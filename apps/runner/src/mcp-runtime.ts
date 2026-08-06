import { createMcpRuntime, describeIsolationAssurance, preflightGeneratedAuthority, serveStdio, startHttpMcpServer, startStreamableHttpMcpServer, toolNameExposures, type RuntimeCapabilityConfig, type RuntimeConfig, type SourceIsolationAssurance, type StreamableHttpSessionFactory, type StreamableHttpTlsOptions, type ToolNameStyle } from "@synapsor-runner/mcp-server";
import {
  ProposalStore
} from "@synapsor-runner/proposal-store";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";
import process from "node:process";
import { createScopedExploreMcpServer, serveScopedExploreStdio } from "./authoring-mcp.js";
import { loadActivatedExplorationBoundaries, type ActivatedExplorationBoundary } from "./auto-boundary.js";
import { createScopedExploreBoundarySetRuntime } from "./scoped-explore-boundary-set.js";
import {
  createScopedExploreDatabaseExecutor,
  prepareScopedExplore,
  type PreparedExplore,
  type ScopedExploreExecutor,
} from "./scoped-explore.js";
import { cliCommandName } from "./cli-command-meta.js";
import { fileExists } from "./cli-files.js";
import { formatScalar, isRecord, shellQuote } from "./cli-format.js";
import { assertKnownOptions, envValue, firstPositional, optionalArg } from "./cli-options.js";
import { confirmDangerousAction, defaultConfigPath, defaultStorePath, envWithDemoDefaults, optionalResolvedLocalStorePath, readRuntimeConfig, resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import { LocalDoctorGovernance, trustedContextsForDoctor } from "./doctor-domain.js";
import { formatSmokeCallResult, resultFormatOption } from "./mcp-shared.js";
import { writeStoreLease } from "./store-lease.js";
import { sharedPostgresLedgerMirrorRequested, withoutSharedPostgresLedgerMirror, withSharedPostgresLedgerMirror } from "./store-shared.js";
import { capabilityOperation, formatSourceReceiptMode, sourceNeedsSqlWriteback } from "./writeback-domain.js";


export async function mcpServe(args: string[]): Promise<number> {
  const transport = optionalArg(args, "--transport") ?? "stdio";
  if (args.includes("--authoring")) {
    if (transport !== "stdio") {
      throw new Error("Scoped Explore is authoring-only and may be served only over local stdio.");
    }
    assertKnownOptions(args, new Set(["--authoring", "--project-root", "--transport"]), "mcp serve --authoring");
    await serveScopedExploreStdio({
      projectRoot: path.resolve(optionalArg(args, "--project-root") ?? process.cwd()),
    });
    return 0;
  }
  if (args.includes("--production-explore") && transport !== "streamable-http") {
    throw new Error("Production Explore requires --transport streamable-http.");
  }
  if (transport === "streamable-http") return mcpServeStreamableHttp(args);
  if (transport === "http" || transport === "json-rpc-http" || transport === "jsonrpc-http") return mcpServeHttp(args);
  if (transport !== "stdio") throw new Error("--transport must be stdio, streamable-http, or http");
  const configPath = runnerConfigPath(args, defaultConfigPath);
  const readOnly = args.includes("--read-only");
  const baseConfig = await readRuntimeConfig(configPath);
  const config = readOnly ? { ...baseConfig, mode: "read_only" as const } : baseConfig;
  const toolNameStyle = toolNameStyleOption(args);
  const resultFormat = resultFormatOption(args);
  const storePath = optionalResolvedLocalStorePath(args);
  const releaseLease = await writeStoreLease(mcpServeLeaseStorePath(config, storePath), "mcp", "stdio", args.includes("--allow-concurrent-store"));
  try {
    await serveStdio({
      configPath,
      storePath,
      config,
      toolNameStyle,
      resultFormat,
    });
    return 0;
  } finally {
    await releaseLease();
  }
}


export async function mcpServeHttp(args: string[]): Promise<number> {
  if (args.includes("--production-explore")) {
    throw new Error("Production Explore requires spec MCP Streamable HTTP. Use mcp serve --transport streamable-http --production-explore.");
  }
  process.stderr.write([
    "Warning: mcp serve-http is a legacy JSON-RPC bridge, not spec MCP Streamable HTTP.",
    `For OpenAI Agents SDK or standard HTTP MCP clients, use: ${cliCommandName()} mcp serve --transport streamable-http`,
    "",
  ].join("\n"));
  const configPath = runnerConfigPath(args, defaultConfigPath);
  const readOnly = args.includes("--read-only");
  const baseConfig = await readRuntimeConfig(configPath);
  const config = readOnly ? { ...baseConfig, mode: "read_only" as const } : baseConfig;
  assertReceiptTopologyForTransport(config, "http");
  const host = optionalArg(args, "--host") ?? "127.0.0.1";
  const port = Number(optionalArg(args, "--port") ?? "8765");
  const resultFormat = resultFormatOption(args);
  const tls = httpTlsOptions(args, process.env);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  const storePath = optionalResolvedLocalStorePath(args);
  const releaseLease = await writeStoreLease(mcpServeLeaseStorePath(config, storePath), "mcp", "legacy-jsonrpc", args.includes("--allow-concurrent-store"));
  let server: Awaited<ReturnType<typeof startHttpMcpServer>>;
  try {
    server = await startHttpMcpServer({
      configPath,
      config,
      storePath,
      host,
      port,
      authTokenEnv: optionalArg(args, "--auth-token-env"),
      previousAuthTokenEnv: optionalArg(args, "--previous-auth-token-env"),
      devNoAuth: args.includes("--dev-no-auth"),
      corsOrigin: optionalArg(args, "--cors-origin"),
      trustedTlsProxy: args.includes("--trusted-tls-proxy"),
      unsafeAllowCleartextHttp: args.includes("--unsafe-allow-cleartext-http"),
      resultFormat,
      tls,
    });
  } catch (error) {
    await releaseLease();
    throw error;
  }
  process.stderr.write("Press Ctrl+C to stop.\n");
  await new Promise<void>((resolve) => {
    const stop = async () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await server.close();
      await releaseLease();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}


export async function mcpServeStreamableHttp(args: string[]): Promise<number> {
  const productionExplore = args.includes("--production-explore");
  if (productionExplore) {
    const presentationFlags = [
      "--result-format",
      "--tool-name-style",
      "--alias-mode",
      "--openai-tool-aliases",
      "--aliases",
    ].filter((flag) => args.includes(flag));
    if (presentationFlags.length > 0) {
      throw new Error(
        `Production Explore uses fixed app.describe_data/app.explore_data tool names and one fixed reviewed result envelope. Remove ${presentationFlags.join(", ")}; presentation aliases and result-format overrides are not available on this surface.`,
      );
    }
  }
  const configPath = runnerConfigPath(args, defaultConfigPath);
  const readOnly = args.includes("--read-only");
  const baseConfig = await readRuntimeConfig(configPath);
  const config = readOnly ? { ...baseConfig, mode: "read_only" as const } : baseConfig;
  let productionPosture: ProductionExploreStartupReport | undefined;
  if (productionExplore) {
    if (args.includes("--dev-no-auth")
      || args.includes("--unsafe-allow-cleartext-http")
      || optionalArg(args, "--auth-token-env")
      || optionalArg(args, "--previous-auth-token-env")) {
      throw new Error("Production Explore forbids development no-auth, cleartext break glass, and static endpoint-token flags.");
    }
    productionPosture = await assertProductionExploreStartup(
      config,
      process.env,
      loadActivatedExplorationBoundaries,
      prepareScopedExplore,
      {
        doctorCommand: `${cliCommandName()} doctor --config ${shellQuote(configPath)} --transport streamable-http`,
      },
    );
  }
  assertReceiptTopologyForTransport(config, "streamable-http");
  const toolNameStyle = toolNameStyleOption(args);
  const resultFormat = resultFormatOption(args);
  const host = optionalArg(args, "--host") ?? "127.0.0.1";
  const port = Number(optionalArg(args, "--port") ?? "8766");
  const tls = httpTlsOptions(args, process.env);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  const storePath = optionalResolvedLocalStorePath(args);
  const releaseLease = await writeStoreLease(mcpServeLeaseStorePath(config, storePath), "mcp", "streamable-http", args.includes("--allow-concurrent-store"));
  let server: Awaited<ReturnType<typeof startStreamableHttpMcpServer>>;
  try {
    server = await startStreamableHttpMcpServer({
      configPath,
      config,
      storePath,
      host,
      port,
      toolNameStyle,
      authTokenEnv: optionalArg(args, "--auth-token-env"),
      previousAuthTokenEnv: optionalArg(args, "--previous-auth-token-env"),
      devNoAuth: args.includes("--dev-no-auth"),
      corsOrigin: optionalArg(args, "--cors-origin"),
      trustedTlsProxy: args.includes("--trusted-tls-proxy"),
      unsafeAllowCleartextHttp: args.includes("--unsafe-allow-cleartext-http"),
      resultFormat,
      tls,
      ...(productionExplore
        ? { streamableSessionFactory: productionExploreSessionFactory(config, process.env) }
        : {}),
    });
  } catch (error) {
    await releaseLease();
    throw error;
  }
  if (productionPosture) {
    process.stderr.write(formatProductionExploreStartupReport(productionPosture));
  }
  process.stderr.write("Press Ctrl+C to stop.\n");
  await new Promise<void>((resolve) => {
    const stop = async () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      await server.close();
      await releaseLease();
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

export type ProductionExploreStartupCheck = {
  name: string;
  ok: boolean;
  level: "pass" | "warn" | "fail";
  message: string;
};

export type ProductionExploreStartupReport = {
  ok: boolean;
  checks: ProductionExploreStartupCheck[];
  active_boundaries: string[];
  tools: ["app.describe_data", "app.explore_data"];
};

export async function inspectProductionExploreStartup(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  loadBoundaries: (projectRoot: string) => Promise<ActivatedExplorationBoundary[]> = loadActivatedExplorationBoundaries,
  prepareBoundary: (input: {
    projectRoot: string;
    transport: "streamable_http";
    mode: "production_http";
    boundaryName: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<PreparedExplore> = prepareScopedExplore,
): Promise<ProductionExploreStartupReport> {
  const production = config.production_explore;
  const checks: ProductionExploreStartupCheck[] = [];
  const add = (
    name: string,
    ok: boolean,
    message: string,
    level: ProductionExploreStartupCheck["level"] = ok ? "pass" : "fail",
  ) => checks.push({ name, ok, level, message });
  if (!production?.enabled) {
    add("explicit-opt-in", false, "Production Explore is off. Set production_explore.enabled to true in the reviewed runtime configuration.");
    return {
      ok: false,
      checks,
      active_boundaries: [],
      tools: ["app.describe_data", "app.explore_data"],
    };
  }
  add("explicit-opt-in", true, "Production Explore is explicitly enabled.");
  add(
    "read-only-runtime",
    config.mode === "read_only",
    config.mode === "read_only"
      ? "The deployment is read-only; proposal, approval, apply, and write tools are unavailable."
      : "Production Explore requires runtime mode read_only.",
  );
  const rawHmacKey = envValue(env, production.budget_hmac_key_env);
  const hmacIssue = productionExploreHmacKeyIssue(rawHmacKey);
  const hmacReady = !hmacIssue;
  add(
    "shared-budget-hmac",
    hmacReady,
    hmacReady
      ? `Opaque accounting uses at least 32 bytes of randomly generated key material from ${production.budget_hmac_key_env}; the value is not displayed.`
      : `${production.budget_hmac_key_env} ${hmacIssue}`,
  );
  const sharedStoreReady = config.storage?.shared_postgres?.mode === "runtime_store"
    && Boolean(envValue(env, config.storage.shared_postgres.url_env));
  add(
    "shared-accounting-store",
    sharedStoreReady,
    sharedStoreReady
      ? `Atomic production accounting uses shared Postgres from ${config.storage!.shared_postgres!.url_env}; the URL is not displayed.`
      : "Production Explore requires storage.shared_postgres.mode runtime_store and its configured URL environment value.",
  );
  const authReady = config.session_auth?.provider === "jwt_asymmetric"
    && Boolean(config.session_auth.issuer)
    && Boolean(config.session_auth.audience)
    && (production.single_organization_id
      ? !config.session_auth.tenant_claim
      : Boolean(config.session_auth.tenant_claim))
    && Boolean(config.session_auth.principal_claim);
  add(
    "verified-principal-scope",
    authReady,
    authReady
      ? production.single_organization_id
        ? `Every session requires asymmetric JWT verification and trusted ${config.session_auth!.principal_claim} principal claims; organization identity is fixed as ${production.single_organization_id}.`
        : `Every session requires asymmetric JWT verification and trusted ${config.session_auth!.tenant_claim}/${config.session_auth!.principal_claim} claims.`
      : "Production Explore requires asymmetric JWT verification with exact issuer, audience, principal claim, and either a tenant claim or reviewed fixed organization identity.",
  );
  const requiredScopes = config.http_security?.oauth_resource?.required_scopes ?? [];
  const transportReady = config.http_security?.deployment === "shared"
    && (config.http_security.channel === "direct_tls" || config.http_security.channel === "trusted_tls_proxy")
    && requiredScopes.includes(production.required_oauth_scope);
  add(
    "secured-http-transport",
    transportReady,
    transportReady
      ? `Shared Streamable HTTP requires OAuth scope ${production.required_oauth_scope} over ${config.http_security!.channel}.`
      : "Production Explore requires shared Streamable HTTP, direct TLS or a trusted TLS proxy, and its OAuth scope in required_scopes.",
  );
  add(
    "hierarchical-budgets",
    true,
    `Per-principal rolling budgets come from each reviewed boundary; tenant ceilings are ${production.tenant_limits.max_queries_per_rolling_24_hours} queries, ${production.tenant_limits.max_extracted_cells_per_rolling_24_hours} cells, ${production.tenant_limits.max_differencing_queries_per_rolling_24_hours} differencing variants per 24 hours, and ${production.tenant_limits.requests_per_minute} requests per minute. The per-response tenant ceiling is ${production.tenant_limits.max_response_cells_per_response === undefined ? "inherited from each boundary" : `${production.tenant_limits.max_response_cells_per_response} cells`}.`,
  );
  add(
    "source-connection-ceiling",
    true,
    `Every production Explore session shares one process-wide source pool capped at ${production.source_max_connections ?? 8} connections. Size this below the source database connection allowance.`,
  );
  add(
    "principal-session-ceiling",
    true,
    `Each verified tenant/principal pair may hold at most ${production.max_sessions_per_principal ?? 4} concurrent MCP sessions; other principals have independent session capacity.`,
  );
  let boundaries: ActivatedExplorationBoundary[] = [];
  const controlDatabaseSeparationFailures: string[] = [];
  let controlDatabaseSeparationEvaluated = 0;
  try {
    boundaries = await loadBoundaries(production.project_root);
  } catch (error) {
    add("active-production-boundaries", false, `Production Explore boundaries could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (boundaries.length === 0 && !checks.some((check) => check.name === "active-production-boundaries")) {
    add("active-production-boundaries", false, "Production Explore requires at least one active reviewed production boundary.");
  }
  if (boundaries.length > 0) {
    const reviewedSources = new Map(boundaries.map((boundary) => [boundary.pack.name, boundary.source]));
    const sourceNames = new Set(reviewedSources.values());
    add(
      "single-reviewed-source",
      sourceNames.size === 1,
      sourceNames.size === 1
        ? `Every active production boundary uses reviewed source ${[...sourceNames][0]}.`
        : `Active production boundaries must use one reviewed source, but these conflict: ${[...reviewedSources].map(([name, source]) => `${name} -> ${source}`).join(", ")}. Split them across separate Runner deployments.`,
    );
  }
  for (const boundary of boundaries) {
    if (boundary.deployment_profile !== "production") {
      add("active-production-boundaries", false, `Boundary ${boundary.pack.name} is ${boundary.deployment_profile}, not a separately reviewed production boundary.`);
      continue;
    }
    if (boundary.trusted_context.provider !== "http_claims") {
      add("active-production-boundaries", false, `Boundary ${boundary.pack.name} does not bind tenant and principal scope to verified HTTP claims.`);
      continue;
    }
    const organizationMatches = boundary.organization_scope
      ? boundary.organization_scope.organization_id === production.single_organization_id
        && boundary.trusted_context.tenant_claim === undefined
      : production.single_organization_id === undefined
        && boundary.trusted_context.tenant_claim === config.session_auth?.tenant_claim;
    if (!organizationMatches
      || boundary.trusted_context.principal_claim !== config.session_auth?.principal_claim) {
      add("active-production-boundaries", false, `Boundary ${boundary.pack.name} claim bindings do not match session_auth. Regenerate and review the production boundary against this HTTP identity contract.`);
      continue;
    }
    const configuredSource = config.sources?.[boundary.source];
    if (!configuredSource) {
      add("active-production-boundaries", false, `Boundary ${boundary.pack.name} references source ${boundary.source}, which is absent from the runtime config.`);
      continue;
    }
    if (configuredSource.engine === "postgres") controlDatabaseSeparationEvaluated += 1;
    const separationFailure = productionExploreControlDatabaseSeparationFailure({
      sourceName: boundary.source,
      sourceEngine: configuredSource.engine,
      sourceUrlEnv: configuredSource.read_url_env,
      controlUrlEnv: config.storage!.shared_postgres!.url_env,
      env,
    });
    if (separationFailure) {
      controlDatabaseSeparationFailures.push(separationFailure);
      continue;
    }
    try {
      const prepared = await prepareBoundary({
        projectRoot: production.project_root,
        transport: "streamable_http",
        mode: "production_http",
        boundaryName: boundary.pack.name,
        env,
      });
      if (prepared.lock.engine !== configuredSource.engine
        || prepared.lock.source_env !== configuredSource.read_url_env) {
        add(
          "active-production-boundaries",
          false,
          `Boundary ${boundary.pack.name} source lock does not match runtime source ${boundary.source}. The reviewed engine and read credential environment name must match exactly.`,
        );
      }
    } catch (error) {
      add(
        "active-production-boundaries",
        false,
        `Boundary ${boundary.pack.name} failed current schema, read-only role, or generation-lock attestation: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (boundaries.length > 0 && !checks.some((check) => check.name === "active-production-boundaries")) {
    add(
      "active-production-boundaries",
      true,
      `${boundaries.length} exact-digest production ${boundaries.length === 1 ? "boundary is" : "boundaries are"} active: ${boundaries.map((boundary) => boundary.pack.name).join(", ")}.`,
    );
  }
  if (controlDatabaseSeparationFailures.length > 0) {
    add("control-database-separation", false, controlDatabaseSeparationFailures.join(" "));
  } else if (controlDatabaseSeparationEvaluated > 0) {
    add(
      "control-database-separation",
      true,
      "The shared privacy-accounting database is separate from every reviewed PostgreSQL source database.",
    );
  }
  const budgetSizingWarnings = productionExploreTenantBudgetSizingWarnings(production, boundaries);
  add(
    "tenant-budget-sizing",
    true,
    budgetSizingWarnings.length === 0
      ? "Tenant ceilings are not below any active boundary's per-principal budgets."
      : `Safe but potentially disruptive configuration: ${budgetSizingWarnings.join("; ")}. Raise the tenant ceilings above expected aggregate principal usage to avoid tenant-wide throttling.`,
    budgetSizingWarnings.length === 0 ? "pass" : "warn",
  );
  add(
    "model-tool-surface",
    true,
    "The model receives only app.describe_data and app.explore_data; activation, approval, apply, Protect, configuration, credentials, and SQL remain unavailable.",
  );
  return {
    ok: checks.every((check) => check.ok),
    checks,
    active_boundaries: boundaries.map((boundary) => boundary.pack.name),
    tools: ["app.describe_data", "app.explore_data"],
  };
}

function productionExploreHmacKeyIssue(value: string | undefined): string | undefined {
  if (!value || Buffer.byteLength(value, "utf8") < 32) {
    return "must contain at least 32 bytes of randomly generated secret material shared by every Runner replica. A base64url key generated from 32 random bytes is about 43 characters.";
  }
  if (/^[a-f0-9]+$/i.test(value) && value.length < 64) {
    return "looks like a short hexadecimal key. Use at least 64 hexadecimal characters for 32 random bytes; a 32-character hex string contains only 16 bytes.";
  }
  return undefined;
}

function productionExploreTenantBudgetSizingWarnings(
  production: NonNullable<RuntimeConfig["production_explore"]>,
  boundaries: ActivatedExplorationBoundary[],
): string[] {
  const warnings: string[] = [];
  for (const boundary of boundaries) {
    const budgets = boundary.budgets;
    if (!budgets) continue;
    const lower: string[] = [];
    if (production.tenant_limits.max_queries_per_rolling_24_hours < budgets.max_queries_per_session) {
      lower.push(`queries ${production.tenant_limits.max_queries_per_rolling_24_hours} < ${budgets.max_queries_per_session}`);
    }
    if (production.tenant_limits.max_extracted_cells_per_rolling_24_hours < budgets.max_extracted_cells_per_session) {
      lower.push(`extracted cells ${production.tenant_limits.max_extracted_cells_per_rolling_24_hours} < ${budgets.max_extracted_cells_per_session}`);
    }
    if (production.tenant_limits.max_differencing_queries_per_rolling_24_hours < budgets.max_differencing_queries) {
      lower.push(`differencing queries ${production.tenant_limits.max_differencing_queries_per_rolling_24_hours} < ${budgets.max_differencing_queries}`);
    }
    if (production.tenant_limits.requests_per_minute < budgets.rate_limit_per_minute) {
      lower.push(`requests per minute ${production.tenant_limits.requests_per_minute} < ${budgets.rate_limit_per_minute}`);
    }
    if (production.tenant_limits.max_response_cells_per_response !== undefined
      && production.tenant_limits.max_response_cells_per_response < budgets.max_response_cells) {
      lower.push(`response cells ${production.tenant_limits.max_response_cells_per_response} < ${budgets.max_response_cells}`);
    }
    if (lower.length > 0) warnings.push(`${boundary.pack.name}: ${lower.join(", ")}`);
  }
  return warnings;
}

function productionExploreControlDatabaseSeparationFailure(input: {
  sourceName: string;
  sourceEngine: "postgres" | "mysql";
  sourceUrlEnv: string;
  controlUrlEnv: string;
  env: NodeJS.ProcessEnv;
}): string | undefined {
  if (input.sourceEngine !== "postgres") return undefined;
  if (input.sourceUrlEnv === input.controlUrlEnv) {
    return `Source ${input.sourceName} and the shared privacy ledger use the same database URL environment variable. Configure a separate PostgreSQL control database.`;
  }
  const source = postgresDatabaseTarget(input.env[input.sourceUrlEnv]);
  const control = postgresDatabaseTarget(input.env[input.controlUrlEnv]);
  if (!source || !control) {
    return `Runner could not attest that source ${input.sourceName} and the shared privacy ledger use separate PostgreSQL databases. Both environment values must be PostgreSQL URLs naming a database.`;
  }
  if (source === control) {
    return `Source ${input.sourceName} and the shared privacy ledger resolve to the same PostgreSQL database. Configure a separate control database so Explore accounting never mutates the application source.`;
  }
  return undefined;
}

function postgresDatabaseTarget(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") return undefined;
    const hostname = (parsed.hostname || parsed.searchParams.get("host") || "").toLowerCase();
    const port = parsed.port || parsed.searchParams.get("port") || "5432";
    const pathDatabase = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    const database = pathDatabase || parsed.searchParams.get("dbname") || "";
    if (!hostname || !database) return undefined;
    return `${hostname}:${port}:${database}`;
  } catch {
    return undefined;
  }
}

export async function assertProductionExploreStartup(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  loadBoundaries: (projectRoot: string) => Promise<ActivatedExplorationBoundary[]> = loadActivatedExplorationBoundaries,
  prepareBoundary: Parameters<typeof inspectProductionExploreStartup>[3] = prepareScopedExplore,
  options: { doctorCommand?: string } = {},
): Promise<ProductionExploreStartupReport> {
  const report = await inspectProductionExploreStartup(config, env, loadBoundaries, prepareBoundary);
  if (!report.ok) {
    throw new Error([
      formatProductionExploreStartupReport(report).trimEnd(),
      "",
      `Production Explore did not start. Run ${options.doctorCommand ?? `${cliCommandName()} doctor --config <path-to-synapsor.runner.json> --transport streamable-http`} to inspect every prerequisite together.`,
    ].join("\n"));
  }
  return report;
}

export function formatProductionExploreStartupReport(report: ProductionExploreStartupReport): string {
  const lines = [
    "",
    report.ok ? "PRODUCTION EXPLORE READY" : "PRODUCTION EXPLORE NOT READY",
    ...report.checks.map((check) => `  ${check.level === "warn" ? "WARN" : check.ok ? "OK" : "FAIL"}  ${check.message}`),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function productionExploreSessionFactory(
  config: RuntimeConfig,
  env: NodeJS.ProcessEnv,
  dependencies: {
    loadBoundaries?: typeof loadActivatedExplorationBoundaries;
    createExecutor?: typeof createScopedExploreDatabaseExecutor;
    createBoundarySetRuntime?: typeof createScopedExploreBoundarySetRuntime;
    createMcpServer?: typeof createScopedExploreMcpServer;
  } = {},
): StreamableHttpSessionFactory {
  const production = config.production_explore;
  if (!production?.enabled) throw new Error("Production Explore is not enabled.");
  const hmacKey = Buffer.from(envValue(env, production.budget_hmac_key_env) ?? "", "utf8");
  const tenantLimits = {
    max_queries_per_session: production.tenant_limits.max_queries_per_rolling_24_hours,
    max_extracted_cells_per_session: production.tenant_limits.max_extracted_cells_per_rolling_24_hours,
    max_differencing_queries: production.tenant_limits.max_differencing_queries_per_rolling_24_hours,
    rate_limit_per_minute: production.tenant_limits.requests_per_minute,
    // The query runtime clamps this optional tenant ceiling to the selected
    // boundary's per-principal response cap before reserving any budget.
    max_response_cells: production.tenant_limits.max_response_cells_per_response ?? Number.MAX_SAFE_INTEGER,
  };
  let sharedExecutorLeasePromise: Promise<ProductionExploreExecutorLease> | undefined;
  let closed = false;
  const sharedExecutor = (): Promise<ScopedExploreExecutor> => {
    if (!sharedExecutorLeasePromise) {
      const bootstrap = (async () => {
        const boundaries = await (dependencies.loadBoundaries ?? loadActivatedExplorationBoundaries)(production.project_root);
        const sourceNames = [...new Set(boundaries.map((boundary) => boundary.source))];
        if (sourceNames.length !== 1) {
          throw new Error("Production Explore requires every active boundary to use one reviewed source.");
        }
        const source = config.sources?.[sourceNames[0]!];
        if (!source) throw new Error(`Production Explore source ${sourceNames[0]} is absent from the runtime config.`);
        const databaseUrl = envValue(env, source.read_url_env);
        if (!databaseUrl) throw new Error(`${source.read_url_env} is required for production Explore.`);
        return await acquireProductionExploreExecutor({
          engine: source.engine,
          databaseUrl,
          maxConnections: production.source_max_connections ?? 8,
          createExecutor: dependencies.createExecutor ?? createScopedExploreDatabaseExecutor,
        });
      })();
      const recoverable = bootstrap.catch((error) => {
        if (sharedExecutorLeasePromise === recoverable) sharedExecutorLeasePromise = undefined;
        throw error;
      });
      sharedExecutorLeasePromise = recoverable;
    }
    return sharedExecutorLeasePromise.then((lease) => lease.executor);
  };
  const factory: StreamableHttpSessionFactory = async ({ store, trustedContext }) => {
    if (closed) throw new Error("Production Explore session factory is closed.");
    if (trustedContext.provenance !== "http_claims"
      || !trustedContext.tenant_id.trim()
      || !trustedContext.principal.trim()
      || (production.single_organization_id !== undefined
        && trustedContext.tenant_id !== production.single_organization_id)) {
      throw new Error(production.single_organization_id
        ? "Single-organization production Explore requires a verified principal and the exact reviewed organization identity for every MCP session."
        : "Production Explore requires verified tenant and principal HTTP claims for every MCP session.");
    }
    const executor = await sharedExecutor();
    const runtime = await (dependencies.createBoundarySetRuntime ?? createScopedExploreBoundarySetRuntime)({
      projectRoot: production.project_root,
      transport: "streamable_http",
      mode: "production_http",
      env,
      store,
      sessionContext: {
        tenant_id: trustedContext.tenant_id,
        principal: trustedContext.principal,
        provenance: "http_claims",
      },
      productionPrivacyHmacKey: hmacKey,
      productionAccountingNamespace: production.accounting_namespace,
      productionTenantLimits: tenantLimits,
      executor,
    });
    const server = (dependencies.createMcpServer ?? createScopedExploreMcpServer)(runtime, { mode: "production_http" });
    return {
      connect: (transport) => server.connect(transport),
      close: async () => {
        await Promise.allSettled([server.close(), runtime.close()]);
      },
    };
  };
  factory.maxSessionsPerPrincipal = production.max_sessions_per_principal ?? 4;
  factory.close = async () => {
    if (closed) return;
    closed = true;
    const pendingLease = sharedExecutorLeasePromise;
    sharedExecutorLeasePromise = undefined;
    if (!pendingLease) return;
    const lease = await pendingLease.catch(() => undefined);
    if (!lease) return;
    await lease.release().catch(() => {
      process.stderr.write("Warning: the shared production Explore source pool did not close cleanly.\n");
    });
  };
  return factory;
}

type ProductionExploreExecutorLease = {
  executor: ScopedExploreExecutor;
  release(): Promise<void>;
};

type ProductionExploreExecutorRegistryEntry = {
  executor: Promise<ScopedExploreExecutor>;
  maxConnections: number;
  references: number;
};

const productionExploreExecutorRegistry = new Map<string, ProductionExploreExecutorRegistryEntry>();

async function acquireProductionExploreExecutor(input: {
  engine: "postgres" | "mysql";
  databaseUrl: string;
  maxConnections: number;
  createExecutor: typeof createScopedExploreDatabaseExecutor;
}): Promise<ProductionExploreExecutorLease> {
  const registryKey = crypto.createHash("sha256")
    .update(`${input.engine}\0${input.databaseUrl}`)
    .digest("hex");
  let entry = productionExploreExecutorRegistry.get(registryKey);
  if (entry && entry.maxConnections !== input.maxConnections) {
    throw new Error(
      "Production Explore servers in one process must use the same source connection ceiling for the same database.",
    );
  }
  if (!entry) {
    entry = {
      executor: Promise.resolve(input.createExecutor({
        engine: input.engine,
        databaseUrl: input.databaseUrl,
        maxConnections: input.maxConnections,
      })),
      maxConnections: input.maxConnections,
      references: 0,
    };
    productionExploreExecutorRegistry.set(registryKey, entry);
  }
  entry.references += 1;
  let released = false;
  try {
    const executor = await entry.executor;
    return {
      executor,
      release: async () => {
        if (released) return;
        released = true;
        const current = productionExploreExecutorRegistry.get(registryKey);
        if (!current) return;
        current.references -= 1;
        if (current.references > 0) return;
        productionExploreExecutorRegistry.delete(registryKey);
        await executor.close();
      },
    };
  } catch (error) {
    entry.references -= 1;
    if (entry.references <= 0) productionExploreExecutorRegistry.delete(registryKey);
    throw error;
  }
}


function mcpServeLeaseStorePath(config: RuntimeConfig, storePath: string | undefined): string | undefined {
  // In runtime_store mode, the MCP server never opens the local SQLite ledger.
  // Holding a SQLite lease would be misleading and can block unrelated local
  // inspection/reset commands for a file the server is not using.
  return config.storage?.shared_postgres?.mode === "runtime_store" ? ":memory:" : storePath;
}


export function assertReceiptTopologyForTransport(config: RuntimeConfig, transport: string): void {
  if (transport === "stdio" || config.mode !== "review") return;
  const runnerLedgerSources = Object.entries(config.sources ?? {}).filter(([sourceName, source]) =>
    source.receipts?.authority === "runner_ledger" && sourceNeedsSqlWriteback(config, sourceName));
  if (runnerLedgerSources.length === 0) return;
  if (config.storage?.shared_postgres?.mode !== "runtime_store") {
    throw new Error(`Networked MCP with runner_ledger writeback requires storage.shared_postgres.mode runtime_store. Local SQLite is supported only for one local stdio/operator process. Unsafe sources: ${runnerLedgerSources.map(([name]) => name).join(", ")}.`);
  }
}


export function networkHttpSecurityArgs(args: string[]): string[] {
  return [
    ...(optionalArg(args, "--previous-auth-token-env") ? ["--previous-auth-token-env", optionalArg(args, "--previous-auth-token-env") as string] : []),
    ...(args.includes("--trusted-tls-proxy") ? ["--trusted-tls-proxy"] : []),
    ...(args.includes("--unsafe-allow-cleartext-http") ? ["--unsafe-allow-cleartext-http"] : []),
    ...(optionalArg(args, "--tls-cert-env") ? ["--tls-cert-env", optionalArg(args, "--tls-cert-env") as string] : []),
    ...(optionalArg(args, "--tls-key-env") ? ["--tls-key-env", optionalArg(args, "--tls-key-env") as string] : []),
    ...(optionalArg(args, "--tls-ca-env") ? ["--tls-ca-env", optionalArg(args, "--tls-ca-env") as string] : []),
    ...(args.includes("--require-client-cert") ? ["--require-client-cert"] : []),
  ];
}


function httpTlsOptions(args: string[], env: NodeJS.ProcessEnv): StreamableHttpTlsOptions | undefined {
  const certEnv = optionalArg(args, "--tls-cert-env");
  const keyEnv = optionalArg(args, "--tls-key-env");
  const caEnv = optionalArg(args, "--tls-ca-env");
  const requestClientCert = args.includes("--require-client-cert");
  if (!certEnv && !keyEnv && !caEnv && !requestClientCert) return undefined;
  if (!certEnv || !keyEnv) throw new Error("HTTP TLS requires both --tls-cert-env and --tls-key-env.");
  const cert = envValue(env, certEnv);
  const key = envValue(env, keyEnv);
  const ca = caEnv ? envValue(env, caEnv) : undefined;
  if (!cert) throw new Error(`${certEnv} is not set or is empty.`);
  if (!key) throw new Error(`${keyEnv} is not set or is empty.`);
  if (requestClientCert && !ca) throw new Error("--require-client-cert requires --tls-ca-env with the trusted client CA bundle.");
  return { cert, key, ca, requestClientCert };
}


export function toolNameStyleOption(args: string[]): ToolNameStyle {
  const requestedStyle = optionalArg(args, "--tool-name-style");
  const requestedAliasMode = optionalArg(args, "--alias-mode");
  if (requestedStyle && requestedAliasMode && requestedStyle !== requestedAliasMode) {
    throw new Error("--tool-name-style and --alias-mode must match when both are provided");
  }
  const requested = requestedAliasMode ?? requestedStyle;
  if (args.includes("--openai-tool-aliases")) {
    if (requested && requested !== "openai") throw new Error("--openai-tool-aliases cannot be combined with a non-openai alias mode");
    return "openai";
  }
  if (!requested) return "canonical";
  if (requested === "canonical" || requested === "openai" || requested === "both") return requested;
  throw new Error("--alias-mode must be canonical, openai, or both");
}


export async function propose(args: string[]): Promise<number> {
  const capabilityName = firstPositional(args);
  if (!capabilityName) throw new Error("propose requires <capability-name>");
  const configPath = runnerConfigPath(args, defaultConfigPath);
  const storePath = resolvedLocalStorePath(args, undefined, defaultStorePath);
  const config = await readRuntimeConfig(configPath);
  if (sharedPostgresLedgerMirrorRequested(args, config)) {
    return withSharedPostgresLedgerMirror(args, storePath, `propose ${capabilityName}`, () => propose(withoutSharedPostgresLedgerMirror(args)), config);
  }
  const capability = (config.capabilities ?? []).find((item) => item.name === capabilityName);
  if (!capability) throw new Error(`proposal capability not found: ${capabilityName}`);
  if (capability.kind !== "proposal") throw new Error(`${capabilityName} is a ${capability.kind} capability. Use a proposal capability with ${cliCommandName()} propose.`);
  const input = await proposalInput(args, capability);
  const env = envWithDemoDefaults(config, configPath);
  const store = new ProposalStore(storePath);
  const runtime = createMcpRuntime(config, { store, env });
  try {
    const result = await runtime.callTool(capabilityName, input);
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(formatProposeResult(capabilityName, result, storePath));
    }
    return 0;
  } finally {
    await runtime.close();
  }
}


async function proposalInput(args: string[], capability: RuntimeCapabilityConfig): Promise<Record<string, unknown>> {
  const jsonInput = optionalArg(args, "--json");
  const inputPath = optionalArg(args, "--input");
  const sample = args.includes("--sample");
  const selected = [Boolean(jsonInput), Boolean(inputPath), sample].filter(Boolean).length;
  if (selected > 1) throw new Error("propose accepts only one of --sample, --input, or --json");
  if (jsonInput) {
    const parsed = JSON.parse(jsonInput);
    if (!isRecord(parsed)) throw new Error("propose --json must be a JSON object");
    return parsed;
  }
  if (inputPath) {
    const parsed = JSON.parse(await fs.readFile(inputPath, "utf8"));
    if (!isRecord(parsed)) throw new Error("propose --input must point to a JSON object");
    return parsed;
  }
  if (sample) return sampleInputForCapability(capability);
  throw new Error(`propose ${capability.name} requires --sample, --input <file>, or --json '<object>'`);
}


function sampleInputForCapability(capability: RuntimeCapabilityConfig): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(capability.args)) {
    if (spec.type === "object_array") {
      input[name] = [Object.fromEntries(Object.entries(spec.fields).map(([fieldName, fieldSpec]) => [fieldName, sampleScalarArg(fieldName, fieldSpec)]))];
      continue;
    }
    if (name === capability.lookup.id_from_arg) input[name] = sampleIdForCapability(capability, name);
    else if (/reason/i.test(name)) input[name] = sampleReasonForCapability(capability);
    else if (/resolution/i.test(name)) input[name] = "Resolved after reviewing policy evidence.";
    else if (spec.enum?.length) input[name] = spec.enum[0];
    else if (/status/i.test(name)) input[name] = "pending_review";
    else if (/amount|cents|fee|credit|balance/i.test(name)) input[name] = typeof spec.maximum === "number" ? Math.min(spec.maximum, 1000) : 0;
    else if (spec.type === "number") input[name] = spec.minimum ?? 1;
    else if (spec.type === "boolean") input[name] = true;
    else input[name] = `sample_${name}`;
  }
  const missing = Object.entries(capability.args)
    .filter(([, spec]) => spec.required !== false)
    .filter(([name]) => input[name] === undefined)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`no sample exists for ${capability.name}. Required input fields: ${missing.join(", ")}`);
  }
  return input;
}


function sampleScalarArg(name: string, spec: Exclude<RuntimeCapabilityConfig["args"][string], { type: "object_array" }>): unknown {
  if (spec.enum?.length) return spec.enum[0];
  if (/reason/i.test(name)) return "Reviewed sample reason.";
  if (/status/i.test(name)) return "pending_review";
  if (spec.type === "number") return spec.minimum ?? (typeof spec.maximum === "number" ? Math.min(spec.maximum, 1000) : 1);
  if (spec.type === "boolean") return true;
  return `sample_${name}`;
}


function sampleIdForCapability(capability: RuntimeCapabilityConfig, argName: string): string {
  const text = `${capability.name} ${capability.target.table} ${argName}`.toLowerCase();
  const arg = argName.toLowerCase();
  if (/invoice|billing/.test(text)) return "INV-3001";
  if (/account|customer/.test(arg) || /accounts|customers/.test(text)) return "cust_acme_1";
  if (/ticket|support/.test(text)) return "T-1042";
  if (/order/.test(text)) return "O-1001";
  return "sample_1";
}


function sampleReasonForCapability(capability: RuntimeCapabilityConfig): string {
  const text = `${capability.name} ${capability.target.table}`.toLowerCase();
  if (/order|status_change/.test(text)) return "payment cleared and ready for the next status";
  if (/credit|customer|account/.test(text)) return "support goodwill credit";
  if (/late_fee|waiver|billing|invoice/.test(text)) return "approved support waiver";
  return "reviewed and approved by support";
}


function formatProposeResult(capabilityName: string, result: Record<string, unknown>, storePath: string): string {
  const proposalId = String(result.proposal_id ?? "");
  const evidenceId = String(result.evidence_bundle_id ?? "");
  const sourceChanged = result.source_database_changed === true || result.source_database_mutated === true;
  const status = String(result.status ?? "review_required");
  const approval = isRecord(result.approval) ? result.approval : undefined;
  const autoApproved = status === "approved" && approval?.mode === "policy";
  const lines = [
    autoApproved ? "Proposal created and policy-approved." : "Proposal created.",
    "",
    "Capability:",
    capabilityName,
    "",
    "Proposal:",
    proposalId || "(missing)",
    "",
    "Evidence:",
    evidenceId || "(missing)",
    "",
    "Source DB changed:",
    sourceChanged ? "yes" : "no",
    "",
    "Approval:",
    autoApproved ? `approved by policy ${String(approval?.policy ?? "")}` : "required outside MCP",
    "",
    "Review:",
    `${cliCommandName()} proposals show ${proposalId || "latest"} --store ${storePath}`,
    ...(autoApproved ? [] : [`${cliCommandName()} proposals approve ${proposalId || "latest"} --store ${storePath}`]),
    `${cliCommandName()} apply ${proposalId || "latest"} --store ${storePath}`,
    `${cliCommandName()} replay ${proposalId || "latest"} --store ${storePath}`,
    "",
  ];
  return `${lines.join("\n")}\n`;
}


export async function mcpConfigure(args: string[]): Promise<number> {
  const client = normalizeMcpClientName(optionalArg(args, "--client"));
  if (!client) throw new Error("mcp configure requires --client generic-stdio|claude|claude-desktop|cursor|vscode|openai-agents");
  const useAbsolutePaths = args.includes("--absolute-paths");
  const rawConfigPath = runnerConfigPath(args, "./synapsor.runner.json");
  const rawStorePath = optionalArg(args, "--store") ?? "./.synapsor/local.db";
  const configPath = useAbsolutePaths ? path.resolve(rawConfigPath) : rawConfigPath;
  const storePath = useAbsolutePaths ? path.resolve(rawStorePath) : rawStorePath;
  const transport = mcpClientConfigTransport(args, client);
  const aliasMode = mcpClientConfigAliasMode(args, client);
  const includeInstructions = args.includes("--include-instructions");
  const host = optionalArg(args, "--host") ?? "127.0.0.1";
  const port = Number(optionalArg(args, "--port") ?? "8766");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("--port must be an integer from 1 to 65535");
  }
  if (!await fileExists(rawConfigPath)) {
    process.stderr.write(`Warning: config path does not exist yet: ${rawConfigPath}\n`);
  }
  if (transport === "stdio" && (!path.isAbsolute(configPath) || !path.isAbsolute(storePath))) {
    process.stderr.write("Warning: relative paths are resolved by the MCP client working directory. Use --absolute-paths if the client runs from another directory.\n");
  }
  const existingConfig = await fileExists(rawConfigPath) ? await readRuntimeConfig(rawConfigPath) : undefined;
  const claimsAuth = Boolean(existingConfig && trustedContextsForDoctor(existingConfig).some((context) => context.provider === "http_claims"));
  const authTokenEnv = optionalArg(args, "--auth-token-env")
    ?? existingConfig?.http_security?.static_token?.active_env
    ?? "SYNAPSOR_RUNNER_HTTP_TOKEN";
  const clientAccessTokenEnv = optionalArg(args, "--client-access-token-env")
    ?? (claimsAuth ? "SYNAPSOR_MCP_ACCESS_TOKEN" : authTokenEnv);
  const snippet = mcpClientSnippet(client, configPath, storePath, {
    transport,
    aliasMode,
    host,
    port,
    authTokenEnv,
    clientAccessTokenEnv,
    authMode: claimsAuth ? "signed-jwt" : "opaque-static",
    oauthResource: existingConfig?.http_security?.oauth_resource?.resource,
    authorizationServers: existingConfig?.http_security?.oauth_resource?.authorization_servers,
  });
  if (includeInstructions) {
    snippet.agent_instructions = mcpAgentInstructions(client, aliasMode);
  }
  if (args.includes("--write")) {
    const destination = optionalArg(args, "--destination");
    if (!destination) throw new Error("mcp configure --write requires --destination <path>");
    await writeMcpClientSnippet(destination, client, snippet, args.includes("--yes"));
    process.stdout.write(`wrote MCP ${client} configuration to ${destination}\n`);
  } else {
    process.stderr.write(`Paste this ${client} MCP config into your local MCP client settings. It contains command paths and credential environment references only, not database URLs, write credentials, or token values.\n`);
    process.stderr.write("Proposal tools advertise a display-only MCP App automatically where the host supports it; other clients retain the same text/JSON result. Approval and apply remain outside MCP.\n");
    process.stdout.write(`${JSON.stringify(snippet, null, 2)}\n`);
  }
  return 0;
}


export async function mcpConfig(args: string[]): Promise<number> {
  const [client, ...rest] = args;
  if (!client || client.startsWith("--")) return mcpConfigure(["--client", "claude-desktop", ...args]);
  return mcpConfigure(["--client", normalizeMcpClientName(client) ?? client, ...rest]);
}


function normalizeMcpClientName(client: string | undefined): string | undefined {
  if (client === "claude") return "claude-desktop";
  return client;
}


type McpClientSnippetOptions = {
  transport: "stdio" | "streamable-http";
  aliasMode: ToolNameStyle;
  host: string;
  port: number;
  authTokenEnv: string;
  clientAccessTokenEnv: string;
  authMode: "opaque-static" | "signed-jwt";
  oauthResource?: string;
  authorizationServers?: string[];
};


function mcpClientConfigTransport(args: string[], client: string): "stdio" | "streamable-http" {
  const requested = optionalArg(args, "--transport") ?? (client === "openai-agents" ? "streamable-http" : "stdio");
  if (requested === "stdio" || requested === "streamable-http") return requested;
  if (requested === "http" || requested === "json-rpc-http" || requested === "jsonrpc-http") {
    throw new Error("mcp config uses stdio or streamable-http. The lightweight JSON-RPC HTTP bridge is not a standard MCP client transport.");
  }
  throw new Error("--transport must be stdio or streamable-http");
}


function mcpClientConfigAliasMode(args: string[], client: string): ToolNameStyle {
  const requested = optionalArg(args, "--alias-mode");
  const aliasMode = requested ?? (args.includes("--openai-tool-aliases") ? "openai" : client === "openai-agents" ? "openai" : "canonical");
  if (aliasMode === "canonical" || aliasMode === "openai" || aliasMode === "both") return aliasMode;
  throw new Error("--alias-mode must be canonical, openai, or both");
}


function serveArgsForClient(configPath: string, storePath: string, options: McpClientSnippetOptions): string[] {
  const args = options.transport === "streamable-http"
    ? [
      "mcp",
      "serve-streamable-http",
      "--config",
      configPath,
      "--store",
      storePath,
      "--host",
      options.host,
      "--port",
      String(options.port),
      ...(options.authMode === "opaque-static" ? ["--auth-token-env", options.authTokenEnv] : []),
    ]
    : ["mcp", "serve", "--config", configPath, "--store", storePath];
  if (options.aliasMode !== "canonical") args.push("--alias-mode", options.aliasMode);
  return args;
}


function mcpClientSnippet(client: string, configPath: string, storePath: string, options: McpClientSnippetOptions): Record<string, unknown> {
  const command = cliCommandName();
  const args = serveArgsForClient(configPath, storePath, options);
  if (client === "generic" || client === "generic-stdio") return { command, args };
  if (client === "claude-desktop" || client === "cursor") {
    if (options.transport !== "stdio") throw new Error(`${client} config output currently supports stdio. Use --transport stdio.`);
    return { mcpServers: { synapsor: { command, args } } };
  }
  if (client === "vscode") {
    if (options.transport !== "stdio") throw new Error("vscode config output currently supports stdio. Use --transport stdio.");
    return { servers: { synapsor: { type: "stdio", command, args } } };
  }
  if (client === "openai-agents") {
    if (options.transport !== "streamable-http") throw new Error("openai-agents config output uses Streamable HTTP. Use --transport streamable-http.");
    const externalProtectedResource = options.authMode === "signed-jwt" && Boolean(options.oauthResource);
    const url = externalProtectedResource ? options.oauthResource as string : `http://${options.host}:${options.port}/mcp`;
    return {
      transport: "streamable-http",
      ...(!externalProtectedResource ? { start_server: {
        command,
        args,
      } } : {}),
      openai_agents_sdk: {
        package: "openai-agents",
        url,
        headers_from_env: {
          Authorization: `Bearer $${options.clientAccessTokenEnv}`,
        },
        python: [
          "import os",
          "from agents.mcp import MCPServerStreamableHttp",
          "",
          "synapsor_mcp = MCPServerStreamableHttp(",
          `    params={`,
          `        "url": "${url}",`,
          `        "headers": {"Authorization": f"Bearer {os.environ['${options.clientAccessTokenEnv}']}"},`,
          "    }",
          ")",
        ].join("\n"),
      },
      authentication: {
        mode: options.authMode,
        bearer_presentation: true,
        client_access_token_env: options.clientAccessTokenEnv,
        ...(options.authMode === "opaque-static" ? {
          server_endpoint_token_env: options.authTokenEnv,
          provisioned_by: "operator_out_of_band",
        } : {
          protected_resource: options.oauthResource,
          authorization_servers: options.authorizationServers ?? [],
          provisioned_by: "configured_identity_provider",
        }),
        credential_value_embedded: false,
      },
      tool_names: {
        canonical: "billing.inspect_invoice",
        model_visible_with_alias_mode_openai: "billing__inspect_invoice",
        alias_mode: options.aliasMode,
      },
      notes: [
        externalProtectedResource
          ? "Connect to the already deployed HTTPS protected resource. Runner deployment, TLS/proxy configuration, and token issuance remain operator responsibilities."
          : "Start the local Streamable HTTP MCP server before creating the OpenAI Agents SDK server.",
        "OpenAI-facing configs should use --alias-mode openai because OpenAI function names cannot contain dots.",
        "Runner maps aliases back to canonical Synapsor capability names and includes the canonical name in MCP tool metadata.",
        options.authMode === "opaque-static"
          ? `The operator generates one high-entropy endpoint token and provisions it out of band to both server env ${options.authTokenEnv} and authorized client env ${options.clientAccessTokenEnv}. Runner does not issue it.`
          : `The configured identity provider issues a signed access token for the protected resource; place the short-lived client token in ${options.clientAccessTokenEnv}. Runner verifies it and never issues or refreshes it.`,
        "This config contains no database URLs, write credentials, API keys, bearer token values, client secrets, or refresh tokens.",
      ],
    };
  }
  throw new Error(`unsupported MCP client: ${client}`);
}


function mcpAgentInstructions(client: string, aliasMode: ToolNameStyle): Record<string, unknown> {
  const toolNameNote = aliasMode === "openai"
    ? "OpenAI-facing tool names may use aliases such as billing__inspect_invoice. Treat the canonical Synapsor capability name in tool metadata/results as the audit name."
    : "Use the model-visible Synapsor tool names exactly as listed by the MCP client.";
  return {
    target_client: client,
    alias_mode: aliasMode,
    recommended_system_prompt: [
      "Use Synapsor Runner tools in a propose-first pattern.",
      "Inspect relevant records, policy rows, and other evidence before proposing a change.",
      "Do not claim a database change was committed unless a result says source_database_changed: true.",
      "Proposal tools create reviewable proposals only; they do not commit writes.",
      "You cannot approve, apply, commit, or write back through model-facing MCP tools.",
      "On VERSION_CONFLICT, re-inspect the record before proposing again.",
      "Evidence handles are audit/replay handles; you do not need to call them during the turn.",
      toolNameNote,
    ].join(" "),
    checklist: [
      "Inspect evidence before proposing.",
      "Use trusted session scope; never ask the user/model for tenant or principal values.",
      "Report proposal ids and source_database_changed exactly from the tool result.",
      "If ok is false, follow error.code. On TEMPORARILY_UNAVAILABLE, retry later. On NOT_FOUND_IN_TENANT, do not infer cross-tenant existence.",
    ],
  };
}


export async function mcpSmoke(args: string[]): Promise<number> {
  const boundary = await inspectMcpToolBoundary(args);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ok: boundary.ok, config_path: boundary.configPath, store_path: boundary.storePath, tools: boundary.names, checks: boundary.checks }, null, 2)}\n`);
  } else {
    process.stdout.write(formatMcpSmoke(boundary));
  }
  return boundary.ok ? 0 : 1;
}


export async function smokeCall(args: string[]): Promise<number> {
  const call = await executeRuntimeToolCall(args);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({
      ok: call.ok,
      tool: call.tool,
      input: call.input,
      result: call.result,
      store_path: call.store_path,
      store_authority: call.store_authority,
      ...(call.shared_postgres_schema ? { shared_postgres_schema: call.shared_postgres_schema } : {}),
    }, null, 2)}\n`);
  } else {
    process.stdout.write(formatSmokeCallResult(call.tool, call.input, call.result, {
      configPath: call.config_path,
      storePath: call.store_path,
      storeAuthority: call.store_authority,
      sharedPostgresSchema: call.shared_postgres_schema ?? "synapsor_runner",
    }));
  }
  return call.ok ? 0 : 1;
}


