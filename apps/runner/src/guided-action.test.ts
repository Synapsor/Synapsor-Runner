import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMcpRuntime,
  loadRuntimeConfigFromFile,
} from "@synapsor-runner/mcp-server";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  activateExplorationBoundary,
  buildAutoBoundary,
  deactivateExplorationBoundary,
  explorationBoundaryCandidateDigest,
  reviewExplorationBoundaryCandidate,
  writeAutoBoundaryArtifacts,
} from "./auto-boundary.js";
import {
  activateGuidedAction,
  activateGuidedActionBoundary,
  createGuidedActionDraft,
  discardGuidedActionDraft,
  guidedActionStatus,
  guidedActionOptions,
  guidedActionOptionsFromCandidate,
  prepareGuidedActionPreview,
  readGuidedActionDesignInput,
  recordGuidedActionBoundaryLimits,
  recordGuidedActionPreview,
  recordGuidedActionStructuralPreview,
  reviseGuidedActionBoundary,
  reviseGuidedActionAuthority,
} from "./guided-action.js";
import { initializeGuidedProject } from "./guided-project.js";
import { actionCommand } from "./boundary-commands.js";
import {
  boundaryReviewDecisions,
} from "./boundary-review-domain.js";
import {
  readBoundaryReviewProgress,
  saveInstantBoundaryReviewBaseline,
} from "./boundary-review-persistence.js";
import { readActionBoundaryActivation, readActionBoundaryDraft } from "./action-boundary.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("guided write actions", () => {
  it("keeps Action Boundary field review independent from minimized Read Boundary row returns", async () => {
    const fixture = await activatedFitFlowFixture();
    const generatedDraft = structuredClone(fixture.candidate);
    const minimizedCandidate = structuredClone(generatedDraft);
    const resource = minimizedCandidate.pack.resources[0]!;
    resource.selectable_fields = [];
    resource.sortable_fields = [];
    resource.filterable_fields = {};
    const candidate = reviewExplorationBoundaryCandidate(
      generatedDraft,
      minimizedCandidate,
    ).candidate;

    const options = guidedActionOptionsFromCandidate({
      candidate,
      inspection: fixture.inspection,
    });

    expect(options.resources[0]).toMatchObject({
      id: "public.members",
      writable_fields: expect.arrayContaining([
        expect.objectContaining({ name: "membership_status" }),
        expect.objectContaining({ name: "loyalty_balance" }),
      ]),
      structurally_eligible_fields: expect.arrayContaining([
        expect.objectContaining({ name: "membership_status" }),
        expect.objectContaining({ name: "loyalty_balance" }),
      ]),
      operation_availability: {
        update: { available: true },
        insert: { available: true },
      },
    });
    expect(options.resources[0]?.kept_out_fields).toEqual(expect.arrayContaining([
      "payment_method",
      "medical_notes",
      "organization_id",
      "assigned_trainer_id",
    ]));

    await deactivateExplorationBoundary(fixture.root, candidate.pack.name);
    const { progress } = await saveInstantBoundaryReviewBaseline({
      projectRoot: fixture.root,
      draft: generatedDraft,
      candidate,
      actor: "reviewer@example.test",
    });
    expect(progress.confirmed_decisions).toEqual(
      boundaryReviewDecisions(candidate).map((decision) => decision.decision),
    );
    const reloadedProgress = await readBoundaryReviewProgress(fixture.root, generatedDraft);
    expect(reloadedProgress).toMatchObject({
      candidate: { pack: { name: candidate.pack.name } },
      policy_migration: { status: "complete" },
    });
    expect(new Set(reloadedProgress!.confirmed_decisions)).toEqual(
      new Set(boundaryReviewDecisions(reloadedProgress!.candidate).map((decision) => decision.decision)),
    );
    const created = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      boundaryName: candidate.pack.name,
      allowReviewedPending: true,
      action: {
        capability_name: "membership.propose_minimized_status",
        description: "Propose one bounded status change without widening read output.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "membership_status",
          value_source: "argument",
          argument_name: "membership_status",
          allowed_from: ["active"],
        }],
        confirmed_trusted_scope: true,
      },
    });
    expect(created.dsl).toContain("ALLOW READ id, membership_status, version");
    expect(created.dsl).toContain("MODEL WITHHELD id, membership_status, version");
    expect(created.contract.capabilities[0]).toMatchObject({
      visible_fields: ["id", "membership_status", "version"],
      model_withheld_fields: ["id", "membership_status", "version"],
    });
    expect(candidate.pack.resources[0]?.selectable_fields).toEqual([]);
  });

  it("never exposes a model-withheld field as an Action proposal argument", async () => {
    const fixture = await activatedFitFlowFixture();
    const candidate = structuredClone(fixture.candidate);
    const resource = candidate.pack.resources[0]!;
    resource.model_withheld_fields = [...new Set([
      ...(resource.model_withheld_fields ?? []),
      "loyalty_balance",
    ])];

    const options = guidedActionOptionsFromCandidate({
      candidate,
      inspection: fixture.inspection,
    });
    const fields = options.resources[0]?.structurally_eligible_fields.map((field) => field.name) ?? [];

    expect(fields).not.toContain("loyalty_balance");
    expect(options.resources[0]?.writable_fields.map((field) => field.name)).not.toContain("loyalty_balance");
  });

  it("authors and runs proposal-only UPDATE under reviewed single-organization scope", async () => {
    const fixture = await activatedFitFlowFixture({ singleOrganization: true });
    const options = await guidedActionOptions({ projectRoot: fixture.root, inspection: fixture.inspection });
    expect(options.resources).toHaveLength(1);
    expect(options.resources[0]).toMatchObject({
      id: "public.members",
      organization_scope: {
        mode: "single_organization",
        organization_id: "northgate-library",
      },
      operation_availability: {
        update: { available: true },
        insert: { available: false, reason: expect.stringMatching(/proposal-only|deduplication/i) },
        delete: { available: true },
      },
    });
    expect(options.resources[0]).not.toHaveProperty("tenant_key");

    const created = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.set_whole_library_status",
        description: "Propose one reviewed membership status change for this library.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "membership_status",
          value_source: "argument",
          argument_name: "membership_status",
          allowed_from: ["active", "frozen"],
        }],
        confirmed_trusted_scope: true,
      },
      actionBoundaryJobIntent: "Help library staff manage membership status changes.",
    });
    expect(created.dsl).toContain("BIND tenant_id FROM REVIEWED_ORGANIZATION northgate-library REQUIRED");
    expect(created.dsl).toContain("ACTION SINGLE ORGANIZATION 'northgate-library' ACKNOWLEDGED");
    expect(created.dsl).toContain("WRITEBACK NONE");
    expect(created.dsl).not.toContain("TENANT KEY");
    expect(created.contract.capabilities[0]?.proposal?.organization_scope).toMatchObject({
      organization_id: "northgate-library",
    });
    await expect(readActionBoundaryDraft(fixture.root)).resolves.toMatchObject({
      state: "disabled",
      job_intent: "Help library staff manage membership status changes.",
    });

    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      contractDigest: created.draft.contract_digest,
      actionBoundaryDigest: created.draft.action_boundary_digest!,
      proposalId: "wrp_single_org_preview",
      proposalHash: `sha256:${"8".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    const active = await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: created.draft.action_boundary_digest!,
      confirmation: `ACTIVATE ${created.draft.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    });
    expect(active).toMatchObject({
      authority_posture: "proposal_only",
      writeback_mode: "none",
      source_database_changed: false,
    });

    const actionConfigPath = path.join(fixture.root, "synapsor.actions.runner.json");
    const runtime = createMcpRuntime(loadRuntimeConfigFromFile(actionConfigPath), {
      storePath: path.join(fixture.root, ".synapsor/single-org-action-test.db"),
      env: {
        DATABASE_URL: "postgresql://reader:redacted@db.example/fitflow",
        SYNAPSOR_PRINCIPAL: "librarian-17",
      },
      generatedAuthorityInspector: async () => fixture.inspection,
      readRow: async ({ context }) => {
        expect(context).toMatchObject({
          tenant_id: "northgate-library",
          principal: "librarian-17",
        });
        return {
          row: {
            id: "member-1",
            organization_id: "northgate-library",
            assigned_trainer_id: "librarian-17",
            membership_status: "active",
            membership_tier: "plus",
            loyalty_balance: 25,
            version: 4,
          },
          rowCount: 1,
        };
      },
    });
    try {
      const proposed = await runtime.callTool(created.draft.capability, {
        member_id: "member-1",
        membership_status: "frozen",
      });
      expect(proposed).toMatchObject({
        ok: true,
        source_database_changed: false,
        proposal: { writeback: { mode: "proposal_only", applied: false } },
      });
      const proposalId = (proposed.proposal as { id: string }).id;
      expect(runtime.store.getProposal(proposalId)).toMatchObject({
        tenant_id: "northgate-library",
        principal: "librarian-17",
        source_database_mutated: false,
        change_set: {
          guards: {
            tenant: { column: "__reviewed_organization", value: "northgate-library" },
          },
          writeback: { mode: "read_only", executor: "none" },
        },
      });
    } finally {
      await runtime.close();
    }

    await expect(reviseGuidedActionAuthority({
      projectRoot: fixture.root,
      capabilityName: active.capability,
      expectedCurrentDigest: active.contract_digest,
      authority: { authority_posture: "executable", writeback: { mode: "direct_sql" } },
      inspection: fixture.inspection,
    })).rejects.toThrow(/GUIDED_ACTION_ORGANIZATION_PROPOSAL_ONLY/);

    await expect(createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.create_whole_library_member",
        description: "Propose a new membership.",
        resource: "public.members",
        operation: "insert",
        approval_role: "membership_reviewer",
        patches: [{
          column: "membership_status",
          value_source: "fixed",
          fixed_value: "active",
        }],
        confirmed_trusted_scope: true,
      },
    })).rejects.toThrow(/GUIDED_ACTION_ORGANIZATION_INSERT_UNSUPPORTED/);
  }, 30_000);

  it("drafts and rehearses against a fully reviewed pending read boundary but gates activation", async () => {
    const fixture = await activatedFitFlowFixture();
    const boundaryName = fixture.candidate.pack.name;
    await deactivateExplorationBoundary(fixture.root, boundaryName);
    await saveInstantBoundaryReviewBaseline({
      projectRoot: fixture.root,
      draft: fixture.candidate,
      candidate: fixture.candidate,
      actor: "reviewer@example.test",
    });

    const options = await guidedActionOptions({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      boundaryName,
      allowReviewedPending: true,
    });
    expect(options).toMatchObject({
      boundary_name: boundaryName,
      boundary_state: "reviewed_pending",
      boundary_digest: explorationBoundaryCandidateDigest(fixture.candidate),
    });

    const created = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      boundaryName,
      allowReviewedPending: true,
      action: {
        capability_name: "membership.propose_pending_loyalty_balance",
        description: "Propose a reviewed loyalty balance for one assigned member.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 500,
        }],
        confirmed_trusted_scope: true,
      },
    });
    expect(created.draft).toMatchObject({
      state: "disabled",
      boundary_name: boundaryName,
      boundary_digest: options.boundary_digest,
    });

    const preview = await prepareGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
    });
    expect(preview.draft_digest).toBe(created.draft.contract_digest);
    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      contractDigest: created.draft.contract_digest,
      actionBoundaryDigest: created.draft.action_boundary_digest!,
      proposalId: "wrp_pending_read_preview",
      proposalHash: `sha256:${"b".repeat(64)}`,
      sourceDatabaseChanged: false,
    });

    const actionBoundary = await reviseGuidedActionBoundary({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      sharedLimits: [{
        id: "tenant_principal_pending_daily",
        kind: "count",
        scope: "tenant_principal",
        capability: created.draft.capability,
        maximum: 10,
        window_seconds: 86_400,
      }],
    });
    const rebased = (await guidedActionStatus(fixture.root)).drafts.find(
      (draft) => draft.capability === created.draft.capability,
    );
    if (!rebased) throw new Error("Expected the disabled Action draft to be rebased.");
    expect(rebased).toMatchObject({
      contract_digest: created.draft.contract_digest,
      action_boundary_name: actionBoundary.name,
      action_boundary_digest: actionBoundary.digest,
    });
    expect(rebased.effect_preview).toBeUndefined();

    const activation = {
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: rebased.action_boundary_digest!,
      confirmation: `ACTIVATE ${rebased.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    };
    await expect(activateGuidedAction(activation)).rejects.toThrow(
      /GUIDED_ACTION_READ_DEPENDENCY_INACTIVE/,
    );

    const readDigest = explorationBoundaryCandidateDigest(fixture.candidate);
    await activateExplorationBoundary({
      projectRoot: fixture.root,
      candidate: fixture.candidate,
      expectedDigest: readDigest,
      actor: "reviewer@example.test",
      confirmation: `ACTIVATE ${readDigest}`,
      confirmedDecisions: fixture.candidate.unresolved_decisions,
      currentInspection: fixture.inspection,
    });
    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: rebased.capability,
      contractDigest: rebased.contract_digest,
      actionBoundaryDigest: rebased.action_boundary_digest!,
      proposalId: "wrp_pending_read_rehearsed_after_limit_change",
      proposalHash: `sha256:${"d".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    await expect(activateGuidedAction(activation)).resolves.toMatchObject({
      state: "active",
      capability: created.draft.capability,
      authority_posture: "proposal_only",
      writeback_mode: "none",
      source_database_changed: false,
    });
  });

  it("emits a disabled bounded update with optional auto-approval through public DSL", async () => {
    const fixture = await activatedFitFlowFixture();
    const options = await guidedActionOptions({ projectRoot: fixture.root, inspection: fixture.inspection });
    expect(options.resources[0]).toMatchObject({
      id: "public.members",
      primary_key: "id",
      tenant_key: "organization_id",
      principal_key: "assigned_trainer_id",
      operation_availability: {
        update: { available: true },
        insert: { available: true },
        delete: { available: true },
      },
    });
    expect(options.resources[0]?.insert_dedup_candidates).toEqual(["request_id"]);
    expect(options.resources[0]?.kept_out_fields).toEqual(expect.arrayContaining([
      "payment_method",
      "medical_notes",
      "organization_id",
      "assigned_trainer_id",
    ]));

    const created = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      now: "2026-07-24T18:00:00.000Z",
      action: {
        capability_name: "membership.set_loyalty_balance",
        description: "Propose a reviewed loyalty balance for one assigned member.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        auto_approval: {
          field: "loyalty_balance",
          maximum: 100,
          max_per_day: 20,
          max_total_per_day: 1000,
        },
        supervised_worker_execution: true,
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          argument_description: "Reviewed loyalty balance.",
          minimum: 0,
          maximum: 500,
        }],
        confirmed_trusted_scope: true,
      },
    });

    expect(created.dsl).toContain("CREATE CAPABILITY membership.set_loyalty_balance");
    expect(created.dsl).toContain("PRINCIPAL SCOPE KEY assigned_trainer_id");
    expect(created.dsl).toContain("BOUND loyalty_balance 0..500");
    expect(created.dsl).toContain("AUTO APPROVE WHEN loyalty_balance <= 100");
    expect(created.dsl).toContain("LIMIT 20 PER DAY");
    expect(created.dsl).toContain("LIMIT TOTAL 1000 OF loyalty_balance PER DAY");
    expect(created.dsl).toContain("ALLOW SUPERVISED WORKER APPLY");
    expect(created.dsl).not.toMatch(/execute_sql|sql\s+string/i);
    expect(created.contract.capabilities[0]?.proposal).toMatchObject({
      operation: {
        kind: "update",
        version_advance: { column: "version", strategy: "integer_increment" },
      },
      allowed_fields: ["loyalty_balance"],
      conflict_guard: { column: "version" },
      approval: { mode: "policy", required_role: "membership_reviewer" },
      execution: { supervised_worker: "allowed" },
    });
    expect(created.draft).toMatchObject({
      state: "disabled",
      source: "local_postgres",
      supervised_worker_execution: true,
      action_boundary_name: "default_action_boundary",
      action_boundary_digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    await expect(readActionBoundaryDraft(fixture.root)).resolves.toMatchObject({
      state: "disabled",
      digest: created.draft.action_boundary_digest,
      authority: {
        capabilities: [{ capability: created.draft.capability, contract_digest: created.draft.contract_digest }],
      },
    });
    await expect(fs.readFile(path.join(fixture.root, created.draft.dsl_path), "utf8")).resolves.toBe(created.dsl);
    await expect(readGuidedActionDesignInput(
      fixture.root,
      "membership.set_loyalty_balance",
      "draft",
    )).resolves.toMatchObject({
      capability_name: "membership.set_loyalty_balance",
      resource: "public.members",
      operation: "update",
      authority_posture: "supervised_execution",
      confirmed_trusted_scope: true,
    });
    await expect(discardGuidedActionDraft({
      projectRoot: fixture.root,
      capabilityName: "membership.set_loyalty_balance",
      expectedDigest: `sha256:${"0".repeat(64)}`,
    })).rejects.toThrow(/GUIDED_ACTION_DRAFT_CHANGED/);
    await expect(discardGuidedActionDraft({
      projectRoot: fixture.root,
      capabilityName: "membership.set_loyalty_balance",
      expectedDigest: created.draft.contract_digest,
    })).resolves.toMatchObject({
      capability: "membership.set_loyalty_balance",
      source_database_changed: false,
    });
    await expect(readGuidedActionDesignInput(
      fixture.root,
      "membership.set_loyalty_balance",
      "draft",
    )).rejects.toThrow(/GUIDED_ACTION_DRAFT_REQUIRED/);
  });

  it("advertises proposal operations when trusted tenant scope completes the source primary key", async () => {
    const fixture = await activatedFitFlowFixture({ compositePrimaryKey: true });
    const options = await guidedActionOptions({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
    });

    expect(options.resources[0]).toMatchObject({
      id: "public.members",
      primary_key: "id",
      operation_availability: {
        insert: { available: true },
        update: { available: true },
        delete: { available: true },
      },
    });

    await expect(createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.propose_scoped_member",
        description: "Propose one reviewed member under trusted tenant scope.",
        resource: "public.members",
        operation: "insert",
        dedup_proposal_column: "request_id",
        approval_role: "membership_reviewer",
        patches: [
          { column: "membership_status", value_source: "fixed", fixed_value: "active" },
          { column: "membership_tier", value_source: "argument", argument_name: "membership_tier" },
          {
            column: "loyalty_balance",
            value_source: "argument",
            argument_name: "loyalty_balance",
            minimum: 0,
            maximum: 500,
          },
        ],
        confirmed_trusted_scope: true,
      },
    })).resolves.toMatchObject({
      draft: {
        capability: "membership.propose_scoped_member",
        state: "disabled",
      },
      dsl: expect.stringContaining("DEDUP KEY organization_id = TRUSTED TENANT, request_id = PROPOSAL ID"),
    });
  });

  it("names a required unreviewed INSERT column instead of misreporting deduplication", async () => {
    const fixture = await activatedFitFlowFixture({ hiddenRequiredInsertField: true });
    const options = await guidedActionOptions({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
    });

    expect(options.resources[0]).toMatchObject({
      id: "public.members",
      insert_dedup_candidates: [],
      operation_availability: {
        insert: {
          available: false,
          reason: expect.stringMatching(/required insert column service_window.*not reviewed.*no source default/i),
        },
      },
    });
    expect(options.resources[0]?.operation_availability.insert.reason).not.toMatch(/no primary\/unique/i);
  });

  it("keeps proposal operations blocked when a source primary-key component is not trusted scope", async () => {
    const fixture = await activatedFitFlowFixture({ untrustedPrimaryKeyComponent: true });
    const options = await guidedActionOptions({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
    });

    for (const availability of Object.values(options.resources[0]!.operation_availability)) {
      expect(availability.available).toBe(false);
      expect(availability.reason).toContain("direct trusted scope");
    }
  });

  it("does not invent a required principal binding for a tenant-only reviewed resource", async () => {
    const fixture = await activatedFitFlowFixture({ principalScoped: false });
    const options = await guidedActionOptions({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
    });
    expect(options.resources[0]?.principal_key).toBeUndefined();

    const created = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.propose_tenant_only_balance",
        description: "Propose one bounded tenant-only membership balance.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 500,
        }],
        confirmed_trusted_scope: true,
      },
    });
    expect(created.dsl).toContain("BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED");
    expect(created.dsl).not.toContain("BIND principal");
    expect(created.dsl).not.toContain("PRINCIPAL BINDING");
    expect(created.contract.contexts[0]).not.toHaveProperty("principal_binding");

    const prepared = await prepareGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
    });
    const runtime = createMcpRuntime(
      runtimeConfigForMockRead(path.join(fixture.root, prepared.config_path)),
      {
        storePath: ":memory:",
        env: {
          DATABASE_URL: "postgresql://reader:redacted@db.example/fitflow",
          SYNAPSOR_TENANT_ID: "acme",
          USER: "local-reviewer",
        },
        readRow: async ({ context }) => {
          expect(context).toMatchObject({
            tenant_id: "acme",
            principal: "local-reviewer",
            provenance: "environment",
          });
          return {
            row: {
              id: "member-1",
              organization_id: "acme",
              membership_status: "active",
              membership_tier: "plus",
              loyalty_balance: 25,
              version: 4,
            },
            rowCount: 1,
          };
        },
      },
    );
    try {
      const proposed = await runtime.callTool(created.draft.capability, {
        member_id: "member-1",
        loyalty_balance: 100,
      });
      expect(proposed).toMatchObject({
        ok: true,
        kind: "proposal",
        source_database_changed: false,
      });
      const proposalId = String(
        proposed.proposal_id
          ?? (proposed.proposal as { id?: string } | undefined)?.id
          ?? "",
      );
      expect(await runtime.store.getProposal(proposalId)).toMatchObject({
        change_set: {
          principal: {
            id: "local-reviewer",
            source: "environment",
          },
          guards: {
            tenant: { column: "organization_id", value: "acme" },
          },
        },
      });
    } finally {
      await runtime.close();
    }
  });

  it("does not advertise or accept guarded writes with relationship-carried principal scope", async () => {
    const fixture = await activatedDerivedPrincipalWriteFixture();
    const options = await guidedActionOptions({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
    });
    expect(options.resources.map((resource) => resource.id)).not.toContain("public.members");
    expect(options.blocked_resources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "public.members",
        reasons: expect.arrayContaining([expect.stringMatching(/direct principal column/i)]),
      }),
    ]));

    await expect(createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.set_derived_loyalty_balance",
        description: "Propose a reviewed loyalty balance.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 500,
        }],
        confirmed_trusted_scope: true,
      },
    })).rejects.toThrow(/GUIDED_ACTION_DIRECT_PRINCIPAL_REQUIRED/);
  });

  it("emits reversible human-reviewed transitions and blocks unsafe policy combinations", async () => {
    const fixture = await activatedFitFlowFixture();
    const base = {
      projectRoot: fixture.root,
      inspection: fixture.inspection,
    };
    await expect(createGuidedActionDraft({
      ...base,
      action: {
        capability_name: "membership.bad_fractional_integer_bounds",
        description: "Invalid fractional bounds for an integer source column.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0.5,
          maximum: 500,
        }],
        confirmed_trusted_scope: true,
      },
    })).rejects.toThrow(/GUIDED_ACTION_INTEGER_BOUNDS_REQUIRED/);

    await expect(createGuidedActionDraft({
      ...base,
      action: {
        capability_name: "membership.bad_fractional_integer_policy",
        description: "Invalid fractional policy value for an integer source column.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 500,
        }],
        auto_approval: {
          conditions: [{ field: "loyalty_balance", operator: "lte", value: 100.5 }],
          max_per_day: 10,
        },
        confirmed_trusted_scope: true,
      },
    })).rejects.toThrow(/GUIDED_ACTION_AUTO_APPROVAL_INTEGER_REQUIRED/);

    const freeze = await createGuidedActionDraft({
      ...base,
      action: {
        capability_name: "membership.freeze_membership",
        description: "Propose freezing one assigned membership from a reviewed active state.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "membership_status",
          value_source: "fixed",
          fixed_value: "frozen",
          allowed_from: ["active"],
        }],
        reversible: true,
        confirmed_trusted_scope: true,
      },
    });
    expect(freeze.dsl).toContain("TRANSITION membership_status ALLOW 'active' -> 'frozen'");
    expect(freeze.dsl).toContain("REVERSIBLE");
    expect(freeze.contract.capabilities[0]?.proposal).toMatchObject({
      approval: { mode: "human" },
      reversibility: { mode: "reviewed_inverse" },
    });

    await expect(createGuidedActionDraft({
      ...base,
      action: {
        capability_name: "membership.bad_reversible_policy",
        description: "Invalid combination.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 500,
        }],
        reversible: true,
        auto_approval: { field: "loyalty_balance", maximum: 100, max_per_day: 10, max_total_per_day: 500 },
        confirmed_trusted_scope: true,
      },
    })).rejects.toThrow(/REVERSIBLE_AUTO_APPROVAL_FORBIDDEN/);

    await expect(createGuidedActionDraft({
      ...base,
      action: {
        capability_name: "membership.expose_payment",
        description: "Invalid sensitive write.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "payment_method",
          value_source: "argument",
          argument_name: "payment_method",
          max_length: 100,
        }],
        confirmed_trusted_scope: true,
      },
    })).rejects.toThrow(/FIELD_NOT_REVIEWED/);

    await expect(createGuidedActionDraft({
      ...base,
      action: {
        capability_name: "membership.delete_member",
        description: "Invalid auto-approved delete.",
        resource: "public.members",
        operation: "delete",
        conflict_column: "version",
        approval_role: "membership_reviewer",
        auto_approval: { field: "version", maximum: 1, max_per_day: 1, max_total_per_day: 1 },
        confirmed_trusted_scope: true,
        delete_confirmation: "DELETE public.members",
      },
    })).rejects.toThrow(/DELETE_AUTO_APPROVAL_FORBIDDEN/);

    await expect(createGuidedActionDraft({
      ...base,
      action: {
        capability_name: "membership.bad_auto_approval_bound",
        description: "Invalid policy threshold below the reviewed business range.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 200,
          maximum: 500,
        }],
        auto_approval: {
          field: "loyalty_balance",
          maximum: 100,
          max_per_day: 10,
          max_total_per_day: 500,
        },
        confirmed_trusted_scope: true,
      },
    })).rejects.toThrow(/AUTO_APPROVAL_BOUND_INVALID/);

    await expect(createGuidedActionDraft({
      ...base,
      action: {
        capability_name: "membership.bad_reversible_worker",
        description: "Invalid reversible supervised combination.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 500,
        }],
        reversible: true,
        supervised_worker_execution: true,
        confirmed_trusted_scope: true,
      },
    })).rejects.toThrow(/REVERSIBLE_SUPERVISED_WORKER_FORBIDDEN/);

    await expect(createGuidedActionDraft({
      ...base,
      action: {
        capability_name: "membership.bad_delete_worker",
        description: "Invalid supervised hard delete.",
        resource: "public.members",
        operation: "delete",
        conflict_column: "version",
        approval_role: "membership_reviewer",
        supervised_worker_execution: true,
        confirmed_trusted_scope: true,
        delete_confirmation: "DELETE public.members",
      },
    })).rejects.toThrow(/DELETE_SUPERVISED_WORKER_FORBIDDEN/);
  });

  it("rebases multiple disabled action drafts as each reviewed revision becomes active", async () => {
    const fixture = await activatedFitFlowFixture();
    const freeze = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      actionBoundaryJobIntent: "Let membership staff propose bounded account changes.",
      action: {
        capability_name: "membership.freeze_membership",
        description: "Propose freezing one assigned active membership.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "membership_status",
          value_source: "fixed",
          fixed_value: "frozen",
          allowed_from: ["active"],
        }],
        confirmed_trusted_scope: true,
      },
    });
    const balance = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.set_loyalty_balance",
        description: "Propose a reviewed loyalty balance for one assigned member.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 500,
        }],
        confirmed_trusted_scope: true,
      },
    });
    expect(freeze.draft.action_boundary_digest).not.toBe(balance.draft.action_boundary_digest);
    for (const [draft, marker] of [[freeze.draft, "a"], [balance.draft, "b"]] as const) {
      await recordGuidedActionPreview({
        projectRoot: fixture.root,
        capabilityName: draft.capability,
        contractDigest: draft.contract_digest,
        actionBoundaryDigest: draft.action_boundary_digest!,
        proposalId: `wrp_multi_${marker}`,
        proposalHash: `sha256:${marker.repeat(64)}`,
        sourceDatabaseChanged: false,
      });
    }

    await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: freeze.draft.capability,
      expectedDigest: freeze.draft.action_boundary_digest!,
      confirmation: `ACTIVATE ${freeze.draft.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    });
    const afterFirst = await guidedActionStatus(fixture.root);
    expect(afterFirst.activations.map((item) => item.capability)).toEqual([freeze.draft.capability]);
    expect(afterFirst.drafts.map((item) => item.capability)).toEqual([balance.draft.capability]);
    expect(afterFirst.drafts[0]?.effect_preview).toBeUndefined();
    expect(afterFirst.drafts[0]?.action_boundary_digest).not.toBe(balance.draft.action_boundary_digest);
    expect(afterFirst.action_boundary.draft?.authority.capabilities.map((item) => item.capability).sort()).toEqual([
      balance.draft.capability,
      freeze.draft.capability,
    ].sort());

    const rebasedBalance = afterFirst.drafts[0]!;
    await expect(activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: rebasedBalance.capability,
      expectedDigest: rebasedBalance.action_boundary_digest!,
      confirmation: `ACTIVATE ${rebasedBalance.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    })).rejects.toThrow(/GUIDED_ACTION_EFFECT_PREVIEW_REQUIRED/);
    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: rebasedBalance.capability,
      contractDigest: rebasedBalance.contract_digest,
      actionBoundaryDigest: rebasedBalance.action_boundary_digest!,
      proposalId: "wrp_multi_b_rebased",
      proposalHash: `sha256:${"e".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: rebasedBalance.capability,
      expectedDigest: rebasedBalance.action_boundary_digest!,
      confirmation: `ACTIVATE ${rebasedBalance.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    });
    const complete = await guidedActionStatus(fixture.root);
    expect(complete.drafts).toEqual([]);
    expect(complete.action_boundary.draft).toBeUndefined();
    expect(complete.action_boundary.active?.authority.capabilities.map((item) => item.capability).sort()).toEqual([
      balance.draft.capability,
      freeze.draft.capability,
    ].sort());
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(fixture.root, "synapsor.actions.runner.json"), "utf8"),
    );
    expect(runtimeConfig.contracts).toHaveLength(2);
  }, 30_000);

  it("preserves semantic outcome worker authority when a proposal-only legacy action is activated", async () => {
    const fixture = await activatedFitFlowFixture();
    const first = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.freeze_membership",
        description: "Propose freezing one assigned active membership.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "membership_status",
          value_source: "fixed",
          fixed_value: "frozen",
          allowed_from: ["active"],
        }],
        confirmed_trusted_scope: true,
      },
    });
    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: first.draft.capability,
      contractDigest: first.draft.contract_digest,
      actionBoundaryDigest: first.draft.action_boundary_digest!,
      proposalId: "wrp_semantic_coexist_first",
      proposalHash: `sha256:${"a".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: first.draft.capability,
      expectedDigest: first.draft.action_boundary_digest!,
      confirmation: `ACTIVATE ${first.draft.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    });
    const actionConfigPath = path.join(fixture.root, "synapsor.actions.runner.json");
    const actionConfig = JSON.parse(await fs.readFile(actionConfigPath, "utf8"));
    actionConfig.sources.local_postgres.read_only = false;
    actionConfig.sources.local_postgres.write_url_env = "SYNAPSOR_DATABASE_WRITE_URL";
    actionConfig.sources.local_postgres.receipts = { authority: "runner_ledger" };
    actionConfig.supervised_worker = {
      enabled: true,
      profile: "staging",
      capabilities: [],
      outcomes: [{
        outcome: "membership.recalculate_tier",
        action_boundary_digest: `sha256:${"e".repeat(64)}`,
        mode: "supervised_worker",
        concurrency: 1,
        queue_limit: 100,
        lease_seconds: 300,
        max_attempts: 5,
        proposal_ttl_seconds: 86400,
        rate_limit: { executions: 60, window_seconds: 60 },
        write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
      }],
    };
    await fs.writeFile(actionConfigPath, `${JSON.stringify(actionConfig, null, 2)}\n`, "utf8");

    const second = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.set_loyalty_balance",
        description: "Propose a reviewed loyalty balance for one assigned member.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 500,
        }],
        confirmed_trusted_scope: true,
      },
    });
    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: second.draft.capability,
      contractDigest: second.draft.contract_digest,
      actionBoundaryDigest: second.draft.action_boundary_digest!,
      proposalId: "wrp_semantic_coexist_second",
      proposalHash: `sha256:${"b".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: second.draft.capability,
      expectedDigest: second.draft.action_boundary_digest!,
      confirmation: `ACTIVATE ${second.draft.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    });
    const after = JSON.parse(await fs.readFile(actionConfigPath, "utf8"));
    expect(after.sources.local_postgres).toMatchObject({
      read_only: false,
      write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
      receipts: { authority: "runner_ledger" },
    });
    expect(after.supervised_worker).toMatchObject({
      enabled: true,
      capabilities: [],
      outcomes: [{
        outcome: "membership.recalculate_tier",
        action_boundary_digest: `sha256:${"e".repeat(64)}`,
      }],
    });
  }, 30_000);

  it("reviews and activates shared cross-action limits as a separate exact boundary revision", async () => {
    const fixture = await activatedFitFlowFixture();
    const created = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.set_loyalty_balance",
        description: "Propose a reviewed loyalty balance for one assigned member.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 500,
        }],
        confirmed_trusted_scope: true,
      },
    });
    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      contractDigest: created.draft.contract_digest,
      actionBoundaryDigest: created.draft.action_boundary_digest!,
      proposalId: "wrp_limit_base",
      proposalHash: `sha256:${"c".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: created.draft.action_boundary_digest!,
      confirmation: `ACTIVATE ${created.draft.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    });

    await expect(reviseGuidedActionBoundary({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      sharedLimits: [{
        id: "invalid_total",
        kind: "total",
        scope: "tenant",
        capability: created.draft.capability,
        field: "membership_status",
        maximum: 100,
        window_seconds: 86_400,
      }],
    })).rejects.toThrow(/ACTION_BOUNDARY_TOTAL_FIELD_NOT_NUMERIC/);

    const revised = await reviseGuidedActionBoundary({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      sharedLimits: [
        {
          id: "tenant_daily_proposals",
          kind: "count",
          scope: "tenant",
          maximum: 20,
          window_seconds: 86_400,
        },
        {
          id: "principal_daily_balance",
          kind: "total",
          scope: "tenant_principal",
          capability: created.draft.capability,
          field: "loyalty_balance",
          maximum: 1_000,
          window_seconds: 86_400,
        },
      ],
      now: "2026-08-28T18:00:00.000Z",
    });
    const beforeActivation = await guidedActionStatus(fixture.root);
    expect(beforeActivation.action_boundary.active?.authority.shared_limits).toEqual([]);
    expect(beforeActivation.action_boundary.draft?.digest).toBe(revised.digest);
    expect(beforeActivation.action_boundary.draft?.authority.shared_limits).toHaveLength(2);
    await expect(activateGuidedActionBoundary({
      projectRoot: fixture.root,
      expectedDigest: revised.digest,
      confirmation: `ACTIVATE ${"0".repeat(64)}`,
      actor: "reviewer@example.test",
    })).rejects.toThrow(/ACTION_BOUNDARY_CONFIRMATION_REQUIRED/);
    const activated = await activateGuidedActionBoundary({
      projectRoot: fixture.root,
      expectedDigest: revised.digest,
      confirmation: `ACTIVATE ${revised.digest}`,
      actor: "reviewer@example.test",
      now: "2026-08-28T18:05:00.000Z",
    });
    expect(activated.digest).toBe(revised.digest);
    expect(activated.authority.shared_limits).toHaveLength(2);
    const afterActivation = await guidedActionStatus(fixture.root);
    expect(afterActivation.action_boundary.draft).toBeUndefined();
    expect(afterActivation.action_boundary.active?.digest).toBe(revised.digest);
    const runtimeConfig = JSON.parse(
      await fs.readFile(path.join(fixture.root, "synapsor.actions.runner.json"), "utf8"),
    );
    expect(runtimeConfig.action_boundary).toMatchObject({
      digest: revised.digest,
      authority: { shared_limits: revised.authority.shared_limits },
    });
  }, 30_000);

  it("reviews shared limits against a disabled action before its immutable revision exists", async () => {
    const fixture = await activatedFitFlowFixture();
    const created = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.propose_small_balance",
        description: "Propose one bounded loyalty balance for human or deterministic review.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 100,
        }],
        auto_approval: {
          conditions: [{ field: "loyalty_balance", operator: "lte", value: 100 }],
          max_per_day: 10,
          max_total_per_day: 500,
          total_field: "loyalty_balance",
        },
        confirmed_trusted_scope: true,
      },
    });

    const revised = await reviseGuidedActionBoundary({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      sharedLimits: [{
        id: "principal_daily_balance_before_activation",
        kind: "total",
        scope: "tenant_principal",
        capability: created.draft.capability,
        field: "loyalty_balance",
        maximum: 500,
        window_seconds: 86_400,
      }],
    });

    const status = await guidedActionStatus(fixture.root);
    expect(status.activations).toEqual([]);
    expect(status.action_boundary.active).toBeUndefined();
    expect(status.action_boundary.draft?.digest).toBe(revised.digest);
    expect(status.action_boundary.draft?.authority.shared_limits).toEqual([
      expect.objectContaining({
        id: "principal_daily_balance_before_activation",
        capability: created.draft.capability,
        field: "loyalty_balance",
      }),
    ]);
  }, 30_000);

  it("invalidates rehearsal and replaces stale per-draft limits when complete authority changes", async () => {
    const fixture = await activatedFitFlowFixture();
    const created = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.propose_bounded_balance",
        description: "Propose one bounded loyalty balance for deterministic or human review.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 500,
        }],
        auto_approval: {
          conditions: [{ field: "loyalty_balance", operator: "lte", value: 100 }],
          max_per_day: 10,
        },
        confirmed_trusted_scope: true,
      },
    });
    const originalLimit = [{
      id: "balance_per_principal",
      kind: "count" as const,
      scope: "tenant_principal" as const,
      capability: created.draft.capability,
      maximum: 3,
      window_seconds: 86_400,
    }];
    await recordGuidedActionBoundaryLimits({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      limits: originalLimit,
    });
    const firstBoundary = await reviseGuidedActionBoundary({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      sharedLimits: originalLimit,
    });
    const firstRehearsal = await recordGuidedActionStructuralPreview({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
    });
    expect(firstRehearsal.effect_preview?.action_boundary_digest).toBe(firstBoundary.digest);

    const replacementLimit = [{ ...originalLimit[0]!, maximum: 2 }];
    const secondBoundary = await reviseGuidedActionBoundary({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      sharedLimits: replacementLimit,
    });
    expect(secondBoundary.digest).not.toBe(firstBoundary.digest);
    expect(secondBoundary.authority.shared_limits).toEqual(replacementLimit);

    const status = await guidedActionStatus(fixture.root);
    const rebased = status.drafts.find((draft) => draft.capability === created.draft.capability);
    expect(rebased?.action_boundary_digest).toBe(secondBoundary.digest);
    expect(rebased?.action_boundary_shared_limits).toEqual(replacementLimit);
    expect(rebased?.effect_preview).toBeUndefined();
    await expect(activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: firstBoundary.digest,
      confirmation: `ACTIVATE ${firstBoundary.digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    })).rejects.toThrow(/GUIDED_ACTION_DRAFT_CHANGED/);

    const rehearsed = await recordGuidedActionStructuralPreview({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
    });
    expect(rehearsed.effect_preview?.action_boundary_digest).toBe(secondBoundary.digest);
    await expect(activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: secondBoundary.digest,
      confirmation: `ACTIVATE ${secondBoundary.digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    })).resolves.toMatchObject({
      state: "active",
      action_boundary_digest: secondBoundary.digest,
    });
  }, 30_000);

  it("keeps separate trusted-scope limits with two disabled action revisions", async () => {
    const fixture = await activatedFitFlowFixture();
    const create = (capabilityName: string, maximum: number) => createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: capabilityName,
        description: `Propose one bounded loyalty balance up to ${maximum}.`,
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum,
        }],
        auto_approval: {
          conditions: [{ field: "loyalty_balance", operator: "lte", value: maximum }],
          max_per_day: 1,
        },
        confirmed_trusted_scope: true,
      },
    });

    const first = await create("membership.propose_small_balance", 100);
    const firstLimits = [{
      id: "small_balance_per_principal",
      kind: "count" as const,
      scope: "tenant_principal" as const,
      capability: first.draft.capability,
      maximum: 1,
      window_seconds: 1_296_000,
    }];
    await recordGuidedActionBoundaryLimits({
      projectRoot: fixture.root,
      capabilityName: first.draft.capability,
      limits: firstLimits,
    });
    await reviseGuidedActionBoundary({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      sharedLimits: firstLimits,
    });

    const second = await create("membership.propose_routine_balance", 50);
    let status = await guidedActionStatus(fixture.root);
    expect(status.action_boundary.draft?.authority.capabilities.map((entry) => entry.capability))
      .toEqual([second.draft.capability]);
    expect(status.action_boundary.draft?.authority.shared_limits).toEqual([]);

    const secondLimits = [{
      id: "routine_balance_per_principal",
      kind: "count" as const,
      scope: "tenant_principal" as const,
      capability: second.draft.capability,
      maximum: 3,
      window_seconds: 86_400,
    }];
    await recordGuidedActionBoundaryLimits({
      projectRoot: fixture.root,
      capabilityName: second.draft.capability,
      limits: secondLimits,
    });
    await expect(reviseGuidedActionBoundary({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      sharedLimits: secondLimits,
    })).resolves.toBeDefined();

    status = await guidedActionStatus(fixture.root);
    expect(status.drafts.find((draft) => draft.capability === first.draft.capability)?.action_boundary_shared_limits)
      .toEqual(firstLimits);
    expect(status.drafts.find((draft) => draft.capability === second.draft.capability)?.action_boundary_shared_limits)
      .toEqual(secondLimits);
    await expect(prepareGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: first.draft.capability,
    })).resolves.toBeDefined();
    await expect(prepareGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: second.draft.capability,
    })).resolves.toBeDefined();
  }, 30_000);

  it("activates proposal-only first and promotes execution only through a new immutable revision", async () => {
    const fixture = await activatedFitFlowFixture();
    const created = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.set_loyalty_balance",
        description: "Propose a reviewed loyalty balance for one assigned member.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 500,
        }],
        confirmed_trusted_scope: true,
      },
    });
    await expect(activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: created.draft.action_boundary_digest!,
      confirmation: `ACTIVATE ${created.draft.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    })).rejects.toThrow(/EFFECT_PREVIEW_REQUIRED/);

    const preview = await prepareGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
    });
    await expect(fs.stat(path.join(fixture.root, preview.config_path))).resolves.toBeDefined();
    const previewConfig = JSON.parse(await fs.readFile(path.join(fixture.root, preview.config_path), "utf8"));
    expect(previewConfig.proposal_freshness).toBeUndefined();
    expect(previewConfig.sources.local_postgres).toMatchObject({
      read_url_env: "DATABASE_URL",
      read_only: true,
      database_scope: {
        mode: "postgres_rls",
        tenant_setting: "app.organization_id",
        principal_setting: "app.principal",
      },
    });
    expect(previewConfig.sources.local_postgres.write_url_env).toBeUndefined();
    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      contractDigest: created.draft.contract_digest,
      actionBoundaryDigest: created.draft.action_boundary_digest!,
      proposalId: "wrp_fitflow_preview",
      proposalHash: `sha256:${"a".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    const active = await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: created.draft.action_boundary_digest!,
      confirmation: `ACTIVATE ${created.draft.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    });
    expect(active).toMatchObject({
      state: "active",
      capability: "membership.set_loyalty_balance",
      authority_posture: "proposal_only",
      writeback_mode: "none",
      source_database_changed: false,
      boundary_name: "reviewed_staging",
      action_boundary_name: "default_action_boundary",
      action_boundary_digest: created.draft.action_boundary_digest,
    });
    await expect(readActionBoundaryActivation(fixture.root)).resolves.toMatchObject({
      state: "active",
      digest: active.action_boundary_digest,
      authority: {
        capabilities: [{ capability: active.capability, contract_digest: active.contract_digest }],
      },
    });
    const baseConfig = JSON.parse(await fs.readFile(path.join(fixture.root, "synapsor.runner.json"), "utf8"));
    expect(baseConfig.sources.local_postgres.read_only).toBe(true);
    const actionConfigPath = path.join(fixture.root, "synapsor.actions.runner.json");
    const config = JSON.parse(await fs.readFile(actionConfigPath, "utf8"));
    expect(config.mode).toBe("review");
    expect(config.production_explore).toBeUndefined();
    expect(config.action_rules).toEqual({ project_root: "./", legacy_tools: "enabled" });
    expect(config.sources.local_postgres).toMatchObject({
      read_url_env: "DATABASE_URL",
      read_only: true,
    });
    expect(config.sources.local_postgres.write_url_env).toBeUndefined();
    expect(config.contracts).toEqual([active.contract_path]);
    const proposalOnlyContract = JSON.parse(await fs.readFile(path.join(fixture.root, active.contract_path), "utf8"));
    expect(proposalOnlyContract.capabilities[0].proposal.writeback).toEqual({ mode: "none" });
    await expect(fs.readFile(path.join(fixture.root, active.design_path), "utf8")).resolves.toContain('"posture": "proposal_only"');
    const environmentBeforePromotion = await fs.readFile(path.join(fixture.root, ".env.example"), "utf8");
    expect(environmentBeforePromotion).not.toContain("SYNAPSOR_DATABASE_WRITE_URL=");

    let sourceReads = 0;
    const proposalRuntime = createMcpRuntime(runtimeConfigForMockRead(actionConfigPath), {
      storePath: path.join(fixture.root, ".synapsor/action-runtime-test.db"),
      env: {
        DATABASE_URL: "postgresql://reader:redacted@db.example/fitflow",
        SYNAPSOR_TENANT_ID: "acme",
        SYNAPSOR_PRINCIPAL: "trainer-17",
      },
      generatedAuthorityInspector: async () => fixture.inspection,
      readRow: async ({ context }) => {
        sourceReads += 1;
        expect(context).toMatchObject({
          tenant_id: "acme",
          principal: "trainer-17",
          provenance: "environment",
        });
        return {
          row: {
            id: "member-1",
            organization_id: "acme",
            assigned_trainer_id: "trainer-17",
            membership_status: "active",
            membership_tier: "plus",
            loyalty_balance: 25,
            version: 4,
          },
          rowCount: 1,
        };
      },
    });
    try {
      const tools = proposalRuntime.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["membership.set_loyalty_balance"]);
      expect(Object.keys(tools[0]!.input_schema).sort()).toEqual(["loyalty_balance", "member_id"]);
      expect(JSON.stringify(tools[0]!.input_schema)).not.toMatch(/approve|apply|activate|execute_sql|raw_sql|tenant_id|principal|writeback|credential/i);
      expect(tools[0]!.annotations).toMatchObject({
        raw_sql_exposed: false,
        approval_or_commit_tool: false,
      });
      const proposed = await proposalRuntime.callTool("membership.set_loyalty_balance", {
        member_id: "member-1",
        loyalty_balance: 100,
      });
      expect(proposed).toMatchObject({
        ok: true,
        kind: "proposal",
        source_database_changed: false,
        proposal: {
          state: "review_required",
          writeback: { mode: "proposal_only", applied: false },
        },
      });
      expect(sourceReads).toBe(1);
      const proposalView = proposed.proposal as { id: string };
      const stored = await proposalRuntime.store.getProposal(proposalView.id);
      expect(stored).toMatchObject({
        state: "pending_review",
        tenant_id: "acme",
        principal: "trainer-17",
        source_database_mutated: false,
        change_set: {
          contract: { digest: active.contract_digest },
          writeback: { mode: "read_only", executor: "none" },
        },
      });
    } finally {
      await proposalRuntime.close();
    }

    const promoted = await reviseGuidedActionAuthority({
      projectRoot: fixture.root,
      capabilityName: active.capability,
      expectedCurrentDigest: active.contract_digest,
      authority: {
        authority_posture: "executable",
        writeback: { mode: "direct_sql" },
        version_advance: "integer_increment",
      },
      inspection: fixture.inspection,
    });
    expect(promoted.transition).toEqual({
      kind: "promotion",
      requires_new_revision: true,
      old_proposals_gain_execution_authority: false,
    });
    expect(promoted.draft.contract_digest).not.toBe(active.contract_digest);
    expect(promoted.dsl).toContain("WRITEBACK DIRECT SQL");
    expect(promoted.dsl).toContain("ADVANCE VERSION version USING INTEGER INCREMENT");
    const unchangedBeforePromotion = JSON.parse(await fs.readFile(actionConfigPath, "utf8"));
    expect(unchangedBeforePromotion.contracts).toEqual([active.contract_path]);

    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: promoted.draft.capability,
      contractDigest: promoted.draft.contract_digest,
      actionBoundaryDigest: promoted.draft.action_boundary_digest!,
      proposalId: "wrp_fitflow_promoted_preview",
      proposalHash: `sha256:${"b".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    const promotedActive = await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: promoted.draft.capability,
      expectedDigest: promoted.draft.action_boundary_digest!,
      confirmation: `ACTIVATE ${promoted.draft.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    });
    expect(promotedActive).toMatchObject({
      authority_posture: "executable",
      writeback_mode: "direct_sql",
    });
    const promotedConfig = JSON.parse(await fs.readFile(actionConfigPath, "utf8"));
    expect(promotedConfig.contracts).toEqual([promotedActive.contract_path]);
    expect(promotedConfig.contracts).not.toContain(active.contract_path);
    expect(promotedConfig.sources.local_postgres).toMatchObject({
      read_only: false,
      write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
      receipts: { authority: "runner_ledger" },
    });
    expect(promotedConfig.proposal_freshness).toEqual({
      "membership.set_loyalty_balance": { approval: "required", dependencies: [] },
    });
    const promotedContract = JSON.parse(await fs.readFile(path.join(fixture.root, promotedActive.contract_path), "utf8"));
    expect(promotedContract.capabilities[0].proposal.writeback).toEqual({ mode: "direct_sql" });
    // Promotion changes the active pointer, never the immutable proposal-only revision.
    const archivedProposalOnly = JSON.parse(await fs.readFile(path.join(fixture.root, active.contract_path), "utf8"));
    expect(archivedProposalOnly.capabilities[0].proposal.writeback).toEqual({ mode: "none" });
    const environmentExample = await fs.readFile(path.join(fixture.root, ".env.example"), "utf8");
    expect(environmentExample).toContain("SYNAPSOR_DATABASE_WRITE_URL=");
    expect(environmentExample).not.toContain("postgres://");

    const second = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.freeze_membership",
        description: "Propose freezing one assigned active membership.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        approval_role: "membership_reviewer",
        patches: [{
          column: "membership_status",
          value_source: "fixed",
          fixed_value: "frozen",
          allowed_from: ["active"],
        }],
        confirmed_trusted_scope: true,
      },
    });
    const secondPreview = await prepareGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: second.draft.capability,
    });
    const secondPreviewPath = path.join(fixture.root, secondPreview.config_path);
    const secondPreviewConfig = JSON.parse(await fs.readFile(secondPreviewPath, "utf8"));
    expect(secondPreviewConfig.contracts).toHaveLength(2);
    expect(secondPreviewConfig.proposal_freshness).toEqual({
      "membership.set_loyalty_balance": {
        approval: "required",
        dependencies: [],
      },
    });
    for (const contractPath of secondPreviewConfig.contracts) {
      await expect(fs.stat(path.resolve(path.dirname(secondPreviewPath), contractPath))).resolves.toBeDefined();
    }
  }, 30_000);

  it("runs generated proposal-only INSERT and DELETE with trusted scope and no source mutation", async () => {
    const fixture = await activatedFitFlowFixture();
    const inserted = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.propose_create_member",
        description: "Propose one reviewed member creation within trusted organization and trainer scope.",
        resource: "public.members",
        operation: "insert",
        dedup_proposal_column: "request_id",
        approval_role: "membership_reviewer",
        patches: [
          { column: "membership_status", value_source: "fixed", fixed_value: "active" },
          { column: "membership_tier", value_source: "argument", argument_name: "membership_tier" },
          {
            column: "loyalty_balance",
            value_source: "argument",
            argument_name: "loyalty_balance",
            minimum: 0,
            maximum: 500,
          },
        ],
        confirmed_trusted_scope: true,
      },
    });
    expect(inserted.dsl).toContain("PROPOSE ACTION propose_create_member INSERT");
    expect(inserted.dsl).toContain("DEDUP KEY organization_id = TRUSTED TENANT, request_id = PROPOSAL ID");
    expect(inserted.dsl).toContain("WRITEBACK NONE");
    expect(inserted.dsl).not.toContain("TRANSITION membership_status");
    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: inserted.draft.capability,
      contractDigest: inserted.draft.contract_digest,
      actionBoundaryDigest: inserted.draft.action_boundary_digest!,
      proposalId: "wrp_insert_preview",
      proposalHash: `sha256:${"c".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: inserted.draft.capability,
      expectedDigest: inserted.draft.action_boundary_digest!,
      confirmation: `ACTIVATE ${inserted.draft.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    });
    const deleted = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.propose_delete_member",
        description: "Propose deleting one exact reviewed member with a frozen version guard.",
        resource: "public.members",
        operation: "delete",
        conflict_column: "version",
        approval_role: "membership_reviewer",
        required_approvals: 2,
        confirmed_trusted_scope: true,
        delete_confirmation: "DELETE public.members",
      },
    });
    expect(deleted.dsl).toContain("PROPOSE ACTION propose_delete_member DELETE");
    expect(deleted.dsl).toContain("REQUIRE 2 APPROVALS");
    expect(deleted.dsl).toContain("WRITEBACK NONE");
    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: deleted.draft.capability,
      contractDigest: deleted.draft.contract_digest,
      actionBoundaryDigest: deleted.draft.action_boundary_digest!,
      proposalId: "wrp_delete_preview",
      proposalHash: `sha256:${"d".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    const deleteActivation = await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: deleted.draft.capability,
      expectedDigest: deleted.draft.action_boundary_digest!,
      confirmation: `ACTIVATE ${deleted.draft.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    });
    const actionBoundary = await readActionBoundaryActivation(fixture.root);
    expect(actionBoundary).toMatchObject({
      digest: deleteActivation.action_boundary_digest,
    });
    expect(actionBoundary?.authority.capabilities.map((item) => item.capability)).toEqual([
      "membership.propose_create_member",
      "membership.propose_delete_member",
    ]);
    expect(actionBoundary?.authority.read_dependencies).toHaveLength(1);

    let sourceReads = 0;
    const runtime = createMcpRuntime(
      runtimeConfigForMockRead(path.join(fixture.root, "synapsor.actions.runner.json")),
      {
        storePath: path.join(fixture.root, ".synapsor/crud-action-runtime.db"),
        env: {
          DATABASE_URL: "postgresql://reader:redacted@db.example/fitflow",
          SYNAPSOR_TENANT_ID: "acme",
          SYNAPSOR_PRINCIPAL: "trainer-17",
        },
        generatedAuthorityInspector: async () => fixture.inspection,
        readRow: async ({ context }) => {
          sourceReads += 1;
          return {
            row: {
              id: "member-delete-1",
              request_id: "request-existing",
              organization_id: context.tenant_id,
              assigned_trainer_id: context.principal,
              membership_status: "active",
              membership_tier: "basic",
              loyalty_balance: 40,
              version: 9,
              payment_method: null,
              medical_notes: null,
            },
            rowCount: 1,
          };
        },
      },
    );
    try {
      expect(runtime.listTools().map((tool) => tool.name).sort()).toEqual([
        "membership.propose_create_member",
        "membership.propose_delete_member",
      ]);
      const createResult = await runtime.callTool("membership.propose_create_member", {
        membership_tier: "basic",
        loyalty_balance: 20,
      });
      expect(sourceReads).toBe(0);
      expect(createResult).toMatchObject({
        ok: true,
        source_database_changed: false,
        proposal: { state: "review_required", writeback: { mode: "proposal_only" } },
      });
      const createProposal = await runtime.store.getProposal((createResult.proposal as { id: string }).id);
      expect(createProposal).toMatchObject({
        tenant_id: "acme",
        principal: "trainer-17",
        source_database_mutated: false,
        change_set: {
          operation: "single_row_insert",
          after: {
            organization_id: "acme",
            assigned_trainer_id: "trainer-17",
            membership_status: "active",
            membership_tier: "basic",
            loyalty_balance: 20,
          },
          guards: {
            deduplication: { components: expect.arrayContaining([
              expect.objectContaining({ column: "organization_id", value: "acme", source: "trusted_tenant" }),
              expect.objectContaining({ column: "request_id", source: "proposal_id" }),
            ]) },
          },
          writeback: { mode: "read_only", executor: "none" },
        },
      });

      const deleteResult = await runtime.callTool("membership.propose_delete_member", {
        member_id: "member-delete-1",
      });
      expect(sourceReads).toBe(1);
      expect(deleteResult).toMatchObject({
        ok: true,
        source_database_changed: false,
        proposal: { state: "review_required", writeback: { mode: "proposal_only" } },
      });
      const deleteProposal = await runtime.store.getProposal((deleteResult.proposal as { id: string }).id);
      expect(deleteProposal).toMatchObject({
        tenant_id: "acme",
        principal: "trainer-17",
        source_database_mutated: false,
        change_set: {
          operation: "single_row_delete",
          before: { id: "member-delete-1", version: 9 },
          after: {},
          guards: { expected_version: { column: "version", value: 9 } },
          approval: { required_approvals: 2 },
          writeback: { mode: "read_only", executor: "none" },
        },
      });
    } finally {
      await runtime.close();
    }
  }, 30_000);

  it("requires a verified, exact, nonce-bound decision for headless activation", async () => {
    const fixture = await activatedFitFlowFixture();
    const created = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.propose_loyalty_adjustment",
        description: "Propose one reviewed loyalty adjustment for an assigned member.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 500,
        }],
        confirmed_trusted_scope: true,
      },
    });
    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      contractDigest: created.draft.contract_digest,
      actionBoundaryDigest: created.draft.action_boundary_digest!,
      proposalId: "wrp_headless_rehearsal",
      proposalHash: `sha256:${"c".repeat(64)}`,
      sourceDatabaseChanged: false,
    });

    const configPath = path.join(fixture.root, "synapsor.runner.json");
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKeyPath = path.join(fixture.root, "action-reviewer.pub.pem");
    const privateKeyPath = path.join(fixture.root, "action-reviewer.private.pem");
    await fs.writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }).toString(), "utf8");
    await fs.writeFile(
      privateKeyPath,
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      { encoding: "utf8", mode: 0o600 },
    );
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    config.operator_identity = {
      provider: "signed_key",
      operators: {
        action_reviewer: {
          public_key_path: "./action-reviewer.pub.pem",
          roles: ["action_reviewer"],
        },
      },
    };
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

    const args = [
      "activate",
      "--headless",
      "--capability", created.draft.capability,
      "--expected-digest", created.draft.action_boundary_digest!,
      "--confirmation", `ACTIVATE ${created.draft.action_boundary_digest}`,
      "--config", configPath,
      "--project-root", fixture.root,
      "--identity", "action_reviewer",
      "--identity-key", privateKeyPath,
      "--required-role", "action_reviewer",
      "--reason", "Reviewed the exact proposal-only effect and source-unchanged rehearsal.",
      "--nonce", "headless-action-activation-nonce-0001",
      "--json",
    ];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const wrongDigest = [...args];
    wrongDigest[wrongDigest.indexOf("--expected-digest") + 1] = created.draft.contract_digest;
    await expect(actionCommand(wrongDigest, async () => fixture.inspection)).rejects.toThrow(
      `--expected-digest ${created.draft.action_boundary_digest} and --confirmation 'ACTIVATE ${created.draft.action_boundary_digest}'`,
    );
    await expect(actionCommand(args, async () => fixture.inspection)).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"authority_posture": "proposal_only"'));
    await expect(actionCommand(args, async () => fixture.inspection)).rejects.toThrow(/already consumed/);
  });

  it("rehearses and activates reusable Action authority without a runtime identity or source row", async () => {
    const fixture = await activatedFitFlowFixture();
    const created = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.propose_identity_free_loyalty_adjustment",
        description: "Propose one reviewed loyalty adjustment for the runtime-scoped member.",
        resource: "public.members",
        operation: "update",
        conflict_column: "version",
        version_advance: "integer_increment",
        approval_role: "membership_reviewer",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 500,
        }],
        confirmed_trusted_scope: true,
      },
    });

    const rehearsed = await recordGuidedActionStructuralPreview({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
    });
    expect(rehearsed.effect_preview).toMatchObject({
      mode: "structural",
      contract_digest: created.draft.contract_digest,
      proposal_id: expect.stringMatching(/^structural:[a-f0-9]{64}$/),
      proposal_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      source_rows_read: false,
      source_database_changed: false,
    });

    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    await expect(actionCommand([
      "preview",
      "--capability", created.draft.capability,
      "--project-root", fixture.root,
      "--json",
    ], async () => fixture.inspection)).resolves.toBe(0);
    stdout.mockRestore();
    expect(JSON.parse(output.join(""))).toMatchObject({
      ok: true,
      rehearsal_mode: "structural",
      activation_review: { expected_digest: created.draft.action_boundary_digest,
        confirmation: `ACTIVATE ${created.draft.action_boundary_digest}`, authority_posture: "proposal_only",
        trusted_operator_confirmation_required: true },
      runtime_identity_resolved: false,
      source_rows_read: false,
      source_database_changed: false,
      preview: { mode: "structural" },
    });

    await expect(activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: created.draft.action_boundary_digest!,
      confirmation: `ACTIVATE ${created.draft.action_boundary_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    })).resolves.toMatchObject({
      capability: created.draft.capability,
      authority_posture: "proposal_only",
      source_database_changed: false,
    });

    const readRow = vi.fn(async () => ({ row: {}, rowCount: 0 }));
    const runtime = createMcpRuntime(runtimeConfigForMockRead(
      path.join(fixture.root, "synapsor.actions.runner.json"),
    ), {
      storePath: ":memory:",
      env: {
        DATABASE_URL: "postgresql://reader:redacted@db.example/fitflow",
      },
      readRow,
    });
    try {
      await expect(runtime.callTool(
        created.draft.capability,
        created.preview_args,
      )).resolves.toMatchObject({
        ok: false,
        kind: "proposal",
        proposal: null,
        error: { code: "INVALID_ARGUMENT" },
        source_database_changed: false,
      });
      expect(readRow).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("refuses a rehearsal marker without a full immutable proposal hash", async () => {
    const fixture = await activatedFitFlowFixture();
    const created = await createGuidedActionDraft({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
      action: {
        capability_name: "membership.propose_invalid_preview",
        description: "Propose one bounded membership update.",
        resource: "public.members",
        operation: "update",
        lookup_argument: "member_id",
        conflict_column: "version",
        patches: [{
          column: "loyalty_balance",
          value_source: "argument",
          argument_name: "loyalty_balance",
          minimum: 0,
          maximum: 1_000,
        }],
        approval_role: "membership_reviewer",
        confirmed_trusted_scope: true,
      },
    });
    await expect(recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      contractDigest: created.draft.contract_digest,
      actionBoundaryDigest: created.draft.action_boundary_digest!,
      proposalId: "wrp_invalid_preview",
      proposalHash: "sha256:not-a-real-hash",
      sourceDatabaseChanged: false,
    })).rejects.toThrow(/PREVIEW_IDENTITY_REQUIRED/);
  });

  it("imports and lists a bounded suggestion without granting authority or changing active tools", async () => {
    const fixture = await activatedFitFlowFixture();
    const suggestionPath = path.join(fixture.root, "action-suggestion.json");
    await fs.writeFile(suggestionPath, `${JSON.stringify({
      schema_version: "synapsor.action-suggestion.v1",
      intent: "Let membership staff propose a bounded loyalty balance update.",
      operation: "update",
      resource: "public.members",
      fields: ["loyalty_balance"],
      rationale: "The field and operation are structural candidates for human review.",
      suggested_by: { kind: "operator" },
    }, null, 2)}\n`, "utf8");

    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    await expect(actionCommand([
      "suggest",
      "--input", "action-suggestion.json",
      "--project-root", fixture.root,
      "--json",
    ], async () => fixture.inspection)).resolves.toBe(0);
    const imported = JSON.parse(output.join(""));
    expect(imported).toMatchObject({
      ok: true,
      authority_granted: false,
      active_tools_changed: false,
      source_database_changed: false,
      suggestion: {
        state: "suggested",
        authority_granted: false,
        source_database_changed: false,
        assessment: {
          suggestion: {
            operation: "update",
            resource: "public.members",
            fields: ["loyalty_balance"],
          },
        },
      },
    });
    expect(imported.suggestion.suggestion_id).toMatch(/^as_[a-f0-9]{32}$/);

    output.length = 0;
    await expect(actionCommand([
      "suggestions",
      "--project-root", fixture.root,
      "--json",
    ], async () => fixture.inspection)).resolves.toBe(0);
    const listed = JSON.parse(output.join(""));
    expect(listed).toMatchObject({
      ok: true,
      source_database_changed: false,
      suggestions: [{
        suggestion_id: imported.suggestion.suggestion_id,
        state: "suggested",
        authority_granted: false,
        source_database_changed: false,
      }],
    });
  });
});

