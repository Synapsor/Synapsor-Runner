import {
  parseRunnerRegistration,
  parseRunnerProposal,
  parseRunnerActivity,
  parseWritebackJob,
  parseWritebackResult,
  canonicalJsonDigest,
  type RunnerRegistrationV1,
  type RunnerProposalV1,
  type RunnerActivityV1,
  type WritebackJob,
  type WritebackResult,
} from "@synapsor-runner/protocol";

export type CloudCredentialKind = "human" | "service" | "runner";

export type CloudControlClientConfig = {
  baseUrl: string;
  credential: string;
  credentialKind?: CloudCredentialKind;
  userAgent?: string;
  maxRetries?: number;
  timeoutMs?: number;
};

export type CloudRequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  idempotencyKey?: string;
  headers?: Record<string, string>;
  retry?: boolean;
};

export type CloudErrorShape = {
  error_code: string;
  message: string;
  retryable: boolean;
  retry_after_ms?: number;
  request_id?: string;
  status: number;
  details?: Record<string, unknown>;
};

export class CloudControlError extends Error implements CloudErrorShape {
  readonly error_code: string;
  readonly retryable: boolean;
  readonly retry_after_ms?: number;
  readonly request_id?: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(shape: CloudErrorShape) {
    super(shape.message);
    this.name = "CloudControlError";
    this.error_code = shape.error_code;
    this.retryable = shape.retryable;
    this.retry_after_ms = shape.retry_after_ms;
    this.request_id = shape.request_id;
    this.status = shape.status;
    this.details = shape.details;
  }

