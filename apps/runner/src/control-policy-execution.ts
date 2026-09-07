import { z } from "zod";
import path from "node:path";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { assertValidRunnerCapabilityConfig } from "@synapsor-runner/config";
import type { RuntimeConfig, RuntimeSupervisedWorkerConfig } from "@synapsor-runner/mcp-server";
import type { ControlPolicyRevision } from "@synapsor-runner/proposal-store";
import { OPERATOR_POLICY_RECORD_VERSION, OPERATOR_EXECUTION_POLICY_KEY,
  assertOperatorPolicyRecord, storedOperatorPolicyRecord } from "./control-policy-record.js";
import { openProjectControlPolicies, type BoundProjectPolicyStore } from "./control-policy-store.js";

export const operatorExecutionDocument = z.object({ schema_version: z.literal(OPERATOR_POLICY_RECORD_VERSION),
  type: z.literal("execution"), runtime_binding_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  policy: z.record(z.unknown()) }).strict();
export type StoredOperatorExecutionPolicy = {
  type: "execution"; runtime_binding_digest: string; policy: RuntimeSupervisedWorkerConfig;
};

/** Callers resolve config-relative paths before hashing. No credential values
 * are copied into the record, and an edited worker export is not authority. */
export function executionBindingDigest(config: RuntimeConfig): string {
  const { supervised_worker: _export, ...bindings } = config;
  return canonicalJsonDigest(omitAbsentConfigProperties(bindings));
}

// Contract expansion materializes absent optional object properties. Omit only
// those; canonical JSON still rejects invalid scalars, array entries and cycles.
function omitAbsentConfigProperties(value: unknown, copies = new Map<object, unknown>()): unknown {
  if (value === null || typeof value !== "object") return value;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  if (copies.has(value)) return copies.get(value);
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    copies.set(value, output);
    for (const item of value) output.push(omitAbsentConfigProperties(item, copies));
    return output;
  }
  const output: Record<string, unknown> = Object.create(null);
  copies.set(value, output);
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) output[key] = omitAbsentConfigProperties(item, copies);
  }
  return output;
}

export function parseOperatorExecutionPolicy(value: unknown, config?: RuntimeConfig): StoredOperatorExecutionPolicy {
  const parsed = operatorExecutionDocument.parse(value);
  if (!config) fail("POLICY_EXECUTION_CONTEXT_REQUIRED");
  if (executionBindingDigest(config) !== parsed.runtime_binding_digest) fail("POLICY_EXECUTION_BINDING_CHANGED");
  assertValidRunnerCapabilityConfig({ ...config, strict: true, supervised_worker: parsed.policy });
  return { type: "execution", runtime_binding_digest: parsed.runtime_binding_digest,
    policy: structuredClone(parsed.policy) as unknown as RuntimeSupervisedWorkerConfig };
}

export function encodeOperatorExecutionPolicy(config: RuntimeConfig): ControlPolicyRevision | undefined {
  if (config.supervised_worker === undefined) return undefined;
  const content = { schema_version: OPERATOR_POLICY_RECORD_VERSION, type: "execution",
    runtime_binding_digest: executionBindingDigest(config), policy: config.supervised_worker };
  const policy = parseOperatorExecutionPolicy(content, config);
  return storedOperatorPolicyRecord(OPERATOR_EXECUTION_POLICY_KEY, canonicalJsonDigest(policy), content);
}

/** No cache or file fallback after migration. Borrowed bindings must be verified
 * by runtime composition; operator/config readers may open the governed store. */
export async function readOperatorExecutionConfig(input: {
  projectRoot: string; config: RuntimeConfig; policyStore?: BoundProjectPolicyStore; env?: NodeJS.ProcessEnv; storePath?: string;
}): Promise<{ config: RuntimeConfig; epoch?: number }> {
  const binding = input.policyStore ?? await openProjectControlPolicies({ ...input,
    storePath: input.storePath ?? path.resolve(input.projectRoot, input.config.storage?.sqlite_path ?? ".synapsor/local.db") });
  if (!binding) return { config: input.config };
  try {
    const snapshot = await binding.repository.scopeSnapshot({ deployment_id: binding.deployment_id,
      scope: { level: "operator" }, kinds: ["execution"] });
    if (snapshot.active.length > 1) fail("POLICY_EXECUTION_IDENTITY_MISMATCH");
    const config = structuredClone(input.config);
    delete config.supervised_worker;
    const revision = snapshot.active[0];
    if (revision) {
      const policy = parseOperatorExecutionPolicy(revision.content, config);
      assertOperatorPolicyRecord(revision, OPERATOR_EXECUTION_POLICY_KEY, canonicalJsonDigest(policy));
      config.supervised_worker = policy.policy;
    }
    return { config, epoch: snapshot.epoch };
  } finally {
    if (!input.policyStore) await binding.close();
  }
}

function fail(code: string): never {
  throw Object.assign(new Error(`${code}: reviewed execution policy is unavailable; no execution is authorized.`), { code });
}
