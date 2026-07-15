import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { ProposalStore, type StoredProposal } from "@synapsor-runner/proposal-store";

export type ComplianceReportScope =
  | { kind: "object"; tenant_id: string; object_type: string; object_id: string }
  | { kind: "principal"; tenant_id: string; principal: string };

export type ComplianceReportEntry = {
  timestamp: string;
  category: "proposal" | "approval" | "event" | "evidence" | "query_audit" | "writeback_intent" | "receipt" | "replay" | "policy_recommendation" | "policy_decision" | "policy_artifact";
  id: string;
  proposal_id?: string;
  capability?: string;
  principal?: string;
  object?: string;
  details: Record<string, unknown>;
};

export type ComplianceReport = {
  schema_version: "synapsor.compliance-report.v1";
  generated_at: string;
  scope: ComplianceReportScope;
  entries: ComplianceReportEntry[];
  integrity: {
    algorithm: "sha256";
    digest: string;
    signed_payload: "canonical-report-content";
    signature?: { algorithm: "ed25519" | "rsa-sha256"; key_id: string; value: string };
  };
  boundary: string;
};

export async function createComplianceReport(input: {
  storePath: string;
  scope: ComplianceReportScope;
  signingKeyPath?: string;
  signingKeyId?: string;
  generatedAt?: string;
}): Promise<ComplianceReport> {
  const store = new ProposalStore(input.storePath);
  try {
    const filters = input.scope.kind === "object"
      ? { tenant: input.scope.tenant_id, objectType: input.scope.object_type, objectId: input.scope.object_id, limit: 1_000_000 }
      : { tenant: input.scope.tenant_id, principal: input.scope.principal, limit: 1_000_000 };
    const proposals = store.listProposals(filters);
    const proposalIds = new Set(proposals.map((proposal) => proposal.proposal_id));
    const entries: ComplianceReportEntry[] = [];

    for (const proposal of proposals) {
      entries.push(proposalEntry(proposal));
      for (const approval of store.approvals(proposal.proposal_id)) entries.push({
        timestamp: approval.created_at,
        category: "approval",
        id: `approval:${approval.approval_id}`,
        proposal_id: proposal.proposal_id,
        capability: proposal.capability ?? proposal.action,
        principal: approval.approver,
        object: `${proposal.business_object}:${proposal.object_id}`,
        details: sanitize({ status: approval.status, reason: approval.reason, identity_provider: approval.identity?.provider, verified: approval.identity?.verified, subject: approval.identity?.subject, decision_hash: approval.decision_hash, integrity_hash: approval.integrity_hash }),
      });
      for (const event of store.events(proposal.proposal_id)) entries.push({
        timestamp: event.created_at,
        category: "event",
        id: `event:${event.event_id}`,
        proposal_id: proposal.proposal_id,
        capability: proposal.capability ?? proposal.action,
        principal: event.actor,
        object: `${proposal.business_object}:${proposal.object_id}`,
        details: sanitize({ kind: event.kind, actor: event.actor, payload_included: false }),
      });
      for (const intent of store.listWritebackIntents({ proposal_id: proposal.proposal_id, limit: 1_000_000 })) entries.push({
        timestamp: intent.created_at,
        category: "writeback_intent",
        id: intent.intent_id,
        proposal_id: proposal.proposal_id,
        capability: proposal.capability ?? proposal.action,
        principal: proposal.principal,
        object: `${proposal.business_object}:${proposal.object_id}`,
        details: sanitize({ operation: intent.operation, status: intent.status, writeback_job_id: intent.writeback_job_id, runner_id: intent.runner_id, reconciliation_reason: intent.reconciliation_reason }),
      });
      entries.push({
        timestamp: proposal.updated_at,
        category: "replay",
        id: `replay_${proposal.proposal_id}`,
        proposal_id: proposal.proposal_id,
        capability: proposal.capability ?? proposal.action,
        principal: proposal.principal,
        object: `${proposal.business_object}:${proposal.object_id}`,
        details: { linkage: `synapsor://replay/${proposal.proposal_id}` },
      });
    }

    for (const evidence of store.listEvidenceBundles(filters)) {
      if (evidence.proposal_id) proposalIds.add(evidence.proposal_id);
      entries.push({
        timestamp: evidence.created_at,
        category: "evidence",
        id: evidence.evidence_bundle_id,
        ...(evidence.proposal_id ? { proposal_id: evidence.proposal_id } : {}),
        ...(evidence.capability ? { capability: evidence.capability } : {}),
        ...(evidence.principal ? { principal: evidence.principal } : {}),
        ...(evidence.business_object && evidence.object_id ? { object: `${evidence.business_object}:${evidence.object_id}` } : {}),
        details: sanitize({ source_id: evidence.source_id, source_table: evidence.source_table, query_fingerprint: evidence.query_fingerprint, row_payload_included: false }),
      });
    }
    for (const audit of store.listQueryAudit(filters)) entries.push(queryAuditEntry(audit));
    for (const receipt of store.listReceipts(filters)) entries.push({
      timestamp: receipt.created_at,
      category: "receipt",
      id: `receipt:${receipt.receipt_id}`,
      proposal_id: receipt.proposal_id,
      ...(receipt.capability ? { capability: receipt.capability } : {}),
      ...(receipt.principal ? { principal: receipt.principal } : {}),
      ...(receipt.business_object && receipt.object_id ? { object: `${receipt.business_object}:${receipt.object_id}` } : {}),
      details: sanitize({ status: receipt.status, writeback_job_id: receipt.writeback_job_id, runner_id: receipt.runner_id, source_database_mutated: receipt.source_database_mutated, receipt_schema_version: receipt.receipt.schema_version }),
    });
    for (const recommendation of store.listPolicyRecommendations({ tenant: input.scope.tenant_id })) {
      const linkedProposalIds = recommendation.evidence_proposal_ids.filter((proposalId) => proposalIds.has(proposalId));
      if (linkedProposalIds.length === 0) continue;
      entries.push({
        timestamp: recommendation.created_at,
        category: "policy_recommendation",
        id: recommendation.recommendation_id,
        capability: recommendation.capability,
        details: sanitize({
          policy: recommendation.policy,
          field: recommendation.field,
          current_threshold: recommendation.current_threshold,
          proposed_threshold: recommendation.proposed_threshold,
          maximum_increment: recommendation.maximum_increment,
          absolute_ceiling: recommendation.absolute_ceiling,
          criteria: recommendation.criteria,
          metrics: recommendation.metrics,
          linked_proposal_ids: linkedProposalIds,
          base_contract_digest: recommendation.base_contract_digest,
          base_contract_version: recommendation.base_contract_version,
          integrity_hash: recommendation.integrity_hash,
          status: recommendation.status,
          contract_activated: false,
        }),
      });
      if (recommendation.decision) entries.push({
        timestamp: recommendation.decision.decided_at,
        category: "policy_decision",
        id: `${recommendation.recommendation_id}:decision`,
        capability: recommendation.capability,
        principal: recommendation.decision.actor,
        details: sanitize({
          policy: recommendation.policy,
          action: recommendation.decision.action,
          reason: recommendation.decision.reason,
          identity_provider: recommendation.decision.identity.provider,
          identity_verified: recommendation.decision.identity.verified,
          decision_hash: recommendation.decision.identity.decision_hash,
          recommendation_integrity_hash: recommendation.integrity_hash,
          contract_activated: false,
        }),
      });
      if (recommendation.export) entries.push({
        timestamp: recommendation.export.exported_at,
        category: "policy_artifact",
        id: `${recommendation.recommendation_id}:artifact`,
        capability: recommendation.capability,
        principal: recommendation.export.actor,
        details: sanitize({
          policy: recommendation.policy,
          artifact_digest: recommendation.export.artifact_digest,
          base_contract_digest: recommendation.base_contract_digest,
          contract_activated: false,
        }),
      });
    }

    entries.sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.category.localeCompare(right.category) || left.id.localeCompare(right.id));
    const generatedAt = input.generatedAt ?? new Date().toISOString();
    const core = { schema_version: "synapsor.compliance-report.v1" as const, scope: input.scope, entries };
    const digest = `sha256:${crypto.createHash("sha256").update(canonicalJson(core)).digest("hex")}`;
    const report: ComplianceReport = {
      ...core,
      generated_at: generatedAt,
      integrity: { algorithm: "sha256", digest, signed_payload: "canonical-report-content" },
      boundary: "This export is tamper-evident when its digest/signature verifies. A local SQLite ledger is not immutable compliance storage.",
    };
    if (input.signingKeyPath) {
      const privateKey = crypto.createPrivateKey(await fs.readFile(input.signingKeyPath));
      const algorithm = privateKey.asymmetricKeyType === "ed25519" ? "ed25519" : "rsa-sha256";
      const signature = crypto.sign(algorithm === "ed25519" ? null : "sha256", Buffer.from(canonicalJson(core)), privateKey).toString("base64url");
      report.integrity.signature = { algorithm, key_id: input.signingKeyId ?? path.basename(input.signingKeyPath), value: signature };
    }
    return report;
  } finally {
    store.close();
  }
}

