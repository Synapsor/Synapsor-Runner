import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [resultsPath, cloudScreenshotPath, outputPath] = process.argv.slice(2);
if (!resultsPath || !cloudScreenshotPath || !outputPath) {
  throw new Error("usage: render-deck.mjs <results.json> <cloud-screenshot.png> <output.html>");
}

const data = JSON.parse(await readFile(resultsPath, "utf8"));
let cloudImage = "";
try {
  cloudImage = `data:image/png;base64,${(await readFile(cloudScreenshotPath)).toString("base64")}`;
} catch {
  // Local draft renders are useful while Cloud credentials are unavailable.
  // The final verifier rejects an incomplete Cloud scene.
}

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const e = escapeHtml;
const yesNo = (value) => value ? "yes" : "no";
const shortHash = (value, head = 18, tail = 8) => {
  const text = String(value ?? "");
  return text.length > head + tail + 3 ? `${text.slice(0, head)}...${text.slice(-tail)}` : text;
};
const money = (cents) => `$${(Number(cents) / 100).toFixed(2)}`;
const command = (body) => `<div class="terminal"><div class="terminal-bar"><span></span><span></span><span></span><strong>demo@synapsor:~</strong></div><pre>${e(body)}</pre></div>`;
const scene = ({ id, start, end, eyebrow, title, caption, body, tone = "default" }) => `
  <section class="scene scene-${tone}" data-scene="${id}" data-start="${start}" data-end="${end}">
    <div class="scene-content">
      <p class="eyebrow">${e(eyebrow)}</p>
      <h1>${title}</h1>
      ${body}
    </div>
    <div class="caption"><span>${String(id).padStart(2, "0")}</span><p>${e(caption)}</p></div>
  </section>`;

const proposal = data.proposal;
const cloud = data.cloud ?? { complete: false };
const cloudVersion = cloud.version_number ?? "pending";
const cloudDigest = cloud.digest ?? "Cloud capture required";
const bundleEntries = cloud.bundle?.entries?.length ?? 0;
const auditFindings = data.audit.findings.map((finding) => `<li><span class="fail-dot"></span>${e(finding.replaceAll("_", " ").toLowerCase())}</li>`).join("");
const contextLines = data.contract.context_lines.map((line) => `<code>${e(line)}</code>`).join("");
const checks = data.writeback.checks.map((check) => `<li><span class="check">&#10003;</span>${e(check)}</li>`).join("");
const replayEvents = data.replay.events.map((event, index) => `<li><span>${index + 1}</span><strong>${e(event.replaceAll("_", " "))}</strong></li>`).join("");
const cloudImageMarkup = cloudImage
  ? `<img class="cloud-shot" src="${cloudImage}" alt="Real Synapsor Cloud contract registry capture">`
  : `<div class="cloud-placeholder"><strong>Cloud capture pending</strong><span>Final verification requires the real registry UI.</span></div>`;

