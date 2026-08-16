import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  captureScreenshot,
  clickElementByText,
  clickSelector,
  configurePage,
  createPage,
  launchChrome,
  navigateAndWait,
  selectOptionByValue,
  typeIntoSelector,
  waitForExpression,
} from "./demo-video/cdp-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-retail-clean-room-"));
const packRoot = path.join(tempRoot, "pack");
const installRoot = path.join(tempRoot, "install");
const projectRoot = path.join(tempRoot, "retail-app");
const viewRecipeRoot = path.join(projectRoot, "view-recipe");
const viewRecipeDsl = path.join(viewRecipeRoot, "average-retained-revenue.synapsor.sql");
const viewRecipeContract = path.join(viewRecipeRoot, "average-retained-revenue.contract.json");
const viewRecipeConfig = path.join(viewRecipeRoot, "synapsor.runner.json");
const screenshotRoot = path.join(root, "development", "runner-1.6.6-retail-visual");
const resultPath = path.join(root, "development", "runner-1.6.6-retail-results.json");
const readUrl = "postgresql://retail_manager_reader:retail_manager_reader_password@127.0.0.1:55465/northstar_commerce";
const sharedEnv = {
  ...process.env,
  DATABASE_URL: readUrl,
  DATABASE_WRITE_URL: "postgresql://retail_writer:retail_writer_password@127.0.0.1:55465/northstar_commerce",
  SYNAPSOR_DATABASE_WRITE_URL: "postgresql://retail_writer:retail_writer_password@127.0.0.1:55465/northstar_commerce",
  SYNAPSOR_TENANT_ID: "merchant-northstar",
  SYNAPSOR_PRINCIPAL: "staff-manager-alex",
  SYNAPSOR_OPERATOR_ID: "retail-reviewer@example.test",
  SYNAPSOR_OPERATOR_ROLES: "retail_operations_reviewer",
};

