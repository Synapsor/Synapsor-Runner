import { afterEach, describe, expect, it, vi } from "vitest";
import type { PolicyManagementParent, RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ownerPolicyTestFixture } from "../../../packages/mcp-server/src/owner-policy-test-fixture.js";
import type { BoundaryAuthoringChat } from "./boundary-authoring-chat.js";
import * as stores from "./control-policy-store.js";
import * as reviewModule from "./owner-policy-parent-review.js";
import { collectOwnerBindings, runOperatorParentChat } from "./owner-policy-parent-chat.js";
import type { draftOperatorParentPolicy } from "./owner-policy-parent-model.js";

afterEach(() => vi.restoreAllMocks());

function fixture(choices: Array<string | undefined>, messages: Array<string | undefined> = []) {
  const f = ownerPolicyTestFixture("inventory", true);
  const scope = { level: "principal" as const, tenant_id: "acme", principal: "maya" };
  const parent: PolicyManagementParent = { schema_version: "synapsor.policy-management-parent.v1", delegation: f.parent,
    managers: [{ subject: "maya-login", actor_kind: "human", tenant_id: "acme", scope: { mode: "personal" }, permissions: ["inspect", "draft", "activate"] }],
    agent_owners: f.parent.agents.map((agent) => ({ agent, scope: { ...scope } })),
    runtime_delegations: [{ agent: f.parent.agents[0]!, delegator: "maya", owner: { ...scope }, policies: [{ scope: { ...scope }, name: "my_agent_rules" }] }] };
  const chooseOption = vi.fn(async () => choices.shift());
  const chat = { session: { chooseOption, showReviewDetails: vi.fn(async () => {}), confirm: vi.fn(async () => false) },
    readLiteral: vi.fn(async () => messages.shift()), readOperator: vi.fn(async () => messages.shift()),
    checkpoint: vi.fn(), rememberDetails: vi.fn(), showDetails: vi.fn(), streamModel: vi.fn(async () => {}),
    setModel: vi.fn(), close: vi.fn(), progress: async (_: string, action: () => Promise<unknown>) => action() } as unknown as BoundaryAuthoringChat;
  const close = vi.fn(async () => {});
  vi.spyOn(stores, "openProjectControlPolicies").mockResolvedValue({ close } as any);
  const review = { name: "parent", expected_epoch: 10, before_revision: "old", before: parent, after: parent,
    digest: `sha256:${"a".repeat(64)}` as const, expires_at: new Date(Date.now() + 300_000).toISOString() };
  const service = { context: vi.fn(async () => ({ epoch: 10, current: parent, rules: [f.compiled] })),
    prepare: vi.fn(async () => review), cancel: vi.fn(), confirm: vi.fn(async () => ({ epoch: 11, changed: true, revision_id: "new" })) };
  vi.spyOn(reviewModule, "createOperatorParentReview").mockReturnValue(service);
  const config: RuntimeConfig = { version: 1, mode: "read_only", sources: {}, capabilities: [], trusted_context: { provider: "environment" } };
  const input = { projectRoot: "/test", config, configPath: "/test/runner.json", storePath: "/test/control.db",
    name: "parent", env: {}, actor: "local:operator", recheckConfig: vi.fn(async () => {}) };
  const draft = vi.fn(async () => ({ state: "candidate" as const, parent, summary: "Owners may require human review for larger replenishments.",
    correction_used: false, authority_granted: false as const, source_database_changed: false as const }));
  const dependencies = { chat, modelSession: { provider: "openai" as const, model: "gpt-parent-test" }, draft };
  return { input, dependencies, draft, service, chat, parent, chooseOption, close };
}

