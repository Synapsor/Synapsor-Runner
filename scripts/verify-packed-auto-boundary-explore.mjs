import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Pool } from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerPackageDir = path.join(root, "apps", "runner");
const specPackageDir = path.join(root, "packages", "spec");
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-packed-auto-boundary-"));
const packRoot = path.join(tempRoot, "pack");
const installRoot = path.join(tempRoot, "install");
const warmInstallRoot = path.join(tempRoot, "warm-install");
const isolatedNpmCache = path.join(tempRoot, "npm-cache");
const projectRoot = path.join(tempRoot, "project");
const readUrl = "postgresql://synapsor_churn_reader:synapsor_churn_reader_password@127.0.0.1:55460/synapsor_auto_boundary";
const adminUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55460/synapsor_auto_boundary";
const runtimeEnv = {
  ...process.env,
  DATABASE_URL: readUrl,
  SYNAPSOR_TENANT_ID: "acme",
  SYNAPSOR_PRINCIPAL: "pm-1",
};

let compose;
let adminPool;
const timings = {};
const measureIsolatedInstall = process.env.SYNAPSOR_MEASURE_INSTALL_TIMING === "1";
const npmInstallEnv = measureIsolatedInstall
  ? { ...process.env, npm_config_cache: isolatedNpmCache }
  : process.env;

