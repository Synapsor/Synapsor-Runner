import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { ProposalStore } from "@synapsor-runner/proposal-store";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { onboard } from "./guided-start.js";
import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";
import { loadBoundaryReviewContext } from "./boundary-commands.js";
import { readActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { policyCoverageDraft } from "./authoring-policy-evidence.js";
import { parsePolicyCoverage } from "./authoring-policy-coverage.js";
import { newPolicySourceSession, policyTextSnapshot, bindPolicyCoverage, savePolicySources } from "./authoring-policy-source.js";
import { buildBoundaryAuthoringResumeState, writeBoundaryAuthoringResumeState } from "./boundary-authoring-resume.js";
import { explorationBoundaryCandidateDigest } from "./auto-boundary.js";
import { assertCompleteSelectedActionProgram } from "./saved-action-job-review.js";
import { savedAuthoringPolicyReview } from "./authoring-saved-review.js";
import { withCountingOutcomeDomain } from "./authoring-counting-domain.js";
import { withProjectRuntimeAdmission } from "./project-runtime-admission.js";
import { withProjectAuthorityMutation, type ProjectAuthorityMutationPermit } from "./project-authority-mutation.js";
import { reviewClientDutyOwnership } from "./authoring-client-duties.js";
import { ownedProgramDraft, ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";

/** Renamed local-only component. Public disabled producer + ordinary parsed
 * coverage; no activation, imported authority, fabricated ready flag or provider. */
it("keeps accepted counting coverage current under admitted publication scope and refuses stale scope", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-studio-counting-"));
  const env = { ...process.env, OWNED_STUDIO_READ_URL: "postgresql://fixture.invalid/not-used" };
  const previous = process.env.OWNED_STUDIO_READ_URL;
  process.env.OWNED_STUDIO_READ_URL = env.OWNED_STUDIO_READ_URL;
  let output = "";
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
  try {
    expect(await onboard(["db", "--project-root", root, "--from-env", "OWNED_STUDIO_READ_URL", "--schema", "studio", "--json"],
      { interactive: false, schemaInspector: async () => ownedProgramInspection() }), output).toBe(0);
    const run = (args: string[]) => structuredBoundaryAuthoringCommand(["--project-root", root, ...args], async () => ownedProgramInspection());
    output = ""; expect(await run(["--export-draft", "counting.json", "--json"]), output).toBe(0);
    const request = JSON.parse(await fs.readFile(path.join(root, "counting.json"), "utf8"));
    request.read.resources = [{ resource_id: "studio.parcels", include: true, tenant_key: "tenant_id", principal_key: "principal_id", row_identity: "parcel_id",
      selectable_fields: ["label", "units", "available", "version"], keep_out_fields: ["internal_note"], withhold_from_model_fields: ["available", "version"], private_model_fields: ["available", "version"] }];
    const action = ownedProgramDraft(1);
    action.approval.mode = "policy"; action.approval.auto_approve_when = action.require;
    action.approval.shared_limits = [{ id: "studio.overall", kind: "count", scope: "boundary", maximum: 9, window_seconds: 86400 },
      { id: "studio.tenant", kind: "count", scope: "tenant", maximum: 2, window_seconds: 86400 }];
    request.actions = [action];
    await fs.writeFile(path.join(root, "counting.json"), JSON.stringify(request));
    output = ""; expect(await run(["--draft", "counting.json", "--json"]), output).toBe(0);
    const context = await loadBoundaryReviewContext(root);
    const draft = (await readActionRuleAuthorityDraft(root, `${context.candidate.pack.name}_rules`))!;
    const readDigest = explorationBoundaryCandidateDigest(context.candidate);
    const authorityDigest = canonicalJsonDigest({ read: readDigest, action: draft.digest });
    const sources = newPolicySourceSession();
    const source = policyTextSnapshot(Buffer.from("Unavailable parcels are refused.\nAt most nine automatic pack parcel overall and two per tenant within one rolling day."), "owned-studio-counting-rules.txt");
    sources.snapshots = [source]; sources.active = source.version;
    const answer = "Apply the automatic limits only to pack parcel.";
    const question = "Which selected outcomes consume the automatic allowance on line two?";
    sources.operator_messages = [answer];
    const domain = await withCountingOutcomeDomain(root, draft, async current => current, env);
    const coverageInput = { read: context.candidate, authority: draft, actions: [], decisions: [], policySources: sources, countingDomain: domain,
      operatorClarifications: [{ question, answer }] };
    const firstEvidence = policyCoverageDraft(coverageInput);
    const comparisons = action.approval.shared_limits.map((_limit, index) => ({ path: `/runner_evidence/actions/${action.outcome}/automatic_limits/${index}/history_selector/capability`,
      current_capability: null, required_capability: action.outcome }));
    const claims = { passages: [
      { start: 1, end: 1, responsibility: "runner", disposition: "implemented", interpretation: "The availability guard refuses unavailable parcels.", draft_paths: ["/actions/0/require"] },
      { start: 2, end: 2, responsibility: "runner", disposition: "conflict", interpretation: "The source counts this parcel outcome, while the current selector has no capability filter.",
        draft_paths: comparisons.map(comparison => comparison.path), counter_requirements: comparisons, operator_clarification: answer },
      { start: 2, end: 2, responsibility: "runner", disposition: "implemented", interpretation: "The overall and tenant rolling-day maxima are nine and two.", draft_paths: ["/actions/0/approval/shared_limits"] },
    ] };
    const first = parsePolicyCoverage(claims, source, firstEvidence, sources.operator_messages);
    expect(first.passages.some(passage => passage.disposition === "conflict")).toBe(true);
    bindPolicyCoverage(sources, first, authorityDigest);
    const currentEvidence = policyCoverageDraft(coverageInput);
    const report = parsePolicyCoverage(claims, source, currentEvidence, sources.operator_messages);
    expect(report.passages.some(passage => passage.counting_resolution?.kind === "conditional_singleton_equivalence")).toBe(true);
    sources.application_assignments = await reviewClientDutyOwnership({ report, sources,
      session: { chooseOption: async () => "assign" }, assertCurrent: async () => {} });
    bindPolicyCoverage(sources, report, authorityDigest);
    await savePolicySources(root, sources, { expectedDigest: null });
    const binding = { boundary_name: context.candidate.pack.name, generation_lock_fingerprint: context.candidate.generation_lock_fingerprint,
      schema_fingerprint: context.lock.schema_fingerprint, role_posture_fingerprint: context.lock.role_posture_fingerprint };
    // A deliberately reviewed reduction of a saved larger agenda retains v2
    // semantics. This host progress state is not coverage or activation authority.
    const previousProgram = buildBoundaryAuthoringResumeState({ binding, stage: "action_drafting", jobIntent: "Review the selected parcel program.",
      provider: "openai", model: "owned-offline", action: { intent: "Parcel one", intents: Array.from({ length: 9 }, (_, i) => `Parcel ${i + 1}`) } });
    const state = buildBoundaryAuthoringResumeState({ binding, previous: previousProgram, stage: "authority_review", jobIntent: previousProgram.job_intent,
      provider: "openai", model: "owned-offline", policySourceSession: sources.id,
      action: { intent: "Parcel one", intents: ["Parcel one"], outcome: action.outcome, completed_outcomes: [action.outcome] } });
    expect(state.schema_version).toBe("synapsor.boundary-authoring-resume.v2");
    await writeBoundaryAuthoringResumeState(root, state, { expectedRevisionDigest: null });
    expect((await savedAuthoringPolicyReview({ projectRoot: root, binding, readDigest, exactActionDraft: draft, env }))?.ready).toBe(true);
    let heldPermit: ProjectAuthorityMutationPermit | undefined;
    await withProjectRuntimeAdmission(root, async admitted => withProjectAuthorityMutation(admitted, async permit => {
      heldPermit = permit;
      await expect(assertCompleteSelectedActionProgram({ projectRoot: root, draft, env, permit })).resolves.toBeUndefined();
      expect(await withCountingOutcomeDomain(root, draft, async current => current, env, permit)).toEqual(domain);
      const foreignRoot = await fs.mkdtemp(path.join(os.tmpdir(), "owned-studio-foreign-permit-"));
      try {
        await expect(withCountingOutcomeDomain(foreignRoot, draft, async current => current, env, permit)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
      } finally { await fs.rm(foreignRoot, { recursive: true, force: true }); }
    }));
    await expect(withCountingOutcomeDomain(root, draft, async current => current, env, heldPermit)).rejects.toMatchObject({ code: "POLICY_MUTATION_PERMIT_INVALID" });
    const otherStore = path.join(root, ".synapsor/other.db"); new ProposalStore(otherStore).close();
    const staleEnv = { ...env, SYNAPSOR_LOCAL_STORE: otherStore };
    expect((await savedAuthoringPolicyReview({ projectRoot: root, binding, readDigest, exactActionDraft: draft, env: staleEnv }))?.ready).toBe(false);
    await withProjectRuntimeAdmission(root, async admitted => withProjectAuthorityMutation(admitted, async permit => {
      await expect(assertCompleteSelectedActionProgram({ projectRoot: root, draft, env: staleEnv, permit })).rejects.toThrow("Full attached source coverage");
    }));
    await expect(assertCompleteSelectedActionProgram({ projectRoot: root, draft, env })).resolves.toBeUndefined();
  } finally {
    stdout.mockRestore(); if (previous === undefined) delete process.env.OWNED_STUDIO_READ_URL; else process.env.OWNED_STUDIO_READ_URL = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
}, 20000);
