import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const out = `${pkg.name}-${pkg.version}.vsix`;
const require = createRequire(import.meta.url);
const vsceBin = require.resolve("@vscode/vsce/vsce");

const result = spawnSync(
  process.execPath,
  [
    vsceBin,
    "package",
    "--no-dependencies",
    "--allow-missing-repository",
    "--skip-license",
    "--out",
    out
  ],
  {
    cwd: repoRoot,
    stdio: "inherit"
  }
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
