# Security policy

## Security status

Local LLM Harness is undergoing a security-hardening release. The current
codebase does **not** yet claim complete filesystem, process, or host isolation.

Phase 4 adds an opt-in Docker-only command boundary. `run_command` is available
only when a captured application configuration names an absolute Docker CLI,
canonical local daemon endpoint, immutable audited image, and at least one
closed structured command rule, and the runtime/image/profile pass attestation.
The model selects only `{"ruleId":"..."}`; it never supplies a command line,
executable, argument, environment, or working directory. An absent, unhealthy,
changed, or misconfigured backend fails closed, with no ambient host-shell,
runtime discovery, image pull/build, or network-daemon fallback.

Phases 1 through 4 of the hardening plan are implemented. `SEC-002` (exact,
base-bound edit approval) and `SEC-003` (verified no-network command boundary)
are no longer unresolved implementation findings. This environment did not
provide a real Docker daemon, so Phase 4 evidence consists of adversarial fake-
transport lifecycle/attestation tests, local supervisor and snapshot contract
tests, transaction/UI policy tests, and dependency-boundary tests. The explicit
cross-platform, real-sandbox, extension-host, SCM, and installed-VSIX gates
`SEC-008` and `SEC-009` remain open, as do the transcript and unified-
cancellation gates. They continue to block an official security release and
any claim of complete host isolation.

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
bundle and dependencies are trusted. For commands and sandboxed Git, the local
configured Docker CLI binary, Docker daemon, its container runtime, the audited
immutable Linux image, and the packaged supervisor inside that image are also
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

- Assistant commands are selected only by exact configured rule ID. Each rule
  fixes an absolute POSIX executable, argv, optional canonical relative working
  directory, and bounded description. The model cannot append flags, introduce
  shell syntax, replace argv, change environment, or select an unconfigured
  directory. The deprecated `safeCommands` regex text is never evaluated.
- Prompt advertisement, runtime classification, preparation, approval, and
  execution share one immutable per-turn capability snapshot. `run_command` is
  omitted in plan mode and whenever Docker runtime/image/profile verification
  or settings decoding fails. There is no ambient host-shell fallback.
- Manual commands use an authentic one-shot prepared handle and a complete
  `command-v1` review artifact. Its approval digest length-binds session, turn,
  proposal, decision token, rule and revision, exact executable/argv/cwd,
  timeout and output limit, Docker executable/endpoint, backend profile and
  immutable image identities, no-network/ephemeral modes, transaction ID, and
  artifact hash. `autoapproveSandboxCommands` defaults off; enabling it skips
  only the manual decision, not rule resolution, attestation, preparation,
  limits, or sandbox execution.
- The command adapter uses an absolute Docker CLI and only a canonical local
  Unix socket or Windows named pipe. It passes the structured command and a
  guarded bounded workspace snapshot over stdin, not through Docker argv or a
  shell. It never searches `PATH`, chooses a Docker context, contacts a TCP/SSH
  daemon, pulls/builds an image, or inherits arbitrary host environment data.
- The container is created from an immutable digest/ID and re-attested before
  use. Its fixed profile requires Linux with the selected architecture, a
  non-root UID/GID, read-only root, `network=none`, no host binds/volumes,
  socket/device requests, port publication, added capabilities, custom DNS or
  inherited groups; capability drop `ALL`; `no-new-privileges`; built-in
  seccomp; private cgroup/PID namespaces; no IPC; bounded tmpfs, memory, CPU,
  PIDs and file descriptors; and no persistent Docker logs, restart, or health
  check. The fixed supervisor validates the framed snapshot/profile, invokes
  direct argv without a shell, enforces the deadline, terminates descendants,
  and returns bounded output.
- `/workspace` is a host-created, identity-checked copy in container tmpfs, not
  a host-data bind mount. Container filesystem changes are discarded. After
  execution the harness force-removes the container and independently verifies
  absence. An unprovable cleanup quarantines that Docker CLI/endpoint key in a
  process-lifetime registry, so existing and newly created ports for the same
  backend fail closed until the extension host restarts.
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
- Each assistant edit is prepared without mutation from one verified base
  snapshot. The approval UI receives a complete, bounded artifact containing
  every changed UTF-8 segment in JSON-quoted form plus base/result byte counts
  and SHA-256 hashes. For a manually approved edit, the host binds the canonical
  operation, base revision, artifact, session, turn, proposal, and random
  decision token; consumes a matching decision once; and commits only the
  retained prepared object. Auto-approved edits use the same prepare and commit
  path without creating a manual-decision binding.
  A changed target, changed path topology, competing create, foreign object,
  duplicate decision, or replay is refused instead of being re-prepared under
  the old decision.