export async function formatComplianceReport(report: ComplianceReport, format: "json" | "markdown" | "pdf"): Promise<string | Uint8Array> {
  if (format === "json") return `${JSON.stringify(report, null, 2)}\n`;
  const encoded = Buffer.from(JSON.stringify(report), "utf8").toString("base64url");
  if (format === "markdown") return `${markdownReport(report)}\n<!-- synapsor-report-manifest:${encoded} -->\n`;
  const pdf = await PDFDocument.create();
  pdf.setTitle("Synapsor compliance report");
  pdf.setSubject(`synapsor-report-manifest:${encoded}`);
  pdf.setProducer("Synapsor Runner");
  pdf.setCreator("Synapsor Runner");
  pdf.setCreationDate(new Date(report.generated_at));
  pdf.setModificationDate(new Date(report.generated_at));
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  let page = pdf.addPage([612, 792]);
  let y = 756;
  for (const line of markdownReport(report).replace(/^#+\s*/gm, "").replace(/`/g, "").split("\n").flatMap((part) => wrap(part, 92))) {
    if (y < 42) { page = pdf.addPage([612, 792]); y = 756; }
    page.drawText(ascii(line), { x: 36, y, size: 8.5, font, color: rgb(0.08, 0.12, 0.14) });
    y -= 11;
  }
  return pdf.save({ useObjectStreams: false });
}

export async function readComplianceReport(filePath: string): Promise<ComplianceReport> {
  const data = await fs.readFile(filePath);
  if (data.subarray(0, 4).toString() === "%PDF") {
    const pdf = await PDFDocument.load(data);
    const subject = pdf.getSubject() ?? "";
    return decodeEmbedded(subject);
  }
  const text = data.toString("utf8");
  if (path.extname(filePath).toLowerCase() === ".json" || text.trimStart().startsWith("{")) return JSON.parse(text) as ComplianceReport;
  const match = text.match(/<!-- synapsor-report-manifest:([A-Za-z0-9_-]+) -->/);
  if (!match?.[1]) throw new Error("REPORT_MANIFEST_MISSING: Markdown report does not contain its canonical manifest");
  return JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")) as ComplianceReport;
}

export async function verifyComplianceReport(report: ComplianceReport, publicKeyPath?: string): Promise<{ ok: boolean; digest_ok: boolean; signature_ok?: boolean; code: string }> {
  const core = { schema_version: report.schema_version, scope: report.scope, entries: report.entries };
  const expected = `sha256:${crypto.createHash("sha256").update(canonicalJson(core)).digest("hex")}`;
  const digestOk = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(report.integrity?.digest ?? "").padEnd(expected.length, "\0").slice(0, expected.length)))
    && expected === report.integrity?.digest;
  if (!digestOk) return { ok: false, digest_ok: false, code: "REPORT_DIGEST_MISMATCH" };
  if (!report.integrity.signature) return { ok: true, digest_ok: true, code: "REPORT_DIGEST_VERIFIED" };
  if (!publicKeyPath) return { ok: false, digest_ok: true, signature_ok: false, code: "REPORT_PUBLIC_KEY_REQUIRED" };
  const publicKey = crypto.createPublicKey(await fs.readFile(publicKeyPath));
  const signatureOk = crypto.verify(report.integrity.signature.algorithm === "ed25519" ? null : "sha256", Buffer.from(canonicalJson(core)), publicKey, Buffer.from(report.integrity.signature.value, "base64url"));
  return { ok: signatureOk, digest_ok: true, signature_ok: signatureOk, code: signatureOk ? "REPORT_SIGNATURE_VERIFIED" : "REPORT_SIGNATURE_INVALID" };
}

