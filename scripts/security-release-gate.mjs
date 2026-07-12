import { readFile } from "node:fs/promises";

const gateUrl = new URL("../security-gates.json", import.meta.url);
const gate = JSON.parse(await readFile(gateUrl, "utf8"));

if (gate.schemaVersion !== 1 || !Array.isArray(gate.blockingFindings)) {
  console.error("Invalid security-gates.json; refusing to release.");
  process.exit(1);
}

if (gate.releaseStatus !== "ready" || gate.blockingFindings.length > 0) {
  console.error("Release blocked by the security release gate.");
  for (const finding of gate.blockingFindings) {
    console.error(`- ${finding.id} (phase ${finding.targetPhase}): ${finding.summary}`);
  }
  console.error(
    "Set releaseStatus to ready only after every finding has a passing regression test and remove all resolved entries."
  );
  process.exit(1);
}

console.log("Security release gate passed.");
