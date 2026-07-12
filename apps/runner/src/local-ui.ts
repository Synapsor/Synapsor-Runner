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
  tour?: boolean;
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
    throw new Error("synapsor-runner ui binds to localhost by default. Use --allow-remote-bind only for an intentional trusted local-network demo.");
  }
  const configPath = path.resolve(options.configPath ?? "synapsor.runner.json");
  const storePath = path.resolve(options.storePath ?? "./.synapsor/local.db");
  const token = options.token ?? crypto.randomBytes(24).toString("base64url");
  const csrfToken = options.csrfToken ?? crypto.randomBytes(24).toString("base64url");

  const server = createServer(async (request, response) => {
    try {
      await handleRequest({ request, response, configPath, storePath, token, csrfToken, tour: options.tour === true });
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
  const url = `http://${host}:${port}/?token=${encodeURIComponent(token)}${options.tour ? "&tour=1" : ""}`;
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
  tour: boolean;
}): Promise<void> {
  const { request, response, configPath, storePath, token, csrfToken, tour } = input;
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  if (!hasValidSessionToken(request, url, token)) {
    sendJson(response, 401, { ok: false, error: "local UI session token required" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/") {
    response.setHeader("set-cookie", `synapsor_ui_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`);
    sendHtml(response, renderShell(csrfToken, tour || url.searchParams.get("tour") === "1", configPath, storePath));
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
        review_view: proposalReviewView(proposal),
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
    if (await signedIdentityRequired(configPath)) {
      sendJson(response, 403, { ok: false, error: "This Runner requires a signed operator identity. Approve with the CLI using --identity and --identity-key." });
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
    if (await signedIdentityRequired(configPath)) {
      sendJson(response, 403, { ok: false, error: "This Runner requires a signed operator identity. Reject with the CLI using --identity and --identity-key." });
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

async function signedIdentityRequired(configPath: string): Promise<boolean> {
  const config = await readRunnerConfig(configPath);
  return isRecord(config.operator_identity) && config.operator_identity.provider === "signed_key";
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
      context: item.context,
      executor: item.executor ?? "sql_update",
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
      storage: asRecord(config.storage),
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
      hidden_trusted_bindings: contextValuesForCapability(config, item),
      lookup: item.lookup,
      visible_columns: item.visible_columns,
      allowed_patch_columns: item.allowed_columns ?? [],
      conflict_guard: item.conflict_guard,
      executor: item.executor ?? "sql_update",
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
    writeback_status: changeSet.writeback.status,
    writeback_mode: changeSet.writeback.mode,
    executor: (changeSet.writeback as { executor?: unknown }).executor ?? "sql_update",
    diff: Object.fromEntries(Object.keys(changeSet.patch).map((column) => [column, {
      before: changeSet.before[column],
      proposed: changeSet.after[column],
    }])),
    created_at: proposal.created_at,
    updated_at: proposal.updated_at,
  };
}

function proposalReviewView(proposal: StoredProposal): JsonRecord {
  const changeSet = proposal.change_set;
  return {
    message: proposal.source_database_mutated
      ? "Commit executed by trusted runner."
      : "The model can propose this change. It cannot approve or commit it.",
    source_database_changed: proposal.source_database_mutated,
    source_row_before: changeSet.before,
    proposed_patch: changeSet.patch,
    diff: Object.fromEntries(Object.keys(changeSet.patch).map((column) => [column, {
      before: changeSet.before[column],
      proposed: changeSet.after[column],
    }])),
    trusted_context: {
      tenant_id: proposal.tenant_id,
      principal: changeSet.principal,
    },
    guard_checklist: {
      tenant_guard: changeSet.guards.tenant,
      allowed_columns: changeSet.guards.allowed_columns,
      primary_key: changeSet.source.primary_key,
      conflict_version: changeSet.guards.expected_version,
      idempotency_key: `${proposal.proposal_id}:${proposal.object_id}`,
      affected_row_count_required: 1,
    },
    writeback: {
      status: proposal.state,
      mode: changeSet.writeback.mode,
      executor: (changeSet.writeback as { executor?: unknown }).executor ?? "sql_update",
    },
    evidence: changeSet.evidence,
  };
}

function contextValuesForCapability(config: JsonRecord, capability: JsonRecord): unknown {
  const contextName = typeof capability.context === "string" ? capability.context : undefined;
  const contexts = asRecord(config.contexts);
  const named = contextName ? asRecord(contexts[contextName]) : {};
  if (Object.keys(named).length > 0) return asRecord(named.values) ?? named;
  return asRecord(asRecord(config.trusted_context).values) ?? config.trusted_context;
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

function renderShell(csrfToken: string, tour = false, configPath = "synapsor.runner.json", storePath = "./.synapsor/local.db"): string {
  const escapedCsrf = escapeScriptString(csrfToken);
  const escapedConfigPath = escapeScriptString(configPath);
  const escapedStorePath = escapeScriptString(storePath);
  const tourHtml = tour ? `
    <div class="card full tour">
      <h2>Commit-safe MCP in one loop</h2>
      <div class="tour-grid">
        <section>
          <h3>What the model can do</h3>
          <ul><li>Inspect a business object</li><li>Propose a change</li></ul>
        </section>
        <section>
          <h3>What the model cannot do</h3>
          <ul><li>Run SQL</li><li>Approve</li><li>Commit</li><li>Choose tenant authority</li><li>Access write credentials</li></ul>
        </section>
        <section>
          <h3>What the trusted runner does</h3>
          <ul><li>Checks tenant scope</li><li>Checks allowed columns</li><li>Checks idempotency</li><li>Checks row version</li><li>Stores receipt and replay</li></ul>
        </section>
      </div>
    </div>` : "";
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
.tour-grid { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:14px; }
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
header h1 { margin-bottom:6px; }
.console { display:grid; grid-template-columns:300px minmax(0,1fr); gap:16px; align-items:start; }
.plist { display:flex; flex-direction:column; gap:8px; }
.pitem { display:block; width:100%; text-align:left; background:white; color:var(--ink); border:1px solid var(--line); border-radius:12px; padding:12px; cursor:pointer; box-shadow:none; font-weight:400; }
.pitem:hover { border-color:#9cc6e6; }
.pitem.sel { border-color:#0b72a8; box-shadow:0 0 0 3px rgba(11,114,168,.12); }
.pitem-action { font-weight:700; font-size:14px; color:var(--ink); }
.pitem-target { font-size:12px; color:var(--muted); margin:2px 0 8px; word-break:break-all; }
.chip { display:inline-flex; align-items:center; gap:6px; border-radius:999px; padding:3px 9px; font-size:11px; font-weight:600; border:1px solid var(--line); }
.chip-ok{color:var(--ok);background:#eefaf2;border-color:#b7e3c2;}
.chip-wait{color:var(--warn);background:#fff7ed;border-color:#fed7aa;}
.chip-warn{color:#9a3412;background:#fff4ed;border-color:#fdba74;}
.chip-bad{color:var(--bad);background:#fef2f2;border-color:#fecaca;}
.chip-info{color:var(--blue);background:#eef6fc;border-color:#bfdcf0;}
.chip-muted{color:var(--muted);background:var(--soft);border-color:var(--line);}
.detail-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:4px; }
.detail-head .sub { font-size:13px; color:var(--muted); margin-top:2px; word-break:break-all; }
.tabs { display:flex; gap:0; margin:10px 0 18px; border-bottom:1px solid var(--line); }
.tab { background:transparent; color:var(--muted); border:0; border-bottom:2px solid transparent; border-radius:0; padding:8px 2px; margin-right:18px; font-weight:600; cursor:pointer; }
.tab.active { color:var(--blue); border-bottom-color:var(--blue); }
.hidden { display:none; }
.step { display:grid; grid-template-columns:36px 1fr; gap:14px; padding:0 0 18px; }
.step-rail { display:flex; flex-direction:column; align-items:center; }
.step-num { width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:13px; color:white; background:#94a3b8; flex:none; }
.step .step-rail::after { content:""; flex:1; width:2px; background:var(--line); margin-top:6px; }
.step:last-child .step-rail::after { display:none; }
.step-ok .step-num{background:var(--ok);} .step-wait .step-num{background:#d97706;} .step-warn .step-num{background:#ea580c;} .step-bad .step-num{background:var(--bad);} .step-info .step-num{background:#0b72a8;} .step-muted .step-num{background:#94a3b8;}
.step-title { font-weight:700; font-size:15px; margin-bottom:4px; }
.step-main p { margin:2px 0 6px; }
.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; background:#f1f6fb; border:1px solid var(--line); border-radius:8px; padding:8px 10px; display:inline-block; color:var(--ink); word-break:break-all; }
.callout { background:#eef6fc; border:1px solid #bfdcf0; border-left:3px solid #0b72a8; border-radius:8px; padding:10px 12px; color:#0c4a6e; font-size:13px; margin:6px 0; }
.status-line { font-size:13px; margin:4px 0; }
.diff { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; border:1px solid var(--line); border-radius:10px; overflow:hidden; margin:6px 0; }
.diff-col { background:#f1f6fb; padding:6px 10px; font-weight:600; border-bottom:1px solid var(--line); color:var(--muted); }
.diff-line { padding:5px 10px; white-space:pre-wrap; word-break:break-all; }
.diff-line.del { background:#fef2f2; color:#991b1b; }
.diff-line.add { background:#eefaf2; color:#116b35; }
.badge-row { display:flex; align-items:center; gap:10px; font-size:14px; margin:6px 0; }
.badge { border-radius:999px; padding:4px 12px; font-weight:700; font-size:13px; }
.badge.no { color:var(--ok); background:#eefaf2; border:1px solid #b7e3c2; }
.badge.yes { color:var(--blue); background:#eef6fc; border:1px solid #bfdcf0; }
.timeline { display:flex; flex-direction:column; margin-top:4px; }
.tl-row { display:grid; grid-template-columns:14px 1fr; gap:10px; padding-bottom:12px; position:relative; }
.tl-row::before { content:""; position:absolute; left:5px; top:14px; bottom:-2px; width:2px; background:var(--line); }
.tl-row:last-child::before { display:none; }
.tl-dot { width:11px; height:11px; border-radius:50%; margin-top:3px; background:#94a3b8; z-index:1; }
.tl-ok{background:var(--ok);} .tl-warn{background:#ea580c;} .tl-bad{background:var(--bad);} .tl-info{background:#0b72a8;} .tl-wait{background:#d97706;} .tl-muted{background:#94a3b8;}
.tl-label { font-weight:600; font-size:13px; }
.tl-meta { font-size:12px; color:var(--muted); word-break:break-all; }
.kv { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; font-size:13px; margin:8px 0; }
.kv dt { color:var(--muted); } .kv dd { margin:0; color:var(--ink); word-break:break-all; }
details.raw { margin-top:12px; }
details.raw > summary { cursor:pointer; color:var(--blue); font-weight:600; font-size:13px; }
.config-section { margin-top:24px; }
.config-section > summary { cursor:pointer; font-weight:700; font-size:16px; padding:10px 0; color:var(--ink); }
@media (max-width: 900px) { .console { grid-template-columns:1fr; } }
@media (max-width: 850px) { .grid, .tour-grid { grid-template-columns: 1fr; } main { padding:18px; } }
</style>
</head>
<body>
<main>
  <header>
    <h1>Synapsor Runner Local UI</h1>
    <p>A local review console for what an agent proposed, what the safety boundary did, and what the trusted runner committed. No raw SQL editor is exposed.</p>
  </header>
  ${tourHtml}
  <section class="console">
    <div class="card" id="proposals"><h2>Proposals</h2><p>Loading...</p></div>
    <div class="card" id="detail"><h2>Local review console</h2><p>Select a proposal to walk through what happened.</p></div>
  </section>
  <details class="card config-section">
    <summary>Runtime configuration &amp; tools</summary>
    <div class="grid" style="margin-top:14px">
      <div class="card" id="summary"><h2>Setup summary</h2><p>Loading...</p></div>
      <div class="card" id="tools"><h2>Tools</h2><p>Loading...</p></div>
    </div>
  </details>
</main>
<script>
const csrfToken = "${escapedCsrf}";
const configPath = "${escapedConfigPath}";
const storePath = "${escapedStorePath}";
const state = { selected: null, firstId: null };
const byId = (id) => document.getElementById(id);
const text = (tag, value, className = "") => { const node = document.createElement(tag); node.textContent = value == null ? "" : String(value); if (className) node.className = className; return node; };
function el(tag, opts, kids) {
  const node = document.createElement(tag);
  if (opts) {
    if (opts.class) node.className = opts.class;
    if (opts.text != null) node.textContent = String(opts.text);
    if (opts.onclick) node.onclick = opts.onclick;
    if (opts.style) node.style.cssText = opts.style;
  }
  if (kids != null) for (const k of [].concat(kids)) if (k) node.append(k);
  return node;
}
async function api(path, options = {}) {
  const res = await fetch(path, { credentials: "same-origin", ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } });
  const payload = await res.json();
  if (!res.ok) throw new Error(payload.error || "request failed");
  return payload;
}
function pre(value) { const node = document.createElement("pre"); node.textContent = JSON.stringify(value, null, 2); return node; }
function pill(label, kind = "") { return text("span", label, "pill " + kind); }
function chip(label, tone) { return text("span", label, "chip chip-" + tone); }
function rawJson(label, value) {
  const d = el("details", { class: "raw" });
  d.append(el("summary", { text: label || "View raw JSON" }));
  d.append(pre(value));
  return d;
}
function fmtVal(v) {
  if (v === null || v === undefined || v === "") return "(empty)";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
function humanizeState(s) {
  switch (s) {
    case "pending_review": return { label: "Awaiting approval", tone: "wait" };
    case "approved": return { label: "Approved", tone: "ok" };
    case "pending_worker": return { label: "Queued for runner", tone: "wait" };
    case "applied": return { label: "Committed", tone: "ok" };
    case "conflict": return { label: "Conflict blocked", tone: "warn" };
    case "failed": return { label: "Failed", tone: "bad" };
    case "rejected": return { label: "Rejected", tone: "bad" };
    case "canceled": return { label: "Canceled", tone: "muted" };
    default: return { label: s, tone: "muted" };
  }
}
function eventMeta(kind) {
  const map = {
    evidence_recorded: { label: "Evidence recorded", tone: "info" },
    proposal_created: { label: "Proposal created", tone: "info" },
    proposal_approved: { label: "Approved outside MCP", tone: "ok" },
    proposal_rejected: { label: "Rejected", tone: "bad" },
    proposal_canceled: { label: "Canceled", tone: "muted" },
    proposal_pending_worker: { label: "Queued for trusted runner", tone: "wait" },
    writeback_job_recorded: { label: "Writeback job recorded", tone: "info" },
    writeback_applied: { label: "Committed by trusted runner", tone: "ok" },
    writeback_conflict: { label: "Conflict guard blocked stale write", tone: "warn" },
    writeback_failed: { label: "Writeback failed", tone: "bad" },
  };
  return map[kind] || { label: String(kind).replace(/_/g, " "), tone: "info" };
}
function stepCard(n, title, tone, body) {
  const rail = el("div", { class: "step-rail" }, el("span", { class: "step-num", text: n }));
  const main = el("div", { class: "step-main" }, [el("div", { class: "step-title", text: title })].concat([].concat(body || [])));
  return el("div", { class: "step step-" + tone }, [rail, main]);
}
function diffBlock(target, diff) {
  const wrap = el("div", { class: "diff" });
  const cols = Object.keys(diff || {});
  if (!cols.length) { wrap.append(el("div", { class: "diff-line", text: "(no field changes)" })); return wrap; }
  for (const col of cols) {
    const d = diff[col];
    wrap.append(el("div", { class: "diff-col", text: target + "." + col }));
    wrap.append(el("div", { class: "diff-line del", text: "- " + fmtVal(d.before) }));
    wrap.append(el("div", { class: "diff-line add", text: "+ " + fmtVal(d.proposed) }));
  }
  return wrap;
}
function guardDrawer(gc) {
  const d = el("details", { class: "raw" });
  d.append(el("summary", { text: "What the trusted runner enforces" }));
  const kv = el("dl", { class: "kv" });
  const add = (k, v) => { kv.append(el("dt", { text: k }), el("dd", { text: v })); };
  if (gc.tenant_guard) add("Tenant scope", gc.tenant_guard.column + " = " + fmtVal(gc.tenant_guard.value));
  if (gc.allowed_columns) add("Allowed columns", (gc.allowed_columns || []).join(", "));
  if (gc.primary_key) add("Primary key", gc.primary_key.column + " = " + fmtVal(gc.primary_key.value));
  if (gc.conflict_version) add("Conflict guard", gc.conflict_version.column + " = " + fmtVal(gc.conflict_version.value));
  if (gc.idempotency_key) add("Idempotency key", gc.idempotency_key);
  if (gc.affected_row_count_required != null) add("Affected rows required", String(gc.affected_row_count_required));
  d.append(kv);
  return d;
}
function shellQuote(value) {
  const text = String(value || "");
  return /^[A-Za-z0-9_./:@=-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\\\''") + "'";
}
function trustedApplyCommand(proposalId) {
  return "synapsor-runner apply " + shellQuote(proposalId) + " --config " + shellQuote(configPath) + " --store " + shellQuote(storePath);
}
async function loadSummary() {
  const payload = await api("/api/summary");
  const root = byId("summary"); root.replaceChildren(text("h2", "Setup summary"));
  root.append(pill("mode: " + payload.setup.mode, payload.doctor.config_ok ? "ok" : "bad"));
  root.append(pill("config valid: " + payload.doctor.config_ok, payload.doctor.config_ok ? "ok" : "bad"));
  root.append(pill("no raw SQL exposed: " + payload.doctor.no_raw_sql_exposed, payload.doctor.no_raw_sql_exposed ? "ok" : "bad"));
  const kv = el("dl", { class: "kv" });
  const add = (k, v) => { kv.append(el("dt", { text: k }), el("dd", { text: v })); };
  add("Config path", payload.setup.config_path);
  add("Local store", payload.setup.store_path);
  add("Sources", Object.keys(payload.setup.sources || {}).join(", ") || "(none)");
  root.append(kv);
  root.append(rawJson("View raw JSON", { sources: payload.setup.sources, trusted_context: payload.setup.trusted_context, storage: payload.setup.storage, warnings: payload.doctor.warnings, errors: payload.doctor.errors }));
}
async function loadTools() {
  const payload = await api("/api/tools");
  const root = byId("tools"); root.replaceChildren(text("h2", "Tools"));
  for (const tool of payload.tools) {
    const box = document.createElement("div"); box.className = "card"; box.style.margin = "10px 0"; box.style.boxShadow = "none";
    box.append(text("strong", tool.name), text("div", tool.target_business_object, "pitem-target"));
    box.append(chip(tool.kind, tool.kind === "read" ? "ok" : "wait"));
    box.append(chip(tool.no_raw_sql_exposed ? "No raw SQL" : "RAW SQL EXPOSED", tool.no_raw_sql_exposed ? "ok" : "bad"));
    box.append(rawJson("View raw JSON", { target: tool.target_business_object, input_schema: tool.input_schema, hidden_trusted_bindings: tool.hidden_trusted_bindings, allowed_patch_columns: tool.allowed_patch_columns, conflict_guard: tool.conflict_guard }));
    root.append(box);
  }
}
async function loadProposals() {
  const payload = await api("/api/proposals");
  const root = byId("proposals"); root.replaceChildren(text("h2", "Proposals"));
  if (payload.proposals.length === 0) {
    root.append(text("p", "No proposals in the local store yet. Run synapsor-runner mcp serve and have an agent propose a change."));
    state.firstId = null;
    return;
  }
  const list = el("div", { class: "plist" });
  for (const proposal of payload.proposals) {
    const st = humanizeState(proposal.state);
    const item = el("button", { class: "pitem" + (proposal.proposal_id === state.selected ? " sel" : ""), onclick: () => loadDetail(proposal.proposal_id) }, [
      el("div", { class: "pitem-action", text: proposal.action }),
      el("div", { class: "pitem-target", text: proposal.target.object_id + " · " + proposal.target.schema + "." + proposal.target.table }),
      chip(st.label, st.tone),
    ]);
    list.append(item);
  }
  root.append(list);
  state.firstId = payload.proposals[0].proposal_id;
}
function commitResult(stateVal) {
  switch (stateVal) {
    case "pending_review": return { label: "Not committed yet — awaiting human approval.", tone: "wait" };
    case "approved": return { label: "Approved. The trusted runner will attempt the commit.", tone: "wait" };
    case "pending_worker": return { label: "Queued for the trusted runner.", tone: "wait" };
    case "applied": return { label: "Committed by the trusted runner. The approved change was applied.", tone: "ok" };
    case "conflict": return { label: "Conflict: the row changed after the proposal. No write applied.", tone: "warn" };
    case "failed": return { label: "Writeback failed. No write applied.", tone: "bad" };
    case "rejected": return { label: "No commit. The proposal was rejected.", tone: "bad" };
    case "canceled": return { label: "No commit. The proposal was canceled.", tone: "muted" };
    default: return { label: stateVal, tone: "muted" };
  }
}
function buildStory(payload) {
  const proposal = payload.proposal;
  const rv = payload.review_view || {};
  const cs = proposal.change_set || {};
  const stateVal = proposal.state;
  const target = proposal.source_schema + "." + proposal.source_table;
  const objectId = proposal.object_id;
  const mutated = proposal.source_database_mutated === true;
  const events = payload.events || [];
  const find = (k) => events.find((e) => e.kind === k);
  const principalId = (cs.principal && cs.principal.id) || "the agent";
  const requiredRole = (cs.approval && cs.approval.required_role) || "a reviewer";
  const story = el("div", { class: "story" });

  // 1. Agent requested a change
  story.append(stepCard("1", "Agent requested a change", "info", [
    el("div", { class: "mono", text: proposal.action + " for " + objectId }),
    el("p", { text: "The model called a semantic MCP tool. It could request this change, but it had no tools to run SQL, approve, or commit." }),
  ]));

  // 2. Synapsor Runner created a proposal
  story.append(stepCard("2", "Synapsor Runner created a proposal", "ok", [
    el("p", { text: "The request was captured as a reviewable proposal in the local store." }),
    el("div", { class: "kv" }, [
      el("dt", { text: "Proposal" }), el("dd", { text: proposal.proposal_id }),
      el("dt", { text: "Tenant" }), el("dd", { text: proposal.tenant_id }),
      el("dt", { text: "Principal" }), el("dd", { text: principalId }),
    ]),
  ]));

  // 3. The proposed change
  story.append(stepCard("3", "The proposed change", "info", [
    diffBlock(target, rv.diff),
  ]));

  // 4. Safety result
  story.append(stepCard("4", "Safety result", mutated ? "ok" : "ok", [
    el("div", { class: "badge-row" }, [
      el("span", { text: "Source database changed:" }),
      el("span", { class: "badge " + (mutated ? "yes" : "no"), text: mutated ? "Yes" : "No" }),
    ]),
    el("p", { text: mutated
      ? "The trusted runner applied the approved change to the source database."
      : "Proposing and reviewing did not modify the source database." }),
  ]));

  // 5. Approval boundary
  const approveBody = [el("div", { class: "callout", text: "Approval happened outside MCP. The model did not get approve or commit tools." })];
  const approvedEv = find("proposal_approved");
  const rejectedEv = find("proposal_rejected");
  if (stateVal === "pending_review") {
    approveBody.push(el("div", { class: "status-line", text: "Waiting for a human reviewer (" + requiredRole + ")." }));
  } else if (rejectedEv) {
    approveBody.push(el("div", { class: "status-line", text: "Rejected by " + rejectedEv.actor + (rejectedEv.payload && rejectedEv.payload.reason ? ": " + rejectedEv.payload.reason : "") + "." }));
  } else if (approvedEv) {
    approveBody.push(el("div", { class: "status-line", text: "Approved by " + approvedEv.actor + (approvedEv.payload && approvedEv.payload.reason ? ": " + approvedEv.payload.reason : "") + "." }));
  } else if (stateVal === "canceled") {
    approveBody.push(el("div", { class: "status-line", text: "The proposal was canceled before approval." }));
  }
  story.append(stepCard("5", "Approval boundary", rejectedEv ? "bad" : (approvedEv ? "ok" : "wait"), approveBody));

  // 6. Commit result
  const cr = commitResult(stateVal);
  const commitBody = [el("p", { text: cr.label })];
  if (rv.guard_checklist) commitBody.push(guardDrawer(rv.guard_checklist));
  story.append(stepCard("6", "Commit result", cr.tone, commitBody));

  // 7. Replay
  const tl = el("div", { class: "timeline" });
  if (!events.length) {
    tl.append(el("p", { text: "No replay events recorded yet." }));
  } else {
    for (const e of events) {
      const m = eventMeta(e.kind);
      tl.append(el("div", { class: "tl-row" }, [
        el("span", { class: "tl-dot tl-" + m.tone }),
        el("div", {}, [
          el("div", { class: "tl-label", text: m.label }),
          el("div", { class: "tl-meta", text: (e.actor || "") + (e.created_at ? " · " + e.created_at : "") }),
        ]),
      ]));
    }
  }
  const replayDrawer = el("details", { class: "raw" });
  replayDrawer.append(el("summary", { text: "View full replay JSON" }));
  let replayLoaded = false;
  replayDrawer.addEventListener("toggle", async () => {
    if (!replayDrawer.open || replayLoaded) return;
    replayLoaded = true;
    try {
      const replayPayload = await api("/api/replay/" + encodeURIComponent(proposal.proposal_id));
      replayDrawer.append(pre(replayPayload.replay));
    } catch (error) {
      replayDrawer.append(el("p", { text: error.message }));
    }
  });
  story.append(stepCard("7", "Replay saved what happened", "info", [tl, replayDrawer]));

  return story;
}
async function loadDetail(proposalId) {
  state.selected = proposalId;
  const payload = await api("/api/proposals/" + encodeURIComponent(proposalId));
  const proposal = payload.proposal;
  const st = humanizeState(proposal.state);
  const root = byId("detail"); root.replaceChildren();

  const head = el("div", { class: "detail-head" }, [
    el("div", {}, [
      el("h2", { text: proposal.action, style: "margin:0" }),
      el("div", { class: "sub", text: proposal.object_id + " · " + proposal.source_schema + "." + proposal.source_table }),
    ]),
    chip(st.label, st.tone),
  ]);
  root.append(head);

  const reviewTab = el("button", { class: "tab active", text: "Review" });
  const jsonTab = el("button", { class: "tab", text: "View raw JSON" });
  const reviewPane = el("div", { class: "pane" });
  const jsonPane = el("div", { class: "pane hidden" });
  reviewTab.onclick = () => { reviewTab.classList.add("active"); jsonTab.classList.remove("active"); reviewPane.classList.remove("hidden"); jsonPane.classList.add("hidden"); };
  jsonTab.onclick = () => { jsonTab.classList.add("active"); reviewTab.classList.remove("active"); jsonPane.classList.remove("hidden"); reviewPane.classList.add("hidden"); };
  root.append(el("div", { class: "tabs" }, [reviewTab, jsonTab]));

  reviewPane.append(buildStory(payload));

  if (proposal.state === "pending_review") {
    const actor = document.createElement("input"); actor.placeholder = "Reviewer identity"; actor.value = "local_reviewer";
    const reason = document.createElement("textarea"); reason.placeholder = "Reason for approval or rejection"; reason.rows = 3;
    const actions = el("div", { class: "actions" });
    const approve = el("button", { text: "Approve outside MCP", onclick: async () => { await api("/api/proposals/" + encodeURIComponent(proposalId) + "/approve", { method: "POST", headers: { "x-synapsor-csrf": csrfToken }, body: JSON.stringify({ actor: actor.value, reason: reason.value, confirm: "approve" }) }); await loadProposals(); await loadDetail(proposalId); } });
    const reject = el("button", { class: "danger", text: "Reject", onclick: async () => { await api("/api/proposals/" + encodeURIComponent(proposalId) + "/reject", { method: "POST", headers: { "x-synapsor-csrf": csrfToken }, body: JSON.stringify({ actor: actor.value, reason: reason.value || "rejected from local UI", confirm: "reject" }) }); await loadProposals(); await loadDetail(proposalId); } });
    actions.append(approve, reject);
    reviewPane.append(el("div", { class: "callout", text: "You are the approval authority here — the model cannot reach these controls." }), actor, reason, actions);
  } else if (proposal.state === "approved" || proposal.state === "pending_worker") {
    const command = trustedApplyCommand(proposalId);
    const commandBox = el("div", { class: "mono", text: command, style: "display:block;margin-top:8px" });
    const copied = el("span", { class: "status-line", text: "" });
    const copy = el("button", { text: "Copy guarded apply command", onclick: async () => {
      try {
        await navigator.clipboard.writeText(command);
        copied.textContent = "Copied. Run this from a trusted terminal with write credentials.";
      } catch {
        copied.textContent = "Copy this guarded apply command and run it from a trusted terminal with write credentials.";
      }
    } });
    reviewPane.append(
      el("div", { class: "callout", text: "Apply guarded writeback from a trusted terminal. This remains outside MCP, so the model still cannot commit." }),
      commandBox,
      el("div", { class: "actions" }, [copy]),
      copied,
    );
  }

  jsonPane.append(
    el("h3", { text: "proposal", style: "margin:6px 0 2px;font-size:13px;color:var(--muted)" }), pre(payload.proposal),
    el("h3", { text: "events", style: "margin:6px 0 2px;font-size:13px;color:var(--muted)" }), pre(payload.events),
    el("h3", { text: "receipts", style: "margin:6px 0 2px;font-size:13px;color:var(--muted)" }), pre(payload.receipts),
    el("h3", { text: "evidence", style: "margin:6px 0 2px;font-size:13px;color:var(--muted)" }), pre(payload.evidence),
  );
  root.append(reviewPane, jsonPane);
}
async function init() {
  await Promise.all([loadSummary(), loadTools(), loadProposals()]);
  if (state.firstId && !state.selected) await loadDetail(state.firstId);
}
init().catch((error) => {
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
