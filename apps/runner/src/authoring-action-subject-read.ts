import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { currentStructuredReadEvidence, type CurrentStructuredReadEvidence } from "./read-current-evidence.js";
import type { ReadSubjectBinding } from "./read-structured-scope.js";
import type { ActionSubjectEntry, ActionSubjectOption, ActionSubjectTarget } from "./authoring-action-subject-binding.js";
/** One exact structural option. The reference is domain-owned; callers do not
 * independently reconstruct a weaker identity from a resource name. */
export function actionSubjectOptionFromRead(target: ActionSubjectTarget, scope: ReadSubjectBinding): ActionSubjectOption | undefined {
  if (target.kind !== "verification_subject" || target.resource !== scope.root_resource) return undefined;
  const target_digest = canonicalJsonDigest(target);
  return { reference: canonicalJsonDigest({ target, scope }), target_digest, kind: scope.kind,
    dependencies_digest: canonicalJsonDigest(scope) };
}
/** Reuse only how an existing public opaque subject is scoped. This never
 * supplies private/effect authority, whole-resource disclosure or a write grant.
 * The exact current original job, Source, structural review and analysis come
 * through Read's existing resolver; a matching table name alone is insufficient. */
export function resolveActionReadSubject(input: { target: ActionSubjectTarget; options: readonly ActionSubjectOption[];
  read: CurrentStructuredReadEvidence }): Extract<ActionSubjectEntry, { state: "proposed" }> | undefined {
  if (input.target.kind !== "verification_subject") return undefined;
  const resolved = currentStructuredReadEvidence(input.read);
  if (resolved.status !== "confirmed") return undefined;
  const q = resolved.question, record = q.read_scope!.record;
  for (const requirement of record.proposal.requirements) {
    if (requirement.disposition !== "include" || !requirement.targets.some(t => t.root_resource === input.target.resource && t.resource === input.target.resource)) continue;
    const subject = requirement.subjects.find(s => s.root_resource === input.target.resource);
    if (!subject || subject.mode === "unresolved") continue;
    const scopes = record.subject_bindings.filter(s => s.root_resource === input.target.resource
      && (subject.mode === "trusted_principal" ? s.kind === "principal" : s.reference === subject.scope_reference));
    if (scopes.length !== 1) continue;
    const expected = actionSubjectOptionFromRead(input.target, scopes[0]!);
    if (!expected || !input.options.some(option => canonicalJsonDigest(option) === canonicalJsonDigest(expected))) continue;
    return { state: "proposed", target_digest: canonicalJsonDigest(input.target),
      meaning: subject.mode === "trusted_principal" ? "trusted_principal" : "reviewed_scope", scope_reference: expected.reference,
      support: { kind: "read_subject", question_id: q.id, question_revision: q.revision, question_digest: q.digest,
        scope_record_digest: record.digest as `sha256:${string}`, requirement_id: requirement.id } };
  }
  return undefined;
}
