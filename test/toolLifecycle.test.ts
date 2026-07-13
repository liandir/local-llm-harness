import { describe, expect, it } from "vitest";
import {
  canApplyToolDiff,
  canApplyToolProgress,
  canApplyToolProposal,
  canApplyToolResolution,
  type ToolLifecycleStatus
} from "../src/ui/chatView/webview/toolLifecycle.js";

const TERMINAL: ToolLifecycleStatus[] = ["executed", "rejected", "failed"];

describe("tool-card lifecycle", () => {
  it("allows progress and proposal finalization only before a proposal exists", () => {
    expect(canApplyToolProgress("streaming")).toBe(true);
    expect(canApplyToolProposal(undefined)).toBe(true);
    expect(canApplyToolProposal("streaming")).toBe(true);
    for (const status of ["pending", "approved", ...TERMINAL] as ToolLifecycleStatus[]) {
      expect(canApplyToolProgress(status)).toBe(false);
      expect(canApplyToolProposal(status)).toBe(false);
    }
  });

  it("never regresses or resurrects a terminal card", () => {
    for (const status of TERMINAL) {
      for (const next of ["approved", "rejected", "executed", "failed"] as const) {
        expect(canApplyToolResolution(status, next)).toBe(false);
      }
    }
    expect(canApplyToolResolution("pending", "approved")).toBe(true);
    expect(canApplyToolResolution("pending", "rejected")).toBe(true);
    expect(canApplyToolResolution("approved", "executed")).toBe(true);
    expect(canApplyToolResolution("approved", "approved")).toBe(false);
  });

  it("accepts lazy diffs only for executed cards without a live binding", () => {
    expect(canApplyToolDiff("executed", false)).toBe(true);
    expect(canApplyToolDiff("executed", true)).toBe(false);
    expect(canApplyToolDiff("pending", false)).toBe(false);
    expect(canApplyToolDiff("approved", false)).toBe(false);
  });
});
