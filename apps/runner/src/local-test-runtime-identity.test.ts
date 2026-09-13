import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_LOCAL_TEST_RUNTIME_IDENTITY_PATH,
  localRuntimeSelectionOption, localClientRuntimePath, localTestRuntimeIdentityContract, listLocalTestRuntimeProfiles, retireLocalTestRuntimeProfile,
  loadLocalTestRuntimeIdentity,
  saveLocalTestRuntimeIdentity,
  withLocalTestRuntimeIdentity,
} from "./local-test-runtime-identity.js";

import { installManagedMcpProjectSet, managedMcpProjectStatus, uninstallManagedMcpProject } from "./managed-mcp-project.js";
import { reviewLocalClientSetup } from "./reviewed-local-client-setup.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("local test runtime identity", () => {
  it("treats an absent optional local runtime directory as no saved identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "runner-local-runtime-absent-"));
    roots.push(root);
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root })).resolves.toBeUndefined();
    await expect(fs.lstat(path.join(root, ".synapsor"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("stores exact reviewed fixture bindings in an owner-only project file and restores the caller environment", async () => {
    const root = await activeProject();
    const stateDirectory = path.join(root, ".synapsor");
    await fs.chmod(stateDirectory, 0o755);
    const saved = await saveLocalTestRuntimeIdentity({
      projectRoot: root,
      bindings: [{ role: "tenant", environment: "FIXTURE_TENANT" }, { role: "principal", environment: "FIXTURE_PERSON" }],
      values: { FIXTURE_TENANT: "tenant-a", FIXTURE_PERSON: "person-a" },
      now: "2026-09-10T18:00:00.000Z",
    });
    expect(saved.path).toBe(path.join(root, DEFAULT_LOCAL_TEST_RUNTIME_IDENTITY_PATH));
    expect(saved.bindings).toEqual([{ role: "principal", environment: "FIXTURE_PERSON" }, { role: "tenant", environment: "FIXTURE_TENANT" }]);
    expect((await fs.lstat(stateDirectory)).mode & 0o777).toBe(0o755);
    expect((await fs.lstat(saved.path)).mode & 0o077).toBe(0);
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root })).resolves.toEqual({ FIXTURE_PERSON: "person-a", FIXTURE_TENANT: "tenant-a" });

    const prior = process.env.FIXTURE_TENANT;
    delete process.env.FIXTURE_TENANT;
    try {
      await withLocalTestRuntimeIdentity({ projectRoot: root }, async () => {
        expect(process.env.FIXTURE_TENANT).toBe("tenant-a");
        expect(process.env.FIXTURE_PERSON).toBe("person-a");
      });
      expect(process.env.FIXTURE_TENANT).toBeUndefined();
      expect(process.env.FIXTURE_PERSON).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env.FIXTURE_TENANT;
      else process.env.FIXTURE_TENANT = prior;
    }
  });

  it("preserves an identity across a privacy/business Read revision but rejects arbitrary paths, broad permissions, unreviewed keys, and changed identity authority", async () => {
    const root = await activeProject();
    const values = { FIXTURE_TENANT: "tenant-a", FIXTURE_PERSON: "person-a" };
    const bindings = [{ role: "tenant" as const, environment: "FIXTURE_TENANT" }, { role: "principal" as const, environment: "FIXTURE_PERSON" }];
    await expect(saveLocalTestRuntimeIdentity({ projectRoot: root, bindings, values, runtimePath: "runtime.json" }))
      .rejects.toThrow("LOCAL_TEST_RUNTIME_PATH_INVALID");
    await saveLocalTestRuntimeIdentity({ projectRoot: root, bindings, values });
    const savedPath = path.join(root, DEFAULT_LOCAL_TEST_RUNTIME_IDENTITY_PATH);
    await fs.chmod(savedPath, 0o644);
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root })).rejects.toThrow("LOCAL_TEST_RUNTIME_PERMISSIONS_INVALID");
    await fs.chmod(savedPath, 0o600);
    const parsed = JSON.parse(await fs.readFile(savedPath, "utf8"));
    parsed.values.UNRELATED = "not-allowed";
    await fs.writeFile(savedPath, JSON.stringify(parsed));
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root })).rejects.toThrow("LOCAL_TEST_RUNTIME_VALUES_INVALID");

    await saveLocalTestRuntimeIdentity({ projectRoot: root, bindings, values });
    await writeActiveAuthority(root, "FIXTURE_TENANT", "FIXTURE_PERSON", "staging", "revised-read-policy", "org-a", ["case_id"]);
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root })).resolves.toEqual(values);
    await writeActiveAuthority(root, "FIXTURE_TENANT", "FIXTURE_PERSON", "staging", "revised-read-policy", "org-b");
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root })).rejects.toThrow("LOCAL_TEST_RUNTIME_BINDING_CHANGED");
    await writeActiveAuthority(root, "FIXTURE_TENANT", "FIXTURE_PERSON", "staging", "revised-read-policy", "org-a");
    await saveLocalTestRuntimeIdentity({ projectRoot: root, bindings, values });
    await writeActiveAuthority(root, "FIXTURE_TENANT", "CHANGED_PERSON");
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root })).rejects.toThrow("LOCAL_TEST_RUNTIME_BINDING_CHANGED");
  });

  it("rejects production authority and a symlink runtime file", async () => {
    const root = await activeProject({ deploymentProfile: "production" });
    const bindings = [{ role: "tenant" as const, environment: "FIXTURE_TENANT" }, { role: "principal" as const, environment: "FIXTURE_PERSON" }];
    await expect(saveLocalTestRuntimeIdentity({ projectRoot: root, bindings,
      values: { FIXTURE_TENANT: "tenant-a", FIXTURE_PERSON: "person-a" } })).rejects.toThrow("LOCAL_TEST_RUNTIME_NOT_ALLOWED");

    const local = await activeProject();
    const target = path.join(local, ".synapsor/runtime-target.json");
    await fs.writeFile(target, "{}", { mode: 0o600 });
    await fs.symlink(target, path.join(local, DEFAULT_LOCAL_TEST_RUNTIME_IDENTITY_PATH));
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: local })).rejects.toThrow("LOCAL_TEST_RUNTIME_PERMISSIONS_INVALID");
  });

  it("refuses credential or process-control binding names, accepts reviewed coded names, and refuses conflicting inherited values", async () => {
    const root = await activeProject();
    await writeActiveAuthority(root, "DATABASE_URL", "FIXTURE_PERSON");
    await expect(saveLocalTestRuntimeIdentity({ projectRoot: root,
      bindings: [{ role: "tenant", environment: "DATABASE_URL" }, { role: "principal", environment: "FIXTURE_PERSON" }],
      values: { DATABASE_URL: "not-a-url", FIXTURE_PERSON: "person-a" } })).rejects.toThrow("LOCAL_TEST_RUNTIME_BINDING_FORBIDDEN");

    await writeActiveAuthority(root, "INSTITUTION_SCOPE", "STUDENT_RECORD");
    await expect(saveLocalTestRuntimeIdentity({ projectRoot: root,
      bindings: [{ role: "tenant", environment: "INSTITUTION_SCOPE" }, { role: "principal", environment: "STUDENT_RECORD" }],
      values: { INSTITUTION_SCOPE: "institution-a", STUDENT_RECORD: "student-a" } })).resolves.toBeDefined();

    await writeActiveAuthority(root, "FIXTURE_TENANT", "FIXTURE_PERSON");
    await saveLocalTestRuntimeIdentity({ projectRoot: root,
      bindings: [{ role: "tenant", environment: "FIXTURE_TENANT" }, { role: "principal", environment: "FIXTURE_PERSON" }],
      values: { FIXTURE_TENANT: "tenant-a", FIXTURE_PERSON: "person-a" } });
    const prior = process.env.FIXTURE_TENANT;
    process.env.FIXTURE_TENANT = "other-tenant";
    try {
      await expect(withLocalTestRuntimeIdentity({ projectRoot: root }, async () => undefined)).rejects.toThrow("LOCAL_TEST_RUNTIME_ENV_CONFLICT");
    } finally {
      if (prior === undefined) delete process.env.FIXTURE_TENANT;
      else process.env.FIXTURE_TENANT = prior;
    }
  });

  it("refuses a writable state directory and an oversized file without changing directory permissions", async () => {
    const root = await activeProject();
    const bindings = [{ role: "tenant" as const, environment: "FIXTURE_TENANT" }, { role: "principal" as const, environment: "FIXTURE_PERSON" }];
    await saveLocalTestRuntimeIdentity({ projectRoot: root, bindings,
      values: { FIXTURE_TENANT: "tenant-a", FIXTURE_PERSON: "person-a" } });
    const stateDirectory = path.join(root, ".synapsor");
    await fs.chmod(stateDirectory, 0o770);
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root })).rejects.toThrow("LOCAL_TEST_RUNTIME_PERMISSIONS_INVALID");
    expect((await fs.lstat(stateDirectory)).mode & 0o777).toBe(0o770);
    await fs.chmod(stateDirectory, 0o700);
    await fs.writeFile(path.join(root, DEFAULT_LOCAL_TEST_RUNTIME_IDENTITY_PATH), "x".repeat(8_193), { mode: 0o600 });
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root })).rejects.toThrow("LOCAL_TEST_RUNTIME_PERMISSIONS_INVALID");
  });
});

