import { sideFeature as commands } from "../commands/full/side.js";
import type { SideFeature } from "../../build/sideContracts.js";
export const sideFeature: SideFeature = {
  label: "Advanced",
  render: (settings, toggle, escape) => commands.render(settings, toggle, escape) + `<label class="field-label" for="webSearchEndpoint">SearXNG URL</label><input id="webSearchEndpoint" type="url" value="${escape(String(settings.webSearchEndpoint ?? ""))}" placeholder="http://localhost:8888" /><p class="setting-help">Use a SearXNG instance with JSON search enabled. Each query requires approval and is sent to external search engines. Leave blank to disable search.</p>`,
  bind(root, send) {
    commands.bind(root, send);
    root.querySelector<HTMLInputElement>("#webSearchEndpoint")?.addEventListener("change", event => send({ type: "saveSetting", key: "webSearchEndpoint", value: (event.target as HTMLInputElement).value.trim() }));
  }
};
