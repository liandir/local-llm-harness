import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  GuardedWorkspace,
  WorkspaceSecurityError
} from "../src/security/workspace/index.js";
import {
  crossesDeviceBoundary,
  identityOf
} from "../src/security/workspace/fileIdentity.js";
import { migrateLegacyWorkspaceChats } from "../src/security/workspace/legacyChatMigration.js";
import { WorkspaceBoundary } from "../src/security/workspace/boundary.js";
import { parseWorkspacePath } from "../src/security/workspace/pathPolicy.js";

let workspaceRoot: string;
let outsideRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llh-guarded-workspace-"));
  outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llh-guarded-outside-"));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(`${workspaceRoot}-moved`, { recursive: true, force: true });
  await fs.rm(outsideRoot, { recursive: true, force: true });
});

describe("GuardedWorkspace path policy", () => {
  it.each([
    "",
    ".",
    "../outside.txt",
    "src/../outside.txt",
    "/etc/passwd",
    "C:/Windows/System32/config/SAM",
    "C:relative.txt",
    "\\\\server\\share\\secret.txt",
    "\\\\?\\C:\\secret.txt",
    "file.txt:secret",
    "src\\file.ts",
    "src//file.ts",
    "src/./file.ts",
    "NUL",
    "con.txt",
    "CON .txt",
    "COM1.log",
    "COM1 .log",
    "COM¹.log",
    "LPT³",
    "CLOCK$",
    "CONIN$",
    "CONOUT$.txt",
    "trailing.",
    "trailing ",
    "control\0name"
  ])("rejects non-canonical or platform-sensitive path %j before I/O", async requested => {
    const workspace = await GuardedWorkspace.create(workspaceRoot);
    await expect(workspace.resolvePath(requested, signal(), { allowMissing: true }))
      .rejects.toBeInstanceOf(WorkspaceSecurityError);
  });

  it("accepts a canonical relative path and returns stable slash-separated metadata", async () => {
    await fs.mkdir(path.join(workspaceRoot, "src"));
    await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), "export {};\n", "utf8");
    const workspace = await GuardedWorkspace.create(workspaceRoot);

    await expect(workspace.resolvePath("src/app.ts", signal(), { expectedType: "file" }))
      .resolves.toMatchObject({ relativePath: "src/app.ts", type: "file" });
  });

  it("rejects relative and authority-bearing workspace roots before I/O", async () => {
    await expect(GuardedWorkspace.create("relative-workspace"))
      .rejects.toMatchObject({ code: "INVALID_ROOT" });
    await expect(GuardedWorkspace.create("\\\\server\\share\\workspace"))
      .rejects.toMatchObject({ code: "INVALID_ROOT" });
  });

  it("rejects a linked workspace root", async () => {
    const linkedRoot = `${workspaceRoot}-link`;
    await fs.symlink(
      workspaceRoot,
      linkedRoot,
      process.platform === "win32" ? "junction" : "dir"
    );
    try {
      await expect(GuardedWorkspace.create(linkedRoot)).rejects.toMatchObject({
        code: "LINK_NOT_ALLOWED"
      });
    } finally {
      await fs.rm(linkedRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when a filesystem does not expose a usable file identity", () => {
    expect(() => identityOf({ dev: 0n, ino: 0n })).toThrowError(
      expect.objectContaining({ code: "IDENTITY_UNAVAILABLE" })
    );
  });

  it("rejects proven cross-device paths while treating unavailable device IDs as unknown", () => {
    const root = { device: 10n, inode: 20n };
    expect(crossesDeviceBoundary(root, { dev: 11n })).toBe(true);
    expect(crossesDeviceBoundary(root, { dev: 10n })).toBe(false);
    expect(crossesDeviceBoundary({ device: 0n, inode: 20n }, { dev: 11n })).toBe(false);
  });
});

