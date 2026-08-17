import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));

vi.mock("../src/llm/client.js", () => ({ complete: mocks.complete }));

beforeEach(() => mocks.complete.mockReset());

describe("chat title generation", () => {
  it("uses one tiny no-reasoning user prompt and cleans its output", async () => {
    mocks.complete.mockResolvedValue("<think>draft</think>\n```text\nFix Play Again behavior.\n```");
    const { generateChatTitle } = await import("../src/chat/chatTitle.js");

    const title = await generateChatTitle("The Play Again button does not restart", {
      endpoint: "http://127.0.0.1:8080/v1",
      modelFamily: "qwen3",
      topK: 20,
      topP: 0.9
    });

    expect(title).toBe("Fix Play Again behavior");
    expect(mocks.complete).toHaveBeenCalledWith(
      "http://127.0.0.1:8080/v1",
      expect.objectContaining({
        max_tokens: 32,
        thinking_budget_tokens: 0,
        messages: [expect.objectContaining({
          role: "user",
          content: expect.stringMatching(/\/no_think[\s\S]*Please summarize the following using 2-6 words:[\s\S]*Output ONLY the 2-6 words\./)
        })]
      }),
      expect.any(AbortSignal)
    );
  });

  it("retries an empty generation with more room for hidden reasoning", async () => {
    mocks.complete
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("Review implementation status");
    const { generateChatTitle } = await import("../src/chat/chatTitle.js");

    await expect(generateChatTitle("Please fix the restart button in Game.ts now", {
      endpoint: "http://127.0.0.1:8080/v1",
      modelFamily: "gemma4",
      topK: 40,
      topP: 0.95
    })).resolves.toBe("Review implementation status");

    expect(mocks.complete).toHaveBeenCalledTimes(2);
    expect(mocks.complete.mock.calls[1][1]).toEqual(expect.objectContaining({
      max_tokens: 32,
      thinking_budget_tokens: 0
    }));
  });

  it("does not use reasoning as the title and waits for a visible answer", async () => {
    mocks.complete
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("Verify fixes plan");
    const { generateChatTitle } = await import("../src/chat/chatTitle.js");

    await expect(generateChatTitle("Please read FIXES_PLAN_REVIEW and verify it", {
      endpoint: "http://127.0.0.1:8080/v1",
      modelFamily: "gemma4",
      topK: 40,
      topP: 0.95
    })).resolves.toBe("Verify fixes plan");

    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });

  it("fails explicitly rather than accepting a placeholder after two empty attempts", async () => {
    mocks.complete.mockResolvedValue("");
    const { generateChatTitle } = await import("../src/chat/chatTitle.js");

    await expect(generateChatTitle("Please read FIXES_PLAN_REVIEW and verify it", {
      endpoint: "http://127.0.0.1:8080/v1",
      modelFamily: "gemma4",
      topK: 40,
      topP: 0.95
    })).rejects.toThrow("did not produce a valid 2–6 word chat name");
  });

  it("retries instead of truncating an explanatory response into a title", async () => {
    mocks.complete
      .mockResolvedValueOnce("Here is a concise title for the conversation")
      .mockResolvedValueOnce("Verify fixes plan");
    const { generateChatTitle } = await import("../src/chat/chatTitle.js");

    await expect(generateChatTitle("Please read FIXES_PLAN_REVIEW and verify it", {
      endpoint: "http://127.0.0.1:8080/v1",
      modelFamily: "gemma4",
      topK: 40,
      topP: 0.95
    })).resolves.toBe("Verify fixes plan");
  });
});
