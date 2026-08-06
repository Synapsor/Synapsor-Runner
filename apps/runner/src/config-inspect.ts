import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import {
  inspectDatabase,
  rolePostureFingerprint,
  type InspectEngine,
  type SchemaInspection
} from "@synapsor-runner/schema-inspector";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";
import { writeFileGuarded } from "./cli-files.js";
import { usage } from "./cli-help.js";
import { assertKnownOptions, optionalArg, outputArg } from "./cli-options.js";
import { databaseInputFromArgs } from "./cli-project.js";
import { configMigrate, configShow, configValidate } from "./contract-commands.js";
import { inferPrimaryKeyCandidate } from "./onboarding.js";
import {
  DEFAULT_GENERATED_DIR,
  type ExplorationBoundaryDraft,
  type GenerationLock,
} from "./auto-boundary.js";


export async function inspect(args: string[]): Promise<number> {
  const databaseInput = databaseInputFromArgs(args, { implyDatabaseUrl: true });
  const engine = (optionalArg(args, "--engine") ?? "auto") as InspectEngine;
  if (!["postgres", "mysql", "auto"].includes(engine)) {
    throw new Error("inspect --engine must be postgres, mysql, or auto.");
  }
  const inspection = await inspectDatabase({
    engine,
    databaseUrlEnv: databaseInput.inspectionDatabaseUrlEnv,
    schema: optionalArg(args, "--schema"),
    env: databaseInput.env,
  });
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify({
      ...inspection,
      role_posture_fingerprint: rolePostureFingerprint(inspection),
    }, null, 2)}\n`);
  } else {
    if (databaseInput.inlineUrl) {
      process.stderr.write("Tip: prefer `--from-env DATABASE_URL` for reusable setup so connection strings do not land in shell history.\n");
    }
    process.stdout.write(formatSchemaInspectionForCli(inspection, databaseInput.configDatabaseUrlEnv));
  }
  return 0;
}


function formatSchemaInspectionForCli(inspection: SchemaInspection, databaseUrlEnv: string): string {
  const lines = [
    "Synapsor schema inspection",
    `Engine: ${inspection.engine}`,
    `Server: ${inspection.server_version}`,
    `Current user: ${inspection.current_user}`,
    `Role posture fingerprint: ${rolePostureFingerprint(inspection)}`,
    `Schemas: ${inspection.schemas.join(", ") || "(none)"}`,
    "",
    `Found ${inspection.tables.length} tables/views:`,
  ];
  for (const table of inspection.tables) {
    lines.push(`- ${table.schema}.${table.name} (${table.type})`);
    const primaryKeyCandidate = inferPrimaryKeyCandidate(table);
    lines.push(`  primary key: ${table.primary_key.join(", ") || (primaryKeyCandidate ? `not detected; candidate: ${primaryKeyCandidate}` : "not detected")}`);
    lines.push(`  possible tenant/scope columns: ${table.suggestions.tenant_columns.join(", ") || "not detected"}`);
    lines.push(`  possible conflict/version columns: ${table.suggestions.conflict_columns.join(", ") || "not detected"}`);
    lines.push(`  fields suggested for review: ${table.suggestions.sensitive_columns.join(", ") || "none"}`);
    lines.push(`  suggested visible fields: ${table.suggestions.default_visible_columns.slice(0, 12).join(", ") || "none"}`);
  }
  if (inspection.warnings.length) {
    lines.push("");
    lines.push("Warnings:");
    for (const warning of inspection.warnings) lines.push(`! ${warning}`);
  }
  lines.push("");
  lines.push("Next:");
  lines.push(`  ${cliCommandName()} onboard db --from-env ${databaseUrlEnv}`);
  lines.push(`  ${cliCommandName()} tools preview --config ./synapsor.runner.json --store ./.synapsor/local.db`);
  return `${lines.join("\n")}\n`;
}


export async function configCommand(args: string[]): Promise<number> {
  const [subcommand] = args;
  if (subcommand === "init") return configInit(args.slice(1));
  if (subcommand === "validate") return configValidate(args.slice(1));
  if (subcommand === "show") return configShow(args.slice(1));
  if (subcommand === "migrate") return configMigrate(args.slice(1));
  usage();
  return 2;
}


async function configInit(args: string[]): Promise<number> {
  assertKnownOptions(
    args,
    new Set([
      "--output", "--out", "-o", "--engine", "--read-url-env", "--source", "--json",
      "--production-explore", "--project-root", "--tenant-claim", "--principal-claim",
      "--single-tenant-organization-id",
      "--issuer", "--audience", "--accounting-namespace", "--oauth-scope",
      "--control-url-env", "--jwks-url-env", "--hmac-key-env", "--http-channel",
    ]),
    "config init",
  );
  const output = outputArg(args) ?? "synapsor.runner.json";
  const productionExplore = args.includes("--production-explore");
  const projectRootValue = optionalArg(args, "--project-root") ?? ".";
  const projectRoot = path.resolve(projectRootValue);
  const drafted = productionExplore ? await readProductionExploreDraft(projectRoot) : undefined;
  const engine = optionalArg(args, "--engine") ?? drafted?.lock.engine ?? "postgres";
  if (engine !== "postgres" && engine !== "mysql") {
    throw new Error("config init --engine must be postgres or mysql.");
  }
  const source = optionalArg(args, "--source") ?? drafted?.boundary.source ?? `local_${engine}`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(source)) {
    throw new Error("config init --source must be a safe identifier.");
  }
  const readUrlEnv = optionalArg(args, "--read-url-env") ?? drafted?.lock.source_env ?? "DATABASE_URL";
  if (!isEnvironmentName(readUrlEnv)) {
    throw new Error("config init --read-url-env must name an environment variable, not contain a URL.");
  }
  if (drafted) {
    if (drafted.boundary.deployment_profile !== "production"
      || drafted.boundary.trusted_context.provider !== "http_claims") {
      throw new Error(`The draft at ${path.join(projectRoot, DEFAULT_GENERATED_DIR)} is not a production HTTP-claims boundary.`);
    }
    if (engine !== drafted.lock.engine || source !== drafted.boundary.source || readUrlEnv !== drafted.lock.source_env) {
      throw new Error("Production config source options must match the generated boundary source, engine, and read credential environment name exactly.");
    }
    const reviewedTenantClaim = productionClaim(drafted.boundary, "tenant");
    const reviewedPrincipalClaim = productionClaim(drafted.boundary, "principal");
    const requestedTenantClaim = optionalArg(args, "--tenant-claim");
    const requestedPrincipalClaim = optionalArg(args, "--principal-claim");
    const requestedOrganizationId = optionalArg(args, "--single-tenant-organization-id");
    if (requestedTenantClaim && requestedTenantClaim !== reviewedTenantClaim) {
      throw new Error(
        `Production config --tenant-claim ${requestedTenantClaim} must match the reviewed boundary claim ${reviewedTenantClaim} exactly. Regenerate and review the boundary to change it.`,
      );
    }
    if (requestedPrincipalClaim && requestedPrincipalClaim !== reviewedPrincipalClaim) {
      throw new Error(
        `Production config --principal-claim ${requestedPrincipalClaim} must match the reviewed boundary claim ${reviewedPrincipalClaim} exactly. Regenerate and review the boundary to change it.`,
      );
    }
    const reviewedOrganizationId = drafted.boundary.organization_scope?.organization_id;
    if (requestedOrganizationId && requestedOrganizationId !== reviewedOrganizationId) {
      throw new Error(
        `Production config organization id ${requestedOrganizationId} must match the reviewed boundary organization ${reviewedOrganizationId ?? "(none)"} exactly. Regenerate and review the boundary to change it.`,
      );
    }
  }
  const config = productionExplore
    ? productionExploreConfigTemplate({
      projectRoot: projectRootValue,
      engine,
      source,
      readUrlEnv,
      tenantClaim: optionalArg(args, "--tenant-claim") ?? productionClaim(drafted?.boundary, "tenant"),
      principalClaim: optionalArg(args, "--principal-claim") ?? productionClaim(drafted?.boundary, "principal"),
      singleOrganizationId: optionalArg(args, "--single-tenant-organization-id")
        ?? drafted?.boundary.organization_scope?.organization_id,
      issuer: optionalArg(args, "--issuer"),
      audience: optionalArg(args, "--audience"),
      accountingNamespace: optionalArg(args, "--accounting-namespace"),
      oauthScope: optionalArg(args, "--oauth-scope") ?? "synapsor.explore",
      controlUrlEnv: optionalArg(args, "--control-url-env") ?? "SYNAPSOR_CONTROL_DATABASE_URL",
      jwksUrlEnv: optionalArg(args, "--jwks-url-env") ?? "SYNAPSOR_SESSION_JWKS_URL",
      hmacKeyEnv: optionalArg(args, "--hmac-key-env") ?? "SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY",
      httpChannel: optionalArg(args, "--http-channel") ?? "trusted_tls_proxy",
    })
    : {
    version: 1,
    mode: "read_only",
    storage: { sqlite_path: "./.synapsor/local.db" },
    sources: {
      [source]: {
        engine,
        read_url_env: readUrlEnv,
        read_only: true,
        statement_timeout_ms: 3000,
      },
    },
    trusted_context: {
      provider: "environment",
      values: {
        tenant_id_env: "SYNAPSOR_TENANT_ID",
        principal_env: "SYNAPSOR_PRINCIPAL",
      },
      tenant_binding: "tenant_id",
      principal_binding: "principal",
    },
    capabilities: [],
    strict: true,
    result_format: 2,
  };
  const validation = validateRunnerCapabilityConfig(config);
  if (!validation.ok) {
    throw new Error(`Internal config-init validation failed: ${validation.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
  }
  await writeFileGuarded(output, `${JSON.stringify(config, null, 2)}\n`, false);
  const parsed = JSON.parse(await fs.readFile(output, "utf8"));
  const writtenValidation = validateRunnerCapabilityConfig(parsed);
  if (!writtenValidation.ok) {
    await fs.rm(output, { force: true });
    throw new Error(`Written config did not validate: ${writtenValidation.errors.map((issue) => issue.code).join(", ")}`);
  }
  const result = {
    ok: true,
    config_path: path.resolve(output),
    mode: "read_only",
    active_capabilities: 0,
    ...(productionExplore ? { profile: "production_explore" } : {}),
    source,
    engine,
    read_url_env: readUrlEnv,
    source_database_changed: false,
    next_action: productionExplore
      ? `Set the referenced secrets, initialize the shared control store, then run ${cliCommandName()} doctor --config ${path.resolve(output)} --transport streamable-http.`
      : `Run ${cliCommandName()} start --from-env ${readUrlEnv} to draft a reviewed boundary, or author capabilities manually.`,
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write([
      `Created valid zero-authority ${productionExplore ? "production Explore " : ""}Runner config: ${result.config_path}`,
      `Mode: ${result.mode}`,
      `Database credential reference: ${readUrlEnv} (value was not read or written)`,
      ...(productionExplore
        ? [
          "Generated: shared control store, asymmetric JWT claims, secured HTTP, OAuth scope, tenant ceilings, and bounded source/session pools.",
          "Secret values were not read or written. Generate the shared HMAC key from at least 32 random bytes; do not use a 32-character hex key.",
        ]
        : []),
      "Agent authority active: no",
      "Source database changed: no",
      `Next: ${result.next_action}`,
      "",
    ].join("\n"));
  }
  return 0;
}

