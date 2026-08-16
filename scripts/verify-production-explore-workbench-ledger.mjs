import path from "node:path";
import { ProposalStore } from "../packages/proposal-store/dist/index.js";
import { startLocalUiServer } from "../apps/runner/dist/local-ui.js";
import { withSharedPostgresRuntimeStoreReadBridge } from "../apps/runner/dist/store-shared.js";

function assert(condition, message, detail) {
  if (!condition) {
    throw new Error(`${message}${detail === undefined ? "" : `\n${JSON.stringify(detail, null, 2)}`}`);
  }
}

async function jsonRequest(server, pathname) {
  const response = await fetch(`http://${server.host}:${server.port}${pathname}`, {
    headers: { "x-synapsor-ui-token": server.token },
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

export async function verifyProductionExploreWorkbenchLedger(input) {
  const priorControlUrl = process.env[input.url_env];
  const hmacKeyEnv = input.runtime_config.production_explore?.budget_hmac_key_env;
  const priorHmacKey = hmacKeyEnv ? process.env[hmacKeyEnv] : undefined;
  process.env[input.url_env] = input.control_url;
  if (hmacKeyEnv && input.hmac_key) process.env[hmacKeyEnv] = input.hmac_key;
  const bridgeArgs = ["--config", input.config_path];
  const storeAccess = async (mode, operation, callback) => {
    if (mode !== "read") throw new Error("production Explore ledger verification is read-only");
    return withSharedPostgresRuntimeStoreReadBridge(
      bridgeArgs,
      input.runtime_config,
      `production verifier Workbench ${operation}`,
      async (bridgeStorePath) => {
        const store = new ProposalStore(bridgeStorePath);
        try {
          return callback(store);
        } finally {
          store.close();
        }
      },
    );
  };
  let server;
  try {
    server = await startLocalUiServer({
      configPath: input.config_path,
      storePath: input.runtime_config.storage.sqlite_path,
      storeAccess,
      ledgerSource: {
        kind: "shared_postgres",
        schema: input.schema,
        url_env: input.url_env,
        read_only: true,
      },
      projectRoot: input.project_root,
      boundaryRoot: path.join(input.project_root, "synapsor/generated"),
      deploymentProfile: "production",
      token: `production-ledger-${input.engine}`,
      csrfToken: `production-ledger-csrf-${input.engine}`,
    });

    const historyResponse = await jsonRequest(server, "/api/explore/history");
    assert(historyResponse.status === 200 && historyResponse.payload.ok === true,
      `${input.engine} Workbench could not list production Explore history.`, historyResponse);
    assert(historyResponse.payload.ledger_source?.kind === "shared_postgres"
      && historyResponse.payload.ledger_source?.schema === input.schema
      && historyResponse.payload.ledger_source?.url_env === input.url_env
      && historyResponse.payload.ledger_source?.read_only === true,
    `${input.engine} Workbench did not identify the read-only shared PostgreSQL ledger.`, historyResponse.payload.ledger_source);
    const identityFilters = new URLSearchParams({
      ...(input.tenant ? { tenant: input.tenant } : {}),
      ...(input.principal ? { principal: input.principal } : {}),
      limit: "200",
    });
    const identityResponse = input.tenant || input.principal
      ? await jsonRequest(server, `/api/explore/history?${identityFilters}`)
      : historyResponse;
    assert(identityResponse.status === 200
      && identityResponse.payload.durable?.length > 0,
    `${input.engine} Workbench could not resolve plaintext production scope filters.`, identityResponse);
    const audit = identityResponse.payload.durable?.find((item) => item.evidence_bundle_id);
    assert(audit, `${input.engine} Workbench production history had no evidence-linked query audit.`, historyResponse.payload.durable);

    const detailResponse = await jsonRequest(server, `/api/explore/history?audit_id=${encodeURIComponent(audit.audit_id)}`);
    assert(detailResponse.status === 200
      && detailResponse.payload.audit?.audit_id === audit.audit_id
      && detailResponse.payload.audit?.result_values_persisted === false
      && detailResponse.payload.audit?.trusted_scope_values_persisted === false
      && detailResponse.payload.audit?.raw_sql_included === false
      && /FROM\s+/i.test(String(detailResponse.payload.audit?.reconstructed_query?.statement ?? ""))
      && /RUNNER_(?:TENANT|PRINCIPAL)_PREDICATE|predicate not applied/i.test(String(detailResponse.payload.audit?.reconstructed_query?.statement ?? "")),
    `${input.engine} Workbench query-audit detail violated production redaction.`, detailResponse);

    const evidenceResponse = await jsonRequest(
      server,
      `/api/explore/evidence?evidence_id=${encodeURIComponent(audit.evidence_bundle_id)}`,
    );
    const evidence = evidenceResponse.payload.evidence;
    assert(evidenceResponse.status === 200
      && evidence?.evidence_bundle_id === audit.evidence_bundle_id
      && evidence?.result_values_persisted === false
      && /^keyed:[a-f0-9]{64}$/.test(String(evidence?.tenant_scope_fingerprint ?? ""))
      && /FROM\s+/i.test(String(evidence?.reconstructed_query?.statement ?? "")),
    `${input.engine} Workbench evidence detail omitted keyed scope or redaction.`, evidenceResponse);

    const since = new Date(Math.max(0, Date.parse(audit.created_at) - 1_000)).toISOString();
    const filtered = new URLSearchParams({
      ...(input.tenant ? { tenant: input.tenant } : { tenant: evidence.tenant_scope_fingerprint }),
      ...(input.principal ? { principal: input.principal } : {}),
      resource: audit.resource,
      capability: "app.explore_data",
      boundary: detailResponse.payload.audit.boundary_digest,
      outcome: "ok",
      since,
      limit: "5",
    });
    const filteredResponse = await jsonRequest(server, `/api/explore/history?${filtered}`);
    assert(filteredResponse.status === 200
      && filteredResponse.payload.durable?.some((item) => item.audit_id === audit.audit_id),
    `${input.engine} Workbench shared-ledger filters did not preserve the matching query audit.`, filteredResponse);

    const serialized = JSON.stringify({
      history: historyResponse.payload,
      identity: identityResponse.payload,
      detail: detailResponse.payload,
      evidence: evidenceResponse.payload,
    });
    assert(!serialized.includes(input.control_url),
      `${input.engine} Workbench disclosed the shared PostgreSQL control URL.`);
    assert(!input.tenant || !serialized.includes(input.tenant),
      `${input.engine} Workbench echoed a plaintext tenant filter.`);
    assert(!input.principal || !serialized.includes(input.principal),
      `${input.engine} Workbench echoed a plaintext principal filter.`);

    delete process.env[input.url_env];
    const unavailableResponse = await jsonRequest(server, "/api/explore/history");
    assert(unavailableResponse.status >= 400
      && String(unavailableResponse.payload.error ?? "").includes(input.url_env)
      && !JSON.stringify(unavailableResponse.payload).includes(input.control_url),
    `${input.engine} Workbench shared-store outage did not name only the configured URL environment variable.`, unavailableResponse);
    process.env[input.url_env] = input.control_url;

    return {
      ledger_source: historyResponse.payload.ledger_source,
      durable_query_audits: historyResponse.payload.durable.length,
      evidence_bundle_id: audit.evidence_bundle_id,
      filtered: true,
      unreachable_store_names_env_only: true,
      read_only: true,
    };
  } finally {
    await server?.close().catch(() => undefined);
    if (priorControlUrl === undefined) delete process.env[input.url_env];
    else process.env[input.url_env] = priorControlUrl;
    if (hmacKeyEnv) {
      if (priorHmacKey === undefined) delete process.env[hmacKeyEnv];
      else process.env[hmacKeyEnv] = priorHmacKey;
    }
  }
}
