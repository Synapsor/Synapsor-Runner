export type ExplicitTrustedPolicyScope = {
  scope: "boundary" | "capability" | "tenant" | "tenant_principal" | "tenant_object";
  phrase: string;
};

export type ExplicitPolicyDuration = {
  seconds: number;
  phrase: string;
};

export type ExplicitPolicyLimit = {
  kind: "count";
  scope: ExplicitTrustedPolicyScope["scope"];
  maximum: number;
  window_seconds: number;
  phrase: string;
};

type LocatedPolicyDuration = ExplicitPolicyDuration & {
  start: number;
  end: number;
};

export function explicitTrustedPolicyScope(value: string): ExplicitTrustedPolicyScope | undefined {
  const answer = value.replace(
    /\b(?:not|instead\s+of|rather\s+than)\s+(?:per\s+)?(?:(?:trusted|customer)\s+)?(?:target\s+)?(?:account|tenant|org|organization|organisation|agent|operator|principal|user|customer|row|record|object)\b/gi,
    " ",
  );
  const objectMatch = answer.match(
    /\b(?:(?:per|for\s+each|for\s+every|each|every)\s+(?:exact\s+)?(?:target\s+)?(?:row|record|object)|for\s+(?:this|the\s+same)\s+exact\s+(?:target\s+)?(?:row|record|object|subscription))\b/i,
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
  const tenantPrincipalMatch = answer.match(
    /\b(?:per|for\s+(?:each|every|a|an|the)|each|every)\s+(?:(?:trusted|customer)\s+)?(?:tenant|account)\s*(?:\/|\+|plus|and)\s*(?:trusted\s+)?(?:principal|agent|operator|user|customer)(?:\s+(?:pair|combination))?\b/i,
  );
  if (tenantPrincipalMatch) {
    return { scope: "tenant_principal", phrase: JSON.stringify(tenantPrincipalMatch[0]) };
  }
  const accountMatch = answer.match(
    /\b(?:(?:per|for\s+each|for\s+every|each|every)\s+(?:(?:trusted|customer)\s+)?account|for\s+(?:the\s+)?same\s+(?:customer\s+)?account)\b/i,
  );
  if (accountMatch) return { scope: "tenant", phrase: JSON.stringify(accountMatch[0]) };
  const principalMatch = answer.match(
    /\b(?:(?:per|for\s+each|for\s+every|each|every)\s+(?:(?:authenticated|signed[- ]in|trusted)\s+)?(?:person|agent|operator|principal|user)|for\s+(?:the\s+)?same\s+(?:(?:authenticated|signed[- ]in|trusted)\s+)?(?:person|agent|operator|principal|user)(?:\s+in\s+(?:an?|the|that|same)\s+(?:customer\s+)?account)?)\b/i,
  );
  if (principalMatch) return { scope: "tenant_principal", phrase: JSON.stringify(principalMatch[0]) };
  const tenantMatch = answer.match(
    /\b(?:per|for\s+each|for\s+every|each|every)\s+(?:trusted\s+)?(?:tenant|org|organization|organisation)\b/i,
  );
  return tenantMatch ? { scope: "tenant", phrase: JSON.stringify(tenantMatch[0]) } : undefined;
}

export function explicitTrustedPolicyScopes(value: string): ExplicitTrustedPolicyScope[] {
  let answer = value.replace(
    /\b(?:not|instead\s+of|rather\s+than)\s+(?:per\s+)?(?:(?:trusted|customer)\s+)?(?:target\s+)?(?:account|tenant|org|organization|organisation|agent|operator|principal|user|customer|row|record|object)\b/gi,
    " ",
  );
  const found = new Map<ExplicitTrustedPolicyScope["scope"], string>();
  const tenantPrincipalPattern = /\b(?:per|for\s+(?:each|every|a|an|the)|each|every)\s+(?:(?:trusted|customer)\s+)?(?:tenant|account)\s*(?:\/|\+|plus|and)\s*(?:trusted\s+)?(?:principal|agent|operator|user|customer)(?:\s+(?:pair|combination))?\b/gi;
  answer = answer.replace(tenantPrincipalPattern, (phrase) => {
    if (!found.has("tenant_principal")) {
      found.set("tenant_principal", JSON.stringify(phrase));
    }
    // Do not let the tenant-only pass below reclassify one compound limit.
    return " ".repeat(phrase.length);
  });
  const patterns: Array<[ExplicitTrustedPolicyScope["scope"], RegExp]> = [
    ["tenant_object", /\b(?:(?:per|for\s+each|for\s+every|each|every)\s+(?:exact\s+)?(?:target\s+)?(?:row|record|object)|for\s+(?:this|the\s+same)\s+exact\s+(?:target\s+)?(?:row|record|object|subscription))\b/gi],
    ["boundary", /\b(?:across|for|per|within)\s+(?:the\s+)?(?:whole\s+|entire\s+|this\s+)?action\s+boundary\b/gi],
    ["capability", /\b(?:across|for|per|within)\s+(?:this\s+|the\s+|each\s+|every\s+)?(?:exact\s+)?(?:action|capability)\b/gi],
    ["tenant_principal", /\b(?:(?:per|for\s+each|for\s+every|each|every)\s+(?:(?:authenticated|signed[- ]in|trusted)\s+)?(?:person|agent|operator|principal|user)|for\s+(?:the\s+)?same\s+(?:(?:authenticated|signed[- ]in|trusted)\s+)?(?:person|agent|operator|principal|user)(?:\s+in\s+(?:an?|the|that|same)\s+(?:customer\s+)?account)?)\b/gi],
    ["tenant", /\b(?:(?:per|for\s+each|for\s+every|each|every)\s+(?:(?:trusted|customer)\s+)?account|for\s+(?:the\s+)?same\s+(?:customer\s+)?account)\b/gi],
    ["tenant", /\b(?:per|for\s+each|for\s+every|each|every)\s+(?:trusted\s+)?(?:tenant|org|organization|organisation)\b/gi],
  ];
  for (const [scope, pattern] of patterns) {
    for (const match of answer.matchAll(pattern)) {
      if (!found.has(scope)) found.set(scope, JSON.stringify(match[0]));
    }
  }
  return [...found].map(([scope, phrase]) => ({ scope, phrase }));
}

export function explicitPolicyDurations(value: string): ExplicitPolicyDuration[] {
  const found = new Map<number, string>();
  for (const duration of locatedPolicyDurations(value)) {
    found.set(duration.seconds, duration.phrase);
  }
  return [...found].map(([seconds, phrase]) => ({ seconds, phrase }));
}

export function explicitPolicyLimits(value: string): ExplicitPolicyLimit[] {
  const lower = value.toLowerCase();
  const scopes = explicitTrustedPolicyScopes(value)
    .map((scope) => {
      const phrase = parseMatchedPhrase(scope.phrase);
      const start = lower.indexOf(phrase.toLowerCase());
      return start < 0 ? undefined : { ...scope, matchedPhrase: phrase, start, end: start + phrase.length };
    })
    .filter((scope): scope is NonNullable<typeof scope> => scope !== undefined)
    .sort((left, right) => left.start - right.start);
  const durations = locatedPolicyDurations(value);
  const limits: ExplicitPolicyLimit[] = [];

  for (const [index, scope] of scopes.entries()) {
    const previous = scopes[index - 1];
    const next = scopes[index + 1];
    const sentenceStart = Math.max(value.lastIndexOf(".", scope.start - 1), value.lastIndexOf(";", scope.start - 1), value.lastIndexOf("\n", scope.start - 1)) + 1;
    const sentenceEnds = [value.indexOf(".", scope.end), value.indexOf(";", scope.end), value.indexOf("\n", scope.end)]
      .filter((position) => position >= 0);
    const sentenceEnd = sentenceEnds.length === 0 ? value.length : Math.min(...sentenceEnds);
    const start = previous === undefined
      ? sentenceStart
      : Math.max(sentenceStart, connectorBoundary(value, previous.end, scope.start, "after"));
    const end = next === undefined
      ? sentenceEnd
      : Math.min(sentenceEnd, connectorBoundary(value, scope.end, next.start, "before"));
    const segment = value.slice(start, end);
    const segmentDurations = durations.filter((duration) => duration.start >= start && duration.end <= end);
    const maximums = explicitCountMaximums(segment, scope.matchedPhrase);
    if (segmentDurations.length !== 1 || maximums.length !== 1) continue;
    limits.push({
      kind: "count",
      scope: scope.scope,
      maximum: maximums[0]!,
      window_seconds: segmentDurations[0]!.seconds,
      phrase: JSON.stringify(segment.trim()),
    });
  }
  return limits;
}

function locatedPolicyDurations(value: string): LocatedPolicyDuration[] {
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
  const found: LocatedPolicyDuration[] = [];
  const duration = "(\\d+(?:\\.\\d+)?)\\s*(?:-|\\s)?\\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)";
  const patterns = [
    new RegExp(`\\b(?:rolling|per|every|within|over|during|in\\s+(?:the\\s+)?last|last)\\s+${duration}\\b`, "gi"),
    new RegExp(`\\b${duration}\\s+(?:rolling\\s+)?(?:window|period)\\b`, "gi"),
    /\bper\s+(second|sec|minute|min|hour|hr|day|week)s?\b/gi,
  ];
  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      const impliedOne = match.length === 2;
      const amount = impliedOne ? 1 : Number(match[1]);
      const unit = String(impliedOne ? match[1] : match[2]).toLowerCase().replace(/s$/, "");
      const multiplier = multipliers[unit];
      const seconds = multiplier === undefined ? NaN : amount * multiplier;
      if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 31_536_000) continue;
      const start = match.index ?? -1;
      const end = start + match[0].length;
      if (start < 0) continue;
      const overlap = found.findIndex((entry) => entry.seconds === seconds && start < entry.end && end > entry.start);
      if (overlap >= 0) {
        if (end - start > found[overlap]!.end - found[overlap]!.start) {
          found[overlap] = { seconds, phrase: match[0], start, end };
        }
        continue;
      }
      found.push({ seconds, phrase: match[0], start, end });
    }
  }
  return found.sort((left, right) => left.start - right.start);
}

