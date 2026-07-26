import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { type RuntimeConfig } from "@synapsor-runner/mcp-server";
import {
  createLogger,
  doctorChecks,
  loadConfig
} from "@synapsor-runner/worker-core";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { cliCommandName } from "./cli-command-meta.js";
import { fileExists } from "./cli-files.js";
import { shellQuote } from "./cli-format.js";
import { envValue, optionalArg } from "./cli-options.js";
import { resolvedLocalStorePath, runnerConfigPath } from "./cli-project.js";
import { adapters } from "./cli-runtime.js";
import { trustedContextsForDoctor } from "./doctor-domain.js";
import { localDoctor } from "./runtime-doctor.js";


export async function doctor(args: string[] = []): Promise<number> {
  if (args.includes("--first-run")) return firstRunDoctor(args);
  const configPath = optionalArg(args, "--config");
  if (configPath || await fileExists("synapsor.runner.json")) {
    return localDoctor(args);
  }
  if (!process.env.SYNAPSOR_CONTROL_PLANE_URL) {
    throw new Error(`Local doctor requires --config ./synapsor.runner.json. Cloud worker doctor requires SYNAPSOR_CONTROL_PLANE_URL and the scoped worker environment.`);
  }
  const config = loadConfig();
  const logger = createLogger(config);
  const report = await doctorChecks(config, adapters[config.engine]);
  logger.info("doctor checks", report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}


type FirstRunCheck = {
  name: string;
  status: "pass" | "warn" | "fail";
  checked: string;
  why: string;
  fix: string;
};


async function firstRunDoctor(args: string[]): Promise<number> {
  const json = args.includes("--json");
  const checks: FirstRunCheck[] = [];
  checks.push(commandCheck("bash", "Bash shell is available.", "The first-run script is a Bash script.", "Install bash, then rerun ./scripts/try-synapsor.sh."));
  checks.push(commandCheck("docker", "Docker CLI is installed.", "The first-run demo starts disposable Postgres/MySQL containers.", "Install Docker Desktop or Docker Engine, then rerun ./scripts/try-synapsor.sh."));
  checks.push(commandCheck("node", "Node.js is installed for source-checkout commands.", "Source commands such as corepack pnpm runner use Node.", "Install Node.js 22+, or run ./scripts/try-synapsor.sh which uses Docker for the demo."));
  checks.push(commandCheck("corepack", "Corepack is installed for the pinned pnpm version.", "The source checkout uses packageManager pnpm@10.14.0.", "Run corepack enable after installing Node.js, or use the Docker-only first-run script."));
  checks.push(await pnpmInstallCheck());
  checks.push(diskSpaceCheck());
  checks.push(memoryCheck());

  if (commandExists("docker")) {
    const info = spawnSync("docker", ["info"], { encoding: "utf8" });
    checks.push(info.status === 0
      ? pass("docker-daemon", "Docker daemon is reachable.", "The demo needs Docker to start disposable databases.", "No action needed.")
      : fail(
        "docker-daemon",
        "Docker daemon is not reachable.",
        "The first-run demo starts disposable Postgres/MySQL containers.",
        dockerFix(info.stderr || info.stdout),
      ));
    const compose = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
    checks.push(compose.status === 0
      ? pass("docker-compose", "Docker Compose is available.", "The reference app and fixtures use Docker Compose.", "No action needed.")
      : warn("docker-compose", "Docker Compose was not detected.", "The reference app uses Docker Compose.", "Install a Docker version with `docker compose`, then rerun the demo."));
    const staleContainers = dockerNames(["ps", "-a", "--format", "{{.Names}}"])
      .filter((name) => /synapsor_runner|mcp-postgres|mcp-mysql|postgres-support|mysql-orders|reference-support/i.test(name));
    checks.push(staleContainers.length === 0
      ? pass("stale-containers", "No stale Synapsor demo containers found.", "Stale containers can hold ports or old fixture state.", "No action needed.")
      : warn("stale-containers", `Stale Synapsor demo containers found: ${staleContainers.join(", ")}`, "Stale containers can hold ports or old fixture state.", "./scripts/try-synapsor.sh --reset"));
  }

  for (const port of [55433, 55434, 55435, 53307]) {
    const available = await isPortAvailable(port);
    checks.push(available
      ? pass(`port-${port}`, `Port ${port} is available.`, "The first-run fixtures bind predictable local demo ports.", "No action needed.")
      : fail(`port-${port}`, `Port ${port} is already in use.`, "The first-run fixtures need predictable local demo ports.", `Stop the process using port ${port}, or run ./scripts/try-synapsor.sh --reset if it is a stale demo container.`));
  }

  const configPath = runnerConfigPath(args);
  const storePath = resolvedLocalStorePath(args);
  const configExists = await fileExists(configPath);
  checks.push(configExists
    ? pass("config", `Runner config exists at ${configPath}.`, "MCP serve/smoke need a reviewed config.", "No action needed.")
    : warn("config", `Runner config not found at ${configPath}.`, "Own-database MCP setup needs a generated config.", `Run ${cliCommandName()} demo first, or run ${cliCommandName()} onboard db --from-env DATABASE_URL.`));

  if (configExists) {
    const parsedConfig = JSON.parse(await fs.readFile(configPath, "utf8")) as RuntimeConfig;
    const validation = validateRunnerCapabilityConfig(parsedConfig);
    checks.push(validation.ok
      ? pass("config-valid", "Runner config validates.", "Invalid configs must fail before exposing MCP tools.", "No action needed.")
      : fail("config-valid", `Runner config failed validation: ${validation.errors.map((error) => error.code).join(", ")}`, "Invalid configs must fail before exposing MCP tools.", `Run ${cliCommandName()} config validate --config ${configPath}.`));
    checks.push(...firstRunConfigEnvChecks(parsedConfig));
  }
  checks.push(await sqliteStoreCheck(storePath));
  checks.push(...await mcpClientConfigLeakChecks(args));

  const report = { ok: checks.every((check) => check.status !== "fail"), checks };
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatFirstRunDoctor(report));
  }
  return report.ok ? 0 : 1;
}


