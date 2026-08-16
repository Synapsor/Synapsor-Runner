import { evaluateProposalFreshness, resolveSupervisedWorkerEligibility, validateFreshnessAuthorityAgainstCurrentConfig, type ProposalFreshnessEvaluation, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import {
  ProposalStore,
  type EvidenceSearchFilters,
  type QueryAuditSearchFilters,
  type StoredEvidenceBundle,
  type StoredProposal,
  type WorkerQueueItem
} from "@synapsor-runner/proposal-store";
import { parseFreshnessAuthority } from "@synapsor-runner/protocol";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { activityFromEvidence, activityFromProposal, activityFromQueryAudit, activityFromReceipt, formatActivityItem, formatActivityNext, formatEventLine, localEventWebhookPayload, postLocalEventWebhook, redactWebhookUrl } from "./activity-formatting.js";
import { cliCommandName } from "./cli-command-meta.js";
import { isRecord, safeErrorMessage, showDetails, storeOptionSuffix, stringField } from "./cli-format.js";
import { operationalLog } from "./cli-logging.js";
import { assertKnownOptions, envValue, exportFormat, limitFromArgs, optionalArg, optionalPositiveIntegerArg, outputArg, positional, positiveIntOption, runtimeStoreBridgeFlag, waitFor } from "./cli-options.js";
import { confirmDangerousAction, localStorePath, openLocalStore, operatorIdentityForDecision, optionalRuntimeConfig, requireLocalProposal, resolveProposalIdFromStore, runnerConfigPath } from "./cli-project.js";
import { activitySearchAllowedOptions, eventFiltersFromArgs, eventTailAllowedOptions, eventWebhookAllowedOptions, evidenceFiltersFromActivityArgs, evidenceFiltersFromArgs, evidenceListAllowedOptions, exportAllowedOptions, proposalFiltersFromActivityArgs, proposalFiltersFromArgs, proposalFiltersFromReplayArgs, proposalListAllowedOptions, queryAuditFiltersFromActivityArgs, queryAuditFiltersFromArgs, queryAuditListAllowedOptions, receiptFiltersFromActivityArgs, receiptFiltersFromArgs, receiptListAllowedOptions, replayExportAllowedOptions, replayListAllowedOptions, replayShowAllowedOptions, resolveReplayProposalId, showAllowedOptions } from "./ledger-options.js";
import { resolveExploreLedgerFilters } from "./ledger-search.js";
import { TrustedOperatorInvocation } from "./operator-authority.js";
import { formatEvidenceDetail, formatEvidenceFirstLook, formatEvidenceMarkdown, formatEvidenceSummary, formatProposalDebug, formatProposalDetail, formatProposalEventDetail, formatProposalFirstLook, formatProposalSummary, formatQueryAuditDetail, formatQueryAuditFirstLook, formatQueryAuditSummary, formatReceiptDetail, formatReceiptFirstLook, formatReceiptSummary, formatReplayDebug, formatReplayDetail, formatReplayFirstLook, formatReplayMarkdown, formatReplaySummary } from "./proposal-formatting.js";
import { sharedPostgresLedgerMirrorOptions } from "./shared-ledger-domain.js";
import { argsWithRuntimeStoreBridge, assertLocalGovernanceMutationAllowed, assertNoRuntimeStoreForLocalMutation, maybeSharedPostgresRuntimeStoreRead, runtimeStoreBridgeRequired, sharedPostgresLedgerMirrorRequested, withoutSharedPostgresLedgerMirror, withSharedPostgresLedgerMirror, withSharedPostgresRuntimeStoreBridge } from "./store-shared.js";
import { findProposalCapability } from "./writeback-execution.js";
import { terminalSyntaxColorEnabled } from "./terminal-syntax.js";
import { readTerminalTextWithEscape } from "./terminal-prompt.js";

type LedgerReadSource =
  | { kind: "local_sqlite"; path: string }
  | { kind: "shared_postgres"; schema: string; url_env: string };


async function ledgerReadSource(args: string[]): Promise<LedgerReadSource> {
  if (args.includes(runtimeStoreBridgeFlag)) {
    const config = await optionalRuntimeConfig(runnerConfigPath(args));
    const shared = sharedPostgresLedgerMirrorOptions(args, config);
    return { kind: "shared_postgres", schema: shared.schema, url_env: shared.urlEnv };
  }
  const storePath = localStorePath(args);
  return { kind: "local_sqlite", path: storePath === ":memory:" ? storePath : path.resolve(storePath) };
}


function ledgerReadSourceLine(source: LedgerReadSource): string {
  return source.kind === "shared_postgres"
    ? `Ledger: shared PostgreSQL schema ${source.schema} (URL from ${source.url_env}; read-only)\n`
    : `Ledger: local SQLite ${source.path}\n`;
}


function emptyLedgerMessage(label: string, source: LedgerReadSource): string {
  const selection = source.kind === "shared_postgres"
    ? "Use a development config without storage.shared_postgres.mode=runtime_store plus --store <path> to inspect local SQLite."
    : "Use --config <production-config> to inspect its configured shared PostgreSQL runtime store.";
  return `No ${label} found in the consulted ledger.\n${selection}\n`;
}


type EvidenceListResult = {
  ledgerSource: LedgerReadSource;
  notes: string[];
  rows: StoredEvidenceBundle[];
};

type QueryAuditListResult = {
  ledgerSource: LedgerReadSource;
  notes: string[];
  rows: Record<string, unknown>[];
};


function principalEmptyResultNotes(
  args: string[],
  label: string,
  rows: Array<{ principal?: unknown }>,
  otherwiseMatching: Array<{ principal?: unknown }>,
): string[] {
  if (!optionalArg(args, "--principal") || rows.length > 0) return [];
  if (otherwiseMatching.length === 0) {
    return [`No ${label} records matched the non-principal filters, so there was no candidate activity to attribute to the requested principal.`];
  }
  if (otherwiseMatching.some((row) => typeof row.principal !== "string" || row.principal.length === 0)) {
    return [
      `No keyed principal record matched. At least one otherwise-matching legacy ${label} record only states whether principal scope was bound and cannot be attributed retroactively; this empty result does not rule out older activity by that principal.`,
    ];
  }
  return [`The principal filter was applied successfully. Otherwise-matching ${label} records exist, but none match that principal fingerprint.`];
}


function evidenceFiltersWithoutPrincipal(filters: EvidenceSearchFilters): EvidenceSearchFilters {
  const { principal: _principal, principals: _principals, ...rest } = filters;
  return { ...rest, limit: 200 };
}


function queryAuditFiltersWithoutPrincipal(filters: QueryAuditSearchFilters): QueryAuditSearchFilters {
  const { principal: _principal, principals: _principals, ...rest } = filters;
  return { ...rest, limit: 200 };
}


async function readEvidenceList(args: string[]): Promise<EvidenceListResult> {
  const resolved = await resolveExploreLedgerFilters(args, evidenceFiltersFromArgs(args));
  if (resolved.filters.outcome === "refused" || resolved.filters.outcome === "failed") {
    throw new Error(
      `Evidence bundles exist only for released results. Use ${cliCommandName()} query-audit list --outcome ${resolved.filters.outcome} to inspect ${resolved.filters.outcome} Explore attempts.`,
    );
  }
  const bridged = await maybeSharedPostgresRuntimeStoreRead(
    args,
    "evidence list",
    (bridgeStorePath) => readEvidenceList(argsWithRuntimeStoreBridge(args, bridgeStorePath)),
  );
  if (bridged !== undefined) return bridged;
  const ledgerSource = await ledgerReadSource(args);
  const store = await openLocalStore(args);
  try {
    const rows = store.listEvidenceBundles(resolved.filters);
    const otherwiseMatching = optionalArg(args, "--principal") && rows.length === 0
      ? store.listEvidenceBundles(evidenceFiltersWithoutPrincipal(resolved.filters))
      : [];
    return {
      ledgerSource,
      notes: [
        ...resolved.notes,
        ...principalEmptyResultNotes(args, "evidence", rows, otherwiseMatching),
      ],
      rows,
    };
  } finally {
    store.close();
  }
}


async function readQueryAuditList(args: string[]): Promise<QueryAuditListResult> {
  const resolved = await resolveExploreLedgerFilters(args, queryAuditFiltersFromArgs(args));
  const bridged = await maybeSharedPostgresRuntimeStoreRead(
    args,
    "query-audit list",
    (bridgeStorePath) => readQueryAuditList(argsWithRuntimeStoreBridge(args, bridgeStorePath)),
  );
  if (bridged !== undefined) return bridged;
  const ledgerSource = await ledgerReadSource(args);
  const store = await openLocalStore(args);
  try {
    const rows = store.listQueryAudit(resolved.filters);
    const otherwiseMatching = optionalArg(args, "--principal") && rows.length === 0
      ? store.listQueryAudit(queryAuditFiltersWithoutPrincipal(resolved.filters))
      : [];
    return {
      ledgerSource,
      notes: [
        ...resolved.notes,
        ...principalEmptyResultNotes(args, "query-audit", rows, otherwiseMatching),
      ],
      rows,
    };
  } finally {
    store.close();
  }
}


function writeEvidenceList(result: EvidenceListResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ledger_source: result.ledgerSource, notices: result.notes, evidence: result.rows }, null, 2)}\n`);
    return;
  }
  process.stdout.write(ledgerReadSourceLine(result.ledgerSource));
  for (const note of result.notes) process.stdout.write(`Note: ${note}\n`);
  if (result.rows.length === 0) process.stdout.write(emptyLedgerMessage("evidence bundles", result.ledgerSource));
  else for (const bundle of result.rows) process.stdout.write(formatEvidenceSummary(bundle));
}


function writeQueryAuditList(
  result: QueryAuditListResult,
  json: boolean,
  details: boolean,
  storeSuffix: string,
): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ledger_source: result.ledgerSource, notices: result.notes, query_audit: result.rows }, null, 2)}\n`);
    return;
  }
  process.stdout.write(ledgerReadSourceLine(result.ledgerSource));
  for (const note of result.notes) process.stdout.write(`Note: ${note}\n`);
  if (result.rows.length === 0) process.stdout.write(emptyLedgerMessage("query audit records", result.ledgerSource));
  else for (const row of result.rows) process.stdout.write(formatQueryAuditSummary(row, details, storeSuffix));
}


