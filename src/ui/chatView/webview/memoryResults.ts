import type MarkdownIt from "markdown-it";
import { renderMemoryDate } from "../../memoryDate.js";
import { cloudIcon } from "../../icons.js";
import type { MemoryCreation } from "../../../chat/memory.js";
import { renderToolOutputSurface } from "./toolOutputSurface.js";

export function renderMemoryCreation(creation: MemoryCreation, md: MarkdownIt, disclosureIcon: string): string {
  const active = creation.status === "queued" || creation.status === "generating";
  const updating = creation.operation === "update";
  const label = creation.status === "created" ? (updating ? "Updated memory" : "Created memory")
    : creation.status === "failed" ? (updating ? "Memory update failed" : "Memory creation failed")
    : updating ? "Updating memory" : "Creating memory";
  const contents = creation.status === "created"
    ? renderMemoryContents(creation.text ?? "", creation.generatedAt ?? 0, md)
    : `<div class="${creation.status === "failed" ? "tool-error-result" : "assistant-markdown"}">${md.utils.escapeHtml(
      creation.error ?? (creation.status === "queued" ? "Waiting for the model to be idle." : "Saving a summary for future chats.")
    )}</div>`;
  return `<summary class="tool-head disclosure-trigger${active ? " active-tool-head" : ""}"><span class="tool-icon" aria-hidden="true">${cloudIcon()}</span><span class="tool-name">${label}</span>${disclosureIcon}</summary>
    <div class="tool-expanded">${renderToolOutputSurface(contents, creation.status === "failed")}</div>`;
}

export function renderMemoryContents(text: string, timestamp: number, md: MarkdownIt): string {
  return `<div class="memory-details"><div class="memory-date">${renderMemoryDate(timestamp)}</div>
    <div class="assistant-markdown">${md.render(text)}</div></div>`;
}

/** Return an empty string for incomplete/old results so the card can show its raw output. */
export function renderMemoryResult(toolName: string, result: string, md: MarkdownIt): string {
  let parsed: unknown;
  try { parsed = JSON.parse(result); } catch { return ""; }
  if (!isObject(parsed)) return "";
  if (toolName === "recall_memory") {
    const contents = parsed.contents;
    return isMetadata(parsed) && typeof contents === "string"
      ? renderMemoryContents(contents, Date.parse(parsed.date), md)
      : "";
  }
  if (toolName !== "search_memories" || !Array.isArray(parsed.memories) || !parsed.memories.every(isMetadata)) return "";
  const escape = md.utils.escapeHtml;
  const rows = parsed.memories.map(memory =>
    `<li class="tool-filelist-item tool-memory-item"><span class="tool-filelist-icon" aria-hidden="true">${cloudIcon()}</span>
      <div class="tool-memory-entry"><div class="tool-memory-name">${escape(memory.name)}</div>
        <div class="memory-date">${renderMemoryDate(Date.parse(memory.date))} · <span>${escape(memory.id)}</span></div></div></li>`
  ).join("");
  const list = rows ? `<ul class="tool-filelist">${rows}</ul>`
    : `<div class="tool-filelist tool-filelist-empty">no matches</div>`;
  const truncated = parsed.truncated === true && typeof parsed.total === "number" && Number.isFinite(parsed.total)
    ? `<div class="memory-date">Showing ${parsed.memories.length} of ${parsed.total} matches</div>` : "";
  return list + truncated;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isMetadata(value: unknown): value is { name: string; id: string; date: string } {
  return isObject(value) && typeof value.name === "string" && typeof value.id === "string"
    && typeof value.date === "string" && Number.isFinite(Date.parse(value.date));
}
