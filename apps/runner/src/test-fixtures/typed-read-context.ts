import { randomUUID } from "node:crypto";
import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { DEFAULT_REVIEWED_EXPLORATION_BUDGETS, type ExplorationBoundaryDraft } from "../auto-boundary.js";
import { generateModelReadWorkload, readWorkloadCatalog } from "../read-workload-model.js";
import { projectReadScopeHostContext } from "../read-current-evidence.js";
import { READ_SCOPE_PROTOCOL, type ReadScopeProposal } from "../read-structured-scope.js";
import { createReadScopeQuestion, proposeReadScopeReview, confirmReadScopeReview } from "../authoring-read-scope-question.js";
import { authoringReadCheckpoint, configureAuthoringGenerationRecovery, withAuthoringGenerationRecovery, type AuthoringTransportState } from "../authoring-generation-recovery.js";
import { readScopeConsumption } from "../authoring-read-scope-binding.js";
import type { OperatorQuestion } from "../authoring-operator-question.js";

/** Declared public facts and finite targets for a test's actual original request.
 * No English interpretation, analysis-to-expected-response conversion, or private oracle. */
export function declaredReadContext(request: string, resources: string[]) {
  const catalog = { resources: resources.map(id => ({ id, fields: [{ id: "name" }] })), relationships: [] };
  const context = projectReadScopeHostContext({ request: { id: "original-job", text: request }, catalog: { ...catalog, digest: d(catalog) },
    binding: { meaning_digest: d({ request, declared_field: "name" }), applicability_digest: d("declared test job"), operation_digest: d(catalog) } });
  const proposal: ReadScopeProposal = { protocol: READ_SCOPE_PROTOCOL, original_request: "original-job", applicability: "read_requested", requirements: resources.map((resource, index) => ({
    id: `names-${index}`, intended_use: `Show the names in ${resource}`, references: ["original-job"], disposition: "include", targets: [
      { root_resource: resource, resource, operation: "resource" }, { root_resource: resource, resource, operation: "return", field: "name" },
    ],
  })) };
  return { context, proposal, structuredScope: { protocol: READ_SCOPE_PROTOCOL, current: () => context } };
}

/** Real producer + compiler + consumed completion and native scope confirmation.
 * Preparation is scripted fixture setup; it is not a tested planning call. */
export async function preparedNativeReadContext(resources: string[]) {
  const request = `Show names from ${resources.join(", ")}.`;
  const declared = declaredReadContext(request, resources);
  const boundary: ExplorationBoundaryDraft = { schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed",
    deployment_profile: "staging", source: "local_postgres", compiler_version: "1.7.0", spec_version: "1.9.0", reporting_timezone: "UTC",
    trusted_context: { provider: "environment", tenant_env: "SYNAPSOR_TENANT_ID", principal_env: "SYNAPSOR_PRINCIPAL_ID" },
    generation_lock_fingerprint: d("fixture lock"), role_posture_fingerprint: d("fixture roles"),
    pack: { name: "reviewed_staging", resources: resources.map(id => ({ id, schema: id.split(".")[0]!, table: id.split(".")[1]!,
      primary_key: "id", tenant_key: "tenant_id", principal_key: "principal_id", field_types: { id: "uuid", tenant_id: "text", principal_id: "text", name: "text" },
      field_enums: {}, selectable_fields: ["name"], filterable_fields: {}, sortable_fields: [], groupable_fields: [], aggregate_measures: [],
      aggregate_measure_functions: {}, count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: [], relationships: [], minimum_cohort_size: 5, suppression_aware_totals: true })) },
    budgets: structuredClone(DEFAULT_REVIEWED_EXPLORATION_BUDGETS), unresolved_decisions: [] };
  const catalog = readWorkloadCatalog(boundary);
  const context = projectReadScopeHostContext({ request: { id: "original-job", text: request },
    catalog: { digest: catalog.digest, resources: catalog.resources, relationships: [] }, binding: declared.context.binding });
  let generation: AuthoringTransportState = { version: 1, operations: [] }, question: OperatorQuestion | undefined;
  const result = await withAuthoringGenerationRecovery(async () => {
    configureAuthoringGenerationRecovery({ available: () => true, read: () => generation, current: async () => d("prepared native context"),
      write: async next => { generation = structuredClone(next); } });
    return generateModelReadWorkload({ name: "saved_names", allowedQuestions: [request], provider: "openai", model: "scripted", apiKey: "inert-test-key",
      generatedBoundary: boundary, egressAcknowledged: true, deferNarration: true,
      structuredScope: { protocol: READ_SCOPE_PROTOCOL, current: () => context },
      dependencies: { requestJson: async () => ({ status: 200, body: { output: [{ type: "function_call", call_id: "prepare_native_read",
        name: "runner__submit_read_workloads", arguments: JSON.stringify({ read_scope: declared.proposal, forbidden: [],
          allowed: resources.map((resource, index) => ({ id: `names_${index}`, description: `Show names from ${resource}`,
            plan: { kind: "rows", resource, select: ["name"] } })) }) }] } }) },
      onCheckpoint: async (_checkpoint, _boundary, accepted, completion) => {
        if (!accepted) return;
        if (!accepted.read_scope || !completion) throw new Error("Missing actual typed producer completion");
        const pending = createReadScopeQuestion({ id: randomUUID(), revision: 1, scope_digest: d("prepared scope"), context_digest: completion.context_digest,
          read_scope: { mode: "review", record: accepted.read_scope, completion } });
        generation = authoringReadCheckpoint(generation, completion, readScopeConsumption(pending.read_scope!));
        const proposed = proposeReadScopeReview(pending, context.binding, accepted.analysis, context);
        question = confirmReadScopeReview(proposed, context.binding, accepted.analysis, proposed.digest, context);
      } });
  });
  if (!question) throw new Error("Missing actual confirmed scope");
  return { proposal: declared.proposal, structuredScope: { protocol: READ_SCOPE_PROTOCOL, current: () => ({ ...context,
    reusable: { questions: [question!], handoffs: [], generation, question_id: question!.id, analysis: result.analysis } }) } };
}
