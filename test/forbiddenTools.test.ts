import { describe, expect, it } from "vitest";
import {
  ALLOWED_TOOL_NAMES,
  classifyToolName,
  disabledToolReason
} from "../src/tools/forbiddenTools.js";

describe("disabled command tool", () => {
  it("is recognized for rejection but is never in the active tool catalog", () => {
    expect(ALLOWED_TOOL_NAMES.has("run_command")).toBe(false);
    expect(classifyToolName("run_command")).toBe("disabled");
  });

  it("explains the fail-closed sandbox requirement", () => {
    const reason = disabledToolReason("run_command");
    expect(reason).toContain("no verified sandbox backend is available");
    expect(reason).toContain("No command was executed");
  });
});