function assertLedgerListModes(args: string[], command: string): void {
  if (args.includes("--interactive") && args.includes("--follow")) {
    throw new Error(`${command} accepts either --interactive or --follow, not both`);
  }
  if (args.includes("--interactive") && args.includes("--json")) {
    throw new Error(`${command} --interactive uses the terminal view and cannot be combined with --json`);
  }
}


async function followEvidence(args: string[]): Promise<number> {
  const intervalMs = positiveIntOption(args, "--interval-ms", 2_000, 250, 60_000);
  const readArgs = args.includes("--limit") ? args : [...args, "--limit", "200"];
  const seen = new Set<string>();
  let first = true;
  while (true) {
    const result = await readEvidenceList(readArgs);
    if (first && !args.includes("--json")) {
      process.stdout.write(ledgerReadSourceLine(result.ledgerSource));
      for (const note of result.notes) process.stdout.write(`Note: ${note}\n`);
      process.stdout.write(`Following released Explore evidence every ${intervalMs} ms. Press Ctrl+C to stop.\n`);
    }
    const fresh = result.rows.filter((row) => !seen.has(row.evidence_bundle_id)).reverse();
    for (const row of fresh) {
      seen.add(row.evidence_bundle_id);
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify({ ledger_source: result.ledgerSource, evidence: row })}\n`);
      } else process.stdout.write(formatEvidenceSummary(row));
    }
    first = false;
    await waitFor(intervalMs);
  }
}


async function followQueryAudit(args: string[]): Promise<number> {
  const intervalMs = positiveIntOption(args, "--interval-ms", 2_000, 250, 60_000);
  const readArgs = args.includes("--limit") ? args : [...args, "--limit", "200"];
  const seen = new Set<number>();
  let first = true;
  while (true) {
    const result = await readQueryAuditList(readArgs);
    if (first && !args.includes("--json")) {
      process.stdout.write(ledgerReadSourceLine(result.ledgerSource));
      for (const note of result.notes) process.stdout.write(`Note: ${note}\n`);
      process.stdout.write(`Following Explore query audit every ${intervalMs} ms. Press Ctrl+C to stop.\n`);
    }
    const fresh = result.rows.filter((row) => {
      const auditId = Number(row.audit_id);
      return Number.isSafeInteger(auditId) && !seen.has(auditId);
    }).reverse();
    for (const row of fresh) {
      const auditId = Number(row.audit_id);
      seen.add(auditId);
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify({ ledger_source: result.ledgerSource, query_audit: row })}\n`);
      } else process.stdout.write(formatQueryAuditSummary(row, showDetails(args), storeOptionSuffix(args)));
    }
    first = false;
    await waitFor(intervalMs);
  }
}


