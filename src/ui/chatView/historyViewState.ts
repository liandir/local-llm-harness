/** Presentation state only: live transcript content remains owned by the session. */
interface HistoryMessage {
  id: string;
  role: string;
  recordTs?: number;
  responseToTs?: number;
  parts: { kind: string; userExpanded?: boolean }[];
  toolCards: { toolId: string; expanded: boolean }[];
  workGroupExpanded?: Map<string, boolean>;
  fileChangesExpanded?: boolean;
  expandedFileChanges?: Set<string>;
}

interface MessageDisclosureState {
  workGroups: Map<string, boolean>;
  thoughts: (boolean | undefined)[];
  tools: Map<string, boolean>;
  fileChangesExpanded?: boolean;
  expandedFileChanges: Set<string>;
}

export type HistoryViewState = Map<string, MessageDisclosureState>;

function messageKey(message: HistoryMessage): string {
  const timestamp = message.role === "assistant" ? message.responseToTs : message.recordTs;
  return timestamp === undefined ? message.id : `${message.role}:${timestamp}`;
}

export function captureHistoryView(messages: HistoryMessage[]): HistoryViewState {
  return new Map(messages.map(message => [messageKey(message), {
    workGroups: new Map([...message.workGroupExpanded ?? []].map(([id, expanded]) => [id.slice(message.id.length), expanded])),
    thoughts: message.parts.filter(part => part.kind === "thought").map(part => part.userExpanded),
    tools: new Map(message.toolCards.map(tool => [tool.toolId, tool.expanded])),
    fileChangesExpanded: message.fileChangesExpanded,
    expandedFileChanges: new Set(message.expandedFileChanges)
  }]));
}

export function restoreHistoryView(messages: HistoryMessage[], saved: HistoryViewState): void {
  for (const message of messages) {
    const view = saved.get(messageKey(message));
    if (!view) continue;
    message.workGroupExpanded = new Map([...view.workGroups].map(([suffix, expanded]) => [message.id + suffix, expanded]));
    message.parts.filter(part => part.kind === "thought").forEach((part, index) => {
      if (view.thoughts[index] !== undefined) part.userExpanded = view.thoughts[index];
    });
    for (const tool of message.toolCards) {
      const expanded = view.tools.get(tool.toolId);
      if (expanded !== undefined) tool.expanded = expanded;
    }
    message.fileChangesExpanded = view.fileChangesExpanded;
    message.expandedFileChanges = new Set(view.expandedFileChanges);
  }
}
