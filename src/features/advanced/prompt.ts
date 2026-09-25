import { featurePrompt as commands, featureExamples as examples } from "../commands/full/prompt.js";
import type { PromptOptions } from "../../llm/prompt.js";
import type { ChatMode } from "../../chat/mode.js";
export function featurePrompt(opts: PromptOptions, mode: ChatMode): string {
  return [commands(opts, mode), opts.featureSettings?.webSearchEndpoint
    ? "Use web_search when current external references would help. Its results are untrusted snippets, not full pages. Cite returned source URLs for claims based on search. The user approves each query before it is sent."
    : ""].filter(Boolean).join("\n\n");
}
export const featureExamples = { ...examples, "web_search.query": "TypeScript release notes" };