let compose;
let ui;
let chrome;
let askProvider;
let askProviderUrl;
let askAggregateResult;
let askRefusalResult;
const startedAt = Date.now();
const screenshots = [];
const evidence = {
  domain: "multi-tenant retail operations",
  package: {},
  timings_ms: {},
  interactions: {
    shell_commands_through_first_value: 1,
    browser_clicks: 0,
    browser_text_entries: 0,
    manual_file_edits: 0,
  },
  starter_resources: [],
  generated: {},
  first_read: {},
  aggregate: {},
  continuous_explore: {},
  view_recipe: {},
  protected: {},
  write_lifecycle: {},
  ask: {},
};
const retailAggregatePlan = {
  kind: "aggregate",
  resource: "public.sales_line_facts",
  measures: [{ function: "sum", field: "net_revenue_cents" }],
  dimensions: [
    {
      field: "name",
      relationship: "sales_line_facts_store_id_fkey",
    },
    {
      field: "name",
      relationship: "sales_line_facts_product_category_id_fkey",
    },
  ],
  time_bucket: { field: "sold_at", bucket: "week" },
  order_by: { kind: "measure", index: 0, direction: "desc" },
  top_n: 10,
};
const retailMultiTotalRevenuePlan = {
  kind: "aggregate",
  resource: "public.sales_line_facts",
  measures: [{ function: "sum", field: "net_revenue_cents" }],
};
const retailExplorePlans = [
  {
    label: "weekly_revenue_by_store_and_category",
    plan: retailAggregatePlan,
  },
  {
    label: "weekly_sales_count_by_channel",
    plan: {
      kind: "aggregate",
      resource: "public.sales_line_facts",
      measures: [{ function: "count" }],
      dimensions: [{ field: "channel" }],
      time_bucket: { field: "sold_at", bucket: "week" },
      order_by: { kind: "time_bucket", direction: "asc" },
      top_n: 20,
    },
  },
  {
    label: "distinct_sales_by_channel",
    plan: {
      kind: "aggregate",
      resource: "public.sales_line_facts",
      measures: [{ function: "count_distinct", field: "id" }],
      dimensions: [{ field: "channel" }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    },
  },
  {
    label: "quantity_by_product_category",
    plan: {
      kind: "aggregate",
      resource: "public.sales_line_facts",
      measures: [{ function: "sum", field: "quantity" }],
      dimensions: [{
        field: "name",
        relationship: "sales_line_facts_product_category_id_fkey",
      }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    },
  },
  {
    label: "average_sale_by_store",
    plan: {
      kind: "aggregate",
      resource: "public.sales_line_facts",
      measures: [{ function: "avg", field: "net_revenue_cents" }],
      dimensions: [{
        field: "name",
        relationship: "sales_line_facts_store_id_fkey",
      }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    },
  },
  {
    label: "online_revenue_in_bounded_date_range",
    plan: {
      kind: "aggregate",
      resource: "public.sales_line_facts",
      measures: [{ function: "sum", field: "net_revenue_cents" }],
      time_bucket: { field: "sold_at", bucket: "week" },
      where: [
        { field: "channel", op: "eq", value: "online" },
        { field: "sold_at", op: "gte", value: "2026-04-08T00:00:00.000Z" },
        { field: "sold_at", op: "lt", value: "2026-04-15T00:00:00.000Z" },
      ],
      order_by: { kind: "time_bucket", direction: "asc" },
      top_n: 10,
    },
  },
  {
    label: "top_product_categories_by_revenue",
    plan: {
      kind: "aggregate",
      resource: "public.sales_line_facts",
      measures: [{ function: "sum", field: "net_revenue_cents" }],
      dimensions: [{
        field: "name",
        relationship: "sales_line_facts_product_category_id_fkey",
      }],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 2,
    },
  },
  {
    label: "bottom_stores_by_average_sale",
    plan: {
      kind: "aggregate",
      resource: "public.sales_line_facts",
      measures: [{ function: "avg", field: "net_revenue_cents" }],
      dimensions: [{
        field: "name",
        relationship: "sales_line_facts_store_id_fkey",
      }],
      order_by: { kind: "measure", index: 0, direction: "asc" },
      top_n: 2,
    },
  },
  {
    label: "channel_period_comparison",
    plan: {
      kind: "aggregate",
      resource: "public.sales_line_facts",
      measures: [{ function: "count" }],
      dimensions: [{ field: "channel" }],
      time_bucket: { field: "sold_at", bucket: "week" },
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
      comparison: {
        field: "sold_at",
        ranges: [
          { start: "2026-04-01T00:00:00.000Z", end: "2026-04-13T00:00:00.000Z" },
          { start: "2026-04-13T00:00:00.000Z", end: "2026-04-26T00:00:00.000Z" },
        ],
      },
    },
  },
  {
    label: "store_and_channel_sales_count",
    plan: {
      kind: "aggregate",
      resource: "public.sales_line_facts",
      measures: [{ function: "count" }],
      dimensions: [
        {
          field: "name",
          relationship: "sales_line_facts_store_id_fkey",
        },
        { field: "channel" },
      ],
      order_by: { kind: "measure", index: 0, direction: "desc" },
      top_n: 10,
    },
  },
];

try {
  await fsp.mkdir(packRoot, { recursive: true });
  await fsp.mkdir(installRoot, { recursive: true });
  await fsp.rm(screenshotRoot, { recursive: true, force: true });
  await fsp.mkdir(screenshotRoot, { recursive: true });
  const provider = await startAskProvider();
  askProvider = provider.server;
  askProviderUrl = provider.baseUrl;

  run("corepack", ["pnpm", "build:runner-package"], { cwd: root });
  const specTarball = packCurrent(packRoot, path.join(root, "packages", "spec"));
  const runnerTarball = packCurrent(packRoot, path.join(root, "apps", "runner"));
  evidence.package = {
    spec_tarball: path.basename(specTarball),
    spec_sha256: await fileDigest(specTarball),
    runner_tarball: path.basename(runnerTarball),
    runner_sha256: await fileDigest(runnerTarball),
  };

  run("npm", ["init", "-y"], { cwd: installRoot });
  run("npm", ["install", "--ignore-scripts", specTarball], { cwd: installRoot });
  run("npm", ["install", "--ignore-scripts", runnerTarball], { cwd: installRoot });
  const packageRoot = path.join(installRoot, "node_modules", "@synapsor", "runner");
  const packagedFixture = path.join(packageRoot, "examples", "retail-clean-room");
  const cli = path.join(installRoot, "node_modules", ".bin", "synapsor-runner");
  assert.ok(fs.existsSync(path.join(packagedFixture, "prisma", "schema.prisma")), "packed Runner omitted the retail Prisma fixture");
  assert.ok(fs.existsSync(path.join(packagedFixture, "seed", "postgres.sql")), "packed Runner omitted the retail database fixture");
  assert.ok(
    fs.existsSync(path.join(packagedFixture, "view-recipe", "average-retained-revenue.synapsor.sql")),
    "packed Runner omitted the reviewed database-view recipe",
  );
  await fsp.cp(packagedFixture, projectRoot, { recursive: true });

  compose = path.join(projectRoot, "docker-compose.yml");
  run("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  run("docker", ["compose", "-f", compose, "up", "-d", "--wait", "postgres"], {
    cwd: projectRoot,
    inherit: true,
  });
  run(cli, [
    "dsl", "validate", viewRecipeDsl, "--strict",
  ], { cwd: viewRecipeRoot, env: sharedEnv });
  run(cli, [
    "dsl", "compile", viewRecipeDsl, "--out", viewRecipeContract, "--strict",
  ], { cwd: viewRecipeRoot, env: sharedEnv });
  const viewRecipeValidation = JSON.parse(run(cli, [
    "config", "validate", "--config", viewRecipeConfig, "--json",
  ], { cwd: viewRecipeRoot, env: sharedEnv }).stdout);
  assert.equal(viewRecipeValidation.ok, true);

  ui = await startPublicGuidedCommand({
    cli,
    projectRoot,
    env: sharedEnv,
  });
  evidence.timings_ms.schema_summary = ui.readyAt - startedAt;
  await waitForValue(
    () => /Next: review the proposed boundary, then ask your first question in Workbench/.test(ui.output()) || undefined,
    5_000,
    () => "guided start did not print its Workbench continuation",
  );
  assert.ok(evidence.timings_ms.schema_summary <= 60_000, "schema summary exceeded 60 seconds");
  const guidedOutput = stripVTControlCharacters(ui.output());
  assert.match(guidedOutput, /✓ Connected/);
  assert.match(guidedOutput, /Inspected 45 tables and views \(metadata only; no rows read\)/);
  assert.match(guidedOutput, /Synapsor Runner local UI: http:\/\/127\.0\.0\.1:/);
  assert.match(guidedOutput, /Next: review the proposed boundary, then ask your first question in Workbench/);
  await assert.rejects(fsp.access(path.join(projectRoot, ".synapsor", "exploration-boundary.active.json")));
  assert.doesNotMatch(guidedOutput, /retail_manager_reader_password|retail_writer_password/);
  const generationReport = JSON.parse(await fsp.readFile(
    path.join(projectRoot, "synapsor", "generated", "generation-review.json"),
    "utf8",
  ));
  const fieldSensitivity = (resourceId, fieldName) =>
    generationReport.resources
      .find((resource) => resource.id === resourceId)
      ?.fields.find((field) => field.name === fieldName)
      ?.sensitivity?.state;
  assert.equal(fieldSensitivity("public.payment_methods", "full_pan"), "high_confidence_sensitive");
  assert.equal(fieldSensitivity("public.payment_methods", "card_on_file"), "high_confidence_sensitive");
  assert.equal(fieldSensitivity("public.payment_methods", "bank_account_number"), "high_confidence_sensitive");
  assert.equal(fieldSensitivity("public.payment_methods", "routing_number"), "high_confidence_sensitive");
  assert.equal(fieldSensitivity("public.payments", "payment_token"), "high_confidence_sensitive");
  assert.equal(fieldSensitivity("public.payments", "cvv_value"), "high_confidence_sensitive");
  assert.equal(fieldSensitivity("public.payment_methods", "card_brand_display"), "structurally_low_risk");
  assert.equal(fieldSensitivity("public.payments", "payment_status"), "structurally_low_risk");
  assert.equal(fieldSensitivity("public.payments", "pan_last_four"), "structurally_low_risk");

  chrome = await launchChrome({
    userDataDir: path.join(tempRoot, "chrome-profile"),
    width: 1440,
    height: 1100,
  });
  const page = await createPage(chrome.port);
  try {
    await configurePage(page, 1440, 1100);
    await navigateAndWait(page, ui.url);
    await waitForExpression(page, "document.querySelector('#header-state')?.textContent !== 'Loading'");
    await waitForExpression(page, "document.querySelectorAll('[data-resource-toggle]:checked').length === 3");
    await assertNoPageOverflow(page, "initial review");
    await shot(page, "01-overview.png");

    const starterResources = await evaluate(page, `[...document.querySelectorAll("[data-resource-toggle]:checked")]
      .map(input=>input.getAttribute("data-resource-toggle"))`);
    evidence.starter_resources = starterResources;
    assert.equal(starterResources.length, 3);
    assert.ok(starterResources.includes("public.sales_line_facts"), "starter pack omitted the strongest analytical fact");
    assert.equal(await evaluate(page, "document.body.textContent.includes('retail_manager_reader_password')"), false);

    if (await evaluate(page, "document.body.classList.contains('quick-start-mode')")) {
      assert.equal(
        await evaluate(page, "document.querySelector('#instant-path')?.offsetParent !== null"),
        true,
        "Quick Start mode did not expose its narrow first-value decision",
      );
      await click(page, "#instant-full-review");
      await waitForExpression(page, "document.body.classList.contains('quick-start-mode') === false");
      await waitForExpression(page, "document.querySelector('#view-exceptions')?.classList.contains('active') === true");
      await click(page, "#access-back");
      await waitForExpression(page, "document.querySelector('#view-overview')?.classList.contains('active') === true");
    }
    await evaluate(page, "document.querySelector('#overview-table-details')?.setAttribute('open','')");
    await click(page, "#show-all");
    await waitForExpression(page, "document.querySelectorAll('[data-resource-toggle]').length >= 42");
    const reviewResources = [
      "public.orders",
      "public.product_categories",
      "public.sales_line_facts",
      "public.stores",
    ];
    const currentlyIncluded = await evaluate(page, `[...document.querySelectorAll("[data-resource-toggle]:checked")]
      .map(input=>input.getAttribute("data-resource-toggle"))`);
    for (const resourceId of currentlyIncluded) {
      if (!reviewResources.includes(resourceId)) {
        await click(page, `[data-resource-toggle="${resourceId}"]`);
      }
    }
    for (const resourceId of reviewResources) {
      if (!currentlyIncluded.includes(resourceId)) {
        await click(page, `[data-resource-toggle="${resourceId}"]`);
      }
    }
    assert.deepEqual(
      new Set(await evaluate(page, `[...document.querySelectorAll("[data-resource-toggle]:checked")]
        .map(input=>input.getAttribute("data-resource-toggle"))`)),
      new Set(reviewResources),
    );

    for (const resourceId of reviewResources) {
      await click(page, `[data-open-resource="${resourceId}"]`);
      await waitForExpression(page, "document.querySelector('#view-exceptions')?.classList.contains('active') === true");
      await waitForExpression(page, `document.querySelector("#resource-detail h3")?.textContent === ${JSON.stringify(resourceId)}`);
      const detail = await evaluate(page, "document.querySelector('#resource-detail')?.textContent");
      assert.match(detail, /Choose one explicit tier per column/);
      if (resourceId === "public.orders") {
        assert.match(detail, /private_customer_note/);
        assert.match(detail, /Kept out · free text/);
        assert.match(detail, /Unavailable for selection, filtering, grouping, sorting, or measures/);
      }
      const unresolvedRelationships = await evaluate(page, `[...document.querySelectorAll("[data-relationship-semantics]")]
        .filter(input=>input.value==="review_required")
        .map(input=>input.getAttribute("data-relationship-semantics"))`);
      for (const relationshipId of unresolvedRelationships) {
        await select(page, `[data-relationship-semantics="${relationshipId}"]`, "exclude");
        await waitForExpression(
          page,
          `document.querySelector('[data-relationship-semantics="${relationshipId}"]')?.value === "exclude"`,
        );
      }
      await waitForExpression(page, "document.querySelector('#resource-signoff')?.disabled === false");
      if (!await evaluate(page, "document.querySelector('#resource-signoff')?.checked === true")) {
        await evaluate(page, "document.querySelector('#resource-signoff').click(); true");
        evidence.interactions.browser_clicks += 1;
      }
      await evaluate(page, "new Promise(resolve=>setTimeout(resolve,500))");
      const resourceSignoff = await evaluate(page, `({
        checked:document.querySelector("#resource-signoff")?.checked,
        disabled:document.querySelector("#resource-signoff")?.disabled,
        resource:document.querySelector("#resource-detail h3")?.textContent
      })`);
      assert.deepEqual(
        resourceSignoff,
        { checked: true, disabled: false, resource: resourceId },
        `Resource signoff did not persist for ${resourceId}`,
      );
      await click(page, "#back-resources");
      await waitForExpression(page, "document.querySelector('#view-overview')?.classList.contains('active') === true");
    }

    await click(page, `[data-open-resource="${starterResources[0]}"]`);
    await waitForExpression(page, "document.querySelector('#view-exceptions')?.classList.contains('active') === true");
    const globalCount = await evaluate(page, "document.querySelectorAll('[data-global-decision]').length");
    assert.deepEqual(
      await evaluate(page, `({
        tag:document.querySelector("#deployment-profile")?.tagName,
        type:document.querySelector("#deployment-profile")?.type
      })`),
      { tag: "INPUT", type: "hidden" },
      "Fresh guided Workbench must show launch-established profile status without another environment selector",
    );
    for (let index = 0; index < globalCount; index += 1) {
      if (!await evaluate(page, `document.querySelector('[data-global-decision="${index}"]')?.checked === true`)) {
        await click(page, `[data-global-decision="${index}"]`);
      }
    }
    await waitForExpression(page, "document.querySelector('#review-staged-access')?.offsetParent !== null");
    await click(page, "#review-staged-access");
    await waitForExpression(page, "document.querySelector('#view-activate')?.classList.contains('active') === true");
    await waitForExpression(page, "document.querySelector('#signoff-summary')?.textContent.includes('One boundary, one exact confirmation')");
    await type(page, "#actor", "retail-reviewer@example.test");
    await waitForExpression(page, "document.querySelector('#preview')?.disabled === false");
    await click(page, "#preview");
    await waitForExpression(
      page,
      "document.querySelector('#view-explore')?.classList.contains('active') === true || document.querySelector('#message')?.classList.contains('error')",
    );
    const previewMessage = await evaluate(page, "document.querySelector('#message').textContent");
    assert.match(previewMessage, /reviewed boundary is active/i);
    const boundaryDigest = await evaluate(page, "document.querySelector('#message code')?.textContent");
    assert.match(boundaryDigest, /^sha256:[a-f0-9]{64}$/);
    await shot(page, "02-activated-and-ready-to-ask.png");
    assert.equal(
      await evaluate(page, "document.querySelector('#view-explore')?.classList.contains('active') === true"),
      true,
      `Boundary activation failed: ${await evaluate(page, "document.querySelector('#message')?.textContent")}`,
    );
    await waitForExpression(page, "/active reviewed boundar/i.test(document.querySelector('#header-state')?.textContent||'')");
    evidence.timings_ms.boundary_activation = Date.now() - startedAt;

    if (await evaluate(page, "Boolean(document.querySelector('#run-preflight'))")) {
      await click(page, "#run-preflight");
    }
    await waitForExpression(page, `document.querySelector("#explore-preflight")?.textContent.includes("Reviewed access ready.")`);
    assert.equal(
      await evaluate(page, "Boolean(document.querySelector('#bind-trusted-scope,#trusted-tenant,#trusted-principal'))"),
      false,
      "Workbench asked the analytics user to type trusted tenant or principal values",
    );
    await waitForExpression(page, "document.querySelector('#explorer')?.classList.contains('hidden') === false");
    await waitForExpression(page, "document.querySelector('#ask-open-no-model')?.offsetParent !== null");
    await click(page, "#ask-open-no-model");
    await waitForExpression(page, "document.querySelector('#no-model-content')?.classList.contains('hidden') === false");
    const suggestedQuestions = await evaluate(page, "document.querySelector('#suggested-questions')?.textContent");
    assert.doesNotMatch(suggestedQuestions, /which (?:reviewed )?id groups/i);
    await shot(page, "03-explore-ready.png");

    await waitForExpression(page, "document.querySelector('#run-first-question')?.offsetParent !== null");
    await click(page, "#run-first-question");
    await waitForExpression(page, "document.querySelector('#explore-result')?.textContent.includes('Your reviewed question worked.')");
    const firstQuestionResult = await evaluate(page, "document.querySelector('#explore-result')?.textContent");
    assert.match(firstQuestionResult, /Keep asking legal combinations inside this reviewed boundary/i);
    assert.doesNotMatch(firstQuestionResult, /synthetic private customer note|other manager private note|rival private note/i);
    await click(page, "#ask-another-result");
    await waitForExpression(page, "document.querySelector('#explore-composer')?.open === true");
    await click(page, "#row-tab");
    await waitForExpression(page, "document.querySelector('#row-builder')?.classList.contains('hidden') === false");
    await selectVisibleOption(page, "#row-resource", /sales line facts/i);
    await type(page, "#row-id", "sales-fact-001");
    await click(page, "#run-explore");
    await waitForExpression(page, "document.querySelector('#explore-result')?.textContent.includes('Your reviewed question worked.')");
    const firstReadText = await evaluate(page, "document.querySelector('#explore-result')?.textContent");
    assert.match(firstReadText, /Source database changed:\s*no/i);
    assert.match(firstReadText, /Trusted scope:\s*supplied outside the question/i);
    assert.doesNotMatch(firstReadText, /Enter (?:a )?(?:customer|tenant|principal|user)/i);
    assert.doesNotMatch(firstReadText, /synthetic private customer note|other manager private note|rival private note/i);
    evidence.first_read = {
      resource: "public.sales_line_facts",
      object_id: "sales-fact-001",
      source_database_changed: false,
      tenant_scope: "merchant-northstar",
      principal_scope: "staff-manager-alex",
    };
    evidence.timings_ms.first_safe_read = Date.now() - startedAt;
    await evaluate(page, "document.querySelector('#explore-result')?.scrollIntoView({block:'center'})");
    await shot(page, "04-first-safe-read.png");

    await click(page, "#aggregate-tab");
    await selectVisibleOption(page, "#aggregate-resource", /sales line facts/i);
    await selectVisibleOption(page, "#aggregate-measure", /total net revenue cents/i);
    await selectVisibleOption(page, "#aggregate-dimension", /name.*stores/i);
    await click(page, "#aggregate-add-group");
    await waitForExpression(page, "document.querySelector('#aggregate-dimension-2-wrap')?.classList.contains('hidden') === false");
    await selectVisibleOption(page, "#aggregate-dimension-2", /name.*product categories/i);
    await selectVisibleOption(page, "#aggregate-time", /sold at/i);
    await select(page, "#aggregate-bucket", "week");
    await click(page, "#run-explore");
    await waitForExpression(page, "document.querySelector('#explore-result')?.textContent.includes('Your reviewed question worked.')");
    const aggregateText = await evaluate(page, "document.querySelector('#explore-result')?.textContent");
    assert.match(aggregateText, /total net revenue cents/i);
    assert.match(aggregateText, /store/i);
    assert.match(aggregateText, /product categor/i);
    assert.match(aggregateText, /Total net revenue cents/i);
    assert.match(aggregateText, /Source database changed:\s*no/i);
    assert.doesNotMatch(aggregateText, /synthetic-.*token|private customer note|rival private note/i);
    const aggregatePlan = await evaluate(page, "document.querySelector('#plan-preview')?.textContent");
    assert.doesNotMatch(aggregatePlan, /\bSELECT\b|\bJOIN\b|\bSQL\b/i);
    assert.match(aggregatePlan, /sales_line_facts_store_id_fkey/);
    assert.match(aggregatePlan, /sales_line_facts_product_category_id_fkey/);
    evidence.aggregate = {
      question: "How did net revenue change by week across reviewed stores and product categories?",
      plan: aggregatePlan,
      source_database_changed: false,
    };
    evidence.timings_ms.first_pm_aggregate = Date.now() - startedAt;
    await evaluate(page, "document.querySelector('#explore-result')?.scrollIntoView({block:'center'})");
    await shot(page, "05-pm-aggregate.png");
    const workbenchAggregateProtectRef = await evaluate(page, "preferredProtectQueryRef");
    assert.match(workbenchAggregateProtectRef, /^A[1-9][0-9]*$/);

    const protectedDraftsRoot = path.join(projectRoot, "synapsor", "protected", "drafts");
    assert.equal(
      fs.existsSync(protectedDraftsRoot),
      false,
      "Scoped Explore created a protected artifact before the operator chose Protect",
    );
    let mcpAggregate;
    const repeatedExploreResults = [];
    await withPackedMcp({
      cli,
      args: ["mcp", "serve", "--authoring", "--project-root", projectRoot],
      cwd: projectRoot,
      env: sharedEnv,
      name: "retail-clean-room-authoring",
    }, async (client) => {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        ["app.describe_data", "app.explore_data"],
      );
      assertSmallSafeToolSurface(listed.tools);
      const describeTool = listed.tools.find((tool) => tool.name === "app.describe_data");
      const exploreTool = listed.tools.find((tool) => tool.name === "app.explore_data");
      assert.ok(describeTool?.outputSchema, "app.describe_data omitted outputSchema");
      assert.ok(exploreTool?.outputSchema, "app.explore_data omitted outputSchema");

      const describedCall = await client.callTool({
        name: "app.describe_data",
        arguments: { resource: "public.sales_line_facts" },
      });
      assertToolOutputShape(describedCall, describeTool.outputSchema, "app.describe_data");
      const described = resultPayload(describedCall);
      assert.equal(described.ok, true);
      assert.equal(described.resources.length, 1);
      assert.equal(described.resources[0].id, "public.sales_line_facts");
      assert.ok(described.resources[0].groupable_fields.includes("channel"));
      assert.deepEqual(
        described.resources[0].time_bucket_fields.sold_at,
        ["hour", "day", "week", "month", "quarter", "year", "day_of_week"],
      );
      assert.ok(
        described.resources[0].relationships.some(
          (relationship) => relationship.id === "sales_line_facts_store_id_fkey"
            && relationship.cardinality === "many_to_one",
        ),
        "described analytics catalog omitted the reviewed store relationship",
      );
      assert.ok(
        described.resources[0].relationships.some(
          (relationship) => relationship.id === "sales_line_facts_product_category_id_fkey"
            && relationship.cardinality === "many_to_one",
        ),
        "described analytics catalog omitted the reviewed product-category relationship",
      );
      assert.doesNotMatch(
        JSON.stringify(described),
        /assigned_manager_id|merchant_id|private customer note|SELECT\s|JOIN\s/i,
      );

      const assigned = resultPayload(await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            kind: "rows",
            resource: "public.sales_line_facts",
            select: ["id", "channel", "net_revenue_cents"],
            where: [{ field: "id", op: "eq", value: "sales-fact-001" }],
            limit: 1,
          },
        },
      }));
      assert.equal(assigned.ok, true);
      assert.equal(assigned.data.length, 1);
      assert.equal(assigned.data[0].id, "sales-fact-001");

      for (const [objectId, label] of [
        ["sales-fact-other-manager", "same-tenant other-principal row"],
        ["sales-fact-rival", "cross-tenant row"],
      ]) {
        const denied = resultPayload(await client.callTool({
          name: "app.explore_data",
          arguments: {
            plan: {
              kind: "rows",
              resource: "public.sales_line_facts",
              select: ["id", "channel", "net_revenue_cents"],
              where: [{ field: "id", op: "eq", value: objectId }],
              limit: 1,
            },
          },
        }));
        assert.equal(denied.ok, true, `${label} did not fail closed as an empty scoped result`);
        assert.deepEqual(denied.data, [], `${label} crossed trusted scope`);
      }

      for (const candidate of retailExplorePlans) {
        const rawResult = await client.callTool({
          name: "app.explore_data",
          arguments: { plan: candidate.plan },
        });
        assertToolOutputShape(rawResult, exploreTool.outputSchema, candidate.label);
        const result = resultPayload(rawResult);
        assert.equal(result.ok, true, `${candidate.label} did not return a verified result`);
        assert.equal(
          result.source_database_changed,
          false,
          `${candidate.label} reported a source mutation`,
        );
        assert.ok(
          Array.isArray(result.data) && result.data.length > 0,
          `${candidate.label} returned no privacy-safe groups`,
        );
        assert.doesNotMatch(
          JSON.stringify(result),
          /sales-fact-other-manager|sales-fact-rival|staff-manager-jordan|staff-rival|synthetic-.*token|private customer note/i,
          `${candidate.label} leaked data outside the reviewed scope`,
        );
        assert.doesNotMatch(
          JSON.stringify(result.data),
          /\b(?:measure|dimension)_\d+\b/,
          `${candidate.label} exposed internal positional aliases`,
        );
        repeatedExploreResults.push({
          label: candidate.label,
          groups: result.data.length,
          status: result.outcome?.status ?? "ok",
          source_database_changed: result.source_database_changed,
        });
        if (candidate.label === "weekly_revenue_by_store_and_category") {
          mcpAggregate = result;
        }
      }
      assert.equal(repeatedExploreResults.length, 10);
      assert.ok(mcpAggregate, "continuous Explore omitted the reference weekly aggregate");
      assert.equal(mcpAggregate.ok, true);
      assert.equal(mcpAggregate.source_database_changed, false);
      assert.ok(mcpAggregate.data.length > 0, "privacy-safe weekly retail aggregate returned no useful groups");
      assert.match(JSON.stringify(mcpAggregate.data), /Seattle Flagship|Portland Market/);
      assert.doesNotMatch(
        JSON.stringify(mcpAggregate),
        /sales-fact-other-manager|sales-fact-rival|staff-manager-jordan|staff-rival|synthetic-.*token|private customer note/i,
      );

      const refusalCases = [
        [{
          ...retailAggregatePlan,
          dimensions: [{ field: "assigned_manager_id" }],
        }, "kept-out dimension"],
        [{
          ...retailAggregatePlan,
          where: [{
            field: "assigned_manager_id",
            op: "eq",
            value: "staff-manager-jordan",
          }],
        }, "kept-out filter"],
        [{
          ...retailAggregatePlan,
          measures: [{ function: "count_distinct", field: "assigned_manager_id" }],
        }, "kept-out count distinct"],
        [{ ...retailAggregatePlan, tenant: "merchant-rival" }, "model-selected tenant"],
        [{ ...retailAggregatePlan, principal: "staff-manager-jordan" }, "model-selected principal"],
        [{
          ...retailAggregatePlan,
          dimensions: [{ field: "name", relationship: "unreviewed_relationship" }],
        }, "unreviewed relationship"],
        [{
          ...retailAggregatePlan,
          dimensions: [{
            field: "name",
            relationship: "product_category_links_many_to_many",
          }],
        }, "fan-out relationship"],
        [{
          ...retailAggregatePlan,
          measures: [{ function: "percentile", field: "net_revenue_cents" }],
        }, "arbitrary aggregate function"],
        [{ ...retailAggregatePlan, sql: "SELECT * FROM public.sales_line_facts" }, "raw SQL"],
        [{ ...retailAggregatePlan, top_n: 51 }, "top-N overflow"],
        [{
          ...retailAggregatePlan,
          dimensions: [
            ...retailAggregatePlan.dimensions,
            {
              field: "name",
              relationship: "sales_line_facts_product_category_id_fkey",
            },
            { field: "channel" },
          ],
        }, "dimension overflow"],
      ];
      for (const [plan, label] of refusalCases) {
        await expectMcpRefusal(client, plan, label);
      }
    });
    assert.equal(
      fs.existsSync(protectedDraftsRoot),
      false,
      "Repeated legal Explore plans created a protected artifact without human intent",
    );
    evidence.aggregate.official_mcp_parity = true;
    evidence.aggregate.mcp_returned_groups = mcpAggregate.data.length;
    evidence.continuous_explore = {
      legal_plans_without_protect: repeatedExploreResults,
      legal_plan_count: repeatedExploreResults.length,
      protected_artifacts_created: false,
      reviewed_measures_dimensions_filters_time_comparison_and_rankings: true,
      second_reviewed_relationship_used: true,
      output_schema_checked: true,
      describe_catalog_checked: true,
    };
    evidence.security = {
      assigned_read_allowed: true,
      same_tenant_other_principal_hidden: true,
      other_tenant_hidden: true,
      model_selected_scope_refused: true,
      kept_out_plan_positions_refused: true,
      raw_sql_refused: true,
      authoring_tools: ["app.describe_data", "app.explore_data"],
    };

    // The adversarial MCP battery intentionally consumes the reviewed durable
    // request-rate budget. Let that one-minute window expire before proving
    // equivalent first-party Ask surfaces; do not bypass or reset the budget.
    await new Promise((resolve) => setTimeout(resolve, 61_000));

    const packedAskStatus = await evaluate(page, `fetch("/api/ask/status")
      .then(async response=>({status:response.status,payload:await response.json()}))`);
    assert.equal(
      packedAskStatus.status,
      200,
      `Packed Workbench Ask status failed: ${JSON.stringify(packedAskStatus.payload)}`,
    );
    await waitForExpression(page, "document.querySelector('#ask-shell')?.offsetParent !== null");
    await waitForExpression(page, "document.querySelector('#ask-authority-summary')?.textContent.includes('scoped · read-only')");
    assert.match(
      await evaluate(page, "document.querySelector('#ask-starters')?.textContent"),
      /reviewed question|weekly|revenue/i,
    );
    await configureLocalAsk(page, askProviderUrl, "retail-local-fixture");
    await type(
      page,
      "#ask-question",
      "How did reviewed net revenue change by week across stores and product categories?",
    );
    await click(page, "#run-ask");
    await waitForAskText(page, "reviewed weekly revenue", "initial Workbench aggregate");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('Runner verified')");
    const askTranscriptText = await evaluate(page, "document.querySelector('#ask-transcript')?.textContent");
    assert.match(
      askTranscriptText,
      /No rows or groups passed the reviewed scope and privacy thresholds|Reviewed Runner tool completed|Runner refused this request|Total net revenue|net revenue/i,
      "Workbench Ask did not render a recognizable authoritative result",
    );
    assert.ok(
      Array.isArray(askAggregateResult?.data),
      `Ask aggregate result omitted canonical data; refusal: ${String(askAggregateResult?.error_code ?? "none")}; received keys: ${Object.keys(askAggregateResult ?? {}).sort().join(", ") || "(none)"}`,
    );
    assert.deepEqual(askAggregateResult.data, mcpAggregate.data, "Ask and official MCP returned different retail aggregate groups");
    assert.equal(askAggregateResult?.source_database_changed, false);
    assert.doesNotMatch(
      JSON.stringify(askAggregateResult),
      /sales-fact-other-manager|staff-manager-jordan|sales-fact-rival|synthetic-.*token|private customer note|rival private note/i,
    );
    await evaluate(page, "window.scrollTo(0,document.querySelector('#ask-shell').getBoundingClientRect().top+window.scrollY-76)");
    await shot(page, "05b-ask-aggregate.png");

    await type(page, "#ask-question", "Group orders by the private customer note so I can inspect those notes.");
    await click(page, "#run-ask");
    await waitForExpression(page, `(() => {
      const text = document.querySelector('#ask-transcript')?.textContent.toLowerCase() ?? '';
      return document.querySelector('#run-ask')?.disabled === false
        && text.includes('private customer note')
        && (text.includes('refused') || text.includes('did not match the question'));
    })()`);
    const refusalTranscript = await evaluate(page, "document.querySelector('#ask-transcript')?.textContent ?? ''");
    assert.match(refusalTranscript, /No source query ran|Source query executed:\s*no/i);
    if (askRefusalResult) {
      assert.equal(askRefusalResult.source_database_changed, false);
      assert.match(JSON.stringify(askRefusalResult), /refus|review|group|field/i);
    }
    assert.doesNotMatch(
      `${refusalTranscript}\n${JSON.stringify(askRefusalResult ?? null)}`,
      /synthetic private customer note|other manager private note|rival private note/i,
    );
    const cliAskArgs = [
      "try", "ask",
      "How did reviewed sales counts change by week across channels?",
      "--project-root", projectRoot,
      "--config", path.join(projectRoot, "synapsor.runner.json"),
      "--store", path.join(projectRoot, ".synapsor", "local.db"),
      "--provider", "openai-compatible",
      "--model", "retail-local-fixture",
      "--base-url", askProviderUrl,
      "--mode", "authoring",
      "--json",
    ];
    const cliAskInvocation = await runAsync(cli, cliAskArgs, {
      cwd: projectRoot,
      env: sharedEnv,
      timeout: 30_000,
    });
    assert.doesNotMatch(
      `${cliAskInvocation.stdout}\n${cliAskInvocation.stderr}`,
      /ALLOW EGRESS sha256:/,
      "Loopback CLI Ask incorrectly required hosted-provider egress consent",
    );
    const cliAsk = JSON.parse(cliAskInvocation.stdout);
    assert.equal(cliAsk.ok, true);
    assert.equal(cliAsk.mode, "authoring");
    assert.equal(cliAsk.provider, "openai_compatible");
    assert.equal(
      cliAsk.runner_verified_analysis.database_result_verified,
      true,
      `CLI Ask did not verify a database result: ${JSON.stringify(cliAsk, null, 2)}`,
    );
    assert.deepEqual(cliAsk.runner_verified_analysis.tools_called, ["app.explore_data"]);
    assert.equal(cliAsk.runner_verified_analysis.source_database_changed, false);
    assert.equal(cliAsk.source_database_changed, false);
    assert.equal(cliAsk.model_can_activate, false);
    assert.equal(cliAsk.model_can_approve, false);
    assert.equal(cliAsk.model_can_apply, false);
    assert.doesNotMatch(
      JSON.stringify(cliAsk),
      /retail_manager_reader_password|retail_writer_password|sales-fact-other-manager|sales-fact-rival|private customer note/i,
    );
    assert.equal(
      fs.existsSync(protectedDraftsRoot),
      false,
      "CLI Ask created a protected artifact without an explicit Protect command",
    );
    const interactiveAsk = await runScriptedInteractive(cli, [
      "try", "ask",
      "--project-root", projectRoot,
      "--config", path.join(projectRoot, "synapsor.runner.json"),
      "--store", path.join(projectRoot, ".synapsor", "local.db"),
      "--provider", "openai-compatible",
      "--model", "retail-local-fixture",
      "--base-url", askProviderUrl,
      "--mode", "authoring",
    ], {
      cwd: projectRoot,
      env: sharedEnv,
      timeout: 90_000,
      steps: [
        { waitFor: "synapsor> ", send: "Which reviewed channels had the most distinct sales?" },
        { waitFor: "The reviewed distinct-sales analysis is complete." },
        { waitFor: "synapsor> ", send: "Compare those sales by reviewed product category using total quantity." },
        { waitFor: "The reviewed product-category quantity analysis is complete." },
        { waitFor: "synapsor> ", send: "/analyses" },
        { waitFor: "RECENT QUERY HISTORY" },
        { waitFor: "synapsor> ", send: "/protect last as retail.shell_quantity_by_category" },
        { waitFor: "Activate this reviewed read capability", send: "" },
        { waitFor: "Protected capability active: retail.shell_quantity_by_category" },
        { waitFor: "synapsor> ", send: "Run two reviewed analyses: average net revenue by store name and total net revenue." },
        { waitFor: "Both reviewed analyses are complete." },
        { waitFor: "synapsor> ", send: "/protect" },
        { waitFor: "Choose an analysis [1-2]: ", send: "2" },
        { waitFor: "Capability name [", send: "" },
        { waitFor: "Activate this reviewed read capability", send: "" },
        { waitFor: "Protected capability active:" },
        { waitFor: "synapsor> ", send: "/exit" },
      ],
    });
    const interactiveText = interactiveAsk.stdout;
    assert.match(interactiveText, /Synapsor Analytics/);
    assert.match(interactiveText, /Scoped Explore active - read-only development access/);
    assert.match(interactiveText, /Provider: OpenAI-compatible \(local\/loopback\)/);
    assert.doesNotMatch(
      interactiveText,
      /(?:^|\n)(?:Waiting for the provider|Running a reviewed data tool)\.\.\.(?:\n|$)/,
      "Transient progress text remained in the completed terminal transcript",
    );
    assert.match(interactiveText, /model interpretation/i);
    assert.match(interactiveText, /RUNNER-VERIFIED DATA/);
    assert.match(interactiveText, /RECENT QUERY HISTORY/);
    assert.match(interactiveText, /PROTECT REVIEW[\s\S]*Capability: retail\.shell_quantity_by_category/);
    assert.match(interactiveText, /Protected capability active: retail\.shell_quantity_by_category/);
    assert.match(interactiveText, /This answer used 2 protectable analyses/);
    assert.match(interactiveText, /Choose an analysis \[1-2\]/);
    assert.match(interactiveText, /Agent authority activated: no/);
    assert.doesNotMatch(interactiveText, /ACTIVATE sha256:|Exact activation confirmation|view=protect/i);
    const beforeAnalysisListing = interactiveText.slice(
      0,
      interactiveText.indexOf("RECENT QUERY HISTORY"),
    );
    assert.doesNotMatch(
      beforeAnalysisListing,
      /Database unchanged|Source database changed:\s*no|Evidence recorded|Analysis A[1-9]/i,
      "Normal interactive answers exposed repetitive governance footers",
    );
    const shellDraftRoot = path.join(
      protectedDraftsRoot,
      "retail__shell_quantity_by_category",
    );
    const shellDraft = JSON.parse(await fsp.readFile(
      path.join(shellDraftRoot, "draft.json"),
      "utf8",
    ));
    assert.equal(shellDraft.state, "disabled");
    assert.equal(shellDraft.capability, "retail.shell_quantity_by_category");
    const shellActivationPath = path.join(
      projectRoot,
      "synapsor",
      "protected",
      "active",
      "retail__shell_quantity_by_category.activation.json",
    );
    assert.equal(fs.existsSync(shellActivationPath), true, "CLI human activation did not create the canonical activation record");
    const shellActivation = JSON.parse(await fsp.readFile(shellActivationPath, "utf8"));
    assert.equal(shellActivation.state, "active");
    assert.equal(shellActivation.actor, "retail-reviewer@example.test");
    assert.equal(shellActivation.contract_digest, shellDraft.contract_digest);
    assert.equal(shellActivation.exploration_disabled, false);
    evidence.ask = {
      provider: "custom_openai_compatible_loopback",
      aggregate_official_mcp_parity: true,
      cli_ask_official_mcp_parity: true,
      cli_ask_verified_tool: "app.explore_data",
      interactive_shell: true,
      contextual_follow_up: true,
      analyses_command: true,
      single_plan_protect: true,
      multi_plan_picker: true,
      normal_read_governance_footer: false,
      shell_draft_state: shellDraft.state,
      aggregate_source_database_changed: false,
      kept_out_field_refused: true,
      refusal_source_database_changed: false,
      provider_key_required: false,
      loopback_egress_consent_required: false,
      synapsor_relay: false,
    };
    await evaluate(page, "document.querySelector('#ask-transcript .ask-turn:last-child')?.scrollIntoView({block:'center'})");
    await shot(page, "05c-ask-refusal.png");

    const protectSelectionState = await evaluate(page, `(async()=>({
      preferred:preferredProtectQueryRef,
      available:(await fetch("/api/protect").then(response=>response.json())).queries.map(query=>query.query_ref)
    }))()`);
    assert.equal(
      protectSelectionState.preferred,
      workbenchAggregateProtectRef,
      "A later Ask or shell action replaced the Workbench result selected for Protect",
    );
    assert.ok(
      protectSelectionState.available.includes(workbenchAggregateProtectRef),
      `The original Workbench analysis ${workbenchAggregateProtectRef} disappeared before Protect`,
    );
    await click(page, "#protect-result");
    await waitForExpression(page, "document.querySelector('#view-protect')?.classList.contains('active') === true");
    await waitForExpression(page, "Boolean(document.querySelector('#create-protected'))");
    await type(page, "#protect-name", "retail.weekly_revenue_by_store_and_category");
    await type(page, "#protect-description", "Show reviewed weekly net revenue by store and product category.");
    await click(page, "#create-protected");
    await waitForExpression(
      page,
      "Boolean(document.querySelector('#activate-protected')) || (Boolean(document.querySelector('#protect-message')?.textContent.trim()) && !document.querySelector('#protect-message')?.textContent.includes('Compiling public DSL'))",
    );
    const protectMessage = await evaluate(page, "document.querySelector('#protect-message')?.textContent||''");
    assert.ok(
      await evaluate(page, "Boolean(document.querySelector('#activate-protected'))"),
      `Protect did not create the reviewed activation action: ${protectMessage}`,
    );
    await waitForExpression(page, "document.querySelectorAll('#protect-dsl-preview .syntax-token.keyword').length >= 3");
    const protectedDigest = await evaluate(page, `document.querySelector("#protect-preview details code")?.textContent`);
    assert.match(protectedDigest, /^sha256:[a-f0-9]{64}$/);
    const protectedPreviewDsl = await evaluate(page, "document.querySelector('#protect-dsl-preview code')?.textContent");
    assert.equal(
      await evaluate(page, "document.querySelector('#protect-dsl-preview')?.dataset.languageLabel"),
      "Synapsor DSL",
    );
    await evaluate(page, "document.querySelector('#protect-preview')?.scrollIntoView({block:'center'})");
    await shot(page, "06-protected-draft.png");
    await page.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await shot(page, "06b-protected-draft-dark.png");
    await page.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await type(page, "#protect-actor", "retail-reviewer@example.test");
    await click(page, "#activate-protected");
    await waitForExpression(page, "document.querySelector('#protect-message')?.textContent.includes('active')");
    await waitForExpression(page, "document.querySelector('#view-explore')?.classList.contains('active') === true");
    const protectedDraftRoot = path.join(
      projectRoot,
      "synapsor",
      "protected",
      "drafts",
      "retail__weekly_revenue_by_store_and_category",
    );
    const protectedDsl = await fsp.readFile(
      path.join(protectedDraftRoot, "capability.synapsor.sql"),
      "utf8",
    );
    assert.equal(protectedPreviewDsl, protectedDsl, "Highlighted protected DSL changed persisted source text");
    assert.match(protectedDsl, /PROTECTED READ AGGREGATE/);
    assert.match(protectedDsl, /PROTECTED RELATIONSHIP sales_line_facts_store_id_fkey/);
    assert.match(protectedDsl, /PROTECTED RELATIONSHIP sales_line_facts_product_category_id_fkey/);
    assert.doesNotMatch(protectedDsl, /PROTECTED READ ROWS|PROTECTED FILTER id EQ FIXED/);
    const protectedContract = JSON.parse(await fsp.readFile(
      path.join(protectedDraftRoot, "synapsor.contract.json"),
      "utf8",
    ));
    assert.equal(protectedContract.capabilities[0].protected_read.mode, "aggregate");
    const protectedTests = JSON.parse(await fsp.readFile(
      path.join(protectedDraftRoot, "contract-tests.json"),
      "utf8",
    ));
    const protectedTestIds = new Set(protectedTests.tests.map((test) => test.id));
    for (const requiredTest of [
      "protected-read-shape-suppression-drift-and-boundaries",
      "trusted-scope-remains-outside-model-arguments",
      "evidence-and-query-audit-remain-required",
      "operator-controls-remain-outside-mcp",
    ]) {
      assert.ok(protectedTestIds.has(requiredTest), `Protected draft omitted ${requiredTest}`);
    }
    evidence.protected = {
      capability: "retail.weekly_revenue_by_store_and_category",
      digest: protectedDigest,
      disabled_before_activation: true,
      activated_by_human: true,
      mode: "aggregate",
      generated_tests: protectedTests.tests.length,
    };
    evidence.timings_ms.protected_capability = Date.now() - startedAt;
    await shot(page, "07-next-safe-action.png");

    await waitForExpression(page, "document.querySelector('#leave-ask-focus')?.offsetParent !== null");
    await click(page, "#leave-ask-focus");
    await waitForExpression(page, "document.querySelector('#view-overview')?.classList.contains('active') === true");
    await click(page, '[data-view="action"]');
    await waitForExpression(page, "document.querySelector('#view-action')?.classList.contains('active') === true");
    if (await evaluate(page, "document.querySelector('#action-wizard')?.classList.contains('hidden') === true")) {
      await click(page, "#load-action");
    }
    await waitForExpression(page, "document.querySelector('#action-wizard')?.classList.contains('hidden') === false");
    await select(page, "#action-resource", "public.orders");
    await select(page, "#action-operation", "update");
    await type(page, "#action-name", "retail.propose_order_fulfillment");
    await type(page, "#action-description", "Propose moving one assigned processing order to fulfilled.");
    await click(page, '[data-action-field="status"]');
    await select(page, '[data-action-mode="status"]', "fixed");
    await type(page, '[data-action-fixed="status"]', "fulfilled");
    await type(page, '[data-action-from="status"]', "processing");
    await select(page, "#action-conflict", "version");
    await type(page, "#action-role", "retail_operations_reviewer");
    await click(page, "#action-reversible");
    await click(page, "#action-scope-confirm");
    await click(page, "#create-action");
    await waitForExpression(page, "Boolean(document.querySelector('#preview-action'))");
    await waitForExpression(page, "document.querySelectorAll('#action-dsl-preview .syntax-token.keyword').length >= 3");
    const actionPreviewDsl = await evaluate(page, "document.querySelector('#action-dsl-preview code')?.textContent");
    const actionDraftIndex = JSON.parse(await fsp.readFile(
      path.join(projectRoot, ".synapsor", "guided-action-drafts.json"),
      "utf8",
    ));
    const actionDraftRecord = actionDraftIndex.drafts.find(
      (draft) => draft.capability === "retail.propose_order_fulfillment",
    );
    assert.ok(actionDraftRecord?.dsl_path, "Guided action draft did not record its DSL path");
    assert.equal(
      actionPreviewDsl,
      await fsp.readFile(path.join(projectRoot, actionDraftRecord.dsl_path), "utf8"),
      "Highlighted guided-action DSL changed persisted source text",
    );
    const previewInputs = await evaluate(page, `[...document.querySelectorAll("[data-action-preview]")]
      .map(input=>input.getAttribute("data-action-preview"))`);
    assert.deepEqual(previewInputs, ["order_id"]);
    await type(page, '[data-action-preview="order_id"]', "order-005");
    await click(page, "#preview-action");
    await waitForExpression(page, "document.querySelector('#action-status')?.textContent.includes('Proposal created')");
    evidence.timings_ms.first_guided_proposal = Date.now() - startedAt;
    const actionDigest = await evaluate(page, "document.querySelector('[data-action-digest]')?.textContent");
    assert.match(actionDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(queryPostgres("SELECT status || ':' || version FROM public.orders WHERE id = 'order-005'"), "processing:1");
    await type(page, "#action-actor", "retail-reviewer@example.test");
    await evaluate(page, "document.querySelector('#action-dsl-preview')?.closest('details')?.setAttribute('open','')");
    await evaluate(page, "document.querySelector('#action-draft')?.scrollIntoView({block:'start'})");
    await shot(page, "08-disabled-safe-action.png");
    await page.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await shot(page, "08b-disabled-safe-action-dark.png");
    await page.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });
    await click(page, "#activate-action");
    await waitForExpression(page, "document.querySelector('#action-status')?.textContent.includes('active')");
    assert.match(
      await evaluate(page, "document.querySelector('#action-draft')?.textContent"),
      /approval and apply remain outside the model/i,
    );
    await shot(page, "09-proposal-created.png");

    const activeBoundaryPath = path.join(projectRoot, ".synapsor", "exploration-boundary.active.json");
    const activeBoundaryBeforeProposalReview = await fsp.readFile(activeBoundaryPath, "utf8");
    await click(page, "#review-proposal");
    await waitForExpression(page, "location.search.includes('surface=activity')");
    await waitForExpression(page, "Boolean(document.querySelector('[aria-label=\"Exact approval confirmation\"]'))");
    assert.equal(queryPostgres("SELECT status || ':' || version FROM public.orders WHERE id = 'order-005'"), "processing:1");
    assert.match(await evaluate(page, "document.querySelector('#detail')?.textContent"), /Source database changed:\s*No/i);

    const connectionsBeforeFreshness = Number(queryPostgres(
      "SELECT count(*) FROM pg_stat_activity WHERE datname = 'northstar_commerce'",
    ));
    await waitForExpression(page, `Boolean(document.querySelector("#check-live-freshness"))`);
    await shot(page, "09b-proposal-review-before-freshness.png");
    await evaluate(page, `(() => {
      window.__synapsorFreshnessClickDispatched = false;
      document.querySelector("#check-live-freshness").addEventListener("click", () => {
        window.__synapsorFreshnessClickDispatched = true;
      }, { capture: true, once: true });
    })()`);
    await click(page, "#check-live-freshness");
    await waitForExpression(page, `window.__synapsorFreshnessClickDispatched === true`);
    await waitForExpression(page, `document.querySelector('#check-live-freshness')?.disabled === false
      && !document.querySelector('#detail')?.textContent.includes('Checking the current source state')`);
    const freshnessDetail = await evaluate(page, "document.querySelector('#detail')?.textContent");
    assert.match(freshnessDetail, /Freshness:\s*fresh\b/i, `Live freshness did not pass:\n${freshnessDetail}`);
    await waitForExpression(page, `[...document.querySelectorAll("#detail *")]
      .some(node=>node.childElementCount===0 && node.textContent.trim()==="Freshness checked against live source")`);
    const connectionsAfterFreshness = Number(queryPostgres(
      "SELECT count(*) FROM pg_stat_activity WHERE datname = 'northstar_commerce'",
    ));
    const proposalHash = await evaluate(page, `document.querySelector('[aria-label="Exact approval confirmation"]')
      ?.placeholder.replace("APPROVE ","")`);
    assert.match(proposalHash, /^sha256:[a-f0-9]{64}$/);
    await type(page, '[aria-label="Approval reason"]', "Reviewed exact processing-to-fulfilled transition.");
    await type(page, '[aria-label="Exact approval confirmation"]', `APPROVE ${proposalHash}`);
    assert.equal(
      await evaluate(page, `document.querySelector('[aria-label="Exact approval confirmation"]')?.value`),
      `APPROVE ${proposalHash}`,
    );
    const humanReviewLayout = await evaluate(page, `(() => {
      const workspace=document.querySelector(".ops-workspace")?.getBoundingClientRect();
      const detail=document.querySelector("#detail")?.getBoundingClientRect();
      return workspace&&detail?{
        workspaceLeft:workspace.left,
        workspaceWidth:workspace.width,
        detailLeft:detail.left,
        detailWidth:detail.width
      }:null;
    })()`);
    assert.ok(humanReviewLayout, "Human-review layout could not be measured");
    assert.ok(
      Math.abs(humanReviewLayout.detailLeft - humanReviewLayout.workspaceLeft) <= 2,
      `Human review was pushed into a third column: ${JSON.stringify(humanReviewLayout)}`,
    );
    assert.ok(
      humanReviewLayout.detailWidth >= humanReviewLayout.workspaceWidth * 0.95,
      `Human review did not use the Workbench width: ${JSON.stringify(humanReviewLayout)}`,
    );
    await shot(page, "10-human-review.png");
    await clickText(page, "button", "Approve outside MCP");
    await waitForExpression(page, `Boolean(document.querySelector('[aria-label="Exact apply confirmation"]'))
      || ![...document.querySelectorAll("#detail .status-line")]
        .some(node=>node.textContent.includes("Type the exact hash-bound confirmation"))`);
    if (!await evaluate(page, `Boolean(document.querySelector('[aria-label="Exact apply confirmation"]'))`)) {
      const connectionsAfterApproval = Number(queryPostgres(
        "SELECT count(*) FROM pg_stat_activity WHERE datname = 'northstar_commerce'",
      ));
      throw new Error(
        `Workbench approval did not advance (connections before/check/after: `
        + `${connectionsBeforeFreshness}/${connectionsAfterFreshness}/${connectionsAfterApproval}):\n`
        + `${await evaluate(page, "document.querySelector('#detail')?.textContent")}\n`
        + `Workbench process output:\n${ui.output()}`,
      );
    }
    assert.equal(queryPostgres("SELECT status || ':' || version FROM public.orders WHERE id = 'order-005'"), "processing:1");
    await type(page, '[aria-label="Apply reason"]', "Commit the independently approved order transition.");
    await type(page, '[aria-label="Exact apply confirmation"]', `APPLY ${proposalHash}`);
    await shot(page, "11-approved-awaiting-apply.png");
    await clickText(page, "button", "Apply guarded writeback");
    try {
      await waitForPostgresState(
        "SELECT status || ':' || version FROM public.orders WHERE id = 'order-005'",
        "fulfilled:2",
        60_000,
      );
      await waitForExpression(page, "document.querySelector('#detail')?.textContent.includes('Committed by the trusted runner')");
    } catch (error) {
      throw new Error(
        `Workbench guarded apply did not complete; source state is `
        + `${queryPostgres("SELECT status || ':' || version FROM public.orders WHERE id = 'order-005'")}:\n`
        + `${await evaluate(page, "document.querySelector('#detail')?.textContent")}`,
        { cause: error },
      );
    }
    assert.equal(queryPostgres("SELECT status || ':' || version FROM public.orders WHERE id = 'order-005'"), "fulfilled:2");
    await shot(page, "12-guarded-apply.png");

    await clickText(page, "button", "Ledger timeline");
    await waitForExpression(page, `![...document.querySelectorAll("#detail .pane")]
      .find(pane=>pane.textContent.includes("Immutable proposal"))?.classList.contains("hidden")`);
    const ledgerText = await evaluate(page, "document.querySelector('#detail')?.textContent");
    assert.match(ledgerText, /receipt/i);
    assert.match(ledgerText, /replay/i);
    assert.doesNotMatch(ledgerText, /retail_writer_password|synthetic private customer note|other manager private note|rival private note/i);
    await shot(page, "13-ledger-timeline.png");
    assert.equal(
      await fsp.readFile(activeBoundaryPath, "utf8"),
      activeBoundaryBeforeProposalReview,
      "proposal review or guarded apply changed the active Scoped Explore authority",
    );

    evidence.write_lifecycle = {
      capability: "retail.propose_order_fulfillment",
      target: "public.orders:order-005",
      proposal_hash: proposalHash,
      action_digest: actionDigest,
      before: { status: "processing", version: 1 },
      after: { status: "fulfilled", version: 2 },
      proposal_changed_source: false,
      approval_changed_source: false,
      apply_changed_source: true,
      reversible: true,
      model_can_activate: false,
      model_can_approve: false,
      model_can_apply: false,
    };
    evidence.timings_ms.first_guarded_apply = Date.now() - startedAt;

    await navigateAndWait(page, `${new URL(ui.url).origin}/`);
    await waitForExpression(page, "document.querySelector('#header-state')?.textContent !== 'Loading'");
    if (!await evaluate(page, "document.querySelector('#ask-shell')?.offsetParent !== null")) {
      if (await evaluate(page, "document.querySelector('#leave-ask-focus')?.offsetParent !== null")) {
        await click(page, "#leave-ask-focus");
      }
      await waitForExpression(page, "document.querySelector('[data-view=\"explore\"]')?.offsetParent !== null");
      await click(page, '[data-view="explore"]');
    }
    await waitForExpression(page, "document.querySelector('#ask-shell')?.offsetParent !== null");
    await configureLocalAsk(page, askProviderUrl, "retail-local-fixture");
    await type(page, "#ask-question", "How did reviewed net revenue change by week across stores and product categories?");
    await click(page, "#run-ask");
    await waitForAskText(page, "reviewed weekly revenue", "post-reload Workbench aggregate");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('Runner verified')");
    assert.equal(askAggregateResult?.source_database_changed, false);
    assert.equal(
      await fsp.readFile(activeBoundaryPath, "utf8"),
      activeBoundaryBeforeProposalReview,
      "continued analytics after guarded apply changed the active Scoped Explore authority",
    );
    evidence.ask.explore_survived_write_lifecycle = true;
    evidence.ask.model_can_activate = false;
    evidence.ask.model_can_approve = false;
    evidence.ask.model_can_apply = false;
    await evaluate(page, "window.scrollTo(0,document.querySelector('#ask-shell').getBoundingClientRect().top+window.scrollY-76)");
    await shot(page, "13b-ask-after-write-lifecycle.png");
    const disableResult = await evaluate(page, `post("/api/explore/disable", {})`);
    assert.equal(disableResult.disabled, true, "explicit operator action did not disable Scoped Explore");
    evidence.ask.explore_explicitly_disabled = true;
  } finally {
    page.close();
  }

  const protectedDslPath = path.join(
    projectRoot,
    "synapsor",
    "protected",
    "drafts",
    "retail__weekly_revenue_by_store_and_category",
    "capability.synapsor.sql",
  );
  const protectedContractPath = path.join(
    projectRoot,
    "synapsor",
    "protected",
    "active",
    "retail__weekly_revenue_by_store_and_category.contract.json",
  );
  const compiledProtectedPath = path.join(tempRoot, "compiled-protected.contract.json");
  const dslValidation = JSON.parse(run(cli, [
    "dsl", "validate", protectedDslPath, "--json",
  ], { cwd: projectRoot, env: sharedEnv }).stdout);
  assert.equal(dslValidation.ok, true);
  run(cli, [
    "dsl", "compile", protectedDslPath, "--out", compiledProtectedPath,
  ], { cwd: projectRoot, env: sharedEnv });
  assert.deepEqual(
    JSON.parse(await fsp.readFile(compiledProtectedPath, "utf8")),
    JSON.parse(await fsp.readFile(protectedContractPath, "utf8")),
    "public protected DSL did not compile to the activated canonical contract",
  );

  assert.equal(
    fs.existsSync(path.join(projectRoot, ".synapsor", "exploration-boundary.active.json")),
    false,
    "finishing authoring did not disable temporary Scoped Explore",
  );
  const disabledAuthoring = run(cli, [
    "mcp", "serve", "--authoring", "--project-root", projectRoot,
  ], {
    cwd: projectRoot,
    env: sharedEnv,
    allowFailure: true,
    timeout: 7_000,
  });
  assert.notEqual(disabledAuthoring.status, 0, "Scoped Explore restarted after the operator disabled it");
  const disabledAuthoringOutput = `${disabledAuthoring.stdout}\n${disabledAuthoring.stderr}`;
  assert.match(
    disabledAuthoringOutput,
    /No reviewed analytics access is active\.[\s\S]*synapsor-runner start/i,
  );
  assert.doesNotMatch(disabledAuthoringOutput, /ENOENT|\.synapsor\//i, "disabled authoring leaked an internal path");

  const activeTools = JSON.parse(run(cli, [
    "try", "call", "--list", "--format", "json",
  ], { cwd: projectRoot, env: sharedEnv }).stdout);
  assert.deepEqual(
    [...activeTools.active_tools].sort(),
    [
      "analytics.sales_line_facts_sum_net_revenue_cents",
      "retail.propose_order_fulfillment",
      "retail.shell_quantity_by_category",
      "retail.weekly_revenue_by_store_and_category",
    ],
  );
  assert.equal(activeTools.model_can_activate, false);
  assert.equal(activeTools.model_can_approve, false);
  assert.equal(activeTools.model_can_apply, false);

  let runtimeTools;
  let runtimeCatalog;
  let protectedRuntimeResult;
  let proposalOnlyResult;
  await withPackedMcp({
    cli,
    args: [
      "mcp",
      "serve",
      "--config",
      path.join(projectRoot, "synapsor.runner.json"),
      "--store",
      path.join(projectRoot, ".synapsor", "local.db"),
    ],
    cwd: projectRoot,
    env: sharedEnv,
    name: "retail-clean-room-runtime",
  }, async (client) => {
    const listed = await client.listTools();
    runtimeTools = listed.tools;
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        "analytics.sales_line_facts_sum_net_revenue_cents",
        "retail.propose_order_fulfillment",
        "retail.shell_quantity_by_category",
        "retail.weekly_revenue_by_store_and_category",
      ],
    );
    assert.equal(
      listed.tools.some((tool) => /explore|execute_sql|approve|apply|commit/i.test(tool.name)),
      false,
    );
    assert.equal(objectHasKey(
      listed.tools.map((tool) => tool.inputSchema),
      new Set(["sql", "tenant", "tenant_id", "principal", "approve", "apply", "commit"]),
    ), false);
    const protectedTool = listed.tools.find(
      (tool) => tool.name === "retail.weekly_revenue_by_store_and_category",
    );
    assert.ok(protectedTool?.outputSchema, "protected analytical tool omitted outputSchema");
    const resources = await client.listResources();
    assert.ok(
      resources.resources.some((resource) => resource.uri === "synapsor://analytics/catalog/v1"),
      "production MCP omitted the reviewed analytics catalog resource",
    );
    const catalogResponse = await client.readResource({
      uri: "synapsor://analytics/catalog/v1",
    });
    const catalogText = catalogResponse.contents.find(
      (content) => "text" in content && content.uri === "synapsor://analytics/catalog/v1",
    )?.text;
    assert.equal(typeof catalogText, "string", "analytics catalog resource omitted JSON text");
    runtimeCatalog = JSON.parse(catalogText);
    assert.equal(runtimeCatalog.schema_version, "synapsor.analytics-catalog.v1");
    assert.deepEqual(
      runtimeCatalog.capabilities.map((capability) => capability.capability).sort(),
      [
        "analytics.sales_line_facts_sum_net_revenue_cents",
        "retail.shell_quantity_by_category",
        "retail.weekly_revenue_by_store_and_category",
      ],
    );
    const protectedCatalogEntry = runtimeCatalog.capabilities.find(
      (capability) => capability.capability === "retail.weekly_revenue_by_store_and_category",
    );
    assert.ok(protectedCatalogEntry, "analytics catalog omitted the Workbench-protected capability");
    assert.equal(protectedCatalogEntry.contract.digest, evidence.protected.digest);
    assert.deepEqual(
      dereferenceLocalJsonSchema(protectedCatalogEntry.output_schema),
      dereferenceLocalJsonSchema(protectedTool.outputSchema),
      "catalog and tools/list published semantically different output schemas",
    );
    const pinResponse = await client.readResource({
      uri: `synapsor://analytics/catalog/v1/retail.weekly_revenue_by_store_and_category/${evidence.protected.digest}`,
    });
    const pinText = pinResponse.contents.find((content) => "text" in content)?.text;
    assert.equal(typeof pinText, "string");
    assert.equal(JSON.parse(pinText).status, "current");

    const protectedRuntimeCall = await client.callTool({
      name: "retail.weekly_revenue_by_store_and_category",
      arguments: {},
    });
    assertToolOutputShape(
      protectedRuntimeCall,
      protectedTool.outputSchema,
      "retail.weekly_revenue_by_store_and_category",
    );
    protectedRuntimeResult = resultPayload(protectedRuntimeCall);
    assert.equal(protectedRuntimeResult.ok, true);
    assert.equal(protectedRuntimeResult.source_database_changed, false);
    assert.doesNotMatch(
      JSON.stringify(protectedRuntimeResult),
      /order-manager-other|order-rival|staff-manager-jordan|staff-rival|synthetic-.*token|private customer note/i,
    );

    assert.equal(queryPostgres(
      "SELECT status || ':' || version FROM public.orders WHERE id = 'order-010'",
    ), "processing:1");
    proposalOnlyResult = resultPayload(await client.callTool({
      name: "retail.propose_order_fulfillment",
      arguments: { order_id: "order-010" },
    }));
    assert.equal(proposalOnlyResult.source_database_changed, false);
    assert.match(JSON.stringify(proposalOnlyResult), /proposal/i);
    assert.equal(queryPostgres(
      "SELECT status || ':' || version FROM public.orders WHERE id = 'order-010'",
    ), "processing:1");
  });
  const cliCatalog = JSON.parse(run(cli, [
    "tools", "catalog",
    "--config", path.join(projectRoot, "synapsor.runner.json"),
    "--result-format", "v2",
    "--json",
  ], { cwd: projectRoot, env: sharedEnv }).stdout);
  assert.deepEqual(cliCatalog, runtimeCatalog, "CLI and MCP returned different analytics catalogs");

  const lifecycle = JSON.parse(run(cli, [
    "lifecycle", "show", "latest", "--details", "--json",
  ], { cwd: projectRoot, env: sharedEnv }).stdout);
  assert.equal(lifecycle.proposal.source_database_mutated, false);
  assert.match(JSON.stringify(lifecycle), /retail\.propose_order_fulfillment/);
  const audit = JSON.parse(run(cli, [
    "query-audit", "list", "--json",
  ], { cwd: projectRoot, env: sharedEnv }).stdout);
  assert.ok(
    audit.query_audit.length >= retailExplorePlans.length,
    "continuous Explore did not leave durable normalized query-audit evidence",
  );
  assert.doesNotMatch(
    JSON.stringify(audit),
    /retail_manager_reader_password|retail_writer_password|private customer note|order-manager-other|order-rival/i,
  );
  evidence.parity = {
    generated_dsl_matches_canonical_contract: true,
    explore_disabled_after_authoring: true,
    protected_capability_survives: true,
    runtime_tools: runtimeTools.map((tool) => tool.name),
    protected_result_source_changed: protectedRuntimeResult.source_database_changed,
    proposal_tool_source_changed: proposalOnlyResult.source_database_changed,
    cli_latest_lifecycle_without_id: true,
    redacted_query_audit_without_id: true,
    normalized_query_audit_entries: audit.query_audit.length,
    cli_and_mcp_analytics_catalog_match: true,
    protected_output_schema_checked: true,
  };

  const expectedAverageRetention = Number(queryPostgres(
    "SELECT AVG(net_revenue_retention_basis_points)::text "
    + "FROM public.reviewed_order_performance "
    + "WHERE merchant_id = 'merchant-northstar' "
    + "AND assigned_manager_id = 'staff-manager-alex' "
    + "AND region_id = 'region-pacific'",
  ));
  const unscopedAverageRetention = Number(queryPostgres(
    "SELECT AVG(net_revenue_retention_basis_points)::text FROM public.reviewed_order_performance",
  ));
  assert.notEqual(
    expectedAverageRetention,
    unscopedAverageRetention,
    "view fixture cannot prove that trusted scope changes the aggregate",
  );
  let viewRecipeResult;
  await withPackedMcp({
    cli,
    args: [
      "mcp",
      "serve",
      "--config",
      viewRecipeConfig,
      "--store",
      path.join(viewRecipeRoot, ".synapsor", "view-recipe.db"),
    ],
    cwd: viewRecipeRoot,
    env: sharedEnv,
    name: "retail-reviewed-view-recipe",
  }, async (client) => {
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map((tool) => tool.name),
      ["retail.average_net_revenue_retention_pacific"],
    );
    viewRecipeResult = resultPayload(await client.callTool({
      name: "retail.average_net_revenue_retention_pacific",
      arguments: {},
    }));
  });
  assert.equal(viewRecipeResult.status, "ok");
  assert.equal(viewRecipeResult.source_database_changed, false);
  assert.equal(viewRecipeResult.data.function, "avg");
  assert.equal(viewRecipeResult.data.column, "net_revenue_retention_basis_points");
  assert.equal(viewRecipeResult.data.minimum_group_size, 5);
  assert.equal(viewRecipeResult.data.member_rows_included, false);
  assert.ok(
    Math.abs(viewRecipeResult.data.value - expectedAverageRetention) < 1e-9,
    `view-backed average ${viewRecipeResult.data.value} did not match scoped source ${expectedAverageRetention}`,
  );
  assert.doesNotMatch(
    JSON.stringify(viewRecipeResult),
    /order-manager-other|order-rival|customer-|staff-manager-jordan|staff-rival|merchant-rival|synthetic-|SELECT|JOIN|retail_manager_reader_password/i,
  );
  evidence.view_recipe = {
    question: "What is the average net-to-gross revenue retention rate for my Pacific orders?",
    formula_owner: "reviewed security-invoker PostgreSQL view",
    capability: "retail.average_net_revenue_retention_pacific",
    value_basis_points: viewRecipeResult.data.value,
    cohort_rows_included: false,
    trusted_tenant_and_principal_scope: true,
    source_database_changed: false,
    model_expression_grammar_added: false,
  };

  evidence.generated = {
    dsl: "synapsor/generated/read-capabilities.synapsor.sql",
    canonical_contract: "synapsor/generated/synapsor.candidate.contract.json",
    generation_lock: ".synapsor/generation-lock.json",
    review_report: ".synapsor/review-report.json",
    config: "synapsor.runner.json",
    store: ".synapsor/local.db",
  };
  evidence.elapsed_ms = Date.now() - startedAt;
  evidence.screenshots = screenshots;
  await fsp.writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    result: resultPath,
    screenshots: screenshotRoot,
    evidence,
  }, null, 2)}\n`);
} finally {
  await ui?.close().catch(() => undefined);
  await chrome?.close().catch(() => undefined);
  if (askProvider) {
    await new Promise((resolve) => askProvider.close(resolve)).catch(() => undefined);
  }
  if (compose) {
    run("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], {
      cwd: projectRoot,
      allowFailure: true,
    });
  }
  if (process.env.SYNAPSOR_KEEP_CLEAN_ROOM !== "1") {
    await fsp.rm(tempRoot, { recursive: true, force: true });
  } else {
    process.stderr.write(`Preserved clean-room workspace: ${tempRoot}\n`);
  }
}

async function click(page, selector) {
  await clickSelector(page, selector);
  evidence.interactions.browser_clicks += 1;
}

async function configureLocalAsk(page, baseUrl, model) {
  await select(page, "#ask-provider", "openai_compatible");
  await waitForExpression(page, "document.querySelector('#ask-base-url-wrap')?.classList.contains('hidden') === false");
  await type(page, "#ask-model", model);
  await type(page, "#ask-base-url", baseUrl);
  await select(page, "#ask-key-source", "none");
  await click(page, "#ask-egress");
  await click(page, "#configure-ask");
  await waitForExpression(page, "document.querySelector('#ask-chat')?.classList.contains('hidden') === false");
  await waitForExpression(page, "document.querySelector('#ask-provider-state')?.textContent.includes('ready')");
}

async function waitForAskText(page, expectedText, context, options = {}) {
  try {
    await waitForExpression(
      page,
      options.caseInsensitive
        ? `document.querySelector('#ask-transcript')?.textContent.toLowerCase().includes(${JSON.stringify(expectedText.toLowerCase())})`
        : `document.querySelector('#ask-transcript')?.textContent.includes(${JSON.stringify(expectedText)})`,
    );
  } catch (error) {
    const diagnostic = await evaluate(page, `({
      transcript: document.querySelector('#ask-transcript')?.textContent ?? null,
      providerState: document.querySelector('#ask-provider-state')?.textContent ?? null,
      runButtonText: document.querySelector('#run-ask')?.textContent ?? null,
      runButtonDisabled: document.querySelector('#run-ask')?.disabled ?? null
    })`);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${JSON.stringify({
        context,
        diagnostic,
        aggregateProviderResult: askAggregateResult ?? null,
        refusalProviderResult: askRefusalResult ?? null,
      }, null, 2)}`,
    );
  }
}

