import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildAutoBoundary,
  writeAutoBoundaryArtifacts,
} from "../apps/runner/dist/auto-boundary.js";
import { startLocalUiServer } from "../apps/runner/dist/local-ui.js";
import { parseSchemaCandidateSource } from "../apps/runner/dist/schema-candidates.js";
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
    ?? path.join(root, "development", "runner-1.6.0-visual"),
);
const chromeProfile = path.join(projectRoot, "chrome-profile");
let localUi;
let chrome;

try {
  await fs.rm(outputRoot, { recursive: true, force: true });
  await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const openApiPath = path.join(root, "fixtures", "generators", "openapi", "openapi.yaml");
  const openApi = parseSchemaCandidateSource(
    "openapi",
    await fs.readFile(openApiPath, "utf8"),
    openApiPath,
  );
  const build = buildAutoBoundary({
    inspection: visualInspection(),
    project: {
      root: projectRoot,
      package_manager: "pnpm",
      frameworks: ["nextjs", "prisma"],
      schema_inputs: [{ kind: "openapi", path: openApiPath }],
      database_env_names: ["DATABASE_URL"],
    },
    parsedEvidence: [openApi],
    sourceEnv: "DATABASE_URL",
  });
  const written = await writeAutoBoundaryArtifacts({ projectRoot, build });
  const stateDir = path.join(projectRoot, ".synapsor");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(stateDir, "explore-audit.key"),
    crypto.randomBytes(32).toString("base64url"),
    { encoding: "utf8", mode: 0o600 },
  );
  const configPath = path.join(projectRoot, "synapsor.runner.json");
  await fs.writeFile(configPath, `${JSON.stringify({
    version: 1,
    mode: "read_only",
    storage: { sqlite_path: "./.synapsor/local.db" },
    contracts: [],
    sources: {},
  }, null, 2)}\n`, "utf8");

  localUi = await startLocalUiServer({
    projectRoot,
    boundaryRoot: written.root,
    configPath,
    storePath: path.join(stateDir, "local.db"),
    token: "visual-bootstrap-token",
    csrfToken: "visual-csrf-token",
  });
  chrome = await launchChrome({ userDataDir: chromeProfile, width: 1440, height: 1000 });
  const page = await createPage(chrome.port);
  try {
    await configurePage(page, 1440, 1000);
    await navigateAndWait(page, localUi.url);
    await waitForExpression(page, "document.querySelector('#state')?.textContent.includes('Disabled') === true");
    await waitForExpression(page, "document.querySelectorAll('.resource').length > 0");
    await waitForExpression(page, "document.querySelector('#protect-message')?.textContent.length > 0");
    await assertWorkbenchDom(page, "desktop light");
    await captureScreenshot(page, path.join(outputRoot, "workbench-desktop-light.png"));

    await page.send("Runtime.evaluate", {
      expression: `document.querySelector("#state").textContent="Loading review";
        document.querySelector("#message").textContent="Loading deterministic schema evidence…";
        document.querySelector("#message").className="";`,
    });
    await captureScreenshot(page, path.join(outputRoot, "workbench-loading.png"));
    await page.send("Runtime.evaluate", {
      expression: `document.querySelector("#state").textContent="Disabled · review required";
        document.querySelector("#message").textContent="";`,
    });

    await page.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-color-scheme", value: "dark" }],
    });
    await captureScreenshot(page, path.join(outputRoot, "workbench-desktop-dark.png"));
    await page.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [{ name: "prefers-color-scheme", value: "light" }],
    });

    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 390,
      screenHeight: 844,
    });
    await page.send("Runtime.evaluate", { expression: "window.scrollTo(0, 0)" });
    await assertWorkbenchDom(page, "mobile light");
    await captureScreenshot(page, path.join(outputRoot, "workbench-mobile-light.png"));

    await page.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: 1440,
      screenHeight: 1000,
    });
    await page.send("Runtime.evaluate", {
      expression: `document.querySelector("#protect-message").textContent="No recent query is ready yet.";
        document.querySelector("#protect-message").className="";
        document.querySelector("#protect-queries").scrollIntoView({block:"center"});`,
    });
    await captureScreenshot(page, path.join(outputRoot, "workbench-protect-empty.png"));

    await page.send("Runtime.evaluate", {
      expression: `document.querySelector("#message").textContent="Schema changed after review. Regenerate and inspect the semantic diff.";
        document.querySelector("#message").className="error";
        document.querySelector("#actor").focus();
        document.querySelector(".actions").scrollIntoView({block:"center"});`,
    });
    const focus = await evaluate(page, "({tag:document.activeElement?.tagName,id:document.activeElement?.id})");
    assert(focus.id === "actor", "keyboard focus did not reach the operator identity control", focus);
    await captureScreenshot(page, path.join(outputRoot, "workbench-keyboard-failure.png"));
  } finally {
    page.close();
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    output: outputRoot,
    screenshots: [
      "workbench-desktop-light.png",
      "workbench-loading.png",
      "workbench-desktop-dark.png",
      "workbench-mobile-light.png",
      "workbench-protect-empty.png",
      "workbench-keyboard-failure.png",
    ],
    states: ["desktop", "narrow", "light", "dark", "keyboard", "loading", "empty", "failure", "partial-generation"],
  }, null, 2)}\n`);
} finally {
  await localUi?.close().catch(() => undefined);
  await chrome?.close().catch(() => undefined);
  await fs.rm(projectRoot, { recursive: true, force: true });
}

async function assertWorkbenchDom(page, label) {
  const report = await evaluate(page, `(() => {
    const controls=[...document.querySelectorAll("input,select,textarea")];
    const unlabeled=controls.filter(control=>!control.getAttribute("aria-label")&&!control.closest("label")).map(control=>control.id||control.type);
    const ids=[...document.querySelectorAll("[id]")].map(node=>node.id);
    const duplicates=ids.filter((id,index)=>ids.indexOf(id)!==index);
    const overflowers=[...document.querySelectorAll("body *")]
      .filter(node=>node.getBoundingClientRect().right>document.documentElement.clientWidth+1||node.scrollWidth>node.clientWidth+1)
      .slice(0,10)
      .map(node=>({tag:node.tagName,id:node.id,className:String(node.className||""),clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,right:Math.round(node.getBoundingClientRect().right)}));
    return {
      title:document.title,
      header:Boolean(document.querySelector("header")),
      main:Boolean(document.querySelector("main")),
      horizontalOverflow:document.documentElement.scrollWidth>document.documentElement.clientWidth+1,
      unlabeled,
      duplicates,
      overflowers,
      blockedText:document.querySelector("#blocked")?.textContent||"",
      profile:document.querySelector("#deployment-profile")?.value,
      state:document.querySelector("#state")?.textContent,
      protectText:document.querySelector("#protect-queries")?.textContent||"",
    };
  })()`);
  assert(report.title === "Auto Boundary Review | Synapsor Runner", `${label}: wrong page title`, report);
  assert(report.header && report.main, `${label}: missing page landmarks`, report);
  assert(report.horizontalOverflow === false, `${label}: horizontal overflow`, report);
  assert(report.unlabeled.length === 0, `${label}: unlabeled form controls`, report);
  assert(report.duplicates.length === 0, `${label}: duplicate element IDs`, report);
  assert(report.profile === "staging", `${label}: explicit profile selector is missing`, report);
  assert(/blocked|scope|No blocked/i.test(report.blockedText), `${label}: blocked-object state is not visible`, report);
  assert(/No unexpired query|No recent query/i.test(report.protectText), `${label}: empty Protect state is not visible`, report);
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
    inspected_at: "2026-07-22T00:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    tables: [
      table("subscriptions", true),
      table("customer_notes", false),
    ],
  };
}

function table(name, scoped) {
  return {
    schema: "public",
    name,
    type: "table",
    writable: false,
    columns: [
      column("id", "uuid", { immutable: true }),
      ...(scoped ? [column("tenant_id", "uuid", { tenant: true, immutable: true })] : []),
      column("region", "text"),
      column("status", "text"),
      column("created_at", "timestamp with time zone"),
      column("monthly_revenue_cents", "integer"),
      column("secret_token", "text", { sensitive: true }),
    ],
    primary_key: ["id"],
    unique_constraints: [{ name: `${name}_pkey`, columns: ["id"] }],
    foreign_keys: [],
    indexes: [{ name: `${name}_pkey`, columns: ["id"], unique: true }],
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
      sensitive_columns: ["secret_token"],
      default_visible_columns: [
        "id",
        ...(scoped ? ["tenant_id"] : []),
        "region",
        "status",
        "created_at",
        "monthly_revenue_cents",
      ],
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
