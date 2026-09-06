import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyWorkspacePath } from "../src/ui/chatView/workspacePathTypes.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe("classifyWorkspacePath", () => {
  it("distinguishes files, directories, and missing paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-path-types-"));
    tempRoots.push(root);
    await fs.mkdir(path.join(root, "src"));
    await fs.writeFile(path.join(root, "src", "app.ts"), "export {};\n");

    await expect(classifyWorkspacePath(root, "src/app.ts")).resolves.toBe("file");
    await expect(classifyWorkspacePath(root, "src")).resolves.toBe("directory");
    await expect(classifyWorkspacePath(root, "missing.ts")).resolves.toBe("missing");
  });

  it("does not classify paths outside the workspace as files", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-path-types-"));
    tempRoots.push(root);

    await expect(classifyWorkspacePath(root, "../outside.ts")).resolves.toBe("missing");
  });
});
