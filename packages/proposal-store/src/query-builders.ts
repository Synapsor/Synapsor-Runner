import type {
  ProposalSearchFilters,
  EvidenceSearchFilters,
  QueryAuditSearchFilters,
  ReceiptSearchFilters,
  EventSearchFilters,
} from "./domain-types.js";
import {
  isRecord,
} from "./common.js";

export type SqlParam = string | number | null;
export type SqlQuery = { sql: string; params: SqlParam[] };

export function inWhere(column: string, values: string[]): { sql: string; params: string[] } | undefined {
  if (values.length === 0) return undefined;
  return {
    sql: `${column} IN (${values.map(() => "?").join(", ")})`,
    params: values,
  };
}

export function buildProposalQuery(filters: ProposalSearchFilters): SqlQuery {
  const { clauses, params } = proposalQueryParts(filters);
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return {
    sql: `SELECT * FROM proposals${where} ORDER BY created_at DESC, proposal_id DESC${filters.limit ? " LIMIT ?" : ""}`,
    params: filters.limit ? [...params, filters.limit] : params,
  };
}

export function buildProposalCountQuery(filters: ProposalSearchFilters): SqlQuery {
  const { clauses, params } = proposalQueryParts(filters);
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return { sql: `SELECT COUNT(*) AS count FROM proposals${where}`, params };
}

export function proposalQueryParts(filters: ProposalSearchFilters): { clauses: string[]; params: SqlParam[] } {
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
  return { clauses, params };
}

export function buildEvidenceQuery(filters: EvidenceSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqual(clauses, params, "evidence_bundle_id", filters.evidence);
  addEqualAny(clauses, params, "tenant_id", filters.tenants ?? (filters.tenant ? [filters.tenant] : []));
  addEqualAny(clauses, params, "principal", filters.principals ?? (filters.principal ? [filters.principal] : []));
  addEqual(clauses, params, "capability", filters.capability);
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "source_table", filters.table);
  addEqual(clauses, params, "query_fingerprint", filters.queryFingerprint);
  addEvidenceStatusFilter(clauses, params, filters.status);
  addExploreOutcomeFilter(clauses, params, filters.outcome, "outcome");
  addJsonEqual(clauses, params, "boundary_digest", filters.boundary);
  addObjectFilter(clauses, params, "business_object", "source_table", "object_id", filters.objectType, filters.objectId);
  addMetadataSearch(clauses, params, filters.search, [
    "evidence_bundle_id", "source_table", "source_id", "capability", "payload_json",
  ]);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM evidence_bundles", clauses, params, filters.limit, filters.offset);
}

export function buildQueryAuditQuery(filters: QueryAuditSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqualAny(clauses, params, "tenant_id", filters.tenants ?? (filters.tenant ? [filters.tenant] : []));
  addEqualAny(clauses, params, "principal", filters.principals ?? (filters.principal ? [filters.principal] : []));
  addEqual(clauses, params, "capability", filters.capability);
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "evidence_bundle_id", filters.evidence);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "table_name", filters.table);
  addObjectFilter(clauses, params, "business_object", "table_name", "object_id", filters.objectType, filters.objectId);
  addEqual(clauses, params, "primary_key_value", filters.primaryKey);
  addEqual(clauses, params, "query_fingerprint", filters.queryFingerprint);
  addJsonStatusFilter(clauses, params, filters.status);
  addExploreOutcomeFilter(clauses, params, filters.outcome, "status");
  addJsonEqual(clauses, params, "boundary_digest", filters.boundary);
  addMetadataSearch(clauses, params, filters.search, [
    "CAST(audit_id AS TEXT)", "table_name", "source_id", "capability", "evidence_bundle_id", "payload_json",
  ]);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM query_audit", clauses, params, filters.limit, filters.offset);
}

export function buildReceiptQuery(filters: ReceiptSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqual(clauses, params, "receipt_id", filters.receipt);
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "writeback_job_id", filters.writebackJob);
  addEqual(clauses, params, "idempotency_key", filters.idempotencyKey);
  addEqual(clauses, params, "status", filters.status);
  addEqual(clauses, params, "tenant_id", filters.tenant);
  addEqual(clauses, params, "principal", filters.principal);
  addEqual(clauses, params, "capability", filters.capability);
  addEqual(clauses, params, "source_id", filters.source);
  addTableFilter(clauses, params, "source_table", filters.table);
  addObjectFilter(clauses, params, "business_object", "source_table", "object_id", filters.objectType, filters.objectId);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery(`SELECT * FROM (
    SELECT r.*, p.tenant_id, p.principal, p.action AS capability,
      p.business_object, p.object_id, p.source_id, p.source_table
    FROM writeback_receipts r
    JOIN proposals p ON p.proposal_id = r.proposal_id
  ) AS associated_receipts`, clauses, params, filters.limit);
}

