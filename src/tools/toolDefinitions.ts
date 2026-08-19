export interface JsonSchema {
  type: "object" | "array" | "string" | "integer" | "number" | "boolean";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema & { type: "object"; properties: Record<string, JsonSchema> };
}

export interface OpenAiTool {
  type: "function";
  function: ToolSpec;
}

export function asOpenAiTools(tools: ToolSpec[]): OpenAiTool[] {
  return tools.map(tool => ({ type: "function", function: tool }));
}

const objectParameters = (
  properties: Record<string, JsonSchema>,
  required: string[]
): ToolSpec["parameters"] => ({
  type: "object",
  properties,
  required,
  additionalProperties: false
});

export const ALL_TOOLS: ToolSpec[] = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the open workspace, optionally only a line range. Each returned line is prefixed with its real 1-based line number in the file and a tab (e.g. `12\\t...`); that prefix is not part of the file. Pass those numbers to insert_text and replace_range. Prefer a range for large files; a range read is prefixed with `[lines X-Y of N]`.",
    parameters: objectParameters({
      path: { type: "string", description: "Workspace-relative path." },
      startLine: { type: "integer", minimum: 1, description: "Optional 1-based first line to read. Omit to read from the start." },
      endLine: { type: "integer", minimum: 1, description: "Optional 1-based last line to read, inclusive. Omit to read to the end." }
    }, ["path"])
  },
  {
    name: "write_file",
    description: "Replace a UTF-8 text file inside the open workspace with complete file content. Creates parent directories. Prefer insert_text or replace_range for small localized edits.",
    parameters: objectParameters({
      path: { type: "string", description: "Workspace-relative path." },
      content: { type: "string", description: "Full file content." }
    }, ["path", "content"])
  },
  {
    name: "create_file",
    description: "Create a new UTF-8 text file inside the workspace. Fails if the path already exists; use edit_file for an existing file.",
    parameters: objectParameters({
      path: { type: "string", description: "Workspace-relative path." },
      content: { type: "string", description: "Complete initial file content." }
    }, ["path", "content"])
  },
  {
    name: "edit_file",
    description: "Atomically edit an existing UTF-8 file using exact text replacements. First call read_file and pass its revision as baseRevision. Every oldText must occur exactly once in the progressively edited file; otherwise nothing is written.",
    parameters: objectParameters({
      path: { type: "string", description: "Workspace-relative path." },
      baseRevision: { type: "string", description: "SHA-256 revision returned by read_file. The canonical sha256:<64 hex digits> form is preferred; the bare 64-digit digest is also accepted." },
      edits: {
        type: "array",
        minItems: 1,
        description: "Ordered exact replacements applied atomically.",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Non-empty exact current text; it must occur exactly once." },
            newText: { type: "string", description: "Replacement text; use an empty string to delete oldText." }
          },
          required: ["oldText", "newText"],
          additionalProperties: false
        }
      }
    }, ["path", "baseRevision", "edits"])
  },
  {
    name: "insert_text",
    description: "Insert UTF-8 text immediately BEFORE a 1-based line number in a workspace file. Read the target first. expectedLine is a safety precondition: copy the current text of the line at `line` exactly, but omit its displayed number, tab prefix, and line break. Preserve every source-code space after the tab prefix, including leading indentation. To append, set line to line_count + 1 and expectedLine to <EOF>. If the file changed or the line is wrong, the tool refuses the edit instead of inserting in the wrong place. Use for headers, imports, and small added blocks. The result echoes the updated region with current line numbers — use those for any follow-up edit.",
    parameters: objectParameters({
      path: { type: "string", description: "Workspace-relative path." },
      line: { type: "integer", minimum: 1, description: "1-based line number to insert before. Use line 1 for the top of the file, or line_count + 1 to append." },
      expectedLine: { type: "string", description: "Required safety check: exact current text of the line at `line`, without read_file's number-tab prefix or line break. Preserve all whitespace after that prefix, especially leading indentation. Use the literal <EOF> only when appending at line_count + 1." },
      text: { type: "string", description: "Text to insert, normally whole lines ending with a newline (one is added if missing)." }
    }, ["path", "line", "expectedLine", "text"])
  },
  {
    name: "replace_range",
    description: "Replace an inclusive 1-based line range in a workspace file. Read the target first. Both startLine AND endLine are replaced (inclusive). expectedContent is the OLD/CURRENT text that must already occupy exactly that range; content is the NEW replacement. For expectedContent, join multiple old lines with newline characters but omit read_file's displayed numbers, tab prefixes, and the final line break. Preserve every source-code space after each tab prefix, including leading indentation. The harness compares expectedContent immediately before writing and refuses a mismatch, so a stale or incorrect range cannot silently edit the wrong lines. Use the fresh numbered result for follow-up edits.",
    parameters: objectParameters({
      path: { type: "string", description: "Workspace-relative path." },
      startLine: { type: "integer", minimum: 1, description: "1-based first line to replace." },
      endLine: { type: "integer", minimum: 1, description: "1-based last line to replace, inclusive." },
      expectedContent: { type: "string", description: "Required safety check: exact OLD/CURRENT text in startLine..endLine, joined with \n, without read_file's number-tab prefixes and without a final line break. Preserve all whitespace after each prefix, especially leading indentation. This is not the replacement." },
      content: { type: "string", description: "Only the NEW lines that replace startLine..endLine — NOT the old text and NOT the whole file. Normally ends with a newline (one is added if missing)." }
    }, ["path", "startLine", "endLine", "expectedContent", "content"])
  },
  {
    name: "list_dir",
    description: "List entries of a directory inside the open workspace.",
    parameters: objectParameters({
      path: { type: "string", description: "Workspace-relative directory path." }
    }, ["path"])
  },
  {
    name: "glob",
    description: "List files matching a glob pattern inside the open workspace.",
    parameters: objectParameters({
      pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts'." }
    }, ["pattern"])
  },
  {
    name: "run_command",
    description:
      "Run a shell command in the workspace terminal when you decide it would help. Call the tool directly; the harness handles approval. Commands require explicit user approval unless a safe-list match is eligible for the user's auto-approve setting.",
    parameters: objectParameters({
      command: { type: "string", description: "Exact command line." }
    }, ["command"])
  },
  {
    name: "run_process",
    description:
      "Run a program and argument vector in the workspace when you decide it would help. No shell interprets the arguments. Call the tool directly; the harness handles approval. Commands require explicit user approval unless a safe-list match is eligible for the user's auto-approve setting.",
    parameters: objectParameters({
      program: { type: "string", description: "Executable name, for example npm, git, or ls." },
      args: {
        type: "array",
        description: "Arguments passed directly to the program without shell parsing.",
        items: { type: "string" }
      }
    }, ["program", "args"])
  },
  {
    name: "ask_user_question",
    description:
      "Ask the user a single clarifying question when their request is ambiguous or you have two or three viable approaches and the choice is theirs to make. Provide 2-3 short, distinct suggested answers; the user picks one or types their own. Emit this tool on its own (not alongside other tool calls) and wait for the answer before continuing. Prefer acting on sensible defaults — use this only when a wrong guess would waste real work.",
    parameters: objectParameters({
      question: { type: "string", description: "The question to ask, phrased clearly for the user." },
      suggestions: {
        type: "array",
        description: "2-3 short, distinct suggested answers as strings. The user may also enter their own answer instead.",
        items: { type: "string" },
        minItems: 2,
        maxItems: 3
      }
    }, ["question", "suggestions"])
  },
  {
    name: "update_todos",
    description:
      "Record the steps of a multi-step task as a checklist the user watches live. Send the COMPLETE list every call — it replaces the previous one. Each item is { content, status } where status is \"pending\", \"in_progress\", or \"completed\". Keep exactly one item \"in_progress\" and flip items to \"completed\" as you finish them. Use it only when a task has more than one step; skip it for single-step work. It changes nothing on disk and needs no approval.",
    parameters: objectParameters({
      todos: {
        type: "array",
        description: "The full list of steps, each an object {\"content\": string, \"status\": \"pending\"|\"in_progress\"|\"completed\"}.",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] }
          },
          required: ["content", "status"],
          additionalProperties: false
        }
      }
    }, ["todos"])
  }
];

