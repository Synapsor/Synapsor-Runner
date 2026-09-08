import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { assertValidRunnerCapabilityConfig } from "@synapsor-runner/config";
import { resolveRuntimeConfig, policyManagementParentSchema, type RuntimeConfig } from "@synapsor-runner/mcp-server";
import { readOperatorExecutionConfig, encodeOperatorExecutionPolicy, executionBindingDigest } from "./control-policy-execution.js";
import { openProjectControlPolicies } from "./control-policy-store.js";
import { OPERATOR_EXECUTION_POLICY_KEY } from "./control-policy-record.js";
import { publishPolicyConfiguration, recoverPolicyConfiguration } from "./control-policy-config-publication.js";
import { withProjectAuthorityMutation } from "./project-authority-mutation.js";

type OwnerConnections = Pick<NonNullable<RuntimeConfig["action_rules"]>, "owner_management" | "owner_delegation">;
type Input = { projectRoot: string; configPath: string; connections?: unknown; previousConfigPath?: string;
  storePath?: string; env?: NodeJS.ProcessEnv; actor: string };
export type OwnerConnectionReview = {
  digest: string; epoch: number; recovery: boolean; execution_enabled: boolean;
  before: OwnerConnections; after: OwnerConnections; execution: NonNullable<RuntimeConfig["supervised_worker"]> | null;
};

function withoutOwnerConnections(config: RuntimeConfig): RuntimeConfig {
  const result = structuredClone(config);
  if (result.action_rules) {
    delete result.action_rules.owner_management;
    delete result.action_rules.owner_delegation;
  }
  return result;
}

function connections(config: RuntimeConfig): OwnerConnections {
  return JSON.parse(JSON.stringify({ owner_management: config.action_rules?.owner_management,
    owner_delegation: config.action_rules?.owner_delegation })) as OwnerConnections;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(`${code}: ${message} No configuration or authority was changed.`), { code });
}

async function readConfig(file: string): Promise<{ text: string; raw: RuntimeConfig }> {
  const stat = await fs.stat(file);
  if (stat.size > 1_048_576) fail("POLICY_CONNECTION_CONFIG_TOO_LARGE", "Inspect the configuration locally before review.");
  const text = await fs.readFile(file, "utf8");
  if (Buffer.byteLength(text) > 1_048_576) fail("POLICY_CONNECTION_CONFIG_TOO_LARGE", "The configuration changed beyond the review limit.");
  return { text, raw: JSON.parse(text) as RuntimeConfig };
}

/** Trusted local operator only. The prior execution binding must be proven,
 * never reconstructed from an unchecked export or a model's explanation. */