  toJSON(): CloudErrorShape {
    return {
      error_code: this.error_code,
      message: this.message,
      retryable: this.retryable,
      ...(this.retry_after_ms === undefined ? {} : { retry_after_ms: this.retry_after_ms }),
      ...(this.request_id ? { request_id: this.request_id } : {}),
      status: this.status,
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export type CloudContractPushInput = {
  projectId: string;
  contract: Record<string, unknown>;
  name?: string;
  description?: string;
  source: "runner" | "cli";
  sourceVersions?: Record<string, string>;
  activate?: boolean;
  idempotencyKey?: string;
};

export type CloudContractPushResult = Record<string, unknown> & {
  local_digest: `sha256:${string}`;
};

export class CloudControlClient {
  private readonly baseUrl: string;
  private readonly credential: string;
  private readonly credentialKind: CloudCredentialKind;
  private readonly userAgent: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(config: CloudControlClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.credential = requireValue(config.credential, "Cloud credential");
    this.credentialKind = config.credentialKind ?? "service";
    this.userAgent = config.userAgent ?? "synapsor-cloud-client";
    this.maxRetries = Math.max(0, Math.min(5, config.maxRetries ?? 2));
    this.timeoutMs = Math.max(1_000, Math.min(120_000, config.timeoutMs ?? 15_000));
  }

  async get(path: string): Promise<Record<string, unknown>> {
    return this.request(path, { method: "GET" });
  }

  async post(path: string, body: unknown, options: Omit<CloudRequestOptions, "method" | "body"> = {}): Promise<Record<string, unknown>> {
    return this.request(path, { ...options, method: "POST", body });
  }

  async request(path: string, options: CloudRequestOptions = {}): Promise<Record<string, unknown>> {
    const method = options.method ?? "GET";
    const retryPermitted = options.retry !== false && (method === "GET" || Boolean(options.idempotencyKey));
    let attempt = 0;
    while (true) {
      try {
        return await this.requestOnce(path, options);
      } catch (error) {
        const retryable = error instanceof CloudControlError && error.retryable;
        if (!retryPermitted || !retryable || attempt >= this.maxRetries) throw error;
        const delay = error.retry_after_ms ?? Math.min(5_000, 200 * (2 ** attempt));
        attempt += 1;
        await sleep(delay);
      }
    }
  }

  async pushContract(input: CloudContractPushInput): Promise<CloudContractPushResult> {
    const localDigest = canonicalJsonDigest(input.contract);
    const payload = {
      schema_version: "synapsor.cloud-contract-push.v0.1",
      contract: input.contract,
      name: input.name,
      description: input.description,
      source: input.source,
      source_versions: input.sourceVersions ?? {},
      activate: input.activate === true,
      idempotency_key: input.idempotencyKey,
      local_digest: localDigest,
    };
    const response = await this.post(
      `/v1/control/projects/${encodeURIComponent(input.projectId)}/agent-contracts`,
      payload,
      { idempotencyKey: input.idempotencyKey ?? localDigest },
    );
    const remoteDigest = firstString(response.digest, normalizeRecord(response.version)?.digest);
    if (!remoteDigest) {
      throw new CloudControlError({
        error_code: "contract_digest_missing",
        message: "Cloud did not return the canonical contract digest.",
        retryable: false,
        status: 502,
      });
    }
    if (remoteDigest !== localDigest) {
      throw new CloudControlError({
        error_code: "contract_digest_mismatch",
        message: `Cloud contract digest ${remoteDigest} does not match local digest ${localDigest}.`,
        retryable: false,
        status: 409,
        details: { local_digest: localDigest, remote_digest: remoteDigest },
      });
    }
    return { ...response, local_digest: localDigest };
  }

  private async requestOnce(path: string, options: CloudRequestOptions): Promise<Record<string, unknown>> {
    const endpoint = new URL(path, `${this.baseUrl}/`);
    if (endpoint.origin !== new URL(this.baseUrl).origin) {
      throw new CloudControlError({ error_code: "invalid_api_path", message: "Cloud API path must remain on the configured origin.", retryable: false, status: 0 });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(endpoint.toString(), {
        method: options.method ?? "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.credential}`,
          "user-agent": this.userAgent,
          "x-synapsor-credential-kind": this.credentialKind,
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
      throw new CloudControlError({
        error_code: timeout ? "request_timeout" : "network_unavailable",
        message: timeout ? "Cloud request timed out." : "Cloud request could not reach the configured API.",
        retryable: true,
        retry_after_ms: 500,
        status: 0,
      });
    } finally {
      clearTimeout(timer);
    }
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || payload.ok === false) throw cloudControlError(response, payload);
    return payload;
  }
}

export type ControlPlaneClientConfig = {
  baseUrl: string;
  runnerToken: string;
  sourceId?: string;
  runnerId?: string;
};

export type ClaimOptions = {
  sourceId?: string;
  limit?: number;
  leaseSeconds?: number;
  runnerId?: string;
};

export type CloudLease = {
  leaseId: string;
  expiresAt: string | number;
  attempt: number;
};

export type ClaimedWritebackJob = WritebackJob & { cloud_lease: CloudLease };

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
  private readonly runnerId?: string;
  private readonly transport: CloudControlClient;

  constructor(config: ControlPlaneClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.runnerToken = config.runnerToken;
    this.sourceId = config.sourceId;
    this.runnerId = config.runnerId;
    this.transport = new CloudControlClient({
      baseUrl: config.baseUrl,
      credential: config.runnerToken,
      credentialKind: "runner",
      userAgent: "synapsor-runner-control-plane-client",
    });
  }

  async claim(options: ClaimOptions = {}): Promise<ClaimedWritebackJob[]> {
    const body = {
      source_id: options.sourceId || this.sourceId,
      runner_id: options.runnerId || this.runnerId,
      limit: options.limit ?? 1,
      lease_seconds: options.leaseSeconds
    };
    const response = await this.post("/v1/writeback/jobs/claim", body);
    const jobs = Array.isArray(response.jobs) ? response.jobs : [];
    return jobs.map((job) => {
      const parsed = parseWritebackJob(job);
      return Object.assign(parsed, { cloud_lease: cloudLease(job) });
    });
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

  async submitProposal(payload: RunnerProposalV1): Promise<Record<string, unknown>> {
    return this.post("/v1/runner/proposals", parseRunnerProposal(payload));
  }

  async submitActivity(payload: RunnerActivityV1): Promise<Record<string, unknown>> {
    return this.post("/v1/runner/activity", parseRunnerActivity(payload));
  }

  async proposalStatus(proposalId: string): Promise<Record<string, unknown>> {
    return this.transport.get(`/v1/runner/proposals/${encodeURIComponent(requireValue(proposalId, "proposal_id"))}`);
  }

  async heartbeat(jobId: string, leaseId: string, runnerId = this.runnerId, leaseSeconds = 60): Promise<void> {
    await this.renewLease(jobId, leaseId, runnerId, leaseSeconds);
  }

  async renewLease(jobId: string, leaseId: string, runnerId = this.runnerId, leaseSeconds = 60): Promise<Record<string, unknown>> {
    return this.post(`/v1/writeback/jobs/${encodeURIComponent(jobId)}/heartbeat`, {
      runner_id: requireValue(runnerId, "runner_id"),
      lease_id: requireValue(leaseId, "lease_id"),
      lease_seconds: leaseSeconds,
    });
  }

  async result(result: WritebackResult, leaseId: string): Promise<Record<string, unknown>> {
    const parsed = parseWritebackResult(result);
    const cloudSafeResult = { ...parsed } as Record<string, unknown>;
    // The reviewed inverse remains in the local receipt/replay ledger. Cloud
    // receives only the terminal status, bounded identities, and digests.
    delete cloudSafeResult.inverse;
    return this.post(`/v1/writeback/jobs/${encodeURIComponent(parsed.job_id)}/result`, {
      ...cloudSafeResult,
      lease_id: requireValue(leaseId, "lease_id"),
    });
  }

  async submitReceipt(result: WritebackResult, leaseId: string): Promise<Record<string, unknown>> {
    return this.result(result, leaseId);
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
    const normalizedBody = JSON.parse(JSON.stringify(body)) as unknown;
    return this.transport.post(path, normalizedBody, { idempotencyKey: canonicalJsonDigest({ path, body: normalizedBody }) });
  }
}

function cloudLease(input: unknown): CloudLease {
  const record = normalizeRecord(input);
  const publicLease = normalizeRecord(record?.lease);
  const leaseId = typeof publicLease?.lease_id === "string"
    ? publicLease.lease_id
    : typeof record?.lease_id === "string"
      ? record.lease_id
      : "";
  const expiresAt = publicLease?.expires_at ?? record?.lease_expires_at;
  const attempt = Number(publicLease?.attempt ?? record?.attempt_count ?? 0);
  if (!leaseId || (typeof expiresAt !== "string" && typeof expiresAt !== "number") || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("control plane returned a writeback job without a valid lease");
  }
  return { leaseId, expiresAt, attempt };
}

function requireValue(value: string | undefined, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${field} is required for Cloud lease ownership`);
  return normalized;
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

function normalizeBaseUrl(value: string): string {
  const normalized = String(value || "").trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new CloudControlError({ error_code: "invalid_api_url", message: "Cloud API URL is invalid.", retryable: false, status: 0 });
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new CloudControlError({ error_code: "invalid_api_url", message: "Cloud API URL must be an HTTP(S) origin without credentials, query, or fragment.", retryable: false, status: 0 });
  }
  return normalized;
}

function firstString(...values: unknown[]): string {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? "";
}

function cloudControlError(response: Response, payload: Record<string, unknown>): CloudControlError {
  const errorCode = firstString(payload.error_code, payload.error, `http_${response.status}`);
  const requestId = firstString(payload.request_id, response.headers.get("x-request-id"));
  const retryAfterHeader = response.headers.get("retry-after");
  const payloadDelay = Number(payload.retry_after_ms);
  const headerSeconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  const retryAfterMs = Number.isFinite(payloadDelay) && payloadDelay >= 0
    ? payloadDelay
    : Number.isFinite(headerSeconds) && headerSeconds >= 0
      ? Math.round(headerSeconds * 1_000)
      : undefined;
  const retryable = payload.retryable === true || [408, 425, 429, 502, 503, 504].includes(response.status);
  const message = firstString(payload.message, payload.error_description, humanCloudErrorMessage(errorCode, response.status));
  const details = normalizeRecord(payload.details) ?? (Array.isArray(payload.errors) ? { errors: payload.errors } : undefined);
  return new CloudControlError({
    error_code: errorCode,
    message,
    retryable,
    ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs }),
    ...(requestId ? { request_id: requestId } : {}),
    status: response.status,
    ...(details ? { details } : {}),
  });
}

function humanCloudErrorMessage(code: string, status: number): string {
  if (code === "payment_required") return "This project does not currently have the required Cloud entitlement.";
  if (code === "feature_not_entitled") return "This Cloud feature is not enabled for the selected project.";
  if (status === 401) return "Cloud authentication failed or the credential expired.";
  if (status === 403) return "The authenticated principal is not authorized for this operation.";
  if (status === 404) return "The requested Cloud resource was not found in the selected scope.";
  if (status === 409) return "Cloud rejected the request because the current state conflicts with it.";
  if (status === 429) return "Cloud rate-limited the request; retry after the supplied delay.";
  if (status >= 500) return "Cloud is temporarily unable to complete the request.";
  return `Cloud request failed (${code}).`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
