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

## First-time setup

Click the harness icon in the Activity Bar, then switch to the **Settings**
tab in the side panel. You need to configure two things before chatting:

- **Server URL** — the address of your `llama.cpp` server, e.g.
  `http://localhost:8080`. It must resolve to a local or private/LAN address;
  public IPs are refused. Click **Save** to validate.
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

Plan mode (toggle with the **Plan mode** pill or **Shift+Tab**) restricts the
assistant to read-only tools. It can browse and read your files but cannot
write or run commands — it produces a written plan instead.

Once the plan is rendered, you'll see two buttons:

- **Accept plan and execute** — turns plan mode off and asks the assistant
  to carry out what it just proposed.
- **Reject plan and suggest changes** — keeps plan mode on and lets you
  type feedback so the assistant can revise.

Use plan mode for anything non-trivial. It gives you a chance to redirect
before files are touched.

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
  conversation in the background before your next message.
- You can also click the context ring at any time to compact immediately.

Compaction trades fidelity for headroom — older details are summarized so
the model has room to keep working. If accuracy of early-conversation
details matters, start a new chat instead.

## Settings reference

| Setting | Default | What it does |
| --- | --- | --- |
| `endpoint` | `http://localhost:8080` | URL of your llama.cpp server. LAN/private only. |
| `modelFamily` | `gemma4` | Output-parsing family (`gemma4` = Gemma, `qwen3` = Qwen/ChatML). Must match the served model. |
| `contextSize` | `32768` | Total tokens the model can hold. |
| `autoCompact` | `true` | Summarize old turns when nearing the limit. |
| `autoCompactThreshold` | `28000` | Token count that triggers auto-compaction. |
| `autoapproveReads` | `true` | Skip approval for read-only file tools. |
| `autoapproveWrites` | `false` | Skip approval for file-edit tool calls. Off by default. |
| `safeCommands` | (built-in list) | Allow-list of shell commands the assistant may propose. |

There is no `autoapproveCommands` setting by design.

## Where chats are stored

Chats are saved per workspace under `.local-llm-chats/` at the workspace
root. You can delete a chat by hovering its row in the Welcome list and
clicking the trash icon. Deleting cannot be undone.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Enter` | Send message |
| `Shift+Enter` | Newline in composer |
| `Shift+Tab` | Toggle plan mode (while chat is focused) |

## Privacy & isolation

- The endpoint validator refuses any address that isn't loopback,
  link-local, or RFC 1918 private space.
- File tools cannot read or write outside the workspace root.
- The assistant has no network tool — it cannot fetch URLs, call APIs, or
  install packages on your behalf. If you want a package installed, run it
  yourself in the integrated terminal.
