#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { inspectDatabase } from "../packages/schema-inspector/dist/index.js";
import { canonicalJsonDigest } from "../packages/protocol/dist/index.js";
import { loadBoundaryReviewContext, prepareModelReadBoundaryExposureRevision } from "../apps/runner/dist/boundary-commands.js";
import { explorationBoundaryCandidateDigest, generationLockSharedFactsDigest } from "../apps/runner/dist/auto-boundary.js";
import { generateModelReadBoundaryRevision } from "../apps/runner/dist/read-boundary-revision-model.js";
import { buildActionRuleAuthoringCatalog } from "../apps/runner/dist/action-rule-authoring.js";
import { actionRuleModelDraftFromAuthority, compileActionRuleModelDraft } from "../apps/runner/dist/action-rule-draft.js";

// Opt-in telecom reproduction. Previews only: no artifact save, activation,
// source-row read, or write. Set SYNAPSOR_LIVE_PRIVACY_PROVIDER for a real model.
const root = process.env.SYNAPSOR_TEST_PROJECT;
assert.ok(root && process.env.DATABASE_URL, "Set SYNAPSOR_TEST_PROJECT and the metadata-only DATABASE_URL reader.");
const beforeFiles = await snapshot(root);
try {
  const context = await loadBoundaryReviewContext(root);
  const original = structuredClone(context.candidate);
  const saved = JSON.parse(await readFile(path.join(root, ".synapsor/action-rules/drafts/reviewed_staging_rules/authority.json"), "utf8"));
  assert.equal(saved.state, "disabled");
  assert.equal(saved.authority.rules.length, 1);
  const inspection = await inspectDatabase({ engine: "postgres", schema: "telecom", databaseUrlEnv: "DATABASE_URL" });
  const initialCatalog = buildActionRuleAuthoringCatalog({ boundary: original, inspection, retainedCatalog: saved.authority.catalog });
  const { outcome, ...review } = saved.reviews[0];
  const baseline = compileActionRuleModelDraft({
    draft: actionRuleModelDraftFromAuthority({ authority: saved.authority, outcome, review }),
    builtCatalog: initialCatalog, readBoundary: original, readBoundaryDigest: explorationBoundaryCandidateDigest(original),
  });
  const expected = {
    account_memberships: ["membership_id", "subscriber_id", "updated_at"],
    accounts: ["updated_at", "version"],
    billing_preferences: ["billing_preference_id", "updated_at", "version"],
    invoices: ["invoice_id", "updated_at"],
    payments: ["payment_id", "invoice_id"],
    plan_change_offers: ["plan_offer_id", "subscription_id", "auto_approval_eligible", "target_data_policy", "updated_at", "version"],
    service_lines: ["line_id", "subscriber_id", "updated_at", "version"],
    subscribers: ["subscriber_id", "updated_at"],
    subscriptions: ["subscription_id", "data_policy", "updated_at", "version"],
    support_case_notes: ["note_id", "case_id", "proposal_id"],
    support_cases: ["case_id", "assigned_agent_id", "note_policy_units", "updated_at", "version"],
  };
  const expectedKeys = Object.entries(expected).flatMap(([table, fields]) => fields.map((field) => `telecom.${table}.${field}`)).sort();
  assert.equal(expectedKeys.length, 36);
  let preview;
  let compiled;
  let requestCount = 0;
  const provider = process.env.SYNAPSOR_LIVE_PRIVACY_PROVIDER;
  const result = await generateModelReadBoundaryRevision({
    instruction: "Keep internal database IDs, version fields, and private approval controls hidden from the agent, but available to Runner where needed. Keep useful customer-facing information and references visible. Preserve the plan-change rules, approval limits, and automatic-completion setup.",
    provider: provider ?? "openai", model: process.env.SYNAPSOR_LIVE_PRIVACY_MODEL ?? "gpt-5.6-terra",
    ...(!provider ? { apiKey: "test-only" } : {}),
    ...(process.env.SYNAPSOR_LIVE_PRIVACY_BASE_URL ? { baseUrl: process.env.SYNAPSOR_LIVE_PRIVACY_BASE_URL } : {}),
    boundary: context.candidate, egressAcknowledged: true, signal: AbortSignal.timeout(240_000),
    clarificationHandler: async ({ question }) => { throw new Error(`Unexpected clarification: ${question}`); },
    validateRevision: async (revision) => {
      preview = await prepareModelReadBoundaryExposureRevision({
        projectRoot: root, context, revision, schemaInspector: async () => inspection,
        validateCandidate: (candidate, lock) => {
          assert.equal(generationLockSharedFactsDigest(lock), generationLockSharedFactsDigest(context.lock));
          assert.equal(canonicalJsonDigest(context.lock), saved.authority.catalog.generation_lock_fingerprint);
          const retainedCatalog = { ...structuredClone(saved.authority.catalog), generation_lock_fingerprint: candidate.generation_lock_fingerprint };
          compiled = compileActionRuleModelDraft({ draft: baseline.draft,
            builtCatalog: buildActionRuleAuthoringCatalog({ boundary: candidate, inspection, retainedCatalog }),
            readBoundary: candidate, readBoundaryDigest: explorationBoundaryCandidateDigest(candidate),
          });
        },
      });
    },
    ...(!provider ? { dependencies: { requestJson: async (request) => {
      requestCount += 1;
      if (requestCount === 2) assert.match(JSON.stringify(request), /membership_id is marked runner_only, but settings.selectable_fields removes Runner's access/);
      return { status: 200, body: { output: [{ type: "function_call", call_id: "privacy",
        name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: Object.entries(expected).map(([table, fields]) => ({
          resource: `telecom.${table}`, field_exposure: fields.map((field) => ({ field, exposure: "runner_only" })),
          ...(requestCount === 1 && table === "account_memberships" ? { settings: { selectable_fields: ["membership_role", "status", "joined_at"] } } : {}),
        })) }),
      }] } };
    } } } : {}),
  });
  assert.ok(preview && compiled);
  assert.deepEqual(result.changes.map((change) => `${change.resource}.${change.field}`).sort(), expectedKeys);
  assert.ok(result.changes.every((change) => change.before === "model_and_runner" && change.after === "runner_only"));
  assert.deepEqual(result.policy_changes ?? [], []);
  assert.deepEqual(preview.semantic_diff.flatMap((diff) => diff.added_model_withheld_fields.map((field) => `${diff.resource_id}.${field}`)).sort(), expectedKeys);
  for (const before of original.pack.resources) {
    const after = preview.candidate.pack.resources.find((resource) => resource.id === before.id);
    assert.ok(after);
    assert.deepEqual([...after.selectable_fields].sort(), [...new Set([...before.selectable_fields, ...expected[before.table]])].sort());
    assert.deepEqual(after.kept_out_fields, before.kept_out_fields);
    assert.deepEqual(after.relationships, before.relationships);
    assert.equal(after.tenant_key, before.tenant_key);
    assert.equal(after.principal_key, before.principal_key);
    assert.deepEqual(after.rls_session, before.rls_session);
    assert.deepEqual([...after.model_withheld_fields].sort(), [...new Set([...(before.model_withheld_fields ?? []), ...expected[before.table]])].sort());
    for (const field of ["invoice_number", "case_number", "payment_reference", "plan_name"]) {
      if (before.selectable_fields.includes(field)) assert.ok(!after.model_withheld_fields.includes(field));
    }
  }
  assert.deepEqual(preview.candidate.budgets, original.budgets);
  assert.deepEqual(compiled.draft, baseline.draft);
  assert.equal(compiled.draft.effect.writeback, "supervised");
  assert.equal(compiled.draft.approval.mode, "policy");
  for (const [scope, maximum] of [["capability", 10], ["tenant", 3]]) {
    assert.ok(compiled.draft.approval.shared_limits.some((limit) => limit.scope === scope && limit.maximum === maximum && limit.window_seconds === 86400));
  }
  assert.equal(preview.candidate.activation, "disabled_unreviewed");
  assert.equal(result.authority_granted, false);
  assert.deepEqual(context.candidate, original);
  if (!provider) { assert.equal(requestCount, 2); assert.equal(result.correction_used, true); }
  console.log(`PASS ${provider ?? "injected correction"}: exact 36-field candidate and diff; business references, private verification, rules, limits and supervised execution preserved.`);
} finally {
  assert.deepEqual(await snapshot(root), beforeFiles, "Saved user project changed during the read-only test; do not overwrite concurrent user changes.");
  console.log("Saved project unchanged. No activation, source-row read or source write.");
}

async function snapshot(root, relative = "") {
  const entries = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) entries.push(...await snapshot(root, name));
    else if (entry.isSymbolicLink()) entries.push([name, await readlink(path.join(root, name))]);
    else entries.push([name, createHash("sha256").update(await readFile(path.join(root, name))).digest("hex")]);
  }
  return entries.sort(([a], [b]) => a.localeCompare(b));
}
