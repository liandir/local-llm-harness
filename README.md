# Local LLM Harness

Local LLM Harness is a VS Code extension that turns a locally hosted
`llama.cpp` server into a coding assistant inside your editor. Model requests
are sent only to the configured `localhost` or private-address endpoint.

> **Security hardening in progress:** this version does not claim complete host
> or process isolation. Assistant commands are available only as fixed,
> structured rules after a Docker-only sandbox passes runtime, image, and
> profile attestation; otherwise they fail closed with no host-shell fallback.
> The sandbox receives a bounded ephemeral copy of the workspace, has no
> external network or host workspace/credential/engine/device mount, and
> discards command filesystem changes. File
> tools retain the guarded, exact prepared-edit boundary described below.
> Cross-platform, installed-VSIX, real-Docker, transcript, and unified-
> cancellation release gates remain open; see [SECURITY.md](SECURITY.md).

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

The other settings (context size, sampling, auto-approve toggles, context
budgets, and the optional Docker sandbox) have conservative defaults and can be
revisited later. Command execution stays unavailable until every required
sandbox setting is supplied and the configured local runtime and immutable
image pass preflight.

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
  local `llama.cpp` endpoint. The result is written into the matching Git input
  box only when VS Code's built-in Git provider is already active; otherwise it
  is copied to the clipboard without activating host Git.
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

Git inspection for this feature uses the command sandbox. It therefore requires
the same verified Docker configuration and an audited image containing
`/usr/bin/git`. If that capability is unavailable, staged-change detection and
commit-message generation fail closed instead of running Git on the host.

## How tool calls work

When the assistant wants to interact with your workspace, it emits a tool
call which appears as a small card in the chat. Cards are color-coded:

- **Read tools** (`read_file`, `list_dir`, `glob`) — gray. They require manual
  approval by default. **Auto-approve reads** is an explicit opt-in for trusted
  workspaces.
- **File edit tools** (`write_file`, `insert_text`, and `replace_range` —
  surfaced as "Edit File") — gray. They require manual approval by default.
  Before presenting the decision, the extension reads one verified base
  snapshot, prepares the exact resulting UTF-8 text without changing the file,
  and shows a complete diff. Changed segments are JSON-quoted so line endings,
  tabs, control characters, and other invisible format characters are
  unambiguous. The host binds that artifact, its hashes, canonical path, base
  revision, session, turn, and proposal to a one-shot decision. Click **Accept
  changes** to commit those prepared bytes, or **Reject changes and suggest
  changes** to discard them. If the file or its path topology changed after
  review, acceptance fails as stale and nothing is reapplied automatically.
- **Commands** (`run_command`) — in act mode, this tool is advertised
  only when the configured Docker sandbox has passed preflight for the current
  turn. The model can select only an exact configured `ruleId`; the host owns
  the fixed executable, argument vector, and working directory. Manual approval
  shows the complete `command-v1` artifact before execution. There is no shell
  parsing or host-shell fallback.
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

## Sandboxed commands

Command support is deliberately opt-in and Docker-only. With the default blank
configuration, `run_command` is absent from the model prompt and any legacy
request fails closed. Enabling it requires all of the following:

- A Windows or Linux host with a local Docker Engine or Docker Desktop daemon
  running Linux containers on the host architecture (`linux/amd64` or
  `linux/arm64`). Command snapshots currently fail closed on macOS because the
  extension cannot yet prove nested-mount containment there.
- A compatible Linux container runtime exposing cgroup v2, the built-in
  seccomp profile, private cgroup/PID namespaces, and the live `/proc` metadata
  checked by the supervisor. Missing profile evidence keeps commands disabled.
- A canonical absolute path to an unlinked Docker CLI regular file outside the
  selected workspace. The harness binds and revalidates that file and never
  searches `PATH` for it.
- The platform-local Docker endpoint: a canonical `unix://` socket on Linux or
  a canonical `npipe://` endpoint on Windows. TCP, HTTP, SSH, and
  other network transports are rejected.
- A locally present image selected by an immutable `repo@sha256:...` digest or
  exact `sha256:...` image ID. Mutable tags are rejected. The harness never
  pulls, builds, or updates an image automatically.
- At least one closed structured rule in `sandboxCommands`.

