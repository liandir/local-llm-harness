import type { ChatToExt } from "../ui/messaging.js";
import type { UiEvent } from "../chat/session.js";
export interface FeatureCard {
  toolId: string;
  toolName: string;
  status: "streaming" | "pending" | "approved" | "rejected" | "executed" | "failed";
  processCommand?: string;
  processJobId?: string;
  processRunning?: boolean;
  processStopping?: boolean;
  resultPreview?: string;
}
export interface ChatFeature {
  renderHeader?(card: FeatureCard, args: Record<string, unknown>, code: (text: string, language: string, prefix: string, actions?: string) => string, escape: (value: string) => string, icon: string, error?: boolean): string;
  formatResult?(card: FeatureCard, text: string): string | undefined;
  activityClass?(card: FeatureCard): string;
  renderResult?(card: FeatureCard, escape: (value: string) => string, separator: string): string | undefined;
  fullResult?(name: string): boolean;
  operation?(card: FeatureCard, args: Record<string, unknown>): string;
  recognizes?(name: string): boolean;
  ownsActivity?(name: string, running: boolean): boolean;
  headerLabel?(card: FeatureCard, active: boolean): string | undefined;
  actions?(card: FeatureCard, escape: (value: string) => string, icon: string): string;
  click?(target: HTMLElement, cards: FeatureCard[], send: (message: ChatToExt) => void): boolean;
  event?(event: UiEvent, cards: FeatureCard[]): boolean;
  icon?(): string;
  active?: Record<string, string>;
  settled?: Record<string, string>;
  aliases?: Record<string, string>;
  subjects?: Record<string, string>;
  groupLabel?(name: string, count: number): string | undefined;
  commandLabel?(status: FeatureCard["status"]): string;
}
