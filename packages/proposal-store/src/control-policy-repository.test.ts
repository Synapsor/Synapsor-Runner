import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { ProposalStore } from "./sqlite-store.js";
import { type ControlPolicyRevision, type ControlPolicyScope } from "./control-policy-repository.js";

const stores: ProposalStore[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function store(path = ":memory:") {
  const value = new ProposalStore(path);
  stores.push(value);
  return { raw: value, policies: value.controlPolicies };
}
const operator: ControlPolicyScope = { level: "operator" };
const owner = (tenant: string): ControlPolicyScope => ({ level: "principal", tenant_id: tenant, principal: "maya" });
const key = (scope: ControlPolicyScope = operator) => ({ scope, kind: "action" as const, name: "inventory.replenish" });
function revision(id: string, scope = operator, content: unknown = { quantity: { maximum: 20 } }): ControlPolicyRevision {
  return { ...key(scope), revision_id: id, authority_digest: canonicalJsonDigest({ reviewed: content }),
    content_digest: canonicalJsonDigest(content), content };
}
function event(id: string) {
  return { event_id: id, actor: "authenticated-test-manager", occurred_at: "2026-09-06T00:00:00.000Z", receipt: { operation: "explicit-test-review", candidate: id } };
}
function imported(revisions = [revision("v1")]) {
  return { deployment_id: "deployment-one", project_id: "project-one", migration_digest: canonicalJsonDigest({ fixture: "legacy-1" }),
    revisions, active: revisions.map(({ revision_id, scope, kind, name }) => ({ revision_id, scope, kind, name })), event: event("import") };
}

describe("control policy repository storage foundation", () => {
  it("keeps disabled revisions distinct from active authority in one exact snapshot", async () => {
    const { policies } = store(); await policies.initialize(); await policies.importDeployment(imported());
    const disabled = revision("draft-v2", operator, { quantity: { maximum: 8 } });
    await policies.commit({ deployment_id: "deployment-one", expected_epoch: 1, revisions: [disabled], active: [],
      drafts: [{ ...key(), revision_id: disabled.revision_id }], event: event("save-disabled") });
    expect(await policies.snapshot("deployment-one", [key()])).toEqual({ epoch: 2, policies: [{ active: revision("v1"), draft: disabled }] });
    expect(await policies.listDrafts({ deployment_id: "deployment-one", scope: operator, kind: "action" })).toEqual([disabled]);
    await policies.commit({ deployment_id: "deployment-one", expected_epoch: 2, revisions: [],
      active: [{ ...key(), revision_id: disabled.revision_id }], drafts: [{ ...key(), revision_id: null }], event: event("activate-reviewed") });
    expect(await policies.snapshot("deployment-one", [key()])).toEqual({ epoch: 3, policies: [{ active: disabled }] });
    const recent = await policies.history({ deployment_id: "deployment-one", key: key(), limit: 1 });
    expect(recent).toEqual([{ epoch: 2, revision: disabled }]);
    expect(await policies.history({ deployment_id: "deployment-one", key: key(), before: { epoch: 2, revision_id: disabled.revision_id } }))
      .toEqual([{ epoch: 1, revision: revision("v1") }]);
    expect(await policies.history({ deployment_id: "deployment-one", key: key(owner("acme")) })).toEqual([]);
  });

  it("preserves multiple imported revisions of one key without skipping history pages", async () => {
    const { policies } = store(); await policies.initialize();
    await policies.importDeployment({ ...imported([revision("old"), revision("new")]), active: [{ ...key(), revision_id: "old" }],
      drafts: [{ ...key(), revision_id: "new" }] });
    const first = await policies.history({ deployment_id: "deployment-one", key: key(), limit: 1 });
    expect(first[0]?.revision.revision_id).toBe("old");
    const second = await policies.history({ deployment_id: "deployment-one", key: key(), before: { epoch: 1, revision_id: "old" }, limit: 1 });
    expect(second[0]?.revision.revision_id).toBe("new");
    expect(await policies.history({ deployment_id: "deployment-one", key: key(), before: { epoch: 1, revision_id: "new" }, limit: 1 })).toEqual([]);
  });

  it("fails a cross-scope draft and malformed batch without changing either pointer", async () => {
    const { policies } = store(); await policies.initialize(); await policies.importDeployment(imported());
    await expect(policies.commit({ deployment_id: "deployment-one", expected_epoch: 1, revisions: [], active: [],
      drafts: [{ ...key(owner("beta")), revision_id: "v1" }], event: event("wrong-scope-draft") })).rejects.toThrow();
    await expect(policies.snapshot("deployment-one", Array.from({ length: 65 }, () => key()))).rejects.toMatchObject({ code: "POLICY_BATCH_TOO_LARGE" });
    await expect(policies.listDrafts({ deployment_id: "deployment-one", scope: operator, kind: "action", limit: 101 })).rejects.toMatchObject({ code: "POLICY_LIST_LIMIT_INVALID" });
    await expect(policies.commit({ deployment_id: "deployment-one", expected_epoch: 1, revisions: [], active: [],
      drafts: [{ ...key(), revision_id: null }, { ...key(), revision_id: null }], event: event("duplicate") })).rejects.toMatchObject({ code: "POLICY_DUPLICATE_POINTER" });
    expect(await policies.snapshot("deployment-one", [key()])).toEqual({ epoch: 1, policies: [{ active: revision("v1") }] });
  });

  it("imports exact immutable authority and preserves scope, identity and history across reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "synapsor-policy-store-")); roots.push(root);
    const path = join(root, "control.db");
    const first = store(path);
    const id = await first.policies.initialize();
    expect(await first.policies.initialize()).toBe(id);
    expect(await first.policies.importDeployment(imported())).toBe("imported");
    expect(await first.policies.active("deployment-one", key())).toEqual(revision("v1"));
    first.raw.close(); stores.splice(stores.indexOf(first.raw), 1);
    const second = store(path);
    expect(await second.policies.identity()).toBe(id);
    expect(await second.policies.deployment("deployment-one")).toMatchObject({ epoch: 1, project_id: "project-one" });
    expect(await second.policies.revision("deployment-one", key(), "v1")).toEqual(revision("v1"));
    expect(second.raw.db.prepare("SELECT COUNT(*) AS n FROM control_policy_events").get()?.n).toBe(1);
  });

  it("does not replay an old import over a later activation or revoke history", async () => {
    const { policies, raw } = store(); await policies.initialize();
    await policies.importDeployment(imported());
    const next = revision("v2", operator, { quantity: { maximum: 10 } });
    await policies.commit({ deployment_id: "deployment-one", expected_epoch: 1, revisions: [next],
      active: [{ ...key(), revision_id: "v2" }], event: event("change") });
    expect(await policies.importDeployment(imported())).toBe("already_imported");
    expect(await policies.active("deployment-one", key())).toEqual(next);
    expect(await policies.revision("deployment-one", key(), "v1")).toEqual(revision("v1"));
    await policies.commit({ deployment_id: "deployment-one", expected_epoch: 2, revisions: [],
      active: [{ ...key(), revision_id: null }], event: event("revoke") });
    expect(await policies.active("deployment-one", key())).toBeUndefined();
    expect(await policies.revision("deployment-one", key(), "v2")).toEqual(next);
    expect(raw.db.prepare("SELECT COUNT(*) AS n FROM control_policy_events").get()?.n).toBe(3);
    await expect(policies.importDeployment({ ...imported(), migration_digest: canonicalJsonDigest("changed export") }))
      .rejects.toMatchObject({ code: "POLICY_MIGRATION_MISMATCH" });
  });

  it("uses composite owner scopes even when tenants share a principal name", async () => {
    const { policies } = store(); await policies.initialize();
    await policies.importDeployment(imported([revision("acme-v1", owner("acme")), revision("beta-v1", owner("beta"))]));
    expect(await policies.revision("deployment-one", key(owner("beta")), "acme-v1")).toBeUndefined();
    expect(await policies.listActive({ deployment_id: "deployment-one", scope: owner("acme"), kind: "action" }))
      .toEqual([revision("acme-v1", owner("acme"))]);
    expect(await policies.listActive({ deployment_id: "deployment-one", scope: { level: "tenant", tenant_id: "acme" }, kind: "action" })).toEqual([]);
    await expect(policies.commit({ deployment_id: "deployment-one", expected_epoch: 1, revisions: [],
      active: [{ ...key(owner("beta")), revision_id: "acme-v1" }], event: event("wrong-owner") })).rejects.toThrow();
    expect((await policies.deployment("deployment-one"))?.epoch).toBe(1);
    expect(await policies.active("deployment-one", key(owner("beta")))).toEqual(revision("beta-v1", owner("beta")));
  });

  it("rolls back a failed migration rather than leaving a partial deployment", async () => {
    const { policies, raw } = store(); await policies.initialize();
    await expect(policies.importDeployment({ ...imported(), active: [{ ...key(), revision_id: "missing" }] })).rejects.toThrow();
    expect(await policies.deployment("deployment-one")).toBeUndefined();
    expect(raw.db.prepare("SELECT COUNT(*) AS n FROM control_policy_revisions").get()?.n).toBe(0);
    expect(raw.db.prepare("SELECT COUNT(*) AS n FROM control_policy_events").get()?.n).toBe(0);
    expect(await policies.importDeployment(imported())).toBe("imported");
  });

  it("rejects stale commits atomically across separate local connections", async () => {
    const root = mkdtempSync(join(tmpdir(), "synapsor-policy-concurrency-")); roots.push(root);
    const first = store(join(root, "control.db")); await first.policies.initialize();
    await first.policies.importDeployment(imported());
    const second = store(join(root, "control.db"));
    const results = await Promise.allSettled([first, second].map(({ policies }, index) => policies.commit({
      deployment_id: "deployment-one", expected_epoch: 1, revisions: [revision(`change-${index}`)],
      active: [{ ...key(), revision_id: `change-${index}` }], event: event(`review-${index}`),
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toMatchObject({ code: "POLICY_REVISION_CONFLICT" });
    expect((await first.policies.deployment("deployment-one"))?.epoch).toBe(2);
    expect(first.raw.db.prepare("SELECT COUNT(*) AS n FROM control_policy_revisions").get()?.n).toBe(2);
  });

  it("does not overwrite a revision or consume a review event twice", async () => {
    const { policies } = store(); await policies.initialize(); await policies.importDeployment(imported());
    await expect(policies.commit({ deployment_id: "deployment-one", expected_epoch: 1,
      revisions: [revision("v1", operator, { quantity: 100 })], active: [], event: event("overwrite") })).rejects.toThrow();
    await expect(policies.commit({ deployment_id: "deployment-one", expected_epoch: 1,
      revisions: [revision("v2")], active: [], event: event("import") })).rejects.toThrow();
    expect((await policies.deployment("deployment-one"))?.epoch).toBe(1);
    expect(await policies.revision("deployment-one", key(), "v2")).toBeUndefined();
    expect(await policies.active("deployment-one", key())).toEqual(revision("v1"));
  });

  it("fails closed for corrupted content and a missing repository", async () => {
    const { policies, raw } = store();
    await expect(policies.identity()).rejects.toThrow();
    await policies.initialize(); await policies.importDeployment(imported());
    raw.db.prepare("UPDATE control_policy_revisions SET content_json = ?").run('{"quantity":999}');
    await expect(policies.active("deployment-one", key())).rejects.toMatchObject({ code: "POLICY_CONTENT_MISMATCH" });
    await expect(policies.listActive({ deployment_id: "deployment-one", scope: operator, kind: "action" }))
      .rejects.toMatchObject({ code: "POLICY_CONTENT_MISMATCH" });
  });
});
