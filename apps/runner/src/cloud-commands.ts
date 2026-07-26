import { CloudControlClient, CloudControlError, ControlPlaneClient } from "@synapsor-runner/control-plane-client";
import { CloudLinkedSynchronizer, createDefaultRuntimeStore, loadRuntimeConfigFromFile } from "@synapsor-runner/mcp-server";
import {
  ProposalStore,
  type StoredProposal
} from "@synapsor-runner/proposal-store";
import { protocolVersions, type ChangeSet, type RunnerActivityV1, type RunnerProposalV1, type RunnerRegistrationV1 } from "@synapsor-runner/protocol";
import { normalizeContract, type SynapsorContract } from "@synapsor/spec";
import fs from "node:fs/promises";
import process from "node:process";
import dslPackage from "../../../packages/dsl/package.json" with { type: "json" };
import specPackage from "../../../packages/spec/package.json" with { type: "json" };
import runnerPackage from "../package.json" with { type: "json" };
import { isRecord } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { envValue, firstPositional, optionalArg } from "./cli-options.js";
import { resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import { normalizeCapabilities, normalizeEngines } from "./config-templates.js";
import { doctor } from "./first-run-doctor.js";
import { startWorker, up } from "./runtime-commands.js";


export async function runnerCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "start") return startWorker(rest);
  if (subcommand === "up") return up(rest);
  if (subcommand === "doctor") return doctor(rest);
  usage();
  return 2;
}


export async function cloud(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand === "connect") return cloudConnect(rest);
  if (subcommand === "sync") return cloudSync(rest);
  if (subcommand === "sync-activity") return cloudSyncActivity(rest);
  if (subcommand === "push") return cloudPush(rest);
  if (subcommand === "outbox") return cloudOutbox(rest);
  usage();
  return 2;
}


