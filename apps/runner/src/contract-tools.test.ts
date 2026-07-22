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
    expect(formatContractLint(first, "text")).toContain("Surface:");
    const json = JSON.parse(formatContractLint(first, "json"));
    expect(json.issues).toEqual(first.issues);
    expect(json.surface).toEqual(first.surface);
    const sarif = JSON.parse(formatContractLint(first, "sarif"));
    expect(sarif.version).toBe("2.1.0");
    expect(sarif.runs[0].results.length).toBe(first.issues.length);
    expect(sarif.runs[0].results.map((result: { ruleId: string }) => result.ruleId)).toEqual(first.issues.map((issue) => issue.code));
    expect(sarif.runs[0].results.map((result: { properties?: unknown }) => result.properties)).toEqual(first.issues.map((issue) => issue.details));
  });

  it("reports unresolved runner sources without reading environment secrets", async () => {
    const loaded = await loadReviewedContract(fixture);
    const result = lintContract(loaded.contract, { runnerConfig: { sources: {}, executors: {} } });
    expect(result.issues).toContainEqual(expect.objectContaining({ code: "RUNNER_SOURCE_UNRESOLVED", severity: "error" }));
    expect(result.ok).toBe(false);
  });

  it("fails Runner lint and explains the boundary for canonical SESSION bindings", async () => {
    const loaded = await loadReviewedContract(fixture);
    loaded.contract.contexts[0]!.bindings[0]!.source = "session";

    const result = lintContract(loaded.contract);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "SESSION_BINDING_UNSUPPORTED",
      severity: "error",
    }));
    expect(result.ok).toBe(false);
    expect(formatContractExplanation(explainContract(loaded.contract), "markdown")).toContain("Synapsor Runner rejects that provider");
  });

  it("warns when a canonical contract explicitly accepts weak projection hashing", async () => {
    const loaded = await loadReviewedContract(fixture);
    loaded.contract.capabilities[0]!.proposal!.conflict_guard = { weak_guard_ack: true };

    const result = lintContract(loaded.contract);
    expect(result.issues).toContainEqual(expect.objectContaining({
      code: "WEAK_CONFLICT_GUARD_ACKNOWLEDGED",
      severity: "warning",
      message: expect.stringContaining("captured projection"),
    }));
    expect(formatContractExplanation(explainContract(loaded.contract), "markdown")).toContain(
      "Conflict guard: WEAK row hash over the captured projection",
    );
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

  it("explains a tenant-additive principal row lock and flags owner-like fields only as an advisory", async () => {
    const loaded = await loadReviewedContract(fixture);
    const capability = loaded.contract.capabilities[0]!;
    capability.subject.principal_scope_key = "assigned_to";
    capability.visible_fields.push("assigned_to");
    const explanation = explainContract(loaded.contract);
    expect(explanation.capabilities[0]?.row_scope).toEqual(expect.objectContaining({
      tenant_column: "tenant_id",
      principal_column: "assigned_to",
      principal_binding: "principal",
      principal_required: true,
      effective_predicate: expect.stringContaining("tenant_id = <trusted tenant> AND assigned_to = <trusted principal>"),
    }));
    expect(formatContractExplanation(explanation, "markdown")).toContain("Principal row lock: `assigned_to`");

    delete capability.subject.principal_scope_key;
    const lint = lintContract(loaded.contract);
    expect(lint.issues).toContainEqual(expect.objectContaining({
      code: "PRINCIPAL_SCOPE_REVIEW_RECOMMENDED",
      severity: "info",
    }));
    expect(lint.issues.find((issue) => issue.code === "PRINCIPAL_SCOPE_REVIEW_RECOMMENDED")?.message).toContain("not data classification");
  });
});
