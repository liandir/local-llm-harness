# Local LLM Harness

Local LLM Harness is a VS Code extension that turns a locally hosted
`llama.cpp` server into a coding assistant inside your editor. No data leaves
your machine or LAN. File access is scoped to the open workspace, and the
assistant cannot run shell commands you haven't explicitly allowed.

## Install

1. Open this repository on GitHub and go to **Releases**.
2. Download the latest `.vsix` asset (e.g. `local-llm-harness-1.0.1.vsix`).
3. Install it using either method:

   **From the terminal:**

   ```bash
   code --install-extension local-llm-harness-1.0.1.vsix
   ```

   **From inside VS Code:** open the Command Palette (`Ctrl/Cmd+Shift+P`) and
   run **Extensions: Install from VSIX…**, then pick the file you downloaded.

4. Reload VS Code when prompted.

The **Local LLM Harness** icon will appear in the Activity Bar on the left.

## Build a `.vsix` from source

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
   `local-llm-harness-<version>.vsix` to the repository root — for example
   `local-llm-harness-1.0.1.vsix`, matching the `version` in `package.json`.

3. Install the freshly built file the same way as a released one:

   ```bash
   code --install-extension local-llm-harness-1.0.1.vsix
   ```

   Or, from inside VS Code, run **Extensions: Install from VSIX…** from the
   Command Palette (`Ctrl/Cmd+Shift+P`) and pick the file. Reload VS Code when
   prompted.

To rebuild after changing the source, re-run `npm run package:vsix` and install
the new file again (add `--force` to `code --install-extension` to overwrite the
previous install of the same version).

## Development setup

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

## First-time setup

Click the harness icon in the Activity Bar, then switch to the **Settings**
tab in the side panel. You need to configure two things before chatting:

- **Server URL** — the address of your `llama.cpp` server, e.g.
  `http://127.0.0.1:8080` or `http://192.168.1.50:8080`. It must be
  `localhost` or a private IP literal; DNS hostnames such as `nas.local` are
  refused. Click **Save** to validate.
- **Model family** — pick `gemma4` (Gemma-style chat template) or `qwen3`
  (Qwen / ChatML) to match the model your server is serving. The family
  selects how the assistant's output is parsed for tool calls and reasoning;
  picking the wrong one means tool calls may not be recognized.

The other settings (context size, auto-approve toggles, safe commands) have
sensible defaults and can be revisited later.

## Starting a chat

Open the harness panel and either:

- Click **+ New chat** on the Welcome page, or
- Click any past chat in the list to reopen it.

Type your question in the composer at the bottom of the chat panel and press
**Enter** to send. Use **Shift+Enter** for a newline. While the assistant is
responding, the send button turns into a stop button — click it (or the
cancel icon) to interrupt the current turn.

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

The prompt asks the model to output only the commit message, using an
imperative, concise subject line and a short body only when it adds useful
context.

## How tool calls work

When the assistant wants to interact with your workspace, it emits a tool
call which appears as a small card in the chat. Cards are color-coded:

- **Read tools** (`read_file`, `list_dir`, `glob`) — gray. Auto-approved by
  default; flip off **Auto-approve reads** in settings if you'd rather
  confirm each one.
- **File edit tools** (`write_file` — surfaced as "Edit File") — gray, with
  a unified diff preview when expanded. Requires your approval by default.
  Click **Accept changes** to apply, or **Reject changes and suggest
  changes** to refuse and leave feedback in the composer.
- **Commands** (`run_command`) — purple. Only commands matching your
  safe-command allow-list are even offered; anything else is rejected
  before execution and returned to the assistant as a tool error so it can
  adapt or ask you to run the command manually. Matched commands **always
  require your manual approval, every time** — there is no auto-approve toggle
  for commands.
- **Errors** — if a tool fails (e.g. file not found, write permission
  denied), the card turns red and the error is fed back to the assistant so
  it can self-correct without ending the chat. Click any card to expand it
  and inspect arguments, raw output, or the diff.

## Safe commands

The `localLlmHarness.safeCommands` setting is an allow-list of shell
commands the assistant is permitted to propose. Each entry is a regular
expression matched against the full command string.

```jsonc
"localLlmHarness.safeCommands": [
  { "match": "npm test", "description": "Run tests" },
  { "match": "npm run (build|typecheck|lint)", "description": "Project checks" },
  { "match": "git (status|diff|log(?: -[0-9]+)?)", "description": "Read-only git inspection" }
]
```

Open `settings.json` directly via the **Edit safe commands** button in the
Settings tab. Keep these patterns narrow — broad regexes weaken the safety
net. Even a matched command still pops the approval dialog.

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
| `endpoint` | `http://localhost:8080` | URL of your llama.cpp server. Use `localhost` or a private IP literal such as `http://127.0.0.1:8080` or `http://192.168.1.50:8080`. |
| `modelFamily` | `gemma4` | Output-parsing family (`gemma4` = Gemma, `qwen3` = Qwen/ChatML). Must match the served model. |
| `contextSize` | `32768` | Total tokens the model can hold. |
| `autoCompact` | `true` | Summarize old turns automatically near the context limit. |
| `autoCompactThresholdPercent` | `80` | Context usage percentage that triggers auto-compaction. |
| `autoapproveReads` | `true` | Skip approval for read-only file tools. |
| `autoapproveWrites` | `false` | Skip approval for file-edit tool calls. Off by default. |
| `safeCommands` | (built-in list) | Allow-list of shell commands the assistant may propose. |

There is no `autoapproveCommands` setting by design.

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

## Privacy & isolation

- The endpoint validator refuses DNS hostnames other than exact `localhost`;
  use loopback, link-local, CGNAT, or RFC 1918 private IP literals.
- File tools cannot read or write outside the workspace root.
- Commit-message generation reads only staged changes (`git diff --cached`)
  and sends that diff to the configured local/LAN endpoint.
- The assistant has no network tool — it cannot fetch URLs, call APIs, or
  install packages on your behalf. If you want a package installed, run it
  yourself in the integrated terminal.
