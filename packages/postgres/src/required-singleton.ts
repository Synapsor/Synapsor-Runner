import { ActionRuleError, actionRuleRelationshipPairs, type CompiledRuleBindingV1 } from "@synapsor-runner/action-rules";
import type { PostgresApplyClient } from "./index.js";
import { canonicalJsonDigest, postgresColumnDeclarationExpression, postgresNativeDeclarationSupportedExpression, postgresRequiredSingletonProofExpression } from "@synapsor-runner/protocol";

/** Finite PG catalogue check. This proves keys, never scope meaning or row existence. */
export async function assertPostgresRequiredSingletonRelationship(client: PostgresApplyClient,
  binding: CompiledRuleBindingV1, parent: CompiledRuleBindingV1,
  mode: "proposal_snapshot" | "transaction_reverify" | undefined): Promise<void> {
  const reject = (): never => { throw new ActionRuleError("ACTION_RULE_SCOPE_UNPROVEN",
    "The required private witness's current key, relationship or protected reader/writer prerequisites could not be established. Review the source configuration; no private facts are disclosed."); };
  try {
  const relationship = binding.relationship, proof = relationship?.required_singleton_proof;
  const source = binding.verification.source, purpose = binding.resource.private_evidence;
  if (!relationship || !proof || source.kind !== "relationship" || source.direction !== "inverse"
    || mode === undefined || purpose?.mode !== "required_scoped_singleton"
    || purpose.parent_resource !== parent.resource.name || purpose.relationship !== relationship.name
    || binding.verification.cardinality !== "one" || parent.verification.cardinality !== "one"
    || binding.verification.collection_consistency || binding.verification.scope.mode !== "columns"
    || parent.verification.scope.mode !== "columns" || !binding.verification.scope.principal_field
    || !parent.verification.scope.principal_field || actionRuleRelationshipPairs(relationship).length !== 1) return reject();
  if (mode === "transaction_reverify") {
    const isolation = await client.query("SHOW transaction_isolation");
    if (isolation.rows[0]?.transaction_isolation !== "read committed") reject();
    // Empty locking reads retain ROW SHARE relation locks; conflicting key,
    // column and policy DDL cannot pass those locks. Native RI state is checked
    // below; this is not a claim that every catalogue update is excluded. The
    // ordinary loader then locks the actual parent and witness rows through commit.
    // They require the reviewed narrow column UPDATE privilege, never a grant here.
    const quote = (name: string) => `"${name.replace(/"/gu, '""')}"`;
    for (const resource of [parent.resource, binding.resource]) {
      try { await client.query(`SELECT ${quote(resource.primary_key)} FROM ONLY ${quote(resource.schema)}.${quote(resource.table)} WHERE FALSE FOR UPDATE`); }
      catch { reject(); }
    }
  }
  // Deparsed native defaults/checks must have the same qualified spelling for
  // the reader and writer. Keep this setting transaction-local and restore it;
  // neither role defaults nor subsequent source operations are rewritten.
  const previousPath = await client.query("SHOW search_path");
  if (typeof previousPath.rows[0]?.search_path !== "string") return reject();
  await client.query("SELECT pg_catalog.set_config('search_path', 'pg_catalog', true)");
  try {
  for (const [candidate, side] of [[parent, "parent"], [binding, "witness"]] as const) {
    const names = candidate.verification.fields.map(field => field.name);
    const declarations = purpose.column_declarations[side];
    if (!declarations || names.some(name => !declarations[name])) return reject();
    const current = await client.query(`SELECT a.attname AS name, ${postgresColumnDeclarationExpression} AS declaration,
      ${postgresNativeDeclarationSupportedExpression} AS supported_type
      FROM pg_catalog.pg_class r JOIN pg_catalog.pg_namespace n ON n.oid=r.relnamespace
      JOIN pg_catalog.pg_attribute a ON a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped
      JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
      WHERE n.nspname=$1 AND r.relname=$2 AND a.attname=ANY($3::text[]) ORDER BY a.attname`,
      [candidate.resource.schema, candidate.resource.table, names]);
    if (current.rows.length !== names.length || new Set(current.rows.map(row => row.name)).size !== names.length
      || current.rows.some(row => row.supported_type !== true || typeof row.name !== "string" || !declarations[row.name]
        || canonicalJsonDigest(row.declaration) !== declarations[row.name])) return reject();
  }
  // The very same finite publisher is evaluated again, after relation locks.
  // Compare its complete proof, not just the schema builder's input or names.
  const rows = await client.query(`SELECT source_attr.attname AS local_field, target_attr.attname AS target_field,
    ${postgresRequiredSingletonProofExpression} AS required_singleton_proof,
    (NOT actor_role.rolsuper AND NOT actor_role.rolbypassrls
      AND NOT pg_catalog.pg_has_role(current_user,source.relowner,'MEMBER')
      AND NOT pg_catalog.pg_has_role(current_user,target.relowner,'MEMBER')
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_index x ON x.indexrelid=k.conindid
        JOIN pg_catalog.pg_attribute a ON a.attrelid=source.oid AND a.attnum=k.conkey[1]
        JOIN pg_catalog.pg_opclass opclass ON opclass.oid=x.indclass[0]
        JOIN pg_catalog.pg_am access ON access.oid=opclass.opcmethod
        WHERE k.conrelid=source.oid AND k.contype='p' AND cardinality(k.conkey)=1 AND a.attname=$6
          AND a.attnotnull AND NOT a.attisdropped AND k.convalidated AND NOT k.condeferrable
          AND COALESCE((to_jsonb(k)->>'conenforced')::boolean,current_setting('server_version_num')::integer BETWEEN 130000 AND 179999)
          AND x.indisunique AND x.indisvalid AND x.indisready AND x.indimmediate AND x.indislive
          AND x.indnkeyatts=1 AND x.indnatts=1 AND x.indpred IS NULL AND x.indexprs IS NULL
          AND x.indrelid=source.oid AND x.indkey[0]=a.attnum
          AND access.amname='btree' AND opclass.opcnamespace='pg_catalog'::regnamespace AND opclass.opcdefault
          AND opclass.opcintype=CASE WHEN a.atttypid='varchar'::regtype THEN 'text'::regtype ELSE a.atttypid END)
      AND EXISTS(SELECT 1 FROM pg_catalog.pg_constraint k JOIN pg_catalog.pg_index x ON x.indexrelid=k.conindid
        JOIN pg_catalog.pg_attribute a ON a.attrelid=target.oid AND a.attnum=k.conkey[1]
        JOIN pg_catalog.pg_opclass opclass ON opclass.oid=x.indclass[0]
        JOIN pg_catalog.pg_am access ON access.oid=opclass.opcmethod
        WHERE k.conrelid=target.oid AND k.contype='p' AND cardinality(k.conkey)=1 AND a.attname=$7
          AND a.attnotnull AND NOT a.attisdropped AND k.convalidated AND NOT k.condeferrable
          AND COALESCE((to_jsonb(k)->>'conenforced')::boolean,current_setting('server_version_num')::integer BETWEEN 130000 AND 179999)
          AND x.indisunique AND x.indisvalid AND x.indisready AND x.indimmediate AND x.indislive
          AND x.indnkeyatts=1 AND x.indnatts=1 AND x.indpred IS NULL AND x.indexprs IS NULL
          AND x.indrelid=target.oid AND x.indkey[0]=a.attnum
          AND access.amname='btree' AND opclass.opcnamespace='pg_catalog'::regnamespace AND opclass.opcdefault
          AND opclass.opcintype=CASE WHEN a.atttypid='varchar'::regtype THEN 'text'::regtype ELSE a.atttypid END)) AS usable
    FROM pg_catalog.pg_constraint con
    CROSS JOIN pg_catalog.pg_roles actor_role
    JOIN pg_catalog.pg_class source ON source.oid=con.conrelid
    JOIN pg_catalog.pg_namespace sn ON sn.oid=source.relnamespace
    JOIN pg_catalog.pg_class target ON target.oid=con.confrelid
    JOIN pg_catalog.pg_namespace dn ON dn.oid=target.relnamespace
    JOIN pg_catalog.pg_attribute source_attr ON source_attr.attrelid=source.oid AND source_attr.attnum=con.conkey[1] AND NOT source_attr.attisdropped
    JOIN pg_catalog.pg_attribute target_attr ON target_attr.attrelid=target.oid AND target_attr.attnum=con.confkey[1] AND NOT target_attr.attisdropped
    WHERE actor_role.rolname=current_user AND con.contype='f' AND con.conname=$1
      AND sn.nspname=$2 AND source.relname=$3 AND dn.nspname=$4 AND target.relname=$5
    LIMIT 2`, [relationship.name, binding.resource.schema, binding.resource.table, parent.resource.schema, parent.resource.table,
    binding.resource.primary_key, parent.resource.primary_key]);
  const pair = actionRuleRelationshipPairs(relationship)[0]!;
  if (rows.rows.length !== 1 || rows.rows[0]!.usable !== true
    || canonicalJsonDigest(rows.rows[0]!.required_singleton_proof ?? null) !== canonicalJsonDigest(proof)
    || rows.rows[0]!.local_field !== pair.local_field
    || rows.rows[0]!.target_field !== pair.target_field) reject();
  } finally {
    await client.query("SELECT pg_catalog.set_config('search_path', $1, true)", [previousPath.rows[0].search_path]);
  }
  } catch { reject(); }
}
