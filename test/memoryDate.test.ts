import { describe, expect, it } from "vitest";
import { renderMemoryDate, renderMessageDate } from "../src/ui/memoryDate.js";

describe("memory dates", () => {
  it.each([
    [new Date(2026, 8, 7, 14, 5, 9, 123), "07-09-2026", "14:05"],
    [new Date(2026, 0, 1, 0, 0, 0), "01-01-2026", "00:00"]
  ])("shows an unambiguous local date and retains the full timestamp for %s", (date, day, time) => {
    const html = renderMemoryDate(date.getTime());
    expect(html.replace(/<[^>]*>/g, "")).toBe(day);
    expect(html).toContain(`title="${day} ${time}"`);
    expect(html).toContain(`datetime="${date.toISOString()}"`);
  });
});

describe("message dates", () => {
  it("shows the local date and time while preserving the exact instant", () => {
    const date = new Date(2026, 8, 11, 14, 5, 9, 123);
    const html = renderMessageDate(date.getTime(), date.getTime());
    expect(html.replace(/<[^>]*>/g, "")).toBe("14:05");
    expect(html).toContain(`datetime="${date.toISOString()}"`);
  });

  it.each([
    [new Date(2026, 8, 11, 23, 59), new Date(2026, 8, 12), "11 Sept · 23:59"],
    [new Date(2025, 11, 31, 23, 59), new Date(2026, 0, 1), "31 Dec 2025 · 23:59"],
    [new Date(2026, 0, 1, 0, 5), new Date(2026, 0, 1, 12), "00:05"]
  ])("adds date information relative to when a chat is viewed", (date, now, expected) => {
    expect(renderMessageDate(date.getTime(), now.getTime()).replace(/<[^>]*>/g, "")).toBe(expected);
  });

  it.each([NaN, Infinity, 1e20])("omits invalid timestamps: %s", timestamp => {
    expect(renderMessageDate(timestamp)).toBe("");
  });
});
