import esbuild from "esbuild";
import { cp, mkdir } from "node:fs/promises";

const watch = process.argv.includes("--watch");

async function copyVendor() {
  await mkdir("dist/webview/katex", { recursive: true });
  await cp("node_modules/katex/dist", "dist/webview/katex", { recursive: true });
}

const extensionCfg = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  target: "node18",
  format: "cjs",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "info"
};

const chatWebviewCfg = {
  entryPoints: ["src/ui/chatView/webview/main.ts"],
  bundle: true,
  outfile: "dist/webview/chat.js",
  platform: "browser",
  target: "es2020",
  format: "iife",
  sourcemap: true,
  loader: { ".css": "text" },
  logLevel: "info"
};

const sideWebviewCfg = {
  entryPoints: ["src/ui/sideView/webview/main.ts"],
  bundle: true,
  outfile: "dist/webview/side.js",
  platform: "browser",
  target: "es2020",
  format: "iife",
  sourcemap: true,
  loader: { ".css": "text" },
  logLevel: "info"
};

if (watch) {
  await copyVendor().catch(() => {});
  for (const cfg of [extensionCfg, chatWebviewCfg, sideWebviewCfg]) {
    const ctx = await esbuild.context(cfg);
    await ctx.watch();
  }
  console.log("Watching...");
} else {
  await copyVendor();
  await Promise.all([
    esbuild.build(extensionCfg),
    esbuild.build(chatWebviewCfg),
    esbuild.build(sideWebviewCfg)
  ]);
  console.log("Build complete.");
}
