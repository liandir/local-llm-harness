/** Display local calendar dates while retaining the full timestamp and hover time. */
export function renderMemoryDate(timestamp: number): string {
  return renderDate(timestamp, false);
}

/** Show only the date information relevant on the day the chat is viewed. */
export function renderMessageDate(timestamp: number, now = Date.now()): string {
  return renderDate(timestamp, true, now);
}

function renderDate(timestamp: number, contextual: boolean, now = Date.now()): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  let label = day;
  if (contextual) {
    const today = new Date(now);
    const sameYear = date.getFullYear() === today.getFullYear();
    const sameDay = sameYear && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
    const shortDate = new Intl.DateTimeFormat("en-GB", {
      day: "numeric", month: "short", ...(sameYear ? {} : { year: "numeric" as const })
    }).format(date);
    label = sameDay ? time : `${shortDate} · ${time}`;
  }
  return `<time datetime="${date.toISOString()}" title="${day} ${time}">${label}</time>`;
}
