import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rm, cp, readdir, rename } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import vm from "node:vm";
import esbuild from "esbuild";
import { buildProfile } from "../esbuild.config.mjs";
import { root, profiles, assertProfile } from "./build-profiles.mjs";
import { auditStage, auditArchive } from "./verify-build-isolation.mjs";

const require = createRequire(import.meta.url);
const base = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const selected = process.argv.find(arg => arg.startsWith("--profile="))?.slice(10);
if (selected) assertProfile(selected);
const targets = selected ? [selected] : profiles;
const labels = { "no-commands": "No commands", "safe-list": "Safe list", commands: "Commands", advanced: "Advanced" };
const output = path.join(root, "artifacts");
const pending = path.join(root, ".build", "packages");
await mkdir(pending, { recursive: true });
await mkdir(output, { recursive: true });

async function defaultPatterns() {
  const result = await esbuild.build({ entryPoints: [path.join(root, "src/features/commands/safeList/defaults.ts")], bundle: true, write: false, platform: "node", format: "cjs" });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports });
  return module.exports.DEFAULT_SAFE_PATTERNS;
}

function runVsce(cwd, out) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve("@vscode/vsce/vsce"), "package", "--no-dependencies", "--allow-missing-repository", "--skip-license", "--out", out], { cwd, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve() : reject(new Error(`VSCE exited with ${code}`)));
  });
}

for (const profile of targets) {
  const stage = path.join(root, ".build", "staging", profile);
  await rm(stage, { recursive: true, force: true });
  await mkdir(path.join(stage, "media"), { recursive: true });
  const metadata = await buildProfile(profile, path.join(stage, "dist"));
  const reportDir = path.join(root, ".build", "reports");
  await mkdir(reportDir, { recursive: true });
  await writeFile(path.join(reportDir, `${profile}.json`), JSON.stringify(metadata));
  for (const name of await readdir(path.join(root, "media"))) {
    if (profile === "no-commands" && name === "commands.css") continue;
    await cp(path.join(root, "media", name), path.join(stage, "media", name), { recursive: true });
  }
  const manifest = structuredClone(base);
  manifest.displayName = `${base.displayName} — ${labels[profile]}`;
  manifest.harnessEdition = profile;
  manifest.description = `${labels[profile]} edition of Local LLM Harness: a local/LAN model with workspace tools.`;
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.dependencies;
  delete manifest.overrides;
  delete manifest.allowScripts;
  const properties = manifest.contributes.configuration.properties;
  if (profile === "no-commands" || profile === "safe-list") delete properties["localLlmHarness.autoapproveCommands"];
  if (profile === "safe-list") {
    properties["localLlmHarness.autoapproveSafeCommands"] = { type: "boolean", default: false, scope: "application", description: "Auto-approve all matching safe commands in Act mode, including deletion. Review mode always asks. User settings only." };
    properties["localLlmHarness.safeCommandPatterns"] = { type: "array", items: { type: "string", maxLength: 2048 }, maxItems: 128, default: await defaultPatterns(), scope: "application", description: "Whole-command regexes over executable and literal arguments separated by spaces. Arguments needing quoting use shell-style single quotes. Built-in workspace restrictions also apply. An empty list denies all commands. User settings only." };
  }
  if (profile === "advanced") properties["localLlmHarness.webSearchEndpoint"] = { type: "string", default: "", scope: "application", description: "SearXNG base URL with JSON search enabled. Each query requires approval. Use HTTPS, or HTTP on localhost/private IP. Blank disables search. User settings only." };
  await writeFile(path.join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const instructions = profile === "safe-list"
    ? "Commands require approval by default. Enable Auto-approve safe commands to approve all matching commands uniformly. Use Edit User Settings to configure safeCommandPatterns. Patterns match the entire normalized command; shell expansion and compound commands are unsupported. Paths for built-in filesystem commands are restricted to the workspace. Custom programs may access the network or run further code; this is not an OS sandbox."
    : profile === "no-commands" ? "Workspace file tools are available. This package contains no model command execution or web search implementation."
    : "Commands require approval by default. Auto-approve commands applies in Act mode; Review mode always asks. Commands inherit the editor's OS permissions.";
  const search = profile === "advanced" ? "\n\nConfigure webSearchEndpoint in Settings with your SearXNG base URL. Enable JSON search on that service. Each query requires approval and may be sent to external search engines. Results contain source URLs and snippets, not full pages." : "";
  await writeFile(path.join(stage, "README.md"), `# ${manifest.displayName}\n\n${instructions}${search}\n\nConfigure the local/LAN model endpoint in Settings. Commit-message generation uses the same VS Code Git integration in every edition. Installing another edition replaces this extension while preserving chats and shared preferences.\n`);
  await cp(path.join(root, "LICENSE"), path.join(stage, "LICENSE"));
  await auditStage(profile, stage, metadata);
  const filename = `${base.name}-${base.version}-${profile}.vsix`;
  const candidate = path.join(pending, filename);
  await rm(candidate, { force: true });
  await runVsce(stage, candidate);
  await auditArchive(profile, candidate);
}
// Promote only when every requested package has passed its archive audit.
if (!selected) {
  for (const filename of await readdir(output)) {
    if (filename.startsWith(`${base.name}-`) && filename.endsWith(".vsix")) await rm(path.join(output, filename));
  }
}
for (const profile of targets) {
  const filename = `${base.name}-${base.version}-${profile}.vsix`;
  await rm(path.join(output, filename), { force: true });
  await rename(path.join(pending, filename), path.join(output, filename));
}
console.log(`Packaged and verified ${targets.length} editions in artifacts/.`);
