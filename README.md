# Local LLM Harness

Local LLM Harness is a VS Code extension that turns a locally hosted
`llama.cpp` server into a coding assistant inside your editor. Model requests
are sent only to the configured `localhost` or private-address endpoint.

> **Security hardening in progress:** this version does not claim complete host
> or process isolation. Assistant shell commands are disabled and fail closed
> while a verified sandbox runner is developed. All assistant file tools, root
> `AGENTS.md` loading, and workspace file review/opening use one guarded
> capability that rejects noncanonical paths, detected links, and multiply
> linked regular files; bounds reads and traversal; verifies file identity; and
> atomically replaces writes. Exact diff-bound approval and command sandboxing
> remain incomplete. This is an application boundary, not an OS filesystem
> sandbox; see [SECURITY.md](SECURITY.md) for its explicit threat-model limit.

The assistant has workspace file tools but no general-purpose network tool.
All auto-approval settings are off by default. Approval reduces accidental
actions; it is not a substitute for the isolation work tracked in the security
policy.

## Install

1. Open this repository on GitHub and go to **Releases**.
2. Download the latest `.vsix` asset (`local-llm-harness-<version>.vsix`).
3. Install it using either method:

   **From the terminal** (substitute the version you downloaded):

   ```bash
   code --install-extension local-llm-harness-<version>.vsix
   ```

   **From inside VS Code:** open the Command Palette (`Ctrl/Cmd+Shift+P`) and
   run **Extensions: Install from VSIX…**, then pick the file you downloaded.

4. Reload VS Code when prompted.

The **Local LLM Harness** icon will appear in the Activity Bar on the left. The
welcome screen and the chat window both open initially; you can drag the chat
window to a location that is more comfortable for you.

## First-time setup

Click the harness icon in the Activity Bar, then switch to the **Settings**
tab in the side panel. You need to configure two things before chatting:

- **Server URL** — the address of your `llama.cpp` server, e.g.
  `http://127.0.0.1:8080/v1` or `http://192.168.1.50:8080/v1`. It must be
  `localhost` or a private IP literal; DNS hostnames such as `nas.local` are
  refused. Click **Save** to validate.
- **Model family** — pick `gemma4` (Gemma-style chat template) or `qwen3`
  (Qwen / ChatML) to match the model your server is serving. The family
  selects how the assistant's output is parsed for tool calls and reasoning;
  picking the wrong one means tool calls may not be recognized.

The other settings (context size, sampling, auto-approve toggles, and context
budgets) have conservative defaults and can be revisited later. The retained
safe-command settings are currently inactive because assistant command
execution is disabled.

## Starting a chat

The harness binds each chat to exactly one local filesystem folder. Multi-root,
virtual, and authority-bearing network-share workspaces are refused because
they do not provide one unambiguous local approval and filesystem scope.

Open the harness panel and either:

- Click **+ New chat** on the Welcome page, or
- Click any past chat in the list to reopen it.

Type your question in the composer at the bottom of the chat panel and press
**Enter** to send. Use **Shift+Enter** for a newline. While the assistant is
responding, the send button turns into a stop button. Clicking it requests
cancellation of the current turn. Some preflight and cleanup stages are not yet
covered by a single proven cancellation boundary; see [SECURITY.md](SECURITY.md).

The assistant streams its response as it goes. If the model supports a
"thinking" mode, you'll see a collapsible **Thinking…** row above the
response — click it to read the reasoning. When the thought is done, the
label becomes **Thought for N seconds**.

## Plan mode

Plan mode (toggle with the **Plan mode** pill) restricts the
assistant to read-only tools. It can browse and read your files but cannot
write or run commands — it produces a written plan instead.

Once the plan is rendered, you'll see two buttons:

- **Accept plan and execute** — turns plan mode off and asks the assistant
  to carry out what it just proposed.
- **Reject plan and suggest changes** — keeps plan mode on and lets you
  type feedback so the assistant can revise.

Use plan mode for anything non-trivial. It gives you a chance to redirect
before files are touched.

## Commit message generation

Open VS Code's **Source Control** view after staging changes. The Local LLM
Harness button in the Source Control title bar can generate a commit message
from the staged diff.

- If staged changes exist, hover text reads **Generate commit message with
  local-llm**. Click the button to send the staged diff to your configured
  local `llama.cpp` endpoint and write the generated message into Git's commit
  input box.
- If nothing is staged, hover text reads **Please stage changes before
  generating a commit message.** Clicking the button briefly wiggles the icon.
- While the model is working, the icon spins. The extension only drafts the
  message; it does not commit anything.
- A Git repository whose root is above or outside the selected workspace is
  refused, so a subfolder cannot authorize sending the parent repository's
  staged diff.

The prompt asks the model to output only the commit message, using an
imperative, concise subject line and a short body only when it adds useful
context.

## How tool calls work

When the assistant wants to interact with your workspace, it emits a tool
call which appears as a small card in the chat. Cards are color-coded:

