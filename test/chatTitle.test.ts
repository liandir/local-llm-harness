import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));

vi.mock("../src/llm/client.js", () => ({ complete: mocks.complete }));

beforeEach(() => mocks.complete.mockReset());

const settings = {
  endpoint: "http://127.0.0.1:8080/v1",
  modelFamily: "gemma4" as const,
  topK: 40,
  topP: 0.95,
  titlePrompt: "Summarize the user message in 2-6 words. Output ONLY the summary."
};

describe("chat title generation", () => {
  it("caps title reasoning at 1024 tokens while leaving output length unrestricted", async () => {
    mocks.complete.mockResolvedValue('Title: "Review fixes plan."');
    const { generateChatTitle } = await import("../src/chat/chatTitle.js");

    await expect(generateChatTitle("Please review FIXES_PLAN_REVIEW", settings))
      .resolves.toBe("Review fixes plan");

    expect(mocks.complete).toHaveBeenCalledTimes(1);
    expect(mocks.complete).toHaveBeenCalledWith(
      settings.endpoint,
      expect.objectContaining({
        messages: [expect.objectContaining({
          role: "user",
          content: [
            "Summarize the user message in 2-6 words. Output ONLY the summary.",
            "",
            'User message: "Please review FIXES_PLAN_REVIEW"'
          ].join("\n")
        })]
      }),
      expect.any(AbortSignal),
      { acceptPartialOnLength: true }
    );
    expect(mocks.complete.mock.calls[0][1]).not.toHaveProperty("max_tokens");
    expect(mocks.complete.mock.calls[0][1]).toHaveProperty("thinking_budget_tokens", 1024);
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
