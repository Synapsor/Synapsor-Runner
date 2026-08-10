import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createPool: vi.fn(),
  getConnection: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  destroy: vi.fn(),
  end: vi.fn(),
}));

vi.mock("mysql2/promise", () => ({
  default: { createPool: mocks.createPool },
}));

import { createScopedExploreDatabaseExecutor } from "./scoped-explore.js";

describe("Scoped Explore MySQL executor session state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createPool.mockReturnValue({
      getConnection: mocks.getConnection,
      end: mocks.end,
    });
    mocks.getConnection.mockResolvedValue({
      query: mocks.query,
      release: mocks.release,
      destroy: mocks.destroy,
    });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === "SELECT @@SESSION.time_zone AS time_zone") {
        return [[{ time_zone: "SYSTEM" }], []];
      }
      if (sql === "SELECT 1 AS value") return [[{ value: 1 }], []];
      return [[], []];
    });
  });

  it("restores the pooled session timezone before a legacy boundary reuses the connection", async () => {
    const executor = createScopedExploreDatabaseExecutor({
      engine: "mysql",
      databaseUrl: "mysql://reader:secret@example.test/app",
    });
    const context = { tenant: "acme", principal: "rep-1" };

    await expect(executor.execute({
      sql: "SELECT 1 AS value",
      params: [],
      resources: [],
      reporting_timezone: "UTC",
      context,
      timeoutMs: 1000,
    })).resolves.toEqual([{ value: 1 }]);

    expect(mocks.query.mock.calls.map(([sql, params]) => [sql, params])).toEqual([
      ["SELECT @@SESSION.time_zone AS time_zone", undefined],
      ["SET SESSION time_zone = ?", ["+00:00"]],
      ["SET TRANSACTION ISOLATION LEVEL REPEATABLE READ", undefined],
      ["SET TRANSACTION READ ONLY", undefined],
      ["START TRANSACTION READ ONLY", undefined],
      ["SET SESSION max_execution_time = ?", [1000]],
      ["SELECT 1 AS value", []],
      ["COMMIT", undefined],
      ["SET SESSION time_zone = ?", ["SYSTEM"]],
    ]);
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.destroy).not.toHaveBeenCalled();

    mocks.query.mockClear();
    mocks.release.mockClear();
    await executor.execute({
      sql: "SELECT 1 AS value",
      params: [],
      resources: [],
      context,
      timeoutMs: 1000,
    });
    expect(mocks.query.mock.calls.map(([sql]) => sql)).not.toContain(
      "SELECT @@SESSION.time_zone AS time_zone",
    );
    expect(mocks.query.mock.calls.filter(([sql]) => sql === "SET SESSION time_zone = ?"))
      .toHaveLength(0);
    expect(mocks.release).toHaveBeenCalledOnce();

    await executor.close();
    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("borrows schema inspections from the same bounded pool as reviewed queries", async () => {
    const inspection = { engine: "mysql", tables: [] };
    const inspectDatabaseWithConnectionFn = vi.fn(async () => inspection);
    const executor = createScopedExploreDatabaseExecutor({
      engine: "mysql",
      databaseUrl: "mysql://reader:secret@example.test/app",
      maxConnections: 2,
    }, { inspectDatabaseWithConnectionFn: inspectDatabaseWithConnectionFn as never });

    await expect(executor.inspectDatabase?.({
      engine: "mysql",
      databaseUrlEnv: "DATABASE_URL",
      env: { DATABASE_URL: "mysql://reader:secret@example.test/app" },
    })).resolves.toBe(inspection);

    expect(mocks.createPool).toHaveBeenCalledWith(expect.objectContaining({
      connectionLimit: 2,
    }));
    expect(mocks.getConnection).toHaveBeenCalledOnce();
    expect(inspectDatabaseWithConnectionFn).toHaveBeenCalledWith(
      expect.objectContaining({ engine: "mysql" }),
      expect.objectContaining({
        engine: "mysql",
        connection: expect.objectContaining({ query: mocks.query }),
      }),
    );
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(mocks.query).not.toHaveBeenCalled();

    await executor.close();
  });

  it("destroys a connection whose original timezone cannot be restored", async () => {
    let timeZoneAssignments = 0;
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql === "SELECT @@SESSION.time_zone AS time_zone") {
        return [[{ time_zone: "America/Los_Angeles" }], []];
      }
      if (sql === "SET SESSION time_zone = ?" && ++timeZoneAssignments === 2) {
        throw new Error("restore failed");
      }
      if (sql === "SELECT 1 AS value") return [[{ value: 1 }], []];
      return [[], []];
    });
    const executor = createScopedExploreDatabaseExecutor({
      engine: "mysql",
      databaseUrl: "mysql://reader:secret@example.test/app",
    });

    await expect(executor.execute({
      sql: "SELECT 1 AS value",
      params: [],
      resources: [],
      reporting_timezone: "UTC",
      context: { tenant: "acme", principal: "rep-1" },
      timeoutMs: 1000,
    })).rejects.toThrow("restore failed");
    expect(mocks.destroy).toHaveBeenCalledOnce();
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
