import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";

/** Local review adapter for the shared generation ledger. No provider or
 * business callback runs here; recording and currentness belong to the host's
 * existing project mutation lease and Resume compare-and-swap. */
export async function reviewInterruptedAuthoringStep<T>(input: {
  session: Pick<BoundaryReviewInteractiveSession, "chooseOption" | "confirm" | "showReviewDetails">;
  businessContext: string[];
  prepare(): Promise<{ preview: T; details: string[]; canContinue: boolean }>;
  record(preview: T, mode: "linked_generation" | "local_review"): Promise<void>;
}): Promise<"recorded" | "pending"> {
  const { preview, details, canContinue } = await input.prepare();
  let choice: string | undefined;
  do {
    choice = await input.session.chooseOption?.("REVIEW INTERRUPTED BUSINESS STEP", [
      { value: "details", label: "Inspect saved work and the interrupted step" },
      ...(canContinue ? [{ value: "continue", label: "Continue this unfinished step within its remaining limits" }] : []),
      { value: "review", label: "Retain the interruption and review current saved work" },
      { value: "pause", label: "Keep the step pending" },
    ], { initialValue: "pause", displayContext: true, context: [
      ...input.businessContext,
      "The earlier result remains uncertain. Runner will not accept its late output or mark it completed.",
      "A recorded recovery retains existing limits, saved answers and current reviews; it grants no publication or execution authority.",
    ] });
    if (choice === "details") await input.session.showReviewDetails?.("Interrupted step and exact saved state", details);
  } while (choice === "details");
  if (choice !== "review" && (choice !== "continue" || !canContinue)) return "pending";
  const mode = choice === "continue" ? "linked_generation" : "local_review";
  const confirmed = await input.session.confirm(
    "Stop accepting the interrupted result and record recovery of this exact unfinished step?",
    { defaultValue: false, context: [
      ...input.businessContext,
      "Its original attempt, possible charge and uncertainty remain recorded. No request is sent by this decision.",
      "Ordinary continuation still checks the same limits, current policy, privacy consent and saved review. A missing or exhausted allowance does not become a fresh allowance.",
    ], exactDetails: { title: "EXACT INTERRUPTED STEP RECOVERY", lines: details } },
  );
  if (confirmed !== true) return "pending";
  await input.record(preview, mode);
  return "recorded";
}
