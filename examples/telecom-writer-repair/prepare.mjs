import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

// This is a recipe for the shipped telecom fixture, not a policy inference engine.
const [handoff, output, option] = process.argv.slice(2);
if (!handoff || !output || (option !== undefined && option !== "--fresh-role") || process.argv.length > 5) {
  throw new Error("Usage: node prepare.mjs <writer-handoff-directory> <new-provisioning.sql> [--fresh-role]");
}
const plan = JSON.parse(await fs.readFile(path.join(handoff, "requirements.json"), "utf8"));
const grants = await fs.readFile(path.join(handoff, "grants.sql"), "utf8");
const fields = ["base_monthly_cents", "data_policy", "effective_from", "included_lines", "international_day_pass", "plan_code", "plan_display_name", "version"];
const subscriptions = plan.relations?.find((relation) => relation.relation === "telecom.subscriptions");
const offers = plan.relations?.find((relation) => relation.relation === "telecom.plan_change_offers");
const consumesOffer = JSON.stringify([...(offers?.update_columns ?? [])].sort()) === '["status","version"]';
const offersAllowed = consumesOffer
  ? JSON.stringify([...(offers?.privileges ?? [])].sort()) === '["select","update"]'
  : JSON.stringify(offers?.privileges) === '["select"]' && offers?.update_columns?.length === 0;
if (plan.version !== 1 || plan.engine !== "postgres" || !/^sha256:[a-f0-9]{64}$/u.test(plan.action_digest)
  || !/^runner_writer_[a-f0-9]{12}$/u.test(plan.suggested_role) || plan.relations?.length !== 2
  || !subscriptions || !offers || subscriptions.schema !== "telecom" || subscriptions.table !== "subscriptions"
  || offers.schema !== "telecom" || offers.table !== "plan_change_offers"
  || JSON.stringify([...subscriptions.update_columns].sort()) !== JSON.stringify(fields)
  || JSON.stringify([...subscriptions.privileges].sort()) !== '["select","update"]'
  || !offersAllowed
  || subscriptions.lock_column !== "subscription_id" || offers.lock_column !== "plan_offer_id"
  || !subscriptions.rls_required || !offers.rls_required || subscriptions.triggers.length || offers.triggers.length) {
  throw new Error("This is not the supported two-relation offered-plan effect. Keep its authority unchanged; an administrator must review a different writer plan.");
}
const literal = (value) => "'" + value.replaceAll("'", "''") + "'";
// An explicit retry creates another new role, never alters an existing attempt.
const role = option === "--fresh-role" ? `runner_writer_${randomBytes(6).toString("hex")}` : plan.suggested_role;
const helperBody = (management) => `SELECT EXISTS (SELECT 1 FROM telecom.account_memberships m
 WHERE m.account_id = p_account_id AND m.principal_id = p_principal_id AND m.status = 'active'
 ${management ? "AND m.membership_role IN ('owner', 'manager')" : ""})`;
