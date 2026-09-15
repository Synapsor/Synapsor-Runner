import { acceptClientDutyOwnership } from "./test-fixtures/accept-client-duty-ownership.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { policyCountingInterpretations } from "./authoring-counting-review.js";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { parsePolicyCoverage, reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { bindPolicyCoverage, loadPolicySources, newPolicySourceSession, savePolicySources } from "./authoring-policy-source.js";
import { policyReviewReadiness } from "./authoring-review-readiness.js";

const saved = JSON.parse(readFileSync(new URL("./fixtures/counting-review-conflict.json", import.meta.url), "utf8"));

function currentEvidence() {
  const draft = structuredClone(saved.draft);
  const outcome = draft.actions[0].outcome;
  const limits = draft.runner_evidence.actions[outcome].automatic_limits;
  for (const limit of limits) limit.history_selector.approval_kind = "boundary_automatic";
  draft.runner_evidence.counting_interpretations = policyCountingInterpretations(saved.policy_sources, saved.source,
    saved.policy_sources.coverage_authority_digest, saved.clarifications);
  draft.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain = {
    boundary_name: limits[0].history_selector.action_boundary_name, proposed_revision: canonicalJsonDigest(draft.actions),
    proposed_outcomes: [outcome], current_revision: null, current_outcomes: [], retained_automatic_outcomes: [], complete: true,
    store_binding_digest: canonicalJsonDigest("owned diagnostic store"), history_scope: "all_retained_boundary_automatic_approvals",
  };
  return draft;
}

