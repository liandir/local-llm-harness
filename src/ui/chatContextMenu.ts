/** Shared rename menu for chat tabs and Recent Chats rows. */
export function installChatContextMenu(root: HTMLElement, rename: (id: string) => void): void {
  let menu: HTMLDivElement | undefined;
  let owner: HTMLElement | undefined;
  const close = (restoreFocus = false): void => {
    menu?.remove();
    menu = undefined;
    if (restoreFocus) (owner?.querySelector<HTMLElement>("button") ?? owner)?.focus();
  };
  const open = (target: HTMLElement, x: number, y: number): void => {
    close();
    owner = target;
    const id = target.dataset.chatContext;
    if (!id) return;
    menu = document.createElement("div");
    menu.className = "chat-context-menu";
    menu.setAttribute("role", "menu");
    const button = document.createElement("button");
    button.textContent = "Rename";
    button.setAttribute("role", "menuitem");
    button.addEventListener("click", event => { event.stopPropagation(); close(true); rename(id); });
    menu.append(button);
    document.body.append(menu);
    menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - menu.offsetWidth))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - menu.offsetHeight))}px`;
    button.focus();
  };
  root.addEventListener("contextmenu", event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-chat-context]");
    if (!target) return;
    event.preventDefault();
    open(target, event.clientX, event.clientY);
  });
  root.addEventListener("keydown", event => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-chat-context]");
    if (!target) return;
    event.preventDefault();
    const rect = target.getBoundingClientRect();
    open(target, rect.left, rect.bottom);
  });
  document.addEventListener("pointerdown", event => { if (!menu?.contains(event.target as Node)) close(); });
  document.addEventListener("keydown", event => { if (menu && event.key === "Escape") { event.preventDefault(); close(true); } });
  window.addEventListener("blur", () => close());
}
