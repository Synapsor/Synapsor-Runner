import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { SchemaInspection, TableInfo } from "@synapsor-runner/schema-inspector";
import { resolveReadPrerequisiteScope, type ReadPrerequisiteScopeBoundaryContext } from "./read-prerequisite-scope.js";
export type { ReadPrerequisiteScopeEvidence } from "./read-prerequisite-scope.js";

export const READ_CURRENT_STATE_PREREQUISITE_VERSION =
  "synapsor.read-current-state-prerequisite.v1";
export const READ_PREREQUISITE_DEPENDENCY_VERSION =
  "synapsor.read-prerequisite-dependency.v1";
const MAX_SUPPORTED_CURRENT_STATE_CANDIDATES = 64;

export class ReadPrerequisiteCatalogTooLargeError extends Error {
  readonly code = "READ_PREREQUISITE_CATALOG_TOO_LARGE";
  constructor() {
    super("READ_PREREQUISITE_CATALOG_TOO_LARGE: More than 64 possible private access-condition mappings. Select the authoritative source before reviewing its metadata; no candidates were truncated or transferred.");
  }
}

export type ReadCurrentStatePrerequisite = {
  schema_version: typeof READ_CURRENT_STATE_PREREQUISITE_VERSION;
  source: { schema: string; table: string };
  subject: {
    tenant_column: string;
    principal_column: string;
    /** Exact inspected two-column uniqueness; no history, ordering, or collection is allowed. */
    unique_constraint: string;
  };
  current_state: {
    state_column: string;
    /** An inspected enum value, fixed by reviewed authority and never caller input. */
    positive_state: string;
    effective_from_column: string;
    effective_until_column: string;
    interval: "[effective_from,effective_until)";
    clock: "database_utc";
  };
  /** Explicit reviewed meaning; catalog names and comments are never sufficient. */
  semantic_consent: {
    source_description: string;
    positive_state_description: string;
    confirmed: true;
  };
  /** Existing reviewed RLS settings for the prerequisite relation, if applicable. */
  rls_session?: { tenant_setting?: string; principal_setting?: string };
};

export type ReadPrerequisiteAuthorityDependency = {
  schema_version: typeof READ_PREREQUISITE_DEPENDENCY_VERSION;
  source: { schema: string; table: string };
  fields: {
    tenant_column: string;
    principal_column: string;
    state_column: string;
    effective_from_column: string;
    effective_until_column: string;
  };
  unique_constraint: string;
  positive_state: string;
  clock: "database_utc";
  rls_session?: { tenant_setting?: string; principal_setting?: string };
  fingerprint: `sha256:${string}`;
};

/** A candidate becomes runtime authority only after an inspection binds this dependency. */
export type ReviewedReadCurrentStatePrerequisite = ReadCurrentStatePrerequisite & {
  dependency: ReadPrerequisiteAuthorityDependency;
};

/** Structural minimum needed to prove the Read runtime has a trusted principal. */
export type ReadPrerequisiteBoundaryContext = ReadPrerequisiteScopeBoundaryContext & {
  trusted_context: {
    provider: "environment" | "http_claims";
    principal_env?: string;
    principal_claim?: string;
  };
};

/** Catalog metadata only. No source values, caller identity, or predicate result is loaded. */
export type SupportedReadCurrentStatePrerequisiteCandidate = {
  source: { schema: string; table: string };
  subject: {
    tenant_column: string;
    principal_column: string;
    unique_constraint: string;
  };
  current_state: {
    state_column: string;
    positive_states: string[];
    effective_from_column: string;
    effective_until_column: string;
    interval: "[effective_from,effective_until)";
    clock: "database_utc";
  };
  rls_required: boolean;
  /** Untrusted catalog labels only; the selection requires explicit consent text. */
  catalog_descriptions: {
    source?: string;
    state?: string;
    effective_from?: string;
    effective_until?: string;
  };
};

/** Exact reviewed selection; all names and the positive enum value must come from a listed candidate. */
export type ReadCurrentStatePrerequisiteSelection = Omit<ReadCurrentStatePrerequisite, "schema_version" | "rls_session">;

export function listSupportedReadCurrentStatePrerequisiteCandidates(
  inspection: SchemaInspection,
  boundary: ReadPrerequisiteBoundaryContext,
  scope?: ReadPrerequisiteCandidateScope,
): SupportedReadCurrentStatePrerequisiteCandidate[] {
  assertReadPrerequisiteBoundaryContext(boundary);
  const candidates: SupportedReadCurrentStatePrerequisiteCandidate[] = [];
  const missingScopes: string[] = [];
  for (const candidate of supportedReadPrerequisiteCandidates(inspection, boundary, scope, missingScopes)) {
    candidates.push(candidate);
    if (candidates.length > MAX_SUPPORTED_CURRENT_STATE_CANDIDATES) throw new ReadPrerequisiteCatalogTooLargeError();
  }
  if (!candidates.length && missingScopes.length) throwMissingScopeProof(missingScopes);
  return candidates.sort((left, right) => canonicalJsonDigest(left).localeCompare(canonicalJsonDigest(right)));
}

