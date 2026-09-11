import { createHash } from "node:crypto";
import { isCompleteCollectionScopeExpression } from "@synapsor-runner/postgres";
import type { WriterProvisioningPlan } from "./writer-provisioning-types.js";

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

export type WriterPolicyRepair = { sql?: string; blockers: string[]; changes: string[] };

/** Closed scope grammar and full policy-drift checks; never infer business predicates. */
export function writerPolicyRepair(plan: WriterProvisioningPlan): WriterPolicyRepair {
  const blockers: string[] = [], changes: string[] = [], assertions: string[] = [], repairs: string[] = [];
  if (plan.engine !== "postgres" || !/^runner_writer_[a-f0-9]{12}$/u.test(plan.suggested_role)) {
    return { blockers: ["A reviewed dedicated PostgreSQL writer plan is required."], changes };
  }
  const role = plan.suggested_role;
  for (const relation of plan.relations.filter(relation => relation.rls_required)) {
    const settings = new Map(relation.row_scope?.map(item => [item.field, item.setting]));
    const fail = (reason: string) => blockers.push(`${relation.relation}: ${reason}`);
    if (!settings.size || settings.size > 2 || settings.size !== relation.row_scope?.length) {
      fail("Reviewed column-to-identity settings are unavailable or ambiguous; an administrator must map the existing policy. No predicate was guessed."); continue;
    }
    if (relation.row_security?.enabled !== true || relation.row_security.forced !== true) {
      fail("ENABLE and FORCE RLS must already be reviewed and enabled. Review that database change separately, then refresh this handoff."); continue;
    }
    const reads = relation.policies.filter(policy => policy.command === "SELECT");
    const uuidColumns = new Set(relation.native_uuid_scope_columns ?? []);
    // Earlier dedicated writers may have equivalent policies. Validate every
    // predicate against the same exact scope, not the number of reader roles.
    if (reads.length === 0 || relation.policies.some(policy => !policy.permissive
      || !["SELECT", "UPDATE", "INSERT"].includes(policy.command)
      || (policy.command !== "INSERT" && (!policy.using_expression || !isCompleteCollectionScopeExpression(policy.using_expression, settings, uuidColumns)))
      || (policy.command !== "SELECT" && (!policy.check_expression || !isCompleteCollectionScopeExpression(policy.check_expression, settings, uuidColumns))))) {
      fail("Existing policies are not one complete, simple reviewed identity scope. Preserve custom conditions, helper functions and restrictive policies; request a database-administrator repair instead."); continue;
    }
    if (relation.triggers.length || !relation.privileges.every(privilege => ["select", "update", "insert"].includes(privilege))) {
      fail("Triggers or unsupported privileges need a separate administrator review before generating a policy repair."); continue;
    }
    const table = `${identifier(relation.schema)}.${identifier(relation.table)}`;
    const policies = relation.policies.map(policy => ({ name: policy.name, command: policy.command, permissive: policy.permissive,
      roles: [...policy.roles].sort(), using_expression: policy.using_expression ?? null, check_expression: policy.check_expression ?? null }));
    assertions.push(
      ...[...uuidColumns].map(column => `IF NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE a.attrelid=${literal(table)}::regclass AND a.attname=${literal(column)} AND NOT a.attisdropped AND t.typname='uuid' AND n.nspname='pg_catalog') THEN RAISE EXCEPTION 'Reviewed UUID identity type changed: %', ${literal(`${relation.relation}.${column}`)}; END IF;`),
      `IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${literal(relation.schema)} AND c.relname=${literal(relation.table)} AND c.relkind='r' AND c.relrowsecurity AND c.relforcerowsecurity AND c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=${literal(role)})) THEN RAISE EXCEPTION 'Table ownership or forced row security changed: %', ${literal(relation.relation)}; END IF;`,
      `IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=${literal(table)}::regclass AND NOT tgisinternal) THEN RAISE EXCEPTION 'Unreviewed trigger: %', ${literal(relation.relation)}; END IF;`,
      `IF (SELECT coalesce(jsonb_agg(p ORDER BY p->>'name'), '[]'::jsonb) FROM (SELECT jsonb_build_object('name',policyname,'command',cmd,'permissive',permissive='PERMISSIVE','roles',(SELECT jsonb_agg(r ORDER BY r) FROM unnest(roles) r),'using_expression',qual,'check_expression',with_check) p FROM pg_policies WHERE schemaname=${literal(relation.schema)} AND tablename=${literal(relation.table)}) policies) <> (SELECT jsonb_agg(p ORDER BY p->>'name') FROM jsonb_array_elements(${literal(JSON.stringify(policies))}::jsonb) p) THEN RAISE EXCEPTION 'Policies changed after export: %. Refresh the administrator handoff.', ${literal(relation.relation)}; END IF;`,
    );
    const operations = ["SELECT", ...(relation.lock_column || relation.privileges.includes("update") ? ["UPDATE"] : []),
      ...(relation.privileges.includes("insert") ? ["INSERT"] : [])];
    for (const operation of operations) {
      if (relation.policies.some(policy => policy.command === operation && policy.roles.some(candidate => candidate === "public" || candidate === role))) continue;
      const name = `runner_scope_${createHash("sha256").update(`${role}:${relation.relation}:${operation}`).digest("hex").slice(0, 18)}`;
      const predicate = reads[0]!.using_expression!;
      repairs.push(`CREATE POLICY ${identifier(name)} ON ${table} FOR ${operation} TO ${identifier(role)}${operation === "INSERT" ? "" : ` USING (${predicate})`}${operation === "SELECT" ? "" : ` WITH CHECK (${predicate})`};`);
      changes.push(`${relation.relation}: add ${operation === "UPDATE" && !relation.privileges.includes("update") ? "private row-lock" : operation} policy for ${role}; preserve the reviewed ${settings.size === 1 ? "account" : "account and customer"} filter.`);
    }
  }
  if (blockers.length || !repairs.length) return { blockers, changes: blockers.length ? [] : changes };
  // Quote the entire body instead of using a fixed dollar delimiter: inspected
  // identifiers and policy names are untrusted and may themselves contain it.
  const checks = ["BEGIN",
    `IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=${literal(role)} AND NOT rolsuper AND NOT rolbypassrls AND NOT rolinherit AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication) OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=${literal(role)}) OR roleid=(SELECT oid FROM pg_roles WHERE rolname=${literal(role)})) THEN RAISE EXCEPTION 'Dedicated writer is missing, privileged or has role memberships; no changes made'; END IF;`,
    ...assertions, "END"].join("\n");
  return { blockers, changes, sql: [
    "-- ADMINISTRATOR REVIEW REQUIRED. Runner never runs this file.",
    "-- Apply grants.sql first, then this separate exact policy repair. No source records are changed.",
    "-- Adds policies ONLY for the dedicated writer; never alters existing policies or grants role membership.",
    "-- Verification-only identity-column grants exist for row locking, not agent permission to modify those fields.",
    "-- Reapplying a stale export fails closed. Refresh and review instead of dropping policies.",
    "\\set ON_ERROR_STOP on", "BEGIN;", "SET LOCAL standard_conforming_strings = on;", "SET LOCAL search_path = pg_catalog;", "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='30s';",
    `LOCK TABLE ${plan.relations.filter(relation => relation.rls_required).map(relation => `${identifier(relation.schema)}.${identifier(relation.table)}`).join(", ")} IN SHARE ROW EXCLUSIVE MODE;`,
    `DO ${literal(checks)};`, ...repairs, "COMMIT;", "",
    "-- Keep the reader credential unchanged. Rescan metadata, revalidate this saved job and recheck the writer.",
    "-- Execution authorization and worker startup remain separate. No request has been executed.", "",
  ].join("\n") };
}
