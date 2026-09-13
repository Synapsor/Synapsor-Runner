import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { withProjectRuntimeAdmission } from "./project-runtime-admission.js";
import { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { ControlPolicyRepository, ProposalStore } from "@synapsor-runner/proposal-store";
import { migrateProjectControlPolicies, openProjectControlPolicies, bindRuntimeControlPolicies, createProjectRuntimeStore, type BoundProjectPolicyStore,
  type ControlPolicyMigrationSnapshot, type ProjectPolicyStoreSelection } from "./control-policy-store.js";

const roots: string[] = [];
const bindings: BoundProjectPolicyStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const binding of bindings.splice(0)) await binding.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
const key = { scope: { level: "operator" as const }, kind: "action" as const, name: "inventory.replenish" };
const reviewed = { quantity: { min: 1, max: 20 }, reviewer: "inventory_owner", source_write: false };
const snapshot = (): ControlPolicyMigrationSnapshot => ({
  revisions: [
    { ...key, revision_id: "active-v1", authority_digest: canonicalJsonDigest(reviewed), content_digest: canonicalJsonDigest({ reviewed, actor: "original-operator" }), content: { reviewed, actor: "original-operator" } },
    { ...key, revision_id: "disabled-v2", authority_digest: canonicalJsonDigest({ ...reviewed, max: 12 }), content_digest: canonicalJsonDigest({ ...reviewed, max: 12 }), content: { ...reviewed, max: 12 } },
  ],
  active: [{ ...key, revision_id: "active-v1" }], drafts: [{ ...key, revision_id: "disabled-v2" }],
  provenance: [{ path: ".synapsor/example-legacy-authority.json", digest: canonicalJsonDigest(reviewed) }],
});
async function fixture(): Promise<ProjectPolicyStoreSelection> {
  const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-policy-migration-")); roots.push(projectRoot);
  return { projectRoot, storePath: path.join(projectRoot, ".synapsor/control.db"), config: {} as RuntimeConfig, env: {} };
}
const track = (binding: BoundProjectPolicyStore) => { bindings.push(binding); return binding; };
function migration(selection: ProjectPolicyStoreSelection) {
  return { ...selection, actor: "authenticated-operator", readLegacySnapshot: vi.fn(async () => snapshot()),
    validateSnapshot: vi.fn(async (candidate: ControlPolicyMigrationSnapshot) => {
      expect(candidate).toEqual(snapshot());
    }) };
}
const manifestPath = (selection: ProjectPolicyStoreSelection) => path.join(selection.projectRoot, ".synapsor/control-policy/migration.json");

