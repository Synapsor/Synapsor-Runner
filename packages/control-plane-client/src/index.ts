import {
  parseRunnerRegistration,
  parseWritebackJob,
  parseWritebackResult,
  type RunnerRegistrationV1,
  type WritebackJob,
  type WritebackResult,
} from "@synapsor-runner/protocol";

export type ControlPlaneClientConfig = {
  baseUrl: string;
  runnerToken: string;
  sourceId?: string;
};

export type ClaimOptions = {
  sourceId?: string;
  limit?: number;
  leaseSeconds?: number;
};

export type AdapterToolCatalogEntry = {
  name: string;
  title?: string;
  description?: string;
  input_schema?: Record<string, unknown>;
  output_schema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

export type AdapterToolCatalog = {
  adapter_id?: string;
  tools: AdapterToolCatalogEntry[];
  raw?: Record<string, unknown>;
};

export type AdapterToolCallResult = {
  ok: boolean;
  tool_name: string;
  response: Record<string, unknown>;
  raw?: Record<string, unknown>;
};

export class ControlPlaneClient {
  private readonly baseUrl: string;
  private readonly runnerToken: string;
  private readonly sourceId?: string;

  constructor(config: ControlPlaneClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.runnerToken = config.runnerToken;
    this.sourceId = config.sourceId;
  }

  async claim(options: ClaimOptions = {}): Promise<WritebackJob[]> {
    const body = {
      source_id: options.sourceId || this.sourceId,
      limit: options.limit ?? 1,
      lease_seconds: options.leaseSeconds
    };
    const response = await this.post("/v1/writeback/jobs/claim", body);
    const jobs = Array.isArray(response.jobs) ? response.jobs : [];
    return jobs.map((job) => parseWritebackJob(job));
  }

  async register(payload: RunnerRegistrationV1): Promise<Record<string, unknown>> {
    const registration = parseRunnerRegistration(payload);
    return this.post("/v1/runner/register", registration);
  }

  async runnerHeartbeat(payload: {
    runner_id: string;
    runner_version?: string;
    engines?: string[];
    source_ids?: string[];
    current_job_id?: string;
    status?: "online" | "degraded" | "offline" | string;
    details?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    return this.post("/v1/runner/heartbeat", payload);
  }

  async heartbeat(jobId: string, leaseSeconds = 60): Promise<void> {
    await this.post(`/v1/writeback/jobs/${encodeURIComponent(jobId)}/heartbeat`, { lease_seconds: leaseSeconds });
  }

  async renewLease(jobId: string, leaseSeconds = 60): Promise<Record<string, unknown>> {
    return this.post(`/v1/writeback/jobs/${encodeURIComponent(jobId)}/heartbeat`, { lease_seconds: leaseSeconds });
  }

  async result(result: WritebackResult): Promise<void> {
    const parsed = parseWritebackResult(result);
    await this.post(`/v1/writeback/jobs/${encodeURIComponent(parsed.job_id)}/result`, parsed);
  }

  async submitReceipt(result: WritebackResult): Promise<void> {
    await this.result(result);
  }

  async adapterTools(adapterId: string, options: { session?: Record<string, unknown> } = {}): Promise<AdapterToolCatalog> {
    const response = await this.post("/v1/agent/adapters/tools", {
      adapter: adapterId,
      session: options.session ?? {},
    });
    const result = normalizeRecord(response.result);
    const tools = Array.isArray(response.tools)
      ? response.tools
      : result && Array.isArray(result.tools)
        ? result.tools
        : [];
    return {
      adapter_id: String(response.adapter_id || response.adapter || adapterId),
      tools: tools.map((tool: unknown) => normalizeTool(tool)).filter((tool: AdapterToolCatalogEntry | undefined): tool is AdapterToolCatalogEntry => tool !== undefined),
      raw: response,
    };
  }

  async callAdapterTool(
    adapterId: string,
    toolName: string,
    input: Record<string, unknown>,
    options: { session?: Record<string, unknown>; runId?: string; stepKey?: string } = {},
  ): Promise<AdapterToolCallResult> {
    const response = await this.post("/v1/agent/adapters/call-tool", {
      adapter: adapterId,
      tool: toolName,
      input,
      session: options.session ?? {},
      run_id: options.runId,
      step_key: options.stepKey,
    });
    return {
      ok: Boolean(response.ok),
      tool_name: toolName,
      response: normalizeRecord(response.result) ?? normalizeRecord(response.response) ?? response,
      raw: response,
    };
  }


  async doctor(): Promise<{ ok: boolean; status: number; authenticated: boolean; details?: Record<string, unknown> }> {
    const response = await fetch(`${this.baseUrl}/v1/writeback/runner/doctor`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${this.runnerToken}`
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload?.ok) {
      return { ok: true, status: response.status, authenticated: true, details: payload as Record<string, unknown> };
    }
    if (response.status !== 404) {
      return { ok: false, status: response.status, authenticated: false, details: payload as Record<string, unknown> };
    }
    const health = await fetch(`${this.baseUrl}/health`, { method: "GET" });
    return { ok: health.ok, status: health.status, authenticated: false, details: { fallback: "health_endpoint_only" } };
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const response = await this.fetchWithRetry(path, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.runnerToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload?.ok) {
      const code = typeof payload?.error === "string" ? payload.error : `http_${response.status}`;
      throw new Error(`control plane request failed: ${code}`);
    }
    return payload as Record<string, unknown>;
  }

  private async fetchWithRetry(path: string, init: RequestInit): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await fetch(`${this.baseUrl}${path}`, init);
        if (![408, 429, 500, 502, 503, 504].includes(response.status)) return response;
        if (attempt === 2) return response;
        lastError = new Error(`retryable_http_${response.status}`);
      } catch (error) {
        lastError = error;
        if (attempt === 2) throw error;
      }
      await sleep(100 * 2 ** attempt + Math.floor(Math.random() * 25));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

function normalizeTool(value: unknown): AdapterToolCatalogEntry | undefined {
  const record = normalizeRecord(value);
  if (!record || typeof record.name !== "string" || record.name.length === 0) return undefined;
  return {
    name: record.name,
    title: typeof record.title === "string" ? record.title : undefined,
    description: typeof record.description === "string" ? record.description : undefined,
    input_schema: normalizeRecord(record.input_schema ?? record.inputSchema),
    output_schema: normalizeRecord(record.output_schema ?? record.outputSchema),
    annotations: normalizeRecord(record.annotations),
    metadata: normalizeRecord(record.metadata ?? record._meta),
  };
}

function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
