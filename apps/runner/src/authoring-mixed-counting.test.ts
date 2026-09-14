import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { createModelAuthoringConversation } from "./model-authoring-conversation.js";
import { parsePolicyCoverage, reviewPolicyCoverage } from "./authoring-policy-coverage.js";
import { bindPolicyCoverage, loadPolicySources, savePolicySources } from "./authoring-policy-source.js";
import { policyCountingInterpretations } from "./authoring-counting-review.js";
import { policyReviewReadiness } from "./authoring-review-readiness.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";

const saved = JSON.parse(readFileSync(new URL("./fixtures/mixed-counting-review.json", import.meta.url), "utf8"));
const parse = (reply = saved.replies[0], draft = saved.drafts[0], messages = saved.operator_messages) => parsePolicyCoverage(reply, saved.source, draft, messages);
const counter = (reply: any) => reply.passages.find((p: any) => p.counter_requirements?.length);
const comparisons = (report: ReturnType<typeof parse>) => report.passages.flatMap(p => p.counting_components?.flatMap(c => c.resolution.comparisons) ?? p.counting_resolution?.comparisons ?? []).sort((a,b) => a.path.localeCompare(b.path));

describe("exact installed mixed counting review", () => {
  it.each([0, 1])("replays complete captured request/reply %s through producer, save/reload, readiness and pending reconciliation", async index => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-mixed-review-"));
    try {
      const state = structuredClone(saved.policy_sources), source = saved.source, draft = saved.drafts[index];
      const before = canonicalJsonDigest(draft.actions), original = JSON.stringify(saved.replies[index]);
      const conversation = createModelAuthoringConversation(); conversation.policySources = state;
      let calls = 0;
      const report = await reviewPolicyCoverage({ source, draft, env: { OPENAI_API_KEY: "controlled-test-only" },
        session: { provider: "openai", model: "gpt-5.6-terra", conversation, dependencies: { requestJson: async () => {
          calls++; return { status: 200, body: { output: [{ type: "function_call", name: "runner__review_policy_coverage", call_id: "exact_capture", arguments: original }] } };
        } } } });
      expect(calls).toBe(1); expect(JSON.stringify(saved.replies[index])).toBe(original);
      const passage = counter(report), submitted = counter(saved.replies[index]);
      expect(passage.interpretation).toBe(submitted.interpretation);
      expect(passage.disposition).toBe(submitted.disposition);
      expect(passage.draft_paths).toEqual(submitted.draft_paths);
      expect(passage.operator_clarification).toBe(saved.operator_messages[submitted.operator_message_id - 1]);
      expect(passage.counting_components).toHaveLength(2);
      for (const component of passage.counting_components) {
        expect(component.origin).toBe("HOST-RESOLVED");
        expect(component.submitted_support).toMatchObject({ operator_message_id: submitted.operator_message_id, paragraph: passage.operator_clarification });
        expect(component.resolution.operator_support).toEqual(draft.runner_evidence.counting_interpretations[0].operator_support);
        expect(component.resolution.operator_support.answer).not.toBe(passage.operator_clarification);
      }
      bindPolicyCoverage(state, report, state.coverage_authority_digest);
      expect(policyReviewReadiness(source, report, state).ready).toBe(true);
      expect(report.passages.filter(p => p.disposition === "needs_decision").length).toBeGreaterThan(0);
      expect(report.passages.some(p => p.application_obligations?.includes("independent_source_readback"))).toBe(true);
      await savePolicySources(root, state, { expectedDigest: null });
      const reopened = await loadPolicySources(root, state.id);
      expect(parse({ passages: reopened.coverage!.passages }, draft)).toEqual(report);
      expect(policyCountingInterpretations(reopened, source, state.coverage_authority_digest, saved.clarifications)).toEqual(draft.runner_evidence.counting_interpretations);
      expect(canonicalJsonDigest(draft.actions)).toBe(before); expect(calls).toBe(1);
      const binding = { boundary_name: "reviewed_staging", generation_lock_fingerprint: canonicalJsonDigest("lock"), schema_fingerprint: canonicalJsonDigest("schema"), role_posture_fingerprint: canonicalJsonDigest("reader") };
      const base = { binding, stage: "authority_review" as const, jobIntent: "Continue exact saved business review.", provider: "openai" as const, model: "gpt-5.6-terra", policySourceSession: state.id };
      const initial = buildBoundaryAuthoringResumeState({ ...base, pendingActionRevision: saved.pending });
      await writeBoundaryAuthoringResumeState(root, initial, { expectedRevisionDigest: null });
      const reconciled = buildBoundaryAuthoringResumeState({ ...base, previous: initial, reconciledActionRevisions: [{ pending: saved.pending, source_digest: source.digest, report_digest: canonicalJsonDigest(report), draft_digest: report.draft_digest, reason: "current_review_requires_no_action_edit", confirmed_by: "operator" }] });
      await writeBoundaryAuthoringResumeState(root, reconciled, { expectedRevisionDigest: initial.revision_digest });
      expect((await readBoundaryAuthoringResumeState(root, binding)).status).toBe("ready");
      expect(reconciled.pending_action_revision).toBeUndefined(); expect(reconciled.reconciled_action_revisions?.[0]?.pending).toEqual(saved.pending);
      const newer = structuredClone(reopened); newer.operator_messages!.push("A newer owner change remains unresolved.");
      await savePolicySources(root, newer, { expectedDigest: canonicalJsonDigest(reopened) });
      await expect(savePolicySources(root, reopened, { expectedDigest: canonicalJsonDigest(reopened) })).rejects.toThrow("POLICY_SOURCE_CHANGED");
      expect(await loadPolicySources(root, state.id)).toEqual(newer);
      await expect(writeBoundaryAuthoringResumeState(root, initial, { expectedRevisionDigest: initial.revision_digest })).rejects.toMatchObject({ code: "BOUNDARY_AUTHORING_RESUME_CHANGED" });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("preserves conclusions when the same explicit components are separated or reordered", () => {
    const baseline = comparisons(parse());
    const reversed = structuredClone(saved.replies[0]); counter(reversed).counter_requirements.reverse(); reversed.passages.reverse();
    expect(comparisons(parse(reversed))).toEqual(baseline);
    const separated = structuredClone(saved.replies[0]), mixed = counter(separated);
    separated.passages = separated.passages.filter((p: any) => p !== mixed);
    for (const check of mixed.counter_requirements) separated.passages.push({ ...mixed, counter_requirements: [check], draft_paths: [check.path] });
    expect(comparisons(parse(separated))).toEqual(baseline);
  });

  it("keeps different support bound to each counter without interpreting the paragraph as either decision", () => {
    const draft = structuredClone(saved.drafts[0]), messages = [...saved.operator_messages, "Keep the second counter's saved selector, as explicitly reviewed."], reply = structuredClone(saved.replies[0]);
    const prior = draft.runner_evidence.counting_interpretations[0];
    draft.runner_evidence.counting_interpretations = prior.comparisons.map((check: any, i: number) => ({ ...structuredClone(prior), comparisons: [check], operator_support: i ? { question: "Preserve the second counter?", answer: messages.at(-1) } : prior.operator_support, operator_history_digest: canonicalJsonDigest(messages) }));
    const report = parse(reply, draft, messages); const parts = counter(report).counting_components;
    expect(parts.map((p: any) => p.resolution.operator_support.answer)).toEqual([prior.operator_support.answer, messages.at(-1)]);
    counter(reply).counter_requirements[1].operator_message_id = messages.indexOf(prior.operator_support.answer) + 1;
    expect(() => parse(reply, draft, messages)).toThrow("COUNTING_SUPPORT_MISMATCH");
  });

  it.each(["missing", "ambiguous", "wrong_explicit", "stale_decision", "broad_only", "bad_pointer", "wrong_value", "incomplete", "other_history", "other_current", "other_proposed", "bad_store"])("refuses %s precisely", mode => {
    const reply = structuredClone(saved.replies[0]), draft = structuredClone(saved.drafts[0]), p = counter(reply), domain = draft.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain;
    let code = "COUNTING_";
    if (mode === "missing") draft.runner_evidence.counting_interpretations = [];
    if (mode === "ambiguous") draft.runner_evidence.counting_interpretations.push(structuredClone(draft.runner_evidence.counting_interpretations[0]));
    if (mode === "wrong_explicit") p.counter_requirements[0].operator_message_id = p.operator_message_id;
    if (mode === "stale_decision") draft.runner_evidence.counting_interpretations[0].operator_history_digest = canonicalJsonDigest("changed");
    if (mode === "broad_only") { p.draft_paths = ["/actions/0/approval", "/runner_evidence"]; code = "COUNTING_REFERENCE_OVERBROAD"; }
    if (mode === "bad_pointer") { p.counter_requirements[0].path = "/actions/0/approval"; code = "Counter requirements must name an exact"; }
    if (mode === "wrong_value") { p.counter_requirements[0].current_capability = "wrong"; code = "Counter evidence changed"; }
    if (mode === "incomplete") domain.complete = false;
    if (mode === "other_history") domain.retained_automatic_outcomes.push("another.outcome");
    if (mode === "other_current") domain.current_outcomes.push("another.outcome");
    if (mode === "other_proposed") domain.proposed_outcomes.push("another.outcome");
    if (mode === "bad_store") domain.store_binding_digest = "missing";
    expect(() => parse(reply, draft)).toThrow(code);
  });

  it.each(["maximum", "condition", "unrelated"])("counting proof cannot discharge a %s failure", mode => {
    const reply = structuredClone(saved.replies[0]), p = counter(reply);
    if (mode === "unrelated") reply.passages.push({ start: p.start, end: p.end, interpretation: "A separate source obligation remains unresolved.", disposition: "needs_decision", responsibility: "operator", issue_kind: "business_choice", draft_paths: ["/actions/0/approval"] });
    else { p.disposition = "conflict"; p.issue_kind = "contradiction"; p.interpretation = `The ${mode} does not satisfy a separate requirement.`; }
    const report = parse(reply); expect(counter(report).counting_components).toHaveLength(2);
    expect(policyReviewReadiness(saved.source, report, saved.policy_sources).ready).toBe(false);
    if (mode !== "unrelated") expect(counter(report)).toMatchObject({ disposition: "conflict", interpretation: p.interpretation });
  });

  it("retains scalar maximum and privacy validation within a mixed passage", () => {
    const reply = structuredClone(saved.replies[0]), p = counter(reply), root = p.counter_requirements[0].path.replace(/\/history_selector\/capability$/, "");
    p.evidence_checks = [{ path: root + "/maximum", equals: 999 }];
    expect(() => parse(reply)).toThrow("Mechanical evidence mismatch");
    delete p.evidence_checks;
    const privatePassage = reply.passages.find((q: any) => q.field_checks?.some((c: any) => c.expectation === "private"));
    expect(privatePassage).toBeDefined();
    p.field_checks = structuredClone(privatePassage.field_checks);
    expect(counter(parse(reply)).counting_components).toHaveLength(2);
  });

  it.each(["history", "authority", "store", "decision", "source"])("rejects a saved component after relevant %s change", mode => {
    const report = parse(), draft = structuredClone(saved.drafts[0]), source = structuredClone(saved.source);
    const domain = draft.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain;
    if (mode === "history") domain.retained_automatic_outcomes.push("other");
    if (mode === "authority") domain.current_revision = canonicalJsonDigest("other revision");
    if (mode === "store") domain.store_binding_digest = canonicalJsonDigest("other store");
    if (mode === "decision") draft.runner_evidence.counting_interpretations = [];
    if (mode === "source") source.digest = canonicalJsonDigest("changed source");
    expect(() => parsePolicyCoverage({ passages: report.passages }, source, draft, saved.operator_messages)).toThrow();
  });

  it("cannot lose a domain-dependent obligation when a new response omits typed comparisons", () => {
    const reply = structuredClone(saved.replies[0]), draft = structuredClone(saved.drafts[0]);
    delete counter(reply).counter_requirements;
    const state = structuredClone(saved.policy_sources), first = parse(reply, draft);
    bindPolicyCoverage(state, first, state.coverage_authority_digest);
    expect(policyReviewReadiness(saved.source, first, state).ready).toBe(true);
    draft.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain.retained_automatic_outcomes.push("another.outcome");
    const report = parse(reply, draft);
    expect(policyReviewReadiness(saved.source, report, saved.policy_sources).ready).toBe(false);
    expect(report.passages.some(p => p.disposition === "conflict" && p.counter_requirements?.length)).toBe(true);
  });
});
