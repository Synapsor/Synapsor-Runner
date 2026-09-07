import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { canonicalJsonDigest, canonicalJsonStringify } from "@synapsor-runner/protocol";
import type { PostgresRuntimePool } from "./postgres-runtime-types.js";
import { ProposalStoreError } from "./errors.js";

export type ControlPolicyScope =
  | { level: "operator" }
  | { level: "tenant"; tenant_id: string }
  | { level: "principal"; tenant_id: string; principal: string };
export type ControlPolicyKind = "read" | "action" | "execution" | "parent" | "delegation" | "management";
export type ControlPolicyKey = { scope: ControlPolicyScope; kind: ControlPolicyKind; name: string };
export type ControlPolicyRevision = ControlPolicyKey & {
  revision_id: string;
  authority_digest: string;
  content: unknown;
  content_digest: string;
};
export type ControlPolicyPointer = ControlPolicyKey & { revision_id: string | null };
export type ControlPolicyScopeSnapshot = {
  epoch: number;
  active: ControlPolicyRevision[];
  drafts: ControlPolicyRevision[];
};
export type ControlPolicyEvent = {
  event_id: string;
  actor: string;
  occurred_at: string;
  receipt: unknown;
};
export type ControlPolicyCommit = {
  deployment_id: string; expected_epoch: number;
  revisions: ControlPolicyRevision[]; active: ControlPolicyPointer[];
  drafts?: ControlPolicyPointer[]; event: ControlPolicyEvent;
};

type Row = Record<string, unknown>;
type Statement = { sql: string; values?: SQLInputValue[]; check?: (rows: Row[]) => void };
type PolicyConnection = {
  table(name: string): string;
  collation: string;
  byteLength(expression: string): string;
  execute(statements: Statement[], mode?: "read" | "write" | "migration"): Promise<Row[][]>;
};

/** Storage only, not an owner-facing authorization API. Its caller must validate
 * policy semantics and authenticate management rights before obtaining a scope.
 * Both backends execute the same bounded statement batches atomically. */
export class ControlPolicyRepository {
  constructor(private readonly connection: PolicyConnection) {}

  async initialize(): Promise<string> {
    const t = (name: string) => this.connection.table(name);
    const rows = await this.connection.execute([
      { sql: `CREATE TABLE IF NOT EXISTS ${t("identity")} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), repository_id TEXT NOT NULL)` },
      { sql: `CREATE TABLE IF NOT EXISTS ${t("deployments")} (
          deployment_id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE,
          epoch BIGINT NOT NULL CHECK (epoch >= 0), migration_digest TEXT NOT NULL)` },
      { sql: `CREATE TABLE IF NOT EXISTS ${t("revisions")} (
          deployment_id TEXT NOT NULL, scope_key TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
          revision_id TEXT NOT NULL, epoch BIGINT NOT NULL, authority_digest TEXT NOT NULL, content_digest TEXT NOT NULL, content_json TEXT NOT NULL,
          PRIMARY KEY (deployment_id, revision_id),
          UNIQUE (deployment_id, scope_key, kind, name, revision_id),
          FOREIGN KEY (deployment_id) REFERENCES ${t("deployments")}(deployment_id))` },
      { sql: `CREATE TABLE IF NOT EXISTS ${t("active")} (
          deployment_id TEXT NOT NULL, scope_key TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, revision_id TEXT,
          PRIMARY KEY (deployment_id, scope_key, kind, name),
          FOREIGN KEY (deployment_id) REFERENCES ${t("deployments")}(deployment_id),
          FOREIGN KEY (deployment_id, scope_key, kind, name, revision_id)
            REFERENCES ${t("revisions")}(deployment_id, scope_key, kind, name, revision_id))` },
      { sql: `CREATE TABLE IF NOT EXISTS ${t("drafts")} (
          deployment_id TEXT NOT NULL, scope_key TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, revision_id TEXT,
          PRIMARY KEY (deployment_id, scope_key, kind, name),
          FOREIGN KEY (deployment_id) REFERENCES ${t("deployments")}(deployment_id),
          FOREIGN KEY (deployment_id, scope_key, kind, name, revision_id)
            REFERENCES ${t("revisions")}(deployment_id, scope_key, kind, name, revision_id))` },
      { sql: `CREATE INDEX IF NOT EXISTS control_policy_revision_history ON ${t("revisions")}
          (deployment_id, scope_key, kind, name, epoch, revision_id)` },
      { sql: `CREATE TABLE IF NOT EXISTS ${t("events")} (
          deployment_id TEXT NOT NULL, epoch BIGINT NOT NULL, event_id TEXT NOT NULL,
          actor TEXT NOT NULL, occurred_at TEXT NOT NULL, receipt_json TEXT NOT NULL,
          PRIMARY KEY (deployment_id, epoch), UNIQUE (deployment_id, event_id),
          FOREIGN KEY (deployment_id) REFERENCES ${t("deployments")}(deployment_id))` },
      { sql: `INSERT INTO ${t("identity")} (singleton, repository_id) VALUES (1, $1) ON CONFLICT (singleton) DO NOTHING`, values: [randomUUID()] },
      { sql: `SELECT repository_id FROM ${t("identity")} WHERE singleton = 1`, check: exactlyOne },
    ], "migration");
    return String(rows.at(-1)![0]!.repository_id);
  }