describe("governed policy-store binding and recovery", () => {
  it("drains runtime work before reading the migration snapshot or installing its locator", async () => {
    const selection = await fixture(), input = migration(selection);
    let pending!: ReturnType<typeof migrateProjectControlPolicies>;
    await withProjectRuntimeAdmission(selection.projectRoot, async () => {
      pending = migrateProjectControlPolicies(input);
      await delay(80);
      expect(input.readLegacySnapshot).not.toHaveBeenCalled();
      await expect(fs.stat(manifestPath(selection))).rejects.toHaveProperty("code", "ENOENT");
    });
    const result = await pending; track(result.binding);
    expect(result.status).toBe("imported");
    expect(input.readLegacySnapshot).toHaveBeenCalledOnce();
    expect(await result.binding.repository.active(result.binding.deployment_id, key)).toEqual(snapshot().revisions[0]);
  });

  it("does not initialize authority from a read or accept an ephemeral store", async () => {
    const selection = await fixture();
    expect(await openProjectControlPolicies(selection)).toBeUndefined();
    await expect(fs.stat(selection.storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(migrateProjectControlPolicies({ ...migration(selection), storePath: ":memory:" })).rejects.toMatchObject({ code: "POLICY_STORE_MUST_PERSIST" });
  });

  it("imports exact active and disabled revisions without changing their provenance", async () => {
    const selection = await fixture(); const input = migration(selection);
    const result = await migrateProjectControlPolicies(input); const binding = track(result.binding);
    expect(result.status).toBe("imported");
    expect(input.validateSnapshot).toHaveBeenCalledTimes(2);
    expect(await binding.repository.snapshot(binding.deployment_id, [key])).toEqual({ epoch: 1,
      policies: [{ active: snapshot().revisions[0], draft: snapshot().revisions[1] }] });
    const manifest = JSON.parse(await fs.readFile(manifestPath(selection), "utf8"));
    expect(manifest).not.toHaveProperty("snapshot");
    expect((await fs.stat(manifestPath(selection))).size).toBeLessThan(2048);
    expect((await fs.stat(manifestPath(selection))).mode & 0o077).toBe(0);
    await binding.close();
    const reopened = track((await openProjectControlPolicies(selection))!);
    expect(reopened.repository_id).toBe(binding.repository_id);
    expect(await reopened.repository.active(reopened.deployment_id, key)).toEqual(snapshot().revisions[0]);
  });

  it("opens current policies without rerunning ledger migrations and can borrow the actual runtime store", async () => {
    const selection = await fixture(); const imported = track((await migrateProjectControlPolicies(migration(selection))).binding);
    await imported.close();
    const runtime = new ProposalStore(selection.storePath);
    const migrate = vi.spyOn(ProposalStore.prototype, "migrate").mockImplementation(() => { throw new Error("must not rerun ledger migrations"); });
    try {
      const opened = track((await openProjectControlPolicies(selection))!);
      const borrowed = track((await bindRuntimeControlPolicies({ ...selection, store: runtime }))!);
      expect(borrowed.repository).toBe(runtime.controlPolicies);
      expect(borrowed.repository_id).toBe(opened.repository_id);
      await borrowed.close();
      expect(await runtime.controlPolicies.active(borrowed.deployment_id, key)).toEqual(snapshot().revisions[0]);
      expect(migrate).not.toHaveBeenCalled();
    } finally { migrate.mockRestore(); runtime.close(); }
  });

  it("refuses a borrowed runtime connected to a different repository", async () => {
    const selection = await fixture(); track((await migrateProjectControlPolicies(migration(selection))).binding);
    const different = new ProposalStore(":memory:"); await different.controlPolicies.initialize();
    try {
      await expect(bindRuntimeControlPolicies({ ...selection, store: different })).rejects.toMatchObject({ code: "POLICY_REPOSITORY_MISMATCH" });
      expect(await different.controlPolicies.identity()).toBeTruthy();
    } finally { different.close(); }
  });

  it("refuses a changed or missing store before runtime creation can leave an empty shadow file", async () => {
    const selection = await fixture(); const binding = track((await migrateProjectControlPolicies(migration(selection))).binding);
    await binding.close();
    const shadow = path.join(selection.projectRoot, "must-not-create.db");
    await expect(createProjectRuntimeStore({ ...selection, storePath: shadow })).rejects.toMatchObject({ code: "POLICY_STORE_SELECTION_CHANGED" });
    await expect(fs.stat(shadow)).rejects.toMatchObject({ code: "ENOENT" });
    const runtime = await createProjectRuntimeStore(selection);
    expect(await runtime.controlPolicies!.identity()).toBe(binding.repository_id);
    await runtime.close();
    await fs.rename(selection.storePath, `${selection.storePath}.saved`);
    await expect(createProjectRuntimeStore(selection)).rejects.toMatchObject({ code: "POLICY_REPOSITORY_UNAVAILABLE" });
    await expect(fs.stat(selection.storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("validates only the required store selection before constructing an authoring ledger", async () => {
    const selection = await fixture();
    await expect(createProjectRuntimeStore({ ...selection, config: { storage: { shared_postgres: {
      mode: "runtime_store", schema: "invalid.schema", url_env: "CONTROL_URL",
    } } } as RuntimeConfig })).rejects.toThrow("INVALID_SHARED_POSTGRES_SCHEMA");
    await expect(fs.stat(selection.storePath)).rejects.toMatchObject({ code: "ENOENT" });
    const runtime = await createProjectRuntimeStore({ ...selection, config: { storage: { sqlite_path: selection.storePath } } as RuntimeConfig });
    await runtime.close();
  });

  it("resumes a frozen pending import rather than rereading changed legacy files", async () => {
    const selection = await fixture(); const input = migration(selection);
    const original = ControlPolicyRepository.prototype.importDeployment;
    const spy = vi.spyOn(ControlPolicyRepository.prototype, "importDeployment").mockRejectedValueOnce(new Error("simulated process interruption before import"));
    await expect(migrateProjectControlPolicies(input)).rejects.toThrow("simulated process interruption");
    await expect(openProjectControlPolicies(selection)).rejects.toMatchObject({ code: "POLICY_MIGRATION_PENDING" });
    spy.mockImplementation(original);
    input.readLegacySnapshot.mockRejectedValue(new Error("must not reread legacy authority"));
    const result = await migrateProjectControlPolicies(input); const binding = track(result.binding);
    expect(input.readLegacySnapshot).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("imported");
    expect(await binding.repository.active(binding.deployment_id, key)).toEqual(snapshot().revisions[0]);
  });

  it("recovers an import committed before the process lost its response without replaying it", async () => {
    const selection = await fixture(); const input = migration(selection);
    const original = ControlPolicyRepository.prototype.importDeployment;
    const spy = vi.spyOn(ControlPolicyRepository.prototype, "importDeployment").mockImplementationOnce(async function (this: ControlPolicyRepository, value) {
      await original.call(this, value);
      throw new Error("simulated interruption after database commit");
    });
    await expect(migrateProjectControlPolicies(input)).rejects.toThrow("after database commit");
    spy.mockImplementation(original);
    const reopened = track((await openProjectControlPolicies(selection))!);
    await reopened.repository.commit({ deployment_id: reopened.deployment_id, expected_epoch: 1, revisions: [],
      active: [{ ...key, revision_id: null }], event: { event_id: "later-revocation", actor: "operator", occurred_at: "2026-09-06T00:00:00.000Z", receipt: { reason: "explicit revoke" } } });
    const resumed = await migrateProjectControlPolicies(input); const binding = track(resumed.binding);
    expect(resumed.status).toBe("already_imported");
    expect(await binding.repository.active(binding.deployment_id, key)).toBeUndefined();
    expect((await binding.repository.deployment(binding.deployment_id))?.epoch).toBe(2);
    expect(input.readLegacySnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not load or trust the snapshot export after repository authority is established", async () => {
    const selection = await fixture(); const input = migration(selection);
    const binding = track((await migrateProjectControlPolicies(input)).binding); await binding.close();
    const root = path.dirname(manifestPath(selection));
    const exportName = (await fs.readdir(root)).find((name) => name.endsWith(".snapshot.json"))!;
    await fs.writeFile(path.join(root, exportName), '{"authority":"unrestricted"}');
    const reopened = track((await openProjectControlPolicies(selection))!);
    expect(await reopened.repository.active(reopened.deployment_id, key)).toEqual(snapshot().revisions[0]);
    const resumed = await migrateProjectControlPolicies(input); track(resumed.binding);
    expect(resumed.status).toBe("already_imported");
    expect(input.readLegacySnapshot).toHaveBeenCalledTimes(1);
  });

  it("refuses tampered pending input before importing any authority", async () => {
    const selection = await fixture(); const input = migration(selection);
    const spy = vi.spyOn(ControlPolicyRepository.prototype, "importDeployment").mockRejectedValueOnce(new Error("stop before commit"));
    await expect(migrateProjectControlPolicies(input)).rejects.toThrow("stop before commit"); spy.mockRestore();
    const root = path.dirname(manifestPath(selection));
    const exportName = (await fs.readdir(root)).find((name) => name.endsWith(".snapshot.json"))!;
    await fs.writeFile(path.join(root, exportName), JSON.stringify({ ...snapshot(), active: [] }));
    await expect(migrateProjectControlPolicies(input)).rejects.toMatchObject({ code: "POLICY_MIGRATION_SNAPSHOT_INVALID" });
    await expect(openProjectControlPolicies(selection)).rejects.toMatchObject({ code: "POLICY_MIGRATION_PENDING" });
  });

  it("does not create a shadow control store when the selection changes", async () => {
    const selection = await fixture(); track((await migrateProjectControlPolicies(migration(selection))).binding);
    const different = { ...selection, storePath: path.join(selection.projectRoot, "shadow.db") };
    await expect(openProjectControlPolicies(different)).rejects.toMatchObject({ code: "POLICY_STORE_SELECTION_CHANGED" });
    await expect(migrateProjectControlPolicies(migration(different))).rejects.toMatchObject({ code: "POLICY_STORE_SELECTION_CHANGED" });
    await expect(fs.stat(different.storePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed for a missing or replaced bound repository", async () => {
    const selection = await fixture(); const binding = track((await migrateProjectControlPolicies(migration(selection))).binding); await binding.close();
    await fs.rename(selection.storePath, `${selection.storePath}.preserved`);
    await expect(openProjectControlPolicies(selection)).rejects.toMatchObject({ code: "POLICY_REPOSITORY_UNAVAILABLE" });
    await expect(migrateProjectControlPolicies(migration(selection))).rejects.toMatchObject({ code: "POLICY_REPOSITORY_UNAVAILABLE" });
    await expect(fs.stat(selection.storePath)).rejects.toMatchObject({ code: "ENOENT" });
    const replacement = new ProposalStore(selection.storePath);
    await replacement.controlPolicies.initialize(); replacement.close();
    await expect(openProjectControlPolicies(selection)).rejects.toMatchObject({ code: "POLICY_REPOSITORY_MISMATCH" });
  });

  it("never falls back to file authority if the migration binding disappears", async () => {
    const selection = await fixture(); const input = migration(selection);
    const binding = track((await migrateProjectControlPolicies(input)).binding); await binding.close();
    const original = await fs.readFile(manifestPath(selection), "utf8");
    await fs.rm(manifestPath(selection));
    await expect(openProjectControlPolicies(selection)).rejects.toMatchObject({ code: "POLICY_MIGRATION_MANIFEST_MISSING" });
    await expect(migrateProjectControlPolicies(input)).rejects.toMatchObject({ code: "POLICY_MIGRATION_MANIFEST_MISSING" });
    expect(input.readLegacySnapshot).toHaveBeenCalledTimes(1);
    await fs.writeFile(manifestPath(selection), original, { mode: 0o600 });
    const restored = track((await openProjectControlPolicies(selection))!);
    expect(await restored.repository.active(restored.deployment_id, key)).toEqual(snapshot().revisions[0]);
  });

  it("rejects unvalidated input before creating a binding or initializing policy tables", async () => {
    const selection = await fixture(); const input = migration(selection);
    input.validateSnapshot.mockRejectedValue(new Error("existing authority validator refused the candidate"));
    await expect(migrateProjectControlPolicies(input)).rejects.toThrow("validator refused");
    await expect(fs.stat(manifestPath(selection))).rejects.toMatchObject({ code: "ENOENT" });
    const raw = new ProposalStore(selection.storePath);
    try { expect(raw.db.prepare("SELECT name FROM sqlite_master WHERE name = 'control_policy_identity'").get()).toBeUndefined(); }
    finally { raw.close(); }
  });

  it("chooses one complete binding during concurrent migration", async () => {
    const selection = await fixture();
    // This is migration of an existing application ledger. Keep one-time SQLite
    // schema DDL outside the completing cutover schedule: on a loaded disk it can
    // legitimately exceed the gate's five-second busy bound. Both imports below
    // still compete for the same uninitialized policy binding and exact snapshot.
    const ledger = new ProposalStore(selection.storePath);
    ledger.close();
    const first = migration(selection), second = migration(selection);
    const results = await Promise.all([migrateProjectControlPolicies(first), migrateProjectControlPolicies(second)]);
    results.forEach((result) => track(result.binding));
    expect(new Set(results.map((result) => result.binding.deployment_id)).size).toBe(1);
    expect(new Set(results.map((result) => result.binding.repository_id)).size).toBe(1);
    expect(results.map((result) => result.status).sort()).toEqual(["already_imported", "imported"]);
    expect((await results[0]!.binding.repository.deployment(results[0]!.binding.deployment_id))?.epoch).toBe(1);
    // Only the winning migration reads legacy input. Its competitor must wait
    // for the complete import, then use the same immutable binding.
    expect(first.readLegacySnapshot.mock.calls.length + second.readLegacySnapshot.mock.calls.length).toBe(1);
  });

  it("returns bounded busy when another migration really remains inside the cutover gate", async () => {
    const selection = await fixture();
    const ledger = new ProposalStore(selection.storePath); ledger.close();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>(resolve => {entered = resolve;});
    const held = new Promise<void>(resolve => {release = resolve;});
    const first = migration(selection), second = migration(selection);
    first.readLegacySnapshot.mockImplementation(async () => {entered(); await held; return snapshot();});
    const winner = migrateProjectControlPolicies(first);
    void winner.catch(() => undefined);
    let completed: Awaited<typeof winner> | undefined;
    try {
      await Promise.race([ready, winner.then(() => {throw new Error("Migration completed without entering the held snapshot");})]);
      const started = performance.now();
      await expect(migrateProjectControlPolicies(second)).rejects.toMatchObject({code: "POLICY_RUNTIME_BUSY"});
      expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
      expect(performance.now() - started).toBeLessThan(7500);
      expect(second.readLegacySnapshot).not.toHaveBeenCalled();
      expect(first.readLegacySnapshot).toHaveBeenCalledOnce();
    } finally {release(); completed = await winner; track(completed.binding);}
    expect(completed.status).toBe("imported");
    expect((await completed.binding.repository.deployment(completed.binding.deployment_id))?.epoch).toBe(1);
  });

  it("binds migration files, local store and the snapshot reader to the locked canonical project", async () => {
    const selection = await fixture(), other = await fixture(), links = await fixture();
    const alias = path.join(links.projectRoot, "current");
    await fs.symlink(selection.projectRoot, alias, "dir");
    const original = fs.lstat.bind(fs);
    let retargeted = false;
    vi.spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
      if (!retargeted && args[0] === path.join(selection.projectRoot, ".synapsor/exploration-boundaries.active.lock")) {
        retargeted = true; await fs.unlink(alias); await fs.symlink(other.projectRoot, alias, "dir");
      }
      return original(...args);
    }) as typeof fs.lstat);
    const input = { ...migration(selection), projectRoot: alias, storePath: path.join(alias, ".synapsor/control.db") };
    track((await migrateProjectControlPolicies(input)).binding);
    expect(input.readLegacySnapshot).toHaveBeenCalledWith(selection.projectRoot);
    expect(await fs.stat(selection.storePath)).toBeDefined();
    expect(await fs.stat(manifestPath(selection))).toBeDefined();
    await expect(fs.stat(other.storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(manifestPath(other))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

const databaseUrl = process.env.SYNAPSOR_TEST_POSTGRES_URL;
(databaseUrl ? it : it.skip)("uses the configured PostgreSQL repository, not a local authority mirror", async () => {
  const selection = await fixture();
  const schema = `synapsor_binding_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 2000 });
  selection.config = { storage: { shared_postgres: { mode: "runtime_store", url_env: "TEST_POLICY_URL", schema } } } as RuntimeConfig;
  selection.env = { TEST_POLICY_URL: databaseUrl };
  const opened: BoundProjectPolicyStore[] = [];
  try {
    const first = await migrateProjectControlPolicies(migration(selection)); opened.push(first.binding);
    expect(first.status).toBe("imported");
    await expect(fs.stat(selection.storePath)).rejects.toMatchObject({ code: "ENOENT" });
    const result = await admin.query(`SELECT authority_digest FROM "${schema}".control_policy_revisions ORDER BY revision_id`);
    expect(result.rows.map((row) => row.authority_digest).sort()).toEqual(snapshot().revisions.map((revision) => revision.authority_digest).sort());
    await first.binding.close();
    const next = (await openProjectControlPolicies(selection))!; opened.push(next);
    expect(next.repository_id).toBe(first.binding.repository_id);
    expect(await next.repository.draft(next.deployment_id, key)).toEqual(snapshot().revisions[1]);
    const again = await migrateProjectControlPolicies(migration(selection)); opened.push(again.binding);
    expect(again.status).toBe("already_imported");
    await expect(openProjectControlPolicies({ ...selection, env: {} })).rejects.toMatchObject({ code: "POSTGRES_RUNTIME_STORE_URL_MISSING" });
  } finally {
    for (const binding of opened) await binding.close();
    try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await admin.end(); }
  }
});
