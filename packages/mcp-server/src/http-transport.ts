import crypto from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createServer as createHttpsServer,
} from "node:https";
import type {
  AddressInfo,
} from "node:net";
import path from "node:path";
import {
  StreamableHTTPServerTransport,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  assertValidRunnerCapabilityConfig,
} from "@synapsor-runner/config";
import type {
  ProposalRuntimeStore,
} from "@synapsor-runner/proposal-store";
import type {
  JwtVerifier,
} from "./jwt-auth.js";
import type {
  ToolNameStyle,
  ResultFormat,
  RuntimeConfig,
  McpRuntimeSharedResources,
  McpRuntime,
  LocalToolMetadata,
  HttpMcpServerOptions,
  ReadinessReport,
  HttpMcpServerHandle,
  StreamableHttpSession,
  ResolvedHttpSecurity,
  MetricsEndpointAccess,
} from "./runtime-types.js";
import {
  CloudLinkedSynchronizer,
  fetchCloudToolMetadata,
} from "./cloud-linked.js";
import {
  preflightGeneratedAuthority,
} from "./generated-authority.js";
import {
  applyHttpServerLimits,
  authenticateStreamableRequest,
  containsInitializeRequest,
  headerValue,
  jsonRpcError,
  maybeServeOauthMetadata,
  readRequestBody,
  requestIdFromPayload,
  resolveHttpSecurity,
  sanitizeHttpError,
  sanitizeHttpPayload,
  sessionAuthVerifier,
  setCommonHttpHeaders,
  validBearerTokens,
  validateHttpRequestSecurity,
  validateTlsMaterial,
  writeAuthenticationFailure,
  writeJson,
} from "./http-security.js";
import {
  resourceResult,
} from "./local-resources.js";
import {
  assertRuntimeStoreStartupReady,
  createDefaultRuntimeStore,
  createMcpRuntime,
} from "./runtime-composition.js";
import {
  describeIsolationAssurance,
  loadRuntimeConfigFromFile,
  resolveRuntimeConfig,
} from "./runtime-config.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  checkRunnerReadiness,
  handleMetricsRequest,
  renderRuntimeMetrics,
  resolveMetricsEndpointAccess,
} from "./runtime-observability.js";
import {
  isRecord,
} from "./safe-values.js";
import {
  createSynapsorMcpServer,
} from "./server-composition.js";
import {
  createMcpRuntimeSharedResources,
  preflightPostgresDatabaseScope,
} from "./source-runtime.js";
import {
  toolCallResult,
} from "./tool-catalog.js";
import {
  configUsesHttpClaims,
} from "./trusted-context.js";

