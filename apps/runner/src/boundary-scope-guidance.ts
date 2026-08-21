import type {
  BoundaryInference,
  DerivedScopeInference,
  SharedReferenceScopeInference,
  SingleOrganizationScope,
} from "./auto-boundary.js";

type ScopeRelationship = {
  name: string;
  columns: string[];
  referenced_resource: string;
  referenced_columns: string[];
  nullable: boolean;
  cardinality_proven: boolean;
};

export type BlockedTenantScopeInput = {
  id?: string;
  resource_id?: string;
  organization_scope?: SingleOrganizationScope;
  tenant_key: BoundaryInference<string>;
  derived_tenant_scope?: DerivedScopeInference;
  shared_reference_scope?: SharedReferenceScopeInference;
  relationships: ScopeRelationship[];
};

export type BlockedTenantScopeGuidance = {
  why: string[];
  remediation: string[];
};

export function blockedTenantScopeGuidance(
  input: BlockedTenantScopeInput,
): BlockedTenantScopeGuidance | undefined {
  if (input.organization_scope?.mode === "single_organization") return undefined;
  if (input.tenant_key.selected
    || input.tenant_key.candidates.length > 0
    || input.derived_tenant_scope?.selected
    || (input.derived_tenant_scope?.candidates.length ?? 0) > 0
    || input.shared_reference_scope?.eligible) {
    return undefined;
  }
  const resourceId = input.resource_id ?? input.id ?? "this table";
  const why = [
    "Direct tenant scope unavailable: no trusted tenant column was found.",
  ];
  const tenantRelationshipBlockers = new Map<string, string>();
  for (const blocker of input.shared_reference_scope?.blockers ?? []) {
    const match = /^relationship (.+) reaches tenant-scoped resource (.+)$/.exec(blocker);
    if (match) tenantRelationshipBlockers.set(match[1]!, match[2]!);
  }
  const nullableTenantRelationships = input.relationships.filter((relationship) =>
    relationship.nullable
    && relationship.cardinality_proven
    && tenantRelationshipBlockers.get(relationship.name) === relationship.referenced_resource);
  if (nullableTenantRelationships.length) {
    for (const relationship of nullableTenantRelationships) {
      why.push(
        `Derived tenant scope unavailable: ${relationship.columns.join(", ")} -> `
          + `${relationship.referenced_resource}.${relationship.referenced_columns.join(", ")} is nullable, `
          + "so some rows can have no owning tenant.",
      );
    }
  } else {
    why.push(
      "Derived tenant scope unavailable: no NOT NULL many-to-one foreign-key path reaches a tenant-scoped table.",
    );
  }
  for (const blocker of input.shared_reference_scope?.blockers ?? []) {
    why.push(`Shared reference unavailable: ${sentence(blocker)}`);
  }

  const remediation = [
    `Add and populate a trusted tenant column on ${resourceId}, then rescan.`,
  ];
  if (nullableTenantRelationships.length) {
    for (const relationship of nullableTenantRelationships) {
      remediation.push(
        `If every row must belong to ${relationship.referenced_resource}, make `
          + `${resourceId}.${relationship.columns.join(", ")} NOT NULL, then rescan.`,
      );
    }
  } else {
    remediation.push(
      "Add a NOT NULL many-to-one foreign-key path to a tenant-scoped table, then rescan.",
    );
  }
  if ((input.shared_reference_scope?.blockers.length ?? 0) > 0) {
    remediation.push(
      "Shared reference is not a valid workaround while this table relates to tenant-scoped data.",
    );
  }
  remediation.push("Runner will not change the database schema for you.");
  return {
    why: unique(why),
    remediation: unique(remediation),
  };
}

function sentence(value: string): string {
  const trimmed = value.trim().replace(/[.]+$/, "");
  return `${trimmed}.`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
