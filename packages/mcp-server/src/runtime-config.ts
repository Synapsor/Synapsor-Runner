import fs from "node:fs";
import path from "node:path";
import {
  assertValidRunnerCapabilityConfig,
} from "@synapsor-runner/config";
import {
  canonicalJsonDigest,
} from "@synapsor-runner/protocol";
import {
  normalizeContract,
  type AgentContextSpec,
  type CapabilitySpec,
  type ResourceSpec,
  type SynapsorContract,
} from "@synapsor/spec";
import type {
  RuntimeCapabilityConfig,
  RuntimeConfig,
  IsolationAssuranceMode,
  SourceIsolationAssurance,
} from "./runtime-types.js";
import {
  trustedContextBindingMode,
  trustedContextProvidersForSource,
} from "./capability-authority.js";

/**
 * Describes deployment assurance without changing portable contract semantics.
 * This is intentionally derived from local Runner wiring, never model input.
 */
export function describeIsolationAssurance(config: RuntimeConfig): SourceIsolationAssurance[] {
  return Object.entries(config.sources ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceName, source]) => {
      const providers = trustedContextProvidersForSource(config, sourceName);
      const requestBinding = trustedContextBindingMode(providers);
      const databaseScope = source.database_scope?.mode ?? "application";
      const credentialScope = source.credential_scope?.mode ?? "shared";
      const mode: IsolationAssuranceMode = credentialScope === "tenant_resolver"
        ? "tenant_bound"
        : databaseScope === "postgres_rls"
          ? "postgres_rls"
          : "application_scope";
      const controls = [
        "runner_predicates",
        ...(databaseScope === "postgres_rls" ? ["postgres_rls"] : []),
        ...(credentialScope === "tenant_resolver" ? ["tenant_credential_resolver"] : []),
      ];

      if (mode === "tenant_bound") {
        return {
          source: sourceName,
          engine: source.engine,
          mode,
          database_scope: databaseScope,
          credential_scope: credentialScope,
          trusted_context: { providers, request_binding: requestBinding },
          controls,
          protects_against: [
            "model_scope_override",
            "runner_query_predicate_defect",
            "pooled_context_leakage",
            "cross_tenant_process_authority_when_resolver_grants_are_correct",
          ],
          does_not_protect_against: [
            "incorrect_credential_resolver_or_database_grants",
            "compromised_selected_tenant_credential",
            "compromised_database_administrator",
          ],
          remaining_trust_boundary: "The application-supplied resolver and database grants must ensure the selected credential has no authority over other tenants.",
        };
      }

      if (mode === "postgres_rls") {
        return {
          source: sourceName,
          engine: source.engine,
          mode,
          database_scope: databaseScope,
          credential_scope: credentialScope,
          trusted_context: { providers, request_binding: requestBinding },
          controls,
          protects_against: [
            "model_scope_override",
            "runner_query_predicate_defect",
            "pooled_context_leakage",
          ],
          does_not_protect_against: [
            "compromised_runner_selecting_arbitrary_rls_context",
            "broad_credential_compromise",
            "compromised_database_administrator",
          ],
          remaining_trust_boundary: "A fully compromised Runner holding a broad credential can still choose arbitrary transaction-local RLS context.",
        };
      }

      const sharedHttp = requestBinding === "verified_http_session";
      return {
        source: sourceName,
        engine: source.engine,
        mode,
        database_scope: databaseScope,
        credential_scope: credentialScope,
        trusted_context: { providers, request_binding: requestBinding },
        controls,
        protects_against: [
          "model_scope_override",
          "forged_model_tool_arguments",
        ],
        does_not_protect_against: [
          "runner_query_predicate_defect",
          "broad_credential_compromise",
          "compromised_runner_process",
          "compromised_database_administrator",
        ],
        remaining_trust_boundary: "Runner query construction and the shared database credential remain inside the tenant-isolation trust boundary.",
        ...(sharedHttp ? {
          warning: "Shared authenticated HTTP sessions use application-level scope only. Add PostgreSQL RLS or tenant-bound credentials for an independent database/process boundary.",
        } : {}),
      };
    });
}

export function loadRuntimeConfigFromFile(
  configPath = process.env.SYNAPSOR_MCP_CONFIG || "synapsor.runner.json",
): RuntimeConfig {
  const resolved = path.resolve(configPath);
  const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
  const config = resolveRuntimeConfig(parsed as RuntimeConfig, path.dirname(resolved));
  assertValidRunnerCapabilityConfig(config);
  return config;
}

