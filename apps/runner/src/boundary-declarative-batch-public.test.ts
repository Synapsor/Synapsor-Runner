import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { start } from "./guided-start.js";
import { loadBoundaryReviewContext } from "./boundary-review-context.js";
import { ownedProgramInspection } from "./test-fixtures/owned-authoring-program.js";
import { readBoundaryDraftExchange } from "./boundary-draft-bundle.js";
import { loadActivatedExplorationBoundary } from "./auto-boundary.js";

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) await fs.rm(root, {recursive:true,force:true}); });

it("actual start/export/draft service replaces the sole saved bootstrap in one disabled batch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "public-declarative-batch-")); roots.push(root);
  await fs.mkdir(path.join(root, ".git"));
  const inspection = ownedProgramInspection(), original = inspection.tables[0]!;
  inspection.schemas = ["orchard"];
  inspection.tables = ["bootstrap", "fruit"].map(name => ({ ...structuredClone(original), schema: "orchard", name }));
  vi.stubEnv("BATCH_DECLARED_READ_URL", "postgresql://fixture.invalid/not-used");
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "SYNAPSOR_RUNNER_CONFIG", "SYNAPSOR_MCP_CONFIG"]) vi.stubEnv(name, undefined);
  const inspector = vi.fn(async () => inspection);
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation(chunk => { output += String(chunk); return true; });
  const run = async (args: string[]) => {
    output = "";
    const exit = await start(["--project-root", root, ...args, "--json"], {interactive:false,schemaInspector:inspector});
    const response = {exit, result:JSON.parse(output)};
    if (process.env.BATCH_PUBLIC_EVIDENCE) await fs.appendFile(process.env.BATCH_PUBLIC_EVIDENCE, JSON.stringify({args, response})+"\n");
    return response;
  };
  expect(await run(["--from-env", "BATCH_DECLARED_READ_URL", "--schema", "orchard"])).toMatchObject({exit:0});
  const include = (resource_id: string) => ({resource_id,include:true,tenant_key:"tenant_id",principal_key:"principal_id",
    row_identity:"parcel_id",selectable_fields:["label"],allow_reviewed_fields:["label"],keep_out_fields:["internal_note"]});
  expect(await run(["--export-draft", "bootstrap.json"])).toMatchObject({exit:0});
  const initial = await readBoundaryDraftExchange(root, "bootstrap.json") as { read: {resources: unknown[]}; actions: unknown[] };
  initial.read.resources = [include("orchard.bootstrap"), {resource_id:"orchard.fruit",exclude:true}]; initial.actions = [];
  await fs.writeFile(path.join(root,"bootstrap.json"), JSON.stringify(initial));
  expect(await run(["--draft", "bootstrap.json"])).toMatchObject({exit:0,result:{state:"saved_disabled",source_database_changed:false}});
  const before = await loadBoundaryReviewContext(root);
  expect(before.candidate.pack.resources.map(r=>r.id)).toEqual(["orchard.bootstrap"]);
  expect(await run(["--export-draft", "replace.json"])).toMatchObject({exit:0});
  const replacement = await readBoundaryDraftExchange(root, "replace.json") as typeof initial;
  replacement.read.resources = [{resource_id:"orchard.bootstrap",exclude:true}, include("orchard.fruit")]; replacement.actions=[];
  await fs.writeFile(path.join(root,"replace.json"), JSON.stringify(replacement));
  expect(await run(["--draft", "replace.json", "--dry-run"])).toMatchObject({exit:0,result:{state:"validated_disabled_preview",source_database_changed:false}});
  expect(await loadBoundaryReviewContext(root)).toEqual(before);
  expect(await run(["--draft", "replace.json"])).toMatchObject({exit:0,result:{state:"saved_disabled",source_database_changed:false}});
  const after = await loadBoundaryReviewContext(root);
  expect(after.candidate.pack.resources.map(r=>r.id)).toEqual(["orchard.fruit"]);
  expect(after.candidate.activation).toBe("disabled_unreviewed");
  expect(after.candidate.pack.resources[0]!.kept_out_fields).toContain("internal_note");
  await expect(loadActivatedExplorationBoundary(root)).rejects.toMatchObject({code:"ENOENT"});
  expect(inspector).toHaveBeenCalled();
}, 60000);
