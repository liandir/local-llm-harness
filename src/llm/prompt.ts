import { ModelFamily } from "./parser/index.js";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

export const ALL_TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the open workspace, optionally only a line range. Each returned line is prefixed with its real 1-based line number in the file and a tab (e.g. `12\\t...`); that prefix is not part of the file. Pass those numbers to insert_text and replace_range. Prefer a range for large files; a range read is prefixed with `[lines X-Y of N]`.",
    parameters: {
      path: { type: "string", description: "Workspace-relative path.", required: true },
      startLine: { type: "number", description: "Optional 1-based first line to read. Omit to read from the start." },
      endLine: { type: "number", description: "Optional 1-based last line to read, inclusive. Omit to read to the end." }
    }
  },
  {
    name: "write_file",
    description: "Replace a UTF-8 text file inside the open workspace with complete file content. Creates parent directories. Prefer insert_text or replace_range for small localized edits.",
    parameters: {
      path: { type: "string", description: "Workspace-relative path.", required: true },
      content: { type: "string", description: "Full file content.", required: true }
    }
  },
  {
    name: "insert_text",
    description: "Insert UTF-8 text exactly as provided before a 1-based line number in a workspace file. Use for headers, imports, and small added blocks. Include a trailing newline when inserting whole lines.",
    parameters: {
      path: { type: "string", description: "Workspace-relative path.", required: true },
      line: { type: "number", description: "1-based line number to insert before. Use line 1 for the top of the file, or line_count + 1 to append.", required: true },
      text: { type: "string", description: "Text to insert exactly as provided.", required: true }
    }
  },
  {
    name: "replace_range",
    description: "Replace an inclusive 1-based line range in a workspace file with UTF-8 content exactly as provided. Use for localized edits instead of rewriting a whole file.",
    parameters: {
      path: { type: "string", description: "Workspace-relative path.", required: true },
      startLine: { type: "number", description: "1-based first line to replace.", required: true },
      endLine: { type: "number", description: "1-based last line to replace, inclusive.", required: true },
      content: { type: "string", description: "Replacement content exactly as provided. Include a trailing newline when replacing whole lines.", required: true }
    }
  },
  {
    name: "list_dir",
    description: "List entries of a directory inside the open workspace.",
    parameters: {
      path: { type: "string", description: "Workspace-relative directory path.", required: true }
    }
  },
  {
    name: "glob",
    description: "List files matching a glob pattern inside the open workspace.",
    parameters: {
      pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts'.", required: true }
    }
  },
  {
    name: "run_command",
    description:
      "Propose a shell command to run in the workspace terminal. The user must approve each call; only commands matching the configured safe-list are even offered for approval.",
    parameters: {
      command: { type: "string", description: "Exact command line.", required: true }
    }
  },
  {
    name: "update_todos",
    description:
      "Record the steps of a multi-step task as a checklist the user watches live. Send the COMPLETE list every call — it replaces the previous one. Each item is { content, status } where status is \"pending\", \"in_progress\", or \"completed\". Keep exactly one item \"in_progress\" and flip items to \"completed\" as you finish them. Use it only when a task has more than one step; skip it for single-step work. It changes nothing on disk and needs no approval.",
    parameters: {
      todos: {
        type: "array",
        description: "The full list of steps, each an object {\"content\": string, \"status\": \"pending\"|\"in_progress\"|\"completed\"}.",
        required: true
      }
    }
  }
];

const READ_ONLY = new Set(["read_file", "list_dir", "glob", "update_todos"]);

export interface PromptOptions {
  family: ModelFamily;
  planMode: boolean;
  workspaceRoot: string;
  /** Trimmed contents of the project's root AGENTS.md, if one exists. */
  agentsMd?: string;
}

export function buildSystemPrompt(opts: PromptOptions): string {
  const tools = opts.planMode ? ALL_TOOLS.filter(t => READ_ONLY.has(t.name)) : ALL_TOOLS;
  const policy = policySections(opts).join("\n\n");
  const toolBlock = opts.family === "gemma4" ? renderGemma4ToolBlock(tools) : renderQwenToolBlock(tools);
  return policy + "\n\n" + toolBlock;
}

/**
 * The behavioral half of the system prompt. It states the facts and
 * affordances the model needs and cannot infer, plus the two grounding rules
 * small models reliably break (no invented tools, no quoting unread files); it
 * carries no style preferences (those belong in the project's AGENTS.md). A
 * shared preamble
 * comes first, then the mode-specific section, then the project's AGENTS.md if
 * present. The family-specific tool-format block is appended by
 * buildSystemPrompt and must stay last.
 */
