# Local LLM Harness

Local LLM Harness is a VS Code extension for using a LAN or local
`llama.cpp` server as a coding assistant. It keeps file access scoped to the
current workspace and only runs terminal commands that match your safe-command
allow-list.

## Install From GitHub Artifact

1. Open this repository on GitHub.
2. Go to **Actions**.
3. Open the latest successful **Build VSIX** workflow run.
4. Download the artifact named `local-llm-harness-vsix`.
5. Unzip the downloaded artifact. It contains a file like:

   ```text
   local-llm-harness-0.1.0.vsix
   ```

6. In VS Code, open the Command Palette and run:

   ```text
   Extensions: Install from VSIX...
   ```

7. Select the `.vsix` file.
8. Reload VS Code when prompted.

After installation, the **Local LLM Harness** icon appears in the Activity Bar.

## Setup

Open VS Code settings and configure:

- `localLlmHarness.endpoint`: your `llama.cpp` server URL, for example `http://localhost:8080`
- `localLlmHarness.modelFamily`: `gemma4` or `qwen3`
- `localLlmHarness.safeCommands`: terminal commands the assistant may propose

The endpoint must resolve to a local or private/LAN address.

## Using The Extension

- Use **New chat** to start a conversation.
- Use **Plan mode** when you want the assistant to inspect and propose changes without writing files or running commands.
- File tools are limited to the open workspace.
- Terminal commands always require your approval and must match `localLlmHarness.safeCommands`.

Saved chats are stored locally in `.local-llm-chats/`.

## Safe Commands

Safe commands are configured in `settings.json`:

```jsonc
"localLlmHarness.safeCommands": [
  { "match": "npm test", "description": "Run tests" },
  { "match": "npm run (build|typecheck|lint)", "description": "Project checks" },
  { "match": "git (status|diff|log(?: -[0-9]+)?)", "description": "Read-only git commands" }
]
```

Each `match` is a regular expression matched against the full command string.
Keep these rules narrow. A matched command still needs manual approval before
it runs.

## Build Locally

For local development:

```bash
npm install
npm run build
npm run package:vsix
```

The package command creates a `.vsix` file in the project root.
