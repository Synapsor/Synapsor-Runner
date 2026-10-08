import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createPostgresPool } from "./index.js";
import { observePostgresClientErrors, postgresClientConnectionFailed } from "./connection-lifetime.js";

describe("owned PostgreSQL connection errors", () => {
  it("keeps a checked-out asynchronous failure observable without process termination", async () => {
    const pool = createPostgresPool("postgresql://fixture@localhost/unopened");
    const client = new EventEmitter();
    let observed: unknown;
    pool.emit("connect", client);
    client.on("error", (error) => { observed = error; });
    const failure = new Error("connection ended while awaiting COMMIT");
    expect(postgresClientConnectionFailed(client)).toBe(false);
    expect(() => client.emit("error", failure)).not.toThrow();
    expect(observed).toBe(failure);
    expect(postgresClientConnectionFailed(client)).toBe(true);
    await pool.end();
  });

  it("does not duplicate listeners on repeat checkout and owns idle pool errors", async () => {
    const client = new EventEmitter();
    observePostgresClientErrors(client);
    observePostgresClientErrors(client);
    expect(client.listenerCount("error")).toBe(1);
    const pool = createPostgresPool("postgresql://fixture@localhost/unopened");
    expect(() => pool.emit("error", new Error("idle connection ended"))).not.toThrow();
    await pool.end();
  });
});
