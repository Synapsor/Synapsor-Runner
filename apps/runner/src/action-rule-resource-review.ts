import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { actionRuleRelationshipPairs, type ActionRuleCatalogResourceV1 } from "@synapsor-runner/action-rules";
import { rolePostureFingerprint, schemaFingerprintForInspection, type SchemaInspection, type TableInfo } from "@synapsor-runner/schema-inspector";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { ActionRuleScalarTypeSpecV1 } from "@synapsor/spec";
import {
  actionRuleRelationshipsForTable, actionRuleTypeForColumn, buildActionRuleAuthoringCatalog, uniqueKey,
  type ActionRuleAuthoringCatalogV1, type BuiltActionRuleAuthoringCatalogV1,
} from "./action-rule-authoring.js";

export type PrivateActionSourceReview = {
  resource: string;
  parent_resource: string;
  relationship: string;
  proof_digest: `sha256:${string}`;
};

export type PreparePrivateActionSourceInput = {
  built: BuiltActionRuleAuthoringCatalogV1;
  boundary: ExplorationBoundaryDraft;
  inspection: SchemaInspection;
  resource: string;
  parentResource: string;
};

export type PreparedPrivateActionSource = {
  built: BuiltActionRuleAuthoringCatalogV1;
  review: PrivateActionSourceReview;
  /** Operator-only consent preview. The host must authorize metadata egress before exposing built to a model. */
  details: string[];
};

const MAX_PRIVATE_RESOURCES = 16;
const MAX_PRIVATE_FIELDS = 128;

function refuse(reason: string): never {
  throw new Error(`ACTION_RULE_PRIVATE_SOURCE_REVIEW_REQUIRED: ${reason} Read access, existing rules and source data are unchanged.`);
}

function exactTable(inspection: SchemaInspection, id: string): TableInfo {
  const matches = inspection.tables.filter(table => `${table.schema}.${table.name}` === id);
  if (matches.length !== 1 || matches[0]!.type !== "table") refuse(`${id} must identify one inspected base table.`);
  const table = matches[0]!;
  if (new Set(table.columns.map(column => column.name)).size !== table.columns.length) refuse(`${id} has duplicate field metadata.`);
  return table;
}

function portableRequiredField(table: TableInfo, name: string) {
  const column = table.columns.find(field => field.name === name);
  const type = column && actionRuleTypeForColumn(column);
  if (!column || column.nullable || !type) refuse(`${table.schema}.${table.name}.${name} needs an inspected non-null portable scalar type.`);
  return { name, type, nullable: false };
}

function displayType(type: ActionRuleScalarTypeSpecV1): string {
  switch (type.kind) {
    case "string": return `string(max_length=${type.max_length}${type.min_length === undefined ? "" : `, min_length=${type.min_length}`}, comparison=${type.comparison}${type.enum ? `, enum=${JSON.stringify(type.enum)}` : ""})`;
    case "integer": return `integer${type.unit ? `(unit=${JSON.stringify(type.unit)})` : ""}`;
    case "money_minor": return `money_minor(currency=${JSON.stringify(type.currency)})`;
    default: return type.kind;
  }
}

/** Pure preparation, not a review grant. The host binds inspection to its selected
 * generation-lock snapshot and obtains consent before sending this metadata. */
