import type {
  ChatCompletionRequest,
  LlmStreamChunk
} from "../../llm/client.js";
import type { ModelFamily } from "../../llm/parser/index.js";
import type { HarnessSettings } from "../../config/settings.js";
import type { ChatRecord } from "../storage.js";

/** A minimal disposable contract which does not couple session code to VS Code. */
export interface PortSubscription {
  dispose(): void;
}

/** All model I/O used by a session. Every potentially blocking call is cancellable. */
export interface LlmPort {
  streamChat(
    endpoint: string,
    request: ChatCompletionRequest,
    signal: AbortSignal
  ): AsyncIterable<LlmStreamChunk>;
  complete(
    endpoint: string,
    request: ChatCompletionRequest,
    signal: AbortSignal
  ): Promise<string>;
  fetchServerContextSize(endpoint: string, signal: AbortSignal): Promise<number | undefined>;
  tokenize(endpoint: string, text: string, signal: AbortSignal): Promise<number>;
}

export interface ChatListEntry {
  id: string;
  title: string;
  updatedAt: number;
}

/**
 * Persistence owned by the extension, outside the model-controlled workspace.
 * Implementations must complete atomically or reject; cancellation must not
 * leave a partially written record.
 */
export interface ChatStoragePort {
  ensureReady(signal: AbortSignal): Promise<void>;
  list(signal: AbortSignal): Promise<readonly ChatListEntry[]>;
  load(id: string, signal: AbortSignal): Promise<ChatRecord | undefined>;
  save(record: ChatRecord, signal: AbortSignal): Promise<void>;
  delete(id: string, signal: AbortSignal): Promise<void>;
  deleteEmpty(exceptId: string | undefined, signal: AbortSignal): Promise<void>;
  newRecord(modelFamily: ModelFamily): ChatRecord;
}

export interface WorkspaceReadRequest {
  /** Untrusted, workspace-relative path. Absolute and escaping paths must be rejected. */
  path: string;
  /** Optional one-based inclusive range. */
  startLine?: number;
  endLine?: number;
}

export interface WorkspaceReadResult {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
}

export interface WorkspaceEntry {
  name: string;
  type: "file" | "directory" | "other";
}

export interface WorkspaceWriteResult {
  bytesWritten: number;
  previous?: string;
  next: string;
  /** True only when this operation published a previously missing file. */
  created?: boolean;
  /** Compatibility notes for whole-line edit normalization. */
  addedLeadingBreak?: boolean;
  addedTrailingBreak?: boolean;
}

/**
 * The sole capability through which session code may access the selected
 * workspace. Every method must independently validate containment immediately
 * before I/O; a successful earlier call is not authority for a later call.
 *
 * Mutation methods enforce filesystem safety only. Their caller remains
 * responsible for binding execution to an approved proposal.
 */
export interface WorkspacePort {
  /** Canonical root selected for this session; immutable for the port lifetime. */
  readonly root: string;
  readFile(request: WorkspaceReadRequest, signal: AbortSignal): Promise<WorkspaceReadResult>;
  listDirectory(path: string, signal: AbortSignal): Promise<readonly WorkspaceEntry[]>;
  glob(pattern: string, maxResults: number | undefined, signal: AbortSignal): Promise<readonly string[]>;
  writeFile(path: string, content: string, signal: AbortSignal): Promise<WorkspaceWriteResult>;
  insertText(path: string, line: number, text: string, signal: AbortSignal): Promise<WorkspaceWriteResult>;
  replaceRange(
    path: string,
    startLine: number,
    endLine: number,
    content: string,
    signal: AbortSignal
  ): Promise<WorkspaceWriteResult>;
}

export interface CommandRequest {
  /** Stable user-configured policy identifier, never executable command text. */
  ruleId: string;
  executable: string;
  args: readonly string[];
  /** Optional workspace-relative working directory. */
  cwd?: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export type CommandAvailability =
  | { available: true; backend: string }
  | { available: false; reason: string };

/** Structured, shell-free command execution supplied by a verified sandbox backend. */
export interface CommandPort {
  availability(signal: AbortSignal): Promise<CommandAvailability>;
  execute(request: CommandRequest, signal: AbortSignal): Promise<CommandResult>;
}

/** Settings access without a dependency on the VS Code configuration API. */
export interface SettingsPort {
  read(): Readonly<HarnessSettings>;
  onDidChange(listener: () => void): PortSubscription;
}

/** Wall-clock dependency for persisted timestamps and user-visible durations. */
export interface ClockPort {
  now(): number;
}

/**
 * Identifier source for transcript/UI/proposal correlation. Implementations
 * used for approval proposal IDs must be backed by a cryptographically secure
 * random generator.
 */
export interface IdPort {
  next(prefix?: string): string;
}
