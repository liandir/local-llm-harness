const UNLISTED_COMMAND_HINT =
  "This command is not on the safe list, so it cannot be auto-approved. Review it carefully before approving.";

export function approvalHintForCategory(category: string): string | undefined {
  return category === "command" ? UNLISTED_COMMAND_HINT : undefined;
}
