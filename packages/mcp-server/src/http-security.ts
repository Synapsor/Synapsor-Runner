import crypto from "node:crypto";
import type {
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import {
  createSecureContext,
} from "node:tls";
import {
  OAuthProtectedResourceMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  isInitializeRequest,
} from "@modelcontextprotocol/sdk/types.js";
import mysql from "mysql2/promise";
import {
  createJwtVerifier,
  type JwtVerifier,
} from "./jwt-auth.js";
import type {
  RuntimeConfig,
  TrustedContext,
  HttpMcpServerOptions,
  HttpChannel,
  ResolvedHttpLimits,
  ResolvedOauthResource,
  ResolvedHttpSecurity,
  StreamableAuthenticationResult,
} from "./runtime-types.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  envValue,
  isRecord,
} from "./safe-values.js";
import {
  configUsesHttpClaims,
} from "./trusted-context.js";

export function resolveHttpSecurity(
  config: RuntimeConfig,
  options: HttpMcpServerOptions,
  host: string,
  env: NodeJS.ProcessEnv,
  usesSessionAuth: boolean,
): ResolvedHttpSecurity {
  const configured = config.http_security;
  const loopback = isLoopbackHost(host);
  if (options.devNoAuth && !loopback) {
    throw new McpRuntimeError("HTTP_DEV_NO_AUTH_UNSAFE_HOST", "--dev-no-auth is only allowed with localhost or 127.0.0.1.");
  }
  const deployment = configured?.deployment ?? (loopback ? "loopback" : undefined);
  if (!deployment) {
    throw new McpRuntimeError(
      "HTTP_REMOTE_DEPLOYMENT_REQUIRED",
      "A non-loopback listener requires http_security.deployment single_tenant or shared.",
    );
  }
  if (!loopback && deployment === "loopback") {
    throw new McpRuntimeError("HTTP_LOOPBACK_PROFILE_REMOTE", "http_security.deployment loopback cannot bind a non-loopback listener.");
  }
  if (deployment === "shared" && !usesSessionAuth) {
    throw new McpRuntimeError("HTTP_SHARED_SESSION_AUTH_REQUIRED", "Shared HTTP deployment requires signed per-session http_claims identity.");
  }
  if (deployment !== "shared" && usesSessionAuth && !loopback) {
    throw new McpRuntimeError("HTTP_SHARED_DEPLOYMENT_REQUIRED", "Remote http_claims identity requires http_security.deployment shared.");
  }

  const optionChannels = [
    options.trustedTlsProxy ? "trusted_tls_proxy" : undefined,
    options.unsafeAllowCleartextHttp ? "insecure_http_break_glass" : undefined,
  ].filter((value): value is NonNullable<RuntimeConfig["http_security"]>["channel"] => Boolean(value));
  if (optionChannels.length > 1) {
    throw new McpRuntimeError("HTTP_CHANNEL_CONFLICT", "Choose only one of trusted TLS proxy or unsafe cleartext break-glass mode.");
  }
  const requestedChannel = optionChannels[0] ?? configured?.channel;
  if (options.tls && requestedChannel && requestedChannel !== "direct_tls") {
    throw new McpRuntimeError("HTTP_CHANNEL_CONFLICT", "Runner-owned TLS cannot be combined with trusted-proxy or insecure-cleartext channel declarations.");
  }
  let channel: HttpChannel;
  if (options.tls) channel = "direct_tls";
  else if (requestedChannel === "direct_tls") {
    throw new McpRuntimeError("HTTP_TLS_MATERIAL_REQUIRED", "http_security.channel direct_tls requires Runner TLS certificate and key material.");
  } else if (requestedChannel === "trusted_tls_proxy") channel = "trusted_tls_proxy";
  else if (requestedChannel === "insecure_http_break_glass") channel = "insecure_http_break_glass";
  else if (loopback) channel = "loopback_cleartext";
  else {
    throw new McpRuntimeError(
      "HTTP_REMOTE_CLEARTEXT_REFUSED",
      "Refusing non-loopback cleartext HTTP. Configure Runner-owned TLS, an explicit trusted TLS proxy, or --unsafe-allow-cleartext-http break glass.",
    );
  }

  if (options.devNoAuth && channel === "insecure_http_break_glass") {
    throw new McpRuntimeError("HTTP_BREAK_GLASS_AUTH_REQUIRED", "Unsafe cleartext break-glass mode never disables authentication.");
  }
  if (options.devNoAuth && deployment !== "loopback") {
    throw new McpRuntimeError("HTTP_DEV_NO_AUTH_PROFILE_INVALID", "--dev-no-auth is valid only for a loopback development deployment.");
  }

  const activeTokenEnv = options.authTokenEnv ?? configured?.static_token?.active_env ?? "SYNAPSOR_RUNNER_HTTP_TOKEN";
  const previousTokenEnv = options.previousAuthTokenEnv ?? configured?.static_token?.previous_env;
  if (previousTokenEnv && previousTokenEnv === activeTokenEnv) {
    throw new McpRuntimeError("HTTP_TOKEN_ENV_REUSED", "Active and previous HTTP token environment variables must be different.");
  }
  const activeToken = options.devNoAuth || usesSessionAuth ? undefined : envValue(env, activeTokenEnv);
  const previousToken = options.devNoAuth || usesSessionAuth || !previousTokenEnv ? undefined : envValue(env, previousTokenEnv);
  if (!options.devNoAuth && !usesSessionAuth && !activeToken) {
    throw new McpRuntimeError("HTTP_AUTH_TOKEN_MISSING", `${activeTokenEnv} is not set. HTTP MCP requires bearer auth by default.`);
  }
  if (previousTokenEnv && !usesSessionAuth && !options.devNoAuth && !previousToken) {
    throw new McpRuntimeError("HTTP_PREVIOUS_AUTH_TOKEN_MISSING", `${previousTokenEnv} is configured for rotation but is not set.`);
  }
  if (activeToken && previousToken && constantTimeTokenEquals(activeToken, previousToken)) {
    throw new McpRuntimeError("HTTP_TOKEN_ROTATION_DUPLICATE", "Active and previous HTTP endpoint tokens must differ.");
  }
  const weakStaticToken = Boolean(activeToken && !strongOpaqueToken(activeToken)) || Boolean(previousToken && !strongOpaqueToken(previousToken));
  if (!loopback && !usesSessionAuth && weakStaticToken) {
    throw new McpRuntimeError("HTTP_AUTH_TOKEN_WEAK", "Non-loopback static endpoint tokens must contain at least 32 bytes of high-entropy secret material.");
  }

  const configuredOrigins = configured?.allowed_origins ?? [];
  const allowedOrigins = new Set(configuredOrigins);
  if (options.corsOrigin) {
    if (!isExactHttpOrigin(options.corsOrigin)) {
      throw new McpRuntimeError("HTTP_CORS_ORIGIN_INVALID", "--cors-origin must be one exact HTTP(S) origin; wildcards, paths, credentials, query, and fragments are forbidden.");
    }
    allowedOrigins.add(options.corsOrigin);
  }

  const allowedHosts = configured?.allowed_hosts?.map((value) => value.toLowerCase()) ?? defaultAllowedHosts(host);
  if (!loopback && allowedHosts.length === 0) {
    throw new McpRuntimeError("HTTP_ALLOWED_HOSTS_REQUIRED", "Non-loopback HTTP requires http_security.allowed_hosts with exact public/direct Host authorities.");
  }

  const rawLimits = configured?.limits;
  const limits: ResolvedHttpLimits = {
    maxRequestBytes: rawLimits?.max_request_bytes ?? 1_048_576,
    maxHeaderBytes: rawLimits?.max_header_bytes ?? 16_384,
    maxSessions: rawLimits?.max_sessions ?? 1_024,
    sessionIdleTimeoutMs: (rawLimits?.session_idle_timeout_seconds ?? 900) * 1_000,
    requestTimeoutMs: rawLimits?.request_timeout_ms ?? 30_000,
    headersTimeoutMs: rawLimits?.headers_timeout_ms ?? 10_000,
    keepAliveTimeoutMs: rawLimits?.keep_alive_timeout_ms ?? 5_000,
    maxConnections: rawLimits?.max_connections ?? 2_048,
  };

  const oauth = configured?.oauth_resource ? resolveOauthResource(configured.oauth_resource) : undefined;
  if (deployment === "shared") {
    if (!oauth) throw new McpRuntimeError("HTTP_OAUTH_RESOURCE_REQUIRED", "Shared HTTP deployment requires RFC 9728 protected-resource metadata.");
    const auth = config.session_auth;
    if (!auth?.issuer || !auth.audience) {
      throw new McpRuntimeError("HTTP_JWT_ISSUER_AUDIENCE_REQUIRED", "Shared HTTP deployment requires exact session_auth issuer and audience/resource.");
    }
    if (auth.audience !== configured?.oauth_resource?.resource) {
      throw new McpRuntimeError("HTTP_RESOURCE_AUDIENCE_MISMATCH", "session_auth.audience must exactly match http_security.oauth_resource.resource.");
    }
  }

  return {
    deployment,
    channel,
    activeToken,
    previousToken,
    activeTokenEnv,
    previousTokenEnv,
    weakStaticToken,
    allowedOrigins,
    allowedHosts,
    limits,
    oauth,
  };
}

