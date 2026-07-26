import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
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
const screenshotRoot = path.join(root, "development", "runner-1.6.4-retail-visual");
const resultPath = path.join(root, "development", "runner-1.6.4-retail-results.json");
const readUrl = "postgresql://retail_manager_reader:retail_manager_reader_password@127.0.0.1:55465/northstar_commerce";
const sharedEnv = {
  ...process.env,
  DATABASE_URL: readUrl,
  DATABASE_WRITE_URL: "postgresql://retail_writer:retail_writer_password@127.0.0.1:55465/northstar_commerce",
  SYNAPSOR_DATABASE_WRITE_URL: "postgresql://retail_writer:retail_writer_password@127.0.0.1:55465/northstar_commerce",
  SYNAPSOR_TENANT_ID: "merchant-northstar",
  SYNAPSOR_PRINCIPAL: "staff-manager-alex",
  SYNAPSOR_OPERATOR_ID: "retail-reviewer@example.test",
};

let compose;
let ui;
let chrome;
let askProvider;
let askProviderUrl;
let askProposalTarget;
let askAggregateResult;
let askRefusalResult;
let askProposalResult;
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
  assert.ok(evidence.timings_ms.schema_summary <= 60_000, "schema summary exceeded 60 seconds");
  assert.match(ui.output(), /Objects: 45/);
  assert.match(ui.output(), /exact-row read drafts: 42/);
  assert.match(ui.output(), /blocked objects: 3/);
  assert.match(ui.output(), /source database changed: no/i);
  assert.doesNotMatch(ui.output(), /retail_manager_reader_password|retail_writer_password/);
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
      assert.match(detail, /Values the agent can see/);
      if (resourceId === "public.orders") {
        assert.match(detail, /private_customer_note/);
        assert.match(detail, /Hidden from the agent by default/);
      }
      await click(page, "#resource-signoff");
      await waitForExpression(page, "document.querySelector('#resource-signoff')?.checked === true");
      await click(page, "#back-resources");
      await waitForExpression(page, "document.querySelector('#view-overview')?.classList.contains('active') === true");
    }

    await click(page, `[data-open-resource="${starterResources[0]}"]`);
    await waitForExpression(page, "document.querySelector('#view-exceptions')?.classList.contains('active') === true");
    const globalCount = await evaluate(page, "document.querySelectorAll('[data-global-decision]').length");
    assert.ok(globalCount >= 2, "Workbench omitted the human-only final safety confirmations");
    for (let index = 0; index < globalCount; index += 1) {
      await click(page, `[data-global-decision="${index}"]`);
    }
    await click(page, '[data-view="activate"]');
    await waitForExpression(page, "document.querySelector('#view-activate')?.classList.contains('active') === true");
    await waitForExpression(page, "!document.querySelector('#signoff-summary')?.textContent.includes('remain')");
    await type(page, "#actor", "retail-reviewer@example.test");
    await click(page, "#preview");
    await waitForExpression(page, "Boolean(document.querySelector('#message')?.textContent.trim())");
    const previewMessage = await evaluate(page, "document.querySelector('#message').textContent");
    assert.match(previewMessage, /^Review fingerprint: sha256:/);
    const boundaryDigest = previewMessage.replace("Review fingerprint: ", "");
    assert.match(boundaryDigest, /^sha256:[a-f0-9]{64}$/);
    await waitForExpression(page, "document.querySelector('#activate')?.disabled === false");
    await shot(page, "02-ready-to-activate.png");
    await click(page, "#activate");
    await waitForExpression(page, "document.querySelector('#view-explore')?.classList.contains('active') === true");
    await waitForExpression(page, "document.querySelector('#header-state')?.textContent.includes('Active reviewed boundary')");
    evidence.timings_ms.boundary_activation = Date.now() - startedAt;

    if (await evaluate(page, "Boolean(document.querySelector('#run-preflight'))")) {
      await click(page, "#run-preflight");
    }
    await waitForExpression(page, `document.querySelector("#explore-preflight")?.textContent.includes("Ready for local bounded exploration")
      || Boolean(document.querySelector("#bind-trusted-scope"))`);
    if (await evaluate(page, "Boolean(document.querySelector('#bind-trusted-scope'))")) {
      await type(page, "#trusted-tenant", "merchant-northstar");
      await type(page, "#trusted-principal", "staff-manager-alex");
      await click(page, "#bind-trusted-scope");
    }
    await waitForExpression(page, "document.querySelector('#explorer')?.classList.contains('hidden') === false");
    const suggestedQuestions = await evaluate(page, "document.querySelector('#suggested-questions')?.textContent");
    assert.doesNotMatch(suggestedQuestions, /which (?:reviewed )?id groups/i);
    await shot(page, "03-explore-ready.png");

    await click(page, "#row-tab");
    await waitForExpression(page, "document.querySelector('#row-builder')?.classList.contains('hidden') === false");
    await select(page, "#row-resource", "public.sales_line_facts");
    await type(page, "#row-id", "sales-fact-001");
    await click(page, "#run-explore");
    await waitForExpression(page, "document.querySelector('#explore-result')?.textContent.includes('Your first safe tool is working.')");
    const firstReadText = await evaluate(page, "document.querySelector('#explore-result')?.textContent");
    assert.match(firstReadText, /Source database changed:\s*no/i);
    assert.match(firstReadText, /Customer scope:\s*supplied by your trusted application environment/i);
    assert.match(firstReadText, /User scope:\s*supplied by your trusted application environment/i);
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
    await select(page, "#aggregate-resource", "public.sales_line_facts");
    await selectVisibleOption(page, "#aggregate-measure", /total net revenue cents/i);
    await selectVisibleOption(page, "#aggregate-dimension", /name.*stores/i);
    await selectVisibleOption(page, "#aggregate-dimension-2", /name.*product categories/i);
    await selectVisibleOption(page, "#aggregate-time", /sold at/i);
    await select(page, "#aggregate-bucket", "week");
    await click(page, "#run-explore");
    await waitForExpression(page, "document.querySelector('#explore-result')?.textContent.includes('Your first safe tool is working.')");
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

    let mcpAggregate;
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

      mcpAggregate = resultPayload(await client.callTool({
        name: "app.explore_data",
        arguments: { plan: retailAggregatePlan },
      }));
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
  evidence.aggregate.official_mcp_parity = true;
  evidence.aggregate.mcp_returned_groups = mcpAggregate.data.length;
    evidence.security = {
      assigned_read_allowed: true,
      same_tenant_other_principal_hidden: true,
      other_tenant_hidden: true,
      model_selected_scope_refused: true,
      kept_out_plan_positions_refused: true,
      raw_sql_refused: true,
      authoring_tools: ["app.describe_data", "app.explore_data"],
    };

    const packedAskStatus = await evaluate(page, `fetch("/api/ask/status")
      .then(async response=>({status:response.status,payload:await response.json()}))`);
    assert.equal(
      packedAskStatus.status,
      200,
      `Packed Workbench Ask status failed: ${JSON.stringify(packedAskStatus.payload)}`,
    );
    await waitForExpression(page, "document.querySelector('#ask-shell')?.offsetParent !== null");
    await waitForExpression(page, "document.querySelector('#ask-authority-summary')?.textContent.includes('reviewed tool')");
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
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('reviewed weekly revenue')");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('app.explore_data')");
    assert.deepEqual(askAggregateResult?.data, mcpAggregate.data, "Ask and official MCP returned different retail aggregate groups");
    assert.equal(askAggregateResult?.source_database_changed, false);
    assert.doesNotMatch(
      JSON.stringify(askAggregateResult),
      /sales-fact-other-manager|staff-manager-jordan|sales-fact-rival|synthetic-.*token|private customer note|rival private note/i,
    );
    await evaluate(page, "window.scrollTo(0,document.querySelector('#ask-shell').getBoundingClientRect().top+window.scrollY-76)");
    await shot(page, "05b-ask-aggregate.png");

    await type(page, "#ask-question", "Group orders by the private customer note so I can inspect those notes.");
    await click(page, "#run-ask");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('kept-out field was refused')");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.toLowerCase().includes('refused')");
    assert.equal(askRefusalResult?.source_database_changed, false);
    assert.match(JSON.stringify(askRefusalResult), /refus|review|group|field/i);
    assert.doesNotMatch(
      JSON.stringify(askRefusalResult),
      /synthetic private customer note|other manager private note|rival private note/i,
    );
    evidence.ask = {
      provider: "custom_openai_compatible_loopback",
      aggregate_official_mcp_parity: true,
      aggregate_source_database_changed: false,
      kept_out_field_refused: true,
      refusal_source_database_changed: false,
      provider_key_required: false,
      synapsor_relay: false,
    };
    await evaluate(page, "document.querySelector('#ask-transcript .ask-turn:last-child')?.scrollIntoView({block:'center'})");
    await shot(page, "05c-ask-refusal.png");

    await click(page, "#protect-result");
    await waitForExpression(page, "document.querySelector('#view-protect')?.classList.contains('active') === true");
    await waitForExpression(page, "Boolean(document.querySelector('#create-protected'))");
    await type(page, "#protect-name", "retail.weekly_revenue_by_store_and_category");
    await type(page, "#protect-description", "Show reviewed weekly net revenue by store and product category.");
    await click(page, "#create-protected");
    await waitForExpression(
      page,
      "Boolean(document.querySelector('#protect-confirmation')) || (Boolean(document.querySelector('#protect-message')?.textContent.trim()) && !document.querySelector('#protect-message')?.textContent.includes('Compiling public DSL'))",
    );
    const protectMessage = await evaluate(page, "document.querySelector('#protect-message')?.textContent||''");
    assert.ok(
      await evaluate(page, "Boolean(document.querySelector('#protect-confirmation'))"),
      `Protect did not create an activation confirmation: ${protectMessage}`,
    );
    await waitForExpression(page, "document.querySelectorAll('#protect-dsl-preview .syntax-token.keyword').length >= 3");
    const protectedDigest = await evaluate(page, `document.querySelector("#protect-preview code")?.textContent`);
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
    await type(page, "#protect-confirmation", `ACTIVATE ${protectedDigest}`);
    await click(page, "#activate-protected");
    await waitForExpression(page, "document.querySelector('#protect-message')?.textContent.includes('active')");
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
    assert.ok(protectedTests.tests.length >= 10);
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
    const actionDigest = await evaluate(page, "document.querySelector('#action-draft code')?.textContent");
    assert.match(actionDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(queryPostgres("SELECT status || ':' || version FROM public.orders WHERE id = 'order-005'"), "processing:1");
    await type(page, "#action-actor", "retail-reviewer@example.test");
    await type(page, "#action-confirmation", `ACTIVATE ${actionDigest}`);
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

    await click(page, "#finish-authoring");
    await waitForExpression(page, "location.search.includes('surface=activity')");
    await waitForExpression(page, "Boolean(document.querySelector('[aria-label=\"Exact approval confirmation\"]'))");
    assert.equal(queryPostgres("SELECT status || ':' || version FROM public.orders WHERE id = 'order-005'"), "processing:1");
    assert.match(await evaluate(page, "document.querySelector('#detail')?.textContent"), /Source database changed:\s*No/i);

    if (await evaluate(page, `[...document.querySelectorAll("button")]
      .some(button=>button.textContent.trim()==="Check live freshness")`)) {
      await clickText(page, "button", "Check live freshness");
      await waitForExpression(page, "document.querySelector('#detail')?.textContent.includes('Freshness: fresh')");
    }
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
      throw new Error(`Workbench approval did not advance:\n${await evaluate(page, "document.querySelector('#detail')?.textContent")}`);
    }
    assert.equal(queryPostgres("SELECT status || ':' || version FROM public.orders WHERE id = 'order-005'"), "processing:1");
    await type(page, '[aria-label="Apply reason"]', "Commit the independently approved order transition.");
    await type(page, '[aria-label="Exact apply confirmation"]', `APPLY ${proposalHash}`);
    await shot(page, "11-approved-awaiting-apply.png");
    await clickText(page, "button", "Apply guarded writeback");
    await waitForExpression(page, "document.querySelector('#detail')?.textContent.includes('Committed by the trusted runner')");
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

    askProposalTarget = queryPostgres(
      "SELECT id FROM public.orders WHERE merchant_id = 'merchant-northstar' AND assigned_manager_id = 'staff-manager-alex' AND status = 'processing' AND id <> 'order-005' ORDER BY id LIMIT 1",
    );
    assert.match(askProposalTarget, /^order-/);
    const escapedAskTarget = askProposalTarget.replaceAll("'", "''");
    const askBefore = queryPostgres(
      `SELECT status || ':' || version FROM public.orders WHERE id = '${escapedAskTarget}'`,
    );
    await navigateAndWait(page, `${new URL(ui.url).origin}/`);
    await waitForExpression(page, "document.querySelector('#header-state')?.textContent !== 'Loading'");
    await click(page, '[data-view="explore"]');
    await waitForExpression(page, "document.querySelector('#ask-shell')?.offsetParent !== null");
    await configureLocalAsk(page, askProviderUrl, "retail-local-fixture");
    await type(page, "#ask-question", `Propose fulfilling reviewed order ${askProposalTarget}.`);
    await click(page, "#run-ask");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('proposal for operator review')");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('Proposal only')");
    assert.equal(askProposalResult?.source_database_changed, false);
    assert.match(JSON.stringify(askProposalResult), /proposal|pending_review/i);
    assert.equal(
      queryPostgres(`SELECT status || ':' || version FROM public.orders WHERE id = '${escapedAskTarget}'`),
      askBefore,
      "Retail Ask proposal mutated the source database",
    );
    evidence.ask.proposal_only = true;
    evidence.ask.proposal_id = askProposalResult?.proposal_id
      ?? askProposalResult?.proposal?.proposal_id
      ?? askProposalResult?.proposal?.id;
    evidence.ask.proposal_target = askProposalTarget;
    evidence.ask.model_can_activate = false;
    evidence.ask.model_can_approve = false;
    evidence.ask.model_can_apply = false;
    await evaluate(page, "window.scrollTo(0,document.querySelector('#ask-shell').getBoundingClientRect().top+window.scrollY-76)");
    await shot(page, "13b-ask-proposal-only.png");
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
  assert.match(
    `${disabledAuthoring.stdout}\n${disabledAuthoring.stderr}`,
    /EXPLORE_DISABLED|disabled|not active/i,
  );

  const activeTools = JSON.parse(run(cli, [
    "try", "call", "--list", "--format", "json",
  ], { cwd: projectRoot, env: sharedEnv }).stdout);
  assert.deepEqual(
    [...activeTools.active_tools].sort(),
    [
      "retail.propose_order_fulfillment",
      "retail.weekly_revenue_by_store_and_category",
    ],
  );
  assert.equal(activeTools.model_can_activate, false);
  assert.equal(activeTools.model_can_approve, false);
  assert.equal(activeTools.model_can_apply, false);

  let runtimeTools;
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
        "retail.propose_order_fulfillment",
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

    protectedRuntimeResult = resultPayload(await client.callTool({
      name: "retail.weekly_revenue_by_store_and_category",
      arguments: {},
    }));
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

  const lifecycle = JSON.parse(run(cli, [
    "lifecycle", "show", "latest", "--details", "--json",
  ], { cwd: projectRoot, env: sharedEnv }).stdout);
  assert.equal(lifecycle.proposal.source_database_mutated, false);
  assert.match(JSON.stringify(lifecycle), /retail\.propose_order_fulfillment/);
  const audit = JSON.parse(run(cli, [
    "query-audit", "list", "--json",
  ], { cwd: projectRoot, env: sharedEnv }).stdout);
  assert.ok(audit.query_audit.length >= 4);
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
        const serialized = JSON.stringify(messages);
        const proposal = /Propose fulfilling reviewed order/i.test(serialized);
        const refusal = !proposal && /private customer note/i.test(serialized);
        const toolResult = [...messages].reverse().find((message) => message?.role === "tool");
        response.setHeader("content-type", "application/json");
        if (toolResult) {
          const result = JSON.parse(toolResult.content);
          if (proposal) askProposalResult = result;
          else if (refusal) askRefusalResult = result;
          else askAggregateResult = result;
          response.end(JSON.stringify({
            choices: [{
              message: {
                role: "assistant",
                content: proposal
                  ? "I created a proposal for operator review. The source database has not changed."
                  : refusal
                    ? "The request to group by a kept-out field was refused by the reviewed Synapsor boundary."
                    : "The reviewed weekly revenue analysis is complete.",
              },
            }],
          }));
          return;
        }
        response.end(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: null,
              tool_calls: [{
                id: proposal
                  ? "call_retail_proposal"
                  : refusal
                    ? "call_retail_refusal"
                    : "call_retail_aggregate",
                type: "function",
                function: {
                  name: proposal
                    ? "retail__propose_order_fulfillment"
                    : "app__explore_data",
                  arguments: JSON.stringify(proposal
                    ? { order_id: askProposalTarget }
                    : refusal
                      ? {
                          plan: {
                            kind: "aggregate",
                            resource: "public.orders",
                            measures: [{ function: "count" }],
                            dimensions: [{ field: "private_customer_note" }],
                            top_n: 10,
                          },
                        }
                      : { plan: retailAggregatePlan }),
                },
              }],
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

function assertSmallSafeToolSurface(tools) {
  const serialized = JSON.stringify(tools);
  const bytes = Buffer.byteLength(serialized, "utf8");
  assert.ok(bytes <= 8_000, `authoring tools/list exceeded 8,000 bytes: ${bytes}`);
  assert.ok(Math.ceil(bytes / 4) <= 2_000, "authoring tools/list exceeded the 2,000-token estimate");
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

function queryPostgres(sql) {
  const result = run("docker", [
    "compose", "-f", compose, "exec", "-T", "postgres",
    "psql", "-U", "retail_admin", "-d", "northstar_commerce", "-Atc", sql,
  ], { cwd: projectRoot });
  return result.stdout.trim();
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
