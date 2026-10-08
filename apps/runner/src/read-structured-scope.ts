import { z } from "zod";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ReadAuthorityAtom, ReadWorkloadAnalysis } from "./read-workload-assist.js";

export const READ_SCOPE_PROTOCOL = "synapsor.read-scope.v1" as const;
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const name = z.string().min(1).max(256);
const prose = z.string().min(1).max(4000).refine(value => !!value.trim(), "Blank text is not a value.");
const operations = ["resource", "return", "filter", "sort", "group", "aggregate", "count_distinct",
  "presence_measure", "time_bucket", "time_window", "relationship", "derived_measure", "numeric_band", "auto_band"] as const;

/** Names identify catalog objects here; they never prove their business meaning. */
const targetSchema = z.object({ root_resource: name, resource: name, operation: z.enum(operations),
  field: name.optional(), relationship: name.optional(), qualifier: name.optional() }).strict();
const requirementSchema = z.object({ id: name, intended_use: prose, references: z.array(name).min(1).max(64),
  disposition: z.enum(["include", "exclude", "unresolved"]), targets: z.array(targetSchema).max(256),
  unresolved: prose.optional() }).strict();
export const readScopeProposalCodec = z.object({ protocol: z.literal(READ_SCOPE_PROTOCOL),
  original_request: name, applicability: z.enum(["read_requested", "no_read_requested"]),
  requirements: z.array(requirementSchema).max(128) }).strict().superRefine((value, ctx) => {
    if ((value.applicability === "read_requested") !== (value.requirements.length > 0))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Only an explicit no-Read proposal has no requirements." });
  });
export type ReadScopeProposal = z.infer<typeof readScopeProposalCodec>;
export type ReadScopeTarget = z.infer<typeof targetSchema>;

// Provider projection of the canonical codec, checked by the conformance test.
const stringSchema = { type: "string", minLength: 1, maxLength: 256 };
const proseSchema = { type: "string", minLength: 1, maxLength: 4000, pattern: "\\S" };
export const readScopeProposalSchema = {
  type: "object", additionalProperties: false, required: ["protocol", "original_request", "applicability", "requirements"],
  oneOf: [
    { properties: { applicability: { const: "read_requested" }, requirements: { minItems: 1 } } },
    { properties: { applicability: { const: "no_read_requested" }, requirements: { maxItems: 0 } } },
  ],
  properties: { protocol: { const: READ_SCOPE_PROTOCOL }, original_request: stringSchema,
    applicability: { enum: ["read_requested", "no_read_requested"] },
    requirements: { type: "array", maxItems: 128, items: {
      type: "object", additionalProperties: false,
      required: ["id", "intended_use", "references", "disposition", "targets"],
      properties: { id: stringSchema, intended_use: proseSchema,
        references: { type: "array", minItems: 1, maxItems: 64, items: stringSchema },
        disposition: { enum: ["include", "exclude", "unresolved"] }, unresolved: proseSchema,
        targets: { type: "array", maxItems: 256, items: { type: "object", additionalProperties: false,
          required: ["root_resource", "resource", "operation"], properties: {
            root_resource: stringSchema, resource: stringSchema, operation: { enum: [...operations] },
            field: stringSchema, relationship: stringSchema, qualifier: stringSchema,
          } } },
      },
    } },
  },
} as const;

const referenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request"), id: name, digest, text: prose }).strict(),
  z.object({ kind: z.literal("source"), id: name, digest, source_id: name,
    start_line: z.number().int().positive(), end_line: z.number().int().positive(), text: prose }).strict(),
  z.object({ kind: z.literal("answer"), id: name, digest, question_id: name,
    question_revision: z.number().int().positive(), answer_id: name, text: prose }).strict(),
]);
/** Constructed from protected native records by the host, never from model prose. */
export type ReadScopeReference = z.infer<typeof referenceSchema>;
const bindingSchema = z.object({ request_digest: digest, source_digest: digest, catalog_digest: digest,
  meaning_digest: digest, applicability_digest: digest, operation_digest: digest }).strict();
