/** Fixed catalogue expression shared by inspection and required-singleton revalidation.
 * The consumer binds pg_attribute as a, pg_type as t, and pg_class as r.
 * It contains declaration metadata only, never row values or executable model SQL.
 * OIDs are deliberately excluded from the portable digest; native type modifiers,
 * qualified type/collation identities and sorted constraint declarations remain.
 */
export const postgresColumnDeclarationExpression = `jsonb_build_object(
  'type_schema',(SELECT n.nspname FROM pg_catalog.pg_namespace n WHERE n.oid=t.typnamespace),
  'type_name',t.typname,'type_modifier',a.atttypmod,'nullable',NOT a.attnotnull,
  'collation_schema',(SELECT n.nspname FROM pg_catalog.pg_collation c JOIN pg_catalog.pg_namespace n ON n.oid=c.collnamespace WHERE c.oid=a.attcollation),
  'collation_name',(SELECT c.collname FROM pg_catalog.pg_collation c WHERE c.oid=a.attcollation),
  'generated',a.attgenerated,'identity',a.attidentity,
  'default_expression',(SELECT pg_catalog.pg_get_expr(d.adbin,d.adrelid,false) FROM pg_catalog.pg_attrdef d WHERE d.adrelid=a.attrelid AND d.adnum=a.attnum),
  'enum_values',COALESCE((SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid),'[]'::jsonb),
  'domain_checks',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_catalog.pg_get_constraintdef(c.oid,false),'validated',c.convalidated,'no_inherit',c.connoinherit) ORDER BY c.conname)
    FROM pg_catalog.pg_constraint c WHERE c.contypid=t.oid AND c.contype='c'),'[]'::jsonb),
  'table_checks',COALESCE((SELECT jsonb_agg(jsonb_build_object('name',c.conname,'definition',pg_catalog.pg_get_constraintdef(c.oid,false),'validated',c.convalidated,'no_inherit',c.connoinherit) ORDER BY c.conname)
    FROM pg_catalog.pg_constraint c WHERE c.conrelid=r.oid AND c.contype='c'),'[]'::jsonb)
)`;

// Fixed native scalar qualification for the new declaration stamp only. Defaults
// and checks with dependencies outside this relation cannot be protected by its
// relation lock. Pinned native built-ins do not have pg_depend edges.
export const postgresNativeDeclarationSupportedExpression = `(
  t.typtype='b' AND t.typnamespace='pg_catalog'::regnamespace
  AND t.typname IN ('bool','int2','int4','int8','date','timestamp','timestamptz','text','varchar','bpchar')
  AND t.typelem=0 AND t.typbasetype=0 AND a.attndims=0
  AND r.relkind='r' AND r.relpersistence='p' AND NOT r.relispartition
  AND r.relam=(SELECT am.oid FROM pg_catalog.pg_am am WHERE am.amname='heap' AND am.amtype='t')
  AND (a.attcollation=0 OR EXISTS (SELECT 1 FROM pg_catalog.pg_collation native_collation
    WHERE native_collation.oid=a.attcollation AND native_collation.collnamespace='pg_catalog'::regnamespace AND native_collation.collisdeterministic))
  AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_depend dependency
    WHERE ((dependency.classid='pg_attrdef'::regclass AND dependency.objid IN
        (SELECT d.oid FROM pg_catalog.pg_attrdef d WHERE d.adrelid=r.oid))
      OR (dependency.classid='pg_constraint'::regclass AND dependency.objid IN
        (SELECT c.oid FROM pg_catalog.pg_constraint c WHERE c.conrelid=r.oid AND c.contype='c')))
      AND NOT (dependency.refclassid='pg_class'::regclass AND dependency.refobjid=r.oid)
  )
)`;

/** Fixed FK catalogue projection. The consumer binds con/source/target and the
 * ordered source_attr/target_attr pair. NULL is deliberately not legacy refusal.
 * This establishes native at-most-one linkage, never scope or row existence.
 */
