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

  it("tells Qwen how to emit a single tool-call block", () => {
    const prompt = buildSystemPrompt({
      family: "qwen3",
      planMode: false,
      workspaceRoot: "/tmp/ws"
    });

    expect(prompt).toContain(`<tool_call>{"name":"NAME","arguments":{...}}</tool_call>`);
    expect(prompt).toContain("Emit a tool call as a single block on its own line");
  });

  it("gives Qwen the same concrete per-tool examples as Gemma", () => {
    const qwen = buildSystemPrompt({ family: "qwen3", planMode: false, workspaceRoot: "/tmp/ws" });
    const gemma = buildSystemPrompt({ family: "gemma4", planMode: false, workspaceRoot: "/tmp/ws" });

    expect(qwen).toContain("Examples:");
    for (const name of ["read_file", "write_file", "insert_text", "replace_range", "list_dir", "glob", "run_command"]) {
      expect(qwen).toContain(`<tool_call>{"name":"${name}","arguments":`);
      expect(gemma).toContain(`<|tool_call>call:${name}{`);
    }
    expect(qwen).toContain(
      `<tool_call>{"name":"replace_range","arguments":{"path":"src/example.ts","startLine":10,"endLine":12,"expectedContent":"old line 10\\nold line 11\\nold line 12","content":"replacement lines here\\n"}}</tool_call>`
    );
    expect(qwen).toContain(
      `<tool_call>{"name":"insert_text","arguments":{"path":"src/example.ts","line":1,"expectedLine":"current line text","text":"inserted text here\\n"}}</tool_call>`
    );
  });
});

describe("system prompt policy", () => {
  const normal = buildSystemPrompt({ family: "qwen3", planMode: false, workspaceRoot: "/tmp/ws" });
  const plan = buildSystemPrompt({ family: "qwen3", planMode: true, workspaceRoot: "/tmp/ws" });

  it("states the shared operating facts in the preamble", () => {
    for (const prompt of [normal, plan]) {
      expect(prompt).toContain("workspace at /tmp/ws");
      expect(prompt).toContain("You are offline");
      expect(prompt).toContain("[<tool> result]");
      expect(prompt).toContain("they come from the editor, not the user");
      expect(prompt).toContain("Use workspace-relative paths.");
      expect(prompt).toContain("Private reasoning goes inside <think>...</think>");
      expect(prompt).toContain("close </think> before you reply or call a tool");
      expect(prompt).toContain("Keep the user oriented as you go");
    }
  });

  it("offers update_todos in act mode only, with guidance", () => {
    expect(normal).toContain("update_todos");
    expect(normal).toContain("When a task takes more than one step, briefly tell the user what you intend to do, then call update_todos");
    // Not a read-only tool, so it is absent from the plan-mode tool list.
    expect(plan).not.toContain("update_todos");
  });

  it("describes the work loop and a summary only when done", () => {
    expect(normal).toContain("You work step by step");
    expect(normal).toContain("Continue across as many tool calls as the task needs");
    expect(normal).toContain("end with a short summary of what changed");
  });

  it("couples read_file line numbers to the edit tools", () => {
    expect(normal).toContain("Before every insert_text or replace_range call, read the target lines");
    expect(normal).toContain("at most ONE insert_text or replace_range call per response");
    expect(normal).toContain("mandatory safety preconditions");
    expect(normal).toContain("insert_text.expectedLine");
    expect(normal).toContain("replace_range.expectedContent");
    expect(normal).toContain("exact OLD/CURRENT text");
    expect(normal).toContain("the harness writes nothing and tells you to re-read");
    expect(normal).toContain("echoes fresh numbered context");
  });

  it("declares edit preconditions as required and keeps old and new content distinct", () => {
    for (const family of ["gemma4", "qwen3"] as const) {
      const prompt = buildSystemPrompt({ family, planMode: false, workspaceRoot: "/tmp/ws" });
      expect(prompt).toContain("expectedLine");
      expect(prompt).toContain("expectedContent");
      expect(prompt).toContain("OLD/CURRENT text");
      expect(prompt).toContain("NEW replacement");
    }
    expect(normal).toContain('"expectedContent"');
    expect(normal).toContain('"required": true');
  });

  it("explains run_command approval only outside plan mode", () => {
    expect(normal).toContain("run_command proposes a command for the user to approve");
    expect(plan).not.toContain("run_command");
  });

  it("offers ask_user_question in both act and plan mode", () => {
    for (const prompt of [normal, plan]) {
      expect(prompt).toContain("ask_user_question");
      expect(prompt).toContain("clarifying question");
      expect(prompt).toContain("missing user choice would materially change");
      expect(prompt).toContain("ask before inspecting or changing files");
      expect(prompt).toContain("Wait for the tool result before continuing.");
    }
    expect(plan).toContain("read_file, list_dir, glob, and ask_user_question are available");
    expect(plan).toContain("Resolve any material user choice with ask_user_question first");
  });

  it("drops the old prohibitions and stopping points", () => {
    for (const removed of [
      "GROUNDING",
      "code fence",
      "ONE tool call per turn",
      "answer directly and stop",
      "brief one-paragraph summary"
    ]) {
      expect(normal).not.toContain(removed);
    }
  });

  it("keeps the two grounding rules small models reliably break", () => {
    for (const prompt of [normal, plan]) {
      expect(prompt).toContain("there is no web access");
      expect(prompt).toContain("web_search");
      expect(prompt).toContain("only after a read_file result for it appears");
    }
  });

  it("keeps the tool-format block as the final section", () => {
    expect(normal.indexOf("You work step by step")).toBeLessThan(normal.indexOf("Available tools"));
  });

  it("plan mode offers read-only and question tools and asks for a checklist", () => {
    expect(plan).toContain("You are in plan mode");
    expect(plan).toContain("read_file, list_dir, glob, and ask_user_question are available");
    expect(plan).toContain("markdown checklist");
    expect(plan).not.toContain("You work step by step");
  });
});

