import { canonicalJsonDigest, canonicalJsonStringify } from "@synapsor-runner/protocol";
import { parseOperatorQuestion, type OperatorQuestion } from "./authoring-operator-question.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { AuthoringTransportOperation } from "./authoring-generation-recovery.js";
import type { CoverageReviewEpisode, PolicyTextSnapshot } from "./authoring-policy-source.js";
import { safeTerminalText } from "./analytics-shell-render.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";

type Digest = `sha256:${string}`;
export type AuthoringHistoryOwner = "question" | "source" | "resume" | "native_operation";
export type AuthoringHistoryRef = Readonly<{
  owner: AuthoringHistoryOwner; record_id: string; record_digest: Digest;
  operation_id?: string; part: "operator" | "submission" | "finding" | "candidate" | "confirmation" | "save";
}>;
/** Host authorization is exact-record scoped. It is never inferred from text,
 * transport status, a model field, or prior display. Absence means redacted. */
export type AuthoringHistoryAccess = Readonly<{
  owner: AuthoringHistoryOwner; record_id: string; record_digest: Digest;
  visibility: "available" | "redacted"; reason?: string;
}>;
export type AuthoringHistoryEntry = Readonly<{
  ref: AuthoringHistoryRef; title: string; status: string;
  availability: "available" | "redacted" | "unavailable"; lines: readonly string[];
}>;
export type AuthoringHistorySnapshot = Readonly<{
  snapshot_digest: Digest; entries: readonly AuthoringHistoryEntry[];
}>;
export type AuthoringHistoryRecords = Readonly<{
  /** Already-current records from existing protected owners; no read/write ports. */
  questions?: readonly OperatorQuestion[];
  handoffs?: readonly AuthoringOwnerHandoff[];
  source_snapshots?: readonly Readonly<{ session_id: string; snapshot: PolicyTextSnapshot }>[];
  coverage_episodes?: readonly Readonly<{ session_id: string; episode: CoverageReviewEpisode }>[];
  operations?: readonly AuthoringTransportOperation[];
  access: readonly AuthoringHistoryAccess[];
}>;
function invalid(message: string): never { throw new Error(`AUTHORING_HISTORY_INVALID: ${message}`); }
const sha = (value: unknown): value is Digest => typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
const key = (ref: Pick<AuthoringHistoryRef, "owner" | "record_id" | "record_digest">) => canonicalJsonDigest(ref);
export function authoringHistoryRecordRef(owner: AuthoringHistoryOwner, record_id: string, record: unknown) {
  return { owner, record_id, record_digest: canonicalJsonDigest(record) };
}

/** Pure, bounded projection. Missing original payloads remain unavailable;
 * no transcript reconstruction, response dumping, saved-state inference or
 * model forwarding. Native typed proposal records can add an explicit adapter
 * after their owning format lands; unknown future shapes are not guessed. */
