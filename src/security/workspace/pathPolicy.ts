import * as path from "node:path";
import { WorkspaceSecurityError } from "./errors.js";

const MAX_RELATIVE_PATH_LENGTH = 4096;
export const MAX_WORKSPACE_PATH_DEPTH = 128;

export interface ParsedWorkspacePath {
  /** Native-separator relative path; empty only when the workspace root is allowed. */
  readonly relativePath: string;
  /** Stable slash-separated representation for display, comparison, and glob results. */
  readonly displayPath: string;
  readonly parts: readonly string[];
}

/**
 * Parse an untrusted path without consulting the filesystem.
 *
 * Both POSIX and Windows absolute/path-alias forms are rejected on every host,
 * so a chat created on one operating system cannot become dangerous when moved
 * to another. `..`, ADS/device syntax, ambiguous trailing dots/spaces, control
 * characters, and Windows reserved device names are rejected fail-closed.
 */
export function parseWorkspacePath(requested: string, allowRoot = false): ParsedWorkspacePath {
  if (typeof requested !== "string") {
    throw invalidPath("Workspace path must be a string.");
  }
  if (requested.length > MAX_RELATIVE_PATH_LENGTH) {
    throw invalidPath(`Workspace path exceeds ${MAX_RELATIVE_PATH_LENGTH} characters.`);
  }
  if (containsControlCharacter(requested)) {
    throw invalidPath("Workspace path contains a control character.");
  }

  if (requested.includes("\\")) {
    throw invalidPath("Backslashes are not allowed; use forward slashes in workspace paths.");
  }
  const slashPath = requested;
  if (
    path.posix.isAbsolute(slashPath) ||
    path.win32.isAbsolute(requested) ||
    /^[A-Za-z]:/.test(requested) ||
    slashPath.startsWith("//")
  ) {
    throw invalidPath("Absolute, drive-relative, UNC, and device paths are not allowed.");
  }
  // A colon is an NTFS alternate-data-stream separator. Reject it on every
  // platform so a persisted path has one meaning across supported hosts.
  if (requested.includes(":")) {
    throw invalidPath("Colons and alternate data stream paths are not allowed.");
  }

  if (slashPath === "" || slashPath === ".") {
    if (!allowRoot) throw invalidPath("A file path must not name the workspace root.");
    return { relativePath: "", displayPath: "", parts: [] };
  }

  const rawParts = slashPath.split("/");
  const parts: string[] = [];
  for (const component of rawParts) {
    if (component === "") {
      throw invalidPath("Workspace path contains an empty component.");
    }
    if (component === "." || component === "..") {
      throw invalidPath("Dot and parent traversal components are not allowed.");
    }
    if (component.endsWith(".") || component.endsWith(" ")) {
      throw invalidPath("Path components ending in a dot or space are not allowed.");
    }
    if (isWindowsDeviceName(component)) {
      throw invalidPath(`Reserved device path component is not allowed: ${component}.`);
    }
    parts.push(component);
  }
  if (parts.length > MAX_WORKSPACE_PATH_DEPTH) {
    throw invalidPath(`Workspace path exceeds ${MAX_WORKSPACE_PATH_DEPTH} components.`);
  }
  return {
    relativePath: path.join(...parts),
    displayPath: parts.join("/"),
    parts
  };
}

/** Parse and normalize a glob while preserving `*`, `**`, and `?` tokens. */
export function parseWorkspaceGlob(pattern: string): { displayPattern: string; regex: RegExp } {
  if (typeof pattern !== "string" || pattern.length === 0) {
    throw invalidPath("Glob pattern must be a non-empty string.");
  }
  if (pattern.length > MAX_RELATIVE_PATH_LENGTH) {
    throw invalidPath(`Glob pattern exceeds ${MAX_RELATIVE_PATH_LENGTH} characters.`);
  }
  if (containsControlCharacter(pattern) || pattern.includes(":")) {
    throw invalidPath("Glob pattern contains a forbidden character.");
  }
  if (pattern.includes("\\")) {
    throw invalidPath("Backslashes are not allowed; use forward slashes in glob patterns.");
  }
  const slashPattern = pattern;
  if (
    path.posix.isAbsolute(slashPattern) ||
    path.win32.isAbsolute(pattern) ||
    /^[A-Za-z]:/.test(pattern) ||
    slashPattern.startsWith("//")
  ) {
    throw invalidPath("Absolute, drive-relative, UNC, and device glob patterns are not allowed.");
  }
  const normalized = slashPattern.startsWith("./") ? slashPattern.slice(2) : slashPattern;
  const parts = normalized.split("/");
  if (parts.length > MAX_WORKSPACE_PATH_DEPTH) {
    throw invalidPath(`Glob pattern exceeds ${MAX_WORKSPACE_PATH_DEPTH} components.`);
  }
  for (const component of parts) {
    if (component === "" || component === "." || component === "..") {
      throw invalidPath("Glob pattern contains an empty, dot, or parent traversal component.");
    }
    if (component.endsWith(".") || component.endsWith(" ")) {
      throw invalidPath("Glob components ending in a dot or space are not allowed.");
    }
  }
  return { displayPattern: normalized, regex: globToRegex(normalized) };
}

function globToRegex(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length;) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 2;
        if (pattern[index] === "/") index++;
      } else {
        source += "[^/]*";
        index++;
      }
    } else if (character === "?") {
      source += "[^/]";
      index++;
    } else {
      source += escapeRegex(character);
      index++;
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegex(character: string): string {
  return /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character;
}

function isWindowsDeviceName(component: string): boolean {
  // Win32 device parsing also tolerates spaces/dots between the reserved stem
  // and an extension (for example `CON .txt`). Normalize that stem before the
  // cross-platform rejection check.
  const base = component.split(".", 1)[0].replace(/[ .]+$/u, "").toUpperCase();
  return /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/u.test(base);
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function invalidPath(message: string): WorkspaceSecurityError {
  return new WorkspaceSecurityError("INVALID_PATH", message);
}
