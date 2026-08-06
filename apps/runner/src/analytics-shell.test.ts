import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createTerminalAnalyticsShellIo,
  renderAnalyticsShellBanner,
  renderReviewedAccessCatalog,
  renderSlashCommandMenu,
  renderTerminalJson,
  renderTerminalSql,
  runAnalyticsShell,
  slashCommandSuggestions,
  type AnalyticsShellIo,
  type ShellAnalysisRecord,
} from "./analytics-shell.js";
import {
  modelAnswerForDisplay,
  renderAnalysis,
  renderAnalyticsTurn,
  renderRefusedAttempts,
  renderTable,
  type AnalyticsAnalysis,
} from "./analytics-shell-render.js";
import type {
  AskTurnResult,
} from "./model-ask.js";
import type { BoundaryCatalogModel } from "./boundary-catalog.js";

const digest = `sha256:${"a".repeat(64)}` as const;

describe("Synapsor Analytics shell", () => {
  it("accepts plain questions, renders verified rows, and hides routine governance noise", async () => {
    const io = fakeIo([
      "Which regions had the most failed sessions?",
      "/exit",
    ]);
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      boundaryLabel: "support_analytics",
      profileLabel: "staging",
      reviewedDataAreas: 4,
      io,
      ask: async () => ({
        turn: turn("West had the most failed sessions with 184."),
        analyses: [analysis("A1", 1)],
        answer_id: "ans_aaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      listAnalyses: async () => [storedAnalysis("A1")],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    const output = io.output();
    expect(output).toContain("Synapsor Analytics");
    expect(output).toContain("Reviewed access: support_analytics (4 tables)");
    expect(output).toContain("/access manages boundaries");
    expect(output).toContain("Ctrl+D exits");
    expect(output).toContain("MODEL INTERPRETATION");
    expect(output).toContain("RUNNER-VERIFIED DATA");
    expect(output).toContain(
      "Structured values rendered by Runner. Model prose cannot replace or alter them.",
    );
    expect(output).toContain("West had the most failed sessions with 184.");
    expect(output).toContain("Region");
    expect(output).toContain("west");
    expect(output).toContain("184");
    expect(output).toContain("1 additional group was withheld");
    expect(output).toContain("To change this in the CLI:");
    expect(output).toContain("select support_analytics and press Enter");
    expect(output).toContain("Highlight public.sessions; do not open its columns");
    expect(output).toContain("Press P (Privacy) for the highlighted table");
    expect(output).toContain("Save this privacy change? [Y/n]");
    expect(output).toContain("press C later from the boundary screen");
    expect(output).toContain("Until activation, Ask keeps the previous minimum group size");
    expect(output).not.toContain("Database unchanged");
    expect(output).not.toContain("Source database changed: no");
    expect(output).not.toContain("Evidence recorded");
    expect(output).not.toContain("Analysis A1");
    expect(output).not.toContain(digest);
  });

  it("explains when an entity-shaped grouping triggers cohort suppression", () => {
    const current = analysis("A1", 1);
    current.plan = {
      kind: "aggregate",
      resource: "public.support_tickets",
      measures: [{ function: "count" }],
      dimensions: [{ field: "account_id" }],
      top_n: 10,
    };
    current.result.boundary_name = "support_analytics";
    const output = renderAnalysis(current).join("\n");
    expect(output).toContain("one row per account id");
    expect(output).toContain("Try a coarser reviewed grouping");
    expect(output).toContain("Highlight public.support_tickets; do not open its columns");
  });

  it("discloses opaque enum buckets and row allowlist exclusions in verified output", () => {
    const grouped = analysis("A1", 0);
    grouped.result.data = [{ status: "[unreviewed:abc123:1]", count: 7 }];
    grouped.result.privacy = {
      minimum_cohort_size: 5,
      suppressed_groups: 0,
      totals_returned: false,
      reviewed_value_controls: {
        bucketed_fields: [{
          resource: "public.orders",
          field: "status",
          output_field: "status",
          bucket_returned: true,
          bucket_token: "[unreviewed:abc123:1]",
        }],
        excluded_fields: [{
          resource: "public.orders",
          field: "channel",
          effect: "rows_outside_reviewed_values_excluded",
        }],
        source_values_exposed: false,
      },
    };

    const output = renderAnalysis(grouped).join("\n");
    expect(output).toContain("public.orders.status contains an opaque [unreviewed:abc123:1] group");
    expect(output).toContain("Their labels were not exposed");
    expect(output).toContain("limited to reviewed values for public.orders.channel");
    expect(output).toContain("Rows with other values, if any, were excluded");
  });

  it("renders TrailPeak-style verified aggregates with business labels and readable values", () => {
    const output = renderAnalyticsTurn(
      turn("Revenue rose after the week of July 6."),
      [{
        index: 1,
        tool: "app.explore_data",
        status: "ok",
        reference: "A1",
        description: "sum total cents grouped by week created at",
        plan: {
          kind: "aggregate",
          resource: "public.orders",
          measures: [{ function: "sum", field: "total_cents" }],
          time_bucket: { field: "created_at", bucket: "week" },
          top_n: 12,
        },
        result: {
          ok: true,
          data: [{ time_bucket: "2026-07-06T00:00:00.000Z", sum_total_cents: 1_442_600 }],
          outcome: {
            type: "success",
            result: {
              grain: {
                kind: "aggregate_groups",
                time_bucket: {
                  field: "created_at",
                  bucket: "week",
                  output_alias: "time_bucket",
                },
              },
              measures: [{
                alias: "sum_total_cents",
                function: "sum",
                field: "total_cents",
              }],
              dimensions: [],
            },
          },
          privacy: { minimum_cohort_size: 5, suppressed_groups: 0 },
          source_database_changed: false,
        },
        source_database_changed: false,
      }],
      100,
    );
    expect(output).toContain("Orders by week");
    expect(output).toContain("Week starting");
    expect(output).toContain("Total cents");
    expect(output).toContain("2026-07-06");
    expect(output).toContain("1,442,600");
    expect(output).not.toContain("sum_total_cents");
    expect(output).not.toContain("2026-07-06T00:00:00.000Z");
  });

  it("keeps text cells left-aligned and numeric result cells right-aligned", () => {
    const rendered = renderTable([
      { region: "pacific", count: 7 },
      { region: "mountain", count: 127 },
    ], 60);

    expect(rendered[0]).toContain("Region");
    expect(rendered[0]).toContain("Count");
    expect(rendered[2]?.trimStart()).toMatch(/^pacific\s+/);
    expect(rendered[3]?.trimStart()).toMatch(/^mountain\s+/);
    expect(rendered[0]?.length).toBe(rendered[2]?.length);
    expect(rendered[2]?.length).toBe(rendered[3]?.length);
  });

  it("labels a sum of a non-total field without implying a second total", () => {
    const output = renderAnalyticsTurn(
      turn("Discounts were summarized."),
      [{
        index: 1,
        tool: "app.explore_data",
        status: "ok",
        description: "sum discount cents",
        plan: {
          kind: "aggregate",
          resource: "public.orders",
          measures: [{ function: "sum", field: "discount_cents" }],
          top_n: 1,
        },
        result: {
          ok: true,
          data: [{ sum_discount_cents: 11_500 }],
          outcome: {
            type: "success",
            result: {
              grain: { kind: "aggregate_groups" },
              measures: [{
                alias: "sum_discount_cents",
                function: "sum",
                field: "discount_cents",
              }],
              dimensions: [],
            },
          },
          source_database_changed: false,
        },
        source_database_changed: false,
      }],
    );

    expect(output).toContain("Sum of discount cents");
    expect(output).not.toContain("Total Discount cents");
  });

  it("gives period-comparison columns distinct readable labels", () => {
    const current = analysis("A1", 0);
    current.plan = {
      kind: "aggregate",
      resource: "public.orders",
      measures: [{ function: "sum", field: "total_cents" }],
      comparison: {
        field: "created_at",
        ranges: [
          { start: "2026-07-19T00:00:00Z", end: "2026-07-26T00:00:00Z" },
          { start: "2026-07-26T00:00:00Z", end: "2026-08-02T00:00:00Z" },
        ],
      },
      top_n: 2,
    };
    current.result.data = [{
      sum_total_cents_period_1: 4_576_800,
      sum_total_cents_period_2: 4_805_300,
      sum_total_cents_absolute_change: 228_500,
      sum_total_cents_percentage_change: 4.99,
    }];
    current.result.outcome = {
      type: "success",
      result: {
        grain: {
          kind: "period_comparison",
          reviewed_time_field: "created_at",
          reviewed_time_bucket: "week",
          periods: [],
        },
        dimensions: [],
        measures: [{
          alias: "sum_total_cents",
          function: "sum",
          field: "total_cents",
          comparison_outputs: {
            period_1: "sum_total_cents_period_1",
            period_2: "sum_total_cents_period_2",
            absolute_change: "sum_total_cents_absolute_change",
            percentage_change: "sum_total_cents_percentage_change",
          },
        }],
      },
    };

    const output = renderAnalysis(current, 140).join("\n");
    expect(output).toContain("Earlier total cents");
    expect(output).toContain("Later total cents");
    expect(output).toContain("Change in total cents");
    expect(output).toContain("Percent change in total cents");
    expect(output).not.toContain("Total cents p...");
  });

  it("collapses only repeated result rows while preserving the provider interpretation", () => {
    const current = analysis("A1", 0);
    current.result.data = [
      { region: "west", count: 184 },
      { region: "north", count: 121 },
      { region: "east", count: 99 },
    ];
    const original = [
      "The reviewed result covers three regions.",
      "",
      "Results:",
      "- west: 184",
      "- north: 121",
      "- east: 99",
      "",
      "Interpretation: West led the returned groups, while East was lowest.",
    ].join("\n");

    const displayed = modelAnswerForDisplay(original, [current]);
    expect(displayed).toContain("The reviewed result covers three regions.");
    expect(displayed).toContain("West led the returned groups");
    expect(displayed).not.toContain("Interpretation:");
    expect(displayed).not.toContain("- west: 184");
    expect(displayed).not.toContain("Results:");
    expect(original).toContain("- west: 184");
  });

  it("removes an orphaned provider lead-in after repeated rows are collapsed", () => {
    const current = analysis("A1", 0);
    current.result.data = [
      { week: "2026-05-11", total_cents: 3_065_500 },
      { week: "2026-05-18", total_cents: 3_057_100 },
      { week: "2026-05-25", total_cents: 3_465_000 },
    ];
    const original = [
      "Revenue rose across the returned period.",
      "",
      "Interpretation (week-over-week change):",
      "- 2026-05-11: 3,065,500",
      "- 2026-05-18: 3,057,100",
      "- 2026-05-25: 3,465,000",
      "",
      "The final returned week was the strongest of these three.",
    ].join("\n");

    const displayed = modelAnswerForDisplay(original, [current]);
    expect(displayed).toContain("Revenue rose across the returned period.");
    expect(displayed).toContain("The final returned week was the strongest");
    expect(displayed).not.toContain("Interpretation (week-over-week change):");
  });

  it("collapses a converted-currency row listing by its unique reviewed time keys", () => {
    const current = analysis("A1", 0);
    current.result.data = [
      { week: "2026-05-11", total_cents: 3_065_500 },
      { week: "2026-05-18", total_cents: 3_057_100 },
      { week: "2026-05-25", total_cents: 3_465_000 },
    ];
    const original = [
      "Revenue generally rose across the reviewed period.",
      "",
      "Week-over-week changes in dollars:",
      "- 2026-05-11: $30,655.00 (baseline)",
      "- 2026-05-18: $30,571.00 - change: -$84.00 (-0.27%)",
      "- 2026-05-25: $34,650.00 - change: +$4,079.00 (+13.35%)",
      "",
      "The May 25 week was the strongest of the returned weeks.",
    ].join("\n");

    const displayed = modelAnswerForDisplay(original, [current]);
    expect(displayed).toContain("Revenue generally rose");
    expect(displayed).toContain("The May 25 week was the strongest");
    expect(displayed).not.toContain("Week-over-week changes in dollars:");
    expect(displayed).not.toContain("$30,655.00");
  });

  it("labels a reviewed resource identity count with the business resource name", () => {
    const current = analysis("A1", 0);
    current.plan = {
      kind: "aggregate",
      resource: "public.customers",
      measures: [{ function: "count_distinct", field: "id" }],
      dimensions: [{ field: "region" }],
      top_n: 10,
    };
    current.result.data = [{ region: "mountain", count_distinct_customers_id: 65 }];
    current.result.outcome = {
      type: "success",
      result: {
        grain: { kind: "aggregate_groups" },
        dimensions: [{ alias: "region", field: "region" }],
        measures: [{
          alias: "count_distinct_customers_id",
          function: "count_distinct",
          field: "id",
        }],
      },
    };

    expect(renderAnalysis(current).join("\n")).toContain("Unique customers");
    expect(renderAnalysis(current).join("\n")).not.toContain("Unique Id");
  });

  it("removes method narration and unsolicited follow-up menus after verified data", () => {
    const current = analysis("A1", 0);
    current.result.data = [
      { reason: "defective_item", week: "2026-07-13", count: 5 },
      { reason: "defective_item", week: "2026-07-20", count: 13 },
    ];
    const displayed = modelAnswerForDisplay([
      "I ran the reviewed boundary for refunds over the requested period.",
      "Defective items rose from 5 to 13.",
      "Would you like the table or a chart?",
    ].join(" "), [current]);

    expect(displayed).toBe("Defective items rose from 5 to 13.");
  });

  it("leads with the finding after a generic query-method sentence", () => {
    const current = analysis("A1", 0);
    current.result.data = [
      { week: "2026-07-06", total_cents: 1_442_600 },
      { week: "2026-07-13", total_cents: 4_510_600 },
    ];
    const displayed = modelAnswerForDisplay([
      "I queried orders by week using the reviewed sum of total cents.",
      "Summary: Revenue recovered sharply after the July 6 drop.",
    ].join(" "), [current]);

    expect(displayed).toBe("Revenue recovered sharply after the July 6 drop.");
  });

  it("keeps a provider sentence that directly states a counted result", () => {
    const current = analysis("A1", 0);
    current.result.data = [{ count_distinct_customers_id: 30 }];

    expect(modelAnswerForDisplay(
      "I counted 30 customers with at least one order.",
      [current],
    )).toBe("I counted 30 customers with at least one order.");
  });

  it("removes a provider method preamble and an inline copy of verified rows", () => {
    const current = analysis("A1", 0);
    current.result.data = [
      { time_bucket: "2026-05-11T00:00:00.000Z", sum_total_cents: 3_065_500 },
      { time_bucket: "2026-07-06T00:00:00.000Z", sum_total_cents: 1_442_600 },
      { time_bucket: "2026-07-27T00:00:00.000Z", sum_total_cents: 4_805_300 },
    ];
    const displayed = modelAnswerForDisplay([
      "I grouped orders by UTC week and summed total_cents for each week.",
      "Returned weekly sums in cents for the reviewed period.",
      "Strongest trend: order value moved upward with a sharp July 6 dip.",
      "Exact weekly sums returned: 2026-05-11: 3,065,500; 2026-07-06: 1,442,600; 2026-07-27: 4,805,300.",
      "Interpretation: order value recovered to its highest returned week on July 27.",
    ].join(" "), [current]);

    expect(displayed).toBe("Order value moved upward with a sharp July 6 dip. Order value recovered to its highest returned week on July 27.");
    expect(displayed).not.toContain("3,065,500");
  });

  it("does not let a generic returned-range sentence lead a verified interpretation", () => {
    const current = analysis("A1", 0);
    current.result.data = [
      { week: "2026-05-11", total_cents: 3_065_500 },
      { week: "2026-07-27", total_cents: 4_805_300 },
    ];
    const displayed = modelAnswerForDisplay(
      "Returned weeks cover 2026-05-11 through 2026-07-27. Revenue rose by 56.8%.",
      [current],
    );

    expect(displayed).toBe("Revenue rose by 56.8%.");
  });

  it("keeps a no-query model limitation concise before Runner's proven review path", () => {
    const catalog: AnalyticsAnalysis = {
      index: 1,
      tool: "app.describe_data",
      status: "ok",
      description: "Reviewed data catalog",
      result: { ok: true, resources: [{ id: "public.orders" }] },
      source_database_changed: false,
    };
    const original = [
      "Product category is not available in the active reviewed catalog.",
      "",
      "Add a guessed product table or tell me which schema to use.",
    ].join("\n");
    const displayed = modelAnswerForDisplay(original, [catalog], {
      kind: "review_candidate",
      title: "Category is not in the active boundary",
      message: "Runner found a source-proven candidate path.",
      candidate_path: "Order items -> Products -> Orders",
      next_action: "Use /access.",
    });

    expect(displayed).toBe("Category is not in the active boundary. The active reviewed boundary cannot answer this question, so Runner did not execute a data query.");
    expect(original).toContain("guessed product table");
  });

  it("reports a complementary privacy refusal as an executed and discarded read", () => {
    const refused = refusedAnalysis(
      "EXPLORE_PRIVACY_BUDGET_EXHAUSTED",
      "An earlier grouped result withheld a small cohort. This total could reconstruct it.",
    );
    refused.result.details = {
      reason: "complementary_aggregate_release",
      source_query_executed: true,
    };
    const output = renderAnalyticsTurn(turn("I could not release that total."), [refused], 100, {
      accessGuidance: {
        kind: "review_candidate",
        title: "A complementary total was blocked to protect a withheld group",
        message: "Runner discarded the result.",
        review_boundary: "support_analytics",
        review_resource: "public.sessions",
        review_focus: "privacy",
        source_query_executed: true,
        next_action: "/access -> boundary support_analytics -> table public.sessions -> Privacy (P) -> Review + activate.",
      },
    });
    expect(output).toContain("Runner executed a read-only query, then discarded its result");
    expect(output).not.toContain("No data query ran");
    expect(output).toContain("HUMAN REVIEW PATH");
    expect(output).toContain("Privacy (P)");
  });

  it("protects a sole current analysis without making the user type its reference", async () => {
    const projectRoot = path.resolve("/tmp/synapsor-protect-display");
    const io = fakeIo([
      "Which regions had the most failed sessions?",
      "/protect",
      "",
      "",
      "/exit",
    ]);
    const protect = vi.fn(async () => ({
      draft: {
        schema_version: "synapsor.protected-query.v1" as const,
        state: "disabled" as const,
        capability: "analytics.sessions_count_by_region",
        source: "app",
        mode: "aggregate" as const,
        boundary_digest: digest,
        generation_lock_fingerprint: digest,
        contract_digest: digest,
        dsl_path: "synapsor/protected/capability.synapsor.sql",
        contract_path: "synapsor/protected/synapsor.contract.json",
        tests_path: "synapsor/protected/contract-tests.json",
        review_path: "synapsor/protected/REVIEW.md",
        literal_positions: [],
        converted_arguments: [],
      },
    }));
    const activateProtected = vi.fn(async () => ({
      schema_version: "synapsor.protected-query.v1" as const,
      state: "active" as const,
      capability: "analytics.sessions_count_by_region",
      contract_digest: digest,
      contract_path: "synapsor/protected/synapsor.contract.json",
      config_path: "synapsor/synapsor.runner.json",
      actor: "local-developer",
      activated_at: "2026-08-02T00:00:00.000Z",
      exploration_disabled: false,
    }));
    await runAnalyticsShell({
      projectRoot,
      providerLabel: "OpenAI",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: async () => ({
        turn: turn("West had the most failures."),
        analyses: [analysis("A1", 0)],
        answer_id: "ans_aaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      listAnalyses: async () => [storedAnalysis("A1")],
      protect,
      activateProtected,
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    expect(protect).toHaveBeenCalledWith({
      reference: "A1",
      capabilityName: "analytics.sessions_count_by_region",
    });
    expect(io.output()).toContain("PROTECT REVIEW");
    expect(io.output()).toContain("Provenance");
    expect(io.output()).toContain(
      `DSL: ${path.join(projectRoot, "synapsor/protected/capability.synapsor.sql")}`,
    );
    expect(io.output()).toContain(
      `Contract: ${path.join(projectRoot, "synapsor/protected/synapsor.contract.json")}`,
    );
    expect(io.output()).toContain(
      `Tests: ${path.join(projectRoot, "synapsor/protected/contract-tests.json")}`,
    );
    expect(io.output()).toContain("Which regions had the most failed sessions?");
    expect(io.output()).toContain("Model request: app.explore_data");
    expect(io.output()).toContain("Inspect exact request and runtime checks: /details A1");
    expect(io.output()).toContain("Agent authority activated: no");
    expect(io.output()).toContain("Protected capability active: analytics.sessions_count_by_region");
    expect(io.output()).not.toContain("http://127.0.0.1");
    expect(activateProtected).toHaveBeenCalledWith({
      capabilityName: "analytics.sessions_count_by_region",
      reviewedDigest: digest,
      actor: "local-developer",
    });
    expect(io.output()).not.toContain("Database unchanged");
  });

  it("styles the Protect review hierarchy in an interactive terminal", async () => {
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    const io = fakeIo([
      "Which regions had the most failed sessions?",
      "/protect",
      "",
      "/exit",
    ], 100, true);
    try {
      await runAnalyticsShell({
        providerLabel: "OpenAI",
        profileLabel: "staging",
        reviewedDataAreas: 1,
        io,
        ask: async () => ({
          turn: turn("West had the most failures."),
          analyses: [analysis("A1", 0)],
          answer_id: "ans_aaaaaaaaaaaaaaaaaaaaaaaa",
        }),
        listAnalyses: async () => [storedAnalysis("A1")],
        protect: async () => ({ draft: dummyDraft() }),
        clearConversation: vi.fn(),
        cancel: vi.fn(() => false),
      });

      expect(io.output()).toContain("\u001b[1;36mPROTECT REVIEW\u001b[0m");
      expect(io.output()).toContain("\u001b[1mProvenance\u001b[0m");
      expect(io.output()).toContain("\u001b[1mGenerated\u001b[0m");
      expect(io.output()).toContain("\u001b[1;35manalytics.analysis\u001b[0m");
      expect(io.output()).toContain("\u001b[1;36m/details A1\u001b[0m");
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
    }
  });

  it("requires a readable choice when one answer executed multiple plans", async () => {
    const io = fakeIo([
      "Compare by region and charger model.",
      "/protect",
      "2",
      "analytics.failures_by_model",
      "/exit",
    ]);
    const protect = vi.fn(async ({ capabilityName }: { capabilityName: string }) => ({
      draft: {
        ...dummyDraft(),
        capability: capabilityName,
      },
      workbenchUrl: "http://127.0.0.1:8765/?token=one-time",
    }));
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "development",
      reviewedDataAreas: 2,
      io,
      ask: async () => ({
        turn: turn("The reviewed results are shown below."),
        analyses: [
          analysis("A1", 0),
          {
            ...analysis("A2", 0),
            description: "sessions grouped by charger model",
            suggested_capability: "analytics.sessions_count_by_charger_model",
          },
        ],
        answer_id: "ans_bbbbbbbbbbbbbbbbbbbbbbbb",
      }),
      listAnalyses: async () => [
        {
          ...storedAnalysis("A2"),
          description: "sessions grouped by charger model",
          suggested_capability: "analytics.sessions_count_by_charger_model",
        },
        storedAnalysis("A1"),
      ],
      protect,
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    expect(io.output()).toContain("This answer used 2 protectable analyses");
    expect(protect).toHaveBeenCalledWith({
      reference: "A2",
      capabilityName: "analytics.failures_by_model",
    });
  });

  it("refuses explicit last when the current answer has multiple protectable plans", async () => {
    const io = fakeIo([
      "Compare by region and charger model.",
      "/protect last as analytics.failures",
      "/exit",
    ]);
    const protect = vi.fn();
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "development",
      reviewedDataAreas: 2,
      io,
      ask: async () => ({
        turn: turn("Two reviewed results are shown below."),
        analyses: [
          analysis("A1", 0),
          {
            ...analysis("A2", 0),
            description: "sessions grouped by charger model",
          },
        ],
        answer_id: "ans_dddddddddddddddddddddddd",
      }),
      listAnalyses: async () => [
        {
          ...storedAnalysis("A2"),
          description: "sessions grouped by charger model",
        },
        storedAnalysis("A1"),
      ],
      protect,
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    expect(io.output()).toContain("`last` is ambiguous");
    expect(io.output()).toContain("A1");
    expect(io.output()).toContain("A2");
    expect(protect).not.toHaveBeenCalled();
  });

  it("protects an explicit analysis reference without opening an ambiguity picker", async () => {
    const io = fakeIo([
      "Compare by region and charger model.",
      "/protect A2 as analytics.failures_by_model",
      "/exit",
    ]);
    const protect = vi.fn(async ({ capabilityName }: { capabilityName: string }) => ({
      draft: {
        ...dummyDraft(),
        capability: capabilityName,
      },
      workbenchUrl: "http://127.0.0.1:8765/?token=one-time",
    }));
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "development",
      reviewedDataAreas: 2,
      io,
      ask: async () => ({
        turn: turn("Two reviewed results follow."),
        analyses: [
          analysis("A1", 0),
          {
            ...analysis("A2", 0),
            description: "sessions grouped by charger model",
          },
        ],
        answer_id: "ans_222222222222222222222222",
      }),
      listAnalyses: async () => [
        {
          ...storedAnalysis("A2"),
          description: "sessions grouped by charger model",
        },
        storedAnalysis("A1"),
      ],
      protect,
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    expect(protect).toHaveBeenCalledWith({
      reference: "A2",
      capabilityName: "analytics.failures_by_model",
    });
    expect(io.output()).not.toContain("Choose an analysis");
  });

  it("replaces transient provider and tool progress without adding it to the transcript", async () => {
    const io = fakeIo(["show reviewed totals", "/exit"]);
    await runAnalyticsShell({
      providerLabel: "Anthropic",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: async (_question, onProgress) => {
        onProgress?.("provider");
        onProgress?.("tool");
        onProgress?.("provider");
        return {
          turn: turn("The verified result follows."),
          analyses: [analysis("A1", 0)],
          answer_id: "ans_eeeeeeeeeeeeeeeeeeeeeeee",
        };
      },
      listAnalyses: async () => [storedAnalysis("A1")],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    expect(io.statuses()).toEqual([
      "Waiting for the provider...",
      "Running a reviewed data tool...",
      "Waiting for the provider...",
    ]);
    expect(io.currentStatus()).toBe("");
    expect(io.output()).not.toContain("Waiting for the provider");
    expect(io.output()).not.toContain("Running a reviewed data tool");
    expect(io.output()).not.toMatch(/transport|sqlite|config path/i);
  });

  it("shows successful Runner data without surfacing refused intermediate attempts", async () => {
    const io = fakeIo(["show reviewed totals", "/exit"]);
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: async () => ({
        turn: turn("The verified result follows."),
        analyses: [
          catalogAnalysis(),
          refusedAnalysis("EXPLORE_PLAN_INVALID", "count does not accept a field"),
          refusedAnalysis("EXPLORE_PLAN_INVALID", "top_n exceeds the reviewed aggregate result bound"),
          analysis("A1", 0),
        ],
        answer_id: "ans_eeeeeeeeeeeeeeeeeeeeeeee",
      }),
      listAnalyses: async () => [storedAnalysis("A1")],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    const output = io.output();
    expect(output).toContain("RUNNER-VERIFIED DATA");
    expect(output).not.toContain("earlier attempts were refused");
    expect(output).not.toContain("Type /attempts to inspect.");
    expect(output).not.toContain("Reviewed data catalog: 1 table");
    expect(output).not.toContain("count does not accept a field");
    expect(output).not.toContain("top_n exceeds the reviewed aggregate result bound");
    expect(output).toContain("west");
  });

  it("shows collapsed refusal details only when the developer requests /attempts", async () => {
    const io = fakeIo(["show reviewed totals", "/attempts", "/exit"]);
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: async () => ({
        turn: turn("The verified result follows."),
        analyses: [
          refusedAnalysis("EXPLORE_PLAN_INVALID", "count does not accept a field"),
          refusedAnalysis("EXPLORE_PLAN_INVALID", "top_n exceeds the reviewed aggregate result bound"),
          analysis("A1", 0),
        ],
        answer_id: "ans_eeeeeeeeeeeeeeeeeeeeeeee",
      }),
      listAnalyses: async () => [storedAnalysis("A1")],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    const output = io.output();
    expect(output).toContain("REFUSED ATTEMPTS");
    expect(output).toContain("Attempt 1 - EXPLORE_PLAN_INVALID");
    expect(output).toContain("count does not accept a field");
    expect(output).toContain("top_n exceeds the reviewed aggregate result bound");
  });

  it("syntax-highlights typed tool requests in refused-attempt details", () => {
    const refused = refusedAnalysis("EXPLORE_FIELD_FORBIDDEN", "field access was refused");
    refused.arguments = {
      boundary: "reviewed_sessions",
      plan: { kind: "aggregate", resource: "public.sessions", top_n: 10 },
    };
    const output = renderRefusedAttempts([refused], true).join("\n");
    expect(output).toContain('\u001b[1;36m"boundary"\u001b[0m');
    expect(output).toContain('\u001b[1;32m"reviewed_sessions"\u001b[0m');
    expect(output).toContain("\u001b[1;33m10\u001b[0m");
  });

  it("styles model prose and Runner facts differently in a TTY", async () => {
    const io = fakeIo(["show reviewed totals", "/exit"], 100, true);
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: async () => ({
        turn: turn("The verified result follows."),
        analyses: [analysis("A1", 0)],
        answer_id: "ans_eeeeeeeeeeeeeeeeeeeeeeee",
      }),
      listAnalyses: async () => [storedAnalysis("A1")],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    expect(io.output()).toContain("\u001b[1;35mMODEL INTERPRETATION\u001b[0m");
    expect(io.output()).toContain("\u001b[3mThe verified result follows.\u001b[0m");
    expect(io.output()).toContain("\u001b[1;32mRUNNER-VERIFIED DATA\u001b[0m");

    const noQuery = renderAnalyticsTurn(turn("I can describe the reviewed boundary."), [], 100, {
      ansi: true,
    });
    expect(noQuery).toContain("\u001b[3mI can describe the reviewed boundary.\u001b[0m");
    expect(noQuery).toContain("\u001b[1;33mRUNNER STATUS\u001b[0m");
    expect(noQuery).toContain("No Runner data query was executed for this answer.");
  });

  it("styles provider, model, boundary, and active posture without changing plain output", () => {
    const input = {
      providerLabel: "OpenAI",
      modelLabel: "gpt-5-mini",
      boundaryLabel: "reviewed_staging",
      profileLabel: "development",
      reviewedDataAreas: 2,
    };
    const plain = renderAnalyticsShellBanner(input);
    expect(plain).toContain("Provider: OpenAI");
    expect(plain).toContain("Model: gpt-5-mini");
    expect(plain).toContain("Reviewed access: reviewed_staging (2 tables)");
    expect(plain).not.toContain("\u001b[");

    const colored = renderAnalyticsShellBanner(input, true);
    expect(colored).toContain("\u001b[1;36mSynapsor Analytics\u001b[0m");
    expect(colored).toContain("Provider: \u001b[1;36mOpenAI\u001b[0m");
    expect(colored).toContain("Model: \u001b[1;36mgpt-5-mini\u001b[0m");
    expect(colored).toContain("Reviewed access: \u001b[1;35mreviewed_staging\u001b[0m");
  });

  it("keeps a disabled boundary update visible when Ask still uses the prior revision", () => {
    const output = renderAnalyticsShellBanner({
      providerLabel: "OpenAI",
      modelLabel: "gpt-5-mini",
      boundaryLabel: "reviewed_staging",
      profileLabel: "development",
      reviewedDataAreas: 2,
      pendingBoundaryReview: {
        boundary_name: "reviewed_staging",
        pending_changes: 1,
        previous_authority_active: true,
      },
    });
    expect(output).toContain("1 PENDING BOUNDARY CHANGE IS NOT ACTIVE");
    expect(output).toContain("Ask still uses the previous exact reviewed revision");
    expect(output).toContain("/access -> select the boundary -> C Review + activate");
  });

  it("shows a concise reviewed-access summary and only validated starter questions", () => {
    const output = renderAnalyticsShellBanner({
      providerLabel: "OpenAI",
      modelLabel: "gpt-5-mini",
      boundaryLabel: "reviewed_staging",
      profileLabel: "development",
      reviewedDataAreas: 1,
      accessSummary: {
        table_count: 1,
        resources: [{
          id: "public.orders",
          label: "Orders",
          capabilities: [
            "record counts",
            "totals and averages of Total cents",
            "grouping by Status and Channel",
          ],
          suggestions: ["How did total cents change by week across channel?"],
        }],
        suggestions: ["How did total cents change by week across channel?"],
      },
    });
    expect(output).toContain("Can ask now");
    expect(output).toContain("Orders: record counts; totals and averages of Total cents; grouping by Status and Channel");
    expect(output).toContain('Try: "How did total cents change by week across channel?"');
  });

  it("pages detailed reviewed access without dumping every table", () => {
    const resources = Array.from({ length: 7 }, (_, index) => ({
      id: `public.table_${index + 1}`,
      label: `Table ${index + 1}`,
      boundary_name: index < 4 ? "billing_review" : "support_review",
      capabilities: ["record counts", `grouping by Field ${index + 1}`],
      suggestions: [`How many table ${index + 1} records are there?`],
    }));
    const page = renderReviewedAccessCatalog({
      line: "/catalog 2",
      boundaryLabel: "2 active boundaries",
      summary: { table_count: resources.length, resources, suggestions: [] },
      pageSize: 5,
    });
    expect(page).toContain("CAN ASK NOW");
    expect(page).toContain("7 reviewed tables and 0 reviewed join paths - page 2 of 2");
    expect(page).toContain("Table 6 (public.table_6)");
    expect(page).toContain("Boundary: support_review");
    expect(page).toContain("Can answer: record counts; grouping by Field 6");
    expect(page).toContain('/catalog 1 previous.');
    expect(page).not.toContain("Table 1 (public.table_1)");
    expect(renderReviewedAccessCatalog({
      line: "/catalog all",
      summary: { table_count: resources.length, resources, suggestions: [] },
    })).toContain(
      "Usage: /catalog [page] or /catalog --diagram [--boundary <name>] [--export [path]]",
    );
  });

  it("exposes the detailed reviewed catalog as a shell action", async () => {
    const io = fakeIo(["/catalog", "/exit"]);
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      boundaryLabel: "reviewed_staging",
      profileLabel: "development",
      reviewedDataAreas: 1,
      accessSummary: {
        table_count: 1,
        resources: [{
          id: "public.orders",
          label: "Orders",
          boundary_name: "reviewed_staging",
          capabilities: ["record counts", "grouping by Status"],
          suggestions: ["Which statuses have the most orders?"],
        }],
        suggestions: ["Which statuses have the most orders?"],
      },
      boundaryCatalog: reviewedCatalog(),
      io,
      ask: vi.fn(),
      listAnalyses: async () => [],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });
    expect(io.output()).toContain("CAN ASK NOW");
    expect(io.output()).toContain("Boundary: reviewed_staging");
    expect(io.output()).toContain("Can answer: record counts; grouping by Status");
    expect(io.output()).toContain(
      "Join path: public.orders.customer_id -> public.customers.id (1 join, catalog proven)",
    );
    expect(io.output()).toContain('Ask across path: "What is total order cents by customer region?"');
    expect(io.output()).toContain("Reachable: public.customers");
    expect(io.output()).toContain("/catalog --diagram");
  });

  it("renders the shared active-boundary model as ASCII and Mermaid", async () => {
    const io = fakeIo(["/catalog --diagram", "/exit"], 72);
    await runAnalyticsShell({
      providerLabel: "Anthropic",
      boundaryLabel: "reviewed_staging",
      profileLabel: "development",
      reviewedDataAreas: 2,
      boundaryCatalog: reviewedCatalog(),
      io,
      ask: vi.fn(),
      listAnalyses: async () => [],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });
    expect(io.output()).toContain("ACTIVE BOUNDARY DIAGRAM");
    expect(io.output()).toContain("Boundary reviewed_staging");
    expect(io.output()).toContain("2 tables | 1 physical join | 1 reviewed path");
    expect(io.output()).toContain("[public.orders]");
    expect(io.output()).toContain("customer_id -> [public.customers].id");
    expect(io.output()).toContain("TRY CROSS-TABLE QUESTIONS");
    expect(io.output()).toContain("```mermaid");
    expect(io.output()).toContain("PUBLIC_ORDERS }o--|| PUBLIC_CUSTOMERS");
  });

  it("requires an exact boundary for multi-boundary diagrams and exports one digest-bound map", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-catalog-export-"));
    try {
      const catalog = reviewedCatalog();
      const second = structuredClone(catalog.boundaries[0]!);
      second.name = "support_review";
      second.digest = `sha256:${"b".repeat(64)}`;
      catalog.boundaries.push(second);
      catalog.table_count = 4;
      catalog.relationship_count = 2;
      catalog.physical_relationship_count = 2;

      const io = fakeIo([
        "/catalog --diagram",
        "/catalog --diagram --boundary support_review --export",
        "/exit",
      ]);
      await runAnalyticsShell({
        projectRoot,
        providerLabel: "OpenAI",
        boundaryLabel: "2 active boundaries",
        profileLabel: "development",
        reviewedDataAreas: 4,
        boundaryCatalog: catalog,
        io,
        ask: vi.fn(),
        listAnalyses: async () => [],
        protect: vi.fn(),
        clearConversation: vi.fn(),
        cancel: vi.fn(() => false),
      });

      expect(io.output()).toContain("2 reviewed boundaries are active");
      expect(io.output()).toContain("/catalog --diagram --boundary reviewed_staging");
      expect(io.output()).toContain("BOUNDARY DIAGRAM EXPORTED");
      const exported = path.join(
        projectRoot,
        ".synapsor/catalog/support_review-bbbbbbbbbbbb.boundary-diagram.md",
      );
      const content = await fs.readFile(exported, "utf8");
      expect(content).toContain("# Reviewed Boundary: support_review");
      expect(content).toContain("## Mermaid ER Diagram");
      expect(content).toContain("PUBLIC_ORDERS }o--|| PUBLIC_CUSTOMERS");
      expect(content).toContain("TRY CROSS-TABLE QUESTIONS");
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("refuses explicit diagram exports outside the project, including symlink escapes", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-catalog-confined-"));
    const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-catalog-outside-"));
    const siblingPath = path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}-escaped.md`);
    const absolutePath = path.join(outsideRoot, "absolute-escaped.md");
    const symlinkPath = path.join(projectRoot, "linked-outside");
    await fs.symlink(outsideRoot, symlinkPath, "dir");
    try {
      const io = fakeIo([
        `/catalog --diagram --boundary reviewed_staging --export ../${path.basename(siblingPath)}`,
        `/catalog --diagram --boundary reviewed_staging --export ${absolutePath}`,
        "/catalog --diagram --boundary reviewed_staging --export linked-outside/symlink-escaped.md",
        "/exit",
      ]);
      await runAnalyticsShell({
        projectRoot,
        providerLabel: "OpenAI",
        boundaryLabel: "reviewed_staging",
        profileLabel: "development",
        reviewedDataAreas: 2,
        boundaryCatalog: reviewedCatalog(),
        io,
        ask: vi.fn(),
        listAnalyses: async () => [],
        protect: vi.fn(),
        clearConversation: vi.fn(),
        cancel: vi.fn(() => false),
      });

      expect(io.output()).toContain("Export path must stay inside this project");
      expect(io.output()).toContain("Export directory resolves outside this project");
      await expect(fs.access(siblingPath)).rejects.toThrow();
      await expect(fs.access(absolutePath)).rejects.toThrow();
      await expect(fs.access(path.join(outsideRoot, "symlink-escaped.md"))).rejects.toThrow();
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
      await fs.rm(outsideRoot, { recursive: true, force: true });
      await fs.rm(siblingPath, { force: true });
    }
  });

  it("shows, filters, and fully clears transient slash actions while editing", async () => {
    expect(slashCommandSuggestions("/")).toContain("/access");
    expect(slashCommandSuggestions("/ac")).toEqual(["/access", "/access-workbench"]);
    expect(slashCommandSuggestions("/catalog --d")).toEqual(["/catalog --diagram"]);
    expect(slashCommandSuggestions("/catalog --diagram ")).toEqual(["/catalog --diagram"]);
    expect(slashCommandSuggestions("question")).toEqual([]);
    expect(renderSlashCommandMenu("/ac")).toContain("/access-workbench");
    expect(renderSlashCommandMenu("/catalog --diagram")).toContain(
      "Show connected reviewed paths and Mermaid",
    );
    expect(renderSlashCommandMenu("/catalog --diagram")).not.toContain("No matching action");
    expect(renderSlashCommandMenu("/missing")).toContain("No matching action");

    for (const command of [
      "/catalog 2",
      "/catalog --diagram --boundary reviewed_staging",
      "/catalog --diagram --boundary reviewed_staging --export",
      "/details last",
      "/details --sql",
      "/details A7",
      "/details last --sql",
      "/details A7 --sql",
      "/protect last",
      "/protect A7",
      "/protect A7 as analytics.orders_by_region",
      "/access workbench",
    ]) {
      expect(renderSlashCommandMenu(command), command).not.toContain("No matching action");
    }
    for (const partial of [
      "/details l",
      "/details A",
      "/details A7 --s",
      "/protect A",
      "/protect A7 as",
      "/access work",
    ]) {
      expect(renderSlashCommandMenu(partial), partial).not.toContain("No matching action");
    }
    expect(renderSlashCommandMenu("/details yesterday")).toContain("No matching action");
    expect(renderSlashCommandMenu("/catalog zero")).toContain("No matching action");

    const readable = new PassThrough();
    const writable = new PassThrough();
    const chunks: string[] = [];
    writable.on("data", (chunk) => chunks.push(String(chunk)));
    const io = createTerminalAnalyticsShellIo({ readable, writable, terminal: true });
    const answer = io.read("synapsor> ");
    readable.write("/");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const firstMenu = chunks.join("");
    expect(firstMenu).toContain("  synapsor> ");
    expect(firstMenu).toContain("/access");
    expect(firstMenu).toContain("Add or edit reviewed boundaries");
    expect(firstMenu.indexOf("synapsor> ")).toBeLessThan(firstMenu.indexOf("/access"));
    expect(firstMenu).not.toContain("\u001b7");
    expect(firstMenu).not.toContain("\u001b8");

    let offset = chunks.join("").length;
    readable.write("a");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const filtered = chunks.join("").slice(offset);
    expect(filtered).toContain("/access");
    expect(filtered).not.toContain("/help");

    readable.write("\u007f");
    await new Promise<void>((resolve) => setImmediate(resolve));
    offset = chunks.join("").length;
    readable.write("\u007f");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const cleared = chunks.join("").slice(offset);
    expect(cleared).toContain("\u001b[0J");
    expect(cleared).toContain("  synapsor> ");
    expect(cleared).not.toContain("/access");
    expect(cleared).not.toContain("Keep typing");

    readable.write("/");
    await new Promise<void>((resolve) => setImmediate(resolve));
    readable.write("\r");
    await expect(answer).resolves.toBe("/");
    const submitted = chunks.join("");
    const finalClear = submitted.lastIndexOf("\u001b[0J");
    expect(finalClear).toBeGreaterThan(submitted.lastIndexOf("/access"));
    expect(submitted.slice(finalClear)).toContain("  synapsor> /");
    expect(chunks.join("")).not.toContain("\u001b[s");
    expect(chunks.join("")).not.toContain("\u001b[u");
    expect(chunks.join("")).not.toContain("\u001b7");
    expect(chunks.join("")).not.toContain("\u001b8");
    io.close();
  });

  it("keeps the complete catalog diagram action valid in the live slash menu", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const chunks: string[] = [];
    writable.on("data", (chunk) => chunks.push(String(chunk)));
    const io = createTerminalAnalyticsShellIo({ readable, writable, terminal: true });
    const answer = io.read("synapsor> ");

    readable.write("/catalog --diagram");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rendered = chunks.join("");
    expect(rendered).toContain("/catalog --diagram");
    expect(rendered).toContain("Show connected reviewed paths and Mermaid");
    expect(rendered).not.toContain("No matching action");

    readable.write("\r");
    await expect(answer).resolves.toBe("/catalog --diagram");
    io.close();
  });

  it("keeps accepted argument commands valid in the live slash menu", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const chunks: string[] = [];
    writable.on("data", (chunk) => chunks.push(String(chunk)));
    const io = createTerminalAnalyticsShellIo({ readable, writable, terminal: true });
    const answer = io.read("synapsor> ");

    readable.write("/details last");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const rendered = chunks.join("");
    expect(rendered).toContain("/details last");
    expect(rendered).toContain("Inspect the latest analysis");
    expect(rendered).not.toContain("No matching action");

    readable.write("\r");
    await expect(answer).resolves.toBe("/details last");
    io.close();
  });

  it("fully clears slash actions after a completed model turn", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough() as PassThrough & { columns: number };
    writable.columns = 80;
    const chunks: string[] = [];
    writable.on("data", (chunk) => chunks.push(String(chunk)));
    const io = createTerminalAnalyticsShellIo({ readable, writable, terminal: true });

    const firstAnswer = io.read("synapsor> ");
    readable.write("How did revenue change?\r");
    await expect(firstAnswer).resolves.toBe("How did revenue change?");
    io.write([
      "MODEL INTERPRETATION",
      "Revenue increased over the reviewed period.",
      "",
      "RUNNER-VERIFIED DATA",
      "week          total",
      "2026-07-27    4805300",
      "",
    ].join("\n"));

    const secondAnswer = io.read("synapsor> ");
    readable.write("/");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const menuEnd = chunks.join("").length;
    expect(chunks.join("")).toContain("/access-workbench");

    readable.write("\u007f");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const cleared = chunks.join("").slice(menuEnd);
    expect(cleared).toContain("\u001b[0J");
    expect(cleared).toContain("  synapsor> ");
    expect(cleared).not.toContain("/access-workbench");
    expect(cleared).not.toContain("Keep typing");

    readable.write("done\r");
    await expect(secondAnswer).resolves.toBe("done");
    io.close();
  });

  it("recalls submitted questions with Up after a completed model turn", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough() as PassThrough & { columns: number };
    writable.columns = 80;
    writable.on("data", () => undefined);
    const io = createTerminalAnalyticsShellIo({ readable, writable, terminal: true });

    const firstAnswer = io.read("synapsor> ");
    readable.write("How did revenue change?\r");
    await expect(firstAnswer).resolves.toBe("How did revenue change?");
    io.write("RUNNER-VERIFIED DATA\n");

    const secondAnswer = io.read("synapsor> ");
    readable.write("\u001b[A\r");
    await expect(secondAnswer).resolves.toBe("How did revenue change?");
    io.close();
  });

  it("dismisses slash actions with Escape without submitting or duplicating them", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const chunks: string[] = [];
    writable.on("data", (chunk) => chunks.push(String(chunk)));
    const io = createTerminalAnalyticsShellIo({ readable, writable, terminal: true });
    const answer = io.read("synapsor> ");

    readable.write("/ac");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const beforeEscape = chunks.join("");
    expect(beforeEscape).toContain("/access-workbench");

    readable.emit("keypress", "", { name: "escape", sequence: "\u001b" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const escaped = chunks.join("").slice(beforeEscape.length);
    expect(escaped).toContain("\u001b[0J");
    expect(escaped).not.toContain("/access-workbench");

    readable.write("\r");
    await expect(answer).resolves.toBe("/ac");
    io.close();
  });

  it("renders one animated TTY status line and erases it before normal output", () => {
    const readable = new PassThrough();
    const writable = new PassThrough();
    const chunks: string[] = [];
    writable.on("data", (chunk) => chunks.push(String(chunk)));
    const io = createTerminalAnalyticsShellIo({
      readable,
      writable,
      terminal: true,
    });

    io.setStatus?.("Waiting for the provider...");
    io.setStatus?.("Running a reviewed data tool...");
    io.clearStatus?.();
    io.write("Answer\n");
    io.close();

    const output = chunks.join("");
    expect(output).toContain("\r\u001b[2K\u001b[2m  - Waiting for the provider...\u001b[0m");
    expect(output).toContain("\r\u001b[2K\u001b[2m  - Running a reviewed data tool...\u001b[0m");
    expect(output).toContain("\r\u001b[2K  Answer\n");
    expect(output).not.toContain("Waiting for the provider...\n");
    expect(output).not.toContain("Running a reviewed data tool...\n");
  });

  it("adds breathing room only for interactive terminals", () => {
    const terminalReadable = new PassThrough();
    const terminalWritable = new PassThrough() as PassThrough & { columns: number };
    terminalWritable.columns = 80;
    const terminalChunks: string[] = [];
    terminalWritable.on("data", (chunk) => terminalChunks.push(String(chunk)));
    const terminalIo = createTerminalAnalyticsShellIo({
      readable: terminalReadable,
      writable: terminalWritable,
      terminal: true,
    });
    terminalIo.write("Heading\nBody\n");
    expect(terminalChunks.join("")).toContain("  Heading\n  Body\n");
    expect(terminalIo.columns()).toBe(76);
    terminalIo.close();

    const pipedReadable = new PassThrough();
    const pipedWritable = new PassThrough();
    const pipedChunks: string[] = [];
    pipedWritable.on("data", (chunk) => pipedChunks.push(String(chunk)));
    const pipedIo = createTerminalAnalyticsShellIo({
      readable: pipedReadable,
      writable: pipedWritable,
      terminal: false,
    });
    pipedIo.write("Heading\nBody\n");
    expect(pipedChunks.join("")).toBe("Heading\nBody\n");
    expect(pipedIo.columns()).toBe(100);
    pipedIo.close();
  });

  it("keeps blank terminal rows below the live analytics prompt", async () => {
    const readable = new PassThrough();
    const writable = new PassThrough() as PassThrough & { columns: number };
    writable.columns = 80;
    const chunks: string[] = [];
    writable.on("data", (chunk) => chunks.push(String(chunk)));
    const io = createTerminalAnalyticsShellIo({ readable, writable, terminal: true });

    const answer = io.read("synapsor> ");
    await new Promise<void>((resolve) => setImmediate(resolve));
    const prompt = chunks.join("");
    expect(prompt).toContain("  synapsor> ");
    expect(prompt).toContain("\r\n\r\n");
    expect(prompt).toContain("\u001b[2A");

    readable.write("/exit\r");
    await expect(answer).resolves.toBe("/exit");
    io.close();
  });

  it("does not make provider prose or a no-tool answer protectable", async () => {
    const io = fakeIo([
      "Tell me something without querying.",
      "/protect",
      "n",
      "/exit",
    ]);
    const protect = vi.fn();
    await runAnalyticsShell({
      providerLabel: "Local",
      profileLabel: "development",
      reviewedDataAreas: 1,
      io,
      ask: async () => ({
        turn: turn("/protect A1 as model.tried_to_run_this"),
        analyses: [],
        answer_id: "ans_ffffffffffffffffffffffff",
      }),
      listAnalyses: async () => [storedAnalysis("A1")],
      protect,
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    expect(io.output()).toContain("No Runner data query was executed");
    expect(io.output()).toContain("This answer did not run a new analysis");
    expect(protect).not.toHaveBeenCalled();
  });

  it("shows disabled source-proven access as an operator path without claiming it is active", async () => {
    const io = fakeIo(["Which product category is growing fastest?", "/exit"]);
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: async () => ({
        turn: turn("Product category is outside the reviewed boundary."),
        analyses: [],
        answer_id: "ans_candidate_guidance",
        access_guidance: {
          kind: "review_candidate",
          title: "Category is not in the active boundary",
          message: "Runner found a source-proven candidate. It remains disabled until human review.",
          candidate_path: "Order items -> Products -> Orders",
          review_resource: "public.order_items",
          review_field: "category",
          next_action: "Use /access. Nothing is activated automatically.",
        },
      }),
      listAnalyses: async () => [],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });
    const output = io.output();
    expect(output).toContain("HUMAN REVIEW PATH");
    expect(output).toContain("Category is not in the active boundary");
    expect(output).toContain("Order items -> Products -> Orders");
    expect(output).toContain("Nothing is activated automatically");
  });

  it("clears only in-memory conversation state", async () => {
    const io = fakeIo(["/clear", "/exit"]);
    const clearConversation = vi.fn();
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "development",
      reviewedDataAreas: 1,
      io,
      ask: vi.fn(),
      listAnalyses: async () => [],
      protect: vi.fn(),
      clearConversation,
      cancel: vi.fn(() => false),
    });

    expect(clearConversation).toHaveBeenCalledOnce();
    expect(io.output()).toContain("Durable evidence and protected drafts were not deleted");
  });

  it("lists and inspects safe metadata while redacting plan literals", async () => {
    const io = fakeIo(["/analyses", "/details A1", "/exit"]);
    const stored = storedAnalysis("A1");
    const normalizedPlan = stored.normalized_plan!;
    stored.normalized_plan = {
      ...normalizedPlan,
      where: [{ field: "region", op: "eq", value: "secret-region-value" }],
    };
    stored.evidence_bundle_id = "ev_safe_metadata";
    stored.query_audit_handle = `sha256:${"b".repeat(64)}`;
    stored.returned_rows_or_groups = 2;
    stored.returned_cells = 4;
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: vi.fn(),
      listAnalyses: async () => [stored],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    expect(io.output()).toContain("Recent analyses");
    expect(io.output()).toContain("Use /protect, /protect A1, or /details A1.");
    expect(io.output()).toContain("Evidence: ev_safe_metadata");
    expect(io.output()).toContain("Source database changed: no");
    expect(io.output()).toContain("<redacted>");
    expect(io.output()).not.toContain("secret-region-value");
  });

  it("shows the live question and exact typed tool request without exposing SQL by default", async () => {
    const io = fakeIo(["How many sessions are in each region?", "/details A1", "/exit"]);
    const liveAnalysis = analysis("A1", 0);
    liveAnalysis.arguments = {
      boundary: "reviewed_sessions",
      plan: liveAnalysis.plan,
    };
    const inspectAnalysis = vi.fn(async () => operatorEvidence());
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: async () => ({
        turn: turn("West has the most sessions."),
        analyses: [liveAnalysis],
        answer_id: "ans_live_evidence",
      }),
      listAnalyses: async () => [storedAnalysis("A1")],
      protect: vi.fn(),
      inspectAnalysis,
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    const output = io.output();
    expect(output).toContain("How many sessions are in each region?");
    expect(output).toContain("WHAT THE MODEL REQUESTED");
    expect(output).toContain('"boundary": "reviewed_sessions"');
    expect(output).toContain("WHAT RUNNER EXECUTED");
    expect(output).toContain("Use /details --sql");
    expect(output).not.toContain('SELECT "region"');
    expect(inspectAnalysis).toHaveBeenCalledOnce();
  });

  it("syntax-highlights detail JSON only for interactive color terminals", async () => {
    const value = {
      boundary: "reviewed_sessions",
      plan: {
        kind: "aggregate",
        top_n: 1,
        enabled: true,
        optional: null,
      },
    };
    const plain = renderTerminalJson(value);
    expect(plain).toBe(JSON.stringify(value, null, 2));
    expect(plain).not.toContain("\u001b[");

    const colored = renderTerminalJson(value, true);
    expect(colored).toContain('\u001b[1;36m"boundary"\u001b[0m');
    expect(colored).toContain('\u001b[1;32m"reviewed_sessions"\u001b[0m');
    expect(colored).toContain("\u001b[1;33m1\u001b[0m");
    expect(colored).toContain("\u001b[1;35mtrue\u001b[0m");
    expect(colored).toContain("\u001b[2mnull\u001b[0m");
    expect(colored).toContain("\u001b[2m{\u001b[0m");

    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    const io = fakeIo(["How many sessions are in each region?", "/details A1", "/exit"], 100, true);
    const liveAnalysis = analysis("A1", 0);
    liveAnalysis.arguments = { boundary: "reviewed_sessions", plan: liveAnalysis.plan };
    try {
      await runAnalyticsShell({
        providerLabel: "OpenAI",
        profileLabel: "staging",
        reviewedDataAreas: 1,
        io,
        ask: async () => ({
          turn: turn("West has the most sessions."),
          analyses: [liveAnalysis],
          answer_id: "ans_colored_details",
        }),
        listAnalyses: async () => [storedAnalysis("A1")],
        protect: vi.fn(),
        clearConversation: vi.fn(),
        cancel: vi.fn(() => false),
      });
    } finally {
      if (previousNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = previousNoColor;
    }
    expect(io.output()).toContain('\u001b[1;36m"boundary"\u001b[0m');
    expect(io.output()).toContain('\u001b[1;32m"reviewed_sessions"\u001b[0m');
  });

  it("reveals only placeholder SQL and parameter types through the explicit operator detail action", async () => {
    const io = fakeIo(["How many sessions are in each region?", "/details A1 --sql", "/exit"]);
    const liveAnalysis = analysis("A1", 0);
    liveAnalysis.arguments = { boundary: "reviewed_sessions", plan: liveAnalysis.plan };
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: async () => ({
        turn: turn("West has the most sessions."),
        analyses: [liveAnalysis],
        answer_id: "ans_live_sql_evidence",
      }),
      listAnalyses: async () => [storedAnalysis("A1")],
      protect: vi.fn(),
      inspectAnalysis: async () => operatorEvidence(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    const output = io.output();
    expect(output).toContain("COMPILED DATABASE STATEMENT");
    expect(output).toContain("Operator diagnostic only. The model never received this SQL.");
    expect(output).toContain('SELECT "region", COUNT(*) FROM "public"."sessions" WHERE "tenant_id" = $1');
    expect(output).toContain("Parameter types: string, integer");
    expect(output).toContain("Parameter values: redacted");
    expect(output).not.toContain("tenant-secret-value");
  });

  it("syntax-highlights compiled SQL only for interactive color terminals", () => {
    const statement = 'SELECT t0."feature", SUM(t0."event_count") FROM "public"."usage_events" t0 WHERE t0."organization_id" = $1 ORDER BY "measure_0" DESC LIMIT $2';
    expect(renderTerminalSql(statement)).toBe(statement);
    expect(renderTerminalSql(statement)).not.toContain("\u001b[");

    const colored = renderTerminalSql(statement, true);
    expect(colored).toContain("\u001b[1;36mSELECT\u001b[0m");
    expect(colored).toContain('\u001b[1;32m"feature"\u001b[0m');
    expect(colored).toContain("\u001b[1;34mSUM\u001b[0m");
    expect(colored).toContain("\u001b[1;33m$1\u001b[0m");
    expect(colored).toContain("\u001b[1;36mORDER\u001b[0m");
    expect(colored).toContain("\u001b[1;36mDESC\u001b[0m");
    expect(colored).toContain("\u001b[1;33m$2\u001b[0m");
  });

  it("does not mislabel a derived number as absent from the verified result", async () => {
    const io = fakeIo(["did the daily count change", "/exit"]);
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: async () => ({
        turn: turn("Both returned days had 11 check-ins, so the net change was 0."),
        analyses: [analysis("A1", 0)],
        answer_id: "ans_111111111111111111111111",
      }),
      listAnalyses: async () => [storedAnalysis("A1")],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    expect(io.output()).toContain("net change was 0");
    expect(io.output()).toContain("184");
    expect(io.output()).not.toContain("not present in the verified result");
    expect(io.output()).not.toContain("below the reviewed minimum cohort");
  });

  it("does not present visible-subtotal shares as percentages of a suppressed population", async () => {
    const io = fakeIo(["what percentage of all orders came from each region", "/exit"]);
    const result = analysis("A1", 1);
    result.result.data = [
      { region: "pacific", count: 127 },
      { region: "mountain", count: 99 },
    ];
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: async () => ({
        turn: turn("Pacific has 56.2% of the visible returned subtotal."),
        analyses: [result],
        answer_id: "ans_visible_subtotal_share",
      }),
      listAnalyses: async () => [storedAnalysis("A1")],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    expect(io.output()).toContain("exact share of the complete population is unavailable");
    expect(io.output()).toContain("returned non-suppressed subtotal");
  });

  it("explains model-withheld values and exposes an operator-only visual access editor action", async () => {
    const io = fakeIo(["show reviewed groups", "/help", "/access-workbench", "/exit"]);
    const openAccessEditor = vi.fn(async () => ({
      workbenchUrl: "http://127.0.0.1:48123/?view=exceptions",
    }));
    const response = turn("The opaque group with the largest count has 184 records.");
    response.tool_calls = [{
      call_id: "call_withheld",
      tool: "app.explore_data",
      provider_tool: "app__explore_data",
      status: "ok",
      arguments: {},
      result: { data: [{ region: "west", count: 184 }] },
      model_withheld_values: true,
    }];
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: async () => ({
        turn: response,
        analyses: [analysis("A1", 0)],
        answer_id: "ans_121212121212121212121212",
      }),
      listAnalyses: async () => [storedAnalysis("A1")],
      protect: vi.fn(),
      openAccessEditor,
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    expect(io.output()).toContain("shown only in the Runner-verified result");
    expect(io.output()).toContain("/access");
    expect(io.output()).toContain("Review, add, or edit Explore boundaries");
    expect(io.output()).toContain("http://127.0.0.1:48123/");
    expect(openAccessEditor).toHaveBeenCalledOnce();
  });

  it("leaves chat cleanly for the terminal access editor", async () => {
    const io = fakeIo(["/access"]);
    await expect(runAnalyticsShell({
      providerLabel: "OpenAI",
      modelLabel: "gpt-5-mini",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: vi.fn(),
      listAnalyses: async () => [],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    })).resolves.toBe("access");
    expect(io.output()).toContain("After activation, this shell resumes with the same provider, model, and in-memory key.");

    expect(io.output()).toContain("Opening the terminal boundary editor");
    expect(io.output()).toContain("Model: gpt-5-mini");
  });

  it("withholds model prose when the complete result is privacy-suppressed", async () => {
    const io = fakeIo(["show the smallest customer group", "/exit"]);
    const suppressed = analysis("A1", 1);
    suppressed.result.data = [];
    suppressed.result.outcome = { status: "fully_suppressed" };
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "staging",
      reviewedDataAreas: 1,
      io,
      ask: async () => ({
        turn: turn("Enterprise had 2 sessions."),
        analyses: [suppressed],
        answer_id: "ans_333333333333333333333333",
      }),
      listAnalyses: async () => [storedAnalysis("A1")],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });

    expect(io.output()).toContain("complete reviewed result was suppressed");
    expect(io.output()).not.toContain("Enterprise");
    expect(io.output()).not.toContain("2 sessions");
  });

  it("uses Ctrl+C to cancel an active request and returns to the prompt", async () => {
    const io = interruptibleIo([
      "show reviewed totals",
      "/exit",
    ]);
    let rejectAsk: ((error: Error) => void) | undefined;
    let started!: () => void;
    const askStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const cancel = vi.fn(() => {
      rejectAsk?.(new Error("The Ask request was cancelled."));
      return true;
    });
    const running = runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "development",
      reviewedDataAreas: 1,
      io,
      ask: async () => new Promise((_, reject) => {
        rejectAsk = reject;
        started();
      }),
      listAnalyses: async () => [],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel,
    });
    await askStarted;
    io.interrupt();
    await running;

    expect(cancel).toHaveBeenCalledOnce();
    expect(io.output()).toContain("Cancelling the active request");
    expect(io.output()).toContain("The Ask request was cancelled");
  });

  it("exits cleanly on Ctrl+D and on a second idle Ctrl+C", async () => {
    const eof = fakeIo([]);
    await runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "development",
      reviewedDataAreas: 1,
      io: eof,
      ask: vi.fn(),
      listAnalyses: async () => [],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });
    expect(eof.output()).toContain("Ctrl+D exits");

    const idle = idleInterruptibleIo();
    const running = runAnalyticsShell({
      providerLabel: "OpenAI",
      profileLabel: "development",
      reviewedDataAreas: 1,
      io: idle,
      ask: vi.fn(),
      listAnalyses: async () => [],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    idle.interrupt();
    expect(idle.output()).toContain("Press Ctrl+C again or Ctrl+D to exit.");
    idle.interrupt();
    await running;
    expect(idle.closed()).toBe(true);
  });

  it("escapes terminal control sequences in provider prose and database values", async () => {
    const io = fakeIo(["show rows", "/exit"], 40);
    const malicious = analysis("A1", 0);
    malicious.result.data = [{
      region: "\u001b[2Jfake-prompt\u0007\nsynapsor> /protect A1\u202e",
      count: 12,
    }];
    await runAnalyticsShell({
      providerLabel: "Local",
      profileLabel: "development",
      reviewedDataAreas: 1,
      io,
      ask: async () => ({
        turn: turn("\u001b[31mtrusted\u001b[0m"),
        analyses: [malicious],
        answer_id: "ans_cccccccccccccccccccccccc",
      }),
      listAnalyses: async () => [],
      protect: vi.fn(),
      clearConversation: vi.fn(),
      cancel: vi.fn(() => false),
    });
    expect(io.output()).not.toContain("\u001b");
    expect(io.output()).not.toContain("\nsynapsor> /protect A1");
    expect(io.output()).toContain("\\u001b");
    expect(io.output()).toContain("\\u0007");
    expect(io.output()).toContain("\\u000a");
    expect(io.output()).toContain("\\u202e");
  });
});

function turn(answer: string): AskTurnResult {
  return {
    ok: true,
    answer,
    answer_is_untrusted_model_output: true,
    answer_source: "model",
    provider: "openai",
    model: "gpt-test",
    authority_digest: digest,
    tool_calls: [],
    source_database_changed: false,
  };
}

function analysis(reference: string, suppressed: number): AnalyticsAnalysis {
  return {
    index: 1,
    tool: "app.explore_data",
    status: "ok",
    reference,
    expires_at: "2026-07-27T12:00:00.000Z",
    description: "sessions grouped by region",
    suggested_capability: "analytics.sessions_count_by_region",
    plan: {
      kind: "aggregate",
      resource: "public.sessions",
      measures: [{ function: "count" }],
      dimensions: [{ field: "region" }],
      top_n: 10,
    },
    result: {
      ok: true,
      boundary_name: "support_analytics",
      data: [{ region: "west", count: 184 }, { region: "north", count: 121 }],
      privacy: {
        minimum_cohort_size: 5,
        suppressed_groups: suppressed,
        totals_returned: false,
      },
      source_database_changed: false,
    },
    evidence_bundle_id: "ev_safe",
    query_audit_handle: digest,
    source_database_changed: false,
  };
}

function catalogAnalysis(): AnalyticsAnalysis {
  return {
    index: 1,
    tool: "app.describe_data",
    status: "ok",
    description: "Reviewed data catalog",
    result: {
      ok: true,
      resources: [{ id: "public.sessions" }],
    },
    source_database_changed: false,
  };
}

function refusedAnalysis(errorCode: string, message: string): AnalyticsAnalysis {
  return {
    index: 1,
    tool: "app.explore_data",
    status: "refused",
    error_code: errorCode,
    description: "reviewed aggregate attempt",
    result: {
      ok: false,
      message,
    },
    source_database_changed: false,
  };
}

function storedAnalysis(reference: string): ShellAnalysisRecord {
  const current = analysis(reference, 0);
  return {
    token: reference,
    expires_at: current.expires_at!,
    boundary_digest: digest,
    normalized_plan: current.plan!,
    description: current.description,
    suggested_capability: current.suggested_capability!,
  };
}

function operatorEvidence() {
  return {
    engine: "postgres" as const,
    boundary_name: "reviewed_sessions",
    boundary_digest: digest,
    trusted_scope: {
      tenant: "PostgreSQL role setting app.tenant_id",
      principal: "not required by this boundary",
      values_included: false as const,
    },
    role_posture: {
      status: "verified_before_execution" as const,
      fingerprint: digest,
    },
    transaction: "single_read_only_transaction" as const,
    statements: [{
      statement: 'SELECT "region", COUNT(*) FROM "public"."sessions" WHERE "tenant_id" = $1 LIMIT $2',
      parameter_types: ["string", "integer"],
      parameter_values: "redacted" as const,
    }],
    model_received_sql: false as const,
    persisted: false as const,
  };
}

function dummyDraft() {
  return {
    schema_version: "synapsor.protected-query.v1" as const,
    state: "disabled" as const,
    capability: "analytics.analysis",
    source: "app",
    mode: "aggregate" as const,
    boundary_digest: digest,
    generation_lock_fingerprint: digest,
    contract_digest: digest,
    dsl_path: "capability.synapsor.sql",
    contract_path: "synapsor.contract.json",
    tests_path: "contract-tests.json",
    review_path: "REVIEW.md",
    literal_positions: [],
    converted_arguments: [],
  };
}

function reviewedCatalog(): BoundaryCatalogModel {
  return {
    schema_version: "synapsor.boundary-catalog.v1",
    table_count: 2,
    relationship_count: 1,
    physical_relationship_count: 1,
    boundaries: [{
      name: "reviewed_staging",
      digest,
      physical_relationship_count: 1,
      tables: [
        {
          id: "public.orders",
          label: "Orders",
          model_visible_fields: [
            { name: "id", data_type: "text" },
            { name: "status", data_type: "text" },
          ],
          runner_only_field_count: 0,
          kept_out_field_count: 1,
          outside_boundary_relationship_count: 0,
          reachable_tables: ["public.customers"],
          groupable_fields: ["status"],
          aggregate_measures: ["total_cents"],
          count_distinct_fields: ["id"],
          time_bucket_fields: ["created_at"],
          runner_only_analysis: {
            groupable_fields: [],
            aggregate_measures: [],
            count_distinct_fields: [],
            time_bucket_fields: [],
          },
        },
        {
          id: "public.customers",
          label: "Customers",
          model_visible_fields: [
            { name: "id", data_type: "text" },
            { name: "region", data_type: "text" },
          ],
          runner_only_field_count: 0,
          kept_out_field_count: 2,
          outside_boundary_relationship_count: 0,
          reachable_tables: [],
          groupable_fields: ["region"],
          aggregate_measures: [],
          count_distinct_fields: ["id"],
          time_bucket_fields: [],
          runner_only_analysis: {
            groupable_fields: [],
            aggregate_measures: [],
            count_distinct_fields: [],
            time_bucket_fields: [],
          },
        },
      ],
      relationships: [{
        id: "orders_customer_fkey",
        source_table: "public.orders",
        target_table: "public.customers",
        source_key: "customer_id",
        target_key: "id",
        hidden_join_key: false,
        cardinality: "many_to_one",
        proven: true,
        nullable: false,
        path_depth: 1,
        links: [{
          source_table: "public.orders",
          target_table: "public.customers",
          source_key: "customer_id",
          target_key: "id",
          hidden_join_key: false,
          proven: true,
          nullable: false,
        }],
        suggested_questions: [
          "What is total order cents by customer region?",
          "How did total order cents change by month for each customer region?",
        ],
      }],
    }],
  };
}

function fakeIo(inputs: string[], columns = 100, terminal = false): AnalyticsShellIo & {
  output(): string;
  statuses(): string[];
  currentStatus(): string;
} {
  const chunks: string[] = [];
  const statuses: string[] = [];
  let currentStatus = "";
  return {
    read: async (prompt) => {
      chunks.push(prompt);
      return inputs.shift();
    },
    write: (value) => {
      chunks.push(value);
    },
    setStatus: (value) => {
      currentStatus = value;
      statuses.push(value);
    },
    clearStatus: () => {
      currentStatus = "";
    },
    isTerminal: () => terminal,
    columns: () => columns,
    onInterrupt: () => () => undefined,
    close: () => undefined,
    output: () => chunks.join(""),
    statuses: () => [...statuses],
    currentStatus: () => currentStatus,
  };
}

function interruptibleIo(inputs: string[]): AnalyticsShellIo & {
  output(): string;
  interrupt(): void;
} {
  const chunks: string[] = [];
  let interruptHandler: (() => void) | undefined;
  return {
    read: async (prompt) => {
      chunks.push(prompt);
      return inputs.shift();
    },
    write: (value) => {
      chunks.push(value);
    },
    setStatus: () => undefined,
    clearStatus: () => undefined,
    columns: () => 100,
    onInterrupt: (handler) => {
      interruptHandler = handler;
      return () => {
        if (interruptHandler === handler) interruptHandler = undefined;
      };
    },
    close: () => undefined,
    output: () => chunks.join(""),
    interrupt: () => interruptHandler?.(),
  };
}

function idleInterruptibleIo(): AnalyticsShellIo & {
  output(): string;
  interrupt(): void;
  closed(): boolean;
} {
  const chunks: string[] = [];
  let interruptHandler: (() => void) | undefined;
  let finishRead: ((value: string | undefined) => void) | undefined;
  let isClosed = false;
  return {
    read: async (prompt) => {
      chunks.push(prompt);
      return new Promise<string | undefined>((resolve) => {
        finishRead = resolve;
      });
    },
    write: (value) => chunks.push(value),
    setStatus: () => undefined,
    clearStatus: () => undefined,
    columns: () => 100,
    onInterrupt: (handler) => {
      interruptHandler = handler;
      return () => {
        if (interruptHandler === handler) interruptHandler = undefined;
      };
    },
    close: () => {
      isClosed = true;
      finishRead?.(undefined);
      finishRead = undefined;
    },
    output: () => chunks.join(""),
    interrupt: () => interruptHandler?.(),
    closed: () => isClosed,
  };
}