export function projectAuthoringOperationHistory(input: AuthoringHistoryRecords): AuthoringHistorySnapshot {
  const count = (input.questions?.length ?? 0) + (input.handoffs?.length ?? 0) + (input.source_snapshots?.length ?? 0)
    + (input.coverage_episodes?.length ?? 0) + (input.operations?.length ?? 0);
  if (count > 4096 || input.access.length > 4096) invalid("The requested inspection exceeds the bounded display; select a narrower existing operation. No records were pruned.");
  const grants = new Map<string, AuthoringHistoryAccess>();
  for (const access of input.access) {
    if (!["question", "source", "resume", "native_operation"].includes(access.owner) || !access.record_id
      || !sha(access.record_digest) || !["available", "redacted"].includes(access.visibility)) invalid("Malformed exact inspection authorization.");
    const id = key({ owner: access.owner, record_id: access.record_id, record_digest: access.record_digest });
    if (grants.has(id)) invalid("Duplicate record authorization."); grants.set(id, access);
  }
  const entries: AuthoringHistoryEntry[] = [], seen = new Set<string>();
  const append = (record: unknown, owner: AuthoringHistoryOwner, id: string, part: AuthoringHistoryRef["part"], title: string,
    status: string, lines: readonly string[], available = true, operation_id?: string) => {
    const recordRef = authoringHistoryRecordRef(owner, id, record), grant = grants.get(key(recordRef));
    const ref = { ...recordRef, part, ...(operation_id ? { operation_id } : {}) };
    const identity = canonicalJsonDigest(ref);
    if (seen.has(identity)) invalid("Duplicate exact operation reference."); seen.add(identity);
    const visibility = grant?.visibility ?? "redacted";
    if (entries.length >= 20_480) invalid("The inspection entry bound was reached. Select a narrower existing operation; no history was discarded.");
    entries.push({ ref, title: safeTerminalText(title), status: safeTerminalText(status),
      availability: visibility === "redacted" ? "redacted" : available ? "available" : "unavailable",
      lines: (visibility === "redacted" ? ["This exact record is redacted for the current operator inspection.",
        ...(grant?.reason ? [grant.reason] : [])] : lines).map(safeTerminalText) });
  };
  for (const raw of input.questions ?? []) {
    const q = parseOperatorQuestion(raw);
    append(q, "question", q.id, "operator", "Operator answer", q.raw_answer ? "captured; not confirmation" : "no captured answer",
      q.raw_answer ? [`Answer reference: ${q.raw_answer.id}`, `Actor: ${q.raw_answer.actor}`, `Recorded: ${q.raw_answer.recorded_at}`, q.raw_answer.text]
        : ["No raw answer exists in this record. A Source interpretation or retained suggestion is not a fabricated answer."], !!q.raw_answer);
    append(q, "question", q.id, "candidate", "Proposed interpretation", q.proposal?.disposition ?? "unavailable",
      q.proposal ? [canonicalJsonStringify(q.proposal), ...(q.proposal_history?.length ? ["Earlier proposals (not current authority):", canonicalJsonStringify(q.proposal_history)] : [])]
        : ["No proposed interpretation is retained."], !!q.proposal);
    append(q, "question", q.id, "confirmation", "Business confirmation", q.confirmation ? "confirmed interpretation; not activation" : "unconfirmed",
      q.confirmation ? [canonicalJsonStringify(q.confirmation)] : ["No explicit confirmation exists in this record."], !!q.confirmation);
    append(q, "question", q.id, "finding", "Question disposition", q.disposition ?? (q.terminal_failure ? "terminal refusal" : "no disposition recorded"),
      [canonicalJsonStringify({ disposition: q.disposition ?? null, history: q.disposition_history ?? [], terminal_failure: q.terminal_failure ?? null })]);
    append(q, "question", q.id, "save", "Downstream save", "not established by question record",
      ["A confirmed interpretation does not prove an acknowledged Source adoption, disabled draft save, activation or source effect."], false);
  }
  for (const h of input.handoffs ?? []) {
    append(h, "resume", h.id, "operator", "Retained owner handoff", h.state,
      [`Question: ${h.question}`, ...(h.state === "answered" ? [`Actor: ${h.actor}`, `Exact answer: ${h.answer}`] : ["No answer recorded."])]);
  }
  for (const { session_id, snapshot } of input.source_snapshots ?? []) {
    append(snapshot, "source", `${session_id}:snapshot:${snapshot.version}`, "operator", "Attached Source snapshot", "attached text; not permission or semantic proof",
      [`Source: ${snapshot.name}`, `Original source digest: ${snapshot.digest}`, snapshot.text]);
  }
  for (const { session_id, episode } of input.coverage_episodes ?? []) {
    for (const submission of episode.submissions) {
      const id = `${session_id}:${episode.id}:${submission.number}`;
      append(submission, "source", id, "submission", "Coverage submission", submission.completed_at ? "response recorded" : "reserved; completion not established",
        [`Episode: ${episode.id}`, `Evidence context: ${episode.context}`, `Submission: ${submission.number}`, `Reserved: ${submission.reserved_at}`,
          ...(submission.completed_at ? [`Response recorded: ${submission.completed_at}`] : []),
          "Original submitted payload is not retained here; it is not reconstructed from current context."], false, episode.id);
      append(submission, "source", id, "finding", "Coverage finding", submission.validated === true ? "validated coverage evidence; not activation" : submission.validated === false ? "not validated" : "validation unknown",
        [submission.diagnostic ?? "No diagnostic retained.", "Tentative model responses and arbitrary nested payloads are not automatically disclosed by this inspection adapter."], true, episode.id);
    }
  }
  for (const op of input.operations ?? []) {
    append(op, "native_operation", op.id, "submission", "Native generation operation", op.state,
      [`Request digest: ${op.request_digest}`, `Context digest: ${op.context_digest}`,
        "Original request/response text is unavailable from this transport record. Transport metadata is not a business answer."], false, op.id);
    append(op, "native_operation", op.id, "finding", "Native transport outcome", op.state,
      op.attempts.map(attempt => `Attempt ${attempt.id}: ${attempt.outcome}${attempt.code ? ` (${attempt.code})` : ""}`), true, op.id);
    const checkpoint = op.action_checkpoint ?? op.read_checkpoint;
    append(op, "native_operation", op.id, "save", "Producer consumption acknowledgement", checkpoint ? "exact consumption checkpoint retained" : "no consumption proof in this projection",
      checkpoint ? [canonicalJsonStringify(checkpoint), "This producer acknowledgement alone is not publication, activation or a database completion receipt."]
        : ["HTTP response/handled/checkpointed status alone is not used to infer a durable business save."], !!checkpoint, op.id);
  }
  return { snapshot_digest: canonicalJsonDigest(entries), entries };
}
function checkedSnapshot(snapshot: AuthoringHistorySnapshot): void {
  if (!sha(snapshot.snapshot_digest) || canonicalJsonDigest(snapshot.entries) !== snapshot.snapshot_digest) invalid("Inspection projection changed. Reload the current authorized records.");
}
export function authoringHistoryPage(snapshot: AuthoringHistorySnapshot, page: number, pageSize = 10) {
  checkedSnapshot(snapshot);
  if (!Number.isSafeInteger(page) || page < 0 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 10) invalid("Invalid bounded history page.");
  const pages = Math.max(1, Math.ceil(snapshot.entries.length / pageSize));
  if (page >= pages) invalid("History page does not exist.");
  return { page, pages, total: snapshot.entries.length, entries: snapshot.entries.slice(page * pageSize, (page + 1) * pageSize) };
}
export function exactAuthoringHistoryEntry(snapshot: AuthoringHistorySnapshot, ref: AuthoringHistoryRef): AuthoringHistoryEntry {
  checkedSnapshot(snapshot);
  if (!ref || Object.keys(ref).some(name => !["owner", "record_id", "record_digest", "operation_id", "part"].includes(name))) invalid("Malformed exact history reference.");
  const found = snapshot.entries.find(entry => canonicalJsonDigest(entry.ref) === canonicalJsonDigest(ref));
  if (!found) invalid("This exact record reference is unavailable in the current authorized projection.");
  return structuredClone(found);
}

