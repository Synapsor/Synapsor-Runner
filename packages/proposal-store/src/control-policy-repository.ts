import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { PostgresRuntimePool } from "./postgres-runtime-types.js";
import { ProposalStoreError } from "./errors.js";

import type { ControlPolicyScope, ControlPolicyKind, ControlPolicyKey, ControlPolicyRevision,
  ControlPolicyPointer, ControlPolicyScopeSnapshot, ControlPolicyEvent, ControlPolicyCommit,
  Row, Statement, PolicyConnection, ControlPolicyReadGuard } from "./control-policy-types.js";
import { boundedJson, digest, epoch, exactlyOne, fail, identifier, policyKind, scopeKey } from "./control-policy-values.js";
import { ControlPolicyReviews, controlPolicyReviewSchema } from "./control-policy-reviews.js";
import { ControlHardBudgets, controlHardBudgetSchema } from "./control-hard-budgets.js";
import { ControlEffectAdmissions, controlEffectAdmissionSchema } from "./control-effect-admissions.js";
import { ControlRuntimeProofs, controlRuntimeProofSchema } from "./control-runtime-proofs.js";
export type { ControlPolicyScope, ControlPolicyKind, ControlPolicyKey, ControlPolicyRevision,
  ControlPolicyPointer, ControlPolicyScopeSnapshot, ControlPolicyEvent, ControlPolicyCommit, ControlPolicyReadGuard } from "./control-policy-types.js";

/** Storage only, not an owner-facing authorization API. Its caller must validate
 * policy semantics and authenticate management rights before obtaining a scope.
 * Both backends execute the same bounded statement batches atomically. */
export class ControlPolicyRepository {
  readonly reviews: ControlPolicyReviews;
  readonly budgets: ControlHardBudgets;
  readonly effects: ControlEffectAdmissions;
  readonly runtimeProofs: ControlRuntimeProofs;
  constructor(private readonly connection: PolicyConnection) {
    this.reviews = new ControlPolicyReviews(connection);
    this.budgets = new ControlHardBudgets(connection);
    this.effects = new ControlEffectAdmissions(connection, this.budgets);
    this.runtimeProofs = new ControlRuntimeProofs(connection);
  }

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
      ...controlPolicyReviewSchema(this.connection),
      ...controlHardBudgetSchema(this.connection),
      ...controlEffectAdmissionSchema(this.connection),
      ...controlRuntimeProofSchema(this.connection),
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
  async snapshot(deploymentId: string, keys: ControlPolicyKey[], guard?: ControlPolicyReadGuard): Promise<{
    epoch: number; policies: { active?: ControlPolicyRevision; draft?: ControlPolicyRevision }[];
  }> {
    if (keys.length > 64) fail("POLICY_BATCH_TOO_LARGE");
    const guards = this.readGuardStatements(deploymentId, guard);
    const rows = await this.connection.execute([{
      sql: `SELECT epoch FROM ${this.connection.table("deployments")} WHERE deployment_id = $1`,
      values: [identifier(deploymentId)], check: exactlyOne,
    }, ...guards, ...keys.flatMap((key) => [this.pointerStatement(deploymentId, key, "active"), this.pointerStatement(deploymentId, key, "drafts")])]);
    return { epoch: epoch(rows[0]![0]!.epoch), policies: keys.map((_, index) => ({
      ...(rows[index * 2 + 1 + guards.length]![0] ? { active: decodeRevision(rows[index * 2 + 1 + guards.length]![0]!) } : {}),
      ...(rows[index * 2 + 2 + guards.length]![0] ? { draft: decodeRevision(rows[index * 2 + 2 + guards.length]![0]!) } : {}),
    })) };
  }