function runtimeConfigForMockRead(configPath: string) {
  const config = loadRuntimeConfigFromFile(configPath);
  for (const source of Object.values(config.sources ?? {})) {
    delete source.database_scope;
  }
  return config;
}

async function activatedFitFlowFixture(options: {
  compositePrimaryKey?: boolean;
  untrustedPrimaryKeyComponent?: boolean;
  principalScoped?: boolean;
  singleOrganization?: boolean;
  hiddenRequiredInsertField?: boolean;
} = {}): Promise<{
  root: string;
  inspection: SchemaInspection;
  candidate: ReturnType<typeof buildAutoBoundary>["exploration_boundary"];
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-guided-action-"));
  temporaryRoots.push(root);
  const inspection = fitFlowInspection();
  if (options.singleOrganization) {
    const table = inspection.tables[0]!;
    table.columns = table.columns.filter((candidate) => candidate.name !== "organization_id");
    table.suggestions.tenant_columns = [];
    table.suggestions.default_visible_columns = table.suggestions.default_visible_columns
      .filter((candidate) => candidate !== "organization_id");
    table.unique_constraints = table.unique_constraints.filter((constraint) =>
      !constraint.columns.includes("organization_id"));
    table.indexes = table.indexes.filter((index) => !(index.columns ?? []).includes("organization_id"));
    table.row_level_security = false;
    table.row_level_security_policies = [];
    table.role_posture!.row_security_forced = false;
    table.role_posture!.row_security_effective_for_current_role = false;
  }
  if (options.compositePrimaryKey) {
    const table = inspection.tables[0]!;
    table.primary_key = ["organization_id", "id"];
    table.unique_constraints = [
      { name: "members_pkey", columns: ["organization_id", "id"] },
      { name: "members_id_key", columns: ["id"] },
      { name: "members_organization_request_key", columns: ["organization_id", "request_id"] },
    ];
    table.indexes = [
      { name: "members_pkey", columns: ["organization_id", "id"], unique: true },
      { name: "members_id_key", columns: ["id"], unique: true },
      { name: "members_organization_request_key", columns: ["organization_id", "request_id"], unique: true },
    ];
  }
  if (options.untrustedPrimaryKeyComponent) {
    const table = inspection.tables[0]!;
    table.columns.push(column("partition_id", "text", { immutable: true }));
    table.primary_key = ["organization_id", "partition_id", "id"];
    table.unique_constraints = [
      { name: "members_pkey", columns: ["organization_id", "partition_id", "id"] },
      { name: "members_id_key", columns: ["id"] },
      { name: "members_organization_request_key", columns: ["organization_id", "request_id"] },
    ];
    table.indexes = [
      { name: "members_pkey", columns: ["organization_id", "partition_id", "id"], unique: true },
      { name: "members_id_key", columns: ["id"], unique: true },
      { name: "members_organization_request_key", columns: ["organization_id", "request_id"], unique: true },
    ];
  }
  if (options.hiddenRequiredInsertField) {
    inspection.tables[0]!.columns.push(column("service_window", "text"));
  }
  const build = buildAutoBoundary({
    inspection,
    project: {
      root,
      package_manager: "pnpm",
      frameworks: ["nextjs", "prisma"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    },
    sourceEnv: "DATABASE_URL",
    ...(options.singleOrganization
      ? { singleOrganization: { organizationId: "northgate-library" } }
      : {}),
    overrides: {
      schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
      resources: {
        "public.members": {
          principal_key: {
            value: options.principalScoped === false ? null : "assigned_trainer_id",
            actor: "reviewer@example.test",
            reason: options.principalScoped === false
              ? "This reviewed tenant-only resource does not apply per-principal row scope."
              : "Assigned trainers may access only their reviewed member rows.",
            decided_at: "2026-07-24T17:00:00.000Z",
          },
          ...(options.hiddenRequiredInsertField ? {
            fields: {
              service_window: {
                exposure: "keep_out" as const,
                actor: "reviewer@example.test",
                reason: "This required source field was deliberately not reviewed for agent use.",
                decided_at: "2026-07-24T17:00:00.000Z",
              },
            },
          } : {}),
        },
      },
    },
  });

  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.6.4" });
  const candidate = structuredClone(build.exploration_boundary);
  const digest = explorationBoundaryCandidateDigest(candidate);
  await activateExplorationBoundary({
    projectRoot: root,
    candidate,
    expectedDigest: digest,
    actor: "reviewer@example.test",
    confirmation: `ACTIVATE ${digest}`,
    confirmedDecisions: candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  return { root, inspection, candidate };
}

async function activatedDerivedPrincipalWriteFixture(): Promise<{
  root: string;
  inspection: SchemaInspection;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-guided-derived-principal-"));
  temporaryRoots.push(root);
  const inspection = derivedPrincipalWriteInspection();
  const build = buildAutoBoundary({
    inspection,
    project: {
      root,
      package_manager: "pnpm",
      frameworks: ["nextjs", "prisma"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    },
    sourceEnv: "DATABASE_URL",
    overrides: {
      schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
      resources: {
        "public.members": {
          principal_key: {
            value: null,
            actor: "reviewer@example.test",
            reason: "Principal scope is inherited from the required trainer relationship.",
            decided_at: "2026-08-05T18:00:00.000Z",
          },
          principal_scope_path: {
            value: "members_assigned_trainer_id_fkey",
            actor: "reviewer@example.test",
            reason: "Every member belongs to exactly one reviewed trainer principal.",
            decided_at: "2026-08-05T18:00:00.000Z",
          },
        },
        "public.staff": {
          principal_key: {
            value: "trainer_id",
            actor: "reviewer@example.test",
            reason: "The authenticated trainer id is the direct principal on this table.",
            decided_at: "2026-08-05T18:00:00.000Z",
          },
          fields: {
            trainer_id: {
              exposure: "keep_out",
              actor: "reviewer@example.test",
              reason: "The trusted principal binding must stay outside model arguments.",
              decided_at: "2026-08-05T18:00:00.000Z",
            },
          },
        },
      },
    },
  });
  await writeAutoBoundaryArtifacts({ projectRoot: root, build });
  await initializeGuidedProject({ projectRoot: root, build, runnerVersion: "1.7.0" });
  const candidate = structuredClone(build.exploration_boundary);
  const digest = explorationBoundaryCandidateDigest(candidate);
  await activateExplorationBoundary({
    projectRoot: root,
    candidate,
    expectedDigest: digest,
    actor: "reviewer@example.test",
    confirmation: `ACTIVATE ${digest}`,
    confirmedDecisions: candidate.unresolved_decisions,
    currentInspection: inspection,
  });
  return { root, inspection };
}

function fitFlowInspection(): SchemaInspection {
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16",
    current_user: "fitflow_reader",
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    },
    inspected_at: "2026-07-24T17:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    tables: [{
      schema: "public",
      name: "members",
      type: "table",
      writable: true,
      columns: [
        column("id", "uuid", { immutable: true, defaultValue: "gen_random_uuid()" }),
        column("request_id", "text", { immutable: true }),
        column("organization_id", "uuid", { tenant: true, immutable: true }),
        column("assigned_trainer_id", "uuid", { immutable: true }),
        column("membership_status", "text", { enumValues: ["active", "frozen", "cancelled"] }),
        column("membership_tier", "text", { enumValues: ["basic", "plus", "elite"] }),
        column("loyalty_balance", "integer"),
        column("version", "integer", { conflict: true, defaultValue: "1" }),
        column("payment_method", "text", { sensitive: true, nullable: true }),
        column("medical_notes", "text", { sensitive: true, nullable: true }),
      ],
      primary_key: ["id"],
      unique_constraints: [
        { name: "members_pkey", columns: ["id"] },
        { name: "members_organization_request_key", columns: ["organization_id", "request_id"] },
      ],
      foreign_keys: [],
      referenced_by: [],
      write_triggers: [],
      indexes: [
        { name: "members_pkey", columns: ["id"], unique: true },
        { name: "members_organization_request_key", columns: ["organization_id", "request_id"], unique: true },
      ],
      row_level_security: true,
      row_level_security_policies: [{
        name: "member_scope",
        command: "SELECT",
        permissive: true,
        roles: ["fitflow_reader"],
        using_expression: "(organization_id = current_setting('app.organization_id')::uuid AND assigned_trainer_id = current_setting('app.principal')::uuid)",
      }],
      role_posture: {
        owner: "fitflow_owner",
        current_role_is_owner: false,
        current_role_can_assume_owner: false,
        row_security_forced: true,
        row_security_effective_for_current_role: true,
        privileges: {
          select: true,
          insert: false,
          update: false,
          delete: false,
          truncate: false,
          references: false,
          trigger: false,
        },
      },
      suggestions: {
        tenant_columns: ["organization_id"],
        conflict_columns: ["version"],
        sensitive_columns: ["payment_method", "medical_notes"],
        default_visible_columns: ["id", "request_id", "organization_id", "assigned_trainer_id", "membership_status", "membership_tier", "loyalty_balance", "version"],
      },
    }],
  };
}

