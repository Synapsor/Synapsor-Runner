import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  writeAutoBoundaryArtifacts,
} from "../apps/runner/dist/auto-boundary.js";
import { createScopedExploreMcpServer } from "../apps/runner/dist/authoring-mcp.js";

const TABLE_COUNT = 40;
const ACTIVE_PACK_SIZE = 3;
const MAX_TOOLS_LIST_BYTES = 8_000;
const MAX_ESTIMATED_TOKENS = 2_000;
const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-auto-boundary-scale-"));

try {
  const inspection = largeInspection();
  const project = {
    root: projectRoot,
    package_manager: "pnpm",
    frameworks: ["nextjs", "prisma"],
    schema_inputs: [{ kind: "prisma", path: "prisma/schema.prisma" }],
    database_env_names: ["DATABASE_URL"],
  };
  const first = buildAutoBoundary({ inspection, project, sourceEnv: "DATABASE_URL" });
  const reversed = buildAutoBoundary({
    inspection: { ...inspection, tables: [...inspection.tables].reverse() },
    project,
    sourceEnv: "DATABASE_URL",
  });
  assert(first.graph.resources.length === TABLE_COUNT, "Auto Boundary did not compile the entire 40-table schema.");
  assert(first.contract_digest === reversed.contract_digest, "Whole-schema output depends on catalog row order.");
  assert(first.dsl === reversed.dsl, "Whole-schema DSL depends on catalog row order.");
  assert(first.exploration_boundary.pack.resources.length === TABLE_COUNT, "Candidate catalog omitted reviewed resources.");
  await writeAutoBoundaryArtifacts({ projectRoot, build: first });

  const candidate = structuredClone(first.exploration_boundary);
  candidate.pack.name = "support_operations";
  candidate.pack.resources = candidate.pack.resources.slice(0, ACTIVE_PACK_SIZE);
  const digest = explorationBoundaryCandidateDigest(candidate);
  const boundary = await activateExplorationBoundary({
    projectRoot,
    candidate,
    expectedDigest: digest,
    actor: "scale-verifier",
    confirmation: `ACTIVATE ${digest}`,
    confirmedDecisions: candidate.unresolved_decisions,
    currentInspection: inspection,
  });

  const runtime = {
    boundary,
    session_fingerprint: "sha256:scale-verifier",
    describe: (request = {}) => {
      const cursor = request.cursor ?? 0;
      const limit = Math.min(request.limit ?? 2, 10);
      const resources = request.resource
        ? boundary.pack.resources.filter((resource) => resource.id === request.resource)
        : boundary.pack.resources.slice(cursor, cursor + limit);
      return {
        ok: true,
        resources: resources.map((resource) => ({ id: resource.id })),
        next_cursor: request.resource || cursor + resources.length >= boundary.pack.resources.length
          ? null
          : cursor + resources.length,
      };
    },
    explore: async () => ({ ok: true, source_database_changed: false }),
    close: async () => undefined,
  };
  const server = createScopedExploreMcpServer(runtime);
  const client = new Client({ name: "auto-boundary-scale-verifier", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    const serialized = JSON.stringify(tools.tools);
    const bytes = Buffer.byteLength(serialized, "utf8");
    const estimatedTokens = Math.ceil(bytes / 4);
    assert(tools.tools.length === 2, "Scaled authoring surface exposed more than two model tools.");
    assert(bytes <= MAX_TOOLS_LIST_BYTES, `tools/list ${bytes} bytes exceeds ${MAX_TOOLS_LIST_BYTES}.`);
    assert(estimatedTokens <= MAX_ESTIMATED_TOKENS, `tools/list estimate ${estimatedTokens} exceeds ${MAX_ESTIMATED_TOKENS}.`);
    for (const resource of boundary.pack.resources) {
      assert(serialized.includes(resource.id), `Activated resource ${resource.id} is absent from tools/list.`);
    }
    for (const resource of first.exploration_boundary.pack.resources.slice(ACTIVE_PACK_SIZE)) {
      assert(!serialized.includes(resource.id), `Unactivated catalog resource ${resource.id} leaked into tools/list.`);
    }
    const firstPage = await client.callTool({
      name: "app.describe_data",
      arguments: { cursor: 0, limit: 2 },
    });
    const payload = firstPage.structuredContent;
    assert(Array.isArray(payload?.resources) && payload.resources.length === 2 && payload.next_cursor === 2,
      "app.describe_data is not bounded and paginated.", payload);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      schema_tables: TABLE_COUNT,
      generated_candidates: first.exploration_boundary.pack.resources.length,
      activated_resources: ACTIVE_PACK_SIZE,
      model_tools: tools.tools.map((tool) => tool.name),
      tools_list_bytes: bytes,
      estimated_tools_list_tokens: estimatedTokens,
      byte_budget: MAX_TOOLS_LIST_BYTES,
      estimated_token_budget: MAX_ESTIMATED_TOKENS,
    }, null, 2)}\n`);
  } finally {
    await client.close().catch(() => undefined);
    await server.close().catch(() => undefined);
  }
} finally {
  await fs.rm(projectRoot, { recursive: true, force: true });
}

function largeInspection() {
  return {
    engine: "postgres",
    server_version: "PostgreSQL 16 scale fixture",
    current_user: "app_reader",
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: false,
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    },
    inspected_at: "2026-07-22T00:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    tables: Array.from({ length: TABLE_COUNT }, (_unused, index) => {
      const suffix = String(index + 1).padStart(2, "0");
      return {
        schema: "public",
        name: `entity_${suffix}`,
        type: "table",
        writable: false,
        columns: [
          column("id", "uuid", { immutable: true }),
          column("tenant_id", "uuid", { tenant: true, immutable: true }),
          column("status", "text"),
          column("created_at", "timestamp with time zone"),
          column("amount_cents", "integer"),
          column("secret_token", "text", { sensitive: true }),
        ],
        primary_key: ["id"],
        unique_constraints: [{ name: `entity_${suffix}_pkey`, columns: ["id"] }],
        check_constraints: [{ name: `entity_${suffix}_amount_check`, definition: "CHECK (amount_cents >= 0)" }],
        foreign_keys: [],
        indexes: [{ name: `entity_${suffix}_pkey`, columns: ["id"], unique: true }],
        row_level_security: true,
        row_level_security_policies: [{
          name: `entity_${suffix}_tenant_read`,
          command: "SELECT",
          permissive: true,
          roles: ["app_reader"],
          using_expression: "(tenant_id = current_setting('app.tenant_id')::uuid)",
        }],
        role_posture: {
          owner: "app_owner",
          current_role_is_owner: false,
          current_role_can_assume_owner: false,
          row_security_forced: true,
          row_security_effective_for_current_role: true,
          privileges: {
            select: true,
            insert: false,
            update: false,
            delete: false,
            truncate: false,
            references: false,
            trigger: false,
          },
        },
        suggestions: {
          tenant_columns: ["tenant_id"],
          conflict_columns: [],
          sensitive_columns: ["secret_token"],
          default_visible_columns: ["id", "tenant_id", "status", "created_at", "amount_cents"],
        },
      };
    }),
  };
}

function column(name, dataType, flags = {}) {
  return {
    name,
    data_type: dataType,
    nullable: false,
    generated: false,
    ordinal_position: 1,
    suggestions: {
      tenant: flags.tenant ?? false,
      conflict: false,
      sensitive: flags.sensitive ?? false,
      immutable: flags.immutable ?? false,
      large_or_binary: false,
    },
  };
}

function assert(condition, message, details) {
  if (condition) return;
  throw new Error(`${message}${details === undefined ? "" : `\n${JSON.stringify(details, null, 2)}`}`);
}
