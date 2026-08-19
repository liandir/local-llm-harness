import { describe, expect, it } from "vitest";
import { approvalHintForCategory } from "../src/ui/chatView/webview/approvalHints.js";

describe("approvalHintForCategory", () => {
  it("warns when a command is not on the safe list", () => {
    expect(approvalHintForCategory("command")).toBe(
      "This command is not on the safe list, so it cannot be auto-approved. Review it carefully before approving."
    );
  });

  it.each(["safeCmd", "read", "write", "question"])(
    "does not warn for %s approvals",
    category => {
      expect(approvalHintForCategory(category)).toBeUndefined();
    }
  );
});
