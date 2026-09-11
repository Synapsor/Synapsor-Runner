import { hasReviewedPrincipalScope, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { actionRuleModelDraftFromAuthority, type CompiledActionRuleModelDraftV1 } from "./action-rule-draft.js";
import type { ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";
import { readBoundaryRevisionCatalog } from "./read-boundary-revision-model.js";
import type { ManagedMcpProjectClient } from "./managed-mcp-project.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { PolicyCoverage, PolicyPassage } from "./authoring-policy-source.js";
import { hasReviewedCustomerReadEntry, reviewedReadEntryPaths } from "./read-relationship-access.js";

/** Evidence for authoring review, derived from the current typed candidates. No
 * runtime identities, rows, credentials or model assertions belong here. */
export function policyCoverageDraft(input: {
  read: ExplorationBoundaryDraft;
  decisions: Array<{ decision: string; confirmed: boolean }>;
  actions: CompiledActionRuleModelDraftV1[];
  authority?: ActionRuleAuthorityDraftV1;
}) {
  const catalog = readBoundaryRevisionCatalog(input.read);
  // Coverage reviews the replacement bundle, not just newly authored entries.
  // Otherwise adding one outcome makes retained business rules appear missing.
  const actions: Array<Pick<CompiledActionRuleModelDraftV1, "draft" | "rule" | "verification_boundary" | "effect_envelope"> & { boundary_name: string }> = input.authority
    ? input.authority.authority.rules.map((entry) => {
      const review = input.authority!.reviews.find((item) => item.outcome === entry.rule.outcome);
      if (!review) throw new Error(`POLICY_COVERAGE_ACTION_REVIEW_MISSING: ${entry.rule.outcome} needs its saved review before the complete policy can be checked.`);
      return { boundary_name: input.authority!.authority.action_boundary.name,
        rule: entry.rule, verification_boundary: entry.verification_boundary, effect_envelope: entry.effect_envelope,
        draft: actionRuleModelDraftFromAuthority({ authority: input.authority!.authority, outcome: entry.rule.outcome,
          review, preserveVerificationFields: true }) };
    }) : input.actions.map((action) => ({ ...action, boundary_name: action.loaded.authority.action_boundary.name }));
  return {
    read: input.read,
    actions: actions.map((action) => action.draft),
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
          independently_queryable: !raw.relationship_only,
          reviewed_entry_paths: reviewedReadEntryPaths(input.read, raw.id),
          customer_scoped_access: hasReviewedCustomerReadEntry(input.read, raw.id),
          fields: Object.fromEntries(resource.fields.map((field) => [field.id, { field: field.id, label: field.label ?? null, description: field.description ?? null,
            actual_values_returned: field.raw_return, model_analysis: field.model_operations,
            private_read_selection: field.row_selection && !field.raw_return, kept_out: field.current_exposure === "kept_out",
            role_candidates: field.roles,
          }])),
        }] as const;
      })),
      actions: Object.fromEntries(actions.map((action) => [action.rule.outcome, {
        outcome: action.rule.outcome,
        scoped_bindings: Object.fromEntries(action.verification_boundary.resources.map((resource) => [resource.binding, {
          binding: resource.binding, resource: resource.resource, scope: resource.scope, source: resource.source,
          row_identity: resource.primary_key, conflict_field: resource.version_field ?? null,
          fields: Object.fromEntries(resource.fields.map((field) => [field.name, { name: field.name, model_visible: field.model_visible }])),
        }])),
        automatic_limits: (action.draft.approval.shared_limits ?? []).map((limit) => ({
          ...limit,
          applies_to_outcome: limit.capability === undefined || limit.capability === action.rule.outcome,
          history_selector: {
            action_boundary_name: action.boundary_name,
            approval_status: "approved",
            window_seconds: limit.window_seconds,
            time_bounds: "inclusive: now - window_seconds through now",
            capability: limit.capability ?? (limit.scope === "capability" ? action.rule.outcome : null),
            tenant: ["tenant", "tenant_principal", "tenant_object"].includes(limit.scope) ? "current_proposal.tenant_id" : null,
            principal: limit.scope === "tenant_principal" ? "current_proposal.principal" : null,
            business_object: limit.scope === "tenant_object" ? "current_proposal.business_object" : null,
            object_id: limit.scope === "tenant_object" ? "current_proposal.object_id" : null,
          },
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
          version_advance: action.effect_envelope.version_advance
            ? structuredClone(action.effect_envelope.version_advance) : null,
          source_fields_modified: [...new Set([
            ...action.effect_envelope.allowed_fields.map((field) => field.name),
            ...(action.effect_envelope.version_advance ? [action.effect_envelope.version_advance.column] : []),
          ])].sort(),
          unrelated_fields: "Fields outside source_fields_modified are not authorized for modification by this envelope. Version advancement is Runner-owned, not a caller-supplied business field.",
          ...(action.effect_envelope.atomic_updates ? { atomic_updates: action.effect_envelope.atomic_updates.map((effect, index) => ({
            target_resource: effect.target_resource, target_binding: effect.target_binding,
            fields: effect.allowed_fields.map((field) => field.name), set: action.rule.atomic_updates![index]!.set,
            source_fields_modified: [...effect.allowed_fields.map((field) => field.name), effect.version_advance.column].sort(),
            version_advance: effect.version_advance,
          })), transaction: "All listed updates share one verification, approval, transaction and receipt. Any failed update rolls back all changes. Permanent consumption requires an explicit change plus eligibility checking that changed fact." } : {}),
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
        read_eligibility: {
          trusted_record_scope_configured: input.read.pack.resources.length > 0
            && input.read.pack.resources.every((resource) => hasReviewedCustomerReadEntry(input.read, resource.id)
              && Boolean(resource.tenant_key || resource.rls_session?.tenant_setting || resource.tenant_scope)),
          record_scope_meaning: "customer_scoped_access and the reviewed tenant/principal mappings establish the configured restriction to the customer's permitted records. Runtime enforces these bindings on queries; actual session wiring is a separate deployment check. This is distinct from an additional current business fact such as admission, entitlement status or unrevoked consent. Do not infer that extra fact merely from the words authorized or permitted.",
          runner_private_source_predicates_supported: true,
          configured_current_state_prerequisite: input.read.read_prerequisite ?? null,
          supported_shape: "One private authoritative status register with a non-null unique trusted tenant/person pair, a reviewed positive enum status, and inclusive-start/exclusive-end UTC effective dates. Other business Read predicates remain unsupported here.",
          action_requirements_apply_to_reads: false,
          database_business_predicates_verified: false,
          database_business_predicates_meaning: "This flag makes no general claim about arbitrary business predicates. It does not negate trusted record-scope enforcement or the exact configured_current_state_prerequisite. Check the specific additional condition required by the source policy, if any, against that exact configuration.",
          meaning: "Read scope proves whose records may be accessed, not current eligibility. Only configured_current_state_prerequisite supplies Runner's private current-state Read condition: every data query transaction checks trusted subject, reviewed positive status and the current half-open effective interval; missing or non-qualifying evidence denies. A null configuration means this check is NOT implemented, despite engine support. Field filters, relationships, authentication and Action require conditions do not supply Read eligibility. Tenant/principal RLS metadata is not proof of extra business enforcement.",
          next_step: "If required Read evidence matches the supported shape but the configured prerequisite is null, use the model-guided Read revision to review its private source metadata and business meaning. Missing evidence keeps setup pending; unsupported shapes need a concrete support gap. Do not expose the register publicly, infer eligibility, waive the requirement or activate broader access. The disabled prerequisite still needs separate Read activation.",
        },
        approval: "Automatic approval counts are taken atomically from Runner's proposal/approval ledger with the configured scope, capability and window. Limits govern automatic approval, not authorized human fallback. Invalid eligibility is refused before approval.",
        approval_counter_selection: {
          evidence: "Each automatic_limits entry supplies its exact history_selector and applies_to_outcome, derived from the current compiled authority. Null selectors mean no filter, not missing configuration. Tenant/principal/object selectors reference the current trusted proposal; no runtime identity values are supplied here.",
          diagnostic_only: ["limit.id"],
          not_history_filters: ["limit.id", "approval_class", "action_boundary_digest"],
          semantics: "The evaluator selects approved history by Action Boundary name, inclusive time window and the listed optional capability/tenant/principal/object filters. Different limit IDs or approval classes do NOT create separate counters. The same selectors share the same history across outcomes and authority revisions; matching IDs do not combine different selectors. Compare kind, maximum and optional total field separately from the history selector. A capability filter, capability scope, different trusted scope or different window can change the selected history. Reconcile a false grouping claim in the report; do not rename IDs or change valid business rules to satisfy it.",
        },
        request_identity: "The fixed request_change operation accepts outcome, scoped subject_refs and reviewed business inputs, not a client-supplied request ID. Repeating the same claimed references, outcome and inputs reuses the recorded proposal. New references or a different reviewed request are not an unlimited delivery-retry exemption. Execution uses the sealed proposal's idempotency identity.",
        conflict_protection: "Runner records immutable eligibility/effect evidence, re-verifies current facts and approved effect at execution, and checks configured version fields. A changed version or changed approved effect refuses stale execution; do not require duplicate equality predicates in require for these Runner-owned checks.",
        version_advancement: "Each compiled action effect lists its exact version_advance, or null when none is configured. integer_increment advances that column in the same guarded source transaction as the successful change. Refused, rolled-back and replayed requests do not advance it again. A conflict field alone is not proof of advancement; neither is this contract permission to add an unconfigured version update.",
        receipts: "Runner's control ledger records processing and execution receipts, separately from source effects. A second source-table audit INSERT is not required. request_change distinguishes queued/human_review/not_enabled/completed; completed requires applied state. Pending/failed is not completed.",
        client_responsibilities: "The application authenticates the person, supplies trusted session identity, captures their selection and uses returned execution status/receipts for messages. A scoped subject reference authorizes one reviewed row; it does not prove the human clicked a UI. When an effective date is in the future, recording the change is not proof its benefits are already in force. Boundary rules cannot prove arbitrary client UI wording.",
        application_obligations: {
          customer_selection: "The client captures the customer's intended choice and submits that reviewed subject reference. Runner independently verifies its scope and eligibility; it cannot prove the human selected it.",
          status_presentation: "The client presents returned statuses and receipts accurately. Approval, a queued request or a failed execution is not completion. A recorded future-effective change does not mean benefits are already in force.",
        },
        deployment_prerequisites: {
          runner_client_connection: {
            supported: true,
            supported_clients: ["claude-code", "cursor", "vscode"] satisfies ManagedMcpProjectClient[],
            transport: "local_stdio",
            stage: "after_authority_review",
            configuration_checked: false,
            verified: false,
            meaning: "Runner supports managed local stdio client installation at the later client handoff. This is not external application business implementation or a prerequisite for reviewing disabled authority. It does not prove a client is installed or connected, authenticate a customer, grant authority, or start a worker. Custom clients and production HTTP requirements need their own review.",
            next_step: "After authority review, choose a supported client in client setup and review its installation and connection check. Connection, authenticated identity, application responsibilities and execution readiness remain separate and unverified.",
          },
          authenticated_identity: {
            reviewed_customer_scope: input.read.pack.resources.length > 0
              && input.read.pack.resources.every((resource) => hasReviewedCustomerReadEntry(input.read, resource.id)
                && Boolean(resource.tenant_key || resource.rls_session?.tenant_setting || resource.tenant_scope)),
            verified: false,
            meaning: "Only connecting an authenticated application session to the already reviewed tenant/principal bindings remains a deployment step. Runtime refuses missing identity. This does not settle which customers are authorized or permit weakening database scope. Metadata-only drafting needs no actual identity values.",
            next_step: "After authority review, choose a client and configure runtime identity. A local fixed-identity test is not production authentication verification; production must supply identity from its authenticated session, never model arguments.",
          },
        },
      },
    },
  };
}

/** Resolve traceability against the report's exact bundle, never an editable
 * subset's array positions. A reference is evidence, not permission to edit. */
export function policyCoverageActionTargets(input: {
  report: PolicyCoverage;
  draft: ReturnType<typeof policyCoverageDraft>;
  passages: PolicyPassage[];
  editableOutcomes: readonly string[];
}): { referenced: string[]; editable: string[] } {
  if (canonicalJsonDigest(input.draft) !== input.report.draft_digest) {
    throw new Error("POLICY_COVERAGE_DRAFT_CHANGED: recheck the exact current draft before choosing an Action revision.");
  }
  const referenced = new Set<string>();
  for (const passage of input.passages) {
    for (const pointer of passage.draft_paths) {
      const parts = pointer.slice(1).split("/").map((part) => part.replace(/~1/gu, "/").replace(/~0/gu, "~"));
      let outcome: string | undefined;
      if (parts[0] === "actions" && parts.length > 1) {
        if (!/^(?:0|[1-9]\d*)$/u.test(parts[1]!)) throw new Error("POLICY_COVERAGE_ACTION_TARGET_INVALID: expected an exact Action index.");
        outcome = input.draft.actions[Number(parts[1])]?.outcome;
      } else if (parts[0] === "runner_evidence" && parts[1] === "actions" && parts.length > 2) {
        if (Object.hasOwn(input.draft.runner_evidence.actions, parts[2]!)) outcome = input.draft.runner_evidence.actions[parts[2]!]!.outcome;
      } else continue;
      if (!outcome || input.draft.actions.filter((action) => action.outcome === outcome).length !== 1) {
        throw new Error("POLICY_COVERAGE_ACTION_TARGET_INVALID: the referenced outcome is missing or ambiguous. No Action was selected.");
      }
      referenced.add(outcome);
    }
  }
  return { referenced: [...referenced], editable: [...referenced].filter((outcome) => input.editableOutcomes.includes(outcome)) };
}
