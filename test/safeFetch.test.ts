import { afterEach, describe, it, expect, vi } from "vitest";
import { safeFetch, NetworkPolicyError } from "../src/network/safeFetch.js";

describe("safeFetch origin lock", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("rejects hostname endpoints before fetch is called", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      safeFetch("http://nas.local:8080", "http://nas.local:8080/v1/models")
    ).rejects.toBeInstanceOf(NetworkPolicyError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses to follow redirects so the endpoint cannot bounce the body off-origin", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);

    await safeFetch("http://127.0.0.1:8080", "http://127.0.0.1:8080/v1/chat", {
      method: "POST",
      body: "{}"
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error" });
  });
});
