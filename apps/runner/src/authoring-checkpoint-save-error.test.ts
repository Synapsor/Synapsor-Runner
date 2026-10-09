import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRuntimeConfigFromFile } from "@synapsor-runner/mcp-server";
import { assertAuthoringMaterial, resolveAuthoringMaterialContext } from "./authoring-resume-material.js";
import { describe, expect, it } from "vitest";
import { AuthoringResumeMaterialError, AuthoringCheckpointSaveError, rejectedCheckpointMaterial } from "./authoring-checkpoint-save-error.js";
import { assertBoundaryAuthoringResumeMaterial } from "./boundary-authoring-resume.js";

describe("checkpoint rejection follows actual native cause", () => {
  it.each([{answer:"api_key=secret"},{answer:"principal_id: actual-private-identity"}])("binds native rejection of %j without wrapper wording", async value => {
    let cause: unknown;
    // Credential-only codec control stays synchronous; the identical identity
    // string now has a real configured native context, not a prose classifier.
    if (value.answer === "api_key=secret") {
      try { assertBoundaryAuthoringResumeMaterial(value); } catch (error) { cause=error; }
    } else {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "checkpoint-native-cause-"));
      await fs.chmod(root, 0o700); await fs.mkdir(path.join(root, ".git"));
      const keys = ["SYNAPSOR_RUNNER_CONFIG", "SYNAPSOR_MCP_CONFIG", "D4_CHECKPOINT_TENANT", "D4_CHECKPOINT_PRINCIPAL"];
      const previous = keys.map(key => process.env[key]);
      try {
        delete process.env.SYNAPSOR_RUNNER_CONFIG; delete process.env.SYNAPSOR_MCP_CONFIG;
        process.env.D4_CHECKPOINT_TENANT = "checkpoint-tenant";
        process.env.D4_CHECKPOINT_PRINCIPAL = "actual-private-identity";
        const config = path.join(root, "synapsor.runner.json");
        await fs.writeFile(config, JSON.stringify({ version: 1, mode: "read_only", capabilities: [],
          sources: { app: { engine: "postgres", read_url_env: "D4_UNUSED_READ_DB" } },
          trusted_context: { provider: "environment", values: {
            tenant_id_env: "D4_CHECKPOINT_TENANT", principal_env: "D4_CHECKPOINT_PRINCIPAL" } },
        }), { mode: 0o600 });
        loadRuntimeConfigFromFile(config);
        const owner = { projectRoot: root, jobCreatedAt: "2026-10-09T10:00:00.000Z" };
        const context = await resolveAuthoringMaterialContext(owner);
        try { await assertAuthoringMaterial({ value, owner, origin: "retained_material", context }); } catch (error) { cause=error; }
      } finally {
        keys.forEach((key, index) => { const prior = previous[index]; if (prior === undefined) delete process.env[key]; else process.env[key] = prior; });
        await fs.rm(root, { recursive: true, force: true });
      }
    }
    expect(cause).toBeInstanceOf(AuthoringResumeMaterialError);
    const checkpoint=new AuthoringCheckpointSaveError("different display words", "redacted diagnostic", cause as AuthoringResumeMaterialError);
    expect(rejectedCheckpointMaterial(checkpoint)).toBe(true);
    expect(checkpoint.cause).toBe(cause);
    expect(checkpoint.message).not.toContain(value.answer);
  });
  it("rejects provider/ordinary errors that merely repeat the old English wrapper",()=>{
    const prose="ACTION_CHECKPOINT_NOT_SAVED: The checkpoint could not be saved. BOUNDARY_AUTHORING_RESUME_PRIVATE_MATERIAL_BLOCKED: copied prose";
    expect(rejectedCheckpointMaterial(new Error(prose))).toBe(false);
    expect(rejectedCheckpointMaterial(Object.assign(new Error(prose),{code:"ACTION_CHECKPOINT_NOT_SAVED",cause:{code:"BOUNDARY_AUTHORING_RESUME_PRIVATE_MATERIAL_BLOCKED"}}))).toBe(false);
  });
  it("does not carry rejected material into a later ordinary save failure",()=>{
    const material=new AuthoringResumeMaterialError("BOUNDARY_AUTHORING_RESUME_PRIVATE_MATERIAL_BLOCKED","redacted");
    expect(rejectedCheckpointMaterial(new AuthoringCheckpointSaveError("checkpoint","diagnostic",material))).toBe(true);
    expect(rejectedCheckpointMaterial(new AuthoringCheckpointSaveError("currentness","same displayed diagnostic"))).toBe(false);
  });
});
