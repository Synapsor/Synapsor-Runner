import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  explorationBoundaryCandidateDigest,
  type ActivatedExplorationBoundary,
  type ExplorationBoundaryDraft,
  type GenerationLock,
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
      changes: [{
        boundary_name: "reviewed_staging",
        previous_authority_active: false,
        cause: "reviewed_access_edited",
      }],
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
      changes: [{
        boundary_name: "reviewed_staging",
        previous_authority_active: true,
        cause: "reviewed_access_edited",
      }],
    });
  });

  it("finds unselected pending boundaries without inferring database drift from a lock digest alone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-authority-all-"));
    roots.push(root);
    await fs.mkdir(path.join(root, ".synapsor"), { recursive: true });
    const selected = boundaryCandidate();
    const other = boundaryCandidate();
    other.pack.name = "subscription_boundary";
    other.generation_lock_fingerprint = `sha256:${"c".repeat(64)}`;
    await fs.writeFile(
      path.join(root, ".synapsor/boundary-library.json"),
      JSON.stringify({
        selected_name: "reviewed_staging",
        boundaries: {
          reviewed_staging: { candidate: selected },
          subscription_boundary: { candidate: other },
        },
      }),
    );
    await fs.writeFile(
      path.join(root, ".synapsor/exploration-boundaries.active.json"),
      JSON.stringify({
        schema_version: "synapsor.active-exploration-boundaries.v1",
        selected_name: "reviewed_staging",
        boundaries: [{
          ...selected,
          activation: { digest: explorationBoundaryCandidateDigest(selected) },
        }, {
          ...other,
          generation_lock_fingerprint: `sha256:${"d".repeat(64)}`,
          activation: { digest: `sha256:${"e".repeat(64)}` },
        }],
      }),
    );

    await expect(resolvePendingBoundaryReviewSummary(root)).resolves.toEqual({
      boundary_name: "subscription_boundary",
      pending_changes: 1,
      previous_authority_active: true,
      changes: [{
        boundary_name: "subscription_boundary",
        previous_authority_active: true,
        cause: "reviewed_access_edited",
      }],
    });
  });

  it("keeps boundary A clean when activating B changes only lock evidence and clears reverted drift", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-authority-multi-boundary-"));
    roots.push(root);
    await fs.mkdir(path.join(root, ".synapsor/exploration-locks"), { recursive: true });

    const lockA = generationLock("1", "a", "b", "c");
    const lockB = generationLock("1", "a", "d", "e");
    const lockADigest = canonicalJsonDigest(lockA);
    const lockBDigest = canonicalJsonDigest(lockB);
    const reviewedA = boundaryCandidate();
    reviewedA.generation_lock_fingerprint = lockADigest;
    const activeA = activateBoundary(reviewedA);
    const rebasedA = structuredClone(reviewedA);
    rebasedA.generation_lock_fingerprint = lockBDigest;
    const boundaryB = boundaryCandidate();
    boundaryB.pack.name = "subscription_boundary";
    boundaryB.pack.resources[0]!.id = "public.subscriptions";
    boundaryB.pack.resources[0]!.schema = "public";
    boundaryB.pack.resources[0]!.table = "subscriptions";
    boundaryB.generation_lock_fingerprint = lockBDigest;
    const activeB = activateBoundary(boundaryB);

    await writeGenerationLock(root, lockA);
    await writeGenerationLock(root, lockB);
    await writeActiveSet(root, [activeA, activeB]);
    await writeMultiBoundaryLibrary(root, rebasedA, boundaryB);
    await expect(resolvePendingBoundaryReviewSummary(root)).resolves.toBeUndefined();

    const driftedLock = generationLock("2", "a", "f", "0");
    const driftedDigest = canonicalJsonDigest(driftedLock);
    const driftedA = structuredClone(rebasedA);
    const driftedB = structuredClone(boundaryB);
    driftedA.generation_lock_fingerprint = driftedDigest;
    driftedB.generation_lock_fingerprint = driftedDigest;
    await writeGenerationLock(root, driftedLock);
    await writeMultiBoundaryLibrary(root, driftedA, driftedB);
    await expect(resolvePendingBoundaryReviewSummary(root)).resolves.toMatchObject({
      pending_changes: 2,
      changes: [
        { boundary_name: "reviewed_staging", cause: "database_posture_changed" },
        { boundary_name: "subscription_boundary", cause: "database_posture_changed" },
      ],
    });

    await fs.writeFile(
      path.join(root, ".synapsor/generation-lock.json"),
      `${JSON.stringify(lockB, null, 2)}\n`,
      "utf8",
    );
    await writeMultiBoundaryLibrary(root, rebasedA, boundaryB);
    await expect(resolvePendingBoundaryReviewSummary(root)).resolves.toBeUndefined();
  });

  it("does not mislabel the initial Quick Start staging review as a user edit", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-authority-instant-"));
    roots.push(root);
    await fs.mkdir(path.join(root, ".synapsor"), { recursive: true });
    const candidate = boundaryCandidate();
    candidate.deployment_profile = "staging";
    await writeLibrary(root, candidate, 1);
    await fs.writeFile(
      path.join(root, ".synapsor/guided-onboarding.json"),
      JSON.stringify({
        status: "boundary_active",
        instant_onboarding: true,
      }),
    );
    await fs.writeFile(
      path.join(root, ".synapsor/exploration-boundary.active.json"),
      JSON.stringify({
        ...candidate,
        deployment_profile: "development",
        generation_lock_fingerprint: candidate.generation_lock_fingerprint,
        activation: { digest: `sha256:${"c".repeat(64)}` },
      }),
    );

    await expect(resolvePendingBoundaryReviewSummary(root)).resolves.toBeUndefined();

    await writeLibrary(root, candidate, 2);
    await expect(resolvePendingBoundaryReviewSummary(root)).resolves.toMatchObject({
      pending_changes: 1,
      changes: [{ cause: "reviewed_access_edited" }],
    });
  });

  it("attaches only the rescan report for the exact pending candidate digest", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-ask-authority-rescan-"));
    roots.push(root);
    await fs.mkdir(path.join(root, ".synapsor"), { recursive: true });
    const activeCandidate = boundaryCandidate();
    const pendingCandidate = structuredClone(activeCandidate);
    pendingCandidate.pack.resources[0]!.field_types.new_status = "text";
    pendingCandidate.pack.resources[0]!.kept_out_fields.push("new_status");
    await writeLibrary(root, pendingCandidate);
    await fs.writeFile(
      path.join(root, ".synapsor/exploration-boundary.active.json"),
      JSON.stringify(activateBoundary(activeCandidate)),
    );
    const pendingDigest = explorationBoundaryCandidateDigest(pendingCandidate);
    await fs.writeFile(
      path.join(root, ".synapsor/boundary-rescan-report.json"),
      JSON.stringify({
        schema_version: "synapsor.boundary-rescan-report.v1",
        generated_at: "2026-08-08T00:00:00.000Z",
        engine: "postgres",
        source_env: "DATABASE_URL",
        previous_schema_fingerprint: `sha256:${"1".repeat(64)}`,
        schema_fingerprint: `sha256:${"2".repeat(64)}`,
        previous_role_posture_fingerprint: `sha256:${"3".repeat(64)}`,
        role_posture_fingerprint: `sha256:${"3".repeat(64)}`,
        schema_changed: true,
        role_posture_changed: false,
        changed: true,
        source_database_changed: false,
        totals: {},
        boundaries: [{
          boundary_id: "bnd_test",
          boundary_name: "reviewed_staging",
          deployment_profile: "development",
          previous_candidate_digest: explorationBoundaryCandidateDigest(activeCandidate),
          candidate_digest: pendingDigest,
          kept_confirmations: 0,
          preserved_authority: {
            resources: 1,
            reviewed_paths: 2,
            field_policies: 5,
          },
          safely_carried_confirmations: [],
          invalidated_decisions: [],
          retained_resources: ["public.orders"],
          removed_resources: [],
          newly_available_resources: [],
          newly_available_fields: [{ resource_id: "public.orders", field: "new_status" }],
          removed_fields: [],
          changed_field_types: [],
          newly_available_relationships: [{
            resource_id: "public.order_items",
            relationship_id: "order_items_order_fkey__orders_customer_fkey",
            target_resource: "public.customers",
            path_depth: 2,
            path_links: [
              {
                source_resource: "public.order_items",
                target_resource: "public.orders",
                source_columns: ["order_id"],
              },
              {
                source_resource: "public.orders",
                target_resource: "public.customers",
                source_columns: ["customer_id"],
              },
            ],
          }],
          removed_relationships: [],
          newly_proven_value_allowlists: [{
            resource_id: "public.orders",
            field: "status",
            value_count: 4,
          }],
          pruned_review_inputs: [],
        }],
      }),
    );

    await expect(resolvePendingBoundaryReviewSummary(root)).resolves.toMatchObject({
      changes: [{
        reconciliation: {
          kept_decisions: 0,
          preserved_authority: {
            resources: 1,
            reviewed_paths: 2,
            field_policies: 5,
          },
          decisions_requiring_review: 0,
          details: [
            "public.orders.new_status: new column is kept out until reviewed",
            "public.order_items: new relationship is available to review (2 hops)\n    order_items -> orders -> customers\n    via columns: order_id -> customer_id\n    path ID: order_items_order_fkey__orders_customer_fkey",
            "public.orders.status: an enforced schema vocabulary now narrows existing filter/group authority to 4 reviewed values; confirm field permissions, then activate",
          ],
        },
      }],
    });

    pendingCandidate.pack.resources[0]!.kept_out_fields.push("another_field");
    pendingCandidate.pack.resources[0]!.field_types.another_field = "text";
    await writeLibrary(root, pendingCandidate);
    const laterSummary = await resolvePendingBoundaryReviewSummary(root);
    expect(laterSummary).not.toHaveProperty("changes.0.reconciliation");
  });
});

