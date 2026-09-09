import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildBoundaryAuthoringResumeState,
  clearBoundaryAuthoringResumeState,
  readBoundaryAuthoringResumeState,
  revalidateBoundaryAuthoringResume,
  writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeBinding,
} from "./boundary-authoring-resume.js";
import { actionRuleAuthoringCheckpoint } from "./action-rule-authoring-checkpoint.js";

const binding: BoundaryAuthoringResumeBinding = {
  boundary_name: "reviewed_staging",
  generation_lock_fingerprint: `sha256:${"1".repeat(64)}`,
  schema_fingerprint: `sha256:${"2".repeat(64)}`,
  role_posture_fingerprint: `sha256:${"3".repeat(64)}`,
};

describe("Boundary authoring resume state", () => {
  it("revalidates business context and exact completed outcomes without carrying stale analysis, Action checkpoints or consent", () => {
    const state = buildBoundaryAuthoringResumeState({ binding, stage: "client_setup",
      jobIntent: "Review visits and propose rescheduling.", provider: "openai", model: "gpt-5.6-terra",
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
          components: {},
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
    });
    expect(next.action?.checkpoint).toBeUndefined();
    expect(next.client_handoff).toBeUndefined();
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
});