type ReadPrerequisiteCandidateScope = {
  source: { schema: string; table: string };
  subject?: SupportedReadCurrentStatePrerequisiteCandidate["subject"];
  current_state?: Pick<SupportedReadCurrentStatePrerequisiteCandidate["current_state"],
    "state_column" | "effective_from_column" | "effective_until_column">;
};

/** A local source picker, not a partial model contract or a grant of access. */
export function listReadCurrentStatePrerequisiteSources(
  inspection: SchemaInspection, boundary: ReadPrerequisiteBoundaryContext,
): Array<{ schema: string; table: string }> {
  assertReadPrerequisiteBoundaryContext(boundary);
  const missingScopes: string[] = [];
  const sources = inspection.tables.flatMap(table => {
    const source = { schema: table.schema, table: table.name };
    return supportedReadPrerequisiteCandidates(inspection, boundary, { source }, missingScopes).next().done ? [] : [source];
  });
  if (!sources.length && missingScopes.length) throwMissingScopeProof(missingScopes);
  return sources;
}

function throwMissingScopeProof(reasons: string[]): never {
  throw new Error(`READ_PREREQUISITE_SCOPE_PROOF_MISSING: ${reasons.slice(0, 8).join(" ")} No identity mapping was inferred and no authority changed.`);
}

function* supportedReadPrerequisiteCandidates(
  inspection: SchemaInspection, boundary: ReadPrerequisiteBoundaryContext,
  scope?: ReadPrerequisiteCandidateScope, missingScopes: string[] = [],
): Generator<SupportedReadCurrentStatePrerequisiteCandidate> {
  for (const table of inspection.tables) {
    if (scope && (table.schema !== scope.source.schema || table.name !== scope.source.table)) continue;
    if (table.type !== "table" || !hasSafeReadOnlyPosture(table)) continue;
    const nonNull = table.columns.filter((column) => !column.nullable);
    const stateColumns = nonNull.filter((column) => (column.enum_values?.length ?? 0) > 0);
    const instantColumns = nonNull.filter((column) => isUtcInstantColumn(inspection.engine, column.data_type));
    if (!stateColumns.length || instantColumns.length < 2 || !table.unique_constraints.some(constraint => constraint.columns.length === 2)) continue;
    const proof = resolveReadPrerequisiteScope(inspection, boundary, { schema: table.schema, table: table.name });
    if (proof.state === "missing") { missingScopes.push(proof.reason); continue; }
    for (const constraint of table.unique_constraints) {
      if (constraint.columns.length !== 2) continue;
      const [left, right] = constraint.columns;
      if (!left || !right) continue;
      for (const [tenant, principal] of [[left, right], [right, left]] as const) {
        if (tenant !== proof.subject.tenant_column || principal !== proof.subject.principal_column) continue;
        if (scope?.subject && (scope.subject.tenant_column !== tenant || scope.subject.principal_column !== principal
          || scope.subject.unique_constraint !== constraint.name)) continue;
        if (!nonNull.some((column) => column.name === tenant)
          || !nonNull.some((column) => column.name === principal)) continue;
        for (const state of stateColumns) {
          if (scope?.current_state && scope.current_state.state_column !== state.name) continue;
          if (state.name === tenant || state.name === principal) continue;
          for (const effectiveFrom of instantColumns) {
            if (scope?.current_state && scope.current_state.effective_from_column !== effectiveFrom.name) continue;
            if ([tenant, principal, state.name].includes(effectiveFrom.name)) continue;
            for (const effectiveUntil of instantColumns) {
              if (scope?.current_state && scope.current_state.effective_until_column !== effectiveUntil.name) continue;
              if (effectiveUntil.name === effectiveFrom.name
                || [tenant, principal, state.name].includes(effectiveUntil.name)) continue;
              yield {
                source: { schema: table.schema, table: table.name },
                subject: { tenant_column: tenant, principal_column: principal, unique_constraint: constraint.name },
                current_state: {
                  state_column: state.name,
                  positive_states: [...state.enum_values!].sort(),
                  effective_from_column: effectiveFrom.name,
                  effective_until_column: effectiveUntil.name,
                  interval: "[effective_from,effective_until)",
                  clock: "database_utc",
                },
                rls_required: table.row_level_security === true,
                catalog_descriptions: {
                  ...(table.comment ? { source: table.comment } : {}),
                  ...(state.comment ? { state: state.comment } : {}),
                  ...(effectiveFrom.comment ? { effective_from: effectiveFrom.comment } : {}),
                  ...(effectiveUntil.comment ? { effective_until: effectiveUntil.comment } : {}),
                },
              };
            }
          }
        }
      }
    }
  }
}

