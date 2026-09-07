import { randomBytes, randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { PolicyConnection, Row, Statement } from "./control-policy-types.js";
import { digest, epoch, fail, identifier } from "./control-policy-values.js";
import type { ControlHardBudgets } from "./control-hard-budgets.js";

export type EffectAdmissionTarget = {
  deployment_id: string; request_id: string; expected_epoch: number;
  actor_digest: string; policy_chain_digest: string; effect_digest: string;
};
export type EffectAdmissionState = "prepared" | "dispatched" | "unknown" | "completed" | "no_effect";
export type PreparedEffectAdmission = { dispatch_id: string; state: EffectAdmissionState; nonce?: string; expires_at_ms: number };
type EffectReceiptInput = { deployment_id: string; request_id: string; dispatch_id: string; effect_digest: string;
  state: "unknown" | "completed" | "no_effect"; receipt_digest: string };
type EffectReceiptResult = { state: "unknown" | "completed" | "no_effect"; receipt_digest: string; accounting_pending: boolean };

export function controlEffectAdmissionSchema(c: PolicyConnection): Statement[] {
  return [
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("effect_admissions")} (
      deployment_id TEXT NOT NULL, request_id TEXT NOT NULL, dispatch_id TEXT NOT NULL,
      actor_digest TEXT NOT NULL, policy_chain_digest TEXT NOT NULL, effect_digest TEXT NOT NULL,
      budget_request_id TEXT, prepared_epoch BIGINT NOT NULL, dispatch_epoch BIGINT,
      expires_at_ms BIGINT NOT NULL, nonce_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'dispatched', 'unknown', 'completed', 'no_effect')),
      dispatched_at_ms BIGINT, receipt_digest TEXT,
      PRIMARY KEY (deployment_id, request_id), UNIQUE (deployment_id, dispatch_id), UNIQUE (deployment_id, budget_request_id),
      FOREIGN KEY (deployment_id) REFERENCES ${c.table("deployments")}(deployment_id),
      FOREIGN KEY (deployment_id, budget_request_id) REFERENCES ${c.table("budget_requests")}(deployment_id, request_id))` },
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("effect_receipts")} (
      deployment_id TEXT NOT NULL, dispatch_id TEXT NOT NULL, receipt_digest TEXT NOT NULL, recorded_at_ms BIGINT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('unknown', 'completed', 'no_effect')),
      PRIMARY KEY (deployment_id, dispatch_id, receipt_digest),
      FOREIGN KEY (deployment_id, dispatch_id) REFERENCES ${c.table("effect_admissions")}(deployment_id, dispatch_id))` },
  ];
}

/** Internal trusted-executor admission. The service must resolve the current
 * authenticated policy chain before prepare AND dispatch. A dispatch commit is
 * the revocation linearization point: later revocation stops new admissions,
 * not a source/external request already admitted. There is no cross-DB atomicity.
 * A replay reports reconciliation required, never a second dispatch grant. */
export class ControlEffectAdmissions {
  constructor(private readonly c: PolicyConnection, private readonly budgets: ControlHardBudgets) {}

  /** Trusted executor reconciliation only. No nonce or new dispatch authority
   * is returned, and completed/uncertain effects remain inspectable after the
   * originating short-lived workload or parent permission expires. */
  async inspect(input: Omit<EffectAdmissionTarget, "expected_epoch">): Promise<{
    dispatch_id: string; state: EffectAdmissionState; receipt_digest?: string;
  }> {
    const target = normalize({ ...input, expected_epoch: 0 });
    const rows = await this.c.execute([{
      sql: `SELECT * FROM ${this.c.table("effect_admissions")}
        WHERE deployment_id = $1 AND request_id = $2 AND actor_digest = $3 AND policy_chain_digest = $4 AND effect_digest = $5`,
      values: targetValues(target), check: (rows) => { if (rows.length !== 1) fail("EFFECT_ADMISSION_INVALID"); },
    }]);
    const row = rows[0]![0]!, result = prepared(row);
    return { dispatch_id: result.dispatch_id, state: result.state,
      ...(row.receipt_digest == null ? {} : { receipt_digest: digest(row.receipt_digest) }) };
  }

