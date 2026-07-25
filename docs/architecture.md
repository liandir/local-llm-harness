# Architecture

This guide describes the Phase 1 through Phase 4 module boundaries. Phase 1
introduced contracts and enforceable seams, Phase 2 routes workspace access
through one guarded capability, Phase 3 binds file-edit decisions to exact
prepared transactions, and Phase 4 routes structured commands and extension-
owned Git through one attested Docker boundary. Transcript, unified-
cancellation, cross-platform, installed-VSIX, and real-sandbox release gates
remain incomplete. Current guarantees and limitations live in
[SECURITY.md](../SECURITY.md).

## Module map

| Concern | Canonical module | Responsibility |
| --- | --- | --- |
| Tool policy | `src/tools/catalog.ts` | Names, prompt schemas, availability, categories, and approval policy for active and disabled tools |
| Chat domain model | `src/chat/model.ts` | Versioned stored-record types, strict decoders, and explicit legacy migration |
| UI protocol | `src/chat/protocol.ts` | Shared structured-clone DTOs and strict parsers for messages entering the extension host |
| Approval coordinator | `src/chat/approvalCoordinator.ts` | Cryptographically random session/turn/proposal correlation and one-shot decision consumption |
| Edit transaction | `src/chat/editTransactions.ts` | Prepared workspace edits, canonical approval digests, and committed-edit descriptions |
| Exact edit diff | `src/chat/exactEditDiff.ts` | Complete, bounded, byte-faithful UTF-8 approval artifacts and hashes |
| Command transaction | `src/chat/commandTransactions.ts` | Exact `{ruleId}` decoding, fixed-rule resolution, complete `command-v1` artifacts, approval digests, and one-shot execution/discard |
| Turn tool policy | `src/chat/toolPolicySnapshot.ts` | One immutable runtime-attested command capability shared by prompt, classification, approval, and execution |
| Review artifact store | `src/chat/reviewArtifactStore.ts` | Bounded post-execution LRU retaining artifacts without duplicate base/result snapshots |
| Tool-card lifecycle | `src/ui/chatView/webview/toolLifecycle.ts` | Monotonic progress, proposal, resolution, and historical-diff transitions |
| Session contracts | `src/chat/session/ports.ts` | Cancellable interfaces for model, storage, workspace, command, settings, clock, and ID dependencies |
| Cancellation primitive | `src/security/abortScope.ts` | Parent-linked operation scopes, deadlines, derived signals, and deterministic disposal |
| Workspace path policy | `src/security/workspace/pathPolicy.ts` | Canonical cross-platform relative-path grammar and glob parsing |
| Filesystem identity and atomic I/O | `src/security/workspace/boundary.ts` | Root binding, component inspection, bounded handle reads, revalidation, and atomic publication |
| Filesystem identity helpers | `src/security/workspace/fileIdentity.ts` | Fail-closed OS file-ID and version comparison |
| Workspace port adapter | `src/security/workspace/workspaceAdapter.ts` | Tool-facing limits, immutable edit preparation, one-shot commit, line edits, and enumeration |
| Sandbox workspace snapshot | `src/security/workspace/sandboxSnapshot.ts` | Bounded, deterministic copy with path/type/link/hardlink/device and per-read identity/version verification |
| VS Code file bridge | `src/security/workspace/vscodeBridge.ts` | Guarded live-document opening for editor UI actions |
| Legacy migration | `src/security/workspace/legacyChatMigration.ts` | Fixed-scope guarded read and exact-snapshot removal of historical workspace chats |
| Structured command policy | `src/tools/sandboxCommands.ts` | Closed bounded settings decoder, immutable-image/local-endpoint validation, frozen rule snapshots, and exact ID lookup |
| Command-port factory | `src/security/sandboxCommandFactory.ts` | Application-settings-bound local Docker construction with no discovery, pull, build, or fallback |
| Docker command adapter | `src/security/commands/` | Absolute CLI transport, immutable image/supervisor/profile/container attestation, framed execution, fixed lifecycle, output limits, cleanup proof, and process-lifetime backend quarantine |
| Reference sandbox image | `sandbox/Dockerfile`, `sandbox/supervisor.mjs` | Positive-manifest VSIX assets defining the non-root image contract plus independent framed-snapshot validation, direct-argv execution, deadlines, and descendant termination |
| Sandboxed Git profile | `src/scm/gitProfile.ts` | Fixed Git argv/environment that disables helpers, hooks, filters, textconv, external diffs, prompts, credentials, and network protocols |
| Sandboxed Git inspector | `src/scm/sandboxedGit.ts` | Extension-owned staged status/diff and exact HEAD blob reads through `CommandPort` |
| Dependency policy | `security-architecture.json` | Approved raw-capability adapters and temporary exceptions tied to active security gates |
| Orchestration | `src/chat/session.ts` | Turn, prepared-approval, tool-loop, transcript, and compaction coordination |

