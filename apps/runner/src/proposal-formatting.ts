import {
  type ProposalEvent,
  type ProposalReplayRecord,
  type StoredEvidenceBundle,
  type StoredProposal,
  type StoredWritebackReceipt
} from "@synapsor-runner/proposal-store";
import { protocolVersions } from "@synapsor-runner/protocol";
import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";
import { approvalBoundary, boundedSetReviewLines, currentApprovalStatus, currentWritebackStatus, formatChangeLines, formatReceiptId, formatScalar, humanStatus, isRecord, plural, proposalNextCommands, receiptOperationLabel, stringField } from "./cli-format.js";
import { renderTerminalJson } from "./terminal-syntax.js";


export function formatProposalSummary(proposal: StoredProposal): string {
  return [
    `${proposal.created_at}  ${proposal.proposal_id}  ${proposal.state}  ${proposal.action}`,
    `  object: ${proposal.business_object}:${proposal.object_id}`,
    `  target: ${proposal.source_kind}:${proposal.source_id}/${proposal.source_schema}.${proposal.source_table}/${proposal.object_id}`,
    `  tenant: ${proposal.tenant_id}  source changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
  ].join("\n") + "\n";
}


export function formatProposalFirstLook(proposal: StoredProposal, storedEvidenceItemCount: number | undefined, proposalRef: string, storeSuffix: string): string {
  const evidenceItems = storedEvidenceItemCount ?? proposal.change_set.evidence.items?.length ?? 0;
  return [
    `Proposal ${proposal.proposal_id}`,
    `Status: ${humanStatus(proposal.state)}`,
    "",
    "Agent requested:",
    proposal.action,
    "",
    "Business object:",
    `${proposal.business_object} ${proposal.object_id}`,
    ...boundedSetReviewLines(proposal.change_set),
    "",
    "Proposed change:",
    ...formatChangeLines(proposal).map((line) => line.replace(/^  /, "")),
    "",
    "Source DB changed:",
    proposal.source_database_mutated ? "yes" : "no",
    "",
    "Approval:",
    approvalBoundary(proposal),
    "",
    "Evidence:",
    `${proposal.change_set.evidence.bundle_id}${evidenceItems > 0 ? ` (${plural(evidenceItems, "item")})` : ""}`,
    "",
    "Next:",
    ...proposalNextCommands(proposal, proposalRef, storeSuffix).map((command) => `${command}`),
    "",
    "More detail:",
    `${cliCommandName()} lifecycle show proposal:${proposal.proposal_id} --details${storeSuffix}`,
    `${cliCommandName()} proposals show ${proposalRef} --details${storeSuffix}`,
    "",
  ].join("\n");
}


export function formatProposalDetail(proposal: StoredProposal, storedEvidenceItemCount?: number): string {
  const changeSet = proposal.change_set;
  const conflictGuard = "expected_version" in changeSet.guards ? changeSet.guards.expected_version : undefined;
  const evidenceItems = storedEvidenceItemCount ?? changeSet.evidence.items?.length ?? 0;
  const approvalStatus = currentApprovalStatus(proposal);
  const writebackStatus = currentWritebackStatus(proposal);
  return [
    `Proposal details: ${proposal.proposal_id}`,
    "",
    "Review details:",
    `principal: ${changeSet.principal.id} (${changeSet.principal.source})`,
    `tenant: ${proposal.tenant_id}`,
    `target: ${proposal.source_kind}:${proposal.source_id}/${proposal.source_schema}.${proposal.source_table}/${proposal.object_id}`,
    `primary key: ${changeSet.source.primary_key.column}${changeSet.source.primary_key.value === undefined ? " (exact identities frozen below)" : `=${formatScalar(changeSet.source.primary_key.value)}`}`,
    `status: ${proposal.state}`,
    `action: ${proposal.action}`,
    `approval: ${approvalStatus}${changeSet.approval.required_role ? ` required role ${changeSet.approval.required_role}` : ""}`,
    `proposal hash: ${proposal.proposal_hash}`,
    `proposal version: ${proposal.proposal_version}`,
    `allowed columns: ${changeSet.guards.allowed_columns.join(", ")}`,
    `conflict guard: ${conflictGuard?.column || "none"}=${formatScalar(conflictGuard?.value)}`,
    `evidence: ${changeSet.evidence.bundle_id}  query ${changeSet.evidence.query_fingerprint}  items ${evidenceItems}`,
    `writeback: ${writebackStatus} via ${changeSet.writeback.mode}`,
    `source database changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
    ...boundedSetReviewLines(changeSet, true),
    "",
    "Diff:",
    ...formatChangeLines(proposal, 100),
  ].join("\n") + "\n";
}


