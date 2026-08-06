import { Pool } from "pg";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import type {
  ActivatedExplorationBoundary,
  ExplorationBoundaryDraft,
  GenerationLock,
} from "./auto-boundary.js";

type ExploreBoundary = ExplorationBoundaryDraft | ActivatedExplorationBoundary;

export type ExploreTrustedScope = {
  tenant: string;
  principal: string;
  tenant_source: "environment" | "postgres_role_setting" | "verified_http_claim";
  tenant_binding: string;
  principal_source: "environment" | "verified_http_claim" | "not_required";
  principal_binding?: string;
};

export type ExploreHttpSessionContext = {
  tenant_id: string;
  principal: string;
  provenance: "http_claims";
};

export class ExploreTrustedScopeError extends Error {
  constructor(
    message: string,
    public readonly missingBindings: string[] = [],
  ) {
    super(message);
    this.name = "ExploreTrustedScopeError";
  }
}

export type ReadPostgresRoleSetting = (input: {
  databaseUrl: string;
  setting: string;
}) => Promise<{ currentUser: string; value: string | undefined }>;

export async function resolveExploreTrustedScope(input: {
  boundary: ExploreBoundary;
  lock: GenerationLock;
  inspection: SchemaInspection;
  env: NodeJS.ProcessEnv;
  sessionContext?: ExploreHttpSessionContext;
  readPostgresRoleSetting?: ReadPostgresRoleSetting;
}): Promise<ExploreTrustedScope> {
  if (input.boundary.trusted_context.provider === "http_claims") {
    if (input.boundary.deployment_profile !== "production") {
      throw new ExploreTrustedScopeError("Verified HTTP claim bindings are only valid for a reviewed production Explore boundary.");
    }
    const tenant = normalizedScopeValue(input.sessionContext?.tenant_id);
    const principal = normalizedScopeValue(input.sessionContext?.principal);
    if (input.sessionContext?.provenance !== "http_claims" || !tenant || !principal) {
      throw new ExploreTrustedScopeError(
        "Production Explore requires a verified tenant and principal on every HTTP session.",
        [input.boundary.trusted_context.tenant_claim, input.boundary.trusted_context.principal_claim],
      );
    }
    return {
      tenant,
      principal,
      tenant_source: "verified_http_claim",
      tenant_binding: input.boundary.trusted_context.tenant_claim,
      principal_source: "verified_http_claim",
      principal_binding: input.boundary.trusted_context.principal_claim,
    };
  }
  const principalRequired = input.boundary.pack.resources.some((resource) =>
    typeof resource.principal_key === "string" && resource.principal_key.length > 0);
  const configuredTenant = input.env[input.boundary.trusted_context.tenant_env]?.trim();
  const configuredPrincipal = input.env[input.boundary.trusted_context.principal_env]?.trim();
  if (principalRequired && !configuredPrincipal) {
    throw new ExploreTrustedScopeError(
      `Scoped Explore requires trusted ${input.boundary.trusted_context.principal_env} outside model arguments.`,
      [input.boundary.trusted_context.principal_env],
    );
  }
  if (configuredTenant) {
    return {
      tenant: configuredTenant,
      principal: configuredPrincipal ?? "",
      tenant_source: "environment",
      tenant_binding: input.boundary.trusted_context.tenant_env,
      principal_source: principalRequired ? "environment" : "not_required",
      ...(principalRequired ? { principal_binding: input.boundary.trusted_context.principal_env } : {}),
    };
  }

  const roleTenant = input.boundary.trusted_context.database_role_tenant;
  if (!roleTenant) {
    throw new ExploreTrustedScopeError(
      `Scoped Explore requires trusted ${input.boundary.trusted_context.tenant_env} outside model arguments.`,
      [input.boundary.trusted_context.tenant_env],
    );
  }
  assertRoleBoundTenantAuthority(input.boundary, input.inspection, roleTenant.setting);
  const databaseUrl = input.env[input.lock.source_env];
  if (!databaseUrl) {
    throw new ExploreTrustedScopeError(`Scoped Explore database source ${input.lock.source_env} is not configured.`);
  }
  const resolved = await (input.readPostgresRoleSetting ?? readPostgresRoleSetting)({
    databaseUrl,
    setting: roleTenant.setting,
  }).catch(() => {
    throw new ExploreTrustedScopeError(
      "The read-only PostgreSQL credential does not provide the reviewed tenant scope. Configure that credential's RLS session setting or an operator-owned tenant binding.",
    );
  });
  if (resolved.currentUser !== input.inspection.current_user) {
    throw new ExploreTrustedScopeError("The credential used to resolve tenant scope differs from the inspected database role.");
  }
  const tenant = normalizedScopeValue(resolved.value);
  if (!tenant) {
    throw new ExploreTrustedScopeError(
      "The read-only PostgreSQL credential does not provide the reviewed tenant scope. Configure that credential's RLS session setting or an operator-owned tenant binding.",
    );
  }
  return {
    tenant,
    principal: configuredPrincipal ?? "",
    tenant_source: "postgres_role_setting",
    tenant_binding: roleTenant.setting,
    principal_source: principalRequired ? "environment" : "not_required",
    ...(principalRequired ? { principal_binding: input.boundary.trusted_context.principal_env } : {}),
  };
}

function assertRoleBoundTenantAuthority(
  boundary: ExploreBoundary,
  inspection: SchemaInspection,
  setting: string,
): void {
  if (inspection.engine !== "postgres" || !/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(setting)) {
    throw new ExploreTrustedScopeError("The reviewed database-role tenant binding is not valid for this source.");
  }
  const role = inspection.role_posture;
  if (!role?.verified || !role.read_only || role.superuser !== false || role.bypass_rls !== false) {
    throw new ExploreTrustedScopeError("Database-role tenant scope requires a verified read-only, non-owner, non-superuser, non-BYPASSRLS credential.");
  }
  const tables = new Map(inspection.tables.map((table) => [`${table.schema}.${table.name}`, table]));
  for (const resource of boundary.pack.resources) {
    const table = tables.get(resource.id);
    if (resource.rls_session?.tenant_setting !== setting
      || table?.row_level_security !== true
      || table.role_posture?.row_security_effective_for_current_role !== true) {
      throw new ExploreTrustedScopeError(
        `Database-role tenant scope is not proven by the reviewed RLS policy for ${resource.id}.`,
      );
    }
  }
}

async function readPostgresRoleSetting(input: {
  databaseUrl: string;
  setting: string;
}): Promise<{ currentUser: string; value: string | undefined }> {
  const pool = new Pool({
    connectionString: input.databaseUrl,
    max: 1,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 1000,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = 3000");
    const result = await client.query<{ current_user: string; setting_value: string | null }>(
      "SELECT current_user::text AS current_user, current_setting($1, true)::text AS setting_value",
      [input.setting],
    );
    await client.query("ROLLBACK");
    const row = result.rows[0];
    return {
      currentUser: row?.current_user ?? "",
      value: row?.setting_value ?? undefined,
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

function normalizedScopeValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 1024 || /[\u0000\r\n]/.test(normalized)) return undefined;
  return normalized;
}
