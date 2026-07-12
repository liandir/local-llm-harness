/**
 * Byte-bounded LRU storage for virtual review documents.
 *
 * VS Code asks the content provider for these snapshots after a `vscode.diff`
 * command is issued. Keeping a small recent set supports that lifecycle while
 * preventing repeated review requests from retaining unbounded strings.
 */
export class ReviewDocumentStore {
  private readonly entries = new Map<string, { content: string; bytes: number }>();
  private totalBytes = 0;

  constructor(
    private readonly maxTotalBytes: number,
    private readonly maxEntryBytes: number,
    private readonly maxEntries: number
  ) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.content;
  }

  set(key: string, content: string): void {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxEntryBytes) {
      throw new Error(`Review snapshot exceeds the ${this.maxEntryBytes}-byte limit.`);
    }
    const replaced = this.entries.get(key);
    if (replaced) {
      this.totalBytes -= replaced.bytes;
      this.entries.delete(key);
    }
    while (
      this.entries.size > 0 &&
      (this.entries.size >= this.maxEntries || this.totalBytes + bytes > this.maxTotalBytes)
    ) {
      const oldest = this.entries.entries().next().value as [string, { content: string; bytes: number }];
      this.entries.delete(oldest[0]);
      this.totalBytes -= oldest[1].bytes;
    }
    this.entries.set(key, { content, bytes });
    this.totalBytes += bytes;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  /** Exposed for focused invariant tests, not for authorization decisions. */
  get size(): number {
    return this.entries.size;
  }
}