export type ReadScopeBinding = z.infer<typeof bindingSchema>;
const recordBodySchema = z.object({ protocol: z.literal(READ_SCOPE_PROTOCOL), proposal: readScopeProposalCodec,
  binding: bindingSchema, references: z.array(referenceSchema).min(1).max(1024),
  analysis_digest: digest.optional(),
  requirement_bindings: z.array(z.object({ id: name, digest }).strict()).max(128) }).strict();
const recordSchema = recordBodySchema.extend({ digest }).strict();
/** Stored inside the native question, never a separate accepted-meaning store.
 * This record is still only a proposal. Native trusted confirmation is separate. */
export type ReadScopeRecord = z.infer<typeof recordSchema>;
export type ReadScopeCatalog = { resources: readonly { id: string; fields: readonly { id: string }[] }[];
  relationships: readonly { id: string; from: string; to: string }[] };

function invalid(code: string, detail: string): never {
  throw new Error(`${code}: ${detail} No Read meaning, permission or activation was confirmed.`);
}
function unique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) invalid("READ_SCOPE_INVALID", `Duplicate ${label}.`);
}
function targetKey(target: ReadScopeTarget): string { return canonicalJsonDigest(target); }
function targetsKey(targets: readonly ReadScopeTarget[]): string[] { return targets.map(targetKey).sort(); }
function requirementBinding(requirement: ReadScopeProposal["requirements"][number], references: readonly ReadScopeReference[]) {
  // Provider-local IDs are correlation only; content + resolved provenance owns identity.
  return canonicalJsonDigest({ intended_use: requirement.intended_use, disposition: requirement.disposition,
    targets: targetsKey(requirement.targets), unresolved: requirement.unresolved ?? null,
    references: references.filter(reference => requirement.references.includes(reference.id))
      .map(reference => ({ ...reference })).sort((a, b) => a.id.localeCompare(b.id)) });
}

export function parseReadScopeProposal(value: unknown): ReadScopeProposal {
  const parsed = readScopeProposalCodec.safeParse(value);
  if (!parsed.success) invalid("READ_SCOPE_INVALID", parsed.error.issues.map(issue => issue.message).join("; "));
  const proposal = parsed.data;
  unique(proposal.requirements.map(requirement => requirement.id), "requirement identity");
  for (const requirement of proposal.requirements) {
    unique(requirement.references, "reference");
    unique(requirement.targets.map(targetKey), "target");
    if (requirement.disposition === "unresolved") {
      if (!requirement.unresolved) invalid("READ_SCOPE_INVALID", "An unresolved requirement must retain its missing mapping.");
    } else if (!requirement.targets.length || requirement.unresolved !== undefined) {
      invalid("READ_SCOPE_INVALID", "A resolved requirement needs exact targets and no unresolved mapping.");
    }
  }
  return proposal;
}

function validateCatalogTarget(target: ReadScopeTarget, catalog: ReadScopeCatalog): void {
  const root = catalog.resources.find(resource => resource.id === target.root_resource);
  const resource = catalog.resources.find(resource => resource.id === target.resource);
  if (!root || !resource || target.field !== undefined && !resource.fields.some(field => field.id === target.field))
    invalid("READ_SCOPE_TARGET_INVALID", "The exact root/resource/field is not in the supplied catalog.");
  if (target.operation === "resource" && (target.field !== undefined || target.relationship !== undefined || target.qualifier !== undefined))
    invalid("READ_SCOPE_TARGET_INVALID", "Resource identity is not a wildcard field or relationship operation.");
  if (target.operation === "relationship") {
    if (target.field !== undefined || target.resource !== target.root_resource || !target.relationship || !catalog.relationships.some(relationship =>
      relationship.id === target.relationship && relationship.from === target.root_resource && relationship.to === target.qualifier))
      invalid("READ_SCOPE_TARGET_INVALID", "The exact relationship is not in the supplied catalog.");
  } else if (target.relationship !== undefined) {
    if (!catalog.relationships.some(relationship => relationship.id === target.relationship
      && relationship.from === target.root_resource && relationship.to === target.resource))
      invalid("READ_SCOPE_TARGET_INVALID", "The field operation is not reached through its exact catalog relationship.");
  } else if (target.resource !== target.root_resource)
    invalid("READ_SCOPE_TARGET_INVALID", "A related target requires its exact relationship identity.");
  if (["return", "filter", "sort", "group", "count_distinct", "time_bucket", "time_window", "numeric_band", "auto_band"].includes(target.operation)
    && target.field === undefined) invalid("READ_SCOPE_TARGET_INVALID", "This operation needs an exact field.");
}

