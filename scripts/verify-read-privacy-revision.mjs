#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile, readlink } from "node:fs/promises";
import path from "node:path";
import { inspectDatabase } from "../packages/schema-inspector/dist/index.js";
import { canonicalJsonDigest } from "../packages/protocol/dist/index.js";
import { loadBoundaryReviewContext, prepareModelReadBoundaryExposureRevision } from "../apps/runner/dist/boundary-commands.js";
import { explorationBoundaryCandidateDigest, generationLockSharedFactsDigest } from "../apps/runner/dist/auto-boundary.js";
import { generateModelReadBoundaryRevision, readBoundaryRevisionCatalog, reviewedModelAnalysisOperations } from "../apps/runner/dist/read-boundary-revision-model.js";
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
  // Fixture semantics verified in db/01_schema.sql and db/03_seed.sql. These
  // are plan allowances, not private policy facts; no source rows are fetched.
  const benefits = new Set(["data_policy", "target_data_policy"]);
  const fieldCatalog = readBoundaryRevisionCatalog(original);
  const expected = Object.fromEntries(original.pack.resources.map((resource) => [resource.table,
    fieldCatalog.resources.find((item) => item.id === resource.id).fields.filter((field) =>
      field.current_exposure !== "kept_out" && !benefits.has(field.id)
      && (field.current_exposure === "runner_only" || field.roles.length)).map((field) => field.id),
  ]));
  const correctionResource = original.pack.resources.find((resource) => expected[resource.table].some((field) => resource.selectable_fields.includes(field)));
  let preview;
  let compiled;
  let requestCount = 0;
  const provider = process.env.SYNAPSOR_LIVE_PRIVACY_PROVIDER;
  const result = await generateModelReadBoundaryRevision({
    instruction: "Keep internal database IDs, version fields and private approval controls private, with no model filters, sorting, grouping or aggregates on them. Keep Runner verification access. Leave already kept-out fields excluded. Keep useful customer-facing information and references visible. data_policy and target_data_policy describe customer plan data allowances, not approval controls: make these benefits visible for review if currently hidden. Preserve all other business fields, existing plan-change rules, approval limits and automatic-completion setup.",
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
      if (requestCount === 2) assert.match(JSON.stringify(request), /settings.selectable_fields removes Runner's access/);
      return { status: 200, body: { output: [{ type: "function_call", call_id: "privacy",
        name: "runner__submit_read_boundary_revision", arguments: JSON.stringify({ resource_changes: Object.entries(expected).map(([table, fields]) => ({
          resource: `telecom.${table}`, field_exposure: [...fields.map((field) => ({ field, exposure: "runner_only" })),
            ...original.pack.resources.find((item) => item.table === table).model_withheld_fields?.filter((field) => benefits.has(field)).map((field) => ({ field, exposure: "model_and_runner" })) ?? []],
          ...(requestCount === 1 && table === correctionResource?.table ? { settings: { selectable_fields: [] } } : {}),
        })) }),
      }] } };
    } } } : {}),
  });
  assert.ok(preview && compiled);
  assert.ok(result.changes.length);
  for (const before of original.pack.resources) {
    const after = preview.candidate.pack.resources.find((resource) => resource.id === before.id);
    assert.ok(after);
    assert.deepEqual([...after.selectable_fields].sort(), [...before.selectable_fields].sort(), "Privacy must not add unselected fields merely to preserve separately reviewed Action facts.");
    assert.deepEqual(after.kept_out_fields, before.kept_out_fields);
    assert.deepEqual(after.relationships, before.relationships);
    assert.equal(after.tenant_key, before.tenant_key);
    assert.equal(after.principal_key, before.principal_key);
    assert.deepEqual(after.rls_session, before.rls_session);
    for (const field of expected[before.table]) {
      assert.ok(!after.selectable_fields.includes(field) || after.model_withheld_fields.includes(field), `${before.id}.${field} must remain private`);
      assert.deepEqual(reviewedModelAnalysisOperations(after, field), [], `${before.id}.${field} must not permit model inference`);
    }
    for (const field of [...benefits, "invoice_number", "case_number", "payment_reference", "plan_name", "plan_display_name", "target_plan_display_name"]) {
      if (before.selectable_fields.includes(field)) assert.ok(!after.model_withheld_fields?.includes(field));
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
  console.log(`PASS ${provider ?? "injected correction"}: ${result.changes.length} validated field/operation changes; business benefits/references, private verification, rules, limits and supervised execution preserved.`);
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
