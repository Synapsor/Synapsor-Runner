import { isDeepStrictEqual } from "node:util";

export type AskPlanSyntaxRepair = { arguments: Record<string, unknown>; instruction: string };

// Construct a comparison target, never an executable replacement. The model
// must resubmit, and the normal runtime must validate the complete plan again.
export function askPlanSyntaxRepair(trace: {
  tool: string;
  status: string;
  error_code?: string;
  arguments: Record<string, unknown>;
  result: Record<string, unknown>;
}): AskPlanSyntaxRepair | undefined {
  const details = trace.result.details;
  if (trace.tool !== "app.explore_data" || trace.status !== "refused"
    || trace.error_code !== "EXPLORE_PLAN_INVALID" || !record(details)
    || details.category !== "plan_syntax" || details.location !== "filter"
    || details.source_query_executed !== false
    || !isDeepStrictEqual(details.unexpected_keys, ["operator"])) return undefined;
  const args = structuredClone(trace.arguments);
  if (!record(args.plan) || !Array.isArray(args.plan.where)) return undefined;
  let changed = false;
  for (const filter of args.plan.where) {
    if (!record(filter)) return undefined;
    if (!Object.hasOwn(filter, "operator")) continue;
    if (Object.hasOwn(filter, "op") || typeof filter.operator !== "string") return undefined;
    filter.op = filter.operator;
    delete filter.operator;
    changed = true;
  }
  if (!changed) return undefined;
  return { arguments: args, instruction: [
    "Runner rejected the query syntax before source execution, not its access permissions.",
    "Resubmit exactly one app.explore_data call, replacing only each plan.where filter's operator key with op.",
    "Keep every resource, field, relationship, filter value, and other argument unchanged. Do not omit filters or request more access.",
    "This is the one syntax correction attempt; Runner will validate the complete resubmitted plan.",
  ].join(" ") };
}

export function matchesAskPlanSyntaxRepair(repair: AskPlanSyntaxRepair, args: unknown): boolean {
  return isDeepStrictEqual(repair.arguments, args);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