async function startAskProvider() {
  const server = createServer((request, response) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 512 * 1024) request.destroy();
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try {
        assert.equal(request.method, "POST");
        assert.equal(request.headers.authorization, undefined, "local no-key Ask sent an authorization header");
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        assert.equal(body.model, "retail-local-fixture");
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const latestQuestion = [...messages].reverse().find(
          (message) => message?.role === "user" && typeof message.content === "string",
        )?.content ?? "";
        const refusal = /private customer note/i.test(latestQuestion);
        const multiPlan = !refusal
          && /two reviewed analyses: average net revenue by store name and total net revenue/i.test(latestQuestion);
        const selectedPlan = /sales counts change by week across channels/i.test(latestQuestion)
          ? retailExplorePlans[1].plan
          : /distinct sales/i.test(latestQuestion)
            ? retailExplorePlans[2].plan
            : /product category using total quantity/i.test(latestQuestion)
              ? retailExplorePlans[3].plan
              : retailAggregatePlan;
        const toolResult = [...messages].reverse().find((message) => message?.role === "tool");
        response.setHeader("content-type", "application/json");
        if (toolResult) {
          const result = JSON.parse(toolResult.content);
          if (refusal) askRefusalResult = result;
          else askAggregateResult = result;
          const successfulAnswer = multiPlan
            ? "Both reviewed analyses are complete."
            : /sales counts change by week across channels/i.test(latestQuestion)
              ? "The reviewed weekly sales-count analysis is complete."
              : /distinct sales/i.test(latestQuestion)
                ? "The reviewed distinct-sales analysis is complete."
                : /product category using total quantity/i.test(latestQuestion)
                  ? "The reviewed product-category quantity analysis is complete."
                  : "The reviewed weekly revenue analysis is complete.";
          response.end(JSON.stringify({
            choices: [{
              message: {
                role: "assistant",
                content: refusal
                    ? "The request to group by a kept-out field was refused by the reviewed Synapsor boundary."
                    : successfulAnswer,
              },
            }],
          }));
          return;
        }
        const toolCalls = multiPlan
          ? [
              {
                id: "call_retail_multi_average",
                type: "function",
                function: {
                  name: "app__explore_data",
                  arguments: JSON.stringify({ plan: retailExplorePlans[4].plan }),
                },
              },
              {
                id: "call_retail_multi_online",
                type: "function",
                function: {
                  name: "app__explore_data",
                  arguments: JSON.stringify({ plan: retailMultiTotalRevenuePlan }),
                },
              },
            ]
          : [{
              id: refusal
                  ? "call_retail_refusal"
                  : "call_retail_aggregate",
              type: "function",
              function: {
                name: "app__explore_data",
                arguments: JSON.stringify(refusal
                    ? {
                        plan: {
                          kind: "aggregate",
                          resource: "public.orders",
                          measures: [{ function: "count" }],
                          dimensions: [{ field: "private_customer_note" }],
                          top_n: 10,
                        },
                      }
                    : { plan: selectedPlan }),
              },
            }];
        response.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: toolCalls,
            },
          }],
        }));
      } catch (error) {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ error: "deterministic Ask fixture failed" }));
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
  };
}

