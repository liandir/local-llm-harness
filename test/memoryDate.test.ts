import { describe, expect, it } from "vitest";
import { renderMemoryDate } from "../src/ui/memoryDate.js";

describe("memory dates", () => {
  it.each([
    [new Date(2026, 8, 7, 14, 5, 9, 123), "07-09-2026", "14:05:09"],
    [new Date(2026, 0, 1, 0, 0, 0), "01-01-2026", "00:00:00"]
  ])("shows an unambiguous local date and retains the full timestamp for %s", (date, day, time) => {
    const html = renderMemoryDate(date.getTime());
    expect(html.replace(/<[^>]*>/g, "")).toBe(day);
    expect(html).toContain(`title="${day} ${time}"`);
    expect(html).toContain(`datetime="${date.toISOString()}"`);
  });
});
