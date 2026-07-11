import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type Capability = "filesystem" | "childProcess" | "rawNetwork";

interface PathRules {
  exact: string[];
  prefixes: string[];
}

interface LegacyException {
  file: string;
  capabilities: Capability[];
  removeByPhase: number;
  securityGate: string;
  reason: string;
}

interface ArchitecturePolicy {
  schemaVersion: number;
  approvedAdapters: Record<Capability, PathRules>;
  temporaryLegacyAllowlist: LegacyException[];
}

const repoRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

describe("security architecture boundaries", () => {
  it("keeps raw capabilities inside approved adapters or tracked legacy exceptions", async () => {
    const policy = JSON.parse(
      await fs.readFile(path.join(repoRoot, "security-architecture.json"), "utf8")
    ) as ArchitecturePolicy;
    const gates = JSON.parse(
      await fs.readFile(path.join(repoRoot, "security-gates.json"), "utf8")
    ) as { blockingFindings?: Array<{ id: string }> };
    const gateIds = new Set((gates.blockingFindings ?? []).map(gate => gate.id));
    const sourceFiles = await listTypeScriptFiles(path.join(repoRoot, "src"));
    const detections = new Map<string, Set<Capability>>();

    expect(policy.schemaVersion).toBe(1);
    for (const absoluteFile of sourceFiles) {
      const file = toRepoPath(absoluteFile);
      const source = await fs.readFile(absoluteFile, "utf8");
      const capabilities = detectCapabilities(source);
      detections.set(file, capabilities);
      for (const capability of capabilities) {
        expect(
          isApproved(policy, file, capability),
          `${file} uses ${capability} outside an approved adapter. Add an adapter, or a temporary exception tied to an active security gate.`
        ).toBe(true);
      }
    }

    const exceptionKeys = new Set<string>();
    for (const exception of policy.temporaryLegacyAllowlist) {
      expect(exception.reason.trim().length).toBeGreaterThan(10);
      expect(exception.removeByPhase).toBeGreaterThan(1);
      expect(gateIds.has(exception.securityGate), `${exception.file} references inactive ${exception.securityGate}`).toBe(true);
      for (const capability of exception.capabilities) {
        const key = `${exception.file}:${capability}`;
        expect(exceptionKeys.has(key), `duplicate architecture exception ${key}`).toBe(false);
        exceptionKeys.add(key);
        expect(
          detections.get(exception.file)?.has(capability),
          `${key} is stale and should be removed from the temporary allowlist`
        ).toBe(true);
      }
    }
  });
});

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listTypeScriptFiles(target));
    else if (entry.isFile() && /\.tsx?$/.test(entry.name)) files.push(target);
  }
  return files.sort();
}

function detectCapabilities(source: string): Set<Capability> {
  const modules = importedModules(source);
  const capabilities = new Set<Capability>();
  if (
    modules.some(module => FILESYSTEM_MODULES.has(module)) ||
    /\bvscode\.workspace\.(?:fs|openTextDocument|applyEdit)\b/.test(source) ||
    /\bnew\s+vscode\.WorkspaceEdit\b/.test(source)
  ) {
    capabilities.add("filesystem");
  }
  if (
    modules.some(module => CHILD_PROCESS_MODULES.has(module)) ||
    /\bvscode\.window\.createTerminal\b/.test(source) ||
    /\bvscode\.tasks\.executeTask\b/.test(source) ||
    /\bnew\s+vscode\.(?:ShellExecution|ProcessExecution)\b/.test(source)
  ) {
    capabilities.add("childProcess");
  }
  if (
    modules.some(module => RAW_NETWORK_MODULES.has(module)) ||
    /\b(?:globalThis\.|window\.)?fetch\s*\(/.test(source) ||
    /\bnew\s+(?:globalThis\.|window\.)?(?:WebSocket|EventSource|XMLHttpRequest)\s*\(/.test(source) ||
    /\bnavigator\.sendBeacon\s*\(/.test(source)
  ) {
    capabilities.add("rawNetwork");
  }
  return capabilities;
}

function importedModules(source: string): string[] {
  const modules = new Set<string>();
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) modules.add(match[1]);
  }
  return [...modules];
}

function isApproved(policy: ArchitecturePolicy, file: string, capability: Capability): boolean {
  const rules = policy.approvedAdapters[capability];
  if (rules.exact.includes(file) || rules.prefixes.some(prefix => file.startsWith(prefix))) return true;
  return policy.temporaryLegacyAllowlist.some(
    exception => exception.file === file && exception.capabilities.includes(capability)
  );
}

function toRepoPath(absoluteFile: string): string {
  return path.relative(repoRoot, absoluteFile).split(path.sep).join("/");
}

const FILESYSTEM_MODULES = new Set(["fs", "fs/promises", "node:fs", "node:fs/promises"]);
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);
const RAW_NETWORK_MODULES = new Set([
  "http", "https", "http2", "net", "tls", "dgram", "dns", "dns/promises",
  "node:http", "node:https", "node:http2", "node:net", "node:tls", "node:dgram",
  "node:dns", "node:dns/promises",
  "axios", "got", "node-fetch", "request", "superagent", "undici", "ws", "websocket"
]);
