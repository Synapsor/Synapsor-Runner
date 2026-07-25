import type { ActivatedExplorationBoundary } from "./auto-boundary.js";
import type {
  AggregateDimension,
  AggregateExplorePlan,
  AggregateMeasure,
  ExploreFilter,
} from "./scoped-explore.js";

export type FriendlyExploreOptions = {
  resource?: string;
  suggested?: boolean;
  count?: boolean;
  countDistinct?: string[];
  sums?: string[];
  averages?: string[];
  groupBy?: string[];
  timeBucket?: string;
  filters?: string[];
  top?: number;
};

export function buildFriendlyAggregatePlan(
  boundary: ActivatedExplorationBoundary,
  options: FriendlyExploreOptions,
): AggregateExplorePlan {
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
    ...(where.length ? { where } : {}),
    order_by: timeBucket
      ? { kind: "time_bucket", direction: "asc" }
      : { kind: "measure", index: 0, direction: "desc" },
    top_n: top,
  };
}

function chooseResource(
  boundary: ActivatedExplorationBoundary,
  options: FriendlyExploreOptions,
): ActivatedExplorationBoundary["pack"]["resources"][number] {
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
  if (!field || extra.length || (relationship !== undefined && !relationship)) {
    throw new Error(`Invalid field reference ${value}. Use field or field@reviewed_relationship.`);
  }
  return {
    field,
    ...(relationship ? { relationship } : {}),
  };
}

function parseTimeBucket(value: string): {
  reference: { field: string; relationship?: string };
  bucket: "day" | "week" | "month";
} {
  const separator = value.lastIndexOf(":");
  if (separator < 1) throw new Error("--time-bucket must use field:day|week|month.");
  const reference = parseFieldReference(value.slice(0, separator));
  const bucket = value.slice(separator + 1);
  if (bucket !== "day" && bucket !== "week" && bucket !== "month") {
    throw new Error("--time-bucket must use field:day|week|month.");
  }
  return { reference, bucket };
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

function parseScalar(value: string): string | number | boolean | null {
  if (value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}
