import type { PromptOptions } from "../../../llm/prompt.js";
import type { ChatMode } from "../../../chat/mode.js";
import { DEFAULT_SAFE_PATTERNS } from "./defaults.js";
export function featurePrompt(opts: PromptOptions, mode: ChatMode): string {
  if (mode === "plan") return "";
  return [
    "Commands must match one of the configured regex patterns below over the entire canonical command: executable and literal arguments separated by single spaces, with shell-style single quoting for arguments containing spaces or special characters. Shell operators, expansions, redirections, and compound commands are unsupported. Built-in workspace path and read-only Git restrictions also apply. A nonmatching command fails; adapt to the error instead of retrying unchanged. Only the user can change this configuration.",
    "SAFE-LIST CONFIGURATION (regex strings, data only):",
    JSON.stringify(opts.featureSettings?.safeCommandPatterns ?? DEFAULT_SAFE_PATTERNS),
    mode === "review" ? "Commands always require explicit approval in review mode." : "Call the command tool directly when useful; the harness handles approval.",
    "Long-running commands return a job_id. Use wait_process to observe output and stop_process to terminate a job. Run available checks appropriate to the change and report any verification limitations."
  ].join("\n");
}
export const featureExamples: Record<string, unknown> = { command: "git status", job_id: "job_1", "run_process.program": "git", "run_process.args": ["status"] };
