import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createDefaultRuntimeStore, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest, canonicalJsonStringify } from "@synapsor-runner/protocol";
import { assertValidRunnerStorageConfig } from "@synapsor-runner/config";
import { createPostgresPool } from "@synapsor-runner/postgres";
import { sqliteControlPolicyRepository, postgresControlPolicyRepository,
  type ControlPolicyRepository, type ControlPolicyRevision, type ControlPolicyPointer, type ControlPolicyCommit,
  type ProposalRuntimeStore } from "@synapsor-runner/proposal-store";

const identifier = z.string().min(1).max(256).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value));
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sqlite"), path: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("postgres"), url_env: identifier, schema: identifier }).strict(),
]);
const scope = z.discriminatedUnion("level", [
  z.object({ level: z.literal("operator") }).strict(),
  z.object({ level: z.literal("tenant"), tenant_id: identifier }).strict(),
  z.object({ level: z.literal("principal"), tenant_id: identifier, principal: identifier }).strict(),
]);
const key = { scope, kind: z.enum(["read", "action", "execution", "parent", "delegation", "management"]), name: identifier };
const snapshotSchema = z.object({
  revisions: z.array(z.object({ ...key, revision_id: identifier, authority_digest: digest, content_digest: digest, content: z.unknown() }).strict()).max(64),
  active: z.array(z.object({ ...key, revision_id: identifier.nullable() }).strict()).max(64),
  drafts: z.array(z.object({ ...key, revision_id: identifier.nullable() }).strict()).max(64),
  provenance: z.array(z.object({ path: z.string().min(1).max(4096), digest }).strict()).max(256),
}).strict();
const manifestSchema = z.object({
  schema_version: z.literal("synapsor.control-policy-migration/v1"),
  repository_id: z.string().uuid(), deployment_id: z.string().uuid(), project_id: z.string().uuid(),
  target: targetSchema, migration_digest: digest,
  actor: identifier, created_at: z.string().datetime(),
}).strict();

export type ControlPolicyMigrationSnapshot = {
  revisions: ControlPolicyRevision[];
  active: ControlPolicyPointer[];
  drafts: ControlPolicyPointer[];
  provenance: { path: string; digest: string }[];
};
export type ProjectPolicyStoreSelection = {
  projectRoot: string;
  config: RuntimeConfig;
  storePath: string;
  env?: NodeJS.ProcessEnv;
};
export type BoundProjectPolicyStore = {
  repository: ControlPolicyRepository;
  deployment_id: string;
  repository_id: string;
  project_id: string;
  close(): Promise<void>;
};
type Manifest = z.infer<typeof manifestSchema>;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const MANIFEST_FILE = ".synapsor/control-policy/migration.json";

/** Only the trusted operator migration path may call this. Validation must use
 * the existing Read/Action/execution validators, including dependency checks.
 * The immutable manifest is a recovery input, never an active policy fallback. */
export async function migrateProjectControlPolicies(input: ProjectPolicyStoreSelection & {
  actor: string;
  readLegacySnapshot(): Promise<ControlPolicyMigrationSnapshot>;
  validateSnapshot(snapshot: ControlPolicyMigrationSnapshot): Promise<void>;
}): Promise<{ binding: BoundProjectPolicyStore; status: "imported" | "already_imported" }> {
  const target = selectedTarget(input);
  let manifest = await readManifest(input.projectRoot);
  if (manifest) assertSameTarget(manifest, target);
  // A bound missing local store is a recovery failure, never a new empty store.
  if (manifest) await requireExistingLocalStore(target);
  const store = createDefaultRuntimeStore(input.config, input.env ?? process.env, input.storePath);
  try {
    const repository = requireRepository(store);
    if (!manifest) {
      const snapshot = validateSnapshotShape(await input.readLegacySnapshot());
      await input.validateSnapshot(structuredClone(snapshot));
      const repositoryId = await repository.initialize();
      const proposed: Manifest = {
        schema_version: "synapsor.control-policy-migration/v1", repository_id: repositoryId,
        deployment_id: randomUUID(), project_id: randomUUID(), target,
        migration_digest: canonicalJsonDigest(snapshot), actor: identifier.parse(input.actor),
        created_at: new Date().toISOString(),
      };
      await installPrivateJsonExclusive(snapshotPath(input.projectRoot, proposed), snapshot, MAX_SNAPSHOT_BYTES);
      await installManifest(input.projectRoot, proposed);
      // An exclusive link chooses one complete manifest even across processes.
      manifest = await readManifest(input.projectRoot);
      if (!manifest) throw failure("POLICY_MIGRATION_MANIFEST_MISSING", "The policy migration record is missing. No legacy authority was changed.");
    }
    assertSameTarget(manifest, target);
    await assertRepositoryIdentity(repository, manifest);
    const existing = await repository.deployment(manifest.deployment_id);
    if (existing) {
      assertDeployment(existing, manifest);
      return { binding: bound(store, repository, manifest), status: "already_imported" };
    }
    // Revalidate the frozen input after interruption, not changed legacy files.
    const snapshot = await readSnapshot(input.projectRoot, manifest);
    await input.validateSnapshot(structuredClone(snapshot));
    const status = await repository.importDeployment({
      deployment_id: manifest.deployment_id, project_id: manifest.project_id,
      migration_digest: manifest.migration_digest,
      revisions: snapshot.revisions, active: snapshot.active, drafts: snapshot.drafts,
      event: {
        event_id: `migration:${manifest.deployment_id}`, actor: manifest.actor, occurred_at: manifest.created_at,
        receipt: { operation: "import_exact_policy_authority", migration_digest: manifest.migration_digest,
          source_artifacts: snapshot.provenance, source_database_changed: false, authority_added: false },
      },
    });
    return { binding: bound(store, repository, manifest), status };
  } catch (error) {
    await store.close();
    throw error;
  }
}

