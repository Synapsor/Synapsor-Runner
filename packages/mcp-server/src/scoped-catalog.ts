import { randomBytes } from "node:crypto";
import { McpRuntimeError } from "./runtime-errors.js";

export const CATALOG_LIMITS = Object.freeze({
  defaultPage: 5, maxPage: 20, queryCharacters: 256, queryTerms: 16,
  responseBytes: 16_384, detailBytes: 12_288, cursorMs: 300_000,
  sessionCalls: 80, sessionRecords: 300, sessionBytes: 262_144,
  maxEntries: 10_000, maxSearchWork: 10_000, cursors: 128,
});

export type CatalogRequest = { query?: string; limit?: number; cursor?: string; detail?: string };

/** Budget both MCP representations, including the prettified compatibility
 * text and maximum disclosure metadata used by the supported transports. */
export function catalogResponseBytes(value: Record<string, unknown>, format: "pretty" | "compact" = "pretty"): number {
  return Buffer.byteLength(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(value, null, format === "pretty" ? 2 : undefined) }], structuredContent: value,
    _meta: { "synapsor.model_withheld_values": true, "synapsor.operator_metadata_withheld": true },
  }));
}
export type CatalogEntry = {
  id: string;
  title: string;
  summary: string;
  aliases?: string[];
  value: Record<string, unknown>;
  detail: () => Record<string, unknown>;
};
type SearchMatch = { kind: "exact_id" | "exact_name" | "phrase" | "all_terms" | "partial";
  matched_terms: string[]; missing_terms: string[] };

// The caller constructs this index only AFTER resolving current static
// authorization. No denied entry participates in search, ranking or cursors.
export class ScopedCatalogIndex {
  readonly ids: string[];
  private readonly entries = new Map<string, CatalogEntry>();
  private readonly postings = new Map<string, Map<string, number>>();
  private readonly strongPostings = new Map<string, Set<string>>();

  constructor(entries: CatalogEntry[]) {
    if (entries.length > CATALOG_LIMITS.maxEntries) throw catalogError("CATALOG_TOO_LARGE", "The reviewed catalog exceeds the supported entry limit.");
    for (const entry of entries) {
      if (this.entries.has(entry.id)) throw catalogError("CATALOG_INVALID", "The reviewed catalog contains duplicate entries.");
      if (entry.id.length > 512 || entry.title.length > 160 || entry.summary.length > 400
        || (entry.aliases?.length ?? 0) > 16 || entry.aliases?.some((alias) => alias.length > 80)) {
        throw catalogError("CATALOG_INVALID", "A reviewed catalog description exceeds its bounded contract.");
      }
      this.entries.set(entry.id, entry);
      for (const [text, weight] of [[entry.id, 1], [entry.title, 4], [entry.summary, 1],
        ...(entry.aliases ?? []).map((alias) => [alias, 3])] as Array<[string, number]>) {
        for (const term of new Set(terms(text))) {
          let posting = this.postings.get(term);
          if (!posting) this.postings.set(term, posting = new Map());
          posting.set(entry.id, (posting.get(entry.id) ?? 0) + weight);
          if (weight > 1) {
            let strong = this.strongPostings.get(term);
            if (!strong) this.strongPostings.set(term, strong = new Set());
            strong.add(entry.id);
          }
        }
      }
    }
    this.ids = [...this.entries.keys()].sort(compareIds);
  }

  get(id: string): CatalogEntry | undefined { return this.entries.get(id); }

