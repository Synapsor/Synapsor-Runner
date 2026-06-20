import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = path.join(root, "tmp", "runner-smoke");
const examples = {
  postgres: {
    dir: path.join(root, "examples", "postgres-support"),
    job: path.join(root, "examples", "postgres-support", "job.approved.json"),
    env: {
      SYNAPSOR_ENGINE: "postgres",
      SYNAPSOR_DATABASE_URL: "postgresql://synapsor_writer:synapsor_writer_password@localhost:55432/synapsor_runner_demo"
    },
    conflictValue: "1999-01-01T00:00:00Z",
    disallowedColumn: "internal_notes"
  },
  mysql: {
    dir: path.join(root, "examples", "mysql-orders"),
    job: path.join(root, "examples", "mysql-orders", "job.approved.json"),
    env: {
      SYNAPSOR_ENGINE: "mysql",
      SYNAPSOR_DATABASE_URL: "mysql://synapsor_writer:synapsor_writer_password@localhost:53306/synapsor_runner_demo"
    },
    conflictValue: "1999-01-01 00:00:00",
    disallowedColumn: "credit_card_note"
  }
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || root,
    env: { ...process.env, ...(options.env || {}) },
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit"
  });
  if (options.expectFailure) {
    if (result.status === 0) {
      throw new Error(`${command} ${args.join(" ")} unexpectedly succeeded`);
    }
    return result;
  }
  if (options.allowFailure) return result;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with code ${result.status}\n${result.stderr || ""}`);
  }
  return result;
}

function runner(args, env, options = {}) {
  return run("corepack", ["pnpm", "runner", ...args], { ...options, env, capture: true });
}

function readJob(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJob(name, job) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(job, null, 2)}\n`);
  return file;
}

function parseJsonResult(result) {
  const json = result.stdout.match(/\{[\s\S]*\}\s*$/)?.[0];
  try {
    if (!json) throw new Error("missing JSON payload");
    return JSON.parse(json);
  } catch (error) {
    throw new Error(`runner output was not JSON:\n${result.stdout}\n${result.stderr}`);
  }
}

async function startControlPlaneStub() {
  const script = `
const http = require("node:http");
const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url === "/v1/writeback/runner/doctor") {
    const authorization = request.headers.authorization || "";
    if (authorization !== "Bearer syn_wbr_local_smoke") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "invalid_writeback_runner_token" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      kind: "writeback_runner",
      source_id: "src_local_smoke",
      runner_id: "runner_local_smoke",
      permissions: ["writeback:claim", "writeback:heartbeat", "writeback:result"]
    }));
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: false, error: "not_found" }));
});
server.listen(8000, "127.0.0.1", () => process.stdout.write("ready\\n"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
`;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("control-plane stub did not start")), 5000);
    child.once("error", reject);
    child.stdout.once("data", (chunk) => {
      if (String(chunk).includes("ready")) {
        clearTimeout(timeout);
        resolve(undefined);
      }
    });
  });
  return child;
}

