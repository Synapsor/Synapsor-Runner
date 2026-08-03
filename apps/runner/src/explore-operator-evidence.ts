import {
  loadActivatedExplorationBoundary,
  loadGenerationLockForActivatedBoundary,
  type ActivatedExplorationBoundary,
} from "./auto-boundary.js";
import {
  compileExplorePlan,
  validateExplorePlan,
  type ExplorePlan,
} from "./scoped-explore.js";

export type OperatorCompiledExploreEvidence = {
  engine: "postgres" | "mysql";
  boundary_name: string;
  boundary_digest: `sha256:${string}`;
  trusted_scope: {
    tenant: string;
    principal: string;
    values_included: false;
  };
  role_posture: {
    status: "verified_before_execution";
    fingerprint: `sha256:${string}`;
  };
  transaction: "single_read_only_transaction";
  statements: Array<{
    statement: string;
    parameter_types: string[];
    parameter_values: "redacted";
    period?: "period_1" | "period_2";
  }>;
  model_received_sql: false;
  persisted: false;
};

/**
 * Produces a local operator diagnostic from reviewed artifacts only. It never
 * executes the statement and never returns parameter values.
 */
export async function inspectCompiledExplorePlan(input: {
  projectRoot: string;
  boundaryDigest: `sha256:${string}`;
  plan: ExplorePlan;
}): Promise<OperatorCompiledExploreEvidence> {
  const boundary = await loadActivatedExplorationBoundary(input.projectRoot, {
    digest: input.boundaryDigest,
  });
  const lock = await loadGenerationLockForActivatedBoundary(input.projectRoot, boundary);
  return compileOperatorExploreEvidence({
    boundary,
    engine: lock.engine,
    plan: input.plan,
  });
}

export function compileOperatorExploreEvidence(input: {
  boundary: ActivatedExplorationBoundary;
  engine: "postgres" | "mysql";
  plan: ExplorePlan;
}): OperatorCompiledExploreEvidence {
  const { boundary } = input;
  const plan = validateExplorePlan(input.plan, boundary);
  const statements = compileExplorePlan(
    plan,
    boundary,
    {
      tenant: "<trusted-tenant>",
      principal: "<trusted-principal>",
    },
    input.engine,
  ).map((query) => ({
    statement: query.sql,
    parameter_types: query.params.map(parameterType),
    parameter_values: "redacted" as const,
    ...(query.period ? { period: query.period } : {}),
  }));
  return {
    engine: input.engine,
    boundary_name: boundary.pack.name,
    boundary_digest: boundary.activation.digest,
    trusted_scope: {
      tenant: boundary.trusted_context.database_role_tenant
        ? `PostgreSQL role setting ${boundary.trusted_context.database_role_tenant.setting}`
        : `environment binding ${boundary.trusted_context.tenant_env}`,
      principal: boundary.pack.resources.some((resource) => Boolean(resource.principal_key))
        ? `environment binding ${boundary.trusted_context.principal_env}`
        : "not required by this boundary",
      values_included: false,
    },
    role_posture: {
      status: "verified_before_execution",
      fingerprint: boundary.role_posture_fingerprint,
    },
    transaction: "single_read_only_transaction",
    statements,
    model_received_sql: false,
    persisted: false,
  };
}

function parameterType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  return "string";
}
