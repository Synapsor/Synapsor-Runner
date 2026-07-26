import crypto from "node:crypto";
import type {
  ToolNameStyle,
  ToolNameExposure,
} from "./runtime-types.js";

export function openaiToolNameAlias(canonicalName: string): string {
  const sanitized = canonicalName
    .replace(/[^A-Za-z0-9_-]+/g, "__")
    .replace(/_{3,}/g, "__")
    .replace(/^_+|_+$/g, "");
  const base = sanitized.length > 0 ? sanitized : `tool_${shortToolHash(canonicalName)}`;
  if (base.length <= 64) return base;
  const suffix = shortToolHash(canonicalName);
  return `${base.slice(0, Math.max(1, 63 - suffix.length)).replace(/_+$/g, "")}_${suffix}`;
}

export function toolNameExposures(canonicalNames: string[], style: ToolNameStyle): ToolNameExposure[] {
  const exposedNames = toolNameExposureMap(canonicalNames, style);
  return canonicalNames.flatMap((canonicalName) => {
    return (exposedNames.get(canonicalName) ?? [canonicalName]).map((exposedName) => ({
      canonicalName,
      exposedName,
      isAlias: exposedName !== canonicalName,
      style,
    }));
  });
}

export function toolNameExposureMap(canonicalNames: string[], style: ToolNameStyle): Map<string, string[]> {
  const exposedByCanonical = new Map<string, string[]>();
  const canonicalByExposed = new Map<string, string>();
  if (style === "both") {
    for (const canonical of canonicalNames) canonicalByExposed.set(canonical, canonical);
  }
  for (const canonical of canonicalNames) {
    const names = new Set<string>();
    if (style === "canonical" || style === "both") names.add(canonical);
    if (style === "openai" || style === "both") {
      let alias = openaiToolNameAlias(canonical);
      const existing = canonicalByExposed.get(alias);
      if (existing && existing !== canonical) {
        const suffix = shortToolHash(canonical);
        alias = `${alias.slice(0, Math.max(1, 63 - suffix.length)).replace(/_+$/g, "")}_${suffix}`;
      }
      canonicalByExposed.set(alias, canonical);
      names.add(alias);
    }
    exposedByCanonical.set(canonical, [...names]);
  }
  return exposedByCanonical;
}

export function shortToolHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
}
