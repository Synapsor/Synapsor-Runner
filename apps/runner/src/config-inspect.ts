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
    new Set(["--output", "--out", "-o", "--engine", "--read-url-env", "--source", "--json"]),
    "config init",
  );
  const output = outputArg(args) ?? "synapsor.runner.json";
  const engine = optionalArg(args, "--engine") ?? "postgres";
  if (engine !== "postgres" && engine !== "mysql") {
    throw new Error("config init --engine must be postgres or mysql.");
  }
  const source = optionalArg(args, "--source") ?? `local_${engine}`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(source)) {
    throw new Error("config init --source must be a safe identifier.");
  }
  const readUrlEnv = optionalArg(args, "--read-url-env") ?? "DATABASE_URL";
  if (!/^[A-Z_][A-Z0-9_]*$/.test(readUrlEnv)) {
    throw new Error("config init --read-url-env must name an environment variable, not contain a URL.");
  }
  const config = {
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
    source,
    engine,
    read_url_env: readUrlEnv,
    source_database_changed: false,
    next_action: `Run ${cliCommandName()} start --from-env ${readUrlEnv} to draft a reviewed boundary, or author capabilities manually.`,
  };
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write([
      `Created valid zero-authority Runner config: ${result.config_path}`,
      `Mode: ${result.mode}`,
      `Database credential reference: ${readUrlEnv} (value was not read or written)`,
      "Agent authority active: no",
      "Source database changed: no",
      `Next: ${result.next_action}`,
      "",
    ].join("\n"));
  }
  return 0;
}
