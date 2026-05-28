import { describe, expect, it } from "vitest";
import { withoutAssistantPrefill } from "../src/llm/client.js";

describe("withoutAssistantPrefill", () => {
  it("adds a user continuation when the request would end with assistant", () => {
    const messages = withoutAssistantPrefill([
      { role: "system", content: "system" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "partial answer" }
    ]);

    expect(messages.at(-1)?.role).toBe("user");
    expect(messages.at(-1)?.content).toContain("Continue");
  });

  it("keeps requests ending with user unchanged", () => {
    const original = [
      { role: "system" as const, content: "system" },
      { role: "user" as const, content: "hello" }
    ];

    expect(withoutAssistantPrefill(original)).toBe(original);
  });
});
