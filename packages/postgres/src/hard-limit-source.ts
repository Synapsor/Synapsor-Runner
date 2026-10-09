import { randomBytes } from 'node:crypto';
import { ActionRuleError, actionRuleRelationshipPairs, type CompiledRuleBindingV1, type CompiledActionRuleV1 } from '@synapsor-runner/action-rules';
import { isCompleteCollectionScopeExpression } from './complete-collection-scope.js';
import type { PostgresApplyClient, PostgresActionRuleRlsScope } from './index.js';

type HardLimitScopeSettings = Pick<PostgresActionRuleRlsScope, 'tenantSetting' | 'principalSetting'>;
type Receipt = { table: string; provisioning: 'precreated' | 'auto_migrate' };
const receiptSearchPaths = new WeakMap<PostgresApplyClient, string>();
const receiptNames = new WeakMap<PostgresApplyClient, string>();
export function hardLimitReceiptTable(client: PostgresApplyClient, fallback: string): string { return receiptNames.get(client) ?? fallback; }
const qualified = new WeakMap<PostgresApplyClient, Set<string>>();
export function resetHardLimitQualification(client: PostgresApplyClient): void { qualified.delete(client); receiptNames.delete(client); receiptSearchPaths.delete(client); }
const quote = (value: string) => '"' + value.replaceAll('"', '""') + '"';
type SourceDiagnosticStage =
  'namespace_engine_session'
  | 'namespace_acl'
  | 'namespace_lock'
  | 'namespace_lock_evidence'
  | 'receipt_resolution'
  | 'scope_receipt_mode'
  | 'engine_session'
  | 'binding_inventory'
  | 'business_relation'
  | 'receipt_relation'
  | 'foreign_keys'
  | 'internal_triggers'
  | 'column_inventory'
  | 'column_native_profile'
  | 'column_collation'
  | 'business_column_shape'
  | 'integer_column'
  | 'string_column'
  | 'column_kind'
  | 'receipt_column_shape'
  | 'receipt_created_default'
  | 'receipt_column_default'
  | 'business_column_inventory'
  | 'receipt_column_inventory'
  | 'opaque_effects'
  | 'policy_scope'
  | 'policy_settings'
  | 'policy_inventory'
  | 'policy_command'
  | 'policy_using'
  | 'policy_check'
  | 'search_path'
  | 'relation_profile';
type SourceDiagnosticOrigin = 'source.hard_limit' | 'source.receipt_read';
type SourceDiagnosticPath = `${SourceDiagnosticOrigin}.${SourceDiagnosticStage}`;
function unsupported(path: SourceDiagnosticPath): never { throw new ActionRuleError('ACTION_RULE_SCOPE_UNPROVEN', 'Native Source effects cannot be inspected with the supported guarantees.', path); }

/** Protect namespace catalog identity for the same Source transaction. Existing
 * privilege only; callers cannot attest this lock or request a wider grant. */
