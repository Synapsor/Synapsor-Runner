import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import {
  buildFriendlyAggregatePlan,
  type FriendlyAggregateExplorePlan,
} from "./explore-cli.js";

export type InstantFirstValue = {
  resource: string;
  question: string;
  operation: string;
  plan: FriendlyAggregateExplorePlan;
  agent_can_see: string[];
  agent_can_see_labels: string[];
  agent_cannot_see: string[];
  agent_cannot_see_labels: string[];
  tenant_scope: string;
  principal_scope: string;
  maximum_groups: number;
  minimum_cohort_size: number;
};

export function buildInstantFirstValue(
  candidate: ExplorationBoundaryDraft,
): InstantFirstValue {
  const resource = candidate.pack.resources[0];
  if (!resource) {
    throw new Error("Runner could not identify a conservative first resource.");
  }
  const maximumGroups = Math.min(10, candidate.budgets.max_top_n);
  const time = Object.entries(resource.time_bucket_fields)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([field, buckets]) => ({
      field,
      bucket: buckets.includes("week") ? "week" : buckets[0],
    }))
    .find((item): item is { field: string; bucket: "day" | "week" | "month" } =>
      item.bucket === "day" || item.bucket === "week" || item.bucket === "month");
  const measure = resource.aggregate_measures[0];
  const dimension = resource.groupable_fields[0];
  const trend = Boolean(measure && time);
  const plan = buildFriendlyAggregatePlan(candidate, trend
    ? {
        resource: resource.id,
        sums: [measure!],
        timeBucket: `${time!.field}:${time!.bucket}`,
        top: maximumGroups,
      }
    : {
        resource: resource.id,
        count: true,
        ...(dimension ? { groupBy: [dimension] } : {}),
        top: maximumGroups,
      });
  const counted = words(resource.table);
  const grouped = dimension ? words(dimension) : undefined;
  return {
    resource: resource.id,
    question: trend
      ? `How did ${trendMeasureLabel(measure!, counted)} change by ${time!.bucket}?`
      : grouped
        ? `Which ${plural(grouped)} have the most ${plural(counted)}?`
        : `How many reviewed ${plural(counted)} are in scope?`,
    operation: trend
      ? `Sum reviewed ${words(measure!)} by ${time!.bucket} of ${words(time!.field)}`
      : grouped
        ? `Count ${plural(counted)} and group them by reviewed ${grouped}`
        : `Count reviewed ${plural(counted)}`,
    plan,
    agent_can_see: [...resource.selectable_fields],
    agent_can_see_labels: resource.selectable_fields.map(words),
    agent_cannot_see: [...resource.kept_out_fields],
    agent_cannot_see_labels: resource.kept_out_fields.map(words),
    tenant_scope: candidate.trusted_context.database_role_tenant
      ? `verified from the read-only database credential through ${candidate.trusted_context.database_role_tenant.setting}`
      : `configured from ${candidate.trusted_context.tenant_env}`,
    principal_scope: resource.principal_key
      ? `configured from ${candidate.trusted_context.principal_env}`
      : "not required for this reviewed table",
    maximum_groups: maximumGroups,
    minimum_cohort_size: resource.minimum_cohort_size,
  };
}

function trendMeasureLabel(measure: string, resource: string): string {
  if (/^total(?:_|$)/.test(measure)) return `${singular(resource)} totals`;
  if (/^amount(?:_|$)/.test(measure)) return `${singular(resource)} amount`;
  return words(measure).replace(/ cents$/, "");
}

function singular(value: string): string {
  if (value.endsWith("ies")) return `${value.slice(0, -3)}y`;
  if (value.endsWith("ses")) return value.slice(0, -2);
  if (value.endsWith("s")) return value.slice(0, -1);
  return value;
}

function words(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function plural(value: string): string {
  if (/\d$/.test(value)) return `${value} records`;
  if (/(?:status|class|process|address)$/.test(value)) return `${value}es`;
  if (value.endsWith("s")) return value;
  if (value.endsWith("y") && !/[aeiou]y$/.test(value)) {
    return `${value.slice(0, -1)}ies`;
  }
  return `${value}s`;
}
