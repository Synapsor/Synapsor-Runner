import type { ActivatedExplorationBoundary } from "./auto-boundary.js";
import type {
  AggregateDimension,
  AggregateExplorePlan,
  AggregateMeasure,
  CanonicalTimeWindow,
  ExploreFilter,
} from "./scoped-explore.js";
import {
  RELATIVE_TIME_COMPARISONS,
  RELATIVE_TIME_WINDOWS,
  type RelativeTimeComparison,
  type RelativeTimeWindow,
} from "./relative-time-window.js";

export type FriendlyExploreOptions = {
  resource?: string;
  suggested?: boolean;
  count?: boolean;
  countDistinct?: string[];
  sums?: string[];
  averages?: string[];
  measures?: string[];
  groupBy?: string[];
  groupBands?: string[];
  timeBucket?: string;
  timeWindow?: string;
  compareField?: string;
  period?: string;
  versusPeriod?: string;
  compareWindow?: string;
  compareTo?: RelativeTimeComparison;
  comparisonChange?: "absolute" | "percentage";
  filters?: string[];
  top?: number;
};

type FriendlyRelativeTimeWindow = {
  field: string;
  relationship?: string;
  window: RelativeTimeWindow;
};

type FriendlyRelativeComparison = FriendlyRelativeTimeWindow & {
  compare_to: RelativeTimeComparison;
};

export type FriendlyAggregateExplorePlan = Omit<
  AggregateExplorePlan,
  "time_window" | "comparison"
> & {
  time_window?: CanonicalTimeWindow | FriendlyRelativeTimeWindow;
  comparison?: AggregateExplorePlan["comparison"] | FriendlyRelativeComparison;
};

type FriendlyExploreBoundary = Pick<ActivatedExplorationBoundary, "pack" | "budgets">;