export function formatProposalEventDetail(events: ProposalEvent[]): string {
  if (events.length === 0) return "Events:\n  none\n";
  return [
    "Events:",
    ...events.map((event) => `  event ${event.event_id}: ${event.kind} by ${event.actor} at ${event.created_at}`),
  ].join("\n") + "\n";
}


export function formatProposalDebug(proposal: StoredProposal, storePath: string | undefined): string {
  return [
    "Debug:",
    `store: ${storePath ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db"}`,
    `interaction id: ${proposal.interaction_id ?? "none"}`,
    `tool call id: ${proposal.tool_call_id ?? "none"}`,
    `source kind: ${proposal.source_kind}`,
    `writeback mode: ${proposal.change_set.writeback.mode}`,
    "",
  ].join("\n");
}


export function formatEvidenceSummary(evidence: StoredEvidenceBundle): string {
  const outcome = stringField(evidence.payload, "outcome") ?? "recorded";
  return [
    `${evidence.created_at}  ${evidence.evidence_bundle_id}  ${outcome}`,
    `  tenant: ${evidence.tenant_id}  capability: ${evidence.capability ?? "unknown"}  proposal: ${evidence.proposal_id ?? "none"}`,
    `  source: ${evidence.source_id ?? "unknown"}/${evidence.source_table ?? "unknown"}  object: ${evidence.business_object ?? "object"}:${evidence.object_id ?? "unknown"}`,
  ].join("\n") + "\n";
}


export function formatEvidenceFirstLook(evidence: StoredEvidenceBundle, storeSuffix: string): string {
  const object = evidence.business_object && evidence.object_id ? `${evidence.business_object} ${evidence.object_id}` : "not linked";
  const lines = [
    `Evidence ${evidence.evidence_bundle_id}`,
    "",
    "Used for:",
    evidence.capability ?? "unknown capability",
    object,
    "",
    "Captured:",
    plural(evidence.items.length, "evidence item"),
    plural(evidence.query_audit.length, "query audit record"),
    "",
    "Source:",
    `${evidence.source_id ?? "unknown"} / ${evidence.source_table ?? "unknown"}`,
    "",
    "Rows:",
    ...evidence.items.flatMap((item, index) => formatEvidenceItem(item, index + 1)),
    "",
    "Next:",
    `  ${cliCommandName()} lifecycle show evidence:${evidence.evidence_bundle_id}${storeSuffix}`,
    `  ${cliCommandName()} query-audit list --evidence ${evidence.evidence_bundle_id}${storeSuffix}`,
    ...(evidence.proposal_id ? [`  ${cliCommandName()} replay show --proposal ${evidence.proposal_id}${storeSuffix}`] : []),
    "",
    "More detail:",
    `  ${cliCommandName()} evidence show ${evidence.evidence_bundle_id} --details${storeSuffix}`,
  ];
  return `${lines.join("\n")}\n`;
}


