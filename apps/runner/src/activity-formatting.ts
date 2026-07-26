import {
  type ProposalEvent,
  type StoredEvidenceBundle,
  type StoredProposal,
  type StoredWritebackReceipt,
  type StorePruneResult,
  type StoreStats
} from "@synapsor-runner/proposal-store";
import {
  type McpAuditReport
} from "@synapsor-runner/worker-core";
import { cliCommandName } from "./cli-command-meta.js";
import { humanStatus, stringField } from "./cli-format.js";


export function activityFromProposal(proposal: StoredProposal): Record<string, unknown> {
  return {
    kind: "proposal",
    created_at: proposal.created_at,
    capability: proposal.action,
    tenant: proposal.tenant_id,
    principal: proposal.principal ?? proposal.change_set.principal.id,
    object: `${proposal.business_object}:${proposal.object_id}`,
    proposal: proposal.proposal_id,
    evidence: proposal.change_set.evidence.bundle_id,
    status: proposal.state,
    replay: `replay_${proposal.proposal_id}`,
    source: proposal.source_id,
    table: `${proposal.source_schema}.${proposal.source_table}`,
  };
}


export function activityFromEvidence(evidence: StoredEvidenceBundle): Record<string, unknown> {
  return {
    kind: "evidence",
    created_at: evidence.created_at,
    capability: evidence.capability,
    tenant: evidence.tenant_id,
    principal: evidence.principal,
    object: evidence.business_object && evidence.object_id ? `${evidence.business_object}:${evidence.object_id}` : undefined,
    proposal: evidence.proposal_id,
    evidence: evidence.evidence_bundle_id,
    status: "evidence_recorded",
    source: evidence.source_id,
    table: evidence.source_table,
  };
}


export function activityFromQueryAudit(audit: Record<string, unknown>): Record<string, unknown> {
  const businessObject = stringField(audit, "business_object");
  const objectId = stringField(audit, "object_id") ?? stringField(audit, "primary_key_value");
  return {
    kind: "query-audit",
    created_at: stringField(audit, "created_at"),
    capability: stringField(audit, "capability"),
    tenant: stringField(audit, "tenant_id"),
    principal: stringField(audit, "principal"),
    object: businessObject && objectId ? `${businessObject}:${objectId}` : undefined,
    proposal: stringField(audit, "proposal_id"),
    evidence: stringField(audit, "evidence_bundle_id"),
    status: "query_audited",
    source: stringField(audit, "source_id"),
    table: stringField(audit, "table_name"),
    query_audit: stringField(audit, "audit_id"),
    query_fingerprint: stringField(audit, "query_fingerprint"),
  };
}


export function activityFromReceipt(receipt: StoredWritebackReceipt): Record<string, unknown> {
  return {
    kind: "receipt",
    created_at: receipt.created_at,
    capability: receipt.capability,
    tenant: receipt.tenant_id,
    principal: receipt.principal,
    object: receipt.business_object && receipt.object_id ? `${receipt.business_object}:${receipt.object_id}` : undefined,
    proposal: receipt.proposal_id,
    receipt: receipt.receipt_id,
    status: receipt.status,
    replay: `replay_${receipt.proposal_id}`,
    source: receipt.source_id,
    table: receipt.source_table,
    source_database_mutated: receipt.source_database_mutated,
  };
}


export function formatActivityItem(item: Record<string, unknown>, index: number, details = false): string {
  const lines = [
    `${index}. ${item.created_at}`,
    `   kind: ${item.kind}`,
    ...(item.capability ? [`   capability: ${item.capability}`] : []),
    ...(item.tenant ? [`   tenant: ${item.tenant}`] : []),
    ...(item.object ? [`   object: ${item.object}`] : []),
    ...(item.proposal ? [`   proposal: ${item.proposal}`] : []),
    ...(item.evidence ? [`   evidence: ${item.evidence}`] : []),
    ...(item.query_audit ? [`   query audit: ${item.query_audit}`] : []),
    ...(details && item.query_fingerprint ? [`   query fingerprint: ${item.query_fingerprint}`] : []),
    ...(item.receipt ? [`   receipt: ${item.receipt}`] : []),
    ...(item.status ? [`   status: ${humanStatus(String(item.status))}`] : []),
    ...(item.replay ? [`   replay: ${item.replay}`] : []),
    "",
  ];
  return lines.join("\n");
}