const PLAN_MODE_TOOL_NAMES = new Set(["read_file", "list_dir", "glob", "ask_user_question"]);

export function toolsForMode(planMode: boolean, transport: "native" | "legacy" = "legacy"): ToolSpec[] {
  if (planMode) return ALL_TOOLS.filter(tool => PLAN_MODE_TOOL_NAMES.has(tool.name));
  const excluded = transport === "native"
    ? new Set(["run_command", "write_file"])
    : new Set(["run_process", "create_file", "edit_file"]);
  return ALL_TOOLS.filter(tool => !excluded.has(tool.name));
}

export function validateToolArguments(toolName: string, value: unknown): string | undefined {
  const tool = ALL_TOOLS.find(candidate => candidate.name === toolName);
  if (!tool) return `Unknown tool "${toolName}".`;
  return validateSchema(tool.parameters, value, "arguments");
}

function validateSchema(schema: JsonSchema, value: unknown, path: string): string | undefined {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path} must be an object.`;
    const record = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (!(name in record)) return `${path}.${name} is required.`;
    }
    if (schema.additionalProperties === false) {
      const unknown = Object.keys(record).find(name => !(name in (schema.properties ?? {})));
      if (unknown) return `${path}.${unknown} is not an allowed property.`;
    }
    for (const [name, child] of Object.entries(schema.properties ?? {})) {
      if (name in record) {
        const error = validateSchema(child, record[name], `${path}.${name}`);
        if (error) return error;
      }
    }
    return undefined;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path} must be an array.`;
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} must contain at least ${schema.minItems} items.`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} must contain at most ${schema.maxItems} items.`;
    if (schema.items) {
      for (let index = 0; index < value.length; index++) {
        const error = validateSchema(schema.items, value[index], `${path}[${index}]`);
        if (error) return error;
      }
    }
    return undefined;
  }
  if (schema.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return `${path} must be an integer.`;
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be at least ${schema.minimum}.`;
    return undefined;
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path} must be a number.`;
    return undefined;
  }
  if (typeof value !== schema.type) return `${path} must be a ${schema.type}.`;
  if (schema.enum && (typeof value !== "string" || !schema.enum.includes(value))) {
    return `${path} must be one of: ${schema.enum.join(", ")}.`;
  }
  return undefined;
}
