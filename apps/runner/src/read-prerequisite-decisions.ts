import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { listSupportedReadCurrentStatePrerequisiteCandidates, type ReadPrerequisiteBoundaryContext,
  type SupportedReadCurrentStatePrerequisiteCandidate } from "./read-prerequisite.js";
import { redactCliErrorMessage } from "./cli-logging.js";

type Digest = `sha256:${string}`;
const VERSION = "synapsor.read-prerequisite-business-decision.v1";
const KINDS = ["source_authority", "positive_state", "effective_interval"] as const;

/** Host-owned references to the selected job and relevant operator requirement, never model rationale.
 * Keep requirement_revision unchanged for unrelated edits; change it for an explicit meaning revision.
 * These references are lookup context, not metadata consent, scope proof or authority. */
export type ReadPrerequisiteDecisionContext = {
  boundary_name: string;
  source: string;
  workflow: string;
  purpose_key: string;
  requirement_revision: Digest;
};

/** Durable operator answer, carried separately from transient model history and current proof. */
export type ReadPrerequisiteBusinessDecision = {
  decision_id: Digest;
  applicability_digest: Digest;
  question: string;
  answer: string;
};

export type ReadPrerequisiteDecision = Omit<ReadPrerequisiteBusinessDecision, "answer"> & {
  kind: typeof KINDS[number];
};

function invalid(message: string): never { throw new Error(`READ_PREREQUISITE_DECISION_INVALID: ${message}`); }
function digest(value: unknown): asserts value is Digest {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid("Expected an exact decision fingerprint.");
}
function text(value: unknown, max: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > max
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value) || redactCliErrorMessage(value) !== value) {
    invalid("Expected bounded business text without credentials or terminal controls.");
  }
}

export function parseReadPrerequisiteBusinessDecisions(value: unknown): ReadPrerequisiteBusinessDecision[] {
  if (!Array.isArray(value) || value.length > 16 || Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) {
    invalid("Business decisions are bounded to 16 records and 64 KiB; nothing is truncated.");
  }
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(item))
      || Object.keys(item).some(key => !["decision_id", "applicability_digest", "question", "answer"].includes(key))) {
      invalid("Expected an exact host business-decision record.");
    }
    digest(item.decision_id); digest(item.applicability_digest);
    text(item.question, 4000); text(item.answer, 8000);
    if (seen.has(item.decision_id)) invalid("Conflicting or duplicate decision identities require explicit replacement, not history union.");
    seen.add(item.decision_id);
    return { decision_id: item.decision_id, applicability_digest: item.applicability_digest, question: item.question, answer: item.answer };
  });
}

