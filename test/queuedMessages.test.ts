import { describe, expect, it } from "vitest";
import { reorderItemsById } from "../src/ui/chatView/queuedMessages.js";

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
