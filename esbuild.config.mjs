import path from "node:path";
import { fileURLToPath } from "node:url";
import { root, profilePlugin, auditMetadata, assertProfile } from "./scripts/build-profiles.mjs";
import esbuild from "esbuild";
import { cp, mkdir, writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const profileArg = process.argv.find(arg => arg.startsWith("--profile="));
const profile = profileArg?.slice("--profile=".length) ?? "commands";
const outputArg = process.argv.find(arg => arg.startsWith("--outdir="));
const outputDir = path.resolve(outputArg?.slice("--outdir=".length) ?? "dist");
assertProfile(profile);

async function copyVendor() {
  await mkdir(path.join(outputDir, "webview/katex"), { recursive: true });
  await cp("node_modules/katex/dist", path.join(outputDir, "webview/katex"), { recursive: true });
}

const extensionCfg = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: path.join(outputDir, "extension.js"),
  platform: "node",
  target: "node18",
  format: "cjs",
  external: ["vscode"],
  sourcemap: false,
  metafile: true,
  minifySyntax: true,
  plugins: [profilePlugin(profile)],
  logLevel: "info"
};

const chatWebviewCfg = {
  entryPoints: ["src/ui/chatView/webview/main.ts"],
  bundle: true,
  outfile: path.join(outputDir, "webview/chat.js"),
  platform: "browser",
  target: "es2020",
  format: "iife",
  sourcemap: false,
  metafile: true,
  minifySyntax: true,
  plugins: [profilePlugin(profile)],
  loader: { ".css": "text" },
  logLevel: "info"
};

const sideWebviewCfg = {
  entryPoints: ["src/ui/sideView/webview/main.ts"],
  bundle: true,
  outfile: path.join(outputDir, "webview/side.js"),
  platform: "browser",
  target: "es2020",
  format: "iife",
  sourcemap: false,
  metafile: true,
  minifySyntax: true,
  plugins: [profilePlugin(profile)],
  loader: { ".css": "text" },
  logLevel: "info"
};

export async function buildProfile(selectedProfile, directory) {
  assertProfile(selectedProfile);
  const configs = [extensionCfg, chatWebviewCfg, sideWebviewCfg];
  await mkdir(path.join(directory, "webview/katex"), { recursive: true });
  await cp(path.join(root, "node_modules/katex/dist"), path.join(directory, "webview/katex"), { recursive: true });
  const results = await Promise.all(configs.map((config, index) => esbuild.build({
    ...config, absWorkingDir: root,
    outfile: path.join(directory, index === 0 ? "extension.js" : index === 1 ? "webview/chat.js" : "webview/side.js"),
    plugins: [profilePlugin(selectedProfile)]
  })));
  results.forEach(result => auditMetadata(selectedProfile, result.metafile));
  return results.map(result => result.metafile);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (watch) {
    await copyVendor();
    for (const cfg of [extensionCfg, chatWebviewCfg, sideWebviewCfg]) {
      const ctx = await esbuild.context(cfg);
      await ctx.watch();
    }
    console.log(`Watching ${profile}...`);
  } else {
    const metadata = await buildProfile(profile, outputDir);
    const reportDir = path.join(root, ".build", "reports");
    await mkdir(reportDir, { recursive: true });
    await writeFile(path.join(reportDir, `${profile}.json`), JSON.stringify(metadata));
    console.log(`Build complete: ${profile}`);
  }
}
