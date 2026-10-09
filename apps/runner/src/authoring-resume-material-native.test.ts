import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadRuntimeConfigFromFile } from "@synapsor-runner/mcp-server";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { buildBoundaryAuthoringResumeState, readBoundaryAuthoringResumeState,
  readBoundaryAuthoringResumeStateHeld, writeBoundaryAuthoringResumeState,
  type BoundaryAuthoringResumeBinding } from "./boundary-authoring-resume.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";

// bcd48c8d native before: 2P/7F (actual writes/refusals preserved); snapshot export: 42P/types0; Main hooks pending.
// Native empty planning records only: no generation/completion, analysis, Yes,
// selected runtime authority, model request or source database is fabricated.
const restorations: Array<() => void> = [];
afterEach(() => { for (const restore of restorations.splice(0).reverse()) restore(); });
function setEnv(key: string, value: string | undefined) {
  const before = process.env[key];
  restorations.push(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; });
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "native-resume-material-"));
  await fs.chmod(root, 0o700); await fs.mkdir(path.join(root, ".git"));
  setEnv("SYNAPSOR_RUNNER_CONFIG", undefined); setEnv("SYNAPSOR_MCP_CONFIG", undefined);
  setEnv("D4_NATIVE_TENANT", "acme-corp"); setEnv("D4_NATIVE_PRINCIPAL", "person-123");
  const config = path.join(root, "synapsor.runner.json");
  await fs.writeFile(config, JSON.stringify({ version: 1, mode: "read_only", capabilities: [],
    sources: { app: { engine: "postgres", read_url_env: "D4_UNUSED_READ_DB" } },
    trusted_context: { provider: "environment", values: { tenant_id_env: "D4_NATIVE_TENANT", principal_env: "D4_NATIVE_PRINCIPAL" } },
  }), { mode: 0o600 });
  loadRuntimeConfigFromFile(config); // Genuine config owner prerequisite.
  const binding: BoundaryAuthoringResumeBinding = { boundary_name: "native_material",
    generation_lock_fingerprint: canonicalJsonDigest("declared native generation lock"),
    schema_fingerprint: canonicalJsonDigest("declared metadata schema"),
    role_posture_fingerprint: canonicalJsonDigest("declared metadata role") };
  const base = { binding, stage: "planning" as const, jobIntent: "Read available business records.",
    provider: "openai" as const, model: "offline-not-called", now: "2026-10-09T10:00:00.000Z" };
  const state = buildBoundaryAuthoringResumeState(base);
  const file = path.join(root, ".synapsor/boundary-authoring/resume.json");
  const bytes = () => fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined; throw error;
  });
  return { root, config, binding, base, state, file, bytes };
}
async function rejected(operation: () => Promise<unknown>): Promise<unknown> {
  try { await operation(); return undefined; } catch (error) { return error; }
}

describe("native host identity screening at Resume retention", () => {
  it.each(["tenant", "principal", "native_key"] as const)("refuses configured %s before the first native write", async kind => {
    const f = await fixture();
    if (kind === "native_key") setEnv("D4_NATIVE_PRINCIPAL", "conversation");
    const state = kind === "tenant" ? buildBoundaryAuthoringResumeState({ ...f.base, jobIntent: "acme-corp" })
      : kind === "principal" ? buildBoundaryAuthoringResumeState({ ...f.base,
        conversation: [{ question: "Business request", answer: "person-123" }] }) : f.state;
    const error = await rejected(() => writeBoundaryAuthoringResumeState(f.root, state, { expectedRevisionDigest: null }));
    const saved = await f.bytes();
    expect({ rejected: error instanceof Error, saved: saved !== undefined }).toEqual({ rejected: true, saved: false });
    expect(String(error)).toMatch(/IDENTITY_(?:BLOCKED|AMBIGUOUS)/u);
  });
  it("retains ordinary business prose without inferring an identity from English", async () => {
    const f = await fixture();
    const state = buildBoundaryAuthoringResumeState({ ...f.base, jobIntent: "A tenant is described by a business policy; review its meaning." });
    await writeBoundaryAuthoringResumeState(f.root, state, { expectedRevisionDigest: null });
    const loaded = await readBoundaryAuthoringResumeState(f.root, f.binding);
    expect(loaded.status).toBe("ready");
    if (loaded.status !== "ready") throw new Error("Native record did not reopen.");
    expect(loaded.value.job_intent).toBe(state.job_intent);
    expect(loaded.value.authority_granted).toBe(false);
  });
  it("cold disk reloads the exact same job through entry and genuine Held readers", async () => {
    const f = await fixture();
    await writeBoundaryAuthoringResumeState(f.root, f.state, { expectedRevisionDigest: null });
    const original = await f.bytes();
    const entry = await readBoundaryAuthoringResumeState(f.root, f.binding);
    const held = await withProjectAuthorityMutation(f.root, permit => readBoundaryAuthoringResumeStateHeld(f.root, f.binding, permit));
    expect(entry).toEqual({ status: "ready", value: f.state }); expect(held).toEqual(entry);
    expect(await f.bytes()).toBe(original);
    expect(f.state.generation_recovery).toBeUndefined();
  });
  it.each(["missing_config", "missing_env"] as const)("keeps an existing job unavailable under %s, with no display or overwrite", async kind => {
    const f = await fixture();
    await writeBoundaryAuthoringResumeState(f.root, f.state, { expectedRevisionDigest: null });
    const original = await f.bytes();
    const next = buildBoundaryAuthoringResumeState({ ...f.base, previous: f.state,
      readIntent: "Read the same bounded business material.", now: "2026-10-09T10:01:00.000Z" });
    if (kind === "missing_config") await fs.rm(f.config);
    else setEnv("D4_NATIVE_TENANT", undefined);
    const loaded = await readBoundaryAuthoringResumeState(f.root, f.binding);
    const error = await rejected(() => writeBoundaryAuthoringResumeState(f.root, next,
      { expectedRevisionDigest: f.state.revision_digest }));
    // No ready value may reach a presenter; failure may not overwrite old bytes.
    expect({ status: loaded.status, exposed: "value" in loaded, rejected: error instanceof Error,
      unchanged: await f.bytes() === original }).toEqual({ status: "invalid", exposed: false, rejected: true, unchanged: true });
  });
  it("returns none for an actually absent Resume without inventing identity configuration", async () => {
    const f = await fixture(); await fs.rm(f.config);
    expect(await readBoundaryAuthoringResumeState(f.root, f.binding)).toEqual({ status: "none" });
    expect(await f.bytes()).toBeUndefined();
  });
  it("refuses original prototype serialization without invoking it or writing a native record", async () => {
    const f = await fixture(); let calls = 0;
    class PrivateSerialization { toJSON() { calls++; return "person-123"; } }
    Object.setPrototypeOf(f.state, PrivateSerialization.prototype);
    const error = await rejected(() => writeBoundaryAuthoringResumeState(f.root, f.state, { expectedRevisionDigest: null }));
    expect({ rejected: error instanceof Error, calls, saved: await f.bytes() !== undefined })
      .toEqual({ rejected: true, calls: 0, saved: false });
  });
});
