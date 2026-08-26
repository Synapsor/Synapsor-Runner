import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import {
  databaseServerCompatibility,
  databaseServerCompatibilityMessage,
  inspectDatabase,
  rolePostureFingerprint,
  type InspectEngine,
  type SchemaInspection
} from "@synapsor-runner/schema-inspector";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";
import { fileExists, readJsonFileWithLocation, writeFileGuarded } from "./cli-files.js";
import { shellQuote } from "./cli-format.js";
import { usage } from "./cli-help.js";
import { assertKnownOptions, optionalArg, outputArg } from "./cli-options.js";
import { databaseInputFromArgs } from "./cli-project.js";
import { configMigrate, configShow, configValidate } from "./contract-commands.js";
import { inferPrimaryKeyCandidate } from "./onboarding.js";
import { updateModelAuthorityMetadataMode } from "./model-output-config.js";
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
    const serverCompatibility = databaseServerCompatibility(inspection);
    process.stdout.write(`${JSON.stringify({
      ...inspection,
      server_compatibility: serverCompatibility,
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
  const serverCompatibility = databaseServerCompatibility(inspection);
  const lines = [
    "Synapsor schema inspection",
    `Engine: ${inspection.engine}`,
    `Server: ${inspection.server_version}`,
    `Server support: ${serverCompatibility.tier === "full" ? "FULL" : serverCompatibility.tier === "compatible_limited" ? "COMPATIBLE - LIMITED GRAMMAR" : "UNSUPPORTED"}`,
    `  ${databaseServerCompatibilityMessage(serverCompatibility)}`,
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


type ConfigCommandDependencies = {
  env?: NodeJS.ProcessEnv;
  inspectDatabaseFn?: typeof inspectDatabase;
};


async function backupExistingConfig(output: string): Promise<string | undefined> {
  if (!(await fileExists(output))) return undefined;
  const resolved = path.resolve(output);
  const stem = `${resolved}.bak.${new Date().toISOString().replace(/[:.]/g, "-")}`;
  let backup = stem;
  let counter = 1;
  while (await fileExists(backup)) backup = `${stem}.${counter++}`;
  await fs.copyFile(resolved, backup);
  return backup;
}


export async function configCommand(
  args: string[],
  dependencies: ConfigCommandDependencies = {},
): Promise<number> {
  const [subcommand] = args;
  if (subcommand === "init") return configInit(args.slice(1), dependencies);
  if (subcommand === "validate") return configValidate(args.slice(1));
  if (subcommand === "show") return configShow(args.slice(1));
  if (subcommand === "migrate") return configMigrate(args.slice(1));
  if (subcommand === "model-output") return configModelOutput(args.slice(1));
  usage();
  return 2;
}


async function configInit(
  args: string[],
  dependencies: ConfigCommandDependencies,
): Promise<number> {
  assertKnownOptions(
    args,
    new Set([
      "--output", "--out", "-o", "--engine", "--read-url-env", "--source", "--json",
      "--production-explore", "--project-root", "--tenant-claim", "--principal-claim",
      "--tenant-binding", "--principal-binding",
      "--single-tenant-organization-id",
      "--issuer", "--audience", "--accounting-namespace", "--oauth-scope",
      "--control-url-env", "--jwks-url-env", "--hmac-key-env", "--http-channel",
      "--verify-bindings", "--force",
    ]),
    "config init",
  );
  const output = outputArg(args) ?? "synapsor.runner.json";
  const force = args.includes("--force");
  const productionExplore = args.includes("--production-explore");
  const requireBindingVerification = args.includes("--verify-bindings");
  if (requireBindingVerification && !productionExplore) {
    throw new Error("config init --verify-bindings is available only with --production-explore.");
  }
  const projectRootValue = optionalArg(args, "--project-root") ?? ".";
  const projectRoot = path.resolve(projectRootValue);
  const drafted = productionExplore ? await readProductionExploreDraft(projectRoot) : undefined;
  const requestedEngine = optionalArg(args, "--engine");
  if (productionExplore && !requestedEngine && !drafted?.lock.engine) {
    throw new Error(
      "config init --production-explore requires --engine postgres|mysql when no reviewed production boundary draft is available. Runner does not infer a production engine from a credential value.",
    );
  }
  const engine = requestedEngine ?? drafted?.lock.engine ?? "postgres";
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
  const requestedTenantBinding = optionalTrimmedArg(args, "--tenant-binding");
  const requestedPrincipalBinding = optionalTrimmedArg(args, "--principal-binding");
  const reviewedTenantBinding = drafted?.lock.trusted_context_authority?.tenant_binding;
  const reviewedPrincipalBinding = drafted?.lock.trusted_context_authority?.principal_binding;
  const effectiveTenantBinding = requestedTenantBinding ?? reviewedTenantBinding;
  const effectivePrincipalBinding = requestedPrincipalBinding ?? reviewedPrincipalBinding;
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
    if (requestedTenantBinding && reviewedTenantBinding
      && requestedTenantBinding !== reviewedTenantBinding) {
      throw new Error(
        `Production config --tenant-binding ${requestedTenantBinding} must match the reviewed boundary binding ${reviewedTenantBinding} exactly. Rescan and review the boundary to change it.`,
      );
    }
    if (requestedPrincipalBinding && reviewedPrincipalBinding
      && requestedPrincipalBinding !== reviewedPrincipalBinding) {
      throw new Error(
        `Production config --principal-binding ${requestedPrincipalBinding} must match the reviewed boundary binding ${reviewedPrincipalBinding} exactly. Rescan and review the boundary to change it.`,
      );
    }
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
  const bindingReconciliationRequired = Boolean(drafted) && (
    (requestedTenantBinding !== undefined && requestedTenantBinding !== reviewedTenantBinding)
    || (requestedPrincipalBinding !== undefined
      && requestedPrincipalBinding !== reviewedPrincipalBinding)
  );
  const config = productionExplore
    ? productionExploreConfigTemplate({
      projectRoot: projectRootValue,
      engine,
      source,
      readUrlEnv,
      tenantClaim: optionalArg(args, "--tenant-claim") ?? productionClaim(drafted?.boundary, "tenant"),
      principalClaim: optionalArg(args, "--principal-claim") ?? productionClaim(drafted?.boundary, "principal"),
      tenantBinding: effectiveTenantBinding,
      principalBinding: effectivePrincipalBinding,
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
      tenant_binding: requestedTenantBinding ?? "tenant_id",
      principal_binding: requestedPrincipalBinding ?? "principal",
    },
    capabilities: [],
    model_output: { authority_metadata: "semantic" },
    strict: true,
    result_format: 2,
  };
  const validation = validateRunnerCapabilityConfig(config);
  if (!validation.ok) {
    throw new Error(`Internal config-init validation failed: ${validation.errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ")}`);
  }
  const bindingVerification = productionExplore
    ? await verifyProductionExploreBindings({
        engine,
        readUrlEnv,
        tenantBinding: effectiveTenantBinding,
        principalBinding: effectivePrincipalBinding,
        required: requireBindingVerification,
        env: dependencies.env ?? process.env,
        inspectDatabaseFn: dependencies.inspectDatabaseFn ?? inspectDatabase,
      })
    : undefined;
  const backupPath = force ? await backupExistingConfig(output) : undefined;
  await writeFileGuarded(output, `${JSON.stringify(config, null, 2)}\n`, force);
  const parsed = JSON.parse(await fs.readFile(output, "utf8"));
  const writtenValidation = validateRunnerCapabilityConfig(parsed);
  if (!writtenValidation.ok) {
    await fs.rm(output, { force: true });
    throw new Error(`Written config did not validate: ${writtenValidation.errors.map((issue) => issue.code).join(", ")}`);
  }
  const absoluteOutput = path.resolve(output);
  const controlStoreMigrationCommand = productionExplore
    ? `${cliCommandName()} store shared-postgres apply-migration --url-env ${optionalArg(args, "--control-url-env") ?? "SYNAPSOR_CONTROL_DATABASE_URL"} --schema synapsor_runner --yes`
    : undefined;
  const productionPreflightCommand = productionExplore
    ? [
      `${cliCommandName()} doctor`,
      `--config ${shellQuote(absoluteOutput)}`,
      "--transport streamable-http",
      "--preflight",
      ...(optionalArg(args, "--http-channel") === "direct_tls"
        ? ["--tls-cert-env SYNAPSOR_TLS_CERT_PEM", "--tls-key-env SYNAPSOR_TLS_KEY_PEM"]
        : ["--trusted-tls-proxy"]),
    ].join(" ")
    : undefined;
  const bindingReconciliationCommand = bindingReconciliationRequired
    ? `${cliCommandName()} boundary rescan --from-env ${readUrlEnv} --project-root ${shellQuote(projectRootValue)}`
    : undefined;
  const result = {
    ok: true,
    config_path: absoluteOutput,
    mode: "read_only",
    active_capabilities: 0,
    ...(productionExplore ? { profile: "production_explore" } : {}),
    source,
    engine,
    read_url_env: readUrlEnv,
    ...(backupPath ? { backup_path: backupPath } : {}),
    source_database_changed: false,
    ...(bindingVerification ? { binding_verification: bindingVerification } : {}),
    ...(controlStoreMigrationCommand
      ? { control_store_migration_command: controlStoreMigrationCommand }
      : {}),
    ...(productionPreflightCommand
      ? { preflight_command: productionPreflightCommand }
      : {}),
    ...(bindingReconciliationCommand
      ? {
          binding_reconciliation_required: true,
          binding_reconciliation_command: bindingReconciliationCommand,
        }
      : {}),
    next_action: productionExplore
      ? bindingReconciliationCommand
        ? `Run ${bindingReconciliationCommand}, review and activate the reconciled boundary, then initialize the shared control store and run the production preflight.`
        : "Set the referenced secret environment values, initialize the shared control store, then run the production preflight."
      : `Run ${cliCommandName()} start --from-env ${readUrlEnv} to draft a reviewed boundary, or author capabilities manually.`,
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write([
      `Created valid zero-authority ${productionExplore ? "production Explore " : ""}Runner config: ${result.config_path}`,
      ...(backupPath ? [`Backup of replaced config: ${backupPath}`] : []),
      `Mode: ${result.mode}`,
      `Database credential reference: ${readUrlEnv} (${bindingVerification
        ? "value was read only for schema binding verification and was not written"
        : "value was not read or written"})`,
      ...(bindingVerification
        ? [
            "Binding verification:",
            ...bindingVerification.checks.map((check) =>
              `  ${check.status === "verified" ? "OK" : "WARNING"}  ${check.message}`),
            ...bindingVerification.warnings.map((warning) => `  WARNING  ${warning}`),
          ]
        : []),
      ...(productionExplore
        ? [
          "Generated: shared control store, asymmetric JWT claims, secured HTTP, OAuth scope, tenant ceilings, and bounded source/session pools.",
          bindingVerification
            ? "Control-store, JWT/JWKS, and HMAC secret values were not read or written. The source credential was read only for schema binding verification and was not written."
            : "Secret values were not read or written.",
          "Generate the shared HMAC key from at least 32 random bytes; do not use a 32-character hex key.",
          ...(bindingReconciliationCommand
            ? [
                "The configured column bindings are newer than the existing reviewed draft; production startup remains blocked until reconciliation.",
                `Reconcile the existing boundary: ${bindingReconciliationCommand}`,
              ]
            : []),
          `Initialize the shared control store: ${controlStoreMigrationCommand}`,
          `Check every production prerequisite together: ${productionPreflightCommand}`,
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

type ProductionBindingVerificationCheck = {
  option: "--tenant-binding" | "--principal-binding";
  column: string;
  status: "verified" | "missing" | "ineligible";
  matched_resource_count: number;
  eligible_resource_count: number;
  resource_examples: string[];
  message: string;
};

type ProductionBindingVerification = {
  status: "verified" | "warning";
  engine: "postgres" | "mysql";
  read_url_env: string;
  credential_value_read: true;
  source_rows_read: false;
  checks: ProductionBindingVerificationCheck[];
  warnings: string[];
};

async function verifyProductionExploreBindings(input: {
  engine: "postgres" | "mysql";
  readUrlEnv: string;
  tenantBinding?: string;
  principalBinding?: string;
  required: boolean;
  env: NodeJS.ProcessEnv;
  inspectDatabaseFn: typeof inspectDatabase;
}): Promise<ProductionBindingVerification | undefined> {
  const requested = [
    ...(input.tenantBinding
      ? [{ option: "--tenant-binding" as const, column: input.tenantBinding }]
      : []),
    ...(input.principalBinding
      ? [{ option: "--principal-binding" as const, column: input.principalBinding }]
      : []),
  ];
  if (requested.length === 0) {
    if (input.required) {
      throw new Error(
        "config init --verify-bindings requires a configured --tenant-binding or --principal-binding. PostgreSQL RLS-only and single-organization configurations have no direct column binding to verify.",
      );
    }
    return undefined;
  }
  if (!input.env[input.readUrlEnv]?.trim()) {
    if (input.required) {
      throw new Error(
        `config init --verify-bindings cannot verify ${requested.map((item) => `${item.option} ${item.column}`).join(" and ")} because ${input.readUrlEnv} is not set. Set that environment variable or omit --verify-bindings for offline config generation.`,
      );
    }
    return undefined;
  }

  let inspection: SchemaInspection;
  try {
    inspection = await input.inspectDatabaseFn({
      engine: input.engine,
      databaseUrlEnv: input.readUrlEnv,
      env: input.env,
    });
  } catch {
    const warning = [
      `Runner could not verify ${requested.map((item) => `${item.option} ${item.column}`).join(" and ")} because schema inspection using ${input.readUrlEnv} did not complete.`,
      `Run ${cliCommandName()} inspect --engine ${input.engine} --from-env ${input.readUrlEnv} to diagnose the connection.`,
    ].join(" ");
    if (input.required) {
      throw new Error(`config init --verify-bindings failed. ${warning}`);
    }
    return {
      status: "warning",
      engine: input.engine,
      read_url_env: input.readUrlEnv,
      credential_value_read: true,
      source_rows_read: false,
      checks: [],
      warnings: [warning],
    };
  }

  const checks = requested.map((binding): ProductionBindingVerificationCheck => {
    const matches = inspection.tables.flatMap((table) => {
      const column = table.columns.find((candidate) => candidate.name === binding.column);
      return column ? [{ resource: `${table.schema}.${table.name}`, column }] : [];
    });
    const eligible = matches.filter(({ column }) =>
      column.nullable === false
      && column.suggestions.large_or_binary !== true
      && !/(?:^|\b)(bytea|blob|binary|varbinary|image|large object|oid)(?:\b|$)/i.test(column.data_type));
    const matchedResources = matches.map((match) => match.resource).sort();
    const eligibleResources = eligible.map((match) => match.resource).sort();
    if (matches.length === 0) {
      return {
        ...binding,
        status: "missing",
        matched_resource_count: 0,
        eligible_resource_count: 0,
        resource_examples: [],
        message: `${binding.option} ${binding.column} does not match any column visible to the inspected ${input.engine} role. Check the flag spelling before boundary review.`,
      };
    }
    if (eligible.length === 0) {
      return {
        ...binding,
        status: "ineligible",
        matched_resource_count: matches.length,
        eligible_resource_count: 0,
        resource_examples: matchedResources.slice(0, 8),
        message: `${binding.option} ${binding.column} exists on ${summarizeResources(matchedResources)}, but only as nullable, large/binary, or unsupported raw columns. A direct scope binding must be a non-null scalar column.`,
      };
    }
    return {
      ...binding,
      status: "verified",
      matched_resource_count: matches.length,
      eligible_resource_count: eligible.length,
      resource_examples: eligibleResources.slice(0, 8),
      message: `${binding.option} ${binding.column} is an eligible non-null scalar column on ${summarizeResources(eligibleResources)}. Exact boundary review and activation are still required.`,
    };
  });
  const failedMessages = checks
    .filter((check) => check.status !== "verified")
    .map((check) => check.message);
  if (input.required && failedMessages.length > 0) {
    throw new Error([
      "config init --verify-bindings failed:",
      ...failedMessages.map((warning) => `- ${warning}`),
    ].join("\n"));
  }
  return {
    status: failedMessages.length > 0 ? "warning" : "verified",
    engine: input.engine,
    read_url_env: input.readUrlEnv,
    credential_value_read: true,
    source_rows_read: false,
    checks,
    warnings: [],
  };
}

function summarizeResources(resources: string[]): string {
  const examples = resources.slice(0, 5);
  const remaining = resources.length - examples.length;
  return `${examples.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`;
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
  tenantBinding?: string;
  principalBinding?: string;
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
  if (input.engine === "mysql" && !input.singleOrganizationId && !input.tenantBinding) {
    throw new Error(
      "config init --production-explore --engine mysql requires --tenant-binding <column> for multi-tenant boundary authoring. MySQL has no PostgreSQL RLS metadata from which Runner can prove the tenant column; the binding remains reviewer-gated and is never model-authored.",
    );
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
    trusted_context: {
      provider: "http_claims",
      ...(input.tenantBinding ? { tenant_binding: input.tenantBinding } : {}),
      ...(input.principalBinding ? { principal_binding: input.principalBinding } : {}),
    },
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
    model_output: { authority_metadata: "semantic" },
    capabilities: [],
    strict: true,
    result_format: 2,
  };
}

async function configModelOutput(args: string[]): Promise<number> {
  assertKnownOptions(
    args,
    new Set(["--config", "--authority-metadata", "--json"]),
    "config model-output",
  );
  const configPath = path.resolve(optionalArg(args, "--config") ?? "synapsor.runner.json");
  const parsed = await readJsonFileWithLocation<Record<string, unknown>>(
    configPath,
    "Runner config",
  );
  const before = validateRunnerCapabilityConfig(parsed);
  if (!before.ok) {
    throw new Error(
      `Cannot change model output because the Runner config is invalid: ${before.errors.map((issue) => `${issue.path} ${issue.code}`).join(", ")}`,
    );
  }
  const requested = optionalArg(args, "--authority-metadata");
  if (requested !== undefined && requested !== "semantic" && requested !== "exact") {
    throw new Error("config model-output --authority-metadata must be semantic or exact.");
  }
  const current = modelOutputAuthorityMetadata(parsed);
  let changed = false;
  if (requested && requested !== current) {
    changed = (await updateModelAuthorityMetadataMode({
      configPath,
      mode: requested,
    })).changed;
  }
  const authorityMetadata = requested ?? current;
  const result = {
    ok: true,
    config_path: configPath,
    authority_metadata: authorityMetadata,
    changed,
    model_receives_exact_authority_metadata: authorityMetadata === "exact",
    operator_evidence_changed: false,
    restart_required: changed,
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  process.stdout.write([
    `Model-facing authority metadata: ${authorityMetadata.toUpperCase()}${changed ? " (updated)" : ""}`,
    authorityMetadata === "semantic"
      ? "Models receive reviewed names, semantics, privacy outcomes, data, and opaque evidence-resource handles, but not exact Runner digests, fingerprints, or query-audit hashes."
      : "Models receive exact Runner digests, fingerprints, and query-audit hashes for diagnostic workflows.",
    "Operator details, evidence, query audit, and internal authority checks always retain exact metadata.",
    ...(changed ? ["Restart a long-lived MCP server and reconnect clients to apply this presentation change."] : []),
    `Change it with: ${cliCommandName()} config model-output --authority-metadata ${authorityMetadata === "semantic" ? "exact" : "semantic"} --config ${shellQuote(configPath)}`,
    "",
  ].join("\n"));
  return 0;
}

function modelOutputAuthorityMetadata(
  config: Record<string, unknown>,
): "semantic" | "exact" {
  const modelOutput = config.model_output;
  if (!modelOutput || typeof modelOutput !== "object" || Array.isArray(modelOutput)) {
    return "semantic";
  }
  return (modelOutput as Record<string, unknown>).authority_metadata === "exact"
    ? "exact"
    : "semantic";
}

function optionalTrimmedArg(args: string[], option: string): string | undefined {
  const value = optionalArg(args, option);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`config init ${option} must name a database column.`);
  return trimmed;
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
