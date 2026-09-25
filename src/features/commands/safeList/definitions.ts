import { commandDefinitions } from "../shared/definitions.js";
const description = "Execute one program with literal arguments matching a configured safe-list regex. Workspace path restrictions apply. Shell operators, substitutions, and redirects are unsupported. A nonmatching command returns an error. Long-running commands return a job_id for wait_process and stop_process.";
export const featureTools = commandDefinitions({ shell: description, process: description });
