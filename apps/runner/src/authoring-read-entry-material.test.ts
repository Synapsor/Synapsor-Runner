import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { loadRuntimeConfigFromFile, type RuntimeConfig, type TrustedContext } from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { assertAuthoringMaterial, resolveAuthoringMaterialContext, type AuthoringMaterialContext,
  type AuthoringMaterialOwner, type AuthoringMaterialOrigin } from "./authoring-resume-material.js";

// Transient privacy contract only. Declared frame syntax here is not proof of
// native custody/ACK/authority: native readers and writers own those checks.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(override: Partial<RuntimeConfig> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "read-entry-material-")); roots.push(root); await fs.chmod(root, 0o700);
  await fs.mkdir(path.join(root, ".git"));
  const file = path.join(root, "synapsor.runner.json");
  await fs.writeFile(file, JSON.stringify({ version: 1, mode: "read_only", capabilities: [],
    sources: { app: { engine: "postgres", read_url_env: "READ_ENTRY_UNUSED_DB" } },
    trusted_context: { provider: "environment", values: { tenant_id_env: "READ_ENTRY_TENANT", principal_env: "READ_ENTRY_PRINCIPAL" } }, ...override }), { mode: 0o600 });
  loadRuntimeConfigFromFile(file);
  const owner: AuthoringMaterialOwner = { projectRoot: root, readEntry: { entry_id: `bnd_${"1".repeat(32)}`,
    bindings: { repository_id: randomUUID(), deployment_id: randomUUID(), project_id: randomUUID(), epoch: 4, revision_id: `policy:${d("native frame").slice(7)}` } } };
  const env = { READ_ENTRY_TENANT: "declared-private-organization", READ_ENTRY_PRINCIPAL: "declared-private-person" };
  const context = await resolveAuthoringMaterialContext({ ...owner, env });
  const check = (value: unknown, origin: AuthoringMaterialOrigin = "retained_material", selected: AuthoringMaterialOwner = owner, c = context) =>
    assertAuthoringMaterial({ value, origin, owner: selected, context: c });
  return { root, file, owner, env, context, check };
}
it("screens complete nested Read/SUM proposal data and rejects business identity collisions", async () => {
  const f = await fixture(); expect(f.context.kind).toBe("configured");
  await expect(f.check({ workload: { allowed: [{ description: "Ordinary business purpose" }] } })).resolves.toBe('{"workload":{"allowed":[{"description":"Ordinary business purpose"}]}}');
  for (const value of [{ operator_questions: [{ read_scope: { record: { references: [{ text: f.env.READ_ENTRY_PRINCIPAL }] } } }] },
    { actions: [{ review: { then: f.env.READ_ENTRY_TENANT } }] }, { [f.env.READ_ENTRY_PRINCIPAL]: "inert" }])
    await expect(f.check(value)).rejects.toThrow("IDENTITY_BLOCKED");
  f.env.READ_ENTRY_TENANT = "2";
  const current = await resolveAuthoringMaterialContext({ ...f.owner, env: f.env });
  await expect(f.check({ maximum: 2 }, "business_value", f.owner, current)).rejects.toThrow("IDENTITY_AMBIGUOUS");
  await expect(f.check("mysql://private" )).rejects.toThrow();
});
it.each(["entry_id", "repository_id", "deployment_id", "project_id", "epoch", "revision_id"] as const)
  ("fences changed %s; a genuine successor requires a newly resolved transient context", async field => {
    const f = await fixture(); if (!f.owner.readEntry) throw new Error("Read frame required");
    const next = { projectRoot: f.owner.projectRoot, readEntry: { ...f.owner.readEntry, bindings: { ...f.owner.readEntry.bindings } } };
    if (field === "entry_id") next.readEntry = { ...next.readEntry, entry_id: `bnd_${"2".repeat(32)}` };
    else if (field === "epoch") next.readEntry.bindings.epoch++;
    else if (field === "revision_id") next.readEntry.bindings.revision_id = `policy:${d("successor").slice(7)}`;
    else next.readEntry.bindings[field] = randomUUID();
    await expect(f.check("business", "retained_material", next)).rejects.toThrow("CONTEXT_CHANGED");
    const fresh = await resolveAuthoringMaterialContext({ ...next, env: f.env });
    await expect(f.check("business", "retained_material", next, fresh)).resolves.toBe('"business"');
  });
