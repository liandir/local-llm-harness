import { describe, it, expect } from "vitest";
import { safeFetch, NetworkPolicyError } from "../src/network/safeFetch.js";

describe("safeFetch origin lock", () => {
  it("rejects URLs whose origin differs from the configured endpoint", async () => {
    await expect(
      safeFetch("http://192.168.1.50:8080", "http://example.com/foo")
    ).rejects.toBeInstanceOf(NetworkPolicyError);
  });

  it("rejects malformed configured endpoints", async () => {
    await expect(
      safeFetch("http:///garbage", "http://example.com/x")
    ).rejects.toBeInstanceOf(NetworkPolicyError);
  });

  it("refuses when configured endpoint is public", async () => {
    await expect(
      safeFetch("http://1.1.1.1:80", "http://1.1.1.1:80/v1/models")
    ).rejects.toBeInstanceOf(NetworkPolicyError);
  });
});
