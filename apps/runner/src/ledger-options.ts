import {
  ProposalStore,
  type EventSearchFilters,
  type EvidenceSearchFilters,
  type LocalProposalState,
  type ProposalSearchFilters,
  type QueryAuditSearchFilters,
  type ReceiptSearchFilters
} from "@synapsor-runner/proposal-store";
import { limitFromArgs, objectFilterFromArgs, optionalArg, positional, runtimeStoreBridgeFlag } from "./cli-options.js";
import { resolveProposalIdFromStore } from "./cli-project.js";


const commonReadOptions = new Set(["--store", "--config", "--json", "--details", "--debug", runtimeStoreBridgeFlag]);

export const showAllowedOptions = new Set([...commonReadOptions]);

export const exportAllowedOptions = new Set([...commonReadOptions, "--output", "--out", "--format", "--evidence", "--audit"]);

export const proposalListAllowedOptions = new Set([
  ...commonReadOptions,
  "--tenant",
  "--principal",
  "--capability",
  "--action",
  "--object",
  "--object-type",
  "--object-id",
  "--status",
  "--state",
  "--source",
  "--table",
  "--from",
  "--since",
  "--to",
  "--limit",
]);

export const lifecycleListAllowedOptions = new Set([...proposalListAllowedOptions]);

export const lifecycleShowAllowedOptions = new Set([
  ...proposalListAllowedOptions,
  "--evidence",
  "--replay",
  "--writeback-job",
  "--intent",
  "--receipt",
  "--audit",
]);

lifecycleShowAllowedOptions.delete("--limit");

export const evidenceListAllowedOptions = new Set([
  ...commonReadOptions,
  "--tenant",
  "--principal",
  "--capability",
  "--proposal",
  "--object",
  "--object-type",
  "--object-id",
  "--source",
  "--table",
  "--query-fingerprint",
  "--from",
  "--since",
  "--to",
  "--status",
  "--limit",
]);

export const queryAuditListAllowedOptions = new Set([
  ...commonReadOptions,
  "--tenant",
  "--principal",
  "--capability",
  "--proposal",
  "--evidence",
  "--source",
  "--table",
  "--object",
  "--object-type",
  "--object-id",
  "--primary-key",
  "--query-fingerprint",
  "--from",
  "--since",
  "--to",
  "--status",
  "--limit",
]);

export const receiptListAllowedOptions = new Set([
  ...commonReadOptions,
  "--proposal",
  "--writeback-job",
  "--idempotency-key",
  "--status",
  "--from",
  "--since",
  "--to",
  "--limit",
]);

export const eventTailAllowedOptions = new Set([
  ...commonReadOptions,
  "--proposal",
  "--kind",
  "--actor",
  "--from",
  "--to",
  "--limit",
  "--follow",
  "--interval-ms",
]);

export const eventWebhookAllowedOptions = new Set([
  ...eventTailAllowedOptions,
  "--url",
  "--url-env",
  "--auth-token-env",
  "--timeout-ms",
  "--since-event-id",
  "--dry-run",
]);

export const replayShowAllowedOptions = new Set([...commonReadOptions, "--proposal", "--replay", "--evidence"]);

export const replayExportAllowedOptions = new Set([...replayShowAllowedOptions, "--output", "--out", "--format"]);

export const replayListAllowedOptions = new Set([
  ...commonReadOptions,
  "--tenant",
  "--principal",
  "--capability",
  "--proposal",
  "--evidence",
  "--receipt",
  "--object",
  "--object-type",
  "--object-id",
  "--status",
  "--state",
  "--from",
  "--to",
  "--limit",
]);

export const activitySearchAllowedOptions = new Set([
  ...commonReadOptions,
  "--tenant",
  "--principal",
  "--capability",
  "--object",
  "--object-type",
  "--object-id",
  "--proposal",
  "--evidence",
  "--replay",
  "--receipt",
  "--source",
  "--table",
  "--query-fingerprint",
  "--status",
  "--state",
  "--from",
  "--to",
  "--limit",
]);

export const storeStatsAllowedOptions = new Set([...commonReadOptions]);

export const storeVacuumAllowedOptions = new Set([...commonReadOptions]);

export const storePruneAllowedOptions = new Set([...commonReadOptions, "--older-than", "--dry-run", "--yes", "--force"]);

export const storeResetAllowedOptions = new Set([...commonReadOptions, "--yes", "--force"]);

export const storeSharedPostgresAllowedOptions = new Set(["--schema", "--url-env", "--store", "--dry-run", "--yes", "--json", "--output", "--input", "--max-entries", "--older-than"]);