export function resolveRuntimeConfig(config: RuntimeConfig, baseDir = process.cwd()): RuntimeConfig {
  const governance = config.governance?.connection_file
    ? { ...config.governance, connection_file: path.resolve(baseDir, config.governance.connection_file) }
    : config.governance;
  const generatedAuthority = config.generated_authority?.generation_lock_path
    ? { ...config.generated_authority, generation_lock_path: path.resolve(baseDir, config.generated_authority.generation_lock_path) }
    : config.generated_authority;
  if (!Array.isArray(config.contracts) || config.contracts.length === 0) {
    if (governance === config.governance && generatedAuthority === config.generated_authority) return config;
    return {
      ...config,
      ...(governance ? { governance } : {}),
      ...(generatedAuthority ? { generated_authority: generatedAuthority } : {}),
    };
  }
  const seenCapabilities = new Map<string, string>();
  const seenPolicies = new Map<string, string>();
  for (const [index, capability] of (config.capabilities ?? []).entries()) {
    rememberCapabilityName(seenCapabilities, capability.name, `embedded capabilities[${index}]`);
  }
  for (const [index, policy] of (config.policies ?? []).entries()) {
    rememberPolicyName(seenPolicies, policy.name, `embedded policies[${index}]`);
  }
  const resolved: RuntimeConfig = {
    ...config,
    ...(governance ? { governance } : {}),
    ...(generatedAuthority ? { generated_authority: generatedAuthority } : {}),
    contexts: { ...(config.contexts ?? {}) },
    capabilities: [...(config.capabilities ?? [])],
    policies: [...(config.policies ?? [])],
  };
  for (const [contractIndex, contractPath] of config.contracts.entries()) {
    const fullPath = path.resolve(baseDir, contractPath);
    const contract = normalizeContract(JSON.parse(fs.readFileSync(fullPath, "utf8")));
    mergeContractIntoRuntimeConfig(resolved, contract, `contracts[${contractIndex}] ${contractPath}`, seenCapabilities, seenPolicies);
  }
  delete resolved.contracts;
  return resolved;
}

export function rememberCapabilityName(seen: Map<string, string>, name: string, origin: string): void {
  const previous = seen.get(name);
  if (previous) {
    throw new Error(`Duplicate capability ${name}: ${origin} conflicts with ${previous}. Capability names must be unique across embedded runner config and referenced contracts.`);
  }
  seen.set(name, origin);
}

export function rememberPolicyName(seen: Map<string, string>, name: string, origin: string): void {
  const previous = seen.get(name);
  if (previous) {
    throw new Error(`Duplicate policy ${name}: ${origin} conflicts with ${previous}. Policy names must be unique across embedded runner config and referenced contracts.`);
  }
  seen.set(name, origin);
}

export function mergeContractIntoRuntimeConfig(config: RuntimeConfig, contract: SynapsorContract, origin: string, seenCapabilities: Map<string, string>, seenPolicies: Map<string, string>): void {
  const resources = new Map((contract.resources ?? []).map((resource) => [resource.name, resource]));
  const provenance = {
    digest: canonicalJsonDigest(contract),
    version: contract.metadata?.version ?? contract.spec_version,
  };
  for (const context of contract.contexts) {
    if (!config.contexts) config.contexts = {};
    config.contexts[context.name] ??= runtimeContextFromSpec(context);
  }
  if (!config.trusted_context && contract.contexts.length === 1) {
    const [context] = contract.contexts;
    if (context) config.trusted_context = runtimeContextFromSpec(context);
  }
  if (!config.capabilities) config.capabilities = [];
  for (const [capabilityIndex, capability] of contract.capabilities.entries()) {
    rememberCapabilityName(seenCapabilities, capability.name, `${origin} capabilities[${capabilityIndex}]`);
    config.capabilities.push(runtimeCapabilityFromSpec(capability, resources, config, provenance));
  }
  if (contract.policies?.length) {
    if (!config.policies) config.policies = [];
    for (const [policyIndex, policy] of contract.policies.entries()) {
      rememberPolicyName(seenPolicies, policy.name, `${origin} policies[${policyIndex}]`);
      config.policies.push(policy);
    }
  }
}

