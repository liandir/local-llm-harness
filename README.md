# Local LLM Harness

A VS Code extension that drives a locally hosted llama.cpp LLM (on the LAN) for
agentic coding, with hard network isolation, workspace-scoped file I/O, and an
approval-gated terminal restricted to a configurable safe-command allow-list.

## Guarantees

- **No outbound internet traffic.** A single `safeFetch` primitive is the only
  outbound HTTP path. An ESLint rule forbids `fetch`/`undici`/`http`/`https`
  imports anywhere else. The configured endpoint is validated on save to be
  loopback / RFC1918 / link-local / unique-local / CGNAT / `*.local`. Any
  model attempt to invoke `web_search` / `fetch` / `curl` / etc. is shown as a
  red abort card and the stream stops.
- **Workspace-only file access.** `read_file`, `write_file`, `list_dir`, `glob`
  all go through a guard that resolves the deepest existing ancestor via
  `realpath` (so symlinks-pointing-outside cannot escape the workspace).
- **Terminal allow-list.** `run_command` only matches against the user's
  `localLlmHarness.safeCommands` regex list, AND every command still requires
  manual user approval. Non-matching commands are red-carded and abort the
  stream.

## Running the extension

```bash
npm install
npm run build       # bundles extension + both webviews + KaTeX assets
```

Open the project in VS Code and press `F5` to launch an Extension Development
Host. The "Local LLM Harness" icon appears in the activity bar.

The chat view starts in the primary sidebar; drag it to the right (secondary)
sidebar by clicking the view title and dragging into the right edge — VS Code
remembers the placement.

## Supported models

Configure `localLlmHarness.modelFamily` to match your llama.cpp model:
- `gemma4` — Gemma 4 native tokens (`<|tool_call>...<tool_call|>`, `<|channel>thought`)
- `qwen3` — Hermes-style (`<tool_call>{json}</tool_call>`, `<think>...</think>`)

## Configuring safe commands

In `settings.json`:

```jsonc
"localLlmHarness.safeCommands": [
  { "match": "^npm (install|test|run [a-z:-]+)$", "description": "npm scripts" },
  { "match": "^git (status|diff|log( -[0-9]+)?)$", "description": "read-only git" }
]
```

Each entry is a full-string regex against the exact command the model emits.
No shell expansion is performed before matching. Every match still requires
user approval before execution.

## Plan mode

Toggle with `Shift+Tab` in the chat composer, or the button at the bottom of
the composer. In plan mode the model only sees read-only tools, and any
attempt to call `write_file` / `run_command` produces a red abort card. The
final reply is rendered as a blue plan card with Accept / Reject — rejection
opens a suggestion field that becomes the next user turn.

## Scripts

| Command | Purpose |
|---|---|
| `npm run build` | One-shot bundle. |
| `npm run watch` | Rebuild on change. |
| `npm test` | Run vitest (parser, guard, network policy). |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm run lint` | Eslint + import-firewall rule. |

## Layout

Key files:
- `src/network/safeFetch.ts`, `endpointValidator.ts` — the network firewall.
- `src/tools/workspaceGuard.ts` — path containment with `realpath`.
- `src/llm/parser/gemma4.ts`, `qwen3.ts` — streaming token parsers.
- `src/chat/session.ts` — turn loop, approval gates, tool dispatch.
- `src/ui/chatView/`, `src/ui/sideView/` — webviews.