export function buildFriendlyAggregatePlan(
  boundary: FriendlyExploreBoundary,
  options: FriendlyExploreOptions,
): FriendlyAggregateExplorePlan {
  const resource = chooseResource(boundary, options);
  let relationship: string | undefined;
  const bindRelationship = (candidate: string | undefined): void => {
    if (!candidate) return;
    if (relationship && relationship !== candidate) {
      throw new Error(
        `The first friendly Explore release permits one reviewed relationship path; received ${relationship} and ${candidate}.`,
      );
    }
    relationship = candidate;
  };

  const dimensions: AggregateDimension[] = [];
  const requestedDimensions = options.groupBy?.length
    ? options.groupBy
    : options.suggested && resource.groupable_fields.length
      ? [resource.groupable_fields[0]!]
      : [];
  for (const value of requestedDimensions) {
    const reference = parseFieldReference(value);
    bindRelationship(reference.relationship);
    dimensions.push(reference);
  }
  for (const name of options.groupBands ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      throw new Error("--group-band must name one reviewed numeric band.");
    }
    const band = resource.numeric_bands?.find((candidate) => candidate.name === name);
    if (!band) {
      const reviewed = resource.numeric_bands?.map((candidate) => candidate.name).join(", ") || "none";
      throw new Error(`Numeric band ${name} is not reviewed for ${resource.id}. Reviewed bands: ${reviewed}.`);
    }
    bindRelationship(band.relationship);
    dimensions.push({ numeric_band: name });
  }

  const measures: AggregateMeasure[] = [];
  if (options.count) measures.push({ function: "count" });
  for (const value of options.countDistinct ?? []) {
    const reference = parseFieldReference(value);
    bindRelationship(reference.relationship);
    measures.push({ function: "count_distinct", ...reference });
  }
  for (const value of options.sums ?? []) {
    const reference = parseFieldReference(value);
    bindRelationship(reference.relationship);
    measures.push({ function: "sum", ...reference });
  }
  for (const value of options.averages ?? []) {
    const reference = parseFieldReference(value);
    bindRelationship(reference.relationship);
    measures.push({ function: "avg", ...reference });
  }
  for (const value of options.measures ?? []) {
    const measure = parseReviewedMeasure(value);
    if (!("derived_measure" in measure)) bindRelationship(measure.relationship);
    measures.push(measure);
  }
  if (!measures.length && options.suggested && resource.count_distinct_fields.length) {
    measures.push({ function: "count_distinct", field: resource.count_distinct_fields[0]! });
  }
  if (!measures.length) measures.push({ function: "count" });

  let timeBucket: AggregateExplorePlan["time_bucket"];
  const requestedTimeBucket = options.timeBucket
    ?? (options.suggested
      ? Object.entries(resource.time_bucket_fields)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([field, buckets]) => buckets.includes("week") ? `${field}:week` : `${field}:${buckets[0]}`)
        .at(0)
      : undefined);
  if (requestedTimeBucket) {
    const { reference, bucket } = parseTimeBucket(requestedTimeBucket);
    bindRelationship(reference.relationship);
    timeBucket = { field: reference.field, bucket, ...(reference.relationship ? { relationship: reference.relationship } : {}) };
  }

  let timeWindow: FriendlyAggregateExplorePlan["time_window"];
  if (options.timeWindow) {
    const parsed = parseRelativeTimeOption(options.timeWindow, "--time-window");
    bindRelationship(parsed.relationship);
    timeWindow = parsed;
  }

  let comparison: FriendlyAggregateExplorePlan["comparison"];
  const absoluteComparisonRequested = Boolean(
    options.compareField || options.period || options.versusPeriod,
  );
  const relativeComparisonRequested = Boolean(options.compareWindow || options.compareTo);
  if (absoluteComparisonRequested && relativeComparisonRequested) {
    throw new Error(
      "Use either --compare/--period/--vs-period or --compare-window/--compare-to, not both.",
    );
  }
  if (absoluteComparisonRequested) {
    if (!options.compareField || !options.period || !options.versusPeriod) {
      throw new Error("A period comparison requires --compare <time-field>, --period <start>..<end>, and --vs-period <start>..<end>.");
    }
    if (!timeBucket) {
      throw new Error("A period comparison requires --time-bucket <time-field>:hour|day|week|month|quarter|year|day_of_week to state its reviewed reporting grain.");
    }
    const reference = parseFieldReference(options.compareField);
    bindRelationship(reference.relationship);
    comparison = {
      field: reference.field,
      ranges: [parsePeriod(options.period, "--period"), parsePeriod(options.versusPeriod, "--vs-period")],
      ...(reference.relationship ? { relationship: reference.relationship } : {}),
    };
  } else if (relativeComparisonRequested) {
    if (!options.compareWindow || !options.compareTo) {
      throw new Error(
        `A relative comparison requires --compare-window <field[@relationship]>:<window> and --compare-to ${RELATIVE_TIME_COMPARISONS.join("|")}.`,
      );
    }
    if (!timeBucket) {
      throw new Error(
        "A relative comparison requires --time-bucket <time-field>:hour|day|week|month|quarter|year|day_of_week to state its reviewed reporting grain.",
      );
    }
    const parsed = parseRelativeTimeOption(options.compareWindow, "--compare-window");
    bindRelationship(parsed.relationship);
    comparison = { ...parsed, compare_to: options.compareTo };
  }
  if (timeWindow && comparison) {
    throw new Error("--time-window cannot be combined with a period comparison.");
  }

  const where: ExploreFilter[] = [];
  for (const value of options.filters ?? []) {
    const filter = parseFilter(value);
    bindRelationship(filter.relationship);
    where.push(filter);
  }

  const top = options.top ?? Math.min(10, boundary.budgets.max_top_n);
  if (!Number.isInteger(top) || top < 1) throw new Error("--top must be a positive integer.");

  return {
    kind: "aggregate",
    resource: resource.id,
    ...(relationship ? { relationship } : {}),
    measures,
    ...(dimensions.length ? { dimensions } : {}),
    ...(timeBucket ? { time_bucket: timeBucket } : {}),
    ...(timeWindow ? { time_window: timeWindow } : {}),
    ...(where.length ? { where } : {}),
    order_by: comparison
      ? {
        kind: "comparison_change",
        index: 0,
        change: options.comparisonChange ?? "percentage",
        direction: "desc",
      }
      : timeBucket
        ? { kind: "time_bucket", direction: "asc" }
        : { kind: "measure", index: 0, direction: "desc" },
    top_n: top,
    ...(comparison ? { comparison } : {}),
  };
}

function parseRelativeTimeOption(
  value: string,
  option: "--time-window" | "--compare-window",
): FriendlyRelativeTimeWindow {
  const separator = value.lastIndexOf(":");
  if (separator < 1) {
    throw new Error(`${option} must use <field[@reviewed_relationship]>:<window>.`);
  }
  const reference = parseFieldReference(value.slice(0, separator));
  const window = value.slice(separator + 1);
  if (!(RELATIVE_TIME_WINDOWS as readonly string[]).includes(window)) {
    throw new Error(`${option} window must be one of ${RELATIVE_TIME_WINDOWS.join(", ")}.`);
  }
  return { ...reference, window: window as RelativeTimeWindow };
}

