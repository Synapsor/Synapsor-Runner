import fs from "node:fs";
import path from "node:path";
import {
  canonicalJsonDigest,
} from "@synapsor-runner/protocol";
import {
  inspectDatabase,
  rolePostureFingerprint,
  schemaFingerprintForInspection,
  type SchemaInspection,
} from "@synapsor-runner/schema-inspector";
import mysql from "mysql2/promise";
import type {
  RuntimeCapabilityConfig,
  RuntimeConfig,
  GeneratedAuthorityLock,
  GeneratedAuthorityDependencies,
  GeneratedRelationshipDependency,
} from "./runtime-types.js";
import {
  localCapabilities,
} from "./capability-authority.js";
import {
  resolveRuntimeConfig,
} from "./runtime-config.js";
import {
  McpRuntimeError,
} from "./runtime-errors.js";
import {
  isRecord,
} from "./safe-values.js";

export const SUPPORTED_GENERATED_AUTHORITY_COMPILER_VERSIONS = new Set(["1.6.0", "1.6.3", "1.6.4", "1.6.6"]);
export const SUPPORTED_GENERATED_AUTHORITY_SPEC_VERSIONS = new Set(["1.5.0", "1.5.1", "1.6.0", "1.7.0", "1.8.0", "1.9.0"]);

/**
 * Generated protected reads remain executable only while the exact reviewed
 * generation lock, source schema, database role, grants, ownership, and RLS
 * posture are current. Legacy/manual configurations do not carry
 * generated_authority and return without database inspection.
 */
export async function preflightGeneratedAuthority(
  inputConfig: RuntimeConfig,
  env: NodeJS.ProcessEnv = process.env,
  inspect: typeof inspectDatabase = inspectDatabase,
): Promise<void> {
  const config = resolveRuntimeConfig(inputConfig);
  const protectedCapabilities = localCapabilities(config).filter((capability) => capability.protected_read);
  if (protectedCapabilities.length === 0) return;
  const lock = loadGeneratedAuthorityLock(config, protectedCapabilities);
  const inspection = await inspect({
    engine: lock.engine,
    databaseUrlEnv: lock.source_env,
    ...(lock.inspected_schema ? { schema: lock.inspected_schema } : {}),
    statementTimeoutMs: Math.min(...protectedCapabilities.map((capability) =>
      capability.protected_read!.limits.statement_timeout_ms)),
    env,
  });
  assertGeneratedAuthorityInspection(lock, inspection, protectedCapabilities, false);
}

/**
 * Revalidate only the dependencies used by one generated protected read
 * immediately before source execution. Modern dependency-aware locks let an
 * unrelated protected capability continue when another reviewed resource
 * drifts. Legacy locks retain conservative whole-schema validation.
 */
export async function preflightGeneratedCapabilityAuthority(
  inputConfig: RuntimeConfig,
  capability: RuntimeCapabilityConfig,
  env: NodeJS.ProcessEnv = process.env,
  inspect: typeof inspectDatabase = inspectDatabase,
): Promise<void> {
  if (!capability.protected_read) return;
  const config = resolveRuntimeConfig(inputConfig);
  const lock = loadGeneratedAuthorityLock(config, [capability]);
  const inspection = await inspect({
    engine: lock.engine,
    databaseUrlEnv: lock.source_env,
    ...(lock.inspected_schema ? { schema: lock.inspected_schema } : {}),
    statementTimeoutMs: capability.protected_read.limits.statement_timeout_ms,
    env,
  });
  assertGeneratedAuthorityInspection(lock, inspection, [capability], true);
}

function loadGeneratedAuthorityLock(
  config: RuntimeConfig,
  protectedCapabilities: RuntimeCapabilityConfig[],
): GeneratedAuthorityLock {
  const generatedAuthority = config.generated_authority;
  if (!generatedAuthority || generatedAuthority.enforcement !== "required") {
    throw new McpRuntimeError(
      "GENERATED_AUTHORITY_LOCK_REQUIRED",
      "Generated protected capabilities require generated_authority.enforcement=required and an exact generation lock path.",
    );
  }

  let lock: GeneratedAuthorityLock;
  try {
    lock = JSON.parse(fs.readFileSync(generatedAuthority.generation_lock_path, "utf8")) as GeneratedAuthorityLock;
  } catch (error) {
    throw new McpRuntimeError(
      "GENERATION_LOCK_UNAVAILABLE",
      `Unable to load the generated-authority lock${error instanceof SyntaxError ? " because it is not valid JSON" : ""}.`,
    );
  }
  assertGeneratedAuthorityLockShape(lock);
  if (lock.reporting_timezone !== generatedAuthority.reporting_timezone) {
    throw new McpRuntimeError(
      "GENERATION_LOCK_TIMEZONE_MISMATCH",
      "Generated protected authority no longer uses the reporting timezone captured by its generation lock.",
    );
  }
  const lockFingerprint = canonicalJsonDigest(lock);
  for (const capability of protectedCapabilities) {
    if (capability.protected_read!.generation_lock_fingerprint !== lockFingerprint) {
      throw new McpRuntimeError(
        "GENERATION_LOCK_DIGEST_MISMATCH",
        `Protected capability ${capability.name} is not bound to the exact configured generation lock.`,
      );
    }
    const source = config.sources?.[capability.source];
    if (!source || source.engine !== lock.engine || source.read_url_env !== lock.source_env) {
      throw new McpRuntimeError(
        "GENERATION_LOCK_SOURCE_MISMATCH",
        `Protected capability ${capability.name} no longer uses the source and read credential posture captured by its generation lock.`,
      );
    }
  }
  return lock;
}

