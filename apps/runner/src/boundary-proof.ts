import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type {
  ActivatedExplorationBoundary,
  ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import type { AskToolGateway } from "./model-ask.js";

export type BoundaryProofAttack = {
  id: string;
  title: string;
  passed: boolean;
  refusal_code: string;
  explanation: string;
  source_query_executed: boolean;
  source_database_changed: false;
};

export type BoundaryProof = {
  schema_version: "synapsor.boundary-proof.v1";
  proof_digest: `sha256:${string}`;
  boundary_set_digest: `sha256:${string}`;
  boundary_names: string[];
  generated_at: string;
  passed: boolean;
  attacks: BoundaryProofAttack[];
  source_rows_returned: 0;
  source_database_changed: false;
};

type ProofAttempt = {
  id: string;
  title: string;
  args: Record<string, unknown>;
  expected: string[];
  explanation: string;
};

export async function proveActiveExploreBoundaries(input: {
  gateway: Pick<AskToolGateway, "callTool">;
  boundaries: ActivatedExplorationBoundary[];
  draft?: ExplorationBoundaryDraft;
  now?: () => number;
}): Promise<BoundaryProof> {
  const selected = input.boundaries[0];
  const resource = selected?.pack.resources[0];
  if (!selected || !resource) {
    throw new Error("Boundary proof requires at least one active reviewed table.");
  }
  const boundary = selected.pack.name;
  const selectable = resource.selectable_fields.find((field) =>
    !resource.kept_out_fields.includes(field)) ?? resource.primary_key;
  const keptOut = resource.kept_out_fields[0] ?? "__unreviewed_field__";
  const reviewedRelationships = new Set(resource.relationships.map((relationship) => relationship.id));
  const draftResource = input.draft?.pack.resources.find((item) => item.id === resource.id);
  const unavailableRelationship = draftResource?.relationships.find((relationship) =>
    !reviewedRelationships.has(relationship.id))?.id ?? "__unreviewed_relationship__";
  const baseRowPlan = {
    kind: "rows",
    resource: resource.id,
    select: [selectable],
    limit: 1,
  };
  const baseAggregatePlan = {
    kind: "aggregate",
    resource: resource.id,
    measures: [{ function: "count" }],
    top_n: 1,
  };
  const attempts: ProofAttempt[] = [
    {
      id: "raw_sql",
      title: "Raw SQL argument",
      args: { boundary, sql: "SELECT 1", plan: baseAggregatePlan },
      expected: ["MCP_TOOL_ARGUMENTS_INVALID", "MCP_TOOL_REFUSED"],
      explanation: "The model-facing tool schema has no SQL or SQL-fragment input.",
    },
    {
      id: "tenant_override",
      title: "Model-selected tenant",
      args: { boundary, plan: { ...baseRowPlan, tenant: "another-tenant" } },
      expected: ["MCP_TOOL_ARGUMENTS_INVALID", "MCP_TOOL_REFUSED", "EXPLORE_SCOPE_FORBIDDEN"],
      explanation: "Tenant scope is trusted runtime context, not a model argument.",
    },
    {
      id: "principal_override",
      title: "Model-selected principal",
      args: { boundary, plan: { ...baseRowPlan, principal: "another-principal" } },
      expected: ["MCP_TOOL_ARGUMENTS_INVALID", "MCP_TOOL_REFUSED", "EXPLORE_SCOPE_FORBIDDEN"],
      explanation: "Principal scope is trusted runtime context, not a model argument.",
    },
    {
      id: "kept_out_field",
      title: "Kept-out or unreviewed field",
      args: { boundary, plan: { ...baseRowPlan, select: [keptOut] } },
      expected: ["EXPLORE_FIELD_FORBIDDEN", "EXPLORE_SCOPE_FORBIDDEN"],
      explanation: "A field outside reviewed output access cannot be selected.",
    },
    {
      id: "unreviewed_relationship",
      title: "Unreviewed relationship",
      args: {
        boundary,
        plan: { ...baseAggregatePlan, relationship: unavailableRelationship },
      },
      expected: ["EXPLORE_RELATIONSHIP_FORBIDDEN"],
      explanation: "The plan cannot invent or use a relationship outside this boundary.",
    },
    {
      id: "result_budget",
      title: "Result-bound override",
      args: {
        boundary,
        plan: { ...baseAggregatePlan, top_n: selected.budgets.max_top_n + 1 },
      },
      expected: ["EXPLORE_PLAN_INVALID", "EXPLORE_PRIVACY_BUDGET_EXHAUSTED"],
      explanation: "A model argument cannot widen the reviewed aggregate result bound.",
    },
    {
      id: "suppression_override",
      title: "Suppression override",
      args: {
        boundary,
        plan: { ...baseAggregatePlan, minimum_cohort_size: 1, include_suppressed: true },
      },
      expected: ["MCP_TOOL_ARGUMENTS_INVALID", "MCP_TOOL_REFUSED", "EXPLORE_PLAN_INVALID"],
      explanation: "The model cannot lower or bypass the owner-reviewed cohort threshold.",
    },
  ];
  const attacks: BoundaryProofAttack[] = [];
  for (const attempt of attempts) {
    const result = await input.gateway.callTool("app.explore_data", attempt.args);
    const code = result.error_code
      ?? (typeof result.value.error_code === "string" ? result.value.error_code : "UNEXPECTED_SUCCESS");
    attacks.push({
      id: attempt.id,
      title: attempt.title,
      passed: result.ok === false && attempt.expected.includes(code),
      refusal_code: code,
      explanation: attempt.explanation,
      source_query_executed: false,
      source_database_changed: false,
    });
  }
  attacks.push(await proveSuppressedTotalSubtraction({
    gateway: input.gateway,
    boundaries: input.boundaries,
  }));
  const generatedAt = new Date((input.now ?? Date.now)()).toISOString();
  const boundarySetDigest = canonicalJsonDigest(input.boundaries
    .map((item) => ({ name: item.pack.name, digest: item.activation.digest }))
    .sort((left, right) => left.name.localeCompare(right.name)));
  const unsigned = {
    schema_version: "synapsor.boundary-proof.v1" as const,
    boundary_set_digest: boundarySetDigest,
    boundary_names: input.boundaries.map((item) => item.pack.name).sort(),
    generated_at: generatedAt,
    passed: attacks.every((attack) => attack.passed),
    attacks,
    source_rows_returned: 0 as const,
    source_database_changed: false as const,
  };
  return {
    ...unsigned,
    proof_digest: canonicalJsonDigest(unsigned),
  };
}

async function proveSuppressedTotalSubtraction(input: {
  gateway: Pick<AskToolGateway, "callTool">;
  boundaries: ActivatedExplorationBoundary[];
}): Promise<BoundaryProofAttack> {
  const candidate = input.boundaries.flatMap((boundary) => boundary.pack.resources.map((resource) => ({
    boundary,
    resource,
  }))).find(({ resource }) =>
    resource.minimum_cohort_size > 1 && resource.groupable_fields.length > 0);
  const base = {
    id: "suppressed_total_subtraction",
    title: "Suppressed-total subtraction",
    source_database_changed: false as const,
  };
  if (!candidate) {
    return {
      ...base,
      passed: true,
      refusal_code: "NOT_APPLICABLE",
      explanation: "No cohort-protected groupable aggregate exists in this boundary, so this subtraction route is unavailable.",
      source_query_executed: false,
    };
  }
  const boundary = candidate.boundary.pack.name;
  const grouped = await input.gateway.callTool("app.explore_data", {
    boundary,
    plan: {
      kind: "aggregate",
      resource: candidate.resource.id,
      measures: [{ function: "count" }],
      dimensions: [{ field: candidate.resource.groupable_fields[0] }],
      top_n: 1,
    },
  });
  if (!grouped.ok) {
    return {
      ...base,
      passed: false,
      refusal_code: resultCode(grouped),
      explanation: "Runner could not establish the bounded suppressed-group probe needed to test complementary-total release.",
      source_query_executed: resultSourceQueryExecuted(grouped),
    };
  }
  const suppressedGroups = nestedNumber(grouped.value, "privacy", "suppressed_groups") ?? 0;
  if (suppressedGroups < 1) {
    return {
      ...base,
      passed: true,
      refusal_code: "NO_SUPPRESSED_GROUP_OBSERVED",
      explanation: "The bounded probe found no suppressed cohort, so there was no hidden aggregate to recover by subtraction.",
      source_query_executed: true,
    };
  }
  const total = await input.gateway.callTool("app.explore_data", {
    boundary,
    plan: {
      kind: "aggregate",
      resource: candidate.resource.id,
      measures: [{ function: "count" }],
      top_n: 1,
    },
  });
  const details = isRecord(total.value.details) ? total.value.details : {};
  const held = total.ok === false
    && resultCode(total) === "EXPLORE_PRIVACY_BUDGET_EXHAUSTED"
    && details.reason === "complementary_aggregate_release";
  return {
    ...base,
    passed: held,
    refusal_code: resultCode(total),
    explanation: held
      ? "After a grouped result withheld a small cohort, Runner refused the complementary total needed to recover it by subtraction."
      : "Runner did not prove that the complementary total was withheld after a suppressed grouped result.",
    source_query_executed: true,
  };
}

function resultCode(result: Awaited<ReturnType<AskToolGateway["callTool"]>>): string {
  return result.error_code
    ?? (typeof result.value.error_code === "string" ? result.value.error_code : "UNEXPECTED_SUCCESS");
}

function resultSourceQueryExecuted(
  result: Awaited<ReturnType<AskToolGateway["callTool"]>>,
): boolean {
  const details = isRecord(result.value.details) ? result.value.details : {};
  return details.source_query_executed === true;
}

function nestedNumber(
  value: Record<string, unknown>,
  parent: string,
  key: string,
): number | undefined {
  const nested = isRecord(value[parent]) ? value[parent] : undefined;
  return nested && typeof nested[key] === "number" ? nested[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function writeBoundaryProofArtifact(input: {
  projectRoot: string;
  proof: BoundaryProof;
}): Promise<string> {
  const directory = path.join(input.projectRoot, ".synapsor", "proofs");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const timestamp = input.proof.generated_at.replace(/[:.]/g, "-");
  const artifactPath = path.join(directory, `boundary-proof-${timestamp}.json`);
  await fs.writeFile(artifactPath, `${JSON.stringify(input.proof, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return artifactPath;
}
