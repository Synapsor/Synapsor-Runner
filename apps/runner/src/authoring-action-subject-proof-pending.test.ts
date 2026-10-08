import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "./boundary-review-mutation.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { saveReviewedDisabledBoundary } from "./authoring-read-review-save.js";
import { projectReadSubjectContext } from "./authoring-read-subject-context.js";
import { reviewRequiredPrincipalScopes } from "./authoring-principal-scope-host.js";
import { buildActionRuleAuthoringCatalog } from "./action-rule-authoring.js";
import { createActionSubjectQuestion, applyActionSubjectFieldEvent, enrichActionSubjectProof } from "./authoring-action-subject.js";
import { actionSubjectOriginDigest, type ActionSubjectHostMaterial } from "./authoring-action-subject-binding.js";
import { projectActionSubjectStructural, planActionSubjectProof, acknowledgeActionSubjectPreparation, acknowledgeActionSubjectReview } from "./authoring-action-subject-proof.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import { actionSubjectTargets } from "./authoring-action-subject-ports.js";

it.each(["complete", "before_write", "after_commit_before_question_ack"] as const)("native requested-scope structural sequence: %s", async fault => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "owned-action-requested-proof-"));
  await fs.chmod(root, 0o700);
  try {
    const f = await prepareReviewedReadScope(root);
    await commitBoundaryResourceReviewMutation(root, await prepareBoundaryResourceReviewMutation(root, {
      resource_id: "work.items", principal_key: null, actor: "declared source owner", reason: "Declared tenant-only starting configuration",
    }, async () => f.inspection));
    const before = await loadBoundaryReviewContext(root);
    const catalog = buildActionRuleAuthoringCatalog({ boundary: before.candidate, inspection: f.inspection });
    const selected = catalog.authoring.resources.find(r => r.name === "work.items");
    expect(selected?.operations.update).toBe(true);
    expect(selected?.verification_only).not.toBe(true);
    const targets = actionSubjectTargets({ effect: { operation: "update", target_resource: "work.items", target_binding: "item" } });
    expect(targets).toEqual([{ kind: "primary_effect", resource: "work.items", binding: "item" }]);
    const initialProofs = projectReadSubjectContext({ context: before, sourceDigest: d(null) });
    expect(initialProofs.subject_scopes.filter(p => p.root_resource === targets[0]!.resource && p.kind === "principal")).toEqual([]);
    expect(initialProofs.subject_scopes).toEqual([expect.objectContaining({ root_resource: "work.items", kind: "tenant" })]);
    // This test binds the actual structural records; Resume CAS is covered in
    // the native host suite, not represented by these declared component ACKs.
    const structural = projectActionSubjectStructural({ context: before, sourceDigest: d(null) });
    const material: ActionSubjectHostMaterial = { version: 2, structural: structural.reference,
      outcome: "change", logical_turn_id: "declared-turn", baseline: null, request_digest: d("request"),
      applicability_digest: d("applicability"), candidate_digest: d("components"),
      targets: targets.map(target => ({ target, target_digest: d(target), options: [] })) };
    const entries = material.targets.map(t => ({ state: "awaiting" as const, target_digest: t.target_digest }));
    let question = createActionSubjectQuestion({ binding: { version: 2, material, origin: { completion: {
      operation_id: "declared-component-operation", request_digest: d("provider-request"), context_digest: d("context"), response_digest: d("response") },
      material_digest: actionSubjectOriginDigest(material, entries) } }, entries, scope_digest: d("scope"), context_digest: d("context") });
    const proposal = (q: OperatorQuestion) => { if (q.proposal?.value?.kind !== "action_subject") throw Error("missing"); return q.proposal.value.record; };
    const ack = () => ({ question_id: question.id, question_revision: question.revision, question_digest: question.digest,
      checkpoint_digest: d("declared-component-checkpoint"), resume_revision_digest: d("declared-component-resume"), proposal_digest: d(proposal(question)) });
    const view = proposal(question).view, field = view.fields[0]!;
    question = applyActionSubjectFieldEvent(question, { kind: "select_option", binding: view.binding, field_id: field.id,
      target_digest: field.target_digest, dependencies_digest: field.dependencies_digest, value: "request:principal" });
    let requirements = 0, decisions = 0, preparedCallback = 0, committedCallback = 0;
    let failure: unknown;
    const result = await reviewRequiredPrincipalScopes({ projectRoot: root, schemaInspector: async () => f.inspection,
      resourceIds: targets.map(t => t.resource), jobIntent: "Declared operator request: updates concern the signed-in person's records",
      actor: () => "declared source owner",
      onPrepared: async preview => {
        const current = projectActionSubjectStructural({ context: await loadBoundaryReviewContext(root), sourceDigest: d(null) });
        expect(current.reference).toEqual(structural.reference);
        question = enrichActionSubjectProof(question, planActionSubjectProof({ question, requestAck: ack(), current, preview }));
        expect(proposal(question).entries[0]!.state).toBe("requested"); preparedCallback++;
        if (fault === "before_write") throw Error("test interruption before structural write");
      },
      onCommitted: async ({ preview, committed }) => {
        expect(preparedCallback).toBe(1);
        if (fault === "after_commit_before_question_ack") throw Error("test interruption after actual commit ACK, before question save");
        const actual = projectActionSubjectStructural({ context: await loadBoundaryReviewContext(root), sourceDigest: d(null) });
        for (const key of ["schema_fingerprint", "role_posture_fingerprint"] as const)
          expect(actual.reference.binding[key], key).toBe(structural.reference.binding[key]);
        expect(actual.reference.binding.generation_lock_fingerprint).toBe(preview.candidate.generation_lock_fingerprint);
        expect(actual.reference.boundary_id, "boundary identity").toBe(structural.reference.boundary_id);
        question = enrichActionSubjectProof(question, acknowledgeActionSubjectPreparation({ question, requestAck: ack(),
          context: await loadBoundaryReviewContext(root), sourceDigest: d(null), preview, committed }));
        expect(question.confirmation).toBeUndefined(); committedCallback++;
      },
      // Characterization of the structural port only. The v2 native request ACK
      // must supply this projection in production; it is NOT simulated here.
      resolveRequirement: async resources => { requirements++; expect(resources).toEqual(["work.items"]); return { required: ["work.items"], unresolved: [] }; },
      session: { promptText: async () => undefined, chooseResource: async () => undefined, editFieldTiers: async () => undefined,
        confirm: async (_message, options) => { decisions++; expect(options?.defaultValue).toBe(false); return true; },
        chooseOption: async (_title, choices) => {
          const chosen = choices.filter(c => c.label.includes("principal_id"));
          expect(chosen).toHaveLength(1); decisions++; return chosen[0]!.value;
        } } }).catch(error => { failure = error; return undefined; });
    if (fault !== "complete") {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(/test interruption/);
      const saved = projectActionSubjectStructural({ context: await loadBoundaryReviewContext(root), sourceDigest: d(null) });
      expect(proposal(question).review_material!.phase).toBe("planned");
      expect(question.confirmation).toBeUndefined();
      if (fault === "before_write") expect(saved.reference).toEqual(structural.reference);
      else {
        expect(saved.reference.review_revision).toBe(structural.reference.review_revision + 1);
        expect(saved.reference.binding.candidate_digest).toBe(proposal(question).review_material!.mutation.candidate_digest);
        expect(saved.scopes).toEqual([]); // Actual commit retained; never rolled back or treated as final proof.
      }
      return;
    }
    expect(failure).toBeUndefined();
    expect(result).toEqual({ state: "ready", changed: true });
    expect(preparedCallback).toBe(1); expect(committedCallback).toBe(1);
    expect(requirements).toBeGreaterThanOrEqual(2); expect(decisions).toBeGreaterThan(0);
    const prepared = await loadBoundaryReviewContext(root);
    expect(prepared.candidate.pack.resources[0]!.principal_key).toBe("principal_id");
    // Structural preparation is durable but is not the final native review ACK.
    expect(projectReadSubjectContext({ context: prepared, sourceDigest: d(null) }).subject_scopes).toEqual([]);
    const signed = await saveReviewedDisabledBoundary({ projectRoot: root, context: prepared,
      actor: "declared source owner", reason: "Independent structural component proof; ordinary review callback separately tested" });
    const after = await loadBoundaryReviewContext(root), finalProofs = projectReadSubjectContext({ context: after, sourceDigest: d(null) });
    const current = projectActionSubjectStructural({ context: after, sourceDigest: d(null) });
    question = enrichActionSubjectProof(question, acknowledgeActionSubjectReview({ question, requestAck: ack(), current,
      acknowledged: { before: proposal(question).review_material!.after, context: after,
        committed: signed } }));
    expect(proposal(question).entries[0]!.state).toBe("proposed");
    expect(question.confirmation).toBeUndefined();
    expect(finalProofs.subject_scopes).toEqual([expect.objectContaining({ root_resource: "work.items", kind: "principal" })]);
    expect(after.progress!.revision).toBeGreaterThan(before.progress!.revision);
    expect(after.candidate.pack.resources.map(r => r.id)).toEqual(before.candidate.pack.resources.map(r => r.id));
    expect(after.candidate.pack.resources[0]!.selectable_fields).toEqual(before.candidate.pack.resources[0]!.selectable_fields);
    expect(after.lock.schema_fingerprint).toBe(before.lock.schema_fingerprint);
    expect(after.lock.role_posture_fingerprint).toBe(before.lock.role_posture_fingerprint);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