function assertGeneratedAuthorityInspection(
  lock: GeneratedAuthorityLock,
  inspection: SchemaInspection,
  protectedCapabilities: RuntimeCapabilityConfig[],
  validateCapabilityDependencies: boolean,
): void {
  if (lock.authority_dependencies) {
    if (credentialPostureFingerprintForGeneratedAuthority(inspection)
      !== lock.authority_dependencies.credential_posture_fingerprint) {
      throw new McpRuntimeError(
        "GENERATED_AUTHORITY_DRIFT",
        "Generated protected authority is stale because the database credential posture changed. Rescan, review, and activate a new digest.",
      );
    }
    if (validateCapabilityDependencies) {
      for (const capability of protectedCapabilities) {
        assertProtectedCapabilityDependenciesCurrent(
          capability,
          lock.authority_dependencies,
          inspection,
        );
      }
    }
  } else {
    const schemaFingerprint = schemaFingerprintForInspection(inspection);
    const postureFingerprint = rolePostureFingerprint(inspection);
    const changes = [
      ...(schemaFingerprint !== lock.schema_fingerprint ? ["schema metadata"] : []),
      ...(postureFingerprint !== lock.role_posture_fingerprint ? ["database role, grants, ownership, or RLS posture"] : []),
    ];
    if (changes.length > 0) {
      throw new McpRuntimeError(
        "GENERATED_AUTHORITY_DRIFT",
        `Generated protected authority is stale because ${changes.join(" and ")} changed. Rescan, review the semantic diff, regenerate, and activate a new digest.`,
      );
    }
  }
  const role = inspection.role_posture;
  if (!role?.verified || !role.read_only || role.superuser !== false || role.bypass_rls !== false
    || role.writable_relations.length > 0 || role.owned_relations.length > 0) {
    throw new McpRuntimeError(
      "GENERATED_AUTHORITY_ROLE_UNSAFE",
      "Generated protected authority requires a verified non-owner, non-superuser, non-BYPASSRLS, demonstrably read-only database role.",
    );
  }
}

export function assertGeneratedAuthorityLockShape(value: GeneratedAuthorityLock): void {
  const digest = /^sha256:[a-f0-9]{64}$/;
  if (!value || value.schema_version !== "synapsor.generation-lock.v1"
    || !SUPPORTED_GENERATED_AUTHORITY_COMPILER_VERSIONS.has(value.compiler_version)
    || !SUPPORTED_GENERATED_AUTHORITY_SPEC_VERSIONS.has(value.spec_version)
    || (value.engine !== "postgres" && value.engine !== "mysql")
    || !/^[A-Z_][A-Z0-9_]*$/.test(value.source_env)
    || (value.inspected_schema !== undefined
      && (typeof value.inspected_schema !== "string" || !value.inspected_schema))
    || !digest.test(value.schema_fingerprint)
    || !digest.test(value.role_posture_fingerprint)
    || !digest.test(value.evidence_fingerprint)
    || !digest.test(value.generated_contract_digest)
    || !digest.test(value.reviewed_overrides_digest)
    || !Array.isArray(value.protected_authority)
    || value.protected_authority.some((item) => typeof item !== "string")
    || (value.reporting_timezone !== undefined && value.reporting_timezone !== "UTC")
    || (value.authority_dependencies !== undefined
      && !generatedAuthorityDependenciesValid(value.authority_dependencies, digest))) {
    throw new McpRuntimeError(
      "GENERATION_LOCK_INVALID",
      "The generated-authority lock is malformed or belongs to an unsupported compiler/spec version.",
    );
  }
}

