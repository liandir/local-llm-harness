import { describe, expect, it } from "vitest";
import {
  ACTIVE_TOOL_SPECS,
  ALLOWED_TOOL_NAMES,
  DISABLED_TOOL_NAMES,
  findActiveTool,
  isWriteToolName,
  TOOL_CATALOG,
  WRITE_TOOL_NAMES,
  toolsForMode
} from "../src/tools/catalog.js";

describe("tool catalog", () => {
  it("derives advertised and runtime-active names from the same entries", () => {
    const activeNames = TOOL_CATALOG
      .filter(tool => tool.availability === "active")
      .map(tool => tool.name);

    expect(ACTIVE_TOOL_SPECS.map(tool => tool.name)).toEqual(activeNames);
    expect([...ALLOWED_TOOL_NAMES]).toEqual(activeNames);
    expect(DISABLED_TOOL_NAMES.has("run_command")).toBe(true);
    expect(activeNames).not.toContain("run_command");
  });

  it("advertises only catalog-approved plan-mode tools", () => {
    expect(toolsForMode(true).map(tool => tool.name)).toEqual([
      "read_file",
      "list_dir",
      "glob",
      "ask_user_question"
    ]);
    expect(toolsForMode(false)).toBe(ACTIVE_TOOL_SPECS);
  });

  it("keeps write classification and approval policy aligned", () => {
    const catalogWriteNames = TOOL_CATALOG
      .filter(tool => tool.availability === "active" && tool.category === "write")
      .map(tool => tool.name);
    expect([...WRITE_TOOL_NAMES]).toEqual(catalogWriteNames);

    for (const name of WRITE_TOOL_NAMES) {
      const entry = TOOL_CATALOG.find(tool => tool.name === name);
      expect(entry?.category).toBe("write");
      expect(entry?.availableInPlanMode).toBe(false);
      expect(entry?.approvalPolicy).toEqual({
        kind: "configurable",
        setting: "autoapproveWrites",
        defaultApproved: false
      });
    }
  });

  it("provides runtime lookup and narrowing from the canonical entries", () => {
    expect(findActiveTool("read_file")?.category).toBe("read");
    expect(findActiveTool("run_command")).toBeUndefined();
    expect(isWriteToolName("replace_range")).toBe(true);
    expect(isWriteToolName("read_file")).toBe(false);
  });
});