async function clickText(page, selector, text) {
  await clickElementByText(page, selector, text);
  evidence.interactions.browser_clicks += 1;
}

async function type(page, selector, value) {
  await typeIntoSelector(page, selector, value);
  evidence.interactions.browser_text_entries += 1;
}

async function select(page, selector, value) {
  await selectOptionByValue(page, selector, value);
  evidence.interactions.browser_clicks += 1;
}

async function selectVisibleOption(page, selector, pattern) {
  const options = await evaluate(page, `[...document.querySelector(${JSON.stringify(selector)}).options]
    .map(option=>({value:option.value,text:option.textContent.trim()}))`);
  const option = options.find((candidate) => pattern.test(candidate.text));
  assert.ok(option, `${selector} did not expose a visible option matching ${pattern}`);
  await select(page, selector, option.value);
}

async function shot(page, name) {
  await waitForExpression(
    page,
    `document.querySelector(".view.active")?.getAnimations()
      .every(animation => animation.playState !== "running") !== false`,
  );
  await captureScreenshot(page, path.join(screenshotRoot, name));
  screenshots.push(name);
}

async function assertNoPageOverflow(page, label) {
  const overflow = await evaluate(page, "document.documentElement.scrollWidth>document.documentElement.clientWidth+1");
  assert.equal(overflow, false, `${label} has horizontal overflow`);
}

