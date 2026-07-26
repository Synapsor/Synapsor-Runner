import {
  canonicalJsonDigest,
  type ChangeSet,
} from "@synapsor-runner/protocol";
import {
  type StoredShadowHumanAction,
  type ShadowAgentResult,
  type ShadowOutcomeDisposition,
  type StoredShadowStudy,
  type ShadowEffect,
  type StoredShadowCase,
  type StoredShadowOutcome,
  type ShadowStudyComparison,
  type ShadowStudyReport,
  type ShadowComparison,
  type ShadowReport,
} from "./domain-types.js";
import {
  assertNoSecretMaterial,
} from "./proposal-integrity.js";
import {
  rowToShadowHumanAction,
  rowToShadowStudy,
  rowToShadowCase,
  rowToShadowOutcome,
} from "./record-codecs.js";
import {
  comparePatches,
  compareShadowStudyCase,
  latestIsoTimestamp,
  normalizeShadowEffect,
  shadowEffectFromChangeSet,
  effectAmountValue,
  shadowStudyIncludes,
  requiredBoundedText,
  optionalBoundedText,
  optionalIsoTimestamp,
  optionalFiniteNumber,
  safeShadowId,
  assertShadowAgentResult,
  assertShadowOutcomeDisposition,
  countShadowStatus,
  emptyShadowStatusCounts,
  distribution,
  suggestedShadowPolicies,
  shadowTrustProgression,
  safeSqliteFailure,
} from "./shadow-analysis.js";
import {
  ProposalStoreError,
} from "./errors.js";

import type {
  ProposalStoreShadowMethods,
  ProposalStoreShadowInternalMethods,
  ProposalStoreMethodContext,
} from "./sqlite-method-signatures.js";

