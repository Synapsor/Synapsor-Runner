import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ControlPolicyScope, PolicyConnection, Row, Statement } from "./control-policy-types.js";
import { boundedJson, digest, epoch, fail, identifier, scopeKey } from "./control-policy-values.js";

export type ControlRuntimeProof = { deployment_id: string; proposal_id: string; scope: ControlPolicyScope;
  content_digest: string; content: unknown; expires_at_ms: number };

export function controlRuntimeProofSchema(c: PolicyConnection): Statement[] {
  return [{ sql: `CREATE TABLE IF NOT EXISTS ${c.table("runtime_proofs")} (
    deployment_id TEXT NOT NULL, proposal_id TEXT NOT NULL, scope_key TEXT NOT NULL,
    content_digest TEXT NOT NULL, content_json TEXT NOT NULL, expires_at_ms BIGINT NOT NULL, created_epoch BIGINT NOT NULL,
    PRIMARY KEY (deployment_id, proposal_id),
    FOREIGN KEY (deployment_id) REFERENCES ${c.table("deployments")}(deployment_id))` },
  { sql: `CREATE INDEX IF NOT EXISTS control_policy_scoped_runtime_proofs ON ${c.table("runtime_proofs")} (deployment_id, scope_key, expires_at_ms)` }];
}

/** Trusted service attestation of a verified workload, not authentication of
 * caller JSON. Store approved claims and policy bindings, NEVER bearer tokens.
 * Workers read from their configured repository and still re-resolve current
 * policy. This record alone grants no approval, budget or execution authority. */
export class ControlRuntimeProofs {
  constructor(private readonly c: PolicyConnection) {}
  async register(input: ControlRuntimeProof & { expected_epoch: number }): Promise<"registered" | "existing"> {
    const normalized = normalize(input), json = boundedJson(input.content, 65_536), expected = epoch(input.expected_epoch);
    if (canonicalJsonDigest(input.content) !== normalized.content_digest) fail("RUNTIME_PROOF_INTEGRITY_INVALID");
    const replay = new Error("existing runtime proof"); let exists = false;
    try {
      await this.c.execute([{
        sql: `UPDATE ${this.c.table("deployments")} SET epoch = epoch WHERE deployment_id = $1 AND epoch = $2 RETURNING epoch`,
        values: [normalized.deployment_id, expected], check: (rows) => { if (rows.length !== 1) fail("POLICY_REVISION_CONFLICT"); },
      }, {
        sql: `SELECT * FROM ${this.c.table("runtime_proofs")} WHERE deployment_id = $1 AND proposal_id = $2`,
        values: [normalized.deployment_id, normalized.proposal_id], check: (rows) => {
          if (!rows.length) return;
          const row = rows[0]!;
          if (row.scope_key !== scopeKey(normalized.scope) || row.content_digest !== normalized.content_digest
              || row.content_json !== json || epoch(row.expires_at_ms) !== normalized.expires_at_ms) fail("RUNTIME_PROOF_CONFLICT");
          exists = true; throw replay;
        },
      }, {
        sql: `SELECT ${this.c.nowMs} AS now_ms`, check: (rows) => {
          const now = epoch(rows[0]?.now_ms);
          if (normalized.expires_at_ms <= now || normalized.expires_at_ms > now + 900_000) fail("RUNTIME_PROOF_EXPIRED");
        },
      }, {
        sql: `INSERT INTO ${this.c.table("runtime_proofs")} (deployment_id, proposal_id, scope_key, content_digest, content_json, expires_at_ms, created_epoch)
          VALUES ($1, $2, $3, $4, $5, $6, $7)`, values: [normalized.deployment_id, normalized.proposal_id,
            scopeKey(normalized.scope), normalized.content_digest, json, normalized.expires_at_ms, expected],
      }], "write");
      return "registered";
    } catch (error) { if (error === replay && exists) return "existing"; throw error; }
  }

  async get(input: Pick<ControlRuntimeProof, "deployment_id" | "proposal_id" | "scope" | "content_digest">): Promise<ControlRuntimeProof> {
    const values = [identifier(input.deployment_id), identifier(input.proposal_id), scopeKey(input.scope), digest(input.content_digest)];
    const rows = await this.c.execute([{
      sql: `SELECT *, ${this.c.nowMs} AS now_ms FROM ${this.c.table("runtime_proofs")}
        WHERE deployment_id = $1 AND proposal_id = $2 AND scope_key = $3 AND content_digest = $4`, values,
      check: (rows) => {
        if (rows.length !== 1) fail("RUNTIME_PROOF_UNAVAILABLE");
        if (epoch(rows[0]!.expires_at_ms) <= epoch(rows[0]!.now_ms)) fail("RUNTIME_PROOF_EXPIRED");
      },
    }]);
    return decode(rows[0]![0]!);
  }
}
function normalize(input: ControlRuntimeProof): ControlRuntimeProof {
  return { deployment_id: identifier(input.deployment_id), proposal_id: identifier(input.proposal_id),
    scope: JSON.parse(scopeKey(input.scope)) as ControlPolicyScope, content_digest: digest(input.content_digest),
    content: input.content, expires_at_ms: epoch(input.expires_at_ms) };
}
function decode(row: Row): ControlRuntimeProof {
  const content = JSON.parse(String(row.content_json)) as unknown;
  if (canonicalJsonDigest(content) !== digest(row.content_digest)) fail("RUNTIME_PROOF_INTEGRITY_INVALID");
  return normalize({ deployment_id: String(row.deployment_id), proposal_id: String(row.proposal_id),
    scope: JSON.parse(String(row.scope_key)) as ControlPolicyScope, content_digest: String(row.content_digest), content, expires_at_ms: epoch(row.expires_at_ms) });
}
