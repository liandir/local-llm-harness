import { describe, expect, it } from "vitest";
import {
  CHAT_SCHEMA_VERSION,
  CHAT_RECORD_LIMITS,
  migrateLegacyChatRecord,
  normalizeStoredChatRecord,
  parseChatRecord
} from "../src/chat/model.js";

const ID = "123e4567-e89b-42d3-a456-426614174000";

function currentRecord(): Record<string, unknown> {
  return {
    schemaVersion: CHAT_SCHEMA_VERSION,
    id: ID,
    workspaceRoot: "/workspace",
    createdAt: 10,
    updatedAt: 20,
    title: "Validated",
    modelFamily: "gemma4",
    planMode: false,
    messages: [
      {
        role: "assistant",
        content: "Done",
        ts: 20,
        events: [{ kind: "text", text: "Done", t: 20 }],
        fileChanges: [{ path: "src/a.ts", added: 1, removed: 0, diffPreview: "+ line" }]
      }
    ],
    totalTokens: 4
  };
}

describe("versioned chat model", () => {
  it("decodes the current schema into a fresh validated record", () => {
    const raw = currentRecord();
    const record = parseChatRecord(raw);

    expect(record).toMatchObject({ schemaVersion: 1, id: ID, title: "Validated" });
    expect(record).not.toBe(raw);
  });

  it("explicitly migrates unversioned workspace-local records", () => {
    const record = migrateLegacyChatRecord(
      { title: "Legacy", updatedAt: 30, messages: [] },
      { id: ID, workspaceRoot: "/workspace" }
    );

    expect(record).toEqual({
      schemaVersion: 1,
      id: ID,
      workspaceRoot: "/workspace",
      createdAt: 30,
      updatedAt: 30,
      title: "Legacy",
      modelFamily: "gemma4",
      planMode: false,
      messages: [],
      totalTokens: 0
    });
  });

  it("uses the trusted filename id while still validating the complete record", () => {
    const raw = { ...currentRecord(), id: "../../outside" };
    expect(normalizeStoredChatRecord(raw, { id: ID })).toMatchObject({ id: ID });
  });

  it("fails closed for unknown versions, extra fields, and malformed nested data", () => {
    expect(normalizeStoredChatRecord({ ...currentRecord(), schemaVersion: 99 })).toBeUndefined();
    expect(parseChatRecord({ ...currentRecord(), unexpected: true })).toBeUndefined();
    expect(parseChatRecord({
      ...currentRecord(),
      messages: [{ role: "assistant", content: "x", ts: 1, events: [{ kind: "text", text: 5 }] }]
    })).toBeUndefined();
  });

  it("bounds strings and collection sizes in untrusted records", () => {
    expect(parseChatRecord({
      ...currentRecord(),
      title: "x".repeat(CHAT_RECORD_LIMITS.titleChars + 1)
    })).toBeUndefined();
    expect(parseChatRecord({
      ...currentRecord(),
      messages: new Array(CHAT_RECORD_LIMITS.messages + 1).fill({
        role: "user",
        content: "x",
        ts: 1
      })
    })).toBeUndefined();
    expect(parseChatRecord({
      ...currentRecord(),
      messages: [{
        role: "assistant",
        content: "x",
        ts: 1,
        events: new Array(CHAT_RECORD_LIMITS.eventsPerMessage + 1).fill({ kind: "done" })
      }]
    })).toBeUndefined();
  });
});