/** Rebuild from current, host-approved candidates. No older fingerprint supplies inspection proof. */
export function buildReadPrerequisiteDecisions(input: {
  context: ReadPrerequisiteDecisionContext;
  boundary: ReadPrerequisiteBoundaryContext;
  inspection: SchemaInspection;
  candidates: readonly SupportedReadCurrentStatePrerequisiteCandidate[];
}): ReadPrerequisiteDecision[] {
  const { context, boundary, inspection } = input;
  for (const key of ["boundary_name", "source", "workflow", "purpose_key"] as const) text(context[key], 256);
  digest(context.requirement_revision);
  if (!boundary.source || boundary.source !== context.source) invalid("The decision source must be the selected Read source.");
  if ("name" in boundary.pack && boundary.pack.name !== context.boundary_name) invalid("The decision Boundary must be the selected Read Boundary.");
  const decisions = new Map<Digest, ReadPrerequisiteDecision>();
  for (const candidate of input.candidates) {
    const fresh = listSupportedReadCurrentStatePrerequisiteCandidates(inspection, boundary, candidate);
    // The approved catalog can have terminal-sanitized descriptions; its structural tuple must still be exact.
    const tuple = ({ catalog_descriptions: _descriptions, ...structural }: SupportedReadCurrentStatePrerequisiteCandidate) => structural;
    if (!fresh.some(current => canonicalJsonDigest(tuple(current)) === canonicalJsonDigest(tuple(candidate)))) {
      invalid("The decision candidate needs current exact identity and metadata proof.");
    }
    const table = inspection.tables.find(table => table.schema === candidate.source.schema && table.name === candidate.source.table)!;
    // Only this source or its exact organization/person parent contributes
    // lookup settings. Existing validators still own all runtime RLS proof.
    const directResources = boundary.pack.resources.filter(resource => resource.schema === candidate.source.schema && resource.table === candidate.source.table);
    const scopeResources = directResources.length ? directResources : boundary.pack.resources.filter(resource =>
      table.foreign_keys.some(key => key.referenced_schema === resource.schema && key.referenced_table === resource.table
        && key.columns.some((field, i) => field === candidate.subject.tenant_column && key.referenced_columns[i] === resource.tenant_key)
        && key.columns.some((field, i) => field === candidate.subject.principal_column && key.referenced_columns[i] === resource.principal_key)));
    const settings = [...new Set(scopeResources.filter(resource => resource.rls_session)
      .map(resource => canonicalJsonDigest(resource.rls_session!)))].sort();
    for (const kind of KINDS) {
      const current = candidate.current_state;
      const fields = kind === "source_authority" ? [] : kind === "positive_state"
        ? [current.state_column] : [current.effective_from_column, current.effective_until_column];
      const identity = { version: VERSION, boundary_name: context.boundary_name, source: context.source,
        engine: inspection.engine, workflow: context.workflow, purpose_key: context.purpose_key,
        object: candidate.source, subject: candidate.subject, trusted_context: boundary.trusted_context,
        settings, kind, fields };
      const source = `${candidate.source.schema}.${candidate.source.table}`;
      const scope = `For this job's selected Read condition, with organization field ${candidate.subject.tenant_column} and person field ${candidate.subject.principal_column}`;
      const question = kind === "source_authority"
        ? `${scope}, is ${source} authoritative for the required current-state condition? State its ownership and business meaning.`
        : kind === "positive_state"
          ? `${scope}, which inspected value of ${source}.${current.state_column} establishes the required positive state? Explain its meaning.`
          : `${scope}, do ${source}.${current.effective_from_column} and ${source}.${current.effective_until_column} mean inclusive start and exclusive expiry in database UTC? Explain their business meaning.`;
      const relevantNames = [...new Set([candidate.subject.tenant_column, candidate.subject.principal_column, ...fields])];
      const applicability = { requirement_revision: context.requirement_revision,
        fields: relevantNames.map(name => {
          const column = table.columns.find(column => column.name === name)!;
          return { name, data_type: column.data_type, nullable: column.nullable,
            enum_values: [...(column.enum_values ?? [])].sort(), comment: column.comment ?? null };
        }), source_description: candidate.catalog_descriptions.source ?? null,
        ...(kind === "positive_state" ? { state_description: candidate.catalog_descriptions.state ?? null } : {}),
        ...(kind === "effective_interval" ? { interval: current.interval, clock: current.clock,
          from_description: candidate.catalog_descriptions.effective_from ?? null,
          until_description: candidate.catalog_descriptions.effective_until ?? null } : {}),
      };
      const decision_id = canonicalJsonDigest(identity);
      const decision = { decision_id, applicability_digest: canonicalJsonDigest(applicability), kind, question };
      const previous = decisions.get(decision_id);
      if (previous && previous.applicability_digest !== decision.applicability_digest) invalid("The current decision has conflicting inspected applicability.");
      decisions.set(decision_id, decision);
    }
  }
  return [...decisions.values()];
}

/** A match reuses business context only. Fresh proof and explicit exact semantic review remain mandatory. */
export function applicableReadPrerequisiteBusinessDecision(
  decision: ReadPrerequisiteDecision, records: readonly ReadPrerequisiteBusinessDecision[],
): ReadPrerequisiteBusinessDecision | undefined {
  return parseReadPrerequisiteBusinessDecisions(records).find(record => record.decision_id === decision.decision_id
    && record.applicability_digest === decision.applicability_digest);
}
