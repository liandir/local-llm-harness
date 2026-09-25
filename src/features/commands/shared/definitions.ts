import { objectParameters, type ToolSpec } from "../../../tools/schema.js";

export function commandDefinitions(descriptions: { shell: string; process: string }): ToolSpec[] { return [
  {
    name: "run_command",
    availability: { modes: ["act", "review"], transport: "legacy" },
    description: descriptions.shell,
    parameters: objectParameters({
      command: { type: "string", description: "Exact command line." }
    }, ["command"])
  },
  {
    name: "run_process",
    availability: { modes: ["act", "review"], transport: "native" },
    description: descriptions.process,
    parameters: objectParameters({
      program: { type: "string", description: "Executable name, for example npm, git, or ls." },
      args: {
        type: "array",
        description: "Arguments passed directly to the program without shell parsing.",
        items: { type: "string" }
      }
    }, ["program", "args"])
  },
  {
    name: "wait_process",
    availability: { modes: ["act", "review"] },
    description:
      "Wait for a managed process job previously returned by run_command or run_process. Waits for at most wait_ms without consuming model tokens, then returns new output and whether the job is still running. If it is still running, call wait_process again later or stop_process when it is no longer needed.",
    parameters: objectParameters({
      job_id: { type: "string", description: "Harness job ID returned by run_command or run_process." },
      wait_ms: { type: "integer", minimum: 0, maximum: 30000, description: "Maximum time to wait, from 0 to 30000 milliseconds. Defaults to 10000." }
    }, ["job_id"])
  },
  {
    name: "stop_process",
    availability: { modes: ["act", "review"] },
    description:
      "Stop a managed process job previously returned by run_command or run_process. The harness terminates only that chat-owned process tree, escalating to a forced stop if it does not exit promptly, and returns its final output.",
    parameters: objectParameters({
      job_id: { type: "string", description: "Harness job ID returned by run_command or run_process." }
    }, ["job_id"])
  },
]; }
