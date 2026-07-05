import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import {
  parseChangeSet,
  parseExecutionReceipt,
  parseWritebackJob,
  protocolVersions,
  type ChangeSetV1,
  type ExecutionReceiptV1,
  type WritebackJob,
  type WritebackJobV1,
} from "@synapsor-runner/protocol";

export type LocalProposalState =
  | "pending_review"
  | "approved"
  | "rejected"
  | "canceled"
  | "pending_worker"
  | "applied"
  | "conflict"
  | "failed";

export type StoredProposal = {
  proposal_id: string;
  proposal_version: number;
  proposal_hash: string;
  action: string;
  state: LocalProposalState;
  tenant_id: string;
  principal?: string;
  capability?: string;
  interaction_id?: string;
  tool_call_id?: string;
  business_object: string;
  object_id: string;
  source_kind: string;
  source_id: string;
  source_schema: string;
  source_table: string;
  source_database_mutated: boolean;
  change_set: ChangeSetV1;
  created_at: string;
  updated_at: string;
};

export type ProposalEvent = {
  event_id: number;
  proposal_id: string;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type StoredWritebackReceipt = {
  receipt_id: number;
  writeback_job_id: string;
  proposal_id: string;
  runner_id: string;
  status: string;
  idempotency_key: string;
  source_database_mutated: boolean;
  receipt: ExecutionReceiptV1;
  created_at: string;
};

export type ProposalReplayRecord = {
  replay_id: string;
  proposal: StoredProposal;
  events: ProposalEvent[];
  receipts: StoredWritebackReceipt[];
  query_audit: Record<string, unknown>[];
  evidence: Record<string, unknown>[];
  generated_at: string;
};

export type StoredEvidenceBundle = {
  evidence_bundle_id: string;
  proposal_id?: string;
  tenant_id: string;
  principal?: string;
  capability?: string;
  source_id?: string;
  source_table?: string;
  business_object?: string;
  object_id?: string;
  query_fingerprint?: string;
  payload: Record<string, unknown>;
  items: Record<string, unknown>[];
  query_audit: Record<string, unknown>[];
  created_at: string;
};

export type LocalListOptions = {
  limit?: number;
  from?: string;
  to?: string;
};

export type ProposalSearchFilters = LocalListOptions & {
  proposal?: string;
  tenant?: string;
  principal?: string;
  capability?: string;
  action?: string;
  objectType?: string;
  objectId?: string;
  status?: LocalProposalState;
  state?: LocalProposalState;
  source?: string;
  table?: string;
};

export type EvidenceSearchFilters = LocalListOptions & {
  evidence?: string;
  tenant?: string;
  principal?: string;
  capability?: string;
  proposal?: string;
  objectType?: string;
  objectId?: string;
  source?: string;
  table?: string;
  queryFingerprint?: string;
};

export type QueryAuditSearchFilters = LocalListOptions & {
  tenant?: string;
  principal?: string;
  capability?: string;
  proposal?: string;
  evidence?: string;
  source?: string;
  table?: string;
  objectType?: string;
  objectId?: string;
  primaryKey?: string;
  queryFingerprint?: string;
};

export type ReceiptSearchFilters = LocalListOptions & {
  receipt?: string;
  proposal?: string;
  writebackJob?: string;
  idempotencyKey?: string;
  status?: string;
};

export type EventSearchFilters = LocalListOptions & {
  proposal?: string;
  kind?: string;
  actor?: string;
};

export type StoredShadowHumanAction = {
  action_id: number;
  proposal_id: string;
  actor: string;
  patch: Record<string, unknown>;
  notes?: string;
  created_at: string;
};

export type ShadowComparison = {
  proposal_id: string;
  status: "exact_match" | "partial_match" | "mismatch" | "no_human_action";
  agent_patch: Record<string, unknown>;
  human_patch?: Record<string, unknown>;
  matching_columns: string[];
  differing_columns: string[];
  missing_from_human: string[];
  extra_human_columns: string[];
  notes?: string;
  compared_at: string;
};

export type ShadowReport = {
  total_shadow_proposals: number;
  with_human_action: number;
  exact_matches: number;
  partial_matches: number;
  mismatches: number;
  no_human_action: number;
  comparisons: ShadowComparison[];
};

export type StoreStats = {
  path: string;
  proposals: number;
  evidence_bundles: number;
  evidence_items: number;
  query_audit: number;
  writeback_receipts: number;
  writeback_jobs: number;
  idempotency_receipts: number;
  replay_records: number;
  approvals: number;
  proposal_events: number;
  shadow_human_actions: number;
  page_count: number;
  page_size: number;
  approx_bytes: number;
};

export type StorePruneResult = {
  cutoff: string;
  dry_run: boolean;
  deleted: Record<string, number>;
};

export type CreateWritebackJobOptions = {
  project_id?: string;
  runner_id?: string;
  lease_seconds?: number;
  lease_id?: string;
};

export type RecordHandlerWritebackJobInput = {
  writeback_job_id: string;
  proposal_id: string;
  proposal_hash: string;
  runner_id: string;
  executor: string;
  request: Record<string, unknown>;
};

export class ProposalStoreError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProposalStoreError";
  }
}