export function prepareReviewedReadCurrentStatePrerequisite(
  selection: ReadCurrentStatePrerequisiteSelection,
  inspection: SchemaInspection,
  boundary: ReadPrerequisiteBoundaryContext,
): ReviewedReadCurrentStatePrerequisite {
  assertReadPrerequisiteBoundaryContext(boundary);
  const selectionRecord = structuredClone(selection) as Record<string, unknown>;
  // Runtime selection is untyped input. RLS bindings come only from existing
  // reviewed host authority, never from a model or ad hoc selection payload.
  delete selectionRecord.rls_session;
  const rlsSession = reviewedPrerequisiteRlsSession(boundary);
  const prerequisite: ReadCurrentStatePrerequisite = {
    schema_version: READ_CURRENT_STATE_PREREQUISITE_VERSION,
    ...selectionRecord as Omit<ReadCurrentStatePrerequisite, "schema_version">,
    ...(rlsSession ? { rls_session: rlsSession } : {}),
  };
  const exactCandidate = listSupportedReadCurrentStatePrerequisiteCandidates(inspection, boundary, prerequisite).some((candidate) =>
    candidate.source.schema === prerequisite.source.schema
    && candidate.source.table === prerequisite.source.table
    && candidate.subject.tenant_column === prerequisite.subject.tenant_column
    && candidate.subject.principal_column === prerequisite.subject.principal_column
    && candidate.subject.unique_constraint === prerequisite.subject.unique_constraint
    && candidate.current_state.state_column === prerequisite.current_state.state_column
    && candidate.current_state.effective_from_column === prerequisite.current_state.effective_from_column
    && candidate.current_state.effective_until_column === prerequisite.current_state.effective_until_column
    && candidate.current_state.positive_states.includes(prerequisite.current_state.positive_state)
    && candidate.current_state.interval === prerequisite.current_state.interval
    && candidate.current_state.clock === prerequisite.current_state.clock,
  );
  if (!exactCandidate) {
    throw new Error("Read current-state prerequisite selection is not an exact supported inspected candidate.");
  }
  return reviewReadCurrentStatePrerequisite(prerequisite, inspection);
}

export type CompiledReadPrerequisite = {
  authority_fingerprint: `sha256:${string}`;
  gate_sql: string;
  gate_params: Array<string>;
  rls_session?: { tenant_setting?: string; principal_setting?: string };
};

type Engine = "postgres" | "mysql";
type IdentifierQuoter = (identifier: string, engine: Engine) => string;
type Placeholder = (index: number, engine: Engine) => string;