async function cloudOutbox(args: string[]): Promise<number> {
  const [action = "status", ...rest] = args;
  const configPath = runnerConfigPath(rest);
  const storePath = resolvedLocalStorePath(rest);
  const runtimeConfig = loadRuntimeConfigFromFile(configPath);
  if (runtimeConfig.governance?.mode !== "cloud_linked") throw new Error("cloud outbox requires governance.mode cloud_linked");
  const store = createDefaultRuntimeStore(runtimeConfig, process.env, storePath);
  const synchronizer = new CloudLinkedSynchronizer(runtimeConfig, store, process.env);
  try {
    if (action === "status") {
      const status = await synchronizer.status();
      if (rest.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: true, ...status }, null, 2)}\n`);
      else process.stdout.write([
        "Synapsor Cloud outbox",
        `Authority: ${status.authority_mode}`,
        `Evidence residency: ${status.evidence_residency}`,
        `Pending: ${status.pending}`,
        `Leased: ${status.leased}`,
        `Acknowledged: ${status.acknowledged}`,
        `Dead letter: ${status.dead_letter}`,
        `Reconciliation required: ${status.reconciliation_required}`,
        status.last_reconciliation_error_code ? `Last reconciliation error: ${status.last_reconciliation_error_code}` : "",
      ].filter(Boolean).join("\n") + "\n");
      return 0;
    }
    if (action === "inspect") {
      const requested = firstPositional(rest);
      const entries = await store.listCloudOutbox?.({ limit: 10_000 }) ?? [];
      const selected = requested === "latest" || !requested ? entries.at(-1) : entries.find((entry) => entry.event_id === requested);
      if (!selected) throw new Error(`cloud outbox event not found: ${requested || "latest"}`);
      const governance = selected.proposal_id ? await store.listCloudGovernanceEvents?.(selected.proposal_id) ?? [] : [];
      const safe = { ok: true, outbox: selected, governance };
      if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
      else process.stdout.write(`Cloud outbox event: ${selected.event_id}\nStatus: ${selected.status}\nKind: ${selected.kind}\nAttempts: ${selected.attempts}/${selected.max_attempts}\nLast error: ${selected.last_error_code ?? "none"}\nGovernance events: ${governance.length}\n`);
      return 0;
    }
    if (action === "reconcile") {
      if (!rest.includes("--yes")) throw new Error("cloud outbox reconcile requires --yes after inspecting local and Cloud state");
      const drained = await synchronizer.drainOnce();
      const reconciled = await synchronizer.reconcileOnce();
      const status = await synchronizer.status();
      const result = { ok: true, drained, reconciled, status };
      if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(`Cloud outbox reconciliation complete.\nAcknowledged: ${drained.acknowledged}\nFailed: ${drained.failed}\nGovernance updates: ${reconciled.recorded}\n`);
      return status.dead_letter || status.reconciliation_required ? 1 : 0;
    }
    if (action === "retry") {
      const eventId = firstPositional(rest);
      if (!eventId) throw new Error("cloud outbox retry requires <event-id>");
      if (!rest.includes("--yes")) throw new Error("cloud outbox retry requires --yes after resolving the reported permanent cause");
      if (!store.requeueCloudOutbox) throw new Error("configured runtime store does not support Cloud outbox repair");
      const requeued = await store.requeueCloudOutbox(eventId);
      const drained = await synchronizer.drainOnce();
      const result = { ok: true, requeued, drained, status: await synchronizer.status() };
      if (rest.includes("--json")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else process.stdout.write(`Requeued ${eventId}.\nAcknowledged: ${drained.acknowledged}\nFailed: ${drained.failed}\n`);
      return drained.failed ? 1 : 0;
    }
    throw new Error("cloud outbox supports status, inspect, reconcile, and retry");
  } finally {
    await synchronizer.stop();
    await store.close();
  }
}


type CloudConnectionFile = {
  cloud?: {
    protocol_version?: string;
    base_url?: string;
    base_url_env?: string;
    runner_token_env?: string;
    runner_id?: string;
    runner_version?: string;
    project_id?: string;
    source_id?: string;
    /** Portable source alias named by the reviewed contract and local runner config. */
    runner_source_id?: string;
    mapping_id?: string;
    contract_id?: string;
    contract_version_id?: string;
    contract_digest?: string;
    engines?: string[];
    capabilities?: string[];
  };
};


async function loadCloudConnection(configPath: string): Promise<{
  file: NonNullable<CloudConnectionFile["cloud"]>;
  baseUrl: string;
  runnerToken: string;
  runnerId: string;
  runnerVersion: string;
  sourceId: string;
}> {
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as CloudConnectionFile;
  if (!parsed.cloud) throw new Error(`cloud config missing in ${configPath}`);
  const baseUrlEnv = parsed.cloud.base_url_env || "SYNAPSOR_CLOUD_BASE_URL";
  const tokenEnv = parsed.cloud.runner_token_env || "SYNAPSOR_RUNNER_TOKEN";
  const baseUrl = envValue(process.env, baseUrlEnv) || String(parsed.cloud.base_url || "").trim();
  const runnerToken = envValue(process.env, tokenEnv);
  const missing = [baseUrl ? "" : baseUrlEnv, runnerToken ? "" : tokenEnv].filter(Boolean);
  if (missing.length > 0) throw new Error(`missing environment variables: ${missing.join(", ")}`);
  const sourceId = String(parsed.cloud.source_id || process.env.SYNAPSOR_SOURCE_ID || "").trim();
  if (!sourceId || sourceId === "src_replace_me") throw new Error("cloud.source_id is required and must match the scoped Cloud Runner token source");
  return {
    file: parsed.cloud,
    baseUrl: baseUrl!,
    runnerToken: runnerToken!,
    sourceId,
    runnerId: String(parsed.cloud.runner_id || process.env.SYNAPSOR_RUNNER_ID || "synapsor_runner_local").trim(),
    runnerVersion: String(parsed.cloud.runner_version || process.env.npm_package_version || runnerPackage.version).trim(),
  };
}


function stripPrincipalScopeFromCloudRows(changeSet: ChangeSet, column: string): void {
  const stripRecord = (value: unknown): void => {
    if (isRecord(value)) delete value[column];
  };
  stripRecord(changeSet.before);
  stripRecord(changeSet.after);
  if ("frozen_set" in changeSet && isRecord(changeSet.frozen_set) && Array.isArray(changeSet.frozen_set.members)) {
    for (const member of changeSet.frozen_set.members) {
      if (!isRecord(member)) continue;
      stripRecord(member.before);
      stripRecord(member.after);
    }
  }
  if (changeSet.schema_version === protocolVersions.compensationChangeSet) {
    for (const member of changeSet.compensation.descriptor.members) {
      stripRecord(member.expected_state);
      stripRecord(member.restore_values);
    }
  }
}


async function cloudSync(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.cloud.json";
  const storePath = resolvedLocalStorePath(args);
  const requested = firstPositional(args);
  const connection = await loadCloudConnection(configPath);
  const contractId = String(connection.file.contract_id || "").trim();
  const contractVersionId = String(connection.file.contract_version_id || "").trim();
  const contractDigest = String(connection.file.contract_digest || "").trim();
  const runnerSourceId = String(connection.file.runner_source_id || connection.sourceId).trim();
  if (!contractId || !contractVersionId || !/^sha256:[0-9a-f]{16,}$/i.test(contractDigest)) {
    throw new Error("cloud sync requires contract_id, contract_version_id, and contract_digest in synapsor.cloud.json");
  }
  const client = new ControlPlaneClient({
    baseUrl: connection.baseUrl,
    runnerToken: connection.runnerToken,
    sourceId: connection.sourceId,
    runnerId: connection.runnerId,
  });
  const store = new ProposalStore(storePath);
  try {
    const candidates = store.listProposals({ state: "pending_review", source: runnerSourceId, limit: 100 });
    const selected = requested
      ? [requested === "latest" ? candidates[0] : store.getProposal(requested)].filter((value): value is StoredProposal => value !== undefined)
      : candidates;
    if (requested && selected.length === 0) throw new Error(`local pending proposal not found: ${requested}`);
    let synced = 0;
    for (const proposal of selected) {
      if (proposal.state !== "pending_review") throw new Error(`proposal ${proposal.proposal_id} is ${proposal.state}; only pending_review proposals can enter Cloud approval`);
      if (proposal.source_id !== runnerSourceId) {
        throw new Error(`proposal ${proposal.proposal_id} uses local source ${proposal.source_id}; Cloud source ${connection.sourceId} is mapped to reviewed local source ${runnerSourceId}`);
      }
      const evidence = store.listEvidenceBundles({ proposal: proposal.proposal_id, limit: 100 });
      const queryAudit = store.listQueryAudit({ proposal: proposal.proposal_id, limit: 100 });
      const sanitizedChangeSet = JSON.parse(JSON.stringify(proposal.change_set)) as ChangeSet;
      sanitizedChangeSet.evidence.items = [];
      if (sanitizedChangeSet.guards.principal_scope) {
        stripPrincipalScopeFromCloudRows(sanitizedChangeSet, sanitizedChangeSet.guards.principal_scope.column);
        sanitizedChangeSet.principal.id = sanitizedChangeSet.guards.principal_scope.value_fingerprint;
        delete sanitizedChangeSet.guards.principal_scope.value;
      }
      const payload: RunnerProposalV1 = {
        schema_version: protocolVersions.runnerProposal,
        runner_id: connection.runnerId,
        source_id: connection.sourceId,
        ...(connection.file.mapping_id ? { mapping_id: connection.file.mapping_id } : {}),
        contract: {
          contract_id: contractId,
          contract_version_id: contractVersionId,
          digest: contractDigest as `sha256:${string}`,
        },
        change_set: sanitizedChangeSet,
        evidence_metadata: {
          bundle_ids: evidence.map((item) => item.evidence_bundle_id),
          count: evidence.length,
          query_fingerprints: [...new Set(evidence.map((item) => item.query_fingerprint).filter(Boolean))],
          payload_uploaded: false,
        },
        query_audit: {
          audit_ids: queryAudit.map((item) => item.audit_id).filter((value) => value !== undefined),
          count: queryAudit.length,
          query_fingerprints: [...new Set(queryAudit.map((item) => item.query_fingerprint).filter(Boolean))],
          tables: [...new Set(queryAudit.map((item) => item.table_name).filter(Boolean))],
          payload_uploaded: false,
        },
      };
      await client.submitProposal(payload);
      synced += 1;
    }
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify({ ok: true, synced, source_id: connection.sourceId, contract_version_id: contractVersionId }, null, 2)}\n`);
    } else {
      process.stdout.write(`Synced ${synced} pending proposal${synced === 1 ? "" : "s"} to Cloud for ${connection.sourceId}.\n`);
      process.stdout.write("Only proposal diffs and bounded evidence/query-audit metadata were sent; database credentials and source rows stayed local.\n");
    }
    return 0;
  } finally {
    store.close();
  }
}