export function generatedAuthorityDependenciesValid(
  value: GeneratedAuthorityDependencies,
  digest: RegExp,
): boolean {
  if (!value || value.schema_version !== "synapsor.authority-dependencies.v1"
    || !digest.test(value.credential_posture_fingerprint)
    || !isRecord(value.resources)
    || !isRecord(value.relationships)) {
    return false;
  }
  for (const dependency of Object.values(value.resources)) {
    if (!dependency
      || typeof dependency.schema !== "string"
      || typeof dependency.table !== "string"
      || !Array.isArray(dependency.fields)
      || dependency.fields.some((field) => typeof field !== "string")
      || !digest.test(dependency.fingerprint)) {
      return false;
    }
  }
  for (const dependency of Object.values(value.relationships)) {
    if (!dependency
      || typeof dependency.root_resource !== "string"
      || typeof dependency.relationship_id !== "string"
      || !Array.isArray(dependency.links)
      || dependency.links.length < 1
      || dependency.links.length > 2
      || !digest.test(dependency.proof_digest)
      || canonicalJsonDigest(dependency.links) !== dependency.proof_digest) {
      return false;
    }
  }
  return true;
}

export function credentialPostureFingerprintForGeneratedAuthority(
  inspection: SchemaInspection,
): `sha256:${string}` {
  const role = inspection.role_posture;
  return canonicalJsonDigest({
    engine: inspection.engine,
    current_user: inspection.current_user,
    role: role
      ? {
          verified: role.verified,
          superuser: role.superuser,
          bypass_rls: role.bypass_rls,
          read_only: role.read_only,
          writable_relations: [...role.writable_relations].sort(),
          owned_relations: [...role.owned_relations].sort(),
        }
      : null,
  });
}

export function assertProtectedCapabilityDependenciesCurrent(
  capability: RuntimeCapabilityConfig,
  dependencies: GeneratedAuthorityDependencies,
  inspection: SchemaInspection,
): void {
  const root = `${capability.target.schema}.${capability.target.table}`;
  const resourceIds = new Set([root]);
  const protectedRead = capability.protected_read!;
  const paths = [
    ...(protectedRead.relationship ? [{
      name: protectedRead.relationship.name,
      links: [{
        schema: protectedRead.relationship.schema,
        table: protectedRead.relationship.table,
        local_key: protectedRead.relationship.local_key,
        target_key: protectedRead.relationship.target_key,
        cardinality: protectedRead.relationship.cardinality,
        max_fan_out: protectedRead.relationship.max_fan_out,
      }],
    }] : []),
    ...(protectedRead.relationships ?? []).map((path) => ({
      name: path.name,
      links: path.links.map((link) => ({
        schema: link.schema,
        table: link.table,
        local_key: link.local_key,
        target_key: link.target_key,
        cardinality: link.cardinality,
        max_fan_out: link.max_fan_out,
      })),
    })),
  ];
  for (const path of paths) {
    const dependency = dependencies.relationships[`${root}::${path.name}`];
    if (!dependency
      || dependency.root_resource !== root
      || dependency.relationship_id !== path.name
      || path.links.length !== dependency.links.length) {
      throw generatedDependencyDrift(capability, `relationship ${path.name} is not bound to its generation-lock proof`);
    }
    let source = root;
    for (const [index, link] of path.links.entries()) {
      const expected = dependency.links[index]!;
      const target = `${link.schema}.${link.table}`;
      if (expected.source_resource !== source
        || expected.target_resource !== target
        || expected.source_columns.length !== 1
        || expected.source_columns[0] !== link.local_key
        || expected.target_columns.length !== 1
        || expected.target_columns[0] !== link.target_key
        || link.cardinality !== "many_to_one"
        || link.max_fan_out !== 1) {
        throw generatedDependencyDrift(capability, `relationship ${path.name} no longer matches its reviewed structural path`);
      }
      resourceIds.add(source);
      resourceIds.add(target);
      source = target;
    }
    if (relationshipDependencyFingerprintForGeneratedAuthority(dependency, inspection)
      !== dependency.proof_digest) {
      throw generatedDependencyDrift(capability, `relationship ${path.name} foreign-key or uniqueness proof changed`);
    }
  }
  for (const resourceId of resourceIds) {
    const dependency = dependencies.resources[resourceId];
    if (!dependency
      || resourceDependencyFingerprintForGeneratedAuthority(dependency, inspection)
        !== dependency.fingerprint) {
      throw generatedDependencyDrift(capability, `resource ${resourceId} authority-bearing schema or RLS metadata changed`);
    }
  }
}

export function generatedDependencyDrift(
  capability: RuntimeCapabilityConfig,
  reason: string,
): McpRuntimeError {
  return new McpRuntimeError(
    "GENERATED_AUTHORITY_DRIFT",
    `Generated protected capability ${capability.name} is stale because ${reason}. Rescan, review, and activate a new digest.`,
  );
}