type RuntimeToolCall = {
  ok: boolean;
  tool: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  config_path: string;
  store_path: string;
  store_authority: "local_sqlite" | "shared_postgres";
  shared_postgres_schema?: string;
  capability?: RuntimeCapabilityConfig;
};


export async function executeRuntimeToolCall(args: string[]): Promise<RuntimeToolCall> {
  const configPath = runnerConfigPath(args, defaultConfigPath);
  const storePath = resolvedLocalStorePath(args, undefined, defaultStorePath);
  const config = await readRuntimeConfig(configPath);
  const env = envWithDemoDefaults(config, configPath);
  await preflightGeneratedAuthority(config, env);
  const runtime = createMcpRuntime(config, { storePath, env });
  try {
    const tools = runtime.listTools();
    const requestedTool = firstPositional(args);
    const toolName = requestedTool ?? (tools.length === 1 ? tools[0]?.name : undefined);
    if (!toolName) {
      throw new Error(`smoke call needs <capability-name> because ${tools.length} tools are exposed: ${tools.map((tool) => tool.name).join(", ") || "none"}`);
    }
    const capability = (config.capabilities ?? []).find((item) => item.name === toolName);
    if (!capability && config.mode !== "cloud") throw new Error(`capability not found in ${configPath}: ${toolName}`);
    const input = capability ? await smokeToolInput(args, capability) : await smokeInputFromArgs(args);
    const result = await runtime.callTool(toolName, input);
    const ok = result.ok !== false;
    const storeAuthority = config.storage?.shared_postgres?.mode === "runtime_store" ? "shared_postgres" : "local_sqlite";
    return {
      ok,
      tool: toolName,
      input,
      result,
      config_path: configPath,
      store_path: storePath,
      store_authority: storeAuthority,
      ...(storeAuthority === "shared_postgres"
        ? { shared_postgres_schema: config.storage?.shared_postgres?.schema ?? "synapsor_runner" }
        : {}),
      ...(capability ? { capability } : {}),
    };
  } finally {
    await runtime.close();
  }
}


