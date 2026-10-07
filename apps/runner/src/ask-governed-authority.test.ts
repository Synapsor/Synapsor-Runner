import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { AUTO_BOUNDARY_OVERRIDES_VERSION, buildAutoBoundary, deactivateExplorationBoundary, loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { initializeGuidedProject } from "./guided-project.js";
import { readRuntimeConfig } from "./cli-project.js";
import { initializeFreshGovernedAuthoring } from "./control-policy-fresh-authoring.js";
import { createBoundaryReviewProgress } from "./boundary-review-domain.js";
import { saveBoundaryReviewProgress } from "./boundary-review-persistence.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { boundaryActivateCommand } from "./boundary-commands.js";
import { computeAskAuthority, resolveActiveBoundarySummary, resolveAskDeploymentProfile } from "./ask-authority.js";
import { tryAsk } from "./try-ask.js";
import type { AskToolDefinition } from "./model-ask.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, {recursive:true, force:true}); });
const tools: AskToolDefinition[] = ["app.describe_data", "app.explore_data", "app.describe_actions", "app.request_change"].map(name => ({
  name, description: "Declared governed Ask tool surface", input_schema: { type: "object", properties: {}, additionalProperties: false }
}));
async function project(activate = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "governed-ask-")); roots.push(root);
  const build = fixture(root), inspection = fixtureInspection();
  const guided = await initializeGuidedProject({projectRoot:root, build, runnerVersion:"1.8.0", instantOnboarding:true});
  await initializeFreshGovernedAuthoring({projectRoot:root, config:await readRuntimeConfig(guided.config_path), storePath:guided.store_path, build, actor:"fixture_operator"});
  const saved=(await readProjectReadAuthoring(root))!, entry=saved.selected!;
  await saveBoundaryReviewProgress(root, createBoundaryReviewProgress({draft:entry.draft, candidate:entry.progress.candidate,
    previous:entry.progress, confirmedDecisions:entry.progress.candidate.unresolved_decisions, actor:"fixture_operator",
    reason:"Review declared read-only university metadata", revision:entry.progress.revision+1}),saved.bindings);
  if (activate) {
    // Exercise the public local operator consent host, not an invented activation receipt.
    const confirm=vi.fn(async (_question:string, options:{defaultValue?:boolean}) => { expect(options.defaultValue).toBe(false); return true; });
    expect(await boundaryActivateCommand(["--project-root",root],async()=>inspection, {
      presentationMode:"conversation",chooseResource:async()=>undefined,editFieldTiers:async()=>undefined,
      promptText:async()=>"fixture_operator",present:()=>undefined,confirm,
    })).toBe(0);
    expect(confirm).toHaveBeenCalledOnce();
  }
  for (const name of ["exploration-boundary.active.json","exploration-boundaries.active.json"])
    await expect(fs.stat(path.join(root,".synapsor",name))).rejects.toMatchObject({code:"ENOENT"});
  await expect(fs.stat(path.join(root,"synapsor/generated"))).rejects.toMatchObject({code:"ENOENT"});
  return {root,...guided};
}
function authority(p:Awaited<ReturnType<typeof project>>) {
  return computeAskAuthority({projectRoot:p.root,configPath:p.config_path,tools,profile:"staging",mode:"authoring"});
}
it("recognizes native governed Read profile, authority and summary without legacy exports",async()=>{
  const p=await project(), active=await loadActivatedExplorationBoundaries(p.root);
  await expect(resolveAskDeploymentProfile(p.root)).resolves.toBe("staging");
  await expect(resolveActiveBoundarySummary(p.root)).resolves.toMatchObject({names:[active[0]!.pack.name],boundary_count:1,table_count:1});
  await expect(authority(p)).resolves.toMatchObject({active_boundary_digests:[active[0]!.activation.digest]});
});
it("lets native Try Ask reach default-declined egress with four tools and no provider request",async()=>{
  const p=await project(), requestJson=vi.fn(), close=vi.fn(async()=>undefined), consent=vi.fn(async()=>false);
  await expect(tryAsk(["Read the reviewed student credits.","--project-root",p.root,"--config",p.config_path,"--store",p.store_path,"--provider","openai","--model","fixture"],{
    env:{OPENAI_API_KEY:"local-fixture-only"},providerDependencies:{requestJson},confirmEgress:consent,
    gatewayFactory:async()=>({listTools:async()=>tools,callTool:async()=>{throw new Error("No tool execution authorized");},close}),
  })).rejects.toMatchObject({code:"ASK_EGRESS_CONSENT_DECLINED"});
  expect(consent).toHaveBeenCalledOnce();expect(requestJson).not.toHaveBeenCalled();expect(close).toHaveBeenCalledOnce();
});
it("does not promote a reviewed disabled governed draft to Ask authority",async()=>{
  const p=await project(false);
  await expect(authority(p)).rejects.toMatchObject({code:"ASK_AUTHORING_AUTHORITY_UNAVAILABLE"});
  await expect(resolveActiveBoundarySummary(p.root)).resolves.toBeUndefined();
});
it("observes native revocation and never restores it from stale legacy exports",async()=>{
  const p=await project(), [active]=await loadActivatedExplorationBoundaries(p.root);
  await fs.writeFile(path.join(p.root,".synapsor/exploration-boundary.active.json"),JSON.stringify(active));
  await deactivateExplorationBoundary(p.root);
  await expect(authority(p)).rejects.toMatchObject({code:"ASK_AUTHORING_AUTHORITY_UNAVAILABLE"});
  await expect(resolveActiveBoundarySummary(p.root)).resolves.toBeUndefined();
});
function fixture(root: string, inspectedAt = "2026-09-08T00:00:00.000Z") {
  const inspection = fixtureInspection(inspectedAt);
  return buildAutoBoundary({ inspection, inspectedSchema: "university", sourceEnv: "DATABASE_URL", deploymentProfile: "staging", overrides: {
    schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION, resources: { "university.students": { tenant_key: {
      value: "institution_id", actor: "fixture_operator", reason: "Fixture tenant binding.", decided_at: "2026-09-08T00:00:00.000Z",
    } } },
  }, project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] } });
}

function fixtureInspection(inspectedAt = "2026-09-08T00:00:00.000Z"): SchemaInspection {
  return {
    engine: "postgres", server_version: "PostgreSQL 16", current_user: "reader", inspected_at: inspectedAt,
    schemas: ["university"], warnings: [], role_posture: { verified: true, superuser: false, bypass_rls: false,
      read_only: true, writable_relations: [], owned_relations: [], reasons: [] },
    tables: [{ schema: "university", name: "students", type: "table", writable: false,
      columns: ["id", "institution_id", "student_id", "credits", "version"].map((name, ordinal_position) => ({
        name, data_type: name === "credits" || name === "version" ? "integer" : "uuid", ordinal_position,
        nullable: false, generated: false, suggestions: { tenant: name === "institution_id", conflict: name === "version",
          sensitive: false, immutable: name.endsWith("id"), large_or_binary: false },
      })), primary_key: ["id"], unique_constraints: [{ name: "students_pkey", columns: ["id"] }], check_constraints: [], foreign_keys: [], row_level_security: false, indexes: [],
      role_posture: { owner: "owner", current_role_is_owner: false, current_role_can_assume_owner: false,
        privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
        row_security_forced: false, row_security_effective_for_current_role: false },
      suggestions: { tenant_columns: ["institution_id"], conflict_columns: ["version"], sensitive_columns: [], default_visible_columns: ["student_id", "credits"] },
    }],
  };
}
