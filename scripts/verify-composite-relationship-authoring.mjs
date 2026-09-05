#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { inspectDatabase } from "../packages/schema-inspector/dist/index.js";
import { canonicalJsonDigest } from "../packages/protocol/dist/index.js";
import { buildActionRuleAuthoringCatalog } from "../apps/runner/dist/action-rule-authoring.js";
import { generateModelActionRuleDraft } from "../apps/runner/dist/action-rule-model.js";

// Opt-in metadata-only qualification against the unchanged telecom tutorial.
assert.ok(process.env.SYNAPSOR_TEST_BOUNDARY_FILE, "Set SYNAPSOR_TEST_BOUNDARY_FILE to a disposable or read-only tutorial Boundary snapshot.");
assert.ok(process.env.DATABASE_URL, "Set DATABASE_URL to the tutorial reader role. No runtime identity or writer credential is used.");
const bytes = await readFile(process.env.SYNAPSOR_TEST_BOUNDARY_FILE, "utf8");
const boundary = JSON.parse(bytes);
const inspection = await inspectDatabase({ engine: "postgres", schema: "telecom", databaseUrlEnv: "DATABASE_URL" });
const built = buildActionRuleAuthoringCatalog({ boundary, inspection });
const link = built.catalog.relationships.find((candidate) => candidate.from_resource === "telecom.plan_change_offers" && candidate.to_resource === "telecom.subscriptions");
assert.deepEqual(link?.field_pairs, [{ local_field: "account_id", target_field: "account_id" }, { local_field: "subscription_id", target_field: "subscription_id" }]);
const tools = [];
const questions = [];
const reviewed = [];
const provider = process.env.SYNAPSOR_LIVE_AUTHORING_PROVIDER ?? "openai";
const model = process.env.SYNAPSOR_LIVE_AUTHORING_MODEL ?? "gpt-5.6-terra";
const result = await generateModelActionRuleDraft({
  session: { provider, model,
    ...(process.env.SYNAPSOR_LIVE_AUTHORING_BASE_URL ? { baseUrl: process.env.SYNAPSOR_LIVE_AUTHORING_BASE_URL } : {}),
    dependencies: { onProgress: (event) => { if (event.tool) { tools.push(event.tool); process.stdout.write(`TOOL ${event.tool}\n`); } } } },
  intent: "I want a customer-service agent that helps signed-in customers understand their account, bills, services, support history, and available plan options. When a customer chooses a plan currently offered to them, switch them to it. Automatically approve and complete routine eligible changes. Send changes requiring an exception to a human for review, and reject changes the customer isn't eligible for.",
  builtCatalog: built, readBoundary: boundary, readBoundaryDigest: canonicalJsonDigest(boundary), egressAcknowledged: true,
  signal: AbortSignal.timeout(240_000),
  onRelationshipReview: (lines) => reviewed.push(lines),
  askClarification: async (question) => {
    questions.push(question);
    process.stdout.write(`QUESTION ${question}\n`);
    assert.ok(questions.length <= 4, "Repeated questions did not resolve the job.");
    assert.doesNotMatch(question, /expose .*relationship|join columns|add .*foreign key|which .*binding|paste .*SQL/iu, "The model must resolve existing relationship mechanics itself.");
    return "Active offers are selectable while unexpired and still applicable to the customer's current plan. Use the system's approval history: automatically approve no more than 10 plan changes overall and no more than 3 for the same customer account in any rolling 24 hours. Routine offers are those marked automatically approvable. Other eligible offers need one support reviewer; expired, withdrawn or no-longer-applicable offers must be rejected. Use the offered plan for its own subscription. Enable reviewed automatic execution, but this authoring test must not activate anything or change source data.";
  },
});
assert.equal(result.state, "ready");
assert.equal(result.authority_granted, false);
assert.equal(result.source_database_changed, false);
assert.equal(result.compiled.effect_envelope.target_resource, "telecom.subscriptions");
assert.equal(result.compiled.effect_envelope.operation, "update");
assert.deepEqual(result.compiled.effect_envelope.writeback, { mode: "direct_sql", supervised_worker: "allowed" },
  "Automatic completion must prepare separately reviewed execution, not silently become approval-only.");
const target = result.compiled.verification_boundary.resources.find((resource) => resource.binding === result.compiled.effect_envelope.target_binding);
assert.equal(target.source.kind, "relationship", "Target must come from the selected offer, not an unrelated subject reference.");
assert.equal(target.source.relationship, link.name);
assert.deepEqual(target.source.field_pairs, link.field_pairs);
assert.equal(target.cardinality, "one");
assert.equal(result.compiled.approval_class.mode, "policy");
for (const [scope, maximum] of [["capability", 10], ["tenant", 3]]) {
  assert.ok(result.compiled.approval_class.shared_limits.some((limit) => limit.kind === "count" && limit.scope === scope && limit.maximum === maximum && limit.window_seconds === 86400), `Missing ${scope} approval limit`);
}
assert.equal(await readFile(process.env.SYNAPSOR_TEST_BOUNDARY_FILE, "utf8"), bytes, "Qualification must not edit the operator's Boundary file.");
process.stdout.write(`PASS ${provider}[${model}]: exact telecom composite related UPDATE; ${questions.length} business questions; ${reviewed.length} relationship detail records; authority disabled; no rows read or written.\n`);
