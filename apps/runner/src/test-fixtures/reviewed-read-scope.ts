/** Declared disposable fixture preparation through ordinary structural review.
 * No hand-built review confirmation, scope reference, candidate or analysis. */
import fs from "node:fs/promises";
import path from "node:path";
import { buildAutoBoundary } from "../auto-boundary.js";
import { boundaryReviewCommand, loadBoundaryReviewContext } from "../boundary-commands.js";
import { analyzeReadWorkloadSet, READ_WORKLOAD_SET_VERSION } from "../read-workload-assist.js";
import { prepareBoundaryResourceReviewMutation, commitBoundaryResourceReviewMutation } from "../boundary-review-mutation.js";
import type { BoundaryResourceReviewRequest } from "../read-authoring-contract-types.js";
import { ownedProgramInspection } from "./owned-authoring-program.js";
import { initializeGuidedProject } from "../guided-project.js";
import { initializeFreshGovernedAuthoring } from "../control-policy-fresh-authoring.js";
import { readRuntimeConfig } from "../cli-project.js";

export async function prepareReviewedReadScope(projectRoot: string, declared: { resources: string[]; field: string; primaryKey?: string; fields?: Record<string, { type: string; enum?: string[] }>; review?: Pick<BoundaryResourceReviewRequest, "selectable_fields" | "filterable_fields" | "sortable_fields" | "groupable_fields" | "aggregate_measures" | "count_distinct_fields" | "time_bucket_fields" | "keep_out_fields" | "allow_reviewed_fields"> } = {resources:["work.items"],field:"label"}) {
  // Reuse the declared structural fixture; only table identity changes to the
  // existing work.items test domain. No source rows or customer facts exist.
  // A real isolated repository boundary prevents parent decoy/user config discovery.
  await fs.mkdir(path.join(projectRoot,".git"),{mode:0o700});
  const inspection=ownedProgramInspection();
  const template=inspection.tables[0]!;
  inspection.tables=declared.resources.map(id=>{
    const [schema,name]=id.split(".");if(!schema||!name)throw new Error("Exact schema.table fixture identity required");
    const table=structuredClone(template);table.schema=schema;table.name=name;
    if (declared.primaryKey) {
      const originalKey = table.primary_key[0]!;
      table.columns.find(column => column.name === originalKey)!.name = declared.primaryKey;
      table.primary_key = [declared.primaryKey];
      for (const unique of table.unique_constraints) unique.columns = unique.columns.map(column => column === originalKey ? declared.primaryKey! : column);
    }
    for(const column of table.columns)if(column.name==="label")column.name=declared.field;
    for (const [name, field] of Object.entries(declared.fields ?? {})) {
      const column = table.columns.find(column => column.name === name);
      if (column) Object.assign(column, { data_type: field.type, ...(field.enum ? { enum_values: field.enum } : {}) });
      else table.columns.push({ name, data_type: field.type, ...(field.enum ? { enum_values: field.enum } : {}),
        ordinal_position: table.columns.length, nullable: false, generated: false,
        suggestions: { tenant: false, conflict: false, sensitive: declared.review?.keep_out_fields?.includes(name) ?? false,
          immutable: false, large_or_binary: false } });
    }
    table.suggestions.default_visible_columns=table.suggestions.default_visible_columns.map(field=>field==="label"?declared.field:field);
    return table;
  });
  inspection.schemas=[...new Set(inspection.tables.map(table=>table.schema))];
  const build=buildAutoBoundary({inspection,sourceEnv:"DATABASE_URL",inspectedSchema:inspection.schemas[0]!,
    project:{root:projectRoot,package_manager:"npm",frameworks:[],schema_inputs:[],database_env_names:["DATABASE_URL"]}});
  // Follow fresh product initialization before any review. File-only confirmations
  // cannot substitute for the immutable native candidate/origin required by v2.
  const guided = await initializeGuidedProject({ projectRoot, build, runnerVersion: "1.8.0", instantOnboarding: true });
  const config = await readRuntimeConfig(guided.config_path);
  await initializeFreshGovernedAuthoring({ projectRoot, build, config, storePath: guided.store_path,
    actor: "declared fixture operator" });
  for(const resource_id of declared.resources){
  const preview=await prepareBoundaryResourceReviewMutation(projectRoot,{
    resource_id,include:true,tenant_key:"tenant_id",principal_key:"principal_id",
    selectable_fields:[declared.field], ...declared.review, actor:"declared fixture operator",
    reason:"Show the current principal's item labels inside the trusted tenant; retain private fields outside returned data.",
  },async()=>inspection);
  await commitBoundaryResourceReviewMutation(projectRoot,preview);
  }
  const shown:Array<{message:string;context:readonly string[];defaultValue:boolean|undefined}>=[];
  await boundaryReviewCommand(["--project-root",projectRoot,"--confirm","--actor","declared fixture operator","--output",path.join(projectRoot,"reviewed-structure.json")],async()=>inspection,{
    presentationMode:"conversation",promptText:async()=>undefined,
    confirm:async(message,options)=>{
      if(!options?.context?.length)throw new Error("Structural review must show its actual current settings");
      shown.push({message,context:[...options.context],defaultValue:options.defaultValue});return true;
    },chooseResource:async()=>undefined,editFieldTiers:async()=>undefined,
  });
  const context=await loadBoundaryReviewContext(projectRoot);
  if(!shown.length||!context.progress?.confirmations.length||context.bundle.outstanding_decision_ids.length)
    throw new Error("Ordinary structural review did not establish its exact signoffs");
  const analysis=analyzeReadWorkloadSet({generatedBoundary:context.candidate,workload:{schema_version:READ_WORKLOAD_SET_VERSION,name:"items",
    source:{kind:"model",provider:"openai",model:"declared-structural-fixture"},
    allowed:declared.resources.map((resource,index)=>({id:`items_${index}`,description:`Show the reviewed ${declared.field}`,plan:{kind:"rows" as const,resource,select:[declared.field]}})),forbidden:[]}});
  if(analysis.status!=="ready"||!analysis.candidate)throw new Error("Actual Read compiler did not produce the declared fixture");
  return{inspection,build,context,analysis,shown};
}
