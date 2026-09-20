import fs from "node:fs/promises";
import { countingSourceRequirements } from "../../../apps/runner/src/authoring-counting-requirements.js";
import { parsePolicyCoverage,collectCoverageFeedback } from "../../../apps/runner/src/authoring-policy-coverage.js";
const original=JSON.parse(await fs.readFile(new URL("../../../apps/runner/src/test-fixtures/faithful-current-description.json",import.meta.url),"utf8"));
const {context,response}=structuredClone(original),sources=context.source_document,source=sources.snapshots.find(s=>s.version===sources.active),draft=context.draft;
const corrected=structuredClone(response); for(const c of corrected.passages[9].counter_requirements)c.current_capability=c.required_capability="release.clear_assessment";
let correctionResult;try{parsePolicyCoverage(corrected,source,draft,sources.operator_messages);correctionResult="accepted";}catch(e){correctionResult=e.message;}
console.log(JSON.stringify({classification:"Exact old capture; separately derived faithful current/required values, no provider or persistence",source_digest:source.digest,requirements:countingSourceRequirements(source,draft,sources.operator_messages),original_feedback:collectCoverageFeedback(response,source,draft,sources.operator_messages),corrected_result:correctionResult},null,2));
