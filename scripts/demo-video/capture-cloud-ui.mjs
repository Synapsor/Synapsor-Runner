import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { captureScreenshot, configurePage, createPage, launchChrome, navigateAndWait, removeDirectoryWithRetries, waitForExpression } from "./cdp-client.mjs";

const privateStatePath = process.env.SYNAPSOR_DEMO_PRIVATE_CLOUD_STATE;
const publicStatePath = process.env.SYNAPSOR_DEMO_CLOUD_PUBLIC_STATE;
const screenshotPath = process.env.SYNAPSOR_DEMO_CLOUD_SCREENSHOT;
const captureStatePath = process.env.SYNAPSOR_DEMO_CLOUD_CAPTURE_STATE;
if (!privateStatePath || !publicStatePath || !screenshotPath || !captureStatePath) {
  throw new Error("Cloud capture environment is incomplete.");
}

const privateState = JSON.parse(await readFile(privateStatePath, "utf8"));
const publicState = JSON.parse(await readFile(publicStatePath, "utf8"));
if (!publicState.complete || !publicState.contract_id) throw new Error("Cloud push/artifact verification is incomplete.");

const profileDir = path.join(path.dirname(privateStatePath), "chrome-profile");
await mkdir(path.dirname(screenshotPath), { recursive: true, mode: 0o700 });
const chrome = await launchChrome({ userDataDir: profileDir, width: 1600, height: 1000 });

try {
  const page = await createPage(chrome.port);
  await configurePage(page, 1600, 1000);
  const host = new URL(privateState.base_url).hostname;
  const cookie = await page.send("Network.setCookie", {
    name: "synapsor_session",
    value: privateState.session_token,
    domain: host,
    path: "/v1/control",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  if (cookie.success !== true) throw new Error("Chrome rejected the HttpOnly demo session cookie.");

  const registryUrl = `${privateState.base_url}/workspace/contracts?contract=${encodeURIComponent(publicState.contract_id)}`;
  await navigateAndWait(page, registryUrl, 45_000);
  await waitForExpression(page, `document.body.innerText.includes("support-plan-credit") && document.body.innerText.includes("Download bundle") && document.body.innerText.includes("card_token") && document.body.innerText.includes("private_notes") && !document.body.innerText.includes("Loading contract version...")`, 45_000);

  await page.send("Runtime.evaluate", {
    expression: `(() => {
      document.querySelectorAll('[aria-label="Open navigation"], .console-toast').forEach((node) => node.remove());
      window.scrollTo(0, 0);
      return true;
    })()`,
    returnByValue: true,
  });
  await captureScreenshot(page, screenshotPath, { format: "png" });

  const visible = await page.send("Runtime.evaluate", {
    expression: `({
      title: document.title,
      hasContract: document.body.innerText.includes("support-plan-credit"),
      hasBundle: document.body.innerText.includes("Download bundle"),
      hasKeptOut: document.body.innerText.includes("card_token") && document.body.innerText.includes("private_notes"),
      hasRawSql: document.body.innerText.includes("execute_sql(sql")
    })`,
    returnByValue: true,
  });
  const state = visible.result?.value ?? {};
  if (!state.hasContract || !state.hasBundle || !state.hasKeptOut || state.hasRawSql) {
    throw new Error(`Cloud UI did not show the expected safe registry state: ${JSON.stringify(state)}`);
  }
  await writeFile(captureStatePath, `${JSON.stringify({ ok: true, ...state, registry_url: registryUrl }, null, 2)}\n`, { mode: 0o600 });
  page.close();
  console.log(`Captured real Cloud registry UI: ${screenshotPath}`);
} finally {
  await chrome.close();
  await removeDirectoryWithRetries(profileDir);
}
