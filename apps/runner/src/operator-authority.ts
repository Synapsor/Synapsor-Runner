import { type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { envValue } from "./cli-options.js";
import { RunnerCapabilityConfig } from "./cli-runtime.js";


export function trustedCliContext(config: RuntimeConfig, capability: RunnerCapabilityConfig, env: NodeJS.ProcessEnv): { tenant_id: string; principal: string } {
  const context = capability.context ? config.contexts?.[capability.context] : config.trusted_context;
  if (!context) throw new Error(`TRUSTED_CONTEXT_MISSING: capability ${capability.name} has no trusted context`);
  const values = context.values ?? {};
  if (context.provider !== "environment" && context.provider !== "static_dev") throw new Error(`TRUSTED_CONTEXT_UNAVAILABLE: ${context.provider} requires a verified MCP/Cloud session and cannot authorize a local CLI revert`);
  const tenantEnv = String(values.tenant_id_env ?? "SYNAPSOR_TENANT_ID");
  const principalEnv = String(values.principal_env ?? "SYNAPSOR_PRINCIPAL");
  const tenant = context.provider === "environment"
    ? envValue(env, tenantEnv)
    : envValue(env, tenantEnv) ?? (typeof values.tenant_id === "string" ? values.tenant_id.trim() : undefined);
  const principal = context.provider === "environment"
    ? envValue(env, principalEnv)
    : envValue(env, principalEnv) ?? (typeof values.principal === "string" ? values.principal.trim() : undefined);
  if (!tenant || !principal) throw new Error(`TRUSTED_BINDING_MISSING: ${tenantEnv} and ${principalEnv} must resolve before creating a revert proposal`);
  return { tenant_id: tenant, principal };
}


export type TrustedOperatorDecisionOverride = {
  actor?: string;
  identity?: string;
  privateKeyPath?: string;
  reason?: string;
  identityToken?: string;
};


export type TrustedOperatorInvocation = {
  decision?: TrustedOperatorDecisionOverride;
  freshnessProofDigest?: string;
  /** Binds a TUI/Workbench decision to the exact proposal the operator reviewed. */
  expectedProposalHash?: string;
  quiet?: boolean;
};
