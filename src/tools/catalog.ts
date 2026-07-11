/**
 * Canonical metadata for every tool name the harness intentionally recognizes.
 *
 * Security-sensitive consumers must select tools by `availability`; a disabled
 * entry exists only so older transcripts and compatibility parsers can reject
 * it with a stable explanation. Disabled tools must never be advertised to the
 * model or treated as executable capabilities.
 */

export interface ToolParameterSpec {
  readonly type: string;
  readonly description: string;
  readonly required?: boolean;
}

/** The prompt-facing portion of a tool definition. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, ToolParameterSpec>>;
}

export type ToolAvailability = "active" | "disabled";
export type ActiveToolCategory = "read" | "write" | "todos" | "question";
export type ToolCategory = ActiveToolCategory | "command";

/**
 * Describes the complete approval contract for an active capability.
 *
 * `configurable` means approval is required unless the named setting is
 * explicitly enabled. `none` is reserved for extension-local state changes,
 * while `interactive` means the tool itself is the user interaction.
 */
export type ToolApprovalPolicy =
  | {
    readonly kind: "configurable";
    readonly setting: "autoapproveReads" | "autoapproveWrites";
    readonly defaultApproved: false;
  }
  | { readonly kind: "none" }
  | { readonly kind: "interactive" }
  | { readonly kind: "disabled" };

export interface ToolCatalogEntry extends ToolSpec {
  readonly availability: ToolAvailability;
  readonly category: ToolCategory;
  /** Whether the tool is advertised to the model while plan mode is active. */
  readonly availableInPlanMode: boolean;
  readonly approvalPolicy: ToolApprovalPolicy;
  /** Stable explanation returned when a recognized disabled tool is requested. */
  readonly disabledReason?: string;
}

const COMMAND_DISABLED_REASON = [
  `Tool "run_command" is disabled because no verified sandbox backend is available.`,
  "No command was executed.",
  "Run the command manually if needed; command execution will remain unavailable until it can be isolated from the host."
].join("\n");

/**
 * Single source of truth for tool identity, schema, mode availability, category,
 * and approval policy. Keep disabled compatibility names in this list too.
 */
export const TOOL_CATALOG = [
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the open workspace, optionally only a line range. Each returned line is prefixed with its real 1-based line number in the file and a tab (e.g. `12\\t...`); that prefix is not part of the file. Pass those numbers to insert_text and replace_range. Prefer a range for large files; a range read is prefixed with `[lines X-Y of N]`.",
    parameters: {
      path: { type: "string", description: "Workspace-relative path.", required: true },
      startLine: { type: "number", description: "Optional 1-based first line to read. Omit to read from the start." },
      endLine: { type: "number", description: "Optional 1-based last line to read, inclusive. Omit to read to the end." }
    },
    availability: "active",
    category: "read",
    availableInPlanMode: true,
    approvalPolicy: { kind: "configurable", setting: "autoapproveReads", defaultApproved: false }
  },
  {
    name: "write_file",
    description: "Replace a UTF-8 text file inside the open workspace with complete file content. Creates parent directories. Prefer insert_text or replace_range for small localized edits.",
    parameters: {
      path: { type: "string", description: "Workspace-relative path.", required: true },
      content: { type: "string", description: "Full file content.", required: true }
    },
    availability: "active",
    category: "write",
    availableInPlanMode: false,
    approvalPolicy: { kind: "configurable", setting: "autoapproveWrites", defaultApproved: false }
  },
  {
    name: "insert_text",
    description: "Insert UTF-8 text before a 1-based line number in a workspace file. Use for headers, imports, and small added blocks. Do NOT include the number-tab prefixes from read_file output in the text. The result echoes the updated region with current line numbers — use those for any follow-up edit.",
    parameters: {
      path: { type: "string", description: "Workspace-relative path.", required: true },
      line: { type: "number", description: "1-based line number to insert before. Use line 1 for the top of the file, or line_count + 1 to append.", required: true },
      text: { type: "string", description: "Text to insert, normally whole lines ending with a newline (one is added if missing).", required: true }
    },
    availability: "active",
    category: "write",
    availableInPlanMode: false,
    approvalPolicy: { kind: "configurable", setting: "autoapproveWrites", defaultApproved: false }
  },
  {
    name: "replace_range",
    description: "Replace an inclusive 1-based line range in a workspace file with new content. Use for localized edits instead of rewriting a whole file. Both startLine and endLine ARE replaced (inclusive, not exclusive). Do NOT include the number-tab prefixes from read_file output in the content. The result echoes the updated region with current line numbers — use those for any follow-up edit.",
    parameters: {
      path: { type: "string", description: "Workspace-relative path.", required: true },
      startLine: { type: "number", description: "1-based first line to replace.", required: true },
      endLine: { type: "number", description: "1-based last line to replace, inclusive.", required: true },
      content: { type: "string", description: "Only the lines that replace startLine..endLine — NOT the whole file. Normally ends with a newline (one is added if missing).", required: true }
    },
    availability: "active",
    category: "write",
    availableInPlanMode: false,
    approvalPolicy: { kind: "configurable", setting: "autoapproveWrites", defaultApproved: false }
  },
  {
    name: "list_dir",
    description: "List entries of a directory inside the open workspace.",
    parameters: {
      path: { type: "string", description: "Workspace-relative directory path.", required: true }
    },
    availability: "active",
    category: "read",
    availableInPlanMode: true,
    approvalPolicy: { kind: "configurable", setting: "autoapproveReads", defaultApproved: false }
  },
  {
    name: "glob",
    description: "List files matching a glob pattern inside the open workspace.",
    parameters: {
      pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts'.", required: true }
    },
    availability: "active",
    category: "read",
    availableInPlanMode: true,
    approvalPolicy: { kind: "configurable", setting: "autoapproveReads", defaultApproved: false }
  },
  {
    name: "ask_user_question",
    description:
      "Ask the user a single clarifying question when their request is ambiguous or you have two or three viable approaches and the choice is theirs to make. Provide 2-3 short, distinct suggested answers; the user picks one or types their own. Emit this tool on its own (not alongside other tool calls) and wait for the answer before continuing. Prefer acting on sensible defaults — use this only when a wrong guess would waste real work.",
    parameters: {
      question: { type: "string", description: "The question to ask, phrased clearly for the user.", required: true },
      suggestions: {
        type: "array",
        description: "2-3 short, distinct suggested answers as strings. The user may also enter their own answer instead.",
        required: true
      }
    },
    availability: "active",
    category: "question",
    availableInPlanMode: true,
    approvalPolicy: { kind: "interactive" }
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
    },
    availability: "active",
    category: "todos",
    availableInPlanMode: false,
    approvalPolicy: { kind: "none" }
  },
  {
    name: "run_command",
    description: "Execute a command in an isolated workspace sandbox.",
    parameters: {
      command: { type: "string", description: "Command to execute.", required: true }
    },
    availability: "disabled",
    category: "command",
    availableInPlanMode: false,
    approvalPolicy: { kind: "disabled" },
    disabledReason: COMMAND_DISABLED_REASON
  }
] as const satisfies readonly ToolCatalogEntry[];