  async identity(): Promise<string> {
    const rows = await this.connection.execute([{ sql: `SELECT repository_id FROM ${this.connection.table("identity")} WHERE singleton = 1`, check: exactlyOne }]);
    return String(rows[0]![0]!.repository_id);
  }

  async deployment(deploymentId: string): Promise<{ project_id: string; epoch: number; migration_digest: string } | undefined> {
    const rows = await this.connection.execute([{
      sql: `SELECT project_id, epoch, migration_digest FROM ${this.connection.table("deployments")} WHERE deployment_id = $1`,
      values: [identifier(deploymentId)],
    }]);
    const value = rows[0]![0];
    return value ? { project_id: identifier(value.project_id), epoch: epoch(value.epoch), migration_digest: digest(value.migration_digest) } : undefined;
  }

  /** Imports one verified legacy snapshot, including its pointers, in one commit.
   * A retry recognizes the original migration without replaying its authority. */
  async importDeployment(input: {
    deployment_id: string; project_id: string; migration_digest: string;
    revisions: ControlPolicyRevision[]; active: ControlPolicyPointer[]; drafts?: ControlPolicyPointer[]; event: ControlPolicyEvent;
  }): Promise<"imported" | "already_imported"> {
    const deploymentId = identifier(input.deployment_id);
    identifier(input.project_id);
    digest(input.migration_digest);
    const existing = await this.deployment(deploymentId);
    if (existing) {
      if (existing.project_id !== input.project_id || existing.migration_digest !== input.migration_digest) fail("POLICY_MIGRATION_MISMATCH");
      return "already_imported";
    }
    const statements: Statement[] = [{
      sql: `INSERT INTO ${this.connection.table("deployments")} (deployment_id, project_id, epoch, migration_digest)
        VALUES ($1, $2, 0, $3) ON CONFLICT DO NOTHING RETURNING deployment_id`,
      values: [deploymentId, input.project_id, input.migration_digest],
      check: (rows) => { if (rows.length !== 1) fail("POLICY_MIGRATION_RACE"); },
    }, ...this.changeStatements({ ...input, expected_epoch: 0 })];
    try { await this.connection.execute(statements, "write"); }
    catch (error) {
      if (!(error instanceof ProposalStoreError) || error.code !== "POLICY_MIGRATION_RACE") throw error;
      const raced = await this.deployment(deploymentId);
      if (raced?.project_id !== input.project_id || raced.migration_digest !== input.migration_digest) fail("POLICY_MIGRATION_MISMATCH");
      return "already_imported";
    }
    return "imported";
  }

  async commit(input: ControlPolicyCommit): Promise<number> {
    await this.connection.execute(this.changeStatements(input), "write");
    return input.expected_epoch + 1;
  }

