import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tokenize: vi.fn()
}));

vi.mock("../src/llm/client.js", () => ({
  tokenize: mocks.tokenize
}));

// Deterministic, roughly linear tokenizer so truncation math converges the same
// way it would against a real /tokenize.
function fakeTokenize(_endpoint: string, text: string): Promise<number> {
  return Promise.resolve(Math.max(1, Math.ceil(text.length / 4)));
}

beforeEach(() => {
  mocks.tokenize.mockReset();
  mocks.tokenize.mockImplementation(fakeTokenize);
});

describe("promptTokens", () => {
  it("sums exact per-message counts plus per-message overhead", async () => {
    const { promptTokens } = await import("../src/chat/contextTracker.js");
    const messages = [
      { role: "system", content: "abcd" }, // <|system|>abcd => 12 chars => 3 tokens
      { role: "user", content: "hello world" }
    ];
    const overhead = 5;
    const expected =
      Math.ceil("<|system|>abcd".length / 4) +
      Math.ceil("<|user|>hello world".length / 4) +
      overhead * 2;
    expect(await promptTokens("http://x", messages, overhead)).toBe(expected);
  });
});

describe("countTokens caching", () => {
  it("tokenizes a given string only once", async () => {
    const { countTokens } = await import("../src/chat/contextTracker.js");
    const unique = `cache-probe-${Math.random()}`;
    await countTokens("http://x", unique);
    await countTokens("http://x", unique);
    const calls = mocks.tokenize.mock.calls.filter(c => c[1] === unique);
    expect(calls.length).toBe(1);
  });
});

describe("truncateToTokenBudget", () => {
  it("leaves content under budget untouched", async () => {
    const { truncateToTokenBudget } = await import("../src/chat/contextTracker.js");
    const r = await truncateToTokenBudget("http://x", "short", 1000);
    expect(r.truncated).toBe(false);
    expect(r.text).toBe("short");
  });

  it("middle-truncates oversized content under the budget with a marker", async () => {
    const { truncateToTokenBudget, countTokens } = await import("../src/chat/contextTracker.js");
    const big = Array.from({ length: 400 }, (_, i) => `line ${i} of some content`).join("\n");
    const budget = 200;
    const r = await truncateToTokenBudget("http://x", big, budget);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("context guard elided");
    // Keeps a head and a tail of the original.
    expect(r.text.startsWith("line 0")).toBe(true);
    expect(await countTokens("http://x", r.text)).toBeLessThanOrEqual(budget);
  });
});