export function resolveReadScopeProposal(value: unknown, input: {
  expectedBinding: ReadScopeBinding; references: readonly ReadScopeReference[]; catalog: ReadScopeCatalog;
  analysis?: ReadWorkloadAnalysis;
}): ReadScopeRecord {
  const proposal = parseReadScopeProposal(value);
  const binding = bindingSchema.parse(input.expectedBinding);
  const inventory = input.references.map(reference => referenceSchema.parse(reference));
  unique(inventory.map(reference => reference.id), "host reference identity");
  const original = inventory.find(reference => reference.id === proposal.original_request);
  if (!original || original.kind !== "request" || original.digest !== binding.request_digest)
    invalid("READ_SCOPE_REFERENCE_INVALID", "The original request does not match the current host binding.");
  const used = new Set([proposal.original_request, ...proposal.requirements.flatMap(requirement => requirement.references)]);
  const references = inventory.filter(reference => used.has(reference.id)).sort((a, b) => a.id.localeCompare(b.id));
  if (references.length !== used.size) invalid("READ_SCOPE_REFERENCE_INVALID", "A reference was not supplied by the host.");
  for (const reference of references) {
    if (reference.kind === "source" && (reference.digest !== binding.source_digest || reference.end_line < reference.start_line))
      invalid("READ_SCOPE_REFERENCE_INVALID", "The Source identity or line range is stale or invalid.");
  }
  for (const requirement of proposal.requirements) for (const target of requirement.targets) validateCatalogTarget(target, input.catalog);
  const body = { protocol: READ_SCOPE_PROTOCOL, proposal, binding, references,
    ...(input.analysis ? { analysis_digest: canonicalJsonDigest(input.analysis) } : {}),
    requirement_bindings: proposal.requirements.map(requirement => ({ id: requirement.id, digest: requirementBinding(requirement, references) })) };
  return parseReadScopeRecord({ ...body, digest: canonicalJsonDigest(body) });
}

export function parseReadScopeRecord(value: unknown): ReadScopeRecord {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) invalid("READ_SCOPE_RECORD_INVALID", "The native Read proposal record is malformed.");
  const record = parsed.data;
  parseReadScopeProposal(record.proposal);
  unique(record.references.map(reference => reference.id), "saved reference identity");
  const { digest: recordedDigest, ...body } = record;
  if (canonicalJsonDigest(body) !== recordedDigest || canonicalJsonDigest(record.requirement_bindings) !== canonicalJsonDigest(
    record.proposal.requirements.map(requirement => ({ id: requirement.id, digest: requirementBinding(requirement, record.references) }))))
    invalid("READ_SCOPE_RECORD_INVALID", "The proposal or resolved requirement binding changed.");
  const original = record.references.find(reference => reference.id === record.proposal.original_request);
  if (!original || original.kind !== "request" || original.digest !== record.binding.request_digest
    || record.proposal.requirements.some(requirement => requirement.references.some(id => !record.references.some(reference => reference.id === id))))
    invalid("READ_SCOPE_RECORD_INVALID", "The resolved original request or requirement provenance is missing.");
  if (record.references.some(reference => reference.kind === "source"
    && (reference.digest !== record.binding.source_digest || reference.end_line < reference.start_line)))
    invalid("READ_SCOPE_RECORD_INVALID", "The saved Source identity or line range is inconsistent with its binding.");
  return record;
}

/** Self-consistent hashes are insufficient. Native consumers must resolve every
 * saved reference again against their current protected inventory. No Source
 * quote or recorded answer is accepted merely because its location exists. */