export class ProposalStore {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path = ":memory:") {
    this.path = path;
    this.db = new DatabaseSync(path);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

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
      idempotency_receipts: this.countTable("idempotency_receipts"),
      replay_records: this.countTable("replay_records"),
      approvals: this.countTable("approvals"),
      proposal_events: this.countTable("proposal_events"),
      shadow_human_actions: this.countTable("shadow_human_actions"),
      page_count: pageCount,
      page_size: pageSize,
      approx_bytes: pageCount * pageSize,
    };
  }

  vacuum(): void {
    this.db.exec("VACUUM");
  }

  pruneBefore(cutoffIso: string, options: { dryRun?: boolean } = {}): StorePruneResult {
    const dryRun = options.dryRun !== false;
    const proposalIds = this.stringColumn("SELECT proposal_id FROM proposals WHERE created_at < ?", [cutoffIso], "proposal_id");
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
        run("idempotency_receipts", proposalWhere.sql, proposalWhere.params);
        run("writeback_receipts", proposalWhere.sql, proposalWhere.params);
        run("writeback_jobs", proposalWhere.sql, proposalWhere.params);
        run("approvals", proposalWhere.sql, proposalWhere.params);
        run("proposal_events", proposalWhere.sql, proposalWhere.params);
        run("shadow_human_actions", proposalWhere.sql, proposalWhere.params);
        run("replay_records", proposalWhere.sql, proposalWhere.params);
      } else {
        for (const table of ["idempotency_receipts", "writeback_receipts", "writeback_jobs", "approvals", "proposal_events", "shadow_human_actions", "replay_records"]) {
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
  }

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

      CREATE TABLE IF NOT EXISTS runner_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_proposal_events_proposal_id ON proposal_events(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_query_audit_proposal_id ON query_audit(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_writeback_receipts_proposal_id ON writeback_receipts(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_replay_records_proposal_id ON replay_records(proposal_id);
      CREATE INDEX IF NOT EXISTS idx_shadow_human_actions_proposal_id ON shadow_human_actions(proposal_id);

      INSERT OR IGNORE INTO proposal_store_schema(version, applied_at)
      VALUES (1, datetime('now'));
    `);
    this.ensureSearchColumns();
    this.backfillSearchColumns();
    this.ensureSearchIndexes();
  }

  private ensureSearchColumns(): void {
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
  }

  private ensureSearchIndexes(): void {
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
    `);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((row) => isRecord(row) && row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private backfillSearchColumns(): void {
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
  }

  createProposal(input: unknown): StoredProposal {
    const changeSet = parseChangeSet(input);
    assertNoSecretMaterial(changeSet, "change_set");
    const existing = this.getProposal(changeSet.proposal_id);
    if (existing) {
      if (
        existing.proposal_version !== changeSet.proposal_version ||
        existing.proposal_hash !== changeSet.integrity.proposal_hash
      ) {
        throw new ProposalStoreError(
          "PROPOSAL_IMMUTABILITY_VIOLATION",
          `proposal ${changeSet.proposal_id} already exists with a different version or hash`,
        );
      }
      return existing;
    }

    const state = stateFromChangeSet(changeSet);
    const now = changeSet.created_at || new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO proposals (
        proposal_id,
        proposal_version,
        proposal_hash,
        action,
        state,
        tenant_id,
        principal,
        capability,
        interaction_id,
        tool_call_id,
        business_object,
        object_id,
        source_kind,
        source_id,
        source_schema,
        source_table,
        source_database_mutated,
        change_set_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.transaction(() => {
      insert.run(
        changeSet.proposal_id,
        changeSet.proposal_version,
        changeSet.integrity.proposal_hash,
        changeSet.action,
        state,
        changeSet.scope.tenant_id,
        changeSet.principal.id,
        changeSet.action,
        null,
        null,
        changeSet.scope.business_object,
        changeSet.scope.object_id,
        changeSet.source.kind,
        changeSet.source.source_id,
        changeSet.source.schema,
        changeSet.source.table,
        changeSet.source_database_mutated ? 1 : 0,
        JSON.stringify(changeSet),
        now,
        now,
      );
      this.appendEvent(changeSet.proposal_id, "proposal_created", changeSet.principal.id, {
        proposal_hash: changeSet.integrity.proposal_hash,
        proposal_version: changeSet.proposal_version,
        source_database_mutated: changeSet.source_database_mutated,
      });
    });
    const created = this.getProposal(changeSet.proposal_id);
    if (!created) {
      throw new ProposalStoreError("PROPOSAL_CREATE_FAILED", `proposal ${changeSet.proposal_id} was not persisted`);
    }
    return created;
  }

  getProposal(proposalId: string): StoredProposal | undefined {
    const row = this.db.prepare("SELECT * FROM proposals WHERE proposal_id = ?").get(proposalId);
    return rowToProposal(row);
  }

  listProposals(filters?: LocalProposalState | ProposalSearchFilters): StoredProposal[] {
    if (typeof filters === "string") filters = { state: filters };
    const query = buildProposalQuery(filters ?? {});
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map((row) => rowToProposal(row)).filter((proposal): proposal is StoredProposal => proposal !== undefined);
  }

  listEvidenceBundles(filters: EvidenceSearchFilters = {}): StoredEvidenceBundle[] {
    const query = buildEvidenceQuery(filters);
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map((row) => this.rowToEvidenceBundle(row)).filter((evidence): evidence is StoredEvidenceBundle => evidence !== undefined);
  }

  listQueryAudit(filters: QueryAuditSearchFilters = {}): Record<string, unknown>[] {
    const query = buildQueryAuditQuery(filters);
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map(rowToQueryAudit).filter((record): record is Record<string, unknown> => record !== undefined);
  }

  getQueryAudit(auditId: number): Record<string, unknown> | undefined {
    return rowToQueryAudit(this.db.prepare("SELECT * FROM query_audit WHERE audit_id = ?").get(auditId));
  }

  listReceipts(filters: ReceiptSearchFilters = {}): StoredWritebackReceipt[] {
    const query = buildReceiptQuery(filters);
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map(rowToReceipt).filter((receipt): receipt is StoredWritebackReceipt => receipt !== undefined);
  }

  getReceipt(receiptId: number): StoredWritebackReceipt | undefined {
    return rowToReceipt(this.db.prepare("SELECT * FROM writeback_receipts WHERE receipt_id = ?").get(receiptId));
  }

  getReplayByReplayId(replayId: string): ProposalReplayRecord {
    const prefix = "replay_";
    const proposalId = replayId.startsWith(prefix) ? replayId.slice(prefix.length) : replayId;
    return this.replay(proposalId);
  }

  proposalIdForEvidence(evidenceBundleId: string): string | undefined {
    const evidence = this.getEvidenceBundle(evidenceBundleId);
    if (evidence?.proposal_id) return evidence.proposal_id;
    const row = this.db
      .prepare("SELECT proposal_id FROM query_audit WHERE evidence_bundle_id = ? AND proposal_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")
      .get(evidenceBundleId);
    return isRecord(row) && row.proposal_id != null ? String(row.proposal_id) : undefined;
  }

  approveProposal(
    proposalId: string,
    options: { approver: string; proposal_hash: string; proposal_version: number; reason?: string },
  ): StoredProposal {
    const proposal = this.requireProposal(proposalId);
    assertWritebackAllowed(proposal, "approved");
    assertProposalIdentity(proposal, options.proposal_hash, options.proposal_version);
    if (proposal.state !== "pending_review") {
      throw new ProposalStoreError("PROPOSAL_NOT_PENDING_REVIEW", `proposal ${proposalId} is ${proposal.state}`);
    }
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("approved", now, proposalId);
      this.db.prepare(`
        INSERT INTO approvals (proposal_id, proposal_version, proposal_hash, approver, status, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(proposalId, options.proposal_version, options.proposal_hash, options.approver, "approved", options.reason ?? null, now);
      this.appendEvent(proposalId, "proposal_approved", options.approver, {
        proposal_hash: options.proposal_hash,
        proposal_version: options.proposal_version,
        reason: options.reason ?? null,
      });
    });
    return this.requireProposal(proposalId);
  }

  rejectProposal(
    proposalId: string,
    options: { actor: string; proposal_hash: string; proposal_version: number; reason: string },
  ): StoredProposal {
    const proposal = this.requireProposal(proposalId);
    assertProposalIdentity(proposal, options.proposal_hash, options.proposal_version);
    if (proposal.state !== "pending_review" && proposal.state !== "approved") {
      throw new ProposalStoreError("PROPOSAL_NOT_REJECTABLE", `proposal ${proposalId} is ${proposal.state}`);
    }
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("rejected", now, proposalId);
      this.db.prepare(`
        INSERT INTO approvals (proposal_id, proposal_version, proposal_hash, approver, status, reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(proposalId, options.proposal_version, options.proposal_hash, options.actor, "rejected", options.reason, now);
      this.appendEvent(proposalId, "proposal_rejected", options.actor, {
        proposal_hash: options.proposal_hash,
        proposal_version: options.proposal_version,
        reason: options.reason,
      });
    });
    return this.requireProposal(proposalId);
  }

  markPendingWorker(proposalId: string, proposalHash: string, proposalVersion: number): StoredProposal {
    const proposal = this.requireProposal(proposalId);
    assertWritebackAllowed(proposal, "moved to pending worker");
    assertProposalIdentity(proposal, proposalHash, proposalVersion);
    if (proposal.state !== "approved") {
      throw new ProposalStoreError("PROPOSAL_NOT_APPROVED", `proposal ${proposalId} is ${proposal.state}`);
    }
    this.setState(proposalId, "pending_worker", "runner", { proposal_hash: proposalHash, proposal_version: proposalVersion });
    return this.requireProposal(proposalId);
  }

  recordExecutionReceipt(input: unknown): StoredProposal {
    const receipt = parseExecutionReceipt(input);
    const proposal = this.requireProposal(receipt.proposal_id);
    assertWritebackAllowed(proposal, "recorded with an execution receipt");
    const state = stateFromReceipt(receipt);
    const now = receipt.executed_at || new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO writeback_receipts (
          writeback_job_id,
          proposal_id,
          runner_id,
          status,
          idempotency_key,
          source_database_mutated,
          receipt_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.writeback_job_id,
        receipt.proposal_id,
        receipt.runner_id,
        receipt.status,
        receipt.idempotency_key,
        receipt.source_database_mutated ? 1 : 0,
        JSON.stringify(receipt),
        now,
      );
      this.db.prepare("UPDATE proposals SET state = ?, source_database_mutated = ?, updated_at = ? WHERE proposal_id = ?")
        .run(state, receipt.source_database_mutated ? 1 : proposal.source_database_mutated ? 1 : 0, now, receipt.proposal_id);
      this.db.prepare(`
        INSERT OR REPLACE INTO idempotency_receipts (
          idempotency_key,
          writeback_job_id,
          proposal_id,
          receipt_status,
          receipt_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        receipt.idempotency_key,
        receipt.writeback_job_id,
        receipt.proposal_id,
        receipt.status,
        JSON.stringify(receipt),
        now,
      );
      this.db.prepare("UPDATE writeback_jobs SET status = ?, updated_at = ? WHERE writeback_job_id = ?")
        .run(receipt.status, now, receipt.writeback_job_id);
      this.appendEvent(receipt.proposal_id, `writeback_${receipt.status}`, receipt.runner_id, {
        writeback_job_id: receipt.writeback_job_id,
        rows_affected: receipt.rows_affected,
        source_database_mutated: receipt.source_database_mutated,
        receipt_hash: receipt.receipt_hash,
      });
    });
    return this.requireProposal(receipt.proposal_id);
  }

  recordWritebackJob(input: unknown): WritebackJob {
    const job = parseWritebackJob(input);
    const proposal = this.requireProposal(job.proposal_id);
    assertWritebackAllowed(proposal, "recorded with a writeback job");
    const proposalHash = job.approval_id;
    assertProposalIdentity(proposal, proposalHash, proposal.proposal_version);
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO writeback_jobs (
          writeback_job_id,
          proposal_id,
          proposal_hash,
          status,
          job_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(writeback_job_id) DO UPDATE SET
          status = excluded.status,
          job_json = excluded.job_json,
          updated_at = excluded.updated_at
      `).run(job.job_id, job.proposal_id, proposalHash, "pending_worker", JSON.stringify(job), now, now);
      this.appendEvent(job.proposal_id, "writeback_job_recorded", "runner", {
        writeback_job_id: job.job_id,
        proposal_hash: proposalHash,
        source_id: job.source_id,
      });
    });
    return job;
  }

  recordHandlerWritebackJob(input: RecordHandlerWritebackJobInput): void {
    const proposal = this.requireProposal(input.proposal_id);
    assertWritebackAllowed(proposal, "recorded with a handler writeback job");
    assertProposalIdentity(proposal, input.proposal_hash, proposal.proposal_version);
    assertNoSecretMaterial(input.request, "handler_writeback_job");
    const now = new Date().toISOString();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO writeback_jobs (
          writeback_job_id,
          proposal_id,
          proposal_hash,
          status,
          job_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(writeback_job_id) DO UPDATE SET
          status = excluded.status,
          job_json = excluded.job_json,
          updated_at = excluded.updated_at
      `).run(
        input.writeback_job_id,
        input.proposal_id,
        input.proposal_hash,
        "pending_worker",
        JSON.stringify({
          schema_version: "synapsor.handler-writeback.v1",
          writeback_job_id: input.writeback_job_id,
          proposal_id: input.proposal_id,
          proposal_hash: input.proposal_hash,
          runner_id: input.runner_id,
          executor: input.executor,
          request: input.request,
        }),
        now,
        now,
      );
      this.appendEvent(input.proposal_id, "handler_writeback_job_recorded", input.runner_id, {
        writeback_job_id: input.writeback_job_id,
        executor: input.executor,
      });
    });
  }

  createWritebackJobFromProposal(proposalId: string, options: CreateWritebackJobOptions = {}): WritebackJobV1 {
    const proposal = this.requireProposal(proposalId);
    assertWritebackAllowed(proposal, "converted into a writeback job");
    if (proposal.state !== "approved" && proposal.state !== "pending_worker") {
      throw new ProposalStoreError("PROPOSAL_NOT_APPROVED", `proposal ${proposalId} is ${proposal.state}`);
    }
    const changeSet = proposal.change_set;
    if (changeSet.writeback.mode !== "trusted_worker_required") {
      throw new ProposalStoreError("WRITEBACK_NOT_REQUIRED", `proposal ${proposalId} uses ${changeSet.writeback.mode}`);
    }
    if (changeSet.source.kind !== "external_postgres" && changeSet.source.kind !== "external_mysql") {
      throw new ProposalStoreError("WRITEBACK_TARGET_NOT_EXTERNAL", `proposal ${proposalId} targets ${changeSet.source.kind}`);
    }
    const engine = changeSet.source.kind === "external_postgres" ? "postgres" : "mysql";
    const leaseSeconds = Math.max(15, Math.min(Number(options.lease_seconds ?? 300), 3600));
    const now = Date.now();
    const job: WritebackJobV1 = {
      schema_version: protocolVersions.writebackJob,
      writeback_job_id: `wbj_${proposal.proposal_id.replace(/[^A-Za-z0-9_:-]/g, "_")}`,
      proposal_id: proposal.proposal_id,
      proposal_version: proposal.proposal_version,
      proposal_hash: proposal.proposal_hash,
      runner_scope: {
        project_id: options.project_id ?? "local",
        source_id: proposal.source_id,
      },
      engine,
      operation: "single_row_update",
      target: {
        schema: proposal.source_schema,
        table: proposal.source_table,
        primary_key: changeSet.source.primary_key,
      },
      tenant_guard: changeSet.guards.tenant,
      allowed_columns: changeSet.guards.allowed_columns,
      patch: changeSet.patch,
      conflict_guard: conflictGuardFromChangeSet(changeSet),
      idempotency_key: `${proposal.proposal_id}:${proposal.object_id}`,
      lease: {
        lease_id: options.lease_id ?? `lease_${proposal.proposal_id.replace(/[^A-Za-z0-9_:-]/g, "_")}`,
        attempt: 1,
        expires_at: new Date(now + leaseSeconds * 1000).toISOString(),
      },
    };
    this.transaction(() => {
      if (proposal.state === "approved") {
        this.db.prepare("UPDATE proposals SET state = ?, updated_at = ? WHERE proposal_id = ?").run("pending_worker", new Date().toISOString(), proposalId);
        this.appendEvent(proposalId, "proposal_pending_worker", options.runner_id ?? "local_runner", {
          proposal_hash: proposal.proposal_hash,
          proposal_version: proposal.proposal_version,
        });
      }
      const normalized = parseWritebackJob(job);
      this.db.prepare(`
        INSERT INTO writeback_jobs (
          writeback_job_id,
          proposal_id,
          proposal_hash,
          status,
          job_json,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(writeback_job_id) DO UPDATE SET
          status = excluded.status,
          job_json = excluded.job_json,
          updated_at = excluded.updated_at
      `).run(normalized.job_id, proposal.proposal_id, proposal.proposal_hash, "pending_worker", JSON.stringify(normalized), new Date().toISOString(), new Date().toISOString());
      this.appendEvent(proposal.proposal_id, "writeback_job_recorded", options.runner_id ?? "local_runner", {
        writeback_job_id: normalized.job_id,
        proposal_hash: proposal.proposal_hash,
        source_id: normalized.source_id,
      });
    });
    return job;
  }

  recordEvidenceBundle(input: {
    evidence_bundle_id: string;
    proposal_id?: string;
    tenant_id: string;
    payload: Record<string, unknown>;
    items?: Record<string, unknown>[];
  }): void {
    assertNoSecretMaterial({ payload: input.payload, items: input.items ?? [] }, "evidence_bundle");
    const now = new Date().toISOString();
    const proposal = input.proposal_id ? this.requireProposal(input.proposal_id) : undefined;
    const metadata = this.evidenceMetadata({ proposal, payload: input.payload, items: input.items ?? [] });
    this.transaction(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO evidence_bundles (
          evidence_bundle_id,
          proposal_id,
          tenant_id,
          principal,
          capability,
          source_id,
          source_table,
          business_object,
          object_id,
          query_fingerprint,
          payload_json,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.evidence_bundle_id,
        input.proposal_id ?? null,
        input.tenant_id,
        metadata.principal ?? null,
        metadata.capability ?? null,
        metadata.source_id ?? null,
        metadata.source_table ?? null,
        metadata.business_object ?? null,
        metadata.object_id ?? null,
        metadata.query_fingerprint ?? null,
        JSON.stringify(input.payload),
        now,
      );
      for (const item of input.items ?? []) {
        this.db.prepare(`
          INSERT INTO evidence_items (evidence_bundle_id, item_json, created_at)
          VALUES (?, ?, ?)
        `).run(input.evidence_bundle_id, JSON.stringify(item), now);
      }
      if (input.proposal_id) {
        this.appendEvent(input.proposal_id, "evidence_recorded", "runner", {
          evidence_bundle_id: input.evidence_bundle_id,
          item_count: input.items?.length ?? 0,
        });
      }
    });
  }

  recordQueryAudit(input: {
    proposal_id?: string;
    evidence_bundle_id?: string;
    source_id: string;
    query_fingerprint: string;
    table_name: string;
    row_count: number;
    payload: Record<string, unknown>;
  }): void {
    assertNoSecretMaterial(input.payload, "query_audit");
    const now = new Date().toISOString();
    const proposal = input.proposal_id ? this.requireProposal(input.proposal_id) : undefined;
    const evidence = input.evidence_bundle_id ? this.getEvidenceBundle(input.evidence_bundle_id) : undefined;
    const metadata = this.queryAuditMetadata({ proposal, evidence, payload: input.payload });
    this.db.prepare(`
      INSERT INTO query_audit (
        proposal_id,
        evidence_bundle_id,
        tenant_id,
        principal,
        capability,
        business_object,
        object_id,
        primary_key_value,
        source_id,
        query_fingerprint,
        table_name,
        row_count,
        payload_json,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.proposal_id ?? null,
      input.evidence_bundle_id ?? null,
      metadata.tenant_id ?? null,
      metadata.principal ?? null,
      metadata.capability ?? null,
      metadata.business_object ?? null,
      metadata.object_id ?? null,
      metadata.primary_key_value ?? null,
      input.source_id,
      input.query_fingerprint,
      input.table_name,
      input.row_count,
      JSON.stringify(input.payload),
      now,
    );
  }

  getEvidenceBundle(evidenceBundleId: string): StoredEvidenceBundle | undefined {
    const row = this.db
      .prepare("SELECT * FROM evidence_bundles WHERE evidence_bundle_id = ?")
      .get(evidenceBundleId);
    return this.rowToEvidenceBundle(row);
  }

  private rowToEvidenceBundle(row: unknown): StoredEvidenceBundle | undefined {
    if (!isRecord(row)) return undefined;
    return {
      evidence_bundle_id: String(row.evidence_bundle_id),
      proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
      tenant_id: String(row.tenant_id),
      principal: row.principal == null ? undefined : String(row.principal),
      capability: row.capability == null ? undefined : String(row.capability),
      source_id: row.source_id == null ? undefined : String(row.source_id),
      source_table: row.source_table == null ? undefined : String(row.source_table),
      business_object: row.business_object == null ? undefined : String(row.business_object),
      object_id: row.object_id == null ? undefined : String(row.object_id),
      query_fingerprint: row.query_fingerprint == null ? undefined : String(row.query_fingerprint),
      payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
      items: this.evidenceItems(String(row.evidence_bundle_id)),
      query_audit: this.queryAuditByEvidence(String(row.evidence_bundle_id)),
      created_at: String(row.created_at),
    };
  }

  events(proposalId: string): ProposalEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM proposal_events WHERE proposal_id = ? ORDER BY event_id ASC")
      .all(proposalId);
    return rows.map(rowToEvent).filter((event): event is ProposalEvent => event !== undefined);
  }

  listEvents(filters: EventSearchFilters = {}): ProposalEvent[] {
    const query = buildEventQuery(filters);
    const rows = this.db.prepare(query.sql).all(...query.params);
    return rows.map(rowToEvent).filter((event): event is ProposalEvent => event !== undefined);
  }

  receipts(proposalId: string): StoredWritebackReceipt[] {
    const rows = this.db
      .prepare("SELECT * FROM writeback_receipts WHERE proposal_id = ? ORDER BY receipt_id ASC")
      .all(proposalId);
    return rows.map(rowToReceipt).filter((receipt): receipt is StoredWritebackReceipt => receipt !== undefined);
  }

  replay(proposalId: string): ProposalReplayRecord {
    const proposal = this.requireProposal(proposalId);
    const replay: ProposalReplayRecord = {
      replay_id: `replay_${proposalId}`,
      proposal,
      events: this.events(proposalId),
      receipts: this.receipts(proposalId),
      query_audit: this.queryAudit(proposalId),
      evidence: this.evidence(proposalId),
      generated_at: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT OR REPLACE INTO replay_records (replay_id, proposal_id, payload_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(replay.replay_id, proposalId, JSON.stringify(replay), replay.generated_at);
    return replay;
  }

  setRunnerState(key: string, value: Record<string, unknown>): void {
    assertNoSecretMaterial(value, `runner_state.${key}`);
    this.db.prepare(`
      INSERT INTO runner_state (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), new Date().toISOString());
  }

  getRunnerState(key: string): Record<string, unknown> | undefined {
    const row = this.db.prepare("SELECT value_json FROM runner_state WHERE key = ?").get(key);
    if (!isRecord(row)) return undefined;
    return JSON.parse(String(row.value_json)) as Record<string, unknown>;
  }

  recordShadowHumanAction(
    proposalId: string,
    input: { actor: string; patch: Record<string, unknown>; notes?: string },
  ): StoredShadowHumanAction {
    const proposal = this.requireProposal(proposalId);
    if (proposal.change_set.mode !== "shadow") {
      throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${proposalId} is not a shadow proposal`);
    }
    assertNoSecretMaterial(input.patch, "shadow_human_action.patch");
    const now = new Date().toISOString();
    let actionId = 0;
    this.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO shadow_human_actions (proposal_id, actor, patch_json, notes, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(proposalId, input.actor, JSON.stringify(input.patch), input.notes ?? null, now);
      actionId = Number(result.lastInsertRowid);
      this.appendEvent(proposalId, "shadow_human_action_recorded", input.actor, {
        action_id: actionId,
        patch_columns: Object.keys(input.patch),
        notes: input.notes ?? null,
      });
    });
    const action = this.shadowHumanActions(proposalId).find((item) => item.action_id === actionId);
    if (!action) throw new ProposalStoreError("SHADOW_ACTION_CREATE_FAILED", `shadow action for ${proposalId} was not persisted`);
    return action;
  }

  shadowHumanActions(proposalId: string): StoredShadowHumanAction[] {
    const rows = this.db.prepare("SELECT * FROM shadow_human_actions WHERE proposal_id = ? ORDER BY action_id ASC").all(proposalId);
    return rows.map(rowToShadowHumanAction).filter((action): action is StoredShadowHumanAction => action !== undefined);
  }

  compareShadowProposal(proposalId: string): ShadowComparison {
    const proposal = this.requireProposal(proposalId);
    if (proposal.change_set.mode !== "shadow") {
      throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${proposalId} is not a shadow proposal`);
    }
    const actions = this.shadowHumanActions(proposalId);
    const latest = actions.at(-1);
    return comparePatches(proposalId, proposal.change_set.patch, latest);
  }

  shadowReport(): ShadowReport {
    const proposals = this.listProposals().filter((proposal) => proposal.change_set.mode === "shadow");
    const comparisons = proposals.map((proposal) => this.compareShadowProposal(proposal.proposal_id));
    return {
      total_shadow_proposals: proposals.length,
      with_human_action: comparisons.filter((comparison) => comparison.status !== "no_human_action").length,
      exact_matches: comparisons.filter((comparison) => comparison.status === "exact_match").length,
      partial_matches: comparisons.filter((comparison) => comparison.status === "partial_match").length,
      mismatches: comparisons.filter((comparison) => comparison.status === "mismatch").length,
      no_human_action: comparisons.filter((comparison) => comparison.status === "no_human_action").length,
      comparisons,
    };
  }

  private requireProposal(proposalId: string): StoredProposal {
    const proposal = this.getProposal(proposalId);
    if (!proposal) {
      throw new ProposalStoreError("PROPOSAL_NOT_FOUND", `proposal ${proposalId} not found`);
    }
    return proposal;
  }

  private setState(
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
  }

  private appendEvent(
    proposalId: string,
    kind: string,
    actor: string,
    payload: Record<string, unknown>,
  ): void {
    this.db.prepare(`
      INSERT INTO proposal_events (proposal_id, kind, actor, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(proposalId, kind, actor, JSON.stringify(payload), new Date().toISOString());
  }

  private queryAudit(proposalId: string): Record<string, unknown>[] {
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
  }

  private queryAuditByEvidence(evidenceBundleId: string): Record<string, unknown>[] {
    const rows = this.db
      .prepare("SELECT * FROM query_audit WHERE evidence_bundle_id = ? ORDER BY audit_id ASC")
      .all(evidenceBundleId);
    return rows.map(rowToQueryAudit).filter((record): record is Record<string, unknown> => record !== undefined);
  }

  private evidence(proposalId: string): Record<string, unknown>[] {
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
  }

  private evidenceItems(evidenceBundleId: string): Record<string, unknown>[] {
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
  }

  private evidenceMetadata(input: {
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
    const table = stringFromUnknown(input.payload.target) ?? stringFromUnknown(firstItem?.table);
    return {
      principal,
      capability: stringFromUnknown(input.payload.capability),
      source_id: stringFromUnknown(input.payload.source_id) ?? stringFromUnknown(firstItem?.source_id),
      source_table: table,
      business_object: table ? lastIdentifier(table) : undefined,
      object_id: primaryKey ? stringFromUnknown(primaryKey.value) : undefined,
      query_fingerprint: stringFromUnknown(input.payload.query_fingerprint),
    };
  }

  private queryAuditMetadata(input: {
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
        primary_key_value: String(input.proposal.change_set.source.primary_key.value),
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
  }

  private countTable(table: string): number {
    return this.countWhere(table, "1 = 1", []);
  }

  private countWhere(table: string, where: string, params: SQLInputValue[]): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get(...params);
    return isRecord(row) ? Number(row.count ?? 0) : 0;
  }

  private numberValue(sql: string): number {
    const row = this.db.prepare(sql).get();
    if (!isRecord(row)) return 0;
    const value = Object.values(row)[0];
    return typeof value === "number" ? value : Number(value ?? 0);
  }

  private stringColumn(sql: string, params: SQLInputValue[], column: string): string[] {
    return this.db.prepare(sql).all(...params)
      .map((row) => isRecord(row) ? row[column] : undefined)
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .map(String);
  }

  private evidenceIdsForPrune(cutoffIso: string, proposalIds: string[]): string[] {
    const proposalWhere = inWhere("proposal_id", proposalIds);
    if (!proposalWhere) {
      return this.stringColumn("SELECT evidence_bundle_id FROM evidence_bundles WHERE created_at < ?", [cutoffIso], "evidence_bundle_id");
    }
    return this.stringColumn(
      `SELECT evidence_bundle_id FROM evidence_bundles WHERE created_at < ? OR ${proposalWhere.sql}`,
      [cutoffIso, ...proposalWhere.params],
      "evidence_bundle_id",
    );
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function stateFromChangeSet(changeSet: ChangeSetV1): LocalProposalState {
  if (changeSet.approval.status === "approved") return "approved";
  if (changeSet.approval.status === "rejected") return "rejected";
  if (changeSet.approval.status === "canceled") return "canceled";
  return "pending_review";
}

type SqlParam = string | number | null;
type SqlQuery = { sql: string; params: SqlParam[] };

function inWhere(column: string, values: string[]): { sql: string; params: string[] } | undefined {
  if (values.length === 0) return undefined;
  return {
    sql: `${column} IN (${values.map(() => "?").join(", ")})`,
    params: values,
  };
}

function buildProposalQuery(filters: ProposalSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "tenant_id", filters.tenant);
  addEqual(clauses, params, "principal", filters.principal);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "source_table", filters.table);
  addEqual(clauses, params, "state", filters.status ?? filters.state);
  addEqual(clauses, params, "action", filters.capability ?? filters.action);
  addObjectFilter(clauses, params, "business_object", "source_table", "object_id", filters.objectType, filters.objectId);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM proposals", clauses, params, filters.limit);
}

function buildEvidenceQuery(filters: EvidenceSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqual(clauses, params, "evidence_bundle_id", filters.evidence);
  addEqual(clauses, params, "tenant_id", filters.tenant);
  addEqual(clauses, params, "principal", filters.principal);
  addEqual(clauses, params, "capability", filters.capability);
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "source_table", filters.table);
  addEqual(clauses, params, "query_fingerprint", filters.queryFingerprint);
  addObjectFilter(clauses, params, "business_object", "source_table", "object_id", filters.objectType, filters.objectId);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM evidence_bundles", clauses, params, filters.limit);
}

function buildQueryAuditQuery(filters: QueryAuditSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqual(clauses, params, "tenant_id", filters.tenant);
  addEqual(clauses, params, "principal", filters.principal);
  addEqual(clauses, params, "capability", filters.capability);
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "evidence_bundle_id", filters.evidence);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "table_name", filters.table);
  addObjectFilter(clauses, params, "business_object", "table_name", "object_id", filters.objectType, filters.objectId);
  addEqual(clauses, params, "primary_key_value", filters.primaryKey);
  addEqual(clauses, params, "query_fingerprint", filters.queryFingerprint);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM query_audit", clauses, params, filters.limit);
}

function buildReceiptQuery(filters: ReceiptSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqual(clauses, params, "receipt_id", filters.receipt);
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "writeback_job_id", filters.writebackJob);
  addEqual(clauses, params, "idempotency_key", filters.idempotencyKey);
  addEqual(clauses, params, "status", filters.status);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM writeback_receipts", clauses, params, filters.limit);
}

function buildEventQuery(filters: EventSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "kind", filters.kind);
  addEqual(clauses, params, "actor", filters.actor);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM proposal_events", clauses, params, filters.limit);
}

function addEqual(clauses: string[], params: SqlParam[], column: string, value?: string): void {
  if (!value) return;
  clauses.push(`${column} = ?`);
  params.push(value);
}

function addTableFilter(clauses: string[], params: SqlParam[], column: string, value?: string): void {
  if (!value) return;
  if (value.includes(".")) {
    clauses.push(`${column} = ?`);
    params.push(value);
    return;
  }
  clauses.push(`(${column} = ? OR ${column} = ?)`);
  params.push(value, `public.${value}`);
}

function addObjectFilter(
  clauses: string[],
  params: SqlParam[],
  typeColumn: string,
  tableColumn: string,
  idColumn: string,
  objectType?: string,
  objectId?: string,
): void {
  if (objectId) {
    clauses.push(`${idColumn} = ?`);
    params.push(objectId);
  }
  if (!objectType) return;
  const variants = objectTypeVariants(objectType);
  const placeholders = variants.map(() => "?").join(", ");
  clauses.push(`(${typeColumn} IN (${placeholders}) OR ${tableColumn} IN (${placeholders}))`);
  params.push(...variants, ...variants);
}

function addTimeRange(clauses: string[], params: SqlParam[], column: string, from?: string, to?: string): void {
  if (from) {
    clauses.push(`${column} >= ?`);
    params.push(from);
  }
  if (to) {
    clauses.push(`${column} <= ?`);
    params.push(to);
  }
}

function finishQuery(base: string, clauses: string[], params: SqlParam[], limit?: number): SqlQuery {
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const sql = `${base}${where} ORDER BY created_at DESC${limit ? " LIMIT ?" : ""}`;
  return { sql, params: limit ? [...params, limit] : params };
}

function objectTypeVariants(value: string): string[] {
  const variants = new Set<string>([value]);
  if (value.endsWith("s")) variants.add(value.slice(0, -1));
  else variants.add(`${value}s`);
  for (const variant of [...variants]) {
    if (!variant.includes(".")) variants.add(`public.${variant}`);
  }
  return [...variants];
}

function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function stringFromPrincipal(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) return stringFromUnknown(value.id);
  return undefined;
}

