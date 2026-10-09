import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { parseOperatorQuestions, type OperatorQuestion } from "./authoring-operator-question.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { AuthoringTransportState } from "./authoring-generation-recovery.js";
import type { PolicySourceSession } from "./authoring-policy-source.js";
import { projectReadScopeHostContext } from "./read-current-evidence.js";
import { parseReadScopeRecord, type ReadScopeRecord, type ReadScopeReference } from "./read-structured-scope.js";
import { ReadScopeReviewError } from "./authoring-read-scope-error.js";

/** Historical inspection resolves exact testimony against existing native
 * owners. It does not revalidate a catalog target, carry a Yes forward, or make
 * a historical Source/answer applicable to a changed request or permission. */
export function readScopeHistoricalReferences(input: {
  record: ReadScopeRecord; request: Extract<ReadScopeReference, { kind: "request" }>;
  sources?: PolicySourceSession; questions: readonly OperatorQuestion[];
  handoffs: readonly AuthoringOwnerHandoff[]; generation?: AuthoringTransportState;
}): ReadScopeReference[] {
  const record = parseReadScopeRecord(input.record);
  const questions = parseOperatorQuestions(input.questions, input.handoffs, input.generation);
  const unavailable = (): never => { throw new ReadScopeReviewError("READ_SCOPE_HISTORY_UNAVAILABLE",
    "The exact saved scope provenance is unavailable. Inspect the saved job; no confirmation or replacement was accepted."); };
  return record.references.map(reference => {
    if (reference.kind === "request") {
      if (canonicalJsonDigest(reference) !== canonicalJsonDigest(input.request)) return unavailable();
      return structuredClone(input.request);
    }
    if (reference.kind === "answer") {
      const q = questions.find(q => q.id === reference.question_id);
      if (!q?.raw_answer || q.revision !== reference.question_revision || q.raw_answer.id !== reference.answer_id) return unavailable();
      const actual: ReadScopeReference = { kind: "answer", id: `answer:${q.id}:${q.revision}:${q.raw_answer.id}`,
        digest: canonicalJsonDigest(q.raw_answer), question_id: q.id, question_revision: q.revision,
        answer_id: q.raw_answer.id, text: q.raw_answer.text };
      if (canonicalJsonDigest(actual) !== canonicalJsonDigest(reference)) return unavailable();
      return actual;
    }
    const snapshot = input.sources?.id === reference.source_id
      ? input.sources.snapshots.find(snapshot => snapshot.digest === reference.digest) : undefined;
    if (!snapshot) return unavailable();
    // Reuse exact Source numbering/content validation. No quote reconstruction
    // from the model's citation or location and no current applicability claim.
    const historical = projectReadScopeHostContext({ request: { id: input.request.id, text: input.request.text },
      source: { session_id: input.sources!.id, snapshot },
      catalog: { digest: record.binding.catalog_digest as `sha256:${string}`, resources: [], relationships: [] },
      binding: record.binding }).references.find(ref => ref.id === reference.id && ref.kind === "source");
    if (!historical || canonicalJsonDigest(historical) !== canonicalJsonDigest(reference)) return unavailable();
    return historical;
  });
}

export function assertReadScopeHistoricalReferences(record: ReadScopeRecord, inventory: readonly ReadScopeReference[]): void {
  parseReadScopeRecord(record);
  if (new Set(inventory.map(ref => ref.id)).size !== inventory.length
    || record.references.some(ref => !inventory.some(actual => actual.id === ref.id
      && canonicalJsonDigest(actual) === canonicalJsonDigest(ref)))) {
    throw new ReadScopeReviewError("READ_SCOPE_HISTORY_UNAVAILABLE",
      "The exact saved scope provenance is unavailable. Inspect the saved job; no confirmation or replacement was accepted.");
  }
}

