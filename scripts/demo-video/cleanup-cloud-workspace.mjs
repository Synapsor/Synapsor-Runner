import { readFile, rm } from "node:fs/promises";

const adminToken = String(process.env.SYNAPSOR_DEMO_ADMIN_TOKEN ?? "").trim();
const privateStatePath = String(process.env.SYNAPSOR_DEMO_PRIVATE_CLOUD_STATE ?? "").trim();
if (!adminToken) throw new Error("SYNAPSOR_DEMO_ADMIN_TOKEN is required for account cleanup.");
if (!privateStatePath) throw new Error("SYNAPSOR_DEMO_PRIVATE_CLOUD_STATE is required.");

const state = JSON.parse(await readFile(privateStatePath, "utf8"));
let lastFailure = "unknown_error";
let deleted = false;
for (let attempt = 1; attempt <= 6; attempt += 1) {
  try {
    const response = await fetch(`${state.base_url}/v1/control/accounts/${encodeURIComponent(state.account_id)}/delete`, {
      method: "POST",
      headers: { Authorization: `Bearer ${adminToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        confirm_account_email: state.email,
        force: true,
        external_billing_ack: true,
        actor: "demo-video-harness-cleanup",
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (response.ok && payload.ok !== false) {
      deleted = true;
      break;
    }
    lastFailure = `HTTP ${response.status}: ${payload.error ?? "unknown_error"}`;
    if (![502, 503, 504].includes(response.status)) break;
  } catch (error) {
    lastFailure = error instanceof Error ? error.message : String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
}
if (!deleted) throw new Error(`Cloud cleanup failed after bounded retries: ${lastFailure}`);

await rm(privateStatePath, { force: true });
console.log(`Deleted disposable Cloud account ${state.account_id} and its projects.`);