export function formatEvidenceDetail(evidence: StoredEvidenceBundle): string {
  const audit = evidence.query_audit[0];
  const payload = evidence.payload;
  const trustedScope = isRecord(payload.trusted_scope) ? payload.trusted_scope : {};
  const normalizedPlan = isRecord(payload.normalized_plan)
    ? payload.normalized_plan
    : isRecord(audit?.payload) && isRecord(audit.payload.normalized_plan)
      ? audit.payload.normalized_plan
      : undefined;
  const principal = evidence.principal
    ?? (trustedScope.principal_bound === false ? "not applicable (this resource has no reviewed principal scope)" : "not recorded");
  const lines = [
    `Evidence bundle: ${evidence.evidence_bundle_id}`,
    `Tenant: ${evidence.tenant_id}`,
    `Proposal: ${evidence.proposal_id ?? "none"}`,
    `Principal: ${principal}`,
    `Capability: ${evidence.capability ?? "unknown"}`,
    `Source: ${evidence.source_id ?? "unknown"}`,
    `Table: ${evidence.source_table ?? "unknown"}`,
    `Boundary digest: ${stringField(payload, "boundary_digest") ?? "not recorded"}`,
    `Generation lock: ${stringField(payload, "generation_lock_fingerprint") ?? "not recorded"}`,
    `Role posture: ${stringField(payload, "role_posture_fingerprint") ?? "not recorded"}`,
    `Query fingerprint: ${evidence.query_fingerprint ?? stringField(audit, "query_fingerprint") ?? "unknown"}`,
    `Result fingerprint: ${stringField(payload, "result_fingerprint") ?? "not recorded"}`,
    `Outcome: ${stringField(payload, "outcome") ?? "recorded"}`,
    `Returned rows or groups: ${formatMetadataValue(payload.returned_rows_or_groups)}`,
    `Returned cells: ${formatMetadataValue(payload.returned_cells)}`,
    `Suppressed groups: ${formatMetadataValue(payload.suppressed_groups)}`,
    `Execution duration: ${formatMetadataValue(payload.execution_duration_ms, " ms")}`,
    `Rows captured: ${evidence.items.length}`,
    `Source query executed: ${formatMetadataBoolean(payload.source_query_executed)}`,
    `Source database changed: ${formatMetadataBoolean(payload.source_database_changed)}`,
    `Result values persisted: ${formatMetadataBoolean(payload.result_values_persisted)}`,
    `Trusted scope values persisted: ${formatMetadataBoolean(payload.trusted_scope_values_persisted ?? trustedScope.values_persisted)}`,
    `Created at: ${evidence.created_at}`,
    "Persistence: evidence contains bounded metadata and keyed fingerprints, not result rows, raw SQL, credentials, or trusted tenant/principal values.",
    "",
    "Normalized reviewed plan:",
    normalizedPlan ? renderTerminalJson(normalizedPlan, false) : "not recorded",
    "",
    "Stored evidence items:",
    ...(evidence.items.length
      ? evidence.items.flatMap((item, index) => formatEvidenceItem(item, index + 1))
      : ["none (Explore result values are not persisted)"]),
    "",
    "Related:",
    ...(evidence.proposal_id ? [`  ${cliCommandName()} proposals show ${evidence.proposal_id}`, `  ${cliCommandName()} replay show --proposal ${evidence.proposal_id}`] : []),
    `  ${cliCommandName()} query-audit list --evidence ${evidence.evidence_bundle_id}`,
  ];
  return `${lines.join("\n")}\n`;
}


function formatMetadataValue(value: unknown, suffix = ""): string {
  if (typeof value === "number" && Number.isFinite(value)) return `${value}${suffix}`;
  if (typeof value === "string" && value) return `${value}${suffix}`;
  return "not recorded";
}


function formatMetadataBoolean(value: unknown): string {
  return value === true ? "yes" : value === false ? "no" : "not recorded";
}


function formatEvidenceItem(item: Record<string, unknown>, index: number): string[] {
  const payload = isRecord(item.item) ? item.item : item;
  const visibleRow = isRecord(payload.visible_row) ? payload.visible_row : payload;
  const title = stringField(payload, "kind") ?? "item";
  const primaryKey = isRecord(payload.primary_key) ? payload.primary_key : undefined;
  const heading = primaryKey
    ? `* ${title} ${formatScalar(primaryKey.value)}`
    : `* ${title} ${index}`;
  const rows = Object.entries(visibleRow)
    .filter(([key]) => !["kind", "source_id", "table", "primary_key", "tenant"].includes(key))
    .flatMap(([key, value]) => formatEvidenceFieldLines(key, value))
    .slice(0, 12);
  return [heading, ...(rows.length ? rows : ["  (no scalar preview fields)"])];
}


