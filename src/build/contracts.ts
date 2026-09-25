import type { HarnessSettings } from "../config/settings.js";
import type { UiEvent } from "../chat/session.js";
import type { ChatToolProcess } from "../ui/messaging.js";

export interface FeatureContext {
  workspaceRoot: string;
  emit(event: UiEvent): void;
  appendResult(name: string, args: string, result: string, metadata: ChatToolProcess): Promise<unknown>;
}

export interface FeatureRuntime {
  tools: readonly string[];
  category(name: string): "command" | "process" | "search";
  needsApproval(settings: HarnessSettings): boolean;
  prepare(name: string, args: Record<string, unknown>, settings: HarnessSettings): Promise<ChatToolProcess>;
  execute(name: string, args: Record<string, unknown>, toolId: string, signal?: AbortSignal): Promise<{ result: string } & ChatToolProcess>;
  action?(id: string): Promise<void>;
  cancel?(): void;
  endTurn?(): Promise<void>;
}
