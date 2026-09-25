import { startCommand, startProcess } from "../../../tools/terminalTool.js";
import { CommandRuntime, normalizeProcessArgs } from "../shared/runtime.js";
import type { FeatureContext, FeatureRuntime } from "../../../build/contracts.js";

export function createFeatures(context: FeatureContext): FeatureRuntime[] {
  return [new CommandRuntime(context, {
    async prepare(name, args) {
      if (name === "run_process") normalizeProcessArgs(args);
      else if (typeof args.command !== "string" || !args.command.trim()) throw new Error("command must be a non-empty string.");
    },
    async launch(name, args, root, signal, output) {
      if (name === "run_command") return startCommand(String(args.command), root, signal, output);
      const prepared = normalizeProcessArgs(args);
      return startProcess(prepared.program, prepared.args, root, signal, output);
    },
    autoapprove: settings => settings.autoapproveCommands === true
  })];
}
