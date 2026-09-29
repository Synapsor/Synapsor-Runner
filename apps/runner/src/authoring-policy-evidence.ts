import { SOURCE_RECEIPT_CONTRACT, ATOMIC_EFFECT_TRANSACTION } from "./authoring-receipt-contract.js";
import {sourceTransactionPreparedContext} from './authoring-source-transaction-review.js';
import { actionSubjectCompatibility } from "./action-subject-compatibility.js";
import { receiptReadExclusion, reviewEvidencePhases } from "./authoring-receipt-read-evidence.js";
import { policyCountingInterpretations } from "./authoring-counting-review.js";
import type { CountingOutcomeDomain } from "./authoring-policy-source.js";
import { explorationBoundaryCandidateDigest, hasReviewedPrincipalScope, type ExplorationBoundaryDraft } from "./auto-boundary.js";
import { actionRuleModelDraftFromAuthority, type CompiledActionRuleModelDraftV1 } from "./action-rule-draft.js";
import type { ActionRuleAuthorityReviewSubjectV1 } from "./action-rule-authority.js";
import { readBoundaryRevisionCatalog } from "./read-boundary-revision-model.js";
import type { ManagedMcpProjectClient } from "./managed-mcp-project.js";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { activePolicySource, type PolicyCoverage, type PolicyPassage, type PolicySourceSession } from "./authoring-policy-source.js";
import { hasReviewedCustomerReadEntry, reviewedReadEntryPaths } from "./read-relationship-access.js";
import { policySourceConstraintEvidence, type PolicySourceInspection } from "./action-rule-source-evidence.js";
import { inspectDatabase, rolePostureFingerprint, schemaFingerprintForInspection } from "@synapsor-runner/schema-inspector";
import { actionRuleRelationshipPairs, normalizeActionRuleCatalog, type ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import { inspectedPostgresScopeMapping } from "./inspected-scope-mapping.js";
import { actionRuleRelationshipsForTable, buildActionRuleAuthoringCatalog, uniqueKey } from "./action-rule-authoring.js";
import { parseReviewedActionVersionFields, type ReviewedActionVersionField } from "./action-rule-authoring-checkpoint.js";
import { prepareActionVersionField } from "./action-rule-version-review.js";
import { preparePrivateActionSource } from "./action-rule-resource-review.js";
import type { DerivedEffectEnvelopeSpecV1 } from "@synapsor/spec";
import type { AskProvider } from "./model-ask.js";

/** Policy and counter evidence is bound to the reviewed reader, not the
 * writer-enriched inspection used to compile Actions. Never substitute writer
 * posture or fall back after a failed reader inspection. The normal exact
 * lock/schema/role validators still validate the returned evidence. */
export async function inspectPolicyReviewSource(
  generationLock: PolicySourceInspection["generationLock"],
  inspect: typeof inspectDatabase = inspectDatabase,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PolicySourceInspection> {
  const inspection = await inspect({ engine: generationLock.engine, databaseUrlEnv: generationLock.source_env,
    ...(generationLock.inspected_schema ? { schema: generationLock.inspected_schema } : {}), env });
  return { inspection, generationLock };
}

function inspectedReaderPosture(read: ExplorationBoundaryDraft, source?: PolicySourceInspection) {
  if (!source) return null;
  const { inspection, generationLock } = source;
  const schemaFingerprint = schemaFingerprintForInspection(inspection), roleFingerprint = rolePostureFingerprint(inspection);
  if (canonicalJsonDigest(generationLock) !== read.generation_lock_fingerprint
    || generationLock.engine !== inspection.engine || generationLock.schema_fingerprint !== schemaFingerprint
    || generationLock.role_posture_fingerprint !== roleFingerprint || read.role_posture_fingerprint !== roleFingerprint) {
    return null;
  }
  const role = inspection.role_posture;
  const nonOwner = role?.verified === true && role.owned_relations.length === 0 && inspection.tables.length > 0
    && inspection.tables.every(table => table.role_posture?.current_role_is_owner === false
      && table.role_posture.current_role_can_assume_owner === false);
  return { source: read.source, engine: inspection.engine,
    generation_lock_fingerprint: read.generation_lock_fingerprint, schema_fingerprint: schemaFingerprint, role_posture_fingerprint: roleFingerprint,
    role_verified: role?.verified === true,
    read_only: role?.verified === true && role.read_only && role.writable_relations.length === 0,
    non_owner: nonOwner,
    non_bypass: role?.verified === true && role.superuser === false && role.bypass_rls === false && nonOwner,
    live_connection_rechecked: false, writer_separation_verified: false, production_integration_verified: false,
    meaning: "Current generation-lock-bound metadata establishes only the inspected onboarding reader's role posture, not RLS or additional business predicates. It is not a new live credential check and reveals no credentials. When these exact facts satisfy the requested reader posture, do not ask to provision it again. This does not verify a separate writer, client connection, authenticated identity, grants after inspection, production integration or execution. Compare record scope separately against read_access database_scope_proof.",
  };
}

function inspectedReadScopes(read: ExplorationBoundaryDraft, source?: PolicySourceInspection) {
  type Mapping = NonNullable<ReturnType<typeof inspectedPostgresScopeMapping>>;
  type Evidence = Pick<Mapping, "tenant" | "principal" | "policy_fingerprint"> & {
    resource: string; source: string; schema: string; table: string; operation: "SELECT";
    generation_lock_fingerprint: string; schema_fingerprint: string; role_posture_fingerprint: string;
    policy_count: number; enforcement: "inspected_postgres_rls"; meaning: string;
  };
  const result = new Map<string, Evidence>();
  const resources = read.pack.resources.filter(resource => resource.rls_session?.tenant_setting && resource.rls_session.principal_setting);
  if (!source || !resources.length) return result;
  const { inspection, generationLock } = source;
  const schemaFingerprint = schemaFingerprintForInspection(inspection), roleFingerprint = rolePostureFingerprint(inspection);
  if (inspection.engine !== "postgres" || generationLock.engine !== inspection.engine
    || canonicalJsonDigest(generationLock) !== read.generation_lock_fingerprint
    || schemaFingerprint !== generationLock.schema_fingerprint
    || roleFingerprint !== generationLock.role_posture_fingerprint || roleFingerprint !== read.role_posture_fingerprint) {
    throw new Error("POLICY_RLS_EVIDENCE_STALE: exact current Read lock, inspected schema and current-role posture are required for database scope evidence.");
  }
  for (const resource of resources) {
    if (!resource.tenant_key || read.pack.resources.filter(entry => entry.id === resource.id).length !== 1) continue;
    const mapping = inspectedPostgresScopeMapping({ inspection,
      resource: { schema: resource.schema, table: resource.table, fields: Object.keys(resource.field_types ?? {}) },
      tenantField: resource.tenant_key, tenantSetting: resource.rls_session!.tenant_setting!, principalSetting: resource.rls_session!.principal_setting! });
    if (!mapping || resource.principal_key && resource.principal_key !== mapping.principal.field) continue;
    result.set(resource.id, { resource: resource.id, source: read.source, schema: resource.schema, table: resource.table, operation: "SELECT",
      tenant: mapping.tenant, principal: mapping.principal, policy_fingerprint: mapping.policy_fingerprint,
      generation_lock_fingerprint: read.generation_lock_fingerprint, schema_fingerprint: schemaFingerprint,
      role_posture_fingerprint: roleFingerprint, policy_count: mapping.policy_names.length, enforcement: "inspected_postgres_rls",
      meaning: "Exact current-reader RLS restricts this source to these distinct trusted session identities. The principal field need not be repeated in the compiled SQL column scope or projected for Action verification. This proves record scope only, not an additional business predicate, public field access, authenticated-client wiring, writer readiness, activation or execution. Policy SQL and source rows are not included.",
    });
  }
  return result;
}

/** Evidence for authoring review, derived from the current typed candidates. No
 * runtime identities, rows, credentials or model assertions belong here. */
export function policyCoverageDraft(input: {
  client?: string;
  reviewStoreDigest?: string;
  transactionStoreDigest?: string;
  inputStoreDigest?: string;
  read: ExplorationBoundaryDraft;
  decisions: Array<{ decision: string; confirmed: boolean }>;
  actions: CompiledActionRuleModelDraftV1[];
  authority?: ActionRuleAuthorityReviewSubjectV1;
  source?: PolicySourceInspection;
  /** Host-confirmed operating commitments, never model assertions or proof of external enforcement. */
  reviewedVersionFields?: readonly ReviewedActionVersionField[];
  policySources?: PolicySourceSession;
  /** Current host-selected authoring session, not saved policy prose or a runtime client. */
  authoringSession?: { provider: AskProvider; model: string };
  /** Sanitized current operator policy readback; no credentials, identities or source rows. */
  countingDomain?: CountingOutcomeDomain;
  operatorClarifications?: Array<{ question: string; answer: string }>;
  receiptConfiguration?: Awaited<ReturnType<typeof import("./authoring-receipt-configuration.js").authoringReceiptConfiguration>>;
  executionReview?: { action_digest: string; enabled_outcomes: string[]; policy_digest: string };
}) {
  const policySource = activePolicySource(input.policySources);
  const versionReviews = input.reviewedVersionFields === undefined ? [] : parseReviewedActionVersionFields(input.reviewedVersionFields, 32);
  const catalog = readBoundaryRevisionCatalog(input.read);
  const readFields = new Map(catalog.resources.map(resource => [resource.id,
    new Map(resource.fields.map(field => [field.id, field]))]));
  // Coverage reviews the replacement bundle, not just newly authored entries.
  // Otherwise adding one outcome makes retained business rules appear missing.
  const actions: Array<Pick<CompiledActionRuleModelDraftV1, "draft" | "rule" | "verification_boundary" | "effect_envelope"> & {
    boundary_name: string; source_catalog?: ActionRuleCatalogV1; read_dependency?: { name: string; digest: string };
  }> = input.authority
    ? input.authority.authority.rules.map((entry) => {
      const review = input.authority!.reviews.find((item) => item.outcome === entry.rule.outcome);
      if (!review) throw new Error(`POLICY_COVERAGE_ACTION_REVIEW_MISSING: ${entry.rule.outcome} needs its saved review before the complete policy can be checked.`);
      return { boundary_name: input.authority!.authority.action_boundary.name, source_catalog: input.authority!.authority.catalog,
        read_dependency: { name: entry.read_boundary_name, digest: entry.read_boundary_digest },
        rule: entry.rule, verification_boundary: entry.verification_boundary, effect_envelope: entry.effect_envelope,
        draft: actionRuleModelDraftFromAuthority({ authority: input.authority!.authority, outcome: entry.rule.outcome,
          review, preserveVerificationFields: true }) };
    }) : input.actions.map((action) => {
      const rule = action.loaded.authority.rules?.find(entry => entry.rule.outcome === action.rule.outcome);
      return { ...action, boundary_name: action.loaded.authority.action_boundary.name, source_catalog: action.loaded.authority.catalog,
        ...(rule ? { read_dependency: { name: rule.read_boundary_name, digest: rule.read_boundary_digest } } : {}) };
    });
  const readScopes = inspectedReadScopes(input.read, input.source);
  const readerPosture = inspectedReaderPosture(input.read, input.source);
  const readDigest = explorationBoundaryCandidateDigest(input.read);
  const sourceCounterMaintenance = (action: typeof actions[number], effect: Pick<DerivedEffectEnvelopeSpecV1,
    "operation" | "target_resource" | "target_binding" | "primary_key" | "tenant_key" | "principal_scope_key" | "organization_scope" | "conflict_key" | "version_advance">,
  ruleEffect: typeof action.rule.effect | undefined) => {
    const review = versionReviews.find(entry => entry.resource === effect.target_resource && entry.field === effect.version_advance?.column);
    if (!review || !input.source || effect.operation !== "update" || effect.version_advance?.strategy !== "integer_increment"
      || effect.conflict_key !== review.field || !effect.target_binding
      || ruleEffect?.operation !== effect.operation || ruleEffect.target_resource !== effect.target_resource || ruleEffect.target_binding !== effect.target_binding
      || action.read_dependency?.name !== input.read.pack.name || action.read_dependency.digest !== readDigest
      || action.source_catalog?.generation_lock_fingerprint !== input.read.generation_lock_fingerprint
      || action.verification_boundary.generation_lock_fingerprint !== input.read.generation_lock_fingerprint
      || [action.rule.source, action.verification_boundary.source, action.effect_envelope.source].some(source => source !== input.read.source)) return null;
    const targets = action.source_catalog.resources.filter(resource => resource.name === effect.target_resource);
    const bindings = action.verification_boundary.resources.filter(binding => binding.binding === effect.target_binding);
    const target = targets.length === 1 ? targets[0] : undefined, binding = bindings.length === 1 ? bindings[0] : undefined;
    if (!target || target.verification_only || !binding || binding.resource !== target.name
      || target.version_field !== review.field || binding.version_field !== review.field
      || target.primary_key !== effect.primary_key || binding.primary_key !== target.primary_key
      || target.tenant_key !== effect.tenant_key || target.principal_scope_key !== effect.principal_scope_key
      || binding.scope.mode === "inherited"
      || binding.scope.principal_field !== target.principal_scope_key
      || (binding.scope.mode === "columns" ? binding.scope.tenant_field !== target.tenant_key || effect.organization_scope !== undefined
        : effect.tenant_key !== undefined || !input.read.organization_scope
          || binding.scope.organization_id !== input.read.organization_scope.organization_id
          || canonicalJsonDigest(effect.organization_scope ?? null) !== canonicalJsonDigest(input.read.organization_scope))) return null;
    // A saved digest attests only to the exact reviewed mapping. Re-derive it
    // from current metadata, then bind it to the actual compiled update target.
    try {
      const builtCatalog = buildActionRuleAuthoringCatalog({ boundary: input.read, inspection: input.source.inspection, retainedCatalog: action.source_catalog });
      const prepared = prepareActionVersionField({ context: { readBoundary: input.read, readBoundaryDigest: readDigest, builtCatalog },
        inspection: input.source.inspection, generationLock: input.source.generationLock, resource: review.resource, field: review.field });
      const current = normalizeActionRuleCatalog(prepared.builtCatalog.catalog).resources.find(resource => resource.name === target.name);
      const saved = normalizeActionRuleCatalog(action.source_catalog).resources.find(resource => resource.name === target.name);
      const fields = binding.fields.filter(field => field.name === review.field), field = fields.length === 1 ? fields[0] : undefined;
      const currentField = current?.fields.find(field => field.name === review.field);
      if (!current || !saved || canonicalJsonDigest(current) !== canonicalJsonDigest(saved)
        || canonicalJsonDigest(prepared.review) !== canonicalJsonDigest(review)
        || !field || !currentField || field.nullable !== currentField.nullable
        || canonicalJsonDigest(field.type) !== canonicalJsonDigest(currentField.type)) return null;
      return { status: "owner_confirmed_operating_prerequisite" as const, resource: review.resource, field: review.field,
        maintenance: review.maintenance, proof_digest: review.proof_digest, read_boundary_digest: readDigest,
        generation_lock_fingerprint: input.read.generation_lock_fingerprint, role_posture_fingerprint: input.read.role_posture_fingerprint,
        external_writers_verified: false, production_integration_verified: false };
    } catch {
      return null;
    }
  };
  const actionScope = (action: typeof actions[number], binding: typeof actions[number]["verification_boundary"]["resources"][number]) => {
    if (action.source_catalog?.generation_lock_fingerprint !== input.read.generation_lock_fingerprint
      || action.verification_boundary.generation_lock_fingerprint !== input.read.generation_lock_fingerprint
      || action.verification_boundary.source !== input.read.source
      || action.read_dependency?.name !== input.read.pack.name || action.read_dependency.digest !== readDigest
      || binding.scope.mode !== "columns") return null;
    const resources = action.source_catalog.resources.filter(resource => resource.name === binding.resource);
    const resource = resources.length === 1 ? resources[0] : undefined;
    if (!resource || resource.engine !== "postgres" || resource.source !== input.read.source) return null;
    let proof = readScopes.get(binding.resource);
    // Private verification does not need public Read admission. Recheck only
    // the already-compiled link and exact child scope through existing validators.
    if (!proof && input.source && binding.source.kind === "relationship"
      && binding.source.direction === "inverse" && !input.read.pack.resources.some(entry => entry.id === resource.name)) {
      const source = binding.source;
      const parents = action.verification_boundary.resources.filter(entry => entry.binding === source.from_binding);
      const parent = parents.length === 1 ? parents[0] : undefined;
      const parentProof = parent && readScopes.get(parent.resource);
      const links = action.source_catalog.relationships.filter(entry => entry.name === source.relationship);
      const link = links.length === 1 ? links[0] : undefined;
      if (parentProof && parent?.scope.mode === "columns" && parent.scope.tenant_field === parentProof.tenant.field
        && parent.scope.principal_field === parentProof.principal.field
        && link?.from_resource === resource.name && link.to_resource === parent.resource
        && canonicalJsonDigest(source.field_pairs) === canonicalJsonDigest(actionRuleRelationshipPairs(link))) {
        try {
          const built = buildActionRuleAuthoringCatalog({ boundary: input.read, inspection: input.source.inspection,
            retainedCatalog: action.source_catalog });
          const current = normalizeActionRuleCatalog(built.catalog), saved = normalizeActionRuleCatalog(action.source_catalog);
          // Compiled catalogs normalize field order. Compare canonical records
          // before reuse, without introducing any unreviewed current edge.
          if (![resource.name, parent.resource].every(name => canonicalJsonDigest(current.resources.find(entry => entry.name === name))
            === canonicalJsonDigest(saved.resources.find(entry => entry.name === name)))
            || canonicalJsonDigest(current.relationships.find(entry => entry.name === source.relationship))
              !== canonicalJsonDigest(saved.relationships.find(entry => entry.name === source.relationship))) return null;
          const children = input.source.inspection.tables.filter(table => `${table.schema}.${table.name}` === resource.name);
          const parents = input.source.inspection.tables.filter(table => `${table.schema}.${table.name}` === parent.resource);
          const childTable = children.length === 1 ? children[0] : undefined, parentTable = parents.length === 1 ? parents[0] : undefined;
          if (!childTable || !parentTable || childTable.type !== "table" || parentTable.type !== "table"
            || !uniqueKey(childTable, [resource.primary_key]) || !uniqueKey(parentTable, [parent.primary_key])
            || new Set(childTable.foreign_keys.map(key => key.name)).size !== childTable.foreign_keys.length) return null;
          const candidates = actionRuleRelationshipsForTable(childTable,
            new Map([[resource.name, childTable], [parent.resource, parentTable]]), new Set([resource.name, parent.resource]), [])
            .filter(candidate => {
              const pairs = actionRuleRelationshipPairs(candidate);
              return candidate.to_resource === parent.resource && candidate.target_unique && !candidate.nullable
                && !childTable.foreign_keys.find(key => key.name === candidate.name)?.deferrable
                && pairs.some(pair => pair.local_field === resource.tenant_key && pair.target_field === parentProof.tenant.field)
                && pairs.some(pair => pair.local_field === resource.principal_scope_key && pair.target_field === parentProof.principal.field)
                && pairs.every(pair => parentTable.columns.find(column => column.name === pair.target_field)?.nullable === false);
            });
          if (candidates.length !== 1 || canonicalJsonDigest(candidates[0]) !== canonicalJsonDigest(link)) return null;
          // A retained Action catalog may predate narrowing public Read access.
          // Its already-compiled binding can have RLS evidence without changing
          // purpose or fabricating the separate private-source consent record.
          if (resource.verification_only) {
            const prepared = preparePrivateActionSource({ built, boundary: input.read, inspection: input.source.inspection,
              resource: resource.name, parentResource: parent.resource });
            if (prepared.review.relationship !== source.relationship) return null;
          }
          const mapping = resource.tenant_key && inspectedPostgresScopeMapping({ inspection: input.source.inspection,
            resource: { schema: resource.schema, table: resource.table, fields: resource.fields.map(field => field.name) },
            tenantField: resource.tenant_key, tenantSetting: parentProof.tenant.setting, principalSetting: parentProof.principal.setting });
          if (mapping && resource.principal_scope_key === mapping.principal.field) {
            proof = { ...parentProof, resource: resource.name, schema: resource.schema, table: resource.table,
              tenant: mapping.tenant, principal: mapping.principal, policy_fingerprint: mapping.policy_fingerprint,
              policy_count: mapping.policy_names.length };
          }
        } catch {
          // Changed/ambiguous metadata is still unresolved, never inferred from a name or model assertion.
        }
      }
    }
    if (!proof || binding.scope.tenant_field !== proof.tenant.field
      || binding.scope.principal_field && binding.scope.principal_field !== proof.principal.field
      || resource.schema !== proof.schema || resource.table !== proof.table
      || resource.tenant_key !== proof.tenant.field
      || resource.principal_scope_key && resource.principal_scope_key !== proof.principal.field
      || ![proof.tenant.field, proof.principal.field].every(field => resource.fields.some(entry => entry.name === field))) return null;
    return proof;
  };
  const sourceConstraints = input.source ? policySourceConstraintEvidence({ source: input.source, read: input.read,
    resources: [...input.read.pack.resources.map(resource => resource.id),
      ...actions.flatMap(action => action.verification_boundary.resources.map(resource => resource.resource))] }) : undefined;
  // Only a complete, matching selected authoring bundle can establish absence
  // of public grants. This does not infer privacy from a row projection or an
  // inactive deployment. Existing Read/Action fields keep their usual evidence.
  const completeSelectedActions = actions.every(action => action.read_dependency?.name === input.read.pack.name
    && action.read_dependency.digest === readDigest
    && action.source_catalog?.generation_lock_fingerprint === input.read.generation_lock_fingerprint
    && action.verification_boundary.generation_lock_fingerprint === input.read.generation_lock_fingerprint
    && action.rule.source === input.read.source && action.verification_boundary.source === input.read.source
    && action.verification_boundary.resources.every(binding => {
      const targets = action.source_catalog!.resources.filter(resource => resource.name === binding.resource);
      return targets.length === 1 && targets[0]!.source === input.read.source
        && `${targets[0]!.schema}.${targets[0]!.table}` === binding.resource;
    }));
  const excludedFields = sourceConstraints && completeSelectedActions ? Object.fromEntries(
    Object.entries(sourceConstraints.resources).flatMap(([resource, inspected]) => {
      // A resource present under another display/id spelling must not acquire a
      // negative proof. All its actual return/analysis grants need normal review.
      if (input.read.pack.resources.some(r => `${r.schema}.${r.table}` === resource)) return [];
      const used = new Set(actions.flatMap(action => action.verification_boundary.resources
        .filter(binding => binding.resource === resource).flatMap(binding => binding.fields.map(field => field.name))));
      const fields = Object.fromEntries(Object.keys(inspected.columns).filter(field => !used.has(field)).map(field => [field, {
        actual_values_returned: false, model_analysis: [], read_access_present: false, private_action_verification: false,
        meaning: "Inspected field excluded from this complete selected Read and unused by these Actions. This is not Action verification access, database-wide privacy, activation or another interface's permissions.",
      }]));
      return Object.keys(fields).length ? [[resource, { resource, fields }]] : [];
    })) : undefined;
  return {
    read: input.read,
    actions: actions.map((action) => action.draft),
    runner_evidence: {
      // Exact revision identity from the selected authoritative review subject,
      // separate from the phase description used by the model.
      action_revision: input.authority ? {
        action_boundary_digest: input.authority.authority.action_boundary.digest,
        review_record_digest: input.authority.digest,
      } : null,
      ...((input.policySources?.scoped_disclosure_reviews?.length || input.reviewStoreDigest) ? {scoped_disclosure: {
        source_session: input.policySources?.id ?? "",
        metadata_digest: input.source && readerPosture ? canonicalJsonDigest({schema:schemaFingerprintForInspection(input.source.inspection),role:rolePostureFingerprint(input.source.inspection)}) : null,
        read_digest: readDigest, store_digest: input.reviewStoreDigest ?? input.countingDomain?.store_binding_digest ?? null,
        reviews: input.policySources?.scoped_disclosure_reviews ?? [],
      }} : {}),
      ...(input.policySources?.input_policy_reviews?.length ? {input_policy_requirement:{source_session:input.policySources.id,store_digest:input.inputStoreDigest ?? null,reviews:input.policySources.input_policy_reviews}} : {}),
      ...(input.policySources ? {source_transaction_requirement: sourceTransactionPreparedContext(input.policySources,
        input.transactionStoreDigest ?? input.countingDomain?.store_binding_digest ?? null,policySource?.digest)} : {}),
      ...(sourceConstraints ? { source_constraints: sourceConstraints } : {}),
      ...(excludedFields && Object.keys(excludedFields).length ? { excluded_field_access: {
        selected_read_digest: canonicalJsonDigest(input.read), selected_actions_digest: canonicalJsonDigest(actions.map(action => action.draft)),
        source_constraints_digest: canonicalJsonDigest(sourceConstraints), resources: excludedFields,
      } } : {}),
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
          trusted_tenant_field: raw.tenant_key ?? null, trusted_principal_field: raw.principal_key ?? readScopes.get(resource.id)?.principal.field ?? null,
          explicit_principal_column: raw.principal_key ?? null,
          database_scope_proof: readScopes.get(resource.id) ?? null,
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
          database_scope_proof: actionScope(action, resource),
          row_identity: resource.primary_key, conflict_field: resource.version_field ?? null,
          fields: Object.fromEntries(resource.fields.map((field) => {
            const readField = readFields.get(resource.resource)?.get(field.name);
            // A private verification flag cannot hide independent Read access.
            // An absent Read field supplies no Read permissions, not a new entry.
            return [field.name, { name: field.name, type: structuredClone(field.type), nullable: field.nullable, model_visible: field.model_visible === true,
              read_access_present: readField !== undefined,
              actual_values_returned: field.model_visible === true || readField?.raw_return === true,
              model_analysis: [...(readField?.model_operations ?? [])],
              private_read_selection: readField?.row_selection === true && !readField.raw_return,
              private_action_verification: field.model_visible !== true,
            }] as const;
          })),
        }])),
        automatic_limits: (action.draft.approval.shared_limits ?? []).map((limit) => ({
          ...limit,
          applies_to_outcome: limit.capability === undefined || limit.capability === action.rule.outcome,
          history_selector: {
            action_boundary_name: action.boundary_name,
            approval_status: "approved", approval_kind: "boundary_automatic",
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
          source_counter_maintenance: sourceCounterMaintenance(action, action.effect_envelope, action.rule.effect),
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
            source_counter_maintenance: sourceCounterMaintenance(action, effect, action.rule.atomic_updates?.[index]),
          })), transaction: ATOMIC_EFFECT_TRANSACTION } : {}),
        },
        execution: {
          configured_mode: action.effect_envelope.writeback.mode,
          supported_automatic_completion: action.effect_envelope.writeback.mode === "direct_sql",
          activation: "separate_operator_review",
          prerequisites: ["reviewed writer", "execution enabled for this exact Action revision", "running worker"],
          semantics: "With direct_sql configured and separately enabled, the worker processes approved requests without a per-request staff step. Approval alone is not completion. A disabled configuration is prepared behavior, not missing business logic.",
        },
      }])),
      action_subject_compatibility: input.authority ? actionSubjectCompatibility(input.authority.authority, [input.read]) : null,
      counting_decisions: input.policySources?.counting_decisions ?? [],
      counting_interpretations: policyCountingInterpretations(input.policySources, policySource,
        canonicalJsonDigest({ read: readDigest, action: input.authority?.digest ?? null }), input.operatorClarifications ?? []),
      runtime_contract: {
        authoring_provider: input.authoringSession ? {
          provider: input.authoringSession.provider, model: input.authoringSession.model, purpose: "disabled_policy_authoring",
          provider_response_verified: false, runtime_client_verified: false, authority_granted: false,
          meaning: "The host selected this provider and model for the current authoring session, not a runtime MCP client. This selection does not prove a successful provider response or the semantic correctness of its drafts. Compare an authoring-model requirement here, separately from later managed runtime-client installation and connection. It grants no data, approval, activation or execution authority.",
        } : null,
        onboarding_reader: readerPosture,
        trusted_time: {
          binding: "transaction_time", origin: "runner_supplied_evaluation_time", database_clock_verified: false, model_supplied: false,
          meaning: "Action predicates receive a trusted timestamp from Runner's proposal evaluation or execution re-verification context. The binding name does not establish database-server clock origin, a SQL CURRENT_TIMESTAMP expression or equality to a database transaction-start timestamp. A policy requiring that particular clock origin remains unresolved; do not silently replace it with trusted current UTC evaluation time. This describes only the existing time binding, not a new predicate or execution capability.",
        },
        authoring_lifecycle: {
          current_policy_snapshot: policySource ? { digest: policySource.digest, version: policySource.version,
            bytes: policySource.bytes, lines: policySource.lines } : null,
          retained_business_answers: input.policySources?.operator_messages?.length ?? 0,
          retained_read_interpretations: input.policySources?.read_interpretations?.length ?? 0,
          sources: "Complete versioned local snapshots are restored on resume, not silently reread from an edited original file. Replacing or removing rules is an explicit operator operation with separate model-transfer consent.",
          revisions: "Business and permission edits prepare disabled revisions. Current active authority remains separate until exact operator activation; model prose and saved answers never activate authority.",
          resume: "Saved job progress, accepted meanings and existing action revisions are retained. Changed schema, reader posture or Read dependencies require revalidation; unsupported rules and unanswered decisions remain pending. A saved checkpoint is not proof that the entire policy is implemented or a future external client will obey it.",
          automatic_activation: false,
          external_client_behavior_verified: false,
        },
        deployment_profile: {
          configured_profile: input.read.deployment_profile,
          identity_provider: input.read.trusted_context.provider,
          local_identity_mode: input.read.deployment_profile !== "production" && input.read.trusted_context.provider === "environment",
          production_authentication_verified: false,
          meaning: "Development and staging are local environment-bound identity profiles. The profile name does not establish whether source data is synthetic, where the system is deployed, or whether a production authentication integration was verified. Compare the actual required identity and deployment controls, not an informal environment label. An explicit requirement for a specific profile still needs review; never downgrade production or waive authentication, privacy or execution requirements.",
        },
        agent_interface: {
          tools: ["app.describe_data", "app.explore_data", "app.describe_actions", "app.request_change"],
          surface: "fixed_four_tools",
          discovery: "Activated reading permissions and business outcomes are discovered through these tools. Supported reviewed rule changes update their catalogs, not the tool list. No per-outcome MCP tool or bespoke runtime adapter is required.",
          limits: "Only supported, validated and explicitly activated boundaries are available. A fixed interface does not provide arbitrary SQL, unsupported effects, model-supplied scope, approval or execution authority. New grants and execution policies still require separate review; pending requests retain their reviewed version checks.",
          configuration_checked: false,
          connection_verified: false,
          deployment: "This is Runner's supported interface contract, not proof that a particular client is installed, configured or connected. Use runner_client_connection for the separate later installation and handshake check.",
        },
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
          outcome_domain: input.countingDomain && input.authority && input.countingDomain.proposed_revision === input.authority.digest
            && input.countingDomain.boundary_name === input.authority.authority.action_boundary.name
            && canonicalJsonDigest(input.countingDomain.proposed_outcomes) === canonicalJsonDigest(actions.map(action => action.rule.outcome).sort())
            ? input.countingDomain : null,
          evidence: "Each automatic_limits entry supplies its exact history_selector and applies_to_outcome, derived from the current compiled authority. Null selectors mean no filter, not missing configuration. Tenant/principal/object selectors reference the current trusted proposal; no runtime identity values are supplied here.",
          diagnostic_only: ["limit.id"],
          not_history_filters: ["limit.id", "approval_class", "action_boundary_digest"],
          semantics: "The evaluator selects automatic approval records tagged with this Action Boundary name and status approved; human approvals have no boundary tag and are excluded. It filters by inclusive time window and the listed optional capability/tenant/principal/object filters. Different limit IDs or approval classes do NOT create separate counters. The same selectors share the same history across outcomes and authority revisions; matching IDs do not combine different selectors. Compare kind, maximum and optional total field separately from the history selector. A capability filter, capability scope, different trusted scope or different window can change the selected history. Reconcile a false grouping claim in the report; do not rename IDs or change valid business rules to satisfy it.",
        },
        request_identity: "The fixed request_change operation accepts outcome, scoped subject_refs and reviewed business inputs, not a client-supplied request ID. Repeating the same claimed references, outcome and inputs reuses the recorded proposal. New references or a different reviewed request are not an unlimited delivery-retry exemption. Execution uses the sealed proposal's idempotency identity.",
        conflict_protection: "Runner records immutable eligibility/effect evidence, re-verifies current facts and approved effect at execution, and checks configured version fields. A changed version or changed approved effect refuses stale execution; do not require duplicate equality predicates in require for these Runner-owned checks.",
        version_advancement: "Each compiled action effect lists its exact version_advance, or null when none is configured. integer_increment advances that column in the same guarded source transaction as the successful change. Refused, rolled-back and replayed requests do not advance it again. A conflict field alone is not proof of advancement; neither is this contract permission to add an unconfigured version update.",
        source_counter_maintenance: "Each effect and atomic_updates entry supplies source_counter_maintenance: an exact host-confirmed operating prerequisite, validated against the current Read dependency, inspection, role posture, generation lock, catalog, compiled update target and saved review digest, or null when no matching current confirmation is available. Cite that exact entry for a source-owner obligation to maintain the counter on every update. This is not independent proof that external writers enforce the obligation: external_writers_verified and production_integration_verified remain false. If the policy requires formal independent enforcement, keep that requirement pending until its actual evidence is supplied. Neither model text, source-policy wording, structural suitability nor compiled version advancement substitutes for host confirmation; a null entry cannot support a positive maintenance claim. This metadata grants no Read visibility, activation or execution authority.",
        saved_execution_review: input.executionReview && input.authority
          && input.executionReview.action_digest === input.authority.authority.action_boundary.digest
          ? { ...input.executionReview, authority: "existing_operator_execution_policy", live_writer_rechecked: false,
            worker_running_verified: false, receipt_mode_verified: false, independent_source_readback_verified: false,
            meaning: "These outcomes have an enabled operator execution policy bound to this exact Action revision. This existing record is not a fresh writer/grant check, worker liveness check, receipt mode verification, completed execution or independent observation. Preserve its history without repeating a business Action repair. Inspect remaining setup separately." }
          : null,
        receipt_configuration: input.receiptConfiguration ?? null,
        receipt_read_exclusion: receiptReadExclusion(input.read, input.receiptConfiguration, input.source),
        review_evidence_phases: reviewEvidencePhases(input.authority?.authority.action_boundary.digest ?? null,
          input.read, actions.map(action => action.draft)),
        receipts: SOURCE_RECEIPT_CONTRACT,
        client_responsibilities: "The application authenticates the person, supplies trusted session identity, captures their selection and uses returned execution status/receipts for messages. A scoped subject reference authorizes one reviewed row; it does not prove the human clicked a UI. When an effective date is in the future, recording the change is not proof its benefits are already in force. Boundary rules cannot prove arbitrary client UI wording.",
        client_contract: { mode: "interactive_four_tool", client: input.client ?? "unselected",
          origin: "PRODUCT-CLIENT-CONTRACT", ownership: "explicit_unverified" },
        application_obligations: {
          customer_selection: "The client captures the customer's intended choice and submits that reviewed subject reference. Runner independently verifies its scope and eligibility; it cannot prove the human selected it.",
          status_presentation: "The client presents returned statuses and receipts accurately. Approval, a queued request or a failed execution is not completion. A recorded future-effective change does not mean benefits are already in force.",
          independent_source_readback: {
            phase: "after_execution", verified: false, receipt_proves_observation: false,
            observation_scope: null,
            meaning: "An independent client or source owner observes the source after a particular execution and compares it with that exact intended change. This required observation remains external and unverified here; it cannot be performed before the change exists. Neither a receipt, selected receipt mode, execution setup, past test nor conversation establishes this observation. No private source rows or external verifier files are imported into authoring evidence. Business review may finish while this later obligation remains visible; claiming independently verified completion may not.",
            limits: "This is only a separately performed observation, not an automatic runtime postcondition, transactional readback expression or guarantee for every future execution. If the policy requires such an automated guarantee, keep that precise unsupported requirement unresolved rather than assigning it away. Source_db atomic receipt requirements remain distinct.",
          },
        },
        deployment_prerequisites: {
          runner_execution_setup: {
            supported: actions.length > 0 && actions.every((action) => action.effect_envelope.writeback.mode === "direct_sql"),
            receipt_modes_supported: actions.length > 0 && actions.every((action) => action.effect_envelope.writeback.mode === "direct_sql")
              ? ["runner_ledger", "source_db"] : [],
            receipt_mode_checked: false,
            outcomes: actions.map((action) => ({ outcome: action.rule.outcome, configured_mode: action.effect_envelope.writeback.mode })),
            stage: "after_authority_review",
            configuration_checked: false,
            verified: false,
            meaning: "Only deployment of already compiled direct SQL effects: review a separate writer and exact database grants, separately enable execution, review the required receipt authority and its exact source objects/grants if applicable, then configure and start a worker. These are not prerequisites for reviewing disabled business rules. This evidence never asserts that the writer, grants, execution or worker are ready. Reader credentials stay separate. Proposal-only effects, missing actions, unsupported transactions, business eligibility, privacy and approval conditions cannot use this prerequisite.",
            next_step: "After authority review, use execution setup to prepare the exact writer handoff or verify an existing dedicated writer. If administration is needed, save and resume this job after the administrator applies only the reviewed requirements. Execution remains off until separately enabled; completion requires a successful receipt.",
          },
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
