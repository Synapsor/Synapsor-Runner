import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectQualificationStorage, assertQualificationStorageOwned } from "./qualification-storage-preflight.js";

const roots: string[] = [];
const cwd = process.cwd();
afterEach(async () => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-isolation-sentinel-")); roots.push(root);
  const owned = path.join(root, "owned"), original = path.join(root, "original");
  await fs.mkdir(path.join(owned, ".synapsor/control-policy"), { recursive: true });
  await fs.mkdir(original);
  await fs.writeFile(path.join(owned, "synapsor.runner.json"), JSON.stringify({ storage: { sqlite_path: ".synapsor/local.db" } }));
  await fs.writeFile(path.join(original, "local.db"), "SENTINEL - NOT A SQLITE DATABASE");
  process.chdir(owned);
  for (const key of ["SYNAPSOR_LOCAL_STORE", "SYNAPSOR_RUNNER_CONFIG", "SYNAPSOR_MCP_CONFIG"]) vi.stubEnv(key, undefined);
  const mount = { logical: owned, physical: owned };
  const manifest = async (target: unknown) => fs.writeFile(path.join(owned, ".synapsor/control-policy/migration.json"), JSON.stringify({
    schema_version: "synapsor.control-policy-migration/v1", repository_id: randomUUID(), deployment_id: randomUUID(), project_id: randomUUID(),
    target, migration_digest: `sha256:${"a".repeat(64)}`, actor: "sentinel", created_at: new Date().toISOString(),
  }));
  return { owned, original, mount, manifest };
}

