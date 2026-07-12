import type { Dirent } from "node:fs";
import { WorkspaceBoundary } from "./boundary.js";
import { WorkspaceSecurityError } from "./errors.js";
import { parseWorkspacePath } from "./pathPolicy.js";

const LEGACY_CHAT_DIRECTORY = ".local-llm-chats";
const MAX_LEGACY_CHAT_FILES = 10_000;
const CHAT_FILE_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/i;

export interface LegacyChatMigrationOptions {
  workspaceRoot: string;
  maxRecordBytes: number;
  /** Return true only after the record is durably published elsewhere. */
  publish(id: string, raw: string): Promise<boolean>;
}

/**
 * Migrate only the extension's historical UUID-named chat files through a
 * maintenance-only guarded capability. Linked directories/files, hardlinks,
 * malformed UTF-8, changes between read and delete, and oversized records all
 * fail closed. No arbitrary delete operation is exposed to model tools.
 */
export async function migrateLegacyWorkspaceChats(
  options: LegacyChatMigrationOptions,
  signal: AbortSignal = new AbortController().signal
): Promise<void> {
  const boundary = await WorkspaceBoundary.create(options.workspaceRoot, signal);
  const directory = parseWorkspacePath(LEGACY_CHAT_DIRECTORY, true);
  let entries: readonly Dirent[];
  try {
    entries = await boundary.readDirectory(directory, signal, MAX_LEGACY_CHAT_FILES);
  } catch (error) {
    if (error instanceof WorkspaceSecurityError && error.code === "PATH_NOT_FOUND") return;
    throw error;
  }

  for (const entry of entries) {
    signal.throwIfAborted();
    const match = CHAT_FILE_NAME.exec(entry.name);
    if (!match || !entry.isFile() || entry.isSymbolicLink()) continue;
    const recordPath = parseWorkspacePath(`${LEGACY_CHAT_DIRECTORY}/${entry.name}`);
    let snapshot;
    try {
      snapshot = await boundary.readFileSnapshot(
        recordPath,
        options.maxRecordBytes,
        false,
        signal
      );
    } catch {
      // One hostile/broken legacy file must not block other valid migrations.
      continue;
    }
    if (!await options.publish(match[1], snapshot.content)) continue;
    await boundary.removeExactSnapshot(recordPath, snapshot, signal);
  }
}
