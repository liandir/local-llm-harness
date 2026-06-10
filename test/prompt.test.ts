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
    expect(prompt).toContain("<|tool>declaration:insert_text");
    expect(prompt).toContain("<|tool>declaration:replace_range");
    expect(prompt).toContain("<|tool_call>call:write_file");
    expect(prompt).toContain("<|tool_call>call:insert_text");
    expect(prompt).toContain("<|tool_call>call:replace_range");
    expect(prompt).toContain("Prefer insert_text or replace_range");
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

  it("warns Qwen to emit bare, unfenced tool-call blocks", () => {
    const prompt = buildSystemPrompt({
      family: "qwen3",
      planMode: false,
      workspaceRoot: "/tmp/ws"
    });

    expect(prompt).toContain(`<tool_call>{"name":"NAME","arguments":{...}}</tool_call>`);
    expect(prompt).toContain("bare tool-call block");
    expect(prompt).toContain("never wrap it in");
    expect(prompt).toContain("``` code fence");
  });
});

describe("system prompt policy", () => {
  const normal = buildSystemPrompt({ family: "qwen3", planMode: false, workspaceRoot: "/tmp/ws" });
  const plan = buildSystemPrompt({ family: "qwen3", planMode: true, workspaceRoot: "/tmp/ws" });

  it("grounds the agent against fabricated actions and unread files", () => {
    expect(normal).toContain("GROUNDING");
    expect(normal).toContain("Never claim you read, edited, or ran something");
    expect(normal).toContain("the tool result wins");
    expect(normal).toContain("[tool_name result]");
  });

  it("gives a concrete working loop ending in a summary", () => {
    expect(normal).toContain("HOW TO WORK");
    expect(normal).toContain("answer directly and stop");
    expect(normal).toContain("brief one-paragraph summary");
  });

  it("explains line-number staleness after edits", () => {
    expect(normal).toContain("shifts every number below it");
    expect(normal).toContain("Re-read the affected range");
  });

  it("demands one dependent tool call per turn", () => {
    expect(normal).toContain("ONE tool call per turn");
    expect(normal).toContain("never emit a call that needs the result of another call");
  });

  it("keeps the tool-format block as the final section", () => {
    expect(normal.indexOf("REPLIES:")).toBeLessThan(normal.indexOf("Available tools"));
  });

  it("plan mode keeps read-only contract and bans diffs in the plan", () => {
    expect(plan).toContain("PLAN MODE");
    expect(plan).toContain("markdown checklist");
    expect(plan).toContain("do not include code diffs");
    expect(plan).not.toContain("COMMANDS:");
    expect(plan).not.toContain(`"run_command"`);
  });
});
