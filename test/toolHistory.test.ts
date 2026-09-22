import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatRecord, FileChangeSummary } from "../src/chat/storage.js";
import { restoredCreatesNewFile, restoredToolFileChanges, restoredToolStatus } from "../src/ui/chatView/webview/toolHistory.js";

describe("restored tool history metadata", () => {
  it("prefers explicitly persisted outcomes", () => {
    expect(restoredToolStatus("rejected", "ordinary text")).toBe("rejected");
    expect(restoredToolStatus("failed", "ordinary text")).toBe("failed");
    expect(restoredToolStatus("executed", "error: text returned by a successful tool")).toBe("executed");
  });

  it("infers unsuccessful outcomes in records that predate metadata", () => {
    expect(restoredToolStatus(undefined, "error: could not read file")).toBe("failed");
    expect(restoredToolStatus(undefined, "[blocked: unknown] Tool call rejected.")).toBe("rejected");
    expect(restoredToolStatus(undefined, "[rejected by user]\nTool: run_command")).toBe("rejected");
    expect(restoredToolStatus(undefined, "normal output")).toBe("executed");
    expect(restoredToolStatus(undefined, "normal output", true)).toBe("rejected");
  });

  it("retains creation metadata and recognizes historical create_file calls", () => {
    expect(restoredCreatesNewFile("write_file", true)).toBe(true);
    expect(restoredCreatesNewFile("write_file", false)).toBe(false);
    expect(restoredCreatesNewFile("create_file", undefined)).toBe(true);
    expect(restoredCreatesNewFile("edit_file", undefined)).toBeUndefined();
  });
});

describe("restored edit diffs", () => {
  const first: FileChangeSummary = { path: "src/app.ts", added: 1, removed: 1, diffPreview: "-\t1\t\told\n+\t\t1\tfirst" };
  const second: FileChangeSummary = { ...first, diffPreview: "-\t1\t\tfirst\n+\t\t1\tsecond" };
  const total: FileChangeSummary = { ...first, diffPreview: "-\t1\t\told\n+\t\t1\tsecond" };
  const edit = (path = "src/app.ts", fileChange?: FileChangeSummary): ChatMessage => ({
    role: "tool", content: "edited file", ts: 2,
    toolCall: { name: "edit_file", argsJson: JSON.stringify({ path }), status: "executed", fileChange }
  });
  const summary = (...fileChanges: FileChangeSummary[]): ChatMessage => ({ role: "assistant", content: "Done", ts: 3, fileChanges });
  const restore = (messages: ChatMessage[], workspaceRoot = "/workspace") =>
    restoredToolFileChanges({ messages, workspaceRoot } as ChatRecord);

  it("preserves each saved edit instead of substituting the turn's combined diff", () => {
    expect(restore([edit("src/app.ts", first), edit("src/app.ts", second), summary(total)]))
      .toEqual(new Map([[0, first], [1, second]]));
  });

  it("recovers legacy diffs for files edited once in a turn", () => {
    const other = { ...first, path: "other.ts" };
    expect(restore([edit("/workspace/src/app.ts"), edit("./other.ts"), summary(first, other)]))
      .toEqual(new Map([[0, first], [1, other]]));
  });

  it("does not assign a combined diff to one of several edits of the same file", () => {
    expect(restore([edit(), edit("./src/../src/app.ts"), summary(total)]).size).toBe(0);
    expect(restore([edit("src/app.ts", first), edit(), summary(total)]))
      .toEqual(new Map([[0, first]]));
  });

  it("keeps recovery scoped to each user turn", () => {
    expect(restore([edit(), summary(first), { role: "user", content: "Again", ts: 4 }, edit(), summary(second)]))
      .toEqual(new Map([[0, first], [3, second]]));
    expect(restore([edit(), { role: "user", content: "Again", ts: 4 }, summary(second)]).size).toBe(0);
  });

  it("excludes failed edits, including those with old approval metadata", () => {
    const failed = edit("src/app.ts", first);
    failed.toolCall!.status = "failed";
    expect(restore([failed, edit(), summary(second)])).toEqual(new Map([[1, second]]));
  });

  it("matches normalized legacy argument aliases and Windows paths", () => {
    const legacy = edit();
    legacy.toolCall!.argsJson = JSON.stringify({ arguments: { file_path: "C:\\workspace\\SRC\\app.ts" } });
    expect(restore([legacy, summary(first)], "C:\\workspace")).toEqual(new Map([[0, first]]));
  });

  it("leaves missing or ambiguous history unavailable", () => {
    expect(restore([edit()]).size).toBe(0);
    expect(restore([edit(), summary(first), summary(second)]).size).toBe(0);
    const malformed = edit();
    malformed.toolCall!.argsJson = "{";
    expect(restore([malformed, edit(), summary(first)]).size).toBe(0);
  });
});