- **Read tools** (`read_file`, `list_dir`, `glob`) — gray. They require manual
  approval by default. **Auto-approve reads** is an explicit opt-in for trusted
  workspaces.
- **File edit tools** (`write_file` — surfaced as "Edit File") — gray. They
  require manual approval by default. The current approval is not yet bound to
  an immutable, complete precomputed diff; this is a documented interim
  limitation, not a hard security boundary. Click **Accept changes** to apply,
  or **Reject changes and suggest changes** to refuse and leave feedback in the
  composer.
- **Commands** (`run_command`) — disabled. Every assistant command request is
  refused while the isolated runner is being developed. `safeCommands` and
  **Auto-approve commands** cannot enable execution, and there is no host-shell
  fallback.
- **Errors** — if a tool fails (e.g. file not found, write permission
  denied), the card turns red and the error is fed back to the assistant so
  it can self-correct without ending the chat. Click any card to expand it
  and inspect arguments, raw output, or the diff.

## Project instructions (`AGENTS.md`)

If a file named `AGENTS.md` exists at the root of your workspace, its contents
are loaded into the assistant's system prompt as standing instructions for that
project — a place to record build/test commands, code-style conventions, or any
context the model should keep in mind on every turn.

- **Root only.** Only the workspace-root `AGENTS.md` is read; nested
  `AGENTS.md` files in sub-directories are not (yet) supported.
- **Always on, no setup.** It is picked up automatically whenever the file is
  present — there is no setting to enable. Remove the file to turn it off.
- **Live and bounded.** The file is re-read each turn, so edits take effect on
  your next message without reloading. An empty file is ignored. Valid source
  files up to 1 MiB are truncated to 16 KiB for the prompt; larger, invalid
  UTF-8, linked, multiply linked, or non-file inputs are ignored.
- **Authority.** Project instructions rank *below* the harness's own safety
  rules and your live chat messages: if they conflict, the harness rules and
  your request win. Treat `AGENTS.md` as untrusted project content, not a way to
  grant unavailable capabilities.

`AGENTS.md` is read through the same guarded workspace capability as assistant
file tools. It never grants additional capabilities or changes approval policy.