export function resourceDependencyFingerprintForGeneratedAuthority(
  dependency: GeneratedAuthorityDependencies["resources"][string],
  inspection: SchemaInspection,
): `sha256:${string}` | undefined {
  const table = inspection.tables.find((candidate) =>
    candidate.schema === dependency.schema && candidate.name === dependency.table);
  if (!table) return undefined;
  const columns = new Map(table.columns.map((column) => [column.name, column]));
  const selectedColumns = dependency.fields.map((name) => {
    const column = columns.get(name);
    if (!column) return undefined;
    return {
      name: column.name,
      data_type: column.data_type,
      nullable: column.nullable,
      default: column.default ?? null,
      generated: column.generated,
      identity: column.identity ?? false,
      enum_values: [...(column.enum_values ?? [])].sort(),
    };
  });
  if (selectedColumns.some((column) => !column)) return undefined;
  return canonicalJsonDigest({
    engine: inspection.engine,
    schema: table.schema,
    table: table.name,
    type: table.type,
    primary_key: [...table.primary_key],
    columns: selectedColumns,
    row_level_security: table.row_level_security ?? "unknown",
    row_level_security_policies: [...(table.row_level_security_policies ?? [])]
      .map((policy) => ({
        name: policy.name,
        command: policy.command,
        permissive: policy.permissive,
        roles: [...policy.roles].sort(),
        using_expression: policy.using_expression ?? null,
        check_expression: policy.check_expression ?? null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    role_posture: table.role_posture
      ? {
          owner: table.role_posture.owner,
          current_role_is_owner: table.role_posture.current_role_is_owner,
          current_role_can_assume_owner: table.role_posture.current_role_can_assume_owner,
          privileges: table.role_posture.privileges,
          row_security_forced: table.role_posture.row_security_forced,
          row_security_effective_for_current_role: table.role_posture.row_security_effective_for_current_role,
        }
      : null,
  });
}

export function relationshipDependencyFingerprintForGeneratedAuthority(
  dependency: GeneratedRelationshipDependency,
  inspection: SchemaInspection,
): `sha256:${string}` | undefined {
  const tables = new Map(inspection.tables.map((table) => [`${table.schema}.${table.name}`, table]));
  const links: GeneratedRelationshipDependency["links"] = [];
  for (const expected of dependency.links) {
    const source = tables.get(expected.source_resource);
    const target = tables.get(expected.target_resource);
    if (!source || !target) return undefined;
    const foreignKey = source.foreign_keys.find((candidate) =>
      candidate.name === expected.constraint_name
      && candidate.referenced_schema === target.schema
      && candidate.referenced_table === target.name
      && sameGeneratedColumns(candidate.columns, expected.source_columns)
      && sameGeneratedColumns(candidate.referenced_columns, expected.target_columns));
    if (!foreignKey) return undefined;
    const uniqueness = generatedRelationshipTargetUniqueness(target, expected.target_columns);
    if (!uniqueness
      || uniqueness.kind !== expected.target_uniqueness.kind
      || uniqueness.name !== expected.target_uniqueness.name
      || !sameGeneratedColumns(uniqueness.columns, expected.target_uniqueness.columns)) {
      return undefined;
    }
    links.push({
      constraint_name: foreignKey.name,
      source_resource: expected.source_resource,
      target_resource: expected.target_resource,
      source_columns: [...foreignKey.columns],
      target_columns: [...foreignKey.referenced_columns],
      target_uniqueness: uniqueness,
      nullable: foreignKey.columns.some((name) =>
        source.columns.find((column) => column.name === name)?.nullable !== false),
      cardinality: "many_to_one",
      max_fan_out: 1,
    });
  }
  return canonicalJsonDigest(links);
}

export function generatedRelationshipTargetUniqueness(
  target: SchemaInspection["tables"][number],
  columns: string[],
): GeneratedRelationshipDependency["links"][number]["target_uniqueness"] | undefined {
  const same = (candidate: string[]) => sameGeneratedColumns(candidate, columns);
  if (same(target.primary_key)) {
    const named = target.unique_constraints.find((constraint) => same(constraint.columns))
      ?? target.indexes.find((index) => index.unique === true && same(index.columns ?? []));
    return {
      kind: "primary_key",
      name: named?.name ?? `${target.schema}.${target.name}.primary_key`,
      columns: [...columns],
    };
  }
  const constraint = target.unique_constraints.find((candidate) => same(candidate.columns));
  if (constraint) return { kind: "unique_constraint", name: constraint.name, columns: [...columns] };
  const index = target.indexes.find((candidate) => candidate.unique === true && same(candidate.columns ?? []));
  return index ? { kind: "unique_index", name: index.name, columns: [...columns] } : undefined;
}

export function sameGeneratedColumns(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
