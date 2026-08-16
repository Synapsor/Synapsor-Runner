import { describe, expect, it } from "vitest";
import {
  explorationBoundaryCandidateDigest,
  type ActivatedExplorationBoundary,
  type ExplorationBoundaryDraft,
  type GenerationLock,
} from "./auto-boundary.js";
import { classifyBoundaryRevisionState } from "./boundary-revision-state.js";

describe("saved boundary revision state", () => {
  it("does not report database drift for an unrelated lock change or resource reordering", () => {
    const activeCandidate = candidate("sha256:old-lock", ["public.orders", "public.customers"]);
    const active = activate(activeCandidate);
    const rebased = candidate("sha256:new-lock", ["public.customers", "public.orders"]);

    expect(classifyBoundaryRevisionState({
      candidate: rebased,
      active,
      currentLock: lock("sha256:schema", "sha256:role"),
      activeLock: lock("sha256:schema", "sha256:role"),
    })).toEqual({ matches_active_authority: true });
  });

  it("keeps genuine schema and role posture drift fail-closed and clears it after reversion", () => {
    const reviewed = candidate("sha256:active-lock", ["public.orders"]);
    const active = activate(reviewed);
    const activeLock = lock("sha256:schema-a", "sha256:role-a");

    expect(classifyBoundaryRevisionState({
      candidate: reviewed,
      active,
      currentLock: lock("sha256:schema-b", "sha256:role-a"),
      activeLock,
    })).toEqual({
      matches_active_authority: false,
      cause: "database_posture_changed",
    });
    expect(classifyBoundaryRevisionState({
      candidate: reviewed,
      active,
      currentLock: lock("sha256:schema-a", "sha256:role-b"),
      activeLock,
    })).toEqual({
      matches_active_authority: false,
      cause: "database_posture_changed",
    });
    expect(classifyBoundaryRevisionState({
      candidate: reviewed,
      active,
      currentLock: activeLock,
      activeLock,
    })).toEqual({ matches_active_authority: true });
  });

  it("still reports a real reviewed access edit when database posture is unchanged", () => {
    const reviewed = candidate("sha256:active-lock", ["public.orders"]);
    const active = activate(reviewed);
    const edited = structuredClone(reviewed);
    edited.pack.resources[0]!.minimum_cohort_size = 2;

    expect(classifyBoundaryRevisionState({
      candidate: edited,
      active,
      currentLock: lock("sha256:schema", "sha256:role"),
      activeLock: lock("sha256:schema", "sha256:role"),
    })).toEqual({
      matches_active_authority: false,
      cause: "reviewed_access_edited",
    });
  });
});

function candidate(
  generationLock: `sha256:${string}`,
  resourceOrder: string[],
): ExplorationBoundaryDraft {
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "staging",
    source: "app_postgres",
    compiler_version: "1.6.6",
    spec_version: "1.8.0",
    trusted_context: {
      provider: "environment",
      tenant_env: "TENANT_ID",
    },
    generation_lock_fingerprint: generationLock,
    role_posture_fingerprint: "sha256:role",
    pack: {
      schema_version: "synapsor.authoring-pack.v1",
      name: "reviewed_staging",
      resources: resourceOrder.map(resource),
    },
    budgets: {
      max_rows_per_query: 25,
      max_groups_per_query: 25,
      max_candidate_groups_per_query: 500,
      max_cells_per_response: 250,
      max_bytes_per_response: 32_768,
      max_queries_per_session: 100,
      max_extracted_cells_per_session: 2_500,
      max_differencing_queries: 5,
      rate_limit_per_minute: 30,
    },
    unresolved_decisions: [],
  } as unknown as ExplorationBoundaryDraft;
}

function resource(id: string): ExplorationBoundaryDraft["pack"]["resources"][number] {
  const [schema, table] = id.split(".");
  return {
    id,
    schema,
    table,
    primary_key: "id",
    selectable_fields: ["id", "status"],
    filterable_fields: { status: ["eq", "neq", "in"] },
    sortable_fields: ["id", "status"],
    groupable_fields: ["status"],
    aggregate_measures: [],
    count_distinct_fields: ["id"],
    time_bucket_fields: {},
    field_types: { id: "integer", status: "text" },
    field_enums: { status: ["open", "closed"] },
    kept_out_fields: [],
    tenant_key: "organization_id",
    minimum_cohort_size: 5,
    suppression_aware_totals: true,
    relationships: [],
  } as unknown as ExplorationBoundaryDraft["pack"]["resources"][number];
}

function activate(candidate: ExplorationBoundaryDraft): ActivatedExplorationBoundary {
  const { activation: _activation, unresolved_decisions: _unresolved, ...authority } = candidate;
  return {
    ...authority,
    activation: {
      state: "active",
      digest: explorationBoundaryCandidateDigest(candidate),
      actor: "operator",
      activated_at: "2026-08-07T00:00:00.000Z",
      generation_lock_fingerprint: candidate.generation_lock_fingerprint,
      reviewed_decisions: [],
    },
  } as ActivatedExplorationBoundary;
}

function lock(
  schema: `sha256:${string}`,
  role: `sha256:${string}`,
): Pick<GenerationLock, "schema_fingerprint" | "role_posture_fingerprint"> {
  return {
    schema_fingerprint: schema,
    role_posture_fingerprint: role,
  };
}
