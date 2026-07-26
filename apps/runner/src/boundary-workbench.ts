import { WORKBENCH_SYNTAX_CSS, workbenchSyntaxScript } from "./workbench-syntax.js";

export function renderBoundaryWorkbench(csrfToken: string): string {
  const escapedCsrf = escapeScriptString(csrfToken);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Auto Boundary Review | Synapsor Runner</title>
  <style>
    :root{color-scheme:light dark;--bg:#f7f8fa;--surface:#fff;--surface-2:#f1f4f5;--text:#162024;--muted:#5b696f;--line:#d3dcdf;--line-strong:#aebdc1;--accent:#087f73;--accent-strong:#05665e;--accent-soft:#e5f4f1;--warn:#8a5a00;--warn-soft:#fff4d6;--bad:#b42318;--bad-soft:#ffebe8;--good:#137333;--good-soft:#e8f5eb;--shadow:0 8px 28px rgba(22,32,36,.08)}
    @media(prefers-color-scheme:dark){:root{--bg:#101617;--surface:#182124;--surface-2:#222c2f;--text:#edf3f2;--muted:#aab7b8;--line:#35464b;--line-strong:#52666b;--accent:#5bcabb;--accent-strong:#79ddcf;--accent-soft:#173c38;--warn:#f4c86a;--warn-soft:#3d3219;--bad:#ff8d84;--bad-soft:#3f2221;--good:#70d58c;--good-soft:#1d3826;--shadow:none}}
    *{box-sizing:border-box;letter-spacing:0}
    body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    header{position:sticky;top:0;z-index:10;background:color-mix(in srgb,var(--surface) 94%,transparent);border-bottom:1px solid var(--line);backdrop-filter:blur(12px)}
    header>div,main{width:min(1440px,calc(100% - 40px));margin:auto}
    header>div{min-height:64px;display:flex;align-items:center;justify-content:space-between;gap:16px}
    .brand{display:flex;align-items:center;gap:11px;min-width:0}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:7px;background:var(--text);color:var(--surface);font-size:13px;font-weight:800}.brand-copy{min-width:0}.brand-copy p{font-size:12px;margin:0}.header-status{display:flex;align-items:center;gap:8px}
    h1{font-size:17px;margin:0}h2{font-size:20px;margin:0 0 7px}h3{font-size:15px;margin:0}
    p{margin:6px 0;color:var(--muted)}main{padding:24px 0 56px}
    button,input,select,textarea{font:inherit}
    button{min-height:38px;padding:8px 13px;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer;transition:background .15s ease,border-color .15s ease,transform .15s ease}
    button:not(:disabled):hover{background:var(--accent-strong);border-color:var(--accent-strong)}button:not(:disabled):active{transform:translateY(1px)}
    button.secondary{background:transparent;color:var(--accent)}button.quiet{background:var(--surface-2);border-color:var(--line);color:var(--text)}
    button.danger{background:var(--bad);border-color:var(--bad)}button:disabled{opacity:.5;cursor:not-allowed}
    button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
    input[type=text],input[type=number],input[type=datetime-local],select,textarea{width:100%;min-height:38px;padding:7px 9px;border:1px solid var(--line);border-radius:5px;background:var(--surface);color:var(--text)}
    input[type=checkbox],input[type=radio]{width:16px;height:16px;accent-color:var(--accent)}
    label.field{display:flex;flex-direction:column;gap:5px;color:var(--muted)}
    code,pre{font:12px ui-monospace,SFMono-Regular,Consolas,monospace}code{overflow-wrap:anywhere}
    pre{white-space:pre-wrap;overflow:auto;max-height:420px;background:var(--surface-2);border:1px solid var(--line);padding:12px;border-radius:5px}
    ${WORKBENCH_SYNTAX_CSS}
    .state{font-weight:700;color:var(--warn)}.state.good{color:var(--good)}
    .workbench-layout{display:grid;grid-template-columns:224px minmax(0,1fr);gap:32px;align-items:start}.workflow-rail{position:sticky;top:88px;min-width:0}.workspace{min-width:0;max-width:1080px}
    .rail-label{margin:0 0 9px;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--muted)}
    .steps{display:grid;gap:3px;background:transparent;margin:0}
    .step{min-height:44px;border:0;border-left:3px solid transparent;border-radius:0 6px 6px 0;background:transparent;color:var(--muted);font-weight:650;text-align:left;padding:9px 12px}
    .step:not(:disabled):hover{background:var(--surface-2);border-color:transparent;color:var(--text);transform:none}.step.active{background:var(--accent-soft);color:var(--accent);border-left-color:var(--accent)}
    .step.done{color:var(--good)}.view{display:none}.view.active{display:block}
    .rail-note{margin-top:18px;padding:13px;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:12px}.rail-note strong{display:block;margin-bottom:4px}.rail-note p{margin:0}
    .band{background:var(--surface);border:1px solid var(--line);padding:16px;margin:12px 0;border-radius:7px}
    .band .band{box-shadow:none}.workspace>.view>h2+.band{margin-top:14px}
    .notice{border-left:4px solid var(--warn);background:var(--warn-soft)}.success{border-left:4px solid var(--good);background:var(--good-soft)}
    .error{border-left:4px solid var(--bad);background:var(--bad-soft);color:var(--bad)}
    .summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--line);background:var(--surface)}
    .metric{padding:13px;border-right:1px solid var(--line)}.metric:last-child{border-right:0}.metric strong{display:block;font-size:21px}.metric span{color:var(--muted)}
	    .toolbar,.actions,.split-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.actions{margin-top:14px}.split-actions{justify-content:space-between}
	    .journey{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;gap:16px}.journey strong{display:block}.journey p{margin:2px 0}
    .resource-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin-top:12px}
    .resource{border:1px solid var(--line);background:var(--surface);padding:14px;border-radius:7px;min-width:0;transition:border-color .15s ease,box-shadow .15s ease}.resource:hover{border-color:var(--line-strong);box-shadow:var(--shadow)}
    .resource-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.resource-name{overflow-wrap:anywhere}
    .badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}.badge{display:inline-flex;padding:3px 7px;border-radius:999px;border:1px solid var(--line);font-size:12px;color:var(--muted);background:var(--surface-2)}
    .badge.bad{color:var(--bad);background:var(--bad-soft);border-color:var(--bad)}.badge.warn{color:var(--warn);background:var(--warn-soft);border-color:var(--warn)}.badge.good{color:var(--good);background:var(--good-soft);border-color:var(--good)}
    .risk-list{display:grid;gap:8px;margin-top:12px}.risk{border-left:3px solid var(--line);padding:9px 11px;background:var(--surface-2)}.risk.high{border-color:var(--bad)}.risk.unresolved{border-color:var(--warn)}
    .review-form{margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
     .scope-grid,.form-grid,.preflight{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.preflight{grid-template-columns:repeat(3,minmax(0,1fr))}.preflight>div{min-width:0}.preflight p{overflow-wrap:anywhere}
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
    .ask-surface{margin-top:22px;padding:0;background:var(--surface);border:1px solid var(--line);border-radius:7px;overflow:hidden}
    .ask-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:start;padding:18px;border-bottom:1px solid var(--line)}
    .ask-head p{max-width:720px}.ask-state{text-align:right}.ask-state .badge{margin-left:5px}
    .ask-body{padding:18px}.ask-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .ask-disclosure{padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:14px 0}
    .ask-transcript{display:grid;gap:10px;margin:14px 0}.ask-turn{padding:12px;border-left:3px solid var(--line);background:var(--surface-2)}.ask-turn.answer{border-color:var(--accent)}
    .ask-composer{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}.ask-composer textarea{min-height:96px;resize:vertical}.ask-composer-actions{display:grid;gap:8px;width:138px}
    .ask-tool-trace{margin-top:10px;border-top:1px solid var(--line);padding-top:10px}.ask-tool-trace summary{font-size:12px}
    .instant-path{border-left:4px solid var(--accent);scroll-margin-top:76px}.scope-question{border:0;padding:0;margin:0;min-width:0}.scope-question legend{font-weight:700;margin-bottom:6px}.instant-summary{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:12px}.instant-summary>div{padding:11px;background:var(--surface-2);border:1px solid var(--line);border-radius:5px}.instant-summary strong{display:block;margin-bottom:4px}.instant-result{margin-top:12px}.instant-completion{border-left:4px solid var(--good);padding:4px 0 4px 16px}.instant-completion>strong{display:block}.instant-completion details{margin-right:16px}
    .hidden{display:none!important}.screen-reader{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
	    @media(max-width:960px){.workbench-layout{grid-template-columns:1fr;gap:18px}.workflow-rail{position:static}.rail-label,.rail-note{display:none}.steps{display:flex;overflow-x:auto;border-bottom:1px solid var(--line);padding-bottom:1px}.step{flex:0 0 auto;min-width:150px;border-left:0;border-bottom:3px solid transparent;border-radius:6px 6px 0 0}.step.active{border-left:0;border-bottom-color:var(--accent)}}
	    @media(max-width:820px){header>div,main{width:calc(100% - 24px)}.summary{grid-template-columns:1fr 1fr}.metric:nth-child(2){border-right:0}.resource-list,.scope-grid,.form-grid,.preflight,.journey,.ask-grid{grid-template-columns:1fr}.footer-actions{position:static}.ask-head{grid-template-columns:1fr}.ask-state{text-align:left}.ask-state .badge{margin:0 5px 0 0}}
    @media(max-width:560px){.ask-composer{grid-template-columns:1fr}.ask-composer-actions{display:flex;flex-wrap:wrap;width:auto}.ask-composer-actions button{flex:1 1 120px}}
    @media(max-width:480px){header>div,main{width:calc(100% - 20px)}.brand-copy p{display:none}.header-status .badge{display:none}.summary{grid-template-columns:1fr}.metric{border-right:0;border-bottom:1px solid var(--line)}.toolbar>*,.actions>button{width:100%}.step{min-width:132px}.ask-head,.ask-body{padding:14px}}
  </style>
</head>
<body>
  <header><div><div class="brand"><span class="brand-mark" aria-hidden="true">S</span><div class="brand-copy"><h1>Synapsor Workbench</h1><p>Local data-access review</p></div></div><div class="header-status"><span class="badge">Source unchanged</span><span id="header-state" class="state">Loading</span></div></div></header>
  <main>
    <div class="workbench-layout">
      <aside class="workflow-rail">
        <p class="rail-label">Setup workflow</p>
        <nav class="steps" aria-label="Boundary review progress">
          <button class="step active" data-view="overview" type="button">1. Review data access</button>
          <button class="step" data-view="activate" type="button">2. Activate and try</button>
          <button class="step" data-view="explore" type="button">3. Analyze</button>
          <button class="step" data-view="protect" type="button">4. Make reusable</button>
          <button class="step" data-view="action" type="button">5. Add safe action</button>
        </nav>
        <div class="rail-note"><strong>No SQL or commit tool</strong><p>The agent can use only the exact access reviewed here.</p></div>
        <details class="rail-note">
          <summary>Plain-language glossary</summary>
          <p><strong>Customer limit:</strong> which organization's rows are eligible.</p>
          <p><strong>User limit:</strong> which assigned person's rows are eligible.</p>
          <p><strong>Review fingerprint:</strong> a tamper-evident ID for the exact choices you approved.</p>
        </details>
      </aside>
      <div class="workspace">

	    <section id="view-overview" class="view active">
	      <h2>Choose what your agent can see</h2>
	      <div class="band">
	        <strong>Synapsor is creating the small set of database powers your agent may use.</strong>
	        <p>It does not give the agent SQL access. The agent gets named, reviewed tools; reads return only approved fields and records. Writes create proposals and cannot be approved or applied by the model. The model also cannot activate new authority.</p>
	      </div>
	      <div id="overview-notice" class="band notice">Source rows remain unavailable until the exact reviewed boundary is active.</div>
	      <section id="instant-path" class="band instant-path hidden" aria-labelledby="instant-title">
	        <h3 id="instant-title">Get one safe read working now</h3>
	        <p>Runner picked one conservative data area, hid sensitive and uncertain fields, and disabled relationships and writes. Two short answers and one recorded activation gesture run a real bounded read through the same reviewed runtime.</p>
	        <div class="form-grid">
	          <label class="field">1. What kind of database is this?
	            <select id="instant-profile"><option value="">Choose one</option><option value="own_development">My own development or disposable test database</option><option value="shared_or_production">Shared, staging, or production-like data</option></select>
	          </label>
	          <fieldset class="scope-question">
	            <legend>2. What trusted scope should this session use?</legend>
	            <div class="scope-grid">
	              <label class="field">Customer or tenant value<input id="instant-tenant" type="text" maxlength="256" autocomplete="off"></label>
	              <label id="instant-principal-wrap" class="field">User or principal value<input id="instant-principal" type="text" maxlength="256" autocomplete="off"></label>
	            </div>
	            <p>These values stay in this Workbench process. They are not model arguments and are not written to generated files or the ledger.</p>
	          </fieldset>
	        </div>
	        <div id="instant-authority"></div>
	        <div class="actions"><button id="run-instant" type="button" disabled>Activate this narrow read and show a real result</button><span id="instant-status" class="status-message" role="status" aria-live="polite"></span></div>
	        <div id="instant-result" class="instant-result"></div>
	      </section>
	      <div id="journey-state" class="band journey" aria-live="polite"></div>
	      <div id="database-summary" class="band"></div>
	      <div id="summary" class="summary" aria-live="polite"></div>
      <div class="split-actions" style="margin-top:16px">
        <div>
          <h2>Data areas</h2>
          <p>Start with the flagged items. Detailed field controls remain available when needed.</p>
        </div>
	        <div class="toolbar">
	          <button id="show-all" class="secondary" type="button">Show all data areas</button>
	          <button id="show-risks" class="secondary" type="button">Show only risks</button>
	          <button id="show-exposed" class="secondary" type="button">Show visible data</button>
	          <button id="show-unresolved" class="secondary" type="button">Show blocked setup</button>
	        </div>
	      </div>
	      <div id="resources" class="resource-list"></div>
	      <div class="actions"><button id="overview-primary" data-next="exceptions" type="button">Review flagged access</button></div>
	      <details class="band"><summary>Existing project actions</summary><p>Resume does not inspect the database or rewrite files. Rescan is explicit. Start over resets managed boundary-review decisions but preserves the ledger, protected named capabilities, Runner config, and source database.</p><div class="actions"><button class="secondary" id="resume-review" type="button">Resume existing review</button><button class="secondary" id="try-active" type="button">Try active tools</button><button class="quiet" id="rescan-project" type="button">Rescan and review changes</button><button class="danger" id="start-over" type="button">Start over review</button></div><div id="project-action-message"></div></details>
	    </section>

    <section id="view-exceptions" class="view">
      <h2>Fix access that needs a human decision</h2>
      <p>Confirm which record identifies a row, which customer owns it, and whether each user is limited to their own rows.</p>
      <div class="band">
        <h3>Blocked data stays unavailable</h3>
        <p>Anything Runner cannot scope safely remains off. This screen can narrow access, never silently widen it.</p>
      </div>
      <div id="resource-detail" class="band"><p>Select a resource from Overview.</p></div>
      <div id="global-decisions" class="band"></div>
      <div class="actions"><button data-next="activate" type="button">Review final access</button></div>
    </section>

    <section id="view-activate" class="view">
      <h2>Activate the reviewed access</h2>
      <div id="signoff-summary" class="band"></div>
      <div class="form-grid">
        <label class="field">Where will you test this?
          <select id="deployment-profile"><option value="staging">Staging</option><option value="development">Development</option></select>
        </label>
        <label class="field">Who reviewed it?
          <input id="actor" type="text" maxlength="128" placeholder="alex@example.com" autocomplete="username">
          <span>An audit label for the local human reviewer, not a password or API key.</span>
        </label>
      </div>
      <div id="role-posture" class="band"></div>
      <div class="footer-actions">
        <button id="preview" class="secondary" type="button">Create review fingerprint</button>
        <button id="activate" type="button" disabled>Activate this access</button>
        <span id="message" class="status-message" role="status" aria-live="polite"></span>
      </div>
    </section>

    <section id="view-explore" class="view">
      <h2>Analyze reviewed data</h2>
      <p>Choose only from the fields and operations already activated for this local development or staging session.</p>
      <div id="explore-preflight" class="band"><button id="run-preflight" type="button">Check access and start</button></div>
      <div id="explorer" class="hidden">
        <div class="band">
          <div class="tabs" role="tablist" aria-label="Explore mode">
            <button id="aggregate-tab" class="tab active" type="button" role="tab">Trends and totals</button>
            <button id="row-tab" class="tab" type="button" role="tab">One record</button>
          </div>
          <div id="suggested-questions" class="question-list"></div>
          <div id="aggregate-builder" class="form-grid" style="margin-top:14px"></div>
          <div id="row-builder" class="form-grid hidden" style="margin-top:14px"></div>
          <details><summary>Advanced structured plan</summary><pre id="plan-preview"></pre></details>
          <div class="actions"><button id="run-explore" type="button">Run safe analysis</button></div>
        </div>
        <div id="explore-status" class="status-message" role="status" aria-live="polite"></div>
        <div id="explore-result"></div>
        <details class="band"><summary>Use an external MCP client</summary><div id="client-configs"></div></details>
      </div>
      <section id="ask-shell" class="ask-surface hidden" aria-labelledby="ask-title">
        <div class="ask-head">
          <div>
            <h3 id="ask-title">Ask with your model <span class="badge">Optional</span></h3>
            <p>Your model may call only the exact reviewed tools shown here. Activation, approval, apply, worker control, and notification control remain outside this surface.</p>
          </div>
          <div class="ask-state"><span id="ask-provider-state" class="badge">Not configured</span><span class="badge good">Source unchanged</span></div>
        </div>
        <div class="ask-body">
          <div id="ask-authority-summary"></div>
          <div id="ask-configuration">
            <div id="ask-configuration-form">
              <div class="ask-grid">
                <label class="field">Model provider
                  <select id="ask-provider">
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="openai_compatible">OpenAI-compatible or local</option>
                  </select>
                </label>
                <label class="field">Model
                  <input id="ask-model" type="text" maxlength="128" value="gpt-5-mini" autocomplete="off">
                </label>
                <label id="ask-base-url-wrap" class="field hidden">Provider base URL
                  <input id="ask-base-url" type="text" maxlength="2048" value="http://127.0.0.1:11434/v1" autocomplete="url" spellcheck="false">
                </label>
                <label class="field">Credential source
                  <select id="ask-key-source">
                    <option value="session">Paste for this Workbench session</option>
                    <option value="environment">Read an environment variable</option>
                    <option id="ask-no-key-option" value="none" disabled>No key (local/custom only)</option>
                  </select>
                </label>
                <label id="ask-key-wrap" class="field">Provider API key
                  <input id="ask-key" type="password" maxlength="4096" autocomplete="new-password" spellcheck="false">
                  <span>Held only in this Workbench process. It is not written to project files or the ledger.</span>
                </label>
                <label id="ask-key-env-wrap" class="field hidden">Environment variable name
                  <input id="ask-key-env" type="text" maxlength="128" value="OPENAI_API_KEY" autocomplete="off" spellcheck="false">
                </label>
              </div>
              <div class="ask-disclosure">
                <label class="check"><input id="ask-egress" type="checkbox"><span>I understand that approved visible fields and my question will go directly to this provider. Synapsor does not relay the request. Kept-out fields remain unavailable.</span></label>
              </div>
              <div class="actions"><button id="configure-ask" type="button">Use this model</button><span id="ask-config-status" class="status-message" role="status" aria-live="polite"></span></div>
            </div>
            <div id="ask-configured-summary" class="hidden">
              <div class="split-actions">
                <div><strong id="ask-configured-model"></strong><p id="ask-configured-detail"></p></div>
                <button id="change-ask-provider" class="secondary" type="button">Change model</button>
              </div>
              <span class="badge good">Consent matches the current reviewed tool surface</span>
            </div>
          </div>
          <div id="ask-chat" class="hidden">
            <div class="ask-disclosure"><strong>Session-only conversation</strong><p>Questions, tool results, and model responses stay in memory and are cleared when this Workbench stops or you select Clear. Model output is untrusted; database facts must come through a reviewed tool call.</p></div>
            <div id="ask-starters" class="question-list"></div>
            <div id="ask-transcript" class="ask-transcript" aria-live="polite"></div>
            <div class="ask-composer">
              <label class="field">Question
                <textarea id="ask-question" maxlength="4000" placeholder="Which reviewed regions contributed most to the weekly change?"></textarea>
              </label>
              <div class="ask-composer-actions">
                <button id="run-ask" type="button">Ask</button>
                <button id="cancel-ask" class="secondary" type="button" disabled>Cancel</button>
                <button id="clear-ask" class="quiet" type="button">Clear</button>
              </div>
            </div>
            <div id="ask-run-status" class="status-message" role="status" aria-live="polite"></div>
          </div>
        </div>
      </section>
    </section>

    <section id="view-protect" class="view">
      <h2>Make this analysis reusable</h2>
      <p>Freeze one successful analysis into a narrow named tool. It starts disabled and still needs human activation.</p>
      <div class="actions"><button id="refresh-protect" class="secondary" type="button">Load recent analyses</button></div>
      <div id="protect-queries"></div>
      <div id="protect-editor"></div>
      <span id="protect-message" class="status-message" role="status" aria-live="polite"></span>
    </section>

    <section id="view-action" class="view">
      <h2>Add a proposal-only write</h2>
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
      </div>
    </div>
  </main>
  <script>
    ${workbenchSyntaxScript()}
    const csrf="${escapedCsrf}";
    let original;
    let candidate;
    let reviewReport;
    let activeBoundary;
    let candidateDigest;
	    let currentView="overview";
	    let resourceFilter="starter";
	    let journey=null;
    let selectedResource=null;
    let openedResources=new Set();
    let confirmedDecisions=new Set();
    let reviewRevision=0;
    let reviewInvalidations=[];
    let exploreDescription=null;
    let exploreBudgets=null;
    let exploreMode="aggregate";
    let lastExplorePlan=null;
    let preferredProtectQueryRef=null;
    let protectQueries=[];
    let selectedProtect=null;
    let protectedDraft=null;
    let guidedActionData=null;
    let guidedActionDraft=null;
    let askStatus=null;
    let askStarterPrompts=[];
    let instantOnboarding=null;
    let reviewProgressHealthy=true;
    let progressSave=Promise.resolve();
    const permissions=[
      ["Show value","selectable_fields"],
      ["Filter","filterable_fields"],
      ["Sort","sortable_fields"],
      ["Group totals","groupable_fields"],
      ["Calculate totals","aggregate_measures"],
      ["Count unique","count_distinct_fields"],
      ["Chart by time","time_bucket_fields"]
    ];

    const byId=id=>document.getElementById(id);
    const esc=value=>String(value).replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
    const getJson=async url=>{const response=await fetch(url);const payload=await response.json();if(!response.ok||!payload.ok){const error=new Error(payload.error||"Request failed");error.payload=payload;throw error}return payload};
    const post=async(url,body)=>{const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json","x-synapsor-csrf":csrf},body:JSON.stringify(body)});const payload=await response.json();if(!response.ok||!payload.ok){const error=new Error(payload.error||"Request failed");error.payload=payload;throw error}return payload};
    const currentResource=id=>candidate&&candidate.pack.resources.find(resource=>resource.id===id);
    const reviewResource=id=>(reviewReport&&reviewReport.resources||[]).find(resource=>resource.id===id);
    const resourceDecisions=id=>(candidate?.unresolved_decisions||[]).filter(decision=>decision.startsWith(id+":"));
    const globalDecisions=()=>(candidate?.unresolved_decisions||[]).filter(decision=>!(reviewReport.resources||[]).some(resource=>decision.startsWith(resource.id+":")));
    const classificationFor=(id,field)=>{const resource=reviewResource(id);return resource&&resource.fields&&resource.fields.find(item=>item.name===field)?.sensitivity};
    const stateLabel=state=>state==="high_confidence_sensitive"?"Sensitive":state==="unresolved_free_text"?"Needs review":"Low structural risk";
    const hasActiveAuthority=()=>Boolean(activeBoundary)||journey?.authority_active===true;

    function renderInstantOnboarding(){
      const shell=byId("instant-path");
      if(!instantOnboarding?.eligible||activeBoundary){
        shell.classList.add("hidden");
        byId("overview-primary").classList.remove("secondary");
        return;
      }
      shell.classList.remove("hidden");
      byId("overview-primary").classList.add("secondary");
      const resource=instantOnboarding.candidate?.pack?.resources?.[0];
      if(!resource){
        byId("instant-authority").innerHTML='<div class="band notice">Runner could not identify a conservative starter resource. Continue with the full review below.</div>';
        byId("run-instant").disabled=true;
        return;
      }
      byId("instant-principal-wrap").classList.toggle("hidden",!instantOnboarding.requires_principal);
      byId("instant-authority").innerHTML='<div class="instant-summary"><div><strong>Agent can see</strong><code>'+esc((resource.selectable_fields||[]).join(", ")||"No raw fields; aggregate count only")+'</code></div><div><strong>Agent cannot see</strong><code>'+esc((resource.kept_out_fields||[]).join(", ")||"No additional fields were present")+'</code></div><div><strong>First data area</strong><code>'+esc(resource.id)+'</code></div><div><strong>Writes</strong>Unavailable. This path activates one local read boundary only.</div></div>';
      updateInstantAction();
    }

    function updateInstantAction(){
      const profile=byId("instant-profile").value;
      const button=byId("run-instant");
      if(profile==="shared_or_production"){
        button.disabled=false;
        button.textContent="Continue to full security review";
        byId("instant-status").textContent="Shared, staging, and production-like data use the full review. No authority has been activated.";
        return;
      }
      button.textContent="Activate this narrow read and show a real result";
      button.disabled=profile!=="own_development"||!byId("instant-tenant").value.trim()||(instantOnboarding.requires_principal&&!byId("instant-principal").value.trim());
      byId("instant-status").textContent=profile==="own_development"?"One click will record this development assertion, activate the exact narrow digest, and run one read.":"No authority is active.";
    }

    async function runInstantOnboarding(){
      if(byId("instant-profile").value==="shared_or_production"){
        setView("exceptions");
        return;
      }
      const button=byId("run-instant");
      const status=byId("instant-status");
      button.disabled=true;
      status.className="status-message";
      status.textContent="Rechecking the read-only role and exact schema, then running one scoped read...";
      try{
        const payload=await post("/api/instant/activate-and-read",{
          profile_assertion:"own_development",
          tenant:byId("instant-tenant").value,
          principal:byId("instant-principal").value
        });
        activeBoundary=payload.active;
        instantOnboarding.eligible=false;
        const form=byId("instant-path").querySelector(".form-grid");
        form?.classList.add("hidden");
        byId("instant-authority").classList.add("hidden");
        byId("instant-tenant").value="";
        byId("instant-principal").value="";
        button.closest(".actions")?.classList.add("hidden");
        byId("header-state").textContent="First safe tool working";
        byId("header-state").className="state good";
        byId("overview-notice").className="band success";
        byId("overview-notice").textContent="The conservative local read boundary is active. Source database changed: no.";
        byId("journey-state").innerHTML='<div><strong>Your first safe tool is working.</strong><p>Agent data access active: yes · Source database changed: no</p></div><span class="badge good">Narrow read active</span>';
        byId("instant-result").innerHTML='<div class="instant-completion"><strong>Your first safe tool is working.</strong><p>Tool: <code>'+esc(payload.first_tool)+'</code> · Data area: <code>'+esc(payload.resource)+'</code></p><p>Agent can see: <code>'+esc((payload.agent_can_see||[]).join(", ")||"bounded aggregate only")+'</code></p><p>Agent cannot see: <code>'+esc((payload.agent_cannot_see||[]).join(", ")||"none")+'</code></p><p>Tenant scope: '+esc(payload.tenant_scope)+' · Principal scope: '+esc(payload.principal_scope)+'</p><p><strong>Source database changed: no</strong></p><details><summary>Real bounded result</summary><pre>'+esc(JSON.stringify(payload.result,null,2))+'</pre></details>'+(payload.graduation_tip?'<p>'+esc(payload.graduation_tip)+'</p>':'')+'<div class="actions"><button id="instant-next" type="button">Ask a bounded aggregate question</button></div></div>';
        byId("instant-next").onclick=()=>setView("explore");
        document.querySelector('[data-view="activate"]').classList.add("done");
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
        button.disabled=false;
      }
    }

    function setView(view){
      currentView=view;
      document.querySelectorAll(".view").forEach(node=>node.classList.toggle("active",node.id==="view-"+view));
      document.querySelectorAll(".step").forEach(node=>node.classList.toggle("active",node.dataset.view===(view==="exceptions"?"overview":view)));
      if(view==="activate")renderSignoff();
      if(view==="explore"){
        if(activeBoundary)runPreflight();
        loadAskStatus();
      }
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
	      const includedIds=new Set(candidate.pack.resources.map(resource=>resource.id));
	      const unresolved=(reviewReport.resources||[])
	        .filter(resource=>includedIds.has(resource.id))
	        .flatMap(resource=>resource.fields||[])
	        .filter(field=>field.sensitivity?.state==="unresolved_free_text").length;
	      const exposed=candidate.pack.resources.reduce((total,resource)=>total+resource.selectable_fields.length,0);
	      const hidden=candidate.pack.resources.reduce((total,resource)=>total+resource.kept_out_fields.length,0);
      byId("summary").innerHTML=[
	        [candidate.pack.resources.length,"data areas included"],
	        [exposed,"fields the agent can see"],
	        [hidden,"fields hidden from the agent"],
	        [unresolved,"fields needing review"]
	      ].map(item=>'<div class="metric"><strong>'+esc(item[0])+'</strong><span>'+esc(item[1])+'</span></div>').join("");
	      const tenantResolved=(reviewReport.resources||[]).filter(resource=>resource.tenant_key?.selected).length;
	      const principalResolved=(reviewReport.resources||[]).filter(resource=>resource.principal_key?.selected).length;
		      byId("database-summary").innerHTML='<h3>Database connected</h3><p><strong>'+esc(String(reviewReport.engine||"database").toUpperCase())+'</strong> · read role <code>'+esc(reviewReport.database_role?.name||"unknown")+'</code> · '+esc(summary.objects)+' data area(s) inspected.</p><p>'+esc(summary.draft_reads)+' can be reviewed now; '+esc(summary.blocked_objects)+' stay unavailable. Customer isolation was detected for '+esc(tenantResolved)+' area(s). Per-user row limits were detected for '+esc(principalResolved)+' area(s). '+esc(summary.sensitive_fields_kept_out)+' sensitive field(s) were hidden conservatively across the inspected schema.</p>';
	    }

	    function renderResources(){
	      const sources=(reviewReport.resources||[]).filter(review=>{
	        const source=original.pack.resources.find(resource=>resource.id===review.id);
	        const raw=source?.selectable_fields.length||0;
	        const unresolved=(review.fields||[]).some(field=>field.sensitivity?.state==="unresolved_free_text");
	        if(resourceFilter==="risks")return riskCount({id:review.id})>0;
	        if(resourceFilter==="exposed")return raw>0;
	        if(resourceFilter==="unresolved")return unresolved;
	        if(resourceFilter==="starter")return Boolean(currentResource(review.id))||riskCount({id:review.id})>0||review.status!=="draft_read";
	        return true;
	      }).sort((left,right)=>{
	        const includedDifference=Number(Boolean(currentResource(right.id)))-Number(Boolean(currentResource(left.id)));
	        if(includedDifference)return includedDifference;
	        const riskDifference=riskCount({id:right.id})-riskCount({id:left.id});
	        return riskDifference||left.id.localeCompare(right.id);
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
          const badgeText=blocked?"Blocked":!included?"Not included":risks?risks+" item(s) need review":"Ready to confirm";
          const badgeClass=blocked?"bad":!included?"":risks?"warn":"good";
		        return '<article class="resource" data-risk="'+risks+'"><div class="resource-head"><div><h3 class="resource-name">'+esc(review.id)+'</h3><p>'+esc(blocked?"Unavailable: "+(review.blockers||[]).join("; "):included?"Included in the agent data set":"Excluded from the agent data set")+'</p></div><span class="badge '+badgeClass+'">'+esc(badgeText)+'</span></div><div class="badges"><span class="badge">'+esc(raw)+' visible</span><span class="badge">'+esc(kept)+' hidden</span><span class="badge">record ID: '+esc(primary)+'</span></div><p>Customer column <code>'+esc(tenant)+'</code> · User/owner column <code>'+esc(principal)+'</code></p><div class="actions"><button class="secondary" data-open-resource="'+esc(review.id)+'" type="button">Review access</button>'+(source?'<label class="check"><input type="checkbox" data-resource-toggle="'+esc(review.id)+'" '+(included?"checked":"")+'> Include</label>':'')+'</div></article>';
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
      }
      const includedIds=new Set(candidate.pack.resources.map(resource=>resource.id));
      candidate.pack.resources.forEach(resource=>{
        const generated=original.pack.resources.find(item=>item.id===resource.id);
        resource.relationships=(generated?.relationships||[])
          .filter(relation=>includedIds.has(relation.target_resource)
            &&(relation.proof?.links||[]).every(link=>includedIds.has(link.source_resource)&&includedIds.has(link.target_resource)))
          .map(relation=>structuredClone(relation));
      });
      syncCandidateDecisions();
      invalidateDigest();
      renderSummary();
      renderResources();
      queueReviewProgressSave();
    }

    function syncCandidateDecisions(){
      if(!candidate||!original)return;
      const retained=new Map(candidate.pack.resources.map(resource=>[resource.id,resource]));
      candidate.unresolved_decisions=(original.unresolved_decisions||[]).filter(decision=>{
        if(decision.startsWith("deployment profile:")||decision.startsWith("trusted context:")||decision.startsWith("database role:"))return true;
        const separator=decision.indexOf(": ");
        if(separator<1)return true;
        const resource=retained.get(decision.slice(0,separator));
        if(!resource)return false;
        const match=/^review relationship (.+) cardinality and scope on (.+)$/.exec(decision.slice(separator+2));
        return !match||resource.relationships.some(item=>item.id===match[1]&&item.target_resource===match[2]);
      });
      const required=new Set(candidate.unresolved_decisions);
      confirmedDecisions=new Set([...confirmedDecisions].filter(decision=>required.has(decision)));
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
      syncCandidateDecisions();
      invalidateResourceReview(id);
      renderResourceDetail();
    }

    function setRelationshipSemantics(id,relationshipId,value){
      const resource=currentResource(id);
      const relationship=resource?.relationships.find(item=>item.id===relationshipId);
      if(!relationship||!["exclude","keep_null"].includes(value))return;
      relationship.unmatched_rows=value;
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
        status.textContent="Saving this reviewed choice and updating only the affected access...";
        await post("/api/boundary/regenerate",{
          kind:"field_exposure",
          resource_id:selectedResource,
          field,
          exposure,
          actor,
          reason
        });
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
      return '<div class="review-form hidden" data-managed-review-form data-field="'+esc(field)+'" data-exposure="'+esc(exposure)+'"><label class="field">Human reviewer<input data-review-actor type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><label class="field">Reason<textarea data-review-reason maxlength="500" rows="2" placeholder="'+esc(placeholder)+'"></textarea></label><div class="actions"><button data-submit-field-review="'+esc(field)+'" data-exposure="'+esc(exposure)+'" type="button">Save this reviewed choice</button><button class="quiet" data-cancel-field-review type="button">Cancel</button></div><span data-review-status class="status-message"></span></div>';
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
        status.textContent="Saving this reviewed choice and updating only the affected access...";
        await post("/api/boundary/regenerate",{
          kind,
          resource_id:selectedResource,
          value,
          actor,
          reason
        });
        candidateDigest=undefined;
        await load();
        setView("exceptions");
        renderResourceDetail();
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function inferenceExplanation(label,inference){
      if(!inference)return "";
      const selected=inference.selected;
      const selectedAlternative=(inference.alternatives_considered||[]).find(item=>item.value===selected);
      const evidence=selectedAlternative?.evidence||inference.evidence?.map(item=>item.detail)||[];
      const alternatives=(inference.alternatives_considered||[]).filter(item=>item.value!==selected);
      const heading=selected
        ?"Suggested "+label+": "+selected
        :"Runner did not choose a "+label;
      const reason=evidence.length
        ?evidence.slice(0,3).join(" ")
        :inference.blocked_reason||"The inspected metadata does not prove a safe choice.";
      return '<div class="risk '+(selected?"unresolved":"high")+'"><strong>'+esc(heading)+'</strong><p><strong>Why:</strong> '+esc(reason)+'</p><p><strong>If unresolved:</strong> This data area stays unavailable to the agent.</p><p><strong>Safety consequence:</strong> '+esc(inference.safety_consequence||"A wrong choice could widen access.")+'</p>'
        +(alternatives.length?'<details><summary>Other inspected candidates</summary>'+alternatives.map(item=>'<p><code>'+esc(item.value)+'</code> · '+esc(item.confidence)+' confidence'+(item.evidence?.length?' · '+esc(item.evidence[0]):"")+'</p>').join("")+'</details>':"")
        +(inference.blocked_reason?'<p>'+esc(inference.blocked_reason)+'</p>':"")
        +'</div>';
    }

    function managedScopeReviewForm(kind,label,values,current,allowNone=false,inference){
      const ranked=(inference?.alternatives_considered||[]).map(item=>item.value);
      const ordered=[...new Set([...ranked,...values])];
      const options=[
        ...(allowNone?[{value:"__none__",label:"No per-user row limit"}]:[]),
        ...ordered.map(value=>{
          const alternative=(inference?.alternatives_considered||[]).find(item=>item.value===value);
          const suffix=alternative?.selected?" — suggested":alternative?" — alternative":"";
          return {value,label:value+suffix};
        })
      ];
      return inferenceExplanation(label,inference)+'<div class="review-form" data-scope-review-form><h3>Confirm or change the '+esc(label)+'</h3><div class="form-grid"><label class="field">Database column<select data-scope-review-value>'+options.map(option=>'<option value="'+esc(option.value)+'" '+((current===undefined&&option.value==="__none__")||current===option.value?"selected":"")+'>'+esc(option.label)+'</option>').join("")+'</select></label><label class="field">Human reviewer<input data-scope-review-actor type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><label class="field">Why is this correct?<textarea data-scope-review-reason maxlength="500" rows="2" placeholder="Describe the application rule this column enforces."></textarea></label></div><div class="actions"><button data-submit-scope-review="'+esc(kind)+'" type="button">Save this reviewed choice</button></div><span data-scope-review-status class="status-message"></span></div>';
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
          const payload=await post("/api/boundary/progress",{
            candidate:savedCandidate,
            confirmed_decisions:savedDecisions,
            expected_revision:reviewRevision,
            actor:byId("actor").value.trim()
          });
          reviewRevision=payload.revision;
          reviewInvalidations=payload.invalidated_decisions||[];
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
          const decisionLabel=resolvingIdentity?"record ID backed by a unique database key":"customer-isolation column";
          const decisionInference=resolvingIdentity?review.primary_key:review.tenant_key;
          const resolution=candidateValues.length
            ?'<p>Your choice updates the public DSL, canonical JSON, tests, and review fingerprint. It does not activate access.</p>'+managedScopeReviewForm(kind,decisionLabel,candidateValues,undefined,false,decisionInference)
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
          :kept?"Hidden from the agent by default":"Human decision required";
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
      const advanced=resource?'<details><summary>Advanced permissions</summary><p>Turning a permission off narrows access. Fields hidden by Runner cannot be restored in this review.</p><div style="overflow:auto"><table class="permission-table"><thead><tr><th>Field</th>'+permissions.map(item=>'<th>'+esc(item[0])+'</th>').join("")+'<th>Hidden</th></tr></thead><tbody>'+permissionRows+'</tbody></table></div></details>':'<p>This data area is excluded. Return to Data access to include it.</p>';
      const sourceFields=Object.keys(source.field_types).sort();
      const scopeReview=resource?'<details><summary>Record and customer limits</summary><p>Runner reads these values from trusted application context. The AI never supplies them.</p>'+managedScopeReviewForm("row_identity","record ID",review.primary_key?.candidates||[],source.primary_key,false,review.primary_key)+managedScopeReviewForm("tenant_key","customer-isolation column",sourceFields,source.tenant_key,false,review.tenant_key)+managedScopeReviewForm("principal_key","user/owner column",sourceFields,source.principal_key,true,review.principal_key)+'</details>':"";
      const unresolvedRelationship=resource?.relationships.some(relationship=>relationship.unmatched_rows==="review_required");
      const relationshipReview=resource?.relationships.length
        ?'<details '+(unresolvedRelationship?"open":"")+'><summary>Reviewed related data</summary><p>Only database foreign keys that cannot multiply '+esc(source.table)+' records are available. The AI cannot invent another join.</p><div class="risk-list">'+resource.relationships.map(relationship=>{
          const links=relationship.proof?.links||[];
          const constraints=links.map(link=>link.constraint_name+" ("+link.source_resource+" → "+link.target_resource+")").join("; ")||relationship.id;
          const nullable=relationship.nullable===true;
          const choice=relationship.unmatched_rows||"exclude";
          return '<div class="risk '+(choice==="review_required"?"unresolved":"")+'"><strong>'+esc(relationship.target_resource)+'</strong><p>'+esc((relationship.path_depth||1)+" proven many-to-one link"+((relationship.path_depth||1)===1?"":"s")+". Evidence: "+constraints+".")+'</p>'
            +(nullable?'<label class="field">When a related record is missing<select data-relationship-semantics="'+esc(relationship.id)+'"><option value="review_required" '+(choice==="review_required"?"selected":"")+' disabled>Choose explicitly</option><option value="keep_null" '+(choice==="keep_null"?"selected":"")+'>Keep the counted record and show an empty group value</option><option value="exclude" '+(choice==="exclude"?"selected":"")+'>Exclude the counted record from this analysis</option></select></label><p>This choice changes business totals and is bound into the review fingerprint.</p>':'<p>The foreign-key columns are required, so an inner match does not silently drop valid counted records.</p>')
            +'</div>';
        }).join("")+'</div></details>'
        :'<p>No related data is proposed for this area.</p>';
      byId("resource-detail").innerHTML='<div class="split-actions"><div><h3>'+esc(selectedResource)+'</h3><p>Record ID <code>'+esc(source.primary_key)+'</code> · Customer <code>'+esc(source.tenant_key)+'</code> · User/owner <code>'+esc(source.principal_key||"not configured")+'</code></p></div><button class="secondary" id="back-resources" type="button">Back to data areas</button></div><div class="scope-grid" style="margin-top:12px"><div><strong>Values the agent can see</strong><p>'+esc(resource?resource.selectable_fields.join(", ")||"none":"excluded")+'</p></div><div><strong>Available only as totals</strong><p>'+esc(resource?resource.aggregate_measures.filter(field=>!resource.selectable_fields.includes(field)).join(", ")||"none":"excluded")+'</p></div></div><h3 style="margin-top:16px">Items needing attention</h3><div class="risk-list">'+riskHtml+'</div>'+relationshipReview+scopeReview+advanced+'<div class="actions"><label class="check"><input id="resource-signoff" type="checkbox" data-review-decision="'+esc(selectedResource)+'" '+(resourceConfirmed?"checked":"")+(resource&&!unresolvedRelationship?"":" disabled")+'><span>I reviewed which records and fields this agent may use, including privacy limits and related data.</span></label></div>';
      byId("back-resources").onclick=()=>setView("overview");
      document.querySelectorAll("[data-open-field-review]").forEach(button=>button.onclick=()=>openManagedFieldReview(button.dataset.openFieldReview,button.dataset.exposure));
      document.querySelectorAll("[data-submit-field-review]").forEach(button=>button.onclick=()=>submitManagedFieldReview(button.dataset.submitFieldReview,button.dataset.exposure));
      document.querySelectorAll("[data-cancel-field-review]").forEach(button=>button.onclick=()=>button.closest("[data-managed-review-form]").classList.add("hidden"));
      document.querySelectorAll("[data-submit-scope-review]").forEach(button=>button.onclick=()=>submitManagedScopeReview(button.dataset.submitScopeReview,button.closest("[data-scope-review-form]")));
      document.querySelectorAll("[data-permission-field]").forEach(input=>input.onchange=()=>setPermission(selectedResource,input.dataset.permissionField,input.dataset.permissionKey,input.checked));
      document.querySelectorAll("[data-relationship-semantics]").forEach(input=>input.onchange=()=>setRelationshipSemantics(selectedResource,input.dataset.relationshipSemantics,input.value));
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
      byId("global-decisions").innerHTML='<h3>Final safety confirmations</h3><p>Runner cannot decide these from table and column names.</p>'+decisions.map((decision,index)=>'<label class="check" style="margin-top:10px" title="'+esc(decision)+'"><input type="checkbox" data-review-decision="global" data-global-decision="'+index+'" '+(confirmedDecisions.has(decision)?"checked":"")+'><span>'+esc(humanDecision(decision))+'</span></label>').join("");
      document.querySelectorAll("[data-global-decision]").forEach(input=>input.onchange=()=>{
        const decision=decisions[Number(input.dataset.globalDecision)];
        if(input.checked)confirmedDecisions.add(decision);else confirmedDecisions.delete(decision);
        invalidateDigest();
        queueReviewProgressSave();
      });
    }

    function humanDecision(decision){
      if(decision.startsWith("deployment profile:"))return "This is a development or staging setup, not production.";
      if(decision.startsWith("trusted context:"))return "Your application chooses the customer and user. The AI cannot change either.";
      if(decision.startsWith("database role:"))return "The database login is verified read-only and cannot bypass row security.";
      if(decision.includes(": confirm tenant key "))return decision.slice(0,decision.indexOf(":"))+": confirm the customer-isolation column.";
      if(decision.includes(": confirm principal scope "))return decision.slice(0,decision.indexOf(":"))+": confirm whether each user is limited to their own rows.";
      if(decision.endsWith(": confirm visible and kept-out fields"))return decision.slice(0,decision.indexOf(":"))+": confirm which field values the agent can and cannot see.";
      if(decision.endsWith(": confirm filter/sort/group/aggregate-only field permissions"))return decision.slice(0,decision.indexOf(":"))+": confirm how fields may be searched, sorted, grouped, or totaled.";
      if(decision.endsWith(": confirm minimum cohort and extraction/differencing budgets"))return decision.slice(0,decision.indexOf(":"))+": confirm privacy and result-size limits.";
      if(decision.includes(": review relationship "))return decision.slice(0,decision.indexOf(":"))+": confirm this reviewed table relationship cannot widen access.";
      return decision;
    }

    function allDecisionsConfirmed(){
      const decisions=candidate?.unresolved_decisions||[];
      return decisions.length>0&&decisions.every(decision=>confirmedDecisions.has(decision));
    }

    function renderSignoff(){
      if(!candidate||!reviewReport)return;
      const total=candidate.unresolved_decisions.length;
      const done=candidate.unresolved_decisions.filter(decision=>confirmedDecisions.has(decision)).length;
      const outstanding=candidate.unresolved_decisions.filter(decision=>!confirmedDecisions.has(decision));
      const resourceIds=new Set((reviewReport.resources||[]).map(resource=>resource.id));
      const globalOutstanding=outstanding.filter(decision=>![...resourceIds].some(id=>decision.startsWith(id+":")));
      const remainingResources=[...new Set(outstanding
        .map(decision=>decision.slice(0,decision.indexOf(": ")))
        .filter(id=>resourceIds.has(id)))];
      const nextBlocker=outstanding[0];
      byId("signoff-summary").innerHTML='<h3>'+esc(done)+' of '+esc(total)+' required decisions reviewed</h3>'
        +(outstanding.length
          ?'<p><strong>One next step:</strong> '+esc(humanDecision(nextBlocker))+'</p><p>'+esc(outstanding.length)+' decision'+(outstanding.length===1?"":"s")+' remain ('+(globalOutstanding.length?esc(globalOutstanding.length)+" final safety / ":"")+esc(remainingResources.length)+' data-area).</p><button id="review-next-blocker" class="secondary" type="button">Go to next decision</button>'
          :'<p>Every final safety and data-area decision is confirmed.</p>')
        +(reviewInvalidations.length?'<p>'+esc(reviewInvalidations.length)+' earlier confirmation'+(reviewInvalidations.length===1?" was":"s were")+' invalidated because reviewed inputs changed.</p>':"")
        +'<p>Data areas: '+esc(candidate.pack.resources.length)+' / Visible fields: '+esc(candidate.pack.resources.reduce((sum,resource)=>sum+resource.selectable_fields.length,0))+' / Hidden fields: '+esc(candidate.pack.resources.reduce((sum,resource)=>sum+resource.kept_out_fields.length,0))+'</p>';
      byId("review-next-blocker")?.addEventListener("click",()=>{
        const separator=nextBlocker.indexOf(": ");
        if(separator>0&&reviewResource(nextBlocker.slice(0,separator))){
          openResource(nextBlocker.slice(0,separator));
        }else{
          selectedResource=null;
          setView("exceptions");
          renderResourceDetail();
          byId("global-decisions").scrollIntoView({behavior:"smooth",block:"center"});
        }
      });
      byId("deployment-profile").value=candidate.deployment_profile;
      renderRolePosture();
      updateActivationState();
    }

    function renderRolePosture(){
      const role=reviewReport.database_role||{};
      byId("role-posture").innerHTML='<h3>Database login safety</h3><p><code>'+esc(role.name||"unknown")+'</code> is '+esc(role.verified===true?"verified":"not verified")+', '+esc(role.read_only===true?"read-only":"not read-only")+', and '+esc(role.superuser===false&&role.bypass_rls===false?"cannot bypass database row security":"may bypass database protections")+'.</p><details><summary>Exact database role posture</summary><p>Superuser: '+esc(String(role.superuser))+' · BYPASSRLS: '+esc(String(role.bypass_rls))+' · Fingerprint <code>'+esc(role.fingerprint||candidate.role_posture_fingerprint)+'</code></p></details>';
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
        message.textContent="Review fingerprint: "+candidateDigest;
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

    async function loadAskStatus(){
      const shell=byId("ask-shell");
      try{
        const payload=await getJson("/api/ask/status");
        askStatus=payload;
        shell.classList.remove("hidden");
        renderAskStatus();
      }catch(error){
        askStatus=null;
        shell.classList.add("hidden");
      }
    }

    function renderAskStatus(){
      if(!askStatus)return;
      const tools=askStatus.tools||[];
      const available=askStatus.available&&tools.length>0;
      const session=askStatus.session||{};
      const authority=byId("ask-authority-summary");
      if(!available){
        authority.className="notice";
        authority.innerHTML='<strong>No reviewed model tool is active yet.</strong><p>Activate a reviewed read or proposal tool first. Ask never creates or widens authority.</p>';
        byId("ask-configuration").classList.add("hidden");
        byId("ask-chat").classList.add("hidden");
        byId("ask-provider-state").textContent="No reviewed tools";
        return;
      }
      const toolNames=tools.map(tool=>tool.name);
      const boundaryBadge=askStatus.active_boundary_digest
        ?'<span class="badge">Boundary '+esc(String(askStatus.active_boundary_digest).slice(0,18))+'…</span>'
        :'';
      authority.className="";
      authority.innerHTML='<div class="split-actions"><div><strong>'+esc(tools.length)+' reviewed tool'+(tools.length===1?"":"s")+' available to the model</strong><p>'+esc(toolNames.slice(0,3).join(", "))+(toolNames.length>3?" and "+esc(toolNames.length-3)+" more":"")+'</p></div><div class="badges">'+boundaryBadge+'<span class="badge">Ask authority '+esc(String(askStatus.authority_digest).slice(0,18))+'…</span></div></div><details><summary>Inspect exact model tool surface</summary><ul>'+tools.map(tool=>'<li><code>'+esc(tool.name)+'</code> · '+esc(tool.description||"Reviewed Synapsor tool")+'</li>').join("")+'</ul></details>';
      byId("ask-configuration").classList.remove("hidden");
      const consentCurrent=session.configured&&askStatus.authority_matches_consent;
      byId("ask-chat").classList.toggle("hidden",!consentCurrent);
      byId("ask-configuration-form").classList.toggle("hidden",Boolean(consentCurrent));
      byId("ask-configured-summary").classList.toggle("hidden",!consentCurrent);
      byId("ask-provider-state").textContent=consentCurrent
        ? providerLabel(session.configuration.provider)+" ready"
        : session.configured
          ?"Review changed"
          :"Not configured";
      byId("ask-provider-state").className="badge "+(consentCurrent?"good":session.configured?"warn":"");
      if(session.configuration){
        byId("ask-provider").value=session.configuration.provider;
        byId("ask-model").value=session.configuration.model;
        updateAskProviderFields(false);
        byId("ask-configured-model").textContent=providerLabel(session.configuration.provider)+" · "+session.configuration.model;
        byId("ask-configured-detail").textContent="Direct to "+session.configuration.endpoint_origin+" · "+credentialSourceLabel(session.configuration.credential_source)+" · no Synapsor relay or saved conversation.";
        byId("ask-config-status").className="status-message";
        byId("ask-config-status").textContent=consentCurrent
          ?"Ready. Provider key and conversation remain in this Workbench process only."
          :"The reviewed tool surface changed. Acknowledge provider egress again.";
      }
      renderAskStarters();
    }

    function providerLabel(provider){
      return provider==="openai"?"OpenAI":provider==="anthropic"?"Anthropic":"Custom model";
    }

    function credentialSourceLabel(source){
      return source==="session_paste"?"session-only pasted key":source==="environment"?"environment credential":"no provider key";
    }

    function showAskConfiguration(){
      byId("ask-configuration-form").classList.remove("hidden");
      byId("ask-configured-summary").classList.add("hidden");
      byId("ask-config-status").className="status-message";
      byId("ask-config-status").textContent="Changing the provider or model requires a new egress acknowledgement for the current reviewed tools.";
      byId("ask-egress").checked=false;
      byId("ask-provider").focus();
    }

    function renderAskStarters(){
      const panel=byId("ask-starters");
      const prompts=askStarterPrompts.slice(0,3);
      if(!prompts.length){
        panel.innerHTML='<strong>Ask through the reviewed tools</strong><p>Use a plain-language question below. The model can call only the named tools shown above and cannot widen their database access.</p>';
        return;
      }
      panel.innerHTML='<strong>Try a reviewed question</strong><p>These suggestions use only activated data-area metadata.</p>'+prompts.map((prompt,index)=>'<button class="question" data-ask-starter="'+index+'" type="button">'+esc(prompt)+'</button>').join("");
      document.querySelectorAll("[data-ask-starter]").forEach(button=>button.onclick=()=>{
        byId("ask-question").value=prompts[Number(button.dataset.askStarter)]||"";
        byId("ask-question").focus();
      });
    }

    function updateAskProviderFields(resetModel=true){
      const provider=byId("ask-provider").value;
      const custom=provider==="openai_compatible";
      const baseWrap=byId("ask-base-url-wrap");
      const noKey=byId("ask-no-key-option");
      baseWrap.classList.toggle("hidden",!custom);
      noKey.disabled=!custom;
      if(!custom&&byId("ask-key-source").value==="none")byId("ask-key-source").value="session";
      if(resetModel){
        byId("ask-model").value=provider==="openai"
          ?"gpt-5-mini"
          :provider==="anthropic"
            ?"claude-sonnet-4-20250514"
            :"llama3.2";
        byId("ask-key-env").value=provider==="openai"
          ?"OPENAI_API_KEY"
          :provider==="anthropic"
            ?"ANTHROPIC_API_KEY"
            :"MODEL_API_KEY";
      }
      updateAskCredentialFields();
    }

    function updateAskCredentialFields(){
      const source=byId("ask-key-source").value;
      byId("ask-key-wrap").classList.toggle("hidden",source!=="session");
      byId("ask-key-env-wrap").classList.toggle("hidden",source!=="environment");
      if(source!=="session")byId("ask-key").value="";
    }

    async function configureAsk(){
      const status=byId("ask-config-status");
      try{
        if(!askStatus?.available)throw new Error("Activate a reviewed tool before configuring Ask.");
        const provider=byId("ask-provider").value;
        const keySource=byId("ask-key-source").value;
        const body={
          provider,
          model:byId("ask-model").value.trim(),
          authority_digest:askStatus.authority_digest,
          egress_acknowledged:byId("ask-egress").checked
        };
        if(provider==="openai_compatible")body.base_url=byId("ask-base-url").value.trim();
        if(keySource==="session")body.api_key=byId("ask-key").value;
        if(keySource==="environment")body.api_key_env=byId("ask-key-env").value.trim();
        status.className="status-message";
        status.textContent="Verifying provider settings and binding consent to the reviewed tools...";
        const payload=await post("/api/ask/configure",body);
        byId("ask-key").value="";
        byId("ask-egress").checked=false;
        status.textContent=payload.egress_notice+" Next: Ask one bounded question.";
        await loadAskStatus();
        byId("ask-question").focus();
      }catch(error){
        byId("ask-key").value="";
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    async function runAsk(){
      const status=byId("ask-run-status");
      const question=byId("ask-question").value.trim();
      if(!question){
        status.className="status-message error";
        status.textContent="Enter one question.";
        return;
      }
      const run=byId("run-ask");
      const cancel=byId("cancel-ask");
      const transcript=byId("ask-transcript");
      run.disabled=true;
      cancel.disabled=false;
      status.className="status-message";
      status.textContent="Your model is choosing among the exact reviewed tools...";
      transcript.insertAdjacentHTML("beforeend",'<div class="ask-turn"><strong>You</strong><p>'+esc(question)+'</p></div>');
      byId("ask-question").value="";
      try{
        const payload=await post("/api/ask/run",{question});
        const proposals=(payload.tool_calls||[]).map(call=>proposalIdFromAskResult(call.result)).filter(Boolean);
        const traces=(payload.tool_calls||[]).map(call=>{const proposalId=proposalIdFromAskResult(call.result);return '<div><strong>'+esc(call.tool)+'</strong> <span class="badge '+(call.status==="ok"?"good":"bad")+'">'+esc(call.status)+'</span>'+(proposalId?'<p>Proposal <code>'+esc(proposalId)+'</code> · source database unchanged</p>':'')+'<details class="ask-tool-trace"><summary>Bounded arguments and redacted result</summary><pre>'+esc(JSON.stringify({arguments:call.arguments,result:call.result},null,2))+'</pre></details></div>'}).join("");
        transcript.insertAdjacentHTML("beforeend",'<div class="ask-turn answer"><strong>'+esc(providerLabel(payload.provider))+'</strong><p>'+esc(payload.answer)+'</p>'+(traces?'<div class="ask-tool-trace">'+traces+'</div>':'')+(proposals.length?'<div class="notice"><strong>Proposal only</strong><p>The source database did not change. The model cannot approve or apply this proposal.</p></div>':'')+'</div>');
        status.className="status-message";
        status.textContent=payload.next_action||"Ask another bounded question.";
      }catch(error){
        transcript.insertAdjacentHTML("beforeend",'<div class="ask-turn error"><strong>Request refused safely</strong><p>'+esc(error.message)+'</p><p>Source database changed: no</p></div>');
        status.className="status-message error";
        status.textContent=error.message;
      }finally{
        run.disabled=false;
        cancel.disabled=true;
      }
    }

    function proposalIdFromAskResult(result){
      if(!result||typeof result!=="object")return null;
      if(typeof result.proposal_id==="string")return result.proposal_id;
      if(result.proposal&&typeof result.proposal==="object"){
        if(typeof result.proposal.proposal_id==="string")return result.proposal.proposal_id;
        if(typeof result.proposal.id==="string")return result.proposal.id;
      }
      return result.change_set&&typeof result.change_set.proposal_id==="string"
        ?result.change_set.proposal_id
        :null;
    }

    async function cancelAsk(){
      const status=byId("ask-run-status");
      try{
        const payload=await post("/api/ask/cancel",{});
        status.className="status-message";
        status.textContent=payload.next_action;
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    async function clearAsk(){
      const status=byId("ask-run-status");
      try{
        const payload=await post("/api/ask/clear",{});
        byId("ask-transcript").textContent="";
        byId("ask-question").value="";
        byId("ask-key").value="";
        status.className="status-message";
        status.textContent=payload.next_action;
        await loadAskStatus();
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
      const suggestions=resources.flatMap(resource=>{
        const dimension=resource.groupable_fields?.[0];
        const measure=resource.aggregate_measures?.[0];
        const timeField=Object.keys(resource.time_bucket_fields||{})[0];
        const fallback={
          text:timeField&&dimension
            ?"How did "+(measure?"total "+fieldLabel(resource,measure).toLowerCase():resourceLabel(resource).toLowerCase())+" change by week across "+fieldLabel(resource,dimension).toLowerCase()+"?"
            :dimension
              ?"Which "+fieldLabel(resource,dimension).toLowerCase()+" groups contain the most "+resourceLabel(resource).toLowerCase()+"?"
              :"How many reviewed "+resourceLabel(resource).toLowerCase()+" records are available?",
          measure:measure?{function:"sum",field:measure}:{function:"count"},
          ...(dimension?{dimension}:{}),
          ...(timeField?{time_field:timeField,time_bucket:"week"}:{})
        };
        return (resource.suggested_questions?.length?resource.suggested_questions:[fallback]).map(question=>({resource,question}));
      }).slice(0,3);
      askStarterPrompts=suggestions.map(item=>item.question.text).filter(Boolean);
      renderAskStarters();
      byId("suggested-questions").innerHTML='<div class="split-actions"><div><h3>Start with a reviewed question</h3><p>These suggestions use only the measures, groups, and dates already approved.</p></div></div>'
        +suggestions.map((suggestion,index)=>'<button class="question '+(index===0?"selected":"")+'" data-question="'+index+'" type="button">'+esc(suggestion.question.text)+'<br><span class="badge">'+esc(suggestion.resource.label||suggestion.resource.id)+'</span></button>').join("");
      document.querySelectorAll("[data-question]").forEach(button=>button.onclick=()=>{
        document.querySelectorAll("[data-question]").forEach(item=>item.classList.remove("selected"));
        button.classList.add("selected");
        const suggestion=suggestions[Number(button.dataset.question)];
        populateAggregateBuilder(suggestion.resource.id,suggestion.question);
      });
      const firstSuggestion=suggestions[0];
      populateAggregateBuilder(firstSuggestion?.resource.id||resources[0].id,firstSuggestion?.question);
      populateRowBuilder(resources[0].id);
      renderClientConfigs();
    }

    function resourceLabel(resource){
      return resource?.label||String(resource?.id||"").split(".").pop().replace(/_/g," ");
    }

    function fieldLabel(resource,field){
      return resource?.field_labels?.[field]||String(field).replace(/_/g," ");
    }

    function fieldChoices(resource,key){
      const own=key==="filterable_fields"||key==="time_bucket_fields"
        ?Object.keys(resource?.[key]||{})
        :resource?.[key]||[];
      const choices=own.map(field=>({
        field,
        label:fieldLabel(resource,field),
        field_types:resource.field_types||{},
        filter_operators:resource.filter_operators||{},
        time_bucket_fields:resource.time_bucket_fields||{}
      }));
      for(const relationship of resource?.relationships||[]){
        const related=key==="filterable_fields"||key==="time_bucket_fields"
          ?Object.keys(relationship[key]||{})
          :relationship[key]||[];
        related.forEach(field=>choices.push({
          field,
          relationship:relationship.id,
          label:fieldLabel(relationship,field)+" — "+(relationship.label||relationship.target_resource)
            +(relationship.operator_review_required?" — human relationship review required":""),
          field_types:relationship.field_types||{},
          filter_operators:relationship.filter_operators||{},
          time_bucket_fields:relationship.time_bucket_fields||{}
        }));
      }
      return choices;
    }

    function fieldChoiceValue(choice){
      return JSON.stringify({
        field:choice.field,
        ...(choice.relationship?{relationship:choice.relationship}:{})
      });
    }

    function parseFieldChoice(value){
      if(!value)return null;
      const parsed=JSON.parse(value);
      if(!parsed||typeof parsed.field!=="string")throw new Error("The selected reviewed field is invalid.");
      return parsed;
    }

    function normalizedSuggestedField(value){
      if(!value)return null;
      return typeof value==="string"?{field:value}:value;
    }

    function fieldReferenceLabel(resource,reference){
      if(!reference)return "";
      if(!reference.relationship)return fieldLabel(resource,reference.field);
      const relationship=(resource.relationships||[]).find(item=>item.id===reference.relationship);
      return fieldLabel(relationship,reference.field)+" from "+(relationship?.label||relationship?.target_resource||"reviewed related data");
    }

    function optionList(values,selected,labelForValue=value=>value){
      return values.map(value=>'<option value="'+esc(value)+'" '+(value===selected?"selected":"")+'>'+esc(labelForValue(value))+'</option>').join("");
    }

    function measureOptions(resource){
      return [
        {value:JSON.stringify({function:"count"}),label:"Number of "+resourceLabel(resource).toLowerCase()},
        ...fieldChoices(resource,"aggregate_measures").flatMap(choice=>[
          {value:JSON.stringify({function:"sum",field:choice.field,...(choice.relationship?{relationship:choice.relationship}:{})}),label:"Total "+choice.label.toLowerCase()},
          {value:JSON.stringify({function:"avg",field:choice.field,...(choice.relationship?{relationship:choice.relationship}:{})}),label:"Average "+choice.label.toLowerCase()}
        ]),
        ...fieldChoices(resource,"count_distinct_fields").map(choice=>({
          value:JSON.stringify({function:"count_distinct",field:choice.field,...(choice.relationship?{relationship:choice.relationship}:{})}),
          label:"Number of unique "+choice.label.toLowerCase()
        }))
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

    function populateAggregateBuilder(resourceId,suggestion){
      const resources=resourcesFromDescription();
      const resource=resources.find(item=>item.id===resourceId)||resources[0];
      const dimensions=fieldChoices(resource,"groupable_fields");
      const timeFields=fieldChoices(resource,"time_bucket_fields");
      const filters=fieldChoices(resource,"filterable_fields");
      const measures=measureOptions(resource);
      const suggestedMeasure=suggestion?.measure
        ?JSON.stringify(suggestion.measure)
        :measures[0]?.value;
      const suggestedDimensions=(Array.isArray(suggestion?.dimensions)?suggestion.dimensions:[suggestion?.dimension])
        .map(normalizedSuggestedField)
        .filter(Boolean);
      const suggestedDimensionValues=[
        suggestedDimensions[0]?fieldChoiceValue(suggestedDimensions[0]):dimensions[0]?fieldChoiceValue(dimensions[0]):"",
        suggestedDimensions[1]?fieldChoiceValue(suggestedDimensions[1]):"",
        suggestedDimensions[2]?fieldChoiceValue(suggestedDimensions[2]):""
      ];
      const suggestedTime=normalizedSuggestedField(suggestion?.time_field);
      const suggestedTimeValue=suggestedTime?fieldChoiceValue(suggestedTime):timeFields[0]?fieldChoiceValue(timeFields[0]):"";
      const suggestedBucket=suggestion?.time_bucket||"week";
      const ranges=defaultComparisonRanges();
      const maximumGroups=Math.min(10,Math.max(1,resource.maximum_groups||10));
      byId("aggregate-builder").innerHTML=
        '<label class="field">Data area<select id="aggregate-resource">'+optionList(resources.map(item=>item.id),resource.id,value=>resourceLabel(resources.find(item=>item.id===value)))+'</select></label>'+
        '<label class="field">What should Runner calculate?<select id="aggregate-measure">'+measures.map(item=>'<option value="'+esc(item.value)+'" '+(item.value===suggestedMeasure?"selected":"")+'>'+esc(item.label)+'</option>').join("")+'</select></label>'+
        '<label class="field">Compare groups by<select id="aggregate-dimension"><option value="">No grouping</option>'+optionList(dimensions.map(fieldChoiceValue),suggestedDimensionValues[0],value=>dimensions.find(choice=>fieldChoiceValue(choice)===value)?.label||value)+'</select></label>'+
        '<label class="field">And optionally by<select id="aggregate-dimension-2"><option value="">No second group</option>'+optionList(dimensions.map(fieldChoiceValue),suggestedDimensionValues[1],value=>dimensions.find(choice=>fieldChoiceValue(choice)===value)?.label||value)+'</select></label>'+
        '<label class="field">And optionally by<select id="aggregate-dimension-3"><option value="">No third group</option>'+optionList(dimensions.map(fieldChoiceValue),suggestedDimensionValues[2],value=>dimensions.find(choice=>fieldChoiceValue(choice)===value)?.label||value)+'</select></label>'+
        '<label class="field">Show change over time using<select id="aggregate-time"><option value="">No time grouping</option>'+optionList(timeFields.map(fieldChoiceValue),suggestedTimeValue,value=>timeFields.find(choice=>fieldChoiceValue(choice)===value)?.label||value)+'</select></label>'+
        '<label class="field">Time interval<select id="aggregate-bucket"><option value="week" '+(suggestedBucket==="week"?"selected":"")+'>Week</option><option value="day" '+(suggestedBucket==="day"?"selected":"")+'>Day</option><option value="month" '+(suggestedBucket==="month"?"selected":"")+'>Month</option></select></label>'+
        '<label class="field">Order result<select id="aggregate-order"><option value="measure:desc">Largest measure first</option><option value="measure:asc">Smallest measure first</option><option value="time_bucket:asc">Oldest bucket first</option><option value="time_bucket:desc">Newest bucket first</option></select></label>'+
        '<label class="field">Maximum groups<input id="aggregate-top" type="number" min="1" max="'+esc(resource.maximum_groups||25)+'" value="'+esc(maximumGroups)+'"></label>'+
        '<label class="field">Optional filter<select id="aggregate-filter"><option value="">No filter</option>'+optionList(filters.map(fieldChoiceValue),undefined,value=>filters.find(choice=>fieldChoiceValue(choice)===value)?.label||value)+'</select></label>'+
        '<label class="field">Filter operator<select id="aggregate-filter-op"><option value="eq">Equals</option></select></label>'+
        '<label class="field">Filter value<input id="aggregate-filter-value" type="text" maxlength="256" placeholder="Enter a value"></label>'+
        '<label class="check"><input id="aggregate-compare" type="checkbox" '+(timeFields.length?"":"disabled")+'><span>Compare two date ranges</span></label>'+
        '<label class="field comparison hidden">Earlier period start<input id="period-1-start" type="datetime-local" value="'+ranges[0]+'"></label>'+
        '<label class="field comparison hidden">Earlier period end<input id="period-1-end" type="datetime-local" value="'+ranges[1]+'"></label>'+
        '<label class="field comparison hidden">Later period start<input id="period-2-start" type="datetime-local" value="'+ranges[2]+'"></label>'+
        '<label class="field comparison hidden">Later period end<input id="period-2-end" type="datetime-local" value="'+ranges[3]+'"></label>'+
        '<div id="explore-guardrails" class="band notice"><strong>This form cannot widen data access.</strong><p>Your application supplies the customer and user outside this form. Hidden fields never appear as choices. Results stop at '+esc(resource.maximum_groups||"the reviewed number of")+' groups, and groups smaller than '+esc(resource.minimum_cohort_size)+' are suppressed.</p></div>';
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
      const choice=parseFieldChoice(byId("aggregate-filter").value);
      const catalog=choice?fieldChoices(resource,"filterable_fields").find(item=>fieldChoiceValue(item)===fieldChoiceValue(choice)):null;
      const operators=catalog?.filter_operators?.[choice?.field]||["eq"];
      byId("aggregate-filter-op").innerHTML=operators.map(operator=>'<option value="'+esc(operator)+'">'+esc(operator==="eq"?"Equals":operator==="neq"?"Does not equal":operator.toUpperCase())+'</option>').join("");
      byId("aggregate-filter-value").disabled=!choice;
    }

    function refreshTimeBucketOptions(){
      const resource=resourcesFromDescription().find(item=>item.id===byId("aggregate-resource").value);
      const choice=parseFieldChoice(byId("aggregate-time").value);
      const catalog=choice?fieldChoices(resource,"time_bucket_fields").find(item=>fieldChoiceValue(item)===fieldChoiceValue(choice)):null;
      const buckets=catalog?.time_bucket_fields?.[choice?.field]||["week"];
      const current=byId("aggregate-bucket").value;
      byId("aggregate-bucket").innerHTML=buckets.map(bucket=>'<option value="'+esc(bucket)+'" '+(bucket===current?"selected":"")+'>'+esc(bucket[0].toUpperCase()+bucket.slice(1))+'</option>').join("");
      const timeOrderOptions=byId("aggregate-order").querySelectorAll('option[value^="time_bucket:"]');
      timeOrderOptions.forEach(option=>option.disabled=!choice);
    }

    function populateRowBuilder(resourceId){
      const resources=resourcesFromDescription();
      const resource=resources.find(item=>item.id===resourceId)||resources[0];
      const fields=(resource.selectable_fields||[]).slice().sort((left,right)=>{
        const priority=field=>field===resource.primary_key?0:/(^|_)id$/i.test(field)?2:1;
        return priority(left)-priority(right);
      });
      byId("row-builder").innerHTML=
        '<label class="field">Data area<select id="row-resource">'+optionList(resources.map(item=>item.id),resource.id,value=>resourceLabel(resources.find(item=>item.id===value)))+'</select></label>'+
        '<label class="field">Exact '+esc(fieldLabel(resource,resource.primary_key||"record ID"))+'<input id="row-id" type="text" maxlength="256" placeholder="Enter a real record ID"></label>'+
        '<label class="field">Values to return<select id="row-fields" multiple size="'+Math.min(6,Math.max(3,fields.length))+'">'+fields.map((field,index)=>'<option value="'+esc(field)+'" '+(index<Math.min(5,fields.length)?"selected":"")+'>'+esc(fieldLabel(resource,field))+'</option>').join("")+'</select></label>'+
        '<div class="band notice"><strong>The AI cannot choose another customer or user.</strong><p>Your application supplies those trusted values outside this form.</p></div>';
      byId("row-resource").onchange=()=>populateRowBuilder(byId("row-resource").value);
      document.querySelectorAll("#row-builder input,#row-builder select").forEach(input=>input.addEventListener("change",updatePlanPreview));
      updatePlanPreview();
    }

    function isoValue(id){
      const value=byId(id)?.value;
      return value?new Date(value).toISOString():null;
    }

    function typedFilterValue(resource,choice,operator,value){
      const catalog=fieldChoices(resource,"filterable_fields").find(item=>fieldChoiceValue(item)===fieldChoiceValue(choice));
      const field=choice.field;
      if(operator==="in")return value.split(",").map(item=>typedFilterValue(resource,choice,"eq",item.trim()));
      const type=String(catalog?.field_types?.[field]||"").toLowerCase();
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
      const measure=JSON.parse(byId("aggregate-measure").value);
      const dimensions=["aggregate-dimension","aggregate-dimension-2","aggregate-dimension-3"]
        .map(id=>parseFieldChoice(byId(id).value))
        .filter(Boolean);
      const dimensionKeys=dimensions.map(fieldChoiceValue);
      if(new Set(dimensionKeys).size!==dimensionKeys.length){
        throw new Error("Choose each reviewed grouping field only once.");
      }
      const timeField=parseFieldChoice(byId("aggregate-time").value);
      const filterField=parseFieldChoice(byId("aggregate-filter").value);
      const filterOperator=byId("aggregate-filter-op").value;
      const filterText=byId("aggregate-filter-value").value.trim();
      const [orderKind,orderDirection]=byId("aggregate-order").value.split(":");
      const plan={
        kind:"aggregate",
        resource:resourceId,
        measures:[measure],
        ...(dimensions.length?{dimensions}:{}),
        ...(timeField?{time_bucket:{...timeField,bucket:byId("aggregate-bucket").value}}:{}),
        ...(filterField&&filterText?{where:[{...filterField,op:filterOperator,value:typedFilterValue(resource,filterField,filterOperator,filterText)}]}:{}),
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
        if(ranges.every(range=>range.start&&range.end)&&timeField)plan.comparison={...timeField,ranges};
      }
      return plan;
    }

    function planSentence(plan){
      const resource=resourcesFromDescription().find(item=>item.id===plan.resource);
      if(plan.kind==="rows")return "Read one exact "+resourceLabel(resource).toLowerCase()+" record and return only "+plan.select.map(field=>fieldLabel(resource,field)).join(", ")+".";
      const measures=plan.measures.map(measure=>{
        if(measure.function==="count")return "the number of records";
        if(measure.function==="count_distinct")return "the number of unique "+fieldReferenceLabel(resource,measure).toLowerCase();
        return (measure.function==="sum"?"total ":"average ")+fieldReferenceLabel(resource,measure).toLowerCase();
      }).join(", ");
      const groups=(plan.dimensions||[]).map(item=>fieldReferenceLabel(resource,item)).join(", ");
      const filters=(plan.where||[]).map(item=>fieldReferenceLabel(resource,item)+" "+(item.op==="eq"?"equals":item.op)+" "+JSON.stringify(item.value)).join(", ");
      return "Calculate "+measures+" for "+resourceLabel(resource).toLowerCase()+(groups?" grouped by "+groups:"")+(plan.time_bucket?" for each "+plan.time_bucket.bucket:"")+(filters?" where "+filters:"")+" with at most "+plan.top_n+" groups.";
    }

    function resultColumnLabel(plan,key){
      const resource=resourcesFromDescription().find(item=>item.id===plan.resource);
      if(plan.kind==="rows")return fieldLabel(resource,key);
      const dimension=/^dimension_(\\d+)$/.exec(key);
      if(dimension){
        const value=plan.dimensions?.[Number(dimension[1])];
        return value?fieldReferenceLabel(resource,value):"Reviewed group";
      }
      const measure=/^measure_(\\d+)$/.exec(key);
      if(measure){
        const value=plan.measures?.[Number(measure[1])];
        if(!value)return "Reviewed measure";
        if(value.function==="count")return "Record count";
        if(value.function==="count_distinct")return "Unique "+fieldReferenceLabel(resource,value);
        return (value.function==="sum"?"Total ":"Average ")+fieldReferenceLabel(resource,value);
      }
      if(key==="time_bucket")return (plan.time_bucket?.bucket||"Time")+" · "+fieldReferenceLabel(resource,plan.time_bucket);
      if(key==="period_index")return "Comparison period";
      if(key==="cohort_count")return "Cohort size";
      if(key==="suppressed")return "Privacy status";
      return String(key).replace(/_/g," ");
    }

    function resultDataHtml(plan,data){
      if(!Array.isArray(data)||!data.length)return '<p>No rows or groups passed the reviewed scope and privacy thresholds.</p>';
      const columns=[...new Set(data.flatMap(row=>Object.keys(row)))];
      const cell=value=>value===null||value===undefined?"—":typeof value==="object"?JSON.stringify(value):String(value);
      return '<div class="result-table"><table><thead><tr>'+columns.map(column=>'<th>'+esc(resultColumnLabel(plan,column))+'</th>').join("")+'</tr></thead><tbody>'
        +data.map(row=>'<tr>'+columns.map(column=>'<td>'+esc(cell(row[column]))+'</td>').join("")+'</tr>').join("")
        +'</tbody></table></div><details><summary>Bounded JSON for developers</summary><pre>'+esc(JSON.stringify(data,null,2))+'</pre></details>';
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
	        preferredProtectQueryRef=result.protect?.token||null;
	        const reviewedResource=currentResource(plan.resource);
	        const visible=plan.kind==="rows"
	          ?plan.select.map(field=>fieldLabel(resourcesFromDescription().find(item=>item.id===plan.resource),field))
	          :plan.measures.map(measure=>measure.function+(measure.field?"("+fieldReferenceLabel(resourcesFromDescription().find(item=>item.id===plan.resource),measure)+")":""))
	            .concat((plan.dimensions||[]).map(dimension=>fieldReferenceLabel(resourcesFromDescription().find(item=>item.id===plan.resource),dimension)),plan.time_bucket?[fieldReferenceLabel(resourcesFromDescription().find(item=>item.id===plan.resource),plan.time_bucket)]:[]);
	        const unavailable=(reviewedResource?.kept_out_fields||[]).join(", ")||"all fields outside this reviewed result";
	        status.textContent="Returned through the reviewed boundary. Source database changed: no.";
	        resultPanel.innerHTML='<section class="band success"><h3>Your first safe tool is working.</h3><p>'+esc(planSentence(plan))+'</p><p><strong>Tool (local authoring only):</strong> <code>app.explore_data</code><br><strong>Agent can use:</strong> '+esc(visible.join(", ")||"reviewed row count")+'<br><strong>Agent cannot use:</strong> '+esc(unavailable)+'<br><strong>Customer scope:</strong> supplied by your trusted application environment<br><strong>User scope:</strong> '+esc(reviewedResource?.principal_key?"supplied by your trusted application environment":"not configured for this data area")+'<br><strong>Source database changed:</strong> no</p><p>This temporary analysis access is not a production tool. Make the useful analysis reusable and activate it separately before production use.</p><div class="result-meta"><span class="badge good">'+esc(result.audit.returned_rows_or_groups)+' row(s) / group(s)</span><span class="badge">'+esc(result.audit.returned_cells)+' cells</span><span class="badge">'+esc(result.privacy.suppressed_groups)+' suppressed</span><span class="badge">No source mutation</span></div>'+resultDataHtml(plan,result.data)+'<p>'+esc(result.untrusted_data_notice)+'</p><button id="protect-result" type="button">'+esc(plan.kind==="aggregate"?"Make this analysis reusable":"Ask a bounded aggregate question")+'</button></section>';
	        byId("protect-result").onclick=async()=>{if(plan.kind==="aggregate"){await loadProtect(preferredProtectQueryRef);setView("protect")}else{switchExploreMode("aggregate");window.scrollTo({top:0,behavior:"smooth"})}};
      }catch(error){
        const remediation=error.payload?.remediation;
        const relationshipReview=error.payload?.details?.relationship_review;
        status.className="status-message error";
        status.textContent=error.message;
        const evidence=relationshipReview?.evidence||[];
        resultPanel.innerHTML='<section class="band error"><h3>Request refused safely</h3><p>'+esc(error.message)+'</p>'
          +(relationshipReview
            ?'<div class="risk"><strong>Catalog proof available for human review</strong><p>Counted entity: <code>'+esc(relationshipReview.counted_entity)+'</code> · Path depth: '+esc(relationshipReview.path_depth)+' · Nullable: '+esc(String(relationshipReview.nullable))+'</p>'+evidence.map(link=>'<p><code>'+esc(link.constraint)+'</code>: '+esc(link.source_resource+"."+link.source_columns.join(","))+' → unique '+esc(link.target_resource+"."+link.target_columns.join(","))+' · '+esc(link.cardinality)+' · max fan-out '+esc(link.max_fan_out)+'</p>').join("")+'<label class="field">Human reviewer<input id="relationship-review-actor" type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><button id="review-missing-relationship" type="button">Review and add this relationship</button><span id="relationship-review-status" class="status-message"></span></div>'
            :"")
          +(remediation?'<p><strong>Next action:</strong> '+esc(remediation.action)+'</p><p>'+esc(remediation.preserved)+'</p>':"")+'</section>';
        if(relationshipReview)byId("review-missing-relationship").onclick=()=>stageRelationshipReview(relationshipReview);
      }
    }

    async function stageRelationshipReview(review){
      const status=byId("relationship-review-status");
      try{
        const actor=(byId("relationship-review-actor")?.value||byId("actor").value).trim();
        if(!actor)throw new Error("Enter your human reviewer identity before changing authority.");
        byId("actor").value=actor;
        status.className="status-message";
        status.textContent="Staging this exact catalog proof for normal boundary review...";
        const payload=await post("/api/boundary/review-relationship",{
          resource:review.resource,
          relationship:review.relationship,
          active_boundary_digest:review.active_boundary_digest,
          actor,
          confirmation:"REVIEW RELATIONSHIP "+review.proof_digest
        });
        candidate=payload.candidate;
        confirmedDecisions=new Set(payload.confirmed_decisions||[]);
        reviewRevision=payload.revision;
        reviewInvalidations=payload.invalidated_decisions||[];
        candidateDigest=payload.candidate_digest;
        if(review.nullable){
          status.className="status-message";
          status.textContent=payload.message+" This path is nullable, so choose whether unmatched records stay under an empty group or are excluded before activation.";
          selectedResource=review.resource;
          setView("exceptions");
          renderResourceDetail();
          return;
        }
        byId("explore-result").innerHTML='<section class="band notice"><h3>Exact relationship staged for activation</h3><p>'+esc(payload.message)+'</p><p><strong>Review fingerprint:</strong> <code>'+esc(payload.candidate_digest)+'</code></p><p>The active boundary has not changed. Activating this exact fingerprint adds only the catalog-proven path shown above.</p><button id="activate-reviewed-relationship" type="button">Activate this exact reviewed path</button><span id="relationship-activation-status" class="status-message"></span></section>';
        byId("activate-reviewed-relationship").onclick=()=>activateReviewedRelationship(payload);
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    async function activateReviewedRelationship(staged){
      const status=byId("relationship-activation-status");
      try{
        status.className="status-message";
        status.textContent="Rechecking the exact catalog proof, schema lock, and database-role posture...";
        const payload=await post("/api/boundary/activate",{
          candidate:staged.candidate,
          expected_digest:staged.candidate_digest,
          actor:byId("actor").value.trim(),
          confirmation:"ACTIVATE "+staged.candidate_digest,
          confirmed_decisions:staged.confirmed_decisions
        });
        activeBoundary=payload.active;
        byId("header-state").textContent="Active reviewed boundary";
        byId("header-state").className="state good";
        document.querySelector('[data-view="activate"]').classList.add("done");
        byId("explore-result").innerHTML='<section class="band success"><h3>Reviewed relationship active</h3><p>'+esc(payload.message)+'</p><p><strong>Active fingerprint:</strong> <code>'+esc(staged.candidate_digest)+'</code><br><strong>Source database changed:</strong> no</p><button id="retry-reviewed-relationship" type="button">Try the refused analysis again</button></section>';
        byId("retry-reviewed-relationship").onclick=runExplore;
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

		    function renderClientConfigs(){
		      const command="npx -y @synapsor/runner mcp serve --authoring --project-root .";
		      const config={mcpServers:{synapsor_authoring:{command:"npx",args:["-y","@synapsor/runner","mcp","serve","--authoring","--project-root","."]}}};
		      const codex='[mcp_servers.synapsor_authoring]\\ncommand = "npx"\\nargs = '+JSON.stringify(config.mcpServers.synapsor_authoring.args);
		      byId("client-configs").innerHTML='<p>Every path receives the same two local authoring tools and no approval or commit tool. Runner never puts database credentials in these files.</p><h3>Managed project installers</h3><p>Each command previews and owns only the <code>synapsor</code> entry, preserves other project settings, and creates a backup before editing an existing file.</p><pre>'+esc("synapsor-runner mcp install cursor --project --authoring --project-root . --yes\\nsynapsor-runner mcp install claude-code --project --authoring --project-root . --yes\\nsynapsor-runner mcp install vscode --project --authoring --project-root . --yes")+'</pre><h3>Generic stdio MCP</h3><pre>'+esc(JSON.stringify(config,null,2))+'</pre><h3>Direct server command</h3><p>Use this in another local MCP client. No model API key is needed by Runner.</p><pre>'+esc(command)+'</pre><h3>Codex</h3><pre>'+esc(codex)+'</pre>';
		    }

    async function loadProtect(preferredRef=preferredProtectQueryRef){
      const status=byId("protect-message");
      try{
        const payload=await getJson("/api/protect");
        protectQueries=payload.queries||[];
        const preferredIndex=preferredRef?protectQueries.findIndex(query=>query.query_ref===preferredRef):-1;
        selectedProtect=protectQueries.length?(preferredIndex>=0?preferredIndex:0):null;
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
      document.querySelectorAll("[data-protect-index]").forEach(button=>button.onclick=()=>{selectedProtect=Number(button.dataset.protectIndex);preferredProtectQueryRef=protectQueries[selectedProtect]?.query_ref||null;protectedDraft=null;renderProtect()});
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
        byId("protect-preview").innerHTML='<h3 style="margin-top:16px">Disabled named capability</h3><p>Digest <code>'+esc(payload.draft.contract_digest)+'</code></p><pre id="protect-dsl-preview"></pre><div class="form-grid"><label class="field">Operator identity<input id="protect-actor" type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><label class="field">Exact activation confirmation<input id="protect-confirmation" type="text" placeholder="ACTIVATE '+esc(payload.draft.contract_digest)+'"></label></div><label class="check" style="margin-top:12px"><input id="protect-disable-explore" type="checkbox"><span>Disable temporary Scoped Explore now. Leave this off while adding the guided safe action; authoring can be finished and disabled afterward.</span></label><div class="actions"><button id="activate-protected" type="button">Activate exact digest</button></div>';
        renderSyntaxCode("protect-dsl-preview",payload.dsl,"synapsor-dsl");
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
      byId("action-draft").innerHTML='<section class="band success"><h3>Disabled reviewable action</h3><p><strong>Capability:</strong> '+esc(draft.capability)+'<br><strong>Operation:</strong> '+esc(draft.operation.toUpperCase())+'<br><strong>Supervised execution permission:</strong> '+(draft.supervised_worker_execution?"Contract side enabled; deployment side still required":"Off")+'<br><strong>Digest:</strong> <code>'+esc(draft.contract_digest)+'</code><br><strong>Source database changed:</strong> no</p><details><summary>Review generated public DSL</summary><pre id="action-dsl-preview"></pre></details><h3 style="margin-top:16px">Exact staging proposal preview</h3><p>Use a real row identifier and bounded values. This calls the actual proposal runtime; it cannot approve or apply.</p><div class="form-grid">'+inputs+'</div><div class="actions"><button id="preview-action" type="button">Create preview proposal</button></div><div id="action-activation"></div></section>';
      renderSyntaxCode("action-dsl-preview",payload.dsl||"Open "+draft.dsl_path+" to inspect the persisted public DSL.","synapsor-dsl");
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
      instantOnboarding=payload.instant_onboarding;
      const namedAuthorityActive=!activeBoundary&&journey?.authority_active===true;
      const anyAuthorityActive=Boolean(activeBoundary)||namedAuthorityActive;
      confirmedDecisions=new Set(payload.confirmed_decisions||[]);
      reviewRevision=payload.review_progress?.revision||0;
      reviewInvalidations=payload.review_progress?.invalidated_decisions||[];
      reviewProgressHealthy=true;
      byId("deployment-profile").value=candidate.deployment_profile;
      if(payload.operator_identity)byId("actor").value=payload.operator_identity;
      byId("header-state").textContent=activeBoundary
        ?"Active reviewed boundary"
        :namedAuthorityActive
          ?"Reviewed named tools active"
          :"No data access active";
      byId("header-state").className=anyAuthorityActive?"state good":"state";
      byId("overview-notice").className=anyAuthorityActive?"band success":"band notice";
	      byId("overview-notice").textContent=activeBoundary
	        ?"The reviewed local data access is active. Named production tools remain separate."
        :namedAuthorityActive
          ?"Reviewed named tools are active. Temporary Scoped Explore is off."
	        :"Source rows remain unavailable until you review and activate this access.";
	      const next=journey?.recommended_next_action||(anyAuthorityActive?"Try an active reviewed tool.":"Review what the agent can see.");
	      byId("journey-state").innerHTML='<div><strong>'+esc(next)+'</strong><p>Agent data access active: '+esc(anyAuthorityActive?"yes":"no")+' · Source database changed: no</p></div><span class="badge '+(anyAuthorityActive?"good":"warn")+'">'+esc(activeBoundary?"Reviewed local access active":namedAuthorityActive?"Reviewed named tools active":"Source rows unavailable")+'</span>';
	      const primary=byId("overview-primary");
	      primary.textContent=anyAuthorityActive?"Try active tools":"Review security exceptions";
	      primary.dataset.next=anyAuthorityActive?"explore":"exceptions";
	      renderSummary();
      renderInstantOnboarding();
      renderResources();
      renderResourceDetail();
      renderSignoff();
      if(anyAuthorityActive)document.querySelector('[data-view="activate"]').classList.add("done");
    }

	    document.querySelectorAll("[data-view]").forEach(button=>button.onclick=()=>setView(button.dataset.view));
	    function setResourceFilter(filter){
	      resourceFilter=resourceFilter===filter?"all":filter;
	      byId("show-all").textContent=resourceFilter==="all"?"Showing all data areas":"Show all data areas";
	      byId("show-risks").textContent=resourceFilter==="risks"?"Show all resources":"Show only risks";
	      byId("show-exposed").textContent=resourceFilter==="exposed"?"Show all data areas":"Show visible data";
	      byId("show-unresolved").textContent=resourceFilter==="unresolved"?"Show all data areas":"Show blocked setup";
	      renderResources();
	    }
	    byId("show-all").onclick=()=>setResourceFilter(resourceFilter==="all"?"starter":"all");
	    byId("show-risks").onclick=()=>setResourceFilter("risks");
	    byId("show-exposed").onclick=()=>setResourceFilter("exposed");
	    byId("show-unresolved").onclick=()=>setResourceFilter("unresolved");
	    byId("resume-review").onclick=()=>setView(hasActiveAuthority()?"explore":"exceptions");
	    byId("try-active").onclick=()=>{
	      if(hasActiveAuthority())setView("explore");
	      else byId("project-action-message").textContent="No authority is active. Next: finish boundary review.";
	    };
	    byId("rescan-project").onclick=previewProjectRescan;
	    byId("start-over").onclick=previewStartOver;
    byId("instant-profile").onchange=updateInstantAction;
    byId("instant-tenant").oninput=updateInstantAction;
    byId("instant-principal").oninput=updateInstantAction;
    byId("run-instant").onclick=runInstantOnboarding;
    byId("deployment-profile").onchange=()=>{candidate.deployment_profile=byId("deployment-profile").value;globalDecisions().forEach(decision=>{if(decision.startsWith("deployment profile:"))confirmedDecisions.delete(decision)});invalidateDigest();queueReviewProgressSave();renderSignoff()};
    byId("actor").addEventListener("input",updateActivationState);
    byId("preview").onclick=previewBoundary;
    byId("activate").onclick=activateBoundary;
    byId("run-preflight").onclick=runPreflight;
    byId("aggregate-tab").onclick=()=>switchExploreMode("aggregate");
    byId("row-tab").onclick=()=>switchExploreMode("rows");
    byId("run-explore").onclick=runExplore;
    byId("ask-provider").onchange=()=>updateAskProviderFields(true);
    byId("ask-key-source").onchange=updateAskCredentialFields;
    byId("configure-ask").onclick=configureAsk;
    byId("change-ask-provider").onclick=showAskConfiguration;
    byId("run-ask").onclick=runAsk;
    byId("cancel-ask").onclick=cancelAsk;
    byId("clear-ask").onclick=clearAsk;
    byId("refresh-protect").onclick=loadProtect;
    byId("load-action").onclick=loadGuidedAction;
    byId("create-action").onclick=createGuidedAction;
    byId("action-quorum").onchange=updateGuidedCompatibility;
    updateAskProviderFields(false);
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
