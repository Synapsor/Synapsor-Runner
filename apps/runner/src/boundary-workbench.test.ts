import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { renderBoundaryWorkbench } from "./boundary-workbench.js";

describe("Auto Boundary Workbench renderer", () => {
  it("sends original review bindings for preview and activation and advances them only on successful saves", async () => {
    const script = renderBoundaryWorkbench("test-csrf").match(/<script>([\s\S]*?)<\/script>/)![1]!;
    const start = script.indexOf("const post=async");
    const end = script.indexOf("const currentResource=", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const initial = { repository_id: "repository", deployment_id: "deployment", project_id: "project", epoch: 3, revision_id: "original" };
    const next = { ...initial, epoch: 4, revision_id: "saved" };
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    let response: { ok: boolean; payload: Record<string, unknown> } = { ok: true, payload: { ok: true } };
    const context = vm.createContext({ structuredClone, initial,
      fetch: async (url: string, request: { body: string }) => { sent.push({ url, body: JSON.parse(request.body) }); return response; } });
    const api = vm.runInContext(`let authoringBinding=structuredClone(initial); const csrf="test-csrf";
      const readPayload=async r=>r.payload; const handleSessionFailure=()=>false;
      ${script.slice(start, end)}
      ({post, binding:()=>authoringBinding});`, context) as { post(url: string, body: unknown): Promise<unknown>; binding(): unknown };
    for (const route of ["preview", "activate", "regenerate", "workloads/analyze", "workloads/apply", "review-relationship", "delegations/catalog"]) {
      await api.post(`/api/boundary/${route}`, { candidate: { name: "reviewed" } });
      expect(sent.at(-1)!.body.authoring_binding).toEqual(initial);
    }
    response = { ok: false, payload: { ok: false, error: "Review changed", authoring_binding: next } };
    await expect(api.post("/api/boundary/progress", {})).rejects.toThrow("Review changed");
    expect(api.binding()).toEqual(initial);
    response = { ok: true, payload: { ok: true, authoring_binding: next } };
    await api.post("/api/boundary/progress", {});
    expect(api.binding()).toEqual(next);
    await api.post("/api/boundary/preview", {});
    expect(sent.at(-1)!.body.authoring_binding).toEqual(next);
    await api.post("/api/ask", { question: "Stock?" });
    expect(sent.at(-1)!.body).toEqual({ question: "Stock?" });
  });

  it("revalidates even a no-op job catalog instead of skipping the original review check in the browser", async () => {
    const script = renderBoundaryWorkbench("test-csrf").match(/<script>([\s\S]*?)<\/script>/)![1]!;
    const start = script.indexOf("async function prepareDelegationCatalog");
    const end = script.indexOf("function renderSavedDelegations", start);
    expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
    const sent: Array<{ url: string; body: unknown }> = [];
    const context = vm.createContext({ delegationData: { mapping_catalog: { plan_digest: "reviewed-catalog" } },
      document: { querySelectorAll: () => [] }, delegationCardSelectionEdited: false,
      renderDelegationCatalog: () => undefined, useDelegationRecommendations: () => undefined,
      post: async (url: string, body: unknown) => { sent.push({ url, body }); return { mapping_catalog: {}, plan_cards: [] }; } });
    const prepare = vm.runInContext(`${script.slice(start, end)}; prepareDelegationCatalog`, context) as (actor: string) => Promise<void>;
    await prepare("reviewer");
    expect(sent).toEqual([{ url: "/api/boundary/delegations/catalog",
      body: { expected_plan_digest: "reviewed-catalog", accepted_shared_resources: [], actor: "reviewer" } }]);
  });

  it.each([false, true])("shows exact Action impact before the Workbench submits Read activation (accept=%s)", async accept => {
    const script = renderBoundaryWorkbench("csrf").match(/<script>([\s\S]*?)<\/script>/)![1]!;
    const start = script.indexOf("function confirmReadActivationImpact(");
    const end = script.indexOf("async function activateBoundary(", start);
    const warning = ["ACTIVATING THIS READ REVISION WILL PAUSE VERIFIED ACTIONS", "- maintenance.complete_visit",
      "Each listed outcome needs an Action recheck and then a fresh writer review before supervised execution can resume."];
    const order: string[] = [];
    const nodes = { message: { className: "", textContent: "" }, preview: { disabled: false }, actor: { value: "reviewer" } };
    const confirm = vi.fn((message: string) => { order.push("warning"); expect(message).toContain(warning.join("\n")); return accept; });
    const context = vm.createContext({ byId: (id: keyof typeof nodes) => nodes[id], window: { confirm },
      focusedAccessReview: false, reviewProgressHealthy: true, candidate: {}, candidateDigest: undefined,
      reviewRevision: 2, confirmedDecisions: new Set(), queueReviewProgressSave: async () => undefined,
      updateActivationState: () => undefined,
      post: async (url: string) => { expect(url).toBe("/api/boundary/preview"); order.push("preview");
        return { digest: "exact", activation_warning_lines: warning }; },
      activateBoundary: async () => { order.push("activate"); } });
    vm.runInContext(script.slice(start, end), context);
    await vm.runInContext("previewBoundary()", context);
    expect(order).toEqual(accept ? ["preview", "warning", "activate"] : ["preview", "warning"]);
    expect(confirm).toHaveBeenCalledOnce();
    // The independent relationship shortcut also warns before its activation submission.
    const relationship = script.slice(script.indexOf("async function activateReviewedRelationship("), script.indexOf("function renderClientConfigs("));
    expect(relationship.indexOf("confirmReadActivationImpact(preview)")).toBeLessThan(relationship.indexOf('post("/api/boundary/activate"'));
  });

  it("ships an executable code-editor playground with parameterized SQL as a primary path", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

    expect(() => new vm.Script(script)).not.toThrow();
    expect(html).toContain("playground-line-numbers");
    expect(html).toContain("playground-json-highlight");
    expect(html).toContain(".plan-code-highlight .syntax-code{font:inherit;line-height:inherit}");
    expect(html).toContain("Preview parameterized SQL");
    expect(html).toContain("Placeholders remain variables");
    expect(script).toContain('renderSyntaxCode("playground-normalized-json"');
    expect(script).toContain('renderSyntaxCode("playground-sql-"+index');
    expect(script).toContain("parameter value(s) withheld");
    expect(script).toContain("setPlanPlaygroundBusy(true");
    expect(script).toContain('root.setAttribute("aria-busy","true")');
    expect(script).toContain("setPlanPlaygroundBusy(false)");
    expect(script).toContain('error.payload?.error_code==="EXPLORE_SOURCE_UNAVAILABLE"');
    expect(script).toContain("Database connection environment is missing.");
    expect(script).toContain("is not set in the process that launched Workbench");
    expect(script).toContain("Retry after setting ");
  });

  it("presents workload compilation as a disabled step before activation and Action Assist", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

    expect(html).toContain("Advanced read compiler");
    expect(html).toContain("Question cards");
    expect(html).toContain("What should the agent be able to answer?");
    expect(html).toContain("Visual aggregate builder");
    expect(html).toContain("Map questions with a model");
    expect(html).toContain("Allow structural metadata egress for this mapping");
    expect(html).toContain("No source query or privacy budget");
    expect(html).toContain("Separate activation remains required");
    expect(script).toContain('getJson("/api/boundary/workloads")');
    expect(script).toContain('post("/api/boundary/workloads/analyze"');
    expect(script).toContain('post("/api/boundary/workloads/apply"');
    expect(script).toContain('readWorkloadMode="cards"');
    expect(script).toContain("selected_card_ids");
    expect(script).toContain("applyReadWorkloadCandidate(true)");
    expect(html).toContain("Keep reviewed and prepare an action");
    expect(script).toContain("keepReadReviewedDisabled");
    expect(script).toContain("Authority remains inactive; opening proposal Action Assist");
    expect(script).toContain('setView("action")');
  });

  it("presents one job-level Read and Action Boundary flow with four separate authority stages", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

    expect(html).toContain("Delegate one job");
    expect(html).toContain("Prepare one agent job");
    expect(html).toContain("Reviewed agent authority");
    expect(html).toContain("<th>Name</th><th>Type</th><th>Status</th><th>Contents</th><th>Agent authority</th><th>Actions</th>");
    expect(html).toContain("Read Boundaries</strong> control what Explore may inspect");
    expect(html).toContain("Action Boundaries</strong> control what changes an agent may propose");
    expect(script).toContain("payload.action_boundary_overview||null");
    expect(script).toContain('id="open-action-boundary"');
    expect(script).toContain('setView("action")');
    expect(html).toContain("What job are you giving this agent?");
    expect(html).toContain("Reviewed mapping catalog");
    expect(html).toContain(".workload-layout>*{min-width:0}");
    expect(html).toContain(".action-field{min-width:0;overflow-wrap:anywhere");
    expect(html).toContain("Model + Runner row values and operations");
    expect(html).toContain("Reviewed operations: ");
    expect(html).toContain("Find an exact read");
    expect(html).toContain("Describe the job to receive a bounded reviewed-metadata recommendation.");
    expect(html).toContain("Use Runner recommendation");
    expect(html).toContain("Approval starting point");
    expect(html).toContain("Review deterministic rules when available");
    expect(html).toContain("What may the agent propose?");
    expect(html).toContain("Allow this job's structural metadata egress");
    expect(html).toContain("One acknowledgement covers bounded read and action-set mapping");
    expect(html).toContain("Leave this blank to reuse the change-oriented job above as one proposal intent");
    expect(html).toContain("Explain or simulate deterministic approval");
    expect(html).toContain("Every model-supplied change field receives an explicit reviewed condition");
    expect(html).toContain("Policy fallback:</strong>");
    expect(html).toContain("approval policy / UTC calendar day");
    expect(script).toContain('operator:"gte"');
    expect(script).toContain('operator:"lte"');
    expect(script).toContain('operator:"in"');
    expect(script).toContain('operator:"max_length"');
    expect(script).toContain('source:"before"');
    expect(script).toContain('getJson("/api/boundary/delegations")');
    expect(script).toContain('post("/api/boundary/delegations/catalog"');
    expect(script).toContain("selectedDelegationCardIds");
    expect(script).toContain("delegationCardRecommendations");
    expect(script).toContain("useDelegationRecommendations");
    expect(script).toContain("!useModel&&actionIntents.length===0&&delegationJobRequestsActions(jobIntent)");
    expect(script).toContain("Runner found no unique reviewed-metadata match");
    expect(script).toContain("unrelated optional shared-reference table");
    expect(script).toContain("delegationSelectedCards=new Map()");
    expect(script).toContain('mode:"exact"');
    expect(script).toContain('source:{kind:"operator_exact_plan"}');
    expect(script).toContain('post("/api/boundary/delegations/record"');
    expect(script).toContain('post("/api/actions/guided/suggest-set"');
    const detectorStart = script.indexOf("function delegationJobRequestsActions");
    const detectorEnd = script.indexOf("function updateDelegationModelSettings", detectorStart);
    expect(detectorStart).toBeGreaterThanOrEqual(0);
    expect(detectorEnd).toBeGreaterThan(detectorStart);
    const detector = script.slice(detectorStart, detectorEnd);
    expect(vm.runInNewContext(
      `${detector}; delegationJobRequestsActions("Analyze inspections and propose creating a bounded maintenance request.")`,
    )).toBe(true);
    expect(vm.runInNewContext(
      `${detector}; delegationJobRequestsActions("Analyze inspection workload by asset kind.")`,
    )).toBe(false);
    expect(script).not.toContain("\u0008");
    expect(script).toContain("authoring_catalog:true");
    expect(script).toContain("action_support:actionSupport");
    expect(script).toContain("deterministic_approval_template");
    expect(script).toContain("Every deterministic condition must pass");
    expect(script).toContain("Runner discarded ");
    expect(script).toContain("incomplete model policy proposal");
    expect(script).toContain("come from exact reviewed field bounds");
    expect(script).toContain("Hard delete is never eligible");
    expect(script).toContain('selected==="deterministic"');
    expect(script).toContain("Review Read Boundary to continue");
    expect(script).toContain("selected:seed.decisions");
    expect(script).toContain("first.preparation?.selected||first.selected");
    expect(script).toContain("proposal intents saved");
    expect(script).toContain("resumeQuickActionAfterReadReview=true");
    expect(script).toContain("openFocusedActivationReview");
    expect(script).toContain('action_boundary_job_intent:pending.job_intent');
    expect(script).toContain('post("/api/actions/guided/policy/simulate"');
    expect(script).toContain('getJson("/api/actions/guided/draft?capability="+encodeURIComponent(capability))');
    expect(script).toContain("showGuidedActionDraft(payload)");
    expect(html).toContain("No source query runs");
    expect(html).toContain("<span>Explore</span>");
    expect(script).toContain(':"delegation";');
  });

  it("makes proposal-only action cards and automatic rehearsal the Workbench default", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

    expect(html).toContain("Create one proposal action");
    expect(html).toContain("Intent is used only to rank reviewed tables, operations, and fields");
    expect(html).toContain("Advanced action design");
    expect(script).toContain('post("/api/actions/guided/quick"');
    expect(script).toContain("quickActionPreparation.action");
    expect(script).toContain("Deterministic rules; fallback to human");
    expect(script).toContain("action.auto_approval=structuredClone(template.auto_approval)");
    expect(script).toContain("Binding trusted-scope rolling limits to the disabled Action Boundary");
    expect(script).toContain('post("/api/actions/guided/boundary/limits"');
    expect(script).toContain("Human review when exhausted or uncertain");
    expect(script).toContain("Outside the hard proposal envelope:");
    expect(script).toContain("Inside the envelope but outside deterministic approval:");
    expect(script).toContain('"Shared limit "+limit.id');
    expect(script).toContain("structural:true");
    expect(script).toContain("Identity-free structural rehearsal");
    expect(script).toContain("without resolving a runtime identity");
    expect(script).not.toContain("One rehearsal value needed");
    expect(script).not.toContain("rehearseQuickAction(draftPayload,lookupArgument)");
    expect(script).toContain("Structural rehearsal passed without a tenant, principal, or source-row read");
    expect(script).toContain("Activate proposal-only action");
    expect(script).toContain("Read and proposal authority are active");
    expect(script).toContain('byId("action-quick-prepare").disabled=actionReady.length===0');
    expect(script).toContain("No reviewed table has a source-proven proposal operation");
  });

  it("reviews trusted scope and shared Action Boundary limits through exact disabled revisions", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

    expect(html).toContain('id="action-boundary-editor"');
    expect(script).toContain("Action Boundary controls");
    expect(script).toContain("Trusted MCP scope");
    expect(script).toContain("Each tenant + principal");
    expect(script).toContain("Each tenant + object");
    expect(script).toContain("Save disabled limit revision");
    expect(script).toContain('post("/api/actions/guided/boundary/limits"');
    expect(script).toContain('post("/api/actions/guided/boundary/activate"');
    expect(script).toContain("No proposal will be approved or applied");
  });

  it("keeps the 1.7.0 reviewed-access controls discoverable in both Workbench and CLI", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const parityMarkers: Array<[string, string[]]> = [
      ["independent boundary lifecycle", ["Your boundaries", "New Read Boundary", "Deactivate selected Read Boundary", "Review and activate now"]],
      ["field tiers and sensitive widening", ["Model + Runner", "Withheld from model", "Kept out", "Changing a tier opens a recorded human review"]],
      ["reviewed enum allowlists", ["Allowed values", "Save allowed values", "Removed values are refused even if guessed"]],
      ["reviewed labels and descriptions", ["Reviewed label", "Reviewed description", "Save reviewed metadata", "plans still use the exact id"]],
      ["model vocabulary coverage", ["Reviewed model vocabulary required before activation", "Reviewed model vocabulary advised", "Model vocabulary ready", "coded value fields", "Exact database IDs remain the plan authority"]],
      ["direct and relationship-carried tenant scope", ["tenant_scope_path", "mandatory proven relationship path"]],
      ["direct, relationship-carried, and PostgreSQL RLS principal scope", ["principal_scope_path", "principal_rls_setting", "PostgreSQL RLS setting", "user/owner limit"]],
      ["shared-reference scope", ["Shared reference - same rows for every tenant", "I confirm this table has no per-tenant rows"]],
      ["per-table and whole-boundary privacy", ["Privacy for all tables", "Save privacy change", "Save for all"]],
      ["query-volume controls and operator status", ["Queries per rolling 24 hours", "Requests per rolling minute", "Operator-only budget status", "Disclosure controls remain separate", "Differencing variants for ", "root_resource"]],
      ["reviewed relationships and visual map", ["Reviewed data map", "renderBoundaryGraphSvg", "Each reviewed join uses its own labeled connection lane", "boundary-field-matrix", "Canonical path ID"]],
      ["numeric bands", ["Add a fixed numeric band", "kind:\"numeric_band\""]],
      ["automatic numeric bands", ["Allow automatic numeric bands", "kind:\"auto_band\"", "raw edges"]],
      ["reviewed exact grouping", ["Exact groups", "kind:\"exact_numeric_grouping\"", "It returns exact values; it does not create numeric bands"]],
      ["database capability tiers", ["Reviewed source release:", "Full reviewed grammar", "reviewed release line", "Automatic numeric bands are unavailable on", "This unavailable grammar is not shown to the model", "Supported limited database grammar", "schema_check_constraints===false", "automatic_numeric_bands===false", "Database capability changes"]],
      ["reviewed relative UTC windows", ["Reviewed UTC window", "Reviewed relative UTC window", "Exact UTC date ranges", "Operator-only resolved UTC window", "time_window", "compare_to"]],
      ["named and post-suppression measures", ["Add a named derived metric", "Add a post-suppression calculation", "kind:\"derived_measure\""]],
      ["safe child-count measures", ["Add a safe child-count metric", "Count child records without a raw one-to-many join"]],
      ["reconciling rescan", ["Rescan and review changes", "boundary_rescan_report", "Active authority did not change", "Repair authoring baseline", "No boundary review is required"]],
      ["query history and evidence", ["Query history", "Durable query ledger", "/api/explore/history?audit_id="]],
      ["local-model provider controls", ["OpenAI-compatible or local", "Model request timeout (seconds)"]],
      ["external MCP client setup", ["Use an existing AI or MCP client", "Generic stdio MCP", "Managed project installers"]],
      ["dependency-aware table removal", ["This table cannot be removed yet", "Remove or re-scope", "Nothing was saved or activated"]],
      ["effective reviewed field counts", ["reviewedFieldAccessCounts", "Runner-only</span>", "kept out</span>"]],
    ];
    for (const [feature, markers] of parityMarkers) {
      for (const marker of markers) expect(html, feature).toContain(marker);
    }
    expect(html).toContain("reviewed operations can still reveal equality, frequency, or order");
    expect(html).toContain("use Kept out for confidentiality");
    expect(html).toContain("complementary_scalar_filter_release");
    expect(html).not.toMatch(/execute_sql|model can activate|model can approve|model can apply/i);
  });

  it("blocks opaque Workbench authority until the reviewed vocabulary panels are completed", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const vocabularyStart = script.indexOf("const modelFacingFieldIds");
    const vocabularyEnd = script.indexOf("function handleSessionFailure", vocabularyStart);
    const blockerStart = script.indexOf("function focusedBoundaryBlocker()");
    const blockerEnd = script.indexOf("function renderSignoff()", blockerStart);
    expect(vocabularyStart).toBeGreaterThanOrEqual(0);
    expect(vocabularyEnd).toBeGreaterThan(vocabularyStart);
    expect(blockerStart).toBeGreaterThanOrEqual(0);
    expect(blockerEnd).toBeGreaterThan(blockerStart);
    const functions = `${script.slice(vocabularyStart, vocabularyEnd)}\n${script.slice(blockerStart, blockerEnd)}`;
    const candidate: {
      pack: {
        resources: Array<Record<string, unknown>>;
      };
    } = {
      pack: {
        resources: [{
          id: "legacy.t_0031",
          selectable_fields: ["val_1"],
          filterable_fields: {},
          sortable_fields: [],
          groupable_fields: ["val_1"],
          aggregate_measures: [],
          count_distinct_fields: [],
          time_bucket_fields: {},
          kept_out_fields: [],
          relationships: [],
        }],
      },
    };
    const context: Record<string, unknown> = {
      candidate,
      vocabularyStructuralProfiles: {
        "legacy.t_0031": {
          resource_identifier_opaque: true,
          field_semantic_status: { val_1: "opaque_identifier" },
        },
      },
    };
    const evaluated = vm.createContext(context);
    vm.runInContext(`${functions}; result=focusedBoundaryBlocker();`, evaluated);
    expect(context.result).toMatch(/legacy\.t_0031.*table name.*val_1/is);

    candidate.pack.resources[0]!.label = "Transit routes";
    candidate.pack.resources[0]!.field_metadata = { val_1: { label: "Service class" } };
    vm.runInContext("result=focusedBoundaryBlocker();", evaluated);
    expect(context.result).toBe("");

    candidate.pack.resources[0] = {
      id: "public.sites",
      selectable_fields: ["ph_code"],
      filterable_fields: { ph_code: ["eq"] },
      sortable_fields: ["ph_code"],
      groupable_fields: ["ph_code"],
      aggregate_measures: [],
      count_distinct_fields: [],
      time_bucket_fields: {},
      kept_out_fields: [],
      relationships: [],
    };
    context.vocabularyStructuralProfiles = {
      "public.sites": {
        resource_identifier_opaque: false,
        field_semantic_status: { ph_code: "coded_values" },
      },
    };
    vm.runInContext("vocabularyStructuralProfiles=globalThis.vocabularyStructuralProfiles; result=focusedBoundaryBlocker(); summary=modelVocabularySummary(candidate.pack.resources[0]);", evaluated);
    expect(context.result).toBe("");
    expect(context.summary).toMatch(/reviewed vocabulary advised.*ph_code.*activation remains available/is);
  });

  it("blocks a Workbench table removal when another table derives scope through it", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const start = script.indexOf("function removalScopeReferencesResource");
    const end = script.indexOf("function syncCandidateDecisions", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const functions = script.slice(start, end);
    const candidate = {
      pack: {
        resources: [{
          id: "public.orders",
          relationships: [],
        }, {
          id: "public.order_items",
          tenant_scope: {
            path_id: "order_items_order_id_fkey",
            ancestor_resource: "public.orders",
            proof: {
              links: [{
                source_resource: "public.order_items",
                target_resource: "public.orders",
              }],
            },
          },
          relationships: [],
        }],
      },
    };
    const context: Record<string, unknown> = {
      candidate,
      currentResource: (id: string) => candidate.pack.resources.find((resource) => resource.id === id),
    };
    vm.runInNewContext(`${functions}; result=resourceRemovalImpact("public.orders");`, context);
    expect(context.result).toEqual({
      blockers: ["public.order_items: tenant scope via order_items_order_id_fkey"],
      pruned: [],
    });
    expect(script).toContain("if(!toggleResource(selectedResource,false))return");
    expect(script).toContain("if(!toggleResource(input.dataset.resourceToggle,input.checked))input.checked=true");
  });

  it("counts a low-risk reviewer exclusion in every Workbench field summary", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const start = script.indexOf("function reviewedFieldAccessTier");
    const end = script.indexOf("const reviewedResourceKind", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const resource = {
      id: "librarydb.event_notes",
      field_types: {
        id: "int",
        loan_event_id: "int",
        note_source: "enum",
        sentiment: "enum",
      },
      selectable_fields: ["id", "loan_event_id", "sentiment"],
      model_withheld_fields: [],
      kept_out_fields: [],
    };
    const review = {
      fields: Object.keys(resource.field_types).map((name) => ({ name })),
    };
    const counts = vm.runInNewContext(
      `${script.slice(start, end)}\nreviewedFieldAccessCounts(resource, review)`,
      { resource, review },
    );
    expect({ ...counts }).toEqual({ visible: 3, runnerOnly: 0, keptOut: 1 });
    expect(counts.visible + counts.runnerOnly + counts.keptOut).toBe(review.fields.length);
  });

  it("assigns distinct graph lanes to multiple relationships from one table", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const renderer = script.match(/function renderBoundaryGraphSvg\(boundary\)\{[\s\S]*?\n    \}/)?.[0];
    expect(renderer).toBeTruthy();
    const context: Record<string, unknown> = {
      boundaryGraphSequence: 0,
      esc: (value: unknown) => String(value),
      boundary: {
        name: "sales",
        tables: ["orders", "customers", "reps"].map((id) => ({
          id,
          model_visible_fields: [{ name: "id" }],
          runner_only_field_count: 0,
          kept_out_field_count: 0,
        })),
        relationships: [{
          links: [
            { source_table: "orders", source_key: "customer_id", target_table: "customers", target_key: "id", proven: true },
            { source_table: "orders", source_key: "rep_id", target_table: "reps", target_key: "id", proven: true },
          ],
        }],
      },
    };
    vm.runInNewContext(`${renderer}; result=renderBoundaryGraphSvg(boundary);`, context);
    const graph = String((context as { result?: unknown }).result ?? "");
    const labels = [...graph.matchAll(/class="edge-label"[^>]* y="([^"]+)"/g)]
      .map((match) => match[1]);
    expect(labels).toHaveLength(2);
    expect(new Set(labels).size).toBe(2);
    expect(graph).toContain("customer_id → id");
    expect(graph).toContain("rep_id → id");
  });

  it("omits an undefined aggregate group limit from model-authored plan summaries", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const start = script.indexOf("function planSentence");
    const end = script.indexOf("function resultColumnLabel", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const renderer = script.slice(start, end);
    const render = (plan: Record<string, unknown>): string => {
      const context: Record<string, unknown> = {
        plan,
        result: "",
        describedResourceForPlan: () => ({ id: "clinicdb.encounters" }),
        resourceLabel: () => "Encounters",
        fieldReferenceLabel: (_resource: unknown, item: { field?: string }) => item.field ?? "Field",
        relativeWindowLabel: (value: string) => value,
      };
      vm.runInNewContext(`${renderer}; result=planSentence(plan,"reviewed_staging");`, context);
      return String(context.result);
    };
    const plan = {
      kind: "aggregate",
      resource: "clinicdb.encounters",
      measures: [{ function: "count" }],
      dimensions: [{ field: "department" }],
      where: [{ field: "status", op: "eq", value: "completed" }],
    };
    expect(render(plan)).toBe(
      'Calculate the number of records for encounters grouped by department where status equals "completed".',
    );
    expect(render({ ...plan, top_n: 25 })).toContain("with at most 25 groups.");
    expect(render(plan)).not.toContain("undefined");
  });

  it("renders current reconciliation, baseline-repair, and clean rescan reports", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    const start = script.indexOf("function rescanList");
    const end = script.indexOf("async function previewProjectRescan", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const renderer = script.slice(start, end);
    const render = (input: Record<string, unknown>): string => {
      const context: Record<string, unknown> = {
        input,
        result: "",
        esc: (value: unknown) => String(value),
      };
      vm.runInNewContext(`${renderer}; result=renderProjectRescanPreview(input);`, context);
      return String(context.result);
    };
    const totals = {
      boundaries: 1,
      preserved_authority: {
        resources: 6,
        reviewed_paths: 6,
        field_policies: 24,
      },
      kept_confirmations: 0,
      safely_carried_confirmations: 0,
      invalidated_decisions: 1,
      newly_proven_value_allowlists: 1,
      newly_available_resources: 0,
      newly_available_fields: 1,
      newly_available_relationships: 1,
      removed_resources: 0,
      removed_fields: 0,
      removed_relationships: 0,
    };
    const changed = render({
      changed: true,
      schema_changed: true,
      role_posture_changed: false,
      trusted_context_changed: false,
      database_server_authority_changed: true,
      database_server_authority_changes: [
        "release line changed from mysql 8.x to mysql 5.7",
        "automatic numeric bands are unavailable on this release line and were removed from review authority",
      ],
      totals,
      boundaries: [{
        boundary_name: "reviewed_staging",
        kept_confirmations: 0,
        preserved_authority: {
          resources: 6,
          reviewed_paths: 6,
          field_policies: 24,
        },
        invalidated_decisions: [{ id: "resource.public.orders.field_visibility", reason: "reviewed_input_changed" }],
        changed_field_types: [],
        removed_fields: [],
        removed_relationships: [],
        removed_resources: [],
        newly_available_resources: [],
        newly_available_fields: [{ resource_id: "public.orders", field: "channel" }],
        newly_available_relationships: [{
          resource_id: "librarydb.note_flags",
          relationship_id: "note_flags_note_fk__event_notes_event_fk__loan_events_loan_fk",
          target_resource: "librarydb.loans",
          path_depth: 3,
          path_links: [
            {
              source_resource: "librarydb.note_flags",
              target_resource: "librarydb.event_notes",
              source_columns: ["event_note_id"],
            },
            {
              source_resource: "librarydb.event_notes",
              target_resource: "librarydb.loan_events",
              source_columns: ["loan_event_id"],
            },
            {
              source_resource: "librarydb.loan_events",
              target_resource: "librarydb.loans",
              source_columns: ["loan_id"],
            },
          ],
        }],
        newly_proven_value_allowlists: [{
          resource_id: "public.orders",
          field: "status",
          value_count: 4,
        }],
        pruned_review_inputs: [],
      }],
    });
    expect(changed).toContain("Apply disabled reconciliation");
    expect(changed).toContain("public.orders.channel: new column kept out until reviewed");
    expect(changed).toContain("resource.public.orders.field_visibility: reviewed input changed");
    expect(changed).toContain("public.orders.status: an enforced schema vocabulary now narrows existing filter/group authority to 4 reviewed values; confirm field permissions, then activate");
    expect(changed).toContain("Newly proven value allowlists</th><td>1");
    expect(changed).toContain(
      "Reviewed authority preserved</th><td>6 tables, 6 reviewed paths, 24 field policies",
    );
    expect(changed).not.toContain("Decisions kept");
    expect(changed).toContain(
      "librarydb.note_flags: new relationship is available to review (3 hops)",
    );
    expect(changed).toContain("note_flags -> event_notes -> loan_events -> loans");
    expect(changed).toContain("via columns: event_note_id -> loan_event_id -> loan_id");
    expect(changed).toContain(
      "path ID: note_flags_note_fk__event_notes_event_fk__loan_events_loan_fk",
    );
    expect(changed).not.toContain(
      "librarydb.note_flags.note_flags_note_fk__event_notes_event_fk__loan_events_loan_fk",
    );
    expect(changed).toContain("Database capabilities</th><td>Changed");
    expect(changed).toContain("release line changed from mysql 8.x to mysql 5.7");

    const repaired = render({
      changed: false,
      authoring_baseline_refreshed: true,
      schema_changed: false,
      role_posture_changed: false,
      trusted_context_changed: false,
      totals: { ...totals, invalidated_decisions: 0, newly_available_fields: 0 },
      boundaries: [],
    });
    expect(repaired).toContain("Repair authoring baseline");
    expect(repaired).toContain("No boundary review is required");
    expect(repaired).not.toContain("Apply disabled reconciliation");

    const clean = render({
      changed: false,
      authoring_baseline_refreshed: false,
      schema_changed: false,
      role_posture_changed: false,
      trusted_context_changed: false,
      totals: { ...totals, invalidated_decisions: 0, newly_available_fields: 0 },
      boundaries: [],
    });
    expect(clean).toContain("Nothing needs to be applied");
    expect(clean).not.toContain('id="apply-rescan"');
  });

  it("emits executable browser JavaScript and the host-neutral guided journey", () => {
    const html = renderBoundaryWorkbench("test-csrf");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

    expect(script).toBeTruthy();
    expect(() => new vm.Script(script!, { filename: "boundary-workbench.js" })).not.toThrow();
    expect(html).toContain("Synapsor is creating the small set of database powers your agent may use.");
    expect(html).toContain("Writes create proposals and cannot be approved or applied by the model.");
    expect(html).toContain("The model also cannot activate new authority.");
    expect(html).toContain("Advanced field operations");
    expect(html).toContain("Reviewed metrics and numeric bands");
    expect(html).toContain("Add a fixed numeric band");
    expect(html).toContain("Allow automatic numeric bands");
    expect(html).toContain("Add a named derived metric");
    expect(html).toContain("Add a safe child-count metric");
    expect(html).toContain("Count child records without a raw one-to-many join");
    expect(html).toContain('kind:"numeric_band"');
    expect(html).toContain('kind:"auto_band"');
    expect(html).toContain('kind:"exact_numeric_grouping"');
    expect(html).toContain("maximum ");
    expect(html).toContain("reviewed rolling query budgets");
    expect(html).toContain('managedMetadataReviewPanel("resource_metadata"');
    expect(html).toContain('managedMetadataReviewPanel("field_metadata"');
    expect(html).toContain('data-metadata-review-form');
    expect(html).toContain('data-submit-metadata-review');
    expect(html).toContain("This metadata grants no access; plans still use the exact id.");
    expect(html).toContain('id="analytics-auto-band-method"');
    expect(html).toContain('id="analytics-auto-band-min"');
    expect(html).toContain('id="analytics-auto-band-max"');
    expect(html).toContain("Runner computes bands from trusted scoped rows and never exposes raw edges.");
    expect(html).toContain('kind:"derived_measure"');
    expect(html).toContain('<option value="child_count_total">Total child rows</option>');
    expect(html).toContain("definition:{name,label,shape,child_resource:selected.child_resource");
    expect(html).toContain("depth>previousAnalysisDepth&&depth<=next.max_analysis_relationship_hops");
    expect(html).toContain("retained.push(structuredClone(relationship))");
    expect(html).toContain("relationship:selected.relationship");
    expect(html).toContain("The AI receives only the saved name and labels; it cannot supply edges.");
    expect(html).toContain("Review security exceptions");
    expect(html).toContain("Pick a table. Set each column's access.");
    expect(html).toContain("Step 1 of 2 · Edit access");
    expect(html).toContain("Scoped Explore");
    expect(html).toContain('id="boundary-overview-title">Your boundaries');
    expect(html).toContain("Read Boundaries</strong> control what Explore may inspect.");
    expect(html).toContain("Action Boundaries</strong> control what changes an agent may propose.");
    expect(html).toContain('<th>Name</th><th>Type</th><th>Status</th><th>Contents</th><th>Agent authority</th><th>Actions</th>');
    expect(html).toContain("Disabled draft");
    expect(html).toContain("Reviewed · not active");
    expect(html).toContain("Read Boundaries never merge relationship graphs.");
    expect(html).toContain("An Action Boundary stays bound to its reviewed Read dependency.");
    expect(html).toContain('id="boundary-overview" class="boundary-overview"');
    expect(html).toContain('id="edit-boundary-tables" ');
    expect(html).toContain('type="button">Edit selected Read Boundary</button>');
    expect(html).toContain("pendingBoundaryChange?'class=\"secondary\" '");
    expect(html).toContain('id="new-boundary" class="secondary" type="button">New Read Boundary</button>');
    expect(html).toContain("Choose its first table. Nothing is copied from another boundary");
    expect(html).toContain('id="new-boundary-table"');
    expect(html).toContain("Showing all '+esc(inspectedStartingTables.length)+' inspected tables");
    expect(html).toContain("can be added after their scoped ancestor");
    expect(html).toContain("after a boundary-specific Shared reference acknowledgement");
    expect(html).toContain('return {kind:"shared_reference",reason:');
    expect(html).toContain("firstTableState");
    expect(html).toContain("derivedScopeStartGuidance");
    expect(html).toContain("resource.derived_principal_scope?.selected");
    expect(html).toContain("unavailable tables remain visible with their reason");
    expect(html).toContain("resource.blockers?.[0]");
    expect(html).toContain("Why unavailable");
    expect(html).toContain("What makes it addable");
    expect(html).toContain("scope_resolution_guidance");
    expect(html).toContain("Tenant scope available (");
    expect(html).toContain("derivedScopePathChain");
    expect(html).toContain("derivedScopeJoinColumns");
    expect(html).toContain("commonNamespace");
    expect(html).toContain("via columns:");
    expect(html).toContain("exact path ID");
    expect(html).toContain("Raise Derived-scope depth from ");
    expect(html).toContain("Proven tenant scope is available");
    expect(html).toContain("Choose table and edit");
    expect(html).toContain('post("/api/boundary/library/create"');
    expect(html).toContain("resource_id:resourceId");
    expect(html).not.toContain("copies the selected disabled structure");
    expect(html).toContain('const name=requestedName.toLowerCase()');
    expect(html).toContain('Using lower-case name');
    expect(html).toContain('const next=requestedName.toLowerCase()');
    expect(html).toContain('Principal scope: ');
    expect(html).toContain('mandatory proven relationship path');
    expect(html).toContain('data-review-kind="');
    expect(html).toContain('kind:reviewedKind');
    expect(html).toContain('tenant_scope_path');
    expect(html).toContain('shared_reference_scope');
    expect(html).toContain("Shared reference - same rows for every tenant");
    expect(html).toContain("I confirm this table has no per-tenant rows");
    expect(html).toContain('data-shared-reference-ack');
    expect(html).toContain('reviewRequest.acknowledgement="table_has_no_per_tenant_rows"');
    expect(html).toContain("Boundary-specific Shared reference review required below");
    expect(html).toContain("An acknowledgement recorded for another boundary is never copied");
    expect(html).toContain("explicitly review Shared reference only if ");
    expect(html).toContain('if(candidate.organization_scope)return {kind:"startable"}');
    expect(html).toContain('principal_scope_path');
    expect(html).toContain('principal_rls_setting');
    expect(html).toContain("PostgreSQL RLS scope candidates");
    expect(html).toContain("user/owner limit");
    expect(html).toContain("review.fields||[]).filter(field=>field.nullable===false");
    expect(html).toContain("bytea|blob|binary|varbinary|image");
    expect(html).toContain('return scope?"mandatory relationship path "+derivedScopePathChain(scope):"unresolved"');
    expect(html).toContain("Advanced exact path IDs");
    expect(html).toContain('post("/api/boundary/library/switch"');
    expect(html).toContain('post("/api/boundary/library/delete"');
    expect(html).toContain('data-discard-boundary="');
    expect(html).toContain("Reset curated review");
    expect(html).toContain("DISCARD REVIEW ");
    expect(html).toContain("discard_curated_review:true");
    expect(html).toContain("Runner config, ledger, evidence, and source data were preserved");
    expect(html).toContain('<details class="boundary-options"><summary>Rename selected Read Boundary</summary>');
    expect(html).toContain('<details id="overview-table-details" class="band">');
    expect(html).toContain('id="boundary-pack-name"');
    expect(html).toContain('id="save-boundary-name"');
    expect(html).toContain("The name is included in its final review fingerprint.");
    // Owner's typed-plan contract retires only the English-comparison control.
    expect(html).toContain("Local Ask validates the model&apos;s typed plan");
    expect(html).toContain("reviewed fields, operations, scope, privacy controls and limits");
    expect(html).not.toContain('id="boundary-ask-intent-mode"');
    expect(html).not.toContain('post("/api/boundary/ask-intent-check"');
    expect(html).toContain("Model response details · ");
    expect(html).toContain("[SEMANTIC] exact hashes stay operator-only");
    expect(html).toContain('id="boundary-model-output-mode"');
    expect(html).toContain("Semantic — keep hashes operator-only");
    expect(html).toContain("Exact diagnostics — include hashes");
    expect(html).toContain('post("/api/config/model-output"');
    expect(html).toContain("operator evidence");
    expect(html).toContain("changes no reviewed data authority and needs no activation");
    expect(html).toContain("boundary_rescan_report");
    expect(html).toContain("authoring_baseline_refreshed");
    expect(html).toContain("renderProjectRescanPreview");
    expect(html).not.toContain("diff.added_resources");
    expect(html).toContain("new column is kept out until reviewed");
    expect(html).toContain("new relationship is available to review");
    expect(html).toContain("Active authority did not change.");
    expect(html).toContain('id="disable-active-boundary"');
    expect(html).toContain("Deactivate selected Read Boundary");
    expect(html).toContain("Other active boundaries, protected capabilities, evidence, ledger, and source data stay unchanged.");
    expect(html).toContain('post("/api/explore/disable",{boundary_name:selectedEntry.name})');
    expect(html).not.toContain("data-boundary-add");
    expect(html).not.toContain("data-boundary-remove");
    expect(html).not.toContain('class="boundary-lanes"');
    expect(html).toContain('id="resource-search" type="search"');
    expect(html).toContain('id="show-related-access" class="secondary active"');
    expect(html).toContain('id="show-all-access"');
    expect(html).toContain("Boundary + related");
    expect(html).toContain("All inspected");
    expect(html).toContain("connected by inspected foreign-key paths");
    expect(html).toContain("Advanced view: unrelated tables are visible but are not presented as joinable.");
    expect(html).toContain("accessRelationshipConnections");
    expect(html).toContain('id="resource-navigation" class="access-resource-list"');
    expect(html).toContain('id="include-selected-resource"');
    expect(html).toContain('id="remove-selected-resource"');
    expect(html).toContain("data-access-column-list");
    expect(html).toContain("data-field-tier");
    expect(html).toContain("reviewedFieldOperations");
    expect(html).toContain("fieldNeedsOperationRepair");
    expect(html).toContain("Restored current inspected operation suggestions");
    expect(html).toContain("Re-including it restores only the current inspected operation suggestions");
    expect(html).toContain("Optional analytical operation restore");
    expect(html).toContain("Restore current suggested operations");
    expect(html).toContain("data-restore-field-operations");
    expect(html).toContain('class="access-secondary" data-access-secondary');
    expect(html).toContain('id="access-staged" class="access-final hidden"');
    expect(html).toContain("No access changes staged");
    expect(html).toContain("This remains a disabled draft until Step 2.");
    expect(html).toContain('byId("review-staged-access").onclick=openFocusedActivationReview');
    expect(html).toContain("One boundary, one exact confirmation");
    expect(html).toContain("confirmedDecisions=new Set(candidate.unresolved_decisions||[])");
    expect(html).toContain("openAccessEditor(button.dataset.reviewResource,button.dataset.reviewField)");
    expect(html).toContain("data-access-highlighted");
    expect(html).not.toMatch(/drag(?:-| )and(?:-| )drop|approve all/i);
    expect(html).toContain("includedIds.has(relation.target_resource)");
    expect(html).toContain("includedIds.has(link.source_resource)&&includedIds.has(link.target_resource)");
    expect(html).toContain("Exact database role posture");
    expect(html).toContain("Ask your reviewed data");
    expect(html).toContain('aria-label="Workbench destinations"');
    expect(html.indexOf('data-view="explore" type="button">Ask your data')).toBeLessThan(
      html.indexOf('data-view="overview" type="button">Review data access'),
    );
    expect(html).not.toContain("3. Ask your data");
    expect(html).toContain(':activeBoundary\n            ?"explore"\n            :"delegation"');
    expect(html).toContain("Ask naturally. Runner holds the boundary.");
    expect(html).toContain("Your model can reason freely. Its database requests cannot.");
    expect(html).toContain("What can I ask?");
    expect(html).toContain("Reviewed data map");
    expect(html).toContain("Download full map");
    expect(html).toContain("Copy Mermaid");
    expect(html).toContain("data-boundary-catalog-select");
    expect(html).toContain("data-boundary-catalog-section");
    expect(html).toContain("renderBoundaryGraphSvg");
    expect(html).toContain("boundary-catalog-graph");
    expect(html).toContain("Reviewed fields and relationships");
    expect(html).toContain("Operations are written out by name");
    expect(html).toContain("Field and database type");
    expect(html).toContain("Missing-data measure");
    expect(html).not.toContain("RET return · FLT filter");
    expect(html).toContain("boundaryRelationshipDisplay");
    expect(html).toContain("commonSchema");
    expect(html).toContain("field.operations||{}");
    expect(html).toContain("boundaryIdentifierDisplay");
    expect(html).toContain("Exact filter and time vocabularies");
    expect(html).toContain("boundary-relationship-summary");
    expect(html).toContain("Each reviewed join uses its own labeled connection lane.");
    expect(html).toContain('return fieldLabel(relationship,reference.field)+" from "+relationshipTargetLabel(relationship);');
    expect(html).toContain("This is one exact active boundary; it is never merged with another.");
    expect(html).toContain("Download this large boundary map");
    expect(html).toContain("diagram.markdown");
    expect(html).toContain("boundary_catalog");
    expect(html).toContain("boundary_mermaid");
    expect(html).toContain("boundary_diagrams");
    expect(html).toContain("This is one exact active boundary; it is never merged with another.");
    expect(html).toContain("Try asking");
    expect(html).toContain("relationship.links");
    expect(html).toContain("physical join");
    expect(html).toContain("askBoundaryPageSize=6");
    expect(html).toContain('aria-label="Reviewed table pages"');
    expect(html).toContain('id="ask-boundary-previous"');
    expect(html).toContain('id="ask-boundary-next"');
    expect(html).toContain("Showing '+esc(pageStart+1)+'–'+esc(Math.min(pageStart+askBoundaryPageSize,resources.length))+' of '");
    expect(html).toContain("Review or expand access");
    expect(html).toContain('id="prove-boundary"');
    expect(html).toContain("Prove this boundary");
    expect(html.indexOf('id="boundary-proof-result"')).toBeLessThan(html.indexOf('id="ask-configuration"'));
    expect(html).toContain('post("/api/boundary/prove",{})');
    expect(html).toContain("Runner did not release both sides of a suppressed-total subtraction.");
    expect(html).toContain("aggregate probe values discarded");
    expect(html).toContain("A subtraction probe may read scoped rows in a read-only transaction.");
    expect(html).toContain("Download proof");
    expect(html).toContain("Human review path");
    expect(html).toContain("Review this candidate access");
    expect(html).toContain("askAccessGuidanceHtml");
    expect(html).toContain("payload.display_answer||fullAnswer");
    expect(html).toContain("payload.display_answer_source||payload.answer_source");
    expect(html).toContain("Full model explanation");
    expect(html).toContain("The model cannot change this access.");
    expect(html).toContain("wireAskBoundaryEditAction");
    expect(html).toContain("Use an existing MCP client");
    expect(html).toContain("Use without a model");
    expect(html).toContain('id="no-model-content" class="no-model-content hidden"');
    expect(html).toContain("Safe starting boundary ready");
    expect(html).toContain("Review once.");
    expect(html).toContain("Then ask your database.");
    expect(html).toContain("prepared useful, conservative access");
    expect(html).toContain("tables, fields, relationships, and operations shown here");
    expect(html).toContain("Edit tables or columns");
    expect(html).toContain("Review this exact boundary once");
    expect(html).toContain('id="leave-ask-focus"');
    expect(html).toContain('byId("leave-ask-focus").onclick=()=>setView("overview")');
    expect(html).not.toMatch(/data[- ]areas?/i);
    expect(html).not.toContain("if(left.id===selectedResource)");
    expect(html).not.toContain("if(right.id===selectedResource)");
    expect(html).toContain("border-left:3px solid var(--accent)");
    expect(html).toContain('selected.scrollIntoView({behavior:"auto",block:"nearest"})');
    expect(html).not.toContain("Your AI can explore one table.");
    expect(html).toContain("Review and start asking");
    expect(html).toContain('class="instant-flow-active"');
    expect(html).toContain('class="instant-flow-core"');
    expect(html).toContain("animation:instant-edge-flow 1.9s linear infinite");
    expect(html).toContain("@keyframes instant-edge-flow");
    expect(html).toContain("@media(prefers-reduced-motion:reduce)");
    expect(html).toContain("Authoring profile");
    expect(html).toContain("Established by <code>synapsor-runner start</code>");
    expect(html).toContain('id="deployment-profile" type="hidden"');
    expect(html).not.toMatch(/<select id="deployment-profile"/);
    expect(html).not.toContain("profile_assertion");
    expect(html).toContain('const nextSurface="model"');
    expect(html).toContain('post("/api/instant/activate"');
    expect(html).toContain('byId("open-client-setup").onclick=revealExistingClientSetup');
    expect(html).toContain('byId("open-no-model").onclick=revealNoModelComposer');
    expect(html).toContain('openNoModelAfterLoad=true;\n        if(!byId("explorer").classList.contains("hidden"))');
    expect(html.indexOf('id="ask-shell"')).toBeGreaterThan(-1);
    expect(html).toContain("#ask-shell{order:3}");
    expect(html).toContain("#explorer{order:4}");
    expect(html).toContain("Reviewed named tools are active.");
    expect(html).toContain("Ask a question or request one reviewed proposal.");
    expect(html).toContain("Synapsor does not relay the request.");
    expect(html).toContain('id="ask-egress-review" class="ask-egress-review"');
    expect(html).toContain("Review what can leave this machine");
    expect(html).toContain("Allow this reviewed provider egress");
    expect(html).toContain("Your unsent key remains in this form.");
    expect(html).toContain('review.scrollIntoView({behavior:"smooth",block:"center"})');
    expect(html).toContain("not SQL, credentials, tenant choice, model-withheld values, kept-out fields, or write authority");
    expect(html).toContain("the model still cannot activate, approve, apply, or widen any tool");
    expect(html).toContain("Session-only conversation");
    expect(html).toContain('id="ask-history" class="ask-history"');
    expect(html).toContain("Query history");
    expect(html).toContain("Load query history");
    expect(html).toContain('id="ask-history-principal"');
    expect(html).toContain('id="ask-history-resource"');
    expect(html).toContain('id="ask-history-search"');
    expect(html).toContain('id="ask-history-newer"');
    expect(html).toContain('id="ask-history-older"');
    expect(html).toContain('id="ask-history-boundary"');
    expect(html).toContain('id="ask-history-outcome"');
    expect(html).toContain('id="ask-history-limit"');
    expect(html).toContain('getJson("/api/explore/history"+(params.size?"?"+params.toString():""))');
    expect(html).toContain('getJson("/api/explore/history?audit_id="');
    expect(html).toContain('getJson("/api/explore/evidence?evidence_id="');
    expect(html).toContain("Recent references");
    expect(html).toContain("Durable query ledger");
    expect(html).toContain("Reviewed query");
    expect(html).toContain("function historyStatusClass(value)");
    expect(html).toContain('return "history-status-warning"');
    expect(html).toContain('return "history-status-error"');
    expect(html).toContain("historyStatusClass(audit.status)");
    expect(html).toContain("historyStatusClass(evidencePayload.outcome)");
    expect(html).toContain("reconstructed.title");
    expect(html).toContain('class="history-detail-grid"');
    expect(html).toContain('renderSyntaxCode("ask-history-sql",reconstructed.statement,"SQL")');
    expect(html).toContain("New records retain operator-only parameterized SQL");
    expect(html).toContain('id="ask-submit-consent"');
    expect(html).toContain("Submitting your first question confirms");
    expect(html).toContain("No provider request occurs before you submit.");
    expect(html).toContain("configureAskOnFirstQuestion");
    expect(html).toContain("soleEnvironmentProvider");
    expect(html).toContain("ask-answer-grid");
    expect(html).toContain("ask-model-panel");
    expect(html).toContain("Asking...");
    expect(html).toContain("Asking your model through the reviewed data boundary...");
    expect(html).toContain('code==="ASK_PROVIDER_AUTHENTICATION_FAILED"');
    expect(html).toContain("could not authenticate");
    expect(html).toContain("Change provider or key");
    expect(html).toContain("Paste only the API key value");
    expect(html).not.toContain("<strong>Request refused safely</strong>");
    expect(html).toContain("View verified data (");
    expect(html).toContain("verified-data-details");
    expect(html).toContain("Stopped at the reviewed boundary");
    expect(html).toContain("Numbers in this answer come from the bounded plan, not model prose");
    expect(html).not.toContain("Runner validated and refused this call before granting data access.");
    expect(html).toContain("BOUNDARY_REFUSED");
    expect(html).toContain('id="ask-key" type="password"');
    expect(html).toContain('id="ask-timeout" type="number" min="1" max="600"');
    expect(html).toContain("request_timeout_seconds=Number(requestTimeout)");
    expect(html).toContain('id="ask-session-token-budget" type="number" min="1000" max="5000000"');
    expect(html).toContain('id="ask-live-session-token-budget" type="number" min="1000" max="5000000"');
    expect(html).toContain('id="ask-max-output-tokens" type="number" min="256" max="16384"');
    expect(html).toContain('post("/api/ask/limits"');
    expect(html).toContain("Conversation context was preserved");
    expect(html).toContain('code==="ASK_SESSION_TOKEN_BUDGET_EXCEEDED"');
    expect(html).toContain("s per model request");
    expect(html).toContain('maxlength="4000"');
    expect(html).toContain('post("/api/ask/run",{question})');
    expect(html).toContain("activeQuestionIsExecutable");
    expect(html).toContain('(payload.display_answer_source||payload.answer_source)==="runner"');
    expect(html).toContain("Runner boundary explanation");
    expect(html).not.toContain("Which reviewed regions contributed most to the weekly change?");
    expect(html).not.toMatch(/localStorage|sessionStorage|indexedDB/);
    expect(html).toContain("Optional filter");
    expect(html).toContain('id="aggregate-dimension-2"');
    expect(html).toContain('id="aggregate-dimension-3"');
    expect(html).toContain("reviewed fixed buckets");
    expect(html).toContain("parseDimensionChoice");
    expect(html).toContain("Choose each reviewed grouping field only once.");
    expect(html).toContain("One record");
    expect(html).toContain("JSON plan playground");
    expect(html).toContain('id="playground-plan-json"');
    expect(html).toContain('id="playground-validate"');
    expect(html).toContain('id="playground-run"');
    expect(html).toContain('post("/api/explore/validate",request)');
    expect(html).toContain('post("/api/explore/run",request)');
    expect(html).toContain("Values are never shown or accepted by this editor.");
    expect(html).toContain("No source data query ran and no Explore budget was consumed.");
    expect(html).toContain("Make this analysis reusable");
    expect(html).toContain("Make this reusable");
    expect(html).toContain("Choose an analysis to make reusable");
    expect(html).toContain("Runner will not choose one silently");
    expect(html).toContain("const resultProtectQueryRef=result.protect?.query_ref||null");
    expect(html).toContain("preferredProtectQueryRef=resultProtectQueryRef");
    expect(html).toContain("loadProtect(resultProtectQueryRef)");
    expect(html).toContain("query.query_ref===preferredRef");
    expect(html).toContain("The selected analysis is no longer available to Protect.");
    expect(html).toContain('params.get("query_ref")');
    expect(html).toContain('params.get("capability")');
    expect(html).toContain('if(!raw)return ""');
    expect(html).toContain('getJson("/api/protect/draft?capability_name="');
    expect(html).toContain("Review the generated authority, not the earlier freeform question.");
    expect(html).toContain("Disabled named capability:");
    expect(html).toContain("Add safe action");
    expect(html).toContain("Bounded JSON for developers");
    expect(html).toContain("resultColumnLabel");
    expect(html).toContain('new Intl.NumberFormat("en-US"');
    expect(html).toContain("Trace the role from IdP claim to approval and apply");
    expect(html).toContain("docs/approval-roles-and-operator-identity.md");
    expect(html).toContain("Try your first reviewed question");
    expect(html).toContain("Build another reviewed question");
    expect(html).toContain("body.ask-focus-mode button.tab.active");
    expect(html).toContain("No time grouping");
    expect(html).toContain("Model + Runner");
    expect(html).toContain("Withheld from model");
    expect(html).toContain("Raw values: Runner only");
    expect(html).toContain("Kept out");
    expect(html).toContain('data-trusted-scope="');
    expect(html).toContain("Trusted scope · Model + Runner");
    expect(html).toContain("fixed trusted-scope value enter model context");
    expect(html).toContain("fixed trusted-scope value only in the local verified result");
    expect(html).toContain("its raw column value is sent only when you reviewed that column as Model + Runner");
    expect(html).toContain("response-only tokens");
    expect(html).toContain("Changing a tier opens a recorded human review");
    expect(html).toContain("Allowed values · ");
    expect(html).toContain("data-submit-enum-review");
    expect(html).toContain('kind:"field_enum"');
    expect(html).toContain("Selecting none disables filtering and grouping for this column.");
    expect(html).toContain("Removed values are refused even if guessed.");
    expect(html).toContain("no source rows were sampled");
    expect(html).toContain("Runner-only analysis:");
    expect(html).toContain("labels tokenized");
    expect(html).toContain("Reviewed value controls");
    expect(html).toContain("reviewedValueControlHtml(result)");
    expect(html).toContain("sensitive kept out");
    expect(html).toContain("Aggregate privacy · minimum group size");
    expect(html).toContain("Privacy for all tables");
    expect(html).toContain('id="boundary-cohort-all"');
    expect(html).toContain('kind:"minimum_cohort_all"');
    expect(html).toContain("Save for all");
    expect(html).toContain("pending boundary change");
    expect(html).toContain("Review and activate now");
    expect(html).toContain("offerStagedActivation");
    expect(html).toContain("suppressionReviewGuidance");
    expect(html).toContain("Try a coarser reviewed grouping");
    expect(html).toContain("select Review privacy for");
    expect(html).toContain("Until activation, Ask uses the previous group size");
    expect(html).toContain("Ranked result settings");
    expect(html).toContain('id="boundary-query-volume"');
    expect(html).toContain('id="boundary-request-rate"');
    expect(html).toContain("Throughput controls");
    expect(html).toContain("renderOperatorBudgetStatus(result)");
    expect(html).toContain('id="boundary-ranked-groups"');
    expect(html).toContain("Groups considered before ranking");
    expect(html).toContain("Small-group suppression runs before ranking");
    expect(html).toContain("The AI cannot change this setting");
    expect(html).toContain("Fastest percentage growth");
    expect(html).toContain("Complete-population share unavailable");
    expect(html).toContain("returned non-suppressed subtotal");
    expect(html).toContain("Largest absolute increase");
    expect(html).toContain('kind:"comparison_change"');
    expect(html).toContain("Privacy: minimum group");
    expect(html).toContain('id="open-resource-privacy"');
    expect(html).toContain('section.querySelector("[data-cohort-review-value]")?.focus()');
    expect(html).toContain("Explicit owner override");
    expect(html).toContain("1 — show every non-empty group; suppression off");
    expect(html).toContain("Save privacy change");
    expect(html).toContain("Groups of one identify individuals");
    expect(html).toContain('kind:"minimum_cohort"');
    expect(html).toContain("Re-confirm lowered aggregate privacy setting");
    expect(html).toContain("Lowered privacy setting");
    expect(html).toContain("Activate this reviewed capability");
    expect(html).not.toContain('id="protect-confirmation"');
    expect(html).toContain("Runner normalized plan");
    expect(html).toContain("Runner does not persist or infer the MCP host conversation");
    expect(html).toContain("Activate this exact");
    expect(html).not.toContain('id="action-confirmation"');
    expect(html).toContain("data-action-digest");
    expect(html).toContain('id="leave-ask-focus" class="quiet header-back"');
    expect(html).toContain('byId("instant-full-review").onclick=()=>openFocusedAccessReview({useStarter:true})');
    expect(html).toContain("candidate=structuredClone(instantOnboarding.candidate)");
    expect(html).toContain("await queueReviewProgressSave()");
    expect(html).toContain("Activate boundary and ask");
    expect(html).toContain("Runner will revalidate the exact reviewed fingerprint");
    expect(html).toContain("continueAfterFinalSignoff");
    expect(html).not.toContain('id="activate"');
    expect(html).toContain("WORKBENCH_SESSION_EXPIRED");
    expect(html).toContain("Return to the terminal and type <code>r</code>");
    expect(html).not.toContain('id="trusted-tenant"');
    expect(html).not.toContain('id="trusted-principal"');
    expect(html).not.toContain('id="instant-tenant"');
    expect(html).not.toContain('id="instant-principal"');
    expect(html).toContain("Review proposals outside MCP");
    expect(html).toContain("Disable Explore and review proposals");
    expect(html).toContain("Reviewing does not end this local analytics session");
    expect(html).toContain("No native guarded write is available for this resource");
    expect(html).toContain("history.pushState(historyState");
    expect(html).toContain('window.addEventListener("popstate"');
    expect(html).toContain("selected_resource:selectedResource");
    expect(html).not.toMatch(/id="protect-disable-explore" type="checkbox" checked/);
    expect(html).toContain("Generic stdio MCP");
    expect(html).toContain("Managed project installers");
    expect(html).toContain("Prepare this project");
    expect(html).toContain("The client starts each local stdio runtime when it opens this project.");
    expect(html).toContain("Prepare Claude Code");
    expect(html).toContain("No live client session is connected yet");
    expect(html).not.toContain("is connected.</strong>");
    expect(html).toContain('data-install-mcp="cursor"');
    expect(html).toContain('data-install-mcp="claude-code"');
    expect(html).toContain('data-install-mcp="vscode"');
    expect(html).toContain('post("/api/mcp/install"');
    expect(html).toContain("Validating the active Read");
    expect(html).toContain("async function installManagedMcpClient(button){");
    expect(html).toContain("const includeActions=Boolean(actionBoundaryOverview");
    expect(html).toContain("--include-actions");
    expect(html).toContain("synapsor-actions");
    expect(html).toContain("mcp install cursor");
    expect(html).toContain("mcp install claude-code");
    expect(html).toContain("mcp install vscode");
    expect(html).toContain("Production Streamable HTTP clients");
    expect(html).toContain("mcp client-config --client claude-code --transport streamable-http");
    expect(html).toContain("mcp client-config --client cursor --transport streamable-http");
    expect(html).toContain("mcp client-config --client vscode --transport streamable-http");
    expect(html).toContain("SYNAPSOR_MCP_ACCESS_TOKEN");
    expect(html).toContain("Do not paste the token into the generated file");
    expect(html).toContain("Codex");
    expect(html).not.toMatch(/execute_sql|raw SQL tool|approve tool|apply tool/i);
  });
});
