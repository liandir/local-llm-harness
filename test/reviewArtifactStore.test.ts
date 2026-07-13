import { describe, expect, it } from "vitest";
import { ReviewArtifactStore } from "../src/chat/reviewArtifactStore.js";

describe("ReviewArtifactStore", () => {
  it("retains bounded exact artifacts without base or result snapshots", () => {
    const store = new ReviewArtifactStore(10, 2);
    store.set("a", { text: "aaaa", format: "exact-v1" });
    store.set("b", { text: "bbbb", format: "exact-v1" });
    expect(store.get("a")).toEqual({ text: "aaaa", format: "exact-v1" });

    store.set("c", { text: "cccc", format: "exact-v1" });
    expect(store.get("b")).toBeUndefined();
    expect(store.get("a")).toEqual({ text: "aaaa", format: "exact-v1" });
    expect(store.get("c")).toEqual({ text: "cccc", format: "exact-v1" });
  });

  it("does not retain one artifact larger than the byte budget", () => {
    const store = new ReviewArtifactStore(3, 2);
    store.set("large", { text: "four", format: "exact-v1" });
    expect(store.get("large")).toBeUndefined();
  });
});
