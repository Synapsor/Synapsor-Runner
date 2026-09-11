import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { ModelActionRuleDraftInput } from "./action-rule-model.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { preparePrivateActionSource } from "./action-rule-resource-review.js";

/** Exact metadata is local until the operator permits this catalog expansion. */
export async function reviewPrivateActionSourceForModel(input: {
  request: Parameters<NonNullable<ModelActionRuleDraftInput["reviewPrivateSource"]>>[0];
  inspection: SchemaInspection;
  session: BoundaryReviewInteractiveSession;
  modelLabel: string;
  assertCurrent: () => Promise<void>;
}) {
  await input.assertCurrent();
  const { request } = input;
  const prepared = preparePrivateActionSource({ built: request.context.builtCatalog, boundary: request.context.readBoundary,
    inspection: input.inspection, resource: request.resource, parentResource: request.parentResource });
  const sameProof = request.previousReview && canonicalJsonDigest(prepared.review) === canonicalJsonDigest(request.previousReview);
  if (request.previousReview && !sameProof && !request.revalidatePreviousReview) {
    throw new Error("ACTION_AUTHORING_CHECKPOINT_STALE: The supporting source changed. Re-review its metadata; saved rules and active authority are unchanged.");
  }
  if (!sameProof) {
    if (!input.session.chooseOption) throw new Error("PRIVATE_SOURCE_REVIEW_REQUIRED: Resume guided setup to review the additional private source. No metadata was transferred.");
    const exact = { title: "PRIVATE SUPPORTING SOURCE", lines: [
      `Destination: ${input.modelLabel}`, ...prepared.details,
      "This permits the reviewed structural metadata in this authoring conversation only, never source rows.",
      "No public Read access, writes or activation. The existing business rules still need complete validation.",
    ] };
    const selected = await input.session.chooseOption("REVIEW SUPPORTING SOURCE", [
      { value: "allow", label: "Use this source for private verification", detail: "Send the reviewed metadata; keep its data out of customer reads and changes." },
      { value: "pending", label: "Keep this requirement pending", detail: "Do not send additional metadata or change the draft." },
    ], { initialValue: "pending", requireExplicitSelection: true, explainOnRequest: true,
      context: [`The model needs additional structural information for ${request.resource}.`,
        "Runner will check it privately. This does not make its records readable or writable by the agent.",
        "Exact details shows the fields and relationship before you allow the transfer."],
      // Narration must not receive the new field inventory before this consent.
      explanationContext: ["Permission to send one additional inspected supporting source's structural metadata for private verification. No rows, public reads, writes or activation."],
      exactDetails: exact,
    });
    if (selected !== "allow") return undefined;
    await input.assertCurrent();
  }
  return { ...request.context, builtCatalog: prepared.built, review: prepared.review };
}
