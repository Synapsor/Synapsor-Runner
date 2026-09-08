import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { ControlPolicyRepository } from "@synapsor-runner/proposal-store";
import * as project from "./cli-project.js";
import * as migration from "./control-policy-project-migration.js";
import * as store from "./control-policy-store.js";
import * as parentReview from "./owner-policy-parent-review.js";
import type { OwnerPolicyReviewIo } from "./owner-policy-review-ui.js";
import { ownerPolicyCommand } from "./owner-policy-commands.js";

const config: RuntimeConfig = { version: 1, mode: "read_only", sources: { source: { engine: "postgres", read_url_env: "UNUSED_SOURCE_URL" } },
  capabilities: [], trusted_context: { provider: "environment" } };
const roots: string[] = [];
beforeEach(() => { vi.spyOn(project, "readRuntimeConfig").mockResolvedValue(config); });
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
function ui(answers: Array<string | undefined>, width = 80) {
  const output: string[] = [];
  const io: OwnerPolicyReviewIo = { read: async () => answers.shift(), write: (text) => output.push(text), columns: () => width,
    choose: vi.fn(async () => answers.shift()), review: vi.fn(async () => {}), isTerminal: () => false };
  return { io, output };
}
function preview() {
  return vi.spyOn(migration, "previewProjectControlPolicyMigration").mockResolvedValue({ status: "ready", epoch: 0,
    migration_digest: `sha256:${"a".repeat(64)}`, snapshot: { revisions: [], active: [], drafts: [], provenance: [] } });
}

describe("optional local owner-delegation operator commands", () => {
  it.each([undefined, "", "cancel"])("leaves storage unchanged on a declined decision (%s)", async (answer) => {
    preview();
    const migrate = vi.spyOn(migration, "migrateProjectControlPoliciesFromProject");
    const { io, output } = ui([answer]);
    expect(await ownerPolicyCommand(["storage", "--project-root", "/test-project"], { io })).toBe(0);
    expect(migrate).not.toHaveBeenCalled();
    expect(output.join("")).toContain("Configuration left unchanged");
    expect(io.choose).toHaveBeenCalledWith(expect.objectContaining({ initialValue: "cancel" }));
  });

  it("keeps exact details on the same immutable preview and uses the configured destination", async () => {
    const inspect = preview(), close = vi.fn(async () => {});
    const migrate = vi.spyOn(migration, "migrateProjectControlPoliciesFromProject").mockResolvedValue({ status: "imported", binding: { close } } as any);
    const { io, output } = ui(["details", "confirm"], 52);
    const env = {};
    await ownerPolicyCommand(["storage", "--project-root", "/test-project", "--store", "/control/exact.db"], { io, env });
    expect(inspect).toHaveBeenCalledOnce();
    expect(inspect).toHaveBeenCalledWith(expect.objectContaining({ storePath: "/control/exact.db", env }));
    expect(io.review).toHaveBeenCalledOnce();
    expect(migrate).toHaveBeenCalledWith(expect.objectContaining({ storePath: "/control/exact.db", preview: await inspect.mock.results[0]!.value }));
    expect(close).toHaveBeenCalledOnce();
    expect(output.join("").split("\n").every((line) => line.length <= 52)).toBe(true);
  });

  it("invalidates consent when configuration changes during review", async () => {
    preview();
    vi.mocked(project.readRuntimeConfig).mockResolvedValueOnce(config).mockResolvedValueOnce({ ...config, sources: { other: { engine: "postgres", read_url_env: "OTHER_URL" } } });
    const migrate = vi.spyOn(migration, "migrateProjectControlPoliciesFromProject");
    await expect(ownerPolicyCommand(["storage"], { io: ui(["confirm"]).io })).rejects.toThrow("configuration changed");
    expect(migrate).not.toHaveBeenCalled();
  });

  it("recovers only the already-reviewed frozen migration rather than inventing new consent", async () => {
    vi.spyOn(migration, "previewProjectControlPolicyMigration").mockResolvedValue({ status: "migration_pending", epoch: 0 });
    const close = vi.fn(async () => {});
    const migrate = vi.spyOn(migration, "migrateProjectControlPoliciesFromProject").mockResolvedValue({ status: "already_imported", binding: { close } } as any);
    const { io, output } = ui([]);
    await ownerPolicyCommand(["storage"], { io });
    expect(migrate).toHaveBeenCalledWith(expect.objectContaining({ preview: { status: "migration_pending", epoch: 0 } }));
    expect(io.choose).not.toHaveBeenCalled();
    expect(output.join("")).toContain("Previously reviewed");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not print control-store connection secrets", async () => {
    preview();
    vi.mocked(project.readRuntimeConfig).mockResolvedValue({ ...config, storage: { shared_postgres: { mode: "runtime_store", url_env: "CONTROL_URL" } } });
    const { io, output } = ui(["cancel"]);
    await ownerPolicyCommand(["storage"], { io, env: { CONTROL_URL: "postgresql://secret:password@private/control" } });
    expect(output.join("")).toContain("configured PostgreSQL control store");
    expect(output.join("")).not.toMatch(/password|private\/control/);
  });

  it("recovers a real interrupted migration even though normal config loading cannot admit the runtime", async () => {
    vi.mocked(project.readRuntimeConfig).mockRestore();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-owner-command-recovery-")); roots.push(root);
    const file = path.join(root, "synapsor.runner.json"), storePath = path.join(root, "control.db");
    const selected: RuntimeConfig = { ...config, storage: { sqlite_path: storePath } };
    await fs.writeFile(file, JSON.stringify(selected), { mode: 0o600 });
    const reviewed = await migration.previewProjectControlPolicyMigration({ projectRoot: root, config: selected, storePath });
    const interrupted = vi.spyOn(ControlPolicyRepository.prototype, "importDeployment").mockRejectedValueOnce(new Error("interrupted import"));
    await expect(migration.migrateProjectControlPoliciesFromProject({ projectRoot: root, config: selected, storePath, actor: "local:test", preview: reviewed }))
      .rejects.toThrow("interrupted import");
    interrupted.mockRestore();
    await expect(project.readRuntimeConfig(file)).rejects.toMatchObject({ code: "POLICY_MIGRATION_PENDING" });
    const { io, output } = ui([]);
    await ownerPolicyCommand(["storage", "--config", file], { io });
    expect(io.choose).not.toHaveBeenCalled();
    expect(output.join("")).toContain("Previously reviewed policy-storage migration recovered");
    const binding = await store.openProjectControlPolicies({ projectRoot: root, config: selected, storePath });
    try {
      const state = await binding!.repository.scopeSnapshot({ deployment_id: binding!.deployment_id,
        scope: { level: "operator" }, kinds: ["read", "action", "execution", "parent", "delegation"] });
      expect(state.active).toEqual([]);
      expect(state.epoch).toBe(1);
    } finally { await binding?.close(); }
  }, 20_000);

  it("requires an already-reviewed store for model or exact parent setup; it never migrates implicitly", async () => {
    const { io } = ui([]);
    vi.spyOn(store, "openProjectControlPolicies").mockResolvedValue(undefined);
    await expect(ownerPolicyCommand(["delegation"], { io })).rejects.toThrow("First run policy storage");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-owner-command-")); roots.push(root);
    const file = path.join(root, "parent.json"); await fs.writeFile(file, "{}", { mode: 0o600 });
    const prepare = vi.spyOn(parentReview, "createOperatorParentReview");
    await expect(ownerPolicyCommand(["delegation", "--input", file, "--name", "parent"], { io })).rejects.toThrow("First run policy storage");
    expect(prepare).not.toHaveBeenCalled();
  });
});