try {
  await fsp.mkdir(packRoot);
  await fsp.mkdir(installRoot);
  await fsp.mkdir(warmInstallRoot);
  run("corepack", ["pnpm", "build:runner-package"], { cwd: root });
  const specTarball = packCurrent(packRoot, specPackageDir);
  const tarball = packCurrent(packRoot, runnerPackageDir);
  const freshInstallStartedAt = Date.now();
  run("npm", ["init", "-y"], { cwd: installRoot, env: npmInstallEnv });
  run("npm", ["install", "--ignore-scripts", specTarball], { cwd: installRoot, env: npmInstallEnv });
  run("npm", ["install", "--ignore-scripts", tarball], { cwd: installRoot, env: npmInstallEnv });
  timings.fresh_package_install_ms = Date.now() - freshInstallStartedAt;

  const warmInstallStartedAt = Date.now();
  run("npm", ["init", "-y"], { cwd: warmInstallRoot, env: npmInstallEnv });
  run("npm", ["install", "--ignore-scripts", specTarball], { cwd: warmInstallRoot, env: npmInstallEnv });
  run("npm", ["install", "--ignore-scripts", tarball], { cwd: warmInstallRoot, env: npmInstallEnv });
  timings.warm_cache_install_ms = Date.now() - warmInstallStartedAt;
  assert.ok(
    fs.existsSync(path.join(warmInstallRoot, "node_modules", "@synapsor", "runner", "dist", "cli.js")),
    "warm-cache installation omitted the packed Runner CLI",
  );

  const packageRoot = path.join(installRoot, "node_modules", "@synapsor", "runner");
  const cli = path.join(packageRoot, "dist", "cli.js");
  const packagedFixture = path.join(packageRoot, "examples", "auto-boundary-churn");
  assert.ok(fs.existsSync(path.join(packagedFixture, "docker-compose.yml")), "packed Runner omitted the Auto Boundary churn fixture");
  await fsp.cp(packagedFixture, projectRoot, { recursive: true });
  compose = path.join(projectRoot, "docker-compose.yml");

  run("docker", ["compose", "-f", compose, "up", "-d", "--wait", "postgres"], {
    cwd: projectRoot,
    inherit: true,
  });
  adminPool = new Pool({ connectionString: adminUrl, max: 1 });
  const before = await sourceSnapshot(adminPool);
  const productStartedAt = Date.now();

  const draftResult = run(process.execPath, [
    cli,
    "boundary",
    "draft",
    "--from-env",
    "DATABASE_URL",
    "--project-root",
    projectRoot,
    "--json",
  ], { cwd: projectRoot, env: runtimeEnv });
  const drafted = JSON.parse(draftResult.stdout);
  assert.equal(drafted.ok, true);
  assert.equal(drafted.activation, "disabled_unreviewed");
  const boundaryRoot = path.resolve(drafted.root);
  assert.equal(fs.existsSync(path.join(projectRoot, ".synapsor", "exploration-boundary.active.json")), false);
  assertGeneratedArtifactsContainNoRows(boundaryRoot);

  const beforeActivation = run(process.execPath, [
    cli,
    "mcp",
    "serve",
    "--authoring",
    "--project-root",
    projectRoot,
  ], {
    cwd: projectRoot,
    env: runtimeEnv,
    allowFailure: true,
    timeout: 10_000,
    input: "",
  });
  assert.notEqual(beforeActivation.status, 0, "packed Scoped Explore started before boundary activation");
  assert.match(
    `${beforeActivation.stdout}\n${beforeActivation.stderr}`,
    /not active|active exploration boundary|exploration-boundary\.active/i,
    "pre-activation authoring refusal was not actionable",
  );

  const activationUi = await startWorkbench({ cli, boundaryRoot, projectRoot, env: runtimeEnv });
  let boundaryDigest;
  try {
    const boundaryPayload = await activationUi.json("GET", "/api/boundary");
    assert.equal(boundaryPayload.ok, true);
    const candidate = narrowGoldenBoundary(structuredClone(boundaryPayload.draft));
    const preview = await activationUi.json("POST", "/api/boundary/preview", { candidate });
    assert.equal(preview.ok, true);
    boundaryDigest = preview.digest;
    const activated = await activationUi.json("POST", "/api/boundary/activate", {
      candidate,
      expected_digest: boundaryDigest,
      actor: "packed-golden-reviewer",
      confirmation: `ACTIVATE ${boundaryDigest}`,
      confirmed_decisions: candidate.unresolved_decisions,
    });
    assert.equal(activated.ok, true);
    assert.equal(activated.active.activation.state, "active");
  } finally {
    await activationUi.close();
  }

  const authoringInstall = JSON.parse(run(process.execPath, [
    cli,
    "mcp",
    "install",
    "cursor",
    "--project",
    "--authoring",
    "--project-root",
    projectRoot,
    "--yes",
    "--json",
  ], { cwd: projectRoot, env: runtimeEnv }).stdout);
  assert.equal(authoringInstall.installed, true);
  assert.equal(authoringInstall.mode, "authoring");
  assert.deepEqual(authoringInstall.tools, ["app.describe_data", "app.explore_data"]);
  const authoringStatus = JSON.parse(run(process.execPath, [
    cli,
    "mcp",
    "status",
    "cursor",
    "--project",
    "--project-root",
    projectRoot,
    "--json",
  ], { cwd: projectRoot, env: runtimeEnv }).stdout);
  assert.equal(authoringStatus.ok, true);
  assert.equal(authoringStatus.mode, "authoring");
  assert.deepEqual(authoringStatus.tools, ["app.describe_data", "app.explore_data"]);
  assert.doesNotMatch(
    await fsp.readFile(path.join(projectRoot, ".cursor", "mcp.json"), "utf8"),
    /postgres(?:ql)?:\/\/|synapsor_churn_reader_password|SYNAPSOR_TENANT_ID.*acme/i,
  );

  const goldenPlan = {
    kind: "aggregate",
    resource: "public.churn_events",
    relationship: "churn_events_account_id_fkey",
    measures: [
      { function: "count_distinct", field: "id", relationship: "churn_events_account_id_fkey" },
      { function: "sum", field: "monthly_revenue_cents" },
      { function: "avg", field: "monthly_revenue_cents" },
    ],
    dimensions: [
      { field: "region", relationship: "churn_events_account_id_fkey" },
      { field: "reason_category" },
    ],
    time_bucket: { field: "churned_at", bucket: "week" },
    comparison: {
      field: "churned_at",
      ranges: [
        { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
        { start: "2026-07-01T00:00:00.000Z", end: "2026-08-01T00:00:00.000Z" },
      ],
    },
    order_by: { kind: "measure", index: 0, direction: "desc" },
    top_n: 10,
  };

  let explored;
  let authoringTools;
  await withPackedMcp({
    cli,
    args: ["mcp", "serve", "--authoring", "--project-root", projectRoot],
    cwd: projectRoot,
    env: runtimeEnv,
    name: "packed-cursor-authoring",
  }, async (client) => {
    const listed = await client.listTools();
    authoringTools = listed.tools;
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["app.describe_data", "app.explore_data"]);
    assertSmallSafeToolSurface(listed.tools);

    const called = await client.callTool({ name: "app.explore_data", arguments: { plan: goldenPlan } });
    assert.equal(called.isError, undefined, `packed golden aggregate failed: ${JSON.stringify(called)}`);
    explored = resultPayload(called);
    assert.equal(explored.ok, true);
    assert.equal(explored.source_database_changed, false);
    assert.equal(explored.privacy.suppressed_groups, 2);
    assert.equal(explored.privacy.totals_returned, false);
    assert.equal(explored.data.length, 5);
    assert.match(JSON.stringify(explored), /"measure_0":10/);
    assert.match(JSON.stringify(explored), /"measure_0":5/);
    assert.doesNotMatch(
      JSON.stringify(explored),
      /globex|other-west|@example\.invalid|private kept-out|synthetic kept-out/i,
    );
    timings.first_useful_answer_ms = Date.now() - productStartedAt;

    const refusalCases = [
      [{ ...goldenPlan, dimensions: [{ field: "account_id" }] }, "unauthorized dimension"],
      [{ ...goldenPlan, dimensions: [{ field: "customer_email", relationship: "churn_events_account_id_fkey" }] }, "kept-out grouping"],
      [{ ...goldenPlan, where: [{ field: "customer_email", op: "eq", value: "hidden@example.invalid", relationship: "churn_events_account_id_fkey" }] }, "kept-out filtering"],
      [{ ...goldenPlan, tenant: "globex" }, "model-selected tenant"],
      [{ ...goldenPlan, principal: "other-principal" }, "model-selected principal"],
      [{ ...goldenPlan, relationship: "unreviewed_join" }, "unreviewed join"],
      [{ ...goldenPlan, relationship: "accounts_tags_many_to_many" }, "ambiguous fan-out join"],
      [{ ...goldenPlan, top_n: 11 }, "top-N overflow"],
      [{ ...goldenPlan, max_groups: 1_000 }, "group-limit override"],
      [{ ...goldenPlan, measures: [...goldenPlan.measures, { function: "count" }] }, "measure overflow"],
      [{ ...goldenPlan, dimensions: [...goldenPlan.dimensions, { field: "churned_at" }] }, "dimension overflow"],
      [{ ...goldenPlan, time_bucket: { field: "churned_at", bucket: "quarter" } }, "bucket overflow"],
      [{
        ...goldenPlan,
        comparison: {
          field: "churned_at",
          ranges: [
            ...goldenPlan.comparison.ranges,
            { start: "2026-08-01T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" },
          ],
        },
      }, "time-range overflow"],
      [{ ...goldenPlan, sql: "SELECT * FROM public.churn_events" }, "raw SQL"],
    ];
    for (const [plan, label] of refusalCases) {
      await expectMcpRefusal(client, plan, label);
    }

    for (const reason of ["price", "service", "product"]) {
      const result = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            ...goldenPlan,
            where: [{ field: "reason_category", op: "eq", value: reason }],
          },
        },
      });
      assert.notEqual(result.isError, true, `reviewed differencing query ${reason} failed unexpectedly`);
    }
    const exhausted = await client.callTool({
      name: "app.explore_data",
      arguments: {
        plan: {
          ...goldenPlan,
          where: [{ field: "reason_category", op: "eq", value: "support" }],
        },
      },
    });
    assert.equal(resultPayload(exhausted).error_code, "EXPLORE_PRIVACY_BUDGET_EXHAUSTED");
  });

  const protectUi = await startWorkbench({ cli, boundaryRoot, projectRoot, env: runtimeEnv });
  let protectedDraft;
  try {
    const recent = await protectUi.json("GET", "/api/protect");
    assert.equal(recent.ok, true);
    assert.equal(recent.available, true);
    assert.ok(recent.queries.length >= 1, "Workbench did not discover the recent aggregate without copied IDs");
    const query = recent.queries.find((item) => item.kind === "aggregate" && item.resource === "public.churn_events");
    assert.ok(query, "Workbench did not surface the packed golden aggregate");
    assert.equal(typeof query.query_ref, "string");
    assert.notEqual(query.query_ref, "<redacted>");
    assert.equal(Object.hasOwn(query, "token"), false);

    const created = await protectUi.json("POST", "/api/protect/draft", {
      query_ref: query.query_ref,
      capability_name: "analytics.churn_contributors_by_week",
      description: "Compare reviewed churn-account cohorts by week, region, and reason.",
      returns_hint: "Returns privacy-suppressed descriptive groups; it does not establish causation.",
      arguments: [],
    });
    assert.equal(created.ok, true);
    assert.equal(created.source_database_changed, false);
    assert.match(created.dsl, /PROTECTED READ AGGREGATE/);
    assert.match(created.dsl, /PROTECTED RELATIONSHIP churn_events_account_id_fkey/);
    assert.equal(created.draft.state, "disabled");
    assert.ok(created.contract.capabilities.some((capability) =>
      capability.name === "analytics.churn_contributors_by_week"
      && capability.protected_read?.mode === "aggregate"));
    assert.ok(
      Array.isArray(created.tests.tests) && created.tests.tests.length >= 7,
      "Protect did not generate the positive, scope, suppression, deny, drift, and boundary tests",
    );
    protectedDraft = created.draft;
    timings.first_data_pr_ms = Date.now() - productStartedAt;

    const activated = await protectUi.json("POST", "/api/protect/activate", {
      capability_name: protectedDraft.capability,
      expected_digest: protectedDraft.contract_digest,
      confirmation: `ACTIVATE ${protectedDraft.contract_digest}`,
      actor: "packed-golden-reviewer",
      disable_explore: true,
    });
    assert.equal(activated.ok, true);
    assert.equal(activated.active.state, "active");
    assert.equal(activated.active.exploration_disabled, true);
    timings.first_promoted_capability_ms = Date.now() - productStartedAt;
  } finally {
    await protectUi.close();
  }

  const disabledAuthoring = run(process.execPath, [
    cli,
    "mcp",
    "serve",
    "--authoring",
    "--project-root",
    projectRoot,
  ], {
    cwd: projectRoot,
    env: runtimeEnv,
    allowFailure: true,
    timeout: 10_000,
    input: "",
  });
  assert.notEqual(disabledAuthoring.status, 0, "Scoped Explore restarted after Protect disabled it");
  assert.match(`${disabledAuthoring.stdout}\n${disabledAuthoring.stderr}`, /EXPLORE_DISABLED|disabled/i);

  const configPath = path.join(projectRoot, "synapsor.runner.json");
  assert.match(await fsp.readFile(configPath, "utf8"), /"mode": "postgres_rls"/);
  const runtimeInstall = JSON.parse(run(process.execPath, [
    cli,
    "mcp",
    "install",
    "cursor",
    "--project",
    "--project-root",
    projectRoot,
    "--config",
    configPath,
    "--store",
    path.join(projectRoot, ".synapsor", "production.db"),
    "--yes",
    "--json",
  ], { cwd: projectRoot, env: runtimeEnv }).stdout);
  assert.equal(runtimeInstall.installed, true);
  assert.equal(runtimeInstall.mode, "runtime");
  assert.deepEqual(runtimeInstall.tools, ["analytics.churn_contributors_by_week"]);
  const runtimeStatus = JSON.parse(run(process.execPath, [
    cli,
    "mcp",
    "status",
    "cursor",
    "--project",
    "--project-root",
    projectRoot,
    "--json",
  ], { cwd: projectRoot, env: runtimeEnv }).stdout);
  assert.equal(runtimeStatus.ok, true);
  assert.equal(runtimeStatus.mode, "runtime");
  assert.deepEqual(runtimeStatus.tools, ["analytics.churn_contributors_by_week"]);
  let productionTools;
  await withPackedMcp({
    cli,
    args: [
      "mcp",
      "serve",
      "--config",
      configPath,
      "--store",
      path.join(projectRoot, ".synapsor", "production.db"),
    ],
    cwd: projectRoot,
    env: runtimeEnv,
    name: "packed-production-protected",
  }, async (client) => {
    const listed = await client.listTools();
    productionTools = listed.tools;
    assert.deepEqual(listed.tools.map((tool) => tool.name), ["analytics.churn_contributors_by_week"]);
    assert.equal(listed.tools.some((tool) => tool.name === "app.explore_data"), false);

    let guessed;
    try {
      guessed = await client.callTool({ name: "app.explore_data", arguments: { plan: goldenPlan } });
    } catch (error) {
      assert.match(String(error), /not found|unknown|capability/i);
    }
    if (guessed) assert.equal(guessed.isError, true);

    const protectedResult = resultPayload(await client.callTool({
      name: "analytics.churn_contributors_by_week",
      arguments: {},
    }));
    assert.equal(protectedResult.status, "ok", JSON.stringify(protectedResult, null, 2));
    assert.equal(protectedResult.source_database_changed, false, JSON.stringify(protectedResult, null, 2));
    assert.equal(protectedResult.data.suppression.suppressed_groups, 2);
    assert.doesNotMatch(
      JSON.stringify(protectedResult),
      /globex|other-west|@example\.invalid|private kept-out|synthetic kept-out/i,
    );
  });

  const auditResult = run(process.execPath, [
    cli,
    "query-audit",
    "list",
    "--store",
    path.join(projectRoot, ".synapsor", "local.db"),
    "--json",
  ], { cwd: projectRoot, env: runtimeEnv });
  const auditPayload = JSON.parse(auditResult.stdout);
  assert.ok(
    auditPayload.query_audit.length >= 4,
    `packed exploration audit was not durably queryable: ${JSON.stringify(auditPayload)}`,
  );
  const auditText = JSON.stringify(auditPayload);
  assert.match(auditText, /"kind":"aggregate"/);
  assert.match(auditText, /"suppressed_groups":2/);
  assert.doesNotMatch(
    auditText,
    /globex|other-west|@example\.invalid|private kept-out|synthetic kept-out|"tenant_id":"acme"|"principal":"pm-1"/i,
  );

  const after = await sourceSnapshot(adminPool);
  assert.deepEqual(after, before, "packed Auto Boundary journey mutated the source database");
  assert.ok(
    timings.first_useful_answer_ms < 5 * 60_000,
    `first useful own-data answer exceeded five minutes: ${timings.first_useful_answer_ms}ms`,
  );
  assert.ok(
    timings.first_promoted_capability_ms < 10 * 60_000,
    `first promoted capability exceeded ten minutes: ${timings.first_promoted_capability_ms}ms`,
  );
  assert.ok(
    timings.first_data_pr_ms < 15 * 60_000,
    `first Data PR exceeded fifteen minutes: ${timings.first_data_pr_ms}ms`,
  );
  const uninstalled = JSON.parse(run(process.execPath, [
    cli,
    "mcp",
    "uninstall",
    "cursor",
    "--project",
    "--project-root",
    projectRoot,
    "--yes",
    "--json",
  ], { cwd: projectRoot, env: runtimeEnv }).stdout);
  assert.equal(uninstalled.changed, true);

  const toolsBytes = Buffer.byteLength(JSON.stringify(authoringTools), "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    artifact: path.basename(tarball),
    stack: ["PostgreSQL", "Next.js", "Prisma", "Cursor-compatible MCP", "local Workbench"],
    boundary_digest: boundaryDigest,
    protected_contract_digest: protectedDraft.contract_digest,
    authoring_tools: authoringTools.map((tool) => tool.name),
    production_tools: productionTools.map((tool) => tool.name),
    tools_list_bytes: toolsBytes,
    estimated_tools_list_tokens: Math.ceil(toolsBytes / 4),
    returned_groups: explored.data.length,
    suppressed_groups: explored.privacy.suppressed_groups,
    source_database_changed: false,
    timing: {
      scope: "package download excluded; product clock starts with Runner database inspection",
      install_cache: measureIsolatedInstall ? "fresh isolated npm cache, then warm cache" : "ambient npm cache, then warm cache",
      ...timings,
    },
    aggregate_acceptance: {
      unauthorized_dimension_rejected: true,
      kept_out_group_and_filter_rejected: true,
      model_scope_rejected: true,
      unreviewed_join_rejected: true,
      ambiguous_fanout_rejected: true,
      small_cohort_suppressed: true,
      differencing_budget_enforced: true,
      hard_limits_enforced: true,
      verified_read_only_transaction: true,
      source_unchanged: true,
      disabled_canonical_protect_output: true,
      digest_bound_human_activation: true,
      production_explore_absent: true,
      protected_capability_survives: true,
      published_compatibility_gate: "test:packed-backward-compatibility",
    },
  }, null, 2)}\n`);
} finally {
  await adminPool?.end().catch(() => undefined);
  if (compose && process.env.SYNAPSOR_KEEP_AUTO_BOUNDARY_FIXTURE !== "1") {
    run("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], {
      cwd: projectRoot,
      allowFailure: true,
    });
  }
  if (process.env.SYNAPSOR_KEEP_AUTO_BOUNDARY_FIXTURE === "1") {
    process.stderr.write(`Preserved packed Auto Boundary fixture at ${tempRoot}\n`);
  } else {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

function narrowGoldenBoundary(candidate) {
  candidate.pack.name = "product_churn";
  candidate.budgets.max_rows = 20;
  candidate.budgets.max_groups = 12;
  candidate.budgets.max_top_n = 10;
  candidate.budgets.max_measures = 3;
  candidate.budgets.max_dimensions = 2;
  candidate.budgets.max_differencing_queries = 3;
  candidate.budgets.max_queries_per_session = 12;
  candidate.budgets.max_extracted_cells_per_session = 1_000;
  candidate.pack.resources = candidate.pack.resources.filter((resource) =>
    resource.id === "public.accounts" || resource.id === "public.churn_events");
  const accounts = candidate.pack.resources.find((resource) => resource.id === "public.accounts");
  const events = candidate.pack.resources.find((resource) => resource.id === "public.churn_events");
  assert.ok(accounts && events, "Auto Boundary did not draft both packed golden resources");
  narrowResource(accounts, {
    selectable: ["region", "segment"],
    filterable: ["region", "segment"],
    sortable: ["region", "segment"],
    groupable: ["region", "segment"],
    measures: [],
    distinct: ["id"],
    time: [],
  });
  narrowResource(events, {
    selectable: ["reason_category", "monthly_revenue_cents", "churned_at"],
    filterable: ["reason_category", "monthly_revenue_cents", "churned_at"],
    sortable: ["reason_category", "monthly_revenue_cents", "churned_at"],
    groupable: ["reason_category"],
    measures: ["monthly_revenue_cents"],
    distinct: ["id"],
    time: ["churned_at"],
  });
  events.relationships = events.relationships.filter((relationship) =>
    relationship.id === "churn_events_account_id_fkey");
  assert.equal(events.relationships.length, 1);
  return candidate;
}

function narrowResource(resource, input) {
  resource.selectable_fields = input.selectable;
  resource.filterable_fields = Object.fromEntries(Object.entries(resource.filterable_fields)
    .filter(([field]) => input.filterable.includes(field)));
  resource.sortable_fields = resource.sortable_fields.filter((field) => input.sortable.includes(field));
  resource.groupable_fields = resource.groupable_fields.filter((field) => input.groupable.includes(field));
  resource.aggregate_measures = resource.aggregate_measures.filter((field) => input.measures.includes(field));
  resource.count_distinct_fields = resource.count_distinct_fields.filter((field) => input.distinct.includes(field));
  resource.time_bucket_fields = Object.fromEntries(Object.entries(resource.time_bucket_fields)
    .filter(([field]) => input.time.includes(field)));
}

async function startWorkbench(input) {
  const child = spawn(process.execPath, [
    input.cli,
    "ui",
    "--boundary-root",
    input.boundaryRoot,
    "--config",
    path.join(input.projectRoot, "synapsor.runner.json"),
    "--store",
    path.join(input.projectRoot, ".synapsor", "workbench.db"),
  ], {
    cwd: input.projectRoot,
    env: input.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const url = await waitForValue(() => {
    const match = stdout.match(/Synapsor Runner local UI: (http:\/\/[^\s]+)/);
    return match?.[1];
  }, 15_000, () => `Workbench did not start.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  const parsed = new URL(url);
  const token = parsed.searchParams.get("token");
  assert.ok(token, "Workbench URL omitted the bootstrap token");
  const origin = parsed.origin;
  const pageResponse = await fetch(`${origin}/`, {
    headers: { "x-synapsor-ui-token": token },
  });
  assert.equal(pageResponse.status, 200);
  const page = await pageResponse.text();
  const csrf = page.match(/const csrf="([^"]+)"/)?.[1];
  assert.ok(csrf, "Workbench page omitted its CSRF token");

  return {
    async json(method, pathname, body) {
      const response = await fetch(`${origin}${pathname}`, {
        method,
        headers: {
          "x-synapsor-ui-token": token,
          ...(method === "POST"
            ? { "content-type": "application/json", "x-synapsor-csrf": csrf }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const payload = await response.json();
      if (!response.ok || payload.ok === false) {
        throw new Error(`${method} ${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
      }
      return payload;
    },
    async close() {
      if (child.exitCode !== null) return;
      if (!killProcessGroup(child.pid, "SIGTERM")) return;
      try {
        await waitForValue(
          () => child.exitCode !== null ? child.exitCode : undefined,
          5_000,
          () => "Workbench did not stop after SIGTERM.",
        );
      } catch {
        if (!killProcessGroup(child.pid, "SIGKILL")) return;
        await waitForValue(
          () => child.exitCode !== null ? child.exitCode : undefined,
          5_000,
          () => `Workbench did not stop.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }
    },
  };
}

function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function withPackedMcp(input, action) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [input.cli, ...input.args],
    cwd: input.cwd,
    env: input.env,
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.setEncoding("utf8");
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = new Client({ name: input.name, version: "1.0.0" });
  try {
    await client.connect(transport);
    return await action(client);
  } catch (error) {
    if (error instanceof Error && stderr.trim()) error.message += `\nMCP stderr:\n${stderr.trim()}`;
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function expectMcpRefusal(client, plan, label) {
  const result = await client.callTool({ name: "app.explore_data", arguments: { plan } });
  assert.equal(result.isError, true, `${label} unexpectedly succeeded`);
  if (result.structuredContent && typeof result.structuredContent === "object") {
    assert.match(result.structuredContent.error_code, /^EXPLORE_/, `${label} did not fail through Scoped Explore`);
    return;
  }
  const text = result.content?.find((item) => item.type === "text")?.text ?? "";
  try {
    const payload = JSON.parse(text);
    assert.match(payload.error_code, /^EXPLORE_/, `${label} did not fail through Scoped Explore`);
  } catch (error) {
    if (error instanceof SyntaxError) {
      assert.match(text, /MCP error|Input validation error|Invalid arguments/i, `${label} returned an unrecognized refusal`);
      return;
    }
    throw error;
  }
}

function assertSmallSafeToolSurface(tools) {
  const serialized = JSON.stringify(tools);
  const bytes = Buffer.byteLength(serialized, "utf8");
  assert.ok(bytes <= 8_000, `packed authoring tools/list exceeded 8,000 bytes: ${bytes}`);
  assert.ok(Math.ceil(bytes / 4) <= 2_000, "packed authoring tools/list exceeded the token estimate");
  for (const tool of tools) {
    assert.doesNotMatch(tool.name, /execute_sql|query_sql|approve|apply|commit/i);
    assert.equal(objectHasKey(tool.inputSchema, new Set([
      "sql",
      "query_sql",
      "execute_sql",
      "tenant",
      "tenant_id",
      "principal",
      "approve",
      "apply",
      "commit",
    ])), false);
    assert.equal(tool._meta?.["synapsor.raw_sql_exposed"], false);
    assert.equal(tool._meta?.["synapsor.approval_tool"], false);
    assert.equal(tool._meta?.["synapsor.commit_tool"], false);
  }
}

function objectHasKey(value, forbidden) {
  if (Array.isArray(value)) return value.some((item) => objectHasKey(item, forbidden));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) =>
    forbidden.has(key.toLowerCase()) || objectHasKey(item, forbidden));
}

function resultPayload(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string", "MCP result omitted structured content and JSON text");
  return JSON.parse(text);
}

function assertGeneratedArtifactsContainNoRows(boundaryRoot) {
  const text = collectText(boundaryRoot);
  assert.doesNotMatch(
    text,
    /acme-west@example\.invalid|globex@example\.invalid|private kept-out|synthetic kept-out/i,
    "generated authority persisted source-row values",
  );
  assert.doesNotMatch(text, /synapsor_churn_reader_password|synapsor_admin_password/);
}

function collectText(rootPath) {
  return fs.readdirSync(rootPath, { withFileTypes: true })
    .map((entry) => {
      const resolved = path.join(rootPath, entry.name);
      return entry.isDirectory() ? collectText(resolved) : fs.readFileSync(resolved, "utf8");
    })
    .join("\n");
}

async function sourceSnapshot(pool) {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS row_count,
      md5(string_agg(
        id || ':' || tenant_id || ':' || owner_id || ':' || account_id || ':' ||
        reason_category || ':' || monthly_revenue_cents::text || ':' ||
        churned_at::text || ':' || private_note,
        '|' ORDER BY id
      )) AS digest
    FROM public.churn_events
  `);
  return result.rows[0];
}

function packCurrent(destination, packageDirectory) {
  const result = run("corepack", [
    "pnpm",
    "pack",
    "--pack-destination",
    destination,
  ], { cwd: packageDirectory });
  const filename = result.stdout.trim().split(/\r?\n/).findLast((line) => line.endsWith(".tgz"));
  assert.ok(filename, `pnpm pack did not report a tarball filename:\n${result.stdout}`);
  return path.join(destination, path.basename(filename));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? result.error?.message})\n` +
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

async function waitForValue(read, timeoutMs, failure) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(failure());
}
