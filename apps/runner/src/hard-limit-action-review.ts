import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { inspectSemanticActionActivationWriterSetup } from "./semantic-action-deployment.js";
import { hardLimitWriterSetupLines } from "./hard-limit-writer-setup.js";

/** Wires the existing public review to a fresh writer readback. It neither
 * confirms the business rules nor publishes authority. */
export async function reviewHardLimitActionWriter(input: Parameters<typeof inspectSemanticActionActivationWriterSetup>[0]
  & { session: BoundaryReviewInteractiveSession }): Promise<boolean> {
  const readback = await inspectSemanticActionActivationWriterSetup(input);
  if (readback.status === "not_required") return true;
  const lines = hardLimitWriterSetupLines(readback);
  input.session.rememberDetails?.("Hard-limit writer prerequisites", lines);
  if (readback.status === "ready") return true;
  await input.session.showReviewDetails?.("Hard-limit writer prerequisites", [
    ...lines, "The disabled business rules remain saved. Configure the dedicated writer, then resume this review.",
    "No Action activation, execution approval, or Source change occurred.",
  ]);
  return false;
}
