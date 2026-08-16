import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  RuntimeCapabilityConfig,
} from "./runtime-types.js";

const mocks = vi.hoisted(() => ({
  postgresQuery: vi.fn(),
  postgresRelease: vi.fn(),
  postgresEnd: vi.fn(),
  postgresConnect: vi.fn(),
  mysqlQuery: vi.fn(),
  mysqlExecute: vi.fn(),
  mysqlEnd: vi.fn(),
  mysqlCreateConnection: vi.fn(),
}));

vi.mock("@synapsor-runner/postgres", async (importOriginal) => {
  const original = await importOriginal<typeof import("@synapsor-runner/postgres")>();
  return {
    ...original,
    createPostgresPool: () => ({
      connect: mocks.postgresConnect,
      end: mocks.postgresEnd,
    }),
  };
});

vi.mock("mysql2/promise", () => ({
  default: {
    createConnection: mocks.mysqlCreateConnection,
    createPool: vi.fn(),
  },
}));

import {
  readMysqlRow,
  readPostgresRow,
} from "./source-runtime.js";

describe("generated analytical reporting timezone", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.postgresConnect.mockResolvedValue({
      query: mocks.postgresQuery,
      release: mocks.postgresRelease,
    });
    mocks.postgresEnd.mockResolvedValue(undefined);
    mocks.mysqlCreateConnection.mockResolvedValue({
      query: mocks.mysqlQuery,
      execute: mocks.mysqlExecute,
      end: mocks.mysqlEnd,
    });
    mocks.mysqlEnd.mockResolvedValue(undefined);
  });

  it("sets PostgreSQL UTC inside the same read-only transaction", async () => {
    mocks.postgresQuery.mockImplementation(async (sql: string) => {
      if (/^SELECT /i.test(sql)) return { rows: [{ id: "MEM-1", status: "active" }], rowCount: 1 };
      return { rows: [], rowCount: null };
    });
    const result = await readPostgresRow(readerInput("postgres"));
    expect(result).toMatchObject({ rowCount: 1, row: { id: "MEM-1" } });
    expect(mocks.postgresQuery.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN READ ONLY",
      "SET LOCAL TIME ZONE 'UTC'",
      expect.stringMatching(/^SELECT /),
      "COMMIT",
    ]);
    expect(mocks.postgresRelease).toHaveBeenCalledOnce();
    expect(mocks.postgresEnd).toHaveBeenCalledOnce();
  });

  it("sets MySQL UTC before the same read-only transaction", async () => {
    mocks.mysqlQuery.mockResolvedValue([[], []]);
    mocks.mysqlExecute.mockResolvedValue([[{ id: "MEM-1", status: "active" }], []]);
    const result = await readMysqlRow(readerInput("mysql"));
    expect(result).toMatchObject({ rowCount: 1, row: { id: "MEM-1" } });
    expect(mocks.mysqlQuery.mock.calls.map(([sql]) => sql)).toEqual([
      "SET SESSION time_zone = '+00:00'",
      "START TRANSACTION READ ONLY",
      "COMMIT",
    ]);
    expect(mocks.mysqlEnd).toHaveBeenCalledOnce();
  });

  it("closes a PostgreSQL pool when its initial connection fails", async () => {
    mocks.postgresConnect.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(readPostgresRow(readerInput("postgres")))
      .rejects.toThrow("database unavailable");
    expect(mocks.postgresRelease).not.toHaveBeenCalled();
    expect(mocks.postgresEnd).toHaveBeenCalledOnce();
  });

  it("preserves a PostgreSQL query error when pool cleanup also fails", async () => {
    mocks.postgresQuery.mockImplementation(async (sql: string) => {
      if (/^SELECT /i.test(sql)) throw new Error("source query failed");
      return { rows: [], rowCount: null };
    });
    mocks.postgresEnd.mockRejectedValueOnce(new Error("pool cleanup failed"));

    await expect(readPostgresRow(readerInput("postgres")))
      .rejects.toThrow("source query failed");
    expect(mocks.postgresRelease).toHaveBeenCalledOnce();
    expect(mocks.postgresEnd).toHaveBeenCalledOnce();
  });

  it("ends the PostgreSQL pool when client release throws", async () => {
    mocks.postgresQuery.mockImplementation(async (sql: string) => {
      if (/^SELECT /i.test(sql)) return { rows: [{ id: "MEM-1", status: "active" }], rowCount: 1 };
      return { rows: [], rowCount: null };
    });
    mocks.postgresRelease.mockImplementationOnce(() => { throw new Error("release failed"); });

    await expect(readPostgresRow(readerInput("postgres")))
      .rejects.toThrow("release failed");
    expect(mocks.postgresRelease).toHaveBeenCalledOnce();
    expect(mocks.postgresEnd).toHaveBeenCalledOnce();
  });

  it("preserves a MySQL query error when connection cleanup also fails", async () => {
    mocks.mysqlQuery.mockResolvedValue([[], []]);
    mocks.mysqlExecute.mockRejectedValueOnce(new Error("source query failed"));
    mocks.mysqlEnd.mockRejectedValueOnce(new Error("connection cleanup failed"));

    await expect(readMysqlRow(readerInput("mysql")))
      .rejects.toThrow("source query failed");
    expect(mocks.mysqlEnd).toHaveBeenCalledOnce();
  });
});

function readerInput(engine: "postgres" | "mysql") {
  return {
    sourceName: "local_database",
    source: {
      engine,
      read_url_env: "DATABASE_URL",
      read_only: true,
    },
    capability: protectedRowsCapability(),
    args: { member_id: "MEM-1" },
    context: {
      tenant_id: "acme",
      principal: "trainer-1",
      provenance: "environment" as const,
    },
    env: {
      DATABASE_URL: engine === "postgres"
        ? "postgresql://reader:secret@example.test/app"
        : "mysql://reader:secret@example.test/app",
    },
    transaction_mode: "read_only" as const,
    reporting_timezone: "UTC" as const,
  };
}

function protectedRowsCapability(): RuntimeCapabilityConfig {
  return {
    name: "members.inspect_active",
    kind: "read",
    source: "local_database",
    target: {
      schema: "public",
      table: "members",
      primary_key: "id",
      tenant_key: "tenant_id",
      principal_scope_key: "trainer_id",
    },
    args: {
      member_id: { type: "string", required: true },
    },
    lookup: { id_from_arg: "member_id" },
    visible_columns: ["id", "status"],
    protected_read: {
      version: "1",
      mode: "rows",
      boundary_digest: `sha256:${"a".repeat(64)}`,
      generation_lock_fingerprint: `sha256:${"b".repeat(64)}`,
      limits: {
        max_rows: 1,
        max_groups: 1,
        max_response_cells: 10,
        max_response_bytes: 4096,
        statement_timeout_ms: 0,
        max_queries_per_session: 10,
        max_extracted_cells_per_session: 100,
        max_differencing_queries: 2,
        rate_limit_per_minute: 10,
      },
    },
  };
}