async function browseEvidence(result: EvidenceListResult): Promise<number> {
  assertInteractiveTerminal("evidence browse");
  process.stdout.write(ledgerReadSourceLine(result.ledgerSource));
  for (const note of result.notes) process.stdout.write(`Note: ${note}\n`);
  if (result.rows.length === 0) {
    process.stdout.write(emptyLedgerMessage("evidence bundles", result.ledgerSource));
    return 0;
  }
  process.stdout.write("\nEVIDENCE BROWSER\n");
  result.rows.forEach((row, index) => {
    const outcome = stringField(row.payload, "outcome") ?? "recorded";
    if (index > 0) process.stdout.write(`  ${"-".repeat(72)}\n`);
    process.stdout.write(`  ${index + 1}. ${row.created_at}  ${outcome}  ${row.source_table ?? "unknown resource"}\n      ${row.evidence_bundle_id}\n`);
  });
  while (true) {
    const answer = await readTerminalTextWithEscape(
      "Evidence number or ID [Enter/Esc exits]: ",
      process.stdin,
      process.stdout,
    );
    if (!answer) return 0;
    const selected = /^\d+$/.test(answer)
      ? result.rows[Number(answer) - 1]
      : result.rows.find((row) => row.evidence_bundle_id === answer);
    if (!selected) {
      process.stdout.write(`No evidence in this filtered page matches ${answer}.\n`);
      continue;
    }
    process.stdout.write(`\n${formatEvidenceDetail(selected, terminalSyntaxColorEnabled())}\n`);
  }
}


async function browseQueryAudit(result: QueryAuditListResult): Promise<number> {
  assertInteractiveTerminal("query-audit browse");
  process.stdout.write(ledgerReadSourceLine(result.ledgerSource));
  for (const note of result.notes) process.stdout.write(`Note: ${note}\n`);
  if (result.rows.length === 0) {
    process.stdout.write(emptyLedgerMessage("query audit records", result.ledgerSource));
    return 0;
  }
  process.stdout.write("\nQUERY AUDIT BROWSER\n");
  result.rows.forEach((row, index) => {
    const payload = isRecord(row.payload) ? row.payload : {};
    if (index > 0) process.stdout.write(`  ${"-".repeat(72)}\n`);
    process.stdout.write(
      `  #${index + 1}  ${row.created_at}  ${stringField(payload, "status") ?? "recorded"}  ${row.table_name}\n      audit ${row.audit_id}${row.evidence_bundle_id ? `  evidence ${row.evidence_bundle_id}` : ""}\n`,
    );
  });
  while (true) {
    const answer = await readTerminalTextWithEscape(
      "Audit ID or #page-number [Enter/Esc exits]: ",
      process.stdin,
      process.stdout,
    );
    if (!answer) return 0;
    const selected = /^#\d+$/.test(answer)
      ? result.rows[Number(answer.slice(1)) - 1]
      : /^\d+$/.test(answer)
        ? result.rows.find((row) => Number(row.audit_id) === Number(answer))
        : undefined;
    if (!selected) {
      process.stdout.write(`No audit in this filtered page matches ${answer}.\n`);
      continue;
    }
    process.stdout.write(`\n${formatQueryAuditDetail(selected, terminalSyntaxColorEnabled())}\n`);
  }
}


function assertInteractiveTerminal(command: string): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error(`${command} requires a real terminal. Use list --json for scripts and automation.`);
  }
}


