import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const privateStatePath = process.env.SYNAPSOR_DEMO_PRIVATE_CLOUD_STATE;
const pushResponsePath = process.env.SYNAPSOR_DEMO_CLOUD_PUSH_RESPONSE;
const publicStatePath = process.env.SYNAPSOR_DEMO_CLOUD_PUBLIC_STATE;
const bundlePath = process.env.SYNAPSOR_DEMO_CLOUD_BUNDLE;
const contractPath = process.env.SYNAPSOR_DEMO_CONTRACT;
if (!privateStatePath || !pushResponsePath || !publicStatePath || !bundlePath || !contractPath) {
  throw new Error("Cloud artifact environment is incomplete.");
}

const state = JSON.parse(await readFile(privateStatePath, "utf8"));
const pushed = JSON.parse(await readFile(pushResponsePath, "utf8"));
const contractId = pushed.contract_id;
const versionId = pushed.contract_version_id;
if (!contractId || !versionId || !pushed.digest) throw new Error("Cloud push response is missing contract/version/digest.");

async function get(route, binary = false) {
  const response = await fetch(`${state.base_url}${route}`, {
    headers: { Authorization: `Bearer ${state.session_token}` },
  });
  if (!response.ok) throw new Error(`Cloud GET ${route} failed with HTTP ${response.status}`);
  return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
}

const baseRoute = `/v1/control/projects/${encodeURIComponent(state.project_id)}/agent-contracts/${encodeURIComponent(contractId)}/versions/${encodeURIComponent(versionId)}`;
const versionPayload = await get(baseRoute);
const bundle = await get(`${baseRoute}/runner-bundle?download=1`, true);
if (bundle.length < 4 || bundle.subarray(0, 2).toString("hex") !== "504b") throw new Error("Runner bundle is not a ZIP file.");

await mkdir(path.dirname(bundlePath), { recursive: true, mode: 0o700 });
await writeFile(bundlePath, bundle, { mode: 0o600 });

const entries = execFileSync("unzip", ["-Z1", bundlePath], { encoding: "utf8" })
  .split(/\r?\n/)
  .map((entry) => entry.trim())
  .filter(Boolean);
const requiredEntries = [
  "synapsor.contract.json",
  "synapsor.runner.json",
  ".env.example",
  "README.md",
  "mcp-client-examples/claude-desktop.json",
  "mcp-client-examples/openai-agents-streamable-http.ts",
];
for (const entry of requiredEntries) {
  if (!entries.includes(entry)) throw new Error(`Runner bundle is missing ${entry}`);
}

const extractedText = entries
  .filter((entry) => /(?:\.json|\.md|\.ts|\.example)$/.test(entry))
  .map((entry) => execFileSync("unzip", ["-p", bundlePath, entry], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }))
  .join("\n");
const secretPatterns = [
  /(?:postgres(?:ql)?|mysql):\/\/[^\s"']+:[^\s"']+@/i,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bsyn_(?:sess|ops|inv)_[A-Za-z0-9_-]+\b/,
  /Authorization:\s*Bearer\s+(?!<)[A-Za-z0-9._~+/=-]{12,}/i,
];
if (secretPatterns.some((pattern) => pattern.test(extractedText))) throw new Error("Runner bundle contains a secret-like value.");

const version = versionPayload.version ?? versionPayload;
const sortCanonical = (value) => {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortCanonical(value[key])]));
  }
  return value;
};
const localContract = JSON.parse(await readFile(contractPath, "utf8"));
const cloudContract = version.contract;
if (!cloudContract || JSON.stringify(sortCanonical(cloudContract)) !== JSON.stringify(sortCanonical(localContract))) {
  throw new Error("Cloud registry contract does not match the local canonical contract.");
}
const computedDigest = `sha256:${createHash("sha256").update(JSON.stringify(sortCanonical(localContract))).digest("hex")}`;
if (computedDigest !== pushed.digest || computedDigest !== version.digest) {
  throw new Error("Cloud registry digest does not match the canonical local contract digest.");
}
const publicState = {
  schema_version: "synapsor.demo-video-cloud-public.v1",
  complete: true,
  base_url: state.base_url,
  project_id: state.project_id,
  project_name: state.project_name,
  account_label: "Demo Reviewer",
  contract_id: contractId,
  contract_version_id: versionId,
  version_number: pushed.version_number ?? version.version_number,
  digest: pushed.digest,
  local_contract_digest: computedDigest,
  exact_contract_match: true,
  status: pushed.status ?? version.status,
  registry_url: pushed.registry_url,
  summary: version.summary ?? {},
  bundle: {
    size_bytes: bundle.length,
    entries,
    required_entries_present: true,
    secret_scan: "clean",
  },
  captured_at: new Date().toISOString(),
};
await writeFile(publicStatePath, `${JSON.stringify(publicState, null, 2)}\n`, { mode: 0o600 });
console.log(`Verified Cloud contract ${contractId} version ${publicState.version_number}.`);
console.log(`Verified secret-free Runner bundle with ${entries.length} files.`);