  async prepare(input: EffectAdmissionTarget & { expires_at_ms: number; budget_request_id?: string }): Promise<PreparedEffectAdmission> {
    const target = normalize(input), expires = epoch(input.expires_at_ms);
    const budget = input.budget_request_id === undefined ? null : identifier(input.budget_request_id);
    const nonce = randomBytes(32).toString("base64url"), nonceDigest = canonicalJsonDigest({ nonce });
    const replay = new Error("existing admission"); let existing: PreparedEffectAdmission | undefined;
    const values = targetValues(target);
    const statements: Statement[] = [this.lock(target), {
      sql: `SELECT * FROM ${this.c.table("effect_admissions")} WHERE deployment_id = $1 AND request_id = $2`, values: values.slice(0, 2),
      check: (rows) => {
        const row = rows[0]; if (!row) return;
        if (row.actor_digest !== target.actor_digest || row.policy_chain_digest !== target.policy_chain_digest || row.effect_digest !== target.effect_digest
            || row.budget_request_id !== budget || epoch(row.expires_at_ms) !== expires) fail("EFFECT_ADMISSION_CONFLICT");
        if (row.state !== "prepared") { existing = prepared(row); throw replay; }
      },
    }, {
      sql: `SELECT ${this.c.nowMs} AS now_ms`, check: (rows) => {
        const now = epoch(rows[0]?.now_ms);
        if (expires <= now || expires > now + 900_000) fail("EFFECT_ADMISSION_EXPIRED");
      },
    }, ...(budget ? [this.budgetCheck(target, budget)] : []), {
      sql: `INSERT INTO ${this.c.table("effect_admissions")}
        (deployment_id, request_id, actor_digest, policy_chain_digest, effect_digest, dispatch_id, budget_request_id,
         prepared_epoch, expires_at_ms, nonce_digest, state)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'prepared')
        ON CONFLICT (deployment_id, request_id) DO UPDATE SET nonce_digest = excluded.nonce_digest
        RETURNING *`, values: [...values, randomUUID(), budget, target.expected_epoch, expires, nonceDigest],
    }];
    try {
      const rows = await this.c.execute(statements, "write");
      return { ...prepared(rows.at(-1)![0]!), nonce };
    } catch (error) { if (error === replay && existing) return existing; throw error; }
  }

