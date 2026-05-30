import { describe, expect, it } from "vitest";
import { compactAvailableForMessageCount, MIN_COMPACT_MESSAGES } from "../src/chat/compactor.js";

describe("compact eligibility", () => {
  it("is unavailable before the saved-message threshold", () => {
    expect(MIN_COMPACT_MESSAGES).toBe(6);
    expect(compactAvailableForMessageCount(MIN_COMPACT_MESSAGES - 1)).toBe(false);
  });

  it("is available at the saved-message threshold", () => {
    expect(compactAvailableForMessageCount(MIN_COMPACT_MESSAGES)).toBe(true);
  });
});
