import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  createSandboxSnapshot,
  type SandboxSnapshotLimits
} from "../src/security/workspace/sandboxSnapshot.js";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "llh-snapshot-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "llh-snapshot-outside-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("guarded sandbox snapshot", () => {
  it("copies binary files deterministically and keeps authenticated bytes private", async () => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "a.bin"), Buffer.from([0, 1, 2, 255]));
    await fs.writeFile(path.join(root, "src", "run"), "#!/bin/sh\nexit 0\n");
    if (process.platform !== "win32") await fs.chmod(path.join(root, "src", "run"), 0o755);

    const snapshot = await createSandboxSnapshot(root, signal());
    const first = [...snapshot.entries()];
    const second = [...snapshot.entries()];

    expect(first.map(entry => entry.path)).toEqual(["a.bin", "src", "src/run"]);
    expect(snapshot.entryCount).toBe(3);
    expect(snapshot.totalBytes).toBe(21);
    expect(snapshot.digest).toMatch(/^[0-9a-f]{64}$/);
    const firstFile = first[0];
    const secondFile = second[0];
    expect(firstFile.type).toBe("file");
    expect(secondFile.type).toBe("file");
    if (firstFile.type === "file" && secondFile.type === "file") {
      firstFile.content[0] = 99;
      expect([...secondFile.content]).toEqual([0, 1, 2, 255]);
    }
  });

  it("globally sorts flattened paths while retaining parents before descendants", async () => {
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "child.txt"), "child");
    await fs.writeFile(path.join(root, "src.ts"), "sibling");

    const snapshot = await createSandboxSnapshot(root, signal());
    expect([...snapshot.entries()].map(entry => entry.path)).toEqual([
      "src",
      "src.ts",
      "src/child.txt"
    ]);
  });

  it("rejects symbolic links and junctions instead of following them", async () => {
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.symlink(outside, path.join(root, "escape"), process.platform === "win32" ? "junction" : "dir");

    await expect(createSandboxSnapshot(root, signal())).rejects.toMatchObject({
      code: "LINK_NOT_ALLOWED"
    });
  });

  it("rejects every hardlinked regular file", async () => {
    const original = path.join(root, "original.txt");
    await fs.writeFile(original, "same inode");
    await fs.link(original, path.join(root, "alias.txt"));

    await expect(createSandboxSnapshot(root, signal())).rejects.toMatchObject({
      code: "HARDLINK_NOT_ALLOWED"
    });
  });

  it("enforces independent entry, per-file, total-byte, and depth ceilings", async () => {
    await fs.mkdir(path.join(root, "nested"));
    await fs.writeFile(path.join(root, "nested", "large.bin"), "12345");
    await fs.writeFile(path.join(root, "other.bin"), "12");

    await expect(createSandboxSnapshot(root, signal(), limits({ maxEntries: 2 })))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(createSandboxSnapshot(root, signal(), limits({ maxFileBytes: 4 })))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(createSandboxSnapshot(root, signal(), limits({ maxTotalBytes: 6, maxFileBytes: 6 })))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    await expect(createSandboxSnapshot(root, signal(), limits({ maxDepth: 1 })))
      .rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("honors cancellation before reading workspace entries", async () => {
    await fs.writeFile(path.join(root, "keep.txt"), "unchanged");
    const controller = new AbortController();
    controller.abort(new Error("stop snapshot"));

    await expect(createSandboxSnapshot(root, controller.signal)).rejects.toThrow("stop snapshot");
    await expect(fs.readFile(path.join(root, "keep.txt"), "utf8")).resolves.toBe("unchanged");
  });
});

function limits(overrides: Partial<SandboxSnapshotLimits>): SandboxSnapshotLimits {
  return {
    maxEntries: 100,
    maxTotalBytes: 100,
    maxFileBytes: 100,
    maxDepth: 10,
    ...overrides
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
