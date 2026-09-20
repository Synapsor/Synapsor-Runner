import assert from 'node:assert/strict';
import { blockedClosureLines } from '../../../apps/runner/src/worker-blocked-closure.js';
const text = blockedClosureLines({ schema_version: 'synapsor.blocked-closure.v1', proposal_id: 'wrp_presentation_control', status: 'unavailable', code: 'BLOCKED_CLOSURE_NOT_TERMINAL_NO_EFFECT', assessment_digest: `sha256:${'0'.repeat(64)}`, required_roles: [], approval_refunded: false }).join('\n');
console.log(JSON.stringify({derived_control:true, mutation:false, text}));
assert(!text.includes('Old work will never retry.'), 'An unavailable preview must not assert that existing retryable work will never retry');
assert(!text.includes('original proposal and failed receipt stay failed.'), 'An unavailable preview must not label an applied/non-failed item as failed');
