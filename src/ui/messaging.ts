/**
 * Message types exchanged between the extension host and each webview.
 * Kept in one file so both sides import the same definitions.
 */
import type { UiEvent } from "../chat/session.js";
import type { ThinkingMode } from "../chat/thinkingMode.js";

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
  | { type: "endpointValidation"; ok: boolean; error?: string; resolved?: string[]; metadata?: { modelAlias: string; contextSize: number } }
  | { type: "settingSaved"; key: string; ok: boolean; error?: string }
  | { type: "openTabs"; tabs: { id: string; title: string }[] };

// --- Chat view ---

export type ChatToExt =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "queueMessage"; id: string; text: string }
  | { type: "updateQueuedMessage"; id: string; text: string }
  | { type: "removeQueuedMessage"; id: string }
  | { type: "editMessage"; messageTs: number; text: string }
  | { type: "forkChat"; throughUserMessageTs: number }
  | { type: "openChat"; id: string }
  | { type: "cancel" }
  | { type: "approveTool"; toolId: string; approved: boolean }
  | { type: "answerQuestion"; toolId: string; answer: string }
  | { type: "setPlanMode"; on: boolean }
  | { type: "setThinkingMode"; mode: ThinkingMode }
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
  | { type: "settings"; planMode: boolean; thinkingMode: ThinkingMode; autoCompact: boolean; autoCompactThresholdPercent: number }
  | { type: "messageQueue"; messages: { id: string; text: string }[] }
  | { type: "recentChats"; chats: { id: string; title: string; updatedAt: number }[] };