/** Shared local pager; Main supplies fresh authorized projection and currentness.
 * No fallback to a latest unrelated record after a failed exact resolution. */
export async function presentAuthoringOperationHistory(input: {
  snapshot: AuthoringHistorySnapshot;
  session: Pick<BoundaryReviewInteractiveSession, "chooseOption" | "showReviewDetails" | "present">;
  assertCurrent: () => Promise<void>;
}): Promise<void> {
  let page = 0;
  const snapshot = structuredClone(input.snapshot);
  for (;;) {
    await input.assertCurrent();
    const current = authoringHistoryPage(snapshot, page);
    const selected = await input.session.chooseOption?.("RUNNER OPERATION HISTORY — READ ONLY", [
      ...current.entries.map((entry, i) => ({ value: `entry:${i}`, label: `${entry.title} — ${entry.status} [${entry.availability}]` })),
      ...(page > 0 ? [{ value: "previous", label: "Previous page" }] : []),
      ...(page + 1 < current.pages ? [{ value: "next", label: "Next page" }] : []),
      { value: "back", label: "Back to the current decision" },
    ], { decisionKind: "business_review", localOnly: true, initialValue: "back", reviewOnly: true,
      context: [`Page ${page + 1} of ${current.pages}; ${current.total} retained inspection entries.`,
        "Records are display-only. Missing original payloads are labelled unavailable; no model call, save or authority change."], displayContext: true });
    await input.assertCurrent();
    if (selected === undefined || selected === "back") return;
    if (selected === "previous" && page > 0) { page--; continue; }
    if (selected === "next" && page + 1 < current.pages) { page++; continue; }
    const index = current.entries.findIndex((_entry, i) => selected === `entry:${i}`);
    if (index < 0) invalid("The selected history entry is not on this page.");
    const exact = exactAuthoringHistoryEntry(snapshot, current.entries[index]!.ref);
    const lines = [`Availability: ${exact.availability}`, `Status: ${exact.status}`, `Exact reference: ${canonicalJsonStringify(exact.ref)}`, ...exact.lines];
    if (input.session.showReviewDetails) await input.session.showReviewDetails(exact.title, lines);
    else input.session.present?.(exact.title, lines);
    await input.assertCurrent();
  }
}
