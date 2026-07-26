import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { resolveRuntimeConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import {
  ProposalStore,
  type StoredProposal
} from "@synapsor-runner/proposal-store";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { resolveAssetPath } from "./cli-assets.js";
import { cliCommandName } from "./cli-command-meta.js";
import { fileExists, readJsonFileWithLocation } from "./cli-files.js";
import { shellQuote } from "./cli-format.js";
import { envValue, firstDatabaseUrlPositional, isDatabaseUrl, optionalArg } from "./cli-options.js";
import { TrustedOperatorDecisionOverride } from "./operator-authority.js";
import { resolveOperatorIdentity, type OperatorIdentityConfig } from "./operator-identity.js";
import { type SynapsorProjectResolution } from "./project-resolution.js";

export const activeProjectResolutionState: { current: SynapsorProjectResolution | undefined } = { current: undefined };

export const defaultConfigPath = "synapsor.runner.json";

export const defaultStorePath = "./.synapsor/local.db";

export const generatedSmokeInputPath = "./.synapsor/smoke-input.json";

const referenceDemoDir = "examples/reference-support-billing-app";

const referenceDemoConfigPath = `${referenceDemoDir}/synapsor.runner.json`;

const referenceDemoContainer = "synapsor_runner_reference_support_billing";

const referenceDemoDatabase = "synapsor_reference_support_billing";

const referenceDemoEnv: Record<string, string> = {
  REFERENCE_POSTGRES_READ_URL: "postgresql://synapsor_reader:synapsor_reader_password@localhost:55435/synapsor_reference_support_billing",
  REFERENCE_POSTGRES_WRITE_URL: "postgresql://synapsor_writer:synapsor_writer_password@localhost:55435/synapsor_reference_support_billing",
  SYNAPSOR_TENANT_ID: "acme",
  SYNAPSOR_PRINCIPAL: "local_reviewer",
  SYNAPSOR_ENGINE: "postgres",
  SYNAPSOR_DATABASE_URL: "postgresql://synapsor_writer:synapsor_writer_password@localhost:55435/synapsor_reference_support_billing",
  SYNAPSOR_RUNNER_ID: "synapsor_demo_runner",
  SYNAPSOR_SOURCE_ID: "app_postgres",
  SYNAPSOR_CONTROL_PLANE_URL: "http://127.0.0.1:0",
  SYNAPSOR_RUNNER_TOKEN: "syn_wbr_demo_local",
};


export async function openLocalStore(args: string[]): Promise<ProposalStore> {
  return openLocalStoreAt(localStorePath(args));
}


export async function openLocalStoreAt(storePath: string): Promise<ProposalStore> {
  if (storePath !== ":memory:") {
    if (!await fileExists(storePath)) throw missingLocalStoreError(storePath);
    await fs.mkdir(path.dirname(path.resolve(storePath)), { recursive: true });
  }
  return new ProposalStore(storePath);
}


export function localStorePath(args: string[]): string {
  return resolvedLocalStorePath(args);
}


export function runnerConfigPath(args: string[], fallback = "synapsor.runner.json"): string {
  return optionalArg(args, "--config")
    ?? process.env.SYNAPSOR_RUNNER_CONFIG
    ?? process.env.SYNAPSOR_MCP_CONFIG
    ?? activeProjectResolutionState.current?.config_path
    ?? fallback;
}


export function resolvedLocalStorePath(
  args: string[],
  configuredPath?: string,
  fallback = "./.synapsor/local.db",
): string {
  return optionalResolvedLocalStorePath(args) ?? configuredPath ?? fallback;
}


export function optionalResolvedLocalStorePath(args: string[]): string | undefined {
  const explicit = optionalArg(args, "--store");
  if (explicit) return explicit;
  if (process.env.SYNAPSOR_LOCAL_STORE) return process.env.SYNAPSOR_LOCAL_STORE;
  if (!optionalArg(args, "--config") && activeProjectResolutionState.current?.store_path) {
    return activeProjectResolutionState.current.store_path;
  }
  return undefined;
}


export async function optionalRunnerConfigPath(args: string[]): Promise<string | undefined> {
  const selected = optionalArg(args, "--config")
    ?? process.env.SYNAPSOR_RUNNER_CONFIG
    ?? process.env.SYNAPSOR_MCP_CONFIG
    ?? activeProjectResolutionState.current?.config_path;
  if (selected) return selected;
  return await fileExists("synapsor.runner.json") ? "synapsor.runner.json" : undefined;
}


export function redactConfig(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => redactConfig(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactConfig(entryValue, entryKey)]));
  }
  if (typeof value === "string") {
    if (/(url|password|secret|token|key|credential)/i.test(key)) return "<redacted>";
    if (/^(postgres(?:ql)?:\/\/|mysql:\/\/|Bearer\s+|syn_wbr_)/i.test(value)) return "<redacted>";
  }
  return value;
}


