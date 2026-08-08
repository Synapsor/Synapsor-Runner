import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Pool } from "pg";
import { inspectDatabase } from "../packages/schema-inspector/dist/index.js";
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  writeAutoBoundaryArtifacts,
} from "../apps/runner/dist/auto-boundary.js";
import {
  assertProductionExploreStartup,
} from "../apps/runner/dist/mcp-runtime.js";
import { derivedScopeIndexDoctorChecks } from "../apps/runner/dist/derived-scope-index-doctor.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixture = path.join(root, "examples/auto-boundary-churn");
const compose = path.join(fixture, "docker-compose.yml");
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-production-explore-http-"));
const singleOrganizationProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "synapsor-production-explore-single-org-http-"));
const readUrl = "postgresql://synapsor_churn_reader:synapsor_churn_reader_password@127.0.0.1:55460/synapsor_auto_boundary";
const adminUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55460/synapsor_auto_boundary";
const controlUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55460/postgres";
const controlSchema = `synapsor_production_explore_${process.pid}`;

function assert(condition, message, detail) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return result;
}

async function findFreePort() {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a loopback port for the production Explore CLI verifier."));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startProductionExploreCli(configPath, env) {
  const port = await findFreePort();
  const invocation = productionExploreRunnerInvocation([
    "mcp",
    "serve",
    "--transport",
    "streamable-http",
    "--production-explore",
    "--config",
    configPath,
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--trusted-tls-proxy",
  ]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`Production Explore CLI did not become ready.\n${stdout}\n${stderr}`));
    }, 30_000);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const inspect = () => {
      if (settled) return;
      const match = stderr.match(/Synapsor Runner Streamable HTTP MCP listening on (https?:\/\/\S+)/);
      if (!match || !stderr.includes("PRODUCTION EXPLORE READY")) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ child, url: match[1], stdout: () => stdout, stderr: () => stderr });
    };
    child.stdout.on("data", (chunk) => {
      stdout = `${stdout}${chunk}`.slice(-40_000);
      inspect();
    });
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-40_000);
      inspect();
    });
    child.once("error", fail);
    child.once("exit", (code, signal) => {
      fail(new Error(`Production Explore CLI exited before readiness (${code ?? signal}).\n${stdout}\n${stderr}`));
    });
  });
}

function productionExploreRunnerInvocation(args) {
  const packedRunner = process.env.SYNAPSOR_PRODUCTION_EXPLORE_RUNNER?.trim();
  return packedRunner
    ? { command: packedRunner, args }
    : { command: process.execPath, args: [path.join(root, "apps/runner/dist/cli.js"), ...args] };
}

async function stopProductionExploreCli(handle) {
  if (!handle || handle.child.exitCode !== null || handle.child.signalCode !== null) return;
  await new Promise((resolve) => {
    const timeout = setTimeout(() => handle.child.kill("SIGKILL"), 5_000);
    handle.child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    handle.child.kill("SIGTERM");
  });
}