export function resolveOauthResource(input: NonNullable<NonNullable<RuntimeConfig["http_security"]>["oauth_resource"]>): ResolvedOauthResource {
  const resource = new URL(input.resource);
  const pathname = resource.pathname === "/" ? "" : resource.pathname.replace(/\/$/, "");
  const metadataPath = `/.well-known/oauth-protected-resource${pathname}`;
  const metadataUrl = new URL(metadataPath || "/.well-known/oauth-protected-resource", resource.origin).toString();
  const metadata = OAuthProtectedResourceMetadataSchema.parse({
    resource: input.resource,
    authorization_servers: input.authorization_servers,
    ...(input.scopes_supported ? { scopes_supported: input.scopes_supported } : {}),
    bearer_methods_supported: ["header"],
    ...(input.resource_name ? { resource_name: input.resource_name } : {}),
    ...(input.resource_documentation ? { resource_documentation: input.resource_documentation } : {}),
  }) as Record<string, unknown>;
  return { metadata, metadataUrl, metadataPath, requiredScopes: input.required_scopes ?? [] };
}

export function defaultAllowedHosts(host: string): string[] {
  if (!isLoopbackHost(host)) {
    return host === "0.0.0.0" || host === "::" ? [] : [host.toLowerCase()];
  }
  return ["localhost", "127.0.0.1", "[::1]", host.toLowerCase()];
}

