import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { it, expect } from "vitest";
const execute=promisify(execFile);
it("cold process preserves actual B64 Action clarification completion and refuses changed material before replay",async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),"b64-action-question-process-"));await fs.chmod(root,0o700);
 const driver=fileURLToPath(new URL("../dist/test-fixtures/typed-action-clarification-process.js",import.meta.url));
 try {
  const run=async(mode:string)=>{await execute(process.execPath,[driver,root,mode],{timeout:15000,env:{PATH:process.env.PATH,HOME:root,TMPDIR:root}});
   return JSON.parse(await fs.readFile(path.join(root,`result-${mode}.json`),"utf8"));};
  const first=await run("create");expect(first.error).toContain("CANCELLED");expect(first.requests).toBe(1);expect(first.prompts).toBe(1);
  expect(first.checkpoint.pending_question.completion).toBeDefined();
  expect(first.checkpoint.logical_turns.at(-1).completed.kind).toBe("ordinary_clarification");
  expect(first.generation.operations.find((op:{id:string})=>op.id===first.checkpoint.pending_question.completion.operation_id).state).toBe("checkpointed");
  const resumed=await run("resume");expect(resumed.pid).not.toBe(first.pid);expect(resumed.error).toContain("CANCELLED");
  expect(resumed.requests).toBe(0);expect(resumed.prompts).toBe(1);expect(resumed.before).toBe(resumed.after);
  expect(resumed.checkpoint).toEqual(first.checkpoint);expect(resumed.generation).toEqual(first.generation);expect(resumed.material).toBe(first.material);
  const stale=await run("stale");expect(stale.error).toContain("ACTION_AUTHORING_CHECKPOINT_STALE");expect(stale.requests).toBe(0);expect(stale.prompts).toBe(0);
  expect(stale.before).toBe(stale.after);expect(stale.checkpoint).toEqual(first.checkpoint);
 } finally {await fs.rm(root,{recursive:true,force:true});}
});
