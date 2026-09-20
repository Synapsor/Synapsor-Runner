// Qualification-only accounting; one central allocation, no product changes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
function update(file, operation) {
  const lock = file + '.lock';
  const fd = fs.openSync(lock, 'wx', 0o600); // A competing meter fails closed; no unbounded wait.
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = operation(state);
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, file);
    return result;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function reserve(file, caseId, role, phase, request) {
  return update(file, state => {
    const c = state.case_allocations.find(x => x.case_id === caseId);
    assert(c && c.status === 'LIVE', 'Case is not allocated/live');
    assert(Date.now() < Date.parse(c.deadline), 'Case live deadline exhausted');
    assert(['authoring', 'runtime'].includes(role));
    assert.equal(request.model, c.models[role], 'Undeclared model');
    const calls = c.transports ??= [];
    const sameRole = calls.filter(x => x.role === role);
    assert(sameRole.length < (role === 'authoring' ? 80 : 30), 'Role transport ceiling');
    if (role === 'authoring') {
      const limits = { initial: 50, evolution: 22, restart: 8 };
      assert(phase in limits);
      assert(sameRole.filter(x => x.phase === phase).length < limits[phase], 'Protected phase ceiling');
    }
    const max = request.max_tokens ?? request.max_output_tokens ?? request.max_completion_tokens;
    assert(Number.isInteger(max) && max > 0 && max <= 12000, 'Undeclared output bound');
    // UTF-8 byte count is a conservative token upper bound for these JSON/text
    // envelopes. Runtime uses an intentionally generous $20/$100 per million
    // reserve; actual client reported cost settles it, or it stays reserved.
    const bytes = Buffer.byteLength(JSON.stringify(request));
    const reservation = bytes * (role === 'authoring' ? 0.000004 : 0.000020)
      + max * (role === 'authoring' ? 0.000018 : 0.000100);
    const charged = calls.filter(x => !x.cost_group).reduce((n, x) => n + (x.cost_usd ?? x.provisional_upper_usd ?? x.reservation_usd), 0)
      + (c.runtime_cost_groups ?? []).reduce((n,x) => n+x.cost_usd,0);
    assert(charged + reservation <= c.spend_ceiling_usd, 'Case monetary ceiling would be exceeded');
    const item = { id: `${caseId}-${calls.length + 1}`, role, phase, at: new Date().toISOString(),
      reservation_usd: reservation, input_bytes: bytes, maximum_output_tokens: max, status: 'RESERVED' };
    calls.push(item); return item;
  });
}
export function provisionRuntimeUsage(file, caseId, id, usage) {
  return update(file,state=>{
    const item=state.case_allocations.find(x=>x.case_id===caseId)?.transports.find(x=>x.id===id);
    assert(item?.role==='runtime');
    if(item.cost_group)return;
    assert(Number.isInteger(usage.input_tokens)&&Number.isInteger(usage.output_tokens));
    const totalInput=usage.input_tokens+(usage.cache_creation_input_tokens??0)+(usage.cache_read_input_tokens??0);
    const upper=totalInput*0.000020+usage.output_tokens*0.000100;
    assert(Number.isFinite(upper)&&upper>=0);
    item.provisional_upper_usd=upper;item.usage=usage;
    item.provisional_basis='Observed token counts at conservative $20 input/cache and $100 output per million; NOT actual charge. Native complete-turn result replaces this bound.';
  });
}
export function settleRuntimeTurn(file, caseId, ids, cost) {
  return update(file, state => {
    const c=state.case_allocations.find(x=>x.case_id===caseId);assert(c);
    assert(Number.isFinite(cost)&&cost>=0&&ids.length>0);
    const items=ids.map(id=>c.transports.find(x=>x.id===id));
    assert(items.every(x=>x?.role==='runtime'&&!x.cost_group),'Unknown/already-settled runtime transport');
    const groups=c.runtime_cost_groups??=[];
    const id=`${caseId}-runtime-turn-${groups.length+1}`;
    groups.push({id,transport_ids:ids,cost_usd:cost,basis:'native client total_cost_usd delta for complete turn; not individual transport cost',at:new Date().toISOString()});
    for(const item of items)Object.assign(item,{cost_group:id,status:'TURN_COST_SETTLED'});
  });
}
export function settle(file, caseId, id, cost, details = {}) {
  return update(file, state => {
    const item = state.case_allocations.find(x => x.case_id === caseId)?.transports.find(x => x.id === id);
    assert(item, 'Unknown reservation');
    if (cost != null) { assert(Number.isFinite(cost) && cost >= 0); item.cost_usd = cost; }
    Object.assign(item, { status: cost == null ? 'UNKNOWN_COST_RESERVED' : 'SETTLED',
      completed_at: new Date().toISOString(), ...details });
  });
}
