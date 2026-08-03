import {
  serveStdio,
} from "../../dist/index.js";

const contractDigest = `sha256:${"e".repeat(64)}`;
const config = {
  version: 1,
  mode: "shadow",
  result_format: 2,
  storage: { sqlite_path: ":memory:" },
  sources: {
    local_postgres: {
      engine: "postgres",
      read_url_env: "DATABASE_URL",
      read_only: true,
    },
  },
  trusted_context: {
    provider: "environment",
    values: {
      tenant_id_env: "SYNAPSOR_TENANT_ID",
      principal_env: "SYNAPSOR_PRINCIPAL",
    },
  },
  capabilities: [
    analyticalCapability(contractDigest),
    readCapability(contractDigest),
    proposalCapability(contractDigest),
  ],
};

await serveStdio({
  config,
  resultFormat: 2,
  stdin: process.stdin,
  stdout: process.stdout,
  readRow: async ({ capability }) => capability.kind === "aggregate_read"
    ? {
      row: { aggregate_value: 8, group_size: 8 },
      rowCount: 1,
    }
    : {
      row: {
        id: "INC-100",
        tenant_id: "tenant-acme",
        assigned_to: "operator-1",
        status: "open",
        severity: "high",
        version: 3,
      },
      rowCount: 1,
    },
});

function base(contractDigest) {
  return {
    source: "local_postgres",
    target: {
      schema: "public",
      table: "incidents",
      primary_key: "id",
      tenant_key: "tenant_id",
      principal_scope_key: "assigned_to",
    },
    args: {
      incident_id: { type: "string", required: true, max_length: 64 },
    },
    lookup: { id_from_arg: "incident_id" },
    contract_provenance: { digest: contractDigest, version: "1.0.0" },
  };
}

function analyticalCapability(contractDigest) {
  return {
    ...base(contractDigest),
    name: "operations.incidents_by_region",
    kind: "aggregate_read",
    args: {},
    visible_columns: [],
    kept_out_fields: ["customer_email", "internal_notes"],
    aggregate: {
      function: "count",
      count_mode: "rows",
      selection: { all: [{ column: "status", operator: "eq", value: "open" }] },
      minimum_group_size: 5,
    },
  };
}

function readCapability(contractDigest) {
  return {
    ...base(contractDigest),
    name: "operations.inspect_incident",
    kind: "read",
    visible_columns: ["id", "status", "severity", "version"],
    kept_out_fields: ["customer_email", "internal_notes"],
    max_rows: 1,
  };
}

function proposalCapability(contractDigest) {
  return {
    ...base(contractDigest),
    name: "operations.propose_close_incident",
    kind: "proposal",
    args: {
      incident_id: { type: "string", required: true, max_length: 64 },
      resolution: { type: "string", required: true, max_length: 200 },
    },
    visible_columns: ["id", "status", "severity", "version"],
    kept_out_fields: ["customer_email", "internal_notes"],
    patch: {
      status: { fixed: "closed" },
      resolution: { from_arg: "resolution" },
    },
    allowed_columns: ["status", "resolution"],
    operation: { kind: "update", cardinality: "single" },
    conflict_guard: { column: "version" },
    approval: { mode: "human", required_role: "incident_manager" },
    writeback: { mode: "direct_sql" },
  };
}
