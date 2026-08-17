# Local LLM Harness contributor guide

This file applies to the entire repository.

## Visual language

- Use the chat composer as the reference for interactive surfaces: a subtle filled surface, no visible gray/white border, and no blue focus ring.
- Pill buttons, text fields, selects, switches, queued messages, and inline editors must use transparent borders so focus or state changes do not alter layout.
- Communicate hover, focus, active, and selected states through `--surface-fill` / `--surface-fill-strong`, foreground color, and existing semantic fills. Do not introduce outline strokes for those states.
- Keep icon-only actions circular. Destructive actions use the existing translucent error fill and error foreground, without a colored border.
- Visible borders are reserved for structural content boundaries where grouping matters, such as section separators, tool output surfaces, diffs, and timelines. Do not use them as decoration around controls.
- Prefer VS Code theme variables and `color-mix()` over fixed colors. Check both light and dark themes when changing UI styles.
- Keep shared visual behavior consistent between `media/chat.css` and `media/side.css`.

## Coding guidelines

- Keep TypeScript strict and update the shared protocol types in `src/ui/messaging.ts` whenever webviews and extension-host providers exchange a new message.
- Treat the extension host as the source of truth for state that must survive webview rerenders or reloads; webview state may be used for immediate optimistic feedback.
- Scope chat storage operations to the active workspace. Confirm destructive bulk operations and refresh every affected view afterward.
- Preserve the guarded network boundary: use `src/network/safeFetch.ts`; do not call `fetch` or import another HTTP client directly.
- Edit source files under `src/` and styles under `media/`. Do not hand-edit generated files in `dist/`.
- Reuse existing icons, surface variables, rendering helpers, and storage methods before adding parallel implementations.
- Keep unrelated user changes intact and avoid broad formatting rewrites.

## Verification

- Run `npm run typecheck`, `npm run lint`, and `npm run build` after implementation changes.
- Run the relevant targeted Vitest file for changed behavior; run `npm test` when the change crosses multiple subsystems.
- Run `git diff --check` before handoff.
