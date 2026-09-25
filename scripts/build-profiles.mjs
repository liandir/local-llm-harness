import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("..", import.meta.url));
export const profiles = ["no-commands", "safe-list", "commands", "advanced"];
const selections = {
  "no-commands": { tools: "none/tools", runtime: "none/runtime", settings: "none/settings", prompt: "none/prompt", side: "none/side", chat: "none/chat", assets: "none/assets" },
  "safe-list": { tools: "commands/safeList/definitions", runtime: "commands/safeList/runtime", settings: "commands/safeList/settings", prompt: "commands/safeList/prompt", side: "commands/safeList/side", chat: "commands/shared/ui" },
  commands: { tools: "commands/full/tools", runtime: "commands/full/runtime", settings: "commands/full/settings", prompt: "commands/full/prompt", side: "commands/full/side", chat: "commands/shared/ui" },
  advanced: { tools: "advanced/tools", runtime: "advanced/runtime", settings: "advanced/settings", prompt: "advanced/prompt", side: "advanced/side", chat: "advanced/chat", networkPolicy: "webSearch/networkPolicy" }
};

export function assertProfile(profile) {
  if (!profiles.includes(profile)) throw new Error(`Unknown build profile: ${profile}`);
}

export function forbiddenInput(profile, name) {
  const file = name.replaceAll("\\", "/");
  if (profile !== "advanced" && /src\/features\/(webSearch|advanced)\//.test(file)) return true;
  if (profile !== "safe-list" && /src\/features\/commands\/safeList\//.test(file)) return true;
  if (profile === "safe-list" && (/src\/features\/commands\/full\//.test(file) || file.endsWith("src/tools/terminalTool.ts"))) return true;
  if (profile === "no-commands" && (/src\/features\/commands\//.test(file) || /src\/(tools\/terminalTool|ui\/commandDisplay|util\/exec)\.ts$/.test(file))) return true;
  return false;
}

/** Resolve one edition before loading source. Forbidden imports fail even if unused. */
export function profilePlugin(profile) {
  assertProfile(profile);
  return {
    name: `edition-${profile}`,
    setup(build) {
      build.onResolve({ filter: /(?:^|\/)build\/(tools|runtime|settings|prompt|side|chat|assets|networkPolicy)\.js$/ }, args => {
        const name = path.basename(args.path, ".js");
        const selected = selections[profile][name];
        return { path: path.join(root, selected ? `src/features/${selected}.ts` : `src/build/${name}.ts`) };
      });
      build.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, args => {
        if (forbiddenInput(profile, args.path)) return { errors: [{ text: `${profile} must not include ${path.relative(root, args.path)}` }] };
      });
    }
  };
}

export function auditMetadata(profile, metadata) {
  for (const [name, input] of Object.entries(metadata.inputs)) {
    if (forbiddenInput(profile, name)) throw new Error(`Forbidden ${profile} bundle input: ${name}`);
    if (profile === "no-commands" && input.imports.some(item => /^(?:node:)?(?:child_process|worker_threads)$/.test(item.path))) {
      throw new Error(`Execution dependency in No commands: ${name}`);
    }
  }
}