The source tree and positive-manifest VSIX contain the reference
[Dockerfile](sandbox/Dockerfile) and [supervisor](sandbox/supervisor.mjs). Build
the image only from an audited, digest-pinned Linux runtime that provides
`/usr/local/bin/node` and every
absolute command executable your rules need. That base must not declare extra
environment variables, volumes, exposed ports, or a health check. Record the
resulting immutable image ID or repository digest in `sandboxImage`; configuring
a tag such as `latest` intentionally leaves commands unavailable.

From a source checkout, the intended build shape is:

```bash
docker build \
  --build-arg VERIFIED_RUNTIME_IMAGE=registry.example/runtime@sha256:<audited-digest> \
  --tag local-llm-harness-sandbox:local \
  --file sandbox/Dockerfile sandbox
docker image inspect --format '{{.Id}}' local-llm-harness-sandbox:local
```

Use the reported `sha256:...` ID in settings. The tag is only a convenient
local build label; the harness will not accept it as `sandboxImage`.

For example, this application-scoped configuration exposes one fixed rule:

```json
{
  "localLlmHarness.sandboxDockerPath": "/usr/bin/docker",
  "localLlmHarness.sandboxDockerHost": "unix:///var/run/docker.sock",
  "localLlmHarness.sandboxImage": "sha256:<64 lowercase hex characters>",
  "localLlmHarness.sandboxCommands": [
    {
      "id": "git-status",
      "description": "Inspect concise repository status",
      "executable": "/usr/bin/git",
      "args": ["status", "--short"]
    }
  ]
}
```

Use the absolute Docker Desktop CLI path and the default `npipe` endpoint on
Windows. Each configured executable must be a regular, non-link binary in the
image; executable symlinks are refused. An optional `cwd` is a canonical
workspace-relative directory inside the sandbox copy. Rule IDs and descriptions
are shown to the model; executable, arguments, and `cwd` remain fixed host
configuration. A model tool call is exactly `{"ruleId":"git-status"}` and
cannot add flags, shell operators, environment variables, or a different
directory.

Before manual approval, the host prepares a one-use command transaction and
shows one complete escaped `command-v1` artifact: rule and revision,
JSON-quoted executable and every argument, working directory, timeout and
output cap, Docker executable and endpoint, profile digest, immutable image
reference and ID, `network: none`, ephemeral workspace mode, and transaction
ID. The approval binding covers that exact artifact and execution profile.
`autoapproveSandboxCommands` is a separate explicit opt-in; it skips the human
decision but not structured resolution, attestation, limits, or the sandbox.

For execution, the harness creates a bounded, identity-checked workspace
snapshot and streams it over Docker stdin into `/workspace` tmpfs. It does not
bind-mount the host workspace, Docker socket, devices, volumes, or credentials.
The fixed container profile uses a read-only root filesystem, a non-root user,
no network, dropped capabilities, `no-new-privileges`, seccomp, private
namespaces, resource limits, and disabled persistent logs/restarts. The
supervisor invokes the fixed argv directly without a shell, enforces the
deadline, terminates descendants, and exits. Independently, the host stops the
Docker client on the first byte above the combined output limit. The container
is forcibly removed and absence is verified. If cleanup cannot be proved, every
command port using that Docker CLI and endpoint is quarantined for the rest of
the extension-host process; restarting is the only automatic recovery path. An
unknown container with the harness's management label is never deleted
automatically: remove it
explicitly after verifying its ownership, then restart the extension host. All
command-created or modified files are discarded, so use the file-edit tools for
persistent workspace changes.

Model-selected rules have a fixed 30-second deadline and 2 MiB combined-output
cap. Snapshot preparation accepts at most 50,000 entries, 256 MiB total, 64 MiB
per file, and 128 path components. Exceeding a limit refuses the command rather
than producing a partial workspace copy.

The snapshot covers the entire saved workspace; there is no ignore-pattern
filter. A configured executable—or project code it launches—can read every
copied file, and its stdout/stderr becomes tool output that may be stored in the
chat and sent to the configured LLM endpoint. Any detected link, hardlink,
special entry, cross-device traversal, unstable file, or over-limit tree
refuses the whole snapshot. Audit the image and rules, treat project scripts as
untrusted code, avoid workspaces containing secrets, and keep command auto-
approval off unless that full data flow is acceptable.