export type CatalogEntry = (typeof TOOL_CATALOG)[number];
export type ActiveToolCatalogEntry = Extract<CatalogEntry, { availability: "active" }>;
export type DisabledToolCatalogEntry = Extract<CatalogEntry, { availability: "disabled" }>;
export type WriteToolCatalogEntry = Extract<ActiveToolCatalogEntry, { category: "write" }>;
export type KnownToolName = CatalogEntry["name"];
export type ActiveToolName = ActiveToolCatalogEntry["name"];
export type DisabledToolName = DisabledToolCatalogEntry["name"];
export type WriteToolName = WriteToolCatalogEntry["name"];

/** Active prompt declarations; disabled entries are deliberately filtered out. */
export const ACTIVE_TOOL_SPECS: readonly ToolSpec[] = TOOL_CATALOG
  .filter(tool => tool.availability === "active")
  .map(({ name, description, parameters }) => ({ name, description, parameters }));

export const ALLOWED_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_CATALOG.filter(tool => tool.availability === "active").map(tool => tool.name)
);

export const DISABLED_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_CATALOG.filter(tool => tool.availability === "disabled").map(tool => tool.name)
);

/** File mutation names derived from category metadata, never a parallel list. */
export const WRITE_TOOL_NAMES: readonly WriteToolName[] = TOOL_CATALOG
  .filter(isActiveWriteTool)
  .map(tool => tool.name);
const WRITE_TOOL_NAME_SET: ReadonlySet<string> = new Set(WRITE_TOOL_NAMES);

const FORBIDDEN_PATTERNS = [
  /^web[_-]?search$/i,
  /^http[_-]?get$/i,
  /^http[_-]?post$/i,
  /^fetch$/i,
  /^curl$/i,
  /^wget$/i,
  /^browse$/i,
  /^url[_-]?fetch$/i,
  /^download$/i
];

/** Return the catalog entry for an exact, intentionally recognized tool name. */
export function findTool(name: string): CatalogEntry | undefined {
  return TOOL_CATALOG.find(tool => tool.name === name);
}

/** Return metadata only when the name denotes an executable capability. */
export function findActiveTool(name: string): ActiveToolCatalogEntry | undefined {
  const tool = findTool(name);
  return tool?.availability === "active" ? tool : undefined;
}

/** Narrow a dynamic parser name to one of the catalog's file mutation tools. */
export function isWriteToolName(name: string): name is WriteToolName {
  return WRITE_TOOL_NAME_SET.has(name);
}

function isActiveWriteTool(tool: CatalogEntry): tool is WriteToolCatalogEntry {
  return tool.availability === "active" && tool.category === "write";
}

/** Active prompt declarations for the current immutable mode. */
export function toolsForMode(planMode: boolean): readonly ToolSpec[] {
  if (!planMode) return ACTIVE_TOOL_SPECS;
  const planNames: ReadonlySet<string> = new Set(
    TOOL_CATALOG
      .filter(tool => tool.availability === "active" && tool.availableInPlanMode)
      .map(tool => tool.name)
  );
  return ACTIVE_TOOL_SPECS.filter(tool => planNames.has(tool.name));
}

export function isForbiddenToolName(name: string): boolean {
  return FORBIDDEN_PATTERNS.some(pattern => pattern.test(name));
}

/** A stable, user-facing explanation for a recognized disabled tool. */
export function disabledToolReason(name: string): string | undefined {
  const tool = findTool(name);
  return tool?.availability === "disabled" ? tool.disabledReason : undefined;
}

export type ToolNameClassification = "allowed" | "disabled" | "forbidden" | "unknown";

export function classifyToolName(name: string): ToolNameClassification {
  const tool = findTool(name);
  if (tool?.availability === "active") return "allowed";
  if (tool?.availability === "disabled") return "disabled";
  if (isForbiddenToolName(name)) return "forbidden";
  return "unknown";
}
