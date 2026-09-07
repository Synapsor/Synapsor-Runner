import { randomBytes, randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ControlPolicyKey, PolicyConnection, Statement } from "./control-policy-types.js";
import { boundedJson, digest, epoch, fail, identifier, policyKind, scopeKey } from "./control-policy-values.js";

export type ControlPolicyReviewTarget = {
  deployment_id: string;
  key: ControlPolicyKey;
  revision_id: string;
  expected_epoch: number;
  operation: "activate" | "revoke";
  actor: string;
  session_digest: string;
  summary_digest: string;
};
export type ControlPolicyReview = ControlPolicyReviewTarget & {
  review_id: string;
  expires_at_ms: number;
};
export type ControlPolicyReviewConfirmation = ControlPolicyReviewTarget & { review_id: string; nonce: string };
export type ControlPolicyReviewReceipt = {
  status: "committed" | "already_committed";
  epoch: number;
  event_id: string;
  occurred_at: string;
  operation: "activate" | "revoke";
  key: ControlPolicyKey;
  revision_id: string;
  summary_digest: string;
  review_id: string;
  source_database_changed: false;
};

export function controlPolicyReviewSchema(c: PolicyConnection): Statement[] {
  return [{ sql: `CREATE TABLE IF NOT EXISTS ${c.table("reviews")} (
    deployment_id TEXT NOT NULL, review_id TEXT NOT NULL,
    scope_key TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, revision_id TEXT NOT NULL,
    expected_epoch BIGINT NOT NULL CHECK (expected_epoch >= 0), operation TEXT NOT NULL CHECK (operation IN ('activate', 'revoke')),
    actor TEXT NOT NULL, session_digest TEXT NOT NULL, summary_digest TEXT NOT NULL, nonce_digest TEXT NOT NULL,
    expires_at_ms BIGINT NOT NULL, consumed_event_id TEXT,
    PRIMARY KEY (deployment_id, review_id),
    FOREIGN KEY (deployment_id, scope_key, kind, name, revision_id)
      REFERENCES ${c.table("revisions")}(deployment_id, scope_key, kind, name, revision_id),
    FOREIGN KEY (deployment_id, consumed_event_id) REFERENCES ${c.table("events")}(deployment_id, event_id))` },
  { sql: `CREATE INDEX IF NOT EXISTS control_policy_pending_reviews ON ${c.table("reviews")}
    (deployment_id, scope_key, kind, name, actor, consumed_event_id, expires_at_ms)` },
  { sql: `CREATE INDEX IF NOT EXISTS control_policy_review_history ON ${c.table("reviews")}
    (deployment_id, scope_key, kind, name, expected_epoch, revision_id)` }];
}

/** Trusted management storage, NOT authentication. The management service must
 * verify the human/session and management rights before issuing or confirming.
 * A model tool call or possession of a review id is never that verification. */
export class ControlPolicyReviews {
  constructor(private readonly c: PolicyConnection) {}

