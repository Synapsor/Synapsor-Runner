import crypto, { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { assertValidRunnerCapabilityConfig } from "@synapsor-runner/config";
import { resolveRuntimeConfig, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { encodeOperatorExecutionPolicy, executionBindingDigest, readOperatorExecutionConfig } from "./control-policy-execution.js";
import { openProjectControlPolicies } from "./control-policy-store.js";
import { OPERATOR_APPROVER_IDENTITY_KEY, OPERATOR_EXECUTION_POLICY_KEY, OPERATOR_POLICY_RECORD_VERSION,
  storedOperatorPolicyRecord } from "./control-policy-record.js";
import { publishPolicyConfiguration, recoverPolicyConfiguration } from "./control-policy-config-publication.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";
import { createActiveActionRuleAuthorityLoader } from "./action-rule-authority.js";
import { resolveActivatedActionRule } from "@synapsor-runner/action-rules";
import { operatorPublicKeyFingerprint, signedOperatorKeyAlgorithm } from "./operator-identity.js";

type Identity = NonNullable<RuntimeConfig["operator_identity"]>;
type Input = { projectRoot: string; configPath: string; identity?: unknown; previousConfigPath?: string;
  storePath?: string; env?: NodeJS.ProcessEnv };

function fail(code: string, detail: string): never {
  const outcome = code.startsWith("LOCAL_INSTALLATION_OPERATOR_")
    ? "No delayed request was cancelled."
    : "No approver configuration or execution authority was changed.";
  throw Object.assign(new Error(`${code}: ${detail} ${outcome}`), { code });
}

function withoutIdentity(config: RuntimeConfig): RuntimeConfig {
  const copy = structuredClone(config);
  delete copy.operator_identity;
  return copy;
}

async function ownedFile(file: string, directory = false, code = "POLICY_APPROVER_LOCAL_ADMIN_REQUIRED"): Promise<void> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || stat.uid !== process.geteuid?.()
    || (stat.mode & 0o022) !== 0) {
    fail(code, "Use the existing local deployment-operator account that owns the private project and configuration.");
  }
}

/** Local installation ownership is an explicit management trust boundary,
 * not a verified administrator identity or an approval credential. */
export async function assertLocalInstallationOperator(input: {
  projectRoot: string; configPath: string; storePath?: string;
}): Promise<void> {
  const root = path.resolve(input.projectRoot);
  const config = path.resolve(input.configPath);
  if (!within(root, config) || (input.storePath && !within(root, path.resolve(input.storePath)))) {
    fail("LOCAL_INSTALLATION_OPERATOR_SCOPE_INVALID", "Cancellation must use this installation's private project and store.");
  }
  await ownedFile(root, true, "LOCAL_INSTALLATION_OPERATOR_REQUIRED");
  await ownedFile(config, false, "LOCAL_INSTALLATION_OPERATOR_REQUIRED");
  if (input.storePath) await ownedFile(path.resolve(input.storePath), false, "LOCAL_INSTALLATION_OPERATOR_REQUIRED");
}

async function readConfig(file: string): Promise<{ text: string; raw: RuntimeConfig }> {
  await ownedFile(file);
  const stat = await fs.stat(file);
  if (stat.size > 1_048_576) fail("POLICY_APPROVER_CONFIG_TOO_LARGE", "The runtime configuration exceeds the review limit.");
  const text = await fs.readFile(file, "utf8");
  return { text, raw: JSON.parse(text) as RuntimeConfig };
}

