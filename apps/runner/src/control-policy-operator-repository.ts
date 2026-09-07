import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import type { ControlPolicyKey, ControlPolicyPointer, ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { decodeOperatorAuthority, encodeOperatorAuthority, validateOperatorPolicySnapshot,
  OPERATOR_READ_SELECTION, OPERATOR_READ_AUTHORING, OPERATOR_EXECUTION_POLICY, type StoredOperatorAuthority } from "./control-policy-authority-codec.js";
import type { StoredReadAuthoring } from "./control-policy-read-authoring.js";
import { commitImmutableControlPolicies, type BoundProjectPolicyStore, type ControlPolicyMigrationSnapshot } from "./control-policy-store.js";
import { assertGovernedReadEditDecision, type GovernedReadEditDecision } from "./control-policy-read-edit.js";

export type OperatorAuthorityState = {
  epoch: number;
  active: Array<{ revision: ControlPolicyRevision; policy: StoredOperatorAuthority }>;
  drafts: Array<{ revision: ControlPolicyRevision; policy: StoredOperatorAuthority }>;
};
export type OperatorAuthorityChange = { key: ControlPolicyKey; policy: StoredOperatorAuthority | null };

/** Internal operator persistence, not a management authorization endpoint.
 * Call only after the existing operator review/current-source checks. A model
 * must never receive a callable reference to this service or choose its actor. */
export class OperatorAuthorityRepository {
  constructor(private readonly binding: BoundProjectPolicyStore, private readonly runtimeConfig?: RuntimeConfig) {}

  async current(): Promise<OperatorAuthorityState> {
    return this.currentState(false);
  }

  async currentReadState(): Promise<OperatorAuthorityState> {
    return this.currentState(true);
  }

  private async currentState(readOnly: boolean): Promise<OperatorAuthorityState> {
    const snapshot = await this.binding.repository.scopeSnapshot({ deployment_id: this.binding.deployment_id,
      scope: { level: "operator" }, kinds: readOnly ? ["read", "management"] : ["read", "action", "execution", "management"] });
    // Other management documents have distinct validators and authority. They
    // cannot be interpreted as the selected Read pointer or changed here.
    const managed = (revision: ControlPolicyRevision) => revision.kind !== "management"
      || keyDigest(revision) === keyDigest(OPERATOR_READ_SELECTION)
      || keyDigest(revision) === keyDigest(OPERATOR_READ_AUTHORING);
    const active = snapshot.active.filter(managed);
    const drafts = snapshot.drafts.filter(managed);
    const records = asSnapshot(active, drafts);
    validateOperatorPolicySnapshot(records, { runtimeConfig: this.runtimeConfig });
    const decode = (revision: ControlPolicyRevision) => ({ revision,
      policy: decodeOperatorAuthority(revision, { runtimeConfig: this.runtimeConfig }) });
    return { epoch: snapshot.epoch, active: active.map(decode), drafts: drafts.map(decode) };
  }

  /** Replace the complete reviewed authoring set and its disabled candidates
   * together. Selection here is editing context, never active Read authority. */
  async commitReadAuthoring(input: {
    expected_epoch: number; expected_revision_id: string | null;
    authoring: StoredReadAuthoring; actor: string; operation: string;
    verifiedDecision?: GovernedReadEditDecision;
  }): Promise<Awaited<ReturnType<OperatorAuthorityRepository["commit"]>>> {
    const frozen = structuredClone(input);
    const before = await this.currentReadState();
    const previous = before.active.find(({ policy }) => policy.type === "read_authoring");
    if (before.epoch !== frozen.expected_epoch
      || (previous?.revision.revision_id ?? null) !== frozen.expected_revision_id) fail("POLICY_REVISION_CONFLICT");
    if (frozen.verifiedDecision) {
      const prior = previous?.policy;
      const selected = frozen.authoring.entries.find((entry) => entry.progress.boundary_id === frozen.authoring.selected_boundary_id);
      if (prior?.type !== "read_authoring" || !selected || frozen.operation !== "edit_prepared_read"
        || prior.selected_boundary_id !== frozen.authoring.selected_boundary_id
        || canonicalJsonDigest(prior.entries.filter((entry) => entry.progress.boundary_id !== prior.selected_boundary_id))
          !== canonicalJsonDigest(frozen.authoring.entries.filter((entry) => entry.progress.boundary_id !== prior.selected_boundary_id))) {
        fail("POLICY_READ_EDIT_DECISION_INVALID");
      }
      assertGovernedReadEditDecision(frozen.verifiedDecision, this.binding, frozen.actor, {
        before: { repository_id: this.binding.repository_id, deployment_id: this.binding.deployment_id,
          project_id: this.binding.project_id, epoch: before.epoch, revision_id: previous!.revision.revision_id },
        review_decision_digest: frozen.verifiedDecision.review_decision_digest,
        candidate_digest: selected.progress.candidate_digest,
        generated_contract_digest: selected.candidate_lock.generated_contract_digest,
      });
    }
    const desired: OperatorAuthorityChange[] = frozen.authoring.entries.filter((entry) => entry.stage !== "metadata_only").map((entry) => ({
      key: { scope: { level: "operator" }, kind: "read", name: entry.progress.candidate.pack.name },
      policy: { type: "read", boundary: entry.progress.candidate, generation_lock: entry.candidate_lock },
    }));
    const retained = new Set(desired.map((change) => keyDigest(change.key)));
    const previousDrafts = new Map(before.drafts.map((entry) => [keyDigest(entry.revision), entry.policy]));
    const drafts = desired.filter((change) => canonicalJsonDigest(change.policy)
      !== canonicalJsonDigest(previousDrafts.get(keyDigest(change.key)) ?? null));
    for (const { revision } of before.drafts) {
      if (revision.kind === "read" && !retained.has(keyDigest(revision))) {
        drafts.push({ key: { scope: revision.scope, kind: revision.kind, name: revision.name }, policy: null });
      }
    }
    return this.commitAgainstState({ expected_epoch: frozen.expected_epoch, actor: frozen.actor, operation: frozen.operation,
      drafts, active: [{ key: OPERATOR_READ_AUTHORING, policy: frozen.authoring }], verifiedDecision: frozen.verifiedDecision }, before);
  }

  /** Commits an exact reviewed set, never a best-effort merge after a race.
   * No source calls, file exports, budget resets, or reactivation of history. */
  async commit(input: {
    expected_epoch: number; active?: OperatorAuthorityChange[]; drafts?: OperatorAuthorityChange[];
    actor: string; operation: string;
  }): Promise<{ epoch: number; changes: Array<{ state: "active" | "draft"; key: ControlPolicyKey; before: string | null; after: string | null }> }> {
    return this.commitAgainstState(structuredClone(input), await this.current());
  }

  private async commitAgainstState(input: {
    expected_epoch: number; active?: OperatorAuthorityChange[]; drafts?: OperatorAuthorityChange[];
    actor: string; operation: string;
    verifiedDecision?: GovernedReadEditDecision;
  }, before: OperatorAuthorityState): Promise<Awaited<ReturnType<OperatorAuthorityRepository["commit"]>>> {
    const frozen = structuredClone(input);
    if (!validLabel(frozen.actor) || !validLabel(frozen.operation)) fail("POLICY_REVIEW_RECEIPT_INVALID");
    if ((frozen.active?.length ?? 0) + (frozen.drafts?.length ?? 0) > 64) fail("POLICY_BATCH_TOO_LARGE");
    if (before.epoch !== frozen.expected_epoch) fail("POLICY_REVISION_CONFLICT");
    const next = { active: new Map(before.active.map(({ revision }) => [keyDigest(revision), revision])),
      drafts: new Map(before.drafts.map(({ revision }) => [keyDigest(revision), revision])) };
    const incoming = new Map<string, ControlPolicyRevision>();
    const pointers: { active: ControlPolicyPointer[]; drafts: ControlPolicyPointer[] } = { active: [], drafts: [] };
    const changes: Array<{ state: "active" | "draft"; key: ControlPolicyKey; before: string | null; after: string | null }> = [];
    for (const state of ["active", "drafts"] as const) {
      const seen = new Set<string>();
      for (const change of frozen[state] ?? []) {
        assertManagedKey(change.key);
        const key = keyDigest(change.key);
        if (seen.has(key)) fail("POLICY_DUPLICATE_POINTER");
        seen.add(key);
        const revision = change.policy === null ? undefined
          : encodeOperatorAuthority(change.policy, { runtimeConfig: this.runtimeConfig });
        if (revision && keyDigest(revision) !== key) fail("POLICY_AUTHORITY_IDENTITY_MISMATCH");
        const prior = next[state].get(key);
        if ((prior?.revision_id ?? null) === (revision?.revision_id ?? null)) continue;
        if (revision) { next[state].set(key, revision); incoming.set(revision.revision_id, revision); }
        else next[state].delete(key);
        pointers[state].push({ ...change.key, revision_id: revision?.revision_id ?? null });
        changes.push({ state: state === "active" ? "active" : "draft", key: change.key,
          before: prior?.revision_id ?? null, after: revision?.revision_id ?? null });
      }
    }
    const proposed = asSnapshot([...next.active.values()], [...next.drafts.values()]);
    validateOperatorPolicySnapshot(proposed, { runtimeConfig: this.runtimeConfig });
    assertNewActivationDependencies([...next.active.values()], changes, this.runtimeConfig);
    if (!changes.length) {
      if (frozen.verifiedDecision) fail("POLICY_READ_EDIT_NO_CHANGE");
      return { epoch: before.epoch, changes };
    }
    // The epoch CAS covers concurrent edits, revocations and dependency changes
    // during compilation and the immutable-history lookups above.
    if (frozen.verifiedDecision) {
      assertGovernedReadEditDecision(frozen.verifiedDecision, this.binding, frozen.actor, frozen.verifiedDecision);
    }
    const event = { event_id: frozen.verifiedDecision?.event_id ?? randomUUID(), actor: frozen.actor, occurred_at: new Date().toISOString(),
      receipt: { operation: frozen.operation, changes, source_database_changed: false,
        ...(frozen.verifiedDecision ? { verified_decision: frozen.verifiedDecision } : {}) } };
    let epoch: number;
    try {
      epoch = await commitImmutableControlPolicies(this.binding, {
        expected_epoch: before.epoch, revisions: [...incoming.values()], ...pointers, event });
    } catch (error) {
      if (!frozen.verifiedDecision || (error as { code?: string }).code === "POLICY_EVENT_ALREADY_RECORDED") throw error;
      // Lost COMMIT responses require this exact receipt, not a coincidentally
      // matching candidate or a newer policy pointer.
      let recorded;
      try { recorded = await this.binding.repository.event(this.binding.deployment_id, event.event_id); }
      catch {
        throw Object.assign(new Error("Read edit could not be confirmed. Inspect the control-store review receipt before retrying; do not assume the draft is unchanged. Active authority was not changed by this edit."),
          { code: "POLICY_READ_EDIT_COMMIT_UNCONFIRMED" });
      }
      if (!recorded || canonicalJsonDigest(recorded) !== canonicalJsonDigest({ ...event, epoch: before.epoch + 1 })) throw error;
      epoch = recorded.epoch;
    }
    return { epoch, changes };
  }
}

function asSnapshot(active: ControlPolicyRevision[], drafts: ControlPolicyRevision[]): ControlPolicyMigrationSnapshot {
  const revisions = new Map([...active, ...drafts].map((revision) => [revision.revision_id, revision]));
  const pointer = (revision: ControlPolicyRevision): ControlPolicyPointer => ({ scope: revision.scope, kind: revision.kind,
    name: revision.name, revision_id: revision.revision_id });
  return { revisions: [...revisions.values()], active: active.map(pointer), drafts: drafts.map(pointer), provenance: [] };
}

function assertNewActivationDependencies(active: ControlPolicyRevision[],
  changes: Array<{ state: "active" | "draft"; key: ControlPolicyKey }>, runtimeConfig?: RuntimeConfig): void {
  const changed = new Set(changes.filter((change) => change.state === "active").map((change) => keyDigest(change.key)));
  const reads = new Map(active.filter((entry) => entry.kind === "read").map((entry) => [entry.name, entry.authority_digest]));
  for (const revision of active) {
    if (revision.kind !== "action" || !changed.has(keyDigest(revision))) continue;
    const policy = decodeOperatorAuthority(revision, { runtimeConfig });
    if (policy.type !== "action") fail("POLICY_AUTHORITY_IDENTITY_MISMATCH");
    for (const rule of policy.authority.authority.rules) {
      if (reads.get(rule.read_boundary_name) !== rule.read_boundary_digest) fail("ACTION_RULE_READ_AUTHORITY_STALE");
    }
  }
  if (changed.has(keyDigest(OPERATOR_EXECUTION_POLICY))) {
    const execution = active.find((revision) => keyDigest(revision) === keyDigest(OPERATOR_EXECUTION_POLICY));
    const policy = execution && decodeOperatorAuthority(execution, { runtimeConfig });
    if (policy?.type === "execution" && policy.policy.enabled) {
      const action = active.find((revision) => revision.kind === "action");
      const authority = action && decodeOperatorAuthority(action, { runtimeConfig });
      for (const outcome of policy.policy.outcomes ?? []) {
        if (authority?.type !== "action" || authority.authority.authority.action_boundary.digest !== outcome.action_boundary_digest) {
          fail("POLICY_EXECUTION_AUTHORITY_STALE");
        }
        const rule = authority.authority.authority.rules.find((entry) => entry.rule.outcome === outcome.outcome);
        if (!rule || reads.get(rule.read_boundary_name) !== rule.read_boundary_digest) fail("POLICY_EXECUTION_AUTHORITY_STALE");
      }
    }
  }
  // A Read revocation is allowed to make an existing Action unavailable. It
  // must not silently rebind, delete or republish that immutable Action.
}

function assertManagedKey(key: ControlPolicyKey): void {
  if (key.scope.level !== "operator" || !validLabel(key.name)
    || (!["read", "action"].includes(key.kind) && keyDigest(key) !== keyDigest(OPERATOR_READ_SELECTION)
      && keyDigest(key) !== keyDigest(OPERATOR_READ_AUTHORING)
      && keyDigest(key) !== keyDigest(OPERATOR_EXECUTION_POLICY))) {
    fail("POLICY_AUTHORITY_IDENTITY_MISMATCH");
  }
}

function keyDigest(key: ControlPolicyKey): string {
  return canonicalJsonDigest({ scope: key.scope, kind: key.kind, name: key.name });
}
function validLabel(value: string): boolean { return typeof value === "string" && value.length > 0 && value.length <= 256
  && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value); }
function fail(code: string): never { throw Object.assign(new Error(`${code}: the reviewed policy was not changed.`), { code }); }
