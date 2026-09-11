import type { ActionRuleCatalogV1 } from "@synapsor-runner/action-rules";
import { describe, expect, it } from "vitest";
import type { ExplorationBoundaryDraft } from "./auto-boundary.js";
import type { BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";
import { buildActionRuleAuthorityDraft, mergeActionRuleAuthorityDraft, type ActionRuleAuthorityDraftV1 } from "./action-rule-authority.js";
import { compileActionRuleModelDraft } from "./action-rule-draft.js";
import {
  manualSemanticActionDraft,
  collectManualActionReview,
  collectManualActionValues,
  collectManualActionEdit,
  manualCheckpointComponentLines,
  manualAuthoritySnapshotMatches,
  assertManualReadSnapshot,
  manualSemanticEditBlocker,
  type ManualActionValues,
  type ManualSemanticActionPrompter,
} from "./manual-semantic-action-editor.js";

const lock = `sha256:${"a".repeat(64)}` as const;
const readDigest = `sha256:${"b".repeat(64)}` as const;

describe("manual semantic ActionRule editor", () => {
  it("builds one bounded proposal-only integer UPDATE through the normal compiler", () => {
    const draft = manualSemanticActionDraft(values());
    expect(manualSemanticEditBlocker(draft)).toBeUndefined();
    const compiled = compileActionRuleModelDraft({
      draft,
      builtCatalog: catalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      authorityName: "warehouse_rules",
      actionBoundaryName: "warehouse_actions",
    });
    expect(compiled.rule.outcome).toBe("warehouse.set_reorder_threshold");
    expect(compiled.effect_envelope.writeback).toMatchObject({ mode: "none" });
    expect(compiled.approval_class.shared_limits.map((limit) => limit.scope).sort())
      .toEqual(["capability", "tenant_principal"]);
  });

  it("preserves the inspected integer unit for a manual effect input", () => {
    const built = catalog();
    const hours = { kind: "integer" as const, unit: "hours" };
    const catalogField = built.catalog.resources[0]!.fields.find((field) => field.name === "reorder_threshold")!;
    const authoringField = built.authoring.resources[0]!.fields.find((field) => field.name === "reorder_threshold")!;
    catalogField.type = hours;
    authoringField.type = hours;
    const draft = manualSemanticActionDraft({ ...values(), input_type: hours });

    expect(() => compileActionRuleModelDraft({
      draft,
      builtCatalog: built,
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
    })).not.toThrow();
  });

  it("wraps a compiled manual rule in a disabled authority revision", () => {
    const compiled = compileActionRuleModelDraft({
      draft: manualSemanticActionDraft(values()),
      builtCatalog: catalog(),
      readBoundary: boundary(),
      readBoundaryDigest: readDigest,
      authorityName: "warehouse_rules",
      actionBoundaryName: "warehouse_actions",
    });

    const saved = buildActionRuleAuthorityDraft({
      name: compiled.loaded.authority.name,
      action_boundary_name: compiled.loaded.authority.action_boundary.name,
      catalog: compiled.loaded.authority.catalog,
      rules: [{
        read_boundary_name: "warehouse_read",
        read_boundary_digest: readDigest,
        verification_boundary: compiled.verification_boundary,
        effect_envelope: compiled.effect_envelope,
        rule: compiled.rule,
      }],
      approval_classes: [compiled.approval_class],
      reviews: [{ outcome: compiled.rule.outcome, ...compiled.review }],
      now: "2026-09-10T00:00:00.000Z",
    });

    const replacement = mergeActionRuleAuthorityDraft({ incoming: saved });
    expect(replacement.state).toBe("disabled");
    expect(replacement.authority.rules[0]?.rule.outcome).toBe("warehouse.set_reorder_threshold");
  });

  it("requires an explicit eligible example for a new manual review", async () => {
    const labels: string[] = [];
    const answers = [
      "Confirmed appointments are eligible.",
      "Create a reminder-hours proposal.",
      "Refuse cancelled appointments and values outside range.",
      "Requests above the automatic threshold need human review.",
      "A confirmed appointment requests a 12-hour reminder.",
      "The request can be automatically approved within the rolling caps.",
    ];
    const review = await collectManualActionReview({
      choose: async () => undefined,
      text: async (label) => { labels.push(label); return answers.shift(); },
      message: async () => undefined,
    }, { when: "", then: "", refused: [], human_review: "", examples: [] });

    expect(labels).toEqual([
      "Eligibility summary", "Proposal summary", "Refusal summary", "Human review summary",
      "Eligible example scenario", "Eligible example result",
    ]);
    expect(review?.examples).toEqual([{
      kind: "eligible", scenario: "A confirmed appointment requests a 12-hour reminder.",
      result: "The request can be automatically approved within the rolling caps.",
    }]);
  });

  it("retains the exact existing examples while editing its summaries", async () => {
    const existing = values().review;
    const review = await collectManualActionReview({
      choose: async () => undefined,
      text: async (_label, options) => options?.defaultValue,
      message: async () => undefined,
    }, existing);

    expect(review?.examples).toEqual(existing.examples);
  });

  it("edits only the current automatic threshold and explicit wording in two prompts, preserving the exact AST", async () => {
    const initial = currentValues();
    const before = structuredClone(initial);
    const prompts: string[] = [];
    const menus: string[] = [];
    const summary: string[] = [];
    const edit = await collectManualActionEdit({
      choose: async (title, choices, context, selected) => {
        menus.push(title);
        summary.push(...context ?? []);
        expect(choices.map(choice => choice.value)).toEqual(["automatic_maximum", "full", "back"]);
        expect(selected).toBe("automatic_maximum");
        return "automatic_maximum";
      },
      text: async label => {
        prompts.push(label);
        return label === "Automatic approval maximum" ? "18" : "Valid requests above 18 require warehouse review.";
      },
      message: async () => undefined,
    }, catalog(), initial, true);

    expect(initial).toEqual(before);
    expect(menus).toEqual(["EDIT CURRENT BUSINESS RULE"]);
    expect(prompts).toEqual(["Automatic approval maximum", "Human review summary"]);
    expect(summary.join("\n")).toContain("threshold: 1 through 1000");
    expect(summary.join("\n")).toContain("threshold <= 100");
    expect(summary.join("\n")).toContain("joint_overall");
    expect(summary.join("\n")).toContain("boundary");
    expect(summary.join("\n")).toContain("joint_account");
    expect(summary.join("\n")).toContain("tenant");
    expect(summary.join("\n")).toContain("disabled");
    const expected = structuredClone(before.base!);
    if (expected.approval.auto_approve_when?.kind !== "compare"
      || expected.approval.auto_approve_when.right.kind !== "literal") throw new Error("Expected threshold fixture.");
    expected.approval.auto_approve_when.right.value = 18;
    expected.review.human_review = "Valid requests above 18 require warehouse review.";
    expect(edit?.draft).toEqual(expected);
    expect(edit?.values.auto_maximum).toBe(18);
    expect(() => compileActionRuleModelDraft({ draft: edit!.draft, builtCatalog: catalog(),
      readBoundary: boundary(), readBoundaryDigest: readDigest })).not.toThrow();
  });

  it("preserves unit-bearing input and predicate types in a threshold-only edit", async () => {
    const initial = currentValues();
    const hours = { kind: "integer" as const, unit: "hours" };
    const built = catalog();
    for (const fields of [built.catalog.resources[0]!.fields, built.authoring.resources[0]!.fields]) {
      fields.find(field => field.name === "reorder_threshold")!.type = hours;
    }
    const base = manualSemanticActionDraft({ ...values(), input_type: hours });
    const edit = await collectManualActionEdit(thresholdPrompter(["18"]), built,
      { ...initial, base, input_type: hours }, true);
    expect(edit?.draft.inputs).toEqual(base.inputs);
    expect(edit?.draft.approval.auto_approve_when).toMatchObject({ right: { value: 18, value_type: hours } });
    expect(() => compileActionRuleModelDraft({ draft: edit!.draft, builtCatalog: built,
      readBoundary: boundary(), readBoundaryDigest: readDigest })).not.toThrow();
  });

  it("keeps another outcome and its shared counter membership exact when compiling a focused replacement", async () => {
    const now = "2026-09-10T00:00:00.000Z";
    const initial = currentValues();
    const other = manualSemanticActionDraft({ ...values(), base: initial.base,
      name: "warehouse.other_threshold", outcome: "warehouse.other_threshold" });
    other.approval.class_name = "warehouse.other_approval";
    const existing = mergeActionRuleAuthorityDraft({ existing: disabledDraft(initial.base!), incoming: disabledDraft(other), now });
    const retained = structuredClone(existing);
    const edit = await collectManualActionEdit(thresholdPrompter(["18"]), catalog(), initial, true);
    const merged = mergeActionRuleAuthorityDraft({ existing, incoming: disabledDraft(edit!.draft), now });
    expect(existing).toEqual(retained);
    expect(merged.state).toBe("disabled");
    expect(merged.authority.rules).toHaveLength(2);
    expect(merged.authority.catalog).toEqual(existing.authority.catalog);
    expect(merged.authority.rules.find(rule => rule.rule.outcome === other.outcome))
      .toEqual(existing.authority.rules.find(rule => rule.rule.outcome === other.outcome));
    expect(merged.authority.approval_classes.find(approval => approval.name === other.approval.class_name))
      .toEqual(existing.authority.approval_classes.find(approval => approval.name === other.approval.class_name));
    expect(merged.reviews.find(review => review.outcome === other.outcome))
      .toEqual(existing.reviews.find(review => review.outcome === other.outcome));
  });

  it.each(["menu", "back", "threshold", "wording"])("cancels a focused edit at %s without changing the source draft", async (stage) => {
    const initial = currentValues();
    const before = structuredClone(initial);
    const prompts: string[] = [];
    const result = await collectManualActionEdit({
      choose: async () => stage === "menu" ? undefined : stage === "back" ? "back" : "automatic_maximum",
      text: async label => { prompts.push(label); return stage === "threshold" ? undefined
        : label === "Automatic approval maximum" ? "18" : undefined; },
      message: async () => undefined,
    }, catalog(), initial, true);
    expect(result).toBeUndefined();
    expect(initial).toEqual(before);
    expect(prompts).toHaveLength(stage === "menu" || stage === "back" ? 0 : stage === "threshold" ? 1 : 2);
  });

  it.each(["not-an-integer", "18.5", "0", "1001", "9007199254740992"])("retries invalid focused threshold %s without reopening the full form", async invalid => {
    const initial = currentValues();
    const prompts: string[] = [];
    const messages: string[] = [];
    const answers = [invalid, "18"];
    const edit = await collectManualActionEdit({
      ...thresholdPrompter(answers),
      text: async (label, options) => {
        prompts.push(label);
        return label === "Automatic approval maximum" ? answers.shift() : options?.defaultValue;
      },
      message: async (title, lines) => { messages.push(title, ...lines); },
    }, catalog(), initial, true);
    expect(prompts).toEqual(["Automatic approval maximum", "Automatic approval maximum", "Human review summary"]);
    expect(messages).toContain("INVALID INTEGER");
    expect(messages.join("\n")).toContain("1 through 1000");
    const expected = structuredClone(initial.base!);
    if (expected.approval.auto_approve_when?.kind !== "compare"
      || expected.approval.auto_approve_when.right.kind !== "literal") throw new Error("Expected threshold fixture.");
    expected.approval.auto_approve_when.right.value = 18;
    expect(edit?.draft).toEqual(expected);
  });

  it("keeps the full current editor available for multiple setting changes", async () => {
    const initial = currentValues();
    const prompts: string[] = [];
    const choices: string[] = [];
    const edit = await collectManualActionEdit({
      choose: async (title, _choices, _context, selected) => {
        choices.push(title);
        return title === "EDIT CURRENT BUSINESS RULE" ? "full" : selected;
      },
      text: async (label, options) => {
        prompts.push(label);
        if (label === "Maximum allowed value") return "900";
        if (label === "Automatic approval maximum") return "90";
        return options?.defaultValue;
      },
      message: async () => undefined,
    }, catalog(), initial, true);
    expect(prompts).toHaveLength(18); // Integer eligibility adds one prompt to the 17-prompt enum form.
    expect(choices).toContain("SELECT UPDATE TARGET");
    expect(choices).toContain("SELECT ELIGIBILITY FIELD");
    expect(edit?.draft.inputs?.[0]?.maximum).toBe(900);
    expect(edit?.draft.approval.auto_approve_when).toMatchObject({ right: { value: 90 } });
    expect(edit?.draft.approval.shared_limits).toEqual(initial.base!.approval.shared_limits);
  });

  it("offers only the full editor for a human-only rule, without inventing an automatic threshold", async () => {
    const initial = { ...values(), approval_mode: "human" as const };
    const base = manualSemanticActionDraft(initial);
    let texts = 0;
    const edit = await collectManualActionEdit({
      choose: async (_title, choices) => {
        expect(choices.map(choice => choice.value)).toEqual(["full", "back"]);
        return "back";
      },
      text: async () => { texts += 1; return undefined; },
      message: async () => undefined,
    }, catalog(), { ...initial, base }, true);
    expect(edit).toBeUndefined();
    expect(texts).toBe(0);
  });

  it("does not invent missing input bounds for the threshold shortcut", async () => {
    const initial = currentValues();
    delete initial.base!.inputs![0]!.minimum;
    initial.base!.require = manualSemanticActionDraft(values()).require;
    const result = await collectManualActionEdit({
      choose: async (_title, choices) => {
        expect(choices.map(choice => choice.value)).toEqual(["full", "back"]);
        return "back";
      },
      text: async () => { throw new Error("No invented threshold range."); },
      message: async () => undefined,
    }, catalog(), initial, true);
    expect(result).toBeUndefined();
  });

  it("retains a collected full edit as the exact starting draft for a subsequent focused correction", async () => {
    const initial = currentValues();
    const full = await collectManualActionEdit({
      choose: async (title, _choices, _context, selected) => title === "EDIT CURRENT BUSINESS RULE" ? "full" : selected,
      text: async (label, options) => label === "Maximum allowed value" ? "900" : options?.defaultValue,
      message: async () => undefined,
    }, catalog(), initial, true);
    const focused = await collectManualActionEdit(thresholdPrompter(["18"]), catalog(), full!.values, true);
    expect(focused?.draft.inputs?.[0]?.maximum).toBe(900);
    expect(focused?.draft.effect).toEqual(full?.draft.effect);
    expect(focused?.draft.require).toEqual(full?.draft.require);
    expect(focused?.draft.approval.auto_approve_when).toMatchObject({ right: { value: 18 } });
  });

  it("cannot use the focused menu to bypass the existing unsupported-rule check", async () => {
    const initial = currentValues();
    initial.base!.effect.writeback = "supervised";
    let prompted = false;
    const result = await collectManualActionEdit({
      choose: async () => { prompted = true; return "automatic_maximum"; },
      text: async () => { prompted = true; return "18"; },
      message: async (_title, lines) => { expect(lines.join("\n")).toContain("UNSUPPORTED"); },
    }, catalog(), initial, true);
    expect(result).toBeUndefined();
    expect(prompted).toBe(false);
  });

  it("reprompts invalid names, selections, and integers without discarding earlier manual answers", async () => {
    const textAnswers = new Map<string, string[]>([
      ["Action rule name", ["not a valid name", "warehouse.set_reorder_threshold"]],
      ["Action outcome", ["warehouse.set_reorder_threshold"]],
      ["Verification binding", ["item"]],
      ["Business input name", ["threshold"]],
      ["Business input description", ["Requested reorder threshold in units."]],
      ["Minimum allowed value", ["not-an-integer", "1"]],
      ["Maximum allowed value", ["1000"]],
      ["Eligibility equality value", ["1"]],
      ["Required reviewer role", ["warehouse_reviewer"]],
      ["Required distinct approvals", ["1"]],
      ["Eligibility summary", ["The selected item is enabled and the request is in range."]],
      ["Proposal summary", ["Create a proposal for the selected item."]],
      ["Refusal summary", ["Refuse disabled items and values outside the range."]],
      ["Human review summary", ["Every valid request requires warehouse review."]],
      ["Eligible example scenario", ["An enabled item requests a routine threshold."]],
      ["Eligible example result", ["Create the reviewed proposal."]],
    ]);
    const choices = new Map<string, string[]>([
      ["SELECT UPDATE TARGET", ["not.a.resource", "warehouse.items"]],
      ["SELECT UPDATED INTEGER FIELD", ["not_a_field", "reorder_threshold"]],
      ["SELECT ELIGIBILITY FIELD", ["reorder_enabled"]],
      ["SELECT APPROVAL FALLBACK", ["human"]],
    ]);
    const messages: string[] = [];
    const result = await collectManualActionValues({
      choose: async (title) => choices.get(title)?.shift(),
      text: async (label) => textAnswers.get(label)?.shift(),
      message: async (title) => { messages.push(title); },
    }, catalog(), { ...values(), name: "", outcome: "", binding: "", input_name: "", input_description: "",
      minimum: 1, maximum: 1000, eligibility_field: "", approval_mode: "human", required_role: "",
      review: { when: "", then: "", refused: [], human_review: "", examples: [] } });

    expect(result).toMatchObject({
      name: "warehouse.set_reorder_threshold", outcome: "warehouse.set_reorder_threshold",
      resource: "warehouse.items", field: "reorder_threshold", minimum: 1, maximum: 1000,
      approval_mode: "human",
    });
    expect(messages).toEqual(expect.arrayContaining([
      "INVALID ACTION IDENTIFIER", "INVALID MANUAL SELECTION", "INVALID INTEGER",
    ]));
  });

  it("refuses an unsupported current rule rather than simplifying it", () => {
    const unsupported = manualSemanticActionDraft(values());
    unsupported.effect.atomic_updates = [{
      operation: "update",
      target_resource: "warehouse.items",
      target_binding: "item",
      allowed_fields: [{ name: "other_threshold", minimum: 1, maximum: 1000 }],
      set: { other_threshold: { kind: "input", name: "threshold" } },
    }];
    expect(manualSemanticEditBlocker(unsupported)).toContain("UNSUPPORTED");
  });

  it.each([
    ["boolean", "is_reorder_enabled", true, { kind: "boolean" }],
    ["declared enum", "reorder_state", "enabled", { kind: "string", max_length: 16, comparison: "exact", enum: ["enabled", "paused"] }],
  ] as const)("accepts an inspected %s equality gate without free-form string authority", (_label, field, value, type) => {
    const draft = manualSemanticActionDraft({ ...values(), eligibility_field: field, eligibility_value: value,
      eligibility_type: type as ManualActionValues["eligibility_type"] });
    expect(manualSemanticEditBlocker(draft)).toBeUndefined();
    expect(() => compileActionRuleModelDraft({ draft, builtCatalog: catalog(), readBoundary: boundary(), readBoundaryDigest: readDigest }))
      .not.toThrow();
  });

  it("preserves every unedited representable component when rebuilding an existing rule", () => {
    const existing = manualSemanticActionDraft(values());
    existing.ttl_seconds = 900;
    existing.verification.name = "warehouse.exact_verification";
    existing.verification.resources[0]!.fields.push("reorder_threshold");
    existing.effect.name = "warehouse.exact_effect";
    existing.approval.class_name = "warehouse.exact_approval";
    if (existing.approval.mode !== "policy") throw new Error("Expected policy fixture.");
    existing.approval.shared_limits[0]!.id = "warehouse.retained_overall";
    existing.approval.shared_limits[1]!.id = "warehouse.retained_customer";

    const revised = manualSemanticActionDraft({ ...values(), maximum: 900, auto_maximum: 90, base: existing });

    expect(revised.ttl_seconds).toBe(900);
    expect(revised.verification.name).toBe("warehouse.exact_verification");
    expect(revised.verification.resources[0]!.fields).toEqual(["reorder_enabled", "reorder_threshold"]);
    expect(revised.effect.name).toBe("warehouse.exact_effect");
    expect(revised.approval.class_name).toBe("warehouse.exact_approval");
    expect(revised.approval.shared_limits.map((limit) => limit.id))
      .toEqual(["warehouse.retained_overall", "warehouse.retained_customer"]);
    expect(manualSemanticEditBlocker(revised)).toBeUndefined();
    expect(() => compileActionRuleModelDraft({ draft: revised, builtCatalog: catalog(), readBoundary: boundary(), readBoundaryDigest: readDigest }))
      .not.toThrow();
  });

  it("round-trips guided identity aliases, explicit bounds and shared account counters without simplifying the rule", () => {
    const base = manualSemanticActionDraft(values());
    base.derive = { reviewed_threshold: { kind: "input", name: "threshold" } };
    base.require = { kind: "all", expressions: [base.require,
      { kind: "compare", operator: "gte", left: { kind: "input", name: "threshold" },
        right: { kind: "literal", value: values().minimum, value_type: { kind: "integer" } } },
      { kind: "compare", operator: "lte", left: { kind: "input", name: "threshold" },
        right: { kind: "literal", value: values().maximum, value_type: { kind: "integer" } } },
    ] };
    base.approval.shared_limits = [
      { id: "joint_overall", kind: "count", scope: "boundary", maximum: values().overall_maximum!, window_seconds: 86400 },
      { id: "joint_account", kind: "count", scope: "tenant", maximum: values().customer_maximum!, window_seconds: 86400 },
    ];
    expect(manualSemanticEditBlocker(base)).toBeUndefined();
    expect(manualSemanticActionDraft({ ...values(), base })).toEqual(base);

    const edited = manualSemanticActionDraft({ ...values(), base, auto_maximum: 20 });
    expect({ ...edited, approval: base.approval }).toEqual(base);
    expect(edited.approval.shared_limits).toEqual(base.approval.shared_limits);
    expect(edited.approval.auto_approve_when).toMatchObject({ right: { value: 20 } });
    expect(() => compileActionRuleModelDraft({ draft: edited, builtCatalog: catalog(), readBoundary: boundary(), readBoundaryDigest: readDigest })).not.toThrow();
  });

  it("updates explicit input guards with a deliberate range edit while retaining alias meaning", () => {
    const base = manualSemanticActionDraft(values());
    base.derive = { reviewed_threshold: { kind: "input", name: "threshold" } };
    base.require = { kind: "all", expressions: [base.require,
      { kind: "compare", operator: "lte", left: { kind: "input", name: "threshold" },
        right: { kind: "literal", value: values().maximum, value_type: { kind: "integer" } } },
    ] };
    const edited = manualSemanticActionDraft({ ...values(), base, input_name: "new_threshold", maximum: 900 });
    expect(edited.derive).toEqual({ reviewed_threshold: { kind: "input", name: "new_threshold" } });
    expect(edited.require).toMatchObject({ expressions: [{ kind: "compare" },
      { left: { kind: "input", name: "new_threshold" }, right: { value: 900 } }] });
    expect(manualSemanticEditBlocker(edited)).toBeUndefined();
  });

  it.each(["different bound", "different input", "extra condition", "computed alias"])("keeps %s outside the form instead of dropping it", (variant) => {
    const base = manualSemanticActionDraft(values());
    if (variant === "computed alias") base.derive = { another: { kind: "literal", value: 1, value_type: { kind: "integer" } } };
    else base.require = { kind: "all", expressions: [base.require, variant === "extra condition" ? structuredClone(base.require)
      : { kind: "compare", operator: "lte", left: { kind: "input", name: variant === "different input" ? "other" : "threshold" },
        right: { kind: "literal", value: variant === "different bound" ? values().maximum - 1 : values().maximum, value_type: { kind: "integer" } } }] };
    expect(manualSemanticEditBlocker(base)).toContain("UNSUPPORTED");
    expect(() => manualSemanticActionDraft({ ...values(), base })).toThrow("UNSUPPORTED");
  });

  it("renders exact reviewed checkpoint selections as terminal lines, not raw JSON", () => {
    const lines = manualCheckpointComponentLines({
      verification: { state: "checkpoint", component: {
        name: "warehouse.verify", resources: [{ binding: "item", resource: "warehouse.items", fields: ["reorder_enabled"] }],
      } },
      effect: { state: "checkpoint", component: {
        operation: "update", target_resource: "warehouse.items", target_binding: "item", allowed_fields: [{ name: "reorder_threshold" }],
      } },
      policy: { state: "checkpoint", component: {
        class_name: "warehouse.review", mode: "policy", required_role: "warehouse_reviewer", required_approvals: 1,
        shared_limits: [{ scope: "capability", maximum: 10, window_seconds: 86_400 }],
      } },
    } as never);
    expect(lines).toContain("Verification resource: warehouse.items as item; fields reorder_enabled.");
    expect(lines).toContain("Effect allowed fields: reorder_threshold.");
    expect(lines).toContain("Policy rolling limit: capability, 10 in 86400 seconds.");
    expect(lines.join("\n")).not.toContain("{");
  });

  it("renders stale checkpoint components as untrusted revalidation context", () => {
    const lines = manualCheckpointComponentLines({
      verification: { state: "needs_revalidation", component: {
        name: "warehouse.verify", resources: [{ binding: "item", resource: "warehouse.items", fields: ["reorder_enabled"] }],
      } },
      effect: { state: "needs_revalidation", component: {
        operation: "update", target_resource: "warehouse.items", target_binding: "item", allowed_fields: [{ name: "reorder_threshold" }],
      } },
      policy: { state: "checkpoint", component: { mode: "human", required_role: "warehouse_reviewer", required_approvals: 1 } },
      checkpoint_rule: { state: "needs_revalidation", component: { outcome: "warehouse.set_reorder_threshold" } },
    } as never);

    expect(lines).toContain("Verification: saved component needs revalidation.");
    expect(lines).toContain("Effect: saved component needs revalidation.");
    expect(lines).toContain("Rule: saved component needs revalidation.");
    expect(lines).toContain("Policy: reviewed saved component.");
    expect(lines.join("\n")).not.toContain("{");
  });

  it("rejects concurrent Action and Read snapshots before a manual save can replace them", () => {
    const existing = manualSemanticActionDraft(values());
    const compiled = compileActionRuleModelDraft({ draft: existing, builtCatalog: catalog(), readBoundary: boundary(), readBoundaryDigest: readDigest });
    const authority = compiled.loaded.authority;
    const draft: ActionRuleAuthorityDraftV1 = {
      schema_version: "synapsor.action-rule-authority-draft.v1", state: "disabled", authority,
      digest: authority.digest, reviews: [{ outcome: existing.outcome, ...existing.review }], created_at: "2026-09-10T00:00:00.000Z",
    };
    expect(manualAuthoritySnapshotMatches(draft, { ...draft, reviews: [{ ...draft.reviews[0]!, then: "Concurrent edit" }] })).toBe(false);

    const selected = { progress: { candidate: boundary() }, draft_lock: {
      schema_fingerprint: `sha256:${"e".repeat(64)}`, role_posture_fingerprint: `sha256:${"f".repeat(64)}`,
    } };
    const expected = { bindings: { repository_id: "00000000-0000-4000-8000-000000000001", deployment_id: "00000000-0000-4000-8000-000000000002",
      project_id: "00000000-0000-4000-8000-000000000003", epoch: 4, revision_id: `policy:${"a".repeat(64)}` }, selected };
    const concurrent = { ...expected, bindings: { ...expected.bindings, epoch: 5 } };
    expect(() => assertManualReadSnapshot(expected as never, concurrent as never, {} as never, readDigest))
      .toThrow("saved Read review changed");
  });
});

function thresholdPrompter(answers: Array<string | undefined>): ManualSemanticActionPrompter {
  return {
    choose: async () => "automatic_maximum",
    text: async (label, options) => label === "Automatic approval maximum" ? answers.shift() : options?.defaultValue,
    message: async () => undefined,
  };
}

function disabledDraft(draft: ReturnType<typeof manualSemanticActionDraft>): ActionRuleAuthorityDraftV1 {
  const compiled = compileActionRuleModelDraft({ draft, builtCatalog: catalog(), readBoundary: boundary(),
    readBoundaryDigest: readDigest, authorityName: "warehouse_rules", actionBoundaryName: "warehouse_actions" });
  return buildActionRuleAuthorityDraft({ name: compiled.loaded.authority.name,
    action_boundary_name: compiled.loaded.authority.action_boundary.name, catalog: compiled.loaded.authority.catalog,
    rules: [{ read_boundary_name: "warehouse_read", read_boundary_digest: readDigest,
      verification_boundary: compiled.verification_boundary, effect_envelope: compiled.effect_envelope, rule: compiled.rule }],
    approval_classes: [compiled.approval_class], reviews: [{ outcome: compiled.rule.outcome, ...compiled.review }],
    now: "2026-09-10T00:00:00.000Z",
  });
}

function currentValues(): ManualActionValues {
  const initial = values();
  const base = manualSemanticActionDraft(initial);
  base.ttl_seconds = 900;
  base.verification.name = "warehouse.retained_verification";
  base.verification.resources[0]!.fields = ["reorder_threshold", "reorder_enabled"];
  base.effect.name = "warehouse.retained_effect";
  base.derive = { reviewed_threshold: { kind: "input", name: "threshold" } };
  base.require = { kind: "all", expressions: [base.require,
    { kind: "compare", operator: "gte", left: { kind: "input", name: "threshold" },
      right: { kind: "literal", value: initial.minimum, value_type: initial.input_type } },
    { kind: "compare", operator: "lte", left: { kind: "input", name: "threshold" },
      right: { kind: "literal", value: initial.maximum, value_type: initial.input_type } },
  ] };
  base.approval.shared_limits = [
    { id: "joint_overall", kind: "count", scope: "boundary", maximum: initial.overall_maximum!, window_seconds: 86400 },
    { id: "joint_account", kind: "count", scope: "tenant", maximum: initial.customer_maximum!, window_seconds: 86400 },
  ];
  return { ...initial, base };
}

function values(): ManualActionValues {
  return {
    intent: "Set an eligible warehouse item's reorder threshold.",
    name: "warehouse.set_reorder_threshold",
    outcome: "warehouse.set_reorder_threshold",
    binding: "item",
    resource: "warehouse.items",
    field: "reorder_threshold",
    input_type: { kind: "integer" },
    input_name: "threshold",
    input_description: "Requested reorder threshold in units.",
    minimum: 1,
    maximum: 1000,
    eligibility_field: "reorder_enabled",
    eligibility_value: 1,
    eligibility_type: { kind: "integer" },
    approval_mode: "policy",
    required_role: "warehouse_reviewer",
    required_approvals: 1,
    auto_maximum: 100,
    overall_maximum: 10,
    overall_window_seconds: 86_400,
    customer_maximum: 3,
    customer_window_seconds: 86_400,
    review: {
      when: "The selected item has reorder settings enabled and the requested threshold is in range.",
      then: "Create a proposal to set that item's reorder threshold.",
      refused: ["The item is not eligible or the threshold is outside the reviewed range."],
      human_review: "A warehouse reviewer handles valid requests above the automatic threshold.",
      examples: [{ kind: "eligible", scenario: "Enabled item with a routine threshold", result: "Automatic approval if rolling limits remain." }],
    },
  };
}

function catalog(): BuiltActionRuleAuthoringCatalogV1 {
  const integer = { kind: "integer" as const };
  const text = { kind: "string" as const, max_length: 64, comparison: "exact" as const };
  const fields = [
    { name: "item_id", type: text, nullable: false },
    { name: "tenant_id", type: text, nullable: false },
    { name: "principal_id", type: text, nullable: false },
    { name: "reorder_threshold", type: integer, nullable: false },
    { name: "reorder_enabled", type: integer, nullable: false },
    { name: "is_reorder_enabled", type: { kind: "boolean" as const }, nullable: false },
    { name: "reorder_state", type: { kind: "string" as const, max_length: 16, comparison: "exact" as const, enum: ["enabled", "paused"] }, nullable: false },
    { name: "version", type: integer, nullable: false },
  ];
  const actionCatalog: ActionRuleCatalogV1 = {
    schema_version: "synapsor.action-rule-catalog.v1",
    generation_lock_fingerprint: lock,
    resources: [{
      name: "warehouse.items", source: "local_postgres", engine: "postgres", schema: "warehouse", table: "items",
      primary_key: "item_id", tenant_key: "tenant_id", principal_scope_key: "principal_id", version_field: "version", fields,
    }],
    relationships: [],
  };
  return {
    catalog: actionCatalog,
    authoring: {
      schema_version: "synapsor.action-rule-authoring-catalog.v1",
      source: "local_postgres", engine: "postgres", read_boundary_name: "warehouse_read",
      generation_lock_fingerprint: lock,
      resources: [{
        name: "warehouse.items", primary_key: "item_id", tenant_scope: "direct", tenant_key: "tenant_id",
        principal_scope: "direct", principal_key: "principal_id", version_candidates: ["version"], selected_version_field: "version",
        operations: { update: true, insert: false },
        fields: fields.map((field) => ({
          ...field,
          role: ["item_id", "tenant_id", "principal_id", "version"].includes(field.name)
            ? "guard" as const
            : ["reorder_enabled", "is_reorder_enabled", "reorder_state"].includes(field.name) ? "runner_verification_only" as const : "model_visible" as const,
          writable: field.name === "reorder_threshold",
        })),
      }],
      relationships: [],
      supported_language: {
        comparisons: ["eq", "neq", "lt", "lte", "gt", "gte"],
        predicates: ["all", "any", "not", "null_check", "in", "exists"],
        aggregates: ["count", "sum", "min", "max"],
        arithmetic: ["add", "subtract", "min", "max", "multiply", "divide", "clamp", "add_duration", "date_of"],
        effects: ["single_row_update", "single_row_insert"],
      },
      diagnostics: [],
      digest: `sha256:${"c".repeat(64)}`,
    },
  };
}

function boundary(): ExplorationBoundaryDraft {
  return {
    schema_version: "synapsor.exploration-boundary.v1", activation: "disabled_unreviewed", deployment_profile: "production",
    source: "local_postgres", compiler_version: "test", spec_version: "test",
    trusted_context: { provider: "environment", tenant_env: "TENANT", principal_env: "PRINCIPAL" },
    generation_lock_fingerprint: lock, role_posture_fingerprint: `sha256:${"d".repeat(64)}`,
    unresolved_decisions: [],
    pack: { name: "warehouse_read", resources: [{
      id: "warehouse.items", schema: "warehouse", table: "items", primary_key: "item_id", tenant_key: "tenant_id", principal_key: "principal_id",
      field_types: {}, field_enums: {}, selectable_fields: ["reorder_threshold"], filterable_fields: {}, sortable_fields: [], groupable_fields: [],
      aggregate_measures: [], count_distinct_fields: [], time_bucket_fields: {}, kept_out_fields: ["reorder_enabled", "version"], relationships: [],
      minimum_cohort_size: 5, suppression_aware_totals: true,
    }] },
    budgets: { max_rows: 50, max_groups: 50, max_top_n: 25, max_measures: 3, max_dimensions: 3, max_time_ranges: 2,
      max_relationship_hops: 2, max_response_cells: 500, max_response_bytes: 65_536, statement_timeout_ms: 3_000,
      max_complexity: 24, max_queries_per_session: 1_000, max_extracted_cells_per_session: 4_000, max_differencing_queries: 16,
      rate_limit_per_minute: 120 },
  };
}