const namedBindings = [{ role: "tenant" as const, environment: "FIXTURE_TENANT" }, { role: "principal" as const, environment: "FIXTURE_PERSON" }];
async function named(root: string, profileName: string, person: string, now?: string) {
  return saveLocalTestRuntimeIdentity({ projectRoot: root, profileName, bindings: namedBindings,
    values: { FIXTURE_TENANT: "tenant-a", FIXTURE_PERSON: person },
    expectedProjectBinding: (await localTestRuntimeIdentityContract(root)).project_binding, now });
}

describe("reviewed named local clients", () => {
  it("refuses ambiguous, missing and unparsed launcher selections", () => {
    expect(localRuntimeSelectionOption([], "--local-client")).toBeUndefined();
    expect(localRuntimeSelectionOption(["--local-client", "selected"], "--local-client")).toBe("selected");
    for (const flag of ["--local-client", "--local-test-runtime"] as const) {
      for (const args of [[flag], [flag, "--other"], [`${flag}=value`], [flag, "one", flag, "two"]])
        expect(() => localRuntimeSelectionOption(args, flag)).toThrow("LOCAL_TEST_RUNTIME_REFERENCE_INVALID");
    }
  });

  it("keeps two client entries, the default identity, and one canonical store through concurrent installation and restart", async () => {
    const root = await activeProject();
    const legacy = await saveLocalTestRuntimeIdentity({ projectRoot: root, bindings: namedBindings,
      values: { FIXTURE_TENANT: "legacy", FIXTURE_PERSON: "default" } });
    const before = await fs.readFile(legacy.path, "utf8");
    const [one, two] = await Promise.all([named(root, "client-one", "person-a"), named(root, "client-two", "person-b")]);
    const install = (reference: string) => installManagedMcpProjectSet({ client: "claude-code", projectRoot: root,
      entries: [{ entryKind: "explore", authoring: true, localClient: reference }] });
    await Promise.all([install(one.reference!), install(two.reference!)]);
    const first = await managedMcpProjectStatus("claude-code", root, "explore", one.reference);
    const second = await managedMcpProjectStatus("claude-code", root, "explore", two.reference);
    expect(first.state).toBe("installed"); expect(second.state).toBe("installed");
    expect(first.paths.storeArgument).toBe(second.paths.storeArgument);
    expect(first.paths.configArgument).toBe(second.paths.configArgument);
    expect(first.entry!.args).toContain(localClientRuntimePath(one.reference!));
    expect((first.entry!.args as string[])[(first.entry!.args as string[]).indexOf("--project-root") + 1]).toBe(".");
    expect(second.entry!.args).toContain(localClientRuntimePath(two.reference!));
    const entries = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
    expect(Object.keys(entries.mcpServers)).toHaveLength(2);
    expect(Object.keys(entries.mcpServers).every(name => /^[a-z0-9-]+$/u.test(name))).toBe(true);
    expect(JSON.stringify(entries)).not.toContain("person-a");
    expect(JSON.stringify(entries)).not.toContain("person-b");
    await install(one.reference!);
    expect((await managedMcpProjectStatus("claude-code", root, "explore", two.reference)).entry).toEqual(second.entry);
    for (const [saved, person] of [[one, "person-a"], [two, "person-b"]] as const) {
      const options = { projectRoot: root, runtimePath: localClientRuntimePath(saved.reference!) };
      await expect(loadLocalTestRuntimeIdentity(options)).resolves.toEqual({ FIXTURE_TENANT: "tenant-a", FIXTURE_PERSON: person });
      await expect(loadLocalTestRuntimeIdentity(options)).resolves.toEqual({ FIXTURE_TENANT: "tenant-a", FIXTURE_PERSON: person });
    }
    expect(await fs.readFile(legacy.path, "utf8")).toBe(before);
  });

  it("preserves independent process registry writes to the same project", async () => {
    const root = await activeProject(); const one = await named(root, "process-one", "person-a"), two = await named(root, "process-two", "person-b");
    const moduleUrl = new URL("../dist/managed-mcp-project.js", import.meta.url).href;
    const script = `const {installManagedMcpProjectSet} = await import(process.argv[3]); await installManagedMcpProjectSet({client:'claude-code',projectRoot:process.argv[1],entries:[{entryKind:'explore',authoring:true,localClient:process.argv[2]}]});`;
    await Promise.all([one, two].map(saved => promisify(execFile)(process.execPath,
      ["--input-type=module", "-e", script, root, saved.reference!, moduleUrl], { timeout: 15000 })));
    for (const saved of [one, two]) expect((await managedMcpProjectStatus("claude-code", root, "explore", saved.reference)).state).toBe("installed");
    expect(Object.keys(JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8")).mcpServers)).toHaveLength(2);
  });

  it("does not overwrite a fixed revision in a concurrent duplicate save, and releases coordination after a failed save", async () => {
    const root = await activeProject();
    const results = await Promise.allSettled([named(root, "same", "person-a", "2026-09-13T00:00:00Z"), named(root, "same", "person-a", "2026-09-13T00:00:00Z")]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
    const before = await listLocalTestRuntimeProfiles(root);
    const link = vi.spyOn(fs, "link").mockRejectedValueOnce(new Error("injected atomic save failure"));
    await expect(named(root, "failed", "person-b")).rejects.toThrow("injected atomic save failure"); link.mockRestore();
    expect(await listLocalTestRuntimeProfiles(root)).toEqual(before);
    expect((await fs.readdir(path.join(root, ".synapsor"))).filter(n => n.endsWith(".tmp"))).toEqual([]);
    await expect(named(root, "after-failure", "person-b")).resolves.toHaveProperty("reference");
  });

  it("rolls back a failed registry marker write without losing another named entry", async () => {
    const root = await activeProject(); const one = await named(root, "one", "person-a"), two = await named(root, "two", "person-b");
    const install = (reference: string) => installManagedMcpProjectSet({ client: "claude-code", projectRoot: root,
      entries: [{ entryKind: "explore", authoring: true, localClient: reference }] });
    await install(one.reference!);
    const before = await fs.readFile(path.join(root, ".mcp.json"), "utf8");
    const target = (await managedMcpProjectStatus("claude-code", root, "explore", two.reference)).paths.marker;
    const rename = fs.rename.bind(fs); let failed = false;
    const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (to === target && !failed) { failed = true; throw new Error("injected registry marker failure"); }
      return rename(from, to);
    });
    await expect(install(two.reference!)).rejects.toThrow("injected registry marker failure"); spy.mockRestore();
    expect(failed).toBe(true);
    expect(await fs.readFile(path.join(root, ".mcp.json"), "utf8")).toBe(before);
    expect((await managedMcpProjectStatus("claude-code", root, "explore", one.reference)).state).toBe("installed");
    expect((await managedMcpProjectStatus("claude-code", root, "explore", two.reference)).state).toBe("not_installed");
    await expect(install(two.reference!)).resolves.toBeDefined();
  });

  it("rejects stale, missing, unrelated and changed exact references without default fallback", async () => {
    const root = await activeProject(), unrelated = await activeProject();
    const saved = await named(root, "client", "person-a");
    const runtimePath = localClientRuntimePath(saved.reference!);
    const raw = await fs.readFile(saved.path, "utf8");
    await fs.copyFile(saved.path, path.join(unrelated, runtimePath));
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: unrelated, runtimePath })).rejects.toThrow("LOCAL_TEST_RUNTIME_BINDING_CHANGED");
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root, runtimePath: localClientRuntimePath(`missing.${"a".repeat(64)}`) })).rejects.toThrow("LOCAL_TEST_RUNTIME_REFERENCE_MISSING");
    for (const invalid of ["../local-test-runtime.json", ".synapsor/../.synapsor/local-test-runtime.client.json", "arbitrary.json"]) {
      await expect(loadLocalTestRuntimeIdentity({ projectRoot: root, runtimePath: invalid })).rejects.toThrow("LOCAL_TEST_RUNTIME_PATH_INVALID");
    }
    const changed = JSON.parse(raw); changed.values.FIXTURE_PERSON = "person-b";
    await fs.writeFile(saved.path, JSON.stringify(changed));
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root, runtimePath })).rejects.toThrow("LOCAL_TEST_RUNTIME_REFERENCE_CHANGED");
    await fs.writeFile(saved.path, raw);
    await writeActiveAuthority(root, "FIXTURE_TENANT", "NEW_PERSON");
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root, runtimePath })).rejects.toThrow("LOCAL_TEST_RUNTIME_BINDING_CHANGED");
  });

  it("retains exact old values until explicit retirement, rejects future launches and preserves a running client's context", async () => {
    const root = await activeProject();
    const old = await named(root, "client", "person-a"), replacement = await named(root, "client", "person-b");
    const oldOptions = { projectRoot: root, runtimePath: localClientRuntimePath(old.reference!) };
    await installManagedMcpProjectSet({ client: "claude-code", projectRoot: root,
      entries: [{ entryKind: "explore", authoring: true, localClient: old.reference }] });
    const oldBytes = await fs.readFile(old.path, "utf8");
    await withLocalTestRuntimeIdentity(oldOptions, async () => {
      expect(process.env.FIXTURE_PERSON).toBe("person-a");
      await retireLocalTestRuntimeProfile(root, old.reference!);
      expect(process.env.FIXTURE_PERSON).toBe("person-a");
      await expect(loadLocalTestRuntimeIdentity(oldOptions)).rejects.toThrow("LOCAL_TEST_RUNTIME_RETIRED");
    });
    await uninstallManagedMcpProject({ client: "claude-code", projectRoot: root, localClient: old.reference });
    expect(await fs.readFile(old.path, "utf8")).toBe(oldBytes);
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root, runtimePath: localClientRuntimePath(replacement.reference!) }))
      .resolves.toEqual({ FIXTURE_TENANT: "tenant-a", FIXTURE_PERSON: "person-b" });
    await expect(retireLocalTestRuntimeProfile(root, old.reference!)).resolves.toBeUndefined();
    expect(await listLocalTestRuntimeProfiles(root)).toContainEqual({ reference: old.reference, retired: true });
  });

  it("enforces private files, symlink/hardlink protections and inherited-environment conflict on named references", async () => {
    const root = await activeProject(); const saved = await named(root, "client", "person-a");
    const options = { projectRoot: root, runtimePath: localClientRuntimePath(saved.reference!) };
    await fs.chmod(saved.path, 0o644);
    await expect(loadLocalTestRuntimeIdentity(options)).rejects.toThrow("LOCAL_TEST_RUNTIME_PERMISSIONS_INVALID");
    await fs.chmod(saved.path, 0o600);
    const hardlink = path.join(root, "hardlink"); await fs.link(saved.path, hardlink);
    await expect(loadLocalTestRuntimeIdentity(options)).rejects.toThrow("LOCAL_TEST_RUNTIME_PERMISSIONS_INVALID");
    await fs.unlink(hardlink);
    const original = process.env.FIXTURE_PERSON; process.env.FIXTURE_PERSON = "other-person";
    try { await expect(withLocalTestRuntimeIdentity(options, async () => undefined)).rejects.toThrow("LOCAL_TEST_RUNTIME_ENV_CONFLICT"); }
    finally { if (original === undefined) delete process.env.FIXTURE_PERSON; else process.env.FIXTURE_PERSON = original; }
    await fs.rename(saved.path, hardlink); await fs.symlink(hardlink, saved.path);
    await expect(loadLocalTestRuntimeIdentity(options)).rejects.toThrow("LOCAL_TEST_RUNTIME_PERMISSIONS_INVALID");
  });

  it("reviews, persists and reselects named identities through setup without exposing their values", async () => {
    const root = await activeProject();
    const contexts: unknown[] = [];
    const confirm = vi.fn(async (_: string, options: unknown) => { contexts.push(options); return true; });
    const session = { chooseOption: async () => "create", promptText: async () => "client", confirm };
    const selection = await reviewLocalClientSetup({ projectRoot: root }, { session,
      readIdentity: async prompt => prompt.includes("principal") ? "private-person" : "private-tenant" });
    expect(selection.kind).toBe("named");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(contexts)).toContain("Identity contract");
    expect(JSON.stringify(contexts)).toContain("Shared ledger");
    expect(JSON.stringify(contexts)).not.toContain("private-person");
    if (selection.kind !== "named") throw new Error("expected named reference");
    await expect(reviewLocalClientSetup({ projectRoot: root }, { session: { ...session, chooseOption: async () => `select:${selection.reference}` } }))
      .resolves.toEqual(selection);
    const identity = await loadLocalTestRuntimeIdentity({ projectRoot: root, runtimePath: localClientRuntimePath(selection.reference) });
    expect(identity).toEqual({ FIXTURE_PERSON: "private-person", FIXTURE_TENANT: "private-tenant" });
  });

  it("reports reviewed future-launch retirement separately from cancellation", async () => {
    const root = await activeProject(); const saved = await named(root, "retiring", "person-a");
    await expect(reviewLocalClientSetup({ projectRoot: root }, { session: {
      chooseOption: async () => `retire:${saved.reference}`, promptText: async () => undefined, confirm: async () => true,
    } })).resolves.toEqual({ kind: "retired", reference: saved.reference });
    await expect(loadLocalTestRuntimeIdentity({ projectRoot: root, runtimePath: localClientRuntimePath(saved.reference!) }))
      .rejects.toThrow("LOCAL_TEST_RUNTIME_RETIRED");
  });

  it.each(["initial", "final", "selection", "retirement"])("leaves existing identities and client entries unchanged when %s review is declined", async stage => {
    const root = await activeProject(); const saved = await named(root, "existing", "person-a");
    await installManagedMcpProjectSet({ client: "claude-code", projectRoot: root, entries: [{ entryKind: "explore", authoring: true, localClient: saved.reference }] });
    const before = await fs.readFile(path.join(root, ".mcp.json"), "utf8");
    const profiles = await listLocalTestRuntimeProfiles(root); let confirmations = 0;
    const readIdentity = vi.fn(async () => "not-saved");
    await expect(reviewLocalClientSetup({ projectRoot: root }, { session: {
      chooseOption: async () => stage === "selection" ? `select:${saved.reference}` : stage === "retirement" ? `retire:${saved.reference}` : "create",
      promptText: async () => "declined", confirm: async () => ++confirmations < (stage === "final" ? 2 : 1),
    }, readIdentity })).resolves.toEqual({ kind: "cancelled" });
    if (stage !== "final") expect(readIdentity).not.toHaveBeenCalled();
    expect(await listLocalTestRuntimeProfiles(root)).toEqual(profiles);
    expect(await fs.readFile(path.join(root, ".mcp.json"), "utf8")).toBe(before);
  });

  it("refuses a contract changed during hidden review before saving any new reference", async () => {
    const root = await activeProject(); let confirmations = 0;
    await expect(reviewLocalClientSetup({ projectRoot: root }, { session: {
      chooseOption: async () => "create", promptText: async () => "stale", confirm: async () => {
        if (++confirmations === 2) await writeActiveAuthority(root, "FIXTURE_TENANT", "CHANGED_PERSON"); return true;
      },
    }, readIdentity: async () => "private-value" })).rejects.toThrow("LOCAL_TEST_RUNTIME_BINDING_CHANGED");
    expect(await listLocalTestRuntimeProfiles(root)).toEqual([]);
  });
});

