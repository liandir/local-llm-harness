import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PreparedWorkspaceEdit, WorkspaceWriteResult } from "../src/chat/session/ports.js";
import { GuardedWorkspace } from "../src/security/workspace/index.js";

let workspaceRoot = "";

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llh-edit-transaction-"));
});

afterEach(async () => {
  if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true });
});

describe("GuardedWorkspace edit transactions", () => {
  it("prepares immutable exact bytes without mutating the target", async () => {
    const file = path.join(workspaceRoot, "file.txt");
    await fs.writeFile(file, "before\n", "utf8");
    const workspace = await GuardedWorkspace.create(workspaceRoot);
    const before = await fs.stat(file, { bigint: true });

    const prepared = await workspace.prepareEdit(
      { kind: "write_file", path: "file.txt", content: "after\r\n" },
      signal()
    );

    expect(Object.isFrozen(prepared)).toBe(true);
    expect(prepared).toMatchObject({
      kind: "write_file",
      path: "file.txt",
      previous: "before\n",
      next: "after\r\n",
      created: false,
      bytesWritten: Buffer.byteLength("after\r\n", "utf8")
    });
    expect(prepared.transactionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(prepared.baseRevision).toMatch(/^[0-9a-f]{64}$/);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("before\n");

    const after = await fs.stat(file, { bigint: true });
    expect({ device: after.dev, inode: after.ino }).toEqual({
      device: before.dev,
      inode: before.ino
    });
  });

  it("commits the exact prepared UTF-8 bytes once", async () => {
    const file = path.join(workspaceRoot, "exact.txt");
    const previous = "\ufefffirst\r\nsecond\n";
    const next = "\ufeffFIRST\r\nsecond\nlast";
    await fs.writeFile(file, previous, "utf8");
    const workspace = await GuardedWorkspace.create(workspaceRoot);
    const prepared = await workspace.prepareEdit(
      { kind: "write_file", path: "exact.txt", content: next },
      signal()
    );

    const result = await workspace.commitEdit(prepared, signal());

    expect(result).toMatchObject({ previous, next, created: false });
    await expect(fs.readFile(file)).resolves.toEqual(Buffer.from(next, "utf8"));
    await expect(workspace.commitEdit(prepared, signal()))
      .rejects.toMatchObject({ code: "INVALID_TRANSACTION" });
    await expect(fs.readFile(file)).resolves.toEqual(Buffer.from(next, "utf8"));
  });

  it("rejects a stale same-length base and preserves the intervening bytes", async () => {
    const file = path.join(workspaceRoot, "stale.txt");
    await fs.writeFile(file, "AAAA", "utf8");
    const workspace = await GuardedWorkspace.create(workspaceRoot);
    const prepared = await workspace.prepareEdit(
      { kind: "write_file", path: "stale.txt", content: "CCCC" },
      signal()
    );

    await fs.writeFile(file, "BBBB", "utf8");

    await expect(workspace.commitEdit(prepared, signal()))
      .rejects.toMatchObject({ code: "PATH_CHANGED" });
    await expect(fs.readFile(file, "utf8")).resolves.toBe("BBBB");
    await expect(workspace.commitEdit(prepared, signal()))
      .rejects.toMatchObject({ code: "INVALID_TRANSACTION" });
  });

  it("detects replacement by a different file even when its bytes are identical", async () => {
    const file = path.join(workspaceRoot, "replaced.txt");
    const displaced = path.join(workspaceRoot, "displaced.txt");
    await fs.writeFile(file, "same bytes\n", "utf8");
    const workspace = await GuardedWorkspace.create(workspaceRoot);
    const prepared = await workspace.prepareEdit(
      { kind: "write_file", path: "replaced.txt", content: "approved bytes\n" },
      signal()
    );

    await fs.rename(file, displaced);
    await fs.writeFile(file, "same bytes\n", "utf8");

    await expect(workspace.commitEdit(prepared, signal()))
      .rejects.toMatchObject({ code: "PATH_CHANGED" });
    await expect(fs.readFile(file, "utf8")).resolves.toBe("same bytes\n");
  });

  it("detects a same-inode content ABA even after the original bytes return", async () => {
    const file = path.join(workspaceRoot, "aba.txt");
    await fs.writeFile(file, "AAAA", "utf8");
    const workspace = await GuardedWorkspace.create(workspaceRoot);
    const prepared = await workspace.prepareEdit(
      { kind: "write_file", path: "aba.txt", content: "CCCC" },
      signal()
    );

    await fs.writeFile(file, "BBBB", "utf8");
    await fs.writeFile(file, "AAAA", "utf8");
    // Make the final version observably distinct even on filesystems whose
    // timestamp granularity could otherwise collapse the two fast writes.
    await fs.utimes(file, new Date(1_000), new Date(2_000));

    await expect(workspace.commitEdit(prepared, signal()))
      .rejects.toMatchObject({ code: "PATH_CHANGED" });
    await expect(fs.readFile(file, "utf8")).resolves.toBe("AAAA");
  });

  it("refuses to overwrite a missing target that appears after preparation", async () => {
    const parent = path.join(workspaceRoot, "existing");
    const file = path.join(parent, "new.txt");
    await fs.mkdir(parent);
    const workspace = await GuardedWorkspace.create(workspaceRoot);
    const prepared = await workspace.prepareEdit(
      { kind: "write_file", path: "existing/new.txt", content: "approved" },
      signal()
    );
    expect(prepared.created).toBe(true);

    await fs.writeFile(file, "intervening", "utf8");

    await expect(workspace.commitEdit(prepared, signal()))
      .rejects.toMatchObject({ code: "PATH_CHANGED" });
    await expect(fs.readFile(file, "utf8")).resolves.toBe("intervening");
  });

  it("rejects replacement of a prepared target's existing ancestor", async () => {
    const parent = path.join(workspaceRoot, "parent");
    const displaced = path.join(workspaceRoot, "old-parent");
    await fs.mkdir(parent);
    const workspace = await GuardedWorkspace.create(workspaceRoot);
    const prepared = await workspace.prepareEdit(
      { kind: "write_file", path: "parent/new.txt", content: "approved" },
      signal()
    );

    await fs.rename(parent, displaced);
    await fs.mkdir(parent);
    await fs.writeFile(path.join(parent, "sentinel.txt"), "keep", "utf8");

    await expect(workspace.commitEdit(prepared, signal()))
      .rejects.toMatchObject({ code: "PATH_CHANGED" });
    await expect(fs.readFile(path.join(parent, "sentinel.txt"), "utf8")).resolves.toBe("keep");
    await expect(fs.access(path.join(parent, "new.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("issues no transaction while ancestors are missing", async () => {
    const workspace = await GuardedWorkspace.create(workspaceRoot);

    await expect(workspace.prepareEdit(
      { kind: "write_file", path: "late/deep/file.txt", content: "approved" },
      signal()
    )).rejects.toMatchObject({ code: "PATH_NOT_FOUND" });
    await expect(fs.access(path.join(workspaceRoot, "late"))).rejects.toMatchObject({ code: "ENOENT" });

    await fs.mkdir(path.join(workspaceRoot, "late", "deep"), { recursive: true });
    const fresh = await workspace.prepareEdit(
      { kind: "write_file", path: "late/deep/file.txt", content: "approved" },
      signal()
    );
    await workspace.commitEdit(fresh, signal());
    await expect(fs.readFile(path.join(workspaceRoot, "late", "deep", "file.txt"), "utf8"))
      .resolves.toBe("approved");
  });

  it("rejects fabricated, foreign, and discarded transaction handles", async () => {
    const file = path.join(workspaceRoot, "handles.txt");
    await fs.writeFile(file, "before", "utf8");
    const owner = await GuardedWorkspace.create(workspaceRoot);
    const foreign = await GuardedWorkspace.create(workspaceRoot);
    const prepared = await owner.prepareEdit(
      { kind: "write_file", path: "handles.txt", content: "after" },
      signal()
    );
    const fabricated = Object.freeze({
      ...prepared,
      transactionId: "00000000-0000-4000-8000-000000000000"
    }) as PreparedWorkspaceEdit;

    await expect(owner.commitEdit(fabricated, signal()))
      .rejects.toMatchObject({ code: "INVALID_TRANSACTION" });
    await expect(foreign.commitEdit(prepared, signal()))
      .rejects.toMatchObject({ code: "INVALID_TRANSACTION" });
    expect(foreign.discardEdit(prepared)).toBe(false);
    expect(owner.discardEdit(prepared)).toBe(true);
    expect(owner.discardEdit(prepared)).toBe(false);
    await expect(owner.commitEdit(prepared, signal()))
      .rejects.toMatchObject({ code: "INVALID_TRANSACTION" });
    await expect(fs.readFile(file, "utf8")).resolves.toBe("before");
  });

  it("allows at most one concurrent commit from two adapters prepared on one base", async () => {
    const file = path.join(workspaceRoot, "race.txt");
    await fs.writeFile(file, "base\n", "utf8");
    const firstWorkspace = await GuardedWorkspace.create(workspaceRoot);
    const secondWorkspace = await GuardedWorkspace.create(workspaceRoot);
    const first = await firstWorkspace.prepareEdit(
      { kind: "write_file", path: "race.txt", content: "first\n" },
      signal()
    );
    const second = await secondWorkspace.prepareEdit(
      { kind: "write_file", path: "race.txt", content: "second\n" },
      signal()
    );

    const outcomes = await Promise.allSettled([
      firstWorkspace.commitEdit(first, signal()),
      secondWorkspace.commitEdit(second, signal())
    ]);
    const winners = outcomes.flatMap((outcome, index) => outcome.status === "fulfilled" ? [index] : []);
    const losers = outcomes.flatMap((outcome, index) => outcome.status === "rejected" ? [index] : []);

    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((outcomes[losers[0]] as PromiseRejectedResult).reason)
      .toMatchObject({ code: "PATH_CHANGED" });
    const committed = (outcomes[winners[0]] as PromiseFulfilledResult<WorkspaceWriteResult>).value;
    await expect(fs.readFile(file, "utf8")).resolves.toBe(committed.next);
  });

  it("revalidates a no-op without replacing the file or changing metadata", async () => {
    const file = path.join(workspaceRoot, "noop.txt");
    await fs.writeFile(file, "unchanged\n", "utf8");
    const workspace = await GuardedWorkspace.create(workspaceRoot);
    const prepared = await workspace.prepareEdit(
      { kind: "write_file", path: "noop.txt", content: "unchanged\n" },
      signal()
    );
    const beforeCommit = await fs.stat(file, { bigint: true });

    const committed = await workspace.commitEdit(prepared, signal());

    const afterCommit = await fs.stat(file, { bigint: true });
    expect(committed).toMatchObject({
      previous: "unchanged\n",
      next: "unchanged\n",
      created: false
    });
    expect(versionFields(afterCommit)).toEqual(versionFields(beforeCommit));
    expect((await fs.readdir(workspaceRoot)).some(name =>
      name.startsWith(".local-llm-harness-write-")
    )).toBe(false);
  });
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

function versionFields(stats: BigIntStats): object {
  return {
    device: stats.dev,
    inode: stats.ino,
    size: stats.size,
    mode: stats.mode,
    modifiedNs: stats.mtimeNs,
    changedNs: stats.ctimeNs
  };
}
