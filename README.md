# Local LLM Harness

Local LLM Harness is a VS Code extension that turns a locally hosted
`llama.cpp` server into a coding assistant inside your editor. Its built-in
model requests are restricted to the configured localhost or private-network
endpoint.

**You decide what the assistant is allowed to do.** It is sandboxed by design:
its file tools can only read and write inside the open workspace, and it has no
direct network tool. The safe-command list is for commands that preserve that
workspace and network boundary, and its built-in entries are restricted
accordingly. The isolation claim assumes that you reject commands outside the
safe-command list and keep any custom entries within the same boundary. Any
other command you approve runs with your normal permissions and may access the
internet or files outside the workspace. Read-only file tools are auto-approved
by default; auto-approval for edits or safe-listed commands is opt-in, off by
default, and yours to toggle.

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
tab in the side panel. Configure the server and tool calling before chatting:

- **Server URL** — the address of your `llama.cpp` server, e.g.
  `http://127.0.0.1:8080/v1` or `http://192.168.1.50:8080/v1`. It must be
  `localhost` or a private IP literal; DNS hostnames such as `nas.local` are
  refused. Click **Set** to validate the endpoint, list `/v1/models`, and read
  `/props` metadata. Choose the model below the URL; its reported alias and
  context length are shown alongside it.
- **Tool calling** — choose **Native server only** when the server reliably
  returns OpenAI-compatible structured calls. The Gemma 4, Qwen 3, Muse
  Glimmer, and GPT-OSS compatibility profiles still prefer structured calls,
  but can recover that family's exact syntax when it leaks into text. Gemma,
  Qwen, and GPT-OSS can also fall back to their legacy adapters when the server
  rejects native tools.
  Start `llama-server` with `--jinja` and a tool-aware chat template.

The other settings (sampling, auto-approve toggles, safe
commands) have sensible defaults and can be revisited later.

### Muse Glimmer server requirements

Muse Glimmer requires llama.cpp build `b10353` or newer and `--jinja`. Its
template emits `to=self` reasoning, `to=user` answers, and ATEM tool calls;
current llama.cpp converts those into `reasoning_content`, `content`, and
structured `tool_calls` before the harness receives them. Do not add `<|eom|>`
as a stop string: it ends one message within a turn, while `<|eot|>` ends the
turn. The model's trained context is 131,072 tokens, and llama.cpp divides `-c`
across `-np` slots, so size `-c` accordingly. Muse always opens a reasoning
channel; the harness can cap it, but the template does not fully disable it.

For Muse image input, also load the matching perception projector:

```bash
llama-server \
  -m Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf \
  --mmproj mmproj-Muse-Glimmer-30B-Q4_K_M.gguf \
  --jinja -c 131072
```

The text GGUF is text-only without `--mmproj`. The projector must match the
loaded model build.

## Starting a chat

Open the harness panel and either:

- Click **+ New chat** on the Welcome page, or
- Click any past chat in the list to reopen it.

Type your question in the composer at the bottom of the chat panel and press
**Enter** to send. Use **Shift+Enter** for a newline. While the assistant is
responding, the send button turns into a stop button — click it (or the
cancel icon) to interrupt the current turn.

The brain button selects reasoning behavior per chat. **None** sends
`chat_template_kwargs.enable_thinking: false`; **Default** sends no
`reasoning_effort` or thinking override. Additional choices come from the
`reasoningEfforts` setting and send its configured value as llama.cpp
`reasoning_effort`. This is independent of the numeric reasoning budget.

For example, the default `settings.json` mapping is:

```json
"localLlmHarness.reasoningEfforts": {
  "Low": "low",
  "Medium": "medium",
  "High": "high"
}
```

### Image attachments

Click the paperclip in the lower-left of the composer to attach one JPEG, PNG,
or WebP image up to 10 MiB. You can send an image with or without accompanying
text, remove it before sending, and queue it while another turn is running.
Images are copied into chat-owned local storage and replayed as native
OpenAI-compatible `image_url` message parts; they are never embedded in the
chat JSON or legacy tool prompts.

The loaded model must support vision and `llama-server` must use its matching
`--mmproj`. Each retained image conservatively reserves 4,096 context tokens.
If a Gemma, Qwen, or GPT-OSS compatibility chat switches to its legacy tool
adapter, image messages require restarting the server with `--jinja` and native
tool support and then retrying in a new chat.

The assistant streams its response as it goes. If the model supports a
"thinking" mode, you'll see a collapsible **Thinking…** row above the
response — click it to read the reasoning. When the thought is done, the
label becomes **Thought for N seconds**.