  /** Trusted management callers only. Receipts are not a model-facing audit
   * feed; the service must authorize the exact deployment before this lookup. */
  async event(deploymentId: string, eventId: string): Promise<(ControlPolicyEvent & { epoch: number }) | undefined> {
    const rows = await this.connection.execute([{
      sql: `SELECT epoch, event_id, actor, occurred_at, receipt_json FROM ${this.connection.table("events")}
        WHERE deployment_id = $1 AND event_id = $2`,
      values: [identifier(deploymentId), identifier(eventId)],
    }]);
    const row = rows[0]![0];
    return row ? { epoch: epoch(row.epoch), event_id: identifier(row.event_id), actor: identifier(row.actor),
      occurred_at: String(row.occurred_at), receipt: JSON.parse(String(row.receipt_json)) as unknown } : undefined;
  }

  async revision(deploymentId: string, key: ControlPolicyKey, revisionId: string): Promise<ControlPolicyRevision | undefined> {
    const values = [identifier(deploymentId), scopeKey(key.scope), policyKind(key.kind), identifier(key.name), identifier(revisionId)];
    const rows = await this.connection.execute([{
      sql: `SELECT r.* FROM ${this.connection.table("revisions")} r
        WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND name = $4 AND revision_id = $5`, values,
    }]);
    return rows[0]![0] ? decodeRevision(rows[0]![0]) : undefined;
  }

  async active(deploymentId: string, key: ControlPolicyKey): Promise<ControlPolicyRevision | undefined> {
    const rows = await this.connection.execute([this.pointerStatement(deploymentId, key, "active")]);
    return rows[0]![0] ? decodeRevision(rows[0]![0]) : undefined;
  }

  async draft(deploymentId: string, key: ControlPolicyKey): Promise<ControlPolicyRevision | undefined> {
    const rows = await this.connection.execute([this.pointerStatement(deploymentId, key, "drafts")]);
    return rows[0]![0] ? decodeRevision(rows[0]![0]) : undefined;
  }

  /** Reads a bounded, caller-authorized chain and its CAS epoch in one snapshot. */
  async snapshot(deploymentId: string, keys: ControlPolicyKey[]): Promise<{
    epoch: number; policies: { active?: ControlPolicyRevision; draft?: ControlPolicyRevision }[];
  }> {
    if (keys.length > 64) fail("POLICY_BATCH_TOO_LARGE");
    const rows = await this.connection.execute([{
      sql: `SELECT epoch FROM ${this.connection.table("deployments")} WHERE deployment_id = $1`,
      values: [identifier(deploymentId)], check: exactlyOne,
    }, ...keys.flatMap((key) => [this.pointerStatement(deploymentId, key, "active"), this.pointerStatement(deploymentId, key, "drafts")])]);
    return { epoch: epoch(rows[0]![0]!.epoch), policies: keys.map((_, index) => ({
      ...(rows[index * 2 + 1]![0] ? { active: decodeRevision(rows[index * 2 + 1]![0]!) } : {}),
      ...(rows[index * 2 + 2]![0] ? { draft: decodeRevision(rows[index * 2 + 2]![0]!) } : {}),
    })) };
  }

