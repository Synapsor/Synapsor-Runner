import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  actionBoundaryAuthorityDigest,
  actionBoundaryStatus,
  buildActionBoundaryDraft,
  completeActionBoundaryPublication,
  publishActionBoundaryActivation,
  readActionBoundaryActivation,
  readActionBoundaryDraft,
  reviseActionBoundaryDraft,
  writeActionBoundaryDraft,
  type ActionBoundaryCandidate,
} from "./action-boundary.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Action Boundary manifests", () => {
  it("builds one stable authority digest over exact action and read revisions", () => {
    const left = buildActionBoundaryDraft({
      candidates: [candidate("support.propose_refund"), candidate("support.propose_credit")],
      now: "2026-08-28T12:00:00.000Z",
    });
    const right = buildActionBoundaryDraft({
      candidates: [candidate("support.propose_credit"), candidate("support.propose_refund")],
      now: "2026-08-29T12:00:00.000Z",
    });

    expect(left.digest).toBe(right.digest);
    expect(left.authority.capabilities.map((item) => item.capability)).toEqual([
      "support.propose_credit",
      "support.propose_refund",
    ]);
    expect(left.authority.read_dependencies).toHaveLength(1);
    expect(left.digest).toBe(actionBoundaryAuthorityDigest(left.authority));
    expect(left.created_at).not.toBe(right.created_at);
  });

  it("changes the boundary digest for capability, policy, execution, or trusted-context authority", () => {
    const base = candidate("support.propose_credit");
    const baseline = buildActionBoundaryDraft({ candidates: [base] });
    const variants: ActionBoundaryCandidate[] = [
      { ...base, capability: { ...base.capability, contract_digest: digest("2") } },
      { ...base, approval_policy: { ...base.approval_policy, authority: { mode: "human", role: "finance" } } },
      { ...base, execution_profile: { ...base.execution_profile, authority: { posture: "executable" } } },
      {
        ...base,
        read_dependency: { ...base.read_dependency, trusted_context_fingerprint: digest("3") },
      },
    ];

    for (const variant of variants) {
      expect(buildActionBoundaryDraft({ candidates: [variant] }).digest).not.toBe(baseline.digest);
    }
  });

  it("rejects duplicate capabilities and invalid shared limits", () => {
    expect(() => buildActionBoundaryDraft({
      candidates: [candidate("support.propose_credit"), candidate("support.propose_credit")],
    })).toThrow(/ACTION_BOUNDARY_CAPABILITY_DUPLICATE/);
    expect(() => buildActionBoundaryDraft({
      candidates: [candidate("support.propose_credit")],
      sharedLimits: [{
        id: "daily_total",
        kind: "total",
        scope: "boundary",
        maximum: 1000,
        window_seconds: 86_400,
      }],
    })).toThrow(/total limits require a reviewed field/);
  });

  it("creates a disabled limit revision without changing the exact capability set", () => {
    const activeDraft = buildActionBoundaryDraft({
      candidates: [candidate("support.propose_credit")],
      now: "2026-08-28T12:00:00.000Z",
    });
    const revised = reviseActionBoundaryDraft({
      current: {
        ...activeDraft,
        state: "active",
        actor: "reviewer@example.test",
        activated_at: "2026-08-28T12:05:00.000Z",
      },
      sharedLimits: [{
        id: "tenant_daily_count",
        kind: "count",
        scope: "tenant",
        maximum: 20,
        window_seconds: 86_400,
      }],
      now: "2026-08-28T12:10:00.000Z",
    });
    expect(revised.state).toBe("disabled");
    expect(revised.authority.capabilities).toEqual(activeDraft.authority.capabilities);
    expect(revised.authority.shared_limits).toEqual([{
      id: "tenant_daily_count",
      kind: "count",
      scope: "tenant",
      maximum: 20,
      window_seconds: 86_400,
    }]);
    expect(revised.digest).not.toBe(activeDraft.digest);
  });

  it("persists disabled and immutable active manifests without publishing runtime authority", async () => {
    const root = await temporaryRoot();
    const draft = buildActionBoundaryDraft({
      candidates: [candidate("support.propose_credit")],
      now: "2026-08-28T12:00:00.000Z",
    });
    const draftPath = await writeActionBoundaryDraft(root, draft);
    expect(draftPath).toBe("./synapsor/actions/boundaries/drafts/default_action_boundary/boundary.json");
    await expect(readActionBoundaryDraft(root)).resolves.toEqual(draft);

    const publication = await publishActionBoundaryActivation({
      projectRoot: root,
      draft,
      actor: "reviewer@example.test",
      now: "2026-08-28T12:05:00.000Z",
    });
    expect(publication.activation).toMatchObject({
      state: "active",
      digest: draft.digest,
      actor: "reviewer@example.test",
    });
    await expect(readActionBoundaryActivation(root)).resolves.toEqual(publication.activation);
    await expect(fs.stat(path.join(root, publication.revision_path))).resolves.toBeDefined();
    await expect(fs.stat(path.join(root, "synapsor.actions.runner.json"))).rejects.toMatchObject({ code: "ENOENT" });

    await completeActionBoundaryPublication(root);
    await expect(readActionBoundaryDraft(root)).resolves.toBeUndefined();
    await expect(actionBoundaryStatus(root)).resolves.toMatchObject({
      active: { digest: draft.digest },
      synthesized_from_legacy_actions: false,
    });
  });

  it("restores the previous active pointer when later runtime publication fails", async () => {
    const root = await temporaryRoot();
    const first = buildActionBoundaryDraft({ candidates: [candidate("support.propose_credit")] });
    await publishActionBoundaryActivation({
      projectRoot: root,
      draft: first,
      actor: "reviewer@example.test",
    });
    const second = buildActionBoundaryDraft({
      candidates: [candidate("support.propose_credit"), candidate("support.propose_refund")],
    });
    const publication = await publishActionBoundaryActivation({
      projectRoot: root,
      draft: second,
      actor: "reviewer@example.test",
    });
    await expect(readActionBoundaryActivation(root)).resolves.toMatchObject({ digest: second.digest });

    await publication.rollback();
    await publication.rollback();
    await expect(readActionBoundaryActivation(root)).resolves.toMatchObject({ digest: first.digest });
    await expect(fs.stat(path.join(root, publication.revision_path))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a tampered draft before publication", async () => {
    const root = await temporaryRoot();
    const draft = buildActionBoundaryDraft({ candidates: [candidate("support.propose_credit")] });
    await writeActionBoundaryDraft(root, draft);
    const draftPath = path.join(root, "synapsor/actions/boundaries/drafts/default_action_boundary/boundary.json");
    const tampered = JSON.parse(await fs.readFile(draftPath, "utf8"));
    tampered.authority.capabilities[0].resource = "public.admins";
    await fs.writeFile(draftPath, JSON.stringify(tampered));

    await expect(readActionBoundaryDraft(root)).rejects.toThrow(/ACTION_BOUNDARY_DRAFT_CHANGED/);
  });
});

function candidate(capability: string): ActionBoundaryCandidate {
  return {
    read_dependency: {
      name: "reviewed_production",
      source: "local_postgres",
      digest: digest("a"),
      generation_lock_fingerprint: digest("b"),
      trusted_context_fingerprint: digest("c"),
    },
    capability: {
      capability,
      resource: "public.refunds",
      operation: "update",
      contract_digest: digest(capability.endsWith("refund") ? "d" : "e"),
      contract_path: `./synapsor/actions/revisions/${capability}/synapsor.contract.json`,
    },
    approval_policy: {
      capability,
      mode: "human",
      authority: { mode: "human", required_role: "support_reviewer" },
    },
    execution_profile: {
      capability,
      authority_posture: "proposal_only",
      writeback_mode: "none",
      authority: { posture: "proposal_only", writeback: { mode: "none" } },
    },
  };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-action-boundary-"));
  roots.push(root);
  return root;
}