async function cloudSyncActivity(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? "synapsor.cloud.json";
  const storePath = resolvedLocalStorePath(args);
  const requested = firstPositional(args) ?? "latest";
  const connection = await loadCloudConnection(configPath);
  const runnerSourceId = String(connection.file.runner_source_id || connection.sourceId).trim();
  const client = new ControlPlaneClient({
    baseUrl: connection.baseUrl,
    runnerToken: connection.runnerToken,
    sourceId: connection.sourceId,
    runnerId: connection.runnerId,
  });
  const store = new ProposalStore(storePath);
  try {
    const proposal = requested === "latest"
      ? store.listProposals({ source: runnerSourceId, limit: 1 })[0]
      : store.getProposal(requested);
    if (!proposal) throw new Error(`local proposal not found: ${requested}`);
    if (proposal.source_id !== runnerSourceId) {
      throw new Error(`proposal ${proposal.proposal_id} uses local source ${proposal.source_id}; Cloud source ${connection.sourceId} is mapped to reviewed local source ${runnerSourceId}`);
    }
    const evidence = store.listEvidenceBundles({ proposal: proposal.proposal_id, limit: 100 });
    const queryAudit = store.listQueryAudit({ proposal: proposal.proposal_id, limit: 100 });
    const replay = store.replay(proposal.proposal_id);
    const principalScope = proposal.change_set.guards.principal_scope;
    const common = {
      schema_version: protocolVersions.runnerActivity,
      runner_id: connection.runnerId,
      source_id: connection.sourceId,
      proposal_id: proposal.proposal_id,
      capability: proposal.action,
      tenant_id: proposal.tenant_id,
      principal: principalScope?.value_fingerprint ?? proposal.principal,
      business_object: proposal.business_object,
      object_id: proposal.object_id,
      status: proposal.state,
    } as const;
    const events: RunnerActivityV1[] = [
      ...evidence.map((item) => ({
        ...common,
        event_id: `evidence:${item.evidence_bundle_id}`,
        event_type: "evidence.recorded" as const,
        evidence_ids: [item.evidence_bundle_id],
        detail: { stored_locally: true, payload_uploaded: false },
        occurred_at: item.created_at,
      })),
      ...queryAudit.map((item) => ({
        ...common,
        event_id: `query-audit:${String(item.audit_id)}`,
        event_type: "query_audit.recorded" as const,
        query_audit_ids: [String(item.audit_id)],
        ...(typeof item.evidence_bundle_id === "string" ? { evidence_ids: [item.evidence_bundle_id] } : {}),
        detail: { stored_locally: true, payload_uploaded: false },
        occurred_at: typeof item.created_at === "string" ? item.created_at : undefined,
      })),
      {
        ...common,
        event_id: `replay:${replay.replay_id}`,
        event_type: "replay.recorded",
        replay_id: replay.replay_id,
        detail: { stored_locally: true, payload_uploaded: false },
      },
    ];
    for (const event of events) await client.submitActivity(event);
    const output = {
      ok: true,
      synced: events.length,
      proposal_id: proposal.proposal_id,
      evidence_references: evidence.length,
      query_audit_references: queryAudit.length,
      replay_id: replay.replay_id,
    };
    if (args.includes("--json")) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    else {
      process.stdout.write(`Synced ${events.length} local activity reference${events.length === 1 ? "" : "s"} to Cloud for ${proposal.proposal_id}.\n`);
      process.stdout.write("Evidence contents, source rows, database credentials, and local replay payloads stayed local.\n");
    }
    return 0;
  } finally {
    store.close();
  }
}


