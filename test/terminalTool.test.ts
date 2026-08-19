import { describe, expect, it } from "vitest";
import * as os from "node:os";
import { runProcess } from "../src/tools/terminalTool.js";

describe("background command execution", () => {
  it("captures stdout and stderr from an isolated child process", async () => {
    const program = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "echo out & echo err 1>&2"]
      : ["-c", "printf out; printf err >&2"];
    const result = await runProcess(
      program,
      args,
      os.tmpdir()
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("out");
    expect(result.stderr).toContain("err");
    expect(result.truncated).toBe(false);
  });

  it("terminates the child when the command is cancelled", async () => {
    const controller = new AbortController();
    const resultPromise = runProcess(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      os.tmpdir(),
      controller.signal
    );

    controller.abort();
    await expect(resultPromise).resolves.toMatchObject({ exitCode: -1 });
  });
});
