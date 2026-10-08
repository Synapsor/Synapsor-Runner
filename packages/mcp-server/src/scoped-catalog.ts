import { randomBytes } from "node:crypto";
import { McpRuntimeError } from "./runtime-errors.js";
import { CONTRACT_SECTION_INDEX, contractSections, selectContractItems, type ContractDocument, type ContractNavigation, type ContractSectionPage } from "./catalog-detail-sections.js";
import { withResultEvidence } from "./result-evidence.js";

export const CATALOG_LIMITS = Object.freeze({
  defaultPage: 5, maxPage: 20, queryCharacters: 256, queryTerms: 16,
  responseBytes: 16_384, detailBytes: 12_288, cursorMs: 300_000,
  sessionCalls: 80, sessionRecords: 300, sessionBytes: 262_144,
  maxEntries: 10_000, maxSearchWork: 10_000, cursors: 128,
});

export type CatalogRequest = { query?: string; limit?: number; cursor?: string; detail?: string; section?: string; item?: string; contract_revision?: string };

/** Budget both MCP representations, including the prettified compatibility
 * text and maximum disclosure metadata used by the supported transports. */
export function catalogResponseBytes(value: Record<string, unknown>, format: "pretty" | "compact" = "pretty"): number {
  const tool = value.policy_view === "agent_rules" && value.source === "runner_control_plane"
    ? Array.isArray(value.actions) ? "app.describe_actions" : value.review ? "app.request_change"
      : value.control_ref || value.section ? "app.explore_data" : "app.describe_data"
    : Array.isArray(value.actions) ? "app.describe_actions" : "app.describe_data";
  const modelResult = withResultEvidence(tool, value);
  return Buffer.byteLength(JSON.stringify({
    content: [{ type: "text", text: JSON.stringify(modelResult, null, format === "pretty" ? 2 : undefined) }], structuredContent: modelResult,
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

  search(query: string): { ids: string[]; visited: number; matches?: Record<string, SearchMatch>; unambiguous_id?: string } {
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
    // Ranking identifies possibilities. Only a unique exact tier, or a sole
    // complete hit, supports an inline contract; score/order alone is not intent.
    const top = selected[0];
    const unambiguous = top && top.match.kind !== "partial" && (selected.length === 1
      || (top.tier >= 3 && selected[1]!.tier < top.tier));
    return { ids: selected.map(hit => hit.id), visited: work,
      ...(unambiguous ? { unambiguous_id: top.id } : {}),
      matches: Object.fromEntries(selected.map(hit => [hit.id, hit.match])) };
  }
}

type Cursor = {
  binding: string; query: string; limit: number; expires: number; offset: number;
  ids: string[]; legacy: boolean;
  matches?: Record<string, SearchMatch>;
  unambiguousId?: string;
  next?: string;
  contract?: { detail: string; section: string; item?: string; revision: string };
};

/** One server-side discovery budget, never reset by catalog edits or cursors. */
export class ScopedCatalogSession {
  private calls = 0;
  private records = 0;
  private bytes = 0;
  private readonly cursors = new Map<string, Cursor>();
  private readonly documents = new Map<string, ContractDocument & { expires: number; unitsFramed: boolean; sectionLimit: number; value: Record<string, unknown>; context: Record<string, unknown> }>();
  constructor(private readonly clock: () => number = Date.now) {}

  /** Read-through public metadata cache only. The caller must establish the
   * current trusted binding first; returning it does not consume or renew any
   * disclosure budget. The eventual describe call still meters the response. */
  preparedContract(binding: string, key: "actions" | "resources", detail: string) {
    const document = this.documents.get(`${binding}\0${key}\0${detail}`);
    return document && document.expires > this.clock() ? { value: document.value, context: document.context } : undefined;
  }

  describe(input: {
    index: ScopedCatalogIndex;
    /** Private current scope + catalog + delegation revisions, never model input. */
    binding: string;
    request: CatalogRequest;
    /** Optional single-pass search prepared by this same authorized index. */
    searchResult?: ReturnType<ScopedCatalogIndex["search"]>;
    legacy?: boolean;
    key: "actions" | "resources";
    context?: Record<string, unknown>;
    /** A scoped asynchronous provider may prepare the exact entry first. */
    detailValue?: Record<string, unknown>;
    /** Exact public projection used for sections. Never pass a raw operator
     * descriptor here when its normal model projection withholds information. */
    sectionValue?: Record<string, unknown>;
    /** The owning projection's public context, for read-through cached sections. */
    sectionContext?: Record<string, unknown>;
    /** Prepared ONLY through the same current authorization/projection as exact
     * detail. The index's listing permission never calls entry.detail for inline. */
    inlineDetail?: { id: string; value: Record<string, unknown>; nextSteps?: Record<string, unknown>[] };
    detailNextSteps?: Record<string, unknown>[];
    inlineUnavailable?: boolean;
    /** Actual public tool grammar, supplied by the owning runtime. */
    exactDetailArguments?: (id: string) => Record<string, unknown>;
    continuationArguments?: (cursor: string) => Record<string, unknown>;
    catalogTool?: string;
    /** Some existing settings catalogs already return full metadata entries. */
    completeListing?: boolean;
    /** Account for the actual model projection before choosing a page size. */
    measureResponse?: (value: Record<string, unknown>) => number;
    /** Use the disclosed entry representation, not an unprojected operator record. */
    measureDetail?: (value: Record<string, unknown>) => number;
  }): Record<string, unknown> {
    const { request, index } = input;
    const measure = input.measureResponse ?? catalogResponseBytes;
    if ((request.section !== undefined || request.item !== undefined || request.contract_revision !== undefined) && request.detail === undefined
      || (request.item !== undefined || request.contract_revision !== undefined) && request.section === undefined
      || request.detail !== undefined && (request.query !== undefined
        || request.section === undefined && (request.cursor !== undefined || request.limit !== undefined))) {
      throw catalogError("ARGUMENT_INVALID", "Use an exact entry alone, without search or pagination arguments.");
    }
    const limit = request.limit ?? CATALOG_LIMITS.defaultPage;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > CATALOG_LIMITS.maxPage
      || (request.query?.length ?? 0) > CATALOG_LIMITS.queryCharacters) {
      throw catalogError("ARGUMENT_INVALID", "Use limit 1 through 20 and a query of at most 256 characters.");
    }
    if (++this.calls > CATALOG_LIMITS.sessionCalls) throw budgetError();
    if (request.detail && request.section !== undefined) {
      const entry = index.get(request.detail);
      if (!entry) throw catalogError("CATALOG_ENTRY_UNAVAILABLE", "That entry is not available in the current authorized catalog.");
      return this.contractPage(input, input.sectionValue ?? input.detailValue ?? entry.detail());
    }
    const query = (request.query ?? "").normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
    const now = this.clock();
    for (const [token, cursor] of this.cursors) if (cursor.expires <= now) this.cursors.delete(token);
    let page: Cursor;
    let visited = 0;
    if (request.cursor) {
      const cursor = this.cursors.get(request.cursor);
      if (!cursor || cursor.contract || cursor.binding !== input.binding || cursor.query !== query || cursor.limit !== limit) {
        throw catalogError("CATALOG_CURSOR_INVALID", "This page cannot be continued. Restart discovery in the current session and scope.");
      }
      page = cursor;
    } else {
      const found = request.detail ? { ids: index.get(request.detail) ? [request.detail] : [], visited: 0 } : input.searchResult ?? index.search(query);
      visited = found.visited;
      if (request.detail && !found.ids.length) {
        throw catalogError("CATALOG_ENTRY_UNAVAILABLE", "That entry is not available in the current authorized catalog.");
      }
      page = { binding: input.binding, query, limit, ids: found.ids, offset: 0,
        expires: now + CATALOG_LIMITS.cursorMs, legacy: input.legacy === true,
        ...("matches" in found ? { matches: found.matches as Record<string, SearchMatch> } : {}),
        ...("unambiguous_id" in found ? { unambiguousId: found.unambiguous_id as string } : {}) };
    }
    const values: Record<string, unknown>[] = [];
    const tool = input.catalogTool ?? (input.key === "actions" ? "app.describe_actions" : "app.describe_data");
    const exactArguments = (id: string) => input.exactDetailArguments?.(id)
      ?? (input.key === "actions" ? { outcome: id } : { resource: id });
    const continuationArguments = (cursor: string) => input.continuationArguments?.(cursor)
      ?? { ...(request.query !== undefined ? { query: request.query } : {}), limit, cursor };
    let inline: Record<string, unknown> | undefined;
    let inlineStatus: string | undefined = input.inlineUnavailable ? "detail_unavailable_in_current_scope" : undefined;
    const nextSteps = (next: string | null): Record<string, unknown>[] => {
      if (request.detail) return input.detailNextSteps ?? [{ kind: "inspect_selected_contract", guidance: "Use this complete current contract; missing caller values remain unknown." }];
      const steps: Record<string, unknown>[] = [];
      if (inline) steps.push(...input.inlineDetail?.nextSteps ?? [{ kind: "inspect_selected_contract", guidance: "Review the complete inline contract before choosing an operation." }]);
      else if (page.unambiguousId) steps.push({ kind: "inspect_exact_details", tool, arguments: exactArguments(page.unambiguousId) });
      else if (!page.ids.length) steps.push(query
        ? { kind: "revise_query", guidance: "No authorized metadata matches this query. Ask the caller to clarify or browse the current catalog; absence is not removal proof." }
        : { kind: "review_catalog_availability", guidance: "The current authorized metadata catalog is empty. Ask the operator to inspect reviewed availability; absence is not removal proof." });
      else if (query) steps.push({ kind: "clarify_intent", guidance: "These are alternatives, not a selected operation. Ask the caller or narrow the query before choosing exact details." });
      if (next) steps.push({ kind: "continue_page", tool, arguments: continuationArguments(next) });
      else if (!query && !request.detail && page.ids.length) steps.push(input.completeListing
        ? { kind: "inspect_page_entries", guidance: "Inspect these complete current permitted metadata entries; catalog disclosure grants no authority." }
        : { kind: "inspect_exact_details", guidance: "Choose the intended listed entry and use its exact public identifiers for detail; this exhausted page completes authorized metadata only." });
      return steps;
    };
    // Large accepted Read details already carry complete next_action/grammar.
    // Keep their compact envelope; listing guidance must not displace a valid
    // exact contract at the existing disclosure limit.
    const compactReadDetail = request.detail !== undefined && input.key === "resources" && input.detailNextSteps === undefined;
    const body = (next: string | null = null): Record<string, unknown> => ({
      ok: true, catalog_version: "synapsor.scoped-catalog.v2",
      discovery: { mode: request.detail ? "detail" : page.legacy ? "bounded_compatibility" : "summary",
        search_status: !query ? "no_query" : !page.ids.length ? "no_matches"
          : page.matches && Object.values(page.matches).every(match => match.kind === "partial") ? "partial_matches" : "matches",
        ...(!compactReadDetail ? { match_status: !query ? "not_searched" : !page.ids.length ? "no_matches" : page.unambiguousId ? "unambiguous_match"
          : page.matches && Object.values(page.matches).every(match => match.kind === "partial") ? "partial_alternatives" : "ambiguous_alternatives",
        contract_status: request.detail || page.legacy ? "complete_exact_details" : input.completeListing ? "complete_listing_entries" : inline ? "inline_complete" : "exact_detail_required",
        ...(inlineStatus ? { inline_status: inlineStatus } : {}),
        currentness: "checked_current_authority", scope: "authorized_catalog_metadata", next_steps: nextSteps(next) } : {}),
        eligibility: "not_checked",
        ...(query && !page.ids.length ? { empty_search: "no_matches_to_this_query" } : {}),
        next_step: compactReadDetail
          ? "Search or browse a shortlist, request exact details, then use the selected contract. Discovery grants no authority."
          : "Discovery gives possible operations and permitted metadata, not caller intent, eligibility or execution authority." },
      pagination: { page_item_count: values.length, has_more: offset < page.ids.length,
        ...(!compactReadDetail ? { state: request.detail ? "exact_detail" : query && !page.ids.length ? "no_matches" : offset < page.ids.length ? "more_pages" : "exhausted",
        scope: "authorized_catalog_metadata" } : {}),
        total: { kind: "exact", value: page.ids.length }, consistency: "fixed_authorized_catalog" },
      ...input.context, [input.key]: values, ...(inline ? { inline_contract: inline } : {}), next_cursor: next,
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
        if (request.detail) return this.contractPage(input, input.sectionValue ?? value);
        throw catalogContractSizeError("entry", detailBytes, CATALOG_LIMITS.detailBytes);
      }
      values.push(value);
      // Include cursor-dependent presentation before pagination. Never split
      // or truncate an executable contract to fit the transport envelope.
      const responseBytes = measure(body(request.detail || offset + 1 >= page.ids.length ? null : `cur_${"a".repeat(43)}`));
      if (responseBytes > CATALOG_LIMITS.responseBytes) {
        values.pop();
        if (!values.length) {
          if (request.detail) return this.contractPage(input, input.sectionValue ?? value);
          throw catalogContractSizeError("response", responseBytes, CATALOG_LIMITS.responseBytes);
        }
        break;
      }
      offset++;
    }
    let next: string | undefined;
    if (offset < page.ids.length) {
      next = page.next ?? `cur_${randomBytes(32).toString("base64url")}`;
    }
    if (!request.detail && !page.legacy && page.offset === 0 && input.inlineDetail
      && input.inlineDetail.id === page.unambiguousId && values.length > 0) {
      const candidate = structuredClone(input.inlineDetail.value);
      const detailBytes = input.measureDetail?.(candidate) ?? Buffer.byteLength(JSON.stringify(candidate));
      inline = candidate;
      if (detailBytes > CATALOG_LIMITS.detailBytes || measure(body(next ?? null)) > CATALOG_LIMITS.responseBytes) {
        inline = undefined;
        inlineStatus = "complete_contract_exceeds_inline_bound";
      }
    }
    const result = body(next ?? null);
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

  /** Same authorization binding, cursor store, call/record/byte meter and
   * transport measurement as ordinary exact detail. A section is not a new
   * business capability or a new disclosure allowance. */
  private contractPage(input: Parameters<ScopedCatalogSession["describe"]>[0], value: Record<string, unknown>): Record<string, unknown> {
    const { request } = input;
    const detail = request.detail!;
    const measure = input.measureResponse ?? catalogResponseBytes;
    const now = this.clock();
    for (const [key, document] of this.documents) if (document.expires <= now) this.documents.delete(key);
    for (const [key, cursor] of this.cursors) if (cursor.expires <= now) this.cursors.delete(key);
    const documentKey = `${input.binding}\0${input.key}\0${detail}`;
    let document = this.documents.get(documentKey);
    if (request.contract_revision !== undefined && document?.revision !== request.contract_revision) {
      throw catalogError("CATALOG_CURSOR_INVALID", "This exact contract revision is no longer available in the current session, authority and scope.");
    }
    if (!document) {
      const preparedValue = structuredClone(value);
      const prepared = contractSections(preparedValue, CATALOG_LIMITS.detailBytes, CATALOG_LIMITS.sessionBytes);
      const context = structuredClone(input.sectionContext ?? {});
      const bytes = prepared.bytes + Buffer.byteLength(JSON.stringify(context), "utf8");
      if (bytes > CATALOG_LIMITS.sessionBytes) throw catalogError("CATALOG_DETAIL_WORK_LIMIT", "The public contract and context exceed the bounded detail-preparation limit; no metadata was truncated.");
      // Cache only bounded PUBLIC metadata, not source facts or private policy.
      // Eviction invalidates dependent cursors; it never changes their identity.
      while (this.documents.size && [...this.documents.values()].reduce((sum, item) => sum + item.bytes, 0) + bytes > CATALOG_LIMITS.sessionBytes) {
        this.documents.delete(this.documents.keys().next().value!);
      }
      document = { ...prepared, bytes, unitsFramed: false, sectionLimit: request.limit ?? CATALOG_LIMITS.maxPage,
        value: preparedValue, context, revision: `rev_${randomBytes(32).toString("base64url")}`, expires: now + CATALOG_LIMITS.cursorMs };
      this.documents.set(documentKey, document);
    }
    const tool = input.catalogTool ?? (input.key === "actions" ? "app.describe_actions" : "app.describe_data");
    const exact = input.exactDetailArguments?.(detail) ?? (input.key === "actions" ? { outcome: detail } : { resource: detail });
    const identity: Record<string, unknown> = input.key === "actions" ? { outcome: String(value.outcome ?? detail) }
      : { id: String(value.id ?? detail), ...(typeof value.boundary_name === "string" ? { boundary_name: value.boundary_name } : {}) };
    const limit = request.limit ?? CATALOG_LIMITS.defaultPage;
    const indexMode = request.section === undefined || request.section === CONTRACT_SECTION_INDEX;
    if (indexMode && request.item !== undefined) throw catalogError("ARGUMENT_INVALID", "Use the section index without an item selector; select an exact returned section first.");
    const args = (section: string, cursor?: string) => ({ ...exact, section, contract_revision: document!.revision, ...(request.item ? { item: request.item } : {}), limit, ...(cursor ? { cursor } : {}) });
    const stub = { ...identity, contract_status: "partial_navigable" };
    const response = (part: Record<string, unknown>, total: number, offset: number, count: number, next: string | null, reuseContext = request.contract_revision !== undefined): Record<string, unknown> => {
      const pageSection = part.contract_section as ContractSectionPage | undefined;
      return {
      ...(reuseContext ? typeof input.context?.boundary_name === "string" ? { boundary_name: input.context.boundary_name } : {} : input.context),
      ok: true, catalog_version: "synapsor.scoped-catalog.v2", [input.key]: [stub],
      discovery: { mode: pageSection ? "section" : "overview", contract_status: "partial_navigable",
        currentness: "checked_current_authority", eligibility: "not_checked", scope: "authorized_contract_metadata",
        context_basis: reuseContext ? "same_previously_disclosed_contract_revision" : "included_in_this_response",
        next_steps: pageSection ? next ? [{ kind: "continue_contract_section", tool, arguments: args(pageSection.section, next) }]
          : [{ kind: "inspect_contract_sections", tool, arguments: exact,
            guidance: "This section/selection ended; other sections remain separate. Missing inputs/constraints are not permission." }]
          : next ? [{ kind: "continue_contract_index", tool, arguments: args(CONTRACT_SECTION_INDEX, next) }]
            : [{ kind: "inspect_contract_sections", guidance: "Use each contract_navigation next_call; every section-index page and section is required for the complete contract." }] },
      pagination: { page_item_count: count, has_more: next !== null, state: next ? "more_pages" : "exhausted",
        total: { kind: "exact", value: total }, scope: pageSection ? "selected_contract_section" : "contract_section_index",
        consistency: "fixed_authorized_contract" },
      ...part, next_cursor: next, source_database_changed: false,
      };
    };
    let result: Record<string, unknown>;
    if (indexMode) {
      // A navigable overview must not advertise a continuation already known
      // to be impossible. Check whole units including actual transport framing.
      if (!document.unitsFramed) for (const section of document.sections) for (const unit of section.items) {
        const probe = response({ contract_section: { subject: String(identity.outcome ?? identity.id), revision: document.revision,
          section: section.section, representation: section.representation, items: [unit], complete_section: section.items.length === 1 } },
          section.items.length, 0, 1, section.items.length > 1 ? `cur_${"a".repeat(43)}` : null, true);
        const size = measure(probe);
        if (size > CATALOG_LIMITS.responseBytes) {
          this.documents.delete(documentKey);
          throw catalogContractSizeError("response", size, CATALOG_LIMITS.responseBytes);
        }
      }
      document.unitsFramed = true;
      let offset = 0;
      if (request.cursor) {
        const cursor = this.cursors.get(request.cursor);
        if (!cursor || cursor.binding !== input.binding || cursor.limit !== limit || cursor.contract?.detail !== detail
          || cursor.contract.section !== CONTRACT_SECTION_INDEX || cursor.contract.revision !== document.revision) {
          throw catalogError("CATALOG_CURSOR_INVALID", "This section index cannot be continued in the current session, authority and scope.");
        }
        offset = cursor.offset;
      }
      const start = offset;
      const selected: ContractNavigation["sections"] = [];
      const page = (next: string | null) => {
        const navigation: ContractNavigation = { subject: String(identity.outcome ?? identity.id), revision: document!.revision,
          complete_contract: false, complete_section_index: start === 0 && offset === document!.sections.length,
          sections: selected,
          reconstruction: "Keep the public context from the first response, then use all section-index pages and every exact section in this revision. Arrays retain returned position keys; objects retain keys; value sections retain one whole value. Empty sections remain explicit. A page or selected item is not the whole contract." };
        return response({ contract_navigation: navigation }, document!.sections.length, start, selected.length, next);
      };
      while (offset < document.sections.length && selected.length < limit) {
        const section = document.sections[offset]!;
        selected.push({ section: section.section, representation: section.representation, item_count: section.items.length,
          // The index remains a short list. Its default must not force every
          // field/permission section into tiny pages whose repeated framing
          // exhausts the same cumulative disclosure budget. Recommend the
          // existing bounded section maximum unless initially chosen explicitly.
          // An index cursor carries its own limit, not a new section choice.
          // Explicit section requests still apply; every page fits its wire limit.
          next_call: { tool, arguments: { ...exact, section: section.section, contract_revision: document.revision,
            limit: document.sectionLimit } } });
        offset++;
        const candidate = page(offset < document.sections.length ? `cur_${"a".repeat(43)}` : null);
        if (Buffer.byteLength(JSON.stringify(selected)) > CATALOG_LIMITS.detailBytes || measure(candidate) > CATALOG_LIMITS.responseBytes) {
          selected.pop(); offset--;
          if (!selected.length) throw catalogContractSizeError("response", measure(candidate), CATALOG_LIMITS.responseBytes);
          break;
        }
      }
      const next = offset < document.sections.length ? `cur_${randomBytes(32).toString("base64url")}` : null;
      result = page(next);
      if (next) {
        while (this.cursors.size >= CATALOG_LIMITS.cursors) this.cursors.delete(this.cursors.keys().next().value!);
        this.cursors.set(next, { binding: input.binding, query: "", limit, expires: document.expires, offset, ids: [], legacy: false,
          contract: { detail, section: CONTRACT_SECTION_INDEX, revision: document.revision } });
      }
    } else {
      const section = document.sections.find(section => section.section === request.section);
      if (!section) throw catalogError("CATALOG_ENTRY_UNAVAILABLE", "That section is not available in this current permitted contract.");
      const items = selectContractItems(section, request.item);
      let offset = 0;
      if (request.cursor) {
        const cursor = this.cursors.get(request.cursor);
        if (!cursor || cursor.binding !== input.binding || cursor.limit !== limit || cursor.contract?.detail !== detail
          || cursor.contract.section !== request.section || cursor.contract.item !== request.item || cursor.contract.revision !== document.revision) {
          throw catalogError("CATALOG_CURSOR_INVALID", "This exact section cannot be continued in the current session, authority and scope.");
        }
        offset = cursor.offset;
      }
      const start = offset;
      const returned: typeof items = [];
      const page = (next: string | null): Record<string, unknown> => {
        const content: ContractSectionPage = { subject: String(identity.outcome ?? identity.id), revision: document!.revision,
          section: section.section, representation: section.representation, ...(request.item ? { item: request.item } : {}),
          items: returned, complete_section: request.item === undefined && start === 0 && offset === items.length };
        return response({ contract_section: content }, items.length, start, returned.length, next);
      };
      while (offset < items.length && returned.length < limit) {
        returned.push(structuredClone(items[offset]!)); offset++;
        const candidate = page(offset < items.length ? `cur_${"a".repeat(43)}` : null);
        if (Buffer.byteLength(JSON.stringify(returned)) > CATALOG_LIMITS.detailBytes || measure(candidate) > CATALOG_LIMITS.responseBytes) {
          returned.pop(); offset--;
          if (!returned.length) throw catalogContractSizeError("response", measure(candidate), CATALOG_LIMITS.responseBytes);
          break;
        }
      }
      const next = offset < items.length ? `cur_${randomBytes(32).toString("base64url")}` : null;
      result = page(next);
      const size = measure(result);
      if (size > CATALOG_LIMITS.responseBytes) throw catalogContractSizeError("response", size, CATALOG_LIMITS.responseBytes);
      if (this.records + 1 > CATALOG_LIMITS.sessionRecords || this.bytes + size > CATALOG_LIMITS.sessionBytes) throw budgetError();
      if (next) {
        while (this.cursors.size >= CATALOG_LIMITS.cursors) this.cursors.delete(this.cursors.keys().next().value!);
        this.cursors.set(next, { binding: input.binding, query: "", limit, expires: document.expires, offset, ids: [], legacy: false,
          contract: { detail, section: section.section, ...(request.item ? { item: request.item } : {}), revision: document.revision } });
      }
    }
    const size = measure(result);
    if (size > CATALOG_LIMITS.responseBytes) throw catalogContractSizeError("response", size, CATALOG_LIMITS.responseBytes);
    if (this.records + 1 > CATALOG_LIMITS.sessionRecords || this.bytes + size > CATALOG_LIMITS.sessionBytes) throw budgetError();
    // One disclosed catalog subject, as with exact detail; units do not grant a
    // fresh per-section pool or debit an undisclosed complete document.
    this.records++; this.bytes += size;
    this.lastWork = { visited: 0, returned: 1, bytes: size };
    return result;
  }
}

export function catalogContractSizeError(kind: "entry" | "response", measured: number, limit: number): McpRuntimeError {
  return new McpRuntimeError("CATALOG_CONTRACT_TOO_LARGE",
    `The complete reviewed contract does not fit the ${kind} disclosure limit (${measured} bytes; maximum ${limit}). `
    + "No constraints were truncated. Repeating the lookup or changing the page size will not help. "
    + "Ask the operator to open Boundary review, inspect Discovery compatibility, and revise this resource's reviewed metadata or scope; then review and activate the replacement. Do not guess permissions.",
    { kind, measured_bytes: measured, limit_bytes: limit, retryable: false, recovery: "operator_boundary_review" });
}

function terms(text: string): string[] { return text.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []; }
// Preserve every caller token. Search matches disclose literal coverage;
// no English grammar word is silently discarded.
function searchTerms(text: string): string[] {
  return [...new Set(searchSequence(text))];
}
function searchSequence(text: string): string[] { return terms(text); }
function compareIds(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function budgetError(): McpRuntimeError { return catalogError("CATALOG_SESSION_LIMIT", "This session reached its discovery limit. Use the already reviewed shortlist; further catalog disclosure requires a new authorized session."); }
function catalogError(code: string, message: string): McpRuntimeError { return new McpRuntimeError(code, message); }
