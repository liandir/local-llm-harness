/**
 * Message types exchanged between the extension host and each webview.
 * Kept in one file so both sides import the same definitions.
 */
import type { UiEvent } from "../chat/session.js";
import type { ChatAttachment } from "../chat/storage.js";
import type { ReasoningEffort, ReasoningEfforts } from "../chat/reasoningEffort.js";

// --- Side view (welcome / chats / settings) ---

export type SideTab = "welcome" | "chats" | "settings";

export type SideToExt =
  | { type: "ready" }
  | { type: "newChat" }
  | { type: "openChat"; id: string }
  | { type: "deleteChat"; id: string }
  | { type: "clearChats" }
  | { type: "openTab"; tab: SideTab }
  | { type: "openGithub" }
  | { type: "saveSetting"; key: string; value: unknown }
  | { type: "validateEndpoint"; url: string }
  | { type: "editUserSettingsJson" }
  | { type: "restoreDefaultGeneratedPrompts" }
  | { type: "restoreDefaultSafeCommands" }
  | { type: "resetAllDefaults" };

export type ExtToSide =
  | { type: "settings"; settings: Record<string, unknown> }
  | { type: "appInfo"; version: string }
  | { type: "chats"; chats: { id: string; title: string; updatedAt: number }[] }
  | { type: "focusTab"; tab: SideTab }
  | { type: "endpointValidation"; ok: boolean; error?: string; resolved?: string[]; metadata?: { modelAlias: string; contextSize: number }; models?: { id: string }[]; selectedModel?: string }
  | { type: "settingSaved"; key: string; ok: boolean; error?: string }
  | { type: "openTabs"; tabs: { id: string; title: string }[] };

// --- Chat view ---

export type ChatToExt =
  | { type: "ready" }
  | { type: "send"; text: string; attachmentId?: string }
  | { type: "queueMessage"; id: string; text: string; attachmentId?: string }
  | { type: "updateQueuedMessage"; id: string; text: string }
  | { type: "removeQueuedMessage"; id: string }
  | { type: "editMessage"; messageTs: number; text: string; removeAttachment?: boolean }
  | { type: "selectAttachment" }
  | { type: "pasteAttachment"; fileName: string; mimeType: string; dataUrl: string }
  | { type: "discardAttachment"; attachmentId: string }
  | { type: "forkChat"; throughUserMessageTs: number }
  | { type: "openChat"; id: string }
  | { type: "cancel" }
  | { type: "approveTool"; toolId: string; approved: boolean }
  | { type: "answerQuestion"; toolId: string; answer: string }
  | { type: "stopProcess"; jobId: string }
  | { type: "setPlanMode"; on: boolean }
  | { type: "setReasoningEffort"; effort: ReasoningEffort }
  | { type: "compactNow" }
  | { type: "compactInterruptAndRun" }
  | { type: "newChat" }
  | { type: "openChats" }
  | { type: "openSettings" }
  | { type: "acceptPlan" }
  | { type: "openFile"; path: string; line?: number }
  | { type: "reviewFile"; path: string }
  | { type: "reviewProposedFile"; path: string; content: string }
  | { type: "reviewWorkspaceChanges" }
  | { type: "requestToolDiff"; toolId: string }
  | { type: "renameChat"; title: string }
  | { type: "deleteCurrent" };

export type ExtToChat = UiEvent
  | { type: "settings"; planMode: boolean; reasoningEffort: ReasoningEffort; reasoningEfforts: ReasoningEfforts; showThinking: boolean; autoCompact: boolean; autoCompactThresholdPercent: number; workspaceRoot?: string }
  | { type: "attachmentSelected"; attachment: UiAttachment }
  | { type: "attachmentPasteFailed"; error: string }
  | { type: "attachmentCleared" }
  | { type: "messageQueue"; messages: { id: string; text: string; attachment?: UiAttachment }[] }
  | { type: "recentChats"; chats: { id: string; title: string; updatedAt: number }[] };

export type UiAttachment = ChatAttachment & { previewUri: string };
