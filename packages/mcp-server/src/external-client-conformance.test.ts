import path from "node:path";
import {
  fileURLToPath,
} from "node:url";
import {
  Client,
} from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  describe,
  expect,
  it,
} from "vitest";
import {
  startStreamableHttpMcpServer,
  type RuntimeConfig,
} from "./index.js";

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/external-client-stdio-server.mjs",
);
const contractDigest = `sha256:${"e".repeat(64)}` as const;

describe("host-neutral external client conformance", () => {
  it("discovers schemas and forwards legal and illegal typed calls over generic stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fixturePath],
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://unused.example.test/conformance",
        SYNAPSOR_TENANT_ID: "tenant-acme",
        SYNAPSOR_PRINCIPAL: "operator-1",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "external-stdio-conformance", version: "1.0.0" });
    try {
      await client.connect(transport);
      await assertExternalApplicationContract(client);
    } finally {
      await client.close();
    }
  });

  it("enforces the same contract over bearer-authenticated Streamable HTTP", async () => {
    const token = "external-conformance-token-that-is-at-least-32-bytes";
    const config = conformanceConfig();
    const server = await startStreamableHttpMcpServer({
      config,
      host: "127.0.0.1",
      port: 0,
      authTokenEnv: "SYNAPSOR_RUNNER_HTTP_TOKEN",
      resultFormat: 2,
      env: {
        DATABASE_URL: "postgresql://unused.example.test/conformance",
        SYNAPSOR_RUNNER_HTTP_TOKEN: token,
        SYNAPSOR_TENANT_ID: "tenant-acme",
        SYNAPSOR_PRINCIPAL: "operator-1",
      },
      readRow: conformanceReadRow,
      log: false,
    });
    const client = new Client({ name: "external-http-conformance", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(server.url), {
      requestInit: {
        headers: { authorization: `Bearer ${token}` },
      },
    });
    try {
      await client.connect(transport);
      await assertExternalApplicationContract(client);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

async function assertExternalApplicationContract(client: Client): Promise<void> {
  const listed = await client.listTools();
  expect(listed.tools.map((tool) => tool.name)).toEqual([
    "operations.incidents_by_region",
    "operations.inspect_incident",
    "operations.propose_close_incident",
  ]);
  expect(listed.tools.some((tool) => /sql|approve|apply|commit/i.test(tool.name))).toBe(false);
  const analytical = listed.tools[0];
  expect(analytical?.outputSchema).toMatchObject({
    type: "object",
    properties: {
      ok: expect.any(Object),
      data: expect.any(Object),
      error: expect.any(Object),
    },
  });
  expect(analytical?._meta?.["synapsor.contract_digest"]).toBe(contractDigest);

  const catalogResponse = await client.readResource({ uri: "synapsor://analytics/catalog/v1" });
  const catalogContent = catalogResponse.contents[0];
  if (!catalogContent || !("text" in catalogContent)) throw new Error("analytics catalog missing");
  const catalog = JSON.parse(catalogContent.text);
  expect(catalog.capabilities).toHaveLength(1);
  expect(catalog.capabilities[0]).toMatchObject({
    capability: "operations.incidents_by_region",
    contract: { digest: contractDigest },
  });

  const analysis = await client.callTool({
    name: "operations.incidents_by_region",
    arguments: {},
  });
  expect(analysis.structuredContent).toMatchObject({
    ok: true,
    kind: "aggregate_read",
    data: {
      function: "count",
      suppressed: false,
      minimum_group_size: 5,
      value: 8,
      member_rows_included: false,
    },
    source_database_changed: false,
  });

  const illegal = await client.callTool({
    name: "operations.incidents_by_region",
    arguments: { tenant_id: "other-tenant" },
  });
  expect(illegal.isError).toBe(true);
  expect(JSON.stringify(illegal)).toMatch(/input validation|unrecognized key/i);
  expect(JSON.stringify(illegal)).not.toContain("other-tenant");

  const read = await client.callTool({
    name: "operations.inspect_incident",
    arguments: { incident_id: "INC-100" },
  });
  expect(read.structuredContent).toMatchObject({
    ok: true,
    kind: "read",
    data: {
      id: "INC-100",
      status: "open",
      severity: "high",
      version: 3,
    },
    source_database_changed: false,
  });
  expect(JSON.stringify(read)).not.toMatch(/customer_email|internal_notes/);

  const proposal = await client.callTool({
    name: "operations.propose_close_incident",
    arguments: {
      incident_id: "INC-100",
      resolution: "Resolved through reviewed operational procedure.",
    },
  });
  expect(proposal.structuredContent).toMatchObject({
    ok: true,
    kind: "proposal",
    proposal: {
      approval_required: true,
      writeback: { applied: false },
    },
    proposal_review: {
      security_boundary: {
        approval_tool_exposed: false,
        apply_tool_exposed: false,
      },
    },
    source_database_changed: false,
  });
  expect(JSON.stringify(proposal)).not.toMatch(/execute_sql/i);
}

function conformanceConfig(): RuntimeConfig {
  return {
    version: 1,
    mode: "shadow",
    result_format: 2,
    model_output: { authority_metadata: "exact" },
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
      analyticalCapability(),
      readCapability(),
      proposalCapability(),
    ],
  };
}

const baseCapability = {
  source: "local_postgres",
  target: {
    schema: "public",
    table: "incidents",
    primary_key: "id",
    tenant_key: "tenant_id",
    principal_scope_key: "assigned_to",
  },
  args: {
    incident_id: { type: "string" as const, required: true, max_length: 64 },
  },
  lookup: { id_from_arg: "incident_id" },
  contract_provenance: { digest: contractDigest, version: "1.0.0" },
};

function analyticalCapability(): NonNullable<RuntimeConfig["capabilities"]>[number] {
  return {
    ...baseCapability,
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

function readCapability(): NonNullable<RuntimeConfig["capabilities"]>[number] {
  return {
    ...baseCapability,
    name: "operations.inspect_incident",
    kind: "read",
    visible_columns: ["id", "status", "severity", "version"],
    kept_out_fields: ["customer_email", "internal_notes"],
    max_rows: 1,
  };
}

function proposalCapability(): NonNullable<RuntimeConfig["capabilities"]>[number] {
  return {
    ...baseCapability,
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

async function conformanceReadRow({ capability }: {
  capability: NonNullable<RuntimeConfig["capabilities"]>[number];
}) {
  if (capability.kind === "aggregate_read") {
    return {
      row: { aggregate_value: 8, group_size: 8 },
      rowCount: 1,
    };
  }
  return {
    row: {
      id: "INC-100",
      tenant_id: "tenant-acme",
      assigned_to: "operator-1",
      status: "open",
      severity: "high",
      version: 3,
    },
    rowCount: 1,
  };
}
