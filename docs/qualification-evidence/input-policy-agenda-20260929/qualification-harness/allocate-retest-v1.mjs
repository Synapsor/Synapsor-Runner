// Qualification-only allocation for owner b47dae4e, not a Runner product module.
// Create the next authoritative ledger revision; preserve the sealed parent file.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { hash, units, summary, transportSummary } from '/home/sandesh-tiwari/Desktop/C++/synapsor-runner/docs/qualification-evidence/larger-programs-supported-20260927/lane-c-harness/lane-c-budget-v5.mjs';
import { acquireBudgetLock } from '/home/sandesh-tiwari/Desktop/C++/synapsor-runner/docs/qualification-evidence/source-phase-review-20260921/provider-budget.mjs';

export const ownerSha256 = '8c32d9950fc95875f7056dae7de96da1bbcdb28e73045c7a364e48ccca83833e';
export const deadline = '2026-09-30T12:07:34Z';
export const journey = 'input_agenda_retest';
const digest = /^[a-f0-9]{64}$/;
const outstanding = e => e.status === 'RESERVED' || (e.started_at && !e.completed_at);

export function allocateRetest(parent, destination, amendment, signoffs) {
  assert(path.resolve(parent) !== path.resolve(destination), 'SEALED_PARENT_MUST_BE_DISTINCT');
  assert(!fs.existsSync(destination), 'CONTINUATION_ALREADY_EXISTS');
  const amendmentHash = hash(JSON.stringify(amendment));
  for (const role of ['Main', 'Tester']) {
    const ref = signoffs?.[role]; assert(ref?.path && digest.test(ref.sha256), 'JOINT_SIGNOFF_REQUIRED');
    const bytes = fs.readFileSync(ref.path); assert.equal(hash(bytes), ref.sha256, 'SIGNOFF_CHANGED');
    const signed = JSON.parse(bytes);
    assert(signed.role === role && signed.accepted === true && signed.amendment_sha256 === amendmentHash, 'SIGNOFF_MISMATCH');
  }
  assert.equal(amendment.owner_sha256, ownerSha256, 'OWNER_CHANGED');
  assert.equal(amendment.parent_path, path.resolve(parent), 'PARENT_PATH_CHANGED');
  assert.equal(amendment.destination_path, path.resolve(destination), 'DESTINATION_PATH_CHANGED');
  assert.equal(fs.realpathSync(parent), path.resolve(parent), 'PARENT_PATH_ALIAS');
  assert.equal(fs.realpathSync(path.dirname(destination)), path.resolve(path.dirname(destination)), 'DESTINATION_PATH_ALIAS');
  assert.equal(amendment.id, 'input-agenda-fidelity-20260929-allocation1', 'ALLOCATION_ID');
  assert(digest.test(amendment.expected_parent_sha256), 'PARENT_BINDING_REQUIRED');
  assert(digest.test(amendment.expected_policy_sha256), 'POLICY_BINDING_REQUIRED');
  assert(digest.test(amendment.plan_sha256), 'PLAN_BINDING_REQUIRED');
  assert(digest.test(amendment.installed_acceptance_sha256), 'INSTALLED_ACCEPTANCE_REQUIRED');
  assert.equal(amendment.deadline, deadline, 'DEADLINE_CHANGED');
  assert(Date.now() < Date.parse(deadline), 'DEADLINE');
  const lockPath = parent + '.lock'; const lock = acquireBudgetLock(lockPath);
  const marker = parent + '.input-agenda-retest-allocation.json';
  let temporary; let markerCreated = false; let destinationPublished = false;
  try {
    assert(!fs.existsSync(marker), 'PARENT_ALREADY_ALLOCATED');
    const bytes = fs.readFileSync(parent); assert.equal(hash(bytes), amendment.expected_parent_sha256, 'PARENT_CHANGED');
    const state = JSON.parse(bytes); const lane = state.larger_programs_lane_c;
    assert(state.active_operation == null && lane && !lane.stopped && !lane.entries.some(outstanding), 'NOT_QUIESCENT');
    assert.equal(lane.policy_sha256, amendment.expected_policy_sha256, 'POLICY_CHANGED');
    assert.equal(hash(JSON.stringify(lane.policy)), lane.policy_sha256, 'POLICY_INTEGRITY');
    assert.deepEqual(Object.keys(lane.policy.journeys).sort(), ['direct', 'mini', 'or'], 'HISTORICAL_LANES_CHANGED');
    assert(!lane.amendment_events?.some(x => x.id === amendment.id), 'ALLOCATION_ALREADY_APPLIED');
    assert.equal(lane.policy.campaign_usd, '80', 'CAMPAIGN_CHANGED');
    assert.equal(lane.policy.combined_usd, '60', 'HISTORICAL_COMBINED_CHANGED');
    assert.equal(lane.policy.serial_chargeable_egress, true, 'SERIAL_REQUIRED');
    const prior = summary(state); const counts = transportSummary(state);
    assert(units(prior.campaign) + units('20') <= units('80'), 'COMPLETE_ALLOCATION_CAMPAIGN_SHORTFALL');
    assert(units(prior.combined) + units('20') <= units('60'), 'COMPLETE_ALLOCATION_COMBINED_SHORTFALL');
    const priorPolicy = structuredClone(lane.policy); const priorStops = structuredClone(lane.stopped_journeys ?? {});
    lane.policy = { ...priorPolicy, deadline, journeys: { ...priorPolicy.journeys, [journey]: {
      usd: '20', transports: 800, token_count_calls: 100, historical_token_count_calls: 0,
      transient_retries: priorPolicy.journeys.direct.transient_retries, plan_sha256: amendment.plan_sha256
    } } };
    // Old semantic/uncertain stops are retained exactly. Closed successful transport
    // records do not imply authority to reopen either other historical sample.
    lane.stopped_journeys = { ...priorStops };
    for (const old of ['direct', 'or', 'mini']) lane.stopped_journeys[old] ??= {
      reason: 'HISTORICAL_JOURNEY_CLOSED', at: new Date().toISOString(), allocation_id: amendment.id
    };
    lane.policy_sha256 = hash(JSON.stringify(lane.policy));
    (lane.amendment_events ??= []).push({
      id: amendment.id, at: new Date().toISOString(), amendment_sha256: amendmentHash,
      owner_sha256: ownerSha256, parent_path: path.resolve(parent), parent_sha256: hash(bytes),
      prior_policy: priorPolicy, prior_policy_sha256: amendment.expected_policy_sha256,
      prior_stops: priorStops, prior_summary: prior, prior_counters: counts,
      new_journey: journey, allocation_usd: '20', installed_acceptance_sha256: amendment.installed_acceptance_sha256,
      signoffs: structuredClone(signoffs)
    });
    assert.equal(summary(state).campaign, prior.campaign, 'ALLOCATION_IS_NOT_SPEND');
    for (const old of ['direct', 'or', 'mini']) assert.deepEqual(transportSummary(state)[old], counts[old], 'HISTORY_CHANGED');
    // This sidecar chooses ONE authoritative continuation from this sealed parent.
    // A crash leaves it in place for explicit diagnosis, never an automatic fork.
    const markerFd = fs.openSync(marker, 'wx', 0o600); markerCreated = true;
    try { fs.writeFileSync(markerFd, JSON.stringify({ amendment_sha256: amendmentHash, destination: path.resolve(destination), parent_sha256: hash(bytes) }) + '\n'); fs.fsyncSync(markerFd); }
    finally { fs.closeSync(markerFd); }
    const parentDir = fs.openSync(path.dirname(parent), 'r'); try { fs.fsyncSync(parentDir); } finally { fs.closeSync(parentDir); }
    temporary = destination + `.allocation-${process.pid}-${Date.now()}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    assert.equal(hash(fs.readFileSync(parent)), amendment.expected_parent_sha256, 'PARENT_CHANGED_DURING_ALLOCATION');
    // Atomic no-replace publication: readers cannot observe a partial ledger and
    // a racing allocator cannot overwrite the already-created continuation.
    fs.linkSync(temporary, destination); destinationPublished = true;
    const dir = fs.openSync(path.dirname(destination), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return { destination, journey, summary: summary(state), counters: transportSummary(state), amendment_sha256: amendmentHash };
  } catch (error) {
    if (markerCreated && !destinationPublished) fs.unlinkSync(marker);
    throw error;
  } finally {
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    fs.closeSync(lock); fs.unlinkSync(lockPath);
  }
}
