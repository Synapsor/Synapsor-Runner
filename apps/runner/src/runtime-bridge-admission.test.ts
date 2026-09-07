import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { migrateSharedPostgresRuntimeStore, ProposalStore } from "@synapsor-runner/proposal-store";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withSharedPostgresRuntimeStoreBridge, withSharedPostgresRuntimeStoreReadBridge, withSharedPostgresLedgerMirror } from "./store-shared.js";
import { withProjectRuntimeCutover } from "./project-runtime-admission.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe.skipIf(!process.env.SYNAPSOR_TEST_POSTGRES_URL)("local admission around actual PostgreSQL ledger bridges", () => {
  it.each(["write", "read", "mirror"])("holds admission through %s bridge work and cleanup", async (mode) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-bridge-admission-")); roots.push(root);
    const schema = `admission_${randomBytes(8).toString("hex")}`;
    const pool = new Pool({ connectionString: process.env.SYNAPSOR_TEST_POSTGRES_URL });
    let bridgePath = "", cleanupStarted!: () => void, releaseCleanup!: () => void;
    const cleanupReady = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const cleanupHold = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const originalRm = fs.rm;
    const callback = vi.fn(async (storePath: string) => {
      bridgePath = storePath;
      await expect(withProjectRuntimeCutover(root, async () => undefined, { waitMs: 40 }))
        .rejects.toHaveProperty("code", "POLICY_RUNTIME_BUSY");
      const store = new ProposalStore(storePath);
      try { if (mode !== "read") store.setRunnerState("admission-test", { complete: true }); }
      finally { store.close(); }
      if (mode !== "mirror") vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        if (String(target) === path.dirname(storePath)) { cleanupStarted(); await cleanupHold; }
        return originalRm(target, options);
      });
      throw new Error("expected callback refusal");
    });
    const config = { version: 1, mode: "review", capabilities: [], action_rules: { project_root: root },
      storage: { sqlite_path: path.join(root, "local.db"), shared_postgres: {
        mode: "runtime_store", url_env: "SYNAPSOR_TEST_POSTGRES_URL", schema,
      } } } as RuntimeConfig;
    const args = ["--config", path.join(root, "synapsor.runner.json")];
    let running: Promise<unknown> | undefined;
    try {
      await migrateSharedPostgresRuntimeStore(pool, schema);
      await withProjectRuntimeCutover(root, async () => {
        running = (mode === "write" ? withSharedPostgresRuntimeStoreBridge(args, config, "admission test", callback)
          : mode === "read" ? withSharedPostgresRuntimeStoreReadBridge(args, config, "admission test", callback)
            : withSharedPostgresLedgerMirror(args, config.storage!.sqlite_path!, "admission test", () => callback(config.storage!.sqlite_path!), config))
          .then((value) => value, (error: unknown) => error);
        await delay(60); expect(callback).not.toHaveBeenCalled();
      });
      if (mode !== "mirror") {
        await Promise.race([cleanupReady, running!.then((value) => { throw value; })]);
        await expect(withProjectRuntimeCutover(root, async () => undefined, { waitMs: 40 }))
          .rejects.toHaveProperty("code", "POLICY_RUNTIME_BUSY");
        releaseCleanup();
      }
      expect(await running).toHaveProperty("message", "expected callback refusal");
      expect(callback).toHaveBeenCalledOnce();
      await withProjectRuntimeCutover(root, async () => undefined);
      if (mode !== "mirror") await expect(fs.stat(path.dirname(bridgePath))).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      releaseCleanup(); await running; vi.restoreAllMocks();
      try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      finally { await pool.end(); }
    }
  });
});