  /** A complete, bounded scope view for trusted policy services. Overflow is a
   * refusal, not a truncated authority set. Null pointers are revocations and
   * are deliberately absent; immutable history remains separately available. */
  async scopeSnapshot(input: {
    deployment_id: string; scope: ControlPolicyScope; kinds: ControlPolicyKind[]; limit?: number; max_bytes?: number;
  }): Promise<ControlPolicyScopeSnapshot> {
    const limit = input.limit ?? 64;
    const maximumBytes = input.max_bytes ?? 128 * 1024 * 1024;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) fail("POLICY_LIST_LIMIT_INVALID");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 128 * 1024 * 1024) fail("POLICY_SNAPSHOT_BYTES_INVALID");
    if (!input.kinds.length || input.kinds.length > 6 || new Set(input.kinds).size !== input.kinds.length) fail("POLICY_KIND_SELECTION_INVALID");
    const values = [identifier(input.deployment_id), scopeKey(input.scope), ...input.kinds.map(policyKind), limit + 1];
    const kinds = input.kinds.map((_, index) => `$${index + 3}`).join(", ");
    const source = (state: "active" | "drafts") => `FROM ${this.connection.table(state)} a JOIN ${this.connection.table("revisions")} r
        ON r.deployment_id = a.deployment_id AND r.scope_key = a.scope_key
        AND r.kind = a.kind AND r.name = a.name AND r.revision_id = a.revision_id
        WHERE a.deployment_id = $1 AND a.scope_key = $2 AND a.kind IN (${kinds})
        ORDER BY a.kind COLLATE ${this.connection.collation}, a.name COLLATE ${this.connection.collation}
        LIMIT $${values.length}`;
    let count = 0; let bytes = 0;
    const statements: Statement[] = [{
      sql: `SELECT epoch FROM ${this.connection.table("deployments")} WHERE deployment_id = $1`,
      values: [values[0]!], check: exactlyOne,
    }, ...(["active", "drafts"] as const).map((state): Statement => ({
      // Check sizes within this transaction before fetching or parsing bodies.
      sql: `SELECT ${this.connection.byteLength("r.content_json")} AS bytes ${source(state)}`,
      values,
      check: (rows) => {
        count += rows.length;
        bytes += rows.reduce((sum, row) => sum + epoch(row.bytes), 0);
        if (count > limit || bytes > maximumBytes) fail("POLICY_SNAPSHOT_TOO_LARGE");
      },
    })), ...(["active", "drafts"] as const).map((state): Statement => ({
      sql: `SELECT r.* ${source(state)}`, values,
    }))];
    const rows = await this.connection.execute(statements);
    return { epoch: epoch(rows[0]![0]!.epoch), active: rows[3]!.map(decodeRevision), drafts: rows[4]!.map(decodeRevision) };
  }

  private pointerStatement(deploymentId: string, key: ControlPolicyKey, state: "active" | "drafts"): Statement {
    return {
      sql: `SELECT r.* FROM ${this.connection.table(state)} a JOIN ${this.connection.table("revisions")} r
        ON r.deployment_id = a.deployment_id AND r.revision_id = a.revision_id
        AND r.scope_key = a.scope_key AND r.kind = a.kind AND r.name = a.name
        WHERE a.deployment_id = $1 AND a.scope_key = $2 AND a.kind = $3 AND a.name = $4`,
      values: [identifier(deploymentId), scopeKey(key.scope), policyKind(key.kind), identifier(key.name)],
    };
  }

  async listActive(input: { deployment_id: string; scope: ControlPolicyScope; kind: ControlPolicyKind; after?: string; limit?: number }): Promise<ControlPolicyRevision[]> {
    return this.listPointers(input, "active");
  }

  async listDrafts(input: { deployment_id: string; scope: ControlPolicyScope; kind: ControlPolicyKind; after?: string; limit?: number }): Promise<ControlPolicyRevision[]> {
    return this.listPointers(input, "drafts");
  }

  private async listPointers(input: { deployment_id: string; scope: ControlPolicyScope; kind: ControlPolicyKind; after?: string; limit?: number }, state: "active" | "drafts"): Promise<ControlPolicyRevision[]> {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("POLICY_LIST_LIMIT_INVALID");
    const rows = await this.connection.execute([{
      sql: `SELECT r.* FROM ${this.connection.table(state)} a JOIN ${this.connection.table("revisions")} r
        ON r.deployment_id = a.deployment_id AND r.revision_id = a.revision_id
        AND r.scope_key = a.scope_key AND r.kind = a.kind AND r.name = a.name
        WHERE a.deployment_id = $1 AND a.scope_key = $2 AND a.kind = $3 AND a.name COLLATE ${this.connection.collation} > $4
        ORDER BY a.name COLLATE ${this.connection.collation} LIMIT $5`,
      values: [identifier(input.deployment_id), scopeKey(input.scope), policyKind(input.kind), input.after === undefined ? "" : identifier(input.after), limit],
    }]);
    return rows[0]!.map(decodeRevision);
  }

  async history(input: { deployment_id: string; key: ControlPolicyKey; before?: { epoch: number; revision_id: string }; limit?: number }): Promise<{ epoch: number; revision: ControlPolicyRevision }[]> {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("POLICY_LIST_LIMIT_INVALID");
    const rows = await this.connection.execute([{
      sql: `SELECT r.* FROM ${this.connection.table("revisions")} r
        WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND name = $4
          AND (epoch < $5 OR (epoch = $5 AND revision_id COLLATE ${this.connection.collation} < $6))
        ORDER BY epoch DESC, revision_id COLLATE ${this.connection.collation} DESC LIMIT $7`,
      values: [identifier(input.deployment_id), scopeKey(input.key.scope), policyKind(input.key.kind), identifier(input.key.name),
        input.before === undefined ? Number.MAX_SAFE_INTEGER : epoch(input.before.epoch),
        input.before === undefined ? "" : identifier(input.before.revision_id), limit],
    }]);
    return rows[0]!.map((row) => ({ epoch: epoch(row.epoch), revision: decodeRevision(row) }));
  }

  private changeStatements(input: ControlPolicyCommit): Statement[] {
    const deploymentId = identifier(input.deployment_id);
    if (!Number.isSafeInteger(input.expected_epoch) || input.expected_epoch < 0 || input.expected_epoch >= Number.MAX_SAFE_INTEGER) fail("POLICY_EPOCH_INVALID");
    if (input.revisions.length > 64 || input.active.length + (input.drafts?.length ?? 0) > 64) fail("POLICY_BATCH_TOO_LARGE");
    const event = input.event;
    identifier(event.event_id); identifier(event.actor);
    if (typeof event.occurred_at !== "string" || !Number.isFinite(Date.parse(event.occurred_at))
      || new Date(event.occurred_at).toISOString() !== event.occurred_at) fail("POLICY_EVENT_TIME_INVALID");
    const receipt = boundedJson(event.receipt, 64 * 1024);
    const statements: Statement[] = [{
      sql: `UPDATE ${this.connection.table("deployments")} SET epoch = epoch + 1
        WHERE deployment_id = $1 AND epoch = $2 RETURNING epoch`,
      values: [deploymentId, input.expected_epoch],
      check: (rows) => { if (rows.length !== 1) fail("POLICY_REVISION_CONFLICT"); },
    }];
    let bytes = 0;
    for (const revision of input.revisions) {
      const content = boundedJson(revision.content, 64 * 1024 * 1024);
      bytes += Buffer.byteLength(content);
      if (bytes > 128 * 1024 * 1024) fail("POLICY_BATCH_TOO_LARGE");
      if (digest(revision.content_digest) !== canonicalJsonDigest(revision.content)) fail("POLICY_CONTENT_MISMATCH");
      statements.push({
        sql: `INSERT INTO ${this.connection.table("revisions")}
          (deployment_id, scope_key, kind, name, revision_id, epoch, authority_digest, content_digest, content_json)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        values: [deploymentId, scopeKey(revision.scope), policyKind(revision.kind), identifier(revision.name),
          identifier(revision.revision_id), input.expected_epoch + 1, digest(revision.authority_digest), revision.content_digest, content],
      });
    }
    for (const state of ["active", "drafts"] as const) {
      const pointerKeys = new Set<string>();
      for (const pointer of input[state] ?? []) {
        const key = [scopeKey(pointer.scope), policyKind(pointer.kind), identifier(pointer.name)];
        const token = JSON.stringify(key);
        if (pointerKeys.has(token)) fail("POLICY_DUPLICATE_POINTER");
        pointerKeys.add(token);
        statements.push({
          sql: `INSERT INTO ${this.connection.table(state)} (deployment_id, scope_key, kind, name, revision_id)
            VALUES ($1, $2, $3, $4, $5) ON CONFLICT (deployment_id, scope_key, kind, name)
            DO UPDATE SET revision_id = excluded.revision_id`,
          values: [deploymentId, ...key, pointer.revision_id === null ? null : identifier(pointer.revision_id)],
        });
      }
    }
    statements.push({
      sql: `INSERT INTO ${this.connection.table("events")} (deployment_id, epoch, event_id, actor, occurred_at, receipt_json)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (deployment_id, event_id) DO NOTHING RETURNING event_id`,
      values: [deploymentId, input.expected_epoch + 1, event.event_id, event.actor, event.occurred_at, receipt],
      check: (rows) => { if (rows.length !== 1) fail("POLICY_EVENT_ALREADY_RECORDED"); },
    });
    return statements;
  }
}

export function sqliteControlPolicyRepository(db: DatabaseSync): ControlPolicyRepository {
  if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) fail("POLICY_FOREIGN_KEYS_REQUIRED");
  return new ControlPolicyRepository({
    table: (name) => `"control_policy_${name}"`,
    collation: "BINARY",
    byteLength: (expression) => `length(CAST(${expression} AS BLOB))`,
    async execute(statements, mode = "read") {
      // No await inside this transaction: another synchronous connection must
      // not block this event loop while it owns the SQLite write lock.
      if (db.prepare("PRAGMA foreign_keys").get()?.foreign_keys !== 1) fail("POLICY_FOREIGN_KEYS_REQUIRED");
      db.exec(mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
      try {
        const result = statements.map((statement) => {
          const parameters = Object.fromEntries((statement.values ?? []).map((value, index) => [`$${index + 1}`, value]));
          const rows = db.prepare(statement.sql).all(parameters) as Row[];
          statement.check?.(rows);
          return rows;
        });
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  });
}

export function postgresControlPolicyRepository(pool: PostgresRuntimePool, schema: string): ControlPolicyRepository {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/u.test(schema)) fail("POLICY_SCHEMA_INVALID");
  return new ControlPolicyRepository({
    table: (name) => `"${schema}"."control_policy_${name}"`,
    collation: '"C"',
    byteLength: (expression) => `octet_length(${expression})`,
    async execute(statements, mode = "read") {
      const client = await pool.connect();
      try {
        await client.query(mode === "read" ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
        if (mode === "migration") {
          await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`${schema}:control-policy-migration`]);
          await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
        }
        const result: Row[][] = [];
        for (const statement of statements) {
          const rows = (await client.query(statement.sql, statement.values)).rows;
          statement.check?.(rows);
          result.push(rows);
        }
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { client.release(); }
    },
  });
}

function decodeRevision(row: Row): ControlPolicyRevision {
  const content = JSON.parse(String(row.content_json)) as unknown;
  if (canonicalJsonDigest(content) !== row.content_digest) fail("POLICY_CONTENT_MISMATCH");
  const scope = JSON.parse(String(row.scope_key)) as ControlPolicyScope;
  if (scopeKey(scope) !== row.scope_key) fail("POLICY_SCOPE_INVALID");
  return { scope, kind: policyKind(row.kind), name: identifier(row.name), revision_id: identifier(row.revision_id),
    authority_digest: digest(row.authority_digest), content_digest: digest(row.content_digest), content };
}

function scopeKey(scope: ControlPolicyScope): string {
  if (!scope || typeof scope !== "object") fail("POLICY_SCOPE_INVALID");
  const keys = Object.keys(scope).sort().join(",");
  if (scope.level === "operator" && keys === "level") return canonicalJsonStringify(scope);
  if (scope.level === "tenant" && keys === "level,tenant_id") {
    identifier(scope.tenant_id); return canonicalJsonStringify(scope);
  }
  if (scope.level === "principal" && keys === "level,principal,tenant_id") {
    identifier(scope.tenant_id); identifier(scope.principal); return canonicalJsonStringify(scope);
  }
  return fail("POLICY_SCOPE_INVALID");
}

function policyKind(value: unknown): ControlPolicyKind {
  if (typeof value !== "string" || !["read", "action", "execution", "parent", "delegation", "management"].includes(value)) fail("POLICY_KIND_INVALID");
  return value as ControlPolicyKind;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail("POLICY_IDENTIFIER_INVALID");
  return value;
}
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail("POLICY_DIGEST_INVALID");
  return value;
}
function epoch(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" && /^[0-9]+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 0) fail("POLICY_EPOCH_INVALID");
  return number;
}
function boundedJson(value: unknown, limit: number): string {
  const json = canonicalJsonStringify(value);
  if (Buffer.byteLength(json) > limit) fail("POLICY_CONTENT_TOO_LARGE");
  return json;
}
function exactlyOne(rows: Row[]): void { if (rows.length !== 1) fail("POLICY_REPOSITORY_UNAVAILABLE"); }
function fail(code: string): never { throw new ProposalStoreError(code, code); }
