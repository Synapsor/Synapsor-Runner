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
  configurePage,
  createPage,
  launchChrome,
  navigateAndWait,
  waitForExpression,
} from "./demo-video/cdp-client.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-workbench-visual-"));
const outputRoot = path.resolve(
  process.env.SYNAPSOR_WORKBENCH_VISUAL_OUTPUT
    ?? path.join(root, "development", "runner-1.6.3-visual"),
);
const chromeProfile = path.join(projectRoot, "chrome-profile");
const screenshots = [];
let localUi;
let chrome;

try {
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
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
    runnerVersion: "1.6.3",
  });
  seedVisualAttention(guided.store_path);
  await fs.writeFile(
    path.join(projectRoot, ".synapsor", "explore-audit.key"),
    crypto.randomBytes(32).toString("base64url"),
    { encoding: "utf8", mode: 0o600 },
  );

  localUi = await startLocalUiServer({
    projectRoot,
    boundaryRoot: written.root,
    configPath: guided.config_path,
    storePath: guided.store_path,
    token: "visual-bootstrap-token",
    csrfToken: "visual-csrf-token",
    schemaInspector: async () => inspection,
  });
  chrome = await launchChrome({ userDataDir: chromeProfile, width: 1440, height: 1100 });
  const page = await createPage(chrome.port);
  try {
    await configurePage(page, 1440, 1100);
    await navigateAndWait(page, localUi.url);
    await waitForExpression(page, "document.querySelector('#header-state')?.textContent !== 'Loading'");
    await waitForExpression(page, "document.querySelectorAll('.resource').length === 40");
    await assertWorkbenchDom(page, "desktop overview", {
      expectedView: "overview",
      expectedResources: 40,
    });
    await screenshot(page, "workbench-overview-desktop-light.png");

    await evaluate(page, `(() => {
      document.querySelector("#header-state").textContent="Loading deterministic schema evidence";
      document.querySelector("#journey-state").innerHTML="<div><strong>Database connected.</strong><p>Agent authority: none. Source database changed: no.</p></div><span>Next: Review what the agent can see.</span>";
      document.querySelector("#resources").setAttribute("aria-busy","true");
    })()`);
    await screenshot(page, "workbench-loading-partial.png");
    await evaluate(page, `(() => {
      document.querySelector("#resources").removeAttribute("aria-busy");
      document.querySelector("#header-state").textContent="Disabled · review required";
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

    await evaluate(page, `(() => {
      const blocked=[...document.querySelectorAll(".resource")].find(resource=>resource.textContent.includes("Blocked"));
      blocked?.querySelector("[data-open-resource]")?.click();
    })()`);
    await waitForExpression(page, "document.querySelector('#view-exceptions')?.classList.contains('active') === true");
    await waitForExpression(page, "document.querySelector('#resource-detail')?.textContent.includes('Blocked') === true");
    await assertWorkbenchDom(page, "blocked exception", { expectedView: "exceptions" });
    await screenshot(page, "workbench-blocked-identity.png");

    await evaluate(page, `(() => {
      document.querySelector('[data-view="activate"]').click();
      document.querySelector("#actor").focus();
      document.querySelector("#message").textContent="Schema changed after review. Your disabled draft and completed decisions were preserved. Next: rescan and review the semantic diff.";
      document.querySelector("#message").className="status-message error";
    })()`);
    await waitForExpression(page, "document.querySelector('#view-activate')?.classList.contains('active') === true");
    const focus = await evaluate(page, "({tag:document.activeElement?.tagName,id:document.activeElement?.id})");
    assert(focus.id === "actor", "keyboard focus did not reach the operator identity control", focus);
    await assertWorkbenchDom(page, "keyboard stale failure", { expectedView: "activate" });
    await screenshot(page, "workbench-keyboard-stale-failure.png");

    await evaluate(page, `document.querySelector('[data-view="explore"]').click()`);
    await waitForExpression(page, "document.querySelector('#view-explore')?.classList.contains('active') === true");
    await evaluate(page, `document.querySelector("#run-preflight")?.click()`);
    await waitForExpression(page, "document.querySelector('#explore-preflight')?.textContent.includes('blocked') === true || document.querySelector('#explore-preflight')?.textContent.includes('unavailable') === true || document.querySelector('#explore-preflight')?.textContent.includes('active') === true");
    await assertWorkbenchDom(page, "explore blocked", { expectedView: "explore" });
    await screenshot(page, "workbench-explore-blocked.png");

    await evaluate(page, `document.querySelector('[data-view="protect"]').click()`);
    await waitForExpression(page, "document.querySelector('#view-protect')?.classList.contains('active') === true");
    await waitForExpression(page, "document.querySelector('#protect-queries')?.textContent.length > 0");
    await assertWorkbenchDom(page, "protect empty", { expectedView: "protect" });
    await screenshot(page, "workbench-protect-empty.png");

    await evaluate(page, `document.querySelector('[data-view="action"]').click()`);
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
    await evaluate(page, `document.querySelector('[data-view="overview"]').click();window.scrollTo(0,0)`);
    await waitForExpression(page, "document.querySelector('#view-overview')?.classList.contains('active') === true");
    await assertWorkbenchDom(page, "mobile overview", {
      expectedView: "overview",
      expectedResources: 40,
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
      await evaluate(page, `(() => {
        const select=document.querySelector('#attention select[aria-label="Human attention status"]');
        select.value=${JSON.stringify(status)};
        select.dispatchEvent(new Event("change"));
      })()`);
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
    await evaluate(page, `(() => {
      const select=document.querySelector('#attention select[aria-label="Human attention status"]');
      select.value="open";
      select.dispatchEvent(new Event("change"));
      window.scrollTo(0, document.querySelector("#attention").offsetTop);
    })()`);
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
    const controls=[...document.querySelectorAll("input,select,textarea")];
    const unlabeled=controls
      .filter(control=>!control.getAttribute("aria-label")&&!control.closest("label"))
      .map(control=>(control.outerHTML||control.id||control.type).slice(0,240));
    const ids=[...document.querySelectorAll("[id]")].map(node=>node.id);
    const duplicates=ids.filter((id,index)=>ids.indexOf(id)!==index);
    const visibleView=[...document.querySelectorAll(".view")].find(node=>node.classList.contains("active"));
    const primary=[...visibleView.querySelectorAll("button")]
      .filter(button=>!button.disabled&&!button.classList.contains("secondary")&&!button.classList.contains("quiet")&&!button.classList.contains("danger"))
      .filter(button=>button.offsetParent!==null)
      .map(button=>button.textContent.trim());
    return {
      title:document.title,
      header:Boolean(document.querySelector("header")),
      main:Boolean(document.querySelector("main")),
      steps:document.querySelectorAll(".step").length,
      visibleView:visibleView?.id,
      horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,
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
  assert(report.steps === 6, `${label}: six-step journey is missing`, report);
  assert(report.visibleView === `view-${options.expectedView}`, `${label}: wrong visible journey step`, report);
  assert(report.horizontalOverflow === false, `${label}: horizontal overflow`, report);
  assert(report.unlabeled.length === 0, `${label}: unlabeled form controls`, report);
  assert(report.duplicates.length === 0, `${label}: duplicate element IDs`, report);
  assert(report.primary.length <= 1, `${label}: more than one visually primary next action`, report);
  if (options.expectedResources !== undefined) {
    assert(report.resources === options.expectedResources, `${label}: resource catalog size changed`, report);
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
  assert(report.title === "Synapsor Runner Local UI", `${label}: wrong activity page title`, report);
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
        ],
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
    column("status", "text"),
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
    foreign_keys: [],
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
