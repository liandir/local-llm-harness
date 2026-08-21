/* eslint-disable no-control-regex -- matching terminal control sequences is the purpose of this helper */

/**
 * Convert terminal-oriented output into safe plain text for chat and model
 * context. This removes CSI styling/cursor commands, OSC hyperlinks/titles,
 * other ANSI string controls, and non-printing C0 controls while preserving
 * tabs and line breaks. Incomplete trailing sequences are hidden from live
 * snapshots until the next process chunk completes them.
 */
export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1B\][\s\S]*?(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B[PX^_][\s\S]*?\x1B\\/g, "")
    .replace(/(?:\x1B\[|\x9B)[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B(?:[ -/][@-~]|[@-_])/g, "")
    .replace(/\x1B(?:\][^\x07]*|\[[0-?]*[ -/]*)?$/g, "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g, "");
}
