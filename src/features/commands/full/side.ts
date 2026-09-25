import type { SideFeature } from "../../../build/sideContracts.js";
export const sideFeature: SideFeature = {
  label: "Commands",
  render: (settings, toggle) => toggle("autoapproveCommands", "Auto-approve commands", settings.autoapproveCommands === true),
  bind(root, send) {
    root.querySelector<HTMLInputElement>("#autoapproveCommands")?.addEventListener("change", event => {
      send({ type: "saveSetting", key: "autoapproveCommands", value: (event.target as HTMLInputElement).checked });
    });
  }
};
