# Security policy

## Security status

Local LLM Harness is undergoing a security-hardening release. The current
codebase does **not** yet provide a complete filesystem or process sandbox, and
the project does not currently claim hard isolation from the host.

Assistant-initiated command execution (`run_command`) is disabled while an
isolated command runner is being developed. It fails closed: a safe-command
pattern or auto-approval setting cannot enable it, and there is no fallback to
the host shell. The command settings remain present only for configuration
compatibility and future migration.

Do not use an older release that permits host-shell commands with an untrusted
model, endpoint, repository, or `AGENTS.md`. Until the release criteria below
are met, use the extension only with workspaces and local/LAN endpoints you
trust, review every proposed operation, and keep all auto-approval settings off.

## Threat model

The security objective is to let a coding model inspect and propose changes to
one explicitly selected workspace without granting it ambient access to the
rest of the host.

### Protected assets

- Files and directories outside the selected workspace.
- Host credentials, environment variables, agents, sockets, and other secrets.
- Network destinations other than the user-configured local/LAN LLM endpoint.
- The integrity of workspace changes: approval must eventually authorize the
  exact bytes shown to the user, once, against the reviewed file version.
- Chat records and other extension data that are not intentionally supplied to
  the model.

### Untrusted inputs

The following must be treated as potentially malicious:

- Model output and the configured LLM endpoint.
- Workspace contents, filenames, links, repository metadata, and `AGENTS.md`.
- Tool names, arguments, command text, command output, and generated diffs.
- Stored chat records and messages crossing the webview boundary.
- Code that the user approves for execution; approval is consent, not proof
  that code is safe.

### Trusted computing base

The operating system and kernel, VS Code extension host, installed extension
bundle and dependencies, and (once implemented) selected sandbox runtime are
trusted. The configured endpoint is an allowed recipient of prompts, but its
responses are still untrusted input.

The threat model does not defend against a compromised operating system,
kernel or VS Code installation, a malicious extension with equivalent host
permissions, compromise of the distributed extension bundle, a sandbox-runtime
escape, or a local administrator. Those components can bypass controls inside
this extension.

Portable Node also does not expose cross-platform directory-handle-relative
filesystem operations. A separate process running with the same OS-user
permissions that concurrently replaces workspace path components or changes
mount topology is outside the guarded workspace capability's proven boundary.
The same applies to a pre-existing bind mount or reparse/mount form that Node's
portable metadata APIs cannot identify. Supporting those adversaries requires
platform-native handle-relative primitives or an OS sandbox. Model-controlled
paths and detected static links/hardlinks remain in scope.

## Current guarantees

Subject to the limitations below, the current hardening baseline provides:

- Assistant `run_command` requests are refused. No assistant command is run in
  an ambient host shell, even when it matches `safeCommands`.
- Read and write auto-approval defaults are off. File operations require an
  explicit decision unless a user deliberately changes an auto-approval
  setting.
- The endpoint validator accepts exact `localhost` or supported private IP
  literals and rejects ordinary public/DNS destinations. Extension model
  requests are directed to that configured endpoint.
- The assistant has no general-purpose HTTP, browser, or package-install tool.
- Assistant file tools, root `AGENTS.md`, file review/opening, and guarded
  legacy-chat migration use the common workspace capability. It binds one
  local workspace root identity; enforces canonical relative paths; rejects
  detected symlinks, junctions, redirected reparse paths, and regular-file
  hardlinks; requires usable file IDs; bounds UTF-8 reads and enumeration;
  revalidates file identity; and writes through synced same-directory temporary
  files with atomic replacement or no-clobber publication.
- Multi-root, virtual, and authority-bearing network-share workspaces are
  refused. Plan mode excludes write and command tools at the policy level.
- Security-relevant settings are application-scoped and read only from VS
  Code's default/global configuration. Workspace settings cannot redirect the
  model endpoint or enable automatic approval.
- Chat records are stored outside the workspace in `.local-llm-chats/` under
  the user's home directory.
- Stored chat records are size-bounded and decoded through a closed, versioned
  schema, and messages entering the extension host from either webview are
  checked against bounded, closed message unions before dispatch.
- A dependency-boundary test rejects new direct filesystem, child-process, and
  raw-network use outside approved adapters or temporary exceptions tied to an
  active security gate.

These are application-level controls, not an OS security boundary.

## Known limitations

Until the hard-isolation release gate is complete, do not treat these
application controls as containment of hostile local processes:

- Filesystem checks and revalidation are point-in-time. Portable Node exposes
  neither POSIX `openat`/`openat2` and `renameat` nor equivalent Windows
  handle-relative/reparse APIs. Containment is therefore not proven against the
  explicitly out-of-scope same-user concurrent replacement or opaque
  mount-topology adversary described above. Detected static links, hardlinks,
  cross-device mounts, and supported platform-sensitive path forms are covered
  by the guarded boundary and regression tests.
