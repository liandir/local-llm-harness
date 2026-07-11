import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(import.meta.url);
const vsceBin = require.resolve("@vscode/vsce/vsce");

const mediaFiles = [
  "media/side.css",
  "media/chat.css",
  "media/activity-bar.svg",
  "media/activity-bar-wiggle.svg",
  "media/activity-bar-spin.svg",
  "media/activity-bar-command-wiggle-light.svg",
  "media/activity-bar-command-wiggle-dark.svg",
  "media/activity-bar-command-spin-light.svg",
  "media/activity-bar-command-spin-dark.svg",
  "media/activity-bar-command-light.svg",
  "media/activity-bar-command-dark.svg"
];

const katexFonts = [
  "KaTeX_AMS-Regular.woff2",
  "KaTeX_Caligraphic-Bold.woff2",
  "KaTeX_Caligraphic-Regular.woff2",
  "KaTeX_Fraktur-Bold.woff2",
  "KaTeX_Fraktur-Regular.woff2",
  "KaTeX_Main-Bold.woff2",
  "KaTeX_Main-BoldItalic.woff2",
  "KaTeX_Main-Italic.woff2",
  "KaTeX_Main-Regular.woff2",
  "KaTeX_Math-BoldItalic.woff2",
  "KaTeX_Math-Italic.woff2",
  "KaTeX_SansSerif-Bold.woff2",
  "KaTeX_SansSerif-Italic.woff2",
  "KaTeX_SansSerif-Regular.woff2",
  "KaTeX_Script-Regular.woff2",
  "KaTeX_Size1-Regular.woff2",
  "KaTeX_Size2-Regular.woff2",
  "KaTeX_Size3-Regular.woff2",
  "KaTeX_Size4-Regular.woff2",
  "KaTeX_Typewriter-Regular.woff2"
].map((name) => `dist/webview/katex/fonts/${name}`);

export const expectedSourceFiles = Object.freeze([
  "README.md",
  "package.json",
  "LICENSE",
  "SECURITY.md",
  ...mediaFiles,
  "dist/extension.js",
  "dist/webview/side.js",
  "dist/webview/chat.js",
  "dist/webview/katex/katex.min.css",
  ...katexFonts
]);

const expectedSourceSet = new Set(expectedSourceFiles);
const expectedArchiveSet = new Set([
  "extension.vsixmanifest",
  "[Content_Types].xml",
  ...expectedSourceFiles.map((file) => {
    if (file === "README.md") return "extension/readme.md";
    if (file === "LICENSE") return "extension/LICENSE.txt";
    return `extension/${file}`;
  })
]);

function assertSafeRelativePath(value, source) {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`${source} contains an unsafe package path: ${JSON.stringify(value)}`);
  }
  return value;
}

function assertExactManifest(actualPaths, expectedPaths, source) {
  const seen = new Set();
  for (const candidate of actualPaths) {
    const path = assertSafeRelativePath(candidate, source);
    if (seen.has(path)) {
      throw new Error(`${source} contains a duplicate path: ${path}`);
    }
    seen.add(path);
  }

  const unexpected = [...seen].filter((path) => !expectedPaths.has(path)).sort();
  const missing = [...expectedPaths].filter((path) => !seen.has(path)).sort();
  if (unexpected.length === 0 && missing.length === 0) return;

  const details = [];
  if (unexpected.length > 0) {
    details.push(`unexpected files:\n  ${unexpected.join("\n  ")}`);
  }
  if (missing.length > 0) {
    details.push(`missing required files:\n  ${missing.join("\n  ")}`);
  }
  throw new Error(`${source} does not match the release manifest (${details.join(";\n")})`);
}

/** Audit the file list VSCE would source from the working tree. */
export function auditVsceList() {
  const result = spawnSync(
    process.execPath,
    [vsceBin, "ls", "--no-dependencies"],
    { cwd: repoRoot, encoding: "utf8" }
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `vsce ls failed with status ${result.status}:\n${result.stderr || result.stdout}`
    );
  }

  const paths = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  assertExactManifest(paths, expectedSourceSet, "vsce ls");
  return paths;
}

function findEndOfCentralDirectory(bytes) {
  const minimumOffset = Math.max(0, bytes.length - 22 - 65_535);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("VSIX is not a supported ZIP archive (end record not found)");
}

function readZipEntries(bytes) {
  const eocdOffset = findEndOfCentralDirectory(bytes);
  const diskNumber = bytes.readUInt16LE(eocdOffset + 4);
  const centralDirectoryDisk = bytes.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocdOffset + 8);
  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = bytes.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = bytes.readUInt32LE(eocdOffset + 16);

  if (
    diskNumber !== 0 ||
    centralDirectoryDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralDirectoryOffset === 0xffffffff ||
    centralDirectorySize === 0xffffffff
  ) {
    throw new Error("Multi-disk and ZIP64 VSIX archives are not supported by the audit");
  }
  if (centralDirectoryOffset + centralDirectorySize > eocdOffset) {
    throw new Error("VSIX central directory is outside the archive bounds");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = [];
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error(`VSIX central-directory entry ${index} is malformed`);
    }

    const flags = bytes.readUInt16LE(cursor + 8);
    const filenameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const entryEnd = cursor + 46 + filenameLength + extraLength + commentLength;
    if (entryEnd > bytes.length) {
      throw new Error(`VSIX central-directory entry ${index} exceeds the archive bounds`);
    }
    if ((flags & 0x0001) !== 0) {
      throw new Error(`VSIX entry ${index} is encrypted`);
    }

    const filename = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + filenameLength));
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) {
      throw new Error(`VSIX contains a symbolic-link entry: ${filename}`);
    }
    if (filename.endsWith("/")) {
      throw new Error(`VSIX contains an unexpected directory entry: ${filename}`);
    }
    entries.push(filename);
    cursor = entryEnd;
  }

  if (cursor !== centralDirectoryOffset + centralDirectorySize) {
    throw new Error("VSIX central-directory size does not match its entries");
  }
  return entries;
}

/** Audit the actual archive, including VSIX metadata and VSCE-renamed docs. */
export async function auditVsix(vsixPath) {
  const entries = readZipEntries(await readFile(vsixPath));
  assertExactManifest(entries, expectedArchiveSet, "VSIX archive");
  return entries;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 0 && (args.length !== 2 || args[0] !== "--vsix")) {
    throw new Error("Usage: node scripts/package-audit.mjs [--vsix path/to/package.vsix]");
  }

  const sourceFiles = auditVsceList();
  console.log(`Package source audit passed (${sourceFiles.length} files).`);
  if (args.length === 2) {
    const archiveFiles = await auditVsix(args[1]);
    console.log(`VSIX archive audit passed (${archiveFiles.length} entries).`);
  }
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
