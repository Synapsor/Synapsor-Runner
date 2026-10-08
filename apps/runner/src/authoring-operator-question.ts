import { parseReadScopeQuestionBinding, readScopeConsumption, type ReadScopeQuestionBinding } from "./authoring-read-scope-binding.js";
import { assertAuthoringReadCheckpoint } from "./authoring-generation-recovery.js";
import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { AskAuthoringEpisodeBudget } from "./model-ask.js";
import type { AuthoringOwnerHandoff } from "./authoring-owner-handoff.js";
import type { AuthoringQuestionCompletion, AuthoringTransportState } from "./authoring-generation-recovery.js";
import { AskError } from "./model-provider-transport.js";
import { parseOperatorClarificationGateState, type OperatorClarificationGateState } from "./authoring-operator-presentation.js";

type Digest = `sha256:${string}`;
export type OperatorQuestionValue =
  | { kind: "read_scope"; scope_digest: Digest }
  | { kind: "attributed_meaning" }
  | { kind: "input_bounds"; requirements: Array<{ outcomes: string[]; input: string;
      start?: number; end?: number; min_length: number; max_length: number }> }
  | { kind: "writer_maintenance"; maintenance: "all_writers_increment" }
  | { kind: "receipt_requirement";
      completion_basis: "applied_change_receipt"; unapplied_status: "pending_or_approved" };

/** A question checkpoint beside the immutable owner handoff. This is neither a
 * Source fact nor an authority revision. The consumer owns currentness/CAS and
 * validates domain values again before its ordinary reviewed save. */
