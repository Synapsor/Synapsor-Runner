import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { clientHandoffMatchesActiveAuthority, pendingClientResponsibilities } from "./authoring-client-readiness.js";
import { newPolicySourceSession, policyTextSnapshot, savePolicySources, bindPolicyCoverage } from "./authoring-policy-source.js";

const active = vi.hoisted(() => ({ reads: vi.fn(), actions: vi.fn() }));
vi.mock("./auto-boundary.js", async (original) => ({ ...await original<typeof import("./auto-boundary.js")>(), loadActivatedExplorationBoundaries: active.reads }));
vi.mock("./action-rule-authority.js", async (original) => ({ ...await original<typeof import("./action-rule-authority.js")>(), loadActiveActionRuleAuthority: active.actions }));
const digest = (c: string): `sha256:${string}` => `sha256:${c.repeat(64)}`;
const binding = { boundary_name: "reviewed_staging", generation_lock_fingerprint: digest("1"), schema_fingerprint: digest("2"), role_posture_fingerprint: digest("3") };
const saved = (action = true) => buildBoundaryAuthoringResumeState({
  binding, stage: "client_setup", jobIntent: "Complete eligible requests and confirm them accurately.", provider: "openai", model: "gpt-5.6-terra",
  clientHandoff: { read_digest: digest("4"), ...(action ? { action_digest: digest("5") } : {}) },
});

describe("client setup checkpoint is navigation, never authority or readiness proof", () => {
  beforeEach(() => {
    active.reads.mockResolvedValue([{ pack: { name: binding.boundary_name }, activation: { digest: digest("4") } }]);
    active.actions.mockResolvedValue({ authority: { action_boundary: { digest: digest("5") } } });
  });
  it("persists the exact handoff without claiming client or worker readiness", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-client-checkpoint-"));
    try {
      const state = saved();
      await writeBoundaryAuthoringResumeState(root, state);
      expect(await readBoundaryAuthoringResumeState(root, binding)).toEqual({ status: "ready", value: state });
      expect(await clientHandoffMatchesActiveAuthority(root, state)).toBe(true);
      expect(state).not.toHaveProperty("client_verified");
      expect(state).not.toHaveProperty("worker_running");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("refuses handoff shortcuts after Read revision, revocation or selection changes", async () => {
    for (const reads of [[], [{ pack: { name: binding.boundary_name }, activation: { digest: digest("6") } }],
      [{ pack: { name: "another_boundary" }, activation: { digest: digest("4") } }]]) {
      active.reads.mockResolvedValue(reads);
      expect(await clientHandoffMatchesActiveAuthority("unused", saved())).toBe(false);
    }
  });
  it("refuses handoff shortcuts after Action revision, revocation or unreviewed addition", async () => {
    for (const actions of [undefined, { authority: { action_boundary: { digest: digest("6") } } }]) {
      active.actions.mockResolvedValue(actions);
      expect(await clientHandoffMatchesActiveAuthority("unused", saved())).toBe(false);
    }
    active.actions.mockResolvedValue({ authority: { action_boundary: { digest: digest("5") } } });
    expect(await clientHandoffMatchesActiveAuthority("unused", saved(false))).toBe(false);
    active.actions.mockResolvedValue(undefined);
    expect(await clientHandoffMatchesActiveAuthority("unused", saved(false))).toBe(true);
  });
  it("retains assigned client duties as unverified through reload and detects changed snapshots", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-client-duties-"));
    try {
      const session = newPolicySourceSession();
      const source = policyTextSnapshot(Buffer.from("Show completion only after the receipt."), "rules.txt");
      session.snapshots = [source]; session.active = source.version;
      session.coverage = { source_digest: source.digest, draft_digest: digest("7"), passages: [{ start: 1, end: 1,
        disposition: "needs_decision", responsibility: "application", topic: "Customer confirmation", interpretation: "The client must use receipt state.",
        draft_paths: ["/runner_evidence/runtime_contract/application_obligations/status_presentation"], application_obligations: ["status_presentation"], next_step: "Verify the client distinguishes approved and completed.",
      }] };
      session.application_assignments = [{ source_digest: source.digest, draft_digest: digest("7"), start: 1, end: 1,
        obligations: ["status_presentation"], assigned_at: new Date().toISOString(), owner: "client_application", verified: false }];
      await savePolicySources(root, session);
      const state = { ...saved(), policy_source_session: session.id };
      expect((await pendingClientResponsibilities(root, state)).join("\n")).toContain("assigned to your client application; not verified");
      session.coverage_authority_digest = digest("a");
      bindPolicyCoverage(session, { ...session.coverage, draft_digest: digest("b"), passages: [
        { start: 1, end: 1, disposition: "implemented", interpretation: "Runner supplies a receipt, not a customer interface.",
          draft_paths: ["/runner_evidence/runtime_contract/receipts"], responsibility: "runner" },
        ...session.coverage.passages,
      ] }, digest("a"));
      await savePolicySources(root, session);
      expect((await pendingClientResponsibilities(root, state)).join("\n")).toContain("assigned to your client application; not verified");
      expect(session.application_assignments[0]?.assigned_at).toBeTruthy();
      bindPolicyCoverage(session, { ...session.coverage, draft_digest: digest("c") }, digest("d"));
      await savePolicySources(root, session);
      expect((await pendingClientResponsibilities(root, state)).join("\n")).toContain("assignment pending; not verified");
      session.coverage.draft_digest = digest("8");
      await savePolicySources(root, session);
      expect((await pendingClientResponsibilities(root, state)).join("\n")).toContain("assignment pending; not verified");
      session.coverage.source_digest = digest("9");
      await savePolicySources(root, session);
      expect((await pendingClientResponsibilities(root, state)).join("\n")).toContain("current coverage check");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("handles an absent Action file for read-only jobs but refuses corrupt authority", async () => {
    active.actions.mockRejectedValue(Object.assign(new Error("No active Action authority"), { code: "ENOENT" }));
    expect(await clientHandoffMatchesActiveAuthority("unused", saved(false))).toBe(true);
    expect(await clientHandoffMatchesActiveAuthority("unused", saved())).toBe(false);
    active.actions.mockRejectedValue(Object.assign(new Error("Invalid immutable authority"), { code: "ACTION_RULE_INVALID" }));
    await expect(clientHandoffMatchesActiveAuthority("unused", saved(false))).rejects.toThrow("Invalid immutable authority");
  });
});
