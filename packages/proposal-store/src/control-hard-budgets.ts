import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ControlPolicyScope, PolicyConnection, Row, Statement } from "./control-policy-types.js";
import { digest, epoch, fail, identifier, scopeKey } from "./control-policy-values.js";

export type HardBudgetAccount = { scope: ControlPolicyScope; meter: string; unit: string; scale: number };
export type HardBudgetLimit = HardBudgetAccount & { limit: number; window_ms: number };
export type HardBudgetReservation = {
  deployment_id: string; expected_epoch: number; request_id: string; effect_digest: string; policy_chain_digest: string;
  accounts: Array<HardBudgetLimit & { amount: number }>;
};
export type HardBudgetState = "reserved" | "unknown" | "committed" | "released";
export type HardBudgetReceipt = { request_id: string; state: HardBudgetState; receipt_digest?: string;
  status: "reserved" | "existing" | "settled"; execution_authorized: false };

export function controlHardBudgetSchema(c: PolicyConnection): Statement[] {
  return [
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("budget_accounts")} (
      deployment_id TEXT NOT NULL, scope_key TEXT NOT NULL, meter TEXT NOT NULL, unit TEXT NOT NULL, scale BIGINT NOT NULL CHECK (scale > 0),
      PRIMARY KEY (deployment_id, scope_key, meter), FOREIGN KEY (deployment_id) REFERENCES ${c.table("deployments")}(deployment_id))` },
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("budget_requests")} (
      deployment_id TEXT NOT NULL, request_id TEXT NOT NULL, effect_digest TEXT NOT NULL, payload_digest TEXT NOT NULL,
      policy_chain_digest TEXT NOT NULL, authorization_epoch BIGINT NOT NULL, account_count INTEGER NOT NULL CHECK (account_count BETWEEN 1 AND 8),
      state TEXT NOT NULL CHECK (state IN ('reserved', 'unknown', 'committed', 'released')), reserved_at_ms BIGINT NOT NULL,
      receipt_digest TEXT, PRIMARY KEY (deployment_id, request_id),
      FOREIGN KEY (deployment_id) REFERENCES ${c.table("deployments")}(deployment_id))` },
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("budget_entries")} (
      deployment_id TEXT NOT NULL, scope_key TEXT NOT NULL, meter TEXT NOT NULL, request_id TEXT NOT NULL,
      amount BIGINT NOT NULL CHECK (amount > 0), state TEXT NOT NULL CHECK (state IN ('reserved', 'unknown', 'committed', 'released')),
      window_ms BIGINT NOT NULL CHECK (window_ms > 0),
      settled_at_ms BIGINT,
      PRIMARY KEY (deployment_id, scope_key, meter, request_id),
      FOREIGN KEY (deployment_id, scope_key, meter) REFERENCES ${c.table("budget_accounts")}(deployment_id, scope_key, meter),
      FOREIGN KEY (deployment_id, request_id) REFERENCES ${c.table("budget_requests")}(deployment_id, request_id))` },
    { sql: `CREATE INDEX IF NOT EXISTS control_policy_budget_usage ON ${c.table("budget_entries")}
      (deployment_id, scope_key, meter, state, settled_at_ms)` },
    { sql: `CREATE INDEX IF NOT EXISTS control_policy_budget_request_entries ON ${c.table("budget_entries")} (deployment_id, request_id)` },
    { sql: `CREATE TABLE IF NOT EXISTS ${c.table("budget_receipts")} (
      deployment_id TEXT NOT NULL, request_id TEXT NOT NULL, receipt_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('unknown', 'committed', 'released')), recorded_at_ms BIGINT NOT NULL,
      PRIMARY KEY (deployment_id, request_id, receipt_digest),
      FOREIGN KEY (deployment_id, request_id) REFERENCES ${c.table("budget_requests")}(deployment_id, request_id))` },
  ];
}

/** Internal accounting, not a runtime tool or authorization service. Callers
 * must derive scopes/meters/limits from current authenticated policy. A held
 * reservation NEVER replaces current policy, approval, or execution admission.
 * Only the trusted executor reconciles outcomes; unknown is not cancellation. */
export class ControlHardBudgets {
  constructor(private readonly c: PolicyConnection) {}

  async reserve(input: HardBudgetReservation): Promise<HardBudgetReceipt> {
    const deployment = identifier(input.deployment_id), request = identifier(input.request_id), effect = digest(input.effect_digest);
    const expected = epoch(input.expected_epoch), chain = digest(input.policy_chain_digest);
    if (!Array.isArray(input.accounts) || input.accounts.length < 1 || input.accounts.length > 8) fail("BUDGET_ACCOUNT_LIMIT");
    const accounts = input.accounts.map((value) => ({ ...normalizeLimit(value), amount: positive(value.amount) }))
      .sort((a, b) => accountId(a).localeCompare(accountId(b)));
    if (new Set(accounts.map(accountId)).size !== accounts.length) fail("BUDGET_DUPLICATE_ACCOUNT");
    const payload = canonicalJsonDigest({ effect_digest: effect,
      accounts: accounts.map(({ limit: _limit, window_ms: _window, ...value }) => value) });
    const replay = new Error("existing reservation");
    let existing: HardBudgetReceipt | undefined;
    const statements: Statement[] = [this.lock(deployment, expected), {
      sql: `SELECT * FROM ${this.c.table("budget_requests")} WHERE deployment_id = $1 AND request_id = $2`, values: [deployment, request],
      check: (rows) => {
        if (!rows.length) return;
        if (rows[0]!.payload_digest !== payload || rows[0]!.effect_digest !== effect) fail("BUDGET_REQUEST_CONFLICT");
        existing = receipt(rows[0]!, "existing"); throw replay;
      },
    }, {
      sql: `INSERT INTO ${this.c.table("budget_requests")}
        (deployment_id, request_id, effect_digest, payload_digest, policy_chain_digest, authorization_epoch, account_count, state, reserved_at_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'reserved', ${this.c.nowMs})`,
      values: [deployment, request, effect, payload, chain, expected, accounts.length],
    }];
    for (const account of accounts) {
      const key = [deployment, account.scope_key, account.meter];
      statements.push({
        sql: `INSERT INTO ${this.c.table("budget_accounts")} (deployment_id, scope_key, meter, unit, scale)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (deployment_id, scope_key, meter) DO NOTHING`,
        values: [...key, account.unit, account.scale],
      }, this.accountCheck(deployment, account), this.usage(deployment, account, (committed, reserved) => {
        if (account.amount > account.limit - committed - reserved) fail("HARD_BUDGET_EXCEEDED");
      }), {
        sql: `INSERT INTO ${this.c.table("budget_entries")} (deployment_id, scope_key, meter, request_id, amount, window_ms, state)
          VALUES ($1, $2, $3, $4, $5, $6, 'reserved')`, values: [...key, request, account.amount, account.window_ms],
      });
    }
    try { await this.c.execute(statements, "write"); }
    catch (error) { if (error === replay && existing) return existing; throw error; }
    return { request_id: request, state: "reserved", status: "reserved", execution_authorized: false };
  }

  async inspect(input: { deployment_id: string; account: HardBudgetLimit }): Promise<{ committed: number; reserved: number; available: number }> {
    const deployment = identifier(input.deployment_id), account = normalizeLimit(input.account);
    let result = { committed: 0, reserved: 0, available: account.limit };
    await this.c.execute([this.accountCheck(deployment, account, true), this.usage(deployment, account, (committed, reserved) => {
      result = { committed, reserved, available: Math.max(0, account.limit - committed - reserved) };
    })]);
    return result;
  }

  /** Settlement records a real effect even after policy revocation. `released`
   * requires trusted evidence that no effect occurred; a timeout is `unknown`.
   * Terminal outcomes cannot be rewritten or refunded by changing policy. */
  async settle(input: { deployment_id: string; request_id: string; effect_digest: string;
    state: Exclude<HardBudgetState, "reserved">; receipt_digest: string }): Promise<HardBudgetReceipt> {
    const deployment = identifier(input.deployment_id), request = identifier(input.request_id), effect = digest(input.effect_digest);
    const proof = digest(input.receipt_digest), state = input.state;
    if (!["committed", "unknown", "released"].includes(state)) fail("BUDGET_SETTLEMENT_INVALID");
    let count = 0, existing: HardBudgetReceipt | undefined;
    const replay = new Error("recorded settlement");
    const statements: Statement[] = [this.lock(deployment), {
      sql: `SELECT * FROM ${this.c.table("budget_requests")} WHERE deployment_id = $1 AND request_id = $2`, values: [deployment, request],
      check: (rows) => {
        const row = rows[0];
        if (!row || row.effect_digest !== effect) fail("BUDGET_REQUEST_CONFLICT");
        count = epoch(row.account_count);
        if (row.state === state && row.receipt_digest === proof) { existing = receipt(row, "existing"); throw replay; }
        if (row.state === "committed" || row.state === "released") fail("BUDGET_SETTLEMENT_CONFLICT");
      },
    }, {
      sql: `INSERT INTO ${this.c.table("budget_receipts")} (deployment_id, request_id, receipt_digest, state, recorded_at_ms)
        VALUES ($1, $2, $3, $4, ${this.c.nowMs})`, values: [deployment, request, proof, state],
    }, {
      sql: `UPDATE ${this.c.table("budget_entries")} SET state = $3, settled_at_ms = ${state === "unknown" ? "NULL" : this.c.nowMs}
        WHERE deployment_id = $1 AND request_id = $2 AND state IN ('reserved', 'unknown') RETURNING meter`, values: [deployment, request, state],
      check: (rows) => { if (rows.length !== count) fail("BUDGET_SETTLEMENT_CONFLICT"); },
    }, {
      sql: `UPDATE ${this.c.table("budget_requests")} SET state = $3, receipt_digest = $4
        WHERE deployment_id = $1 AND request_id = $2 AND state IN ('reserved', 'unknown') RETURNING *`, values: [deployment, request, state, proof],
      check: (rows) => { if (rows.length !== 1) fail("BUDGET_SETTLEMENT_CONFLICT"); },
    }];
    try { const rows = await this.c.execute(statements, "write"); return receipt(rows.at(-1)![0]!, "settled"); }
    catch (error) { if (error === replay && existing) return existing; throw error; }
  }

  private lock(deployment: string, expected?: number): Statement {
    return { sql: `UPDATE ${this.c.table("deployments")} SET epoch = epoch WHERE deployment_id = $1${expected === undefined ? "" : " AND epoch = $2"} RETURNING epoch`,
      values: [deployment, ...(expected === undefined ? [] : [expected])],
      check: (rows) => { if (rows.length !== 1) fail("POLICY_REVISION_CONFLICT"); } };
  }
  private accountCheck(deployment: string, account: NormalizedLimit, allowMissing = false): Statement {
    return { sql: `SELECT unit, scale FROM ${this.c.table("budget_accounts")} WHERE deployment_id = $1 AND scope_key = $2 AND meter = $3`,
      values: [deployment, account.scope_key, account.meter], check: (rows) => {
        if (allowMissing && !rows.length) return;
        if (rows.length !== 1 || rows[0]!.unit !== account.unit || epoch(rows[0]!.scale) !== account.scale) fail("BUDGET_UNIT_MISMATCH");
      } };
  }
  private usage(deployment: string, account: NormalizedLimit, check: (committed: number, reserved: number) => void): Statement {
    // A shorter new policy window cannot erase the reservation's original
    // consumption lifetime. Longer current windows still include old usage.
    return { sql: `SELECT state, COALESCE(SUM(amount), 0) AS amount FROM ${this.c.table("budget_entries")}
        WHERE deployment_id = $1 AND scope_key = $2 AND meter = $3
          AND (state IN ('reserved', 'unknown') OR (state = 'committed'
            AND settled_at_ms > ${this.c.nowMs} - CASE WHEN window_ms > $4 THEN window_ms ELSE $4 END)) GROUP BY state`,
      values: [deployment, account.scope_key, account.meter, account.window_ms], check: (rows) => {
        const committed = rows.filter((row) => row.state === "committed").reduce((n, row) => n + epoch(row.amount), 0);
        const reserved = rows.filter((row) => row.state !== "committed").reduce((n, row) => n + epoch(row.amount), 0);
        if (!Number.isSafeInteger(committed + reserved)) fail("BUDGET_USAGE_OVERFLOW");
        check(committed, reserved);
      } };
  }
}
type NormalizedLimit = { scope_key: string; meter: string; unit: string; scale: number; limit: number; window_ms: number };
function normalizeLimit(input: HardBudgetLimit): NormalizedLimit {
  const limit = input.limit;
  if (!Number.isSafeInteger(limit) || limit < 0) fail("BUDGET_VALUE_INVALID");
  return { scope_key: scopeKey(input.scope), meter: identifier(input.meter), unit: identifier(input.unit), scale: positive(input.scale),
    limit, window_ms: positive(input.window_ms, 366 * 86_400_000) };
}
function positive(value: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail("BUDGET_VALUE_INVALID");
  return value;
}
function accountId(value: { scope_key: string; meter: string }): string { return canonicalJsonDigest({ scope_key: value.scope_key, meter: value.meter }); }
function receipt(row: Row, status: HardBudgetReceipt["status"]): HardBudgetReceipt {
  if (!["reserved", "unknown", "committed", "released"].includes(String(row.state))) fail("BUDGET_STATE_INVALID");
  return { request_id: identifier(row.request_id), state: row.state as HardBudgetState, status,
    ...(row.receipt_digest == null ? {} : { receipt_digest: digest(row.receipt_digest) }), execution_authorized: false };
}
