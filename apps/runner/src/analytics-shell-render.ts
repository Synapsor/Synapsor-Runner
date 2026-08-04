import type {
  AskToolTrace,
  AskTurnResult,
} from "./model-ask.js";
import type { AskAccessGuidance } from "./ask-access-summary.js";
import {
  describeProtectableAnalysis,
  suggestProtectedCapabilityName,
} from "./protect-query.js";
import type {
  ExplorePlan,
} from "./scoped-explore.js";
import { cliPrivacyReviewInstructions } from "./privacy-review-guidance.js";
import {
  renderTerminalJson,
  safeTerminalCellText,
  safeTerminalText,
} from "./terminal-syntax.js";

export { safeTerminalText } from "./terminal-syntax.js";

export type AnalyticsAnalysis = {
  index: number;
  tool: string;
  status: "ok" | "refused";
  error_code?: string;
  reference?: string;
  expires_at?: string;
  description: string;
  suggested_capability?: string;
  arguments?: Record<string, unknown>;
  plan?: ExplorePlan;
  result: Record<string, unknown>;
  evidence_bundle_id?: string;
  query_audit_handle?: string;
  source_database_changed: false;
};

export function collectAnalyticsAnalyses(toolCalls: AskToolTrace[]): AnalyticsAnalysis[] {
  return toolCalls.map((call, index) => {
    const result = record(call.result);
    const protect = record(result.protect);
    const audit = record(result.audit);
    const rawPlan = record(call.arguments.plan);
    const plan = isExplorePlan(rawPlan) ? rawPlan : undefined;
    const reference = call.tool === "app.explore_data"
      && call.status === "ok"
      && typeof protect.token === "string"
      ? protect.token
      : undefined;
    return {
      index: index + 1,
      tool: call.tool,
      status: call.status,
      ...(call.error_code ? { error_code: call.error_code } : {}),
      ...(reference ? { reference } : {}),
      ...(typeof protect.expires_at === "string" ? { expires_at: protect.expires_at } : {}),
      description: plan
        ? describeProtectableAnalysis(plan)
        : call.tool === "app.describe_data"
          ? "Reviewed data catalog"
          : "Reviewed Runner operation",
      ...(plan ? {
        plan,
        suggested_capability: suggestProtectedCapabilityName(plan),
      } : {}),
      arguments: structuredClone(call.arguments),
      result,
      ...(typeof result.evidence_bundle_id === "string"
        ? { evidence_bundle_id: result.evidence_bundle_id }
        : {}),
      ...(typeof audit.query_fingerprint === "string"
        ? { query_audit_handle: audit.query_fingerprint }
        : {}),
      source_database_changed: false,
    };
  });
}

