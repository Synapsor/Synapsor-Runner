import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onboard } from "./guided-start.js";
import { structuredBoundaryAuthoringCommand } from "./boundary-structured-authoring.js";
import { readProjectReadAuthoring } from "./control-policy-read-authoring-project.js";
import { readActionRuleAuthorityActivation, readActionRuleAuthorityDraft, readActionRuleAuthorityRevisionBaseline, writeActionRuleAuthorityDraft } from "./action-rule-authority.js";
import type { BoundaryReviewInteractiveSession } from "./boundary-cli-picker.js";
import { structuredTestAction, structuredTestInspection } from "./structured-authoring-test-fixture.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-structured-counter-")); roots.push(root);
  const inspection = structuredTestInspection();
  const table = inspection.tables[0]!;
  table.columns.find(field => field.name === "version")!.name = "c09";
  table.columns.forEach(field => { field.suggestions.conflict = false; });
  table.suggestions.conflict_columns = [];
  vi.stubEnv("COUNTER_TEST_READ_URL", "postgresql://fixture.invalid/not-used");
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Provider/network calls are forbidden in this regression"));
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const inspect = vi.fn(async () => structuredClone(inspection));
  expect(await onboard(["db", "--project-root", root, "--from-env", "COUNTER_TEST_READ_URL", "--schema", "warehouse", "--json"],
    { interactive: false, schemaInspector: inspect })).toBe(0);
  const run = (args: string[], session?: BoundaryReviewInteractiveSession) => structuredBoundaryAuthoringCommand(["--project-root", root, "--json", ...args], inspect, session);
  expect(await run(["--export-draft", "read.json"])).toBe(0);
  const request = JSON.parse(await fs.readFile(path.join(root, "read.json"), "utf8"));
  request.read.resources = [{ resource_id: "warehouse.items", include: true, principal_key: "principal_id", row_identity: "item_id", tenant_key: "tenant_id",
    selectable_fields: ["sku", "q_av"], keep_out_fields: ["internal_note"] }];
  await fs.writeFile(path.join(root, "read.json"), JSON.stringify(request));
  expect(await run(["--draft", "read.json"])).toBe(0);
  expect(await run(["--export-draft", "action.json"])).toBe(0);
  const input = JSON.parse(await fs.readFile(path.join(root, "action.json"), "utf8"));
  input.read.resources = [];
  input.actions = [structuredTestAction("quantity", "q_av", 50, 20)];
  input.actions[0].approval.shared_limits = input.actions[0].approval.shared_limits.filter((limit: { id: string }) => limit.id !== "reorder_limit");
  await fs.writeFile(path.join(root, "action.json"), JSON.stringify(input));
  const read = (await readProjectReadAuthoring(root))!;
  return { root, inspection, inspect, run, input, stdout, read, name: `${read.selected!.progress.candidate.pack.name}_rules` };
}

function reviewSession(selection = "field:c09", confirmation: string | undefined = "confirm", onConfirm?: () => void | Promise<void>) {
  return { chooseOption: vi.fn(async (title, choices, options) => {
    expect(options?.requireExplicitSelection).toBe(true);
    if (title === "SELECT MAINTAINED CONFLICT COUNTER") {
      expect(options?.initialValue).toBe("cancel");
      expect(choices.map((choice: { value: string }) => choice.value)).toEqual(["cancel", "field:c09", "field:q_av", "field:reorder_point"]);
      return selection;
    }
    expect(title).toBe("REVIEW CHANGED-RECORD PROTECTION");
    expect(options?.initialValue).toBe("pending");
    expect(options?.context?.join("\n")).toContain("every source writer increments");
    expect(options?.exactDetails?.lines.join("\n")).toContain("not proof of external application behavior");
    await onConfirm?.();
    return confirmation;
  }) } as unknown as BoundaryReviewInteractiveSession;
}

const output = (f: Awaited<ReturnType<typeof fixture>>) => f.stdout.mock.calls.map(([chunk]) => String(chunk)).join("\n");

