import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  writeAutoBoundaryArtifacts,
} from "../apps/runner/dist/auto-boundary.js";
import { initializeGuidedProject } from "../apps/runner/dist/guided-project.js";
import { saveInstantBoundaryReviewBaseline } from "../apps/runner/dist/boundary-review-domain.js";
import { startLocalUiServer } from "../apps/runner/dist/local-ui.js";
import { AskError } from "../apps/runner/dist/model-ask.js";
import { createScopedExploreRuntime } from "../apps/runner/dist/scoped-explore.js";
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
const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-workbench-ask-"));
const chromeProfile = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-workbench-ask-chrome-"));
const outputRoot = path.resolve(
  process.env.SYNAPSOR_WORKBENCH_ASK_OUTPUT
    ?? path.join(root, "development", "runner-1.6.6-ask-visual"),
);
const sessionKey = "sk-workbench-browser-canary-never-persist";
const priorDatabaseUrl = process.env.DATABASE_URL;
const priorTenant = process.env.SYNAPSOR_TENANT_ID;
process.env.DATABASE_URL = "postgresql://fixture.invalid/synapsor";
process.env.SYNAPSOR_TENANT_ID = "tenant-browser";
const screenshots = [];
let localUi;
let chrome;
let providerRequests = 0;
let providerAuthenticationFailures = 0;
let toolCalls = 0;
let refusalCalls = 0;
const providerRequestBodies = [];
const withheldRegions = ["withheld-region-alpha", "withheld-region-beta"];

