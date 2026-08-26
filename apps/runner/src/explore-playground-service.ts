import {
  ScopedExploreError,
  type ScopedExploreRuntime,
  type ScopedExploreValidationResult,
} from "./scoped-explore.js";
import type { ScopedExploreBoundarySetRuntime } from "./scoped-explore-boundary-set.js";

export type ExplorePlaygroundRuntime =
  | ScopedExploreRuntime
  | ScopedExploreBoundarySetRuntime;

export type ExplorePlaygroundRequest = {
  plan: Record<string, unknown>;
  boundary?: string;
};

export function normalizeExplorePlaygroundRequest(
  input: unknown,
  explicitBoundary?: string,
): ExplorePlaygroundRequest {
  if (!isRecord(input)) {
    throw new ScopedExploreError(
      "EXPLORE_PLAN_INVALID",
      "Explore Plan Playground input must be one JSON object containing a plan or the MCP envelope {\"plan\":{...},\"boundary\":\"optional\"}.",
    );
  }

  if (Object.hasOwn(input, "plan")) {
    const unknownKeys = Object.keys(input).filter((key) => key !== "plan" && key !== "boundary");
    if (unknownKeys.length > 0) {
      throw new ScopedExploreError(
        "EXPLORE_PLAN_INVALID",
        `Explore Plan Playground MCP envelope contains unsupported key(s): ${unknownKeys.join(", ")}. Only plan and optional boundary are accepted.`,
      );
    }
    if (!isRecord(input.plan)) {
      throw new ScopedExploreError(
        "EXPLORE_PLAN_INVALID",
        "Explore Plan Playground envelope plan must be one JSON object.",
      );
    }
    const documentBoundary = optionalBoundary(input.boundary);
    if (documentBoundary && explicitBoundary && documentBoundary !== explicitBoundary) {
      throw new ScopedExploreError(
        "EXPLORE_BOUNDARY_REQUIRED",
        `The plan document selects boundary ${documentBoundary}, but --boundary selects ${explicitBoundary}. Choose one exact active boundary.`,
      );
    }
    return {
      plan: input.plan,
      ...(explicitBoundary || documentBoundary
        ? { boundary: explicitBoundary ?? documentBoundary }
        : {}),
    };
  }

  return {
    plan: input,
    ...(explicitBoundary ? { boundary: explicitBoundary } : {}),
  };
}

export async function validateExplorePlaygroundRequest(
  runtime: ExplorePlaygroundRuntime,
  request: ExplorePlaygroundRequest,
): Promise<ScopedExploreValidationResult & {
  active_boundary_set_digest?: `sha256:${string}`;
}> {
  return isBoundarySetRuntime(runtime)
    ? runtime.validate(request.plan, request.boundary)
    : runtime.validate(request.plan);
}

export async function runExplorePlaygroundRequest(
  runtime: ExplorePlaygroundRuntime,
  request: ExplorePlaygroundRequest,
): Promise<Record<string, unknown>> {
  return isBoundarySetRuntime(runtime)
    ? runtime.explore(request.plan, request.boundary)
    : runtime.explore(request.plan);
}

export function describeExplorePlaygroundScope(
  runtime: ExplorePlaygroundRuntime,
): {
  tenant: { source: string; binding: string };
  principal: { source: string; binding?: string };
  raw_values_exposed: false;
} | undefined {
  if (!runtime.trusted_scope) return undefined;
  return {
    tenant: { ...runtime.trusted_scope.tenant },
    principal: { ...runtime.trusted_scope.principal },
    raw_values_exposed: false,
  };
}

function optionalBoundary(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(value)) {
    throw new ScopedExploreError(
      "EXPLORE_PLAN_INVALID",
      "Explore Plan Playground boundary must be one exact active boundary name.",
    );
  }
  return value;
}

function isBoundarySetRuntime(
  runtime: ExplorePlaygroundRuntime,
): runtime is ScopedExploreBoundarySetRuntime {
  return "active_boundary_set_digest" in runtime;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
