import { describe, expect, it } from "vitest";
import { restoredRecordMessageId, restoredToolCardId } from "../src/ui/chatView/webview/ids.js";

describe("restored webview ids", () => {
  it("keeps duplicate timestamps unique by including the record index", () => {
    expect(restoredRecordMessageId(0, 123)).toBe("r_0_123");
    expect(restoredRecordMessageId(1, 123)).toBe("r_1_123");
    expect(restoredToolCardId(0, 123)).toBe("rt_0_123");
    expect(restoredToolCardId(1, 123)).toBe("rt_1_123");
  });
});