export function renderAnalyticsTurn(
  turn: AskTurnResult,
  analyses: AnalyticsAnalysis[],
  width = 100,
  options: {
    ansi?: boolean;
    includeAttempts?: boolean;
    attemptsHint?: string;
    accessGuidance?: AskAccessGuidance;
  } = {},
): string {
  const successfulData = analyses.filter((analysis) =>
    analysis.tool !== "app.describe_data"
    && analysis.status === "ok"
    && analysis.result.ok !== false);
  const runnerBoundaryExplanation = Boolean(options.accessGuidance && successfulData.length === 0);
  const explanation = analyses.some(completeResultSuppressed)
    ? "The complete reviewed result was suppressed, so the model explanation is withheld."
    : safeTerminalText(modelAnswerForDisplay(turn.answer, analyses, options.accessGuidance));
  const refused = refusedAnalyses(analyses);
  const refusedSourceExecuted = refused.some(refusedSourceQueryExecuted);
  const withheldFromModel = turn.tool_calls.some((call) => call.model_withheld_values === true);
  const suppressedShareWarning = turn.answer_source === "runner"
    ? undefined
    : populationShareWarning(explanation, successfulData);
  const rule = "-".repeat(Math.max(32, Math.min(72, width)));
  const lines = [
    ...(withheldFromModel
      ? [
        "Some values are shown only in the Runner-verified result and were withheld from the model, so its summary cannot name them.",
        "",
      ]
      : []),
    styledHeading(
      turn.answer_source === "runner" || runnerBoundaryExplanation
        ? "RUNNER BOUNDARY EXPLANATION"
        : "MODEL INTERPRETATION",
      turn.answer_source === "runner" || runnerBoundaryExplanation ? "runner" : "model",
      options.ansi === true,
    ),
    turn.answer_source === "runner" || runnerBoundaryExplanation
      ? explanation
      : styledModelProse(explanation, options.ansi === true),
    ...(suppressedShareWarning
      ? ["", styledNotice(suppressedShareWarning, options.ansi === true)]
      : []),
    "",
  ];
  if (successfulData.length === 0 && refused.length === 0) {
    lines.push(
      styledSystemStatus("RUNNER STATUS", options.ansi === true),
      styledNotice("No Runner data query was executed for this answer.", options.ansi === true),
      ...renderAccessGuidance(options.accessGuidance, options.ansi === true),
      "",
    );
    return lines.join("\n");
  }
  lines.push(
    styledRule(rule, options.ansi === true),
    styledHeading(
      successfulData.length > 0
        ? "RUNNER-VERIFIED DATA"
        : "RUNNER-VERIFIED BOUNDARY RESULT",
      "runner",
      options.ansi === true,
    ),
    successfulData.length > 0
      ? "Structured values rendered by Runner. Model prose cannot replace or alter them."
      : refusedSourceExecuted
        ? "Runner executed a read-only query, then discarded its result because the reviewed privacy boundary blocked its release."
        : "No data query ran because Runner rejected the attempted plans before source execution.",
  );
  for (const analysis of successfulData) {
    lines.push(...renderAnalysis(analysis, width));
  }
  if (refused.length > 0) {
    if (options.includeAttempts) {
      lines.push(...renderRefusedAttempts(refused, options.ansi === true));
    } else if (successfulData.length === 0) {
      const latest = refused[refused.length - 1]!;
      lines.push(
        ...renderAnalysis(latest, width),
        ...(refused.length > 1
          ? [
              "",
              styledNotice(
                `${refused.length - 1} additional refused attempt${refused.length === 2 ? " is" : "s are"} hidden.${options.attemptsHint ? ` ${options.attemptsHint}` : ""}`,
                options.ansi === true,
              ),
            ]
          : []),
      );
    }
  }
  if (successfulData.length === 0) {
    lines.push(...renderAccessGuidance(options.accessGuidance, options.ansi === true));
  }
  lines.push("");
  return lines.join("\n");
}

function populationShareWarning(
  answer: string,
  analyses: AnalyticsAnalysis[],
): string | undefined {
  if (!analyses.some((analysis) => suppressedGroupCount(analysis.result) > 0)) return undefined;
  if (!/(?:\bshares?\b|\bpercent(?:age|ages|s)?\s+of\b|%\s+of\b)/i.test(answer)) return undefined;
  return "Runner note: at least one group was withheld, so an exact share of the complete population is unavailable. Percentages calculated from the displayed rows describe only the returned non-suppressed subtotal.";
}

export function modelAnswerForDisplay(
  answer: string,
  analyses: AnalyticsAnalysis[],
  accessGuidance?: AskAccessGuidance,
): string {
  const successfulData = analyses.some((analysis) =>
    analysis.tool !== "app.describe_data"
    && analysis.status === "ok"
    && analysis.result.ok !== false);
  const rows = analyses
    .filter((analysis) => analysis.status === "ok" && analysis.result.ok !== false)
    .flatMap((analysis) => resultRows(analysis.result));
  const finish = (value: string): string => successfulData
    ? polishSuccessfulModelInterpretation(value, rows)
    : value;
  if (rows.length < 3) return finish(conciseBoundaryLimitation(answer, analyses, accessGuidance));

  const lines = answer.split(/\r?\n/);
  const matches = lines.map((line) => matchingResultRows(line, rows));
  const uniqueMatches = lines.map((line) => matchingUniqueResultRows(line, rows));
  const repeatedUniqueListing = lines.filter((line, index) =>
    /^[-*\u2022]\s+/.test(line.trim()) && uniqueMatches[index]! > 0).length >= 3;
  const removable = matches.map((matchedRows, index) => {
    const line = lines[index]!.trim();
    return matchedRows >= 4 || (/^[-*\u2022]\s+/.test(line) && (
      matchedRows > 0 || (repeatedUniqueListing && uniqueMatches[index]! > 0)
    ));
  });
  const duplicateRows = matches.reduce((total, matchedRows, index) =>
    total + (removable[index] ? Math.max(matchedRows, uniqueMatches[index]!) : 0), 0);
  if (duplicateRows < 3) return finish(conciseBoundaryLimitation(answer, analyses, accessGuidance));

  const duplicateLeadIns = lines.map((line, index) => {
    if (!/:\s*$/.test(line.trim())) return false;
    let next = index + 1;
    while (next < lines.length && lines[next]!.trim() === "") next += 1;
    return removable[next] === true;
  });
  const kept = lines.filter((line, index) => {
    if (removable[index] || duplicateLeadIns[index]) return false;
    return !/\b(?:results?|rows?|breakdown|summary interpretation)[^.!?]*:\s*$/i.test(line.trim());
  });
  const cleaned = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return finish(conciseBoundaryLimitation(cleaned || answer, analyses, accessGuidance));
}

