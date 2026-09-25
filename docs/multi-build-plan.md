**Implementation plan: separate extension builds**

Status: implemented on `feat-multi-build`. The original design below is retained for context; the current source layout, verification results, and implementation limits are recorded in [build-editions.md](build-editions.md).

Produce four VSIX packages from one source tree and one version:

| Package suffix | Command implementation | Search implementation |
| --- | --- | --- |
| `no-commands` | Absent | Absent |
| `safe-list` | Regex-constrained execution | Absent |
| `commands` | General command execution | Absent |
| `advanced` | General command execution | Dedicated `web_search` |

The four-package scope follows the revised proposal. Keep capability composition extensible enough to add the other two combinations later, but do not ship six packages in this implementation.

**Behavior fixed by the latest request**

- Commands require approval by default.
- Safe list exposes one “Auto-approve safe commands” switch. When enabled in Act mode, every matching command receives identical approval treatment, including `rm`, `rmdir`, and `mkdir`. There is no deletion-specific approval exception.
- A command outside the safe list fails before execution and returns a useful tool error. An individual approval cannot override a failed safe-list check.
- The effective regex list is included in the Safe list system prompt. It is absent from the other builds.
- The safe list is editable through actual user settings from the Settings tab. Workspace files cannot grant command permissions.
- Existing Plan mode excludes command execution. Existing Review mode continues to require explicit approval for every command, uniformly, even when Act mode auto-approval is enabled.
- Unavailable implementations must be absent from shipped bundles, schemas, settings, prompts, UI handlers, and dependencies. Hiding or disabling their controls is insufficient.

Lack of sudo is not a workspace boundary: an ordinary user can delete files outside the workspace when filesystem permissions allow it. Child processes also inherit the extension host's privileges. Preserve explicit workspace checks for the constrained built-ins; do not claim an OS sandbox or rely on permission errors to prevent damage. [Linux deletion permission rules](https://man7.org/linux/man-pages/man2/unlink.2.html)

**Planning assumptions open to review**

- Ship alternative installations under the existing extension ID, preserving chats and existing shared settings when switching packages. Show the selected edition in its display name and Settings tab. Supporting simultaneous installations would require separate IDs and namespaced commands, views, settings, and storage; it is outside this plan.
- Start Advanced search with a user-configured SearXNG endpoint. The provider was not selected explicitly, so this is a proposed initial choice, not a settled requirement. The provider interface permits replacing this with Brave before implementation without changing tool behavior or the build boundaries.
- Preserve fixed, user-triggered Git UI features through VS Code's Git extension API, without shipping a subprocess helper in No commands. VS Code itself can still run Git; the guarantee concerns this extension's packaged execution capability and model-accessible tools.

