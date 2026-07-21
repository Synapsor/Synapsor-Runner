import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [stateDir, outputPath, repoRoot, runnerMode, runnerVersion] = process.argv.slice(2);
if (!stateDir || !outputPath || !repoRoot || !runnerMode || !runnerVersion) {
  throw new Error("usage: build-result.mjs <state-dir> <output> <repo-root> <runner-mode> <runner-version>");
}

const rawDir = path.join(stateDir, "raw");
const sanitizedDir = path.join(stateDir, "sanitized");

async function text(name, sanitized = true) {
  return readFile(path.join(sanitized ? sanitizedDir : rawDir, name), "utf8");
}

async function json(name, sanitized = false) {
  return JSON.parse(await text(name, sanitized));
}

function sourceRow(value) {
  const [customerId, creditCents, reason] = value.trim().split("|");
  return { customer_id: customerId, plan_credit_cents: Number(creditCents), credit_reason: reason };
}

function exactLines(source, wanted) {
  const lines = source.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return wanted.map((fragment) => {
    const match = lines.find((line) => line.includes(fragment));
    if (!match) throw new Error(`contract line missing: ${fragment}`);
    return match;
  });
}

const inspect = await json("inspect.json");
const proposal = await json("proposal.json");
const beforeApproval = await json("proposal-before-approval.json");
const afterApply = await json("proposal-after-apply.json");
const staleProposal = await json("stale-proposal.json");
const staleBeforeApply = await json("stale-proposal-before-apply.json");
const staleAfterApply = await json("stale-proposal-after-apply.json");
const specPackage = JSON.parse(await readFile(path.join(repoRoot, "packages/spec/package.json"), "utf8"));
const dslPackage = JSON.parse(await readFile(path.join(repoRoot, "packages/dsl/package.json"), "utf8"));
const contractSource = await readFile(path.join(repoRoot, "examples/support-plan-credit/contract.synapsor.sql"), "utf8");
const audit = await text("audit.md");
const auditSummary = audit.match(/Findings: HIGH (\d+) \| MEDIUM (\d+) \| LOW (\d+)/);
if (!auditSummary) throw new Error("audit summary missing");

const proposalRecord = beforeApproval.proposal;
const appliedRecord = afterApply.proposal;
const receipt = afterApply.receipts?.[0];
const proposalEvents = afterApply.events?.map((event) => event.kind) ?? [];
const evidenceId = proposal.evidence_bundle_id;

if (proposal.status !== "review_required") throw new Error(`expected review_required, got ${proposal.status}`);
if (proposal.source_database_changed !== false) throw new Error("proposal mutated source database");
if (proposalRecord.state !== "pending_review") throw new Error(`expected pending_review, got ${proposalRecord.state}`);
if (appliedRecord.state !== "applied") throw new Error(`expected applied, got ${appliedRecord.state}`);
if (receipt?.status !== "applied" || receipt?.receipt?.rows_affected !== 1) throw new Error("expected one-row applied receipt");
for (const event of ["proposal_created", "evidence_recorded", "proposal_approved", "writeback_applied"]) {
  if (!proposalEvents.includes(event)) throw new Error(`missing replay event: ${event}`);
}

const source = {
  before: sourceRow(await text("source-before.txt")),
  after_proposal: sourceRow(await text("source-after-proposal.txt")),
  after_apply: sourceRow(await text("source-after-apply.txt")),
  after_stale_refusal: sourceRow(await text("source-after-stale.txt")),
};
if (source.before.plan_credit_cents !== 0 || source.after_proposal.plan_credit_cents !== 0) {
  throw new Error("source changed before approval");
}
if (source.after_apply.plan_credit_cents !== 10000) throw new Error("guarded writeback did not apply expected credit");
if (source.after_stale_refusal.plan_credit_cents !== 10000 || source.after_stale_refusal.credit_reason !== "SLA outage ticket SUP-481") {
  throw new Error("stale proposal changed the reviewed business fields");
}
if (staleProposal.source_database_changed !== false) throw new Error("stale-check proposal mutated source database");
if (staleBeforeApply.proposal?.state !== "pending_review") throw new Error("expected stale-check proposal to require review");
if (staleAfterApply.proposal?.state !== "conflict") throw new Error(`expected stale-check conflict, got ${staleAfterApply.proposal?.state}`);
const staleTranscript = await text("stale-apply.txt");
if (!/VERSION_CONFLICT|conflict/i.test(staleTranscript)) throw new Error("stale apply transcript does not prove a conflict");

