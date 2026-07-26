import {
  ProposalStoreError,
  type ProposalRuntimeStore,
  type StoredProposal,
} from "@synapsor-runner/proposal-store";
import type {
  RuntimeConfig,
  TrustedContext,
  DbRowReader,
  CloudAdapterClient,
} from "./runtime-types.js";
import {
  assertApprovalPolicyResolvable,
  assertProposalWritebackResolvable,
  maybeAutoApproveProposal,
} from "./approval-policy.js";
import {
  isSetCapability,
  localCapabilities,
  resolveSupervisedWorkerEligibility,
} from "./capability-authority.js";
import {
  assertCloudLinkedProposalAvailability,
  callCloudTool,
  enqueueCloudLinkedProposal,
} from "./cloud-linked.js";
import {
  selectTemplate,
} from "./local-resources.js";
import {
  batchItemsFromArgs,
  boundedSetEvidenceItems,
  buildChangeSet,
  buildItemPatch,
  buildPatch,
  diffFromChangeSet,
  enforcePatchGuards,
  proposalAlreadyExists,
  resolveDeduplication,
} from "./proposal-builder.js";
import {
  captureProposalFreshnessAuthority,
} from "./proposal-freshness.js";
import {
  enforceProtectedReadBudget,
  recordAggregateRead,
  recordProtectedRead,
} from "./protected-read-runtime.js";
import {
  queryFingerprintFor,
} from "./read-planning.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  scalarRecord,
  stableId,
  visibleScalarRecord,
  withoutPrincipalScopeValue,
} from "./safe-values.js";
import {
  effectivePrincipalScope,
  rejectTrustedArgOverrides,
  resolveTrustedContext,
  validateToolArgs,
} from "./trusted-context.js";