  search(query: string): { ids: string[]; visited: number; matches?: Record<string, SearchMatch> } {
    const tokens = searchTerms(query);
    if (tokens.length > CATALOG_LIMITS.queryTerms) throw catalogError("ARGUMENT_INVALID", "Use at most 16 search terms.");
    if (!tokens.length) return { ids: query.trim() ? [] : this.ids, visited: 0 };
    const candidates = new Map<string, { matched: string[]; score: number; strong: boolean }>();
    let work = 0;
    const postings = tokens.map(token => this.postings.get(token));
    // Preserve selective multiword lookup: intersect from the rarest posting
    // before considering partial alternatives from a broader union.
    if (postings.every(posting => posting !== undefined)) {
      const smallest = postings.reduce((a, b) => a!.size <= b!.size ? a : b)!;
      for (const id of smallest.keys()) {
        if (++work > CATALOG_LIMITS.maxSearchWork) throw catalogError("CATALOG_QUERY_TOO_BROAD", "Narrow the search or browse the paginated catalog.");
        if (postings.every(posting => posting!.has(id))) candidates.set(id, {
          matched: tokens, score: postings.reduce((sum, posting) => sum + posting!.get(id)!, 0), strong: true,
        });
      }
    }
    if (!candidates.size) for (const token of tokens) for (const [id, score] of this.postings.get(token) ?? []) {
        if (++work > CATALOG_LIMITS.maxSearchWork) throw catalogError("CATALOG_QUERY_TOO_BROAD", "Narrow the search or browse the paginated catalog.");
        const candidate = candidates.get(id) ?? { matched: [], score: 0, strong: false };
        candidate.matched.push(token); candidate.score += score;
        // A bare number is insufficient to anchor a partial suggestion.
        candidate.strong ||= /\p{L}/u.test(token) && this.strongPostings.get(token)?.has(id) === true;
        candidates.set(id, candidate);
    }
    const normalized = searchSequence(query).join(" ");
    const ranked: Array<{ id: string; tier: number; score: number; match: SearchMatch }> = [];
    for (const [id, candidate] of candidates) {
      const entry = this.entries.get(id)!;
      const complete = candidate.matched.length === tokens.length;
      const names = [entry.title, ...(entry.aliases ?? [])].map(text => searchSequence(text).join(" "));
      const exactId = searchSequence(id).join(" ") === normalized;
      const exactName = names.includes(normalized);
      const phrase = names.some(name => (` ${name} `).includes(` ${normalized} `));
      // Partial fallback requires a strong reviewed name/alias anchor and at
      // least half the meaningful query terms. It is never substring or
      // unrestricted OR matching, and is used only when no complete hit exists.
      if (!complete && (!candidate.strong || candidate.matched.length < Math.ceil(tokens.length / 2)
        || tokens.some(token => /^\p{N}+$/u.test(token) && !candidate.matched.includes(token)))) continue;
      const kind = exactId ? "exact_id" : exactName ? "exact_name" : phrase ? "phrase" : complete ? "all_terms" : "partial";
      ranked.push({ id, tier: exactId ? 4 : exactName ? 3 : phrase ? 2 : complete ? 1 : 0, score: candidate.score,
        match: { kind, matched_terms: candidate.matched, missing_terms: tokens.filter(token => !candidate.matched.includes(token)) } });
    }
    const completeHits = ranked.some(hit => hit.tier > 0);
    const selected = ranked.filter(hit => !completeHits || hit.tier > 0)
      .sort((a, b) => b.tier - a.tier || b.score - a.score || compareIds(a.id, b.id));
    return { ids: selected.map(hit => hit.id), visited: work,
      matches: Object.fromEntries(selected.map(hit => [hit.id, hit.match])) };
  }
}

type Cursor = {
  binding: string; query: string; limit: number; expires: number; offset: number;
  ids: string[]; legacy: boolean;
  matches?: Record<string, SearchMatch>;
  next?: string;
};

/** One server-side discovery budget, never reset by catalog edits or cursors. */
export class ScopedCatalogSession {
  private calls = 0;
  private records = 0;
  private bytes = 0;
  private readonly cursors = new Map<string, Cursor>();
  constructor(private readonly clock: () => number = Date.now) {}

