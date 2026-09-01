import { describe, expect, it } from "vitest";
import {
  SERVER_PENDING_NOTICE_DELAY_MS,
  pendingNoticeReplacesCurrentActivity,
  serverPendingVisibility
} from "../src/ui/chatView/webview/serverPendingDelay.js";

describe("serverPendingVisibility", () => {
  it("hides a new generic server wait for three seconds", () => {
    expect(serverPendingVisibility("server", undefined, 1_000)).toEqual({
      since: 1_000,
      visible: false,
      remainingMs: SERVER_PENDING_NOTICE_DELAY_MS
    });
    expect(serverPendingVisibility("server", 1_000, 3_999)).toEqual({
      since: 1_000,
      visible: false,
      remainingMs: 1
    });
    expect(serverPendingVisibility("server", 1_000, 4_000)).toEqual({
      since: 1_000,
      visible: true,
      remainingMs: 0
    });
  });

  it("shows named preparation work immediately and resets the generic timer", () => {
    expect(serverPendingVisibility("title", 1_000, 1_100)).toEqual({
      since: undefined,
      visible: true,
      remainingMs: 0
    });
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
