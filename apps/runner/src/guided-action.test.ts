import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { afterEach, describe, expect, it } from "vitest";
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
} from "./guided-action.js";
import { initializeGuidedProject } from "./guided-project.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
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

  it("requires a real proposal preview before exact-digest activation", async () => {
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
    expect(previewConfig.proposal_freshness).toEqual({
      "membership.set_loyalty_balance": {
        approval: "required",
        dependencies: [],
      },
    });
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
      source_database_changed: false,
    });
    const config = JSON.parse(await fs.readFile(path.join(fixture.root, "synapsor.runner.json"), "utf8"));
    expect(config.mode).toBe("review");
    expect(config.sources.local_postgres).toMatchObject({
      read_url_env: "DATABASE_URL",
      read_only: false,
      write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
      database_scope: {
        mode: "postgres_rls",
        tenant_setting: "app.organization_id",
      },
      receipts: { authority: "runner_ledger" },
    });
    expect(config.contracts).toContain("./synapsor/actions/active/membership_set_loyalty_balance.contract.json");
    expect(config.proposal_freshness).toEqual({
      "membership.set_loyalty_balance": {
        approval: "required",
        dependencies: [],
      },
    });
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
    const secondPreview = await prepareGuidedActionPreview({
      projectRoot: fixture.root,
      capabilityName: second.draft.capability,
    });
    const secondPreviewPath = path.join(fixture.root, secondPreview.config_path);
    const secondPreviewConfig = JSON.parse(await fs.readFile(secondPreviewPath, "utf8"));
    expect(secondPreviewConfig.contracts).toHaveLength(2);
    expect(secondPreviewConfig.proposal_freshness).toEqual({
      "membership.freeze_membership": {
        approval: "required",
        dependencies: [],
      },
      "membership.set_loyalty_balance": {
        approval: "required",
        dependencies: [],
      },
    });
    for (const contractPath of secondPreviewConfig.contracts) {
      await expect(fs.stat(path.resolve(path.dirname(secondPreviewPath), contractPath))).resolves.toBeDefined();
    }
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
        column("id", "uuid", { immutable: true }),
        column("organization_id", "uuid", { tenant: true, immutable: true }),
        column("assigned_trainer_id", "uuid", { immutable: true }),
        column("membership_status", "text", { enumValues: ["active", "frozen", "cancelled"] }),
        column("membership_tier", "text", { enumValues: ["basic", "plus", "elite"] }),
        column("loyalty_balance", "integer"),
        column("version", "integer", { conflict: true }),
        column("payment_method", "text", { sensitive: true }),
        column("medical_notes", "text", { sensitive: true }),
      ],
      primary_key: ["id"],
      unique_constraints: [{ name: "members_pkey", columns: ["id"] }],
      foreign_keys: [],
      referenced_by: [],
      write_triggers: [],
      indexes: [{ name: "members_pkey", columns: ["id"], unique: true }],
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
        default_visible_columns: ["id", "organization_id", "assigned_trainer_id", "membership_status", "membership_tier", "loyalty_balance", "version"],
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
  }> = {},
) {
  return {
    name,
    data_type: dataType,
    ...(overrides.enumValues ? { enum_values: overrides.enumValues } : {}),
    nullable: false,
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