let cloud = { complete: false };
try {
  const publicCloud = JSON.parse(await readFile(path.join(stateDir, "cloud-public.json"), "utf8"));
  cloud = { complete: publicCloud.complete === true, ...publicCloud };
} catch {
  // A local-only development render is allowed, but final verification rejects it.
}

const result = {
  schema_version: "synapsor.demo-video-result.v1",
  generated_at: new Date().toISOString(),
  source: {
    repository: "https://github.com/Synapsor/Synapsor-Runner",
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(),
    runner_mode: runnerMode,
    runner_version: runnerVersion,
    spec_version: specPackage.version,
    dsl_version: dslPackage.version,
  },
  audit: {
    tools_inspected: Number(audit.match(/Tools inspected: (\d+)/)?.[1] ?? 0),
    high: Number(auditSummary[1]),
    medium: Number(auditSummary[2]),
    low: Number(auditSummary[3]),
    findings: ["GENERIC_SQL_TOOL", "WRITE_TOOL_ACCEPTS_ARBITRARY_SQL", "MODEL_CONTROLLED_TRUST_SCOPE"],
  },
  contract: {
    context_lines: exactLines(contractSource, [
      "BIND tenant_id FROM ENVIRONMENT",
      "BIND principal FROM ENVIRONMENT",
      "TENANT BINDING",
      "PRINCIPAL BINDING",
    ]),
    boundary_lines: exactLines(contractSource, [
      "ALLOW READ id",
      "KEEP OUT card_token",
      "ALLOW WRITE plan_credit_cents",
      "BOUND plan_credit_cents",
      "APPROVAL ROLE",
      "WRITEBACK DIRECT SQL",
    ]),
  },
  tools: {
    exposed: ["support.inspect_customer", "support.propose_plan_credit"],
    excluded: ["execute_sql / raw query tools", "approval tools", "commit/apply tools", "database URLs", "write credentials", "model-controlled tenant authority"],
    transcript: await text("tools-preview.txt"),
  },
  inspect: {
    tool: inspect.tool,
    tenant_id: inspect.result?.trusted_context?.tenant_id,
    principal: inspect.result?.trusted_context?.principal,
    object_id: inspect.result?.business_object?.id,
    evidence_bundle_id: inspect.result?.evidence_bundle_id,
    source_database_changed: inspect.result?.source_database_changed,
  },
  proposal: {
    proposal_id: proposal.proposal_id,
    evidence_bundle_id: evidenceId,
    status: proposal.status,
    capability: proposal.action,
    tenant_id: proposal.target?.tenant_id,
    object_id: proposal.target?.id,
    diff: proposal.diff,
    approval_required: proposal.approval_required,
    source_database_changed: proposal.source_database_changed,
  },
  source_state: source,
  approval: {
    state_before: proposalRecord.state,
    state_after: "approved",
    required_role: proposalRecord.change_set?.approval?.required_role,
    actor: afterApply.events?.find((event) => event.kind === "proposal_approved")?.actor,
    transcript: await text("approval.txt"),
  },
  writeback: {
    state: appliedRecord.state,
    rows_affected: receipt.receipt.rows_affected,
    idempotency_key: receipt.idempotency_key,
    receipt_id: receipt.receipt_id,
    receipt_hash: receipt.receipt.receipt_hash,
    checks: ["proposal approved", "primary key matched", "tenant guard matched", "allowed columns only", "conflict guard passed", "affected rows: 1"],
    transcript: await text("apply.txt"),
    retry_transcript: await text("apply-retry.txt"),
  },
  stale_conflict: {
    proposal_id: staleProposal.proposal_id,
    capability: staleProposal.action,
    diff: staleProposal.diff,
    state_before_apply: "approved",
    state_after_apply: staleAfterApply.proposal.state,
    source_database_changed: false,
    source_after_refusal: source.after_stale_refusal,
    transcript: staleTranscript,
  },
  replay: {
    replay_id: `replay_${proposal.proposal_id}`,
    events: proposalEvents,
    transcript: await text("replay.txt"),
  },
  cloud,
};

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
console.log(`wrote ${outputPath}`);
