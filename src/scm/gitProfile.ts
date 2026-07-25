import { parseWorkspacePath } from "../security/workspace/pathPolicy.js";

/**
 * Git is treated as an untrusted repository interpreter even inside the
 * command sandbox. These fixed global options suppress ambient configuration,
 * optional helpers, replacement objects, lazy fetching, hooks, and pagers.
 * Individual operations add their own explicit no-ext-diff/no-textconv flags.
 */
export const SANDBOX_GIT_ENV = Object.freeze({
  PATH: "/usr/bin:/bin",
  HOME: "/tmp/home",
  XDG_CONFIG_HOME: "/tmp/xdg",
  TMPDIR: "/tmp",
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_ATTR_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
  GIT_NO_LAZY_FETCH: "1",
  GIT_LITERAL_PATHSPECS: "1",
  GIT_CEILING_DIRECTORIES: "/workspace",
  GIT_EDITOR: "/bin/false",
  GIT_SEQUENCE_EDITOR: "/bin/false",
  GIT_SSH_COMMAND: "/bin/false",
  GIT_PROXY_COMMAND: "/bin/false",
  NO_COLOR: "1"
} as const);

const COMMON_ARGS = Object.freeze([
  "--no-pager",
  "--no-optional-locks",
  "--no-replace-objects",
  "--no-lazy-fetch",
  "--literal-pathspecs",
  "-c", "safe.directory=/workspace",
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.attributesFile=/dev/null",
  "-c", "credential.helper=",
  "-c", "credential.interactive=false",
  "-c", "protocol.allow=never",
  "-c", "protocol.file.allow=never",
  "-c", "submodule.recurse=false",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "color.ui=false",
  "-C", "/workspace"
] as const);

export function gitRepositoryRootArgs(): readonly string[] {
  return commandArgs("rev-parse", "--path-format=absolute", "--show-toplevel");
}

export function gitStagedStatusArgs(): readonly string[] {
  return commandArgs(
    "diff",
    "--cached",
    "--quiet",
    "--exit-code",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--ignore-submodules=all",
    "--"
  );
}

export function gitStagedPatchArgs(): readonly string[] {
  return commandArgs(
    "diff",
    "--cached",
    "--patch",
    "--unified=3",
    "--inter-hunk-context=0",
    "--no-indent-heuristic",
    "--diff-algorithm=myers",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-renames",
    "--ignore-submodules=all",
    "--"
  );
}

export function gitHeadTreeArgs(requestedPath: string): readonly string[] {
  const path = canonicalFilePath(requestedPath);
  return commandArgs("ls-tree", "-z", "--full-tree", "HEAD", "--", path);
}

export function gitBlobSizeArgs(oid: string): readonly string[] {
  return commandArgs("cat-file", "-s", checkedObjectId(oid));
}

export function gitBlobContentArgs(oid: string): readonly string[] {
  return commandArgs("cat-file", "blob", checkedObjectId(oid));
}

export function parseHeadBlobEntry(output: string, requestedPath: string): string | undefined {
  const path = canonicalFilePath(requestedPath);
  if (output === "") return undefined;
  const match = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/.exec(output);
  if (!match || match[3] !== path) {
    throw new Error("Git returned an unexpected or non-regular HEAD tree entry.");
  }
  return match[2];
}

function commandArgs(...operation: string[]): readonly string[] {
  return Object.freeze([...COMMON_ARGS, ...operation]);
}

function canonicalFilePath(requestedPath: string): string {
  const parsed = parseWorkspacePath(requestedPath, false);
  return parsed.displayPath;
}

function checkedObjectId(oid: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) {
    throw new Error("Git returned an invalid object identifier.");
  }
  return oid;
}
