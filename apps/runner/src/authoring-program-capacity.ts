/** Authoring dimensions. Canonical authority capacity remains separately 4096. */
export const AUTHORING_PROGRAM_CAPACITY = Object.freeze({
  totalActions: 64,
  structuredChangedActions: 12,
  recommendedWorkUnitActions: 8,
  reviewPageActions: 8,
  structuredDraftBytes: 512 * 1024,
  structuredDraftRecordBytes: 256 * 1024,
  structuredDraftManifestBytes: 64 * 1024,
  structuredDraftParts: 16,
  structuredDraftRecords: 192,
  structuredDraftTotalBytes: 4 * 1024 * 1024,
});

export const AUTHORING_PROGRAM_RESUME_VERSION = "synapsor.boundary-authoring-resume.v2" as const;
export const AUTHORING_PROGRAM_INPUT_VERSION = "synapsor.boundary-draft-input.v2" as const;

/** Host progress only: neither drafting nor a work-unit boundary grants authority. */
export function authoringProgramWorkUnit(total: number, completed: number) {
  if (!Number.isSafeInteger(total) || total < 1 || total > AUTHORING_PROGRAM_CAPACITY.totalActions
    || !Number.isSafeInteger(completed) || completed < 0 || completed > total) {
    throw new Error("AUTHORING_PROGRAM_INVENTORY_INVALID: the complete saved agenda or progress is outside its supported bounds.");
  }
  const size = AUTHORING_PROGRAM_CAPACITY.recommendedWorkUnitActions;
  const start = Math.floor(completed / size) * size;
  return { total, completed, remaining: total - completed,
    state: completed === total ? "drafted" as const : "pending" as const,
    unit: completed === total ? null : { index: Math.floor(completed / size) + 1,
      start, end: Math.min(start + size, total), next_intent_index: completed } };
}

export function authoringProgramProgressLines(total: number, completed: number): string[] {
  const progress = authoringProgramWorkUnit(total, completed);
  return [`Selected program: ${progress.completed}/${progress.total} Action drafts prepared; ${progress.remaining} remain.`,
    ...(progress.unit ? [`Current work unit ${progress.unit.index}: intended Actions ${progress.unit.start + 1}–${progress.unit.end}; next ${completed + 1}.`]
      : ["All intended drafts are prepared; complete program validation and separate operator publication are still required."]),
    "Work units preserve one program and its shared obligations; they do not split approval limits or authorize partial completion."];
}

/** Operator pages never narrow the candidate being reviewed or confirmed. */
export function authoringReviewPage<T>(items: readonly T[], page: number, matches: (item: T) => boolean = () => true) {
  const selected = items.filter(matches);
  const pages = Math.max(1, Math.ceil(selected.length / AUTHORING_PROGRAM_CAPACITY.reviewPageActions));
  if (!Number.isSafeInteger(page) || page < 0 || page >= pages) throw new Error("AUTHORING_REVIEW_PAGE_INVALID: choose a current inventory page.");
  const start = page * AUTHORING_PROGRAM_CAPACITY.reviewPageActions;
  return { items: selected.slice(start, start + AUTHORING_PROGRAM_CAPACITY.reviewPageActions), page, pages,
    start, matched: selected.length, total: items.length };
}

/** Workflow capacity and protocol version are separate. Structured jobs retain
 * their explicit workflow; v3 alone never increases the legacy action cap. */
export function isAuthoringProgramResume(value: { schema_version: string; action_workflow?: string }): boolean {
  return value.schema_version === AUTHORING_PROGRAM_RESUME_VERSION
    || value.schema_version === "synapsor.boundary-authoring-resume.v3" && value.action_workflow === "program";
}