  async dispatch(input: EffectAdmissionTarget & { nonce: string }): Promise<{
    dispatch_id: string; status: "authorized" | "not_authorized"; state: EffectAdmissionState; reconciliation_required: boolean;
  }> {
    const target = normalize(input);
    if (typeof input.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input.nonce)) fail("EFFECT_ADMISSION_INVALID");
    const values = [...targetValues(target), canonicalJsonDigest({ nonce: input.nonce })];
    const match = "deployment_id = $1 AND request_id = $2 AND actor_digest = $3 AND policy_chain_digest = $4 AND effect_digest = $5 AND nonce_digest = $6";
    const replay = new Error("already consumed"); let existing: PreparedEffectAdmission | undefined;
    const statements: Statement[] = [this.lock(target), {
      sql: `SELECT * FROM ${this.c.table("effect_admissions")} WHERE ${match}`, values,
      check: (rows) => {
        if (rows.length !== 1) fail("EFFECT_ADMISSION_INVALID");
        if (rows[0]!.state !== "prepared") { existing = prepared(rows[0]!); throw replay; }
      },
    }, {
      sql: `SELECT a.dispatch_id FROM ${this.c.table("effect_admissions")} a
        LEFT JOIN ${this.c.table("budget_requests")} b ON a.deployment_id = b.deployment_id AND a.budget_request_id = b.request_id
        WHERE a.deployment_id = $1 AND a.request_id = $2
          AND (a.budget_request_id IS NULL OR (b.state = 'reserved' AND b.effect_digest = a.effect_digest))`, values: values.slice(0, 2),
      check: (rows) => { if (rows.length !== 1) fail("EFFECT_BUDGET_NOT_RESERVED"); },
    }, {
      sql: `UPDATE ${this.c.table("effect_admissions")} SET state = 'dispatched', dispatch_epoch = $7, dispatched_at_ms = ${this.c.nowMs}
        WHERE ${match} AND state = 'prepared' AND expires_at_ms > ${this.c.nowMs} RETURNING dispatch_id`,
      values: [...values, target.expected_epoch], check: (rows) => { if (rows.length !== 1) fail("EFFECT_ADMISSION_EXPIRED"); },
    }];
    try {
      const rows = await this.c.execute(statements, "write");
      return { dispatch_id: identifier(rows.at(-1)![0]!.dispatch_id), status: "authorized", state: "dispatched", reconciliation_required: false };
    } catch (error) {
      if (error === replay && existing) return { dispatch_id: existing.dispatch_id, status: "not_authorized", state: existing.state,
        reconciliation_required: existing.state === "dispatched" || existing.state === "unknown" };
      throw error;
    }
  }

  /** The receipt comes from the executor, not a model statement. Record it
   * durably before settlement. A crash between these two transactions leaves
   * capacity held, never prematurely free; replay retries accounting safely. */
  async record(input: EffectReceiptInput): Promise<EffectReceiptResult> { return this.recordResult(input, false); }

  /** Cancellation proves absence of dispatch under the same writer lock. Once
   * dispatched, only executor evidence may resolve an effect as no_effect. */
  async cancelPrepared(input: Omit<EffectReceiptInput, "state" | "receipt_digest">): Promise<EffectReceiptResult> {
    return this.recordResult({ ...input, state: "no_effect", receipt_digest: canonicalJsonDigest({ operation: "cancel_prepared_effect", ...input }) }, true);
  }

  private async recordResult(input: EffectReceiptInput, preparedOnly: boolean): Promise<EffectReceiptResult> {
    const deployment = identifier(input.deployment_id), request = identifier(input.request_id), dispatch = identifier(input.dispatch_id);
    const effect = digest(input.effect_digest), proof = digest(input.receipt_digest), state = input.state;
    if (!["unknown", "completed", "no_effect"].includes(state)) fail("EFFECT_RECEIPT_INVALID");
    let budget: string | null = null, recorded = false;
    const replay = new Error("recorded effect receipt");
    try {
      await this.c.execute([{ sql: `UPDATE ${this.c.table("deployments")} SET epoch = epoch WHERE deployment_id = $1 RETURNING epoch`,
        values: [deployment], check: (rows) => { if (rows.length !== 1) fail("POLICY_REPOSITORY_UNAVAILABLE"); } }, {
        sql: `SELECT * FROM ${this.c.table("effect_admissions")} WHERE deployment_id = $1 AND request_id = $2 AND dispatch_id = $3 AND effect_digest = $4`,
        values: [deployment, request, dispatch, effect], check: (rows) => {
          const row = rows[0]; if (!row) fail("EFFECT_ADMISSION_INVALID");
          budget = row.budget_request_id == null ? null : identifier(row.budget_request_id);
          if (row.state === state && row.receipt_digest === proof) { recorded = true; throw replay; }
          if (preparedOnly && row.state !== "prepared") fail("EFFECT_ALREADY_DISPATCHED");
          if (row.state === "completed" || row.state === "no_effect" || (!preparedOnly && row.state === "prepared")) fail("EFFECT_RECEIPT_CONFLICT");
        },
      }, {
        sql: `INSERT INTO ${this.c.table("effect_receipts")} (deployment_id, dispatch_id, receipt_digest, recorded_at_ms, state)
          VALUES ($1, $2, $3, ${this.c.nowMs}, $4)`, values: [deployment, dispatch, proof, state],
      }, {
        sql: `UPDATE ${this.c.table("effect_admissions")} SET state = $3, receipt_digest = $4
          WHERE deployment_id = $1 AND request_id = $2 RETURNING request_id`, values: [deployment, request, state, proof],
        check: (rows) => { if (rows.length !== 1) fail("EFFECT_RECEIPT_CONFLICT"); },
      }], "write");
    } catch (error) { if (error !== replay || !recorded) throw error; }
    if (budget) {
      try { await this.budgets.settle({ deployment_id: deployment, request_id: budget, effect_digest: effect,
        state: state === "completed" ? "committed" : state === "no_effect" ? "released" : "unknown", receipt_digest: proof }); }
      catch { return { state, receipt_digest: proof, accounting_pending: true }; }
    }
    return { state, receipt_digest: proof, accounting_pending: false };
  }

  private lock(target: EffectAdmissionTarget): Statement {
    return { sql: `UPDATE ${this.c.table("deployments")} SET epoch = epoch WHERE deployment_id = $1 AND epoch = $2 RETURNING epoch`,
      values: [target.deployment_id, target.expected_epoch], check: (rows) => { if (rows.length !== 1) fail("POLICY_REVISION_CONFLICT"); } };
  }
  private budgetCheck(target: EffectAdmissionTarget, request: string): Statement {
    return { sql: `SELECT request_id FROM ${this.c.table("budget_requests")}
      WHERE deployment_id = $1 AND request_id = $2 AND effect_digest = $3 AND state = 'reserved'`, values: [target.deployment_id, request, target.effect_digest],
      check: (rows) => { if (rows.length !== 1) fail("EFFECT_BUDGET_NOT_RESERVED"); } };
  }
}
function normalize(input: EffectAdmissionTarget): EffectAdmissionTarget {
  return { deployment_id: identifier(input.deployment_id), request_id: identifier(input.request_id), expected_epoch: epoch(input.expected_epoch),
    actor_digest: digest(input.actor_digest), policy_chain_digest: digest(input.policy_chain_digest), effect_digest: digest(input.effect_digest) };
}
function targetValues(input: EffectAdmissionTarget): Array<string> {
  return [input.deployment_id, input.request_id, input.actor_digest, input.policy_chain_digest, input.effect_digest];
}
function prepared(row: Row): PreparedEffectAdmission {
  const state = row.state as EffectAdmissionState;
  if (!["prepared", "dispatched", "unknown", "completed", "no_effect"].includes(state)) fail("EFFECT_ADMISSION_INVALID");
  return { dispatch_id: identifier(row.dispatch_id), state, expires_at_ms: epoch(row.expires_at_ms) };
}
