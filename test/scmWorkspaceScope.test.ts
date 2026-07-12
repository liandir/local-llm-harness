import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { requireContainedGitRoot } from "../src/scm/workspaceScope.js";

describe("SCM workspace scope", () => {
  it("accepts a repository equal to or nested inside the selected workspace", () => {
    const workspace = path.resolve("workspace");
    expect(requireContainedGitRoot(workspace, workspace)).toBe(workspace);
    expect(requireContainedGitRoot(workspace, path.join(workspace, "nested-repo")))
      .toBe(path.join(workspace, "nested-repo"));
  });

  it("rejects a parent or sibling repository root", () => {
    const parent = path.resolve("parent");
    const workspace = path.join(parent, "workspace");
    expect(() => requireContainedGitRoot(workspace, parent)).toThrow(/outside/);
    expect(() => requireContainedGitRoot(workspace, path.join(parent, "sibling"))).toThrow(/outside/);
  });
});
