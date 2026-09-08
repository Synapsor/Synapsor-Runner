import type { LocalOwnerPolicyReview } from "./owner-policy-runtime.js";
import { terminalTheme } from "./boundary-cli-picker.js";
import { safeTerminalText } from "./analytics-shell-render.js";
import { renderTerminalJson } from "./terminal-syntax.js";
import { terminalContentWidth, wrapStyledTerminalLine } from "./terminal-layout.js";
import { formatPolicyDuration } from "./action-policy-scope.js";

export type OwnerPolicyReviewIo = {
  read(prompt: string): Promise<string | undefined>;
  write(value: string): void;
  isTerminal?(): boolean;
  columns(): number;
  review?(title: string, lines: string[], returnTo?: string): Promise<void>;
  choose?(input: { title: string; message: string; initialValue?: string;
    options: Array<{ value: string; label: string; detail?: string }> }): Promise<string | undefined>;
};

/** Human-only terminal review. Neither the callback nor the service challenge
 * is included in the Ask conversation or in any model tool result. */
export async function reviewOwnerRules(io: OwnerPolicyReviewIo, review: LocalOwnerPolicyReview): Promise<void> {
  let prepared: Awaited<ReturnType<LocalOwnerPolicyReview["prepare"]>> | undefined;
  let confirmed = false;
  try {
    prepared = await review.prepare();
    const color = io.isTerminal?.() === true && !("NO_COLOR" in process.env);
    const theme = terminalTheme(color), width = terminalContentWidth(io.columns());
    const lines = renderOwnerRuleReview(prepared.summary);
    io.write(`\n${theme.title("Review agent rules")}\n${lines.flatMap((line) => wrapStyledTerminalLine(line, width)).join("\n")}\n\n`);
    while (true) {
      const choice = io.choose ? await io.choose({
        title: "AUTHORIZE THIS RULE REVISION", message: "Changes future agent permissions only. Source data stays unchanged.",
        initialValue: "cancel", options: [
          { value: "activate", label: "Activate these reviewed agent rules" },
          { value: "details", label: "Inspect complete before and after rules" },
          { value: "cancel", label: "Keep draft disabled" },
        ],
      }) : await io.read("Type activate to authorize this exact revision, details to inspect, or press Enter to keep it disabled: ");
      if (choice === "details") {
        const exact = renderTerminalJson(prepared.summary, color).split("\n");
        if (io.review) await io.review("Exact agent-rule revision", exact, "Agent-rule confirmation");
        else io.write(`\n${exact.join("\n")}\n\n`);
        continue;
      }
      if (choice !== "activate") { io.write("Draft kept disabled. Your active rules are unchanged.\n\n"); return; }
      await prepared.confirm();
      confirmed = true;
      io.write(`${theme.success("Agent rules activated.")} The next request uses the current rules. Spent and reserved allowance is preserved; no source row changed.\n\n`);
      return;
    }
  } catch (error) {
    const rawCode = (error as { code?: unknown })?.code;
    const code = typeof rawCode === "string" && /^POLICY_[A-Z_]{1,89}$/.test(rawCode) ? rawCode : "POLICY_REVIEW_UNAVAILABLE";
    const message = code === "POLICY_NO_DISABLED_DRAFT" ? "There is no saved rule draft to activate. Describe a change in chat first."
      : code === "POLICY_CREDENTIAL_REQUIRED" || code === "POLICY_AUTHENTICATION_FAILED" ? "Your separate human-review sign-in is missing or expired. Sign in through the configured identity provider, then retry /review-rules."
      : code === "POLICY_MANAGEMENT_FORBIDDEN" ? "This sign-in cannot review the selected owner's rules. Use an authorized human reviewer."
      : "The review could not be confirmed. Inspect current settings and retry /review-rules; a stale review cannot activate a newer draft.";
    io.write(`\n${message}\nReview status: ${safeTerminalText(code)}. No source change was requested.\n\n`);
  } finally {
    if (prepared && !confirmed) { try { prepared.cancel(); } catch { /* Expired challenges already cannot activate. */ } }
  }
}

