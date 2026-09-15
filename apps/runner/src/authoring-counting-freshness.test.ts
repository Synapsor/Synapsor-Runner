import { acceptClientDutyOwnership } from "./test-fixtures/accept-client-duty-ownership.js";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { ProposalStore, migrateSharedPostgresRuntimeStore, type ProposalRuntimeStore } from "@synapsor-runner/proposal-store";
import { createProjectRuntimeStore, migrateProjectControlPolicies } from "./control-policy-store.js";
import { withCountingOutcomeDomain } from "./authoring-counting-domain.js";
import { savedAuthoringPolicyReview } from "./authoring-saved-review.js";
import { explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import * as authorities from "./action-rule-authority.js";
import { parsePolicyCoverage } from "./authoring-policy-coverage.js";
import { bindPolicyCoverage, loadPolicySources, savePolicySources } from "./authoring-policy-source.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";

const trace = JSON.parse(readFileSync(new URL("./fixtures/mixed-counting-review.json", import.meta.url), "utf8"));
const proposed = JSON.parse(readFileSync(new URL("./fixtures/attached-policy-reconciliation.json", import.meta.url), "utf8"))[0].authority as authorities.ActionRuleAuthorityDraftV1;

describe("saved counting review depends on the actual current store", () => {
  for (const backend of ["sqlite", "postgres"] as const) it.skipIf(backend === "postgres" && !process.env.SYNAPSOR_TEST_POSTGRES_URL)(`${backend}: a competing automatic outcome invalidates status, reuse and pre-save validation`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-counting-freshness-"));
    const config = JSON.parse(readFileSync(new URL("../../../examples/reference-support-billing-app/synapsor.runner.json", import.meta.url), "utf8"));
    config.capabilities = config.capabilities.filter((c: any) => c.kind === "read").slice(0, 1);
    config.storage = { sqlite_path: ".synapsor/local.db", ...(backend === "postgres" ? { shared_postgres: { mode: "runtime_store", url_env: "SYNAPSOR_TEST_POSTGRES_URL", schema: `freshness_${Date.now()}_${Math.random().toString(16).slice(2,8)}` } } : {}) };
    let store: ProposalRuntimeStore | undefined;
    // Only the saved draft inventory is supplied by this composed fixture.
    // Domain inspection and approval history use real independent store handles.
    const inventory = vi.spyOn(authorities, "listActionRuleAuthorityDrafts").mockResolvedValue([proposed]);
    try {
      await fs.writeFile(path.join(root, "synapsor.runner.json"), JSON.stringify(config));
      if (backend === "sqlite") new ProposalStore(path.join(root, ".synapsor/local.db")).close();
      const migration = await migrateProjectControlPolicies({ projectRoot: root, config, storePath: path.join(root, ".synapsor/local.db"), actor: "owned-test-operator", readLegacySnapshot: async () => ({ revisions: [], active: [], drafts: [], provenance: [] }), validateSnapshot: async () => {} });
      await migration.binding.close();
      if (backend === "postgres") { const pool = new Pool({ connectionString: process.env.SYNAPSOR_TEST_POSTGRES_URL }); try { await migrateSharedPostgresRuntimeStore(pool, config.storage.shared_postgres.schema); } finally { await pool.end(); } }
      const state = structuredClone(trace.policy_sources), draft = structuredClone(trace.drafts[0]), source = trace.source;
      const domain = await withCountingOutcomeDomain(root, proposed, async current => current);
      draft.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain = domain;
      const readDigest = explorationBoundaryCandidateDigest(draft.read), authorityDigest = canonicalJsonDigest({ read: readDigest, action: proposed.digest });
      expect(authorityDigest).toBe(state.coverage_authority_digest);
      for (const interpretation of draft.runner_evidence.counting_interpretations) interpretation.authority_digest = authorityDigest;
      const report = parsePolicyCoverage(trace.replies[0], source, draft, trace.operator_messages);
      await acceptClientDutyOwnership(report, state);
      bindPolicyCoverage(state, report, authorityDigest); await savePolicySources(root, state, { expectedDigest: null });
      const binding = { boundary_name: "reviewed_staging", generation_lock_fingerprint: canonicalJsonDigest("lock"), schema_fingerprint: canonicalJsonDigest("schema"), role_posture_fingerprint: canonicalJsonDigest("reader") };
      await writeBoundaryAuthoringResumeState(root, buildBoundaryAuthoringResumeState({ binding, stage: "authority_review", jobIntent: "Review the saved job.", provider: "openai", model: "gpt-5.6-terra", policySourceSession: state.id }), { expectedRevisionDigest: null });
      const ready = await savedAuthoringPolicyReview({ projectRoot: root, binding, readDigest });
      expect(ready, JSON.stringify(ready)).toMatchObject({ ready: true });
      const resumeInput = { binding, stage: "authority_review" as const, jobIntent: "Review the saved job.", provider: "openai" as const, model: "gpt-5.6-terra", policySourceSession: state.id };
      await writeBoundaryAuthoringResumeState(root, buildBoundaryAuthoringResumeState({ ...resumeInput, intendedClient: "cursor" }));
      const changedClient = await savedAuthoringPolicyReview({ projectRoot: root, binding, readDigest });
      expect(changedClient?.ready).toBe(false);
      expect(changedClient?.summary.join(" ")).toContain("Client responsibilities need current contract");
      await writeBoundaryAuthoringResumeState(root, buildBoundaryAuthoringResumeState(resumeInput));
      expect((await savedAuthoringPolicyReview({ projectRoot: root, binding, readDigest }))?.ready).toBe(true);
      store = await createProjectRuntimeStore({ projectRoot: root, config, storePath: path.join(root, ".synapsor/local.db") });
      const input = JSON.parse(readFileSync(new URL("../../../fixtures/protocol/change-set.late-fee-waiver.v1.json", import.meta.url), "utf8"));
      input.proposal_id = "wrp_competing_outcome"; input.action = "diagnostic.other"; input.integrity.proposal_hash = canonicalJsonDigest("owned competing request");
      const proposal = await store.createProposal(input);
      expect((await store.approveProposalByPolicy(proposal.proposal_id, { policy: "owned-diagnostic", proposal_hash: proposal.proposal_hash, proposal_version: proposal.proposal_version, reason: "Independent test history", action_boundary: { name: proposed.authority.action_boundary.name, digest: proposed.authority.action_boundary.digest, limits: [] } })).approved).toBe(true);
      expect((await savedAuthoringPolicyReview({ projectRoot: root, binding, readDigest }))?.ready).toBe(false);
      let persisted = false;
      await expect(withCountingOutcomeDomain(root, proposed, async (current, permit) => {
        const currentDraft = structuredClone(draft); currentDraft.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain = current;
        parsePolicyCoverage({ passages: report.passages }, source, currentDraft, trace.operator_messages);
        await savePolicySources(root, state, { expectedDigest: canonicalJsonDigest(state), permit }); persisted = true;
      })).rejects.toThrow("COUNTING_BEHAVIOR_DIFFERENT");
      expect(persisted).toBe(false); expect(await loadPolicySources(root, state.id)).toEqual(state);
      expect((await withCountingOutcomeDomain(root, proposed, async current => current)).retained_automatic_outcomes).toEqual(["diagnostic.other"]);
    } finally { inventory.mockRestore(); await store?.close(); await fs.rm(root, { recursive: true, force: true }); }
  }, 20_000);
});
