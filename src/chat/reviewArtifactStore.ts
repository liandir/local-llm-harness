export interface StoredReviewArtifact {
  readonly text: string;
  readonly format: "exact-v1";
}

interface Entry extends StoredReviewArtifact {
  readonly bytes: number;
}

/** Small LRU for post-execution review requests; never retains base/result text. */
export class ReviewArtifactStore {
  private readonly entries = new Map<string, Entry>();
  private totalBytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxEntries: number
  ) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxBytes must be positive");
    if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error("maxEntries must be positive");
  }

  set(id: string, artifact: StoredReviewArtifact): void {
    const bytes = Buffer.byteLength(artifact.text, "utf8");
    const existing = this.entries.get(id);
    if (existing) {
      this.totalBytes -= existing.bytes;
      this.entries.delete(id);
    }
    if (bytes > this.maxBytes) return;
    this.entries.set(id, { ...artifact, bytes });
    this.totalBytes += bytes;
    this.evict();
  }

  get(id: string): StoredReviewArtifact | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return { text: entry.text, format: entry.format };
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || this.totalBytes > this.maxBytes) {
      const oldestId = this.entries.keys().next().value as string | undefined;
      if (oldestId === undefined) return;
      const oldest = this.entries.get(oldestId)!;
      this.entries.delete(oldestId);
      this.totalBytes -= oldest.bytes;
    }
  }
}