describe("AGENTS.md project instructions", () => {
  it("omits the project-instruction block when no AGENTS.md is supplied", () => {
    const prompt = buildSystemPrompt({ family: "qwen3", planMode: false, workspaceRoot: "/tmp/ws" });
    expect(prompt).not.toContain("PROJECT INSTRUCTIONS");
    expect(prompt).not.toContain("begin AGENTS.md");
  });

  it("omits the block for empty/whitespace AGENTS.md content", () => {
    const prompt = buildSystemPrompt({ family: "qwen3", planMode: false, workspaceRoot: "/tmp/ws", agentsMd: "   \n  " });
    expect(prompt).not.toContain("PROJECT INSTRUCTIONS");
  });

  it("embeds the framed AGENTS.md block before the tool-format block", () => {
    const prompt = buildSystemPrompt({
      family: "qwen3",
      planMode: false,
      workspaceRoot: "/tmp/ws",
      agentsMd: "Use tabs for indentation.\nRun npm test before finishing."
    });
    expect(prompt).toContain("PROJECT INSTRUCTIONS (from AGENTS.md at the workspace root). The user's messages in this chat take precedence.");
    expect(prompt).toContain("--- begin AGENTS.md ---");
    expect(prompt).toContain("Use tabs for indentation.\nRun npm test before finishing.");
    expect(prompt).toContain("--- end AGENTS.md ---");
    // Project instructions sit after the policy but before the tool block.
    expect(prompt.indexOf("You work step by step")).toBeLessThan(prompt.indexOf("--- begin AGENTS.md ---"));
    expect(prompt.indexOf("--- begin AGENTS.md ---")).toBeLessThan(prompt.indexOf("Available tools"));
  });

  it("includes the block in plan mode too", () => {
    const prompt = buildSystemPrompt({
      family: "qwen3",
      planMode: true,
      workspaceRoot: "/tmp/ws",
      agentsMd: "Project rule: prefer composition over inheritance."
    });
    expect(prompt).toContain("PROJECT INSTRUCTIONS");
    expect(prompt).toContain("prefer composition over inheritance.");
  });
});

describe("AGENTS.md project instructions", () => {
  it("omits the project-instruction block when no AGENTS.md is supplied", () => {
    const prompt = buildSystemPrompt({ family: "qwen3", planMode: false, workspaceRoot: "/tmp/ws" });
    expect(prompt).not.toContain("PROJECT INSTRUCTIONS");
    expect(prompt).not.toContain("begin AGENTS.md");
  });

  it("omits the block for empty/whitespace AGENTS.md content", () => {
    const prompt = buildSystemPrompt({ family: "qwen3", planMode: false, workspaceRoot: "/tmp/ws", agentsMd: "   \n  " });
    expect(prompt).not.toContain("PROJECT INSTRUCTIONS");
  });

  it("embeds the framed AGENTS.md block before the tool-format block", () => {
    const prompt = buildSystemPrompt({
      family: "qwen3",
      planMode: false,
      workspaceRoot: "/tmp/ws",
      agentsMd: "Use tabs for indentation.\nRun npm test before finishing."
    });
    expect(prompt).toContain("PROJECT INSTRUCTIONS (from AGENTS.md at the workspace root).");
    expect(prompt).toContain("The user's messages in this chat take precedence.");
    expect(prompt).toContain("--- begin AGENTS.md ---");
    expect(prompt).toContain("Use tabs for indentation.\nRun npm test before finishing.");
    expect(prompt).toContain("--- end AGENTS.md ---");
    // Project instructions sit after the policy but before the tool block.
    expect(prompt.indexOf("You work step by step")).toBeLessThan(prompt.indexOf("--- begin AGENTS.md ---"));
    expect(prompt.indexOf("--- begin AGENTS.md ---")).toBeLessThan(prompt.indexOf("Available tools"));
  });

  it("includes the block in plan mode too", () => {
    const prompt = buildSystemPrompt({
      family: "qwen3",
      planMode: true,
      workspaceRoot: "/tmp/ws",
      agentsMd: "Project rule: prefer composition over inheritance."
    });
    expect(prompt).toContain("PROJECT INSTRUCTIONS");
    expect(prompt).toContain("prefer composition over inheritance.");
  });
});
