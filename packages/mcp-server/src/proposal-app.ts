export const PROPOSAL_APP_URI = "ui://synapsor/proposal-review.html";
export const PROPOSAL_APP_SPEC_VERSION = "2026-01-26";

export function proposalAppInitializeRequest(id: number | string = 1) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "ui/initialize" as const,
    params: {
      appInfo: { name: "synapsor-proposal-review", version: "1.0.0" },
      appCapabilities: {},
      protocolVersion: PROPOSAL_APP_SPEC_VERSION,
    },
  };
}

export function proposalAppHtml(): string {
  const initializeRequest = JSON.stringify(proposalAppInitializeRequest(1));
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Synapsor proposal review</title>
  <style>
    :root {
      color-scheme: light dark;
      font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
      background: var(--color-background-primary, #f7f8f8);
      color: var(--color-text-primary, #16201f);
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; }
    main {
      width: min(100%, 760px);
      border: 1px solid var(--color-border-secondary, #cbd5d3);
      border-radius: 8px;
      background: var(--color-background-secondary, #ffffff);
      overflow: hidden;
    }
    header { padding: 16px 18px 12px; border-bottom: 1px solid var(--color-border-tertiary, #e4e8e7); }
    h1 { margin: 0; font-size: 18px; line-height: 1.3; letter-spacing: 0; }
    .subtitle { margin: 5px 0 0; color: var(--color-text-secondary, #52605e); font-size: 13px; }
    .status { display: inline-flex; margin-top: 10px; padding: 3px 8px; border-radius: 999px; background: #dff5ee; color: #075c44; font-size: 12px; font-weight: 700; }
    .content { display: grid; gap: 0; }
    section { padding: 14px 18px; border-bottom: 1px solid var(--color-border-tertiary, #e4e8e7); }
    section:last-child { border-bottom: 0; }
    h2 { margin: 0 0 9px; font-size: 13px; line-height: 1.3; letter-spacing: 0; }
    dl { display: grid; grid-template-columns: minmax(120px, 0.6fr) minmax(0, 1.4fr); gap: 7px 12px; margin: 0; font-size: 13px; }
    dt { color: var(--color-text-secondary, #52605e); }
    dd { margin: 0; overflow-wrap: anywhere; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; table-layout: fixed; }
    th, td { padding: 7px 8px; border: 1px solid var(--color-border-tertiary, #e4e8e7); text-align: left; overflow-wrap: anywhere; }
    th { background: var(--color-background-tertiary, #f1f4f3); }
    code { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
    .boundary { color: var(--color-text-secondary, #52605e); font-size: 12px; line-height: 1.5; }
    .empty { padding: 20px 18px; color: var(--color-text-secondary, #52605e); }
    @media (max-width: 520px) {
      body { padding: 6px; }
      dl { grid-template-columns: 1fr; gap: 3px; }
      dd { margin-bottom: 7px; }
      th, td { padding: 6px; }
    }
  </style>
</head>
<body>
  <main aria-live="polite">
    <div class="empty" id="empty">Waiting for a Synapsor proposal result...</div>
    <div id="view" hidden>
      <header>
        <h1 id="title">Reviewed proposal</h1>
        <p class="subtitle" id="subtitle"></p>
        <span class="status" id="status"></span>
      </header>
      <div class="content">
        <section>
          <h2>Trusted scope</h2>
          <dl id="scope"></dl>
        </section>
        <section>
          <h2>Exact proposed diff</h2>
          <table>
            <thead><tr><th>Field</th><th>Before</th><th>Proposed</th></tr></thead>
            <tbody id="diff"></tbody>
          </table>
        </section>
        <section>
          <h2>Evidence and guards</h2>
          <dl id="guards"></dl>
        </section>
        <section>
          <h2>Operator handoff</h2>
          <p class="boundary" id="handoff"></p>
          <code id="command"></code>
        </section>
      </div>
    </div>
  </main>
  <script>
    (() => {
      const parentWindow = window.parent;
      let requestId = 1;
      const text = (value) => value === null || value === undefined ? "not configured" : typeof value === "object" ? JSON.stringify(value) : String(value);
      const addPair = (target, label, value) => {
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = label;
        dd.textContent = text(value);
        target.append(dt, dd);
      };
      const render = (payload) => {
        const review = payload && typeof payload === "object" ? payload.proposal_review : null;
        if (!review || review.schema_version !== "synapsor.proposal-review-view.v1") return;
        document.getElementById("empty").hidden = true;
        document.getElementById("view").hidden = false;
        document.getElementById("title").textContent = text(review.requested_business_action);
        document.getElementById("subtitle").textContent = text(review.semantic_capability);
        document.getElementById("status").textContent = text(review.proposal && review.proposal.status);
        const scope = document.getElementById("scope");
        scope.replaceChildren();
        addPair(scope, "Tenant", review.trusted_context && review.trusted_context.tenant_id);
        addPair(scope, "Principal", review.trusted_context && review.trusted_context.principal);
        addPair(scope, "Expected version", review.expected_source_version);
        addPair(scope, "Expiration", review.expiration && review.expiration.status);
        const diff = document.getElementById("diff");
        diff.replaceChildren();
        Object.entries(review.diff || {}).forEach(([field, values]) => {
          const row = document.createElement("tr");
          [field, values && values.before, values && values.proposed].forEach((value) => {
            const cell = document.createElement("td");
            cell.textContent = text(value);
            row.appendChild(cell);
          });
          diff.appendChild(row);
        });
        const guards = document.getElementById("guards");
        guards.replaceChildren();
        addPair(guards, "Evidence", review.evidence_summary && review.evidence_summary.bundle_id);
        addPair(guards, "Kept-out values", "not included");
        addPair(guards, "Policy / risk", review.policy_and_risk);
        addPair(guards, "Receipt", review.receipt && review.receipt.status);
        document.getElementById("handoff").textContent = review.handoff && review.handoff.note
          ? review.handoff.note
          : "Review in the standalone local operator UI. This card contains no approval or apply authority.";
        document.getElementById("command").textContent = review.handoff && review.handoff.local_ui_command
          ? review.handoff.local_ui_command
          : "synapsor-runner ui";
        parentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: {
          width: Math.ceil(document.documentElement.getBoundingClientRect().width),
          height: Math.ceil(document.documentElement.getBoundingClientRect().height)
        } }, "*");
      };
      window.addEventListener("message", (event) => {
        if (event.source !== parentWindow || !event.data || event.data.jsonrpc !== "2.0") return;
        if (event.data.id === requestId && event.data.result) {
          parentWindow.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} }, "*");
        }
        if (event.data.method === "ui/notifications/tool-result") {
          render(event.data.params && event.data.params.structuredContent);
        }
      });
      parentWindow.postMessage(${initializeRequest}, "*");
    })();
  </script>
</body>
</html>`;
}