export async function proposalsList(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "proposals list", (bridgeStorePath) => proposalsList(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, proposalListAllowedOptions, "proposals list");
  const store = await openLocalStore(args);
  try {
    const filters = proposalFiltersFromArgs(args);
    const rows = store.listProposals(filters);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ proposals: rows }, null, 2)}\n`);
      return 0;
    }
    if (rows.length === 0) {
      process.stdout.write("No proposals found.\n");
      return 0;
    }
    for (const proposal of rows) {
      process.stdout.write(formatProposalSummary(proposal));
    }
    return 0;
  } finally {
    store.close();
  }
}


export async function proposalsShow(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "proposals show", (bridgeStorePath) => proposalsShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, showAllowedOptions, "proposals show");
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals show requires <proposal_id>");
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const proposal = store.getProposal(resolvedProposalId);
    if (!proposal) throw new Error(`proposal not found: ${resolvedProposalId}`);
    const evidence = store.getEvidenceBundle(proposal.change_set.evidence.bundle_id);
    const approvalProgress = store.approvalProgress(resolvedProposalId);
    const latestFreshness = store.latestFreshnessProof(resolvedProposalId);
    const freshness = {
      required: "freshness" in proposal.change_set && proposal.change_set.freshness !== undefined,
      status: latestFreshness?.result ?? ("freshness" in proposal.change_set && proposal.change_set.freshness !== undefined ? "not_checked" : "not_required"),
      proof: latestFreshness ?? null,
    };
    const payload = { proposal, approval_progress: approvalProgress, freshness, events: store.events(resolvedProposalId), receipts: store.receipts(resolvedProposalId), evidence };
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else if (showDetails(args)) {
      process.stdout.write(formatProposalDetail(proposal, evidence?.items.length));
      process.stdout.write(`Approval progress: ${approvalProgress.approved}/${approvalProgress.required}${approvalProgress.rejected ? " (rejected)" : ""}\n`);
      process.stdout.write(`Freshness: ${freshness.status}${latestFreshness ? ` checked=${latestFreshness.checked_at} proof=${latestFreshness.proof_digest}` : ""}\n`);
      process.stdout.write(formatProposalEventDetail(payload.events));
      if (args.includes("--debug")) process.stdout.write(formatProposalDebug(proposal, optionalArg(args, "--store")));
    } else {
      process.stdout.write(formatProposalFirstLook(proposal, evidence?.items.length, proposalId, storeOptionSuffix(args)));
    }
    return 0;
  } finally {
    store.close();
  }
}


const freshnessExitCodes = {
  fresh: 0,
  not_required: 0,
  stale: 3,
  unavailable: 4,
  invalid: 5,
  unsupported: 6,
} as const;


export async function proposalsCheckFreshness(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals check-freshness requires <proposal_id|latest>");
  const storePath = localStorePath(args);
  const configPath = runnerConfigPath(args);
  const config = await optionalRuntimeConfig(configPath);
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(
      args,
      config,
      `proposals check-freshness ${proposalId}`,
      (bridgeStorePath) => proposalsCheckFreshness(argsWithRuntimeStoreBridge(args, bridgeStorePath)),
    );
  }
  assertNoRuntimeStoreForLocalMutation(config, "proposals check-freshness", args);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(
      args,
      storePath,
      `proposals check-freshness ${proposalId}`,
      () => proposalsCheckFreshness(withoutSharedPostgresLedgerMirror(args)),
      config,
    );
  }
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const proposal = requireLocalProposal(store, resolvedProposalId);
    const freshness = await evaluateAndRecordProposalFreshness({ proposal, config, configPath, store });
    operationalLog(freshness.status === "fresh" || freshness.status === "not_required" ? "info" : "warn", "proposal_freshness_check", {
      proposal_id: proposal.proposal_id,
      capability: proposal.action,
      tenant: proposal.tenant_id,
      status: freshness.status,
      error_code: freshness.safe_code,
      target_count: freshness.target_count,
      supporting_count: freshness.supporting_count,
      ...(freshness.required ? { freshness_proof_digest: freshness.proof.proof_digest } : {}),
      source_database_changed: false,
    });
    process.stdout.write(args.includes("--json")
      ? `${JSON.stringify(freshnessJson(freshness), null, 2)}\n`
      : formatFreshnessResult(freshness, args.includes("--details")));
    return freshnessExitCodes[freshness.status];
  } finally {
    store.close();
  }
}


async function evaluateAndRecordProposalFreshness(input: {
  proposal: StoredProposal;
  config: RuntimeConfig | undefined;
  configPath: string;
  store: ProposalStore;
  unavailableAttempts?: number;
}): Promise<ProposalFreshnessEvaluation> {
  const required = "freshness" in input.proposal.change_set && input.proposal.change_set.freshness !== undefined;
  if (!required) {
    return {
      required: false,
      status: "not_required",
      safe_code: "FRESHNESS_NOT_REQUIRED",
      target_count: 0,
      supporting_count: 0,
    };
  }
  if (!input.config) {
    throw new Error(`freshness-required proposal needs an existing --config file; not found: ${path.resolve(input.configPath)}`);
  }
  const attempts = Math.max(1, Math.min(input.unavailableAttempts ?? 1, 2));
  let result: ProposalFreshnessEvaluation | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await evaluateProposalFreshness({
      config: input.config,
      proposal: input.proposal,
      env: process.env,
    });
    if (result.required) input.store.recordFreshnessProof(result.proof);
    if (result.status !== "unavailable" || attempt === attempts) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return result!;
}


export function reusableRecordedFreshness(input: {
  proposal: StoredProposal;
  config: RuntimeConfig | undefined;
  configPath: string;
  store: ProposalStore;
  proofDigest: string | undefined;
}): ProposalFreshnessEvaluation | undefined {
  if (!input.proofDigest) return undefined;
  if (!("freshness" in input.proposal.change_set) || input.proposal.change_set.freshness === undefined) return undefined;
  if (!input.config) {
    throw new Error(`freshness-required proposal needs an existing --config file; not found: ${path.resolve(input.configPath)}`);
  }
  const authority = parseFreshnessAuthority(input.proposal.change_set.freshness);
  const capability = findProposalCapability(input.config, input.proposal);
  const authorityError = validateFreshnessAuthorityAgainstCurrentConfig(input.config, capability, authority);
  if (authorityError) {
    throw new Error(
      `FRESHNESS_POLICY_CHANGED_CREATE_NEW_PROPOSAL: ${authorityError}; create and review a new proposal`,
    );
  }
  const proof = input.store.latestFreshnessProof(input.proposal.proposal_id);
  if (!proof || proof.proof_digest !== input.proofDigest) return undefined;
  if (proof.proposal_hash !== input.proposal.proposal_hash
    || proof.proposal_version !== input.proposal.proposal_version
    || proof.dependency_set_digest !== authority.dependency_set_digest
    || proof.result !== "fresh"
    || Date.parse(proof.valid_until) < Date.now()) return undefined;
  if (input.store.approvals(input.proposal.proposal_id).some((approval) => approval.freshness_proof_digest === proof.proof_digest)) {
    return undefined;
  }
  return {
    required: true,
    status: "fresh",
    safe_code: proof.safe_code,
    target_count: proof.target_count,
    supporting_count: proof.supporting_count,
    proof,
  };
}


function freshnessJson(result: ProposalFreshnessEvaluation): Record<string, unknown> {
  return {
    schema_version: "synapsor.proposal-freshness-result.v1",
    required: result.required,
    status: result.status,
    safe_code: result.safe_code,
    target_count: result.target_count,
    supporting_count: result.supporting_count,
    ...(result.required ? { proof: result.proof } : {}),
    source_database_changed: false,
  };
}


function formatFreshnessResult(result: ProposalFreshnessEvaluation, details: boolean): string {
  if (!result.required) return "Freshness: not required (legacy target guard remains enforced at apply).\n";
  const lines = [
    `Freshness: ${result.status}`,
    `code: ${result.safe_code}`,
    `target checks: ${result.target_count}`,
    `supporting checks: ${result.supporting_count}`,
    `checked at: ${result.proof.checked_at}`,
    `proof: ${result.proof.proof_digest}`,
  ];
  if (result.status === "stale") lines.push("next: create a new source read and proposal; this proposal cannot be refreshed or approved");
  else if (result.status === "unavailable") lines.push("next: retry the live check after the source is available; no approval was recorded");
  else if (result.status === "invalid" || result.status === "unsupported") lines.push("next: fix the reviewed freshness configuration; no approval was recorded");
  else lines.push("note: approval-time freshness does not replace the final apply-time revalidation");
  if (details) {
    for (const check of result.proof.checks) {
      lines.push(
        `- ${check.kind}:${check.id} ${check.status} (${check.safe_code})`
        + `${check.expected_version_digest ? ` expected=${check.expected_version_digest}` : ""}`
        + `${check.observed_version_digest ? ` observed=${check.observed_version_digest}` : ""}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}