export function applyHttpServerLimits(server: Server, limits: ResolvedHttpLimits): void {
  server.requestTimeout = limits.requestTimeoutMs;
  server.headersTimeout = limits.headersTimeoutMs;
  server.keepAliveTimeout = limits.keepAliveTimeoutMs;
  server.maxConnections = limits.maxConnections;
}

export function validateTlsMaterial(tls: HttpMcpServerOptions["tls"]): void {
  if (!tls) return;
  try {
    createSecureContext({ cert: tls.cert, key: tls.key, ca: tls.ca });
  } catch {
    throw new McpRuntimeError("HTTP_TLS_MATERIAL_INVALID", "HTTP TLS certificate, private key, or CA material is invalid.");
  }
}

export function validateHttpRequestSecurity(request: IncomingMessage, response: ServerResponse, security: ResolvedHttpSecurity): boolean {
  if ((request.url?.length ?? 0) > 8_192) {
    writeJson(response, 414, { ok: false, error: "uri_too_long" });
    return false;
  }
  const host = headerValue(request.headers.host);
  if (!host || !hostAllowed(host, security.allowedHosts)) {
    writeJson(response, 403, { ok: false, error: "host_forbidden" });
    return false;
  }
  const origin = headerValue(request.headers.origin);
  if (origin && !security.allowedOrigins.has(origin)) {
    writeJson(response, 403, { ok: false, error: "origin_forbidden" });
    return false;
  }
  setHttpSecurityHeaders(response);
  if (origin) setCorsHeaders(response, origin);
  return true;
}

export function hostAllowed(rawHost: string, allowedHosts: string[]): boolean {
  const actual = parseHostAuthority(rawHost);
  if (!actual) return false;
  return allowedHosts.some((allowed) => {
    const expected = parseHostAuthority(allowed);
    if (!expected || expected.hostname !== actual.hostname) return false;
    return expected.port ? expected.port === actual.port : true;
  });
}

export function parseHostAuthority(value: string): { hostname: string; port: string } | undefined {
  if (!value || value !== value.trim() || /[\s,/?#\\]/.test(value)) return undefined;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) return undefined;
    return { hostname: parsed.hostname.toLowerCase(), port: parsed.port };
  } catch {
    return undefined;
  }
}

export function isExactHttpOrigin(value: string): boolean {
  if (value === "*" || value === "null") return false;
  try {
    const origin = new URL(value);
    return (origin.protocol === "http:" || origin.protocol === "https:")
      && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash
      && origin.origin === value;
  } catch {
    return false;
  }
}

export function setHttpSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("referrer-policy", "no-referrer");
}