- Atomic replacement preserves ordinary POSIX permission bits but does not
  promise to preserve every platform ACL, extended attribute, ownership flag,
  or alternate stream. Files requiring such metadata should not be edited by
  the harness yet.
- File-edit approval is not yet transactionally bound to an immutable,
  complete pre-approval diff. Review cards must not be treated as proof that
  the exact displayed bytes are what will be written.
- Extension-owned Git inspection for commit-message generation is separate
  from assistant `run_command` and is not yet executed in the future isolated
  runner.
- Cancellation is best effort in some preflight, compaction, filesystem, and
  process stages; Stop is not yet a proven transitive kill boundary.
- Transcript ordering and failed-compaction rollback are still being hardened.
- Extension-to-webview payloads and webview reducer state are not yet runtime
  decoded. The remaining capability-policy exception is extension-owned Git
  child-process execution, tracked for the sandbox phase; there are no
  temporary raw-workspace-filesystem exceptions.
- Chats are stored as ordinary local files, not encrypted. Workspace excerpts,
  prompts, and tool output may be present in them.
- An HTTP endpoint on the LAN does not provide transport confidentiality. The
  endpoint operator can read all prompts and any workspace content included in
  them.

## Command execution: fail-closed policy

`localLlmHarness.safeCommands` and
`localLlmHarness.autoapproveCommands` are currently inert. They do not grant
permission to execute commands. Every assistant `run_command` request must
return a refusal explaining that secure command execution is unavailable.

Command execution may be re-enabled only through a verified sandbox backend
with no silent host-shell fallback. If that backend is absent, unhealthy, or
misconfigured, command execution must remain unavailable. Extension-owned
operations such as Git inspection must be documented separately and migrated
to the same isolation boundary before hard isolation is claimed.

## Reporting a vulnerability

**Security contact: pending publication.** Before the next public security
release, the maintainers must replace this placeholder with a monitored private
contact and response expectations.

Until then:

1. Prefer the repository's private GitHub security-advisory reporting feature,
   if it is enabled.
2. Otherwise, contact the repository owner through an available private
   channel.
3. If no private channel is available, open a minimal public issue asking for a
   security contact. Do not include exploit details, secrets, or affected user
   data in that issue.

Include the affected version/commit, operating system, VS Code version, impact,
reproduction prerequisites, and a minimal proof of concept. Please allow the
maintainers time to reproduce and coordinate a fix before public disclosure.
Never include real credentials or private workspace content in a report.

## Release criteria

Automatic publication is blocked by `security-gates.json`. A blocking entry
may be removed only in the same change that adds the corresponding passing
regression evidence. `scripts/security-release-gate.mjs` blocks publication
while unresolved entries remain; code review and CI are responsible for
checking the accompanying evidence.

### Interim hardening artifacts

Local builds and CI artifacts may be produced without a hard-isolation claim
only when:

- `run_command` is demonstrably disabled and cannot be restored by settings.
- Reads, writes, and commands all default to manual approval.
- The packaged VSIX is built from an explicit or verified file list and
  contains no local settings, secrets, logs, source maps, or unrelated files.
- Security regression tests cover the known findings and are not silently
  skipped on a supported platform.
- README claims and setting defaults match the shipped artifact.

The official automated release workflow remains blocked while any entry in
`security-gates.json` is unresolved.

### Hard-isolation claim

The README may claim complete workspace/process isolation only after all of the
following are implemented and enforced in release CI:

- One guarded workspace-filesystem capability covers every model-influenced
  read and write, including `AGENTS.md`, file review/opening, and
  workspace-scoped Git discovery. Static path/link/hardlink cases have
  adversarial Windows, Linux, and macOS coverage. Any claim covering concurrent
  same-user path replacement or mount manipulation additionally requires an
  OS-backed handle-relative implementation; portable revalidation is not
  sufficient.
- Every edit is prepared in memory, shown as a complete immutable diff, bound
  to the reviewed base version, committed atomically, and protected from stale,
  duplicate, tampered, or late approvals.
- Commands run only in a disposable, non-root sandbox with no network, secrets,
  engine socket, ambient host filesystem, inherited credentials, or surviving
  child process. Absence or failure of that sandbox is fail-closed.
- Endpoint parsing, redirects, deadlines, and allowed-address checks have
  adversarial integration coverage.
- One cancellation scope reaches network requests, filesystem work,
  compaction, approval waits, storage, and the entire sandbox lifecycle; late
  writes and events are suppressed.
- Transcript chronology is validated, and compaction is transactional with
  fault-injection tests proving rollback.
- Webview messages and stored records are runtime validated, and dependency
  rules prevent bypassing the security adapters.
- Extension Host, webview, SCM, installed-VSIX, and real sandbox contract tests
  pass on every supported operating system.
- Every security statement in user documentation maps to an automated test or
  an explicit limitation in this file.

Passing ordinary unit tests, obtaining user approval, or matching a command
allow-list is not by itself sufficient evidence of isolation.