async function writeLibrary(
  root: string,
  candidate: ExplorationBoundaryDraft,
  revision?: number,
): Promise<void> {
  await fs.writeFile(
    path.join(root, ".synapsor/boundary-library.json"),
    JSON.stringify({
      selected_name: "reviewed_staging",
      boundaries: {
        reviewed_staging: { candidate, ...(revision === undefined ? {} : { revision }) },
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

function generationLock(
  schemaMarker: string,
  roleMarker: string,
  evidenceMarker: string,
  overrideMarker: string,
): GenerationLock {
  return {
    schema_version: "synapsor.generation-lock.v1",
    compiler_version: "test",
    spec_version: "test",
    engine: "postgres",
    source_env: "DATABASE_URL",
    inspected_schema: "public",
    schema_fingerprint: `sha256:${schemaMarker.repeat(64)}`,
    role_posture_fingerprint: `sha256:${roleMarker.repeat(64)}`,
    evidence_fingerprint: `sha256:${evidenceMarker.repeat(64)}`,
    generated_contract_digest: `sha256:${"9".repeat(64)}`,
    reviewed_overrides_digest: `sha256:${overrideMarker.repeat(64)}`,
    protected_authority: [],
  };
}

function activateBoundary(candidate: ExplorationBoundaryDraft): ActivatedExplorationBoundary {
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

async function writeGenerationLock(root: string, lock: GenerationLock): Promise<void> {
  const digest = canonicalJsonDigest(lock);
  await fs.writeFile(
    path.join(root, ".synapsor/generation-lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(root, `.synapsor/exploration-locks/${digest.slice("sha256:".length)}.json`),
    `${JSON.stringify(lock, null, 2)}\n`,
    "utf8",
  );
}

async function writeActiveSet(
  root: string,
  boundaries: ActivatedExplorationBoundary[],
): Promise<void> {
  await fs.writeFile(
    path.join(root, ".synapsor/exploration-boundaries.active.json"),
    `${JSON.stringify({
      schema_version: "synapsor.active-exploration-boundaries.v1",
      selected_name: boundaries.at(-1)!.pack.name,
      boundaries,
      updated_at: "2026-08-07T00:00:00.000Z",
    }, null, 2)}\n`,
    "utf8",
  );
}

async function writeMultiBoundaryLibrary(
  root: string,
  boundaryA: ExplorationBoundaryDraft,
  boundaryB: ExplorationBoundaryDraft,
): Promise<void> {
  await fs.writeFile(
    path.join(root, ".synapsor/boundary-library.json"),
    `${JSON.stringify({
      selected_name: boundaryB.pack.name,
      boundaries: {
        [boundaryA.pack.name]: { candidate: boundaryA },
        [boundaryB.pack.name]: { candidate: boundaryB },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}
