import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { PolicyManagementTools } from "@synapsor-runner/mcp-server";
import { createOwnerSettingsMcpServer } from "./authoring-mcp.js";
import { computeAskAuthority } from "./ask-authority.js";
import { askToolSurfaceDigest, WorkbenchAskSession, type AskToolDefinition, type AskToolGateway } from "./model-ask.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function surface() {
  const calls: Array<{ name: string; args: unknown }> = [];
  const provider = {
    handles: (args: unknown) => typeof args === "object" && args !== null && Object.hasOwn(args, "policy_view"),
    callTool: async (name: string, args: unknown) => {
      calls.push({ name, args });
      return { ok: true, policy_view: "agent_rules", source: "runner_control_plane", source_database_changed: false,
        ...(name === "app.describe_data" ? { resources: [{ id: "runner.agent_rules" }] }
          : { active: { action_count: 1 }, agents_available: ["agent-a"], draft: null }) };
    },
  } satisfies PolicyManagementTools;
  const server = createOwnerSettingsMcpServer(provider), client = new Client({ name: "settings-ask-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  const tools: AskToolDefinition[] = (await client.listTools()).tools.map((tool) => ({ name: tool.name,
    description: tool.description ?? "", input_schema: tool.inputSchema, metadata: tool._meta }));
  const close = async () => { await client.close(); await server.close(); };
  const intent = vi.fn(async () => { throw new Error("Source-plan checks must not run for settings"); });
  const gateway: AskToolGateway = { mode: "authoring", ownerSettingsOnly: true, listTools: () => tools,
    resolveAskIntentCheck: intent,
    callTool: async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      return { ok: !result.isError, value: result.structuredContent as Record<string, unknown> };
    }, close };
  return { tools, gateway, close, calls, intent };
}

describe("local owner settings Ask binding", () => {
  it("binds a settings-only session without inventing active source Read authority", async () => {
    const fixture = await surface();
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-settings-ask-")); roots.push(root);
      const configPath = path.join(root, "synapsor.runner.json");
      await fs.writeFile(configPath, JSON.stringify({ version: 1, mode: "read_only" }));
      const input = { tools: fixture.tools, projectRoot: root, configPath, profile: "development" as const, mode: "authoring" as const };
      await expect(computeAskAuthority(input)).rejects.toMatchObject({ code: "ASK_AUTHORING_AUTHORITY_UNAVAILABLE" });
      const ownerManagementBinding = canonicalJsonDigest("authenticated-session-A");
      const first = await computeAskAuthority({ ...input, ownerManagementBinding });
      expect(first.active_boundary_digest).toBeUndefined();
      expect(first.active_boundary_set_digest).toBeUndefined();
      const second = await computeAskAuthority({ ...input, ownerManagementBinding: canonicalJsonDigest("authenticated-session-B") });
      expect(first.authority_digest).not.toBe(second.authority_digest);
      const mixed = structuredClone(fixture.tools);
      (mixed.find((tool) => tool.name === "app.explore_data")!.input_schema.properties as Record<string, unknown>).plan = { type: "object" };
      await expect(computeAskAuthority({ ...input, tools: mixed, ownerManagementBinding })).rejects.toMatchObject({ code: "ASK_AUTHORING_AUTHORITY_UNAVAILABLE" });
      const unmarked = fixture.tools.map(({ metadata: _metadata, ...tool }) => tool);
      await expect(computeAskAuthority({ ...input, tools: unmarked, ownerManagementBinding })).rejects.toMatchObject({ code: "ASK_AUTHORING_AUTHORITY_UNAVAILABLE" });
      expect(await fs.readdir(root)).toEqual(["synapsor.runner.json"]);
    } finally { await fixture.close(); }
  });

  it.each(["openai", "anthropic", "openai_compatible"] as const)("runs %s settings chat without source-query corrections or human credentials", async (provider) => {
    const fixture = await surface();
    const session = new WorkbenchAskSession();
    const authority = askToolSurfaceDigest(fixture.tools);
    session.configure({ provider, model: provider === "anthropic" ? "claude-test" : "gpt-5.6-terra",
      ...(provider === "openai_compatible" ? { base_url: "http://127.0.0.1:11434/v1" } : { api_key: "model-test-key" }),
      authority_digest: authority, egress_acknowledged: true });
    let iteration = 0;
    const requests: unknown[] = [];
    const reply = async (request: { body: Record<string, unknown> }) => {
      requests.push(request.body);
      const step = iteration++;
      if (step > 2) throw new Error("Unexpected settings/source correction loop");
      const name = step === 0 ? "app__describe_data" : "app__explore_data";
      const args = { policy_view: "agent_rules", ...(step === 1 ? { section: "summary" } : {}) };
      return { status: 200, body: provider === "anthropic"
        ? { content: step < 2 ? [{ type: "tool_use", id: `call_${step}`, name, input: args }]
          : [{ type: "text", text: "One action is configured for agent-a. No draft is pending." }], stop_reason: step < 2 ? "tool_use" : "end_turn" }
        : { choices: [{ message: step < 2 ? { role: "assistant", content: null, tool_calls: [{ id: `call_${step}`, type: "function",
          function: { name, arguments: JSON.stringify(args) } }] } : { role: "assistant", content: "One action is configured for agent-a. No draft is pending." } }] } };
    };
    try {
      const result = await session.run("Show my current agent rules.", fixture.gateway, { requestJson: reply }, authority);
      expect(result.answer).toContain("One action");
      expect(fixture.intent).not.toHaveBeenCalled();
      expect(fixture.calls).toEqual([
        { name: "app.describe_data", args: { policy_view: "agent_rules" } },
        { name: "app.explore_data", args: { policy_view: "agent_rules", section: "summary" } },
      ]);
      expect(result.tool_calls.every((trace) => trace.question_to_plan_checked === undefined)).toBe(true);
      expect(JSON.stringify(requests)).not.toMatch(/human-review-token|review_nonce/);
      expect(result.source_database_changed).toBe(false);
    } finally { await fixture.close(); }
  });
});