export const postgresRequiredSingletonProofExpression = `(SELECT jsonb_build_object(
  'child_unique_key',child_key.conname,'child_unique_index',child_index.relname,
  'parent_unique_key',parent_key.conname,'parent_unique_index',parent_index.relname)
  FROM pg_catalog.pg_constraint child_key
  JOIN pg_catalog.pg_index ci ON ci.indexrelid=child_key.conindid AND ci.indrelid=source.oid
  JOIN pg_catalog.pg_class child_index ON child_index.oid=ci.indexrelid
  JOIN pg_catalog.pg_opclass child_opclass ON child_opclass.oid=ci.indclass[0]
  JOIN pg_catalog.pg_am child_am ON child_am.oid=child_opclass.opcmethod
  JOIN pg_catalog.pg_constraint parent_key ON parent_key.conrelid=target.oid
    AND parent_key.contype IN ('p','u') AND parent_key.conkey=con.confkey AND parent_key.conindid=con.conindid
  JOIN pg_catalog.pg_index pi ON pi.indexrelid=parent_key.conindid AND pi.indrelid=target.oid
  JOIN pg_catalog.pg_class parent_index ON parent_index.oid=pi.indexrelid
  JOIN pg_catalog.pg_opclass parent_opclass ON parent_opclass.oid=pi.indclass[0]
  JOIN pg_catalog.pg_am parent_am ON parent_am.oid=parent_opclass.opcmethod
  WHERE child_key.conrelid=source.oid AND child_key.contype IN ('p','u') AND child_key.conkey=con.conkey
    AND source.oid<>target.oid AND source.relkind='r' AND target.relkind='r'
    AND NOT source.relispartition AND NOT target.relispartition
    AND source.relpersistence='p' AND target.relpersistence='p'
    AND source.relam=(SELECT am.oid FROM pg_catalog.pg_am am WHERE am.amname='heap' AND am.amtype='t')
    AND target.relam=(SELECT am.oid FROM pg_catalog.pg_am am WHERE am.amname='heap' AND am.amtype='t')
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_inherits h
      WHERE h.inhrelid IN (source.oid,target.oid) OR h.inhparent IN (source.oid,target.oid))
    AND COALESCE((to_jsonb(con)->>'conenforced')::boolean, current_setting('server_version_num')::integer BETWEEN 130000 AND 179999)
    AND current_setting('server_version_num')::integer BETWEEN 130000 AND 189999
    AND con.convalidated AND NOT con.condeferrable AND cardinality(con.conkey)=1 AND cardinality(con.confkey)=1
    AND con.confdeltype='a' AND con.confupdtype='a'
    AND source_attr.attnotnull AND target_attr.attnotnull AND NOT source_attr.attisdropped AND NOT target_attr.attisdropped
    AND source_attr.atttypid=target_attr.atttypid AND source_attr.atttypmod=target_attr.atttypmod
    AND source_attr.attcollation=target_attr.attcollation
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_collation coll
      WHERE coll.oid IN (source_attr.attcollation,target_attr.attcollation) AND NOT coll.collisdeterministic)
    AND child_key.convalidated AND NOT child_key.condeferrable AND parent_key.convalidated AND NOT parent_key.condeferrable
    AND COALESCE((to_jsonb(child_key)->>'conenforced')::boolean, current_setting('server_version_num')::integer BETWEEN 130000 AND 179999)
    AND COALESCE((to_jsonb(parent_key)->>'conenforced')::boolean, current_setting('server_version_num')::integer BETWEEN 130000 AND 179999)
    AND ci.indisunique AND ci.indisvalid AND ci.indisready AND ci.indimmediate AND ci.indislive
    AND pi.indisunique AND pi.indisvalid AND pi.indisready AND pi.indimmediate AND pi.indislive
    AND ci.indnkeyatts=1 AND ci.indnatts=1 AND pi.indnkeyatts=1 AND pi.indnatts=1
    AND ci.indkey[0]=source_attr.attnum AND pi.indkey[0]=target_attr.attnum
    AND ci.indpred IS NULL AND ci.indexprs IS NULL AND pi.indpred IS NULL AND pi.indexprs IS NULL
    AND child_am.amname='btree' AND parent_am.amname='btree'
    AND child_opclass.opcnamespace='pg_catalog'::regnamespace AND child_opclass.opcdefault
    AND parent_opclass.opcnamespace='pg_catalog'::regnamespace AND parent_opclass.opcdefault
    AND child_opclass.opcintype=CASE WHEN source_attr.atttypid='varchar'::regtype THEN 'text'::regtype ELSE source_attr.atttypid END
    AND parent_opclass.opcintype=CASE WHEN target_attr.atttypid='varchar'::regtype THEN 'text'::regtype ELSE target_attr.atttypid END
    AND cardinality(con.conpfeqop)=1 AND cardinality(con.conppeqop)=1 AND cardinality(con.conffeqop)=1
    AND NOT EXISTS (SELECT 1 FROM unnest(con.conpfeqop || con.conppeqop || con.conffeqop) AS operators(operator_id)
      LEFT JOIN pg_catalog.pg_operator native_operator ON native_operator.oid=operator_id
      WHERE native_operator.oid IS NULL OR native_operator.oprnamespace<>'pg_catalog'::regnamespace
        OR native_operator.oprname<>'=' OR native_operator.oprresult<>'bool'::regtype)
    AND current_setting('session_replication_role')='origin'
    AND (SELECT count(*)=4 AND bool_and(ri_trigger.tgenabled IN ('O','A') AND NOT ri_trigger.tgdeferrable AND NOT ri_trigger.tginitdeferred
        AND proc.pronamespace='pg_catalog'::regnamespace)
      AND count(*) FILTER (WHERE ri_trigger.tgrelid=source.oid AND ri_trigger.tgtype=5 AND proc.proname='RI_FKey_check_ins')=1
      AND count(*) FILTER (WHERE ri_trigger.tgrelid=source.oid AND ri_trigger.tgtype=17 AND proc.proname='RI_FKey_check_upd')=1
      AND count(*) FILTER (WHERE ri_trigger.tgrelid=target.oid AND ri_trigger.tgtype=9 AND proc.proname='RI_FKey_noaction_del')=1
      AND count(*) FILTER (WHERE ri_trigger.tgrelid=target.oid AND ri_trigger.tgtype=17 AND proc.proname='RI_FKey_noaction_upd')=1
      FROM pg_catalog.pg_trigger ri_trigger LEFT JOIN pg_catalog.pg_proc proc ON proc.oid=ri_trigger.tgfoid
      WHERE ri_trigger.tgconstraint=con.oid AND ri_trigger.tgisinternal)
    -- Do not select the first of several possible child constraint identities.
    AND (SELECT count(*) FROM pg_catalog.pg_constraint k
      WHERE k.conrelid=source.oid AND k.contype IN ('p','u') AND k.conkey=con.conkey)=1
    AND (SELECT count(*) FROM pg_catalog.pg_constraint k
      WHERE k.conrelid=target.oid AND k.contype IN ('p','u') AND k.conkey=con.confkey AND k.conindid=con.conindid)=1
)`;
