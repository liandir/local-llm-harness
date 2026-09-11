import { generateMemory } from "./memoryGeneration.js";
export { generateMemory } from "./memoryGeneration.js";
import { foregroundBusy, onForegroundChange } from "../llm/activity.js";
import { readSettings } from "../config/settings.js";
import { countTokens } from "./contextTracker.js";
import { ChatStorage, type ChatRecord } from "./storage.js";
import {
  MEMORY_SUMMARY_TOKENS, transcriptRevision, usableMemory, redactMemorySecrets,
  type ChatMemory, type MemoryListItem, type MemorySnapshot
} from "./memory.js";

export class WorkspaceMemory {
  // Explicit regeneration may update inactive memories without activating them.
  private queue = new Map<string, boolean>();
  private active?: { id: string; controller: AbortController; endpoint: string; model: string };
  private timer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private disposed = false;
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
  enqueue(id: string, regenerate = false): void {
    if (this.disposed) return;
    this.queue.set(id, regenerate || this.queue.get(id) === true);
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
    if (this.disposed || this.active || this.timer || !this.queue.size || foregroundBusy()) return;
    // Avoid competing with the next queued user message or auxiliary title.
    this.timer = setTimeout(() => { this.timer = undefined; void this.run(); }, this.idleDelayMs);
  }
  private async run(): Promise<void> {
    if (this.disposed || this.active || foregroundBusy()) return;
    const storage = this.getStorage();
    const next = this.queue.entries().next().value;
    if (!storage || !next) return;
    const [id, regenerate] = next;
    this.queue.delete(id);
    const controller = new AbortController();
    const epoch = this.epoch;
    const settings = readSettings();
    this.active = { id, controller, endpoint: settings.endpoint, model: settings.model };
    this.changed();
    let revision = "";
    try {
      const rec = await storage.load(id);
      if (!rec || rec.memory?.manual || (rec.memory?.enabled === false && !regenerate) || !rec.messages.length) return;
      revision = transcriptRevision(rec);
      if (usableMemory(rec)) return;
      const text = await generateMemory(rec, settings.endpoint, settings.model, controller.signal);
      if (epoch !== this.epoch || !settingsStillMatch(settings.endpoint, settings.model)) return;
      await storage.updateMemory(id, current => {
        if (controller.signal.aborted || current.memory?.manual || (current.memory?.enabled === false && !regenerate)
          || transcriptRevision(current) !== revision) return undefined;
        return { text, sourceRevision: revision, generatedAt: Date.now(), enabled: current.memory?.enabled ?? false, manual: false };
      });
    } catch (error) {
      if (controller.signal.aborted) {
        if (epoch === this.epoch && !this.disposed) this.queue.set(id, regenerate || this.queue.get(id) === true);
      } else if (revision) {
        await storage.updateMemory(id, current => {
          if (current.memory?.manual || transcriptRevision(current) !== revision) return undefined;
          return { ...emptyMemory(current), ...current.memory, error: "Memory generation failed. Check the local server and retry." };
        }).catch(() => undefined);
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
  return { text: "", sourceRevision: transcriptRevision(rec), generatedAt: 0, enabled: false, manual: false };
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
