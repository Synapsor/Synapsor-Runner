import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadActivatedExplorationBoundaries } from "./auto-boundary.js";
import { expect,it } from "vitest";
import { prepareReviewedReadScope } from "./test-fixtures/reviewed-read-scope.js";
it("prepares real structural signoffs and an actual compiler candidate for native scope fixtures",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"native-scope-structure-"));await fs.chmod(root,0o700);
 try{const f=await prepareReviewedReadScope(root);
  await expect(loadActivatedExplorationBoundaries(root)).rejects.toMatchObject({code:"ENOENT"});
  expect(f.context.progress!.confirmations.length).toBeGreaterThan(0);expect(f.context.bundle.outstanding_decision_ids).toEqual([]);
  expect(f.analysis.status).toBe("ready");expect(f.analysis.candidate?.pack.resources[0]?.id).toBe("work.items");
  expect(f.analysis.authority_granted).toBe(false);expect(f.analysis.source_query_executed).toBe(false);expect(f.analysis.source_database_changed).toBe(false);
  expect(f.shown.some(view=>view.context.some(line=>line.includes("work.items")))).toBe(true);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
