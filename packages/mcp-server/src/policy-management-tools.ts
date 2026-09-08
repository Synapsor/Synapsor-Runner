import { randomBytes } from "node:crypto";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { ControlPolicyScope } from "@synapsor-runner/proposal-store";
import { z } from "zod";
import { assertBoundedOwnerPolicyInput, ownerPolicyDefinitionSchema } from "./owner-policy-language.js";
import { OwnerPolicyCompileError } from "./owner-policy-compiler.js";
import type { createPolicyManagementService } from "./policy-management.js";
import { PolicyManagementError } from "./policy-management-identity.js";
import { McpRuntimeError } from "./runtime-errors.js";
import { CATALOG_LIMITS, ScopedCatalogIndex, ScopedCatalogSession, catalogResponseBytes } from "./scoped-catalog.js";

export const POLICY_VIEW = "agent_rules";
export const POLICY_REVISION_OUTCOME = "agent_rules.propose_revision";
const view = z.literal(POLICY_VIEW);
const page = { cursor: z.string().regex(/^cur_[A-Za-z0-9_-]{43}$/u).optional(), limit: z.number().int().min(1).max(20).optional() };
const describe = z.object({ policy_view: view }).strict();
const explore = z.object({ policy_view: view, section: z.enum(["summary", "active_rules", "draft_rules", "vocabulary", "budgets"]), ...page }).strict();
const revise = z.object({ policy_view: view, outcome: z.literal(POLICY_REVISION_OUTCOME),
  control_ref: z.string().regex(/^pol_[A-Za-z0-9_-]{43}$/u), definition: z.unknown() }).strict();
export function policyManagementToolInputSchema(tool: string) {
  switch (tool) {
    case "app.describe_data": case "app.describe_actions": return describe;
    case "app.explore_data": return explore;
    case "app.request_change": return revise;
    default: throw new McpRuntimeError("TOOL_NOT_FOUND", "Unknown policy-management tool.");
  }
}

/** Advertise an object shape to the MCP SDK, which does not publish top-level
 * unions. Each dispatcher still validates the selected complete strict branch. */
export function withPolicyManagementInput(source: z.AnyZodObject, tool: string) {
  const shape: z.ZodRawShape = { ...source.partial().shape };
  for (const [key, value] of Object.entries(policyManagementToolInputSchema(tool).shape)) {
    shape[key] = source.shape[key] ? z.union([source.shape[key], value]).optional() : value.optional();
  }
  return z.object(shape).strict().describe("Either the ordinary source-data arguments, or policy_view: agent_rules with its settings arguments. Never mix the two routes.");
}
export type PolicyManagementTools = ReturnType<typeof createPolicyManagementTools>;
type Service = ReturnType<typeof createPolicyManagementService>;
type Detail = Awaited<ReturnType<Service["detail"]>>;
/** Supplied by an authenticated backend, never by a model tool argument. This
 * adapter serves one selected owner view at a time; broad administrator scope
 * selection belongs to the provider's separately authorized management UI. */
export type PolicyManagementToolContext = {
  credential: string; scope: ControlPolicyScope; policy_name: string;
  scope_label: string; session_id: string; expires_at_ms: number;
};
type Handle = { binding: string; epoch: number; expires: number; detail: Detail;
  request?: { digest: string; result: Promise<Record<string, unknown>>; saved_epoch?: number } };

function conditionalNarrowingExample(detail: Detail) {
  for (const outcome of detail.vocabulary) {
    if (!outcome.automatic_approval_delegable) continue;
    for (const fact of outcome.facts) {
      const values = "allowed_values" in fact ? fact.allowed_values : undefined;
      if (fact.operators.includes("one_of") && fact.value_type === "string" && values?.length) {
        return { outcome: outcome.outcome, approval: "inherit", auto_approve_when: { kind: "one_of", fact: fact.name, values: [values[0]!] } };
      }
    }
    for (const fact of outcome.facts) {
      const range = "literal_range" in fact ? fact.literal_range : undefined;
      if (fact.operators.includes("lte") && (fact.value_type === "integer" || fact.value_type === "money_minor") && range) {
        const values = "literal_values" in fact ? fact.literal_values : undefined;
        const value = values
          ? values.find((candidate) => typeof candidate === "number" && Number.isSafeInteger(candidate)
            && candidate >= range.minimum && candidate <= range.maximum)
          : range.maximum;
        if (value !== undefined) {
          return { outcome: outcome.outcome, approval: "inherit", auto_approve_when: { kind: "compare", fact: fact.name, operator: "lte", value } };
        }
      }
    }
  }
  return undefined;
}

