import path from "node:path";
import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "./cli.js";

describe("capability surface fitness lint CLI", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps advisories valid by default and exposes deterministic structured JSON", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["contract", "validate", fixturePath()])).resolves.toBe(0);
    output.length = 0;
    await expect(main(["contract", "lint", fixturePath(), "--format", "json"])).resolves.toBe(0);
    const first = JSON.parse(output.join(""));
    expect(first.ok).toBe(true);
    expect(first.surface).toMatchObject({
      total_capabilities: 9,
      target_count: 1,
      density_review_threshold: 8,
    });
    expect(first.issues.map((issue: { code: string }) => issue.code)).toEqual(expect.arrayContaining([
      "SURFACE_GENERIC_ARGUMENT",
      "SURFACE_NEAR_DUPLICATE",
      "SURFACE_OPERATION_NAMING",
      "SURFACE_TARGET_DENSITY",
    ]));
    expect(first.issues.find((issue: { code: string }) => issue.code === "SURFACE_TARGET_DENSITY").details.capabilities).toHaveLength(9);

    output.length = 0;
    await expect(main(["contract", "lint", fixturePath(), "--format", "json"])).resolves.toBe(0);
    expect(JSON.parse(output.join(""))).toEqual(first);
  });

  it("renders the same finding set in text and makes warning failure explicitly opt-in", async () => {
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      output.push(String(chunk));
      return true;
    });

    await expect(main(["contract", "lint", fixturePath()])).resolves.toBe(0);
    const text = output.join("");
    for (const code of ["SURFACE_GENERIC_ARGUMENT", "SURFACE_NEAR_DUPLICATE", "SURFACE_OPERATION_NAMING", "SURFACE_TARGET_DENSITY"]) {
      expect(text).toContain(code);
    }
    expect(text).toContain("Surface: 9 model-facing capabilities across 1 targets");

    output.length = 0;
    await expect(main(["contract", "lint", fixturePath(), "--strict"])).resolves.toBe(1);
    expect(output.join("")).toContain("SURFACE_TARGET_DENSITY");
  });
});

function fixturePath(): string {
  for (const candidate of [process.cwd(), path.resolve(process.cwd(), "../..")]) {
    const fixture = path.join(candidate, "fixtures/contracts/capability-surface-fitness.contract.json");
    if (existsSync(fixture)) return fixture;
  }
  throw new Error("capability surface fitness fixture not found");
}
