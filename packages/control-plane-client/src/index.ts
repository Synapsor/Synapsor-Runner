import { parseWritebackJob, parseWritebackResult, type WritebackJob, type WritebackResult } from "@synapsor-runner/protocol";

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

  async heartbeat(jobId: string, leaseSeconds = 60): Promise<void> {
    await this.post(`/v1/writeback/jobs/${encodeURIComponent(jobId)}/heartbeat`, { lease_seconds: leaseSeconds });
  }

  async result(result: WritebackResult): Promise<void> {
    const parsed = parseWritebackResult(result);
    await this.post(`/v1/writeback/jobs/${encodeURIComponent(parsed.job_id)}/result`, parsed);
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
    const response = await fetch(`${this.baseUrl}${path}`, {
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
}
