import { describe, expect, it } from "vitest";
import { sandboxCommandCardIdentity } from "../src/ui/chatView/webview/sandboxCommandCard.js";

describe("sandbox command card identity", () => {
  it("restores a command card from its exact immutable rule ID", () => {
    expect(sandboxCommandCardIdentity('{"ruleId":"git-status"}', undefined)).toEqual({
      kind: "rule",
      label: "[git-status]",
      value: "git-status"
    });
  });

  it("keeps the richer host-rendered identity on a live command card", () => {
    expect(sandboxCommandCardIdentity(
      '{"ruleId":"git-status"}',
      '[git-status] "/usr/bin/git" "status" "--short"'
    )).toEqual({
      kind: "command",
      label: '[git-status] "/usr/bin/git" "status" "--short"',
      value: '[git-status] "/usr/bin/git" "status" "--short"'
    });
  });

  it("never treats legacy or extended argument objects as command identity", () => {
    expect(sandboxCommandCardIdentity('{"command":"npm test"}', undefined)).toBeUndefined();
    expect(sandboxCommandCardIdentity(
      '{"ruleId":"git-status","command":"npm test"}',
      undefined
    )).toBeUndefined();
    expect(sandboxCommandCardIdentity('{"arguments":{"ruleId":"git-status"}}', undefined))
      .toBeUndefined();
  });

  it("rejects malformed rule IDs and falls back from an empty host display", () => {
    expect(sandboxCommandCardIdentity('{"ruleId":"Git Status"}', undefined)).toBeUndefined();
    expect(sandboxCommandCardIdentity('{"ruleId":"git-status"}', "")).toEqual({
      kind: "rule",
      label: "[git-status]",
      value: "git-status"
    });
  });
});
