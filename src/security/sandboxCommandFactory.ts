import * as path from "node:path";
import type { HarnessSettings } from "../config/settings.js";
import type { CommandPort } from "../chat/session/ports.js";
import {
  createDockerSandboxCommandPort,
  type DockerSandboxPlatform
} from "./commands/index.js";

/**
 * Construct one settings-bound Docker capability after its asynchronous local
 * runtime/image preflight. No runtime discovery, pull, build, or fallback is
 * attempted here: every authority-bearing value comes from the captured
 * application settings and explicit host platform policy.
 */
export function createConfiguredCommandPort(
  workspaceRoot: string,
  extensionStorageRoot: string,
  settings: Readonly<HarnessSettings>,
  signal: AbortSignal
): Promise<CommandPort> {
  // Only the literal blank setting selects the local default. Any non-empty
  // malformed value must reach profile validation and fail closed.
  const dockerHost = settings.sandboxDockerHost === ""
    ? defaultLocalDockerHost()
    : settings.sandboxDockerHost;
  const dockerConfigDirectory = path.join(
    path.resolve(extensionStorageRoot),
    "sandbox-docker-config-v1"
  );
  return createDockerSandboxCommandPort({
    workspaceRoot,
    dockerCliPath: settings.sandboxDockerPath,
    dockerHost,
    dockerConfigDirectory,
    image: settings.sandboxImage,
    platform: requiredSandboxPlatform(),
    hostEnvironment: dockerHostEnvironment()
  }, signal);
}

export function requiredSandboxPlatform(): DockerSandboxPlatform {
  // Linux exposes mount IDs for nested-bind rejection and Windows exposes
  // mount points as rejected reparse paths. Portable Node cannot establish an
  // equivalent proof on macOS yet, so capability advertisement must fail
  // before a model can propose a command there.
  if (process.platform !== "linux" && process.platform !== "win32") {
    throw new Error(
      `Docker sandbox commands are unavailable on host platform ${process.platform} because workspace mount containment cannot be proved.`
    );
  }
  if (process.arch === "x64") return "linux/amd64";
  if (process.arch === "arm64") return "linux/arm64";
  throw new Error(`Docker sandbox commands are unavailable on host architecture ${process.arch}.`);
}

export function defaultLocalDockerHost(): string {
  return process.platform === "win32"
    ? "npipe:////./pipe/docker_engine"
    : "unix:///var/run/docker.sock";
}

/** Minimal non-secret host data needed to start Docker Desktop on Windows. */
function dockerHostEnvironment(): Readonly<Record<string, string>> {
  if (process.platform !== "win32") return Object.freeze({});
  const environment: Record<string, string> = {};
  const systemRoot = process.env.SystemRoot;
  if (systemRoot && !systemRoot.includes("\0")) environment.SystemRoot = systemRoot;
  return Object.freeze(environment);
}
