import { describe, expect, it } from "vitest";
import {
  SANDBOX_GIT_ENV,
  gitBlobContentArgs,
  gitBlobSizeArgs,
  gitHeadTreeArgs,
  gitStagedPatchArgs,
  gitStagedStatusArgs,
  parseHeadBlobEntry
} from "../src/scm/gitProfile.js";

describe("sandbox Git profile", () => {
  it("disables repository-triggered helpers for staged inspection", () => {
    const status = gitStagedStatusArgs();
    const patch = gitStagedPatchArgs();
    for (const args of [status, patch]) {
      expect(args).toContain("--no-ext-diff");
      expect(args).toContain("--no-textconv");
      expect(args).toContain("core.hooksPath=/dev/null");
      expect(args).toContain("credential.helper=");
      expect(args).toContain("protocol.allow=never");
      expect(args.at(-1)).toBe("--");
    }
    expect(SANDBOX_GIT_ENV.GIT_TERMINAL_PROMPT).toBe("0");
    expect(SANDBOX_GIT_ENV.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    expect(SANDBOX_GIT_ENV.GIT_SSH_COMMAND).toBe("/bin/false");
  });

  it("places a validated path after the pathspec delimiter", () => {
    const args = gitHeadTreeArgs("src/a file.ts");
    expect(args.slice(-2)).toEqual(["--", "src/a file.ts"]);
    expect(() => gitHeadTreeArgs("../outside")).toThrow();
    expect(() => gitHeadTreeArgs("C:/outside")).toThrow();
  });

  it("accepts only an exact regular blob entry for the requested path", () => {
    const oid = "a".repeat(40);
    expect(parseHeadBlobEntry(`100644 blob ${oid}\tsrc/a.ts\0`, "src/a.ts")).toBe(oid);
    expect(parseHeadBlobEntry("", "src/a.ts")).toBeUndefined();
    expect(() => parseHeadBlobEntry(`120000 blob ${oid}\tsrc/a.ts\0`, "src/a.ts")).toThrow();
    expect(() => parseHeadBlobEntry(`100644 blob ${oid}\tsrc/b.ts\0`, "src/a.ts")).toThrow();
  });

  it("accepts only full SHA-1 or SHA-256 object IDs", () => {
    expect(gitBlobSizeArgs("b".repeat(64)).at(-1)).toBe("b".repeat(64));
    expect(gitBlobContentArgs("c".repeat(40)).at(-1)).toBe("c".repeat(40));
    expect(() => gitBlobContentArgs("HEAD:src/a.ts")).toThrow();
  });
});
