import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ControlPolicyRepository } from "@synapsor-runner/proposal-store";
import * as actionAuthority from "./action-rule-authority.js";
import { onboard, start } from "./guided-start.js";
import { loadBoundaryReviewContext } from "./boundary-commands.js";
import { activateExplorationBoundary } from "./auto-boundary.js";
import { activateActionRuleAuthority, readActionRuleAuthorityDraft } from "./action-rule-authority.js";
import { semanticActionRuntimeConfig, semanticSupervisedExecutionConfig } from "./semantic-action-deployment.js";
import { openBoundProjectControlPolicies } from "./control-policy-store.js";
import { OperatorAuthorityRepository } from "./control-policy-operator-repository.js";
import { parseOperatorExecutionPolicy, encodeOperatorExecutionPolicy } from "./control-policy-execution.js";
import { OPERATOR_EXECUTION_POLICY_KEY } from "./control-policy-record.js";
import { structuredTestAction as action, structuredTestInspection as inspection } from "./structured-authoring-test-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture(execution = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-structured-execution-")); roots.push(root);
  vi.stubEnv("TEST_READ_URL", "postgresql://fixture.invalid/not-used");
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SYNAPSOR_DATABASE_WRITE_URL", "SYNAPSOR_RUNNER_CONFIG", "SYNAPSOR_MCP_CONFIG"]) vi.stubEnv(key, undefined);
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const run = async (args: string[], spelling: "start" | "onboard" = "onboard", inspect = async () => inspection()) => {
    output.mockClear();
    const supplied = ["--project-root", root, ...args, "--json"];
    const code = await (spelling === "start" ? start(supplied, { interactive: false, schemaInspector: inspect })
      : onboard(["db", ...supplied], { interactive: false, schemaInspector: inspect }));
    const text = output.mock.calls.map(([chunk]) => String(chunk)).join("");
    return { code, result: JSON.parse(text) };
  };
  expect((await run(["--from-env", "TEST_READ_URL", "--schema", "warehouse"])).code).toBe(0);
  expect((await run(["--export-draft", "initial.json"])).code).toBe(0);
  const initial = JSON.parse(await fs.readFile(path.join(root, "initial.json"), "utf8"));
  initial.read.resources = [{ resource_id: "warehouse.items", include: true, principal_key: "principal_id", row_identity: "item_id", tenant_key: "tenant_id",
    selectable_fields: ["sku", "q_av", "reorder_point", "available", "item_id", "version"],
    withhold_from_model_fields: ["item_id", "version", "available"], private_model_fields: ["item_id", "version", "available"], keep_out_fields: ["internal_note"] }];
  initial.actions = [action("quantity", "q_av", 50, 20), action("reorder", "reorder_point", 30, 10)];
  await fs.writeFile(path.join(root, "initial.json"), JSON.stringify(initial));
  expect((await run(["--draft", "initial.json"])).code).toBe(0);
  const context = await loadBoundaryReviewContext(root);
  await activateExplorationBoundary({ projectRoot: root, candidate: context.candidate, expectedDigest: context.bundle.candidate_digest,
    reviewDraft: context.candidate, generationLock: context.lock, expectedAuthoring: context.bundle.mutation_bindings.authoring,
    actor: "fixture_operator", confirmation: `ACTIVATE ${context.bundle.candidate_digest}`,
    confirmedDecisions: context.candidate.unresolved_decisions, currentInspection: inspection() });
  const draft = (await readActionRuleAuthorityDraft(root, `${context.candidate.pack.name}_rules`))!;
  const active = await activateActionRuleAuthority({ projectRoot: root, name: draft.authority.name, expected_digest: draft.digest,
    actor: "fixture_operator", confirmation: `ACTIVATE ${draft.digest}` });
  const primaryPath = path.join(root, "synapsor.runner.json"), configPath = path.join(root, "synapsor.actions.runner.json");
  const primary = JSON.parse(await fs.readFile(primaryPath, "utf8"));
  const raw = semanticSupervisedExecutionConfig({ sourceConfig: semanticActionRuntimeConfig({ projectRoot: root, sourceConfigPath: primaryPath,
    outputConfigPath: configPath, sourceConfig: primary, draft, preserveActionRuntime: false }), activation: active,
    outcome: "warehouse.quantity", profile: "staging", writeUrlEnv: "TEST_WRITE_URL", writerPostureFingerprint: `sha256:${"a".repeat(64)}` });
  const config = resolveRuntimeConfig(raw as RuntimeConfig, root);
  await fs.writeFile(configPath, JSON.stringify(raw), { mode: 0o600 });
  const binding = (await openBoundProjectControlPolicies(root))!;
  try {
    const repository = new OperatorAuthorityRepository(binding, config), executionRevision = encodeOperatorExecutionPolicy(config)!;
    // Test setup uses the actual stored-execution parser and exact current Action.
    // Installed qualification separately exercises the public operator review.
    if (execution) await repository.commit({ expected_epoch: (await repository.current()).epoch, actor: "fixture_operator", operation: "fixture_reviewed_execution",
      active: [{ key: OPERATOR_EXECUTION_POLICY_KEY, policy: parseOperatorExecutionPolicy(executionRevision.content, config) }] });
  } finally { await binding.close(); }
  const state = async () => {
    const bound = (await openBoundProjectControlPolicies(root))!;
    try { return await new OperatorAuthorityRepository(bound, config).current(); } finally { await bound.close(); }
  };
  const ledger = () => {
    const db = new DatabaseSync(path.join(root, ".synapsor/local.db"), { readOnly: true });
    try { return Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[])
      .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}"`).all()])); } finally { db.close(); }
  };
  return { root, run, state, ledger, config, configPath, primaryPath, active };
}

