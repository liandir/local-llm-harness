import { describe, expect, it } from "vitest";
import { restoredCreatesNewFile, restoredToolStatus } from "../src/ui/chatView/webview/toolHistory.js";

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
