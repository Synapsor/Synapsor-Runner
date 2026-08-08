import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-packed-first-run-cli-"));
const installRoot = path.join(tempRoot, "install");
const packRoot = path.join(tempRoot, "pack");
const fixtures = [
  {
    engine: "postgres",
    compose: path.join(root, "examples", "mcp-postgres-billing", "docker-compose.yml"),
    service: "postgres",
    container: "synapsor_runner_mcp_postgres_billing",
    databaseUrl: "postgresql://synapsor_reader:synapsor_reader_password@127.0.0.1:55433/synapsor_runner_mcp_billing",
    resource: "public.invoices",
    identity: "id",
    tenant: "tenant_id",
  },
  {
    engine: "mysql",
    compose: path.join(root, "examples", "mcp-mysql-orders", "docker-compose.yml"),
    service: "mysql",
    container: "synapsor_runner_mcp_mysql_orders",
    databaseUrl: "mysql://synapsor_reader:synapsor_reader_password@127.0.0.1:53307/synapsor_runner_mcp_orders",
    resource: "synapsor_runner_mcp_orders.orders",
    identity: "id",
    tenant: "tenant_id",
  },
];

const results = [];

try {
  const cli = await resolvePackedCli();
  for (const fixture of fixtures) {
    await resetFixture(fixture);
    const before = sourceSnapshot(fixture);
    const projectRoot = await fsp.mkdtemp(path.join(tempRoot, `${fixture.engine}-project-`));
    const proof = await runFirstUseJourney({ cli, fixture, projectRoot });
    const after = sourceSnapshot(fixture);
    assert.equal(after, before, `${fixture.engine} first-run journey changed source data`);

    const activePath = path.join(projectRoot, ".synapsor", "exploration-boundary.active.json");
    const active = JSON.parse(await fsp.readFile(activePath, "utf8"));
    const resource = active.pack.resources.find((item) => item.id === fixture.resource);
    assert.ok(resource, `${fixture.engine} did not activate ${fixture.resource}`);
    assert.equal(resource.primary_key, fixture.identity);
    assert.equal(resource.tenant_key, fixture.tenant);
    assert.equal(active.deployment_profile, "staging");
    assertProjectHasNoCredential(projectRoot, fixture.databaseUrl);

    results.push({
      engine: fixture.engine,
      fresh_project: true,
      packed_artifact: true,
      blocked_scope_resolved_inline: true,
      column_review_remained_open: true,
      boundary_activated: true,
      reached_model_choice: true,
      source_database_changed: false,
      elapsed_ms: proof.elapsedMs,
    });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, results }, null, 2)}\n`);
} finally {
  for (const fixture of fixtures) {
    run("docker", ["compose", "-f", fixture.compose, "down", "-v", "--remove-orphans"], {
      allowFailure: true,
    });
  }
  if (process.env.SYNAPSOR_KEEP_PACKED_FIRST_RUN_TEMP !== "1") {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`Packed first-run artifacts retained at ${tempRoot}\n`);
  }
}

async function resolvePackedCli() {
  const supplied = process.env.SYNAPSOR_PACKED_RUNNER?.trim();
  if (supplied) {
    const resolved = path.resolve(supplied);
    assert.ok(fs.existsSync(resolved), `SYNAPSOR_PACKED_RUNNER does not exist: ${resolved}`);
    return resolved;
  }
  await fsp.mkdir(packRoot);
  await fsp.mkdir(installRoot);
  run("corepack", ["pnpm", "build:runner-package"]);
  const specTarball = packCurrent(path.join(root, "packages", "spec"));
  const runnerTarball = packCurrent(path.join(root, "apps", "runner"));
  run("npm", ["init", "-y"], { cwd: installRoot });
  run("npm", ["install", "--ignore-scripts", specTarball], { cwd: installRoot });
  run("npm", ["install", "--ignore-scripts", runnerTarball], { cwd: installRoot });
  const cli = path.join(installRoot, "node_modules", ".bin", "synapsor-runner");
  assert.ok(fs.existsSync(cli), "packed install omitted the synapsor-runner binary");
  return cli;
}

function packCurrent(packageRoot) {
  const packed = run("corepack", ["pnpm", "pack", "--pack-destination", packRoot], {
    cwd: packageRoot,
  });
  const filename = packed.stdout.trim().split(/\r?\n/).findLast((line) => line.endsWith(".tgz"));
  assert.ok(filename, `pnpm pack did not report a tarball for ${packageRoot}`);
  return path.join(packRoot, path.basename(filename));
}

async function resetFixture(fixture) {
  run("docker", ["compose", "-f", fixture.compose, "down", "-v", "--remove-orphans"], {
    allowFailure: true,
  });
  run("docker", ["compose", "-f", fixture.compose, "up", "-d", fixture.service]);
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const ready = fixture.engine === "postgres"
      ? run("docker", [
        "exec", "-e", "PGPASSWORD=synapsor_reader_password", fixture.container,
        "psql", "-h", "127.0.0.1", "-U", "synapsor_reader",
        "-d", "synapsor_runner_mcp_billing", "-Atc", "SELECT COUNT(*) FROM public.invoices",
      ], { allowFailure: true })
      : run("docker", [
        "exec", "-e", "MYSQL_PWD=synapsor_reader_password", fixture.container,
        "mysql", "-h127.0.0.1", "-usynapsor_reader", "-N", "-B",
        "synapsor_runner_mcp_orders", "-e", "SELECT COUNT(*) FROM orders",
      ], { allowFailure: true });
    if (ready.status === 0) return;
    await delay(250);
  }
  throw new Error(`${fixture.engine} fixture did not become query-ready within 60 seconds`);
}

async function runFirstUseJourney({ cli, fixture, projectRoot }) {
  const started = Date.now();
  const env = {
    ...process.env,
    DATABASE_URL: fixture.databaseUrl,
    TERM: "xterm-256color",
    COLUMNS: "120",
    LINES: "40",
  };
  delete env.SYNAPSOR_TENANT_ID;
  delete env.SYNAPSOR_PRINCIPAL;
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.NO_COLOR;

  const command = `stty cols 120 rows 40; ${shellQuote(cli)} start --from-env DATABASE_URL --cli`;
  const child = spawn("script", ["-qefc", command, "/dev/null"], {
    cwd: projectRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  let output = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  const transcript = () => stripTerminal(`${output}\n${stderr}`);
  const checkpoint = async (pattern, label, timeoutMs = 60_000) => {
    await waitForValue(
      () => pattern.test(transcript()) ? true : undefined,
      timeoutMs,
      () => `${fixture.engine} first-run did not reach ${label}.\n${tail(transcript())}`,
    );
  };

  try {
    await checkpoint(/Quick Start could not prove a conservative connected starter boundary/i, "blocked Quick Start handoff");
    await checkpoint(/blocked:\s*1\s+issue/i, "blocked table row");
    child.stdin.write("\r");

    await checkpoint(new RegExp(`RESOLVE TABLE ACCESS - ${escapeRegExp(fixture.resource)}`), "inline scope resolver");
    await checkpoint(/Record ID\s+id[\s\S]*Tenant isolation\s+tenant_id/i, "source-inspected scope choices");
    child.stdin.write("\r");

    await checkpoint(new RegExp(`REVIEW COLUMNS - ${escapeRegExp(fixture.resource)}`), "column review after scope resolution");
    await checkpoint(/Saved structural review[\s\S]*Agent authority activated: no/i, "disabled structural decision");
    child.stdin.write("\r");

    await checkpoint(/draft changed - activate to use/i, "parent table editor after column review");
    child.stdin.write("c");

    await checkpoint(/REVIEW EXACT BOUNDARY/i, "whole-boundary review");
    await checkpoint(
      /Activate "reviewed_staging" exactly as shown(?: now\? You will stay in \/access\.| and continue to Ask\?) \[Y\/n\]/i,
      "explicit activation prompt",
    );
    child.stdin.write("\r");

    await checkpoint(/ASK YOUR REVIEWED DATA/i, "model and MCP continuation chooser");
    child.stdin.write("\u001b[B\u001b[B\u001b[B\u001b[B\r");
    await checkpoint(/Your reviewed boundaries remain active\./i, "Later handoff");
    await checkpoint(/\/access is still open\./i, "resumed access editor");
    child.stdin.write("q");

    const result = await waitForExit(child, 15_000, () =>
      `${fixture.engine} first-run did not exit cleanly after leaving the resumed access editor.\n${tail(transcript())}`);
    assert.equal(result.code, 0, `${fixture.engine} first-run exited with ${result.code ?? result.signal}`);
    assert.doesNotMatch(transcript(), /cannot be added because record identity or trusted scope is unresolved/i);
    assert.doesNotMatch(transcript(), /Ask did not start:/i);
    assert.doesNotMatch(transcript(), new RegExp(escapeRegExp(fixture.databaseUrl)));
    return { elapsedMs: Date.now() - started };
  } finally {
    if (child.exitCode === null) {
      killProcessGroup(child.pid, "SIGTERM");
      await waitForExit(child, 3_000, () => "").catch(() => {
        killProcessGroup(child.pid, "SIGKILL");
      });
    }
  }
}

function sourceSnapshot(fixture) {
  if (fixture.engine === "postgres") {
    return run("docker", [
      "exec", fixture.container,
      "psql", "-U", "synapsor_admin", "-d", "synapsor_runner_mcp_billing", "-Atc",
      "SELECT string_agg(id || '|' || tenant_id || '|' || status || '|' || late_fee_cents::text || '|' || coalesce(waiver_reason, ''), E'\\n' ORDER BY id) FROM public.invoices",
    ]).stdout.trim();
  }
  return run("docker", [
    "exec", "-e", "MYSQL_PWD=root_password", fixture.container,
    "mysql", "-uroot", "-N", "-B", "synapsor_runner_mcp_orders", "-e",
    "SELECT GROUP_CONCAT(CONCAT_WS('|', id, tenant_id, status, refund_review_status, COALESCE(refund_note, '')) ORDER BY id SEPARATOR '\\n') FROM orders",
  ]).stdout.trim();
}

function assertProjectHasNoCredential(projectRoot, databaseUrl) {
  const text = collectText(projectRoot);
  assert.doesNotMatch(text, new RegExp(escapeRegExp(databaseUrl)));
  assert.doesNotMatch(text, /synapsor_reader_password/);
}

function collectText(rootPath) {
  return fs.readdirSync(rootPath, { withFileTypes: true })
    .map((entry) => {
      const resolved = path.join(rootPath, entry.name);
      if (entry.isDirectory()) return collectText(resolved);
      if (entry.name.endsWith(".db") || fs.statSync(resolved).size > 2_000_000) return "";
      return fs.readFileSync(resolved, "utf8");
    })
    .join("\n");
}

function stripTerminal(value) {
  return value
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "");
}

function tail(value, lines = 100) {
  return value.split("\n").slice(-lines).join("\n");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function waitForExit(child, timeoutMs, failure) {
  if (child.exitCode !== null) return { code: child.exitCode, signal: child.signalCode };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(failure()));
    }, timeoutMs);
    const onExit = (code, signal) => {
      cleanup();
      resolve({ code, signal });
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
    };
    child.on("exit", onExit);
  });
}

async function waitForValue(read, timeoutMs, failure) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await delay(50);
  }
  throw new Error(failure());
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? result.error?.message})\n`
      + `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}