export async function proposalsApprove(
  args: string[],
  invocation: TrustedOperatorInvocation = {},
): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals approve requires <proposal_id>");
  const storePath = localStorePath(args);
  const configPath = runnerConfigPath(args);
  const config = await optionalRuntimeConfig(configPath);
  assertLocalGovernanceMutationAllowed(config, "proposals approve");
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(
      args,
      config,
      `proposals approve ${proposalId}`,
      (bridgeStorePath) => proposalsApprove(argsWithRuntimeStoreBridge(args, bridgeStorePath), invocation),
    );
  }
  assertNoRuntimeStoreForLocalMutation(config, "proposals approve", args);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(
      args,
      storePath,
      `proposals approve ${proposalId}`,
      () => proposalsApprove(withoutSharedPostgresLedgerMirror(args), invocation),
      config,
    );
  }
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const proposal = requireLocalProposal(store, resolvedProposalId);
    if (!invocation.quiet && !args.includes("--json")) {
      const evidence = store.getEvidenceBundle(proposal.change_set.evidence.bundle_id);
      process.stdout.write(formatProposalDetail(proposal, evidence?.items.length));
    }
    const freshness = reusableRecordedFreshness({
      proposal,
      config,
      configPath,
      store,
      proofDigest: invocation.freshnessProofDigest,
    }) ?? await evaluateAndRecordProposalFreshness({
      proposal,
      config,
      configPath,
      store,
      unavailableAttempts: 2,
    });
    if (!invocation.quiet && !args.includes("--json")) process.stdout.write(formatFreshnessResult(freshness, args.includes("--details")));
    if (freshness.status !== "fresh" && freshness.status !== "not_required") {
      if (freshness.required) {
        store.recordFreshnessApprovalBlocked(resolvedProposalId, {
          proof_digest: freshness.proof.proof_digest,
          safe_code: freshness.safe_code,
          actor: invocation.decision?.actor ?? "operator",
        });
      }
      if (!invocation.quiet && args.includes("--json")) process.stdout.write(`${JSON.stringify(freshnessJson(freshness), null, 2)}\n`);
      return freshnessExitCodes[freshness.status];
    }
    await confirmDangerousAction(args, `Approve proposal ${resolvedProposalId} for guarded writeback?`);
    const reason = invocation.decision?.reason ?? optionalArg(args, "--reason");
    const identity = await operatorIdentityForDecision({
      args,
      config,
      configPath,
      proposal,
      action: "approve",
      reason,
      decision: invocation.decision,
    });
    const updated = store.approveProposal(resolvedProposalId, {
      approver: identity.subject,
      proposal_hash: proposal.proposal_hash,
      proposal_version: proposal.proposal_version,
      reason,
      identity,
      require_verified_identity: Boolean(config?.operator_identity && config.operator_identity.provider !== "dev_env"),
      freshness_proof_digest: freshness.required ? freshness.proof.proof_digest : undefined,
    });
    operationalLog("info", "operator_decision", {
      action: "approve",
      proposal_id: updated.proposal_id,
      capability: updated.action,
      tenant: updated.tenant_id,
      subject: identity.subject,
      identity_provider: identity.provider,
      identity_verified: identity.verified,
      required_role: proposal.change_set.approval.required_role,
      approval_progress: `${store.approvalProgress(resolvedProposalId).approved}/${store.approvalProgress(resolvedProposalId).required}`,
      freshness_status: freshness.status,
      ...(freshness.required ? { freshness_proof_digest: freshness.proof.proof_digest } : {}),
    });
    const progress = store.approvalProgress(resolvedProposalId);
    const workerQueue = progress.complete
      ? enqueueApprovedProposalForSupervisedWorker(store, config, updated)
      : undefined;
    const approvalResult = {
      ...updated,
      approval_progress: progress,
      freshness: freshnessJson(freshness),
      ...(workerQueue ? {
        execution: {
          mode: "supervised_worker",
          status: workerQueue.status,
          contract_digest: workerQueue.contract_digest,
        },
      } : {}),
    };
    if (!invocation.quiet) {
      process.stdout.write(args.includes("--json")
        ? `${JSON.stringify(approvalResult, null, 2)}\n`
        : progress.complete
          ? `approved ${updated.proposal_id} (${progress.approved}/${progress.required})`
            + (workerQueue
              ? `\nqueued for separately trusted supervised execution under ${workerQueue.contract_digest}\n`
              : "\n")
          : `approval recorded for ${updated.proposal_id} (${progress.approved}/${progress.required}); awaiting ${progress.remaining} more verified reviewer${progress.remaining === 1 ? "" : "s"}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}


function enqueueApprovedProposalForSupervisedWorker(
  store: ProposalStore,
  config: RuntimeConfig | undefined,
  proposal: StoredProposal,
): WorkerQueueItem | undefined {
  if (!config?.supervised_worker?.enabled || proposal.state !== "approved") return undefined;
  const capability = findProposalCapability(config, proposal);
  const eligibility = resolveSupervisedWorkerEligibility(config, capability, { phase: "queue" });
  if (!eligibility.eligible || !eligibility.policy || !eligibility.contract_digest) return undefined;
  if (proposal.change_set.contract?.digest !== eligibility.contract_digest) return undefined;
  return store.enqueueWorkerProposal({
    proposal_id: proposal.proposal_id,
    execution_mode: "supervised_worker",
    contract_digest: eligibility.contract_digest,
    max_attempts: eligibility.policy.max_attempts,
    queue_limit: eligibility.policy.queue_limit,
  });
}


export async function proposalsReject(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals reject requires <proposal_id>");
  const reason = optionalArg(args, "--reason");
  if (!reason) throw new Error("proposals reject requires --reason <text>");
  const storePath = localStorePath(args);
  const configPath = runnerConfigPath(args);
  const config = await optionalRuntimeConfig(configPath);
  assertLocalGovernanceMutationAllowed(config, "proposals reject");
  if (config && runtimeStoreBridgeRequired(args, config)) {
    return withSharedPostgresRuntimeStoreBridge(args, config, `proposals reject ${proposalId}`, (bridgeStorePath) => proposalsReject(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  }
  assertNoRuntimeStoreForLocalMutation(config, "proposals reject", args);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(args, storePath, `proposals reject ${proposalId}`, () => proposalsReject(withoutSharedPostgresLedgerMirror(args)), config);
  }
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const proposal = requireLocalProposal(store, resolvedProposalId);
    if (!args.includes("--json")) {
      const evidence = store.getEvidenceBundle(proposal.change_set.evidence.bundle_id);
      process.stdout.write(formatProposalDetail(proposal, evidence?.items.length));
    }
    await confirmDangerousAction(args, `Reject proposal ${resolvedProposalId}?`);
    const identity = await operatorIdentityForDecision({ args, config, configPath, proposal, action: "reject", reason });
    const updated = store.rejectProposal(resolvedProposalId, {
      actor: identity.subject,
      proposal_hash: proposal.proposal_hash,
      proposal_version: proposal.proposal_version,
      reason,
      identity,
      require_verified_identity: Boolean(config?.operator_identity && config.operator_identity.provider !== "dev_env"),
    });
    operationalLog("info", "operator_decision", {
      action: "reject",
      proposal_id: updated.proposal_id,
      capability: updated.action,
      tenant: updated.tenant_id,
      subject: identity.subject,
      identity_provider: identity.provider,
      identity_verified: identity.verified,
      required_role: proposal.change_set.approval.required_role,
    });
    process.stdout.write(args.includes("--json") ? `${JSON.stringify(updated, null, 2)}\n` : `rejected ${updated.proposal_id}\n`);
    return 0;
  } finally {
    store.close();
  }
}


export async function proposalsWritebackJob(args: string[]): Promise<number> {
  const proposalId = positional(args, 0);
  if (!proposalId) throw new Error("proposals writeback-job requires <proposal_id>");
  const output = outputArg(args);
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveProposalIdFromStore(proposalId, store);
    const job = store.createWritebackJobFromProposal(resolvedProposalId, {
      project_id: optionalArg(args, "--project") ?? "local",
      runner_id: optionalArg(args, "--runner") ?? process.env.SYNAPSOR_RUNNER_ID ?? "local_runner",
      lease_seconds: Number(optionalArg(args, "--lease-seconds") ?? "300"),
    });
    const text = `${JSON.stringify(job, null, 2)}\n`;
    if (output) {
      await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
      await fs.writeFile(output, text, "utf8");
      process.stdout.write(`created writeback job ${job.writeback_job_id} for ${resolvedProposalId} at ${output}\n`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  } finally {
    store.close();
  }
}


export async function evidenceList(args: string[]): Promise<number> {
  assertKnownOptions(args, evidenceListAllowedOptions, "evidence list");
  assertLedgerListModes(args, "evidence list");
  if (args.includes("--follow")) return followEvidence(args);
  const result = await readEvidenceList(args);
  if (args.includes("--interactive")) return browseEvidence(result);
  writeEvidenceList(result, args.includes("--json"));
  return 0;
}


export async function evidenceShow(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "evidence show", (bridgeStorePath) => evidenceShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, showAllowedOptions, "evidence show");
  const evidenceId = positional(args, 0);
  if (!evidenceId) throw new Error("evidence show requires <evidence_bundle_id>");
  const ledgerSource = await ledgerReadSource(args);
  const store = await openLocalStore(args);
  try {
    const evidence = store.getEvidenceBundle(evidenceId);
    if (!evidence) {
      const guidance = /^\d+$/.test(evidenceId)
        ? ` ${evidenceId} looks like a query-audit ID; try ${cliCommandName()} query-audit show ${evidenceId} --details${storeOptionSuffix(args)}.`
        : "";
      throw new Error(`evidence bundle not found: ${evidenceId}.${guidance}`);
    }
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ...evidence, ledger_source: ledgerSource }, null, 2)}\n`);
    else {
      process.stdout.write(ledgerReadSourceLine(ledgerSource));
      if (showDetails(args)) process.stdout.write(formatEvidenceDetail(evidence, terminalSyntaxColorEnabled()));
      else process.stdout.write(formatEvidenceFirstLook(evidence, storeOptionSuffix(args)));
    }
    return 0;
  } finally {
    store.close();
  }
}