export function formatActivityNext(items: Record<string, unknown>[], storeSuffix: string): string {
  const first = items[0];
  if (!first) return "";
  const proposal = stringField(first, "proposal");
  const replayId = stringField(first, "replay");
  const evidence = stringField(first, "evidence");
  const lines = ["Next:"];
  if (proposal) {
    lines.push(`${cliCommandName()} lifecycle show proposal:${proposal}${storeSuffix}`);
    lines.push(`${cliCommandName()} proposals show ${proposal}${storeSuffix}`);
    lines.push(`${cliCommandName()} replay show --proposal ${proposal}${storeSuffix}`);
  } else if (replayId) {
    lines.push(`${cliCommandName()} lifecycle show replay:${replayId}${storeSuffix}`);
    lines.push(`${cliCommandName()} replay show --replay ${replayId}${storeSuffix}`);
  } else if (evidence) {
    lines.push(`${cliCommandName()} lifecycle show evidence:${evidence}${storeSuffix}`);
    lines.push(`${cliCommandName()} evidence show ${evidence}${storeSuffix}`);
  } else {
    lines.push(`${cliCommandName()} activity search --details${storeSuffix}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}


export function formatEventLine(event: ProposalEvent, details = false): string {
  const lines = [
    `${event.created_at}  ${event.kind}`,
    `  proposal: ${event.proposal_id}`,
    `  actor: ${event.actor}`,
  ];
  if (details && Object.keys(event.payload).length > 0) {
    lines.push(`  payload: ${JSON.stringify(event.payload)}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}


export function localEventWebhookPayload(event: ProposalEvent, storePath: string): Record<string, unknown> {
  return {
    schema_version: "synapsor.local-event-webhook.v1",
    delivered_at: new Date().toISOString(),
    source: {
      kind: "local_store",
      store_path: storePath,
    },
    event,
  };
}


export async function postLocalEventWebhook(
  endpoint: URL,
  payload: Record<string, unknown>,
  options: { token?: string; timeoutMs: number },
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json",
      "user-agent": "synapsor-runner-events-webhook",
    };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`webhook returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}


export function redactWebhookUrl(endpoint: URL): string {
  const copy = new URL(endpoint.toString());
  copy.username = "";
  copy.password = "";
  copy.search = "";
  return copy.toString();
}


export function formatStoreStats(stats: StoreStats): string {
  return [
    `Local store: ${stats.path}`,
    `Approx size: ${stats.approx_bytes} bytes`,
    `Proposals: ${stats.proposals}`,
    `Evidence bundles: ${stats.evidence_bundles}`,
    `Evidence items: ${stats.evidence_items}`,
    `Query audit records: ${stats.query_audit}`,
    `Writeback receipts: ${stats.writeback_receipts}`,
    `Writeback jobs: ${stats.writeback_jobs}`,
    `Idempotency receipts: ${stats.idempotency_receipts}`,
    `Replay records: ${stats.replay_records}`,
    `Approvals: ${stats.approvals}`,
    `Proposal events: ${stats.proposal_events}`,
    `Shadow human actions: ${stats.shadow_human_actions}`,
    `Worker queue items: ${stats.worker_queue}`,
  ].join("\n") + "\n";
}


export function formatStorePrune(result: StorePruneResult): string {
  const lines = [
    `Local store prune ${result.dry_run ? "dry run" : "complete"}`,
    `Cutoff: ${result.cutoff}`,
    "",
    "Rows:",
    ...Object.entries(result.deleted).map(([table, count]) => `  ${table}: ${count}`),
  ];
  if (result.dry_run) {
    lines.push("", "No rows were deleted. Rerun with --yes to apply this prune.");
  }
  return `${lines.join("\n")}\n`;
}


export function formatStoreReset(result: { store: string; removed: string[]; source_database_changed: boolean }): string {
  const lines = [
    "Local store reset complete",
    `Store: ${result.store}`,
    `Source database changed: ${result.source_database_changed ? "yes" : "no"}`,
    "",
    "Removed:",
    ...(result.removed.length ? result.removed.map((entry) => `  - ${entry}`) : ["  - no local store files were present"]),
  ];
  return `${lines.join("\n")}\n`;
}


export function cutoffFromOlderThan(value: string): string {
  const match = value.match(/^(\d+)([smhd])$/i);
  if (!match) throw new Error("--older-than must use a duration such as 30d, 12h, 90m, or 0d");
  const amount = Number(match[1]);
  const unit = (match[2] ?? "d").toLowerCase();
  const multiplier = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return new Date(Date.now() - amount * multiplier).toISOString();
}


export function formatMcpAuditMarkdown(report: McpAuditReport): string {
  const lines = [
    "# Synapsor MCP Database Risk Review",
    "",
    `- Target: \`${escapeMcpAuditMarkdown(report.target)}\``,
    `- Generated at: \`${escapeMcpAuditMarkdown(report.generated_at)}\``,
    `- Tools inspected: ${report.summary.tools_inspected}`,
    `- Findings: HIGH ${report.summary.high} | MEDIUM ${report.summary.medium} | LOW ${report.summary.low}`,
    `- Total findings: ${report.summary.total_findings}`,
    "",
    `> ${report.disclaimer}`,
    "",
    "## Model-authority map",
    "",
    "| Authority | Evidence status | Observed tools |",
    "| --- | --- | --- |",
    ...report.authority_map.items.map((item) =>
      `| ${escapeMcpAuditMarkdown(item.label)} | \`${item.status}\` | ${item.tools.length > 0 ? item.tools.map((tool) => `\`${escapeMcpAuditMarkdown(tool)}\``).join(", ") : "None"} |`),
    "",
    escapeMcpAuditMarkdown(report.authority_map.visibility_limit),
    "",
  ];
  if (report.bypass_check) {
    lines.push("## Configured-server bypass check", "");
    lines.push(`Mode: \`${report.bypass_check.mode}\``);
    lines.push("");
    lines.push("| Server | Transport | Status | Observed tools |", "| --- | --- | --- | --- |");
    for (const server of report.bypass_check.servers) {
      lines.push(`| \`${escapeMcpAuditMarkdown(server.server)}\` | \`${server.transport}\` | \`${server.status}\` | ${server.tools_observed.length > 0 ? server.tools_observed.map((tool) => `\`${escapeMcpAuditMarkdown(tool)}\``).join(", ") : "None"} |`);
    }
    lines.push("", escapeMcpAuditMarkdown(report.bypass_check.warning), "");
  }
  if (report.findings.length === 0) {
    lines.push("No obvious database-commit risks were detected in the static manifest.", "");
    lines.push("This does not prove the MCP server or its tools are secure.", "");
  } else {
    lines.push("## Findings", "");
    for (const finding of report.findings) {
      lines.push(`### ${finding.severity}: ${finding.code}${finding.tool ? ` (\`${escapeMcpAuditMarkdown(finding.tool)}\`)` : ""}`);
      lines.push("");
      lines.push(finding.message);
      lines.push("");
      if (finding.evidence.length > 0) {
        lines.push("Evidence:");
        for (const evidence of finding.evidence) lines.push(`- ${escapeMcpAuditMarkdown(evidence)}`);
        lines.push("");
      }
      lines.push(`Recommendation: ${finding.recommendation}`);
      lines.push("");
      lines.push(`[Remediation guide](${finding.remediation_url})`);
      lines.push("");
    }
  }
  lines.push("## Safer Shape", "");
  lines.push("- expose semantic inspect/propose tools instead of raw SQL;");
  lines.push("- bind tenant/principal from trusted context;");
  lines.push("- keep approval outside MCP;");
  lines.push("- apply approved changes through guarded writeback;");
  lines.push("- keep replay/evidence handles for later review.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}


function escapeMcpAuditMarkdown(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([\\`*_\[\]<>|])/g, "\\$1");
}


export function formatShadowComparison(comparison: {
  proposal_id: string;
  status: string;
  matching_columns: string[];
  differing_columns: string[];
  missing_from_human: string[];
  extra_human_columns: string[];
  notes?: string;
}): string {
  return [
    `shadow comparison: ${comparison.proposal_id}`,
    `status: ${comparison.status}`,
    `matching columns: ${comparison.matching_columns.join(", ") || "none"}`,
    `differing columns: ${comparison.differing_columns.join(", ") || "none"}`,
    `missing from human action: ${comparison.missing_from_human.join(", ") || "none"}`,
    `extra human columns: ${comparison.extra_human_columns.join(", ") || "none"}`,
    ...(comparison.notes ? [`notes: ${comparison.notes}`] : []),
  ].join("\n") + "\n";
}