export async function callConfiguredTool(input: {
  config: RuntimeConfig;
  env: NodeJS.ProcessEnv;
  store: ProposalRuntimeStore;
  readRow: DbRowReader;
  cloudClient?: CloudAdapterClient;
  trustedContext?: TrustedContext;
  privacySessionId?: string;
  name: string;
  args: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  rejectTrustedArgOverrides(input.args);
  if (input.config.mode === "cloud") {
    return callCloudTool(input.config, input.cloudClient, input.name, input.args);
  }
  const capability = localCapabilities(input.config).find((item) => item.name === input.name);
  if (!capability) throw new McpRuntimeError("MCP_TOOL_NOT_FOUND", `Unknown Synapsor tool: ${input.name}`);
  validateToolArgs(capability, input.args);

  if (capability.kind === "proposal" && input.config.mode === "read_only") {
    throw new McpRuntimeError("PROPOSALS_DISABLED", "This runner is in read_only mode; proposal tools are disabled.");
  }
  if (capability.kind === "proposal" && input.config.mode === "review") {
    assertProposalWritebackResolvable(input.config, capability);
    assertApprovalPolicyResolvable(input.config, capability);
  }
  if (capability.kind === "proposal") {
    await assertCloudLinkedProposalAvailability(input.config, input.env);
  }
  const source = input.config.sources?.[capability.source];
  if (!source) throw new McpRuntimeError("SOURCE_NOT_FOUND", `Unknown source: ${capability.source}`);
  const context = resolveTrustedContext(input.config, input.env, capability, input.trustedContext);
  if (capability.protected_read) {
    await enforceProtectedReadBudget(input.store, capability, context, input.args, input.privacySessionId ?? "direct-call");
  }
  const operation = capability.kind === "proposal" ? capability.operation?.kind ?? "update" : "update";
  const setOperation = isSetCapability(capability);
  const batchInsert = setOperation && operation === "insert";
  const batchItems = batchInsert ? batchItemsFromArgs(capability, input.args) : [];
  const current = capability.kind === "proposal" && operation === "insert"
    ? { row: {}, rows: [] as Record<string, unknown>[], rowCount: batchItems.length }
    : await input.readRow({
      sourceName: capability.source,
      source,
      capability,
      args: input.args,
      context,
      env: input.env,
    });
  if (capability.protected_read) {
    return recordProtectedRead({
      capability,
      sourceName: capability.source,
      context,
      current,
      store: input.store,
      mode: input.config.mode,
      privacySessionId: input.privacySessionId ?? "direct-call",
      args: input.args,
    });
  }
  if (capability.kind === "aggregate_read") {
    return recordAggregateRead({ capability, sourceName: capability.source, context, current, store: input.store, mode: input.config.mode });
  }
  const currentRows = setOperation
    ? batchInsert ? [] : current.rows ?? (current.rowCount === 1 ? [current.row] : [])
    : current.rowCount === 1 ? [current.row] : [];
  if (setOperation) {
    const maxRows = capability.operation?.max_rows ?? 0;
    const reviewedCount = batchInsert ? batchItems.length : current.rowCount;
    if (reviewedCount > maxRows) throw new McpRuntimeError("SET_ROW_CAP_EXCEEDED", `Reviewed set exceeds MAX ROWS ${maxRows}; no proposal was created.`);
    if (reviewedCount < 1) throw new McpRuntimeError("SET_EMPTY", "The reviewed set is empty; no proposal was created.");
  } else if ((capability.kind !== "proposal" || operation !== "insert") && current.rowCount !== 1) {
    throw new McpRuntimeError("ROW_NOT_FOUND", "The scoped capability read did not find exactly one authorized row.");
  }

  const patch = capability.kind !== "proposal" || operation === "delete" || batchInsert ? {} : buildPatch(capability, input.args);
  const itemPatches = batchInsert ? batchItems.map((item) => buildItemPatch(capability, item, input.args)) : [];
  const before = scalarRecord(current.row);
  const principalScope = effectivePrincipalScope(input.config, capability, context);
  const principalScopeMetadata = principalScope ? withoutPrincipalScopeValue(principalScope) : undefined;
  if (capability.kind === "proposal") {
    if (setOperation && !batchInsert) currentRows.forEach((row) => enforcePatchGuards(capability, scalarRecord(row), patch));
    else if (batchInsert) itemPatches.forEach((itemPatch) => enforcePatchGuards(capability, {}, itemPatch));
    else enforcePatchGuards(capability, before, patch);
  }
  const createdAt = new Date().toISOString();
  const proposalId = stableId("wrp", capability.operation ? {
    action: capability.name,
    operation,
    tenant: context.tenant_id,
    principal_scope: principalScope?.value_fingerprint,
    before: setOperation ? currentRows.map(scalarRecord) : before,
    patch: batchInsert ? itemPatches : patch,
    created_at: createdAt,
  } : {
    action: capability.name,
    tenant: context.tenant_id,
    principal_scope: principalScope?.value_fingerprint,
    object: String(current.row[capability.target.primary_key] ?? input.args[capability.lookup.id_from_arg]),
    before,
    patch,
    created_at: createdAt,
  });
  const resolvedDeduplication = capability.kind === "proposal" && operation === "insert" && !batchInsert
    ? resolveDeduplication(capability, proposalId, context)
    : undefined;
  const primaryDedup = resolvedDeduplication?.components.find((component) => component.column === capability.target.primary_key);
  const objectId = setOperation
    ? stableId("set", {
      capability: capability.name,
      tenant: context.tenant_id,
      principal_scope: principalScope?.value_fingerprint,
      identities: batchInsert ? batchItems : currentRows.map((row) => row[capability.target.primary_key]),
    })
    : capability.kind === "proposal" && operation === "insert"
    ? String(primaryDedup?.value ?? proposalId)
    : String(current.row[capability.target.primary_key] ?? input.args[capability.lookup.id_from_arg]);

  const evidenceBundleId = stableId("ev", {
    capability: capability.name,
    source: capability.source,
    tenant: context.tenant_id,
    principal_scope: principalScope?.value_fingerprint,
    row: capability.kind === "proposal" && operation === "insert" ? undefined : setOperation ? currentRows : current.row,
    patch: capability.kind === "proposal" && operation === "insert" ? (batchInsert ? itemPatches : patch) : undefined,
    at: createdAt,
  });
  const queryFingerprint = queryFingerprintFor(capability, context);
  const freshnessCapture = capability.kind === "proposal"
    ? await captureProposalFreshnessAuthority({
      config: input.config,
      capability,
      args: input.args,
      context,
      source,
      readRow: input.readRow,
      env: input.env,
      proposalId,
      createdAt,
      targetMemberCount: operation === "insert" ? 0 : setOperation ? currentRows.length : 1,
    })
    : undefined;
  const changeSet = capability.kind === "proposal" ? buildChangeSet({
    config: input.config,
    capability,
    args: input.args,
    context,
    sourceName: capability.source,
    source,
    currentRow: current.row,
    currentRows,
    batchItems,
    itemPatches,
    patch,
    proposalId,
    createdAt,
    resolvedDeduplication,
    evidenceBundleId,
    queryFingerprint,
    objectId,
    freshness: freshnessCapture?.authority,
  }) : undefined;
  await input.store.recordEvidenceBundle({
    evidence_bundle_id: evidenceBundleId,
    tenant_id: context.tenant_id,
    payload: {
      capability: capability.name,
      source_id: capability.source,
      target: `${capability.target.schema}.${capability.target.table}`,
      principal: context.principal,
      tenant_id: context.tenant_id,
      source_database_changed: false,
      binding_provenance: context.provenance,
      ...(principalScopeMetadata ? { principal_scope: principalScopeMetadata } : {}),
    },
    items: setOperation
      ? boundedSetEvidenceItems(capability, context, operation, currentRows, itemPatches, batchItems)
      : [{
        kind: capability.kind === "proposal" && operation === "insert" ? "reviewed_insert_intent" : "external_row",
        source_id: capability.source,
        table: `${capability.target.schema}.${capability.target.table}`,
        primary_key: { column: capability.target.primary_key, value: objectId },
        tenant: capability.target.tenant_key ? { column: capability.target.tenant_key, value: context.tenant_id } : undefined,
        ...(principalScopeMetadata ? { principal_scope: principalScopeMetadata } : {}),
        visible_row: capability.kind === "proposal" && operation === "insert" ? patch : visibleScalarRecord(capability, current.row),
        ...(resolvedDeduplication ? { deduplication: resolvedDeduplication } : {}),
      }],
  });
  if (capability.kind !== "proposal" || operation !== "insert") {
    await input.store.recordQueryAudit({
      evidence_bundle_id: evidenceBundleId,
      source_id: capability.source,
      query_fingerprint: queryFingerprint,
      table_name: `${capability.target.schema}.${capability.target.table}`,
      row_count: current.rowCount,
      payload: {
        capability: capability.name,
        columns: capability.visible_columns,
        binding_provenance: context.provenance,
        tenant_bound: Boolean(capability.target.tenant_key),
        principal_bound: Boolean(principalScope),
        ...(principalScopeMetadata ? { principal_scope: principalScopeMetadata } : {}),
        statement_template: selectTemplate(capability),
        parameters_redacted: true,
      },
    });
  }
  for (const supporting of freshnessCapture?.evidence ?? []) {
    await input.store.recordEvidenceBundle({
      evidence_bundle_id: supporting.bundle_id,
      tenant_id: context.tenant_id,
      capability: supporting.capability.name,
      source_id: supporting.capability.source,
      source_table: `${supporting.capability.target.schema}.${supporting.capability.target.table}`,
      business_object: supporting.capability.target.table,
      object_id: String(supporting.primary_key.value),
      query_fingerprint: supporting.query_fingerprint,
      payload: {
        kind: "freshness_dependency",
        dependency_id: supporting.dependency_id,
        capability: supporting.capability.name,
        source_id: supporting.capability.source,
        target: `${supporting.capability.target.schema}.${supporting.capability.target.table}`,
        parameters_redacted: true,
        source_database_changed: false,
      },
      items: [],
    });
    await input.store.recordQueryAudit({
      evidence_bundle_id: supporting.bundle_id,
      capability: supporting.capability.name,
      source_id: supporting.capability.source,
      query_fingerprint: supporting.query_fingerprint,
      table_name: `${supporting.capability.target.schema}.${supporting.capability.target.table}`,
      business_object: supporting.capability.target.table,
      object_id: String(supporting.primary_key.value),
      primary_key_value: String(supporting.primary_key.value),
      row_count: 1,
      payload: {
        kind: "freshness_dependency",
        dependency_id: supporting.dependency_id,
        capability: supporting.capability.name,
        columns: [supporting.version_column],
        parameters_redacted: true,
        tenant_bound: Boolean(supporting.capability.target.tenant_key),
        principal_bound: Boolean(supporting.capability.target.principal_scope_key),
      },
    });
  }

  if (capability.kind === "read") {
    return {
      status: "ok",
      action: capability.name,
      mode: input.config.mode,
      business_object: {
        type: capability.target.table,
        id: objectId,
      },
      data: visibleScalarRecord(capability, current.row),
      trusted_context: {
        tenant_id: context.tenant_id,
        principal: context.principal,
        provenance: context.provenance,
      },
      evidence_bundle_id: evidenceBundleId,
      evidence_resource: `synapsor://evidence/${evidenceBundleId}`,
      source_database_changed: false,
      source_database_mutated: false,
    };
  }

  if (!changeSet) throw new McpRuntimeError("PROPOSAL_CHANGE_SET_MISSING", "Proposal change set was not constructed.");
  const activeProposal = await input.store.findActiveProposal({
    tenant_id: context.tenant_id,
    action: capability.name,
    business_object: capability.target.table,
    object_id: objectId,
  });
  if (activeProposal) throw proposalAlreadyExists(activeProposal);
  let proposal: StoredProposal;
  try {
    proposal = await input.store.createProposal(changeSet);
  } catch (error) {
    if (error instanceof ProposalStoreError && error.code === "PROPOSAL_ALREADY_EXISTS") {
      const existing = await input.store.findActiveProposal({
        tenant_id: context.tenant_id,
        action: capability.name,
        business_object: capability.target.table,
        object_id: objectId,
      });
      if (existing) throw proposalAlreadyExists(existing);
    }
    throw error;
  }
  const approvalResult = input.config.governance?.mode === "cloud_linked"
    ? { proposal, approved: false }
    : await maybeAutoApproveProposal({
      config: input.config,
      capability,
      store: input.store,
      proposal,
      patch: changeSet.patch,
      env: input.env,
      readRow: input.readRow,
    });
  await input.store.recordEvidenceBundle({
    evidence_bundle_id: evidenceBundleId,
    proposal_id: proposal.proposal_id,
    tenant_id: context.tenant_id,
    payload: {
      capability: capability.name,
      proposal_id: proposal.proposal_id,
      source_database_changed: false,
      approval_status: approvalResult.proposal.state === "approved" ? "approved" : changeSet.approval.status,
      ...(principalScopeMetadata ? { principal_scope: principalScopeMetadata } : {}),
    },
    items: [
      {
        kind: "proposal_evidence",
        before: changeSet.before,
        patch: changeSet.patch,
        after: changeSet.after,
      },
    ],
  });
  if (operation !== "insert") {
    await input.store.recordQueryAudit({
      proposal_id: proposal.proposal_id,
      evidence_bundle_id: evidenceBundleId,
      source_id: capability.source,
      query_fingerprint: queryFingerprint,
      table_name: `${capability.target.schema}.${capability.target.table}`,
      row_count: current.rowCount,
      payload: {
        capability: capability.name,
        statement_template: selectTemplate(capability),
        parameters_redacted: true,
        principal_bound: Boolean(principalScope),
        ...(principalScopeMetadata ? { principal_scope: principalScopeMetadata } : {}),
      },
    });
  }

  let supervisedWorker:
    | {
      status: "queued";
      mode: "supervised_worker";
      capability: string;
      contract_digest: `sha256:${string}`;
    }
    | undefined;
  if (
    input.config.governance?.mode !== "cloud_linked"
    && approvalResult.proposal.state === "approved"
  ) {
    const eligibility = resolveSupervisedWorkerEligibility(input.config, capability, { phase: "queue" });
    if (eligibility.eligible && eligibility.policy && eligibility.contract_digest) {
      if (!input.store.enqueueWorkerProposal) {
        throw new McpRuntimeError(
          "SUPERVISED_WORKER_LEDGER_REQUIRED",
          "Supervised execution requires a durable worker queue in the authoritative proposal store.",
        );
      }
      await input.store.enqueueWorkerProposal({
        proposal_id: approvalResult.proposal.proposal_id,
        execution_mode: "supervised_worker",
        contract_digest: eligibility.contract_digest,
        max_attempts: eligibility.policy.max_attempts,
        queue_limit: eligibility.policy.queue_limit,
      });
      supervisedWorker = {
        status: "queued",
        mode: "supervised_worker",
        capability: capability.name,
        contract_digest: eligibility.contract_digest,
      };
    }
  }

  await enqueueCloudLinkedProposal({
    config: input.config,
    store: input.store,
    proposal: approvalResult.proposal,
    evidenceBundleId,
    queryFingerprint,
    env: input.env,
  });

  return {
    status: input.config.governance?.mode === "cloud_linked"
      ? "pending_cloud_sync"
      : input.config.mode === "shadow"
        ? "shadow_proposal_created"
        : approvalResult.freshness?.status === "stale"
          ? "freshness_conflict"
        : supervisedWorker
          ? "queued_for_trusted_execution"
        : approvalResult.proposal.state === "approved"
          ? "approved"
          : "review_required",
    action: capability.name,
    proposal_id: approvalResult.proposal.proposal_id,
    proposal_version: approvalResult.proposal.proposal_version,
    proposal_hash: approvalResult.proposal.proposal_hash,
    target: {
      type: capability.target.table,
      id: objectId,
      tenant_id: context.tenant_id,
    },
    diff: diffFromChangeSet(changeSet),
    evidence_bundle_id: evidenceBundleId,
    evidence_resource: `synapsor://evidence/${evidenceBundleId}`,
    proposal_resource: `synapsor://proposals/${proposal.proposal_id}`,
    replay_resource: `synapsor://replay/replay_${proposal.proposal_id}`,
    approval: approvalResult.approved
      ? { mode: "policy", policy: approvalResult.policy }
      : {
        mode: capability.approval?.mode ?? "human",
        ...(capability.approval?.policy ? { policy: capability.approval.policy } : {}),
        ...(capability.approval?.required_role ? { required_role: capability.approval.required_role } : {}),
        ...(approvalResult.tripped_limits?.length ? {
          fallback: "human_review",
          tripped_limits: approvalResult.tripped_limits,
        } : {}),
      },
    approval_required: approvalResult.proposal.state === "pending_review",
    ...(approvalResult.freshness ? { freshness: approvalResult.freshness } : {}),
    governance: input.config.governance?.mode === "cloud_linked"
      ? { authority: "synapsor_cloud", state: "pending_cloud_sync", evidence_residency: "metadata_only" }
      : { authority: "local" },
    writeback: changeSet.writeback,
    ...(supervisedWorker ? {
      execution: {
        ...supervisedWorker,
        approval_source: "policy_auto",
        model_can_approve_or_apply: false,
      },
    } : {}),
    source_database_changed: false,
    source_database_mutated: false,
  };
}