`src/chat/session.ts` and `src/ui/chatView/webview/main.ts` remain large legacy
coordinators. Phases 3 and 4 moved edit preparation, command preparation,
turn-scoped policy, approval state, exact rendering, artifact retention, and
tool-card lifecycle rules into focused modules. Later phases can continue
splitting orchestration and presentation while regression tests preserve the
existing public behavior.

## Security-relevant flows

### Model tool call

1. A model-family parser emits a dynamic tool name and argument payload.
2. `src/chat/session.ts` classifies the name through the canonical catalog.
3. Disabled, forbidden, unknown, and plan-violating calls fail closed.
4. For commands, the catalog is parameterized by the same captured sandbox
   capability used to build the prompt. `run_command` is active only in act
   mode after runtime verification.
5. The catalog supplies the active category and configurable approval setting.
6. A write or command call is normalized, prepared, and rendered as a complete
   exact approval artifact before a manual decision is requested.
7. `ChatSession` executes an approved operation through either its cached
   `GuardedWorkspace`, which implements `WorkspacePort` and revalidates the path
   at operation time, or the retained authentic command transaction. Compatibility
   wrappers contain no raw filesystem or process access.

Prompt advertisement and runtime classification therefore derive from the same
catalog and immutable per-turn policy. Without an attested command capability,
`run_command` remains disabled compatibility metadata and is absent from active
prompt declarations.

### Structured command sandbox

1. `captureToolPolicySnapshot` decodes the captured application settings. Empty
   or invalid Docker path/image/rules stop here with an unavailable capability.
2. `createConfiguredCommandPort` supplies one absolute Docker CLI path, the
   canonical local Unix-socket or Windows-named-pipe endpoint, an isolated
   Docker CLI config directory, exact Linux host architecture, and the immutable
   image selector. It does not discover a runtime or pull/build an image.
   Capability creation currently supports Linux and Windows hosts; macOS fails
   closed before advertisement because the snapshot layer cannot yet prove
   nested-mount containment there.
3. `DockerSandboxCommandPort.create` runs bounded Docker `version` and image
   inspection through `DockerCliTransport`. It verifies daemon OS/architecture,
   resolves the selector to one image ID, and checks the exact image entrypoint,
   command, user, workdir, environment, profile and exact supervisor-SHA labels,
   and absence of declared volumes, ports, and health check.
4. The verified `CommandPort` reports an attestation. The turn snapshot checks
   it against captured configuration before exposing rule IDs/descriptions to
   the prompt. Settings changes do not mutate an active turn's authority.
5. A model call must decode as exactly `{"ruleId":"..."}`. The host looks up
   one frozen rule and derives its revision from fixed executable, argv, cwd,
   description, and public execution limits. No command string is parsed.
6. `prepareCommand` re-attests the backend and returns a frozen one-use handle
   backed by private weak-map authority. `commandTransactions.ts` verifies every
   public field and renders the full `command-v1` artifact. Manual decisions
   length-bind every executable/profile/limit field and the artifact hash to the
   approval coordinator's session/turn/proposal token.