function polishSuccessfulModelInterpretation(
  answer: string,
  rows: Array<Record<string, unknown>>,
): string {
  const withoutRowListings = answer
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !(
      matchingResultRows(sentence, rows) >= 3
      && /\b(?:exact|returned|rows?|breakdown|weekly sums?)\b/i.test(sentence)
    ))
    .join(" ");
  return withoutRowListings
    .trim()
    .replace(
      /^I (?:ran|used|queried|grouped|aggregated)\b[^.]*\.\s*/i,
      "",
    )
    .replace(
      /^Returned\b[^.]*\.\s*/i,
      "",
    )
    .replace(/(^|\s)(?:Strongest trend|Interpretation|Summary):\s*/gi, "$1")
    .replace(/(^|[.!?]\s+)([a-z])/g, (_match, prefix: string, letter: string) =>
      `${prefix}${letter.toUpperCase()}`)
    .replace(
      /\s+(?:Would you like|If you (?:would like|want))[^?]*\?\s*$/i,
      "",
    )
    .trim();
}

function conciseBoundaryLimitation(
  answer: string,
  analyses: AnalyticsAnalysis[],
  accessGuidance: AskAccessGuidance | undefined,
): string {
  if (!accessGuidance || analyses.some((analysis) =>
    analysis.tool === "app.explore_data"
    && analysis.status === "ok"
    && analysis.result.ok !== false)) return answer;
  return accessGuidance.source_query_executed
    ? `${accessGuidance.title}. Runner completed the read-only aggregate, but discarded its result instead of releasing a privacy-reconstructing answer.`
    : `${accessGuidance.title}. The active reviewed boundary cannot answer this question, so Runner did not execute a data query.`;
}

function matchingResultRows(
  line: string,
  rows: Array<Record<string, unknown>>,
): number {
  const normalizedLine = normalizeResultComparison(line);
  return rows.filter((row) => {
    const tokens = unique(Object.values(row).flatMap(resultComparisonTokens));
    return tokens.filter((token) => normalizedLine.includes(token)).length >= 2;
  }).length;
}

function matchingUniqueResultRows(
  line: string,
  rows: Array<Record<string, unknown>>,
): number {
  const normalizedLine = normalizeResultComparison(line);
  const rowTokens = rows.map((row) =>
    unique(Object.values(row).flatMap(resultComparisonTokens)));
  const tokenFrequency = new Map<string, number>();
  for (const tokens of rowTokens) {
    for (const token of tokens) {
      tokenFrequency.set(token, (tokenFrequency.get(token) ?? 0) + 1);
    }
  }
  return rowTokens.filter((tokens) => tokens.some((token) =>
    tokenFrequency.get(token) === 1 && normalizedLine.includes(token))).length;
}

function resultComparisonTokens(value: unknown): string[] {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return [];
  const raw = String(value);
  const tokens = [normalizeResultComparison(raw)];
  if (typeof value === "number") {
    tokens.push(normalizeResultComparison(new Intl.NumberFormat("en-US").format(value)));
  }
  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      tokens.push(normalizeResultComparison(new Date(timestamp).toISOString().slice(0, 10)));
    }
  }
  return tokens.filter((token) => token.length >= 2);
}

function normalizeResultComparison(value: string): string {
  return value.toLowerCase().replace(/[,\s]/g, "");
}

