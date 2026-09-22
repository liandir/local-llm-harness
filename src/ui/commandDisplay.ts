/** Keep launched commands and subsequent process controls identical in the UI. */
export function toolCommandText(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "run_process") {
    const argv = Array.isArray(args.args) ? args.args.filter(value => typeof value === "string") : [];
    return [String(args.program ?? ""), ...argv].join(" ").trim();
  }
  return String(args.command ?? "");
}
