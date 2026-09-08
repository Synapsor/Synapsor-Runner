import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig, PolicyManagementParent } from "@synapsor-runner/mcp-server";
import { ownerPolicyTestFixture } from "../../../packages/mcp-server/src/owner-policy-test-fixture.js";
import * as authority from "./action-rule-authority.js";
import { migrateProjectControlPolicies, type BoundProjectPolicyStore } from "./control-policy-store.js";
import { createOperatorParentReview } from "./owner-policy-parent-review.js";

const roots: string[] = [], bindings: BoundProjectPolicyStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const binding of bindings.splice(0)) await binding.close();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-parent-review-")); roots.push(root);
  const config: RuntimeConfig = { version: 1, mode: "read_only", sources: {}, capabilities: [], trusted_context: { provider: "environment" } };
  const migrated = await migrateProjectControlPolicies({ projectRoot: root, config, storePath: path.join(root, "control.db"),
    actor: "test-local-operator", readLegacySnapshot: async () => ({ revisions: [], active: [], drafts: [], provenance: [] }),
    validateSnapshot: async (snapshot) => expect(snapshot.revisions).toEqual([]) });
  const binding = migrated.binding; bindings.push(binding);
  const source = ownerPolicyTestFixture("inventory", true);
  const rules = vi.spyOn(authority, "createActiveActionRuleAuthorityLoader").mockReturnValue(async () => ({
    registry: { rules: [{ compiled: source.compiled }] },
  }) as any);
  const owner = { level: "principal" as const, tenant_id: "acme", principal: "maya" };
  const parent: PolicyManagementParent = { schema_version: "synapsor.policy-management-parent.v1", delegation: source.parent,
    managers: [{ subject: "maya-login", actor_kind: "human", tenant_id: "acme", scope: { mode: "personal" }, permissions: ["inspect", "draft", "activate"] }],
    agent_owners: [{ agent: "agent-a", scope: { ...owner } }, { agent: "agent-b", scope: { ...owner } }],
    runtime_delegations: [{ agent: "agent-a", owner: { ...owner }, delegator: "maya-login", policies: [{ scope: { ...owner }, name: "my_rules" }] }],
  };
  const review = createOperatorParentReview({ projectRoot: root, binding, config, actor: "local:test-operator" });
  return { root, binding, config, source, rules, parent, review };
}

describe("trusted local operator delegation review", () => {
  it("validates coded field vocabulary before a separate exact one-use activation and keeps no-op edits stable", async () => {
    const f = await fixture();
    const before = await f.binding.repository.deployment(f.binding.deployment_id);
    const prepared = await f.review.prepare("inventory_owner_rules", f.parent);
    expect(await f.binding.repository.deployment(f.binding.deployment_id)).toEqual(before);
    expect(prepared.after.delegation.outcomes[0]?.facts[1]?.source).toEqual({ kind: "field", binding: "request", field: "f09" });
    expect(prepared.before).toBeNull();
    const receipt = await f.review.confirm(prepared);
    expect(receipt).toMatchObject({ changed: true, epoch: before!.epoch + 1 });
    await expect(f.review.confirm(prepared)).rejects.toMatchObject({ code: "POLICY_PARENT_REVIEW_STALE" });
    const stored = await f.binding.repository.exactPointerSnapshot({ deployment_id: f.binding.deployment_id,
      key: { scope: { level: "operator" }, kind: "parent", name: prepared.name } });
    expect(stored.active?.content).toEqual(f.parent);
    const unchanged = await f.review.prepare(prepared.name, f.parent);
    expect(unchanged.before).toEqual(f.parent);
    expect(await f.review.confirm(unchanged)).toMatchObject({ changed: false, epoch: receipt.epoch });
  }, 20_000);

  it("rejects invented facts, unowned agents and stale compiled Action bindings before mutation", async () => {
    const f = await fixture();
    const epoch = (await f.binding.repository.deployment(f.binding.deployment_id))!.epoch;
    const invented = structuredClone(f.parent);
    invented.delegation.outcomes[0]!.facts[0]!.source = { kind: "field", binding: "request", field: "invented" };
    await expect(f.review.prepare("inventory_owner_rules", invented)).rejects.toMatchObject({ code: "OWNER_POLICY_FACT_NOT_VERIFIED" });
    await expect(f.review.prepare("inventory_owner_rules", { ...f.parent, agent_owners: f.parent.agent_owners.slice(0, 1) }))
      .rejects.toMatchObject({ code: "POLICY_PARENT_OWNER_INVALID" });
    const changed = structuredClone(f.parent);
    changed.delegation.outcomes[0]!.compiled_plan_digest = `sha256:${"c".repeat(64)}`;
    await expect(f.review.prepare("inventory_owner_rules", changed)).rejects.toMatchObject({ code: "OWNER_POLICY_PARENT_CHANGED" });
    expect((await f.binding.repository.deployment(f.binding.deployment_id))!.epoch).toBe(epoch);
  }, 20_000);

  it("refuses tampered, copied, cancelled and superseded review objects", async () => {
    const f = await fixture();
    const context = await f.review.context("inventory_owner_rules");
    expect(context.current).toBeNull();
    expect(context.rules[0]?.compiled_plan_digest).toBe(f.source.compiled.compiled_plan_digest);
    const prepared = await f.review.prepare("inventory_owner_rules", f.parent);
    await expect(f.review.confirm(structuredClone(prepared))).rejects.toMatchObject({ code: "POLICY_PARENT_REVIEW_STALE" });
    prepared.after.managers[0]!.permissions.push("revoke");
    await expect(f.review.confirm(prepared)).rejects.toMatchObject({ code: "POLICY_PARENT_REVIEW_STALE" });
    const cancelled = await f.review.prepare("inventory_owner_rules", f.parent);
    f.review.cancel(cancelled);
    await expect(f.review.confirm(cancelled)).rejects.toMatchObject({ code: "POLICY_PARENT_REVIEW_STALE" });
    const stale = await f.review.prepare("inventory_owner_rules", f.parent);
    const current = await f.review.prepare("inventory_owner_rules", f.parent);
    await f.review.confirm(current);
    await expect(f.review.confirm(stale)).rejects.toMatchObject({ code: "POLICY_PARENT_REVIEW_STALE" });
    await expect(f.review.prepare("inventory_owner_rules", f.parent, context.epoch))
      .rejects.toMatchObject({ code: "POLICY_PARENT_REVIEW_STALE" });
  }, 20_000);

  it("revalidates current Actions at confirmation and never enables writes or child policies", async () => {
    const f = await fixture();
    const prepared = await f.review.prepare("inventory_owner_rules", f.parent);
    f.source.compiled.compiled_plan_digest = `sha256:${"d".repeat(64)}`;
    await expect(f.review.confirm(prepared)).rejects.toMatchObject({ code: "OWNER_POLICY_PARENT_CHANGED" });
    expect((await f.binding.repository.scopeSnapshot({ deployment_id: f.binding.deployment_id,
      scope: { level: "operator" }, kinds: ["parent", "delegation", "execution"] })).active).toEqual([]);
    expect(f.config.mode).toBe("read_only");
  }, 20_000);
});