export function strongOpaqueToken(token: string): boolean {
  if (Buffer.byteLength(token, "utf8") < 32) return false;
  if (new Set(token).size < 12) return false;
  return !/^(.)\1+$/.test(token) && !/(?:password|secret|token|changeme|example|development)/i.test(token);
}

export function httpAuthChallenge(security: ResolvedHttpSecurity, insufficientScope = false): string {
  const parts = ["Bearer"];
  if (insufficientScope) parts.push('error="insufficient_scope"');
  if (security.oauth) {
    parts.push(`resource_metadata="${security.oauth.metadataUrl}"`);
    if (security.oauth.requiredScopes.length) parts.push(`scope="${security.oauth.requiredScopes.join(" ")}"`);
  }
  return parts.join(" ");
}

export function maybeServeOauthMetadata(request: IncomingMessage, response: ServerResponse, security: ResolvedHttpSecurity, pathname: string): boolean {
  if (!security.oauth || request.method !== "GET") return false;
  if (pathname !== security.oauth.metadataPath && pathname !== "/.well-known/oauth-protected-resource") return false;
  writeJson(response, 200, security.oauth.metadata);
  return true;
}

export function writeAuthenticationFailure(response: ServerResponse, security: ResolvedHttpSecurity, status: 401 | 403, error: string): void {
  response.setHeader("www-authenticate", httpAuthChallenge(security, status === 403));
  writeJson(response, status, { ok: false, error });
}

export function validBearerToken(header: string | undefined, expected: string): boolean {
  return validBearerTokens(header, [expected]);
}

export function validBearerTokens(header: string | undefined, expected: Array<string | undefined>): boolean {
  const actual = bearerToken(header);
  if (!actual) return false;
  let matched = 0;
  for (const candidate of expected.filter((value): value is string => Boolean(value))) {
    matched |= Number(constantTimeTokenEquals(actual, candidate));
  }
  return matched === 1;
}

export function constantTimeTokenEquals(actual: string, expected: string): boolean {
  const actualDigest = crypto.createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(actualDigest, expectedDigest);
}

export function sessionAuthVerifier(config: RuntimeConfig, env: NodeJS.ProcessEnv, baseDir: string): JwtVerifier {
  const auth = config.session_auth;
  if (!auth) throw new McpRuntimeError("SESSION_AUTH_REQUIRED", "http_claims trusted context requires signed session_auth.");
  try {
    return createJwtVerifier(auth, env, { baseDir });
  } catch (error) {
    const message = error instanceof Error ? error.message : "session authentication is not ready";
    throw new McpRuntimeError("SESSION_AUTH_INVALID", message);
  }
}

export async function authenticateStreamableRequest(
  config: RuntimeConfig,
  authorization: string | undefined,
  sessionVerifier: JwtVerifier | undefined,
  security: ResolvedHttpSecurity,
  devNoAuth: boolean,
): Promise<StreamableAuthenticationResult> {
  if (devNoAuth) return { ok: true, authentication: { fingerprint: "dev-no-auth" } };
  const token = bearerToken(authorization);
  if (!token) return { ok: false, status: 401, error: "unauthorized" };
  if (!configUsesHttpClaims(config)) {
    if (!validBearerTokens(authorization, [security.activeToken, security.previousToken])) {
      return { ok: false, status: 401, error: "unauthorized" };
    }
    return { ok: true, authentication: { fingerprint: tokenFingerprint(token) } };
  }
  try {
    if (!sessionVerifier) return { ok: false, status: 401, error: "unauthorized" };
    const context = await verifySessionJwt(config, token, sessionVerifier);
    return { ok: true, authentication: { fingerprint: tokenFingerprint(token), context } };
  } catch (error) {
    if (error instanceof McpRuntimeError && error.code === "HTTP_INSUFFICIENT_SCOPE") {
      return { ok: false, status: 403, error: "insufficient_scope" };
    }
    return { ok: false, status: 401, error: "unauthorized" };
  }
}