export function assertReadCurrentStatePrerequisiteShape(
  prerequisite: ReviewedReadCurrentStatePrerequisite,
): void {
  assertOnlyKeys(prerequisite, ["schema_version", "source", "subject", "current_state", "semantic_consent", "rls_session", "dependency"], "Read current-state prerequisite");
  assertOnlyKeys(prerequisite.source, ["schema", "table"], "Read prerequisite source");
  assertOnlyKeys(prerequisite.subject, ["tenant_column", "principal_column", "unique_constraint"], "Read prerequisite subject");
  assertOnlyKeys(prerequisite.current_state, ["state_column", "positive_state", "effective_from_column", "effective_until_column", "interval", "clock"], "Read prerequisite current state");
  assertOnlyKeys(prerequisite.semantic_consent, ["source_description", "positive_state_description", "confirmed"], "Read prerequisite semantic consent");
  assertOnlyKeys(prerequisite.dependency, ["schema_version", "source", "fields", "unique_constraint", "positive_state", "clock", "rls_session", "fingerprint"], "Read prerequisite dependency");
  assertOnlyKeys(prerequisite.dependency.source, ["schema", "table"], "Read prerequisite dependency source");
  assertOnlyKeys(prerequisite.dependency.fields, ["tenant_column", "principal_column", "state_column", "effective_from_column", "effective_until_column"], "Read prerequisite dependency fields");
  if (prerequisite.rls_session) assertOnlyKeys(prerequisite.rls_session, ["tenant_setting", "principal_setting"], "Read prerequisite RLS session");
  if (prerequisite.dependency.rls_session) assertOnlyKeys(prerequisite.dependency.rls_session, ["tenant_setting", "principal_setting"], "Read prerequisite dependency RLS session");
  if (prerequisite.schema_version !== READ_CURRENT_STATE_PREREQUISITE_VERSION
    || prerequisite.current_state.interval !== "[effective_from,effective_until)"
    || prerequisite.current_state.clock !== "database_utc"
    || prerequisite.dependency.schema_version !== READ_PREREQUISITE_DEPENDENCY_VERSION
    || !/^sha256:[a-f0-9]{64}$/.test(prerequisite.dependency.fingerprint)) {
    throw new Error("Read current-state prerequisite authority is malformed.");
  }
  for (const value of [
    prerequisite.source.schema,
    prerequisite.source.table,
    prerequisite.subject.tenant_column,
    prerequisite.subject.principal_column,
    prerequisite.subject.unique_constraint,
    prerequisite.current_state.state_column,
    prerequisite.current_state.positive_state,
    prerequisite.current_state.effective_from_column,
    prerequisite.current_state.effective_until_column,
  ]) assertPrintable(value, "Read current-state prerequisite authority");
  assertDescription(prerequisite.semantic_consent.source_description, "Read prerequisite source description");
  assertDescription(prerequisite.semantic_consent.positive_state_description, "Read prerequisite positive-state description");
  if (prerequisite.semantic_consent.confirmed !== true) throw new Error("Read prerequisite semantic consent must be explicitly confirmed.");
  if (prerequisite.dependency.source.schema !== prerequisite.source.schema
    || prerequisite.dependency.source.table !== prerequisite.source.table
    || prerequisite.dependency.unique_constraint !== prerequisite.subject.unique_constraint
    || prerequisite.dependency.positive_state !== prerequisite.current_state.positive_state
    || prerequisite.dependency.clock !== prerequisite.current_state.clock
    || canonicalJsonDigest(prerequisite.dependency.fields) !== canonicalJsonDigest({
      tenant_column: prerequisite.subject.tenant_column,
      principal_column: prerequisite.subject.principal_column,
      state_column: prerequisite.current_state.state_column,
      effective_from_column: prerequisite.current_state.effective_from_column,
      effective_until_column: prerequisite.current_state.effective_until_column,
    })
    || canonicalJsonDigest(prerequisite.dependency.rls_session ?? null)
      !== canonicalJsonDigest(prerequisite.rls_session ?? null)) {
    throw new Error("Read current-state prerequisite dependency does not agree with reviewed authority.");
  }
}

export function validateReadCurrentStatePrerequisite(
  prerequisite: ReadCurrentStatePrerequisite,
  inspection: SchemaInspection,
): ReadPrerequisiteAuthorityDependency {
  if (prerequisite.schema_version !== READ_CURRENT_STATE_PREREQUISITE_VERSION) {
    throw new Error("Read current-state prerequisite has an unsupported schema version.");
  }
  const table = inspectedTable(prerequisite, inspection);
  if (table.type !== "table") throw new Error("Read current-state prerequisite source must be an inspected base table.");
  assertReadOnlyPosture(table);
  assertPrintable(prerequisite.source.schema, "Read prerequisite schema");
  assertPrintable(prerequisite.source.table, "Read prerequisite table");
  const fields = {
    tenant_column: prerequisite.subject.tenant_column,
    principal_column: prerequisite.subject.principal_column,
    state_column: prerequisite.current_state.state_column,
    effective_from_column: prerequisite.current_state.effective_from_column,
    effective_until_column: prerequisite.current_state.effective_until_column,
  };
  for (const [label, field] of Object.entries(fields)) assertPrintable(field, `Read prerequisite ${label}`);
  if (new Set(Object.values(fields)).size !== Object.keys(fields).length) {
    throw new Error("Read current-state prerequisite identity, state, and interval columns must be distinct.");
  }
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  const tenant = requireColumn(columns, fields.tenant_column);
  const principal = requireColumn(columns, fields.principal_column);
  const state = requireColumn(columns, fields.state_column);
  const effectiveFrom = requireColumn(columns, fields.effective_from_column);
  const effectiveUntil = requireColumn(columns, fields.effective_until_column);
  if ([tenant, principal, state, effectiveFrom, effectiveUntil].some((column) => column.nullable)) {
    throw new Error("Read current-state prerequisite requires non-null identity, state, and interval columns.");
  }
  const unique = table.unique_constraints.find((constraint) => constraint.name === prerequisite.subject.unique_constraint);
  if (!unique || !sameSet(unique.columns, [fields.tenant_column, fields.principal_column])) {
    throw new Error("Read current-state prerequisite requires the named inspected UNIQUE constraint to contain exactly tenant and principal columns.");
  }
  if (!Array.isArray(state.enum_values) || !state.enum_values.includes(prerequisite.current_state.positive_state)) {
    throw new Error("Read current-state prerequisite positive state must be an exact inspected enum value.");
  }
  assertPrintable(prerequisite.current_state.positive_state, "Read prerequisite positive state");
  assertUtcInstantColumns(inspection.engine, effectiveFrom.data_type, effectiveUntil.data_type);
  assertRlsSettings(prerequisite.rls_session);
  const dependency = {
    schema_version: READ_PREREQUISITE_DEPENDENCY_VERSION,
    source: { ...prerequisite.source },
    fields,
    unique_constraint: prerequisite.subject.unique_constraint,
    positive_state: prerequisite.current_state.positive_state,
    clock: prerequisite.current_state.clock,
    ...(prerequisite.rls_session ? { rls_session: { ...prerequisite.rls_session } } : {}),
  } as const;
  return {
    ...dependency,
    fingerprint: readPrerequisiteDependencyFingerprint(dependency, inspection),
  };
}