function policySections(opts: PromptOptions): string[] {
  const sections: string[] = [];

  // Shared preamble: identical regardless of mode or model family.
  sections.push([
    `You are a coding agent working inside the user's editor, in the workspace at ${opts.workspaceRoot}. You are offline; the tools listed below are the only ones available, and you learn about the workspace through their results in this conversation. Tool results arrive as messages labeled [<tool> result] — they come from the editor, not the user. Use workspace-relative paths.`,
    ``,
    `The listed tools are the only ones that exist: there is no web access, and calling any other tool (web_search, fetch, curl, and the like) fails and ends your turn. Describe or quote a file's contents only after a read_file result for it appears above; read first, then speak.`,
    ``,
    `Private reasoning goes inside <think>...</think>; close </think> before you reply or call a tool. Everything outside <think> is shown to the user.`,
    ``,
    `Keep the user oriented as you go: a short note on what you're about to do, and a heads-up when you find something they should know.`
  ].join("\n"));

  if (opts.planMode) {
    sections.push(
      `You are in plan mode: read_file, list_dir, and glob are available. Explore the code, then reply with a GitHub-flavored markdown checklist of concrete steps — name the file for each step and describe the change. The user reviews and accepts the plan before any change is made; once accepted, those steps become a live todo list you keep current with update_todos as you implement them.`
    );
  } else {
    sections.push([
      `You work step by step: call a tool, read its result, then choose the next step. Continue across as many tool calls as the task needs. When everything the user asked for is done, end with a short summary of what changed.`,
      ``,
      `When a task takes more than one step, call update_todos with the full list of steps and keep it current as you go: mark one item in_progress and flip items to completed as you finish them. Skip it for single-step tasks.`,
      ``,
      `read_file shows each line prefixed with its 1-based line number. insert_text and replace_range act on those numbers, so read the file (or range) to get current numbers before editing it.`,
      ``,
      `run_command proposes a command for the user to approve; commands on the user's allow-list can run.`,
      ``,
      `When you write prose, the user already sees a diff for every edit.`
    ].join("\n"));
  }

  const agentsMd = opts.agentsMd?.trim();
  if (agentsMd) {
    sections.push([
      `PROJECT INSTRUCTIONS (from AGENTS.md at the workspace root). The user's messages in this chat take precedence.`,
      `--- begin AGENTS.md ---`,
      agentsMd,
      `--- end AGENTS.md ---`
    ].join("\n"));
  }

  return sections;
}

function renderGemma4ToolBlock(tools: ToolSpec[]): string {
  const declarations = tools.map(renderGemmaDeclaration).join("\n");
  const examples = tools.map(t => renderGemmaToolCallExample(t)).join("\n");
  return [
    "Available tools:",
    declarations,
    "",
    "Emit a tool call as a single block on its own line:",
    `<|tool_call>call:TOOL_NAME{argument:<|"|>value<|"|>}<tool_call|>`,
    "Wrap every string value in <|\"|>...<|\"|>, including full file content.",
    "",
    "Examples:",
    examples
  ].join("\n");
}

function renderGemmaDeclaration(tool: ToolSpec): string {
  const required = Object.entries(tool.parameters)
    .filter(([, spec]) => spec.required)
    .map(([name]) => name);
  const properties = Object.entries(tool.parameters)
    .map(([name, spec]) => {
      const parts = [
        `description:${gemmaString(spec.description)}`,
        `type:${gemmaString(spec.type.toUpperCase())}`
      ];
      return `${name}:{${parts.join(",")}}`;
    })
    .join(",");
  const params = [
    `properties:{${properties}}`,
    `required:[${required.map(gemmaString).join(",")}]`,
    `type:${gemmaString("OBJECT")}`
  ].join(",");
  return `<|tool>declaration:${tool.name}{description:${gemmaString(tool.description)},parameters:{${params}}}<tool|>`;
}

function renderGemmaToolCallExample(tool: ToolSpec): string {
  // Examples show only required params: an example with optional params (e.g.
  // read_file's startLine/endLine) teaches small models to always send them.
  const args = Object.fromEntries(
    Object.entries(tool.parameters)
      .filter(([, spec]) => spec.required)
      .map(([name]) => [name, exampleValueForParam(name)])
  );
  return renderGemmaToolCall(tool.name, args);
}

function exampleValueForParam(name: string): unknown {
  if (name === "path") return "src/example.ts";
  if (name === "content") return "complete file content here";
  if (name === "text") return "inserted text here\n";
  if (name === "line") return 1;
  if (name === "startLine") return 10;
  if (name === "endLine") return 12;
  if (name === "command") return "npm test";
  if (name === "pattern") return "src/**/*.ts";
  return `${name} value`;
}

export function renderToolCallForPrompt(
  family: ModelFamily,
  name: string,
  argsJson: string
): string {
  let args: unknown = {};
  try {
    args = JSON.parse(argsJson);
  } catch {
    args = {};
  }
  if (family === "gemma4") {
    return renderGemmaToolCall(name, args);
  }
  return `<tool_call>${JSON.stringify({ name, arguments: isRecord(args) ? args : {} })}</tool_call>`;
}

function renderGemmaToolCall(name: string, args: unknown): string {
  const rendered = isRecord(args)
    ? Object.entries(args).map(([key, value]) => `${key}:${renderGemmaValue(value)}`).join(",")
    : "";
  return `<|tool_call>call:${name}{${rendered}}<tool_call|>`;
}

function renderGemmaValue(value: unknown): string {
  if (typeof value === "string") return gemmaString(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(renderGemmaValue).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value).map(([key, v]) => `${key}:${renderGemmaValue(v)}`).join(",")}}`;
  }
  return gemmaString(String(value ?? ""));
}

function gemmaString(value: string): string {
  return `<|"|>${value}<|"|>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function renderQwenToolBlock(tools: ToolSpec[]): string {
  return [
    "Available tools (Hermes JSON format):",
    JSON.stringify(tools, null, 2),
    "",
    "Emit a tool call as a single block on its own line:",
    `<tool_call>{"name":"NAME","arguments":{...}}</tool_call>`
  ].join("\n");
}

export interface PromptMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * Merge consecutive messages that share a role into one, joined by a blank line.
 *
 * Gemma's chat template requires strictly alternating user/model turns and
 * throws on two user turns in a row — which happens whenever the model emits a
 * tool call with no visible text (no assistant turn is recorded) and the tool
 * result is then replayed as a user turn. Coalescing keeps the transcript
 * alternating for any template, Gemma included.
 */
export function coalesceSameRole(messages: PromptMessage[]): PromptMessage[] {
  const out: PromptMessage[] = [];
  for (const m of messages) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}
