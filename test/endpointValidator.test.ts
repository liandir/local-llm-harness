import { describe, it, expect } from "vitest";
import { validateEndpoint, isPrivateAddress } from "../src/network/endpointValidator.js";

describe("isPrivateAddress", () => {
  it("accepts loopback, RFC1918, link-local, CGNAT, mDNS-resolved ranges", () => {
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    expect(isPrivateAddress("10.0.0.5")).toBe(true);
    expect(isPrivateAddress("172.16.5.1")).toBe(true);
    expect(isPrivateAddress("172.31.255.255")).toBe(true);
    expect(isPrivateAddress("192.168.1.50")).toBe(true);
    expect(isPrivateAddress("169.254.1.1")).toBe(true);
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
  });

  it("rejects public addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("172.15.0.1")).toBe(false);
    expect(isPrivateAddress("192.167.1.1")).toBe(false);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("rejects non-IPs", () => {
    expect(isPrivateAddress("notanaddress")).toBe(false);
    expect(isPrivateAddress("")).toBe(false);
  });
});

describe("validateEndpoint", () => {
  it("accepts http://localhost", async () => {
    const r = await validateEndpoint("http://localhost:8080");
    expect(r.ok).toBe(true);
  });
  it("accepts private IPv4 literals", async () => {
    expect((await validateEndpoint("http://192.168.1.50:8080")).ok).toBe(true);
    expect((await validateEndpoint("http://10.0.0.1:1234")).ok).toBe(true);
  });
  it("accepts *.local mDNS without DNS", async () => {
    const r = await validateEndpoint("http://nas.local:8080");
    expect(r.ok).toBe(true);
  });
  it("rejects public IP literals", async () => {
    const r = await validateEndpoint("http://8.8.8.8:80");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/public address/);
  });
  it("rejects malformed URLs", async () => {
    const r = await validateEndpoint("not a url");
    expect(r.ok).toBe(false);
  });
  it("rejects non-http(s) protocols", async () => {
    const r = await validateEndpoint("file:///etc/passwd");
    expect(r.ok).toBe(false);
  });
});