export async function startHttpMcpServer(options: HttpMcpServerOptions = {}): Promise<HttpMcpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8765;
  const env = options.env ?? process.env;
  const devNoAuth = options.devNoAuth === true;
  const config = resolveRuntimeConfig(options.config ?? loadRuntimeConfigFromFile(options.configPath));
  assertValidRunnerCapabilityConfig(config);
  if (configUsesHttpClaims(config)) {
    throw new McpRuntimeError("HTTP_CLAIMS_REQUIRES_STREAMABLE", "http_claims trusted context requires spec MCP Streamable HTTP sessions; the legacy JSON-RPC bridge cannot bind per-session context.");
  }
  const security = resolveHttpSecurity(config, options, host, env, false);
  const metricsAccess = resolveMetricsEndpointAccess(config, env, host);
  if (options.tls?.requestClientCert && !options.tls.ca) {
    throw new McpRuntimeError("MTLS_CA_REQUIRED", "HTTP mTLS requires a CA bundle when client certificates are required.");
  }
  validateTlsMaterial(options.tls);

  const cloudTools = config.mode === "cloud" ? await fetchCloudToolMetadata(config, env) : undefined;
  if (options.readRow && Object.values(config.sources ?? {}).some((source) => source.database_scope?.mode === "postgres_rls")) {
    throw new McpRuntimeError("POSTGRES_RLS_CUSTOM_READER_UNVERIFIED", "Hardened postgres_rls mode requires Runner's verified PostgreSQL reader; a custom readRow cannot be attested by the stock server.");
  }
  await preflightGeneratedAuthority(config, env);
  await preflightPostgresDatabaseScope(config, env, options.credentialResolver);
  const runtime = createMcpRuntime(config, {
    env,
    storePath: options.storePath,
    resultFormat: options.resultFormat,
    readRow: options.readRow,
    credentialResolver: options.credentialResolver,
    cloudTools,
  });
  const readinessCheck = options.readinessCheck ?? (() => checkRunnerReadiness(config, env));
  const requestHandler = (request: IncomingMessage, response: ServerResponse) => {
    void handleHttpMcpRequest({
      request,
      response,
      runtime,
      devNoAuth,
      security,
      readinessCheck,
      metricsAccess,
      metricsProvider: () => renderRuntimeMetrics(runtime.store, runtime.poolMetrics(), runtime.rateLimitMetrics(), readinessCheck),
    });
  };
  const server = options.tls
    ? createHttpsServer({
      cert: options.tls.cert,
      key: options.tls.key,
      ca: options.tls.ca,
      requestCert: options.tls.requestClientCert === true,
      rejectUnauthorized: options.tls.requestClientCert === true,
      maxHeaderSize: security.limits.maxHeaderBytes,
    }, requestHandler)
    : createServer({ maxHeaderSize: security.limits.maxHeaderBytes }, requestHandler);
  applyHttpServerLimits(server, security.limits);

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }

  const address = server.address() as AddressInfo;
  const actualHost = address.address === "::" ? host : address.address;
  const actualPort = address.port;
  const scheme = options.tls ? "https" : "http";
  const url = `${scheme}://${actualHost}:${actualPort}/mcp`;

  if (options.log !== false) {
    const log = options.log ?? process.stderr;
    log.write(`Synapsor Runner HTTP MCP listening on ${url}\n`);
    log.write(`Channel: ${security.channel}; deployment: ${security.deployment}\n`);
    if (options.tls) log.write(options.tls.requestClientCert ? "TLS: enabled, client certificates required in addition to Bearer auth\n" : "TLS: enabled\n");
    log.write(devNoAuth ? "Auth: disabled for loopback development only\n" : `Auth: opaque Bearer endpoint token from ${security.activeTokenEnv}${security.previousTokenEnv ? `; previous rotation token from ${security.previousTokenEnv}` : ""}\n`);
    if (security.weakStaticToken) log.write("Auth warning: loopback endpoint token is shorter or more predictable than the production requirement; generate at least 32 random bytes.\n");
    if (security.channel === "insecure_http_break_glass") log.write("SECURITY WARNING: remote Bearer traffic is using explicit insecure cleartext break glass. Credentials and data can be intercepted.\n");
    log.write(`Config: ${options.configPath ?? "synapsor.runner.json"}\n`);
    log.write(`Store: ${options.storePath ?? config.storage?.sqlite_path ?? "./.synapsor/local.db"}\n`);
  }

  return {
    host: actualHost,
    port: actualPort,
    url,
    close: () => closeHttpServer(server, runtime),
  };
}