describe("GuardedWorkspace links and identity", () => {
  it("rejects directory symlinks and Windows junctions that point outside", async () => {
    await fs.writeFile(path.join(outsideRoot, "secret.txt"), "secret", "utf8");
    await fs.symlink(
      outsideRoot,
      path.join(workspaceRoot, "escape"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const workspace = await GuardedWorkspace.create(workspaceRoot);

    await expect(workspace.readFile({ path: "escape/secret.txt" }, signal()))
      .rejects.toMatchObject({ code: "LINK_NOT_ALLOWED" });
  });

  it("rejects links even when they point to another location inside the workspace", async () => {
    await fs.mkdir(path.join(workspaceRoot, "real"));
    await fs.writeFile(path.join(workspaceRoot, "real", "inside.txt"), "inside", "utf8");
    await fs.symlink(
      path.join(workspaceRoot, "real"),
      path.join(workspaceRoot, "alias"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const workspace = await GuardedWorkspace.create(workspaceRoot);

    await expect(workspace.readFile({ path: "alias/inside.txt" }, signal()))
      .rejects.toMatchObject({ code: "LINK_NOT_ALLOWED" });
  });

  it("rejects leaf and broken symbolic links", async () => {
    const outsideFile = path.join(outsideRoot, "outside.txt");
    await fs.writeFile(outsideFile, "outside", "utf8");
    if (process.platform === "win32") {
      // Junction creation does not require Developer Mode and still exercises
      // leaf and broken reparse-point rejection on the Windows release runner.
      await fs.symlink(outsideRoot, path.join(workspaceRoot, "leaf"), "junction");
      await fs.symlink(path.join(outsideRoot, "missing"), path.join(workspaceRoot, "broken"), "junction");
    } else {
      await fs.symlink(outsideFile, path.join(workspaceRoot, "leaf"), "file");
      await fs.symlink(path.join(outsideRoot, "missing.txt"), path.join(workspaceRoot, "broken"), "file");
    }
    const workspace = await GuardedWorkspace.create(workspaceRoot);

    await expect(workspace.resolvePath("leaf", signal()))
      .rejects.toMatchObject({ code: "LINK_NOT_ALLOWED" });
    await expect(workspace.resolvePath("broken", signal()))
      .rejects.toMatchObject({ code: "LINK_NOT_ALLOWED" });
  });

  it("rejects hardlinked regular files for reads and writes", async () => {
    const outsideFile = path.join(outsideRoot, "outside.txt");
    await fs.writeFile(outsideFile, "outside sentinel", "utf8");
    await fs.link(outsideFile, path.join(workspaceRoot, "linked.txt"));
    const workspace = await GuardedWorkspace.create(workspaceRoot);

    await expect(workspace.readFile({ path: "linked.txt" }, signal()))
      .rejects.toMatchObject({ code: "HARDLINK_NOT_ALLOWED" });
    await expect(workspace.writeFile("linked.txt", "changed", signal()))
      .rejects.toMatchObject({ code: "HARDLINK_NOT_ALLOWED" });
    await expect(fs.readFile(outsideFile, "utf8")).resolves.toBe("outside sentinel");
  });

  it("detects replacement of the selected root", async () => {
    await fs.writeFile(path.join(workspaceRoot, "before.txt"), "before", "utf8");
    const workspace = await GuardedWorkspace.create(workspaceRoot);
    const moved = `${workspaceRoot}-moved`;
    await fs.rename(workspaceRoot, moved);
    await fs.mkdir(workspaceRoot);
    await fs.writeFile(path.join(workspaceRoot, "before.txt"), "replacement", "utf8");

    await expect(workspace.readFile({ path: "before.txt" }, signal()))
      .rejects.toMatchObject({ code: "ROOT_CHANGED" });
  });
});

describe("GuardedWorkspace operations", () => {
  it("reads ranges and performs atomic line edits without stale path reuse", async () => {
    await fs.mkdir(path.join(workspaceRoot, "src"));
    await fs.writeFile(path.join(workspaceRoot, "src", "app.ts"), "one\ntwo\nthree\n", "utf8");
    const workspace = await GuardedWorkspace.create(workspaceRoot);

    await expect(workspace.readFile({ path: "src/app.ts", startLine: 2, endLine: 3 }, signal()))
      .resolves.toEqual({ content: "two\nthree\n", startLine: 2, endLine: 3, totalLines: 3 });

    const inserted = await workspace.insertText("src/app.ts", 2, "middle", signal());
    expect(inserted.addedTrailingBreak).toBe(true);
    expect(inserted.next).toBe("one\nmiddle\ntwo\nthree\n");

    const replaced = await workspace.replaceRange("src/app.ts", 3, 3, "TWO", signal());
    expect(replaced.addedTrailingBreak).toBe(true);
    await expect(fs.readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8"))
      .resolves.toBe("one\nmiddle\nTWO\nthree\n");
  });

  it("creates missing parents and reports whether write_file created the target", async () => {
    const workspace = await GuardedWorkspace.create(workspaceRoot);

    const created = await workspace.writeFile("new/deep/file.txt", "first", signal());
    const overwritten = await workspace.writeFile("new/deep/file.txt", "second", signal());

    expect(created.created).toBe(true);
    expect(overwritten.created).toBe(false);
    expect(overwritten.previous).toBe("first");
    await expect(fs.readFile(path.join(workspaceRoot, "new", "deep", "file.txt"), "utf8"))
      .resolves.toBe("second");
    expect((await fs.readdir(path.join(workspaceRoot, "new", "deep"))).some(name =>
      name.startsWith(".local-llm-harness-write-")
    )).toBe(false);
  });

  it("keeps a no-clobber target usable when initial temporary cleanup fails", async () => {
    const boundary = await WorkspaceBoundary.create(workspaceRoot);
    const target = parseWorkspacePath("published.txt");
    let injectedUnlinks = 0;

    await boundary.atomicReplace(
      target,
      "published exactly",
      { exists: false, content: "" },
      signal(),
      {
        unlinkPublishedTemporary: async () => {
          injectedUnlinks++;
          throw new Error("transient first-unlink failure");
        }
      }
    );

    expect(injectedUnlinks).toBe(1);
    const workspace = await GuardedWorkspace.create(workspaceRoot);
    await expect(workspace.readFile({ path: "published.txt" }, signal()))
      .resolves.toMatchObject({ content: "published exactly" });
    expect((await fs.stat(path.join(workspaceRoot, "published.txt"))).nlink).toBe(1);
    expect((await fs.readdir(workspaceRoot)).some(name =>
      name.startsWith(".local-llm-harness-write-")
    )).toBe(false);
  });

  it("preserves existing POSIX permission bits and rejects lossy UTF-8 writes", async () => {
    const file = path.join(workspaceRoot, "script.sh");
    await fs.writeFile(file, "#!/bin/sh\n", "utf8");
    if (process.platform !== "win32") await fs.chmod(file, 0o755);
    const workspace = await GuardedWorkspace.create(workspaceRoot);

    await workspace.writeFile("script.sh", "#!/bin/sh\necho ok\n", signal());
    if (process.platform !== "win32") {
      expect((await fs.stat(file)).mode & 0o777).toBe(0o755);
    }
    await expect(workspace.writeFile("script.sh", "bad\ud800text", signal()))
      .rejects.toMatchObject({ code: "INVALID_ENCODING" });
    await expect(fs.readFile(file, "utf8")).resolves.toBe("#!/bin/sh\necho ok\n");
  });

  it("rejects invalid UTF-8 and oversized reads", async () => {
    await fs.writeFile(path.join(workspaceRoot, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    const oversized = path.join(workspaceRoot, "oversized.txt");
    await fs.writeFile(oversized, "");
    await fs.truncate(oversized, 1024 * 1024 + 1);
    const workspace = await GuardedWorkspace.create(workspaceRoot);

    await expect(workspace.readFile({ path: "invalid.txt" }, signal()))
      .rejects.toMatchObject({ code: "INVALID_ENCODING" });
    await expect(workspace.readFile({ path: "oversized.txt" }, signal()))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("lists and globs without traversing linked directories", async () => {
    await fs.mkdir(path.join(workspaceRoot, "src"));
    await fs.writeFile(path.join(workspaceRoot, "root.txt"), "root", "utf8");
    await fs.writeFile(path.join(workspaceRoot, "src", "nested.txt"), "nested", "utf8");
    await fs.writeFile(path.join(outsideRoot, "outside.txt"), "outside", "utf8");
    await fs.symlink(
      outsideRoot,
      path.join(workspaceRoot, "escape"),
      process.platform === "win32" ? "junction" : "dir"
    );
    const workspace = await GuardedWorkspace.create(workspaceRoot);

    const listed = await workspace.listDirectory(".", signal());
    expect(listed).toContainEqual({ name: "escape", type: "other" });
    await expect(workspace.glob("**/*.txt", undefined, signal()))
      .resolves.toEqual(expect.arrayContaining(["root.txt", "src/nested.txt"]));
    expect(await workspace.glob("**/*.txt", undefined, signal())).not.toContain("escape/outside.txt");
  });

  it("enforces directory-entry and glob-depth budgets", async () => {
    const crowded = path.join(workspaceRoot, "crowded");
    await fs.mkdir(crowded);
    await Promise.all(["a", "b", "c"].map(name =>
      fs.writeFile(path.join(crowded, `${name}.txt`), "x")
    ));
    let deep = path.join(workspaceRoot, "deep");
    await fs.mkdir(deep);
    for (let depth = 0; depth < 66; depth++) {
      deep = path.join(deep, "d");
      await fs.mkdir(deep);
    }
    await fs.writeFile(path.join(deep, "end.txt"), "end");
    const boundary = await WorkspaceBoundary.create(workspaceRoot);
    const workspace = await GuardedWorkspace.create(workspaceRoot);

    await expect(boundary.readDirectory(parseWorkspacePath("crowded", true), signal(), 2))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(workspace.glob("deep/**/*.txt", undefined, signal()))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  }, 30_000);

  it("allows explicit review snapshots up to the edit-size boundary", async () => {
    const content = "x".repeat(1024 * 1024 + 1);
    await fs.writeFile(path.join(workspaceRoot, "large.txt"), content, "utf8");
    const workspace = await GuardedWorkspace.create(workspaceRoot);

    await expect(workspace.readFile({ path: "large.txt" }, signal()))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(workspace.readFileForReview("large.txt", signal())).resolves.toBe(content);
  });

  it("refuses legacy deletion when the source changes during publication", async () => {
    const directory = path.join(workspaceRoot, ".local-llm-chats");
    const id = "123e4567-e89b-42d3-a456-426614174099";
    const file = path.join(directory, `${id}.json`);
    await fs.mkdir(directory);
    await fs.writeFile(file, "original", "utf8");

    await expect(migrateLegacyWorkspaceChats({
      workspaceRoot,
      maxRecordBytes: 1024,
      publish: async () => {
        await fs.writeFile(file, "changed", "utf8");
        return true;
      }
    })).rejects.toMatchObject({ code: "PATH_CHANGED" });
    await expect(fs.readFile(file, "utf8")).resolves.toBe("changed");
  });

  it("honors cancellation before filesystem work", async () => {
    await fs.writeFile(path.join(workspaceRoot, "a.txt"), "a", "utf8");
    const workspace = await GuardedWorkspace.create(workspaceRoot);
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await expect(workspace.readFile({ path: "a.txt" }, controller.signal)).rejects.toThrow("stop");
    await expect(workspace.writeFile("a.txt", "changed", controller.signal)).rejects.toThrow("stop");
    await expect(fs.readFile(path.join(workspaceRoot, "a.txt"), "utf8")).resolves.toBe("a");
  });
});

function signal(): AbortSignal {
  return new AbortController().signal;
}