export async function protectPostgresHardLimitNames(client: PostgresApplyClient): Promise<void> {
  const engine = await client.query("SELECT pg_catalog.current_setting('server_version_num')::pg_catalog.int4 AS version,pg_catalog.current_setting('transaction_isolation') AS isolation,pg_catalog.current_setting('session_replication_role') AS replication_role");
  if (Number(engine.rows[0]?.version) < 170000 || Number(engine.rows[0]?.version) >= 180000 || engine.rows[0]?.isolation !== 'read committed' || engine.rows[0]?.replication_role !== 'origin') unsupported('source.hard_limit.namespace_engine_session');
  const held = await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
    WHERE pid=pg_catalog.pg_backend_pid() AND relation='pg_catalog.pg_namespace'::pg_catalog.regclass
      AND granted AND mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')) AS held`);
  if (held.rows[0]?.held === true) return;
  const privilege = await client.query("SELECT pg_catalog.has_table_privilege(current_user,'pg_catalog.pg_namespace','MAINTAIN,UPDATE,DELETE,TRUNCATE') AS permitted");
  if (privilege.rows[0]?.permitted !== true) unsupported('source.hard_limit.namespace_acl');
  await client.query(`SELECT pg_catalog.set_config('lock_timeout', CASE
    WHEN pg_catalog.current_setting('lock_timeout')::pg_catalog.interval = interval '0'
      OR pg_catalog.current_setting('lock_timeout')::pg_catalog.interval > interval '5 seconds'
    THEN '5s' ELSE pg_catalog.current_setting('lock_timeout') END, true)`);
  try { await client.query('LOCK TABLE ONLY pg_catalog.pg_namespace IN SHARE MODE'); }
  catch { unsupported('source.hard_limit.namespace_lock'); }
  const protectedName = await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
    WHERE pid=pg_catalog.pg_backend_pid() AND relation='pg_catalog.pg_namespace'::pg_catalog.regclass
      AND granted AND mode='ShareLock') AS held`);
  if (protectedName.rows[0]?.held !== true) unsupported('source.hard_limit.namespace_lock_evidence');
}

async function resolveReceipt(client: PostgresApplyClient, table: string, origin: SourceDiagnosticOrigin): Promise<string> {
  const result = await client.query(`SELECT pg_catalog.quote_ident(n.nspname)||'.'||pg_catalog.quote_ident(c.relname) AS name
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=pg_catalog.to_regclass($1)`, [table]);
  const name = result.rows[0]?.name; if (result.rows.length !== 1 || typeof name !== 'string') unsupported(`${origin}.receipt_resolution`);
  receiptNames.set(client, name); return name;
}

/** Bounded trusted-core PG17 capability. No user-expression/body inference or grants. */
export async function assertPostgresHardLimitSource(client: PostgresApplyClient, compiled: CompiledActionRuleV1,
  scope: HardLimitScopeSettings | undefined, receipt?: Receipt): Promise<void> {
  if (!compiled.hard_limit) return;
  await protectPostgresHardLimitNames(client);
  if (qualified.get(client)?.has(compiled.compiled_plan_digest)) return;
  if (!scope || !scope.principalSetting || receipt?.provisioning === 'auto_migrate') unsupported('source.hard_limit.scope_receipt_mode');
  if (receipt) {
    // Historical lookup cannot select the fresh mutation target. Re-resolve the
    // owner's configured relation under its original native path after waiting.
    const path = receiptSearchPaths.get(client);
    if (path !== undefined) await client.query("SELECT pg_catalog.set_config('search_path',$1,true)", [path]);
    receiptNames.delete(client);
    receipt = { ...receipt, table: await resolveReceipt(client, receipt.table, 'source.hard_limit') };
  }
  await client.query('SET LOCAL search_path = pg_catalog');
  const version = await client.query("SELECT pg_catalog.current_setting('server_version_num')::pg_catalog.int4 AS version,pg_catalog.current_setting('transaction_isolation') AS isolation,pg_catalog.current_setting('session_replication_role') AS replication_role");
  if (Number(version.rows[0]?.version) < 170000 || Number(version.rows[0]?.version) >= 180000 || version.rows[0]?.isolation !== 'read committed' || version.rows[0]?.replication_role !== 'origin') unsupported('source.hard_limit.engine_session');
  const byBinding = new Map(compiled.bindings.map(b => [b.binding, b]));
  const bindings = [...new Map(compiled.verification_boundary.lock_order.map(name => {
    const b = byBinding.get(name); if (!b || !b.resource.version_field || b.resource.engine !== 'postgres') unsupported('source.hard_limit.binding_inventory');
    return [JSON.stringify([b.resource.source,b.resource.schema,b.resource.table]), b] as const;
  })).values()];
  // Fixed same-field analysis obtains ROW EXCLUSIVE without executing UPDATE.
  // All relations are protected before inspecting one or permitting any Source DML.
  for (const b of bindings) {
    const name = quote('synapsor_admission_' + randomBytes(12).toString('hex'));
    const table = quote(b.resource.schema) + '.' + quote(b.resource.table);
    const field = quote(b.resource.version_field!);
    await client.query(`PREPARE ${name} AS UPDATE ${table} SET ${field}=${field} WHERE FALSE`);
    await client.query(`DEALLOCATE ${name}`);
  }
  if (receipt) await client.query(`LOCK TABLE ${receipt.table} IN ROW EXCLUSIVE MODE`);
  const relations: Array<{ oid: string; binding?: typeof bindings[number]; table: string }> = [];
  for (const b of bindings) {
    const table = quote(b.resource.schema) + '.' + quote(b.resource.table);
    const rows = await client.query(`SELECT c.oid::text AS oid,c.relkind,c.relam,c.relispartition,
      EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherits,
      EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid=pg_backend_pid() AND l.relation=c.oid AND l.mode='RowExclusiveLock' AND l.granted) AS protected
      FROM pg_catalog.pg_class c WHERE c.oid=to_regclass($1)`, [table]);
    const r=rows.rows[0]; if (rows.rows.length!==1 || !r || r.relkind!=='r' || Number(r.relam)!==2 || r.relispartition!==false || r.inherits!==false || r.protected!==true) unsupported('source.hard_limit.business_relation');
    relations.push({oid:String(r.oid),binding:b,table});
  }
  if (receipt) {
    const rows=await client.query(`SELECT c.oid::text AS oid,c.relkind,c.relam,c.relispartition,c.relrowsecurity,
      EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherits,
      EXISTS(SELECT 1 FROM pg_catalog.pg_locks l WHERE l.pid=pg_backend_pid() AND l.relation=c.oid AND l.mode='RowExclusiveLock' AND l.granted) AS protected
      FROM pg_catalog.pg_class c WHERE c.oid=to_regclass($1)`,[receipt.table]);
    const r=rows.rows[0]; if(rows.rows.length!==1 || !r || r.relkind!=='r' || Number(r.relam)!==2 || r.relispartition!==false || r.inherits!==false || r.relrowsecurity!==false || r.protected!==true) unsupported('source.hard_limit.receipt_relation');
    relations.push({oid:String(r.oid),table:receipt.table});
  }
  const oids=relations.map(r=>r.oid);
  for (const r of relations) await inspectRelation(client, r, scope);
  const fks=await client.query(`SELECT c.oid::text AS oid,c.conname,c.conrelid::text AS child,c.confrelid::text AS parent,
    c.confupdtype,c.confdeltype,c.condeferrable,c.convalidated,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY k(n,o) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.n ORDER BY k.o) AS local_fields,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY k(n,o) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.n ORDER BY k.o) AS target_fields
    FROM pg_catalog.pg_constraint c WHERE c.contype='f' AND (c.conrelid=ANY($1::oid[]) OR c.confrelid=ANY($1::oid[]))`,[oids]);
  const allowedFks=new Set<string>();
  for(const f of fks.rows){
    const child=relations.find(r=>r.oid===f.child)?.binding;const parent=relations.find(r=>r.oid===f.parent)?.binding;
    const relationship=compiled.bindings.find(b=>b.resource.name===child?.resource.name && b.relationship?.name===f.conname)?.relationship;
    if(!child || !parent || !relationship || f.confupdtype!=='a' || f.confdeltype!=='a' || f.condeferrable!==false || f.convalidated!==true
      || relationship.to_resource!==parent.resource.name
      || JSON.stringify(f.local_fields)!==JSON.stringify(actionRuleRelationshipPairs(relationship).map(p=>p.local_field))
      || JSON.stringify(f.target_fields)!==JSON.stringify(actionRuleRelationshipPairs(relationship).map(p=>p.target_field))) unsupported('source.hard_limit.foreign_keys');
    allowedFks.add(String(f.oid));
  }
  const internal=await client.query(`SELECT t.tgconstraint::text AS constraint,t.tgenabled,p.pronamespace,p.prosrc,p.prolang
    FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid WHERE t.tgrelid=ANY($1::oid[]) AND t.tgisinternal`,[oids]);
  for(const t of internal.rows){if(!allowedFks.has(String(t.constraint)) || t.tgenabled!=='O' || Number(t.pronamespace)!==11 || Number(t.prolang)!==12
    || !['RI_FKey_check_ins','RI_FKey_check_upd','RI_FKey_noaction_del','RI_FKey_noaction_upd'].includes(String(t.prosrc))) unsupported('source.hard_limit.internal_triggers');}
  qualified.set(client,new Set([...(qualified.get(client)??[]),compiled.compiled_plan_digest]));
}

async function inspectRelation(client: PostgresApplyClient,
  r: { oid: string; binding?: CompiledRuleBindingV1; table: string }, scope?: HardLimitScopeSettings, receiptRead = false): Promise<void> {
    const origin: SourceDiagnosticOrigin = receiptRead ? 'source.receipt_read' : 'source.hard_limit';

    const columns=await client.query(`SELECT a.attname,a.atttypid::integer AS type,a.atttypmod,a.attnotnull,a.attgenerated,a.attidentity,
      t.typnamespace=11 AS core,t.typtype,pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression,
      co.collisdeterministic,co.collprovider
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation
      WHERE a.attrelid=$1::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,[r.oid]);
    if(!columns.rows.length) unsupported(`${origin}.column_inventory`);
    const receiptTypes:Record<string,[number,boolean]>={idempotency_key:[25,true],job_id:[25,true],proposal_id:[25,true],status:[25,true],result_hash:[25,false],semantic_verification_json:[3802,false],completion_evidence_json:[3802,false],created_at:[1184,true],completed_at:[1184,false]};
    for(const a of columns.rows){
      if(a.core!==true || a.typtype!=='b' || a.attgenerated!=='' || a.attidentity!=='') unsupported(`${origin}.column_native_profile`);
      if(a.collisdeterministic===false || (a.collprovider!=null && !['d','c','i'].includes(String(a.collprovider)))) unsupported(`${origin}.column_collation`);
      if(r.binding){
        const field=r.binding.resource.fields.find(f=>f.name===a.attname);
        if(!field || a.attnotnull!==!field.nullable || a.default_expression!=null) unsupported(`${origin}.business_column_shape`);
        if(field.type.kind==='integer') {if(Number(a.type)!==23 || Number(a.atttypmod)!==-1) unsupported(`${origin}.integer_column`);}
        else if(field.type.kind==='string'){if(Number(a.type)!==1043 || Number(a.atttypmod)!==field.type.max_length+4) unsupported(`${origin}.string_column`);}
        else unsupported(`${origin}.column_kind`);
      }else{
        const expected=receiptTypes[String(a.attname)]; if(!expected || Number(a.type)!==expected[0] || a.attnotnull!==expected[1] || Number(a.atttypmod)!==-1) unsupported(`${origin}.receipt_column_shape`);
        if(a.attname==='created_at'){if(!['now()','pg_catalog.now()'].includes(String(a.default_expression))) unsupported(`${origin}.receipt_created_default`);}
        else if(a.default_expression!=null) unsupported(`${origin}.receipt_column_default`);
      }
    }
    if(r.binding && columns.rows.length!==r.binding.resource.fields.length) unsupported(`${origin}.business_column_inventory`);
    if(!r.binding) {
      const expectedNames = Object.keys(receiptTypes).filter(name => !receiptRead || name !== 'completion_evidence_json');
      if (expectedNames.some(name => !columns.rows.some(a => a.attname === name))
        || (!receiptRead && columns.rows.length !== expectedNames.length)
        || (receiptRead && ![expectedNames.length, expectedNames.length + 1].includes(columns.rows.length))) unsupported(`${origin}.receipt_column_inventory`);
    }
    const opaque=await client.query(`SELECT
      EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=$1::oid AND NOT t.tgisinternal) AS triggers,
      EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite w WHERE w.ev_class=$1::oid) AS rules,
      EXISTS(SELECT 1 FROM pg_catalog.pg_constraint c WHERE c.conrelid=$1::oid AND (c.contype NOT IN ('p','u','f') OR c.condeferrable OR NOT c.convalidated)) AS constraints,
      EXISTS(SELECT 1 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class ic ON ic.oid=i.indexrelid
        WHERE i.indrelid=$1::oid AND (ic.relam<>403 OR i.indexprs IS NOT NULL OR i.indpred IS NOT NULL OR i.indisexclusion
          OR NOT i.indisvalid OR NOT i.indisready OR NOT i.indislive
          OR EXISTS(SELECT 1 FROM unnest(i.indkey) k WHERE k<=0)
          OR EXISTS(SELECT 1 FROM unnest(i.indclass) oc JOIN pg_catalog.pg_opclass op ON op.oid=oc
            WHERE op.opcnamespace<>11 OR op.opcname NOT IN ('int4_ops','text_ops') OR op.opcintype NOT IN (23,25)))) AS indexes`,[r.oid]);
    if(opaque.rows.length!==1 || !opaque.rows[0] || (receiptRead ? opaque.rows[0].indexes !== false : Object.values(opaque.rows[0]).some(v=>v!==false))) unsupported(`${origin}.opaque_effects`);
    if(r.binding){
      const policies=await client.query(`SELECT pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS using_expression,
        pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression,p.polcmd
        FROM pg_catalog.pg_policy p WHERE p.polrelid=$1::oid`,[r.oid]);
      const s=r.binding.verification.scope;if(s.mode!=='columns' || !s.principal_field) unsupported(`${origin}.policy_scope`);
      if (!scope?.principalSetting) unsupported(`${origin}.policy_settings`);
      const allowed=new Map([[s.tenant_field,scope.tenantSetting],[s.principal_field,scope.principalSetting]]);
      if(!policies.rows.length) unsupported(`${origin}.policy_inventory`);
      for(const p of policies.rows){
        if(!['r','a','w','*'].includes(String(p.polcmd))) unsupported(`${origin}.policy_command`);
        if(p.polcmd==='a') {
          if(p.using_expression!==null) unsupported(`${origin}.policy_using`);
        } else if(typeof p.using_expression!=='string' || !isCompleteCollectionScopeExpression(p.using_expression,allowed)) unsupported(`${origin}.policy_using`);
        if(p.polcmd!=='r' && (typeof p.check_expression!=='string' || !isCompleteCollectionScopeExpression(p.check_expression,allowed))) unsupported(`${origin}.policy_check`);
      }
    }

}