7. `executeCommand` consumes authority before awaiting, re-attests the backend,
   and creates a guarded snapshot of saved on-disk workspace content. Snapshot
   enumeration rejects detected links, hardlinks, special files, cross-device
   traversal, identity/version changes, and fixed count/size/depth limits.
8. Docker receives only fixed lifecycle argv. The command request and framed
   file bytes travel over stdin; the host workspace, Docker socket, volumes,
   devices, credentials, and host environment are not mounted or inherited.
   Before start, container inspection must match the fixed read-only/non-root,
   `network=none`, capability, seccomp, namespace, tmpfs, resource, logging, and
   restart profile exactly.
9. The immutable supervisor independently checks its profile and every frame,
   extracts into `/workspace` tmpfs, and spawns exact argv without a shell. It
   enforces the deadline, kills descendants, and emits bounded stdout/stderr;
   the host transport independently stops the Docker client on the first byte
   above the combined output ceiling.
10. The host re-inspects the exited container, force-removes it and its volumes,
    then requires a separate absence result. If cleanup cannot be proved, the
    Docker CLI/endpoint key enters a process-lifetime quarantine. Existing and
    future ports for that backend fail closed until the extension host restarts,
    so opening another chat or SCM inspector cannot bypass cleanup failure. A
    matching managed container outside the current in-memory transaction is
    never auto-deleted; it requires verified operator cleanup and a restart.

The copy is ephemeral and command filesystem writes never flow back to the
host. It is deliberately not a persistent-edit mechanism. Docker and its
runtime-supplied proc/sys/dev mounts plus generated `/etc/hostname`,
`/etc/hosts`, and `/etc/resolv.conf` files are part of the trusted boundary;
“no host mount” here means no workspace/credential bind, named volume, engine
socket, or device mount—not no host-derived runtime metadata. See `SECURITY.md`
for tmpfs/swap, non-global-atomic snapshot, image TCB, and real-Docker evidence
limitations.

### Sandboxed Git inspection

Commit-message staged status/diff and chat review of a file's HEAD version use
`SandboxedGitInspector`, which submits extension-owned `CommandRequest` values
through the same `CommandPort`. These internal requests are not model-selected
and do not need a UI approval, but they receive the same runtime/image/profile,
snapshot, no-network, resource, and cleanup enforcement.

`gitProfile.ts` constructs fixed direct argv with `--no-ext-diff`,
`--no-textconv`, no renames or submodule traversal, a literal `--` path
delimiter, and a closed environment/config profile. HEAD content uses
`ls-tree` to accept only regular blobs, `cat-file -s` to enforce the content
limit, then `cat-file blob`; it never uses `show`, filters, helpers, or host Git.
Truncation, unexpected exit status, unavailable sandbox, or malformed metadata
is an error rather than a host fallback.

### Guarded workspace boundary

`GuardedWorkspace.create` binds one canonical local workspace root and its
filesystem identity. Multi-root, virtual, and authority-bearing network-share
workspace selection is refused by the extension entry point. Untrusted tool paths use a forward-slash relative
grammar that rejects traversal, absolute/drive/UNC/device forms, alternate data
streams, control characters, ambiguous components, and Windows device aliases
before filesystem access.

At execution time, the low-level boundary checks each existing component with
`lstat` and `realpath`, rejects detected links/junctions/redirections and
multiply linked regular files, and requires a usable OS file ID. Reads use one
opened handle, fatal UTF-8 decoding, byte limits, before/after version checks,
and handle-to-path identity verification. Listing and globbing never descend
through detected links and enforce entry, depth, visit, result-count, and
returned-byte limits.

