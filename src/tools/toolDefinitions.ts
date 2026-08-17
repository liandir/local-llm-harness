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
    description: "Insert UTF-8 text immediately BEFORE a 1-based line number in a workspace file. Read the target first. expectedLine is a safety precondition: copy the current text of the line at `line` exactly, but omit its displayed number, tab prefix, and line break. Preserve every source-code space after the tab prefix, including leading indentation. To append, set line to line_count + 1 and expectedLine to <EOF>. If the file changed or the line is wrong, the tool refuses the edit instead of inserting in the wrong place. Use for headers, imports, and small added blocks. The result echoes the updated region with current line numbers — use those for any follow-up edit.",
    parameters: {
      path: { type: "string", description: "Workspace-relative path.", required: true },
      line: { type: "number", description: "1-based line number to insert before. Use line 1 for the top of the file, or line_count + 1 to append.", required: true },
      expectedLine: { type: "string", description: "Required safety check: exact current text of the line at `line`, without read_file's number-tab prefix or line break. Preserve all whitespace after that prefix, especially leading indentation. Use the literal <EOF> only when appending at line_count + 1.", required: true },
      text: { type: "string", description: "Text to insert, normally whole lines ending with a newline (one is added if missing).", required: true }
    }
  },
  {
    name: "replace_range",
    description: "Replace an inclusive 1-based line range in a workspace file. Read the target first. Both startLine AND endLine are replaced (inclusive). expectedContent is the OLD/CURRENT text that must already occupy exactly that range; content is the NEW replacement. For expectedContent, join multiple old lines with newline characters but omit read_file's displayed numbers, tab prefixes, and the final line break. Preserve every source-code space after each tab prefix, including leading indentation. The harness compares expectedContent immediately before writing and refuses a mismatch, so a stale or incorrect range cannot silently edit the wrong lines. Use the fresh numbered result for follow-up edits.",
    parameters: {
      path: { type: "string", description: "Workspace-relative path.", required: true },
      startLine: { type: "number", description: "1-based first line to replace.", required: true },
      endLine: { type: "number", description: "1-based last line to replace, inclusive.", required: true },
      expectedContent: { type: "string", description: "Required safety check: exact OLD/CURRENT text in startLine..endLine, joined with \n, without read_file's number-tab prefixes and without a final line break. Preserve all whitespace after each prefix, especially leading indentation. This is not the replacement.", required: true },
      content: { type: "string", description: "Only the NEW lines that replace startLine..endLine — NOT the old text and NOT the whole file. Normally ends with a newline (one is added if missing).", required: true }
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