function formatEvidenceFieldLines(key: string, value: unknown): string[] {
  if (isRecord(value)) {
    const nested = Object.entries(value)
      .filter(([, nestedValue]) => nestedValue === null || ["string", "number", "boolean"].includes(typeof nestedValue))
      .slice(0, 6)
      .map(([nestedKey, nestedValue]) => `  ${key}.${nestedKey}: ${formatScalar(nestedValue)}`);
    return nested.length ? nested : [`  ${key}: [object]`];
  }
  return [`  ${key}: ${formatScalar(value)}`];
}


export function formatEvidenceMarkdown(evidence: StoredEvidenceBundle): string {
  return [
    `# Evidence ${evidence.evidence_bundle_id}`,
    "",
    `- Tenant: ${evidence.tenant_id}`,
    `- Proposal: ${evidence.proposal_id ?? "none"}`,
    `- Principal: ${evidence.principal ?? "unknown"}`,
    `- Capability: ${evidence.capability ?? "unknown"}`,
    `- Source: ${evidence.source_id ?? "unknown"}`,
    `- Table: ${evidence.source_table ?? "unknown"}`,
    `- Query fingerprint: ${evidence.query_fingerprint ?? "unknown"}`,
    `- Created at: ${evidence.created_at}`,
    "",
    "## Captured Items",
    "",
    "```json",
    JSON.stringify(evidence.items, null, 2),
    "```",
    "",
    "## Query Audit",
    "",
    "```json",
    JSON.stringify(evidence.query_audit, null, 2),
    "```",
  ].join("\n") + "\n";
}


export function formatQueryAuditSummary(row: Record<string, unknown>, details = false, storeSuffix = ""): string {
  const payload = isRecord(row.payload) ? row.payload : {};
  const status = stringField(payload, "status") ?? "recorded";
  const errorCode = stringField(payload, "error_code");
  const lines = [
    `${row.created_at}  audit ${row.audit_id}  ${status}${errorCode ? ` (${errorCode})` : ""}`,
    `  source: ${row.source_id}/${row.table_name}  rows: ${row.row_count}`,
    `  proposal: ${row.proposal_id ?? "none"}  evidence: ${row.evidence_bundle_id ?? "none"}`,
    ...(details ? [`  query fingerprint: ${row.query_fingerprint}`] : []),
    `  detail: ${cliCommandName()} query-audit show ${row.audit_id}${details ? "" : " --details"}${storeSuffix}`,
  ];
  return lines.join("\n") + "\n";
}


export function formatQueryAuditFirstLook(row: Record<string, unknown>, storeSuffix: string): string {
  return [
    `Query audit ${row.audit_id}`,
    "",
    "Read:",
    `${row.source_id}/${row.table_name}`,
    "",
    "Rows returned:",
    String(row.row_count ?? "unknown"),
    "",
    "Linked records:",
    `proposal: ${row.proposal_id ?? "none"}`,
    `evidence: ${row.evidence_bundle_id ?? "none"}`,
    "",
    "More detail:",
    `${cliCommandName()} lifecycle show audit:${String(row.audit_id)}${storeSuffix}`,
    `${cliCommandName()} query-audit show ${row.audit_id} --details${storeSuffix}`,
    "",
  ].join("\n");
}


export function formatQueryAuditDetail(row: Record<string, unknown>, color = false): string {
  const payload = isRecord(row.payload) ? row.payload : {};
  return [
    `Query audit: ${row.audit_id}`,
    `Created at: ${row.created_at}`,
    `Source: ${row.source_id}`,
    `Table: ${row.table_name}`,
    `Rows: ${row.row_count}`,
    `Query fingerprint: ${row.query_fingerprint}`,
    `Proposal: ${row.proposal_id ?? "none"}`,
    `Evidence: ${row.evidence_bundle_id ?? "none"}`,
    `Tenant: ${row.tenant_id ?? "not recorded"}`,
    `Principal: ${row.principal ?? "not recorded (legacy records may only state whether principal scope was bound)"}`,
    `Capability: ${row.capability ?? payload.capability ?? "unknown"}`,
    `Status: ${payload.status ?? "recorded"}`,
    `Error code: ${payload.error_code ?? "none"}`,
    `Boundary digest: ${payload.boundary_digest ?? "not recorded"}`,
    `Parameters redacted: ${payload.parameters_redacted === true ? "yes" : "unknown"}`,
    "",
    "Payload:",
    renderTerminalJson(payload, color),
  ].join("\n") + "\n";
}


