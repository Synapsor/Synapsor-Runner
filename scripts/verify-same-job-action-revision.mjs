#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inspectDatabase } from "../packages/schema-inspector/dist/index.js";
import { canonicalJsonDigest } from "../packages/protocol/dist/index.js";
import { loadBoundaryReviewContext } from "../apps/runner/dist/boundary-commands.js";
import { explorationBoundaryCandidateDigest } from "../apps/runner/dist/auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "../apps/runner/dist/action-rule-authoring.js";
import { actionRuleModelDraftFromAuthority, compileActionRuleModelDraft } from "../apps/runner/dist/action-rule-draft.js";
import { generateModelActionRuleDraft } from "../apps/runner/dist/action-rule-model.js";
import { createModelAuthoringConversation } from "../apps/runner/dist/model-authoring-conversation.js";

// Opt-in reproduction using a paused telecom job. All saved artifacts are read-only.
const root = process.env.SYNAPSOR_TEST_PROJECT;
assert.ok(root && process.env.DATABASE_URL, "Set SYNAPSOR_TEST_PROJECT and the metadata-only DATABASE_URL reader.");
const resumeFile = path.join(root, ".synapsor/boundary-authoring/resume.json");
const authorityFile = path.join(root, ".synapsor/action-rules/drafts/reviewed_staging_rules/authority.json");
const resumeBytes = await readFile(resumeFile, "utf8");
const authorityBytes = await readFile(authorityFile, "utf8");
const resume = JSON.parse(resumeBytes);
const saved = JSON.parse(authorityBytes);
assert.equal(resume.stage, "action_drafting");
assert.equal(resume.action.completed_outcomes.length, 1);
assert.equal(resume.action.intents.length, 3);
const outcome = resume.action.completed_outcomes[0];
const { outcome: _outcome, ...review } = saved.reviews.find((entry) => entry.outcome === outcome);
const boundary = (await loadBoundaryReviewContext(root)).candidate;
const inspection = await inspectDatabase({ engine: "postgres", schema: "telecom", databaseUrlEnv: "DATABASE_URL" });
const builtCatalog = buildActionRuleAuthoringCatalog({ boundary, inspection, retainedCatalog: saved.authority.catalog });
const baseline = compileActionRuleModelDraft({
  draft: actionRuleModelDraftFromAuthority({ authority: saved.authority, outcome, review }),
  builtCatalog, readBoundary: boundary, readBoundaryDigest: explorationBoundaryCandidateDigest(boundary),
}).draft;
const questions = [];
const tools = [];
const result = await generateModelActionRuleDraft({
  session: { provider: process.env.SYNAPSOR_LIVE_AUTHORING_PROVIDER ?? "openai",
    model: process.env.SYNAPSOR_LIVE_AUTHORING_MODEL ?? "gpt-5.6-terra",
    ...(process.env.SYNAPSOR_LIVE_AUTHORING_BASE_URL ? { baseUrl: process.env.SYNAPSOR_LIVE_AUTHORING_BASE_URL } : {}),
    conversation: createModelAuthoringConversation(resume.conversation),
    dependencies: { onProgress: (event) => { if (event.tool) { tools.push(event.tool); process.stdout.write(`TOOL ${event.tool}\n`); } } },
  },
  intent: resume.action.intents[1], pendingIntents: resume.action.intents.slice(1),
  preparedDrafts: [baseline], reservedOutcomes: [outcome], checkpoint: resume.action.checkpoint,
  builtCatalog, readBoundary: boundary, readBoundaryDigest: explorationBoundaryCandidateDigest(boundary),
  egressAcknowledged: true, signal: AbortSignal.timeout(240_000),
  askClarification: async (question) => {
    questions.push(question);
    process.stdout.write(`QUESTION ${question}\n`);
    assert.ok(questions.length <= 2, "The same policy clarification must not loop.");
    assert.doesNotMatch(question, /distinct outcome|new outcome name|cannot (?:edit|replace)|separate exception action/iu);
    return "Edit the same disabled plan-change action. The selected offer must belong to the customer's subscription, match its current plan, be active, have started and not have expired. Derive the subscription change from that offer. Auto-approve and complete offers marked eligible within 10 overall and 3 per customer account per rolling 24 hours; send every other valid request, including limit overruns, to one customer_service reviewer. Invalid offers are refused. No separate exception or refusal action. Preserve the effect, scope and all other settings. Keep all authority disabled for review.";
  },
});
assert.equal(result.compiled.rule.outcome, outcome);
assert.equal(result.revision.reopened_draft.digest, canonicalJsonDigest(baseline));
assert.deepEqual(result.revision.reopened_draft.covered_intent_indexes.sort(), [0, 1]);
assert.deepEqual(result.compiled.draft.effect, baseline.effect);
assert.equal(result.compiled.draft.effect.writeback, "supervised");
assert.doesNotMatch(JSON.stringify(result.compiled.draft.require), /auto_approval_eligible/);
assert.match(JSON.stringify(result.compiled.draft.require), /valid_from/);
assert.match(JSON.stringify(result.compiled.draft.require), /expires_at/);
assert.match(JSON.stringify(result.compiled.draft.require), /source_plan_code/);
assert.match(JSON.stringify(result.compiled.draft.approval.auto_approve_when), /auto_approval_eligible/);
assert.equal(result.compiled.draft.approval.mode, "policy");
assert.equal(result.compiled.draft.approval.required_approvals, 1);
assert.equal(result.compiled.draft.approval.required_role, "customer_service");
for (const [scope, maximum] of [["capability", 10], ["tenant", 3]]) {
  assert.ok(result.compiled.draft.approval.shared_limits.some((limit) => limit.kind === "count" && limit.scope === scope
    && limit.maximum === maximum && limit.window_seconds === 86400));
}
assert.equal(result.authority_granted, false);
assert.equal(result.source_database_changed, false);
assert.equal(await readFile(resumeFile, "utf8"), resumeBytes);
assert.equal(await readFile(authorityFile, "utf8"), authorityBytes);
process.stdout.write(`PASS: one revised telecom outcome, preserved execution intent, ${questions.length} questions; saved job unchanged.\n`);
