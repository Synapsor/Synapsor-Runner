import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_TEST_RUNTIME_IDENTITY_PATH,
  loadLocalTestRuntimeIdentity,
  saveLocalTestRuntimeIdentity,
  withLocalTestRuntimeIdentity,
} from "./local-test-runtime-identity.js";

const roots: string[] = [];

afterEach(async () => {
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
