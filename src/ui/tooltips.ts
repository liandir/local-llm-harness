const TOOLTIP_DELAY_MS = 500;
const MARGIN = 8;
const GAP = 6;

export function tooltipPosition(
  target: { left: number; top: number; bottom: number; width: number },
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
  below: boolean
): { left: number; top: number } {
  let top = below ? target.bottom + GAP : target.top - tip.height - GAP;
  if (!below && top < MARGIN) top = target.bottom + GAP;
  top = Math.max(MARGIN, Math.min(top, viewport.height - MARGIN - tip.height));
  const centered = target.left + target.width / 2 - tip.width / 2;
  const left = Math.max(MARGIN, Math.min(centered, viewport.width - MARGIN - tip.width));
  return { left: Math.floor(left), top: Math.floor(top) };
}

/** One tooltip surface for both webviews, including controls inserted by later renders. */
export function installTooltips(): void {
  const tooltip = document.createElement("div");
  tooltip.id = "tooltip";
  tooltip.className = "tooltip";
  tooltip.setAttribute("role", "tooltip");
  tooltip.hidden = true;
  document.body.append(tooltip);
  let target: HTMLElement | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const hide = (): void => {
    clearTimeout(timer);
    timer = undefined;
    target = undefined;
    tooltip.hidden = true;
  };
  const refresh = (): void => {
    if (!target || tooltip.hidden) return;
    if (!target.isConnected || !target.getClientRects().length || target.matches('[aria-haspopup="menu"][aria-expanded="true"]')) {
      hide();
      return;
    }
    tooltip.textContent = target.dataset.tip ?? target.getAttribute("aria-label") ?? target.textContent?.trim() ?? "";
    if (!tooltip.textContent) { hide(); return; }
    // Measure at the viewport origin so a previous position cannot constrain the width.
    tooltip.style.left = "0px";
    tooltip.style.top = "0px";
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight };
    tooltip.style.maxWidth = `${Math.max(0, viewport.width - 2 * MARGIN)}px`;
    const position = tooltipPosition(target.getBoundingClientRect(), tooltip.getBoundingClientRect(),
      viewport, !!target.closest(".chat-header, .tabs"));
    tooltip.style.left = `${position.left}px`;
    tooltip.style.top = `${position.top}px`;
  };
  const schedule = (element: HTMLElement): void => {
    if (target === element) return;
    hide();
    target = element;
    timer = setTimeout(() => {
      timer = undefined;
      if (!element.isConnected || !(element.matches(":hover") || element.matches(":focus-visible"))) { hide(); return; }
      tooltip.hidden = false;
      refresh();
    }, TOOLTIP_DELAY_MS);
  };
  const owner = (event: Event): HTMLElement | null =>
    event.target instanceof Element ? event.target.closest<HTMLElement>("[data-tip], button") : null;
  document.addEventListener("pointerover", event => {
    const element = owner(event);
    if (element) schedule(element);
  });
  document.addEventListener("pointerout", event => {
    if (target && !target.contains(event.relatedTarget as Node | null)) hide();
  });
  document.addEventListener("focusin", event => {
    const element = owner(event);
    if (element?.matches(":focus-visible")) schedule(element);
  });
  document.addEventListener("focusout", hide);
  document.addEventListener("pointerdown", hide, true);
  document.addEventListener("keydown", event => { if (event.key === "Escape") hide(); });
  window.addEventListener("blur", hide);
  window.addEventListener("resize", hide);
  window.addEventListener("scroll", hide, true);
  // Streaming and tab switches can replace the hovered control without pointerout.
  new MutationObserver(refresh).observe(document.getElementById("app")!, {
    subtree: true, childList: true, attributes: true, attributeFilter: ["data-tip", "aria-label", "aria-expanded", "hidden"]
  });
}
