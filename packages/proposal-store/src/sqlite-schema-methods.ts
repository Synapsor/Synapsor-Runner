import {
  type SQLInputValue,
} from "node:sqlite";
import {
  parseChangeSet,
} from "@synapsor-runner/protocol";
import {
  type StoreStats,
  type StorePruneResult,
} from "./domain-types.js";
import {
  isRecord,
} from "./common.js";
import {
  inWhere,
} from "./query-builders.js";

import type {
  ProposalStoreSchemaMethods,
  ProposalStoreSchemaInternalMethods,
  ProposalStoreMethodContext,
} from "./sqlite-method-signatures.js";

export const proposalStoreSchemaMethods: ProposalStoreSchemaMethods & ProposalStoreSchemaInternalMethods & ThisType<ProposalStoreMethodContext> = {
  close(): void {
      this.db.close();
    },
  
  stats(): StoreStats {
      const pageCount = this.numberValue("PRAGMA page_count");
      const pageSize = this.numberValue("PRAGMA page_size");
      return {
        path: this.path,
        proposals: this.countTable("proposals"),
        evidence_bundles: this.countTable("evidence_bundles"),
        evidence_items: this.countTable("evidence_items"),
        query_audit: this.countTable("query_audit"),
        writeback_receipts: this.countTable("writeback_receipts"),
        writeback_jobs: this.countTable("writeback_jobs"),
        writeback_intents: this.countTable("writeback_intents"),
        idempotency_receipts: this.countTable("idempotency_receipts"),
        replay_records: this.countTable("replay_records"),
        approvals: this.countTable("approvals"),
        proposal_events: this.countTable("proposal_events"),
        shadow_human_actions: this.countTable("shadow_human_actions"),
        shadow_studies: this.countTable("shadow_studies"),
        shadow_study_cases: this.countTable("shadow_study_cases"),
        shadow_outcomes: this.countTable("shadow_outcomes"),
        worker_queue: this.countTable("worker_queue"),
        attention_events: this.countTable("attention_events"),
        attention_items: this.countTable("attention_items"),
        notification_deliveries: this.countTable("notification_deliveries"),
        policy_recommendations: this.countTable("policy_recommendations"),
        page_count: pageCount,
        page_size: pageSize,
        approx_bytes: pageCount * pageSize,
      };
    },
  
  vacuum(): void {
      this.db.exec("VACUUM");
    },
  
  pruneBefore(cutoffIso: string, options: { dryRun?: boolean } = {}): StorePruneResult {
      const dryRun = options.dryRun !== false;
      const proposalIds = this.stringColumn(
        `SELECT proposal_id FROM proposals
         WHERE created_at < ? AND state IN ('applied', 'conflict', 'rejected', 'canceled')
           AND NOT EXISTS (
             SELECT 1 FROM cloud_outbox
             WHERE cloud_outbox.proposal_id = proposals.proposal_id
               AND cloud_outbox.status <> 'acknowledged'
           )`,
        [cutoffIso],
        "proposal_id",
      );
      const evidenceIds = this.evidenceIdsForPrune(cutoffIso, proposalIds);
      const deleted: Record<string, number> = {};
      const run = (table: string, where: string, params: SQLInputValue[]) => {
        deleted[table] = this.countWhere(table, where, params);
        if (!dryRun && deleted[table] > 0) this.db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params);
      };
      const proposalWhere = inWhere("proposal_id", proposalIds);
      const evidenceWhere = inWhere("evidence_bundle_id", evidenceIds);
      this.transaction(() => {
        if (proposalWhere) {
          run("cloud_outbox", `${proposalWhere.sql} AND status = 'acknowledged'`, proposalWhere.params);
          run("cloud_governance_events", proposalWhere.sql, proposalWhere.params);
          run("idempotency_receipts", proposalWhere.sql, proposalWhere.params);
          run("writeback_receipts", proposalWhere.sql, proposalWhere.params);
          run("writeback_jobs", proposalWhere.sql, proposalWhere.params);
          run("writeback_intents", proposalWhere.sql, proposalWhere.params);
          run("approvals", proposalWhere.sql, proposalWhere.params);
          run("proposal_events", proposalWhere.sql, proposalWhere.params);
          run("shadow_outcomes", proposalWhere.sql, proposalWhere.params);
          run("shadow_study_cases", proposalWhere.sql, proposalWhere.params);
          run("shadow_human_actions", proposalWhere.sql, proposalWhere.params);
          run("worker_queue", proposalWhere.sql, proposalWhere.params);
          run("replay_records", proposalWhere.sql, proposalWhere.params);
        } else {
          for (const table of ["cloud_outbox", "cloud_governance_events", "idempotency_receipts", "writeback_receipts", "writeback_jobs", "writeback_intents", "approvals", "proposal_events", "shadow_outcomes", "shadow_study_cases", "shadow_human_actions", "worker_queue", "replay_records"]) {
            deleted[table] = 0;
          }
        }
        const auditClauses: string[] = [];
        const auditParams: SQLInputValue[] = [];
        if (proposalWhere) {
          auditClauses.push(proposalWhere.sql);
          auditParams.push(...proposalWhere.params);
        }
        if (evidenceWhere) {
          auditClauses.push(evidenceWhere.sql);
          auditParams.push(...evidenceWhere.params);
        }
        auditClauses.push("(proposal_id IS NULL AND evidence_bundle_id IS NULL AND created_at < ?)");
        auditParams.push(cutoffIso);
        run("query_audit", auditClauses.map((clause) => `(${clause})`).join(" OR "), auditParams);
        if (evidenceWhere) {
          run("evidence_items", evidenceWhere.sql, evidenceWhere.params);
          run("evidence_bundles", evidenceWhere.sql, evidenceWhere.params);
        } else {
          deleted.evidence_items = 0;
          deleted.evidence_bundles = 0;
        }
        if (proposalWhere) run("proposals", proposalWhere.sql, proposalWhere.params);
        else deleted.proposals = 0;
      });
      return { cutoff: cutoffIso, dry_run: dryRun, deleted };
    },
  
  migrate(): void {
      this.db.exec(`
        PRAGMA foreign_keys = ON;
  
        CREATE TABLE IF NOT EXISTS proposal_store_schema (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL
        );
  
        CREATE TABLE IF NOT EXISTS proposals (
          proposal_id TEXT PRIMARY KEY,
          proposal_version INTEGER NOT NULL,
          proposal_hash TEXT NOT NULL,
          action TEXT NOT NULL,
          state TEXT NOT NULL,
          tenant_id TEXT NOT NULL,
          business_object TEXT NOT NULL,
          object_id TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          source_id TEXT NOT NULL,
          source_schema TEXT NOT NULL,
          source_table TEXT NOT NULL,
          source_database_mutated INTEGER NOT NULL DEFAULT 0,
          change_set_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
  
        CREATE TABLE IF NOT EXISTS proposal_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          proposal_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          actor TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS approvals (
          approval_id INTEGER PRIMARY KEY AUTOINCREMENT,
          proposal_id TEXT NOT NULL,
          proposal_version INTEGER NOT NULL,
          proposal_hash TEXT NOT NULL,
          approver TEXT NOT NULL,
          status TEXT NOT NULL,
          reason TEXT,
          identity_json TEXT,
          decision_hash TEXT,
          signature TEXT,
          integrity_hash TEXT,
          freshness_proof_digest TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS writeback_receipts (
          receipt_id INTEGER PRIMARY KEY AUTOINCREMENT,
          writeback_job_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          runner_id TEXT NOT NULL,
          status TEXT NOT NULL,
          idempotency_key TEXT NOT NULL,
          source_database_mutated INTEGER NOT NULL,
          receipt_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE (writeback_job_id, idempotency_key),
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS evidence_bundles (
          evidence_bundle_id TEXT PRIMARY KEY,
          proposal_id TEXT,
          tenant_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS evidence_items (
          evidence_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
          evidence_bundle_id TEXT NOT NULL,
          item_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (evidence_bundle_id) REFERENCES evidence_bundles(evidence_bundle_id)
        );
  
        CREATE TABLE IF NOT EXISTS query_audit (
          audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
          proposal_id TEXT,
          evidence_bundle_id TEXT,
          source_id TEXT NOT NULL,
          query_fingerprint TEXT NOT NULL,
          table_name TEXT NOT NULL,
          row_count INTEGER NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id),
          FOREIGN KEY (evidence_bundle_id) REFERENCES evidence_bundles(evidence_bundle_id)
        );
  
        CREATE TABLE IF NOT EXISTS writeback_jobs (
          writeback_job_id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL,
          proposal_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          job_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS idempotency_receipts (
          idempotency_key TEXT PRIMARY KEY,
          writeback_job_id TEXT NOT NULL,
          proposal_id TEXT NOT NULL,
          receipt_status TEXT NOT NULL,
          receipt_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (writeback_job_id) REFERENCES writeback_jobs(writeback_job_id),
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS writeback_intents (
          intent_id TEXT PRIMARY KEY,
          idempotency_key TEXT UNIQUE NOT NULL,
          writeback_job_id TEXT UNIQUE NOT NULL,
          proposal_id TEXT NOT NULL,
          proposal_hash TEXT NOT NULL,
          runner_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          status TEXT NOT NULL,
          intent_json TEXT NOT NULL,
          result_json TEXT,
          reconciliation_reason TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS replay_records (
          replay_id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS shadow_human_actions (
          action_id INTEGER PRIMARY KEY AUTOINCREMENT,
          proposal_id TEXT NOT NULL,
          actor TEXT NOT NULL,
          patch_json TEXT NOT NULL,
          notes TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS shadow_studies (
          study_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          selected_capabilities_json TEXT NOT NULL,
          starts_at TEXT,
          ends_at TEXT,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
  
        CREATE TABLE IF NOT EXISTS shadow_study_cases (
          case_id TEXT PRIMARY KEY,
          study_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          proposal_id TEXT,
          tenant_id TEXT NOT NULL,
          principal TEXT,
          capability TEXT NOT NULL,
          business_object TEXT NOT NULL,
          object_id TEXT NOT NULL,
          evidence_bundle_id TEXT,
          proposed_effect_json TEXT,
          agent_result TEXT NOT NULL,
          decision_reason TEXT,
          risk_score REAL,
          amount_value REAL,
          created_at TEXT NOT NULL,
          UNIQUE(study_id, request_id, tenant_id, business_object, object_id),
          FOREIGN KEY (study_id) REFERENCES shadow_studies(study_id),
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS shadow_outcomes (
          outcome_id TEXT PRIMARY KEY,
          study_id TEXT NOT NULL,
          request_id TEXT NOT NULL,
          proposal_id TEXT,
          tenant_id TEXT NOT NULL,
          business_object TEXT NOT NULL,
          object_id TEXT NOT NULL,
          actor TEXT NOT NULL,
          disposition TEXT NOT NULL,
          actual_effect_json TEXT,
          occurred_at TEXT NOT NULL,
          source TEXT NOT NULL,
          reference TEXT,
          reason TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (study_id) REFERENCES shadow_studies(study_id),
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS runner_state (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
  
        CREATE TABLE IF NOT EXISTS cloud_outbox (
          event_id TEXT PRIMARY KEY,
          proposal_id TEXT,
          sequence INTEGER NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL,
          next_attempt_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_expires_at TEXT,
          last_error_code TEXT,
          sent_at TEXT,
          acknowledged_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS cloud_governance_events (
          event_id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL,
          cloud_proposal_id TEXT,
          kind TEXT NOT NULL,
          state TEXT NOT NULL,
          authority TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          integrity_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE TABLE IF NOT EXISTS policy_recommendations (
          recommendation_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          capability TEXT NOT NULL,
          policy TEXT NOT NULL,
          base_contract_digest TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          integrity_hash TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
  
        CREATE TABLE IF NOT EXISTS attention_events (
          event_id TEXT PRIMARY KEY,
          schema_version TEXT NOT NULL,
          event_type TEXT NOT NULL,
          severity TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          environment TEXT NOT NULL,
          proposal_id TEXT,
          job_id TEXT,
          operation_id TEXT,
          correlation_id TEXT,
          capability TEXT,
          contract_digest TEXT,
          attention_key TEXT,
          attention_required INTEGER NOT NULL,
          immediate_default INTEGER NOT NULL,
          summary TEXT NOT NULL,
          approval_source TEXT,
          worker_state TEXT,
          failure_class TEXT,
          expires_at TEXT,
          workbench_path TEXT,
          details_json TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
  
        CREATE TABLE IF NOT EXISTS attention_items (
          attention_id TEXT PRIMARY KEY,
          attention_key TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL,
          severity TEXT NOT NULL,
          environment TEXT NOT NULL,
          event_type TEXT NOT NULL,
          capability TEXT,
          contract_digest TEXT,
          title TEXT NOT NULL,
          occurrence_count INTEGER NOT NULL,
          first_event_id TEXT NOT NULL,
          latest_event_id TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          acknowledged_by TEXT,
          acknowledged_at TEXT,
          acknowledgement_identity_json TEXT,
          acknowledgement_decision_hash TEXT,
          acknowledgement_signature TEXT,
          acknowledgement_integrity_hash TEXT,
          resolved_at TEXT,
          expires_at TEXT,
          FOREIGN KEY (first_event_id) REFERENCES attention_events(event_id),
          FOREIGN KEY (latest_event_id) REFERENCES attention_events(event_id)
        );
  
        CREATE TABLE IF NOT EXISTS notification_deliveries (
          delivery_id TEXT PRIMARY KEY,
          sink_id TEXT NOT NULL,
          event_id TEXT NOT NULL,
          attention_id TEXT,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL,
          next_attempt_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_id TEXT,
          lease_expires_at TEXT,
          last_error_code TEXT,
          external_reference TEXT,
          delivered_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(sink_id, event_id),
          FOREIGN KEY (event_id) REFERENCES attention_events(event_id),
          FOREIGN KEY (attention_id) REFERENCES attention_items(attention_id)
        );
  
        CREATE TABLE IF NOT EXISTS worker_queue (
          proposal_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          execution_mode TEXT DEFAULT 'legacy',
          contract_digest TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL,
          next_attempt_at TEXT NOT NULL,
          lease_owner TEXT,
          lease_id TEXT,
          lease_expires_at TEXT,
          last_error_code TEXT,
          terminal_outcome TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (proposal_id) REFERENCES proposals(proposal_id)
        );
  
        CREATE INDEX IF NOT EXISTS idx_proposal_events_proposal_id ON proposal_events(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_query_audit_proposal_id ON query_audit(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_writeback_receipts_proposal_id ON writeback_receipts(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_writeback_intents_proposal_id ON writeback_intents(proposal_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_writeback_intents_status_updated ON writeback_intents(status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_replay_records_proposal_id ON replay_records(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_shadow_human_actions_proposal_id ON shadow_human_actions(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_shadow_studies_status ON shadow_studies(status, starts_at, ends_at);
        CREATE INDEX IF NOT EXISTS idx_shadow_study_cases_study ON shadow_study_cases(study_id, created_at, case_id);
        CREATE INDEX IF NOT EXISTS idx_shadow_study_cases_proposal ON shadow_study_cases(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_shadow_outcomes_study_request ON shadow_outcomes(study_id, request_id, occurred_at, outcome_id);
        CREATE INDEX IF NOT EXISTS idx_shadow_outcomes_proposal ON shadow_outcomes(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_policy_recommendations_scope ON policy_recommendations(tenant_id, capability, policy, status, created_at);
        CREATE INDEX IF NOT EXISTS idx_cloud_outbox_due ON cloud_outbox(status, next_attempt_at, sequence, created_at);
        CREATE INDEX IF NOT EXISTS idx_cloud_outbox_proposal ON cloud_outbox(proposal_id, sequence, created_at);
        CREATE INDEX IF NOT EXISTS idx_cloud_governance_proposal ON cloud_governance_events(proposal_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_attention_events_type_time ON attention_events(event_type, occurred_at, event_id);
        CREATE INDEX IF NOT EXISTS idx_attention_events_proposal ON attention_events(proposal_id, occurred_at, event_id);
        CREATE INDEX IF NOT EXISTS idx_attention_events_capability ON attention_events(capability, occurred_at, event_id);
        CREATE INDEX IF NOT EXISTS idx_attention_items_status ON attention_items(status, severity, last_seen_at, attention_id);
        CREATE INDEX IF NOT EXISTS idx_notification_deliveries_due ON notification_deliveries(status, next_attempt_at, created_at, delivery_id);
        CREATE INDEX IF NOT EXISTS idx_notification_deliveries_sink ON notification_deliveries(sink_id, status, updated_at, delivery_id);
  
        INSERT OR IGNORE INTO proposal_store_schema(version, applied_at)
        VALUES (1, datetime('now'));
      `);
      this.ensureSearchColumns();
      this.backfillSearchColumns();
      this.ensureSearchIndexes();
    },
  
  ensureSearchColumns(): void {
      this.ensureColumn("proposals", "principal", "TEXT");
      this.ensureColumn("proposals", "capability", "TEXT");
      this.ensureColumn("proposals", "interaction_id", "TEXT");
      this.ensureColumn("proposals", "tool_call_id", "TEXT");
      this.ensureColumn("evidence_bundles", "principal", "TEXT");
      this.ensureColumn("evidence_bundles", "capability", "TEXT");
      this.ensureColumn("evidence_bundles", "source_id", "TEXT");
      this.ensureColumn("evidence_bundles", "source_table", "TEXT");
      this.ensureColumn("evidence_bundles", "business_object", "TEXT");
      this.ensureColumn("evidence_bundles", "object_id", "TEXT");
      this.ensureColumn("evidence_bundles", "query_fingerprint", "TEXT");
      this.ensureColumn("query_audit", "tenant_id", "TEXT");
      this.ensureColumn("query_audit", "principal", "TEXT");
      this.ensureColumn("query_audit", "capability", "TEXT");
      this.ensureColumn("query_audit", "business_object", "TEXT");
      this.ensureColumn("query_audit", "object_id", "TEXT");
      this.ensureColumn("query_audit", "primary_key_value", "TEXT");
      this.ensureColumn("approvals", "identity_json", "TEXT");
      this.ensureColumn("approvals", "decision_hash", "TEXT");
      this.ensureColumn("approvals", "signature", "TEXT");
      this.ensureColumn("approvals", "integrity_hash", "TEXT");
      this.ensureColumn("approvals", "freshness_proof_digest", "TEXT");
      this.ensureColumn("attention_items", "acknowledgement_identity_json", "TEXT");
      this.ensureColumn("attention_items", "acknowledgement_decision_hash", "TEXT");
      this.ensureColumn("attention_items", "acknowledgement_signature", "TEXT");
      this.ensureColumn("attention_items", "acknowledgement_integrity_hash", "TEXT");
      this.ensureColumn("worker_queue", "execution_mode", "TEXT DEFAULT 'legacy'");
      this.ensureColumn("worker_queue", "contract_digest", "TEXT");
      this.ensureColumn("worker_queue", "lease_id", "TEXT");
      this.ensureColumn("worker_queue", "terminal_outcome", "TEXT");
    },
  
  ensureSearchIndexes(): void {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_proposals_tenant_created ON proposals(tenant_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_action_created ON proposals(action, created_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_capability_created ON proposals(capability, created_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_principal_created ON proposals(principal, created_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_object_created ON proposals(business_object, object_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_state_created ON proposals(state, created_at);
        CREATE INDEX IF NOT EXISTS idx_proposals_source_table_created ON proposals(source_id, source_table, created_at);
  
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_tenant_created ON evidence_bundles(tenant_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_proposal_id ON evidence_bundles(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_created ON evidence_bundles(created_at);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_capability_created ON evidence_bundles(capability, created_at);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_principal_created ON evidence_bundles(principal, created_at);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_object_created ON evidence_bundles(business_object, object_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_source_table_created ON evidence_bundles(source_id, source_table, created_at);
        CREATE INDEX IF NOT EXISTS idx_evidence_bundles_fingerprint_created ON evidence_bundles(query_fingerprint, created_at);
  
        CREATE INDEX IF NOT EXISTS idx_evidence_items_bundle_id ON evidence_items(evidence_bundle_id);
  
        CREATE INDEX IF NOT EXISTS idx_query_audit_evidence_id ON query_audit(evidence_bundle_id);
        CREATE INDEX IF NOT EXISTS idx_query_audit_source_table_created ON query_audit(source_id, table_name, created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_fingerprint_created ON query_audit(query_fingerprint, created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_created ON query_audit(created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_tenant_created ON query_audit(tenant_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_capability_created ON query_audit(capability, created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_principal_created ON query_audit(principal, created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_object_created ON query_audit(business_object, object_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_query_audit_primary_key_created ON query_audit(primary_key_value, created_at);
  
        CREATE INDEX IF NOT EXISTS idx_writeback_receipts_writeback_job ON writeback_receipts(writeback_job_id);
        CREATE INDEX IF NOT EXISTS idx_writeback_receipts_idempotency_key ON writeback_receipts(idempotency_key);
        CREATE INDEX IF NOT EXISTS idx_writeback_receipts_status_created ON writeback_receipts(status, created_at);
  
        CREATE INDEX IF NOT EXISTS idx_replay_records_created ON replay_records(created_at);
  
        CREATE INDEX IF NOT EXISTS idx_approvals_proposal_id ON approvals(proposal_id);
        CREATE INDEX IF NOT EXISTS idx_approvals_status_created ON approvals(status, created_at);
  
        CREATE INDEX IF NOT EXISTS idx_proposal_events_kind_created ON proposal_events(kind, created_at);
        CREATE INDEX IF NOT EXISTS idx_worker_queue_claim ON worker_queue(status, next_attempt_at, lease_expires_at, created_at);
        CREATE INDEX IF NOT EXISTS idx_worker_queue_supervised_claim ON worker_queue(execution_mode, contract_digest, status, next_attempt_at, lease_expires_at, created_at);
      `);
    },
  
  ensureColumn(table: string, column: string, definition: string): void {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
      if (columns.some((row) => isRecord(row) && row.name === column)) return;
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    },
  
  backfillSearchColumns(): void {
      const proposals = this.db.prepare("SELECT proposal_id, action, change_set_json FROM proposals").all();
      for (const row of proposals) {
        if (!isRecord(row)) continue;
        try {
          const changeSet = parseChangeSet(JSON.parse(String(row.change_set_json)));
          this.db.prepare("UPDATE proposals SET principal = COALESCE(principal, ?), capability = COALESCE(capability, ?) WHERE proposal_id = ?")
            .run(changeSet.principal.id, changeSet.action, String(row.proposal_id));
        } catch {
          // Leave old malformed rows untouched; normal accessors will still validate when read.
        }
      }
  
      const evidenceRows = this.db.prepare("SELECT evidence_bundle_id, proposal_id, payload_json FROM evidence_bundles").all();
      for (const row of evidenceRows) {
        if (!isRecord(row)) continue;
        const proposal = row.proposal_id == null ? undefined : this.getProposal(String(row.proposal_id));
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
        } catch {
          payload = {};
        }
        const metadata = this.evidenceMetadata({
          proposal,
          payload,
          items: this.evidenceItems(String(row.evidence_bundle_id)).map((item) => item.item as Record<string, unknown>),
        });
        this.db.prepare(`
          UPDATE evidence_bundles
          SET principal = COALESCE(principal, ?),
              capability = COALESCE(capability, ?),
              source_id = COALESCE(source_id, ?),
              source_table = COALESCE(source_table, ?),
              business_object = COALESCE(business_object, ?),
              object_id = COALESCE(object_id, ?),
              query_fingerprint = COALESCE(query_fingerprint, ?)
          WHERE evidence_bundle_id = ?
        `).run(
          metadata.principal ?? null,
          metadata.capability ?? null,
          metadata.source_id ?? null,
          metadata.source_table ?? null,
          metadata.business_object ?? null,
          metadata.object_id ?? null,
          metadata.query_fingerprint ?? null,
          String(row.evidence_bundle_id),
        );
      }
  
      const auditRows = this.db.prepare("SELECT audit_id, proposal_id, evidence_bundle_id, payload_json FROM query_audit").all();
      for (const row of auditRows) {
        if (!isRecord(row)) continue;
        const proposal = row.proposal_id == null ? undefined : this.getProposal(String(row.proposal_id));
        const evidence = row.evidence_bundle_id == null ? undefined : this.getEvidenceBundle(String(row.evidence_bundle_id));
        let payload: Record<string, unknown> = {};
        try {
          payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
        } catch {
          payload = {};
        }
        const metadata = this.queryAuditMetadata({ proposal, evidence, payload });
        this.db.prepare(`
          UPDATE query_audit
          SET tenant_id = COALESCE(tenant_id, ?),
              principal = COALESCE(principal, ?),
              capability = COALESCE(capability, ?),
              business_object = COALESCE(business_object, ?),
              object_id = COALESCE(object_id, ?),
              primary_key_value = COALESCE(primary_key_value, ?)
          WHERE audit_id = ?
        `).run(
          metadata.tenant_id ?? null,
          metadata.principal ?? null,
          metadata.capability ?? null,
          metadata.business_object ?? null,
          metadata.object_id ?? null,
          metadata.primary_key_value ?? null,
          Number(row.audit_id),
        );
      }
    },
};