/** Does not initialize, migrate or consult policy exports. Undefined means the
 * project has never opted into repository authority; other failures fail closed. */
export async function openProjectControlPolicies(input: ProjectPolicyStoreSelection): Promise<BoundProjectPolicyStore | undefined> {
  const manifest = await readManifest(input.projectRoot);
  if (!manifest) return undefined;
  const target = selectedTarget(input);
  assertSameTarget(manifest, target);
  return openBoundRepository(manifest, input.env ?? process.env);
}

/** Check an established deployment before a ledger constructor can create a
 * new local file. The returned store, not a second policy connection, is owned
 * by the calling runtime. No migration or activation is performed here. */
export async function createProjectRuntimeStore(input: ProjectPolicyStoreSelection): Promise<ProposalRuntimeStore> {
  assertValidRunnerStorageConfig(input.config.storage);
  const manifest = await readManifest(input.projectRoot);
  if (manifest) {
    assertSameTarget(manifest, selectedTarget(input));
    await requireExistingLocalStore(manifest.target);
  }
  const store = createDefaultRuntimeStore(input.config, input.env ?? process.env, input.storePath);
  try {
    await bindRuntimeControlPolicies({ ...input, store });
    return store;
  } catch (error) {
    await store.close();
    throw error;
  }
}

/** Existing project-authority access follows its governed locator. Runtime
 * composition must separately bind its actual store before serving requests. */
export async function openBoundProjectControlPolicies(projectRoot: string, env: NodeJS.ProcessEnv = process.env): Promise<BoundProjectPolicyStore | undefined> {
  const manifest = await readManifest(projectRoot);
  return manifest ? openBoundRepository(manifest, env) : undefined;
}

async function openBoundRepository(manifest: Manifest, env: NodeJS.ProcessEnv): Promise<BoundProjectPolicyStore> {
  const target = manifest.target;
  await requireExistingLocalStore(target);
  const store = openExistingRepository(target, env);
  try {
    const repository = requireRepository(store);
    await assertRepositoryIdentity(repository, manifest);
    const deployment = await repository.deployment(manifest.deployment_id);
    if (!deployment) throw failure("POLICY_MIGRATION_PENDING", "Policy migration is unfinished. Resume the same migration; legacy exports cannot serve authority.");
    assertDeployment(deployment, manifest);
    return bound(store, repository, manifest);
  } catch (error) {
    await store.close();
    throw error;
  }
}

/** A long-lived runtime uses its actual selected ledger connection. The caller
 * owns that connection; closing this binding never closes the runtime store. */
export async function bindRuntimeControlPolicies(input: ProjectPolicyStoreSelection & {
  store: ProposalRuntimeStore;
}): Promise<BoundProjectPolicyStore | undefined> {
  const manifest = await readManifest(input.projectRoot);
  if (!manifest) return undefined;
  const target = selectedTarget(input);
  assertSameTarget(manifest, target);
  return borrowBoundRepository(manifest, input.store);
}

/** Runtime constructors receive the actual ledger, not another connection
 * opened from a policy locator. Config-aware composition also checks selection
 * with bindRuntimeControlPolicies; both routes verify repository identity. */
export async function borrowRuntimeControlPolicies(projectRoot: string,
  store: ProposalRuntimeStore): Promise<BoundProjectPolicyStore | undefined> {
  const manifest = await readManifest(projectRoot);
  return manifest ? borrowBoundRepository(manifest, store) : undefined;
}

