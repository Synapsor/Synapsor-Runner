import { canonicalJsonDigest } from "@synapsor-runner/protocol";

export type ActionRuleAuthoringCheckpoint = {
  schema_version: "synapsor.action-authoring-checkpoint.v1";
  intent_digest: `sha256:${string}`;
  context_digest: `sha256:${string}`;
  components: Partial<Record<"verification" | "effect" | "rule" | "approval", Record<string, unknown>>>;
  operator_messages?: string[];
  digest: `sha256:${string}`;
};

export function actionRuleAuthoringCheckpoint(
  input: Omit<ActionRuleAuthoringCheckpoint, "schema_version" | "digest">,
): ActionRuleAuthoringCheckpoint {
  const core = { schema_version: "synapsor.action-authoring-checkpoint.v1" as const, ...structuredClone(input) };
  return parseActionRuleAuthoringCheckpoint({ ...core, digest: canonicalJsonDigest(core) });
}

export function parseActionRuleAuthoringCheckpoint(value: unknown): ActionRuleAuthoringCheckpoint {
  const fail = () => new Error("ACTION_AUTHORING_CHECKPOINT_INVALID: saved draft components are invalid or changed. Active authority is unchanged.");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail();
  const record = value as Record<string, unknown>;
  if (record.schema_version !== "synapsor.action-authoring-checkpoint.v1"
    || Object.keys(record).some((key) => !["schema_version", "intent_digest", "context_digest", "components", "operator_messages", "digest"].includes(key))
    || ![record.intent_digest, record.context_digest, record.digest].every((digest) => typeof digest === "string" && /^sha256:[a-f0-9]{64}$/u.test(digest))
    || !record.components || typeof record.components !== "object" || Array.isArray(record.components)) throw fail();
  if (record.operator_messages !== undefined && (!Array.isArray(record.operator_messages)
    || record.operator_messages.length > 16
    || record.operator_messages.some((message) => typeof message !== "string" || !message.trim() || message.length > 4_000))) throw fail();
  for (const [phase, component] of Object.entries(record.components)) {
    if (!["verification", "effect", "rule", "approval"].includes(phase)
      || !component || typeof component !== "object" || Array.isArray(component)) throw fail();
  }
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > 96 * 1024) throw fail();
  const { digest, ...core } = record;
  if (canonicalJsonDigest(core) !== digest) throw fail();
  return structuredClone(record) as ActionRuleAuthoringCheckpoint;
}