async function sourceSnapshot(pool) {
  const churn = await pool.query(`
    SELECT COUNT(*)::int AS row_count,
      md5(string_agg(id || ':' || tenant_id || ':' || owner_id || ':' || reason_category || ':' || monthly_revenue_cents::text, '|' ORDER BY id)) AS digest
    FROM public.churn_events
  `);
  const derived = await pool.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.scoped_orders) AS order_count,
      (SELECT COUNT(*)::int FROM public.scoped_order_items) AS item_count,
      (SELECT md5(string_agg(id || ':' || order_id || ':' || item_kind || ':' || quantity::text, '|' ORDER BY id))
        FROM public.scoped_order_items) AS item_digest
  `);
  const sharedReference = await pool.query(`
    SELECT COUNT(*)::int AS row_count,
      md5(string_agg(id || ':' || category, '|' ORDER BY id)) AS digest
    FROM public.shared_product_catalog
  `);
  return {
    churn: churn.rows[0],
    derived: derived.rows[0],
    shared_reference: sharedReference.rows[0],
  };
}

async function seedDerivedSource(pool) {
  await pool.query(`
    DROP TABLE IF EXISTS public.scoped_order_items;
    DROP TABLE IF EXISTS public.scoped_orders;
    DROP TABLE IF EXISTS public.shared_product_catalog;
    CREATE TABLE public.scoped_orders (
      id text PRIMARY KEY,
      tenant_id text NOT NULL,
      owner_id text NOT NULL,
      category text NOT NULL CHECK (category IN ('enterprise', 'trail')),
      occurred_at timestamptz NOT NULL
    );
    CREATE TABLE public.scoped_order_items (
      id text PRIMARY KEY,
      order_id text NOT NULL,
      item_kind text NOT NULL CHECK (item_kind IN ('standard')),
      quantity integer NOT NULL CHECK (quantity > 0),
      occurred_at timestamptz NOT NULL,
      CONSTRAINT scoped_order_items_order_id_fkey
        FOREIGN KEY (order_id) REFERENCES public.scoped_orders(id) ON DELETE RESTRICT
    );
    CREATE INDEX scoped_order_items_order_id_idx ON public.scoped_order_items (order_id);
    CREATE INDEX scoped_orders_tenant_id_idx ON public.scoped_orders (tenant_id);
    CREATE INDEX scoped_orders_owner_id_idx ON public.scoped_orders (owner_id);
    CREATE TABLE public.shared_product_catalog (
      id text PRIMARY KEY,
      category text NOT NULL CHECK (category IN ('hardware', 'software')),
      internal_notes text NOT NULL
    );
    INSERT INTO public.scoped_orders (id, tenant_id, owner_id, category, occurred_at) VALUES
      ('derived-acme-order', 'acme', 'derived-acme', 'trail', '2026-07-01T00:00:00Z'),
      ('derived-globex-order', 'globex', 'derived-globex', 'enterprise', '2026-07-01T00:00:00Z');
    INSERT INTO public.scoped_orders (id, tenant_id, owner_id, category, occurred_at)
    SELECT 'fanout-acme-order-' || item, 'acme', 'fanout-acme', 'trail', '2026-07-01T00:00:00Z'::timestamptz
      FROM generate_series(1, 5) AS item;
    INSERT INTO public.scoped_order_items (id, order_id, item_kind, quantity, occurred_at)
    SELECT 'derived-acme-item-' || item, 'derived-acme-order', 'standard', item, '2026-07-01T00:00:00Z'::timestamptz
      FROM generate_series(1, 5) AS item;
    INSERT INTO public.scoped_order_items (id, order_id, item_kind, quantity, occurred_at)
    SELECT 'derived-globex-item-' || item, 'derived-globex-order', 'standard', item, '2026-07-01T00:00:00Z'::timestamptz
      FROM generate_series(1, 7) AS item;
    INSERT INTO public.scoped_order_items (id, order_id, item_kind, quantity, occurred_at)
    SELECT 'fanout-acme-item-' || item, 'fanout-acme-order-' || item, 'standard', item, '2026-07-01T00:00:00Z'::timestamptz
      FROM generate_series(1, 5) AS item;
    INSERT INTO public.shared_product_catalog (id, category, internal_notes)
    SELECT 'hardware-' || item, 'hardware', 'operator-only hardware note ' || item
      FROM generate_series(1, 6) AS item;
    INSERT INTO public.shared_product_catalog (id, category, internal_notes)
    SELECT 'software-' || item, 'software', 'operator-only software note ' || item
      FROM generate_series(1, 6) AS item;
    ALTER TABLE public.scoped_orders ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.scoped_orders FORCE ROW LEVEL SECURITY;
    CREATE POLICY scoped_orders_trusted_scope ON public.scoped_orders
      FOR SELECT
      USING (
        tenant_id = current_setting('app.tenant_id', true)
        AND owner_id = current_setting('app.principal', true)
      );
    GRANT SELECT ON public.scoped_orders, public.scoped_order_items, public.shared_product_catalog TO synapsor_churn_reader;
  `);
}

async function seedSingleOrganizationSource(pool) {
  await pool.query(`
    DROP SCHEMA IF EXISTS single_org_http CASCADE;
    CREATE SCHEMA single_org_http;
    CREATE TABLE single_org_http.activity (
      id text PRIMARY KEY,
      category text NOT NULL CHECK (category IN ('billing', 'support')),
      amount_cents integer NOT NULL CHECK (amount_cents >= 0),
      occurred_at timestamptz NOT NULL
    );
    INSERT INTO single_org_http.activity (id, category, amount_cents, occurred_at)
    SELECT 'billing-' || item, 'billing', item * 100, '2026-08-01T00:00:00Z'::timestamptz + item * interval '1 hour'
      FROM generate_series(1, 6) AS item;
    INSERT INTO single_org_http.activity (id, category, amount_cents, occurred_at)
    SELECT 'support-' || item, 'support', item * 200, '2026-08-02T00:00:00Z'::timestamptz + item * interval '1 hour'
      FROM generate_series(1, 6) AS item;
    GRANT USAGE ON SCHEMA single_org_http TO synapsor_churn_reader;
    GRANT SELECT ON single_org_http.activity TO synapsor_churn_reader;
  `);
}

async function singleOrganizationSourceSnapshot(pool) {
  const result = await pool.query(`
    SELECT COUNT(*)::int AS row_count,
      SUM(amount_cents)::bigint AS amount_cents,
      md5(string_agg(id || ':' || category || ':' || amount_cents::text || ':' || occurred_at::text, '|' ORDER BY id)) AS digest
    FROM single_org_http.activity
  `);
  return result.rows[0];
}

function resultPayload(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (typeof text !== "string") throw new Error("MCP result did not contain structured content.");
  return JSON.parse(text);
}

function narrowResource(resource) {
  resource.selectable_fields = ["reason_category", "monthly_revenue_cents", "churned_at"];
  resource.filterable_fields = Object.fromEntries(Object.entries(resource.filterable_fields)
    .filter(([field]) => resource.selectable_fields.includes(field)));
  resource.sortable_fields = resource.sortable_fields.filter((field) => resource.selectable_fields.includes(field));
  resource.groupable_fields = resource.groupable_fields.filter((field) => field === "reason_category");
  resource.aggregate_measures = resource.aggregate_measures.filter((field) => field === "monthly_revenue_cents");
  resource.count_distinct_fields = resource.count_distinct_fields.filter((field) => field === "id");
  resource.time_bucket_fields = Object.fromEntries(Object.entries(resource.time_bucket_fields)
    .filter(([field]) => field === "churned_at"));
  resource.relationships = [];
}

function narrowDerivedResources(parent, child) {
  parent.selectable_fields = ["category", "occurred_at"];
  parent.filterable_fields = Object.fromEntries(Object.entries(parent.filterable_fields)
    .filter(([field]) => parent.selectable_fields.includes(field)));
  parent.sortable_fields = parent.sortable_fields.filter((field) => parent.selectable_fields.includes(field));
  parent.groupable_fields = parent.groupable_fields.filter((field) => field === "category");
  parent.aggregate_measures = [];
  parent.time_bucket_fields = Object.fromEntries(Object.entries(parent.time_bucket_fields)
    .filter(([field]) => field === "occurred_at"));

  child.selectable_fields = ["item_kind", "quantity", "occurred_at"];
  child.filterable_fields = Object.fromEntries(Object.entries(child.filterable_fields)
    .filter(([field]) => child.selectable_fields.includes(field)));
  child.sortable_fields = child.sortable_fields.filter((field) => child.selectable_fields.includes(field));
  child.groupable_fields = child.groupable_fields.filter((field) => field === "item_kind");
  child.aggregate_measures = child.aggregate_measures.filter((field) => field === "quantity");
  child.time_bucket_fields = Object.fromEntries(Object.entries(child.time_bucket_fields)
    .filter(([field]) => field === "occurred_at"));
  child.relationships = child.relationships.filter((relationship) =>
    relationship.id === "scoped_order_items_order_id_fkey");
}

async function token(privateKey, { tenant, principal, scope = "synapsor.explore" }) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "production-explore-test" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    tenant_id: tenant,
    scope,
    iss: "https://identity.example",
    aud: "https://runner.example/mcp",
    iat: now,
    exp: now + 600,
    ...(principal !== undefined ? { sub: principal } : {}),
  })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), privateKey).toString("base64url");
  return `${unsigned}.${signature}`;
}

function clientFor(url, bearer, query = {}) {
  const endpoint = new URL(url);
  for (const [key, value] of Object.entries(query)) endpoint.searchParams.set(key, value);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: {
        authorization: `Bearer ${bearer}`,
        "x-synapsor-tenant-id": "header-tenant-must-not-win",
        "x-synapsor-principal": "header-principal-must-not-win",
      },
    },
  });
  return {
    client: new Client({ name: "production-explore-verifier", version: "1.0.0" }),
    transport,
  };
}

async function verifySingleOrganizationProductionExplore(input) {
  const { admin, controlSchema, controlUrl, privateKey, publicKeyPem } = input;
  const clients = [];
  let server;
  await seedSingleOrganizationSource(admin);
  const before = await singleOrganizationSourceSnapshot(admin);
  const env = {
    ...process.env,
    DATABASE_URL: readUrl,
    SYNAPSOR_CONTROL_DATABASE_URL: controlUrl,
    SYNAPSOR_SESSION_PUBLIC_KEY: publicKeyPem,
    SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY: "single-organization-budget-hmac-key-material-1234567890",
  };
  delete env.SYNAPSOR_TENANT_ID;
  try {
    const inspection = await inspectDatabase({
      engine: "postgres",
      databaseUrlEnv: "DATABASE_URL",
      schema: "single_org_http",
      env,
    });
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: singleOrganizationProjectRoot,
        package_manager: "pnpm",
        frameworks: ["node"],
        schema_inputs: [],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      inspectedSchema: "single_org_http",
      deploymentProfile: "production",
      httpClaims: { principalClaim: "sub" },
      singleOrganization: { organizationId: "internal-finance" },
    });
    await writeAutoBoundaryArtifacts({ projectRoot: singleOrganizationProjectRoot, build });
    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.name = "internal_finance_production";
    assert(candidate.pack.resources.length === 1
      && candidate.pack.resources[0].id === "single_org_http.activity"
      && candidate.pack.resources[0].tenant_key === undefined
      && candidate.pack.resources[0].tenant_scope === undefined,
    "Single-organization production boundary did not retain one tenant-free reviewed resource.", candidate);
    candidate.budgets.max_queries_per_session = 1;
    candidate.budgets.rate_limit_per_minute = 10;
    candidate.budgets.max_extracted_cells_per_session = 100;
    candidate.budgets.max_differencing_queries = 10;
    const digest = explorationBoundaryCandidateDigest(candidate);
    await activateExplorationBoundary({
      projectRoot: singleOrganizationProjectRoot,
      candidate,
      expectedDigest: digest,
      actor: "production-owner@example.test",
      confirmation: `ACTIVATE ${digest}`,
      confirmedDecisions: candidate.unresolved_decisions,
      currentInspection: inspection,
    });

    const runtimeConfig = {
      version: 1,
      mode: "read_only",
      storage: {
        sqlite_path: path.join(singleOrganizationProjectRoot, ".synapsor/local.db"),
        shared_postgres: {
          mode: "runtime_store",
          url_env: "SYNAPSOR_CONTROL_DATABASE_URL",
          schema: controlSchema,
          lock_timeout_ms: 5_000,
          max_entries: 100_000,
        },
      },
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
          statement_timeout_ms: 3_000,
        },
      },
      trusted_context: { provider: "http_claims" },
      session_auth: {
        provider: "jwt_asymmetric",
        algorithms: ["RS256"],
        public_key_env: "SYNAPSOR_SESSION_PUBLIC_KEY",
        issuer: "https://identity.example",
        audience: "https://runner.example/mcp",
        principal_claim: "sub",
      },
      http_security: {
        deployment: "shared",
        channel: "trusted_tls_proxy",
        allowed_hosts: ["127.0.0.1"],
        oauth_resource: {
          resource: "https://runner.example/mcp",
          authorization_servers: ["https://identity.example"],
          scopes_supported: ["synapsor.explore"],
          required_scopes: ["synapsor.explore"],
        },
      },
      production_explore: {
        enabled: true,
        project_root: singleOrganizationProjectRoot,
        required_oauth_scope: "synapsor.explore",
        budget_hmac_key_env: "SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY",
        accounting_namespace: "verify.production.explore.single-organization",
        single_organization_id: "internal-finance",
        source_max_connections: 2,
        max_sessions_per_principal: 2,
        tenant_limits: {
          max_queries_per_rolling_24_hours: 100,
          max_extracted_cells_per_rolling_24_hours: 10_000,
          max_differencing_queries_per_rolling_24_hours: 100,
          requests_per_minute: 100,
          max_response_cells_per_response: 500,
        },
      },
    };
    const mismatchConfig = structuredClone(runtimeConfig);
    mismatchConfig.production_explore.single_organization_id = "different-organization";
    let mismatchError = "";
    try {
      await assertProductionExploreStartup(mismatchConfig, env);
    } catch (error) {
      mismatchError = String(error);
    }
    assert(/claim bindings do not match|not ready/i.test(mismatchError),
      "A runtime configured for a different fixed organization did not fail closed.", mismatchError);

    const posture = await assertProductionExploreStartup(runtimeConfig, env);
    assert(posture.ok
      && posture.tools.join(",") === "app.describe_data,app.explore_data"
      && posture.checks.some((check) => check.name === "verified-principal-scope"
        && check.ok && check.message.includes("internal-finance")),
    "Single-organization production startup did not attest principal-only JWT scope.", posture);
    const configPath = path.join(singleOrganizationProjectRoot, "synapsor.runner.json");
    fs.writeFileSync(configPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");
    server = await startProductionExploreCli(configPath, env);

    const alice = clientFor(server.url, await token(privateKey, { tenant: undefined, principal: "analyst-a" }));
    clients.push(alice.client);
    await alice.client.connect(alice.transport);
    const tools = await alice.client.listTools();
    assert(tools.tools.map((tool) => tool.name).join(",") === "app.describe_data,app.explore_data",
      "Single-organization MCP exposed more than the two reviewed Explore tools.", tools.tools);
    const described = resultPayload(await alice.client.callTool({
      name: "app.describe_data",
      arguments: {},
    }));
    const describedText = JSON.stringify(described);
    assert(describedText.includes("single_organization")
      && !describedText.includes("internal-finance"),
    "Model-facing catalog did not report the fixed posture safely.", described);
    assert(described.resources?.[0]?.id === "single_org_http.activity"
      && !("label" in described.resources[0])
      && !("plan_resource" in described.resources[0]),
    "Production describe_data did not publish one canonical resource id.", described);
    const plan = {
      kind: "aggregate",
      resource: "activity",
      measures: [{ function: "count" }, { function: "sum", field: "amount_cents" }],
      dimensions: [{ field: "category" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const aliceResult = resultPayload(await alice.client.callTool({
      name: "app.explore_data",
      arguments: { plan },
    }));
    assert(aliceResult.ok === true
      && aliceResult.source_database_changed === false
      && aliceResult.data.length === 2
      && aliceResult.data.reduce((sum, row) => sum + row.count, 0) === 12,
    "Principal-only JWT production Explore did not resolve an unambiguous table alias.", aliceResult);
    const exhausted = await alice.client.callTool({ name: "app.explore_data", arguments: { plan } });
    assert(exhausted.isError === true && JSON.stringify(exhausted).includes("authenticated principal"),
      "The single-organization principal did not exhaust only its own reviewed budget.", exhausted);

    const bob = clientFor(server.url, await token(privateKey, { tenant: undefined, principal: "analyst-b" }));
    clients.push(bob.client);
    await bob.client.connect(bob.transport);
    const bobResult = resultPayload(await bob.client.callTool({ name: "app.explore_data", arguments: { plan } }));
    assert(bobResult.ok === true && bobResult.data.length === 2,
      "A second principal was starved by the first principal in the fixed organization.", bobResult);

    const missingPrincipal = clientFor(server.url, await token(privateKey, { tenant: undefined, principal: undefined }));
    await missingPrincipal.client.connect(missingPrincipal.transport)
      .then(() => { throw new Error("JWT without a principal unexpectedly initialized single-organization production Explore."); })
      .catch((error) => assert(/401|unauthorized/i.test(String(error)),
        "Single-organization production Explore did not require a verified principal.", String(error)));
    const after = await singleOrganizationSourceSnapshot(admin);
    assert(JSON.stringify(after) === JSON.stringify(before),
      "Single-organization production Explore mutated its source database.", { before, after });
    return {
      tools: tools.tools.map((tool) => tool.name),
      principal_only_jwt: true,
      fixed_organization: true,
      principal_budget_isolated: true,
      source_database_changed: false,
    };
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopProductionExploreCli(server).catch(() => undefined);
  }
}

async function main() {
  fs.cpSync(fixture, projectRoot, { recursive: true });
  run("docker", ["compose", "-f", compose, "up", "-d", "--wait", "postgres"], { inherit: true });
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  const control = new Pool({ connectionString: controlUrl, max: 1 });
  let server;
  const clients = [];
  try {
    if (process.env.SYNAPSOR_SKIP_PRODUCTION_EXPLORE_ACCOUNTING_TEST !== "1") {
      run("corepack", [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--maxWorkers=1",
        "--minWorkers=1",
        "--testTimeout=30000",
        "--hookTimeout=30000",
        "packages/proposal-store/src/production-explore-postgres.test.ts",
      ], {
        inherit: true,
        env: { ...process.env, SYNAPSOR_TEST_POSTGRES_URL: controlUrl },
      });
    }
    await seedDerivedSource(admin);
    const before = await sourceSnapshot(admin);
    const env = { ...process.env, DATABASE_URL: readUrl };
    const inspection = await inspectDatabase({
      engine: "postgres",
      databaseUrlEnv: "DATABASE_URL",
      env,
    });
    assert(inspection.role_posture?.verified === true && inspection.role_posture.read_only === true,
      "Production Explore fixture reader is not demonstrably read-only.", inspection.role_posture);
    const build = buildAutoBoundary({
      inspection,
      project: {
        root: projectRoot,
        package_manager: "pnpm",
        frameworks: ["node", "nextjs", "prisma"],
        schema_inputs: [{ kind: "prisma", path: "prisma/schema.prisma" }],
        database_env_names: ["DATABASE_URL"],
      },
      sourceEnv: "DATABASE_URL",
      deploymentProfile: "production",
      httpClaims: { tenantClaim: "tenant_id", principalClaim: "sub" },
      overrides: {
        schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
        resources: {
          "public.scoped_order_items": {
            tenant_scope_path: {
              value: "scoped_order_items_order_id_fkey",
              actor: "production-owner@example.test",
              reason: "Every item belongs to the tenant of its required reviewed order.",
              decided_at: "2026-08-05T18:00:00.000Z",
            },
            principal_scope_path: {
              value: "scoped_order_items_order_id_fkey",
              actor: "production-owner@example.test",
              reason: "Every item belongs to the principal of its required reviewed order.",
              decided_at: "2026-08-05T18:00:00.000Z",
            },
          },
          "public.shared_product_catalog": {
            shared_reference_scope: {
              value: SHARED_REFERENCE_ACKNOWLEDGEMENT,
              actor: "production-owner@example.test",
              reason: "This centrally maintained catalog contains the same reviewed rows for every tenant.",
              decided_at: "2026-08-07T12:00:00.000Z",
            },
          },
        },
      },
    });
    await writeAutoBoundaryArtifacts({ projectRoot, build });
    const candidate = structuredClone(build.exploration_boundary);
    candidate.pack.name = "customer_churn_production";
    candidate.pack.resources = candidate.pack.resources.filter((resource) => [
      "public.churn_events",
      "public.scoped_orders",
      "public.scoped_order_items",
      "public.shared_product_catalog",
    ].includes(resource.id));
    assert(candidate.pack.resources.length === 4,
      "Production fixture did not draft its direct, derived, and shared-reference resources.", candidate.pack.resources);
    const churnResource = candidate.pack.resources.find((resource) => resource.id === "public.churn_events");
    const scopedOrders = candidate.pack.resources.find((resource) => resource.id === "public.scoped_orders");
    const scopedOrderItems = candidate.pack.resources.find((resource) => resource.id === "public.scoped_order_items");
    const sharedProductCatalog = candidate.pack.resources.find((resource) =>
      resource.id === "public.shared_product_catalog");
    assert(churnResource && scopedOrders && scopedOrderItems?.tenant_scope && scopedOrderItems?.principal_scope
      && sharedProductCatalog?.shared_reference_scope?.acknowledgement === SHARED_REFERENCE_ACKNOWLEDGEMENT,
    "Production fixture did not preserve its derived scope and explicit shared-reference authority.", candidate.pack.resources);
    assert(
      JSON.stringify(churnResource.field_enums.reason_category)
        === JSON.stringify(["onboarding", "price", "product", "service"]),
      "PostgreSQL CHECK-constrained values did not reach the reviewed boundary from live schema metadata.",
      churnResource.field_enums,
    );
    narrowResource(churnResource);
    narrowDerivedResources(scopedOrders, scopedOrderItems);
    scopedOrders.derived_measures = [{
      name: "scoped_order_item_count",
      label: "Scoped order item count",
      shape: "child_count_total",
      child_resource: "public.scoped_order_items",
      relationship: "scoped_order_items_order_id_fkey",
    }];
    sharedProductCatalog.selectable_fields = ["category"];
    sharedProductCatalog.filterable_fields = Object.fromEntries(
      Object.entries(sharedProductCatalog.filterable_fields).filter(([field]) => field === "category"),
    );
    sharedProductCatalog.sortable_fields = sharedProductCatalog.sortable_fields
      .filter((field) => field === "category");
    sharedProductCatalog.groupable_fields = sharedProductCatalog.groupable_fields
      .filter((field) => field === "category");
    sharedProductCatalog.aggregate_measures = [];
    sharedProductCatalog.count_distinct_fields = [];
    sharedProductCatalog.time_bucket_fields = {};
    sharedProductCatalog.relationships = [];
    const indexedChecks = derivedScopeIndexDoctorChecks({
      boundaries: [candidate],
      inspectionsBySource: new Map([[candidate.source, [inspection]]]),
    });
    assert(indexedChecks.some((check) => check.name === "derived-scope-indexes:complete"),
      "PostgreSQL live catalog did not attest the indexed derived-scope path.", indexedChecks);
    await admin.query("DROP INDEX public.scoped_order_items_order_id_idx");
    const missingIndexInspection = await inspectDatabase({
      engine: "postgres",
      databaseUrlEnv: "DATABASE_URL",
      env,
    });
    const missingIndexChecks = derivedScopeIndexDoctorChecks({
      boundaries: [candidate],
      inspectionsBySource: new Map([[candidate.source, [missingIndexInspection]]]),
    });
    assert(missingIndexChecks.filter((check) => check.advisory === "warning").length === 2
      && missingIndexChecks.every((check) => check.ok === true)
      && missingIndexChecks.every((check) => check.message.includes("scoped_order_items.order_id"))
      && missingIndexChecks.every((check) => check.message.includes("CREATE INDEX")),
    "PostgreSQL dropped-index advisory did not name both reviewed scope paths without gating them.", missingIndexChecks);
    await admin.query("CREATE INDEX scoped_order_items_order_id_idx ON public.scoped_order_items (order_id)");
    candidate.budgets.max_queries_per_session = 1;
    candidate.budgets.rate_limit_per_minute = 10;
    candidate.budgets.max_extracted_cells_per_session = 100;
    candidate.budgets.max_differencing_queries = 10;
    const boundaryDigest = explorationBoundaryCandidateDigest(candidate);
    await activateExplorationBoundary({
      projectRoot,
      candidate,
      expectedDigest: boundaryDigest,
      actor: "production-owner@example.test",
      confirmation: `ACTIVATE ${boundaryDigest}`,
      confirmedDecisions: candidate.unresolved_decisions,
      currentInspection: inspection,
    });

    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const runtimeConfig = {
      version: 1,
      mode: "read_only",
      storage: {
        sqlite_path: path.join(projectRoot, ".synapsor/local.db"),
        shared_postgres: {
          mode: "runtime_store",
          url_env: "SYNAPSOR_CONTROL_DATABASE_URL",
          schema: controlSchema,
          lock_timeout_ms: 5_000,
          max_entries: 100_000,
        },
      },
      sources: {
        local_postgres: {
          engine: "postgres",
          read_url_env: "DATABASE_URL",
          statement_timeout_ms: 3_000,
        },
      },
      trusted_context: {
        provider: "http_claims",
      },
      session_auth: {
        provider: "jwt_asymmetric",
        algorithms: ["RS256"],
        public_key_env: "SYNAPSOR_SESSION_PUBLIC_KEY",
        issuer: "https://identity.example",
        audience: "https://runner.example/mcp",
        tenant_claim: "tenant_id",
        principal_claim: "sub",
      },
      http_security: {
        deployment: "shared",
        channel: "trusted_tls_proxy",
        allowed_hosts: ["127.0.0.1"],
        oauth_resource: {
          resource: "https://runner.example/mcp",
          authorization_servers: ["https://identity.example"],
          scopes_supported: ["synapsor.explore"],
          required_scopes: ["synapsor.explore"],
        },
      },
      production_explore: {
        enabled: true,
        project_root: projectRoot,
        required_oauth_scope: "synapsor.explore",
        budget_hmac_key_env: "SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY",
        accounting_namespace: "verify.production.explore",
        source_max_connections: 2,
        max_sessions_per_principal: 2,
        tenant_limits: {
          max_queries_per_rolling_24_hours: 100,
          max_extracted_cells_per_rolling_24_hours: 10_000,
          max_differencing_queries_per_rolling_24_hours: 100,
          requests_per_minute: 100,
          max_response_cells_per_response: 500,
        },
      },
    };
    Object.assign(env, {
      SYNAPSOR_CONTROL_DATABASE_URL: controlUrl,
      SYNAPSOR_SESSION_PUBLIC_KEY: publicKeyPem,
      SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY: "shared-production-budget-hmac-key-material-1234567890",
    });

    const posture = await assertProductionExploreStartup(runtimeConfig, env);
    assert(posture.ok && posture.tools.join(",") === "app.describe_data,app.explore_data",
      "Production Explore startup posture did not attest the exact two-tool surface.", posture);
    const configPath = path.join(projectRoot, "synapsor.runner.json");
    fs.writeFileSync(configPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, "utf8");
    const migrationInvocation = productionExploreRunnerInvocation([
      "store",
      "shared-postgres",
      "apply-migration",
      "--schema",
      controlSchema,
      "--url-env",
      "SYNAPSOR_CONTROL_DATABASE_URL",
      "--yes",
    ]);
    run(migrationInvocation.command, migrationInvocation.args, { env });
    const doctorInvocation = productionExploreRunnerInvocation([
      "doctor",
      "--config",
      configPath,
      "--json",
      "--transport",
      "streamable-http",
      "--host",
      "127.0.0.1",
      "--trusted-tls-proxy",
    ]);
    const doctorResult = run(doctorInvocation.command, doctorInvocation.args, { env });
    const doctor = JSON.parse(doctorResult.stdout);
    assert(doctor.ok === true, "Production Explore doctor did not attest deployment readiness.", doctor);
    assert(doctor.tools?.join(",") === "app.describe_data,app.explore_data",
      "Production Explore doctor did not report the exact model-facing tool surface.", doctor.tools);
    assert(doctor.checks?.some((check) => check.name === "production-explore:verified-principal-scope" && check.ok === true),
      "Production Explore doctor did not attest verified tenant/principal scope.", doctor.checks);
    assert(doctor.checks?.some((check) => check.name === "production-explore:source-connection-ceiling"
      && check.ok === true && check.message.includes("2 connections")),
    "Production Explore doctor did not attest the process-wide source connection ceiling.", doctor.checks);
    assert(doctor.checks?.some((check) => check.name === "derived-scope-indexes:complete"
      && check.level === "pass" && check.message.includes("2 reviewed derived-scope paths")),
    "Production Explore doctor did not attest live derived-scope index coverage.", doctor.checks);
    assert(doctor.checks?.some((check) =>
      check.name === "shared-reference:customer_churn_production:public.shared_product_catalog"
      && check.ok === true
      && check.message.includes("no tenant predicate")),
    "Production Explore doctor did not attest the exact reviewed Shared reference.", doctor.checks);
    const doctorSerialized = JSON.stringify(doctor);
    assert(!doctorSerialized.includes(controlUrl)
      && !doctorSerialized.includes(readUrl)
      && !doctorSerialized.includes(env.SYNAPSOR_EXPLORE_BUDGET_HMAC_KEY),
    "Production Explore doctor disclosed a database URL or HMAC key.");
    server = await startProductionExploreCli(configPath, env);

    const plan = {
      kind: "aggregate",
      resource: "public.churn_events",
      measures: [{ function: "count" }],
      dimensions: [{ field: "reason_category" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const aliceToken = await token(privateKey, { tenant: "acme", principal: "pm-1" });
    const alice = clientFor(server.url, aliceToken, { tenant_id: "globex", principal: "pm-2" });
    clients.push(alice.client);
    await alice.client.connect(alice.transport);
    const aliceSecond = clientFor(server.url, aliceToken);
    clients.push(aliceSecond.client);
    await aliceSecond.client.connect(aliceSecond.transport);
    const aliceThird = clientFor(server.url, aliceToken);
    await aliceThird.client.connect(aliceThird.transport)
      .then(() => { throw new Error("One principal exceeded the reviewed concurrent-session ceiling."); })
      .catch((error) => assert(
        /429|principal_session_capacity_exhausted/i.test(String(error)),
        "The per-principal session ceiling did not return a clear refusal.",
        String(error),
      ));
    const tools = await alice.client.listTools();
    assert(tools.tools.map((tool) => tool.name).join(",") === "app.describe_data,app.explore_data",
      "Production MCP exposed more than the reviewed two-tool surface.", tools.tools);
    assert(tools.tools.every((tool) => tool._meta?.["synapsor.production_explore"] === true
      && tool._meta?.["synapsor.raw_sql_exposed"] === false
      && tool._meta?.["synapsor.approval_tool"] === false
      && tool._meta?.["synapsor.commit_tool"] === false),
    "Production MCP tool metadata did not preserve the read-only boundary.", tools.tools);

    const aliceResult = resultPayload(await alice.client.callTool({
      name: "app.explore_data",
      arguments: { plan },
    }));
    assert(aliceResult.ok === true && aliceResult.source_database_changed === false,
      "Production Explore did not return a verified read-only result.", aliceResult);
    assert(aliceResult.privacy?.suppressed_groups === 1,
      "Production Explore did not suppress the sub-threshold product cohort.", aliceResult);
    assert(!Object.hasOwn(aliceResult, "protect"), "Remote production Explore exposed local Protect authority.");
    const aliceSerialized = JSON.stringify(aliceResult);
    assert(!aliceSerialized.match(/globex|pm-2|@example\.invalid|synthetic kept-out|SELECT\s/i),
      "Production result leaked another scope, kept-out values, or SQL.", aliceResult);

    const exhausted = await alice.client.callTool({ name: "app.explore_data", arguments: { plan } });
    assert(exhausted.isError === true && JSON.stringify(exhausted).includes("authenticated principal"),
      "One principal did not exhaust only its own reviewed query budget.", exhausted);

    const bobToken = await token(privateKey, { tenant: "acme", principal: "pm-other" });
    const bob = clientFor(server.url, bobToken);
    clients.push(bob.client);
    await bob.client.connect(bob.transport);
    const bobResult = resultPayload(await bob.client.callTool({ name: "app.explore_data", arguments: { plan } }));
    assert(bobResult.ok === true && bobResult.data.length === 0,
      "A second principal was starved by the first principal or read the first principal's rows.", bobResult);

    const globexToken = await token(privateKey, { tenant: "globex", principal: "pm-2" });
    const globex = clientFor(server.url, globexToken);
    clients.push(globex.client);
    await globex.client.connect(globex.transport);
    const globexResult = resultPayload(await globex.client.callTool({ name: "app.explore_data", arguments: { plan } }));
    assert(globexResult.ok === true
      && globexResult.data.length === 1
      && globexResult.data[0].reason_category === "price"
      && globexResult.data[0].count === 8,
    "Verified tenant/principal claims did not isolate the Globex result.", globexResult);

    const sharedReferencePlan = {
      kind: "aggregate",
      resource: "public.shared_product_catalog",
      measures: [{ function: "count" }],
      dimensions: [{ field: "category" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const sharedAcme = clientFor(server.url, await token(privateKey, {
      tenant: "acme",
      principal: "shared-reference-acme",
    }));
    clients.push(sharedAcme.client);
    await sharedAcme.client.connect(sharedAcme.transport);
    const sharedAcmeResult = resultPayload(await sharedAcme.client.callTool({
      name: "app.explore_data",
      arguments: { plan: sharedReferencePlan },
    }));
    const sharedGlobex = clientFor(server.url, await token(privateKey, {
      tenant: "globex",
      principal: "shared-reference-globex",
    }));
    clients.push(sharedGlobex.client);
    await sharedGlobex.client.connect(sharedGlobex.transport);
    const sharedGlobexResult = resultPayload(await sharedGlobex.client.callTool({
      name: "app.explore_data",
      arguments: { plan: sharedReferencePlan },
    }));
    const expectedSharedData = [
      { category: "hardware", count: 6 },
      { category: "software", count: 6 },
    ];
    const sharedAcmeData = [...(sharedAcmeResult.data ?? [])]
      .sort((left, right) => left.category.localeCompare(right.category));
    const sharedGlobexData = [...(sharedGlobexResult.data ?? [])]
      .sort((left, right) => left.category.localeCompare(right.category));
    assert(sharedAcmeResult.ok === true
      && sharedGlobexResult.ok === true
      && JSON.stringify(sharedAcmeData) === JSON.stringify(expectedSharedData)
      && JSON.stringify(sharedGlobexData) === JSON.stringify(expectedSharedData)
      && sharedAcmeResult.source_database_changed === false
      && sharedGlobexResult.source_database_changed === false,
    "Production HTTP Shared reference did not return the same reviewed global rows to two JWT tenants.", {
      sharedAcmeResult,
      sharedGlobexResult,
    });
    assert(!JSON.stringify([sharedAcmeResult, sharedGlobexResult]).match(/operator-only|internal_notes|SELECT\s/i),
      "Production HTTP Shared reference leaked a kept-out field or compiled SQL.", {
        sharedAcmeResult,
        sharedGlobexResult,
      });

    const derivedPlan = {
      kind: "aggregate",
      resource: "public.scoped_order_items",
      measures: [{ function: "count" }, { function: "sum", field: "quantity" }],
      dimensions: [{
        field: "category",
        relationship: "scoped_order_items_order_id_fkey",
      }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    };
    const derivedAcme = clientFor(server.url, await token(privateKey, {
      tenant: "acme",
      principal: "derived-acme",
    }));
    clients.push(derivedAcme.client);
    await derivedAcme.client.connect(derivedAcme.transport);
    const derivedAcmeResult = resultPayload(await derivedAcme.client.callTool({
      name: "app.explore_data",
      arguments: { plan: derivedPlan },
    }));
    assert(derivedAcmeResult.ok === true
      && derivedAcmeResult.data.length === 1
      && derivedAcmeResult.data[0].scoped_orders_category === "trail"
      && derivedAcmeResult.data[0].count === 5,
    "PostgreSQL production Explore did not isolate a normalized child through its mandatory scope path.", derivedAcmeResult);
    assert(!JSON.stringify(derivedAcmeResult).match(/globex|enterprise|derived-globex|SELECT\s/i),
      "PostgreSQL derived-scope result leaked another scope or compiled SQL.", derivedAcmeResult);

    const derivedGlobex = clientFor(server.url, await token(privateKey, {
      tenant: "globex",
      principal: "derived-globex",
    }));
    clients.push(derivedGlobex.client);
    await derivedGlobex.client.connect(derivedGlobex.transport);
    const derivedGlobexResult = resultPayload(await derivedGlobex.client.callTool({
      name: "app.explore_data",
      arguments: { plan: derivedPlan },
    }));
    assert(derivedGlobexResult.ok === true
      && derivedGlobexResult.data.length === 1
      && derivedGlobexResult.data[0].scoped_orders_category === "enterprise"
      && derivedGlobexResult.data[0].count === 7,
    "PostgreSQL derived scope did not isolate the second tenant/principal.", derivedGlobexResult);

    const fanoutAcme = clientFor(server.url, await token(privateKey, {
      tenant: "acme",
      principal: "fanout-acme",
    }));
    clients.push(fanoutAcme.client);
    await fanoutAcme.client.connect(fanoutAcme.transport);
    const fanoutResult = resultPayload(await fanoutAcme.client.callTool({
      name: "app.explore_data",
      arguments: {
        plan: {
          kind: "aggregate",
          resource: "public.scoped_orders",
          measures: [{ derived_measure: "scoped_order_item_count" }],
          dimensions: [{ field: "category" }],
          top_n: 10,
        },
      },
    }));
    assert(fanoutResult.ok === true
      && fanoutResult.data.length === 1
      && fanoutResult.data[0].category === "trail"
      && fanoutResult.data[0].scoped_order_item_count === 5
      && fanoutResult.privacy.minimum_cohort_size >= 5,
    "PostgreSQL production HTTP Explore did not execute the reviewed scoped child count.", fanoutResult);
    assert(!JSON.stringify(fanoutResult).match(/globex|derived-acme|SELECT\s/i),
      "PostgreSQL reviewed child count leaked another principal, tenant, or compiled SQL.", fanoutResult);

    const loadClients = await Promise.all(Array.from({ length: 8 }, async (_unused, index) => {
      const handle = clientFor(server.url, await token(privateKey, {
        tenant: "acme",
        principal: `load-principal-${index}`,
      }));
      clients.push(handle.client);
      await handle.client.connect(handle.transport);
      return handle;
    }));
    await Promise.all(loadClients.map((handle) => handle.client.callTool({
      name: "app.explore_data",
      arguments: { plan },
    })));
    const sourceConnections = await admin.query(`
      SELECT COUNT(*)::int AS count
      FROM pg_stat_activity
      WHERE datname = current_database() AND usename = 'synapsor_churn_reader'
    `);
    assert(Number(sourceConnections.rows[0]?.count) <= 2,
      "Production MCP sessions exceeded the process-wide source connection ceiling.", sourceConnections.rows);

    const auditStorage = await control.query(`
      SELECT
        (SELECT COUNT(*)::int FROM "${controlSchema}".production_explore_audit_events) AS dedicated_events,
        (SELECT COUNT(*)::int FROM "${controlSchema}".ledger_entries
          WHERE kind IN ('evidence_bundle', 'evidence_item', 'query_audit')) AS proposal_ledger_events
    `);
    assert(Number(auditStorage.rows[0]?.dedicated_events) >= 12,
      "Production Explore did not append metadata evidence to its dedicated sink.", auditStorage.rows[0]);
    assert(Number(auditStorage.rows[0]?.proposal_ledger_events) === 0,
      "Production Explore query volume still entered the proposal/writeback ledger.", auditStorage.rows[0]);

    const wrongScopeToken = await token(privateKey, { tenant: "acme", principal: "pm-scope", scope: "unrelated.scope" });
    const wrongScope = clientFor(server.url, wrongScopeToken);
    await wrongScope.client.connect(wrongScope.transport)
      .then(() => { throw new Error("JWT without the production Explore OAuth scope unexpectedly initialized a session."); })
      .catch((error) => assert(/403|insufficient_scope/i.test(String(error)), "Missing OAuth scope did not fail closed.", String(error)));

    const missingPrincipalToken = await token(privateKey, { tenant: "acme", principal: undefined });
    const missingPrincipal = clientFor(server.url, missingPrincipalToken);
    await missingPrincipal.client.connect(missingPrincipal.transport)
      .then(() => { throw new Error("JWT without a principal unexpectedly initialized production Explore."); })
      .catch((error) => assert(/401|unauthorized/i.test(String(error)), "Missing-principal JWT did not fail as authentication.", String(error)));

    const singleOrganization = await verifySingleOrganizationProductionExplore({
      admin,
      controlSchema,
      controlUrl,
      privateKey,
      publicKeyPem,
    });
    const after = await sourceSnapshot(admin);
    assert(JSON.stringify(after) === JSON.stringify(before),
      "Production HTTP Explore mutated the application source database.", { before, after });

    process.stdout.write(`${JSON.stringify({
      ok: true,
      boundary: candidate.pack.name,
      tools: tools.tools.map((tool) => tool.name),
      principal_budget_isolated: true,
      tenant_and_principal_rows_isolated: true,
      derived_tenant_and_principal_scope_isolated: true,
      reviewed_child_count_scope_isolated: true,
      shared_reference_same_across_tenants: true,
      concurrent_budget_reservation: true,
      source_connection_ceiling: 2,
      principal_session_ceiling: 2,
      dedicated_audit_sink: true,
      public_cli_entrypoint: true,
      packed_artifact: Boolean(process.env.SYNAPSOR_PRODUCTION_EXPLORE_RUNNER?.trim()),
      doctor_attested: true,
      derived_scope_indexes_attested: true,
      suppressed_groups: aliceResult.privacy.suppressed_groups,
      single_organization: singleOrganization,
      source_database_changed: false,
    }, null, 2)}\n`);
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    await stopProductionExploreCli(server).catch(() => undefined);
    await control.query(`DROP SCHEMA IF EXISTS "${controlSchema}" CASCADE`).catch(() => undefined);
    await Promise.allSettled([admin.end(), control.end()]);
    if (process.env.SYNAPSOR_KEEP_PRODUCTION_EXPLORE_FIXTURE === "1") {
      process.stderr.write(`Preserved production Explore fixture at ${projectRoot}\n`);
    } else {
      run("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], { allowFailure: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
      fs.rmSync(singleOrganizationProjectRoot, { recursive: true, force: true });
    }
  }
}

await main();
