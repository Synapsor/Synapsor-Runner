import { describe, expect, it } from "vitest";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import type { RuntimeConfig } from "@synapsor-runner/mcp-server";
import { executionBindingDigest } from "./control-policy-execution.js";

const config = (value: unknown) => value as RuntimeConfig;

describe("execution runtime binding normalization", () => {
  it("omits absent contract properties without mutating the runtime or changing existing JSON digests", () => {
    const bindings = { capabilities: [{ name: "inventory.adjust", description: undefined,
      source: { table: "items", optional: undefined }, args: { value: { type: "number", minimum: 0 } } }],
    storage: undefined };
    const persisted = JSON.parse(JSON.stringify(bindings));
    const before = structuredClone(bindings);
    expect(executionBindingDigest(config(bindings))).toBe(canonicalJsonDigest(persisted));
    expect(bindings).toEqual(before);
    expect(Object.hasOwn(bindings.capabilities[0]!, "description")).toBe(true);
  });

  it("ignores the worker export but binds every meaningful runtime property", () => {
    const bindings = { source: { env: "READER_URL" }, receipt: null };
    expect(executionBindingDigest(config({ ...bindings, supervised_worker: { enabled: true } })))
      .toBe(executionBindingDigest(config({ ...bindings, supervised_worker: { enabled: false } })));
    expect(executionBindingDigest(config(bindings)))
      .not.toBe(executionBindingDigest(config({ ...bindings, source: { env: "OTHER_URL" } })));
    expect(executionBindingDigest(config(bindings)))
      .not.toBe(executionBindingDigest(config({ ...bindings, receipt: undefined })));
  });

  it.each([NaN, Infinity, -Infinity, 1n, () => 1, Symbol("invalid"), new Date(), [undefined], new Array(1)])(
    "continues to refuse non-JSON runtime binding %#", (value) => {
      expect(() => executionBindingDigest(config({ binding: value }))).toThrow();
    },
  );

  it("refuses cycles while permitting repeated non-circular objects", () => {
    const shared: Record<string, unknown> = { optional: undefined, value: 1 };
    expect(executionBindingDigest(config({ first: shared, second: shared })))
      .toBe(canonicalJsonDigest({ first: { value: 1 }, second: { value: 1 } }));
    shared.cycle = shared;
    expect(() => executionBindingDigest(config({ binding: shared }))).toThrow(/circular/);
  });
});