const scenes = [
  scene({
    id: 1, start: 0, end: 8, eyebrow: "Synapsor Runner", tone: "hero",
    title: `Stop giving agents <code>execute_sql</code>.`,
    caption: "Stop giving agents execute_sql. Give them reviewed business actions instead.",
    body: `<p class="hero-copy">Give them <strong>reviewed business actions</strong> instead.</p><div class="hero-rule"></div><p class="supporting">An open contract layer for safe, tenant-bound, reviewable actions over MCP.</p>`,
  }),
  scene({
    id: 2, start: 8, end: 20, eyebrow: "The risky default", tone: "danger",
    title: "One generic tool hands authority to the model.",
    caption: "Raw database MCP can hand SQL text, table selection, filters, and write authority to the model.",
    body: `<div class="two-col danger-grid">
      ${command(`$ audit dangerous-db-mcp\n\nexecute_sql(sql: string)\nrun_query(query: string)\nupdate_customer(table, column, value)`)}
      <div class="finding-panel"><div class="metric-row"><div><strong>${data.audit.high}</strong><span>high</span></div><div><strong>${data.audit.medium}</strong><span>medium</span></div><div><strong>${data.audit.low}</strong><span>low</span></div></div><ul class="finding-list">${auditFindings}</ul><p>No SQL was executed. This is a static tool-shape audit.</p></div>
    </div>`,
  }),
  scene({
    id: 3, start: 20, end: 32, eyebrow: "Trusted context", tone: "contract",
    title: "Tenant scope is bound outside model arguments.",
    caption: "Synapsor binds tenant and principal scope from trusted context, outside model arguments.",
    body: `<div class="two-col context-grid"><div class="code-sheet"><span>CREATE AGENT CONTEXT trusted_operator</span>${contextLines}<span>END</span></div><div class="trust-flow"><div><small>Trusted runtime</small><strong>${e(data.inspect.tenant_id)}</strong><span>tenant</span></div><b>&rarr;</b><div><small>Semantic tool</small><strong>${e(data.inspect.tool)}</strong><span>no tenant argument</span></div></div>`,
  }),
  scene({
    id: 4, start: 32, end: 45, eyebrow: "Reviewed contract", tone: "contract",
    title: "The boundary is explicit and versionable.",
    caption: "The reviewed contract declares visible fields, kept-out fields, bounded writes, and approval.",
    body: `<div class="boundary-grid"><div><h2>Visible to the capability</h2><p>id, plan, invoice_status, support_ticket_reason, plan_credit_cents</p></div><div class="kept-out"><h2>Kept out</h2><p>card_token, raw_payment_method, internal_risk_score, private_notes</p></div><div><h2>Bounded change</h2><p><code>plan_credit_cents 1..50000</code></p></div><div><h2>Commit boundary</h2><p><code>APPROVAL ROLE support_reviewer</code><br><code>WRITEBACK DIRECT SQL</code></p></div></div>`,
  }),
  scene({
    id: 5, start: 45, end: 58, eyebrow: "MCP-facing surface", tone: "tools",
    title: "The model gets two business capabilities.",
    caption: "The model sees two semantic tools. It does not see raw SQL, credentials, approval, or apply.",
    body: `<div class="tool-surface"><div class="exposed"><h2>Exposed to MCP</h2>${data.tools.exposed.map((tool) => `<p><span class="check">&#10003;</span><code>${e(tool)}</code></p>`).join("")}</div><div class="excluded"><h2>Not exposed</h2>${data.tools.excluded.slice(0, 6).map((item) => `<p><span>&times;</span>${e(item)}</p>`).join("")}</div></div>`,
  }),
  scene({
    id: 6, start: 58, end: 70, eyebrow: "Scoped inspection", tone: "terminal",
    title: "One read. One tenant. Evidence recorded.",
    caption: "The inspect tool reads one tenant-scoped customer and records evidence. The source stays unchanged.",
    body: `<div class="two-col inspect-grid">${command(`$ smoke call support.inspect_customer\n  customer_id = "${data.inspect.object_id}"\n\nstatus                    ok\ntenant                    ${data.inspect.tenant_id}\nprincipal                 ${data.inspect.principal}\nevidence                  ${data.inspect.evidence_bundle_id}\nsource database changed   ${yesNo(data.inspect.source_database_changed)}`)}<div class="evidence-card"><p class="status-pill">SCOPED READ</p><strong>${e(data.inspect.object_id)}</strong><dl><dt>Tenant</dt><dd>${e(data.inspect.tenant_id)}</dd><dt>Principal</dt><dd>${e(data.inspect.principal)}</dd><dt>Evidence</dt><dd>${e(shortHash(data.inspect.evidence_bundle_id))}</dd></dl></div></div>`,
  }),
  scene({
    id: 7, start: 70, end: 88, eyebrow: "Agent request", tone: "proposal",
    title: "A request becomes a proposal, not a write.",
    caption: "The agent requests a plan credit. Runner stores the exact diff, evidence handle, and expected row version.",
    body: `<div class="proposal-head"><code>${e(proposal.capability)}(customer_id="${e(proposal.object_id)}")</code><span>review required</span></div><div class="diff-grid"><div><small>plan_credit_cents</small><p><del>${proposal.diff.plan_credit_cents.before}</del><b>&rarr;</b><ins>${proposal.diff.plan_credit_cents.proposed}</ins></p></div><div><small>credit_reason</small><p><del>null</del><b>&rarr;</b><ins>${e(proposal.diff.credit_reason.proposed)}</ins></p></div></div><div class="id-strip"><span>Proposal <code>${e(proposal.proposal_id)}</code></span><span>Evidence <code>${e(proposal.evidence_bundle_id)}</code></span></div>`,
  }),
  scene({
    id: 8, start: 88, end: 96, eyebrow: "Proposal does not equal commit", tone: "database",
    title: "Postgres is still unchanged.",
    caption: "Before approval, Postgres still shows zero credit. Proposal does not equal commit.",
    body: `<div class="db-compare"><div><small>Before proposal</small><strong>${money(data.source_state.before.plan_credit_cents)}</strong><span>${e(data.source_state.before.credit_reason)}</span></div><div class="equals">=</div><div><small>After proposal</small><strong>${money(data.source_state.after_proposal.plan_credit_cents)}</strong><span>${e(data.source_state.after_proposal.credit_reason)}</span></div></div><p class="unchanged"><span class="check">&#10003;</span> Source database changed: no</p>`,
  }),
  scene({
    id: 9, start: 96, end: 108, eyebrow: "Outside MCP", tone: "approval",
    title: "An operator reviews the exact proposal.",
    caption: "An operator reviews and approves outside the model-facing MCP surface.",
    body: `<div class="approval-layout"><div class="approval-box"><span>Required role</span><strong>${e(data.approval.required_role)}</strong><span>Proposal</span><code>${e(proposal.proposal_id)}</code><span>Source changed</span><strong>no</strong></div><div class="approval-action"><span>Operator</span><strong>${e(data.approval.actor)}</strong><div class="approve-button">Approved</div><small>This command is not an MCP tool.</small></div></div>`,
  }),
  scene({
    id: 10, start: 108, end: 123, eyebrow: "Guarded writeback", tone: "writeback",
    title: "Only the approved row and columns can change.",
    caption: "Guarded writeback checks approval, primary key, tenant, allowed columns, row version, and affected rows.",
    body: `<div class="two-col writeback-grid"><ul class="guard-list">${checks}</ul><div class="result-change"><small>public.customers / ${e(proposal.object_id)}</small><div><span>${money(data.source_state.after_proposal.plan_credit_cents)}</span><b>&rarr;</b><strong>${money(data.source_state.after_apply.plan_credit_cents)}</strong></div><p>${e(data.source_state.after_apply.credit_reason)}</p><em>${data.writeback.rows_affected} row affected</em></div></div>`,
  }),
  scene({
    id: 11, start: 123, end: 137, eyebrow: "Receipt and replay", tone: "replay",
    title: "The full decision path remains inspectable.",
    caption: "The receipt and replay preserve the read, evidence, proposal, approval, writeback, and result.",
    body: `<ol class="replay-line">${replayEvents}</ol><div class="receipt-strip"><span>Receipt hash <code>${e(shortHash(data.writeback.receipt_hash, 20, 8))}</code></span><span>Status <strong>${e(data.writeback.state)}</strong></span><span>Retry <strong>no second write</strong></span></div>`,
  }),
  scene({
    id: 12, start: 137, end: 155, eyebrow: "Same canonical contract", tone: "cloud",
    title: "Push one reviewed contract to Cloud.",
    caption: "The same canonical contract is pushed to Synapsor Cloud as an immutable version with a server digest.",
    body: `<div class="two-col cloud-push">${command(`$ synapsor-runner cloud push synapsor.contract.json\n\ncontract   support-plan-credit\nversion    ${cloudVersion}\ndigest     ${shortHash(cloudDigest, 26, 10)}\nstatus     ${cloud.complete ? "registered" : "capture pending"}`)}<div class="cloud-facts"><p><span class="check">&#10003;</span>Server-computed digest</p><p><span class="check">&#10003;</span>Immutable contract version</p><p><span class="check">&#10003;</span>Workspace-scoped registry</p><p><span class="check">&#10003;</span>Same OSS contract</p></div></div>`,
  }),
  scene({
    id: 13, start: 155, end: 169, eyebrow: "Synapsor Cloud / design-partner beta", tone: "cloud-ui",
    title: "The reviewed boundary becomes shared team state.",
    caption: "The Cloud registry exposes the reviewed boundary and exports a secret-free Runner bundle.",
    body: `<div class="cloud-ui-layout"><div class="browser-frame"><div class="browser-bar"><span></span><span></span><span></span><strong>Synapsor Cloud / Contract registry</strong></div>${cloudImageMarkup}</div><div class="bundle-proof"><small>Version ${e(String(cloudVersion))}</small><strong>${e(shortHash(cloudDigest, 14, 8))}</strong><p>${bundleEntries} bundle files</p><p><span class="check">&#10003;</span>required files present</p><p><span class="check">&#10003;</span>secret scan clean</p></div></div>`,
  }),
  scene({
    id: 14, start: 169, end: 177, eyebrow: "Open source Runner / Cloud design-partner beta", tone: "cta",
    title: "Reviewed business actions for agents.",
    caption: "Try the open-source Runner. Synapsor Cloud is available for design partners.",
    body: `<div class="cta-links"><div><small>Try the Runner</small><strong>github.com/Synapsor/Synapsor-Runner</strong></div><div><small>Read the architecture</small><strong>synapsor.ai/blog/stop-giving-agents-execute-sql</strong></div><div><small>Design partners</small><strong>synapsor.ai/contact</strong></div></div><p class="final-boundary">Business tools for the model. Approval and writeback outside the model. Replay for inspection.</p>`,
  }),
].join("\n");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1920,height=1080,initial-scale=1"><title>Synapsor launch demo</title>
<style>
  :root { color-scheme: light; --ink:#102b2b; --muted:#5c6f6d; --paper:#f4f8f7; --white:#fff; --line:#cbd9d6; --teal:#0f766e; --teal-dark:#095b55; --teal-soft:#dcefeb; --red:#b42318; --red-soft:#fbe7e5; --amber:#9a6700; --terminal:#101c1c; --terminal-text:#e7f4f1; }
  * { box-sizing:border-box; }
  html,body { width:1920px; height:1080px; margin:0; overflow:hidden; background:var(--paper); color:var(--ink); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; letter-spacing:0; }
  body::before { content:""; position:fixed; inset:0; background-image:linear-gradient(#dbe5e2 1px, transparent 1px),linear-gradient(90deg,#dbe5e2 1px,transparent 1px); background-size:64px 64px; opacity:.27; }
  .brandbar { position:fixed; z-index:20; left:76px; right:76px; top:36px; height:48px; display:flex; align-items:center; justify-content:space-between; border-bottom:1px solid var(--line); font-size:18px; }
  .brand { display:flex; align-items:center; gap:14px; font-weight:800; }
  .brand-mark { width:28px; height:28px; background:var(--teal); display:grid; place-items:center; color:#fff; font-size:15px; border-radius:4px; }
  .brand em { color:var(--muted); font-style:normal; font-weight:600; }
  .clock { display:flex; gap:20px; color:var(--muted); font-variant-numeric:tabular-nums; }
  .progress { position:fixed; z-index:21; left:0; top:0; height:6px; width:0; background:var(--teal); }
  .scene { position:absolute; inset:0; display:none; opacity:0; }
  .scene.active { display:block; opacity:1; }
  .scene-content { position:absolute; top:112px; left:120px; right:120px; bottom:190px; display:flex; flex-direction:column; justify-content:center; }
  .eyebrow { margin:0 0 20px; color:var(--teal); font-weight:800; font-size:19px; text-transform:uppercase; }
  h1 { max-width:1540px; margin:0 0 38px; font-size:58px; line-height:1.08; font-weight:760; }
  h1 code { color:var(--red); font-family:"SFMono-Regular",Consolas,monospace; font-size:.92em; }
  h2 { margin:0 0 12px; font-size:20px; }
  code,pre { font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace; letter-spacing:0; }
  .caption { position:absolute; z-index:5; left:120px; right:120px; bottom:46px; min-height:105px; display:grid; grid-template-columns:58px 1fr; align-items:center; gap:24px; padding:20px 28px; background:#fff; border-top:4px solid var(--teal); box-shadow:0 10px 30px rgba(16,43,43,.12); }
  .caption span { width:48px; height:48px; display:grid; place-items:center; color:#fff; background:var(--teal); border-radius:4px; font-weight:800; }
  .caption p { margin:0; font-size:25px; line-height:1.34; font-weight:650; }
  .two-col { display:grid; grid-template-columns:1.15fr .85fr; gap:44px; align-items:stretch; }
  .terminal { min-height:330px; overflow:hidden; background:var(--terminal); color:var(--terminal-text); border:1px solid #314443; box-shadow:0 16px 38px rgba(16,43,43,.16); }
  .terminal-bar,.browser-bar { height:48px; display:flex; align-items:center; gap:10px; padding:0 18px; background:#263736; color:#bed0cc; font-size:14px; }
  .terminal-bar span,.browser-bar span { width:12px; height:12px; border-radius:50%; background:#6d807d; }
  .terminal-bar strong,.browser-bar strong { margin-left:8px; font-weight:600; }
  .terminal pre { margin:0; padding:28px; white-space:pre-wrap; font-size:20px; line-height:1.55; }
  .finding-panel { padding:28px 32px; background:var(--white); border:1px solid var(--line); }
  .metric-row { display:grid; grid-template-columns:repeat(3,1fr); gap:14px; }
  .metric-row div { padding:18px; background:var(--red-soft); border-left:4px solid var(--red); }
  .metric-row strong { display:block; font-size:38px; color:var(--red); }
  .metric-row span { color:#7c302a; text-transform:uppercase; font-weight:800; font-size:14px; }
  .finding-list { list-style:none; margin:28px 0; padding:0; display:grid; gap:15px; font-size:20px; }
  .finding-list li { display:flex; align-items:center; gap:12px; }
  .fail-dot { width:10px; height:10px; background:var(--red); border-radius:50%; }
  .finding-panel>p { color:var(--muted); font-size:17px; }
  .hero-copy { margin:0; font-size:50px; line-height:1.15; }
  .hero-copy strong { color:var(--teal); }
  .hero-rule { width:180px; height:8px; background:var(--teal); margin:38px 0; }
  .supporting { max-width:1060px; margin:0; color:var(--muted); font-size:28px; line-height:1.45; }
  .code-sheet { display:grid; gap:15px; align-content:center; padding:32px 36px; background:#fff; border-left:6px solid var(--teal); box-shadow:0 14px 32px rgba(16,43,43,.1); }
  .code-sheet code,.code-sheet>span { font:20px/1.45 "SFMono-Regular",Consolas,monospace; }
  .code-sheet>span { color:var(--teal); font-weight:800; }
  .trust-flow { display:grid; grid-template-columns:1fr 48px 1fr; gap:12px; align-items:center; }
  .trust-flow>div { min-height:210px; display:flex; flex-direction:column; justify-content:center; padding:28px; background:var(--teal-soft); border:1px solid #b8d9d3; }
  .trust-flow small,.trust-flow span { color:var(--muted); font-size:16px; }
  .trust-flow strong { margin:14px 0; font-size:27px; overflow-wrap:anywhere; }
  .trust-flow>div:last-child strong { font-size:20px; white-space:nowrap; overflow-wrap:normal; }
  .trust-flow b { font-size:36px; color:var(--teal); text-align:center; }
  .boundary-grid { display:grid; grid-template-columns:1fr 1fr; gap:18px; }
  .boundary-grid>div { min-height:145px; padding:24px 28px; background:#fff; border-left:5px solid var(--teal); }
  .boundary-grid .kept-out { border-left-color:var(--red); background:#fff9f8; }
  .boundary-grid p { margin:0; font-size:20px; line-height:1.5; color:var(--muted); }
  .tool-surface { display:grid; grid-template-columns:1fr 1fr; gap:28px; }
  .tool-surface>div { padding:30px 34px; background:#fff; border:1px solid var(--line); }
  .tool-surface .exposed { border-top:6px solid var(--teal); }
  .tool-surface .excluded { border-top:6px solid var(--red); }
  .tool-surface p { display:flex; align-items:center; gap:14px; margin:14px 0; font-size:21px; }
  .tool-surface .excluded p span { color:var(--red); font-size:28px; }
  .check { color:var(--teal); font-weight:900; }
  .evidence-card { display:flex; flex-direction:column; justify-content:center; padding:34px; background:#fff; border-top:6px solid var(--teal); }
  .status-pill { align-self:flex-start; margin:0 0 18px; padding:7px 11px; background:var(--teal-soft); color:var(--teal-dark); font-weight:800; font-size:14px; }
  .evidence-card>strong { font-size:42px; }
  .evidence-card dl { display:grid; grid-template-columns:120px 1fr; gap:13px 18px; font-size:18px; }
  .evidence-card dt { color:var(--muted); }
  .evidence-card dd { margin:0; font-family:monospace; overflow-wrap:anywhere; }
  .proposal-head { display:flex; justify-content:space-between; align-items:center; padding:22px 28px; background:var(--terminal); color:#fff; }
  .proposal-head code { font-size:22px; }
  .proposal-head span { padding:8px 12px; background:#fff2cc; color:#714f00; font-weight:800; text-transform:uppercase; }
  .diff-grid { display:grid; grid-template-columns:1fr 1fr; gap:22px; margin:22px 0; }
  .diff-grid>div { padding:25px 28px; background:#fff; border:1px solid var(--line); }
  .diff-grid small { color:var(--muted); font-size:17px; }
  .diff-grid p { display:flex; gap:22px; align-items:center; margin:18px 0 0; font:27px/1.3 monospace; }
  del { color:var(--red); background:var(--red-soft); padding:7px 10px; }
  ins { color:var(--teal-dark); background:var(--teal-soft); padding:7px 10px; text-decoration:none; }
  .id-strip,.receipt-strip { display:flex; flex-wrap:wrap; gap:28px; padding:17px 24px; background:#e8eeec; font-size:16px; }
  .db-compare { display:grid; grid-template-columns:1fr 70px 1fr; align-items:center; gap:24px; }
  .db-compare>div:not(.equals) { display:flex; flex-direction:column; gap:10px; padding:34px; background:#fff; border:1px solid var(--line); }
  .db-compare small { color:var(--muted); font-size:18px; }
  .db-compare strong { font-size:54px; }
  .db-compare span { font-family:monospace; font-size:18px; }
  .equals { text-align:center; font-size:48px; color:var(--teal); }
  .unchanged { align-self:center; padding:14px 22px; background:var(--teal-soft); font-size:23px; font-weight:800; }
  .approval-layout { display:grid; grid-template-columns:1.15fr .85fr; gap:28px; }
  .approval-box { display:grid; grid-template-columns:170px 1fr; gap:18px; padding:32px; background:#fff; border-left:6px solid var(--amber); font-size:20px; }
  .approval-box>span { color:var(--muted); }
  .approval-box code { overflow-wrap:anywhere; }
  .approval-action { display:flex; flex-direction:column; justify-content:center; align-items:center; gap:12px; background:var(--teal-soft); border:1px solid #b8d9d3; }
  .approval-action strong { font-size:28px; }
  .approve-button { margin:12px 0; padding:17px 50px; background:var(--teal); color:#fff; font-size:24px; font-weight:800; border-radius:4px; }
  .approval-action small { color:var(--muted); }
  .guard-list { list-style:none; margin:0; padding:26px 32px; display:grid; gap:16px; background:#fff; font-size:20px; }
  .guard-list li { display:flex; gap:14px; align-items:center; }
  .result-change { display:flex; flex-direction:column; justify-content:center; padding:34px; background:var(--terminal); color:#fff; }
  .result-change small { color:#afc3bf; }
  .result-change>div { display:flex; align-items:center; gap:20px; margin:24px 0; font-size:34px; }
  .result-change strong { color:#75d1c5; font-size:46px; }
  .result-change p { color:#dcebe8; font-family:monospace; }
  .result-change em { align-self:flex-start; padding:8px 12px; background:var(--teal); font-style:normal; font-weight:800; }
  .replay-line { display:grid; grid-template-columns:repeat(6,1fr); gap:12px; list-style:none; padding:0; margin:10px 0 30px; }
  .replay-line li { position:relative; min-height:160px; padding:22px 18px; background:#fff; border-top:5px solid var(--teal); }
  .replay-line li span { display:grid; place-items:center; width:34px; height:34px; background:var(--teal-soft); color:var(--teal-dark); font-weight:800; }
  .replay-line li strong { display:block; margin-top:20px; font-size:17px; text-transform:capitalize; }
  .cloud-facts { display:grid; gap:14px; align-content:center; padding:30px; background:#fff; border-top:6px solid var(--teal); }
  .cloud-facts p { margin:0; display:flex; gap:13px; font-size:21px; }
  .cloud-ui-layout { display:grid; grid-template-columns:1fr 330px; gap:24px; min-height:520px; }
  .browser-frame { overflow:hidden; background:#fff; border:1px solid var(--line); box-shadow:0 14px 34px rgba(16,43,43,.13); }
  .browser-bar { background:#dce5e3; color:var(--ink); }
  .cloud-shot { display:block; width:100%; height:520px; object-fit:cover; object-position:center 85%; }
  .cloud-placeholder { height:520px; display:flex; flex-direction:column; justify-content:center; align-items:center; gap:12px; color:var(--muted); }
  .bundle-proof { padding:30px; background:var(--terminal); color:#fff; }
  .bundle-proof small { color:#afc3bf; }
  .bundle-proof>strong { display:block; margin:16px 0 30px; color:#75d1c5; font:19px/1.5 monospace; overflow-wrap:anywhere; }
  .bundle-proof p { font-size:18px; }
  .cta-links { display:grid; grid-template-columns:1fr; gap:12px; max-width:1400px; }
  .cta-links>div { display:grid; grid-template-columns:250px 1fr; align-items:center; padding:20px 26px; background:#fff; border-left:6px solid var(--teal); }
  .cta-links small { color:var(--muted); font-size:17px; }
  .cta-links strong { font-size:25px; overflow-wrap:anywhere; }
  .final-boundary { margin:24px 0 0; color:var(--teal-dark); font-size:22px; font-weight:800; }
</style></head><body>
<div class="progress" id="progress"></div>
<header class="brandbar"><div class="brand"><span class="brand-mark">S</span><span>SYNAPSOR</span><em>Runner</em></div><div class="clock"><span id="scene-label">01 / 14</span><span id="timecode">00:00</span></div></header>
<main>${scenes}</main>
<script>
  const duration = 177;
  const scenes = [...document.querySelectorAll('.scene')];
  const progress = document.getElementById('progress');
  const timecode = document.getElementById('timecode');
  const sceneLabel = document.getElementById('scene-label');
  window.__setDemoTime = (milliseconds) => {
    const seconds = Math.max(0, Math.min(duration - 0.001, milliseconds / 1000));
    let activeIndex = 0;
    scenes.forEach((item, index) => {
      const start = Number(item.dataset.start);
      const end = Number(item.dataset.end);
      const active = seconds >= start && seconds < end;
      item.classList.toggle('active', active);
      if (active) activeIndex = index;
    });
    progress.style.width = ((seconds / duration) * 100) + '%';
    timecode.textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(Math.floor(seconds % 60)).padStart(2, '0');
    sceneLabel.textContent = String(activeIndex + 1).padStart(2, '0') + ' / ' + String(scenes.length).padStart(2, '0');
    return { seconds, activeIndex };
  };
  window.__setDemoTime(0);
  window.__DEMO_READY = true;
</script></body></html>`;

await writeFile(outputPath, html, { mode: 0o600 });
console.log(`Rendered deterministic demo deck: ${path.resolve(outputPath)}`);
