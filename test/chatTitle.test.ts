import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));

vi.mock("../src/llm/client.js", () => ({ complete: mocks.complete }));

beforeEach(() => mocks.complete.mockReset());

const settings = {
  endpoint: "http://127.0.0.1:8080/v1",
  modelFamily: "gemma4" as const,
  topK: 40,
  topP: 0.95
};

describe("chat title generation", () => {
  it("uses one plain user prompt with normal reasoning and cleans the visible title", async () => {
    mocks.complete.mockResolvedValue('Title: "Review fixes plan."');
    const { generateChatTitle } = await import("../src/chat/chatTitle.js");

    await expect(generateChatTitle("Please review FIXES_PLAN_REVIEW", settings))
      .resolves.toBe("Review fixes plan");

    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledWith(
      settings.endpoint,
      expect.objectContaining({
        max_tokens: 512,
        messages: [expect.objectContaining({
          role: "user",
          content: 'Please summarize "Please review FIXES_PLAN_REVIEW" in 2-6 words. Output ONLY the summary.'
        })]
      }),
      expect.any(AbortSignal),
      { acceptPartialOnLength: true }
    );
  });

  it("accepts long visible titles without validation", async () => {
    mocks.complete.mockResolvedValue("Review whether the fixes plan is fully implemented already");
    const { generateChatTitle } = await import("../src/chat/chatTitle.js");

    await expect(generateChatTitle("Review this", settings))
      .resolves.toBe("Review whether the fixes plan is fully implemented already");
  });

  it("quietly returns no title for an empty response", async () => {
    mocks.complete.mockResolvedValue("");
    const { generateChatTitle } = await import("../src/chat/chatTitle.js");

    const title = await generateChatTitle("Review this", settings);
    expect(title).toBeUndefined();
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
});
