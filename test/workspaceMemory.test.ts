import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
const mocks = vi.hoisted(() => ({
  settings: { memoryEnabled: true, endpoint: "http://127.0.0.1:8080", model: "test" },
  complete: vi.fn(), tokenize: vi.fn(), context: vi.fn()
}));
vi.mock("../src/config/settings.js", () => ({ readSettings: () => mocks.settings }));
vi.mock("../src/llm/client.js", () => ({
  complete: mocks.complete, tokenize: mocks.tokenize, fetchServerContextSize: mocks.context
}));
import { WorkspaceMemory, generateMemory, activeSnapshots } from "../src/chat/workspaceMemory.js";
import { ChatStorage, type ChatRecord } from "../src/chat/storage.js";
import { transcriptRevision, rankMemories, recallMemory, memoryMetadata } from "../src/chat/memory.js";
import { beginForeground, foregroundBusy } from "../src/llm/activity.js";
let dir: string;
let storage: ChatStorage;
let memory: WorkspaceMemory;
let releases: (() => void)[];
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "llh-memory-"));
  storage = new ChatStorage(path.join(dir, "workspace"), path.join(dir, "chats"));
  memory = new WorkspaceMemory(() => storage, 5);
  releases = [];
  mocks.settings.memoryEnabled = true;
  mocks.settings.model = "test";
  mocks.complete.mockReset().mockResolvedValue("Parser uses exact revisions. Verified by tests.");
  mocks.tokenize.mockReset().mockImplementation(async (_endpoint, text: string) => Math.ceil(text.length / 4));
  mocks.context.mockReset().mockResolvedValue(8192);
});
afterEach(async () => { memory.dispose(); releases.forEach(release => release()); await fs.rm(dir, { recursive: true, force: true }); });
async function chat(text = "Parser change requested"): Promise<ChatRecord> {
  const rec = storage.newRecord("native"); rec.title = "Parser";
  rec.messages = [{ role: "user", content: text, ts: 1 }, { role: "assistant", content: "Parser changed and verified", ts: 2 }];
  await storage.save(rec); return rec;
}
async function generated(id: string): Promise<void> {
  await vi.waitFor(async () => expect((await storage.load(id))?.memory?.text).toContain("Parser"));
}
describe("memory generation", () => {
  it("activates new summaries for retrieval automatically", async () => {
    const rec = await chat();
    memory.enqueue(rec.id);
    await generated(rec.id);
    expect((await memory.list())[0]).toMatchObject({ enabled: true, status: "ready", usable: true });
    expect(rankMemories("parser", await storage.records(), "new-chat")).toHaveLength(1);
  });

  it("persists recalled contents after the answer and retains earlier turn cards on reopening", async () => {
    const rec = await chat();
    const end = beginForeground(); releases.push(end);
    memory.enqueue(rec.id);
    expect(await memory.creations(rec.id)).toEqual([{ messageTs: 2, status: "queued", operation: "create" }]);
    end();
    await generated(rec.id);
    const snapshots = rankMemories("parser", await storage.records(), "new-chat");
    const metadata = memoryMetadata(snapshots[0]);
    const recalled = recallMemory(metadata.name, metadata.id, await storage.records(), "new-chat");
    expect(await memory.creations(rec.id)).toEqual([
      { messageTs: 2, status: "created", operation: "create", text: recalled.text, generatedAt: recalled.generatedAt }
    ]);
    rec.messages.push({ role: "user", content: "next", ts: 3 }, { role: "assistant", content: "next answer", ts: 4 });
    await storage.save(rec); // stale session saves preserve background history
    const pause = beginForeground(); releases.push(pause);
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(rec.id);
    expect((await memory.creations(rec.id)).at(-1)).toEqual({ messageTs: 4, status: "queued", operation: "update" });
    pause();
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await memory.creations(rec.id)).at(-1)).toEqual({ messageTs: 4, status: "generating", operation: "update" });
    finish("Parser updated memory");
    await vi.waitFor(async () => expect((await memory.creations(rec.id)).map(item => item.status)).toEqual(["created", "created"]));
    const reopened = new WorkspaceMemory(() => storage);
    expect((await reopened.creations(rec.id)).map(item => [item.messageTs, item.operation])).toEqual([[2, "create"], [4, "update"]]);
    reopened.dispose();
    expect((await storage.fork(rec)).memoryCreations).toBeUndefined();
    rec.messages = rec.messages.slice(0, 1);
    await storage.save(rec);
    expect(await memory.creations(rec.id)).toEqual([]);
  });

  it("finishes active memory before a chat turn and defers other queued memories", async () => {
    const first = await chat(); const second = await chat("second");
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(first.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    memory.enqueue(second.id);
    const waiting = vi.fn();
    let acquired = false;
    const turn = memory.beginChatTurn(new AbortController().signal, waiting).then(release => {
      releases.push(release); acquired = true; return release;
    });
    expect(waiting).toHaveBeenCalledOnce();
    expect(await memory.creations(first.id)).toEqual([{ messageTs: 2, status: "generating", operation: "create" }]);
    expect(acquired).toBe(false);
    expect(mocks.complete.mock.calls[0][2].aborted).toBe(false);
    finish("Parser memory");
    const release = await turn;
    expect(foregroundBusy()).toBe(true);
    expect((await storage.load(first.id))!.memory!.text).toBe("Parser memory");
    expect(mocks.complete).toHaveBeenCalledOnce();
    release();
    await generated(second.id);
  });

  it("saves the completed answer's memory even when a follow-up is accepted during generation", async () => {
    const rec = await chat();
    const revision = transcriptRevision(rec);
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(rec.id, false, 2);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    const turn = memory.beginChatTurn(new AbortController().signal, vi.fn());
    rec.messages.push({ role: "user", content: "Next request", ts: 3 });
    await storage.save(rec);
    expect(await memory.creations(rec.id)).toEqual([{ messageTs: 2, status: "generating", operation: "create" }]);
    finish("Parser memory for the previous answer");
    releases.push(await turn);
    const saved = (await storage.load(rec.id))!;
    expect(saved.messages.at(-1)).toMatchObject({ role: "user", content: "Next request" });
    expect(saved.memory).toMatchObject({ text: "Parser memory for the previous answer", sourceRevision: revision, enabled: true });
    expect(await memory.creations(rec.id)).toEqual([expect.objectContaining({ messageTs: 2, status: "created", text: saved.memory!.text })]);
    await storage.save(rec);
    expect((await storage.load(rec.id))!.memoryCreations).toEqual(saved.memoryCreations);
  });

  it("excludes a follow-up saved before the generation source is loaded", async () => {
    const rec = await chat();
    const revision = transcriptRevision(rec);
    const release = beginForeground(); releases.push(release);
    memory.enqueue(rec.id, false, 2);
    rec.messages.push({ role: "user", content: "FOLLOW_UP_SENTINEL", ts: 3 });
    await storage.save(rec);
    release();
    await generated(rec.id);
    expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain("FOLLOW_UP_SENTINEL");
    expect((await storage.load(rec.id))!.memory!.sourceRevision).toBe(revision);
    expect(await memory.creations(rec.id)).toEqual([expect.objectContaining({ messageTs: 2, status: "created" })]);
  });

  it("keeps a queued card attached to the completed answer during the next turn's tool calls", async () => {
    const rec = await chat();
    const release = beginForeground(); releases.push(release);
    memory.enqueue(rec.id, false, 2);
    rec.messages.push({ role: "user", content: "next request", ts: 3 }, { role: "assistant", content: "Checking files", ts: 4 });
    await storage.save(rec);
    expect(await memory.creations(rec.id)).toEqual([{ messageTs: 2, status: "queued", operation: "create" }]);
    memory.reset();
  });

  it("cancels a waiting turn without aborting memory generation or leaking a reservation", async () => {
    const first = await chat(); const second = await chat("second");
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(first.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    memory.enqueue(second.id);
    const controller = new AbortController();
    const turn = memory.beginChatTurn(controller.signal, vi.fn());
    controller.abort();
    await expect(turn).rejects.toThrow();
    expect(foregroundBusy()).toBe(false);
    expect(mocks.complete.mock.calls[0][2].aborted).toBe(false);
    finish("Parser memory");
    await generated(second.id);
  });

  it("releases waiting turns after memory failure", async () => {
    const rec = await chat();
    let fail!: (error: Error) => void;
    mocks.complete.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    memory.enqueue(rec.id);
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    const turn = memory.beginChatTurn(new AbortController().signal, vi.fn());
    fail(new Error("offline"));
    const release = await turn; releases.push(release);
    expect((await memory.creations(rec.id))[0]).toMatchObject({ messageTs: 2, status: "failed" });
    expect(foregroundBusy()).toBe(true);
  });

  it.each(["", "Existing Parser summary"])("retains the operation after failure and retry with prior contents %j", async text => {
    const rec = await chat();
    if (text) await storage.updateMemory(rec.id, () => ({
      text, sourceRevision: "0".repeat(64), generatedAt: 1, enabled: true, manual: false
    }));
    const operation = text ? "update" : "create";
    mocks.complete.mockRejectedValueOnce(new Error("offline"));
    memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.creations(rec.id))[0]).toMatchObject({ status: "failed", operation }));
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(rec.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await memory.creations(rec.id))[0]).toMatchObject({ status: "generating", operation });
    finish("Parser retry succeeded");
    await vi.waitFor(async () => expect((await memory.creations(rec.id))[0]).toMatchObject({ status: "created", operation }));
  });

  it("keeps manual creation inactive and preserves activation across editing and regeneration", async () => {
    const rec = await chat();
    await memory.edit(rec.id, "Manual Parser decision");
    expect((await storage.load(rec.id))!.memory!.enabled).toBe(false);
    for (const enabled of [false, true]) {
      await memory.setEnabled(rec.id, enabled);
      await memory.edit(rec.id, "Manual Parser decision");
      expect((await storage.load(rec.id))!.memory!.enabled).toBe(enabled);
      await memory.regenerate(rec.id);
      await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("ready"));
      expect((await storage.load(rec.id))!.memory!.enabled).toBe(enabled);
    }
  });

  it("uses bounded visible transcript chunks without tools, reasoning, or imported memories", async () => {
    const rec = await chat("parser ".repeat(6000) + ' password="hidden-secret"');
    rec.messages.push({ role: "tool", content: "RAW_TOOL_SENTINEL", ts: 3 });
    rec.messages[1].reasoningContent = "REASONING_SENTINEL";
    rec.contextMessages = [{ role: "system", content: "CONTEXT_SENTINEL", ts: 4 }];
    rec.memorySelection = [{ sourceId: rec.id, title: "Imported", text: "IMPORTED_SENTINEL", generatedAt: 1, sourceRevision: transcriptRevision(rec) }];
    const text = await generateMemory(rec, mocks.settings.endpoint, "test", new AbortController().signal);
    expect(Math.ceil(text.length / 4)).toBeLessThanOrEqual(384);
    expect(mocks.complete.mock.calls.length).toBeGreaterThan(1);
    for (const [, request] of mocks.complete.mock.calls) {
      const raw = JSON.stringify(request.messages);
      for (const forbidden of ["RAW_TOOL_SENTINEL", "REASONING_SENTINEL", "IMPORTED_SENTINEL", "CONTEXT_SENTINEL", "hidden-secret"]) expect(raw).not.toContain(forbidden);
      expect(request.background).toBe(true);
      expect(raw.length / 4).toBeLessThan(8192 - 512);
    }
  });
  it("does not process old chats until requested and skips manual summaries", async () => {
    mocks.settings.memoryEnabled = false;
    const first = await chat(); const manual = await chat("Manual");
    await memory.edit(manual.id, "Manually curated parser decision");
    expect(mocks.complete).not.toHaveBeenCalled();
    await memory.summarizeExisting();
    await generated(first.id);
    expect((await storage.load(manual.id))!.memory!.manual).toBe(true);
    expect(mocks.complete).toHaveBeenCalledTimes(1);
  });
  it("defers background work during foreground activity and retries preempted generation", async () => {
    mocks.settings.memoryEnabled = false;
    const rec = await chat();
    const end = beginForeground(); releases.push(end);
    await memory.regenerate(rec.id);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(mocks.complete).not.toHaveBeenCalled();
    mocks.complete.mockImplementationOnce((_endpoint, _req, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    end();
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(1));
    const pause = beginForeground(); releases.push(pause);
    await vi.waitFor(() => expect(mocks.complete.mock.calls[0][2].aborted).toBe(true));
    pause();
    await generated(rec.id);
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });
  it("ignores stale generation results and never overwrites a manual edit", async () => {
    const rec = await chat();
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(rec.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    rec.messages[0].content = "changed request";
    await storage.save(rec);
    finish("Old Parser decision");
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("missing"));
    expect((await storage.load(rec.id))!.memory).toBeUndefined();
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(rec.id);
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledTimes(2));
    await memory.edit(rec.id, "Manual Parser decision");
    finish("Generated Parser decision");
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("manual"));
    await storage.save(rec); // stale live session must preserve the manual edit
    expect((await storage.load(rec.id))!.memory!.text).toBe("Manual Parser decision");
  });
  it("exposes failures for retry and cancelling does not create a memory", async () => {
    const rec = await chat();
    mocks.complete.mockRejectedValueOnce(new Error("server offline"));
    memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    expect((await storage.load(rec.id))!.messages).toEqual(rec.messages);
    await memory.regenerate(rec.id);
    await generated(rec.id);
    memory.reset();
    const second = await chat("second"); memory.enqueue(second.id); memory.reset();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await storage.load(second.id))!.memory).toBeUndefined();
  });
  it("keeps previous manual text inspectable when explicit regeneration fails", async () => {
    mocks.settings.memoryEnabled = false;
    const rec = await chat();
    await memory.edit(rec.id, "Manual Parser decision to retain");
    mocks.complete.mockRejectedValueOnce(new Error("server offline"));
    await memory.regenerate(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("failed"));
    expect((await storage.load(rec.id))!.memory!.text).toBe("Manual Parser decision to retain");
    await memory.regenerate(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("ready"));
    expect((await storage.load(rec.id))!.memory!.text).toBe("Parser uses exact revisions. Verified by tests.");
  });

  it("generates queued summaries when context loading is disabled", async () => {
    const rec = await chat(); memory.enqueue(rec.id);
    mocks.settings.memoryEnabled = false; memory.settingsChanged();
    await generated(rec.id);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it("does not interrupt active generation when context loading is disabled", async () => {
    const rec = await chat();
    let finish!: (text: string) => void;
    mocks.complete.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    memory.enqueue(rec.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    mocks.settings.memoryEnabled = false; memory.settingsChanged();
    expect(mocks.complete.mock.calls[0][2].aborted).toBe(false);
    finish("Parser decision");
    await generated(rec.id);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });
  it("restarts active generation with the new model when settings change", async () => {
    const rec = await chat();
    mocks.complete.mockImplementationOnce((_endpoint, _req, signal: AbortSignal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    memory.enqueue(rec.id);
    await vi.waitFor(() => expect(mocks.complete).toHaveBeenCalledOnce());
    mocks.settings.model = "replacement"; memory.settingsChanged();
    await generated(rec.id);
    expect(mocks.complete.mock.calls[0][2].aborted).toBe(true);
    expect(mocks.complete.mock.calls[1][1].model).toBe("replacement");
  });
  it("skips individually excluded chats when context loading is disabled", async () => {
    mocks.settings.memoryEnabled = false;
    const rec = await chat();
    await memory.setEnabled(rec.id, false);
    memory.enqueue(rec.id);
    await vi.waitFor(async () => expect((await memory.list())[0].status).toBe("stale"));
    expect(mocks.complete).not.toHaveBeenCalled();
  });
});
describe("workspace memory persistence", () => {
  it("reports eligibility for the cloud icon using the same rules as retrieval", async () => {
    const rec = await chat();
    expect((await memory.list())[0]).toMatchObject({ enabled: false, status: "missing", usable: false });
    await storage.updateMemory(rec.id, current => ({ text: "Parser decision", sourceRevision: transcriptRevision(current), generatedAt: 1, enabled: true, manual: false }));
    expect((await memory.list())[0]).toMatchObject({ status: "ready", usable: true });
    await memory.setEnabled(rec.id, false);
    expect((await memory.list())[0]).toMatchObject({ enabled: false, usable: false });
    await memory.setEnabled(rec.id, true);
    rec.messages[0].content = "Changed request";
    await storage.save(rec);
    expect((await memory.list())[0]).toMatchObject({ status: "stale", usable: false });
    await memory.edit(rec.id, "Manual Parser decision");
    expect((await memory.list())[0]).toMatchObject({ status: "manual", usable: true });
    await storage.updateMemory(rec.id, current => ({ ...current.memory!, error: "Generation failed" }));
    expect((await memory.list())[0]).toMatchObject({ status: "failed", usable: false });
    await storage.updateMemory(rec.id, current => ({ ...current.memory!, error: undefined, text: " " }));
    expect((await memory.list())[0].usable).toBe(false);
  });

  it("isolates workspace retrieval and removes excluded/deleted sources from snapshots", async () => {
    const rec = await chat(); await memory.edit(rec.id, "Parser decisions");
    await memory.setEnabled(rec.id, true);
    const candidates = await storage.records();
    const snapshots = rankMemories("parser", candidates, "new-chat");
    expect(await activeSnapshots(storage, snapshots)).toHaveLength(1);
    const other = new ChatStorage(path.join(dir, "other"), path.join(dir, "chats"));
    expect(await other.records()).toEqual([]);
    expect(await activeSnapshots(other, snapshots)).toEqual([]);
    await memory.setEnabled(rec.id, false);
    expect(await activeSnapshots(storage, snapshots)).toEqual([]);
    await memory.setEnabled(rec.id, true);
    await storage.delete(rec.id);
    expect(await activeSnapshots(storage, snapshots)).toEqual([]);
  });
  it("forks without inheriting a summary or imported memory selection", async () => {
    const rec = await chat(); await memory.edit(rec.id, "Parser decisions");
    await memory.setEnabled(rec.id, true);
    const loaded = (await storage.load(rec.id))!;
    loaded.memorySelection = rankMemories("parser", [loaded], "other");
    const fork = await storage.fork(loaded);
    expect(fork.memory).toBeUndefined(); expect(fork.memorySelection).toBeUndefined();
  });
});