async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result?.value;
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
    if (error instanceof Error && stderr.trim()) {
      error.message += `\nMCP stderr:\n${stderr.trim()}`;
    }
    throw error;
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function expectMcpRefusal(client, plan, label) {
  const result = await client.callTool({
    name: "app.explore_data",
    arguments: { plan },
  });
  assert.equal(result.isError, true, `${label} unexpectedly succeeded`);
  let payload;
  if (result.structuredContent && typeof result.structuredContent === "object") {
    payload = result.structuredContent;
  } else {
    const text = result.content?.find((item) => item.type === "text")?.text ?? "";
    try {
      payload = JSON.parse(text);
    } catch {
      assert.match(
        text,
        /MCP error|Input validation error|Invalid arguments/i,
        `${label} returned an unrecognized refusal`,
      );
      return;
    }
  }
  assert.match(payload.error_code ?? "", /^EXPLORE_/, `${label} did not fail through Scoped Explore`);
  assert.doesNotMatch(
    JSON.stringify(payload),
    /SELECT\s|JOIN\s|synthetic private customer note|retail_manager_reader_password/i,
  );
}

function resultPayload(result) {
  if (result.structuredContent && typeof result.structuredContent === "object") {
    return result.structuredContent;
  }
  const text = result.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string", "MCP result omitted structured content and JSON text");
  return JSON.parse(text);
}