export function assertReadScopeProvenance(value: ReadScopeRecord, input: {
  expectedBinding: ReadScopeBinding; references: readonly ReadScopeReference[]; catalog: ReadScopeCatalog;
}): ReadScopeRecord {
  const record = parseReadScopeRecord(value);
  const current = resolveReadScopeProposal(record.proposal, input);
  const { digest: _savedDigest, analysis_digest: _analysis, ...savedBody } = record;
  const { digest: _currentDigest, ...currentBody } = current;
  if (canonicalJsonDigest(savedBody) !== canonicalJsonDigest(currentBody))
    invalid("READ_SCOPE_PROVENANCE_STALE", "The saved scope does not match the exact current host reference inventory and binding.");
  return record;
}

function atomTarget(atom: ReadAuthorityAtom): ReadScopeTarget {
  const { id: _id, ...target } = atom;
  return target;
}
export type ReadScopeDraftAssessment = { status: "compatible" | "pending" | "delta_required";
  unresolved: string[]; missing: ReadScopeTarget[]; excluded: ReadScopeTarget[]; added: ReadScopeTarget[];
  analysis_ready: boolean; authority_granted: false };
/** Exact finite values only: no prose parsing, synonymy or completeness claim. */
export function assessReadScopeDraft(value: ReadScopeRecord, analysis: ReadWorkloadAnalysis): ReadScopeDraftAssessment {
  const record = parseReadScopeRecord(value);
  const included = record.proposal.requirements.filter(requirement => requirement.disposition === "include").flatMap(requirement => requirement.targets);
  const excluded = record.proposal.requirements.filter(requirement => requirement.disposition === "exclude").flatMap(requirement => requirement.targets);
  const unresolved = record.proposal.requirements.filter(requirement => requirement.disposition === "unresolved").map(requirement => requirement.id);
  const actual = analysis.authority_atoms.map(atomTarget);
  const includedKeys = new Set(included.map(targetKey)), excludedKeys = new Set(excluded.map(targetKey)), actualKeys = new Set(actual.map(targetKey));
  const missing = included.filter(target => !actualKeys.has(targetKey(target)));
  const forbidden = actual.filter(target => excludedKeys.has(targetKey(target)));
  const added = actual.filter(target => !includedKeys.has(targetKey(target)));
  return { status: unresolved.length || analysis.status !== "ready" ? "pending" : missing.length || forbidden.length || added.length ? "delta_required" : "compatible",
    unresolved, missing, excluded: forbidden, added, analysis_ready: analysis.status === "ready", authority_granted: false };
}

/** A changed scope must be shown as a delta. Provider item IDs cannot conceal a
 * removed exclusion or relabel a different intended use as the old requirement. */
export function readScopeDelta(before: ReadScopeRecord, after: ReadScopeRecord): {
  removed: ReadScopeRecord["requirement_bindings"]; added: ReadScopeRecord["requirement_bindings"];
} {
  const prior = parseReadScopeRecord(before), next = parseReadScopeRecord(after);
  const oldDigests = new Set(prior.requirement_bindings.map(requirement => requirement.digest));
  const newDigests = new Set(next.requirement_bindings.map(requirement => requirement.digest));
  return { removed: prior.requirement_bindings.filter(requirement => !newDigests.has(requirement.digest)),
    added: next.requirement_bindings.filter(requirement => !oldDigests.has(requirement.digest)) };
}

/** Native owner must supply a parsed OperatorQuestion and its current lineage.
 * Passing a provider reply here is never a substitute for that protected loader. */
export function currentReadScope(input: { record: ReadScopeRecord; expectedBinding: ReadScopeBinding;
  confirmation?: { proposal_digest: string; actor: "local_installation_operator" };
  retired?: boolean; pendingReplacement?: boolean }): {
    status: "proposed" | "confirmed" | "stale" | "pending"; record: ReadScopeRecord; authority_granted: false;
  } {
  const record = parseReadScopeRecord(input.record);
  const current = bindingSchema.parse(input.expectedBinding);
  const status = input.retired || canonicalJsonDigest(record.binding) !== canonicalJsonDigest(current) ? "stale"
    : input.pendingReplacement || !record.analysis_digest || record.proposal.requirements.some(requirement => requirement.disposition === "unresolved") ? "pending"
    : input.confirmation?.actor === "local_installation_operator" && input.confirmation.proposal_digest === record.digest ? "confirmed" : "proposed";
  return { status, record, authority_granted: false };
}
