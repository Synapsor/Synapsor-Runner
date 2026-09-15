import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { PolicyPassage, PolicyTextSnapshot } from "./authoring-policy-source.js";

const root = /^\/runner_evidence\/actions\/[^/]+\/effect(?:\/atomic_updates\/\d+)?\/source_counter_maintenance$/u;
const context = "/runner_evidence/runtime_contract/source_counter_maintenance";
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
function valueAt(draft: unknown, pointer: string): unknown {
  return pointer.slice(1).split("/").reduce<unknown>((value, part) => object(value)?.[part.replace(/~1/gu, "/").replace(/~0/gu, "~")]
    ?? (Array.isArray(value) && /^\d+$/u.test(part) ? value[Number(part)] : undefined), draft);
}

export function sourceCounterMaintenanceReferences(draft: unknown): string[] {
  const actions = object(valueAt(draft, "/runner_evidence/actions")), paths: string[] = [];
  for (const [outcome, action] of Object.entries(actions ?? {})) {
    const effect = object(object(action)?.effect);
    if (!effect) continue;
    const prefix = `/runner_evidence/actions/${outcome.replace(/~/gu, "~0").replace(/\//gu, "~1")}/effect`;
    if (Object.hasOwn(effect, "source_counter_maintenance")) paths.push(`${prefix}/source_counter_maintenance`);
    if (Array.isArray(effect.atomic_updates)) effect.atomic_updates.forEach((entry, index) => {
      if (object(entry) && Object.hasOwn(entry, "source_counter_maintenance")) paths.push(`${prefix}/atomic_updates/${index}/source_counter_maintenance`);
    });
  }
  return paths;
}

export const SOURCE_COUNTER_CLASSIFICATION_GUIDANCE = "Classify the source requirement, not the presence of false external-verification flags. Separate maintained-counter responsibility from effect, privacy and other claims. A narrow needs_decision/deployment/missing_configuration passage uses source_counter_obligation={path:<exact effect or companion source_counter_maintenance entry>,requirement:owner_maintenance|independent_assurance}, with draft_paths containing only that path. owner_maintenance means the source accepts the currently attested all-writers maintenance operating contract; independent_assurance means the source actually requires a further independent guarantee. The former can permit BUSINESS review only with current exact host confirmation, while external assurance remains unverified. The latter remains blocked. Never infer confirmation from a column, compiled increment, policy text or model assertion. Keep every effect/version-update/condition/privacy claim in its own checked passage. Do not change rules or ask the owner to repeat a current confirmation merely to classify this report.";

/** This component has no fields capable of discharging an effect or other claim.
 * The semantic requirement remains explicit; the host proves only applicability
 * of an existing owner record and never external-writer compliance. */
export function resolveSourceCounterObligation(passage: PolicyPassage, source: PolicyTextSnapshot, draft: unknown) {
  const obligation = passage.source_counter_obligation;
  if (!obligation) {
    if (passage.disposition === "needs_decision" && passage.responsibility === "deployment"
      && passage.issue_kind === "missing_configuration" && passage.draft_paths.some(path => path === context || root.test(path))) {
      throw new Error(`SOURCE_COUNTER_CLASSIFICATION_REQUIRED: Source lines ${passage.start}-${passage.end}. ${SOURCE_COUNTER_CLASSIFICATION_GUIDANCE}`);
    }
    return undefined;
  }
  if (!object(obligation) || Object.keys(obligation).some(key => !["path", "requirement"].includes(key))
    || typeof obligation.path !== "string" || !root.test(obligation.path)
    || !["owner_maintenance", "independent_assurance"].includes(obligation.requirement)) {
    throw new Error("SOURCE_COUNTER_OBLIGATION_INVALID: Use one exact effect/companion maintenance entry and a supported source requirement; the context overview is not proof.");
  }
  if (passage.disposition !== "needs_decision" || passage.responsibility !== "deployment" || passage.issue_kind !== "missing_configuration"
    || passage.draft_paths.length !== 1 || passage.draft_paths[0] !== obligation.path
    || passage.field_checks?.length || passage.evidence_checks?.length || passage.counter_requirements?.length
    || passage.application_obligations?.length || passage.deployment_prerequisite || passage.operator_override
    || passage.counting_components?.length || passage.counting_resolution) {
    throw new Error(`SOURCE_COUNTER_COMPONENT_MIXED: ${SOURCE_COUNTER_CLASSIFICATION_GUIDANCE}`);
  }
  const evidence = object(valueAt(draft, obligation.path));
  // Missing confirmation cannot become proof through saved coverage. An actual
  // independent guarantee is deliberately outside this attestation mechanism.
  if (obligation.requirement === "independent_assurance") return undefined;
  if (evidence?.status !== "owner_confirmed_operating_prerequisite" || evidence.maintenance !== "all_writers_increment"
    || typeof evidence.resource !== "string" || typeof evidence.field !== "string"
    || evidence.external_writers_verified !== false || evidence.production_integration_verified !== false
    || [evidence.proof_digest, evidence.read_boundary_digest, evidence.generation_lock_fingerprint, evidence.role_posture_fingerprint]
      .some(value => typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value))) {
    throw new Error("SOURCE_COUNTER_ATTESTATION_REQUIRED: This effect has no exact current source-owner maintenance confirmation. Use the existing reviewed-counter operation and revalidate its current source, metadata and target; external assurance remains unverified.");
  }
  return { source_digest: source.digest, path: obligation.path,
    dependencies_digest: canonicalJsonDigest({ source: source.digest, range: [passage.start, passage.end], obligation, evidence }),
    proof_digest: evidence.proof_digest as string, external_assurance: "unverified" as const };
}