export function formatReceiptSummary(receipt: StoredWritebackReceipt): string {
  return [
    `${receipt.created_at}  receipt ${receipt.receipt_id}  ${receipt.status}`,
    `  proposal: ${receipt.proposal_id}  job: ${receipt.writeback_job_id}`,
    `  idempotency: ${receipt.idempotency_key}  source changed: ${receipt.source_database_mutated ? "yes" : "no"}`,
  ].join("\n") + "\n";
}


export function formatReceiptFirstLook(receipt: StoredWritebackReceipt, storeSuffix: string): string {
  const setReceipt = receipt.receipt.schema_version === protocolVersions.executionReceiptV3 ? receipt.receipt : undefined;
  const checks = receipt.status === "applied"
    ? setReceipt
      ? ["every frozen identity matched", "trusted tenant matched", "allowed columns only", "every version guard passed", "one atomic set transaction"]
      : ["primary key matched", "tenant guard matched", "allowed columns only", "conflict guard passed"]
    : receipt.status === "conflict"
      ? ["primary key matched", "tenant guard matched", "conflict guard blocked stale write"]
      : ["guarded writeback did not apply"];
  return [
    `Receipt ${formatReceiptId(receipt.receipt_id)}`,
    `Status: ${humanStatus(receipt.status)}`,
    "",
    "Proposal:",
    receipt.proposal_id,
    "",
    "Writeback:",
    setReceipt ? `guarded bounded-set ${setReceipt.operation.replace(/^set_|^batch_/, "").toUpperCase()}` : `guarded ${receiptOperationLabel(receipt)}`,
    "",
    "Checks:",
    ...checks.map((check) => `${check}`),
    `affected rows: ${receipt.receipt.rows_affected}`,
    "",
    "Source DB changed:",
    receipt.source_database_mutated ? "yes" : "no",
    "",
    "Next:",
    `${cliCommandName()} lifecycle show receipt:${receipt.receipt_id}${storeSuffix}`,
    `${cliCommandName()} replay show --proposal ${receipt.proposal_id}${storeSuffix}`,
    "",
    "More detail:",
    `${cliCommandName()} receipts show ${receipt.receipt_id} --details${storeSuffix}`,
    "",
  ].join("\n");
}


export function formatReceiptDetail(receipt: StoredWritebackReceipt): string {
  const setReceipt = receipt.receipt.schema_version === protocolVersions.executionReceiptV3 ? receipt.receipt : undefined;
  return [
    `Receipt: ${receipt.receipt_id}`,
    `Proposal: ${receipt.proposal_id}`,
    `Writeback job: ${receipt.writeback_job_id}`,
    `Runner: ${receipt.runner_id}`,
    `Status: ${receipt.status}`,
    `Idempotency key: ${receipt.idempotency_key}`,
    `Source database mutated: ${receipt.source_database_mutated ? "yes" : "no"}`,
    `Rows affected: ${receipt.receipt.rows_affected}`,
    ...(setReceipt ? [
      `Operation: ${setReceipt.operation}`,
      `Frozen set digest: ${setReceipt.target.set_digest}`,
      `Exact member effects: ${setReceipt.member_effects.length}`,
      ...setReceipt.member_effects.map((member) => `  ${member.primary_key.column}=${formatScalar(member.primary_key.value)} before=${member.before_digest ?? "none"} after=${member.after_digest ?? "none"} tombstone=${member.tombstone_digest ?? "none"}`),
    ] : []),
    `Safe error: ${receipt.receipt.safe_error_code ?? "none"}`,
    `Receipt hash: ${receipt.receipt.receipt_hash}`,
    `Created at: ${receipt.created_at}`,
    "",
    "Related:",
    `  ${cliCommandName()} replay show --proposal ${receipt.proposal_id}`,
  ].join("\n") + "\n";
}


export function formatReplaySummary(row: Record<string, unknown>): string {
  return [
    `${row.created_at}  ${row.replay_id}`,
    `  proposal: ${row.proposal_id}  status: ${row.state}`,
    `  tenant: ${row.tenant_id}  capability: ${row.capability}  object: ${row.business_object}:${row.object_id}`,
  ].join("\n") + "\n";
}


