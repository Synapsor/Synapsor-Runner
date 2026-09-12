type DirectScope = { tenant_key?: string; principal_key?: string };

/** A private scope pair is structural, never permission to return either key. */
export function isReadRelationshipScopePair(
  source: DirectScope,
  target: DirectScope,
  sourceColumn: string,
  targetColumn: string,
): boolean {
  return (sourceColumn === source.tenant_key && targetColumn === target.tenant_key)
    || (sourceColumn === source.principal_key && targetColumn === target.principal_key);
}