export function reviewReadCurrentStatePrerequisite(
  prerequisite: ReadCurrentStatePrerequisite,
  inspection: SchemaInspection,
): ReviewedReadCurrentStatePrerequisite {
  const reviewed: ReviewedReadCurrentStatePrerequisite = {
    ...structuredClone(prerequisite),
    dependency: validateReadCurrentStatePrerequisite(prerequisite, inspection),
  };
  assertReadCurrentStatePrerequisiteShape(reviewed);
  return reviewed;
}

export function assertReviewedReadCurrentStatePrerequisite(
  prerequisite: ReviewedReadCurrentStatePrerequisite,
  inspection: SchemaInspection,
): void {
  assertReadCurrentStatePrerequisiteShape(prerequisite);
  const expected = validateReadCurrentStatePrerequisite(prerequisite, inspection);
  const { fingerprint: _expectedFingerprint, ...expectedWithoutFingerprint } = expected;
  const { fingerprint: _storedFingerprint, ...storedWithoutFingerprint } = prerequisite.dependency;
  if (canonicalJsonDigest(expectedWithoutFingerprint)
    !== canonicalJsonDigest(storedWithoutFingerprint)) {
    throw new Error("Read current-state prerequisite authority and its reviewed dependency disagree.");
  }
  assertReadPrerequisiteDependencyCurrent(prerequisite.dependency, inspection);
}

/** Only rescan can refresh writer-only additions, after reproducing the exact
 * historical proof. Runtime always checks the full currently reviewed proof. */
export function reconcileReadPrerequisiteForRescan(
  prerequisite: ReviewedReadCurrentStatePrerequisite,
  inspection: SchemaInspection,
  previousPolicyNames?: readonly string[],
): ReviewedReadCurrentStatePrerequisite {
  try {
    assertReviewedReadCurrentStatePrerequisite(prerequisite, inspection);
    return structuredClone(prerequisite);
  } catch (error) {
    const table = inspectedTable(prerequisite, inspection);
    const policies = table.row_level_security_policies;
    const applicable = table.role_posture?.row_security_applicable_policies;
    if (inspection.engine !== "postgres" || !previousPolicyNames || !policies || !applicable
      || table.row_level_security !== true || table.role_posture?.row_security_forced !== true
      || new Set(previousPolicyNames).size !== previousPolicyNames.length
      || new Set(policies.map(policy => policy.name)).size !== policies.length
      || previousPolicyNames.some(name => !policies.some(policy => policy.name === name))) throw error;
    const previousNames = new Set(previousPolicyNames);
    const added = policies.filter(policy => !previousNames.has(policy.name));
    if (!added.length || added.some(policy => applicable.includes(policy.name)
      || policy.roles.some(role => role.toLowerCase() === "public" || role === inspection.current_user))) throw error;
    const historical = structuredClone(inspection);
    inspectedTable(prerequisite, historical).row_level_security_policies = structuredClone(
      policies.filter(policy => previousNames.has(policy.name)),
    );
    // This equality check also rejects changed enums, time types, old predicates,
    // ownership, uniqueness and effective grants. Do not merely re-sign drift.
    assertReviewedReadCurrentStatePrerequisite(prerequisite, historical);
    return reviewReadCurrentStatePrerequisite(prerequisite, inspection);
  }
}