function lastIdentifier(value: string): string {
  const parts = value.split(".");
  return parts[parts.length - 1] ?? value;
}

function stateFromReceipt(receipt: ExecutionReceiptV1): LocalProposalState {
  if (receipt.status === "applied" || receipt.status === "already_applied") return "applied";
  if (receipt.status === "conflict") return "conflict";
  if (receipt.status === "canceled") return "canceled";
  return "failed";
}

function conflictGuardFromChangeSet(changeSet: ChangeSetV1): WritebackJobV1["conflict_guard"] {
  const guard = changeSet.guards.expected_version;
  if (guard.column === "__row_hash") {
    return { kind: "row_hash", expected_hash: String(guard.value) };
  }
  if (!guard.column || guard.value === null || guard.value === undefined) {
    return { kind: "none" };
  }
  return { kind: "column", column: guard.column, expected_value: guard.value };
}

function assertProposalIdentity(proposal: StoredProposal, hash: string, version: number): void {
  if (proposal.proposal_hash !== hash) {
    throw new ProposalStoreError("PROPOSAL_HASH_MISMATCH", `proposal ${proposal.proposal_id} hash mismatch`);
  }
  if (proposal.proposal_version !== version) {
    throw new ProposalStoreError("PROPOSAL_VERSION_MISMATCH", `proposal ${proposal.proposal_id} version mismatch`);
  }
}

