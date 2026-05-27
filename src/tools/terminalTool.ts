import * as vscode from "vscode";
import { spawn } from "node:child_process";

const TERMINAL_NAME = "Local LLM Harness";

let terminal: vscode.Terminal | undefined;

function getTerminal(cwd: string): vscode.Terminal {
  if (!terminal || terminal.exitStatus !== undefined) {
    terminal = vscode.window.createTerminal({ name: TERMINAL_NAME, cwd });
  }
  return terminal;
}

/**
 * Display the command in the user-visible terminal and run it via a child
 * process so we can stream stdout/stderr back into the chat. We do NOT use
 * `terminal.sendText` for execution because we cannot capture its output
 * portably; we send a comment line for transparency and execute in parallel.
 */
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

const MAX_OUTPUT_BYTES = 64 * 1024;

export async function runCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal
): Promise<CommandResult> {
  const term = getTerminal(cwd);
  term.show(true);
  term.sendText(`# [harness] $ ${command}`, true);

  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd,
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;

    const append = (target: "stdout" | "stderr", chunk: Buffer) => {
      const s = chunk.toString("utf-8");
      const current = target === "stdout" ? stdout : stderr;
      if (current.length + s.length > MAX_OUTPUT_BYTES) {
        const room = Math.max(0, MAX_OUTPUT_BYTES - current.length);
        const slice = s.slice(0, room);
        if (target === "stdout") stdout += slice;
        else stderr += slice;
        truncated = true;
      } else {
        if (target === "stdout") stdout += s;
        else stderr += s;
      }
      term.sendText(s.replace(/\n$/, ""), false);
    };

    child.stdout.on("data", c => append("stdout", c));
    child.stderr.on("data", c => append("stderr", c));
    child.on("error", reject);
    child.on("close", code => {
      term.sendText("", true);
      resolve({ exitCode: code ?? -1, stdout, stderr, truncated });
    });
    if (signal) {
      signal.addEventListener("abort", () => child.kill("SIGTERM"));
    }
  });
}
