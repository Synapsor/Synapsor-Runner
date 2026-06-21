import { afterEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneClient } from "./index.js";

describe("control plane client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers runners and sends heartbeats without database credentials", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, runner_id: "runner_1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const client = new ControlPlaneClient({ baseUrl: "https://api.synapsor.example/", runnerToken: "syn_wbr_test" });
    await client.register({
      schema_version: "synapsor.runner-registration.v1",
      runner_id: "runner_1",
      runner_version: "0.1.0-alpha.0",
      engines: ["postgres"],
      capabilities: ["writeback:claim", "writeback:complete"],
      scope: { project_id: "proj_1", source_ids: ["src_1"] },
      registered_at: "2026-06-20T00:00:00Z",
    });
    await client.runnerHeartbeat({ runner_id: "runner_1", engines: ["postgres"], source_ids: ["src_1"], status: "online" });

    expect(requests.map((request) => request.url)).toEqual([
      "https://api.synapsor.example/v1/runner/register",
      "https://api.synapsor.example/v1/runner/heartbeat",
    ]);
    expect(JSON.stringify(requests)).not.toMatch(/postgres(?:ql)?:\/\/|mysql:\/\/|password|secret/i);
  });

  it("fetches adapter tool catalogs and calls tools through Cloud APIs", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      if (String(url).endsWith("/v1/agent/adapters/tools")) {
        expect(body).toMatchObject({ adapter: "mcp.billing" });
        return new Response(JSON.stringify({
          ok: true,
          adapter_id: "mcp.billing",
          tools: [
            {
              name: "billing.propose_late_fee_waiver",
              description: "Create a reviewed proposal.",
              input_schema: { type: "object", properties: { invoice_id: { type: "string" } } },
              annotations: { readOnlyHint: false },
            },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (String(url).endsWith("/v1/agent/adapters/call-tool")) {
        expect(body).toMatchObject({
          adapter: "mcp.billing",
          tool: "billing.propose_late_fee_waiver",
          input: { invoice_id: "INV-3001" },
        });
        return new Response(JSON.stringify({
          ok: true,
          result: {
            status: "review_required",
            proposal_id: "wrp_1",
            source_database_mutated: false,
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ ok: false, error: "not_found" }), { status: 404 });
    }));

    const client = new ControlPlaneClient({ baseUrl: "https://api.synapsor.example", runnerToken: "syn_wbr_test" });
    const catalog = await client.adapterTools("mcp.billing", { session: { tenant_id: "acme" } });
    expect(catalog.tools).toHaveLength(1);
    expect(catalog.tools[0]?.name).toBe("billing.propose_late_fee_waiver");

    const result = await client.callAdapterTool("mcp.billing", "billing.propose_late_fee_waiver", { invoice_id: "INV-3001" });
    expect(result.response).toMatchObject({ status: "review_required", source_database_mutated: false });
  });

  it("renews leases through the existing writeback heartbeat path", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.synapsor.example/v1/writeback/jobs/wbj_1/heartbeat");
      expect(JSON.parse(String(init?.body || "{}"))).toEqual({ lease_seconds: 120 });
      return new Response(JSON.stringify({ ok: true, job_id: "wbj_1", lease_expires_at: 123 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const client = new ControlPlaneClient({ baseUrl: "https://api.synapsor.example", runnerToken: "syn_wbr_test" });
    await expect(client.renewLease("wbj_1", 120)).resolves.toMatchObject({ ok: true, job_id: "wbj_1" });
  });
});
