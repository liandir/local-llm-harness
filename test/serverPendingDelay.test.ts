import { describe, expect, it } from "vitest";
import {
  SERVER_PENDING_NOTICE_DELAY_MS,
  TITLE_BLOCKING_NOTICE_DELAY_MS,
  pendingNoticeReplacesCurrentActivity,
  serverPendingVisibility
} from "../src/ui/chatView/webview/serverPendingDelay.js";

describe("serverPendingVisibility", () => {
  it("shows a sustained generic server wait after three seconds", () => {
    expect(SERVER_PENDING_NOTICE_DELAY_MS).toBe(3_000);
    expect(serverPendingVisibility("server", undefined, 1_000)).toEqual({
      since: 1_000,
      visible: false,
      remainingMs: SERVER_PENDING_NOTICE_DELAY_MS
    });
    expect(serverPendingVisibility("server", 1_000, 1_000 + SERVER_PENDING_NOTICE_DELAY_MS - 1)).toEqual({
      since: 1_000,
      visible: false,
      remainingMs: 1
    });
    expect(serverPendingVisibility("server", 1_000, 1_000 + SERVER_PENDING_NOTICE_DELAY_MS)).toEqual({
      since: 1_000,
      visible: true,
      remainingMs: 0
    });
  });

  it("shows title generation only after it persists long enough to be blocking", () => {
    expect(TITLE_BLOCKING_NOTICE_DELAY_MS).toBe(SERVER_PENDING_NOTICE_DELAY_MS);
    expect(TITLE_BLOCKING_NOTICE_DELAY_MS).toBe(3_000);
    expect(serverPendingVisibility("title", 1_000, 1_100)).toEqual({
      since: 1_000,
      visible: false,
      remainingMs: TITLE_BLOCKING_NOTICE_DELAY_MS - 100
    });
    expect(serverPendingVisibility("title", 1_000, 1_000 + TITLE_BLOCKING_NOTICE_DELAY_MS)).toEqual({
      since: 1_000,
      visible: true,
      remainingMs: 0
    });
  });

  it("shows context preparation immediately and resets pending timers", () => {
    expect(serverPendingVisibility("context", 1_000, 1_100).visible).toBe(true);
    expect(serverPendingVisibility(undefined, 1_000, 1_100).since).toBeUndefined();
  });

  it("replaces a collapsed sub-session's current tool once server pending is visible", () => {
    expect(pendingNoticeReplacesCurrentActivity("server")).toBe(true);
    expect(pendingNoticeReplacesCurrentActivity("title")).toBe(true);
    expect(pendingNoticeReplacesCurrentActivity("context")).toBe(false);
    expect(pendingNoticeReplacesCurrentActivity(undefined)).toBe(false);
  });
});
