import { describe, expect, it } from "vitest";
import MarkdownIt from "markdown-it";
import { renderMemoryCreation, renderMemoryResult } from "../src/ui/chatView/webview/memoryResults.js";

const md = new MarkdownIt({ html: false });
const metadata = { name: "Parser decisions", id: "abc123", date: "2026-09-11T12:30Z" };

describe("memory tool result rendering", () => {
  it.each(["create", "update"] as const)("renders %s with the same full contents and date as recall", operation => {
    const contents = "# Parser\n\nUse **strict parsing**.\n\n" + "Complete detail. ".repeat(100);
    const recalled = renderMemoryResult("recall_memory", JSON.stringify({ ...metadata, contents }), md);
    const created = renderMemoryCreation({ messageTs: 2, operation, status: "created", text: contents, generatedAt: Date.parse(metadata.date) }, md, "");
    expect(created).toContain(operation === "update" ? "Updated memory" : "Created memory");
    expect(created).toContain('class="tool-head disclosure-trigger"');
    expect(created).toContain(`<div class="tool-output-surface">${recalled}</div>`);
    expect(created).not.toContain("active-tool-head");
  });

  it.each(["queued", "generating"] as const)("shows %s creation as live tool activity", status => {
    const html = renderMemoryCreation({ messageTs: 2, status }, md, "");
    expect(html).toContain("Creating memory");
    expect(html).toContain("active-tool-head");
    expect(html).not.toContain("Created memory");
  });

  it.each(["queued", "generating", "failed"] as const)("uses update wording for %s operations on an existing memory", status => {
    const html = renderMemoryCreation({ messageTs: 2, status, operation: "update" }, md, "");
    expect(html).toContain(status === "failed" ? "Memory update failed" : "Updating memory");
    expect(html).not.toMatch(/Creating memory|Created memory|Memory creation failed/);
  });

  it("discloses a failed generation with an escaped error instead of a success label", () => {
    const html = renderMemoryCreation({ messageTs: 2, status: "failed", error: "<script>offline</script>" }, md, "");
    expect(html).toContain("Memory creation failed");
    expect(html).toContain('class="tool-output-surface error"');
    expect(html).toContain("&lt;script&gt;offline&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Created memory");
  });

  it("renders the full recalled Markdown with its date inside the card", () => {
    const contents = `# Decisions\n\nUse **strict parsing** and \`tokens\`.\n\n${"Details. ".repeat(100)}\n\n- Final detail`;
    const html = renderMemoryResult("recall_memory", JSON.stringify({ ...metadata, contents }), md);
    expect(html).toContain('<div class="assistant-markdown">');
    expect(html).toContain("<h1>Decisions</h1>");
    expect(html).toContain("<strong>strict parsing</strong>");
    expect(html).toContain("<code>tokens</code>");
    expect(html).toContain("<li>Final detail</li>");
    expect(html).toContain('datetime="2026-09-11T12:30:00.000Z"');
    expect(html).not.toContain('"contents":');
  });

  it("lists names and dates without IDs in search relevance order with truncation feedback", () => {
    const html = renderMemoryResult("search_memories", JSON.stringify({
      memories: [{ ...metadata, name: "Zebra parser" }, { ...metadata, name: "Another parser", id: "def456" }],
      total: 5, truncated: true
    }), md);
    expect(html).toContain('<ul class="tool-filelist">');
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html.indexOf("Zebra parser")).toBeLessThan(html.indexOf("Another parser"));
    expect(html).not.toContain("abc123");
    expect(html).not.toContain("def456");
    expect(html).toContain('datetime="2026-09-11T12:30:00.000Z"');
    expect(html).toContain("Showing 2 of 5 matches");
  });

  it("shows an empty search explicitly", () => {
    expect(renderMemoryResult("search_memories", '{"memories":[],"total":0,"truncated":false}', md)).toContain("no matches");
  });

  it("escapes memory metadata and disables raw HTML in recalled contents", () => {
    const unsafe = { ...metadata, name: '<img src=x onerror="alert(1)">', id: "<script>" };
    const list = renderMemoryResult("search_memories", JSON.stringify({ memories: [unsafe] }), md);
    expect(list).toContain("&lt;img");
    expect(list).not.toContain("&lt;script&gt;");
    expect(list).not.toContain("<script>");
    expect(list).not.toContain("<img");
    const recalled = renderMemoryResult("recall_memory", JSON.stringify({ ...metadata, contents: "<script>alert(1)</script>" }), md);
    expect(recalled).toContain("&lt;script&gt;");
    expect(recalled).not.toContain("<script>");
  });

  it.each([
    ["recall_memory", "error: memory is no longer active"],
    ["recall_memory", JSON.stringify({ ...metadata, contents: null })],
    ["recall_memory", JSON.stringify({ ...metadata, date: "invalid", contents: "text" })],
    ["search_memories", '{"memories":[null]}'],
    ["search_memories", '{"memories":'],
    ["search_memories", "null"]
  ])("preserves the raw fallback for invalid %s results: %s", (name, result) => {
    expect(renderMemoryResult(name, result, md)).toBe("");
  });
});