async function activeProject(input: { deploymentProfile?: "staging" | "production" } = {}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-local-test-runtime-"));
  roots.push(root);
  await writeActiveAuthority(root, "FIXTURE_TENANT", "FIXTURE_PERSON", input.deploymentProfile ?? "staging");
  return root;
}

async function writeActiveAuthority(root: string, tenant: string, principal: string, deploymentProfile: "staging" | "production" = "staging", compilerVersion = "test", organizationId = "org-a", selectableFields = ["case_id", "status"]): Promise<void> {
  const authority = {
    schema_version: "synapsor.exploration-boundary.v1",
    activation: "reviewed",
    deployment_profile: deploymentProfile,
    source: "local_postgres",
    compiler_version: compilerVersion,
    spec_version: "test",
    trusted_context: { provider: "environment", tenant_env: tenant, principal_env: principal },
    organization_scope: { mode: "single_organization", organization_id: organizationId,
      acknowledgement: "all_rows_belong_to_one_organization" },
    generation_lock_fingerprint: `sha256:${"a".repeat(64)}`,
    role_posture_fingerprint: `sha256:${"b".repeat(64)}`,
    pack: { name: "local_test", resources: [{ id: "cases", schema: "app", table: "cases", selectable_fields: selectableFields }] },
    budgets: {},
  };
  const active = { ...authority, activation: { state: "active", digest: canonicalJsonDigest(authority), actor: "test",
    activated_at: "2026-09-10T18:00:00.000Z", generation_lock_fingerprint: authority.generation_lock_fingerprint, reviewed_decisions: [] } };
  await fs.mkdir(path.join(root, ".synapsor"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(root, ".synapsor/exploration-boundaries.active.json"), JSON.stringify({
    schema_version: "synapsor.active-exploration-boundaries.v1", selected_name: active.pack.name,
    boundaries: [active], updated_at: active.activation.activated_at,
  }));
}
