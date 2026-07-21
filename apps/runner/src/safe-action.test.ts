import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { loadRuntimeConfigFromFile } from "@synapsor-runner/mcp-server";
import { normalizeContract } from "@synapsor/spec";
import {
  activateSafeActionDraft,
  compileSafeActionDraft,
  parseSafeActionSource,
  prepareSafeActionPreview,
  recordSafeActionEffectPreview,
  safeActionStatus,
  scaffoldSafeAction,
  SafeActionValidationError,
  validateSafeActionCapability,
} from "./safe-action.js";

const workspaceRoot = path.resolve(import.meta.dirname, "../../..");

describe("Safe Action authoring", () => {
  it("scaffolds one concise inert action from an existing reviewed read boundary", async () => {
    const fixture = await projectFixture();
    const configBefore = await fs.readFile(fixture.configPath, "utf8");
    const result = await scaffoldSafeAction({
      projectRoot: fixture.root,
      actionName: "refund_order",
      description: "Propose one order refund without exposing customer email.",
    });
    expect(result).toMatchObject({
      action_name: "billing.propose_refund_order",
      based_on_capability: "billing.inspect_invoice",
      source_path: "./synapsor/actions/billing.propose_refund_order.ts",
      instructions: {
        canonical: "./synapsor/SAFE_ACTION_AGENT.md",
        codex: "./synapsor/actions/AGENTS.md",
        claude: "./synapsor/actions/CLAUDE.md",
      },
    });
    expect(result.authority_questions.map((item) => item.field)).toEqual([
      "proposal.operation",
      "proposal.allowed_fields / patch",
      "proposal.conflict_guard",
      "proposal.approval",
      "proposal.writeback",
    ]);
    const generated = await fs.readFile(path.join(fixture.root, result.source_path), "utf8");
    expect(generated).toContain("Disabled authoring draft");
    expect(generated).toContain("__REVIEW_OPERATION__");
    expect(generated).toContain("__REVIEW_MUTATION_COLUMN__");
    expect(generated).toContain("__REVIEW_APPROVER_ROLE__");
    expect(generated).toContain("__REVIEW_WRITEBACK_MODE__");
    expect(generated).not.toMatch(/postgres(?:ql)?:\/\/|password|secret-value/i);
    const instructions = await fs.readFile(path.join(fixture.root, "synapsor/SAFE_ACTION_AGENT.md"), "utf8");
    expect(instructions).toContain("Never activate an action");
    expect(instructions).toContain("Keep tenant, principal");
    expect(instructions).toContain("strict contract lint");
    expect(await fs.readFile(path.join(fixture.root, "synapsor/actions/AGENTS.md"), "utf8")).toContain(instructions.split("\n").slice(2, -1).join("\n"));
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(configBefore);
    await expect(compileSafeActionDraft({ projectRoot: fixture.root, sourcePath: result.source_path })).rejects.toThrow(/SAFE_ACTION_REVIEW_PLACEHOLDER/);
    await expect(scaffoldSafeAction({
      projectRoot: fixture.root,
      actionName: "refund_order",
      description: "different intent",
    })).rejects.toThrow(/already exists/);
  });

  it("parses the static code-first subset without executing agent-authored code", () => {
    const source = actionSource("billing.propose_refund_order");
    expect(parseSafeActionSource(source)).toMatchObject({
      name: "billing.propose_refund_order",
      kind: "proposal",
      proposal: { writeback: { mode: "direct_sql" } },
    });

    expect(() => parseSafeActionSource(source.replace(
      'patch: { late_fee_cents: { from_arg: "refund_cents" }, waiver_reason: { from_arg: "reason" } },',
      "patch: buildPatch(),",
    ))).toThrow(/SAFE_ACTION_DYNAMIC_EXPRESSION_FORBIDDEN/);
    expect(() => parseSafeActionSource(source.replace(
      'import { defineCapability } from "@synapsor/runner/authoring";',
      'import { defineCapability } from "./unsafe-helper.js";',
    ))).toThrow(/SAFE_ACTION_IMPORT_FORBIDDEN/);
    expect(() => parseSafeActionSource(source.replace(
      "visible_fields: [",
      "visible_fields: [...process.env.VISIBLE_FIELDS,",
    ))).toThrow(/SAFE_ACTION_SPREAD_FORBIDDEN|SAFE_ACTION_DYNAMIC_EXPRESSION_FORBIDDEN/);
  });

  it("compiles a canonical disabled draft and deterministic tests without changing active authority", async () => {
    const fixture = await projectFixture();
    const beforeConfig = await fs.readFile(fixture.configPath, "utf8");
    const beforeContract = await fs.readFile(fixture.contractPath, "utf8");
    const result = await compileSafeActionDraft({
      projectRoot: fixture.root,
      sourcePath: fixture.sourcePath,
      generatedAt: "2026-07-21T04:00:00.000Z",
    });

    expect(result.manifest).toMatchObject({
      state: "disabled_draft",
      action_name: "billing.propose_refund_order",
      base_contract_path: "./synapsor.contract.json",
      unresolved_authority: [],
    });
    expect(result.contract.capabilities.map((capability) => capability.name)).toContain("billing.propose_refund_order");
    expect(result.contract.workflows?.[0]?.allowed_capabilities).toContain("billing.propose_refund_order");
    expect(result.tests.tests).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "operator_boundary", capability: "billing.propose_refund_order" }),
      expect.objectContaining({ kind: "hide_fields", fields: ["internal_risk_score", "card_token", "customer_email"] }),
      expect.objectContaining({ kind: "proposal_effect", capability: "billing.propose_refund_order" }),
      expect.objectContaining({ kind: "conflict_guard", expected: { column: "updated_at" } }),
      expect.objectContaining({ kind: "trusted_scope", capability: "billing.propose_refund_order" }),
      expect.objectContaining({ kind: "evidence_requirement", expected: { required: true, query_audit: true } }),
      expect.objectContaining({ kind: "approval_boundary", capability: "billing.propose_refund_order" }),
      expect.objectContaining({ kind: "tool_allow" }),
      expect.objectContaining({ kind: "tool_deny", expected_code: "NOT_FOUND_IN_TENANT" }),
      expect.objectContaining({ kind: "source_unchanged_before_approval" }),
    ]));
    expect(result.manifest.validation).toMatchObject({
      ok: true,
      blocking_lint_issues: 0,
      static_test_summary: { passed: 10, failed: 0, total: 10 },
      live_tests_pending: [
        "billing.propose_refund_order-allowed-effect",
        "billing.propose_refund_order-other-tenant-denied",
        "billing.propose_refund_order-source-unchanged",
      ],
    });
    expect(result.manifest.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "CAPABILITY_DESCRIPTION_MISSING", source: "inherited contract lint" }),
    ]));
    expect(JSON.parse(await fs.readFile(path.join(fixture.root, result.manifest.validation.lint_report_path), "utf8"))).toMatchObject({
      summary: { errors: 0, warnings: 2 },
    });
    expect(await fs.readFile(path.join(fixture.root, result.manifest.validation.explanation_path), "utf8")).toContain("billing.propose_refund_order");
    expect(JSON.parse(await fs.readFile(path.join(fixture.root, result.manifest.validation.static_test_report_path), "utf8"))).toMatchObject({
      ok: true,
      mode: "static",
      summary: { passed: 10, failed: 0, total: 10 },
    });
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(beforeConfig);
    expect(await fs.readFile(fixture.contractPath, "utf8")).toBe(beforeContract);
    await expect(fs.access(path.join(fixture.root, ".synapsor", "active.json"))).rejects.toMatchObject({ code: "ENOENT" });
    const status = await safeActionStatus(fixture.root);
    expect(status).toMatchObject({ draft: { state: "disabled_draft" }, draft_matches_active: false });
  });

  it("fails closed on trusted model arguments and unresolved review placeholders", async () => {
    const fixture = await projectFixture();
    await fs.writeFile(fixture.sourcePath, actionSource("billing.propose_refund_order").replace(
      'order_id: { type: "string", required: true, max_length: 128 },',
      'order_id: { type: "string", required: true, max_length: 128 }, tenant_id: { type: "string", required: true },',
    ));
    await expect(compileSafeActionDraft({ projectRoot: fixture.root, sourcePath: fixture.sourcePath }))
      .rejects.toMatchObject({
        name: "SafeActionValidationError",
        diagnostics: expect.arrayContaining([expect.objectContaining({ code: "SAFE_ACTION_TRUSTED_ARG_FORBIDDEN" })]),
      } satisfies Partial<SafeActionValidationError>);

    await fs.writeFile(fixture.sourcePath, actionSource("billing.propose_refund_order").replace("billing_reviewer", "__REVIEW_APPROVER_ROLE__"));
    await expect(compileSafeActionDraft({ projectRoot: fixture.root, sourcePath: fixture.sourcePath }))
      .rejects.toThrow(/SAFE_ACTION_REVIEW_PLACEHOLDER/);
    expect((await safeActionStatus(fixture.root)).draft).toBeUndefined();
  });

  it("blocks activation on a newly introduced strict lint warning while preserving inherited warnings", async () => {
    const fixture = await projectFixture();
    await fs.writeFile(fixture.sourcePath, actionSource("billing.propose_refund_order").replace(
      'order_id: { type: "string", required: true, max_length: 128 },',
      'order_id: { type: "string", required: true },',
    ));
    const draft = (await compileSafeActionDraft({ projectRoot: fixture.root, sourcePath: fixture.sourcePath })).manifest;
    expect(draft.validation).toMatchObject({ ok: false, blocking_lint_issues: 1 });
    expect(draft.unresolved_authority).toEqual([
      "lint:STRING_ARGUMENT_UNBOUNDED:$.capabilities[2].args.order_id",
    ]);
    expect(draft.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "STRING_ARGUMENT_UNBOUNDED", source: "Safe Action contract lint" }),
      expect.objectContaining({ code: "CAPABILITY_DESCRIPTION_MISSING", source: "inherited contract lint" }),
    ]));
    await expect(prepareSafeActionPreview({ projectRoot: fixture.root })).rejects.toThrow(/SAFE_ACTION_VALIDATION_REQUIRED/);
    await recordSafeActionEffectPreview({
      projectRoot: fixture.root,
      draftDigest: draft.draft_contract_digest,
      proposalId: "wrp_lint_blocked",
      proposalHash: "sha256:lint-blocked",
      sourceDatabaseChanged: false,
    });
    await expect(activateSafeActionDraft({
      projectRoot: fixture.root,
      expectedDigest: draft.draft_contract_digest,
      confirmation: `ACTIVATE ${draft.draft_contract_digest}`,
    })).rejects.toThrow(/SAFE_ACTION_UNRESOLVED_AUTHORITY/);
    expect(JSON.parse(await fs.readFile(fixture.configPath, "utf8")).contracts).toEqual(["./synapsor.contract.json"]);
  });

  it("fails closed on missing authority even when the canonical object shape is otherwise parseable", async () => {
    const fixture = await projectFixture();
    const contract = normalizeContract(JSON.parse(await fs.readFile(fixture.contractPath, "utf8")));
    const config = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
    const original = parseSafeActionSource(actionSource("billing.propose_refund_order"));
    const expectCode = (mutate: (candidate: typeof original, candidateConfig: Record<string, unknown>) => void, code: string) => {
      const candidate = structuredClone(original);
      const candidateConfig = structuredClone(config) as Record<string, unknown>;
      mutate(candidate, candidateConfig);
      expect(validateSafeActionCapability(candidate, contract, candidateConfig)).toEqual(expect.arrayContaining([
        expect.objectContaining({ severity: "error", code }),
      ]));
    };

    expectCode((candidate) => { delete candidate.description; }, "SAFE_ACTION_DESCRIPTION_REQUIRED");
    expectCode((candidate) => { candidate.evidence = { required: false }; }, "SAFE_ACTION_EVIDENCE_REQUIRED");
    expectCode((candidate) => { candidate.proposal!.allowed_fields.push("status"); }, "SAFE_ACTION_PATCH_MUST_BE_EXACT");
    expectCode((candidate) => { delete candidate.proposal!.approval!.required_role; }, "SAFE_ACTION_REVIEWER_ROLE_REQUIRED");
    expectCode((candidate) => { delete candidate.proposal!.numeric_bounds; }, "SAFE_ACTION_NUMERIC_VALUE_BOUNDS_REQUIRED");
    expectCode((candidate) => { candidate.proposal!.operation = { kind: "insert" }; }, "SAFE_ACTION_INSERT_DEDUP_REQUIRED");
    expectCode((candidate, candidateConfig) => {
      delete (candidateConfig.sources as Record<string, Record<string, unknown>>).local_postgres!.write_url_env;
    }, "SAFE_ACTION_WRITE_CREDENTIAL_AUTHORITY_REQUIRED");
    expectCode((candidate) => {
      candidate.proposal!.allowed_fields = ["status"];
      candidate.proposal!.patch = { status: { fixed: "refunded" } };
      delete candidate.proposal!.transition_guards;
    }, "SAFE_ACTION_TRANSITION_GUARD_REQUIRED");
  });

  it("activates only the exact reviewed digest and keeps immutable history", async () => {
    const fixture = await projectFixture();
    const draft = (await compileSafeActionDraft({ projectRoot: fixture.root, sourcePath: fixture.sourcePath })).manifest;
    await expect(activateSafeActionDraft({
      projectRoot: fixture.root,
      expectedDigest: draft.draft_contract_digest,
      confirmation: "ACTIVATE sha256:not-the-reviewed-digest",
    })).rejects.toThrow(/SAFE_ACTION_CONFIRMATION_REQUIRED/);
    const configBefore = await fs.readFile(fixture.configPath, "utf8");
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(configBefore);
    await expect(activateSafeActionDraft({
      projectRoot: fixture.root,
      expectedDigest: draft.draft_contract_digest,
      confirmation: `ACTIVATE ${draft.draft_contract_digest}`,
    })).rejects.toThrow(/SAFE_ACTION_EFFECT_PREVIEW_REQUIRED/);
    const preview = await prepareSafeActionPreview({ projectRoot: fixture.root });
    expect(preview).toMatchObject({ capability: "billing.propose_refund_order", draft_digest: draft.draft_contract_digest });
    expect(JSON.parse(await fs.readFile(path.join(fixture.root, preview.config_path), "utf8"))).toMatchObject({
      mode: "review",
      governance: { mode: "local_only" },
    });
    await expect(recordSafeActionEffectPreview({
      projectRoot: fixture.root,
      draftDigest: draft.draft_contract_digest,
      proposalId: "wrp_preview",
      proposalHash: "sha256:preview",
      sourceDatabaseChanged: true,
    })).rejects.toThrow(/PREVIEW_MUTATED_SOURCE/);
    await recordSafeActionEffectPreview({
      projectRoot: fixture.root,
      draftDigest: draft.draft_contract_digest,
      proposalId: "wrp_preview",
      proposalHash: "sha256:preview",
      sourceDatabaseChanged: false,
      previewedAt: "2026-07-21T04:04:00.000Z",
    });

    const active = await activateSafeActionDraft({
      projectRoot: fixture.root,
      expectedDigest: draft.draft_contract_digest,
      confirmation: `ACTIVATE ${draft.draft_contract_digest}`,
      activatedAt: "2026-07-21T04:05:00.000Z",
    });
    expect(active).toMatchObject({
      state: "active",
      action_name: "billing.propose_refund_order",
      contract_digest: draft.draft_contract_digest,
      previous_contract_digest: draft.base_contract_digest,
    });
    const config = JSON.parse(await fs.readFile(fixture.configPath, "utf8"));
    expect(config.contracts[0]).toMatch(/^\.\/\.synapsor\/active\/[a-f0-9]{64}\.contract\.json$/);
    const activeContractPath = path.resolve(fixture.root, config.contracts[0]);
    const activeContract = normalizeContract(JSON.parse(await fs.readFile(activeContractPath, "utf8")));
    expect(canonicalJsonDigest(activeContract)).toBe(draft.draft_contract_digest);
    expect((await fs.stat(activeContractPath)).mode & 0o777).toBe(0o400);
    expect(await safeActionStatus(fixture.root)).toMatchObject({
      draft: { state: "activated" },
      active: { contract_digest: draft.draft_contract_digest },
      draft_matches_active: true,
    });
  });

  it("does not reinterpret active authority when source changes and rejects a stale draft base", async () => {
    const fixture = await projectFixture();
    const firstDraft = (await compileSafeActionDraft({ projectRoot: fixture.root, sourcePath: fixture.sourcePath })).manifest;
    await recordSafeActionEffectPreview({ projectRoot: fixture.root, draftDigest: firstDraft.draft_contract_digest, proposalId: "wrp_first", proposalHash: "sha256:first", sourceDatabaseChanged: false });
    await fs.writeFile(fixture.sourcePath, actionSource("billing.propose_refund_order").replace("maximum: 5000", "maximum: 7000"));
    await expect(activateSafeActionDraft({
      projectRoot: fixture.root,
      expectedDigest: firstDraft.draft_contract_digest,
      confirmation: `ACTIVATE ${firstDraft.draft_contract_digest}`,
    })).rejects.toThrow(/SAFE_ACTION_SOURCE_CHANGED/);
    expect(JSON.parse(await fs.readFile(fixture.configPath, "utf8")).contracts).toEqual(["./synapsor.contract.json"]);

    await fs.writeFile(fixture.sourcePath, actionSource("billing.propose_refund_order"));
    const staleDraft = (await compileSafeActionDraft({ projectRoot: fixture.root, sourcePath: fixture.sourcePath })).manifest;
    await recordSafeActionEffectPreview({ projectRoot: fixture.root, draftDigest: staleDraft.draft_contract_digest, proposalId: "wrp_stale", proposalHash: "sha256:stale", sourceDatabaseChanged: false });
    const base = JSON.parse(await fs.readFile(fixture.contractPath, "utf8"));
    base.metadata.description = "independently changed active contract";
    await fs.writeFile(fixture.contractPath, `${JSON.stringify(base, null, 2)}\n`);
    const configBefore = await fs.readFile(fixture.configPath, "utf8");
    await expect(activateSafeActionDraft({
      projectRoot: fixture.root,
      expectedDigest: staleDraft.draft_contract_digest,
      confirmation: `ACTIVATE ${staleDraft.draft_contract_digest}`,
    })).rejects.toThrow(/SAFE_ACTION_BASE_CHANGED/);
    expect(await fs.readFile(fixture.configPath, "utf8")).toBe(configBefore);
    await expect(fs.access(path.join(fixture.root, ".synapsor", "active.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps restarted MCP tool authority unchanged until explicit activation", async () => {
    const fixture = await projectFixture();
    const originalNames = loadRuntimeConfigFromFile(fixture.configPath).capabilities?.map((capability) => capability.name);
    expect(originalNames).not.toContain("billing.propose_refund_order");
    const draft = (await compileSafeActionDraft({ projectRoot: fixture.root, sourcePath: fixture.sourcePath })).manifest;
    expect(loadRuntimeConfigFromFile(fixture.configPath).capabilities?.map((capability) => capability.name)).toEqual(originalNames);
    await recordSafeActionEffectPreview({ projectRoot: fixture.root, draftDigest: draft.draft_contract_digest, proposalId: "wrp_restart", proposalHash: "sha256:restart", sourceDatabaseChanged: false });
    await activateSafeActionDraft({ projectRoot: fixture.root, expectedDigest: draft.draft_contract_digest, confirmation: `ACTIVATE ${draft.draft_contract_digest}` });
    const activated = loadRuntimeConfigFromFile(fixture.configPath);
    expect(activated.capabilities?.map((capability) => capability.name)).toContain("billing.propose_refund_order");
    expect(activated.capabilities?.find((capability) => capability.name === "billing.propose_refund_order")?.numeric_bounds).toEqual({ late_fee_cents: { minimum: 1, maximum: 5000 } });

    await fs.writeFile(fixture.sourcePath, actionSource("billing.propose_refund_order").replace("maximum: 5000", "maximum: 7000"));
    const secondDraft = (await compileSafeActionDraft({ projectRoot: fixture.root, sourcePath: fixture.sourcePath })).manifest;
    expect(secondDraft.draft_contract_digest).not.toBe(draft.draft_contract_digest);
    const beforeSecondActivation = loadRuntimeConfigFromFile(fixture.configPath);
    expect(beforeSecondActivation.capabilities?.find((capability) => capability.name === "billing.propose_refund_order")?.numeric_bounds).toEqual({ late_fee_cents: { minimum: 1, maximum: 5000 } });
  });

  it("refuses project escape and symlinked authoring inputs", async () => {
    const fixture = await projectFixture();
    const outside = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-action-outside-")), "outside.ts");
    await fs.writeFile(outside, actionSource("billing.propose_refund_order"));
    await expect(compileSafeActionDraft({ projectRoot: fixture.root, sourcePath: outside })).rejects.toThrow(/inside the project/);
    const linked = path.join(fixture.root, "linked-action.ts");
    await fs.symlink(outside, linked);
    await expect(compileSafeActionDraft({ projectRoot: fixture.root, sourcePath: linked })).rejects.toThrow(/symbolic link|regular file/);
  });
});

async function projectFixture(): Promise<{ root: string; configPath: string; contractPath: string; sourcePath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-safe-action-"));
  const contractPath = path.join(root, "synapsor.contract.json");
  const configPath = path.join(root, "synapsor.runner.json");
  const sourcePath = path.join(root, "synapsor", "actions", "refund-order.ts");
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.copyFile(path.join(workspaceRoot, "packages/spec/examples/guarded-writeback.contract.json"), contractPath);
  await fs.writeFile(configPath, `${JSON.stringify({
    version: 1,
    mode: "review",
    storage: { sqlite_path: "./.synapsor/local.db" },
    contracts: ["./synapsor.contract.json"],
    sources: {
      local_postgres: {
        engine: "postgres",
        read_url_env: "SYNAPSOR_DATABASE_READ_URL",
        write_url_env: "SYNAPSOR_DATABASE_WRITE_URL",
      },
    },
  }, null, 2)}\n`);
  await fs.writeFile(sourcePath, actionSource("billing.propose_refund_order"));
  return { root, configPath, contractPath, sourcePath };
}

function actionSource(name: string): string {
  return `import { defineCapability } from "@synapsor/runner/authoring";

export default defineCapability({
  name: "${name}",
  description: "Propose one bounded order refund for human review.",
  kind: "proposal",
  context: "local_operator",
  source: "local_postgres",
  subject: { resource: "billing_invoices" },
  args: {
    order_id: { type: "string", required: true, max_length: 128 },
    refund_cents: { type: "number", required: true, minimum: 1, maximum: 5000 },
    reason: { type: "string", required: true, max_length: 500 },
  },
  lookup: { id_from_arg: "order_id" },
  visible_fields: ["id", "tenant_id", "status", "balance_cents", "late_fee_cents", "waiver_reason", "updated_at"],
  kept_out_fields: ["internal_risk_score", "card_token", "customer_email"],
  evidence: { required: true, query_audit: true },
  max_rows: 1,
  proposal: {
    action: "refund_order",
    operation: { kind: "update" },
    allowed_fields: ["late_fee_cents", "waiver_reason"],
    patch: { late_fee_cents: { from_arg: "refund_cents" }, waiver_reason: { from_arg: "reason" } },
    numeric_bounds: { late_fee_cents: { minimum: 1, maximum: 5000 } },
    conflict_guard: { column: "updated_at" },
    approval: { mode: "human", required_role: "billing_reviewer" },
    writeback: { mode: "direct_sql" },
  },
});
`;
}
