import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [resultsPath, outputPath] = process.argv.slice(2);
if (!resultsPath || !outputPath) {
  throw new Error("usage: render-safe-action-deck.mjs <results.json> <output.html>");
}

const data = JSON.parse(await readFile(resultsPath, "utf8"));
const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const e = escapeHtml;
const money = (value) => `$${(Number(value) / 100).toFixed(2)}`;
const shortHash = (value) => {
  const text = String(value ?? "");
  return text.length > 34 ? `${text.slice(0, 22)}...${text.slice(-8)}` : text;
};
const proposal = data.proposal;
const stale = data.stale_conflict;
if (!proposal || !stale || stale.state_after_apply !== "conflict") {
  throw new Error("recorded proposal and stale-conflict evidence are required");
}

const scene = ({ id, eyebrow, title, body, caption }) => `
<section class="scene" data-scene="${id}" data-start="${(id - 1) * 4.5}" data-end="${id * 4.5}">
  <div class="content"><p class="eyebrow">${e(eyebrow)}</p><h1>${title}</h1>${body}</div>
  <footer><span>${String(id).padStart(2, "0")}</span><p>${e(caption)}</p></footer>
</section>`;

const scenes = [
  scene({
    id: 1,
    eyebrow: "Cursor / project MCP",
    title: "Ask for one business change.",
    caption: "Cursor sees a reviewed semantic tool, not SQL, credentials, approval, or commit authority.",
    body: `<div class="chat"><small>Developer</small><strong>Give CUS-3001 a $100 plan credit for SLA ticket SUP-481.</strong></div><div class="surface"><code>support.propose_plan_credit</code><span>reviewed model-facing tool</span></div>`,
  }),
  scene({
    id: 2,
    eyebrow: "Semantic proposal",
    title: "A request becomes a proposal, not a write.",
    caption: "The semantic capability records immutable intent and evidence. The source is not mutated.",
    body: `<div class="terminal"><code>${e(proposal.capability)}({ customer_id: "${e(proposal.object_id)}", credit_cents: 10000 })</code><dl><dt>Proposal</dt><dd>${e(proposal.proposal_id)}</dd><dt>Status</dt><dd>review required</dd><dt>Evidence</dt><dd>${e(proposal.evidence_bundle_id)}</dd></dl></div>`,
  }),
  scene({
    id: 3,
    eyebrow: "Exact Data PR",
    title: "Review the effect before it exists.",
    caption: "The Data PR freezes the exact before and proposed values under the trusted tenant scope.",
    body: `<div class="data-pr"><div><small>plan_credit_cents</small><p><del>${proposal.diff.plan_credit_cents.before}</del><b>&rarr;</b><ins>${proposal.diff.plan_credit_cents.proposed}</ins></p></div><div><small>credit_reason</small><p><del>null</del><b>&rarr;</b><ins>${e(proposal.diff.credit_reason.proposed)}</ins></p></div></div><p class="idline">${e(proposal.proposal_id)} / tenant ${e(proposal.tenant_id)}</p>`,
  }),
  scene({
    id: 4,
    eyebrow: "Proposal is not commit",
    title: "Postgres is still unchanged.",
    caption: "Before approval, the proposal ledger changed and the application row did not.",
    body: `<div class="compare"><div><small>Before proposal</small><strong>${money(data.source_state.before.plan_credit_cents)}</strong></div><b>=</b><div><small>After proposal</small><strong>${money(data.source_state.after_proposal.plan_credit_cents)}</strong></div></div><p class="proof ok">Source database changed: No</p>`,
  }),
  scene({
    id: 5,
    eyebrow: "Outside MCP",
    title: "A human controls approval.",
    caption: "The secured Workbench holds the approval control. The agent has no route to it.",
    body: `<div class="approval"><div><small>Exact proposal</small><code>${e(proposal.proposal_id)}</code><small>Required role</small><strong>${e(data.approval.required_role)}</strong></div><div><small>Verified decision surface</small><button>Approve outside MCP</button><p>No model-facing approval tool</p></div></div>`,
  }),
  scene({
    id: 6,
    eyebrow: "Guarded commit",
    title: "One reviewed row changes. A receipt remains.",
    caption: "Runner rechecks approval, tenant, fields, version, bounds, affected rows, and idempotency.",
    body: `<div class="commit"><ul>${data.writeback.checks.map((item) => `<li><span>&#10003;</span>${e(item)}</li>`).join("")}</ul><div><small>Committed value</small><strong>${money(data.source_state.after_apply.plan_credit_cents)}</strong><small>Receipt</small><code>${e(shortHash(data.writeback.receipt_hash))}</code></div></div>`,
  }),
  scene({
    id: 7,
    eyebrow: "Idempotent retry",
    title: "Retry cannot apply the change twice.",
    caption: "Runner observes the terminal applied state. The source remains $100 and no second mutation occurs.",
    body: `<div class="retry"><div><small>First apply</small><strong>1 row</strong><span>applied</span></div><div><small>Retry</small><strong>0 rows</strong><span>already terminal</span></div><div><small>Source after retry</small><strong>${money(data.source_state.after_apply.plan_credit_cents)}</strong><span>unchanged</span></div></div>`,
  }),
  scene({
    id: 8,
    eyebrow: "Stale-write refusal",
    title: "Changed data fails closed.",
    caption: "A separately approved stale proposal hits the version guard: conflict, zero rows, no overwrite.",
    body: `<div class="stale"><div><small>Stale proposal</small><code>${e(stale.proposal_id)}</code><p>${money(stale.diff.plan_credit_cents.before)} &rarr; ${money(stale.diff.plan_credit_cents.proposed)}</p></div><div class="blocked"><strong>VERSION CONFLICT</strong><span>0 rows affected</span><span>Source remains ${money(stale.source_after_refusal.plan_credit_cents)}</span></div></div><p class="cta">Let AI agents change real application data without giving the model SQL. <b>github.com/Synapsor/Synapsor-Runner</b></p>`,
  }),
].join("\n");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=1920,height=1080,initial-scale=1"><title>Synapsor safe action demo</title>
<style>
:root{--ink:#102b2b;--muted:#536b68;--paper:#f4f8f7;--white:#fff;--line:#c4d5d2;--teal:#087f74;--teal-dark:#075b55;--teal-soft:#d8efeb;--red:#b42318;--red-soft:#fae4e1;--amber:#8a6100;--dark:#112827}*{box-sizing:border-box}html,body{width:1920px;height:1080px;margin:0;overflow:hidden;background:var(--paper);color:var(--ink);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:0}.progress{position:fixed;z-index:20;top:0;left:0;height:7px;background:var(--teal)}header{position:fixed;z-index:10;top:34px;left:84px;right:84px;height:58px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line)}.brand{display:flex;align-items:center;gap:14px;font-size:19px;font-weight:800}.mark{display:grid;width:34px;height:34px;place-items:center;border-radius:6px;background:var(--teal);color:#fff}.clock{color:var(--muted);font:17px/1.2 ui-monospace,monospace}.scene{position:absolute;inset:0;display:none}.scene.active{display:block}.content{position:absolute;top:130px;right:116px;bottom:190px;left:116px;display:flex;flex-direction:column;justify-content:center}.eyebrow{margin:0 0 18px;color:var(--teal-dark);font-size:20px;font-weight:800;text-transform:uppercase}h1{max-width:1560px;margin:0 0 34px;font-size:66px;line-height:1.08;font-weight:760;letter-spacing:0}footer{position:absolute;right:116px;bottom:42px;left:116px;display:grid;min-height:110px;grid-template-columns:58px 1fr;align-items:center;gap:24px;border-top:5px solid var(--teal);background:#fff;padding:20px 28px;box-shadow:0 15px 38px rgba(16,43,43,.12)}footer span{display:grid;width:50px;height:50px;place-items:center;border-radius:5px;background:var(--teal);color:#fff;font-weight:800}footer p{margin:0;font-size:27px;line-height:1.35;font-weight:620}.chat{max-width:1300px;border-left:7px solid var(--teal);background:#fff;padding:34px 40px;box-shadow:0 18px 40px rgba(16,43,43,.12)}.chat small,.surface span,small{display:block;color:var(--muted);font-size:19px}.chat strong{display:block;margin-top:14px;font-size:36px;line-height:1.35}.surface{display:flex;max-width:1300px;align-items:center;justify-content:space-between;margin-top:20px;background:var(--dark);padding:24px 32px;color:#fff}.surface code{font-size:27px;color:#8be0d6}.terminal{max-width:1450px;background:var(--dark);color:#edf8f6;padding:34px 40px}.terminal>code{font-size:25px;color:#8be0d6}.terminal dl{display:grid;grid-template-columns:180px 1fr;gap:16px 26px;margin:30px 0 0;font-size:21px}.terminal dt{color:#a9bfbb}.terminal dd{margin:0;font-family:ui-monospace,monospace;overflow-wrap:anywhere}.data-pr{display:grid;grid-template-columns:1fr 1fr;gap:24px}.data-pr>div{background:#fff;border:1px solid var(--line);padding:32px}.data-pr p{display:flex;align-items:center;gap:24px;margin:20px 0 0;font:34px/1.3 ui-monospace,monospace}.data-pr del{background:var(--red-soft);color:var(--red);padding:10px 14px}.data-pr ins{background:var(--teal-soft);color:var(--teal-dark);padding:10px 14px;text-decoration:none;overflow-wrap:anywhere}.idline{margin:18px 0 0;background:#e6eeec;padding:18px 24px;font:19px/1.3 ui-monospace,monospace}.compare{display:grid;grid-template-columns:1fr 90px 1fr;align-items:center;gap:28px}.compare>div{background:#fff;border:1px solid var(--line);padding:42px}.compare strong{display:block;margin-top:16px;font-size:74px}.compare>b{text-align:center;color:var(--teal);font-size:64px}.proof{align-self:flex-start;margin:26px 0 0;padding:18px 26px;font-size:27px;font-weight:800}.ok{background:var(--teal-soft);color:var(--teal-dark)}.approval{display:grid;grid-template-columns:1.08fr .92fr;gap:28px}.approval>div{display:flex;min-height:300px;flex-direction:column;justify-content:center;gap:15px;background:#fff;padding:36px;border:1px solid var(--line)}.approval code{font-size:23px;overflow-wrap:anywhere}.approval strong{font-size:32px}.approval button{border:0;border-radius:6px;background:var(--teal);padding:20px;color:#fff;font-size:28px;font-weight:800}.approval p{margin:0;color:var(--red);font-size:20px;font-weight:700;text-align:center}.commit{display:grid;grid-template-columns:1.05fr .95fr;gap:28px}.commit>ul,.commit>div{margin:0;background:#fff;border:1px solid var(--line);padding:32px}.commit ul{display:grid;grid-template-columns:1fr 1fr;gap:18px;list-style:none;font-size:21px}.commit li{display:flex;align-items:center;gap:12px}.commit li span{color:var(--teal);font-weight:900}.commit>div{display:flex;flex-direction:column;justify-content:center}.commit strong{margin:10px 0 24px;font-size:68px;color:var(--teal-dark)}.commit code{margin-top:10px;font-size:20px;overflow-wrap:anywhere}.retry{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}.retry>div{display:flex;min-height:270px;flex-direction:column;justify-content:center;background:#fff;border-top:7px solid var(--teal);padding:32px}.retry strong{margin:18px 0;font-size:62px}.retry span{color:var(--teal-dark);font-size:22px;font-weight:750}.stale{display:grid;grid-template-columns:1.1fr .9fr;gap:26px}.stale>div{display:flex;min-height:260px;flex-direction:column;justify-content:center;background:#fff;border:1px solid var(--line);padding:34px}.stale code{margin:15px 0;font-size:20px;overflow-wrap:anywhere}.stale p{margin:8px 0 0;font-size:38px;font-weight:750}.stale .blocked{background:var(--red-soft);border-left:7px solid var(--red)}.blocked strong{color:var(--red);font-size:36px}.blocked span{margin-top:18px;font-size:24px;font-weight:700}.cta{display:flex;justify-content:space-between;gap:30px;margin:22px 0 0;background:var(--dark);padding:22px 28px;color:#fff;font-size:21px}.cta b{color:#8be0d6;white-space:nowrap}code{font-family:ui-monospace,"SFMono-Regular",Consolas,monospace;letter-spacing:0}
.surface span{color:#c6d7d4}
</style></head><body><div class="progress" id="progress"></div><header><div class="brand"><span class="mark">S</span><span>SYNAPSOR RUNNER</span></div><div class="clock"><span id="scene-label">01 / 08</span> &nbsp; <span id="timecode">00:00</span></div></header><main>${scenes}</main><script>
const duration=36;const scenes=[...document.querySelectorAll('.scene')];const progress=document.getElementById('progress');const timecode=document.getElementById('timecode');const sceneLabel=document.getElementById('scene-label');window.__setDemoTime=(milliseconds)=>{const seconds=Math.max(0,Math.min(duration-.001,milliseconds/1000));let activeIndex=0;scenes.forEach((item,index)=>{const active=seconds>=Number(item.dataset.start)&&seconds<Number(item.dataset.end);item.classList.toggle('active',active);if(active)activeIndex=index});progress.style.width=((seconds/duration)*100)+'%';timecode.textContent='00:'+String(Math.floor(seconds)).padStart(2,'0');sceneLabel.textContent=String(activeIndex+1).padStart(2,'0')+' / 08';return{seconds,activeIndex}};window.__setDemoTime(0);window.__DEMO_READY=true;
</script></body></html>`;

await writeFile(outputPath, html, { mode: 0o600 });
console.log(`Rendered deterministic Safe Action deck: ${path.resolve(outputPath)}`);