export async function evidenceExport(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "evidence export", (bridgeStorePath) => evidenceExport(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, exportAllowedOptions, "evidence export");
  const evidenceId = positional(args, 0) ?? optionalArg(args, "--evidence");
  if (!evidenceId) throw new Error("evidence export requires <evidence_bundle_id>");
  const output = outputArg(args);
  if (!output) throw new Error("evidence export requires --output <path>");
  const format = exportFormat(args);
  const ledgerSource = await ledgerReadSource(args);
  const store = await openLocalStore(args);
  try {
    const evidence = store.getEvidenceBundle(evidenceId);
    if (!evidence) {
      const guidance = /^\d+$/.test(evidenceId)
        ? ` ${evidenceId} looks like a query-audit ID; try ${cliCommandName()} query-audit show ${evidenceId} --details${storeOptionSuffix(args)}.`
        : "";
      throw new Error(`evidence bundle not found: ${evidenceId}.${guidance}`);
    }
    const text = format === "json" ? `${JSON.stringify(evidence, null, 2)}\n` : formatEvidenceMarkdown(evidence);
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(ledgerReadSourceLine(ledgerSource));
    process.stdout.write(`exported ${evidence.evidence_bundle_id} to ${output}\n`);
    return 0;
  } finally {
    store.close();
  }
}


export async function queryAuditList(args: string[]): Promise<number> {
  assertKnownOptions(args, queryAuditListAllowedOptions, "query-audit list");
  assertLedgerListModes(args, "query-audit list");
  if (args.includes("--follow")) return followQueryAudit(args);
  const result = await readQueryAuditList(args);
  if (args.includes("--interactive")) return browseQueryAudit(result);
  writeQueryAuditList(result, args.includes("--json"), showDetails(args), storeOptionSuffix(args));
  return 0;
}


export async function queryAuditShow(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "query-audit show", (bridgeStorePath) => queryAuditShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, showAllowedOptions, "query-audit show");
  const auditId = Number(positional(args, 0));
  if (!Number.isInteger(auditId) || auditId <= 0) throw new Error("query-audit show requires <audit_id>");
  const ledgerSource = await ledgerReadSource(args);
  const store = await openLocalStore(args);
  try {
    const row = store.getQueryAudit(auditId);
    if (!row) throw new Error(`query audit record not found: ${auditId}`);
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ...row, ledger_source: ledgerSource }, null, 2)}\n`);
    else {
      process.stdout.write(ledgerReadSourceLine(ledgerSource));
      process.stdout.write(showDetails(args)
        ? formatQueryAuditDetail(row, terminalSyntaxColorEnabled())
        : formatQueryAuditFirstLook(row, storeOptionSuffix(args)));
    }
    return 0;
  } finally {
    store.close();
  }
}


export async function queryAuditExport(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "query-audit export", (bridgeStorePath) => queryAuditExport(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, exportAllowedOptions, "query-audit export");
  const auditId = Number(positional(args, 0) ?? optionalArg(args, "--audit"));
  if (!Number.isInteger(auditId) || auditId <= 0) throw new Error("query-audit export requires <audit_id>");
  const output = outputArg(args);
  if (!output) throw new Error("query-audit export requires --output <path>");
  const format = exportFormat(args, ["json"]);
  const ledgerSource = await ledgerReadSource(args);
  const store = await openLocalStore(args);
  try {
    const row = store.getQueryAudit(auditId);
    if (!row) throw new Error(`query audit record not found: ${auditId}`);
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, `${JSON.stringify(row, null, 2)}\n`, "utf8");
    process.stdout.write(ledgerReadSourceLine(ledgerSource));
    process.stdout.write(`exported query audit ${auditId} to ${output}\n`);
    return 0;
  } finally {
    store.close();
  }
}


export async function receiptsList(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "receipts list", (bridgeStorePath) => receiptsList(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, receiptListAllowedOptions, "receipts list");
  const ledgerSource = await ledgerReadSource(args);
  const store = await openLocalStore(args);
  try {
    const rows = store.listReceipts(receiptFiltersFromArgs(args));
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ledger_source: ledgerSource, receipts: rows }, null, 2)}\n`);
    else {
      process.stdout.write(ledgerReadSourceLine(ledgerSource));
      if (rows.length === 0) process.stdout.write(emptyLedgerMessage("writeback receipts", ledgerSource));
      else for (const receipt of rows) process.stdout.write(formatReceiptSummary(receipt));
    }
    return 0;
  } finally {
    store.close();
  }
}


