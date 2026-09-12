import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { ModelActionRuleDraftInput } from "./action-rule-model.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { preparePrivateActionSource } from "./action-rule-resource-review.js";
import { inspectedPostgresScopeMapping } from "./inspected-scope-mapping.js";

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
  if (request.prerequisite) {
    const child = prepared.built.catalog.resources.find(resource => resource.name === request.resource)!;
    const parent = request.context.readBoundary.pack.resources.find(resource => resource.id === request.parentResource);
    const settings = parent?.rls_session;
    const scope = settings?.tenant_setting && settings.principal_setting && child.tenant_key ? inspectedPostgresScopeMapping({ inspection: input.inspection,
      resource: { schema: child.schema, table: child.table, fields: child.fields.map(field => field.name) },
      tenantField: child.tenant_key, tenantSetting: settings.tenant_setting, principalSetting: settings.principal_setting }) : undefined;
    if (prepared.review.relationship !== request.prerequisite.relationship || request.prerequisite.collection_consistency !== "complete_locked"
      || !scope || scope.principal.field !== child.principal_scope_key) {
      throw new Error("ACTION_RULE_PRIVATE_SOURCE_REVIEW_REQUIRED: The retained complete collection needs its exact current relationship and unfiltered direct tenant/principal read scope. Keep the absence/aggregate condition pending; no metadata was transferred or Read access changed.");
    }
  }
  const sameProof = request.previousReview && canonicalJsonDigest(prepared.review) === canonicalJsonDigest(request.previousReview);
  if (request.previousReview && !sameProof && !request.revalidatePreviousReview) {
    throw new Error("ACTION_AUTHORING_CHECKPOINT_STALE: The supporting source changed. Re-review its metadata; saved rules and active authority are unchanged.");
  }
  if (!sameProof) {
    if (!input.session.chooseOption) throw new Error("PRIVATE_SOURCE_REVIEW_REQUIRED: Resume guided setup to review the additional private source. No metadata was transferred.");
    const exact = { title: "PRIVATE SUPPORTING SOURCE", lines: [
      `Destination: ${input.modelLabel}`, ...prepared.details,
      ...(request.prerequisite ? ["The saved rule still uses this complete collection, but its prepared relationship needs current review.",
        "Read exclusion is not private-verification approval. This review permits only the exact private prerequisite; the complete saved rule must be revalidated."] : []),
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