function renderAccessGuidance(
  guidance: AskAccessGuidance | undefined,
  ansi: boolean,
): string[] {
  if (!guidance) return [];
  return [
    "",
    styledSystemStatus("HUMAN REVIEW PATH", ansi),
    styledNotice(safeTerminalText(guidance.title), ansi),
    safeTerminalText(guidance.message),
    ...(guidance.candidate_path
      ? [`Candidate path: ${safeTerminalText(guidance.candidate_path)}`]
      : []),
    `Next: ${safeTerminalText(guidance.next_action)}`,
  ];
}

export function renderRefusedAttempts(
  analyses: AnalyticsAnalysis[],
  ansi = false,
): string[] {
  const refused = refusedAnalyses(analyses);
  if (refused.length === 0) {
    return ["", "No refused attempts are available for the latest answer."];
  }
  return [
    "",
    "REFUSED ATTEMPTS",
    ...refused.flatMap((analysis, index) => {
      const message = stringValue(analysis.result.message)
        ?? stringValue(record(analysis.result.outcome).message)
        ?? "The reviewed boundary refused this request.";
      const sourceExecution = refusedSourceQueryExecuted(analysis)
        ? analysis.error_code === "EXPLORE_PRIVACY_BUDGET_EXHAUSTED"
          ? "yes; the privacy-reconstructing result was discarded"
          : "yes; the bounded result was discarded"
        : analysis.error_code === "EXPLORE_SOURCE_UNAVAILABLE"
          ? "outcome unavailable; inspect the durable audit before retrying"
          : "no; validation stopped it before source execution";
      return [
        "",
        `Attempt ${index + 1}${analysis.error_code ? ` - ${safeTerminalText(analysis.error_code)}` : ""}`,
        safeTerminalText(analysis.description),
        safeTerminalText(message),
        ...(analysis.arguments
          ? [
              "Typed tool request:",
              renderTerminalJson(analysis.arguments, ansi),
            ]
          : []),
        `Source query executed: ${sourceExecution}`,
        "Source rows returned to the model: no",
        "Source database changed: no",
      ];
    }),
  ];
}

function refusedSourceQueryExecuted(analysis: AnalyticsAnalysis): boolean {
  const direct = record(analysis.result.details);
  const outcome = record(record(analysis.result.outcome).details);
  if (direct.source_query_executed === true || outcome.source_query_executed === true) return true;
  return analysis.error_code === "EXPLORE_RESPONSE_TOO_LARGE";
}

export function renderAnalysis(
  analysis: AnalyticsAnalysis,
  width = 100,
): string[] {
  if (analysis.status === "refused" || analysis.result.ok === false) {
    const message = stringValue(analysis.result.message)
      ?? stringValue(record(analysis.result.outcome).message)
      ?? "The reviewed boundary refused this request.";
    return [
      "",
      `Refused${analysis.error_code ? ` (${safeTerminalText(analysis.error_code)})` : ""}`,
      safeTerminalText(message),
    ];
  }
  if (analysis.tool === "app.describe_data") {
    const resources = Array.isArray(analysis.result.resources)
      ? analysis.result.resources.length
      : 0;
    return ["", `Reviewed data catalog: ${resources} table${resources === 1 ? "" : "s"}.`];
  }
  const rows = resultRows(analysis.result);
  const lines = ["", safeTerminalText(analysisDisplayTitle(analysis))];
  const minimumCohort = minimumCohortSize(analysis.result);
  if (rows.length > 0) {
    lines.push("", ...renderTable(rows, width, analysis));
  } else {
    const status = stringValue(record(analysis.result.outcome).status)
      ?? stringValue(record(record(analysis.result.outcome).result).suppression?.toString())
      ?? "empty";
    lines.push(status === "fully_suppressed"
      ? `No aggregate value can be shown under the reviewed minimum group size${minimumCohort === undefined ? "" : ` of ${minimumCohort}`}.`
      : "No reviewed rows or groups were returned.");
  }
  const suppressed = suppressedGroupCount(analysis.result);
  if (suppressed > 0) {
    const shapeHint = minimumCohortQuestionShapeHint(analysis, minimumCohort);
    lines.push(
      "",
      `${suppressed} additional group${suppressed === 1 ? " was" : "s were"} withheld because ${suppressed === 1 ? "it was" : "they were"} below the reviewed minimum group size${minimumCohort === undefined ? "" : ` of ${minimumCohort}`}.`,
      ...(shapeHint ? [shapeHint] : []),
      ...(minimumCohort !== undefined && minimumCohort > 1
        ? [minimumCohortRecoveryPath(analysis)]
        : []),
    );
  }
  return lines;
}

