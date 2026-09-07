import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { assertInsideWorkspace, WorkspaceGuardError } from "../src/tools/workspaceGuard.js";

let ws: string;
let outside: string;

beforeAll(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-ws-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "llh-out-"));
  await fs.writeFile(path.join(ws, "ok.txt"), "ok");
  await fs.writeFile(path.join(outside, "secret"), "x");
  // symlink inside ws pointing to outside file
  await fs.symlink(path.join(outside, "secret"), path.join(ws, "escape"));
});

afterAll(async () => {
  await fs.rm(ws, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("assertInsideWorkspace", () => {
  it("accepts files inside the workspace", async () => {
    const r = await assertInsideWorkspace(ws, "ok.txt");
    expect(r).toMatch(/ok\.txt$/);
  });

  it("rejects .. traversal", async () => {
    await expect(assertInsideWorkspace(ws, "../escape")).rejects.toBeInstanceOf(
      WorkspaceGuardError
    );
  });

  it("rejects absolute paths outside the workspace", async () => {
    await expect(
      assertInsideWorkspace(ws, path.join(outside, "secret"))
    ).rejects.toBeInstanceOf(WorkspaceGuardError);
  });

  it("rejects symlinks pointing outside", async () => {
    await expect(assertInsideWorkspace(ws, "escape")).rejects.toBeInstanceOf(
      WorkspaceGuardError
    );
  });

  it("rejects empty workspace root", async () => {
    await expect(assertInsideWorkspace("", "x.txt")).rejects.toBeInstanceOf(
      WorkspaceGuardError
    );
  });
});

describe("missing path handling", () => {
  it("allows new nested paths and valid internal symlinks", async () => {
    await fs.symlink(path.join(ws, "ok.txt"), path.join(ws, "internal"));
    await expect(assertInsideWorkspace(ws, "internal")).resolves.toBe(path.join(await fs.realpath(ws), "ok.txt"));
    await expect(assertInsideWorkspace(ws, "new/nested/file.txt"))
      .resolves.toBe(path.join(await fs.realpath(ws), "new/nested/file.txt"));
  });

  it("rejects dangling links and paths beneath them", async () => {
    await fs.symlink(path.join(outside, "missing"), path.join(ws, "dangling"));
    await expect(assertInsideWorkspace(ws, "dangling")).rejects.toBeInstanceOf(WorkspaceGuardError);
    await expect(assertInsideWorkspace(ws, "dangling/child.txt")).rejects.toBeInstanceOf(WorkspaceGuardError);
  });

  it("propagates errors other than missing paths", async () => {
    await expect(assertInsideWorkspace(ws, "ok.txt/child.txt")).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
