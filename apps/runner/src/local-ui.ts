import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { validateRunnerCapabilityConfig } from "@synapsor-runner/config";
import { ProposalStore, type LocalProposalState, type StoredProposal } from "@synapsor-runner/proposal-store";

type JsonRecord = Record<string, unknown>;

export type LocalUiOptions = {
  configPath?: string;
  storePath?: string;
  host?: string;
  port?: number;
  token?: string;
  csrfToken?: string;
  allowRemoteBind?: boolean;
};

export type LocalUiServer = {
  server: Server;
  url: string;
  host: string;
  port: number;
  token: string;
  csrfToken: string;
  close: () => Promise<void>;
};

export async function startLocalUiServer(options: LocalUiOptions = {}): Promise<LocalUiServer> {
  const host = options.host ?? "127.0.0.1";
  if (!isLocalHost(host) && options.allowRemoteBind !== true) {
    throw new Error("synapsor ui binds to localhost by default. Use --allow-remote-bind only for an intentional trusted local-network demo.");
  }
  const configPath = path.resolve(options.configPath ?? "synapsor.runner.json");
  const storePath = path.resolve(options.storePath ?? "./.synapsor/local.db");
  const token = options.token ?? crypto.randomBytes(24).toString("base64url");
  const csrfToken = options.csrfToken ?? crypto.randomBytes(24).toString("base64url");

  const server = createServer(async (request, response) => {
    try {
      await handleRequest({ request, response, configPath, storePath, token, csrfToken });
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://${host}:${port}/?token=${encodeURIComponent(token)}`;
  return {
    server,
    url,
    host,
    port,
    token,
    csrfToken,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  };
}

async function handleRequest(input: {
  request: IncomingMessage;
  response: ServerResponse;
  configPath: string;
  storePath: string;
  token: string;
  csrfToken: string;
}): Promise<void> {
  const { request, response, configPath, storePath, token, csrfToken } = input;
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (!hasValidSessionToken(request, url, token)) {
    sendJson(response, 401, { ok: false, error: "local UI session token required" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    response.setHeader("set-cookie", `synapsor_ui_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
    sendHtml(response, renderShell(csrfToken));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/summary") {
    const config = await readRunnerConfig(configPath);
    sendJson(response, 200, buildSummary(config, configPath, storePath));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tools") {
    const config = await readRunnerConfig(configPath);
    sendJson(response, 200, buildTools(config));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/proposals") {
    const state = url.searchParams.get("state") as LocalProposalState | null;
    withStore(storePath, (store) => {
      const proposals = store.listProposals(state ?? undefined).map((proposal) => summarizeProposal(proposal));
      sendJson(response, 200, { ok: true, proposals });
    });
    return;
  }

  const proposalDetailMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)$/);
  if (request.method === "GET" && proposalDetailMatch) {
    const proposalId = decodeURIComponent(proposalDetailMatch[1] ?? "");
    withStore(storePath, (store) => {
      const proposal = requireProposal(store, proposalId);
      sendJson(response, 200, {
        ok: true,
        proposal,
        events: store.events(proposalId),
        receipts: store.receipts(proposalId),
        evidence: store.getEvidenceBundle(proposal.change_set.evidence.bundle_id),
      });
    });
    return;
  }

  const approveMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/approve$/);
  if (request.method === "POST" && approveMatch) {
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for proposal review actions" });
      return;
    }
    const proposalId = decodeURIComponent(approveMatch[1] ?? "");
    const body = await readJsonBody(request);
    if (body.confirm !== "approve") throw new Error("approval requires confirm=approve");
    withStore(storePath, (store) => {
      const proposal = requireProposal(store, proposalId);
      const updated = store.approveProposal(proposalId, {
        approver: stringOrDefault(body.actor, "local_reviewer"),
        proposal_hash: proposal.proposal_hash,
        proposal_version: proposal.proposal_version,
        reason: typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined,
      });
      sendJson(response, 200, { ok: true, proposal: updated });
    });
    return;
  }

  const rejectMatch = url.pathname.match(/^\/api\/proposals\/([^/]+)\/reject$/);
  if (request.method === "POST" && rejectMatch) {
    if (!hasValidCsrf(request, csrfToken)) {
      sendJson(response, 403, { ok: false, error: "CSRF token required for proposal review actions" });
      return;
    }
    const proposalId = decodeURIComponent(rejectMatch[1] ?? "");
    const body = await readJsonBody(request);
    if (body.confirm !== "reject") throw new Error("rejection requires confirm=reject");
    const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "";
    if (!reason) throw new Error("rejection requires a reason");
    withStore(storePath, (store) => {
      const proposal = requireProposal(store, proposalId);
      const updated = store.rejectProposal(proposalId, {
        actor: stringOrDefault(body.actor, "local_reviewer"),
        proposal_hash: proposal.proposal_hash,
        proposal_version: proposal.proposal_version,
        reason,
      });
      sendJson(response, 200, { ok: true, proposal: updated });
    });
    return;
  }

  const replayMatch = url.pathname.match(/^\/api\/replay\/([^/]+)$/);
  if (request.method === "GET" && replayMatch) {
    const proposalId = decodeURIComponent(replayMatch[1] ?? "");
    withStore(storePath, (store) => {
      sendJson(response, 200, { ok: true, replay: store.replay(proposalId) });
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: "not found" });
}

async function readRunnerConfig(configPath: string): Promise<JsonRecord> {
  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("runner config must be a JSON object");
  return parsed;
}

function buildSummary(config: JsonRecord, configPath: string, storePath: string): JsonRecord {
  const validation = validateRunnerCapabilityConfig(config);
  const sources = Object.fromEntries(Object.entries(asRecord(config.sources)).map(([name, source]) => {
    const sourceConfig = asRecord(source);
    return [name, {
      engine: sourceConfig.engine,
      read_url_env: sourceConfig.read_url_env,
      write_url_env: sourceConfig.write_url_env,
      statement_timeout_ms: sourceConfig.statement_timeout_ms,
    }];
  }));
  const capabilities = Array.isArray(config.capabilities) ? config.capabilities.map((capability) => {
    const item = asRecord(capability);
    const target = asRecord(item.target);
    return {
      name: item.name,
      kind: item.kind,
      source: item.source,
      target: {
        schema: target.schema,
        table: target.table,
        primary_key: target.primary_key,
        tenant_key: target.tenant_key,
        single_tenant_dev: target.single_tenant_dev === true,
      },
      evidence: item.evidence,
      max_rows: item.max_rows,
    };
  }) : [];
  const forbiddenTools = capabilities
    .map((capability) => String(asRecord(capability).name ?? ""))
    .filter((name) => /execute_sql|run_query|approve|commit|apply_writeback/i.test(name));
  return {
    ok: true,
    setup: {
      config_path: configPath,
      store_path: storePath,
      mode: config.mode,
      storage: { sqlite_path: asRecord(config.storage).sqlite_path },
      trusted_context: config.trusted_context,
      sources,
      capabilities,
    },
    doctor: {
      config_ok: validation.ok,
      errors: validation.errors,
      warnings: validation.warnings,
      no_raw_sql_exposed: forbiddenTools.length === 0,
      forbidden_model_tools: forbiddenTools,
    },
  };
}

function buildTools(config: JsonRecord): JsonRecord {
  const capabilities = Array.isArray(config.capabilities) ? config.capabilities.map((capability) => {
    const item = asRecord(capability);
    const target = asRecord(item.target);
    return {
      name: item.name,
      kind: item.kind,
      target_business_object: `${String(target.schema ?? "")}.${String(target.table ?? "")}`,
      input_schema: item.args,
      hidden_trusted_bindings: asRecord(config.trusted_context).values ?? config.trusted_context,
      lookup: item.lookup,
      visible_columns: item.visible_columns,
      allowed_patch_columns: item.allowed_columns ?? [],
      conflict_guard: item.conflict_guard,
      no_raw_sql_exposed: !/execute_sql|run_query/i.test(String(item.name ?? "")),
      approval_or_commit_exposed: /approve|commit|apply_writeback/i.test(String(item.name ?? "")),
    };
  }) : [];
  return { ok: true, tools: capabilities };
}

function summarizeProposal(proposal: StoredProposal): JsonRecord {
  const changeSet = proposal.change_set;
  return {
    proposal_id: proposal.proposal_id,
    action: proposal.action,
    state: proposal.state,
    tenant_id: proposal.tenant_id,
    principal: changeSet.principal,
    target: {
      source_kind: proposal.source_kind,
      source_id: proposal.source_id,
      schema: proposal.source_schema,
      table: proposal.source_table,
      object_id: proposal.object_id,
      primary_key: changeSet.source.primary_key,
    },
    approval: changeSet.approval,
    source_database_changed: proposal.source_database_mutated,
    expected_version: changeSet.guards.expected_version,
    evidence: changeSet.evidence,
    diff: Object.fromEntries(Object.keys(changeSet.patch).map((column) => [column, {
      before: changeSet.before[column],
      proposed: changeSet.after[column],
    }])),
    created_at: proposal.created_at,
    updated_at: proposal.updated_at,
  };
}

function withStore<T>(storePath: string, fn: (store: ProposalStore) => T): T {
  const store = new ProposalStore(storePath);
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function requireProposal(store: ProposalStore, proposalId: string): StoredProposal {
  const proposal = store.getProposal(proposalId);
  if (!proposal) throw new Error(`proposal not found: ${proposalId}`);
  return proposal;
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("request body must be a JSON object");
  return parsed;
}

function hasValidCsrf(request: IncomingMessage, csrfToken: string): boolean {
  return request.headers["x-synapsor-csrf"] === csrfToken;
}

function hasValidSessionToken(request: IncomingMessage, url: URL, expectedToken: string): boolean {
  const header = request.headers["x-synapsor-ui-token"];
  if (header === expectedToken) return true;
  if (url.searchParams.get("token") === expectedToken) return true;
  const cookies = parseCookies(String(request.headers.cookie ?? ""));
  return cookies.synapsor_ui_token === expectedToken;
}

function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (!rawKey) continue;
    result[rawKey] = decodeURIComponent(rest.join("="));
  }
  return result;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.end(`${JSON.stringify(redactSecrets(payload), null, 2)}\n`);
}

function sendHtml(response: ServerResponse, html: string): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("cache-control", "no-store");
  response.end(html);
}

function renderShell(csrfToken: string): string {
  const escapedCsrf = escapeScriptString(csrfToken);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Synapsor Runner Local UI</title>
<style>
:root { color-scheme: light; --ink:#0f172a; --muted:#475569; --line:#d8e2ee; --blue:#075985; --soft:#f8fbff; --ok:#116b35; --warn:#8a4b00; --bad:#991b1b; }
* { box-sizing: border-box; }
body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--ink); background:#f4f8fb; }
main { max-width: 1180px; margin: 0 auto; padding: 28px; }
h1 { margin: 0 0 4px; font-size: 28px; }
h2 { margin: 0 0 12px; font-size: 18px; }
p { color: var(--muted); line-height: 1.5; }
.grid { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
.card { background:white; border:1px solid var(--line); border-radius:14px; padding:18px; box-shadow:0 8px 28px rgba(15,23,42,.05); }
.full { grid-column: 1 / -1; }
.pill { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:999px; padding:5px 10px; margin:4px 6px 4px 0; color:var(--muted); background:var(--soft); font-size:12px; }
.pill.ok { color:var(--ok); background:#eefaf2; border-color:#b7e3c2; }
.pill.warn { color:var(--warn); background:#fff7ed; border-color:#fed7aa; }
.pill.bad { color:var(--bad); background:#fef2f2; border-color:#fecaca; }
button { border:0; border-radius:10px; padding:10px 13px; color:white; background:linear-gradient(135deg,#0b72a8,#0d9488); font-weight:700; cursor:pointer; }
button.secondary { color:var(--blue); background:#e8f4fb; border:1px solid #acd5ec; }
button.danger { background:linear-gradient(135deg,#b91c1c,#d97706); }
button:disabled { opacity:.55; cursor:not-allowed; }
pre { white-space:pre-wrap; overflow:auto; max-height:380px; background:#08111f; color:#d9f7ff; border-radius:12px; padding:14px; }
table { width:100%; border-collapse:collapse; }
td, th { border-bottom:1px solid var(--line); padding:10px; text-align:left; vertical-align:top; }
input, textarea { width:100%; border:1px solid var(--line); border-radius:10px; padding:10px; color:var(--ink); }
.actions { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
@media (max-width: 850px) { .grid { grid-template-columns: 1fr; } main { padding:18px; } }
</style>
</head>
<body>
<main>
  <h1>Synapsor Runner Local UI</h1>
  <p>Review local semantic tools, proposals, exact diffs, evidence, approval state, receipts, and replay. No raw SQL editor is exposed.</p>
  <section class="grid">
    <div class="card" id="summary"><h2>Setup summary</h2><p>Loading...</p></div>
    <div class="card" id="tools"><h2>Tools</h2><p>Loading...</p></div>
    <div class="card full" id="proposals"><h2>Proposals</h2><p>Loading...</p></div>
    <div class="card full" id="detail"><h2>Proposal review and replay</h2><p>Select a proposal to inspect it.</p></div>
  </section>
</main>
<script>
const csrfToken = "${escapedCsrf}";
const state = { selectedProposal: null };
const byId = (id) => document.getElementById(id);
const text = (tag, value, className = "") => { const el = document.createElement(tag); el.textContent = value == null ? "" : String(value); if (className) el.className = className; return el; };
async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || "request failed");
  return payload;
}
function pre(value) { const el = document.createElement("pre"); el.textContent = JSON.stringify(value, null, 2); return el; }
function pill(label, kind = "") { return text("span", label, "pill " + kind); }
async function loadSummary() {
  const payload = await api("/api/summary");
  const root = byId("summary"); root.replaceChildren(text("h2", "Setup summary"));
  root.append(pill("mode: " + payload.setup.mode, payload.doctor.config_ok ? "ok" : "bad"));
  root.append(pill("config valid: " + payload.doctor.config_ok, payload.doctor.config_ok ? "ok" : "bad"));
  root.append(pill("no raw SQL exposed: " + payload.doctor.no_raw_sql_exposed, payload.doctor.no_raw_sql_exposed ? "ok" : "bad"));
  root.append(pre({ sources: payload.setup.sources, trusted_context: payload.setup.trusted_context, storage: payload.setup.storage, warnings: payload.doctor.warnings, errors: payload.doctor.errors }));
}
async function loadTools() {
  const payload = await api("/api/tools");
  const root = byId("tools"); root.replaceChildren(text("h2", "Tools"));
  for (const tool of payload.tools) {
    const box = document.createElement("div"); box.className = "card"; box.style.margin = "10px 0"; box.style.boxShadow = "none";
    box.append(text("strong", tool.name));
    box.append(pill(tool.kind, tool.kind === "read" ? "ok" : "warn"));
    box.append(pill("No raw SQL", tool.no_raw_sql_exposed ? "ok" : "bad"));
    box.append(pre({ target: tool.target_business_object, input_schema: tool.input_schema, hidden_trusted_bindings: tool.hidden_trusted_bindings, allowed_patch_columns: tool.allowed_patch_columns, conflict_guard: tool.conflict_guard }));
    root.append(box);
  }
}
async function loadProposals() {
  const payload = await api("/api/proposals");
  const root = byId("proposals"); root.replaceChildren(text("h2", "Proposals"));
  if (payload.proposals.length === 0) { root.append(text("p", "No proposals found in the local store yet.")); return; }
  const table = document.createElement("table");
  const head = document.createElement("tr");
  for (const label of ["Proposal", "State", "Target", "Source changed", "Action"]) head.append(text("th", label));
  table.append(head);
  for (const proposal of payload.proposals) {
    const row = document.createElement("tr");
    row.append(text("td", proposal.proposal_id));
    row.append(text("td", proposal.state));
    row.append(text("td", proposal.target.schema + "." + proposal.target.table + " / " + proposal.target.object_id));
    row.append(text("td", proposal.source_database_changed ? "yes" : "no"));
    const action = document.createElement("td");
    const button = document.createElement("button"); button.textContent = "Inspect"; button.onclick = () => loadDetail(proposal.proposal_id);
    action.append(button); row.append(action); table.append(row);
  }
  root.append(table);
}
async function loadDetail(proposalId) {
  state.selectedProposal = proposalId;
  const payload = await api("/api/proposals/" + encodeURIComponent(proposalId));
  const root = byId("detail"); root.replaceChildren(text("h2", "Proposal review and replay"));
  root.append(pill("state: " + payload.proposal.state, payload.proposal.state === "pending_review" ? "warn" : "ok"));
  root.append(pill("source DB changed: " + (payload.proposal.source_database_mutated ? "yes" : "no"), payload.proposal.source_database_mutated ? "bad" : "ok"));
  root.append(pre({ proposal: payload.proposal, events: payload.events, receipts: payload.receipts, evidence: payload.evidence }));
  const actor = document.createElement("input"); actor.placeholder = "Reviewer identity"; actor.value = "local_reviewer";
  const reason = document.createElement("textarea"); reason.placeholder = "Reason for approval or rejection"; reason.rows = 3;
  const actions = document.createElement("div"); actions.className = "actions";
  const approve = document.createElement("button"); approve.textContent = "Approve outside MCP"; approve.onclick = async () => { await api("/api/proposals/" + encodeURIComponent(proposalId) + "/approve", { method: "POST", headers: { "x-synapsor-csrf": csrfToken }, body: JSON.stringify({ actor: actor.value, reason: reason.value, confirm: "approve" }) }); await loadProposals(); await loadDetail(proposalId); };
  const reject = document.createElement("button"); reject.className = "danger"; reject.textContent = "Reject"; reject.onclick = async () => { await api("/api/proposals/" + encodeURIComponent(proposalId) + "/reject", { method: "POST", headers: { "x-synapsor-csrf": csrfToken }, body: JSON.stringify({ actor: actor.value, reason: reason.value || "rejected from local UI", confirm: "reject" }) }); await loadProposals(); await loadDetail(proposalId); };
  const replay = document.createElement("button"); replay.className = "secondary"; replay.textContent = "Inspect replay"; replay.onclick = async () => { const replayPayload = await api("/api/replay/" + encodeURIComponent(proposalId)); root.append(text("h2", "Replay")); root.append(pre(replayPayload.replay)); };
  actions.append(approve, reject, replay);
  root.append(actor, reason, actions);
}
Promise.all([loadSummary(), loadTools(), loadProposals()]).catch((error) => {
  document.body.textContent = error.message;
});
</script>
</body>
</html>`;
}

function redactSecrets(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactSecrets(entryValue, entryKey)]));
  }
  if (typeof value === "string") {
    if (!key.endsWith("_env") && /(password|secret|token|api[_-]?key|private[_-]?key|cookie|credential|connection[_-]?string|database[_-]?url)/i.test(key)) {
      return "<redacted>";
    }
    return value
      .replace(/(postgres(?:ql)?:\/\/)([^:]+):([^@]+)@/gi, "$1<user>:<redacted>@")
      .replace(/(mysql:\/\/)([^:]+):([^@]+)@/gi, "$1<user>:<redacted>@")
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer <redacted>")
      .replace(/syn_wbr_[A-Za-z0-9._~+/=-]+/g, "syn_wbr_<redacted>");
  }
  return value;
}

function escapeScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/</g, "\\u003c");
}

function isLocalHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
