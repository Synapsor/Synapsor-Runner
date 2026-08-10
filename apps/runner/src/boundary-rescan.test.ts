import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import {
  activateExplorationBoundary,
  buildAutoBoundary,
  emptyReviewOverrides,
  explorationBoundaryCandidateDigest,
  loadActivatedExplorationBoundaries,
  writeAutoBoundaryArtifacts,
} from "./auto-boundary.js";
import {
  applyManagedBoundaryReviewDecision,
  createBoundaryReviewProgress,
  saveBoundaryReviewProgress,
} from "./boundary-review-domain.js";
import {
  createSavedBoundary,
  switchSavedBoundary,
  synchronizeBoundaryLibrary,
} from "./boundary-library.js";
import {
  boundaryReviewCommand as boundaryReviewCommandInternal,
  loadBoundaryReviewContext,
} from "./boundary-commands.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import {
  commitBoundaryRescan,
  formatBoundaryRescanReport,
  prepareBoundaryRescan,
  readBoundaryRescanReport,
} from "./boundary-rescan.js";

describe("boundary rescan reconciliation", () => {
  it("preserves derived/shared policy and active authority while offering unrelated schema additions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-rescan-"));
    const inspection = normalizedCommerceInspection();
    const project = {
      root,
      package_manager: "npm" as const,
      frameworks: ["node"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    };
    let overrides = emptyReviewOverrides();
    overrides = applyManagedBoundaryReviewDecision(overrides, {
      kind: "tenant_scope_path",
      resource_id: "public.order_items",
      value: "order_items_order_id_fkey",
      actor: "owner@example.test",
      reason: "Every order item belongs to the tenant-scoped order reached by this required foreign key.",
      decided_at: "2026-08-08T00:00:00.000Z",
    });
    overrides = applyManagedBoundaryReviewDecision(overrides, {
      kind: "shared_reference_scope",
      resource_id: "public.product_catalog",
      acknowledgement: "table_has_no_per_tenant_rows",
      actor: "owner@example.test",
      reason: "The product catalog contains the same reviewed rows for every tenant.",
      decided_at: "2026-08-08T00:00:00.000Z",
    });
    const build = buildAutoBoundary({
      inspection,
      project,
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
      overrides,
    });
    expect(build.exploration_boundary.pack.resources.map((resource) => resource.id).sort())
      .toEqual(["public.order_items", "public.orders", "public.product_catalog"]);

    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const progress = createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: build.exploration_boundary,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        reviewOverrides: overrides,
        actor: "owner@example.test",
        reason: "Initial exact boundary review.",
        revision: 1,
        now: "2026-08-08T00:00:00.000Z",
      });
      await saveBoundaryReviewProgress(root, progress);
      await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: build.exploration_boundary,
        currentCandidate: progress.candidate,
        currentProgress: progress,
      });
      const activeDigest = explorationBoundaryCandidateDigest(progress.candidate);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: progress.candidate,
        expectedDigest: activeDigest,
        actor: "owner@example.test",
        confirmation: `ACTIVATE ${activeDigest}`,
        confirmedDecisions: progress.candidate.unresolved_decisions,
        currentInspection: inspection,
      });

      const changed = structuredClone(inspection);
      const orderItems = changed.tables.find((table) => table.name === "order_items")!;
      orderItems.columns.push(column("product_id", "uuid", false, orderItems.columns.length + 1));
      orderItems.foreign_keys.push({
        name: "order_items_product_id_fkey",
        columns: ["product_id"],
        referenced_schema: "public",
        referenced_table: "product_catalog",
        referenced_columns: ["id"],
        delete_rule: "RESTRICT",
      });
      orderItems.suggestions.default_visible_columns.push("product_id");

      const firstPreview = await prepareBoundaryRescan({
        projectRoot: root,
        inspection: changed,
        now: "2026-08-08T01:00:00.000Z",
      });
      const secondPreview = await prepareBoundaryRescan({
        projectRoot: root,
        inspection: changed,
        now: "2026-08-08T01:01:00.000Z",
      });
      expect(secondPreview.previewDigest).toBe(firstPreview.previewDigest);
      expect(firstPreview.report).toMatchObject({
        changed: true,
        totals: {
          invalidated_decisions: 0,
          newly_available_fields: 1,
          newly_available_relationships: 1,
        },
      });
      expect(firstPreview.selectedProgress.candidate.pack.resources.map((resource) => resource.id).sort())
        .toEqual(["public.order_items", "public.orders", "public.product_catalog"]);
      const reconciledItems = firstPreview.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.order_items",
      )!;
      expect(reconciledItems.tenant_scope?.path_id).toBe("order_items_order_id_fkey");
      expect(reconciledItems.kept_out_fields).toContain("product_id");
      expect(reconciledItems.relationships.map((relationship) => relationship.id))
        .not.toContain("order_items_product_id_fkey");
      expect(firstPreview.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.product_catalog",
      )?.shared_reference_scope).toMatchObject({ mode: "shared_reference" });

      const libraryPath = path.join(root, ".synapsor/boundary-library.json");
      const originalLibrary = await fs.readFile(libraryPath, "utf8");
      const concurrentLibrary = JSON.parse(originalLibrary);
      concurrentLibrary.updated_at = "2026-08-08T01:30:00.000Z";
      await fs.writeFile(libraryPath, `${JSON.stringify(concurrentLibrary, null, 2)}\n`);
      await expect(commitBoundaryRescan(firstPreview)).rejects.toThrow(
        /changed after this rescan preview.*nothing was written.*retry --rescan/i,
      );
      await fs.writeFile(libraryPath, originalLibrary);

      const reportPath = path.join(root, ".synapsor/boundary-rescan-report.json");
      const draftPath = path.join(root, "synapsor/generated/exploration-boundary.draft.json");
      const draftBeforeFailedCommit = await fs.readFile(draftPath, "utf8");
      await fs.mkdir(reportPath);
      await expect(commitBoundaryRescan(secondPreview)).rejects.toThrow(
        /refusing to replace non-regular managed state file/i,
      );
      expect(await fs.readFile(draftPath, "utf8")).toBe(draftBeforeFailedCommit);
      expect(await fs.readFile(libraryPath, "utf8")).toBe(originalLibrary);
      await fs.rm(reportPath, { recursive: true });

      await commitBoundaryRescan(secondPreview);
      const active = await loadActivatedExplorationBoundaries(root);
      expect(active).toHaveLength(1);
      expect(active[0]!.activation.digest).toBe(activeDigest);
      expect(active[0]!.pack.resources.find((resource) => resource.id === "public.order_items")
        ?.kept_out_fields).not.toContain("product_id");
      const storedOverrides = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/review-overrides.json"),
        "utf8",
      ));
      expect(storedOverrides.resources["public.order_items"].tenant_scope_path.value)
        .toBe("order_items_order_id_fkey");
      expect(storedOverrides.resources["public.product_catalog"].shared_reference_scope.value)
        .toBe("table_has_no_per_tenant_rows");
      await expect(readBoundaryRescanReport(root)).resolves.toMatchObject({
        totals: { invalidated_decisions: 0 },
      });

      const noChange = await prepareBoundaryRescan({
        projectRoot: root,
        inspection: changed,
        now: "2026-08-08T02:00:00.000Z",
      });
      expect(noChange.report.changed).toBe(false);
      expect(noChange.report.totals.invalidated_decisions).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("retains production HTTP profile and trusted claims during reconciliation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-production-rescan-"));
    const inspection = normalizedCommerceInspection();
    const build = buildAutoBoundary({
      inspection,
      project: {
        root,
        package_manager: "npm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
      deploymentProfile: "production",
      httpClaims: {
        tenantClaim: "org_id",
        principalClaim: "sub",
      },
    });
    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const progress = createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: build.exploration_boundary,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        actor: "production-reviewer",
        revision: 1,
      });
      await saveBoundaryReviewProgress(root, progress);
      await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: build.exploration_boundary,
        currentCandidate: progress.candidate,
        currentProgress: progress,
      });
      const preview = await prepareBoundaryRescan({ projectRoot: root, inspection });
      expect(preview.report.changed, JSON.stringify(preview.report, null, 2)).toBe(false);
      expect(preview.selectedProgress.candidate).toMatchObject({
        deployment_profile: "production",
        trusted_context: {
          provider: "http_claims",
          tenant_claim: "org_id",
          principal_claim: "sub",
        },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles an all-blocked MySQL draft without inventing authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-blocked-mysql-rescan-"));
    try {
      const inspection = normalizedCommerceInspection();
      inspection.engine = "mysql";
      inspection.server_version = "MySQL 8.4";
      inspection.schemas = ["appdb"];
      inspection.tables = [inspection.tables.find((item) => item.name === "orders")!];
      const orders = inspection.tables[0]!;
      orders.schema = "appdb";
      orders.row_level_security = false;
      orders.row_level_security_policies = [];
      orders.role_posture!.row_security_effective_for_current_role = false;
      const build = buildAutoBoundary({
        inspection,
        project: {
          root,
          package_manager: "npm",
          frameworks: ["node"],
          schema_inputs: [],
          database_env_names: ["DATABASE_URL"],
        },
        sourceEnv: "DATABASE_URL",
        inspectedSchema: "appdb",
      });
      expect(build.exploration_boundary.pack.resources).toEqual([]);
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });

      const changed = structuredClone(inspection);
      changed.tables[0]!.columns.push(column("rescan_probe", "integer", false, 4));
      const preview = await prepareBoundaryRescan({ projectRoot: root, inspection: changed });

      expect(preview.report).toMatchObject({
        engine: "mysql",
        schema_changed: true,
        changed: true,
      });
      expect(preview.persistReviewState).toBe(false);
      expect(preview.selectedProgress.candidate.pack.resources).toEqual([]);
      expect(formatBoundaryRescanReport(preview.report)).toContain(
        "This project still has no reviewed table.",
      );
      await commitBoundaryRescan(preview);
      await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(root, ".synapsor/boundary-library.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.access(path.join(root, ".synapsor/boundary-review-progress.json")))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates reviewed field decisions when a reviewed column type changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-field-type-rescan-"));
    try {
      const setup = await writeReviewedCommerceProject(root);
      const changed = structuredClone(setup.inspection);
      const status = changed.tables.find((table) => table.name === "orders")!
        .columns.find((field) => field.name === "status")!;
      status.data_type = "integer";

      const preview = await prepareBoundaryRescan({ projectRoot: root, inspection: changed });
      const entry = preview.report.boundaries[0]!;
      expect(preview.report.changed).toBe(true);
      expect(entry.changed_field_types).toContainEqual({
        resource_id: "public.orders",
        field: "status",
      });
      expect(entry.invalidated_decisions.map((decision) => decision.id)).toEqual(
        expect.arrayContaining([
          "resource.public.orders.field_permissions",
        ]),
      );
      expect(entry.invalidated_decisions.map((decision) => decision.id))
        .not.toContain("resource.public.orders.field_visibility");
      expect(entry.retained_resources).toEqual([
        "public.order_items",
        "public.orders",
        "public.product_catalog",
      ]);
      expect(preview.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.order_items",
      )?.tenant_scope?.path_id).toBe("order_items_order_id_fkey");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("removes a dropped reviewed column while preserving unrelated resource decisions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-dropped-field-rescan-"));
    try {
      const setup = await writeReviewedCommerceProject(root);
      const changed = structuredClone(setup.inspection);
      const orders = changed.tables.find((table) => table.name === "orders")!;
      orders.columns = orders.columns.filter((field) => field.name !== "status");
      orders.suggestions.default_visible_columns = orders.suggestions.default_visible_columns
        .filter((field) => field !== "status");

      const preview = await prepareBoundaryRescan({ projectRoot: root, inspection: changed });
      const entry = preview.report.boundaries[0]!;
      expect(entry.removed_fields).toContainEqual({
        resource_id: "public.orders",
        field: "status",
      });
      expect(entry.invalidated_decisions.map((decision) => decision.id)).toEqual(
        expect.arrayContaining([
          "resource.public.orders.field_visibility",
          "resource.public.orders.field_permissions",
        ]),
      );
      expect(preview.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.order_items",
      )?.tenant_scope?.path_id).toBe("order_items_order_id_fkey");
      expect(preview.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.product_catalog",
      )?.shared_reference_scope).toMatchObject({ mode: "shared_reference" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when a derived path breaks and a shared-reference table gains tenant posture", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-scope-rescan-"));
    try {
      const setup = await writeReviewedCommerceProject(root, true);
      const changed = structuredClone(setup.inspection);
      const orderItems = changed.tables.find((table) => table.name === "order_items")!;
      orderItems.columns.find((field) => field.name === "order_id")!.nullable = true;
      const catalog = changed.tables.find((table) => table.name === "product_catalog")!;
      catalog.columns.push(column("tenant_id", "uuid", true, catalog.columns.length + 1));
      catalog.suggestions.tenant_columns.push("tenant_id");
      catalog.suggestions.default_visible_columns.push("tenant_id");

      const preview = await prepareBoundaryRescan({ projectRoot: root, inspection: changed });
      const entry = preview.report.boundaries[0]!;
      expect(entry.pruned_review_inputs).toEqual(expect.arrayContaining([
        expect.stringContaining("reviewed derived tenant path order_items_order_id_fkey is no longer"),
        expect.stringContaining("reviewed shared-reference scope is no longer safe"),
      ]));
      expect(preview.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.order_items",
      )).toBeUndefined();
      const reviewedCatalog = preview.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.product_catalog",
      );
      expect(reviewedCatalog?.shared_reference_scope).toBeUndefined();
      expect(preview.selectedProgress.confirmed_decisions).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining("shared reference"),
          expect.stringContaining("derived tenant"),
        ]),
      );

      await commitBoundaryRescan(preview);
      const active = await loadActivatedExplorationBoundaries(root);
      expect(active[0]!.activation.digest).toBe(setup.activeDigest);
      expect(active[0]!.pack.resources.find(
        (resource) => resource.id === "public.product_catalog",
      )?.shared_reference_scope).toMatchObject({ mode: "shared_reference" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles overlapping boundaries independently and persists every exact lock snapshot", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-multi-boundary-rescan-"));
    try {
      const inspection = normalizedCommerceInspection();
      const project = {
        root,
        package_manager: "npm" as const,
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      };
      let overrides = emptyReviewOverrides();
      overrides = applyManagedBoundaryReviewDecision(overrides, {
        kind: "shared_reference_scope",
        resource_id: "public.product_catalog",
        acknowledgement: "table_has_no_per_tenant_rows",
        actor: "owner@example.test",
        reason: "The product catalog contains the same reviewed rows for every tenant.",
        decided_at: "2026-08-08T00:00:00.000Z",
      });
      const build = buildAutoBoundary({
        inspection,
        project,
        sourceEnv: "DATABASE_URL",
        inspectedSchema: "public",
        overrides,
      });
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const primary = createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: build.exploration_boundary,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        reviewOverrides: overrides,
        actor: "owner@example.test",
        revision: 1,
      });
      await saveBoundaryReviewProgress(root, primary);
      await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: build.exploration_boundary,
        currentCandidate: primary.candidate,
        currentProgress: primary,
      });
      const support = await createSavedBoundary({
        projectRoot: root,
        draft: build.exploration_boundary,
        currentCandidate: primary.candidate,
        currentProgress: primary,
        name: "support_boundary",
        resourceId: "public.orders",
        actor: "support-reviewer",
      });

      const changed = structuredClone(inspection);
      const catalog = changed.tables.find((table) => table.name === "product_catalog")!;
      catalog.columns.push(column("display_rank", "integer", false, catalog.columns.length + 1));
      catalog.suggestions.default_visible_columns.push("display_rank");
      const preview = await prepareBoundaryRescan({ projectRoot: root, inspection: changed });
      expect(preview.report.boundaries).toHaveLength(2);
      const primaryEntry = preview.report.boundaries.find(
        (entry) => entry.boundary_name === "reviewed_staging",
      )!;
      const supportEntry = preview.report.boundaries.find(
        (entry) => entry.boundary_name === "support_boundary",
      )!;
      expect(primaryEntry.newly_available_fields).toContainEqual({
        resource_id: "public.product_catalog",
        field: "display_rank",
      });
      expect(supportEntry.newly_available_fields).toEqual([]);
      expect(supportEntry.invalidated_decisions).toEqual([]);
      expect(preview.library.boundaries.reviewed_staging!.boundary_id)
        .not.toBe(support.boundary_id);
      expect(preview.library.boundaries.support_boundary!.boundary_id).toBe(support.boundary_id);

      await commitBoundaryRescan(preview);
      for (const snapshot of preview.generationLockSnapshots) {
        const digest = snapshot.fingerprint.slice("sha256:".length);
        await expect(fs.readFile(
          path.join(root, ".synapsor/exploration-locks", `${digest}.json`),
          "utf8",
        )).resolves.toContain(snapshot.lock.schema_fingerprint);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("activates a reconciled boundary over a stale revision without disturbing another active boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-reconciled-activation-"));
    try {
      const setup = await writeReviewedDirectCommerceProject(root);
      const primary = await loadBoundaryReviewContext(root);
      const support = await createSavedBoundary({
        projectRoot: root,
        draft: primary.draft,
        currentCandidate: primary.candidate,
        ...(primary.progress ? { currentProgress: primary.progress } : {}),
        name: "support_boundary",
        resourceId: "public.orders",
        actor: "support-reviewer",
      });
      const supportDigest = explorationBoundaryCandidateDigest(support.candidate);
      expect(support.candidate.generation_lock_fingerprint)
        .toBe(primary.draft.generation_lock_fingerprint);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: support.candidate,
        expectedDigest: supportDigest,
        actor: "support-reviewer",
        confirmation: `ACTIVATE ${supportDigest}`,
        confirmedDecisions: support.candidate.unresolved_decisions,
        currentInspection: setup.inspection,
        activeSetMode: "add",
      });
      await switchSavedBoundary({
        projectRoot: root,
        draft: primary.draft,
        currentCandidate: support.candidate,
        currentProgress: support,
        name: "reviewed_staging",
      });

      const changed = structuredClone(setup.inspection);
      const orders = changed.tables.find((table) => table.name === "orders")!;
      orders.columns.push(column("display_rank", "integer", false, orders.columns.length + 1));
      orders.suggestions.default_visible_columns.push("display_rank");
      const preview = await prepareBoundaryRescan({ projectRoot: root, inspection: changed });
      expect(preview.report.changed).toBe(true);
      await commitBoundaryRescan(preview);

      const staleActive = await loadActivatedExplorationBoundaries(root);
      expect(staleActive).toHaveLength(2);
      expect(staleActive.find((boundary) => boundary.pack.name === "reviewed_staging")
        ?.activation.digest).toBe(setup.activeDigest);
      const reconciledDigest = explorationBoundaryCandidateDigest(preview.selectedProgress.candidate);
      let pickerCalls = 0;
      let refreshedOverview: Parameters<BoundaryReviewInteractiveSession["chooseResource"]>[1];
      const session: BoundaryReviewInteractiveSession = {
        chooseResource: async (_resources, overview) => {
          pickerCalls += 1;
          if (pickerCalls === 2) refreshedOverview = overview;
          return pickerCalls === 1 ? { action: "confirm" } : undefined;
        },
        editFieldTiers: async () => undefined,
        promptText: async () => {
          throw new Error("Reconciled activation already has an audited operator identity.");
        },
        confirm: async () => {
          throw new Error("Focused activation must use the explicit raw-key confirmation.");
        },
        confirmActivation: async () => true,
      };

      await expect(boundaryReviewCommandInternal(
        ["--project-root", root, "--access"],
        async () => changed,
        session,
        async () => 0,
        { startAtBoundaryList: true },
      )).resolves.toBe(0);

      expect(pickerCalls).toBe(2);
      const activeSet = await loadActivatedExplorationBoundaries(root);
      expect(activeSet).toHaveLength(2);
      expect(activeSet.find((boundary) => boundary.pack.name === "reviewed_staging")
        ?.activation.digest).toBe(reconciledDigest);
      expect(activeSet.find((boundary) => boundary.pack.name === "support_boundary")
        ?.activation.digest).toBe(supportDigest);
      const legacySelected = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/exploration-boundary.active.json"),
        "utf8",
      ));
      expect(legacySelected.pack.name).toBe("reviewed_staging");
      expect(legacySelected.activation.digest).toBe(reconciledDigest);
      const persistedSet = JSON.parse(await fs.readFile(
        path.join(root, ".synapsor/exploration-boundaries.active.json"),
        "utf8",
      ));
      expect(persistedSet.boundaries).toHaveLength(2);
      expect(persistedSet.boundaries.find((boundary: { pack: { name: string } }) =>
        boundary.pack.name === "reviewed_staging")?.activation.digest).toBe(reconciledDigest);
      expect(refreshedOverview?.boundaries?.find((boundary) =>
        boundary.name === "reviewed_staging")).toMatchObject({
        active: true,
        matches_active_digest: true,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function writeReviewedDirectCommerceProject(root: string): Promise<{
  inspection: SchemaInspection;
  activeDigest: `sha256:${string}`;
}> {
  const inspection = normalizedCommerceInspection();
  const build = buildAutoBoundary({
    inspection,
    project: {
      root,
      package_manager: "npm",
      frameworks: ["node"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    },
    sourceEnv: "DATABASE_URL",
    inspectedSchema: "public",
  });
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  const progress = createBoundaryReviewProgress({
    draft: build.exploration_boundary,
    candidate: build.exploration_boundary,
    confirmedDecisions: build.exploration_boundary.unresolved_decisions,
    actor: "owner@example.test",
    reason: "Initial exact direct-scope boundary review.",
    revision: 1,
    now: "2026-08-08T00:00:00.000Z",
  });
  await saveBoundaryReviewProgress(root, progress);
  await synchronizeBoundaryLibrary({
    projectRoot: root,
    draft: build.exploration_boundary,
    currentCandidate: progress.candidate,
    currentProgress: progress,
  });
  const activeDigest = explorationBoundaryCandidateDigest(progress.candidate);
  await activateExplorationBoundary({
    projectRoot: root,
    candidate: progress.candidate,
    expectedDigest: activeDigest,
    actor: "owner@example.test",
    confirmation: `ACTIVATE ${activeDigest}`,
    confirmedDecisions: progress.candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  return { inspection, activeDigest };
}

async function writeReviewedCommerceProject(root: string, activate = false): Promise<{
  inspection: SchemaInspection;
  activeDigest?: `sha256:${string}`;
}> {
  const inspection = normalizedCommerceInspection();
  const project = {
    root,
    package_manager: "npm" as const,
    frameworks: ["node"],
    schema_inputs: [],
    database_env_names: ["DATABASE_URL"],
  };
  let overrides = emptyReviewOverrides();
  overrides = applyManagedBoundaryReviewDecision(overrides, {
    kind: "tenant_scope_path",
    resource_id: "public.order_items",
    value: "order_items_order_id_fkey",
    actor: "owner@example.test",
    reason: "Every item belongs to the tenant-scoped order reached by this required foreign key.",
    decided_at: "2026-08-08T00:00:00.000Z",
  });
  overrides = applyManagedBoundaryReviewDecision(overrides, {
    kind: "shared_reference_scope",
    resource_id: "public.product_catalog",
    acknowledgement: "table_has_no_per_tenant_rows",
    actor: "owner@example.test",
    reason: "The product catalog contains the same reviewed rows for every tenant.",
    decided_at: "2026-08-08T00:00:00.000Z",
  });
  const build = buildAutoBoundary({
    inspection,
    project,
    sourceEnv: "DATABASE_URL",
    inspectedSchema: "public",
    overrides,
  });
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  const progress = createBoundaryReviewProgress({
    draft: build.exploration_boundary,
    candidate: build.exploration_boundary,
    confirmedDecisions: build.exploration_boundary.unresolved_decisions,
    reviewOverrides: overrides,
    actor: "owner@example.test",
    reason: "Initial exact boundary review.",
    revision: 1,
    now: "2026-08-08T00:00:00.000Z",
  });
  await saveBoundaryReviewProgress(root, progress);
  await synchronizeBoundaryLibrary({
    projectRoot: root,
    draft: build.exploration_boundary,
    currentCandidate: progress.candidate,
    currentProgress: progress,
  });
  if (!activate) return { inspection };
  const activeDigest = explorationBoundaryCandidateDigest(progress.candidate);
  await activateExplorationBoundary({
    projectRoot: root,
    candidate: progress.candidate,
    expectedDigest: activeDigest,
    actor: "owner@example.test",
    confirmation: `ACTIVATE ${activeDigest}`,
    confirmedDecisions: progress.candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  return { inspection, activeDigest };
}

function normalizedCommerceInspection(): SchemaInspection {
  const orders = table("orders", [
    column("id", "uuid", false, 1),
    column("tenant_id", "uuid", true, 2),
    column("status", "text", false, 3),
  ]);
  orders.suggestions.tenant_columns = ["tenant_id"];
  orders.row_level_security = true;
  orders.row_level_security_policies = [{
    name: "orders_tenant_read",
    command: "SELECT",
    permissive: true,
    roles: ["app_reader"],
    using_expression: "tenant_id = current_setting('app.tenant_id')::uuid",
  }];
  orders.role_posture!.row_security_effective_for_current_role = true;

  const orderItems = table("order_items", [
    column("id", "uuid", false, 1),
    column("order_id", "uuid", false, 2),
    column("quantity", "integer", false, 3),
  ]);
  orderItems.foreign_keys = [{
    name: "order_items_order_id_fkey",
    columns: ["order_id"],
    referenced_schema: "public",
    referenced_table: "orders",
    referenced_columns: ["id"],
    delete_rule: "RESTRICT",
  }];

  const productCatalog = table("product_catalog", [
    column("id", "uuid", false, 1),
    column("category", "text", false, 2),
  ]);
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16",
    current_user: "app_reader",
    inspected_at: "2026-08-08T00:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    },
    tables: [orders, orderItems, productCatalog],
  };
}

function table(
  name: string,
  columns: ReturnType<typeof column>[],
): SchemaInspection["tables"][number] {
  return {
    schema: "public",
    name,
    type: "table" as const,
    writable: true,
    columns,
    primary_key: ["id"],
    unique_constraints: [{ name: `${name}_pkey`, columns: ["id"] }],
    foreign_keys: [] as SchemaInspection["tables"][number]["foreign_keys"],
    indexes: [{ name: `${name}_pkey`, columns: ["id"], unique: true }],
    row_level_security: false,
    row_level_security_policies: [],
    role_posture: {
      owner: "app_owner",
      current_role_is_owner: false,
      current_role_can_assume_owner: false,
      privileges: {
        select: true,
        insert: false,
        update: false,
        delete: false,
        truncate: false,
        references: false,
        trigger: false,
      },
      row_security_forced: false,
      row_security_effective_for_current_role: false,
    },
    suggestions: {
      tenant_columns: [] as string[],
      conflict_columns: [],
      sensitive_columns: [],
      default_visible_columns: columns.map((item) => item.name),
    },
  };
}

function column(name: string, dataType: string, tenant: boolean, ordinalPosition: number) {
  return {
    name,
    data_type: dataType,
    nullable: false,
    generated: false,
    ordinal_position: ordinalPosition,
    suggestions: {
      tenant,
      conflict: false,
      sensitive: false,
      immutable: name === "id" || tenant,
      large_or_binary: false,
    },
  };
}
