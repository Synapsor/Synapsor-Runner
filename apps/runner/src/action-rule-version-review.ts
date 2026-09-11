import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { rolePostureFingerprint, schemaFingerprintForInspection, type SchemaInspection } from "@synapsor-runner/schema-inspector";
import type { GenerationLock } from "./auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import type { ReviewedActionVersionField } from "./action-rule-authoring-checkpoint.js";
import type { ActionRuleModelPreparedContext } from "./action-rule-model.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";

export function prepareActionVersionField(input: {
  context: ActionRuleModelPreparedContext;
  inspection: SchemaInspection;
  generationLock: GenerationLock;
  resource: string;
  field: string;
}) {
  const { context, inspection, generationLock, resource, field } = input;
  if (canonicalJsonDigest(generationLock) !== context.readBoundary.generation_lock_fingerprint
    || generationLock.schema_fingerprint !== schemaFingerprintForInspection(inspection)
    || generationLock.engine !== inspection.engine
    || generationLock.role_posture_fingerprint !== rolePostureFingerprint(inspection)
    || context.readBoundary.role_posture_fingerprint !== generationLock.role_posture_fingerprint
    || context.builtCatalog.catalog.generation_lock_fingerprint !== context.readBoundary.generation_lock_fingerprint) {
    throw new Error("ACTION_VERSION_REVIEW_STALE: Recheck the saved source structure before selecting a conflict counter. No authority changed.");
  }
  const current = buildActionRuleAuthoringCatalog({ boundary: context.readBoundary, inspection, retainedCatalog: context.builtCatalog.catalog });
  const target = current.catalog.resources.find(item => item.name === resource);
  const authoring = current.authoring.resources.find(item => item.name === resource);
  if (!target || !authoring || target.verification_only || !authoring.version_field_options?.includes(field)) {
    throw new Error("ACTION_VERSION_FIELD_UNSUPPORTED: Select an inspected, non-null, non-generated integer field on the existing update target, not its row or scope identity. No source or permissions changed.");
  }
  const catalog = structuredClone(current.catalog);
  const selected = catalog.resources.find(item => item.name === resource)!;
  selected.version_field = field;
  const builtCatalog = buildActionRuleAuthoringCatalog({ boundary: context.readBoundary, inspection, retainedCatalog: catalog });
  if (builtCatalog.catalog.resources.find(item => item.name === resource)?.version_field !== field) {
    throw new Error("ACTION_VERSION_FIELD_NOT_APPLIED: The reviewed counter did not survive catalog construction. No draft was saved.");
  }
  const review: ReviewedActionVersionField = { resource, field, maintenance: "all_writers_increment",
    proof_digest: canonicalJsonDigest({ source: selected.source, engine: selected.engine, resource,
      field: selected.fields.find(item => item.name === field), primary_key: selected.primary_key,
      tenant_key: selected.tenant_key ?? null, principal_scope_key: selected.principal_scope_key ?? null,
      maintenance: "all_writers_increment" }),
  };
  return { ...context, builtCatalog, review };
}

/** Business meaning is an operator decision; schema shape alone is insufficient. */
export async function reviewActionVersionField(input: Parameters<typeof prepareActionVersionField>[0] & {
  session: BoundaryReviewInteractiveSession;
  previousReview?: ReviewedActionVersionField;
  assertCurrent: () => Promise<void>;
}) {
  await input.assertCurrent();
  const prepared = prepareActionVersionField(input);
  if (!input.previousReview || canonicalJsonDigest(input.previousReview) !== canonicalJsonDigest(prepared.review)) {
    const summary = [
      `Use ${input.resource}.${input.field} to detect a record changed after a request was prepared.`,
      "The source owner must confirm that every source writer increments this counter on each update.",
      "Runner will compare the observed counter and increment it in the same guarded transaction. Customers cannot supply the counter as an input; existing Read visibility is unchanged and still needs its own privacy review.",
      "This prepares a disabled mapping only. Business rules, execution permission and source data do not change.",
    ];
    const details = { title: "Conflict counter mapping", summaryTitle: "Changed-record protection", lines: [...summary,
      `Structure checked: non-null integer; not generated, immutable, a primary key or a scope key. Proof: ${prepared.review.proof_digest}`,
      "This is not proof of external application behavior. If other writers do not maintain this counter, leave setup pending and ask the source owner to provide a maintained guard."] };
    const confirmed = input.session.chooseOption
      ? await input.session.chooseOption("REVIEW CHANGED-RECORD PROTECTION", [
        { value: "confirm", label: "Confirm this maintained counter", detail: "Record only this disabled mapping; no activation or source update." },
        { value: "pending", label: "Keep this mapping pending", detail: "The counter's meaning or maintenance still needs confirmation." },
      ], { initialValue: "pending", requireExplicitSelection: true, explainOnRequest: true, context: summary, exactDetails: details }) === "confirm"
      : await input.session.confirm("Does every source writer maintain this exact counter?", { defaultValue: false, context: details.lines });
    if (!confirmed) return undefined;
    await input.assertCurrent();
  }
  return prepared;
}