export async function optionalRuntimeConfig(configPath: string): Promise<RuntimeConfig | undefined> {
  return await fileExists(configPath) ? await readRuntimeConfig(configPath) : undefined;
}


export async function operatorIdentityForDecision(input: {
  args: string[];
  config: RuntimeConfig | undefined;
  configPath: string;
  proposal: StoredProposal;
  action:
    | "approve"
    | "reject"
    | "apply"
    | "revert"
    | "reconcile"
    | "worker_requeue"
    | "worker_discard"
    | "worker_cancel";
  reason?: string;
  decision?: TrustedOperatorDecisionOverride;
}) {
  const applyAuthorityAction = ["apply", "reconcile", "worker_requeue", "worker_discard", "worker_cancel"].includes(input.action);
  const requiredRole = applyAuthorityAction ? undefined : input.proposal.change_set.approval.required_role;
  const identity = await resolveOperatorIdentity({
    config: input.config?.operator_identity as OperatorIdentityConfig | undefined,
    configPath: input.configPath,
    proposal: input.proposal,
    action: input.action,
    reason: input.decision?.reason ?? input.reason,
    actor: input.decision?.actor ?? optionalArg(input.args, "--actor"),
    identity: input.decision?.identity ?? optionalArg(input.args, "--identity"),
    privateKeyPath: input.decision?.privateKeyPath ?? optionalArg(input.args, "--identity-key"),
    token: input.decision?.identityToken,
    requiredRole,
  });
  const applyRoles = input.config?.operator_identity?.apply_roles ?? [];
  if (applyAuthorityAction && applyRoles.length > 0 && !applyRoles.some((role) => identity.roles.includes(role))) {
    throw new Error(`operator ${identity.subject} lacks an apply role; requires one of: ${applyRoles.join(", ")}`);
  }
  return identity;
}


export function requireLocalProposal(store: ProposalStore, proposalId: string): StoredProposal {
  const proposal = store.getProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
  return proposal;
}


export async function resolveProposalId(proposalId: string, storePath: string): Promise<string> {
  if (proposalId !== "latest") return proposalId;
  if (storePath !== ":memory:" && !await fileExists(storePath)) throw missingLocalStoreError(storePath);
  const store = new ProposalStore(storePath);
  try {
    return resolveProposalIdFromStore(proposalId, store);
  } finally {
    store.close();
  }
}


export function resolveProposalIdFromStore(proposalId: string, store: ProposalStore): string {
  if (proposalId !== "latest") return proposalId;
  const latest = store.listProposals()[0];
  if (!latest) throw new Error("no proposals found in the local store");
  return latest.proposal_id;
}


export function missingLocalStoreError(storePath: string): Error {
  return new Error([
    `No local Synapsor proposal store was found at ${storePath}.`,
    "Run:",
    `${cliCommandName()} demo`,
    "or pass:",
    "--store /path/to/local.db",
  ].join("\n"));
}


export async function readRuntimeConfig(configPath: string): Promise<RuntimeConfig> {
  const parsed = await readJsonFileWithLocation<RuntimeConfig>(configPath, "Runner config");
  const resolved = resolveRuntimeConfig(parsed, path.dirname(path.resolve(configPath)));
  const validation = validateRunnerCapabilityConfig(resolved);
  if (!validation.ok) {
    const first = validation.errors[0]!;
    throw new Error(
      `Invalid Runner config ${path.resolve(configPath)}: ${first.path} ${first.code}: ${first.message} ` +
      `State preserved: the config and source database were not changed. ` +
      `Next: run ${cliCommandName()} config validate --config ${shellQuote(configPath)} --json.`,
    );
  }
  return resolved;
}


export function isSynapsorContractLike(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    ((value as { kind?: unknown }).kind === "SynapsorContract" || (value as { spec_version?: unknown }).spec_version === "0.1");
}


export function envWithDemoDefaults(config: RuntimeConfig, configPath: string): NodeJS.ProcessEnv {
  if (!isReferenceDemoConfig(config, configPath)) return process.env;
  return { ...referenceDemoEnv, ...process.env };
}


function isReferenceDemoConfig(config: RuntimeConfig, configPath: string): boolean {
  const normalized = path.normalize(configPath);
  const hasReferenceSource = Boolean(config.sources?.app_postgres?.read_url_env === "REFERENCE_POSTGRES_READ_URL");
  return hasReferenceSource || normalized.endsWith(path.normalize(referenceDemoConfigPath));
}