1. **Establish build-time composition and dependency boundaries.**

   Files: `esbuild.config.mjs`, new `scripts/build-profiles.mjs`, new `src/build/contracts.ts` and `src/build/profiles/{noCommands,safeList,commands,advanced}/` modules, `tsconfig.json`.

   - Define the four profiles in build tooling. Select exactly one profile for each extension-host, chat-webview, and settings-webview build. Reject unknown or missing profiles in packaging; never silently substitute a more capable edition.
   - Resolve a stable profile import to the selected module before bundling. Give TypeScript a type-only contract for the selected imports. Shared application code must not import a runtime table containing all four editions.
   - Keep schemas, execution handlers, settings contributions, prompt fragments, rendering hooks, styles, and network additions owned by their feature modules. Separate host and browser entry modules so a webview cannot import an executor.
   - Make No commands contribute no command tools. Do not provide a `run_command` stub, throwing executor, dormant branch, or dynamic import of a command module.
   - Let Commands and Advanced intentionally share the general-command implementation. Safe list gets its own checked execution entry points and excludes the general shell runner. Only command-capable editions import shared process lifecycle code.
   - Enable esbuild metadata for every entry bundle. Add an import-resolution guard that fails builds on forbidden cross-profile imports, including transitive dependencies. Keep this metadata outside shipped packages.

   esbuild can redirect selected imports during resolution; this permits excluding other implementations before they enter the bundle graph. Dead-code elimination is an additional optimization, not the separation mechanism. [esbuild resolution hooks](https://esbuild.github.io/plugins/#on-resolve)

2. **Extract command capabilities from shared session and tool code.**

   Files: `src/tools/toolDefinitions.ts`, `src/tools/forbiddenTools.ts`, `src/tools/terminalTool.ts`, `src/chat/session.ts`, `src/llm/parser/gemma4.ts`, `src/ui/commandDisplay.ts`; new `src/features/commands/{shared,full,safeList}/` modules.

   - Split common tool definitions from command definitions. Build the actual registry from common tools and the selected profile, then apply mode, transport, memory, and vision filtering.
   - Extract command classification, argument preparation, launch, job tracking, wait/stop, cancellation, and command-specific error formatting from `ChatSession` into command feature handlers. Shared dispatch invokes registered handlers without naming absent tools.
   - Remove the global forbidden-name list's references to optional tools. Unknown tools receive a generic unavailable-tool error; available-tool lists in errors come from the current mode's registry.
   - Preserve existing transport compatibility: legacy calls use `run_command`; native calls use `run_process`. Both are absent from No commands. Both routes in Safe list must use the same safe-list policy, with no bypass through native calls or compatibility recovery.
   - Keep `wait_process` and `stop_process` only in command-capable builds. They operate only on previously authorized jobs belonging to the current chat; they cannot start commands or attach to arbitrary processes.
   - Derive parser recognition and repair examples from the actual registry. Legacy syntax recovery must not reintroduce tools omitted by the build or mode.
   - Bind approval to the exact prepared command, workspace, and arguments. Immediately before launch, recheck current policy and workspace identity; a stale approval or settings change cannot authorize a different operation.

3. **Implement the regex safe list and uniform approval behavior.**

   Files: new `src/features/commands/safeList/{settings,defaults,policy,commandSyntax,executor,prompt}.ts`, shared command interfaces, `src/tools/workspaceGuard.ts` where existing path checking can be reused.

   - Add `localLlmHarness.safeCommandPatterns`, an array of regex-source strings, and `localLlmHarness.autoapproveSafeCommands`, defaulting to `false`. These settings exist only in the Safe list package. An explicit empty array allows no commands; defaults apply only when the setting is absent.
   - Match the entire candidate command against at least one pattern, case-sensitively, without regex flags. Do not permit a partial match to authorize a trailing operation. Invalid configuration fails closed with a settings error; it must not fall back to broader defaults.
   - Give regex matching a bounded execution budget, using an isolated worker with a timeout for user-supplied JavaScript regexes. Limit pattern count, pattern length, and command length. Malformed or pathological expressions must not block the extension host.
   - Define one lossless canonical command representation from executable plus arguments. Use it for regex matching, approval display, model error feedback, and native/legacy consistency. Do not use the current unquoted `args.join(" ")` display as an authorization representation. Document quoting and whitespace normalization beside the settings and in the Safe list prompt.
   - For `run_command`, parse a deliberately limited single-command grammar with literal arguments and quoting. Reject shell operators, substitutions, redirections, environment assignments, and additional commands. Execute the prepared program and argument vector without a shell. Native `run_process` enters the same validation path directly. Literal punctuation inside an argument must remain literal.
   - Resolve executables consistently from a trusted search path; exclude workspace executables and workspace entries in PATH from the default policy. Block elevation wrappers in Safe list. Do not fall back to a shell for Windows batch files; report unsupported invocations clearly.
   - Supply conservative default regexes for `grep`/`rg`, `mkdir`, `rmdir`, `rm`, and selected read-only Git forms such as `status`, `diff`, `log`, `show`, `ls-files`, and `branch -a`. Restrict accepted flags and subcommand combinations; do not use broad defaults such as `git .*` or `rm .*`.
   - Allow matched workspace deletion using exactly the same approval switch as other commands. Defaults allow explicit file deletion and empty-directory removal; recursive/force forms require adding corresponding patterns. Do not add per-command approval categories.
   - For built-in filesystem commands, validate every path-bearing operand and option, resolve symlinks, and keep targets within the active workspace. Protect the workspace root and Git metadata against deletion. For recursive operations explicitly enabled by the user, check traversal behavior and refuse paths whose containment cannot be established. Revalidate immediately before execution; document that this is not race-proof OS isolation against other local processes.
   - For built-in Git forms, restrict repository selection and options; suppress external diff/text conversion, pagers, configured execution helpers, and lazy fetching. Account for installed Git/platform support and fail closed when required controls are unavailable. Prevent regex additions from silently disabling built-in path constraints.
   - Apply regex policy first, then the uniform approval decision. In Act mode, a match prompts when auto-approval is off and executes when it is on. In Review mode, a match always prompts. A mismatch always returns an error without launching or offering an override.
   - Custom patterns can deliberately admit other programs such as `curl`; describe this as user-authorized expansion, not a guarantee that every matched program is harmless or local. An admitted interpreter or project script can run further code. The regex list is a command policy, not an OS sandbox.

   Built-in path and Git checks complement the requested regex list; regexes alone cannot establish real filesystem containment or suppress program-specific side effects. Git documents the relevant [diff helper controls](https://git-scm.com/docs/git-diff) and [lazy-fetch control](https://git-scm.com/docs/git).

4. **Make prompts, settings, and both webviews profile-specific.**

   Files: `src/llm/prompt.ts`, `src/config/settings.ts`, `src/ui/messaging.ts`, `src/ui/sideView/provider.ts`, `src/ui/sideView/webview/main.ts`, `src/ui/chatView/provider.ts`, `src/ui/chatView/webview/{main,workLabels,toolHistory}.ts`, `media/chat.css`, `media/side.css`; selected feature UI and CSS modules.

   - Compose prompts from common guidance, current-mode guidance, and selected feature fragments. Remove blanket offline claims and lists of absent tools. Keep command workflow examples and instructions only in command-enabled modes and builds.
   - Include the exact effective safe-list patterns and matching semantics only in Safe list modes that expose commands. Keep this section synchronized with runtime policy and context-token accounting. Quote the settings as configuration data, not additional free-form instructions.
   - Invalidate cached prompts and tool payloads when the safe list changes. Validate calls against the latest policy even while an older model response or approval is pending.
   - Keep native schemas, legacy declarations/examples, mode restrictions, and tool error messages consistent for every supported model compatibility profile.
   - Rename the Safe list switch to “Auto-approve safe commands”; retain “Auto-approve commands” in Commands and Advanced; omit command settings and their handlers from No commands. Never migrate a general-command auto-approval value into Safe list's new setting.
   - Make “Edit User Settings” open user JSON. Seed editable safe-list defaults only when absent and only for Safe list. Read permissions from user-level configuration, ignoring workspace/folder/language overrides. Preserve a separate route for existing workspace prompt customization.
   - Move command cards, stop actions, process events, command labels, and feature-specific CSS into selected command UI modules. Move search settings/results into Advanced-only modules. Maintain the existing common card and link styling.
   - Preserve historical chats when switching packages. Unknown historical tools use the existing generic card/data presentation with no live execution, stop, retry, or approval action. Historical tool names stored as user data do not justify bundling their implementations.
   - Update shared protocol types for new messages. Only selected host/webview handlers accept optional-feature operations; forged or stale messages cannot activate absent capabilities.

5. **Remove indirect subprocess dependencies from common UI features.**

   Files: `src/scm/commitMessage.ts`, `src/ui/chatView/provider.ts`, `src/util/exec.ts`; new narrow `src/scm/gitApi.ts` adapter.

   - Replace direct `execFileUtf8` usage for staged-change detection, staged diffs, and HEAD content with fixed methods/data from the built-in VS Code Git API.
   - Keep commit-message generation user-triggered and restrict the adapter to specific read operations. It must expose no arbitrary executable, command, shell, or user-selected VS Code command API to the model.
   - Remove the direct-Git fallback. If the built-in Git extension is unavailable, show a clear unavailable message for commit generation and use existing captured edit snapshots where possible for diff review; never fabricate an empty baseline for an unknown failure.
   - Remove `src/util/exec.ts` when no longer referenced. Verify that the complete No commands host bundle has no `child_process` import or subprocess implementation, including transitive dependencies.
   - Test repository selection, nested repositories, staged changes, missing HEAD, and unavailable Git API behavior. Verify the API surface against the minimum supported VS Code version, not just the current installation.

   The Git API exposes repository state, staged diff retrieval, and fixed revision reads, allowing these user-facing features without a packaged generic subprocess helper. [VS Code Git API definitions](https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts)

6. **Implement Advanced-only web search.**

   Files: new `src/features/webSearch/{definition,executor,provider,searxng,settings,prompt,ui}.ts`, `src/network/safeFetch.ts`, selected network-policy modules and Advanced settings/protocol contributions.

   - Define `web_search({ query, count? })` only for Advanced, returning bounded titles, HTTP(S) URLs, snippets, and available dates. Start with a small default result count and strict query/result/response-size limits.
   - Use a provider interface, with SearXNG as the provisional first implementation. Require a user-configured endpoint whose instance enables JSON search. Do not depend on a random public instance or embed a shared credential. [SearXNG API](https://docs.searxng.org/dev/search_api.html)
   - Send only the proposed query and necessary search options. Display the query for approval before network access by default; use a dedicated search approval category rather than auto-approving through file-read or command settings. Do not add a search auto-approval switch in the initial scope.
   - Permit search in Act, Review, and Plan modes of Advanced because it is a research operation; the search approval rule is identical in all three. Treat source contents as untrusted reference data and ground citations in returned URLs.
   - Preserve `safeFetch.ts` as the only HTTP primitive. Separate its common bounded transport from selected authorization policies: every build retains the exact local/LAN model endpoint policy; only Advanced imports the additional configured search-origin policy.
   - Do not turn the model endpoint setting into a general outbound allowlist. Reject cross-origin redirects, unexpected protocols, credential-bearing URLs, and response overflows. The model chooses a query, not the request destination. Keep requests in the extension host, with cancellation/timeouts and redacted errors.
   - Keep third-party search results from initiating additional requests through remote images, favicons, HTML, or automatic page fetching. Return text and escaped links in the shared tool-card style.
   - In Advanced, contribute the tool only when its provider is configured; surface configuration failures in the Advanced settings. Other editions contain no search schema, provider, settings, UI, or additional network-policy implementation.
   - If Brave is selected instead, implement its structured search endpoint and keep the key in VS Code SecretStorage. The model never receives the key. [Brave search API](https://api-dashboard.search.brave.com/app/documentation/web-search)
   - Keep full-page browsing and `read_web_page` outside this implementation. Search snippets must not be represented as having read an entire page. A locally hosted SearXNG instance still sends web queries to external engines.

7. **Package isolated outputs and update distribution.**

   Files: `scripts/package-vsix.mjs`, `scripts/build-profiles.mjs`, `esbuild.config.mjs`, `package.json`, `.vscodeignore`, `.gitignore`, `.github/workflows/{vsix,release}.yml`, `README.md`, `AGENTS.md`; generated profile-specific manifests/readmes.

   - Make `npm run package:vsix` build, verify, and package all four editions. Keep an explicit single-profile option for development. Default local development to the existing Commands behavior; packaging always names its profile explicitly.
   - Build into separate clean staging directories, including separate host and both webview bundles. Generate manifests with only the selected edition's configuration contributions, title, and description.
   - Copy only the selected compiled output, selected styles, shared assets/fonts, edition-specific documentation, and required licenses. Exclude source, maps, build metadata, tests, other stage directories, local state, and prior VSIX files.
   - Ensure VSCE's prepublish hook cannot rebuild the default edition over a selected staging directory. Make prepublish profile-aware or omit the hook in the already-built staged manifest.
   - Write `local-llm-harness-<version>-no-commands.vsix`, `...-safe-list.vsix`, `...-commands.vsix`, and `...-advanced.vsix` into a dedicated artifact directory. Publish only the exact four artifacts from the current successful run.
   - Make the all-profile packaging operation fail if any build, policy audit, archive audit, or package step fails. Do not report partial output as a complete release.
   - Update CI artifact upload and release upload paths. Keep generated binaries out of source control. Document installation replacement behavior, approval defaults, regex syntax, search setup, and the actual scope of the locality claims.
   - Add contributor rules requiring build-time capability ownership and archive-level isolation checks when introducing optional tools. Keep existing visual requirements unchanged.

8. **Prove behavior and package isolation before handoff.**

   Files: existing `test/{session,prompt,parsers,settings,terminalTool,commitMessage,chatProviderFiles,safeFetch}.test.ts`; new `test/{buildProfiles,safeCommands,webSearch,profileUi}.test.ts`, new `scripts/verify-build-isolation.mjs`.

   - Test all four editions against Act, Plan, and Review modes and all supported tool transports. Check exposed schemas, prompt text/examples, actual dispatch, UI settings, parser recovery, and unavailable-tool errors.
   - Test the approval matrix uniformly with read commands, creation, and deletion: default prompt; matched auto-approved command; unmatched failure even with auto-approval on; rejection; cancellation; changed policy/workspace during approval. No real destructive commands run against user files.
   - Test full-string regex matching, empty/invalid lists, timeout behavior, quoting, spaces, multiple arguments, newlines, shell operators/substitution, native/legacy equivalence, Windows syntax, path traversal, symlinks, executable shadowing, dangerous flags, Git helpers, and lazy fetch behavior. Use temporary fixture workspaces.
   - Test search configuration, approval, query forwarding, result escaping, limits, cancellation, timeout, malformed responses, provider errors, and redirects. Assert that model endpoint restrictions remain unchanged in every edition. Use mocked HTTP for automated tests.
   - Test old chat loading in every edition and stale/forged webview messages. Missing features must not gain an execution path through restored data, process controls, or protocol compatibility.
   - Audit every bundle's input graph and emitted imports; fail if a forbidden module was resolved, even if optimization later removed it. Deliberately inject forbidden imports in build fixtures to prove the guards work.
   - Unpack the actual VSIX archives and inspect their contents, manifests, entry bundles, dynamic chunks, assets, and documents. Exclude maps/embedded source and stale cross-build outputs. Supplement module checks with feature-specific emitted-symbol/string checks; do not mistake arbitrary user-history text or unrelated syntax-highlighter tokens for executable capability.
   - Prove these package invariants: No commands has no command schema/handler/job manager/UI/settings or subprocess import; Safe list has no unchecked shell executor or search implementation; Commands has no safe-list or search implementation/settings/prompt; Advanced has no safe-list implementation/settings/prompt.
   - Smoke-test the packaged extensions with a mocked VS Code host, then manually install each in an isolated VS Code profile. Check both webviews, approval controls, restored chats, Git UI behavior, command results, and Advanced search. Check light/dark themes for changed settings/tool surfaces.
   - Run `npm run typecheck`, `npm run lint`, `npm run build`, the full `npm test` suite, all-profile packaging with isolation audits, and `git diff --check`. Record the four artifact names and verification results at handoff.

Completion requires all four final archives to pass the isolation audit. A runtime-disabled feature, an unused executor still present in a bundle, or a package that accidentally contains another edition's files does not satisfy the request.
