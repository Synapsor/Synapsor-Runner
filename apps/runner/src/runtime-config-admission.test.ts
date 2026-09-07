import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withRuntimeConfigAdmission } from "./cli-project.js";
import { applyProposal } from "./guarded-apply.js";
import { authorizeConfiguredJobApply } from "./guarded-apply.js";
import { apply } from "./apply-commands.js";
import * as jobInput from "./config-templates.js";
import { resolveSqlWriteDatabaseUrl, verifyLocalWritebackAuthority } from "./writeback-execution.js";
import { parseWritebackJob } from "@synapsor-runner/protocol";
import { withProjectRuntimeCutover } from "./project-runtime-admission.js";

const roots: string[] = [];
async function project() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-config-admission-")); roots.push(root);
  const config: RuntimeConfig = { version: 1, mode: "review", capabilities: [],
    trusted_context: { provider: "environment" }, action_rules: { project_root: root },
    sources: { local_postgres: { engine: "postgres", read_only: true, read_url_env: "READER_URL" } },
    storage: { sqlite_path: "./.synapsor/local.db" } };
  const file = path.join(root, "synapsor.runner.json");
  await fs.writeFile(file, JSON.stringify(config));
  return { root, config, file };
}
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("runtime configuration admission", () => {
  it("reloads the configuration after waiting and holds admission through work and failure", async () => {
    const { root, file, config } = await project(), seen = vi.fn(async (value: RuntimeConfig) => {
      expect(value.mode).toBe("shadow");
      await expect(withProjectRuntimeCutover(root, async () => undefined, { waitMs: 30 }))
        .rejects.toHaveProperty("code", "POLICY_RUNTIME_BUSY");
      throw new Error("operation refused");
    });
    let running!: Promise<void>;
    await withProjectRuntimeCutover(root, async () => {
      running = withRuntimeConfigAdmission(file, seen);
      await delay(60); expect(seen).not.toHaveBeenCalled();
      await fs.writeFile(file, JSON.stringify({ ...config, mode: "shadow" }));
    });
    await expect(running).rejects.toThrow("operation refused");
    expect(seen).toHaveBeenCalledOnce();
    await withProjectRuntimeCutover(root, async () => undefined);
  });

  it("refuses rerouting to a different project while waiting", async () => {
    const first = await project(), second = await project(), seen = vi.fn(async () => undefined);
    let result!: Promise<void>;
    await withProjectRuntimeCutover(first.root, async () => {
      result = withRuntimeConfigAdmission(first.file, seen);
      await delay(60); expect(seen).not.toHaveBeenCalled();
      await fs.writeFile(first.file, JSON.stringify({ ...first.config, action_rules: { project_root: second.root } }));
    });
    await expect(result).rejects.toHaveProperty("code", "POLICY_RUNTIME_PROJECT_CHANGED");
    expect(seen).not.toHaveBeenCalled();
  });

  it("refuses different Read and Action projects instead of silently rebinding one", async () => {
    const first = await project(), second = await project(), seen = vi.fn(async () => undefined);
    await fs.writeFile(first.file, JSON.stringify({ ...first.config,
      production_explore: { project_root: second.root } }));
    await expect(withRuntimeConfigAdmission(first.file, seen)).rejects.toHaveProperty("code", "POLICY_RUNTIME_PROJECT_CHANGED");
    expect(seen).not.toHaveBeenCalled();
  });

  it("accepts a canonical alias and rejects a retargeted alias before work", async () => {
    const first = await project(), second = await project(), alias = path.join(second.root, "project");
    await fs.symlink(first.root, alias);
    await fs.writeFile(first.file, JSON.stringify({ ...first.config, action_rules: { project_root: alias } }));
    await expect(withRuntimeConfigAdmission(first.file, async (config, root) => {
      expect(config.action_rules!.project_root).toBe(first.root); return root;
    })).resolves.toBe(first.root);
    let result!: Promise<void>;
    await withProjectRuntimeCutover(first.root, async () => {
      result = withRuntimeConfigAdmission(first.file, async () => { throw new Error("must not run"); });
      await delay(60); await fs.unlink(alias); await fs.symlink(second.root, alias);
    });
    await expect(result).rejects.toHaveProperty("code", "POLICY_RUNTIME_PROJECT_CHANGED");
  });

  it("makes guarded apply wait before opening or mutating its proposal ledger", async () => {
    const { root, file } = await project(), store = path.join(root, ".synapsor/local.db");
    let applying!: Promise<unknown>;
    await withProjectRuntimeCutover(root, async () => {
      applying = applyProposal(["--config", file, "--store", store, "--dry-run"], "missing")
        .then((result) => result, (error: unknown) => error);
      await delay(60);
      await expect(fs.stat(store)).rejects.toHaveProperty("code", "ENOENT");
    });
    const result = await applying;
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toMatch(/not found|not present|does not exist|unknown proposal/i);
    await withProjectRuntimeCutover(root, async () => undefined);
  });

  it.each([false, true])("admits job-file apply before consuming input (project changed: %s)", async (change) => {
    const first = await project(), second = await project();
    const read = vi.spyOn(jobInput, "readJob").mockImplementation(async () => { throw new Error("job input reached"); });
    let running!: Promise<unknown>;
    await withProjectRuntimeCutover(first.root, async () => {
      running = apply(["--config", first.file, "--job", "unused.json", "--dry-run"])
        .then((value) => value, (error: unknown) => error);
      await delay(60); expect(read).not.toHaveBeenCalled();
      if (change) await fs.writeFile(first.file, JSON.stringify({ ...first.config, action_rules: { project_root: second.root } }));
    });
    const result = await running;
    if (change) {
      expect(result).toHaveProperty("code", "POLICY_RUNTIME_PROJECT_CHANGED");
      expect(read).not.toHaveBeenCalled();
    } else {
      expect(result).toHaveProperty("message", "job input reached");
      expect(read).toHaveBeenCalledOnce();
    }
    await withProjectRuntimeCutover(first.root, async () => undefined);
  });

  it("keeps validation, operator authorization and credential routing on the admitted configuration", async () => {
    const { root, config } = await project();
    const raw = JSON.parse(await fs.readFile("fixtures/protocol/writeback-job.update.v2.json", "utf8"));
    raw.lease.expires_at = new Date(Date.now() + 60_000).toISOString();
    const job = parseWritebackJob(raw);
    config.sources = { [job.source_id]: { engine: "postgres", read_url_env: "READER", write_url_env: "WRITER" } };
    const missingConfigFile = path.join(root, "must-not-be-loaded.json");
    await expect(resolveSqlWriteDatabaseUrl(job, missingConfigFile, { WRITER: "reviewed-writer" }, config)).resolves.toBe("reviewed-writer");
    await expect(authorizeConfiguredJobApply([], job, missingConfigFile, undefined, config)).resolves.toBeUndefined();
    await expect(verifyLocalWritebackAuthority(job, missingConfigFile, undefined, { config }))
      .rejects.toThrow("does not match any reviewed proposal capability");
  });

  it("does not switch configured authority after an asynchronous job input arrives", async () => {
    const first = await project(), second = await project();
    const raw = JSON.parse(await fs.readFile("fixtures/protocol/writeback-job.update.v2.json", "utf8"));
    raw.lease.expires_at = new Date(Date.now() + 60_000).toISOString();
    const job = parseWritebackJob(raw);
    first.config.sources = { [job.source_id]: { engine: "postgres", read_url_env: "READER" } };
    await fs.writeFile(first.file, JSON.stringify(first.config));
    vi.spyOn(jobInput, "readJob").mockImplementation(async () => {
      await fs.writeFile(first.file, JSON.stringify(second.config));
      await expect(withProjectRuntimeCutover(first.root, async () => undefined, { waitMs: 0 }))
        .rejects.toHaveProperty("code", "POLICY_RUNTIME_BUSY");
      return raw;
    });
    await expect(apply(["--config", first.file, "--job", "unused.json", "--dry-run"]))
      .rejects.toThrow("does not match any reviewed proposal capability");
    await withProjectRuntimeCutover(first.root, async () => undefined);
  });
});
