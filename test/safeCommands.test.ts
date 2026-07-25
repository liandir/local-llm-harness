import { describe, expect, it, vi } from "vitest";
import pkg from "../package.json";
import { checkSafeCommand, type SafeCommandEntry } from "../src/tools/safeCommands.js";

describe("legacy safeCommands compatibility", () => {
  it("never authorizes a command or evaluates legacy regex text", () => {
    const entry = Object.defineProperty({}, "match", {
      enumerable: true,
      get: vi.fn(() => {
        throw new Error("legacy regex was inspected");
      })
    }) as SafeCommandEntry;

    const result = checkSafeCommand("npm test", [entry]);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("inactive");
    expect(Object.getOwnPropertyDescriptor(entry, "match")?.get).not.toHaveBeenCalled();
  });

  it("keeps even pathological historical patterns execution-inert", () => {
    const legacy = [{ match: "(a+)+$", description: "historical entry" }];
    const command = `${"a".repeat(100_000)}!`;

    expect(checkSafeCommand(command, legacy)).toEqual({
      ok: false,
      reason: "Legacy safeCommands regex authorization is inactive; no command was authorized."
    });
  });

  it("documents empty, inert compatibility defaults in the manifest", () => {
    const properties = pkg.contributes.configuration.properties;
    const legacyRules = properties["localLlmHarness.safeCommands"];
    expect(legacyRules.default).toEqual([]);
    expect(legacyRules.description).toContain("never evaluated");
    expect(properties["localLlmHarness.autoapproveCommands"].description).toContain("ignored");
  });
});
