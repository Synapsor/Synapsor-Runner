import { randomBytes } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { CATALOG_LIMITS } from "@synapsor-runner/mcp-server";
import { ScopedExploreError, type ExplorePlan, type ScopedExploreValidationResult } from "./scoped-explore.js";

type Projection = { value: Record<string, unknown>; withheld: boolean; operator_metadata_withheld?: boolean };
export type RowContinuationRequest = { plan: unknown; boundary?: string; page_rows?: number; cursor?: string };
export type RowContinuationDescription = {
  page_rows: number; offset: number; original_result_rows: number; original_query_limit: number;
  source_query_executed_this_call: boolean; reference_expiry: "unchanged"; retained_metadata_scope: "original_query";
};
type Document = {
  request: string; binding: string; plan: ExplorePlan; boundary: string; pageRows: number; expires: number;
  value: Record<string, unknown>; bytes: number; projection: Omit<Projection, "value">;
};
type Cursor = { document: Document; offset: number };

/** Pages one already budgeted, bounded observation. It never compiles another
 * SELECT, extends a proof, issues a reference, or resets the durable privacy
 * meter. The cache contains only the ordinary MODEL projection; normalized
 * request/currentness bindings are control metadata, not source facts. */
export function createScopedRowContinuation(input: {
  current: () => Promise<void>;
  session: () => string;
  validate: (plan: unknown, boundary?: string) => Promise<ScopedExploreValidationResult>;
  explore: (plan: ExplorePlan, boundary?: string) => Promise<Record<string, unknown>>;
  project: (plan: ExplorePlan, boundary: string, result: Record<string, unknown>) => Projection;
  limits: (boundary: string) => { max_rows: number; max_response_bytes: number };
  measure: (value: Record<string, unknown>) => number;
  clock?: () => number;
}) {
  const clock = input.clock ?? Date.now;
  const cursors = new Map<string, Cursor>();
  let calls = 0, disclosedBytes = 0;
  const refuse = (code: string, message: string): never => { throw new ScopedExploreError(code, message); };
  const binding = (validation: ScopedExploreValidationResult) => canonicalJsonDigest({
    session: input.session(), boundary: validation.boundary_name, digest: validation.boundary_digest,
    lock: validation.generation_lock_fingerprint, engine: validation.database_engine,
    scope: validation.trusted_scope, plan: validation.normalized_plan,
  });
  const prune = () => {
    for (const [token, cursor] of cursors) if (cursor.document.expires <= clock()) cursors.delete(token);
  };
  return async (request: RowContinuationRequest): Promise<Projection> => {
    await input.current();
    if (!isRecord(request.plan) || request.plan.kind !== "rows") refuse("EXPLORE_PLAN_INVALID", "Row continuation is available only for one ordinary reviewed rows plan; aggregate results have no row cursor.");
    const pageRows = request.page_rows ?? CATALOG_LIMITS.maxPage;
    if (!Number.isSafeInteger(pageRows) || pageRows < 1 || pageRows > CATALOG_LIMITS.maxPage) refuse("EXPLORE_PLAN_INVALID", "page_rows must be an integer from 1 through 20; retain the original plan's total row limit.");
    if (++calls > CATALOG_LIMITS.sessionCalls) refuse("EXPLORE_CONTINUATION_LIMIT", "This client reached its bounded continuation limit. No source query or disclosure allowance was renewed.");
    prune();
    const requestKey = canonicalJsonDigest({ plan: request.plan, boundary: request.boundary ?? null, page_rows: pageRows });
    let document: Document;
    let offset = 0;
    let queried = false;
    if (request.cursor !== undefined) {
      const cursor = cursors.get(request.cursor);
      if (!cursor || cursor.document.request !== requestKey) refuse("EXPLORE_CURSOR_INVALID", "This row cursor is unavailable for the exact current caller, plan, page size and client session. Use current permitted discovery; no old result or reference was renewed.");
      document = cursor.document;
      // Validate the ORIGINAL normalized interval rather than resolving a new
      // relative interval on a later page. The public request must still match.
      const validated = await input.validate(document.plan, document.boundary);
      if (binding(validated) !== document.binding) refuse("EXPLORE_CURSOR_INVALID", "Reviewed access or the exact query changed. This old observed result cannot be continued under the changed context.");
      offset = cursor.offset;
    } else {
      const validated = await input.validate(request.plan, request.boundary);
      if (validated.normalized_plan.kind !== "rows") refuse("EXPLORE_PLAN_INVALID", "Only a reviewed rows query can start row continuation.");
      const plan = validated.normalized_plan;
      const before = binding(validated);
      const raw = await input.explore(plan, validated.boundary_name);
      const projected = input.project(plan, validated.boundary_name, raw);
      if (projected.value.ok === false) return projected;
      if (!Array.isArray(projected.value.data)) refuse("EXPLORE_CONTINUATION_UNAVAILABLE", "The bounded rows observation is unavailable; no source completeness or effect can be inferred.");
      const limits = input.limits(validated.boundary_name);
      if (projected.value.data.length > plan.limit || plan.limit > limits.max_rows
        || Buffer.byteLength(JSON.stringify(projected.value.data), "utf8") > limits.max_response_bytes) {
        refuse("EXPLORE_CONTINUATION_UNAVAILABLE", "The original result does not fit its reviewed row/response limit. No continuation was returned; the original query retains its ordinary accounting.");
      }
      const bytes = Buffer.byteLength(JSON.stringify(projected.value), "utf8");
      // Finite preparation storage, not a new source extraction allowance.
      const documents = new Set([...cursors.values()].map(cursor => cursor.document));
      while (cursors.size && [...documents].reduce((total, doc) => total + doc.bytes, 0) + bytes > CATALOG_LIMITS.sessionBytes) {
        const oldest = cursors.values().next().value!.document;
        for (const [token, cursor] of cursors) if (cursor.document === oldest) cursors.delete(token);
        documents.delete(oldest);
      }
      if (bytes > CATALOG_LIMITS.sessionBytes) refuse("EXPLORE_CONTINUATION_LIMIT", "This observed result exceeds bounded continuation preparation. No values were truncated and no source allowance was increased.");
      const after = await input.validate(plan, validated.boundary_name);
      if (binding(after) !== before) refuse("EXPLORE_CURSOR_INVALID", "Reviewed access changed while preparing the bounded observation; no continued result is available.");
      document = { request: requestKey, binding: before, plan, boundary: validated.boundary_name, pageRows,
        expires: clock() + CATALOG_LIMITS.cursorMs, value: structuredClone(projected.value), bytes,
        projection: { withheld: projected.withheld, ...(projected.operator_metadata_withheld ? { operator_metadata_withheld: true } : {}) } };
      queried = true;
    }
    const rows = document.value.data as unknown[];
    const returned: unknown[] = [];
    let end = offset;
    const page = (next: string | null): Record<string, unknown> => {
      const value = structuredClone(document.value);
      value.data = returned;
      if (Array.isArray(value.subjects)) value.subjects = value.subjects.filter(subject => isRecord(subject)
        && typeof subject.row_index === "number" && subject.row_index >= offset && subject.row_index < end)
        .map(subject => ({ ...(subject as Record<string, unknown>), row_index: (subject as { row_index: number }).row_index - offset }));
      const description: RowContinuationDescription = { page_rows: pageRows, offset, original_result_rows: rows.length,
        original_query_limit: document.plan.kind === "rows" ? document.plan.limit : 0,
        source_query_executed_this_call: queried, reference_expiry: "unchanged", retained_metadata_scope: "original_query" };
      value.row_continuation = description;
      const outcome = isRecord(value.outcome) ? value.outcome : undefined;
      const result = outcome && isRecord(outcome.result) ? outcome.result : undefined;
      if (result) result.returned = visibleCounts(returned);
      if (result) result.pagination = { page_item_count: returned.length, has_more: next !== null, next_cursor: next,
        total: { kind: "exact_bounded_query_result", value: rows.length }, continuation: "same_bounded_result",
        consistency: "fixed_original_query_result",
        guidance: "Continue this bounded original observation with the same plan/page_rows and returned cursor. Its total is not the source population. Source facts may have changed; original subject references retain their original expiry. Retained audit, remaining-budget and freshness metadata describe the original query, not a refreshed budget or source. No new query, reference or snapshot guarantee follows from a page." };
      value.next_cursor = next;
      return value;
    };
    while (end < rows.length && returned.length < pageRows) {
      returned.push(structuredClone(rows[end]!)); end++;
      const measured = input.measure(page(end < rows.length ? `cur_${"a".repeat(43)}` : null));
      if (measured > CATALOG_LIMITS.responseBytes) {
        returned.pop(); end--;
        if (!returned.length) refuse("EXPLORE_ROW_TOO_LARGE", "One indivisible observed row does not fit the supported MCP response. No field was omitted or sliced; use a smaller otherwise permitted projection in a separate normal query.");
        break;
      }
    }
    const next = end < rows.length ? `cur_${randomBytes(32).toString("base64url")}` : null;
    const value = page(next);
    await input.current();
    // Ordinary re-projection precedes the FINAL outgoing-size/accounting check.
    // It renews only per-response opaque private-cell labels, not source facts.
    const projected = input.project(document.plan, document.boundary, value);
    const outcome = isRecord(projected.value.outcome) ? projected.value.outcome : undefined;
    const result = outcome && isRecord(outcome.result) ? outcome.result : undefined;
    if (result && Array.isArray(projected.value.data)) result.returned = visibleCounts(projected.value.data);
    const size = input.measure(projected.value);
    if (size > CATALOG_LIMITS.responseBytes || disclosedBytes + size > CATALOG_LIMITS.sessionBytes) refuse("EXPLORE_CONTINUATION_LIMIT", "This client reached its cumulative continuation disclosure limit; no source allowance was renewed.");
    disclosedBytes += size;
    if (next) {
      while (cursors.size >= CATALOG_LIMITS.cursors) cursors.delete(cursors.keys().next().value!);
      cursors.set(next, { document, offset: end });
    }

    return { ...projected, withheld: document.projection.withheld || projected.withheld,
      ...(document.projection.operator_metadata_withheld || projected.operator_metadata_withheld ? { operator_metadata_withheld: true } : {}) };
  };
}
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function visibleCounts(rows: unknown[]) {
  return { rows_or_groups: rows.length, cells: rows.reduce<number>((total, row) => total + (isRecord(row) ? Object.keys(row).length : 0), 0),
    bytes: Buffer.byteLength(JSON.stringify(rows), "utf8") };
}