const compact = (value) => value.replace(/\s+/gu, "");
const helpers = [["is_active_member", false], ["can_manage_account", true]];
const assertions = [
  "LOCK TABLE telecom.subscriptions, telecom.plan_change_offers IN SHARE ROW EXCLUSIVE MODE;",
  "DO $fixture_review$ BEGIN",
  ...[subscriptions, offers].flatMap((relation) => {
    const policies = relation.policies.map((policy) => ({ name: policy.name, command: policy.command, permissive: policy.permissive,
      roles: [...policy.roles].sort(), using_expression: policy.using_expression ?? null, check_expression: policy.check_expression ?? null }));
    return [
      `IF NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='telecom' AND c.relname=${literal(relation.table)} AND c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='telecom_owner') THEN RAISE EXCEPTION 'Fixture ownership or forced RLS differs; no changes made'; END IF;`,
      `IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid=${literal(relation.relation)}::regclass AND NOT tgisinternal) THEN RAISE EXCEPTION 'Fixture has unreviewed triggers; no changes made'; END IF;`,
      `IF (SELECT coalesce(jsonb_agg(p ORDER BY p->>'name'), '[]'::jsonb) FROM (SELECT jsonb_build_object('name',policyname,'command',cmd,'permissive',permissive='PERMISSIVE','roles',(SELECT jsonb_agg(r ORDER BY r) FROM unnest(roles) r),'using_expression',qual,'check_expression',with_check) p FROM pg_policies WHERE schemaname='telecom' AND tablename=${literal(relation.table)}) policies) <> (SELECT jsonb_agg(p ORDER BY p->>'name') FROM jsonb_array_elements(${literal(JSON.stringify(policies))}::jsonb) p) THEN RAISE EXCEPTION 'Fixture policies changed after export; inspect again'; END IF;`,
      `IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='telecom' AND tablename=${literal(relation.table)} AND cmd IN ('ALL','UPDATE') AND 'public'=ANY(roles) AND permissive='PERMISSIVE') THEN RAISE EXCEPTION 'Public write policy needs administrator review; no changes made'; END IF;`,
    ];
  }),
  ...helpers.map(([name, management]) => `IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid='telecom.${name}(uuid,uuid)'::regprocedure AND l.lanname='sql' AND p.prosecdef AND p.provolatile='s' AND pg_get_userbyid(p.proowner)='telecom_policy' AND p.proconfig=ARRAY['search_path=pg_catalog, telecom'] AND regexp_replace(p.prosrc, '[[:space:]]', '', 'g')=${literal(compact(helperBody(management)))}) THEN RAISE EXCEPTION 'Reviewed fixture helper differs; no changes made'; END IF;`),
  "END $fixture_review$;",
];
const scope = "account_id = nullif(current_setting('synapsor.tenant_id', true), '')::uuid AND telecom.can_manage_account(account_id, nullif(current_setting('synapsor.principal', true), '')::uuid)";
const repair = [
  ...helpers.map(([name]) => `GRANT EXECUTE ON FUNCTION telecom.${name}(uuid, uuid) TO "${role}";`),
  ...[subscriptions, offers].map((relation) => `CREATE POLICY "${role}_update" ON "telecom"."${relation.table}" FOR UPDATE TO "${role}" USING (${scope}) WITH CHECK (${scope});`),
];
// Never consume arbitrary statements from the exported grants file. Rebuild the
// small, allowlisted fixture grant set and compare it with the reviewed export.
const grantStatements = (role) => [
  `GRANT USAGE ON SCHEMA "telecom" TO "${role}";`,
  `GRANT SELECT ON TABLE "telecom"."subscriptions" TO "${role}";`,
  `GRANT UPDATE (${fields.map((field) => `"${field}"`).join(", ")}) ON TABLE "telecom"."subscriptions" TO "${role}";`,
  `GRANT SELECT ON TABLE "telecom"."plan_change_offers" TO "${role}";`,
  `GRANT UPDATE (${consumesOffer ? '"status", "version"' : '"plan_offer_id"'}) ON TABLE "telecom"."plan_change_offers" TO "${role}";`,
];
if (grantStatements(plan.suggested_role).some((line) => !grants.split("\n").includes(line))) throw new Error("Reviewed grant export does not match the fixture plan; export again.");
const sql = [
  "-- TELECOM FIXTURE ONLY. Administrator review and explicit psql execution required.",
  "-- No password, shared-role mutation, source row change, or execution activation.",
  "-- New RLS policies change the reviewed schema. Revalidate saved Read/Action dependencies afterward.",
  "\\set ON_ERROR_STOP on", "BEGIN;", "SET LOCAL lock_timeout='5s';", "SET LOCAL statement_timeout='30s';", ...assertions,
  `CREATE ROLE "${role}" NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;`,
  `DO $connect$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '${role}'); END $connect$;`,
  ...grantStatements(role), ...repair,
  `ALTER ROLE "${role}" SET statement_timeout='5s';`, `ALTER ROLE "${role}" SET lock_timeout='2s';`, "COMMIT;", "",
  `-- Authentication remains separate: use psql's \\password ${role} interactively, then ALTER ROLE "${role}" LOGIN;`,
  "-- Configure the new writer URL privately. Resume start with --rescan in the SAME project; revalidate the saved job, review its authority, then recheck execution.",
  "-- Start a worker only after separate execution confirmation. A receipt, not approval alone, proves completion.", "",
].join("\n");
await fs.writeFile(output, sql, { flag: "wx", mode: 0o600 });
process.stdout.write(`Reviewable fixture repair saved: ${path.resolve(output)}\nDedicated role: ${role}\nNo database connection or command was executed.\n`);