export type OperatorQuestion = {
  version: 1 | 2;
  read_scope?: ReadScopeQuestionBinding;
  id: string;
  revision: number;
  handoff_id?: string;
  kind: OperatorQuestionValue["kind"];
  scope_digest: Digest;
  context_digest: Digest;
  target: { phase: string; resource?: string; field?: string; outcomes: string[] };
  material: string[];
  evidence: Array<{ id: string; digest: Digest }>;
  /** Existing host configuration, never a model interpretation of raw words.
   * Confirmation separately attributes its applicability to the cited duty. */
  receipt_selection?: { source: string; mode: "runner_ledger" | "source_db"; dependencies_digest: Digest };
  continuation: "read_mapping" | "action_rule_review" | "input_policy_review" | "version_mapping" | "receipt_requirement_review";
  /** Saved operator policy, not a fabricated UI answer. Only input review may
   * propose from this evidence without an owner-question handoff. */
  source_binding?: { source_session: string; source_digest: Digest; store_digest: Digest;
    agenda_digest: Digest; lines: number };
  /** A missing-part question draws from its Source interpretation's existing
   * pool. It owns no fresh allowance; the controller reserves the root. */
  budget_owner_id?: string;
  /** Read keeps its producer's counters. New assisted local consumers share
   * ONE existing normal provider allowance across both stages and restart. */
  budget?: { iterations_used: number; tool_calls_used: number; correction_used: boolean };
  /** Inert wording input retained before the existing single correction. */
  wording_state?: { stage: "present" | "source-review"; gate: OperatorClarificationGateState };
  presentation?: { text: string; recorded_at: string };
  raw_answer?: { id: string; text: string; actor: "local_installation_operator"; recorded_at: string };
  proposal?: { question_id: string; revision: number; answer_id?: string; source_reference?: Digest;
    disposition: "pending" | "proposed"; value?: OperatorQuestionValue };
  proposal_history?: NonNullable<OperatorQuestion["proposal"]>[];
  confirmation?: { actor: "local_installation_operator"; recorded_at: string;
    proposal_digest: Digest; decision: "new_attributed_decision" };
  disposition?: "unknown" | "cancelled" | "declined";
  disposition_history?: Array<{ disposition: NonNullable<OperatorQuestion["disposition"]>; recorded_at: string }>;
  /** Exhausted, positively consumed Input or scoped Version interpretation. This is a terminal
   * contract refusal, never a transport classification or a replacement grant. */
  terminal_failure?: { code: "ASK_TOOL_ARGUMENTS_INVALID"; stage: "present" | "source-review" | "answer-map";
    completion: AuthoringQuestionCompletion; recorded_at: string };
  digest: Digest;
};

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every(k => keys.includes(k));
const text = (v: unknown, max: number, blank = false): v is string => typeof v === "string" && v.length <= max && (blank || !!v.trim());
const digest = (v: unknown): v is Digest => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
const id = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9-]{36}$/u.test(v);
const count = (v: unknown, max: number, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
function invalid(reason: string): never { throw new Error(`AUTHORING_QUESTION_INVALID: ${reason} No decision or permission was accepted.`); }
const reseal = (q: Omit<OperatorQuestion, "digest">): OperatorQuestion => parseOperatorQuestion({ ...q, digest: canonicalJsonDigest(q) });

export function createOperatorQuestion(input: Pick<OperatorQuestion,
  "id" | "revision" | "handoff_id" | "kind" | "scope_digest" | "context_digest" | "target" | "material" | "evidence" | "continuation" | "source_binding" | "budget_owner_id" | "receipt_selection"> & {
    assistedLocalConsumer?: boolean;
  }): OperatorQuestion {
  const { assistedLocalConsumer, ...body } = input;
  return reseal({ version: 1, ...structuredClone(body), ...(assistedLocalConsumer
    ? { budget: { iterations_used: 0, tool_calls_used: 0, correction_used: false } } : {}) });
}

export function parseOperatorQuestion(value: unknown): OperatorQuestion {
  if (!object(value) || !exact(value, ["version", "id", "revision", "handoff_id", "kind", "scope_digest", "context_digest", "target",
    "material", "evidence", "receipt_selection", "read_scope", "continuation", "source_binding", "budget_owner_id", "budget", "wording_state", "presentation", "raw_answer", "proposal", "proposal_history", "confirmation", "disposition", "disposition_history", "terminal_failure", "digest"])
    || ![1, 2].includes(value.version as number) || !id(value.id) || value.handoff_id !== undefined && !text(value.handoff_id, 100) || !count(value.revision, Number.MAX_SAFE_INTEGER, 1)
    || !["attributed_meaning", "input_bounds", "writer_maintenance", "receipt_requirement", "read_scope"].includes(value.kind as string)
    || !digest(value.scope_digest) || !digest(value.context_digest) || !digest(value.digest)
    || !object(value.target) || !exact(value.target, ["phase", "resource", "field", "outcomes"])
    || !text(value.target.phase, 100) || value.target.resource !== undefined && !text(value.target.resource, 256)
    || value.target.field !== undefined && (!text(value.target.field, 256) || !value.target.resource)
    || !Array.isArray(value.target.outcomes) || value.target.outcomes.length > (value.kind === "input_bounds" ? 128 : 64)
    || value.target.outcomes.some(o => !text(o, 256)) || new Set(value.target.outcomes).size !== value.target.outcomes.length
    || !Array.isArray(value.material) || value.material.length > 64 || value.material.some(line => !text(line, 2000))
    || !Array.isArray(value.evidence) || value.evidence.length > 64
    || value.evidence.some(e => !object(e) || !exact(e, ["id", "digest"]) || !text(e.id, 256) || !digest(e.digest))
    || !["read_mapping", "action_rule_review", "input_policy_review", "version_mapping", "receipt_requirement_review"].includes(value.continuation as string)
    || Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) invalid("The saved question envelope is malformed or too large.");
  const continuation = { read_scope: "read_mapping", attributed_meaning: "read_mapping", input_bounds: "input_policy_review", writer_maintenance: "version_mapping",
    receipt_requirement: "receipt_requirement_review" };
  if (value.version === 2 ? value.kind !== "read_scope" : value.kind === "read_scope" || value.read_scope !== undefined)
    invalid("The question version does not support this typed interaction.");
  if (value.kind === "read_scope") {
    const binding = parseReadScopeQuestionBinding(value.read_scope);
    if (value.target.phase !== "read_scope" || value.target.resource !== undefined || value.target.field !== undefined
      || value.target.outcomes.length || value.source_binding !== undefined || value.budget !== undefined
      || value.budget_owner_id !== undefined || value.wording_state !== undefined
      || (binding.mode === "review" ? value.handoff_id !== undefined || value.raw_answer !== undefined
        : !text(value.handoff_id, 100) || value.confirmation !== undefined || value.proposal !== undefined))
      invalid("The typed Read review and a missing raw answer must remain separate decisions.");
  }
  if (value.kind === "receipt_requirement") {
    const selection = value.receipt_selection;
    if (!object(selection) || !exact(selection, ["source", "mode", "dependencies_digest"])
      || !text(selection.source, 256) || !["runner_ledger", "source_db"].includes(selection.mode as string)
      || !digest(selection.dependencies_digest) || value.target.phase !== "receipt_requirement"
      || new Set(value.evidence.map(e => (e as { id: string }).id)).size !== value.evidence.length
      || !value.evidence.some(e => object(e) && e.id === "receipt-meaning-dependencies" && e.digest === selection.dependencies_digest))
      invalid("The configured receipt selection is not current host context for this question.");
  } else if (value.receipt_selection !== undefined) invalid("Receipt configuration cannot be attached to another question kind.");
  if (value.source_binding !== undefined) {
    const s = value.source_binding;
    if (value.kind !== "input_bounds" || value.handoff_id !== undefined || value.raw_answer !== undefined
      || !object(s) || !exact(s, ["source_session", "source_digest", "store_digest", "agenda_digest", "lines"])
      || !id(s.source_session) || !digest(s.source_digest) || !digest(s.store_digest) || !digest(s.agenda_digest)
      || !count(s.lines, 600, 1) || s.agenda_digest !== canonicalJsonDigest({ source_session: s.source_session,
        source_digest: s.source_digest, store_digest: s.store_digest, outcomes: value.target.outcomes })) {
      invalid("The input interpretation is not bound to its exact current Source and agenda.");
    }
  } else if (!(value.kind === "read_scope" && (value.read_scope as ReadScopeQuestionBinding).mode === "review") && !text(value.handoff_id, 100)) invalid("A raw-answer question requires its actual owner handoff.");
  if (value.budget_owner_id !== undefined && (!id(value.budget_owner_id) || value.budget_owner_id === value.id
    || !["input_bounds", "receipt_requirement"].includes(value.kind as string) || value.source_binding !== undefined
    || value.kind === "input_bounds" && value.budget !== undefined || value.kind === "receipt_requirement" && value.budget === undefined))
    invalid("The missing-answer question cannot own or reset another allowance.");
  if (continuation[value.kind as OperatorQuestion["kind"]] !== value.continuation
      && !(value.kind === "attributed_meaning" && value.continuation === "action_rule_review")
    || value.kind === "attributed_meaning" && value.continuation === "read_mapping" && !value.target.resource
    || value.kind === "writer_maintenance" && (!value.target.resource || !value.target.field)
    || ["input_bounds", "receipt_requirement"].includes(value.kind as string) && !value.target.outcomes.length) invalid("The decision does not match its exact target or continuation.");
  if (value.budget !== undefined && (!object(value.budget) || !exact(value.budget, ["iterations_used", "tool_calls_used", "correction_used"])
    || !count(value.budget.iterations_used, 6) || !count(value.budget.tool_calls_used, 8) || typeof value.budget.correction_used !== "boolean")) invalid("Invalid owning episode counters.");
  if (value.wording_state !== undefined) {
    const wording = value.wording_state;
    if (!object(wording) || !exact(wording, ["stage", "gate"])
      || wording.stage !== (value.source_binding ? "source-review" : "present")) invalid("Wording belongs to another question stage.");
    const gate = parseOperatorClarificationGateState(wording.gate);
    const target = { ...(value.target.resource ? { resource: value.target.resource } : {}), ...(value.target.field ? { field: value.target.field } : {}) };
    if (gate.stage !== (value.kind === "writer_maintenance" ? "version" : value.kind === "input_bounds" ? "input" : "read")
      || canonicalJsonDigest(gate.target ?? {}) !== canonicalJsonDigest(target)) invalid("Wording belongs to another exact question target.");
  }
  if (value.presentation !== undefined && (!object(value.presentation) || !exact(value.presentation, ["text", "recorded_at"])
    || !text(value.presentation.text, 4000) || !date(value.presentation.recorded_at))) invalid("Invalid saved presentation.");
  if (value.raw_answer !== undefined && (!value.presentation || !object(value.raw_answer) || !exact(value.raw_answer, ["id", "text", "actor", "recorded_at"])
    || !id(value.raw_answer.id) || !text(value.raw_answer.text, value.kind === "attributed_meaning" && ["read_prerequisite", "read_prerequisite_correction"].includes(String(value.target.phase)) ? 8000 : 4000, true) || value.raw_answer.actor !== "local_installation_operator"
    || !date(value.raw_answer.recorded_at))) invalid("Invalid trusted answer reference.");
  if (value.proposal !== undefined) validateProposal(value as OperatorQuestion, value.proposal);
  if (value.proposal_history !== undefined) {
    if (!Array.isArray(value.proposal_history) || value.proposal_history.length > 16) invalid("Invalid proposed interpretation history.");
    for (const previous of value.proposal_history) validateProposal(value as OperatorQuestion, previous);
  }
  if (value.confirmation !== undefined && (!value.proposal || !object(value.confirmation)
    || !exact(value.confirmation, ["actor", "recorded_at", "proposal_digest", "decision"])
    || value.confirmation.actor !== "local_installation_operator" || !date(value.confirmation.recorded_at)
    || value.confirmation.decision !== "new_attributed_decision" || value.confirmation.proposal_digest !== canonicalJsonDigest(value.proposal)
    || (value.proposal as OperatorQuestion["proposal"])!.disposition !== "proposed" || value.disposition !== undefined)) invalid("Invalid material confirmation.");
  if (value.disposition !== undefined && !["unknown", "cancelled", "declined"].includes(value.disposition as string)) invalid("Invalid unresolved disposition.");
  if (value.disposition_history !== undefined && (!Array.isArray(value.disposition_history) || value.disposition_history.length > 64
    || value.disposition_history.some(event => !object(event) || !exact(event, ["disposition", "recorded_at"])
      || !["unknown", "cancelled", "declined"].includes(event.disposition as string) || !date(event.recorded_at)))) invalid("Invalid retained pending history.");
  if (value.terminal_failure !== undefined) {
    const failure = value.terminal_failure, c = object(failure) ? failure.completion : undefined;
    if (!["input_bounds", "writer_maintenance", "receipt_requirement"].includes(value.kind as string) || value.proposal !== undefined || value.confirmation !== undefined || value.disposition !== undefined
      || !object(failure) || !exact(failure, ["code", "stage", "completion", "recorded_at"])
      || failure.code !== "ASK_TOOL_ARGUMENTS_INVALID" || !date(failure.recorded_at)
      || (value.kind === "input_bounds" && failure.stage !== (value.source_binding ? "source-review" : "answer-map"))
      || (value.kind === "writer_maintenance" && !["present", "answer-map"].includes(failure.stage as string))
      || (value.kind === "receipt_requirement" && (failure.stage !== "answer-map" || !object(value.budget) || value.budget.correction_used !== true))
      || (value.kind === "writer_maintenance" && failure.stage === "present" && (value.presentation !== undefined || value.raw_answer !== undefined))
      || (value.kind === "input_bounds" && !value.source_binding && !value.budget_owner_id)
      || (!value.source_binding && failure.stage !== "present" && (!object(value.raw_answer) || !text(value.raw_answer.text, 4000)))
      || (value.kind === "writer_maintenance" && (value.source_binding !== undefined || value.budget !== undefined || value.budget_owner_id !== undefined))
      || (value.source_binding && (!object(value.budget) || value.budget.correction_used !== true))
      || !object(c) || !exact(c, ["operation_id", "request_digest", "context_digest", "response_digest"])
      || !text(c.operation_id, 100) || !digest(c.request_digest) || !digest(c.context_digest) || !digest(c.response_digest)) {
      invalid("The terminal refusal has no exact consumed interpretation binding.");
    }
  }
  const { digest: identity, ...body } = value;
  if (canonicalJsonDigest(body) !== identity) invalid("The question checkpoint changed.");
  return structuredClone(value) as OperatorQuestion;
}

function validateProposal(q: OperatorQuestion, proposal: unknown): asserts proposal is NonNullable<OperatorQuestion["proposal"]> {
  if (!object(proposal) || !exact(proposal, ["question_id", "revision", "answer_id", "source_reference", "disposition", "value"])
    || proposal.question_id !== q.id || proposal.revision !== q.revision
    || !["pending", "proposed"].includes(proposal.disposition as string)) invalid("The proposed answer belongs to another question or response.");
  if (q.read_scope?.mode === "review") {
    if (proposal.answer_id !== undefined || proposal.source_reference !== canonicalJsonDigest(q.read_scope))
      invalid("The Read review must bind its complete typed proposal, without invented raw testimony.");
  } else if (q.source_binding) {
    if (proposal.answer_id !== undefined || proposal.source_reference !== canonicalJsonDigest(q.source_binding))
      invalid("The interpretation references another Source or invented raw testimony.");
  } else if (proposal.source_reference !== undefined || !q.raw_answer || proposal.answer_id !== q.raw_answer.id)
    invalid("The proposed answer belongs to another trusted response.");
  if (proposal.disposition === "pending") { if (proposal.value !== undefined) invalid("A pending answer cannot carry a resolved value."); return; }
  if (!q.source_binding && !q.read_scope && !q.raw_answer!.text.trim()) invalid("A blank response has no resolved meaning.");
  const v = proposal.value;
  if (!object(v) || v.kind !== q.kind) invalid("The proposal changed the decision kind.");
  if (v.kind === "read_scope") {
    if (!exact(v, ["kind", "scope_digest"]) || !q.read_scope || q.read_scope.mode !== "review"
      || v.scope_digest !== q.read_scope.record.digest || !q.read_scope.record.analysis_digest
      || q.read_scope.record.proposal.requirements.some(r => r.disposition === "unresolved"))
      invalid("A scope review requires its exact analyzed, fully resolved proposal.");
  } else if (v.kind === "attributed_meaning") { if (!exact(v, ["kind"])) invalid("Meaning comes from the trusted raw words, not a model quote."); }
  else if (v.kind === "writer_maintenance") {
    if (!exact(v, ["kind", "maintenance"]) || v.maintenance !== "all_writers_increment") invalid("Unknown writer behavior cannot become a different assurance.");
  } else if (v.kind === "receipt_requirement") {
    if (!exact(v, ["kind", "completion_basis", "unapplied_status"])
      || v.completion_basis !== "applied_change_receipt" || v.unapplied_status !== "pending_or_approved")
      invalid("A receipt interpretation must keep configured storage, applied completion and unapplied status distinct.");
  } else if (!exact(v, ["kind", "requirements"]) || !Array.isArray(v.requirements) || v.requirements.length > 256
    || v.requirements.some(r => !object(r) || !exact(r, ["outcomes", "input", "start", "end", "min_length", "max_length"])
      || !Array.isArray(r.outcomes) || !r.outcomes.length || r.outcomes.some(o => !q.target.outcomes.includes(o as string))
      || new Set(r.outcomes).size !== r.outcomes.length || !text(r.input, 128)
      || (q.source_binding !== undefined || r.start !== undefined || r.end !== undefined)
        && (!count(r.start, Number.MAX_SAFE_INTEGER, 1) || !count(r.end, Number.MAX_SAFE_INTEGER, r.start as number))
      || q.source_binding !== undefined && (r.end as number) > q.source_binding.lines
      || !count(r.min_length, 4096) || !count(r.max_length, 4096, r.min_length as number))) invalid("Invalid current input ranges. Normal Source review is still required.");
}

function update(q: OperatorQuestion, mutate: (value: Omit<OperatorQuestion, "digest">) => void): OperatorQuestion {
  const { digest: _, ...body } = parseOperatorQuestion(q);
  if (body.confirmation) invalid("This question is already confirmed; use the ordinary reviewed change flow.");
  if (body.terminal_failure) invalid("This interpretation has stopped. Its saved evidence cannot be reopened or adopted.");
  mutate(body); return reseal(body);
}
export function presentOperatorQuestion(q: OperatorQuestion, text: string): OperatorQuestion {
  return update(q, next => {
    if (next.presentation) invalid("Redisplay the saved presentation; do not generate another one.");
    next.presentation = { text, recorded_at: new Date().toISOString() };
  });
}
/** The host saves this input under its ordinary raw currentness/CAS boundary,
 * without acknowledging a response or changing the question's allowance. */
export function retainOperatorQuestionWording(q: OperatorQuestion, wording: NonNullable<OperatorQuestion["wording_state"]>): OperatorQuestion {
  return update(q, next => {
    if (next.presentation || next.raw_answer || next.proposal || next.disposition) invalid("Do not rewrite wording for an already presented or interpreted question.");
    if (next.wording_state && canonicalJsonDigest(next.wording_state) !== canonicalJsonDigest(wording)) invalid("The original wording input cannot be replaced.");
    next.wording_state = structuredClone(wording);
  });
}
export function captureOperatorAnswer(q: OperatorQuestion, raw: string): OperatorQuestion {
  return update(q, next => {
    if (next.raw_answer) invalid("An answer is already saved. Inspect it before a reviewed replacement.");
    next.raw_answer = { id: randomUUID(), text: raw, actor: "local_installation_operator", recorded_at: new Date().toISOString() };
  });
}
export function proposeOperatorAnswer(q: OperatorQuestion, proposal: unknown): OperatorQuestion {
  validateProposal(parseOperatorQuestion(q), proposal);
  return update(q, next => {
    if (next.proposal) next.proposal_history = [...(next.proposal_history ?? []), next.proposal];
    next.proposal = structuredClone(proposal);
  });
}
export function confirmOperatorAnswer(q: OperatorQuestion): OperatorQuestion {
  return update(q, next => {
    if (next.proposal?.disposition !== "proposed" || next.disposition) invalid("No material proposal is ready for explicit operator adoption.");
    next.confirmation = { actor: "local_installation_operator", recorded_at: new Date().toISOString(),
      proposal_digest: canonicalJsonDigest(next.proposal), decision: "new_attributed_decision" };
  });
}
export function leaveOperatorQuestionPending(q: OperatorQuestion, disposition: NonNullable<OperatorQuestion["disposition"]>): OperatorQuestion {
  return update(q, next => {
    next.disposition = disposition;
    next.disposition_history = [...(next.disposition_history ?? []), { disposition, recorded_at: new Date().toISOString() }];
  });
}
/** Called only by the supported operator continuation; grants no new allowance. */
export function reopenOperatorQuestion(q: OperatorQuestion): OperatorQuestion {
  return update(q, next => { delete next.disposition; });
}

/** The controller supplies only a producer-minted actual consumed completion
 * under its existing currentness/CAS boundary. A matching error code alone is
 * not permission to call this function. */
export function stopOperatorInputQuestion(q: OperatorQuestion,
  failure: { stage: "source-review" | "answer-map"; completion: AuthoringQuestionCompletion }): OperatorQuestion {
  if (q.kind !== "input_bounds") invalid("An Input refusal cannot establish a Version stop.");
  return update(q, next => {
    next.terminal_failure = { code: "ASK_TOOL_ARGUMENTS_INVALID", ...structuredClone(failure), recorded_at: new Date().toISOString() };
  });
}

/** The Version controller must verify actual pending marker/proof/root/correction
 * ownership at its enclosing Resume CAS. This shape alone grants no retry or assurance. */
export function stopOperatorVersionQuestion(q: OperatorQuestion,
  failure: { stage: "present" | "answer-map"; completion: AuthoringQuestionCompletion }): OperatorQuestion {
  if (q.kind !== "writer_maintenance") invalid("A Version refusal cannot establish an Input stop.");
  return update(q, next => {
    next.terminal_failure = { code: "ASK_TOOL_ARGUMENTS_INVALID", ...structuredClone(failure), recorded_at: new Date().toISOString() };
  });
}

/** Storage and association checks. Current database/Source evidence is checked
 * again by the owning controller under its existing authority mutation/CAS. */
export function parseOperatorQuestions(value: unknown, handoffs: readonly AuthoringOwnerHandoff[], generation?: AuthoringTransportState): OperatorQuestion[] {
  if (!Array.isArray(value) || value.length > 64) invalid("Invalid saved question inventory.");
  const seen = new Set<string>();
  const result = value.map(parseOperatorQuestion);
  for (const q of result) {
    if (seen.has(q.id)) invalid("Duplicate question identity.");
    seen.add(q.id);
    if (q.budget_owner_id) {
      const root = result.find(record => record.id === q.budget_owner_id);
      if (q.kind === "receipt_requirement") {
        const earlier = result.filter(other => seen.has(other.id) && other.id !== q.id
          && (other.id === q.budget_owner_id || other.budget_owner_id === q.budget_owner_id));
        const previous = earlier.at(-1);
        if (!root || !previous || !root.budget || !previous.budget || !q.budget || root.kind !== q.kind || root.budget_owner_id
          || q.revision !== previous.revision + 1 || root.scope_digest !== q.scope_digest
          || canonicalJsonDigest(root.target) !== canonicalJsonDigest(q.target)
          || canonicalJsonDigest(root.receipt_selection) !== canonicalJsonDigest(q.receipt_selection)
          || q.evidence.find(e => e.id === "receipt-source-range")?.digest !== root.evidence.find(e => e.id === "receipt-source-range")?.digest
          || q.budget.iterations_used < previous.budget.iterations_used || q.budget.tool_calls_used < previous.budget.tool_calls_used
          || previous.budget.correction_used && !q.budget.correction_used) invalid("The replacement receipt answer lost its original owning allowance or exact requirement.");
      } else if (!root || !seen.has(root.id) || root.kind !== "input_bounds" || !root.source_binding || !root.budget
        || root.budget_owner_id || root.confirmation || root.terminal_failure || q.revision <= root.revision
        || root.scope_digest !== q.scope_digest || root.context_digest !== q.context_digest
        || canonicalJsonDigest(root.target) !== canonicalJsonDigest(q.target)
        || canonicalJsonDigest(root.material) !== canonicalJsonDigest(q.material)
        || canonicalJsonDigest(root.evidence) !== canonicalJsonDigest(q.evidence)
        || result.some(other => other.id !== q.id && other.budget_owner_id === q.budget_owner_id && other.revision === q.revision))
        invalid("The missing-answer question has no exact current owning Source episode.");
      if (q.kind === "input_bounds" && q.terminal_failure && !root!.budget!.correction_used) invalid("The owning Input correction was not exhausted.");
    }
    if (q.terminal_failure) {
      const c = q.terminal_failure.completion, op = generation?.operations.find(op => op.id === c.operation_id);
      if (!op || !["handled", "checkpointed"].includes(op.state) || op.request_digest !== c.request_digest
        || op.context_digest !== c.context_digest || op.attempts.at(-1)?.outcome !== "response") {
        invalid("The terminal Input refusal has no consumed generation in its saved history.");
      }
    }
    if (q.read_scope) {
      assertAuthoringReadCheckpoint(generation, q.read_scope.completion, readScopeConsumption(q.read_scope));
      const predecessor = q.read_scope.predecessor_id ? result.find(p => p.id === q.read_scope!.predecessor_id) : undefined;
      if (q.read_scope.predecessor_id ? !predecessor || !seen.has(predecessor.id) || predecessor.id === q.id
        || predecessor.kind !== "read_scope" || predecessor.read_scope?.mode !== q.read_scope.mode
        || predecessor.scope_digest !== q.scope_digest || q.revision !== predecessor.revision + 1
        || result.some(other => other.id !== q.id && other.read_scope?.predecessor_id === predecessor.id)
        : q.revision !== 1) invalid("A Read replacement must retain its exact preceding question, without branching history.");
      for (const ref of q.read_scope.record.references) {
        if (ref.kind !== "answer") continue;
        const captured = result.find(item => item.id === ref.question_id);
        if (!captured || !seen.has(captured.id) || captured.id === q.id || captured.revision !== ref.question_revision
          || !captured.raw_answer || !captured.raw_answer.text.trim()
          || captured.raw_answer.id !== ref.answer_id || captured.raw_answer.text !== ref.text
          || canonicalJsonDigest(captured.raw_answer) !== ref.digest)
          invalid("The Read proposal references stale, replaced or invented operator testimony.");
      }
      if (q.read_scope.mode === "review") continue;
    }
    if (q.source_binding) continue;
    const h = handoffs.find(handoff => handoff.id === q.handoff_id);
    if (!h || h.scope_digest !== q.scope_digest || h.context_digest !== q.context_digest
      || q.kind === "attributed_meaning" && q.presentation && q.presentation.text !== h.question
      || q.kind === "attributed_meaning" && !(q.continuation === "action_rule_review"
        ? h.consumer === "policy_clarification" : ["read_clarification", "read_revision_clarification", "read_revision_prerequisite"].includes(h.consumer))
      || q.kind === "read_scope" && (!["read_clarification", "read_revision_clarification"].includes(h.consumer)
        || q.presentation && q.presentation.text !== h.question
        || canonicalJsonDigest(h.completion ?? null) !== canonicalJsonDigest(q.read_scope!.completion))
      || q.kind === "input_bounds" && h.consumer !== "input_policy"
      || q.kind === "writer_maintenance" && h.consumer !== "version_maintenance"
      || q.kind === "receipt_requirement" && h.consumer !== "policy_clarification"
      || h.state === "answered" && !q.disposition && (!q.raw_answer || h.answer !== q.raw_answer.text || h.actor !== q.raw_answer.actor)
      || q.confirmation && (h.state !== "answered" || !q.raw_answer?.text.trim())) invalid("The question has no exact attributable owner handoff.");
    if (h.consumer === "read_revision_prerequisite"
      && (q.kind !== "attributed_meaning" || q.continuation !== "read_mapping"
        || !["read_prerequisite", "read_prerequisite_correction"].includes(q.target.phase)))
      invalid("The private Read statement has no exact stage association.");
    if (q.budget_owner_id && q.kind === "input_bounds") {
      const root = result.find(record => record.id === q.budget_owner_id)!;
      const predecessors = result.filter(other => seen.has(other.id) && other.id !== q.id
        && other.budget_owner_id === root.id);
      const previous = predecessors.at(-1);
      if (q.revision !== root.revision + predecessors.length + 1 || !q.presentation || q.presentation.text !== h.question)
        invalid("The missing-answer question lost its exact presentation or consecutive Source revision.");
      if (!previous) {
        // The full resume validator checks this reference against the real B35
        // ledger. A bare host checkpoint cannot originate a model question.
        if (!h.completion) invalid("The first missing-answer question has no consumed generation provenance.");
      } else {
        const previousHandoff = handoffs.find(record => record.id === previous.handoff_id);
        if (!previous.disposition || previous.confirmation || !previous.raw_answer
          || previous.presentation?.text !== q.presentation.text || !previousHandoff)
          invalid("A replacement must retain the immediately preceding unresolved answer.");
        if (h.id === previousHandoff.id) {
          // After the new child is answered, the shared handoff is answered too;
          // the old blank remains immutable evidence, never that new answer.
          if (previous.raw_answer.text.trim()) invalid("An answered handoff cannot receive a replacement raw answer.");
        } else if (h.completion || previousHandoff.state !== "answered" || !previous.raw_answer.text.trim()
          || previousHandoff.answer !== previous.raw_answer.text || previousHandoff.actor !== previous.raw_answer.actor) {
          invalid("A replacement host question requires the actual acknowledged predecessor; no completion may be copied.");
        }
      }
    }
  }
  return result;
}

/** A valid digest is not permission to erase acknowledged history or renew an
 * episode. This runs at the same durable CAS as the surrounding resume save. */
export function assertOperatorQuestionsAdvance(previous: readonly OperatorQuestion[], next: readonly OperatorQuestion[]): void {
  for (const old of previous) {
    const current = next.find(q => q.id === old.id);
    if (!current) invalid("The saved question or its history was removed.");
    if (old.confirmation || old.terminal_failure) {
      if (current.digest !== old.digest) invalid(old.terminal_failure
        ? "A terminal Input refusal changed outside its supported continuation."
        : "An accepted decision changed outside the ordinary reviewed replacement flow.");
      continue;
    }
    const fixed = (q: OperatorQuestion) => ({ version: q.version, id: q.id, revision: q.revision,
      ...(q.handoff_id ? { handoff_id: q.handoff_id } : {}),
      kind: q.kind, scope_digest: q.scope_digest, context_digest: q.context_digest, target: q.target,
      material: q.material, evidence: q.evidence, continuation: q.continuation,
      ...(q.read_scope ? { read_scope: q.read_scope } : {}),
      ...(q.receipt_selection ? { receipt_selection: q.receipt_selection } : {}),
      ...(q.source_binding ? { source_binding: q.source_binding } : {}),
      ...(q.budget_owner_id ? { budget_owner_id: q.budget_owner_id } : {}) });
    if (canonicalJsonDigest(fixed(old)) !== canonicalJsonDigest(fixed(current))) invalid("A pending question's routing or currentness binding changed.");
    for (const field of ["wording_state", "presentation", "raw_answer"] as const) {
      if (old[field] && canonicalJsonDigest(old[field]) !== canonicalJsonDigest(current[field] ?? null)) invalid("Presented or captured evidence changed.");
    }
    if (old.budget && (!current.budget || current.budget.iterations_used < old.budget.iterations_used
      || current.budget.tool_calls_used < old.budget.tool_calls_used || old.budget.correction_used && !current.budget.correction_used)
      || !old.budget && current.budget) invalid("Question ownership or episode counters changed.");
    const oldHistory = [...(old.proposal_history ?? []), ...(old.proposal ? [old.proposal] : [])];
    const newHistory = [...(current.proposal_history ?? []), ...(current.proposal ? [current.proposal] : [])];
    if (oldHistory.some((p, n) => canonicalJsonDigest(p) !== canonicalJsonDigest(newHistory[n] ?? null))) invalid("Proposed interpretation history changed.");
    if ((old.disposition_history ?? []).some((event, n) => canonicalJsonDigest(event) !== canonicalJsonDigest(current.disposition_history?.[n] ?? null))) invalid("Pending/cancel history changed.");
  }
}

/** Host-owned readback. Assistant prose is not used to construct these facts. */
export function operatorQuestionReadback(q: OperatorQuestion): string[] {
  parseOperatorQuestion(q);
  const v = q.proposal?.value;
  if (!v || q.proposal?.disposition !== "proposed") return ["This answer is still pending. No interpretation or permission will be recorded.", ...q.material];
  if (v.kind === "read_scope") return [
    "Review the complete proposed Read scope. This decision does not activate access.",
    ...q.read_scope!.record.proposal.requirements.flatMap(requirement => [
      `${requirement.disposition}: ${requirement.intended_use}`,
      ...requirement.targets.map(target => `${target.operation}: ${target.root_resource} / ${target.resource}${target.field ? ` / ${target.field}` : ""}${target.relationship ? ` / ${target.relationship}` : ""}${target.qualifier ? ` / ${target.qualifier}` : ""}`),
    ]), ...q.material,
  ];
  if (v.kind === "attributed_meaning") return [
    q.continuation === "action_rule_review" ? "Record your exact words as a business statement for this Action question:"
      : `Record your exact words as the business meaning of ${q.target.resource}${q.target.field ? ` / ${q.target.field}` : ""}:`,
    q.raw_answer!.text, ...q.material,
    "This records your statement for this task. It does not prove the statement or grant access, approval or execution.",
  ];
  if (v.kind === "writer_maintenance") return [
    `For ${q.target.resource}, every application, script and person changing a record also increments its ${q.target.field} change counter.`,
    "Confirm only if you can make that statement for all writers. If you do not know, keep it pending and ask the person responsible for those applications.",
    "This is a new, unverified operator assertion. Column presence and the assistant's answer are not proof of writer behavior.",
    ...q.material,
  ];
  if (v.kind === "receipt_requirement") return [
    ...q.material, "Your captured answer, retained exactly:", q.raw_answer!.text,
    `Runner's currently configured receipt location: ${q.receipt_selection!.mode === "runner_ledger" ? "Runner's local ledger, outside the source database transaction" : "the source database, in the same transaction as the applied change"}. This fact comes from configuration, not your answer.`,
    "A change may be described as completed only from its trusted completion receipt. Pending or approved requests are not completed changes.",
    "Confirm only if this shown receipt location satisfies the cited completion requirement. A requirement for a receipt in the same source transaction cannot be met by the local ledger.",
    "This records your interpretation of the cited requirement. It does not switch receipt storage, prove a source effect, waive another policy duty or authorize execution.",
  ];
  return [
    ...q.material,
    ...(q.raw_answer ? ["Basis: your captured answer, retained exactly; no policy-line citation or permission is inferred.", q.raw_answer.text] : []),
    ...v.requirements.map(r => `${r.outcomes.join(", ")}: ${r.input}. If this input is supplied as a string, its length is ${r.min_length} to ${r.max_length} UTF-16 units. ${r.min_length === 0 ? "Empty text is allowed by this length rule." : "Empty text is outside this length range."} Null is not a string. Spaces are counted; nothing is trimmed.`),
    "This length interpretation does not change whether the input is required, whether null is allowed, or its allowed enum values.",
    "Length follows JavaScript string length: a supplementary symbol such as 😀 counts as two units; an e plus a combining accent counts as two. This is not a count of visible characters.",
    ...(v.requirements.length ? [] : ["No explicit string length range is recorded for these Actions. Other policy duties remain subject to complete review."]),
    "Only these shown interpretations will be saved. Other requirements, permissions and business rules remain subject to their normal review.",
  ];
}

/** The adapter MUST implement save with its existing currentness/CAS boundary.
 * No mutation is returned to the callback until that durable save succeeds. */
export function operatorQuestionEpisode(host: { read(): OperatorQuestion; save(next: OperatorQuestion, expected: Digest): Promise<void> }):
  AskAuthoringEpisodeBudget & { reserveCorrection(): Promise<boolean> } {
  const change = async (run: (budget: NonNullable<OperatorQuestion["budget"]>) => boolean): Promise<boolean> => {
    const q = parseOperatorQuestion(host.read());
    if (!q.budget) invalid("The existing producer, not this helper, owns this question's allowance.");
    const next = update(q, body => { if (!run(body.budget!)) throw new AskError("ASK_TOOL_BUDGET_EXCEEDED",
      "The saved question's authoring allowance is exhausted. Inspect the retained question and raw answer; reopening does not renew the allowance.", 422); });
    await host.save(next, q.digest); return true;
  };
  return {
    admitIteration: async () => { await change(b => { if (b.iterations_used === 6) return false; b.iterations_used++; return true; }); },
    reserveToolBatch: async n => {
      if (!count(n, 4, 1)) invalid("Invalid provider tool batch.");
      await change(b => { if (b.tool_calls_used + n > 8) return false; b.tool_calls_used += n; return true; });
    },
    reserveCorrection: async () => {
      if (parseOperatorQuestion(host.read()).budget?.correction_used) return false;
      return change(b => { if (b.correction_used) return false; b.correction_used = true; return true; });
    },
  };
}