it("captures the nested frame before a wait and detaches it from mutable input", async () => {
  const f = await fixture(); if (!f.owner.readEntry) throw new Error("Read frame required");
  const pinned = structuredClone(f.owner), pending = f.check("business");
  f.owner.readEntry.bindings.epoch++;
  expect(await pending).toBe('"business"');
  await expect(f.check("business")).rejects.toThrow("CONTEXT_CHANGED");
  await expect(f.check("business", "retained_material", pinned)).resolves.toBe('"business"');
});
it("refuses mixed/fake owners and serialized or forged privacy contexts", async () => {
  const f = await fixture();
  for (const input of [{ ...f.owner, jobCreatedAt: "2026-10-09T10:00:00.000Z" }, { ...f.owner, sourceSessionId: randomUUID() },
    { ...f.owner, readEntry: { ...f.owner.readEntry, entry_id: "invented" } }])
    await expect(Reflect.apply(resolveAuthoringMaterialContext, undefined, [{ ...input, env: f.env }])).rejects.toThrow("CONTEXT_UNAVAILABLE");
  await expect(f.check("business", "retained_material", f.owner, { kind: "configured" } as AuthoringMaterialContext)).rejects.toThrow("CONTEXT_UNAVAILABLE");
  expect(Object.keys(f.context)).toEqual(["kind"]); expect(() => JSON.stringify(f.context)).toThrow("CONTEXT_UNAVAILABLE");
});
it("keeps environment/config drift strict and requires actual verified sessions", async () => {
  const f = await fixture(); f.env.READ_ENTRY_PRINCIPAL = "changed-private-person";
  await expect(f.check("business")).rejects.toThrow("CONTEXT_CHANGED");
  f.env.READ_ENTRY_PRINCIPAL = "declared-private-person";
  await fs.writeFile(f.file, JSON.stringify({ version: 1, mode: "read_only", capabilities: [] }));
  await expect(f.check("business")).rejects.toThrow("CONTEXT_CHANGED");
  const h = await fixture({ trusted_context: { provider: "http_claims", principal_binding: "actor" },
    session_auth: { provider: "jwt_hs256", secret_env: "READ_ENTRY_SESSION_SECRET" } });
  expect(h.context.kind).toBe("unavailable"); await expect(h.check("business")).rejects.toThrow("CONTEXT_UNAVAILABLE");
  // Explicit host-port contract fixture; this does not qualify an authenticator.
  let session: TrustedContext | undefined = { tenant_id: "declared-http-organization", principal: "declared-http-person", provenance: "http_claims" };
  const c = await resolveAuthoringMaterialContext({ ...h.owner, env: h.env, currentVerifiedSession: async frame => {
    expect(frame.readEntry).toEqual(h.owner.readEntry); expect(frame.jobCreatedAt).toBeUndefined(); expect(frame.sourceSessionId).toBeUndefined(); return session;
  } });
  await expect(h.check("declared-http-person", "retained_material", h.owner, c)).rejects.toThrow("IDENTITY_BLOCKED");
  session = undefined; await expect(h.check("business", "retained_material", h.owner, c)).rejects.toThrow("CONTEXT_CHANGED");
});
it("preserves the existing job and Source owner branches", async () => {
  const f = await fixture();
  for (const owner of [{ projectRoot: f.root, jobCreatedAt: "2026-10-09T10:00:00.000Z" }, { projectRoot: f.root, sourceSessionId: randomUUID() }]) {
    const context = await resolveAuthoringMaterialContext({ ...owner, env: f.env });
    await expect(f.check("business", "retained_material", owner, context)).resolves.toBe('"business"');
    await expect(f.check(f.env.READ_ENTRY_PRINCIPAL, "retained_material", owner, context)).rejects.toThrow("IDENTITY_BLOCKED");
    await expect(f.check("business", "retained_material", owner)).rejects.toThrow("CONTEXT_CHANGED");
  }
});
