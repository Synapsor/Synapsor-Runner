import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeBinding } from "./boundary-authoring-resume.js";
import { actionRuleIntentSkeletonsFromResume, loadActionRuleIntentSkeletons } from "./action-rule-intent-skeleton.js";
import type { ActionRuleAuthoringCatalogV1, BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";
import { actionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import type { ActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

const binding: BoundaryAuthoringResumeBinding = {
  boundary_name: "reviewed_appointments",
  generation_lock_fingerprint: `sha256:${"a".repeat(64)}`,
  schema_fingerprint: `sha256:${"b".repeat(64)}`,
  role_posture_fingerprint: `sha256:${"c".repeat(64)}`,
};

const catalog: ActionRuleAuthoringCatalogV1 = {
  schema_version: "synapsor.action-rule-authoring-catalog.v1",
  source: "local_postgres", engine: "postgres", read_boundary_name: binding.boundary_name,
  generation_lock_fingerprint: binding.generation_lock_fingerprint,
  resources: [{ name: "public.service_appointments", primary_key: "appointment_id", tenant_scope: "direct",
    tenant_key: "tenant_id", principal_scope: "direct", principal_key: "principal_id", version_candidates: ["version"],
    selected_version_field: "version", operations: { update: true, insert: false }, fields: [] }],
  relationships: [{ name: "appointment_customer", from_resource: "public.service_appointments",
    to_resource: "public.customers", local_field: "customer_id", target_field: "customer_id",
    cardinality: "many_to_one", nullable: false, target_unique: true }],
  supported_language: { comparisons: ["eq", "neq", "lt", "lte", "gt", "gte"], predicates: ["all", "any", "not", "null_check", "in", "exists"],
    aggregates: ["count", "sum", "min", "max"], arithmetic: ["add", "subtract", "min", "max", "multiply", "divide", "clamp", "add_duration", "date_of"],
    effects: ["single_row_update", "single_row_insert"] },
  diagnostics: [], digest: `sha256:${"d".repeat(64)}`,
};
const readBoundaryDigest = `sha256:${"e".repeat(64)}` as const;
const builtCatalog = { authoring: catalog, catalog: {
  schema_version: "synapsor.action-rule-catalog.v1", generation_lock_fingerprint: binding.generation_lock_fingerprint,
  resources: [{ name: "public.service_appointments", tenant_key: "tenant_id" }], relationships: [],
} } as unknown as BuiltActionRuleAuthoringCatalogV1;
function prepared(outcome: string) {
  const draft = { schema_version: "synapsor.action-rule-model-draft.v1", outcome } as ActionRuleModelDraftV1;
  return { outcome, digest: canonicalJsonDigest(draft), draft };
}

function resume(action?: Parameters<typeof buildBoundaryAuthoringResumeState>[0]["action"]) {
  return buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting", jobIntent: "Manage appointments",
    provider: "openai", model: "test", ...(action ? { action } : {}), now: "2026-09-10T00:00:00.000Z" });
}

describe("actionRuleIntentSkeletonsFromResume", () => {
  it("exports one incomplete skeleton per exact saved business intent without guessing an action", () => {
    const saved = resume({ intent: "Change a reminder", intents: ["Change a reminder", "Reschedule an appointment"],
      completed_outcomes: ["service_appointment.change_reminder", "service_appointment.reschedule"], strategy: "rule_derived" });

    const first = prepared("service_appointment.change_reminder"), second = prepared("service_appointment.reschedule");
    const skeletons = actionRuleIntentSkeletonsFromResume({ resume: saved, builtCatalog, readBoundaryDigest,
      preparedDrafts: [first, second, prepared("service_appointment.unrelated")] });

    expect(skeletons).toHaveLength(2);
    expect(skeletons.map((entry) => entry.intent)).toEqual(["Change a reminder", "Reschedule an appointment"]);
    expect(skeletons.map((entry) => entry.continuation)).toEqual([
      { state: "exact_current_draft", outcome: first.outcome, digest: first.digest, draft: first.draft },
      { state: "exact_current_draft", outcome: second.outcome, digest: second.digest, draft: second.draft },
    ]);
    expect(skeletons[0]!.candidates.subject_ref_resource_candidates).toEqual(["public.service_appointments"]);
    expect(skeletons[0]!.candidates.relationships).toEqual(catalog.relationships);
    expect(JSON.stringify(skeletons)).not.toContain("target_resource");
    expect(JSON.stringify(skeletons)).not.toContain("allowed_fields");
    expect(JSON.stringify(skeletons)).not.toContain("auto_approve_when");
  });

  it("maps completed outcomes to their saved prefix without claiming the unfinished intent", () => {
    const saved = resume({ intent: "Change a reminder", intents: ["Change a reminder", "Reschedule an appointment"],
      completed_outcomes: ["service_appointment.change_reminder"], strategy: "rule_derived" });

    const skeletons = actionRuleIntentSkeletonsFromResume({ resume: saved, builtCatalog, readBoundaryDigest,
      preparedDrafts: [prepared("service_appointment.change_reminder")] });

    expect(skeletons[0]!.continuation).toMatchObject({ state: "exact_current_draft", outcome: "service_appointment.change_reminder" });
    expect(skeletons[1]!.continuation).toEqual({ state: "unprepared" });
  });

  it("retains third-action components as untrusted after a Read edit, separate from two completed outcomes", () => {
    const intents = ["Change a reminder", "Reschedule an appointment", "Request an adviser"];
    const drafts = [prepared("appointments.reminder"), prepared("appointments.reschedule")];
    const checkpoint = actionRuleAuthoringCheckpoint({ intent_digest: canonicalJsonDigest(intents[2]),
      context_digest: canonicalJsonDigest({ catalog: builtCatalog.catalog, read: readBoundaryDigest, baseline: null }),
      components: { verification: { name: "adviser", resources: [] }, effect: { operation: "insert" }, rule: { outcome: "appointments.adviser" } } });
    const saved = resume({ intent: intents[0]!, intents, completed_outcomes: drafts.map(draft => draft.outcome),
      strategy: "rule_derived", checkpoint });
    const skeletons = actionRuleIntentSkeletonsFromResume({ resume: saved, builtCatalog,
      readBoundaryDigest: `sha256:${"f".repeat(64)}`, preparedDrafts: drafts });
    expect(skeletons.slice(0, 2).map(entry => entry.continuation.state)).toEqual(["exact_current_draft", "exact_current_draft"]);
    expect(skeletons[2]!.verification).toEqual({ state: "needs_revalidation", component: checkpoint.components.verification });
    expect(skeletons[2]!.effect).toEqual({ state: "needs_revalidation", component: checkpoint.components.effect });
    expect(skeletons[2]!.checkpoint_rule).toEqual({ state: "needs_revalidation", component: checkpoint.components.rule });
    expect(skeletons[2]!.policy.state).toBe("unknown");
    expect(skeletons[2]!.continuation.state).toBe("unprepared");
  });

  it("refuses to export action components from a stale saved Read binding", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-intent-skeleton-")); roots.push(root);
    await writeBoundaryAuthoringResumeState(root, resume({ intent: "Change a reminder", strategy: "rule_derived" }));
    const changed = { ...binding, schema_fingerprint: `sha256:${"e".repeat(64)}` as `sha256:${string}` };

    await expect(loadActionRuleIntentSkeletons({ projectRoot: root, binding: changed, builtCatalog, readBoundaryDigest,
      preparedDrafts: [] })).rejects.toThrow("ACTION_RULE_INTENT_SKELETON_STALE");
  });

  it("exports no skeleton when the exact saved job has no captured action intent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-intent-skeleton-")); roots.push(root);
    await writeBoundaryAuthoringResumeState(root, resume());

    await expect(loadActionRuleIntentSkeletons({ projectRoot: root, binding, builtCatalog, readBoundaryDigest,
      preparedDrafts: [] })).resolves.toMatchObject({ resume: expect.any(Object), skeletons: [] });
  });

  it("exposes exact partial checkpoint components only for its bound current intent and catalog", () => {
    const intent = "Change a reminder";
    const checkpoint = actionRuleAuthoringCheckpoint({ intent_digest: canonicalJsonDigest(intent),
      context_digest: canonicalJsonDigest({ catalog: builtCatalog.catalog, read: readBoundaryDigest, baseline: null }),
      components: { verification: { name: "reminder verification", resources: [] }, approval: { class_name: "reviewer" } } });
    const saved = resume({ intent, intents: [intent, "Reschedule an appointment"], strategy: "rule_derived", checkpoint });

    const skeletons = actionRuleIntentSkeletonsFromResume({ resume: saved, builtCatalog, readBoundaryDigest, preparedDrafts: [] });

    expect(skeletons[0]!.verification).toEqual({ state: "checkpoint", component: checkpoint.components.verification });
    expect(skeletons[0]!.policy).toEqual({ state: "checkpoint", component: checkpoint.components.approval });
    expect(skeletons[1]!.verification.state).toBe("unknown");
  });

  it("exposes a reopened draft's exact checkpoint only when its current draft and covered intent still match", () => {
    const intent = "Change a reminder", draft = prepared("service_appointment.change_reminder");
    const checkpoint = actionRuleAuthoringCheckpoint({
      intent_digest: canonicalJsonDigest(intent),
      context_digest: canonicalJsonDigest({ catalog: builtCatalog.catalog, read: readBoundaryDigest, baseline: draft.draft,
        pending_intents: [intent, "Reschedule an appointment"] }),
      components: { effect: { name: "reminder effect", operation: "update" } },
      reopened_draft: { outcome: draft.outcome, digest: draft.digest, covered_intent_indexes: [0] },
    });
    const saved = resume({ intent, intents: [intent, "Reschedule an appointment"], strategy: "rule_derived", checkpoint });
    const skeletons = actionRuleIntentSkeletonsFromResume({ resume: saved, builtCatalog, readBoundaryDigest, preparedDrafts: [draft] });

    expect(skeletons[0]!.effect).toEqual({ state: "checkpoint", component: checkpoint.components.effect });
    expect(skeletons[0]!.continuation).toMatchObject({ state: "exact_current_draft", outcome: draft.outcome });
    expect(skeletons[1]!.effect.state).toBe("unknown");
  });
});
