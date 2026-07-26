import {
  type StoredProposal,
  type StoredWritebackReceipt
} from "@synapsor-runner/proposal-store";
import { protocolVersions, type ChangeSet } from "@synapsor-runner/protocol";
import { cliCommandName } from "./cli-command-meta.js";
import { optionalArg, runtimeStoreBridgeFlag } from "./cli-options.js";


export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}


export function stableStringArray(values: string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}


export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


export function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


export function stringField(record: unknown, key: string): string | undefined {
  if (!isRecord(record)) return undefined;
  const value = record[key];
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return undefined;
}


export function currentApprovalStatus(proposal: StoredProposal): string {
  if (proposal.state === "rejected") return "rejected";
  if (proposal.state === "canceled") return "canceled";
  if (["approved", "pending_worker", "applied", "conflict", "failed"].includes(proposal.state)) return "approved";
  return proposal.change_set.approval.status;
}


export function currentWritebackStatus(proposal: StoredProposal): string {
  if (proposal.state === "pending_worker") return "pending_worker";
  if (proposal.state === "applied") return "applied";
  if (proposal.state === "conflict") return "conflict";
  if (proposal.state === "failed") return "failed";
  return proposal.change_set.writeback.status;
}


export function showDetails(args: string[]): boolean {
  return args.includes("--details") || args.includes("--debug");
}


export function storeOptionSuffix(args: string[]): string {
  if (args.includes(runtimeStoreBridgeFlag)) {
    const configPath = optionalArg(args, "--config");
    return configPath ? ` --config ${configPath}` : "";
  }
  const storePath = optionalArg(args, "--store");
  return storePath ? ` --store ${storePath}` : "";
}


export function humanStatus(value: string): string {
  const normalized = value.replace(/_/g, " ");
  if (normalized === "pending review") return "pending review";
  if (normalized === "not applied") return "not applied";
  return normalized;
}


export function plural(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}


export function formatReceiptId(receiptId: number): string {
  return `rct_${String(receiptId).padStart(6, "0")}`;
}


export function approvalBoundary(proposal: StoredProposal): string {
  const approval = proposal.change_set.approval as Record<string, unknown>;
  const policy = typeof approval.policy === "string" ? approval.policy : undefined;
  const policyActor = policy ? `policy:${policy}` : undefined;
  if (proposal.state === "pending_review") return "required outside MCP";
  if (proposal.state === "approved" || proposal.state === "pending_worker") return `${policyActor ? `approved by ${policyActor}` : "approved outside MCP"}; waiting for trusted worker`;
  if (proposal.state === "applied") return `${policyActor ? `approved by ${policyActor}` : "approved outside MCP"}; writeback applied`;
  if (proposal.state === "conflict") return `${policyActor ? `approved by ${policyActor}` : "approved outside MCP"}; writeback blocked by conflict guard`;
  if (proposal.state === "failed") return `${policyActor ? `approved by ${policyActor}` : "approved outside MCP"}; writeback failed safely`;
  if (proposal.state === "rejected") return "rejected outside MCP";
  return humanStatus(proposal.state);
}


export function proposalNextCommands(proposal: StoredProposal, proposalRef: string, storeSuffix: string): string[] {
  if (proposal.state === "pending_review") {
    return [
      `${cliCommandName()} proposals approve ${proposalRef} --yes${storeSuffix}`,
      `${cliCommandName()} replay show ${proposalRef === "latest" ? "latest" : `--proposal ${proposal.proposal_id}`}${storeSuffix}`,
    ];
  }
  if (proposal.state === "approved" || proposal.state === "pending_worker") {
    return [
      `${cliCommandName()} replay show --proposal ${proposal.proposal_id}${storeSuffix}`,
    ];
  }
  if (proposal.state === "conflict") {
    return [
      `${cliCommandName()} propose ${proposal.action} --json '<fresh reviewed input>'${storeSuffix}`,
      `${cliCommandName()} replay show --proposal ${proposal.proposal_id}${storeSuffix}`,
    ];
  }
  return [
    `${cliCommandName()} replay show --proposal ${proposal.proposal_id}${storeSuffix}`,
  ];
}


export function boundedSetReviewLines(changeSet: ChangeSet, includeAllIdentities = false): string[] {
  if (changeSet.schema_version !== protocolVersions.changeSetV3) return [];
  const members = includeAllIdentities ? changeSet.frozen_set.members : changeSet.frozen_set.members.slice(0, 10);
  const remaining = changeSet.frozen_set.members.length - members.length;
  return [
    "",
    "Bounded set:",
    `operation: ${changeSet.operation}`,
    `exact rows frozen: ${changeSet.frozen_set.row_count} (reviewed maximum ${changeSet.frozen_set.max_rows})`,
    `aggregate bounds: ${changeSet.frozen_set.aggregate_bounds.map((bound) => `${bound.measure}(${bound.column}) ${bound.actual}/${bound.maximum}`).join("; ")}`,
    `set digest: ${changeSet.frozen_set.set_digest}`,
    "exact identities:",
    ...members.map((member) => `  ${member.primary_key.column}=${formatScalar(member.primary_key.value)}`),
    ...(remaining > 0 ? [`  ... ${remaining} more; use --details to review every identity`] : []),
    "approval: verified human/operator required; policy auto-approval unavailable",
  ];
}


export function receiptOperationLabel(receipt: StoredWritebackReceipt): string {
  if (receipt.receipt.schema_version === protocolVersions.executionReceiptV2) {
    return receipt.receipt.operation.replaceAll("_", " ");
  }
  return "single-row update";
}


export function formatChangeLines(proposal: StoredProposal, memberLimit = 10): string[] {
  const changeSet = proposal.change_set;
  if (changeSet.schema_version === protocolVersions.changeSetV3) {
    const members = changeSet.frozen_set.members.slice(0, memberLimit);
    const lines = members.flatMap((member) => {
      const identity = `${member.primary_key.column}=${formatScalar(member.primary_key.value)}`;
      if (changeSet.operation === "batch_insert") return [`  ${identity}: create ${JSON.stringify(member.after)}`];
      if (changeSet.operation === "set_delete") return [`  ${identity}: delete ${JSON.stringify(member.before)}`];
      return Object.keys(changeSet.patch).map((column) => `  ${identity} ${column}: ${formatScalar(member.before[column])} -> ${formatScalar(member.after[column])}`);
    });
    const remaining = changeSet.frozen_set.members.length - members.length;
    if (remaining > 0) lines.push(`  ... ${remaining} more exact members; use --details to review all`);
    return lines.length > 0 ? lines : ["  (no changed columns)"];
  }
  const columns = Object.keys(changeSet.patch);
  if (columns.length === 0) return ["  (no changed columns)"];
  return columns.map((column) => {
    const before = changeSet.before[column as keyof typeof changeSet.before];
    const proposed = changeSet.after[column as keyof typeof changeSet.after];
    return `  ${column}: ${formatScalar(before)} -> ${formatScalar(proposed)}`;
  });
}


export function formatScalar(value: unknown): string {
  if (value === undefined) return "unset";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
