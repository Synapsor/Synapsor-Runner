import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { inspectSemanticActionActivationWriterSetup, type HardLimitWriterReviewBinding } from "./semantic-action-deployment.js";
import { hardLimitWriterSetupLines } from "./hard-limit-writer-setup.js";
import { HardLimitWriterReviewChangedError } from "./hard-limit-writer-review-binding.js";

export type HardLimitActionWriterReview = {
  ready: boolean;
  writerReviewBinding?: HardLimitWriterReviewBinding;
};

/** Wires the existing public review to a fresh writer readback. It neither
 * confirms the business rules nor publishes authority. */
export async function reviewHardLimitActionWriter(input: Parameters<typeof inspectSemanticActionActivationWriterSetup>[0]
  & { session: BoundaryReviewInteractiveSession }): Promise<HardLimitActionWriterReview> {
  const readback = await inspectSemanticActionActivationWriterSetup(input);
  if (readback.status === "not_required") return { ready: true };
  const lines = hardLimitWriterSetupLines(readback);
  input.session.rememberDetails?.("Hard-limit writer prerequisites", lines);
  await input.session.showReviewDetails?.("Hard-limit writer prerequisites", readback.status === "ready" ? lines : [
    ...lines, "The disabled business rules remain saved. Configure the dedicated writer, then resume this review.",
    "No Action activation, execution approval, or Source change occurred.",
  ]);
  if (readback.status !== "ready") return { ready: false };
  if (!readback.writerReviewBinding) throw new HardLimitWriterReviewChangedError();
  return { ready: true, writerReviewBinding: readback.writerReviewBinding };
}
