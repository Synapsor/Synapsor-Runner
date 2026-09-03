export type ExplicitTrustedPolicyScope = {
  scope: "boundary" | "capability" | "tenant" | "tenant_principal" | "tenant_object";
  phrase: string;
};

export type ExplicitPolicyDuration = {
  seconds: number;
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
  const boundaryMatch = answer.match(
    /\b(?:across|for|per|within)\s+(?:the\s+)?(?:whole\s+|entire\s+|this\s+)?action\s+boundary\b/i,
  );
  if (boundaryMatch) return { scope: "boundary", phrase: JSON.stringify(boundaryMatch[0]) };
  const capabilityMatch = answer.match(
    /\b(?:across|for|per|within)\s+(?:this\s+|the\s+|each\s+|every\s+)?(?:exact\s+)?(?:action|capability)\b/i,
  );
  if (capabilityMatch) return { scope: "capability", phrase: JSON.stringify(capabilityMatch[0]) };
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

export function explicitPolicyDurations(value: string): ExplicitPolicyDuration[] {
  const multipliers: Record<string, number> = {
    second: 1,
    sec: 1,
    minute: 60,
    min: 60,
    hour: 3_600,
    hr: 3_600,
    day: 86_400,
    week: 604_800,
  };
  const found = new Map<number, string>();
  const duration = "(\\d+(?:\\.\\d+)?)\\s*(?:-|\\s)?\\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)";
  const patterns = [
    new RegExp(`\\b(?:rolling|per|every|within|over|during|in\\s+(?:the\\s+)?last|last)\\s+${duration}\\b`, "gi"),
    new RegExp(`\\b${duration}\\s+(?:rolling\\s+)?(?:window|period)\\b`, "gi"),
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const amount = Number(match[1]);
      const unit = String(match[2]).toLowerCase().replace(/s$/, "");
      const multiplier = multipliers[unit];
      const seconds = multiplier === undefined ? NaN : amount * multiplier;
      if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 31_536_000) continue;
      found.set(seconds, match[0]);
    }
  }
  return [...found].map(([seconds, phrase]) => ({ seconds, phrase }));
}

export function formatPolicyDuration(seconds: number): string {
  if (seconds % 604_800 === 0) return `${seconds / 604_800} week${seconds === 604_800 ? "" : "s"}`;
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} seconds`;
}
