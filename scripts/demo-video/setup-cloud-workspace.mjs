import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const adminToken = String(process.env.SYNAPSOR_DEMO_ADMIN_TOKEN ?? "").trim();
const baseUrl = String(process.env.SYNAPSOR_DEMO_CLOUD_BASE_URL ?? "https://dev-console.synapsor.ai").replace(/\/+$/, "");
const privateStatePath = String(process.env.SYNAPSOR_DEMO_PRIVATE_CLOUD_STATE ?? "").trim();
const publicStatePath = String(process.env.SYNAPSOR_DEMO_CLOUD_PUBLIC_STATE ?? "").trim();

if (!adminToken) throw new Error("SYNAPSOR_DEMO_ADMIN_TOKEN is required.");
if (!privateStatePath || !publicStatePath) throw new Error("Cloud state output paths are required.");
if (baseUrl !== "https://dev-console.synapsor.ai") {
  throw new Error(`Refusing unapproved Cloud base URL: ${baseUrl}`);
}

const suffix = `${new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 12)}${randomBytes(3).toString("hex")}`.toLowerCase();
const email = `synapsor-demo-video-${suffix}@example.com`;
const password = `Demo-${randomBytes(18).toString("base64url")}`;
const projectId = `synapsor_demo_video_${suffix}`;
const projectName = "Synapsor Demo Video Lab";

async function request(route, { token, body, method = "POST" } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(`${method} ${route} failed with HTTP ${response.status}: ${payload.error ?? "unknown_error"}`);
  }
  return payload;
}

const invited = await request("/v1/control/invites", {
  token: adminToken,
  body: { email, name: "Demo Reviewer", plan: "free", project_name: projectName, actor: "demo-video-harness" },
});
if (!invited.token) throw new Error("Cloud invite did not return an acceptance token.");

const accepted = await request("/v1/control/invites/accept", {
  body: { token: invited.token, name: "Demo Reviewer", password, confirm_password: password },
});
if (!accepted.session_token || !accepted.account?.account_id) {
  throw new Error("Cloud invite acceptance did not return a developer session.");
}

await request("/v1/control/projects", {
  token: accepted.session_token,
  body: {
    project_id: projectId,
    name: projectName,
    plan: "free",
    idempotency_key: `demo-video-project-${suffix}`,
  },
});

const privateState = {
  schema_version: "synapsor.demo-video-cloud-private.v1",
  base_url: baseUrl,
  account_id: accepted.account.account_id,
  email,
  password,
  project_id: projectId,
  project_name: projectName,
  session_token: accepted.session_token,
  created_at: new Date().toISOString(),
};
const publicState = {
  schema_version: "synapsor.demo-video-cloud-public.v1",
  complete: false,
  base_url: baseUrl,
  project_id: projectId,
  project_name: projectName,
  account_label: "Demo Reviewer",
  created_at: privateState.created_at,
};

await mkdir(path.dirname(privateStatePath), { recursive: true, mode: 0o700 });
await writeFile(privateStatePath, `${JSON.stringify(privateState, null, 2)}\n`, { mode: 0o600 });
await writeFile(publicStatePath, `${JSON.stringify(publicState, null, 2)}\n`, { mode: 0o600 });

console.log(`Created disposable Cloud workspace ${projectId}.`);
console.log("Credentials were written only to the ignored private demo state.");