This follows the same [AGENTS.md](https://agents.md) convention used by other
coding agents, so a file you already maintain for them works here too.

## Commands (temporarily disabled)

Assistant command execution is unavailable until it can run in a verified,
disposable sandbox. A `run_command` call always fails closed, regardless of
approval or configuration, and never falls back to the ambient host shell.

The `localLlmHarness.safeCommands` and
`localLlmHarness.autoapproveCommands` settings remain visible so existing user
configuration is not destroyed and can be migrated later. They are currently
inert: editing an allow-list entry or enabling auto-approval does not authorize
execution. A matching regular expression is not considered a security
boundary. See [SECURITY.md](SECURITY.md) for the requirements that must be met
before commands can return.

## Managing context

A small ring on the composer toggle bar shows how full the model's context
window is. When it gets close to full:

- **Auto-compact** (on by default) summarizes older parts of the
  conversation when context reaches the configured threshold (80% by
  default).
- If auto-compact is off, the context ring turns red at that threshold so
  you can compact manually before the next request gets too large.
- You can also click the context ring at any time to compact immediately.

Compaction trades fidelity for headroom — older details are summarized so
the model has room to keep working. If accuracy of early-conversation
details matters, start a new chat instead.

## Settings reference

| Setting | Default | What it does |
| --- | --- | --- |
| `endpoint` | `http://localhost:8080/v1` | URL of your llama.cpp server. Use `localhost` or a private IP literal such as `http://127.0.0.1:8080/v1` or `http://192.168.1.50:8080/v1`. |
| `modelFamily` | `gemma4` | Output-parsing family (`gemma4` = Gemma, `qwen3` = Qwen/ChatML). Must match the served model. |
| `contextSize` | `32768` | Total tokens the model can hold. |
| `temperature` | `0.3` | Sampling temperature for chat requests. Lower is more deterministic, higher more varied. |
| `topK` | `40` | Top-k sampling: keep only the K most likely tokens at each step (`0` disables). |
| `topP` | `0.95` | Top-p (nucleus) sampling: keep the smallest token set whose cumulative probability reaches p (`1` disables). |
| `autoCompact` | `true` | Summarize old turns automatically near the context limit. |
| `autoCompactThresholdPercent` | `80` | Context usage percentage that triggers auto-compaction. |
| `tailBudgetPercent` | `30` | Share of the context window reserved for keeping recent messages verbatim during compaction. |
| `maxMessageTokensPercent` | `25` | Per-message context cap; larger messages are middle-truncated with an elision marker. |
| `templateOverheadTokensPerMessage` | `4` | Estimated chat-template tokens added per message when calculating context usage. |
| `autoapproveReads` | `false` | Skip approval for read-only file tools. Off by default; enable only for trusted workspaces. |
| `autoapproveWrites` | `false` | Skip approval for file-edit tool calls. Off by default. |
| `autoapproveCommands` | `false` | Retained for compatibility but inactive while `run_command` is disabled. |
| `safeCommands` | (built-in list) | Retained command-policy configuration; currently inactive and does not authorize execution. |

`autoapproveCommands` and `safeCommands` currently have no execution effect.
Every assistant command is refused until a verified sandbox is available.

All harness settings are application-scoped and read only from VS Code's
default/global configuration. A workspace's `.vscode/settings.json` cannot
redirect the endpoint or enable automatic approval.

The **Reset** section at the bottom of the Settings tab has a **Restore all
defaults** button that returns every setting above — including the server URL
and the safe-command list — to its default. It asks for confirmation first.

The sampling settings (`temperature`, `topK`, `topP`) are sent with every chat
request, so they override whatever `--temp`, `--top-k`, or `--top-p` flags the
`llama.cpp` server was started with. Commit-message generation and context
compaction keep their own fixed low-temperature settings.

## Where chats are stored

Chats are saved in your home folder under `.local-llm-chats/`, not inside the
workspace. Each chat record stores the workspace folder it belongs to, and the
Recent Chats list only shows records whose folder matches the currently open
workspace. This keeps chat transcripts out of recursive workspace commands such
as `grep`.

You can delete a chat by hovering its row in the Welcome list and clicking the
trash icon. Deleting cannot be undone.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Enter` | Send message |
| `Shift+Enter` | Newline in composer |

## Privacy and current security boundary

- The endpoint validator refuses DNS hostnames other than exact `localhost`;
  use loopback, link-local, CGNAT, or RFC 1918 private IP literals.
- File tools accept canonical, forward-slash, workspace-relative paths only.
  Absolute, drive-relative, UNC/device, alternate-data-stream, traversal,
  reserved-device, detected linked, and multiply linked targets are rejected.
  Reads and enumeration are bounded and identity-checked; writes revalidate the
  base and use same-directory atomic replacement or no-clobber publication.
- These checks defend against model-supplied paths and detected static malicious
  link content. Portable Node cannot eliminate a race with a separate same-user
  process that concurrently replaces path components, nor reliably identify
  every pre-existing or changing mount/reparse topology. Defending against that
  actor and those opaque mount forms requires native handle-relative filesystem
  primitives or an OS sandbox.
- Commit-message generation uses extension-owned Git inspection, reads staged
  changes (`git diff --cached`), and sends that diff to the configured local/LAN
  endpoint. This path is separate from disabled assistant commands and has not
  yet been migrated to the future sandbox runner.
- The assistant has no network tool — it cannot fetch URLs, call APIs, or
  install packages on your behalf. Assistant shell commands are disabled.
- Chat records are ordinary, unencrypted local files. The configured endpoint
  receives prompts and any workspace excerpts included in them.

The exact guarantees, trusted components, known limitations, and release gates
are documented in [SECURITY.md](SECURITY.md).

---

## Development

The sections below are only relevant if you are building, testing, or modifying
the extension from source. Installing a released `.vsix` (see **Install** above)
does not require any of this.

The [architecture guide](docs/architecture.md) maps the module boundaries,
runtime validation points, compatibility facades, and tracked legacy seams.

### Build a `.vsix` from source

If you'd rather build the extension yourself than download a release, package a
`.vsix` from this repository and install it.

1. Make sure dependencies are installed (see **Development setup** below):

   ```bash
   npm install
   ```

2. Build and package the `.vsix`:

   ```bash
   npm run package:vsix
   ```

   This bundles the extension (via `npm run build`) and writes
   `local-llm-harness-<version>.vsix` to the repository root, where `<version>`
   matches the `version` in `package.json`.

3. Install the freshly built file the same way as a released one:

   ```bash
   code --install-extension local-llm-harness-<version>.vsix
   ```

   Or, from inside VS Code, run **Extensions: Install from VSIX…** from the
   Command Palette (`Ctrl/Cmd+Shift+P`) and pick the file. Reload VS Code when
   prompted.

To rebuild after changing the source, re-run `npm run package:vsix` and install
the new file again (add `--force` to `code --install-extension` to overwrite the
previous install of the same version).

### Development setup

You only need Node.js if you are building, testing, packaging, or modifying
the extension from source. Installing a released `.vsix` in VS Code does not
require Node.js.

Use Node.js `20.19.0` or newer. Node `22.x` is recommended. The current
development toolchain includes Vite, Vitest, Rolldown, and Shiki packages that
declare Node `20+` requirements; running `npm install` with Node `18` may print
`EBADENGINE` warnings, and tests can fail before they start with missing
runtime APIs such as `node:util.styleText`.

If your system Node is too old, install a project-local Node with `nvm`:

```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

nvm install 22
nvm use 22
node -v
```

Then install dependencies and run the checks:

```bash
npm install
npm run typecheck
npm test
```

If `nvm` is still not found after installation, close and reopen the terminal,
or source `~/.nvm/nvm.sh` as shown above.
