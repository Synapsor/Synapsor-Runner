import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBoundaryAuthoringResumeState,
  boundaryAuthoringVersionReviews,
  prepareBoundaryActionRevision,
  clearBoundaryAuthoringResumeState,
  readBoundaryAuthoringResumeState,
  revalidateBoundaryAuthoringResume,
  writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeBinding,
} from "./boundary-authoring-resume.js";
import { actionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";

const binding: BoundaryAuthoringResumeBinding = {
  boundary_name: "reviewed_staging",
  generation_lock_fingerprint: `sha256:${"1".repeat(64)}`,
  schema_fingerprint: `sha256:${"2".repeat(64)}`,
  role_posture_fingerprint: `sha256:${"3".repeat(64)}`,
};

describe("Boundary authoring resume state", () => {
  it("retains scoped business decisions through rewrite, restart and rescan without upgrading history or consent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-scoped-decision-resume-"));
    try {
      const conversation = [{ kind: "clarification" as const, question: "Earlier ambiguous question?", answer: "Earlier unscoped business answer." }];
      const input = { binding, stage: "authority_review" as const, jobIntent: "Inspect equipment and close a visit; a separate automatic limit is unanswered.",
        provider: "openai" as const, model: "gpt-test", conversation };
      const records = [{ decision_id: canonicalJsonDigest("host exact scope"), applicability_digest: canonicalJsonDigest("host relevant meaning and fields"),
        question: "For this workflow, is the reviewed register authoritative?", answer: "The operator confirms its business ownership." }];
      const action = { intent: "Schedule follow-up; automatic limit remains unanswered.", intents: ["Close a visit.", "Schedule follow-up; automatic limit remains unanswered."],
        completed_outcomes: ["operations.close_visit"], checkpoint: actionRuleAuthoringCheckpoint({ intent_digest: canonicalJsonDigest("unfinished intent"),
          context_digest: canonicalJsonDigest("old proof"), components: {}, operator_messages: ["Business limit remains unanswered."] }) };
      const original = buildBoundaryAuthoringResumeState({ ...input, readPrerequisiteDecisions: records, action,
        privateReadMetadataDigest: canonicalJsonDigest("old consent") });
      let state = original;
      for (const stage of ["planning", "read_mapping", "action_drafting", "authority_review"] as const) {
        state = buildBoundaryAuthoringResumeState({ ...input, stage, previous: state });
        expect(state.read_prerequisite_decisions).toEqual(records);
        expect(state.action).toEqual(action);
        expect(state.conversation).toEqual(conversation);
        await writeBoundaryAuthoringResumeState(root, state);
        expect(await clearBoundaryAuthoringResumeState(root)).toBe(false);
        expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      }
      const revalidated = revalidateBoundaryAuthoringResume(original, { ...binding, role_posture_fingerprint: canonicalJsonDigest("fresh writer role") });
      expect(revalidated.read_prerequisite_decisions).toEqual(records);
      expect(revalidated.private_read_metadata_digest).toBeUndefined();
      expect(revalidated.authority_granted).toBe(false);
      expect(revalidated.action).toEqual(action);
      expect(buildBoundaryAuthoringResumeState(input).read_prerequisite_decisions).toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("distinguishes omission, explicit replacement, explicit clear and another Boundary for scoped records", () => {
    const input = { binding, stage: "authority_review" as const, jobIntent: "Review the complete saved job.", provider: "openai" as const, model: "gpt-test" };
    const record = { decision_id: canonicalJsonDigest("decision"), applicability_digest: canonicalJsonDigest("applicability"), question: "Reviewed meaning?", answer: "Original answer." };
    const previous = buildBoundaryAuthoringResumeState({ ...input, readPrerequisiteDecisions: [record] });
    const replaced = { ...record, applicability_digest: canonicalJsonDigest("explicit revised meaning"), answer: "Explicit new answer." };
    expect(buildBoundaryAuthoringResumeState({ ...input, previous, readPrerequisiteDecisions: [replaced] }).read_prerequisite_decisions).toEqual([replaced]);
    expect(buildBoundaryAuthoringResumeState({ ...input, previous, readPrerequisiteDecisions: [] }).read_prerequisite_decisions).toBeUndefined();
    expect(buildBoundaryAuthoringResumeState({ ...input, previous, binding: { ...binding, boundary_name: "other" } }).read_prerequisite_decisions).toBeUndefined();
    const edited = buildBoundaryAuthoringResumeState({ ...input, previous, jobIntent: "Explicitly edited job; retained answers are context until applicability is checked." });
    expect(edited.read_prerequisite_decisions).toEqual([record]);
    expect(previous.read_prerequisite_decisions).toEqual([record]);
    expect(() => buildBoundaryAuthoringResumeState({ ...input, readPrerequisiteDecisions: [record, replaced] })).toThrow("duplicate decision");
    expect(() => revalidateBoundaryAuthoringResume({ ...previous, read_prerequisite_decisions: [replaced] }, binding)).toThrow("digest");
  });

  it("retains two host counter confirmations after a no-op edit, restart and metadata rescan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-counter-review-resume-"));
    try {
      const input = { binding, stage: "authority_review" as const, jobIntent: "Exchange the assignment and consume the selected offer atomically.",
        provider: "openai" as const, model: "gpt-test" };
      const reviews = ["operations.assignments", "operations.offers"].map((resource, i) => ({ resource, field: "counter",
        maintenance: "all_writers_increment" as const, proof_digest: `sha256:${String(i + 4).repeat(64)}` as const }));
      const checkpoint = actionRuleAuthoringCheckpoint({ intent_digest: `sha256:${"6".repeat(64)}`,
        context_digest: `sha256:${"7".repeat(64)}`, components: {}, reviewed_version_fields: reviews });
      const old = buildBoundaryAuthoringResumeState({ ...input, pendingActionRevision: { outcome: "operations.exchange",
        instruction: "Confirm the existing operating prerequisites.", baseline_digest: `sha256:${"8".repeat(64)}`, checkpoint } });
      expect(boundaryAuthoringVersionReviews(old)).toEqual(reviews);
      const completed = buildBoundaryAuthoringResumeState({ ...input, previous: old });
      expect(completed.pending_action_revision).toBeUndefined();
      expect(completed.reviewed_version_fields).toEqual(reviews);
      await writeBoundaryAuthoringResumeState(root, completed);
      const loaded = await readBoundaryAuthoringResumeState(root, binding);
      expect(loaded).toEqual({ status: "ready", value: completed });
      const refreshed = revalidateBoundaryAuthoringResume(old, { ...binding, schema_fingerprint: `sha256:${"9".repeat(64)}` });
      expect(refreshed.pending_action_revision?.checkpoint).toBeUndefined();
      expect(boundaryAuthoringVersionReviews(refreshed)).toEqual(reviews);
      expect(refreshed.authority_granted).toBe(false);
      expect(refreshed.source_database_changed).toBe(false);
      expect(() => boundaryAuthoringVersionReviews({ ...completed,
        reviewed_version_fields: [{ ...reviews[0]!, field: "other_counter" }] })).toThrow("digest");
      expect(buildBoundaryAuthoringResumeState({ ...input, jobIntent: "A different job.", previous: completed })
        .reviewed_version_fields).toBeUndefined();
      expect(buildBoundaryAuthoringResumeState({ ...input, binding: { ...binding, boundary_name: "other" }, previous: completed })
        .reviewed_version_fields).toBeUndefined();
      expect(buildBoundaryAuthoringResumeState({ ...input, reviewedVersionFields: [], previous: completed })
        .reviewed_version_fields).toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("keeps the latest host confirmation instead of an older component checkpoint", () => {
    const older = { resource: "operations.records", field: "v1", maintenance: "all_writers_increment" as const,
      proof_digest: `sha256:${"a".repeat(64)}` as const };
    const latest = { ...older, field: "v2", proof_digest: `sha256:${"b".repeat(64)}` as const };
    const input = { binding, stage: "authority_review" as const, jobIntent: "Change a record.", provider: "openai" as const, model: "gpt-test" };
    const state = buildBoundaryAuthoringResumeState({ ...input, reviewedVersionFields: [latest], action: { intent: input.jobIntent,
      checkpoint: actionRuleAuthoringCheckpoint({ intent_digest: `sha256:${"c".repeat(64)}`, context_digest: `sha256:${"d".repeat(64)}`,
        components: {}, reviewed_version_fields: [older] }) } });
    expect(boundaryAuthoringVersionReviews(state)).toEqual([latest]);
    const records = Array.from({ length: 32 }, (_, i) => ({ ...latest, resource: `operations.record_${i}` }));
    expect(buildBoundaryAuthoringResumeState({ ...input, reviewedVersionFields: records }).reviewed_version_fields).toEqual(records);
    expect(() => buildBoundaryAuthoringResumeState({ ...input, reviewedVersionFields: [...records, older] })).toThrow("CHECKPOINT_INVALID");
    expect(() => buildBoundaryAuthoringResumeState({ ...input, reviewedVersionFields: [older, latest] })).toThrow("CHECKPOINT_INVALID");
  });
  it.each([true, false])("preserves an omitted unfinished agenda on rewrite, clear and rescan (components %s)", async (components) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-partial-job-resume-"));
    try {
      const input = { binding, stage: "authority_review" as const, jobIntent: "Inspect assets, close a visit, and schedule follow-up when its limits are provided.",
        provider: "openai" as const, model: "gpt-test" };
      const action = { intent: "Inspect an asset.", intents: ["Inspect an asset.", "Close a visit.", "Schedule a follow-up; automatic limits remain unanswered."],
        outcome: "operations.close_visit", completed_outcomes: ["operations.inspect_asset", "operations.close_visit"], strategy: "rule_derived" as const,
        ...(components ? { checkpoint: actionRuleAuthoringCheckpoint({ intent_digest: `sha256:${"4".repeat(64)}`,
          context_digest: `sha256:${"5".repeat(64)}`, components: { verification: { name: "private_facts", resources: [] } },
          operator_messages: ["The business owner has not supplied the automatic limit. Keep it pending."] }) } : {}),
      };
      let state = buildBoundaryAuthoringResumeState({ ...input, action });
      for (const stage of ["planning", "read_mapping", "action_drafting", "authority_review"] as const) {
        state = buildBoundaryAuthoringResumeState({ ...input, stage, previous: state });
        expect(state.action).toEqual(action);
        await writeBoundaryAuthoringResumeState(root, state);
        expect(await clearBoundaryAuthoringResumeState(root)).toBe(false);
        expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      }
      expect(revalidateBoundaryAuthoringResume(state, { ...binding, schema_fingerprint: `sha256:${"6".repeat(64)}` }).action).toEqual(action);
      const complete = buildBoundaryAuthoringResumeState({ ...input, previous: state,
        action: { ...action, checkpoint: undefined, completed_outcomes: [...action.completed_outcomes, "operations.followup"] } });
      await writeBoundaryAuthoringResumeState(root, complete);
      expect(await clearBoundaryAuthoringResumeState(root)).toBe(true);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("retains an unclassified edit separately from the job through resume and rescan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-job-edit-resume-"));
    try {
      const input = { binding, stage: "planning" as const, jobIntent: "Review visits and complete approved follow-ups.",
        provider: "openai" as const, model: "gpt-test", intendedClient: "claude-code" as const };
      const pendingJobRevision = "Keep internal identifiers private and reduce automatic approval to one per day.";
      const state = buildBoundaryAuthoringResumeState({ ...input, pendingJobRevision });
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      const refreshed = revalidateBoundaryAuthoringResume(state, { ...binding, schema_fingerprint: `sha256:${"f".repeat(64)}` });
      expect(refreshed).toMatchObject({ job_intent: input.jobIntent, pending_job_revision: pendingJobRevision, intended_client: "claude-code" });
      expect(() => revalidateBoundaryAuthoringResume({ ...state, pending_job_revision: "A different edit" }, binding)).toThrow("digest");
      expect(buildBoundaryAuthoringResumeState({ ...input, previous: state }).pending_job_revision).toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("retains only a bound custom destination fingerprint and drops it on revalidation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-custom-destination-resume-"));
    try {
      const input = { binding, stage: "planning" as const, jobIntent: "Review records.", provider: "openai_compatible" as const, model: "local" };
      const metadataDestinationDigest = `sha256:${"d".repeat(64)}` as const;
      const state = buildBoundaryAuthoringResumeState({ ...input, metadataDestinationDigest });
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      expect(() => revalidateBoundaryAuthoringResume({ ...state, metadata_destination_digest: `sha256:${"e".repeat(64)}` }, binding)).toThrow("digest");
      expect(revalidateBoundaryAuthoringResume(state, { ...binding, schema_fingerprint: `sha256:${"f".repeat(64)}` }).metadata_destination_digest).toBeUndefined();
      expect(buildBoundaryAuthoringResumeState({ ...input, previous: state }).metadata_destination_digest).toBeUndefined();
      expect(JSON.stringify(state)).not.toContain("http");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("binds private Read metadata permission to the saved mapping and discards it on rescan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-private-read-consent-resume-"));
    try {
      const input = { binding, stage: "authority_review" as const, jobIntent: "Require current admission.", provider: "openai" as const, model: "gpt-test" };
      const privateReadMetadataDigest = `sha256:${"a".repeat(64)}` as const;
      const state = buildBoundaryAuthoringResumeState({ ...input, privateReadMetadataDigest });
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      expect(state.private_read_metadata_digest).toBe(privateReadMetadataDigest);
      expect(() => revalidateBoundaryAuthoringResume({ ...state, private_read_metadata_digest: `sha256:${"b".repeat(64)}` }, binding)).toThrow("digest");
      expect(revalidateBoundaryAuthoringResume(state, { ...binding, schema_fingerprint: `sha256:${"c".repeat(64)}` })
        .private_read_metadata_digest).toBeUndefined();
      expect(() => buildBoundaryAuthoringResumeState({ ...input, privateReadMetadataDigest: "unbound" as never })).toThrow("private Read metadata permission");
      expect(buildBoundaryAuthoringResumeState({ ...input, previous: state }).private_read_metadata_digest).toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("saves an in-progress policy edit separately from initial action drafting and drops stale components on rescan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-action-revision-resume-"));
    try {
      const pendingActionRevision = { outcome: "university.accept_offer", instruction: "Require current admission without changing the other rules.",
        baseline_digest: `sha256:${"4".repeat(64)}` as const,
        checkpoint: actionRuleAuthoringCheckpoint({ intent_digest: `sha256:${"5".repeat(64)}`,
          context_digest: `sha256:${"6".repeat(64)}`, components: {}, operator_messages: ["Save pending"] }),
      };
      const input = { binding, stage: "authority_review" as const, jobIntent: "Help students with registration.", provider: "openai" as const, model: "gpt-5.6-terra" };
      const state = buildBoundaryAuthoringResumeState({ ...input, pendingActionRevision, intendedClient: "claude-code" });
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      expect(state.pending_action_revision).toEqual(pendingActionRevision);
      expect(prepareBoundaryActionRevision(pendingActionRevision, pendingActionRevision)).toEqual(pendingActionRevision);
      const newInstruction = "Map the reviewed admission source; preserve existing limits.";
      expect(prepareBoundaryActionRevision({ ...pendingActionRevision, instruction: newInstruction }, pendingActionRevision))
        .toEqual({ outcome: pendingActionRevision.outcome, baseline_digest: pendingActionRevision.baseline_digest, instruction: newInstruction });
      expect(() => prepareBoundaryActionRevision({ ...pendingActionRevision, outcome: "university.other" }, pendingActionRevision))
        .toThrow("ACTION_REVISION_BASELINE_CHANGED");
      expect(() => prepareBoundaryActionRevision({ ...pendingActionRevision, baseline_digest: `sha256:${"f".repeat(64)}` }, pendingActionRevision))
        .toThrow("ACTION_REVISION_BASELINE_CHANGED");
      expect(state.action?.checkpoint).toBeUndefined();
      expect(state.authority_granted).toBe(false);
      const refreshed = revalidateBoundaryAuthoringResume(state, { ...binding, schema_fingerprint: `sha256:${"7".repeat(64)}` });
      expect(refreshed.pending_action_revision).toEqual({ ...pendingActionRevision, checkpoint: undefined });
      expect(refreshed.intended_client).toBe("claude-code");
      expect(() => revalidateBoundaryAuthoringResume({ ...state, pending_action_revision: { ...pendingActionRevision,
        outcome: "university.other" } }, binding)).toThrow("digest");
      expect(() => buildBoundaryAuthoringResumeState({ ...input, pendingActionRevision: {
        ...pendingActionRevision, baseline_digest: "unbound" as never,
      } })).toThrow();
      expect(buildBoundaryAuthoringResumeState({ ...input, previous: state }).pending_action_revision).toBeUndefined();
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("binds pending removal to the exact replacement instead of just a missing outcome name", () => {
    const input = { binding, stage: "authority_review" as const, jobIntent: "Stop offering the obsolete action.", provider: "openai" as const, model: "gpt-test" };
    const pendingActionRemoval = { outcome: "clinic.obsolete", authority_name: "clinic_rules", draft_digest: `sha256:${"4".repeat(64)}` as const };
    const state = buildBoundaryAuthoringResumeState({ ...input, pendingActionRemoval });
    expect(state.pending_action_removal).toEqual(pendingActionRemoval);
    expect(() => revalidateBoundaryAuthoringResume({ ...state, pending_action_removal: { ...pendingActionRemoval,
      draft_digest: `sha256:${"5".repeat(64)}` } }, binding)).toThrow("digest");
    expect(() => buildBoundaryAuthoringResumeState({ ...input, pendingActionRemoval: "clinic.obsolete" as never })).toThrow("removal review");
  });
  it("preserves exact operator provenance through revision save and invalidates a changed statement checkpoint", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-repair-provenance-"));
    try {
      const revision = { outcome: "gym.freeze", instruction: "Generated repair diagnostic.",
        operator_statements: ["Original policy:\n\nKeep the cap per organization.\n", "Keep the existing reviewer."],
        baseline_digest: `sha256:${"4".repeat(64)}` as const,
        checkpoint: actionRuleAuthoringCheckpoint({ intent_digest: `sha256:${"5".repeat(64)}`,
          context_digest: `sha256:${"6".repeat(64)}`, components: {}, operator_messages: [] }),
      };
      const input = { binding, stage: "authority_review" as const, jobIntent: "Apply the original policy.", provider: "openai" as const, model: "gpt-test" };
      const state = buildBoundaryAuthoringResumeState({ ...input, pendingActionRevision: revision });
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      expect(state.pending_action_revision?.operator_statements).toEqual(revision.operator_statements);
      const changed = prepareBoundaryActionRevision({ ...revision, operator_statements: ["A different accepted policy."] }, revision);
      expect(changed.checkpoint).toBeUndefined();
      expect(() => revalidateBoundaryAuthoringResume({ ...state, pending_action_revision: changed }, binding)).toThrow("digest");
      for (const statement of ["tenant_id = acme-corp", "Use postgres://operator:secret@db.example/app"]) {
        expect(() => buildBoundaryAuthoringResumeState({ ...input, pendingActionRevision: { ...revision, operator_statements: [statement] } })).toThrow(/BLOCKED/u);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("retains a cited missing Action request and its exact existing identities through rescan", () => {
    const input = { binding, stage: "planning" as const, jobIntent: "Help admitted students manage enrollment.",
      provider: "openai" as const, model: "gpt-test" };
    const pendingActionAddition = {
      policy_source_digest: `sha256:${"a".repeat(64)}` as const,
      source_ranges: [{ start: 12, end: 14 }, { start: 28, end: 28 }],
      retained_action: {
        intent: "Update an eligible enrollment.",
        intents: ["Update an eligible enrollment.", "Record an approved withdrawal."],
        completed_outcomes: ["university.update_enrollment", "university.record_withdrawal"],
        outcome: "university.record_withdrawal",
        strategy: "rule_derived" as const,
      },
    };
    const state = buildBoundaryAuthoringResumeState({ ...input, pendingActionAddition });
    expect(state.pending_action_addition).toEqual(pendingActionAddition);
    const refreshed = revalidateBoundaryAuthoringResume(state, {
      ...binding,
      schema_fingerprint: `sha256:${"b".repeat(64)}`,
    });
    expect(refreshed.pending_action_addition).toEqual(pendingActionAddition);
    expect(() => revalidateBoundaryAuthoringResume({
      ...state,
      pending_action_addition: { ...pendingActionAddition, source_ranges: [{ start: 12, end: 15 }] },
    }, binding)).toThrow("digest");
    expect(() => buildBoundaryAuthoringResumeState({ ...input, pendingActionAddition: {
      ...pendingActionAddition,
      source_ranges: [{ start: 12, end: 14 }, { start: 12, end: 14 }],
    } })).toThrow("source ranges must be unique");
  });
  it("validates client preferences and includes them in the integrity digest", () => {
    const input = { binding, stage: "planning" as const, jobIntent: "Review customer records.", provider: "openai" as const, model: "gpt-test" };
    const state = buildBoundaryAuthoringResumeState({ ...input, intendedClient: "claude-code" });
    expect(() => revalidateBoundaryAuthoringResume({ ...state, intended_client: "cursor" }, binding)).toThrow("digest");
    expect(() => buildBoundaryAuthoringResumeState({ ...input, intendedClient: "unreviewed-launcher" as never })).toThrow("client preference");
    expect(buildBoundaryAuthoringResumeState({ ...input, previous: state }).intended_client).toBeUndefined();
  });
  it("retains untrusted unfinished components and exact completed outcomes without carrying stale analysis or consent", () => {
    const state = buildBoundaryAuthoringResumeState({ binding, stage: "client_setup",
      jobIntent: "Review visits and propose rescheduling.", provider: "openai", model: "gpt-5.6-terra",
      intendedClient: "claude-code",
      policySourceSession: "d2c11000-aaa1-4bbb-8ccc-111111111111",
      conversation: [{ question: "Who reviews exceptions?", answer: "The clinic manager." }],
      read: { analysis_id: "read_one", analysis_digest: `sha256:${"4".repeat(64)}` },
      action: {
        intent: "Reschedule visits.", outcome: "clinic.reschedule", strategy: "rule_derived",
        intents: ["Reschedule visits.", "Notify the clinic."],
        completed_outcomes: ["clinic.reschedule"],
        checkpoint: actionRuleAuthoringCheckpoint({
          intent_digest: `sha256:${"7".repeat(64)}`,
          context_digest: `sha256:${"8".repeat(64)}`,
          components: { verification: { name: "clinic.verify_notification", resources: [] } },
          operator_messages: ["Notification approval limits are still undecided."],
        }),
      },
      clientHandoff: { read_digest: `sha256:${"5".repeat(64)}` },
    });
    const current = { ...binding, schema_fingerprint: `sha256:${"6".repeat(64)}` as const };
    const next = revalidateBoundaryAuthoringResume(state, current);
    expect(next).toMatchObject({ stage: "planning", binding: current, job_intent: state.job_intent,
      conversation: state.conversation, policy_source_session: state.policy_source_session, authority_granted: false });
    expect(next.read).toBeUndefined();
    expect(next.action).toEqual({
      intent: "Reschedule visits.", outcome: "clinic.reschedule", strategy: "rule_derived",
      intents: ["Reschedule visits.", "Notify the clinic."],
      completed_outcomes: ["clinic.reschedule"],
      checkpoint: state.action!.checkpoint,
    });
    expect(next.action?.checkpoint?.context_digest).toBe(`sha256:${"8".repeat(64)}`);
    expect(next.client_handoff).toBeUndefined();
    expect(next.intended_client).toBe("claude-code");
    expect(state.stage).toBe("client_setup");
    expect(() => revalidateBoundaryAuthoringResume(state, { ...current, boundary_name: "other" })).toThrow("different Read Boundary");
    expect(() => revalidateBoundaryAuthoringResume({ ...state, job_intent: "tampered" }, current)).toThrow("digest");
  });
  it("persists bounded symbolic context without credentials or trusted identities", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-resume-"));
    try {
      const state = buildBoundaryAuthoringResumeState({
        binding,
        stage: "action_drafting",
        intendedClient: "claude-code",
        jobIntent: "Let customers review tickets and propose one bounded refund.",
        provider: "openai",
        model: "gpt-5.6-terra",
        conversation: [{
          question: "What is the largest refund the agent may propose?",
          answer: "Twenty-five dollars.",
          kind: "clarification",
        }],
        policySourceSession: "d2c11000-aaa1-4bbb-8ccc-111111111111",
        readIntent: "Let the authenticated customer inspect only their own tickets and charges.",
        read: {
          analysis_id: "read_analysis_1",
          analysis_digest: `sha256:${"4".repeat(64)}`,
        },
        action: {
          intent: "Propose one bounded refund.",
          outcome: "refund.request_submitted",
          strategy: "rule_derived",
        },
        now: "2026-09-03T12:00:00.000Z",
      });
      const saved = await writeBoundaryAuthoringResumeState(root, state);
      expect(saved).toBe("./.synapsor/boundary-authoring/resume.json");
      await expect(readBoundaryAuthoringResumeState(root, binding)).resolves.toEqual({
        status: "ready",
        value: state,
      });
      const raw = await fs.readFile(path.join(root, ".synapsor/boundary-authoring/resume.json"), "utf8");
      expect(raw).not.toContain("OPENAI_API_KEY");
      expect(raw).not.toContain("tenant_id");
      expect(raw).not.toContain("principal_id");
      expect(raw).not.toContain("DATABASE_URL");
      expect(state.policy_source_session).toBe("d2c11000-aaa1-4bbb-8ccc-111111111111");
      expect(state.read_intent).toBe(
        "Let the authenticated customer inspect only their own tickets and charges.",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("round-trips clarification history and rejects unsupported saved turn kinds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-resume-kind-"));
    try {
      const state = buildBoundaryAuthoringResumeState({
        binding,
        stage: "planning",
        jobIntent: "Review visits without activating authority.",
        provider: "openai",
        model: "gpt-test",
        conversation: [{
          question: "Should customers see the visit status?",
          answer: "Visit status is customer-facing business information.",
          kind: "clarification",
        }],
      });
      await writeBoundaryAuthoringResumeState(root, state);
      await expect(readBoundaryAuthoringResumeState(root, binding)).resolves.toEqual({ status: "ready", value: state });
      const filePath = path.join(root, ".synapsor/boundary-authoring/resume.json");
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as { conversation: Array<Record<string, unknown>> };
      parsed.conversation[0]!.kind = "unsupported";
      await fs.writeFile(filePath, `${JSON.stringify(parsed)}\n`, "utf8");
      await expect(readBoundaryAuthoringResumeState(root, binding)).resolves.toEqual({
        status: "invalid",
        reason: "The saved authoring state failed its schema or integrity check.",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("persists a detailed job and Action intent beyond the old 500-character ceiling", () => {
    const jobIntent = "j".repeat(2_000);
    const actionIntent = "a".repeat(2_000);
    const state = buildBoundaryAuthoringResumeState({
      binding,
      stage: "action_drafting",
      jobIntent,
      provider: "openai",
      model: "gpt-test",
      action: { intent: actionIntent, strategy: "rule_derived" },
    });
    expect(state.job_intent).toBe(jobIntent);
    expect(state.action?.intent).toBe(actionIntent);
    expect(() => buildBoundaryAuthoringResumeState({
      binding,
      stage: "planning",
      jobIntent: "j".repeat(2_001),
      provider: "openai",
      model: "gpt-test",
    })).toThrow("job intent must be 1 through 2000 safe characters");
  });

  it("retains a concise Read intent for resuming a long job before analysis exists", () => {
    const readIntent = "Let the authenticated customer inspect only their own account, charges, refunds, and tickets.";
    const state = buildBoundaryAuthoringResumeState({
      binding,
      stage: "read_mapping",
      jobIntent: "j".repeat(637),
      readIntent,
      provider: "openai",
      model: "gpt-test",
    });
    expect(state.job_intent).toHaveLength(637);
    expect(state.read_intent).toBe(readIntent);
    expect(() => buildBoundaryAuthoringResumeState({
      binding,
      stage: "read_mapping",
      jobIntent: "Review customer support records.",
      readIntent: "r".repeat(501),
      provider: "openai",
      model: "gpt-test",
    })).toThrow("Read intent must be 1 through 500 safe characters");
  });

  it("refuses a digest-tampered resume record", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-resume-tamper-"));
    try {
      const state = buildBoundaryAuthoringResumeState({
        binding,
        stage: "planning",
        jobIntent: "Review support tickets.",
        provider: "anthropic",
        model: "claude-test",
      });
      await writeBoundaryAuthoringResumeState(root, state);
      const filePath = path.join(root, ".synapsor/boundary-authoring/resume.json");
      const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
      parsed.job_intent = "Review every tenant.";
      await fs.writeFile(filePath, `${JSON.stringify(parsed)}\n`, "utf8");
      await expect(readBoundaryAuthoringResumeState(root, binding)).resolves.toEqual({
        status: "invalid",
        reason: "The saved authoring state changed after Runner wrote its integrity digest.",
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("marks schema or role drift stale and can clear the record", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-resume-stale-"));
    try {
      const state = buildBoundaryAuthoringResumeState({
        binding,
        stage: "read_mapping",
        jobIntent: "Review support tickets.",
        provider: "openai_compatible",
        model: "qwen-test",
      });
      await writeBoundaryAuthoringResumeState(root, state);
      const changed: BoundaryAuthoringResumeBinding = {
        ...binding,
        schema_fingerprint: `sha256:${"9".repeat(64)}`,
        role_posture_fingerprint: `sha256:${"8".repeat(64)}`,
      };
      const loaded = await readBoundaryAuthoringResumeState(root, changed);
      expect(loaded).toMatchObject({
        status: "stale",
        reason: expect.stringContaining("database schema changed"),
      });
      expect(loaded.status === "stale" ? loaded.reason : "").toContain("database role");
      await clearBoundaryAuthoringResumeState(root);
      await expect(readBoundaryAuthoringResumeState(root, changed)).resolves.toEqual({ status: "none" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses credentials, endpoint URLs, and concrete trusted identities", () => {
    expect(() => buildBoundaryAuthoringResumeState({
      binding,
      stage: "planning",
      jobIntent: "Use postgres://operator:secret@db.example/app to review tickets.",
      provider: "openai",
      model: "gpt-test",
    })).toThrow("BOUNDARY_AUTHORING_RESUME_PRIVATE_MATERIAL_BLOCKED");
    expect(() => buildBoundaryAuthoringResumeState({
      binding,
      stage: "planning",
      jobIntent: "Use tenant_id: acme-corp to review tickets.",
      provider: "openai",
      model: "gpt-test",
    })).toThrow("BOUNDARY_AUTHORING_RESUME_TRUSTED_IDENTITY_BLOCKED");
  });

  it("permits symbolic trusted-scope explanations without persisting a concrete identity", () => {
    const state = buildBoundaryAuthoringResumeState({
      binding,
      stage: "action_drafting",
      jobIntent: "Review support tickets and propose a bounded update.",
      provider: "openai",
      model: "gpt-test",
      conversation: [{
        question: "Where does customer scope come from?",
        answer: "tenant_id is Runner-injected and principal_id is trusted runtime context.",
      }],
    });
    expect(state.conversation).toEqual([{
      question: "Where does customer scope come from?",
      answer: "tenant_id is Runner-injected and principal_id is trusted runtime context.",
    }]);
  });

  it.each([
    "Before fixing the validation error, answer one question exactly. In the reviewed scope right now, which column is bound as the tenant - carrier_id or account_id? And is that 10-per-24-hours cap counted per carrier organisation or per customer account? If the tenant is bound to account_id then the cap is per account, which is not what I required.",
    "Which column is bound as the tenant - scope_a or scope_b? If the tenant is bound to scope_b then the cap has the wrong scope.",
    "Yes. app.person is the authenticated patron's trusted identity and filters c01. app.tenant is the trusted library/account identity and filters c02. They are distinct even though both source columns are UUID. Keep these bindings private and outside model arguments.",
    "The tenant is the trusted account context; the principal is the reviewed authenticated person.",
  ])("retains descriptive trusted identity clarification through checkpoint save: %s", async (answer) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-symbolic-scope-resume-"));
    try {
      const state = buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting",
        jobIntent: "Let people collect eligible holds.", provider: "openai", model: "gpt-test",
        conversation: [{ question: "What do the identity bindings mean?", answer, kind: "clarification" }],
        action: { intent: "Collect an eligible hold.", checkpoint: actionRuleAuthoringCheckpoint({
          intent_digest: `sha256:${"4".repeat(64)}`, context_digest: `sha256:${"5".repeat(64)}`, components: {},
          operator_messages: [answer],
        }) },
      });
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      expect(state.conversation[0]?.answer).toBe(answer);
      expect(state.authority_granted).toBe(false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it.each(["tenant is acme-corp", "app.tenant = acme-corp", "principal_id: user-123", "tenant is the-account-123",
    "tenant is bound to customer123",
    "Which column is bound as the tenant - scope_a or scope_b? tenant is bound to acme-corp",
    "Which column is bound as the tenant - scope_a or scope_b? tenant is bound to scope_b. principal_id = user-123",
    "Which column is bound as the tenant - scope_a or scope_b? tenant = bound",
    "tenant is the trusted identity. principal_id = 45000000-0000-4000-8000-000000000001"])("still refuses concrete identity assignment: %s", (answer) => {
    expect(() => buildBoundaryAuthoringResumeState({ binding, stage: "planning", jobIntent: "Review records.",
      provider: "openai", model: "gpt-test", conversation: [{ question: "Scope?", answer }],
    })).toThrow("BOUNDARY_AUTHORING_RESUME_TRUSTED_IDENTITY_BLOCKED");
  });
});