try {
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const inspection = askInspection();
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
  });
  await saveInstantBoundaryReviewBaseline({
    projectRoot,
    draft: build.exploration_boundary,
    candidate: build.exploration_boundary,
    actor: "browser-reviewer@example.test",
  });
  const boundaryDigest = explorationBoundaryCandidateDigest(build.exploration_boundary);
  await activateExplorationBoundary({
    projectRoot,
    candidate: build.exploration_boundary,
    expectedDigest: boundaryDigest,
    actor: "browser-reviewer@example.test",
    confirmation: `ACTIVATE ${boundaryDigest}`,
    confirmedDecisions: build.exploration_boundary.unresolved_decisions,
    currentInspection: inspection,
  });

  const exploreArguments = {
    plan: {
      kind: "aggregate",
      resource: "public.accounts",
      measures: [{ function: "count" }],
      dimensions: [{ field: "region" }],
      top_n: 10,
    },
  };
  const tools = [{
    name: "app.describe_data",
    title: "Describe reviewed data",
    description: "Lists the exact reviewed local authoring catalog without reading source rows.",
    input_schema: {
      type: "object",
      properties: {
        resource: { type: "string", maxLength: 256 },
        cursor: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 10 },
      },
      additionalProperties: false,
    },
    metadata: {
      "synapsor.kind": "scoped_explore_description",
      "synapsor.authoring_only": true,
      "synapsor.raw_sql_exposed": false,
      "synapsor.approval_tool": false,
      "synapsor.commit_tool": false,
    },
  }, {
    name: "app.explore_data",
    title: "Explore reviewed data",
    description: "Runs one typed bounded plan against the exact reviewed local authoring boundary.",
    input_schema: {
      type: "object",
      properties: {
        plan: {
          type: "object",
          properties: {
            kind: { const: "aggregate" },
            resource: { type: "string", maxLength: 256 },
            measures: { type: "array", maxItems: 3 },
            dimensions: { type: "array", maxItems: 3 },
            top_n: { type: "integer", minimum: 1, maximum: 100 },
          },
          required: ["kind", "resource", "measures", "dimensions", "top_n"],
          additionalProperties: false,
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
    metadata: {
      "synapsor.kind": "scoped_explore",
      "synapsor.authoring_only": true,
      "synapsor.raw_sql_exposed": false,
      "synapsor.approval_tool": false,
      "synapsor.commit_tool": false,
    },
  }];
  localUi = await startLocalUiServer({
    projectRoot,
    boundaryRoot: written.root,
    configPath: guided.config_path,
    storePath: guided.store_path,
    token: "ask-browser-token",
    csrfToken: "ask-browser-csrf",
    deploymentProfile: build.exploration_boundary.deployment_profile,
    schemaInspector: async () => inspection,
    scopedExploreRuntimeFactory: (input) => createScopedExploreRuntime({
      ...input,
      inspectDatabaseFn: async () => inspection,
      executor: {
        execute: async () => [],
        executeBatch: async ({ queries }) => queries.map(() => []),
        close: async () => undefined,
      },
    }),
    askGatewayFactory: async () => ({
      mode: "authoring",
      listTools: async () => tools,
      callTool: async (name, args) => {
        if (name === "app.describe_data") {
          return {
            ok: true,
            value: {
              ok: true,
              resources: [{
                id: "public.accounts",
                label: "Accounts",
                field_labels: {
                  id: "ID",
                  region: "Region",
                  created_at: "Created at",
                },
                field_egress: {
                  id: "visible",
                  region: "withheld",
                  created_at: "visible",
                },
                groupable_fields: ["region"],
                count_distinct_fields: ["id"],
                time_bucket_fields: {
                  created_at: ["day", "week", "month"],
                },
              }],
              source_database_changed: false,
            },
          };
        }
        assert(name === "app.explore_data", "Ask called a tool outside the reviewed analytical surface", { name });
        if (args?.plan?.resource === "public.accounts"
          && args.plan.dimensions?.some((dimension) => dimension.field === "payment_token")) {
          refusalCalls += 1;
          return {
            ok: false,
            error_code: "EXPLORE_FIELD_FORBIDDEN",
            value: {
              ok: false,
              error_code: "EXPLORE_FIELD_FORBIDDEN",
              message: "public.accounts.payment_token is kept out of the activated reviewed boundary.",
              details: {
                resource: "public.accounts",
                field: "payment_token",
              },
              source_database_changed: false,
            },
          };
        }
        assert(
          JSON.stringify(args) === JSON.stringify(exploreArguments),
          "Ask changed the reviewed aggregate plan",
          { args },
        );
        toolCalls += 1;
        const value = {
          ok: true,
          outcome: {
            type: "success",
            status: "ok",
            result: {
              counted_entity: "accounts",
              grain: "one group per reviewed region",
            },
          },
          data: [
            { region: withheldRegions[0], count_accounts: 7 },
            { region: withheldRegions[1], count_accounts: 4 },
          ],
          audit: {
            query_fingerprint: `sha256:${String(toolCalls).padStart(64, "0")}`,
            returned_rows_or_groups: 2,
            returned_cells: 4,
            persisted_result_values: false,
          },
          privacy: {
            minimum_cohort_size: 5,
            suppressed_groups: 0,
            totals_returned: false,
          },
          evidence_bundle_id: `ev_browser_ask_${toolCalls}`,
          evidence_resource: `synapsor://evidence/ev_browser_ask_${toolCalls}`,
          protect: {
            token: `A${toolCalls}`,
            expires_at: "2026-07-27T23:00:00.000Z",
          },
          source_database_changed: false,
        };
        return {
          ok: true,
          value,
          provider_value: {
            ...value,
            data: [
              { region: "[withheld:visual:1]", count_accounts: 7 },
              { region: "[withheld:visual:2]", count_accounts: 4 },
            ],
          },
          model_withheld_values: true,
        };
      },
      close: async () => undefined,
    }),
    askProviderDependencies: {
      requestJson: async (input) => {
        if (JSON.stringify(input.body).includes("Simulate a rejected provider credential.")) {
          providerAuthenticationFailures += 1;
          throw new AskError(
            "ASK_PROVIDER_AUTHENTICATION_FAILED",
            "The selected provider rejected the configured API key.",
            502,
          );
        }
        providerRequests += 1;
        providerRequestBodies.push(JSON.stringify(input.body));
        assert(
          providerRequestBodies.every((body) => withheldRegions.every((value) => !body.includes(value))),
          "A model-withheld value entered a provider request",
          { providerRequestBodies },
        );
        assert(
          input.headers.authorization === `Bearer ${sessionKey}`,
          "Workbench did not keep the session credential isolated to the provider request",
        );
        if (providerRequests === 3) {
          return new Promise((_resolve, reject) => {
            input.signal.addEventListener(
              "abort",
              () => reject(new AskError("ASK_CANCELLED", "The Ask request was cancelled.", 499)),
              { once: true },
            );
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 240));
        if (providerRequests === 1 || providerRequests === 4) {
          return {
            status: 200,
            body: {
              choices: [{
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                      id: `call_browser_ask_${providerRequests}`,
                    type: "function",
                    function: {
                      name: "app__explore_data",
                      arguments: JSON.stringify(exploreArguments),
                    },
                  }],
                },
              }],
            },
          };
        }
        if (providerRequests === 6) {
          return {
            status: 200,
            body: {
              choices: [{
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [{
                    id: "call_browser_refused_payment_token",
                    type: "function",
                    function: {
                      name: "app__explore_data",
                      arguments: JSON.stringify({
                        plan: {
                          kind: "aggregate",
                          resource: "public.accounts",
                          measures: [{ function: "count" }],
                          dimensions: [{ field: "payment_token" }],
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
        if (providerRequests === 7) {
          return {
            status: 200,
            body: {
              choices: [{
                message: {
                  role: "assistant",
                  content: null,
                },
              }],
            },
          };
        }
        if (providerRequests === 8) {
          return {
            status: 200,
            body: {
              choices: [{
                message: {
                  role: "assistant",
                  content: "Payment token is outside the active reviewed boundary, so Runner did not execute that analysis.",
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
                content: "The first withheld region token has the larger reviewed account count.",
              },
            }],
          },
        };
      },
    },
  });

  chrome = await launchChrome({
    userDataDir: chromeProfile,
    width: 1440,
    height: 1100,
  });
  const page = await createPage(chrome.port);
  try {
    await configurePage(page, 1440, 1100);
    await navigateAndWait(page, localUi.url);
    await waitForExpression(page, "document.querySelector('#header-state')?.textContent !== 'Loading'");
    await waitForExpression(page, "document.querySelector('#ask-shell')?.offsetParent !== null");
    const initialDestination = await evaluate(page, `({
      hash:location.hash,
      askActive:document.querySelector('[data-view="explore"]')?.classList.contains("active"),
      reviewActive:document.querySelector('[data-view="overview"]')?.classList.contains("active")
    })`);
    assert(
      initialDestination.askActive && !initialDestination.reviewActive,
      "An active local analytics project did not reopen directly in Ask",
      initialDestination,
    );
    await waitForExpression(page, "document.querySelector('#ask-authority-summary')?.textContent.includes('scoped · read-only')");
    await waitForExpression(page, "document.querySelector('#explore-preflight')?.textContent.includes('Reviewed access ready') || document.querySelector('#explore-preflight')?.textContent.includes('Explore is not ready') || document.querySelector('#explore-preflight')?.textContent.includes('is missing')");
    const preflightText = await evaluate(page, "document.querySelector('#explore-preflight')?.textContent");
    assert(
      String(preflightText).includes("Reviewed access ready"),
      "The browser Ask fixture did not reach the exact active-boundary catalog",
      { preflightText },
    );
    await waitForExpression(page, "document.querySelectorAll('#ask-starters [data-ask-starter]').length > 0");
    const initialQuestionSurface = await evaluate(page, `({
      placeholder:document.querySelector("#ask-question")?.placeholder,
      starters:document.querySelector("#ask-starters")?.textContent
    })`);
    assert(
      !String(initialQuestionSurface.placeholder).includes("reviewed regions contributed most"),
      "Ask retained the canned region placeholder",
      initialQuestionSurface,
    );
    assert(
      String(initialQuestionSurface.placeholder).toLowerCase().includes("account")
        || String(initialQuestionSurface.starters).toLowerCase().includes("account"),
      "Ask did not advertise a question derived from the active accounts boundary",
      initialQuestionSurface,
    );
    await assertAskDom(page, "unconfigured desktop", false);

    await evaluate(page, "document.querySelector('#external-client-setup').open=true");
    await clickSelector(page, '[data-install-mcp="claude-code"]');
    await waitForExpression(page, "document.querySelector('#mcp-install-status')?.textContent.includes('No live client session is connected yet')");
    const managedClientSetup = await evaluate(page, `({
      button:document.querySelector('[data-install-mcp="claude-code"]')?.textContent,
      status:document.querySelector('#mcp-install-status')?.textContent
    })`);
    assert(
      managedClientSetup.button === "Prepared"
        && /project config is prepared/i.test(String(managedClientSetup.status))
        && /no live client session is connected yet/i.test(String(managedClientSetup.status))
        && !/claude code is connected/i.test(String(managedClientSetup.status)),
      "Managed MCP setup claimed a live client connection after writing only project configuration",
      managedClientSetup,
    );
    await evaluate(page, "document.querySelector('#external-client-setup').open=false");

    await selectOptionByValue(page, "#ask-provider", "anthropic");
    await waitForExpression(page, "document.querySelector('#ask-model')?.value.includes('claude')");
    await selectOptionByValue(page, "#ask-provider", "openai_compatible");
    await waitForExpression(page, "document.querySelector('#ask-base-url-wrap')?.classList.contains('hidden') === false");
    await selectOptionByValue(page, "#ask-provider", "openai");
    await waitForExpression(page, "document.querySelector('#ask-base-url-wrap')?.classList.contains('hidden') === true");
    await typeIntoSelector(page, "#ask-key", sessionKey);
    await clickSelector(page, "#configure-ask");
    await waitForExpression(page, "document.querySelector('#ask-config-status')?.textContent.includes('provider-egress checkbox')");
    await waitForExpression(page, "document.activeElement===document.querySelector('#ask-egress')");
    const requestsBeforeConsent = providerRequests;
    assert(requestsBeforeConsent === 0, "Provider was contacted before egress acknowledgement");
    const missingConsent = await evaluate(page, `({
      visible:document.querySelector("#ask-egress-review")?.offsetParent!==null,
      highlighted:document.querySelector("#ask-egress-review")?.classList.contains("needs-attention"),
      focused:document.activeElement===document.querySelector("#ask-egress"),
      keyRetained:document.querySelector("#ask-key")?.value===${JSON.stringify(sessionKey)}
    })`);
    assert(
      missingConsent.visible && missingConsent.highlighted && missingConsent.focused && missingConsent.keyRetained,
      "Missing provider consent did not reveal and focus the retained-key egress review",
      missingConsent,
    );
    await screenshot(page, "workbench-ask-egress-review-desktop.png");
    await evaluate(page, "document.querySelector('#ask-egress').click()");
    await clickSelector(page, "#configure-ask");
    await waitForExpression(page, "document.querySelector('#ask-chat')?.offsetParent !== null");
    await waitForExpression(page, "document.querySelector('#ask-provider-state')?.textContent.includes('ready')");
    await waitForExpression(page, "document.querySelector('#ask-boundary-summary')?.textContent.includes('7 tables')");
    assert(
      await evaluate(page, "!/data[- ]areas?/i.test(document.body.textContent||'')"),
      "Workbench Ask still exposed the retired generic resource terminology",
    );
    await evaluate(page, "document.querySelector('#ask-boundary-guide').open=true");
    const boundaryGuide = await evaluate(page, `({
      text:document.querySelector("#ask-boundary-body")?.textContent,
      editLabel:document.querySelector("[data-edit-ask-boundary]")?.textContent,
      editVisible:document.querySelector("[data-edit-ask-boundary]")?.offsetParent!==null
    })`);
    assert(
      /accounts/i.test(String(boundaryGuide.text))
        && /region/i.test(String(boundaryGuide.text))
        && /credit balance/i.test(String(boundaryGuide.text))
        && !/payment token/i.test(String(boundaryGuide.text))
        && !/filter by\s*0\b/i.test(String(boundaryGuide.text)),
      "Ask did not explain the exact active boundary in plain language",
      boundaryGuide,
    );
    assert(
      boundaryGuide.editVisible && /review or expand access/i.test(String(boundaryGuide.editLabel)),
      "Ask did not offer an operator path to review or expand the boundary",
      boundaryGuide,
    );
    await evaluate(page, "document.querySelector('#ask-boundary-body [data-boundary-catalog-map]').open=true");
    await waitForExpression(page, "document.querySelectorAll('#ask-boundary-body .boundary-catalog-graph svg path.edge').length > 0");
    const relationshipMap = await evaluate(page, `({
      boundaries:[...document.querySelectorAll('#ask-boundary-body [data-boundary-catalog-select] option')].map(option=>option.value),
      summary:document.querySelector('#ask-boundary-body [data-boundary-catalog-summary]')?.textContent,
      arrows:document.querySelectorAll('#ask-boundary-body .boundary-catalog-graph svg path.edge').length,
      nodes:document.querySelectorAll('#ask-boundary-body .boundary-catalog-graph svg rect.node').length,
      questions:document.querySelector('#ask-boundary-body .boundary-catalog-questions')?.textContent,
      mermaid:document.querySelector('#ask-boundary-body .boundary-catalog-mermaid pre')?.textContent,
      downloadLabel:document.querySelector('#ask-boundary-body [data-download-boundary-diagram]')?.textContent
    })`);
    assert(
      relationshipMap.boundaries.length === 1
        && relationshipMap.boundaries[0] === "reviewed_staging"
        && /one exact active boundary; it is never merged/i.test(String(relationshipMap.summary))
        && relationshipMap.arrows >= 1
        && relationshipMap.nodes >= 2
        && /try cross-table questions/i.test(String(relationshipMap.questions))
        && /account (region|status)/i.test(String(relationshipMap.questions))
        && /erDiagram/.test(String(relationshipMap.mermaid))
        && /PUBLIC_(INVOICES|ORDERS).*PUBLIC_ACCOUNTS/s.test(String(relationshipMap.mermaid))
        && /download full map/i.test(String(relationshipMap.downloadLabel)),
      "Workbench did not render the exact active-boundary relationship graph and export",
      relationshipMap,
    );
    await evaluate(page, "document.querySelector('#ask-boundary-body [data-boundary-catalog-map]').scrollIntoView({behavior:'auto',block:'start'})");
    await screenshot(page, "workbench-ask-relationship-map-desktop.png");
    const firstBoundaryPage = await evaluate(page, `({
      status:document.querySelector(".ask-boundary-pagination-status")?.textContent,
      headings:[...document.querySelectorAll("#ask-boundary-body .ask-boundary-resource h4")].map(node=>node.textContent),
      nextDisabled:document.querySelector("#ask-boundary-next")?.disabled
    })`);
    assert(
      /showing 1.{1,3}6 of 7/i.test(String(firstBoundaryPage.status))
        && firstBoundaryPage.headings.length === 6
        && firstBoundaryPage.nextDisabled === false,
      "Ask did not paginate the first six reviewed tables",
      firstBoundaryPage,
    );
    await clickSelector(page, "#ask-boundary-next");
    await waitForExpression(page, "document.querySelector('.ask-boundary-pagination-status')?.textContent.includes('7 of 7')");
    const secondBoundaryPage = await evaluate(page, `({
      status:document.querySelector(".ask-boundary-pagination-status")?.textContent,
      headings:[...document.querySelectorAll("#ask-boundary-body .ask-boundary-resource h4")].map(node=>node.textContent),
      previousDisabled:document.querySelector("#ask-boundary-previous")?.disabled,
      nextDisabled:document.querySelector("#ask-boundary-next")?.disabled
    })`);
    assert(
      secondBoundaryPage.headings.length === 1
        && /support tickets/i.test(String(secondBoundaryPage.headings[0]))
        && secondBoundaryPage.previousDisabled === false
        && secondBoundaryPage.nextDisabled === true,
      "Ask pagination did not reveal the seventh reviewed table",
      secondBoundaryPage,
    );
    await evaluate(page, "document.querySelector('#ask-boundary-body')?.scrollIntoView({behavior:'auto',block:'start'})");
    await screenshot(page, "workbench-ask-boundary-pagination-desktop.png");
    await clickSelector(page, "#ask-boundary-previous");
    await waitForExpression(page, "document.querySelector('.ask-boundary-pagination-status')?.textContent.includes('1–6 of 7')");
    await clickSelector(page, "[data-edit-ask-boundary]");
    await waitForExpression(page, "document.querySelector('#view-exceptions')?.classList.contains('active')");
    await waitForExpression(page, "document.querySelector('#resource-search')?.offsetParent !== null");
    await clickSelector(page, "#access-back");
    await waitForExpression(page, "document.querySelector('#ask-chat')?.offsetParent !== null");
    await evaluate(page, "document.querySelector('#ask-boundary-guide').open=false");
    const keyAfterConfigure = await evaluate(page, "document.querySelector('#ask-key').value");
    assert(keyAfterConfigure === "", "Pasted provider key remained in the browser field");
    const bodyContainsSecret = await evaluate(page, `document.body.textContent.includes(${JSON.stringify(sessionKey)})`);
    assert(bodyContainsSecret === false, "Pasted provider key appeared in rendered Workbench text");

    await typeIntoSelector(page, "#ask-question", "Simulate a rejected provider credential.");
    await clickSelector(page, "#run-ask");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('OpenAI could not authenticate')");
    const authenticationFailure = await evaluate(page, `({
      transcript:document.querySelector("#ask-transcript")?.textContent,
      action:document.querySelector("[data-ask-error-action]")?.textContent
    })`);
    assert(
      !String(authenticationFailure.transcript).includes("Request refused safely")
        && /change provider or key/i.test(String(authenticationFailure.action)),
      "Provider authentication failure was presented as a Synapsor boundary refusal",
      authenticationFailure,
    );
    await clickSelector(page, "[data-ask-error-action]");
    await waitForExpression(page, "document.querySelector('#ask-configuration-form')?.classList.contains('hidden') === false");
    const recoveryState = await evaluate(page, `({
      credentialOptionsOpen:document.querySelector("#ask-credential-details")?.open,
      recoveryText:document.querySelector("#ask-config-status")?.textContent
    })`);
    assert(
      recoveryState.credentialOptionsOpen
        && /paste only the api key value/i.test(String(recoveryState.recoveryText)),
      "Provider authentication recovery did not reopen credential setup with an actionable explanation",
      recoveryState,
    );
    await typeIntoSelector(page, "#ask-key", sessionKey);
    await evaluate(page, "document.querySelector('#ask-egress').click()");
    await clickSelector(page, "#configure-ask");
    await waitForExpression(
      page,
      "document.querySelector('#ask-chat')?.offsetParent !== null" +
      " && document.querySelector('#ask-configuration-form')?.classList.contains('hidden') === true" +
      " && document.querySelector('#ask-provider-state')?.textContent.includes('ready')",
    );

    await typeIntoSelector(page, "#ask-question", "Count reviewed accounts by region.");
    await clickSelector(page, "#run-ask");
    await waitForExpression(page, "document.querySelector('.ask-composer')?.classList.contains('is-running')");
    const loadingState = await evaluate(page, `({
      running:document.querySelector(".ask-composer")?.classList.contains("is-running"),
      button:document.querySelector("#run-ask")?.textContent,
      buttonDisabled:document.querySelector("#run-ask")?.disabled,
      cancelDisabled:document.querySelector("#cancel-ask")?.disabled,
      status:document.querySelector("#ask-run-status")?.textContent,
      ariaBusy:document.querySelector(".ask-composer")?.getAttribute("aria-busy")
    })`);
    assert(
      loadingState.running
        && loadingState.button === "Asking..."
        && loadingState.buttonDisabled
        && !loadingState.cancelDisabled
        && loadingState.ariaBusy === "true"
        && /reviewed data boundary/i.test(String(loadingState.status)),
      "Ask did not expose a clear cancellable loading state",
      loadingState,
    );
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('Runner verified')");
    await waitForExpression(page, `document.querySelector('#ask-transcript')?.textContent.includes(${JSON.stringify(withheldRegions[0])})`);
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('Some values were shown only to you')");
    assert(
      providerRequestBodies.every((body) => withheldRegions.every((value) => !body.includes(value))),
      "Workbench rendered a local withheld value only after leaking it to the provider",
      { providerRequestBodies },
    );
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('Protect as reusable capability')");
    const desktopAnswerLayout = await evaluate(page, `(() => {
      const grid=document.querySelector(".ask-answer-grid");
      const model=grid?.querySelector(".ask-model-panel")?.getBoundingClientRect();
      const verified=grid?.querySelector("details.ask-verified");
      const vrect=verified?.getBoundingClientRect();
      const composer=document.querySelector(".ask-composer");
      return {
        stacked:Boolean(model&&vrect&&vrect.top>=model.bottom-2),
        modelPrimary:Boolean(model&&vrect&&model.width>=vrect.width-2),
        verifiedCollapsed:Boolean(verified&&!verified.open),
        summary:verified?.querySelector("summary")?.textContent||"",
        composerPosition:composer?getComputedStyle(composer).position:""
      };
    })()`);
    assert(
      desktopAnswerLayout.stacked && desktopAnswerLayout.modelPrimary,
      "The model answer was not the primary chat reply above the verified result",
      desktopAnswerLayout,
    );
    assert(
      desktopAnswerLayout.composerPosition === "sticky",
      "The chat composer was not kept available for the next question",
      desktopAnswerLayout,
    );
    assert(
      desktopAnswerLayout.verifiedCollapsed
        && /runner verified/i.test(String(desktopAnswerLayout.summary)),
      "The verified result was not a labeled collapsed disclosure by default",
      desktopAnswerLayout,
    );
    await clickSelector(page, "details.ask-verified > summary");
    await waitForExpression(page, "document.querySelector('details.ask-verified')?.open === true");
    await clickSelector(page, ".verified-data-details > summary");
    await waitForExpression(page, "document.querySelector('.verified-data-details')?.open && document.querySelector('.verified-data-details table')?.getClientRects().length > 0");
    const withheldVerifiedTable = await evaluate(page, "document.querySelector('.verified-data-details table')?.textContent");
    assert(
      withheldRegions.every((value) => String(withheldVerifiedTable).includes(value))
        && !String(withheldVerifiedTable).includes("[withheld:"),
      "The local verified table did not show the full withheld values",
      { withheldVerifiedTable },
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    await screenshot(page, "workbench-ask-withheld-verified-desktop.png");
    await clickSelector(page, ".verified-data-details > summary");
    await clickSelector(page, "details.ask-verified > summary");
    await assertAskDom(page, "completed desktop", true);
    await evaluate(page, "window.scrollTo(0,document.querySelector('#ask-shell').getBoundingClientRect().top+window.scrollY-76)");
    await screenshot(page, "workbench-ask-first-result-desktop.png");

    await typeIntoSelector(page, "#ask-question", "Cancel this model request.");
    await clickSelector(page, "#run-ask");
    await waitForExpression(page, "document.querySelector('#cancel-ask')?.disabled === false");
    await clickSelector(page, "#cancel-ask");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('Request cancelled')");
    await typeIntoSelector(page, "#ask-question", "Run the reviewed regional count again.");
    await clickSelector(page, "#run-ask");
    await waitForExpression(page, "document.querySelectorAll('#ask-transcript .ask-turn.answer').length === 2");
    await typeIntoSelector(page, "#ask-question", "Group accounts by payment token.");
    await clickSelector(page, "#run-ask");
    await waitForExpression(page, "document.querySelector('#ask-transcript .ask-refused')?.textContent.includes('Nothing ran')");
    await waitForExpression(page, "document.querySelector('#ask-transcript .ask-refused')?.textContent.includes('That question needs data outside this boundary')");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('EXPLORE_FIELD_FORBIDDEN')");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('Attempted plan')");
    const refusedTranscript = await evaluate(page, "document.querySelector('#ask-transcript')?.textContent");
    assert(
      !String(refusedTranscript).includes("The provider returned no final answer."),
      "All-refused Ask retained the cryptic missing-answer terminal state",
    );
    await clickSelector(page, ".ask-refused > .actions [data-review-another-question]");
    await waitForExpression(page, "document.querySelector('#view-exceptions')?.classList.contains('active')");
    await waitForExpression(page, "document.querySelector('[data-access-resource=\"public.accounts\"]')?.classList.contains('selected')");
    await waitForExpression(page, "document.querySelector('[data-access-column=\"payment_token\"]')?.getAttribute('data-access-highlighted') === 'true'");
    await waitForExpression(page, "document.activeElement?.getAttribute('data-field-name') === 'payment_token'");
    const refusalEditorTarget = await evaluate(page, `({
      selected:document.querySelector('[data-access-resource="public.accounts"]')?.classList.contains("selected"),
      highlighted:document.querySelector('[data-access-column="payment_token"]')?.getAttribute("data-access-highlighted"),
      focused:document.activeElement?.getAttribute("data-field-name")
    })`);
    assert(
      refusalEditorTarget.selected
        && refusalEditorTarget.highlighted === "true"
        && refusalEditorTarget.focused === "payment_token",
      "Ask refusal did not deep-link to the exact reviewed table and kept-out field",
      refusalEditorTarget,
    );
    await clickSelector(page, "#access-back");
    await waitForExpression(
      page,
      "document.querySelector('#ask-chat')?.offsetParent !== null"
        + " && !document.body.classList.contains('access-focus-mode')"
        + " && !document.querySelector('#view-exceptions')?.classList.contains('active')",
    );
    await evaluate(page, "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const returnedFromAccessEditor = await evaluate(page, `({
      bodyClass:document.body.className,
      activeView:document.querySelector(".view.active")?.id,
      bodyOpacity:getComputedStyle(document.body).opacity,
      bodyFilter:getComputedStyle(document.body).filter,
      askOpacity:getComputedStyle(document.querySelector("#ask-shell")).opacity,
      askFilter:getComputedStyle(document.querySelector("#ask-shell")).filter
    })`);
    assert(
      returnedFromAccessEditor.activeView === "view-explore"
        && returnedFromAccessEditor.bodyOpacity === "1"
        && returnedFromAccessEditor.bodyFilter === "none"
        && returnedFromAccessEditor.askOpacity === "1"
        && returnedFromAccessEditor.askFilter === "none",
      "Returning from the access editor left Ask visually obscured",
      returnedFromAccessEditor,
    );
    await evaluate(page, "window.scrollTo(0,document.querySelector('#ask-shell').getBoundingClientRect().top+window.scrollY-76)");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await screenshot(page, "workbench-ask-completed-desktop.png");

    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    const mobileAnswerLayout = await evaluate(page, `(() => {
      const grid=document.querySelector(".ask-answer-grid");
      const model=grid?.querySelector(".ask-model-panel")?.getBoundingClientRect();
      const verified=grid?.querySelector(".ask-verified")?.getBoundingClientRect();
      const brand=document.querySelector(".brand")?.getBoundingClientRect();
      const brandTitle=document.querySelector(".brand-copy h1");
      const brandTitleRect=brandTitle?.getBoundingClientRect();
      const brandLineHeight=brandTitle?parseFloat(getComputedStyle(brandTitle).lineHeight):0;
      const headerStatus=document.querySelector(".header-status")?.getBoundingClientRect();
      return {
        columns:grid?getComputedStyle(grid).gridTemplateColumns:"",
        stacked:Boolean(model&&verified&&verified.top>model.bottom),
        brandSingleLine:Boolean(brandTitleRect&&brandLineHeight&&brandTitleRect.height<=brandLineHeight*1.25),
        headerNoOverlap:Boolean(brand&&headerStatus&&brand.right<=headerStatus.left-4),
        headerFits:document.querySelector("header")?.scrollWidth<=window.innerWidth
      };
    })()`);
    assert(
      mobileAnswerLayout.stacked,
      "Model interpretation and verified Runner result did not stack on mobile",
      mobileAnswerLayout,
    );
    assert(
      mobileAnswerLayout.brandSingleLine
        && mobileAnswerLayout.headerNoOverlap
        && mobileAnswerLayout.headerFits,
      "The mobile Workbench brand wrapped, overlapped authority status, or overflowed the viewport",
      mobileAnswerLayout,
    );
    await evaluate(page, "window.scrollTo(0,document.querySelector('#ask-shell').getBoundingClientRect().top+window.scrollY-70)");
    await assertAskDom(page, "completed mobile", true);
    await screenshot(page, "workbench-ask-summary-mobile.png");
    await evaluate(page, "window.scrollTo(0,document.querySelector('#ask-transcript').getBoundingClientRect().top+window.scrollY-70)");
    await screenshot(page, "workbench-ask-completed-mobile.png");

    const changedCandidate = structuredClone(build.exploration_boundary);
    changedCandidate.pack.name = "changed_reviewed";
    const changedDigest = explorationBoundaryCandidateDigest(changedCandidate);
    await activateExplorationBoundary({
      projectRoot,
      candidate: changedCandidate,
      expectedDigest: changedDigest,
      actor: "second-browser-reviewer@example.test",
      confirmation: `ACTIVATE ${changedDigest}`,
      confirmedDecisions: changedCandidate.unresolved_decisions,
      currentInspection: inspection,
      activeSetMode: "add",
    });
    await typeIntoSelector(page, "#ask-question", "Use the changed boundary without a new acknowledgement.");
    await clickSelector(page, "#run-ask");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('Reviewed access changed')");
    await waitForExpression(page, "document.querySelector('#ask-run-status')?.textContent.includes('Reload Ask')");
    assert(providerRequests === 8, "Changed boundary reached the provider without renewed egress consent");

    await clickSelector(page, "#clear-ask");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.length === 0");
    await waitForExpression(page, "document.querySelector('#ask-chat')?.classList.contains('hidden') === true");
    const browserStorage = await evaluate(page, "({local:localStorage.length,session:sessionStorage.length})");
    assert(
      browserStorage.local === 0 && browserStorage.session === 0,
      "Ask wrote browser storage",
      browserStorage,
    );
  } finally {
    page.close();
  }

  assert(providerRequests === 8, "Expected two complete turns, one cancelled request, and one all-refused turn with a bounded final explanation pass", { providerRequests });
  assert(providerAuthenticationFailures === 1, "Expected one recoverable provider authentication failure", {
    providerAuthenticationFailures,
  });
  assert(toolCalls === 2, "Expected two reviewed Explore tool calls", { toolCalls });
  assert(refusalCalls === 1, "Expected one refused out-of-boundary Explore tool call", { refusalCalls });
  await assertSecretAbsent(projectRoot, sessionKey);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    screenshots,
    provider_requests: providerRequests,
    provider_authentication_failures: providerAuthenticationFailures,
    reviewed_tool_calls: toolCalls,
    refused_tool_calls: refusalCalls,
    source_database_changed: false,
    provider_key_persisted: false,
    browser_storage_entries: 0,
  }, null, 2)}\n`);
} finally {
  await localUi?.close().catch(() => undefined);
  await chrome?.close().catch(() => undefined);
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(chromeProfile, { recursive: true, force: true });
  if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = priorDatabaseUrl;
  if (priorTenant === undefined) delete process.env.SYNAPSOR_TENANT_ID;
  else process.env.SYNAPSOR_TENANT_ID = priorTenant;
}

async function assertAskDom(page, label, completed) {
  const report = await evaluate(page, `(() => {
    const shell=document.querySelector("#ask-shell");
    const controls=[...shell.querySelectorAll("input,select,textarea")];
    return {
      visible:shell.offsetParent!==null,
      horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,
      shellOverflow:shell.scrollWidth>shell.clientWidth+1,
      overflowElements:[...shell.querySelectorAll("*")].filter(node=>node.scrollWidth>node.clientWidth+1).slice(0,12).map(node=>({
        tag:node.tagName,
        id:node.id,
        className:String(node.className||""),
        clientWidth:node.clientWidth,
        scrollWidth:node.scrollWidth,
        text:String(node.textContent||"").trim().slice(0,120),
      })),
      unlabeled:controls.filter(control=>!control.getAttribute("aria-label")&&!control.closest("label")).map(control=>control.id),
      duplicateIds:[...document.querySelectorAll("[id]")].map(node=>node.id).filter((id,index,all)=>all.indexOf(id)!==index),
      disclosure:/approved (?:model-)?visible fields/i.test(shell.textContent)&&/does not relay/i.test(shell.textContent),
	      authority:/activation, approval, (?:and )?apply/i.test(shell.textContent),
	      verifiedAnalysis:/runner verified/i.test(shell.textContent),
      sourceUnchanged:/source database (?:did not change|unchanged|changed: *no)/i.test(shell.textContent),
      analysisNumber:/analysis\\s+[0-9]+/i.test(shell.textContent),
      secretFieldType:document.querySelector("#ask-key")?.type,
    };
  })()`);
  assert(report.visible, `${label}: Ask surface is hidden`, report);
  assert(!report.horizontalOverflow && !report.shellOverflow, `${label}: horizontal overflow`, report);
  assert(report.unlabeled.length === 0, `${label}: unlabeled controls`, report);
  assert(report.duplicateIds.length === 0, `${label}: duplicate IDs`, report);
  assert(report.disclosure, `${label}: direct-egress disclosure missing`, report);
  assert(report.authority, `${label}: operator authority separation missing`, report);
  assert(report.secretFieldType === "password", `${label}: provider key is not masked`, report);
  if (completed) {
    assert(report.verifiedAnalysis, `${label}: verified Runner result is missing`, report);
    assert(!report.sourceUnchanged, `${label}: repetitive source-mutation text is visible`, report);
    assert(!report.analysisNumber, `${label}: internal analysis numbering is visible`, report);
  }
}

async function assertSecretAbsent(directory, secret) {
  const entries = await fs.readdir(directory, { recursive: true });
  const needle = Buffer.from(secret);
  for (const relativePath of entries) {
    const absolutePath = path.join(directory, relativePath);
    const stat = await fs.stat(absolutePath).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat) continue;
    if (stat.isFile() && (await fs.readFile(absolutePath)).includes(needle)) {
      throw new Error(`Provider key was persisted in ${relativePath}`);
    }
  }
}

async function screenshot(page, name) {
  await captureScreenshot(page, path.join(outputRoot, name));
  screenshots.push(name);
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

function askInspection() {
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16 Ask fixture",
    current_user: "app_reader",
    inspected_at: "2026-07-25T00:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    },
    tables: [{
      schema: "public",
      name: "accounts",
      type: "table",
      writable: false,
      columns: [
        column("id", "uuid", { immutable: true }),
        column("tenant_id", "uuid", { tenant: true, immutable: true }),
        column("status", "text"),
        column("region", "text"),
        column("credit_balance_cents", "integer"),
        column("payment_token", "text", { sensitive: true }),
      ],
      primary_key: ["id"],
      unique_constraints: [{ name: "accounts_pkey", columns: ["id"] }],
      foreign_keys: [],
      indexes: [{ name: "accounts_pkey", columns: ["id"], unique: true }],
      row_level_security: true,
      row_level_security_policies: [{
        name: "account_tenant_scope",
        command: "SELECT",
        permissive: true,
        roles: ["app_reader"],
        using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)",
      }],
      role_posture: {
        owner: "app_owner",
        current_role_is_owner: false,
        current_role_can_assume_owner: false,
        privileges: {
          select: true,
          insert: false,
          update: false,
          delete: false,
          truncate: false,
          references: false,
          trigger: false,
        },
        row_security_forced: false,
        row_security_effective_for_current_role: true,
      },
      suggestions: {
        tenant_columns: ["tenant_id"],
        conflict_columns: [],
        sensitive_columns: ["payment_token"],
        default_visible_columns: ["id", "tenant_id", "status", "region", "credit_balance_cents"],
      },
    }, ...[
      "campaigns",
      "invoices",
      "orders",
      "payments",
      "subscriptions",
      "support_tickets",
    ].map(supportingAnalyticsTable)],
  };
}

function supportingAnalyticsTable(name) {
  return {
    schema: "public",
    name,
    type: "table",
    writable: false,
    columns: [
      column("id", "uuid", { immutable: true }),
      column("tenant_id", "uuid", { tenant: true, immutable: true }),
      column("account_id", "uuid", { immutable: true }),
      column("status", "text"),
      column("created_at", "timestamp with time zone"),
    ],
    primary_key: ["id"],
    unique_constraints: [{ name: `${name}_pkey`, columns: ["id"] }],
    foreign_keys: [{
      name: `${name}_account_fkey`,
      columns: ["account_id"],
      referenced_schema: "public",
      referenced_table: "accounts",
      referenced_columns: ["id"],
      nullable: false,
    }],
    indexes: [{ name: `${name}_pkey`, columns: ["id"], unique: true }],
    row_level_security: true,
    row_level_security_policies: [{
      name: `${name}_tenant_scope`,
      command: "SELECT",
      permissive: true,
      roles: ["app_reader"],
      using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)",
    }],
    role_posture: {
      owner: "app_owner",
      current_role_is_owner: false,
      current_role_can_assume_owner: false,
      privileges: {
        select: true,
        insert: false,
        update: false,
        delete: false,
        truncate: false,
        references: false,
        trigger: false,
      },
      row_security_forced: false,
      row_security_effective_for_current_role: true,
    },
    suggestions: {
      tenant_columns: ["tenant_id"],
      conflict_columns: [],
      sensitive_columns: [],
      default_visible_columns: ["id", "tenant_id", "account_id", "status", "created_at"],
    },
  };
}

function column(name, dataType, suggestions = {}) {
  return {
    name,
    data_type: dataType,
    nullable: false,
    generated: false,
    ordinal_position: 1,
    suggestions: {
      tenant: false,
      conflict: false,
      sensitive: false,
      immutable: false,
      large_or_binary: false,
      ...suggestions,
    },
  };
}

function assert(condition, message, details = {}) {
  if (!condition) {
    throw new Error(`${message}\n${JSON.stringify(details, null, 2)}`);
  }
}
