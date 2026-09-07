import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { type ControlPolicyRevision, type ControlPolicyScope } from "./control-policy-repository.js";
import { PostgresProposalRuntimeStore } from "./postgres-runtime-store.js";

const databaseUrl = process.env.SYNAPSOR_TEST_POSTGRES_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("control policy PostgreSQL storage parity", () => {
  const schema = `synapsor_policy_${process.pid}_${randomBytes(4).toString("hex")}`;
  let pool: Pool;
  const operator: ControlPolicyScope = { level: "operator" };
  const key = (scope: ControlPolicyScope = operator) => ({ scope, kind: "action" as const, name: "university.enroll" });
  const revision = (id: string, scope: ControlPolicyScope = operator, content: unknown = { credits: { maximum: 18 } }): ControlPolicyRevision => ({
    ...key(scope), revision_id: id, content, content_digest: canonicalJsonDigest(content), authority_digest: canonicalJsonDigest({ reviewed: content }),
  });
  const event = (id: string) => ({ event_id: id, actor: "authenticated-test-owner", occurred_at: "2026-09-06T00:00:00.000Z", receipt: { candidate: id } });
  const imported = (deployment: string, revisions = [revision("v1")]) => ({
    deployment_id: deployment, project_id: `project-${deployment}`, migration_digest: canonicalJsonDigest({ legacy: deployment }), revisions,
    active: revisions.map(({ scope, kind, name, revision_id }) => ({ scope, kind, name, revision_id })), event: event("import"),
  });
  const repository = () => new PostgresProposalRuntimeStore({ pool, schema }).controlPolicies;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 2_000, statement_timeout: 10_000 });
    await pool.query(`CREATE SCHEMA "${schema}"`);
  });
  afterAll(async () => {
    if (!pool) return;
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await pool.end(); }
  });

  it("serializes concurrent initialization and preserves one repository identity", async () => {
    const identities = await Promise.all(Array.from({ length: 4 }, () => repository().initialize()));
    expect(new Set(identities).size).toBe(1);
    expect(await repository().identity()).toBe(identities[0]);
  });

  it("atomically imports once and does not replay migration over a new active revision", async () => {
    const first = repository(); const second = repository();
    const inputs = imported("migration");
    const results = await Promise.all([first.importDeployment(inputs), second.importDeployment(inputs)]);
    expect(results.sort()).toEqual(["already_imported", "imported"]);
    const v2 = revision("v2", operator, { credits: { maximum: 12 } });
    await first.commit({ deployment_id: "migration", expected_epoch: 1, revisions: [v2], active: [{ ...key(), revision_id: "v2" }], event: event("review-v2") });
    expect(await second.importDeployment(inputs)).toBe("already_imported");
    expect(await second.active("migration", key())).toEqual(v2);
    expect(await second.revision("migration", key(), "v1")).toEqual(revision("v1"));
    await expect(second.importDeployment({ ...inputs, project_id: "another-project" })).rejects.toMatchObject({ code: "POLICY_MIGRATION_MISMATCH" });
  });

  it("rolls back all records on interrupted import or an invalid pointer", async () => {
    const policies = repository();
    await expect(policies.importDeployment({ ...imported("interrupted"), active: [{ ...key(), revision_id: "missing" }] })).rejects.toThrow();
    expect(await policies.deployment("interrupted")).toBeUndefined();
    const rows = await pool.query(`SELECT COUNT(*) AS n FROM "${schema}".control_policy_revisions WHERE deployment_id = $1`, ["interrupted"]);
    expect(Number(rows.rows[0].n)).toBe(0);
    expect(await policies.importDeployment(imported("interrupted"))).toBe("imported");
  });

  it("recognizes concurrent imports across both unique keys without admitting a second deployment", async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const input = imported(`race-${attempt}`);
      const results = await Promise.all(Array.from({ length: 4 }, () => repository().importDeployment(input)));
      expect(results.filter((result) => result === "imported")).toHaveLength(1);
      expect(results.filter((result) => result === "already_imported")).toHaveLength(3);
      const impostor = { ...input, deployment_id: `different-${attempt}` };
      await expect(repository().importDeployment(impostor)).rejects.toMatchObject({ code: "POLICY_MIGRATION_MISMATCH" });
      expect(await repository().deployment(impostor.deployment_id)).toBeUndefined();
      expect(await repository().active(input.deployment_id, key())).toEqual(revision("v1"));
    }
  });

  it("allows only one concurrent commit of an exact reviewed epoch", async () => {
    await repository().importDeployment(imported("concurrent"));
    const results = await Promise.allSettled(Array.from({ length: 4 }, (_, index) => repository().commit({
      deployment_id: "concurrent", expected_epoch: 1, revisions: [revision(`candidate-${index}`)],
      active: [{ ...key(), revision_id: `candidate-${index}` }], event: event(`review-${index}`),
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const result of results) if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "POLICY_REVISION_CONFLICT" });
    const rows = await pool.query(`SELECT COUNT(*) AS n FROM "${schema}".control_policy_events WHERE deployment_id = $1`, ["concurrent"]);
    expect(Number(rows.rows[0].n)).toBe(2);
  });

  it("saves drafts without activation and atomically promotes only the reviewed revision", async () => {
    const policies = repository(); await policies.importDeployment(imported("drafts"));
    const draft = revision("draft-v2", operator, { credits: { maximum: 12 } });
    await policies.commit({ deployment_id: "drafts", expected_epoch: 1, revisions: [draft], active: [],
      drafts: [{ ...key(), revision_id: draft.revision_id }], event: event("save-disabled") });
    expect(await policies.snapshot("drafts", [key()])).toEqual({ epoch: 2, policies: [{ active: revision("v1"), draft }] });
    expect(await policies.scopeSnapshot({ deployment_id: "drafts", scope: operator, kinds: ["read", "action"] }))
      .toEqual({ epoch: 2, active: [revision("v1")], drafts: [draft] });
    await expect(policies.scopeSnapshot({ deployment_id: "drafts", scope: operator, kinds: ["action"], limit: 1 }))
      .rejects.toMatchObject({ code: "POLICY_SNAPSHOT_TOO_LARGE" });
    await expect(policies.scopeSnapshot({ deployment_id: "drafts", scope: operator, kinds: ["action"], max_bytes: 1 }))
      .rejects.toMatchObject({ code: "POLICY_SNAPSHOT_TOO_LARGE" });
    expect(await policies.listDrafts({ deployment_id: "drafts", scope: operator, kind: "action" })).toEqual([draft]);
    await policies.commit({ deployment_id: "drafts", expected_epoch: 2, revisions: [],
      active: [{ ...key(), revision_id: draft.revision_id }], drafts: [{ ...key(), revision_id: null }], event: event("activate-reviewed") });
    expect(await policies.draft("drafts", key())).toBeUndefined();
    expect(await policies.scopeSnapshot({ deployment_id: "drafts", scope: operator, kinds: ["action"] }))
      .toEqual({ epoch: 3, active: [draft], drafts: [] });
    expect(await policies.active("drafts", key())).toEqual(draft);
    expect(await policies.history({ deployment_id: "drafts", key: key(), limit: 1 })).toEqual([{ epoch: 2, revision: draft }]);
    expect(await policies.history({ deployment_id: "drafts", key: key(), before: { epoch: 2, revision_id: draft.revision_id } }))
      .toEqual([{ epoch: 1, revision: revision("v1") }]);
  });

  it("separates identical principal names and rejects a pointer to a different owner's revision", async () => {
    const owner = (tenant: string): ControlPolicyScope => ({ level: "principal", tenant_id: tenant, principal: "maya" });
    const policies = repository();
    await policies.importDeployment(imported("owners", [revision("acme-v1", owner("acme")), revision("beta-v1", owner("beta"))]));
    expect(await policies.listActive({ deployment_id: "owners", scope: owner("acme"), kind: "action" })).toEqual([revision("acme-v1", owner("acme"))]);
    expect(await policies.revision("owners", key(owner("beta")), "acme-v1")).toBeUndefined();
    expect(await policies.active("different-deployment", key(owner("acme")))).toBeUndefined();
    await expect(policies.commit({ deployment_id: "owners", expected_epoch: 1, revisions: [], active: [{ ...key(owner("beta")), revision_id: "acme-v1" }], event: event("wrong-owner") })).rejects.toThrow();
    expect((await policies.deployment("owners"))?.epoch).toBe(1);
    expect(await policies.active("owners", key(owner("beta")))).toEqual(revision("beta-v1", owner("beta")));
  });

  it("retains immutable history, refuses replayed review events and detects corrupt content", async () => {
    const policies = repository(); await policies.importDeployment(imported("immutable"));
    await expect(policies.commit({ deployment_id: "immutable", expected_epoch: 1, revisions: [revision("v1", operator, { credits: 99 })], active: [], event: event("overwrite") })).rejects.toThrow();
    await expect(policies.commit({ deployment_id: "immutable", expected_epoch: 1, revisions: [revision("v2")], active: [], event: event("import") }))
      .rejects.toMatchObject({ code: "POLICY_EVENT_ALREADY_RECORDED" });
    expect(await policies.event("immutable", "import")).toEqual({ ...event("import"), epoch: 1 });
    expect(await policies.event("no-such-deployment", "import")).toBeUndefined();
    expect(await policies.event("immutable", "overwrite")).toBeUndefined();
    expect((await policies.deployment("immutable"))?.epoch).toBe(1);
    await policies.commit({ deployment_id: "immutable", expected_epoch: 1, revisions: [], active: [{ ...key(), revision_id: null }], event: event("revoke") });
    expect(await policies.active("immutable", key())).toBeUndefined();
    expect(await policies.revision("immutable", key(), "v1")).toEqual(revision("v1"));
    await pool.query(`UPDATE "${schema}".control_policy_revisions SET content_json = $1 WHERE deployment_id = $2`, ['{"credits":999}', "immutable"]);
    await expect(policies.revision("immutable", key(), "v1")).rejects.toMatchObject({ code: "POLICY_CONTENT_MISMATCH" });
  });
});
