export function renderBoundaryWorkbench(csrfToken: string): string {
  const escapedCsrf = escapeScriptString(csrfToken);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Auto Boundary Review | Synapsor Runner</title>
  <style>
    :root{color-scheme:light dark;--bg:#f4f7f7;--surface:#fff;--surface-2:#eef3f3;--text:#172126;--muted:#5d6b70;--line:#cbd7d9;--accent:#087f73;--accent-soft:#e1f3f0;--warn:#8a5a00;--warn-soft:#fff4d6;--bad:#b42318;--bad-soft:#ffebe8;--good:#137333;--good-soft:#e8f5eb}
    @media(prefers-color-scheme:dark){:root{--bg:#111718;--surface:#192124;--surface-2:#222d30;--text:#edf3f2;--muted:#aab7b8;--line:#3a4a4f;--accent:#55c9b9;--accent-soft:#173c38;--warn:#f4c86a;--warn-soft:#3d3219;--bad:#ff8d84;--bad-soft:#3f2221;--good:#70d58c;--good-soft:#1d3826}}
    *{box-sizing:border-box;letter-spacing:0}
    body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    header{background:var(--surface);border-bottom:1px solid var(--line)}
    header>div,main{width:min(1120px,calc(100% - 32px));margin:auto}
    header>div{min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:16px}
    h1{font-size:20px;margin:0}h2{font-size:18px;margin:0 0 8px}h3{font-size:15px;margin:0}
    p{margin:6px 0;color:var(--muted)}main{padding:20px 0 48px}
    button,input,select,textarea{font:inherit}
    button{min-height:38px;padding:8px 13px;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer}
    button.secondary{background:transparent;color:var(--accent)}button.quiet{background:var(--surface-2);border-color:var(--line);color:var(--text)}
    button.danger{background:var(--bad);border-color:var(--bad)}button:disabled{opacity:.5;cursor:not-allowed}
    button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
    input[type=text],input[type=number],input[type=datetime-local],select,textarea{width:100%;min-height:38px;padding:7px 9px;border:1px solid var(--line);border-radius:5px;background:var(--surface);color:var(--text)}
    input[type=checkbox],input[type=radio]{width:16px;height:16px;accent-color:var(--accent)}
    label.field{display:flex;flex-direction:column;gap:5px;color:var(--muted)}
    code,pre{font:12px ui-monospace,SFMono-Regular,Consolas,monospace}code{overflow-wrap:anywhere}
    pre{white-space:pre-wrap;overflow:auto;max-height:420px;background:var(--surface-2);border:1px solid var(--line);padding:12px;border-radius:5px}
    .state{font-weight:700;color:var(--warn)}.state.good{color:var(--good)}
    .steps{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));border:1px solid var(--line);background:var(--surface);margin-bottom:18px}
    .step{min-height:52px;border:0;border-right:1px solid var(--line);border-radius:0;background:transparent;color:var(--muted);font-weight:600;text-align:left}
    .step:last-child{border-right:0}.step.active{background:var(--accent-soft);color:var(--accent);box-shadow:inset 0 -3px var(--accent)}
    .step.done{color:var(--good)}.view{display:none}.view.active{display:block}
    .band{background:var(--surface);border:1px solid var(--line);padding:16px;margin:12px 0;border-radius:6px}
    .notice{border-left:4px solid var(--warn);background:var(--warn-soft)}.success{border-left:4px solid var(--good);background:var(--good-soft)}
    .error{border-left:4px solid var(--bad);background:var(--bad-soft);color:var(--bad)}
    .summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--line);background:var(--surface)}
    .metric{padding:13px;border-right:1px solid var(--line)}.metric:last-child{border-right:0}.metric strong{display:block;font-size:21px}.metric span{color:var(--muted)}
	    .toolbar,.actions,.split-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.actions{margin-top:14px}.split-actions{justify-content:space-between}
	    .journey{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:16px}.journey strong{display:block}.journey p{margin:2px 0}
    .resource-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
    .resource{border:1px solid var(--line);background:var(--surface);padding:14px;border-radius:6px;min-width:0}
    .resource-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.resource-name{overflow-wrap:anywhere}
    .badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}.badge{display:inline-flex;padding:3px 7px;border-radius:999px;border:1px solid var(--line);font-size:12px;color:var(--muted);background:var(--surface-2)}
    .badge.bad{color:var(--bad);background:var(--bad-soft);border-color:var(--bad)}.badge.warn{color:var(--warn);background:var(--warn-soft);border-color:var(--warn)}.badge.good{color:var(--good);background:var(--good-soft);border-color:var(--good)}
    .risk-list{display:grid;gap:8px;margin-top:12px}.risk{border-left:3px solid var(--line);padding:9px 11px;background:var(--surface-2)}.risk.high{border-color:var(--bad)}.risk.unresolved{border-color:var(--warn)}
    .review-form{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
    .scope-grid,.form-grid,.preflight{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.preflight{grid-template-columns:repeat(3,minmax(0,1fr))}
    .check{display:flex;align-items:flex-start;gap:8px}.check input{flex:0 0 auto;margin-top:3px}
    details{border-top:1px solid var(--line);margin-top:14px;padding-top:10px}summary{cursor:pointer;color:var(--accent);font-weight:700}
    table{width:100%;table-layout:fixed;border-collapse:collapse;margin-top:10px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th{color:var(--muted);font-size:12px}
    .permission-table th:first-child{width:25%}.permission{display:flex;justify-content:center}
    .footer-actions{position:sticky;bottom:0;background:var(--surface);border:1px solid var(--line);padding:12px;margin-top:18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;z-index:2}
    .status-message{flex:1 1 260px;min-height:20px;color:var(--muted)}
    .question-list{display:grid;gap:8px}.question{width:100%;text-align:left;background:var(--surface);color:var(--text);border-color:var(--line)}
    .question.selected{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
    .action-fields{display:grid;gap:10px;margin-top:10px}.action-field{border:1px solid var(--line);background:var(--surface-2);padding:12px;border-radius:6px}.action-field-settings{margin-top:10px}
    .result-meta{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0}.result-table{overflow:auto}
    .tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin-bottom:12px}.tab{background:transparent;color:var(--muted);border:0;border-bottom:3px solid transparent;border-radius:0}.tab.active{color:var(--accent);border-bottom-color:var(--accent)}
    .hidden{display:none!important}.screen-reader{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
	    @media(max-width:820px){.steps{grid-template-columns:1fr}.step{border-right:0;border-bottom:1px solid var(--line)}.summary{grid-template-columns:1fr 1fr}.metric:nth-child(2){border-right:0}.resource-list,.scope-grid,.form-grid,.preflight,.journey{grid-template-columns:1fr}.footer-actions{position:static}}
    @media(max-width:480px){header>div,main{width:calc(100% - 20px)}.summary{grid-template-columns:1fr}.metric{border-right:0;border-bottom:1px solid var(--line)}.toolbar>*,.actions>button{width:100%}}
  </style>
</head>
<body>
  <header><div><h1>Synapsor boundary review</h1><span id="header-state" class="state">Loading</span></div></header>
  <main>
    <nav class="steps" aria-label="Boundary review progress">
      <button class="step active" data-view="overview" type="button">1. Overview</button>
      <button class="step" data-view="exceptions" type="button">2. Review exceptions</button>
      <button class="step" data-view="activate" type="button">3. Sign off</button>
      <button class="step" data-view="explore" type="button">4. Explore</button>
      <button class="step" data-view="protect" type="button">5. Protect</button>
      <button class="step" data-view="action" type="button">6. Add action</button>
    </nav>

	    <section id="view-overview" class="view active">
	      <h2>What the agent can access</h2>
	      <div class="band">
	        <strong>Synapsor is creating the small set of database powers your agent may use.</strong>
	        <p>It does not give the agent SQL access. Reads return only the fields you approve. Writes create proposals and cannot be approved or applied by the model.</p>
	      </div>
	      <div id="overview-notice" class="band notice">Source rows remain unavailable until the exact reviewed boundary is active.</div>
	      <div id="journey-state" class="band journey" aria-live="polite"></div>
	      <div id="database-summary" class="band"></div>
	      <div id="summary" class="summary" aria-live="polite"></div>
      <div class="split-actions" style="margin-top:16px">
        <div>
          <h2>Reviewed resource pack</h2>
          <p>Open each resource with risks or unresolved scope. The complete field matrix is under Advanced permissions.</p>
        </div>
	        <div class="toolbar">
	          <button id="show-risks" class="secondary" type="button">Show only risks</button>
	          <button id="show-exposed" class="secondary" type="button">Show exposed</button>
	          <button id="show-unresolved" class="secondary" type="button">Show unresolved</button>
	        </div>
	      </div>
	      <div id="resources" class="resource-list"></div>
	      <div class="actions"><button id="overview-primary" data-next="exceptions" type="button">Review security exceptions</button></div>
	      <details class="band"><summary>Existing project actions</summary><p>Resume does not inspect the database or rewrite files. Rescan is explicit. Start over resets managed boundary-review decisions but preserves the ledger, protected named capabilities, Runner config, and source database.</p><div class="actions"><button class="secondary" id="resume-review" type="button">Resume existing review</button><button class="secondary" id="try-active" type="button">Try active tools</button><button class="quiet" id="rescan-project" type="button">Rescan and review changes</button><button class="danger" id="start-over" type="button">Start over review</button></div><div id="project-action-message"></div></details>
	    </section>

    <section id="view-exceptions" class="view">
      <h2>Security-critical exceptions</h2>
      <p>Resolve fields, row identity, tenant scope, and principal scope before signing the boundary.</p>
      <div class="band">
        <h3>Blocked Objects And Disabled Actions</h3>
        <p>Blocked resources and every write-action draft stay disabled. This review can only narrow the generated read boundary.</p>
      </div>
      <div id="resource-detail" class="band"><p>Select a resource from Overview.</p></div>
      <div id="global-decisions" class="band"></div>
      <div class="actions"><button data-next="activate" type="button">Continue to sign-off</button></div>
    </section>

    <section id="view-activate" class="view">
      <h2>Sign off on the exact boundary</h2>
      <div id="signoff-summary" class="band"></div>
      <div class="form-grid">
        <label class="field">Deployment profile
          <select id="deployment-profile"><option value="staging">Staging</option><option value="development">Development</option></select>
        </label>
        <label class="field">Operator identity
          <input id="actor" type="text" maxlength="128" placeholder="alex@example.com" autocomplete="username">
          <span>Recorded as the local human who reviewed this digest. This is not a password or API key.</span>
        </label>
      </div>
      <div id="role-posture" class="band"></div>
      <div class="footer-actions">
        <button id="preview" class="secondary" type="button">Preview exact digest</button>
        <button id="activate" type="button" disabled>Activate reviewed boundary</button>
        <span id="message" class="status-message" role="status" aria-live="polite"></span>
      </div>
    </section>

    <section id="view-explore" class="view">
      <h2>Explore reviewed data</h2>
      <p>Choose only from the fields and operations already activated for this local development or staging session.</p>
      <div id="explore-preflight" class="band"><button id="run-preflight" type="button">Check and open Explore</button></div>
      <div id="explorer" class="hidden">
        <div class="band">
          <div class="tabs" role="tablist" aria-label="Explore mode">
            <button id="aggregate-tab" class="tab active" type="button" role="tab">Aggregate</button>
            <button id="row-tab" class="tab" type="button" role="tab">Exact row</button>
          </div>
          <div id="suggested-questions" class="question-list"></div>
          <div id="aggregate-builder" class="form-grid" style="margin-top:14px"></div>
          <div id="row-builder" class="form-grid hidden" style="margin-top:14px"></div>
          <details><summary>Advanced structured plan</summary><pre id="plan-preview"></pre></details>
          <div class="actions"><button id="run-explore" type="button">Run bounded exploration</button></div>
        </div>
        <div id="explore-status" class="status-message" role="status" aria-live="polite"></div>
        <div id="explore-result"></div>
        <details class="band"><summary>Use an external MCP client</summary><div id="client-configs"></div></details>
      </div>
    </section>

    <section id="view-protect" class="view">
      <h2>Protect This Query</h2>
      <p>Turn one successful exploration into public DSL and a disabled named capability. Activation remains a separate human decision.</p>
      <div class="actions"><button id="refresh-protect" class="secondary" type="button">Refresh recent results</button></div>
      <div id="protect-queries"></div>
      <div id="protect-editor"></div>
      <span id="protect-message" class="status-message" role="status" aria-live="polite"></span>
    </section>

    <section id="view-action" class="view">
      <h2>Add a safe action</h2>
      <p>Define one business action. Runner supplies only inspected structure; you choose the authority, bounds, and reviewers.</p>
      <div class="band notice">
        <strong>Writes remain proposals.</strong>
        <p>This wizard never infers business write authority. Every draft starts disabled, and the model cannot activate, approve, or apply it.</p>
      </div>
      <div id="action-loading" class="band"><button id="load-action" type="button">Review available action shapes</button></div>
      <div id="action-wizard" class="hidden">
        <section class="band">
          <div class="form-grid">
            <label class="field">Target resource<select id="action-resource"></select></label>
            <label class="field">Operation<select id="action-operation"></select></label>
            <label class="field">Business capability name<input id="action-name" type="text" maxlength="160" placeholder="membership.set_loyalty_balance"></label>
            <label class="field">What may the agent propose?<input id="action-description" type="text" maxlength="500" placeholder="Propose a reviewed loyalty balance for one assigned member."></label>
          </div>
          <div id="action-operation-note" class="band"></div>
          <h3>Allowed changes</h3>
          <p>Select only the fields this named action needs. Numeric and text arguments require explicit bounds.</p>
          <div id="action-fields" class="action-fields"></div>
          <div class="form-grid" style="margin-top:14px">
            <label class="field">Conflict / version guard<select id="action-conflict"></select></label>
            <label class="field">Version advancement<select id="action-version"><option value="integer_increment">Runner increments an integer version</option><option value="database_generated">Database generates the next version</option></select></label>
            <label class="field">Insert deduplication identity<select id="action-dedup"></select></label>
            <label class="field">Approval role<input id="action-role" type="text" maxlength="128" value="operator_reviewer"></label>
            <label class="field">Required distinct approvals<input id="action-quorum" type="number" min="1" max="10" value="1"></label>
            <label class="field">Receipt authority<select id="action-receipts"><option value="runner_ledger">Runner ledger, no source receipt table</option><option value="source_auto_migrate">Source database, Runner creates receipt table</option><option value="source_precreated">Source database, precreated receipt table</option></select></label>
            <label class="field">Write credential environment name<input id="action-write-env" type="text" maxlength="128" value="SYNAPSOR_DATABASE_WRITE_URL"></label>
          </div>
          <p class="muted">The approval role is a Synapsor contract role, not a database role or secret. In production, Runner requires that exact role in a freshly verified operator identity. <a href="https://github.com/Synapsor/Synapsor-Runner/blob/main/docs/approval-roles-and-operator-identity.md" target="_blank" rel="noreferrer">Trace the role from IdP claim to approval and apply</a>.</p>
          <label class="check" style="margin-top:14px"><input id="action-auto" type="checkbox"><span>Allow a small bounded case to be policy-approved. Off by default.</span></label>
          <div id="action-auto-settings" class="form-grid hidden" style="margin-top:10px">
            <label class="field">Bounded numeric field<select id="action-auto-field"></select></label>
            <label class="field">Maximum automatic value<input id="action-auto-max" type="number" min="0" value="25"></label>
            <label class="field">Maximum per day<input id="action-auto-count" type="number" min="1" value="20"></label>
            <label class="field">Maximum total value per day<input id="action-auto-total" type="number" min="1" value="500"></label>
          </div>
          <label class="check" style="margin-top:12px"><input id="action-supervised-worker" type="checkbox"><span>Permit a separately trusted Runner worker to apply eligible approved proposals. Off by default.</span></label>
          <p class="muted">This adds only contract-side permission. Automatic execution still requires a separate operator-owned deployment allowlist for this exact activated digest; the model can configure neither side.</p>
          <label class="check" style="margin-top:12px"><input id="action-reversible" type="checkbox"><span>Create reviewed compensation authority. This is available only for a human-approved integer-version UPDATE.</span></label>
          <label class="check" style="margin-top:12px"><input id="action-scope-confirm" type="checkbox"><span>I confirm this action inherits the reviewed tenant and principal scope shown above.</span></label>
          <label id="action-delete-confirm-wrap" class="field hidden" style="margin-top:12px">Exact delete confirmation<input id="action-delete-confirm" type="text"></label>
          <details><summary>Advanced boundary details</summary><div id="action-boundary-details"></div></details>
          <div class="actions"><button id="create-action" type="button">Generate disabled action</button></div>
          <div id="action-status" class="status-message" role="status" aria-live="polite"></div>
          <div id="action-draft"></div>
        </section>
      </div>
    </section>
  </main>
  <script>
    const csrf="${escapedCsrf}";
    let original;
    let candidate;
    let reviewReport;
    let activeBoundary;
    let candidateDigest;
	    let currentView="overview";
	    let resourceFilter="all";
	    let journey=null;
    let selectedResource=null;
    let openedResources=new Set();
    let confirmedDecisions=new Set();
    let exploreDescription=null;
    let exploreBudgets=null;
    let exploreMode="aggregate";
    let lastExplorePlan=null;
    let protectQueries=[];
    let selectedProtect=null;
    let protectedDraft=null;
    let guidedActionData=null;
    let guidedActionDraft=null;
    let reviewProgressHealthy=true;
    let progressSave=Promise.resolve();
    const permissions=[
      ["Raw","selectable_fields"],
      ["Filter","filterable_fields"],
      ["Sort","sortable_fields"],
      ["Group","groupable_fields"],
      ["Sum / avg","aggregate_measures"],
      ["Count distinct","count_distinct_fields"],
      ["Time bucket","time_bucket_fields"]
    ];

    const byId=id=>document.getElementById(id);
    const esc=value=>String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
    const getJson=async url=>{const response=await fetch(url);const payload=await response.json();if(!response.ok||!payload.ok){const error=new Error(payload.error||"Request failed");error.payload=payload;throw error}return payload};
    const post=async(url,body)=>{const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json","x-synapsor-csrf":csrf},body:JSON.stringify(body)});const payload=await response.json();if(!response.ok||!payload.ok){const error=new Error(payload.error||"Request failed");error.payload=payload;throw error}return payload};
    const currentResource=id=>candidate&&candidate.pack.resources.find(resource=>resource.id===id);
    const reviewResource=id=>(reviewReport&&reviewReport.resources||[]).find(resource=>resource.id===id);
    const resourceDecisions=id=>(reviewReport.unresolved_decisions||[]).filter(decision=>decision.startsWith(id+":"));
    const globalDecisions=()=>(reviewReport.unresolved_decisions||[]).filter(decision=>!(reviewReport.resources||[]).some(resource=>decision.startsWith(resource.id+":")));
    const classificationFor=(id,field)=>{const resource=reviewResource(id);return resource&&resource.fields&&resource.fields.find(item=>item.name===field)?.sensitivity};
    const stateLabel=state=>state==="high_confidence_sensitive"?"Sensitive":state==="unresolved_free_text"?"Needs review":"Low structural risk";

    function setView(view){
      currentView=view;
      document.querySelectorAll(".view").forEach(node=>node.classList.toggle("active",node.id==="view-"+view));
      document.querySelectorAll(".step").forEach(node=>node.classList.toggle("active",node.dataset.view===view));
      if(view==="activate")renderSignoff();
      if(view==="explore"&&activeBoundary)runPreflight();
      if(view==="protect")loadProtect();
      if(view==="action")loadGuidedAction();
      window.scrollTo({top:0,behavior:"smooth"});
    }

    function authorityCount(resource,key){
      if(key==="filterable_fields"||key==="time_bucket_fields")return Object.keys(resource[key]||{}).length;
      return (resource[key]||[]).length;
    }

    function riskCount(source){
      const resource=reviewResource(source.id);
      return (resource?.fields||[]).filter(field=>field.sensitivity&&field.sensitivity.state!=="structurally_low_risk").length+(resource?.blockers||[]).length;
    }

	    function renderSummary(){
	      const summary=reviewReport.summary;
	      const unresolved=(reviewReport.resources||[]).flatMap(resource=>resource.fields||[]).filter(field=>field.sensitivity?.state==="unresolved_free_text").length;
	      const exposed=candidate.pack.resources.reduce((total,resource)=>total+resource.selectable_fields.length,0);
      byId("summary").innerHTML=[
        [candidate.pack.resources.length,"included resources"],
        [exposed,"raw-visible fields"],
        [summary.sensitive_fields_kept_out,"kept-out suggestions"],
        [unresolved,"unresolved fields"]
	      ].map(item=>'<div class="metric"><strong>'+esc(item[0])+'</strong><span>'+esc(item[1])+'</span></div>').join("");
	      const tenantResolved=(reviewReport.resources||[]).filter(resource=>resource.tenant_key?.selected).length;
	      const principalResolved=(reviewReport.resources||[]).filter(resource=>resource.principal_key?.selected).length;
	      byId("database-summary").innerHTML='<h3>Database found</h3><p><strong>'+esc(String(reviewReport.engine||"database").toUpperCase())+'</strong> using role <code>'+esc(reviewReport.database_role?.name||"unknown")+'</code>. Inspected '+esc(summary.objects)+' resource(s); '+esc(summary.draft_reads)+' read candidate(s) are ready and '+esc(summary.blocked_objects)+' object(s) remain blocked.</p><p>Detected tenant scope for '+esc(tenantResolved)+' resource(s) and principal scope for '+esc(principalResolved)+'. Human review is required because schema structure cannot decide business visibility or authority.</p>';
	    }

	    function renderResources(){
	      const sources=(reviewReport.resources||[]).filter(review=>{
	        const source=original.pack.resources.find(resource=>resource.id===review.id);
	        const raw=source?.selectable_fields.length||0;
	        const unresolved=(review.fields||[]).some(field=>field.sensitivity?.state==="unresolved_free_text");
	        if(resourceFilter==="risks")return riskCount({id:review.id})>0;
	        if(resourceFilter==="exposed")return raw>0;
	        if(resourceFilter==="unresolved")return unresolved;
	        return true;
	      });
	      byId("resources").innerHTML=sources.map(review=>{
	        const source=original.pack.resources.find(resource=>resource.id===review.id);
	        const resource=currentResource(review.id);
	        const included=Boolean(resource);
	        const risks=riskCount({id:review.id});
	        const raw=resource?resource.selectable_fields.length:0;
	        const kept=resource?resource.kept_out_fields.length:(review.fields||[]).filter(field=>field.sensitivity?.state!=="structurally_low_risk").length;
	        const primary=source?.primary_key||review.primary_key?.selected||"unresolved";
	        const tenant=source?.tenant_key||review.tenant_key?.selected||"unresolved";
	        const principal=source?.principal_key||review.principal_key?.selected||"not configured";
	        const blocked=review.status!=="draft_read";
	        return '<article class="resource" data-risk="'+risks+'"><div class="resource-head"><div><h3 class="resource-name">'+esc(review.id)+'</h3><p>'+esc(blocked?"Blocked: "+(review.blockers||[]).join("; "):included?"Included in this authoring pack":"Excluded from this authoring pack")+'</p></div><span class="badge '+(blocked?"bad":risks?"warn":"good")+'">'+esc(blocked?"Blocked":risks?risks+" risk / review item(s)":"No detected exception")+'</span></div><div class="badges"><span class="badge">'+esc(raw)+' raw</span><span class="badge">'+esc(kept)+' kept out</span><span class="badge">row id: '+esc(primary)+'</span></div><p>Tenant <code>'+esc(tenant)+'</code> / Principal <code>'+esc(principal)+'</code></p><div class="actions"><button class="secondary" data-open-resource="'+esc(review.id)+'" type="button">Review resource</button>'+(source?'<label class="check"><input type="checkbox" data-resource-toggle="'+esc(review.id)+'" '+(included?"checked":"")+'> Include</label>':'')+'</div></article>';
	      }).join("")||'<div class="band">No resources match this filter.</div>';
      document.querySelectorAll("[data-open-resource]").forEach(button=>button.onclick=()=>openResource(button.dataset.openResource));
      document.querySelectorAll("[data-resource-toggle]").forEach(input=>input.onchange=()=>toggleResource(input.dataset.resourceToggle,input.checked));
    }

    function toggleResource(id,included){
      const source=original.pack.resources.find(resource=>resource.id===id);
      if(!source)return;
      if(included&&!currentResource(id)){
        candidate.pack.resources.push(structuredClone(source));
        candidate.pack.resources.sort((left,right)=>left.id.localeCompare(right.id));
      }else if(!included){
        candidate.pack.resources=candidate.pack.resources.filter(resource=>resource.id!==id);
        candidate.pack.resources.forEach(resource=>{resource.relationships=resource.relationships.filter(relation=>relation.target_resource!==id)});
      }
      invalidateDigest();
      renderSummary();
      renderResources();
      queueReviewProgressSave();
    }

    function openResource(id){
      selectedResource=id;
      openedResources.add(id);
      setView("exceptions");
      renderResourceDetail();
    }

    function fieldHas(resource,field,key){
      return key==="filterable_fields"||key==="time_bucket_fields"
        ? Object.hasOwn(resource[key]||{},field)
        : (resource[key]||[]).includes(field);
    }

    function removeFieldAuthority(resource,field){
      resource.selectable_fields=resource.selectable_fields.filter(value=>value!==field);
      delete resource.filterable_fields[field];
      resource.sortable_fields=resource.sortable_fields.filter(value=>value!==field);
      resource.groupable_fields=resource.groupable_fields.filter(value=>value!==field);
      resource.aggregate_measures=resource.aggregate_measures.filter(value=>value!==field);
      resource.count_distinct_fields=resource.count_distinct_fields.filter(value=>value!==field);
      delete resource.time_bucket_fields[field];
      resource.relationships=resource.relationships.filter(relation=>!relation.local_columns.includes(field));
    }

    function setPermission(id,field,key,enabled){
      const source=original.pack.resources.find(resource=>resource.id===id);
      const resource=currentResource(id);
      if(!source||!resource||resource.kept_out_fields.includes(field)&&enabled)return;
      if(key==="filterable_fields"||key==="time_bucket_fields"){
        if(enabled&&Object.hasOwn(source[key],field))resource[key][field]=structuredClone(source[key][field]);
        else delete resource[key][field];
      }else if(enabled&&source[key].includes(field)&&!resource[key].includes(field)){
        resource[key].push(field);
      }else if(!enabled){
        resource[key]=resource[key].filter(value=>value!==field);
      }
      invalidateResourceReview(id);
      renderResourceDetail();
    }

    function openManagedFieldReview(field,exposure){
      document.querySelectorAll("[data-managed-review-form]").forEach(form=>form.classList.add("hidden"));
      const form=[...document.querySelectorAll("[data-managed-review-form]")].find(item=>item.dataset.field===field&&item.dataset.exposure===exposure);
      if(!form)return;
      form.classList.remove("hidden");
      const actor=form.querySelector("[data-review-actor]");
      if(actor&&!actor.value)actor.value=byId("actor").value.trim();
      form.querySelector("[data-review-reason]")?.focus();
    }

    async function submitManagedFieldReview(field,exposure){
      const form=[...document.querySelectorAll("[data-managed-review-form]")].find(item=>item.dataset.field===field&&item.dataset.exposure===exposure);
      if(!form)return;
      const actor=form.querySelector("[data-review-actor]").value.trim();
      const reason=form.querySelector("[data-review-reason]").value.trim();
      const status=form.querySelector("[data-review-status]");
      try{
        if(!actor||!reason)throw new Error("Enter the human reviewer identity and a concrete reason.");
        status.className="status-message";
        status.textContent="Rechecking metadata and regenerating the managed boundary...";
        await post("/api/boundary/regenerate",{
          kind:"field_exposure",
          resource_id:selectedResource,
          field,
          exposure,
          actor,
          reason
        });
        confirmedDecisions.clear();
        candidateDigest=undefined;
        await load();
        setView("exceptions");
        renderResourceDetail();
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function managedReviewForm(field,exposure,placeholder){
      return '<div class="review-form hidden" data-managed-review-form data-field="'+esc(field)+'" data-exposure="'+esc(exposure)+'"><label class="field">Human reviewer<input data-review-actor type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><label class="field">Reason<textarea data-review-reason maxlength="500" rows="2" placeholder="'+esc(placeholder)+'"></textarea></label><div class="actions"><button data-submit-field-review="'+esc(field)+'" data-exposure="'+esc(exposure)+'" type="button">Regenerate reviewed boundary</button><button class="quiet" data-cancel-field-review type="button">Cancel</button></div><span data-review-status class="status-message"></span></div>';
    }

    async function submitManagedScopeReview(kind,form){
      const status=form.querySelector("[data-scope-review-status]");
      try{
        const selected=form.querySelector("[data-scope-review-value]").value;
        const value=kind==="principal_key"&&selected==="__none__"?null:selected;
        const actor=form.querySelector("[data-scope-review-actor]").value.trim();
        const reason=form.querySelector("[data-scope-review-reason]").value.trim();
        if((value===null?false:!value)||!actor||!reason)throw new Error("Choose the source column and enter the human reviewer identity and reason.");
        status.className="status-message";
        status.textContent="Rechecking metadata and regenerating the managed boundary...";
        await post("/api/boundary/regenerate",{
          kind,
          resource_id:selectedResource,
          value,
          actor,
          reason
        });
        confirmedDecisions.clear();
        candidateDigest=undefined;
        await load();
        setView("exceptions");
        renderResourceDetail();
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function managedScopeReviewForm(kind,label,values,current,allowNone=false){
      const options=[
        ...(allowNone?[{value:"__none__",label:"No principal-level row scope"}]:[]),
        ...values.map(value=>({value,label:value}))
      ];
      return '<div class="review-form" data-scope-review-form><h3>Review '+esc(label)+'</h3><div class="form-grid"><label class="field">Source column<select data-scope-review-value>'+options.map(option=>'<option value="'+esc(option.value)+'" '+((current===undefined&&option.value==="__none__")||current===option.value?"selected":"")+'>'+esc(option.label)+'</option>').join("")+'</select></label><label class="field">Human reviewer<input data-scope-review-actor type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><label class="field">Reason<textarea data-scope-review-reason maxlength="500" rows="2" placeholder="Why is this the reviewed '+esc(label)+'?"></textarea></label></div><div class="actions"><button data-submit-scope-review="'+esc(kind)+'" type="button">Regenerate reviewed boundary</button></div><span data-scope-review-status class="status-message"></span></div>';
    }

    function invalidateResourceReview(id){
      resourceDecisions(id).forEach(decision=>confirmedDecisions.delete(decision));
      invalidateDigest();
      queueReviewProgressSave();
    }

    function invalidateDigest(){
      candidateDigest=undefined;
      updateActivationState();
    }

    function queueReviewProgressSave(){
      if(!candidate||!reviewReport)return Promise.resolve();
      const savedCandidate=structuredClone(candidate);
      const savedDecisions=[...confirmedDecisions];
      progressSave=progressSave.catch(()=>undefined).then(async()=>{
        try{
          await post("/api/boundary/progress",{candidate:savedCandidate,confirmed_decisions:savedDecisions});
          reviewProgressHealthy=true;
          updateActivationState();
        }catch(error){
          reviewProgressHealthy=false;
          const message=byId("message");
          message.className="status-message error";
          message.textContent="Review progress was not saved: "+error.message;
          updateActivationState();
        }
      });
      return progressSave;
    }

	    function renderResourceDetail(){
      if(!selectedResource){
        byId("resource-detail").innerHTML="<p>Select a resource from Overview.</p>";
        renderGlobalDecisions();
        return;
      }
	      const source=original.pack.resources.find(resource=>resource.id===selectedResource);
	      const resource=currentResource(selectedResource);
	      const review=reviewResource(selectedResource);
	      if(!review){
	        byId("resource-detail").innerHTML="<p>This resource is no longer present in the managed draft.</p>";
	        return;
	      }
	      if(!source){
	        const fields=review.fields||[];
	        const kept=fields.filter(field=>field.sensitivity?.state!=="structurally_low_risk").map(field=>field.name);
          const resolvingIdentity=!review.primary_key?.selected;
          const kind=resolvingIdentity?"row_identity":"tenant_key";
          const candidateValues=resolvingIdentity
            ?review.primary_key?.candidates||[]
            :fields.map(field=>field.name);
          const decisionLabel=resolvingIdentity?"source-proven row identity":"trusted tenant column";
          const resolution=candidateValues.length
            ?'<p>This decision is stored with its reviewer and reason, then all managed DSL, JSON, tests, review files, and lock data are regenerated. It does not activate authority.</p>'+managedScopeReviewForm(kind,decisionLabel,candidateValues,undefined)
            :'<div class="risk high"><strong>No safe '+esc(decisionLabel)+' candidate exists.</strong><p>Add a single-column primary or unique key in the database, then rescan. Runner will not accept a friendly ORM or API name as row-identity proof.</p></div>';
	        byId("resource-detail").innerHTML='<div class="split-actions"><div><h3>'+esc(selectedResource)+'</h3><p><span class="badge bad">Blocked</span> No authority can be activated for this object yet.</p></div><button class="secondary" id="back-resources" type="button">Back to resources</button></div><div class="risk-list">'+(review.blockers||[]).map(blocker=>'<div class="risk high"><strong>'+esc(blocker)+'</strong><p>This object stays unavailable; unrelated safe resources can continue.</p></div>').join("")+'</div><div class="scope-grid" style="margin-top:12px"><div><strong>Row identity candidates</strong><p>'+esc((review.primary_key?.candidates||[]).join(", ")||"none")+'</p></div><div><strong>Tenant candidates</strong><p>'+esc((review.tenant_key?.candidates||[]).join(", ")||"none")+'</p></div></div>'+resolution+'<p>Sensitive or unresolved fields kept unavailable: '+esc(kept.join(", ")||"none detected")+'.</p>';
	        byId("back-resources").onclick=()=>setView("overview");
          document.querySelectorAll("[data-submit-scope-review]").forEach(button=>button.onclick=()=>submitManagedScopeReview(button.dataset.submitScopeReview,button.closest("[data-scope-review-form]")));
	        renderGlobalDecisions();
	        return;
	      }
      const fields=review.fields||[];
      const risks=fields.filter(field=>field.sensitivity?.state!=="structurally_low_risk");
      const riskHtml=risks.length?risks.map(field=>{
        const classification=field.sensitivity;
        const kept=resource?resource.kept_out_fields.includes(field.name):true;
        const reviewed=field.review_override;
        const exposure=kept?"allow_reviewed_use":"keep_out";
        const action=kept?"Review for access":"Keep out";
        const state=reviewed
          ?reviewed.exposure==="allow_reviewed_use"?"Reviewed visible":"Reviewed kept out"
          :kept?"Kept out by default":"Action required";
        const reviewNote=reviewed?'<p>Reviewed by '+esc(reviewed.actor)+' at '+esc(reviewed.decided_at)+': '+esc(reviewed.reason)+'</p>':"";
        const form=resource?managedReviewForm(field.name,exposure,kept?"Why is this field safe for this agent?":"Why should this field remain unavailable?"):"";
        return '<div class="risk '+(classification.state==="high_confidence_sensitive"?"high":"unresolved")+'"><div class="split-actions"><div><strong><code>'+esc(field.name)+'</code> · '+esc(stateLabel(classification.state))+'</strong><p>'+esc(classification.reasons.join(" "))+'</p>'+reviewNote+'</div><span class="badge '+(kept?"bad":"warn")+'">'+esc(state)+'</span></div>'+(resource?'<button class="secondary" data-open-field-review="'+esc(field.name)+'" data-exposure="'+esc(exposure)+'" type="button">'+esc(action)+'</button>'+form:"")+'</div>';
      }).join(""):'<p>No sensitive or unresolved structural field signals were detected.</p>';
      const resourceConfirmed=resourceDecisions(selectedResource).every(decision=>confirmedDecisions.has(decision));
      const fieldNames=Object.keys(source.field_types).sort();
      const permissionRows=resource?fieldNames.map(field=>{
        const cells=permissions.map(item=>{
          if(!fieldHas(source,field,item[1]))return '<td><span class="permission">Not available</span></td>';
          return '<td><span class="permission"><input type="checkbox" aria-label="'+esc(item[0]+" "+field)+'" data-permission-field="'+esc(field)+'" data-permission-key="'+esc(item[1])+'" '+(fieldHas(resource,field,item[1])?"checked":"")+(resource.kept_out_fields.includes(field)?" disabled":"")+'></span></td>';
        }).join("");
        const kept=resource.kept_out_fields.includes(field)
          ?'<span class="badge">Yes</span>'
          :'<button class="quiet" data-open-field-review="'+esc(field)+'" data-exposure="keep_out" type="button">Keep out</button>'+managedReviewForm(field,"keep_out","Why should this field remain unavailable?");
        return '<tr><td><code>'+esc(field)+'</code></td>'+cells+'<td>'+kept+'</td></tr>';
      }).join(""):"";
      const advanced=resource?'<details><summary>Advanced permissions</summary><p>Removing access narrows this draft. Generated kept-out fields cannot be restored in this activation.</p><div style="overflow:auto"><table class="permission-table"><thead><tr><th>Field</th>'+permissions.map(item=>'<th>'+esc(item[0])+'</th>').join("")+'<th>Kept out</th></tr></thead><tbody>'+permissionRows+'</tbody></table></div></details>':'<p>This resource is excluded. Return to Overview to include it.</p>';
      const sourceFields=Object.keys(source.field_types).sort();
      const scopeReview=resource?'<details><summary>Identity and trusted scope</summary><p>These values come from inspected source columns. They never become model arguments.</p>'+managedScopeReviewForm("row_identity","row identity",review.primary_key?.candidates||[],source.primary_key)+managedScopeReviewForm("tenant_key","tenant scope",sourceFields,source.tenant_key)+managedScopeReviewForm("principal_key","principal scope",sourceFields,source.principal_key,true)+'</details>':"";
      byId("resource-detail").innerHTML='<div class="split-actions"><div><h3>'+esc(selectedResource)+'</h3><p>Row identity <code>'+esc(source.primary_key)+'</code> · Tenant <code>'+esc(source.tenant_key)+'</code> · Principal <code>'+esc(source.principal_key||"not configured")+'</code></p></div><button class="secondary" id="back-resources" type="button">Back to resources</button></div><div class="scope-grid" style="margin-top:12px"><div><strong>Raw-visible</strong><p>'+esc(resource?resource.selectable_fields.join(", ")||"none":"excluded")+'</p></div><div><strong>Aggregate-only</strong><p>'+esc(resource?resource.aggregate_measures.filter(field=>!resource.selectable_fields.includes(field)).join(", ")||"none":"excluded")+'</p></div></div><h3 style="margin-top:16px">Risk exceptions</h3><div class="risk-list">'+riskHtml+'</div>'+scopeReview+advanced+'<div class="actions"><label class="check"><input id="resource-signoff" type="checkbox" data-review-decision="'+esc(selectedResource)+'" '+(resourceConfirmed?"checked":"")+(resource?"":" disabled")+'><span>I reviewed this resource identity, scope, field exposure, privacy limits, and relationships.</span></label></div>';
      byId("back-resources").onclick=()=>setView("overview");
      document.querySelectorAll("[data-open-field-review]").forEach(button=>button.onclick=()=>openManagedFieldReview(button.dataset.openFieldReview,button.dataset.exposure));
      document.querySelectorAll("[data-submit-field-review]").forEach(button=>button.onclick=()=>submitManagedFieldReview(button.dataset.submitFieldReview,button.dataset.exposure));
      document.querySelectorAll("[data-cancel-field-review]").forEach(button=>button.onclick=()=>button.closest("[data-managed-review-form]").classList.add("hidden"));
      document.querySelectorAll("[data-submit-scope-review]").forEach(button=>button.onclick=()=>submitManagedScopeReview(button.dataset.submitScopeReview,button.closest("[data-scope-review-form]")));
      document.querySelectorAll("[data-permission-field]").forEach(input=>input.onchange=()=>setPermission(selectedResource,input.dataset.permissionField,input.dataset.permissionKey,input.checked));
      byId("resource-signoff").onchange=event=>{
        const decisions=resourceDecisions(selectedResource);
        if(event.currentTarget.checked)decisions.forEach(decision=>confirmedDecisions.add(decision));
        else decisions.forEach(decision=>confirmedDecisions.delete(decision));
        invalidateDigest();
        queueReviewProgressSave();
        renderGlobalDecisions();
      };
      renderGlobalDecisions();
    }

    function renderGlobalDecisions(){
      const decisions=globalDecisions();
      byId("global-decisions").innerHTML='<h3>Boundary-wide confirmations</h3><p>These decisions cannot be inferred safely from schema names.</p>'+decisions.map((decision,index)=>'<label class="check" style="margin-top:10px"><input type="checkbox" data-review-decision="global" data-global-decision="'+index+'" '+(confirmedDecisions.has(decision)?"checked":"")+'><span>'+esc(decision)+'</span></label>').join("");
      document.querySelectorAll("[data-global-decision]").forEach(input=>input.onchange=()=>{
        const decision=decisions[Number(input.dataset.globalDecision)];
        if(input.checked)confirmedDecisions.add(decision);else confirmedDecisions.delete(decision);
        invalidateDigest();
        queueReviewProgressSave();
      });
    }

    function allDecisionsConfirmed(){
      const decisions=reviewReport?.unresolved_decisions||[];
      return decisions.length>0&&decisions.every(decision=>confirmedDecisions.has(decision));
    }

    function renderSignoff(){
      if(!candidate||!reviewReport)return;
      const total=reviewReport.unresolved_decisions.length;
      const done=reviewReport.unresolved_decisions.filter(decision=>confirmedDecisions.has(decision)).length;
      const remainingResources=(reviewReport.resources||[]).filter(resource=>resource.status==="draft_read"&&!resourceDecisions(resource.id).every(decision=>confirmedDecisions.has(decision))).map(resource=>resource.id);
      byId("signoff-summary").innerHTML='<h3>'+esc(done)+' of '+esc(total)+' required decisions reviewed</h3><p>'+(remainingResources.length?'Still review: '+esc(remainingResources.join(", ")):'All resource reviews are complete.')+'</p><p>Included resources: '+esc(candidate.pack.resources.length)+' / Raw-visible fields: '+esc(candidate.pack.resources.reduce((sum,resource)=>sum+resource.selectable_fields.length,0))+' / Kept out: '+esc(candidate.pack.resources.reduce((sum,resource)=>sum+resource.kept_out_fields.length,0))+'</p>';
      byId("deployment-profile").value=candidate.deployment_profile;
      renderRolePosture();
      updateActivationState();
    }

    function renderRolePosture(){
      const role=reviewReport.database_role||{};
      byId("role-posture").innerHTML='<h3>Exact database role posture</h3><p>Role <code>'+esc(role.name||"unknown")+'</code> · Verified '+esc(role.verified===true?"yes":"no")+' · Read only '+esc(role.read_only===true?"yes":"no")+' · Superuser '+esc(String(role.superuser))+' · BYPASSRLS '+esc(String(role.bypass_rls))+'</p><p>Fingerprint <code>'+esc(role.fingerprint||candidate.role_posture_fingerprint)+'</code></p>';
    }

    function updateActivationState(){
      byId("activate").disabled=!reviewProgressHealthy||!candidateDigest||!allDecisionsConfirmed()||!byId("actor").value.trim();
    }

    async function previewBoundary(){
      const message=byId("message");
      try{
        message.className="status-message";
        await queueReviewProgressSave();
        if(!reviewProgressHealthy)throw new Error("Review progress must be saved before previewing a digest.");
        message.textContent="Validating the narrowed boundary...";
        const payload=await post("/api/boundary/preview",{candidate});
        candidateDigest=payload.digest;
        message.textContent="Exact reviewed digest: "+candidateDigest;
        updateActivationState();
      }catch(error){
        message.className="status-message error";
        message.textContent=error.message;
      }
    }

    async function activateBoundary(){
      const message=byId("message");
      try{
        message.className="status-message";
        await queueReviewProgressSave();
        if(!reviewProgressHealthy)throw new Error("Review progress must be saved before activation.");
        message.textContent="Rechecking schema lock and database-role posture...";
        const payload=await post("/api/boundary/activate",{
          candidate,
          expected_digest:candidateDigest,
          actor:byId("actor").value.trim(),
          confirmation:"ACTIVATE "+candidateDigest,
          confirmed_decisions:[...confirmedDecisions]
        });
        activeBoundary=payload.active;
        byId("header-state").textContent="Active reviewed boundary";
        byId("header-state").className="state good";
        message.className="status-message";
        message.textContent=payload.message;
        document.querySelector('[data-view="activate"]').classList.add("done");
        setView("explore");
      }catch(error){
        message.className="status-message error";
        message.textContent=error.message;
      }
    }

    async function previewProjectRescan(){
      const panel=byId("project-action-message");
      try{
        panel.className="review-form";
        panel.innerHTML="<p>Inspecting current metadata and computing a semantic diff. Nothing is being replaced...</p>";
        const payload=await post("/api/project/rescan",{});
        const diff=payload.diff;
        const lines=[
          "Resources: "+diff.resources_before+" → "+diff.resources_after,
          "Added: "+(diff.added_resources.join(", ")||"none"),
          "Removed: "+(diff.removed_resources.join(", ")||"none"),
          "Changed: "+(diff.changed_resources.join(", ")||"none"),
          "Review inputs no longer valid: "+(diff.pruned_review_inputs.join("; ")||"none")
        ];
        panel.innerHTML='<h3>Rescan preview</h3><p>'+lines.map(esc).join("<br>")+'</p><p>No generated file, active boundary, protected capability, ledger record, or source row changed.</p><button id="apply-rescan" type="button">Apply this disabled rescan</button>';
        byId("apply-rescan").onclick=()=>applyProjectRescan(payload.preview_digest);
      }catch(error){
        panel.className="review-form error";
        panel.textContent=error.message;
      }
    }

    async function applyProjectRescan(digest){
      const panel=byId("project-action-message");
      try{
        panel.className="review-form";
        panel.textContent="Rechecking the preview and replacing only managed boundary artifacts...";
        const payload=await post("/api/project/rescan/apply",{
          expected_digest:digest,
          confirmation:"RESCAN "+digest
        });
        confirmedDecisions.clear();
        candidateDigest=undefined;
        await load();
        panel.className="review-form success";
        panel.textContent=payload.message+" Next: Review the changed boundary.";
      }catch(error){
        panel.className="review-form error";
        panel.textContent=error.message;
      }
    }

    function previewStartOver(){
      const panel=byId("project-action-message");
      panel.className="review-form error";
      panel.innerHTML='<h3>Reset managed boundary review?</h3><p>This removes saved field/scope review decisions and temporary Explore authority. It preserves the local ledger, protected named capabilities, Runner config, and source database.</p><button id="confirm-start-over" class="danger" type="button">Confirm start over review</button>';
      byId("confirm-start-over").onclick=applyStartOver;
    }

    async function applyStartOver(){
      const panel=byId("project-action-message");
      try{
        panel.className="review-form";
        panel.textContent="Re-inspecting metadata and creating a fresh disabled review draft...";
        const payload=await post("/api/project/start-over",{confirmation:"START OVER REVIEW"});
        confirmedDecisions.clear();
        candidateDigest=undefined;
        await load();
        panel.className="review-form success";
        panel.textContent=payload.message+" Next: Review what the agent can see.";
      }catch(error){
        panel.className="review-form error";
        panel.textContent=error.message;
      }
    }

    async function runPreflight(){
      const panel=byId("explore-preflight");
      panel.className="band";
      panel.innerHTML="<p>Rechecking profile, boundary digest, schema lock, database role, trusted scope, and privacy budgets...</p>";
      try{
        const payload=await getJson("/api/explore/preflight");
        exploreDescription=payload.description;
        exploreBudgets=payload.budgets;
        panel.className="band success";
        panel.innerHTML='<h3>Ready for local bounded exploration</h3><div class="preflight">'+payload.checks.map(check=>'<div><span class="badge good">Ready</span><strong style="display:block;margin-top:5px">'+esc(check.name)+'</strong><p>'+esc(check.detail)+'</p></div>').join("")+'</div>';
        byId("explorer").classList.remove("hidden");
        renderExplorer();
      }catch(error){
        const remediation=error.payload?.remediation;
        if(error.payload?.error_code==="EXPLORE_SCOPE_FORBIDDEN"){
          panel.className="band notice";
          panel.innerHTML='<h3>Bind this local authoring session</h3><p>Enter the trusted tenant and principal values for the staging rows you are allowed to inspect. They stay only in this secured Workbench process, are never written to project files, and never become model arguments.</p><div class="form-grid"><label class="field">Trusted tenant<input id="trusted-tenant" type="text" maxlength="256" autocomplete="off"></label><label class="field">Trusted principal<input id="trusted-principal" type="text" maxlength="256" autocomplete="off"></label></div><div class="actions"><button id="bind-trusted-scope" type="button">Bind trusted scope and continue</button></div><span id="trusted-scope-status" class="status-message"></span>';
          byId("explorer").classList.add("hidden");
          byId("bind-trusted-scope").onclick=bindTrustedScope;
          return;
        }
        panel.className="band error";
        panel.innerHTML='<h3>Explore is not ready</h3><p>'+esc(error.message)+'</p>'+(remediation?'<p><strong>Next action:</strong> '+esc(remediation.action)+'</p><p>'+esc(remediation.preserved)+'</p>':"")+'<button id="retry-preflight" type="button">Retry preflight</button>';
        byId("explorer").classList.add("hidden");
        byId("retry-preflight").onclick=runPreflight;
      }
    }

    async function bindTrustedScope(){
      const status=byId("trusted-scope-status");
      try{
        const tenant=byId("trusted-tenant").value.trim();
        const principal=byId("trusted-principal").value.trim();
        if(!tenant||!principal)throw new Error("Enter both trusted scope values.");
        status.className="status-message";
        status.textContent="Binding trusted scope in this local process...";
        await post("/api/explore/trusted-context",{tenant,principal});
        byId("trusted-tenant").value="";
        byId("trusted-principal").value="";
        await runPreflight();
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function resourcesFromDescription(){
      return exploreDescription?.resources||[];
    }

    function renderExplorer(){
      const resources=resourcesFromDescription();
      if(!resources.length){
        byId("suggested-questions").innerHTML='<div class="band error">The activated pack contains no explorable resources.</div>';
        return;
      }
      byId("suggested-questions").innerHTML=resources.slice(0,3).map((resource,index)=>{
        const dimension=resource.groupable_fields?.[0];
        const timeField=Object.keys(resource.time_bucket_fields||{})[0];
        const question=timeField&&dimension
          ?"How did reviewed "+dimension+" groups change by week?"
          :dimension
            ?"Which reviewed "+dimension+" groups contributed the most?"
            :"How many reviewed records are in "+resource.id+"?";
        return '<button class="question '+(index===0?"selected":"")+'" data-question="'+index+'" type="button">'+esc(question)+'<br><span class="badge">'+esc(resource.id)+'</span></button>';
      }).join("");
      document.querySelectorAll("[data-question]").forEach(button=>button.onclick=()=>{
        document.querySelectorAll("[data-question]").forEach(item=>item.classList.remove("selected"));
        button.classList.add("selected");
        const resource=resources[Number(button.dataset.question)];
        populateAggregateBuilder(resource.id);
      });
      populateAggregateBuilder(resources[0].id);
      populateRowBuilder(resources[0].id);
      renderClientConfigs();
    }

    function optionList(values,selected){
      return values.map(value=>'<option value="'+esc(value)+'" '+(value===selected?"selected":"")+'>'+esc(value)+'</option>').join("");
    }

    function measureOptions(resource){
      return [
        {value:"count:",label:"Count reviewed records"},
        ...(resource.aggregate_measures||[]).flatMap(field=>[
          {value:"sum:"+field,label:"Sum "+field},
          {value:"avg:"+field,label:"Average "+field}
        ]),
        ...(resource.count_distinct_fields||[]).map(field=>({value:"count_distinct:"+field,label:"Count distinct "+field}))
      ];
    }

    function localDateTime(value){
      const offset=value.getTimezoneOffset()*60000;
      return new Date(value.getTime()-offset).toISOString().slice(0,16);
    }

    function defaultComparisonRanges(){
      const now=new Date();
      const end=new Date(now);
      end.setHours(0,0,0,0);
      end.setDate(end.getDate()-((end.getDay()+6)%7));
      const period2Start=new Date(end);period2Start.setDate(period2Start.getDate()-7);
      const period1End=new Date(period2Start);
      const period1Start=new Date(period1End);period1Start.setDate(period1Start.getDate()-7);
      return [localDateTime(period1Start),localDateTime(period1End),localDateTime(period2Start),localDateTime(end)];
    }

    function populateAggregateBuilder(resourceId){
      const resources=resourcesFromDescription();
      const resource=resources.find(item=>item.id===resourceId)||resources[0];
      const dimensions=resource.groupable_fields||[];
      const timeFields=Object.keys(resource.time_bucket_fields||{});
      const filters=resource.filterable_fields||[];
      const measures=measureOptions(resource);
      const ranges=defaultComparisonRanges();
      const maximumGroups=Math.min(10,Math.max(1,resource.maximum_groups||10));
      byId("aggregate-builder").innerHTML=
        '<label class="field">Resource<select id="aggregate-resource">'+optionList(resources.map(item=>item.id),resource.id)+'</select></label>'+
        '<label class="field">Measure<select id="aggregate-measure">'+measures.map((item,index)=>'<option value="'+esc(item.value)+'" '+(index===0?"selected":"")+'>'+esc(item.label)+'</option>').join("")+'</select></label>'+
        '<label class="field">Group by<select id="aggregate-dimension"><option value="">No grouping</option>'+optionList(dimensions,dimensions[0])+'</select></label>'+
        '<label class="field">Time field<select id="aggregate-time"><option value="">No time bucket</option>'+optionList(timeFields,timeFields[0])+'</select></label>'+
        '<label class="field">Time bucket<select id="aggregate-bucket"><option value="week">Week</option><option value="day">Day</option><option value="month">Month</option></select></label>'+
        '<label class="field">Order result<select id="aggregate-order"><option value="measure:desc">Largest measure first</option><option value="measure:asc">Smallest measure first</option><option value="time_bucket:asc">Oldest bucket first</option><option value="time_bucket:desc">Newest bucket first</option></select></label>'+
        '<label class="field">Maximum groups<input id="aggregate-top" type="number" min="1" max="'+esc(resource.maximum_groups||25)+'" value="'+esc(maximumGroups)+'"></label>'+
        '<label class="field">Optional filter field<select id="aggregate-filter"><option value="">No filter</option>'+optionList(filters)+'</select></label>'+
        '<label class="field">Filter operator<select id="aggregate-filter-op"><option value="eq">Equals</option></select></label>'+
        '<label class="field">Filter value<input id="aggregate-filter-value" type="text" maxlength="256" placeholder="A reviewed typed value"></label>'+
        '<label class="check"><input id="aggregate-compare" type="checkbox" '+(timeFields.length?"checked":"disabled")+'><span>Compare the last two complete weeks</span></label>'+
        '<label class="field comparison '+(timeFields.length?"":"hidden")+'">Earlier period start<input id="period-1-start" type="datetime-local" value="'+ranges[0]+'"></label>'+
        '<label class="field comparison '+(timeFields.length?"":"hidden")+'">Earlier period end<input id="period-1-end" type="datetime-local" value="'+ranges[1]+'"></label>'+
        '<label class="field comparison '+(timeFields.length?"":"hidden")+'">Later period start<input id="period-2-start" type="datetime-local" value="'+ranges[2]+'"></label>'+
        '<label class="field comparison '+(timeFields.length?"":"hidden")+'">Later period end<input id="period-2-end" type="datetime-local" value="'+ranges[3]+'"></label>'+
        '<div id="explore-guardrails" class="band notice"><strong>Authority stays fixed.</strong><p>Trusted tenant and principal values are injected outside this form. Kept-out fields are unavailable. Results are limited to '+esc(resource.maximum_groups||"the reviewed number of")+' groups with a minimum cohort of '+esc(resource.minimum_cohort_size)+'.</p></div>';
      byId("aggregate-resource").onchange=()=>populateAggregateBuilder(byId("aggregate-resource").value);
      byId("aggregate-compare").onchange=()=>document.querySelectorAll(".comparison").forEach(node=>node.classList.toggle("hidden",!byId("aggregate-compare").checked));
      byId("aggregate-filter").onchange=refreshFilterOperators;
      byId("aggregate-time").onchange=refreshTimeBucketOptions;
      document.querySelectorAll("#aggregate-builder input,#aggregate-builder select").forEach(input=>input.addEventListener("change",updatePlanPreview));
      refreshFilterOperators();
      refreshTimeBucketOptions();
      updatePlanPreview();
    }

    function refreshFilterOperators(){
      const resource=resourcesFromDescription().find(item=>item.id===byId("aggregate-resource").value);
      const field=byId("aggregate-filter").value;
      const operators=field?(resource.filter_operators?.[field]||[]):["eq"];
      byId("aggregate-filter-op").innerHTML=operators.map(operator=>'<option value="'+esc(operator)+'">'+esc(operator==="eq"?"Equals":operator==="neq"?"Does not equal":operator.toUpperCase())+'</option>').join("");
      byId("aggregate-filter-value").disabled=!field;
    }

    function refreshTimeBucketOptions(){
      const resource=resourcesFromDescription().find(item=>item.id===byId("aggregate-resource").value);
      const field=byId("aggregate-time").value;
      const buckets=field?(resource.time_bucket_fields?.[field]||[]):["week"];
      byId("aggregate-bucket").innerHTML=buckets.map(bucket=>'<option value="'+esc(bucket)+'">'+esc(bucket[0].toUpperCase()+bucket.slice(1))+'</option>').join("");
      const timeOrderOptions=byId("aggregate-order").querySelectorAll('option[value^="time_bucket:"]');
      timeOrderOptions.forEach(option=>option.disabled=!field);
    }

    function populateRowBuilder(resourceId){
      const resources=resourcesFromDescription();
      const resource=resources.find(item=>item.id===resourceId)||resources[0];
      const fields=resource.selectable_fields||[];
      byId("row-builder").innerHTML=
        '<label class="field">Resource<select id="row-resource">'+optionList(resources.map(item=>item.id),resource.id)+'</select></label>'+
        '<label class="field">Exact '+esc(resource.primary_key||"row identifier")+'<input id="row-id" type="text" maxlength="256" placeholder="Enter a real identifier"></label>'+
        '<label class="field">Visible fields<select id="row-fields" multiple size="'+Math.min(6,Math.max(3,fields.length))+'">'+fields.map((field,index)=>'<option value="'+esc(field)+'" '+(index<Math.min(5,fields.length)?"selected":"")+'>'+esc(field)+'</option>').join("")+'</select></label>'+
        '<div class="band notice"><strong>Trusted scope stays outside this form.</strong><p>The tenant and principal come from the activated server-side bindings.</p></div>';
      byId("row-resource").onchange=()=>populateRowBuilder(byId("row-resource").value);
      document.querySelectorAll("#row-builder input,#row-builder select").forEach(input=>input.addEventListener("change",updatePlanPreview));
      updatePlanPreview();
    }

    function isoValue(id){
      const value=byId(id)?.value;
      return value?new Date(value).toISOString():null;
    }

    function typedFilterValue(resource,field,operator,value){
      if(operator==="in")return value.split(",").map(item=>typedFilterValue(resource,field,"eq",item.trim()));
      const type=String(resource.field_types?.[field]||"").toLowerCase();
      if(/int|numeric|decimal|real|double|float|money|number/.test(type)){
        const number=Number(value);
        if(!Number.isFinite(number))throw new Error("Filter "+field+" requires a numeric value.");
        return number;
      }
      if(/bool/.test(type)){
        if(value!=="true"&&value!=="false")throw new Error("Filter "+field+" requires true or false.");
        return value==="true";
      }
      return value;
    }

    function currentPlan(){
      if(exploreMode==="rows"){
        const resource=resourcesFromDescription().find(item=>item.id===byId("row-resource").value);
        const id=byId("row-id").value.trim();
        const select=[...byId("row-fields").selectedOptions].map(option=>option.value);
        return {
          kind:"rows",
          resource:resource.id,
          select,
          where:id?[{field:resource.primary_key,op:"eq",value:id}]:[],
          limit:1
        };
      }
      const resourceId=byId("aggregate-resource").value;
      const resource=resourcesFromDescription().find(item=>item.id===resourceId);
      const [measureFunction,measureField]=byId("aggregate-measure").value.split(":");
      const dimension=byId("aggregate-dimension").value;
      const timeField=byId("aggregate-time").value;
      const filterField=byId("aggregate-filter").value;
      const filterOperator=byId("aggregate-filter-op").value;
      const filterText=byId("aggregate-filter-value").value.trim();
      const [orderKind,orderDirection]=byId("aggregate-order").value.split(":");
      const plan={
        kind:"aggregate",
        resource:resourceId,
        measures:[{function:measureFunction,...(measureField?{field:measureField}:{})}],
        ...(dimension?{dimensions:[{field:dimension}]}:{}),
        ...(timeField?{time_bucket:{field:timeField,bucket:byId("aggregate-bucket").value}}:{}),
        ...(filterField&&filterText?{where:[{field:filterField,op:filterOperator,value:typedFilterValue(resource,filterField,filterOperator,filterText)}]}:{}),
        order_by:orderKind==="time_bucket"
          ?{kind:"time_bucket",direction:orderDirection}
          :{kind:"measure",index:0,direction:orderDirection},
        top_n:Number(byId("aggregate-top").value)
      };
      if(byId("aggregate-compare").checked){
        const ranges=[
          {start:isoValue("period-1-start"),end:isoValue("period-1-end")},
          {start:isoValue("period-2-start"),end:isoValue("period-2-end")}
        ];
        if(ranges.every(range=>range.start&&range.end)&&timeField)plan.comparison={field:timeField,ranges};
      }
      return plan;
    }

    function planSentence(plan){
      if(plan.kind==="rows")return "Read one exact reviewed row from "+plan.resource+" and return only "+plan.select.join(", ")+".";
      const measures=plan.measures.map(measure=>measure.function+(measure.field?"("+measure.field+")":"")).join(", ");
      const groups=(plan.dimensions||[]).map(item=>item.field).join(", ");
      const filters=(plan.where||[]).map(item=>item.field+" "+item.op+" "+JSON.stringify(item.value)).join(", ");
      return "Calculate "+measures+" from "+plan.resource+(groups?" grouped by "+groups:"")+(plan.time_bucket?" by "+plan.time_bucket.bucket:"")+(filters?" where "+filters:"")+" with at most "+plan.top_n+" groups.";
    }

    function updatePlanPreview(){
      if(!exploreDescription)return;
      try{
        const plan=currentPlan();
        byId("plan-preview").textContent=planSentence(plan)+"\\n\\n"+JSON.stringify(plan,null,2);
      }catch(error){
        byId("plan-preview").textContent="Complete the visible fields to preview the structured plan.";
      }
    }

    function switchExploreMode(mode){
      exploreMode=mode;
      byId("aggregate-tab").classList.toggle("active",mode==="aggregate");
      byId("row-tab").classList.toggle("active",mode==="rows");
      byId("aggregate-builder").classList.toggle("hidden",mode!=="aggregate");
      byId("row-builder").classList.toggle("hidden",mode!=="rows");
      updatePlanPreview();
    }

    async function runExplore(){
      const status=byId("explore-status");
      const resultPanel=byId("explore-result");
      try{
        const plan=currentPlan();
        if(plan.kind==="rows"&&!plan.where.length)throw new Error("Enter the real row identifier. Runner will not select an arbitrary first row.");
        status.className="status-message";
        status.textContent="Running the bounded read through the reviewed authoring boundary...";
        resultPanel.innerHTML="";
	        const payload=await post("/api/explore/run",{plan});
	        lastExplorePlan=plan;
	        const result=payload.result;
	        const reviewedResource=currentResource(plan.resource);
	        const visible=plan.kind==="rows"?plan.select:plan.measures.map(measure=>measure.function+(measure.field?"("+measure.field+")":"")).concat((plan.dimensions||[]).map(dimension=>dimension.field),plan.time_bucket?[plan.time_bucket.field]:[]);
	        const unavailable=(reviewedResource?.kept_out_fields||[]).join(", ")||"all fields outside this reviewed result";
	        status.textContent="Returned through the reviewed boundary. Source database changed: no.";
	        resultPanel.innerHTML='<section class="band success"><h3>Your first safe tool is working.</h3><p>'+esc(planSentence(plan))+'</p><p><strong>Tool (local authoring only):</strong> <code>app.explore_data</code><br><strong>Agent can use:</strong> '+esc(visible.join(", ")||"reviewed row count")+'<br><strong>Agent cannot use:</strong> '+esc(unavailable)+'<br><strong>Tenant scope:</strong> trusted environment<br><strong>Principal scope:</strong> '+esc(reviewedResource?.principal_key?"trusted environment":"not configured for this pack")+'<br><strong>Source database changed:</strong> no</p><p>This temporary Explore authority is not a production named capability. Protect and separately activate the useful result before production use.</p><div class="result-meta"><span class="badge good">'+esc(result.audit.returned_rows_or_groups)+' row(s) / group(s)</span><span class="badge">'+esc(result.audit.returned_cells)+' cells</span><span class="badge">'+esc(result.privacy.suppressed_groups)+' suppressed</span><span class="badge">No source mutation</span></div><div class="result-table"><pre>'+esc(JSON.stringify(result.data,null,2))+'</pre></div><p>'+esc(result.untrusted_data_notice)+'</p><button id="protect-result" type="button">'+esc(plan.kind==="aggregate"?"Protect this analysis":"Ask a bounded aggregate question")+'</button></section>';
	        byId("protect-result").onclick=async()=>{if(plan.kind==="aggregate"){await loadProtect();setView("protect")}else{switchExploreMode("aggregate");window.scrollTo({top:0,behavior:"smooth"})}};
      }catch(error){
        const remediation=error.payload?.remediation;
        status.className="status-message error";
        status.textContent=error.message;
        resultPanel.innerHTML='<section class="band error"><h3>Request refused safely</h3><p>'+esc(error.message)+'</p>'+(remediation?'<p><strong>Next action:</strong> '+esc(remediation.action)+'</p><p>'+esc(remediation.preserved)+'</p>':"")+'</section>';
      }
    }

	    function renderClientConfigs(){
	      const command="npx -y -p @synapsor/runner synapsor-runner mcp serve --authoring --project-root .";
	      const config={mcpServers:{synapsor_authoring:{command:"npx",args:["-y","-p","@synapsor/runner","synapsor-runner","mcp","serve","--authoring","--project-root","."]}}};
	      const codex='[mcp_servers.synapsor_authoring]\\ncommand = "npx"\\nargs = '+JSON.stringify(config.mcpServers.synapsor_authoring.args);
	      byId("client-configs").innerHTML='<p>All clients receive the same two local authoring tools and no approval or commit tool.</p><h3>Generic stdio MCP</h3><pre>'+esc(JSON.stringify(config,null,2))+'</pre><h3>Cursor project</h3><p>Save the same JSON as <code>.cursor/mcp.json</code>, or use the consent-gated installer.</p><pre>'+esc("synapsor-runner mcp install cursor --project --authoring --project-root . --yes")+'</pre><h3>Claude-compatible local MCP</h3><p>Use the same stdio server command in the client MCP configuration. No model API key is needed by Runner.</p><pre>'+esc(command)+'</pre><h3>Codex</h3><pre>'+esc(codex)+'</pre>';
	    }

    async function loadProtect(){
      const status=byId("protect-message");
      try{
        const payload=await getJson("/api/protect");
        protectQueries=payload.queries||[];
        selectedProtect=protectQueries.length?0:null;
        renderProtect();
        status.className="status-message";
        status.textContent=protectQueries.length?protectQueries.length+" recent result(s) ready.":payload.message||"No recent result is ready.";
      }catch(error){
        protectQueries=[];
        selectedProtect=null;
        renderProtect();
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function renderProtect(){
      const list=byId("protect-queries");
      const editor=byId("protect-editor");
      if(!protectQueries.length){
        list.innerHTML='<div class="band"><p>No unexpired result is ready. Run a bounded exploration, then return here.</p><button class="secondary" data-next="explore" type="button">Open Explore</button></div>';
        editor.innerHTML="";
        bindNextButtons();
        return;
      }
      list.innerHTML='<div class="resource-list">'+protectQueries.map((query,index)=>'<button class="question '+(selectedProtect===index?"selected":"")+'" data-protect-index="'+index+'" type="button"><strong>'+esc(query.kind==="aggregate"?"Aggregate result":"Bounded rows")+'</strong><br><span>'+esc(query.resource)+' / expires '+esc(query.expires_at)+'</span></button>').join("")+'</div>';
      document.querySelectorAll("[data-protect-index]").forEach(button=>button.onclick=()=>{selectedProtect=Number(button.dataset.protectIndex);protectedDraft=null;renderProtect()});
      const query=protectQueries[selectedProtect];
      if(!query){editor.innerHTML="";return}
      const literals=(query.literal_positions||[]).map((position,index)=>'<div class="risk"><label class="check"><input type="checkbox" data-arg-enable="'+index+'"><span>Turn this reviewed literal into a bounded typed argument</span></label><p><code>'+esc(position.location+" / "+(position.relationship?position.relationship+".":"")+position.field+" = "+JSON.stringify(position.current_value))+'</code></p><div class="form-grid"><label class="field">Argument name<input type="text" data-arg-name="'+index+'" value="'+esc(position.suggested_argument)+'"></label><label class="field">Description<input type="text" data-arg-description="'+index+'" value="'+esc("Reviewed "+position.field+" filter.")+'"></label></div></div>').join("");
      editor.innerHTML='<section class="band"><div class="form-grid"><label class="field">Capability name<input id="protect-name" type="text" value="analytics.protected_query"></label><label class="field">Description<input id="protect-description" type="text" value="Answer one reviewed, bounded data question."></label><label class="field">Returns hint<input id="protect-returns" type="text" value="Returns only the reviewed bounded result shape."></label></div><h3 style="margin-top:16px">Literal review</h3>'+literals+'<div class="actions"><button id="create-protected" type="button">Generate disabled capability</button></div><div id="protect-preview"></div></section>';
      byId("create-protected").onclick=createProtected;
    }

    function selectedArguments(query){
      return (query.literal_positions||[]).flatMap((position,index)=>{
        if(!document.querySelector('[data-arg-enable="'+index+'"]')?.checked)return[];
        return[{
          location:position.location,
          name:document.querySelector('[data-arg-name="'+index+'"]').value.trim(),
          description:document.querySelector('[data-arg-description="'+index+'"]').value.trim()
        }];
      });
    }

    async function createProtected(){
      const status=byId("protect-message");
      const query=protectQueries[selectedProtect];
      try{
        status.className="status-message";
        status.textContent="Compiling public DSL, canonical contract, and tests...";
        const payload=await post("/api/protect/draft",{
          query_ref:query.query_ref,
          capability_name:byId("protect-name").value.trim(),
          description:byId("protect-description").value.trim(),
          returns_hint:byId("protect-returns").value.trim(),
          arguments:selectedArguments(query)
        });
        protectedDraft=payload.draft;
        byId("protect-preview").innerHTML='<h3 style="margin-top:16px">Disabled named capability</h3><p>Digest <code>'+esc(payload.draft.contract_digest)+'</code></p><pre>'+esc(payload.dsl)+'</pre><div class="form-grid"><label class="field">Operator identity<input id="protect-actor" type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><label class="field">Exact activation confirmation<input id="protect-confirmation" type="text" placeholder="ACTIVATE '+esc(payload.draft.contract_digest)+'"></label></div><label class="check" style="margin-top:12px"><input id="protect-disable-explore" type="checkbox"><span>Disable temporary Scoped Explore now. Leave this off while adding the guided safe action; authoring can be finished and disabled afterward.</span></label><div class="actions"><button id="activate-protected" type="button">Activate exact digest</button></div>';
        byId("activate-protected").onclick=activateProtected;
        status.textContent="The generated capability is still disabled. Review its DSL and exact digest.";
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    async function activateProtected(){
      const status=byId("protect-message");
      try{
        const payload=await post("/api/protect/activate",{
          capability_name:protectedDraft.capability,
          expected_digest:protectedDraft.contract_digest,
          confirmation:byId("protect-confirmation").value,
          actor:byId("protect-actor").value.trim(),
          disable_explore:byId("protect-disable-explore").checked
        });
        status.className="status-message";
        status.textContent=payload.message;
        byId("header-state").textContent=payload.active.exploration_disabled?"Protected capability active · Explore disabled":"Protected capability active";
        byId("header-state").className="state good";
        byId("activate-protected").disabled=true;
        document.querySelector('[data-view="protect"]').classList.add("done");
        if(!payload.active.exploration_disabled)setView("action");
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    async function loadGuidedAction(){
      const status=byId("action-status");
      if(guidedActionData){
        byId("action-loading").classList.add("hidden");
        byId("action-wizard").classList.remove("hidden");
        return;
      }
      try{
        status.className="status-message";
        status.textContent="Loading inspected write prerequisites...";
        const payload=await getJson("/api/actions/guided");
        guidedActionData=payload;
        byId("action-loading").classList.add("hidden");
        byId("action-wizard").classList.remove("hidden");
        populateGuidedResources();
        status.textContent="Structural prerequisites loaded. Next: define one business action.";
        const drafts=(payload.status?.drafts||[]).slice().sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at)));
        if(drafts.length){
          const details=await getJson("/api/actions/guided/draft?capability="+encodeURIComponent(drafts[0].capability));
          showGuidedActionDraft(details);
          status.textContent=drafts[0].effect_preview
            ?"Resumed the existing exact-previewed draft. Next: activate its reviewed digest."
            :"Resumed the existing disabled draft. Next: enter real staging arguments and preview one proposal.";
        }
      }catch(error){
        byId("action-loading").classList.remove("hidden");
        byId("action-loading").innerHTML='<div class="error"><strong>Safe action authoring is unavailable.</strong><p>'+esc(error.message)+'</p><p>Keep Scoped Explore active until the action is drafted, or reactivate the exact reviewed authoring boundary.</p></div>';
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function populateGuidedResources(){
      const resources=guidedActionData?.options?.resources||[];
      byId("action-resource").innerHTML=resources.map(resource=>'<option value="'+esc(resource.id)+'">'+esc(resource.id)+'</option>').join("");
      byId("action-resource").onchange=renderGuidedActionForm;
      byId("action-operation").onchange=renderGuidedActionForm;
      byId("action-auto").onchange=()=>{byId("action-auto-settings").classList.toggle("hidden",!byId("action-auto").checked);updateGuidedAutoFields()};
      byId("action-supervised-worker").onchange=updateGuidedCompatibility;
      byId("action-reversible").onchange=updateGuidedCompatibility;
      renderGuidedActionForm();
    }

    function selectedGuidedResource(){
      return (guidedActionData?.options?.resources||[]).find(resource=>resource.id===byId("action-resource").value);
    }

    function renderGuidedActionForm(){
      const resource=selectedGuidedResource();
      if(!resource)return;
      const current=byId("action-operation").value;
      const operations=["update","insert","delete"];
      byId("action-operation").innerHTML=operations.map(operation=>{
        const availability=resource.operation_availability[operation];
        return '<option value="'+operation+'" '+(availability.available?"":"disabled")+' title="'+esc(availability.reason)+'">'+operation.toUpperCase()+(availability.available?"":" - unavailable")+'</option>';
      }).join("");
      if(current&&resource.operation_availability[current]?.available)byId("action-operation").value=current;
      else byId("action-operation").value=operations.find(operation=>resource.operation_availability[operation].available)||"update";
      const operation=byId("action-operation").value;
      const availability=resource.operation_availability[operation];
      byId("action-operation-note").innerHTML='<strong>'+esc(operation.toUpperCase())+'</strong><p>'+esc(availability.reason)+'</p>';
      byId("action-conflict").innerHTML=(resource.conflict_candidates||[]).map(value=>'<option value="'+esc(value)+'">'+esc(value)+'</option>').join("");
      byId("action-conflict").disabled=operation==="insert";
      byId("action-version").disabled=operation!=="update";
      byId("action-dedup").innerHTML=(resource.insert_dedup_candidates||[]).map(value=>'<option value="'+esc(value)+'">'+esc(value)+'</option>').join("");
      byId("action-dedup").disabled=operation!=="insert";
      byId("action-delete-confirm-wrap").classList.toggle("hidden",operation!=="delete");
      byId("action-delete-confirm").placeholder="DELETE "+resource.id;
      renderGuidedFields(resource,operation);
      byId("action-boundary-details").innerHTML='<p><strong>Trusted tenant:</strong> '+esc(resource.tenant_key)+'<br><strong>Trusted principal:</strong> '+esc(resource.principal_key||"not configured")+'<br><strong>Source-proven row identity:</strong> '+esc(resource.primary_key)+'<br><strong>Kept out:</strong> '+esc((resource.kept_out_fields||[]).join(", ")||"none")+'</p><p>The model cannot provide or change tenant, principal, activation, approval, or apply authority.</p>';
      updateGuidedCompatibility();
    }

    function renderGuidedFields(resource,operation){
      const panel=byId("action-fields");
      if(operation==="delete"){
        panel.innerHTML='<div class="band notice"><strong>No writable fields.</strong><p>DELETE targets one reviewed row by primary key, trusted scope, and conflict guard. Hard delete always requires human approval.</p></div>';
        updateGuidedAutoFields();
        return;
      }
      panel.innerHTML=(resource.writable_fields||[]).map(field=>{
        const numeric=isGuidedNumeric(field.data_type);
        const transition=/(^|_)(status|state)$/i.test(field.name);
        return '<div class="action-field"><label class="check"><input type="checkbox" data-action-field="'+esc(field.name)+'"><span><strong>'+esc(field.name)+'</strong> <span class="badge">'+esc(field.data_type)+'</span></span></label><div class="action-field-settings hidden" data-action-settings="'+esc(field.name)+'"><div class="form-grid"><label class="field">Value source<select data-action-mode="'+esc(field.name)+'"><option value="argument">Bounded tool argument</option><option value="fixed">Fixed reviewed value</option></select></label><label class="field">Argument name<input data-action-argument="'+esc(field.name)+'" type="text" value="'+esc(field.name)+'"></label><label class="field">Fixed value<input data-action-fixed="'+esc(field.name)+'" type="'+(numeric?"number":"text")+'" placeholder="'+esc((field.enum_values||[]).join(" | ")||"Reviewed fixed value")+'"></label>'+(numeric?'<label class="field">Minimum<input data-action-min="'+esc(field.name)+'" type="number" value="0"></label><label class="field">Maximum<input data-action-max="'+esc(field.name)+'" type="number" value="100"></label>':'<label class="field">Maximum length<input data-action-length="'+esc(field.name)+'" type="number" min="1" value="128"></label>')+(transition?'<label class="field">Allowed current states<input data-action-from="'+esc(field.name)+'" type="text" placeholder="'+esc((field.enum_values||[]).join(", "))+'"></label>':'')+'</div>'+(field.enum_values?.length?'<p>Inspected values: '+esc(field.enum_values.join(", "))+'</p>':'')+'</div></div>';
      }).join("")||'<div class="band error">No reviewed non-sensitive writable field is available.</div>';
      panel.querySelectorAll("[data-action-field]").forEach(input=>{
        input.onchange=()=>{
          panel.querySelector('[data-action-settings="'+cssValue(input.dataset.actionField)+'"]').classList.toggle("hidden",!input.checked);
          updateGuidedAutoFields();
        };
      });
      panel.querySelectorAll("[data-action-mode]").forEach(select=>select.onchange=updateGuidedAutoFields);
      updateGuidedAutoFields();
    }

    function updateGuidedAutoFields(){
      const resource=selectedGuidedResource();
      if(!resource)return;
      const selected=[...document.querySelectorAll("[data-action-field]:checked")].map(input=>input.dataset.actionField);
      const eligible=(resource.writable_fields||[]).filter(field=>selected.includes(field.name)&&isGuidedNumeric(field.data_type)&&document.querySelector('[data-action-mode="'+cssValue(field.name)+'"]')?.value==="argument");
      byId("action-auto-field").innerHTML=eligible.map(field=>'<option value="'+esc(field.name)+'">'+esc(field.name)+'</option>').join("");
      if(byId("action-auto").checked&&!eligible.length){
        byId("action-auto").checked=false;
        byId("action-auto-settings").classList.add("hidden");
      }
    }

    function updateGuidedCompatibility(){
      const operation=byId("action-operation").value;
      const reversible=byId("action-reversible");
      const auto=byId("action-auto");
      const supervised=byId("action-supervised-worker");
      reversible.disabled=operation!=="update";
      if(reversible.disabled)reversible.checked=false;
      auto.disabled=operation==="delete"||reversible.checked||Number(byId("action-quorum").value)>1;
      if(auto.disabled){
        auto.checked=false;
        byId("action-auto-settings").classList.add("hidden");
      }
      supervised.disabled=operation==="delete"||reversible.checked;
      if(supervised.disabled)supervised.checked=false;
    }

    function guidedActionPayload(){
      const resource=selectedGuidedResource();
      const operation=byId("action-operation").value;
      const patches=[...document.querySelectorAll("[data-action-field]:checked")].map(input=>{
        const column=input.dataset.actionField;
        const field=resource.writable_fields.find(candidate=>candidate.name===column);
        const mode=document.querySelector('[data-action-mode="'+cssValue(column)+'"]').value;
        const patch={column,value_source:mode};
        if(mode==="argument"){
          patch.argument_name=document.querySelector('[data-action-argument="'+cssValue(column)+'"]').value.trim();
          if(isGuidedNumeric(field.data_type)){
            patch.minimum=Number(document.querySelector('[data-action-min="'+cssValue(column)+'"]').value);
            patch.maximum=Number(document.querySelector('[data-action-max="'+cssValue(column)+'"]').value);
          }else patch.max_length=Number(document.querySelector('[data-action-length="'+cssValue(column)+'"]').value);
        }else{
          const raw=document.querySelector('[data-action-fixed="'+cssValue(column)+'"]').value;
          patch.fixed_value=isGuidedNumeric(field.data_type)?Number(raw):/bool/i.test(field.data_type)?raw==="true":raw;
          const from=document.querySelector('[data-action-from="'+cssValue(column)+'"]');
          if(from)patch.allowed_from=from.value.split(",").map(value=>value.trim()).filter(Boolean);
        }
        return patch;
      });
      const action={
        capability_name:byId("action-name").value.trim(),
        description:byId("action-description").value.trim(),
        resource:resource.id,
        operation,
        patches,
        approval_role:byId("action-role").value.trim(),
        required_approvals:Number(byId("action-quorum").value),
        receipt_mode:byId("action-receipts").value,
        write_url_env:byId("action-write-env").value.trim(),
        confirmed_trusted_scope:byId("action-scope-confirm").checked,
        supervised_worker_execution:byId("action-supervised-worker").checked,
        reversible:byId("action-reversible").checked
      };
      if(operation!=="insert")action.conflict_column=byId("action-conflict").value;
      if(operation==="update")action.version_advance=byId("action-version").value;
      if(operation==="insert")action.dedup_proposal_column=byId("action-dedup").value;
      if(operation==="delete")action.delete_confirmation=byId("action-delete-confirm").value;
      if(byId("action-auto").checked)action.auto_approval={
        field:byId("action-auto-field").value,
        maximum:Number(byId("action-auto-max").value),
        max_per_day:Number(byId("action-auto-count").value),
        max_total_per_day:Number(byId("action-auto-total").value)
      };
      return action;
    }

    async function createGuidedAction(){
      const status=byId("action-status");
      try{
        status.className="status-message";
        status.textContent="Compiling public DSL, canonical contract, tests, and exact digest...";
        const payload=await post("/api/actions/guided/draft",{action:guidedActionPayload()});
        showGuidedActionDraft(payload);
        status.textContent="Disabled action draft created. Next: enter real staging arguments and preview one proposal.";
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function showGuidedActionDraft(payload){
      guidedActionDraft=payload;
      const draft=payload.draft;
      const args=payload.preview_args||{};
      const inputs=Object.entries(args).map(([name,value])=>'<label class="field">'+esc(name)+'<input data-action-preview="'+esc(name)+'" data-value-type="'+esc(typeof value)+'" type="'+(typeof value==="number"?"number":typeof value==="boolean"?"checkbox":"text")+'" '+(typeof value==="boolean"&&value?"checked":"")+(typeof value==="boolean"?"":' value="'+esc(value)+'"')+'></label>').join("");
      byId("action-draft").innerHTML='<section class="band success"><h3>Disabled reviewable action</h3><p><strong>Capability:</strong> '+esc(draft.capability)+'<br><strong>Operation:</strong> '+esc(draft.operation.toUpperCase())+'<br><strong>Supervised execution permission:</strong> '+(draft.supervised_worker_execution?"Contract side enabled; deployment side still required":"Off")+'<br><strong>Digest:</strong> <code>'+esc(draft.contract_digest)+'</code><br><strong>Source database changed:</strong> no</p><details><summary>Review generated public DSL</summary><pre>'+esc(payload.dsl||"Open "+draft.dsl_path+" to inspect the persisted public DSL.")+'</pre></details><h3 style="margin-top:16px">Exact staging proposal preview</h3><p>Use a real row identifier and bounded values. This calls the actual proposal runtime; it cannot approve or apply.</p><div class="form-grid">'+inputs+'</div><div class="actions"><button id="preview-action" type="button">Create preview proposal</button></div><div id="action-activation"></div></section>';
      byId("preview-action").onclick=previewGuidedAction;
      if(draft.effect_preview)renderGuidedActionActivation();
    }

    function guidedPreviewArgs(){
      return Object.fromEntries([...document.querySelectorAll("[data-action-preview]")].map(input=>[
        input.dataset.actionPreview,
        input.dataset.valueType==="number"?Number(input.value):input.dataset.valueType==="boolean"?input.checked:input.value
      ]));
    }

    async function previewGuidedAction(){
      const status=byId("action-status");
      try{
        status.className="status-message";
        status.textContent="Creating one immutable proposal through the real runtime...";
        const payload=await post("/api/actions/guided/preview",{
          capability_name:guidedActionDraft.draft.capability,
          args:guidedPreviewArgs()
        });
        guidedActionDraft.draft.effect_preview=payload.preview;
        renderGuidedActionActivation();
        status.textContent=payload.message;
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function renderGuidedActionActivation(){
      const draft=guidedActionDraft.draft;
      byId("action-activation").innerHTML='<div class="band notice"><strong>Proposal created. Source database changed: no.</strong><p>The model cannot approve or apply this proposal. Review the generated action and activate only this exact digest.</p></div><div class="form-grid"><label class="field">Operator identity<input id="action-actor" type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><label class="field">Exact activation confirmation<input id="action-confirmation" type="text" placeholder="ACTIVATE '+esc(draft.contract_digest)+'"></label></div><div class="actions"><button id="activate-action" type="button">Activate exact action digest</button></div>';
      byId("activate-action").onclick=activateGuidedAction;
    }

    async function activateGuidedAction(){
      const status=byId("action-status");
      try{
        const payload=await post("/api/actions/guided/activate",{
          capability_name:guidedActionDraft.draft.capability,
          expected_digest:guidedActionDraft.draft.contract_digest,
          confirmation:byId("action-confirmation").value,
          actor:byId("action-actor").value.trim()
        });
        status.className="status-message";
        status.textContent=payload.message;
        byId("action-activation").innerHTML='<div class="band success"><strong>Safe action active.</strong><p>Its MCP call creates a proposal only. Approval and apply remain outside the model.</p><button id="finish-authoring" type="button">Finish authoring and review proposal</button></div>';
        byId("finish-authoring").onclick=finishGuidedAuthoring;
        document.querySelector('[data-view="action"]').classList.add("done");
        byId("header-state").textContent="Reviewed read and proposal tools active";
        byId("header-state").className="state good";
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    async function finishGuidedAuthoring(){
      const status=byId("action-status");
      try{
        const payload=await post("/api/explore/disable",{});
        activeBoundary=null;
        byId("finish-authoring").disabled=true;
        status.className="status-message";
        status.textContent=payload.message+" Opening the outside-model proposal review...";
        window.location.href="/?surface=activity";
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function isGuidedNumeric(type){
      return /int|numeric|decimal|real|double|float|money|number/i.test(type);
    }

    function cssValue(value){
      return CSS.escape(String(value));
    }

    function bindNextButtons(){
      document.querySelectorAll("[data-next]").forEach(button=>button.onclick=()=>setView(button.dataset.next));
    }

	    async function load(){
	      const payload=await getJson("/api/boundary");
      original=payload.draft;
      candidate=structuredClone(payload.candidate||payload.draft);
	      reviewReport=payload.review;
	      activeBoundary=payload.active;
	      journey=payload.journey;
      confirmedDecisions=new Set(payload.confirmed_decisions||[]);
      reviewProgressHealthy=true;
      byId("deployment-profile").value=candidate.deployment_profile;
      if(payload.operator_identity)byId("actor").value=payload.operator_identity;
      byId("header-state").textContent=activeBoundary?"Active reviewed boundary":"Disabled · review required";
      byId("header-state").className=activeBoundary?"state good":"state";
      byId("overview-notice").className=activeBoundary?"band success":"band notice";
	      byId("overview-notice").textContent=activeBoundary
	        ?"The reviewed local authoring boundary is active. Named production capabilities remain separate."
	        :"Source rows remain unavailable until the exact reviewed boundary is active.";
	      const next=journey?.recommended_next_action||(activeBoundary?"Try your first safe read.":"Review what the agent can see.");
	      byId("journey-state").innerHTML='<div><strong>'+esc(next)+'</strong><p>Agent authority active: '+esc(activeBoundary?"yes":"no")+' · Source database changed: no</p></div><span class="badge '+(activeBoundary?"good":"warn")+'">'+esc(activeBoundary?"Reviewed local authority active":"No source-row authority")+'</span>';
	      const primary=byId("overview-primary");
	      primary.textContent=activeBoundary?"Try your first safe read":"Review security exceptions";
	      primary.dataset.next=activeBoundary?"explore":"exceptions";
	      renderSummary();
      renderResources();
      renderResourceDetail();
      renderSignoff();
      if(activeBoundary)document.querySelector('[data-view="activate"]').classList.add("done");
    }

	    document.querySelectorAll("[data-view]").forEach(button=>button.onclick=()=>setView(button.dataset.view));
	    function setResourceFilter(filter){
	      resourceFilter=resourceFilter===filter?"all":filter;
	      byId("show-risks").textContent=resourceFilter==="risks"?"Show all resources":"Show only risks";
	      byId("show-exposed").textContent=resourceFilter==="exposed"?"Show all resources":"Show exposed";
	      byId("show-unresolved").textContent=resourceFilter==="unresolved"?"Show all resources":"Show unresolved";
	      renderResources();
	    }
	    byId("show-risks").onclick=()=>setResourceFilter("risks");
	    byId("show-exposed").onclick=()=>setResourceFilter("exposed");
	    byId("show-unresolved").onclick=()=>setResourceFilter("unresolved");
	    byId("resume-review").onclick=()=>setView(activeBoundary?"explore":"exceptions");
	    byId("try-active").onclick=()=>{
	      if(activeBoundary)setView("explore");
	      else byId("project-action-message").textContent="No authority is active. Next: finish boundary review.";
	    };
	    byId("rescan-project").onclick=previewProjectRescan;
	    byId("start-over").onclick=previewStartOver;
    byId("deployment-profile").onchange=()=>{candidate.deployment_profile=byId("deployment-profile").value;globalDecisions().forEach(decision=>{if(decision.startsWith("deployment profile:"))confirmedDecisions.delete(decision)});invalidateDigest();queueReviewProgressSave();renderSignoff()};
    byId("actor").addEventListener("input",updateActivationState);
    byId("preview").onclick=previewBoundary;
    byId("activate").onclick=activateBoundary;
    byId("run-preflight").onclick=runPreflight;
    byId("aggregate-tab").onclick=()=>switchExploreMode("aggregate");
    byId("row-tab").onclick=()=>switchExploreMode("rows");
    byId("run-explore").onclick=runExplore;
    byId("refresh-protect").onclick=loadProtect;
    byId("load-action").onclick=loadGuidedAction;
    byId("create-action").onclick=createGuidedAction;
    byId("action-quorum").onchange=updateGuidedCompatibility;
    bindNextButtons();
    load().catch(error=>{
      byId("header-state").textContent="Review unavailable";
      byId("overview-notice").className="band error";
      byId("overview-notice").textContent=error.message;
    });
  </script>
</body>
</html>`;
}

function escapeScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/</g, "\\u003c");
}
