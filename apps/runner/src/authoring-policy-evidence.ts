import { hasReviewedPrincipalScope, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { CompiledActionRuleModelDraftV1 } from "./action-rule-draft.js";
import { readBoundaryRevisionCatalog } from "./read-boundary-revision-model.js";

/** Evidence for authoring review, derived from the current typed candidates. No
 * runtime identities, rows, credentials or model assertions belong here. */
export function policyCoverageDraft(input: {
  read: ExplorationBoundaryDraft;
  decisions: Array<{ decision: string; confirmed: boolean }>;
  actions: CompiledActionRuleModelDraftV1[];
}) {
  const catalog = readBoundaryRevisionCatalog(input.read);
  return {
    read: input.read,
    actions: input.actions.map((action) => action.draft),
    runner_evidence: {
      read_review: {
        meaning: "read.unresolved_decisions lists candidate review requirements, NOT current outstanding decisions. The following current digest-bound review status is authoritative for their confirmation, not activation.",
        confirmed: input.decisions.filter((decision) => decision.confirmed).map((decision) => decision.decision),
        pending: input.decisions.filter((decision) => !decision.confirmed).map((decision) => decision.decision),
        activation: "separate_operator_review",
      },
      privacy_review: catalog.resources.flatMap((resource) => resource.fields.filter((field) => field.roles.some((role) => role !== "trusted_scope")
        && (field.raw_return || field.model_operations.length)).map((field) => ({ resource: resource.id, field: field.id,
        role_candidates: field.roles, actual_values_returned: field.raw_return, model_analysis: field.model_operations,
        meaning: "Potential internal/control field with model access. Check the source privacy rule against actual metadata and business meaning; a name candidate is not proof. Do not call a broad privacy requirement implemented while required private fields are exposed.",
      }))),
      read_access: Object.fromEntries(catalog.resources.map((resource) => {
        const raw = input.read.pack.resources.find((entry) => entry.id === resource.id)!;
        return [resource.id, { resource: resource.id, label: resource.label ?? null, description: resource.description ?? null,
          trusted_tenant_field: raw.tenant_key ?? null, trusted_principal_field: raw.principal_key ?? null,
          database_session_scope: raw.rls_session ?? null,
          principal_scope_configured: hasReviewedPrincipalScope(raw),
          fields: Object.fromEntries(resource.fields.map((field) => [field.id, { field: field.id, label: field.label ?? null, description: field.description ?? null,
            actual_values_returned: field.raw_return, model_analysis: field.model_operations,
            private_read_selection: field.row_selection && !field.raw_return, kept_out: field.current_exposure === "kept_out",
            role_candidates: field.roles,
          }])),
        }] as const;
      })),
      actions: Object.fromEntries(input.actions.map((action) => [action.rule.outcome, {
        outcome: action.rule.outcome,
        scoped_bindings: Object.fromEntries(action.verification_boundary.resources.map((resource) => [resource.binding, {
          binding: resource.binding, resource: resource.resource, scope: resource.scope, source: resource.source,
          row_identity: resource.primary_key, conflict_field: resource.version_field ?? null,
          fields: Object.fromEntries(resource.fields.map((field) => [field.name, { name: field.name, model_visible: field.model_visible }])),
        }])),
        automatic_limits: (action.draft.approval.shared_limits ?? []).map((limit) => ({
          ...limit,
          ...(limit.scope === "tenant" || limit.scope === "tenant_principal" ? {
            tenant_bindings: action.verification_boundary.resources.filter((resource) => resource.scope.mode === "columns")
              .map((resource) => ({ resource: resource.resource,
                field: resource.scope.mode === "columns" ? resource.scope.tenant_field : null })),
            explanation: "This ledger scope groups by the SAME trusted tenant value used for these exact field bindings. It is not a second or broader business tenant. Use reviewed labels/relationships to interpret its business meaning; do not assume tenant means account in other deployments.",
          } : {}),
        })),
        effect: { target_resource: action.effect_envelope.target_resource,
          target_binding: action.effect_envelope.target_binding ?? null,
          operation: action.effect_envelope.operation,
          fields: action.effect_envelope.allowed_fields.map((field) => field.name),
          unrelated_fields: "not authorized for modification by this envelope",
        },
        execution: {
          configured_mode: action.effect_envelope.writeback.mode,
          supported_automatic_completion: action.effect_envelope.writeback.mode === "direct_sql",
          activation: "separate_operator_review",
          prerequisites: ["reviewed writer", "execution enabled for this exact Action revision", "running worker"],
          semantics: "With direct_sql configured and separately enabled, the worker processes approved requests without a per-request staff step. Approval alone is not completion. A disabled configuration is prepared behavior, not missing business logic.",
        },
      }])),
      runtime_contract: {
        approval: "Automatic approval counts are taken atomically from Runner's proposal/approval ledger with the configured scope, capability and window. Limits govern automatic approval, not authorized human fallback. Invalid eligibility is refused before approval.",
        request_identity: "The fixed request_change operation accepts outcome, scoped subject_refs and reviewed business inputs, not a client-supplied request ID. Repeating the same claimed references, outcome and inputs reuses the recorded proposal. New references or a different reviewed request are not an unlimited delivery-retry exemption. Execution uses the sealed proposal's idempotency identity.",
        conflict_protection: "Runner records immutable eligibility/effect evidence, re-verifies current facts and approved effect at execution, and checks configured version fields. A changed version or changed approved effect refuses stale execution; do not require duplicate equality predicates in require for these Runner-owned checks.",
        receipts: "Runner's control ledger records processing and execution receipts, separately from source effects. A second source-table audit INSERT is not required. request_change distinguishes queued/human_review/not_enabled/completed; completed requires applied state. Pending/failed is not completed.",
        client_responsibilities: "The application authenticates the person, supplies trusted session identity, captures their selection and uses returned execution status/receipts for messages. A scoped subject reference authorizes one reviewed row; it does not prove the human clicked a UI. When an effective date is in the future, recording the change is not proof its benefits are already in force. Boundary rules cannot prove arbitrary client UI wording.",
      },
    },
  };
}