export async function startStreamableHttpMcpServer(options: HttpMcpServerOptions = {}): Promise<HttpMcpServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8766;
  const env = options.env ?? process.env;
  const devNoAuth = options.devNoAuth === true;
  const config = resolveRuntimeConfig(options.config ?? loadRuntimeConfigFromFile(options.configPath));
  assertValidRunnerCapabilityConfig(config);
  const usesSessionAuth = configUsesHttpClaims(config);
  const security = resolveHttpSecurity(config, options, host, env, usesSessionAuth);
  const metricsAccess = resolveMetricsEndpointAccess(config, env, host);

  if (devNoAuth && usesSessionAuth) {
    throw new McpRuntimeError("HTTP_CLAIMS_AUTH_REQUIRED", "http_claims trusted context cannot run with --dev-no-auth.");
  }
  assertRuntimeStoreStartupReady(config, env);
  const sessionVerifier = usesSessionAuth
    ? sessionAuthVerifier(config, env, options.configPath ? path.dirname(path.resolve(options.configPath)) : process.cwd())
    : undefined;
  const readinessCheck = options.readinessCheck ?? (() => checkRunnerReadiness(config, env));
  if (options.tls?.requestClientCert && !options.tls.ca) {
    throw new McpRuntimeError("MTLS_CA_REQUIRED", "Streamable HTTP mTLS requires a CA bundle when client certificates are required.");
  }
  validateTlsMaterial(options.tls);

  const cloudTools = config.mode === "cloud" ? await fetchCloudToolMetadata(config, env) : undefined;
  if (options.readRow && Object.values(config.sources ?? {}).some((source) => source.database_scope?.mode === "postgres_rls")) {
    throw new McpRuntimeError("POSTGRES_RLS_CUSTOM_READER_UNVERIFIED", "Hardened postgres_rls mode requires Runner's verified PostgreSQL reader; a custom readRow cannot be attested by the stock server.");
  }
  await preflightGeneratedAuthority(config, env);
  await preflightPostgresDatabaseScope(config, env, options.credentialResolver);
  const sharedStorePath = options.storePath ?? config.storage?.sqlite_path ?? "./.synapsor/local.db";
  const sharedStore = createDefaultRuntimeStore(config, env, sharedStorePath);
  const cloudSynchronizer = config.governance?.mode === "cloud_linked"
    ? new CloudLinkedSynchronizer(config, sharedStore, env)
    : undefined;
  cloudSynchronizer?.start();
  const sharedResources = createMcpRuntimeSharedResources(config, env, options.readRow, Date.now, options.credentialResolver);
  const sessions = new Map<string, StreamableHttpSession>();
  const openSessions = new Set<StreamableHttpSession>();
  const initializingSessions = { count: 0 };
  const requestHandler = (request: IncomingMessage, response: ServerResponse) => {
    void handleStreamableHttpMcpRequest({
      request,
      response,
      config,
      storePath: sharedStorePath,
      sharedStore,
      sharedResources,
      cloudTools,
      env,
      toolNameStyle: options.toolNameStyle,
      resultFormat: options.resultFormat,
      sessionVerifier,
      devNoAuth,
      security,
      sessions,
      openSessions,
      initializingSessions,
      readinessCheck,
      metricsAccess,
      metricsProvider: () => renderRuntimeMetrics(sharedStore, sharedResources.poolMetrics(), sharedResources.rateLimitMetrics(), readinessCheck),
    });
  };
  const server = options.tls
    ? createHttpsServer({
      cert: options.tls.cert,
      key: options.tls.key,
      ca: options.tls.ca,
      requestCert: options.tls.requestClientCert === true,
      rejectUnauthorized: options.tls.requestClientCert === true,
      maxHeaderSize: security.limits.maxHeaderBytes,
    }, requestHandler)
    : createServer({ maxHeaderSize: security.limits.maxHeaderBytes }, requestHandler);
  applyHttpServerLimits(server, security.limits);
  const sessionReaper = setInterval(() => {
    void pruneExpiredStreamableSessions(sessions, openSessions, security.limits.sessionIdleTimeoutMs, Date.now());
  }, Math.min(30_000, Math.max(1_000, Math.floor(security.limits.sessionIdleTimeoutMs / 2))));
  sessionReaper.unref?.();

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(sessionReaper);
    await cloudSynchronizer?.stop();
    await closeStreamableSessions(openSessions);
    await sharedResources.close();
    await sharedStore.close();
    throw error;
  }

  const address = server.address() as AddressInfo;
  const actualHost = address.address === "::" ? host : address.address;
  const actualPort = address.port;
  const scheme = options.tls ? "https" : "http";
  const url = `${scheme}://${actualHost}:${actualPort}/mcp`;

  if (options.log !== false) {
    const log = options.log ?? process.stderr;
    log.write(`Synapsor Runner Streamable HTTP MCP listening on ${url}\n`);
    log.write(`Channel: ${security.channel}; deployment: ${security.deployment}\n`);
    if (options.tls) log.write(options.tls.requestClientCert ? "TLS: enabled, client certificates required in addition to Bearer auth\n" : "TLS: enabled\n");
    log.write(devNoAuth
      ? "Auth: disabled for localhost development only\n"
      : usesSessionAuth
        ? `Auth: signed per-session JWT (${config.session_auth?.provider}); issuer and resource checked on every request\n`
        : `Auth: opaque Bearer endpoint token from ${security.activeTokenEnv}${security.previousTokenEnv ? `; previous rotation token from ${security.previousTokenEnv}` : ""}\n`);
    if (security.oauth) log.write(`OAuth resource metadata: ${security.oauth.metadataUrl}\n`);
    if (security.weakStaticToken) log.write("Auth warning: loopback endpoint token is shorter or more predictable than the production requirement; generate at least 32 random bytes.\n");
    if (security.channel === "insecure_http_break_glass") log.write("SECURITY WARNING: remote Bearer traffic is using explicit insecure cleartext break glass. Credentials and data can be intercepted.\n");
    for (const assurance of describeIsolationAssurance(config)) {
      log.write(`Isolation ${assurance.source}: ${assurance.mode}; trusted context: ${assurance.trusted_context.request_binding}\n`);
      if (assurance.warning) log.write(`Isolation warning ${assurance.source}: ${assurance.warning}\n`);
    }
    log.write(`Config: ${options.configPath ?? "synapsor.runner.json"}\n`);
    log.write(`Store: ${options.storePath ?? config.storage?.sqlite_path ?? "./.synapsor/local.db"}\n`);
  }

  return {
    host: actualHost,
    port: actualPort,
    url,
    close: () => {
      clearInterval(sessionReaper);
      return closeStreamableHttpServer(server, openSessions, sharedResources, sharedStore, cloudSynchronizer);
    },
  };
}

export async function handleStreamableHttpMcpRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  config: RuntimeConfig;
  storePath?: string;
  sharedStore: ProposalRuntimeStore;
  sharedResources: McpRuntimeSharedResources;
  cloudTools?: LocalToolMetadata[];
  env: NodeJS.ProcessEnv;
  toolNameStyle?: ToolNameStyle;
  resultFormat?: ResultFormat;
  sessionVerifier?: JwtVerifier;
  devNoAuth: boolean;
  security: ResolvedHttpSecurity;
  sessions: Map<string, StreamableHttpSession>;
  openSessions: Set<StreamableHttpSession>;
  initializingSessions: { count: number };
  readinessCheck: () => Promise<ReadinessReport>;
  metricsAccess: MetricsEndpointAccess;
  metricsProvider: () => Promise<string>;
}): Promise<void> {
  const { request, response, config, storePath, sharedStore, sharedResources, cloudTools, env, toolNameStyle, resultFormat, sessionVerifier, devNoAuth, security, sessions, openSessions, initializingSessions, readinessCheck, metricsAccess, metricsProvider } = input;
  try {
    if (!validateHttpRequestSecurity(request, response, security)) return;
    if (request.method === "OPTIONS" && request.headers.origin) {
      response.statusCode = 204;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    if (maybeServeOauthMetadata(request, response, security, url.pathname)) return;
    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, {
        ok: true,
        status: "live",
        transport: "streamable-http",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      const readiness = await readinessCheck();
      writeJson(response, readiness.ok ? 200 : 503, readiness);
      return;
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      await handleMetricsRequest(request, response, metricsAccess, metricsProvider);
      return;
    }

    if (url.pathname !== "/mcp") {
      writeJson(response, 404, { ok: false, error: "not_found" });
      return;
    }
    const authResult = await authenticateStreamableRequest(config, request.headers.authorization, sessionVerifier, security, devNoAuth);
    if (!authResult.ok) {
      writeAuthenticationFailure(response, security, authResult.status, authResult.error);
      return;
    }
    const authentication = authResult.authentication;

    await pruneExpiredStreamableSessions(sessions, openSessions, security.limits.sessionIdleTimeoutMs, Date.now());

    const sessionId = headerValue(request.headers["mcp-session-id"]);
    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) {
        writeJson(response, 404, jsonRpcError(null, -32000, "MCP session not found."));
        return;
      }
      if (existing.authFingerprint !== authentication.fingerprint) {
        writeAuthenticationFailure(response, security, 401, "unauthorized");
        return;
      }
      existing.lastSeenAt = Date.now();
      await existing.transport.handleRequest(request, response);
      return;
    }

    if (request.method !== "POST") {
      writeJson(response, 400, jsonRpcError(null, -32000, "MCP initialize request is required before using this Streamable HTTP session."));
      return;
    }

    if (openSessions.size + initializingSessions.count >= security.limits.maxSessions) {
      response.setHeader("retry-after", "1");
      writeJson(response, 503, { ok: false, error: "session_capacity_exhausted", retryable: true, retry_after_ms: 1000 });
      return;
    }
    initializingSessions.count += 1;
    let initializingSession: StreamableHttpSession | undefined;
    try {
      const parsedBody = JSON.parse(await readRequestBody(request, security.limits.maxRequestBytes)) as unknown;
      if (!containsInitializeRequest(parsedBody)) {
        writeJson(response, 400, jsonRpcError(requestIdFromPayload(parsedBody), -32000, "First Streamable HTTP MCP request must be initialize."));
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (newSessionId) => {
          if (initializingSession) {
            initializingSession.sessionId = newSessionId;
            sessions.set(newSessionId, initializingSession);
          }
        },
        onsessionclosed: (closedSessionId) => {
          const closed = sessions.get(closedSessionId);
          if (closed) {
            disposeStreamableSession(closed, sessions, openSessions);
          }
        },
      });
      const runtime = createMcpRuntime(config, {
        env,
        storePath,
        store: sharedStore,
        sharedResources,
        resultFormat,
        cloudTools,
        trustedContext: authentication.context,
      });
      initializingSession = { transport, runtime, authFingerprint: authentication.fingerprint, lastSeenAt: Date.now() };
      openSessions.add(initializingSession);
      transport.onclose = () => {
        if (initializingSession) disposeStreamableSession(initializingSession, sessions, openSessions);
      };
      await createSynapsorMcpServer(runtime, {
        toolNameStyle,
        resultFormat,
      }).connect(transport);
      await transport.handleRequest(request, response, parsedBody);
    } catch (error) {
      if (initializingSession) {
        disposeStreamableSession(initializingSession, sessions, openSessions);
        await initializingSession.transport.close().catch(() => undefined);
      }
      throw error;
    } finally {
      initializingSessions.count -= 1;
    }
  } catch (error) {
    const message = sanitizeHttpError(error, security.activeToken, security.previousToken);
    if (!response.headersSent && error instanceof McpRuntimeError && error.code === "HTTP_BODY_TOO_LARGE") {
      writeJson(response, 413, { ok: false, error: "request_too_large" });
    } else if (!response.headersSent) writeJson(response, 200, jsonRpcError(null, -32000, message));
    else response.end();
  }
}

