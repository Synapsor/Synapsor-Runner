import { assertBoundaryAuthoringResumeMaterial } from '../../../apps/runner/src/boundary-authoring-resume.js';
import { writeFileSync } from 'node:fs';
const cases = ['The per-league limit is scoped to the tenant: maximum 2 in 86,400 seconds, shared across referees in that league.', 'The per-league limit is scoped to the tenant, with maximum 2 in 86,400 seconds, shared across referees in that league.'];
const results=cases.map(explanation=>{try{assertBoundaryAuthoringResumeMaterial({explanation});return {explanation,accepted:true};}catch(error){return {explanation,accepted:false,error:String(error)};}});
writeFileSync(new URL('./checkpoint-prose-reproduction.json',import.meta.url),JSON.stringify({classification:'READ_ONLY_SOURCE_DIAGNOSTIC; installed failure is separately preserved',results},null,2)+'\n');
console.log(JSON.stringify(results));
