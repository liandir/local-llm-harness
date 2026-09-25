import { chatFeature as commands } from "../commands/shared/ui.js";
import type { ChatFeature } from "../../build/chatContracts.js";
export const chatFeature: ChatFeature = {
  ...commands,
  active: { ...commands.active, web_search: "Searching the web" },
  settled: { ...commands.settled, web_search: "Searched the web" },
  aliases: { ...commands.aliases, web_search: "Search the web" },
  subjects: { ...commands.subjects, web_search: "Web search" },
  fullResult: name => name === "web_search",
  renderResult(card, escape, separator) {
    if (card.toolName !== "web_search" || !card.resultPreview) return undefined;
    try {
      const payload = JSON.parse(card.resultPreview);
      if (!Array.isArray(payload.results)) return undefined;
      const links = payload.results.flatMap((result: { url?: unknown; title?: unknown; snippet?: unknown }) => {
        if (typeof result?.url !== "string") return [];
        let url: URL;
        try { url = new URL(result.url); } catch { return []; }
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return [];
        return [`<p><a href="${escape(url.href)}">${escape(String(result.title ?? url.hostname))}</a><br>${escape(String(result.snippet ?? ""))}</p>`];
      }).join("");
      return `<div class="tool-output-header"><span class="tool-label-main">${escape(String(payload.query ?? "Web search"))}</span></div>${separator}<div class="tool-filelist assistant-markdown">${links || "No results found."}</div>`;
    } catch { return undefined; }
  },
  groupLabel: (name: string, count: number) => name === "web_search" ? "searched the web" : commands.groupLabel?.(name, count)
};