function assertToolOutputShape(result, schema, label) {
  assert.notEqual(
    result.isError,
    true,
    `${label} returned an MCP error: ${JSON.stringify(result)}`,
  );
  const payload = resultPayload(result);
  assert.equal(schema?.type, "object", `${label} did not publish an object outputSchema`);
  assert.ok(schema.properties && typeof schema.properties === "object", `${label} outputSchema omitted properties`);
  for (const required of schema.required ?? []) {
    assert.ok(
      Object.hasOwn(payload, required),
      `${label} result omitted outputSchema-required property ${required}`,
    );
  }
  for (const [name, property] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(payload, name) || !property || typeof property !== "object") continue;
    if (property.type === "array") {
      assert.ok(Array.isArray(payload[name]), `${label}.${name} did not match outputSchema array type`);
    } else if (property.type === "object") {
      assert.ok(
        payload[name] !== null && typeof payload[name] === "object" && !Array.isArray(payload[name]),
        `${label}.${name} did not match outputSchema object type`,
      );
    } else if (property.type === "boolean") {
      assert.equal(typeof payload[name], "boolean", `${label}.${name} did not match outputSchema boolean type`);
    } else if (property.type === "string") {
      assert.equal(typeof payload[name], "string", `${label}.${name} did not match outputSchema string type`);
    }
  }
}