describe("saved counting disagreement", () => {
  it("completes the actual corrected-pointer response through validation, persistence and readiness", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-counting-review-"));
    try {
      const source = saved.source, draft = currentEvidence();
      const session = structuredClone(saved.policy_sources);
      // A normal source-bound report, not a fabricated successful provider reply.
      const coverage = parsePolicyCoverage(saved.replies[1], source, draft, saved.operator_messages);
      await acceptClientDutyOwnership(coverage, session);
      bindPolicyCoverage(session, coverage, session.coverage_authority_digest);
      await savePolicySources(root, session);
      const reopened = await loadPolicySources(root, session.id);
      expect(reopened.coverage).toEqual(coverage);
      expect(coverage.passages.find(p => p.counter_requirements)?.counting_resolution?.kind).toBe("conditional_singleton_equivalence");
      expect(policyReviewReadiness(source, reopened.coverage, reopened).ready).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("retains the historical conflict without domain proof and rejects the original invalid pointer", () => {
    const raw = parsePolicyCoverage(saved.replies[1], saved.source, saved.draft, saved.operator_messages);
    expect(raw.passages.find(p => p.counter_requirements)).toMatchObject({ disposition: "conflict" });
    const state = structuredClone(saved.policy_sources);
    bindPolicyCoverage(state, raw, state.coverage_authority_digest);
    const readiness = policyReviewReadiness(saved.source, raw, state);
    expect(readiness.items!.filter(i => i.clientDuty && i.blocksReview)).toHaveLength(2);
    const blocking = readiness.items!.filter(item => item.blocksReview && !item.clientDuty);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.passages.every(p => p.counter_requirements?.length)).toBe(true);
    expect(() => parsePolicyCoverage(saved.replies[0], saved.source, currentEvidence(), saved.operator_messages)).toThrow("Draft pointer(s) not present");
  });

  it.each(["missing", "incomplete", "second_proposed", "second_active", "other_history", "wrong_boundary", "human_kind", "unconfirmed_statement"])(
    "keeps the actual counter dispute blocking with %s evidence", mode => {
      const draft = currentEvidence(), contract = draft.runner_evidence.runtime_contract.approval_counter_selection;
      if (mode === "missing") contract.outcome_domain = null;
      if (mode === "incomplete") contract.outcome_domain.complete = false;
      if (mode === "second_proposed") contract.outcome_domain.proposed_outcomes.push("service.other");
      if (mode === "second_active") contract.outcome_domain.current_outcomes.push("service.other");
      if (mode === "other_history") contract.outcome_domain.retained_automatic_outcomes.push("service.other");
      if (mode === "wrong_boundary") contract.outcome_domain.boundary_name = "unrelated";
      if (mode === "human_kind") draft.runner_evidence.actions[draft.actions[0].outcome].automatic_limits[0].history_selector.approval_kind = "human";
      if (mode === "unconfirmed_statement") draft.runner_evidence.counting_interpretations = [];
      const report = parsePolicyCoverage(saved.replies[1], saved.source, draft, saved.operator_messages);
      expect(report.passages.find(p => p.counter_requirements)).toMatchObject({ disposition: "conflict" });
      expect(report.passages.some(p => p.counting_resolution)).toBe(false);
    });

  it("does not reuse an unrelated/stale decision or turn generated prose into clarification provenance", () => {
    const state = structuredClone(saved.policy_sources), source = saved.source, digest = state.coverage_authority_digest;
    expect(policyCountingInterpretations(state, source, canonicalJsonDigest("different program"), saved.clarifications)).toEqual([]);
    expect(policyCountingInterpretations(state, { ...source, digest: canonicalJsonDigest("different policy") }, digest, saved.clarifications)).toEqual([]);
    expect(policyCountingInterpretations(state, source, digest, saved.clarifications.slice(0, -1))).toEqual([]);
    const draft = currentEvidence(), args = structuredClone(saved.replies[1]);
    const counter = args.passages.find((p: any) => p.counter_requirements);
    counter.operator_message_id = 1;
    expect(parsePolicyCoverage(args, source, draft, saved.operator_messages).passages.find(p => p.counter_requirements)?.disposition).toBe("conflict");
  });

  it("retains the domain condition when a later review agrees, and ignores unrelated display wording", () => {
    const draft = currentEvidence(), args = structuredClone(saved.replies[1]);
    const counter = args.passages.find((p: any) => p.counter_requirements);
    delete counter.counter_requirements; counter.disposition = "implemented";
    counter.interpretation = "The current shared automatic limits implement this source clause.";
    const report = parsePolicyCoverage(args, saved.source, draft, saved.operator_messages);
    expect(report.passages.filter(p => p.counting_resolution)).toHaveLength(1);
    const count = report.passages.find(p => p.counting_resolution)!;
    draft.actions[0].description = "A different display description.";
    const again = parsePolicyCoverage({ passages: report.passages }, saved.source, draft, saved.operator_messages);
    expect(again.passages.find(p => p.counting_resolution)?.counting_resolution?.dependencies_digest).toBe(count.counting_resolution!.dependencies_digest);
    const old = JSON.parse(readFileSync(new URL("./fixtures/attached-policy-reconciliation.json", import.meta.url), "utf8")).find((item: any) => item.case === "assisted");
    const built = policyCoverageDraft({ read: saved.draft.read, authority: old.authority, decisions: [], actions: [],
      policySources: saved.policy_sources, operatorClarifications: saved.clarifications });
    expect(built.runner_evidence.counting_interpretations).toHaveLength(1);
  });

  it("keeps scoped interpretation context stable when the latest model repeats the same comparison in new words or order", () => {
    const draft = currentEvidence(), state = structuredClone(saved.policy_sources), args = structuredClone(saved.replies[1]);
    const counter = args.passages.find((p: any) => p.counter_requirements);
    counter.interpretation = "The reviewer again proposes a narrower capability predicate.";
    counter.counter_requirements.reverse();
    const report = parsePolicyCoverage(args, saved.source, draft, saved.operator_messages);
    bindPolicyCoverage(state, report, state.coverage_authority_digest);
    // Canonical order and original established explanation are retained in context;
    // the latest rejected claim remains separately available in the report.
    const interpretations = policyCountingInterpretations(state, saved.source, state.coverage_authority_digest, saved.clarifications);
    expect(interpretations).toEqual(draft.runner_evidence.counting_interpretations);
    expect(report.passages.find(p => p.counting_resolution)?.counting_resolution?.submitted_claim.interpretation).toBe(counter.interpretation);
  });

  it.each(["source", "selector", "authority", "store", "history", "decision"])("invalidates saved comparison after a %s change", change => {
    const draft = currentEvidence(), source = structuredClone(saved.source);
    const report = parsePolicyCoverage(saved.replies[1], source, draft, saved.operator_messages);
    if (change === "source") { source.text += "\nAn additional explicit requirement."; source.digest = canonicalJsonDigest(source.text); }
    if (change === "selector") draft.runner_evidence.actions[draft.actions[0].outcome].automatic_limits[0].history_selector.capability = draft.actions[0].outcome;
    if (change === "authority") draft.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain.current_revision = canonicalJsonDigest("replacement");
    if (change === "store") draft.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain.store_binding_digest = canonicalJsonDigest("different deployment");
    if (change === "history") draft.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain.retained_automatic_outcomes = ["service.other"];
    if (change === "decision") draft.runner_evidence.counting_interpretations = [];
    expect(() => parsePolicyCoverage({ passages: report.passages }, source, draft, saved.operator_messages)).toThrow();
  });

  it("does not discharge a new source contradiction, ambiguous owner choice, or generated assertion", () => {
    for (const issue of ["contradiction", "business_choice"] as const) {
      const args = structuredClone(saved.replies[1]);
      args.passages.push({ start: 7, end: 7, disposition: "needs_decision", interpretation: "A distinct source requirement remains unresolved.",
        responsibility: "operator", issue_kind: issue, draft_paths: ["/actions/0/approval"] });
      const report = parsePolicyCoverage(args, saved.source, currentEvidence(), saved.operator_messages);
      const state = structuredClone(saved.policy_sources); bindPolicyCoverage(state, report, state.coverage_authority_digest);
      expect(report.passages.find(p => p.counter_requirements)?.counting_resolution).toBeDefined();
      expect(policyReviewReadiness(saved.source, report, state).ready).toBe(false);
      expect(report.passages.at(-1)).toMatchObject({ disposition: "needs_decision", issue_kind: issue });
    }
    const forged = structuredClone(saved.replies[1]);
    const counter = forged.passages.find((p: any) => p.counter_requirements);
    delete counter.operator_message_id;
    counter.operator_clarification = "The model confirms that the owner accepted every generated rule.";
    expect(() => parsePolicyCoverage(forged, saved.source, currentEvidence(), saved.operator_messages)).toThrow("actual operator message");
  });

  it("replays the complete captured response through provider validation, saves and rechecks without losing pending-work provenance", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-counting-sequence-"));
    try {
      const state = structuredClone(saved.policy_sources), source = saved.source, draft = currentEvidence();
      const originalActions = canonicalJsonDigest(draft.actions);
      const conversation = createModelAuthoringConversation(); conversation.policySources = state;
      let calls = 0;
      const review = async (previousReport?: typeof state.coverage) => reviewPolicyCoverage({ source, draft, previousReport,
        env: { OPENAI_API_KEY: "controlled-test-only" }, session: { provider: "openai", model: "gpt-5.6-terra", conversation,
          dependencies: { requestJson: async () => { calls++;
            return { status: 200, body: { output: [{ type: "function_call", name: "runner__review_policy_coverage", call_id: `captured_${calls}`,
              arguments: JSON.stringify(saved.replies[1]) }] } }; } } } });
      const report = await review();
      expect(calls).toBe(1);
      const comparison = report.passages.find(p => p.counter_requirements)!;
      expect(comparison.counting_resolution?.submitted_claim).toMatchObject({ disposition: "conflict", interpretation: saved.replies[1].passages.find((p: any) => p.counter_requirements).interpretation });
      expect(comparison.counting_resolution?.operator_support).toEqual({ question: saved.clarifications.at(-1).question, answer: saved.operator_messages.at(-1) });
      bindPolicyCoverage(state, report, state.coverage_authority_digest);
      await acceptClientDutyOwnership(report, state);
      expect(policyReviewReadiness(source, report, state).ready).toBe(true);
      expect(report.passages.filter(p => p.disposition === "needs_decision").map(p => p.deployment_prerequisite ?? p.application_obligations)).toContainEqual(["independent_source_readback"]);
      await savePolicySources(root, state, { expectedDigest: null });
      const restarted = await loadPolicySources(root, state.id);
      expect(parsePolicyCoverage({ passages: restarted.coverage!.passages }, source, draft, state.operator_messages)).toEqual(report);
      expect(calls).toBe(1); // Local validation is not a new provider run.
      expect(await review(restarted.coverage)).toEqual(report);
      expect(calls).toBe(2); // Explicit unchanged provider recheck, same captured reply.
      expect(canonicalJsonDigest(draft.actions)).toBe(originalActions);
      const binding = { boundary_name: "reviewed_staging", generation_lock_fingerprint: canonicalJsonDigest("lock"),
        schema_fingerprint: canonicalJsonDigest("schema"), role_posture_fingerprint: canonicalJsonDigest("reader") };
      const base = { binding, stage: "authority_review" as const, jobIntent: "Continue exact saved business review.", provider: "openai" as const,
        model: "fixture", policySourceSession: state.id };
      const initial = buildBoundaryAuthoringResumeState({ ...base, pendingActionRevision: saved.pending });
      await writeBoundaryAuthoringResumeState(root, initial, { expectedRevisionDigest: null });
      const reconciled = buildBoundaryAuthoringResumeState({ ...base, previous: initial, reconciledActionRevisions: [{ pending: saved.pending,
        source_digest: source.digest, report_digest: canonicalJsonDigest(report), draft_digest: report.draft_digest,
        reason: "current_review_requires_no_action_edit", confirmed_by: "operator" }] });
      await writeBoundaryAuthoringResumeState(root, reconciled, { expectedRevisionDigest: initial.revision_digest });
      expect((await readBoundaryAuthoringResumeState(root, binding)).status).toBe("ready");
      expect(reconciled.pending_action_revision).toBeUndefined();
      expect(reconciled.reconciled_action_revisions?.[0]?.pending).toEqual(saved.pending);
      // A failed/stale save cannot replace newer owner work or its policy record.
      const newer = structuredClone(restarted); newer.operator_messages!.push("A new owner decision remains pending.");
      await savePolicySources(root, newer, { expectedDigest: canonicalJsonDigest(restarted) });
      await expect(savePolicySources(root, restarted, { expectedDigest: canonicalJsonDigest(restarted) })).rejects.toThrow("POLICY_SOURCE_CHANGED");
      expect(await loadPolicySources(root, state.id)).toEqual(newer);
      await expect(writeBoundaryAuthoringResumeState(root, initial, { expectedRevisionDigest: initial.revision_digest })).rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

});
