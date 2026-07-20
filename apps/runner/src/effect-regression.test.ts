import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProposalStore, type ProposalReplayRecord } from "@synapsor-runner/proposal-store";
import {
  acceptEffectBaseline,
  compareEffectResult,
  createEffectFixtureFromReplay,
  createEffectRegressionReport,
  effectResultTemplate,
  formatEffectRegressionReport,
  loadEffectFixture,
  loadEffectFixtureSet,
  loadEffectResult,
  writeEffectJson,
  type EffectFixture,
  type EffectResult,
} from "./effect-regression.js";

describe("effect regression", () => {
  let root: string;
  let fixture: EffectFixture;
  let result: EffectResult;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-effect-test-"));
    const replay = createReplayFixture();
    fixture = createEffectFixtureFromReplay({
      replay,
      name: "courtesy late-fee waiver",
      businessRequest: "Waive the $55 late fee on invoice INV-3001.",
      hiddenFields: ["internal_agent_note", "internal_risk_note"],
      contractVersion: "billing-contract-v1",
    });
    result = effectResultTemplate(fixture);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("creates a replay-bound fixture without secrets, hidden fields, or live evaluation reads", async () => {
    expect(fixture.source.kind).toBe("replay");
    expect(fixture.evidence.source_reads_during_evaluation).toBe(false);
    expect(fixture.expected.source_database_changed).toBe(false);
    expect(fixture.expected.trusted_context).toMatchObject({
      tenant_id: "acme",
      principal: "support-agent-demo",
      provenance: "trusted_session",
    });
    expect(JSON.stringify(fixture)).not.toContain("internal_risk_note\":");
    expect(JSON.stringify(fixture)).not.toMatch(/postgres(?:ql)?:\/\//i);

    const filePath = path.join(root, "effect.json");
    await writeEffectJson(filePath, fixture);
    await expect(loadEffectFixture(filePath)).resolves.toEqual(fixture);
  });

  it("compares an imported result without reading or mutating a source", async () => {
    const sourcePath = path.join(root, "source-sentinel.json");
    await fs.writeFile(sourcePath, "{\"unchanged\":true}\n", "utf8");
    const before = await fs.readFile(sourcePath, "utf8");

    const report = compareEffectResult(fixture, result);

    expect(report.status).toBe("passed");
    expect(await fs.readFile(sourcePath, "utf8")).toBe(before);
    expect(report.checks).toContainEqual(expect.objectContaining({
      code: "REPLAYED_EVIDENCE_ONLY",
      status: "passed",
    }));
  });

  it("fails source mutation and new reads unless a live read is explicit", () => {
    const changed = structuredClone(result);
    changed.source_database_changed = true;
    changed.evidence = { mode: "live", new_source_reads: true };

    expect(failedCodes(compareEffectResult(fixture, changed))).toEqual(expect.arrayContaining([
      "SOURCE_UNCHANGED",
      "REPLAYED_EVIDENCE_ONLY",
    ]));
    expect(failedCodes(compareEffectResult(fixture, changed, { allowLiveRead: true }))).toContain(
      "SOURCE_UNCHANGED",
    );
    expect(failedCodes(compareEffectResult(fixture, changed, { allowLiveRead: true }))).not.toContain(
      "REPLAYED_EVIDENCE_ONLY",
    );
  });

  it("fails capability expansion, model-controlled context, hidden fields, and changed effects", () => {
    const changed = structuredClone(result);
    changed.capability_calls.push({
      name: "database.execute_sql",
      args: {
        tenant_id: "globex",
        principal: "attacker",
        internal_risk_note: "leaked",
      },
    });
    changed.proposal.diff = {
      ...changed.proposal.diff,
      late_fee_cents: { before: 5500, proposed: 2500 },
    };
    changed.observed_fields.push("internal_risk_note");

    expect(failedCodes(compareEffectResult(fixture, changed))).toEqual(expect.arrayContaining([
      "CAPABILITY_CALLS",
      "CAPABILITY_SURFACE_EXPANSION",
      "MODEL_CONTEXT_OVERRIDE",
      "BUSINESS_DIFF",
      "HIDDEN_FIELDS",
    ]));
  });

  it("fails tenant, target, policy, conflict, category, and contract-version drift", () => {
    const changed = structuredClone(result);
    changed.trusted_context.tenant_id = "globex";
    changed.proposal.target = { business_object: "customers", object_id: "CUS-9" };
    changed.proposal.policy = { decision: "auto_approved" };
    changed.proposal.error_code = "VERSION_CONFLICT";
    changed.proposal.result_category = "stale_conflict";
    changed.proposal.contract_version = "billing-contract-v2";

    expect(failedCodes(compareEffectResult(fixture, changed))).toEqual(expect.arrayContaining([
      "TRUSTED_CONTEXT",
      "TARGET_OBJECT",
      "POLICY_DECISION",
      "CONFLICT_OR_BLOCK",
      "RESULT_CATEGORY",
      "CONTRACT_VERSION",
    ]));
  });

  it("updates a business baseline only through explicit acceptance metadata", async () => {
    const changed = structuredClone(result);
    changed.proposal.diff = {
      ...changed.proposal.diff,
      waiver_reason: { before: null, proposed: "Approved exception" },
    };
    const accepted = acceptEffectBaseline({
      fixture,
      result: changed,
      actor: "release-engineer",
      reason: "Reviewed product change",
      acceptedAt: "2026-07-19T12:00:00.000Z",
    });

    expect(accepted.expected.proposal.diff).toEqual(changed.proposal.diff);
    expect(accepted.baseline_history).toEqual([
      expect.objectContaining({
        actor: "release-engineer",
        reason: "Reviewed product change",
        accepted_at: "2026-07-19T12:00:00.000Z",
      }),
    ]);
    const acceptedPath = path.join(root, "accepted.json");
    await writeEffectJson(acceptedPath, accepted);
    await expect(loadEffectFixture(acceptedPath)).resolves.toEqual(accepted);
  });

  it("refuses to accept safety-boundary regressions", () => {
    const hidden = structuredClone(result);
    hidden.observed_fields.push("internal_agent_note");
    expect(() => acceptEffectBaseline({
      fixture,
      result: hidden,
      actor: "operator",
      reason: "unsafe",
    })).toThrow(/EFFECT_BASELINE_SAFETY_REFUSED: HIDDEN_FIELDS/);

    const mutated = structuredClone(result);
    mutated.source_database_changed = true;
    expect(() => acceptEffectBaseline({
      fixture,
      result: mutated,
      actor: "operator",
      reason: "unsafe",
    })).toThrow(/EFFECT_BASELINE_SAFETY_REFUSED: SOURCE_UNCHANGED/);
  });

  it("produces stable JSON and JUnit reports", () => {
    const report = createEffectRegressionReport([compareEffectResult(fixture, result)]);
    expect(formatEffectRegressionReport(report, "json")).toBe(
      formatEffectRegressionReport(report, "json"),
    );
    expect(formatEffectRegressionReport(report, "junit")).toBe(
      formatEffectRegressionReport(report, "junit"),
    );
    expect(formatEffectRegressionReport(report, "junit")).toContain(
      '<testsuite name="synapsor-effect" tests="14" failures="0">',
    );
  });

  it("loads datasets relative to their manifest and validates result artifacts", async () => {
    const fixturePath = path.join(root, "dataset", "effect.json");
    const resultPath = path.join(root, "dataset", "effect.result.json");
    const datasetPath = path.join(root, "dataset", "dataset.json");
    await writeEffectJson(fixturePath, fixture);
    await writeEffectJson(resultPath, result);
    await writeEffectJson(datasetPath, {
      schema_version: "synapsor.effect-dataset.v1",
      name: "billing effects",
      fixtures: ["./effect.json"],
    });

    await expect(loadEffectResult(resultPath)).resolves.toEqual(result);
    await expect(loadEffectFixtureSet({ datasetPath })).resolves.toEqual([
      { path: fixturePath, fixture },
    ]);
  });

  it("detects fixture tampering instead of silently accepting a new baseline", async () => {
    const filePath = path.join(root, "tampered.json");
    await writeEffectJson(filePath, fixture);
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as EffectFixture;
    parsed.business_request = "A changed request";
    await fs.writeFile(filePath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");

    await expect(loadEffectFixture(filePath)).rejects.toThrow(
      /EFFECT_FIXTURE_DIGEST_MISMATCH/,
    );
  });

  it("ships a portable pass/fail reference fixture", async () => {
    const reference = await loadEffectFixture(
      path.resolve("fixtures/effects/support-late-fee.effect.json"),
    );
    const matching = await loadEffectResult(
      path.resolve("fixtures/effects/results/eff_support_late_fee_v1.result.json"),
    );
    const changed = await loadEffectResult(
      path.resolve("fixtures/effects/changed/eff_support_late_fee_v1.result.json"),
    );

    expect(compareEffectResult(reference, matching).status).toBe("passed");
    expect(failedCodes(compareEffectResult(reference, changed))).toEqual(
      expect.arrayContaining(["BUSINESS_DIFF", "POLICY_DECISION"]),
    );
  });
});

function failedCodes(report: ReturnType<typeof compareEffectResult>): string[] {
  return report.checks
    .filter((check) => check.status === "failed")
    .map((check) => check.code);
}

function createReplayFixture(): ProposalReplayRecord {
  const proposalHash = `sha256:${"a".repeat(64)}`;
  const queryFingerprint = `sha256:${"b".repeat(64)}`;
  const store = new ProposalStore(":memory:");
  try {
    store.createProposal({
      schema_version: "synapsor.change-set.v1",
      proposal_id: "wrp_effect_fixture",
      proposal_version: 1,
      action: "billing.propose_late_fee_waiver",
      mode: "review_required",
      principal: { id: "support-agent-demo", source: "trusted_session" },
      scope: {
        tenant_id: "acme",
        business_object: "invoice",
        object_id: "INV-3001",
      },
      source: {
        kind: "external_postgres",
        source_id: "billing",
        schema: "public",
        table: "invoices",
        primary_key: { column: "id", value: "INV-3001" },
      },
      before: {
        late_fee_cents: 5500,
        waiver_reason: null,
        updated_at: "2026-07-19T09:00:00.000Z",
      },
      patch: {
        late_fee_cents: 0,
        waiver_reason: "Courtesy waiver supported by SUP-184",
      },
      after: {
        late_fee_cents: 0,
        waiver_reason: "Courtesy waiver supported by SUP-184",
        updated_at: "2026-07-19T09:00:00.000Z",
      },
      guards: {
        tenant: { column: "tenant_id", value: "acme" },
        allowed_columns: ["late_fee_cents", "waiver_reason"],
        expected_version: {
          column: "updated_at",
          value: "2026-07-19T09:00:00.000Z",
        },
      },
      evidence: {
        bundle_id: "ev_effect_fixture",
        query_fingerprint: queryFingerprint,
        items: [],
      },
      approval: { status: "pending", required_role: "billing_lead" },
      writeback: { status: "not_applied", mode: "trusted_worker_required" },
      source_database_mutated: false,
      integrity: { proposal_hash: proposalHash },
      created_at: "2026-07-19T09:00:01.000Z",
    });
    store.recordEvidenceBundle({
      evidence_bundle_id: "ev_effect_fixture",
      proposal_id: "wrp_effect_fixture",
      tenant_id: "acme",
      payload: {
        principal: "support-agent-demo",
        capability: "billing.propose_late_fee_waiver",
        source_id: "billing",
        business_object: "invoice",
        object_id: "INV-3001",
        support_ticket: "SUP-184",
        courtesy_waiver_eligible: true,
        query_fingerprint: queryFingerprint,
      },
      items: [{
        kind: "support_ticket",
        id: "SUP-184",
        courtesy_waiver_eligible: true,
      }],
    });
    store.recordQueryAudit({
      proposal_id: "wrp_effect_fixture",
      evidence_bundle_id: "ev_effect_fixture",
      source_id: "billing",
      query_fingerprint: queryFingerprint,
      table_name: "public.invoices",
      row_count: 1,
      payload: { parameters_redacted: true },
    });
    store.approveProposal("wrp_effect_fixture", {
      approver: "billing-lead",
      proposal_hash: proposalHash,
      proposal_version: 1,
      reason: "Approved reference effect",
    });
    return store.replay("wrp_effect_fixture");
  } finally {
    store.close();
  }
}
