import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import type { ActionRuleModelPreparedContext } from "./action-rule-model.js";
import { preparePrivateActionSource } from "./action-rule-resource-review.js";
import { reviewPrivateActionSourceForModel } from "./action-rule-source-consent.js";

vi.mock("./action-rule-resource-review.js", () => ({ preparePrivateActionSource: vi.fn() }));

describe("private source metadata consent", () => {
  const context = { builtCatalog: { catalog: { resources: [] } }, readBoundary: { pack: { name: "student" } },
    readBoundaryDigest: canonicalJsonDigest("read") } as unknown as ActionRuleModelPreparedContext;
  const review = { resource: "school.admissions", parent_resource: "school.students", relationship: "admissions_student_fk",
    proof_digest: canonicalJsonDigest("scoped-source-proof") };
  const prepared = { built: structuredClone(context.builtCatalog), review, details: ["Fields: private_status, effective_from, effective_until"] };
  beforeEach(() => { vi.mocked(preparePrivateActionSource).mockReset().mockReturnValue(prepared); });
  const input = (selection: string | undefined) => ({
    request: { context, resource: review.resource, parentResource: review.parent_resource },
    inspection: {} as SchemaInspection, modelLabel: "openai[gpt-5.6-terra]", assertCurrent: vi.fn(async () => {}),
    session: { chooseOption: vi.fn(async () => selection) } as unknown as BoundaryReviewInteractiveSession,
  });

  it("shows complete metadata locally while permission narration receives only an already-known source and purpose", async () => {
    const args = input("allow");
    const before = structuredClone(context);
    expect(await reviewPrivateActionSourceForModel(args)).toEqual({ ...context, builtCatalog: prepared.built, review });
    const [, , options] = vi.mocked(args.session.chooseOption!).mock.calls[0]!;
    expect(options?.exactDetails?.lines.join("\n")).toContain("private_status");
    expect(JSON.stringify({ context: options?.context, explanation: options?.explanationContext })).not.toContain("private_status");
    expect(options).toMatchObject({ initialValue: "pending", requireExplicitSelection: true, explainOnRequest: true });
    expect(args.assertCurrent).toHaveBeenCalledTimes(2);
    expect(context).toEqual(before);
  });

  it.each(["pending", undefined])("does not return private metadata after decline or cancellation (%s)", async selection => {
    const args = input(selection);
    expect(await reviewPrivateActionSourceForModel(args)).toBeUndefined();
    expect(args.assertCurrent).toHaveBeenCalledOnce();
  });

  it("restores only the exact saved proof without a new model request or permission loop", async () => {
    const args = input("pending");
    expect(await reviewPrivateActionSourceForModel({ ...args, request: { ...args.request, previousReview: review } }))
      .toEqual({ ...context, builtCatalog: prepared.built, review });
    expect(args.session.chooseOption).not.toHaveBeenCalled();
    expect(args.assertCurrent).toHaveBeenCalledOnce();
    await expect(reviewPrivateActionSourceForModel({ ...args, request: { ...args.request,
      previousReview: { ...review, proof_digest: canonicalJsonDigest("old") } } })).rejects.toThrow("CHECKPOINT_STALE");
    expect(args.session.chooseOption).not.toHaveBeenCalled();
  });

  it("refuses a concurrent review change after permission instead of returning stale metadata", async () => {
    const args = input("allow");
    args.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("review changed"));
    await expect(reviewPrivateActionSourceForModel(args)).rejects.toThrow("review changed");
    expect(args.assertCurrent).toHaveBeenCalledTimes(2);
  });

  it.each(["allow", "pending", undefined])("reviews changed private metadata explicitly during saved-component revalidation (%s)", async selection => {
    const args = input(selection);
    const previousReview = { ...review, proof_digest: canonicalJsonDigest("old source proof") };
    const result = await reviewPrivateActionSourceForModel({ ...args,
      request: { ...args.request, previousReview, revalidatePreviousReview: true } });
    expect(args.session.chooseOption).toHaveBeenCalledOnce();
    expect(result).toEqual(selection === "allow" ? { ...context, builtCatalog: prepared.built, review } : undefined);
    expect(previousReview.proof_digest).toBe(canonicalJsonDigest("old source proof"));
    expect(args.assertCurrent).toHaveBeenCalledTimes(selection === "allow" ? 2 : 1);
  });
});