export async function receiptsShow(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "receipts show", (bridgeStorePath) => receiptsShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, showAllowedOptions, "receipts show");
  const receiptId = Number(positional(args, 0));
  if (!Number.isInteger(receiptId) || receiptId <= 0) throw new Error("receipts show requires <receipt_id>");
  const ledgerSource = await ledgerReadSource(args);
  const store = await openLocalStore(args);
  try {
    const receipt = store.getReceipt(receiptId);
    if (!receipt) throw new Error(`writeback receipt not found: ${receiptId}`);
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ...receipt, ledger_source: ledgerSource }, null, 2)}\n`);
    else {
      process.stdout.write(ledgerReadSourceLine(ledgerSource));
      process.stdout.write(showDetails(args) ? formatReceiptDetail(receipt) : formatReceiptFirstLook(receipt, storeOptionSuffix(args)));
    }
    return 0;
  } finally {
    store.close();
  }
}


export async function replayList(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "replay list", (bridgeStorePath) => replayList(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, replayListAllowedOptions, "replay list");
  const ledgerSource = await ledgerReadSource(args);
  const store = await openLocalStore(args);
  try {
    const filters = proposalFiltersFromReplayArgs(args, store);
    const proposals = store.listProposals(filters);
    const rows = proposals.map((proposal) => ({
      replay_id: `replay_${proposal.proposal_id}`,
      proposal_id: proposal.proposal_id,
      created_at: proposal.created_at,
      state: proposal.state,
      tenant_id: proposal.tenant_id,
      principal: proposal.principal ?? proposal.change_set.principal.id,
      capability: proposal.action,
      business_object: proposal.business_object,
      object_id: proposal.object_id,
    }));
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ ledger_source: ledgerSource, replays: rows }, null, 2)}\n`);
    else {
      process.stdout.write(ledgerReadSourceLine(ledgerSource));
      if (rows.length === 0) process.stdout.write(emptyLedgerMessage("replay records", ledgerSource));
      else for (const row of rows) process.stdout.write(formatReplaySummary(row));
    }
    return 0;
  } finally {
    store.close();
  }
}


export async function replayShow(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "replay show", (bridgeStorePath) => replayShow(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, replayShowAllowedOptions, "replay show");
  const ledgerSource = await ledgerReadSource(args);
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveReplayProposalId(args, store);
    const replayRecord = store.replay(resolvedProposalId);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ...replayRecord, ledger_source: ledgerSource }, null, 2)}\n`);
    } else if (showDetails(args)) {
      process.stdout.write(ledgerReadSourceLine(ledgerSource));
      process.stdout.write(formatReplayDetail(replayRecord));
      if (args.includes("--debug")) process.stdout.write(formatReplayDebug(replayRecord, optionalArg(args, "--store")));
    } else {
      process.stdout.write(ledgerReadSourceLine(ledgerSource));
      process.stdout.write(formatReplayFirstLook(replayRecord, storeOptionSuffix(args)));
    }
    return 0;
  } finally {
    store.close();
  }
}


export async function replayExport(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "replay export", (bridgeStorePath) => replayExport(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, replayExportAllowedOptions, "replay export");
  const output = outputArg(args);
  if (!output) throw new Error("replay export requires --output <path>");
  const format = exportFormat(args);
  const ledgerSource = await ledgerReadSource(args);
  const store = await openLocalStore(args);
  try {
    const resolvedProposalId = resolveReplayProposalId(args, store);
    const replayRecord = store.replay(resolvedProposalId);
    const text = format === "json" ? `${JSON.stringify(replayRecord, null, 2)}\n` : formatReplayMarkdown(replayRecord);
    await fs.mkdir(path.dirname(path.resolve(output)), { recursive: true });
    await fs.writeFile(output, text, "utf8");
    process.stdout.write(ledgerReadSourceLine(ledgerSource));
    process.stdout.write(`exported ${replayRecord.replay_id} to ${output}\n`);
    return 0;
  } finally {
    store.close();
  }
}


export async function activitySearch(args: string[]): Promise<number> {
  const bridged = await maybeSharedPostgresRuntimeStoreRead(args, "activity search", (bridgeStorePath) => activitySearch(argsWithRuntimeStoreBridge(args, bridgeStorePath)));
  if (bridged !== undefined) return bridged;
  assertKnownOptions(args, activitySearchAllowedOptions, "activity search");
  const ledgerSource = await ledgerReadSource(args);
  const store = await openLocalStore(args);
  try {
    const proposalFilters = proposalFiltersFromActivityArgs(args, store);
    const resolvedEvidence = await resolveExploreLedgerFilters(
      args,
      evidenceFiltersFromActivityArgs(args, store),
    );
    const resolvedQueryAudit = await resolveExploreLedgerFilters(
      args,
      queryAuditFiltersFromActivityArgs(args, store),
    );
    const receiptFilters = receiptFiltersFromActivityArgs(args, store);
    const exploreOnly = args.includes("--boundary") || args.includes("--outcome");
    const proposals = exploreOnly ? [] : store.listProposals(proposalFilters);
    const evidenceRows = store.listEvidenceBundles(resolvedEvidence.filters);
    const queryAuditRows = store.listQueryAudit(resolvedQueryAudit.filters);
    const receiptsRows = exploreOnly ? [] : store.listReceipts(receiptFilters);
    const proposalIds = new Set(proposals.map((proposal) => proposal.proposal_id));
    const evidenceIds = new Set(evidenceRows.map((evidence) => evidence.evidence_bundle_id));
    const results: Record<string, unknown>[] = proposals.map((proposal) => activityFromProposal(proposal));
    for (const evidence of evidenceRows) {
      if (evidence.proposal_id && proposalIds.has(evidence.proposal_id)) continue;
      results.push(activityFromEvidence(evidence));
    }
    for (const audit of queryAuditRows) {
      const proposalId = stringField(audit, "proposal_id");
      const evidenceId = stringField(audit, "evidence_bundle_id");
      if (proposalId && proposalIds.has(proposalId)) continue;
      if (evidenceId && evidenceIds.has(evidenceId)) continue;
      results.push(activityFromQueryAudit(audit));
    }
    for (const receipt of receiptsRows) {
      if (proposalIds.has(receipt.proposal_id)) continue;
      results.push(activityFromReceipt(receipt));
    }
    const sorted = results
      .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")))
      .slice(0, limitFromArgs(args));
    const notes = [...new Set([...resolvedEvidence.notes, ...resolvedQueryAudit.notes])];
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({
        ledger_source: ledgerSource,
        notices: notes,
        interactions: sorted,
      }, null, 2)}\n`);
    } else if (sorted.length === 0) {
      process.stdout.write(ledgerReadSourceLine(ledgerSource));
      for (const note of notes) process.stdout.write(`Note: ${note}\n`);
      process.stdout.write(emptyLedgerMessage("interactions", ledgerSource));
    } else {
      process.stdout.write(ledgerReadSourceLine(ledgerSource));
      for (const note of notes) process.stdout.write(`Note: ${note}\n`);
      process.stdout.write(`Found ${sorted.length} interaction${sorted.length === 1 ? "" : "s"}\n\n`);
      sorted.forEach((item, index) => process.stdout.write(formatActivityItem(item, index + 1, showDetails(args))));
      process.stdout.write(formatActivityNext(sorted, storeOptionSuffix(args)));
    }
    return 0;
  } finally {
    store.close();
  }
}


