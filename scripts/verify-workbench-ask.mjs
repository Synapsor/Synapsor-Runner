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
import { startLocalUiServer } from "../apps/runner/dist/local-ui.js";
import { AskError } from "../apps/runner/dist/model-ask.js";
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
    ?? path.join(root, "development", "runner-1.6.4-ask-visual"),
);
const sessionKey = "sk-workbench-browser-canary-never-persist";
const screenshots = [];
let localUi;
let chrome;
let providerRequests = 0;
let toolCalls = 0;

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
    runnerVersion: "1.6.4",
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

  const tool = {
    name: "billing.propose_account_credit",
    title: "Propose account credit",
    description: "Creates one bounded account-credit proposal without changing the source database.",
    input_schema: {
      type: "object",
      properties: {
        account_id: { type: "string", maxLength: 128 },
        amount_cents: { type: "integer", minimum: 1, maximum: 2500 },
      },
      required: ["account_id", "amount_cents"],
      additionalProperties: false,
    },
    metadata: {
      "synapsor.kind": "proposal",
      "synapsor.approval_tool": false,
      "synapsor.commit_tool": false,
    },
  };
  localUi = await startLocalUiServer({
    projectRoot,
    boundaryRoot: written.root,
    configPath: guided.config_path,
    storePath: guided.store_path,
    token: "ask-browser-token",
    csrfToken: "ask-browser-csrf",
    deploymentProfile: "staging",
    schemaInspector: async () => inspection,
    askGatewayFactory: async () => ({
      listTools: async () => [tool],
      callTool: async (name, args) => {
        assert(name === tool.name, "Ask called a tool outside the reviewed surface", { name });
        assert(
          JSON.stringify(args) === JSON.stringify({ account_id: "ACC-104", amount_cents: 1500 }),
          "Ask changed the bounded provider arguments",
          { args },
        );
        toolCalls += 1;
        return {
          ok: true,
          value: {
            ok: true,
            proposal_id: "wrp_browser_ask",
            state: "pending_review",
            source_database_changed: false,
          },
        };
      },
      close: async () => undefined,
    }),
    askProviderDependencies: {
      requestJson: async (input) => {
        providerRequests += 1;
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
        await new Promise((resolve) => setTimeout(resolve, 80));
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
                      name: "billing__propose_account_credit",
                      arguments: JSON.stringify({
                        account_id: "ACC-104",
                        amount_cents: 1500,
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
                content: "I created a bounded proposal for operator review. The database has not changed.",
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
    await clickSelector(page, '[data-view="explore"]');
    await waitForExpression(page, "document.querySelector('#ask-shell')?.offsetParent !== null");
    await waitForExpression(page, "document.querySelector('#ask-authority-summary')?.textContent.includes('1 reviewed tool')");
    await assertAskDom(page, "unconfigured desktop", false);

    await selectOptionByValue(page, "#ask-provider", "anthropic");
    await waitForExpression(page, "document.querySelector('#ask-model')?.value.includes('claude')");
    await selectOptionByValue(page, "#ask-provider", "openai_compatible");
    await waitForExpression(page, "document.querySelector('#ask-base-url-wrap')?.classList.contains('hidden') === false");
    await selectOptionByValue(page, "#ask-provider", "openai");
    await waitForExpression(page, "document.querySelector('#ask-base-url-wrap')?.classList.contains('hidden') === true");
    await typeIntoSelector(page, "#ask-key", sessionKey);
    await clickSelector(page, "#configure-ask");
    await waitForExpression(page, "document.querySelector('#ask-config-status')?.textContent.includes('Acknowledge')");
    const requestsBeforeConsent = providerRequests;
    assert(requestsBeforeConsent === 0, "Provider was contacted before egress acknowledgement");
    await typeIntoSelector(page, "#ask-key", sessionKey);
    await evaluate(page, "document.querySelector('#ask-egress').click()");
    await clickSelector(page, "#configure-ask");
    await waitForExpression(page, "document.querySelector('#ask-chat')?.offsetParent !== null");
    await waitForExpression(page, "document.querySelector('#ask-provider-state')?.textContent.includes('ready')");
    const keyAfterConfigure = await evaluate(page, "document.querySelector('#ask-key').value");
    assert(keyAfterConfigure === "", "Pasted provider key remained in the browser field");
    const bodyContainsSecret = await evaluate(page, `document.body.textContent.includes(${JSON.stringify(sessionKey)})`);
    assert(bodyContainsSecret === false, "Pasted provider key appeared in rendered Workbench text");

    await typeIntoSelector(page, "#ask-question", "Propose a $15 credit for account ACC-104.");
    await clickSelector(page, "#run-ask");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('Proposal only')");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('wrp_browser_ask')");
    await assertAskDom(page, "completed desktop", true);

    await typeIntoSelector(page, "#ask-question", "Cancel this model request.");
    await clickSelector(page, "#run-ask");
    await waitForExpression(page, "document.querySelector('#cancel-ask')?.disabled === false");
    await clickSelector(page, "#cancel-ask");
    await waitForExpression(page, "document.querySelector('#ask-transcript')?.textContent.includes('Request refused safely')");
    await typeIntoSelector(page, "#ask-question", "Retry the reviewed credit proposal.");
    await clickSelector(page, "#run-ask");
    await waitForExpression(page, "document.querySelectorAll('#ask-transcript .ask-turn.answer').length === 2");
    await evaluate(page, "window.scrollTo(0,document.querySelector('#ask-shell').getBoundingClientRect().top+window.scrollY-76)");
    await screenshot(page, "workbench-ask-completed-desktop.png");

    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await evaluate(page, "window.scrollTo(0,document.querySelector('#ask-shell').getBoundingClientRect().top+window.scrollY-70)");
    await assertAskDom(page, "completed mobile", true);
    await screenshot(page, "workbench-ask-summary-mobile.png");
    await evaluate(page, "window.scrollTo(0,document.querySelector('#ask-transcript').getBoundingClientRect().top+window.scrollY-70)");
    await screenshot(page, "workbench-ask-completed-mobile.png");

    const activePath = path.join(projectRoot, ".synapsor", "exploration-boundary.active.json");
    const changedBoundary = JSON.parse(await fs.readFile(activePath, "utf8"));
    changedBoundary.activation.digest = `sha256:${"b".repeat(64)}`;
    await fs.writeFile(activePath, `${JSON.stringify(changedBoundary, null, 2)}\n`, "utf8");
    await typeIntoSelector(page, "#ask-question", "Use the changed boundary without a new acknowledgement.");
    await clickSelector(page, "#run-ask");
    await waitForExpression(page, "document.querySelector('#ask-run-status')?.textContent.includes('reviewed tool surface changed')");
    assert(providerRequests === 5, "Changed boundary reached the provider without renewed egress consent");

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

  assert(providerRequests === 5, "Expected two complete provider turns and one cancelled request", { providerRequests });
  assert(toolCalls === 2, "Expected two reviewed proposal tool calls", { toolCalls });
  await assertSecretAbsent(projectRoot, sessionKey);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    screenshots,
    provider_requests: providerRequests,
    reviewed_tool_calls: toolCalls,
    source_database_changed: false,
    provider_key_persisted: false,
    browser_storage_entries: 0,
  }, null, 2)}\n`);
} finally {
  await localUi?.close().catch(() => undefined);
  await chrome?.close().catch(() => undefined);
  await fs.rm(projectRoot, { recursive: true, force: true });
  await fs.rm(chromeProfile, { recursive: true, force: true });
}

async function assertAskDom(page, label, completed) {
  const report = await evaluate(page, `(() => {
    const shell=document.querySelector("#ask-shell");
    const controls=[...shell.querySelectorAll("input,select,textarea")];
    return {
      visible:shell.offsetParent!==null,
      horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,
      shellOverflow:shell.scrollWidth>shell.clientWidth+1,
      unlabeled:controls.filter(control=>!control.getAttribute("aria-label")&&!control.closest("label")).map(control=>control.id),
      duplicateIds:[...document.querySelectorAll("[id]")].map(node=>node.id).filter((id,index,all)=>all.indexOf(id)!==index),
      disclosure:/approved visible fields/i.test(shell.textContent)&&/does not relay/i.test(shell.textContent),
      authority:/activation, approval, apply/i.test(shell.textContent),
      proposalOnly:/proposal only/i.test(shell.textContent),
      sourceUnchanged:/source database (?:did not change|unchanged)/i.test(shell.textContent),
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
    assert(report.proposalOnly, `${label}: proposal-only result message missing`, report);
    assert(report.sourceUnchanged, `${label}: source mutation status missing`, report);
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
    }],
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