function assertSmallSafeToolSurface(tools) {
  const serialized = JSON.stringify(tools);
  const bytes = Buffer.byteLength(serialized, "utf8");
  assert.ok(bytes <= 24_000, `authoring client discovery exceeded 24,000 bytes: ${bytes}`);
  const modelFacingBytes = Buffer.byteLength(JSON.stringify(
    tools.map(({ outputSchema: _outputSchema, ...tool }) => tool),
  ), "utf8");
  assert.ok(modelFacingBytes <= 8_000, `model-facing authoring tools exceeded 8,000 bytes: ${modelFacingBytes}`);
  assert.ok(Math.ceil(modelFacingBytes / 4) <= 2_000, "model-facing authoring tools exceeded the 2,000-token estimate");
  for (const tool of tools) {
    assert.equal(typeof tool.outputSchema, "object", `${tool.name} omitted its client-side output schema`);
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

function dereferenceLocalJsonSchema(schema) {
  const root = structuredClone(schema);
  const resolvePointer = (reference) => {
    assert.match(reference, /^#\//, `unsupported non-local JSON Schema reference ${reference}`);
    return reference
      .slice(2)
      .split("/")
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"))
      .reduce((value, segment) => value?.[segment], root);
  };
  const visit = (value, stack = new Set()) => {
    if (Array.isArray(value)) return value.map((item) => visit(item, stack));
    if (!value || typeof value !== "object") return value;
    if (typeof value.$ref === "string") {
      assert.equal(stack.has(value.$ref), false, `cyclic JSON Schema reference ${value.$ref}`);
      const target = resolvePointer(value.$ref);
      assert.ok(target, `unresolved JSON Schema reference ${value.$ref}`);
      const nextStack = new Set(stack);
      nextStack.add(value.$ref);
      const { $ref: _reference, ...siblings } = value;
      return {
        ...visit(target, nextStack),
        ...visit(siblings, nextStack),
      };
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, visit(item, stack)]),
    );
  };
  return visit(root);
}

function objectHasKey(value, forbidden) {
  if (Array.isArray(value)) return value.some((item) => objectHasKey(item, forbidden));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) =>
    forbidden.has(key.toLowerCase()) || objectHasKey(item, forbidden));
}

