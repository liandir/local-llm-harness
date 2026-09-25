import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { assertProfile, auditMetadata } from "./build-profiles.mjs";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl");
const optionalNames = {
  commands: ["run_command", "run_process", "wait_process", "stop_process", "autoapproveCommands", "CommandRuntime", "startManagedProcess"],
  safe: ["safeCommandPatterns", "autoapproveSafeCommands", "authorizeCommand", "matchesSafeList"],
  search: ["web_search", "webSearchEndpoint", "searchSearxng"]
};

function auditText(profile, name, text) {
  const forbidden = [...(profile === "no-commands" ? optionalNames.commands : []),
    ...(profile !== "safe-list" ? optionalNames.safe : []), ...(profile !== "advanced" ? optionalNames.search : [])];
  for (const marker of forbidden) if (text.includes(marker)) throw new Error(`${profile}: ${name} contains excluded feature marker ${marker}`);
  if (profile === "no-commands" && /(?:node:)?child_process/.test(text)) throw new Error(`${profile}: subprocess dependency in ${name}`);
  if (profile === "safe-list" && /shell:\s*(?:true|!0)|function startCommand\(/.test(text)) throw new Error(`${profile}: unchecked shell runner in ${name}`);
}

export async function auditStage(profile, directory, metadata) {
  assertProfile(profile);
  metadata.forEach(report => auditMetadata(profile, report));
  for (const file of ["dist/extension.js", "dist/webview/chat.js", "dist/webview/side.js", "package.json"]) {
    auditText(profile, file, await readFile(path.join(directory, file), "utf8"));
  }
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  if (manifest.harnessEdition !== profile) throw new Error("Manifest edition does not match build.");
  const entries = await readdir(directory);
  if (entries.some(name => !["dist", "media", "package.json", "README.md", "LICENSE"].includes(name))) throw new Error("Unexpected file in package staging directory.");
}

export async function auditArchive(profile, filename) {
  assertProfile(profile);
  const entries = new Map();
  await new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", entry => {
        const name = entry.fileName;
        if (name.endsWith("/")) { zip.readEntry(); return; }
        if (/\.map$|(?:^|\/)(?:src|test|scripts|node_modules|\.build|artifacts)\//.test(name)) {
          zip.close(); reject(new Error(`Unshipped source/build content in archive: ${name}`)); return;
        }
        if (profile === "no-commands" && name.endsWith("/commands.css")) {
          zip.close(); reject(new Error("Command styles leaked into No commands")); return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) { reject(streamError); return; }
          const chunks = [];
          stream.on("error", reject);
          stream.on("data", chunk => chunks.push(chunk));
          stream.on("end", () => {
            try {
              const buffer = Buffer.concat(chunks);
              entries.set(name, buffer);
              if (/\.(?:js|json|css|md)$/.test(name)) auditText(profile, name, buffer.toString());
              zip.readEntry();
            } catch (err) { zip.close(); reject(err); }
          });
        });
      });
      zip.readEntry();
    });
  });
  for (const file of ["package.json", "dist/extension.js", "dist/webview/chat.js", "dist/webview/side.js"]) {
    if (!entries.has(`extension/${file}`)) throw new Error(`Missing packaged entry: ${file}`);
  }
  const manifest = JSON.parse(entries.get("extension/package.json").toString());
  if (manifest.harnessEdition !== profile) throw new Error("Packaged manifest has wrong edition.");
  return entries;
}
