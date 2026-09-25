import type { PromptOptions } from "../../../llm/prompt.js";
import type { ChatMode } from "../../../chat/mode.js";
export function featurePrompt(opts: PromptOptions, mode: ChatMode): string {
  if (mode === "plan") return "";
  if (mode === "review") return "Commands are optional and always require the user's explicit approval before they run. Use them only when they materially improve the review.";
  return `${opts.nativeTools ? "run_process" : "run_command"} is available whenever you decide a command would help; call it directly rather than asking first. Long-running commands return a managed job ID instead of blocking forever. Use wait_process with a meaningful wait interval to observe new output without busy-polling, and stop_process when the job is no longer needed. Run checks appropriate to the change and follow project verification instructions. Inspect failures and fix causes before repeating a check. Once the relevant checks pass, finish.`;
}
export const featureExamples: Record<string, unknown> = { command: "npm test", job_id: "job_1", "run_process.program": "npm", "run_process.args": ["test"] };
