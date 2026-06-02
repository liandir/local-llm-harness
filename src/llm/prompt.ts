import { ModelFamily } from "./parser/index.js";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, { type: string; description: string; required?: boolean }>;
}

export const ALL_TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the open workspace. Returns its contents.",
    parameters: {
      path: { type: "string", description: "Workspace-relative path.", required: true }
    }
  },
  {
    name: "write_file",
    description: "Write a UTF-8 text file inside the open workspace. Creates parent directories.",
    parameters: {
      path: { type: "string", description: "Workspace-relative path.", required: true },
      content: { type: "string", description: "Full file content.", required: true }
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
  }
];

const READ_ONLY = new Set(["read_file", "list_dir", "glob"]);

export interface PromptOptions {
  family: ModelFamily;
  planMode: boolean;
  workspaceRoot: string;
}

export function buildSystemPrompt(opts: PromptOptions): string {
  const tools = opts.planMode ? ALL_TOOLS.filter(t => READ_ONLY.has(t.name)) : ALL_TOOLS;

  const policy = [
    `You are an offline coding assistant running inside the user's editor.`,
    `You have NO internet access. Do not invent web_search, fetch, curl, or similar tools — any attempt will be rejected with a red error and your turn aborted.`,
    `All file I/O is confined to the workspace at: ${opts.workspaceRoot}`,
    `For shell commands, you may only propose entries in the user's safe-list; the user must approve each one. If a command is rejected before execution, treat the error as a tool result: try an allowed alternative, or ask the user to run the command manually and paste the relevant output.`,
    opts.planMode
      ? `You are in PLAN MODE. You may only call read-only tools (read_file, list_dir, glob). Your final reply MUST be a GitHub-flavored markdown checklist of steps; the user will accept or reject it before any change is made.`
      : `When you finish a task, end your reply with a brief one-paragraph summary of what changed.`
  ].join("\n");

  if (opts.family === "gemma4") {
    return policy + "\n\n" + renderGemma4ToolBlock(tools);
  }
  return policy + "\n\n" + renderQwenToolBlock(tools);
}

function renderGemma4ToolBlock(tools: ToolSpec[]): string {
  const declarations = tools.map(renderGemmaDeclaration).join("\n");
  const examples = tools.map(t => renderGemmaToolCallExample(t)).join("\n");
  return [
    "Available tools:",
    declarations,
    "",
    "To call a tool, output exactly one Gemma tool-call block:",
    `<|tool_call>call:TOOL_NAME{argument:<|"|>value<|"|>}<tool_call|>`,
    "Use <|\"|>...<|\"|> around every string value, including full file content.",
    "",
    "IMPORTANT: a tool call must be emitted as a bare tool-call block on its own — never wrap it in",
    "a ``` code fence. Tool-call blocks shown inside a ``` fence are treated as examples and are NOT run.",
    "Emit at most the tool calls you actually want executed this turn.",
    "",
    "Examples:",
    examples,
    "",
    "If you want to reason privately before answering, put it inside <think>...</think> and",
    "always close the tag. Everything outside <think>...</think> is shown to the user."
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
  const args = Object.fromEntries(
    Object.keys(tool.parameters).map(name => [name, exampleValueForParam(name)])
  );
  return renderGemmaToolCall(tool.name, args);
}

function exampleValueForParam(name: string): string {
  if (name === "path") return "src/example.ts";
  if (name === "content") return "complete file content here";
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
    "To call a tool, emit a single line of the form:",
    `<tool_call>{"name":"NAME","arguments":{...}}</tool_call>`,
    "Place chain-of-thought inside <think>...</think> if useful."
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