/** An explicitly installed virtual-resource provider behind the existing four
 * tools. It never calls a source executor and exposes no confirmation method. */
export function createPolicyManagementTools(options: {
  service: Service;
  resolveContext: () => Promise<PolicyManagementToolContext>;
  publishReview: (input: { scope: ControlPolicyScope; name: string; expected_epoch: number; revision_id: string }) => Promise<string>;
  review_instruction?: string;
  clock?: () => number;
}) {
  const clock = options.clock ?? Date.now;
  const pages = new ScopedCatalogSession(clock);
  const handles = new Map<string, Handle>();
  let calls = 0, responseBytes = 0;
  const settingsOutcome = { type: "success", status: "ok", result: { source: "runner_control_plane" } };
  const measure = (value: Record<string, unknown>) => catalogResponseBytes({ ...value, outcome: settingsOutcome });
  function failure(code: string, message: string): never { throw new McpRuntimeError(code, message); }
  function bounded(value: Record<string, unknown>) {
    const bytes = measure(value);
    if (bytes > CATALOG_LIMITS.responseBytes) failure("POLICY_VIEW_TOO_LARGE", "This complete policy entry cannot fit the reviewed disclosure limit. Open the authenticated exact review; no constraints were truncated.");
    if (responseBytes + bytes > CATALOG_LIMITS.sessionBytes) failure("CATALOG_SESSION_LIMIT", "This settings session reached its disclosure limit. Start a new authenticated session to continue.");
    responseBytes += bytes;
    return value;
  }
  async function context() {
    if (++calls > CATALOG_LIMITS.sessionCalls) failure("CATALOG_SESSION_LIMIT", "This settings session reached its request limit.");
    const current = await options.resolveContext();
    if (!current.session_id || !Number.isFinite(current.expires_at_ms) || current.expires_at_ms <= clock()
      || !current.scope_label.trim() || current.scope_label.length > 160 || /[\u0000-\u001f\u007f]/u.test(current.scope_label)) {
      failure("POLICY_AUTHENTICATION_FAILED", "The authenticated settings session is unavailable or expired.");
    }
    // Reauthenticate and check current parent grants before reading any owner
    // data, looking up a reference, or returning a cached request receipt.
    const detail = await options.service.detail(current.credential, current.scope, current.policy_name);
    const binding = canonicalJsonDigest({ credential: current.credential, scope: current.scope,
      name: current.policy_name, session: current.session_id });
    for (const [token, handle] of handles) if (handle.expires <= clock()) handles.delete(token);
    return { current, detail, binding };
  }
  function reference(binding: string, detail: Detail, expires: number) {
    for (const [token, handle] of handles) if (handle.binding === binding && handle.epoch === detail.epoch && !handle.request) return token;
    while (handles.size >= CATALOG_LIMITS.cursors) handles.delete(handles.keys().next().value!);
    const token = `pol_${randomBytes(32).toString("base64url")}`;
    handles.set(token, { binding, detail, epoch: detail.epoch, expires: Math.min(expires, clock() + CATALOG_LIMITS.cursorMs) });
    return token;
  }
  function base(label: string) {
    return { ok: true, policy_view: POLICY_VIEW, scope: label, source: "runner_control_plane", source_database_changed: false, authority_changed: false };
  }
  function records(detail: Detail, section: z.infer<typeof explore>["section"]): Record<string, unknown>[] {
    if (section === "active_rules" || section === "draft_rules") {
      const selected = section === "active_rules" ? detail.active : detail.draft;
      return selected?.definition.rules.map((rule) => ({ ...rule, state: section === "active_rules" ? "active" : "disabled_draft",
        parent_current: selected.parent_current })) ?? [];
    }
    if (section === "vocabulary") return detail.vocabulary.flatMap((outcome) => [
      { record_kind: "parent_rule", outcome: outcome.outcome, automatic_approval_delegable: outcome.automatic_approval_delegable,
        ...(outcome.parent_require ? { require: outcome.parent_require } : {}) },
      ...outcome.facts.map((fact) => ({ record_kind: "fact", outcome: outcome.outcome, ...fact })),
    ]);
    if (section === "budgets") return (detail.parent_hard_budgets ?? []).map((budget) => ({ ...budget,
      active_maximum: detail.active ? detail.active.definition.budget_limits?.find((limit) => limit.meter === budget.meter)?.maximum ?? budget.maximum : null,
      draft_maximum: detail.draft ? detail.draft.definition.budget_limits?.find((limit) => limit.meter === budget.meter)?.maximum ?? budget.maximum : null,
      measured_event: "successful_effect", pending_or_unknown_effects_reserve_capacity: true,
      consumption_preserved_across_revisions_and_agents: true }));
    return [];
  }
  async function submit(ctx: Awaited<ReturnType<typeof context>>, handle: Handle, definition: unknown) {
    const draft = await options.service.propose(ctx.current.credential, { scope: ctx.current.scope, name: ctx.current.policy_name,
      expected_epoch: handle.epoch, definition });
    if (handle.request) handle.request.saved_epoch = draft.epoch;
    const before = handle.detail.draft?.definition ?? handle.detail.active?.definition;
    const after = ownerPolicyDefinitionSchema.parse(definition);
    const beforeRules = new Map(before?.rules.map((rule) => [rule.outcome, rule]) ?? []);
    const afterRules = new Map(after.rules.map((rule) => [rule.outcome, rule]));
    const changed = [...new Set([...beforeRules.keys(), ...afterRules.keys()])].filter((outcome) =>
      canonicalJsonDigest(beforeRules.get(outcome) ?? null) !== canonicalJsonDigest(afterRules.get(outcome) ?? null));
    let continuation: string | undefined;
    try {
      continuation = await options.publishReview({ scope: ctx.current.scope, name: ctx.current.policy_name,
        expected_epoch: draft.epoch, revision_id: draft.revision_id });
      if (!/^pvr_[A-Za-z0-9_-]{43}$/u.test(continuation)) continuation = undefined;
    } catch { /* The disabled revision is durable even if the review UI is unavailable. */ }
    return { ...base(ctx.current.scope_label), status: draft.status,
      changed_actions: changed, agents_changed: canonicalJsonDigest(before?.agents ?? null) !== canonicalJsonDigest(after.agents),
      budget_limits_changed: canonicalJsonDigest(before?.budget_limits ?? null) !== canonicalJsonDigest(after.budget_limits ?? null),
      active_authority_preserved: true, budget_consumption_preserved: true,
      review: { state: continuation ? "human_review_pending" : "human_review_connection_unavailable",
        ...(continuation ? { continuation } : {}),
        next_step: continuation ? options.review_instruction ?? "Open this revision in the authenticated settings review. Only a human can activate it."
          : "The disabled revision is saved. Reopen the authenticated settings review to inspect and authorize it; nothing was activated." } };
  }
  const provider = {
    handles(input: unknown): boolean {
      return typeof input === "object" && input !== null && Object.hasOwn(input, "policy_view");
    },
    async callTool(tool: string, input: unknown): Promise<Record<string, unknown>> {
      assertBoundedOwnerPolicyInput(input);
      const parsed = policyManagementToolInputSchema(tool).safeParse(input);
      if (!parsed.success) failure("ARGUMENT_INVALID", "Use the exact agent-rules view contract. Source object references, identities, SQL and activation arguments are not accepted here.");
      const ctx = await context(), { current, detail, binding } = ctx;
      if (tool === "app.describe_data") return bounded({ ...base(current.scope_label), resources: [{
        id: "runner.agent_rules", resource: "runner.agent_rules", title: "Agent rules", description: "Your permitted agent settings and disabled revisions. This is not a source-database table.",
        explore: { policy_view: POLICY_VIEW, section: "summary" },
        sections: ["summary", "active_rules", "draft_rules", "vocabulary", "budgets"],
        reference_kind: "pol_", source_object_references_accepted: false,
      }] });
      if (tool === "app.describe_actions" && !detail.permissions.includes("draft")) {
        return bounded({ ...base(current.scope_label), actions: [], management_access: "inspect_only" });
      }
      if (tool === "app.describe_actions" && detail.vocabulary_status !== "current") {
        failure("POLICY_DELEGATION_PARENT_CHANGED", "The reviewed Action vocabulary is no longer current. Inspect existing settings or revoke them; no revision can be drafted.");
      }
      if (tool === "app.describe_actions") return bounded({ ...base(current.scope_label), actions: [{
        outcome: POLICY_REVISION_OUTCOME, title: "Revise agent rules", status: "requires_current_management_permission",
        description: "Prepare a disabled revision of this owner's rules. Parent restrictions and shared consumption remain enforced; human activation is separate.",
        request: { policy_view: POLICY_VIEW, outcome: POLICY_REVISION_OUTCOME, control_ref: "Use the pol_ reference from the settings summary",
          definition: { schema_version: "synapsor.owner-policy.v1", agents: "Reviewed agent names from the summary",
            rules: "Complete intended rules using the reviewed vocabulary", budget_limits: "Optional smaller caps for existing reviewed meters" } },
        rule_contract: { outcome: "Reviewed outcome", require: "Typed predicate", approval: {
          allowed_values: ["inherit", "human"],
          human: "Always requires human review; omit auto_approve_when.",
          inherit: "Defers to the current Action approval policy; it does not approve or execute.",
          auto_approve_when: "Only with inherit: a match defers to the Action policy; a non-match or unknown requires human review.",
          vocabulary_values: "Use literal_values when present; allowed_values are reviewed compiled enum values after parent limits.",
        } },
        predicates: ["all: conditions[]", "any: conditions[]", "not: condition", "compare: fact, operator, value",
          "compare_facts: fact, operator, other_fact", "one_of: fact, values[]", "is_present: fact"],
        comparisons: ["eq", "neq", "lt", "lte", "gt", "gte"],
        ...(() => {
          const example = conditionalNarrowingExample(detail);
          return example ? { conditional_narrowing_example: example } : {};
        })(),
        eligibility: "not_checked", activation_exposed: false,
      }] });
      if (tool === "app.explore_data") {
        const request = explore.parse(parsed.data);
        if (request.section === "vocabulary" && detail.vocabulary_status !== "current") {
          failure("POLICY_DELEGATION_PARENT_CHANGED", "The reviewed Action vocabulary is no longer current. Inspect existing settings or revoke them; no vocabulary is disclosed.");
        }
        if (request.section === "summary") {
          if (request.cursor || request.limit) failure("ARGUMENT_INVALID", "The settings summary has no pages. Page the rules, vocabulary or budgets instead.");
          return bounded({ ...base(current.scope_label), control_ref: reference(binding, detail, current.expires_at_ms),
            can_edit: detail.permissions.includes("draft"),
            agents_available: detail.agents,
            active: detail.active ? { agents: detail.active.definition.agents, action_count: detail.active.definition.rules.length, parent_current: detail.active.parent_current } : null,
            draft: detail.draft ? { agents: detail.draft.definition.agents, action_count: detail.draft.definition.rules.length, parent_current: detail.draft.parent_current } : null,
            sections: ["active_rules", "draft_rules", "vocabulary", "budgets"],
            next_step: "Inspect the existing rules and reviewed vocabulary, then submit one complete disabled revision. Existing active settings do not change until authenticated human review." });
        }
        const index = new ScopedCatalogIndex(records(detail, request.section).map((value, position) => ({
          id: String(position).padStart(5, "0"), title: "Reviewed settings entry", summary: "", value, detail: () => value,
        })));
        return bounded(pages.describe({ index, binding: canonicalJsonDigest({ binding, epoch: detail.epoch, section: request.section }),
          request: { cursor: request.cursor, limit: request.limit }, key: "resources", measureResponse: measure,
          context: { ...base(current.scope_label), section: request.section } }));
      }
      const request = revise.parse(parsed.data), handle = handles.get(request.control_ref);
      if (!handle || handle.binding !== binding) failure("POLICY_REFERENCE_UNAVAILABLE", "This settings reference is expired or belongs to another session. Inspect the current settings again.");
      assertBoundedOwnerPolicyInput(request.definition);
      const definition = ownerPolicyDefinitionSchema.safeParse(request.definition);
      if (!definition.success) failure("ARGUMENT_INVALID", "Use the complete typed owner-rules definition from the reviewed contract.");
      const digest = canonicalJsonDigest(definition.data);
      if (handle.request) {
        const prior = handle.request;
        if (prior.digest !== digest) failure("POLICY_REFERENCE_USED", "This reference already submitted a different revision. Inspect the saved draft before editing again.");
        const receipt = await prior.result;
        const latest = await options.service.detail(current.credential, current.scope, current.policy_name);
        return bounded({ ...receipt, replay: true, receipt_is_not_current_authority: true,
          ...(prior.saved_epoch !== latest.epoch ? { review: { state: "review_context_changed",
            next_step: "This is the prior saved-draft receipt. Settings or permissions changed afterward; inspect the current settings to continue review." } } : {}) });
      }
      if (handle.epoch !== detail.epoch) failure("POLICY_REVISION_CONFLICT", "Settings or parent permissions changed. Inspect the current revision before submitting an edit.");
      let resolveResult!: (value: Record<string, unknown>) => void;
      let rejectResult!: (reason: unknown) => void;
      const result = new Promise<Record<string, unknown>>((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
      handle.request = { digest, result };
      void submit(ctx, handle, definition.data).then(resolveResult, (error: unknown) => {
        if (handle.request?.digest === digest) delete handle.request;
        rejectResult(error);
      });
      return bounded(await result);
    },
  };
  return {
    handles: provider.handles,
    async callTool(tool: string, input: unknown) {
      try {
        const result = await provider.callTool(tool, input);
        return tool === "app.explore_data" ? { ...result, outcome: settingsOutcome } : result;
      }
      catch (error) {
        if (error instanceof McpRuntimeError) throw error;
        if (error instanceof PolicyManagementError) {
          const message = error.code === "POLICY_AUTHENTICATION_FAILED" ? "The authenticated settings session expired or could not be verified. Sign in again."
            : error.code === "POLICY_MANAGEMENT_FORBIDDEN" ? "This session does not have the required settings permission. The existing rules are unchanged."
            : error.code === "POLICY_REVISION_CONFLICT" ? "The settings changed during this request. Inspect the current revision before continuing."
            : "The settings revision is not available under the current parent policy. Reopen the authenticated settings review; no authority was granted.";
          throw new McpRuntimeError(error.code, message);
        }
        if (error instanceof OwnerPolicyCompileError) {
          throw new McpRuntimeError(error.code, "The proposed rules do not fit the reviewed parent contract. Use only its available agents, outcomes, facts, operators and limits. Inspect the vocabulary and current rules before revising; nothing was saved.");
        }
        if (error instanceof Error && error.message === "OWNER_POLICY_COMPLEXITY_LIMIT") {
          throw new McpRuntimeError("POLICY_INPUT_TOO_LARGE", "The settings request exceeds the supported complexity. Use fewer or simpler typed conditions.");
        }
        throw new McpRuntimeError("POLICY_MANAGEMENT_UNAVAILABLE", "The settings service could not finish this request. Reopen the current settings to check saved draft status; no activation was requested.");
      }
    },
  };
}
