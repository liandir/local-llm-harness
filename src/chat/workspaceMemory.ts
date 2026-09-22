import { generateMemory } from "./memoryGeneration.js";
export { generateMemory } from "./memoryGeneration.js";
import { beginForeground, foregroundBusy, onForegroundChange } from "../llm/activity.js";
import { readSettings } from "../config/settings.js";
import { countTokens } from "./contextTracker.js";
import { ChatStorage, type ChatRecord } from "./storage.js";
import {
  MEMORY_SUMMARY_TOKENS, transcriptRevision, usableMemory, redactMemorySecrets,
  type ChatMemory, type MemoryCreation, type MemoryListItem, type MemorySnapshot
} from "./memory.js";

export class WorkspaceMemory {
  // Explicit regeneration may update inactive memories without activating them.
  private queue = new Map<string, { regenerate: boolean; messageTs?: number }>();
  private active?: { id: string; controller: AbortController; endpoint: string; model: string; messageTs?: number; operation?: MemoryCreation["operation"] };
  private timer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private disposed = false;
  private waitingTurns = 0;
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;
  constructor(private getStorage: () => ChatStorage | undefined, private idleDelayMs = 1000) {
    this.unsubscribe = onForegroundChange(() => {
      if (foregroundBusy()) this.active?.controller.abort();
      else this.schedule();
    });
  }
  onChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }
  private changed(): void { for (const listener of this.listeners) listener(); }
  /** Finish the in-flight summary before a chat claims the server, without starting another one. */
  async beginChatTurn(signal: AbortSignal, onWaiting: () => void): Promise<() => void> {
    this.waitingTurns++;
    try {
      signal.throwIfAborted();
      if (this.active) {
        onWaiting();
        await new Promise<void>((resolve, reject) => {
          const cleanup = () => { subscription.dispose(); signal.removeEventListener("abort", aborted); };
          const aborted = () => { cleanup(); reject(signal.reason); };
          const subscription = this.onChange(() => {
            if (!this.active) { cleanup(); resolve(); }
          });
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        });
      }
      signal.throwIfAborted();
      return beginForeground();
    } finally {
      this.waitingTurns--;
      this.schedule();
    }
  }

  async creations(id: string): Promise<MemoryCreation[]> {
    const storage = this.getStorage();
    const rec = await storage?.load(id);
    if (!rec || storage !== this.getStorage()) return [];
    const creations = rec.memoryCreations ?? [];
    const queued = this.queue.get(id);
    const active = this.active?.id === id ? this.active : undefined;
    const messageTs = active?.messageTs ?? queued?.messageTs ?? [...rec.messages].reverse().find(message => message.role === "assistant")?.ts;
    if (messageTs === undefined || rec.memory?.manual || (rec.memory?.enabled === false && !queued?.regenerate && !active)) return creations;
    const status = this.active?.id === id ? "generating" : this.queue.has(id) ? "queued" : undefined;
    const operation = active?.operation ?? (rec.memory?.text.trim() ? "update" : "create");
    return status ? [...creations.filter(item => item.messageTs !== messageTs), { messageTs, status, operation }] : creations;
  }
  enqueue(id: string, regenerate = false, messageTs?: number): void {
    if (this.disposed) return;
    const previous = this.queue.get(id);
    this.queue.set(id, { regenerate: regenerate || previous?.regenerate === true, messageTs: messageTs ?? previous?.messageTs });
    this.changed();
    this.schedule();
  }
  reset(): void {
    this.epoch++;
    this.queue.clear();
    this.active?.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.changed();
  }
  settingsChanged(): void {
    // The memory switch controls search and recall tools only. Restart generation only
    // when its model or endpoint changes.
    if (this.active && !settingsStillMatch(this.active.endpoint, this.active.model)) this.active.controller.abort();
    this.schedule();
    this.changed();
  }
  dispose(): void { this.disposed = true; this.reset(); this.unsubscribe(); this.listeners.clear(); }
  private schedule(): void {
    if (this.disposed || this.active || this.timer || !this.queue.size || foregroundBusy() || this.waitingTurns) return;
    // Avoid competing with the next queued user message or auxiliary title.
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, this.idleDelayMs);
  }
  private async run(): Promise<void> {
    if (this.disposed || this.active || foregroundBusy() || this.waitingTurns) return;
    const storage = this.getStorage();
    const next = this.queue.entries().next().value;
    if (!storage || !next) return;
    const [id, queued] = next;
    const { regenerate } = queued;
    this.queue.delete(id);
    const controller = new AbortController();
    const epoch = this.epoch;
    const settings = readSettings();
    this.active = { id, controller, endpoint: settings.endpoint, model: settings.model, messageTs: queued.messageTs };
    this.changed();
    let revision = "";
    let sourceLength = 0;
    let messageTs: number | undefined;
    try {
      const rec = await storage.load(id);
      if (!rec || rec.memory?.manual || (rec.memory?.enabled === false && !regenerate) || !rec.messages.length) return;
      this.active.operation = rec.memory?.text.trim() ? "update" : "create";
      messageTs = [...rec.messages].reverse().find(message => message.role === "assistant")?.ts;
      // A newly accepted user message can already be saved. Summarize only
      // through the completed answer, keeping the next request out of this memory.
      sourceLength = messageTs === undefined ? rec.messages.length
        : rec.messages.findIndex(message => message.role === "assistant" && message.ts === messageTs) + 1;
      const source = { ...rec, messages: rec.messages.slice(0, sourceLength) };
      revision = transcriptRevision(source);
      this.active.messageTs = messageTs;
      if (usableMemory(rec)) return;
      const text = await generateMemory(source, settings.endpoint, settings.model, controller.signal);
      if (epoch !== this.epoch || !settingsStillMatch(settings.endpoint, settings.model)) return;
      await storage.updateMemory(id, current => {
        if (controller.signal.aborted || current.memory?.manual || (current.memory?.enabled === false && !regenerate)
          || transcriptRevision({ ...current, messages: current.messages.slice(0, sourceLength) }) !== revision) return undefined;
        return { text, sourceRevision: revision, generatedAt: Date.now(), enabled: current.memory?.enabled ?? true, manual: false };
      }, messageTs);
    } catch (error) {
      if (controller.signal.aborted) {
        if (epoch === this.epoch && !this.disposed) {
          const pending = this.queue.get(id);
          this.queue.set(id, { regenerate: regenerate || pending?.regenerate === true, messageTs: pending?.messageTs ?? messageTs });
        }
      } else if (revision) {
        await storage.updateMemory(id, current => {
          if (current.memory?.manual || transcriptRevision({ ...current, messages: current.messages.slice(0, sourceLength) }) !== revision) return undefined;
          return { ...emptyMemory(current), ...current.memory, error: "Memory generation failed. Check the local server and retry." };
        }, messageTs).catch(() => undefined);
      }
    } finally {
      this.active = undefined;
      this.changed();
      this.schedule();
    }
  }
  async list(): Promise<MemoryListItem[]> {
    const storage = this.getStorage();
    const records = await storage?.records() ?? [];
    if (storage !== this.getStorage()) return [];
    return records.filter(r => r.messages.length).map(rec => ({
      sourceId: rec.id, title: rec.title, sourceRevision: rec.memory?.sourceRevision ?? transcriptRevision(rec),
      generatedAt: rec.memory?.generatedAt ?? 0, text: rec.memory?.text ?? "", enabled: rec.memory?.enabled ?? false,
      usable: usableMemory(rec),
      error: rec.memory?.error,
      status: this.active?.id === rec.id ? "generating" : this.queue.has(rec.id) ? "queued"
        : rec.memory?.error ? "failed" : rec.memory?.manual ? "manual" : usableMemory({ ...rec, memory: rec.memory && { ...rec.memory, enabled: true } })
          ? "ready" : rec.memory ? "stale" : "missing"
    }));
  }
  async summarizeExisting(): Promise<void> {
    const epoch = this.epoch;
    const records = await this.getStorage()?.records() ?? [];
    if (epoch !== this.epoch) return;
    for (const rec of records) if (rec.messages.length && !rec.memory?.manual && rec.memory?.enabled !== false) this.enqueue(rec.id);
  }
  async edit(id: string, text: string): Promise<void> {
    const storage = this.getStorage();
    if (!storage) return;
    const settings = readSettings();
    if (typeof text !== "string" || text.length > 20000) throw new Error("Memory text is too long.");
    text = redactMemorySecrets(text.trim());
    if (!text || await countTokens(settings.endpoint, text, settings.model) > MEMORY_SUMMARY_TOKENS) {
      throw new Error("Enter a non-empty memory of at most 384 tokens.");
    }
    await storage.updateMemory(id, rec => ({
      text, sourceRevision: transcriptRevision(rec), generatedAt: Date.now(), enabled: rec.memory?.enabled ?? false, manual: true
    }));
    this.changed();
  }
  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.getStorage()?.updateMemory(id, rec => ({ ...emptyMemory(rec), ...rec.memory, enabled }));
    this.changed();
  }
  async regenerate(id: string): Promise<void> {
    if (this.active?.id === id) this.active.controller.abort();
    await this.getStorage()?.updateMemory(id, rec => ({
      ...emptyMemory(rec), ...rec.memory, manual: false, error: undefined,
      // Keep the previous text inspectable until the replacement succeeds.
      sourceRevision: "0".repeat(64)
    }));
    this.enqueue(id, true);
  }
}
function emptyMemory(rec: ChatRecord): ChatMemory {
  return { text: "", sourceRevision: transcriptRevision(rec), generatedAt: 0, enabled: true, manual: false };
}
function settingsStillMatch(endpoint: string, model: string): boolean {
  const settings = readSettings();
  return settings.endpoint === endpoint && settings.model === model;
}

export async function activeSnapshots(storage: ChatStorage, snapshots: MemorySnapshot[]): Promise<MemorySnapshot[]> {
  const active = await Promise.all(snapshots.map(async snapshot => {
    const source = await storage.load(snapshot.sourceId);
    return source && usableMemory(source)
      && (source.memory!.manual || transcriptRevision(source) === snapshot.sourceRevision) ? snapshot : undefined;
  }));
  return active.filter((snapshot): snapshot is MemorySnapshot => !!snapshot);
}