export async function eventsTail(args: string[]): Promise<number> {
  assertKnownOptions(args, eventTailAllowedOptions, "events tail");
  const follow = args.includes("--follow");
  if (follow && args.includes("--json")) throw new Error("events tail --follow does not support --json yet");
  const storePath = optionalArg(args, "--store");
  const intervalMs = Number(optionalArg(args, "--interval-ms") ?? "1000");
  if (!Number.isFinite(intervalMs) || intervalMs < 250) throw new Error("--interval-ms must be at least 250");
  const filters = eventFiltersFromArgs(args);
  const printOnce = async (seen?: Set<number>): Promise<number> => {
    const store = await openLocalStore(["--store", storePath ?? "./.synapsor/local.db"]);
    try {
      const rows = store.listEvents(filters)
        .sort((left, right) => left.event_id - right.event_id)
        .filter((event) => !seen?.has(event.event_id));
      if (seen) rows.forEach((event) => seen.add(event.event_id));
      if (args.includes("--json")) {
        process.stdout.write(`${JSON.stringify({ events: rows }, null, 2)}\n`);
      } else if (rows.length === 0 && !follow) {
        process.stdout.write("No local events found.\n");
      } else {
        for (const event of rows) {
          process.stdout.write(formatEventLine(
            event,
            showDetails(args),
            terminalSyntaxColorEnabled(),
          ));
        }
        if (!follow && rows.length > 0) {
          process.stdout.write(`Inspect newest complete lifecycle:\n${cliCommandName()} lifecycle${storeOptionSuffix(args)}\n`);
        }
      }
      return rows.length;
    } finally {
      store.close();
    }
  };

  if (!follow) {
    await printOnce();
    return 0;
  }

  const seen = new Set<number>();
  await printOnce(seen);
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      void printOnce(seen).catch((error) => {
        process.stderr.write(`events tail error: ${safeErrorMessage(error)}\n`);
      });
    }, intervalMs);
    const stop = () => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}


export async function eventsWebhook(args: string[]): Promise<number> {
  assertKnownOptions(args, eventWebhookAllowedOptions, "events webhook");
  const url = optionalArg(args, "--url") ?? envValue(optionalArg(args, "--url-env"));
  if (!url) throw new Error("events webhook requires --url <https://...> or --url-env <ENV>");
  const endpoint = new URL(url);
  if (!["http:", "https:"].includes(endpoint.protocol)) throw new Error("events webhook URL must use http or https");

  const follow = args.includes("--follow");
  const dryRun = args.includes("--dry-run");
  const jsonOutput = args.includes("--json");
  if (follow && jsonOutput) throw new Error("events webhook --follow does not support --json");
  const storePath = optionalArg(args, "--store");
  const intervalMs = Number(optionalArg(args, "--interval-ms") ?? "1000");
  const timeoutMs = Number(optionalArg(args, "--timeout-ms") ?? "5000");
  const sinceEventId = optionalPositiveIntegerArg(args, "--since-event-id");
  if (!Number.isFinite(intervalMs) || intervalMs < 250) throw new Error("--interval-ms must be at least 250");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 250) throw new Error("--timeout-ms must be at least 250");
  const token = envValue(optionalArg(args, "--auth-token-env"));
  const filters = eventFiltersFromArgs(args);
  const seen = new Set<number>();

  const pushOnce = async (): Promise<{ delivered: number; payloads: Record<string, unknown>[] }> => {
    const store = await openLocalStore(["--store", storePath ?? "./.synapsor/local.db"]);
    try {
      const rows = store.listEvents(filters)
        .filter((event) => sinceEventId === undefined || event.event_id > sinceEventId)
        .sort((left, right) => left.event_id - right.event_id)
        .filter((event) => !seen.has(event.event_id));
      rows.forEach((event) => seen.add(event.event_id));
      let delivered = 0;
      const payloads: Record<string, unknown>[] = [];
      for (const event of rows) {
        const payload = localEventWebhookPayload(event, store.path);
        payloads.push(payload);
        if (dryRun) {
          if (!jsonOutput) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        } else {
          await postLocalEventWebhook(endpoint, payload, { token, timeoutMs });
          if (!jsonOutput) process.stdout.write(`pushed event ${event.event_id} ${event.kind} for ${event.proposal_id} to ${redactWebhookUrl(endpoint)}\n`);
        }
        delivered += 1;
      }
      if (rows.length === 0 && !follow && !jsonOutput) process.stdout.write(dryRun ? "No local events matched for dry-run.\n" : "No local events matched.\n");
      return { delivered, payloads };
    } finally {
      store.close();
    }
  };

  const first = await pushOnce();
  if (jsonOutput && !follow) {
    process.stdout.write(`${JSON.stringify({ ok: true, dry_run: dryRun, delivered: first.delivered, webhook: redactWebhookUrl(endpoint), events: first.payloads }, null, 2)}\n`);
  }
  if (!follow) return 0;

  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      void pushOnce().catch((error) => {
        process.stderr.write(`events webhook error: ${safeErrorMessage(error)}\n`);
      });
    }, intervalMs);
    const stop = () => {
      clearInterval(timer);
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
