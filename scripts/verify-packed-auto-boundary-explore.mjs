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
import {
  captureScreenshot,
  clickSelector,
  configurePage,
  createPage,
  launchChrome,
  navigateAndWait,
  waitForExpression,
} from "./demo-video/cdp-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runnerPackageDir = path.join(root, "apps", "runner");
const specPackageDir = path.join(root, "packages", "spec");
const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "synapsor-packed-auto-boundary-"));
const packRoot = path.join(tempRoot, "pack");
const installRoot = path.join(tempRoot, "install");
const baselineInstallRoot = path.join(tempRoot, "baseline-install");
const warmInstallRoot = path.join(tempRoot, "warm-install");
const isolatedNpmCache = path.join(tempRoot, "npm-cache");
const projectRoot = path.join(tempRoot, "project");
const baselineProjectRoot = path.join(tempRoot, "published-1.6.3-project");
const relationshipScreenshot = path.join(
  root,
  "development",
  "runner-1.6.6-demand-driven-relationship.png",
);
const readUrl = "postgresql://synapsor_churn_reader:synapsor_churn_reader_password@127.0.0.1:55460/synapsor_auto_boundary";
const adminUrl = "postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:55460/synapsor_auto_boundary";
const runtimeEnv = {
  ...process.env,
  DATABASE_URL: readUrl,
  SYNAPSOR_TENANT_ID: "acme",
  SYNAPSOR_PRINCIPAL: "pm-1",
  SYNAPSOR_OPERATOR_ID: "packed-golden-reviewer",
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
  await fsp.mkdir(baselineInstallRoot);
  await fsp.mkdir(warmInstallRoot);
  run("corepack", ["pnpm", "build:runner-package"], { cwd: root });
  const specTarball = packCurrent(packRoot, specPackageDir);
  const tarball = packCurrent(packRoot, runnerPackageDir);
  const freshInstallStartedAt = Date.now();
  run("npm", ["init", "-y"], { cwd: installRoot, env: npmInstallEnv });
  run("npm", ["install", "--ignore-scripts", specTarball], { cwd: installRoot, env: npmInstallEnv });
  run("npm", ["install", "--ignore-scripts", tarball], { cwd: installRoot, env: npmInstallEnv });
  timings.fresh_package_install_ms = Date.now() - freshInstallStartedAt;

  run("npm", ["init", "-y"], { cwd: baselineInstallRoot });
  run("npm", ["install", "--ignore-scripts", "@synapsor/runner@1.6.3"], {
    cwd: baselineInstallRoot,
  });
  const baselinePackageRoot = path.join(
    baselineInstallRoot,
    "node_modules",
    "@synapsor",
    "runner",
  );
  const baselineCli = path.join(baselinePackageRoot, "dist", "cli.js");
  assert.equal(
    JSON.parse(await fsp.readFile(path.join(baselinePackageRoot, "package.json"), "utf8")).version,
    "1.6.3",
  );

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
  await fsp.cp(packagedFixture, baselineProjectRoot, { recursive: true });
  compose = path.join(projectRoot, "docker-compose.yml");

  run("docker", ["compose", "-f", compose, "down", "-v", "--remove-orphans"], {
    cwd: projectRoot,
    allowFailure: true,
  });
  run("docker", ["compose", "-f", compose, "up", "-d", "--wait", "postgres"], {
    cwd: projectRoot,
    inherit: true,
  });
  adminPool = new Pool({ connectionString: adminUrl, max: 1 });
  const before = await sourceSnapshot(adminPool);
  const productStartedAt = Date.now();

  const baselineDraft = JSON.parse(run(process.execPath, [
    baselineCli,
    "boundary",
    "draft",
    "--from-env",
    "DATABASE_URL",
    "--project-root",
    baselineProjectRoot,
    "--json",
  ], { cwd: baselineProjectRoot, env: runtimeEnv }).stdout);
  assert.equal(baselineDraft.ok, true);
  const baselineWorkbench = await startWorkbench({
    cli: baselineCli,
    boundaryRoot: path.resolve(baselineDraft.root),
    projectRoot: baselineProjectRoot,
    env: runtimeEnv,
  });
  let baselineBoundary;
  try {
    baselineBoundary = await baselineWorkbench.json("GET", "/api/boundary");
    await baselineWorkbench.json("POST", "/api/boundary/progress", {
      candidate: baselineBoundary.candidate,
      confirmed_decisions: [],
      expected_revision: baselineBoundary.review_progress?.revision ?? 0,
      actor: "published-1.6.3-compatibility",
    });
  } finally {
    await baselineWorkbench.close();
  }
  const currentLoadedLegacyBundle = JSON.parse(run(process.execPath, [
    cli,
    "boundary",
    "review",
    "--project-root",
    baselineProjectRoot,
    "--json",
  ], { cwd: baselineProjectRoot, env: runtimeEnv }).stdout);
  assert.deepEqual(
    currentLoadedLegacyBundle.candidate,
    baselineBoundary.candidate,
    "current Runner rewrote a published 1.6.3 single-hop boundary",
  );
  assert.equal(
    currentLoadedLegacyBundle.candidate_digest,
    baselineBoundary.candidate_digest,
    "current Runner changed a published 1.6.3 single-hop boundary digest",
  );

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
    let boundaryPayload = await activationUi.json("GET", "/api/boundary");
    assert.equal(boundaryPayload.ok, true);
    for (const resourceId of ["public.accounts", "public.churn_events"]) {
      const regenerated = await activationUi.json("POST", "/api/boundary/regenerate", {
        kind: "principal_key",
        resource_id: resourceId,
        value: "owner_id",
        actor: "packed-golden-reviewer",
        reason: "The reviewed RLS policy scopes product analytics to the signed-in product manager.",
      });
      assert.equal(regenerated.ok, true);
      assert.equal(regenerated.source_database_changed, false);
    }
    boundaryPayload = await activationUi.json("GET", "/api/boundary");
    const candidate = narrowGoldenBoundary(structuredClone(boundaryPayload.candidate), {
      includeRelationship: false,
    });
    assert.ok(candidate.pack.resources.every((resource) =>
      resource.principal_key === "owner_id"
      && resource.rls_session?.principal_setting === "app.principal"),
    "managed principal review did not preserve the reviewed RLS binding");
    const staged = await activationUi.json("POST", "/api/boundary/progress", {
      candidate,
      confirmed_decisions: [],
      expected_revision: boundaryPayload.review_progress.revision,
      actor: "packed-golden-reviewer",
    });
    boundaryPayload = await activationUi.json("GET", "/api/boundary");
    const reviewedCandidate = boundaryPayload.candidate;
    const reviewed = await activationUi.json("POST", "/api/boundary/progress", {
      candidate: reviewedCandidate,
      confirmed_decisions: reviewedCandidate.unresolved_decisions,
      expected_revision: staged.revision,
      actor: "packed-golden-reviewer",
    });
    const preview = await activationUi.json("POST", "/api/boundary/preview", {
      candidate: reviewedCandidate,
      confirmed_decisions: reviewedCandidate.unresolved_decisions,
      expected_revision: reviewed.revision,
      actor: "packed-golden-reviewer",
    });
    assert.equal(preview.ok, true);
    boundaryDigest = preview.digest;
    const activated = await activationUi.json("POST", "/api/boundary/activate", {
      candidate: preview.candidate,
      expected_digest: boundaryDigest,
      actor: "packed-golden-reviewer",
      confirmation: `ACTIVATE ${boundaryDigest}`,
      confirmed_decisions: preview.candidate.unresolved_decisions,
    });
    assert.equal(activated.ok, true);
    assert.equal(activated.active.activation.state, "active");
  } finally {
    await activationUi.close();
  }

  const relationshipJourneyStartedAt = Date.now();
  const relationshipUi = await startWorkbench({ cli, boundaryRoot, projectRoot, env: runtimeEnv });
  let relationshipChrome;
  try {
    relationshipChrome = await launchChrome({
      userDataDir: path.join(tempRoot, "relationship-browser-profile"),
      width: 1440,
      height: 1000,
    });
    const page = await createPage(relationshipChrome.port);
    try {
      await configurePage(page, 1440, 1000);
      await navigateAndWait(page, relationshipUi.url);
      await waitForExpression(
        page,
        "/active reviewed boundar/i.test(document.querySelector('#header-state')?.textContent||'')",
      );
      await waitForExpression(
        page,
        "document.querySelector('#view-explore')?.classList.contains('active')"
          + " && document.body.classList.contains('ask-focus-mode')",
      );
      await waitForExpression(
        page,
        "document.querySelector('#explore-preflight')?.classList.contains('success')"
          + " && [...(document.querySelector('#aggregate-resource')?.options||[])].some(option=>/churn events/i.test(option.textContent||''))",
      );
      await waitForExpression(
        page,
        "document.querySelector('#ask-open-no-model')?.offsetParent !== null"
          + " || document.querySelector('#no-model-content')?.classList.contains('hidden') === false",
      );
      if (await evaluate(page, "document.querySelector('#no-model-content')?.classList.contains('hidden') === true")) {
        await clickSelector(page, "#ask-open-no-model");
      }
      await waitForExpression(page, "document.querySelector('#no-model-content')?.classList.contains('hidden') === false");
      await waitForExpression(page, "document.querySelector('#explore-composer')?.open === true");
      await selectVisibleOption(page, "#aggregate-resource", /churn events/i);
      await selectVisibleOption(page, "#aggregate-dimension", /region.*accounts.*human relationship review required/i);
      await clickSelector(page, "#run-explore");
      try {
        await waitForExpression(
          page,
          "document.querySelector('#explore-result')?.textContent.includes('Catalog proof available for human review')",
        );
      } catch (error) {
        const visibleState = await evaluate(page, `({
          result:document.querySelector("#explore-result")?.textContent,
          status:document.querySelector("#explore-status")?.textContent,
          resource:document.querySelector("#aggregate-resource")?.value,
          dimension:document.querySelector("#aggregate-dimension")?.value,
          plan:document.querySelector("#plan-preview")?.textContent
        })`);
        throw new Error(`Reviewable relationship refusal did not expose catalog proof.\n${JSON.stringify(visibleState, null, 2)}`, {
          cause: error,
        });
      }
      const refusal = await evaluate(page, "document.querySelector('#explore-result')?.textContent");
      assert.match(refusal, /churn_events_account_id_fkey/);
      assert.match(refusal, /many_to_one|many-to-one/i);
      assert.match(refusal, /max fan-out 1/i);
      assert.match(refusal, /unique public\.accounts\.id/i);
      assert.match(refusal, /Source database|not changed|preserved/i);
      await captureScreenshot(page, relationshipScreenshot);

      let measuredInteractions = 0;
      await clickSelector(page, "#review-missing-relationship");
      measuredInteractions += 1;
      try {
        await waitForExpression(
          page,
          "document.querySelector('#explore-result')?.textContent.includes('Exact relationship staged for activation')",
        );
      } catch (error) {
        const visibleState = await evaluate(page, `({
          result:document.querySelector("#explore-result")?.textContent,
          status:document.querySelector("#relationship-review-status")?.textContent,
          actor:document.querySelector("#relationship-review-actor")?.value
        })`);
        throw new Error(`Relationship staging did not reach exact-digest confirmation.\n${JSON.stringify(visibleState, null, 2)}`, {
          cause: error,
        });
      }
      const staged = await evaluate(page, "document.querySelector('#explore-result')?.textContent");
      assert.match(staged, /Staged review fingerprint:\s*sha256:[a-f0-9]{64}/);
      assert.match(staged, /active boundary has not changed/i);

      await clickSelector(page, "#activate-reviewed-relationship");
      measuredInteractions += 1;
      try {
        await waitForExpression(
          page,
          "document.querySelector('#explore-result')?.textContent.includes('Reviewed relationship active')",
        );
      } catch (error) {
        const visibleState = await evaluate(page, `({
          result:document.querySelector("#explore-result")?.textContent,
          status:document.querySelector("#relationship-activation-status")?.textContent,
          header:document.querySelector("#header-state")?.textContent
        })`);
        throw new Error(`Relationship activation did not complete.\n${JSON.stringify(visibleState, null, 2)}`, {
          cause: error,
        });
      }
      await clickSelector(page, "#retry-reviewed-relationship");
      measuredInteractions += 1;
      try {
        await waitForExpression(
          page,
          "document.querySelector('#explore-result')?.textContent.includes('Your reviewed question worked.')",
        );
      } catch (error) {
        const visibleState = await evaluate(page, `({
          result:document.querySelector("#explore-result")?.textContent,
          status:document.querySelector("#explore-status")?.textContent,
          header:document.querySelector("#header-state")?.textContent
        })`);
        throw new Error(`Reviewed relationship retry did not return a safe result.\n${JSON.stringify(visibleState, null, 2)}`, {
          cause: error,
        });
      }
      const result = await evaluate(page, "document.querySelector('#explore-result')?.textContent");
      assert.match(result, /Source database changed:\s*no/i);
      assert.equal(measuredInteractions, 3);
      timings.demand_driven_relationship_ms = Date.now() - relationshipJourneyStartedAt;
      timings.demand_driven_relationship_interactions = measuredInteractions;
      assert.ok(
        timings.demand_driven_relationship_ms <= 120_000,
        `demand-driven relationship review exceeded two minutes: ${timings.demand_driven_relationship_ms}ms`,
      );
    } finally {
      page.close();
    }
  } finally {
    await relationshipChrome?.close().catch(() => undefined);
    await relationshipUi.close();
  }

  const multiBoundaryUi = await startWorkbench({ cli, boundaryRoot, projectRoot, env: runtimeEnv });
  let retainedAskAuthorityDigest;
  try {
    const askStatus = await multiBoundaryUi.json("GET", "/api/ask/status");
    const sessionOnlyProviderKey = "packed-session-only-openai-key";
    const configuredAsk = await multiBoundaryUi.json("POST", "/api/ask/configure", {
      provider: "openai",
      model: "gpt-5-mini",
      api_key: sessionOnlyProviderKey,
      authority_digest: askStatus.authority_digest,
      egress_acknowledged: true,
    });
    assert.equal(configuredAsk.configuration.credential_source, "session_paste");
    assert.doesNotMatch(JSON.stringify(configuredAsk), new RegExp(sessionOnlyProviderKey));

    await withPackedMcp({
      cli,
      args: ["mcp", "serve", "--authoring", "--project-root", projectRoot],
      cwd: projectRoot,
      env: runtimeEnv,
      name: "packed-live-boundary-registry",
    }, async (liveClient) => {
      const toolsBefore = await liveClient.listTools();
      assert.deepEqual(toolsBefore.tools.map((tool) => tool.name), ["app.describe_data", "app.explore_data"]);
      const catalogBefore = resultPayload(await liveClient.callTool({
        name: "app.describe_data",
        arguments: { limit: 10 },
      }));
      assert.deepEqual(catalogBefore.boundaries.map((boundary) => boundary.name), ["product_churn"]);

    const createdBoundary = await multiBoundaryUi.json("POST", "/api/boundary/library/create", {
      name: "account_segments",
      resource_id: "public.accounts",
      actor: "packed-golden-reviewer",
    });
    const accountCandidate = structuredClone(createdBoundary.candidate);
    accountCandidate.pack.resources = accountCandidate.pack.resources.filter((resource) =>
      resource.id === "public.accounts");
    assert.equal(accountCandidate.pack.resources.length, 1);
    const stagedBoundary = await multiBoundaryUi.json("POST", "/api/boundary/progress", {
      candidate: accountCandidate,
      confirmed_decisions: [],
      expected_revision: createdBoundary.review_progress.revision,
      actor: "packed-golden-reviewer",
    });
    const stagedPayload = await multiBoundaryUi.json("GET", "/api/boundary");
    const reviewedBoundary = await multiBoundaryUi.json("POST", "/api/boundary/progress", {
      candidate: stagedPayload.candidate,
      confirmed_decisions: stagedPayload.candidate.unresolved_decisions,
      expected_revision: stagedBoundary.revision,
      actor: "packed-golden-reviewer",
    });
    const preview = await multiBoundaryUi.json("POST", "/api/boundary/preview", {
      candidate: stagedPayload.candidate,
      expected_revision: reviewedBoundary.revision,
      actor: "packed-golden-reviewer",
      confirmed_decisions: stagedPayload.candidate.unresolved_decisions,
    });
    const activated = await multiBoundaryUi.json("POST", "/api/boundary/activate", {
      candidate: preview.candidate,
      expected_digest: preview.digest,
      actor: "packed-golden-reviewer",
      confirmation: `ACTIVATE ${preview.digest}`,
      confirmed_decisions: preview.candidate.unresolved_decisions,
    });
    assert.equal(activated.active_boundary_added, "account_segments");
    assert.equal(activated.tools_list_changed, false);
    assert.equal(activated.reconnect_required, false);
    assert.equal(activated.ask_provider_session_retained, true);
    assert.equal(activated.ask_conversation_cleared, true);
    assert.equal(activated.ask_authority_refresh_pending, false);
    assert.equal(activated.ask_configuration.credential_source, "session_paste");
    assert.notEqual(activated.ask_configuration.authority_digest, askStatus.authority_digest);
    assert.doesNotMatch(JSON.stringify(activated), new RegExp(sessionOnlyProviderKey));
    retainedAskAuthorityDigest = activated.ask_configuration.authority_digest;

    const refreshedAskStatus = await multiBoundaryUi.json("GET", "/api/ask/status");
    assert.equal(refreshedAskStatus.session.configured, true);
    assert.equal(refreshedAskStatus.session.configuration.credential_source, "session_paste");
    assert.equal(refreshedAskStatus.session.configuration.authority_digest, retainedAskAuthorityDigest);
    assert.equal(refreshedAskStatus.authority_matches_consent, true);
    assert.doesNotMatch(JSON.stringify(refreshedAskStatus), new RegExp(sessionOnlyProviderKey));

      const toolsAfter = await liveClient.listTools();
      assert.deepEqual(toolsAfter.tools.map((tool) => tool.name), ["app.describe_data", "app.explore_data"]);
      const catalogAfter = resultPayload(await liveClient.callTool({
        name: "app.describe_data",
        arguments: { limit: 10 },
      }));
      assert.deepEqual(
        catalogAfter.boundaries.map((boundary) => boundary.name).sort(),
        ["account_segments", "product_churn"],
      );
    });
  } finally {
    await multiBoundaryUi.close();
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
  const accountSegmentsPlan = {
    kind: "aggregate",
    resource: "public.accounts",
    measures: [{ function: "count" }],
    dimensions: [{ field: "region" }],
    order_by: { kind: "measure", index: 0, direction: "desc" },
    top_n: 10,
  };
  const moverPlan = {
    ...goldenPlan,
    order_by: { kind: "comparison_change", index: 0, change: "percentage", direction: "desc" },
  };

  let explored;
  let moverExplored;
  let authoringTools;
  let authoringToolMetrics;
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
    authoringToolMetrics = assertSmallSafeToolSurface(listed.tools);
    assert.equal(
      listed.tools.some((tool) =>
        Object.hasOwn(tool._meta ?? {}, "synapsor.boundary_digest")
        || Object.hasOwn(tool._meta ?? {}, "synapsor.boundary_set_digest")),
      false,
      "stable authoring tool definitions captured a stale boundary digest",
    );

    const described = resultPayload(await client.callTool({
      name: "app.describe_data",
      arguments: { limit: 10 },
    }));
    assert.deepEqual(
      described.boundaries.map((boundary) => boundary.name).sort(),
      ["account_segments", "product_churn"],
    );
    assert.ok(described.resources.some((resource) =>
      resource.id === "public.accounts" && resource.boundary_name === "account_segments"));
    assert.ok(described.resources.some((resource) =>
      resource.id === "public.accounts" && resource.boundary_name === "product_churn"));

    const ambiguousBoundary = await client.callTool({
      name: "app.explore_data",
      arguments: { plan: accountSegmentsPlan },
    });
    assert.equal(resultPayload(ambiguousBoundary).error_code, "EXPLORE_BOUNDARY_REQUIRED");
    const explicitBoundary = resultPayload(await client.callTool({
      name: "app.explore_data",
      arguments: { boundary: "account_segments", plan: accountSegmentsPlan },
    }));
    assert.equal(explicitBoundary.ok, true, JSON.stringify(explicitBoundary, null, 2));
    assert.equal(explicitBoundary.boundary_name, "account_segments");

    const called = await client.callTool({
      name: "app.explore_data",
      arguments: { boundary: "product_churn", plan: goldenPlan },
    });
    assert.equal(called.isError, undefined, `packed golden aggregate failed: ${JSON.stringify(called)}`);
    explored = resultPayload(called);
    assert.equal(explored.ok, true);
    assert.equal(explored.source_database_changed, false);
    assert.equal(
      explored.privacy.suppressed_groups,
      2,
      `packed aggregate suppression changed: ${JSON.stringify(explored)}`,
    );
    assert.equal(explored.privacy.totals_returned, false);
    assert.equal(explored.data.length, 2);
    assert.equal(explored.outcome.result.suppression.incomplete_comparison_groups, 1);
    assert.equal(explored.data[0].count_distinct_accounts_id_period_1, 5);
    assert.equal(explored.data[0].count_distinct_accounts_id_period_2, 10);
    assert.equal(explored.data[0].count_distinct_accounts_id_absolute_change, 5);
    assert.doesNotMatch(
      JSON.stringify(explored),
      /globex|other-west|@example\.invalid|private kept-out|synthetic kept-out/i,
    );
    const moverCall = await client.callTool({
      name: "app.explore_data",
      arguments: { boundary: "product_churn", plan: moverPlan },
    });
    assert.equal(moverCall.isError, undefined, `packed period mover failed: ${JSON.stringify(moverCall)}`);
    moverExplored = resultPayload(moverCall);
    assert.equal(moverExplored.ok, true);
    assert.equal(moverExplored.source_database_changed, false);
    assert.equal(moverExplored.privacy.suppressed_groups, 2);
    assert.equal(moverExplored.data.length, 2);
    assert.ok(moverExplored.data.every((row) =>
      Object.hasOwn(row, "count_distinct_accounts_id_absolute_change")
      && Object.hasOwn(row, "count_distinct_accounts_id_percentage_change")));
    assert.doesNotMatch(
      JSON.stringify(moverExplored),
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
      [{ ...goldenPlan, max_ranked_groups: 10_000 }, "ranked candidate-limit override"],
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

    for (const reason of ["price", "service"]) {
      const result = await client.callTool({
        name: "app.explore_data",
        arguments: {
          plan: {
            ...goldenPlan,
            where: [{ field: "reason_category", op: "eq", value: reason }],
          },
        },
      });
      assert.notEqual(
        result.isError,
        true,
        `reviewed differencing query ${reason} failed unexpectedly: ${JSON.stringify(resultPayload(result))}`,
      );
    }
    const exhausted = await client.callTool({
      name: "app.explore_data",
      arguments: {
          plan: {
            ...goldenPlan,
            where: [{ field: "reason_category", op: "eq", value: "product" }],
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
    const query = recent.queries.find((item) =>
      item.kind === "aggregate"
      && item.resource === "public.churn_events"
      && item.normalized_plan?.measures?.length === 3
      && item.normalized_plan?.dimensions?.length === 2
      && item.normalized_plan?.order_by?.kind === "comparison_change"
      && (item.normalized_plan?.where?.length ?? 0) === 0);
    assert.ok(query, "Workbench did not surface the packed ranked period mover");
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
    assert.match(created.dsl, /AGGREGATE ORDER BY PERCENTAGE CHANGE count_distinct_churn_events_account_id_fkey_id DESC/);
    assert.match(created.dsl, /RANKED GROUPS 500/);
    assert.match(created.dsl, /PROTECTED RELATIONSHIP churn_events_account_id_fkey/);
    assert.equal(created.draft.state, "disabled");
    assert.ok(created.contract.capabilities.some((capability) =>
      capability.name === "analytics.churn_contributors_by_week"
      && capability.protected_read?.mode === "aggregate"
      && capability.protected_read?.aggregate?.order_by?.kind === "comparison_change"
      && capability.protected_read?.limits?.max_ranked_groups === 500));
    const protectedTestIds = new Set((created.tests.tests ?? []).map((test) => test.id));
    for (const requiredTest of [
      "protected-read-shape-suppression-drift-and-boundaries",
      "trusted-scope-remains-outside-model-arguments",
      "kept-out-fields-remain-unavailable",
      "evidence-and-query-audit-remain-required",
      "operator-controls-remain-outside-mcp",
    ]) {
      assert.ok(protectedTestIds.has(requiredTest), `Protect omitted ${requiredTest}`);
    }
    protectedDraft = created.draft;
    timings.first_data_pr_ms = Date.now() - productStartedAt;

    const activated = await protectUi.json("POST", "/api/protect/activate", {
      capability_name: protectedDraft.capability,
      actor: "packed-golden-reviewer",
      disable_explore: true,
    });
    assert.equal(activated.ok, true);
    assert.equal(activated.active.state, "active");
    assert.equal(activated.active.exploration_disabled, true);
    assert.equal(activated.disabled_boundary, "product_churn");
    assert.deepEqual(activated.remaining_boundaries, ["account_segments"]);
    assert.match(activated.message, /remaining local Explore boundary: account_segments/i);
    await withPackedMcp({
      cli,
      args: ["mcp", "serve", "--authoring", "--project-root", projectRoot],
      cwd: projectRoot,
      env: runtimeEnv,
      name: "packed-remaining-authoring-boundary",
    }, async (client) => {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((tool) => tool.name), ["app.describe_data", "app.explore_data"]);
      const described = resultPayload(await client.callTool({
        name: "app.describe_data",
        arguments: { limit: 10 },
      }));
      assert.deepEqual(described.boundaries.map((boundary) => boundary.name), ["account_segments"]);
      assert.ok(described.resources.every((resource) => resource.boundary_name === "account_segments"));
    });
    const disabledRemaining = await protectUi.json("POST", "/api/explore/disable", {
      boundary_name: "account_segments",
    });
    assert.equal(disabledRemaining.disabled, true);
    assert.deepEqual(disabledRemaining.disabled_boundaries, ["account_segments"]);
    assert.deepEqual(disabledRemaining.remaining_boundaries, []);
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
    assert.equal(protectedResult.ok, true, JSON.stringify(protectedResult, null, 2));
    assert.equal(protectedResult.kind, "aggregate_read", JSON.stringify(protectedResult, null, 2));
    assert.equal(protectedResult.proposal, null, JSON.stringify(protectedResult, null, 2));
    assert.equal(protectedResult.error, null, JSON.stringify(protectedResult, null, 2));
    assert.equal(protectedResult.source_database_changed, false, JSON.stringify(protectedResult, null, 2));
    assert.equal(protectedResult.data.suppression.suppressed_groups, 2);
    assert.ok(protectedResult.data.groups.every((group) =>
      Object.hasOwn(group, "count_distinct_churn_events_account_id_fkey_id_absolute_change")
      && Object.hasOwn(group, "count_distinct_churn_events_account_id_fkey_id_percentage_change")),
    JSON.stringify(protectedResult, null, 2));
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

  process.stdout.write(`${JSON.stringify({
    ok: true,
    artifact: path.basename(tarball),
    stack: ["PostgreSQL", "Next.js", "Prisma", "Cursor-compatible MCP", "local Workbench"],
    boundary_digest: boundaryDigest,
    protected_contract_digest: protectedDraft.contract_digest,
    authoring_tools: authoringTools.map((tool) => tool.name),
    production_tools: productionTools.map((tool) => tool.name),
    tools_list_bytes: authoringToolMetrics.client_discovery_bytes,
    estimated_tools_list_tokens: Math.ceil(authoringToolMetrics.client_discovery_bytes / 4),
    model_facing_tools_bytes: authoringToolMetrics.model_facing_bytes,
    estimated_model_facing_tokens: Math.ceil(authoringToolMetrics.model_facing_bytes / 4),
    multi_boundary_authoring: {
      ask_provider_session_retained: Boolean(retainedAskAuthorityDigest),
      live_mcp_discovery_without_reconnect: true,
      stable_tool_count: authoringTools.length,
      overlapping_resource_requires_boundary: true,
      protect_disables_only_source_boundary: true,
    },
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
      ranked_period_mover: moverExplored?.ok === true,
      ranked_candidate_limit_model_override_rejected: true,
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

function narrowGoldenBoundary(candidate, options = { includeRelationship: true }) {
  candidate.pack.name = "product_churn";
  candidate.budgets.max_rows = 20;
  candidate.budgets.max_groups = 12;
  candidate.budgets.max_top_n = 10;
  candidate.budgets.max_measures = 3;
  candidate.budgets.max_dimensions = 2;
  // The packed journey releases a relationship retry, the golden comparison,
  // a differently ranked mover, and two filtered variants before proving the
  // sixth cross-shape release is refused from the shared resource allowance.
  candidate.budgets.max_differencing_queries = 5;
  candidate.budgets.max_queries_per_session = 20;
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
  events.relationships = options.includeRelationship
    ? events.relationships.filter((relationship) =>
      relationship.id === "churn_events_account_id_fkey")
    : [];
  assert.equal(events.relationships.length, options.includeRelationship ? 1 : 0);
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

async function selectVisibleOption(page, selector, pattern) {
  const options = await evaluate(page, `[...document.querySelector(${JSON.stringify(selector)}).options]
    .map(option=>({value:option.value,text:option.textContent.trim()}))`);
  const option = options.find((candidate) => pattern.test(candidate.text));
  assert.ok(option, `${selector} did not expose a visible option matching ${pattern}`);
  await selectRebuildingOptionByValue(page, selector, option.value);
}

async function selectRebuildingOptionByValue(page, selector, value) {
  const selected = await evaluate(page, `(() => {
    const element=document.querySelector(${JSON.stringify(selector)});
    if(!(element instanceof HTMLSelectElement))throw new Error("Missing select: "+${JSON.stringify(selector)});
    if(![...element.options].some(option=>option.value===${JSON.stringify(value)})){
      throw new Error("Missing option: "+${JSON.stringify(value)});
    }
    element.value=${JSON.stringify(value)};
    element.dispatchEvent(new Event("change",{bubbles:true}));
    return document.querySelector(${JSON.stringify(selector)})?.value;
  })()`);
  assert.equal(selected, value, `${selector} did not retain ${value} after rebuilding dependent controls`);
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
    url,
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
  assert.ok(bytes <= 24_000, `packed authoring client discovery exceeded 24,000 bytes: ${bytes}`);
  const modelFacingTools = tools.map(({ outputSchema: _outputSchema, ...tool }) => tool);
  const modelFacingBytes = Buffer.byteLength(JSON.stringify(modelFacingTools), "utf8");
  assert.ok(
    modelFacingBytes <= 8_000,
    `packed authoring model-facing tool surface exceeded 8,000 bytes: ${modelFacingBytes}`,
  );
  assert.ok(
    Math.ceil(modelFacingBytes / 4) <= 2_000,
    "packed authoring model-facing tool surface exceeded the token estimate",
  );
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
  return {
    client_discovery_bytes: bytes,
    model_facing_bytes: modelFacingBytes,
  };
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
