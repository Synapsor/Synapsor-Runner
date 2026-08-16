import {
  type SQLInputValue,
} from "node:sqlite";
import {
  type LocalProposalState,
  type StoredProposal,
  type StoredEvidenceBundle,
} from "./domain-types.js";
import {
  isRecord,
} from "./common.js";
import {
  proposalFreshnessAuthority,
} from "./proposal-integrity.js";
import {
  inWhere,
  stringFromUnknown,
  stringFromPrincipal,
  lastIdentifier,
} from "./query-builders.js";
import {
  rowToQueryAudit,
} from "./record-codecs.js";
import {
  attentionEventsForProposalEvent,
  proposalReviewAttentionKey,
} from "./attention-domain.js";
import {
  ProposalStoreError,
} from "./errors.js";

import type {
  ProposalStoreCoreInternalMethods,
  ProposalStoreMethodContext,
} from "./sqlite-method-signatures.js";

export const proposalStoreInternalsMethods: ProposalStoreCoreInternalMethods & ThisType<ProposalStoreMethodContext> = {
  requireProposal(proposalId: string): StoredProposal {
      const proposal = this.getProposal(proposalId);
      if (!proposal) {
        throw new ProposalStoreError("PROPOSAL_NOT_FOUND", `proposal ${proposalId} not found`);
      }
      return proposal;
    },
  
  assertApprovalFreshness(
      proposal: StoredProposal,
      proofDigest: string | undefined,
      now: string,
    ): void {
      const authority = proposalFreshnessAuthority(proposal);
      if (!authority) {
        if (proofDigest !== undefined) {
          throw new ProposalStoreError(
            "FRESHNESS_PROOF_UNEXPECTED",
            `proposal ${proposal.proposal_id} does not require a freshness proof`,
          );
        }
        return;
      }
      if (!proofDigest) {
        throw new ProposalStoreError(
          "FRESHNESS_PROOF_REQUIRED",
          `proposal ${proposal.proposal_id} requires a fresh live proof before approval`,
        );
      }
      const proof = this.latestFreshnessProof(proposal.proposal_id);
      if (!proof || proof.proof_digest !== proofDigest) {
        throw new ProposalStoreError(
          "FRESHNESS_PROOF_MISSING",
          `the latest freshness proof for proposal ${proposal.proposal_id} was not supplied`,
        );
      }
      if (
        proof.proposal_hash !== proposal.proposal_hash
        || proof.proposal_version !== proposal.proposal_version
        || proof.dependency_set_digest !== authority.dependency_set_digest
      ) {
        throw new ProposalStoreError(
          "FRESHNESS_PROOF_AUTHORITY_MISMATCH",
          `freshness proof does not match proposal ${proposal.proposal_id}`,
        );
      }
      if (proof.result !== "fresh") {
        throw new ProposalStoreError(
          proof.result === "stale" ? "FRESHNESS_STALE" : "FRESHNESS_NOT_VERIFIED",
          `proposal ${proposal.proposal_id} freshness result is ${proof.result}`,
        );
      }
      if (Date.parse(proof.valid_until) < Date.parse(now)) {
        throw new ProposalStoreError(
          "FRESHNESS_PROOF_EXPIRED",
          `freshness proof for proposal ${proposal.proposal_id} has expired`,
        );
      }
      const used = this.db.prepare(`
        SELECT approval_id
        FROM approvals
        WHERE proposal_id = ? AND freshness_proof_digest = ?
        LIMIT 1
      `).get(proposal.proposal_id, proofDigest);
      if (isRecord(used)) {
        throw new ProposalStoreError(
          "FRESHNESS_PROOF_ALREADY_USED",
          `freshness proof for proposal ${proposal.proposal_id} already authorized a reviewer decision`,
        );
      }
    },
  
  setState(
      proposalId: string,
      state: LocalProposalState,
      actor: string,
      payload: Record<string, unknown>,
    ): void {
      const now = new Date().toISOString();
      this.transaction(() => {
        this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run(state, now, proposalId);
        this.appendEvent(proposalId, `proposal_${state}`, actor, payload);
      });
    },
  
  appendEvent(
      proposalId: string,
      kind: string,
      actor: string,
      payload: Record<string, unknown>,
    ): void {
      const append = () => {
        const createdAt = new Date().toISOString();
        const result = this.db.prepare(`
          INSERT INTO proposal_events (proposal_id, kind, actor, payload_json, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(proposalId, kind, actor, JSON.stringify(payload), createdAt);
        const proposal = this.requireProposal(proposalId);
        for (const event of attentionEventsForProposalEvent({
          proposal,
          proposal_event_id: String(result.lastInsertRowid),
          kind,
          actor,
          payload,
          environment: this.attentionEnvironment(),
          occurred_at: createdAt,
        })) {
          this.recordAttentionEventInternal(event);
        }
        if (proposal.state !== "pending_review") {
          this.resolveSatisfiedProposalReviewAttention(proposal, createdAt);
        }
      };
      if (this.db.isTransaction) append();
      else this.transaction(append);
    },
  
  attentionEnvironment(): string {
      const context = this.getRunnerState("attention_context");
      const environment = context?.environment;
      return typeof environment === "string" && /^(development|staging|production|unknown)$/.test(environment)
        ? environment
        : "unknown";
    },
  
  resolveSatisfiedProposalReviewAttention(
      proposal: StoredProposal,
      now: string,
    ): void {
      const attentionKey = proposalReviewAttentionKey(proposal, this.attentionEnvironment());
      const pending = this.db.prepare(`
        SELECT COUNT(DISTINCT p.proposal_id) AS count
        FROM attention_events ae
        JOIN proposals p ON p.proposal_id = ae.proposal_id
        WHERE ae.attention_key = ?
          AND p.state = 'pending_review'
      `).get(attentionKey);
      if (isRecord(pending) && Number(pending.count ?? 0) > 0) return;
      this.db.prepare(`
        UPDATE attention_items
        SET status = 'resolved', resolved_at = ?, last_seen_at = MAX(last_seen_at, ?)
        WHERE attention_key = ?
          AND status IN ('open', 'acknowledged')
      `).run(now, now, attentionKey);
    },
  
  queryAudit(proposalId: string): Record<string, unknown>[] {
      const rows = this.db
        .prepare("SELECT * FROM query_audit WHERE proposal_id = ? ORDER BY audit_id ASC")
        .all(proposalId);
      const records: Record<string, unknown>[] = [];
      for (const row of rows) {
        if (!isRecord(row)) continue;
        records.push({
          audit_id: Number(row.audit_id),
          proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
          evidence_bundle_id: row.evidence_bundle_id == null ? undefined : String(row.evidence_bundle_id),
          source_id: String(row.source_id),
          query_fingerprint: String(row.query_fingerprint),
          table_name: String(row.table_name),
          row_count: Number(row.row_count),
          payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
          created_at: String(row.created_at),
        });
      }
      return records;
    },
  
  queryAuditByEvidence(evidenceBundleId: string): Record<string, unknown>[] {
      const rows = this.db
        .prepare("SELECT * FROM query_audit WHERE evidence_bundle_id = ? ORDER BY audit_id ASC")
        .all(evidenceBundleId);
      return rows.map(rowToQueryAudit).filter((record): record is Record<string, unknown> => record !== undefined);
    },
  
  evidence(proposalId: string): Record<string, unknown>[] {
      const rows = this.db
        .prepare("SELECT * FROM evidence_bundles WHERE proposal_id = ? ORDER BY created_at ASC")
        .all(proposalId);
      const records: Record<string, unknown>[] = [];
      for (const row of rows) {
        if (!isRecord(row)) continue;
        records.push({
          evidence_bundle_id: String(row.evidence_bundle_id),
          proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
          tenant_id: String(row.tenant_id),
          payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
          items: this.evidenceItems(String(row.evidence_bundle_id)),
          query_audit: this.queryAuditByEvidence(String(row.evidence_bundle_id)),
          created_at: String(row.created_at),
        });
      }
      return records;
    },
  
  evidenceItems(evidenceBundleId: string): Record<string, unknown>[] {
      const rows = this.db
        .prepare("SELECT * FROM evidence_items WHERE evidence_bundle_id = ? ORDER BY evidence_item_id ASC")
        .all(evidenceBundleId);
      const records: Record<string, unknown>[] = [];
      for (const row of rows) {
        if (!isRecord(row)) continue;
        records.push({
          evidence_item_id: Number(row.evidence_item_id),
          evidence_bundle_id: String(evidenceBundleId),
          item: JSON.parse(String(row.item_json)) as Record<string, unknown>,
          created_at: String(row.created_at),
        });
      }
      return records;
    },
  
  evidenceMetadata(input: {
      proposal?: StoredProposal;
      payload: Record<string, unknown>;
      items: Record<string, unknown>[];
    }): {
      principal?: string;
      capability?: string;
      source_id?: string;
      source_table?: string;
      business_object?: string;
      object_id?: string;
      query_fingerprint?: string;
    } {
      if (input.proposal) {
        return {
          principal: input.proposal.change_set.principal.id,
          capability: input.proposal.action,
          source_id: input.proposal.source_id,
          source_table: `${input.proposal.source_schema}.${input.proposal.source_table}`,
          business_object: input.proposal.business_object,
          object_id: input.proposal.object_id,
          query_fingerprint: input.proposal.change_set.evidence.query_fingerprint,
        };
      }
      const firstItem = input.items.find(isRecord) as Record<string, unknown> | undefined;
      const primaryKey = isRecord(firstItem?.primary_key) ? firstItem.primary_key : undefined;
      const principal = stringFromPrincipal(input.payload.principal);
      const table = stringFromUnknown(input.payload.source_table)
        ?? stringFromUnknown(input.payload.target)
        ?? stringFromUnknown(firstItem?.table);
      return {
        principal,
        capability: stringFromUnknown(input.payload.capability),
        source_id: stringFromUnknown(input.payload.source_id) ?? stringFromUnknown(firstItem?.source_id),
        source_table: table,
        business_object: table ? lastIdentifier(table) : undefined,
        object_id: primaryKey ? stringFromUnknown(primaryKey.value) : undefined,
        query_fingerprint: stringFromUnknown(input.payload.query_fingerprint),
      };
    },
  
  queryAuditMetadata(input: {
      proposal?: StoredProposal;
      evidence?: StoredEvidenceBundle;
      payload: Record<string, unknown>;
    }): {
      tenant_id?: string;
      principal?: string;
      capability?: string;
      business_object?: string;
      object_id?: string;
      primary_key_value?: string;
    } {
      if (input.proposal) {
        return {
          tenant_id: input.proposal.tenant_id,
          principal: input.proposal.change_set.principal.id,
          capability: input.proposal.action,
          business_object: input.proposal.business_object,
          object_id: input.proposal.object_id,
          primary_key_value: "value" in input.proposal.change_set.source.primary_key
            ? String(input.proposal.change_set.source.primary_key.value)
            : input.proposal.object_id,
        };
      }
      const firstItem = input.evidence?.items.find((item) => isRecord(item.item))?.item as Record<string, unknown> | undefined;
      const primaryKey = isRecord(firstItem?.primary_key) ? firstItem.primary_key : undefined;
      return {
        tenant_id: input.evidence?.tenant_id ?? stringFromUnknown(input.payload.tenant_id),
        principal: input.evidence?.principal ?? stringFromPrincipal(input.payload.principal),
        capability: input.evidence?.capability ?? stringFromUnknown(input.payload.capability),
        business_object: input.evidence?.business_object ?? stringFromUnknown(input.payload.business_object),
        object_id: input.evidence?.object_id ?? stringFromUnknown(input.payload.object_id),
        primary_key_value: primaryKey ? stringFromUnknown(primaryKey.value) : input.evidence?.object_id ?? stringFromUnknown(input.payload.primary_key_value),
      };
    },
  
  countTable(table: string): number {
      return this.countWhere(table, "1 = 1", []);
    },
  
  countWhere(table: string, where: string, params: SQLInputValue[]): number {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params);
      return isRecord(row) ? Number(row.count ?? 0) : 0;
    },
  
  numberValue(sql: string): number {
      const row = this.db.prepare(sql).get();
      if (!isRecord(row)) return 0;
      const value = Object.values(row)[0];
      return typeof value === "number" ? value : Number(value ?? 0);
    },
  
  stringColumn(sql: string, params: SQLInputValue[], column: string): string[] {
      return this.db.prepare(sql).all(...params)
        .map((row) => isRecord(row) ? row[column] : undefined)
        .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
        .map(String);
    },
  
  evidenceIdsForPrune(cutoffIso: string, proposalIds: string[]): string[] {
      const proposalWhere = inWhere("proposal_id", proposalIds);
      if (!proposalWhere) {
        return this.stringColumn("SELECT evidence_bundle_id FROM evidence_bundles WHERE created_at < ?", [cutoffIso], "evidence_bundle_id");
      }
      return this.stringColumn(
        `SELECT evidence_bundle_id FROM evidence_bundles WHERE created_at < ? OR ${proposalWhere.sql}`,
        [cutoffIso, ...proposalWhere.params],
        "evidence_bundle_id",
      );
    },
  
  transaction<T>(fn: () => T): T {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    },
};