export function renderOwnerRuleReview(value: unknown): string[] {
  const summary = record(value), scope = record(summary.scope);
  const owner = scope.level === "principal" ? `${text(scope.tenant_id)} / ${text(scope.principal)} / Personal rules`
    : scope.level === "tenant" ? `${text(scope.tenant_id)} / Shared account rules` : "Deployment rules";
  const actions = array(summary.actions), previous = summary.previous_definition == null ? undefined : record(summary.previous_definition);
  const priorRules = new Map((previous ? array(previous.rules) : []).map((rule) => [text(record(rule).outcome), record(rule)]));
  const nextRules = new Set(actions.map((rule) => text(record(rule).outcome)));
  const lines = [`Owner: ${owner}`, `Applies to: ${array(summary.agents).map(text).join(", ")}`, ""];
  if (previous?.agents && JSON.stringify(previous.agents) !== JSON.stringify(summary.agents)) {
    lines.splice(2, 0, `Previously applied to: ${array(previous.agents).map(text).join(", ")}`);
  }
  for (const item of actions) {
    const rule = record(item), prior = priorRules.get(text(rule.outcome));
    lines.push(`${text(rule.outcome)}${prior ? "" : " (new)"}`,
      `  Required: ${predicate(rule.require)}`,
      `  Approval: ${rule.approval === "human" ? "human review required" : "parent approval rules still apply"}`);
    if (rule.auto_approve_when) lines.push(`  To defer to the Action approval policy: ${predicate(rule.auto_approve_when)}; otherwise human review required`);
    if (prior && JSON.stringify(prior.require) !== JSON.stringify(rule.require)) lines.push(`  Previously required: ${predicate(prior.require)}`);
    if (prior && prior.approval !== rule.approval) lines.push(`  Previous approval: ${prior.approval === "human" ? "human review required" : "parent rules"}`);
    if (prior?.auto_approve_when && JSON.stringify(prior.auto_approve_when) !== JSON.stringify(rule.auto_approve_when)) {
      lines.push(`  Previous conditional deferral: ${predicate(prior.auto_approve_when)}; otherwise human review required`);
    }
  }
  for (const [outcome] of priorRules) if (!nextRules.has(outcome)) lines.push(`Removed permission: ${outcome}`);
  const limits = summary.hard_budget_limits ? array(summary.hard_budget_limits) : [];
  const contracts = summary.parent_budget_contracts ? array(summary.parent_budget_contracts).map(record) : [];
  for (const entry of limits) {
    const limit = record(entry), contract = contracts.find((value) => value.meter === limit.meter);
    lines.push(contract
      ? `Hard allowance ${text(contract.title)}: ${text(limit.maximum)} ${text(contract.unit)} per rolling ${formatPolicyDuration(Number(contract.window_ms) / 1000)} (${contract.scope === "tenant" ? "shared account" : "owner across agents"}; parent cap ${text(contract.maximum)})`
      : `Hard allowance ${text(limit.meter)}: ${text(limit.maximum)} reviewed units`);
  }
  for (const contract of contracts) if (!limits.some((limit) => record(limit).meter === contract.meter)) {
    lines.push(`Inherited allowance ${text(contract.title)}: ${text(contract.maximum)} ${text(contract.unit)} per rolling ${formatPolicyDuration(Number(contract.window_ms) / 1000)} (${contract.scope === "tenant" ? "shared account" : "owner across agents"})`);
  }
  if (previous?.budget_limits) {
    for (const entry of array(previous.budget_limits)) {
      const before = record(entry), after = limits.map(record).find((limit) => limit.meter === before.meter);
      if (!after || before.maximum !== after.maximum) lines.push(`Previous allowance ${text(before.meter)}: ${text(before.maximum)}; ${after ? "revised above" : "now inherits the parent cap"}`);
    }
  }
  if (contracts.length) lines.push("Allowances measure successful effects plus outstanding reservations, not approval counts.");
  lines.push("", "Parent safeguards and spent/reserved allowance remain enforced.", "Activation affects future requests; it does not execute a source change.");
  return lines;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid reviewed rule summary");
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) throw new Error("Invalid reviewed rule summary"); return value; }
function text(value: unknown): string {
  if (!["string", "number", "boolean"].includes(typeof value)) throw new Error("Invalid reviewed rule summary");
  return safeTerminalText(String(value));
}
function predicate(value: unknown, depth = 0): string {
  if (depth > 24) throw new Error("Invalid reviewed predicate");
  const condition = record(value);
  if (condition.kind === "all" || condition.kind === "any") return `(${array(condition.conditions).map((item) => predicate(item, depth + 1)).join(condition.kind === "all" ? " AND " : " OR ")})`;
  if (condition.kind === "not") return `NOT (${predicate(condition.condition, depth + 1)})`;
  if (condition.kind === "is_present") return `${text(condition.fact)} is present`;
  if (condition.kind === "one_of") return `${text(condition.fact)} is one of ${array(condition.values).map((v) => text(JSON.stringify(v))).join(", ")}`;
  const operators: Record<string, string> = { eq: "=", neq: "!=", lt: "<", lte: "<=", gt: ">", gte: ">=" };
  const operator = operators[text(condition.operator)];
  if (!operator || (condition.kind !== "compare" && condition.kind !== "compare_facts")) throw new Error("Invalid reviewed predicate");
  return `${text(condition.fact)} ${operator} ${condition.kind === "compare_facts" ? text(condition.other_fact) : text(JSON.stringify(condition.value))}`;
}

export { predicate as renderOwnerRulePredicate };