function minimumCohortRecoveryPath(analysis: AnalyticsAnalysis): string {
  const boundary = stringValue(analysis.result.boundary_name)
    ?? stringValue(analysis.arguments?.boundary);
  const table = analysis.plan?.resource
    ?? stringValue(record(analysis.result.audit).resource_id);
  return `${cliPrivacyReviewInstructions({
    ...(boundary ? { boundary: safeTerminalText(boundary) } : {}),
    ...(table ? { resource: safeTerminalText(table) } : {}),
  })}\nUntil activation, Ask keeps the previous minimum group size.`;
}

function minimumCohortQuestionShapeHint(
  analysis: AnalyticsAnalysis,
  minimumCohort: number | undefined,
): string | undefined {
  if (analysis.plan?.kind !== "aggregate" || analysis.plan.dimensions?.length !== 1) {
    return undefined;
  }
  const field = analysis.plan.dimensions[0]!.field;
  if (!/(^id$|_id$|(^|_)name$)/i.test(field)) return undefined;
  const label = businessLabel(field).toLowerCase();
  return `This question groups records into one row per ${label}; any entity with fewer than ${minimumCohort ?? "the reviewed minimum"} records is withheld. Try a coarser reviewed grouping, or review this table's minimum group size.`;
}

export function renderTable(
  rows: Array<Record<string, unknown>>,
  requestedWidth = 100,
  analysis?: AnalyticsAnalysis,
): string[] {
  const columns = unique(rows.flatMap((row) => Object.keys(row)));
  if (columns.length === 0) return ["(empty result)"];
  const width = Math.max(24, Math.min(240, requestedWidth));
  const labels = Object.fromEntries(columns.map((column) => [
    column,
    resultColumnLabel(column, analysis),
  ]));
  const safeRows = rows.map((row) => Object.fromEntries(columns.map((column) => [
    column,
    safeTerminalCellText(formatResultScalar(row[column], column, analysis)),
  ])));
  if (width < 48 || columns.length > 8) {
    return safeRows.flatMap((row, index) => [
      ...(index === 0 ? [] : [""]),
      ...columns.map((column) => `${safeTerminalText(labels[column] ?? column)}: ${row[column]}`),
    ]);
  }
  const available = width - (columns.length - 1) * 3;
  if (available < columns.length * 8) {
    return safeRows.flatMap((row, index) => [
      ...(index === 0 ? [] : [""]),
      ...columns.map((column) => `${safeTerminalText(labels[column] ?? column)}: ${row[column]}`),
    ]);
  }
  const maxColumnWidth = Math.max(8, Math.min(32, Math.floor(available / columns.length)));
  const widths = columns.map((column) => Math.min(
    maxColumnWidth,
    Math.max(
      displayWidth(safeTerminalText(labels[column] ?? column)),
      ...safeRows.map((row) => displayWidth(row[column] ?? "")),
    ),
  ));
  const numeric = columns.map((column) => {
    const values = rows.map((row) => row[column]).filter((value) => value !== null && value !== undefined);
    return values.length > 0 && values.every((value) =>
      typeof value === "number" || typeof value === "bigint");
  });
  const line = (values: string[]) => values
    .map((value, index) => {
      const fitted = truncate(value, widths[index]!);
      return numeric[index]
        ? fitted.padStart(widths[index]!)
        : pad(fitted, widths[index]!);
    })
    .join("   ")
    .trimEnd();
  return [
    line(columns.map((column) => safeTerminalText(labels[column] ?? column))),
    line(widths.map((columnWidth) => "-".repeat(columnWidth))),
    ...safeRows.map((row) => line(columns.map((column) => row[column] ?? ""))),
  ];
}