/** Read existing durable evidence before admitting new work. No Source DML. */
export async function inspectPostgresSourceReceiptRead(client: PostgresApplyClient, table: string): Promise<string> {
  const originalPath = await client.query("SELECT pg_catalog.current_setting('search_path') AS path");
  if (typeof originalPath.rows[0]?.path !== 'string') unsupported('source.receipt_read.search_path');
  receiptSearchPaths.set(client, originalPath.rows[0].path);
  const name = await resolveReceipt(client, table, 'source.receipt_read');
  await client.query('SET LOCAL search_path = pg_catalog');
  const protectedNames = await client.query(`SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
    WHERE pid=pg_catalog.pg_backend_pid() AND relation='pg_catalog.pg_namespace'::pg_catalog.regclass
      AND granted AND mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')) AS held`);
  await client.query(`LOCK TABLE ${name} IN ${protectedNames.rows[0]?.held === true ? 'ROW EXCLUSIVE' : 'ACCESS SHARE'} MODE`);
  const result = await client.query(`SELECT c.oid::text AS oid,c.relkind,c.relam,c.relispartition,c.relrowsecurity,
    EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AS inherits
    FROM pg_catalog.pg_class c WHERE c.oid=pg_catalog.to_regclass($1)`, [name]);
  const r=result.rows[0]; if(result.rows.length!==1 || !r || r.relkind!=='r' || Number(r.relam)!==2
    || r.relispartition!==false || r.relrowsecurity!==false || r.inherits!==false) unsupported('source.receipt_read.relation_profile');
  await inspectRelation(client, { oid: String(r.oid), table: name }, undefined, true);
  return name;
}