type ProductionExploreDraftContext = {
  boundary: ExplorationBoundaryDraft;
  lock: GenerationLock;
};

async function readProductionExploreDraft(projectRoot: string): Promise<ProductionExploreDraftContext | undefined> {
  const boundaryPath = path.join(projectRoot, DEFAULT_GENERATED_DIR, "exploration-boundary.draft.json");
  const lockPath = path.join(projectRoot, ".synapsor", "generation-lock.json");
  try {
    const [boundary, lock] = await Promise.all([
      fs.readFile(boundaryPath, "utf8"),
      fs.readFile(lockPath, "utf8"),
    ]);
    return {
      boundary: JSON.parse(boundary) as ExplorationBoundaryDraft,
      lock: JSON.parse(lock) as GenerationLock,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function productionClaim(
  boundary: ExplorationBoundaryDraft | undefined,
  kind: "tenant" | "principal",
): string | undefined {
  if (boundary?.trusted_context.provider !== "http_claims") return undefined;
  return kind === "tenant"
    ? boundary.trusted_context.tenant_claim
    : boundary.trusted_context.principal_claim;
}

function productionExploreConfigTemplate(input: {
  projectRoot: string;
  engine: "postgres" | "mysql";
  source: string;
  readUrlEnv: string;
  tenantClaim?: string;
  principalClaim?: string;
  singleOrganizationId?: string;
  issuer?: string;
  audience?: string;
  accountingNamespace?: string;
  oauthScope: string;
  controlUrlEnv: string;
  jwksUrlEnv: string;
  hmacKeyEnv: string;
  httpChannel: string;
}): Record<string, unknown> {
  if (!input.singleOrganizationId
    && (!input.tenantClaim || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.tenantClaim))) {
    throw new Error("config init --production-explore requires --tenant-claim <claim>, or a production boundary draft containing that reviewed claim binding.");
  }
  if (input.singleOrganizationId
    && !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(input.singleOrganizationId)) {
    throw new Error("config init --production-explore --single-tenant-organization-id must be a stable 1-128 character organization label.");
  }
  if (input.singleOrganizationId && input.tenantClaim) {
    throw new Error("Single-organization production Explore must not configure a tenant claim.");
  }
  if (!input.principalClaim || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(input.principalClaim)) {
    throw new Error("config init --production-explore requires --principal-claim <claim>, or a production boundary draft containing that reviewed claim binding.");
  }
  const issuer = exactHttpsUrl(input.issuer, "--issuer");
  const audience = exactHttpsUrl(input.audience, "--audience");
  if (!input.accountingNamespace || !/^[a-z][a-z0-9_.:-]{0,127}$/.test(input.accountingNamespace)) {
    throw new Error("config init --production-explore requires --accounting-namespace <stable-lower-case-name>, for example acme.analytics.production.");
  }
  if (!/^[A-Za-z0-9._~:+/-]+$/.test(input.oauthScope)) {
    throw new Error("config init --production-explore --oauth-scope must be one valid OAuth scope, for example synapsor.explore.");
  }
  for (const [option, value] of [
    ["--control-url-env", input.controlUrlEnv],
    ["--jwks-url-env", input.jwksUrlEnv],
    ["--hmac-key-env", input.hmacKeyEnv],
  ] as const) {
    if (!isEnvironmentName(value)) throw new Error(`config init --production-explore ${option} must name an environment variable.`);
  }
  if (input.httpChannel !== "trusted_tls_proxy" && input.httpChannel !== "direct_tls") {
    throw new Error("config init --production-explore --http-channel must be trusted_tls_proxy or direct_tls.");
  }
  const audienceUrl = new URL(audience);
  return {
    version: 1,
    mode: "read_only",
    storage: {
      shared_postgres: {
        mode: "runtime_store",
        url_env: input.controlUrlEnv,
        schema: "synapsor_runner",
      },
    },
    sources: {
      [input.source]: {
        engine: input.engine,
        read_url_env: input.readUrlEnv,
        read_only: true,
        statement_timeout_ms: 3000,
      },
    },
    trusted_context: { provider: "http_claims" },
    session_auth: {
      provider: "jwt_asymmetric",
      algorithms: ["RS256"],
      jwks_url_env: input.jwksUrlEnv,
      issuer,
      audience,
      ...(input.tenantClaim ? { tenant_claim: input.tenantClaim } : {}),
      principal_claim: input.principalClaim,
    },
    http_security: {
      deployment: "shared",
      channel: input.httpChannel,
      allowed_hosts: [audienceUrl.host],
      oauth_resource: {
        resource: audience,
        authorization_servers: [issuer],
        scopes_supported: [input.oauthScope],
        required_scopes: [input.oauthScope],
      },
    },
    production_explore: {
      enabled: true,
      project_root: input.projectRoot,
      required_oauth_scope: input.oauthScope,
      budget_hmac_key_env: input.hmacKeyEnv,
      accounting_namespace: input.accountingNamespace,
      ...(input.singleOrganizationId ? { single_organization_id: input.singleOrganizationId } : {}),
      source_max_connections: 8,
      max_sessions_per_principal: 4,
      tenant_limits: {
        max_queries_per_rolling_24_hours: 10_000,
        max_extracted_cells_per_rolling_24_hours: 1_000_000,
        max_differencing_queries_per_rolling_24_hours: 2_000,
        requests_per_minute: 1_000,
        max_response_cells_per_response: 500,
      },
    },
    capabilities: [],
    strict: true,
    result_format: 2,
  };
}

function exactHttpsUrl(value: string | undefined, option: string): string {
  if (!value) throw new Error(`config init --production-explore requires ${option} <https-url>.`);
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) throw new Error("invalid");
    return value;
  } catch {
    throw new Error(`config init --production-explore ${option} must be an exact HTTPS URL without credentials.`);
  }
}

function isEnvironmentName(value: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(value);
}