export function formatReplayFirstLook(replay: ProposalReplayRecord, storeSuffix: string): string {
  const proposal = replay.proposal;
  const evidenceItems = replay.evidence.reduce((count, item) => {
    const evidence = item as { items?: unknown };
    return count + (Array.isArray(evidence.items) ? evidence.items.length : 0);
  }, 0);
  const latestReceipt = replay.receipts.at(-1);
  const writebackStatus = latestReceipt ? humanStatus(latestReceipt.status) : humanStatus(currentWritebackStatus(proposal));
  const approvalLine = proposal.state === "pending_review"
    ? "Approval is still pending"
    : `Proposal is ${humanStatus(proposal.state)}`;
  return [
    `Replay ${replay.replay_id}`,
    "",
    "What happened:",
    `1. Agent called ${proposal.action}`,
    `2. Runner read ${proposal.business_object} ${proposal.object_id} under tenant ${proposal.tenant_id}`,
    `3. Runner created evidence bundle ${proposal.change_set.evidence.bundle_id}`,
    "4. Runner created a proposal",
    `5. Source DB changed: ${proposal.source_database_mutated ? "yes" : "no"}`,
    `6. ${approvalLine}`,
    "",
    "Proposed change:",
    ...formatChangeLines(proposal).map((line) => line.replace(/^  /, "")),
    "",
    "Evidence:",
    plural(replay.query_audit.length, "query audit record"),
    plural(evidenceItems, "evidence item"),
    "",
    "Writeback:",
    writebackStatus,
    ...(latestReceipt ? [`source DB changed after writeback: ${latestReceipt.source_database_mutated ? "yes" : "no"}`] : []),
    "",
    "Next:",
    `  ${cliCommandName()} evidence show ${proposal.change_set.evidence.bundle_id}${storeSuffix}`,
    ...(proposal.state === "pending_review" ? [`  ${cliCommandName()} proposals approve ${proposal.proposal_id} --yes${storeSuffix}`] : []),
    "",
    "More detail:",
    `  ${cliCommandName()} lifecycle show replay:${replay.replay_id} --details${storeSuffix}`,
    `  ${cliCommandName()} replay show --proposal ${proposal.proposal_id} --details${storeSuffix}`,
    "",
  ].join("\n");
}


export function formatReplayDetail(replay: ProposalReplayRecord): string {
  const evidenceItems = replay.evidence.reduce((count, item) => {
    const evidence = item as { items?: unknown };
    return count + (Array.isArray(evidence.items) ? evidence.items.length : 0);
  }, 0);
  return [
    `Replay details ${replay.replay_id}`,
    formatProposalDetail(replay.proposal, evidenceItems).trimEnd(),
    `events: ${replay.events.length}`,
    ...replay.events.map((event) => `  ${event.kind} by ${event.actor} at ${event.created_at}`),
    `receipts: ${replay.receipts.length}`,
    ...replay.receipts.map((receipt) => `  receipt ${receipt.receipt_id}: ${receipt.status} job ${receipt.writeback_job_id}`),
    `evidence bundles: ${replay.evidence.length}`,
    ...replay.evidence.map((evidence) => `  ${(evidence as { evidence_bundle_id?: string }).evidence_bundle_id ?? "unknown"}`),
    `query audit records: ${replay.query_audit.length}`,
    ...replay.query_audit.map((record) => `  audit ${(record as { audit_id?: unknown }).audit_id}: ${(record as { source_id?: unknown }).source_id}/${(record as { table_name?: unknown }).table_name} rows ${(record as { row_count?: unknown }).row_count}`),
  ].join("\n") + "\n";
}


export function formatReplayDebug(replay: ProposalReplayRecord, storePath: string | undefined): string {
  return [
    "Debug:",
    `store: ${storePath ?? process.env.SYNAPSOR_LOCAL_STORE ?? "./.synapsor/local.db"}`,
    `generated at: ${replay.generated_at}`,
    `event ids: ${replay.events.map((event) => event.event_id).join(", ") || "none"}`,
    `receipt ids: ${replay.receipts.map((receipt) => receipt.receipt_id).join(", ") || "none"}`,
    "",
  ].join("\n");
}


