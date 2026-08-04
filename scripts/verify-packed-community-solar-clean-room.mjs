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
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-solar-clean-room-"));
const packRoot = path.join(tempRoot, "pack");
const installRoot = path.join(tempRoot, "install");
const projectRoot = path.join(tempRoot, "community-solar-app");
const screenshotRoot = path.join(root, "development", "runner-1.6.6-community-solar-visual");
const resultPath = path.join(root, "development", "runner-1.6.6-community-solar-results.json");
const readUrl = "postgresql://solar_technician_reader:solar_technician_reader_password@127.0.0.1:55464/community_solar";
const liveOpenAiEnabled = process.env.SYNAPSOR_LIVE_OPENAI_ACCEPTANCE === "1";
const liveOpenAiModel = process.env.SYNAPSOR_LIVE_OPENAI_MODEL?.trim() || "gpt-5-mini";
const sharedEnv = {
  ...process.env,
  DATABASE_URL: readUrl,
  DATABASE_WRITE_URL: "postgresql://solar_writer:solar_writer_password@127.0.0.1:55464/community_solar",
  SYNAPSOR_DATABASE_WRITE_URL: "postgresql://solar_writer:solar_writer_password@127.0.0.1:55464/community_solar",
  SYNAPSOR_TENANT_ID: "coop-sunward",
  SYNAPSOR_PRINCIPAL: "tech-alex",
  SYNAPSOR_OPERATOR_ID: "solar-reviewer@example.test",
};

let compose;
let ui;
let chrome;
let askProvider;
let askProviderUrl;
let askProposalTarget;
let askAggregateResult;
let askProposalResult;
let liveOpenAiKey;
const startedAt = Date.now();
const screenshots = [];
const evidence = {
  domain: "multi-tenant community-solar operations",
  package: {},
  timings_ms: {},
  interactions: {
    shell_commands_through_first_value: 1,
    browser_clicks: 0,
    browser_text_entries: 0,
    manual_file_edits: 0,
  },
  onboarding: {
    command: "synapsor-runner start",
    database_input: "hidden_session_paste",
    database_url_exported: false,
    database_url_in_process_arguments: false,
    database_url_in_output: false,
    database_url_in_generated_artifacts: false,
  },
  starter_resources: [],
  generated: {},
  first_read: {},
  aggregate: {},
  protected: {},
  write_lifecycle: {},
  ask: {},
  live_openai: {
    attempted: false,
  },
};
const solarAggregatePlan = {
  kind: "aggregate",
  resource: "public.work_orders",
  measures: [{ function: "sum", field: "downtime_minutes" }],
  dimensions: [{
    field: "model_name",
    relationship: "work_orders_inverter_model_id_fkey",
  }],
  time_bucket: { field: "opened_at", bucket: "week" },
  order_by: { kind: "measure", index: 0, direction: "desc" },
  top_n: 10,
};

