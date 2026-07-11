import { disabledToolReason } from "./forbiddenTools.js";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/**
 * Fail-closed compatibility entry point.
 *
 * Host command execution was intentionally removed. Keep this export only so
 * stale callers cannot accidentally regain ambient-shell execution while the
 * isolated sandbox backend is being designed.
 */
export function runCommand(
  _command: string,
  _cwd: string,
  _signal?: AbortSignal
): Promise<CommandResult> {
  const reason = disabledToolReason("run_command") ?? "Command execution is disabled.";
  return Promise.reject(new Error(reason));
}
