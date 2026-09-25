import type { SideToExt } from "../ui/messaging.js";
export interface SideFeature {
  label: string;
  render(settings: Record<string, unknown>, toggle: (id: string, label: string, checked: boolean) => string, escape: (value: string) => string): string;
  bind(root: HTMLElement, send: (message: SideToExt) => void): void;
}