try {
  await fsp.mkdir(packRoot, { recursive: true });
  await fsp.mkdir(installRoot, { recursive: true });
  await fsp.rm(screenshotRoot, { recursive: true, force: true });
  await fsp.mkdir(screenshotRoot, { recursive: true });
  if (liveOpenAiEnabled) {
    const envFile = process.env.SYNAPSOR_LIVE_OPENAI_ENV_FILE;
    assert.ok(envFile, "SYNAPSOR_LIVE_OPENAI_ENV_FILE is required for the explicitly authorized live gate");
    liveOpenAiKey = await readExpectedEnvValue(envFile, "OPENAI_API_KEY");
    sharedEnv.OPENAI_API_KEY = liveOpenAiKey;
  }
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
  const packagedFixture = path.join(packageRoot, "examples", "community-solar-clean-room");
  const cli = path.join(installRoot, "node_modules", ".bin", "synapsor-runner");
  assert.ok(fs.existsSync(path.join(packagedFixture, "prisma", "schema.prisma")), "packed Runner omitted the solar Prisma fixture");
  assert.ok(fs.existsSync(path.join(packagedFixture, "seed", "postgres.sql")), "packed Runner omitted the solar database fixture");
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

  ui = await startPublicGuidedCommand({
    cli,
    projectRoot,
    env: sharedEnv,
    sessionDatabaseUrl: readUrl,
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
  assert.match(guidedOutput, /Inspected 40 tables \(metadata only; no rows read\)/);
  assert.match(ui.output(), /Synapsor Runner local UI: http:\/\/127\.0\.0\.1:/);
  assert.match(ui.output(), /Next: review the proposed boundary, then ask your first question in Workbench/);
  await assert.rejects(fsp.access(path.join(projectRoot, ".synapsor", "exploration-boundary.active.json")));
  assert.doesNotMatch(ui.output(), /solar_technician_reader_password|solar_writer_password/);
  assertBytesAbsentFromText(processArguments(), readUrl, "process arguments after hidden database input");
  await assertBytesAbsent(path.join(projectRoot, ".synapsor"), readUrl, "generated .synapsor state");
  await assertBytesAbsent(path.join(projectRoot, "synapsor"), readUrl, "generated public boundary");
  await assertBytesAbsent(path.join(projectRoot, "synapsor.runner.json"), readUrl, "generated Runner config");

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
    if (await evaluate(page, "document.body.classList.contains('quick-start-mode')")) {
      await click(page, "#instant-full-review");
      await waitForExpression(page, "document.body.classList.contains('quick-start-mode') === false");
      await waitForValue(() => {
        try {
          const progress = JSON.parse(fs.readFileSync(
            path.join(projectRoot, ".synapsor", "boundary-review-progress.json"),
            "utf8",
          ));
          return progress.revision > 0 ? progress.revision : undefined;
        } catch {
          return undefined;
        }
      }, 5_000, () => "full-review choice was not persisted");
      await waitForExpression(page, "document.querySelector('#view-exceptions')?.classList.contains('active') === true");
      await click(page, "#access-back");
      await waitForExpression(page, "document.querySelector('#view-overview')?.classList.contains('active') === true");
    }
    await evaluate(page, "document.querySelector('#overview-table-details')?.setAttribute('open','')");
    await waitForExpression(page, "document.querySelectorAll('[data-resource-toggle]:checked').length === 3");
    await assertNoPageOverflow(page, "initial review");
    await shot(page, "01-overview.png");

    const starterResources = await evaluate(page, `[...document.querySelectorAll("[data-resource-toggle]:checked")]
      .map(input=>input.getAttribute("data-resource-toggle"))`);
    evidence.starter_resources = starterResources;
    assert.deepEqual(new Set(starterResources), new Set([
      "public.inverter_models",
      "public.solar_sites",
      "public.work_orders",
    ]));
    assert.equal(await evaluate(page, "document.body.textContent.includes('solar_technician_reader_password')"), false);

    await click(page, "#edit-boundary-tables");
    await waitForExpression(page, "document.querySelector('#view-exceptions')?.classList.contains('active') === true");
    for (const resourceId of starterResources) {
      await click(page, `[data-access-resource="${resourceId}"]`);
      await waitForExpression(page, `document.querySelector("#resource-detail h3")?.textContent === ${JSON.stringify(resourceId)}`);
      const detail = await evaluate(page, "document.querySelector('#resource-detail')?.textContent");
      assert.match(detail, /Choose one explicit tier per column/);
      assert.match(detail, /Model \+ Runner/);
      assert.match(detail, /Raw values: Runner only/);
      assert.match(detail, /Kept out/);
      if (resourceId === "public.work_orders") {
        assert.match(detail, /private_technician_notes/);
        assert.match(detail, /Kept out · free text/);
      }
      assert.match(detail, /One final confirmation, not one checkbox per table/);
      assert.equal(
        await evaluate(page, "Boolean(document.querySelector('#resource-signoff'))"),
        false,
        "Focused access review restored obsolete per-table sign-off",
      );
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
    }

    await click(page, `[data-access-resource="${starterResources[0]}"]`);
    const globalCount = await evaluate(page, "document.querySelectorAll('[data-global-decision]').length");
    assert.deepEqual(
      await evaluate(page, `({
        tag:document.querySelector("#deployment-profile")?.tagName,
        type:document.querySelector("#deployment-profile")?.type
      })`),
      { tag: "INPUT", type: "hidden" },
      "Fresh guided Workbench must not ask for another environment declaration",
    );
    for (let index = 0; index < globalCount; index += 1) {
      if (!await evaluate(page, `document.querySelector('[data-global-decision="${index}"]')?.checked === true`)) {
        await evaluate(page, `document.querySelector('[data-global-decision="${index}"]').click(); true`);
      }
      await waitForExpression(page, `document.querySelector('[data-global-decision="${index}"]')?.checked === true`);
    }
    await waitForExpression(page, "[...document.querySelectorAll('[data-global-decision]')].every(input=>input.checked)");
    await waitForExpression(page, "document.querySelector('#review-staged-access')?.offsetParent !== null");
    await click(page, "#review-staged-access");
    await waitForExpression(page, "document.querySelector('#view-activate')?.classList.contains('active') === true");
    await waitForExpression(page, "!document.querySelector('#signoff-summary')?.textContent.includes('remain')");
    await type(page, "#actor", "solar-reviewer@example.test");
    await waitForExpression(page, "document.querySelector('#preview')?.disabled === false");
    await click(page, "#preview");
    await waitForExpression(
      page,
      "document.querySelector('#view-explore')?.classList.contains('active') === true || document.querySelector('#message')?.classList.contains('error')",
    );
    const previewMessage = await evaluate(page, "document.querySelector('#message')?.textContent");
    assert.match(previewMessage, /reviewed boundary is active/i);
    const boundaryDigest = await evaluate(page, "document.querySelector('#message code')?.textContent");
    assert.match(boundaryDigest, /^sha256:[a-f0-9]{64}$/);
    await shot(page, "02-activated-and-ready-to-ask.png");
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

    await waitForExpression(page, "document.querySelector('#explore-composer')?.open === true");
    await click(page, "#row-tab");
    await waitForExpression(page, "document.querySelector('#row-builder')?.classList.contains('hidden') === false");
    await selectVisibleOption(page, "#row-resource", /work orders/i);
    await type(page, "#row-id", "wo-001");
    await click(page, "#run-explore");
    await waitForExpression(page, "document.querySelector('#explore-result')?.textContent.includes('Your reviewed question worked.')");
    const firstReadText = await evaluate(page, "document.querySelector('#explore-result')?.textContent");
    assert.match(firstReadText, /Source database changed:\s*no/i);
    assert.match(firstReadText, /Trusted scope:\s*supplied outside the question/i);
    assert.doesNotMatch(firstReadText, /synthetic private work note|other tenant private work note/i);
    evidence.first_read = {
      resource: "public.work_orders",
      object_id: "wo-001",
      source_database_changed: false,
      tenant_scope: "coop-sunward",
      principal_scope: "tech-alex",
    };
    evidence.timings_ms.first_safe_read = Date.now() - startedAt;
    await evaluate(page, "document.querySelector('#explore-result')?.scrollIntoView({block:'center'})");
    await shot(page, "04-first-safe-read.png");

    await click(page, "#aggregate-tab");
    await selectVisibleOption(page, "#aggregate-resource", /work orders/i);
    await selectVisibleOption(page, "#aggregate-measure", /total downtime minutes/i);
    await selectVisibleOption(page, "#aggregate-dimension", /model name.*inverter models/i);
    await selectVisibleOption(page, "#aggregate-time", /opened at/i);
    await select(page, "#aggregate-bucket", "week");
    await click(page, "#run-explore");
    await waitForExpression(page, "document.querySelector('#explore-result')?.textContent.includes('Your reviewed question worked.')");
    const aggregateText = await evaluate(page, "document.querySelector('#explore-result')?.textContent");
    assert.match(aggregateText, /total downtime minutes/i);
    assert.match(aggregateText, /model name/i);
    assert.match(aggregateText, /Total downtime minutes/i);
    assert.match(aggregateText, /Source database changed:\s*no/i);
    assert.doesNotMatch(aggregateText, /synthetic-access-token|private work note/i);
    const aggregatePlan = await evaluate(page, "document.querySelector('#plan-preview')?.textContent");
    assert.doesNotMatch(aggregatePlan, /\bSELECT\b|\bJOIN\b|\bSQL\b/i);
    assert.match(aggregatePlan, /work_orders_inverter_model_id_fkey/);
    evidence.aggregate = {
      question: "How did total downtime change by week across reviewed inverter models?",
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
      name: "community-solar-clean-room-authoring",
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
            resource: "public.work_orders",
            select: ["id", "status", "version"],
            where: [{ field: "id", op: "eq", value: "wo-001" }],
            limit: 1,
          },
        },
      }));
      assert.equal(assigned.ok, true);
      assert.equal(assigned.data.length, 1);
      assert.equal(assigned.data[0].id, "wo-001");

      for (const [objectId, label] of [
        ["wo-028", "same-tenant other-principal row"],
        ["wo-other-001", "cross-tenant row"],
      ]) {
        const denied = resultPayload(await client.callTool({
          name: "app.explore_data",
          arguments: {
            plan: {
              kind: "rows",
              resource: "public.work_orders",
              select: ["id", "status", "version"],
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
        arguments: { plan: solarAggregatePlan },
      }));
      assert.equal(mcpAggregate.ok, true);
      assert.equal(mcpAggregate.source_database_changed, false);
      assert.doesNotMatch(
        JSON.stringify(mcpAggregate),
        /wo-other-001|tech-jordan|tech-other|synthetic-access-token|private work note/i,
      );

      const refusalCases = [
        [{
          ...solarAggregatePlan,
          dimensions: [{ field: "assigned_technician_id" }],
        }, "kept-out dimension"],
        [{
          ...solarAggregatePlan,
          where: [{
            field: "private_technician_notes",
            op: "eq",
            value: "synthetic private work note 1",
          }],
        }, "kept-out filter"],
        [{
          ...solarAggregatePlan,
          measures: [{ function: "count_distinct", field: "assigned_technician_id" }],
        }, "kept-out count distinct"],
        [{ ...solarAggregatePlan, tenant: "coop-riverbend" }, "model-selected tenant"],
        [{ ...solarAggregatePlan, principal: "tech-jordan" }, "model-selected principal"],
        [{
          ...solarAggregatePlan,
          dimensions: [{ field: "name", relationship: "unreviewed_relationship" }],
        }, "unreviewed relationship"],
        [{
          ...solarAggregatePlan,
          dimensions: [{
            field: "name",
            relationship: "work_order_assignments_many_to_many",
          }],
        }, "fan-out relationship"],
        [{
          ...solarAggregatePlan,
          measures: [{ function: "percentile", field: "downtime_minutes" }],
        }, "arbitrary aggregate function"],
        [{ ...solarAggregatePlan, sql: "SELECT * FROM public.work_orders" }, "raw SQL"],
        [{ ...solarAggregatePlan, top_n: 51 }, "top-N overflow"],
        [{
          ...solarAggregatePlan,
          dimensions: [
            ...solarAggregatePlan.dimensions,
            { field: "status" },
            { field: "payment_status" },
            { field: "inspection_failed" },
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
    await waitForExpression(page, "document.querySelector('#ask-authority-summary')?.textContent.includes('scoped · read-only')");
    assert.match(
      await evaluate(page, "document.querySelector('#ask-starters')?.textContent"),
      /reviewed question|weekly|downtime/i,
    );
    await configureLocalAsk(page, askProviderUrl, "solar-local-fixture");
    await type(page, "#ask-question", "How did total downtime change by week across reviewed inverter models?");
    await click(page, "#run-ask");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('reviewed weekly downtime')");
    assert.doesNotMatch(
      await evaluate(page, "document.querySelector('#ask-transcript')?.innerText"),
      /app\.explore_data|boundary digest|generation lock/i,
      "Default Workbench Ask transcript exposed internal authoring machinery",
    );
    assert.deepEqual(askAggregateResult?.data, mcpAggregate.data, "Ask and official MCP returned different aggregate groups");
    assert.equal(askAggregateResult?.source_database_changed, false);
    assert.doesNotMatch(
      JSON.stringify(askAggregateResult),
      /wo-other-001|tech-jordan|tech-other|synthetic-access-token|private work note/i,
    );
    evidence.ask = {
      provider: "custom_openai_compatible_loopback",
      aggregate_official_mcp_parity: true,
      aggregate_source_database_changed: false,
      provider_key_required: false,
      synapsor_relay: false,
    };
    await evaluate(page, "window.scrollTo(0,document.querySelector('#ask-shell').getBoundingClientRect().top+window.scrollY-76)");
    await shot(page, "05b-ask-aggregate.png");

    if (liveOpenAiEnabled) {
      assert.ok(liveOpenAiKey, "The live OpenAI gate did not load its authorized key");
      const liveQuestion = [
        "First call app.describe_data for public.work_orders.",
        "Then use only the exact reviewed identifiers it returns to call app.explore_data with exactly this analysis:",
        "sum downtime_minutes from public.work_orders,",
        "grouped by the reviewed inverter-model model_name relationship and week(opened_at),",
        "ordered by that sum descending, top 10.",
      ].join(" ");
      await assertBytesAbsent(projectRoot, liveOpenAiKey, "clean-room project before live OpenAI");
      await assertBytesAbsent(screenshotRoot, liveOpenAiKey, "screenshots before live OpenAI");
      await assertBytesAbsent(path.join(tempRoot, "chrome-profile"), liveOpenAiKey, "browser profile before live OpenAI");
      assertBytesAbsentFromText(ui.output(), liveOpenAiKey, "Workbench output before live OpenAI");
      assertBytesAbsentFromText(processArguments(), liveOpenAiKey, "process arguments before live OpenAI");

      await evaluate(page, `(() => {
        if(window.__synapsorLiveAskCaptureInstalled)return;
        const original=window.fetch.bind(window);
        window.__synapsorLiveAskCaptureInstalled=true;
        window.__synapsorLiveAskResponse=null;
        window.fetch=async (...args)=>{
          const response=await original(...args);
          const target=typeof args[0]==="string"?args[0]:args[0]?.url||"";
          if(String(target).includes("/api/ask/run")){
            response.clone().json()
              .then(payload=>{window.__synapsorLiveAskResponse=payload;})
              .catch(()=>{window.__synapsorLiveAskResponse={ok:false,error_code:"CAPTURE_FAILED"};});
          }
          return response;
        };
      })()`);
      await configureLiveOpenAiAsk(page, liveOpenAiModel);
      await type(page, "#ask-question", liveQuestion);
      const liveStartedAt = Date.now();
      await click(page, "#run-ask");
      await waitForExpression(page, "window.__synapsorLiveAskResponse !== null", 60_000);
      const liveResponse = await evaluate(page, "window.__synapsorLiveAskResponse");
      const liveLatencyMs = Date.now() - liveStartedAt;
      assert.equal(liveResponse?.ok, true, `Live OpenAI Ask failed safely: ${liveResponse?.error_code ?? "unknown"}`);
      const liveExploreCalls = liveResponse.tool_calls?.filter((call) => call.tool === "app.explore_data") ?? [];
      const liveExploreCall = liveExploreCalls.find((call) => call.status === "ok");
      assert.ok(
        liveExploreCall,
        `Live OpenAI did not complete the reviewed aggregate tool: ${liveExploreCalls
          .map((call) => call.error_code ?? call.result?.error_code ?? "unknown")
          .join(", ") || "not called"}`,
      );
      assert.deepEqual(
        liveExploreCall.result?.data,
        mcpAggregate.data,
        "Live OpenAI and official MCP returned different aggregate groups",
      );
      assert.equal(liveResponse.source_database_changed, false);
      assert.equal(liveResponse.model_can_activate, false);
      assert.equal(liveResponse.model_can_approve, false);
      assert.equal(liveResponse.model_can_apply, false);
      assert.doesNotMatch(
        JSON.stringify(liveExploreCall.result),
        /wo-other-001|tech-jordan|tech-other|synthetic-access-token|private work note/i,
      );

      await click(page, "#clear-ask");
      await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.length === 0");
      const browserStorage = await evaluate(page, "({local:localStorage.length,session:sessionStorage.length})");
      assert.deepEqual(browserStorage, { local: 0, session: 0 }, "Live OpenAI Ask wrote browser storage");
      await assertBytesAbsent(projectRoot, liveOpenAiKey, "clean-room project after live OpenAI");
      await assertBytesAbsent(screenshotRoot, liveOpenAiKey, "screenshots after live OpenAI");
      await assertBytesAbsent(path.join(tempRoot, "chrome-profile"), liveOpenAiKey, "browser profile after live OpenAI");
      assertBytesAbsentFromText(ui.output(), liveOpenAiKey, "Workbench output after live OpenAI");
      assertBytesAbsentFromText(processArguments(), liveOpenAiKey, "process arguments after live OpenAI");
      assertBytesAbsentFromText(JSON.stringify(evidence), liveOpenAiKey, "evidence before recording live OpenAI");
      await assertBytesAbsent(projectRoot, liveQuestion, "clean-room project conversation persistence");
      await assertBytesAbsent(path.join(tempRoot, "chrome-profile"), liveQuestion, "browser-profile conversation persistence");
      evidence.live_openai = {
        attempted: true,
        provider: liveResponse.provider,
        model: liveResponse.model,
        success: true,
        failure_class: null,
        tool_sequence: liveResponse.tool_calls.map((call) => ({
          tool: call.tool,
          status: call.status,
          ...(call.error_code ? { error_code: call.error_code } : {}),
        })),
        usage: liveResponse.usage ?? null,
        latency_ms: liveLatencyMs,
        authority_parity: true,
        source_database_changed: false,
        secret_scan: {
          exact_key_absent_before: true,
          exact_key_absent_after: true,
          browser_storage_entries: 0,
          conversation_absent_from_project_and_browser_profile: true,
        },
      };
      assertBytesAbsentFromText(JSON.stringify(evidence.live_openai), liveOpenAiKey, "recorded live OpenAI evidence");
    }

    await click(page, "#protect-result");
    await waitForExpression(page, "document.querySelector('#view-protect')?.classList.contains('active') === true");
    await waitForExpression(page, "Boolean(document.querySelector('#create-protected'))");
    await type(page, "#protect-name", "solar.weekly_downtime_by_inverter_model");
    await type(page, "#protect-description", "Show reviewed weekly downtime by inverter model.");
    await click(page, "#create-protected");
    await waitForExpression(page, "Boolean(document.querySelector('#activate-protected'))");
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
    await type(page, "#protect-actor", "solar-reviewer@example.test");
    await click(page, "#activate-protected");
    await waitForExpression(page, "document.querySelector('#protect-message')?.textContent.includes('active')");
    const protectedDraftRoot = path.join(
      projectRoot,
      "synapsor",
      "protected",
      "drafts",
      "solar__weekly_downtime_by_inverter_model",
    );
    const protectedDsl = await fsp.readFile(
      path.join(protectedDraftRoot, "capability.synapsor.sql"),
      "utf8",
    );
    assert.equal(protectedPreviewDsl, protectedDsl, "Highlighted protected DSL changed persisted source text");
    assert.match(protectedDsl, /PROTECTED READ AGGREGATE/);
    assert.match(protectedDsl, /PROTECTED RELATIONSHIP work_orders_inverter_model_id_fkey/);
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
      capability: "solar.weekly_downtime_by_inverter_model",
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
    await select(page, "#action-resource", "public.work_orders");
    await select(page, "#action-operation", "update");
    await type(page, "#action-name", "solar.propose_work_order_start");
    await type(page, "#action-description", "Propose moving one assigned open work order into progress.");
    await click(page, '[data-action-field="status"]');
    await select(page, '[data-action-mode="status"]', "fixed");
    await type(page, '[data-action-fixed="status"]', "in_progress");
    await type(page, '[data-action-from="status"]', "open");
    await select(page, "#action-conflict", "version");
    await type(page, "#action-role", "solar_maintenance_reviewer");
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
      (draft) => draft.capability === "solar.propose_work_order_start",
    );
    assert.ok(actionDraftRecord?.dsl_path, "Guided action draft did not record its DSL path");
    assert.equal(
      actionPreviewDsl,
      await fsp.readFile(path.join(projectRoot, actionDraftRecord.dsl_path), "utf8"),
      "Highlighted guided-action DSL changed persisted source text",
    );
    const previewInputs = await evaluate(page, `[...document.querySelectorAll("[data-action-preview]")]
      .map(input=>input.getAttribute("data-action-preview"))`);
    assert.deepEqual(previewInputs, ["work_order_id"]);
    await type(page, '[data-action-preview="work_order_id"]', "wo-005");
    await click(page, "#preview-action");
    await waitForExpression(page, "document.querySelector('#action-status')?.textContent.includes('Proposal created')");
    evidence.timings_ms.first_guided_proposal = Date.now() - startedAt;
    const actionDigest = await evaluate(page, "document.querySelector('[data-action-digest]')?.textContent");
    assert.match(actionDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(queryPostgres("SELECT status || ':' || version FROM public.work_orders WHERE id = 'wo-005'"), "open:1");
    await type(page, "#action-actor", "solar-reviewer@example.test");
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
    assert.equal(queryPostgres("SELECT status || ':' || version FROM public.work_orders WHERE id = 'wo-005'"), "open:1");
    assert.match(await evaluate(page, "document.querySelector('#detail')?.textContent"), /Source database changed:\s*No/i);

    if (await evaluate(page, `[...document.querySelectorAll("button")]
      .some(button=>button.textContent.trim()==="Check live freshness")`)) {
      await clickText(page, "button", "Check live freshness");
      await waitForExpression(page, "document.querySelector('#detail')?.textContent.includes('Freshness: fresh')");
    }
    const proposalHash = await evaluate(page, `document.querySelector('[aria-label="Exact approval confirmation"]')
      ?.placeholder.replace("APPROVE ","")`);
    assert.match(proposalHash, /^sha256:[a-f0-9]{64}$/);
    await type(page, '[aria-label="Approval reason"]', "Reviewed exact open-to-in-progress transition.");
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
    assert.equal(queryPostgres("SELECT status || ':' || version FROM public.work_orders WHERE id = 'wo-005'"), "open:1");
    await type(page, '[aria-label="Apply reason"]', "Commit the independently approved work-order transition.");
    await type(page, '[aria-label="Exact apply confirmation"]', `APPLY ${proposalHash}`);
    await shot(page, "11-approved-awaiting-apply.png");
    await clickText(page, "button", "Apply guarded writeback");
    await waitForPostgresState(
      "SELECT status || ':' || version FROM public.work_orders WHERE id = 'wo-005'",
      "in_progress:2",
      60_000,
    );
    await waitForExpression(page, "document.querySelector('#detail')?.textContent.includes('Committed by the trusted runner')");
    assert.equal(queryPostgres("SELECT status || ':' || version FROM public.work_orders WHERE id = 'wo-005'"), "in_progress:2");
    await shot(page, "12-guarded-apply.png");

    await clickText(page, "button", "Ledger timeline");
    await waitForExpression(page, `![...document.querySelectorAll("#detail .pane")]
      .find(pane=>pane.textContent.includes("Immutable proposal"))?.classList.contains("hidden")`);
    const ledgerText = await evaluate(page, "document.querySelector('#detail')?.textContent");
    assert.match(ledgerText, /receipt/i);
    assert.match(ledgerText, /replay/i);
    assert.doesNotMatch(ledgerText, /solar_writer_password|synthetic private work note|other tenant private work note/i);
    await shot(page, "13-ledger-timeline.png");

    evidence.write_lifecycle = {
      capability: "solar.propose_work_order_start",
      target: "public.work_orders:wo-005",
      proposal_hash: proposalHash,
      action_digest: actionDigest,
      before: { status: "open", version: 1 },
      after: { status: "in_progress", version: 2 },
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
      "SELECT id FROM public.work_orders WHERE cooperative_id = 'coop-sunward' AND assigned_technician_id = 'tech-alex' AND status = 'open' AND id NOT IN ('wo-005','wo-010') ORDER BY id LIMIT 1",
    );
    assert.match(askProposalTarget, /^wo-/);
    const escapedAskTarget = askProposalTarget.replaceAll("'", "''");
    const askBefore = queryPostgres(
      `SELECT status || ':' || version FROM public.work_orders WHERE id = '${escapedAskTarget}'`,
    );
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
    await configureLocalAsk(page, askProviderUrl, "solar-local-fixture");
    await type(page, "#ask-question", `Propose starting reviewed work order ${askProposalTarget}.`);
    await click(page, "#run-ask");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('proposal for operator review')");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('Proposal only')");
    assert.equal(askProposalResult?.source_database_changed, false);
    assert.match(JSON.stringify(askProposalResult), /proposal|pending_review/i);
    assert.equal(
      queryPostgres(`SELECT status || ':' || version FROM public.work_orders WHERE id = '${escapedAskTarget}'`),
      askBefore,
      "Ask proposal mutated the source database",
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
    "solar__weekly_downtime_by_inverter_model",
    "capability.synapsor.sql",
  );
  const protectedContractPath = path.join(
    projectRoot,
    "synapsor",
    "protected",
    "active",
    "solar__weekly_downtime_by_inverter_model.contract.json",
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
      "solar.propose_work_order_start",
      "solar.weekly_downtime_by_inverter_model",
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
    name: "community-solar-clean-room-runtime",
  }, async (client) => {
    const listed = await client.listTools();
    runtimeTools = listed.tools;
    assert.deepEqual(
      listed.tools.map((tool) => tool.name).sort(),
      [
        "solar.propose_work_order_start",
        "solar.weekly_downtime_by_inverter_model",
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
      name: "solar.weekly_downtime_by_inverter_model",
      arguments: {},
    }));
    assert.equal(protectedRuntimeResult.ok, true);
    assert.equal(protectedRuntimeResult.source_database_changed, false);
    assert.doesNotMatch(
      JSON.stringify(protectedRuntimeResult),
      /wo-other-001|tech-jordan|tech-other|synthetic-access-token|private work note/i,
    );

    assert.equal(queryPostgres(
      "SELECT status || ':' || version FROM public.work_orders WHERE id = 'wo-010'",
    ), "open:1");
    proposalOnlyResult = resultPayload(await client.callTool({
      name: "solar.propose_work_order_start",
      arguments: { work_order_id: "wo-010" },
    }));
    assert.equal(proposalOnlyResult.source_database_changed, false);
    assert.match(JSON.stringify(proposalOnlyResult), /proposal/i);
    assert.equal(queryPostgres(
      "SELECT status || ':' || version FROM public.work_orders WHERE id = 'wo-010'",
    ), "open:1");
  });

  const lifecycle = JSON.parse(run(cli, [
    "lifecycle", "show", "latest", "--details", "--json",
  ], { cwd: projectRoot, env: sharedEnv }).stdout);
  assert.equal(lifecycle.proposal.source_database_mutated, false);
  assert.match(JSON.stringify(lifecycle), /solar\.propose_work_order_start/);
  const audit = JSON.parse(run(cli, [
    "query-audit", "list", "--json",
  ], { cwd: projectRoot, env: sharedEnv }).stdout);
  assert.ok(audit.query_audit.length >= 4);
  assert.doesNotMatch(
    JSON.stringify(audit),
    /solar_technician_reader_password|solar_writer_password|private work note|wo-other-001/i,
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

  evidence.generated = {
    dsl: "synapsor/generated/read-capabilities.synapsor.sql",
    canonical_contract: "synapsor/generated/synapsor.candidate.contract.json",
    generation_lock: ".synapsor/generation-lock.json",
    review_report: ".synapsor/review-report.json",
    config: "synapsor.runner.json",
    store: ".synapsor/local.db",
  };
  await assertBytesAbsent(screenshotRoot, readUrl, "screenshots after hidden database input");
  await assertBytesAbsent(path.join(tempRoot, "chrome-profile"), readUrl, "browser profile after hidden database input");
  assertBytesAbsentFromText(JSON.stringify(evidence), readUrl, "clean-room evidence after hidden database input");
  evidence.elapsed_ms = Date.now() - startedAt;
  evidence.screenshots = screenshots;
  await fsp.writeFile(resultPath, `${JSON.stringify(evidence, null, 2)}\n`);
  if (liveOpenAiEnabled) {
    assert.ok(liveOpenAiKey);
    await assertBytesAbsent(resultPath, liveOpenAiKey, "live OpenAI evidence output");
  }
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

async function configureLiveOpenAiAsk(page, model) {
  if (await evaluate(page, "document.querySelector('#ask-configuration-form')?.classList.contains('hidden') === true")) {
    await click(page, "#change-ask-provider");
  }
  await select(page, "#ask-provider", "openai");
  await type(page, "#ask-model", model);
  await select(page, "#ask-key-source", "environment");
  await type(page, "#ask-key-env", "OPENAI_API_KEY");
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
        assert.equal(body.model, "solar-local-fixture");
        const messages = Array.isArray(body.messages) ? body.messages : [];
        const serialized = JSON.stringify(messages);
        const proposal = /Propose starting reviewed work order/i.test(serialized);
        const toolResult = [...messages].reverse().find((message) => message?.role === "tool");
        response.setHeader("content-type", "application/json");
        if (toolResult) {
          const result = JSON.parse(toolResult.content);
          if (proposal) askProposalResult = result;
          else askAggregateResult = result;
          response.end(JSON.stringify({
            choices: [{
              message: {
                role: "assistant",
                content: proposal
                  ? "I created a proposal for operator review. The source database has not changed."
                  : "The reviewed weekly downtime analysis is complete.",
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
                id: proposal ? "call_solar_proposal" : "call_solar_aggregate",
                type: "function",
                function: {
                  name: proposal
                    ? "solar__propose_work_order_start"
                    : "app__explore_data",
                  arguments: JSON.stringify(proposal
                    ? { work_order_id: askProposalTarget }
                    : { plan: solarAggregatePlan }),
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
    /SELECT\s|JOIN\s|synthetic private work note|solar_technician_reader_password/i,
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

function objectHasKey(value, forbidden) {
  if (Array.isArray(value)) return value.some((item) => objectHasKey(item, forbidden));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) =>
    forbidden.has(key.toLowerCase()) || objectHasKey(item, forbidden));
}

async function readExpectedEnvValue(filePath, expectedName) {
  const contents = await fsp.readFile(filePath, "utf8");
  const matches = [];
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || match[1] !== expectedName) continue;
    let value = match[2].trim();
    if (
      value.length >= 2
      && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    matches.push(value);
  }
  assert.equal(matches.length, 1, `Expected exactly one ${expectedName} assignment in the authorized env file`);
  assert.ok(matches[0].length >= 8, `The authorized ${expectedName} value is missing or malformed`);
  return matches[0];
}

async function assertBytesAbsent(targetPath, secret, label) {
  const needle = Buffer.from(secret);
  const visit = async (candidate) => {
    const stat = await fsp.lstat(candidate).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat || stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      const entries = await fsp.readdir(candidate);
      for (const entry of entries) await visit(path.join(candidate, entry));
      return;
    }
    if (!stat.isFile()) return;
    const contents = await fsp.readFile(candidate).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (contents?.includes(needle)) {
      throw new Error(`${label} contains the provider key in ${path.relative(targetPath, candidate) || path.basename(candidate)}`);
    }
  };
  await visit(targetPath);
}

function assertBytesAbsentFromText(value, secret, label) {
  assert.equal(Buffer.from(String(value)).includes(Buffer.from(secret)), false, `${label} contains the provider key`);
}

function processArguments() {
  const result = spawnSync("ps", ["-eo", "args="], { encoding: "utf8", stdio: "pipe" });
  assert.equal(result.status, 0, "Could not inspect process arguments for live-provider secret safety");
  return result.stdout;
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
    "psql", "-U", "solar_admin", "-d", "community_solar", "-Atc", sql,
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
  const commandEnv = { ...input.env };
  const command = input.sessionDatabaseUrl
    ? `${shellQuote(input.cli)} start`
    : `${shellQuote(input.cli)} start --from-env DATABASE_URL`;
  if (input.sessionDatabaseUrl) delete commandEnv.DATABASE_URL;
  const child = spawn("script", [
    "-qefc",
    command,
    "/dev/null",
  ], {
    cwd: input.projectRoot,
    env: commandEnv,
    stdio: [input.sessionDatabaseUrl ? "pipe" : "ignore", "pipe", "pipe"],
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
  if (input.sessionDatabaseUrl) {
    await waitForValue(
      () => /Paste a read-only Postgres\/MySQL URL \(input hidden\):/.test(`${stdout}\n${stderr}`) ? true : undefined,
      15_000,
      () => `Public guided start did not request hidden database input.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.stdin.write(`${input.sessionDatabaseUrl}\n`);
  }
  const url = await waitForValue(() => {
    const match = stdout.match(/Synapsor Runner local UI: (http:\/\/[^\s\r]+)/);
    return match?.[1];
  }, 60_000, () => `Public guided start did not reach Workbench.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  if (input.sessionDatabaseUrl) {
    assert.doesNotMatch(`${stdout}\n${stderr}`, new RegExp(escapeRegExp(input.sessionDatabaseUrl)));
  }
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
