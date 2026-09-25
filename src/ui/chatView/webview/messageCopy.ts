type CopyablePart =
  | { kind: "text" | "summary"; text: string }
  | { kind: "abort"; reason: string }
  | { kind: "thought" | "tool" };

interface RenderUnit {
  kind: "work" | "inline";
  parts: readonly CopyablePart[];
}

/** Copy the terminal visible response, never the work history preceding it. */
export function copyableAssistantText(units: readonly RenderUnit[]): string {
  const finalUnit = units.at(-1);
  if (finalUnit?.kind !== "inline") return "";
  const part = finalUnit.parts[0];
  if (part?.kind === "text" || part?.kind === "summary") return part.text;
  if (part?.kind === "abort") return part.reason;
  return "";
}
