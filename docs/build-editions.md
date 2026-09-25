# Build editions

Implemented on `feat-multi-build`, September 25, 2026. Run `npm run package:vsix`
to produce four packages in `artifacts/`:

| Edition | Command executor | Dedicated search |
| --- | --- | --- |
| `no-commands` | Absent | Absent |
| `safe-list` | Regex policy and literal argument execution | Absent |
| `commands` | General shell/native execution | Absent |
| `advanced` | Same general executor | SearXNG |

The packages retain the same extension ID. Installing another edition replaces
the installed edition while retaining chats and common preferences. Normal
`npm run build` uses Commands. To package one edition during development:
`npm run package:vsix -- --profile=safe-list`.

## Ownership and isolation

`scripts/build-profiles.mjs` resolves `src/build/` facade imports to the selected
feature modules before esbuild loads their dependencies. Shared code never
imports a runtime registry of all editions. `src/features/commands/shared/`
contains process lifecycle and command UI, `full/` contains general execution,
and `safeList/` contains policy and constrained execution. `features/advanced/`
composes general commands with `features/webSearch/`. The `features/none/`
modules contribute no optional tools or executors.

The resolver rejects forbidden imports, including unused transitive imports.
Packaging audits input graphs, staged manifests, emitted bundles, and the actual
VSIX archives. No commands excludes subprocess imports, command schemas, job
management, settings, controls, and command styles. Safe list excludes the
general shell runner. Search and its additional network policy exist only in
Advanced. Safe-list code/settings exist only in Safe list. Source files, maps,
development dependencies, and other editions' outputs are excluded from VSIXs.

All editions share `src/scm/commitMessage.ts` and the fixed VS Code Git adapter in
`src/scm/gitApi.ts`. There is no direct subprocess fallback in this integration.

## Runtime behavior

- Commands require approval by default. Safe list's single auto-approval switch
  treats every matching command identically, including deletion. Review always
  asks; Plan exposes no command tools.
- Safe-list settings are read from user configuration only. Edit User Settings
  opens user JSON and seeds defaults when absent. Empty lists deny everything;
  malformed patterns fail closed. Entire normalized commands must match. Native
  and legacy calls share the same policy. Matching uses a timed worker.
- Built-in path checks protect workspace containment, the root, and Git metadata.
  Read-only Git forms suppress configured helpers and lazy network fetches.
  Policy and command/workspace identity are checked again before launch.
- Advanced exposes `web_search` only with a configured SearXNG base URL. Every
  query requires approval, including Plan and Review. Only the approved query
  and search options are sent. Results are bounded text and escaped source links;
  there is no automatic page fetching. Endpoint changes invalidate pending
  approvals. All HTTP goes through `safeFetch`; model endpoint restrictions stay
  unchanged.

## Verification

- TypeScript checks, ESLint, default build, and all 819 tests across 58 Vitest files passed.
- Build probes for all four editions, three modes, two transports, and four
  compatibility families; deliberate forbidden imports verify build rejection.
- Safe-policy tests cover quoting, whole matches, regex timeouts, path escapes,
  symlinks, deletion flags, Git subcommands/helpers, approval changes, and
  workspace replacement. Actual file operations use temporary fixtures.
- Search tests cover endpoint policy, query forwarding, input bounds, invalid
  responses, output escaping, and changed destinations. Shared transport tests
  cover redirects, model isolation, and bounded response reads.
- Shared Git tests cover staged diffs, repository selection, nested repositories,
  unavailable Git integration, and missing baselines.
- All four staged builds and actual VSIX archives passed isolation audits.
- All four VSIXs installed and replaced one another successfully using the VS Code
  CLI with temporary extension/user-data directories; installed manifests were
  checked after each replacement.
- Packaged chat and settings webviews passed headless Electron smoke checks for
  all four editions in light and dark themes. Search-card spacing was inspected.
  Existing scroll checks passed for manual input, streamed updates, compaction,
  nested command panes, jump-to-latest, and restored chats.
- `git diff --check` passed.

## Implementation limits

Safe list is a command policy, not OS sandboxing. Custom patterns can admit
programs that access the network or run further code. Filesystem validation is
not race-proof isolation against other local processes. Recursive checks stop
after 10,000 entries; narrow search paths in larger workspaces. Safe Git currently
requires a `.git` directory inside the workspace, so linked worktrees are refused.
On Windows, Safe list executes `.exe`/`.com` programs without a batch-file shell
fallback. Native Windows execution was not tested in this Linux environment.

SearXNG must have JSON search enabled. Automated search tests use mocked HTTP;
no live provider or live model session was used for this verification. VSIX
installation and browser smoke checks do not replace an interactive end-to-end
session with a configured model and search service.