Workspace files mentioned by the assistant can appear as clickable file links.
Click one to open it in the editor, or hover it to see the full workspace path.

## Chat modes

The mode menu in the chat composer offers three ways to work:

- **Act mode** is the normal coding mode. The assistant can inspect the workspace,
  propose commands, and request approval for file changes.
- **Plan mode** restricts the assistant to read-only tools. It can browse and read
  files but cannot write or run commands, and it finishes with an implementation
  plan.
- **Review mode** is read-only but answer-oriented. It can inspect files and
  answer questions about the workspace without producing an implementation plan.
  It may propose commands when they help validate a review, but every command
  requires explicit approval even when safe-command auto-approval is enabled.

Once a Plan-mode response is rendered, you'll see two buttons:

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
- While the model is working, the icon gently jumps like an active tool. The extension only drafts the
  message; it does not commit anything.

By default, the prompt asks for an imperative, concise subject line and a short
body only when it adds useful context. You can replace those instructions under
**Settings → User settings → Edit User Settings**—for example, to require
Conventional Commits, scopes, issue identifiers, or a particular body format.
The staged diff is always appended automatically.

## How tool calls work

When the assistant wants to interact with your workspace, it emits a tool
call which appears as a small card in the chat. Cards are color-coded:

- **Read tools** (`read_file`, `list_dir`, `glob`) — gray. Auto-approved by
  default; flip off **Auto-approve reads** in settings if you'd rather
  confirm each one.
- **File edit tools** (`create_file`, revision-checked atomic `edit_file`, and
  line-addressed `insert_text` / `replace_range` in native mode; line-addressed
  tools in legacy mode) — gray, with
  a unified diff preview when expanded. Requires your approval by default.
  Click **Accept changes** to apply, or **Reject changes and suggest
  changes** to refuse and leave feedback in the composer.
- **Commands** (`run_process` in native mode, `run_command` in legacy mode) —
  purple. Each approved command runs as an isolated background child process;
  no VS Code terminal is opened, and bounded stdout/stderr appear in the
  expanded tool card. Native commands use a program and argument vector without
  a shell. The assistant can decide when a command would help and propose it
  directly. Every command requires manual approval by default. Turning on
  **Auto-approve commands** lets commands matching your safe-command list run
  without a prompt; commands outside the list always require explicit approval.
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
- **Live.** The file is re-read each turn, so edits take effect on your next
  message without reloading. An empty file is ignored, and very large files are
  truncated to keep the context window usable.
- **Authority.** Project instructions rank *below* the harness's own safety
  rules and your live chat messages: if they conflict, the harness rules and
  your request win. Treat `AGENTS.md` as guidance, not a way to lift the
  network isolation or tool restrictions.