export function runtimeContextFromSpec(context: AgentContextSpec): NonNullable<RuntimeConfig["contexts"]>[string] {
  const unsupportedSessionBinding = context.bindings.find((binding) => binding.source === "session");
  if (unsupportedSessionBinding) {
    throw new Error(
      `SESSION_BINDING_UNSUPPORTED: context ${context.name} binding ${unsupportedSessionBinding.name} uses canonical SESSION source, but Synapsor Runner has no generic web-session trust provider. Use ENVIRONMENT for local stdio, HTTP_CLAIM for verified HTTP JWT claims, or CLOUD_SESSION for verified Cloud-linked identity.`,
    );
  }
  const tenantBinding = context.bindings.find((binding) => binding.name === context.tenant_binding) ?? context.bindings.find((binding) => binding.name === "tenant_id");
  const principalBinding = context.bindings.find((binding) => binding.name === context.principal_binding) ?? context.bindings.find((binding) => binding.name === "principal");
  const provider = context.bindings.some((binding) => binding.source === "environment") ? "environment"
    : context.bindings.some((binding) => binding.source === "cloud_session") ? "cloud_session"
      : context.bindings.some((binding) => binding.source === "http_claim") ? "http_claims"
        : context.bindings.some((binding) => binding.source === "static_dev") ? "static_dev"
          : (() => { throw new Error(`TRUSTED_CONTEXT_BINDING_UNSUPPORTED: context ${context.name} has no binding source supported by Synapsor Runner.`); })();
  return {
    provider,
    tenant_binding: context.tenant_binding,
    principal_binding: context.principal_binding,
    values: {
      ...(tenantBinding ? { tenant_id_env: tenantBinding.key, tenant_id_key: tenantBinding.key } : {}),
      ...(principalBinding ? { principal_env: principalBinding.key, principal_key: principalBinding.key } : {}),
    },
  };
}

export function runtimeCapabilityFromSpec(
  capability: CapabilitySpec,
  resources: Map<string, ResourceSpec>,
  config: RuntimeConfig,
  provenance: { digest: `sha256:${string}`; version: string },
): RuntimeCapabilityConfig {
  const subjectResource = capability.subject.resource ? resources.get(capability.subject.resource) : undefined;
  const source = resolveCapabilitySource(capability, config);
  const target = {
    schema: subjectResource?.schema ?? capability.subject.schema ?? "",
    table: subjectResource?.table ?? capability.subject.table ?? "",
    primary_key: subjectResource?.primary_key ?? capability.subject.primary_key ?? "",
    tenant_key: subjectResource?.tenant_key ?? capability.subject.tenant_key,
    principal_scope_key: capability.subject.principal_scope_key,
    single_tenant_dev: subjectResource?.single_tenant_dev ?? capability.subject.single_tenant_dev,
  };
  const runtime: RuntimeCapabilityConfig = {
    name: capability.name,
    kind: capability.kind === "proposal" ? "proposal" : capability.kind === "aggregate_read" ? "aggregate_read" : "read",
    contract_provenance: provenance,
    ...(capability.description ? { description: capability.description } : {}),
    ...(capability.returns_hint ? { returns_hint: capability.returns_hint } : {}),
    source,
    context: capability.context,
    target,
    args: capability.args,
    lookup: capability.lookup ?? { id_from_arg: Object.keys(capability.args)[0] ?? "id" },
    visible_columns: capability.visible_fields,
    ...(capability.kept_out_fields ? { kept_out_fields: capability.kept_out_fields } : {}),
    ...(capability.model_withheld_fields
      ? { model_withheld_fields: capability.model_withheld_fields }
      : {}),
    evidence: capability.evidence?.required === false ? "optional" : "required",
    ...(capability.max_rows ? { max_rows: capability.max_rows } : {}),
    ...(capability.aggregate ? { aggregate: capability.aggregate } : {}),
    ...(capability.protected_read ? { protected_read: capability.protected_read } : {}),
  };
  if (capability.kind === "proposal" && capability.proposal) {
    runtime.patch = capability.proposal.patch;
    runtime.allowed_columns = capability.proposal.allowed_fields;
    runtime.numeric_bounds = capability.proposal.numeric_bounds;
    runtime.transition_guards = capability.proposal.transition_guards;
    runtime.reversibility = capability.proposal.reversibility;
    runtime.operation = capability.proposal.operation;
    runtime.conflict_guard = capability.proposal.conflict_guard;
    runtime.approval = capability.proposal.approval;
    runtime.execution = capability.proposal.execution;
    runtime.writeback = {
      mode: capability.proposal.writeback?.mode ?? "direct_sql",
      ...(capability.proposal.writeback?.executor ? { executor: capability.proposal.writeback.executor } : {}),
    };
    if (capability.proposal.writeback?.executor) {
      runtime.executor = capability.proposal.writeback.executor;
    }
  }
  return runtime;
}

export function resolveCapabilitySource(capability: CapabilitySpec, config: RuntimeConfig): string {
  if (capability.source) return capability.source;
  const sourceNames = Object.keys(config.sources ?? {});
  if (sourceNames.length === 1 && sourceNames[0]) return sourceNames[0];
  throw new Error(`contract capability ${capability.name} must set source when runner config has ${sourceNames.length} sources`);
}