describe("public model-free structured counter review", () => {
  it("requires explicit ambiguous-field review, previews without saving, and retains the selected counter in a disabled Action", async () => {
    const f = await fixture(), baseline = await readActionRuleAuthorityRevisionBaseline(f.root);
    expect(f.input.action_authoring_catalog.resources[0]).toMatchObject({ version_field_options: ["c09", "q_av", "reorder_point"], operations: { update: false } });
    expect(await f.run(["--draft", "action.json", "--dry-run"])).toBe(2);
    const session = reviewSession();
    expect(await f.run(["--draft", "action.json", "--review-counters", "--dry-run"], session)).toBe(0);
    expect(await readActionRuleAuthorityRevisionBaseline(f.root)).toEqual(baseline);
    expect(await f.run(["--draft", "action.json", "--review-counters"], session)).toBe(0);
    expect(session.chooseOption).toHaveBeenCalledTimes(4); // Preview never supplies durable consent for a later submission.
    const saved = (await readActionRuleAuthorityDraft(f.root, f.name))!;
    expect(saved.state).toBe("disabled");
    expect(saved.authority.catalog.resources[0]!.version_field).toBe("c09");
    expect(saved.authority.rules[0]!.rule.effect.set).toEqual({ q_av: { kind: "input", name: "units" } });
    expect(saved.authority.approval_classes[0]!.shared_limits).toEqual(f.input.actions[0].approval.shared_limits.sort((a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id)));
    expect(await readActionRuleAuthorityActivation(f.root)).toBeUndefined();
    expect((await readProjectReadAuthoring(f.root))!.selected!.progress).toEqual(f.read.selected!.progress);
    expect(await f.run(["--export-draft", "after.json"])).toBe(0);
    const exported = JSON.parse(await fs.readFile(path.join(f.root, "after.json"), "utf8"));
    expect(exported.action_authoring_catalog.resources[0]).toMatchObject({ selected_version_field: "c09", operations: { update: true } });
    expect(await f.run(["--draft", "after.json", "--dry-run"])).toBe(0);
    expect(await readActionRuleAuthorityDraft(f.root, f.name)).toEqual(saved);
    // Persist exact reviewed mappings without another model or terminal consent.
    expect(await f.run(["--draft", "after.json"])).toBe(0);
    const content = (authority: typeof saved.authority) => {
      const { digest: _digest, ...rest } = authority;
      return { ...rest, rules: rest.rules.map(({ activated_at: _timestamp, ...rule }) => rule) };
    };
    expect(content((await readActionRuleAuthorityDraft(f.root, f.name))!.authority)).toEqual(content(saved.authority));
    expect(await readActionRuleAuthorityActivation(f.root)).toBeUndefined();
    expect(output(f)).toContain('"maintenance": "all_writers_increment"');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("permits a deliberate exact history-filter edit through a separate structured disabled review", async () => {
    const f = await fixture();
    expect(await f.run(["--draft", "action.json", "--review-counters"], reviewSession())).toBe(0);
    const before = (await readActionRuleAuthorityDraft(f.root, f.name))!;
    expect(await f.run(["--export-draft", "selector-review.json"])).toBe(0);
    const selected = JSON.parse(await fs.readFile(path.join(f.root, "selector-review.json"), "utf8"));
    const rule = selected.actions[0];
    rule.approval.shared_limits.find((limit: { id: string }) => limit.id === "joint_overall").capability = rule.outcome;
    await fs.writeFile(path.join(f.root, "selector-review.json"), JSON.stringify(selected));
    expect(await f.run(["--draft", "selector-review.json", "--dry-run"])).toBe(0);
    expect(await readActionRuleAuthorityDraft(f.root, f.name)).toEqual(before);
    expect(await f.run(["--draft", "selector-review.json"])).toBe(0);
    const after = (await readActionRuleAuthorityDraft(f.root, f.name))!;
    expect(after.authority.approval_classes[0]!.shared_limits.find(limit => limit.id === "joint_overall")!.capability).toBe(rule.outcome);
    expect(after.authority.rules[0]!.rule.effect).toEqual(before.authority.rules[0]!.rule.effect);
    expect(after.state).toBe("disabled");
    expect(await readActionRuleAuthorityActivation(f.root)).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["pending", "cancel", "field_cancel", "invalid_field"])("leaves existing authority and Read unchanged on %s", async kind => {
    const f = await fixture();
    expect(await f.run(["--draft", "action.json", "--review-counters"], reviewSession())).toBe(0);
    const saved = (await readActionRuleAuthorityDraft(f.root, f.name))!;
    const baseline = await readActionRuleAuthorityRevisionBaseline(f.root), read = await readProjectReadAuthoring(f.root);
    expect(await f.run(["--export-draft", "next.json"])).toBe(0);
    const session = reviewSession(kind === "field_cancel" ? "cancel" : kind === "invalid_field" ? "field:principal_id" : "field:reorder_point", kind === "pending" ? "pending" : "confirm");
    if (kind === "cancel") vi.mocked(session.chooseOption!).mockResolvedValueOnce("field:c09").mockResolvedValueOnce(undefined);
    expect(await f.run(["--draft", "next.json", "--review-counters"], session)).toBe(2);
    expect(await readActionRuleAuthorityRevisionBaseline(f.root)).toEqual(baseline);
    expect(await readActionRuleAuthorityDraft(f.root, f.name)).toEqual(saved);
    expect(await readProjectReadAuthoring(f.root)).toEqual(read);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it.each(["before_review", "during_confirmation", "before_save"])("rejects stale inspected metadata %s", async when => {
    const f = await fixture(), baseline = await readActionRuleAuthorityRevisionBaseline(f.root);
    let postConfirmationInspections = 0;
    const drift = () => { f.inspection.tables[0]!.columns.find(field => field.name === "c09")!.nullable = true; };
    if (when === "before_review") drift();
    const session = reviewSession("field:c09", "confirm", () => {
      if (when === "during_confirmation") drift();
      if (when === "before_save") f.inspect.mockImplementation(async () => {
        if (++postConfirmationInspections === 2) drift();
        return structuredClone(f.inspection);
      });
    });
    expect(await f.run(["--draft", "action.json", "--review-counters"], session)).toBe(2);
    expect(output(f)).toMatch(/STRUCTURED_DRAFT_STALE|ACTION_VERSION_REVIEW_STALE/);
    expect(await readActionRuleAuthorityRevisionBaseline(f.root)).toEqual(baseline);
    expect(await readActionRuleAuthorityActivation(f.root)).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("rejects a concurrent saved Action revision after owner confirmation", async () => {
    const f = await fixture();
    expect(await f.run(["--draft", "action.json", "--review-counters"], reviewSession())).toBe(0);
    const concurrent = structuredClone((await readActionRuleAuthorityDraft(f.root, f.name))!);
    concurrent.reviews[0]!.then = "A concurrent operator changed this review summary.";
    expect(await f.run(["--export-draft", "next.json"])).toBe(0);
    const session = reviewSession("field:c09", "confirm", async () => {
      await writeActionRuleAuthorityDraft(f.root, concurrent);
    });
    expect(await f.run(["--draft", "next.json", "--review-counters"], session)).toBe(2);
    expect(output(f)).toContain("ACTION_VERSION_REVIEW_STALE");
    expect(await readActionRuleAuthorityDraft(f.root, f.name)).toEqual(concurrent);
    expect(await readActionRuleAuthorityActivation(f.root)).toBeUndefined();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not accept a file, --json or --yes as source-owner confirmation", async () => {
    const f = await fixture(), baseline = await readActionRuleAuthorityRevisionBaseline(f.root);
    expect(await f.run(["--draft", "action.json", "--review-counters"])).toBe(2);
    expect(output(f)).toContain("real terminal");
    expect(output(f)).toContain("ACTION_VERSION_REVIEW_TERMINAL_REQUIRED");
    expect(output(f)).toContain("Run the counter review in a real operator terminal");
    expect(output(f)).not.toContain("Correct the reported draft field");
    expect(await f.run(["--draft", "action.json", "--review-counters", "--yes"], reviewSession())).toBe(2);
    expect(await f.run(["--export-draft", "unused.json", "--review-counters"], reviewSession())).toBe(2);
    expect(await readActionRuleAuthorityRevisionBaseline(f.root)).toEqual(baseline);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