export async function handleHttpMcpRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  runtime: McpRuntime;
  devNoAuth: boolean;
  security: ResolvedHttpSecurity;
  readinessCheck: () => Promise<ReadinessReport>;
  metricsAccess: MetricsEndpointAccess;
  metricsProvider: () => Promise<string>;
}): Promise<void> {
  const { request, response, runtime, devNoAuth, security, readinessCheck, metricsAccess, metricsProvider } = input;
  try {
    setCommonHttpHeaders(response);
    if (!validateHttpRequestSecurity(request, response, security)) return;
    if (request.method === "OPTIONS" && request.headers.origin) {
      response.statusCode = 204;
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", "http://localhost");
    if (request.method === "GET" && url.pathname === "/healthz") {
      writeJson(response, 200, {
        ok: true,
        status: "live",
        transport: "http",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      const readiness = await readinessCheck();
      writeJson(response, readiness.ok ? 200 : 503, readiness);
      return;
    }
    if (request.method === "GET" && url.pathname === "/metrics") {
      await handleMetricsRequest(request, response, metricsAccess, metricsProvider);
      return;
    }

    if (url.pathname !== "/mcp") {
      writeJson(response, 404, { ok: false, error: "not_found" });
      return;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { ok: false, error: "method_not_allowed" });
      return;
    }
    if (!devNoAuth && !validBearerTokens(request.headers.authorization, [security.activeToken, security.previousToken])) {
      writeAuthenticationFailure(response, security, 401, "unauthorized");
      return;
    }

    const body = await readRequestBody(request, security.limits.maxRequestBytes);
    const payload = JSON.parse(body) as unknown;
    if (!isRecord(payload)) {
      writeJson(response, 400, jsonRpcError(null, -32600, "JSON-RPC request must be an object."));
      return;
    }
    const id = payload.id ?? null;
    const method = typeof payload.method === "string" ? payload.method : undefined;
    if (!method) {
      writeJson(response, 400, jsonRpcError(id, -32600, "JSON-RPC method is required."));
      return;
    }

    const result = await handleHttpJsonRpcMethod(runtime, method, isRecord(payload.params) ? payload.params : {});
    writeJson(response, 200, {
      jsonrpc: "2.0",
      id,
      result: sanitizeHttpPayload(result, security.activeToken, security.previousToken),
    });
  } catch (error) {
    const message = sanitizeHttpError(error, security.activeToken, security.previousToken);
    if (!response.headersSent && error instanceof McpRuntimeError && error.code === "HTTP_BODY_TOO_LARGE") {
      writeJson(response, 413, { ok: false, error: "request_too_large" });
    } else if (!response.headersSent) writeJson(response, 200, jsonRpcError(null, -32000, message));
    else response.end();
  }
}

export async function handleHttpJsonRpcMethod(
  runtime: McpRuntime,
  method: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (method === "tools/list") {
    return {
      tools: runtime.listTools().map(httpToolMetadata),
    };
  }
  if (method === "tools/call") {
    const name = typeof params.name === "string" ? params.name : undefined;
    if (!name) throw new McpRuntimeError("HTTP_TOOL_NAME_REQUIRED", "tools/call requires params.name.");
    const args = isRecord(params.arguments) ? params.arguments : isRecord(params.args) ? params.args : {};
    return await toolCallResult(runtime, name, args);
  }
  if (method === "resources/read") {
    const uri = typeof params.uri === "string" ? params.uri : undefined;
    if (!uri) throw new McpRuntimeError("HTTP_RESOURCE_URI_REQUIRED", "resources/read requires params.uri.");
    return await resourceResult(uri, runtime.readResource);
  }
  throw new McpRuntimeError("HTTP_JSONRPC_METHOD_UNSUPPORTED", `Unsupported MCP HTTP method: ${method}`);
}

export function httpToolMetadata(tool: LocalToolMetadata): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.input_schema,
    annotations: {
      ...tool.annotations,
      raw_sql_exposed: false,
      approval_or_commit_tool: false,
    },
    _meta: {
      "synapsor.raw_sql_exposed": false,
      "synapsor.approval_tool": false,
      "synapsor.database_credentials_exposed": false,
      "synapsor.model_controlled_tenant_authority": false,
    },
  };
}

