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
  loadAutoBoundaryPolicyBaseline,
  loadActivatedExplorationBoundaries,
  writeAutoBoundaryArtifacts,
  type GenerationLock,
} from "./auto-boundary.js";
import {
  applyManagedBoundaryReviewDecision,
  boundaryReviewDecisions,
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
import { compileExplorePlan, validateExplorePlan } from "./scoped-explore.js";

describe("boundary rescan reconciliation", () => {
  it("repairs a stale policy-neutral authoring baseline without changing reviewed authority", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-boundary-baseline-repair-"));
    const inspection = normalizedCommerceInspection();
    const project = {
      root,
      package_manager: "npm" as const,
      frameworks: ["node"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    };
    const build = buildAutoBoundary({
      inspection,
      project,
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    });
    const unscopedInspection = structuredClone(inspection);
    for (const table of unscopedInspection.tables) {
      table.row_level_security = false;
      table.row_level_security_policies = [];
      if (table.role_posture) {
        table.role_posture.row_security_forced = false;
        table.role_posture.row_security_effective_for_current_role = false;
      }
      for (const field of table.columns.filter((item) => item.name === "tenant_id")) {
        field.nullable = true;
      }
    }
    const staleBaseline = buildAutoBoundary({
      inspection: unscopedInspection,
      project,
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "public",
    }).policy_baseline;
    expect(staleBaseline.boundary.pack.resources).toEqual([]);
    build.policy_baseline = staleBaseline;

    try {
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      await writeRunnerConfig(root, {
        provider: "environment",
        tenantBinding: "tenant_id",
      });
      const progress = createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: build.exploration_boundary,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        actor: "owner@example.test",
        revision: 1,
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
      const draftPath = path.join(root, "synapsor/generated/exploration-boundary.draft.json");
      const overridesPath = path.join(root, ".synapsor/review-overrides.json");
      const draftBefore = await fs.readFile(draftPath, "utf8");
      const overridesBefore = await fs.readFile(overridesPath, "utf8");

      const preview = await prepareBoundaryRescan({ projectRoot: root, inspection });
      expect(preview.report).toMatchObject({
        changed: false,
        authoring_baseline_refreshed: true,
      });
      expect(formatBoundaryRescanReport(preview.report)).toMatch(
        /repaired the private boundary-authoring baseline.*no active boundary or reviewed revision changed/i,
      );
      const repeatedPreview = await prepareBoundaryRescan({ projectRoot: root, inspection });
      const { generated_at: _firstGeneratedAt, ...firstStableReport } = preview.report;
      const { generated_at: _repeatedGeneratedAt, ...repeatedStableReport } = repeatedPreview.report;
      expect(repeatedStableReport).toEqual(firstStableReport);
      expect(repeatedPreview.previewDigest).toBe(preview.previewDigest);
      await commitBoundaryRescan(preview);

      expect(await fs.readFile(draftPath, "utf8")).toBe(draftBefore);
      expect(await fs.readFile(overridesPath, "utf8")).toBe(overridesBefore);
      expect((await loadActivatedExplorationBoundaries(root))[0]!.activation.digest)
        .toBe(activeDigest);
      expect((await loadAutoBoundaryPolicyBaseline(root)).boundary.pack.resources)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ id: "public.orders", tenant_key: "tenant_id" }),
        ]));
      await expect(readBoundaryRescanReport(root)).resolves.toMatchObject({
        changed: false,
        authoring_baseline_refreshed: true,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

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
    overrides = applyManagedBoundaryReviewDecision(overrides, {
      kind: "auto_band",
      resource_id: "public.order_items",
      field: "quantity",
      definition: reviewedQuantityAutoBand(),
      actor: "owner@example.test",
      reason: "Allow bounded adaptive quantity groups without model-authored edges.",
      decided_at: "2026-08-08T00:00:00.000Z",
    });
    overrides = applyManagedBoundaryReviewDecision(overrides, {
      kind: "resource_metadata",
      resource_id: "public.order_items",
      label: "Order line items",
      description: "Reviewed products and quantities attached to tenant-scoped orders.",
      actor: "owner@example.test",
      reason: "Clarify a normalized legacy table without changing its reviewed authority.",
      decided_at: "2026-08-08T00:00:00.000Z",
    });
    overrides = applyManagedBoundaryReviewDecision(overrides, {
      kind: "field_metadata",
      resource_id: "public.order_items",
      field: "quantity",
      label: "Units ordered",
      actor: "owner@example.test",
      reason: "Clarify the reviewed numeric field used by adaptive bands.",
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
      // Older activated revisions can carry exact reviewed authority without
      // storing the newer per-decision confirmation records.
      progress.confirmations = [];
      progress.confirmed_decisions = [];
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
          preserved_authority: {
            resources: 3,
            reviewed_paths: 1,
            field_policies: 8,
          },
          kept_confirmations: 0,
          invalidated_decisions: 0,
          newly_available_fields: 1,
          newly_available_relationships: 1,
        },
      });
      expect(firstPreview.report.boundaries[0]).toMatchObject({
        kept_confirmations: 0,
        preserved_authority: {
          resources: 3,
          reviewed_paths: 1,
          field_policies: 8,
        },
      });
      expect(firstPreview.report.boundaries[0]!.newly_available_relationships[0]).toMatchObject({
        resource_id: "public.order_items",
        relationship_id: "order_items_product_id_fkey",
        target_resource: "public.product_catalog",
        path_depth: 1,
        path_links: [{
          source_resource: "public.order_items",
          target_resource: "public.product_catalog",
          source_columns: ["product_id"],
        }],
      });
      const formatted = formatBoundaryRescanReport(firstPreview.report);
      expect(formatted).toContain(
        "Reviewed authority preserved: 3 tables, 1 reviewed path, 8 field policies",
      );
      expect(formatted).toContain(
        "Boundary reviewed_staging: preserved 3 tables, 1 reviewed path, 8 field policies; 0 prior decisions invalidated.",
      );
      expect(formatted).not.toContain("Decisions kept: 0");
      expect(formatted).toContain("public.order_items: new relationship is available to review (1 hop)");
      expect(formatted).toContain("order_items -> product_catalog");
      expect(formatted).toContain("via columns: product_id");
      expect(formatted).toContain("path ID: order_items_product_id_fkey");

      const threeHopReport = structuredClone(firstPreview.report);
      threeHopReport.boundaries[0]!.newly_available_relationships = [{
        resource_id: "librarydb.note_flags",
        relationship_id: "note_flags_note_fk__event_notes_event_fk__loan_events_loan_fk",
        target_resource: "librarydb.loans",
        path_depth: 3,
        path_links: [
          {
            source_resource: "librarydb.note_flags",
            target_resource: "librarydb.event_notes",
            source_columns: ["event_note_id"],
          },
          {
            source_resource: "librarydb.event_notes",
            target_resource: "librarydb.loan_events",
            source_columns: ["loan_event_id"],
          },
          {
            source_resource: "librarydb.loan_events",
            target_resource: "librarydb.loans",
            source_columns: ["loan_id"],
          },
        ],
      }];
      const threeHopOutput = formatBoundaryRescanReport(threeHopReport);
      expect(threeHopOutput).toContain(
        "librarydb.note_flags: new relationship is available to review (3 hops)",
      );
      expect(threeHopOutput).toContain("note_flags -> event_notes -> loan_events -> loans");
      expect(threeHopOutput).toContain(
        "via columns: event_note_id -> loan_event_id -> loan_id",
      );
      expect(threeHopOutput).toContain(
        "path ID: note_flags_note_fk__event_notes_event_fk__loan_events_loan_fk",
      );
      expect(threeHopOutput).not.toContain(
        "librarydb.note_flags.note_flags_note_fk__event_notes_event_fk__loan_events_loan_fk",
      );
      expect(firstPreview.selectedProgress.candidate.pack.resources.map((resource) => resource.id).sort())
        .toEqual(["public.order_items", "public.orders", "public.product_catalog"]);
      const reconciledItems = firstPreview.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.order_items",
      )!;
      expect(reconciledItems.tenant_scope?.path_id).toBe("order_items_order_id_fkey");
      expect(reconciledItems.auto_bands).toEqual([reviewedQuantityAutoBand()]);
      expect(reconciledItems).toMatchObject({
        label: "Order line items",
        description: "Reviewed products and quantities attached to tenant-scoped orders.",
        field_metadata: { quantity: { label: "Units ordered" } },
      });
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
      expect(storedOverrides.resources["public.order_items"].auto_bands.quantity.definition)
        .toEqual(reviewedQuantityAutoBand());
      expect(storedOverrides.resources["public.order_items"].metadata.label)
        .toBe("Order line items");
      expect(storedOverrides.resources["public.order_items"].field_metadata.quantity.label)
        .toBe("Units ordered");
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
      await writeRunnerConfig(root, {
        provider: "http_claims",
        tenantClaim: "org_id",
        principalClaim: "sub",
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

      await writeRunnerConfig(root, {
        provider: "http_claims",
        tenantClaim: "org_id",
        principalClaim: "actor_id",
      });
      const changedClaims = await prepareBoundaryRescan({
        projectRoot: root,
        inspection,
        now: "2026-08-08T02:00:00.000Z",
      });
      expect(changedClaims.report).toMatchObject({
        schema_changed: false,
        role_posture_changed: false,
        trusted_context_changed: true,
        changed: true,
      });
      expect(changedClaims.report.trusted_context_changes).toContain(
        "principal JWT claim changed from sub to actor_id",
      );
      expect(changedClaims.selectedProgress.candidate.trusted_context).toEqual({
        provider: "http_claims",
        tenant_claim: "org_id",
        principal_claim: "actor_id",
      });
      expect(boundaryReviewDecisions(changedClaims.selectedProgress.candidate)
        .map((decision) => decision.id)).toContain(
        "global.trusted_context",
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles config-added and removed principal bindings without discarding curated policy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-scope-rescan-"));
    const inspection = normalizedCommerceInspection();
    const orders = inspection.tables.find((table) => table.name === "orders")!;
    orders.columns.push(column("attending", "text", false, orders.columns.length + 1));
    orders.suggestions.default_visible_columns.push("attending");
    try {
      await writeReviewedCommerceProject(root, false, inspection);
      await writeRunnerConfig(root, {
        provider: "environment",
        tenantBinding: "tenant_id",
      });

      const unchanged = await prepareBoundaryRescan({ projectRoot: root, inspection });
      expect(unchanged.report.changed).toBe(false);

      await writeRunnerConfig(root, {
        provider: "environment",
        tenantBinding: "tenant_id",
        principalBinding: "attending",
      });
      const added = await prepareBoundaryRescan({
        projectRoot: root,
        inspection,
        now: "2026-08-08T01:00:00.000Z",
      });
      expect(added.report).toMatchObject({
        schema_changed: false,
        role_posture_changed: false,
        trusted_context_changed: true,
        changed: true,
      });
      expect(added.report.trusted_context_changes).toContain(
        "principal binding attending added",
      );
      expect(formatBoundaryRescanReport(added.report)).toContain(
        "principal binding attending added",
      );
      const addedOrders = added.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.orders",
      )!;
      expect(addedOrders.principal_key).toBe("attending");
      expect(added.selectedProgress.review_overrides.resources["public.orders"]?.principal_key)
        .toMatchObject({ value: "attending", actor: "runner-config" });
      expect(added.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.order_items",
      )).toMatchObject({
        tenant_scope: { path_id: "order_items_order_id_fkey" },
        auto_bands: [reviewedQuantityAutoBand()],
      });
      expect(added.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.product_catalog",
      )?.shared_reference_scope).toMatchObject({ mode: "shared_reference" });
      expect(boundaryReviewDecisions(added.selectedProgress.candidate)
        .map((decision) => decision.id)).toEqual(
        expect.arrayContaining([
          "global.trusted_context",
          "resource.public.orders.principal_scope",
        ]),
      );

      await commitBoundaryRescan(added);
      await writeRunnerConfig(root, {
        provider: "environment",
        tenantBinding: "tenant_id",
      });
      const removed = await prepareBoundaryRescan({
        projectRoot: root,
        inspection,
        now: "2026-08-08T02:00:00.000Z",
      });
      expect(removed.report.trusted_context_changes).toContain(
        "principal binding attending removed",
      );
      expect(removed.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.orders",
      )?.principal_key).toBeUndefined();
      expect(removed.selectedProgress.review_overrides.resources["public.orders"]?.principal_key)
        .toBeUndefined();
      expect(removed.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.order_items",
      )).toMatchObject({
        tenant_scope: { path_id: "order_items_order_id_fkey" },
        auto_bands: [reviewedQuantityAutoBand()],
      });
      expect(removed.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.product_catalog",
      )?.shared_reference_scope).toMatchObject({ mode: "shared_reference" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to convert a staging boundary to HTTP claim trust through config alone", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-provider-rescan-"));
    const inspection = normalizedCommerceInspection();
    try {
      await writeReviewedCommerceProject(root, false, inspection);
      await writeRunnerConfig(root, {
        provider: "http_claims",
        tenantClaim: "tenant_id",
        principalClaim: "sub",
      });
      await expect(prepareBoundaryRescan({ projectRoot: root, inspection })).rejects.toThrow(
        /uses trusted_context\.provider=http_claims.*boundary is local\/staging.*separately reviewed production boundary/i,
      );
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
      orders.columns = orders.columns.filter((column) => column.name !== "tenant_id");
      orders.suggestions.tenant_columns = [];
      orders.suggestions.default_visible_columns = orders.suggestions.default_visible_columns
        .filter((field) => field !== "tenant_id");
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

  it("reconciles a MySQL 8 to 5.7 capability downgrade and removes unavailable auto bands", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-mysql-capability-rescan-"));
    try {
      const inspection = normalizedCommerceInspection();
      inspection.engine = "mysql";
      inspection.server_version = "MySQL 8.4.9";
      inspection.schemas = ["appdb"];
      inspection.tables = [inspection.tables.find((item) => item.name === "orders")!];
      const orders = inspection.tables[0]!;
      orders.schema = "appdb";
      orders.row_level_security = false;
      orders.row_level_security_policies = [];
      orders.role_posture!.row_security_effective_for_current_role = false;
      orders.columns = orders.columns.filter((column) => column.name !== "tenant_id");
      orders.suggestions.tenant_columns = [];
      orders.suggestions.default_visible_columns = orders.suggestions.default_visible_columns
        .filter((field) => field !== "tenant_id");
      orders.columns.push(column("duration_ms", "integer", false, orders.columns.length + 1));
      orders.suggestions.default_visible_columns.push("duration_ms");
      const status = orders.columns.find((field) => field.name === "status")!;
      status.enum_values = ["open", "closed"];
      const definition = {
        field: "duration_ms",
        methods: ["quantile"] as Array<"quantile">,
        min_buckets: 3,
        max_buckets: 8,
        label_style: "ordinal" as const,
      };
      const autoBandOverrides = applyManagedBoundaryReviewDecision(emptyReviewOverrides(), {
        kind: "auto_band",
        resource_id: "appdb.orders",
        field: "duration_ms",
        definition,
        actor: "owner@example.test",
        reason: "Review automatic value bands on the full MySQL grammar line.",
        decided_at: "2026-08-12T00:00:00.000Z",
      });
      const overrides = applyManagedBoundaryReviewDecision(autoBandOverrides, {
        kind: "field_enum",
        resource_id: "appdb.orders",
        field: "status",
        values: ["open", "closed"],
        actor: "owner@example.test",
        reason: "Review the enforced CHECK vocabulary on the full MySQL grammar line.",
        decided_at: "2026-08-12T00:00:00.000Z",
      });
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
        overrides,
        singleOrganization: { organizationId: "clinic-one" },
      });
      expect(build.exploration_boundary.pack.resources[0]!.auto_bands).toEqual([definition]);
      expect(build.exploration_boundary.pack.resources[0]!.field_enums.status).toEqual(["open", "closed"]);
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const progress = createBoundaryReviewProgress({
        draft: build.exploration_boundary,
        candidate: build.exploration_boundary,
        confirmedDecisions: build.exploration_boundary.unresolved_decisions,
        reviewOverrides: overrides,
        actor: "owner@example.test",
        revision: 1,
      });
      await saveBoundaryReviewProgress(root, progress);
      await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: build.exploration_boundary,
        currentCandidate: progress.candidate,
        currentProgress: progress,
      });

      const sameAuthorityPatch = structuredClone(inspection);
      sameAuthorityPatch.server_version = "MySQL 8.4.10";
      const patchPreview = await prepareBoundaryRescan({
        projectRoot: root,
        inspection: sameAuthorityPatch,
      });
      expect(patchPreview.report).toMatchObject({
        changed: false,
        schema_changed: false,
        role_posture_changed: false,
        database_server_authority_changed: false,
        previous_database_server_version: "MySQL 8.4.9",
        database_server_version: "MySQL 8.4.10",
        authoring_baseline_refreshed: true,
      });
      expect(patchPreview.selectedProgress.candidate_digest).toBe(progress.candidate_digest);

      const preCheck = structuredClone(inspection);
      preCheck.server_version = "MySQL 8.0.15";
      delete preCheck.tables[0]!.columns.find((field) => field.name === "status")!.enum_values;
      const preCheckPreview = await prepareBoundaryRescan({ projectRoot: root, inspection: preCheck });
      expect(preCheckPreview.report).toMatchObject({
        changed: true,
        schema_changed: true,
        role_posture_changed: false,
        database_server_authority_changed: true,
        previous_database_server_version: "MySQL 8.4.9",
        database_server_version: "MySQL 8.0.15",
        previous_database_server_tier: "full",
        database_server_tier: "compatible_limited",
      });
      expect(preCheckPreview.report.database_server_authority_changes).toEqual(expect.arrayContaining([
        "release line changed from mysql 8.x to mysql 8.0-pre-check",
        "CHECK constraints cannot provide reviewed value vocabularies on this release line",
      ]));
      expect(preCheckPreview.report.boundaries[0]!.pruned_review_inputs).toContain(
        "appdb.orders.status: the schema-declared vocabulary is no longer provable; filtering and grouping remain disabled",
      );
      expect(preCheckPreview.selectedProgress.candidate.pack.resources[0]!.field_enums.status).toBeUndefined();
      expect(preCheckPreview.selectedProgress.candidate.pack.resources[0]!.auto_bands).toEqual([definition]);

      const downgraded = structuredClone(inspection);
      downgraded.server_version = "MySQL 5.7.44-log";
      delete downgraded.tables[0]!.columns.find((field) => field.name === "status")!.enum_values;
      const preview = await prepareBoundaryRescan({ projectRoot: root, inspection: downgraded });
      expect(preview.report).toMatchObject({
        changed: true,
        schema_changed: true,
        role_posture_changed: false,
        database_server_authority_changed: true,
        previous_database_server_version: "MySQL 8.4.9",
        database_server_version: "MySQL 5.7.44-log",
        previous_database_server_tier: "full",
        database_server_tier: "compatible_limited",
      });
      expect(preview.report.database_server_authority_changes).toEqual(expect.arrayContaining([
        "release line changed from mysql 8.x to mysql 5.7",
        "automatic numeric bands are unavailable on this release line and were removed from review authority",
      ]));
      expect(preview.report.boundaries[0]!.pruned_review_inputs).toContain(
        "appdb.orders.duration_ms: reviewed automatic numeric bands are unavailable on MySQL 5.7.44-log",
      );
      expect(preview.selectedProgress.candidate.pack.resources[0]!.auto_bands).toBeUndefined();
      expect(preview.selectedProgress.candidate).toMatchObject({
        database_server_version: "MySQL 5.7.44-log",
        database_server_tier: "compatible_limited",
        database_server_authority: {
          engine: "mysql",
          version_line: "5.7",
        },
      });
      expect(formatBoundaryRescanReport(preview.report)).toMatch(
        /database server capability authority changed.*release line changed from mysql 8\.x to mysql 5\.7/is,
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("reconciles legacy MySQL categorical authority when an enforced CHECK vocabulary becomes provable", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-mysql-legacy-check-rescan-"));
    try {
      const legacyInspection = normalizedCommerceInspection();
      legacyInspection.engine = "mysql";
      legacyInspection.server_version = "MySQL 8.4.9";
      legacyInspection.schemas = ["clinicdb"];
      legacyInspection.tables = [legacyInspection.tables.find((item) => item.name === "orders")!];
      const legacyOrders = legacyInspection.tables[0]!;
      legacyOrders.schema = "clinicdb";
      legacyOrders.row_level_security = false;
      legacyOrders.row_level_security_policies = [];
      legacyOrders.role_posture!.row_security_effective_for_current_role = false;
      legacyOrders.columns = legacyOrders.columns.filter((field) => field.name !== "tenant_id");
      legacyOrders.suggestions.tenant_columns = [];
      legacyOrders.suggestions.default_visible_columns = legacyOrders.suggestions.default_visible_columns
        .filter((field) => field !== "tenant_id");
      delete legacyOrders.columns.find((field) => field.name === "status")!.enum_values;
      const privateStatus = column("private_status", "text", false, legacyOrders.columns.length + 1);
      const priority = column("priority", "text", false, legacyOrders.columns.length + 2);
      legacyOrders.columns.push(privateStatus, priority);
      legacyOrders.columns.find((field) => field.name === "priority")!.enum_values = [
        "urgent",
        "routine",
        "deferred",
      ];
      legacyOrders.suggestions.default_visible_columns.push("private_status", "priority");

      const project = {
        root,
        package_manager: "npm" as const,
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      };
      const legacyBuild = buildAutoBoundary({
        inspection: legacyInspection,
        project,
        sourceEnv: "DATABASE_URL",
        inspectedSchema: "clinicdb",
        singleOrganization: { organizationId: "clinic-one" },
      });
      const legacyResource = legacyBuild.exploration_boundary.pack.resources[0]!;
      expect(legacyResource.groupable_fields).toContain("status");
      expect(legacyResource.filterable_fields).toHaveProperty("status");
      expect(legacyResource.field_enums).not.toHaveProperty("status");
      const legacyCandidate = structuredClone(legacyBuild.exploration_boundary);
      const legacyCandidateResource = legacyCandidate.pack.resources[0]!;
      delete legacyCandidateResource.filterable_fields.private_status;
      legacyCandidateResource.groupable_fields = legacyCandidateResource.groupable_fields
        .filter((field) => field !== "private_status");
      legacyCandidateResource.field_enums.priority = ["urgent"];

      await writeAutoBoundaryArtifacts({ projectRoot: root, build: legacyBuild });
      const legacyProgress = createBoundaryReviewProgress({
        draft: legacyBuild.exploration_boundary,
        candidate: legacyCandidate,
        confirmedDecisions: legacyCandidate.unresolved_decisions,
        actor: "legacy-owner@example.test",
        revision: 1,
      });
      await saveBoundaryReviewProgress(root, legacyProgress);
      await synchronizeBoundaryLibrary({
        projectRoot: root,
        draft: legacyBuild.exploration_boundary,
        currentCandidate: legacyProgress.candidate,
        currentProgress: legacyProgress,
      });
      const legacyDigest = explorationBoundaryCandidateDigest(legacyProgress.candidate);
      await activateExplorationBoundary({
        projectRoot: root,
        candidate: legacyProgress.candidate,
        expectedDigest: legacyDigest,
        actor: "legacy-owner@example.test",
        confirmation: `ACTIVATE ${legacyDigest}`,
        confirmedDecisions: legacyProgress.candidate.unresolved_decisions,
        currentInspection: legacyInspection,
      });

      const currentInspection = structuredClone(legacyInspection);
      currentInspection.tables[0]!.columns.find((field) => field.name === "status")!.enum_values = [
        "scheduled",
        "completed",
        "no_show",
        "cancelled",
      ];
      currentInspection.tables[0]!.columns.find((field) => field.name === "private_status")!.enum_values = [
        "internal",
        "external",
      ];
      const preview = await prepareBoundaryRescan({ projectRoot: root, inspection: currentInspection });
      const reconciled = preview.selectedProgress.candidate.pack.resources[0]!;
      expect(reconciled.groupable_fields).toContain("status");
      expect(reconciled.filterable_fields).toHaveProperty("status");
      expect(reconciled.field_enums.status).toEqual([
        "scheduled",
        "completed",
        "no_show",
        "cancelled",
      ]);
      expect(reconciled.filterable_fields).not.toHaveProperty("private_status");
      expect(reconciled.groupable_fields).not.toContain("private_status");
      expect(reconciled.field_enums).not.toHaveProperty("private_status");
      expect(reconciled.field_enums.priority).toEqual(["urgent"]);
      expect(preview.report.boundaries[0]!.invalidated_decisions.map((decision) => decision.id))
        .toContain("resource.clinicdb.orders.field_permissions");
      expect(preview.report.boundaries[0]!.newly_proven_value_allowlists).toEqual([{
        resource_id: "clinicdb.orders",
        field: "status",
        value_count: 4,
      }]);
      expect(preview.report.totals.newly_proven_value_allowlists).toBe(1);
      expect(formatBoundaryRescanReport(preview.report)).toMatch(
        /clinicdb\.orders\.status: an enforced schema vocabulary now narrows existing filter\/group authority to 4 reviewed values; confirm field permissions, then activate/i,
      );
      expect((await loadActivatedExplorationBoundaries(root))[0]!.activation.digest).toBe(legacyDigest);

      await commitBoundaryRescan(preview);
      expect((await loadActivatedExplorationBoundaries(root))[0]!.activation.digest).toBe(legacyDigest);
      const reconciledDigest = explorationBoundaryCandidateDigest(preview.selectedProgress.candidate);
      const active = await activateExplorationBoundary({
        projectRoot: root,
        candidate: preview.selectedProgress.candidate,
        reviewDraft: preview.selectedBuild.exploration_boundary,
        generationLock: preview.selectedBuild.lock,
        expectedDigest: reconciledDigest,
        actor: "owner@example.test",
        confirmation: `ACTIVATE ${reconciledDigest}`,
        confirmedDecisions: preview.selectedProgress.candidate.unresolved_decisions,
        currentInspection,
      });
      expect(active.pack.resources[0]!.field_enums.status).toEqual([
        "scheduled",
        "completed",
        "no_show",
        "cancelled",
      ]);
      const plan = validateExplorePlan({
        kind: "aggregate",
        resource: "clinicdb.orders",
        measures: [{ function: "count" }],
        dimensions: [{ field: "status" }],
        top_n: 10,
      }, active);
      const [compiled] = compileExplorePlan(plan, active, {
        tenant: "clinic-one",
        principal: "reviewer",
      }, "mysql");
      expect(compiled?.sql).toMatch(/CASE WHEN t0\.`status` IS NULL THEN NULL/);
      expect(compiled?.params).toEqual(expect.arrayContaining([
        "scheduled",
        "completed",
        "no_show",
        "cancelled",
      ]));
      expect(() => validateExplorePlan({
        kind: "rows",
        resource: "clinicdb.orders",
        select: ["id", "status"],
        where: [{ field: "status", op: "eq", value: "retired" }],
        limit: 5,
      }, active)).toThrowError(expect.objectContaining({
        code: "EXPLORE_PLAN_INVALID",
        message: expect.stringMatching(/not a reviewed value/i),
      }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it("reconciles a legacy lock that does not record database capability metadata", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-server-authority-backfill-"));
    try {
      const { inspection } = await writeReviewedCommerceProject(root);
      const lockPath = path.join(root, ".synapsor/generation-lock.json");
      const legacyLock = JSON.parse(await fs.readFile(lockPath, "utf8")) as GenerationLock;
      delete legacyLock.database_server_version;
      delete legacyLock.database_server_tier;
      delete legacyLock.database_server_authority;
      await fs.writeFile(lockPath, `${JSON.stringify(legacyLock, null, 2)}\n`);

      const preview = await prepareBoundaryRescan({ projectRoot: root, inspection });
      expect(preview.report).toMatchObject({
        changed: true,
        schema_changed: false,
        role_posture_changed: false,
        database_server_authority_changed: true,
        database_server_version: "PostgreSQL 16",
        database_server_tier: "full",
      });
      expect(preview.report).not.toHaveProperty("previous_database_server_version");
      expect(preview.report).not.toHaveProperty("previous_database_server_tier");
      expect(preview.report.database_server_authority_changes).toContain(
        "recorded detected server PostgreSQL 16 as the full capability tier",
      );
      await commitBoundaryRescan(preview);

      const reconciledLock = JSON.parse(await fs.readFile(lockPath, "utf8")) as GenerationLock;
      expect(reconciledLock).toMatchObject({
        database_server_version: "PostgreSQL 16",
        database_server_tier: "full",
        database_server_authority: {
          engine: "postgres",
          version_line: "16",
        },
      });
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
      expect(preview.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.order_items",
      )?.auto_bands).toEqual([reviewedQuantityAutoBand()]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates an adaptive-band review when its numeric field type changes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-auto-band-type-rescan-"));
    try {
      const setup = await writeReviewedCommerceProject(root);
      const changed = structuredClone(setup.inspection);
      const quantity = changed.tables.find((table) => table.name === "order_items")!
        .columns.find((field) => field.name === "quantity")!;
      quantity.data_type = "text";

      const preview = await prepareBoundaryRescan({ projectRoot: root, inspection: changed });
      const entry = preview.report.boundaries[0]!;
      expect(entry.changed_field_types).toContainEqual({
        resource_id: "public.order_items",
        field: "quantity",
      });
      expect(entry.pruned_review_inputs).toEqual(expect.arrayContaining([
        expect.stringMatching(/quantity.*reviewed auto band no longer validates/i),
      ]));
      expect(entry.invalidated_decisions.map((decision) => decision.id)).toContain(
        "resource.public.order_items.field_permissions",
      );
      expect(preview.selectedProgress.candidate.pack.resources.find(
        (resource) => resource.id === "public.order_items",
      )?.auto_bands).toBeUndefined();
      expect(preview.selectedProgress.review_overrides.resources["public.order_items"]?.auto_bands)
        .toBeUndefined();
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

async function writeReviewedCommerceProject(
  root: string,
  activate = false,
  inspectionInput?: SchemaInspection,
): Promise<{
  inspection: SchemaInspection;
  activeDigest?: `sha256:${string}`;
}> {
  const inspection = inspectionInput ?? normalizedCommerceInspection();
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
  overrides = applyManagedBoundaryReviewDecision(overrides, {
    kind: "auto_band",
    resource_id: "public.order_items",
    field: "quantity",
    definition: reviewedQuantityAutoBand(),
    actor: "owner@example.test",
    reason: "Allow bounded adaptive quantity groups without model-authored edges.",
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

async function writeRunnerConfig(root: string, input: {
  provider: "environment" | "http_claims";
  tenantBinding?: string;
  principalBinding?: string;
  tenantClaim?: string;
  principalClaim?: string;
}): Promise<void> {
  const config = {
    version: 1,
    mode: "read_only",
    sources: {
      local_postgres: {
        engine: "postgres",
        read_url_env: "DATABASE_URL",
      },
    },
    trusted_context: input.provider === "environment"
      ? {
          provider: "environment",
          values: {
            tenant_id_env: "SYNAPSOR_TENANT_ID",
            principal_env: "SYNAPSOR_PRINCIPAL",
          },
          ...(input.tenantBinding ? { tenant_binding: input.tenantBinding } : {}),
          ...(input.principalBinding ? { principal_binding: input.principalBinding } : {}),
        }
      : {
          provider: "http_claims",
          ...(input.tenantBinding ? { tenant_binding: input.tenantBinding } : {}),
          ...(input.principalBinding ? { principal_binding: input.principalBinding } : {}),
        },
    capabilities: [{
      name: "test.inspect_order",
      kind: "read",
      source: "local_postgres",
      target: {
        schema: "public",
        table: "orders",
        primary_key: "id",
        tenant_key: "tenant_id",
      },
      args: {
        order_id: {
          type: "string",
          required: true,
          max_length: 128,
        },
      },
      lookup: { id_from_arg: "order_id" },
      visible_columns: ["id", "status"],
      evidence: "required",
      max_rows: 1,
    }],
    ...(input.provider === "http_claims"
      ? {
          session_auth: {
            provider: "jwt_asymmetric",
            algorithms: ["RS256"],
            public_key_env: "SYNAPSOR_SESSION_PUBLIC_KEY",
            issuer: "https://identity.example",
            audience: "https://runner.example/mcp",
            tenant_claim: input.tenantClaim ?? "tenant_id",
            principal_claim: input.principalClaim ?? "sub",
          },
        }
      : {}),
  };
  await fs.writeFile(
    path.join(root, "synapsor.runner.json"),
    `${JSON.stringify(config, null, 2)}\n`,
  );
}

function reviewedQuantityAutoBand() {
  return {
    field: "quantity",
    methods: ["quantile", "equal_width"] as Array<"quantile" | "equal_width">,
    min_buckets: 2,
    max_buckets: 8,
    min_bucket_width: 2,
    label_style: "ordinal" as const,
  };
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
