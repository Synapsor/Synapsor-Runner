/** Declared disposable fixture preparation through ordinary structural review.
 * No hand-built review confirmation, scope reference, candidate or analysis. */
import { buildAutoBoundary, writeAutoBoundaryArtifacts } from "../auto-boundary.js";
import { boundaryReviewCommand, loadBoundaryReviewContext } from "../boundary-commands.js";
import { analyzeReadWorkloadSet, READ_WORKLOAD_SET_VERSION } from "../read-workload-assist.js";
import { ownedProgramInspection } from "./owned-authoring-program.js";

export async function prepareReviewedReadScope(projectRoot: string) {
  // Reuse the declared structural fixture; only table identity changes to the
  // existing work.items test domain. No source rows or customer facts exist.
  const inspection=ownedProgramInspection();
  inspection.schemas=["work"];inspection.tables[0]!.schema="work";inspection.tables[0]!.name="items";
  const build=buildAutoBoundary({inspection,sourceEnv:"DATABASE_URL",inspectedSchema:"work",
    project:{root:projectRoot,package_manager:"npm",frameworks:[],schema_inputs:[],database_env_names:["DATABASE_URL"]}});
  await writeAutoBoundaryArtifacts({projectRoot,build});
  const shown:Array<{message:string;context:readonly string[];defaultValue:boolean|undefined}>=[];
  await boundaryReviewCommand(["--project-root",projectRoot,"--confirm","--actor","declared fixture operator"],async()=>inspection,{
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
    allowed:[{id:"items",description:"Show the reviewed item labels",plan:{kind:"rows",resource:"work.items",select:["label"]}}],forbidden:[]}});
  if(analysis.status!=="ready"||!analysis.candidate)throw new Error("Actual Read compiler did not produce the declared fixture");
  return{inspection,build,context,analysis,shown};
}
