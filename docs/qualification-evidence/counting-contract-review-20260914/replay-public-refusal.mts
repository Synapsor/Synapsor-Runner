// Read-only replay of the exact installed submissions. No provider call, source
// mutation, synthetic successful reply, policy save or authority operation.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parsePolicyCoverage } from "../../../apps/runner/src/authoring-policy-coverage.js";
import { resolveCountingComparison } from "../../../apps/runner/src/authoring-counting-review.js";
const root = path.dirname(fileURLToPath(import.meta.url));
const trace = JSON.parse(await fs.readFile(path.join(root, "installed-public-trace.json"), "utf8"));
for (const entry of trace.raw_files) assert.equal(createHash("sha256").update(await fs.readFile(entry.path)).digest("hex"), entry.sha256);
for (let index = 0; index < trace.replies.length; index++) {
  const suffix = String(index + 1).padStart(4, "0");
  const input = trace.raw_files.find((entry: any) => entry.path.endsWith(`/input-${suffix}.json`));
  const output = trace.raw_files.find((entry: any) => entry.path.endsWith(`/output-${suffix}.txt`));
  assert.deepEqual(JSON.parse(await fs.readFile(input.path, "utf8")).request, trace.requests[index]);
  const completed = (await fs.readFile(output.path, "utf8")).split("\n").flatMap(line => {
    if (!line.startsWith("data:")) return [];
    let event: any; try { event = JSON.parse(line.slice(5)); } catch { return []; }
    return event.type === "response.output_item.done" && event.item?.name === "runner__review_policy_coverage"
      ? [JSON.parse(event.item.arguments)] : [];
  });
  assert.deepEqual(completed, [trace.replies[index]]);
}
const results = trace.replies.map((reply: any, index: number) => {
  const draft = trace.drafts[index];
  let error: string | undefined;
  try { parsePolicyCoverage(reply, trace.source, draft, trace.operator_messages); }
  catch (caught) { error = String(caught); }
  assert(error?.includes("Counter disposition must match the actual versus required filter"));
  const counter = reply.passages.find((p: any) => p.counter_requirements?.length);
  assert(counter);
  const support = trace.operator_messages[counter.operator_message_id - 1];
  const interpretations = draft.runner_evidence.counting_interpretations;
  const matching = interpretations.filter((p: any) => p.operator_support.answer === support);
  assert.equal(matching.length, 0);
  assert.equal(resolveCountingComparison(counter, trace.source, draft, support), undefined);
  return { call: index + 1, error, submitted_counter_passage: counter,
    submitted_operator_message: { id: counter.operator_message_id, text: support },
    applicable_interpretation_support: interpretations.map((p: any) => ({
      id: trace.operator_messages.indexOf(p.operator_support.answer) + 1,
      question: p.operator_support.question, answer: p.operator_support.answer,
    })),
    matching_scoped_support_count: matching.length,
    first_failed_resolution_precondition: "The submitted passage cites a different supporting answer from the established scoped counting interpretation.",
    additional_static_guard_observation: {
      broader_approval_pointer: counter.draft_paths.includes("/actions/0/approval"),
      explanation: "This pointer is also outside the narrow counter-only passage contract. The exact replay stops at missing matching support first; no altered-response experiment was performed.",
    }, domain: draft.runner_evidence.runtime_contract.approval_counter_selection.outcome_domain };
});
if (process.argv.includes("--save")) await fs.writeFile(path.join(root, "installed-public-refusal-replay.json"), JSON.stringify({
  at: new Date().toISOString(), artifact_tree: trace.artifact_tree,
  classification: "Host diagnostic replay of exact failed installed responses; expected refusal reproduced, not public success",
  provider_calls: 0, product_or_saved_job_changed: false, results,
}, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ exact_failed_responses_reproduced: results.length,
  classification: "expected-refusal diagnostic, not a passing installed review", provider_calls: 0 }));