export async function prepareOwnerConnectionReview(input: Input) {
  const actor = input.actor;
  const configPath = path.resolve(input.configPath), projectRoot = await fs.realpath(input.projectRoot);
  const relative = path.relative(projectRoot, await fs.realpath(configPath));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("POLICY_CONNECTION_PROJECT_MISMATCH", "Select this project's runtime configuration.");
  }
  await recoverPolicyConfiguration({ projectRoot, configPath, env: input.env });
  const current = await readConfig(configPath);
  const resolve = (raw: RuntimeConfig) => resolveRuntimeConfig(raw, path.dirname(configPath));
  const selected = resolve(current.raw);
  assertValidRunnerCapabilityConfig(selected);
  if (!selected.action_rules || await fs.realpath(selected.action_rules.project_root) !== projectRoot) {
    fail("POLICY_CONNECTION_PROJECT_MISMATCH", "Owner sign-ins require this project's reviewed Action configuration.");
  }
  const binding = await openProjectControlPolicies({ projectRoot, config: selected, env: input.env,
    storePath: input.storePath ?? path.resolve(path.dirname(configPath), selected.storage?.sqlite_path ?? ".synapsor/local.db") });
  if (!binding) fail("POLICY_CONNECTION_STORAGE_REQUIRED", "First review policy storage for this project.");
  try {
    let beforeConfig = selected, recovery = false;
    let execution;
    try { execution = await readOperatorExecutionConfig({ projectRoot, config: beforeConfig, policyStore: binding }); }
    catch (error) {
      if ((error as { code?: string }).code !== "POLICY_EXECUTION_BINDING_CHANGED") throw error;
      recovery = true;
      // Initial documented setup is recoverable without an old file only when
      // removing the added owner blocks exactly restores the stored digest.
      beforeConfig = input.previousConfigPath ? resolve((await readConfig(input.previousConfigPath)).raw)
        : withoutOwnerConnections(selected);
      if (executionBindingDigest(withoutOwnerConnections(beforeConfig)) !== executionBindingDigest(withoutOwnerConnections(selected))) {
        fail("POLICY_CONNECTION_UNRELATED_CHANGE", "Source, scope, storage or other runtime settings also changed. Restore/review those separately.");
      }
      try { execution = await readOperatorExecutionConfig({ projectRoot, config: beforeConfig, policyStore: binding }); }
      catch (cause) {
        if ((cause as { code?: string }).code !== "POLICY_EXECUTION_BINDING_CHANGED") throw cause;
        fail("POLICY_CONNECTION_PREVIOUS_BINDING_REQUIRED", "The prior sign-in binding cannot be proven. Supply --previous-config with the exact previously reviewed configuration; do not edit policy-store hashes.");
      }
    }
    const next = structuredClone(current.raw);
    if (input.connections !== undefined) {
      const value = input.connections;
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).some((key) => !["owner_management", "owner_delegation"].includes(key))) {
        fail("POLICY_CONNECTION_INPUT_INVALID", "The connection document may contain only owner_management and owner_delegation settings.");
      }
      for (const key of ["owner_management", "owner_delegation"] as const) {
        if (Object.hasOwn(value, key)) {
          const candidate = (value as OwnerConnections)[key];
          if (candidate === null) delete next.action_rules![key];
          else Object.assign(next.action_rules!, { [key]: structuredClone(candidate) });
        }
      }
    }
    delete next.supervised_worker;
    if (execution.config.supervised_worker) next.supervised_worker = structuredClone(execution.config.supervised_worker);
    const resolvedNext = resolve(next);
    assertValidRunnerCapabilityConfig(resolvedNext);
    if (!resolvedNext.action_rules?.owner_management && !resolvedNext.action_rules?.owner_delegation) {
      fail("POLICY_CONNECTION_INPUT_REQUIRED", "Supply --input with the backend's owner sign-in configuration, or review the owner settings already in the runtime file.");
    }
    const epoch = execution.epoch!;
    for (const name of new Set(Object.values(connections(resolvedNext)).map((entry) => entry!.parent_name))) {
      const parent = await binding.repository.exactPointerSnapshot({ deployment_id: binding.deployment_id,
        key: { scope: { level: "operator" }, kind: "parent", name }, max_bytes: 1_048_576 });
      if (parent.epoch !== epoch) fail("POLICY_CONNECTION_REVIEW_STALE", "Policy changed; reopen connection review.");
      if (!parent.active) fail("POLICY_CONNECTION_PARENT_REQUIRED", `Review the ${name} parent delegation before connecting its sign-ins.`);
      policyManagementParentSchema.parse(parent.active.content);
    }
    const before = connections(beforeConfig), after = connections(resolvedNext);
    const body = { epoch, recovery, before, after, execution: next.supervised_worker ?? null,
      before_binding: executionBindingDigest(beforeConfig), after_binding: executionBindingDigest(resolvedNext) };
    const digest = canonicalJsonDigest(body);
    const executionEnabled = next.supervised_worker?.enabled === true;
    // UI callers own their review copy, never a reference to the private
    // candidate that will be published after waiting for the mutation lock.
    const review: OwnerConnectionReview = structuredClone({ digest, epoch, recovery, before, after,
      execution: next.supervised_worker ?? null, execution_enabled: executionEnabled });
    const sealed = canonicalJsonDigest(review);
    const expires = Date.now() + 300_000;
    let used = false;
    return {
      review,
      async confirm(confirmation: { connectionDigest: string; executionDigest?: string }): Promise<void> {
        if (used || expires <= Date.now() || canonicalJsonDigest(review) !== sealed || confirmation.connectionDigest !== digest
          || (executionEnabled && confirmation.executionDigest !== digest)) {
          fail("POLICY_CONNECTION_CONFIRMATION_REQUIRED", "Review the exact sign-ins and independently confirm existing execution under those bindings.");
        }
        used = true;
        await withProjectAuthorityMutation(projectRoot, async (permit) => {
          if ((await readConfig(configPath)).text !== current.text) fail("POLICY_CONNECTION_REVIEW_STALE", "The runtime file changed; review again.");
          const currentExecution = await readOperatorExecutionConfig({ projectRoot, config: beforeConfig, policyStore: binding });
          if (currentExecution.epoch !== epoch) fail("POLICY_CONNECTION_REVIEW_STALE", "Policy changed; reopen connection review before saving its sign-ins.");
          const revision = encodeOperatorExecutionPolicy(resolvedNext);
          // The store CAS covers parent, owner, Read/Action and execution edits.
          // Source bindings, business rules and writer grants are unchanged.
          await publishPolicyConfiguration({ projectRoot, configPath, binding, mutationPermit: permit,
            before: current.text, after: `${JSON.stringify(next, null, 2)}\n`, change: {
              expected_epoch: epoch, revisions: revision ? [revision] : [],
              active: revision ? [{ ...OPERATOR_EXECUTION_POLICY_KEY, revision_id: revision.revision_id }] : [], drafts: [],
              event: { event_id: randomUUID(), actor, occurred_at: new Date().toISOString(), receipt: {
                operation: "review_owner_connection", confirmation_digest: digest,
                execution_confirmation_digest: executionEnabled ? digest : null,
                before_binding: body.before_binding, after_binding: body.after_binding,
                source_database_changed: false,
              } },
            } });
        });
      },
      close: () => binding.close(),
    };
  } catch (error) { await binding.close(); throw error; }
}
