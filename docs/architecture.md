# Architecture

This guide describes the Phase 1 and Phase 2 module boundaries. Phase 1
introduced contracts and enforceable seams; Phase 2 routes workspace access
through one guarded capability. The later edit-transaction, sandbox, transcript,
and unified-cancellation phases remain incomplete. Current guarantees and
release gates live in [SECURITY.md](../SECURITY.md).

## Module map

| Concern | Canonical module | Responsibility |
| --- | --- | --- |
| Tool policy | `src/tools/catalog.ts` | Names, prompt schemas, availability, categories, and approval policy for active and disabled tools |
| Chat domain model | `src/chat/model.ts` | Versioned stored-record types, strict decoders, and explicit legacy migration |
| UI protocol | `src/chat/protocol.ts` | Shared structured-clone DTOs and strict parsers for messages entering the extension host |
| Session contracts | `src/chat/session/ports.ts` | Cancellable interfaces for model, storage, workspace, command, settings, clock, and ID dependencies |
| Cancellation primitive | `src/security/abortScope.ts` | Parent-linked operation scopes, deadlines, derived signals, and deterministic disposal |
| Workspace path policy | `src/security/workspace/pathPolicy.ts` | Canonical cross-platform relative-path grammar and glob parsing |
| Filesystem identity and atomic I/O | `src/security/workspace/boundary.ts` | Root binding, component inspection, bounded handle reads, revalidation, and atomic publication |
| Filesystem identity helpers | `src/security/workspace/fileIdentity.ts` | Fail-closed OS file-ID and version comparison |
| Workspace port adapter | `src/security/workspace/workspaceAdapter.ts` | Tool-facing limits, line edits, enumeration, and serialized mutations |
| VS Code file bridge | `src/security/workspace/vscodeBridge.ts` | Guarded live-document opening for editor UI actions |
| Legacy migration | `src/security/workspace/legacyChatMigration.ts` | Fixed-scope guarded read and exact-snapshot removal of historical workspace chats |
| SCM workspace scope | `src/scm/workspaceScope.ts` | Refusal of Git roots outside the selected workspace |
| Dependency policy | `security-architecture.json` | Approved raw-capability adapters and temporary exceptions tied to active security gates |
| Orchestration | `src/chat/session.ts` | Existing turn, approval, tool-loop, transcript, and compaction coordination |

`src/chat/session.ts` remains the largest legacy coordinator. Later phases can
split it behind the ports above while regression tests continue to exercise the
existing public `ChatSession` API.

## Security-relevant flows

### Model tool call

1. A model-family parser emits a dynamic tool name and argument payload.
2. `src/chat/session.ts` classifies the name through the canonical catalog.
3. Disabled, forbidden, unknown, and plan-violating calls fail closed.
4. The catalog supplies the active category and configurable approval setting.
5. `ChatSession` executes the approved operation through its cached
   `GuardedWorkspace`, which implements `WorkspacePort` and revalidates the path
   at operation time. Compatibility wrappers contain no raw filesystem access.

Prompt advertisement and runtime classification therefore derive from the same
catalog entries. `run_command` is retained only as disabled compatibility
metadata and is never included in active prompt declarations.

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

Writes are serialized per adapter. They read a verified base, prepare exact
text in memory, write and sync an exclusive same-directory temporary file,
revalidate the base and parent, then atomically replace an existing target or
publish a missing target without clobbering a competing create. The model-facing
port does not expose delete; legacy chat migration receives only a fixed UUID
record flow and exact-snapshot removal.

These checks cover model-controlled paths and detected static malicious
link/hardlink content. Portable Node has no cross-platform
`openat`/handle-relative or mount-ID API, so a separate same-user process
concurrently replacing an ancestor—and pre-existing or changing mount/reparse
forms opaque to Node—are outside the proven application boundary. See the
public threat model in `SECURITY.md` before strengthening isolation claims.

### Webview to extension host

1. A provider receives `unknown` from `onDidReceiveMessage`.
2. `parseChatToExt` or `parseSideToExt` checks the discriminant, exact fields,
   primitive types, ranges, string bounds, and identifiers.
3. Only a parsed union member reaches the provider switch.

Settings sent through the generic side-view update are explicitly whitelisted.
Endpoint changes keep their dedicated validation flow; command auto-approval
and safe-command configuration cannot be forged through the generic message.
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

Phase 2 removed every temporary raw-workspace-filesystem exception. The one
remaining legacy exception is `src/util/exec.ts`, used for extension-owned Git
inspection until the Phase 4 process boundary lands.

## Ports and cancellation status

The session ports define the target dependency direction and require an
`AbortSignal` on every potentially blocking operation. `AbortScope` supplies a
single-owner primitive for linking parent cancellation, deadlines, and local
consumer signals.

`WorkspacePort` is now wired through `ChatSession`; file tools, `AGENTS.md`, and
review UI share the cached guarded implementation. Other Phase 1 ports are not
yet wired through the entire coordinator. Phase 6 remains responsible for one
transitive scope across every stage and suppression of late effects, so
cancellation is still best effort as stated in `SECURITY.md`.

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

New code should import the canonical modules. Facades can be removed only after
all consumers have migrated and the public compatibility cost is understood.

## Making changes safely

When adding a tool, add one catalog entry and tests that prove prompt exposure,
mode behavior, category, and approval policy remain aligned. Never add a second
handwritten allow-list.

When adding a host-bound message, extend the union and its parser together,
keep the field set closed, bound attacker-controlled strings, and add acceptance
and rejection cases. Providers must continue to receive `unknown` and dispatch
only the parsed value.

When adding direct filesystem, process, or network access, place it behind the
appropriate adapter. A temporary exception is only for already-known legacy
code and must point to an active release gate; it is not a general escape hatch.
