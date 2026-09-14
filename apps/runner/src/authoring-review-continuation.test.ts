import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { readFileSync } from "node:fs";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { parsePolicyCoverage, reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { activePolicySource, authoringDestination, bindPolicyCoverage, loadPolicySources, newPolicySourceSession,
  policyTextSnapshot, savePolicySources, type PolicyPassage } from "./authoring-policy-source.js";
import { policyReviewReadiness } from "./authoring-review-readiness.js";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState,
  clearBoundaryAuthoringResumeState, type BoundaryAuthoringActionRevision, type BoundaryAuthoringResumeBinding } from "./boundary-authoring-resume.js";

type SavedReviewBaseline = { case: string; read: Parameters<typeof policyCoverageDraft>[0]["read"];
  authority: NonNullable<Parameters<typeof policyCoverageDraft>[0]["authority"]>; operator_messages: string[];
  pending: BoundaryAuthoringActionRevision; policy_excerpt: string };
const saved = JSON.parse(readFileSync(new URL("./fixtures/attached-policy-reconciliation.json", import.meta.url), "utf8")) as SavedReviewBaseline[];

const binding: BoundaryAuthoringResumeBinding = { boundary_name: "reviewed_staging",
  generation_lock_fingerprint: canonicalJsonDigest("generation"), schema_fingerprint: canonicalJsonDigest("schema"),
  role_posture_fingerprint: canonicalJsonDigest("reader") };
const readbackPath = "/runner_evidence/runtime_contract/application_obligations/independent_source_readback";