export function readPrerequisiteDependencyFingerprint(
  dependency: Omit<ReadPrerequisiteAuthorityDependency, "fingerprint">,
  inspection: SchemaInspection,
): `sha256:${string}` {
  const prerequisite: ReadCurrentStatePrerequisite = {
    schema_version: READ_CURRENT_STATE_PREREQUISITE_VERSION,
    source: { ...dependency.source },
    subject: {
      tenant_column: dependency.fields.tenant_column,
      principal_column: dependency.fields.principal_column,
      unique_constraint: dependency.unique_constraint,
    },
    current_state: {
      state_column: dependency.fields.state_column,
      positive_state: dependency.positive_state,
      effective_from_column: dependency.fields.effective_from_column,
      effective_until_column: dependency.fields.effective_until_column,
      interval: "[effective_from,effective_until)",
      clock: dependency.clock,
    },
    semantic_consent: {
      source_description: "Dependency fingerprint reconstruction only.",
      positive_state_description: "Dependency fingerprint reconstruction only.",
      confirmed: true,
    },
    ...(dependency.rls_session ? { rls_session: { ...dependency.rls_session } } : {}),
  };
  const validated = validateReadCurrentStatePrerequisiteWithoutFingerprint(prerequisite, inspection);
  return canonicalJsonDigest({
    engine: inspection.engine,
    source: validated.table,
    columns: validated.columns,
    unique_constraint: validated.unique_constraint,
    row_level_security: validated.row_level_security,
    row_level_security_policies: validated.row_level_security_policies,
    role_posture: validated.role_posture,
    rls_session: dependency.rls_session ?? null,
    clock: dependency.clock,
  });
}

export function assertReadPrerequisiteDependencyCurrent(
  dependency: ReadPrerequisiteAuthorityDependency,
  inspection: SchemaInspection,
): void {
  if (dependency.schema_version !== READ_PREREQUISITE_DEPENDENCY_VERSION) {
    throw new Error("Read prerequisite dependency has an unsupported schema version.");
  }
  const fingerprint = readPrerequisiteDependencyFingerprint(dependency, inspection);
  if (fingerprint !== dependency.fingerprint) {
    throw new Error("Read current-state prerequisite source, uniqueness, enum, UTC interval, RLS, or reader role posture changed.");
  }
}

export function compileReadPrerequisitePredicate(input: {
  prerequisite: ReadCurrentStatePrerequisite;
  context: { tenant: string; principal: string };
  params: Array<string | number | boolean | null>;
  engine: Engine;
  quote: IdentifierQuoter;
  placeholder: Placeholder;
}): { predicate: string; compiled: CompiledReadPrerequisite } {
  const compiled = compileReadPrerequisiteGate(input);
  const alias = "__synapsor_prerequisite";
  const predicate = prerequisiteExistsSql({
    prerequisite: input.prerequisite,
    alias,
    context: input.context,
    params: input.params,
    engine: input.engine,
    quote: input.quote,
    placeholder: input.placeholder,
  });
  return { predicate, compiled };
}

export function compileReadPrerequisiteGate(input: {
  prerequisite: ReadCurrentStatePrerequisite;
  context: { tenant: string; principal: string };
  engine: Engine;
  quote: IdentifierQuoter;
  placeholder: Placeholder;
}): CompiledReadPrerequisite {
  const params: string[] = [];
  const predicate = prerequisiteExistsSql({
    prerequisite: input.prerequisite,
    alias: "__synapsor_prerequisite",
    context: input.context,
    params,
    engine: input.engine,
    quote: input.quote,
    placeholder: input.placeholder,
  });
  return {
    authority_fingerprint: canonicalJsonDigest(input.prerequisite),
    gate_sql: `SELECT ${predicate} AS ${input.quote("__synapsor_prerequisite_satisfied", input.engine)}`,
    gate_params: params,
    ...(input.prerequisite.rls_session ? { rls_session: { ...input.prerequisite.rls_session } } : {}),
  };
}

export function assertConsistentCompiledReadPrerequisite(
  queries: Array<{ read_prerequisite?: CompiledReadPrerequisite }>,
): CompiledReadPrerequisite | undefined {
  const prerequisites = queries.map((query) => query.read_prerequisite).filter(
    (value): value is CompiledReadPrerequisite => Boolean(value),
  );
  if (!prerequisites.length) return undefined;
  if (prerequisites.length !== queries.length
    || prerequisites.some((candidate) => canonicalJsonDigest(candidate) !== canonicalJsonDigest(prerequisites[0]!))) {
    throw new Error("Scoped Explore batch mixes read-prerequisite authority.");
  }
  return prerequisites[0]!;
}

