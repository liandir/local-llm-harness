/** Display local calendar dates while retaining the full timestamp and hover time. */
export function renderMemoryDate(timestamp: number): string {
  return renderDate(timestamp, false);
}

/** Display the saved message time in the user's local timezone. */
export function renderMessageDate(timestamp: number): string {
  return renderDate(timestamp, true);
}

function renderDate(timestamp: number, includeTime: boolean): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value: number): string => String(value).padStart(2, "0");
  const day = `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `<time datetime="${date.toISOString()}" title="${day} ${time}">${day}${includeTime ? ` ${time}` : ""}</time>`;
}