export function formatReplayMarkdown(replay: ProposalReplayRecord): string {
  const proposal = replay.proposal;
  const principal = proposal.change_set.principal.id;
  const approvalEvents = replay.events.filter((event) => /approved|rejected|canceled/i.test(event.kind));
  const evidenceLines = replay.evidence.length > 0
    ? replay.evidence.flatMap((evidence) => {
      const record = evidence as {
        evidence_bundle_id?: string;
        payload?: Record<string, unknown>;
        items?: unknown[];
        query_audit?: unknown[];
      };
      const payload = isRecord(record.payload) ? record.payload : {};
      const sourceId = stringField(payload, "source_id") ?? proposal.source_id;
      const table = stringField(payload, "target") ?? `${proposal.source_schema}.${proposal.source_table}`;
      const queryFingerprint = stringField(payload, "query_fingerprint") ?? proposal.change_set.evidence.query_fingerprint;
      return [
        `- evidence: ${record.evidence_bundle_id ?? proposal.change_set.evidence.bundle_id}`,
        `  - source: ${sourceId}.${table}`,
        `  - query fingerprint: ${queryFingerprint}`,
        `  - rows captured: ${Array.isArray(record.items) ? record.items.length : 0}`,
      ];
    })
    : [`- evidence: ${proposal.change_set.evidence.bundle_id}`, `  - source: ${proposal.source_id}.${proposal.source_schema}.${proposal.source_table}`, `  - query fingerprint: ${proposal.change_set.evidence.query_fingerprint}`, "  - rows captured: 0"];
  const receiptLines = replay.receipts.length > 0
    ? replay.receipts.flatMap((receipt) => [
      `- receipt: ${receipt.receipt_id}`,
      `  - status: ${receipt.status}`,
      `  - affected rows: ${receipt.receipt.rows_affected}`,
      `  - idempotency key: ${receipt.idempotency_key}`,
      `  - source database mutated: ${receipt.source_database_mutated ? "yes" : "no"}`,
      ...(receipt.receipt.safe_error_code ? [`  - safe error: ${receipt.receipt.safe_error_code}`] : []),
    ])
    : ["- no writeback receipt recorded yet"];
  return [
    "# Synapsor Replay",
    "",
    `Proposal: ${proposal.proposal_id}`,
    `Capability: ${proposal.action}`,
    `Tenant: ${proposal.tenant_id}`,
    `Object: ${proposal.business_object}:${proposal.object_id}`,
    `Status: ${proposal.state}`,
    "",
    "## What The Agent Requested",
    "",
    `The model-facing capability requested \`${proposal.action}\` for ${proposal.business_object}:${proposal.object_id}.`,
    "The source database was not mutated when the proposal was created.",
    "",
    "## Trusted Context",
    "",
    `tenant_id = ${proposal.tenant_id}`,
    `principal = ${principal}`,
    `principal_source = ${proposal.change_set.principal.source}`,
    "",
    "## Evidence",
    "",
    ...evidenceLines,
    "",
    "## Proposed Diff",
    "",
    ...formatChangeLines(proposal, 100).map((line) => `- ${line.trim()}`),
    "",
    "## Approval",
    "",
    ...(approvalEvents.length > 0
      ? approvalEvents.map((event) => `- ${event.kind} by ${event.actor} at ${event.created_at}`)
      : [`- ${proposal.change_set.approval.status}${proposal.change_set.approval.required_role ? `; required role: ${proposal.change_set.approval.required_role}` : ""}`]),
    "",
    "## Guarded Writeback",
    "",
    ...receiptLines,
    "",
    "## Query Audit",
    "",
    ...replay.query_audit.map((record) => `- audit ${(record as { audit_id?: unknown }).audit_id}: ${(record as { source_id?: unknown }).source_id}/${(record as { table_name?: unknown }).table_name} rows ${(record as { row_count?: unknown }).row_count} fingerprint ${(record as { query_fingerprint?: unknown }).query_fingerprint}`),
    "",
    "## Replay Note",
    "",
    "This is local captured interaction replay, not external database time travel. It reconstructs what the runner recorded: trusted context, evidence handles, proposal diff, approval events, query audit, and writeback receipts.",
  ].join("\n") + "\n";
}