describe("model-assisted operator delegation", () => {
  it("remains optional and makes no provider request or authority change on decline", async () => {
    const f = fixture(["no"]);
    expect(await runOperatorParentChat(f.input, f.dependencies)).toBe(0);
    expect(f.draft).not.toHaveBeenCalled();
    expect(f.service.prepare).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.chat.close).toHaveBeenCalledOnce();
  });

  it("requires metadata permission before any model request", async () => {
    const f = fixture(["yes", "details", "cancel"]);
    expect(await runOperatorParentChat(f.input, f.dependencies)).toBe(0);
    expect(f.chat.showDetails).toHaveBeenCalledOnce();
    expect(f.draft).not.toHaveBeenCalled();
    expect(f.service.confirm).not.toHaveBeenCalled();
  });

  it("keeps exact details on the same review and requires a separate explicit operator confirmation", async () => {
    const f = fixture(["yes", "allow", "details", "confirm"], ["Require human review above twenty units"]);
    await runOperatorParentChat(f.input, f.dependencies);
    expect(f.chat.session.showReviewDetails).toHaveBeenCalledOnce();
    expect(f.draft).toHaveBeenCalledOnce();
    expect(f.service.prepare).toHaveBeenCalledWith("parent", f.parent, 10);
    expect(f.service.confirm).toHaveBeenCalledOnce();
    expect(f.chooseOption).toHaveBeenCalledWith("REVIEW OWNER DELEGATION", expect.any(Array), expect.objectContaining({
      context: expect.arrayContaining([expect.stringMatching(/^Always required\s+valid_until > current_time$/u)]),
    }));
    expect(f.input.recheckConfig).toHaveBeenCalledOnce();
    expect(f.chat.checkpoint).toHaveBeenCalledWith("Owner delegation saved", expect.arrayContaining([
      expect.stringContaining("Owner chat is not connected yet"),
    ]), "success");
  });

  it("revises within the same conversation while preserving exact identity bindings", async () => {
    const f = fixture(["yes", "allow", "revise", "cancel"], ["Use twenty units", "Actually fifteen units"]);
    await runOperatorParentChat(f.input, f.dependencies);
    expect(f.draft).toHaveBeenCalledTimes(2);
    const calls = (f.draft.mock.calls as unknown as Array<[Parameters<typeof draftOperatorParentPolicy>[0]]>);
    expect(calls[0]![0].identityBindings).toEqual(calls[1]![0].identityBindings);
    expect(calls[0]![0].session.conversation).toBe(calls[1]![0].session.conversation);
    expect(f.service.cancel).toHaveBeenCalledTimes(2);
    expect(f.service.confirm).not.toHaveBeenCalled();
    expect(f.chat.readLiteral).not.toHaveBeenCalled();
  });

  it("lets a provider failure return to chat without exposing raw diagnostics or modifying authority", async () => {
    const f = fixture(["yes", "allow"], ["Use twenty units", undefined]);
    f.draft.mockRejectedValueOnce(Object.assign(new Error("secret-key private host"), { code: "PARENT_MODEL_UNAVAILABLE" }));
    await runOperatorParentChat(f.input, f.dependencies);
    expect(f.chat.rememberDetails).toHaveBeenCalledWith("Delegation draft not saved", ["PARENT_MODEL_UNAVAILABLE", expect.any(String)]);
    expect(f.service.prepare).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(f.chat.checkpoint).mock.calls)).not.toContain("secret-key");
  });

  it("does not confirm after concurrent configuration changes", async () => {
    const f = fixture(["yes", "allow", "confirm"], ["Use twenty units"]);
    f.input.recheckConfig.mockRejectedValueOnce(new Error("configuration changed"));
    await expect(runOperatorParentChat(f.input, f.dependencies)).rejects.toThrow("configuration changed");
    expect(f.service.confirm).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("explains a stale draft without overwriting the newer authority or leaking error text", async () => {
    const f = fixture(["yes", "allow"], ["Use twenty units"]);
    f.service.prepare.mockRejectedValueOnce(Object.assign(new Error("private connection diagnostic"), { code: "POLICY_PARENT_REVIEW_STALE" }));
    expect(await runOperatorParentChat(f.input, f.dependencies)).toBe(1);
    expect(f.service.confirm).not.toHaveBeenCalled();
    expect(f.chat.checkpoint).toHaveBeenCalledWith("Rules changed during drafting", expect.arrayContaining([
      expect.stringContaining("Reopen policy delegation"),
    ]), "warning");
    expect(JSON.stringify(vi.mocked(f.chat.checkpoint).mock.calls)).not.toContain("private connection");
    expect(f.close).toHaveBeenCalledOnce();
  });

  it.each(["personal", "tenant"])("collects explicit %s backend bindings locally, without model-selected identity or activation", async (mode) => {
    const f = fixture([mode], ["acme", "maya", "maya-login", "agent-a"]);
    const binding = await collectOwnerBindings(f.chat, "my_agent_rules");
    const scope = mode === "personal" ? { level: "principal", tenant_id: "acme", principal: "maya" } : { level: "tenant", tenant_id: "acme" };
    expect(binding).toMatchObject({ managers: [{ subject: "maya-login", scope: { mode: "exact", scope } }],
      agent_owners: [{ agent: "agent-a", scope }], runtime_delegations: [{ delegator: "maya", policies: [{ scope, name: "my_agent_rules" }] }] });
    expect(binding?.managers[0]?.actor_kind).toBe("human");
    expect(f.draft).not.toHaveBeenCalled();
    expect(f.service.confirm).not.toHaveBeenCalled();
  });

  it("reprompts malformed backend identifiers and never accepts blank input as authority", async () => {
    const f = fixture(["personal"], ["", "acme", "maya", "maya-login", "../agent", "agent-a"]);
    expect(await collectOwnerBindings(f.chat, "my_agent_rules")).toMatchObject({ agent_owners: [{ agent: "agent-a" }] });
    expect(f.chat.checkpoint).toHaveBeenCalledTimes(2);
    expect(f.service.confirm).not.toHaveBeenCalled();
  });
});