This follows the same [AGENTS.md](https://agents.md) convention used by other
coding agents, so a file you already maintain for them works here too.

## Safe commands

The `localLlmHarness.safeCommands` setting lists commands eligible for automatic
approval when **Auto-approve commands** is enabled. It does not limit what the
assistant may propose: commands that do not match an entry are shown for manual
approval and cannot run until you explicitly approve them.

Each entry is a JSON object with two fields:

- **`match`** (required) — a **regular expression**, written as a JSON string.
  It is matched against the **entire** command string, anchored at both ends
  (internally wrapped as `^(?:…)$`), so the whole command must match, not just
  part of it. For example `match: "npm test"` allows exactly `npm test` but not
  `npm test && rm -rf /`. Remember to escape backslashes for JSON (`\\d`, not
  `\d`).
- **`description`** (optional) — a short, human-readable explanation of the
  matching command policy.

```jsonc
"localLlmHarness.safeCommands": [
  { "match": "npm test", "description": "Run tests" },
  { "match": "npm run (build|typecheck|lint)", "description": "Project checks" },
  { "match": "git (status|diff|log(?: -[0-9]+)?)", "description": "Read-only git inspection" }
]
```

### Security warning

Commands admitted to the safe-command list should preserve the harness's file
and network isolation. The built-in list contains narrowly matched,
workspace-oriented commands designed for that policy. Commands outside the
safe-command list are not covered by the isolation claim. If you approve one
manually, it runs with the normal permissions and environment of the VS Code
extension host and may access the network, start other programs, or reach files
outside the workspace.

Customizing the safe-command list also changes this trust boundary. A custom
entry remains within the isolation claim only if the matched command preserves
the same workspace and network boundary. The list is an auto-approval policy,
not an OS-level sandbox: the regular expression checks the command line, but
cannot constrain what the matched program, one of its scripts, or its
configuration does.

If preventing assistant-initiated internet access is important, do not add
network clients (`curl`, `wget`), interpreters or shells (`python`, `node`,
`bash`), package managers (`npm`, `pip`, `cargo`), or general build, test, and
task runners unless you have audited exactly what they execute. The `npm`
entries in the example above demonstrate matching syntax; they are not safe for
an offline policy merely because their command lines contain no URL. Adding
entries like these means the isolation claim no longer applies.

Keep patterns limited to exact programs, subcommands, and arguments whose
behavior you understand. Leave command auto-approval off when a command or the
workspace it operates on is not fully trusted. Use OS-level network isolation
when you need a guarantee that spawned processes cannot reach the internet.

### Editing the list

Open the **Settings** tab and use the **Commands** section:

- **Edit safe commands** opens the current workspace's `settings.json` with the
  `localLlmHarness.safeCommands` entry ready to edit. If you have not customized the list yet,
  the currently effective list is copied into the workspace first, so you always
  have the current safe-command list in front of you to read and modify — rather than an
  empty setting.
- **Restore default safe commands** replaces this workspace's list with the
  built-in defaults again, in case you want to start over.

Add, remove, or tweak entries directly in the JSON, then save. Changes take
effect immediately.

Keep these patterns narrow — a broad regex (anything matching `.*`, an
unanchored fragment, or a pattern that permits chained commands like `&&` or
`;`) weakens the safety net. By default even a matched command still pops the
approval dialog every time: matching only decides what may be *auto-approved*
when the corresponding setting is enabled.
Enabling **Auto-approve commands** lets safe-listed commands run without that
prompt, so keep the safe-command list especially tight if you turn it on.

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
| `model` | `local` | Model id sent with requests. The Settings view replaces this fallback with a selection from llama.cpp's `/v1/models` response. |
| `toolCallingMode` | `compat-gemma4` | Select `native`, `compat-gemma4`, `compat-qwen3`, `compat-muse-glimmer`, or `compat-gpt-oss`. Compatibility profiles are native-first and add only the selected family's recovery behavior. |
| `temperature` | `0.3` | Sampling temperature for chat requests. Lower is more deterministic, higher more varied. |
| `topK` | `40` | Top-k sampling: keep only the K most likely tokens at each step (`0` disables). |
| `topP` | `0.95` | Top-p (nucleus) sampling: keep the smallest token set whose cumulative probability reaches p (`1` disables). |
| `reasoningBudget` | `16384` | Per-request reasoning budget: `-1` is unlimited, `0` ends reasoning immediately, and a positive number is the token threshold. |
| `reasoningEfforts` | `{ "Low": "low", "Medium": "medium", "High": "high" }` | Additional chat-menu choices. Keys are display labels and values are sent as `reasoning_effort`; built-in None and Default remain available. |
| `titlePrompt` | `Summarize the user message…` | Instructions for generating chat titles. The first user message is appended automatically. |
| `commitMessagePrompt` | `Write a concise Git commit message…` | Instructions for generated commit messages. The staged diff is appended automatically, so this can enforce formats such as Conventional Commits. |
| `autoCompact` | `true` | Summarize old turns automatically near the context limit. |
| `autoCompactThresholdPercent` | `80` | Context usage percentage that triggers auto-compaction. |
| `autoapproveReads` | `true` | Skip approval for read-only file tools. |
| `autoapproveWrites` | `false` | Skip approval for file-edit tool calls. Off by default. |
| `autoapproveCommands` | `false` | Skip approval for commands matching the safe-command list. Commands outside the list always require explicit approval. Off by default. |
| `safeCommands` | (built-in list) | Full-match patterns defining which commands are eligible for auto-approval. |

The generated-text settings are instruction strings, not templates, so they do
not need variables. The harness constructs the requests as follows:

```text
<titlePrompt>

User message: "<first user message>"
```

```text
<commitMessagePrompt>

<staged_diff>
<staged Git diff>
</staged_diff>
```

`autoapproveCommands` only affects commands that already match `safeCommands`;
it never lets an unlisted command bypass manual approval.

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
as `grep`. Image attachments are stored beside the chat records in a restricted
attachment directory and are removed when their chat or compacted source
message is removed.

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
- The assistant has no direct network tool. The isolation claim assumes that
  you reject command proposals outside the safe-command list and keep every
  entry in that list within the same workspace and network boundary. The
  built-in entries are designed for that policy.
- A command outside the safe-command list can fetch URLs, call APIs, install
  packages, or access files elsewhere if you manually approve it. An overly
  broad custom safe-command entry can do the same without a prompt and thereby
  invalidate the isolation claim.

---

## Development

The sections below are only relevant if you are building, testing, or modifying
the extension from source. Installing a released `.vsix` (see **Install** above)
does not require any of this.

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