export function buildEventQuery(filters: EventSearchFilters): SqlQuery {
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  addEqual(clauses, params, "proposal_id", filters.proposal);
  addEqual(clauses, params, "kind", filters.kind);
  addEqual(clauses, params, "actor", filters.actor);
  addTimeRange(clauses, params, "created_at", filters.from, filters.to);
  return finishQuery("SELECT * FROM proposal_events", clauses, params, filters.limit);
}

export function addEqual(clauses: string[], params: SqlParam[], column: string, value?: string): void {
  if (!value) return;
  clauses.push(`${column} = ?`);
  params.push(value);
}


function addEqualAny(clauses: string[], params: SqlParam[], column: string, values: string[]): void {
  const distinct = [...new Set(values.filter(Boolean))];
  const clause = inWhere(column, distinct);
  if (!clause) return;
  clauses.push(clause.sql);
  params.push(...clause.params);
}


function addJsonEqual(clauses: string[], params: SqlParam[], key: string, value?: string): void {
  if (!value) return;
  clauses.push(`json_extract(payload_json, '$.${key}') = ?`);
  params.push(value);
}


function addExploreOutcomeFilter(
  clauses: string[],
  params: SqlParam[],
  outcome: "ok" | "refused" | "failed" | undefined,
  payloadKey: "outcome" | "status",
): void {
  if (!outcome) return;
  const expression = `json_extract(payload_json, '$.${payloadKey}')`;
  if (outcome === "refused") {
    clauses.push(`${expression} LIKE 'refused_%'`);
    return;
  }
  if (outcome === "failed") {
    clauses.push(`${expression} = 'failed'`);
    return;
  }
  clauses.push(`${expression} IN ('ok', 'empty', 'fully_suppressed', 'incomplete_comparison')`);
}


function addJsonStatusFilter(clauses: string[], params: SqlParam[], value?: string): void {
  if (!value) return;
  clauses.push("json_extract(payload_json, '$.status') = ?");
  params.push(value);
}


function addEvidenceStatusFilter(clauses: string[], params: SqlParam[], value?: string): void {
  if (!value) return;
  clauses.push("(json_extract(payload_json, '$.outcome') = ? OR json_extract(payload_json, '$.status') = ?)");
  params.push(value, value);
}

export function addTableFilter(clauses: string[], params: SqlParam[], column: string, value?: string): void {
  if (!value) return;
  if (value.includes(".")) {
    clauses.push(`${column} = ?`);
    params.push(value);
    return;
  }
  clauses.push(`(${column} = ? OR ${column} = ?)`);
  params.push(value, `public.${value}`);
}

export function addObjectFilter(
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

export function addTimeRange(clauses: string[], params: SqlParam[], column: string, from?: string, to?: string): void {
  if (from) {
    clauses.push(`${column} >= ?`);
    params.push(from);
  }
  if (to) {
    clauses.push(`${column} <= ?`);
    params.push(to);
  }
}

function addMetadataSearch(
  clauses: string[],
  params: SqlParam[],
  value: string | undefined,
  columns: string[],
): void {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return;
  const escaped = normalized.replace(/[\\%_]/g, (character) => `\\${character}`);
  clauses.push(`(${columns.map((column) => `LOWER(COALESCE(${column}, '')) LIKE ? ESCAPE '\\'`).join(" OR ")})`);
  params.push(...columns.map(() => `%${escaped}%`));
}


export function finishQuery(
  base: string,
  clauses: string[],
  params: SqlParam[],
  limit?: number,
  offset?: number,
): SqlQuery {
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  const boundedOffset = Number.isSafeInteger(offset) && Number(offset) > 0 ? Number(offset) : 0;
  const sql = `${base}${where} ORDER BY created_at DESC${limit ? " LIMIT ?" : boundedOffset ? " LIMIT -1" : ""}${boundedOffset ? " OFFSET ?" : ""}`;
  return {
    sql,
    params: [
      ...params,
      ...(limit ? [limit] : []),
      ...(boundedOffset ? [boundedOffset] : []),
    ],
  };
}

export function objectTypeVariants(value: string): string[] {
  const variants = new Set<string>([value]);
  if (value.endsWith("s")) variants.add(value.slice(0, -1));
  else variants.add(`${value}s`);
  for (const variant of [...variants]) {
    if (!variant.includes(".")) variants.add(`public.${variant}`);
  }
  return [...variants];
}

export function stringFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function stringFromPrincipal(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) return stringFromUnknown(value.id);
  return undefined;
}

export function lastIdentifier(value: string): string {
  const parts = value.split(".");
  return parts[parts.length - 1] ?? value;
}
