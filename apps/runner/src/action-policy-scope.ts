export type ExplicitTrustedPolicyScope = {
  scope: "tenant" | "tenant_principal" | "tenant_object";
  phrase: string;
};

export function explicitTrustedPolicyScope(value: string): ExplicitTrustedPolicyScope | undefined {
  const answer = value.replace(
    /\b(?:not|instead\s+of|rather\s+than)\s+(?:per\s+)?(?:(?:trusted|customer)\s+)?(?:target\s+)?(?:account|tenant|org|organization|organisation|agent|operator|principal|user|customer|row|record|object)\b/gi,
    " ",
  );
  const objectMatch = answer.match(
    /\b(?:per|for\s+each|for\s+every|each|every)\s+(?:exact\s+)?(?:target\s+)?(?:row|record|object)\b/i,
  );
  if (objectMatch) return { scope: "tenant_object", phrase: JSON.stringify(objectMatch[0]) };
  const accountMatch = answer.match(
    /\b(?:per|for\s+each|for\s+every|each|every)\s+(?:(?:trusted|customer)\s+)?account\b/i,
  );
  if (accountMatch) return { scope: "tenant", phrase: JSON.stringify(accountMatch[0]) };
  const principalMatch = answer.match(
    /\b(?:per|for\s+each|for\s+every|each|every)\s+(?:authenticated\s+)?(?:agent|operator|principal|user|customer)\b/i,
  );
  if (principalMatch) return { scope: "tenant_principal", phrase: JSON.stringify(principalMatch[0]) };
  const tenantMatch = answer.match(
    /\b(?:per|for\s+each|for\s+every|each|every)\s+(?:trusted\s+)?(?:tenant|org|organization|organisation)\b/i,
  );
  return tenantMatch ? { scope: "tenant", phrase: JSON.stringify(tenantMatch[0]) } : undefined;
}