export async function toolsPreview(args: string[]): Promise<number> {
  const boundary = await inspectMcpToolBoundary(args);
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({
      ok: boundary.ok,
      config_path: boundary.configPath,
      store_path: boundary.storePath,
      alias_mode: boundary.aliasMode,
      auto_approval: boundary.autoApprovalDisabled ? "disabled" : "enabled",
      exposed_to_mcp: boundary.names,
      alias_mappings: boundary.exposures,
      approval_policies: boundary.approvalPolicies,
      capability_details: boundary.capabilityDetails,
      isolation: boundary.isolation,
      not_exposed_to_mcp: defaultBlockedToolSurface(),
      graduated_trust: boundary.graduatedTrust,
      checks: boundary.checks,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(formatToolsPreview(boundary));
  }
  return boundary.ok ? 0 : 1;
}


export async function inspectMcpToolBoundary(args: string[]): Promise<{
  ok: boolean;
  configPath: string;
  storePath: string;
  aliasMode: ToolNameStyle;
  names: string[];
  exposures: Array<{ canonicalName: string; exposedName: string; isAlias: boolean; style: ToolNameStyle }>;
  autoApprovalDisabled: boolean;
  approvalPolicies: Array<{ capability: string; policy: string; limits: unknown[] }>;
  capabilityDetails: ToolPreviewCapabilityDetail[];
  isolation: SourceIsolationAssurance[];
  governance: LocalDoctorGovernance;
  graduatedTrust: { enabled: boolean; kill_switch: boolean; criteria: number; model_facing: false };
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}> {
  const configPath = runnerConfigPath(args, "./synapsor.runner.json");
  const storePath = resolvedLocalStorePath(args);
  const aliasMode = args.includes("--aliases") && !optionalArg(args, "--alias-mode") && !optionalArg(args, "--tool-name-style")
    ? "both"
    : toolNameStyleOption(args);
  if (!await fileExists(configPath)) {
    throw new Error(`MCP tool preview could not find ${configPath}.\n\nWhy it matters:\nThe MCP server needs a reviewed config before it can expose semantic tools.\n\nFix:\nRun ${cliCommandName()} onboard db --from-env DATABASE_URL, or pass --config <path>.`);
  }
  const parsed = await readRuntimeConfig(configPath);
  const runtime = createMcpRuntime(parsed, { storePath });
  try {
    const tools = runtime.listTools();
    const autoApprovalDisabled = parsed.approvals?.disable_auto_approval === true;
    const approvalPolicies = approvalPolicySummaries(parsed);
    const capabilityDetails = toolPreviewCapabilityDetails(parsed);
    const isolation = describeIsolationAssurance(parsed);
    const cloudSync = await runtime.cloudSyncStatus();
    const governance: LocalDoctorGovernance = {
      ...cloudSync,
      queue_when_unavailable: parsed.governance?.mode === "cloud_linked" && parsed.governance.queue_when_unavailable !== false,
    };
    const graduatedTrust = {
      enabled: parsed.graduated_trust?.enabled === true,
      kill_switch: parsed.graduated_trust?.kill_switch === true,
      criteria: parsed.graduated_trust?.criteria?.length ?? 0,
      model_facing: false as const,
    };
    const exposures = toolNameExposures(tools.map((tool) => tool.name), aliasMode);
    const names = exposures.map((item) => item.exposedName);
    const serialized = JSON.stringify(tools);
    const checks = [
      { name: "semantic tools present", ok: names.length > 0, detail: names.join(", ") || "none" },
      { name: "execute_sql absent", ok: !names.some((name) => /execute_sql|run_query|query_database/i.test(name)), detail: "model does not receive raw SQL tools" },
      { name: "approval tools absent", ok: !names.some((name) => /approve/i.test(name)), detail: "approval stays outside MCP" },
      { name: "policy recommendation tools absent", ok: !names.some((name) => /policy.*recommend|recommend.*policy|activate.*policy/i.test(name)), detail: "graduated-trust evaluation, review, export, and activation stay outside MCP" },
      { name: "commit tools absent", ok: !names.some((name) => /commit|apply_writeback/i.test(name)), detail: "commit stays outside MCP" },
      { name: "database_url absent", ok: !/postgres(?:ql)?:\/\/|mysql:\/\//i.test(serialized), detail: "MCP config uses env var names, not connection strings" },
      { name: "write credentials absent", ok: !/(password|secret|bearer|private[_-]?key|token)/i.test(serialized), detail: "MCP tools do not include write credentials" },
    ];
    const ok = checks.every((check) => check.ok);
    return { ok, configPath, storePath, aliasMode, names, exposures, autoApprovalDisabled, approvalPolicies, capabilityDetails, isolation, governance, graduatedTrust, checks };
  } finally {
    await runtime.close();
  }
}


export function defaultBlockedToolSurface(): string[] {
  return [
    "execute_sql / raw query tools",
    "approval tools",
    "policy recommendation/review/activation tools",
    "commit/apply tools",
    "database URLs",
    "write credentials",
    "model-controlled tenant authority",
    "arbitrary table or column names",
  ];
}


function formatToolsPreview(input: {
  ok: boolean;
  configPath: string;
  storePath: string;
  aliasMode: ToolNameStyle;
  names: string[];
  exposures: Array<{ canonicalName: string; exposedName: string; isAlias: boolean; style: ToolNameStyle }>;
  autoApprovalDisabled: boolean;
  approvalPolicies: Array<{ capability: string; policy: string; limits: unknown[] }>;
  capabilityDetails: ToolPreviewCapabilityDetail[];
  isolation: SourceIsolationAssurance[];
  governance: LocalDoctorGovernance;
  graduatedTrust: { enabled: boolean; kill_switch: boolean; criteria: number; model_facing: false };
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}): string {
  const exposedLines = input.exposures.length > 0
    ? input.exposures.map((item) => item.isAlias ? `  - ${item.exposedName} -> ${item.canonicalName}` : `  - ${item.exposedName}`)
    : ["  - (none)"];
  const lines = [
    `Synapsor tools preview: ${input.ok ? "ok" : "failed"}`,
    `Config: ${input.configPath}`,
    `Store: ${input.storePath}`,
    `Alias mode: ${input.aliasMode}`,
    `Governance authority: ${input.governance.authority_mode}`,
    `Evidence residency: ${input.governance.evidence_residency}`,
    ...(input.governance.authority_mode === "cloud_linked"
      ? [`Queue proposals while Cloud is unavailable: ${input.governance.queue_when_unavailable ? "yes" : "no"}`]
      : []),
    `auto-approval: ${input.autoApprovalDisabled ? "disabled" : "enabled"}`,
    `graduated trust: ${input.graduatedTrust.enabled ? input.graduatedTrust.kill_switch ? "enabled, kill switch active" : `enabled (${input.graduatedTrust.criteria} reviewed criteria)` : "disabled"}; operator-only, never MCP-facing`,
    "",
    "Tenant isolation:",
    ...input.isolation.flatMap((assurance) => [
      `  - ${assurance.source}: ${assurance.mode}; trusted context ${assurance.trusted_context.request_binding}`,
      `    remaining boundary: ${assurance.remaining_trust_boundary}`,
      ...(assurance.warning ? [`    WARNING: ${assurance.warning}`] : []),
    ]),
    ...formatApprovalPolicyPreview(input.approvalPolicies),
    "",
    "Exposed to MCP:",
    ...exposedLines,
    "",
    "Reviewed capability boundary:",
    ...formatToolPreviewCapabilityDetails(input.capabilityDetails),
    "",
    "Not exposed to MCP:",
    ...defaultBlockedToolSurface().map((name) => `  - ${name}`),
    "",
    "Safety checks:",
  ];
  for (const check of input.checks) {
    lines.push(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
    lines.push(`  ${check.detail}`);
  }
  lines.push("");
  lines.push("Next:");
  lines.push(`  ${cliCommandName()} mcp serve --config ${input.configPath} --store ${input.storePath}`);
  return `${lines.join("\n")}\n`;
}


type ToolPreviewCapabilityDetail = {
  name: string;
  kind: "read" | "aggregate_read" | "proposal";
  operation?: "update" | "insert" | "delete";
  cardinality?: "single" | "set";
  target: string;
  tenant_source: string;
  principal_source?: string;
  writable_columns: string[];
  dedup_columns: string[];
  fixed_selection: string[];
  aggregate_bounds: string[];
  version_guard?: string;
  conflict_guard?: {
    mode: "exact_version_column" | "weak_projection_hash";
    column?: string;
    assurance: string;
    warning?: string;
  };
  version_advance?: string;
  receipt_mode?: string;
  reversibility?: string;
  approval: string;
  max_rows: number;
  aggregate?: string;
  minimum_group_size?: number;
  protected_aggregate?: boolean;
  aggregate_dimensions?: string[];
};


function formatProtectedPredicate(
  predicate: NonNullable<NonNullable<RuntimeCapabilityConfig["protected_read"]>["predicates"]>[number],
): string {
  const field = `${predicate.relationship ? `${predicate.relationship}.` : ""}${predicate.field}`;
  if (predicate.operator === "in") return `${field} in (${predicate.values.map(formatScalar).join(", ")})`;
  const value = "fixed" in predicate.value
    ? formatScalar(predicate.value.fixed)
    : `arg:${predicate.value.from_arg}`;
  return `${field} ${predicate.operator} ${value}`;
}


function toolPreviewCapabilityDetails(config: RuntimeConfig): ToolPreviewCapabilityDetail[] {
  return (config.capabilities ?? []).map((capability) => {
    const context = capability.context ? config.contexts?.[capability.context] : config.trusted_context;
    const operation = capability.kind === "proposal" ? capabilityOperation(capability) : undefined;
    const cardinality = capability.kind === "proposal" ? capability.operation?.cardinality ?? "single" : undefined;
    return {
      name: capability.name,
      kind: capability.kind,
      operation,
      cardinality,
      target: `${capability.target.schema}.${capability.target.table}`,
      tenant_source: capability.target.single_tenant_dev
        ? "explicit single-tenant development acknowledgement"
        : `${capability.target.tenant_key ?? "missing tenant key"} from trusted ${context?.provider ?? "context"}`,
      ...(capability.target.principal_scope_key ? {
        principal_source: `${capability.target.principal_scope_key} from required trusted ${context?.provider ?? "context"} binding ${context?.principal_binding ?? "principal"}`,
      } : {}),
      writable_columns: capability.allowed_columns ?? [],
      dedup_columns: capability.operation?.deduplication?.components.map((component) => component.column) ?? [],
      fixed_selection: capability.protected_read?.predicates?.map(formatProtectedPredicate)
        ?? (capability.operation?.selection?.all ?? capability.aggregate?.selection?.all)?.map((term) => `${term.column} ${term.operator} ${formatScalar(term.value)}`)
        ?? [],
      aggregate_bounds: capability.operation?.aggregate_bounds?.map((bound) => `${bound.measure}(${bound.column}) <= ${bound.maximum}`) ?? [],
      version_guard: capability.conflict_guard?.column,
      ...(capability.kind === "proposal" && capability.conflict_guard?.column ? {
        conflict_guard: {
          mode: "exact_version_column" as const,
          column: capability.conflict_guard.column,
          assurance: "apply must match the reviewed source version exactly",
        },
      } : capability.kind === "proposal" && capability.conflict_guard?.weak_guard_ack === true ? {
        conflict_guard: {
          mode: "weak_projection_hash" as const,
          assurance: "apply compares a hash of the captured projection",
          warning: "may miss concurrent changes outside the captured projection; prefer an exact version column",
        },
      } : {}),
      version_advance: capability.operation?.version_advance
        ? `${capability.operation.version_advance.column}:${capability.operation.version_advance.strategy}`
        : undefined,
      receipt_mode: capability.kind === "proposal" ? formatSourceReceiptMode(config.sources?.[capability.source]) : undefined,
      reversibility: capability.kind === "proposal"
        ? capability.reversibility?.mode === "reviewed_inverse"
          ? capabilityOperation(capability) === "delete"
            ? "best-effort unavailable for hard DELETE"
            : "reviewed compensation proposal available after an unambiguous applied receipt"
          : "not configured"
        : undefined,
      approval: capability.kind === "proposal"
        ? `${capability.approval?.mode ?? "human"}${capability.approval?.required_role ? ` role=${capability.approval.required_role}` : ""} quorum=${capability.approval?.required_approvals ?? 1}`
        : "not applicable",
      max_rows: capability.protected_read?.mode === "aggregate"
        ? capability.protected_read.limits.max_groups
        : capability.kind === "aggregate_read"
          ? 0
          : cardinality === "set"
            ? capability.operation?.max_rows ?? 0
            : capability.max_rows ?? 1,
      aggregate: capability.aggregate
        ? `${capability.aggregate.function.toUpperCase()}(${capability.aggregate.function === "count" && capability.aggregate.count_mode !== "non_null" ? "*" : capability.aggregate.column})`
        : capability.protected_read?.mode === "aggregate"
          ? capability.protected_read.aggregate?.measures
            .map((measure) => `${measure.function.toUpperCase()}(${measure.field ?? "*"}) AS ${measure.name}`)
            .join(", ")
        : undefined,
      minimum_group_size: capability.aggregate?.minimum_group_size
        ?? capability.protected_read?.aggregate?.minimum_group_size,
      protected_aggregate: capability.protected_read?.mode === "aggregate",
      aggregate_dimensions: capability.protected_read?.mode === "aggregate"
        ? [
          ...(capability.protected_read.aggregate?.dimensions?.map((dimension) => dimension.name) ?? []),
          ...(capability.protected_read.aggregate?.time_bucket
            ? [capability.protected_read.aggregate.time_bucket.name]
            : []),
        ]
        : undefined,
    };
  });
}


function formatToolPreviewCapabilityDetails(details: ToolPreviewCapabilityDetail[]): string[] {
  if (details.length === 0) return ["  - (none)"];
  return details.flatMap((detail) => [
    `  - ${detail.name}: ${detail.kind}${detail.operation ? ` ${detail.cardinality === "set" ? "BOUNDED SET " : "SINGLE-ROW "}${detail.operation.toUpperCase()}` : ""}`,
    detail.kind === "aggregate_read" && detail.protected_aggregate
      ? `    target: ${detail.target}; reviewed measures: ${detail.aggregate}; dimensions: ${detail.aggregate_dimensions?.join(", ") || "none"}; max groups: ${detail.max_rows}; minimum group size: ${detail.minimum_group_size}`
      : detail.kind === "aggregate_read"
        ? `    target: ${detail.target}; output: one ${detail.aggregate} scalar; minimum group size: ${detail.minimum_group_size}`
      : `    target: ${detail.target}; max rows: ${detail.max_rows}`,
    `    tenant: ${detail.tenant_source}`,
    ...(detail.principal_source ? [`    principal row lock: ${detail.principal_source} (AND tenant)`] : []),
    ...(detail.kind === "aggregate_read" ? [
      `    fixed selection: ${detail.fixed_selection.join(" AND ") || "tenant scope only"}`,
      "    privacy: member rows and identities are never returned or stored as evidence items",
    ] : []),
    ...(detail.kind === "proposal" ? [
      `    writable columns: ${detail.writable_columns.join(", ") || "none"}`,
      `    dedup: ${detail.dedup_columns.join(", ") || "not applicable"}`,
      ...(detail.cardinality === "set" ? [
        `    fixed selection: ${detail.fixed_selection.join(" AND ") || "exact reviewed batch items"}`,
        `    aggregate bounds: ${detail.aggregate_bounds.join("; ") || "missing"}`,
        "    set approval: human/operator required; policy auto-approval unavailable",
      ] : []),
      `    conflict guard: ${detail.conflict_guard?.mode === "exact_version_column" ? `exact version column ${detail.conflict_guard.column}` : detail.conflict_guard?.mode === "weak_projection_hash" ? "WEAK projection hash (explicitly acknowledged)" : "not applicable"}${detail.version_advance ? `; advance: ${detail.version_advance}` : ""}`,
      ...(detail.conflict_guard?.assurance ? [`    concurrency assurance: ${detail.conflict_guard.assurance}`] : []),
      ...(detail.conflict_guard?.warning ? [`    WARNING: ${detail.conflict_guard.warning}`] : []),
      `    receipts: ${detail.receipt_mode ?? "not configured"}; approval: ${detail.approval}`,
      `    reversibility: ${detail.reversibility ?? "not applicable"}`,
    ] : []),
  ]);
}


function approvalPolicySummaries(config: RuntimeConfig): Array<{ capability: string; policy: string; limits: unknown[] }> {
  const policies = new Map((config.policies ?? []).map((policy) => [policy.name, policy]));
  return (config.capabilities ?? []).flatMap((capability) => {
    const policyName = capability.approval?.mode === "policy" ? capability.approval.policy : undefined;
    if (!policyName) return [];
    return [{ capability: capability.name, policy: policyName, limits: policies.get(policyName)?.limits ?? [] }];
  });
}


function formatApprovalPolicyPreview(policies: Array<{ capability: string; policy: string; limits: unknown[] }>): string[] {
  if (policies.length === 0) return [];
  const lines = ["", "Reviewed auto-approval policies:"];
  for (const item of policies) {
    lines.push(`  - ${item.capability}: ${item.policy}`);
    if (item.limits.length === 0) lines.push("    aggregate limits: none (do not schedule unattended batch apply)");
    for (const raw of item.limits) {
      if (!isRecord(raw)) continue;
      const scope = raw.scope === "tenant_policy_object" ? "tenant + policy + object" : "tenant + policy";
      const description = raw.kind === "total"
        ? `total ${String(raw.field)} <= ${String(raw.max)}`
        : `count <= ${String(raw.max)}`;
      lines.push(`    ${description} per ${String(raw.period)} (${scope})`);
    }
  }
  return lines;
}


function formatMcpSmoke(input: {
  ok: boolean;
  configPath: string;
  storePath: string;
  names: string[];
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}): string {
  const lines = [
    `Synapsor MCP smoke: ${input.ok ? "ok" : "failed"}`,
    `Config: ${input.configPath}`,
    `Store: ${input.storePath}`,
    "",
    "Tools the model would see:",
    ...input.names.map((name) => `  - ${name}`),
    "",
  ];
  for (const check of input.checks) {
    lines.push(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
    lines.push(`  ${check.detail}`);
  }
  return `${lines.join("\n")}\n`;
}


async function smokeToolInput(args: string[], capability: RuntimeCapabilityConfig): Promise<Record<string, unknown>> {
  if (!args.includes("--sample") && !optionalArg(args, "--input") && !optionalArg(args, "--json")) {
    return sampleInputForCapability(capability);
  }
  return await smokeInputFromArgs(args, capability);
}


async function smokeInputFromArgs(args: string[], capability?: RuntimeCapabilityConfig): Promise<Record<string, unknown>> {
  const jsonInput = optionalArg(args, "--json");
  const inputPath = optionalArg(args, "--input");
  const sample = args.includes("--sample");
  const selected = [Boolean(jsonInput), Boolean(inputPath), sample].filter(Boolean).length;
  if (selected > 1) throw new Error("smoke call accepts only one of --sample, --input, or --json");
  if (jsonInput) {
    const parsed = JSON.parse(jsonInput);
    if (!isRecord(parsed)) throw new Error("smoke call --json must be a JSON object");
    return parsed;
  }
  if (inputPath) {
    const parsed = JSON.parse(await fs.readFile(inputPath, "utf8"));
    if (!isRecord(parsed)) throw new Error("smoke call --input must point to a JSON object");
    return parsed;
  }
  if (sample && capability) return sampleInputForCapability(capability);
  if (sample) return {};
  return {};
}


async function writeMcpClientSnippet(destination: string, client: string, snippet: Record<string, unknown>, yes: boolean): Promise<void> {
  const resolved = path.resolve(destination);
  let existing: Record<string, unknown> = {};
  let hadExisting = false;
  try {
    existing = JSON.parse(await fs.readFile(resolved, "utf8")) as Record<string, unknown>;
    hadExisting = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const merged = mergeMcpClientSnippet(client, existing, snippet);
  JSON.parse(JSON.stringify(merged));
  process.stderr.write(`Destination: ${resolved}\n`);
  if (hadExisting) {
    process.stderr.write("Existing file will be backed up before writing.\n");
  }
  await confirmDangerousAction(yes ? ["--yes"] : [], "Write MCP client configuration?");
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  if (hadExisting) {
    const backupPath = `${resolved}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
    await fs.copyFile(resolved, backupPath);
    process.stderr.write(`Backup: ${backupPath}\n`);
  }
  await fs.writeFile(resolved, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
}


function mergeMcpClientSnippet(client: string, existing: Record<string, unknown>, snippet: Record<string, unknown>): Record<string, unknown> {
  if (client === "generic" || client === "generic-stdio") return snippet;
  if (client === "claude-desktop" || client === "cursor") {
    const existingServers = isRecord(existing.mcpServers) ? existing.mcpServers : {};
    const snippetServers = isRecord(snippet.mcpServers) ? snippet.mcpServers : {};
    return { ...existing, mcpServers: { ...existingServers, ...snippetServers } };
  }
  if (client === "vscode") {
    const existingServers = isRecord(existing.servers) ? existing.servers : {};
    const snippetServers = isRecord(snippet.servers) ? snippet.servers : {};
    return { ...existing, servers: { ...existingServers, ...snippetServers } };
  }
  throw new Error(`unsupported MCP client: ${client}`);
}