function connectorBoundary(
  value: string,
  left: number,
  right: number,
  side: "before" | "after",
): number {
  const between = value.slice(left, right);
  const connectors = [...between.matchAll(/\b(?:and|while|but)\b|,/gi)];
  if (connectors.length === 0) return Math.floor((left + right) / 2);
  const match = side === "before" ? connectors[0]! : connectors[connectors.length - 1]!;
  const position = left + (match.index ?? 0);
  return side === "before" ? position : position + match[0].length;
}

function explicitCountMaximums(segment: string, matchedScope: string): number[] {
  const number = "(?:\\d+(?:\\.\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten)";
  const patterns = [
    new RegExp(`\\b(?:at\\s+most|no\\s+more\\s+than|maximum(?:\\s+of)?|up\\s+to)\\s+(${number})\\b`, "gi"),
    new RegExp(`\\blimit(?:ed)?(?:\\s+automatic)?(?:\\s+approvals?)?\\s+to\\s+(${number})\\b`, "gi"),
    new RegExp(`\\b(${number})\\s+(?:automatic\\s+)?(?:approvals?|proposals?|requests?)\\b`, "gi"),
    new RegExp(`\\b(${number})\\s+${escapeRegExp(matchedScope)}\\b`, "gi"),
  ];
  const found = new Set<number>();
  for (const pattern of patterns) {
    for (const match of segment.matchAll(pattern)) {
      const parsed = parseCountNumber(match[1]!);
      if (parsed !== undefined) found.add(parsed);
    }
  }
  return [...found];
}

function parseCountNumber(value: string): number | undefined {
  const words: Record<string, number> = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
  };
  const parsed = words[value.toLowerCase()] ?? Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseMatchedPhrase(value: string): string {
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatPolicyDuration(seconds: number): string {
  if (seconds % 604_800 === 0) return `${seconds / 604_800} week${seconds === 604_800 ? "" : "s"}`;
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hour${seconds === 3_600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} minute${seconds === 60 ? "" : "s"}`;
  return `${seconds} seconds`;
}
