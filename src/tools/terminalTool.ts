import { spawn } from "node:child_process";
import { sanitizeTerminalText } from "../util/terminalText.js";

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

export type CommandProgress = Omit<CommandResult, "exitCode">;

const MAX_OUTPUT_BYTES = 64 * 1024;

export async function runCommand(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  onOutput?: (progress: CommandProgress) => void
): Promise<CommandResult> {
  return runChild(command, [], true, cwd, signal, onOutput);
}

export async function runProcess(
  program: string,
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  onOutput?: (progress: CommandProgress) => void
): Promise<CommandResult> {
  return runChild(program, args, false, cwd, signal, onOutput);
}

async function runChild(
  program: string,
  args: string[],
  shell: boolean,
  cwd: string,
  signal?: AbortSignal,
  onOutput?: (progress: CommandProgress) => void
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", TERM: "dumb" };
    delete childEnv.FORCE_COLOR;
    const child = spawn(program, args, {
      shell,
      cwd,
      // The chat output surface is plain text rather than a terminal emulator.
      // Discourage programs from producing colour/cursor control sequences;
      // output is also sanitized below because not every program honours these.
      env: childEnv
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let outputTimer: NodeJS.Timeout | undefined;
    let outputPending = false;

    const emitOutput = () => {
      if (!outputPending) return;
      outputPending = false;
      try {
        onOutput?.({
          stdout: sanitizeTerminalText(stdout),
          stderr: sanitizeTerminalText(stderr),
          truncated
        });
      } catch {
        // UI progress is best-effort and must never terminate the child.
      }
    };

    const queueOutput = () => {
      if (!onOutput) return;
      outputPending = true;
      if (outputTimer) return;
      outputTimer = setTimeout(() => {
        outputTimer = undefined;
        emitOutput();
      }, 50);
    };

    const append = (target: "stdout" | "stderr", s: string) => {
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
      queueOutput();
    };

    // Let Node's StringDecoder carry incomplete UTF-8 sequences across chunks
    // instead of turning a split multi-byte character into replacement glyphs.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", c => append("stdout", c));
    child.stderr.on("data", c => append("stderr", c));
    const abortChild = () => child.kill("SIGTERM");
    child.on("error", reject);
    child.on("close", code => {
      signal?.removeEventListener("abort", abortChild);
      if (outputTimer) clearTimeout(outputTimer);
      outputTimer = undefined;
      emitOutput();
      resolve({
        exitCode: code ?? -1,
        stdout: sanitizeTerminalText(stdout),
        stderr: sanitizeTerminalText(stderr),
        truncated
      });
    });
    if (signal) {
      if (signal.aborted) abortChild();
      else signal.addEventListener("abort", abortChild, { once: true });
    }
  });
}