  async prepare(input: ControlPolicyReviewTarget & { ttl_ms?: number }): Promise<{ review: ControlPolicyReview; nonce: string }> {
    const target = normalizedTarget(input);
    const ttl = input.ttl_ms ?? 300_000;
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 900_000) fail("POLICY_REVIEW_TTL_INVALID");
    const reviewId = randomUUID(), nonce = randomBytes(32).toString("base64url");
    const k = keyValues(target);
    const rows = await this.c.execute([
      this.lock(target, false), this.currentPointer(target),
      { sql: `SELECT COUNT(*) AS n FROM ${this.c.table("reviews")}
          WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND name = $4 AND actor = $5
            AND expected_epoch = $6 AND consumed_event_id IS NULL AND expires_at_ms > ${this.c.nowMs}`,
        values: [...k, target.actor, target.expected_epoch], check: (rows) => { if (epoch(rows[0]?.n) >= 16) fail("POLICY_REVIEW_LIMIT"); } },
      { sql: `INSERT INTO ${this.c.table("reviews")}
          (deployment_id, scope_key, kind, name, revision_id, expected_epoch, operation,
           actor, session_digest, summary_digest, review_id, nonce_digest, expires_at_ms)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, ${this.c.nowMs} + $13)
          RETURNING expires_at_ms`,
        values: [...k, target.revision_id, target.expected_epoch, target.operation,
          target.actor, target.session_digest, target.summary_digest, reviewId, canonicalJsonDigest({ nonce }), ttl] },
    ], "write");
    return { review: { ...target, review_id: reviewId, expires_at_ms: epoch(rows.at(-1)?.[0]?.expires_at_ms) }, nonce };
  }

  async confirm(input: ControlPolicyReviewConfirmation): Promise<ControlPolicyReviewReceipt> {
    const target = normalizedTarget(input);
    const reviewId = identifier(input.review_id);
    if (typeof input.nonce !== "string" || !/^[a-zA-Z0-9_-]{43}$/u.test(input.nonce)) fail("POLICY_REVIEW_INVALID");
    const k = keyValues(target), eventId = `policy_review:${reviewId}`;
    const claim = [...k, target.revision_id, target.expected_epoch, target.operation, target.actor,
      target.session_digest, target.summary_digest, reviewId, canonicalJsonDigest({ nonce: input.nonce })];
    const columns = ["deployment_id", "scope_key", "kind", "name", "revision_id", "expected_epoch", "operation",
      "actor", "session_digest", "summary_digest", "review_id", "nonce_digest"];
    const match = (prefix = "") => columns.map((column, index) => `${prefix}${column} = $${index + 1}`).join(" AND ");
    const receipt = { operation: target.operation, key: target.key, revision_id: target.revision_id,
      summary_digest: target.summary_digest, review_id: reviewId, source_database_changed: false as const };
    let already: ControlPolicyReviewReceipt | undefined;
    // Check for receipt recovery under the same deployment lock as activation.
    // Throwing only this private sentinel rolls back the no-op lock, not an
    // authority mutation, and returns the original result without replaying it.
    const replay = new Error("recorded review");
    const statements: Statement[] = [
      this.lock(target, false, false),
      { sql: `SELECT r.*, e.epoch AS committed_epoch, e.occurred_at
          FROM ${this.c.table("reviews")} r LEFT JOIN ${this.c.table("events")} e
            ON e.deployment_id = r.deployment_id AND e.event_id = r.consumed_event_id
          WHERE ${match("r.")}`,
        values: claim,
        check: (rows) => {
          const row = rows[0];
          if (rows.length !== 1 || !row) fail("POLICY_REVIEW_INVALID");
          if (row.consumed_event_id !== null) {
            if (row.consumed_event_id !== eventId || row.committed_epoch === null || typeof row.occurred_at !== "string") fail("POLICY_REVIEW_RECEIPT_INVALID");
            already = { ...receipt, status: "already_committed", epoch: epoch(row.committed_epoch), event_id: eventId, occurred_at: row.occurred_at };
            throw replay;
          }
        } },
      this.lock(target, true), this.currentPointer(target),
      { sql: `SELECT review_id FROM ${this.c.table("reviews")} WHERE ${match()}
          AND consumed_event_id IS NULL AND expires_at_ms > ${this.c.nowMs}`,
        values: claim, check: (rows) => { if (rows.length !== 1) fail("POLICY_REVIEW_EXPIRED"); } },
      { sql: `INSERT INTO ${this.c.table("active")} (deployment_id, scope_key, kind, name, revision_id)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (deployment_id, scope_key, kind, name)
          DO UPDATE SET revision_id = excluded.revision_id`,
        values: [...k, target.operation === "activate" ? target.revision_id : null] },
      ...(target.operation === "activate" ? [{ sql: `UPDATE ${this.c.table("drafts")} SET revision_id = NULL
          WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND name = $4 AND revision_id = $5`,
        values: [...k, target.revision_id] }] : []),
      { sql: `INSERT INTO ${this.c.table("events")} (deployment_id, epoch, event_id, actor, occurred_at, receipt_json)
          VALUES ($1, $2, $3, $4, ${this.c.nowIso}, $5) RETURNING occurred_at`,
        values: [target.deployment_id, target.expected_epoch + 1, eventId, target.actor, boundedJson(receipt, 64 * 1024)] },
      { sql: `UPDATE ${this.c.table("reviews")} SET consumed_event_id = $13 WHERE ${match()}
          AND consumed_event_id IS NULL AND expires_at_ms > ${this.c.nowMs} RETURNING review_id`,
        values: [...claim, eventId], check: (rows) => { if (rows.length !== 1) fail("POLICY_REVIEW_EXPIRED"); } },
    ];
    try {
      const rows = await this.c.execute(statements, "write");
      return { ...receipt, status: "committed", epoch: target.expected_epoch + 1, event_id: eventId,
        occurred_at: String(rows.at(-2)?.[0]?.occurred_at) };
    } catch (error) { if (error === replay && already) return already; throw error; }
  }

  private lock(target: ControlPolicyReviewTarget, increment: boolean, checkEpoch = true): Statement {
    return { sql: `UPDATE ${this.c.table("deployments")} SET epoch = epoch${increment ? " + 1" : ""}
        WHERE deployment_id = $1${checkEpoch ? " AND epoch = $2" : ""} RETURNING epoch`,
      values: [target.deployment_id, ...(checkEpoch ? [target.expected_epoch] : [])],
      check: (rows) => { if (rows.length !== 1) fail("POLICY_REVISION_CONFLICT"); } };
  }

  private currentPointer(target: ControlPolicyReviewTarget): Statement {
    const table = this.c.table(target.operation === "activate" ? "drafts" : "active");
    return { sql: `SELECT revision_id FROM ${table}
        WHERE deployment_id = $1 AND scope_key = $2 AND kind = $3 AND name = $4 AND revision_id = $5`,
      values: [...keyValues(target), target.revision_id],
      check: (rows) => { if (rows.length !== 1) fail("POLICY_REVIEW_REVISION_CHANGED"); } };
  }
}

function keyValues(target: ControlPolicyReviewTarget): string[] {
  return [target.deployment_id, scopeKey(target.key.scope), policyKind(target.key.kind), identifier(target.key.name)];
}
function normalizedTarget(input: ControlPolicyReviewTarget): ControlPolicyReviewTarget {
  const expected = epoch(input.expected_epoch);
  if (expected >= Number.MAX_SAFE_INTEGER) fail("POLICY_EPOCH_INVALID");
  if (input.operation !== "activate" && input.operation !== "revoke") fail("POLICY_REVIEW_OPERATION_INVALID");
  return { deployment_id: identifier(input.deployment_id), key: {
    scope: JSON.parse(scopeKey(input.key.scope)), kind: policyKind(input.key.kind), name: identifier(input.key.name),
  }, revision_id: identifier(input.revision_id), expected_epoch: expected, operation: input.operation,
    actor: identifier(input.actor), session_digest: digest(input.session_digest), summary_digest: digest(input.summary_digest) };
}