function analysisDisplayTitle(analysis: AnalyticsAnalysis): string {
  const plan = analysis.plan;
  if (!plan) return analysis.description;
  const resource = businessLabel(plan.resource.split(".").at(-1) ?? plan.resource);
  if (plan.kind === "rows") return `${resource} rows`;
  const dimensions = (plan.dimensions ?? []).map((dimension) => businessLabel(dimension.field));
  const time = plan.time_bucket?.bucket;
  const groups = [...dimensions, ...(time ? [time] : [])];
  return groups.length ? `${resource} by ${naturalList(groups)}` : `${resource} summary`;
}

function resultColumnLabel(
  column: string,
  analysis: AnalyticsAnalysis | undefined,
): string {
  const semantics = record(record(analysis?.result.outcome).result);
  const dimensions = Array.isArray(semantics.dimensions)
    ? semantics.dimensions.filter(isRecord)
    : [];
  const measures = Array.isArray(semantics.measures)
    ? semantics.measures.filter(isRecord)
    : [];
  const dimension = dimensions.find((item) => item.alias === column);
  if (dimension && typeof dimension.field === "string") return businessLabel(dimension.field);
  const measure = measures.find((item) => item.alias === column);
  if (measure) return measureLabel(measure, analysis);
  for (const item of measures) {
    const outputs = record(item.comparison_outputs);
    const match = Object.entries(outputs).find(([, alias]) => alias === column);
    if (match) return comparisonColumnLabel(match[0], measureLabel(item, analysis));
  }
  const grain = record(semantics.grain);
  const timeBucket = record(grain.time_bucket);
  if (timeBucket.output_alias === column) {
    const bucket = typeof timeBucket.bucket === "string" ? businessLabel(timeBucket.bucket) : "Time";
    return `${bucket} starting`;
  }
  if (column === "period_index") return "Comparison period";
  if (column === "cohort_count") return "Cohort size";
  return businessLabel(column);
}

function comparisonColumnLabel(output: string, measure: string): string {
  const lowerMeasure = measure[0]?.toLowerCase() + measure.slice(1);
  if (output === "period_1") return `Earlier ${lowerMeasure}`;
  if (output === "period_2") return `Later ${lowerMeasure}`;
  if (output === "absolute_change") return `Change in ${lowerMeasure}`;
  if (output === "percentage_change") return `Percent change in ${lowerMeasure}`;
  return `${measure} ${businessLabel(output).toLowerCase()}`;
}

function measureLabel(
  measure: Record<string, unknown>,
  analysis?: AnalyticsAnalysis,
): string {
  const fn = typeof measure.function === "string" ? measure.function : "value";
  const field = typeof measure.field === "string" ? businessLabel(measure.field) : "records";
  if (fn === "count") return "Record count";
  if (fn === "count_distinct" && measure.field === "id" && analysis?.plan?.resource) {
    return `Unique ${businessLabel(analysis.plan.resource.split(".").at(-1) ?? "records").toLowerCase()}`;
  }
  if (fn === "count_distinct") return `Unique ${field}`;
  if (fn === "avg") return `Average ${field}`;
  if (fn === "sum") return /^total\b/i.test(field) ? field : `Sum of ${field.toLowerCase()}`;
  return businessLabel(`${fn} ${field}`);
}

function formatResultScalar(
  value: unknown,
  column: string,
  analysis: AnalyticsAnalysis | undefined,
): string {
  const semantics = record(record(analysis?.result.outcome).result);
  const timeBucket = record(record(semantics.grain).time_bucket);
  if (timeBucket.output_alias === column && typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 6,
      useGrouping: true,
    }).format(value);
  }
  return formatScalar(value);
}

