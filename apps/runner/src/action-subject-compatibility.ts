import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ActionRuleAuthorityV1, ActionRuleCatalogResourceV1 } from "@synapsor-runner/action-rules";
import type { ActivatedExplorationBoundary, ExplorationBoundaryDraft } from "./auto-boundary.js";
import { compileExplorePlan, validateExplorePlan } from "./scoped-explore.js";

export type ActionSubjectCompatibility = {
  client: "four_tool"; read_digest: string; action_digest: string; compatible: boolean;
  subjects: Array<{ outcome: string; binding: string; resource: string; obtainable: boolean; code?: string; next_step?: string }>;
};

/** No source open, reference issuance or authority mutation. Use the same rows
 * validator/projection compiler as Explore. Internal relationship bindings have
 * already passed Action compilation; they are not externally supplied tokens. */
export function actionSubjectCompatibility(authority: ActionRuleAuthorityV1, reads: readonly (ExplorationBoundaryDraft | ActivatedExplorationBoundary)[]): ActionSubjectCompatibility {
  const subjects: ActionSubjectCompatibility["subjects"] = [];
  for (const entry of authority.rules) for (const subject of entry.rule.subjects) {
    const result = { outcome: entry.rule.outcome, binding: subject.binding, resource: subject.resource, obtainable: false };
    const read = reads.find(r => r.pack.name === entry.read_boundary_name);
    const catalog = authority.catalog.resources.find(r => r.name === subject.resource);
    const code = read && catalog ? subjectReferenceRoute(read, catalog) : "ACTION_SUBJECT_READ_MISSING";
    subjects.push(code ? { ...result, code, next_step: "This external subject has no supported reference route in the reviewed Read contract. Review an obtainable root with an existing exact relationship binding only if it preserves every eligible target, or obtain an explicit separate Read/reference decision. Related values and raw keys are not subject references. No authority was changed." } : { ...result, obtainable: true });
  }
  return { client: "four_tool", read_digest: canonicalJsonDigest(reads), action_digest: authority.digest,
    compatible: subjects.every(s => s.obtainable), subjects };
}

/** Shared by authoring hints and final reviewed publication. An empty query
 * result is deliberately irrelevant: this checks a supported acquisition route. */
export function subjectReferenceRoute(read: ExplorationBoundaryDraft | ActivatedExplorationBoundary, catalog: ActionRuleCatalogResourceV1): string | undefined {
  const resource = read.pack.resources.find(r => r.id === catalog.name);
  if (!resource) return "ACTION_SUBJECT_READ_MISSING";
  if (resource.relationship_only) return "ACTION_SUBJECT_RELATIONSHIP_ONLY";
  if (catalog.source !== read.source || resource.primary_key !== catalog.primary_key
    || catalog.schema !== resource.schema || catalog.table !== resource.table) return "ACTION_SUBJECT_SOURCE_MISMATCH";
  if (catalog.tenant_key && resource.tenant_key && catalog.tenant_key !== resource.tenant_key
    || catalog.principal_scope_key && resource.principal_key && catalog.principal_scope_key !== resource.principal_key) return "ACTION_SUBJECT_SCOPE_MISMATCH";
  try {
    const active = read as ActivatedExplorationBoundary;
    const plan = validateExplorePlan({ kind: "rows", resource: resource.id, select: resource.selectable_fields.slice(0, 1), limit: 1 }, active);
    const queries = compileExplorePlan(plan, active, { tenant: "compatibility-check", principal: "compatibility-check" }, catalog.engine,
      { resource: resource.id, primary_key: catalog.primary_key, version_field: catalog.version_field, outcomes: [] });
    if (queries[0]?.subject_projection?.resource !== resource.id) return "ACTION_SUBJECT_PROJECTION_UNAVAILABLE";
  } catch { return "ACTION_SUBJECT_ROWS_UNAVAILABLE"; }
  return undefined;
}

export function assertActionSubjectsObtainable(authority: ActionRuleAuthorityV1, reads: readonly (ExplorationBoundaryDraft | ActivatedExplorationBoundary)[]): void {
  const result = actionSubjectCompatibility(authority, reads);
  const failed = result.subjects.filter(s => !s.obtainable);
  if (failed.length) throw Object.assign(new Error(`ACTION_SUBJECT_UNOBTAINABLE: ${failed.map(s => `${s.outcome}/${s.binding}: ${s.code}`).join("; ")}. ${failed[0]!.next_step}`), { code: "ACTION_SUBJECT_UNOBTAINABLE" });
}