describe("structured draft save with genuine stored execution", () => {
  it.each(["start", "onboard"] as const)("saves the exact disabled 3-to-1 candidate via %s without altering current execution", async spelling => {
    const f = await fixture();
    const before = await f.state(), configBefore = await fs.readFile(f.configPath, "utf8"), ledgerBefore = f.ledger();
    expect(before.active.some(entry => entry.policy.type === "execution")).toBe(true);
    expect((await f.run(["--export-draft", "edit.json"], spelling)).code).toBe(0);
    const input = JSON.parse(await fs.readFile(path.join(f.root, "edit.json"), "utf8"));
    const original = structuredClone(input);
    for (const entry of input.actions) {
      const limit = entry.approval.shared_limits.find((limit: { id: string }) => limit.id === "joint_company");
      expect(limit).toMatchObject({ maximum: 3, scope: "tenant", window_seconds: 86400 }); limit.maximum = 1;
    }
    await fs.writeFile(path.join(f.root, "edit.json"), JSON.stringify(input));
    const compile = vi.spyOn(actionAuthority, "buildActionRuleAuthorityDraft");
    const preview = await f.run(["--draft", "edit.json", "--dry-run"], spelling);
    expect(preview).toMatchObject({ code: 0, result: { state: "validated_disabled_preview" } });
    expect(await f.state()).toEqual(before);
    const previewCandidate = compile.mock.results.at(-1)!.value as Awaited<ReturnType<typeof readActionRuleAuthorityDraft>>;
    expect(previewCandidate).toBeDefined();
    compile.mockRestore();
    const save = await f.run(["--draft", "edit.json"], spelling);
    expect(save, JSON.stringify(save)).toMatchObject({ code: 0, result: { state: "saved_disabled" } });
    const after = await f.state();
    // Exported Read requests refresh disabled authoring/review bookkeeping.
    // They do not replace any active Read, Action or execution authority.
    expect(after.active.filter(entry => entry.policy.type !== "read_authoring"))
      .toEqual(before.active.filter(entry => entry.policy.type !== "read_authoring"));
    expect(await fs.readFile(f.configPath, "utf8")).toBe(configBefore);
    const candidate = after.drafts.find(entry => entry.policy.type === "action")!.policy;
    expect(candidate.type).toBe("action");
    if (candidate.type !== "action") throw new Error("Missing disabled Action");
    expect(candidate.authority.state).toBe("disabled");
    expect(candidate.authority.authority.catalog).toEqual(f.active.authority.catalog);
    expect(candidate.authority.authority.approval_classes[0]!.shared_limits.find(limit => limit.id === "joint_company")!.maximum).toBe(1);
    const withoutTimes = (rules: typeof f.active.authority.rules) => rules.map(({ activated_at: _time, ...rule }) => rule);
    expect(withoutTimes(candidate.authority.authority.rules)).toEqual(withoutTimes(f.active.authority.rules));
    const approvalBefore = structuredClone(f.active.authority.approval_classes);
    approvalBefore[0]!.shared_limits.find(limit => limit.id === "joint_company")!.maximum = 1;
    expect(candidate.authority.authority.approval_classes).toEqual(approvalBefore);
    expect(withoutTimes(candidate.authority.authority.rules)).toEqual(withoutTimes(previewCandidate!.authority.rules));
    expect(candidate.authority.authority.catalog).toEqual(previewCandidate!.authority.catalog);
    expect(candidate.authority.authority.approval_classes).toEqual(previewCandidate!.authority.approval_classes);
    expect(candidate.authority.reviews).toEqual(previewCandidate!.reviews);
    const afterLedger = f.ledger();
    for (const [table, rows] of Object.entries(ledgerBefore)) if (!table.startsWith("control_policy_")) expect(afterLedger[table], table).toEqual(rows);
    expect((await f.run(["--export-draft", "saved.json"], spelling)).code).toBe(0);
    const saved = JSON.parse(await fs.readFile(path.join(f.root, "saved.json"), "utf8"));
    expect(saved.actions).toEqual(input.actions);
    expect(saved.read).toEqual(original.read);
  });

  it.each(["missing_all", "missing_companion", "wrong_project", "wrong_source", "wrong_store", "ambiguous", "stale"] as const)(
    "refuses %s execution context before export, preview and save without touching stored records", async problem => {
      const f = await fixture();
      expect((await f.run(["--export-draft", "edit.json"])).code).toBe(0);
      const before = f.ledger(), active = await f.state();
      const raw = JSON.parse(await fs.readFile(f.configPath, "utf8"));
      if (problem === "missing_all" || problem === "missing_companion") {
        await fs.rename(f.configPath, f.configPath + ".unavailable");
        if (problem === "missing_all") await fs.rename(f.primaryPath, f.primaryPath + ".unavailable");
      } else if (problem === "ambiguous") {
        await fs.mkdir(path.join(f.root, "synapsor"), { recursive: true });
        await fs.copyFile(f.primaryPath, path.join(f.root, "synapsor/synapsor.runner.json"));
      } else {
        if (problem === "wrong_project") raw.action_rules.project_root = os.tmpdir();
        if (problem === "wrong_source") Object.values(raw.sources as Record<string, { read_url_env: string }>)[0]!.read_url_env = "OTHER_SOURCE_URL";
        if (problem === "wrong_store") raw.storage = { sqlite_path: "another.db" };
        if (problem === "stale") raw.action_rules.enabled = false;
        await fs.writeFile(f.configPath, JSON.stringify(raw));
      }
      for (const args of [["--export-draft", "refused.json"], ["--draft", "edit.json", "--dry-run"], ["--draft", "edit.json"]]) {
        const result = await f.run(args);
        expect(result.code, JSON.stringify(result)).toBe(2);
        expect(result.result).toMatchObject({ ok: false, active_authority_changed: false, disabled_authority_changed: false });
        expect(f.ledger()).toEqual(before);
        expect(await f.state()).toEqual(active);
      }
      await expect(fs.access(path.join(f.root, "refused.json"))).rejects.toMatchObject({ code: "ENOENT" });
    });

  it("does not require runtime configuration or writer credentials when no execution record exists", async () => {
    const f = await fixture(false);
    await fs.rename(f.configPath, f.configPath + ".unavailable");
    await fs.rename(f.primaryPath, f.primaryPath + ".unavailable");
    expect((await f.run(["--export-draft", "draft.json"])).code).toBe(0);
    expect((await f.run(["--draft", "draft.json", "--dry-run"])).code).toBe(0);
    const before = await f.state();
    expect((await f.run(["--draft", "draft.json"])).code).toBe(0);
    const after = await f.state();
    expect(after.active.filter(entry => entry.policy.type !== "read_authoring"))
      .toEqual(before.active.filter(entry => entry.policy.type !== "read_authoring"));
    expect(after.active.some(entry => entry.policy.type === "execution")).toBe(false);
  });

  it.each(["draft", "current", "context", "context_during_preparation"] as const)(
    "rejects a competing %s change after preview and preserves the winner", async change => {
      const f = await fixture();
      expect((await f.run(["--export-draft", "edit.json"])).code).toBe(0);
      expect((await f.run(["--draft", "edit.json", "--dry-run"])).code).toBe(0);
      const modifyContext = async () => {
        const raw = JSON.parse(await fs.readFile(f.configPath, "utf8")); raw.action_rules.enabled = false;
        await fs.writeFile(f.configPath, JSON.stringify(raw));
      };
      if (change === "draft") {
        const replacement = actionAuthority.buildActionRuleAuthorityDraft({ name: f.active.authority.name,
          action_boundary_name: f.active.authority.action_boundary.name, catalog: f.active.authority.catalog,
          rules: f.active.authority.rules, approval_classes: f.active.authority.approval_classes, reviews: f.active.reviews });
        await actionAuthority.writeActionRuleAuthorityDraft(f.root, replacement);
      }
      if (change === "current") await actionAuthority.deactivateActionRuleAuthority(f.root);
      if (change === "context") await modifyContext();
      const before = f.ledger();
      let changed = false;
      const result = await f.run(["--draft", "edit.json"], "onboard", async () => {
        if (change === "context_during_preparation" && !changed) { changed = true; await modifyContext(); }
        return inspection();
      });
      expect(result.code, JSON.stringify(result)).toBe(2);
      expect(f.ledger()).toEqual(before);
      if (change === "context_during_preparation") expect(changed).toBe(true);
    });

  it.each(["before_commit", "lost_acknowledgement"] as const)("preserves atomic state and supports exact reopen after %s", async failure => {
    const f = await fixture();
    expect((await f.run(["--export-draft", "edit.json"])).code).toBe(0);
    const before = await f.state(), ledgerBefore = f.ledger();
    const commit = ControlPolicyRepository.prototype.commit;
    const fault = vi.spyOn(ControlPolicyRepository.prototype, "commit").mockImplementationOnce(async function (this: ControlPolicyRepository, ...args) {
      if (failure === "lost_acknowledgement") await commit.apply(this, args);
      throw Object.assign(new Error("Injected structured persistence acknowledgement failure"), { code: "EIO" });
    });
    const result = await f.run(["--draft", "edit.json"]);
    fault.mockRestore();
    expect(result.code).toBe(2);
    expect(result.result.disabled_authority_changed).toBe("unknown");
    const reopened = await f.state();
    expect(reopened.active.filter(entry => entry.policy.type !== "read_authoring"))
      .toEqual(before.active.filter(entry => entry.policy.type !== "read_authoring"));
    if (failure === "before_commit") {
      expect(f.ledger()).toEqual(ledgerBefore);
      expect((await f.run(["--draft", "edit.json"])).code).toBe(0);
    } else {
      expect(reopened.epoch).toBe(before.epoch + 1);
      expect((await f.run(["--draft", "edit.json"])).code).toBe(2);
      expect(await f.state()).toEqual(reopened);
      expect((await f.run(["--export-draft", "fresh.json"])).code).toBe(0);
      expect((await f.run(["--draft", "fresh.json", "--dry-run"])).code).toBe(0);
      expect((await f.run(["--draft", "fresh.json"])).code).toBe(0);
    }
  });
});