export function preparePrivateActionSource(input: PreparePrivateActionSourceInput): PreparedPrivateActionSource {
  const { built, boundary, inspection, resource, parentResource } = input;
  if (resource === parentResource || ![resource, parentResource].every(id => /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/u.test(id))) {
    refuse("Select distinct exact schema-qualified source and parent identifiers.");
  }
  if (built.catalog.generation_lock_fingerprint !== boundary.generation_lock_fingerprint
    || built.authoring.generation_lock_fingerprint !== boundary.generation_lock_fingerprint
    || built.authoring.read_boundary_name !== boundary.pack.name || built.authoring.source !== boundary.source
    || built.authoring.engine !== inspection.engine || rolePostureFingerprint(inspection) !== boundary.role_posture_fingerprint) {
    refuse("The catalog, Read revision and inspected source/role must have the same current review binding; rescan and revalidate changed metadata.");
  }
  if (boundary.pack.resources.some(candidate => candidate.id === resource)) refuse(`${resource} is already a public Read resource, not a new private source.`);
  const previous = built.catalog.resources.find(candidate => candidate.name === resource);
  if (previous && previous.verification_only !== true) refuse(`${resource} is already reviewed for Actions; its existing purpose cannot be replaced by private-source preparation.`);
  const parent = built.catalog.resources.find(candidate => candidate.name === parentResource);
  const parentAuthoring = built.authoring.resources.find(candidate => candidate.name === parentResource);
  if (!parent || !parentAuthoring || !parent.tenant_key || !parent.principal_scope_key
    || parent.tenant_key === parent.principal_scope_key || parent.source !== boundary.source || parent.engine !== inspection.engine
    || parentAuthoring.tenant_scope !== "direct" || parentAuthoring.principal_scope !== "direct"
    || parentAuthoring.tenant_key !== parent.tenant_key || parentAuthoring.principal_key !== parent.principal_scope_key) {
    refuse(`${parentResource} needs existing, directly reviewed tenant and principal guards in this Action catalog.`);
  }
  const parentRead = boundary.pack.resources.find(candidate => candidate.id === parentResource);
  if (parentRead && (parentRead.primary_key !== parent.primary_key || parentRead.tenant_key !== parent.tenant_key
    || parentRead.principal_key !== parent.principal_scope_key)) refuse(`${parentResource}'s current Read scope differs from the retained Action scope.`);
  const table = exactTable(inspection, resource), parentTable = exactTable(inspection, parentResource);
  if (new Set(table.foreign_keys.map(key => key.name)).size !== table.foreign_keys.length) refuse(`${resource} has ambiguous foreign key identifiers.`);
  if (parent.schema !== parentTable.schema || parent.table !== parentTable.name) refuse("The retained parent's physical table binding changed.");
  for (const key of new Set([parent.primary_key, parent.tenant_key, parent.principal_scope_key])) {
    const current = portableRequiredField(parentTable, key);
    if (canonicalJsonDigest(current) !== canonicalJsonDigest(parent.fields.find(field => field.name === key) ?? null)) {
      refuse(`${parentResource}.${key} no longer matches its reviewed guard metadata.`);
    }
  }
  if (!uniqueKey(parentTable, [parent.primary_key])) refuse(`${parentResource}'s reviewed scalar row identity is not proven unique.`);
  if (table.primary_key.length !== 1 || !uniqueKey(table, table.primary_key)) refuse(`${resource} requires one proven scalar primary key.`);
  const primaryKey = table.primary_key[0]!;
  portableRequiredField(table, primaryKey);
  const retainedPrivate = built.catalog.resources.filter(candidate => candidate.verification_only && candidate.name !== resource);
  if (retainedPrivate.length >= MAX_PRIVATE_RESOURCES
    || table.columns.length + retainedPrivate.reduce((total, candidate) => total + candidate.fields.length, 0) > MAX_PRIVATE_FIELDS) {
    refuse(`Private preparation is bounded to ${MAX_PRIVATE_RESOURCES} resources and ${MAX_PRIVATE_FIELDS} inspected fields; narrow the selected source.`);
  }

  const diagnostics: ActionRuleAuthoringCatalogV1["diagnostics"] = [];
  const relationships = actionRuleRelationshipsForTable(table, new Map([[resource, table], [parentResource, parentTable]]),
    new Set([resource, parentResource]), diagnostics);
  const candidates = relationships.filter(relationship => {
    const foreignKey = table.foreign_keys.find(key => key.name === relationship.name);
    const pairs = actionRuleRelationshipPairs(relationship);
    return relationship.to_resource === parentResource && foreignKey && !foreignKey.deferrable && !relationship.nullable && relationship.target_unique
      && pairs.some(pair => pair.target_field === parent.tenant_key)
      && pairs.some(pair => pair.target_field === parent.principal_scope_key)
      && pairs.every(pair => parentTable.columns.find(column => column.name === pair.target_field)?.nullable === false);
  });
  if (candidates.length !== 1) {
    refuse(candidates.length > 1
      ? `More than one complete immediate foreign key connects ${resource} to ${parentResource}'s reviewed tenant and principal; select an unambiguous source.`
      : `No complete, non-null, immediate exact foreign key proves both reviewed scopes from ${resource} to ${parentResource}. ${diagnostics.map(item => item.message).join(" ")}`);
  }
  const relationship = candidates[0]!, pairs = actionRuleRelationshipPairs(relationship);
  for (const pair of pairs) {
    portableRequiredField(table, pair.local_field);
    const current = portableRequiredField(parentTable, pair.target_field);
    if (canonicalJsonDigest(current) !== canonicalJsonDigest(parent.fields.find(field => field.name === pair.target_field) ?? null)) {
      refuse(`${parentResource}.${pair.target_field} is not an unchanged reviewed parent field.`);
    }
  }
  const existingRelationship = built.catalog.relationships.find(candidate => candidate.name === relationship.name);
  if (existingRelationship && canonicalJsonDigest(existingRelationship) !== canonicalJsonDigest(relationship)) {
    refuse(`Relationship name ${relationship.name} already identifies different reviewed proof.`);
  }
  if (previous && !existingRelationship) refuse(`${resource} is already private; its exact reviewed parent relationship must be retained, not replaced.`);
  const seed: ActionRuleCatalogResourceV1 = {
    name: resource, source: boundary.source, engine: parent.engine, schema: table.schema, table: table.name,
    primary_key: primaryKey, tenant_key: pairs.find(pair => pair.target_field === parent.tenant_key)!.local_field,
    principal_scope_key: pairs.find(pair => pair.target_field === parent.principal_scope_key)!.local_field,
    ...(previous?.version_field ? { version_field: previous.version_field } : {}),
    verification_only: true, fields: [],
  };
  const prepared = buildActionRuleAuthoringCatalog({ boundary, inspection,
    retainedCatalog: { ...built.catalog, resources: [...built.catalog.resources.filter(candidate => candidate.name !== resource), seed] } });
  const added = prepared.catalog.resources.find(candidate => candidate.name === resource)!;
  const addedAuthoring = prepared.authoring.resources.find(candidate => candidate.name === resource)!;
  if (previous && canonicalJsonDigest(previous) !== canonicalJsonDigest(added)) refuse(`${resource}'s previously reviewed private metadata changed; revalidate it before reuse.`);

  // Only the selected resource and its exact parent link join the closed catalog.
  const next = structuredClone(built);
  next.catalog.resources = [...next.catalog.resources.filter(candidate => candidate.name !== resource), added]
    .sort((a, b) => a.name.localeCompare(b.name));
  next.authoring.resources = [...next.authoring.resources.filter(candidate => candidate.name !== resource), addedAuthoring]
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!existingRelationship) next.catalog.relationships.push(structuredClone(relationship));
  next.catalog.relationships.sort((a, b) => a.name.localeCompare(b.name));
  next.authoring.relationships = structuredClone(next.catalog.relationships);
  next.authoring.diagnostics = [...next.authoring.diagnostics.filter(item => item.resource !== resource),
    ...prepared.authoring.diagnostics.filter(item => item.resource === resource && !item.relationship)];
  const { digest: _digest, ...material } = next.authoring;
  next.authoring.digest = canonicalJsonDigest(material);
  const proof = {
    generation_lock_fingerprint: boundary.generation_lock_fingerprint,
    read_boundary_digest: canonicalJsonDigest(boundary),
    schema_fingerprint: schemaFingerprintForInspection(inspection), role_posture_fingerprint: boundary.role_posture_fingerprint,
    parent_resource: parentResource, parent_primary_key: parent.primary_key,
    parent_tenant_key: parent.tenant_key, parent_principal_key: parent.principal_scope_key,
    resource: added, relationship, immediate: true,
  };
  const review: PrivateActionSourceReview = { resource, parent_resource: parentResource,
    relationship: relationship.name, proof_digest: canonicalJsonDigest(proof) };
  return { built: next, review, details: [
    `PRIVATE ACTION SOURCE PREPARATION: ${resource} via ${parentResource}`,
    "Operator-only metadata preview. Obtain the host's exact egress consent before returning this catalog to a model.",
    "",
    "Source and purpose",
    `Source: ${added.source}; engine: ${added.engine}; table: ${added.schema}.${added.table}`,
    `Primary key: ${JSON.stringify(added.primary_key)}; version: ${added.version_field ? JSON.stringify(added.version_field) : "none required for verification"}`,
    "verification_only=true; INSERT=false; UPDATE=false; all fields writable=false",
    "",
    "Reviewed scope proof",
    `Parent: ${parentResource}; primary key: ${JSON.stringify(parent.primary_key)}`,
    `Tenant: ${resource}.${added.tenant_key} -> ${parentResource}.${parent.tenant_key} (direct, non-null)`,
    `Principal: ${resource}.${added.principal_scope_key} -> ${parentResource}.${parent.principal_scope_key} (direct, non-null)`,
    `Exact inspected FK: ${JSON.stringify(relationship.name)}; immediate; complete target tuple unique; non-null; many_to_one`,
    ...pairs.map((pair, index) => `  Pair ${index + 1}: ${resource}.${JSON.stringify(pair.local_field)} -> ${parentResource}.${JSON.stringify(pair.target_field)}`),
    "Inverse access remains a bounded collection, not a one-row lookup.",
    "",
    "Private field metadata: field | type | nullability | purpose | writable",
    ...addedAuthoring.fields.map(field => `${JSON.stringify(field.name)} | ${displayType(field.type)} | ${field.nullable ? "nullable" : "NOT NULL"} | ${field.role} | false${field.enum_source ? ` | enum_source=${field.enum_source}` : ""}`),
    `Conflict candidates (not write permission): ${addedAuthoring.version_candidates.map(name => JSON.stringify(name)).join(", ") || "none"}`,
    ...next.authoring.diagnostics.filter(item => item.resource === resource).map(item => `Diagnostic ${item.code}: ${item.field ? `${JSON.stringify(item.field)}: ` : ""}${item.message}`),
    "",
    "Review fingerprints",
    `Proof: ${review.proof_digest}`,
    `Generation lock: ${proof.generation_lock_fingerprint}`,
    `Read boundary: ${proof.read_boundary_digest}`,
    `Inspected schema: ${proof.schema_fingerprint}`,
    `Role posture: ${proof.role_posture_fingerprint}`,
    `Resulting authoring catalog: ${next.authoring.digest}`,
    "",
    "No Read resource, query permission, existing rule or active authority changed. No I/O, source rows, SQL or runtime effect occurred.",
    "Read admission enforcement, collection/RLS readiness, writer access and execution require their separate checks.",
  ] };
}