describe("qualification storage preflight before writable opens", () => {
  it.each([["start"], ["onboard", "db"], ["synapsor-runner", "start"]])("keeps fresh setup local despite a discoverable parent config: %j", async (...args) => {
    const f = await fixture();
    const child = path.join(f.owned, "fresh");
    await fs.mkdir(child);
    process.chdir(child);
    const inspection = await inspectQualificationStorage(args);
    expect(inspection.config_path).toBe(path.join(child, "synapsor.runner.json"));
    expect(inspection.project_roots).toEqual([child]);
    await assertQualificationStorageOwned({ inspection, mounts: [{ logical: child, physical: child }] });
    expect(await fs.readdir(child)).toEqual([]);
  });
  it("still detects runtime parent discovery before any writable open", async () => {
    const f = await fixture();
    const child = path.join(f.owned, "fresh");
    await fs.mkdir(child);
    process.chdir(child);
    const inspection = await inspectQualificationStorage(["mcp", "serve"]);
    expect(inspection.config_path).toBe(path.join(f.owned, "synapsor.runner.json"));
    await expect(assertQualificationStorageOwned({ inspection, mounts: [{ logical: child, physical: child }] })).rejects.toMatchObject({ code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
    expect(await fs.readdir(child)).toEqual([]);
  });
  it("does not let fresh setup hide an explicit unowned config", async () => {
    const f = await fixture();
    vi.stubEnv("SYNAPSOR_RUNNER_CONFIG", path.join(f.original, "selected.json"));
    await expect(assertQualificationStorageOwned({ inspection: await inspectQualificationStorage(["start"]), mounts: [f.mount] })).rejects.toMatchObject({ code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
  });
  it("finds the absolute governed locator even when public config selects a copied local store", async () => {
    const f = await fixture(), target = path.join(f.original, "local.db");
    await f.manifest({ kind: "sqlite", path: target });
    const inspection = await inspectQualificationStorage([]);
    expect(inspection.destinations).toContainEqual(expect.objectContaining({ kind: "sqlite", path: target }));
    await expect(assertQualificationStorageOwned({ inspection, mounts: [f.mount] })).rejects.toMatchObject({ code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
    expect(await fs.readFile(target, "utf8")).toBe("SENTINEL - NOT A SQLITE DATABASE");
    expect(await fs.readdir(f.original)).toEqual(["local.db"]);
  });
  it("does not create a missing store, authority lock or SQLite companion while checking owned defaults", async () => {
    const f = await fixture();
    const inspection = await inspectQualificationStorage([]);
    await assertQualificationStorageOwned({ inspection, mounts: [f.mount] });
    expect(await fs.readdir(path.join(f.owned, ".synapsor"))).toEqual(["control-policy"]);
  });
  it.each(["--store", "SYNAPSOR_LOCAL_STORE"])("checks %s overrides through the actual CLI selector", async kind => {
    const f = await fixture(), target = path.join(f.original, "local.db");
    const args = kind === "--store" ? ["--store", target] : [];
    if (!args.length) vi.stubEnv(kind, target);
    const inspection = await inspectQualificationStorage(args);
    expect(inspection.destinations.some(value => value.kind === "sqlite" && value.path === target)).toBe(true);
    await expect(assertQualificationStorageOwned({ inspection, mounts: [f.mount] })).rejects.toMatchObject({ code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
  });
  it.each(["--config", "SYNAPSOR_RUNNER_CONFIG", "SYNAPSOR_MCP_CONFIG"])("checks %s config selection without opening its store", async key => {
    const f = await fixture(), config = path.join(f.original, "selected.json");
    await fs.writeFile(config, JSON.stringify({ storage: { sqlite_path: "local.db" } }));
    const args = key === "--config" ? ["--config", config] : [];
    if (!args.length) vi.stubEnv(key, config);
    const inspection = await inspectQualificationStorage(args);
    expect(inspection.config_path).toBe(config);
    await expect(assertQualificationStorageOwned({ inspection, mounts: [f.mount] })).rejects.toMatchObject({ code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
  });
  it("refuses symlink aliases and hard links to an unowned store", async () => {
    const f = await fixture(), alias = path.join(f.owned, "alias.db"), target = path.join(f.original, "local.db");
    await fs.symlink(target, alias);
    await expect(assertQualificationStorageOwned({ inspection: await inspectQualificationStorage(["--store", alias]), mounts: [f.mount] })).rejects.toMatchObject({ code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
    await fs.unlink(alias); await fs.link(target, alias);
    await expect(assertQualificationStorageOwned({ inspection: await inspectQualificationStorage(["--store", alias]), mounts: [f.mount] })).rejects.toMatchObject({ code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
  });
  it("refuses an escaped companion even when the main ledger is owned", async () => {
    const f = await fixture();
    await fs.symlink(path.join(f.original, "local.db"), path.join(f.owned, ".synapsor/local.db-wal"));
    await expect(assertQualificationStorageOwned({ inspection: await inspectQualificationStorage([]), mounts: [f.mount] })).rejects.toMatchObject({ code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
  });
  it("refuses a dangling symlink into an unowned directory before it can become writable", async () => {
    const f = await fixture(), alias = path.join(f.owned, "dangling.db");
    await fs.symlink(path.join(f.original, "not-created.db"), alias);
    await expect(assertQualificationStorageOwned({ inspection: await inspectQualificationStorage(["--store", alias]), mounts: [f.mount] })).rejects.toMatchObject({ code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
    expect(await fs.readdir(f.original)).toEqual(["local.db"]);
  });
  it("requires physical mount identity, not two directories with the same layout", async () => {
    const f = await fixture();
    await expect(assertQualificationStorageOwned({ inspection: await inspectQualificationStorage([]), mounts: [{ logical: f.owned, physical: f.original }] })).rejects.toMatchObject({ code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
  });
  it("finds shared bound and mirror destinations and refuses unknown endpoint credentials", async () => {
    const f = await fixture();
    await f.manifest({ kind: "postgres", url_env: "BOUND_STORE", schema: "authority" });
    await fs.writeFile(path.join(f.owned, "synapsor.runner.json"), JSON.stringify({ storage: { sqlite_path: ".synapsor/local.db", shared_postgres: { mode: "mirror", url_env: "MIRROR_STORE", schema: "audit" } } }));
    const inspection = await inspectQualificationStorage([]);
    expect(inspection.destinations.filter(item => item.kind === "postgres")).toEqual([
      expect.objectContaining({ url_env: "BOUND_STORE", schema: "authority" }),
      expect.objectContaining({ url_env: "MIRROR_STORE", schema: "audit" }),
    ]);
    await expect(assertQualificationStorageOwned({ inspection, mounts: [f.mount], env: { BOUND_STORE: "postgres://sentinel/one", MIRROR_STORE: "postgres://sentinel/two" }, ownedPostgresUrls: ["postgres://sentinel/one"] })).rejects.toMatchObject({ code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
    await assertQualificationStorageOwned({ inspection, mounts: [f.mount], env: { BOUND_STORE: "postgres://sentinel/one", MIRROR_STORE: "postgres://sentinel/two" }, ownedPostgresUrls: ["postgres://sentinel/one", "postgres://sentinel/two"] });
  });
  it("checks a separate Action project root and malformed migration records fail closed", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.owned, "synapsor.runner.json"), JSON.stringify({ action_rules: { project_root: f.original }, storage: { sqlite_path: ".synapsor/local.db" } }));
    await expect(assertQualificationStorageOwned({ inspection: await inspectQualificationStorage([]), mounts: [f.mount] })).rejects.toMatchObject({ code: "QUALIFICATION_STORAGE_NOT_ISOLATED" });
    await fs.writeFile(path.join(f.owned, ".synapsor/control-policy/migration.json"), "{}");
    await expect(inspectQualificationStorage([])).rejects.toMatchObject({ code: "POLICY_MIGRATION_RECORD_INVALID" });
  });
});