export const proposalStoreShadowMethods: ProposalStoreShadowMethods & ProposalStoreShadowInternalMethods & ThisType<ProposalStoreMethodContext> = {
  createShadowStudy(input: {
      study_id?: string;
      name: string;
      description?: string;
      selected_capabilities?: string[];
      starts_at?: string;
      ends_at?: string;
    }): StoredShadowStudy {
      const name = requiredBoundedText(input.name, "shadow study name", 160);
      const description = optionalBoundedText(input.description, "shadow study description", 2_000);
      const selectedCapabilities = [...new Set((input.selected_capabilities ?? []).map((value) =>
        requiredBoundedText(value, "shadow study capability", 256),
      ))].sort();
      const startsAt = optionalIsoTimestamp(input.starts_at, "shadow study starts_at");
      const endsAt = optionalIsoTimestamp(input.ends_at, "shadow study ends_at");
      if (startsAt && endsAt && Date.parse(endsAt) < Date.parse(startsAt)) {
        throw new ProposalStoreError("SHADOW_STUDY_TIME_RANGE_INVALID", "shadow study ends_at must not precede starts_at");
      }
      assertNoSecretMaterial({ name, description, selected_capabilities: selectedCapabilities }, "shadow_study");
      const now = new Date().toISOString();
      const studyId = input.study_id
        ? safeShadowId(input.study_id, "study")
        : `sst_${canonicalJsonDigest({ name, now, ordinal: this.countTable("shadow_studies") }).slice("sha256:".length, "sha256:".length + 20)}`;
      try {
        this.db.prepare(`
          INSERT INTO shadow_studies (
            study_id, name, description, selected_capabilities_json, starts_at,
            ends_at, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
        `).run(
          studyId,
          name,
          description ?? null,
          JSON.stringify(selectedCapabilities),
          startsAt ?? null,
          endsAt ?? null,
          now,
          now,
        );
      } catch (error) {
        throw new ProposalStoreError("SHADOW_STUDY_CREATE_FAILED", safeSqliteFailure(error, `shadow study ${studyId} could not be created`));
      }
      const study = this.getShadowStudy(studyId);
      if (!study) throw new ProposalStoreError("SHADOW_STUDY_CREATE_FAILED", `shadow study ${studyId} was not persisted`);
      this.syncShadowStudy(studyId);
      return this.getShadowStudy(studyId) ?? study;
    },
  
  getShadowStudy(studyId: string): StoredShadowStudy | undefined {
      return rowToShadowStudy(this.db.prepare("SELECT * FROM shadow_studies WHERE study_id = ?").get(studyId));
    },
  
  listShadowStudies(): StoredShadowStudy[] {
      return this.db.prepare("SELECT * FROM shadow_studies ORDER BY created_at DESC, study_id ASC").all()
        .map(rowToShadowStudy)
        .filter((study): study is StoredShadowStudy => study !== undefined);
    },
  
  closeShadowStudy(studyId: string, endsAt = new Date().toISOString()): StoredShadowStudy {
      this.requireShadowStudy(studyId);
      const normalizedEndsAt = optionalIsoTimestamp(endsAt, "shadow study ends_at")!;
      this.db.prepare(`
        UPDATE shadow_studies SET status = 'closed', ends_at = ?, updated_at = ?
        WHERE study_id = ?
      `).run(normalizedEndsAt, new Date().toISOString(), studyId);
      return this.requireShadowStudy(studyId);
    },
  
  syncShadowStudy(studyId: string): { attached: number; total: number } {
      const study = this.requireShadowStudy(studyId);
      let attached = 0;
      for (const proposal of this.listProposals().filter((item) => item.change_set.mode === "shadow")) {
        if (!shadowStudyIncludes(study, proposal.capability ?? proposal.action, proposal.created_at)) continue;
        const before = this.shadowCases(studyId).length;
        this.addShadowProposalToStudy(studyId, proposal.proposal_id);
        if (this.shadowCases(studyId).length > before) attached += 1;
      }
      return { attached, total: this.shadowCases(studyId).length };
    },
  
  addShadowProposalToStudy(studyId: string, proposalId: string, requestId?: string): StoredShadowCase {
      const study = this.requireShadowStudy(studyId);
      const proposal = this.requireProposal(proposalId);
      if (proposal.change_set.mode !== "shadow") {
        throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${proposalId} is not a shadow proposal`);
      }
      if (!shadowStudyIncludes(study, proposal.capability ?? proposal.action, proposal.created_at)) {
        throw new ProposalStoreError("SHADOW_STUDY_SCOPE_MISMATCH", `proposal ${proposalId} is outside shadow study ${studyId}`);
      }
      return this.recordShadowCase({
        study_id: studyId,
        request_id: requestId ?? proposal.interaction_id ?? proposal.tool_call_id ?? proposal.proposal_id,
        proposal_id: proposal.proposal_id,
        tenant_id: proposal.tenant_id,
        principal: proposal.principal,
        capability: proposal.capability ?? proposal.action,
        business_object: proposal.business_object,
        object_id: proposal.object_id,
        evidence_bundle_id: proposal.change_set.evidence.bundle_id,
        proposed_effect: shadowEffectFromChangeSet(proposal.change_set),
        agent_result: "proposed",
        amount_value: effectAmountValue(shadowEffectFromChangeSet(proposal.change_set)),
        created_at: proposal.created_at,
      });
    },
  
  recordShadowCase(input: {
      study_id: string;
      request_id: string;
      proposal_id?: string;
      tenant_id: string;
      principal?: string;
      capability: string;
      business_object: string;
      object_id: string;
      evidence_bundle_id?: string;
      proposed_effect?: ShadowEffect;
      agent_result: ShadowAgentResult;
      decision_reason?: string;
      risk_score?: number;
      amount_value?: number;
      created_at?: string;
    }): StoredShadowCase {
      const study = this.requireShadowStudy(input.study_id);
      const requestId = requiredBoundedText(input.request_id, "shadow request_id", 256);
      const tenantId = requiredBoundedText(input.tenant_id, "shadow tenant_id", 256);
      const capability = requiredBoundedText(input.capability, "shadow capability", 256);
      const businessObject = requiredBoundedText(input.business_object, "shadow business_object", 128);
      const objectId = requiredBoundedText(input.object_id, "shadow object_id", 256);
      assertShadowAgentResult(input.agent_result);
      if (!shadowStudyIncludes(study, capability, input.created_at ?? new Date().toISOString())) {
        throw new ProposalStoreError("SHADOW_STUDY_SCOPE_MISMATCH", `shadow case is outside study ${study.study_id}`);
      }
      if (input.proposal_id) {
        const proposal = this.requireProposal(input.proposal_id);
        if (proposal.change_set.mode !== "shadow") {
          throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${input.proposal_id} is not a shadow proposal`);
        }
        if (
          proposal.tenant_id !== tenantId ||
          proposal.business_object !== businessObject ||
          proposal.object_id !== objectId ||
          (proposal.capability ?? proposal.action) !== capability
        ) {
          throw new ProposalStoreError("SHADOW_CASE_PROPOSAL_SCOPE_MISMATCH", "shadow case does not match the proposal's trusted tenant, target, or capability");
        }
      }
      if (input.agent_result === "proposed" && !input.proposed_effect) {
        throw new ProposalStoreError("SHADOW_PROPOSED_EFFECT_REQUIRED", "a proposed shadow case requires a normalized proposed effect");
      }
      const proposedEffect = input.proposed_effect ? normalizeShadowEffect(input.proposed_effect, "shadow_case.proposed_effect") : undefined;
      const riskScore = optionalFiniteNumber(input.risk_score, "shadow risk_score", 0, 100);
      const amountValue = optionalFiniteNumber(
        input.amount_value ?? (proposedEffect ? effectAmountValue(proposedEffect) : undefined),
        "shadow amount_value",
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const createdAt = optionalIsoTimestamp(input.created_at, "shadow case created_at") ?? new Date().toISOString();
      const caseId = `scase_${canonicalJsonDigest({
        study_id: study.study_id,
        request_id: requestId,
        tenant_id: tenantId,
        business_object: businessObject,
        object_id: objectId,
      }).slice("sha256:".length, "sha256:".length + 20)}`;
      const payload = {
        request_id: requestId,
        tenant_id: tenantId,
        principal: input.principal,
        capability,
        business_object: businessObject,
        object_id: objectId,
        evidence_bundle_id: input.evidence_bundle_id,
        proposed_effect: proposedEffect,
        decision_reason: input.decision_reason,
      };
      assertNoSecretMaterial(payload, "shadow_case");
      this.db.prepare(`
        INSERT INTO shadow_study_cases (
          case_id, study_id, request_id, proposal_id, tenant_id, principal,
          capability, business_object, object_id, evidence_bundle_id,
          proposed_effect_json, agent_result, decision_reason, risk_score,
          amount_value, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(study_id, request_id, tenant_id, business_object, object_id)
        DO NOTHING
      `).run(
        caseId,
        study.study_id,
        requestId,
        input.proposal_id ?? null,
        tenantId,
        optionalBoundedText(input.principal, "shadow principal", 256) ?? null,
        capability,
        businessObject,
        objectId,
        optionalBoundedText(input.evidence_bundle_id, "shadow evidence reference", 256) ?? null,
        proposedEffect ? JSON.stringify(proposedEffect) : null,
        input.agent_result,
        optionalBoundedText(input.decision_reason, "shadow decision reason", 2_000) ?? null,
        riskScore ?? null,
        amountValue ?? null,
        createdAt,
      );
      const stored = this.getShadowCase(caseId)
        ?? this.shadowCases(study.study_id).find((item) =>
          item.request_id === requestId &&
          item.tenant_id === tenantId &&
          item.business_object === businessObject &&
          item.object_id === objectId
        );
      if (!stored) throw new ProposalStoreError("SHADOW_CASE_CREATE_FAILED", `shadow case ${caseId} was not persisted`);
      if (
        stored.agent_result !== input.agent_result ||
        stored.capability !== capability ||
        stored.proposal_id !== input.proposal_id
      ) {
        throw new ProposalStoreError("SHADOW_CASE_IDENTITY_CONFLICT", `shadow case identity already exists with different immutable intent`);
      }
      return stored;
    },
  
  getShadowCase(caseId: string): StoredShadowCase | undefined {
      return rowToShadowCase(this.db.prepare("SELECT * FROM shadow_study_cases WHERE case_id = ?").get(caseId));
    },
  
  shadowCases(studyId: string): StoredShadowCase[] {
      return this.db.prepare(`
        SELECT * FROM shadow_study_cases WHERE study_id = ?
        ORDER BY created_at ASC, case_id ASC
      `).all(studyId).map(rowToShadowCase).filter((item): item is StoredShadowCase => item !== undefined);
    },
  
  recordShadowOutcome(input: {
      study_id: string;
      request_id: string;
      proposal_id?: string;
      tenant_id: string;
      business_object: string;
      object_id: string;
      actor: string;
      disposition: ShadowOutcomeDisposition;
      actual_effect?: ShadowEffect;
      occurred_at?: string;
      source: string;
      reference?: string;
      reason?: string;
    }): StoredShadowOutcome {
      const study = this.requireShadowStudy(input.study_id);
      const requestId = requiredBoundedText(input.request_id, "shadow outcome request_id", 256);
      const tenantId = requiredBoundedText(input.tenant_id, "shadow outcome tenant_id", 256);
      const businessObject = requiredBoundedText(input.business_object, "shadow outcome business_object", 128);
      const objectId = requiredBoundedText(input.object_id, "shadow outcome object_id", 256);
      assertShadowOutcomeDisposition(input.disposition);
      const matchingCase = this.shadowCases(study.study_id).find((item) =>
        item.request_id === requestId &&
        item.tenant_id === tenantId &&
        item.business_object === businessObject &&
        item.object_id === objectId
      );
      if (!matchingCase) {
        throw new ProposalStoreError("SHADOW_OUTCOME_CASE_NOT_FOUND", "authoritative outcome does not match a case in this shadow study");
      }
      if (input.proposal_id !== undefined && matchingCase.proposal_id !== input.proposal_id) {
        throw new ProposalStoreError("SHADOW_OUTCOME_PROPOSAL_MISMATCH", "authoritative outcome proposal does not match the correlated shadow case");
      }
      if (input.disposition === "applied" && !input.actual_effect) {
        throw new ProposalStoreError("SHADOW_ACTUAL_EFFECT_REQUIRED", "an applied authoritative outcome requires actual before/after effect");
      }
      const actualEffect = input.actual_effect ? normalizeShadowEffect(input.actual_effect, "shadow_outcome.actual_effect") : undefined;
      const occurredAt = optionalIsoTimestamp(input.occurred_at, "shadow outcome occurred_at") ?? new Date().toISOString();
      const actor = requiredBoundedText(input.actor, "shadow outcome actor", 256);
      const source = requiredBoundedText(input.source, "shadow outcome source", 256);
      const reference = optionalBoundedText(input.reference, "shadow outcome reference", 1_024);
      const reason = optionalBoundedText(input.reason, "shadow outcome reason", 2_000);
      assertNoSecretMaterial({
        request_id: requestId,
        tenant_id: tenantId,
        business_object: businessObject,
        object_id: objectId,
        actor,
        source,
        actual_effect: actualEffect,
        reference,
        reason,
      }, "shadow_outcome");
      const outcomeId = `sout_${canonicalJsonDigest({
        study_id: study.study_id,
        request_id: requestId,
        tenant_id: tenantId,
        business_object: businessObject,
        object_id: objectId,
        actor,
        disposition: input.disposition,
        actual_effect: actualEffect ?? null,
        occurred_at: occurredAt,
        source,
        reference: reference ?? null,
      }).slice("sha256:".length, "sha256:".length + 20)}`;
      this.db.prepare(`
        INSERT OR IGNORE INTO shadow_outcomes (
          outcome_id, study_id, request_id, proposal_id, tenant_id,
          business_object, object_id, actor, disposition, actual_effect_json,
          occurred_at, source, reference, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        outcomeId,
        study.study_id,
        requestId,
        matchingCase.proposal_id ?? null,
        tenantId,
        businessObject,
        objectId,
        actor,
        input.disposition,
        actualEffect ? JSON.stringify(actualEffect) : null,
        occurredAt,
        source,
        reference ?? null,
        reason ?? null,
        new Date().toISOString(),
      );
      const outcome = this.getShadowOutcome(outcomeId);
      if (!outcome) throw new ProposalStoreError("SHADOW_OUTCOME_CREATE_FAILED", `shadow outcome ${outcomeId} was not persisted`);
      return outcome;
    },
  
  getShadowOutcome(outcomeId: string): StoredShadowOutcome | undefined {
      return rowToShadowOutcome(this.db.prepare("SELECT * FROM shadow_outcomes WHERE outcome_id = ?").get(outcomeId));
    },
  
  shadowOutcomes(studyId: string): StoredShadowOutcome[] {
      return this.db.prepare(`
        SELECT * FROM shadow_outcomes WHERE study_id = ?
        ORDER BY occurred_at ASC, outcome_id ASC
      `).all(studyId).map(rowToShadowOutcome).filter((item): item is StoredShadowOutcome => item !== undefined);
    },
  
  compareShadowStudyCase(caseId: string): ShadowStudyComparison {
      const shadowCase = this.getShadowCase(caseId);
      if (!shadowCase) throw new ProposalStoreError("SHADOW_CASE_NOT_FOUND", `shadow case not found: ${caseId}`);
      const outcome = this.latestShadowOutcomeForCase(shadowCase);
      return compareShadowStudyCase(shadowCase, outcome);
    },
  
  shadowStudyReport(studyId: string): ShadowStudyReport {
      const study = this.requireShadowStudy(studyId);
      const cases = this.shadowCases(studyId);
      const outcomes = this.shadowOutcomes(studyId);
      const comparisons = cases.map((item) => this.compareShadowStudyCase(item.case_id));
      const comparable = comparisons.filter((item) => item.comparable);
      const exact = countShadowStatus(comparisons, "exact_agreement");
      const byCapability: ShadowStudyReport["by_capability"] = {};
      const byDecisionReason: Record<string, number> = {};
      for (const comparison of comparisons) {
        byCapability[comparison.capability] ??= emptyShadowStatusCounts();
        byCapability[comparison.capability]![comparison.status] += 1;
        const reason = comparison.decision_reason ?? comparison.outcome?.reason ?? "(none recorded)";
        byDecisionReason[reason] = (byDecisionReason[reason] ?? 0) + 1;
      }
      const amountValues = comparisons
        .map((item) => item.amount_value)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
      const highestRisk = comparisons
        .filter((item) => item.status === "disagreement" || item.status === "partial_agreement" || item.status === "invalid_or_unsafe_scope_attempt")
        .sort((left, right) =>
          (right.risk_score ?? 0) - (left.risk_score ?? 0) ||
          (right.amount_value ?? 0) - (left.amount_value ?? 0) ||
          left.case_id.localeCompare(right.case_id)
        )
        .slice(0, 10);
      const suggestedPolicies = suggestedShadowPolicies(comparisons);
      return {
        study,
        total_tasks_observed: comparisons.length,
        tasks_with_authoritative_outcomes: comparisons.filter((item) => item.outcome !== undefined).length,
        comparable_tasks: comparable.length,
        exact_agreements: exact,
        exact_agreement_rate: comparable.length === 0 ? null : exact / comparable.length,
        partial_agreements: countShadowStatus(comparisons, "partial_agreement"),
        disagreements: countShadowStatus(comparisons, "disagreement"),
        human_rejections_no_action: countShadowStatus(comparisons, "human_rejected_no_action"),
        policy_denials: countShadowStatus(comparisons, "agent_policy_denied"),
        stale_conflicts: countShadowStatus(comparisons, "stale_conflict"),
        unmatched_cases: countShadowStatus(comparisons, "unmatched_no_authoritative_outcome"),
        invalid_or_unsafe_scope_attempts: countShadowStatus(comparisons, "invalid_or_unsafe_scope_attempt"),
        amount_value_distribution: distribution(amountValues),
        by_capability: byCapability,
        by_decision_reason: byDecisionReason,
        highest_risk_disagreements: highestRisk,
        suggested_policies: suggestedPolicies,
        trust_progression: shadowTrustProgression(comparisons, suggestedPolicies),
        comparisons,
        generated_at: latestIsoTimestamp([
          study.updated_at,
          ...cases.map((item) => item.created_at),
          ...outcomes.map((item) => item.created_at),
        ]),
      };
    },
  
  requireShadowStudy(studyId: string): StoredShadowStudy {
      const study = this.getShadowStudy(studyId);
      if (!study) throw new ProposalStoreError("SHADOW_STUDY_NOT_FOUND", `shadow study not found: ${studyId}`);
      return study;
    },
  
  latestShadowOutcomeForCase(shadowCase: StoredShadowCase): StoredShadowOutcome | undefined {
      return rowToShadowOutcome(this.db.prepare(`
        SELECT * FROM shadow_outcomes
        WHERE study_id = ? AND request_id = ? AND tenant_id = ?
          AND business_object = ? AND object_id = ?
        ORDER BY occurred_at DESC, outcome_id DESC
        LIMIT 1
      `).get(
        shadowCase.study_id,
        shadowCase.request_id,
        shadowCase.tenant_id,
        shadowCase.business_object,
        shadowCase.object_id,
      ));
    },
  
  attachShadowChangeSetToActiveStudies(changeSet: ChangeSet, createdAt: string): void {
      const studies = this.db.prepare("SELECT * FROM shadow_studies WHERE status = 'active'").all()
        .map(rowToShadowStudy)
        .filter((study): study is StoredShadowStudy => study !== undefined);
      for (const study of studies) {
        if (!shadowStudyIncludes(study, changeSet.action, createdAt)) continue;
        this.insertShadowCaseFromChangeSet(study.study_id, changeSet, createdAt);
      }
    },
  
  insertShadowCaseFromChangeSet(studyId: string, changeSet: ChangeSet, createdAt: string): void {
      const requestId = changeSet.proposal_id;
      const caseId = `scase_${canonicalJsonDigest({
        study_id: studyId,
        request_id: requestId,
        tenant_id: changeSet.scope.tenant_id,
        business_object: changeSet.scope.business_object,
        object_id: changeSet.scope.object_id,
      }).slice("sha256:".length, "sha256:".length + 20)}`;
      const effect = shadowEffectFromChangeSet(changeSet);
      this.db.prepare(`
        INSERT OR IGNORE INTO shadow_study_cases (
          case_id, study_id, request_id, proposal_id, tenant_id, principal,
          capability, business_object, object_id, evidence_bundle_id,
          proposed_effect_json, agent_result, decision_reason, risk_score,
          amount_value, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', NULL, NULL, ?, ?)
      `).run(
        caseId,
        studyId,
        requestId,
        changeSet.proposal_id,
        changeSet.scope.tenant_id,
        changeSet.principal.id,
        changeSet.action,
        changeSet.scope.business_object,
        changeSet.scope.object_id,
        changeSet.evidence.bundle_id,
        JSON.stringify(effect),
        effectAmountValue(effect) ?? null,
        createdAt,
      );
    },
  
  recordShadowHumanAction(
      proposalId: string,
      input: { actor: string; patch: Record<string, unknown>; notes?: string },
    ): StoredShadowHumanAction {
      const proposal = this.requireProposal(proposalId);
      if (proposal.change_set.mode !== "shadow") {
        throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${proposalId} is not a shadow proposal`);
      }
      assertNoSecretMaterial(input.patch, "shadow_human_action.patch");
      const now = new Date().toISOString();
      let actionId = 0;
      this.transaction(() => {
        const result = this.db.prepare(`
          INSERT INTO shadow_human_actions (proposal_id, actor, patch_json, notes, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(proposalId, input.actor, JSON.stringify(input.patch), input.notes ?? null, now);
        actionId = Number(result.lastInsertRowid);
        this.appendEvent(proposalId, "shadow_human_action_recorded", input.actor, {
          action_id: actionId,
          patch_columns: Object.keys(input.patch),
          notes: input.notes ?? null,
        });
      });
      const action = this.shadowHumanActions(proposalId).find((item) => item.action_id === actionId);
      if (!action) throw new ProposalStoreError("SHADOW_ACTION_CREATE_FAILED", `shadow action for ${proposalId} was not persisted`);
      const legacyStudy = this.getShadowStudy("sst_legacy")
        ?? this.createShadowStudy({
          study_id: "sst_legacy",
          name: "Legacy shadow comparison",
          description: "Compatibility study for shadow record-human-action commands.",
        });
      const shadowCase = this.addShadowProposalToStudy(legacyStudy.study_id, proposalId);
      this.recordShadowOutcome({
        study_id: legacyStudy.study_id,
        request_id: shadowCase.request_id,
        proposal_id: proposalId,
        tenant_id: proposal.tenant_id,
        business_object: proposal.business_object,
        object_id: proposal.object_id,
        actor: input.actor,
        disposition: "applied",
        actual_effect: normalizeShadowEffect({
          before: proposal.change_set.before,
          after: { ...proposal.change_set.before, ...input.patch },
          patch: input.patch,
        }, "shadow_human_action.effect"),
        occurred_at: now,
        source: "legacy_cli",
        reference: `shadow_human_action:${actionId}`,
        reason: input.notes,
      });
      return action;
    },
  
  shadowHumanActions(proposalId: string): StoredShadowHumanAction[] {
      const rows = this.db.prepare("SELECT * FROM shadow_human_actions WHERE proposal_id = ? ORDER BY action_id ASC").all(proposalId);
      return rows.map(rowToShadowHumanAction).filter((action): action is StoredShadowHumanAction => action !== undefined);
    },
  
  compareShadowProposal(proposalId: string): ShadowComparison {
      const proposal = this.requireProposal(proposalId);
      if (proposal.change_set.mode !== "shadow") {
        throw new ProposalStoreError("NOT_SHADOW_PROPOSAL", `proposal ${proposalId} is not a shadow proposal`);
      }
      const actions = this.shadowHumanActions(proposalId);
      const latest = actions.at(-1);
      return comparePatches(proposalId, proposal.change_set.patch, latest);
    },
  
  shadowReport(): ShadowReport {
      const proposals = this.listProposals().filter((proposal) => proposal.change_set.mode === "shadow");
      const comparisons = proposals.map((proposal) => this.compareShadowProposal(proposal.proposal_id));
      return {
        total_shadow_proposals: proposals.length,
        with_human_action: comparisons.filter((comparison) => comparison.status !== "no_human_action").length,
        exact_matches: comparisons.filter((comparison) => comparison.status === "exact_match").length,
        partial_matches: comparisons.filter((comparison) => comparison.status === "partial_match").length,
        mismatches: comparisons.filter((comparison) => comparison.status === "mismatch").length,
        no_human_action: comparisons.filter((comparison) => comparison.status === "no_human_action").length,
        comparisons,
      };
    },
};