function assertWritebackAllowed(proposal: StoredProposal, operation: string): void {
  if (proposal.change_set.mode === "shadow") {
    throw new ProposalStoreError(
      "SHADOW_WRITEBACK_DISABLED",
      `shadow proposal ${proposal.proposal_id} cannot be ${operation}; shadow mode stores proposals, evidence, query audit, and replay only and never mutates the source database`,
    );
  }
  if (proposal.change_set.mode === "read_only") {
    throw new ProposalStoreError(
      "READ_ONLY_WRITEBACK_DISABLED",
      `read-only proposal ${proposal.proposal_id} cannot be ${operation}; read-only mode does not allow proposal writeback`,
    );
  }
}

const secretKeyPattern = /(^|[_-])(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|cookie|credential|connection[_-]?string|database[_-]?url|read[_-]?url|write[_-]?url)($|[_-])/i;
const secretValuePattern = /(postgres(?:ql)?:\/\/|mysql:\/\/|Bearer\s+[A-Za-z0-9._~+/=-]+|syn_wbr_[A-Za-z0-9._~+/=-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

function assertNoSecretMaterial(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretMaterial(item, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const entryPath = `${path}.${key}`;
      if (secretKeyPattern.test(key)) {
        throw new ProposalStoreError(
          "SECRET_MATERIAL_REJECTED",
          `refusing to persist secret-like field ${entryPath}; remove it from reviewed visible/evidence/query-audit data`,
        );
      }
      assertNoSecretMaterial(entry, entryPath);
    }
    return;
  }
  if (typeof value === "string" && secretValuePattern.test(value)) {
    throw new ProposalStoreError(
      "SECRET_MATERIAL_REJECTED",
      `refusing to persist secret-like value at ${path}; remove it from reviewed visible/evidence/query-audit data`,
    );
  }
}

function rowToProposal(row: unknown): StoredProposal | undefined {
  if (!isRecord(row)) return undefined;
  return {
    proposal_id: String(row.proposal_id),
    proposal_version: Number(row.proposal_version),
    proposal_hash: String(row.proposal_hash),
    action: String(row.action),
    state: String(row.state) as LocalProposalState,
    tenant_id: String(row.tenant_id),
    principal: row.principal == null ? undefined : String(row.principal),
    capability: row.capability == null ? undefined : String(row.capability),
    interaction_id: row.interaction_id == null ? undefined : String(row.interaction_id),
    tool_call_id: row.tool_call_id == null ? undefined : String(row.tool_call_id),
    business_object: String(row.business_object),
    object_id: String(row.object_id),
    source_kind: String(row.source_kind),
    source_id: String(row.source_id),
    source_schema: String(row.source_schema),
    source_table: String(row.source_table),
    source_database_mutated: Number(row.source_database_mutated) === 1,
    change_set: parseChangeSet(JSON.parse(String(row.change_set_json))),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToEvent(row: unknown): ProposalEvent | undefined {
  if (!isRecord(row)) return undefined;
  return {
    event_id: Number(row.event_id),
    proposal_id: String(row.proposal_id),
    kind: String(row.kind),
    actor: String(row.actor),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    created_at: String(row.created_at),
  };
}

function rowToReceipt(row: unknown): StoredWritebackReceipt | undefined {
  if (!isRecord(row)) return undefined;
  return {
    receipt_id: Number(row.receipt_id),
    writeback_job_id: String(row.writeback_job_id),
    proposal_id: String(row.proposal_id),
    runner_id: String(row.runner_id),
    status: String(row.status),
    idempotency_key: String(row.idempotency_key),
    source_database_mutated: Number(row.source_database_mutated) === 1,
    receipt: parseExecutionReceipt(JSON.parse(String(row.receipt_json))),
    created_at: String(row.created_at),
  };
}

function rowToQueryAudit(row: unknown): Record<string, unknown> | undefined {
  if (!isRecord(row)) return undefined;
  return {
    audit_id: Number(row.audit_id),
    proposal_id: row.proposal_id == null ? undefined : String(row.proposal_id),
    evidence_bundle_id: row.evidence_bundle_id == null ? undefined : String(row.evidence_bundle_id),
    tenant_id: row.tenant_id == null ? undefined : String(row.tenant_id),
    principal: row.principal == null ? undefined : String(row.principal),
    capability: row.capability == null ? undefined : String(row.capability),
    business_object: row.business_object == null ? undefined : String(row.business_object),
    object_id: row.object_id == null ? undefined : String(row.object_id),
    primary_key_value: row.primary_key_value == null ? undefined : String(row.primary_key_value),
    source_id: String(row.source_id),
    query_fingerprint: String(row.query_fingerprint),
    table_name: String(row.table_name),
    row_count: Number(row.row_count),
    payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
    created_at: String(row.created_at),
  };
}

function rowToShadowHumanAction(row: unknown): StoredShadowHumanAction | undefined {
  if (!isRecord(row)) return undefined;
  return {
    action_id: Number(row.action_id),
    proposal_id: String(row.proposal_id),
    actor: String(row.actor),
    patch: JSON.parse(String(row.patch_json)) as Record<string, unknown>,
    notes: row.notes == null ? undefined : String(row.notes),
    created_at: String(row.created_at),
  };
}

function comparePatches(
  proposalId: string,
  agentPatch: Record<string, unknown>,
  humanAction?: StoredShadowHumanAction,
): ShadowComparison {
  const comparedAt = new Date().toISOString();
  if (!humanAction) {
    return {
      proposal_id: proposalId,
      status: "no_human_action",
      agent_patch: agentPatch,
      matching_columns: [],
      differing_columns: [],
      missing_from_human: Object.keys(agentPatch),
      extra_human_columns: [],
      compared_at: comparedAt,
    };
  }
  const humanPatch = humanAction.patch;
  const agentColumns = Object.keys(agentPatch);
  const humanColumns = Object.keys(humanPatch);
  const matchingColumns = agentColumns.filter((column) => Object.is(agentPatch[column], humanPatch[column]));
  const differingColumns = agentColumns.filter((column) => column in humanPatch && !Object.is(agentPatch[column], humanPatch[column]));
  const missingFromHuman = agentColumns.filter((column) => !(column in humanPatch));
  const extraHumanColumns = humanColumns.filter((column) => !(column in agentPatch));
  const exact = matchingColumns.length === agentColumns.length && differingColumns.length === 0 && missingFromHuman.length === 0 && extraHumanColumns.length === 0;
  const partial = !exact && matchingColumns.length > 0;
  return {
    proposal_id: proposalId,
    status: exact ? "exact_match" : partial ? "partial_match" : "mismatch",
    agent_patch: agentPatch,
    human_patch: humanPatch,
    matching_columns: matchingColumns,
    differing_columns: differingColumns,
    missing_from_human: missingFromHuman,
    extra_human_columns: extraHumanColumns,
    notes: humanAction.notes,
    compared_at: comparedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