function proposalEntry(proposal: StoredProposal): ComplianceReportEntry {
  const change = proposal.change_set;
  return {
    timestamp: proposal.created_at,
    category: "proposal",
    id: proposal.proposal_id,
    proposal_id: proposal.proposal_id,
    capability: proposal.capability ?? proposal.action,
    principal: proposal.principal ?? change.principal.id,
    object: `${proposal.business_object}:${proposal.object_id}`,
    details: sanitize({
      state: proposal.state,
      action: proposal.action,
      operation: "operation" in change ? change.operation : "single_row_update",
      source_id: proposal.source_id,
      source_table: proposal.source_table,
      before: change.before,
      patch: change.patch,
      after: change.after,
      allowed_columns: change.guards.allowed_columns,
      source_database_mutated: proposal.source_database_mutated,
      proposal_hash: proposal.proposal_hash,
    }),
  };
}

function queryAuditEntry(audit: Record<string, unknown>): ComplianceReportEntry {
  const proposalId = string(audit.proposal_id);
  const objectType = string(audit.business_object) ?? string(audit.table_name);
  const objectId = string(audit.object_id) ?? string(audit.primary_key_value);
  return {
    timestamp: string(audit.created_at) ?? "",
    category: "query_audit",
    id: `query-audit:${string(audit.audit_id) ?? "unknown"}`,
    ...(proposalId ? { proposal_id: proposalId } : {}),
    ...(string(audit.capability) ? { capability: string(audit.capability)! } : {}),
    ...(string(audit.principal) ? { principal: string(audit.principal)! } : {}),
    ...(objectType && objectId ? { object: `${objectType}:${objectId}` } : {}),
    details: sanitize({ evidence_bundle_id: audit.evidence_bundle_id, source_id: audit.source_id, table_name: audit.table_name, query_fingerprint: audit.query_fingerprint, row_count: audit.row_count, raw_sql_included: false }),
  };
}

