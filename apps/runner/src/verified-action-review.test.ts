import { describe, expect, it, vi } from "vitest";
import { verifiedActionActivationChoiceCopy, verifiedActionManualRevisionChoice } from "./verified-action-review.js";

describe("verified Action manual revision entry", () => {
  it("offers an explicit disabled-only manual route without requiring Read activation", () => {
    const run = vi.fn();
    const choices = verifiedActionManualRevisionChoice({ run });

    expect(choices).toEqual([expect.objectContaining({
      value: "manual_revision",
      label: "Edit business rules manually",
    })]);
    expect(choices[0]?.detail).toContain("current draft and live permissions stay unchanged");
    expect(verifiedActionManualRevisionChoice(undefined)).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("verified Action activation guidance", () => {
  it("names an unfinished program when Read is current, without directing the operator to reactivate Read", () => {
    const choice = verifiedActionActivationChoiceCopy({ draftReady: false, readReviewPending: false, programConcern: true,
      subjectConcern: false, canRecheckRead: false, boundaryName: "reviewed_staging" });
    expect(choice.label).toBe("Review saved program status first");
    expect(choice.detail).toContain("attached-policy review concern");
    expect(`${choice.label} ${choice.detail}`).not.toContain("Activate linked Read Boundary first");
  });

  it("keeps Read guidance for a real Read dependency and activation wording for a ready draft", () => {
    const base = { readReviewPending: false, programConcern: false, subjectConcern: false, canRecheckRead: false,
      boundaryName: "reviewed_staging" };
    expect(verifiedActionActivationChoiceCopy({ ...base, draftReady: false }).label)
      .toBe("Activate linked Read Boundary first");
    expect(verifiedActionActivationChoiceCopy({ ...base, draftReady: true }).label)
      .toBe("Activate this exact proposal authority");
    expect(verifiedActionActivationChoiceCopy({ ...base, draftReady: false,
      readReviewPending: true, programConcern: true }).label).toBe("Activate linked Read Boundary first");
    expect(verifiedActionActivationChoiceCopy({ ...base, draftReady: false,
      canRecheckRead: true, programConcern: true }).label).toBe("Recheck saved changes first");
  });
});

// Display-only declared preview. This does not inspect a writer or grant execution.
describe('execution receipt verification display', () => {
  it.each([false, true])('uses the typed receipt branch when Source is resolved: %s', async resolved => {
    const { semanticExecutionVerificationLines } = await import('./verified-action-review.js');
    const { semanticReceiptExecutionReadback } = await import('./semantic-receipt-presentation.js');
    const fingerprint = `sha256:${'b'.repeat(64)}` as const, action = `sha256:${'a'.repeat(64)}` as const;
    const policy: import('@synapsor-runner/mcp-server').RuntimeSupervisedWorkerOutcomePolicy = {
      mode:'supervised_worker',outcome:'business.update',action_boundary_digest:action,write_url_env:'WRITE',
      writer_posture_fingerprint:fingerprint,concurrency:1,queue_limit:1,lease_seconds:30,max_attempts:1,
      proposal_ttl_seconds:60,rate_limit:{executions:1,window_seconds:60},
    };
    const preview: import('./semantic-action-deployment.js').SemanticSupervisedExecutionPreview = {
      source:'business',outcome:policy.outcome,action_boundary_digest:action,config_path:'runner.json',current_config_digest:action,
      profile:'production',target:'business.items',operation:'update',write_url_env:'WRITE',writer_role:'declared_writer',
      writer_posture_fingerprint:fingerprint,allowed_relations:['business.items'],receipts:{authority:'runner_ledger'},policy,
      verification:{writer:{ok:true,fingerprint,expected_fingerprint:fingerprint,reasons:[],allowed_relations:['business.items'],
        writable_relations:['business.items']},receipt_probe:'not_run_runner_ledger'},
      config:{version:1,supervised_worker:{outcomes:[policy]},sources:resolved?{business:{engine:'postgres',read_url_env:'READ',write_url_env:'WRITE'}}:{}},
    };
    const before=structuredClone(preview), receipt=semanticReceiptExecutionReadback(preview);
    const lines=semanticExecutionVerificationLines(preview);
    expect(lines).toContain('recommendation' in receipt ? receipt.recommendation : receipt.meaning);
    if(!resolved) expect(lines.join('\n')).toContain('exact Source binding is unresolved');
    expect(lines.join('\n')).toContain('no source-atomic receipt guarantee');
    expect(preview).toEqual(before);
  });
});

it('keeps the declared typed parameter fixture current and disabled with private guards withheld', async () => {
  const {boundary}=await import('./test-fixtures/typed-action-parameter.js');
  const value=boundary();
  expect(value.schema_version).toBe('synapsor.exploration-boundary.v2');
  expect(value.activation).toBe('disabled_unreviewed');
  expect(value.pack.resources[0]!.selectable_fields).toEqual(['reorder_threshold']);
  expect(value.pack.resources[0]!.kept_out_fields).toEqual(['reorder_enabled','version']);
});