import { projectAuthoringReadScopeContext } from "./authoring-read-scope-context.js";
import { projectBoundaryReviewContext, type BoundaryReviewContext } from "./boundary-review-context.js";
import { readProjectReadAuthoringHistoryHeld } from "./control-policy-read-authoring-project.js";
import type { BoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { projectBoundaryAuthoringResumeBinding } from "./authoring-resume-binding.js";
import { assertReadScopeProvenance, type ReadScopeBinding, type ReadScopeCatalog } from "./read-structured-scope.js";
import type { ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";

export type HistoricalReadScopeInventory = {
  binding: ReadScopeBinding; references: readonly ReadScopeReference[]; catalog: ReadScopeCatalog;
};
/** Resolve the exact historical catalog/subject proof through retained native
 * structural revisions and their original acknowledged decision origins. A
 * matching target or a self-hashed saved catalog is not an origin. */
export async function loadHistoricalReadScopeInventoryHeld(input: {
  projectRoot: string; record: ReadScopeRecord; current: BoundaryReviewContext;
  resume: BoundaryAuthoringResumeState; sources?: PolicySourceSession;
  questions: readonly OperatorQuestion[]; handoffs: readonly AuthoringOwnerHandoff[];
  generation?: AuthoringTransportState;
}, permit: ProjectAuthorityMutationPermit): Promise<HistoricalReadScopeInventory> {
  const record = parseReadScopeRecord(input.record);
  const source = input.sources?.snapshots.find(snapshot => snapshot.digest === record.binding.source_digest);
  const sources = record.binding.source_digest === canonicalJsonDigest(null) ? undefined
    : source && input.sources ? { ...input.sources, active: source.version } : undefined;
  if (record.binding.source_digest !== canonicalJsonDigest(null) && !sources)
    throw new ReadScopeReviewError("READ_SCOPE_HISTORY_UNAVAILABLE", "The exact original Source snapshot is unavailable.");
  const inspect = (current: BoundaryReviewContext): HistoricalReadScopeInventory | undefined => {
    if (current.candidate.pack.name !== input.resume.binding.boundary_name) return undefined;
    const projected = projectAuthoringReadScopeContext({ resume: { ...input.resume,
      binding: projectBoundaryAuthoringResumeBinding(current.candidate, current.lock) },
      boundary: current.candidate, structuralReview: current, ...(sources ? { sources } : {}),
      records: { questions: input.questions, handoffs: input.handoffs, generation: input.generation }, answerQuestionIds: [] });
    if (canonicalJsonDigest(projected.binding) !== canonicalJsonDigest(record.binding)) return undefined;
    const request = projected.references.find(ref => ref.kind === "request");
    if (!request || request.kind !== "request") return undefined;
    const references = readScopeHistoricalReferences({ ...input, request });
    // This re-resolves all targets, relationships and subject acknowledgments
    // from the actual old native context, not the model's saved projection.
    assertReadScopeProvenance(record, { expectedBinding: projected.binding, references, catalog: projected.catalog });
    return { binding: projected.binding, references, catalog: projected.catalog };
  };
  const current = inspect(input.current);
  if (current) return current;
  let before: { epoch: number; revision_id: string } | undefined;
  do {
    const page = await readProjectReadAuthoringHistoryHeld(input.projectRoot,
      { boundaryName: input.resume.binding.boundary_name, ...(before ? { before } : {}) }, permit);
    for (const stored of page.items) {
      const selected = stored.selected!;
      const context = projectBoundaryReviewContext({ boundaryRoot: input.current.boundaryRoot,
        draft: selected.draft, lock: selected.draft_lock, progress: selected.progress, stored });
      const historical = inspect(context);
      if (historical) return historical;
    }
    before = page.before;
  } while (before);
  throw new ReadScopeReviewError("READ_SCOPE_HISTORY_UNAVAILABLE",
    "The exact original catalog and structural review are unavailable. Inspect the saved job; no confirmation or replacement was accepted.");
}