async function borrowBoundRepository(manifest: Manifest, store: ProposalRuntimeStore): Promise<BoundProjectPolicyStore> {
  await requireExistingLocalStore(manifest.target);
  const repository = requireRepository(store);
  await assertRepositoryIdentity(repository, manifest);
  if (manifest.target.kind === "sqlite" && "path" in store && typeof store.path === "string"
    && (store.path === ":memory:" || path.resolve(store.path) !== manifest.target.path)) {
    throw failure("POLICY_STORE_SELECTION_CHANGED", "The runtime ledger is not this project's configured policy store.");
  }
  const deployment = await repository.deployment(manifest.deployment_id);
  if (!deployment) throw failure("POLICY_MIGRATION_PENDING", "Policy migration is unfinished. Resume the same migration; legacy exports cannot serve authority.");
  assertDeployment(deployment, manifest);
  return bound({ close: async () => undefined }, repository, manifest);
}

export async function assertProjectControlPolicyBinding(projectRoot: string, binding: BoundProjectPolicyStore): Promise<void> {
  const manifest = await readManifest(projectRoot);
  if (!manifest || binding.repository_id !== manifest.repository_id || binding.deployment_id !== manifest.deployment_id
    || binding.project_id !== manifest.project_id) {
    throw failure("POLICY_REPOSITORY_MISMATCH", "The policy connection does not match this project's governed repository.");
  }
  await requireExistingLocalStore(manifest.target);
  await assertRepositoryIdentity(binding.repository, manifest);
}

/** Internal persistence after semantic validation and trusted review. Reusing
 * an exact historical record moves a pointer; it never overwrites history. */
export async function commitImmutableControlPolicies(binding: BoundProjectPolicyStore,
  input: Omit<ControlPolicyCommit, "deployment_id">): Promise<number> {
  const frozen = structuredClone(input);
  if (frozen.revisions.length > 64) throw failure("POLICY_BATCH_TOO_LARGE", "The policy update exceeds the reviewed transaction limit.");
  const revisions: ControlPolicyRevision[] = [];
  const seen = new Set<string>();
  for (const revision of frozen.revisions) {
    if (seen.has(revision.revision_id)) throw failure("POLICY_DUPLICATE_REVISION", "The policy update contains duplicate revision identities.");
    seen.add(revision.revision_id);
    const existing = await binding.repository.revision(binding.deployment_id, revision, revision.revision_id);
    if (!existing) revisions.push(revision);
    else if (canonicalJsonDigest(existing) !== canonicalJsonDigest(revision)) {
      throw failure("POLICY_CONTENT_MISMATCH", "The saved immutable revision differs from the reviewed policy. No authority changed.");
    }
  }
  return binding.repository.commit({ ...frozen, deployment_id: binding.deployment_id, revisions });
}

function openExistingRepository(target: Manifest["target"], env: NodeJS.ProcessEnv): {
  controlPolicies: ControlPolicyRepository; close(): Promise<void>;
} {
  if (target.kind === "postgres") {
    const url = env[target.url_env]?.trim();
    if (!url) throw failure("POSTGRES_RUNTIME_STORE_URL_MISSING", `${target.url_env} is required for this project's bound control store.`);
    const pool = createPostgresPool(url);
    return { controlPolicies: postgresControlPolicyRepository(pool, target.schema), close: () => pool.end() };
  }
  const db = new DatabaseSync(target.path);
  try {
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000");
    return { controlPolicies: sqliteControlPolicyRepository(db), close: async () => { db.close(); } };
  } catch (error) { db.close(); throw error; }
}

function selectedTarget(input: ProjectPolicyStoreSelection): Manifest["target"] {
  const shared = input.config.storage?.shared_postgres;
  if (shared?.mode === "runtime_store") return targetSchema.parse({ kind: "postgres", url_env: shared.url_env, schema: shared.schema ?? "synapsor_runner" });
  if (input.storePath === ":memory:") throw failure("POLICY_STORE_MUST_PERSIST", "Policy authority requires a persistent control store.");
  return { kind: "sqlite", path: path.resolve(input.storePath) };
}

function requireRepository(store: { controlPolicies?: ControlPolicyRepository }): ControlPolicyRepository {
  if (!store.controlPolicies) throw failure("POLICY_STORE_UNSUPPORTED", "The selected runtime store does not support authoritative policy storage.");
  return store.controlPolicies;
}

async function requireExistingLocalStore(target: Manifest["target"]): Promise<void> {
  if (target.kind !== "sqlite") return;
  const stat = await fs.stat(target.path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat?.isFile()) throw failure("POLICY_REPOSITORY_UNAVAILABLE", "The bound policy control store is missing. Restore that store; Runner will not recreate it or use older exports.");
}