export function proposalFiltersFromArgs(args: string[]): ProposalSearchFilters {
  const object = objectFilterFromArgs(args);
  return {
    proposal: optionalArg(args, "--proposal"),
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    action: optionalArg(args, "--action"),
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    status: optionalArg(args, "--status") as LocalProposalState | undefined,
    state: optionalArg(args, "--state") as LocalProposalState | undefined,
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    from: optionalArg(args, "--from") ?? optionalArg(args, "--since"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}


export function lifecycleFiltersFromArgs(args: string[]): ProposalSearchFilters {
  const filters = proposalFiltersFromArgs(args);
  delete filters.proposal;
  delete filters.limit;
  return filters;
}


export function lifecycleHandleFromArgs(args: string[]): string | undefined {
  const typed: Array<[string, string]> = [
    ["proposal", "--proposal"],
    ["evidence", "--evidence"],
    ["replay", "--replay"],
    ["job", "--writeback-job"],
    ["intent", "--intent"],
    ["receipt", "--receipt"],
    ["audit", "--audit"],
  ];
  const explicit = typed
    .map(([kind, option]) => ({ kind, value: optionalArg(args, option) }))
    .filter((item): item is { kind: string; value: string } => Boolean(item.value));
  const positionalHandle = lifecyclePositionalHandle(args);
  if (explicit.length + (positionalHandle ? 1 : 0) > 1) {
    throw new Error("lifecycle show accepts exactly one positional or typed handle");
  }
  if (explicit[0]) return `${explicit[0].kind}:${explicit[0].value}`;
  return positionalHandle;
}


function lifecyclePositionalHandle(args: string[]): string | undefined {
  const flagsWithValues = new Set([
    "--store", "--config", "--tenant", "--principal", "--capability", "--action",
    "--object", "--object-type", "--object-id", "--status", "--state", "--source",
    "--table", "--from", "--to", "--limit", "--proposal", "--evidence", "--replay",
    "--writeback-job", "--intent", "--receipt", "--audit",
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    if (arg.startsWith("--")) {
      if (flagsWithValues.has(arg) && !arg.includes("=")) index += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}


export function evidenceFiltersFromArgs(args: string[]): EvidenceSearchFilters {
  const object = objectFilterFromArgs(args);
  return {
    evidence: optionalArg(args, "--evidence"),
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    proposal: optionalArg(args, "--proposal"),
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    queryFingerprint: optionalArg(args, "--query-fingerprint"),
    from: optionalArg(args, "--from") ?? optionalArg(args, "--since"),
    to: optionalArg(args, "--to"),
    status: optionalArg(args, "--status"),
    limit: limitFromArgs(args),
  };
}


export function queryAuditFiltersFromArgs(args: string[]): QueryAuditSearchFilters {
  const object = objectFilterFromArgs(args);
  return {
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    proposal: optionalArg(args, "--proposal"),
    evidence: optionalArg(args, "--evidence"),
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    primaryKey: optionalArg(args, "--primary-key"),
    queryFingerprint: optionalArg(args, "--query-fingerprint"),
    from: optionalArg(args, "--from") ?? optionalArg(args, "--since"),
    to: optionalArg(args, "--to"),
    status: optionalArg(args, "--status"),
    limit: limitFromArgs(args),
  };
}


export function receiptFiltersFromArgs(args: string[]): ReceiptSearchFilters {
  return {
    receipt: optionalArg(args, "--receipt"),
    proposal: optionalArg(args, "--proposal"),
    writebackJob: optionalArg(args, "--writeback-job"),
    idempotencyKey: optionalArg(args, "--idempotency-key"),
    status: optionalArg(args, "--status"),
    from: optionalArg(args, "--from") ?? optionalArg(args, "--since"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}


export function proposalFiltersFromReplayArgs(args: string[], store: ProposalStore): ProposalSearchFilters {
  return proposalFiltersFromActivityArgs(args, store);
}


export function proposalFiltersFromActivityArgs(args: string[], store?: ProposalStore): ProposalSearchFilters {
  const object = objectFilterFromArgs(args);
  const linkedProposal = linkedProposalFilter(args, store);
  return {
    proposal: optionalArg(args, "--proposal") ?? linkedProposal,
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    action: optionalArg(args, "--capability"),
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    status: optionalArg(args, "--status") as LocalProposalState | undefined,
    state: optionalArg(args, "--state") as LocalProposalState | undefined,
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}


export function evidenceFiltersFromActivityArgs(args: string[], store?: ProposalStore): EvidenceSearchFilters {
  const object = objectFilterFromArgs(args);
  const linkedProposal = linkedProposalFilter(args, store, { includeEvidence: false });
  return {
    evidence: optionalArg(args, "--evidence"),
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    proposal: optionalArg(args, "--proposal") ?? linkedProposal,
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    queryFingerprint: optionalArg(args, "--query-fingerprint"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}


export function queryAuditFiltersFromActivityArgs(args: string[], store?: ProposalStore): QueryAuditSearchFilters {
  const object = objectFilterFromArgs(args);
  const linkedProposal = linkedProposalFilter(args, store, { includeEvidence: false });
  return {
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    proposal: optionalArg(args, "--proposal") ?? linkedProposal,
    evidence: optionalArg(args, "--evidence"),
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    queryFingerprint: optionalArg(args, "--query-fingerprint"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}


export function receiptFiltersFromActivityArgs(args: string[], store?: ProposalStore): ReceiptSearchFilters {
  const object = objectFilterFromArgs(args);
  const linkedProposal = linkedProposalFilter(args, store, { includeReceipt: false });
  return {
    receipt: optionalArg(args, "--receipt"),
    proposal: optionalArg(args, "--proposal") ?? linkedProposal,
    status: optionalArg(args, "--status") ?? optionalArg(args, "--state"),
    tenant: optionalArg(args, "--tenant"),
    principal: optionalArg(args, "--principal"),
    capability: optionalArg(args, "--capability"),
    objectType: optionalArg(args, "--object-type") ?? object.type,
    objectId: optionalArg(args, "--object-id") ?? object.id,
    source: optionalArg(args, "--source"),
    table: optionalArg(args, "--table"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}


export function eventFiltersFromArgs(args: string[]): EventSearchFilters {
  return {
    proposal: optionalArg(args, "--proposal"),
    kind: optionalArg(args, "--kind"),
    actor: optionalArg(args, "--actor"),
    from: optionalArg(args, "--from"),
    to: optionalArg(args, "--to"),
    limit: limitFromArgs(args),
  };
}


function linkedProposalFilter(
  args: string[],
  store?: ProposalStore,
  options: { includeEvidence?: boolean; includeReceipt?: boolean } = {},
): string | undefined {
  const noLinkedProposal = "__synapsor_no_linked_proposal__";
  const replay = optionalArg(args, "--replay");
  if (replay) return proposalIdFromReplayId(replay);
  if (!store) return undefined;
  if (options.includeEvidence !== false) {
    const evidence = optionalArg(args, "--evidence");
    if (evidence) return store.proposalIdForEvidence(evidence) ?? noLinkedProposal;
  }
  if (options.includeReceipt !== false) {
    const receiptValue = optionalArg(args, "--receipt");
    if (receiptValue) {
      const receiptId = Number(receiptValue);
      if (!Number.isInteger(receiptId) || receiptId <= 0) throw new Error("--receipt must be a positive receipt id");
      return store.getReceipt(receiptId)?.proposal_id ?? noLinkedProposal;
    }
  }
  return undefined;
}


export function resolveReplayProposalId(args: string[], store: ProposalStore): string {
  const explicitProposal = optionalArg(args, "--proposal");
  if (explicitProposal) return resolveProposalIdFromStore(explicitProposal, store);
  const explicitReplay = optionalArg(args, "--replay");
  if (explicitReplay) return proposalIdFromReplayId(explicitReplay);
  const explicitEvidence = optionalArg(args, "--evidence");
  if (explicitEvidence) {
    const proposalId = store.proposalIdForEvidence(explicitEvidence);
    if (!proposalId) throw new Error(`evidence bundle ${explicitEvidence} is not linked to a replayable proposal`);
    return proposalId;
  }
  const value = positional(args, 0);
  if (!value) throw new Error("replay show requires <proposal_id>, --proposal <proposal_id>, --replay <replay_id>, or --evidence <evidence_bundle_id>");
  if (value === "latest") return resolveProposalIdFromStore(value, store);
  if (value.startsWith("replay_")) return proposalIdFromReplayId(value);
  if (value.startsWith("ev_")) throw new Error(`Use --evidence ${value} to replay from an evidence bundle.`);
  return resolveProposalIdFromStore(value, store);
}


export function proposalIdFromReplayId(replayId: string): string {
  if (!replayId.startsWith("replay_")) throw new Error(`invalid replay id: ${replayId}`);
  const proposalId = replayId.slice("replay_".length);
  if (!proposalId) throw new Error(`invalid replay id: ${replayId}`);
  return proposalId;
}