async function cloudPush(args: string[]): Promise<number> {
  const target = firstPositional(args);
  if (!target) throw new Error("cloud push requires <synapsor.contract.json>");
  const parsed = JSON.parse(await fs.readFile(target, "utf8"));
  const contract = normalizeContract(parsed);
  const workspace = (optionalArg(args, "--workspace") ?? optionalArg(args, "--project") ?? process.env.SYNAPSOR_CLOUD_WORKSPACE ?? process.env.SYNAPSOR_WORKSPACE_ID ?? process.env.SYNAPSOR_PROJECT_ID ?? "").trim();
  const name = (optionalArg(args, "--name") ?? contract.metadata?.name ?? "").trim();
  const description = (optionalArg(args, "--description") ?? contract.metadata?.description ?? "").trim();
  const idempotencyKey = optionalArg(args, "--idempotency-key");
  const payload = {
    schema_version: "synapsor.cloud-contract-push.v0.1",
    contract,
    summary: contractSummary(contract),
    workspace,
    name,
    description,
    source: "runner",
    source_versions: {
      "@synapsor/spec": specPackage.version,
      "@synapsor/dsl": dslPackage.version,
      "@synapsor/runner": process.env.npm_package_version ?? runnerPackage.version,
    },
    activate: args.includes("--activate"),
    idempotency_key: idempotencyKey,
    pushed_at: new Date().toISOString(),
  };
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  if (dryRun && json) {
    process.stdout.write(`${JSON.stringify({ ok: dryRun, dry_run: dryRun, payload }, null, 2)}\n`);
    return 0;
  }
  if (dryRun) {
    process.stdout.write("Synapsor Cloud contract push preview\n");
    process.stdout.write(`Contract: ${target}\n`);
    process.stdout.write(`Contexts: ${payload.summary.contexts}\n`);
    process.stdout.write(`Capabilities: ${payload.summary.capabilities}\n`);
    process.stdout.write(`Workflows: ${payload.summary.workflows}\n`);
    process.stdout.write(`Proposal capabilities: ${payload.summary.proposal_capabilities}\n`);
    process.stdout.write(`Approval policies: ${payload.summary.approval_policies}\n`);
    process.stdout.write(`Kept-out fields: ${payload.summary.kept_out_fields}\n`);
    process.stdout.write("Dry run only. No Cloud upload attempted.\n");
    return 0;
  }
  const apiUrl = (optionalArg(args, "--api-url") ?? process.env.SYNAPSOR_CLOUD_BASE_URL ?? "").trim();
  if (args.includes("--token")) {
    throw new Error("cloud push does not accept secrets through --token. Set SYNAPSOR_API_KEY for automation or SYNAPSOR_CLOUD_ACCESS_TOKEN for an authenticated human session.");
  }
  const apiKey = (process.env.SYNAPSOR_API_KEY ?? "").trim();
  const humanAccessToken = (process.env.SYNAPSOR_CLOUD_ACCESS_TOKEN ?? "").trim();
  const credential = apiKey || humanAccessToken;
  if (!workspace) {
    throw new Error("cloud push upload requires --workspace <project_id> or SYNAPSOR_CLOUD_WORKSPACE/SYNAPSOR_WORKSPACE_ID/SYNAPSOR_PROJECT_ID.");
  }
  if (!apiUrl || !credential) {
    throw new Error("cloud push upload requires --api-url/SYNAPSOR_CLOUD_BASE_URL plus SYNAPSOR_API_KEY or SYNAPSOR_CLOUD_ACCESS_TOKEN. Use --dry-run for local validation without a network call.");
  }
  let response: Record<string, unknown>;
  try {
    response = await new CloudControlClient({
      baseUrl: apiUrl,
      credential,
      credentialKind: apiKey ? "service" : "human",
      userAgent: "synapsor-runner-cloud-push",
    }).pushContract({
      projectId: workspace,
      contract: contract as unknown as Record<string, unknown>,
      name,
      description,
      source: "runner",
      sourceVersions: payload.source_versions,
      activate: args.includes("--activate"),
      idempotencyKey,
    });
  } catch (error) {
    if (error instanceof CloudControlError) {
      const request = error.request_id ? ` Request: ${error.request_id}.` : "";
      const issues = Array.isArray(error.details?.errors)
        ? error.details.errors.slice(0, 3).map((issue) => isRecord(issue)
          ? `${String(issue.path || "$")} ${String(issue.code || "validation_error")}: ${String(issue.message || "")}`
          : String(issue)).join("; ")
        : "";
      if (error.status === 422 && issues) {
        throw new Error(`Cloud rejected the contract: ${issues}.${request}`);
      }
      throw new Error(`cloud push upload failed: ${error.message} (${error.error_code}).${issues ? ` ${issues}` : ""}${request}`);
    }
    throw error;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return 0;
  }
  const contractId = cloudStringField(response, "contract_id") || cloudStringField(response.contract, "contract_id");
  const versionId = cloudStringField(response, "contract_version_id") || cloudStringField(response.version, "contract_version_id");
  const digest = cloudStringField(response, "digest") || cloudStringField(response.version, "digest");
  const status = cloudStringField(response, "status") || cloudStringField(response.version, "status") || "stored";
  process.stdout.write("Synapsor Cloud contract push complete\n");
  process.stdout.write(`Workspace: ${workspace}\n`);
  if (contractId) process.stdout.write(`Contract id: ${contractId}\n`);
  if (versionId) process.stdout.write(`Version id: ${versionId}\n`);
  if (digest) process.stdout.write(`Digest: ${digest}\n`);
  process.stdout.write(`Status: ${status}\n`);
  const registryUrl = cloudStringField(response, "registry_url");
  if (registryUrl) process.stdout.write(`Registry: ${registryUrl}\n`);
  return 0;
}


