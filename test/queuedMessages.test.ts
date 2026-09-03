import { describe, expect, it } from "vitest";
import { reorderItemsById, shouldDrainMessageQueue } from "../src/ui/chatView/queuedMessages.js";

describe("reorderItemsById", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("applies the requested queue order", () => {
    expect(reorderItemsById(items, ["c", "a", "b"]).map(item => item.id))
      .toEqual(["c", "a", "b"]);
  });

  it("ignores stale and duplicate ids while retaining new queue entries", () => {
    expect(reorderItemsById(items, ["b", "missing", "b", "a"]).map(item => item.id))
      .toEqual(["b", "a", "c"]);
  });
});

describe("shouldDrainMessageQueue", () => {
  it("keeps a follow-up queued while a direct session turn is active", () => {
    expect(shouldDrainMessageQueue({
      queueLength: 1,
      messageLoopRunning: false,
      sessionCreationPending: false,
      turnActive: true
    })).toBe(false);
  });

  it("drains queued follow-ups once the session is idle", () => {
    expect(shouldDrainMessageQueue({
      queueLength: 1,
      messageLoopRunning: false,
      sessionCreationPending: false,
      turnActive: false
    })).toBe(true);
  });
});
