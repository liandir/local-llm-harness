import { spawn } from "node:child_process";

/**
 * Run each approved command as an isolated background child process. There is
 * no persistent shell or VS Code terminal: stdout/stderr are captured for the
 * command's chat tool card, and cancellation terminates this child only.
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
  return runChild(command, [], true, cwd, signal);
}

export async function runProcess(
  program: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal
): Promise<CommandResult> {
  return runChild(program, args, false, cwd, signal);
}

async function runChild(
  program: string,
  args: string[],
  shell: boolean,
  cwd: string,
  signal?: AbortSignal
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      shell,
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
    };

    child.stdout.on("data", c => append("stdout", c));
    child.stderr.on("data", c => append("stderr", c));
    const abortChild = () => child.kill("SIGTERM");
    child.on("error", reject);
    child.on("close", code => {
      signal?.removeEventListener("abort", abortChild);
      resolve({ exitCode: code ?? -1, stdout, stderr, truncated });
    });
    if (signal) {
      if (signal.aborted) abortChild();
      else signal.addEventListener("abort", abortChild, { once: true });
    }
  });
}