function derivedPrincipalWriteInspection(): SchemaInspection {
  const inspection = fitFlowInspection();
  const members = inspection.tables[0]!;
  members.foreign_keys = [{
    name: "members_assigned_trainer_id_fkey",
    columns: ["assigned_trainer_id"],
    referenced_schema: "public",
    referenced_table: "staff",
    referenced_columns: ["trainer_id"],
    delete_rule: "RESTRICT",
  }];

  const trainers = structuredClone(members);
  trainers.name = "staff";
  trainers.columns = [
    column("id", "uuid", { immutable: true }),
    column("trainer_id", "uuid", { immutable: true }),
    column("organization_id", "uuid", { tenant: true, immutable: true }),
    column("display_label", "text"),
  ];
  trainers.primary_key = ["id"];
  trainers.unique_constraints = [
    { name: "trainers_pkey", columns: ["id"] },
    { name: "trainers_trainer_id_key", columns: ["trainer_id"] },
  ];
  trainers.foreign_keys = [];
  trainers.referenced_by = [];
  trainers.write_triggers = [];
  trainers.indexes = [
    { name: "trainers_pkey", columns: ["id"], unique: true },
    { name: "trainers_trainer_id_key", columns: ["trainer_id"], unique: true },
  ];
  trainers.row_level_security_policies = [{
    name: "trainer_scope",
    command: "SELECT",
    permissive: true,
    roles: ["fitflow_reader"],
    using_expression: "(organization_id = current_setting('app.organization_id')::uuid AND trainer_id = current_setting('app.principal')::uuid)",
  }];
  trainers.suggestions = {
    tenant_columns: ["organization_id"],
    conflict_columns: [],
    sensitive_columns: [],
    default_visible_columns: ["id", "trainer_id", "organization_id", "display_label"],
  };
  inspection.tables.push(trainers);
  return inspection;
}

function column(
  name: string,
  dataType: string,
  overrides: Partial<{
    tenant: boolean;
    conflict: boolean;
    sensitive: boolean;
    immutable: boolean;
    enumValues: string[];
    nullable: boolean;
    defaultValue: string;
  }> = {},
) {
  return {
    name,
    data_type: dataType,
    ...(overrides.enumValues ? { enum_values: overrides.enumValues } : {}),
    nullable: overrides.nullable ?? false,
    ...(overrides.defaultValue ? { default: overrides.defaultValue } : {}),
    generated: false,
    ordinal_position: 1,
    suggestions: {
      tenant: overrides.tenant ?? false,
      conflict: overrides.conflict ?? false,
      sensitive: overrides.sensitive ?? false,
      immutable: overrides.immutable ?? false,
      large_or_binary: false,
    },
  };
}