Commits are serialized process-wide per workspace path. Preparation reads a
verified base and computes exact next text in memory without mutation. Commit
accepts only the original object retained in the adapter's private weak map and
consumes it before waiting, so foreign, altered, repeated, failed, or cancelled
transactions cannot be retried. It writes and syncs an exclusive same-directory
temporary file, revalidates the base and path topology, then atomically replaces
an existing target or publishes a missing target without clobbering a competing
create. An existing-file no-op verifies the base and returns without replacing
the target. Assistant edits refuse a missing parent directory at preparation
time rather than creating unreviewed topology. The model-facing port does not
expose delete; legacy chat migration receives only a fixed UUID record flow and
exact-snapshot removal.

These checks cover model-controlled paths and detected static malicious
link/hardlink content. Portable Node has no cross-platform
`openat`/handle-relative or mount-ID API, so a separate same-user process
concurrently replacing an ancestor—and pre-existing or changing mount/reparse
forms opaque to Node—are outside the proven application boundary. See the
public threat model in `SECURITY.md` before strengthening isolation claims.

### Prepared edit approval

1. `GuardedWorkspace.prepareEdit` captures verified content, file version, and
   every existing path-component identity. It computes the exact effective next
   text for `write_file`, `insert_text`, or `replace_range` without mutation.
2. `renderExactEditDiff` emits every changed UTF-8 segment. Segments include
   their exact `\r`, `\n`, or `\r\n` terminator and are JSON-quoted so controls,
   tabs, BOMs, bidi marks, and format characters remain visible. Unchanged spans
   may collapse; changed content never does. Preparation fails if editable text
   exceeds 8 MiB or the complete artifact exceeds 16 MiB.
3. `ApprovalCoordinator` creates the pending entry before the event is emitted.
   Its SHA-256 review digest binds canonical operation/path, private transaction
   and base revision, before/after hashes and sizes, artifact hash, session,
   turn, tool, proposal, and random decision token.
4. The host parser accepts only the closed approval-binding shape. A matching
   decision is removed before its waiter is released, making duplicate, swapped,
   cancelled, and late messages inert. Auto-approved writes omit the manual
   decision but use the same preparation and commit path.
5. `commitEdit` accepts the authentic retained object once. It refuses a stale
   base or topology and never re-prepares under an old decision. Reloading the
   webview cancels a pending proposal rather than reconstructing authority from
   persisted chat data.

This protocol correlates a webview decision with one host-owned artifact; it
does not attest that a human inspected the diff or make approval history
durable. Extension-to-webview runtime decoding and causal transcript receipts
remain later-phase work. Portable Node's same-user path-replacement limitation
also still applies during preparation and commit.

### Webview to extension host

1. A provider receives `unknown` from `onDidReceiveMessage`.
2. `parseChatToExt` or `parseSideToExt` checks the discriminant, exact fields,
   primitive types, ranges, string bounds, and identifiers.
3. Only a parsed union member reaches the provider switch.

Settings sent through the generic side-view update are explicitly whitelisted.
Endpoint and structured-command JSON changes keep dedicated validation flows;
command auto-approval and both structured and legacy command policy cannot be
forged through the generic message.
Extension-to-webview payloads are typed but are not yet runtime decoded by the
webview reducers, so they remain a documented limitation.

### Stored chat record

1. `ChatStorage` reads JSON from extension-owned storage as untrusted data.
2. `normalizeStoredChatRecord` dispatches by `schemaVersion`.
3. Version 1 records are decoded recursively with closed keys and value types.
4. Historical unversioned records use one explicit v0 migration and receive
   deterministic defaults.
5. File bytes, collection counts, and attacker-controlled strings are bounded;
   unknown versions or malformed nested messages/events are skipped.

New records are always persisted with `schemaVersion: 1` through a synced
same-directory temporary file and atomic rename. Legacy migration publishes via
a no-clobber link, so an existing global UUID is never overwritten. A legacy
source is deleted only after the host's strongest portable persistence barrier
(file plus directory sync where supported) completes; otherwise the safe
duplicate is retained. The storage module is an
approved adapter because its remaining raw access is extension-owned
persistence, not the model-controlled workspace.

## Dependency boundaries

