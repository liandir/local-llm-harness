import { describe, expect, it } from "vitest";
import * as os from "node:os";
import { runProcess } from "../src/tools/terminalTool.js";
import { sanitizeTerminalText } from "../src/util/terminalText.js";

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

  it("reports captured output before resolving the final result", async () => {
    const progress: Array<{ stdout: string; stderr: string; truncated: boolean }> = [];
    let resolveFirstProgress = (): void => undefined;
    const firstProgress = new Promise<void>(resolve => { resolveFirstProgress = resolve; });
    let settled = false;
    const program = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "echo first & ping -n 2 127.0.0.1 >nul & echo second 1>&2"]
      : ["-c", "printf first; sleep 0.2; printf second >&2"];
    const resultPromise = runProcess(
      program,
      args,
      os.tmpdir(),
      undefined,
      output => {
        progress.push(output);
        resolveFirstProgress();
      }
    );
    void resultPromise.then(() => { settled = true; });

    await firstProgress;
    expect(progress[0].stdout).toContain("first");
    expect(settled).toBe(false);

    const result = await resultPromise;
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toEqual({
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated
    });
  });

  it("turns terminal formatting into clean UTF-8 plain text", () => {
    expect(sanitizeTerminalText("\u001b[31mred ✓\u001b[0m")).toBe("red ✓");
    expect(sanitizeTerminalText("\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007")).toBe("link");
    expect(sanitizeTerminalText("waiting\u001b[")).toBe("waiting");
    expect(sanitizeTerminalText("one\u0000two\tthree\nfour")).toBe("onetwo\tthree\nfour");
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