export async function verifySessionJwt(config: RuntimeConfig, token: string, verifier: JwtVerifier): Promise<TrustedContext> {
  const auth = config.session_auth;
  if (!auth) throw new Error("session auth is not configured");
  const { payload: claims } = await verifier(token);
  const tenant = safeSessionClaim(claims[auth.tenant_claim ?? "tenant_id"]);
  const principal = safeSessionClaim(claims[auth.principal_claim ?? "sub"]);
  if (!tenant || !principal) throw new Error("JWT trusted context claims are missing or unsafe");
  const requiredScopes = config.http_security?.oauth_resource?.required_scopes ?? [];
  if (requiredScopes.length > 0) {
    const granted = safeJwtScopes(claims.scope, claims.scp);
    if (!requiredScopes.every((scope) => granted.has(scope))) {
      throw new McpRuntimeError("HTTP_INSUFFICIENT_SCOPE", "JWT does not grant the required MCP resource scope.");
    }
  }
  return { tenant_id: tenant, principal, provenance: "http_claims" };
}

export function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer[ \t]+([^\s,]+)$/i.exec(header ?? "");
  const token = match?.[1];
  return token && token.length <= 16_384 ? token : undefined;
}

export function safeJwtScopes(scope: unknown, scp: unknown): Set<string> {
  const values: string[] = [];
  if (typeof scope === "string" && scope.length <= 8_192 && !/[\u0000-\u001f\u007f]/.test(scope)) {
    values.push(...scope.split(/\s+/).filter(Boolean));
  } else if (scope !== undefined) {
    throw new Error("JWT scope claim is unsafe");
  }
  if (Array.isArray(scp) && scp.length <= 64 && scp.every((value) => typeof value === "string" && value.length <= 128 && !/[\s\u0000-\u001f\u007f]/.test(value))) {
    values.push(...scp);
  } else if (scp !== undefined) {
    throw new Error("JWT scp claim is unsafe");
  }
  if (values.length > 128 || values.some((value) => value.length > 128)) throw new Error("JWT scope claim is unsafe");
  return new Set(values);
}

export function tokenFingerprint(token: string): string {
  return `sha256:${crypto.createHash("sha256").update(token).digest("hex")}`;
}

export function jwtAudienceIncludes(value: unknown, expected: string): boolean {
  return value === expected || (Array.isArray(value) && value.some((item) => item === expected));
}

export function safeSessionClaim(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) return undefined;
  return text;
}

export function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function containsInitializeRequest(payload: unknown): boolean {
  if (Array.isArray(payload)) return payload.some((message) => isInitializeRequest(message));
  return isInitializeRequest(payload);
}

export function requestIdFromPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    const request = payload.find((message) => isRecord(message) && "id" in message);
    return isRecord(request) ? request.id ?? null : null;
  }
  return isRecord(payload) ? payload.id ?? null : null;
}

export function setCorsHeaders(response: ServerResponse, corsOrigin?: string): void {
  if (corsOrigin) {
    response.setHeader("access-control-allow-origin", corsOrigin);
    response.setHeader("access-control-allow-methods", "POST, GET, DELETE, OPTIONS");
    response.setHeader("access-control-allow-headers", "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id");
  }
}

export function setCommonHttpHeaders(response: ServerResponse, corsOrigin?: string): void {
  response.setHeader("content-type", "application/json; charset=utf-8");
  if (corsOrigin) {
    response.setHeader("access-control-allow-origin", corsOrigin);
    response.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
    response.setHeader("access-control-allow-headers", "authorization, content-type");
  }
}

export function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.end(`${JSON.stringify(payload, null, 2)}\n`);
}

export async function readRequestBody(request: IncomingMessage, maxBytes = 1_048_576): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new McpRuntimeError("HTTP_BODY_TOO_LARGE", `HTTP MCP request body exceeds the configured ${maxBytes}-byte limit.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function jsonRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

export function sanitizeHttpError(error: unknown, ...authTokens: Array<string | undefined>): string {
  const raw = error instanceof Error ? error.message : String(error);
  return sanitizeHttpString(raw, ...authTokens);
}

export function sanitizeHttpPayload(value: unknown, ...authTokens: Array<string | undefined>): unknown {
  if (typeof value === "string") return sanitizeHttpString(value, ...authTokens);
  if (Array.isArray(value)) return value.map((item) => sanitizeHttpPayload(item, ...authTokens));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeHttpPayload(item, ...authTokens)]));
  }
  return value;
}

export function sanitizeHttpString(value: string, ...authTokens: Array<string | undefined>): string {
  let redacted = value.replace(/(?:postgres(?:ql)?|mysql):\/\/[^\s"']+/gi, "[redacted-database-url]");
  for (const authToken of authTokens) if (authToken) redacted = redacted.split(authToken).join("[redacted-token]");
  return redacted;
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}
