export function cliPrivacyReviewInstructions(input: {
  boundary?: string;
  resource?: string;
  requireSuppressionOff?: boolean;
}): string {
  const boundary = input.boundary ?? "the active boundary";
  const resource = input.resource ?? "the affected table";
  const valueInstruction = input.requireSuppressionOff
    ? "Enter 1 to turn small-group suppression off, then enter a short reason."
    : "Enter a new minimum group size from 1 through 5, then enter a short reason. A value of 1 turns small-group suppression off.";
  return [
    "To change this in the CLI:",
    "  1. Type /access in Ask, or run synapsor-runner boundary review --access from your shell.",
    `  2. If the boundary list appears, select ${boundary} and press Enter.`,
    `  3. Highlight ${resource}; do not open its columns. Press P (Privacy) for the highlighted table.`,
    `  4. ${valueInstruction}`,
    "  5. At Save this privacy change? [Y/n], press Enter to save the disabled draft.",
    "  6. At Review and activate this boundary change now? [Y/n], press Enter again. If you postpone activation, press C later from the boundary screen.",
  ].join("\n");
}
