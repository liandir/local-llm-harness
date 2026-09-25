import { spawn } from "node:child_process";
import { startManagedProcess, startProcess, processEnvironment, type CommandProgress, type CommandResult, type CommandHandle } from "../features/commands/shared/process.js";
export { startProcess, type CommandProgress, type CommandResult, type CommandHandle, type CommandWaitResult } from "../features/commands/shared/process.js";

/** General shell execution, imported only by Commands and Advanced. */
export function startCommand(command: string, cwd: string, signal?: AbortSignal,
  onOutput?: (progress: CommandProgress) => void): CommandHandle {
  return startManagedProcess(() => spawn(command, [], {
    cwd, shell: true, detached: process.platform !== "win32", windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"], env: processEnvironment()
  }), signal, onOutput);
}
export async function runCommand(command: string, cwd: string, signal?: AbortSignal,
  onOutput?: (progress: CommandProgress) => void): Promise<CommandResult> {
  return startCommand(command, cwd, signal, onOutput).result;
}
export async function runProcess(program: string, args: string[], cwd: string, signal?: AbortSignal,
  onOutput?: (progress: CommandProgress) => void): Promise<CommandResult> {
  return startProcess(program, args, cwd, signal, onOutput).result;
}