The deprecated `safeCommands` regular expressions and `autoapproveCommands`
toggle remain readable only for compatibility. They are never evaluated and
never authorize execution.

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
| `autoapproveSandboxCommands` | `false` | Skip the manual decision for configured structured rules only after sandbox verification. Off by default. |
| `sandboxDockerPath` | empty | Absolute path to the trusted local Docker CLI outside the workspace. Empty or invalid keeps commands unavailable. |
| `sandboxDockerHost` | empty | Optional canonical local `unix://` or `npipe://` endpoint. Empty uses the platform-local default; network transports are refused. |
| `sandboxImage` | empty | Immutable local `repo@sha256:...` reference or `sha256:...` image ID. Tags are refused. |
| `sandboxCommands` | `[]` | Up to 32 closed rules containing an ID, absolute POSIX regular non-link executable, fixed arguments, and optional `cwd`/description. |
| `autoapproveCommands` | `false` | Deprecated compatibility setting; ignored. |
| `safeCommands` | `[]` | Deprecated regex configuration; retained but never evaluated. |

Command configuration alone is not authority. Each turn captures one immutable
policy snapshot only after the Docker runtime, immutable image, and fixed
profile pass preflight; prompt advertisement, runtime classification, approval,
and execution all use that same snapshot. A missing CLI/daemon/image/rule,
changed image or profile, malformed setting, failed attestation, or cleanup
failure keeps commands unavailable. Plan mode never exposes command tools.

All harness settings are application-scoped and read only from VS Code's
default/global configuration. A workspace's `.vscode/settings.json` cannot
redirect the endpoint, configure a Docker capability, or enable automatic
approval.

The **Reset** section at the bottom of the Settings tab has a **Restore all
defaults** button that returns every setting above—including the server URL,
sandbox rules, and legacy command settings—to its default. It asks for
confirmation first.

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
  Reads and enumeration are bounded and identity-checked. Edits are limited to
  8 MiB of UTF-8 text and their exact approval artifact to 16 MiB; larger
  changes fail closed and must be split. A new target is reviewable only when
  its parent directory already exists. Existing-file no-op edits still verify
  the reviewed base but do not replace the file. Other writes revalidate that
  base and use same-directory atomic replacement or no-clobber publication.
- Manual edit decisions carry a host-issued, one-use session/turn/proposal
  binding. A deliberately enabled **Auto-approve writes** setting skips the
  manual decision, but still uses the same prepare, size-limit, stale-base, and
  atomic-commit path. The binding correlates the displayed artifact with the
  host transaction; it is not cryptographic proof that a human inspected it.
- The reviewed base is the file's on-disk UTF-8 content. Unsaved VS Code editor
  buffers are not part of that snapshot; save or revert them before approval to
  avoid a later editor save conflicting with the committed file.
- These checks defend against model-supplied paths and detected static malicious
  link content. Portable Node cannot eliminate a race with a separate same-user
  process that concurrently replaces path components, nor reliably identify
  every pre-existing or changing mount/reparse topology. Defending against that
  actor and those opaque mount forms requires native handle-relative filesystem
  primitives or an OS sandbox.
- Command snapshots use saved on-disk workspace content, not unsaved editor
  buffers. They are bounded per entry and revalidate each read, but they are not
  one globally atomic point-in-time image of a workspace changing concurrently.
- Command isolation trusts the host kernel, configured Docker CLI, Docker
  daemon/runtime, and audited immutable image. Docker tmpfs can be backed by
  host swap depending on host configuration; the harness does not claim that
  snapshot bytes can never reach disk. See [SECURITY.md](SECURITY.md) for the
  complete trust boundary.
- Commit-message generation and HEAD-content review run fixed Git argv through
  the same verified Docker sandbox. Git helpers, hooks, filters, text conversion,
  external diffs, credentials, prompts, network, and host-shell fallback are
  disabled. If sandboxed Git is unavailable, these features fail closed.
- The assistant has no network tool. A configured sandbox command can run only
  with Docker network mode `none`; package installation or remote fetches are
  therefore unavailable through `run_command`.
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
