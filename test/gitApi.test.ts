import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ extension: vi.fn() }));
vi.mock("vscode", () => ({ extensions: { getExtension: mocks.extension } }));
import { gitRepositories, readGitHeadContent } from "../src/scm/gitApi.js";

beforeEach(() => { mocks.extension.mockReset(); });
describe("shared fixed Git integration", () => {
  it("reads HEAD from the deepest containing repository", async () => {
    const parent = { rootUri: { fsPath: "/workspace" }, show: vi.fn() };
    const nested = { rootUri: { fsPath: "/workspace/project" }, show: vi.fn().mockResolvedValue("original") };
    mocks.extension.mockReturnValue({ activate: async () => ({ getAPI: () => ({ repositories: [parent, nested] }) }) });
    expect(await readGitHeadContent("/workspace/project/src/file.ts")).toBe("original");
    expect(nested.show).toHaveBeenCalledWith("HEAD", "src/file.ts");
    expect(parent.show).not.toHaveBeenCalled();
  });

  it("does not fabricate empty baselines when HEAD or a file is unavailable", async () => {
    const repository = { rootUri: { fsPath: "/workspace" }, show: vi.fn().mockRejectedValue(new Error("missing HEAD")) };
    mocks.extension.mockReturnValue({ activate: async () => ({ getAPI: () => ({ repositories: [repository] }) }) });
    await expect(readGitHeadContent("/workspace/new.txt")).rejects.toThrow("missing HEAD");
    await expect(readGitHeadContent("/workspace-other/file.txt")).rejects.toThrow("unavailable");
  });

  it("reports missing Git integration without a subprocess fallback", async () => {
    expect(await gitRepositories()).toEqual([]);
    await expect(readGitHeadContent("/workspace/file.txt")).rejects.toThrow("unavailable");
    mocks.extension.mockReturnValue({ activate: async () => { throw new Error("disabled"); } });
    expect(await gitRepositories()).toEqual([]);
  });
});