- Existing-file edits whose prepared bytes already equal the base perform an
  exact base verification but no replacement. A missing target can be prepared
  only if its parent already exists. Editable text is limited to 8 MiB and the
  complete approval artifact to 16 MiB; exceeding either limit fails closed.
- Multi-root, virtual, and authority-bearing network-share workspaces are
  refused. Plan mode excludes write and command tools at the policy level.
- Security-relevant settings are application-scoped and read only from VS
  Code's default/global configuration. Workspace settings cannot redirect the
  model endpoint, configure the Docker capability, or enable automatic
  approval.
- Chat records are stored outside the workspace in `.local-llm-chats/` under
  the user's home directory.
- Stored chat records are size-bounded and decoded through a closed, versioned
  schema, and messages entering the extension host from either webview are
  checked against bounded, closed message unions before dispatch.
- A dependency-boundary test rejects new direct filesystem, child-process, and
  raw-network use outside approved adapters or temporary exceptions tied to an
  active security gate.
- Extension-owned staged-diff, staged-status, and HEAD-blob inspection now use
  the same verified command boundary with fixed Git argv and environment.
  External diffs, text conversion, filters, hooks, credential/prompt helpers,
  replacement objects, lazy fetch, pagers, submodule recursion, and Git network
  protocols are disabled. Unavailable or truncated sandboxed Git fails closed;
  no direct host Git process remains.

These guarantees combine application controls with a Docker process boundary
under the trusted-components assumptions above. They are not a complete host-
isolation claim.

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
- Approval correlation does not authenticate the user's physical gesture or
  defend against a compromised VS Code/webview implementation. The random
  one-shot binding prevents a parsed webview message from swapping, altering,
  duplicating, or replaying a different host proposal; it is not a cryptographic
  attestation that the user read the diff.
- Edit transactions bind the verified on-disk UTF-8 file, not an unsaved VS
  Code text-document buffer. A later save of a pre-existing dirty buffer can
  conflict with or overwrite the committed disk content; save or revert dirty
  editors before approving a change.
- The command boundary trusts the host kernel, configured Docker CLI, Docker
  daemon/runtime, and immutable image. A compromised component in that TCB,
  daemon API impersonation, runtime escape, malicious allowed binary, or
  vulnerability in the supervisor can defeat the isolation. Docker daemon
  access remains a highly privileged host capability and should be restricted
  by the operator.
- The reference image is not pulled, built, audited, or updated by the
  extension. Its base must be supplied by the operator and must contain the
  fixed supervisor prerequisites and every configured executable. A binary
  inside the image can still behave maliciously within the container, consume
  the allowed resources, and read everything copied into `/workspace`.
- Each command receives the entire accepted saved workspace; no ignore file
  filters the snapshot. Project scripts and dependencies are untrusted code even
  when selected by an innocuous-looking fixed rule such as a test command. They
  can print any copied secret to stdout/stderr; that output is retained in chat
  history and can be sent to the configured LLM endpoint. `network=none` blocks
  direct container egress, not this intentional tool-result data flow.
- PID 1 and the approved child currently share UID/GID 65532. A hostile child
  may try to address PID 1's procfs file descriptors rather than its own output
  pipes. The host Docker transport therefore terminates on the first byte above
  the combined output ceiling and lifecycle cleanup still force-removes the
  container. A real-Docker regression plus a distinct child UID or audited
  non-dumpable PID 1 remain defense-in-depth work under the open runtime gates.
- Docker supplies ordinary container runtime mounts such as proc/sys/dev and
  generated `/etc/hostname`, `/etc/hosts`, and `/etc/resolv.conf` files in
  addition to the two attested application tmpfs mounts. Those generated files
  can expose container/runtime or host resolver metadata. The guarantee is no
  host workspace/credential bind, named volume, engine socket, or device
  mount—not literally no mounts or host-derived metadata. Docker tmpfs can use
  host swap depending on host configuration, so this project does not claim
  workspace bytes can never reach disk.
- The workspace snapshot rejects detected links, hardlinks, special entries,
  cross-device traversal, unstable identities, and over-limit trees. Each file
  and directory is revalidated around its read, but the complete multi-file
  tree is not one globally atomic snapshot. Concurrent ordinary edits can
  produce a combination of individually verified versions from different
  instants or cause snapshot refusal.
- Command and sandboxed-Git snapshots contain saved on-disk files only. Unsaved
  VS Code editor buffers are excluded. Commands run against a Linux image even
  on Windows, so host-native toolchains, filesystem semantics, dependencies
  outside the workspace, and platform-specific build behavior may differ or be
  unavailable. macOS command capability currently fails closed before
  advertisement because portable Node cannot prove nested-mount containment;
  support remains part of the cross-platform release gate.
