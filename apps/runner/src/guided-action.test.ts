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
  explorationBoundaryCandidateDigest,
  writeAutoBoundaryArtifacts,
} from "./auto-boundary.js";
import {
  activateGuidedAction,
  createGuidedActionDraft,
  guidedActionOptions,
  prepareGuidedActionPreview,
  recordGuidedActionPreview,
  reviseGuidedActionAuthority,
} from "./guided-action.js";
import { initializeGuidedProject } from "./guided-project.js";
import { actionCommand } from "./boundary-commands.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("guided write actions", () => {
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
    expect(created.dsl).toContain("LIMIT TOTAL 1000 PER DAY");
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
    });
    await expect(fs.readFile(path.join(fixture.root, created.draft.dsl_path), "utf8")).resolves.toBe(created.dsl);
  });

  it("does not advertise or accept guarded writes with relationship-carried principal scope", async () => {
    const fixture = await activatedDerivedPrincipalWriteFixture();
    const options = await guidedActionOptions({
      projectRoot: fixture.root,
      inspection: fixture.inspection,
    });
    expect(options.resources.map((resource) => resource.id)).not.toContain("public.members");

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
    await expect(activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: created.draft.contract_digest,
      confirmation: `ACTIVATE ${created.draft.contract_digest}`,
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
    });
    expect(previewConfig.sources.local_postgres.write_url_env).toBeUndefined();
    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      contractDigest: created.draft.contract_digest,
      proposalId: "wrp_fitflow_preview",
      proposalHash: `sha256:${"a".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    const active = await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: created.draft.capability,
      expectedDigest: created.draft.contract_digest,
      confirmation: `ACTIVATE ${created.draft.contract_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    });
    expect(active).toMatchObject({
      state: "active",
      capability: "membership.set_loyalty_balance",
      authority_posture: "proposal_only",
      writeback_mode: "none",
      source_database_changed: false,
    });
    const baseConfig = JSON.parse(await fs.readFile(path.join(fixture.root, "synapsor.runner.json"), "utf8"));
    expect(baseConfig.sources.local_postgres.read_only).toBe(true);
    const actionConfigPath = path.join(fixture.root, "synapsor.actions.runner.json");
    const config = JSON.parse(await fs.readFile(actionConfigPath, "utf8"));
    expect(config.mode).toBe("review");
    expect(config.production_explore).toBeUndefined();
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
    const proposalRuntime = createMcpRuntime(loadRuntimeConfigFromFile(actionConfigPath), {
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
    const unchangedBeforePromotion = JSON.parse(await fs.readFile(actionConfigPath, "utf8"));
    expect(unchangedBeforePromotion.contracts).toEqual([active.contract_path]);

    await recordGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: promoted.draft.capability,
      contractDigest: promoted.draft.contract_digest,
      proposalId: "wrp_fitflow_promoted_preview",
      proposalHash: `sha256:${"b".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    const promotedActive = await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: promoted.draft.capability,
      expectedDigest: promoted.draft.contract_digest,
      confirmation: `ACTIVATE ${promoted.draft.contract_digest}`,
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
      proposalId: "wrp_insert_preview",
      proposalHash: `sha256:${"c".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: inserted.draft.capability,
      expectedDigest: inserted.draft.contract_digest,
      confirmation: `ACTIVATE ${inserted.draft.contract_digest}`,
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
      proposalId: "wrp_delete_preview",
      proposalHash: `sha256:${"d".repeat(64)}`,
      sourceDatabaseChanged: false,
    });
    await activateGuidedAction({
      projectRoot: fixture.root,
      capabilityName: deleted.draft.capability,
      expectedDigest: deleted.draft.contract_digest,
      confirmation: `ACTIVATE ${deleted.draft.contract_digest}`,
      actor: "reviewer@example.test",
      inspection: fixture.inspection,
    });

    let sourceReads = 0;
    const runtime = createMcpRuntime(
      loadRuntimeConfigFromFile(path.join(fixture.root, "synapsor.actions.runner.json")),
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
      "--expected-digest", created.draft.contract_digest,
      "--confirmation", `ACTIVATE ${created.draft.contract_digest}`,
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
    await expect(actionCommand(args, async () => fixture.inspection)).resolves.toBe(0);
    expect(stdout).toHaveBeenCalledWith(expect.stringContaining('"authority_posture": "proposal_only"'));
    await expect(actionCommand(args, async () => fixture.inspection)).rejects.toThrow(/already consumed/);
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

async function activatedFitFlowFixture(): Promise<{ root: string; inspection: SchemaInspection }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-guided-action-"));
  temporaryRoots.push(root);
  const inspection = fitFlowInspection();
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
            value: "assigned_trainer_id",
            actor: "reviewer@example.test",
            reason: "Assigned trainers may access only their reviewed member rows.",
            decided_at: "2026-07-24T17:00:00.000Z",
          },
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
  return { root, inspection };
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