function commandCheck(command: string, checked: string, why: string, fix: string): FirstRunCheck {
  return commandExists(command) ? pass(command, checked, why, "No action needed.") : fail(command, `${command} was not found.`, why, fix);
}


function commandExists(command: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${shellQuote(command)} >/dev/null 2>&1`]).status === 0;
}


function dockerNames(args: string[]): string[] {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}


function dockerFix(message: string): string {
  if (/permission denied/i.test(message)) return "Your user cannot access the Docker socket. Add your user to the docker group or start Docker Desktop, then rerun ./scripts/try-synapsor.sh.";
  return "Start Docker Desktop or the Docker daemon, then run ./scripts/try-synapsor.sh.";
}


async function pnpmInstallCheck(): Promise<FirstRunCheck> {
  if (!await fileExists("package.json")) {
    return warn("package-json", "No package.json found in the current directory.", "Source checkout commands must run from the repository root.", "cd into synapsor-runner before running synapsor commands from this checkout.");
  }
  return await fileExists("node_modules/.pnpm") || await fileExists("node_modules")
    ? pass("pnpm-install", "Dependencies appear installed for source-checkout commands.", "Commands like corepack pnpm runner use local workspace packages.", "No action needed.")
    : warn("pnpm-install", "Dependencies are not installed yet.", "Source-checkout commands need workspace dependencies.", "Run corepack pnpm install, or use ./scripts/try-synapsor.sh for the Docker-only demo.");
}


function diskSpaceCheck(): FirstRunCheck {
  const result = spawnSync("df", ["-Pk", "."], { encoding: "utf8" });
  if (result.status !== 0) {
    return warn("disk-space", "Could not check available disk space.", "Docker image builds and disposable databases need free local disk.", "Run df -h . if the demo fails during Docker build or database startup.");
  }
  const line = result.stdout.trim().split(/\r?\n/)[1] ?? "";
  const availableKb = Number(line.trim().split(/\s+/)[3] ?? "0");
  const availableGb = availableKb / 1024 / 1024;
  if (!Number.isFinite(availableGb) || availableGb <= 0) {
    return warn("disk-space", "Could not parse available disk space.", "Docker image builds and disposable databases need free local disk.", "Run df -h . if the demo fails during Docker build or database startup.");
  }
  if (availableGb < 2) {
    return warn("disk-space", `Only ${availableGb.toFixed(1)} GB free in this workspace filesystem.`, "Docker image builds and disposable databases need local disk headroom.", "Free a few GB, then rerun ./scripts/try-synapsor.sh.");
  }
  return pass("disk-space", `${availableGb.toFixed(1)} GB free in this workspace filesystem.`, "Docker image builds and disposable databases need local disk headroom.", "No action needed.");
}


function memoryCheck(): FirstRunCheck {
  const totalGb = os.totalmem() / 1024 / 1024 / 1024;
  if (totalGb < 4) {
    return warn("memory", `Host reports ${totalGb.toFixed(1)} GB total memory.`, "Docker build plus Postgres/MySQL fixtures need memory headroom.", "Close other heavy apps or increase Docker memory if the demo is killed.");
  }
  return pass("memory", `Host reports ${totalGb.toFixed(1)} GB total memory.`, "Docker build plus Postgres/MySQL fixtures need memory headroom.", "No action needed.");
}


function firstRunConfigEnvChecks(config: RuntimeConfig): FirstRunCheck[] {
  const checks: FirstRunCheck[] = [];
  for (const context of trustedContextsForDoctor(config)) {
    if (context.provider === "http_claims") {
      checks.push(config.session_auth
        ? pass(`trusted-context-${context.name}`, `${context.name} binds tenant/principal from verified signed HTTP session claims.`, "Shared HTTP tenant scope must come from authenticated server-side identity.", "No action needed.")
        : fail(`trusted-context-${context.name}`, `${context.name} uses http_claims without session_auth.`, "Unsigned transport metadata must never become trusted tenant authority.", "Configure signed session_auth before serving Streamable HTTP."));
      continue;
    }
    if (context.provider === "cloud_session") {
      checks.push(warn(`trusted-context-${context.name}`, `${context.name} requires an externally verified Cloud session binding.`, "Cloud session scope cannot be supplied by model arguments or static bearer authentication.", "Use the Cloud-linked embedding that supplies verified per-session context."));
      continue;
    }
    const values = context.values;
    for (const envName of [
      String(values.tenant_id_env ?? "SYNAPSOR_TENANT_ID"),
      String(values.principal_env ?? "SYNAPSOR_PRINCIPAL"),
    ]) {
      checks.push(envValue(process.env, envName)
        ? pass(`env-${envName}`, `${envName} is set for ${context.name}.`, "Trusted tenant/principal values must come from the launcher, not the model.", "No action needed.")
        : warn(`env-${envName}`, `${envName} is not set for ${context.name}.`, "Trusted tenant/principal values must come from the launcher, not the model.", `Set ${envName}, or use the generated .env.example as a template.`));
    }
  }
  for (const [sourceName, source] of Object.entries(config.sources ?? {})) {
    checks.push(envValue(process.env, source.read_url_env)
      ? pass(`env-${source.read_url_env}`, `${source.read_url_env} is set for ${sourceName}.`, "Configured capabilities need a read credential env var to inspect/propose against your DB.", "No action needed.")
      : warn(`env-${source.read_url_env}`, `${source.read_url_env} is not set for ${sourceName}.`, "Configured capabilities need a read credential env var to inspect/propose against your DB.", `Set ${source.read_url_env} before running doctor, tools preview, or mcp serve against your own database.`));
    if (source.write_url_env) {
      checks.push(envValue(process.env, source.write_url_env)
        ? pass(`env-${source.write_url_env}`, `${source.write_url_env} is set for ${sourceName}.`, "Trusted writeback needs a separate writer credential outside the MCP client.", "No action needed.")
        : warn(`env-${source.write_url_env}`, `${source.write_url_env} is not set for ${sourceName}.`, "Trusted writeback needs a separate writer credential outside the MCP client.", `Set ${source.write_url_env} only when you are ready to apply an approved writeback job.`));
      const readValue = envValue(process.env, source.read_url_env);
      const writeValue = envValue(process.env, source.write_url_env);
      if (readValue && writeValue && readValue === writeValue) {
        checks.push(fail(`credential-split-${sourceName}`, `Read and write env vars resolve to the same credential for ${sourceName}.`, "Read/proposal authority and writeback authority must be separated.", "Use a read-only credential for MCP reads and a separate writer credential only for trusted apply."));
      }
    }
  }
  return checks;
}


async function sqliteStoreCheck(storePath: string): Promise<FirstRunCheck> {
  if (storePath === ":memory:") {
    return pass("sqlite-store", "Using in-memory SQLite store.", "The local UI and replay need a store when you want persistent proposals.", "No action needed for tests.");
  }
  if (await fileExists(storePath)) {
    return pass("sqlite-store", `SQLite local store exists at ${storePath}.`, "The local UI and replay read proposal/evidence state from this store.", "No action needed.");
  }
  return warn("sqlite-store", `SQLite local store not found at ${storePath}.`, "The local UI and replay need a store after a demo or proposal run.", "Run ./scripts/try-synapsor.sh, corepack pnpm demo:reference, or create a proposal before opening the UI.");
}


async function mcpClientConfigLeakChecks(args: string[]): Promise<FirstRunCheck[]> {
  const explicit = optionalArg(args, "--client-config");
  const paths = explicit ? [explicit] : await defaultMcpClientConfigPaths();
  if (paths.length === 0) {
    return [warn("mcp-client-config", "No generated MCP client config snippets found yet.", "MCP clients should receive command paths only, never database URLs or credentials.", `Generate one with ${cliCommandName()} mcp config --absolute-paths --config <config> --store <store>.`)];
  }
  const checks: FirstRunCheck[] = [];
  for (const filePath of paths) {
    try {
      const text = await fs.readFile(filePath, "utf8");
      const leaked = /postgres(?:ql)?:\/\/|mysql:\/\/|password\s*[:=]|bearer\s+[a-z0-9._~+/=-]+|syn_wbr_/i.test(text);
      checks.push(leaked
        ? fail(`mcp-client-config-${filePath}`, `MCP client config appears to contain a database URL, password, or token: ${filePath}.`, "MCP clients must only receive the local runner command and arguments.", `Regenerate the snippet with ${cliCommandName()} mcp config ... and keep DB URLs in environment variables.`)
        : pass(`mcp-client-config-${filePath}`, `MCP client config has no obvious database URL, password, or bearer token: ${filePath}.`, "MCP clients must only receive the local runner command and arguments.", "No action needed."));
    } catch (error) {
      checks.push(warn(`mcp-client-config-${filePath}`, `Could not read MCP client config: ${filePath}.`, "MCP clients should receive command paths only, never database URLs or credentials.", error instanceof Error ? error.message : String(error)));
    }
  }
  return checks;
}


async function defaultMcpClientConfigPaths(): Promise<string[]> {
  const dir = path.resolve(".synapsor/mcp");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dir, entry.name))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}


function pass(name: string, checked: string, why: string, fix: string): FirstRunCheck {
  return { name, status: "pass", checked, why, fix };
}


function warn(name: string, checked: string, why: string, fix: string): FirstRunCheck {
  return { name, status: "warn", checked, why, fix };
}


function fail(name: string, checked: string, why: string, fix: string): FirstRunCheck {
  return { name, status: "fail", checked, why, fix };
}


async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}


function formatFirstRunDoctor(report: { ok: boolean; checks: FirstRunCheck[] }): string {
  const lines = [`Synapsor Runner first-run doctor: ${report.ok ? "ok" : "needs attention"}`, ""];
  for (const check of report.checks) {
    const icon = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    lines.push(`${icon} ${check.checked}`);
    lines.push(`Why it matters: ${check.why}`);
    lines.push(`Fix: ${check.fix}`, "");
  }
  return `${lines.join("\n")}\n`;
}
