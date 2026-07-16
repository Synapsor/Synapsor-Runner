import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudControlClient, CloudControlError, ControlPlaneClient } from "./index.js";

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
      runner_version: "0.1.0",
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

  it("marks a generic health fallback as unauthenticated", async () => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      requests.push(url);
      if (url.endsWith("/v1/writeback/runner/doctor")) {
        return new Response(JSON.stringify({ ok: false, error: "not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const client = new ControlPlaneClient({ baseUrl: "https://api.synapsor.example", runnerToken: "syn_run_test" });
    await expect(client.doctor()).resolves.toMatchObject({ ok: true, status: 200, authenticated: false });
    expect(requests).toEqual([
      "https://api.synapsor.example/v1/writeback/runner/doctor",
      "https://api.synapsor.example/health",
    ]);
  });

  it("submits only typed, redacted Runner activity", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ ok: true, event: { event_id: "replay:rpl_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const client = new ControlPlaneClient({ baseUrl: "https://synapsor.example", runnerToken: "syn_run_test" });
    await client.submitActivity({
      schema_version: "synapsor.runner-activity.v1",
      event_id: "replay:rpl_1",
      event_type: "replay.recorded",
      runner_id: "runner_1",
      source_id: "src_1",
      proposal_id: "wrp_1",
      evidence_ids: ["ev_1"],
      replay_id: "rpl_1",
      detail: { stored_locally: true, payload_uploaded: false },
    });
    expect(requests).toEqual([{ url: "https://synapsor.example/v1/runner/activity", body: expect.objectContaining({ event_type: "replay.recorded", replay_id: "rpl_1" }) }]);
    expect(JSON.stringify(requests)).not.toMatch(/database_url|password|private_key/i);
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
      expect(JSON.parse(String(init?.body || "{}"))).toEqual({
        runner_id: "runner_1",
        lease_id: "lease_1",
        lease_seconds: 120,
      });
      return new Response(JSON.stringify({ ok: true, job_id: "wbj_1", lease_expires_at: 123 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const client = new ControlPlaneClient({ baseUrl: "https://api.synapsor.example", runnerToken: "syn_wbr_test", runnerId: "runner_1" });
    await expect(client.renewLease("wbj_1", "lease_1", undefined, 120)).resolves.toMatchObject({ ok: true, job_id: "wbj_1" });
  });

  it("keeps reviewed inverse row values local when reporting Cloud results", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ ok: true, status: "applied" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));
    const client = new ControlPlaneClient({ baseUrl: "https://api.synapsor.example", runnerToken: "syn_run_test", runnerId: "runner_1" });
    await client.result({
      protocol_version: "2.0",
      job_id: "wbj_1",
      runner_id: "runner_1",
      operation: "single_row_update",
      receipt_authority: "runner_ledger",
      status: "applied",
      affected_rows: 1,
      target_identity: [{ column: "id", value: "INV-1" }],
      result_hash: `sha256:${"a".repeat(64)}`,
      completed_at: "2026-07-16T00:00:00.000Z",
      inverse: {
        schema_version: "synapsor.inverse-descriptor.v1",
        availability: "available",
        reason_codes: [],
        operation: "restore_update",
        cardinality: "single",
        forward_proposal_id: "wrp_1",
        forward_writeback_job_id: "wbj_1",
        target: { source_id: "src_1", schema: "public", table: "invoices", primary_key_column: "id" },
        tenant_guard: { column: "tenant_id", value: "acme" },
        allowed_columns: ["status"],
        members: [{ primary_key: { column: "id", value: "INV-1" }, expected_state: { status: "closed", version: 2 }, restore_values: { status: "open" } }],
        max_rows: 1,
        aggregate_bounds: [],
        version_advance: { column: "version", strategy: "integer_increment" },
        lineage: { root_proposal_id: "wrp_1", parent_proposal_id: "wrp_1", reverts_proposal_id: "wrp_1", depth: 1 },
      },
    }, "lease_1");

    expect(body).not.toHaveProperty("inverse");
    expect(JSON.stringify(body)).not.toContain("open");
    expect(body).toMatchObject({ lease_id: "lease_1", status: "applied", result_hash: `sha256:${"a".repeat(64)}` });
  });

  it("keeps Cloud lease ownership attached to claimed jobs", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body || "{}"))).toMatchObject({ source_id: "src_1", runner_id: "runner_1" });
      return new Response(JSON.stringify({
        ok: true,
        jobs: [{
          schema_version: "synapsor.writeback-job.v1",
          writeback_job_id: "wbj_1",
          proposal_id: "wrp_1",
          proposal_version: 1,
          proposal_hash: `sha256:${"a".repeat(64)}`,
          runner_scope: { project_id: "proj_1", source_id: "src_1" },
          engine: "postgres",
          operation: "single_row_update",
          target: { schema: "public", table: "invoices", primary_key: { column: "id", value: "INV-1" } },
          tenant_guard: { column: "tenant_id", value: "acme" },
          allowed_columns: ["status"],
          patch: { status: "paid" },
          conflict_guard: { kind: "column", column: "version", expected_value: 1 },
          idempotency_key: "wrp_1",
          lease: { lease_id: "lease_1", attempt: 2, expires_at: "2026-07-15T12:00:00Z" },
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const client = new ControlPlaneClient({ baseUrl: "https://api.synapsor.example", runnerToken: "syn_run_test", sourceId: "src_1", runnerId: "runner_1" });
    const [job] = await client.claim();
    expect(job?.cloud_lease).toEqual({ leaseId: "lease_1", attempt: 2, expiresAt: "2026-07-15T12:00:00Z" });
  });

  it("pushes canonical contracts with service credentials and verifies the returned digest", async () => {
    const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      const digest = String(body.local_digest);
      requests.push({ url: String(input), headers: new Headers(init?.headers), body });
      return new Response(JSON.stringify({ ok: true, digest, contract_id: "act_1", contract_version_id: "actv_1" }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "req_1" },
      });
    }));

    const client = new CloudControlClient({
      baseUrl: "https://api.synapsor.example/",
      credential: "syn_api_service_secret",
      credentialKind: "service",
      maxRetries: 0,
    });
    const result = await client.pushContract({
      projectId: "project one",
      contract: { spec_version: "0.1", kind: "SynapsorContract", contexts: [], capabilities: [] },
      name: "empty-contract",
      source: "cli",
      sourceVersions: { "@synapsor/spec": "1.4.2" },
      idempotencyKey: "push-1",
    });

    expect(result.local_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(requests[0]?.url).toBe("https://api.synapsor.example/v1/control/projects/project%20one/agent-contracts");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer syn_api_service_secret");
    expect(requests[0]?.headers.get("idempotency-key")).toBe("push-1");
    expect(requests[0]?.headers.get("x-synapsor-credential-kind")).toBe("service");
  });

  it("rejects a remote digest mismatch without retrying the mutation", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      digest: `sha256:${"f".repeat(64)}`,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CloudControlClient({ baseUrl: "https://api.synapsor.example", credential: "syn_api_test", maxRetries: 2 });

    await expect(client.pushContract({
      projectId: "project-1",
      contract: { spec_version: "0.1", kind: "SynapsorContract", contexts: [], capabilities: [] },
      source: "runner",
    })).rejects.toMatchObject({ error_code: "contract_digest_mismatch", retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves classified Cloud errors, request IDs, and server retry timing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: false,
        error: "temporarily_unavailable",
        message: "Pool is saturated.",
        retryable: true,
        retry_after_ms: 0,
      }), { status: 503, headers: { "content-type": "application/json", "x-request-id": "req_retry" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, projects: [] }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new CloudControlClient({ baseUrl: "https://api.synapsor.example", credential: "syn_api_test", maxRetries: 1 });
    await expect(client.get("/v1/control/projects")).resolves.toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: false, error: "feature_not_entitled" }), {
      status: 403,
      headers: { "content-type": "application/json", "x-request-id": "req_denied" },
    })));
    await expect(client.get("/v1/control/projects")).rejects.toEqual(expect.objectContaining<Partial<CloudControlError>>({
      error_code: "feature_not_entitled",
      retryable: false,
      request_id: "req_denied",
      status: 403,
    }));
  });
});
