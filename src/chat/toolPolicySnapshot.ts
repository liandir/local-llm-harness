import type { HarnessSettings } from "../config/settings.js";
import type { CommandPort } from "./session/ports.js";
import {
  createSandboxCommandCapabilitySnapshot,
  type SandboxCommandCapabilitySnapshot
} from "../tools/sandboxCommands.js";

export type CommandPortFactory = (
  settings: Readonly<HarnessSettings>,
  signal: AbortSignal
) => Promise<CommandPort>;

export interface ToolPolicySnapshot {
  readonly sandbox: SandboxCommandCapabilitySnapshot;
  readonly commands?: CommandPort;
}

/**
 * Capture command configuration and runtime attestation once for a chat turn.
 * The same immutable snapshot must feed prompt rendering, tool classification,
 * approval preparation, and execution; settings changes apply next turn only.
 */
export async function captureToolPolicySnapshot(
  settings: Readonly<HarnessSettings>,
  factory: CommandPortFactory | undefined,
  signal: AbortSignal
): Promise<ToolPolicySnapshot> {
  const configuration = {
    sandboxDockerPath: settings.sandboxDockerPath,
    sandboxDockerHost: settings.sandboxDockerHost,
    sandboxImage: settings.sandboxImage,
    sandboxCommands: settings.sandboxCommands
  };
  const unverified = createSandboxCommandCapabilitySnapshot(configuration, false);
  if (
    !settings.sandboxDockerPath ||
    !settings.sandboxImage ||
    settings.sandboxCommands.length === 0
  ) {
    return Object.freeze({ sandbox: unverified });
  }
  if (!factory) {
    return Object.freeze({
      sandbox: createSandboxCommandCapabilitySnapshot(
        configuration,
        false,
        "No sandbox runtime factory is installed."
      )
    });
  }

  try {
    signal.throwIfAborted();
    const commands = await factory(settings, signal);
    const availability = await commands.availability(signal);
    if (!availability.available) {
      return Object.freeze({
        sandbox: createSandboxCommandCapabilitySnapshot(
          configuration,
          false,
          availability.reason
        )
      });
    }
    const expectedImage = settings.sandboxImage;
    const imageMatches = expectedImage.startsWith("sha256:")
      ? availability.imageId === expectedImage && availability.imageReference === expectedImage
      : availability.imageReference === expectedImage;
    if (
      availability.backend !== "docker" ||
      !imageMatches ||
      !/^[0-9a-f]{64}$/.test(availability.profileDigest) ||
      !/^sha256:[0-9a-f]{64}$/.test(availability.imageId)
    ) {
      return Object.freeze({
        sandbox: createSandboxCommandCapabilitySnapshot(
          configuration,
          false,
          "The sandbox runtime attestation did not match the captured configuration."
        )
      });
    }
    return Object.freeze({
      sandbox: createSandboxCommandCapabilitySnapshot(configuration, true),
      commands
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    return Object.freeze({
      sandbox: createSandboxCommandCapabilitySnapshot(
        configuration,
        false,
        boundedFailureReason(error)
      )
    });
  }
}

function boundedFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "Sandbox preflight failed.";
  const printable = [...message]
    .filter(character => {
      const code = character.charCodeAt(0);
      return code >= 0x20 && code !== 0x7f;
    })
    .join("")
    .slice(0, 512);
  return printable || "Sandbox preflight failed.";
}