// Controlled reviews of the exact saved quota/readback clause and programs.
// These do not claim a fresh model run, complete policy review, or source effect.
describe("saved policy review continuation", () => {
  it("uses only an exact saved execution-policy binding and never treats it as a receipt or independent observation", () => {
    const baseline = saved.find(item => item.case === "original")!;
    const input = { read: baseline.read, authority: baseline.authority, actions: [], decisions: [] };
    const review = { action_digest: baseline.authority.authority.action_boundary.digest,
      enabled_outcomes: baseline.authority.authority.rules.map(rule => rule.rule.outcome), policy_digest: canonicalJsonDigest("exact reviewed operator policy") };
    const evidence = policyCoverageDraft({ ...input, executionReview: review }).runner_evidence.runtime_contract;
    expect(evidence.saved_execution_review).toMatchObject({ ...review, authority: "existing_operator_execution_policy",
      live_writer_rechecked: false, worker_running_verified: false, receipt_mode_verified: false,
      independent_source_readback_verified: false });
    expect(evidence.application_obligations.independent_source_readback).toMatchObject({ verified: false, observation_scope: null });
    expect(evidence.receipts).toContain("source_db records the applied receipt in the same source transaction");
    expect(policyCoverageDraft(input).runner_evidence.runtime_contract.saved_execution_review).toBeNull();
    expect(policyCoverageDraft({ ...input, executionReview: { ...review, action_digest: canonicalJsonDigest("superseded authority") } })
      .runner_evidence.runtime_contract.saved_execution_review).toBeNull();
    expect(policyCoverageDraft({ ...input, executionReview: { ...review, enabled_outcomes: [] } })
      .runner_evidence.runtime_contract.saved_execution_review?.enabled_outcomes).toEqual([]);
  });

  it.each(saved)("retains $case selector meaning and later duties through review, save and restart", async baseline => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-review-sequence-"));
    try {
      const input = { read: baseline.read, authority: baseline.authority, actions: [], decisions: [] } as unknown as Parameters<typeof policyCoverageDraft>[0];
      const original = structuredClone(input), draft = policyCoverageDraft(input);
      const source = policyTextSnapshot(Buffer.from(baseline.policy_excerpt), "quota-and-verification-excerpt.txt");
      const session = newPolicySourceSession(); session.snapshots = [source]; session.active = source.version;
      session.approvals = [{ digest: source.digest, destination: authoringDestination({ provider: "openai", model: "fixture" }) }];
      session.operator_messages = baseline.operator_messages;
      const outcome = draft.actions[0]!.outcome, automatic = draft.runner_evidence.actions[outcome]!.automatic_limits;
      expect(automatic.map(limit => limit.maximum).sort()).toEqual([2, 6]);
      const capability = baseline.case === "assisted" ? null : "league.ratify_result";
      expect(automatic.map(limit => limit.history_selector.capability)).toEqual([capability, capability]);
      const ownerMessage = baseline.case === "assisted" ? baseline.operator_messages.length : 1;
      const passages = [
        { start: 1, end: 1, disposition: "implemented", responsibility: "runner", issue_kind: "coverage_link",
          interpretation: "The exact saved quota pair retains its accepted history selection; adding a filter is not required by the applicable clarification.",
          operator_message_id: ownerMessage, draft_paths: [`/runner_evidence/actions/${outcome}/automatic_limits`],
          counter_requirements: automatic.map((limit, index) => ({ path: `/runner_evidence/actions/${outcome}/automatic_limits/${index}/history_selector/capability`,
            current_capability: limit.history_selector.capability, required_capability: capability })) },
        { start: 1, end: 1, disposition: "needs_decision", responsibility: "deployment", issue_kind: "missing_configuration",
          interpretation: "Dedicated deployment must be separately inspected and reviewed; a prepared effect is not a completed execution.",
          deployment_prerequisite: "runner_execution_setup", draft_paths: ["/runner_evidence/runtime_contract/deployment_prerequisites/runner_execution_setup"] },
        { start: 1, end: 1, disposition: "needs_decision", responsibility: "application", issue_kind: "missing_configuration",
          interpretation: "Independent source readback is required after each applicable execution and remains unverified here.",
          application_obligations: ["independent_source_readback"], draft_paths: [readbackPath] },
      ];
      const requests: string[] = [];
      const conversation = createModelAuthoringConversation(); conversation.policySources = session;
      const review = async (previousReport?: typeof session.coverage) => reviewPolicyCoverage({ source, draft,
        previousReport, env: { OPENAI_API_KEY: "test-key" }, session: { provider: "openai", model: "fixture", conversation,
          dependencies: { requestJson: async request => { requests.push(JSON.stringify(request.body));
            return { status: 200, body: { output: [{ type: "function_call", call_id: `review_${requests.length}`,
              name: "runner__review_policy_coverage", arguments: JSON.stringify({ passages }) }] } }; } } } });
      const coverage = await review();
      expect(coverage.passages[0]!.operator_clarification).toBe(baseline.operator_messages[ownerMessage - 1]);
      expect(coverage.passages.some(p => p.disposition === "overridden")).toBe(false);
      expect(policyReviewReadiness(source, coverage, session)).toMatchObject({ ready: true });
      expect(coverage.passages.slice(1).every(p => p.disposition === "needs_decision")).toBe(true);
      bindPolicyCoverage(session, coverage, baseline.authority.digest);
      await savePolicySources(root, session);
      conversation.policySources = await loadPolicySources(root, session.id);
      expect(activePolicySource(conversation.policySources)).toEqual(source);
      expect(conversation.policySources.coverage).toEqual(coverage);
      const checked = await review(conversation.policySources.coverage);
      expect(checked).toEqual(coverage);
      expect(requests).toHaveLength(2);
      expect(requests[1]).toContain("Previous supporting interpretations");
      expect(requests[1]).toContain("not an unfinished field");
      expect(requests[1]).toContain("required external observation after an execution");
      expect(policyCoverageDraft(input).actions).toEqual(draft.actions);
      expect(input).toEqual(original);

      // The retained prose is not treated as implemented code or as new policy.
      const pending = baseline.pending as BoundaryAuthoringActionRevision;
      const base = { binding, stage: "authority_review" as const, jobIntent: "Review the saved job without executing it.",
        provider: "openai" as const, model: "fixture", policySourceSession: session.id };
      const initial = buildBoundaryAuthoringResumeState({ ...base, pendingActionRevision: pending });
      await writeBoundaryAuthoringResumeState(root, initial, { expectedRevisionDigest: null });
      const reconciled = buildBoundaryAuthoringResumeState({ ...base, previous: initial, reconciledActionRevisions: [{
        pending, source_digest: source.digest, report_digest: canonicalJsonDigest(checked), draft_digest: checked.draft_digest,
        reason: "current_review_requires_no_action_edit", confirmed_by: "operator",
      }] });
      await writeBoundaryAuthoringResumeState(root, reconciled, { expectedRevisionDigest: initial.revision_digest });
      const reopened = await readBoundaryAuthoringResumeState(root, binding);
      expect(reopened).toEqual({ status: "ready", value: reconciled });
      expect(reconciled.pending_action_revision).toBeUndefined();
      expect(reconciled.reconciled_action_revisions?.[0]?.pending).toEqual(pending);
      const again = buildBoundaryAuthoringResumeState({ ...base, previous: reconciled });
      expect(again.reconciled_action_revisions).toEqual(reconciled.reconciled_action_revisions);
      expect(again.pending_action_revision).toBeUndefined();
      expect(await clearBoundaryAuthoringResumeState(root)).toBe(false);
      // A competing genuine owner edit survives both stale and invalid saves.
      const owner = { ...pending, instruction: "Change only the existing league allowance from two to one.", coverage_repair: undefined };
      const newer = buildBoundaryAuthoringResumeState({ ...base, previous: reconciled, pendingActionRevision: owner });
      await writeBoundaryAuthoringResumeState(root, newer, { expectedRevisionDigest: reconciled.revision_digest });
      await expect(writeBoundaryAuthoringResumeState(root, again, { expectedRevisionDigest: reconciled.revision_digest })).rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
      await expect(writeBoundaryAuthoringResumeState(root, { ...again, revision_digest: canonicalJsonDigest("invalid") })).rejects.toThrow();
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: newer });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["receipt_only", "wrong_phase", "claimed_verified", "mixed_privacy", "automated_requirement", "missing_contract"])("does not discharge readback using %s", mode => {
    const baseline = saved[0]!;
    const draft = policyCoverageDraft({ read: baseline.read, authority: baseline.authority, actions: [], decisions: [] } as unknown as Parameters<typeof policyCoverageDraft>[0]);
    const source = policyTextSnapshot(Buffer.from("Independently verify the changed source row."), "requirement.txt");
    const entry: PolicyPassage = { start: 1, end: 1, disposition: "needs_decision", responsibility: "application", issue_kind: "missing_configuration",
      interpretation: "Independent observation is still required.", draft_paths: [readbackPath], application_obligations: ["independent_source_readback"] };
    if (mode === "receipt_only") entry.draft_paths = ["/runner_evidence/runtime_contract/receipts"];
    if (mode === "wrong_phase") draft.runner_evidence.runtime_contract.application_obligations.independent_source_readback.phase = "before_execution";
    if (mode === "claimed_verified") draft.runner_evidence.runtime_contract.application_obligations.independent_source_readback.verified = true;
    if (mode === "mixed_privacy") entry.field_checks = [{ resource: "public.match_results", field: "integrity_hold", expectation: "private" }];
    if (mode === "automated_requirement") { entry.responsibility = "runner"; entry.disposition = "unsupported"; }
    if (mode === "missing_contract") delete (draft.runner_evidence.runtime_contract.application_obligations as Partial<typeof draft.runner_evidence.runtime_contract.application_obligations>).independent_source_readback;
    expect(() => parsePolicyCoverage({ passages: [entry] }, source, draft, [])).toThrow();
  });
});
