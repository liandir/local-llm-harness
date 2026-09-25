import { commandDefinitions } from "../shared/definitions.js";
export const featureTools = commandDefinitions({
  shell: "Run a shell command as a managed process in the workspace. Short commands return normally; one still running after a bounded initial wait returns a job_id. Use wait_process to observe output or stop_process to terminate it. Call the tool directly when useful.",
  process: "Run a program and argument vector as a managed process in the workspace. No shell interprets the arguments. Short processes return normally; one still running after a bounded initial wait returns a job_id. Use wait_process to observe output or stop_process to terminate it. Call the tool directly when useful."
});
