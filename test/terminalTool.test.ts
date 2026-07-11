import { describe, expect, it } from "vitest";
import { runCommand } from "../src/tools/terminalTool.js";

describe("terminal tool containment", () => {
  it("fails closed even when called directly", async () => {
    await expect(runCommand("echo must-not-run", process.cwd())).rejects.toThrow(
      "no verified sandbox backend is available"
    );
  });
});
