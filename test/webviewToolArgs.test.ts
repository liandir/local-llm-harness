import { describe, expect, it } from "vitest";
import { normalizeToolArgsForDisplay } from "../src/ui/chatView/webview/toolArgs.js";

describe("webview tool argument normalization", () => {
  it("preserves run_process program and argv parameters", () => {
    expect(normalizeToolArgsForDisplay({
      program: "grep",
      args: ["-n", "needle", "src"]
    })).toEqual({
      program: "grep",
      args: ["-n", "needle", "src"]
    });
  });

  it("still unwraps compatibility argument envelopes", () => {
    expect(normalizeToolArgsForDisplay({
      name: "run_process",
      arguments: { program: "grep", args: ["needle", "src"] }
    })).toEqual({
      program: "grep",
      args: ["needle", "src"]
    });
    expect(normalizeToolArgsForDisplay({ args: { path: "src/app.ts" } }))
      .toEqual({ path: "src/app.ts" });
  });
});
