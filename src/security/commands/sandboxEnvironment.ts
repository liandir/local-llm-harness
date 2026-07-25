/**
 * The complete environment inherited by sandboxed child commands. Keep this
 * synchronized with sandbox/supervisor.mjs; the contract test compares them.
 * In particular, no host proxy, credential, editor, helper, or Node variables
 * are inherited.
 */
export const SANDBOX_PROCESS_ENV = Object.freeze({
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

export const SANDBOX_ENV_ARGUMENTS = Object.freeze(
  Object.entries(SANDBOX_PROCESS_ENV)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, value]) => [`--env=${key}=${value}`])
);

