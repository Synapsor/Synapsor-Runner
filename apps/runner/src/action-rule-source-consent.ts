import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { ModelActionRuleDraftInput } from "./action-rule-model.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { preparePrivateActionSource, PrivateSingletonScopeReviewRequired } from "./action-rule-resource-review.js";
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
  const base = { built: request.context.builtCatalog, boundary: request.context.readBoundary,
    inspection: input.inspection, resource: request.resource, parentResource: request.parentResource };
  const previousMapping = request.previousReview?.evidence_mode === "required_scoped_singleton" && request.previousReview.scope_mapping
    ? { relationship: request.previousReview.relationship, ...request.previousReview.scope_mapping } : undefined;
  let prepared;
  try { prepared = preparePrivateActionSource({ ...base, ...(previousMapping ? { requiredSingletonScope: previousMapping } : {}) }); }
  catch (error) {
    if (!(error instanceof PrivateSingletonScopeReviewRequired) || request.prerequisite?.collection_consistency || !input.session.chooseOption) throw error;
    const choose = async (title: string, values: string[], detail: string) => {
      // Menu control values are separate from arbitrary catalogue identifiers.
      const selected = await input.session.chooseOption!(title,
        [...values.map((value, index) => ({ value: `column:${index}`, label: value, detail })),
          { value: "pending", label: "Keep pending", detail: "Do not confirm a mapping or transfer metadata." }],
        { initialValue: "pending", requireExplicitSelection: true, context: ["Choose only a source fact whose meaning you have reviewed. A foreign key does not establish tenant/principal meaning."] });
      const index = selected && /^column:[0-9]+$/u.test(selected) ? Number(selected.slice(7)) : -1;
      return Number.isSafeInteger(index) && index >= 0 && index < values.length ? values[index] : undefined;
    };
    const relationship = await choose("PRIVATE REQUIRED SINGLETON LINK", error.options.relationships, "Catalogue-proven immediate at-most-one linkage; not a scope or existence guarantee.");
    if (!relationship) return undefined;
    const tenant_field = await choose("PRIVATE TRUSTED TENANT COLUMN", error.options.tenant_fields, "This column represents the same trusted tenant domain as the reviewed subject.");
    if (!tenant_field) return undefined;
    const principal_field = await choose("PRIVATE TRUSTED PRINCIPAL COLUMN", error.options.principal_fields.filter(name => name !== tenant_field), "This column represents the same trusted principal domain as the reviewed subject.");
    if (!principal_field) return undefined;
    await input.assertCurrent();
    prepared = preparePrivateActionSource({ ...base, requiredSingletonScope: { relationship, tenant_field, principal_field } });
  }
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
  if (prepared.review.evidence_mode && request.previousReview?.scope_confirmation
    && request.previousReview.proof_digest === prepared.review.proof_digest) {
    prepared.review.scope_confirmation = structuredClone(request.previousReview.scope_confirmation);
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
    if (prepared.review.evidence_mode) prepared.review.scope_confirmation = {
      actor: "local_installation_operator", confirmed_at: new Date().toISOString(),
    };
  }
  return { ...request.context, builtCatalog: prepared.built, review: prepared.review };
}
