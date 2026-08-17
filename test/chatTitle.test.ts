import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ complete: vi.fn() }));

vi.mock("../src/llm/client.js", () => ({ complete: mocks.complete }));

beforeEach(() => mocks.complete.mockReset());

describe("chat title generation", () => {
  it("asks Qwen for a no-think 2-6 word title and cleans its output", async () => {
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
        max_tokens: 128,
        messages: expect.arrayContaining([
          expect.objectContaining({ content: expect.stringContaining("2 to 6 words") }),
          expect.objectContaining({ content: expect.stringContaining("summarizing the user's first request") }),
          expect.objectContaining({ content: expect.stringContaining("/no_think") })
        ])
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
    expect(mocks.complete.mock.calls[1][1]).toEqual(expect.objectContaining({ max_tokens: 512 }));
  });

  it("keeps the honest placeholder when both model attempts are empty", async () => {
    mocks.complete.mockResolvedValue("");
    const { generateChatTitle } = await import("../src/chat/chatTitle.js");

    await expect(generateChatTitle("Please read FIXES_PLAN_REVIEW and verify it", {
      endpoint: "http://127.0.0.1:8080/v1",
      modelFamily: "gemma4",
      topK: 40,
      topP: 0.95
    })).resolves.toBe("New chat");

    expect(mocks.complete).toHaveBeenCalledTimes(2);
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
