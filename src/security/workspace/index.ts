export {
  GuardedWorkspace,
  type GuardedWorkspaceWriteResult
} from "./workspaceAdapter.js";
export {
  WorkspaceSecurityError,
  type WorkspaceSecurityErrorCode
} from "./errors.js";
export type {
  GuardedPathResolution,
  GuardedPathType,
  ResolvePathOptions
} from "./boundary.js";
export { parseWorkspacePath } from "./pathPolicy.js";
export type { ParsedWorkspacePath } from "./pathPolicy.js";
