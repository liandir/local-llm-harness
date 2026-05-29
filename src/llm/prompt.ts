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
    `For shell commands, you may only propose entries in the user's safe-list; the user must approve each one.`,
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
  const inner = tools
    .map(t => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }, null, 2))
    .join("\n");
  const examples = tools.map(t => renderGemmaXmlExample(t)).join("\n\n");
  return [
    "Available tools:",
    "<|tool>",
    inner,
    "<tool|>",
    "",
    "To call a tool, emit one XML block using the tool name as the outer tag and each argument as its own tag.",
    "Do not use JSON for tool arguments. For file content, place the raw complete file text inside <content>...</content> without escaping newlines.",
    "",
    "Examples:",
    examples,
    "Place thinking inside <|channel>thought ... and the user-visible answer inside <|channel>final ..."
  ].join("\n");
}

function renderGemmaXmlExample(tool: ToolSpec): string {
  const params = Object.keys(tool.parameters)
    .map(name => `<${name}>${exampleValueForParam(name)}</${name}>`)
    .join("\n");
  return `<${tool.name}>\n${params}\n</${tool.name}>`;
}

function exampleValueForParam(name: string): string {
  if (name === "path") return "src/example.ts";
  if (name === "content") return "complete file content here";
  if (name === "command") return "npm test";
  if (name === "pattern") return "src/**/*.ts";
  return `${name} value`;
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
