import { describe, expect, it } from "vitest";
import {
  activationDisplayOptions,
  executionActivationView,
  proposalActivationView,
  readActivationView,
} from "./authoring-activation-view.js";

describe("activation display views", () => {
  it.each([
    { replacing: false, expected: "Enable the reviewed reading access" },
    { replacing: true, expected: "Replace current reading access with this reviewed revision" },
    { replacing: true, removedResources: 1, expected: "Replace current reading access (removes 1 table)" },
    { replacing: true, removedResources: 2, expected: "Replace current reading access (removes 2 tables)" },
    { replacing: true, reducedGrants: true, expected: "Replace current reading access (reduces reviewed access)" },
  ])("presents the host's actual replacement facts: $expected", ({ expected, ...facts }) => {
    const view = readActivationView(facts);
    expect(view.labels.activate).toBe(expected);
    expect(view.title).toBe(facts.replacing ? "REVIEW ACCESS CHANGES" : "REVIEW ACCESS");
    expect(view.labels.finish).toBe(facts.replacing
      ? "Keep current reading access and finish"
      : "Save without enabling access and finish");
    if (!facts.replacing) expect(view.message).toContain("does not enable changes to the database");
  });

  it.each([
    ["current", "Change what the assistant can read"],
    ["new", "Revise saved read access with a model"],
  ] as const)("keeps the %s-model revision path distinct", (revisionModel, expected) => {
    expect(readActivationView({ replacing: false, revisionModel }).labels.revise_model).toBe(expected);
    expect(readActivationView({ replacing: false }).labels).not.toHaveProperty("revise_model");
  });

  it("changes only selected display labels without changing values, order, disabled options or details", () => {
    const options = [
      { value: "activate", label: "Exact immutable activation", detail: "Digest stays exact", disabled: true },
      { value: "__ask_boundary_model__", label: "Ask the model before deciding", detail: "No authority" },
      { value: "finish", label: "Exact finish", detail: "Source stays unchanged", disabled: false },
      { value: "constructor", label: "Keep this literal business code" },
    ];
    const original = structuredClone(options);
    const rendered = activationDisplayOptions(options, readActivationView({ replacing: false }));
    expect(options).toEqual(original);
    expect(rendered.map(({ value, detail, disabled }) => ({ value, detail, disabled })))
      .toEqual(original.map(({ value, detail, disabled }) => ({ value, detail, disabled })));
    expect(rendered[0]!.label).toBe("Enable the reviewed reading access");
    expect(rendered[1]).toBe(options[1]);
    expect(rendered[2]!.label).toBe("Save without enabling access and finish");
    expect(rendered[3]).toBe(options[3]);
  });

  it("keeps proposal consent separate from source execution and leaves execution's exact display unchanged", () => {
    expect(proposalActivationView()).toMatchObject({
      title: "REVIEW CHANGE REQUESTS",
      message: "Allow the reviewed change requests and approval rules? Database execution has a separate review.",
      labels: { yes: "Enable the reviewed change requests" },
    });
    const options = [{ value: "yes", label: "Allow this exact step" }, { value: "no", label: "Not now; keep authority unchanged" }];
    const execution = executionActivationView("warehouse.reserve_stock");
    expect(execution.message).toBe("Enable supervised source execution for warehouse.reserve_stock?");
    expect(execution.title).toBe("PERMISSION REQUIRED");
    expect(activationDisplayOptions(options, execution)).toEqual(options);
  });
});
