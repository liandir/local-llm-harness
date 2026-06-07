import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { glob } from "../src/tools/fsTools.js";

let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "llh-fs-"));
});

afterEach(async () => {
  await fs.rm(ws, { recursive: true, force: true });
});

describe("glob", () => {
  it("defaults malformed, zero, and negative maxResults to the standard cap", async () => {
    await writeFiles(3);

    await expect(glob({ workspaceRoot: ws }, { pattern: "*.txt", maxResults: "bad" as unknown as number }))
      .resolves.toHaveLength(3);
    await expect(glob({ workspaceRoot: ws }, { pattern: "*.txt", maxResults: 0 }))
      .resolves.toHaveLength(3);
    await expect(glob({ workspaceRoot: ws }, { pattern: "*.txt", maxResults: -1 }))
      .resolves.toHaveLength(3);
  });

  it("floors fractional maxResults and honors valid values", async () => {
    await writeFiles(5);

    await expect(glob({ workspaceRoot: ws }, { pattern: "*.txt", maxResults: 2.8 }))
      .resolves.toHaveLength(2);
    await expect(glob({ workspaceRoot: ws }, { pattern: "*.txt", maxResults: 4 }))
      .resolves.toHaveLength(4);
  });

  it("clamps huge maxResults to the hard cap", async () => {
    await writeFiles(1005);

    await expect(glob({ workspaceRoot: ws }, { pattern: "*.txt", maxResults: 5000 }))
      .resolves.toHaveLength(1000);
  });
});

async function writeFiles(count: number): Promise<void> {
  await Promise.all(Array.from({ length: count }, (_, i) =>
    fs.writeFile(path.join(ws, `${String(i).padStart(4, "0")}.txt`), "x", "utf8")
  ));
}