function chooseResource(
  boundary: FriendlyExploreBoundary,
  options: FriendlyExploreOptions,
): FriendlyExploreBoundary["pack"]["resources"][number] {
  if (options.resource) {
    const found = boundary.pack.resources.find((resource) => resource.id === options.resource);
    if (!found) {
      throw new Error(
        `Resource ${options.resource} is not in the active reviewed pack. Run try explore to list reviewed resource aliases.`,
      );
    }
    return found;
  }
  if (!options.suggested) {
    throw new Error("Friendly Explore requires --resource <reviewed-alias>, or use --suggested.");
  }
  const ranked = [...boundary.pack.resources].sort((left, right) => {
    const score = (resource: typeof left) =>
      (Object.keys(resource.time_bucket_fields).length ? 4 : 0)
      + (resource.groupable_fields.length ? 2 : 0)
      + (resource.count_distinct_fields.length ? 1 : 0);
    return score(right) - score(left) || left.id.localeCompare(right.id);
  });
  const selected = ranked[0];
  if (!selected) throw new Error("The active reviewed pack has no explorable resources.");
  return selected;
}

function parseFieldReference(value: string): { field: string; relationship?: string } {
  const [field, relationship, ...extra] = value.split("@");
  if (!field || extra.length || (relationship !== undefined && !relationship)
    || /[\s()+*/]/.test(field) || (relationship ? /[\s()+*/]/.test(relationship) : false)) {
    throw new Error(`Invalid field reference ${value}. Use field or field@reviewed_relationship.`);
  }
  return {
    field,
    ...(relationship ? { relationship } : {}),
  };
}

function parseTimeBucket(value: string): {
  reference: { field: string; relationship?: string };
  bucket: AggregateExplorePlan["time_bucket"] extends infer T
    ? T extends { bucket: infer B } ? B : never
    : never;
} {
  const separator = value.lastIndexOf(":");
  const expected = "field:hour|day|week|month|quarter|year|day_of_week";
  if (separator < 1) throw new Error(`--time-bucket must use ${expected}.`);
  const reference = parseFieldReference(value.slice(0, separator));
  const bucket = value.slice(separator + 1);
  if (!["hour", "day", "week", "month", "quarter", "year", "day_of_week"].includes(bucket)) {
    throw new Error(`--time-bucket must use ${expected}.`);
  }
  return { reference, bucket: bucket as NonNullable<AggregateExplorePlan["time_bucket"]>["bucket"] };
}

function parseReviewedMeasure(value: string): AggregateMeasure {
  const separator = value.indexOf(":");
  const fn = separator < 0 ? value : value.slice(0, separator);
  const subject = separator < 0 ? "" : value.slice(separator + 1);
  if (fn === "count" && !subject) return { function: "count" };
  if (fn === "derived" && subject && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(subject)) {
    return { derived_measure: subject };
  }
  const functions = [
    "count_distinct",
    "sum",
    "avg",
    "stddev_samp",
    "stddev_pop",
    "var_samp",
    "var_pop",
    "null_count",
    "non_null_count",
    "completion_rate",
  ] as const;
  if (!functions.includes(fn as typeof functions[number]) || !subject) {
    throw new Error(
      "--measure must use count, derived:<reviewed-name>, or <function>:<field[@reviewed_relationship]> for count_distinct, sum, avg, stddev_samp, stddev_pop, var_samp, var_pop, null_count, non_null_count, or completion_rate.",
    );
  }
  return {
    function: fn as typeof functions[number],
    ...parseFieldReference(subject),
  };
}

function parseFilter(value: string): ExploreFilter {
  const [fieldReference, operator, ...rawValue] = value.split(":");
  if (!fieldReference || !operator || !rawValue.length) {
    throw new Error("--where must use field:operator:value.");
  }
  if (!["eq", "neq", "lt", "lte", "gt", "gte", "in"].includes(operator)) {
    throw new Error("--where operator must be eq, neq, lt, lte, gt, gte, or in.");
  }
  const reference = parseFieldReference(fieldReference);
  const serialized = rawValue.join(":");
  const parsed = operator === "in"
    ? serialized.split(",").map((item) => parseScalar(item.trim()))
    : parseScalar(serialized);
  return {
    field: reference.field,
    op: operator as ExploreFilter["op"],
    value: parsed,
    ...(reference.relationship ? { relationship: reference.relationship } : {}),
  };
}

function parsePeriod(value: string, option: "--period" | "--vs-period"): { start: string; end: string } {
  const separator = value.indexOf("..");
  const start = separator > 0 ? value.slice(0, separator).trim() : "";
  const end = separator > 0 ? value.slice(separator + 2).trim() : "";
  if (!start || !end || !Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end))) {
    throw new Error(`${option} must use bounded ISO timestamps as <start>..<end>.`);
  }
  if (Date.parse(start) >= Date.parse(end)) {
    throw new Error(`${option} requires start before end.`);
  }
  return { start, end };
}

function parseScalar(value: string): string | number | boolean | null {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}
