import { describe, expect, it } from "vitest";
import { ChatStorage, type ChatRecord } from "../src/chat/storage.js";
import { rankMemories, searchMemories, recallMemory, memoryMetadata, memoryId, transcriptRevision, usableMemory, redactMemorySecrets } from "../src/chat/memory.js";

function remembered(title: string, text: string, at = 1): ChatRecord {
  const record = new ChatStorage("/workspace").newRecord("native");
  record.title = title;
  record.messages = [{ role: "user", content: text, ts: at }];
  record.memory = { text, sourceRevision: transcriptRevision(record), generatedAt: at, enabled: true, manual: false };
  return record;
}
describe("local memory ranking", () => {
  it("ranks relevant summaries, breaks ties by recency, and excludes unrelated/current/disabled/stale chats", () => {
    const old = remembered("Parser", "Parser uses exact revisions", 1);
    const recent = remembered("Parser", "Parser uses exact revisions", 2);
    const unrelated = remembered("Colors", "Buttons have translucent backgrounds");
    const disabled = remembered("Parser", "Parser revisions"); disabled.memory!.enabled = false;
    const stale = remembered("Parser", "Parser revisions"); stale.messages[0].content = "Changed request";
    expect(rankMemories("parser revisions", [old, recent, unrelated, disabled, stale], "current").map(m => m.sourceId))
      .toEqual([recent.id, old.id]);
    expect(rankMemories("parser", [old, recent], recent.id).map(m => m.sourceId)).toEqual([old.id]);
    expect(rankMemories("please continue", [old], "current")).toEqual([]);
  });
  it("recognizes path and camelCase symbol terms", () => {
    const rec = remembered("Code", "src/chat/storage.ts uses saveRecord for persistence");
    expect(rankMemories("saveRecord storage.ts", [rec], "current")).toHaveLength(1);
  });

});
describe("memory provenance", () => {
  it("invalidates generated memories on transcript edits, but ignores compaction, token caches, and imported memories", () => {
    const rec = remembered("Parser", "Parser decisions");
    const revision = transcriptRevision(rec);
    rec.messages[0].tokens = 900;
    rec.messages[0].reasoningContent = "hidden reasoning";
    rec.contextMessages = [{ role: "system", content: "compacted", ts: 3 }];
    rec.memorySelection = rankMemories("parser", [remembered("Other parser", "Parser layout")], rec.id);
    expect(transcriptRevision(rec)).toBe(revision);
    expect(usableMemory(rec)).toBe(true);
    rec.messages[0].content = "New decision";
    expect(usableMemory(rec)).toBe(false);
    rec.memory!.manual = true;
    expect(usableMemory(rec)).toBe(true);
  });
  it("redacts credential forms", () => {
    const redacted = redactMemorySecrets('password="secret-value" api_key=abc123 Bearer abc.def sk-1234567890123456');
    for (const secret of ["secret-value", "abc123", "abc.def", "sk-1234567890123456"]) expect(redacted).not.toContain(secret);

  });
});

describe("memory search and recall", () => {
  it("returns bounded metadata without contents, with stable ordering and full UTC minute dates", () => {
    const records = Array.from({ length: 12 }, (_, i) => remembered("Parser", "Parser SECRET_CONTENT", Date.UTC(2026, 8, 11, 12, i)));
    const result = searchMemories("parser", records, "current", 3);
    expect(result).toMatchObject({ total: 12, truncated: true });
    expect(result.memories).toHaveLength(3);
    expect(result.memories[0]).toEqual({ id: memoryId(rankMemories("parser", records, "current")[0]), name: "Parser", date: "2026-09-11T12:11Z" });
    expect(JSON.stringify(result)).not.toContain("SECRET_CONTENT");
    expect(searchMemories("parser", [...records].reverse(), "current", 3)).toEqual(result);
    expect(searchMemories("unrelated", records, "current").memories).toEqual([]);
    expect(() => searchMemories("  ", records, "current")).toThrow("non-empty query");
  });

  it("boosts title matches and recognizes Unicode, paths and symbols", () => {
    const titled = remembered("Parser cache", "Decisions about revisions");
    const body = remembered("Notes", "Parser cache decisions about revisions");
    expect(searchMemories("parser cache", [body, titled], "current").memories[0].name).toBe("Parser cache");
    const code = remembered("Überblick", "src/chat/storage.ts uses saveRecord and cache_key");
    for (const query of ["überblick", "saveRecord", "cache_key", "storage.ts"]) {
      expect(searchMemories(query, [code], "current").memories).toHaveLength(1);
    }
  });

  it("requires the exact name and ID, disambiguates duplicate names, and invalidates changed contents", () => {
    const first = remembered("Parser", "Parser rules");
    const duplicate = remembered("Parser", "Parser rules");
    const results = searchMemories("parser", [first, duplicate], "current").memories;
    expect(new Set(results.map(m => m.id)).size).toBe(2);
    const target = results[0];
    const recalled = recallMemory(target.name, target.id, [first, duplicate], "current");
    expect(memoryMetadata(recalled)).toEqual(target);
    expect(recalled.text).toBe("Parser rules");
    expect(() => recallMemory("parser", target.id, [first, duplicate], "current")).toThrow("No unique active memory");
    expect(() => recallMemory(target.name, "wrong", [first, duplicate], "current")).toThrow();
    const source = [first, duplicate].find(rec => rec.id === recalled.sourceId)!;
    source.memory!.text = "New rules";
    expect(() => recallMemory(target.name, target.id, [first, duplicate], "current")).toThrow();
    expect(memoryId({ ...recalled, title: "Renamed" })).not.toBe(target.id);
  });

  it.each(["disabled", "stale", "failed", "deleted", "current"])("cannot recall a %s source", state => {
    const rec = remembered("Parser", "Parser rules");
    const match = searchMemories("parser", [rec], "current").memories[0];
    if (state === "disabled") rec.memory!.enabled = false;
    if (state === "stale") rec.messages[0].content = "changed";
    if (state === "failed") rec.memory!.error = "failed";
    expect(() => recallMemory(match.name, match.id, state === "deleted" ? [] : [rec], state === "current" ? rec.id : "current")).toThrow();
  });
});