  /** Reads one exact pointer pair after the caller's guard has authorized the
   * snapshot. Management callers use this instead of expanding a whole scope. */
  async exactPointerSnapshot(input: {
    deployment_id: string; key: ControlPolicyKey; max_bytes?: number;
  }, guard?: ControlPolicyReadGuard): Promise<{
    epoch: number; active?: ControlPolicyRevision; draft?: ControlPolicyRevision;
  }> {
    const maximumBytes = input.max_bytes ?? 1_048_576;
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1_048_576) fail("POLICY_SNAPSHOT_BYTES_INVALID");
    const guards = this.readGuardStatements(input.deployment_id, guard);
    const states = ["active", "drafts"] as const;
    const sizeStatement = (state: typeof states[number]): Statement => ({
      sql: `SELECT ${this.connection.byteLength("r.content_json")} AS bytes FROM ${this.connection.table(state)} a
        JOIN ${this.connection.table("revisions")} r ON r.deployment_id = a.deployment_id AND r.revision_id = a.revision_id
          AND r.scope_key = a.scope_key AND r.kind = a.kind AND r.name = a.name
        WHERE a.deployment_id = $1 AND a.scope_key = $2 AND a.kind = $3 AND a.name = $4`,
      values: [identifier(input.deployment_id), scopeKey(input.key.scope), policyKind(input.key.kind), identifier(input.key.name)],
    });
    let bytes = 0;
    const statements: Statement[] = [{
      sql: `SELECT epoch FROM ${this.connection.table("deployments")} WHERE deployment_id = $1`,
      values: [identifier(input.deployment_id)], check: exactlyOne,
    }, ...guards, ...states.map((state) => ({ ...sizeStatement(state), check: (rows: Row[]) => {
      if (rows.length > 1) fail("POLICY_SNAPSHOT_TOO_LARGE");
      bytes += rows.reduce((sum, row) => sum + epoch(row.bytes), 0);
      if (bytes > maximumBytes) fail("POLICY_SNAPSHOT_TOO_LARGE");
    } })), ...states.map((state) => this.pointerStatement(input.deployment_id, input.key, state))];
    const rows = await this.connection.execute(statements);
    const offset = 1 + guards.length + states.length;
    return { epoch: epoch(rows[0]![0]!.epoch),
      ...(rows[offset]![0] ? { active: decodeRevision(rows[offset]![0]!) } : {}),
      ...(rows[offset + 1]![0] ? { draft: decodeRevision(rows[offset + 1]![0]!) } : {}) };
  }

  /** Returns a single kind's active/draft pointers in deterministic keyset
   * order. The cursor is pinned to the deployment epoch so a later page can
   * never silently combine authority from two snapshots. Bodies are size
   * checked before any JSON is decoded. */
  async scopePointerPage(input: {
    deployment_id: string; scope: ControlPolicyScope; kind: ControlPolicyKind;
    after?: { name: string; epoch: number }; limit?: number; max_bytes?: number;
  }, guard?: ControlPolicyReadGuard): Promise<{
    epoch: number; items: Array<{ name: string; active?: ControlPolicyRevision; draft?: ControlPolicyRevision }>;
    next?: { name: string; epoch: number };
  }> {
    const limit = input.limit ?? 20;
    const maximumBytes = input.max_bytes ?? 1_048_576;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) fail("POLICY_LIST_LIMIT_INVALID");
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 1_048_576) fail("POLICY_SNAPSHOT_BYTES_INVALID");
    const after = input.after ? { name: identifier(input.after.name), epoch: epoch(input.after.epoch) } : undefined;
    const values = [identifier(input.deployment_id), scopeKey(input.scope), policyKind(input.kind), after?.name ?? "", limit + 1];
    const names = `WITH pointer_names AS (
        SELECT name FROM (
          SELECT name FROM ${this.connection.table("active")} WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND revision_id IS NOT NULL AND name COLLATE ${this.connection.collation} > $4
          UNION
          SELECT name FROM ${this.connection.table("drafts")} WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND revision_id IS NOT NULL AND name COLLATE ${this.connection.collation} > $4
        ) pointers ORDER BY name COLLATE ${this.connection.collation} LIMIT $5
      )`;
    const selected = (state: "active" | "drafts", columns: string) => `SELECT '${state}' AS pointer_state, r.name AS pointer_name${columns} FROM pointer_names p
        JOIN ${this.connection.table(state)} a ON a.deployment_id = $1 AND a.scope_key = $2 AND a.kind = $3 AND a.name = p.name
        JOIN ${this.connection.table("revisions")} r ON r.deployment_id = a.deployment_id AND r.revision_id = a.revision_id
          AND r.scope_key = a.scope_key AND r.kind = a.kind AND r.name = a.name`;
    const guards = this.readGuardStatements(input.deployment_id, guard);
    let bytes = 0;
    const statements: Statement[] = [{
      sql: `SELECT epoch FROM ${this.connection.table("deployments")} WHERE deployment_id = $1`, values: [values[0]!],
      check: (rows) => { exactlyOne(rows); const current = epoch(rows[0]!.epoch); if (after && current !== after.epoch) fail("POLICY_PAGE_EPOCH_STALE"); },
    }, ...guards, {
      sql: `${names} ${selected("active", `, ${this.connection.byteLength("r.content_json")} AS bytes`)} UNION ALL ${selected("drafts", `, ${this.connection.byteLength("r.content_json")} AS bytes`)}`,
      values, check: (rows) => {
        if (rows.length > (limit + 1) * 2) fail("POLICY_SNAPSHOT_TOO_LARGE");
        bytes = rows.reduce((sum, row) => sum + epoch(row.bytes), 0);
        if (bytes > maximumBytes) fail("POLICY_SNAPSHOT_TOO_LARGE");
      },
    }, {
      sql: `${names} SELECT * FROM (${selected("active", ", r.*")} UNION ALL ${selected("drafts", ", r.*")}) pointer_rows
        ORDER BY pointer_name COLLATE ${this.connection.collation}, pointer_state`,
      values,
    }];
    const rows = await this.connection.execute(statements);
    const currentEpoch = epoch(rows[0]![0]!.epoch);
    const body = rows.at(-1)!;
    const byName = new Map<string, { name: string; active?: ControlPolicyRevision; draft?: ControlPolicyRevision }>();
    for (const row of body) {
      const pointerName = identifier(row.pointer_name);
      const item = byName.get(pointerName) ?? { name: pointerName };
      if (row.pointer_state === "active") item.active = decodeRevision(row);
      else if (row.pointer_state === "drafts") item.draft = decodeRevision(row);
      else fail("POLICY_POINTER_STATE_INVALID");
      byName.set(pointerName, item);
    }
    const selectedItems = [...byName.values()];
    const items = selectedItems.slice(0, limit);
    const last = items.at(-1);
    return { epoch: currentEpoch, items,
      ...(selectedItems.length > limit && last ? { next: { name: last.name, epoch: currentEpoch } } : {}) };
  }

  /** A complete, bounded scope view for trusted policy services. Overflow is a
   * refusal, not a truncated authority set. Null pointers are revocations and
   * are deliberately absent; immutable history remains separately available. */
  async scopeSnapshot(input: {
    deployment_id: string; scope: ControlPolicyScope; kinds: ControlPolicyKind[]; limit?: number; max_bytes?: number;
  }, guard?: ControlPolicyReadGuard): Promise<ControlPolicyScopeSnapshot> {
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
    const guards = this.readGuardStatements(input.deployment_id, guard);
    const statements: Statement[] = [{
      sql: `SELECT epoch FROM ${this.connection.table("deployments")} WHERE deployment_id = $1`,
      values: [values[0]!], check: exactlyOne,
    }, ...guards, ...(["active", "drafts"] as const).map((state): Statement => ({
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
    return { epoch: epoch(rows[0]![0]!.epoch), active: rows[3 + guards.length]!.map(decodeRevision), drafts: rows[4 + guards.length]!.map(decodeRevision) };
  }

  private readGuardStatements(deploymentId: string, guard?: ControlPolicyReadGuard): Statement[] {
    if (!guard) return [];
    if (!guard.keys.length || guard.keys.length > 8) fail("POLICY_READ_GUARD_INVALID");
    const current: Array<ControlPolicyRevision | undefined> = [];
    return [...guard.keys.map((key): Statement => ({ ...this.pointerStatement(deploymentId, key, "active"),
      check: (rows) => { current.push(rows[0] ? decodeRevision(rows[0]) : undefined); },
    })), { sql: "SELECT 1", check: () => guard.authorize(current) }];
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

  /** Owner-service history for revisions and exact review decisions, with no
   * unscoped event payloads. Each branch applies its key and limit in SQL. */
  async policyHistory(input: { deployment_id: string; key: ControlPolicyKey; limit?: number;
    before?: { epoch: number; revision_id: string } }, guard: ControlPolicyReadGuard) {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("POLICY_LIST_LIMIT_INVALID");
    const values = [identifier(input.deployment_id), scopeKey(input.key.scope), policyKind(input.key.kind), identifier(input.key.name),
      input.before ? epoch(input.before.epoch) : Number.MAX_SAFE_INTEGER, input.before ? identifier(input.before.revision_id) : "", limit + 1];
    const collation = this.connection.collation;
    const branch = (review: boolean) => {
      const version = review ? "r.expected_epoch + 1" : "r.epoch";
      return `SELECT ${version} AS epoch, r.revision_id, e.event_id, e.actor, e.occurred_at,
          ${review ? "r.operation" : "'revision_created'"} AS operation
        FROM ${this.connection.table(review ? "reviews" : "revisions")} r
        JOIN ${this.connection.table("events")} e ON e.deployment_id = r.deployment_id
          AND ${review ? "e.event_id = r.consumed_event_id" : "e.epoch = r.epoch"}
        WHERE r.deployment_id = $1 AND r.scope_key = $2 AND r.kind = $3 AND r.name = $4
          AND (${version} < $5 OR (${version} = $5 AND r.revision_id COLLATE ${collation} < $6))
        ORDER BY ${review ? "r.expected_epoch" : "r.epoch"} DESC, r.revision_id COLLATE ${collation} DESC LIMIT $7`;
    };
    const rows = await this.connection.execute([...this.readGuardStatements(input.deployment_id, guard), {
      sql: `SELECT * FROM (SELECT * FROM (${branch(false)}) versions UNION ALL SELECT * FROM (${branch(true)}) decisions) history
        ORDER BY epoch DESC, revision_id COLLATE ${collation} DESC LIMIT $7`, values,
    }]);
    const page = rows.at(-1)!;
    const items = page.slice(0, limit).map((row) => ({ epoch: epoch(row.epoch), revision_id: identifier(row.revision_id),
      event_id: identifier(row.event_id), actor: identifier(row.actor), occurred_at: String(row.occurred_at), operation: String(row.operation) }));
    const last = items.at(-1);
    return { items, ...(page.length > limit && last ? { next: { epoch: last.epoch, revision_id: last.revision_id } } : {}) };
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
    const receiptValue = JSON.parse(receipt);
    // A recovery fence owns the original epoch/event identity but must never
    // smuggle a revision or pointer update into a claimed cancellation.
    if (receiptValue?.operation === "cancel_unconfirmed_policy_publication") {
      if (input.revisions.length || input.active.length || input.drafts?.length
        || receiptValue.authority_changed !== false || receiptValue.source_database_changed !== false
        || Object.keys(receiptValue).length !== 4) fail("POLICY_PUBLICATION_FENCE_INVALID");
      digest(receiptValue.publication_event_digest);
    }
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
    nowMs: "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)",
    nowIso: "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
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
    nowMs: "FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT",
    nowIso: `to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
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