function within(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function fingerprints(identity: Identity, configPath: string, projectRoot: string) {
  if (identity.provider !== "signed_key" || !identity.operators || !Object.keys(identity.operators).length) {
    fail("POLICY_APPROVER_SIGNED_KEY_REQUIRED", "This transition supports a reviewed signed-key operator roster.");
  }
  const result: Array<{ subject: string; roles: string[]; outcomes: string[]; public_key_fingerprint: string;
    authority_kind?: "legacy" | "scoped_apply"; apply_outcomes?: string[] }> = [];
  for (const [subject, operator] of Object.entries(identity.operators).sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.resolve(path.dirname(configPath), operator.public_key_path);
    if (!within(projectRoot, file)) fail("POLICY_APPROVER_KEY_OUTSIDE_PROJECT", "Select project-owned public verification material.");
    await ownedFile(file);
    const publicKey = await fs.readFile(file);
    try { signedOperatorKeyAlgorithm(publicKey); }
    catch (error) {
      if ((error as { code?: string }).code === "OPERATOR_SIGNING_KEY_UNUSABLE") {
        fail("POLICY_APPROVER_KEY_UNUSABLE", "RSA approver public keys must be at least 2048 bits.");
      }
      fail("POLICY_APPROVER_KEY_UNSUPPORTED", "Only Ed25519 and RSA public keys can be enrolled for signed approval.");
    }
    const fingerprint = operatorPublicKeyFingerprint(publicKey);
    if (operator.public_key_fingerprint && operator.public_key_fingerprint !== fingerprint) {
      fail("POLICY_APPROVER_KEY_CHANGED", "The proposed fingerprint does not match its public verification material.");
    }
    result.push({ subject, roles: [...operator.roles].sort(), outcomes: [...(operator.outcomes ?? [])].sort(),
      public_key_fingerprint: fingerprint,
      ...(identity.roster_version === 2 ? { authority_kind: operator.authority_kind,
        ...(operator.authority_kind === "scoped_apply" ? { apply_outcomes: [...(operator.apply_outcomes ?? [])].sort() } : {}) } : {}) });
  }
  return result;
}

/** Trusted local deployment-operator setup. This management path can repair a
 * disabled/stale execution binding but cannot authorize source execution. */
export async function prepareApproverPolicyConfiguration(input: Input) {
  return prepareOperatorIdentityConfiguration(input, "approver");
}

export async function prepareScopedApplyPolicyConfiguration(input: Input) {
  return prepareOperatorIdentityConfiguration(input, "scoped_apply");
}

async function prepareOperatorIdentityConfiguration(input: Input, mode: "approver" | "scoped_apply") {
  const projectRoot = await fs.realpath(input.projectRoot), configPath = path.resolve(input.configPath);
  if (!within(projectRoot, configPath)) fail("POLICY_APPROVER_PROJECT_MISMATCH", "Select this project's Action runtime configuration.");
  await ownedFile(projectRoot, true);
  await recoverPolicyConfiguration({ projectRoot, configPath, env: input.env });
  const current = await readConfig(configPath);
  const resolve = (raw: RuntimeConfig) => resolveRuntimeConfig(raw, path.dirname(configPath));
  const selected = resolve(current.raw);
  assertValidRunnerCapabilityConfig(selected);
  if (!selected.action_rules || await fs.realpath(selected.action_rules.project_root) !== projectRoot) {
    fail("POLICY_APPROVER_PROJECT_MISMATCH", "Select the exact reviewed Action deployment.");
  }
  const binding = await openProjectControlPolicies({ projectRoot, config: selected, env: input.env,
    storePath: input.storePath ?? path.resolve(path.dirname(configPath), selected.storage?.sqlite_path ?? ".synapsor/local.db") });
  if (!binding) fail("POLICY_APPROVER_STORAGE_REQUIRED", "Review policy storage before changing approver identity.");
  try {
    let beforeConfig = selected, recovery = false;
    let execution;
    try { execution = await readOperatorExecutionConfig({ projectRoot, configPath, config: beforeConfig, policyStore: binding,
      allowUnavailablePinnedKeysForManagement: true }); }
    catch (error) {
      if (!["POLICY_EXECUTION_BINDING_CHANGED", "POLICY_APPROVER_IDENTITY_BINDING_CHANGED"]
        .includes((error as { code?: string }).code ?? "")) throw error;
      recovery = true;
      if (!input.previousConfigPath || !within(projectRoot, path.resolve(input.previousConfigPath))) {
        fail("POLICY_APPROVER_PREVIOUS_BINDING_REQUIRED", "Supply the exact prior project configuration to prove the stored execution binding.");
      }
      beforeConfig = resolve((await readConfig(path.resolve(input.previousConfigPath))).raw);
      if (executionBindingDigest(withoutIdentity(beforeConfig)) !== executionBindingDigest(withoutIdentity(selected))) {
        fail("POLICY_APPROVER_UNRELATED_CHANGE", "Only the proposed approver identity may differ from the proven prior configuration.");
      }
      execution = await readOperatorExecutionConfig({ projectRoot, configPath, config: beforeConfig, policyStore: binding,
        allowUnavailablePinnedKeysForManagement: true });
    }
    const candidate = structuredClone(current.raw);
    if (input.identity !== undefined) {
      if (!input.identity || typeof input.identity !== "object" || Array.isArray(input.identity)) {
        fail("POLICY_APPROVER_INPUT_INVALID", "Supply one exact operator_identity object.");
      }
      candidate.operator_identity = structuredClone(input.identity) as Identity;
    }
    if (mode === "scoped_apply") candidate.version = 2;
    delete candidate.supervised_worker;
    if (execution.config.supervised_worker) {
      candidate.supervised_worker = structuredClone(execution.config.supervised_worker);
      candidate.supervised_worker.enabled = false;
    }
    let resolvedNext = resolve(candidate);
    assertValidRunnerCapabilityConfig(resolvedNext);
    if (!resolvedNext.operator_identity || canonicalJsonDigest(beforeConfig.operator_identity ?? null) === canonicalJsonDigest(resolvedNext.operator_identity)) {
      fail("POLICY_APPROVER_CHANGE_REQUIRED", "The reviewed approver roster must differ from the currently bound one.");
    }
    if (canonicalJsonDigest(beforeConfig.operator_identity?.apply_roles ?? []) !== canonicalJsonDigest(resolvedNext.operator_identity.apply_roles ?? [])) {
      fail("POLICY_APPROVER_ROLE_EXPANSION", "This transition cannot change worker, apply or closure roles.");
    }
    const roster = await fingerprints(resolvedNext.operator_identity, configPath, projectRoot);
    for (const item of roster) candidate.operator_identity!.operators![item.subject]!.public_key_fingerprint = item.public_key_fingerprint;
    resolvedNext = resolve(candidate);
    assertValidRunnerCapabilityConfig(resolvedNext);
    const nextIdentity = resolvedNext.operator_identity!;
    const active = await createActiveActionRuleAuthorityLoader(projectRoot, binding)({ dependency_check: "report" });
    const roleScopes = active.registry.approval_classes.flatMap((approval) => approval.rules.map((rule) => ({
      outcome: rule.outcome, required_role: approval.required_role,
    }))).sort((a, b) => a.outcome.localeCompare(b.outcome));
    const priorOperators = beforeConfig.operator_identity?.operators ?? {};
    const applyRoles = new Set(beforeConfig.operator_identity?.apply_roles ?? []);
    const existingApplySigner = (subject: string) => {
      const prior = priorOperators[subject], next = nextIdentity.operators?.[subject];
      if (prior?.authority_kind === "scoped_apply") {
        if (mode === "approver" && canonicalJsonDigest(prior) !== canonicalJsonDigest(next ?? null)) {
          fail("POLICY_SCOPED_APPLY_CHANGE_OUT_OF_SCOPE", "Use policy apply-operator for this exact scoped signer.");
        }
        return mode === "approver";
      }
      if (!prior || !prior.roles.length || (prior.outcomes ?? []).length ||
        !prior.roles.every((role) => applyRoles.has(role))) return false;
      if (!next || next.public_key_path !== prior.public_key_path ||
        canonicalJsonDigest(next.roles) !== canonicalJsonDigest(prior.roles) ||
        canonicalJsonDigest(next.outcomes ?? []) !== canonicalJsonDigest(prior.outcomes ?? []) ||
        (mode === "approver" && canonicalJsonDigest(next.authority_kind ?? null) !== canonicalJsonDigest(prior.authority_kind ?? null)) ||
        (prior.public_key_fingerprint !== undefined && prior.public_key_fingerprint !== next.public_key_fingerprint)) {
        fail("POLICY_APPROVER_APPLY_SIGNER_CHANGED", "An existing apply or recovery signer must remain unchanged in this approver-only transition.");
      }
      return true;
    };
    if (mode === "approver") {
      for (const subject of Object.keys(priorOperators)) existingApplySigner(subject);
      for (const item of roster) {
        if (item.authority_kind === "scoped_apply") {
          if (!priorOperators[item.subject] || canonicalJsonDigest(priorOperators[item.subject])
            !== canonicalJsonDigest(nextIdentity.operators?.[item.subject])) {
            fail("POLICY_SCOPED_APPLY_CHANGE_OUT_OF_SCOPE", "Use policy apply-operator for this exact scoped signer.");
          }
          continue;
        }
        if (existingApplySigner(item.subject)) continue;
        if (!item.outcomes.length || item.roles.some((role) => !item.outcomes.some((outcome) =>
          roleScopes.some((scope) => scope.outcome === outcome && scope.required_role === role)))
          || item.outcomes.some((outcome) => !item.roles.some((role) =>
            roleScopes.some((scope) => scope.outcome === outcome && scope.required_role === role)))) {
          const currentOutcomes = new Set(active.registry.rules.map(rule => rule.compiled.outcome));
          const obsolete = item.outcomes.filter(outcome => !currentOutcomes.has(outcome)
            && priorOperators[item.subject]?.outcomes?.includes(outcome));
          const invalidOutcomes = item.outcomes.filter(outcome => !obsolete.includes(outcome)
            && !item.roles.some(role => roleScopes.some(scope => scope.outcome === outcome && scope.required_role === role)));
          const invalidRoles = item.roles.filter(role => !item.outcomes.some(outcome =>
            roleScopes.some(scope => scope.outcome === outcome && scope.required_role === role)));
          const detail = [
            ...(obsolete.length ? [`Existing reviewer ${item.subject} retains removed outcome scope ${obsolete.join(", ")}. The complete current Action authority no longer contains that scope. Explicitly retire only that obsolete grant in the proposed roster; preserve other legitimate grants and historical verification material. If it is the last scope, remove the active reviewer entry rather than omit or empty its outcomes restriction.`] : []),
            ...(invalidOutcomes.length || invalidRoles.length || !item.outcomes.length
              ? [`Proposed reviewer ${item.subject} also has invalid grants: outcomes ${invalidOutcomes.join(", ") || (item.outcomes.length ? "none separately identified" : "unrestricted")}; roles ${invalidRoles.join(", ") || "none separately identified"}. Each reviewed role and outcome must form an exact active Action approval mandate. Retiring an obsolete scope does not authorize these grants.`] : []),
          ].join(" ");
          fail("POLICY_APPROVER_ROLE_OUT_OF_SCOPE", `${detail} Next: use policy approver --input <reviewed-roster.json> to preview and separately confirm the exact resulting roster; saving leaves execution disabled for separate review. Action removal and grant retirement are distinct operations. Historical approvals remain recorded.`);
        }
      }
    } else {
      if (nextIdentity.roster_version !== 2) fail("POLICY_SCOPED_APPLY_VERSION_REQUIRED", "Use a version 2 signed roster.");
      if (!beforeConfig.operator_identity || beforeConfig.operator_identity.provider !== "signed_key") {
        fail("POLICY_SCOPED_APPLY_SIGNED_ROSTER_REQUIRED", "Review a signed operator roster before adding a scoped APPLY signer.");
      }
      const unrelatedIdentity = (identity: Identity) => {
        const copy = structuredClone(identity);
        delete copy.operators;
        delete copy.roster_version;
        return copy;
      };
      if (canonicalJsonDigest(unrelatedIdentity(beforeConfig.operator_identity))
        !== canonicalJsonDigest(unrelatedIdentity(nextIdentity))) {
        fail("POLICY_SCOPED_APPLY_UNRELATED_CHANGE", "Only the exact scoped signer may change in this review.");
      }
      const changed = new Set<string>();
      for (const subject of new Set([...Object.keys(priorOperators), ...Object.keys(nextIdentity.operators ?? {})])) {
        const prior = priorOperators[subject], next = nextIdentity.operators?.[subject];
        if (prior?.authority_kind === "scoped_apply" || next?.authority_kind === "scoped_apply") {
          if (prior && prior.authority_kind !== "scoped_apply") {
            fail("POLICY_SCOPED_APPLY_LEGACY_CONVERSION", "An existing legacy signer cannot be converted by this scoped enrollment.");
          }
          if (prior?.authority_kind === "scoped_apply" && next && next.authority_kind !== "scoped_apply") {
            fail("POLICY_SCOPED_APPLY_LEGACY_CONVERSION", "Revocation must keep the scoped variant or remove the signer.");
          }
          if (canonicalJsonDigest(prior ?? null) !== canonicalJsonDigest(next ?? null)) changed.add(subject);
          continue;
        }
        // Migration pins an unpinned legacy key to its reviewed current bytes;
        // it must not otherwise change the signer or its authority.
        const expected = prior ? { ...prior, authority_kind: "legacy",
          public_key_fingerprint: prior.public_key_fingerprint ?? next?.public_key_fingerprint } : null;
        if (canonicalJsonDigest(expected) !== canonicalJsonDigest(next ?? null)) {
          fail("POLICY_SCOPED_APPLY_UNRELATED_CHANGE", "The reviewed transition cannot alter approval or legacy control signers.");
        }
      }
      if (changed.size !== 1) fail("POLICY_SCOPED_APPLY_EXACT_CHANGE_REQUIRED", "Review exactly one scoped signer change at a time.");
      for (const subject of changed) {
        const signer = nextIdentity.operators?.[subject];
        for (const outcome of signer?.apply_outcomes ?? []) {
          try { resolveActivatedActionRule(active.registry, outcome); }
          catch { fail("POLICY_SCOPED_APPLY_OUTCOME_UNAVAILABLE", "Only exact currently published Action outcomes may be enrolled."); }
        }
      }
    }
    const before = beforeConfig.operator_identity ?? null;
    const epoch = execution.epoch!;
    const changedSigners = [...new Set([...Object.keys(priorOperators), ...Object.keys(nextIdentity.operators ?? {})])]
      .sort().filter((subject) => canonicalJsonDigest(priorOperators[subject] ?? null)
        !== canonicalJsonDigest(nextIdentity.operators?.[subject] ?? null))
      .map((subject) => ({ subject,
        before: priorOperators[subject] ? { authority_kind: priorOperators[subject].authority_kind ?? "legacy",
          outcomes: [...(priorOperators[subject].authority_kind === "scoped_apply"
            ? priorOperators[subject].apply_outcomes ?? [] : priorOperators[subject].outcomes ?? [])].sort(),
          public_key_fingerprint: priorOperators[subject].public_key_fingerprint ?? null } : null,
        after: nextIdentity.operators?.[subject] ? {
          authority_kind: nextIdentity.operators![subject]!.authority_kind ?? "legacy",
          outcomes: [...(nextIdentity.operators![subject]!.authority_kind === "scoped_apply"
            ? nextIdentity.operators![subject]!.apply_outcomes ?? []
            : nextIdentity.operators![subject]!.outcomes ?? [])].sort(),
          public_key_fingerprint: nextIdentity.operators![subject]!.public_key_fingerprint ?? null } : null }));
    const operation = { epoch, recovery, mode, project_root: projectRoot, before_binding: executionBindingDigest(beforeConfig),
      after_binding: executionBindingDigest(resolvedNext), before_identity: canonicalJsonDigest(before),
      after_identity: canonicalJsonDigest(resolvedNext.operator_identity), roster, changed_signers: changedSigners,
      role_scopes: roleScopes,
      affected_outcomes: [...new Set([...(execution.config.supervised_worker?.outcomes ?? []).map((item) => item.outcome),
        ...roleScopes.map((item) => item.outcome)])].sort(),
      execution_was_enabled: execution.config.supervised_worker?.enabled === true };
    const digest = canonicalJsonDigest(operation);
    const review = structuredClone({ ...operation, digest, execution_enabled_after: false });
    const sealed = canonicalJsonDigest(review), expires = Date.now() + 300_000;
    let used = false;
    return { review,
      async confirm(confirmationDigest: string): Promise<void> {
        if (used || Date.now() >= expires || confirmationDigest !== digest || canonicalJsonDigest(review) !== sealed) {
          fail("POLICY_APPROVER_CONFIRMATION_REQUIRED", "Review this exact identity revision again.");
        }
        used = true;
        await withProjectAuthorityMutation(projectRoot, async (permit) => {
          await ownedFile(projectRoot, true);
          if ((await readConfig(configPath)).text !== current.text) fail("POLICY_APPROVER_REVIEW_STALE", "The runtime file changed; review again.");
          const latest = await readOperatorExecutionConfig({ projectRoot, configPath, config: beforeConfig, policyStore: binding,
            allowUnavailablePinnedKeysForManagement: true });
          if (latest.epoch !== epoch || canonicalJsonDigest(await fingerprints(resolvedNext.operator_identity!, configPath, projectRoot)) !== canonicalJsonDigest(roster)) {
            fail("POLICY_APPROVER_REVIEW_STALE", "Policy or public verification material changed; review again.");
          }
          const revision = encodeOperatorExecutionPolicy(resolvedNext);
          const publicKeys = await Promise.all(roster.map(async (item) => {
            const operator = resolvedNext.operator_identity!.operators![item.subject]!;
            const keyFile = path.resolve(path.dirname(configPath), operator.public_key_path);
            const publicKeyPem = crypto.createPublicKey(await fs.readFile(keyFile)).export({ type: "spki", format: "pem" }).toString();
            if (operatorPublicKeyFingerprint(publicKeyPem) !== item.public_key_fingerprint) {
              fail("POLICY_APPROVER_KEY_CHANGED", "Public verification material changed while saving its trust revision.");
            }
            return { ...item, public_key_pem: publicKeyPem };
          }));
          const identityContent = { schema_version: OPERATOR_POLICY_RECORD_VERSION, type: "approver_identity",
            identity_digest: canonicalJsonDigest(resolvedNext.operator_identity), public_keys: publicKeys };
          const identityRevision = storedOperatorPolicyRecord(OPERATOR_APPROVER_IDENTITY_KEY,
            canonicalJsonDigest(identityContent), identityContent);
          await publishPolicyConfiguration({ projectRoot, configPath, binding, mutationPermit: permit,
            before: current.text, after: `${JSON.stringify(candidate, null, 2)}\n`, change: {
              expected_epoch: epoch, revisions: [identityRevision, ...(revision ? [revision] : [])],
              active: [{ ...OPERATOR_APPROVER_IDENTITY_KEY, revision_id: identityRevision.revision_id },
                ...(revision ? [{ ...OPERATOR_EXECUTION_POLICY_KEY, revision_id: revision.revision_id }] : [])], drafts: [],
              event: { event_id: randomUUID(), actor: `local-deployment-operator:${os.userInfo().username}`,
                occurred_at: new Date().toISOString(), receipt: { operation: mode === "approver" ? "review_approver_identity" : "review_scoped_apply_identity",
                  confirmation_digest: digest, before_binding: operation.before_binding, after_binding: operation.after_binding,
                  changed_signers: changedSigners, affected_outcomes: operation.affected_outcomes,
                  execution_enabled_after: false, source_database_changed: false } },
            } });
        });
      },
      close: () => binding.close(),
    };
  } catch (error) { await binding.close(); throw error; }
}