export async function prepareReferenceDemo(args: string[]): Promise<number> {
  const force = args.includes("--force") || args.includes("--reset");
  const demoDir = await resolveAssetPath(referenceDemoDir);
  const composePath = path.join(demoDir, "docker-compose.yml");
  if (!await fileExists(composePath)) throw new Error(`demo compose file not found: ${composePath}`);
  const configPath = path.resolve(defaultConfigPath);
  if (await fileExists(configPath) && !force) {
    const existing = JSON.parse(await fs.readFile(configPath, "utf8")) as RuntimeConfig;
    if (!isReferenceDemoConfig(existing, defaultConfigPath)) {
      throw new Error(`${defaultConfigPath} already exists and is not the Synapsor demo config. Rerun with --force, or pass --config to later commands.`);
    }
  }
  await fs.mkdir(path.resolve(".synapsor"), { recursive: true });
  await fs.rm(path.resolve(defaultStorePath), { force: true });
  process.stdout.write([
    "Synapsor Runner demo",
    "",
    "Raw database MCP tools can hand the model SQL and write authority.",
    "Synapsor Runner exposes semantic capabilities instead:",
    "  billing.inspect_invoice",
    "  billing.propose_late_fee_waiver",
    "",
    "Demo flow:",
    "proposal first -> source unchanged -> approval outside MCP -> guarded writeback -> replay",
    "",
    "Starting disposable Postgres fixture...",
    "",
  ].join("\n"));
  const down = spawnSync("docker", ["compose", "-f", composePath, "down", "-v", "--remove-orphans"], { stdio: "inherit", env: process.env });
  if (down.status !== 0) return down.status ?? 1;
  const up = spawnSync("docker", ["compose", "-f", composePath, "up", "-d"], { stdio: "inherit", env: process.env });
  if (up.status !== 0) return up.status ?? 1;
  await waitForReferenceDemoDatabase();
  await fs.copyFile(path.join(demoDir, "synapsor.runner.json"), configPath);
  process.stdout.write([
    "Synapsor Runner demo is ready.",
    "",
    "What is running:",
    "* Demo Postgres database",
    "* Synapsor local store",
    "* Safe MCP capability config",
    "",
    "Try:",
    `1. ${cliCommandName()} propose billing.propose_late_fee_waiver --sample`,
    `2. ${cliCommandName()} proposals show latest`,
    `3. ${cliCommandName()} proposals approve latest --yes`,
    `4. ${cliCommandName()} apply latest`,
    `5. ${cliCommandName()} replay latest`,
    "",
    "Connect MCP:",
    `${cliCommandName()} mcp config --absolute-paths --config ./synapsor.runner.json --store ./.synapsor/local.db`,
    "",
    "Open UI:",
    `${cliCommandName()} ui --open --tour`,
    "",
  ].join("\n"));
  return 0;
}


async function waitForReferenceDemoDatabase(): Promise<void> {
  let last = "";
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = spawnSync("docker", ["exec", referenceDemoContainer, "pg_isready", "-U", "synapsor_admin", "-d", referenceDemoDatabase], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return;
    }
    last = result.stderr || result.stdout || `exit ${result.status}`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`demo database did not become ready: ${last}`);
}


export async function confirmDangerousAction(args: string[], question: string): Promise<void> {
  if (args.includes("--yes")) return;
  if (!process.stdin.isTTY) {
    throw new Error("approval/rejection requires --yes in noninteractive mode");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${question} Type yes to continue: `);
    if (answer.trim().toLowerCase() !== "yes") {
      throw new Error("confirmation declined");
    }
  } finally {
    rl.close();
  }
}


const INLINE_DATABASE_URL_ENV = "SYNAPSOR_RUNNER_INLINE_DATABASE_URL";


export function databaseInputFromArgs(
  args: string[],
  options: { implyDatabaseUrl?: boolean } = {},
): {
  explicit: boolean;
  inlineUrl: boolean;
  inspectionDatabaseUrlEnv: string;
  configDatabaseUrlEnv: string;
  env?: NodeJS.ProcessEnv;
} {
  const inlineFromFlag = optionalArg(args, "--from");
  const inlineFromPosition = firstDatabaseUrlPositional(args);
  if (inlineFromFlag && inlineFromPosition) {
    throw new Error("pass the database URL either as --from <url> or as the positional inspect URL, not both.");
  }
  const inlineUrl = inlineFromFlag ?? inlineFromPosition;
  if (inlineUrl && !isDatabaseUrl(inlineUrl)) {
    throw new Error("--from must be a postgres://, postgresql://, or mysql:// URL.");
  }
  const fromEnv = optionalArg(args, "--from-env")
    ?? optionalArg(args, "--url-env")
    ?? optionalArg(args, "--database-url-env")
    ?? (options.implyDatabaseUrl && envValue(process.env, "DATABASE_URL") ? "DATABASE_URL" : undefined);
  const configDatabaseUrlEnv = fromEnv ?? "SYNAPSOR_DATABASE_READ_URL";
  if (inlineUrl) {
    return {
      explicit: true,
      inlineUrl: true,
      inspectionDatabaseUrlEnv: INLINE_DATABASE_URL_ENV,
      configDatabaseUrlEnv,
      env: { ...process.env, [INLINE_DATABASE_URL_ENV]: inlineUrl },
    };
  }
  return {
    explicit: Boolean(fromEnv),
    inlineUrl: false,
    inspectionDatabaseUrlEnv: configDatabaseUrlEnv,
    configDatabaseUrlEnv,
  };
}
