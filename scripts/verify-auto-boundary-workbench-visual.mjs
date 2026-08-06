import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAutoBoundary,
  writeAutoBoundaryArtifacts,
} from "../apps/runner/dist/auto-boundary.js";
import { initializeGuidedProject } from "../apps/runner/dist/guided-project.js";
import { startLocalUiServer } from "../apps/runner/dist/local-ui.js";
import { ProposalStore } from "../packages/proposal-store/dist/index.js";
import {
  captureScreenshot,
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
const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-workbench-visual-"));
const outputRoot = path.resolve(
  process.env.SYNAPSOR_WORKBENCH_VISUAL_OUTPUT
    ?? path.join(root, "development", "runner-1.6.6-visual"),
);
const chromeProfile = path.join(projectRoot, "chrome-profile");
const screenshots = [];
let localUi;
let chrome;
let visualProviderRequests = 0;
let firstValueHumanSteps = 0;
let firstActionableMs = 0;
let firstVerifiedResultMs = 0;

try {
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const packedRunner = await fs.readFile(
    path.join(root, "apps", "runner", "dist", "runner.mjs"),
    "utf8",
  );
  assert(
    packedRunner.includes("animation:instant-edge-flow 1.9s linear infinite")
      && packedRunner.includes('class="instant-flow-active"')
      && packedRunner.includes("@media(prefers-reduced-motion:reduce)"),
    "packed Runner Workbench is stale or missing the verified overview edge motion",
  );
  const inspection = visualInspection();
  const build = buildAutoBoundary({
    inspection,
    project: {
      root: projectRoot,
      package_manager: "pnpm",
      frameworks: ["nextjs", "prisma"],
      schema_inputs: [],
      database_env_names: ["DATABASE_URL"],
    },
    sourceEnv: "DATABASE_URL",
  });
  const written = await writeAutoBoundaryArtifacts({ projectRoot, build });
  const guided = await initializeGuidedProject({
    projectRoot,
    build,
    runnerVersion: "1.6.6",
    instantOnboarding: true,
  });
  seedVisualAttention(guided.store_path);
  await fs.writeFile(
    path.join(projectRoot, ".synapsor", "explore-audit.key"),
    crypto.randomBytes(32).toString("base64url"),
    { encoding: "utf8", mode: 0o600 },
  );
  process.env.SYNAPSOR_TENANT_ID = "visual-tenant-from-operator-environment";
  delete process.env.SYNAPSOR_PRINCIPAL;
  process.env.OPENAI_API_KEY = "visual-provider-key-never-rendered";

  localUi = await startLocalUiServer({
    projectRoot,
    boundaryRoot: written.root,
    configPath: guided.config_path,
    storePath: guided.store_path,
    token: "visual-bootstrap-token",
    csrfToken: "visual-csrf-token",
    instantOnboarding: true,
    schemaInspector: async () => inspection,
    scopedExploreRuntimeFactory: async () => {
      const boundary = JSON.parse(await fs.readFile(
        path.join(projectRoot, ".synapsor", "exploration-boundary.active.json"),
        "utf8",
      ));
      return {
      boundary,
      session_fingerprint: `sha256:${"c".repeat(64)}`,
      describe: () => ({ resources: boundary.pack.resources }),
      explore: async (plan) => {
        const grouped = plan.dimensions?.[0]?.field;
        return {
          ok: true,
          outcome: {
            type: "success",
            status: "success",
            result: {
              counted_entity: "operational resources",
              result_grain: grouped ? [`reviewed ${grouped}`] : ["reviewed total"],
            },
          },
          data: grouped ? [{ [grouped]: "active", count: 12 }] : [{ count: 12 }],
          privacy: { suppressed_groups: 0 },
          audit: {
            returned_rows_or_groups: 1,
            returned_cells: grouped ? 2 : 1,
          },
          source_database_changed: false,
        };
      },
      close: async () => undefined,
    };
    },
    askGatewayFactory: async () => {
      let subtractionProbeReady = false;
      return {
      mode: "authoring",
      listTools: () => [
        {
          name: "app.describe_data",
          title: "Describe reviewed data",
          description: "Describe only the activated reviewed analytics boundary.",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
        },
        {
          name: "app.explore_data",
          title: "Explore reviewed data",
          description: "Run one typed plan inside the activated reviewed analytics boundary.",
          input_schema: {
            type: "object",
            properties: { plan: { type: "object" } },
            required: ["plan"],
            additionalProperties: false,
          },
        },
      ],
      callTool: async (name, args = {}) => {
        if (name === "app.describe_data") {
          return {
            ok: true,
            value: {
              ok: true,
              resources: [{ id: "public.check_ins", label: "Check ins" }],
              source_database_changed: false,
            },
          };
        }
        const plan = args.plan && typeof args.plan === "object" ? args.plan : {};
        if (Object.hasOwn(args, "sql") || Object.hasOwn(plan, "tenant") || Object.hasOwn(plan, "principal")) {
          return {
            ok: false,
            error_code: "MCP_TOOL_ARGUMENTS_INVALID",
            value: { ok: false, error_code: "MCP_TOOL_ARGUMENTS_INVALID" },
          };
        }
        if (plan.kind === "rows") {
          return {
            ok: false,
            error_code: "EXPLORE_FIELD_FORBIDDEN",
            value: { ok: false, error_code: "EXPLORE_FIELD_FORBIDDEN" },
          };
        }
        if (plan.relationship === "__unreviewed_relationship__") {
          return {
            ok: false,
            error_code: "EXPLORE_RELATIONSHIP_FORBIDDEN",
            value: { ok: false, error_code: "EXPLORE_RELATIONSHIP_FORBIDDEN" },
          };
        }
        if (Number(plan.top_n) > 10) {
          return {
            ok: false,
            error_code: "EXPLORE_PLAN_INVALID",
            value: { ok: false, error_code: "EXPLORE_PLAN_INVALID" },
          };
        }
        if (Object.hasOwn(plan, "minimum_cohort_size") || Object.hasOwn(plan, "include_suppressed")) {
          return {
            ok: false,
            error_code: "MCP_TOOL_ARGUMENTS_INVALID",
            value: { ok: false, error_code: "MCP_TOOL_ARGUMENTS_INVALID" },
          };
        }
        const subtractionProbe = Number(plan.top_n) === 1;
        if (subtractionProbe
          && subtractionProbeReady
          && (!Array.isArray(plan.dimensions) || plan.dimensions.length === 0)) {
          return {
            ok: false,
            error_code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
            value: {
              ok: false,
              error_code: "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
              details: {
                reason: "complementary_aggregate_release",
                source_query_executed: true,
              },
              source_database_changed: false,
            },
          };
        }
        if (subtractionProbe && Array.isArray(plan.dimensions) && plan.dimensions.length > 0) {
          subtractionProbeReady = true;
        }
        const value = {
          ok: true,
          outcome: {
            type: "success",
            status: "success",
            result: {
              counted_entity: "check ins",
              result_grain: ["reviewed outcome"],
            },
          },
          data: [
            { outcome: "attended", count: 15 },
            { outcome: "late_cancel", count: 5 },
          ],
          privacy: { minimum_cohort_size: 5, suppressed_groups: 1 },
          audit: {
            returned_rows_or_groups: 2,
            returned_cells: 4,
            persisted_result_values: false,
          },
          source_database_changed: false,
        };
        return { ok: true, value, provider_value: value };
      },
      close: async () => undefined,
      };
    },
    askProviderDependencies: {
      requestJson: async () => {
        visualProviderRequests += 1;
        if (visualProviderRequests === 1) {
          return {
            status: 200,
            body: {
              choices: [{
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                    id: "call_visual_two_step",
                    type: "function",
                    function: {
                      name: "app__explore_data",
                      arguments: JSON.stringify({
                        plan: {
                          operation: "aggregate",
                          resource: "public.check_ins",
                          measures: [{ op: "count", alias: "count" }],
                          dimensions: [{ field: "outcome" }],
                          top_n: 10,
                        },
                      }),
                    },
                  }],
                },
              }],
            },
          };
        }
        return {
          status: 200,
          body: {
            choices: [{
              message: {
                role: "assistant",
                content: "Attended had 15 reviewed check-ins; late cancellations had 5.",
              },
            }],
          },
        };
      },
    },
  });
  chrome = await launchChrome({ userDataDir: chromeProfile, width: 1440, height: 1100 });
  const page = await createPage(chrome.port);
  try {
    const firstValueStartedAt = Date.now();
    await configurePage(page, 1440, 1100);
    await navigateAndWait(page, localUi.url);
    await waitForExpression(page, "document.querySelector('#header-state')?.textContent !== 'Loading'");
    await waitForExpression(page, "document.querySelector('#instant-path')?.offsetParent !== null");
    await waitForExpression(page, "document.querySelector('#instant-authority')?.textContent.includes('Reviewed access')");
    firstActionableMs = Date.now() - firstValueStartedAt;
    assert(
      firstActionableMs <= 60_000,
      "Workbench did not reach its first actionable boundary screen within 60 seconds",
      { firstActionableMs },
    );
    assert(
      await evaluate(page, "!/data[- ]areas?/i.test(document.body.textContent||'')"),
      "Workbench still exposed the retired generic resource terminology",
    );
    assert(
      await evaluate(page, "document.querySelector('#instant-path')?.textContent.includes('Review once.') && document.querySelector('#instant-path')?.textContent.includes('Then ask your database.')"),
      "instant onboarding did not explain the reviewed boundary",
    );
    assert(
      await evaluate(page, "document.querySelector('#instant-path')?.textContent.includes('model-visible') && document.querySelector('#instant-path')?.textContent.includes('relationship')"),
      "instant onboarding did not summarize the exact reviewed access",
    );
    assert(
      await evaluate(page, "document.querySelector('#instant-path')?.textContent.includes('Runner validated this question against the proposed boundary')"),
      "instant onboarding did not prove its starter question against the proposed authority",
    );
    assert(
      await evaluate(page, "!/\\bamount\\s+amount\\b/i.test(document.querySelector('#instant-path')?.textContent||'')"),
      "instant onboarding generated a duplicated monetary label",
    );
    assert(
      await evaluate(page, "document.querySelector('#instant-path select') === null && document.querySelector('#instant-path input[type=radio]') === null"),
      "instant onboarding still asked for redundant profile or surface choices",
    );
    const edgeMotionStart = await evaluate(page, `(() => {
      const edge = document.querySelector(".instant-flow-active");
      const style = getComputedStyle(edge);
      return {
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        strokeDashoffset: style.strokeDashoffset,
      };
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 240));
    const edgeMotionEnd = await evaluate(
      page,
      `getComputedStyle(document.querySelector(".instant-flow-active")).strokeDashoffset`,
    );
    assert(
      edgeMotionStart.animationName === "instant-edge-flow"
        && edgeMotionStart.animationDuration === "1.9s"
        && edgeMotionStart.strokeDashoffset !== edgeMotionEnd,
      "overview boundary edges are not visibly animated",
      { edgeMotionStart, edgeMotionEnd },
    );
    await page.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    assert(
      await evaluate(
        page,
        `getComputedStyle(document.querySelector(".instant-flow-active")).animationName === "none"`,
      ),
      "overview boundary edge animation ignored reduced-motion preference",
    );
    await page.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 260));
    await screenshot(page, "workbench-instant-ready-desktop.png");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await evaluate(page, "window.scrollTo(0,0)");
    assert(
      await evaluate(page, `(() => {
        const rect=document.querySelector("#run-instant")?.getBoundingClientRect();
        return Boolean(rect)&&rect.top>=0&&rect.bottom<=innerHeight;
      })()`),
      "mobile Quick Start hid its primary action below the initial viewport",
    );
    await screenshot(page, "workbench-instant-ready-mobile.png");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1440,
      screenHeight: 1100,
    });
    await waitForExpression(page, "document.querySelector('#run-instant')?.disabled === false");
    firstValueHumanSteps += 1;
    await clickSelector(page, "#run-instant");
    await waitForExpression(page, "document.body.classList.contains('quick-start-mode') === false");
    await waitForExpression(page, "document.body.classList.contains('ask-focus-mode') === true");
    await waitForExpression(page, "document.querySelector('#view-explore')?.classList.contains('active') === true");
    await waitForExpression(page, "document.querySelector('#ask-shell')?.classList.contains('hidden') === false");
    await waitForExpression(page, "document.querySelector('#explorer')?.classList.contains('hidden') === false");
    await waitForExpression(page, "document.querySelector('#ask-key-source')?.value === 'environment'");
    let activeArtifact = await fs.readFile(
      path.join(projectRoot, ".synapsor", "exploration-boundary.active.json"),
      "utf8",
    );
    assert(!activeArtifact.includes("visual-tenant-from-operator-environment"), "trusted tenant leaked into the activated artifact");
    assert(
      await evaluate(page, "document.querySelector('#ask-title')?.textContent.includes('Ask naturally')"),
      "Quick Start did not route to model-first Ask",
    );
    assert(
      await evaluate(page, "document.querySelector('#no-model-content')?.classList.contains('hidden') === true"),
      "no-model composer displaced the model-first surface",
    );
    assert(
      await evaluate(page, "document.querySelector('#external-client-setup')?.offsetParent === null && document.querySelector('.no-model-surface')?.offsetParent === null"),
      "secondary analytics paths displaced the model-first composer",
    );
    assert(
      await evaluate(page, "document.querySelector('#ask-key')?.value === '' && !document.body.textContent.includes('visual-provider-key-never-rendered')"),
      "provider credential leaked into the rendered Workbench",
    );
    assert(
      await evaluate(page, "document.querySelector('#ask-chat')?.classList.contains('hidden') === false && document.querySelector('#ask-configuration-form')?.classList.contains('hidden') === true"),
      "configured-model Quick Start still required a separate provider configuration step",
    );
    assert(
      await evaluate(page, `(() => {
        const prompts=[...document.querySelectorAll("[data-ask-starter]")].map(button=>(button.textContent||"").trim().toLowerCase());
        return prompts.length===new Set(prompts).size;
      })()`),
      "model-first Ask rendered duplicate starter questions",
    );
    assert(
      await evaluate(page, "document.querySelector('#ask-submit-consent')?.textContent.includes('Submitting your first question confirms')"),
      "configured-model Quick Start did not bind egress disclosure to first-question submission",
    );
    assert(visualProviderRequests === 0, "Workbench contacted the provider before the first question");
    firstValueHumanSteps += 1;
    await typeIntoSelector(page, "#ask-question", "Which outcomes have the most check ins?");
    await evaluate(page, `document.querySelector("#ask-question").dispatchEvent(
      new KeyboardEvent("keydown",{key:"Enter",bubbles:true})
    )`);
    await waitForExpression(page, "document.querySelectorAll('#ask-transcript .ask-turn.answer').length === 1");
    assert(
      visualProviderRequests === 2,
      "the first submitted question did not complete the configured provider/tool loop",
      { visualProviderRequests },
    );
    assert(
      await evaluate(page, "document.querySelector('#ask-transcript')?.textContent.includes('attended') && document.querySelector('#ask-transcript')?.textContent.includes('15')"),
      "the two-interaction Workbench path did not render a verified result",
    );
    assert(
      firstValueHumanSteps === 2,
      "Workbench exceeded the two-step first-value budget",
      { firstValueHumanSteps },
    );
    firstVerifiedResultMs = Date.now() - firstValueStartedAt;
    assert(
      firstVerifiedResultMs <= 120_000,
      "Workbench did not reach its first verified result within two minutes",
      { firstVerifiedResultMs },
    );
    await screenshot(page, "workbench-model-first-analyze-desktop.png");
    await clickSelector(page, "#prove-boundary-chat");
    await waitForExpression(page, "document.querySelector('#boundary-proof-result')?.textContent.includes('Boundary held')");
    assert(
      await evaluate(page, "document.querySelector('#boundary-proof-result')?.textContent.includes('8 / 8 held')"),
      "visible boundary proof did not run every deterministic escape attempt",
    );
    await screenshot(page, "workbench-boundary-proof-desktop.png");
    await evaluate(page, `(() => {
      document.body.classList.remove("ask-result-mode");
      showAskConfiguration();
    })()`);
    await waitForExpression(page, "document.querySelector('#open-client-setup')?.offsetParent !== null");
    await clickSelector(page, "#open-client-setup");
    await waitForExpression(page, "document.querySelector('#external-client-setup')?.open === true");
    await clickSelector(page, '[data-install-mcp="cursor"]');
    await waitForExpression(page, "document.querySelector('#mcp-install-status')?.textContent.includes('No live client session is connected yet')");
    const cursorConfig = await fs.readFile(path.join(projectRoot, ".cursor", "mcp.json"), "utf8");
    assert(cursorConfig.includes("--authoring"), "Workbench MCP continuation did not install authoring mode");
    assert(!cursorConfig.includes("DATABASE_URL") && !cursorConfig.includes("visual-tenant"), "Workbench MCP continuation wrote trusted credentials into the client config");
    await screenshot(page, "workbench-existing-client-path-desktop.png");
    await evaluate(page, "document.querySelector('#ask-tune-access')?.click()");
    await waitForExpression(page, "document.querySelector('#view-exceptions')?.classList.contains('active') === true");
    assert(
      await evaluate(page, "document.querySelector('#instant-path')?.offsetParent === null"),
      "activated Quick Start canvas returned above the access editor",
    );
    const relatedNavigation = await evaluate(
      page,
      `[...document.querySelectorAll("[data-access-resource]")].map(button=>button.dataset.accessResource)`,
    );
    assert(
      Array.isArray(relatedNavigation) && relatedNavigation.length >= 2 && relatedNavigation.length < 40,
      "access editor did not start with a bounded boundary-plus-related table list",
      relatedNavigation,
    );
    assert(
      await evaluate(page, `(() => {
        const rows=[...document.querySelectorAll("[data-access-resource]")];
        return rows.every(row=>row.dataset.accessIncluded==="true"||/Related to/.test(row.textContent||""))
          && !rows.some(row=>/Available · unrelated/.test(row.textContent||""));
      })()`),
      "default access editor exposed an unrelated table without explicit expansion",
      relatedNavigation,
    );
    await clickSelector(page, "#show-all-access");
    await waitForExpression(page, "document.querySelectorAll('[data-access-resource]').length === 40");
    const navigationOrderBefore = await evaluate(
      page,
      `[...document.querySelectorAll("[data-access-resource]")].map(button=>button.dataset.accessResource)`,
    );
    const thirdResource = navigationOrderBefore[2];
    await clickSelector(page, `[data-access-resource="${thirdResource}"]`);
    await waitForExpression(
      page,
      `document.querySelector(".access-resource.selected")?.dataset.accessResource === ${JSON.stringify(thirdResource)}`,
    );
    const navigationOrderAfter = await evaluate(
      page,
      `[...document.querySelectorAll("[data-access-resource]")].map(button=>button.dataset.accessResource)`,
    );
    assert(
      JSON.stringify(navigationOrderAfter) === JSON.stringify(navigationOrderBefore),
      "selecting the third table changed the left navigation order",
      { navigationOrderBefore, navigationOrderAfter, thirdResource },
    );
    assert(
      await evaluate(page, `[...document.querySelectorAll("[data-access-resource]")]
        .some(row=>/Available · unrelated/.test(row.textContent||""))`),
      "All inspected did not expose explicitly labeled unrelated tables",
    );
    await clickSelector(page, "#show-related-access");
    await waitForExpression(page, "document.querySelectorAll('[data-access-resource]').length >= 2 && document.querySelectorAll('[data-access-resource]').length < 40");
    const twoClickResource = await evaluate(page, `([...document.querySelectorAll("[data-access-resource]")]
      .find(button=>button.dataset.accessIncluded==="true"&&!button.querySelector(".access-resource-state.blocked")))
      ?.getAttribute("data-access-resource")`);
    assert(twoClickResource, "access editor fixture did not expose a ready table for the two-click path");
    await clickSelector(page, `[data-access-resource="${twoClickResource}"]`);
    await waitForExpression(page, "document.querySelector('[data-access-column-list]')?.offsetParent !== null");
    const immediateColumns = await evaluate(page, `(() => {
      const list=document.querySelector("[data-access-column-list]");
      const tier=[...list.querySelectorAll("[data-field-tier]")]
        .find(input=>input.dataset.currentTier==="visible"&&!input.disabled);
      const secondary=[...document.querySelectorAll("#resource-detail details[data-access-secondary]")];
      const rect=tier?.getBoundingClientRect();
      return {
        table:document.querySelector(".access-resource.selected")?.dataset.accessResource,
        tierField:tier?.dataset.fieldName||null,
        tierValue:tier?.value||null,
        tierVisible:Boolean(rect&&rect.top>=0&&rect.bottom<=innerHeight),
        tierOptions:tier?[...tier.options].map(option=>option.value):[],
        secondaryCount:secondary.length,
        secondaryClosed:secondary.every(details=>!details.open),
        separateRiskSections:/Sensitive fields kept out|Items needing attention/.test(
          document.querySelector("#resource-detail")?.textContent||"",
        ),
      };
    })()`);
    assert(
      immediateColumns.table === twoClickResource
        && immediateColumns.tierField
        && immediateColumns.tierValue === "visible"
        && immediateColumns.tierVisible
        && JSON.stringify(immediateColumns.tierOptions) === JSON.stringify(["visible", "withheld", "kept_out"])
        && immediateColumns.secondaryCount >= 3
        && immediateColumns.secondaryClosed
        && !immediateColumns.separateRiskSections,
      "one table click did not reveal the flat three-tier column list with closed secondary sections",
      immediateColumns,
    );
    const tierSelector = `[data-field-tier][data-field-name="${immediateColumns.tierField}"]`;
    await evaluate(page, `(() => {
      const input=document.querySelector(${JSON.stringify(tierSelector)});
      input.value="withheld";
      input.dispatchEvent(new Event("change",{bubbles:true}));
    })()`);
    await waitForExpression(
      page,
      `document.querySelector(${JSON.stringify(tierSelector)})?.dataset.currentTier === "withheld"`,
    );
    const withheldReview = await evaluate(page, `({
      tier:document.querySelector(${JSON.stringify(tierSelector)})?.value,
      editorCopy:document.querySelector("#resource-detail")?.textContent,
      stagedHidden:document.querySelector("#access-staged")?.classList.contains("hidden")
    })`);
    assert(
      withheldReview.tier === "withheld"
        && /raw values stay local or become response-only tokens/i.test(String(withheldReview.editorCopy))
        && /reviewed derived results remain available/i.test(String(withheldReview.editorCopy))
        && !withheldReview.stagedHidden,
      "an ordinary low-risk tier change did not stage directly in the focused editor",
      withheldReview,
    );
    assert(
      await fs.readFile(
        path.join(projectRoot, ".synapsor", "exploration-boundary.active.json"),
        "utf8",
      ) === activeArtifact,
      "staging a disabled Workbench replacement changed the active boundary before confirmation",
    );
    assert(
      await evaluate(page, `/active reviewed boundar/i.test(document.querySelector("#header-state")?.textContent||"")`),
      "Workbench reported that active authority disappeared while only the disabled replacement changed",
    );
    const stagedReplacementPreflight = await evaluate(page, `fetch("/api/explore/preflight")
      .then(async response=>({status:response.status,body:await response.json()}))`);
    assert(
      stagedReplacementPreflight.status === 200
        && stagedReplacementPreflight.body?.ok === true,
      "the current active boundary stopped passing runtime preflight while its replacement was only staged",
      stagedReplacementPreflight,
    );
    const enumReview = await evaluate(page, `(() => {
      const form=document.querySelector('[data-enum-review-form][data-enum-field="status"]');
      if(!form)return null;
      form.open=true;
      const values=[...form.querySelectorAll('[data-enum-review-value]')];
      const removed=values.at(-1);
      removed.checked=false;
      form.querySelector('[data-enum-review-actor]').value='visual-reviewer@example.test';
      form.querySelector('[data-enum-review-reason]').value='Keep the internal archived lifecycle state outside this reviewed agent boundary.';
      return {before:values.map(input=>input.value),removed:removed.value,copy:form.textContent};
    })()`);
    assert(
      enumReview
        && JSON.stringify(enumReview.before) === JSON.stringify(["open", "closed", "archived"])
        && /database schema metadata/i.test(String(enumReview.copy))
        && /only by checked values/i.test(String(enumReview.copy)),
      "Workbench did not expose the complete schema-declared categorical review control",
      enumReview,
    );
    await clickSelector(page, '[data-submit-enum-review="status"]');
    await waitForExpression(page, `/Recorded: .*\.status keeps 2 reviewed values/.test(document.querySelector('#access-staged-summary')?.textContent||'')`);
    const enumRecorded = await evaluate(page, `(() => {
      const form=document.querySelector('[data-enum-review-form][data-enum-field="status"]');
      form.open=true;
      const selected=[...form.querySelectorAll('[data-enum-review-value]:checked')].map(input=>input.value);
      form.querySelector('[data-enum-review-actor]').value='visual-reviewer@example.test';
      form.querySelector('[data-enum-review-reason]').value='Keep the internal archived lifecycle state outside this reviewed agent boundary.';
      return {selected,summary:document.querySelector('#access-staged-summary')?.textContent||''};
    })()`);
    assert(
      JSON.stringify(enumRecorded.selected) === JSON.stringify(["open", "closed"])
        && /Actor: visual-reviewer@example\.test/.test(enumRecorded.summary),
      "Workbench did not confirm the exact categorical narrowing and reviewer",
      enumRecorded,
    );
    await clickSelector(page, '[data-submit-enum-review="status"]');
    await waitForExpression(page, "/Unchanged: this column already uses exactly these allowed values/.test(document.querySelector('[data-enum-review-form][data-enum-field=\"status\"] [data-enum-review-status]')?.textContent||'')");
    assert(
      await fs.readFile(
        path.join(projectRoot, ".synapsor", "exploration-boundary.active.json"),
        "utf8",
      ) === activeArtifact,
      "reviewing categorical values changed active authority before confirmation",
    );
    await screenshot(page, "workbench-access-editor-columns-desktop.png");
    await clickSelector(page, "#show-all-access");
    await waitForExpression(page, "document.querySelectorAll('[data-access-resource]').length === 40");
    const keptOutResource = await evaluate(page, `([...document.querySelectorAll("[data-access-resource]")]
      .find(button=>button.getAttribute("data-access-resource")?.includes("members_with_an_intentionally_long"))
      ?.getAttribute("data-access-resource"))`);
    assert(keptOutResource, "visual fixture did not expose its sensitive-field table");
    await clickSelector(page, `[data-access-resource="${keptOutResource}"]`);
    await waitForExpression(page, "document.querySelector('[data-access-column-list]')?.offsetParent !== null");
    const keptOutInline = await evaluate(page, `(() => {
      const row=[...document.querySelectorAll("[data-access-column]")]
        .find(item=>item.dataset.columnKeptOut==="true");
      return {
        present:Boolean(row),
        tier:row?.querySelector("[data-field-tier]")?.value,
        badge:row?.querySelector(".access-column-risk")?.textContent||"",
        inFlatList:Boolean(row?.closest("[data-access-column-list]")),
      };
    })()`);
    assert(
      keptOutInline.present
        && keptOutInline.tier === "kept_out"
        && keptOutInline.inFlatList
        && /Kept out/.test(String(keptOutInline.badge)),
      "kept-out columns were not shown off with their reason in the same flat list",
      keptOutInline,
    );
    const sensitiveTierSelector = await evaluate(page, `(() => {
      const row=[...document.querySelectorAll("[data-access-column]")]
        .find(item=>item.dataset.columnKeptOut==="true"&&!item.querySelector("[data-field-tier]")?.disabled);
      return row?.querySelector("[data-field-tier]")?.dataset.fieldName||null;
    })()`);
    if(sensitiveTierSelector){
      await evaluate(page, `(() => {
        const input=document.querySelector('[data-field-tier][data-field-name="'+${JSON.stringify(sensitiveTierSelector)}+'"]');
        input.value="visible";
        input.dispatchEvent(new Event("change",{bubbles:true}));
      })()`);
      const sensitiveForm = `[data-managed-review-form][data-field="${sensitiveTierSelector}"][data-exposure="allow_reviewed_use"]`;
      await waitForExpression(
        page,
        `document.querySelector(${JSON.stringify(sensitiveForm)})?.classList.contains("hidden") === false`,
      );
      assert(
        await evaluate(page, `Boolean(document.querySelector(${JSON.stringify(`${sensitiveForm} [data-review-actor]`)})
          &&document.querySelector(${JSON.stringify(`${sensitiveForm} [data-review-reason]`)}))`),
        "sensitive widening skipped the explicit reviewer-and-reason exception",
      );
    }
    await clickSelector(page, "#review-staged-access");
    await waitForExpression(page, "document.querySelector('#view-activate')?.classList.contains('active') === true");
    assert(
      await evaluate(page, `document.querySelector("#signoff-summary")?.textContent.includes("One boundary, one exact confirmation")
        &&document.querySelectorAll("#signoff-summary input[type=checkbox]").length===0`),
      "focused Workbench editing fell back to the per-table checkbox wall",
    );
    const finalReviewLayout = await evaluate(page, `(() => {
      const table=document.querySelector("#signoff-summary .focused-boundary-table");
      const wrapper=table?.closest(".focused-boundary-table-wrap");
      const cells=[...document.querySelectorAll("#signoff-summary .focused-boundary-table tbody tr")]
        .flatMap(row=>[...row.cells].map((cell,index,cells)=>({
          contentFits:cell.scrollWidth<=cell.clientWidth+1,
          separated:index===cells.length-1
            || cell.getBoundingClientRect().right<=cells[index+1].getBoundingClientRect().left+1
        })));
      const profile=document.querySelector("#deployment-profile-label")?.closest(".field");
      return {
        present:Boolean(table&&wrapper),
        tableFits:Boolean(table&&wrapper&&table.scrollWidth<=wrapper.clientWidth+1),
        cellsFit:cells.every(cell=>cell.contentFits&&cell.separated),
        profileStacks:Boolean(profile&&getComputedStyle(profile).flexDirection==="column"),
      };
    })()`);
    assert(
      finalReviewLayout.present
        && finalReviewLayout.tableFits
        && finalReviewLayout.cellsFit
        && finalReviewLayout.profileStacks,
      "focused final review compressed or overlapped its boundary summary",
      finalReviewLayout,
    );
    await screenshot(page, "workbench-final-review-desktop.png");
    await clickSelector(page, "#preview");
    await waitForExpression(page, "document.querySelector('#view-explore')?.classList.contains('active') === true");
    activeArtifact = await fs.readFile(
      path.join(projectRoot, ".synapsor", "exploration-boundary.active.json"),
      "utf8",
    );
    await evaluate(page, "document.querySelector('#access-back')?.click()");
    await evaluate(page, "document.querySelector('[data-view=\"overview\"]')?.click()");
    await waitForExpression(page, "document.querySelector('#view-overview')?.classList.contains('active') === true");
    const wholeBoundary = await evaluate(page, `(() => {
      const panel=document.querySelector("#boundary-overview");
      return {
        visible:Boolean(panel?.offsetParent),
        title:panel?.querySelector("h2")?.textContent||"",
        headers:[...panel.querySelectorAll(".boundary-version-table thead th")]
          .map(item=>(item.textContent||"").trim()),
        boundaries:[...panel.querySelectorAll(".boundary-version-table tbody tr")].map(row=>({
          cells:[...row.querySelectorAll("td")].map(item=>(item.textContent||"").trim()),
          selected:row.classList.contains("selected-boundary"),
        })),
        reviewVisible:Boolean(panel.querySelector("#edit-boundary-tables")?.offsetParent),
        newBoundaryVisible:Boolean(panel.querySelector("#new-boundary")?.offsetParent),
        renderedTables:panel.querySelectorAll(".boundary-table-row,[data-boundary-add],[data-boundary-remove]").length,
        optionsOpen:Boolean(panel.querySelector(".boundary-options")?.open),
        generatedDetailsOpen:Boolean(document.querySelector("#overview-table-details")?.open),
        candidateIds:(candidate?.pack?.resources||[]).map(item=>item.id).sort(),
        activeIds:(activeBoundary?.pack?.resources||[]).map(item=>item.id).sort(),
        text:panel?.textContent||"",
      };
    })()`);
    assert(
      wholeBoundary.visible
        && wholeBoundary.title.trim() === "Your boundaries"
        && JSON.stringify(wholeBoundary.headers) === JSON.stringify(["Name","Status","Tables","Authority","Actions"])
        && wholeBoundary.boundaries.length === 1
        && wholeBoundary.boundaries[0].selected
        && wholeBoundary.boundaries[0].cells[0].includes("reviewed_staging")
        && wholeBoundary.boundaries[0].cells[1] === "Active"
        && Number(wholeBoundary.boundaries[0].cells[2]) === wholeBoundary.activeIds.length
        && wholeBoundary.boundaries[0].cells[3] === "Active Explore"
        && JSON.stringify(wholeBoundary.candidateIds) === JSON.stringify(wholeBoundary.activeIds)
        && wholeBoundary.reviewVisible
        && wholeBoundary.newBoundaryVisible
        && wholeBoundary.renderedTables === 0
        && !wholeBoundary.optionsOpen
        && !wholeBoundary.generatedDetailsOpen
        && /independently reviewed set of tables, columns, relationships, and limits/i.test(wholeBoundary.text)
        && /active boundary adds choices to the same two Explore tools/i.test(wholeBoundary.text)
        && /active boundaries never merge relationship graphs/i.test(wholeBoundary.text),
      "post-Quick Start Workbench did not preserve the active boundary as the editable reviewed baseline",
      wholeBoundary,
    );
    await clickSelector(page, "#new-boundary");
    await waitForExpression(page, "document.querySelector('#new-boundary-form')?.hidden === false");
    const newBoundaryForm = await evaluate(page, `(() => {
      const form=document.querySelector("#new-boundary-form");
      const table=document.querySelector("#new-boundary-table");
      return {
        visible:Boolean(form?.offsetParent),
        text:form?.textContent||"",
        startingTableOptions:[...table.options].map(option=>option.value).filter(Boolean),
        inspectedTableCount:(original?.pack?.resources||[]).length,
        selected:table?.value||"",
        createLabel:document.querySelector("#create-boundary")?.textContent||"",
      };
    })()`);
    assert(
      newBoundaryForm.visible
        && newBoundaryForm.startingTableOptions.length === newBoundaryForm.inspectedTableCount
        && newBoundaryForm.inspectedTableCount > 0
        && newBoundaryForm.selected === ""
        && /choose its first table/i.test(newBoundaryForm.text)
        && /nothing is copied from another boundary/i.test(newBoundaryForm.text)
        && /choose table and edit/i.test(newBoundaryForm.createLabel)
        && !/copies the selected disabled structure/i.test(newBoundaryForm.text),
      "new boundary creation did not require an explicit starting table",
      newBoundaryForm,
    );
    await screenshot(page, "workbench-new-boundary-desktop.png");
    await clickSelector(page, "#cancel-new-boundary");
    await waitForExpression(page, "document.querySelector('#new-boundary-form')?.hidden === true");
    const disableControl = await evaluate(page, `(() => {
      const button=document.querySelector("#disable-active-boundary");
      return {
        visible:Boolean(button?.offsetParent),
        disabled:Boolean(button?.disabled),
        text:button?.textContent||"",
      };
    })()`);
    assert(
      disableControl.visible
        && (disableControl.disabled
          ? /already disabled/i.test(disableControl.text)
          : /deactivate selected boundary/i.test(disableControl.text)),
      "boundary lifecycle did not expose its current Explore disable state",
      disableControl,
    );
    if (!disableControl.disabled) {
      await clickSelector(page, "#disable-active-boundary");
      await waitForExpression(page, "document.querySelector('#boundary-disable-confirmation')?.hidden === false");
      await clickSelector(page, "#cancel-disable-boundary");
      await waitForExpression(page, "document.querySelector('#boundary-disable-confirmation')?.hidden === true");
    }
    await evaluate(page, `(() => {
      const details=[...document.querySelectorAll(".boundary-options")]
        .find(item=>/Ranked result settings/i.test(item.querySelector("summary")?.textContent||""));
      if(details)details.open=true;
    })()`);
    const rankedSettings = await evaluate(page, `(() => {
      const input=document.querySelector("#boundary-ranked-groups");
      const help=document.querySelector("#boundary-ranked-help")?.textContent||"";
      return {
        visible:Boolean(input?.offsetParent),
        value:Number(input?.value),
        minimum:Number(input?.min),
        maximum:Number(input?.max),
        help,
        saveLabel:document.querySelector("#save-ranked-groups")?.textContent||"",
      };
    })()`);
    assert(
      rankedSettings.visible
        && rankedSettings.value === 500
        && rankedSettings.minimum === 50
        && rankedSettings.maximum === 500
        && /Small-group suppression runs before ranking/i.test(rankedSettings.help)
        && /only the reviewed top 25 may be returned/i.test(rankedSettings.help)
        && /AI cannot change this setting/i.test(rankedSettings.help)
        && /Save reviewed limit/i.test(rankedSettings.saveLabel),
      "Workbench did not expose the operator-owned ranked candidate limit clearly",
      rankedSettings,
    );
    await screenshot(page, "workbench-ranked-result-settings-desktop.png");
    await evaluate(page, `(() => {
      const details=document.querySelector("#boundary-ranked-groups")?.closest("details");
      if(details)details.open=false;
    })()`);
    await clickSelector(page, ".boundary-options > summary");
    await evaluate(page, `(() => {
      const input=document.querySelector("#boundary-pack-name");
      input.value="fitflow_reviewed";
      document.querySelector("#save-boundary-name")?.click();
    })()`);
    await waitForExpression(
      page,
      "/Saved on the selected disabled boundary/.test(document.querySelector('#boundary-name-status')?.textContent||'')",
    );
    const renamedBoundary = await evaluate(page, `(() => ({
      title:document.querySelector("#boundary-overview-title")?.textContent||"",
      selected:document.querySelector(".boundary-version-table tbody tr.selected-boundary")?.textContent||"",
      active:[...document.querySelectorAll(".boundary-version-table tbody tr")]
        .find(row=>/Active Explore/.test(row.textContent||""))?.textContent||"",
      count:document.querySelectorAll(".boundary-version-table tbody tr").length,
      status:document.querySelector("#boundary-name-status")?.textContent||""
    }))()`);
    assert(
      renamedBoundary.title.trim() === "Your boundaries"
        && /fitflow_reviewed/.test(renamedBoundary.selected)
        && /reviewed_staging/.test(renamedBoundary.active)
        && renamedBoundary.count >= 2
        && /Active authority did not change/.test(renamedBoundary.status),
      "Workbench did not persist the digest-bound boundary name without activation",
      renamedBoundary,
    );
    await clickSelector(page, "#edit-boundary-tables");
    await waitForExpression(page, "document.querySelector('#view-exceptions')?.classList.contains('active') === true");
    const stagedTable = await evaluate(
      page,
      `[...document.querySelectorAll("[data-access-resource]")].find(item=>
        item.dataset.accessIncluded==="false"&&!item.querySelector(".access-resource-state.blocked"))?.dataset.accessResource`,
    );
    assert(stagedTable, "boundary editor did not expose a reviewable table to add");
    await clickSelector(page, `[data-access-resource="${stagedTable}"]`);
    await waitForExpression(
      page,
      `document.querySelector(".access-resource.selected")?.dataset.accessResource === ${JSON.stringify(stagedTable)}`,
    );
    await waitForExpression(
      page,
      `document.querySelector(${JSON.stringify(`[data-access-resource="${stagedTable}"]`)})?.dataset.accessIncluded === "true"`,
    );
    assert(
      await evaluate(
        page,
        `Boolean(document.querySelector("#remove-selected-resource"))
          && !document.querySelector("#include-selected-resource")`,
      ),
      "selecting an addable table did not add it before opening its column review",
    );
    await clickSelector(page, "#remove-selected-resource");
    await waitForExpression(
      page,
      `document.querySelector(${JSON.stringify(`[data-access-resource="${stagedTable}"]`)})?.dataset.accessIncluded === "false"`,
    );
    assert(
      await fs.readFile(
        path.join(projectRoot, ".synapsor", "exploration-boundary.active.json"),
        "utf8",
      ) === activeArtifact,
      "adding and removing a table from the candidate changed active authority",
    );
    await evaluate(page, "document.querySelector('[data-view=\"overview\"]')?.click()");
    await waitForExpression(page, "document.querySelector('#view-overview')?.classList.contains('active') === true");
    await evaluate(page, "document.querySelector('#boundary-overview')?.scrollIntoView({block:'start'})");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await screenshot(page, "workbench-whole-boundary-desktop.png");
    const starterResourceCount = await evaluate(page, "document.querySelectorAll('.resource').length");
    assert(
      starterResourceCount < 40,
      "desktop overview: fresh Workbench did not present a bounded starter pack",
      { starterResourceCount },
    );
    await assertWorkbenchDom(page, "desktop overview", {
      expectedView: "overview",
      maximumResources: 8,
      requireCatalogFixtures: false,
    });
    await screenshot(page, "workbench-overview-desktop-light.png");
    await clickSelector(page, "#overview-table-details > summary");
    await evaluate(page, "document.querySelector('#show-all')?.click()");
    await waitForExpression(
      page,
      `document.querySelectorAll('.resource').length === ${inspection.tables.length}`,
    );
    await assertWorkbenchDom(page, "desktop full catalog", {
      expectedView: "overview",
      expectedResources: inspection.tables.length,
      requireCatalogFixtures: true,
    });

    await evaluate(page, `(() => {
      document.querySelector("#header-state").textContent="Loading deterministic schema evidence";
      document.querySelector("#journey-state").innerHTML="<div><strong>Database connected.</strong><p>Agent data access: none. Source database changed: no.</p></div><span>Next: Review what the agent can see.</span>";
      document.querySelector("#resources").setAttribute("aria-busy","true");
    })()`);
    await screenshot(page, "workbench-loading-partial.png");
    await evaluate(page, `(() => {
      document.querySelector("#resources").removeAttribute("aria-busy");
      document.querySelector("#header-state").textContent="No data access active";
    })()`);

    await page.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await screenshot(page, "workbench-overview-desktop-dark.png");
    await page.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });

    const blockedResource = "public.ambiguous_customer_identity_records";
    assert(
      await evaluate(page, `(() => {
        const button=document.querySelector(${JSON.stringify(`[data-open-resource="${blockedResource}"]`)});
        return Boolean(button?.closest(".resource")?.textContent.includes("Blocked"));
      })()`),
      "visual fixture did not expose its permanently blocked resource",
    );
    await clickSelector(page, `[data-open-resource="${blockedResource}"]`);
    await waitForExpression(page, "document.querySelector('#view-exceptions')?.classList.contains('active') === true");
    await waitForExpression(page, "document.querySelector('#resource-detail')?.textContent.includes('Blocked') === true");
    await assertWorkbenchDom(page, "blocked exception", { expectedView: "exceptions" });
    await screenshot(page, "workbench-blocked-identity.png");

    const resolvableResource = "public.manual_scope_orders";
    await clickSelector(page, "#show-all-access");
    await waitForExpression(page, "document.querySelectorAll('[data-access-resource]').length === 40");
    await clickSelector(page, `[data-access-resource="${resolvableResource}"]`);
    await waitForExpression(
      page,
      `document.querySelector(".access-resource.selected")?.dataset.accessResource === ${JSON.stringify(resolvableResource)}`,
    );
    await evaluate(page, `(() => {
      const details=[...document.querySelectorAll("#resource-detail details")]
        .find(item=>/Resolve blocked access/i.test(item.querySelector("summary")?.textContent||""));
      if(!details)throw new Error("Resolvable blocked table omitted its review controls");
      details.open=true;
    })()`);
    await waitForExpression(page, "document.querySelector('[data-submit-scope-review=\"row_identity\"]')?.offsetParent !== null");
    const identityForm = '[data-scope-review-form]:has([data-submit-scope-review="row_identity"])';
    await selectOptionByValue(page, `${identityForm} [data-scope-review-value]`, "id");
    await typeIntoSelector(page, `${identityForm} [data-scope-review-actor]`, "visual-scope-reviewer");
    await typeIntoSelector(page, `${identityForm} [data-scope-review-reason]`, "The inspected unique key is the application record identity.");
    await clickSelector(page, '[data-submit-scope-review="row_identity"]');
    await waitForExpression(page, `(() => {
      const review=reviewResource(${JSON.stringify(resolvableResource)});
      const form=document.querySelector('[data-scope-review-form]:has([data-submit-scope-review="tenant_key"])');
      const rowForm=document.querySelector('[data-scope-review-form]:has([data-submit-scope-review="row_identity"])');
      return review?.primary_key?.selected==="id"
        && !rowForm
        && document.querySelector("#resource-detail")?.getAttribute("aria-busy")!=="true"
        && Boolean(form?.offsetParent&&form.querySelector('[data-scope-review-value]')?.value);
    })()`);
    const tenantForm = '[data-scope-review-form]:has([data-submit-scope-review="tenant_key"])';
    await screenshot(page, "workbench-blocked-scope-tenant-review.png");
    await typeIntoSelector(page, `${tenantForm} [data-scope-review-actor]`, "visual-scope-reviewer");
    await typeIntoSelector(page, `${tenantForm} [data-scope-review-reason]`, "The application fixes tenant_id outside every model argument.");
    const tenantInputState = await evaluate(page, `(() => {
      const form=document.querySelector(${JSON.stringify(tenantForm)});
      return {
        value:form?.querySelector("[data-scope-review-value]")?.value||null,
        actor:form?.querySelector("[data-scope-review-actor]")?.value||null,
        reason:form?.querySelector("[data-scope-review-reason]")?.value||null,
      };
    })()`);
    assert(
      tenantInputState.value === "tenant_id"
        && tenantInputState.actor === "visual-scope-reviewer"
        && tenantInputState.reason === "The application fixes tenant_id outside every model argument.",
      "Workbench scope form lost operator input before submission",
      tenantInputState,
    );
    await clickSelector(page, '[data-submit-scope-review="tenant_key"]');
    await waitForExpression(
      page,
      `(candidate?.pack?.resources||[]).some(item=>item.id===${JSON.stringify(resolvableResource)})
        || [...document.querySelectorAll("[data-scope-review-status].error")].some(item=>item.textContent?.trim())`,
    );
    const resolvedState = await evaluate(page, `(() => ({
      candidateIds:(candidate?.pack?.resources||[]).map(item=>item.id),
      selectedResource,
      row:document.querySelector(${JSON.stringify(`[data-access-resource="${resolvableResource}"]`)})?.dataset.accessIncluded||null,
      review:(() => {
        const item=reviewResource(${JSON.stringify(resolvableResource)});
        return item?{
          status:item.status,
          blockers:item.blockers,
          primary:item.primary_key,
          tenant:item.tenant_key
        }:null;
      })(),
      statuses:[...document.querySelectorAll("[data-scope-review-status]")].map(item=>({
        className:item.className,
        text:item.textContent||""
      }))
    }))()`);
    assert(
      resolvedState.candidateIds.includes(resolvableResource),
      "Workbench did not include the table after both reviewed scope choices",
      resolvedState,
    );
    assert(
      await evaluate(page, `(() => {
        const selected=document.querySelector(".access-resource.selected");
        const detail=document.querySelector("#resource-detail")?.textContent||"";
        return selected?.dataset.accessResource===${JSON.stringify(resolvableResource)}
          && selected?.dataset.accessIncluded==="true"
          && /Columns/i.test(detail)
          && !/Unavailable:/.test(detail);
      })()`),
      "Workbench scope resolution did not keep the table selected for column review",
    );
    assert(
      await fs.readFile(
        path.join(projectRoot, ".synapsor", "exploration-boundary.active.json"),
        "utf8",
      ) === activeArtifact,
      "resolving blocked Workbench access changed active authority before review",
    );
    await screenshot(page, "workbench-blocked-scope-resolved.png");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await evaluate(page, "window.scrollTo(0,0)");
    await assertWorkbenchDom(page, "mobile access editor", { expectedView: "exceptions" });
    await screenshot(page, "workbench-access-editor-mobile.png");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1440,
      screenHeight: 1100,
    });

    await evaluate(page, "document.querySelector('[data-view=\"activate\"]')?.click()");
    await typeIntoSelector(page, "#actor", "visual-reviewer@example.test");
    await evaluate(page, `(() => {
      document.querySelector("#message").textContent="Schema changed after review. Your disabled draft and completed decisions were preserved. Next: rescan and review the semantic diff.";
      document.querySelector("#message").className="status-message error";
    })()`);
    await waitForExpression(page, "document.querySelector('#view-activate')?.classList.contains('active') === true");
    const focus = await evaluate(page, "({tag:document.activeElement?.tagName,id:document.activeElement?.id})");
    assert(focus.id === "actor", "keyboard focus did not reach the operator identity control", focus);
    await assertWorkbenchDom(page, "keyboard stale failure", { expectedView: "activate" });
    await screenshot(page, "workbench-keyboard-stale-failure.png");

    await clickSelector(page, '[data-view="explore"]');
    await waitForExpression(page, "document.querySelector('#view-explore')?.classList.contains('active') === true");
    if (await evaluate(page, "Boolean(document.querySelector('#run-preflight'))")) {
      await clickSelector(page, "#run-preflight");
    }
    await waitForExpression(page, "document.querySelector('#explore-preflight')?.textContent.includes('Reviewed access ready') === true || document.querySelector('#explore-preflight')?.textContent.includes('Ready for local bounded exploration') === true || document.querySelector('#explore-preflight')?.textContent.includes('Bind this local authoring session') === true || document.querySelector('#explore-preflight')?.textContent.includes('Explore is not ready') === true");
    await assertWorkbenchDom(page, "explore blocked", { expectedView: "explore" });
    await screenshot(page, "workbench-explore-blocked.png");

    await evaluate(page, "document.querySelector('[data-view=\"protect\"]')?.click()");
    await waitForExpression(page, "document.querySelector('#view-protect')?.classList.contains('active') === true");
    await waitForExpression(page, "document.querySelector('#protect-queries')?.textContent.length > 0");
    await assertWorkbenchDom(page, "protect empty", { expectedView: "protect" });
    await screenshot(page, "workbench-protect-empty.png");

    await evaluate(page, "document.querySelector('[data-view=\"action\"]')?.click()");
    await waitForExpression(page, "document.querySelector('#view-action')?.classList.contains('active') === true");
    await waitForExpression(page, "document.querySelector('#action-loading')?.textContent.length > 0");
    await assertWorkbenchDom(page, "action unavailable", { expectedView: "action" });
    await screenshot(page, "workbench-action-unavailable.png");

    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await clickSelector(page, '[data-view="overview"]');
    await waitForExpression(page, "document.querySelector('#view-overview')?.classList.contains('active') === true");
    if (await evaluate(page, `document.querySelectorAll(".resource").length === ${inspection.tables.length}`)) {
      await evaluate(page, "document.querySelector('#show-all')?.click()");
      await waitForExpression(
        page,
        `document.querySelectorAll(".resource").length < ${inspection.tables.length}`,
      );
    }
    await evaluate(page, "window.scrollTo(0,0)");
    await waitForExpression(page, "document.querySelectorAll('.resource').length > 0");
    const mobileStarterResourceCount = await evaluate(page, "document.querySelectorAll('.resource').length");
    assert(
      mobileStarterResourceCount < inspection.tables.length,
      "mobile overview: fresh Workbench did not present a bounded starter pack",
      { mobileStarterResourceCount },
    );
    await waitForExpression(page, "document.querySelector('#view-overview')?.classList.contains('active') === true");
    await assertWorkbenchDom(page, "mobile overview", {
      expectedView: "overview",
      maximumResources: 8,
      requireCatalogFixtures: false,
    });
    await screenshot(page, "workbench-overview-mobile-light.png");

    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1440,
      screenHeight: 1100,
    });
    await navigateAndWait(page, `http://${localUi.host}:${localUi.port}/?surface=activity`);
    await waitForExpression(page, "document.querySelector('#attention select[aria-label=\"Human attention status\"]')?.value === 'open'");
    await waitForExpression(page, "document.querySelectorAll('#attention .attention-item').length >= 3");
    await assertActivityDom(page, "attention open", "open");
    await screenshot(page, "workbench-attention-open-desktop.png");

    for (const status of ["acknowledged", "resolved", "expired"]) {
      await selectOptionByValue(
        page,
        '#attention select[aria-label="Human attention status"]',
        status,
      );
      await waitForExpression(page, `document.querySelector('#attention select[aria-label="Human attention status"]')?.value === ${JSON.stringify(status)} && document.querySelectorAll('#attention .attention-item').length === 1`);
      await assertActivityDom(page, `attention ${status}`, status);
      await screenshot(page, `workbench-attention-${status}-desktop.png`);
    }

    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await navigateAndWait(page, `http://${localUi.host}:${localUi.port}/?surface=activity`);
    await evaluate(page, "window.scrollTo(0, document.querySelector('#attention').offsetTop)");
    await waitForExpression(page, "document.querySelector('#attention select[aria-label=\"Human attention status\"]')?.value === 'open' && document.querySelectorAll('#attention .attention-item').length >= 3");
    await assertActivityDom(page, "attention mobile", "open");
    await screenshot(page, "workbench-attention-mobile.png");

  } finally {
    page.close();
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    output: outputRoot,
    screenshots,
    inspected_resources: 40,
    first_value_human_steps: firstValueHumanSteps,
    first_actionable_ms: firstActionableMs,
    first_verified_result_ms: firstVerifiedResultMs,
    states: [
      "desktop",
      "narrow",
      "light",
      "dark",
      "keyboard",
      "loading",
      "partial",
      "empty",
      "blocked",
      "stale",
      "failure",
      "long-names",
      "multiple-unresolved-fields",
      "ambiguous-identity",
      "40-table-schema",
      "attention-open",
      "attention-acknowledged",
      "attention-resolved",
      "attention-expired",
      "attention-mobile",
      "attention-retry-escalation",
      "attention-dead-letter",
      "attention-unknown",
      "attention-reconciliation",
      "instant-ready",
      "instant-success-desktop",
      "instant-success-mobile",
      "attention-unhealthy-sink",
      "attention-large-backlog",
      "worker-disabled",
    ],
  }, null, 2)}\n`);
} finally {
  await localUi?.close().catch(() => undefined);
  await chrome?.close().catch(() => undefined);
  await fs.rm(projectRoot, { recursive: true, force: true });
}

async function screenshot(page, name) {
  await captureScreenshot(page, path.join(outputRoot, name));
  screenshots.push(name);
}

async function assertWorkbenchDom(page, label, options) {
  const report = await evaluate(page, `(() => {
    const controls=[...document.querySelectorAll("input:not([type=hidden]),select,textarea")];
    const unlabeled=controls
      .filter(control=>!control.getAttribute("aria-label")&&!control.closest("label"))
      .map(control=>(control.outerHTML||control.id||control.type).slice(0,240));
    const ids=[...document.querySelectorAll("[id]")].map(node=>node.id);
    const duplicates=ids.filter((id,index)=>ids.indexOf(id)!==index);
    const visibleView=[...document.querySelectorAll(".view")].find(node=>node.classList.contains("active"));
    const viewportWidth=document.documentElement.clientWidth;
    const overflowElements=[...document.querySelectorAll("body *")]
      .map(node=>({node,rect:node.getBoundingClientRect()}))
      .filter(({rect})=>rect.right>viewportWidth+1||rect.left<-1)
      .slice(0,12)
      .map(({node,rect})=>({
        tag:node.tagName,
        id:node.id,
        className:String(node.className||"").slice(0,160),
        parent:(node.parentElement?.tagName||"")+"#"+(node.parentElement?.id||"")+"."+String(node.parentElement?.className||"").slice(0,120),
        text:String(node.textContent||"").trim().slice(0,160),
        left:Math.round(rect.left),
        right:Math.round(rect.right),
        width:Math.round(rect.width),
      }));
    const primary=[...visibleView.querySelectorAll("button")]
      .filter(button=>!button.disabled&&!button.classList.contains("secondary")&&!button.classList.contains("quiet")&&!button.classList.contains("danger"))
      .filter(button=>button.offsetParent!==null
        && !button.closest("details:not([open])")
        && button.getClientRects().length>0
        && getComputedStyle(button).visibility!=="hidden")
      .map(button=>button.textContent.trim());
    return {
      title:document.title,
      header:Boolean(document.querySelector("header")),
      main:Boolean(document.querySelector("main")),
      steps:document.querySelectorAll(".step").length,
      visibleView:visibleView?.id,
      horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,
      overflowElements,
      unlabeled,
      duplicates,
      resources:document.querySelectorAll(".resource").length,
      primary,
      intro:document.querySelector("#view-overview .band")?.textContent||"",
      advancedMatrixOpen:Boolean(document.querySelector(".permission-table")?.closest("details")?.open),
      longNameVisible:document.body.textContent.includes("members_with_an_intentionally_long_operational_name_for_layout_validation"),
      ambiguousIdentityVisible:document.body.textContent.includes("ambiguous_customer_identity_records"),
    };
  })()`);
  assert(report.title === "Auto Boundary Review | Synapsor Runner", `${label}: wrong page title`, report);
  assert(report.header && report.main, `${label}: missing page landmarks`, report);
  assert(report.steps === 5, `${label}: five-stage journey is missing`, report);
  assert(report.visibleView === `view-${options.expectedView}`, `${label}: wrong visible journey step`, report);
  assert(report.horizontalOverflow === false, `${label}: horizontal overflow`, report);
  assert(report.unlabeled.length === 0, `${label}: unlabeled form controls`, report);
  assert(report.duplicates.length === 0, `${label}: duplicate element IDs`, report);
  assert(report.primary.length <= 1, `${label}: more than one visually primary next action`, report);
  if (options.expectedResources !== undefined) {
    assert(report.resources === options.expectedResources, `${label}: resource catalog size changed`, report);
  }
  if (options.maximumResources !== undefined) {
    assert(report.resources <= options.maximumResources, `${label}: starter review is not bounded`, report);
  }
  if (options.requireCatalogFixtures) {
    assert(/does not give the agent SQL access/i.test(report.intro), `${label}: no-SQL mental model is missing`, report);
    assert(report.advancedMatrixOpen === false, `${label}: dense permission matrix opened by default`, report);
    assert(report.longNameVisible, `${label}: long-name fixture is absent`, report);
    assert(report.ambiguousIdentityVisible, `${label}: ambiguous-identity fixture is absent`, report);
  }
}

async function assertActivityDom(page, label, expectedStatus) {
  const report = await evaluate(page, `(() => {
    const controls=[...document.querySelectorAll("input,select,textarea")];
    const unlabeled=controls
      .filter(control=>!control.getAttribute("aria-label")&&!control.closest("label"))
      .map(control=>(control.outerHTML||control.id||control.type).slice(0,240));
    const ids=[...document.querySelectorAll("[id]")].map(node=>node.id);
    return {
      title:document.title,
      horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,
      unlabeled,
      duplicateIds:ids.filter((id,index)=>ids.indexOf(id)!==index),
      status:document.querySelector('#attention select[aria-label="Human attention status"]')?.value,
      attentionItems:document.querySelectorAll("#attention .attention-item").length,
      attentionText:document.querySelector("#attention")?.textContent||"",
      sourceTruth:/source of truth/i.test(document.querySelector("#attention")?.textContent||""),
      workerBoundary:/controls are never MCP tools/i.test(document.querySelector("#worker")?.textContent||""),
    };
  })()`);
  assert(report.title === "Synapsor Workbench | Activity", `${label}: wrong activity page title`, report);
  assert(report.horizontalOverflow === false, `${label}: horizontal overflow`, report);
  assert(report.unlabeled.length === 0, `${label}: unlabeled form controls`, report);
  assert(report.duplicateIds.length === 0, `${label}: duplicate element IDs`, report);
  assert(report.status === expectedStatus, `${label}: wrong attention status`, report);
  assert(report.attentionItems > 0, `${label}: no attention items rendered`, report);
  assert(report.sourceTruth, `${label}: ledger/Workbench source-of-truth message missing`, report);
  assert(report.workerBoundary, `${label}: worker authority separation message missing`, report);
  if (expectedStatus === "open") {
    for (const [name, pattern] of [
      ["UNKNOWN", /unknown transaction outcome/i],
      ["dead letter", /exhausted its retry budget/i],
      ["reconciliation", /reconciliation/i],
      ["retry escalation", /retry crossed the reviewed escalation threshold/i],
      ["unhealthy supervision", /required supervision sink remained unhealthy/i],
      ["large backlog", /queue backlog exceeded its reviewed threshold/i],
    ]) {
      assert(pattern.test(report.attentionText), `${label}: ${name} attention state is missing`, report);
    }
  }
}

async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
}

function visualInspection() {
  const tables = Array.from({ length: 40 }, (_unused, index) => {
    if (index === 0) {
      return table("members_with_an_intentionally_long_operational_name_for_layout_validation", {
        extraColumns: [
          column("payment_method", "text", { sensitive: true }),
          column("customer_support_context_free_form_notes_requiring_human_review", "text"),
          column("operational_resource_04_id", "uuid", { immutable: true }),
        ],
        foreignKeys: [{
          name: "members_operational_resource_04_id_fkey",
          columns: ["operational_resource_04_id"],
          referenced_schema: "public",
          referenced_table: "operational_resource_04",
          referenced_columns: ["id"],
          delete_rule: "RESTRICT",
        }],
      });
    }
    if (index === 1) {
      return table("ambiguous_customer_identity_records", {
        primaryKey: ["tenant_id", "external_id"],
        omitId: true,
        extraColumns: [
          column("external_id", "uuid", { immutable: true }),
          column("medical_notes", "text", { sensitive: true }),
          column("unstructured_context", "text"),
        ],
      });
    }
    if (index === 2) {
      return table("unscoped_shared_reference_data", {
        scoped: false,
      });
    }
    if (index === 4) {
      return table("operational_resource_05", {
        extraColumns: [column("operational_resource_04_id", "uuid", { immutable: true })],
        foreignKeys: [{
          name: "operational_resource_05_operational_resource_04_id_fkey",
          columns: ["operational_resource_04_id"],
          referenced_schema: "public",
          referenced_table: "operational_resource_04",
          referenced_columns: ["id"],
          delete_rule: "RESTRICT",
        }],
      });
    }
    if (index === 5) {
      return table("operational_resource_06", {
        extraColumns: [column("operational_resource_04_id", "uuid", { immutable: true })],
        foreignKeys: [{
          name: "operational_resource_06_operational_resource_04_id_fkey",
          columns: ["operational_resource_04_id"],
          referenced_schema: "public",
          referenced_table: "operational_resource_04",
          referenced_columns: ["id"],
          delete_rule: "RESTRICT",
        }],
      });
    }
    if (index === 6) {
      const candidate = table("manual_scope_orders", {
        primaryKey: [],
        extraColumns: [column("external_id", "uuid", { immutable: true })],
      });
      candidate.unique_constraints = [
        { name: "manual_scope_orders_id_key", columns: ["id"] },
        { name: "manual_scope_orders_external_id_key", columns: ["external_id"] },
      ];
      candidate.indexes = candidate.unique_constraints.map((constraint) => ({
        name: constraint.name,
        columns: constraint.columns,
        unique: true,
      }));
      candidate.row_level_security = false;
      candidate.row_level_security_policies = [];
      candidate.role_posture.row_security_forced = false;
      candidate.role_posture.row_security_effective_for_current_role = false;
      return candidate;
    }
    return table(`operational_resource_${String(index + 1).padStart(2, "0")}`);
  });
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16 visual fixture",
    current_user: "app_reader",
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    },
    inspected_at: "2026-07-24T00:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    tables,
  };
}

function seedVisualAttention(storePath) {
  const store = new ProposalStore(storePath);
  const digest = `sha256:${"a".repeat(64)}`;
  const record = (event_type, severity, key, summary, extra = {}) => store.recordAttentionEvent({
    event_type,
    severity,
    environment: "staging",
    capability: "membership.propose_status_change",
    contract_digest: digest,
    attention_key: key,
    attention_required: true,
    immediate_default: severity === "critical",
    summary,
    workbench_path: "/",
    details: { source_database_changed: false },
    source_event_key: `visual:${key}:${event_type}`,
    ...extra,
  });
  try {
    record("proposal.review_required", "warning", "visual:review", "Three membership proposals need manager review");
    record("worker.unknown_outcome", "critical", "visual:unknown", "A guarded write has an unknown transaction outcome");
    record("worker.dead_lettered", "critical", "visual:dead-letter", "A trusted-worker job exhausted its retry budget");
    record("worker.reconciliation_required", "critical", "visual:reconciliation", "Operator reconciliation is required before retry");
    record("worker.retry_scheduled", "warning", "visual:retry-escalation", "A retry crossed the reviewed escalation threshold");
    record("worker.unhealthy", "critical", "visual:unhealthy-sink", "A required supervision sink remained unhealthy");
    record("worker.queue_backlog", "warning", "visual:large-backlog", "The trusted-worker queue backlog exceeded its reviewed threshold");

    record("schema.drift_detected", "critical", "visual:acknowledged", "Schema drift blocks one active capability");
    const acknowledged = store.listAttentionItems().find((item) => item.attention_key === "visual:acknowledged");
    store.acknowledgeAttention({
      attention_id: acknowledged.attention_id,
      actor: "visual_operator",
      now: "2026-07-24T17:01:00.000Z",
    });

    record("worker.unhealthy", "warning", "visual:resolved", "Trusted worker health remained degraded");
    const resolved = store.listAttentionItems().find((item) => item.attention_key === "visual:resolved");
    store.resolveAttention({
      attention_id: resolved.attention_id,
      now: "2026-07-24T17:02:00.000Z",
    });

    record(
      "proposal.expiring",
      "warning",
      "visual:expiring",
      "Approved proposal is approaching expiry",
      {
        proposal_id: "wrp_visual_expiring",
        expires_at: "2026-07-24T17:03:00.000Z",
      },
    );
    store.recordAttentionEvent({
      event_type: "proposal.expired",
      severity: "warning",
      environment: "staging",
      proposal_id: "wrp_visual_expiring",
      capability: "membership.propose_status_change",
      contract_digest: digest,
      attention_required: false,
      immediate_default: false,
      summary: "Approved proposal expired without execution",
      details: { source_database_changed: false },
      source_event_key: "visual:expired",
      now: "2026-07-24T17:03:01.000Z",
    });
  } finally {
    store.close();
  }
}

function table(name, options = {}) {
  const scoped = options.scoped !== false;
  const primaryKey = options.primaryKey ?? ["id"];
  const columns = [
    ...(options.omitId ? [] : [column("id", "uuid", { immutable: true })]),
    ...(scoped ? [column("tenant_id", "uuid", { tenant: true, immutable: true })] : []),
    column("status", "text", { enumValues: ["open", "closed", "archived"] }),
    column("created_at", "timestamp with time zone"),
    column("amount_cents", "integer"),
    ...(options.extraColumns ?? []),
  ];
  return {
    schema: "public",
    name,
    type: "table",
    writable: false,
    columns,
    primary_key: primaryKey,
    unique_constraints: primaryKey.length === 1
      ? [{ name: `${name}_pkey`, columns: primaryKey }]
      : [],
    foreign_keys: options.foreignKeys ?? [],
    indexes: primaryKey.length === 1
      ? [{ name: `${name}_pkey`, columns: primaryKey, unique: true }]
      : [],
    row_level_security: scoped,
    row_level_security_policies: scoped ? [{
      name: `${name}_tenant_read`,
      command: "SELECT",
      permissive: true,
      roles: ["app_reader"],
      using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)",
    }] : [],
    role_posture: {
      owner: "app_owner",
      current_role_is_owner: false,
      current_role_can_assume_owner: false,
      row_security_forced: scoped,
      row_security_effective_for_current_role: scoped,
      privileges: {
        select: true,
        insert: false,
        update: false,
        delete: false,
        truncate: false,
        references: false,
        trigger: false,
      },
    },
    suggestions: {
      tenant_columns: scoped ? ["tenant_id"] : [],
      conflict_columns: [],
      sensitive_columns: columns.filter((item) => item.suggestions.sensitive).map((item) => item.name),
      default_visible_columns: columns
        .filter((item) => !item.suggestions.sensitive)
        .map((item) => item.name),
    },
  };
}

function column(name, dataType, flags = {}) {
  return {
    name,
    data_type: dataType,
    nullable: false,
    generated: false,
    ordinal_position: 1,
    ...(flags.enumValues ? { enum_values: [...flags.enumValues] } : {}),
    suggestions: {
      tenant: flags.tenant ?? false,
      conflict: false,
      sensitive: flags.sensitive ?? false,
      immutable: flags.immutable ?? false,
      large_or_binary: false,
    },
  };
}

function assert(condition, message, details) {
  if (condition) return;
  throw new Error(`${message}${details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`}`);
}
