import type {
  ContextProvider,
  RuntimeWritebackMode,
  RuntimeCapabilityConfig,
  SupervisedWorkerEligibility,
  RuntimeConfig,
  TrustedContextBindingMode,
} from "./runtime-types.js";

export function resolveSupervisedWorkerEligibility(
  config: RuntimeConfig,
  capability: RuntimeCapabilityConfig,
  options: { workerIdentity?: string; phase?: "queue" | "execute" } = {},
): SupervisedWorkerEligibility {
  const reasons: string[] = [];
  const deployment = config.supervised_worker;
  const digest = capability.contract_provenance?.digest;
  if (!deployment?.enabled) reasons.push("deployment_disabled");
  if (config.mode !== "review") reasons.push("review_mode_required");
  if (config.governance?.mode === "cloud_linked") reasons.push("cloud_linked_local_execution_forbidden");
  if (capability.kind !== "proposal") reasons.push("proposal_capability_required");
  if (capability.execution?.supervised_worker !== "allowed") reasons.push("contract_permission_missing");
  if (!digest) reasons.push("active_contract_digest_missing");
  const policy = digest
    ? deployment?.capabilities.find((entry) =>
      entry.capability === capability.name
      && entry.contract_digest === digest
      && entry.mode === "supervised_worker")
    : undefined;
  if (!policy) reasons.push("deployment_allowlist_mismatch");
  if (
    options.phase !== "queue"
    && policy?.worker_identity
    && policy.worker_identity !== options.workerIdentity
  ) {
    reasons.push("worker_identity_mismatch");
  }

  const source = config.sources?.[capability.source];
  if (!source || source.read_only === true || !source.write_url_env) {
    reasons.push("writable_source_unavailable");
  } else {
    if (policy && policy.write_url_env !== source.write_url_env) reasons.push("writer_reference_mismatch");
    if (!source.receipts) reasons.push("receipt_authority_missing");
  }
  if (!capability.target.tenant_key) reasons.push("trusted_tenant_scope_missing");
  if (capability.writeback?.mode !== "direct_sql") reasons.push("direct_sql_required");
  if ((capability.operation?.cardinality ?? "single") !== "single") reasons.push("single_row_required");
  const operation = capability.operation?.kind ?? "update";
  if (operation === "delete") reasons.push("delete_ineligible");
  if (capability.reversibility) reasons.push("reversibility_ineligible");
  if (operation === "update"
    && (!capability.conflict_guard?.column || capability.conflict_guard.weak_guard_ack === true)) {
    reasons.push("exact_conflict_guard_required");
  }
  if (operation === "insert" && !capability.operation?.deduplication?.components.length) {
    reasons.push("insert_deduplication_required");
  }

  const uniqueReasons = [...new Set(reasons)];
  return {
    eligible: uniqueReasons.length === 0,
    code: uniqueReasons.length === 0 ? "SUPERVISED_WORKER_ELIGIBLE" : uniqueReasons[0]!.toUpperCase(),
    reasons: uniqueReasons,
    capability: capability.name,
    ...(digest ? { contract_digest: digest } : {}),
    ...(deployment ? { profile: deployment.profile } : {}),
    ...(policy ? { policy } : {}),
  };
}

export function trustedContextProvidersForSource(config: RuntimeConfig, sourceName: string): ContextProvider[] {
  const providers = new Set<ContextProvider>();
  for (const capability of config.capabilities ?? []) {
    if (capability.source !== sourceName) continue;
    const context = capability.context ? config.contexts?.[capability.context] : config.trusted_context;
    if (context?.provider) providers.add(context.provider);
  }
  if (providers.size === 0 && config.trusted_context?.provider) {
    providers.add(config.trusted_context.provider);
  }
  return [...providers].sort();
}

export function trustedContextBindingMode(providers: ContextProvider[]): TrustedContextBindingMode {
  if (providers.length === 0) return "missing";
  if (providers.every((provider) => provider === "reviewed_organization")) return "reviewed_fixed_scope";
  if (providers.every((provider) => provider === "http_claims")) return "verified_http_session";
  if (providers.every((provider) => provider === "cloud_session")) return "verified_external_session";
  if (providers.every((provider) => provider === "environment" || provider === "static_dev")) return "process_bound";
  return "mixed";
}

export function localCapabilities(config: RuntimeConfig): RuntimeCapabilityConfig[] {
  return Array.isArray(config.capabilities) ? config.capabilities : [];
}

export function listedLocalCapabilities(config: RuntimeConfig): RuntimeCapabilityConfig[] {
  const capabilities = localCapabilities(config);
  if (config.mode === "read_only") return capabilities.filter((capability) =>
    capability.kind === "read" || capability.kind === "aggregate_read");
  return capabilities;
}

export function capabilityWritebackMode(capability: RuntimeCapabilityConfig): RuntimeWritebackMode {
  const mode = capability.writeback?.mode;
  if (mode === "direct_sql" || mode === "app_handler" || mode === "cloud_worker" || mode === "none") return mode;
  if (capability.executor && capability.executor !== "sql_update") return "app_handler";
  return "direct_sql";
}

export function capabilityWritebackExecutor(capability: RuntimeCapabilityConfig): string | undefined {
  return capability.writeback?.executor ?? capability.executor;
}

export function readColumns(capability: RuntimeCapabilityConfig): string[] {
  if (capability.kind === "aggregate_read") return [
    ...(capability.aggregate?.column ? [capability.aggregate.column] : []),
    ...(capability.aggregate?.selection?.all ?? []).map((term) => term.column),
    ...(capability.target.tenant_key ? [capability.target.tenant_key] : []),
    ...(capability.target.principal_scope_key ? [capability.target.principal_scope_key] : []),
  ];
  const columns = new Set(capability.visible_columns);
  columns.add(capability.target.primary_key);
  if (capability.target.tenant_key) columns.add(capability.target.tenant_key);
  if (capability.target.principal_scope_key) columns.add(capability.target.principal_scope_key);
  if (capability.conflict_guard?.column) columns.add(capability.conflict_guard.column);
  for (const term of capability.operation?.selection?.all ?? []) columns.add(term.column);
  for (const bound of capability.operation?.aggregate_bounds ?? []) columns.add(bound.column);
  return Array.from(columns);
}

export function isSetCapability(capability: RuntimeCapabilityConfig): boolean {
  return capability.kind === "proposal" && capability.operation?.cardinality === "set";
}

export function isSetSelectionCapability(capability: RuntimeCapabilityConfig): boolean {
  return isSetCapability(capability) && capability.operation?.kind !== "insert";
}
