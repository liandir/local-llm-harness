import type { SideFeature } from "../../../build/sideContracts.js";
export const sideFeature: SideFeature = {
  label: "Safe list",
  render: (settings, toggle) => toggle("autoapproveSafeCommands", "Auto-approve safe commands", settings.autoapproveSafeCommands === true)
    + '<p class="setting-help">Configure command regexes through Edit User Settings. All matching commands use the same approval setting; unmatched commands are refused.</p>',
  bind(root, send) {
    root.querySelector<HTMLInputElement>("#autoapproveSafeCommands")?.addEventListener("change", event => {
      send({ type: "saveSetting", key: "autoapproveSafeCommands", value: (event.target as HTMLInputElement).checked });
    });
  }
};