function contractSummary(contract: SynapsorContract): Record<string, number> {
  const keptOutFields = new Set<string>();
  for (const capability of contract.capabilities) {
    for (const field of capability.kept_out_fields ?? []) keptOutFields.add(field);
  }
  return {
    contexts: contract.contexts.length,
    capabilities: contract.capabilities.length,
    workflows: contract.workflows?.length ?? 0,
    proposal_capabilities: contract.capabilities.filter((capability) => capability.kind === "proposal").length,
    approval_policies: contract.policies?.filter((policy) => policy.kind === "approval").length ?? 0,
    kept_out_fields: keptOutFields.size,
  };
}


function cloudStringField(value: unknown, key: string): string {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : "";
}


async function cloudConnect(args: string[]): Promise<number> {
  const configPath = optionalArg(args, "--config") ?? process.env.SYNAPSOR_MCP_CONFIG ?? "synapsor.cloud.json";
  let connection;
  try {
    connection = await loadCloudConnection(configPath);
  } catch (error) {
    process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  const { baseUrl, runnerToken, sourceId, runnerId, runnerVersion } = connection;
  const engines = normalizeEngines(connection.file.engines);
  const capabilities = normalizeCapabilities(connection.file.capabilities);
  const client = new ControlPlaneClient({
    baseUrl,
    runnerToken,
    sourceId,
    runnerId,
  });
  const report = await client.doctor();
  if (!report.ok || !report.authenticated) {
    const reason = report.authenticated
      ? `status ${report.status}`
      : "the endpoint did not authenticate the Runner protocol; upgrade Cloud or use its supported API URL";
    process.stdout.write(`cloud connection failed: ${reason}\n`);
    return 1;
  }
  const registration: RunnerRegistrationV1 = {
    schema_version: protocolVersions.runnerRegistration,
    protocol_version: protocolVersions.runnerControl,
    runner_id: runnerId,
    runner_version: runnerVersion,
    engines,
    capabilities,
    scope: {
      project_id: String(connection.file.project_id || "token_scope"),
      source_ids: [sourceId],
    },
    contracts: connection.file.contract_id && connection.file.contract_version_id && connection.file.contract_digest
      ? [{
          contract_id: connection.file.contract_id,
          contract_version_id: connection.file.contract_version_id,
          digest: connection.file.contract_digest,
        }]
      : undefined,
    registered_at: new Date().toISOString(),
  };
  await client.register(registration);
  await client.runnerHeartbeat({
    runner_id: runnerId,
    runner_version: runnerVersion,
    engines,
    source_ids: [sourceId],
    status: "online",
    details: {
      mode: "cloud_connect",
      database_credentials_sent: false,
      adapter_catalog_supported: true,
      writeback_supported: true,
    },
  });
  process.stdout.write(`cloud connection ok for ${sourceId}\n`);
  process.stdout.write(`registered runner ${runnerId}\n`);
  process.stdout.write("sent metadata: runner id/version, engines, capabilities, and source id. Database URLs and credentials were not sent.\n");
  return 0;
}
