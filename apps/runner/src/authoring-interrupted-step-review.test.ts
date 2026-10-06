import { describe, expect, it, vi } from "vitest";
import { reviewInterruptedAuthoringStep } from "./authoring-interrupted-step-review.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";

const preview = { operation_id: "old-step", checkpoint_digest: "saved-revision" };
const create = (choice: string | undefined, confirmed: boolean | undefined, canContinue = true) => ({
  session: {
    chooseOption: vi.fn<NonNullable<BoundaryReviewInteractiveSession["chooseOption"]>>(async () => choice),
    confirm: vi.fn<BoundaryReviewInteractiveSession["confirm"]>(async () => confirmed),
    showReviewDetails: vi.fn<NonNullable<BoundaryReviewInteractiveSession["showReviewDetails"]>>(async () => {}),
  },
  businessContext: ["Unfinished task: establish the acceptance rule"],
  prepare: vi.fn(async () => ({ preview, details: ["Exact saved pending answer and counters"], canContinue })),
  record: vi.fn(async () => {}),
});

describe("local interrupted business-step review", () => {
  it.each([undefined, "pause"])("keeps cancellation/default pause pending without authority or another request (%s)", async choice => {
    const input = create(choice, true);
    expect(await reviewInterruptedAuthoringStep(input)).toBe("pending");
    expect(input.record).not.toHaveBeenCalled();
    expect(input.session.confirm).not.toHaveBeenCalled();
    expect(input.session.chooseOption.mock.calls[0]?.[2]).toMatchObject({ initialValue: "pause" });
  });
  it.each([false, undefined])("does not record a declined/unknown confirmation (%s)", async confirmed => {
    const input = create("continue", confirmed);
    expect(await reviewInterruptedAuthoringStep(input)).toBe("pending");
    expect(input.record).not.toHaveBeenCalled();
    expect(input.session.confirm.mock.calls[0]?.[1]).toMatchObject({ defaultValue: false });
  });
  it("records the exact preview only after consent, without treating inspection as completion", async () => {
    const input = create("continue", true);
    input.session.chooseOption.mockResolvedValueOnce("details").mockResolvedValueOnce("continue");
    expect(await reviewInterruptedAuthoringStep(input)).toBe("recorded");
    expect(input.record).toHaveBeenCalledExactlyOnceWith(preview, "linked_generation");
    expect(input.session.showReviewDetails).toHaveBeenCalledOnce();
  });
  it("keeps a local saved-work review available when the generation allowance is exhausted", async () => {
    const input = create("review", true, false);
    expect(await reviewInterruptedAuthoringStep(input)).toBe("recorded");
    expect(input.record).toHaveBeenCalledExactlyOnceWith(preview, "local_review");
    expect(input.session.chooseOption.mock.calls[0]?.[1]).not.toContainEqual(expect.objectContaining({ value: "continue" }));
    const forged = create("continue", true, false);
    expect(await reviewInterruptedAuthoringStep(forged)).toBe("pending");
    expect(forged.record).not.toHaveBeenCalled();
  });
  it("propagates a stale or unacknowledged durable write; no success is inferred", async () => {
    const input = create("continue", true);
    input.record.mockRejectedValue(new Error("BOUNDARY_AUTHORING_RESUME_CHANGED"));
    await expect(reviewInterruptedAuthoringStep(input)).rejects.toThrow("BOUNDARY_AUTHORING_RESUME_CHANGED");
    expect(input.record).toHaveBeenCalledOnce();
  });
});
