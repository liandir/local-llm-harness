import { describe, expect, it } from "vitest";
import { buildSystemPrompt, renderToolCallForPrompt } from "../src/llm/prompt.js";

describe("Gemma prompt rendering", () => {
  it("uses native Gemma declarations and call examples", () => {
    const prompt = buildSystemPrompt({
      family: "gemma4",
      planMode: false,
      workspaceRoot: "/tmp/ws"
    });

    expect(prompt).toContain("<|tool>declaration:write_file");
    expect(prompt).toContain("<|tool_call>call:write_file");
    expect(prompt).toContain(`<|"|>`);
    expect(prompt).toContain(`type:<|"|>STRING<|"|>`);
    expect(prompt).not.toContain("output one XML block");
    expect(prompt).not.toContain("<write_file>");
  });

  it("renders prior Gemma tool calls in native format", () => {
    const call = renderToolCallForPrompt(
      "gemma4",
      "write_file",
      JSON.stringify({ path: "src/app.ts", content: "hello\n" })
    );

    expect(call).toBe(`<|tool_call>call:write_file{path:<|"|>src/app.ts<|"|>,content:<|"|>hello\n<|"|>}<tool_call|>`);
  });

  it("keeps Qwen replay in Hermes format", () => {
    const call = renderToolCallForPrompt("qwen3", "read_file", JSON.stringify({ path: "a.ts" }));
    expect(call).toBe(`<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>`);
  });
});