- This development environment had no usable real Docker daemon. Unit tests
  exercise the production CLI argument/profile contract through an adversarial
  fake transport and run the supervisor parser/child-control contract locally;
  they do not replace the real-Docker, cross-platform, or installed-VSIX
  evidence still required by `SEC-008` and `SEC-009`.
- The supervisor deliberately requires cgroup v2 and exact live kernel evidence
  for its seccomp, namespaces, resource limits, mounts, and network state.
  Older or differently reporting Docker/kernel combinations fail closed until
  they receive explicit real-runtime support and contract tests.
- Cancellation is best effort in some preflight, compaction, filesystem, and
  process stages; Stop is not yet a proven transitive kill boundary.
- Approval transactions are live, in-memory authority and are never restored
  from chat history. Reloading the chat view cancels a pending decision. Durable
  causal persistence of tool calls, decisions, and results, transcript ordering,
  and failed-compaction rollback are still being hardened in later phases.
- Extension-to-webview payloads and webview reducer state are not yet runtime
  decoded. Direct child-process access is confined to the Docker CLI transport,
  and there are no temporary capability-policy exceptions.
- Chats are stored as ordinary local files, not encrypted. Workspace excerpts,
  prompts, and tool output may be present in them.
- An HTTP endpoint on the LAN does not provide transport confidentiality. The
  endpoint operator can read all prompts and any workspace content included in
  them.

## Command execution: verified fail-closed policy

Command configuration is application-scoped and defaults empty/off. A usable
capability requires all of `localLlmHarness.sandboxDockerPath`, an optional
canonical local `sandboxDockerHost`, immutable `sandboxImage`, and at least one
valid `sandboxCommands` rule. Rule decoding is closed, bounded, atomic, and
returns frozen copies; one malformed/duplicate/oversized rule invalidates the
list. Executables must be canonical absolute regular non-link files in `/bin`,
`/usr/bin`, or `/usr/local/bin`, arguments are fixed NUL-free strings, and `cwd`
follows the guarded workspace-relative path grammar.

The trusted Docker CLI and extension-owned isolated Docker configuration
directory must both be absolute and outside the model-writable workspace. The
CLI must resolve to one bounded, unlinked executable regular file; its canonical
directory, file identity, metadata, and SHA-256 are bound at preflight and
revalidated before each host process start. The private Docker configuration
directory must remain canonical and empty.
Model-selected rules use a 30-second deadline and 2 MiB combined-output bound.
The default snapshot ceiling is 50,000 entries, 256 MiB total, 64 MiB per file,
and 128 path components; any overflow refuses the whole operation.

At the beginning of each turn, configuration alone creates no authority. The
extension starts only the configured absolute Docker CLI with a minimal host
environment, verifies the local Linux daemon, resolves the locally present
immutable image selector to its exact image ID, verifies the image contract,
and captures availability once. The prompt and runtime then use that same
snapshot. Settings or backend changes apply on a later turn; a changed image or
attestation between preparation and execution is refused.

Cleanup proof is global to the process rather than one port instance. If forced
removal followed by independent absence inspection cannot prove that a container
is gone, the Docker CLI/endpoint pair is quarantined for the remaining process
lifetime. Creating another chat, command port, or sandboxed-Git inspector cannot
bypass that state; an extension-host restart is the only automatic reset. A
matching managed container not owned by the current in-memory transaction is
never removed automatically. An operator must verify and remove it explicitly,
then restart the extension host.

The public model schema is exactly `{"ruleId":"configured-rule-id"}`. The host
resolves it to fixed argv, prepares the authentic backend handle, and—unless
the separate default-off `autoapproveSandboxCommands` setting is enabled—binds
one decision to the complete `command-v1` artifact. Prepared handles are
private, one-use, and consumed before awaiting execution. Rejection, tampering,
duplication, cancellation, or reload discards the retained handle.

Legacy `localLlmHarness.safeCommands` and
`localLlmHarness.autoapproveCommands` remain readable so old configuration is
not destroyed, but they are inert. Regex matching is not part of the security
boundary and cannot enable execution.

The positive VSIX manifest includes `sandbox/Dockerfile` and
`sandbox/supervisor.mjs` so the reference image contract is inspectable from the
shipped artifact. Their presence does not grant runtime authority: the
extension still never builds or pulls an image, and accepts only an explicitly
configured locally present immutable selector whose labels bind the expected
supervisor SHA-256.

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

- `run_command` is unavailable by default and can become active only through a
  verified structured sandbox capability with no host-shell fallback.
- Reads, writes, and sandbox commands all default to manual approval.
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
- Commands run only in a disposable, non-root sandbox with no network, ambient
  host secrets, engine socket, ambient host filesystem, inherited credentials,
  or surviving child process. Absence or failure of that sandbox is fail-closed.
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
