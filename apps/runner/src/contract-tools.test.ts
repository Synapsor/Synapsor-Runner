import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { explainContract, formatContractExplanation, formatContractLint, lintContract, lintFails, loadReviewedContract } from "./contract-tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = path.join(root, "packages/dsl/examples/bounded-set-multi-term.synapsor.sql");
const aggregateFixture = path.join(root, "packages/dsl/examples/aggregate-read.synapsor.sql");

describe("contract review tooling", () => {
  it("loads DSL through the canonical compiler and explains the trust boundary without environment values", async () => {
    const loaded = await loadReviewedContract(fixture);
    const explanation = explainContract(loaded.contract);
    const markdown = formatContractExplanation(explanation, "markdown");
    expect(loaded.source).toBe("dsl");
    expect(markdown).toContain("cases.close_high_risk");
    expect(markdown).toContain("tenant from context binding tenant_id");
    expect(markdown).toContain("Proposal");
    expect(markdown).toContain("approval");
    expect(markdown).toContain("direct_sql");
    expect(markdown).not.toContain(process.env.DATABASE_URL ?? "definitely-not-present");
    expect(JSON.parse(formatContractExplanation(explanation, "json"))).toEqual(explanation);
  });

  it("emits stable objective lint rules and honors fail-on severity", async () => {
    const loaded = await loadReviewedContract(fixture);
    const runnerConfig = {
      sources: { support_db: { engine: "postgres" } },
      executors: {},
    };
    const first = lintContract(loaded.contract, { runnerConfig, dslWarnings: loaded.dslWarnings });
    const second = lintContract(loaded.contract, { runnerConfig, dslWarnings: loaded.dslWarnings });
    expect(second).toEqual(first);
    expect(first.issues.map((issue) => issue.code)).toContain("KEPT_OUT_REVIEW_NOT_RECORDED");
    expect(lintFails(first, "error")).toBe(false);
    expect(lintFails(first, "warning")).toBe(true);
    expect(formatContractLint(first, "text")).toContain("Summary:");
    const sarif = JSON.parse(formatContractLint(first, "sarif"));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results.length).toBe(first.issues.length);
  });

  it("reports unresolved runner sources without reading environment secrets", async () => {
    const loaded = await loadReviewedContract(fixture);
    const result = lintContract(loaded.contract, { runnerConfig: { sources: {}, executors: {} } });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "RUNNER_SOURCE_UNRESOLVED", severity: "error" }));
    expect(result.ok).toBe(false);
  });

  it("accepts canonical JSON as the same review source", async () => {
    const temp = path.join(root, ".synapsor-contract-tools-test.json");
    const loaded = await loadReviewedContract(fixture);
    await fs.writeFile(temp, `${JSON.stringify(loaded.contract, null, 2)}\n`, "utf8");
    try {
      const jsonLoaded = await loadReviewedContract(temp);
      expect(jsonLoaded.source).toBe("json");
      expect(jsonLoaded.contract).toEqual(loaded.contract);
    } finally {
      await fs.rm(temp, { force: true });
    }
  });

  it("explains aggregate authority, fixed selection, suppression, and no-row output", async () => {
    const loaded = await loadReviewedContract(aggregateFixture);
    const explanation = explainContract(loaded.contract);
    const aggregate = explanation.capabilities[0]!;
    expect(aggregate).toMatchObject({
      kind: "aggregate_read",
      fixed_selection: ["status = 'overdue'"],
      aggregate: {
        function: "sum",
        column: "balance_cents",
        minimum_group_size: 5,
      },
    });
    const markdown = formatContractExplanation(explanation, "markdown");
    expect(markdown).toContain("Aggregate: `sum balance_cents`");
    expect(markdown).toContain("Minimum group size: 5");
    expect(markdown).toContain("no member rows or identities");
  });
});
