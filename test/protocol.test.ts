import { describe, expect, it } from "vitest";
import { HOST_MESSAGE_LIMITS, parseChatToExt, parseSideToExt } from "../src/chat/protocol.js";

const ID = "123e4567-e89b-42d3-a456-426614174000";

describe("host-bound webview protocol", () => {
  it("accepts valid chat messages and rejects unknown or mistyped fields", () => {
    expect(parseChatToExt({ type: "send", text: "hello" })).toEqual({ type: "send", text: "hello" });
    expect(parseChatToExt({ type: "openFile", path: "src/a.ts" })).toEqual({
      type: "openFile",
      path: "src/a.ts"
    });
    expect(parseChatToExt({ type: "approveTool", toolId: "t1", approved: "yes" })).toBeUndefined();
    expect(parseChatToExt({ type: "cancel", injected: true })).toBeUndefined();
    expect(parseChatToExt({ type: "openFile", path: "src/a.ts", line: 0 })).toBeUndefined();
    const inheritedType = Object.assign(Object.create({ type: "openFile" }) as object, {
      path: "src/a.ts"
    });
    expect(parseChatToExt(inheritedType)).toBeUndefined();
  });

  it("bounds host-bound strings and rejects NUL-bearing capability identifiers", () => {
    expect(parseChatToExt({
      type: "send",
      text: "x".repeat(HOST_MESSAGE_LIMITS.chatText + 1)
    })).toBeUndefined();
    expect(parseChatToExt({ type: "openFile", path: "src/evil\0.ts" })).toBeUndefined();
    expect(parseChatToExt({
      type: "approveTool",
      toolId: "t".repeat(HOST_MESSAGE_LIMITS.identifier + 1),
      approved: true
    })).toBeUndefined();
    expect(parseChatToExt({
      type: "renameChat",
      title: "t".repeat(HOST_MESSAGE_LIMITS.title + 1)
    })).toBeUndefined();
    expect(parseSideToExt({
      type: "validateEndpoint",
      url: "x".repeat(HOST_MESSAGE_LIMITS.endpointUrl + 1)
    })).toBeUndefined();
  });

  it("validates side-view ids, tabs, and exact message fields", () => {
    expect(parseSideToExt({ type: "openChat", id: ID })).toEqual({ type: "openChat", id: ID });
    expect(parseSideToExt({ type: "openChat", id: "../outside" })).toBeUndefined();
    expect(parseSideToExt({ type: "openTab", tab: "unknown" })).toBeUndefined();
    expect(parseSideToExt({ type: "ready", extra: true })).toBeUndefined();
  });

  it("whitelists setting keys and validates their types and ranges", () => {
    expect(parseSideToExt({ type: "saveSetting", key: "temperature", value: 0.3 })).toEqual({
      type: "saveSetting",
      key: "temperature",
      value: 0.3
    });
    expect(parseSideToExt({ type: "saveSetting", key: "autoapproveReads", value: false })).toEqual({
      type: "saveSetting",
      key: "autoapproveReads",
      value: false
    });
    expect(parseSideToExt({ type: "saveSetting", key: "endpoint", value: "https://evil.test" })).toBeUndefined();
    expect(parseSideToExt({ type: "saveSetting", key: "safeCommands", value: [] })).toBeUndefined();
    expect(parseSideToExt({ type: "saveSetting", key: "temperature", value: 3 })).toBeUndefined();
    expect(parseSideToExt({ type: "saveSetting", key: "topK", value: 1.5 })).toBeUndefined();
    expect(parseSideToExt({ type: "saveSetting", key: "topP", value: Number.NaN })).toBeUndefined();
  });
});