function markdownReport(report: ComplianceReport): string {
  const scope = report.scope.kind === "object" ? `${report.scope.object_type}:${report.scope.object_id}` : report.scope.principal;
  return [
    "# Synapsor Compliance Report",
    "",
    `- Scope: ${report.scope.kind} ${scope}`,
    `- Tenant: ${report.scope.tenant_id}`,
    `- Generated: ${report.generated_at}`,
    `- Integrity: ${report.integrity.digest}`,
    `- Signature: ${report.integrity.signature ? `${report.integrity.signature.algorithm} / ${report.integrity.signature.key_id}` : "not signed"}`,
    "",
    "## Chronology",
    "",
    ...report.entries.flatMap((entry) => [
      `### ${entry.timestamp} - ${entry.category} - ${entry.id}`,
      `- Proposal: ${entry.proposal_id ?? "none"}`,
      `- Capability: ${entry.capability ?? "none"}`,
      `- Principal: ${entry.principal ?? "none"}`,
      `- Object: ${entry.object ?? "none"}`,
      `- Details: ${JSON.stringify(entry.details)}`,
      "",
    ]),
    "## Integrity Boundary",
    "",
    report.boundary,
  ].join("\n");
}

function sanitize(value: unknown, key = ""): any {
  if (/password|passwd|secret|token|private[_-]?key|authorization|cookie|database[_-]?url|raw[_-]?sql/i.test(key)) return "[redacted]";
  if (typeof value === "string") {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) return "[redacted]";
    if (/(?:postgres(?:ql)?|mysql):\/\//i.test(value)) return "[database-url-redacted]";
    if (/^Bearer\s+/i.test(value)) return "Bearer [redacted]";
    if (/(?:^|[\s"'])\/(?:home|Users)\//.test(value)) return "[local-path-redacted]";
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).map(([childKey, child]) => [childKey, sanitize(child, childKey)]));
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, child]) => child !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

function decodeEmbedded(subject: string): ComplianceReport {
  const prefix = "synapsor-report-manifest:";
  if (!subject.startsWith(prefix)) throw new Error("REPORT_MANIFEST_MISSING: PDF does not contain its canonical manifest");
  return JSON.parse(Buffer.from(subject.slice(prefix.length), "base64url").toString("utf8")) as ComplianceReport;
}

function wrap(value: string, width: number): string[] {
  if (!value) return [""];
  const words = value.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (!current) current = word;
    else if (`${current} ${word}`.length <= width) current += ` ${word}`;
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines;
}

function ascii(value: string): string { return value.replace(/[^\x20-\x7E]/g, "?"); }
function string(value: unknown): string | undefined { return typeof value === "string" || typeof value === "number" ? String(value) : undefined; }