function prerequisiteExistsSql(input: {
  prerequisite: ReadCurrentStatePrerequisite;
  alias: string;
  context: { tenant: string; principal: string };
  params: Array<string | number | boolean | null>;
  engine: Engine;
  quote: IdentifierQuoter;
  placeholder: Placeholder;
}): string {
  const { prerequisite, alias, context, params, engine, quote, placeholder } = input;
  const bind = (value: string) => {
    params.push(value);
    return placeholder(params.length, engine);
  };
  const column = (name: string) => `${alias}.${quote(name, engine)}`;
  const clock = engine === "postgres" ? "CURRENT_TIMESTAMP" : "@synapsor_read_prerequisite_now";
  return `EXISTS (SELECT 1 FROM ${quote(prerequisite.source.schema, engine)}.${quote(prerequisite.source.table, engine)} ${alias} WHERE ${column(prerequisite.subject.tenant_column)} = ${bind(context.tenant)} AND ${column(prerequisite.subject.principal_column)} = ${bind(context.principal)} AND ${column(prerequisite.current_state.state_column)} = ${bind(prerequisite.current_state.positive_state)} AND ${column(prerequisite.current_state.effective_from_column)} <= ${clock} AND ${clock} < ${column(prerequisite.current_state.effective_until_column)})`;
}

function validateReadCurrentStatePrerequisiteWithoutFingerprint(
  prerequisite: ReadCurrentStatePrerequisite,
  inspection: SchemaInspection,
): {
  table: Record<string, unknown>;
  columns: Record<string, unknown>[];
  unique_constraint: Record<string, unknown>;
  row_level_security: boolean | "unknown";
  row_level_security_policies: Record<string, unknown>[];
  role_posture: Record<string, unknown> | null;
} {
  const table = inspectedTable(prerequisite, inspection);
  if (table.type !== "table") throw new Error("Read current-state prerequisite source is not a safe base table.");
  assertReadOnlyPosture(table);
  const names = [
    prerequisite.subject.tenant_column,
    prerequisite.subject.principal_column,
    prerequisite.current_state.state_column,
    prerequisite.current_state.effective_from_column,
    prerequisite.current_state.effective_until_column,
  ];
  if (new Set(names).size !== names.length) throw new Error("Read current-state prerequisite columns must be distinct.");
  const byName = new Map(table.columns.map((column) => [column.name, column]));
  const selected = names.map((name) => requireColumn(byName, name));
  if (selected.some((column) => column.nullable)) throw new Error("Read current-state prerequisite columns must be non-null.");
  const unique = table.unique_constraints.find((constraint) => constraint.name === prerequisite.subject.unique_constraint);
  if (!unique || !sameSet(unique.columns, names.slice(0, 2))) throw new Error("Read current-state prerequisite unique constraint is not exact.");
  const state = selected[2]!;
  if (!state.enum_values?.includes(prerequisite.current_state.positive_state)) throw new Error("Read current-state prerequisite state is not an inspected enum value.");
  assertUtcInstantColumns(inspection.engine, selected[3]!.data_type, selected[4]!.data_type);
  assertRlsSettings(prerequisite.rls_session);
  return {
    table: { schema: table.schema, name: table.name, type: table.type },
    columns: selected.map((column) => ({
      name: column.name,
      data_type: column.data_type,
      nullable: column.nullable,
      enum_values: [...(column.enum_values ?? [])].sort(),
      generated: column.generated,
    })),
    unique_constraint: { name: unique.name, columns: [...unique.columns] },
    row_level_security: table.row_level_security ?? "unknown",
    row_level_security_policies: [...(table.row_level_security_policies ?? [])].map((policy) => ({
      name: policy.name,
      command: policy.command,
      permissive: policy.permissive,
      roles: [...policy.roles].sort(),
      using_expression: policy.using_expression ?? null,
      check_expression: policy.check_expression ?? null,
    })).sort((left, right) => String(left.name).localeCompare(String(right.name))),
    role_posture: table.role_posture ? {
      owner: table.role_posture.owner,
      current_role_is_owner: table.role_posture.current_role_is_owner,
      current_role_can_assume_owner: table.role_posture.current_role_can_assume_owner,
      privileges: table.role_posture.privileges,
      row_security_forced: table.role_posture.row_security_forced,
      row_security_effective_for_current_role: table.role_posture.row_security_effective_for_current_role,
    } : null,
  };
}

function inspectedTable(prerequisite: ReadCurrentStatePrerequisite, inspection: SchemaInspection): TableInfo {
  const table = inspection.tables.find((candidate) => candidate.schema === prerequisite.source.schema
    && candidate.name === prerequisite.source.table);
  if (!table) throw new Error("Read current-state prerequisite source is absent from the inspected catalog.");
  return table;
}