function businessLabel(value: string): string {
  const normalized = value.replace(/[_.-]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : "Value";
}

function naturalList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

export function analysisJson(analysis: AnalyticsAnalysis): Record<string, unknown> {
  return {
    index: analysis.index,
    tool: analysis.tool,
    status: analysis.status,
    ...(analysis.error_code ? { error_code: analysis.error_code } : {}),
    ...(analysis.reference ? { analysis_reference: analysis.reference } : {}),
    ...(analysis.expires_at ? { protectable_until: analysis.expires_at } : {}),
    description: analysis.description,
    ...(analysis.arguments
      ? { model_tool_arguments: redactToolArguments(analysis.arguments) }
      : {}),
    ...(analysis.plan ? { normalized_plan: redactPlanLiterals(analysis.plan) } : {}),
    ...(analysis.evidence_bundle_id ? { evidence_bundle_id: analysis.evidence_bundle_id } : {}),
    ...(analysis.query_audit_handle ? { query_audit_handle: analysis.query_audit_handle } : {}),
    result: analysis.result,
    source_database_changed: false,
  };
}

function redactToolArguments(argumentsValue: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(argumentsValue);
  if (isExplorePlan(record(copy.plan))) {
    copy.plan = redactPlanLiterals(copy.plan as ExplorePlan);
  }
  return copy;
}

export function redactPlanLiterals(plan: ExplorePlan): Record<string, unknown> {
  const copy = structuredClone(plan) as unknown;
  return redactLiteralValue(copy) as Record<string, unknown>;
}

function redactLiteralValue(value: unknown, parent?: string): unknown {
  if (Array.isArray(value)) {
    if (parent === "value") return "<redacted>";
    return value.map((item) => redactLiteralValue(item));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    key === "value" || key === "start" || key === "end"
      ? "<redacted>"
      : redactLiteralValue(item, key),
  ]));
}

function resultRows(result: Record<string, unknown>): Array<Record<string, unknown>> {
  if (Array.isArray(result.data)) return records(result.data);
  const data = record(result.data);
  if (Array.isArray(data.rows)) return records(data.rows);
  if (Array.isArray(data.groups)) return records(data.groups);
  if (Array.isArray(result.rows)) return records(result.rows);
  return [];
}

function suppressedGroupCount(result: Record<string, unknown>): number {
  const privacy = record(result.privacy);
  const data = record(result.data);
  const suppression = record(data.suppression);
  const semantics = record(record(record(result.outcome).result).suppression);
  return numberValue(privacy.suppressed_groups)
    ?? numberValue(suppression.suppressed_groups)
    ?? numberValue(semantics.suppressed_groups)
    ?? 0;
}

function minimumCohortSize(result: Record<string, unknown>): number | undefined {
  const privacy = record(result.privacy);
  const data = record(result.data);
  const suppression = record(data.suppression);
  const semantics = record(record(record(result.outcome).result).suppression);
  return numberValue(privacy.minimum_cohort_size)
    ?? numberValue(suppression.minimum_cohort_size)
    ?? numberValue(semantics.minimum_cohort_size);
}

function completeResultSuppressed(analysis: AnalyticsAnalysis): boolean {
  if (analysis.status !== "ok" || analysis.tool !== "app.explore_data") return false;
  const status = stringValue(record(analysis.result.outcome).status);
  return status === "fully_suppressed"
    || (resultRows(analysis.result).length === 0 && suppressedGroupCount(analysis.result) > 0);
}

function refusedAnalyses(analyses: AnalyticsAnalysis[]): AnalyticsAnalysis[] {
  return analyses.filter((analysis) =>
    analysis.status === "refused" || analysis.result.ok === false);
}

function styledHeading(
  value: string,
  kind: "model" | "runner",
  ansi: boolean,
): string {
  if (!ansi) return value;
  return kind === "runner"
    ? `\u001b[1;32m${value}\u001b[0m`
    : `\u001b[1;35m${value}\u001b[0m`;
}

function styledModelProse(value: string, ansi: boolean): string {
  return ansi ? `\u001b[3m${value}\u001b[0m` : value;
}

function styledSystemStatus(value: string, ansi: boolean): string {
  return ansi ? `\u001b[1;33m${value}\u001b[0m` : value;
}

function styledRule(value: string, ansi: boolean): string {
  return ansi ? `\u001b[2m${value}\u001b[0m` : value;
}

function styledNotice(value: string, ansi: boolean): string {
  return ansi ? `\u001b[2;33m${value}\u001b[0m` : value;
}

function isExplorePlan(value: Record<string, unknown>): value is ExplorePlan {
  return (value.kind === "rows" || value.kind === "aggregate")
    && typeof value.resource === "string";
}

function records(value: unknown[]): Array<Record<string, unknown>> {
  return value.filter((item): item is Record<string, unknown> =>
    Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function displayWidth(value: string): number {
  return [...value].length;
}

function truncate(value: string, width: number): string {
  if (displayWidth(value) <= width) return value;
  if (width <= 3) return ".".repeat(width);
  return `${[...value].slice(0, width - 3).join("")}...`;
}

function pad(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - displayWidth(value)))}`;
}
