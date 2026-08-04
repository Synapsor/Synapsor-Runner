import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  explorationBoundaryCandidateDigest,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import { resolvePendingBoundaryReviewSummary } from "./ask-authority.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    fs.rm(root, { recursive: true, force: true })));
});

describe("Ask authority summaries", () => {
  it("distinguishes an inactive draft, an exact active revision, and later disabled edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-authority-"));
    roots.push(root);
    await fs.mkdir(path.join(root, ".synapsor"), { recursive: true });
    const candidate = boundaryCandidate();

    await writeLibrary(root, candidate);
    await expect(resolvePendingBoundaryReviewSummary(root)).resolves.toEqual({
      boundary_name: "reviewed_staging",
      pending_changes: 1,
      previous_authority_active: false,
    });

    const activeDigest = explorationBoundaryCandidateDigest(candidate);
    await fs.writeFile(
      path.join(root, ".synapsor/exploration-boundary.active.json"),
      JSON.stringify({
        pack: candidate.pack,
        activation: { digest: activeDigest },
      }),
    );
    await expect(resolvePendingBoundaryReviewSummary(root)).resolves.toBeUndefined();

    const edited = structuredClone(candidate);
    edited.pack.resources[0]!.minimum_cohort_size = 1;
    edited.pack.resources[0]!.minimum_cohort_overridden = true;
    await writeLibrary(root, edited);
    await expect(resolvePendingBoundaryReviewSummary(root)).resolves.toEqual({
      boundary_name: "reviewed_staging",
      pending_changes: 1,
      previous_authority_active: true,
    });
  });
});

async function writeLibrary(
  root: string,
  candidate: ExplorationBoundaryDraft,
): Promise<void> {
  await fs.writeFile(
    path.join(root, ".synapsor/boundary-library.json"),
    JSON.stringify({
      selected_name: "reviewed_staging",
      boundaries: {
        reviewed_staging: { candidate },
      },
    }),
  );
}

function boundaryCandidate(): ExplorationBoundaryDraft {
  return {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "disabled_unreviewed",
    deployment_profile: "development",
    source: "source",
    compiler_version: "test",
    spec_version: "test",
    reporting_timezone: "UTC",
    trusted_context: {
      provider: "environment",
      tenant_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
    },
    generation_lock_fingerprint: `sha256:${"a".repeat(64)}`,
    role_posture_fingerprint: `sha256:${"b".repeat(64)}`,
    pack: {
      name: "reviewed_staging",
      resources: [{
        id: "public.orders",
        schema: "public",
        table: "orders",
        primary_key: "id",
        tenant_key: "organization_id",
        field_types: { id: "text", organization_id: "text" },
        field_enums: {},
        selectable_fields: ["id"],
        filterable_fields: { id: ["eq"] },
        sortable_fields: ["id"],
        groupable_fields: [],
        aggregate_measures: [],
        count_distinct_fields: ["id"],
        time_bucket_fields: {},
        kept_out_fields: ["organization_id"],
        relationships: [],
        minimum_cohort_size: 5,
        suppression_aware_totals: true,
      }],
    },
    budgets: {
      max_rows: 10,
      max_groups: 10,
      max_top_n: 10,
      max_measures: 2,
      max_dimensions: 2,
      max_time_ranges: 2,
      max_relationship_hops: 1,
      max_response_cells: 100,
      max_response_bytes: 10_000,
      statement_timeout_ms: 1_000,
      max_complexity: 10,
      max_queries_per_session: 10,
      max_extracted_cells_per_session: 1_000,
      max_differencing_queries: 3,
      rate_limit_per_minute: 10,
    },
    unresolved_decisions: [],
  };
}