function assertSameTarget(manifest: Manifest, target: Manifest["target"]): void {
  if (canonicalJsonDigest(manifest.target) !== canonicalJsonDigest(target)) {
    throw failure("POLICY_STORE_SELECTION_CHANGED", "This project is bound to a different control-store selection. Review a store migration instead of using a shadow authority store.");
  }
}

async function assertRepositoryIdentity(repository: ControlPolicyRepository, manifest: Manifest): Promise<void> {
  let actual: string;
  try { actual = await repository.identity(); }
  catch { throw failure("POLICY_REPOSITORY_UNAVAILABLE", "The bound policy repository could not be read. No legacy authority fallback is permitted."); }
  if (actual !== manifest.repository_id) throw failure("POLICY_REPOSITORY_MISMATCH", "The selected control store is not the repository bound to this project.");
}

function assertDeployment(deployment: { project_id: string; migration_digest: string }, manifest: Manifest): void {
  if (deployment.project_id !== manifest.project_id || deployment.migration_digest !== manifest.migration_digest) {
    throw failure("POLICY_MIGRATION_MISMATCH", "The policy repository does not match this project's reviewed migration record.");
  }
}

function bound(store: { close(): void | Promise<void> }, repository: ControlPolicyRepository, manifest: Manifest): BoundProjectPolicyStore {
  let closed = false;
  return { repository, deployment_id: manifest.deployment_id, repository_id: manifest.repository_id,
    project_id: manifest.project_id, close: async () => { if (!closed) { closed = true; await store.close(); } } };
}

function validateSnapshotShape(value: unknown): ControlPolicyMigrationSnapshot {
  const snapshot = snapshotSchema.parse(value);
  for (const revision of snapshot.revisions) {
    if (canonicalJsonDigest(revision.content) !== revision.content_digest) throw failure("POLICY_CONTENT_MISMATCH", "A migration revision failed its content check.");
  }
  return snapshot as ControlPolicyMigrationSnapshot;
}

async function readManifest(projectRoot: string): Promise<Manifest | undefined> {
  const value = await readPrivateJson(path.join(path.resolve(projectRoot), MANIFEST_FILE), MAX_MANIFEST_BYTES);
  if (value === undefined) {
    const directory = path.dirname(path.join(path.resolve(projectRoot), MANIFEST_FILE));
    const artifacts = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    if (artifacts.some((file) => file.endsWith(".snapshot.json"))) {
      throw failure("POLICY_MIGRATION_MANIFEST_MISSING", "Policy migration input exists but its binding is missing. Restore the migration record; older file authority cannot be used.");
    }
    return undefined;
  }
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw failure("POLICY_MIGRATION_RECORD_INVALID", "The policy migration record is invalid. Restore the original record; no older authority will be used.");
  return parsed.data;
}

function snapshotPath(projectRoot: string, manifest: Manifest): string {
  return path.join(path.resolve(projectRoot), ".synapsor/control-policy", `${manifest.migration_digest.slice("sha256:".length)}.snapshot.json`);
}

async function readSnapshot(projectRoot: string, manifest: Manifest): Promise<ControlPolicyMigrationSnapshot> {
  const value = await readPrivateJson(snapshotPath(projectRoot, manifest), MAX_SNAPSHOT_BYTES);
  if (value === undefined || canonicalJsonDigest(value) !== manifest.migration_digest) {
    throw failure("POLICY_MIGRATION_SNAPSHOT_INVALID", "The frozen migration input is missing or changed. Restore that input before resuming migration.");
  }
  return validateSnapshotShape(value);
}

async function readPrivateJson(file: string, maximum: number): Promise<unknown> {
  const handle = await fs.open(file, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return undefined;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum) throw new Error("Invalid migration record size.");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > stat.size) throw new Error("Migration record changed during read.");
    return JSON.parse(bytes.subarray(0, length).toString("utf8")) as unknown;
  } catch {
    throw failure("POLICY_MIGRATION_RECORD_INVALID", "The policy migration record is invalid. Restore the original record; no older authority will be used.");
  } finally { await handle.close(); }
}

async function installManifest(projectRoot: string, manifest: Manifest): Promise<void> {
  await installPrivateJsonExclusive(path.join(path.resolve(projectRoot), MANIFEST_FILE), manifest, MAX_MANIFEST_BYTES);
}

async function installPrivateJsonExclusive(file: string, value: unknown, maximum: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const text = canonicalJsonStringify(value);
  if (Buffer.byteLength(text) > maximum) throw failure("POLICY_MIGRATION_TOO_LARGE", "The migration exceeds the reviewed policy storage limit.");
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
    await handle.close();
    await fs.link(temporary, file).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
  }
}

function failure(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