async function waitForDoctor(engine, config) {
  let lastError = "";
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const result = runner(["doctor"], {
      ...config.env,
      SYNAPSOR_CONTROL_PLANE_URL: "http://localhost:8000",
      SYNAPSOR_RUNNER_TOKEN: "syn_wbr_local_smoke",
      SYNAPSOR_SOURCE_ID: `src_${engine}_local_smoke`,
      SYNAPSOR_RUNNER_ID: `runner_${engine}_local_smoke`
    }, { allowFailure: true });
    if (result.status === 0) return;
    lastError = result.stderr || result.stdout || `exit ${result.status}`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${engine} fixture did not become ready: ${lastError}`);
}

async function smokeEngine(engine, config) {
  const env = {
    ...config.env,
    SYNAPSOR_CONTROL_PLANE_URL: "http://localhost:8000",
    SYNAPSOR_RUNNER_TOKEN: "syn_wbr_local_smoke",
    SYNAPSOR_SOURCE_ID: `src_${engine}_local_smoke`,
    SYNAPSOR_RUNNER_ID: `runner_${engine}_local_smoke`
  };

  console.log(`\n== ${engine}: start fixture ==`);
  run("docker", ["compose", "down", "-v"], { cwd: config.dir });
  run("docker", ["compose", "up", "-d"], { cwd: config.dir });
  await waitForDoctor(engine, config);

  console.log(`== ${engine}: validate fixture job ==`);
  runner(["validate", "--job", config.job], env);

  console.log(`== ${engine}: apply approved job ==`);
  const applied = parseJsonResult(runner(["apply", "--job", config.job], env));
  if (applied.status !== "applied" || applied.affected_rows !== 1) {
    throw new Error(`${engine} expected first apply to affect one row, got ${JSON.stringify(applied)}`);
  }

  console.log(`== ${engine}: idempotent retry ==`);
  const retry = parseJsonResult(runner(["apply", "--job", config.job], env));
  if (retry.status !== "applied" || retry.affected_rows !== 0) {
    throw new Error(`${engine} expected idempotent retry with zero affected rows, got ${JSON.stringify(retry)}`);
  }

  const base = readJob(config.job);
  const stale = {
    ...base,
    job_id: `${base.job_id}_stale`,
    idempotency_key: `${base.idempotency_key}_stale`,
    conflict_guard: { ...base.conflict_guard, expected_value: config.conflictValue }
  };
  const staleFile = writeJob(`${engine}-stale`, stale);
  console.log(`== ${engine}: stale-version conflict ==`);
  const staleResult = parseJsonResult(runner(["apply", "--job", staleFile], env));
  if (staleResult.status !== "conflict" || staleResult.error_code !== "VERSION_CONFLICT") {
    throw new Error(`${engine} expected VERSION_CONFLICT, got ${JSON.stringify(staleResult)}`);
  }

  const tenantMismatch = {
    ...base,
    job_id: `${base.job_id}_tenant_mismatch`,
    idempotency_key: `${base.idempotency_key}_tenant_mismatch`,
    target: {
      ...base.target,
      tenant_guard: { ...base.target.tenant_guard, value: "otherco" }
    }
  };
  const tenantFile = writeJob(`${engine}-tenant-mismatch`, tenantMismatch);
  console.log(`== ${engine}: tenant mismatch rejection ==`);
  const tenantResult = parseJsonResult(runner(["apply", "--job", tenantFile], env));
  if (tenantResult.status !== "conflict" || tenantResult.error_code !== "ROW_NOT_FOUND") {
    throw new Error(`${engine} expected ROW_NOT_FOUND for tenant mismatch, got ${JSON.stringify(tenantResult)}`);
  }

  const disallowed = {
    ...base,
    job_id: `${base.job_id}_disallowed`,
    idempotency_key: `${base.idempotency_key}_disallowed`,
    patch: { ...base.patch, [config.disallowedColumn]: "should not pass" }
  };
  const disallowedFile = writeJob(`${engine}-disallowed-column`, disallowed);
  console.log(`== ${engine}: disallowed column validation ==`);
  const invalid = runner(["validate", "--job", disallowedFile], env, { expectFailure: true });
  if (!/patch column not allowed/i.test(invalid.stderr || invalid.stdout || "")) {
    throw new Error(`${engine} expected disallowed-column validation error, got ${invalid.stderr || invalid.stdout}`);
  }
}

const controlPlaneStub = await startControlPlaneStub();

try {
  for (const [engine, config] of Object.entries(examples)) {
    await smokeEngine(engine, config);
  }
  console.log("\nLocal Postgres and MySQL runner smoke tests passed.");
} finally {
  controlPlaneStub.kill("SIGTERM");
  for (const config of Object.values(examples)) {
    run("docker", ["compose", "down", "-v"], { cwd: config.dir });
  }
}
