import type { FeatureContext, FeatureRuntime } from "../../../build/contracts.js";
import type { HarnessSettings } from "../../../config/settings.js";
import type { ChatToolProcess } from "../../../ui/messaging.js";
import type { CommandHandle, CommandProgress, CommandResult, CommandWaitResult } from "./process.js";
import { toolCommandText } from "../../../ui/commandDisplay.js";

export interface CommandPolicy {
  prepare(name: string, args: Record<string, unknown>, root: string, settings?: HarnessSettings): Promise<void>;
  launch(name: string, args: Record<string, unknown>, root: string, signal: AbortSignal | undefined, output: (value: CommandProgress) => void): Promise<CommandHandle>;
  autoapprove(settings: HarnessSettings): boolean;
  display?(name: string, args: Record<string, unknown>): string;
}
interface ManagedProcessJob {
  id: string;
  command: string;
  handle: CommandHandle;
  originToolId: string;
  running: boolean;
  announced: boolean;
  stoppedBy?: "model" | "user" | "cancel" | "turn";
  stdoutOffset: number;
  stderrOffset: number;
}

const INITIAL_PROCESS_WAIT_MS = 10_000;
const DEFAULT_PROCESS_WAIT_MS = 10_000;
const MAX_PROCESS_WAIT_MS = 30_000;
const MAX_ACTIVE_PROCESS_JOBS = 4;
const MAX_RETAINED_PROCESS_JOBS = 32;

export class CommandRuntime implements FeatureRuntime {
  readonly tools = ["run_command", "run_process", "wait_process", "stop_process"];
  private processJobs = new Map<string, ManagedProcessJob>();
  constructor(private context: FeatureContext, private policy: CommandPolicy) {}
  category(name: string): "command" | "process" { return name === "run_command" || name === "run_process" ? "command" : "process"; }
  needsApproval(settings: HarnessSettings): boolean { return !this.policy.autoapprove(settings); }
  async prepare(name: string, args: Record<string, unknown>, settings: HarnessSettings): Promise<ChatToolProcess> {
    if (this.category(name) === "command") {
      await this.policy.prepare(name, args, this.context.workspaceRoot, settings);
      return { processCommand: this.policy.display?.(name, args) ?? toolCommandText(name, args) };
    }
    const job = this.requireProcessJob(args);
    return { processCommand: job.command, processJobId: job.id, processRunning: job.running };
  }
  async execute(name: string, args: Record<string, unknown>, toolId: string, signal?: AbortSignal): Promise<{ result: string } & ChatToolProcess> {
    let result: string;
    let processJobId: string | undefined;
    let processRunning: boolean | undefined;
    if (name === "wait_process") {
      const job = this.requireProcessJob(args);
      const waitMs = normalizeProcessWaitMs(args.wait_ms);
      const waited = await job.handle.wait(waitMs);
      ({ result, processJobId, processRunning } = this.processWaitResult(job, waited, waitMs));
    } else if (name === "stop_process") {
      const job = this.requireProcessJob(args);
      const wasRunning = job.running;
      if (wasRunning) {
        job.stoppedBy = "model";
        await job.handle.stop();
      }
      job.running = false;
      processJobId = job.id;
      processRunning = false;
      result = processJobResult(
        this.consumeProcessOutput(job),
        wasRunning ? `Process ${job.id} was stopped.` : `Process ${job.id} had already finished.`
      );

    } else {
      const handle = await this.policy.launch(name, args, this.context.workspaceRoot, signal,
        output => this.context.emit({ kind: "toolCallOutput", toolId, resultPreview: commandOutputText(output) }));
      const job = this.registerProcessJob(handle, toolId, this.policy.display?.(name, args) ?? toolCommandText(name, args));
      const waited = await handle.wait(INITIAL_PROCESS_WAIT_MS);
      return this.processWaitResult(job, waited, INITIAL_PROCESS_WAIT_MS);
    }
    return { result, processJobId, processRunning };
  }
  cancel(): void {
    for (const job of this.processJobs.values()) {
      if (!job.running) continue;
      job.stoppedBy = "cancel";
      void job.handle.stop();
    }
  }
  async action(jobId: string): Promise<void> {
    const job = this.processJobs.get(jobId);
    if (!job) {
      this.context.emit({ kind: "notice", text: `Process ${jobId} is no longer available in this chat.` });
      return;
    }
    const wasRunning = job.running;
    let stoppedResult: CommandResult | undefined;
    if (wasRunning) {
      job.stoppedBy = "user";
      stoppedResult = await job.handle.stop();
    }
    job.running = false;
    const result = processJobResult(job.handle.snapshot(), wasRunning
      ? `Process ${job.id} was stopped by the user${stoppedResult ? ` (exit ${stoppedResult.exitCode})` : ""}.`
      : `Process ${job.id} had already finished when the user requested a stop.`);
    this.context.emit({
      kind: "processJobState",
      toolId: job.originToolId,
      jobId: job.id,
      running: false,
      resultPreview: result
    });
    await this.context.appendResult("stop_process", JSON.stringify({ job_id: job.id }), result, { processCommand: job.command });
  }

