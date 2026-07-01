import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRecord, ChatMessage } from "../src/chat/storage.js";

const mocks = vi.hoisted(() => ({
  tokenize: vi.fn(),
  complete: vi.fn()
}));

vi.mock("../src/llm/client.js", () => ({
  tokenize: mocks.tokenize,
  complete: mocks.complete
}));

function fakeTokenize(_endpoint: string, text: string): Promise<number> {
  return Promise.resolve(Math.max(1, Math.ceil(text.length / 4)));
}

function msg(role: ChatMessage["role"], content: string): ChatMessage {
  return { role, content, ts: Date.now() };
}

function record(messages: ChatMessage[]): ChatRecord {
  return {
    id: "r1",
    workspaceRoot: "/w",
    createdAt: 0,
    updatedAt: 0,
    title: "t",
    modelFamily: "gemma4",
    planMode: false,
    messages,
    totalTokens: 0
  };
}

const cfg = {
  limit: 400,
  thresholdPercent: 80,
  tailBudgetPercent: 30,
  maxMessageTokensPercent: 25,
  overheadPerMessage: 0
};

beforeEach(() => {
  mocks.tokenize.mockReset();
  mocks.complete.mockReset();
  mocks.tokenize.mockImplementation(fakeTokenize);
  mocks.complete.mockResolvedValue("GOAL: keep working\nNEXT: continue");
});

describe("compact — fit guarantee", () => {
  it("summarizes the head and keeps the transcript within the target even with a giant tail", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    const giant = Array.from({ length: 600 }, (_, i) => `output row ${i}`).join("\n"); // ~ big tool result
    const rec = record([
      msg("user", "please refactor the parser"),
      msg("assistant", "reading files"),
      msg("tool", "small read result A"),
      msg("assistant", "editing"),
      msg("tool", "small read result B"),
      msg("assistant", "running tests"),
      msg("tool", giant)
    ]);

    const { keptTail } = await compact("http://x", rec, new AbortController().signal, cfg);

    // A summary was produced by the model.
    expect(mocks.complete).toHaveBeenCalled();
    expect(rec.messages[0].content.startsWith("[context summary]")).toBe(true);
    // The oversized tail result was truncated with a marker.
    const last = rec.messages[rec.messages.length - 1];
    expect(last.content).toContain("context guard elided");
    // The compacted transcript fits the target (threshold% of the budget).
    const target = Math.floor((cfg.limit * cfg.thresholdPercent) / 100);
    expect(rec.totalTokens).toBeLessThanOrEqual(target);
    expect(keptTail).toBeGreaterThanOrEqual(1);
  });

  it("does nothing when there are too few messages", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    const rec = record([msg("user", "hi"), msg("assistant", "hello")]);
    const before = rec.messages.length;
    await compact("http://x", rec, new AbortController().signal, cfg);
    expect(rec.messages.length).toBe(before);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("chunks a very long head so no single summarize request exceeds the input budget", async () => {
    const { compact } = await import("../src/chat/compactor.js");
    // Many medium head messages that together dwarf the per-request budget.
    const head: ChatMessage[] = Array.from({ length: 12 }, (_, i) =>
      msg(i % 2 === 0 ? "assistant" : "tool", `chunk body ${i} ` + "x".repeat(300))
    );
    const rec = record([...head, msg("user", "keep going"), msg("assistant", "ok")]);

    await compact("http://x", rec, new AbortController().signal, cfg);

    // More than one summarization pass ran (map-reduce), and each request's
    // transcript stayed within the input budget.
    expect(mocks.complete.mock.calls.length).toBeGreaterThan(1);
    const outputReserve = Math.floor(cfg.limit * 0.25);
    const inputBudget = Math.max(512, Math.floor((cfg.limit * cfg.thresholdPercent) / 100) - outputReserve);
    for (const call of mocks.complete.mock.calls) {
      const reqMessages = call[1].messages as { role: string; content: string }[];
      const total = reqMessages.reduce((n, m) => n + Math.ceil(`<|${m.role}|>${m.content}`.length / 4), 0);
      expect(total).toBeLessThanOrEqual(inputBudget + 512); // instruction slack
    }
  });
});
