/**
 * Message types exchanged between the extension host and each webview.
 * Kept in one file so both sides import the same definitions.
 */
import type { UiEvent } from "../chat/session.js";

// --- Side view (welcome / chats / settings) ---

export type SideTab = "welcome" | "chats" | "settings";

export type SideToExt =
  | { type: "ready" }
  | { type: "newChat" }
  | { type: "openChat"; id: string }
  | { type: "deleteChat"; id: string }
  | { type: "openTab"; tab: SideTab }
  | { type: "saveSetting"; key: string; value: unknown }
  | { type: "validateEndpoint"; url: string }
  | { type: "editSafeCommandsJson" };

export type ExtToSide =
  | { type: "settings"; settings: Record<string, unknown> }
  | { type: "chats"; chats: { id: string; title: string; updatedAt: number }[] }
  | { type: "focusTab"; tab: SideTab }
  | { type: "endpointValidation"; ok: boolean; error?: string; resolved?: string[] }
  | { type: "settingSaved"; key: string; ok: boolean; error?: string }
  | { type: "openTabs"; tabs: { id: string; title: string }[] };

// --- Chat view ---

export type ChatToExt =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "cancel" }
  | { type: "approveTool"; toolId: string; approved: boolean }
  | { type: "togglePlanMode" }
  | { type: "compactNow" }
  | { type: "compactInterruptAndRun" }
  | { type: "newChat" }
  | { type: "openChats" }
  | { type: "openSettings" }
  | { type: "setAutoApproveWrites"; on: boolean }
  | { type: "acceptPlan" }
  | { type: "openFile"; path: string }
  | { type: "reviewFile"; path: string }
  | { type: "reviewWorkspaceChanges" }
  | { type: "renameChat"; title: string }
  | { type: "deleteCurrent" };

export type ExtToChat = UiEvent | { type: "settings"; autoapproveWrites: boolean; planMode: boolean };