`test/architectureBoundaries.test.ts` scans source imports and direct platform
API use. Raw filesystem, child-process, or network capabilities must be either:

- inside an adapter path approved by `security-architecture.json`; or
- a temporary legacy exception with a removal phase, rationale, and security
  gate that still exists in `security-gates.json`.

The test rejects stale exceptions after their gate is removed. This makes new
direct capability use fail CI and prevents an untracked bypass from quietly
spreading while adapters are introduced. It is a static guardrail, not a proof
of operating-system isolation.

Phase 2 removed every temporary raw-workspace-filesystem exception. Phase 4
removed the ambient `src/util/exec.ts` adapter and its Git exception. The only
approved child-process adapter is now
`src/security/commands/dockerCliTransport.ts`; it accepts fixed Docker lifecycle
argv from the security command layer, not model command argv.

Phase 3 closed `SEC-002` through prepared edit/one-shot approval, and Phase 4
closed the `SEC-003` implementation gate through the command boundary above.
Removing those findings does not change the overall blocked release status:
causal transcript, transactional compaction, unified cancellation, immutable
plan-mode policy, cross-platform, real-sandbox, and end-to-end gates remain.

## Ports and cancellation status

The session ports define the target dependency direction and require an
`AbortSignal` on every potentially blocking operation. `AbortScope` supplies a
single-owner primitive for linking parent cancellation, deadlines, and local
consumer signals.

`WorkspacePort` is now wired through `ChatSession`; file tools, `AGENTS.md`, and
review UI share the cached guarded implementation. Its edit contract is split
into immutable `prepareEdit`, one-shot `commitEdit`, and explicit `discardEdit`;
legacy convenience writes delegate through the same transaction path.
`CommandPort` is also wired through the turn-scoped capability snapshot and the
same session approval coordinator. Extension-owned Git receives a fresh port
from the same factory. Phase 6 remains responsible for one transitive scope
across every stage—including preflight, snapshot, Docker lifecycle, cleanup,
storage, and UI—and suppression of late effects, so cancellation remains best
effort as stated in `SECURITY.md`.

## Compatibility facades

The extraction keeps established import paths stable:

- `src/llm/prompt.ts` re-exports prompt tool types and active declarations.
- `src/tools/forbiddenTools.ts` re-exports catalog classification helpers.
- `src/chat/storage.ts` re-exports chat model types and decoder helpers.
- `src/ui/messaging.ts` re-exports the shared protocol.
- `src/chat/session.ts` re-exports `UiEvent` and `ToolCategory`.
- `src/tools/fsTools.ts` preserves pure display helpers and delegates legacy
  filesystem entry points to `GuardedWorkspace`.
- `src/tools/workspaceGuard.ts` preserves point-in-time resolution for older
  callers but explicitly does not confer durable I/O authority.
- `src/tools/terminalTool.ts` remains a fail-closed legacy facade; it contains
  no command runner. `src/tools/safeCommands.ts` preserves old setting shapes
  but never evaluates their regex text.

New code should import the canonical modules. Facades can be removed only after
all consumers have migrated and the public compatibility cost is understood.

## Making changes safely

When adding a tool, add one catalog entry and tests that prove prompt exposure,
mode behavior, category, and approval policy remain aligned. Never add a second
handwritten allow-list.

When adding a sandbox command, add or edit one structured application setting
rule. Do not add shell parsing, model-controlled argv/cwd/environment, a runtime
fallback, or another child-process adapter. Any profile change must update the
host profile digest, image/supervisor contract, pre-start and post-exit
attestation, adversarial tests, and public limitations together.

When adding a host-bound message, extend the union and its parser together,
keep the field set closed, bound attacker-controlled strings, and add acceptance
and rejection cases. Providers must continue to receive `unknown` and dispatch
only the parsed value.

When adding direct filesystem, process, or network access, place it behind the
appropriate adapter. A temporary exception is only for already-known legacy
code and must point to an active release gate; it is not a general escape hatch.