export async function closeHttpServer(server: Server, runtime: McpRuntime): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  }).finally(() => runtime.close());
}

export async function closeStreamableHttpServer(
  server: Server,
  sessions: Set<StreamableHttpSession>,
  sharedResources: McpRuntimeSharedResources,
  sharedStore: ProposalRuntimeStore,
  cloudSynchronizer?: CloudLinkedSynchronizer,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  }).finally(async () => {
    await cloudSynchronizer?.stop();
    await closeStreamableSessions(sessions);
    await sharedResources.close();
    await sharedStore.close();
  });
}

export async function closeStreamableSessions(sessions: Set<StreamableHttpSession>): Promise<void> {
  for (const session of [...sessions]) {
    sessions.delete(session);
    await session.transport.close().catch(() => undefined);
    disposeStreamableSession(session);
  }
}

export async function pruneExpiredStreamableSessions(
  sessions: Map<string, StreamableHttpSession>,
  openSessions: Set<StreamableHttpSession>,
  idleTimeoutMs: number,
  now: number,
): Promise<void> {
  const expired = [...openSessions].filter((session) => now - session.lastSeenAt >= idleTimeoutMs);
  for (const session of expired) {
    disposeStreamableSession(session, sessions, openSessions);
    await session.transport.close().catch(() => undefined);
  }
}

export function disposeStreamableSession(
  session: StreamableHttpSession,
  sessionMap?: Map<string, StreamableHttpSession>,
  openSessions?: Set<StreamableHttpSession>,
): void {
  if (session.closed) return;
  session.closed = true;
  if (session.sessionId) sessionMap?.delete(session.sessionId);
  openSessions?.delete(session);
  void session.runtime.close();
}
