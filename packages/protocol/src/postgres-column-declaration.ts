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
