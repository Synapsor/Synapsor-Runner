import { policyTextLines, type PolicyTextSnapshot } from "./authoring-policy-source.js";

/** Source coordinates only. No classification, implicit background, retained
 * prose or semantic acceptance is supplied by this structural inventory. */
export function reviewSourceInventory(source: PolicyTextSnapshot) {
  const lines = policyTextLines(source.text);
  return { source_digest: source.digest, line_count: lines.length,
    nonblank_lines: lines.flatMap((line, index) => line.trim() ? [index + 1] : []),
    response_contract: "complete_replacement" as const };
}

export function missingReviewSourceLines(source: PolicyTextSnapshot, passages: readonly unknown[]): number[] | undefined {
  const inventory = reviewSourceInventory(source), covered = new Set<number>();
  for (const raw of passages) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
    const p = raw as { start: number; end: number };
    if (!Number.isSafeInteger(p.start) || !Number.isSafeInteger(p.end)
      || p.start < 1 || p.end < p.start || p.end > inventory.line_count) return undefined;
    for (let line = p.start; line <= p.end; line++) covered.add(line);
  }
  return inventory.nonblank_lines.filter(line => !covered.has(line));
}

export class CoverageSourceLinesError extends Error {
  readonly missing_ranges: Array<{ start: number; end: number }>;
  readonly omitted_range_count: number;
  constructor(readonly source_digest: string, missing: number[]) {
    super(`Unaccounted source lines: ${missing.join(", ")}. Include restrictions and unsupported clauses, not only implemented clauses.`);
    const ranges: Array<{ start: number; end: number }> = [];
    for (const line of missing) {
      const previous = ranges.at(-1);
      if (previous && previous.end === line - 1) previous.end = line;
      else ranges.push({ start: line, end: line });
    }
    this.missing_ranges = ranges.slice(0, 16);
    this.omitted_range_count = Math.max(0, ranges.length - this.missing_ranges.length);
  }
}
