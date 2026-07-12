import { describe, expect, it } from "vitest";
import { ReviewDocumentStore } from "../src/ui/chatView/reviewDocumentStore.js";

describe("ReviewDocumentStore", () => {
  it("evicts least-recently-used snapshots by count and byte budget", () => {
    const store = new ReviewDocumentStore(6, 5, 2);
    store.set("a", "aa");
    store.set("b", "bb");
    expect(store.get("a")).toBe("aa");
    store.set("c", "ccc");

    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toBe("aa");
    expect(store.get("c")).toBe("ccc");
    expect(store.size).toBe(2);
  });

  it("rejects one oversized snapshot and clears retained content", () => {
    const store = new ReviewDocumentStore(10, 4, 3);
    expect(() => store.set("large", "12345")).toThrow("4-byte limit");
    store.set("ok", "1234");
    store.clear();
    expect(store.get("ok")).toBeUndefined();
    expect(store.size).toBe(0);
  });
});
