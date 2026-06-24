import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadRootAgentsMd, MAX_AGENTS_MD_BYTES } from "../src/llm/agentsMd.js";

let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-agents-"));
});

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe("loadRootAgentsMd", () => {
  it("returns undefined when no AGENTS.md exists", async () => {
    await expect(loadRootAgentsMd(ws)).resolves.toBeUndefined();
  });

  it("returns undefined for an empty / whitespace-only file", async () => {
    await fs.writeFile(path.join(ws, "AGENTS.md"), "   \n\t\n");
    await expect(loadRootAgentsMd(ws)).resolves.toBeUndefined();
  });

  it("returns the trimmed contents of a populated file", async () => {
    await fs.writeFile(path.join(ws, "AGENTS.md"), "\n# Rules\nUse tabs.\n\n");
    await expect(loadRootAgentsMd(ws)).resolves.toBe("# Rules\nUse tabs.");
  });

  it("ignores a directory named AGENTS.md", async () => {
    await fs.mkdir(path.join(ws, "AGENTS.md"));
    await expect(loadRootAgentsMd(ws)).resolves.toBeUndefined();
  });

  it("truncates oversized files and appends a marker", async () => {
    const big = "x".repeat(MAX_AGENTS_MD_BYTES + 5000);
    await fs.writeFile(path.join(ws, "AGENTS.md"), big);
    const result = await loadRootAgentsMd(ws);
    expect(result).toBeDefined();
    expect(result!.endsWith("[AGENTS.md truncated]")).toBe(true);
    const markerBytes = Buffer.byteLength("\n…[AGENTS.md truncated]", "utf-8");
    expect(Buffer.byteLength(result!, "utf-8")).toBeLessThanOrEqual(MAX_AGENTS_MD_BYTES + markerBytes);
  });

  it("picks up edits after the file changes (mtime cache invalidation)", async () => {
    const file = path.join(ws, "AGENTS.md");
    await fs.writeFile(file, "first");
    await expect(loadRootAgentsMd(ws)).resolves.toBe("first");
    // Bump mtime explicitly so the change is observable even on coarse clocks.
    await fs.writeFile(file, "second");
    const later = new Date(Date.now() + 1000);
    await fs.utimes(file, later, later);
    await expect(loadRootAgentsMd(ws)).resolves.toBe("second");
  });
});
