import type { ChatFeature } from "../../../build/chatContracts.js";
import { toolCommandText } from "../../../ui/commandDisplay.js";
import { sanitizeTerminalText } from "../../../util/terminalText.js";

const names = ["run_command", "run_process", "wait_process", "stop_process"];
const starts = ["run_command", "run_process"];
export const chatFeature: ChatFeature = {
  activityClass: card => card.processRunning && starts.includes(card.toolName) ? " process-running" : "",
  formatResult: (card, text) => names.includes(card.toolName) ? sanitizeTerminalText(text) : undefined,
  renderHeader(card, args, code, escape, icon, error) {
    const command = chatFeature.operation?.(card, args);
    return command ? code(command, "bash", "$ ", error ? "" : chatFeature.actions?.(card, escape, icon)) : "";
  },
  recognizes: name => names.includes(name),
  operation: (card, args) => names.includes(card.toolName) ? card.processCommand ?? toolCommandText(card.toolName, args) : "",
  ownsActivity: (name, running) => running && starts.includes(name),
  headerLabel: (card, active) => starts.includes(card.toolName)
    ? card.processRunning || (card.status === "executed" && active) ? "Running command" : chatFeature.commandLabel!(card.status) : undefined,
  commandLabel: status => ({ pending: "Run command", streaming: "Running command", approved: "Running command", executed: "Ran command", failed: "Command failed", rejected: "Command rejected" })[status],
  actions(card, escape, icon) {
    if (!names.slice(0, 3).includes(card.toolName) || !card.processJobId || !card.processRunning) return "";
    const label = card.processStopping ? "Stopping process" : "Stop process";
    return `<button class="copy-btn code-block-stop" type="button" data-feature-action="${escape(card.processJobId)}" data-tip="${label}" aria-label="${label}" ${card.processStopping ? "disabled" : ""}>${icon}</button>`;
  },
  click(target, cards, send) {
    const button = target.closest<HTMLElement>("[data-feature-action]");
    if (!button?.dataset.featureAction) return false;
    const id = button.dataset.featureAction;
    for (const card of cards) if (card.processJobId === id) card.processStopping = true;
    send({ type: "featureAction", id });
    return true;
  },
  event(event, cards) {
    if (event.kind !== "processJobState") return false;
    for (const card of cards) {
      if (card.toolId !== event.toolId && card.processJobId !== event.jobId) continue;
      card.processJobId = event.jobId;
      card.processRunning = event.running;
      card.processStopping = false;
      if (event.resultPreview) card.resultPreview = event.resultPreview;
    }
    return true;
  },
  icon: () => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <rect x="3.5" y="5" width="17" height="14" rx="3"/>
    <path d="m7.5 9.25 3 2.75-3 2.75"/>
    <path d="M13.5 15h3.5"/>
  </svg>`,
  active: { run_command: "Running command", run_process: "Running command", wait_process: "Checking process", stop_process: "Stopping process" },
  settled: { wait_process: "Checked process", stop_process: "Stopped process" },
  aliases: { run_command: "Run command", run_process: "Run command", wait_process: "Check process", stop_process: "Stop process" },
  subjects: { wait_process: "Process check" },
  groupLabel(name, count) {
    if (starts.includes(name)) return count === 1 ? "ran command" : "ran commands";
    if (name === "wait_process") return count === 1 ? "checked process" : "checked processes";
    if (name === "stop_process") return count === 1 ? "stopped process" : "stopped processes";
    return undefined;
  }
};
