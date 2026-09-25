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
import { operatorPublicKeyFingerprint } from "./operator-identity.js";

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
  const result: Array<{ subject: string; roles: string[]; outcomes: string[]; public_key_fingerprint: string }> = [];
  for (const [subject, operator] of Object.entries(identity.operators).sort(([a], [b]) => a.localeCompare(b))) {
    const file = path.resolve(path.dirname(configPath), operator.public_key_path);
    if (!within(projectRoot, file)) fail("POLICY_APPROVER_KEY_OUTSIDE_PROJECT", "Select project-owned public verification material.");
    await ownedFile(file);
    const fingerprint = operatorPublicKeyFingerprint(await fs.readFile(file));
    if (operator.public_key_fingerprint && operator.public_key_fingerprint !== fingerprint) {
      fail("POLICY_APPROVER_KEY_CHANGED", "The proposed fingerprint does not match its public verification material.");
    }
    result.push({ subject, roles: [...operator.roles].sort(), outcomes: [...(operator.outcomes ?? [])].sort(),
      public_key_fingerprint: fingerprint });
  }
  return result;
}

/** Trusted local deployment-operator setup. This management path can repair a
 * disabled/stale execution binding but cannot authorize source execution. */
export async function prepareApproverPolicyConfiguration(input: Input) {
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
    const active = await createActiveActionRuleAuthorityLoader(projectRoot, binding)({ dependency_check: "report" });
    const roleScopes = active.registry.approval_classes.flatMap((approval) => approval.rules.map((rule) => ({
      outcome: rule.outcome, required_role: approval.required_role,
    }))).sort((a, b) => a.outcome.localeCompare(b.outcome));
    for (const item of roster) {
      if (!item.outcomes.length || item.roles.some((role) => !item.outcomes.some((outcome) =>
        roleScopes.some((scope) => scope.outcome === outcome && scope.required_role === role)))
        || item.outcomes.some((outcome) => !item.roles.some((role) =>
          roleScopes.some((scope) => scope.outcome === outcome && scope.required_role === role)))) {
        fail("POLICY_APPROVER_ROLE_OUT_OF_SCOPE", "Each reviewed role and outcome must form an exact active Action approval mandate.");
      }
    }
    const before = beforeConfig.operator_identity ?? null;
    const epoch = execution.epoch!;
    const operation = { epoch, recovery, before_binding: executionBindingDigest(beforeConfig),
      after_binding: executionBindingDigest(resolvedNext), before_identity: canonicalJsonDigest(before),
      after_identity: canonicalJsonDigest(resolvedNext.operator_identity), roster,
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
                occurred_at: new Date().toISOString(), receipt: { operation: "review_approver_identity",
                  confirmation_digest: digest, before_binding: operation.before_binding, after_binding: operation.after_binding,
                  affected_outcomes: operation.affected_outcomes, execution_enabled_after: false, source_database_changed: false } },
            } });
        });
      },
      close: () => binding.close(),
    };
  } catch (error) { await binding.close(); throw error; }
}
