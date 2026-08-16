import { WORKBENCH_SYNTAX_CSS, workbenchSyntaxScript } from "./workbench-syntax.js";
import { EXPLORATION_BUDGET_REVIEW_CEILINGS } from "./auto-boundary.js";

export function renderBoundaryWorkbench(csrfToken: string): string {
  const escapedCsrf = escapeScriptString(csrfToken);
  const reviewedBudgetCeilings = JSON.stringify(EXPLORATION_BUDGET_REVIEW_CEILINGS);
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
    .brand{display:flex;align-items:center;gap:11px;min-width:0}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:7px;background:var(--text);color:var(--surface);font-size:13px;font-weight:800}.brand-copy{min-width:0}.brand-copy p{font-size:12px;margin:0}.header-status{display:flex;align-items:center;gap:8px}.header-back{display:none}body.ask-focus-mode .header-back{display:inline-flex}
    h1{font-size:17px;margin:0}h2{font-size:20px;margin:0 0 7px}h3{font-size:15px;margin:0}
    p{margin:6px 0;color:var(--muted)}main{padding:24px 0 56px}
    button,input,select,textarea{font:inherit}
	    button{min-height:44px;padding:8px 13px;border:1px solid var(--accent);border-radius:6px;background:var(--accent);color:#fff;font-weight:700;cursor:pointer;transition:background .15s ease,border-color .15s ease,transform .15s ease}
    button:not(:disabled):hover{background:var(--accent-strong);border-color:var(--accent-strong)}button:not(:disabled):active{transform:translateY(1px)}
    button.secondary{background:transparent;color:var(--accent)}button.quiet{background:var(--surface-2);border-color:var(--line);color:var(--text)}button.secondary:not(:disabled):hover,button.quiet:not(:disabled):hover{color:#fff}
    button.danger{background:var(--bad);border-color:var(--bad)}button:disabled{opacity:.5;cursor:not-allowed}
    button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
	    input[type=text],input[type=search],input[type=number],input[type=datetime-local],select,textarea{width:100%;min-height:44px;padding:7px 9px;border:1px solid var(--line);border-radius:5px;background:var(--surface);color:var(--text)}
	    select{min-width:0;padding-right:34px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    input[type=checkbox],input[type=radio]{width:16px;height:16px;accent-color:var(--accent)}
    .field{display:flex;min-width:0;flex-direction:column;gap:5px;color:var(--muted)}
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
	    .boundary-overview{margin:24px 0 28px;padding:20px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);scroll-margin-top:88px}
	    .boundary-overview-head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:16px}.boundary-overview-head>div{min-width:0;width:min(100%,920px)}.boundary-overview-head h2{font-size:27px;color:var(--text)}.boundary-overview-head p{max-width:720px;color:#aebbb5}.database-compatibility-summary{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:12px 0 16px;color:var(--muted)}.database-compatibility-summary strong{color:var(--text)}
    .boundary-version-table-wrap{width:100%;max-width:920px;overflow:auto;margin:14px 0}.boundary-version-table{margin:0;min-width:700px}.boundary-version-table th:nth-child(1){width:26%}.boundary-version-table th:nth-child(2){width:20%}.boundary-version-table th:nth-child(3){width:10%}.boundary-version-table th:nth-child(4){width:18%}.boundary-version-table th:nth-child(5){width:26%}.boundary-version-table .next-boundary{background:var(--accent-soft)}.boundary-version-table code{color:var(--text)}
    .boundary-version-table .selected-boundary{background:var(--accent-soft)}.boundary-version-table td small{display:block;margin-top:3px;color:var(--muted)}.boundary-row-actions{margin:0;gap:6px}.boundary-row-actions button{min-height:34px;padding:5px 9px}
    .focused-boundary-table-wrap{max-width:none}.focused-boundary-table{min-width:1040px}.focused-boundary-table th:nth-child(1){width:23%}.focused-boundary-table th:nth-child(2){width:22%}.focused-boundary-table th:nth-child(3){width:17%}.focused-boundary-table th:nth-child(4){width:17%}.focused-boundary-table th:nth-child(5){width:21%}.focused-boundary-table td{vertical-align:top}.focused-boundary-table td>strong{display:inline-block;margin-right:4px}.focused-boundary-table td>small{display:block;margin-top:4px;color:var(--muted);line-height:1.4}
    .badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}.badge{display:inline-flex;padding:3px 7px;border-radius:999px;border:1px solid var(--line);font-size:12px;color:var(--muted);background:var(--surface-2)}
    .badge.bad{color:var(--bad);background:var(--bad-soft);border-color:var(--bad)}.badge.warn{color:var(--warn);background:var(--warn-soft);border-color:var(--warn)}.badge.good{color:var(--good);background:var(--good-soft);border-color:var(--good)}
    .risk-list{display:grid;gap:8px;margin-top:12px}.risk{border-left:3px solid var(--line);padding:9px 11px;background:var(--surface-2)}.risk.high{border-color:var(--bad)}.risk.unresolved{border-color:var(--warn)}.risk.available{border-color:var(--good)}
    .review-form{margin-top:10px;padding-top:10px;border-top:1px solid var(--line);scroll-margin-top:78px}
     .scope-grid,.form-grid,.preflight{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.form-grid-contents{display:contents}.preflight{grid-template-columns:repeat(3,minmax(0,1fr))}.preflight>div{min-width:0}.preflight p{overflow-wrap:anywhere}
    .check{display:flex;align-items:flex-start;gap:8px}.check input{flex:0 0 auto;margin-top:3px}
    details{border-top:1px solid var(--line);margin-top:14px;padding-top:10px}summary{cursor:pointer;color:var(--accent);font-weight:700}
    table{width:100%;table-layout:fixed;border-collapse:collapse;margin-top:10px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);overflow-wrap:anywhere}th{color:var(--muted);font-size:12px}
    .permission-table th:first-child{width:25%}.permission{display:flex;justify-content:center}
    .footer-actions{position:sticky;bottom:0;background:var(--surface);border:1px solid var(--line);padding:12px;margin-top:18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;z-index:2}
    .footer-actions .status-message{flex-basis:100%}
    .status-message{flex:1 1 260px;min-height:20px;color:var(--muted)}
    .status-message.blocked{padding:10px 12px;border-left:4px solid var(--warn);background:var(--warn-soft);color:var(--text)}
    .question-list{display:grid;gap:8px}.question{width:100%;text-align:left;background:var(--surface);color:var(--text);border-color:var(--line)}
    .question.selected{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
    .action-fields{display:grid;gap:10px;margin-top:10px}.action-field{border:1px solid var(--line);background:var(--surface-2);padding:12px;border-radius:6px}.action-field-settings{margin-top:10px}
    .result-meta{display:flex;gap:12px;flex-wrap:wrap;margin:10px 0}.result-table{overflow:auto}.resolved-time-table .utc-range{display:grid;gap:2px}.resolved-time-table .utc-range span{white-space:nowrap}
    .tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin-bottom:12px}.tab{background:transparent;color:var(--muted);border:0;border-bottom:3px solid transparent;border-radius:0}.tab.active{color:var(--accent);border-bottom-color:var(--accent)}
    .ask-surface{margin-top:22px;padding:0;background:var(--surface);border:1px solid var(--line);border-radius:7px;overflow:hidden}
    #view-explore.active{display:flex;flex-direction:column}#view-explore>h2{order:0}#view-explore>p{order:1}#explore-preflight{order:2}#ask-shell{order:3}#explorer{order:4}
    #ask-shell{border-left:4px solid var(--accent);box-shadow:var(--shadow);scroll-margin-top:82px}
    .ask-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:start;padding:18px;border-bottom:1px solid var(--line)}
    .ask-head p{max-width:720px}.ask-state{display:flex;align-items:center;justify-content:flex-end;gap:8px;text-align:right}.ask-state .badge{margin-left:5px}
    .ask-body{padding:18px}.ask-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .ask-disclosure{padding:12px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin:14px 0}
    .ask-egress-review{margin:18px 0;padding:16px;border:1px solid #355044;border-left:3px solid var(--accent);border-radius:7px;background:#0b1511;scroll-margin-top:96px}.ask-egress-review>strong{display:block;margin:3px 0 10px;font-size:16px}.ask-egress-review .check{padding:11px 12px;border:1px solid #304239;border-radius:6px;background:#101d17;color:#dce6e1;cursor:pointer}.ask-egress-review .check input{margin-top:4px}.ask-egress-review .check strong,.ask-egress-review .check small{display:block}.ask-egress-review .check small{margin-top:3px;color:#8f9d96;line-height:1.45}.ask-egress-review.needs-attention{border-color:var(--warn);background:var(--warn-soft);box-shadow:0 0 0 3px color-mix(in srgb,var(--warn) 18%,transparent)}.ask-egress-review.needs-attention .check{border-color:var(--warn)}
    .ask-transcript{display:flex;flex-direction:column;gap:16px;margin:14px 0}.ask-turn{max-width:72%;align-self:flex-end;padding:11px 15px;border:1px solid color-mix(in srgb,var(--accent) 28%,var(--line));border-radius:16px 16px 4px 16px;background:var(--accent-soft)}.ask-turn>strong{display:block;margin-bottom:2px;font-size:11px;font-weight:800;text-transform:uppercase;color:var(--muted)}.ask-turn>p{margin:0;color:var(--text)}.ask-turn.answer{align-self:stretch;max-width:none;padding:0;border:0;border-radius:0;background:transparent}.ask-turn.error{align-self:flex-start;border-radius:16px 16px 16px 4px;background:var(--bad-soft);border-color:var(--bad)}
    .ask-composer{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}.ask-composer textarea{min-height:96px;resize:vertical}.ask-composer-actions{display:grid;gap:8px;width:138px}
    .ask-tool-trace{margin-top:10px;border-top:1px solid var(--line);padding-top:10px}.ask-tool-trace summary{font-size:12px}
    .active-scope-line{display:flex;gap:9px;align-items:center;flex-wrap:wrap}.active-scope-line .scope-dot{width:8px;height:8px;border-radius:50%;background:var(--good)}.active-scope-line span:last-child{color:var(--muted)}.ask-verified-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.ask-verified-head h3{margin:0}.runner-verified{color:var(--good);border-color:var(--good);background:var(--good-soft);text-transform:uppercase;font-weight:800}.ask-refused{margin-top:16px;padding:18px;border:1px solid var(--warn);border-left:3px solid var(--warn);border-radius:8px;background:var(--warn-soft)}.ask-refused h3{margin-bottom:6px}.ask-recovery{color:var(--muted)}.ask-access-guidance{margin-top:16px;padding-top:16px;border-top:1px solid var(--line)}.ask-access-guidance h3{margin:4px 0 6px}.ask-access-guidance p{max-width:720px}
    .no-model-surface{margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}.no-model-content{margin-top:12px}
    .instant-path{scroll-margin-top:76px}.instant-reveal{display:grid;grid-template-columns:minmax(310px,.8fr) minmax(520px,1.2fr);gap:54px;align-items:center;min-height:calc(100vh - 160px)}.instant-copy{display:grid;gap:20px;align-content:center}.instant-kicker{margin:0;color:#71e2b7;font-size:11px;font-weight:850;text-transform:uppercase}.instant-copy h2{max-width:610px;margin:0;color:#f4f8f6;font-size:46px;line-height:1.2}.instant-copy h2 span{display:block;color:#718078}.instant-copy>p{max-width:520px;margin:0;color:#aab6b0;font-size:17px;line-height:1.65}.instant-actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.instant-actions button{min-height:52px;padding:12px 20px}.instant-actions .secondary{border-color:#314038;color:#d9e2dd}.instant-trust{display:block;color:#718078;font-size:11px;text-transform:uppercase}.instant-path .status-message{flex:1 0 100%;color:#aab6b0}.instant-boundary{min-width:0;padding:24px;border:1px solid #2a3e34;border-radius:8px;background:#101a16;color:#eef5f1}.instant-boundary-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.instant-boundary-head h3{margin:5px 0 1px;font-size:26px}.instant-boundary-head code{color:#75847c}.instant-badge{display:inline-flex;align-items:center;padding:5px 9px;border:1px solid #60412f;border-radius:999px;background:#211813;color:#f3b276;font-size:11px;font-weight:800;text-transform:uppercase}.instant-flow{display:grid;grid-template-columns:minmax(82px,1fr) minmax(124px,1.2fr) minmax(82px,1fr);gap:18px;align-items:center;min-height:190px;margin:18px 0;padding:18px 0;border-bottom:1px solid #23322b}.instant-node{position:relative;display:grid;place-items:center;min-height:84px;padding:10px;border:1px solid #33433b;border-radius:8px;text-align:center;color:#dfe9e4}.instant-node strong{display:block;font-size:18px}.instant-node span{color:#728078;font-size:10px;text-transform:uppercase}.instant-node.boundary{border-color:#5cd7a5;background:#142a21}.instant-node.boundary::before,.instant-node.boundary::after{content:"";position:absolute;top:calc(50% - 1px);width:20px;height:3px;background-image:repeating-linear-gradient(90deg,#78e6bb 0 8px,transparent 8px 16px),linear-gradient(#33433b,#33433b);background-position:0 0,center;background-repeat:repeat-x,no-repeat;background-size:32px 3px,100% 1px;animation:instant-edge-flow 1.9s linear infinite}.instant-node.boundary::before{right:100%}.instant-node.boundary::after{left:100%}@keyframes instant-edge-flow{to{background-position:32px 0,center}}.instant-blocked{position:absolute;top:calc(100% + 12px);left:50%;width:max-content;max-width:180px;transform:translateX(-50%);padding:3px 8px;border:1px solid #344039;border-radius:999px;background:#0c1411;color:#77847d;font-size:10px}.instant-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px 28px}.instant-fact strong{display:block;margin-bottom:5px;color:#748279;font-size:10px;text-transform:uppercase}.instant-fact p{margin:0;color:#dce5e0}.instant-preview{display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;align-items:start;margin-top:22px;padding:17px;border:1px solid #2a3b32;border-radius:8px;background:#0b1310}.instant-preview-icon{display:grid;place-items:center;width:34px;height:34px;border-radius:7px;background:#173127;color:#77e7ba;font-weight:800}.instant-preview strong{display:block;color:#748279;font-size:10px;text-transform:uppercase}.instant-preview p{margin:5px 0 0;color:#eef5f1;font-size:16px}.instant-preview small{display:block;margin-top:6px;color:#718078}.instant-result{margin-top:12px}
    @media(prefers-reduced-motion:reduce){.instant-node.boundary::before,.instant-node.boundary::after{animation:none}}
    body.quick-start-mode,body.ask-focus-mode{--bg:#07100c;--surface:#101a16;--surface-2:#14211b;--text:#f2f7f4;--muted:#9aa8a1;--line:#27372f;--line-strong:#3b5045;--accent:#75e3b7;--accent-strong:#8aebc5;--accent-soft:#142d23;--good:#75e3b7;--good-soft:#142d23;background:#07100c}
    body.quick-start-mode header,body.ask-focus-mode header{background:#07100c;border-color:#1d2a24;backdrop-filter:none}
    body.quick-start-mode header>div,body.quick-start-mode main,body.ask-focus-mode header>div,body.ask-focus-mode main{width:min(1380px,calc(100% - 64px))}
    body.quick-start-mode .brand-mark,body.ask-focus-mode .brand-mark{background:#75e3b7;color:#07100c}
    body.quick-start-mode .header-status,body.ask-focus-mode .header-status{padding:7px 12px;border:1px solid #27372f;border-radius:999px;background:#0d1713}
    body.quick-start-mode button,body.ask-focus-mode button{background:#75e3b7;border-color:#75e3b7;color:#07100c}
    body.quick-start-mode button.secondary,body.quick-start-mode button.quiet,body.ask-focus-mode button.secondary,body.ask-focus-mode button.quiet{background:transparent;border-color:#34443c;color:#dce6e1}
    body.quick-start-mode .workbench-layout{grid-template-columns:minmax(0,1fr);justify-content:center}
    body.quick-start-mode .workflow-rail{display:none}
    body.quick-start-mode #view-overview>*{display:none!important}
    body.quick-start-mode #view-overview>#instant-path{display:block!important;margin:0}
    body.ask-focus-mode .workbench-layout{grid-template-columns:minmax(0,1120px);justify-content:center}
    body.ask-focus-mode .workflow-rail{display:none}
    body.ask-focus-mode #view-explore>h2,body.ask-focus-mode #view-explore>p{display:none}
    body.ask-focus-mode #explore-preflight{margin:0 0 14px;padding:10px 14px;border:1px solid var(--line);border-left:3px solid var(--good)}
    body.ask-focus-mode #explore-preflight.success{display:none}
    body.ask-focus-mode #explore-preflight h3{display:inline;margin-right:8px}body.ask-focus-mode #explore-preflight>p{display:inline}
    body.ask-focus-mode #ask-shell{margin-top:0;border:0;border-radius:0;background:transparent;box-shadow:none}
    body.ask-focus-mode .ask-head{display:flex;flex-direction:column;align-items:center;padding:36px 18px 22px;border:0;text-align:center}
    body.ask-focus-mode .ask-head h3{font-size:30px}body.ask-focus-mode .ask-head p{max-width:720px}
    body.ask-focus-mode .ask-state{position:static;margin-top:8px}
    body.ask-focus-mode .ask-body{padding:0 18px 40px}
    body.ask-focus-mode #ask-authority-summary{margin:0 auto 18px;max-width:880px}
    body.ask-focus-mode #ask-configuration,body.ask-focus-mode #ask-chat{max-width:880px;margin:auto}
    body.ask-focus-mode #ask-configuration-form{padding:22px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
    body.ask-focus-mode .ask-transcript{gap:18px}
    body.ask-focus-mode .ask-turn{padding:0;border:0;background:transparent}
    body.ask-focus-mode .ask-turn>strong{display:block;margin-bottom:7px;color:var(--muted);font-size:11px;text-transform:uppercase}
    body.ask-focus-mode .ask-turn.answer{padding-top:8px}
    body.ask-focus-mode .ask-verified{margin-top:18px}
    body.ask-focus-mode .ask-composer{margin-top:18px;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
    body.ask-focus-mode .ask-composer textarea{min-height:72px;border:0;background:transparent}
    body.ask-focus-mode .ask-composer textarea:focus-visible{outline:0}
    body.ask-focus-mode #explorer{max-width:880px;margin:22px auto 0;width:100%}
	    body.ask-focus-mode #external-client-setup:not([open]),body.ask-focus-mode .no-model-surface{display:none}
	    body.ask-focus-mode.no-model-focus .no-model-surface{display:block}
	    body.access-focus-mode{--bg:#07100c;--surface:#101a16;--surface-2:#14211b;--text:#f2f7f4;--muted:#9aa8a1;--line:#27372f;--line-strong:#3b5045;--accent:#75e3b7;--accent-strong:#8aebc5;--accent-soft:#142d23;--good:#75e3b7;--good-soft:#142d23;background:#07100c}
	    body.access-focus-mode header{background:#07100c;border-color:#1d2a24;backdrop-filter:none}
	    body.access-focus-mode header>div,body.access-focus-mode main{width:min(1380px,calc(100% - 64px))}
	    body.access-focus-mode .brand-mark{background:#75e3b7;color:#07100c}
	    body.access-focus-mode .header-status{padding:7px 12px;border:1px solid #27372f;border-radius:999px;background:#0d1713}
	    body.access-focus-mode .workbench-layout{grid-template-columns:minmax(0,1fr)}
	    body.access-focus-mode .workflow-rail{display:none}
	    body.access-focus-mode .workspace{max-width:none}
	    body.access-focus-mode button{background:#75e3b7;border-color:#75e3b7;color:#07100c}
	    body.access-focus-mode button.secondary,body.access-focus-mode button.quiet{background:transparent;border-color:#34443c;color:#dce6e1}
	    .access-editor-head{display:flex;justify-content:flex-start;gap:18px;align-items:flex-start;margin-bottom:22px}#access-back{flex:0 0 auto}.access-editor-head>div{max-width:720px}.access-editor-head h2{font-size:30px}
	    .access-editor{display:grid;grid-template-columns:minmax(240px,300px) minmax(0,1fr);gap:18px;align-items:start}
	    .access-nav{position:sticky;top:88px;padding:14px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
	    .access-nav label{display:grid;gap:6px;color:var(--muted);font-size:12px;font-weight:700}
	    .access-catalog-mode{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:10px;padding:4px;border:1px solid var(--line);border-radius:7px;background:var(--bg)}
	    .access-catalog-mode button{min-height:34px;padding:6px 8px;border:0;background:transparent!important;color:var(--muted)!important;font-size:11px}.access-catalog-mode button.active{background:var(--surface-2)!important;color:var(--text)!important;box-shadow:inset 0 0 0 1px var(--line-strong)}
	    .access-catalog-note{display:block;margin-top:8px;color:var(--muted);font-size:11px;line-height:1.4}
	    .access-resource-list{display:grid;gap:4px;margin-top:12px;max-height:calc(100vh - 210px);overflow:auto}
	    .access-resource{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center;width:100%;min-height:54px;padding:9px 10px;border:1px solid transparent;border-radius:6px;background:transparent!important;color:var(--text)!important;text-align:left}
	    .access-resource:not(:disabled):hover{border-color:var(--line);background:var(--surface-2)!important;transform:none}.access-resource.selected{border-color:var(--line);border-left:3px solid var(--accent);background:var(--accent-soft)!important}.access-resource strong,.access-resource small{display:block;overflow:hidden;text-overflow:ellipsis}.access-resource small{color:var(--muted);font-weight:500}
	    .access-resource-state{color:var(--muted);font-size:11px;white-space:nowrap}.access-resource-state.blocked{color:var(--bad)}.access-resource-state.pending{color:var(--warn)}.access-resource-state.ready{color:var(--good)}
	    .boundary-name-editor{display:flex;align-items:end;gap:8px;flex-wrap:wrap;margin-top:12px}.boundary-name-editor label{min-width:min(320px,100%);font-size:12px;color:var(--muted)}.boundary-name-editor input{margin-top:5px}.boundary-name-editor .status-message{margin:0;min-height:20px}
	    .access-focus{min-width:0}.access-focus>#resource-detail,.access-focus>#global-decisions{margin:0 0 14px;padding:20px;border:1px solid var(--line);border-radius:8px;background:var(--surface)}
	    .access-focus>#resource-detail>p:first-child{margin-top:0}.access-focus .resource-detail-placeholder{min-height:280px;display:grid;place-items:center;text-align:center}
	    .access-column-list{display:grid;gap:0;margin:18px 0;border:1px solid var(--line);border-radius:8px;overflow:hidden}
	    .access-column{display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,280px);gap:12px;align-items:center;min-height:72px;padding:12px;border-bottom:1px solid var(--line);background:var(--surface)}
	    .access-column:last-child{border-bottom:0}.access-column:hover{background:var(--surface-2)}.access-column.highlighted{outline:2px solid var(--accent);outline-offset:-2px;background:var(--accent-soft)}
	    .access-column-copy{min-width:0}.access-column-copy strong,.access-column-copy small{display:block;overflow-wrap:anywhere}.access-column-copy small{color:var(--muted)}.access-column-risk{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:5px}
	    .access-column-tier{display:grid;gap:4px;color:var(--muted);font-size:11px;font-weight:700}.access-column-tier select{min-height:38px}.access-column-consequence{font-weight:500;line-height:1.35}.access-column .review-form{grid-column:1/-1;margin:2px 0 4px}
	    .enum-review{grid-column:1/-1;margin:2px 0 4px;padding:10px 12px;border:1px solid var(--line);border-radius:7px;background:var(--bg)}.enum-review>summary{cursor:pointer;font-weight:700}.enum-review-values{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:7px;margin:10px 0}.enum-review-values .check{margin:0;padding:7px 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface)}
	    .access-secondary{margin-top:10px}.access-secondary>summary{font-weight:700}.access-secondary[open]{padding-bottom:6px}
	    .access-final{position:sticky;bottom:12px;display:flex;align-items:center;justify-content:space-between;gap:16px;margin:18px 0 0 auto;max-width:calc(100% - 318px);padding:12px 14px;border:1px solid var(--accent);border-radius:8px;background:color-mix(in srgb,var(--surface) 96%,transparent);box-shadow:0 10px 32px rgba(0,0,0,.18);backdrop-filter:blur(10px);z-index:2}.access-final p{min-width:0;margin:0;overflow-wrap:anywhere}.access-final strong{color:var(--text);overflow-wrap:anywhere}
	    .hidden{display:none!important}.screen-reader{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
	    @media(max-width:960px){.workbench-layout{grid-template-columns:1fr;gap:18px}.workflow-rail{position:static}.rail-label,.rail-note{display:none}.steps{display:flex;overflow-x:auto;border-bottom:1px solid var(--line);padding-bottom:1px}.step{flex:0 0 auto;min-width:150px;border-left:0;border-bottom:3px solid transparent;border-radius:6px 6px 0 0}.step.active{border-left:0;border-bottom-color:var(--accent)}}
	    @media(max-width:820px){header>div,main,body.quick-start-mode header>div,body.quick-start-mode main,body.ask-focus-mode header>div,body.ask-focus-mode main,body.access-focus-mode header>div,body.access-focus-mode main{width:calc(100% - 24px)}.summary{grid-template-columns:1fr 1fr}.metric:nth-child(2){border-right:0}.resource-list,.scope-grid,.form-grid,.preflight,.journey,.ask-grid,.instant-reveal,.access-editor,.access-column,.boundary-version-list{grid-template-columns:1fr}.boundary-overview-head{flex-direction:column}.access-editor-head{align-items:flex-start;flex-direction:column}.access-nav{position:static}.access-resource-list{max-height:270px}.access-final{position:static;max-width:none;flex-direction:column;align-items:stretch}.instant-reveal{gap:28px;min-height:auto;padding:28px 0 44px}.instant-copy{display:contents}.instant-copy .instant-kicker{order:1}.instant-copy h2{order:2;font-size:36px}.instant-copy>p{order:3}.instant-boundary{order:4;padding:18px}.instant-actions{order:5}.instant-trust{order:6}.instant-flow{min-height:160px}.footer-actions{position:static}.ask-head{grid-template-columns:1fr}.ask-state{text-align:left}.ask-state .badge{margin:0 5px 0 0}body.ask-focus-mode .ask-state{position:static}}
    @media(max-width:560px){.ask-composer{grid-template-columns:1fr}.ask-composer-actions{display:flex;flex-wrap:wrap;width:auto}.ask-composer-actions button{flex:1 1 120px}}
    @media(max-width:480px){header>div,main,body.quick-start-mode header>div,body.quick-start-mode main,body.ask-focus-mode header>div,body.ask-focus-mode main{width:calc(100% - 20px)}.brand-copy p{display:none}.header-status .badge{display:none}.summary{grid-template-columns:1fr}.metric{border-right:0;border-bottom:1px solid var(--line)}.toolbar>*,.actions>button{width:100%}.step{min-width:132px}.ask-head,.ask-body{padding:14px}.instant-copy{gap:16px}.instant-copy h2{font-size:32px}.instant-copy>p{font-size:15px}.instant-actions{display:grid}.instant-actions button{width:100%}.instant-facts{grid-template-columns:1fr}.instant-flow{grid-template-columns:72px minmax(108px,1fr) 72px;gap:12px}.instant-node.boundary::before,.instant-node.boundary::after{width:14px}.instant-boundary-head h3{font-size:21px}.instant-preview{padding:13px}.instant-trust{margin-top:4px}}

    /* The visual reference changes presentation only. Existing controls and authority remain intact. */
    :root{color-scheme:dark;--bg:#07100c;--surface:#0f1915;--surface-2:#131f1a;--text:#f1f6f3;--muted:#8d9a94;--line:#26372f;--line-strong:#40544a;--accent:#75e3b7;--accent-strong:#8becC6;--accent-soft:#142d23;--warn:#f0aa68;--warn-soft:#2a1d15;--bad:#ff958b;--bad-soft:#321d1b;--good:#75e3b7;--good-soft:#142d23;--shadow:0 18px 56px rgba(0,0,0,.22)}
    body{background:#07100c;color:var(--text);font:15px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    header{background:#07100c;border-color:#1d2b24;backdrop-filter:none}
    header>div{min-height:70px;width:min(1360px,calc(100% - 64px))}
    main{width:min(1360px,calc(100% - 64px));padding:34px 0 64px}
    .brand{gap:12px}.brand-mark{width:30px;height:30px;border-radius:8px;background:#75e3b7;color:#07100c}.brand-copy{display:flex;align-items:baseline;gap:6px}.brand-copy h1{font-size:16px}.brand-copy p{color:#77837d;font-size:16px}
    .header-status{gap:10px;padding:7px 13px;border:1px solid #26372f;border-radius:999px;background:#0b1511}.header-status::before{content:"";width:7px;height:7px;border-radius:50%;background:#75e3b7}.header-status .badge{padding:0;border:0;background:transparent}.header-status .state{font-size:12px}
    h1,h2,h3{overflow-wrap:anywhere}h2{font-size:24px;line-height:1.3}h3{font-size:17px}p{color:var(--muted)}
    button{border-radius:7px;background:#75e3b7;border-color:#75e3b7;color:#07100c}button:not(:disabled):hover{background:#8becc6;border-color:#8becc6}.button.secondary,button.secondary,button.quiet{background:transparent;border-color:#35483e;color:#dce6e1}button.secondary:not(:disabled):hover,button.quiet:not(:disabled):hover{background:#16231d;border-color:#53695e;color:#fff}
    input[type=text],input[type=search],input[type=number],input[type=datetime-local],select,textarea{background:#0b1511;border-color:#304239;color:#eef5f1}
    .band,.resource,.access-nav,.access-focus>#resource-detail,.access-focus>#global-decisions,.footer-actions{background:#0f1915;border-color:#26372f;box-shadow:none}
    .badge{background:#111d18;border-color:#304239}.badge.good{background:#10271d;border-color:#2f775b}.notice{background:#201b11}.success{background:#10271d}.error{background:#2b1917}
    .workbench-layout{display:block}.workspace{max-width:1240px;margin:0 auto}.split-actions>*{min-width:0}
    .workflow-rail{position:static;margin:0 auto 38px;max-width:1240px}.workflow-rail>.rail-label,.workflow-rail>.rail-note{display:none}.steps{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0;border-bottom:1px solid #26372f}.step{min-width:0;padding:13px 12px;border:0;border-bottom:2px solid transparent;border-radius:0;background:transparent;color:#7d8983;text-align:center}.step.active{border:0;border-bottom:2px solid #75e3b7;background:transparent;color:#75e3b7}.step.done{color:#aebbb5}
    .summary{border-color:#26372f;background:#0f1915}.metric{border-color:#26372f}
    .instant-kicker{color:#75e3b7;font-size:11px;font-weight:800;text-transform:uppercase}
    #view-overview>h2{margin:0 0 20px;font-size:40px;line-height:1.18}
    #view-overview>h2::before{content:"Review data access";display:block;margin-bottom:10px;color:#75e3b7;font-size:11px;font-weight:800;text-transform:uppercase}
    #view-overview>h2+.band{max-width:940px;margin:0 0 26px;padding:0;border:0;background:transparent}
    #view-overview>h2+.band strong{display:block;margin-bottom:7px;color:#eef5f1;font-size:20px}
    #view-overview>h2+.band p{margin:0;font-size:16px}
    #overview-notice{margin:0 0 14px;padding:13px 16px;border:1px solid #315844;border-left:3px solid #75e3b7;background:#0e2118}
    #journey-state{margin:0 0 26px;padding:16px 18px;border-color:#315844;background:#0f2119}
    #database-summary{margin:0;padding:22px 0;border:0;border-top:1px solid #26372f;border-bottom:1px solid #26372f;background:transparent}
    #database-summary h3{font-size:22px}
    #summary{margin-top:0;border:0;border-bottom:1px solid #26372f;background:transparent}
    #summary .metric{padding:20px 16px}
    #view-overview>.split-actions{margin-top:34px!important;align-items:end}
    #view-overview>.split-actions h2{font-size:28px}
    #view-overview .resource-list{gap:12px}
    #view-overview .resource{border-radius:7px;background:#0f1915}
    #view-overview>details.band{margin-top:36px;background:#0b1511}

    body.quick-start-mode .workspace{max-width:1280px;width:100%}
    body.quick-start-mode main{padding-top:46px}
    .instant-reveal{align-items:start;grid-template-columns:minmax(440px,.84fr) minmax(650px,1.16fr);gap:58px;min-height:0}
    .instant-copy{gap:24px;padding-top:30px}.instant-copy h2{max-width:540px;font-size:48px;line-height:1.18}.instant-copy h2 span{margin-top:3px;color:#74817a}.instant-copy>p{max-width:510px;color:#a5b1ab;font-size:17px}.instant-actions{margin-top:8px}.instant-actions button{min-height:54px;padding:13px 22px}.instant-trust{color:#6f7b75;font-size:11px}
    .instant-boundary{padding:28px 30px;border-color:#2a3d34;background:#0f1915}.instant-boundary-head h3{font-size:28px}.instant-boundary-head code{color:#74817a}.instant-badge{background:#211812;border-color:#5a3a28;color:#f0aa68}
    .instant-flow{display:block;min-height:214px;margin:18px 0 12px;padding:0 0 10px;border-bottom:1px solid #26372f}
    .instant-flow svg{display:block;width:100%;height:auto;overflow:visible}.instant-flow-base{fill:none;stroke:#2d3d35;stroke-width:2}.instant-flow-active{fill:none;stroke:#75e3b7;stroke-width:3;stroke-dasharray:8 8;stroke-linecap:round;animation:instant-edge-flow 1.9s linear infinite}.instant-flow-node{fill:#0b1511;stroke:#33483d;stroke-width:2}.instant-flow-core{fill:#132b21;stroke:#75e3b7;stroke-width:2}.instant-flow-muted{fill:#0b1511;stroke:#33433b;stroke-width:1.5}.instant-flow text{fill:#eef5f1;font-family:inherit}.instant-flow .instant-svg-muted{fill:#75827b}.instant-flow .instant-svg-accent{fill:#75e3b7}
    @keyframes instant-edge-flow{to{stroke-dashoffset:-32}}
    .instant-facts{gap:20px 34px}.instant-fact strong{color:#77857e}.instant-fact p{font-size:15px}.instant-preview{margin-top:24px;padding:19px 20px;background:#0a120f}.instant-preview-icon{background:#153026}.instant-preview p{font-size:17px}

    body.ask-focus-mode .workspace{max-width:1080px;width:100%}
    body.ask-focus-mode main{padding-top:44px}
    body.ask-focus-mode .ask-head{padding:42px 0 38px}
    body.ask-focus-mode .ask-head h3{font-size:42px;line-height:1.2}
    body.ask-focus-mode .ask-head p{font-size:17px}
    body.ask-focus-mode .ask-state{margin-top:14px}
    body.ask-focus-mode .ask-body{padding:0 0 56px}
    body.ask-focus-mode #ask-authority-summary{max-width:890px;margin:0 auto 24px;padding:9px 14px;border:1px solid #2e634d;border-radius:999px;background:#0f251b}
    body.ask-focus-mode #ask-authority-summary p,body.ask-focus-mode #ask-authority-summary details{display:none}
    body.ask-focus-mode #ask-configuration,body.ask-focus-mode #ask-chat{max-width:890px}
    body.ask-focus-mode #ask-configuration-form{padding:32px 34px;border-color:#304239;background:#0f1915}
    body.ask-focus-mode #ask-configured-summary{margin-bottom:18px;padding:11px 14px;border:1px solid #26372f;border-radius:7px;background:#0c1511}
    body.ask-focus-mode #ask-chat{display:flex;flex-direction:column;padding-bottom:16px}
    body.ask-focus-mode #ask-chat.hidden{display:none}
    body.ask-focus-mode #ask-boundary-guide{order:0;margin:0 0 18px;padding:0;border:1px solid #304239;border-radius:8px;background:#0f1915}
    body.ask-focus-mode #ask-boundary-guide>summary{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 18px;color:#eef5f1;list-style:none}
    body.ask-focus-mode #ask-boundary-guide>summary::-webkit-details-marker{display:none}
    body.ask-focus-mode #ask-boundary-guide>summary::after{content:"View";color:#75e3b7;font-size:12px;font-weight:800;text-transform:uppercase}
    body.ask-focus-mode #ask-boundary-guide[open]>summary::after{content:"Hide"}
    .ask-boundary-summary{display:flex;align-items:baseline;gap:10px;min-width:0}.ask-boundary-summary small{color:#839189;font-weight:500}
    .ask-boundary-body{padding:0 18px 18px;border-top:1px solid #26372f}.ask-boundary-intro{margin:13px 0 16px}
    .ask-boundary-actions{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:16px;padding-top:14px;border-top:1px solid #26372f}.ask-boundary-actions p{margin:0;max-width:620px;font-size:12px}.ask-boundary-actions button{flex:0 0 auto}
    .ask-boundary-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
    .ask-boundary-resource{min-width:0;padding:15px;border:1px solid #26372f;border-radius:7px;background:#0b1511}
    .ask-boundary-resource h4{margin:0 0 10px;font-size:15px}.ask-boundary-row{display:grid;grid-template-columns:82px minmax(0,1fr);gap:10px;padding:7px 0;border-top:1px solid #1f2d26}
    .ask-boundary-row strong{color:#78867e;font-size:10px;text-transform:uppercase}.ask-boundary-row span{color:#cbd6d0;font-size:13px;overflow-wrap:anywhere}
    .ask-boundary-pagination{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px}.ask-boundary-pagination-status{color:#839189;font-size:12px}.ask-boundary-pagination-actions{display:flex;gap:7px}.ask-boundary-pagination-actions button{min-width:96px;min-height:36px;padding:6px 10px}
    .ask-boundary-examples{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.ask-boundary-examples .question{width:auto;min-height:38px;padding:8px 11px;font-size:13px}
	    .boundary-catalog-map{margin-top:16px;padding-top:14px;border-top:1px solid #26372f}.boundary-catalog-map>summary{color:#dce6e1;font-weight:750;cursor:pointer}.boundary-catalog-summary{margin:8px 0 14px;color:#839189;font-size:12px}.boundary-catalog-controls{display:grid;grid-template-columns:minmax(220px,360px) auto;gap:10px;align-items:end;margin:12px 0}.boundary-catalog-controls .actions{margin:0}.boundary-catalog-boundary{margin-top:14px}.boundary-catalog-boundary h4{margin:0 0 10px}.boundary-catalog-graph{width:100%;overflow:auto;border:1px solid #26372f;border-radius:6px;background:#08100c}.boundary-catalog-graph svg{display:block;min-width:100%;height:auto}.boundary-catalog-graph .node{fill:#0d1813;stroke:#75e3b7;stroke-width:1.5}.boundary-catalog-graph .node-title{fill:#eef5f1;font-size:13px;font-weight:750}.boundary-catalog-graph .node-field{fill:#91a198;font:11px ui-monospace,SFMono-Regular,Consolas,monospace}.boundary-catalog-graph .edge{fill:none;stroke:#75e3b7;stroke-width:2}.boundary-catalog-graph .edge.unproven{stroke:#f0aa68;stroke-dasharray:6 5}.boundary-catalog-graph .edge-label{fill:#9aaba2;stroke:#08100c;stroke-width:5px;stroke-linejoin:round;paint-order:stroke;font:10px ui-monospace,SFMono-Regular,Consolas,monospace}.boundary-catalog-nodes{display:grid;grid-template-columns:1fr;gap:9px}.boundary-catalog-node{min-width:0;padding:12px;border:1px solid #2b3c34;border-radius:6px;background:#0a120f}.boundary-catalog-node strong,.boundary-catalog-node small{display:block}.boundary-catalog-node>strong,.boundary-catalog-node small{overflow-wrap:anywhere}.boundary-catalog-node small{margin-top:5px;color:#839189}.boundary-catalog-edges{display:grid;gap:7px;margin-top:10px}.boundary-catalog-edge{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:9px;padding:10px 12px;border-left:2px solid #75e3b7;background:#0b1511}.boundary-catalog-edge.unproven{border-left-color:#f0aa68}.boundary-catalog-edge code{overflow-wrap:anywhere}.boundary-catalog-edge span{text-align:center;color:#839189;font-size:11px}.boundary-catalog-mermaid{margin-top:12px}.boundary-catalog-mermaid pre{max-height:320px;margin:10px 0 0;padding:13px;overflow:auto;border:1px solid #26372f;border-radius:6px;background:#08100c;color:#bcd5c8;font-size:12px;white-space:pre}
	    .boundary-catalog-path{border-left:2px solid #75e3b7;background:#0b1511}.boundary-catalog-path.unproven{border-left-color:#f0aa68}.boundary-catalog-path .boundary-catalog-edge{border-left:0;background:transparent}.boundary-catalog-question{margin:0;padding:0 12px 11px;color:#cbd6d0;font-size:12px}.boundary-catalog-question strong{color:#75e3b7}.boundary-catalog-questions{margin:12px 0;padding:12px 14px;border-left:2px solid #75e3b7;background:#0b1511}.boundary-catalog-questions strong{color:#75e3b7}.boundary-catalog-questions ul{margin:8px 0 0;padding-left:20px}.boundary-catalog-questions li+li{margin-top:5px}.boundary-catalog-capabilities{color:#aab8b1!important}.boundary-catalog-legend{margin:10px 0 12px;color:#839189;font-size:12px}.boundary-field-matrix-wrap{max-width:100%;margin-top:10px;overflow-x:auto}.boundary-field-matrix{width:100%;min-width:0;table-layout:fixed;border-collapse:collapse;font-size:11px}.boundary-field-matrix th,.boundary-field-matrix td{padding:7px 9px;border:1px solid #26372f;text-align:left;vertical-align:top;overflow-wrap:anywhere}.boundary-field-matrix th:first-child{width:38%;text-align:left}.boundary-field-matrix thead th{color:#aab8b1;font-size:10px}.boundary-field-matrix tbody th{font-weight:500;white-space:normal;overflow-wrap:anywhere}.boundary-field-matrix tbody th small{margin:2px 0 0;color:#839189}.boundary-operation-list{display:flex;flex-wrap:wrap;gap:4px 12px;margin:0;padding:0;list-style:none}.boundary-operation-list li{color:#cbd6d0;white-space:normal;overflow-wrap:anywhere}.boundary-operation-list li::before{content:'Y ';color:#75e3b7;font-weight:700}.boundary-operation-list .unavailable::before{content:''}.boundary-operation-list .unavailable{color:#839189}.boundary-field-exact{margin:8px 0 0;padding-top:8px}.boundary-field-exact ul{display:grid;gap:4px;margin:8px 0 0;padding-left:20px;color:#839189}.boundary-field-exact li code{margin-right:8px;color:#aab8b1}.boundary-catalog-restrictions{margin-top:9px!important;color:#e7bd75!important}.boundary-relationship-summary{display:grid;grid-template-columns:62px minmax(0,1fr);gap:5px 12px;padding:11px 13px}.boundary-relationship-summary>strong{grid-row:1/5;color:#75e3b7}.boundary-relationship-summary>code{overflow-wrap:anywhere}.boundary-relationship-summary>small,.boundary-relationship-summary>span{color:#839189}.boundary-relationship-summary>details summary{cursor:pointer;color:#839189}.boundary-relationship-summary>details code{display:block;margin-top:5px;overflow-wrap:anywhere;color:#aab8b1}
	    .boundary-proof-report{margin:0 0 18px;padding:18px;border:1px solid var(--line);border-left:3px solid var(--good);border-radius:8px;background:var(--good-soft)}.boundary-proof-report.failed{border-left-color:var(--bad);background:var(--bad-soft)}.boundary-proof-head{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.boundary-proof-head h3{margin:3px 0}.boundary-proof-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:14px 0}.boundary-proof-item{padding:10px 12px;border:1px solid var(--line);border-radius:6px;background:var(--surface)}.boundary-proof-item strong,.boundary-proof-item small{display:block}.boundary-proof-item small{margin-top:3px;color:var(--muted)}
	    .ask-proof-actions{order:1;display:flex;justify-content:flex-end;gap:8px;margin:-6px 0 14px}#boundary-proof-result{order:1}
	    .ask-history{order:1;margin:0 0 14px;border:1px solid #304239;border-radius:8px;background:#0f1915}.ask-history>summary{padding:12px 16px;cursor:pointer;font-weight:750}.ask-history-body{padding:0 16px 16px}.ask-history-table-wrap{overflow-x:auto}.ask-history table{width:100%;min-width:680px}.ask-history td{vertical-align:top}.ask-history td code{color:#75e3b7;overflow-wrap:anywhere}.ask-history .history-status-latest{color:var(--good);font-weight:750}.ask-history .history-status-refused{color:var(--warn)}.history-durable-table th:nth-child(3),.history-durable-table td:nth-child(3){min-width:220px}.history-durable-table th:nth-child(6),.history-durable-table td:nth-child(6){min-width:230px}
    body.ask-focus-mode #ask-chat>.ask-disclosure{order:4;margin-top:26px;color:#77857e}
    body.ask-focus-mode #ask-starters{order:3;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:38px}
    body.ask-focus-mode #ask-starters>strong,body.ask-focus-mode #ask-starters>p{grid-column:1/-1}
    body.ask-focus-mode #ask-starters .question{min-height:60px;padding:14px 18px;background:#0f1915;color:#cbd6d0}
    body.ask-focus-mode #ask-transcript{order:1;margin:0 0 24px}
    body.ask-focus-mode .ask-composer{position:sticky;bottom:12px;z-index:4;order:2;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;padding:30px 34px;border-color:#304239;background:#0f1915;box-shadow:0 18px 50px rgba(0,0,0,.36)}
    body.ask-focus-mode .ask-composer label.field{color:#76837c;font-size:11px;font-weight:800;text-transform:uppercase}
    body.ask-focus-mode .ask-composer textarea{min-height:112px;padding:14px 0;border:0;border-bottom:1px solid #2c3c34;border-radius:0;background:transparent;color:#f0f5f2;font-size:22px;line-height:1.45}
    body.ask-focus-mode .ask-composer-actions{align-self:end;display:flex;width:auto}.ask-composer-actions button{min-width:92px}
    body.ask-focus-mode #ask-run-status{order:5}
    body.ask-focus-mode .ask-turn{padding:0;background:transparent}.ask-turn>strong{color:#75827b}
    body.ask-focus-mode .ask-transcript>.ask-turn:not(.answer)>p{font-size:30px;line-height:1.25;color:#f1f6f3}
    body.ask-focus-mode .ask-turn.answer>p:first-of-type{margin:20px 0 30px;padding:18px 24px;border-radius:8px;background:#102019;color:#dce6e1;font-size:17px}
    body.ask-focus-mode .ask-verified{padding:28px 32px;border-color:#304239;border-left-color:#75e3b7;background:#0f1915}
    body.ask-focus-mode .ask-verified-head{padding-bottom:18px;border-bottom:1px solid #26372f}.runner-verified{padding:6px 10px}
    body.ask-focus-mode .ask-tool-trace{padding-top:18px}.ask-tool-trace table th,.ask-tool-trace table td{padding:13px 8px}
    body.ask-focus-mode .ask-refused{padding:28px 32px;background:#201b11}
    body.ask-result-mode main{padding-top:56px}
    body.ask-result-mode .ask-head,body.ask-result-mode #ask-authority-summary,body.ask-result-mode #ask-configured-summary,body.ask-result-mode #ask-starters,body.ask-result-mode .ask-disclosure{display:none!important}
    body.ask-result-mode #ask-chat,body.ask-result-mode #ask-transcript,body.ask-result-mode .ask-turn,body.ask-result-mode .ask-verified,body.ask-result-mode .ask-tool-trace{min-width:0;max-width:100%}
    body.ask-result-mode #ask-chat{max-width:1080px}
    body.ask-result-mode #ask-transcript{margin:0 0 30px}
    body.ask-result-mode pre{max-width:100%;overflow:auto}
    body.ask-result-mode .ask-transcript>.ask-turn:not(.answer)>strong{display:block;margin-bottom:12px;color:#77857e;font-size:11px;text-transform:uppercase}
    body.ask-result-mode .ask-transcript>.ask-turn:not(.answer):not(.error)>strong::after{content:" asked"}
    body.ask-result-mode .ask-transcript>.ask-turn:not(.answer)>p{max-width:980px;margin:0 0 30px;font-size:34px;line-height:1.25}
    body.ask-result-mode .ask-turn.error{padding:18px 20px;border:1px solid #704039;border-left:3px solid #e18072;border-radius:7px;background:#211513}
    body.ask-result-mode .ask-turn.error>strong{color:#e8a69b}
    body.ask-result-mode .ask-turn.error>p{margin:6px 0 0!important;color:#eed6d1!important;font-size:16px!important}
    body.ask-result-mode .ask-turn.answer>strong{display:none}
    body.ask-result-mode .ask-answer-grid{display:flex;flex-direction:column;gap:14px;align-items:stretch}
    body.ask-result-mode .ask-model-panel{min-width:0;padding:24px;border:1px solid #26372f;border-radius:8px;background:#102019}
    body.ask-result-mode .ask-model-label{display:flex;align-items:center;gap:9px;margin-bottom:15px;color:#75e3b7;font-size:11px;font-weight:800;text-transform:uppercase}
    body.ask-result-mode .ask-model-label::before{content:"✦";font-size:18px}
    body.ask-result-mode .ask-model-panel>p{margin:0;color:#dce6e1;font-size:17px;line-height:1.65;font-style:italic}
    body.ask-result-mode .ask-model-panel details{margin-top:18px}
    body.ask-result-mode .ask-verified{margin:0}
    body.ask-result-mode .ask-answer-grid>.ask-refused,body.ask-result-mode .ask-answer-grid>.notice{margin:0}
    body.ask-result-mode .ask-turn.answer>.ask-recovery,body.ask-result-mode .ask-turn.answer>.notice{margin-top:18px}
    body.ask-result-mode .ask-composer{margin-top:8px;padding:18px 20px;grid-template-columns:minmax(0,1fr) auto}
    body.ask-result-mode .ask-composer label.field>span:first-child{display:none}
    body.ask-result-mode .ask-composer textarea{min-height:52px;font-size:17px}
    body.ask-result-mode #ask-run-status:empty{display:none}
    .ask-composer.is-running{border-color:#75e3b7!important;box-shadow:0 0 0 1px #75e3b733}
    .ask-composer.is-running textarea{opacity:.72}
    #run-ask.loading{display:inline-flex;align-items:center;justify-content:center;gap:9px}
    #run-ask.loading::before{content:"";width:14px;height:14px;border:2px solid #07100c55;border-top-color:#07100c;border-radius:50%;animation:ask-spin .8s linear infinite}
    .ask-composer #ask-run-status{grid-column:1/-1;display:flex;align-items:center;gap:9px;margin:0;min-height:0}
    .ask-composer.is-running #ask-run-status::before{content:"";width:8px;height:8px;flex:0 0 auto;border-radius:50%;background:#75e3b7;box-shadow:0 0 0 5px #75e3b71a;animation:ask-pulse 1.15s ease-in-out infinite}
    .ask-verified-count{display:flex;align-items:center;gap:8px;margin:12px 0;color:#aebbb5;font-size:13px}.ask-verified-count::before{content:"";width:7px;height:7px;border-radius:50%;background:#75e3b7}
    .verified-data-details{margin:15px 0 0;border:1px solid #304239;border-radius:7px;background:#0b1511}
    .verified-data-details>summary{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 14px;color:#dce6e1;font-weight:750;list-style:none}
    .verified-data-details>summary::-webkit-details-marker{display:none}.verified-data-details>summary::after{content:"View";color:#75e3b7;font-size:11px;font-weight:800;text-transform:uppercase}
    .verified-data-details[open]>summary::after{content:"Hide"}.verified-data-details:not([open])>.verified-data-body{display:none}.verified-data-body{padding:0 14px 14px;border-top:1px solid #26372f}.verified-data-body .result-table{margin-top:14px}
    @keyframes ask-spin{to{transform:rotate(360deg)}}@keyframes ask-pulse{50%{opacity:.4;transform:scale(.8)}}

    body.access-focus-mode .workspace{max-width:1280px;width:100%}
    .access-editor-head h2{font-size:36px}.access-nav{padding:18px}.access-focus>#resource-detail,.access-focus>#global-decisions{padding:24px}.access-resource{border-radius:7px}.access-final{border-color:#34483e;background:#0f1915}

    @media(prefers-reduced-motion:reduce){.instant-flow-active,#run-ask.loading::before,.ask-composer.is-running #ask-run-status::before{animation:none}.view{animation:none}}
    @media(max-width:960px){.instant-reveal{grid-template-columns:minmax(360px,.85fr) minmax(500px,1.15fr);gap:32px}.instant-copy h2{font-size:42px}}
    @media(max-width:820px){
      header>div,main,body.quick-start-mode header>div,body.quick-start-mode main,body.ask-focus-mode header>div,body.ask-focus-mode main,body.access-focus-mode header>div,body.access-focus-mode main{width:calc(100% - 32px)}
      main{padding-top:26px}.workflow-rail{margin-bottom:28px}.steps{display:flex;overflow-x:auto}.step{flex:0 0 auto;min-width:170px}.instant-reveal{grid-template-columns:1fr;gap:28px;padding:22px 0 44px}.instant-copy{padding-top:0}.instant-copy h2{font-size:38px}.instant-boundary{padding:22px}.instant-flow{min-height:150px}
      body.ask-focus-mode .ask-head{padding:28px 0 24px}body.ask-focus-mode .ask-head h3{font-size:34px}
      body.ask-focus-mode .ask-composer{padding:24px;grid-template-columns:1fr}.ask-composer-actions{justify-content:flex-end}
    }
    @media(max-width:560px){
      header>div,main,body.quick-start-mode header>div,body.quick-start-mode main,body.ask-focus-mode header>div,body.ask-focus-mode main,body.access-focus-mode header>div,body.access-focus-mode main{width:calc(100% - 40px)}
      header>div{min-height:62px;gap:8px}.brand{flex:0 0 auto;gap:8px}.brand-copy h1{white-space:nowrap;overflow-wrap:normal}.brand-copy p{display:none}.header-status{min-width:0;gap:6px;padding:0;border:0;background:transparent}.header-status::before{display:none}.header-status .badge{display:none}.header-status .state{max-width:104px;font-size:12px;line-height:1.25}.header-back{min-height:38px;padding:6px 9px}
      #view-overview>h2{font-size:32px}.workflow-rail{margin-bottom:24px}.step{min-width:150px}.toolbar{display:grid;grid-template-columns:1fr 1fr}.toolbar button{width:100%}
	      body.quick-start-mode main{padding-top:0}.instant-reveal{gap:0;padding-top:22px}.instant-copy{gap:16px}.instant-copy .instant-kicker{margin-bottom:8px}.instant-copy h2{margin-bottom:24px;font-size:31px;line-height:1.15}.instant-copy>p:not(.instant-kicker){display:none}.instant-actions{order:4;display:grid;margin-bottom:24px}.instant-actions button{width:100%}.instant-actions .secondary{order:2}.instant-boundary{order:5;margin-bottom:32px;padding:18px}.instant-boundary-head{position:relative}.instant-boundary-head>div{width:100%;min-width:0}.instant-boundary-head h3{font-size:21px}.instant-boundary-head .instant-badge{position:absolute;top:0;right:0}.instant-flow{min-height:118px;margin:10px 0}.instant-facts{grid-template-columns:1fr;gap:10px}.instant-fact p{font-size:13px}.instant-fact:nth-child(2){order:3;display:flex;align-items:baseline;gap:4px;flex-wrap:wrap}.instant-fact:nth-child(2) strong{margin:0}.instant-fact:nth-child(2) strong::after{content:" ·"}.instant-fact:nth-child(2) br{display:none}.instant-fact:nth-child(2) .muted::before{content:" · "}.instant-fact:nth-child(2) p{font-size:11px;line-height:1.4;text-transform:uppercase}.instant-fact:nth-child(3){order:2}.instant-fact:nth-child(4){display:none}.instant-preview{display:none}.instant-trust{order:6;margin-top:6px}
      body.ask-focus-mode .ask-head h3{font-size:30px}.ask-state{width:100%;justify-content:center}.ask-state .quiet{min-height:38px}.ask-grid{grid-template-columns:1fr}
      body.ask-focus-mode #ask-starters{grid-template-columns:1fr}.ask-transcript>.ask-turn:not(.answer)>p{font-size:24px}
      body.ask-focus-mode .ask-verified{padding:20px}.ask-verified-head{align-items:flex-start}.runner-verified{font-size:10px}
	      .ask-boundary-grid,.boundary-proof-grid,.boundary-catalog-nodes{grid-template-columns:1fr}.ask-boundary-summary{display:grid;gap:2px}.ask-boundary-resource{padding:13px}.ask-boundary-actions{align-items:stretch;flex-direction:column}.ask-boundary-actions button{width:100%}.boundary-catalog-controls{grid-template-columns:1fr}.boundary-catalog-edge{grid-template-columns:1fr;gap:5px}.boundary-catalog-edge span{text-align:left}.boundary-relationship-summary{grid-template-columns:1fr}.boundary-relationship-summary>strong{grid-row:auto}
      .ask-boundary-pagination{align-items:stretch;flex-direction:column}.ask-boundary-pagination-actions{display:grid;grid-template-columns:1fr 1fr}.ask-boundary-pagination-actions button{width:100%}
	      .ask-history-body{padding:0 16px 16px}.ask-history-table-wrap{overflow:visible}.ask-history table{min-width:0}.ask-history thead{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.ask-history tbody,.ask-history tr,.ask-history td{display:block;width:100%}.ask-history tr{padding:10px 0;border-top:1px solid #26372f}.ask-history td{display:grid;grid-template-columns:88px minmax(0,1fr);gap:8px;padding:5px 0;border:0}.ask-history td::before{content:attr(data-label);color:#839189;font-size:10px;font-weight:800;text-transform:uppercase}.history-durable-table td:nth-child(3),.history-durable-table td:nth-child(6){min-width:0}
	      .resolved-time-table{overflow:visible}.resolved-time-table table{min-width:0}.resolved-time-table thead{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.resolved-time-table tbody,.resolved-time-table tr,.resolved-time-table td{display:block;width:100%}.resolved-time-table tr{padding:10px 0;border-top:1px solid #26372f}.resolved-time-table td{display:grid;grid-template-columns:108px minmax(0,1fr);gap:8px;padding:5px 0;border:0}.resolved-time-table td::before{content:attr(data-label);color:#839189;font-size:10px;font-weight:800;text-transform:uppercase}.resolved-time-table .utc-range span{white-space:normal;overflow-wrap:normal;word-break:normal}
      body.ask-result-mode main{padding-top:28px}.ask-result-mode .ask-transcript>.ask-turn:not(.answer)>p{font-size:30px}body.ask-result-mode .ask-answer-grid{grid-template-columns:1fr}.ask-result-mode .ask-model-panel,.ask-result-mode .ask-verified{padding:20px}.ask-result-mode .ask-composer{grid-template-columns:1fr;padding:16px}
    }
    /* Ask chat redesign: model reply is the primary bubble; verified result is a labeled collapsed disclosure */
    .ask-answer-grid{display:flex;flex-direction:column;gap:12px}
    .ask-model-panel{border:1px solid var(--line);border-radius:16px 16px 16px 4px;background:var(--surface);padding:15px 18px}
    .ask-model-label{display:flex;align-items:center;gap:8px;margin-bottom:8px;color:var(--accent);font-size:11px;font-weight:800;text-transform:uppercase}
    .ask-model-label::before{content:"✦";font-size:15px}
    .ask-model-panel>p{margin:0;font-size:15px;line-height:1.6;color:var(--text);font-style:italic}
    details.ask-verified{margin:0;border:1px solid var(--line);border-radius:12px;background:var(--surface-2);padding:0}
    details.ask-verified>summary{display:flex;align-items:center;gap:10px;padding:11px 14px;list-style:none;color:var(--text);font-weight:650;cursor:pointer}
    details.ask-verified>summary::-webkit-details-marker{display:none}
    details.ask-verified .ask-verified-hint{flex:1;color:var(--muted);font-weight:500;font-size:12px}
    details.ask-verified>summary::after{content:"Show";color:var(--accent);font-size:11px;font-weight:800;text-transform:uppercase}
    details.ask-verified[open]>summary::after{content:"Hide"}
    details.ask-verified>.ask-verified-body{padding:2px 14px 14px;border-top:1px solid var(--line)}
    body.ask-result-mode details.ask-verified{border-color:#304239;background:#0f1915}
    body.ask-result-mode details.ask-verified>.ask-verified-body{border-top-color:#26372f}
    .ask-composer{position:sticky;bottom:10px;z-index:5;border:1px solid var(--line);border-radius:14px;background:var(--surface);padding:12px;box-shadow:var(--shadow)}
    #ask-starters{display:flex;flex-wrap:wrap;gap:8px}
    #ask-starters .question{width:auto;border-radius:999px;padding:7px 14px;min-height:36px;font-weight:600}
    #ask-starters .question:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-soft);transform:none}
    @keyframes ask-turn-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
    .ask-turn{animation:ask-turn-in .28s ease both}
    details.ask-verified>.ask-verified-body{animation:ask-turn-in .22s ease both}
    .view.active{animation:ask-turn-in .2s ease both}
    @media(prefers-reduced-motion:reduce){.ask-turn,details.ask-verified>.ask-verified-body,.view.active{animation:none}}
    .access-search{margin:0 0 10px}.access-search input{min-height:40px}
  </style>
</head>
<body>
	  <header><div><div class="brand"><span class="brand-mark" aria-hidden="true">S</span><div class="brand-copy"><h1>Synapsor</h1><p>/ Workbench</p></div></div><div class="header-status"><button id="leave-ask-focus" class="quiet header-back" type="button">Workbench</button><span id="session-state" class="badge">Session checking</span><span id="header-state" class="state">Loading</span></div></div></header>
  <main>
    <div class="workbench-layout">
      <aside class="workflow-rail">
        <p class="rail-label">Setup workflow</p>
        <nav class="steps" aria-label="Workbench destinations">
          <button class="step" data-view="explore" type="button">Ask your data</button>
          <button class="step active" data-view="overview" type="button">Review data access</button>
          <button class="step" data-view="activate" type="button">Activate changes</button>
          <button class="step" data-view="protect" type="button">Make reusable</button>
          <button class="step" data-view="action" type="button">Add safe action</button>
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
		      <section id="instant-path" class="instant-path hidden" aria-labelledby="instant-title">
            <div class="instant-reveal">
              <div class="instant-copy">
                <p class="instant-kicker">Safe starting boundary ready</p>
                <h2 id="instant-title">Review once.<span>Then ask your database.</span></h2>
	                <p>Runner inspected schema metadata and prepared useful, conservative access. Your model can combine only the tables, fields, relationships, and operations shown here. Nothing is active yet.</p>
                <div class="instant-actions">
                  <button id="run-instant" type="button">Review and start asking →</button>
	                  <button id="instant-full-review" class="secondary" type="button">Edit tables or columns</button>
                  <span id="instant-status" class="status-message" role="status" aria-live="polite"></span>
                </div>
                <span class="instant-trust">Metadata inspected · No source rows read or changed</span>
              </div>
              <section id="instant-authority" class="instant-boundary" aria-label="Proposed reviewed AI data boundary"></section>
            </div>
	        <div id="instant-result" class="instant-result"></div>
	      </section>
	      <div id="journey-state" class="band journey" aria-live="polite"></div>
		      <div id="database-summary" class="band"></div>
		      <div id="summary" class="summary" aria-live="polite"></div>
		      <section id="boundary-overview" class="boundary-overview" aria-labelledby="boundary-overview-title"></section>
	      <details id="overview-table-details" class="band">
	        <summary>Inspect generated table details</summary>
	        <div class="split-actions" style="margin-top:16px">
	          <div>
	            <h2 id="resources-heading">Table details</h2>
	            <p>Inspect generated classifications and blockers. Boundary editing remains in the review screen.</p>
	          </div>
	          <div class="toolbar">
	            <button id="show-all" class="secondary" type="button">Show all tables</button>
	            <button id="show-risks" class="secondary" type="button">Show only risks</button>
	            <button id="show-exposed" class="secondary" type="button">Show visible data</button>
	            <button id="show-unresolved" class="secondary" type="button">Show blocked setup</button>
	          </div>
	        </div>
	        <div id="resources" class="resource-list"></div>
	        <div class="actions"><button id="overview-primary" class="secondary" data-next="exceptions" type="button">Review flagged access</button></div>
	      </details>
	      <details class="band"><summary>Existing project actions</summary><p>Resume does not inspect the database or rewrite files. Rescan is explicit. Start over resets managed boundary-review decisions but preserves the ledger, protected named capabilities, Runner config, and source database.</p><div class="actions"><button class="secondary" id="resume-review" type="button">Resume existing review</button><button class="secondary" id="try-active" type="button">Try active tools</button><button class="quiet" id="rescan-project" type="button">Rescan and review changes</button><button class="danger" id="start-over" type="button">Start over review</button></div><div id="project-action-message"></div></details>
	    </section>

	    <section id="view-exceptions" class="view">
	      <div class="access-editor-head">
	        <button id="access-back" class="quiet" type="button" aria-label="Back">← Back</button>
	        <div><p class="instant-kicker">Step 1 of 2 · Edit access</p><h2>Pick a table. Set each column's access.</h2><p>Add tables and choose whether each usable column is visible to the model, visible only in Runner's verified output, or kept out. Anything uncertain stays unavailable. Nothing becomes active until the one exact confirmation on the next screen.</p></div>
	      </div>
	      <div class="access-editor">
	        <aside id="resource-navigation-shell" class="access-nav" aria-label="Table navigation">
	          <label><span id="resource-search-label">Find a table</span><input id="resource-search" type="search" autocomplete="off" placeholder="Search tables"></label>
	          <div class="access-catalog-mode" role="group" aria-label="Tables shown">
	            <button id="show-related-access" class="secondary active" type="button">Boundary + related</button>
	            <button id="show-all-access" class="secondary" type="button">All inspected</button>
	          </div>
	          <small id="access-catalog-note" class="access-catalog-note">Related tables have a proven database relationship to this boundary.</small>
	          <div id="resource-navigation" class="access-resource-list"></div>
	        </aside>
	        <div class="access-focus">
	          <div id="resource-detail"><div class="resource-detail-placeholder"><div><h3>Select one table</h3><p>Review model-visible, model-withheld, and kept-out fields alongside scope, relationships, and privacy limits.</p></div></div></div>
	          <div id="global-decisions"></div>
	        </div>
	      </div>
	      <div id="access-staged" class="access-final hidden" aria-live="polite"><p><strong id="access-staged-summary">No access changes staged</strong><br><span class="muted">This remains a disabled draft until Step 2.</span></p><button id="review-staged-access" type="button">Step 2 · Review and activate →</button></div>
	    </section>

    <section id="view-activate" class="view">
      <p class="instant-kicker">Step 2 of 2 · Human confirmation</p>
      <h2>Review this exact boundary once</h2>
      <div id="signoff-summary" class="band"></div>
      <div class="form-grid">
        <div class="field"><span>Authoring profile</span><strong id="deployment-profile-label">Local development/staging</strong><span>Established by <code>synapsor-runner start</code>. Scoped Explore cannot run in production or an unknown profile.</span><input id="deployment-profile" type="hidden" value="staging"></div>
        <label class="field">Who reviewed it?
          <input id="actor" type="text" maxlength="128" placeholder="alex@example.com" autocomplete="username">
          <span>An audit label for the local human reviewer, not a password or API key.</span>
        </label>
      </div>
      <div id="role-posture" class="band"></div>
      <div class="footer-actions">
	        <button id="preview" type="button">Activate boundary and ask</button>
        <span id="message" class="status-message" role="status" aria-live="polite"></span>
      </div>
    </section>

    <section id="view-explore" class="view">
      <h2>Ask your reviewed data</h2>
      <p>Use your hosted or local model in plain language. Every question still runs through the exact activated fields, relationships, trusted scope, privacy limits, and budgets.</p>
	      <div id="explore-preflight" class="band"><button id="run-preflight" type="button">Check access and start</button></div>
	      <div id="explorer" class="hidden">
          <details id="external-client-setup" class="band">
            <summary>Use an existing AI or MCP client</summary>
            <p>Connect the same reviewed tools to a client that already has its own model. The client receives no broader authority than Workbench Ask.</p>
            <div id="client-configs"></div>
          </details>
          <section class="no-model-surface" aria-labelledby="no-model-title">
            <div class="split-actions">
              <div><h3 id="no-model-title">Use without a model</h3><p>Optional exact-plan composer for local testing or when you do not want approved result fields to leave this machine.</p></div>
              <button id="open-no-model" class="secondary" type="button">Open no-model composer</button>
            </div>
            <div id="no-model-content" class="no-model-content hidden">
	            <div id="first-reviewed-question" class="band"></div>
	            <details id="explore-composer" class="band">
	              <summary>Build another reviewed question</summary>
	              <div class="tabs" role="tablist" aria-label="Explore mode">
	                <button id="aggregate-tab" class="tab active" type="button" role="tab">Trends and totals</button>
	                <button id="row-tab" class="tab" type="button" role="tab">One record</button>
	              </div>
	              <div id="suggested-questions" class="question-list"></div>
	              <div id="aggregate-builder" class="form-grid" style="margin-top:14px"></div>
	              <div id="row-builder" class="form-grid hidden" style="margin-top:14px"></div>
	              <details><summary>Advanced structured plan</summary><pre id="plan-preview"></pre></details>
	              <div class="actions"><button id="run-explore" type="button">Run this reviewed question</button></div>
	            </details>
            <div id="explore-status" class="status-message" role="status" aria-live="polite"></div>
            <div id="explore-result"></div>
            </div>
          </section>
      </div>
      <section id="ask-shell" class="ask-surface hidden" aria-labelledby="ask-title">
        <div class="ask-head">
          <div>
            <span class="instant-kicker">Ask with your model</span>
            <h3 id="ask-title">Ask naturally. Runner holds the boundary.</h3>
            <p>Your model can reason freely. Its database requests cannot.</p>
          </div>
          <div class="ask-state"><span id="ask-provider-state" class="badge">Not configured</span><button id="prove-boundary" data-prove-boundary type="button">Prove this boundary</button><button id="ask-tune-access" data-tune-boundary class="quiet" type="button">Tune access</button></div>
        </div>
        <div class="ask-body">
          <div id="ask-authority-summary"></div>
          <div id="boundary-proof-result"></div>
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
                <label class="field">Model request timeout (seconds)
                  <input id="ask-timeout" type="number" min="1" max="600" step="1" placeholder="Automatic">
                </label>
                <label class="field">Session reported-token budget
                  <input id="ask-session-token-budget" type="number" min="1000" max="5000000" step="1000" placeholder="200000">
                  <span>Client spend/context control. This does not change Explore privacy budgets.</span>
                </label>
                <label class="field">Maximum output tokens per provider call
                  <input id="ask-max-output-tokens" type="number" min="256" max="16384" step="1" placeholder="Automatic">
                  <span>Leave blank to retain the existing provider-call defaults.</span>
                </label>
              </div>
              <details id="ask-credential-details">
                <summary>Credential options</summary>
                <div class="ask-grid" style="margin-top:12px">
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
              </details>
              <div id="ask-egress-review" class="ask-egress-review">
                <span class="instant-kicker">Direct provider egress</span>
                <strong>Review what can leave this machine</strong>
                <label class="check"><input id="ask-egress" type="checkbox"><span><strong>Allow this reviewed provider egress</strong><small>Approved model-visible fields and your question may go directly to this provider. Model-withheld values remain in Runner's local verified result; kept-out fields remain unavailable. Synapsor does not relay the request.</small></span></label>
              </div>
              <div class="actions"><button id="configure-ask" type="button">Start asking in plain English</button><span id="ask-config-status" class="status-message" role="status" aria-live="polite"></span></div>
              <div class="actions"><button id="open-client-setup" class="secondary" type="button">Use an existing MCP client</button><button id="ask-open-no-model" class="quiet" type="button">Continue without a model</button></div>
            </div>
            <div id="ask-configured-summary" class="hidden">
              <div class="split-actions">
                <div><strong id="ask-configured-model"></strong><p id="ask-configured-detail"></p></div>
                <button id="change-ask-provider" class="secondary" type="button">Change provider or model</button>
              </div>
              <span class="badge good">Consent matches the current reviewed access</span>
            </div>
          </div>
          <div id="ask-chat" class="hidden">
            <div id="ask-submit-consent" class="ask-disclosure hidden"></div>
            <div class="ask-disclosure"><strong>Session-only conversation</strong><p>Questions, tool results, and model responses stay in memory and are cleared when this Workbench stops or you select Clear. Model output is untrusted; database facts must come through a reviewed tool call.</p></div>
            <details id="ask-live-limits" class="ask-history">
              <summary><span>Ask limits</span><small id="ask-limit-usage">Loading reported-token usage...</small></summary>
              <div class="ask-history-body">
                <p>Raise these in-memory client limits without clearing this conversation. They do not change reviewed database access, cohort suppression, or Explore privacy accounting.</p>
                <div class="ask-grid">
                  <label class="field">Session reported-token budget
                    <input id="ask-live-session-token-budget" type="number" min="1000" max="5000000" step="1000">
                  </label>
                  <label class="field">Maximum output tokens per provider call
                    <input id="ask-live-max-output-tokens" type="number" min="256" max="16384" step="1" placeholder="Automatic">
                  </label>
                </div>
                <div class="actions"><button id="update-ask-limits" class="secondary" type="button">Update Ask limits</button><span id="ask-limit-status" class="status-message" role="status" aria-live="polite"></span></div>
              </div>
            </details>
            <details id="ask-boundary-guide" class="ask-boundary-guide">
              <summary><span class="ask-boundary-summary"><strong>What can I ask?</strong><small id="ask-boundary-summary">Loading tables and the reviewed relationship map...</small></span></summary>
              <div id="ask-boundary-body" class="ask-boundary-body"></div>
            </details>
            <div class="ask-proof-actions"><button id="prove-boundary-chat" data-prove-boundary class="secondary" type="button">Prove this boundary</button><button data-tune-boundary class="quiet" type="button">Tune access</button></div>
            <details id="ask-history" class="ask-history">
              <summary>Query history</summary>
              <div class="ask-history-body">
                <p>Recent references can still be inspected or protected. Durable history contains bounded audit metadata only; Runner does not persist model conversations, result values, trusted scope values, or raw SQL.</p>
                <div class="grid two ask-history-filters">
                  <label class="field">Tenant fingerprint<input id="ask-history-tenant" type="text" maxlength="160" placeholder="Optional keyed scope"></label>
                  <label class="field">Resource<input id="ask-history-table" type="text" maxlength="256" placeholder="Optional schema.table"></label>
                  <label class="field">Capability<input id="ask-history-capability" type="text" maxlength="160" placeholder="Optional exact capability"></label>
                  <label class="field">Since<input id="ask-history-since" type="datetime-local"></label>
                </div>
                <div class="actions"><button id="load-ask-history" class="secondary" type="button">Load query history</button></div>
                <div id="ask-history-status" class="status-message" role="status" aria-live="polite"></div>
                <div id="ask-history-content"></div>
              </div>
            </details>
            <div id="ask-starters" class="question-list"></div>
            <div id="ask-transcript" class="ask-transcript" aria-live="polite"></div>
            <div class="ask-composer">
              <label class="field">Ask your database
                <textarea id="ask-question" maxlength="4000" placeholder="Ask about the reviewed data here. Enter to send, Shift+Enter for a new line."></textarea>
              </label>
              <div class="ask-composer-actions">
                <button id="run-ask" type="button">Ask</button>
                <button id="cancel-ask" class="secondary" type="button" disabled>Cancel</button>
                <button id="clear-ask" class="quiet" type="button">Clear</button>
              </div>
              <div id="ask-run-status" class="status-message" role="status" aria-live="polite"></div>
            </div>
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
          </div>
          <div id="action-unavailable" class="band notice hidden"></div>
          <div id="action-authoring-controls">
            <div class="form-grid" style="margin-top:14px">
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
          </div>
        </section>
      </div>
    </section>
      </div>
    </div>
  </main>
  <script>
    ${workbenchSyntaxScript()}
    const csrf="${escapedCsrf}";
    const reviewedBudgetCeilings=${reviewedBudgetCeilings};
    let original;
    let candidate;
    let reviewReport;
    let activeBoundary;
    let activeBoundaries=[];
    let boundaryLibrary={selected_name:"",entries:[]};
    let boundaryRescanReport=null;
    let databaseServerCompatibility=null;
    let candidateDigest;
	    let currentView="overview";
	    const validViews=new Set(["overview","exceptions","activate","explore","protect","action"]);
	    let viewHistoryReady=false;
	    let resourceFilter="starter";
	    let resourceSearch="";
	    let showAllAccessResources=false;
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
    let preferredProtectedCapability=null;
    let protectQueries=[];
    let selectedProtect=null;
    let protectedDraft=null;
    const askEvidenceByRef=new Map();
    let guidedActionData=null;
    let guidedActionDraft=null;
    let askStatus=null;
	    let boundaryCatalog={schema_version:"synapsor.boundary-catalog.v1",table_count:0,relationship_count:0,boundaries:[]};
	    let boundaryMermaid="flowchart LR";
	    let boundaryDiagrams=[];
	    let boundaryGraphSequence=0;
    let askConsentOnSubmit=false;
    let askStarterPrompts=[];
    const askBoundaryPageSize=6;
    let askBoundaryPage=0;
    let askBoundaryResourceSignature="";
    let instantOnboarding=null;
    let focusAskAfterLoad=false;
    let openNoModelAfterLoad=false;
	    let openClientAfterLoad=false;
	    let reviewProgressHealthy=true;
	    let progressSave=Promise.resolve();
	    let accessBaselineColumns=null;
	    let highlightedAccessField=null;
	    let focusedAccessReview=false;
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
    const humanizeIdentifier=value=>String(value)
      .replace(/([a-z0-9])([A-Z])/g,"$1 $2")
      .replace(/[_-]+/g," ")
      .trim()
      .replace(/\b\w/g,char=>char.toUpperCase());
	    function handleSessionFailure(payload){
	      if(!["WORKBENCH_SESSION_REQUIRED","WORKBENCH_SESSION_EXPIRED","WORKBENCH_SESSION_INVALID"].includes(payload?.error_code))return false;
	      document.querySelectorAll("button,input,select,textarea").forEach(control=>control.disabled=true);
	      byId("session-state").textContent=payload.error_code==="WORKBENCH_SESSION_EXPIRED"?"Session expired":"Session unavailable";
	      byId("session-state").className="badge bad";
	      byId("header-state").textContent="No operator authority";
	      byId("header-state").className="state";
	      document.querySelector(".workspace").innerHTML='<section class="view active"><h2>Your local Workbench session '+(payload.error_code==="WORKBENCH_SESSION_EXPIRED"?"expired":"is unavailable")+'.</h2><div class="band notice"><p>Saved review progress is preserved. No authority or source data changed.</p><p><strong>Return to the terminal and type <code>r</code>, then open the fresh one-time URL.</strong></p><p>Text that had not yet been saved in an open form cannot be recovered.</p></div></section>';
	      return true;
	    }
	    const readPayload=async response=>{try{return await response.json()}catch{return {ok:false,error:"Workbench returned an unreadable response."}}};
	    const getJson=async url=>{const response=await fetch(url);const payload=await readPayload(response);if(handleSessionFailure(payload)){const error=new Error(payload.error);error.payload=payload;throw error}if(!response.ok||!payload.ok){const error=new Error(payload.error||"Request failed");error.payload=payload;throw error}return payload};
	    const post=async(url,body)=>{const response=await fetch(url,{method:"POST",headers:{"content-type":"application/json","x-synapsor-csrf":csrf},body:JSON.stringify(body)});const payload=await readPayload(response);if(handleSessionFailure(payload)){const error=new Error(payload.error);error.payload=payload;throw error}if(!response.ok||!payload.ok){const error=new Error(payload.error||"Request failed");error.payload=payload;throw error}return payload};
	    const currentResource=id=>candidate&&candidate.pack.resources.find(resource=>resource.id===id);
	    const activeBoundaryForCandidate=()=>activeBoundaries.find(boundary=>
	      boundary?.pack?.name===candidate?.pack?.name);
	    const accessRelationshipConnections=id=>{
	      if(!original||!candidate)return[];
	      const includedIds=new Set(candidate.pack.resources.map(resource=>resource.id));
	      const connections=[];
	      const source=original.pack.resources.find(resource=>resource.id===id);
	      for(const relationship of source?.relationships||[]){
	        if(!includedIds.has(relationship.target_resource))continue;
	        connections.push({
	          source:id,
	          target:relationship.target_resource,
	          relationship:relationship.id,
	          depth:relationship.path_depth||1
	        });
	      }
	      for(const boundaryResource of original.pack.resources){
	        if(!includedIds.has(boundaryResource.id))continue;
	        for(const relationship of boundaryResource.relationships||[]){
	          if(relationship.target_resource!==id)continue;
	          connections.push({
	            source:boundaryResource.id,
	            target:id,
	            relationship:relationship.id,
	            depth:relationship.path_depth||1
	          });
	        }
	      }
	      return connections.sort((left,right)=>left.depth-right.depth
	        ||left.source.localeCompare(right.source)
	        ||left.target.localeCompare(right.target)
	        ||left.relationship.localeCompare(right.relationship));
	    };
	    const accessBoundaryEndpoint=connection=>{
	      const includedIds=new Set((candidate?.pack?.resources||[]).map(resource=>resource.id));
	      return includedIds.has(connection.source)?connection.source:connection.target;
	    };
	    const reviewResource=id=>(reviewReport&&reviewReport.resources||[]).find(resource=>resource.id===id);
	    function reviewedFieldAccessTier(resource,field){
	      if(!resource)return "kept_out";
	      if((resource.kept_out_fields||[]).includes(field))return "kept_out";
	      if((resource.model_withheld_fields||[]).includes(field))return "runner_only";
	      if((resource.selectable_fields||[]).includes(field))return "visible";
	      return "kept_out";
	    }
	    function reviewedFieldAccessCounts(resource,review=reviewResource(resource&&resource.id)){
	      const reviewedFields=(review&&review.fields||[]).map(field=>field.name);
	      const fields=[...new Set(reviewedFields.length?reviewedFields:Object.keys(resource&&resource.field_types||{}))];
	      return fields.reduce((counts,field)=>{
	        const tier=reviewedFieldAccessTier(resource,field);
	        if(tier==="visible")counts.visible+=1;
	        else if(tier==="runner_only")counts.runnerOnly+=1;
	        else counts.keptOut+=1;
	        return counts;
	      },{visible:0,runnerOnly:0,keptOut:0});
	    }
	    function totalReviewedFieldAccess(resources){
	      return (resources||[]).reduce((total,resource)=>{
	        const counts=reviewedFieldAccessCounts(resource);
	        total.visible+=counts.visible;
	        total.runnerOnly+=counts.runnerOnly;
	        total.keptOut+=counts.keptOut;
	        return total;
	      },{visible:0,runnerOnly:0,keptOut:0});
	    }
	    const reviewedResourceKind=id=>reviewResource(id)?.type==="view"?"view":"table";
	    const reviewedCollectionLabel=(resources=reviewReport?.resources||[])=>{
	      return resources.some(resource=>resource.type==="view")?"tables and views":"tables";
	    };
	    const reviewedCollectionLabelForResources=(resources=[])=>{
	      const ids=new Set(resources.map(resource=>resource?.id||resource?.table).filter(Boolean));
	      const reviewed=(reviewReport?.resources||[]).filter(resource=>ids.has(resource.id));
	      return reviewedCollectionLabel(reviewed);
	    };
	    const resourceDecisions=id=>(candidate?.unresolved_decisions||[]).filter(decision=>decision.startsWith(id+":"));
	    const outstandingResourceDecisions=id=>resourceDecisions(id).filter(decision=>!confirmedDecisions.has(decision));
	    const globalDecisions=()=>(candidate?.unresolved_decisions||[]).filter(decision=>
        !decision.startsWith("deployment profile:")
        &&!(reviewReport.resources||[]).some(resource=>decision.startsWith(resource.id+":"))
      );
    const classificationFor=(id,field)=>{const resource=reviewResource(id);return resource&&resource.fields&&resource.fields.find(item=>item.name===field)?.sensitivity};
    const stateLabel=state=>state==="high_confidence_sensitive"?"Sensitive":state==="unresolved_free_text"?"Needs review":"Low structural risk";
    const hasActiveAuthority=()=>activeBoundaries.length>0||journey?.authority_active===true;
    function showDeploymentProfile(profile){
      byId("deployment-profile").value=profile;
      byId("deployment-profile-label").textContent=profile==="development"
        ?"Local development"
        :"Local staging";
    }

    function localWorkbenchActor(){
      return byId("actor").value.trim()||"local-workbench-review";
    }

    async function openFocusedAccessReview(options={}){
      focusedAccessReview=true;
      document.body.classList.remove("quick-start-mode");
      if(options.useStarter===true&&instantOnboarding?.candidate){
        candidate=structuredClone(instantOnboarding.candidate);
        confirmedDecisions=new Set();
        candidateDigest=undefined;
        accessBaselineColumns=accessColumnSnapshot(candidate);
        syncCandidateDecisions();
        await queueReviewProgressSave();
      }else{
        accessBaselineColumns=accessColumnSnapshot(activeBoundaryForCandidate()||candidate);
      }
      selectedResource=candidate?.pack?.resources?.[0]?.id||selectedResource;
      setView("exceptions");
    }

    async function openFocusedActivationReview(){
      focusedAccessReview=true;
      await queueReviewProgressSave();
      if(!reviewProgressHealthy)return;
      setView("activate");
    }

    function renderInstantOnboarding(){
      const shell=byId("instant-path");
      if(!instantOnboarding?.available||!instantOnboarding?.candidate||activeBoundaries.length>0){
        document.body.classList.remove("quick-start-mode");
        shell.classList.add("hidden");
        byId("overview-primary").classList.add("secondary");
        return;
      }
      document.body.classList.add("quick-start-mode");
      shell.classList.remove("hidden");
      byId("overview-primary").classList.add("secondary");
      const candidateResources=instantOnboarding.candidate?.pack?.resources||[];
      const resource=candidateResources[0];
      if(!resource){
        byId("instant-authority").innerHTML='<div class="band notice">Runner could not identify a conservative starter resource. Continue with the full review below.</div>';
        byId("run-instant").disabled=true;
        return;
      }
      const first=instantOnboarding.first_value;
      if(!first){
        byId("instant-authority").innerHTML='<div class="band notice">Runner could not construct one exact starter question without guessing. Continue with full review.</div>';
        byId("run-instant").disabled=true;
        return;
      }
      const allResources=original?.pack?.resources||[];
      const totalAreas=Math.max(Number(reviewReport?.summary?.objects||0),allResources.length);
      const includedResourceCount=candidateResources.length;
      const otherResources=Math.max(0,totalAreas-includedResourceCount);
	      const inspectedKinds=reviewedCollectionLabel();
      const includedIds=new Set(candidateResources.map(item=>item.id));
      const outsideReviews=(reviewReport?.resources||[]).filter(item=>!includedIds.has(item.id));
      const inspectedKindLabel=totalAreas===1
        ?reviewedResourceKind((reviewReport?.resources||[])[0]?.id)
        :inspectedKinds;
      const outsideKindLabel=otherResources===1
        ?reviewedResourceKind(outsideReviews[0]?.id)
        :reviewedCollectionLabel(outsideReviews);
	      const fieldAccess=totalReviewedFieldAccess(candidateResources);
	      const visibleCount=fieldAccess.visible;
	      const runnerOnlyCount=fieldAccess.runnerOnly;
	      const hiddenCount=fieldAccess.keptOut;
      const relationshipCount=candidateResources.reduce((total,item)=>total+(item.relationships||[]).length,0);
      const includedLabels=candidateResources.map(item=>humanizeIdentifier(item.table||item.id.split(".").pop()||item.id));
      const resourceLabel=includedResourceCount===1
        ?includedLabels[0]
        :includedResourceCount+" connected tables";
      const tenantSource=instantOnboarding.tenant_scope_source;
      const tenantLabel=tenantSource==="postgres_role_setting"
        ?"Tenant fixed by read-only database login"
        :tenantSource==="reviewed_organization"
          ?"Whole reviewed organization ("+instantOnboarding.candidate.organization_scope.organization_id+"); no tenant filter"
        :"Tenant from your app";
      const scopeLabel=String(first.principal_scope).startsWith("not required")
        ?tenantLabel
        :tenantLabel+"; principal from your app";
	      const includedSummary=includedLabels.slice(0,5).join(" · ");
	      const hiddenSummary=hiddenCount+" field"+(hiddenCount===1?"":"s")+(otherResources?" · "+otherResources+" table"+(otherResources===1?"":"s")+" outside":"");
	      byId("instant-authority").innerHTML=
          '<div class="instant-boundary-head"><div><span class="instant-kicker">What crosses the boundary</span><h3>'+esc(resourceLabel)+'</h3><code>'+esc(instantOnboarding.candidate.pack.name)+'</code></div><span class="instant-badge">Disabled</span></div>'
	          +'<div class="instant-flow"><svg viewBox="0 0 620 190" role="img" aria-label="'+esc(totalAreas+' inspected '+inspectedKinds+'. '+includedResourceCount+' connected tables are proposed for the starter boundary and '+otherResources+' remain outside it.')+'">'
            +'<path class="instant-flow-base" d="M126 94 H230"/><path class="instant-flow-base" d="M390 94 H494"/>'
            +'<path class="instant-flow-active" d="M126 94 H230"/><path class="instant-flow-active" d="M390 94 H494"/>'
            +'<path class="instant-flow-base" d="M126 129 C178 129 190 166 232 166"/>'
            +'<rect class="instant-flow-node" x="16" y="50" width="110" height="88" rx="18"/>'
            +'<ellipse cx="71" cy="77" rx="19" ry="8" fill="none" stroke="#7c8b84" stroke-width="2"/>'
            +'<path d="M52 77 V103 C52 108 60 112 71 112 C82 112 90 108 90 103 V77" fill="none" stroke="#7c8b84" stroke-width="2"/>'
            +'<path d="M52 90 C52 95 60 99 71 99 C82 99 90 95 90 90" fill="none" stroke="#7c8b84" stroke-width="1.5"/>'
	            +'<text x="71" y="130" text-anchor="middle" font-size="10" class="instant-svg-muted">'+esc(totalAreas)+' '+esc(inspectedKindLabel.toUpperCase())+'</text>'
            +'<rect class="instant-flow-core" x="230" y="30" width="160" height="118" rx="26"/>'
            +'<circle cx="310" cy="55" r="7" fill="#75e3b7" opacity=".2"/><circle cx="310" cy="55" r="3.5" fill="#75e3b7"/>'
            +'<text x="310" y="78" text-anchor="middle" font-size="10" font-weight="700" class="instant-svg-muted">REVIEWED BOUNDARY</text>'
	            +'<text x="310" y="103" text-anchor="middle" font-size="18" font-weight="700">'+esc(includedResourceCount)+' TABLE'+esc(includedResourceCount===1?'':'S')+'</text>'
            +'<text x="310" y="124" text-anchor="middle" font-size="10" class="instant-svg-muted">EXACTLY SCOPED</text>'
            +'<rect class="instant-flow-node" x="494" y="50" width="110" height="88" rx="18"/>'
            +'<path d="M549 69 L553 82 L566 86 L553 90 L549 103 L545 90 L532 86 L545 82 Z" class="instant-svg-accent"/>'
            +'<text x="549" y="124" text-anchor="middle" font-size="12" font-weight="700">YOUR AI</text>'
            +'<rect class="instant-flow-muted" x="235" y="157" width="150" height="26" rx="13"/>'
	            +'<text x="310" y="174" text-anchor="middle" font-size="10" class="instant-svg-muted">'+esc(otherResources)+' '+esc(outsideKindLabel.toUpperCase())+' NOT INCLUDED</text>'
          +'</svg></div>'
          +'<div class="instant-facts">'
	          +'<div class="instant-fact"><strong>Included tables</strong><p>'+esc(includedSummary)+'</p></div>'
	          +'<div class="instant-fact"><strong>Reviewed access</strong><p>'+esc(visibleCount)+' model-visible field'+esc(visibleCount===1?'':'s')+' · '+esc(runnerOnlyCount)+' Runner-only · '+esc(relationshipCount)+' relationship'+esc(relationshipCount===1?'':'s')+'</p></div>'
            +'<div class="instant-fact"><strong>Scope</strong><p>'+esc(scopeLabel)+'<br><span class="muted">The model cannot change it</span></p></div>'
	            +'<div class="instant-fact"><strong>Never crosses</strong><p>'+esc(hiddenSummary)+'</p></div>'
	            +'<div class="instant-fact"><strong>Result limits</strong><p>Return up to '+esc(first.maximum_groups)+' groups · ranked questions consider up to '+esc(candidate.budgets.max_ranked_groups??candidate.budgets.max_groups)+' · groups below '+esc(first.minimum_cohort_size)+' withheld</p></div>'
	            +'<div class="instant-fact"><strong>Human decision</strong><p>Review this exact boundary once</p></div>'
	          +'</div>'
	        +'<div class="instant-preview"><span class="instant-preview-icon" aria-hidden="true">→</span><div><strong>Your first exact question</strong><p>“'+esc(first.question)+'”</p><small>Runner validated this question against the proposed boundary</small></div></div>';
      updateInstantAction();
    }

    function updateInstantAction(){
      const button=byId("run-instant");
      const missing=instantOnboarding?.missing_bindings||[];
      const scopeError=instantOnboarding?.scope_error||"";
      const status=byId("instant-status");
      button.textContent=missing.length||scopeError
        ?"Resolve trusted scope first →"
        :"Review and start asking →";
      button.disabled=!instantOnboarding?.eligible;
      button.setAttribute("aria-describedby","instant-status");
      status.className=missing.length||scopeError?"status-message blocked":"status-message";
      status.textContent=scopeError
        ?scopeError+" No analytical authority is active."
        :missing.length
        ?"Configure "+missing.join(" and ")+" through your application identity, then reopen Quick Start. No analytical authority is active."
        :"";
    }

    async function runInstantOnboarding(){
      const button=byId("run-instant");
      const status=byId("instant-status");
      const nextSurface="model";
      button.disabled=true;
      status.className="status-message";
      status.textContent="Rechecking the read-only role, exact schema, and trusted scope before activating this boundary...";
      try{
		        const payload=await post("/api/instant/activate",{
	            next_surface:nextSurface
	        });
		      activeBoundary=payload.active;
		      activeBoundaries=[payload.active];
		      boundaryLibrary=payload.boundary_library||{selected_name:candidate.pack.name,entries:[]};
        instantOnboarding.eligible=false;
        accessBaselineColumns=null;
        await load();
        byId("header-state").textContent="Reviewed access active";
        byId("header-state").className="state good";
        byId("overview-notice").className="band success";
        byId("overview-notice").textContent="The conservative local read boundary is active. No source rows have been read yet.";
        byId("journey-state").innerHTML='<div><strong>'+esc(payload.next_action)+'</strong><p>Agent data access active: yes · Source rows read: no · Source database changed: no</p></div><span class="badge good">Narrow read active</span>';
        byId("instant-result").innerHTML="";
        document.querySelector('[data-view="activate"]').classList.add("done");
        if(payload.next_surface==="existing_client")openExistingClientAnalysis();
        else if(payload.next_surface==="no_model")openNoModelAnalysis();
        else openModelFirstAnalysis();
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
        button.disabled=false;
      }
    }

    function openModelFirstAnalysis(){
      document.body.classList.remove("quick-start-mode");
      document.body.classList.add("ask-focus-mode");
      focusAskAfterLoad=true;
      openNoModelAfterLoad=false;
      openClientAfterLoad=false;
      setView("explore");
    }

    function openExistingClientAnalysis(){
      document.body.classList.remove("quick-start-mode");
      document.body.classList.add("ask-focus-mode");
      focusAskAfterLoad=false;
      openNoModelAfterLoad=false;
      openClientAfterLoad=true;
      setView("explore");
    }

    function openNoModelAnalysis(){
      document.body.classList.remove("quick-start-mode");
      document.body.classList.add("ask-focus-mode");
      focusAskAfterLoad=false;
      openNoModelAfterLoad=true;
      openClientAfterLoad=false;
      setView("explore");
    }

    function revealExistingClientSetup(){
      if(byId("explorer").classList.contains("hidden")){
        openClientAfterLoad=true;
        return;
      }
      document.body.classList.remove("no-model-focus");
      const setup=byId("external-client-setup");
      setup.open=true;
      setup.scrollIntoView({behavior:"auto",block:"start"});
      setup.querySelector("summary")?.focus();
    }

    function revealNoModelComposer(){
      if(byId("explorer").classList.contains("hidden")){
        openNoModelAfterLoad=true;
        return;
      }
      document.body.classList.add("no-model-focus");
      const content=byId("no-model-content");
      content.classList.remove("hidden");
      byId("explore-composer").open=true;
      byId("open-no-model").textContent="No-model composer open";
      byId("open-no-model").disabled=true;
      content.scrollIntoView({behavior:"auto",block:"start"});
    }

    function setView(view,historyMode="push"){
      if(!validViews.has(view))view="overview";
	      const previousView=currentView;
	      currentView=view;
	      document.body.classList.toggle("ask-focus-mode",view==="explore"&&activeBoundaries.length>0);
	      document.body.classList.toggle("ask-result-mode",view==="explore"&&Boolean(document.querySelector("#ask-transcript .ask-turn.answer, #ask-transcript .ask-turn.error")));
	      document.body.classList.toggle("access-focus-mode",view==="exceptions");
	      if(view!=="explore")document.body.classList.remove("no-model-focus");
	      document.querySelectorAll(".view").forEach(node=>node.classList.toggle("active",node.id==="view-"+view));
	      document.querySelectorAll(".step").forEach(node=>node.classList.toggle("active",node.dataset.view===(view==="exceptions"?"overview":view)));
		      if(view==="exceptions"){
		        if(!selectedResource){
		          selectedResource=(reviewReport?.resources||[])
		            .find(resource=>resource.status!=="draft_read")?.id
		            ||(reviewReport?.resources||[])
		            .find(resource=>riskCount({id:resource.id})>0)?.id
		            ||(reviewReport?.resources||[])[0]?.id
		            ||null;
	        }
	        renderResourceNavigation();
	        renderResourceDetail();
	      }
      if(view==="activate")renderSignoff();
      if(view==="explore"){
        if(activeBoundaries.length)runPreflight();
        loadAskStatus();
      }
      if(view==="protect")loadProtect();
      if(view==="action")loadGuidedAction();
      const historyState={
        synapsor_view:view,
        ...(view==="exceptions"&&selectedResource?{selected_resource:selectedResource}:{})
      };
      if(viewHistoryReady&&historyMode==="push"&&previousView!==view){
        history.pushState(historyState,"","#"+view);
      }else if(historyMode==="replace"){
        history.replaceState(historyState,"","#"+view);
      }
      window.scrollTo({top:0,behavior:"auto"});
    }

    function initializeViewHistory(){
      const stateView=history.state?.synapsor_view;
      const hashView=workbenchHashView();
      const requested=validViews.has(stateView)
        ?stateView
        :validViews.has(hashView)
          ?hashView
          :activeBoundary
            ?"explore"
            :"overview";
      const requestedResource=history.state?.selected_resource;
      selectedResource=requested==="exceptions"
        && typeof requestedResource==="string"
        && Boolean(reviewResource(requestedResource))
        ?requestedResource
        :null;
      viewHistoryReady=true;
      setView(requested,"replace");
    }

    window.addEventListener("popstate",event=>{
      const stateView=event.state?.synapsor_view;
      const hashView=workbenchHashView();
      const requested=validViews.has(stateView)?stateView:validViews.has(hashView)?hashView:"overview";
      const requestedResource=event.state?.selected_resource;
      selectedResource=requested==="exceptions"
        && typeof requestedResource==="string"
        && Boolean(reviewResource(requestedResource))
        ?requestedResource
        :null;
      setView(requested,"none");
    });

    function workbenchHashView(){
      const raw=location.hash.slice(1);
      if(!raw)return "";
      const separator=raw.indexOf("?");
      const encodedView=separator>=0?raw.slice(0,separator):raw;
      let view="overview";
      try{view=decodeURIComponent(encodedView||"overview")}catch{}
      if(view==="protect"&&separator>=0){
        const params=new URLSearchParams(raw.slice(separator+1));
        const queryRef=params.get("query_ref");
        const capability=params.get("capability");
        if(/^A[1-9][0-9]*$/.test(queryRef||""))preferredProtectQueryRef=queryRef;
        if(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(capability||""))preferredProtectedCapability=capability;
      }
      return view;
    }

    function authorityCount(resource,key){
      if(key==="filterable_fields"||key==="time_bucket_fields")return Object.keys(resource[key]||{}).length;
      return (resource[key]||[]).length;
    }

	    function riskCount(source){
	      const review=reviewResource(source.id);
	      return outstandingResourceDecisions(source.id).length+(review?.blockers||[]).length;
	    }

	    function accessNavigationRiskRank(id){
	      const review=reviewResource(id);
	      if(!review)return 0;
	      const sensitive=(review.fields||[]).filter(field=>
	        field.sensitivity?.state!=="structurally_low_risk").length;
	      return (review.status!=="draft_read"?10000:0)+(review.blockers||[]).length*100+sensitive;
	    }

	    function sensitiveKeptOutCount(id){
	      const resource=currentResource(id);
	      const review=reviewResource(id);
	      if(!resource||!review)return 0;
	      return (review.fields||[]).filter(field=>
	        field.sensitivity?.state!=="structurally_low_risk"
	        &&resource.kept_out_fields.includes(field.name)
	      ).length;
	    }

    function blockedResourceNextAction(review){
      if(!review.primary_key?.selected){
        const candidates=review.primary_key?.candidates||[];
        return candidates.length
          ?"Choose the source-proven record ID for "+review.id+"."
          :"Add a single-column primary or unique key, then rescan "+review.id+".";
      }
      if(!candidate?.organization_scope&&!review.tenant_key?.selected&&!review.derived_tenant_scope?.selected){
        const guidance=review.scope_resolution_guidance;
        if(guidance?.remediation?.length)return guidance.remediation.join(" ");
        const candidates=review.tenant_key?.candidates||[];
        const paths=[...(review.derived_tenant_scope?.candidates||[])].sort((left,right)=>(left.proof?.links?.length||0)-(right.proof?.links?.length||0)||left.path_id.localeCompare(right.path_id));
        if(paths.length){
          const path=paths[0];
          const depth=path.proof?.links?.length||1;
          const reviewedDepth=Number(candidate?.budgets?.max_derived_scope_hops??candidate?.budgets?.max_relationship_hops??2);
          if(depth>reviewedDepth){
            return "A proven "+depth+"-hop tenant path is shown above. Raise Derived-scope depth from "+reviewedDepth+" to "+depth+" in Settings → Result shape, timeout, and path depth, then choose it.";
          }
          return "Choose the proven tenant path shown above.";
        }
        if(review.shared_reference_scope?.eligible){
          return "Choose a direct customer-isolation option, or explicitly review Shared reference only if "+review.id+" has the same rows for every tenant.";
        }
        return candidates.length
          ?"Choose the direct customer-isolation column or mandatory proven relationship path for "+review.id+"."
          :"Add or identify a trusted customer-isolation column, then rescan "+review.id+".";
      }
      return "Open this "+reviewedResourceKind(review.id)+" and resolve its remaining scope blocker.";
    }

    function derivedScopePathLabel(scope){
      return scope?"mandatory relationship path "+derivedScopePathChain(scope):"unresolved";
    }

    function derivedScopePathChain(scope){
      if(!scope)return "unresolved";
      const links=scope.proof?.links||[];
      const resources=[];
      if(links[0]?.source_resource)resources.push(links[0].source_resource);
      links.forEach(link=>{
        if(resources.at(-1)!==link.source_resource)resources.push(link.source_resource);
        if(resources.at(-1)!==link.target_resource)resources.push(link.target_resource);
      });
      if(resources.at(-1)!==scope.ancestor_resource)resources.push(scope.ancestor_resource);
      if(!resources.length)resources.push(scope.ancestor_resource);
      const namespaces=resources.map(resource=>{const separator=resource.lastIndexOf(".");return separator>0?resource.slice(0,separator):null;});
      const commonNamespace=namespaces[0]&&namespaces.every(namespace=>namespace===namespaces[0])?namespaces[0]:null;
      const shown=resources.map(resource=>commonNamespace?resource.slice(commonNamespace.length+1):resource.startsWith("public.")?resource.slice(7):resource);
      shown[shown.length-1]=shown.at(-1)+"."+scope.ancestor_column;
      return shown.join(" → ");
    }

    function derivedScopeJoinColumns(scope){
      const links=scope?.proof?.links||[];
      if(!links.length||links.some(link=>!link.source_columns?.length))return "";
      return links.map(link=>link.source_columns.join(", ")).join(" → ");
    }

    function derivedScopeCostAdvisory(scope){
      const depth=scope?.proof?.links?.length||0;
      if(!depth)return "";
      const review=reviewResource(selectedResource);
      const rows=Number.isFinite(review?.approximate_row_count)?Number(review.approximate_row_count):null;
      const timeout=Number(candidate?.budgets?.statement_timeout_ms||3000);
      const rowHops=rows===null?null:rows*depth;
      const pressure=depth>=3||(rowHops!==null&&rowHops>=500000);
      const reviewedDepth=Number(candidate?.budgets?.max_derived_scope_hops??candidate?.budgets?.max_relationship_hops??2);
      return '<div class="band '+(pressure?'warning':'notice')+'"><strong>Derived-scope cost advisory</strong><p>'+esc(depth)+' mandatory many-to-one hop'+(depth===1?'':'s')+' under the reviewed '+esc(timeout.toLocaleString())+' ms statement timeout.</p>'
        +(rows===null
          ?'<p>Catalog row volume is unavailable. Doctor can still attest path indexes.</p>'
          :'<p>The catalog estimates about '+esc(rows.toLocaleString())+' total root rows ('+esc(rowHops.toLocaleString())+' row-hops before selectivity). This is not a tenant count or latency prediction.</p>')
        +(depth>reviewedDepth?'<p><strong>Raise Derived-scope depth to '+esc(depth)+' in Settings → Result shape, timeout, and path depth before saving this path.</strong></p>':'')
        +(pressure?'<p>Run doctor to verify every path index. For high-volume leaves, a direct tenant/principal column is usually faster. Measured source time appears in query details.</p>':'')
        +'</div>';
    }

    function derivedScopeStartGuidance(scope){
      const links=scope?.proof?.links||[];
      const chain=links.length?[links[0].source_resource,...links.map(link=>link.target_resource)]:[scope.ancestor_resource];
      if(chain.at(-1)!==scope.ancestor_resource)chain.push(scope.ancestor_resource);
      const sequence=[...new Set(chain)].reverse();
      const ancestor=sequence[0]||scope.ancestor_resource;
      const intermediate=sequence.slice(1,-1);
      return "start with "+ancestor+(intermediate.length?", then add "+intermediate.join(", then "):"")+", then add this table";
    }

    function firstTableState(resource,generatedStartingIds){
      const generated=resource.status==="draft_read"&&generatedStartingIds.has(resource.id);
      if(resource.status==="blocked_role"||(!resource.primary_key?.selected&&!resource.primary_key?.candidates?.length))return {kind:"unavailable",reason:resource.blockers?.[0]||"record identity or database-role posture is unresolved"};
      const requiredScopes=[];
      if(!candidate.organization_scope&&!resource.tenant_key?.selected&&!resource.tenant_key?.candidates?.length){
        const tenantScope=resource.derived_tenant_scope?.selected||resource.derived_tenant_scope?.candidates?.[0];
        if(tenantScope)requiredScopes.push(tenantScope);
      }
      if(!resource.principal_key?.selected&&resource.derived_principal_scope?.selected){
        requiredScopes.push(resource.derived_principal_scope.selected);
      }
      if(requiredScopes.length)return {kind:"ancestor",reason:requiredScopes.map(scope=>derivedScopeStartGuidance(scope)+" ("+derivedScopePathLabel(scope)+")").join("; ")};
      if(candidate.organization_scope)return {kind:"startable"};
      if(resource.tenant_key?.selected||resource.tenant_key?.candidates?.length)return generated?{kind:"startable"}:{kind:"unavailable",reason:resource.blockers?.[0]||"structural review required"};
      if(resource.shared_reference_scope?.eligible)return {kind:"shared_reference",reason:"start with a tenant-scoped table, then add this table and confirm Shared reference for this boundary"};
      return generated?{kind:"startable"}:{kind:"unavailable",reason:resource.blockers?.[0]||"structural review required"};
    }

    function reviewedTenantScopeLabel(resource,review){
      if(candidate?.organization_scope)return "whole reviewed organization ("+candidate.organization_scope.organization_id+"); no tenant filter";
      if(resource?.tenant_key)return "direct column "+resource.tenant_key;
      if(resource?.shared_reference_scope)return "Shared reference; no tenant predicate";
      const scope=resource?.tenant_scope||review?.derived_tenant_scope?.selected;
      return scope?derivedScopePathLabel(scope):"unresolved";
    }

    function reviewedPrincipalScopeLabel(resource,review){
      if(resource?.principal_key)return "direct column "+resource.principal_key;
      const scope=resource?.principal_scope||review?.derived_principal_scope?.selected;
      return scope?derivedScopePathLabel(scope):"not required";
    }

		    function renderSummary(){
	      const summary=reviewReport.summary;
	      const includedIds=new Set(candidate.pack.resources.map(resource=>resource.id));
	      const tableSignoffs=candidate.pack.resources.filter(resource=>
	        outstandingResourceDecisions(resource.id).length>0
	      ).length;
	      const boundarySignoffs=globalDecisions().some(decision=>!confirmedDecisions.has(decision))?1:0;
	      const unresolvedSignoffs=tableSignoffs+boundarySignoffs;
	      const fieldAccess=totalReviewedFieldAccess(candidate.pack.resources);
	      const exposed=fieldAccess.visible;
	      const hidden=fieldAccess.runnerOnly+fieldAccess.keptOut;
      byId("summary").innerHTML=[
	        [candidate.pack.resources.length,reviewedCollectionLabel()+" included"],
	        [exposed,"fields the agent can see"],
	        [hidden,"fields hidden from the agent"],
	        [unresolvedSignoffs,"review sign-offs remaining"]
	      ].map(item=>'<div class="metric"><strong>'+esc(item[0])+'</strong><span>'+esc(item[1])+'</span></div>').join("");
	      const tenantResources=candidate.organization_scope
	        ?reviewReport.resources||[]
	        :(reviewReport.resources||[]).filter(resource=>
	          resource.tenant_key?.selected||resource.derived_tenant_scope?.selected);
	      const sharedReferenceResources=candidate.organization_scope
	        ?[]
	        :(reviewReport.resources||[]).filter(resource=>resource.shared_reference_scope?.eligible);
	      const principalResources=(reviewReport.resources||[]).filter(resource=>
	        resource.principal_key?.selected||resource.derived_principal_scope?.selected);
	      const tenantResolved=tenantResources.length;
	      const sharedReferenceReviewable=sharedReferenceResources.length;
	      const principalResolved=principalResources.length;
	      const collectionLabel=reviewedCollectionLabel();
		      byId("resources-heading").textContent=collectionLabel==="tables"
		        ?"Table details"
		        :"Table and view details";
	      byId("resource-navigation-shell").setAttribute("aria-label",collectionLabel.replace(/\\b\\w/g,char=>char.toUpperCase())+" navigation");
	      byId("resource-search-label").textContent="Find a "+(collectionLabel==="tables"?"table":"table or view");
	      byId("resource-search").placeholder="Search "+collectionLabel;
			      byId("database-summary").innerHTML='<h3>Database connected</h3><p><strong>'+esc(String(reviewReport.engine||"database").toUpperCase())+'</strong> · read role <code>'+esc(reviewReport.database_role?.name||"unknown")+'</code> · '+esc(summary.objects)+' '+esc(collectionLabel)+' inspected.</p><p>'+esc(summary.draft_reads)+' can be reviewed now; '+esc(summary.blocked_objects)+' stay unavailable. '+(candidate.organization_scope?'Whole-organization access is explicitly reviewed for <code>'+esc(candidate.organization_scope.organization_id)+'</code>; no tenant predicate is applied.':'Customer isolation was detected for '+esc(tenantResolved)+' '+esc(reviewedCollectionLabel(tenantResources))+'. '+esc(sharedReferenceReviewable)+' '+esc(reviewedCollectionLabel(sharedReferenceResources))+' may instead be explicitly reviewed as Shared reference.')+' Per-user row limits were detected for '+esc(principalResolved)+' '+esc(reviewedCollectionLabel(principalResources))+'. '+esc(summary.sensitive_fields_kept_out)+' sensitive field(s) were hidden conservatively across the inspected schema.</p>';
		    }

		    function renderBoundaryOverview(){
		      const panel=byId("boundary-overview");
		      if(!panel||!candidate||!original||!reviewReport)return;
		      const generatedStartingIds=new Set(original.pack.resources.map(resource=>resource.id));
		      const inspectedStartingTables=(reviewReport.resources||[])
		        .slice()
		        .sort((left,right)=>Number(firstTableState(left,generatedStartingIds).kind!=="startable")-Number(firstTableState(right,generatedStartingIds).kind!=="startable")||Number(left.status!=="draft_read")-Number(right.status!=="draft_read")||left.id.localeCompare(right.id));
		      const startingTableStates=new Map(inspectedStartingTables.map(resource=>[resource.id,firstTableState(resource,generatedStartingIds)]));
		      const eligibleStartingTables=inspectedStartingTables.filter(resource=>startingTableStates.get(resource.id)?.kind==="startable");
		      const sequencedStartingTables=inspectedStartingTables.filter(resource=>["ancestor","shared_reference"].includes(startingTableStates.get(resource.id)?.kind));
		      const startingTableOptions=inspectedStartingTables
		        .map(resource=>{
		          const state=startingTableStates.get(resource.id);
		          const eligible=state?.kind==="startable";
		          const suffix=state?.kind==="ancestor"?' - start from ancestor: '+state.reason:state?.kind==="shared_reference"?' - add after scoped table: '+state.reason:state?.kind==="unavailable"?' - unavailable: '+state.reason:'';
		          return '<option value="'+esc(eligible?resource.id:"")+'" '+(eligible?'':'disabled')+'>'+esc(humanizeIdentifier(resource.id.split(".").pop()||resource.id)+suffix)+'</option>';
		        })
		        .join("");
		      const activeIds=new Set(activeBoundaries.flatMap(boundary=>(boundary?.pack?.resources||[]).map(resource=>resource.id)));
		      const activeBoundaryName=activeBoundary?.pack?.name;
		      const entries=(boundaryLibrary?.entries||[]).length
		        ?boundaryLibrary.entries
		        :[{name:candidate.pack.name,selected:true,active:activeBoundaryName===candidate.pack.name,matches_active_digest:activeBoundaryName===candidate.pack.name,table_count:candidate.pack.resources.length,outstanding_decisions:candidate.unresolved_decisions.length-confirmedDecisions.size}];
		      const rows=entries.map(entry=>{
		        const status=entry.policy_review_required
		          ?"Legacy policy review needed"
		          :entry.active
		          ?entry.matches_active_digest?"Active":"Active + draft edits"
		          :entry.outstanding_decisions>0?"Disabled draft":"Reviewed · not active";
		        const action=entry.selected
		          ?'<button class="secondary" data-open-boundary="'+esc(entry.name)+'" type="button">Edit</button>'
		          :'<button class="secondary" data-open-boundary="'+esc(entry.name)+'" type="button">Open</button>';
		        const deletion=!entry.active&&entries.length>1
		          ?'<button class="quiet" data-delete-boundary="'+esc(entry.name)+'" type="button">Delete</button>'
		          :'';
		        return '<tr class="'+(entry.selected?'selected-boundary':'')+'"><td><strong>'+esc(entry.name)+'</strong>'+(entry.selected?'<small>Selected for editing</small>':'')+'</td><td>'+esc(status)+'</td><td>'+esc(entry.table_count)+'</td><td>'+(entry.active?'<span class="badge good">Active Explore</span>':'<span class="badge">No authority</span>')+'</td><td><div class="actions boundary-row-actions">'+action+deletion+'</div></td></tr>';
		      }).join("");
		      const selectedEntry=entries.find(entry=>entry.name===boundaryLibrary.selected_name);
		      const databaseProduct=databaseServerCompatibility?.engine==="postgres"?"PostgreSQL":"MySQL";
		      const databaseDetectedVersion=String(databaseServerCompatibility?.detected_version||"");
		      const databaseVersionLabel=databaseDetectedVersion.toLowerCase().startsWith(databaseProduct.toLowerCase())
		        ?databaseDetectedVersion
		        :databaseProduct+' '+databaseDetectedVersion;
		      const databaseCompatibilitySummary=databaseServerCompatibility
		        ?'<div class="database-compatibility-summary"><span class="badge '+(databaseServerCompatibility.tier==="full"?'good':databaseServerCompatibility.tier==="compatible_limited"?'warn':'bad')+'">'+(databaseServerCompatibility.tier==="full"?'Full reviewed grammar':databaseServerCompatibility.tier==="compatible_limited"?'Supported limited grammar':'Unsupported source')+'</span><span><strong>Reviewed source release:</strong> '+esc(databaseVersionLabel)+(databaseServerCompatibility.authority?.version_line?' · reviewed release line '+esc(databaseServerCompatibility.authority.version_line):'')+'</span></div>'
		        :'';
		      const selectedRescanEntry=(boundaryRescanReport?.boundaries||[]).find(entry=>
		        entry.boundary_name===selectedEntry?.name&&entry.candidate_digest===selectedEntry?.candidate_digest);
		      const rescanDetails=selectedRescanEntry
		        ?[
		          ...(selectedRescanEntry.invalidated_decisions||[]).map(item=>item.id+": "+(item.reason==="decision_removed"?"reviewed input no longer exists":"reviewed input changed")),
		          ...(selectedRescanEntry.changed_field_types||[]).map(item=>item.resource_id+"."+item.field+": reviewed column type changed"),
		          ...(selectedRescanEntry.removed_fields||[]).map(item=>item.resource_id+"."+item.field+": reviewed column was removed"),
		          ...(selectedRescanEntry.newly_available_fields||[]).map(item=>item.resource_id+"."+item.field+": new column is kept out until reviewed"),
			          ...(selectedRescanEntry.newly_available_relationships||[]).map(item=>rescanRelationshipDetail(item,"new")),
		          ...(selectedRescanEntry.newly_proven_value_allowlists||[]).map(item=>item.resource_id+"."+item.field+": an enforced schema vocabulary now narrows existing filter/group authority to "+item.value_count+" reviewed values; confirm field permissions, then activate"),
		          ...(selectedRescanEntry.pruned_review_inputs||[])
		        ]
		        :[];
		      const rescanExplanation=selectedRescanEntry
			        ?'<p>Rescan preserved '+esc(rescanPreservedAuthorityText(selectedRescanEntry))+'; '+esc((selectedRescanEntry.invalidated_decisions||[]).length)+' prior '+((selectedRescanEntry.invalidated_decisions||[]).length===1?'decision was':'decisions were')+' invalidated. Review and activate this new exact revision separately.</p>'+(rescanDetails.length?'<ul>'+rescanDetails.slice(0,8).map(detail=>'<li>'+rescanDetailMarkup(detail)+'</li>').join("")+(rescanDetails.length>8?'<li>+'+esc(rescanDetails.length-8)+' more changes are available in this review.</li>':'')+'</ul>':'')
		        :'';
		      const pendingBoundaryChange=Boolean(selectedEntry&&(selectedEntry.policy_review_required||!selectedEntry.active||!selectedEntry.matches_active_digest));
			      const pendingBoundaryBanner=pendingBoundaryChange
			        ?selectedEntry.policy_review_required
			          ?'<div class="band notice"><strong>Legacy boundary policy needs review</strong><p>Runner preserved this boundary&apos;s exact revision and did not assign ambiguous project-wide settings to it. Open and save a reviewed setting, or Rescan, before activation.</p></div>'
		          :'<div class="band notice"><strong>1 pending boundary change is not active</strong><p>'+(selectedEntry.active?'Ask still uses the previous exact reviewed revision.':'This disabled boundary grants no Ask access yet.')+'</p>'+rescanExplanation+'<button id="review-pending-boundary" type="button">Review and activate now</button></div>'
			        :'';
			      const lifecycleControls='<div class="actions"><button id="edit-boundary-tables" '+(pendingBoundaryChange?'class="secondary" ':'')+'type="button">Edit selected boundary</button><button id="new-boundary" class="secondary" type="button">New boundary</button>'+(selectedEntry?.active?'<button id="disable-active-boundary" class="quiet" type="button">Deactivate selected boundary</button>':'<button id="disable-active-boundary" class="quiet" type="button" disabled title="The selected boundary is not active.">Selected boundary inactive</button>')+'</div>';
		      const rankedMinimum=candidate.budgets.max_groups;
		      const rankedCurrent=candidate.budgets.max_ranked_groups??rankedMinimum;
			      const rankedMaximum=reviewedBudgetCeilings.max_ranked_groups;
			      const rankedEditable=true;
			      const rankedSettings='<details class="boundary-options"><summary>Ranked result settings</summary><div class="boundary-name-editor"><label>Groups considered before ranking<input id="boundary-ranked-groups" type="number" min="'+esc(rankedMinimum)+'" max="'+esc(rankedMaximum)+'" value="'+esc(rankedCurrent)+'" '+(rankedEditable?'':'disabled')+' aria-describedby="boundary-ranked-help"></label><button id="save-ranked-groups" class="secondary" type="button" '+(rankedEditable?'':'disabled')+'>Save reviewed limit</button><span id="boundary-ranked-status" class="status-message" aria-live="polite"></span><small id="boundary-ranked-help">Top, bottom, and period-mover questions may consider this many groups. Small-group suppression runs before ranking, and only the reviewed top '+esc(candidate.budgets.max_top_n)+' may be returned. The AI cannot change this setting.</small></div></details>';
			      const volumeSettings='<details class="boundary-options"><summary>Query volume · '+esc(candidate.budgets.max_queries_per_session)+' per rolling 24 hours · '+esc(candidate.budgets.rate_limit_per_minute)+' per minute</summary><div class="boundary-name-editor"><p><strong>Throughput controls</strong> limit how often this boundary can run for one trusted scope. They do not replace the separate disclosure controls for extracted cells, differencing, or small groups.</p><label>Queries per rolling 24 hours<input id="boundary-query-volume" type="number" min="1" max="1000" value="'+esc(candidate.budgets.max_queries_per_session)+'" aria-describedby="boundary-volume-help"></label><label>Requests per rolling minute<input id="boundary-request-rate" type="number" min="1" max="120" value="'+esc(candidate.budgets.rate_limit_per_minute)+'" aria-describedby="boundary-volume-help"></label><button id="save-boundary-volume" class="secondary" type="button">Save reviewed limits</button><span id="boundary-volume-status" class="status-message" aria-live="polite"></span><small id="boundary-volume-help">These limits are reviewed and digest-bound. Saving creates a disabled boundary revision; Review and activate remains separate. Disclosure defaults and semantics are unchanged.</small></div></details>';
			      const shapeFields=[
			        {key:'max_rows',label:'Returned rows',unit:'rows',min:1},
			        {key:'max_groups',label:'Aggregate groups',unit:'groups',min:candidate.budgets.max_top_n},
			        {key:'max_top_n',label:'Returned top N',unit:'groups',min:1,max:Math.min(reviewedBudgetCeilings.max_top_n,candidate.budgets.max_groups)},
			        {key:'max_measures',label:'Measures per aggregate',unit:'measures',min:1},
			        {key:'max_dimensions',label:'Dimensions per aggregate',unit:'dimensions',min:1},
			        {key:'max_response_cells',label:'Response cells',unit:'cells',min:1},
			        {key:'max_response_bytes',label:'Response bytes',unit:'bytes',min:1024},
			        {key:'statement_timeout_ms',label:'Statement timeout',unit:'milliseconds',min:100},
			        {key:'max_derived_scope_hops',label:'Derived-scope depth',unit:'proven hops',min:1,max:3,value:candidate.budgets.max_derived_scope_hops??candidate.budgets.max_relationship_hops},
			        {key:'max_analysis_relationship_hops',label:'Analysis-path depth',unit:'proven hops',min:1,max:3,value:candidate.budgets.max_analysis_relationship_hops??candidate.budgets.max_relationship_hops}
			      ];
			      const shapeInputs=shapeFields.map(field=>'<label>'+esc(field.label)+'<input id="boundary-shape-'+esc(field.key)+'" type="number" min="'+esc(field.min)+'" max="'+esc(field.max??reviewedBudgetCeilings[field.key])+'" value="'+esc(field.value??candidate.budgets[field.key])+'" aria-describedby="boundary-shape-help"><small>'+esc(field.unit)+'</small></label>').join('');
			      const shapeSettings='<details class="boundary-options"><summary>Result shape, timeout, and path depth</summary><div class="boundary-name-editor"><p><strong>Reviewed execution controls</strong> bound one result and the proven relationship paths Runner may compile. Three-hop traversal is opt-in and can be materially slower than direct tenant columns.</p>'+shapeInputs+'<button id="save-boundary-shape" class="secondary" type="button">Save reviewed controls</button><span id="boundary-shape-status" class="status-message" aria-live="polite"></span><small id="boundary-shape-help">Every value is digest-bound and hard-capped. Depth three still requires the exact catalog-proven path to be reviewed. Small-group suppression, rolling extracted-cell accounting, and differencing protection are unchanged.</small></div></details>';
			      const cohortValues=[...new Set(candidate.pack.resources.map(resource=>resource.minimum_cohort_size))];
			      const cohortCurrent=cohortValues.length===1?cohortValues[0]:5;
			      const cohortSettings='<details class="boundary-options"><summary>Privacy for all tables'+(cohortValues.length===1?' · minimum group size '+esc(cohortCurrent):' · mixed group sizes')+'</summary><div class="boundary-name-editor"><label>Minimum group size for every included table<select id="boundary-cohort-all"><option value="5" '+(cohortCurrent===5?'selected':'')+'>5 — default; hide groups with 1–4 rows</option><option value="4" '+(cohortCurrent===4?'selected':'')+'>4 — hide groups with 1–3 rows</option><option value="3" '+(cohortCurrent===3?'selected':'')+'>3 — hide groups with 1–2 rows</option><option value="2" '+(cohortCurrent===2?'selected':'')+'>2 — hide groups with 1 row</option><option value="1" '+(cohortCurrent===1?'selected':'')+'>1 — show every non-empty group; suppression off</option></select></label><label>Human reviewer<input id="boundary-cohort-actor" type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><label>Reason for this privacy setting<textarea id="boundary-cohort-reason" maxlength="500" rows="2" placeholder="Explain why this minimum group size is appropriate for every table in this boundary."></textarea></label><button id="save-boundary-cohort" class="secondary" type="button" '+(candidate.pack.resources.length?'':'disabled')+'>Save for all '+esc(candidate.pack.resources.length)+' table'+(candidate.pack.resources.length===1?'':'s')+'</button><span id="boundary-cohort-status" class="status-message" aria-live="polite"></span><small>Runner hides aggregate groups with fewer rows than this number. Choosing 1 turns small-group suppression off and may reveal a group containing one person or record. Saving creates one disabled boundary change; Review and activate remains separate.</small></div></details>';
			      panel.innerHTML=
		        '<div class="boundary-overview-head"><div><p class="instant-kicker">Scoped Explore</p><h2 id="boundary-overview-title">Your boundaries</h2><p>Each boundary is an independently reviewed set of tables, columns, relationships, and limits. An active boundary adds choices to the same two Explore tools; one query still uses exactly one boundary.</p>'+databaseCompatibilitySummary+'<div class="boundary-version-table-wrap"><table class="boundary-version-table"><thead><tr><th>Name</th><th>Status</th><th>Tables</th><th>Authority</th><th>Actions</th></tr></thead><tbody>'+rows+'</tbody></table></div><p class="muted">Active boundaries never merge relationship graphs. If a table appears in several boundaries, Runner requires the caller to name one.</p>'+pendingBoundaryBanner+'<div id="new-boundary-form" class="band" hidden><h3>Create another boundary</h3><p>Choose its first table. Nothing is copied from another boundary, and no authority is activated.</p><label class="field">Boundary name<input id="new-boundary-name" type="text" maxlength="64" spellcheck="false" placeholder="support_analytics"></label><label class="field">Starting table<select id="new-boundary-table"><option value="">Choose a table</option>'+startingTableOptions+'</select></label><small>Showing all '+esc(inspectedStartingTables.length)+' inspected tables. '+esc(eligibleStartingTables.length)+' can start a boundary; '+esc(sequencedStartingTables.length)+' can be added after their scoped ancestor or after a boundary-specific Shared reference acknowledgement; unavailable tables remain visible with their reason.</small><small>Runner opens the selected table&apos;s column access next. Related and Shared reference tables can be added afterward through their reviewed controls.</small><div class="actions"><button id="create-boundary" type="button">Choose table and edit</button><button id="cancel-new-boundary" class="secondary" type="button">Cancel</button></div></div><p id="boundary-library-status" class="status-message" aria-live="polite"></p><details class="boundary-options"><summary>Rename selected boundary</summary><div class="boundary-name-editor"><label>Boundary name<input id="boundary-pack-name" type="text" maxlength="64" spellcheck="false" value="'+esc(candidate.pack.name)+'" aria-describedby="boundary-name-help"></label><button id="save-boundary-name" class="secondary" type="button">Save disabled name</button><span id="boundary-name-status" class="status-message" aria-live="polite"></span><small id="boundary-name-help">Saving changes only the selected disabled draft. The name is included in its final review fingerprint.</small></div></details>'+cohortSettings+volumeSettings+rankedSettings+shapeSettings+'</div>'+lifecycleControls+'</div>'
		        +(selectedEntry?.active?'<div id="boundary-disable-confirmation" class="band notice" hidden><strong>Deactivate '+esc(selectedEntry.name)+'?</strong><p>This removes only this boundary from local Explore. Other active boundaries, protected capabilities, evidence, ledger, and source data stay unchanged.</p><div class="actions"><button id="confirm-disable-boundary" class="danger" type="button">Deactivate selected boundary</button><button id="cancel-disable-boundary" class="secondary" type="button">Cancel</button></div><p id="boundary-disable-status" class="status-message" aria-live="polite"></p></div>':"")
		        +renderBoundaryRelationshipMap(boundaryCatalog,boundaryDiagrams);
		      wireBoundaryRelationshipMaps(panel);
			      byId("edit-boundary-tables").onclick=()=>openFocusedAccessReview();
			      byId("review-pending-boundary")?.addEventListener("click",openFocusedActivationReview);
		      byId("new-boundary").onclick=()=>{
		        byId("new-boundary-form").hidden=false;
		        byId("new-boundary-name").focus();
		      };
		      byId("cancel-new-boundary").onclick=()=>byId("new-boundary-form").hidden=true;
		      byId("create-boundary").onclick=async()=>{
		        const status=byId("boundary-library-status");
		        const requestedName=byId("new-boundary-name").value.trim();
		        const name=requestedName.toLowerCase();
		        const resourceId=byId("new-boundary-table").value;
		        try{
		          if(!/^[a-z][a-z0-9_.-]{0,63}$/.test(name))throw new Error("Use 1-64 letters, numbers, dots, dashes, or underscores; start with a letter.");
		          if(!original.pack.resources.some(resource=>resource.id===resourceId))throw new Error("Choose the first table for this boundary.");
		          byId("new-boundary-name").value=name;
		          status.className="status-message";
		          status.textContent=(name!==requestedName?'Using lower-case name "'+name+'". ':'')+"Creating a new disabled boundary with "+resourceId+"...";
		          await queueReviewProgressSave();
		          await post("/api/boundary/library/create",{name,resource_id:resourceId,actor:localWorkbenchActor()});
		          await load();
		          selectedResource=resourceId;
		          await openFocusedAccessReview();
		        }catch(error){status.className="status-message error";status.textContent=error.message;}
		      };
		      document.querySelectorAll("[data-open-boundary]").forEach(button=>button.onclick=async()=>{
		        const status=byId("boundary-library-status");
		        try{
		          if(button.dataset.openBoundary!==boundaryLibrary.selected_name){
		            status.textContent="Saving this draft and opening the selected boundary...";
		            await queueReviewProgressSave();
		            await post("/api/boundary/library/switch",{name:button.dataset.openBoundary});
		            await load();
		          }
		          await openFocusedAccessReview();
		        }catch(error){status.className="status-message error";status.textContent=error.message;}
		      });
		      document.querySelectorAll("[data-delete-boundary]").forEach(button=>button.onclick=async()=>{
		        const status=byId("boundary-library-status");
		        const name=button.dataset.deleteBoundary;
		        if(!window.confirm('Delete saved disabled boundary "'+name+'"? Active authority and source data are unchanged.'))return;
		        try{
		          await queueReviewProgressSave();
		          await post("/api/boundary/library/delete",{name,confirmation:"DELETE "+name});
		          await load();
		        }catch(error){status.className="status-message error";status.textContent=error.message;}
		      });
		      const disableButton=byId("disable-active-boundary");
		      if(disableButton&&!disableButton.disabled){
		        const confirmation=byId("boundary-disable-confirmation");
		        disableButton.onclick=()=>{
		          confirmation.hidden=false;
		          confirmation.scrollIntoView({behavior:"smooth",block:"nearest"});
		        };
		        byId("cancel-disable-boundary").onclick=()=>{
		          confirmation.hidden=true;
		          byId("boundary-disable-status").textContent="";
		        };
		        byId("confirm-disable-boundary").onclick=async()=>{
		          const status=byId("boundary-disable-status");
		          const confirmButton=byId("confirm-disable-boundary");
		          try{
		            confirmButton.disabled=true;
		            status.className="status-message";
		            status.textContent="Deactivating the selected boundary...";
		            const payload=await post("/api/explore/disable",{boundary_name:selectedEntry.name});
		            await load();
		            byId("overview-notice").innerHTML='<strong>Boundary deactivated.</strong><p>'+esc(payload.message)+'</p>';
		          }catch(error){
		            confirmButton.disabled=false;
		            status.className="status-message error";
		            status.textContent=error.message;
		          }
		        };
		      }
		      byId("save-boundary-name").onclick=async()=>{
		        const field=byId("boundary-pack-name");
		        const status=byId("boundary-name-status");
		        const requestedName=field.value.trim();
		        const next=requestedName.toLowerCase();
		        const previous=candidate.pack.name;
		        status.className="status-message";
		        if(!/^[a-z][a-z0-9_.-]{0,63}$/.test(next)){
		          status.className="status-message error";
		          status.textContent="Use 1-64 letters, numbers, dots, dashes, or underscores; start with a letter.";
		          return;
		        }
		        field.value=next;
		        if(next===previous){
		          status.textContent="Name is already current.";
		          return;
		        }
		        candidate.pack.name=next;
		        invalidateDigest();
		        status.textContent=(next!==requestedName?'Using lower-case name "'+next+'". ':'')+"Saving the disabled boundary name...";
		        await queueReviewProgressSave();
		        if(!reviewProgressHealthy){
		          candidate.pack.name=previous;
		          renderBoundaryOverview();
		          const restored=byId("boundary-name-status");
		          restored.className="status-message error";
		          restored.textContent="The name was not saved. Reload or retry after resolving the review-progress error.";
		          return;
		        }
		        await load();
		        const saved=byId("boundary-name-status");
		        saved.className="status-message";
		        saved.textContent="Saved on the selected disabled boundary. Active authority did not change.";
		      };
		      const rankedSave=byId("save-ranked-groups");
		      if(rankedSave&&!rankedSave.disabled)rankedSave.onclick=async()=>{
		        const field=byId("boundary-ranked-groups");
		        const status=byId("boundary-ranked-status");
		        const next=Number(field.value);
		        const previous=candidate.budgets.max_ranked_groups??candidate.budgets.max_groups;
		        status.className="status-message";
		        if(!Number.isSafeInteger(next)||next<rankedMinimum||next>rankedMaximum){
		          status.className="status-message error";
		          status.textContent="Choose a whole number from "+rankedMinimum+" through "+rankedMaximum+".";
		          return;
		        }
		        if(next===previous){
		          status.textContent="Ranked group limit is already "+next+".";
		          return;
		        }
		        candidate.budgets.max_ranked_groups=next;
		        invalidateDigest();
		        status.textContent="Saving this reviewed boundary limit...";
		        await queueReviewProgressSave();
		        if(!reviewProgressHealthy){
		          candidate.budgets.max_ranked_groups=previous;
		          renderBoundaryOverview();
		          return;
		        }
		        await load();
		        const saved=byId("boundary-ranked-status");
			        saved.className="status-message";
			        saved.textContent="Saved in the disabled boundary. Suppression still runs before ranking; active authority did not change.";
			      };
			      byId("save-boundary-volume").onclick=async()=>{
			        const status=byId("boundary-volume-status");
			        const queries=Number(byId("boundary-query-volume").value);
			        const rate=Number(byId("boundary-request-rate").value);
			        const previousQueries=candidate.budgets.max_queries_per_session;
			        const previousRate=candidate.budgets.rate_limit_per_minute;
			        status.className="status-message";
			        if(!Number.isSafeInteger(queries)||queries<1||queries>1000||!Number.isSafeInteger(rate)||rate<1||rate>120){
			          status.className="status-message error";
			          status.textContent="Choose 1–1000 queries per rolling 24 hours and 1–120 requests per minute.";
			          return;
			        }
			        if(queries===previousQueries&&rate===previousRate){
			          status.textContent="Query volume and request rate are already set to those values.";
			          return;
			        }
			        candidate.budgets.max_queries_per_session=queries;
			        candidate.budgets.rate_limit_per_minute=rate;
			        invalidateDigest();
			        status.textContent="Saving these reviewed throughput limits...";
			        await queueReviewProgressSave();
			        if(!reviewProgressHealthy){
			          candidate.budgets.max_queries_per_session=previousQueries;
			          candidate.budgets.rate_limit_per_minute=previousRate;
			          renderBoundaryOverview();
			          return;
			        }
			        await load();
			        const saved=byId("boundary-volume-status");
			        saved.className="status-message";
			        saved.textContent="Saved in the disabled boundary. Disclosure controls are unchanged; active authority did not change.";
			      };
			      byId("save-boundary-shape").onclick=async()=>{
			        const status=byId("boundary-shape-status");
			        status.className="status-message";
			        const next={};
			        for(const field of shapeFields){
			          const value=Number(byId("boundary-shape-"+field.key).value);
			          const maximum=field.max??reviewedBudgetCeilings[field.key];
			          if(!Number.isSafeInteger(value)||value<field.min||value>maximum){
			            status.className="status-message error";
			            status.textContent=field.label+" must be a whole number from "+field.min+" through "+maximum+".";
			            return;
			          }
			          next[field.key]=value;
			        }
			        if(next.max_top_n>next.max_groups){
			          status.className="status-message error";
			          status.textContent="Returned top N cannot exceed the aggregate-group limit.";
			          return;
			        }
			        const incompatibleScope=candidate.pack.resources.find(resource=>
			          (resource.tenant_scope?.proof?.links?.length??0)>next.max_derived_scope_hops
			          ||(resource.principal_scope?.proof?.links?.length??0)>next.max_derived_scope_hops);
			        if(incompatibleScope){
			          status.className="status-message error";
			          status.textContent="Cannot lower derived-scope depth while "+incompatibleScope.id+" uses a deeper mandatory scope path.";
			          return;
			        }
			        const unchanged=shapeFields.every(field=>(candidate.budgets[field.key]??candidate.budgets.max_relationship_hops)===next[field.key]);
			        if(unchanged){status.textContent="These reviewed controls are already set to those values.";return;}
			        const previousBudgets=structuredClone(candidate.budgets);
			        const previousAnalysisDepth=candidate.budgets.max_analysis_relationship_hops??candidate.budgets.max_relationship_hops;
			        const previousRelationships=candidate.pack.resources.map(resource=>[resource.id,structuredClone(resource.relationships)]);
			        Object.assign(candidate.budgets,next);
			        candidate.pack.resources.forEach(resource=>{
			          const retained=resource.relationships.filter(relationship=>(relationship.path_depth??1)<=next.max_analysis_relationship_hops);
			          if(next.max_analysis_relationship_hops>previousAnalysisDepth){
			            const generated=original.pack.resources.find(item=>item.id===resource.id);
			            const existing=new Set(retained.map(relationship=>relationship.id));
			            for(const relationship of generated?.relationships??[]){
			              const depth=relationship.path_depth??1;
			              if(depth>previousAnalysisDepth&&depth<=next.max_analysis_relationship_hops&&!existing.has(relationship.id)){
			                retained.push(structuredClone(relationship));
			                existing.add(relationship.id);
			              }
			            }
			          }
			          resource.relationships=retained.sort((left,right)=>(left.path_depth??1)-(right.path_depth??1)||left.id.localeCompare(right.id));
			        });
			        invalidateDigest();
			        status.textContent="Saving these reviewed execution controls...";
			        await queueReviewProgressSave();
			        if(!reviewProgressHealthy){
			          candidate.budgets=previousBudgets;
			          const byResource=new Map(previousRelationships);
			          candidate.pack.resources.forEach(resource=>{resource.relationships=byResource.get(resource.id)??resource.relationships;});
			          renderBoundaryOverview();
			          return;
			        }
			        await load();
			        const saved=byId("boundary-shape-status");
			        saved.className="status-message";
			        saved.textContent="Saved in the disabled boundary. Suppression and disclosure accounting are unchanged; Review and activate remains separate.";
			      };
			      const cohortAllSave=byId("save-boundary-cohort");
			      if(cohortAllSave&&!cohortAllSave.disabled)cohortAllSave.onclick=async()=>{
			        const status=byId("boundary-cohort-status");
			        const value=Number(byId("boundary-cohort-all").value);
			        const actor=byId("boundary-cohort-actor").value.trim();
			        const reason=byId("boundary-cohort-reason").value.trim();
			        try{
			          if(!Number.isSafeInteger(value)||value<1||value>5||!actor||!reason){
			            throw new Error("Choose a minimum group size from 1 through 5, then enter the human reviewer identity and reason.");
			          }
			          status.className="status-message";
			          status.textContent="Saving one atomic owner decision for every included table...";
			          await post("/api/boundary/regenerate",{
			            kind:"minimum_cohort_all",
			            value,
			            actor,
			            reason
			          });
			          candidateDigest=undefined;
			          focusedAccessReview=true;
			          document.body.classList.remove("quick-start-mode");
			          await load();
			          await openFocusedAccessReview();
			          offerStagedActivation();
			        }catch(error){
			          status.className="status-message error";
			          status.textContent=error.message;
			        }
			      };
			    }

		    function synchronizeBoundaryAuthorityState(active){
		      if(!boundaryLibrary?.entries)return;
		      const activeByName=new Map(activeBoundaries.map(boundary=>[
		        boundary?.pack?.name,
		        boundary?.activation?.digest
		      ]));
		      if(active&&active?.pack?.name&&!activeByName.has(active.pack.name)){
		        activeByName.set(active.pack.name,active?.activation?.digest);
		      }
		      boundaryLibrary={
		        ...boundaryLibrary,
		        entries:boundaryLibrary.entries.map(entry=>({
		          ...entry,
		          active:activeByName.has(entry.name),
		          matches_active_digest:activeByName.has(entry.name)
		            &&entry.candidate_digest===activeByName.get(entry.name)
		        }))
		      };
		    }

			    function renderResources(){
	      const sources=(reviewReport.resources||[]).filter(review=>{
	        const source=original.pack.resources.find(resource=>resource.id===review.id);
	        const raw=source?.selectable_fields.length||0;
	        const unresolved=(review.fields||[]).some(field=>field.sensitivity?.state==="unresolved_free_text");
	        if(resourceFilter==="risks")return riskCount({id:review.id})>0;
	        if(resourceFilter==="exposed")return raw>0;
	        if(resourceFilter==="unresolved")return review.status!=="draft_read"||unresolved;
	        if(resourceFilter==="starter")return Boolean(currentResource(review.id))||riskCount({id:review.id})>0||review.status!=="draft_read";
	        return true;
	      }).sort((left,right)=>{
          const blockedDifference=Number(right.status!=="draft_read")-Number(left.status!=="draft_read");
          if(blockedDifference)return blockedDifference;
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
		        const sensitiveKeptOut=sensitiveKeptOutCount(review.id);
	        const fieldAccess=reviewedFieldAccessCounts(resource,review);
	        const raw=fieldAccess.visible;
	        const runnerOnly=fieldAccess.runnerOnly;
	        const kept=fieldAccess.keptOut;
	        const primary=source?.primary_key||review.primary_key?.selected||"unresolved";
	        const tenant=reviewedTenantScopeLabel(source,review);
	        const principal=reviewedPrincipalScopeLabel(source,review);
	        const blocked=review.status!=="draft_read";
	          const badgeText=blocked?"Blocked":!included?"Available to add":risks?"Table sign-off needed":"Reviewed";
	          const badgeClass=blocked?"bad":!included?"":risks?"warn":"good";
	        const scopeWhy=blocked&&review.scope_resolution_guidance?.why?.length?'<div class="risk-list">'+review.scope_resolution_guidance.why.map(reason=>'<div class="risk unresolved"><strong>Why unavailable</strong><p>'+esc(reason)+'</p></div>').join("")+'</div>':'';
          const reviewedDepth=Number(candidate?.budgets?.max_derived_scope_hops??candidate?.budgets?.max_relationship_hops??2);
          const availableTenantPaths=blocked?[...(review.derived_tenant_scope?.candidates||[])].sort((left,right)=>(left.proof?.links?.length||0)-(right.proof?.links?.length||0)||left.path_id.localeCompare(right.path_id)):[];
          const scopeAvailable=availableTenantPaths.length?'<div class="risk-list">'+availableTenantPaths.slice(0,3).map(path=>{const depth=path.proof?.links?.length||1;const joinColumns=derivedScopeJoinColumns(path);return '<div class="risk available"><strong>Tenant scope available ('+esc(depth)+' hop'+(depth===1?'':'s')+')</strong><p>'+esc(derivedScopePathChain(path))+'</p>'+(joinColumns?'<p>via columns: <code>'+esc(joinColumns)+'</code></p>':'')+'<p>path ID: <code>'+esc(path.path_id)+'</code></p>'+(depth>reviewedDepth?'<p>Needs max_derived_scope_hops '+esc(depth)+' (currently '+esc(reviewedDepth)+').</p>':'')+'</div>';}).join("")+'</div>':'';
	        return '<article class="resource" data-risk="'+risks+'"><div class="resource-head"><div><h3 class="resource-name">'+esc(review.id)+'</h3><p>'+esc(blocked?"Unavailable: "+(review.blockers||[]).join("; "):included?"Included in the agent data set":"Excluded from the agent data set")+'</p></div><span class="badge '+badgeClass+'">'+esc(badgeText)+'</span></div><div class="badges"><span class="badge">'+esc(raw)+' visible</span><span class="badge">'+esc(runnerOnly)+' Runner-only</span><span class="badge">'+esc(kept)+' kept out</span>'+(sensitiveKeptOut?'<span class="badge good">'+esc(sensitiveKeptOut)+' sensitive kept out</span>':'')+'<span class="badge">record ID: '+esc(primary)+'</span></div><p>Customer isolation: <code>'+esc(tenant)+'</code> · User/owner limit: <code>'+esc(principal)+'</code></p>'+scopeWhy+scopeAvailable+(blocked?'<p><strong>Next:</strong> '+esc(blockedResourceNextAction(review))+'</p>':'')+'<div class="actions"><button class="secondary" data-open-resource="'+esc(review.id)+'" type="button">'+esc(risks?"Review access":"Inspect access")+'</button>'+(source?'<label class="check"><input type="checkbox" data-resource-toggle="'+esc(review.id)+'" '+(included?"checked":"")+'> Include</label>':'')+'</div></article>';
	      }).join("")||'<div class="band notice"><strong>No '+esc(reviewedCollectionLabel())+' match this view.</strong><p>The inspected resources are still available; this filter did not change authority.</p><button id="reset-resource-filter" class="secondary" type="button">Show all '+esc(reviewedCollectionLabel())+'</button></div>';
      document.querySelectorAll("[data-open-resource]").forEach(button=>button.onclick=()=>openResource(button.dataset.openResource));
      document.querySelectorAll("[data-resource-toggle]").forEach(input=>input.onchange=()=>{
        if(!toggleResource(input.dataset.resourceToggle,input.checked))input.checked=true;
      });
	      const reset=byId("reset-resource-filter");
	      if(reset)reset.onclick=()=>setResourceFilter("all");
	      renderResourceNavigation();
	    }

	    function scrollAccessDetailForNarrowLayout(){
	      if(window.matchMedia("(max-width: 820px)").matches){
	        byId("resource-detail").scrollIntoView({behavior:"auto",block:"start"});
	      }
	    }

	    function renderResourceNavigation(){
	      const panel=byId("resource-navigation");
	      if(!panel||!reviewReport)return;
	      const query=resourceSearch.trim().toLowerCase();
		      const inspected=reviewReport.resources||[];
		      const relatedCount=inspected.filter(resource=>
		        !currentResource(resource.id)&&accessRelationshipConnections(resource.id).length>0).length;
		      byId("show-related-access").classList.toggle("active",!showAllAccessResources);
		      byId("show-all-access").classList.toggle("active",showAllAccessResources);
		      byId("show-related-access").textContent="Boundary + related ("+
		        ((candidate?.pack?.resources?.length||0)+relatedCount)+")";
		      byId("show-all-access").textContent="All inspected ("+inspected.length+")";
		      byId("access-catalog-note").textContent=showAllAccessResources
		        ?"Advanced view: unrelated tables are visible but are not presented as joinable."
		        :"Showing current boundary tables and "+relatedCount+" table"+(relatedCount===1?"":"s")+" connected by inspected foreign-key paths.";
		      const resources=inspected
		        .filter(resource=>showAllAccessResources||Boolean(currentResource(resource.id))
		          ||accessRelationshipConnections(resource.id).length>0||resource.id===selectedResource)
		        .filter(resource=>{const metadata=currentResource(resource.id);return !query||resource.id.toLowerCase().includes(query)||humanizeIdentifier(resource.id.split(".").pop()||resource.id).toLowerCase().includes(query)||(metadata?.label||"").toLowerCase().includes(query)||(metadata?.description||"").toLowerCase().includes(query)})
		        .sort((left,right)=>{
		          const riskDifference=accessNavigationRiskRank(right.id)-accessNavigationRiskRank(left.id);
		          return riskDifference||left.id.localeCompare(right.id);
		        });
		      panel.innerHTML=resources.map(review=>{
		        const risks=riskCount({id:review.id});
		        const blocked=review.status!=="draft_read";
		        const included=Boolean(currentResource(review.id));
		        const connection=!included?accessRelationshipConnections(review.id)[0]:null;
		        const includedResource=included?currentResource(review.id):null;
		        const privacy=includedResource
		          ?'<small>Privacy: minimum group '+esc(includedResource.minimum_cohort_size)+(includedResource.minimum_cohort_overridden?' · owner override':'')+'</small>'
		          :'';
		      const state=blocked
		        ?"Blocked"
		        :!included
		          ?connection
		            ?"Add related table"
		            :"Available · unrelated"
		            :focusedAccessReview
		              ?"Included"
		              :risks?"Sign-off needed":"Ready";
		        const stateClass=blocked?"blocked":!included||risks?"pending":"ready";
		        const label=includedResource?.label||humanizeIdentifier(review.id.split(".").pop()||review.id);
		        const description=includedResource?.description?'<small>'+esc(includedResource.description)+'</small>':'';
		      const path=connection
		        ?'<small>Related to '+esc(accessBoundaryEndpoint(connection)+' via '+connection.relationship)+'</small>'
		          :'';
		        return '<button class="access-resource secondary '+(review.id===selectedResource?"selected":"")+'" data-access-resource="'+esc(review.id)+'" data-access-included="'+esc(String(included))+'" data-access-blocked="'+esc(String(blocked))+'" type="button" aria-pressed="'+esc(String(review.id===selectedResource))+'"><span><strong>'+esc(label)+'</strong><small>'+esc(review.id)+'</small>'+description+privacy+path+'</span><span class="access-resource-state '+stateClass+'">'+esc(state)+'</span></button>';
	      }).join("")||'<p>No '+esc(reviewedCollectionLabel())+' match this view. '+(showAllAccessResources?'Try another search.':'Use All inspected only when you intentionally need an unrelated table.')+'</p>';
		      document.querySelectorAll("[data-access-resource]").forEach(button=>button.onclick=()=>{
		        selectedResource=button.dataset.accessResource;
		        highlightedAccessField=null;
		        openedResources.add(selectedResource);
		        if(button.dataset.accessIncluded!=="true"&&button.dataset.accessBlocked!=="true"){
		          toggleResource(selectedResource,true);
		          renderResourceDetail();
		          scrollAccessDetailForNarrowLayout();
		          return;
		        }
		        renderResourceNavigation();
		        renderResourceDetail();
	        scrollAccessDetailForNarrowLayout();
	      });
	      requestAnimationFrame(()=>{
	        const selected=[...panel.querySelectorAll("[data-access-resource]")]
	          .find(button=>button.dataset.accessResource===selectedResource);
	        if(!selected)return;
	        const row=selected.getBoundingClientRect();
	        const viewport=panel.getBoundingClientRect();
	        const visibleTop=Math.max(0,viewport.top);
	        const visibleBottom=Math.min(window.innerHeight,viewport.bottom);
	        if(row.top<visibleTop||row.bottom>visibleBottom){
	          selected.scrollIntoView({behavior:"auto",block:"nearest"});
	        }
	      });
	    }

    function removalScopeReferencesResource(scope,id){
      return Boolean(scope&&(scope.ancestor_resource===id||(scope.proof?.links||[])
        .some(link=>link.source_resource===id||link.target_resource===id)));
    }

    function removalRelationshipReferencesResource(relationship,id){
      return relationship.target_resource===id||(relationship.proof?.links||[])
        .some(link=>link.source_resource===id||link.target_resource===id);
    }

    function resourceRemovalImpact(id){
      const blockers=[];
      const pruned=[];
      for(const resource of candidate.pack.resources){
        if(resource.id===id)continue;
        for(const [label,scope] of [["tenant",resource.tenant_scope],["principal",resource.principal_scope]]){
          if(removalScopeReferencesResource(scope,id)){
            blockers.push(resource.id+": "+label+" scope via "+scope.path_id);
          }
        }
        const affected=new Set();
        for(const relationship of resource.relationships||[]){
          if(!removalRelationshipReferencesResource(relationship,id))continue;
          affected.add(relationship.id);
          pruned.push(resource.id+"."+relationship.id);
        }
        for(const measure of resource.derived_measures||[]){
          if(measure.child_resource){
            const child=currentResource(measure.child_resource);
            const childRelationship=(child?.relationships||[]).find(item=>item.id===measure.relationship);
            const childScope=[child?.tenant_scope,child?.principal_scope]
              .find(scope=>scope?.path_id===measure.relationship);
            if(measure.child_resource===id
              ||(childRelationship&&removalRelationshipReferencesResource(childRelationship,id))
              ||removalScopeReferencesResource(childScope,id)){
              blockers.push(resource.id+": reviewed metric "+measure.name+" uses child "+measure.child_resource);
            }
            continue;
          }
          const bases=measure.base_measure?[measure.base_measure]:[measure.numerator,measure.denominator].filter(Boolean);
          const relationship=bases.map(base=>base.relationship).find(value=>value&&affected.has(value));
          if(relationship)blockers.push(resource.id+": reviewed metric "+measure.name+" uses relationship "+relationship);
        }
        for(const band of resource.numeric_bands||[]){
          if(band.relationship&&affected.has(band.relationship)){
            blockers.push(resource.id+": reviewed numeric band "+band.name+" uses relationship "+band.relationship);
          }
        }
      }
      return {blockers:[...new Set(blockers)].sort(),pruned:[...new Set(pruned)].sort()};
    }

    function showBlockedResourceRemoval(id,impact){
      const dependentResources=[...new Set(impact.blockers.map(blocker=>blocker.split(":")[0]))];
      const text="Cannot remove "+id+" because reviewed boundary policy still depends on it. "
        +impact.blockers.join("; ")+". Remove or re-scope "+dependentResources.join(", ")+" first. Nothing was saved or activated.";
      const message=byId("message");
      message.className="status-message error";
      message.textContent=text;
      const detail=byId("resource-detail");
      detail.querySelector("[data-removal-blocked]")?.remove();
      const notice=document.createElement("div");
      notice.className="risk high";
      notice.dataset.removalBlocked="true";
      const heading=document.createElement("strong");
      heading.textContent="This table cannot be removed yet.";
      const explanation=document.createElement("p");
      explanation.textContent=text;
      notice.append(heading,explanation);
      detail.prepend(notice);
      notice.scrollIntoView({behavior:"auto",block:"nearest"});
    }

    function toggleResource(id,included){
      const source=original.pack.resources.find(resource=>resource.id===id);
      if(!source)return false;
      const removalImpact=!included?resourceRemovalImpact(id):null;
      if(removalImpact?.blockers.length){
        showBlockedResourceRemoval(id,removalImpact);
        return false;
      }
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
	      renderBoundaryOverview();
	      renderStagedAccessBar();
	      queueReviewProgressSave();
	      if(removalImpact?.pruned.length){
	        const message=byId("message");
	        message.className="status-message";
	        message.textContent="Removed from the disabled draft. Related-data paths also removed: "+removalImpact.pruned.join(", ")+". Active authority is unchanged until activation.";
	      }
      return true;
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
		      highlightedAccessField=null;
		      openedResources.add(id);
		      setView("exceptions");
		    }

		    function backFromResourceDetail(){
		      if(!focusedAccessReview){
		        setView("overview");
		        return;
		      }
		      selectedResource=null;
		      highlightedAccessField=null;
		      renderResourceNavigation();
		      renderResourceDetail();
		      byId("resource-navigation-shell")?.scrollIntoView({behavior:"auto",block:"start"});
		    }

		    function focusHighlightedAccessField(){
		      if(!highlightedAccessField)return;
		      window.requestAnimationFrame(()=>{
		        const row=[...document.querySelectorAll("[data-access-column]")]
		          .find(item=>item.dataset.accessColumn===highlightedAccessField);
		        if(!row)return;
		        row.scrollIntoView({behavior:"auto",block:"center"});
		        row.querySelector("[data-field-tier]")?.focus();
		      });
		    }

			    function openAccessEditor(resourceId,field,focusPrivacy){
		      focusedAccessReview=true;
		      accessBaselineColumns=accessColumnSnapshot(activeBoundaryForCandidate()||candidate);
		      const resource=typeof resourceId==="string"?reviewResource(resourceId):null;
		      if(resource){
		        selectedResource=resource.id;
		        openedResources.add(resource.id);
		        resourceSearch="";
		        byId("resource-search").value="";
		        const directField=(resource.fields||[]).find(item=>item.name===field)?.name;
		        const trailingField=typeof field==="string"
		          ?(resource.fields||[]).find(item=>item.name===field.split(".").pop())?.name
		          :null;
		        highlightedAccessField=directField||trailingField||null;
		      }else{
		        highlightedAccessField=null;
		        if(typeof resourceId==="string"&&resourceId){
		          resourceSearch=resourceId;
		          byId("resource-search").value=resourceId;
		        }
		      }
			      setView("exceptions");
			      if(focusPrivacy)window.requestAnimationFrame(()=>{
			        const section=document.querySelector("[data-cohort-review-section]");
			        if(!section)return;
			        section.open=true;
			        section.scrollIntoView({behavior:"auto",block:"center"});
			        section.querySelector("[data-cohort-review-value]")?.focus();
			      });
			    }

    function fieldHas(resource,field,key){
      return key==="filterable_fields"||key==="time_bucket_fields"
        ? Object.hasOwn(resource[key]||{},field)
        : (resource[key]||[]).includes(field);
    }

    function accessColumnSnapshot(boundary){
      const snapshot={};
      for(const resource of boundary?.pack?.resources||[]){
        snapshot[resource.id]={
          usable:[...(resource.selectable_fields||[])].sort(),
          withheld:[...(resource.model_withheld_fields||[])].sort()
        };
      }
      return snapshot;
    }

    function stagedAccessCounts(){
      const baseline=accessBaselineColumns||{};
      const current=accessColumnSnapshot(candidate);
      const resources=new Set([...Object.keys(baseline),...Object.keys(current)]);
      let added=0;
      let removed=0;
      let egressChanged=0;
      for(const resource of resources){
        const before=new Set(baseline[resource]?.usable||[]);
        const after=new Set(current[resource]?.usable||[]);
        for(const field of after)if(!before.has(field))added+=1;
        for(const field of before)if(!after.has(field))removed+=1;
        const beforeWithheld=new Set(baseline[resource]?.withheld||[]);
        const afterWithheld=new Set(current[resource]?.withheld||[]);
        for(const field of new Set([...beforeWithheld,...afterWithheld])){
          if(beforeWithheld.has(field)!==afterWithheld.has(field))egressChanged+=1;
        }
      }
      const active=activeBoundaryForCandidate();
      const activeResources=new Map((active?.pack?.resources||[]).map(resource=>[resource.id,resource]));
      const candidateResources=new Map((candidate?.pack?.resources||[]).map(resource=>[resource.id,resource]));
      let privacyChanged=0;
      let tableChanges=0;
      for(const resourceId of new Set([...activeResources.keys(),...candidateResources.keys()])){
        const before=activeResources.get(resourceId);
        const after=candidateResources.get(resourceId);
        if(!before||!after){tableChanges+=1;continue;}
        if(before.minimum_cohort_size!==after.minimum_cohort_size)privacyChanged+=1;
      }
      const rankedChanged=Boolean(active&&(
        (active.budgets.max_ranked_groups??active.budgets.max_groups)
        !==(candidate.budgets.max_ranked_groups??candidate.budgets.max_groups)
      ))?1:0;
      const volumeChanged=Boolean(active&&(
        active.budgets.max_queries_per_session!==candidate.budgets.max_queries_per_session
        ||active.budgets.rate_limit_per_minute!==candidate.budgets.rate_limit_per_minute
      ))?1:0;
      return {added,removed,egressChanged,privacyChanged,tableChanges,rankedChanged,volumeChanged};
    }

    function renderStagedAccessBar(){
      const bar=byId("access-staged");
      if(!bar)return;
      const counts=stagedAccessCounts();
      const selectedEntry=(boundaryLibrary?.entries||[]).find(entry=>entry.selected);
      const pendingRevision=Boolean(selectedEntry&&(!selectedEntry.active||!selectedEntry.matches_active_digest));
      const counted=counts.added+counts.removed+counts.egressChanged+counts.privacyChanged+counts.tableChanges+counts.rankedChanged+counts.volumeChanged;
      const pendingChanges=pendingRevision?Math.max(1,counted):counted;
      bar.classList.toggle("hidden",!focusedAccessReview&&!pendingRevision);
      byId("access-staged-summary").textContent=pendingRevision
        ?pendingChanges+" pending boundary change"+(pendingChanges===1?" is":"s are")+" not active; Ask still uses the previous exact revision"
        :"No access changes staged; review the current boundary as shown";
      byId("review-staged-access").textContent=pendingRevision
        ?"Review and activate now →"
        :"Review and activate →";
    }

    function offerStagedActivation(){
      renderStagedAccessBar();
      const bar=byId("access-staged");
      bar.classList.remove("hidden");
      bar.scrollIntoView({behavior:"smooth",block:"center"});
      byId("review-staged-access").focus();
    }

    function conciseFieldRisk(field){
      const codes=field?.sensitivity?.reason_codes||[];
      const labels=[
        ["credential_or_secret","credential or secret"],
        ["payment_or_bank_detail","payment data"],
        ["government_identifier","government identifier"],
        ["birth_information","birth information"],
        ["medical_or_health_information","health information"],
        ["direct_contact_or_address","identifies a person"],
        ["biometric_or_precise_location","biometric or precise location"],
        ["private_or_risk_information","private information"],
        ["unconstrained_free_text_name","free text"],
        ["unstructured_data_type","unstructured data"],
        ["write_only_input","write-only input"]
      ];
      return labels.find(([code])=>codes.includes(code))?.[1]
        ||(field?.sensitivity?.state==="high_confidence_sensitive"?"sensitive":"needs review");
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

    function reviewedFieldOperations(resource,field){
      if(!resource)return "no reviewed operation";
      const operations=[];
      if((resource.selectable_fields||[]).includes(field))operations.push("return");
      operations.push(...reviewedFieldAnalyticalOperations(resource,field));
      return operations.length?operations.join(", "):"no reviewed operation";
    }

    function reviewedFieldAnalyticalOperations(resource,field,includePresence=true){
      if(!resource)return [];
      const operations=[];
      const filters=(resource.filterable_fields||{})[field];
      if(filters&&filters.length)operations.push("filter("+filters.join("/")+")");
      if((resource.sortable_fields||[]).includes(field))operations.push("sort");
      if((resource.groupable_fields||[]).includes(field))operations.push("group");
      if((resource.aggregate_measures||[]).includes(field))operations.push("aggregate measure");
      if(includePresence&&(resource.presence_measure_fields||[]).includes(field))operations.push("presence measures");
      if((resource.count_distinct_fields||[]).includes(field))operations.push("count distinct");
      const buckets=(resource.time_bucket_fields||{})[field];
      if(buckets&&buckets.length)operations.push("time("+buckets.join("/")+")");
      return operations;
    }

    function fieldNeedsOperationRepair(resource,source,field){
      if(!resource||!source||(resource.kept_out_fields||[]).includes(field))return false;
      const includePresence=!(resource.model_withheld_fields||[]).includes(field);
      return (resource.selectable_fields||[]).includes(field)
        &&(source.selectable_fields||[]).includes(field)
        &&reviewedFieldAnalyticalOperations(resource,field,includePresence).length===0
        &&reviewedFieldAnalyticalOperations(source,field,includePresence).length>0;
    }

    function stagedFieldExposureMessage(resourceId,field,exposure,restored,actor){
      const label=exposure==="allow_reviewed_use"
        ?"Model + Runner"
        :exposure==="withhold_from_model"
          ?"Raw values: Runner only"
          :"Kept out";
      const operations=restored
        ?" Restored current inspected operation suggestions: "+reviewedFieldOperations(currentResource(resourceId),field)+"."
        :"";
      return "Recorded: "+resourceId+"."+field+" -> "+label+"."+operations
        +(actor?" Actor: "+actor+".":"")
        +" This disabled revision still requires review and activation.";
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

    function focusedFieldChangeNeedsExplicitReview(field,currentTier,nextTier){
      const source=original?.pack?.resources?.find(resource=>resource.id===selectedResource);
      if(field===source?.tenant_key||field===source?.principal_key){
        return currentTier!==nextTier;
      }
      const classification=classificationFor(selectedResource,field);
      if(classification?.state==="structurally_low_risk")return false;
      return (currentTier==="kept_out"&&nextTier!=="kept_out")
        ||(currentTier==="withheld"&&nextTier==="visible");
    }

    async function submitFocusedFieldReview(field,exposure){
      const bar=byId("access-staged");
      const summary=byId("access-staged-summary");
      const resourceId=selectedResource;
      const restored=exposure!=="keep_out"
        &&(reviewedFieldAccessTier(currentResource(resourceId),field)==="kept_out"
          ||fieldNeedsOperationRepair(currentResource(resourceId),original.pack.resources.find(resource=>resource.id===resourceId),field));
      try{
        bar.classList.remove("hidden");
        summary.textContent="Saving this disabled access choice...";
        await post("/api/boundary/regenerate",{
          kind:"field_exposure",
          resource_id:resourceId,
          field,
          exposure,
          actor:localWorkbenchActor(),
          reason:"Staged through the focused access editor; the exact boundary update requires final human confirmation."
        });
        candidateDigest=undefined;
        focusedAccessReview=true;
        document.body.classList.remove("quick-start-mode");
        await load();
        offerStagedActivation();
        byId("access-staged-summary").textContent=stagedFieldExposureMessage(
          resourceId,field,exposure,restored,localWorkbenchActor()
        );
      }catch(error){
        summary.textContent=error.message;
        bar.classList.remove("hidden");
      }
    }

    async function submitManagedFieldReview(field,exposure){
      const form=[...document.querySelectorAll("[data-managed-review-form]")].find(item=>item.dataset.field===field&&item.dataset.exposure===exposure);
      if(!form)return;
      const actor=form.querySelector("[data-review-actor]").value.trim();
      const reason=form.querySelector("[data-review-reason]").value.trim();
      const status=form.querySelector("[data-review-status]");
      const resourceId=selectedResource;
      const restored=exposure!=="keep_out"
        &&(reviewedFieldAccessTier(currentResource(resourceId),field)==="kept_out"
          ||fieldNeedsOperationRepair(currentResource(resourceId),original.pack.resources.find(resource=>resource.id===resourceId),field));
      try{
        if(!actor||!reason)throw new Error("Enter the human reviewer identity and a concrete reason.");
        status.className="status-message";
        status.textContent="Saving this reviewed choice and updating only the affected access...";
        await post("/api/boundary/regenerate",{
          kind:"field_exposure",
          resource_id:resourceId,
          field,
          exposure,
          actor,
          reason
        });
        candidateDigest=undefined;
        focusedAccessReview=true;
        document.body.classList.remove("quick-start-mode");
        await load();
        offerStagedActivation();
        byId("access-staged-summary").textContent=stagedFieldExposureMessage(
          resourceId,field,exposure,restored,actor
        );
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    async function submitManagedEnumReview(field,form){
      const status=form.querySelector("[data-enum-review-status]");
      const actor=form.querySelector("[data-enum-review-actor]").value.trim();
      const reason=form.querySelector("[data-enum-review-reason]").value.trim();
      const values=[...form.querySelectorAll("[data-enum-review-value]:checked")].map(input=>input.value);
      const resourceId=selectedResource;
      try{
        if(!actor||!reason)throw new Error("Enter the human reviewer identity and a concrete reason. No change was made.");
        const current=JSON.parse(decodeURIComponent(form.dataset.enumCurrent||"%5B%5D"));
        if(JSON.stringify(values)===JSON.stringify(current)){
          status.className="status-message";
          status.textContent="Unchanged: this column already uses exactly these allowed values. No boundary revision was created.";
          return;
        }
        status.className="status-message";
        status.textContent="Saving this reviewed value allowlist in the disabled boundary...";
        await post("/api/boundary/regenerate",{
          kind:"field_enum",
          resource_id:resourceId,
          field,
          values,
          actor,
          reason
        });
        candidateDigest=undefined;
        focusedAccessReview=true;
        document.body.classList.remove("quick-start-mode");
        await load();
        offerStagedActivation();
        byId("access-staged-summary").textContent="Recorded: "+resourceId+"."+field+" keeps "+(values.length?values.length+" reviewed value"+(values.length===1?"":"s"):"no values; filtering and grouping are disabled")+". Actor: "+actor+".";
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function managedEnumReviewPanel(field,schemaValues,reviewedValues,decision){
      const selected=new Set(reviewedValues);
      const values=schemaValues.map(value=>'<label class="check"><input data-enum-review-value type="checkbox" value="'+esc(value)+'" '+(selected.has(value)?"checked":"")+'><span><code>'+esc(value)+'</code></span></label>').join("");
      const decisionText=decision
        ?'<p>Last reviewed by '+esc(decision.actor)+' at '+esc(decision.decided_at)+': '+esc(decision.reason)+'</p>'
        :"";
      return '<details class="enum-review" data-enum-review-form data-enum-field="'+esc(field)+'" data-enum-current="'+esc(encodeURIComponent(JSON.stringify(reviewedValues)))+'"><summary>Allowed values · '+esc(reviewedValues.length)+' of '+esc(schemaValues.length)+'</summary>'
        +'<p>Runner learned this complete list from database schema metadata; no source rows were sampled. The AI may filter or group only by checked values. Removed values are refused even if guessed.</p>'
        +'<p><strong>Selecting none disables filtering and grouping for this column.</strong> It does not restore free-text access.</p>'
        +decisionText
        +'<div class="enum-review-values">'+values+'</div>'
        +'<div class="form-grid"><label class="field">Human reviewer<input data-enum-review-actor type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><label class="field">Reason<textarea data-enum-review-reason maxlength="500" rows="2" placeholder="Explain why the AI should be limited to exactly these values."></textarea></label></div>'
        +'<div class="actions"><button data-submit-enum-review="'+esc(field)+'" type="button">Save allowed values</button></div><span data-enum-review-status class="status-message"></span></details>';
    }

    function managedReviewForm(field,exposure,placeholder){
      return '<div class="review-form hidden" data-managed-review-form data-field="'+esc(field)+'" data-exposure="'+esc(exposure)+'"><label class="field">Human reviewer<input data-review-actor type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><label class="field">Reason<textarea data-review-reason maxlength="500" rows="2" placeholder="'+esc(placeholder)+'"></textarea></label><div class="actions"><button data-submit-field-review="'+esc(field)+'" data-exposure="'+esc(exposure)+'" type="button">Save this reviewed choice</button><button class="quiet" data-cancel-field-review type="button">Cancel</button></div><span data-review-status class="status-message"></span></div>';
    }

    function managedMetadataReviewPanel(kind,field,metadata){
      const subject=field?"Column name and description":"Table name and description";
      const exact=field?selectedResource+"."+field:selectedResource;
      return '<details class="access-secondary metadata-review" data-metadata-review-form data-metadata-kind="'+esc(kind)+'" data-metadata-field="'+esc(field||"")+'" data-metadata-current-label="'+esc(metadata?.label||"")+'" data-metadata-current-description="'+esc(metadata?.description||"")+'"><summary>'+esc(subject)+(metadata?.label||metadata?.description?' · reviewed':'')+'</summary>'
        +'<p>Help people and AI clients understand <code>'+esc(exact)+'</code>. This metadata grants no access; plans still use the exact id.</p>'
        +'<div class="form-grid"><label class="field">Reviewed label<input data-metadata-label type="text" maxlength="64" value="'+esc(metadata?.label||"")+'" placeholder="Short human-readable name"></label><label class="field">Reviewed description<textarea data-metadata-description maxlength="280" rows="2" placeholder="What this '+(field?'column':'table')+' means">'+esc(metadata?.description||"")+'</textarea></label><label class="field">Human reviewer<input data-metadata-actor type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><label class="field">Reason<textarea data-metadata-reason maxlength="500" rows="2" placeholder="Why these words accurately describe the exact database id"></textarea></label></div>'
        +'<div class="actions"><button data-submit-metadata-review type="button">Save reviewed metadata</button></div><span data-metadata-status class="status-message"></span></details>';
    }

    async function submitManagedMetadataReview(form){
      const status=form.querySelector("[data-metadata-status]");
      try{
        const label=form.querySelector("[data-metadata-label]").value.trim();
        const description=form.querySelector("[data-metadata-description]").value.trim();
        const currentLabel=form.dataset.metadataCurrentLabel||"";
        const currentDescription=form.dataset.metadataCurrentDescription||"";
        if(label===currentLabel&&description===currentDescription){
          status.className="status-message";
          status.textContent="Unchanged: these reviewed words are already saved. No boundary revision was created.";
          return;
        }
        const actor=form.querySelector("[data-metadata-actor]").value.trim();
        const reason=form.querySelector("[data-metadata-reason]").value.trim();
        if(!actor||!reason)throw new Error("Enter the human reviewer identity and a concrete reason. No change was made.");
        status.className="status-message";
        status.textContent="Saving reviewed metadata in the disabled boundary...";
        await post("/api/boundary/regenerate",{
          kind:form.dataset.metadataKind,
          resource_id:selectedResource,
          ...(form.dataset.metadataField?{field:form.dataset.metadataField}:{}),
          label:label||null,
          description:description||null,
          actor,
          reason
        });
        candidateDigest=undefined;
        focusedAccessReview=true;
        document.body.classList.remove("quick-start-mode");
        await load();
        offerStagedActivation();
        byId("access-staged-summary").textContent="Recorded reviewed metadata for "+selectedResource+(form.dataset.metadataField?"."+form.dataset.metadataField:"")+". Review the complete boundary, then activate it.";
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    async function submitManagedScopeReview(kind,form){
      const status=form.querySelector("[data-scope-review-status]");
      const button=form.querySelector("[data-submit-scope-review]");
      const detail=byId("resource-detail");
      try{
        const select=form.querySelector("[data-scope-review-value]");
        const selected=select.value;
        const selectedOption=select.options[select.selectedIndex];
        const reviewedKind=selectedOption?.dataset.reviewKind||kind;
        const selectedDepth=Number(selectedOption?.dataset.reviewDepth||0);
        const reviewedDepth=Number(candidate?.budgets?.max_derived_scope_hops??candidate?.budgets?.max_relationship_hops??2);
        if(selectedDepth>reviewedDepth){
          throw new Error("This "+selectedDepth+"-hop path exceeds the reviewed derived-scope depth of "+reviewedDepth+". Raise it in Settings → Result shape, timeout, and path depth, then return here.");
        }
        const value=(reviewedKind==="principal_key"||reviewedKind==="principal_scope_path")
          &&selected==="__none__"?null:selected;
        const actor=form.querySelector("[data-scope-review-actor]").value.trim();
        const reason=form.querySelector("[data-scope-review-reason]").value.trim();
        if((value===null?false:!value)||!actor||!reason)throw new Error("Choose the reviewed scope and enter the human reviewer identity and reason.");
        if(reviewedKind==="shared_reference_scope"&&!form.querySelector("[data-shared-reference-ack]")?.checked){
          throw new Error("Confirm that this table has no per-tenant rows. No change was made.");
        }
        button.disabled=true;
        detail.setAttribute("aria-busy","true");
        status.className="status-message";
        status.textContent="Saving this reviewed choice and updating only the affected access...";
        const reviewRequest={
          kind:reviewedKind,
          resource_id:selectedResource,
          actor,
          reason
        };
        if(reviewedKind==="shared_reference_scope")reviewRequest.acknowledgement="table_has_no_per_tenant_rows";
        else reviewRequest.value=value;
        await post("/api/boundary/regenerate",reviewRequest);
        candidateDigest=undefined;
        focusedAccessReview=true;
        document.body.classList.remove("quick-start-mode");
        await load();
        detail.removeAttribute("aria-busy");
      }catch(error){
        button.disabled=false;
        detail.removeAttribute("aria-busy");
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    async function submitManagedCohortReview(form){
      const status=form.querySelector("[data-cohort-review-status]");
      try{
        const value=Number(form.querySelector("[data-cohort-review-value]").value);
        const actor=form.querySelector("[data-cohort-review-actor]").value.trim();
        const reason=form.querySelector("[data-cohort-review-reason]").value.trim();
        if(!Number.isSafeInteger(value)||value<1||value>5||!actor||!reason){
          throw new Error("Choose a minimum group size from 1 through 5, then enter the human reviewer identity and reason.");
        }
        status.className="status-message";
        status.textContent="Saving this owner decision and rebuilding only the affected disabled authority...";
        await post("/api/boundary/regenerate",{
          kind:"minimum_cohort",
          resource_id:selectedResource,
          value,
          actor,
          reason
        });
        candidateDigest=undefined;
        focusedAccessReview=true;
        document.body.classList.remove("quick-start-mode");
        await load();
        offerStagedActivation();
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function reviewedAnalyticsFieldChoices(resource){
      const choices=(resource.aggregate_measures||[]).map(field=>({
        field,
        label:resource.id+"."+field
      }));
      for(const relationship of resource.relationships||[]){
        const target=candidate.pack.resources.find(item=>item.id===relationship.target_resource);
        if(!target)continue;
        for(const field of target.aggregate_measures||[]){
          choices.push({
            field,
            relationship:relationship.id,
            label:relationship.id+" -> "+target.id+"."+field
          });
        }
      }
      return choices;
    }

    function reviewedAnalyticsOperandChoices(resource){
      const choices=[{value:{function:"count"},label:"COUNT rows in "+resource.id,relationship:""}];
      const resources=[{resource,relationship:""}];
      for(const relationship of resource.relationships||[]){
        const target=candidate.pack.resources.find(item=>item.id===relationship.target_resource);
        if(target)resources.push({resource:target,relationship:relationship.id});
      }
      for(const item of resources){
        const prefix=item.relationship?item.relationship+" -> "+item.resource.id:item.resource.id;
        for(const field of item.resource.aggregate_measures||[]){
          const functions=item.resource.aggregate_measure_functions?.[field]||["sum","avg"];
          ["sum","avg"].filter(fn=>functions.includes(fn)).forEach(fn=>choices.push({
            value:{function:fn,field,...(item.relationship?{relationship:item.relationship}:{})},
            label:fn.toUpperCase()+" "+prefix+"."+field,
            relationship:item.relationship
          }));
        }
        for(const field of item.resource.count_distinct_fields||[]){
          choices.push({
            value:{function:"count_distinct",field,...(item.relationship?{relationship:item.relationship}:{})},
            label:"COUNT DISTINCT "+prefix+"."+field,
            relationship:item.relationship
          });
        }
      }
      return choices;
    }

    function reviewedChildCountChoices(resource){
      const choices=[];
      for(const child of candidate.pack.resources){
        if(child.id===resource.id)continue;
        if(!candidate.organization_scope&&(child.shared_reference_scope||(!child.tenant_key&&!child.tenant_scope)))continue;
        const proofs=[];
        for(const relationship of child.relationships||[]){
          if(relationship.target_resource===resource.id&&(relationship.path_depth||1)===1&&relationship.proof?.links?.length===1){
            proofs.push({relationship:relationship.id,link:relationship.proof.links[0]});
          }
        }
        for(const scope of [child.tenant_scope,child.principal_scope]){
          if(scope?.ancestor_resource===resource.id&&scope.proof?.links?.length===1){
            proofs.push({relationship:scope.path_id,link:scope.proof.links[0]});
          }
        }
        const seen=new Set();
        for(const proof of proofs){
          const link=proof.link;
          const key=proof.relationship+"\u0000"+JSON.stringify(link);
          if(seen.has(key))continue;
          seen.add(key);
          if(!link||link.constraint_name!==proof.relationship||link.source_resource!==child.id||link.target_resource!==resource.id||link.nullable||link.cardinality!=="many_to_one"||link.max_fan_out!==1||!link.source_columns?.length||link.source_columns.length!==link.target_columns?.length)continue;
          choices.push({
            child_resource:child.id,
            relationship:proof.relationship,
            label:child.id+"."+link.source_columns.join(",")+" -> "+resource.id+"."+link.target_columns.join(",")+" ("+proof.relationship+")"
          });
        }
      }
      return choices.sort((left,right)=>left.label.localeCompare(right.label));
    }

    function reviewedAnalyticsPanel(resource){
      const bands=resource.numeric_bands||[];
      const autoBands=resource.auto_bands||[];
      const automaticBandsAvailable=databaseServerCompatibility?.authority?.features?.automatic_numeric_bands!==false;
      const measures=resource.derived_measures||[];
      const fields=reviewedAnalyticsFieldChoices(resource);
      const autoBandFields=(resource.aggregate_measures||[]).slice().sort();
      const operands=reviewedAnalyticsOperandChoices(resource);
      const childCounts=reviewedChildCountChoices(resource);
      const actor=esc(byId("actor").value.trim());
      const option=value=>esc(JSON.stringify(value));
      const bandRows=bands.length?bands.map(band=>'<div class="risk"><strong>'+esc(band.label)+'</strong><p><code>'+esc(band.name)+'</code> groups '+esc(band.relationship?band.relationship+" -> "+band.field:band.field)+' into '+esc(band.bucket_labels.length)+' fixed buckets: '+esc(band.bucket_labels.join(" | "))+'</p><button class="quiet" data-remove-numeric-band="'+esc(band.name)+'" type="button">Remove this band</button></div>').join(""):'<p>No numeric bands are reviewed for this table.</p>';
      const autoBandRows=autoBands.length?autoBands.map(policy=>'<div class="risk"><strong>Automatic bands for '+esc(policy.field)+'</strong><p>The AI may choose '+esc(policy.methods.map(method=>method.replace(/_/g," ")).join(" or "))+' and '+esc(policy.min_buckets)+'-'+esc(policy.max_buckets)+' buckets. Labels are '+esc(policy.label_style)+'. Raw computed edges are never shown.</p><button class="quiet" data-remove-auto-band="'+esc(policy.field)+'" type="button">Disable automatic bands</button></div>').join(""):'<p>No automatic numeric bands are reviewed for this table.</p>';
      const measureRows=measures.length?measures.map(measure=>'<div class="risk"><strong>'+esc(measure.label)+'</strong><p><code>'+esc(measure.name)+'</code> is a fixed '+esc(measure.shape.replace(/_/g," "))+'. The AI can select its name but cannot change its reviewed definition.'+(measure.base_measure?' Runner applies it only after small-group suppression.':measure.child_resource?' Runner counts scoped child rows through '+esc(measure.child_resource)+" -> "+esc(resource.id)+" without a raw one-to-many join.":'')+'</p><button class="quiet" data-remove-derived-measure="'+esc(measure.name)+'" type="button">Remove this metric</button></div>').join(""):'<p>No named derived metrics are reviewed for this table.</p>';
      const commonReview='<div class="form-grid"><label class="field">Human reviewer<input id="analytics-review-actor" type="text" maxlength="128" value="'+actor+'"></label><label class="field">Reason for this analytics setting<textarea id="analytics-review-reason" maxlength="500" rows="2" placeholder="Explain why this metric or grouping policy is appropriate for this boundary."></textarea></label></div>';
      const bandForm=fields.length
        ?'<div class="review-form"><h4>Add a fixed numeric band</h4><p>Choose a reviewed numeric field and fixed bucket boundaries. The AI receives only the saved name and labels; it cannot supply edges.</p><div class="form-grid"><label class="field">Numeric field<select id="analytics-band-field">'+fields.map(item=>'<option value="'+option(item)+'">'+esc(item.label)+'</option>').join("")+'</select></label><label class="field">Saved name<input id="analytics-band-name" type="text" maxlength="64" placeholder="order_value_band"></label><label class="field">Plain-language label<input id="analytics-band-label" type="text" maxlength="120" placeholder="Order value band"></label><label class="field">Bucket edges<input id="analytics-band-edges" type="text" maxlength="512" placeholder="1000, 5000"></label><label class="field">Labels, lowest to highest<input id="analytics-band-labels" type="text" maxlength="2048" placeholder="Under 10 | 10 to 49 | 50 or more"></label></div><div class="actions"><button id="save-numeric-band" type="button">Save numeric band</button></div></div>'
        :'<div class="risk high"><strong>No reviewed numeric field is available.</strong><p>Review a numeric aggregate field before defining a band.</p></div>';
      const autoBandForm=!automaticBandsAvailable
        ?'<div class="risk"><strong>Automatic numeric bands are unavailable on '+esc(databaseServerCompatibility?.detected_version||"this database release")+'.</strong><p>This database release does not provide the window-function and common-table-expression support required for safe scoped edge computation. Fixed reviewed bands and Runner-side post-suppression calculations remain available. This unavailable grammar is not shown to the model.</p></div>'
        :autoBandFields.length
        ?'<div class="review-form"><h4>Allow automatic numeric bands</h4><p>Approve a bounded method once. The AI may choose only the method and bucket count; Runner computes bands from trusted scoped rows and never exposes raw edges.</p><div class="form-grid"><label class="field">Numeric field<select id="analytics-auto-band-field">'+autoBandFields.map(field=>'<option value="'+esc(field)+'">'+esc(field)+'</option>').join("")+'</select></label><label class="field">Allowed method<select id="analytics-auto-band-method"><option value="quantile">Quantile only (recommended)</option><option value="equal_width">Equal width only</option><option value="both">Quantile or equal width</option></select></label><label class="field">Fewest buckets<input id="analytics-auto-band-min" type="number" min="2" max="16" value="3"></label><label class="field">Most buckets<input id="analytics-auto-band-max" type="number" min="2" max="16" value="10"></label><label class="field">Minimum bucket width<input id="analytics-auto-band-width" type="number" min="0" step="any" placeholder="Required for equal width" disabled></label><label class="field">Labels<select id="analytics-auto-band-label-style"><option value="ordinal">Ordinal (recommended; no data-derived numbers)</option><option value="rounded">Outward-rounded ranges</option></select></label><label class="field">Round labels outward to<input id="analytics-auto-band-round" type="number" min="0" step="any" placeholder="Required for rounded labels" disabled></label></div><div class="actions"><button id="save-auto-band" type="button">Save automatic-band policy</button></div></div>'
        :'<div class="risk high"><strong>No reviewed numeric field is available for automatic bands.</strong><p>Review a numeric aggregate field first.</p></div>';
      const derivedForm=operands.length
        ?'<div class="review-form"><h4>Add a named derived metric</h4><p>Choose two existing reviewed aggregates. Runner fixes the calculation; there is no formula or SQL input.</p><div class="form-grid"><label class="field">Numerator<select id="analytics-derived-numerator">'+operands.map(item=>'<option data-relationship="'+esc(item.relationship)+'" value="'+option(item.value)+'">'+esc(item.label)+'</option>').join("")+'</select></label><label class="field">Denominator<select id="analytics-derived-denominator">'+operands.map(item=>'<option data-relationship="'+esc(item.relationship)+'" value="'+option(item.value)+'">'+esc(item.label)+'</option>').join("")+'</select></label><label class="field">Released result<select id="analytics-derived-shape"><option value="ratio">Ratio</option><option value="percentage">Percentage (ratio x 100)</option><option value="per_unit_average">Per-unit average</option></select></label><label class="field">Saved name<input id="analytics-derived-name" type="text" maxlength="64" placeholder="average_order_value"></label><label class="field">Plain-language label<input id="analytics-derived-label" type="text" maxlength="120" placeholder="Average order value"></label></div><div class="actions"><button id="save-derived-measure" type="button">Save named metric</button></div></div>'
        :'<div class="risk high"><strong>No reviewed aggregate is available.</strong><p>Review aggregate operations before defining a metric.</p></div>';
      const postForm=operands.length
        ?'<div class="review-form"><h4>Add a post-suppression calculation</h4><p>Choose one reviewed aggregate and a fixed operation. Runner calculates only from groups that passed small-group privacy; the AI receives only the saved name.</p><div class="form-grid"><label class="field">Base aggregate<select id="analytics-post-base">'+operands.map(item=>'<option value="'+option(item.value)+'">'+esc(item.label)+'</option>').join("")+'</select></label><label class="field">Calculation<select id="analytics-post-shape"><option value="running_total">Running total by time</option><option value="rank">Rank across released groups</option><option value="lag_absolute_change">Change from previous time bucket</option><option value="lag_percentage_change">Percentage change from previous time bucket</option><option value="moving_average">Moving average by time</option><option value="share_of_released_total">Percentage of released-group total</option></select></label><label class="field">Rank direction<select id="analytics-post-direction" disabled><option value="desc">Highest first</option><option value="asc">Lowest first</option></select></label><label class="field">Moving window<input id="analytics-post-window" type="number" min="2" max="12" value="3" disabled></label><label class="field">Saved name<input id="analytics-post-name" type="text" maxlength="64" placeholder="revenue_running_total"></label><label class="field">Plain-language label<input id="analytics-post-label" type="text" maxlength="120" placeholder="Revenue running total"></label></div><p id="analytics-post-grain">This calculation requires a reviewed ordered time bucket when queried. Optional dimensions partition the sequence.</p><div class="actions"><button id="save-post-measure" type="button">Save post-suppression calculation</button></div></div>'
        :'';
      const childCountForm=childCounts.length
        ?'<div class="review-form"><h4>Add a safe child-count metric</h4><p>Count child records without a raw one-to-many join. Runner fixes the catalog-proven child path, applies trusted child scope, and releases only parent cohorts of at least five.</p><div class="form-grid"><label class="field">Child relationship<select id="analytics-child-count-path">'+childCounts.map(item=>'<option value="'+option(item)+'">'+esc(item.label)+'</option>').join("")+'</select></label><label class="field">Released result<select id="analytics-child-count-shape"><option value="child_count_total">Total child rows</option><option value="child_count_average">Average child rows per parent</option></select></label><label class="field">Saved name<input id="analytics-child-count-name" type="text" maxlength="64" placeholder="orders_count"></label><label class="field">Plain-language label<input id="analytics-child-count-label" type="text" maxlength="120" placeholder="Order count"></label></div><div class="actions"><button id="save-child-count" type="button">Save child-count metric</button></div></div>'
        :'<div class="risk"><strong>No safe child-count path is available for this table.</strong><p>Add and review a child table with one non-null many-to-one foreign key into this table.</p></div>';
      return '<details class="access-secondary" data-access-secondary data-reviewed-analytics><summary>Reviewed metrics and numeric bands · '+esc(measures.length+bands.length+autoBands.length)+'</summary><p>These are digest-bound human decisions. Saving creates a disabled revision; press <strong>Review and activate</strong> after checking the complete boundary.</p><div class="risk-list">'+measureRows+bandRows+autoBandRows+'</div>'+commonReview+bandForm+autoBandForm+derivedForm+postForm+childCountForm+'<span id="analytics-review-status" class="status-message"></span></details>';
    }

    function safeAnalyticsName(value){
      return String(value||"").trim().toLowerCase().replace(/[^a-z0-9_]+/g,"_").replace(/^_+|_+$/g,"").replace(/^[0-9]/,"metric_$&").slice(0,64);
    }

    function analyticsReviewIdentity(){
      const actor=byId("analytics-review-actor")?.value.trim();
      const reason=byId("analytics-review-reason")?.value.trim();
      if(!actor||!reason)throw new Error("Enter the human reviewer identity and a concrete reason. No change was made.");
      return {actor,reason};
    }

    async function saveReviewedAnalyticsDecision(body,statusText){
      const status=byId("analytics-review-status");
      try{
        status.className="status-message";
        status.textContent="Saving this reviewed definition in the disabled boundary...";
        await post("/api/boundary/regenerate",body);
        candidateDigest=undefined;
        focusedAccessReview=true;
        document.body.classList.remove("quick-start-mode");
        await load();
        offerStagedActivation();
        byId("access-staged-summary").textContent=statusText+" Review the complete boundary, then activate it.";
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function wireReviewedAnalytics(resource){
      const field=byId("analytics-band-field");
      const bandName=byId("analytics-band-name");
      const bandLabel=byId("analytics-band-label");
      const suggestBand=()=>{
        if(!field||!bandName||bandName.value.trim())return;
        const selected=JSON.parse(field.value);
        bandName.value=safeAnalyticsName((selected.relationship?selected.relationship+"_":"")+selected.field+"_band");
        if(bandLabel&&!bandLabel.value.trim())bandLabel.value=bandName.value.replace(/_/g," ").replace(/\b\w/g,value=>value.toUpperCase());
      };
      field?.addEventListener("change",suggestBand);
      suggestBand();
      const autoMethod=byId("analytics-auto-band-method");
      const autoLabelStyle=byId("analytics-auto-band-label-style");
      const refreshAutoBandControls=()=>{
        const width=byId("analytics-auto-band-width");
        const round=byId("analytics-auto-band-round");
        if(width)width.disabled=autoMethod?.value==="quantile";
        if(round)round.disabled=autoLabelStyle?.value!=="rounded";
      };
      autoMethod?.addEventListener("change",refreshAutoBandControls);
      autoLabelStyle?.addEventListener("change",refreshAutoBandControls);
      refreshAutoBandControls();
      const numerator=byId("analytics-derived-numerator");
      const denominator=byId("analytics-derived-denominator");
      const refreshDenominators=()=>{
        if(!numerator||!denominator)return;
        const relationship=numerator.selectedOptions[0]?.dataset.relationship||"";
        [...denominator.options].forEach(option=>option.disabled=(option.dataset.relationship||"")!==relationship);
        if(denominator.selectedOptions[0]?.disabled)denominator.value=[...denominator.options].find(option=>!option.disabled)?.value||"";
      };
      numerator?.addEventListener("change",refreshDenominators);
      refreshDenominators();
      const postShape=byId("analytics-post-shape");
      const refreshPostShape=()=>{
        if(!postShape)return;
        const shape=postShape.value;
        const sequential=["running_total","lag_absolute_change","lag_percentage_change","moving_average"].includes(shape);
        byId("analytics-post-direction").disabled=shape!=="rank";
        byId("analytics-post-window").disabled=shape!=="moving_average";
        byId("analytics-post-grain").textContent=sequential
          ?"This calculation requires a reviewed ordered time bucket when queried. Optional dimensions partition the sequence."
          :"This calculation requires at least one reviewed group and no time bucket. It uses the complete released candidate set.";
        const name=byId("analytics-post-name");
        const label=byId("analytics-post-label");
        if(name&&!name.value.trim()){
          const base=JSON.parse(byId("analytics-post-base").value);
          const subject=base.function==="count"?"rows":(base.relationship?base.relationship+"_":"")+(base.field||base.function);
          name.value=safeAnalyticsName(subject+"_"+shape);
          if(label&&!label.value.trim())label.value=name.value.replace(/_/g," ").replace(/\b\w/g,value=>value.toUpperCase());
        }
      };
      postShape?.addEventListener("change",refreshPostShape);
      byId("analytics-post-base")?.addEventListener("change",()=>{
        byId("analytics-post-name").value="";
        byId("analytics-post-label").value="";
        refreshPostShape();
      });
      refreshPostShape();
      const childPath=byId("analytics-child-count-path");
      const childShape=byId("analytics-child-count-shape");
      const refreshChildCount=()=>{
        if(!childPath||!childShape)return;
        const selected=JSON.parse(childPath.value);
        const childName=selected.child_resource.split(".").pop();
        const name=byId("analytics-child-count-name");
        const label=byId("analytics-child-count-label");
        if(name&&!name.value.trim()){
          name.value=safeAnalyticsName(childShape.value==="child_count_total"?childName+"_count":"average_"+childName+"_per_parent");
          if(label&&!label.value.trim())label.value=name.value.replace(/_/g," ").replace(/\b\w/g,value=>value.toUpperCase());
        }
      };
      childPath?.addEventListener("change",()=>{
        byId("analytics-child-count-name").value="";
        byId("analytics-child-count-label").value="";
        refreshChildCount();
      });
      childShape?.addEventListener("change",()=>{
        byId("analytics-child-count-name").value="";
        byId("analytics-child-count-label").value="";
        refreshChildCount();
      });
      refreshChildCount();
      byId("save-numeric-band")?.addEventListener("click",()=>{
        try{
          const review=analyticsReviewIdentity();
          const selected=JSON.parse(field.value);
          const name=bandName.value.trim();
          const label=bandLabel.value.trim();
          const edges=byId("analytics-band-edges").value.split(",").map(value=>Number(value.trim()));
          const labels=byId("analytics-band-labels").value.split("|").map(value=>value.trim());
          if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))throw new Error("Use a saved name that starts with a letter or underscore and contains only letters, numbers, and underscores.");
          if(!label)throw new Error("Enter a plain-language label.");
          if(!edges.length||edges.length>16||edges.some((value,index)=>!Number.isFinite(value)||(index>0&&value<=edges[index-1])))throw new Error("Enter 1-16 finite bucket edges in strictly increasing order.");
          if(labels.length!==edges.length+1||labels.some(value=>!value||value.length>64)||new Set(labels).size!==labels.length||new TextEncoder().encode(JSON.stringify(labels)).byteLength>2048)throw new Error("Enter exactly one unique label per bucket, at most 64 characters each and 2 KB total.");
          saveReviewedAnalyticsDecision({kind:"numeric_band",resource_id:selectedResource,name,definition:{name,label,field:selected.field,...(selected.relationship?{relationship:selected.relationship}:{}),edges,bucket_labels:labels},...review},"Saved numeric band "+name+" for "+selectedResource+".");
        }catch(error){
          const status=byId("analytics-review-status");status.className="status-message error";status.textContent=error.message;
        }
      });
      byId("save-auto-band")?.addEventListener("click",()=>{
        try{
          const review=analyticsReviewIdentity();
          const fieldName=byId("analytics-auto-band-field").value;
          const methodChoice=autoMethod.value;
          const methods=methodChoice==="both"?["quantile","equal_width"]:[methodChoice];
          const minBuckets=Number(byId("analytics-auto-band-min").value);
          const maxBuckets=Number(byId("analytics-auto-band-max").value);
          if(!Number.isSafeInteger(minBuckets)||!Number.isSafeInteger(maxBuckets)||minBuckets<2||maxBuckets>16||minBuckets>maxBuckets)throw new Error("Choose a whole-number bucket range from 2 through 16, with the fewest no greater than the most.");
          const definition={field:fieldName,methods,min_buckets:minBuckets,max_buckets:maxBuckets,label_style:autoLabelStyle.value};
          if(methods.includes("equal_width")){
            const width=Number(byId("analytics-auto-band-width").value);
            if(!Number.isFinite(width)||width<=0)throw new Error("Enter a positive minimum bucket width for equal-width bands.");
            definition.min_bucket_width=width;
          }
          if(autoLabelStyle.value==="rounded"){
            const roundTo=Number(byId("analytics-auto-band-round").value);
            if(!Number.isFinite(roundTo)||roundTo<=0)throw new Error("Enter a positive unit for outward-rounded labels.");
            definition.label_round_to=roundTo;
          }
          saveReviewedAnalyticsDecision({kind:"auto_band",resource_id:selectedResource,field:fieldName,definition,...review},"Saved automatic numeric bands for "+selectedResource+"."+fieldName+".");
        }catch(error){
          const status=byId("analytics-review-status");status.className="status-message error";status.textContent=error.message;
        }
      });
      byId("save-derived-measure")?.addEventListener("click",()=>{
        try{
          const review=analyticsReviewIdentity();
          const numeratorValue=JSON.parse(numerator.value);
          const denominatorValue=JSON.parse(denominator.value);
          if((numeratorValue.relationship||"")!==(denominatorValue.relationship||""))throw new Error("Both aggregates must use the same reviewed table path.");
          const name=byId("analytics-derived-name").value.trim();
          const label=byId("analytics-derived-label").value.trim();
          const shape=byId("analytics-derived-shape").value;
          if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))throw new Error("Use a saved name that starts with a letter or underscore and contains only letters, numbers, and underscores.");
          if(!label)throw new Error("Enter a plain-language label.");
          if(shape==="per_unit_average"&&(numeratorValue.function!=="sum"||!["count","count_distinct"].includes(denominatorValue.function)))throw new Error("A per-unit average requires SUM divided by COUNT or COUNT DISTINCT.");
          saveReviewedAnalyticsDecision({kind:"derived_measure",resource_id:selectedResource,name,definition:{name,label,shape,numerator:numeratorValue,denominator:denominatorValue,null_policy:"null_on_zero_or_null_denominator"},...review},"Saved named metric "+name+" for "+selectedResource+".");
        }catch(error){
          const status=byId("analytics-review-status");status.className="status-message error";status.textContent=error.message;
        }
      });
      byId("save-post-measure")?.addEventListener("click",()=>{
        try{
          const review=analyticsReviewIdentity();
          const shape=byId("analytics-post-shape").value;
          const baseMeasure=JSON.parse(byId("analytics-post-base").value);
          const name=byId("analytics-post-name").value.trim();
          const label=byId("analytics-post-label").value.trim();
          if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))throw new Error("Use a saved name that starts with a letter or underscore and contains only letters, numbers, and underscores.");
          if(!label)throw new Error("Enter a plain-language label.");
          const definition={name,label,shape,base_measure:baseMeasure};
          if(shape==="rank")definition.direction=byId("analytics-post-direction").value;
          if(shape==="moving_average"){
            const windowSize=Number(byId("analytics-post-window").value);
            if(!Number.isSafeInteger(windowSize)||windowSize<2||windowSize>12)throw new Error("Choose a moving window from 2 through 12 time buckets.");
            definition.window_size=windowSize;
          }
          saveReviewedAnalyticsDecision({kind:"derived_measure",resource_id:selectedResource,name,definition,...review},"Saved post-suppression calculation "+name+" for "+selectedResource+".");
        }catch(error){
          const status=byId("analytics-review-status");status.className="status-message error";status.textContent=error.message;
        }
      });
      byId("save-child-count")?.addEventListener("click",()=>{
        try{
          const review=analyticsReviewIdentity();
          const selected=JSON.parse(childPath.value);
          const shape=childShape.value;
          const name=byId("analytics-child-count-name").value.trim();
          const label=byId("analytics-child-count-label").value.trim();
          if(!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name))throw new Error("Use a saved name that starts with a letter or underscore and contains only letters, numbers, and underscores.");
          if(!label)throw new Error("Enter a plain-language label.");
          saveReviewedAnalyticsDecision({kind:"derived_measure",resource_id:selectedResource,name,definition:{name,label,shape,child_resource:selected.child_resource,relationship:selected.relationship},...review},"Saved child-count metric "+name+" for "+selectedResource+".");
        }catch(error){
          const status=byId("analytics-review-status");status.className="status-message error";status.textContent=error.message;
        }
      });
      document.querySelectorAll("[data-remove-numeric-band]").forEach(button=>button.onclick=()=>{
        try{
          const review=analyticsReviewIdentity();
          const definition=(resource.numeric_bands||[]).find(item=>item.name===button.dataset.removeNumericBand);
          if(!definition)throw new Error("That numeric band is no longer in this disabled revision.");
          saveReviewedAnalyticsDecision({kind:"numeric_band",resource_id:selectedResource,name:definition.name,definition,remove:true,...review},"Removed numeric band "+definition.name+" from "+selectedResource+".");
        }catch(error){const status=byId("analytics-review-status");status.className="status-message error";status.textContent=error.message;}
      });
      document.querySelectorAll("[data-remove-auto-band]").forEach(button=>button.onclick=()=>{
        try{
          const review=analyticsReviewIdentity();
          const definition=(resource.auto_bands||[]).find(item=>item.field===button.dataset.removeAutoBand);
          if(!definition)throw new Error("That automatic-band policy is no longer in this disabled revision.");
          saveReviewedAnalyticsDecision({kind:"auto_band",resource_id:selectedResource,field:definition.field,definition,remove:true,...review},"Disabled automatic numeric bands for "+selectedResource+"."+definition.field+".");
        }catch(error){const status=byId("analytics-review-status");status.className="status-message error";status.textContent=error.message;}
      });
      document.querySelectorAll("[data-remove-derived-measure]").forEach(button=>button.onclick=()=>{
        try{
          const review=analyticsReviewIdentity();
          const definition=(resource.derived_measures||[]).find(item=>item.name===button.dataset.removeDerivedMeasure);
          if(!definition)throw new Error("That named metric is no longer in this disabled revision.");
          saveReviewedAnalyticsDecision({kind:"derived_measure",resource_id:selectedResource,name:definition.name,definition,remove:true,...review},"Removed named metric "+definition.name+" from "+selectedResource+".");
        }catch(error){const status=byId("analytics-review-status");status.className="status-message error";status.textContent=error.message;}
      });
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
      return '<div class="risk '+(selected?"unresolved":"high")+'"><strong>'+esc(heading)+'</strong><p><strong>Why:</strong> '+esc(reason)+'</p><p><strong>If unresolved:</strong> This table or view stays unavailable to the agent.</p><p><strong>Safety consequence:</strong> '+esc(inference.safety_consequence||"A wrong choice could widen access.")+'</p>'
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

    function managedTrustedScopeReviewForm(kind,label,directValues,currentDirect,allowNone,directInference,derivedInference,currentDerived,sharedInference,currentShared){
      const pathKind=kind==="tenant_key"?"tenant_scope_path":"principal_scope_path";
      const ranked=(directInference?.alternatives_considered||[]).map(item=>item.value);
      const direct=[...new Set([...ranked,...directValues])].map(value=>({
        value,
        label:"Direct column "+value,
        kind
      }));
      const derived=(derivedInference?.candidates||[]).map(scope=>({
        value:scope.path_id,
        label:derivedScopePathLabel(scope)+' · '+(scope.proof?.links?.length||0)+' hop'+((scope.proof?.links?.length||0)===1?'':'s'),
        kind:pathKind,
        depth:scope.proof?.links?.length||0,
        scope
      }));
      const shared=kind==="tenant_key"&&sharedInference?.eligible?[{
        value:"table_has_no_per_tenant_rows",
        label:"Shared reference - same rows for every tenant",
        kind:"shared_reference_scope"
      }]:[];
      const options=[
        ...(allowNone?[{value:"__none__",label:"No per-user row limit",kind:"principal_key"}]:[]),
        ...direct,
        ...derived,
        ...shared
      ];
      if(!options.length){
        return '<div class="risk high"><strong>No proven '+esc(label)+' is available.</strong><p>Add a direct scope column or a required foreign-key path to a directly scoped ancestor, then rescan.</p></div>';
      }
      const selectedKind=currentShared?"shared_reference_scope":currentDerived?pathKind:kind;
      const selectedValue=currentShared?.acknowledgement||currentDerived||currentDirect||(allowNone?"__none__":undefined);
      const selectedDerived=derived.find(option=>option.value===selectedValue);
      const exactPathIds=derived.length
        ?'<details class="access-secondary"><summary>Advanced exact path IDs</summary><p>Use these canonical IDs only with scripted <code>--'+esc(pathKind.replaceAll("_","-"))+'</code> review. Human review and enforcement still refer to the readable mandatory path above.</p><ul>'+derived.map(option=>'<li><code>'+esc(option.value)+'</code> · '+esc(option.label)+'</li>').join("")+'</ul></details>'
        :"";
      const explanation=inferenceExplanation(label,directInference)
        +(derivedInference?'<div class="risk unresolved"><strong>Relationship-carried scope available</strong><p>Runner will inject the selected path into every read. The AI cannot remove, weaken, or choose this join.</p><p><strong>Safety consequence:</strong> '+esc(derivedInference.safety_consequence)+'</p></div>':"")
        +(sharedInference?.eligible?'<div class="risk high"><strong>Shared reference is an owner assertion, not an automatic inference.</strong><p>Select it only when this table has no per-tenant rows and every tenant may receive the same reviewed rows. Field visibility, cohort suppression, and budgets still apply.</p></div>':"");
      const sharedConfirmation=sharedInference?.eligible?'<label class="check"><input data-shared-reference-ack type="checkbox"><span>I confirm this table has no per-tenant rows and every tenant may receive the same reviewed rows. Required when Shared reference is selected.</span></label>':"";
      return explanation+(selectedDerived?derivedScopeCostAdvisory(selectedDerived.scope):'')+'<div class="review-form" data-scope-review-form><h3>Confirm or change the '+esc(label)+'</h3><div class="form-grid"><label class="field">Reviewed scope<select data-scope-review-value>'+options.map(option=>'<option value="'+esc(option.value)+'" data-review-kind="'+esc(option.kind)+'" '+(option.depth?'data-review-depth="'+esc(option.depth)+'" ':'')+(selectedKind===option.kind&&selectedValue===option.value?"selected":"")+'>'+esc(option.label)+'</option>').join("")+'</select></label><label class="field">Human reviewer<input data-scope-review-actor type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><label class="field">Why is this correct?<textarea data-scope-review-reason maxlength="500" rows="2" placeholder="Describe why this direct column, mandatory path, or shared-reference assertion is correct."></textarea></label></div>'+sharedConfirmation+'<div class="actions"><button data-submit-scope-review="'+esc(kind)+'" type="button">Save this reviewed choice</button></div><span data-scope-review-status class="status-message"></span></div>'+exactPathIds;
    }

    function invalidateResourceReview(id){
      resourceDecisions(id).forEach(decision=>confirmedDecisions.delete(decision));
      invalidateDigest();
      queueReviewProgressSave();
    }

	    function invalidateDigest(){
	      const hadDigest=Boolean(candidateDigest);
	      candidateDigest=undefined;
	      updateActivationState();
	      if(hadDigest){
	        const message=byId("message");
	        message.className="status-message";
	        message.textContent="Reviewed access changed. Activate and ask will create and revalidate a new exact fingerprint.";
	      }
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
	          updateActivationState();
	          message.className="status-message error";
	          message.textContent="Review progress was not saved: "+error.message;
	        }
      });
      return progressSave;
    }

	    function renderResourceDetail(){
      if(!selectedResource){
        byId("resource-detail").innerHTML="<p>Select a "+(reviewedCollectionLabel()==="tables"?"table":"table or view")+" from the list.</p>";
        renderGlobalDecisions();
        renderStagedAccessBar();
        return;
      }
	      const source=original.pack.resources.find(resource=>resource.id===selectedResource);
	      const resource=currentResource(selectedResource);
	      const review=reviewResource(selectedResource);
	      if(!review){
	        byId("resource-detail").innerHTML="<p>This table or view is no longer present in the managed draft.</p>";
	        renderStagedAccessBar();
	        return;
	      }
	      const boundarySpecificSharedReferenceReview=Boolean(
	        !resource&&source?.shared_reference_scope&&review.shared_reference_scope?.eligible
	      );
	      const selectedKind=reviewedResourceKind(selectedResource);
	      const fields=review.fields||[];
	      const orderedFields=[...fields].sort((left,right)=>{
	        if(left.name===highlightedAccessField)return -1;
	        if(right.name===highlightedAccessField)return 1;
	        return left.name.localeCompare(right.name);
	      });
	      const renderColumnRow=field=>{
	        const classification=field.sensitivity||{state:"structurally_low_risk",reason_codes:[],reasons:[]};
	        const sensitive=classification.state!=="structurally_low_risk";
	        const reviewedTier=resource?reviewedFieldAccessTier(resource,field.name):null;
	        const kept=reviewedTier==="kept_out"||(!source&&sensitive);
	        const withheld=reviewedTier==="runner_only";
	        const operationRepairNeeded=fieldNeedsOperationRepair(resource,source,field.name);
	        const supportsVisibility=Boolean(source&&(
	          fieldHas(source,field.name,"selectable_fields")
	          ||fieldHas(source,field.name,"filterable_fields")
	          ||fieldHas(source,field.name,"sortable_fields")
	          ||fieldHas(source,field.name,"groupable_fields")
	          ||fieldHas(source,field.name,"aggregate_measures")
	          ||fieldHas(source,field.name,"count_distinct_fields")
	          ||fieldHas(source,field.name,"time_bucket_fields")
	        ));
	        const visible=reviewedTier==="visible"&&supportsVisibility;
		        const available=Boolean(source&&resource);
		        const trustedScopeField=field.name===source?.tenant_key||field.name===source?.principal_key;
		        const tier=kept
	          ?"kept_out"
	          :!available||!supportsVisibility
	            ?"unavailable"
	            :withheld
	              ?"withheld"
	              :"visible";
		        const disabled=!available||tier==="unavailable";
	        const riskLabel=field.name===source?.tenant_key
	          ?"trusted customer scope"
	          :field.name===source?.principal_key
	            ?"trusted user scope"
	            :field.review_override&&classification.state==="structurally_low_risk"
	              ?"recorded owner decision"
	              :conciseFieldRisk(field);
	        const riskTitle=[...(classification.reasons||[]),field.review_override?.reason].filter(Boolean).join(" ");
	        const stateBadge=trustedScopeField&&visible
	          ?'<span class="badge warn" title="Runner enforces this scope outside model arguments; this reviewed output choice permits its value to enter model context.">Trusted scope · Model + Runner</span>'
	          :trustedScopeField&&withheld
	          ?'<span class="badge warn" title="Runner enforces this scope outside model arguments and may show the reviewed raw value only in the local verified result.">Trusted scope · Raw values: Runner only</span>'
		          :trustedScopeField&&kept
		            ?'<span class="badge good" title="Runner enforces this scope outside model arguments; its raw value remains unavailable to the model and local result.">Trusted scope · Kept out</span>'
		          :kept
		            ?'<span class="badge good" title="'+esc(riskTitle)+'">Kept out · '+esc(riskLabel)+'</span>'
		          :withheld
	            ?'<span class="badge warn" title="Withheld from model: raw values stay in the local verified result or become response-only tokens. Reviewed derived results may still reach the model.">Raw values: Runner only</span>'
	          :sensitive
	            ?'<span class="badge warn" title="'+esc(riskTitle)+'">'+esc(field.review_override?"Reviewed":"Needs review")+' · '+esc(riskLabel)+'</span>'
	            :!visible
	              ?'<span class="badge">Not visible</span>'
	              :"";
	        const operationRepairBadge=operationRepairNeeded
	          ?'<span class="badge warn" title="This field is usable without analytical operations, while the current inspection offers safe suggestions. Restore them only when that access is intended, then review and activate.">Optional operation restore</span>'
	          :"";
	        const unavailableBadge=!available
	          ?'<span class="badge bad">'+esc(selectedKind.replace(/^./,char=>char.toUpperCase()))+' unavailable</span>'
	          :!supportsVisibility&&!kept
	            ?'<span class="badge">Aggregate/filter only</span>'
	            :"";
	        const consequence=operationRepairNeeded
	          ?"This field may be returned, but it has no filter, sort, group, or measure grant. Leave it return-only or explicitly restore the current inspected suggestions below."
	          :trustedScopeField&&tier==="visible"
	          ?"Scope remains fixed outside model arguments. The reviewed value may appear locally and enter model context."
	          :trustedScopeField&&tier==="withheld"
	          ?"Scope remains fixed outside model arguments. Runner may show the value locally; the model receives only a response-local token."
	          :trustedScopeField
	            ?"Scope remains fixed outside model arguments. The raw value is unavailable in results."
		            :tier==="visible"
		              ?"Values may enter the selected model provider."
		          :tier==="withheld"
	            ?"Usable in reviewed plans. Raw values stay local or become response-only tokens; reviewed derived results remain available."
	            :tier==="kept_out"
	              ?"Unavailable for selection, filtering, grouping, sorting, or measures. Re-including it restores only the current inspected operation suggestions in the disabled draft."
	              :"Unavailable until this table's safe identity and scope are resolved.";
		        const tierControl='<label class="access-column-tier">Access tier<select data-field-tier data-field-resource="'+esc(selectedResource)+'" data-field-name="'+esc(field.name)+'" data-current-tier="'+esc(tier)+'" data-trusted-scope="'+esc(String(trustedScopeField))+'" '+(disabled?"disabled":"")+'>'
	          +'<option value="visible" '+(tier==="visible"?"selected":"")+'>Model + Runner</option>'
	          +'<option value="withheld" '+(tier==="withheld"?"selected":"")+'>Raw values: Runner only</option>'
		          +'<option value="kept_out" '+(tier==="kept_out"?"selected":"")+'>Kept out</option>'
		          +'</select><span class="access-column-consequence">'+esc(consequence)+'</span></label>';
	        const reviewForms=!resource||disabled
		          ?""
		          :trustedScopeField
	            ?[
	              tier!=="visible"?managedReviewForm(field.name,"allow_reviewed_use","Why may this fixed trusted-scope value enter model context while its predicate remains fixed outside model arguments?"):"",
	              tier!=="withheld"?managedReviewForm(field.name,"withhold_from_model","Why may Runner show this fixed trusted-scope value only in the local verified result?"):"",
		              tier!=="kept_out"?managedReviewForm(field.name,"keep_out","Why should this trusted-scope value remain unavailable in local results?"):""
		            ].join("")
		            :[
		              tier!=="visible"?managedReviewForm(field.name,"allow_reviewed_use","Why may this field's values enter model context?"):"",
		              tier!=="withheld"?managedReviewForm(field.name,"withhold_from_model","Why may the agent use this field while its values stay out of model context?"):"",
	              tier!=="kept_out"?managedReviewForm(field.name,"keep_out","Why should this field become unavailable to plans?"):""
	            ].join("");
	        const operationRepairExposure=withheld?"withhold_from_model":"allow_reviewed_use";
	        const operationRepairControl=operationRepairNeeded
	          ?'<div class="band notice"><strong>Optional analytical operation restore</strong><p>If this field should not remain return-only, Runner can restore the current type-, allowlist-, and server-compatible suggestions. This stages a new digest and does not activate it.</p><button class="secondary" data-restore-field-operations="'+esc(field.name)+'" data-exposure="'+esc(operationRepairExposure)+'" type="button">Restore current suggested operations</button></div>'
	          :"";
	        const operationRepairForm=operationRepairNeeded
	          ?managedReviewForm(field.name,operationRepairExposure,"Why should Runner restore the current inspected analytical suggestions for this field?")
	          :"";
		        const schemaEnum=Array.isArray(field.enum_values)?field.enum_values:[];
		        const enumReviewable=Boolean(resource&&schemaEnum.length&&(Object.hasOwn(source?.field_enums||{},field.name)||field.enum_review_override));
		        const reviewedEnum=enumReviewable
		          ?Object.hasOwn(resource.field_enums||{},field.name)
		            ?resource.field_enums[field.name]
		            :field.enum_review_override?[]:schemaEnum
		          :[];
		        const enumControl=enumReviewable
		          ?managedEnumReviewPanel(field.name,schemaEnum,reviewedEnum,field.enum_review_override)
		          :"";
		        const fieldMetadata=resource?.field_metadata?.[field.name];
		        const metadataControl=resource
		          ?managedMetadataReviewPanel("field_metadata",field.name,fieldMetadata)
		          :"";
		        const fieldName=fieldMetadata?.label
		          ?'<strong>'+esc(fieldMetadata.label)+'</strong><small><code>'+esc(field.name)+'</code></small>'
		          :'<strong><code>'+esc(field.name)+'</code></strong>';
		        const highlighted=field.name===highlightedAccessField;
		        return '<div class="access-column '+(highlighted?"highlighted":"")+'" data-access-column="'+esc(field.name)+'" data-column-kept-out="'+esc(String(kept))+'" '+(highlighted?'data-access-highlighted="true"':"")+'>'
	          +'<span class="access-column-copy">'+fieldName+'<small>'+esc(field.data_type||source?.field_types?.[field.name]||"unknown type")+'</small>'+(fieldMetadata?.description?'<small>'+esc(fieldMetadata.description)+'</small>':"")+'<span class="access-column-risk">'+stateBadge+operationRepairBadge+unavailableBadge+'</span></span>'
	          +tierControl
	          +reviewForms
	          +operationRepairControl
	          +operationRepairForm
		          +enumControl
		          +metadataControl
		          +'</div>';
	      };
	      const columnList='<div class="access-column-list" data-access-column-list>'+orderedFields.map(renderColumnRow).join("")+'</div>';
		      const privacyButton=resource?'<button class="quiet" id="open-resource-privacy" type="button">Privacy · minimum group '+esc(resource.minimum_cohort_size)+'</button>':"";
		      const resourceMetadata=resource?managedMetadataReviewPanel("resource_metadata",undefined,{label:resource.label,description:resource.description}):"";
		      const resourceHeading=resource?.label
		        ?'<h3>'+esc(resource.label)+'</h3><p><code>'+esc(selectedResource)+'</code></p>'
		        :'<h3>'+esc(selectedResource)+'</h3>';
		      const serverCompatibilityLimits=[];
		      if(databaseServerCompatibility?.authority?.features?.schema_check_constraints===false){
		        serverCompatibilityLimits.push("Text-like categorical fields need a bounded native ENUM before Runner offers grouping or categorical filtering.");
		      }
		      if(databaseServerCompatibility?.authority?.features?.automatic_numeric_bands===false){
		        serverCompatibilityLimits.push("Automatic numeric bands are unavailable.");
		      }
		      const serverCompatibilityNotice=databaseServerCompatibility?.tier==="compatible_limited"
		        ?'<div class="risk"><strong>Supported limited database grammar · '+esc(databaseServerCompatibility.detected_version)+'</strong><p>'+esc(serverCompatibilityLimits.join(" "))+' Fixed bands, numeric/time analysis, derived scope, and Runner-side post-suppression calculations remain available.</p></div>'
		        :"";
		      const header='<div class="split-actions"><div>'+resourceHeading+'<p>'+(source
	        ?'Choose one explicit tier per column. Visible values may enter model context. Runner-only raw fields remain usable: raw values stay local or become response-only tokens, while reviewed derived results remain available. Kept-out columns cannot be used.'
		        :'<span class="badge bad">Blocked</span> Its columns remain visible for diagnosis, but no authority can be activated yet.')+'</p></div><div class="actions">'+privacyButton+'<button class="secondary" id="back-resources" type="button">Back to '+esc(reviewedCollectionLabel())+'</button></div></div>'
	        +'<div class="split-actions"><div><h3>Columns</h3><p>'+(focusedAccessReview
	          ?"Ordinary access choices are staged immediately. Exposing sensitive data still requires an explicit reviewer and reason."
	          :"Changing a tier opens a recorded human review. It stages a new digest and never activates access by itself.")+'</p></div>'
	        +(!resource&&source
	          ?boundarySpecificSharedReferenceReview
	            ?'<span class="badge warn">Boundary-specific Shared reference review required below</span>'
	            :'<button id="include-selected-resource" class="secondary" type="button">Include this '+esc(selectedKind)+'</button>'
	          :resource&&source
	            ?'<button id="remove-selected-resource" class="secondary" type="button" '+(candidate.pack.resources.length<=1?'disabled title="A boundary must retain at least one table."':"")+'>Remove this '+esc(selectedKind)+'</button>'
	            :"")
	        +'</div>';
	      if(!source){
	        const kept=fields.filter(field=>field.sensitivity?.state!=="structurally_low_risk").map(field=>field.name);
          const resolvingIdentity=!review.primary_key?.selected;
          const decisionLabel=resolvingIdentity?"record ID backed by a unique database key":"customer-isolation column";
          const resolution=resolvingIdentity
            ?(review.primary_key?.candidates||[]).length
              ?'<p>Your choice updates the disabled reviewed boundary and its fingerprint. It does not activate access.</p>'+managedScopeReviewForm("row_identity",decisionLabel,review.primary_key.candidates,undefined,false,review.primary_key)
              :'<div class="risk high"><strong>No safe '+esc(decisionLabel)+' candidate exists.</strong><p>Add a single-column primary or unique key in the database, then rescan. Runner will not accept a friendly ORM or API name as row-identity proof.</p></div>'
            :'<p>Your choice updates the disabled reviewed boundary and its fingerprint. It does not activate access.</p>'+managedTrustedScopeReviewForm(
              "tenant_key",
              "customer isolation",
              review.tenant_key?.candidates||[],
              review.tenant_key?.selected,
              false,
              review.tenant_key,
              review.derived_tenant_scope,
              review.derived_tenant_scope?.selected?.path_id,
              review.shared_reference_scope,
              review.shared_reference_scope?.selected
            );
	        const derivedTenantCandidates=(review.derived_tenant_scope?.candidates||[]).map(derivedScopePathLabel);
	        const scopeGuidance=review.scope_resolution_guidance;
	        const reviewedDepth=Number(candidate?.budgets?.max_derived_scope_hops??candidate?.budgets?.max_relationship_hops??2);
	        const scopeExplanation=scopeGuidance?'<div class="risk-list">'+scopeGuidance.why.map(reason=>'<div class="risk unresolved"><strong>Why this table is unavailable</strong><p>'+esc(reason)+'</p></div>').join("")+'</div><div class="band notice"><strong>What makes it addable</strong><ul>'+scopeGuidance.remediation.map(action=>'<li>'+esc(action)+'</li>').join("")+'</ul></div>':derivedTenantCandidates.length?'<div class="band notice"><strong>Proven tenant scope is available</strong><p>Choose one exact mandatory relationship path below. Paths are reviewed ancestor-first and remain outside model arguments.</p><ul>'+(review.derived_tenant_scope?.candidates||[]).map(path=>{const depth=path.proof?.links?.length||1;const joinColumns=derivedScopeJoinColumns(path);return '<li><strong>Tenant scope available ('+esc(depth)+' hop'+(depth===1?'':'s')+')</strong><p>'+esc(derivedScopePathChain(path))+'</p>'+(joinColumns?'<p>via columns: <code>'+esc(joinColumns)+'</code></p>':'')+'<p>path ID: <code>'+esc(path.path_id)+'</code></p>'+(depth>reviewedDepth?'<p>Needs max_derived_scope_hops '+esc(depth)+' (currently '+esc(reviewedDepth)+').</p>':'')+'</li>';}).join("")+'</ul></div>':'';
	        const blockedDetails='<details class="access-secondary" data-access-secondary open><summary>Resolve blocked access</summary><div class="risk-list">'+(review.blockers||[]).map(blocker=>'<div class="risk high"><strong>'+esc(blocker)+'</strong><p>This object stays unavailable; unrelated safe resources can continue.</p></div>').join("")+'</div>'+scopeExplanation+'<div class="scope-grid" style="margin-top:12px"><div><strong>Row identity candidates</strong><p>'+esc((review.primary_key?.candidates||[]).join(", ")||"none")+'</p></div><div><strong>Direct tenant columns</strong><p>'+esc((review.tenant_key?.candidates||[]).join(", ")||"none")+'</p></div><div><strong>Mandatory proven tenant paths</strong><p>'+esc(derivedTenantCandidates.join("; ")||"none")+'</p></div></div>'+resolution+'<p>Sensitive or unresolved fields kept unavailable: '+esc(kept.join(", ")||"none detected")+'.</p></details>';
	        byId("resource-detail").innerHTML=header+serverCompatibilityNotice+blockedDetails+columnList;
		      byId("back-resources").onclick=backFromResourceDetail;
		      if(byId("open-resource-privacy"))byId("open-resource-privacy").onclick=()=>{
		        const section=document.querySelector("[data-cohort-review-section]");
		        if(!section)return;
		        section.open=true;
		        section.scrollIntoView({behavior:"auto",block:"center"});
		        section.querySelector("[data-cohort-review-value]")?.focus();
		      };
          document.querySelectorAll("[data-submit-scope-review]").forEach(button=>button.onclick=()=>submitManagedScopeReview(button.dataset.submitScopeReview,button.closest("[data-scope-review-form]")));
	        renderGlobalDecisions();
	        renderStagedAccessBar();
	        focusHighlightedAccessField();
	        return;
	      }
      const resourceConfirmed=resourceDecisions(selectedResource).every(decision=>confirmedDecisions.has(decision));
      const fieldNames=Object.keys(source.field_types).sort();
      const advancedPermissions=permissions.filter(item=>item[1]!=="selectable_fields");
      const permissionRows=resource?fieldNames.map(field=>{
        const cells=advancedPermissions.map(item=>{
          if(!fieldHas(source,field,item[1]))return '<td><span class="permission">Not available</span></td>';
          return '<td><span class="permission"><input type="checkbox" aria-label="'+esc(item[0]+" "+field)+'" data-permission-field="'+esc(field)+'" data-permission-key="'+esc(item[1])+'" '+(fieldHas(resource,field,item[1])?"checked":"")+(resource.kept_out_fields.includes(field)?" disabled":"")+'></span></td>';
        }).join("");
        return '<tr><td><code>'+esc(field)+'</code></td>'+cells+'</tr>';
      }).join(""):"";
      const advanced=resource
        ?'<details class="access-secondary" data-access-secondary><summary>Advanced field operations</summary><p>Turning a permission off narrows access. Fields hidden by Runner cannot be restored here. A usable field with no analytical grants is marked above and may restore all current safe suggestions in one reviewed action.</p><div style="overflow:auto"><table class="permission-table"><thead><tr><th>Field</th>'+advancedPermissions.map(item=>'<th>'+esc(item[0])+'</th>').join("")+'</tr></thead><tbody>'+permissionRows+'</tbody></table></div></details>'
        :'<details class="access-secondary" data-access-secondary><summary>Advanced field operations</summary><p>This '+esc(selectedKind)+' is excluded. Include it before changing analytical permissions.</p></details>';
      const organizationScopeReview=candidate.organization_scope
        ?'<div class="risk"><strong>Whole reviewed organization</strong><p>'+esc(candidate.organization_scope.organization_id)+' is fixed outside model arguments. This boundary applies no tenant predicate; changing that posture requires regenerating and reviewing the complete boundary.</p></div>'
        :managedTrustedScopeReviewForm("tenant_key","customer isolation",review.tenant_key?.candidates||[],source.tenant_key,false,review.tenant_key,review.derived_tenant_scope,source.tenant_scope?.path_id,review.shared_reference_scope,source.shared_reference_scope);
      const scopeReview=resource
        ?'<details class="access-secondary" data-access-secondary><summary>Record and customer limits</summary><p>'+(candidate.organization_scope?'The reviewed organization is fixed outside the model. Any user/owner limit still comes from trusted application context.':'Runner reads tenant and user values from trusted application context. The AI never supplies them or controls a mandatory relationship path.')+'</p>'+managedScopeReviewForm("row_identity","record ID",review.primary_key?.candidates||[],source.primary_key,false,review.primary_key)+organizationScopeReview+managedTrustedScopeReviewForm("principal_key","user/owner limit",[...new Set([...(review.principal_key?.candidates||[]),...(review.fields||[]).filter(field=>field.nullable===false&&!/(?:bytea|blob|binary|varbinary|image)/i.test(field.data_type)).map(field=>field.name)])],source.principal_key,true,review.principal_key,review.derived_principal_scope,source.principal_scope?.path_id)+'</details>'
        :boundarySpecificSharedReferenceReview
          ?'<details class="access-secondary" data-access-secondary open><summary>Review Shared reference and include</summary><p>This acknowledgement belongs to the selected boundary. An acknowledgement recorded for another boundary is never copied.</p>'+managedTrustedScopeReviewForm("tenant_key","customer isolation",review.tenant_key?.candidates||[],undefined,false,review.tenant_key,review.derived_tenant_scope,undefined,review.shared_reference_scope,undefined)+'</details>'
          :'<details class="access-secondary" data-access-secondary><summary>Record and customer limits</summary><p>This '+esc(selectedKind)+' is excluded. Include it before reviewing trusted scope.</p></details>';
      const cohortDecision=review.minimum_cohort_override;
      const cohortValue=resource?.minimum_cohort_size??5;
      const cohortWarning=cohortValue===1
        ?'<div class="risk high"><strong>Small-group suppression is disabled.</strong><p>Groups of one identify individuals. Protect and protected-capability activation will each require another explicit confirmation.</p></div>'
        :"";
      const cohortReview=resource?'<details class="access-secondary" data-access-secondary data-cohort-review-section><summary>Aggregate privacy · minimum group size '+esc(cohortValue)+'</summary><p><strong>Current minimum group size:</strong> '+esc(cohortValue)+' '+(cohortDecision?'<span class="badge warn">Explicit owner override</span>':'<span class="badge good">Default</span>')+'</p><p>Runner hides aggregate groups with fewer rows than this number. Choosing 1 shows every non-empty group and may identify one person or record. The AI cannot change or confirm this setting.</p>'
        +(cohortDecision?'<p>Reviewed by '+esc(cohortDecision.actor)+' at '+esc(cohortDecision.decided_at)+': '+esc(cohortDecision.reason)+'</p>':"")
        +cohortWarning
        +'<div class="review-form" data-cohort-review-form><div class="form-grid"><label class="field">Minimum group size<select data-cohort-review-value><option value="5" '+(cohortValue===5?"selected":"")+'>5 — default; hide groups with 1–4 rows</option><option value="4" '+(cohortValue===4?"selected":"")+'>4 — hide groups with 1–3 rows</option><option value="3" '+(cohortValue===3?"selected":"")+'>3 — hide groups with 1–2 rows</option><option value="2" '+(cohortValue===2?"selected":"")+'>2 — hide groups with 1 row</option><option value="1" '+(cohortValue===1?"selected":"")+'>1 — show every non-empty group; suppression off</option></select></label><label class="field">Human reviewer<input data-cohort-review-actor type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><label class="field">Reason for this privacy setting<textarea data-cohort-review-reason maxlength="500" rows="2" placeholder="Explain why this minimum group size is appropriate for this table."></textarea></label></div><div class="actions"><button data-submit-cohort-review type="button">Save privacy change</button></div><span data-cohort-review-status class="status-message"></span></div></details>':"";
      const reviewedAnalytics=resource?reviewedAnalyticsPanel(resource):"";
      const unresolvedRelationship=resource?.relationships.some(relationship=>relationship.unmatched_rows==="review_required");
      const relationshipReview=resource?.relationships.length
        ?'<details class="access-secondary" data-access-secondary '+(focusedAccessReview&&unresolvedRelationship?"open":"")+'><summary>Reviewed related data'+(unresolvedRelationship?" · choice required":"")+'</summary><p>Only database foreign keys that cannot multiply '+esc(source.table)+' records are available. The AI cannot invent another join.</p><div class="risk-list">'+resource.relationships.map(relationship=>{
          const links=relationship.proof?.links||[];
          const constraints=links.map(link=>link.constraint_name+" ("+link.source_resource+" → "+link.target_resource+")").join("; ")||relationship.id;
          const nullable=relationship.nullable===true;
          const choice=relationship.unmatched_rows||"exclude";
          return '<div class="risk '+(choice==="review_required"?"unresolved":"")+'"><strong>'+esc(relationship.target_resource)+'</strong><p>'+esc((relationship.path_depth||1)+" proven many-to-one link"+((relationship.path_depth||1)===1?"":"s")+". Evidence: "+constraints+".")+'</p>'
            +(nullable?'<label class="field">When a related record is missing<select data-relationship-semantics="'+esc(relationship.id)+'"><option value="review_required" '+(choice==="review_required"?"selected":"")+' disabled>Choose explicitly</option><option value="keep_null" '+(choice==="keep_null"?"selected":"")+'>Keep the counted record and show an empty group value</option><option value="exclude" '+(choice==="exclude"?"selected":"")+'>Exclude the counted record from this analysis</option></select></label><p>This choice changes business totals and is bound into the review fingerprint.</p>':'<p>The foreign-key columns are required, so an inner match does not silently drop valid counted records.</p>')
            +'</div>';
        }).join("")+'</div></details>'
        :'<details class="access-secondary" data-access-secondary><summary>Reviewed related data</summary><p>No related data is proposed for this area.</p></details>';
	      const resourceSignoff=focusedAccessReview
	        ?'<div class="band notice"><strong>One final confirmation, not one checkbox per table.</strong><p>Step 2 shows this table together with the complete boundary, then records every exact digest-bound decision at once.</p></div>'
	        :'<div class="actions"><label class="check"><input id="resource-signoff" type="checkbox" data-review-decision="'+esc(selectedResource)+'" '+(resourceConfirmed?"checked":"")+(resource&&!unresolvedRelationship?"":" disabled")+'><span>I reviewed which records and fields this agent may use, including privacy limits and related data.</span></label></div>';
	      byId("resource-detail").innerHTML=header+serverCompatibilityNotice+resourceMetadata+columnList+scopeReview+relationshipReview+cohortReview+reviewedAnalytics+advanced+resourceSignoff;
	      byId("back-resources").onclick=backFromResourceDetail;
	      if(byId("open-resource-privacy"))byId("open-resource-privacy").onclick=()=>{
	        const section=document.querySelector("[data-cohort-review-section]");
	        if(!section)return;
	        section.open=true;
	        section.scrollIntoView({behavior:"auto",block:"center"});
	        section.querySelector("[data-cohort-review-value]")?.focus();
	      };
      byId("include-selected-resource")?.addEventListener("click",()=>{
        toggleResource(selectedResource,true);
        renderResourceDetail();
      });
      byId("remove-selected-resource")?.addEventListener("click",()=>{
        if(!toggleResource(selectedResource,false))return;
        selectedResource=null;
        renderResourceNavigation();
        renderResourceDetail();
      });
      document.querySelectorAll("[data-field-tier]").forEach(input=>input.onchange=()=>{
        const nextTier=input.value;
        const currentTier=input.dataset.currentTier;
        input.value=currentTier;
        if(nextTier===currentTier)return;
	      const exposure=nextTier==="visible"
          ?"allow_reviewed_use"
          :nextTier==="withheld"
            ?"withhold_from_model"
            :"keep_out";
        if(focusedAccessReview&&!focusedFieldChangeNeedsExplicitReview(input.dataset.fieldName,currentTier,nextTier)){
          submitFocusedFieldReview(input.dataset.fieldName,exposure);
        }else{
          openManagedFieldReview(input.dataset.fieldName,exposure);
        }
      });
      document.querySelectorAll("[data-open-field-review]").forEach(button=>button.onclick=()=>openManagedFieldReview(button.dataset.openFieldReview,button.dataset.exposure));
	      document.querySelectorAll("[data-restore-field-operations]").forEach(button=>button.onclick=()=>{
	        if(focusedAccessReview)submitFocusedFieldReview(button.dataset.restoreFieldOperations,button.dataset.exposure);
	        else openManagedFieldReview(button.dataset.restoreFieldOperations,button.dataset.exposure);
	      });
	      document.querySelectorAll("[data-submit-field-review]").forEach(button=>button.onclick=()=>submitManagedFieldReview(button.dataset.submitFieldReview,button.dataset.exposure));
	      document.querySelectorAll("[data-cancel-field-review]").forEach(button=>button.onclick=()=>button.closest("[data-managed-review-form]").classList.add("hidden"));
	      document.querySelectorAll("[data-submit-enum-review]").forEach(button=>button.onclick=()=>submitManagedEnumReview(button.dataset.submitEnumReview,button.closest("[data-enum-review-form]")));
      document.querySelectorAll("[data-submit-metadata-review]").forEach(button=>button.onclick=()=>submitManagedMetadataReview(button.closest("[data-metadata-review-form]")));
      document.querySelectorAll("[data-submit-scope-review]").forEach(button=>button.onclick=()=>submitManagedScopeReview(button.dataset.submitScopeReview,button.closest("[data-scope-review-form]")));
      document.querySelectorAll("[data-submit-cohort-review]").forEach(button=>button.onclick=()=>submitManagedCohortReview(button.closest("[data-cohort-review-form]")));
      if(resource)wireReviewedAnalytics(resource);
      document.querySelectorAll("[data-permission-field]").forEach(input=>input.onchange=()=>setPermission(selectedResource,input.dataset.permissionField,input.dataset.permissionKey,input.checked));
      document.querySelectorAll("[data-relationship-semantics]").forEach(input=>input.onchange=()=>setRelationshipSemantics(selectedResource,input.dataset.relationshipSemantics,input.value));
      if(byId("resource-signoff"))byId("resource-signoff").onchange=async event=>{
          const decisions=resourceDecisions(selectedResource);
          if(event.currentTarget.checked)decisions.forEach(decision=>confirmedDecisions.add(decision));
          else decisions.forEach(decision=>confirmedDecisions.delete(decision));
          invalidateDigest();
          await queueReviewProgressSave();
          renderGlobalDecisions();
          continueAfterFinalSignoff();
        };
      renderGlobalDecisions();
      renderStagedAccessBar();
      focusHighlightedAccessField();
    }

    function renderGlobalDecisions(){
      if(focusedAccessReview){
        byId("global-decisions").innerHTML='<div class="band notice"><strong>Step 2 confirms the complete boundary.</strong><p>Runner will show every included table, field tier, reviewed link, trusted-scope rule, and privacy limit together. One human confirmation records the exact digest-bound decisions and activates only that boundary.</p></div>';
        return;
      }
      const decisions=globalDecisions();
      byId("global-decisions").innerHTML='<h3>Final safety confirmations</h3><p>Runner cannot decide these from table and column names.</p>'+decisions.map((decision,index)=>'<label class="check" style="margin-top:10px" title="'+esc(decision)+'"><input type="checkbox" data-review-decision="global" data-global-decision="'+index+'" '+(confirmedDecisions.has(decision)?"checked":"")+'><span>'+esc(humanDecision(decision))+'</span></label>').join("");
      document.querySelectorAll("[data-global-decision]").forEach(input=>input.onchange=async()=>{
        const decision=decisions[Number(input.dataset.globalDecision)];
        if(input.checked)confirmedDecisions.add(decision);else confirmedDecisions.delete(decision);
        invalidateDigest();
        await queueReviewProgressSave();
        continueAfterFinalSignoff();
      });
    }

    function humanDecision(decision){
      if(decision.startsWith("deployment profile:"))return "This is a development or staging setup, not production.";
      if(decision.startsWith("trusted context:"))return "Your application chooses the customer and user. The AI cannot change either.";
      if(decision.startsWith("database role:"))return "The database login is verified read-only and cannot bypass row security.";
      if(decision.includes(": confirm tenant key "))return decision.slice(0,decision.indexOf(":"))+": confirm the customer-isolation column.";
      if(decision.includes(": confirm mandatory derived tenant scope ")){
        const resource=reviewResource(decision.slice(0,decision.indexOf(":")));
        const scope=resource?.derived_tenant_scope?.selected;
        return scope?resource.id+": confirm customer isolation through the "+derivedScopePathLabel(scope)+".":decision;
      }
      if(decision.includes(": confirm mandatory derived principal scope ")){
        const resource=reviewResource(decision.slice(0,decision.indexOf(":")));
        const scope=resource?.derived_principal_scope?.selected;
        return scope?resource.id+": confirm user/owner isolation through the "+derivedScopePathLabel(scope)+".":decision;
      }
      if(decision.includes(": confirm principal scope "))return decision.slice(0,decision.indexOf(":"))+": confirm whether each user is limited to their own rows.";
      if(decision.endsWith(": confirm visible and kept-out fields"))return decision.slice(0,decision.indexOf(":"))+": confirm which fields are model-visible, withheld from the model, or kept out.";
      if(decision.endsWith(": confirm reviewed labels and descriptions"))return decision.slice(0,decision.indexOf(":"))+": confirm the reviewed human-readable names and descriptions for these exact database IDs.";
      if(decision.endsWith(": confirm filter/sort/group/aggregate-only field permissions"))return decision.slice(0,decision.indexOf(":"))+": confirm how fields may be searched, sorted, grouped, or totaled.";
      if(decision.endsWith(": confirm minimum cohort and extraction/differencing budgets"))return decision.slice(0,decision.indexOf(":"))+": confirm privacy and result-size limits.";
      if(decision.includes(": review relationship "))return decision.slice(0,decision.indexOf(":"))+": confirm this reviewed table relationship cannot widen access.";
      return decision;
    }

	    function allDecisionsConfirmed(){
	      const decisions=candidate?.unresolved_decisions||[];
	      return decisions.every(decision=>confirmedDecisions.has(decision));
	    }

    function continueAfterFinalSignoff(){
      if(!reviewProgressHealthy||!allDecisionsConfirmed())return;
      setView("activate");
      window.requestAnimationFrame(()=>byId("actor")?.focus());
    }

    function focusedBoundaryBlocker(){
      if(!candidate?.pack?.resources?.length)return "Include at least one table.";
      for(const resource of candidate.pack.resources){
        const unresolved=(resource.relationships||[]).find(relationship=>relationship.unmatched_rows==="review_required");
        if(unresolved){
          return "Choose how unmatched rows behave for "+resource.id+" → "+unresolved.target_resource+" before activation.";
        }
      }
      return "";
    }

    function renderSignoff(){
      if(!candidate||!reviewReport)return;
      if(focusedAccessReview){
        const blocker=focusedBoundaryBlocker();
        const unresolvedRelationship=candidate.pack.resources
          .flatMap(resource=>(resource.relationships||[]).map(relationship=>({resource,relationship})))
          .find(item=>item.relationship.unmatched_rows==="review_required");
	        const rows=candidate.pack.resources.map(resource=>{
	          const modelFields=(resource.selectable_fields||[]).filter(field=>!(resource.model_withheld_fields||[]).includes(field));
	          const runnerFields=resource.model_withheld_fields||[];
	          const links=(resource.relationships||[]).map(relationship=>relationship.target_resource);
	          const resourceReview=reviewResource(resource.id);
	          const disabledEnums=(resourceReview?.fields||[])
	            .filter(field=>field.enum_review_override&&field.enum_review_override.values.length===0)
	            .map(field=>field.name);
	          const enumSummary=[
	            ...Object.entries(resource.field_enums||{}).map(([field,values])=>field+": "+values.join(" | ")),
	            ...disabledEnums.map(field=>field+": none (filter/group disabled)")
	          ];
		          const fieldDisplay=field=>resource.field_metadata?.[field]?.label?resource.field_metadata[field].label+" ("+field+")":field;
		          const fieldCell=(fields,label)=>'<strong>'+esc(fields.length)+'</strong> '+esc(label)+'<small>'+esc(fields.map(fieldDisplay).join(", ")||"None")+'</small>';
		          const tenantScope=reviewedTenantScopeLabel(resource,resourceReview);
		          const principalScope=reviewedPrincipalScopeLabel(resource,resourceReview);
		          const resourceName=resource.label?resource.label+" ("+resource.id+")":resource.id;
		          return '<tr><td><strong>'+esc(resourceName)+'</strong>'+(resource.description?'<small>'+esc(resource.description)+'</small>':'')+'<small>Tenant scope: '+esc(tenantScope)+' · Principal scope: '+esc(principalScope)+' · minimum group '+esc(resource.minimum_cohort_size)+'</small><small>Allowed categorical values: '+esc(enumSummary.join("; ")||"None")+'</small></td>'
            +'<td>'+fieldCell(modelFields,"model-visible")+'</td>'
            +'<td>'+fieldCell(runnerFields,"Runner-only")+'</td>'
            +'<td>'+fieldCell(resource.kept_out_fields||[],"kept out")+'</td>'
            +'<td><strong>'+esc(links.length)+'</strong> reviewed<small>'+esc(links.join(", ")||"None")+'</small></td></tr>';
        }).join("");
        byId("signoff-summary").innerHTML='<h3>One boundary, one exact confirmation</h3>'
          +'<p>This exact local read boundary will be added to, or update its own entry in, active Explore access. Other active boundaries stay independently reviewed. The model cannot perform or alter this confirmation.</p>'
          +(askStatus?.session?.configured?'<p><strong>Configured model:</strong> activation makes model-visible values in this boundary available to '+esc(providerLabel(askStatus.session.configuration.provider))+' under the same reviewed two-tool surface. Runner retains the in-memory key, clears prior conversation, and binds subsequent egress to the new active boundary set.</p>':'')
		  +'<div class="boundary-version-table-wrap focused-boundary-table-wrap"><table class="boundary-version-table focused-boundary-table"><thead><tr><th>Table and scope</th><th>Model + Runner</th><th>Raw values: Runner only</th><th>Kept out</th><th>Related tables</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
		  +'<p><strong>Ranked queries:</strong> validate at most '+esc(candidate.budgets.max_ranked_groups??candidate.budgets.max_groups)+' candidate groups, suppress small cohorts, then return at most top '+esc(candidate.budgets.max_top_n)+'. The model cannot change this limit.</p>'
		  +'<p><strong>Writes:</strong> none. <strong>Schema and role:</strong> rechecked immediately before activation. <strong>Source database:</strong> unchanged.</p>'
          +(blocker?'<div class="risk high"><strong>One explicit choice remains.</strong><p>'+esc(blocker)+'</p><button id="return-to-access" class="secondary" type="button">Return to access editor</button></div>':'<p class="muted">Selecting Activate records every exact digest-bound decision shown here, activates only this boundary, and opens Ask.</p>');
        byId("return-to-access")?.addEventListener("click",()=>{
          if(unresolvedRelationship)selectedResource=unresolvedRelationship.resource.id;
          setView("exceptions");
          window.requestAnimationFrame(()=>{
            const detail=byId("resource-detail")?.querySelector("[data-relationship-semantics]");
            detail?.closest("details")?.setAttribute("open","");
            detail?.scrollIntoView({behavior:"smooth",block:"center"});
          });
        });
        showDeploymentProfile(candidate.deployment_profile);
        renderRolePosture();
        updateActivationState();
        return;
      }
      const total=candidate.unresolved_decisions.length;
      const outstanding=candidate.unresolved_decisions.filter(decision=>!confirmedDecisions.has(decision));
      const resourceIds=new Set((reviewReport.resources||[]).map(resource=>resource.id));
      const globalOutstanding=outstanding.filter(decision=>![...resourceIds].some(id=>decision.startsWith(id+":")));
      const remainingResources=[...new Set(outstanding
        .map(decision=>decision.slice(0,decision.indexOf(": ")))
        .filter(id=>resourceIds.has(id)))];
      const collectionLabel=reviewedCollectionLabel();
      const decisionLabel=collectionLabel==="tables"?"table":"table/view";
      const nextBlocker=outstanding[0];
      const signoffsRemaining=remainingResources.length+(globalOutstanding.length?1:0);
	      const fieldAccess=totalReviewedFieldAccess(candidate.pack.resources);
	      byId("signoff-summary").innerHTML='<h3>'+(signoffsRemaining?esc(signoffsRemaining)+' review sign-off'+(signoffsRemaining===1?"":"s")+' remaining':'Review complete')+'</h3>'
        +(outstanding.length
          ?'<p><strong>One next step:</strong> '+esc(humanDecision(nextBlocker))+'</p><p>Each '+esc(decisionLabel)+' sign-off confirms its fields, operations, trusted scope, privacy limits, and reviewed relationships together. Runner still records all '+esc(total)+' exact digest-bound decisions underneath.</p><button id="review-next-blocker" class="secondary" type="button">Go to next sign-off</button>'
          :'<p>Every boundary-wide and '+esc(decisionLabel)+' sign-off is confirmed. Runner recorded all '+esc(total)+' exact digest-bound decisions.</p>')
        +(reviewInvalidations.length?'<p>'+esc(reviewInvalidations.length)+' earlier confirmation'+(reviewInvalidations.length===1?" was":"s were")+' invalidated because reviewed inputs changed.</p>':"")
        +'<p>'+esc(collectionLabel.replace(/\\b\\w/g,char=>char.toUpperCase()))+': '+esc(candidate.pack.resources.length)
	        +' / Model-visible fields: '+esc(fieldAccess.visible)
	        +' / Model-withheld fields: '+esc(fieldAccess.runnerOnly)
	        +' / Kept-out fields: '+esc(fieldAccess.keptOut)+'</p>';
      byId("review-next-blocker")?.addEventListener("click",()=>{
        const separator=nextBlocker.indexOf(": ");
        if(separator>0&&reviewResource(nextBlocker.slice(0,separator))){
          openResource(nextBlocker.slice(0,separator));
        }else{
          selectedResource=null;
          setView("exceptions");
          renderResourceDetail();
          byId("global-decisions").scrollIntoView({behavior:"auto",block:"center"});
        }
      });
      showDeploymentProfile(candidate.deployment_profile);
      renderRolePosture();
      updateActivationState();
    }

    function renderRolePosture(){
      const role=reviewReport.database_role||{};
      byId("role-posture").innerHTML='<h3>Database login safety</h3><p><code>'+esc(role.name||"unknown")+'</code> is '+esc(role.verified===true?"verified":"not verified")+', '+esc(role.read_only===true?"read-only":"not read-only")+', and '+esc(role.superuser===false&&role.bypass_rls===false?"cannot bypass database row security":"may bypass database protections")+'.</p><details><summary>Exact database role posture</summary><p>Superuser: '+esc(String(role.superuser))+' · BYPASSRLS: '+esc(String(role.bypass_rls))+' · Fingerprint <code>'+esc(role.fingerprint||candidate.role_posture_fingerprint)+'</code></p></details>';
    }

	    function updateActivationState(){
	      const preview=byId("preview");
	      const message=byId("message");
	      const complete=allDecisionsConfirmed();
	      const actorReady=Boolean(byId("actor").value.trim());
	      const focusedBlocker=focusedAccessReview?focusedBoundaryBlocker():"";
	      preview.disabled=!reviewProgressHealthy||Boolean(focusedBlocker)||(!focusedAccessReview&&!complete)||!actorReady;
	      if(!reviewProgressHealthy){
	        message.textContent="Review progress is not saved. Retry the failed save before continuing.";
	      }else if(focusedBlocker){
	        message.textContent=focusedBlocker;
	      }else if(!focusedAccessReview&&!complete){
	        message.textContent="Review the next required decision before activation.";
	      }else if(!actorReady){
	        message.textContent="Enter who reviewed this access.";
	      }else{
	        message.textContent=focusedAccessReview
	          ?"Ready. One click records this exact boundary, revalidates it, activates local read-only access, and opens Ask."
	          :"Ready. Runner will revalidate the exact reviewed fingerprint, activate local read-only access, and open Ask.";
	      }
	    }

    async function previewBoundary(){
      const message=byId("message");
      const button=byId("preview");
      try{
        button.disabled=true;
        message.className="status-message";
        if(focusedAccessReview){
          const blocker=focusedBoundaryBlocker();
          if(blocker)throw new Error(blocker);
          confirmedDecisions=new Set(candidate.unresolved_decisions||[]);
        }
        await queueReviewProgressSave();
        if(!reviewProgressHealthy)throw new Error("Review progress must be saved before previewing a digest.");
        message.textContent="Validating and activating the reviewed boundary...";
	        const payload=await post("/api/boundary/preview",{
	          candidate,
	          expected_revision:reviewRevision,
	          actor:byId("actor").value.trim(),
	          confirmed_decisions:[...confirmedDecisions]
	        });
	        candidateDigest=payload.digest;
	        await activateBoundary();
	      }catch(error){
	        updateActivationState();
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
	        activeBoundaries=[...activeBoundaries.filter(boundary=>boundary.pack?.name!==payload.active.pack.name),payload.active];
	        synchronizeBoundaryAuthorityState(activeBoundary);
	        focusedAccessReview=false;
	        accessBaselineColumns=accessColumnSnapshot(candidate);
	        renderStagedAccessBar();
	        renderSummary();
	        renderResources();
	        renderBoundaryOverview();
        byId("header-state").textContent="Active reviewed boundary";
        byId("header-state").className="state good";
        message.className="status-message";
        message.innerHTML='<strong>This reviewed boundary is active.</strong> Existing active boundaries and your configured provider credential remain available. Prior model conversation was cleared for the changed authority. Opening Ask.<details><summary>Advanced activation fingerprint</summary><code>'+esc(payload.active.activation.digest)+'</code></details>';
        document.querySelector('[data-view="activate"]').classList.add("done");
        setView("explore");
	      }catch(error){
	        updateActivationState();
	        message.className="status-message error";
	        message.textContent=error.message;
	      }
    }

    function rescanList(value){
      return Array.isArray(value)?value:[];
    }

    function rescanPlural(count,singular,plural){
      return Number(count)===1?singular:plural;
    }

    function rescanPreservedAuthority(value){
      const direct=value&&value.preserved_authority;
      if(direct&&typeof direct==="object"){
        return {
          resources:Number(direct.resources)||0,
          reviewed_paths:Number(direct.reviewed_paths)||0,
          field_policies:Number(direct.field_policies)||0
        };
      }
      return {
        resources:rescanList(value&&value.retained_resources).length,
        reviewed_paths:0,
        field_policies:0
      };
    }

    function rescanPreservedAuthorityText(value){
      const preserved=rescanPreservedAuthority(value);
      return preserved.resources+" "+rescanPlural(preserved.resources,"table","tables")+", "+
        preserved.reviewed_paths+" reviewed "+rescanPlural(preserved.reviewed_paths,"path","paths")+", "+
        preserved.field_policies+" field "+rescanPlural(preserved.field_policies,"policy","policies");
    }

    function rescanRelationshipDetail(relationship,state){
      const action=state==="removed"?"reviewed relationship was removed":"new relationship is available to review";
      const links=rescanList(relationship&&relationship.path_links);
      if(!links.length)return relationship.resource_id+"."+relationship.relationship_id+": "+action;
      const resources=[relationship.resource_id];
      for(const link of links){
        if(resources[resources.length-1]!==link.source_resource)resources.push(link.source_resource);
        if(resources[resources.length-1]!==link.target_resource)resources.push(link.target_resource);
      }
      if(resources[resources.length-1]!==relationship.target_resource)resources.push(relationship.target_resource);
      const namespaces=resources.map(resource=>{
        const separator=String(resource).lastIndexOf(".");
        return separator>0?String(resource).slice(0,separator):null;
      });
      const namespace=namespaces[0]&&namespaces.every(value=>value===namespaces[0])?namespaces[0]:null;
      const path=resources.map(resource=>namespace?String(resource).slice(namespace.length+1):String(resource)).join(" -> ");
      const columns=links.map(link=>rescanList(link.source_columns).join(", "));
      const depth=Number(relationship.path_depth)||links.length;
      return [
        relationship.resource_id+": "+action+" ("+depth+" "+rescanPlural(depth,"hop","hops")+")",
        "  "+path,
        ...(columns.every(Boolean)?["  via columns: "+columns.join(" -> ")]:[]),
        "  path ID: "+relationship.relationship_id
      ].join("\\n");
    }

    function rescanDetailMarkup(detail){
      return esc(detail).replace(/\\n/g,"<br>");
    }

    function rescanBoundaryDetails(boundary){
      const details=[];
      for(const decision of rescanList(boundary.invalidated_decisions)){
        details.push(decision.id+": "+(decision.reason==="decision_removed"?"reviewed input no longer exists":"reviewed input changed"));
      }
      for(const field of rescanList(boundary.changed_field_types))details.push(field.resource_id+"."+field.field+": reviewed column type changed");
      for(const field of rescanList(boundary.removed_fields))details.push(field.resource_id+"."+field.field+": reviewed column removed");
      for(const relationship of rescanList(boundary.removed_relationships))details.push(rescanRelationshipDetail(relationship,"removed"));
      for(const resource of rescanList(boundary.removed_resources))details.push(resource+": reviewed table removed");
      for(const resource of rescanList(boundary.newly_available_resources))details.push(resource+": new table available to review");
      for(const item of rescanList(boundary.newly_proven_value_allowlists))details.push(item.resource_id+"."+item.field+": an enforced schema vocabulary now narrows existing filter/group authority to "+item.value_count+" reviewed values; confirm field permissions, then activate");
      for(const detail of rescanList(boundary.pruned_review_inputs))details.push(detail);
      for(const field of rescanList(boundary.newly_available_fields))details.push(field.resource_id+"."+field.field+": new column kept out until reviewed");
      for(const relationship of rescanList(boundary.newly_available_relationships))details.push(rescanRelationshipDetail(relationship,"new"));
      return details;
    }

    function renderProjectRescanPreview(diff){
      const totals=diff&&diff.totals?diff.totals:{};
      const changed=Boolean(diff&&diff.changed);
      const baselineRefreshed=Boolean(diff&&diff.authoring_baseline_refreshed);
      const title=changed?"Review changes found":baselineRefreshed?"Authoring baseline repair available":"No reviewed changes found";
      const summary=changed
        ?"Runner found reviewed inputs that need a disabled reconciled revision. Existing active authority remains unchanged."
        :baselineRefreshed
          ?"The reviewed database and authority are unchanged, but the private boundary-authoring baseline is stale. Repairing it restores new-boundary authoring in both CLI and Workbench without changing any reviewed revision."
          :"The reviewed schema, database-server capabilities, database-role posture, trusted context, and private authoring baseline already match. Nothing needs to be applied.";
      const facts=[
        ["Schema",diff&&diff.schema_changed?"Changed":"Unchanged"],
        ["Database capabilities",diff&&diff.database_server_authority_changed?"Changed":"Unchanged"],
        ["Database role",diff&&diff.role_posture_changed?"Changed":"Unchanged"],
        ["Trusted context",diff&&diff.trusted_context_changed?"Changed":"Unchanged"],
        ["Boundaries checked",totals.boundaries??0],
        ["Reviewed authority preserved",rescanPreservedAuthorityText(totals)],
        ["Prior decisions invalidated",totals.invalidated_decisions??0],
        ["Newly proven value allowlists",totals.newly_proven_value_allowlists??0],
        ["Newly available",(totals.newly_available_resources??0)+" tables, "+(totals.newly_available_fields??0)+" columns, "+(totals.newly_available_relationships??0)+" relationships"],
        ["Removed",(totals.removed_resources??0)+" tables, "+(totals.removed_fields??0)+" columns, "+(totals.removed_relationships??0)+" relationships"]
      ];
      const factRows=facts.map(item=>'<tr><th>'+esc(item[0])+'</th><td>'+esc(item[1])+'</td></tr>').join("");
      const trustedChanges=rescanList(diff&&diff.trusted_context_changes);
      const trustedMarkup=trustedChanges.length
        ?'<h4>Trusted-context changes</h4><ul>'+trustedChanges.map(change=>'<li>'+esc(change)+'</li>').join("")+'</ul>'
        :"";
      const serverChanges=rescanList(diff&&diff.database_server_authority_changes);
      const serverMarkup=serverChanges.length
        ?'<h4>Database capability changes</h4><ul>'+serverChanges.map(change=>'<li>'+esc(change)+'</li>').join("")+'</ul>'
        :"";
      const boundaryRows=rescanList(diff&&diff.boundaries).map(boundary=>{
        const details=rescanBoundaryDetails(boundary);
        const shown=details.slice(0,8).map(detail=>'<li>'+rescanDetailMarkup(detail)+'</li>').join("");
        const more=details.length>8?'<li>+'+esc(details.length-8)+' more changes are available in the boundary review.</li>':"";
        const detailMarkup=details.length?'<ul>'+shown+more+'</ul>':'No reviewed inputs changed.';
        return '<tr><td data-label="Boundary"><code>'+esc(boundary.boundary_name)+'</code></td><td data-label="Preserved">'+esc(rescanPreservedAuthorityText(boundary))+'</td><td data-label="Invalidated">'+esc(rescanList(boundary.invalidated_decisions).length)+'</td><td data-label="Details">'+detailMarkup+'</td></tr>';
      }).join("");
      const boundariesMarkup=boundaryRows
        ?'<h4>Boundary reconciliation</h4><div class="result-table"><table><thead><tr><th>Boundary</th><th>Preserved authority</th><th>Invalidated</th><th>Details</th></tr></thead><tbody>'+boundaryRows+'</tbody></table></div>'
        :"";
      const action=changed
        ?'<button id="apply-rescan" type="button">Apply disabled reconciliation</button>'
        :baselineRefreshed
          ?'<button id="apply-rescan" type="button">Repair authoring baseline</button>'
          :"";
      const consequence=changed
        ?"Applying writes only a disabled reconciled revision. Review and activation remain separate."
        :baselineRefreshed
          ?"Applying repairs private authoring state only. No boundary review is required."
          :"No generated file, active boundary, protected capability, ledger record, or source row changed.";
      return '<h3>'+esc(title)+'</h3><p>'+esc(summary)+'</p><div class="result-table"><table><tbody>'+factRows+'</tbody></table></div>'+trustedMarkup+serverMarkup+boundariesMarkup+'<p>'+esc(consequence)+'</p>'+action;
    }

    async function previewProjectRescan(){
      const panel=byId("project-action-message");
      try{
        panel.className="review-form";
        panel.innerHTML="<p>Inspecting current metadata and computing a semantic diff. Nothing is being replaced...</p>";
        const payload=await post("/api/project/rescan",{});
        const diff=payload.diff;
        panel.innerHTML=renderProjectRescanPreview(diff);
        const apply=byId("apply-rescan");
        if(apply)apply.onclick=()=>applyProjectRescan(payload.preview_digest);
      }catch(error){
        panel.className="review-form error";
        panel.textContent=error.message;
      }
    }

    async function applyProjectRescan(digest){
      const panel=byId("project-action-message");
      try{
        panel.className="review-form";
	        panel.textContent="Rechecking the preview and applying only its reviewed reconciliation...";
	        const payload=await post("/api/project/rescan/apply",{
          expected_digest:digest,
          confirmation:"RESCAN "+digest
	        });
	        candidateDigest=undefined;
	        accessBaselineColumns=null;
	        await load();
        panel.className="review-form success";
        panel.textContent=payload.message+(payload.diff&&payload.diff.changed
          ?" Next: Review the changed boundary."
          :payload.diff&&payload.diff.authoring_baseline_refreshed
            ?" You can create or edit boundaries now; no boundary review is required for this repair."
            :"");
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
	        accessBaselineColumns=null;
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
	        panel.innerHTML='<h3>Reviewed access ready.</h3><p>Read-only local authoring boundary active.</p><details><summary>Advanced readiness checks</summary><div class="preflight">'+payload.checks.map(check=>'<div><span class="badge good">Ready</span><strong style="display:block;margin-top:5px">'+esc(check.name)+'</strong><p>'+esc(check.detail)+'</p></div>').join("")+'</div></details>';
        byId("explorer").classList.remove("hidden");
        renderExplorer();
      }catch(error){
	        const remediation=error.payload?.remediation;
	        if(error.payload?.error_code==="EXPLORE_SCOPE_FORBIDDEN"){
	          const requirements=error.payload?.scope_requirements||{};
	          const missing=Array.isArray(requirements.missing_bindings)?requirements.missing_bindings:[];
	          const configured=Array.isArray(requirements.configured_bindings)?requirements.configured_bindings:[];
	          const missingLabels=missing.map(binding=>(binding.kind==="principal"?"Principal identity":"Tenant identity")+" from "+binding.env);
	          const configuredLabels=configured.map(binding=>(binding.kind==="principal"?"Principal":"Tenant")+" is configured from "+binding.env);
	          panel.className="band notice";
	          panel.innerHTML='<h3>'+esc(missingLabels.join(" and ")||"Application identity")+" is missing.</h3>"
	            +'<p>Connect the operator-owned application identity before analyzing scoped data. No analytical tool has been enabled.</p>'
	            +(configuredLabels.length?'<p>'+esc(configuredLabels.join(". "))+".</p>":"")
	            +'<p><strong>Next action:</strong> '+esc(remediation?.action||"Configure the reviewed environment binding, then retry.")+'</p>'
	            +'<div class="actions"><button id="retry-preflight" type="button">Retry after identity setup</button></div>';
	          byId("explorer").classList.add("hidden");
	          byId("retry-preflight").onclick=runPreflight;
	          return;
	        }
        panel.className="band error";
        panel.innerHTML='<h3>Explore is not ready</h3><p>'+esc(error.message)+'</p>'+(remediation?'<p><strong>Next action:</strong> '+esc(remediation.action)+'</p><p>'+esc(remediation.preserved)+'</p>':"")+'<button id="retry-preflight" type="button">Retry preflight</button>';
        byId("explorer").classList.add("hidden");
        byId("retry-preflight").onclick=runPreflight;
      }
    }

    async function loadAskStatus(){
      const shell=byId("ask-shell");
      try{
        const payload=await getJson("/api/ask/status");
        askStatus=payload;
        boundaryCatalog=payload.boundary_catalog||boundaryCatalog;
        boundaryMermaid=payload.boundary_mermaid||boundaryMermaid;
        boundaryDiagrams=payload.boundary_diagrams||boundaryDiagrams;
        shell.classList.remove("hidden");
        renderAskStatus();
      }catch(error){
        askStatus=null;
        shell.classList.add("hidden");
        focusAskAfterLoad=false;
        openNoModelAfterLoad=true;
        if(!byId("explorer").classList.contains("hidden")){
          requestAnimationFrame(revealNoModelComposer);
        }
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
      const scopedExplore=Boolean(askStatus.active_boundary_set_digest||askStatus.active_boundary_digest);
      const activeResources=activeBoundaries.flatMap(boundary=>boundary?.pack?.resources||[]);
      const activeLabel=activeBoundaries.length>1
        ?activeBoundaries.length+" active boundaries · "+activeResources.length+" reviewed "+reviewedCollectionLabelForResources(activeResources)
        :activeBoundaries.length===1
          ?activeBoundaries[0].pack.name+" · "+activeResources.length+" reviewed "+reviewedCollectionLabelForResources(activeResources)
          :activeResources.length===1
            ?humanizeIdentifier(activeResources[0].table||activeResources[0].id)
            :activeResources.length+" reviewed "+reviewedCollectionLabelForResources(activeResources);
      const boundaryBadge=scopedExplore
        ?'<span class="badge">Boundary set '+esc(String(askStatus.active_boundary_set_digest||askStatus.active_boundary_digest).slice(0,18))+'…</span>'
        :'';
      authority.className="";
      authority.innerHTML=scopedExplore
        ?'<div class="active-scope-line"><span class="scope-dot" aria-hidden="true"></span><strong>'+esc(activeLabel)+'</strong><span>scoped · read-only</span></div><p>The model receives reviewed tools and model-visible values, not SQL, credentials, tenant choice, model-withheld values, kept-out fields, or write authority. Activation, approval, and apply stay operator-only.</p><details><summary>Advanced: inspect exact tools and authority</summary><div class="badges">'+boundaryBadge+'<span class="badge">Ask authority '+esc(String(askStatus.authority_digest).slice(0,18))+'…</span></div><ul>'+tools.map(tool=>'<li><code>'+esc(tool.name)+'</code> · '+esc(tool.description||"Reviewed Synapsor tool")+'</li>').join("")+'</ul></details>'
        :'<strong>Reviewed named tools are active.</strong><p>Your model may call only these exact activated reads and proposal tools. A proposal can request a bounded change, but the model still cannot activate, approve, apply, or widen any tool.</p><details><summary>Advanced: inspect exact tool surface and authority</summary><div class="badges"><span class="badge">Ask authority '+esc(String(askStatus.authority_digest).slice(0,18))+'…</span></div><ul>'+tools.map(tool=>'<li><code>'+esc(tool.name)+'</code> · '+esc(tool.description||"Reviewed Synapsor tool")+'</li>').join("")+'</ul></details>';
      byId("ask-question").placeholder=scopedExplore
        ?askStarterPrompts[0]||"Ask about the reviewed data available here."
        :"Ask a question or request one reviewed proposal.";
      byId("ask-configuration").classList.remove("hidden");
      const consentCurrent=session.configured&&askStatus.authority_matches_consent;
      const submitProvider=!session.configured&&focusAskAfterLoad
        ?soleEnvironmentProvider()
        :null;
      askConsentOnSubmit=Boolean(submitProvider);
      const readyToAsk=Boolean(consentCurrent||askConsentOnSubmit);
      byId("ask-chat").classList.toggle("hidden",!readyToAsk);
      byId("ask-configuration-form").classList.toggle("hidden",readyToAsk);
      byId("ask-configured-summary").classList.toggle("hidden",!consentCurrent);
      byId("ask-provider-state").textContent=consentCurrent
        ? providerLabel(session.configuration.provider)+" ready"
        :askConsentOnSubmit
          ?providerLabel(submitProvider)+" ready on submit"
        : session.configured
          ?"Review changed"
          :"Not configured";
      byId("ask-provider-state").className="badge "+(readyToAsk?"good":session.configured?"warn":"");
      if(session.configuration){
        byId("ask-provider").value=session.configuration.provider;
        byId("ask-model").value=session.configuration.model;
        byId("ask-timeout").value=String(session.configuration.request_timeout_seconds||"");
        byId("ask-session-token-budget").value=String(session.configuration.session_token_budget||200000);
        byId("ask-max-output-tokens").value=session.configuration.max_output_tokens===undefined?"":String(session.configuration.max_output_tokens);
        byId("ask-live-session-token-budget").value=String(session.configuration.session_token_budget||200000);
        byId("ask-live-max-output-tokens").value=session.configuration.max_output_tokens===undefined?"":String(session.configuration.max_output_tokens);
        const tokenUsage=session.token_usage||{reported_tokens:0,session_token_budget:session.configuration.session_token_budget||200000,remaining_reported_tokens:session.configuration.session_token_budget||200000};
        byId("ask-limit-usage").textContent=Number(tokenUsage.reported_tokens||0).toLocaleString()+" / "+Number(tokenUsage.session_token_budget||0).toLocaleString()+" reported tokens · "+Number(tokenUsage.remaining_reported_tokens||0).toLocaleString()+" remaining";
        updateAskProviderFields(false);
        byId("ask-configured-model").textContent=providerLabel(session.configuration.provider)+" · "+session.configuration.model;
        byId("ask-configured-detail").textContent="Direct to "+session.configuration.endpoint_origin+" · "+session.configuration.request_timeout_seconds+"s per model request · "+Number(session.configuration.session_token_budget||200000).toLocaleString()+" reported tokens per session · "+credentialSourceLabel(session.configuration.credential_source)+" · no Synapsor relay or saved conversation.";
        byId("ask-config-status").className="status-message";
        byId("ask-config-status").textContent=consentCurrent
          ?"Ready. Provider key and conversation remain in this Workbench process only."
          :"The reviewed tool surface changed. Acknowledge provider egress again.";
      }else{
        applyAvailableProviderCredential();
      }
      renderAskSubmitConsent(submitProvider);
      renderAskStarters();
      renderAskBoundaryGuide();
      if(focusAskAfterLoad){
        focusAskAfterLoad=false;
        requestAnimationFrame(()=>{
          byId("ask-shell").scrollIntoView({behavior:"auto",block:"start"});
          (readyToAsk?byId("ask-question"):byId("ask-provider")).focus();
        });
      }
    }

    function soleEnvironmentProvider(){
      const available=askStatus?.credential_environment||{};
      const configured=[
        ...(available.openai?["openai"]:[]),
        ...(available.anthropic?["anthropic"]:[])
      ];
      return configured.length===1?configured[0]:null;
    }

    function renderAskSubmitConsent(provider){
      const panel=byId("ask-submit-consent");
      if(!panel)return;
      if(!provider||!askConsentOnSubmit){
        panel.classList.add("hidden");
        panel.innerHTML="";
        return;
      }
      const model=provider==="openai"?"gpt-5-mini":"claude-sonnet-4-20250514";
      const origin=provider==="openai"?"https://api.openai.com":"https://api.anthropic.com";
      panel.classList.remove("hidden");
      panel.innerHTML='<strong>'+esc(providerLabel(provider))+' is ready</strong>'
        +'<p>Submitting your first question confirms that the question and only approved model-visible values may go directly to <code>'+esc(origin)+'</code> using <code>'+esc(model)+'</code>. Model-withheld raw values and kept-out fields stay out. Trusted scope remains fixed outside model arguments; its raw column value is sent only when you reviewed that column as Model + Runner. No provider request occurs before you submit.</p>'
        +'<button id="ask-submit-change-provider" class="quiet" type="button">Change provider or model</button>';
      byId("ask-submit-change-provider").onclick=()=>{
        askConsentOnSubmit=false;
        renderAskSubmitConsent(null);
        showAskConfiguration();
      };
    }

    function applyAvailableProviderCredential(){
      const available=askStatus?.credential_environment||{};
      const provider=available.openai
        ?"openai"
        :available.anthropic
          ?"anthropic"
          :byId("ask-provider").value;
      byId("ask-provider").value=provider;
      updateAskProviderFields(true);
      if(available[provider]){
        byId("ask-key-source").value="environment";
        byId("ask-key-env").value=provider==="openai"?"OPENAI_API_KEY":"ANTHROPIC_API_KEY";
        updateAskCredentialFields();
        byId("ask-credential-details").open=false;
        byId("ask-config-status").className="status-message";
        byId("ask-config-status").textContent="A conventional provider credential is available in this Workbench process. Its value is never sent to the browser. Review direct egress, then start asking.";
      }else{
        byId("ask-credential-details").open=true;
      }
    }

    function providerLabel(provider){
      return provider==="openai"?"OpenAI":provider==="anthropic"?"Anthropic":"Custom model";
    }

    function credentialSourceLabel(source){
      return source==="session_paste"?"session-only pasted key":source==="environment"?"environment credential":"no provider key";
    }

    function showAskConfiguration(){
      askConsentOnSubmit=false;
      renderAskSubmitConsent(null);
      byId("ask-configuration-form").classList.remove("hidden");
      byId("ask-configured-summary").classList.add("hidden");
      byId("ask-config-status").className="status-message";
      byId("ask-config-status").textContent="Changing the provider or model requires a new egress acknowledgement for the current reviewed tools.";
      byId("ask-egress").checked=false;
      byId("ask-egress-review").classList.remove("needs-attention");
      byId("ask-provider").focus();
    }

    function showAskCredentialRecovery(){
      showAskConfiguration();
      byId("ask-credential-details").open=true;
      const source=byId("ask-key-source").value;
      byId("ask-config-status").className="status-message error";
      byId("ask-config-status").textContent=source==="environment"
        ?"Correct the environment credential and restart Workbench, or switch to a session-only key here."
        :"Paste only the API key value. Do not paste OPENAI_API_KEY=, ANTHROPIC_API_KEY=, or surrounding quotes.";
      (source==="environment"?byId("ask-key-env"):byId("ask-key")).focus();
    }

    function askFailurePresentation(error){
      const code=error.payload?.error_code||"ASK_UNKNOWN";
      const provider=providerLabel(askStatus?.session?.configuration?.provider||byId("ask-provider").value);
      if(code==="ASK_PROVIDER_AUTHENTICATION_FAILED"){
        return {
          title:provider+" could not authenticate",
          message:provider+" rejected the configured API key.",
          detail:error.payload?.next_action||"Change the provider credential and try again.",
          action:"Change provider or key",
          recoverCredential:true
        };
      }
      if(code==="ASK_PROVIDER_PERMISSION_DENIED"){
        return {
          title:provider+" denied access",
          message:"The configured key does not have access to this project or model.",
          detail:error.payload?.next_action||"Review provider permissions or choose another model.",
          action:"Review provider settings",
          recoverCredential:true
        };
      }
      if(code==="ASK_PROVIDER_RATE_LIMITED"){
        return {
          title:provider+" limit reached",
          message:"The provider refused this request because its rate limit or quota was reached.",
          detail:error.payload?.next_action||"Wait and retry, or choose another configured model.",
          action:"Review provider settings",
          recoverCredential:true
        };
      }
      if(code==="ASK_CANCELLED"){
        return {
          title:"Request cancelled",
          message:"The in-progress model request was cancelled.",
          detail:"Ask another question when ready."
        };
      }
      if(code==="ASK_AUTHORITY_CHANGED"){
        return {
          title:"Reviewed access changed",
          message:"Runner stopped this request because the active reviewed boundaries changed.",
          detail:error.payload?.next_action||"Reload the current boundary set and acknowledge provider egress again.",
          action:"Reload reviewed access",
          reload:true
        };
      }
      if(code==="ASK_SESSION_TOKEN_BUDGET_EXCEEDED"||code==="ASK_SESSION_TOKEN_BUDGET_BELOW_USAGE"){
        return {
          title:"Ask session token limit reached",
          message:error.message,
          detail:error.payload?.next_action||"Raise the reported-token budget without clearing this conversation.",
          action:"Open Ask limits",
          limits:true
        };
      }
      if(code.startsWith("ASK_PROVIDER_")){
        return {
          title:"The model provider could not complete this request",
          message:error.message,
          detail:error.payload?.next_action||"Review the provider configuration and try again.",
          action:"Review provider settings",
          recoverCredential:true
        };
      }
      return {
        title:"Ask could not complete this request",
        message:error.message,
        detail:error.payload?.next_action||"Review the reported issue and try again."
      };
    }

    function renderAskStarters(){
      const panel=byId("ask-starters");
      const prompts=askStarterPrompts.slice(0,2);
      if(!prompts.length){
        panel.innerHTML='<strong>Ask through the reviewed tools</strong><p>Use a plain-language question below. The model can call only the named tools shown above and cannot widen their database access.</p>';
        return;
      }
      const activeResources=activeBoundaries.flatMap(boundary=>boundary?.pack?.resources||[]);
      panel.innerHTML='<strong>Try a reviewed question</strong><p>These suggestions use only activated '+esc(reviewedCollectionLabelForResources(activeResources))+' metadata.</p>'+prompts.map((prompt,index)=>'<button class="question secondary" data-ask-starter="'+index+'" type="button">'+esc(prompt)+'</button>').join("");
      document.querySelectorAll("[data-ask-starter]").forEach(button=>button.onclick=()=>{
        byId("ask-question").value=prompts[Number(button.dataset.askStarter)]||"";
        byId("ask-question").focus();
      });
    }

    function askBoundaryValues(resource,key){
      const reviewedFields=value=>Array.isArray(value)?value:Object.keys(value||{});
      const own=key==="filterable_fields"||key==="time_bucket_fields"
        ?reviewedFields(resource?.[key])
        :resource?.[key]||[];
      const values=own.map(field=>fieldLabel(resource,field));
      for(const relationship of resource?.relationships||[]){
        if(relationship.activation!=="active"||relationship.operator_review_required)continue;
        const related=key==="filterable_fields"||key==="time_bucket_fields"
          ?reviewedFields(relationship[key])
          :relationship[key]||[];
        related.forEach(field=>values.push(
          fieldLabel(relationship,field)+" from "+relationshipTargetLabel(relationship)
        ));
      }
      return [...new Set(values)];
    }

    function renderAskBoundaryGuide(){
      const summary=byId("ask-boundary-summary");
      const body=byId("ask-boundary-body");
      if(!summary||!body)return;
      const resources=resourcesFromDescription();
      if(!resources.length){
        const tools=askStatus?.tools||[];
        summary.textContent=tools.length
          ?tools.length+" exact reviewed tool"+(tools.length===1?"":"s")
          :"Loading the active reviewed boundary...";
        body.innerHTML=tools.length
          ?'<p class="ask-boundary-intro">Your model can use only these reviewed tools. It cannot add fields, relationships, SQL, or write authority.</p><div class="ask-boundary-grid">'+tools.map(tool=>'<section class="ask-boundary-resource"><h4>'+esc(tool.title||humanizeIdentifier(tool.name))+'</h4><p>'+esc(tool.description||"Reviewed Synapsor tool")+'</p></section>').join("")+'</div>'+askBoundaryEditAction()
          :'<p class="ask-boundary-intro">Runner is loading the exact measures, groupings, dates, and filters available to this conversation.</p>';
        wireAskBoundaryEditAction();
        return;
      }
      const totalGroups=resources.reduce((count,resource)=>count+askBoundaryValues(resource,"groupable_fields").length,0);
      const totalMeasures=resources.reduce((count,resource)=>
        count+1+askBoundaryValues(resource,"aggregate_measures").length+askBoundaryValues(resource,"count_distinct_fields").length,0);
      const collectionLabel=reviewedCollectionLabelForResources(resources);
      const reviewedJoins=boundaryCatalog?.relationship_count||0;
      summary.textContent=resources.length+" "+(resources.length===1?(collectionLabel==="tables"?"table":"table or view"):collectionLabel)+" · "+totalMeasures+" measure"+(totalMeasures===1?"":"s")+" · "+totalGroups+" grouping"+(totalGroups===1?"":"s")+" · "+reviewedJoins+" join"+(reviewedJoins===1?"":"s");
      const resourceSignature=resources.map(resource=>resource.id||resource.table||describedResourceLabel(resource)).join("|");
      if(resourceSignature!==askBoundaryResourceSignature){
        askBoundaryResourceSignature=resourceSignature;
        askBoundaryPage=0;
      }
      const pageCount=Math.max(1,Math.ceil(resources.length/askBoundaryPageSize));
      askBoundaryPage=Math.min(askBoundaryPage,pageCount-1);
      const pageStart=askBoundaryPage*askBoundaryPageSize;
      const pageResources=resources.slice(pageStart,pageStart+askBoundaryPageSize);
      const cards=pageResources.map(resource=>{
        const numeric=askBoundaryValues(resource,"aggregate_measures");
        const unique=askBoundaryValues(resource,"count_distinct_fields");
        const measures=["Record count",...numeric.flatMap(field=>["Total "+field,"Average "+field]),...unique.map(field=>"Unique "+field)];
        const groups=askBoundaryValues(resource,"groupable_fields");
        const dates=askBoundaryValues(resource,"time_bucket_fields");
        const filters=askBoundaryValues(resource,"filterable_fields");
        const catalogBoundary=(boundaryCatalog?.boundaries||[]).find(boundary=>
          !resource.boundary_name||boundary.name===resource.boundary_name
        );
        const joins=(catalogBoundary?.relationships||[]).filter(relationship=>
          relationship.source_table===(resource.id||resource.table)
        );
	        return '<section class="ask-boundary-resource"><h4>'+esc(describedResourceLabel(resource))+'</h4>'
	          +(resource.label?'<p><code>'+esc(resource.id)+'</code></p>':'')
	          +(resource.description?'<p>'+esc(resource.description)+'</p>':'')
          +'<div class="ask-boundary-row"><strong>Calculate</strong><span>'+esc(measures.join(" · ")||"Record count")+'</span></div>'
          +'<div class="ask-boundary-row"><strong>Compare by</strong><span>'+esc(groups.join(" · ")||"No reviewed grouping")+'</span></div>'
          +'<div class="ask-boundary-row"><strong>Time</strong><span>'+esc(dates.join(" · ")||"No reviewed time field")+'</span></div>'
          +'<div class="ask-boundary-row"><strong>Filter by</strong><span>'+esc(filters.join(" · ")||"No reviewed filters")+'</span></div>'
          +'<div class="ask-boundary-row"><strong>Joins</strong><span>'+(joins.length?joins.map(relationship=>'→ '+esc(relationship.target_table)+' · '+esc(relationship.cardinality.replaceAll("_","-"))+' · '+(relationship.proven?'proven':'unproven')).join('<br>'):'No reviewed join from this table')+'</span></div>'
          +'</section>';
      }).join("");
      const examples=askStarterPrompts.slice(0,3).map((prompt,index)=>
        '<button class="question secondary" data-boundary-example="'+index+'" type="button">'+esc(prompt)+'</button>'
      ).join("");
      const pagination=pageCount>1
        ?'<nav class="ask-boundary-pagination" aria-label="Reviewed table pages"><span class="ask-boundary-pagination-status" aria-live="polite">Showing '+esc(pageStart+1)+'–'+esc(Math.min(pageStart+askBoundaryPageSize,resources.length))+' of '+esc(resources.length)+' '+esc(collectionLabel)+' · Page '+esc(askBoundaryPage+1)+' of '+esc(pageCount)+'</span><div class="ask-boundary-pagination-actions"><button id="ask-boundary-previous" class="quiet" type="button"'+(askBoundaryPage===0?' disabled':'')+'>← Previous</button><button id="ask-boundary-next" class="quiet" type="button"'+(askBoundaryPage>=pageCount-1?' disabled':'')+'>Next →</button></div></nav>'
        :"";
      body.innerHTML='<p class="ask-boundary-intro">These are the exact analytical choices available to this conversation. Anything not shown remains outside the model tool surface.</p>'
        +'<div class="ask-boundary-grid">'+cards+'</div>'
        +pagination
        +renderBoundaryRelationshipMap(boundaryCatalog,boundaryDiagrams)
        +(examples?'<div class="ask-boundary-examples">'+examples+'</div>':"")
        +askBoundaryEditAction();
      const previous=byId("ask-boundary-previous");
      const next=byId("ask-boundary-next");
      if(previous)previous.onclick=()=>{askBoundaryPage=Math.max(0,askBoundaryPage-1);renderAskBoundaryGuide();requestAnimationFrame(()=>byId("ask-boundary-next")?.focus())};
      if(next)next.onclick=()=>{askBoundaryPage=Math.min(pageCount-1,askBoundaryPage+1);renderAskBoundaryGuide();requestAnimationFrame(()=>byId("ask-boundary-previous")?.focus())};
      document.querySelectorAll("[data-boundary-example]").forEach(button=>button.onclick=()=>{
        byId("ask-question").value=askStarterPrompts[Number(button.dataset.boundaryExample)]||"";
        byId("ask-question").focus();
      });
      wireAskBoundaryEditAction();
      wireBoundaryRelationshipMaps(body);
    }

    function boundaryOperationList(labels){
      const items=labels.length?labels:['No reviewed operations'];
      return '<ul class="boundary-operation-list">'+items.map(label=>'<li class="'+(labels.length?'':'unavailable')+'">'+esc(label)+'</li>').join('')+'</ul>';
    }

    function boundaryIdentifierDisplay(value){
      return esc(value).replaceAll('.', '.<wbr>').replaceAll('_', '_<wbr>');
    }

    function renderBoundaryFieldMatrix(table){
      const fields=table.model_visible_fields||[];
      if(!fields.length)return '';
      const exact=[];
      const rows=fields.map(field=>{
        const operations=field.operations||{};
        const filterOperators=operations.filter_operators||[];
        const timeBuckets=operations.time_buckets||[];
        const group=operations.group===true||(table.groupable_fields||[]).includes(field.name);
        const measure=operations.measure===true||(table.aggregate_measures||[]).includes(field.name);
        const distinct=operations.distinct===true||(table.count_distinct_fields||[]).includes(field.name);
        const time=timeBuckets.length>0||(table.time_bucket_fields||[]).includes(field.name);
        const detail=[];
        if(filterOperators.length)detail.push('filter: '+filterOperators.join(', '));
        if(timeBuckets.length)detail.push('time: '+timeBuckets.join(', '));
        if(detail.length)exact.push('<li><code>'+esc(field.name)+'</code><span>'+esc(detail.join(' · '))+'</span></li>');
        const reviewed=[];
        if(operations.return_value!==false)reviewed.push('Return value');
        if(filterOperators.length>0)reviewed.push('Filter');
        if(operations.sort===true)reviewed.push('Sort');
        if(group)reviewed.push('Group / band');
        if(measure)reviewed.push('Numeric measure');
        if(operations.presence===true)reviewed.push('Missing-data measure');
        if(distinct)reviewed.push('Distinct count');
        if(time)reviewed.push('Time bucket');
        return '<tr><th scope="row"><code>'+esc(field.name)+'</code><small>'+esc(field.data_type||'reviewed')+'</small></th>'
          +'<td>'+boundaryOperationList(reviewed)+'</td>'
          +'</tr>';
      }).join('');
      return '<div class="boundary-field-matrix-wrap"><table class="boundary-field-matrix"><thead><tr><th>Field and database type</th><th>Reviewed operations</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
        +(exact.length?'<details class="boundary-field-exact"><summary>Exact filter and time vocabularies</summary><ul>'+exact.join('')+'</ul></details>':'');
    }

    function boundaryRelationshipDisplay(relationship){
      const links=(relationship.links||[]).length?relationship.links:[{source_table:relationship.source_table,target_table:relationship.target_table,source_key:relationship.source_key,target_key:relationship.target_key}];
      const resources=[links[0]?.source_table||relationship.source_table,...links.map(link=>link.target_table)];
      const schemas=resources.map(resource=>resource.includes('.')?resource.slice(0,resource.indexOf('.')):'');
      const commonSchema=schemas[0]&&schemas.every(schema=>schema===schemas[0]);
      const short=resource=>commonSchema?resource.slice(resource.indexOf('.')+1):resource;
      return {
        chain:resources.map(short).join(' -> '),
        via:links.map(link=>link.source_key).join(' -> ')
      };
    }

    function renderBoundaryRelationshipMap(model,diagrams){
      const boundaries=model?.boundaries||[];
      if(!boundaries.length)return '';
      const preferred=[boundaryLibrary?.selected_name,activeBoundary?.pack?.name]
        .find(name=>boundaries.some(boundary=>boundary.name===name))||boundaries[0].name;
      const options=boundaries.map(boundary=>
        '<option value="'+esc(boundary.name)+'" '+(boundary.name===preferred?'selected':'')+'>'
        +esc(boundary.name)+' · '+esc(boundary.tables.length)+' table'
        +(boundary.tables.length===1?'':'s')+'</option>').join('');
      const sections=boundaries.map(boundary=>{
        const diagram=(diagrams||[]).find(item=>item.boundary_name===boundary.name)||{};
        const nodes=(boundary.tables||[]).map(table=>{
          const hidden=[];
          if(table.runner_only_field_count)hidden.push(table.runner_only_field_count+' Runner-only');
          if(table.kept_out_field_count)hidden.push(table.kept_out_field_count+' kept out');
          const runnerOnly=table.runner_only_analysis||{};
          const runnerAnalysis=[];
          if((runnerOnly.aggregate_measures||[]).length)runnerAnalysis.push('totals/averages: '+runnerOnly.aggregate_measures.join(', ')+' (raw values withheld)');
          if((runnerOnly.count_distinct_fields||[]).length)runnerAnalysis.push('unique counts: '+runnerOnly.count_distinct_fields.join(', ')+' (raw values withheld)');
          if((runnerOnly.groupable_fields||[]).length)runnerAnalysis.push('group by: '+runnerOnly.groupable_fields.join(', ')+' (labels tokenized)');
          if((runnerOnly.time_bucket_fields||[]).length)runnerAnalysis.push('time: '+runnerOnly.time_bucket_fields.join(', ')+' (labels tokenized)');
          return '<div class="boundary-catalog-node"><strong>'+boundaryIdentifierDisplay(table.id)+'</strong>'
            +renderBoundaryFieldMatrix(table)
            +(runnerAnalysis.length?'<small class="boundary-catalog-capabilities"><strong>Runner-only analysis:</strong> '+esc(runnerAnalysis.join(' · '))+'</small>':'')
            +(hidden.length?'<small class="boundary-catalog-restrictions">Restricted fields: '+esc(hidden.join(' · '))+'</small>':'')
            +'</div>';
        }).join('');
        const edges=(boundary.relationships||[]).map(relationship=>{
          const display=boundaryRelationshipDisplay(relationship);
          const question=(relationship.suggested_questions||[])[0];
          return '<div class="boundary-catalog-path '+(relationship.proven?'':'unproven')+'"><div class="boundary-relationship-summary"><strong>'+esc(relationship.path_depth)+' '+(relationship.path_depth===1?'hop':'hops')+'</strong><code>'+esc(display.chain)+'</code>'+(display.via?'<small>via '+esc(display.via)+'</small>':'')+'<span>'+esc(relationship.cardinality.replaceAll('_','-'))+' · '+(relationship.proven?'catalog proven':'proof unavailable')+'</span><details><summary>Canonical path ID</summary><code>'+esc(relationship.id)+'</code></details></div>'+(question?'<p class="boundary-catalog-question"><strong>Try asking</strong> “'+esc(question)+'”</p>':'')+'</div>';
        }).join('');
        const large=diagram.large===true||boundary.tables.length>10||(boundary.physical_relationship_count||0)>15;
        const hasJoins=(boundary.physical_relationship_count||0)>0;
        const graph=!hasJoins
          ?'<div class="band"><strong>No reviewed joins to draw</strong><p>'+(boundary.tables.length===1?'This boundary contains one reviewed table.':'These tables have no reviewed relationship path.')+' The single-table counts, totals, groupings, filters, and time trends below remain available.</p></div>'
          :large
            ?'<div class="band notice"><strong>Download this large boundary map</strong><p>'+esc(boundary.tables.length)+' tables and '+esc(boundary.physical_relationship_count||0)+' physical joins would be difficult to read inline. The export includes the full readable map and directional Mermaid relationship diagram.</p></div>'
            :renderBoundaryGraphSvg(boundary);
        const questions=[...new Set([
          ...(boundary.relationships||[]).flatMap(relationship=>relationship.suggested_questions||[]),
          ...(boundary.tables||[]).flatMap(table=>table.suggested_questions||[])
        ])].slice(0,3);
        const questionPanel=questions.length?'<div class="boundary-catalog-questions"><strong>'+(hasJoins?'Try cross-table questions':'Try single-table questions')+'</strong><ul>'+questions.map(question=>'<li>“'+esc(question)+'”</li>').join('')+'</ul></div>':'';
        const detail=large?'':'<details><summary>Reviewed fields and relationships</summary><p class="boundary-catalog-legend">Operations are written out by name. Anything omitted from a field is unavailable.</p><div class="boundary-catalog-nodes">'+nodes+'</div>'+(edges?'<div class="boundary-catalog-edges">'+edges+'</div>':'')+'</details>';
        return '<section class="boundary-catalog-boundary" data-boundary-catalog-section="'+esc(boundary.name)+'" '+(boundary.name===preferred?'':'hidden')+'><h4>'+esc(boundary.name)+'</h4>'+graph+questionPanel+detail+(hasJoins?'<details class="boundary-catalog-mermaid"><summary>Mermaid source</summary><pre>'+esc(diagram.mermaid||'flowchart LR')+'</pre></details>':'')+'</section>';
      }).join('');
      return '<details class="boundary-catalog-map" data-boundary-catalog-map><summary>Reviewed data map</summary><div class="boundary-catalog-controls"><label class="field">Boundary<select data-boundary-catalog-select>'+options+'</select></label><div class="actions"><button class="secondary" data-download-boundary-diagram type="button">Download full map</button><button class="quiet" data-copy-boundary-mermaid type="button">Copy Mermaid</button></div></div><p class="boundary-catalog-summary" data-boundary-catalog-summary></p><span class="status-message" data-boundary-catalog-status aria-live="polite"></span>'+sections+'</details>';
    }

    function renderBoundaryGraphSvg(boundary){
      const tables=boundary.tables||[];
      if(!tables.length)return '<p class="muted">No reviewed tables are available in this boundary.</p>';
      const ids=new Set(tables.map(table=>table.id));
      const links=[];
      const seen=new Set();
      (boundary.relationships||[]).forEach(relationship=>(relationship.links||[]).forEach(link=>{
        if(!ids.has(link.source_table)||!ids.has(link.target_table))return;
        const key=[link.source_table,link.target_table,link.source_key,link.target_key].join('|');
        if(seen.has(key))return;
        seen.add(key);
        links.push(Object.assign({},link,{proven:link.proven!==false}));
      }));
      const outgoing=new Map(tables.map(table=>[table.id,[]]));
      const outgoingPorts=new Map(tables.map(table=>[table.id,[]]));
      const incomingPorts=new Map(tables.map(table=>[table.id,[]]));
      const indegree=new Map(tables.map(table=>[table.id,0]));
      links.forEach((link,index)=>{
        outgoing.get(link.source_table).push(link.target_table);
        outgoingPorts.get(link.source_table).push(index);
        incomingPorts.get(link.target_table).push(index);
        indegree.set(link.target_table,(indegree.get(link.target_table)||0)+1);
      });
      const rank=new Map(tables.map(table=>[table.id,0]));
      const queue=tables.map(table=>table.id).filter(id=>(indegree.get(id)||0)===0).sort();
      const visited=new Set();
      while(queue.length){
        const source=queue.shift();
        if(visited.has(source))continue;
        visited.add(source);
        (outgoing.get(source)||[]).forEach(target=>{
          rank.set(target,Math.max(rank.get(target)||0,(rank.get(source)||0)+1));
          indegree.set(target,(indegree.get(target)||0)-1);
          if(indegree.get(target)===0)queue.push(target);
        });
      }
      const maxRank=Math.max(0,...rank.values());
      tables.filter(table=>!visited.has(table.id)).forEach((table,index)=>rank.set(table.id,maxRank+1+index));
      const columns=new Map();
      tables.forEach(table=>{
        const value=rank.get(table.id)||0;
        const column=columns.get(value)||[];
        column.push(table);
        column.sort((left,right)=>left.id.localeCompare(right.id));
        columns.set(value,column);
      });
      const longestNodeText=Math.max(0,...tables.flatMap(table=>[
        table.id.length,
        ...(table.model_visible_fields||[]).slice(0,4).map(field=>field.name.length)
      ]));
      const maxPorts=Math.max(1,...tables.map(table=>Math.max(
        (outgoingPorts.get(table.id)||[]).length,
        (incomingPorts.get(table.id)||[]).length
      )));
      const nodeWidth=Math.max(250,Math.min(420,longestNodeText*7.4+32));
      const nodeHeight=Math.max(126,56+maxPorts*22),xGap=190,yGap=30,pad=28;
      const ranks=[...columns.keys()].sort((left,right)=>left-right);
      const maxRows=Math.max(...ranks.map(value=>columns.get(value).length));
      const width=pad*2+ranks.length*nodeWidth+Math.max(0,ranks.length-1)*xGap;
      const height=pad*2+maxRows*nodeHeight+Math.max(0,maxRows-1)*yGap;
      const positions=new Map();
      ranks.forEach((value,columnIndex)=>{
        const column=columns.get(value);
        const columnHeight=column.length*nodeHeight+Math.max(0,column.length-1)*yGap;
        const offset=pad+(height-pad*2-columnHeight)/2;
        column.forEach((table,rowIndex)=>positions.set(table.id,{
          x:pad+columnIndex*(nodeWidth+xGap),
          y:offset+rowIndex*(nodeHeight+yGap)
        }));
      });
      const marker='catalog-arrow-'+String(boundary.name).replace(/[^A-Za-z0-9_-]/g,'-')+'-'+(++boundaryGraphSequence);
      const portOffset=(ports,tableId,edgeIndex)=>{
        const indexes=ports.get(tableId)||[];
        const position=indexes.indexOf(edgeIndex);
        return (position-(indexes.length-1)/2)*22;
      };
      const edgeSvg=links.map((link,edgeIndex)=>{
        const source=positions.get(link.source_table),target=positions.get(link.target_table);
        if(!source||!target)return '';
        const forward=target.x>=source.x;
        const sx=source.x+(forward?nodeWidth:0);
        const sy=source.y+nodeHeight/2+portOffset(outgoingPorts,link.source_table,edgeIndex);
        const tx=target.x+(forward?0:nodeWidth);
        const ty=target.y+nodeHeight/2+portOffset(incomingPorts,link.target_table,edgeIndex);
        const mx=(sx+tx)/2;
        const label=link.hidden_join_key?'reviewed hidden key':link.source_key+' → '+link.target_key;
        const edgeTitle=link.source_table+'.'+link.source_key+' to '+link.target_table+'.'+link.target_key+'; '+(link.proven?'catalog proven':'proof unavailable');
        return '<path class="edge '+(link.proven?'':'unproven')+'" d="M '+sx+' '+sy+' C '+mx+' '+sy+', '+mx+' '+ty+', '+tx+' '+ty+'" marker-end="url(#'+marker+')"><title>'+esc(edgeTitle)+'</title></path><text class="edge-label" x="'+(sx+(forward?12:-12))+'" y="'+(sy-8)+'" text-anchor="'+(forward?'start':'end')+'">'+esc(label.slice(0,50))+'<title>'+esc(edgeTitle)+'</title></text>';
      }).join('');
      const nodeSvg=tables.map(table=>{
        const point=positions.get(table.id);
        const fields=(table.model_visible_fields||[]).slice(0,4).map(field=>field.name);
        const hidden=(table.runner_only_field_count||0)+(table.kept_out_field_count||0);
        const lines=[...fields,...((table.model_visible_fields||[]).length>4?['+'+((table.model_visible_fields||[]).length-4)+' more visible']:[]),...(hidden?[''+hidden+' unavailable to model']:[])].slice(0,5);
        return '<g><title>'+esc(table.id+'; '+(table.model_visible_fields||[]).map(field=>field.name).join(', '))+'</title><rect class="node" x="'+point.x+'" y="'+point.y+'" width="'+nodeWidth+'" height="'+nodeHeight+'" rx="6"></rect><text class="node-title" x="'+(point.x+14)+'" y="'+(point.y+23)+'">'+esc(table.id.slice(0,52))+'</text>'+lines.map((line,index)=>'<text class="node-field" x="'+(point.x+14)+'" y="'+(point.y+47+index*16)+'">'+esc(line.slice(0,52))+'</text>').join('')+'</g>';
      }).join('');
      return '<div class="boundary-catalog-graph" role="img" aria-label="Reviewed table relationship diagram for '+esc(boundary.name)+'"><svg viewBox="0 0 '+width+' '+height+'" width="'+width+'" height="'+height+'"><defs><marker id="'+marker+'" markerWidth="9" markerHeight="7" refX="8" refY="3.5" orient="auto"><polygon points="0 0, 9 3.5, 0 7" fill="#75e3b7"></polygon></marker></defs>'+edgeSvg+nodeSvg+'</svg></div><p class="muted">Arrows point from the many-row table to the reviewed one-row ancestor. Each reviewed join uses its own labeled connection lane. Solid lines are catalog-proven; dashed lines require proof before activation.</p>';
    }

    function wireBoundaryRelationshipMaps(scope=document){
      scope.querySelectorAll('[data-boundary-catalog-map]').forEach(root=>{
        const select=root.querySelector('[data-boundary-catalog-select]');
        const summary=root.querySelector('[data-boundary-catalog-summary]');
        const status=root.querySelector('[data-boundary-catalog-status]');
        const copyMermaid=root.querySelector('[data-copy-boundary-mermaid]');
        const update=()=>{
          const name=select.value;
          root.querySelectorAll('[data-boundary-catalog-section]').forEach(section=>{
            section.hidden=section.dataset.boundaryCatalogSection!==name;
          });
          const boundary=(boundaryCatalog.boundaries||[]).find(item=>item.name===name);
          if(boundary){
            summary.textContent=boundary.tables.length+' reviewed table'+(boundary.tables.length===1?'':'s')+' · '+(boundary.physical_relationship_count||0)+' physical join'+((boundary.physical_relationship_count||0)===1?'':'s')+' · '+boundary.relationships.length+' reviewed path'+(boundary.relationships.length===1?'':'s')+'. This is one exact active boundary; it is never merged with another.';
            copyMermaid.hidden=(boundary.physical_relationship_count||0)===0;
          }
          status.textContent='';
        };
        select.onchange=update;
        root.querySelector('[data-download-boundary-diagram]').onclick=()=>{
          const diagram=(boundaryDiagrams||[]).find(item=>item.boundary_name===select.value);
          if(!diagram){
            status.className='status-message error';
            status.textContent='This boundary export is unavailable. Reload Workbench and retry.';
            return;
          }
          const blob=new Blob([diagram.markdown],{type:'text/markdown'});
          const href=URL.createObjectURL(blob);
          const anchor=document.createElement('a');
          anchor.href=href;
          anchor.download=diagram.file_name;
          anchor.click();
          URL.revokeObjectURL(href);
          status.className='status-message';
          status.textContent='Downloaded the exact '+diagram.boundary_name+' boundary map. No source rows were read.';
        };
        copyMermaid.onclick=async()=>{
          const diagram=(boundaryDiagrams||[]).find(item=>item.boundary_name===select.value);
          if(!diagram){
            status.className='status-message error';
            status.textContent='Mermaid source is unavailable. Reload Workbench and retry.';
            return;
          }
          try{
            await navigator.clipboard.writeText(diagram.mermaid);
            status.className='status-message';
            status.textContent='Copied Mermaid for '+diagram.boundary_name+'.';
          }catch{
            status.className='status-message error';
            status.textContent='Clipboard access was unavailable. Open Mermaid source and copy it manually.';
          }
        };
        update();
      });
    }

    function askReviewTarget(call){
      const result=call?.result&&typeof call.result==="object"?call.result:{};
      const details=result.details&&typeof result.details==="object"
        ?result.details
        :result.outcome?.details&&typeof result.outcome.details==="object"
          ?result.outcome.details
          :{};
      const relationship=details.relationship_review&&typeof details.relationship_review==="object"
        ?details.relationship_review
        :{};
      const plan=call?.arguments?.plan&&typeof call.arguments.plan==="object"
        ?call.arguments.plan
        :{};
      const resource=[details.resource,relationship.resource,relationship.source_resource,plan.resource]
        .find(value=>typeof value==="string"&&value);
      const fieldCandidates=[
        details.field,
        relationship.field,
        ...(Array.isArray(plan.select)?plan.select:[]),
        ...(Array.isArray(plan.dimensions)?plan.dimensions.map(item=>item?.field):[]),
        ...(Array.isArray(plan.measures)?plan.measures.map(item=>item?.field):[]),
        ...(Array.isArray(plan.where)?plan.where.map(item=>item?.field):[]),
        ...(Array.isArray(plan.filters)?plan.filters.map(item=>item?.field):[]),
        ...(Array.isArray(plan.order_by)?plan.order_by.map(item=>item?.field):[])
      ];
      const field=fieldCandidates.find(value=>typeof value==="string"&&value);
      return resource||field?{resource,field}:null;
    }

    function askReviewTargetAttributes(target){
      return (target?.resource?' data-review-resource="'+esc(target.resource)+'"':"")
        +(target?.field?' data-review-field="'+esc(target.field)+'"':"");
    }

    function askBoundaryEditAction(target=null){
      return '<div class="ask-boundary-actions"><p>Need another table, field, measure, or relationship? A human can review a wider boundary. The model cannot change this access.</p><button class="secondary" data-edit-ask-boundary'+askReviewTargetAttributes(target)+' type="button">Review or expand access</button></div>';
    }

    function askAccessGuidanceHtml(guidance){
      if(!guidance||typeof guidance!=="object")return "";
      const target={
        resource:typeof guidance.review_resource==="string"?guidance.review_resource:undefined,
        field:typeof guidance.review_field==="string"?guidance.review_field:undefined
      };
      const review=guidance.kind==="review_candidate"
        ?guidance.review_focus==="privacy"&&target.resource
          ?'<button class="secondary" data-review-privacy-resource="'+esc(target.resource)+'" type="button">Review privacy for this table</button>'
          :'<button class="secondary" data-review-another-question'+askReviewTargetAttributes(target)+' type="button">Review this candidate access</button>'
        :"";
      return '<section class="ask-access-guidance"><span class="instant-kicker">Human review path</span><h3>'+esc(guidance.title||"More reviewed access is needed")+'</h3><p>'+esc(guidance.message||"")+'</p>'
        +(guidance.candidate_path?'<p><strong>Candidate path:</strong> '+esc(guidance.candidate_path)+'</p>':"")
        +'<p>'+esc(guidance.next_action||"")+'</p>'
        +(review?'<div class="actions">'+review+'</div>':"")+'</section>';
    }

    function wireAskBoundaryEditAction(){
      document.querySelectorAll("[data-edit-ask-boundary]").forEach(button=>button.onclick=()=>openAccessEditor(button.dataset.reviewResource,button.dataset.reviewField));
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
        byId("ask-timeout").value="";
      }
      updateAskCredentialFields();
      if(!askStatus?.credential_environment?.[provider])byId("ask-credential-details").open=true;
    }

    function updateAskCredentialFields(){
      const source=byId("ask-key-source").value;
      byId("ask-key-wrap").classList.toggle("hidden",source!=="session");
      byId("ask-key-env-wrap").classList.toggle("hidden",source!=="environment");
      if(source!=="session")byId("ask-key").value="";
      const summary=byId("ask-credential-details").querySelector("summary");
      summary.textContent=source==="environment"
        ?"Credential · "+(byId("ask-key-env").value||"environment variable")
        :source==="none"
          ?"Credential · none required by this local endpoint"
          :"Credential · session-only API key";
    }

    async function configureAsk(){
      const status=byId("ask-config-status");
      try{
        if(!askStatus?.available)throw new Error("Activate a reviewed tool before configuring Ask.");
        if(!byId("ask-egress").checked){
          const review=byId("ask-egress-review");
          review.classList.add("needs-attention");
          status.className="status-message error";
          status.textContent="Select the provider-egress checkbox above to continue. Your unsent key remains in this form.";
          requestAnimationFrame(()=>{
            review.scrollIntoView({behavior:"smooth",block:"center"});
            byId("ask-egress").focus();
          });
          return;
        }
        byId("ask-egress-review").classList.remove("needs-attention");
        const provider=byId("ask-provider").value;
        const keySource=byId("ask-key-source").value;
        const body={
          provider,
          model:byId("ask-model").value.trim(),
          authority_digest:askStatus.authority_digest,
          egress_acknowledged:byId("ask-egress").checked
        };
        if(provider==="openai_compatible")body.base_url=byId("ask-base-url").value.trim();
        const requestTimeout=byId("ask-timeout").value.trim();
        if(requestTimeout)body.request_timeout_seconds=Number(requestTimeout);
        const sessionTokenBudget=byId("ask-session-token-budget").value.trim();
        if(sessionTokenBudget)body.session_token_budget=Number(sessionTokenBudget);
        const maxOutputTokens=byId("ask-max-output-tokens").value.trim();
        if(maxOutputTokens)body.max_output_tokens=Number(maxOutputTokens);
        if(keySource==="session"){
          const pastedKey=byId("ask-key").value.trim();
          const looksLikeAssignment=/^(?:export\\s+)?[A-Za-z_][A-Za-z0-9_]*\\s*=/.test(pastedKey);
          const looksQuoted=pastedKey.length>1
            &&((pastedKey.startsWith('"')&&pastedKey.endsWith('"'))||(pastedKey.startsWith("'")&&pastedKey.endsWith("'")));
          if(looksLikeAssignment||looksQuoted){
            throw new Error("Paste only the provider API key value, without OPENAI_API_KEY=, ANTHROPIC_API_KEY=, or surrounding quotes.");
          }
          body.api_key=pastedKey;
        }
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
        if(error.payload?.error_code!=="ASK_EGRESS_ACKNOWLEDGEMENT_REQUIRED")byId("ask-key").value="";
        status.className="status-message error";
        status.textContent=error.message;
        if(error.payload?.error_code==="ASK_EGRESS_ACKNOWLEDGEMENT_REQUIRED"){
          const review=byId("ask-egress-review");
          review.classList.add("needs-attention");
          requestAnimationFrame(()=>{review.scrollIntoView({behavior:"smooth",block:"center"});byId("ask-egress").focus()});
        }
      }
    }

    async function updateAskLimits(){
      const button=byId("update-ask-limits");
      const status=byId("ask-limit-status");
      button.disabled=true;
      status.className="status-message";
      status.textContent="Updating in-memory Ask limits...";
      try{
        const sessionBudget=byId("ask-live-session-token-budget").value.trim();
        if(!sessionBudget)throw new Error("Enter the cumulative session reported-token budget.");
        const outputLimit=byId("ask-live-max-output-tokens").value.trim();
        await post("/api/ask/limits",{
          session_token_budget:Number(sessionBudget),
          max_output_tokens:outputLimit?Number(outputLimit):null
        });
        status.textContent="Ask limits updated. Conversation context was preserved.";
        await loadAskStatus();
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }finally{
        button.disabled=false;
      }
    }

    async function configureAskOnFirstQuestion(){
      if(!askConsentOnSubmit)return;
      const provider=soleEnvironmentProvider();
      if(!provider)throw new Error("The configured provider changed. Review provider settings before asking.");
      const model=provider==="openai"?"gpt-5-mini":"claude-sonnet-4-20250514";
      const keyEnv=provider==="openai"?"OPENAI_API_KEY":"ANTHROPIC_API_KEY";
      await post("/api/ask/configure",{
        provider,
        model,
        authority_digest:askStatus.authority_digest,
        egress_acknowledged:true,
        api_key_env:keyEnv
      });
      askConsentOnSubmit=false;
      await loadAskStatus();
    }

    async function proveBoundary(){
      const buttons=[...document.querySelectorAll("[data-prove-boundary]")];
      const target=byId("boundary-proof-result");
      buttons.forEach(button=>{button.disabled=true;button.textContent="Proving..."});
      target.innerHTML='<section class="boundary-proof-report"><strong>Running escape attempts through the real model-facing tools...</strong><p>The subtraction check may run bounded read-only aggregates. Their values are discarded and are not stored in the proof.</p></section>';
      try{
        const payload=await post("/api/boundary/prove",{});
        const proof=payload.proof;
        const attacks=proof?.attacks||[];
        const held=proof?.passed===true;
        target.innerHTML='<section class="boundary-proof-report'+(held?'':' failed')+'">'
          +'<div class="boundary-proof-head"><div><span class="instant-kicker">Deterministic local proof</span><h3>'+(held?'Boundary held':'Boundary proof failed')+'</h3><p>'+(held?'Direct escape attempts were refused, and Runner did not release both sides of a suppressed-total subtraction.':'At least one escape attempt did not produce its required refusal. Treat this boundary as unsafe until investigated.')+'</p></div><span class="badge '+(held?'good':'')+'">'+esc(attacks.filter(item=>item.passed).length)+' / '+esc(attacks.length)+' held</span></div>'
          +'<div class="boundary-proof-grid">'+attacks.map(item=>'<div class="boundary-proof-item"><strong>'+esc(item.passed?'Held · '+item.title:'FAILED · '+item.title)+'</strong><small>'+esc(item.refusal_code)+' · '+esc(item.explanation)+'</small></div>').join("")+'</div>'
          +'<p><strong>Proof attempts:</strong> 0 raw source rows returned · aggregate probe values discarded · source database unchanged. A subtraction probe may read scoped rows in a read-only transaction.</p>'
          +'<div class="actions"><button class="secondary" id="download-boundary-proof" type="button">Download proof</button><span class="muted">Saved locally at '+esc(payload.artifact_path||".synapsor/proofs")+'</span></div>'
          +'</section>';
        byId("download-boundary-proof").onclick=()=>{
          const blob=new Blob([JSON.stringify(proof,null,2)+"\\n"],{type:"application/json"});
          const href=URL.createObjectURL(blob);
          const anchor=document.createElement("a");
          anchor.href=href;
          anchor.download="synapsor-boundary-proof.json";
          anchor.click();
          URL.revokeObjectURL(href);
        };
        target.scrollIntoView({behavior:"smooth",block:"nearest"});
      }catch(error){
        target.innerHTML='<section class="boundary-proof-report failed"><span class="instant-kicker">Proof unavailable</span><h3>Runner could not complete the boundary proof.</h3><p>'+esc(error.message)+'</p></section>';
      }finally{
        buttons.forEach(button=>{button.disabled=false;button.textContent="Prove this boundary"});
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
      try{
        await configureAskOnFirstQuestion();
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
        showAskConfiguration();
        return;
      }
      const run=byId("run-ask");
      const cancel=byId("cancel-ask");
      const transcript=byId("ask-transcript");
      const composer=run.closest(".ask-composer");
      run.disabled=true;
      run.textContent="Asking...";
      run.classList.add("loading");
      cancel.disabled=false;
      composer.classList.add("is-running");
      composer.setAttribute("aria-busy","true");
      status.className="status-message";
      status.textContent="Asking your model through the reviewed data boundary...";
      transcript.insertAdjacentHTML("beforeend",'<div class="ask-turn"><strong>You</strong><p>'+esc(question)+'</p></div>');
      transcript.lastElementChild?.scrollIntoView({behavior:"smooth",block:"nearest"});
      byId("ask-question").value="";
      try{
        const payload=await post("/api/ask/run",{question});
	        const calls=payload.tool_calls||[];
	        const modelWithheldValues=calls.some(call=>call.model_withheld_values===true);
	        const proposals=calls.map(call=>proposalIdFromAskResult(call.result)).filter(Boolean);
	          const protectableRefs=[...new Set(calls.map(call=>call.result?.protect?.query_ref).filter(Boolean))];
	          protectableRefs.forEach(reference=>{
	            const call=calls.find(candidate=>candidate.result?.protect?.query_ref===reference);
	            if(call)askEvidenceByRef.set(reference,{question,call});
	          });
          const completedOperation=calls.some(call=>call.tool!=="app.describe_data"&&call.status==="ok"&&call.result?.ok!==false);
          const visibleCalls=calls.filter(call=>
            call.tool!=="app.describe_data"&&(!completedOperation||call.status==="ok"&&call.result?.ok!==false));
          const backgroundCalls=calls.filter(call=>
            call.tool==="app.describe_data"||completedOperation&&(call.status!=="ok"||call.result?.ok===false));
		        const analyses=visibleCalls.map(call=>renderAskToolResult(call)).join("");
	          const refusedReviewTarget=visibleCalls.map(askReviewTarget).find(Boolean)||null;
	          const background=backgroundCalls.length
            ?'<details class="ask-recovery"><summary>'+esc(backgroundAttemptSummary(backgroundCalls,completedOperation))+'</summary>'+backgroundCalls.map(call=>renderAskToolResult(call)).join("")+'</details>'
            :"";
	        const answerLabel=(payload.display_answer_source||payload.answer_source)==="runner"
	          ?"Runner boundary explanation"
	          :"Model interpretation · "+providerLabel(payload.provider);
	          const displayedAnswer=String(payload.display_answer||payload.answer||"");
	          const suppressedShareWarning=(payload.display_answer_source||payload.answer_source)!=="runner"
	            &&calls.some(call=>askSuppressedGroupCount(call.result)>0)
	            &&/(?:\bshares?\b|\bpercent(?:age|ages|s)?\s+of\b|%\s+of\b)/i.test(displayedAnswer)
	              ?'<div class="notice"><strong>Complete-population share unavailable</strong><p>At least one group was withheld. Percentages calculated from the displayed rows describe only the returned non-suppressed subtotal.</p></div>'
	              :"";
	          const accessGuidance=askAccessGuidanceHtml(payload.access_guidance);
	          const refusedSourceExecuted=payload.access_guidance?.source_query_executed===true;
	          const runnerOutput=completedOperation
            ?'<details class="ask-verified"><summary><span class="badge runner-verified">Runner verified</span><span class="ask-verified-hint">Numbers in this answer come from the bounded plan, not model prose</span></summary><div class="ask-verified-body">'+analyses+'</div></details>'
	            :visibleCalls.length
	              ?'<section class="ask-refused"><span class="instant-kicker">'+(refusedSourceExecuted?'Result not released':'Nothing ran')+'</span><h3>'+esc(payload.access_guidance?.title||"That question needs data outside this boundary.")+'</h3><p>'+(refusedSourceExecuted?'Runner executed a read-only aggregate, then discarded the result because releasing it would cross the reviewed privacy boundary.':'Runner stopped every attempted plan before it could return source data.')+'</p>'+analyses+accessGuidance+'<div class="actions">'+(askStarterPrompts[0]?'<button class="secondary" data-ask-alternative type="button">Ask instead: '+esc(askStarterPrompts[0])+'</button>':'')+(payload.access_guidance?.kind==="review_candidate"?'':'<button class="quiet" data-review-another-question'+askReviewTargetAttributes(refusedReviewTarget)+' type="button">Review or expand access</button>')+'</div></section>'
              :'<div class="notice"><strong>No Runner data query was executed for this answer.</strong></div>'+accessGuidance;
          const modelPanel='<section class="ask-model-panel"><span class="ask-model-label">'+esc(answerLabel)+'</span>'
            +(modelWithheldValues?'<div class="notice"><strong>Some values were shown only to you.</strong><p>Runner withheld them from the model, so its summary cannot name them. The verified result still applies the reviewed scope, suppression, and budgets.</p></div>':"")
            +askAnswerHtml(payload)+suppressedShareWarning+'</section>';
	        const protectAction=protectableRefs.length===1
	          ?'<div class="actions ask-result-actions"><button data-ask-protect="'+esc(protectableRefs[0])+'" type="button">Make this reusable</button><span class="muted">Creates a disabled named capability for separate exact review.</span></div>'
	          :protectableRefs.length>1
	            ?'<div class="actions ask-result-actions"><button data-ask-protect-picker type="button">Choose an analysis to make reusable</button><span class="muted">This answer used multiple reviewed analyses; Runner will not choose one silently.</span></div>'
	            :"";
	        transcript.insertAdjacentHTML("beforeend",'<div class="ask-turn answer"><div class="ask-answer-grid">'+modelPanel
	          +runnerOutput+'</div>'+protectAction
            +background
	          +(proposals.length?'<div class="notice"><strong>Proposal only</strong><p>The source database did not change. The model cannot approve or apply this proposal.</p></div>':'')+'</div>');
          document.body.classList.add("ask-result-mode");
          transcript.lastElementChild?.scrollIntoView({behavior:"smooth",block:"start"});
	        transcript.querySelectorAll("[data-ask-protect]").forEach(button=>button.onclick=async()=>{preferredProtectQueryRef=button.dataset.askProtect;await loadProtect(preferredProtectQueryRef);setView("protect")});
	        transcript.querySelectorAll("[data-ask-protect-picker]").forEach(button=>button.onclick=async()=>{preferredProtectQueryRef=null;await loadProtect();setView("protect")});
          transcript.querySelectorAll("[data-ask-alternative]").forEach(button=>button.onclick=()=>{
            byId("ask-question").value=askStarterPrompts[0]||"";
            byId("ask-question").focus();
          });
	          transcript.querySelectorAll("[data-review-another-question],[data-review-refusal-access]").forEach(button=>button.onclick=()=>openAccessEditor(button.dataset.reviewResource,button.dataset.reviewField));
	          transcript.querySelectorAll("[data-review-privacy-resource]").forEach(button=>button.onclick=()=>openAccessEditor(button.dataset.reviewPrivacyResource,undefined,true));
	          transcript.querySelectorAll("[data-explore-evidence]").forEach(button=>button.onclick=()=>loadExploreOperatorEvidence(button));
        status.className="status-message";
        status.textContent=completedOperation
          ?""
          :visibleCalls.length
            ?refusedSourceExecuted
              ?"The read-only result was discarded. Choose another question or review this table's minimum group size."
              :"Choose the validated alternative or review the boundary."
            :payload.next_action||"Ask another bounded question.";
      }catch(error){
        const presentation=askFailurePresentation(error);
        transcript.insertAdjacentHTML("beforeend",'<div class="ask-turn error"><strong>'+esc(presentation.title)+'</strong><p>'+esc(presentation.message)+'</p><p>'+esc(presentation.detail)+'</p>'
          +(presentation.action?'<div class="actions"><button class="secondary" data-ask-error-action type="button">'+esc(presentation.action)+'</button></div>':"")
          +'</div>');
        const errorAction=transcript.lastElementChild?.querySelector("[data-ask-error-action]");
        if(errorAction)errorAction.onclick=async()=>{
          if(presentation.limits){
            const limits=byId("ask-live-limits");
            limits.open=true;
            limits.scrollIntoView({behavior:"smooth",block:"center"});
            byId("ask-live-session-token-budget").focus();
            return;
          }
          if(presentation.reload){
            await loadAskStatus();
            return;
          }
          if(presentation.recoverCredential)showAskCredentialRecovery();
        };
        document.body.classList.add("ask-result-mode");
        status.className="status-message error";
        status.textContent=presentation.detail;
      }finally{
        run.disabled=false;
        run.textContent="Ask";
        run.classList.remove("loading");
        cancel.disabled=true;
        composer.classList.remove("is-running");
        composer.removeAttribute("aria-busy");
      }
    }

    function historyPlanSentence(query){
      try{return planSentence(query.normalized_plan)}
      catch{return (query.kind==="aggregate"?"Aggregate":"Bounded rows")+" on "+query.resource+"."}
    }

    function ledgerSourceSentence(source){
      if(source?.kind==="shared_postgres")return "Shared PostgreSQL ledger · schema "+source.schema+" · URL from "+source.url_env+" · read-only";
      return "Local SQLite ledger · "+(source?.path||"configured local store");
    }

    async function loadAskHistory(){
      const button=byId("load-ask-history");
      const status=byId("ask-history-status");
      const content=byId("ask-history-content");
      button.disabled=true;
      button.textContent="Loading...";
      status.className="status-message";
      status.textContent="Reading metadata-only query history from the configured ledger...";
      try{
        const params=new URLSearchParams();
        const tenant=byId("ask-history-tenant").value.trim();
        const table=byId("ask-history-table").value.trim();
        const capability=byId("ask-history-capability").value.trim();
        const since=byId("ask-history-since").value;
        if(tenant)params.set("tenant",tenant);
        if(table)params.set("table",table);
        if(capability)params.set("capability",capability);
        if(since)params.set("since",new Date(since).toISOString());
        const payload=await getJson("/api/explore/history"+(params.size?"?"+params.toString():""));
        const sourceLabel=ledgerSourceSentence(payload.ledger_source);
        const recent=payload.recent||[];
        const durable=payload.durable||[];
        const recentHtml=recent.length
          ?'<h4>Recent references</h4><div class="ask-history-table-wrap"><table class="history-recent-table"><thead><tr><th>Reference</th><th>Request</th><th>Status</th><th>Expires</th></tr></thead><tbody>'+recent.map((query,index)=>'<tr><td data-label="Reference"><code>'+esc(query.query_ref)+'</code></td><td data-label="Request">'+esc(historyPlanSentence(query))+'</td><td data-label="Status" class="'+(index===0?'history-status-latest':'')+'">'+(index===0?'Latest':'Available')+'</td><td data-label="Expires">'+esc(new Date(query.expires_at).toLocaleString())+'</td></tr>').join("")+'</tbody></table></div><p class="muted">Open Make reusable to inspect or protect one of these references.</p>'
          :'<h4>Recent references</h4><p class="muted">No unexpired analysis reference is available in this Workbench session.</p>';
        const durableHtml=durable.length
          ?'<h4>Durable query ledger</h4><div class="ask-history-table-wrap"><table class="history-durable-table"><thead><tr><th>Audit</th><th>When</th><th>Resource</th><th>Outcome</th><th>Rows / groups</th><th>Evidence</th></tr></thead><tbody>'+durable.map(audit=>'<tr><td data-label="Audit"><button class="quiet" data-history-audit="'+esc(audit.audit_id)+'" type="button">'+esc(audit.audit_id)+'</button></td><td data-label="When">'+esc(new Date(audit.created_at).toLocaleString())+'</td><td data-label="Resource"><code>'+esc(audit.resource)+'</code></td><td data-label="Outcome" class="'+(String(audit.status).startsWith("refused")?'history-status-refused':'')+'">'+esc(String(audit.status).replaceAll("_"," "))+(audit.error_code?' · '+esc(audit.error_code):'')+'</td><td data-label="Rows / groups">'+esc(audit.returned_rows_or_groups)+'</td><td data-label="Evidence">'+(audit.evidence_bundle_id?'<button class="quiet" data-history-evidence="'+esc(audit.evidence_bundle_id)+'" type="button">'+esc(audit.evidence_bundle_id)+'</button>':'None')+'</td></tr>').join("")+'</tbody></table></div><div id="ask-history-detail"></div>'
          :'<h4>Durable query ledger</h4><p class="muted">No Explore audit metadata was found in '+esc(sourceLabel)+'.</p>';
        content.innerHTML='<p><strong>Ledger source</strong><br>'+esc(sourceLabel)+'</p>'+recentHtml+durableHtml;
        content.querySelectorAll("[data-history-audit]").forEach(item=>item.onclick=()=>loadAskHistoryDetail(item.dataset.historyAudit));
        content.querySelectorAll("[data-history-evidence]").forEach(item=>item.onclick=()=>loadAskEvidenceDetail(item.dataset.historyEvidence));
        status.textContent=recent.length+" recent "+(recent.length===1?"reference":"references")+" · "+durable.length+" durable audit "+(durable.length===1?"record":"records")+" · "+sourceLabel+". Result and trusted-scope values are not persisted.";
      }catch(error){
        content.innerHTML="";
        status.className="status-message error";
        status.textContent=error.message;
      }finally{
        button.disabled=false;
        button.textContent="Refresh query history";
      }
    }

    async function loadAskHistoryDetail(auditId){
      const target=byId("ask-history-detail");
      if(!target)return;
      target.innerHTML='<p class="muted">Loading audit '+esc(auditId)+'...</p>';
      try{
        const payload=await getJson("/api/explore/history?audit_id="+encodeURIComponent(auditId));
        const audit=payload.audit;
        target.innerHTML='<details open><summary>Audit '+esc(audit.audit_id)+' details</summary><p><strong>Ledger source:</strong> '+esc(ledgerSourceSentence(payload.ledger_source))+'</p><p>Metadata only. Any filter literals in the normalized plan are keyed fingerprints, not source values.</p><pre id="ask-history-json"></pre></details>';
        renderSyntaxCode("ask-history-json",JSON.stringify(audit,null,2),"JSON");
      }catch(error){
        target.innerHTML='<p class="error">'+esc(error.message)+'</p>';
      }
    }

    async function loadAskEvidenceDetail(evidenceId){
      const target=byId("ask-history-detail");
      if(!target)return;
      target.innerHTML='<p class="muted">Loading evidence '+esc(evidenceId)+'...</p>';
      try{
        const payload=await getJson("/api/explore/evidence?evidence_id="+encodeURIComponent(evidenceId));
        target.innerHTML='<details open><summary>Evidence '+esc(evidenceId)+'</summary><p><strong>Ledger source:</strong> '+esc(ledgerSourceSentence(payload.ledger_source))+'</p><p>Metadata only. Result values and raw trusted-scope values are not persisted.</p><pre id="ask-history-evidence-json"></pre></details>';
        renderSyntaxCode("ask-history-evidence-json",JSON.stringify(payload.evidence,null,2),"JSON");
      }catch(error){
        target.innerHTML='<p class="error">'+esc(error.message)+'</p>';
      }
    }

    function askAnswerHtml(payload){
      const fullAnswer=String(payload.answer||"").trim();
      const answer=String(payload.display_answer||fullAnswer).trim();
      if((payload.display_answer_source||payload.answer_source)==="runner")return '<p>'+esc(answer)+'</p>'+(fullAnswer&&fullAnswer!==answer?'<details><summary>Full model explanation</summary><p>'+esc(fullAnswer)+'</p></details>':'');
      if(answer.length<=700&&answer===fullAnswer)return '<p>'+esc(answer)+'</p>';
      if(answer.length<=700)return '<p>'+esc(answer)+'</p><details><summary>Full model explanation</summary><p>'+esc(fullAnswer)+'</p></details>';
      const firstSentence=answer.match(/^.*?[.!?](?:\\s|$)/)?.[0]?.trim();
      const preview=(firstSentence||answer.slice(0,500)).slice(0,700);
      return '<p>'+esc(preview)+'</p><details><summary>Full model explanation</summary><p>'+esc(fullAnswer)+'</p></details>';
    }

    function backgroundAttemptSummary(calls,completedOperation){
      const catalogs=calls.filter(call=>call.tool==="app.describe_data").length;
      const refused=calls.length-catalogs;
      const parts=[];
      if(catalogs)parts.push("reviewed catalog checked");
      if(refused)parts.push(refused+" model attempt"+(refused===1?" was":"s were")+" safely refused");
      return (completedOperation?"Before the valid plan: ":"Boundary details: ")+parts.join(" · ");
    }

    function exploreEvidenceDisclosure(call,result,planValidated){
      const semantics=result.outcome?.result||{};
      const queryRef=result.protect?.query_ref;
      const returned={
        outcome:result.outcome||null,
        privacy:result.privacy||semantics.suppression||null,
        audit:result.audit||null,
        evidence_bundle_id:result.evidence_bundle_id||null,
        source_database_changed:result.source_database_changed===true
      };
      const execution={
        plan_validated:planValidated,
        boundary_name:result.boundary_name||call.arguments?.boundary||null,
        boundary_digest:result.boundary_digest||null,
        normalized_plan:planValidated?call.arguments?.plan:null,
        result_semantics:planValidated?semantics:null,
        resolved_time_windows:planValidated?(result.operator_time_windows||null):null
      };
      return '<details class="ask-execution-evidence"><summary>What the model requested and Runner executed</summary>'
        +'<h4>What the model requested</h4><pre>'+esc(JSON.stringify({tool:call.tool,arguments:call.arguments},null,2))+'</pre>'
        +'<h4>What Runner executed</h4><pre>'+esc(JSON.stringify(execution,null,2))+'</pre>'
          +'<h4>What Runner returned or withheld</h4><pre>'+esc(JSON.stringify(returned,null,2))+'</pre>'+renderOperatorExecutionCost(result)
        +(queryRef?'<button class="quiet" data-explore-evidence="'+esc(queryRef)+'" type="button">Show operator SQL diagnostic</button><div data-evidence-target></div>':'')
        +'</details>';
    }

    async function loadExploreOperatorEvidence(button){
      const target=button.closest("details")?.querySelector("[data-evidence-target]");
      if(!target)return;
      button.disabled=true;
      button.textContent="Loading diagnostic...";
      try{
        const payload=await getJson("/api/explore/evidence?query_ref="+encodeURIComponent(button.dataset.exploreEvidence)+"&include_sql=1");
        const compiled=payload.compiled_statement;
        target.innerHTML='<div class="band notice"><strong>Operator diagnostic only</strong><p>The model never received this SQL. Parameter values are redacted, and this view is not persisted.</p></div>'
          +(compiled?.statements||[]).map((statement,index)=>'<section><h4>Statement '+esc(index+1)+(statement.period?' · '+esc(statement.period):'')+'</h4><pre data-compiled-sql="'+index+'"></pre><p><strong>Parameter types:</strong> '+esc((statement.parameter_types||[]).join(", ")||"none")+'<br><strong>Parameter values:</strong> redacted</p></section>').join("");
        (compiled?.statements||[]).forEach((statement,index)=>renderSyntaxCode(target.querySelector('[data-compiled-sql="'+index+'"]'),statement.statement,"SQL"));
        button.textContent="SQL diagnostic loaded";
      }catch(error){
        target.innerHTML='<p class="error">'+esc(error.message)+'</p>';
        button.disabled=false;
        button.textContent="Retry operator SQL diagnostic";
      }
    }

    function renderAskToolResult(call){
      const result=call.result&&typeof call.result==="object"?call.result:{};
      const proposalId=proposalIdFromAskResult(result);
      if(proposalId){
        return '<section class="ask-tool-trace"><strong>Proposal created</strong><p>Proposal <code>'+esc(proposalId)+'</code>. The model cannot approve or apply it.</p><details><summary>Advanced bounded result</summary><pre>'+esc(JSON.stringify({arguments:call.arguments,result},null,2))+'</pre></details></section>';
      }
      const refusalCode=call.error_code||result.error_code||"BOUNDARY_REFUSED";
      const refusalMessage=result.message||result.error||result.outcome?.message||"The request was outside the activated reviewed boundary.";
	      if(call.status!=="ok"||result.ok===false){
	        const attempted=call.arguments?.plan&&typeof call.arguments.plan==="object"
	          ?'<p><strong>Attempted plan:</strong> '+esc(safeAttemptedPlanSentence(call.arguments.plan))+'</p>'
	          :"";
	        const target=askReviewTarget(call);
	        const refusalDetails=result.details&&typeof result.details==="object"
	          ?result.details
	          :result.outcome?.details&&typeof result.outcome.details==="object"
	            ?result.outcome.details
	            :{};
	        const sourceExecuted=refusalDetails.source_query_executed===true||refusalCode==="EXPLORE_RESPONSE_TOO_LARGE";
	        const execution=sourceExecuted
	          ?refusalCode==="EXPLORE_PRIVACY_BUDGET_EXHAUSTED"
	            ?"yes; the privacy-reconstructing result was discarded"
	            :"yes; the bounded result was discarded"
	          :refusalCode==="EXPLORE_SOURCE_UNAVAILABLE"
	            ?"outcome unavailable"
	            :"no; validation stopped it first";
	        return '<section class="ask-tool-trace refusal"><strong>Stopped at the reviewed boundary</strong>'+attempted+'<p>'+esc(refusalMessage)+'</p><p><strong>Source query executed:</strong> '+esc(execution)+'</p><button class="quiet" data-review-refusal-access'+askReviewTargetAttributes(target)+' type="button">Review or expand access</button>'+exploreEvidenceDisclosure(call,result,false)+'</section>';
	      }
      if(call.tool==="app.describe_data"){
        const resources=Array.isArray(result.resources)?result.resources:[];
        const collectionLabel=reviewedCollectionLabelForResources(resources);
        const resourceLabel=resources.length===1?(collectionLabel==="tables"?"table":"table or view"):collectionLabel;
        return '<section class="ask-tool-trace"><strong>Reviewed data catalog</strong><p>'+esc(resources.length)+' reviewed '+esc(resourceLabel)+(resources.length===1?" is":" are")+' available to this Ask session.</p><details><summary>Reviewed catalog details</summary><pre>'+esc(JSON.stringify(result,null,2))+'</pre></details></section>';
      }
      const plan=call.arguments?.plan;
      if(call.tool==="app.explore_data"&&plan&&typeof plan==="object"){
        const boundaryName=typeof call.arguments?.boundary==="string"?call.arguments.boundary:undefined;
        const rows=askResultRows(result);
	        const semantics=result.outcome?.result;
	        const suppressed=Number(result.privacy?.suppressed_groups||result.data?.suppression?.suppressed_groups||semantics?.suppression?.suppressed_groups||0);
	        const minimumCohort=Number(result.privacy?.minimum_cohort_size||result.data?.suppression?.minimum_cohort_size||semantics?.suppression?.minimum_cohort_size||0);
	        const protectToken=result.protect?.query_ref;
	        const returned=Number(result.audit?.returned_rows_or_groups??rows.length);
	        const resultKind=plan.kind==="aggregate"?"group":"row";
	        const privacyGuidance=suppressed>0
	          ?suppressionReviewGuidance(plan,boundaryName,minimumCohort)
	          :null;
	        const reviewedValueNotice=reviewedValueControlHtml(result);
	        const budgetStatus=renderOperatorBudgetStatus(result);
	        const resolvedTimeStatus=renderOperatorTimeWindowStatus(result);
	        const executionCostStatus=renderOperatorExecutionCost(result);
	        const verifiedData=rows.length
          ?'<details class="verified-data-details"><summary>View verified data ('+esc(returned)+' '+resultKind+(returned===1?"":"s")+')</summary><div class="verified-data-body">'+resultDataHtml(plan,rows,semantics,boundaryName)+'</div></details>'
          :'<p class="ask-verified-count">No rows or groups passed the reviewed scope and privacy thresholds.</p>';
        return '<section class="ask-tool-trace"><p>'+esc(planSentence(plan,boundaryName))+'</p>'
          +(rows.length?'<p class="ask-verified-count">'+esc(returned)+' verified '+resultKind+(returned===1?"":"s")+' returned.</p>':"")
	          +verifiedData
		          +reviewedValueNotice
		          +resolvedTimeStatus
		          +executionCostStatus
		          +budgetStatus
		          +(privacyGuidance?'<p><strong>'+esc(suppressed)+' additional group'+(suppressed===1?" was":"s were")+' withheld because '+(suppressed===1?"it was":"they were")+' below the reviewed minimum group size'+(minimumCohort?' of '+esc(minimumCohort):'')+'.</strong></p>'+(privacyGuidance.shape?'<p>'+esc(privacyGuidance.shape)+'</p>':'')+'<p>'+esc(privacyGuidance.path)+'</p><button class="quiet" data-review-privacy-resource="'+esc(plan.resource)+'" type="button">Review privacy for '+esc(plan.resource)+'</button>':'')
          +(protectToken?'<button class="secondary" data-ask-protect="'+esc(protectToken)+'" type="button">Protect as reusable capability</button>':'')
	          +exploreEvidenceDisclosure(call,result,true)+'</section>';
      }
	      return '<section class="ask-tool-trace"><strong>Reviewed Runner tool completed</strong><details><summary>Advanced bounded result</summary><pre>'+esc(JSON.stringify({arguments:call.arguments,result},null,2))+'</pre></details></section>';
	    }

	    function renderOperatorTimeWindowStatus(result){
	      const items=Array.isArray(result?.operator_time_windows)
	        ?result.operator_time_windows.filter(item=>item&&item.source==="reviewed_relative_time")
	        :[];
	      if(!items.length)return "";
	      const rows=items.flatMap(item=>(item.ranges||[]).map(range=>{
	        const request=item.location==="comparison"
	          ?relativeWindowLabel(item.window)+" vs "+relativeWindowLabel(item.compare_to)
	          :relativeWindowLabel(item.window);
	        const field=String(item.field||"unknown")+(item.relationship?" via "+item.relationship:"");
	        return '<tr><td data-label="Reviewed request">'+esc(request)+'</td><td data-label="Field">'+esc(field)+'</td><td data-label="Range">'+esc(range.id||"range")+'</td><td data-label="UTC [start, end)"><code class="utc-range"><span>['+esc(range.start_inclusive||"?")+',</span><span>'+esc(range.end_exclusive||"?")+')</span></code></td></tr>';
	      })).join("");
	      return '<details class="ask-execution-evidence"><summary>Operator-only resolved UTC window</summary><p>Runner captured one instant, used the reviewed UTC authority, and compiled these half-open ranges. Resolved timestamps are withheld from the model.</p><div class="result-table resolved-time-table"><table><thead><tr><th>Reviewed request</th><th>Field</th><th>Range</th><th>UTC [start, end)</th></tr></thead><tbody>'+rows+'</tbody></table></div><p><strong>Resolved at:</strong> '+esc(items[0]?.resolved_at||"not available")+'</p></details>';
	    }

	    function renderOperatorBudgetStatus(result){
	      const budget=result?.operator_budget;
	      if(!budget||typeof budget!=="object")return "";
	      const scopes=[budget.trusted_scope,budget.tenant].filter(scope=>scope&&typeof scope==="object");
	      const warnings=scopes.flatMap(scope=>Array.isArray(scope.warnings)?scope.warnings:[]);
	      const rows=[];
	      const add=(scope,label,classification,gauge)=>{
	        if(!gauge||typeof gauge!=="object")return;
	        rows.push('<tr><td>'+esc(scope)+ '</td><td>'+esc(classification)+'</td><td>'+esc(label)+'</td><td>'+esc(gauge.used)+' / '+esc(gauge.limit)+'</td><td>'+esc(gauge.remaining)+'</td></tr>');
	      };
	      scopes.forEach(scope=>{
	        const label=scope.scope==="tenant"?"Tenant ceiling":"Trusted scope";
	        add(label,"Queries · rolling 24 hours","Volume",scope.volume?.queries_rolling_24_hours);
	        add(label,"Requests · rolling minute","Volume",scope.volume?.requests_rolling_minute);
	        add(label,"Extracted cells · rolling 24 hours","Disclosure",scope.disclosure?.extracted_cells_rolling_24_hours);
	        const differencing=scope.disclosure?.differencing_variants_rolling_24_hours;
	        const differencingResource=differencing?.root_resource||"current root resource";
	        add(label,"Differencing variants for "+differencingResource+" · rolling 24 hours","Disclosure",differencing);
	      });
	      const warning=warnings.length
	        ?'<div class="band notice"><strong>Reviewed budget is nearing its limit</strong>'+warnings.map(message=>'<p>'+esc(message)+'</p>').join("")+'<p>Review throughput in this boundary&apos;s Query volume settings. Disclosure controls remain separate.</p></div>'
	        :"";
	      return warning+'<details class="ask-execution-evidence"><summary>Operator-only budget status</summary><p>These counters are not sent to the model. Volume controls throughput; disclosure controls reconstruction risk.</p><div class="result-table"><table><thead><tr><th>Scope</th><th>Class</th><th>Budget</th><th>Used / limit</th><th>Remaining</th></tr></thead><tbody>'+rows.join("")+'</tbody></table></div><p><strong>Rolling 24-hour upper expiry:</strong> '+esc(budget.rolling_24_hour_usage_expires_no_later_than||"not available")+'<br><strong>Rolling-minute upper expiry:</strong> '+esc(budget.rolling_minute_usage_expires_no_later_than||"not available")+'</p></details>';
	    }

	    function renderOperatorExecutionCost(result){
	      const duration=result?.outcome?.result?.freshness?.execution_duration_ms;
	      if(!Number.isFinite(duration))return "";
	      return '<p class="muted"><strong>Source execution:</strong> '+esc(Math.max(0,Math.round(duration)))+' ms in one read-only transaction.</p>';
	    }

	    function reviewedValueControlHtml(result){
	      const controls=result?.privacy?.reviewed_value_controls;
	      if(!controls||typeof controls!=="object")return "";
	      const bucketed=Array.isArray(controls.bucketed_fields)?controls.bucketed_fields:[];
	      const excluded=Array.isArray(controls.excluded_fields)?controls.excluded_fields:[];
	      const messages=[];
	      bucketed.forEach(item=>{
	        const field=(item.resource||"reviewed table")+"."+(item.field||"categorical field");
	        messages.push(item.bucket_returned&&item.bucket_token
	          ?field+" includes one opaque "+item.bucket_token+" group for source values outside the reviewed value list. Their labels were not exposed."
	          :field+" contained source values outside the reviewed value list. Runner combined them before privacy and result limits; their labels were not exposed.");
	      });
	      excluded.forEach(item=>{
	        const field=(item.resource||"reviewed table")+"."+(item.field||"categorical field");
	        messages.push("This result is limited to reviewed values for "+field+". Rows with other values, if any, were excluded.");
	      });
	      return messages.length
	        ?'<div class="band notice"><strong>Reviewed value controls</strong>'+messages.map(message=>'<p>'+esc(message)+'</p>').join("")+'</div>'
	        :"";
	    }

	    function suppressionReviewGuidance(plan,boundaryName,minimumCohort){
	      const resource=describedResourceForPlan(plan,boundaryName);
	      const resolvedBoundary=boundaryName||resource?.boundary_name||"the active boundary";
	      const dimension=plan.kind==="aggregate"&&Array.isArray(plan.dimensions)&&plan.dimensions.length===1
	        ?plan.dimensions[0]
	        :null;
	      const field=dimension&&typeof dimension.field==="string"?dimension.field:null;
	      const shape=field&&/(^id$|_id$|(^|_)name$)/i.test(field)
	        ?"This question groups records into one row per "+fieldLabel(resource,field).toLowerCase()+"; any entity with fewer than "+(minimumCohort||"the reviewed minimum")+" records is withheld. Try a coarser reviewed grouping, or review this table's minimum group size."
	        :"";
	      return {
	        shape,
	        path:"To change this in Workbench, select Review privacy for "+plan.resource+" below. Workbench opens that table's Aggregate privacy setting inside boundary "+resolvedBoundary+". Choose a Minimum group size, enter a reason, select Save privacy change, then select Review and activate now. Until activation, Ask uses the previous group size."
	      };
	    }

    function safeAttemptedPlanSentence(plan){
      try{
        if(plan.kind!=="rows"&&plan.kind!=="aggregate")return "Unrecognized structured plan.";
        if(typeof plan.resource!=="string")return "Structured plan with no valid reviewed table.";
        if(plan.kind==="rows"&&!Array.isArray(plan.select))return "Row plan for "+plan.resource+".";
        if(plan.kind==="aggregate"&&!Array.isArray(plan.measures))return "Aggregate plan for "+plan.resource+".";
        return planSentence(plan);
      }catch{
        return "Structured plan for "+String(plan.resource||"an unavailable table")+".";
      }
    }

    function askResultRows(result){
      if(Array.isArray(result.data))return result.data;
      if(Array.isArray(result.data?.rows))return result.data.rows;
      if(Array.isArray(result.data?.groups))return result.data.groups;
      if(Array.isArray(result.rows))return result.rows;
      return [];
    }

    function askSuppressedGroupCount(result){
      const value=result&&typeof result==="object"?result:{};
      return Number(value.privacy?.suppressed_groups||value.data?.suppression?.suppressed_groups||value.outcome?.result?.suppression?.suppressed_groups||0);
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
        document.body.classList.remove("ask-result-mode");
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

    function describedResourceKey(resource){
      return JSON.stringify([resource?.boundary_name||"",resource?.id||""]);
    }

    function describedResourceFromKey(value){
      const resources=resourcesFromDescription();
      try{
        const parsed=JSON.parse(value);
        if(Array.isArray(parsed)&&parsed.length===2){
          return resources.find(resource=>(resource.boundary_name||"")===parsed[0]&&resource.id===parsed[1]);
        }
      }catch{}
      return resources.find(resource=>resource.id===value);
    }

    function describedResourceLabel(resource){
      const label=resourceLabel(resource);
      const boundaries=new Set(resourcesFromDescription().map(item=>item.boundary_name).filter(Boolean));
      const duplicate=resourcesFromDescription().filter(item=>item.id===resource?.id).length>1;
      return resource?.boundary_name&&(boundaries.size>1||duplicate)
        ?label+" - "+resource.boundary_name
        :label;
    }

    function describedResourceForPlan(plan,boundaryName){
      const resources=resourcesFromDescription();
      if(boundaryName){
        const exact=resources.find(resource=>resource.id===plan.resource&&resource.boundary_name===boundaryName);
        if(exact)return exact;
      }
      const selected=exploreMode==="rows"
        ?describedResourceFromKey(byId("row-resource")?.value||"")
        :describedResourceFromKey(byId("aggregate-resource")?.value||"");
      if(selected?.id===plan.resource)return selected;
      const matches=resources.filter(resource=>resource.id===plan.resource);
      return matches.length===1?matches[0]:matches[0];
    }

    function activeQuestionField(resource,key,value){
      const reference=normalizedSuggestedField(value);
      if(!reference)return false;
      if(!reference.relationship){
        const fields=key==="time_bucket_fields"
          ?Object.keys(resource?.time_bucket_fields||{})
          :resource?.[key]||[];
        return fields.includes(reference.field);
      }
      const relationship=(resource?.relationships||[]).find(item=>
        item.id===reference.relationship&&item.activation==="active");
      if(!relationship)return false;
      const fields=key==="time_bucket_fields"
        ?Object.keys(relationship.time_bucket_fields||{})
        :relationship[key]||[];
      return fields.includes(reference.field);
    }

    function activeQuestionIsExecutable(resource,question){
      if(!question||typeof question.text!=="string"||question.relationship_review_required)return false;
      const measure=question.measure;
      if(!measure||typeof measure!=="object")return false;
      if(typeof measure.derived_measure==="string"){
        if(!(resource.derived_measures||[]).some(item=>item.name===measure.derived_measure))return false;
      }else if(measure.function==="count"){
        if(measure.field||measure.relationship)return false;
      }else if(measure.function==="count_distinct"){
        if(!activeQuestionField(resource,"count_distinct_fields",measure))return false;
      }else if(["null_count","non_null_count","completion_rate"].includes(measure.function)){
        if(!activeQuestionField(resource,"presence_measure_fields",measure))return false;
      }else if(["sum","avg","stddev_samp","stddev_pop","var_samp","var_pop"].includes(measure.function)){
        if(!activeQuestionField(resource,"aggregate_measures",measure))return false;
        const target=measure.relationship
          ?(resource.relationships||[]).find(item=>item.id===measure.relationship&&item.activation==="active")
          :resource;
        const functions=target?.aggregate_measure_functions?.[measure.field]||["sum","avg"];
        if(!functions.includes(measure.function))return false;
      }else{
        return false;
      }
      const dimensions=(Array.isArray(question.dimensions)?question.dimensions:[question.dimension]).filter(Boolean);
      if(!dimensions.every(dimension=>typeof dimension.numeric_band==="string"
        ?(resource.numeric_bands||[]).some(item=>item.name===dimension.numeric_band)
        :dimension.numeric_band&&typeof dimension.numeric_band==="object"
          ?(resource.auto_bands||[]).some(policy=>policy.field===dimension.numeric_band.field
            &&policy.methods.includes(dimension.numeric_band.method)
            &&Number.isSafeInteger(dimension.numeric_band.buckets)
            &&dimension.numeric_band.buckets>=policy.min_buckets
            &&dimension.numeric_band.buckets<=policy.max_buckets)
          :activeQuestionField(resource,"groupable_fields",dimension)))return false;
      if(question.time_field){
        const time=normalizedSuggestedField(question.time_field);
        if(!activeQuestionField(resource,"time_bucket_fields",time))return false;
        const relationship=time.relationship
          ?(resource.relationships||[]).find(item=>item.id===time.relationship&&item.activation==="active")
          :resource;
        const buckets=relationship?.time_bucket_fields?.[time.field]||[];
        if(!buckets.includes(question.time_bucket||"week"))return false;
      }
      return true;
    }

    function renderExplorer(){
      const resources=resourcesFromDescription();
      if(!resources.length){
        byId("suggested-questions").innerHTML='<div class="band error">The activated pack contains no explorable resources.</div>';
        return;
      }
      const proposedSuggestions=resources.flatMap(resource=>{
        const dimension=resource.groupable_fields?.[0];
        const measure=resource.aggregate_measures?.[0];
        const timeField=Object.keys(resource.time_bucket_fields||{})[0];
        const rawMeasureLabel=measure?fieldLabel(resource,measure).toLowerCase().replace(/\s+cents$/,""):"";
        const measureQuestionLabel=rawMeasureLabel&&rawMeasureLabel.startsWith("total ")
          ?rawMeasureLabel
          :rawMeasureLabel
            ?"total "+rawMeasureLabel
            :"";
        const fallback={
          text:timeField&&dimension
            ?"How did "+(measure?measureQuestionLabel:resourceLabel(resource).toLowerCase())+" change by week across "+fieldLabel(resource,dimension).toLowerCase()+"?"
            :dimension
              ?"Which "+fieldLabel(resource,dimension).toLowerCase()+" groups contain the most "+resourceLabel(resource).toLowerCase()+"?"
              :"How many reviewed "+resourceLabel(resource).toLowerCase()+" records are available?",
          measure:measure?{function:"sum",field:measure}:{function:"count"},
          ...(dimension?{dimension}:{}),
          ...(timeField?{time_field:timeField,time_bucket:"week"}:{})
        };
        const active=(resource.suggested_questions||[]).filter(question=>
          activeQuestionIsExecutable(resource,question));
        const questions=active.length
          ?active
          :activeQuestionIsExecutable(resource,fallback)
            ?[fallback]
            :[];
        return questions.map(question=>({resource,question}));
      });
      const seenQuestions=new Set();
      const suggestions=proposedSuggestions.filter(item=>{
        const key=String(item.question.text||"").trim().toLowerCase().replace(/\s+/g," ");
        if(!key||seenQuestions.has(key))return false;
        seenQuestions.add(key);
        return true;
      }).slice(0,3);
      askStarterPrompts=suggestions.map(item=>item.question.text).filter(Boolean);
      byId("ask-question").placeholder=askStarterPrompts[0]||"Ask about the reviewed data available here.";
      renderAskStarters();
      renderAskBoundaryGuide();
      byId("suggested-questions").innerHTML='<div class="split-actions"><div><h3>Start with a reviewed question</h3><p>These suggestions use only the measures, groups, and dates already approved.</p></div></div>'
        +suggestions.map((suggestion,index)=>'<button class="question '+(index===0?"selected":"")+'" data-question="'+index+'" type="button">'+esc(suggestion.question.text)+'<br><span class="badge">'+esc(describedResourceLabel(suggestion.resource))+'</span></button>').join("");
      document.querySelectorAll("[data-question]").forEach(button=>button.onclick=()=>{
        document.querySelectorAll("[data-question]").forEach(item=>item.classList.remove("selected"));
        button.classList.add("selected");
        const suggestion=suggestions[Number(button.dataset.question)];
        populateAggregateBuilder(describedResourceKey(suggestion.resource),suggestion.question);
      });
      const firstSuggestion=suggestions[0];
      populateAggregateBuilder(describedResourceKey(firstSuggestion?.resource||resources[0]),firstSuggestion?.question);
      populateRowBuilder(describedResourceKey(resources[0]));
      renderFirstReviewedQuestion(firstSuggestion);
      renderClientConfigs();
      if(openNoModelAfterLoad){
        openNoModelAfterLoad=false;
        requestAnimationFrame(revealNoModelComposer);
      }
      if(openClientAfterLoad){
        openClientAfterLoad=false;
        requestAnimationFrame(revealExistingClientSetup);
      }
    }

    function renderFirstReviewedQuestion(suggestion){
      const panel=byId("first-reviewed-question");
      if(!suggestion){
        panel.innerHTML='<h3>No safe starter question was generated.</h3><p>Open the reviewed composer to choose from the activated boundary without guessing business meaning.</p><div class="actions"><button id="open-composer" type="button">Build a reviewed question</button></div>';
        byId("open-composer").onclick=()=>{byId("explore-composer").open=true;byId("explore-composer").scrollIntoView({behavior:"auto",block:"start"})};
        return;
      }
      const plan=currentPlan();
      const resource=describedResourceForPlan(plan);
      const operation=planOperationLines(plan,resource);
      panel.innerHTML='<h3>Try your first reviewed question</h3><p class="first-question"><strong>'+esc(suggestion.question.text)+'</strong></p><p>'+esc(planSentence(plan))+'</p><ul>'+operation.map(line=>'<li>'+esc(line)+'</li>').join("")+'</ul><p>This is a typed request assembled only from choices you reviewed. Runner generates parameterized read-only SQL internally; neither you nor the model receives SQL or can add another table, field, relationship, tenant, or user.</p><div class="actions"><button id="run-first-question" type="button">Run this reviewed question</button></div>';
      byId("run-first-question").onclick=runExplore;
    }

    function planOperationLines(plan,resource){
      if(plan.kind==="rows"){
        return [
          "Read one exact "+resourceLabel(resource).toLowerCase()+" record",
          "Return only "+plan.select.map(field=>fieldLabel(resource,field)).join(", "),
          plan.time_window?"Limit to "+relativeWindowLabel(plan.time_window.window)+" using "+fieldReferenceLabel(resource,plan.time_window):"No reviewed time window",
          "Maximum 1 record"
        ];
      }
      const measure=plan.measures[0];
      const derived=measure.derived_measure
        ?(resource.derived_measures||[]).find(item=>item.name===measure.derived_measure)
        :null;
      const measureText=derived
        ?"Calculate "+(derived.label||derived.name)
        :measure.function==="count"
        ?"Count "+resourceLabel(resource).toLowerCase()
        :(measure.function==="count_distinct"?"Count unique ":"Calculate "+measure.function+" of ")+fieldReferenceLabel(resource,measure).toLowerCase();
      const groups=(plan.dimensions||[]).map(dimension=>fieldReferenceLabel(resource,dimension)).join(", ");
      return [
        measureText,
        groups?"Group by "+groups:"No categorical grouping",
        plan.time_bucket?"Group time by "+plan.time_bucket.bucket+" using "+fieldReferenceLabel(resource,plan.time_bucket):"No time grouping",
        plan.time_window?"Limit to "+relativeWindowLabel(plan.time_window.window)+" using "+fieldReferenceLabel(resource,plan.time_window):"No reviewed time window",
        plan.comparison?.window?"Compare "+relativeWindowLabel(plan.comparison.window)+" with "+relativeWindowLabel(plan.comparison.compare_to):plan.comparison?"Compare two exact UTC ranges":"No period comparison",
        "Maximum "+plan.top_n+" groups",
        "Minimum group size "+resource.minimum_cohort_size+(resource.minimum_cohort_overridden?" (explicit owner override)":"")
      ];
    }

    function resourceLabel(resource){
      return resource?.label||String(resource?.id||"").split(".").pop().replace(/_/g," ");
    }

    function relationshipTargetLabel(relationship){
      return relationship?.target_label
        ||relationship?.label
        ||humanizeIdentifier(String(relationship?.target_resource||"").split(".").pop());
    }

    function fieldLabel(resource,field){
      return resource?.fields?.find(item=>item.id===field)?.label||String(field).replace(/_/g," ");
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
        time_bucket_fields:resource.time_bucket_fields||{},
        aggregate_measure_functions:resource.aggregate_measure_functions?.[field]||["sum","avg"]
      }));
      for(const relationship of resource?.relationships||[]){
        const related=key==="filterable_fields"||key==="time_bucket_fields"
          ?Object.keys(relationship[key]||{})
          :relationship[key]||[];
        related.forEach(field=>choices.push({
          field,
          relationship:relationship.id,
          label:fieldLabel(relationship,field)+" — "+relationshipTargetLabel(relationship)
            +(relationship.operator_review_required?" — human relationship review required":""),
          field_types:relationship.field_types||{},
          filter_operators:relationship.filter_operators||{},
          time_bucket_fields:relationship.time_bucket_fields||{},
          aggregate_measure_functions:relationship.aggregate_measure_functions?.[field]||["sum","avg"]
        }));
      }
      return choices;
    }

    function relativeTimeCatalog(){
      const catalog=exploreDescription?.relative_time_windows;
      return catalog?.available&&Array.isArray(catalog.windows)
        ?catalog
        :{available:false,reporting_timezone:null,windows:[],comparison_partners:[]};
    }

    function relativeTimeFieldChoices(resource,includeRelationships=true){
      return fieldChoices(resource,"time_bucket_fields").filter(choice=>{
        if(choice.relationship&&!includeRelationships)return false;
        if(!choice.relationship)return (resource?.relative_time_window_fields||[]).includes(choice.field);
        const relationship=(resource?.relationships||[]).find(item=>item.id===choice.relationship&&item.activation==="active");
        return (relationship?.relative_time_window_fields||[]).includes(choice.field);
      });
    }

    function relativeWindowLabel(value){
      const text=String(value||"").replace(/_/g," ");
      return text?text.charAt(0).toUpperCase()+text.slice(1):"Reviewed window";
    }

    function fieldChoiceValue(choice){
      return JSON.stringify({
        field:choice.field,
        ...(choice.relationship?{relationship:choice.relationship}:{})
      });
    }

    function dimensionChoices(resource){
      return [
        ...fieldChoices(resource,"groupable_fields"),
        ...(resource.numeric_bands||[]).map(band=>({
          numeric_band:band.name,
          label:(band.label||band.name)+" — reviewed fixed buckets"
        })),
        ...(resource.auto_bands||[]).flatMap(policy=>policy.methods.flatMap(method=>{
          const choices=[];
          for(let buckets=policy.min_buckets;buckets<=policy.max_buckets;buckets++)choices.push({
            numeric_band:{field:policy.field,method,buckets},
            label:fieldLabel(resource,policy.field)+" — automatic "+method.replace(/_/g," ")+", "+buckets+" buckets"
          });
          return choices;
        }))
      ];
    }

    function dimensionChoiceValue(choice){
      return choice.numeric_band
        ?JSON.stringify({numeric_band:choice.numeric_band})
        :fieldChoiceValue(choice);
    }

    function parseDimensionChoice(value){
      if(!value)return null;
      const parsed=JSON.parse(value);
      if(parsed&&typeof parsed.numeric_band==="string"&&Object.keys(parsed).length===1)return parsed;
      if(parsed&&parsed.numeric_band&&typeof parsed.numeric_band==="object"&&Object.keys(parsed).length===1){
        const band=parsed.numeric_band;
        if(typeof band.field==="string"&&["quantile","equal_width"].includes(band.method)&&Number.isSafeInteger(band.buckets)&&Object.keys(band).every(key=>["field","method","buckets"].includes(key)))return parsed;
      }
      if(parsed&&typeof parsed.field==="string")return parsed;
      throw new Error("The selected reviewed grouping is invalid.");
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
      if(reference.numeric_band){
        if(typeof reference.numeric_band==="string"){
          const band=(resource.numeric_bands||[]).find(item=>item.name===reference.numeric_band);
          return band?.label||reference.numeric_band;
        }
        return fieldLabel(resource,reference.numeric_band.field)+" (automatic "+reference.numeric_band.method.replace(/_/g," ")+", "+reference.numeric_band.buckets+" buckets)";
      }
      if(!reference.relationship)return fieldLabel(resource,reference.field);
      const relationship=(resource.relationships||[]).find(item=>item.id===reference.relationship);
      return fieldLabel(relationship,reference.field)+" from "+relationshipTargetLabel(relationship);
    }

    function optionList(values,selected,labelForValue=value=>value){
      return values.map(value=>'<option value="'+esc(value)+'" '+(value===selected?"selected":"")+'>'+esc(labelForValue(value))+'</option>').join("");
    }

    function measureOptions(resource){
      const numericLabels={
        sum:"Total ",
        avg:"Average ",
        stddev_samp:"Sample standard deviation of ",
        stddev_pop:"Population standard deviation of ",
        var_samp:"Sample variance of ",
        var_pop:"Population variance of "
      };
      const presenceLabels={
        null_count:"Missing values in ",
        non_null_count:"Present values in ",
        completion_rate:"Completion rate for "
      };
      return [
        {value:JSON.stringify({function:"count"}),label:"Number of "+resourceLabel(resource).toLowerCase()},
        ...(resource.derived_measures||[]).map(measure=>({
          value:JSON.stringify({derived_measure:measure.name}),
          label:measure.label+" (reviewed definition)"
        })),
        ...fieldChoices(resource,"aggregate_measures").flatMap(choice=>(choice.aggregate_measure_functions||["sum","avg"]).map(fn=>({
          value:JSON.stringify({function:fn,field:choice.field,...(choice.relationship?{relationship:choice.relationship}:{})}),
          label:(numericLabels[fn]||fn+" of ")+choice.label.toLowerCase()
        }))),
        ...fieldChoices(resource,"presence_measure_fields").flatMap(choice=>(resource.presence_measure_functions||[]).map(fn=>({
          value:JSON.stringify({function:fn,field:choice.field,...(choice.relationship?{relationship:choice.relationship}:{})}),
          label:(presenceLabels[fn]||fn+" of ")+choice.label.toLowerCase()
        }))),
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

    function populateAggregateBuilder(resourceKey,suggestion){
      const resources=resourcesFromDescription();
      const resource=describedResourceFromKey(resourceKey)||resources[0];
      const dimensions=dimensionChoices(resource);
      const timeFields=fieldChoices(resource,"time_bucket_fields");
      const relativeTimeFields=relativeTimeFieldChoices(resource);
      const relativeCatalog=relativeTimeCatalog();
      const relativeWindows=relativeCatalog.windows||[];
      const relativeComparisons=relativeCatalog.comparison_partners||[];
      const filters=fieldChoices(resource,"filterable_fields");
      const measures=measureOptions(resource);
      const suggestedMeasure=suggestion?.measure
        ?JSON.stringify(suggestion.measure)
        :measures[0]?.value;
      const suggestedDimensions=(Array.isArray(suggestion?.dimensions)?suggestion.dimensions:[suggestion?.dimension])
        .map(normalizedSuggestedField)
        .filter(Boolean);
      const suggestedDimensionValues=[
        suggestedDimensions[0]?dimensionChoiceValue(suggestedDimensions[0]):"",
        suggestedDimensions[1]?dimensionChoiceValue(suggestedDimensions[1]):"",
        suggestedDimensions[2]?dimensionChoiceValue(suggestedDimensions[2]):""
      ];
      const suggestedTime=normalizedSuggestedField(suggestion?.time_field);
      const suggestedTimeValue=suggestedTime?fieldChoiceValue(suggestedTime):"";
      const suggestedBucket=suggestion?.time_bucket||"week";
      const ranges=defaultComparisonRanges();
      const maximumGroups=Math.min(10,Math.max(1,resource.maximum_groups||10));
      if(!byId("aggregate-resource")){
        byId("aggregate-builder").innerHTML='<label class="field">Table or view<select id="aggregate-resource"></select></label><div id="aggregate-controls" class="form-grid-contents"></div>';
        byId("aggregate-resource").onchange=event=>populateAggregateBuilder(event.currentTarget.value);
      }
      const resourceSelect=byId("aggregate-resource");
      const resourceKeys=resources.map(describedResourceKey);
      const selectedResourceKey=describedResourceKey(resource);
      if(JSON.stringify([...resourceSelect.options].map(option=>option.value))!==JSON.stringify(resourceKeys)){
        resourceSelect.innerHTML=optionList(resourceKeys,selectedResourceKey,value=>describedResourceLabel(describedResourceFromKey(value)));
      }
      resourceSelect.value=selectedResourceKey;
      byId("aggregate-controls").innerHTML=
        '<label class="field">What should Runner calculate?<select id="aggregate-measure">'+measures.map(item=>'<option value="'+esc(item.value)+'" '+(item.value===suggestedMeasure?"selected":"")+'>'+esc(item.label)+'</option>').join("")+'</select></label>'+
        '<label class="field">Compare groups by<select id="aggregate-dimension"><option value="">No grouping</option>'+optionList(dimensions.map(dimensionChoiceValue),suggestedDimensionValues[0],value=>dimensions.find(choice=>dimensionChoiceValue(choice)===value)?.label||value)+'</select></label>'+
        '<label id="aggregate-dimension-2-wrap" class="field '+(suggestedDimensions[1]?"":"hidden")+'">And optionally by<select id="aggregate-dimension-2"><option value="">No second group</option>'+optionList(dimensions.map(dimensionChoiceValue),suggestedDimensionValues[1],value=>dimensions.find(choice=>dimensionChoiceValue(choice)===value)?.label||value)+'</select></label>'+
        '<label id="aggregate-dimension-3-wrap" class="field '+(suggestedDimensions[2]?"":"hidden")+'">And optionally by<select id="aggregate-dimension-3"><option value="">No third group</option>'+optionList(dimensions.map(dimensionChoiceValue),suggestedDimensionValues[2],value=>dimensions.find(choice=>dimensionChoiceValue(choice)===value)?.label||value)+'</select></label>'+
        '<div id="aggregate-add-group-wrap" class="actions"><button id="aggregate-add-group" class="quiet" type="button">Add another grouping</button></div>'+
        '<label class="field">Show change over time using<select id="aggregate-time"><option value="">No time grouping</option>'+optionList(timeFields.map(fieldChoiceValue),suggestedTimeValue,value=>timeFields.find(choice=>fieldChoiceValue(choice)===value)?.label||value)+'</select></label>'+
        '<label id="aggregate-bucket-wrap" class="field '+(suggestedTime?"":"hidden")+'">Time interval<select id="aggregate-bucket"><option value="week" '+(suggestedBucket==="week"?"selected":"")+'>Week</option><option value="day" '+(suggestedBucket==="day"?"selected":"")+'>Day</option><option value="month" '+(suggestedBucket==="month"?"selected":"")+'>Month</option></select></label>'+
        '<label class="field">Limit records to<select id="aggregate-window-field"><option value="">All reviewed dates</option>'+optionList(relativeTimeFields.map(fieldChoiceValue),undefined,value=>relativeTimeFields.find(choice=>fieldChoiceValue(choice)===value)?.label||value)+'</select></label>'+
        '<label id="aggregate-window-wrap" class="field hidden">Reviewed UTC window<select id="aggregate-window-name">'+relativeWindows.map(window=>'<option value="'+esc(window)+'">'+esc(relativeWindowLabel(window))+'</option>').join("")+'</select></label>'+
        '<label class="field">Order result<select id="aggregate-order"><option value="measure:desc">Largest measure first</option><option value="measure:asc">Smallest measure first</option><option value="comparison_change:percentage:desc" data-comparison-order disabled>Fastest percentage growth</option><option value="comparison_change:absolute:desc" data-comparison-order disabled>Largest absolute increase</option><option value="comparison_change:percentage:asc" data-comparison-order disabled>Fastest percentage decline</option><option value="comparison_change:absolute:asc" data-comparison-order disabled>Largest absolute decrease</option><option value="time_bucket:asc">Oldest bucket first</option><option value="time_bucket:desc">Newest bucket first</option></select></label>'+
        '<label class="field">Maximum groups<input id="aggregate-top" type="number" min="1" max="'+esc(resource.maximum_groups||25)+'" value="'+esc(maximumGroups)+'"></label>'+
        '<label class="field">Optional filter<select id="aggregate-filter"><option value="">No filter</option>'+optionList(filters.map(fieldChoiceValue),undefined,value=>filters.find(choice=>fieldChoiceValue(choice)===value)?.label||value)+'</select></label>'+
        '<label id="aggregate-filter-op-wrap" class="field hidden">Filter operator<select id="aggregate-filter-op"><option value="eq">Equals</option></select></label>'+
        '<label id="aggregate-filter-value-wrap" class="field hidden">Filter value<input id="aggregate-filter-value" type="text" maxlength="256" placeholder="Enter a value"></label>'+
        '<label id="aggregate-compare-wrap" class="check '+(suggestedTime?"":"hidden")+'"><input id="aggregate-compare" type="checkbox" '+(timeFields.length?"":"disabled")+'><span>Compare two date ranges</span></label>'+
        '<label class="field comparison hidden">Date range source<select id="aggregate-comparison-mode"><option value="relative" '+(relativeWindows.length?"":"disabled")+'>Reviewed relative UTC window</option><option value="absolute" '+(relativeWindows.length?"":"selected")+'>Exact UTC date ranges</option></select></label>'+
        '<label class="field comparison comparison-relative hidden">Reviewed window<select id="aggregate-comparison-window">'+relativeWindows.map(window=>'<option value="'+esc(window)+'">'+esc(relativeWindowLabel(window))+'</option>').join("")+'</select></label>'+
        '<label class="field comparison comparison-relative hidden">Compare with<select id="aggregate-comparison-partner">'+relativeComparisons.map(partner=>'<option value="'+esc(partner)+'">'+esc(relativeWindowLabel(partner))+'</option>').join("")+'</select></label>'+
        '<label class="field comparison comparison-absolute hidden">Earlier period start<input id="period-1-start" type="datetime-local" value="'+ranges[0]+'"></label>'+
        '<label class="field comparison comparison-absolute hidden">Earlier period end<input id="period-1-end" type="datetime-local" value="'+ranges[1]+'"></label>'+
        '<label class="field comparison comparison-absolute hidden">Later period start<input id="period-2-start" type="datetime-local" value="'+ranges[2]+'"></label>'+
        '<label class="field comparison comparison-absolute hidden">Later period end<input id="period-2-end" type="datetime-local" value="'+ranges[3]+'"></label>'+
        '<div id="explore-guardrails" class="band notice"><strong>This form cannot widen data access.</strong><p>Your application supplies the customer and user outside this form. Hidden fields never appear as choices. Results stop at '+esc(resource.maximum_groups||"the reviewed number of")+' groups, and groups smaller than '+esc(resource.minimum_cohort_size)+' are suppressed.'+(resource.minimum_cohort_overridden?' <strong>This threshold is an explicit owner override.</strong>':'')+'</p>'+(resource.minimum_cohort_size===1?'<p><strong>Small-group suppression is disabled; groups of one can identify individuals.</strong></p>':'')+'</div>';
      byId("aggregate-add-group").onclick=()=>{
        const second=byId("aggregate-dimension-2-wrap");
        const third=byId("aggregate-dimension-3-wrap");
        if(second.classList.contains("hidden"))second.classList.remove("hidden");
        else third.classList.remove("hidden");
        if(!second.classList.contains("hidden")&&!third.classList.contains("hidden"))byId("aggregate-add-group-wrap").classList.add("hidden");
      };
      if(suggestedDimensions.length>=2)byId("aggregate-dimension-2-wrap").classList.remove("hidden");
      if(suggestedDimensions.length>=3){
        byId("aggregate-dimension-3-wrap").classList.remove("hidden");
        byId("aggregate-add-group-wrap").classList.add("hidden");
      }
      byId("aggregate-compare").onchange=()=>{
        refreshComparisonControls();
      };
      byId("aggregate-comparison-mode").onchange=refreshComparisonControls;
      byId("aggregate-filter").onchange=refreshFilterOperators;
      byId("aggregate-time").onchange=refreshTimeBucketOptions;
      byId("aggregate-window-field").onchange=refreshRelativeTimeWindowControls;
      document.querySelectorAll("#aggregate-controls input,#aggregate-controls select").forEach(input=>input.addEventListener("change",updatePlanPreview));
      refreshFilterOperators();
      refreshTimeBucketOptions();
      refreshRelativeTimeWindowControls();
      refreshComparisonControls();
      updatePlanPreview();
    }

    function refreshFilterOperators(){
      const resource=describedResourceFromKey(byId("aggregate-resource").value);
      const choice=parseFieldChoice(byId("aggregate-filter").value);
      const catalog=choice?fieldChoices(resource,"filterable_fields").find(item=>fieldChoiceValue(item)===fieldChoiceValue(choice)):null;
      const operators=catalog?.filter_operators?.[choice?.field]||["eq"];
      byId("aggregate-filter-op").innerHTML=operators.map(operator=>'<option value="'+esc(operator)+'">'+esc(operator==="eq"?"Equals":operator==="neq"?"Does not equal":operator.toUpperCase())+'</option>').join("");
      byId("aggregate-filter-value").disabled=!choice;
      byId("aggregate-filter-op-wrap").classList.toggle("hidden",!choice);
      byId("aggregate-filter-value-wrap").classList.toggle("hidden",!choice);
    }

    function refreshTimeBucketOptions(){
      const resource=describedResourceFromKey(byId("aggregate-resource").value);
      const choice=parseFieldChoice(byId("aggregate-time").value);
      const catalog=choice?fieldChoices(resource,"time_bucket_fields").find(item=>fieldChoiceValue(item)===fieldChoiceValue(choice)):null;
      const buckets=catalog?.time_bucket_fields?.[choice?.field]||["week"];
      const current=byId("aggregate-bucket").value;
      byId("aggregate-bucket").innerHTML=buckets.map(bucket=>'<option value="'+esc(bucket)+'" '+(bucket===current?"selected":"")+'>'+esc(bucket[0].toUpperCase()+bucket.slice(1))+'</option>').join("");
      byId("aggregate-bucket-wrap").classList.toggle("hidden",!choice);
      byId("aggregate-compare-wrap").classList.toggle("hidden",!choice);
      if(!choice){
        byId("aggregate-compare").checked=false;
      }
      const timeOrderOptions=byId("aggregate-order").querySelectorAll('option[value^="time_bucket:"]');
      timeOrderOptions.forEach(option=>option.disabled=!choice||byId("aggregate-compare").checked);
      refreshComparisonOrderOptions();
      refreshComparisonControls();
    }

    function refreshRelativeTimeWindowControls(){
      const selected=Boolean(byId("aggregate-window-field")?.value);
      byId("aggregate-window-wrap")?.classList.toggle("hidden",!selected);
    }

    function refreshComparisonControls(){
      const comparing=Boolean(byId("aggregate-compare")?.checked);
      const relative=byId("aggregate-comparison-mode")?.value==="relative";
      document.querySelectorAll(".comparison").forEach(node=>node.classList.toggle("hidden",!comparing));
      document.querySelectorAll(".comparison-relative").forEach(node=>node.classList.toggle("hidden",!comparing||!relative));
      document.querySelectorAll(".comparison-absolute").forEach(node=>node.classList.toggle("hidden",!comparing||relative));
      if(byId("aggregate-window-field"))byId("aggregate-window-field").disabled=comparing;
      if(byId("aggregate-window-name"))byId("aggregate-window-name").disabled=comparing;
      refreshComparisonOrderOptions();
    }

    function refreshComparisonOrderOptions(){
      const order=byId("aggregate-order");
      const compare=byId("aggregate-compare");
      if(!order||!compare)return;
      const comparing=compare.checked;
      order.querySelectorAll("[data-comparison-order]").forEach(option=>option.disabled=!comparing);
      order.querySelectorAll('option[value^="time_bucket:"]').forEach(option=>option.disabled=comparing||!byId("aggregate-time")?.value);
      if(comparing&&order.value.startsWith("time_bucket:"))order.value="measure:desc";
      if(!comparing&&order.value.startsWith("comparison_change:"))order.value="measure:desc";
    }

    function populateRowBuilder(resourceKey){
      const resources=resourcesFromDescription();
      const resource=describedResourceFromKey(resourceKey)||resources[0];
      const relativeTimeFields=relativeTimeFieldChoices(resource,false);
      const relativeWindows=relativeTimeCatalog().windows||[];
      const fields=(resource.selectable_fields||[]).slice().sort((left,right)=>{
        const priority=field=>field===resource.primary_key?0:/(^|_)id$/i.test(field)?2:1;
        return priority(left)-priority(right);
      });
      byId("row-builder").innerHTML=
        '<label class="field">Table or view<select id="row-resource">'+optionList(resources.map(describedResourceKey),describedResourceKey(resource),value=>describedResourceLabel(describedResourceFromKey(value)))+'</select></label>'+
        '<label class="field">Exact '+esc(fieldLabel(resource,resource.primary_key||"record ID"))+'<input id="row-id" type="text" maxlength="256" placeholder="Enter a real record ID"></label>'+
        '<label class="field">Values to return<select id="row-fields" multiple size="'+Math.min(6,Math.max(3,fields.length))+'">'+fields.map((field,index)=>'<option value="'+esc(field)+'" '+(index<Math.min(5,fields.length)?"selected":"")+'>'+esc(fieldLabel(resource,field))+'</option>').join("")+'</select></label>'+
        '<label class="field">Limit record to<select id="row-window-field"><option value="">Any reviewed date</option>'+optionList(relativeTimeFields.map(fieldChoiceValue),undefined,value=>relativeTimeFields.find(choice=>fieldChoiceValue(choice)===value)?.label||value)+'</select></label>'+
        '<label id="row-window-wrap" class="field hidden">Reviewed UTC window<select id="row-window-name">'+relativeWindows.map(window=>'<option value="'+esc(window)+'">'+esc(relativeWindowLabel(window))+'</option>').join("")+'</select></label>'+
        '<div class="band notice"><strong>The AI cannot choose another customer or user.</strong><p>Your application supplies those trusted values outside this form.</p></div>';
      byId("row-resource").onchange=()=>populateRowBuilder(byId("row-resource").value);
      byId("row-window-field").onchange=()=>byId("row-window-wrap").classList.toggle("hidden",!byId("row-window-field").value);
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
        const resource=describedResourceFromKey(byId("row-resource").value);
        const id=byId("row-id").value.trim();
        const select=[...byId("row-fields").selectedOptions].map(option=>option.value);
        const timeWindowField=parseFieldChoice(byId("row-window-field").value);
        return {
          kind:"rows",
          resource:resource.id,
          select,
          where:id?[{field:resource.primary_key,op:"eq",value:id}]:[],
          ...(timeWindowField?{time_window:{...timeWindowField,window:byId("row-window-name").value}}:{}),
          limit:1
        };
      }
      const resource=describedResourceFromKey(byId("aggregate-resource").value);
      const resourceId=resource.id;
      const measure=JSON.parse(byId("aggregate-measure").value);
      const dimensions=["aggregate-dimension","aggregate-dimension-2","aggregate-dimension-3"]
        .map(id=>parseDimensionChoice(byId(id).value))
        .filter(Boolean);
      const dimensionKeys=dimensions.map(dimensionChoiceValue);
      if(new Set(dimensionKeys).size!==dimensionKeys.length){
        throw new Error("Choose each reviewed grouping field only once.");
      }
      const autoBandDimensions=dimensions.filter(dimension=>dimension.numeric_band&&typeof dimension.numeric_band==="object");
      if(autoBandDimensions.length>1)throw new Error("Choose at most one automatic numeric band per question.");
      const timeField=parseFieldChoice(byId("aggregate-time").value);
      const timeWindowField=parseFieldChoice(byId("aggregate-window-field").value);
      if(measure.derived_measure){
        const definition=(resource.derived_measures||[]).find(item=>item.name===measure.derived_measure);
        if(definition?.base_measure){
          const sequential=["running_total","lag_absolute_change","lag_percentage_change","moving_average"].includes(definition.shape);
          if(sequential&&!timeField)throw new Error(definition.label+" requires a reviewed time grouping.");
          if(sequential&&byId("aggregate-bucket").value==="day_of_week")throw new Error(definition.label+" requires an ordered calendar interval, not day of week.");
          if(!sequential&&timeField)throw new Error(definition.label+" uses released groups and cannot be combined with a time grouping.");
          if(!sequential&&!dimensions.length)throw new Error(definition.label+" requires at least one reviewed grouping field.");
          if(byId("aggregate-compare").checked)throw new Error(definition.label+" cannot be combined with a two-period comparison.");
        }
      }
      const filterField=parseFieldChoice(byId("aggregate-filter").value);
      const filterOperator=byId("aggregate-filter-op").value;
      const filterText=byId("aggregate-filter-value").value.trim();
      const [orderKind,orderValue,orderTail]=byId("aggregate-order").value.split(":");
      const orderDirection=orderTail||orderValue;
      const plan={
        kind:"aggregate",
        resource:resourceId,
        measures:[measure],
        ...(dimensions.length?{dimensions}:{}),
        ...(timeField?{time_bucket:{...timeField,bucket:byId("aggregate-bucket").value}}:{}),
        ...(!byId("aggregate-compare").checked&&timeWindowField?{time_window:{...timeWindowField,window:byId("aggregate-window-name").value}}:{}),
        ...(filterField&&filterText?{where:[{...filterField,op:filterOperator,value:typedFilterValue(resource,filterField,filterOperator,filterText)}]}:{}),
        order_by:orderKind==="time_bucket"
          ?{kind:"time_bucket",direction:orderDirection}
          :orderKind==="comparison_change"
            ?{kind:"comparison_change",index:0,change:orderValue,direction:orderDirection}
            :{kind:"measure",index:0,direction:orderDirection},
        top_n:Number(byId("aggregate-top").value)
      };
      if(autoBandDimensions.length&&byId("aggregate-compare").checked)throw new Error("Automatic numeric bands cannot be combined with a two-period comparison.");
      if(byId("aggregate-compare").checked){
        if(byId("aggregate-comparison-mode").value==="relative"){
          if(!byId("aggregate-comparison-window").value||!byId("aggregate-comparison-partner").value)throw new Error("Choose a reviewed relative window and comparison period.");
          if(timeField)plan.comparison={...timeField,window:byId("aggregate-comparison-window").value,compare_to:byId("aggregate-comparison-partner").value};
        }else{
          const ranges=[
            {start:isoValue("period-1-start"),end:isoValue("period-1-end")},
            {start:isoValue("period-2-start"),end:isoValue("period-2-end")}
          ];
          if(ranges.every(range=>range.start&&range.end)&&timeField)plan.comparison={...timeField,ranges};
        }
      }
      return plan;
    }

    function planSentence(plan,boundaryName){
      const resource=describedResourceForPlan(plan,boundaryName);
      if(plan.kind==="rows")return "Read one exact "+resourceLabel(resource).toLowerCase()+" record and return only "+plan.select.map(field=>fieldLabel(resource,field)).join(", ")+(plan.time_window?", limited to "+relativeWindowLabel(plan.time_window.window)+" using "+fieldReferenceLabel(resource,plan.time_window):"")+".";
      const measures=plan.measures.map(measure=>{
        if(measure.derived_measure){
          const derived=(resource.derived_measures||[]).find(item=>item.name===measure.derived_measure);
          return (derived?.label||measure.derived_measure).toLowerCase();
        }
        if(measure.function==="count")return "the number of records";
        if(measure.function==="count_distinct")return "the number of unique "+fieldReferenceLabel(resource,measure).toLowerCase();
        const field=fieldReferenceLabel(resource,measure).toLowerCase();
        const labels={sum:"total ",avg:"average ",stddev_samp:"sample standard deviation of ",stddev_pop:"population standard deviation of ",var_samp:"sample variance of ",var_pop:"population variance of ",null_count:"missing values in ",non_null_count:"present values in ",completion_rate:"completion rate for "};
        return measure.function==="sum"&&field.startsWith("total ")?field:(labels[measure.function]||measure.function+" of ")+field;
      }).join(", ");
      const groups=(plan.dimensions||[]).map(item=>fieldReferenceLabel(resource,item)).join(", ");
      const filters=(plan.where||[]).map(item=>fieldReferenceLabel(resource,item)+" "+(item.op==="eq"?"equals":item.op)+" "+JSON.stringify(item.value)).join(", ");
      const timeWindow=plan.time_window?" limited to "+relativeWindowLabel(plan.time_window.window)+" using "+fieldReferenceLabel(resource,plan.time_window):"";
      const comparison=plan.comparison?.window?" comparing "+relativeWindowLabel(plan.comparison.window)+" with "+relativeWindowLabel(plan.comparison.compare_to):plan.comparison?" comparing two exact UTC ranges":"";
      const groupLimit=Number.isInteger(plan.top_n)?" with at most "+plan.top_n+" groups":"";
      return "Calculate "+measures+" for "+resourceLabel(resource).toLowerCase()+(groups?" grouped by "+groups:"")+(plan.time_bucket?" for each "+plan.time_bucket.bucket:"")+timeWindow+comparison+(filters?" where "+filters:"")+groupLimit+".";
    }

    function resultColumnLabel(plan,key,semantics,boundaryName){
      const resource=describedResourceForPlan(plan,boundaryName);
      const measureLabel=measure=>{
        if(measure.function==="reviewed_derived"||measure.derived_measure){
          const name=measure.derived_measure||measure.alias;
          return (resource.derived_measures||[]).find(item=>item.name===name)?.label||name||"Reviewed derived measure";
        }
        if(measure.function==="count")return "Record count";
        const field=fieldReferenceLabel(resource,measure);
        if(measure.function==="count_distinct")return "Unique "+field;
        if(measure.function==="avg")return "Average "+field;
        const labels={sum:"Total ",avg:"Average ",stddev_samp:"Sample standard deviation of ",stddev_pop:"Population standard deviation of ",var_samp:"Sample variance of ",var_pop:"Population variance of ",null_count:"Missing values in ",non_null_count:"Present values in ",completion_rate:"Completion rate for "};
        return measure.function==="sum"&&field.toLowerCase().startsWith("total ")?field:(labels[measure.function]||measure.function+" of ")+field;
      };
      if(plan.kind==="rows")return fieldLabel(resource,key);
      const reviewedDimension=(semantics?.dimensions||[]).find(item=>item.alias===key);
      if(reviewedDimension)return fieldReferenceLabel(resource,reviewedDimension);
      const reviewedMeasure=(semantics?.measures||[]).find(item=>item.alias===key);
      if(reviewedMeasure)return measureLabel(reviewedMeasure);
      for(const measure of semantics?.measures||[]){
        const outputs=measure.comparison_outputs||{};
        const label=measureLabel(measure);
        if(outputs.period_1===key)return label+" · period 1";
        if(outputs.period_2===key)return label+" · period 2";
        if(outputs.absolute_change===key)return label+" · absolute change";
        if(outputs.percentage_change===key)return label+" · percentage change";
      }
      if(semantics?.grain?.time_bucket?.output_alias===key){
        const bucket=semantics.grain.time_bucket;
        const label=String(bucket.bucket||plan.time_bucket?.bucket||"Time");
        return label.charAt(0).toUpperCase()+label.slice(1)+" starting";
      }
      const dimension=/^dimension_(\\d+)$/.exec(key);
      if(dimension){
        const value=plan.dimensions?.[Number(dimension[1])];
        return value?fieldReferenceLabel(resource,value):"Reviewed group";
      }
      const measure=/^measure_(\\d+)$/.exec(key);
      if(measure){
        const value=plan.measures?.[Number(measure[1])];
        if(!value)return "Reviewed measure";
        if(value.derived_measure)return (resource.derived_measures||[]).find(item=>item.name===value.derived_measure)?.label||value.derived_measure;
        if(value.function==="count")return "Record count";
        if(value.function==="count_distinct")return "Unique "+fieldReferenceLabel(resource,value);
        const labels={sum:"Total ",avg:"Average ",stddev_samp:"Sample standard deviation of ",stddev_pop:"Population standard deviation of ",var_samp:"Sample variance of ",var_pop:"Population variance of ",null_count:"Missing values in ",non_null_count:"Present values in ",completion_rate:"Completion rate for "};
        return (labels[value.function]||value.function+" of ")+fieldReferenceLabel(resource,value);
      }
      if(key==="time_bucket")return (plan.time_bucket?.bucket||"Time")+" · "+fieldReferenceLabel(resource,plan.time_bucket);
      if(key==="period_index")return "Comparison period";
      if(key==="cohort_count")return "Cohort size";
      if(key==="suppressed")return "Privacy status";
      return String(key).replace(/_/g," ");
    }

    function resultDataHtml(plan,data,semantics,boundaryName){
      if(!Array.isArray(data)||!data.length)return '<p>No rows or groups passed the reviewed scope and privacy thresholds.</p>';
      const columns=[...new Set(data.flatMap(row=>Object.keys(row)))];
      const cell=(column,value)=>{
        if(value===null||value===undefined)return "—";
        const timeBucket=semantics?.grain?.time_bucket;
        if(timeBucket?.output_alias===column&&typeof value==="string"){
          const timestamp=Date.parse(value);
          if(Number.isFinite(timestamp))return new Date(timestamp).toISOString().slice(0,10);
        }
        if(typeof value==="number"&&Number.isFinite(value))return new Intl.NumberFormat("en-US",{maximumFractionDigits:6,useGrouping:true}).format(value);
        return typeof value==="object"?JSON.stringify(value):String(value);
      };
      return '<div class="result-table"><table><thead><tr>'+columns.map(column=>'<th>'+esc(resultColumnLabel(plan,column,semantics,boundaryName))+'</th>').join("")+'</tr></thead><tbody>'
        +data.map(row=>'<tr>'+columns.map(column=>'<td>'+esc(cell(column,row[column]))+'</td>').join("")+'</tr>').join("")
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
      let attemptedPlan=null;
      let attemptedBoundary=null;
      try{
        const plan=attemptedPlan=currentPlan();
        const selectedDescriptionResource=describedResourceForPlan(plan);
        const selectedBoundary=attemptedBoundary=selectedDescriptionResource?.boundary_name;
        if(plan.kind==="rows"&&!plan.where.length)throw new Error("Enter the real row identifier. Runner will not select an arbitrary first row.");
        status.className="status-message";
        status.textContent="Running the bounded read through the reviewed authoring boundary...";
        resultPanel.innerHTML="";
	        const payload=await post("/api/explore/run",{...(selectedBoundary?{boundary:selectedBoundary}:{}),plan});
	        lastExplorePlan=plan;
	        const result=payload.result;
	        const resultProtectQueryRef=result.protect?.query_ref||null;
	        preferredProtectQueryRef=resultProtectQueryRef;
	        const reviewedResource=selectedDescriptionResource;
		        const visible=plan.kind==="rows"
		          ?plan.select.map(field=>fieldLabel(selectedDescriptionResource,field))
		          :plan.measures.map(measure=>measure.function+(measure.field?"("+fieldReferenceLabel(selectedDescriptionResource,measure)+")":""))
		            .concat((plan.dimensions||[]).map(dimension=>fieldReferenceLabel(selectedDescriptionResource,dimension)),plan.time_bucket?[fieldReferenceLabel(selectedDescriptionResource,plan.time_bucket)]:[]);
		        const unavailable=(reviewedResource?.kept_out_fields||[]).join(", ")||"all fields outside this reviewed result";
		        status.textContent="Reviewed result returned.";
		        const privacyGuidance=result.privacy.suppressed_groups>0
		          ?suppressionReviewGuidance(plan,selectedBoundary,result.privacy.minimum_cohort_size)
		          :null;
          resultPanel.innerHTML='<section class="band success"><h3>Your reviewed question worked.</h3><p>'+esc(planSentence(plan,selectedBoundary))+'</p>'+resultDataHtml(plan,result.data,result.outcome?.result,selectedBoundary)+reviewedValueControlHtml(result)+renderOperatorTimeWindowStatus(result)+renderOperatorExecutionCost(result)+renderOperatorBudgetStatus(result)+(privacyGuidance?'<p><strong>'+esc(result.privacy.suppressed_groups)+' additional group'+(result.privacy.suppressed_groups===1?" was":"s were")+' withheld because '+(result.privacy.suppressed_groups===1?"it was":"they were")+' below the reviewed minimum group size of '+esc(result.privacy.minimum_cohort_size)+'.</strong></p>'+(privacyGuidance.shape?'<p>'+esc(privacyGuidance.shape)+'</p>':'')+'<p>'+esc(privacyGuidance.path)+'</p><button id="review-result-privacy" class="quiet" type="button">Review privacy for '+esc(plan.resource)+'</button>':'')+'<p>Keep asking legal combinations inside this reviewed boundary without another approval. Protect is optional and creates a disabled reusable capability.</p><div class="split-actions"><button id="ask-another-result" type="button">Ask another question</button><button id="protect-result" class="secondary" type="button">Protect this '+esc(plan.kind==="aggregate"?"analysis":"read")+'</button></div><details><summary>What Runner enforced</summary><p><strong>Tool:</strong> <code>app.explore_data</code><br><strong>Reviewed fields used:</strong> '+esc(visible.join(", ")||"record count")+'<br><strong>Minimum group size:</strong> '+esc(result.privacy.minimum_cohort_size??"not applicable")+'<br><strong>Kept out:</strong> '+esc(unavailable)+'<br><strong>Trusted scope:</strong> supplied outside the question<br><strong>Source database changed:</strong> no</p><div class="result-meta"><span class="badge">'+esc(result.audit.returned_rows_or_groups)+' row(s) / group(s)</span><span class="badge">'+esc(result.audit.returned_cells)+' cells</span></div><p>'+esc(result.untrusted_data_notice)+'</p></details></section>';
			        byId("ask-another-result").onclick=()=>{if(plan.kind==="rows")switchExploreMode("aggregate");byId("explore-composer").open=true;byId("explore-composer").scrollIntoView({behavior:"auto",block:"start"})};
		        if(byId("review-result-privacy"))byId("review-result-privacy").onclick=()=>openAccessEditor(plan.resource,undefined,true);
		        byId("protect-result").onclick=async()=>{preferredProtectQueryRef=resultProtectQueryRef;await loadProtect(resultProtectQueryRef);setView("protect")};
      }catch(error){
        const remediation=error.payload?.remediation;
        const relationshipReview=error.payload?.details?.relationship_review;
        const refusalDetails=error.payload?.details||{};
        const privacyComplement=error.payload?.error_code==="EXPLORE_PRIVACY_BUDGET_EXHAUSTED"
          &&refusalDetails.reason==="complementary_aggregate_release"
          &&attemptedPlan;
        const fieldOperation=error.payload?.error_code==="EXPLORE_FIELD_FORBIDDEN"
          &&refusalDetails.reason==="field_operation_not_reviewed";
        const privacyGuidance=privacyComplement
          ?suppressionReviewGuidance(attemptedPlan,attemptedBoundary,refusalDetails.minimum_cohort_size)
          :null;
        const drifted=["EXPLORE_LOCK_STALE","EXPLORE_BOUNDARY_MISMATCH"].includes(error.payload?.error_code);
        status.className="status-message error";
        status.textContent=error.message;
        const evidence=relationshipReview?.evidence||[];
        resultPanel.innerHTML='<section class="band error"><h3>Request refused safely</h3><p>'+esc(error.message)+'</p>'
          +(privacyGuidance?'<p>Runner executed the read-only aggregate, then discarded its result because releasing it could reconstruct a previously withheld group.</p><p>'+esc(privacyGuidance.path)+'</p><button id="review-refused-privacy" type="button">Review privacy for '+esc(attemptedPlan.resource)+'</button>':'')
          +(fieldOperation?'<p><strong>Review path:</strong> boundary '+esc(attemptedBoundary||"the active boundary")+' -> table '+esc(refusalDetails.resource||attemptedPlan?.resource||"the requested table")+' -> column '+esc(refusalDetails.field||"the requested field")+' -> Advanced field operations -> review '+esc(refusalDetails.operation||"this operation")+' -> Review and activate. If the operation is unavailable there, create a narrow reviewed view instead.</p><button id="review-refused-field" type="button">Review this field operation</button>':'')
          +(relationshipReview
            ?'<div class="risk"><strong>Catalog proof available for human review</strong><p>Counted entity: <code>'+esc(relationshipReview.counted_entity)+'</code> · Path depth: '+esc(relationshipReview.path_depth)+' · Nullable: '+esc(String(relationshipReview.nullable))+'</p>'+evidence.map(link=>'<p><code>'+esc(link.constraint)+'</code>: '+esc(link.source_resource+"."+link.source_columns.join(","))+' → unique '+esc(link.target_resource+"."+link.target_columns.join(","))+' · '+esc(link.cardinality)+' · max fan-out '+esc(link.max_fan_out)+'</p>').join("")+'<label class="field">Human reviewer<input id="relationship-review-actor" type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label><button id="review-missing-relationship" type="button">Review and add this relationship</button><span id="relationship-review-status" class="status-message"></span></div>'
            :"")
          +(remediation?'<p><strong>Next action:</strong> '+esc(remediation.action)+'</p><p>'+esc(remediation.preserved)+'</p>':"")
          +(drifted?'<button id="rescan-refused-analysis" type="button">Rescan and review the affected table or view</button>':"")+'</section>';
        if(privacyGuidance)byId("review-refused-privacy").onclick=()=>openAccessEditor(attemptedPlan.resource,undefined,true);
        if(fieldOperation)byId("review-refused-field").onclick=()=>openAccessEditor(refusalDetails.resource||attemptedPlan?.resource,refusalDetails.field);
        if(relationshipReview)byId("review-missing-relationship").onclick=()=>stageRelationshipReview(relationshipReview);
        if(drifted)byId("rescan-refused-analysis").onclick=previewProjectRescan;
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
       (candidate.unresolved_decisions||[])
         .filter(decision=>decision.startsWith("deployment profile:"))
         .forEach(decision=>confirmedDecisions.add(decision));
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
        byId("explore-result").innerHTML='<section class="band notice"><h3>Exact relationship staged for activation</h3><p>'+esc(payload.message)+'</p><p><strong>Staged review fingerprint:</strong> <code>'+esc(payload.candidate_digest)+'</code></p><p>The active boundary has not changed. The next step rechecks schema, role posture, saved review state, and this exact fingerprint before adding only the catalog-proven path shown above.</p><button id="activate-reviewed-relationship" type="button">Recheck and activate this reviewed path</button><span id="relationship-activation-status" class="status-message"></span></section>';
        byId("activate-reviewed-relationship").onclick=()=>activateReviewedRelationship(payload);
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    async function activateReviewedRelationship(staged){
      const status=byId("relationship-activation-status");
      try{
        const actor=byId("actor").value.trim();
        status.className="status-message";
        status.textContent="Creating the final review fingerprint from the current schema, role posture, and saved review...";
        const preview=await post("/api/boundary/preview",{
          candidate:staged.candidate,
          expected_revision:staged.revision,
          actor,
          confirmed_decisions:staged.confirmed_decisions
        });
        status.textContent="The final review fingerprint is current. Activating only this exact reviewed path...";
        const payload=await post("/api/boundary/activate",{
          candidate:preview.candidate,
          expected_digest:preview.digest,
          actor,
          confirmation:"ACTIVATE "+preview.digest,
          confirmed_decisions:staged.confirmed_decisions
        });
        activeBoundary=payload.active;
        activeBoundaries=[...activeBoundaries.filter(boundary=>boundary.pack?.name!==payload.active.pack.name),payload.active];
        synchronizeBoundaryAuthorityState(activeBoundary);
        byId("header-state").textContent="Active reviewed boundary";
        byId("header-state").className="state good";
        document.querySelector('[data-view="activate"]').classList.add("done");
        byId("explore-result").innerHTML='<section class="band success"><h3>Reviewed relationship active</h3><p>'+esc(payload.message)+'</p><p><strong>Active fingerprint:</strong> <code>'+esc(preview.digest)+'</code><br><strong>Source database changed:</strong> no</p><button id="retry-reviewed-relationship" type="button">Try the refused analysis again</button></section>';
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
		      const productionProfile=(activeBoundary?.pack?.deployment_profile||candidate?.deployment_profile)==="production";
		      const productionHttp=productionProfile
		        ?'<section class="band notice"><h3>Production Streamable HTTP clients</h3><p>Generate the native remote config after the production endpoint is deployed. Each file references one short-lived bearer-token environment variable; Runner writes no token value.</p><pre>'+esc("synapsor-runner mcp client-config --client claude-code --transport streamable-http --config ./synapsor.runner.json\\nsynapsor-runner mcp client-config --client cursor --transport streamable-http --config ./synapsor.runner.json\\nsynapsor-runner mcp client-config --client vscode --transport streamable-http --config ./synapsor.runner.json")+'</pre><p>Set <code>SYNAPSOR_MCP_ACCESS_TOKEN</code> in the client process from your configured identity provider, then reload the client. Do not paste the token into the generated file.</p></section>'
		        :'';
		      byId("client-configs").innerHTML='<p>Every client receives the same two local authoring tools and no approval or commit tool. Runner never puts database credentials in client files.</p>'
		        +productionHttp
		        +'<h3>Prepare this project</h3><p>Choose a client used by this project. Runner changes only its <code>synapsor</code> entry, preserves other settings, and backs up an existing file. The client starts the local stdio server when it opens this project.</p>'
		        +'<div class="actions"><button class="secondary" data-install-mcp="cursor" type="button">Prepare Cursor</button><button class="secondary" data-install-mcp="claude-code" type="button">Prepare Claude Code</button><button class="secondary" data-install-mcp="vscode" type="button">Prepare VS Code</button></div><div id="mcp-install-status" class="status-message" role="status" aria-live="polite"></div>'
		        +'<details><summary>Manual and generic client setup</summary><h3>Managed project installers</h3><pre>'+esc("synapsor-runner mcp install cursor --project --authoring --project-root . --yes\\nsynapsor-runner mcp install claude-code --project --authoring --project-root . --yes\\nsynapsor-runner mcp install vscode --project --authoring --project-root . --yes")+'</pre><h3>Generic stdio MCP</h3><pre>'+esc(JSON.stringify(config,null,2))+'</pre><h3>Direct server command</h3><p>Use this in another local MCP client. No model API key is needed by Runner.</p><pre>'+esc(command)+'</pre><h3>Codex</h3><pre>'+esc(codex)+'</pre></details>';
		      document.querySelectorAll("[data-install-mcp]").forEach(button=>button.onclick=()=>installManagedMcpClient(button));
		    }

		    async function installManagedMcpClient(button){
		      const status=byId("mcp-install-status");
		      const originalLabel=button.textContent;
		      document.querySelectorAll("[data-install-mcp]").forEach(item=>item.disabled=true);
		      button.textContent="Preparing...";
		      status.className="status-message";
		      status.textContent="Verifying the two-tool authoring boundary before changing this project's client configuration...";
		      try{
		        const payload=await post("/api/mcp/install",{client:button.dataset.installMcp});
		        status.className="status-message success";
		        const detection=payload.client_command_detected
		          ?esc(payload.client_name)+' was detected on this terminal PATH.'
		          :esc(payload.client_name)+' was not detected on this terminal PATH; the prepared config can remain until it is installed.';
		        status.innerHTML='<strong>'+esc(payload.client_name)+' project config is prepared.</strong> Runner verified '+esc(payload.tools.join(" and "))+' before writing '+esc(payload.destination)+'. No database credential was written. '+detection+' No live client session is connected yet; '+esc(payload.reload_instruction)+'.';
		        button.textContent="Prepared";
		      }catch(error){
		        status.className="status-message error";
		        status.textContent=error.message;
		        button.textContent=originalLabel;
		      }finally{
		        document.querySelectorAll("[data-install-mcp]").forEach(item=>item.disabled=false);
		      }
		    }

    async function loadProtect(preferredRef=preferredProtectQueryRef){
      const status=byId("protect-message");
      try{
        const payload=await getJson("/api/protect");
        protectQueries=payload.queries||[];
        const preferredIndex=preferredRef?protectQueries.findIndex(query=>query.query_ref===preferredRef):-1;
        if(preferredRef&&preferredIndex<0)throw new Error("The selected analysis is no longer available to Protect. Run the reviewed question again.");
        selectedProtect=protectQueries.length?(preferredIndex>=0?preferredIndex:0):null;
        renderProtect();
        status.className="status-message";
        status.textContent=protectQueries.length
          ?protectQueries.length+" recent result(s) available. The exact requested result is selected."
          :payload.message||"No recent result is ready.";
        if(preferredProtectedCapability)await loadProtectedDraft(preferredProtectedCapability);
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
      const query=protectQueries[selectedProtect];
      if(!query){list.innerHTML="";editor.innerHTML="";return}
      const summary=planSentence(query.normalized_plan);
      const liveEvidence=askEvidenceByRef.get(query.query_ref);
      const alternatives=protectQueries
        .map((candidate,index)=>({candidate,index}))
        .filter(item=>item.index!==selectedProtect);
      list.innerHTML='<section class="band notice"><strong>Selected executed result</strong><p>'+esc(summary)+'</p><p><code>'+esc(query.resource)+'</code> · expires '+esc(query.expires_at)+'</p>'
        +'<details><summary>Explore provenance</summary><p><strong>Original question</strong><br>'+(liveEvidence?esc(liveEvidence.question):'Unavailable. Runner does not persist or infer the MCP host conversation.')+'</p><p><strong>Model typed request</strong></p>'+(liveEvidence?'<pre>'+esc(JSON.stringify({tool:liveEvidence.call.tool,arguments:liveEvidence.call.arguments},null,2))+'</pre>':'<p class="muted">The exact host request is unavailable from this Workbench session.</p>')+'<p><strong>Runner normalized plan</strong></p><pre>'+esc(JSON.stringify(query.normalized_plan,null,2))+'</pre><p><strong>Runner evidence</strong><br>'+esc(query.evidence_bundle_id||"Unavailable")+' · query audit '+esc(query.query_audit_handle||"Unavailable")+'</p></details>'
        +'</section>'
        +(alternatives.length
          ?'<details><summary>Choose another recent result ('+alternatives.length+')</summary><div class="resource-list">'+alternatives.map(({candidate,index})=>'<button class="question" data-protect-index="'+index+'" type="button"><strong>'+esc(candidate.kind==="aggregate"?"Aggregate result":"Bounded rows")+'</strong><br><span>'+esc(planSentence(candidate.normalized_plan))+'</span></button>').join("")+'</div></details>'
          :"");
      document.querySelectorAll("[data-protect-index]").forEach(button=>button.onclick=()=>{selectedProtect=Number(button.dataset.protectIndex);preferredProtectQueryRef=protectQueries[selectedProtect]?.query_ref||null;preferredProtectedCapability=null;protectedDraft=null;renderProtect()});
      const literals=(query.literal_positions||[]).map((position,index)=>'<div class="risk"><label class="check"><input type="checkbox" data-arg-enable="'+index+'"><span>Turn this reviewed literal into a bounded typed argument</span></label><p><code>'+esc(position.location+" / "+(position.relationship?position.relationship+".":"")+position.field+" = "+JSON.stringify(position.current_value))+'</code></p><div class="form-grid"><label class="field">Argument name<input type="text" data-arg-name="'+index+'" value="'+esc(position.suggested_argument)+'"></label><label class="field">Description<input type="text" data-arg-description="'+index+'" value="'+esc("Reviewed "+position.field+" filter.")+'"></label></div></div>').join("");
      const cohort=query.minimum_cohort_override;
      const cohortReview=cohort
        ?'<div class="risk high"><strong>Re-confirm lowered aggregate privacy setting</strong><p>This analysis uses an explicit owner override: minimum group size '+esc(cohort.minimum_cohort_size)+'. '+(cohort.minimum_cohort_size===1?"Groups of one can identify individuals. ":"")+'Protecting it can graduate this staging disclosure posture into a named capability.</p><label class="check"><input id="protect-cohort-confirmed" type="checkbox"><span>I reviewed this consequence and want the protected draft to retain this setting.</span></label></div>'
        :"";
      editor.innerHTML='<section class="band"><div class="form-grid"><label class="field">Capability name<input id="protect-name" type="text" value="analytics.protected_query"></label><label class="field">Description<input id="protect-description" type="text" value="Answer one reviewed, bounded data question."></label><label class="field">Returns hint<input id="protect-returns" type="text" value="Returns only the reviewed bounded result shape."></label></div>'+cohortReview+'<h3 style="margin-top:16px">Literal review</h3>'+literals+'<div class="actions"><button id="create-protected" type="button">Generate disabled capability</button></div><div id="protect-preview"></div></section>';
      byId("create-protected").onclick=createProtected;
    }

    async function loadProtectedDraft(capabilityName){
      const status=byId("protect-message");
      status.className="status-message";
      status.textContent="Loading the exact disabled capability draft...";
      const payload=await getJson("/api/protect/draft?capability_name="+encodeURIComponent(capabilityName));
      renderProtectedActivation(payload,true);
      status.textContent="This generated capability is disabled. Review its DSL and exact digest before activation.";
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
          arguments:selectedArguments(query),
          ...(query.minimum_cohort_override?{
            minimum_cohort_confirmed:byId("protect-cohort-confirmed").checked,
            minimum_cohort_actor:byId("actor").value.trim()
          }:{})
        });
        renderProtectedActivation(payload,false);
        status.textContent="The generated capability is still disabled. Review its DSL and exact digest.";
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function renderProtectedActivation(payload,replaceEditor){
      protectedDraft=payload.draft;
      if(replaceEditor){
        byId("protect-editor").innerHTML='<section class="band"><div class="band notice"><strong>Review the generated authority, not the earlier freeform question.</strong><p>This capability is disabled. Activation applies only to the exact DSL and digest below.</p></div><div id="protect-preview"></div></section>';
      }
      const activationCohort=payload.draft.minimum_cohort_override;
      const activationCohortReview=activationCohort
        ?'<div class="risk high"><strong>Lowered privacy setting</strong><p>Activation retains minimum group size '+esc(activationCohort.minimum_cohort_size)+'. '+(activationCohort.minimum_cohort_size===1?"Groups of one can identify individuals. ":"")+'This decision is recorded separately from draft generation.</p><label class="check"><input id="activate-cohort-confirmed" type="checkbox"><span>I reviewed this consequence and want to activate this exact setting.</span></label></div>'
        :"";
      byId("protect-preview").innerHTML='<h3 style="margin-top:16px">Disabled named capability: '+esc(payload.draft.capability)+'</h3><p><strong>Agent authority activated:</strong> no</p><div class="band notice"><strong>Read-only authority generated</strong><p>Review the DSL below. This button is bound to the exact fingerprint you loaded; Runner recomputes it immediately before activation.</p><p><strong>DSL:</strong> <code>'+esc(payload.draft.dsl_path)+'</code><br><strong>Contract:</strong> <code>'+esc(payload.draft.contract_path)+'</code><br><strong>Tests:</strong> <code>'+esc(payload.draft.tests_path)+'</code></p></div><pre id="protect-dsl-preview"></pre><details><summary>Advanced fingerprint</summary><code>'+esc(payload.draft.contract_digest)+'</code></details><div class="form-grid"><label class="field">Operator identity<input id="protect-actor" type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label></div>'+activationCohortReview+'<label class="check" style="margin-top:12px"><input id="protect-disable-explore" type="checkbox"><span>Disable temporary Scoped Explore after activating this named capability.</span></label><div class="actions"><button id="activate-protected" type="button">Activate this reviewed capability</button></div>';
      renderSyntaxCode("protect-dsl-preview",payload.dsl,"synapsor-dsl");
      byId("activate-protected").onclick=activateProtected;
    }

    async function activateProtected(){
      const status=byId("protect-message");
      try{
        const payload=await post("/api/protect/activate",{
          capability_name:protectedDraft.capability,
          actor:byId("protect-actor").value.trim(),
          ...(protectedDraft.minimum_cohort_override?{
            minimum_cohort_confirmed:byId("activate-cohort-confirmed").checked
          }:{}),
          disable_explore:byId("protect-disable-explore").checked
        });
        status.className="status-message";
        byId("header-state").textContent=payload.active.exploration_disabled
          ?payload.remaining_boundaries.length
            ?"Protected capability active · "+payload.remaining_boundaries.length+" Explore "+(payload.remaining_boundaries.length===1?"boundary remains":"boundaries remain")
            :"Protected capability active · Explore disabled"
          :"Protected capability active";
        byId("header-state").className="state good";
        byId("activate-protected").disabled=true;
        document.querySelector('[data-view="protect"]').classList.add("done");
        if(!payload.active.exploration_disabled||payload.remaining_boundaries.length){
          await loadAskStatus();
          setView("explore");
        }else{
          setView("action");
        }
        status.textContent=payload.message;
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
      const resources=(guidedActionData?.options?.resources||[]).slice().sort((left,right)=>{
        const leftAvailable=Object.values(left.operation_availability||{}).some(item=>item.available);
        const rightAvailable=Object.values(right.operation_availability||{}).some(item=>item.available);
        return Number(rightAvailable)-Number(leftAvailable)||String(left.id).localeCompare(String(right.id));
      });
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
      const availableOperations=operations.filter(operation=>resource.operation_availability[operation].available);
      byId("action-operation").innerHTML=operations.map(operation=>{
        const availability=resource.operation_availability[operation];
        return '<option value="'+operation+'" '+(availability.available?"":"disabled")+' title="'+esc(availability.reason)+'">'+operation.toUpperCase()+(availability.available?"":" - unavailable")+'</option>';
      }).join("");
      if(!availableOperations.length){
        byId("action-operation").innerHTML='<option selected disabled>No native operation available</option>';
        byId("action-authoring-controls").classList.add("hidden");
        byId("action-unavailable").classList.remove("hidden");
        byId("action-unavailable").innerHTML='<h3>No native guarded write is available for this resource</h3><p>'+operations.map(operation=>'<strong>'+esc(operation.toUpperCase())+':</strong> '+esc(resource.operation_availability[operation].reason)).join("<br>")+'</p><p><strong>Next:</strong> choose another inspected writable resource. Keep multi-service or transaction-heavy actions in an app-owned executor.</p>';
        return;
      }
      byId("action-unavailable").classList.add("hidden");
      byId("action-authoring-controls").classList.remove("hidden");
      if(current&&resource.operation_availability[current]?.available)byId("action-operation").value=current;
      else byId("action-operation").value=availableOperations[0];
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
      const resourceReview=reviewResource(resource.id);
      byId("action-boundary-details").innerHTML='<p><strong>Trusted tenant:</strong> '+esc(reviewedTenantScopeLabel(resource,resourceReview))+'<br><strong>Trusted principal:</strong> '+esc(reviewedPrincipalScopeLabel(resource,resourceReview))+'<br><strong>Source-proven row identity:</strong> '+esc(resource.primary_key)+'<br><strong>Kept out:</strong> '+esc((resource.kept_out_fields||[]).join(", ")||"none")+'</p><p>The model cannot provide or change tenant, principal, a mandatory scope path, activation, approval, or apply authority.</p>';
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
      byId("action-draft").innerHTML='<section class="band success"><h3>Disabled reviewable action</h3><p><strong>Capability:</strong> '+esc(draft.capability)+'<br><strong>Operation:</strong> '+esc(draft.operation.toUpperCase())+'<br><strong>Supervised execution permission:</strong> '+(draft.supervised_worker_execution?"Contract side enabled; deployment side still required":"Off")+'<br><strong>Source database changed:</strong> no</p><details><summary>Review generated public DSL</summary><pre id="action-dsl-preview"></pre></details><details><summary>Advanced fingerprint</summary><code data-action-digest>'+esc(draft.contract_digest)+'</code></details><h3 style="margin-top:16px">Exact staging proposal preview</h3><p>Use a real row identifier and bounded values. This calls the actual proposal runtime; it cannot approve or apply.</p><div class="form-grid">'+inputs+'</div><div class="actions"><button id="preview-action" type="button">Create preview proposal</button></div><div id="action-activation"></div></section>';
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
      byId("action-activation").innerHTML='<div class="band notice"><strong>Proposal created. Source database changed: no.</strong><p>The model cannot approve or apply this proposal. Activating adds only this reviewed proposal capability; approval and apply remain separate operator actions. Runner binds this button to the exact fingerprint above and rechecks it before activation.</p></div><div class="form-grid"><label class="field">Operator identity<input id="action-actor" type="text" maxlength="128" value="'+esc(byId("actor").value.trim())+'"></label></div><div class="actions"><button id="activate-action" type="button">Activate reviewed proposal capability</button></div>';
      byId("activate-action").onclick=activateGuidedAction;
    }

    async function activateGuidedAction(){
      const status=byId("action-status");
      try{
        const payload=await post("/api/actions/guided/activate",{
          capability_name:guidedActionDraft.draft.capability,
          expected_digest:guidedActionDraft.draft.contract_digest,
          confirmation:"ACTIVATE "+guidedActionDraft.draft.contract_digest,
          actor:byId("action-actor").value.trim()
        });
        status.className="status-message";
        status.textContent=payload.message;
        byId("action-activation").innerHTML='<div class="band success"><strong>Safe action active.</strong><p>Its MCP call creates a proposal only. Approval and apply remain outside the model.</p><div class="actions"><button id="review-proposal" type="button">Review proposal outside MCP</button><button id="finish-authoring" type="button" class="secondary">Disable Explore and review proposal</button></div><p class="muted">Reviewing does not end this local analytics session. Disable Explore only when authoring is finished.</p></div>';
        byId("review-proposal").onclick=openProposalReview;
        byId("finish-authoring").onclick=finishGuidedAuthoring;
        document.querySelector('[data-view="action"]').classList.add("done");
        byId("header-state").textContent="Reviewed read and proposal tools active";
        byId("header-state").className="state good";
      }catch(error){
        status.className="status-message error";
        status.textContent=error.message;
      }
    }

    function openProposalReview(){
      window.location.href="/?surface=activity";
    }

    async function finishGuidedAuthoring(){
      const status=byId("action-status");
      try{
         const payload=await post("/api/explore/disable",{});
         activeBoundary=null;
         activeBoundaries=[];
         synchronizeBoundaryAuthorityState(null);
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
	      document.querySelectorAll("[data-next]").forEach(button=>button.onclick=()=>{
	        if(button.dataset.next==="exceptions")openFocusedAccessReview();
	        else setView(button.dataset.next);
	      });
	    }

	    async function loadSessionStatus(){
	      try{
	        const session=await getJson("/api/session");
	        const state=byId("session-state");
	        const absoluteExpiry=new Date(session.absolute_expires_at);
	        state.textContent="Session active";
	        state.className="badge good";
	        state.title="This local operator session expires by "+absoluteExpiry.toLocaleTimeString()+". Active requests renew the idle deadline, never the absolute lifetime.";
	        const warningDelay=absoluteExpiry.getTime()-Date.now()-(15*60*1000);
	        if(warningDelay>0&&warningDelay<2_147_000_000){
	          window.setTimeout(()=>{
	            if(!byId("session-state"))return;
	            byId("session-state").textContent="Session expires soon";
	            byId("session-state").className="badge warn";
	          },warningDelay);
	        }
	      }catch(error){
	        if(error.payload?.error_code)return;
	        byId("session-state").textContent="Session status unavailable";
	        byId("session-state").className="badge warn";
	      }
	    }

		    async function load(){
		      const payload=await getJson("/api/boundary");
		      original=payload.draft;
		      candidate=structuredClone(payload.candidate||payload.draft);
		      boundaryLibrary=payload.boundary_library||{
		        selected_name:candidate.pack.name,
		        entries:[]
		      };
	      boundaryRescanReport=payload.boundary_rescan_report||null;
	      databaseServerCompatibility=payload.database_server_compatibility||null;
	      if(accessBaselineColumns===null)accessBaselineColumns=accessColumnSnapshot(candidate);
	      reviewReport=payload.review;
	      activeBoundary=payload.active;
	      activeBoundaries=payload.active_boundaries||[];
	      boundaryCatalog=payload.boundary_catalog||{schema_version:"synapsor.boundary-catalog.v1",table_count:0,relationship_count:0,boundaries:[]};
	      boundaryMermaid=payload.boundary_mermaid||"flowchart LR";
	      boundaryDiagrams=payload.boundary_diagrams||[];
	      journey=payload.journey;
      instantOnboarding=payload.instant_onboarding;
      const namedAuthorityActive=!activeBoundaries.length&&journey?.authority_active===true;
      const anyAuthorityActive=activeBoundaries.length>0||namedAuthorityActive;
      confirmedDecisions=new Set(payload.confirmed_decisions||[]);
      (candidate.unresolved_decisions||[])
        .filter(decision=>decision.startsWith("deployment profile:"))
        .forEach(decision=>confirmedDecisions.add(decision));
      reviewRevision=payload.review_progress?.revision||0;
      reviewInvalidations=payload.review_progress?.invalidated_decisions||[];
      reviewProgressHealthy=true;
       showDeploymentProfile(candidate.deployment_profile);
      if(payload.operator_identity)byId("actor").value=payload.operator_identity;
       byId("header-state").textContent=activeBoundaries.length
         ?activeBoundaries.length===1?"1 active reviewed boundary":activeBoundaries.length+" active reviewed boundaries"
        :namedAuthorityActive
          ?"Reviewed named tools active"
          :"No data access active";
      byId("header-state").className=anyAuthorityActive?"state good":"state";
      byId("overview-notice").className=anyAuthorityActive?"band success":"band notice";
	      byId("overview-notice").textContent=activeBoundaries.length
	        ?"Reviewed local data access is active. Each query uses exactly one boundary; named production tools remain separate."
        :namedAuthorityActive
          ?"Reviewed named tools are active. Temporary Scoped Explore is off."
	        :"Source rows remain unavailable until you review and activate this access.";
	      const next=journey?.recommended_next_action||(anyAuthorityActive?"Try an active reviewed tool.":"Review what the agent can see.");
	      byId("journey-state").innerHTML='<div><strong>'+esc(next)+'</strong><p>Agent data access active: '+esc(anyAuthorityActive?"yes":"no")+' · Source database changed: no</p></div><span class="badge '+(anyAuthorityActive?"good":"warn")+'">'+esc(activeBoundaries.length?"Reviewed local access active":namedAuthorityActive?"Reviewed named tools active":"Source rows unavailable")+'</span>';
	      const primary=byId("overview-primary");
	      primary.textContent=anyAuthorityActive?"Try active tools":"Review security exceptions";
	      primary.dataset.next=anyAuthorityActive?"explore":"exceptions";
		      renderSummary();
	      renderInstantOnboarding();
		      renderBoundaryOverview();
		      renderResources();
	      renderResourceDetail();
	      renderStagedAccessBar();
	      renderSignoff();
      if(anyAuthorityActive)document.querySelector('[data-view="activate"]').classList.add("done");
    }

	    document.querySelectorAll("[data-view]").forEach(button=>button.onclick=()=>setView(button.dataset.view));
	    function setResourceFilter(filter){
	      resourceFilter=resourceFilter===filter?"all":filter;
	      const collectionLabel=reviewedCollectionLabel();
	      byId("show-all").textContent=resourceFilter==="all"?"Showing all "+collectionLabel:"Show all "+collectionLabel;
	      byId("show-risks").textContent=resourceFilter==="risks"?"Show all resources":"Show only risks";
	      byId("show-exposed").textContent=resourceFilter==="exposed"?"Show all "+collectionLabel:"Show visible data";
	      byId("show-unresolved").textContent=resourceFilter==="unresolved"?"Show all "+collectionLabel:"Show blocked setup";
	      renderResources();
	    }
	    byId("show-all").onclick=()=>setResourceFilter(resourceFilter==="all"?"starter":"all");
	    byId("show-risks").onclick=()=>setResourceFilter("risks");
	    byId("show-exposed").onclick=()=>setResourceFilter("exposed");
	    byId("show-unresolved").onclick=()=>setResourceFilter("unresolved");
	    byId("resource-search").oninput=event=>{
	      resourceSearch=event.currentTarget.value;
	      renderResourceNavigation();
	    };
	    byId("show-related-access").onclick=()=>{
	      showAllAccessResources=false;
	      renderResourceNavigation();
	    };
	    byId("show-all-access").onclick=()=>{
	      showAllAccessResources=true;
	      renderResourceNavigation();
	    };
	    byId("resume-review").onclick=()=>{
	      if(hasActiveAuthority())setView("explore");
	      else openFocusedAccessReview();
	    };
	    byId("try-active").onclick=()=>{
	      if(hasActiveAuthority())setView("explore");
	      else byId("project-action-message").textContent="No authority is active. Next: finish boundary review.";
	    };
     byId("rescan-project").onclick=previewProjectRescan;
     byId("start-over").onclick=previewStartOver;
     byId("run-instant").onclick=runInstantOnboarding;
     byId("instant-full-review").onclick=()=>openFocusedAccessReview({useStarter:true});
	    byId("actor").addEventListener("input",()=>candidateDigest?invalidateDigest():updateActivationState());
    byId("preview").onclick=previewBoundary;
     byId("run-preflight").onclick=runPreflight;
	     document.querySelectorAll("[data-prove-boundary]").forEach(button=>button.onclick=proveBoundary);
	     document.querySelectorAll("[data-tune-boundary]").forEach(button=>button.onclick=()=>openFocusedAccessReview());
	     byId("leave-ask-focus").onclick=()=>setView("overview");
	     byId("access-back").onclick=()=>{
	       focusedAccessReview=false;
	       setView(hasActiveAuthority()?"explore":"overview");
	     };
	     byId("review-staged-access").onclick=openFocusedActivationReview;
     byId("open-client-setup").onclick=revealExistingClientSetup;
     byId("ask-open-no-model").onclick=revealNoModelComposer;
     byId("open-no-model").onclick=revealNoModelComposer;
    byId("aggregate-tab").onclick=()=>switchExploreMode("aggregate");
    byId("row-tab").onclick=()=>switchExploreMode("rows");
    byId("run-explore").onclick=runExplore;
    byId("ask-provider").onchange=()=>updateAskProviderFields(true);
    byId("ask-key-source").onchange=updateAskCredentialFields;
    byId("ask-egress").onchange=()=>{
      if(!byId("ask-egress").checked)return;
      byId("ask-egress-review").classList.remove("needs-attention");
      if(byId("ask-config-status").textContent.includes("provider-egress checkbox")){
        byId("ask-config-status").className="status-message";
        byId("ask-config-status").textContent="Provider egress reviewed. Start asking when ready.";
      }
    };
    byId("configure-ask").onclick=configureAsk;
    byId("update-ask-limits").onclick=updateAskLimits;
    byId("change-ask-provider").onclick=showAskConfiguration;
    byId("run-ask").onclick=runAsk;
    byId("ask-question").addEventListener("keydown",event=>{
      if(event.key==="Enter"&&!event.shiftKey&&!event.isComposing){
        event.preventDefault();
        if(!byId("run-ask").disabled)runAsk();
      }
    });
    byId("cancel-ask").onclick=cancelAsk;
    byId("clear-ask").onclick=clearAsk;
    byId("load-ask-history").onclick=loadAskHistory;
    byId("refresh-protect").onclick=loadProtect;
    byId("load-action").onclick=loadGuidedAction;
    byId("create-action").onclick=createGuidedAction;
    byId("action-quorum").onchange=updateGuidedCompatibility;
    updateAskProviderFields(false);
    bindNextButtons();
	    loadSessionStatus();
	    load().then(initializeViewHistory).catch(error=>{
      byId("header-state").textContent="Review unavailable";
      byId("overview-notice").className="band error";
      byId("overview-notice").innerHTML='<strong>Boundary review could not load.</strong><p>'+esc(error.message)+'</p><p>No authority changed and the source database was not modified.</p><button id="retry-boundary-load" type="button">Retry boundary review</button>';
      byId("retry-boundary-load").onclick=()=>{
        byId("overview-notice").className="band notice";
        byId("overview-notice").textContent="Reloading the current disabled review state...";
        load().catch(retryError=>{
          byId("overview-notice").className="band error";
          byId("overview-notice").textContent="Boundary review still cannot load: "+retryError.message;
        });
      };
    });
  </script>
</body>
</html>`;
}

function escapeScriptString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/</g, "\\u003c");
}
