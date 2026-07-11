import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { auditVsceList, auditVsix } from "./package-audit.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const out = `${pkg.name}-${pkg.version}.vsix`;
const require = createRequire(import.meta.url);
const vsceBin = require.resolve("@vscode/vsce/vsce");
// Keep staging inside the workspace because constrained build environments may
// not allow VSCE's prepublish subprocesses to operate with an external output.
// VSCE ignores every *.vsix while collecting files, including this random path.
const stagedVsix = join(repoRoot, `.${out}.${randomUUID()}.staging.vsix`);

try {
  const result = spawnSync(
    process.execPath,
    [
      vsceBin,
      "package",
      "--no-dependencies",
      "--allow-missing-repository",
      "--skip-license",
      "--out",
      stagedVsix
    ],
    {
      cwd: repoRoot,
      stdio: "inherit"
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`VSCE packaging failed with status ${result.status}`);
  }

  const sourceFiles = auditVsceList();
  const archiveFiles = await auditVsix(stagedVsix);
  await copyFile(stagedVsix, join(repoRoot, out));
  console.log(
    `Package audit passed (${sourceFiles.length} source files, ${archiveFiles.length} archive entries).`
  );
  console.log(`Published verified package to ${out}`);
} finally {
  await rm(stagedVsix, { force: true });
}
