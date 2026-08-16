import { loadRuntimeConfigFromFile } from "@synapsor-runner/mcp-server";
import {
  CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
  type ConfiguredTrustedContextAuthority,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import { resolveSynapsorProject } from "./project-resolution.js";

export function configuredTrustedContextFromBoundary(
  candidate: ExplorationBoundaryDraft,
): ConfiguredTrustedContextAuthority {
  return candidate.trusted_context.provider === "http_claims"
    ? {
        schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
        provider: "http_claims",
        ...(candidate.trusted_context.tenant_claim
          ? { tenant_claim: candidate.trusted_context.tenant_claim }
          : {}),
        principal_claim: candidate.trusted_context.principal_claim,
      }
    : {
        schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
        provider: "environment",
        tenant_env: candidate.trusted_context.tenant_env,
        principal_env: candidate.trusted_context.principal_env,
      };
}

function optionalConfigString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function resolveConfiguredTrustedContextAuthority(input: {
  projectRoot: string;
  sourceEnv: string;
  candidate: ExplorationBoundaryDraft;
  fallbackAuthority?: ConfiguredTrustedContextAuthority;
}): Promise<ConfiguredTrustedContextAuthority> {
  const fallback = structuredClone(
    input.fallbackAuthority ?? configuredTrustedContextFromBoundary(input.candidate),
  );
  const project = await resolveSynapsorProject(input.projectRoot, process.env);
  if (!project) return fallback;
  const config = loadRuntimeConfigFromFile(project.config_path);
  const source = config.sources?.[input.candidate.source]
    ?? Object.values(config.sources ?? {}).find((item) => item.read_url_env === input.sourceEnv);
  if (!source || source.read_url_env !== input.sourceEnv) {
    throw new Error(
      `Runner config ${project.config_path} does not contain reviewed source ${input.candidate.source} using ${input.sourceEnv}.`,
    );
  }
  const context = config.trusted_context;
  if (!context) return fallback;
  const tenantBinding = optionalConfigString(context.tenant_binding);
  const principalBinding = optionalConfigString(context.principal_binding);
  if (context.provider === "environment") {
    if (input.candidate.deployment_profile === "production") {
      throw new Error(
        "The Runner config now uses trusted_context.provider=environment, but this reviewed boundary is production HTTP. Create or select a non-production boundary instead of changing its trust provider in place.",
      );
    }
    const values = context.values ?? {};
    return {
      schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
      provider: "environment",
      ...(tenantBinding ? { tenant_binding: tenantBinding } : {}),
      ...(principalBinding ? { principal_binding: principalBinding } : {}),
      tenant_env: optionalConfigString(values.tenant_id_env) ?? fallback.tenant_env
        ?? "SYNAPSOR_TENANT_ID",
      principal_env: optionalConfigString(values.principal_env) ?? fallback.principal_env
        ?? "SYNAPSOR_PRINCIPAL",
    };
  }
  if (context.provider === "http_claims") {
    if (input.candidate.deployment_profile !== "production") {
      throw new Error(
        "The Runner config now uses trusted_context.provider=http_claims, but this reviewed boundary is local/staging. Create a separately reviewed production boundary; provider changes cannot silently convert deployment profiles.",
      );
    }
    const tenantClaim = input.candidate.organization_scope
      ? undefined
      : optionalConfigString(config.session_auth?.tenant_claim)
        ?? fallback.tenant_claim
        ?? "tenant_id";
    const principalClaim = optionalConfigString(config.session_auth?.principal_claim)
      ?? fallback.principal_claim
      ?? "sub";
    return {
      schema_version: CONFIGURED_TRUSTED_CONTEXT_AUTHORITY_VERSION,
      provider: "http_claims",
      ...(tenantBinding ? { tenant_binding: tenantBinding } : {}),
      ...(principalBinding ? { principal_binding: principalBinding } : {}),
      ...(tenantClaim ? { tenant_claim: tenantClaim } : {}),
      principal_claim: principalClaim,
    };
  }
  throw new Error(
    `Scoped Explore reconciliation does not accept trusted_context.provider=${context.provider}; use environment locally or http_claims for production HTTP.`,
  );
}