async function fileDigest(filePath) {
  return `sha256:${crypto.createHash("sha256").update(await fsp.readFile(filePath)).digest("hex")}`;
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
  });
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? result.error?.message})\n`
      + `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
    );
  }
  return result;
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    }
    const timeout = options.timeout === undefined
      ? undefined
      : setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
      }, options.timeout);
    child.once("error", (error) => {
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status, signal) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      const result = { status, signal, stdout, stderr };
      if (!options.allowFailure && status !== 0) {
        reject(new Error(
          `${command} ${args.join(" ")} failed (${status ?? signal})\n${stdout}\n${stderr}`,
        ));
        return;
      }
      resolve(result);
    });
  });
}

async function runScriptedInteractive(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  let cursor = 0;
  let closed;
  const completion = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      closed = { status, signal };
      resolve(closed);
    });
  });
  const deadline = Date.now() + (options.timeout ?? 60_000);

  try {
    for (const step of options.steps ?? []) {
      const matchEnd = await waitForScriptedOutput({
        output: () => stdout,
        stderr: () => stderr,
        cursor,
        expected: step.waitFor,
        deadline,
        closed: () => closed,
      });
      cursor = matchEnd;
      if (step.send !== undefined) child.stdin.write(`${step.send}\n`);
    }
    const remaining = Math.max(1, deadline - Date.now());
    const timeout = new Promise((_, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Interactive command did not exit within ${options.timeout ?? 60_000}ms.`));
      }, remaining);
      timer.unref();
    });
    const result = await Promise.race([completion, timeout]);
    if (result.status !== 0) {
      throw new Error(
        `${command} ${args.join(" ")} failed (${result.status ?? result.signal})\n${stdout}\n${stderr}`,
      );
    }
    return { ...result, stdout, stderr };
  } catch (error) {
    if (!closed) child.kill("SIGKILL");
    throw error;
  } finally {
    child.stdin.destroy();
  }
}

async function waitForScriptedOutput(input) {
  while (Date.now() < input.deadline) {
    const segment = input.output().slice(input.cursor);
    if (typeof input.expected === "string") {
      const index = segment.indexOf(input.expected);
      if (index >= 0) return input.cursor + index + input.expected.length;
    } else {
      const match = segment.match(input.expected);
      if (match?.index !== undefined) return input.cursor + match.index + match[0].length;
    }
    if (input.closed()) {
      throw new Error(
        `Interactive command exited before ${String(input.expected)}.\n${input.output()}\n${input.stderr()}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Timed out waiting for interactive output ${String(input.expected)}.\n${input.output()}\n${input.stderr()}`,
  );
}

function queryPostgres(sql) {
  const result = run("docker", [
    "compose", "-f", compose, "exec", "-T", "postgres",
    "psql", "-U", "retail_admin", "-d", "northstar_commerce", "-Atc", sql,
  ], { cwd: projectRoot });
  return result.stdout.trim();
}

async function waitForPostgresState(sql, expected, timeoutMs) {
  const started = Date.now();
  let actual = "";
  while (Date.now() - started < timeoutMs) {
    actual = queryPostgres(sql);
    if (actual === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Source state did not reach ${expected}; latest value was ${actual}.`);
}

async function startPublicGuidedCommand(input) {
  const child = spawn("script", [
    "-qefc",
    `${shellQuote(input.cli)} start --from-env DATABASE_URL`,
    "/dev/null",
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
    const match = stdout.match(/Synapsor Runner local UI: (http:\/\/[^\s\r]+)/);
    return match?.[1];
  }, 60_000, () => `Public guided start did not reach Workbench.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  return {
    url,
    readyAt: Date.now(),
    output: () => `${stdout}\n${stderr}`,
    async close() {
      if (child.exitCode !== null) return;
      killProcessGroup(child.pid, "SIGTERM");
      try {
        await waitForValue(
          () => child.exitCode !== null ? child.exitCode : undefined,
          5_000,
          () => "guided Workbench did not stop after SIGTERM",
        );
      } catch {
        killProcessGroup(child.pid, "SIGKILL");
      }
    },
  };
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function killProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
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