  describe(input: {
    index: ScopedCatalogIndex;
    /** Private current scope + catalog + delegation revisions, never model input. */
    binding: string;
    request: CatalogRequest;
    legacy?: boolean;
    key: "actions" | "resources";
    context?: Record<string, unknown>;
    /** A scoped asynchronous provider may prepare the exact entry first. */
    detailValue?: Record<string, unknown>;
    /** Account for the actual model projection before choosing a page size. */
    measureResponse?: (value: Record<string, unknown>) => number;
    /** Use the disclosed entry representation, not an unprojected operator record. */
    measureDetail?: (value: Record<string, unknown>) => number;
  }): Record<string, unknown> {
    const { request, index } = input;
    const measure = input.measureResponse ?? catalogResponseBytes;
    if (request.detail !== undefined && (request.query !== undefined || request.cursor !== undefined || request.limit !== undefined)) {
      throw catalogError("ARGUMENT_INVALID", "Use an exact entry alone, without search or pagination arguments.");
    }
    const limit = request.limit ?? CATALOG_LIMITS.defaultPage;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CATALOG_LIMITS.maxPage
      || (request.query?.length ?? 0) > CATALOG_LIMITS.queryCharacters) {
      throw catalogError("ARGUMENT_INVALID", "Use limit 1 through 20 and a query of at most 256 characters.");
    }
    if (++this.calls > CATALOG_LIMITS.sessionCalls) throw budgetError();
    const query = (request.query ?? "").normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
    const now = this.clock();
    for (const [token, cursor] of this.cursors) if (cursor.expires <= now) this.cursors.delete(token);
    let page: Cursor;
    let visited = 0;
    if (request.cursor) {
      const cursor = this.cursors.get(request.cursor);
      if (!cursor || cursor.binding !== input.binding || cursor.query !== query || cursor.limit !== limit) {
        throw catalogError("CATALOG_CURSOR_INVALID", "This page cannot be continued. Restart discovery in the current session and scope.");
      }
      page = cursor;
    } else {
      const found = request.detail ? { ids: index.get(request.detail) ? [request.detail] : [], visited: 0 } : index.search(query);
      visited = found.visited;
      if (request.detail && !found.ids.length) {
        throw catalogError("CATALOG_ENTRY_UNAVAILABLE", "That entry is not available in the current authorized catalog.");
      }
      page = { binding: input.binding, query, limit, ids: found.ids, offset: 0,
        expires: now + CATALOG_LIMITS.cursorMs, legacy: input.legacy === true,
        ...("matches" in found ? { matches: found.matches as Record<string, SearchMatch> } : {}) };
    }
    const values: Record<string, unknown>[] = [];
    const body = (): Record<string, unknown> => ({
      ...input.context, ok: true, catalog_version: "synapsor.scoped-catalog.v2",
      [input.key]: values, next_cursor: null,
      pagination: { page_item_count: values.length, has_more: offset < page.ids.length,
        total: { kind: "exact", value: page.ids.length }, consistency: "fixed_authorized_catalog" },
      discovery: { mode: request.detail ? "detail" : page.legacy ? "bounded_compatibility" : "summary",
        search_status: !query ? "no_query" : !page.ids.length ? "no_matches"
          : page.matches && Object.values(page.matches).every(match => match.kind === "partial") ? "partial_matches" : "matches",
        eligibility: "not_checked", ...(query && !page.ids.length ? { empty_search: "no_matches_to_this_query" } : {}),
        next_step: "Search or browse a shortlist, request exact details, then use the selected contract. Discovery grants no authority." },
      source_database_changed: false,
    });
    let offset = page.offset;
    while (offset < page.ids.length && values.length < limit) {
      const entry = index.get(page.ids[offset]!);
      if (!entry) throw catalogError("CATALOG_CURSOR_INVALID", "The catalog changed; restart discovery.");
      const value = structuredClone(request.detail && input.detailValue
        ? input.detailValue : request.detail || page.legacy ? entry.detail() : entry.value);
      if (page.matches?.[entry.id]) value.search_match = page.matches[entry.id];
      const detailBytes = input.measureDetail?.(value) ?? Buffer.byteLength(JSON.stringify(value));
      if (detailBytes > CATALOG_LIMITS.detailBytes) {
        throw catalogContractSizeError("entry", detailBytes, CATALOG_LIMITS.detailBytes);
      }
      values.push(value);
      // Include cursor-dependent presentation before pagination. Never split
      // or truncate an executable contract to fit the transport envelope.
      const responseBytes = measure({ ...body(), next_cursor: request.detail ? null : `cur_${"a".repeat(43)}` });
      if (responseBytes > CATALOG_LIMITS.responseBytes) {
        values.pop();
        if (!values.length) throw catalogContractSizeError("response", responseBytes, CATALOG_LIMITS.responseBytes);
        break;
      }
      offset++;
    }
    const result = body();
    let next: string | undefined;
    if (offset < page.ids.length) {
      next = page.next ?? `cur_${randomBytes(32).toString("base64url")}`;
      result.next_cursor = next;
    }
    const size = measure(result);
    if (size > CATALOG_LIMITS.responseBytes) throw catalogContractSizeError("response", size, CATALOG_LIMITS.responseBytes);
    if (this.records + values.length > CATALOG_LIMITS.sessionRecords || this.bytes + size > CATALOG_LIMITS.sessionBytes) throw budgetError();
    this.records += values.length;
    this.bytes += size;
    if (next) {
      page.next = next;
      if (!this.cursors.has(next)) {
        while (this.cursors.size >= CATALOG_LIMITS.cursors) this.cursors.delete(this.cursors.keys().next().value!);
        this.cursors.set(next, { ...page, offset, next: undefined });
      }
    }
    this.lastWork = { visited, returned: values.length, bytes: size };
    return result;
  }

  /** Operator/test instrumentation; not a model-visible cross-scope count. */
  lastWork = { visited: 0, returned: 0, bytes: 0 };
}

export function catalogContractSizeError(kind: "entry" | "response", measured: number, limit: number): McpRuntimeError {
  return new McpRuntimeError("CATALOG_CONTRACT_TOO_LARGE",
    `The complete reviewed contract does not fit the ${kind} disclosure limit (${measured} bytes; maximum ${limit}). `
    + "No constraints were truncated. Repeating the lookup or changing the page size will not help. "
    + "Ask the operator to open Boundary review, inspect Discovery compatibility, and revise this resource's reviewed metadata or scope; then review and activate the replacement. Do not guess permissions.",
    { kind, measured_bytes: measured, limit_bytes: limit, retryable: false, recovery: "operator_boundary_review" });
}

function terms(text: string): string[] { return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; }
// Grammar words, never business verbs (approve/reject, remove/restore, etc.).
const SEARCH_GRAMMAR_WORDS = new Set(["a", "an", "the", "for", "of", "to", "with", "please"]);
function searchTerms(text: string): string[] {
  return [...new Set(searchSequence(text))];
}
function searchSequence(text: string): string[] { return terms(text).filter(token => !SEARCH_GRAMMAR_WORDS.has(token)); }
function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function budgetError(): McpRuntimeError { return catalogError("CATALOG_SESSION_LIMIT", "This session reached its discovery limit. Use the already reviewed shortlist; further catalog disclosure requires a new authorized session."); }
function catalogError(code: string, message: string): McpRuntimeError { return new McpRuntimeError(code, message); }