  private registerProcessJob(handle: CommandHandle, originToolId: string, command: string): ManagedProcessJob {
    const active = [...this.processJobs.values()].filter(job => job.running).length;
    if (active >= MAX_ACTIVE_PROCESS_JOBS) {
      void handle.stop();
      throw new Error(`at most ${MAX_ACTIVE_PROCESS_JOBS} managed processes may run in one chat`);
    }
    if (this.processJobs.size >= MAX_RETAINED_PROCESS_JOBS) {
      const completed = [...this.processJobs.values()].find(job => !job.running);
      if (completed) this.processJobs.delete(completed.id);
    }
    const id = `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const job: ManagedProcessJob = {
      id,
      command,
      handle,
      originToolId,
      running: true,
      announced: false,
      stdoutOffset: 0,
      stderrOffset: 0
    };
    this.processJobs.set(id, job);
    void handle.result.then(
      result => {
        job.running = false;
        if (!job.announced || this.processJobs.get(job.id) !== job) return;
        const lead = job.stoppedBy === "turn"
          ? `Process ${job.id} stopped after the model response completed (exit ${result.exitCode}).`
          : job.stoppedBy
            ? `Process ${job.id} stopped (exit ${result.exitCode}).`
          : `Process ${job.id} finished (exit ${result.exitCode}).`;
        this.context.emit({
          kind: "processJobState",
          toolId: job.originToolId,
          jobId: job.id,
          running: false,
          resultPreview: processJobResult(result, lead)
        });
      },
      error => {
        job.running = false;
        if (!job.announced || this.processJobs.get(job.id) !== job) return;
        this.context.emit({
          kind: "processJobState",
          toolId: job.originToolId,
          jobId: job.id,
          running: false,
          resultPreview: `Process ${job.id} failed: ${(error as Error).message}`
        });
      }
    );
    return job;
  }

  private requireProcessJob(args: Record<string, unknown>): ManagedProcessJob {
    const id = String(args.job_id ?? "").trim();
    const job = this.processJobs.get(id);
    if (!job) throw new Error(`managed process job ${id || "<missing>"} was not found in this chat`);
    return job;
  }

  private consumeProcessOutput(job: ManagedProcessJob): CommandProgress {
    const snapshot = job.handle.snapshot();
    const output = {
      stdout: snapshot.stdout.slice(job.stdoutOffset),
      stderr: snapshot.stderr.slice(job.stderrOffset),
      truncated: snapshot.truncated
    };
    job.stdoutOffset = snapshot.stdout.length;
    job.stderrOffset = snapshot.stderr.length;
    return output;
  }

  async endTurn(): Promise<void> {
    const running = [...this.processJobs.values()].filter(job => job.running);
    await Promise.all(running.map(async job => {
      job.stoppedBy ??= "turn";
      try {
        await job.handle.stop();
      } catch {
        // The handle's result rejection updates the job and emits its failure.
      } finally {
        job.running = false;
      }
    }));
  }

  private processWaitResult(
    job: ManagedProcessJob,
    waited: CommandWaitResult,
    waitMs: number
  ): { result: string; processJobId?: string; processRunning?: boolean } {
    if (!waited.running && !job.announced) {
      job.running = false;
      this.processJobs.delete(job.id);
      return { result: commandOutputText(waited.result) };
    }
    const output = this.consumeProcessOutput(job);
    if (waited.running) {
      job.announced = true;
      return {
        result: processJobResult(
          output,
          `Process ${job.id} is still running after ${waitMs} ms. Call wait_process again to wait for more output, or stop_process when it is no longer needed.`
        ),
        processJobId: job.id,
        processRunning: true
      };
    }
    job.running = false;
    const lead = job.stoppedBy === "user"
      ? `Process ${job.id} was stopped by the user (exit ${waited.result.exitCode}).`
      : job.stoppedBy
        ? `Process ${job.id} was stopped (exit ${waited.result.exitCode}).`
        : `Process ${job.id} finished (exit ${waited.result.exitCode}).`;
    return {
      result: processJobResult(output, lead),
      processJobId: job.id,
      processRunning: false
    };
  }

}

function commandOutputText(output: CommandProgress | CommandResult): string {
  const exit = "exitCode" in output ? `exit ${output.exitCode}\n` : "";
  return `${exit}--- stdout ---\n${output.stdout}\n--- stderr ---\n${output.stderr}`
    + (output.truncated ? "\n[output truncated]" : "");
}

function processJobResult(output: CommandProgress, lead: string): string {
  const hasOutput = output.stdout.length > 0 || output.stderr.length > 0 || output.truncated;
  return `${lead}${hasOutput ? `\n${commandOutputText(output)}` : "\n(no new output)"}`;
}

function normalizeProcessWaitMs(value: unknown): number {
  if (value === undefined) return DEFAULT_PROCESS_WAIT_MS;
  const number = Number(value);
  if (!Number.isFinite(number)) return DEFAULT_PROCESS_WAIT_MS;
  return Math.min(MAX_PROCESS_WAIT_MS, Math.max(0, Math.round(number)));
}

export function normalizeProcessArgs(args: Record<string, unknown>): { program: string; args: string[] } {
  const program = args.program;
  const argv = args.args;
  if (typeof program !== "string" || !/^[A-Za-z0-9_./+-]+$/.test(program)) {
    throw new Error("run_process.program must be a non-empty executable name without whitespace.");
  }
  if (!Array.isArray(argv) || argv.some(value => typeof value !== "string" || /[\0\r\n]/.test(value))) {
    throw new Error("run_process.args must be an array of strings without control characters.");
  }
  return { program, args: argv as string[] };
}
