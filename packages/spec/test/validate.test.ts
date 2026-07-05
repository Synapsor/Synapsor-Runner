import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertValidContract, normalizeContract, validateContract } from "../src/index.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJson(relativePath: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(packageRoot, relativePath), "utf8"));
}

describe("@synapsor/spec validation", () => {
  it("accepts checked-in examples", () => {
    for (const file of fs.readdirSync(path.join(packageRoot, "examples")).filter((name) => name.endsWith(".json"))) {
      const result = validateContract(readJson(`examples/${file}`));
      expect(result.errors, file).toEqual([]);
      expect(result.ok, file).toBe(true);
    }
  });

  it("loads checked-in JSON Schema files", () => {
    for (const file of fs.readdirSync(path.join(packageRoot, "schemas")).filter((name) => name.endsWith(".json"))) {
      const schema = readJson(`schemas/${file}`);
      expect(schema, file).toMatchObject({ $schema: expect.any(String) });
    }
  });

  it("accepts valid fixtures", () => {
    const result = validateContract(readJson("fixtures/valid/basic-read.contract.json"));
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects model-controlled tenant args", () => {
    const result = validateContract(readJson("fixtures/invalid/model-controlled-tenant.contract.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("MODEL_CONTROLLED_TRUST_ARG");
  });

  it("rejects kept-out fields that are also visible", () => {
    const result = validateContract(readJson("fixtures/invalid/kept-out-visible.contract.json"));
    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain("KEPT_OUT_FIELD_VISIBLE");
  });

  it("normalizes deterministically", () => {
    const input = readJson("examples/guarded-writeback.contract.json");
    const first = normalizeContract(input);
    const second = normalizeContract(JSON.parse(JSON.stringify(first)));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("throws useful assertion errors", () => {
    expect(() => assertValidContract({})).toThrow(/UNSUPPORTED_SPEC_VERSION/);
  });

  it("validates conformance contracts", () => {
    const conformanceRoot = path.join(packageRoot, "fixtures/conformance");
    for (const fixture of fs.readdirSync(conformanceRoot)) {
      const contractPath = path.join(conformanceRoot, fixture, "contract.json");
      if (!fs.existsSync(contractPath)) continue;
      const result = validateContract(JSON.parse(fs.readFileSync(contractPath, "utf8")));
      expect(result.errors, fixture).toEqual([]);
      expect(result.ok, fixture).toBe(true);
    }
  });
});