function assertReadOnlyPosture(table: TableInfo): void {
  const posture = table.role_posture;
  if (!posture || posture.current_role_is_owner || posture.current_role_can_assume_owner
    || !posture.privileges.select || posture.privileges.insert || posture.privileges.update
    || posture.privileges.delete || posture.privileges.truncate || posture.privileges.trigger) {
    throw new Error("Read current-state prerequisite requires the exact inspected reader role to have SELECT-only non-owner posture.");
  }
  if (table.row_level_security === true && posture.row_security_effective_for_current_role !== true) {
    throw new Error("Read current-state prerequisite RLS is not effective for the inspected reader role.");
  }
}

function hasSafeReadOnlyPosture(table: TableInfo): boolean {
  try {
    assertReadOnlyPosture(table);
    return true;
  } catch {
    return false;
  }
}

function assertReadPrerequisiteBoundaryContext(boundary: ReadPrerequisiteBoundaryContext): void {
  const principalBound = boundary.trusted_context.provider === "environment"
    ? Boolean(boundary.trusted_context.principal_env)
    : Boolean(boundary.trusted_context.principal_claim);
  if (!principalBound || !boundary.pack.resources.some((resource) =>
    resource.principal_key || resource.principal_scope || resource.rls_session?.principal_setting)) {
    throw new Error("Read current-state prerequisites require an existing reviewed trusted principal scope.");
  }
}

function reviewedPrerequisiteRlsSession(
  boundary: ReadPrerequisiteBoundaryContext,
): { tenant_setting?: string; principal_setting?: string } | undefined {
  const sessions = boundary.pack.resources
    .map((resource) => resource.rls_session)
    .filter((value): value is { tenant_setting?: string; principal_setting?: string } => Boolean(value));
  if (!sessions.length) return undefined;
  const merged: { tenant_setting?: string; principal_setting?: string } = {};
  // Shared reference resources may only bind the tenant. Compare each trusted
  // role independently rather than treating a missing principal as a conflict.
  for (const session of sessions) {
    for (const [role, value] of Object.entries(session)) {
      if (role !== "tenant_setting" && role !== "principal_setting") throw new Error("Read prerequisite RLS setting is unsupported.");
      if (value === undefined) continue;
      assertPrintable(value, `Read prerequisite ${role}`);
      if (merged[role] !== undefined && merged[role] !== value) {
        throw new Error(`Read current-state prerequisite cannot choose among conflicting reviewed RLS session bindings for ${role}. Review the trusted identity mapping before continuing.`);
      }
      merged[role] = value;
    }
  }
  assertRlsSettings(merged);
  return Object.keys(merged).length ? merged : undefined;
}

function assertUtcInstantColumns(engine: Engine, effectiveFrom: string, effectiveUntil: string): void {
  const normalize = (type: string) => type.trim().toLowerCase();
  const allowed = engine === "postgres"
    ? new Set(["timestamp with time zone", "timestamptz"])
    : new Set(["timestamp"]);
  if (!allowed.has(normalize(effectiveFrom)) || !allowed.has(normalize(effectiveUntil))) {
    throw new Error(engine === "postgres"
      ? "Read current-state prerequisite requires non-null PostgreSQL timestamp-with-time-zone interval columns."
      : "Read current-state prerequisite requires non-null MySQL TIMESTAMP interval columns; DATETIME is not supported without a separately reviewed UTC representation.");
  }
}

function isUtcInstantColumn(engine: Engine, type: string): boolean {
  const normalized = type.trim().toLowerCase();
  return engine === "postgres"
    ? normalized === "timestamp with time zone" || normalized === "timestamptz"
    : normalized === "timestamp";
}

function assertRlsSettings(settings: ReadCurrentStatePrerequisite["rls_session"]): void {
  for (const [kind, value] of Object.entries(settings ?? {})) {
    if (kind !== "tenant_setting" && kind !== "principal_setting") throw new Error("Read prerequisite RLS setting is unsupported.");
    assertPrintable(value, `Read prerequisite ${kind}`);
  }
  if (settings?.tenant_setting !== undefined && settings.tenant_setting === settings.principal_setting) {
    throw new Error("Read prerequisite tenant and principal require distinct RLS settings. Review the trusted identity mapping before continuing.");
  }
}

function requireColumn<T>(columns: Map<string, T>, name: string): T {
  const column = columns.get(name);
  if (!column) throw new Error(`Read current-state prerequisite inspected column ${name} is absent.`);
  return column;
}

function sameSet(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function assertPrintable(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 128 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be a bounded printable identifier or reviewed enum value.`);
  }
}

function assertDescription(value: string, label: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 1_000 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} must be bounded explicit review text.`);
  }
}

function assertOnlyKeys(value: object, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} contains unsupported key ${key}.`);
  }
}
