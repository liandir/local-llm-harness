import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  TrustedDockerHostPaths,
  sameTrustedPathVersion
} from "../src/security/commands/trustedHostPaths.js";

let workspaceRoot: string;
let trustedRoot: string;

beforeEach(async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llh-host-path-workspace-"));
  trustedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "llh-host-path-tcb-"));
});

afterEach(async () => {
  await fs.rm(workspaceRoot, { recursive: true, force: true });
  await fs.rm(trustedRoot, { recursive: true, force: true });
});

describe("trusted Docker host paths", () => {
  it("binds a canonical regular CLI and empty config by identity, metadata, and SHA-256", async () => {
    const cli = await executable(path.join(trustedRoot, process.platform === "win32" ? "docker.exe" : "docker"));
    const guard = await TrustedDockerHostPaths.create(cli, path.join(trustedRoot, "config"), workspaceRoot);

    await expect(guard.verify()).resolves.toBeUndefined();
    await fs.writeFile(cli, "replacement bytes");
    await expect(guard.verify()).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  it("rejects a CLI or canonical configuration target inside the workspace", async () => {
    const insideCli = await executable(path.join(workspaceRoot, process.platform === "win32" ? "docker.exe" : "docker"));
    await expect(TrustedDockerHostPaths.create(
      insideCli,
      path.join(trustedRoot, "config-a"),
      workspaceRoot
    )).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });

    const outsideCli = await executable(path.join(trustedRoot, process.platform === "win32" ? "docker.exe" : "docker"));
    const linkedConfig = path.join(trustedRoot, "linked-config");
    await fs.symlink(workspaceRoot, linkedConfig, process.platform === "win32" ? "junction" : "dir");
    await expect(TrustedDockerHostPaths.create(outsideCli, linkedConfig, workspaceRoot))
      .rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  it("rejects ambient Docker configuration and detects later config changes", async () => {
    const cli = await executable(path.join(trustedRoot, process.platform === "win32" ? "docker.exe" : "docker"));
    const nonempty = path.join(trustedRoot, "nonempty");
    await fs.mkdir(nonempty);
    await fs.writeFile(path.join(nonempty, "config.json"), "{}");
    await expect(TrustedDockerHostPaths.create(cli, nonempty, workspaceRoot))
      .rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });

    const empty = path.join(trustedRoot, "empty");
    const guard = await TrustedDockerHostPaths.create(cli, empty, workspaceRoot);
    await fs.writeFile(path.join(empty, "injected.json"), "{}");
    await expect(guard.verify()).rejects.toMatchObject({ code: "INVALID_CONFIGURATION" });
  });

  it("securely creates a missing extension-storage parent chain outside the workspace", async () => {
    const cli = await executable(path.join(trustedRoot, process.platform === "win32" ? "docker.exe" : "docker"));
    const config = path.join(trustedRoot, "fresh", "global-storage", "sandbox-config");
    const guard = await TrustedDockerHostPaths.create(cli, config, workspaceRoot);

    await expect(fs.readdir(config)).resolves.toEqual([]);
    await expect(guard.verify()).resolves.toBeUndefined();
  });

  it("uses the documented Windows zero-device identity semantics without weakening inode/version checks", () => {
    const base = {
      device: 0n,
      inode: 42n,
      size: 10n,
      mode: 0o100755n,
      modifiedNs: 100n,
      changedNs: 200n
    };
    const handleView = { ...base, device: 99n };
    expect(sameTrustedPathVersion(base, handleView)).toBe(process.platform === "win32");
    expect(sameTrustedPathVersion(base, { ...handleView, inode: 43n })).toBe(false);
    expect(sameTrustedPathVersion(base, { ...handleView, changedNs: 201n })).toBe(false);
  });
});

async function executable(target: string): Promise<string> {
  await fs.writeFile(target, "trusted docker cli bytes");
  if (process.platform !== "win32") await fs.chmod(target, 0o755);
  return target;
}
