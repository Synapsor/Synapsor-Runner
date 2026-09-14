import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ProposalStore, PostgresProposalRuntimeStore, type ProposalRuntimeStore, type ActionBoundaryApprovalContext,
  type PostgresRuntimeClient, type PostgresRuntimePool, type StoredProposal } from "./index.js";

const outcome = "reserve_ops.adjust_claim_reserve";
const boundary: ActionBoundaryApprovalContext = { name: "reviewed_insurance", digest: `sha256:${"a".repeat(64)}`, limits: [
  { id: "overall", kind: "count", scope: "capability", capability: outcome, maximum: 8, window_seconds: 86400 },
  { id: "insurer", kind: "count", scope: "tenant", capability: outcome, maximum: 3, window_seconds: 86400 },
] };
const time = (second: number) => new Date(Date.parse("2026-09-12T12:00:00.000Z") + second * 1000).toISOString();

async function proposal(store: ProposalRuntimeStore, id: string, tenant = "insurer-a", principal = "adjuster-a", action = outcome) {
  const input = JSON.parse(await fs.readFile(new URL("../../../fixtures/protocol/change-set.late-fee-waiver.v1.json", import.meta.url), "utf8"));
  input.proposal_id = id; input.action = action; input.principal.id = principal;
  input.scope.tenant_id = tenant; input.guards.tenant.value = tenant;
  input.scope.object_id = id; input.source.primary_key.value = id;
  input.integrity.proposal_hash = `sha256:${id}`;
  return await store.createProposal(input);
}
function options(p: StoredProposal, now?: string, action_boundary = boundary) {
  return { policy: "reviewed_policy", proposal_hash: p.proposal_hash, proposal_version: p.proposal_version,
    reason: "eligible synthetic local fixture", action_boundary, ...(now ? { now } : {}) };
}
async function saveObservation(name: string, value: unknown) {
  const directory = process.env.SYNAPSOR_TEST_EVIDENCE_DIR;
  if (directory) { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, `${name}.json`), JSON.stringify(value, null, 2) + "\n"); }
}
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("durable automatic approval admission", () => {
  it("does not partially consume combined limits, merge insurers, count human decisions, or reset history on a stricter revision", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-approval-accounting-"));
    const store = new ProposalStore(path.join(directory, "control.sqlite"));
    const approve = async (id: string, tenant: string, at: number, reviewed = boundary) => {
      const p = await proposal(store, id, tenant, `person-${id}`);
      return store.approveProposalByPolicy(p.proposal_id, options(p, time(at), reviewed));
    };
    try {
      for (let i = 0; i < 3; i++) expect((await approve(`wrp_a${i}`, "insurer-a", i)).approved).toBe(true);
      expect(await approve("wrp_a_denied", "insurer-a", 4)).toMatchObject({ approved: false,
        proposal: { state: "pending_review" }, tripped_limits: [expect.objectContaining({ id: "insurer", observed: 3 })] });
      const human = await proposal(store, "wrp_human", "insurer-b");
      store.approveProposal(human.proposal_id, { approver: "local-test-reviewer", proposal_hash: human.proposal_hash, proposal_version: 1 });
      for (const [i, tenant] of ["insurer-b", "insurer-b", "insurer-b", "insurer-c", "insurer-c"].entries())
        expect((await approve(`wrp_other${i}`, tenant, 5 + i)).approved).toBe(true);
      expect(await approve("wrp_overall_denied", "insurer-c", 11)).toMatchObject({ approved: false,
        proposal: { state: "pending_review" }, tripped_limits: [expect.objectContaining({ id: "overall", observed: 8 })] });
      const stricter = { ...boundary, digest: `sha256:${"b".repeat(64)}` as const,
        limits: boundary.limits.map(l => ({ ...l, maximum: l.scope === "tenant" ? 1 : 20 })) };
      expect(await approve("wrp_stricter", "insurer-c", 12, stricter)).toMatchObject({ approved: false,
        tripped_limits: [expect.objectContaining({ id: "insurer", observed: 2, maximum: 1 })] });
      // Overall denial did not consume a third scoped slot; history survives revision.
      const loosenedOverall = { ...boundary, digest: stricter.digest,
        limits: boundary.limits.map(l => ({ ...l, maximum: l.scope === "capability" ? 20 : l.maximum })) };
      expect((await approve("wrp_c_third", "insurer-c", 13, loosenedOverall)).approved).toBe(true);
      const automatic = store.listProposals().flatMap(p => store.approvals(p.proposal_id)).filter(a => a.approver.startsWith("policy:"));
      expect(automatic).toHaveLength(9);
      expect(store.receipts(human.proposal_id)).toEqual([]);
    } finally { store.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("counts other outcomes when boundary and tenant selectors omit capability; adding a filter changes history", async () => {
    for (const narrowed of [false, true]) {
      const store = new ProposalStore();
      const shared: ActionBoundaryApprovalContext = { name: boundary.name, digest: boundary.digest, limits: [
        { id: "overall", kind: "count", scope: "boundary", maximum: 1, window_seconds: 86400 },
        { id: "insurer", kind: "count", scope: "tenant", maximum: 1, window_seconds: 86400 },
      ] };
      try {
        const prior = await proposal(store, "wrp_history_other", "insurer-a", "person-a", "reserve_ops.review_claim");
        expect(store.approveProposalByPolicy(prior.proposal_id, options(prior, time(0), shared)).approved).toBe(true);
        const next = await proposal(store, "wrp_history_current", "insurer-a", "person-b");
        const reviewed = narrowed ? { ...shared, limits: shared.limits.map(limit => ({ ...limit, capability: outcome })) } : shared;
        const result = store.approveProposalByPolicy(next.proposal_id, options(next, time(1), reviewed));
        expect(result.approved).toBe(narrowed);
        if (!narrowed) expect(result).toMatchObject({ proposal: { state: "pending_review" },
          tripped_limits: [expect.objectContaining({ id: "overall", observed: 1 }), expect.objectContaining({ id: "insurer", observed: 1 })] });
        expect(store.approvals(prior.proposal_id)).toHaveLength(1);
        expect(store.approvals(next.proposal_id)).toHaveLength(narrowed ? 1 : 0);
      } finally { store.close(); }
    }
  });

  it("records the counting contract across human decisions, outcomes, tenants and inclusive windows", async () => {
    const observations = [];
    for (const history of ["same_automatic", "other_automatic", "other_human", "other_boundary", "other_tenant", "expired", "exact_start"] as const) {
      for (const filtered of [false, true]) {
        const store = new ProposalStore();
        const shared: ActionBoundaryApprovalContext = { name: boundary.name, digest: boundary.digest, limits: [
          { id: "scope", kind: "count", scope: "tenant", maximum: 1, window_seconds: 60,
            ...(filtered ? { capability: outcome } : {}) },
        ] };
        try {
          const prior = await proposal(store, "wrp_diagnostic_prior", history === "other_tenant" ? "insurer-b" : "insurer-a", "first-person",
            ["other_automatic", "other_human"].includes(history) ? "reserve_ops.review_claim" : outcome);
          if (history === "other_human") {
            vi.useFakeTimers(); vi.setSystemTime(time(0));
            try { store.approveProposal(prior.proposal_id,
              { approver: "fixture-owner", proposal_hash: prior.proposal_hash, proposal_version: prior.proposal_version }); }
            finally { vi.useRealTimers(); }
            expect(store.approvals(prior.proposal_id)[0]?.created_at).toBe(time(0));
          }
          else expect(store.approveProposalByPolicy(prior.proposal_id, options(prior, time(0), {
            ...shared, name: history === "other_boundary" ? "separate_boundary" : shared.name,
            limits: [],
          })).approved).toBe(true);
          expect(store.automaticApprovalOutcomeDomain(shared.name)).toEqual({ complete: true, outcomes:
            ["other_human", "other_boundary"].includes(history) ? [] : [history === "other_automatic" ? "reserve_ops.review_claim" : outcome] });
          const candidate = await proposal(store, "wrp_diagnostic_next", "insurer-a", "second-person");
          const result = store.approveProposalByPolicy(candidate.proposal_id, options(candidate,
            time(history === "expired" ? 60.001 : history === "exact_start" ? 60 : 1), shared));
          const expected = !["same_automatic", "exact_start"].includes(history) && !(history === "other_automatic" && !filtered);
          expect(result.approved).toBe(expected);
          observations.push({ history, filtered, limits: shared.limits, approved: result.approved,
            tripped_limits: result.tripped_limits, prior_approvals: store.approvals(prior.proposal_id), candidate_approvals: store.approvals(candidate.proposal_id) });
        } finally { store.close(); }
      }
    }
    await saveObservation("counting-contract", observations);
  });

  it("preserves the inclusive rolling-window boundary, then releases capacity only after expiry", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-approval-window-"));
    const store = new ProposalStore(path.join(directory, "control.sqlite"));
    const limited = { ...boundary, limits: boundary.limits.map(l => ({ ...l, maximum: 1, window_seconds: 60 })) };
    try {
      const first = await proposal(store, "wrp_window_first");
      expect(store.approveProposalByPolicy(first.proposal_id, options(first, time(0), limited)).approved).toBe(true);
      const exact = await proposal(store, "wrp_window_exact");
      expect(store.approveProposalByPolicy(exact.proposal_id, options(exact, time(60), limited)).approved).toBe(false);
      const expired = await proposal(store, "wrp_window_expired");
      expect(store.approveProposalByPolicy(expired.proposal_id, options(expired, time(60.001), limited)).approved).toBe(true);
      expect(store.approvals(first.proposal_id)).toHaveLength(1);
      expect(store.approvals(exact.proposal_id)).toEqual([]);
    } finally { store.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });

  it("keeps semantic 24-hour limits rolling across UTC midnight and legacy day limits calendar-based", async () => {
    const store = new ProposalStore();
    const before = "2026-09-12T23:59:00.000Z", after = "2026-09-13T00:01:00.000Z";
    const decisions: Record<string, boolean[]> = {rolling: [], daily: []};
    try {
      for (const mechanism of ["rolling", "daily"] as const) for (const at of [before, after]) for (let i = 0; i < 3; i++) {
        const p = await proposal(store, `wrp_${mechanism}_${at === before ? "before" : "after"}_${i}`, mechanism);
        const o = mechanism === "rolling" ? options(p, at) : {
          policy: "explicit_daily", proposal_hash: p.proposal_hash, proposal_version: p.proposal_version, reason: "explicit day control",
          now: at, limits: [{kind: "count" as const, max: 3, period: "day" as const}],
        };
        decisions[mechanism]!.push(store.approveProposalByPolicy(p.proposal_id, o).approved);
      }
      expect(decisions.rolling).toEqual([true, true, true, false, false, false]);
      expect(decisions.daily).toEqual([true, true, true, true, true, true]);
      await saveObservation("midnight-mechanisms", {before, after, decisions,
        rolling: boundary.limits, daily: {period: "day", max: 3}, approvals: store.listProposals().flatMap(p => store.approvals(p.proposal_id))});
    } finally { store.close(); }
  });

  it("takes admission time after real cross-process SQLite writer exclusion", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-approval-serialization-"));
    const storePath = path.join(directory, "control.sqlite"), clockPath = path.join(directory, "trusted-clock.txt");
    const store = new ProposalStore(storePath);
    const children: ReturnType<typeof spawn>[] = [];
    try {
      for (let i = 0; i < 2; i++) { const p = await proposal(store, `wrp_history${i}`); store.approveProposalByPolicy(p.proposal_id, options(p, time(0))); }
      const contenders = await Promise.all([proposal(store, "wrp_slow"), proposal(store, "wrp_winner")]);
      await fs.writeFile(clockPath, time(1));
      // Child hooks observe existing BEGIN/COMMIT boundaries and control timing;
      // every proposal, count and approval is persisted by the actual store code.
      const script = `
        import fs from 'node:fs';
        const [moduleUrl, storePath, clockPath, role, id, opts] = process.argv.slice(1);
        const {ProposalStore}=await import(moduleUrl);
        const store=new ProposalStore(storePath);
        const RealDate=Date;
        globalThis.Date=class extends RealDate {
          constructor(...args){super(...(args.length?args:[fs.readFileSync(clockPath,'utf8')]));}
          static now(){return RealDate.parse(fs.readFileSync(clockPath,'utf8'));}
        };
        const wait=()=>fs.readSync(0,Buffer.alloc(1),0,1,null);
        const exec=store.db.exec.bind(store.db);
        store.db.exec=sql=>{
          if(role==='slow'&&sql==='BEGIN IMMEDIATE'){process.send({event:'before_begin'});wait();process.send({event:'begin_attempt'});}
          if(role==='winner'&&sql==='COMMIT'){process.send({event:'before_commit'});wait();}
          return exec(sql);
        };
        process.send({event:'ready'});wait();
        const result=store.approveProposalByPolicy(id,JSON.parse(opts));
        process.send({event:'result',approved:result.approved,proposal:result.proposal.state,approvals:store.approvals(id)});
        store.close();process.disconnect();
      `;
      const start = (role: string, p: StoredProposal) => {
        const child = spawn(process.execPath, ["--input-type=module", "-e", script,
          pathToFileURL(path.resolve("packages/proposal-store/dist/index.js")).href, storePath, clockPath, role, p.proposal_id, JSON.stringify(options(p))],
        { stdio: ["pipe", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH, NODE_NO_WARNINGS: "1" } });
        children.push(child);
        const events: Record<string, any>[] = [], changed = new Set<() => void>();
        let error = ""; child.stderr!.on("data", d => { error += d; });
        child.on("message", event => { events.push(event as Record<string, any>); for (const f of changed) f(); });
        const wait = (name: string) => new Promise<Record<string, any>>((resolve, reject) => {
          const timer = setTimeout(() => { changed.delete(check); reject(new Error(`${role}:${name} timed out: ${error}`)); }, 8000);
          const check = () => { const e = events.find(e => e.event === name); if(e){clearTimeout(timer);changed.delete(check);resolve(e);} };
          changed.add(check);check();
        });
        return { child, events, wait, release: () => child.stdin!.write("x") };
      };
      const slow = start("slow", contenders[0]!), winner = start("winner", contenders[1]!);
      await Promise.all([slow.wait("ready"), winner.wait("ready")]);
      slow.release(); await slow.wait("before_begin");
      await fs.writeFile(clockPath, time(2));
      winner.release(); await winner.wait("before_commit");
      // Winner holds the real SQLite write transaction, including its decision.
      slow.release(); await slow.wait("begin_attempt");
      expect(slow.events.some(e => e.event === "result")).toBe(false);
      await fs.writeFile(clockPath, time(3)); winner.release();
      expect(await winner.wait("result")).toMatchObject({ approved: true, proposal: "approved" });
      expect(await slow.wait("result")).toMatchObject({ approved: false, proposal: "pending_review", approvals: [] });
      expect(store.listProposals().flatMap(p => store.approvals(p.proposal_id))).toHaveLength(3);
      const denial = store.events("wrp_slow").find(e => e.kind === "policy_auto_approval_deferred");
      expect(denial?.payload.tripped_limits).toEqual([expect.objectContaining({ observed: 3, window_end: time(3) })]);
    } finally {
      for(const child of children) if(child.exitCode===null) child.kill();
      store.close(); await fs.rm(directory, { recursive: true, force: true });
    }
  }, 25000);
});

const postgresUrl = process.env.SYNAPSOR_TEST_POSTGRES_URL;
describe.skipIf(!postgresUrl)("PostgreSQL approval control store (local fixture)", () => {
  it.each(["insurer", "overall"] as const)("serializes the final %s slot across independent pools and commits only one event", async scope => {
    const connection = { connectionString: postgresUrl, connectionTimeoutMillis: 3000, statement_timeout: 10000 };
    const poolA = new Pool(connection), poolB = new Pool(connection);
    const schema = `approval_${randomUUID().replaceAll("-", "")}`;
    const firstLocked = deferred(), release = deferred(), secondContended = deferred();
    let armed = false, schemaCreated = false;
    const sequence: Array<{event: string; pool: string; at: string; approvals?: number}> = [];
    const observe = (event: string, first: boolean, approvals?: number) => sequence.push({event, pool: first ? "A" : "B", at: new Date().toISOString(), ...(approvals === undefined ? {} : {approvals})});
    const wrap = (pool: Pool, first: boolean): PostgresRuntimePool => ({
      query: (sql, values) => pool.query(sql, values),
      connect: async () => {
        const client = await pool.connect();
        return { release: () => client.release(), query: async (sql, values) => {
          const result = await client.query(sql, values);
          if (armed && sql.includes("pg_try_advisory_xact_lock")) {
            observe(result.rows[0]?.locked ? "writer_lock_acquired" : "writer_lock_wait", first);
            if (first && result.rows[0]?.locked) { firstLocked.resolve(); await release.promise; }
            if (!first && result.rows[0]?.locked === false) secondContended.resolve();
          }
          if (armed && sql.includes("SELECT") && sql.includes("ledger_entries") && !sql.includes("pg_try"))
            observe("fresh_ledger_materialized", first, result.rows.filter(row => row.kind === "approval").length);
          if (armed && sql === "COMMIT") observe("commit_acknowledged", first);
          return result;
        } } as PostgresRuntimeClient;
      },
    });
    const first = new PostgresProposalRuntimeStore({ pool: wrap(poolA, true), schema, autoMigrate: true });
    const second = new PostgresProposalRuntimeStore({ pool: wrap(poolB, false), schema, autoMigrate: true });
    const work: Array<Promise<unknown>> = [];
    try {
      const history = scope === "insurer" ? ["a", "a"] : ["a", "a", "a", "b", "b", "c", "c"];
      for (const [i, tenant] of history.entries()) {
        const p = await proposal(first, `wrp_pg_history${i}`, tenant);
        schemaCreated = true;
        expect((await first.approveProposalByPolicy(p.proposal_id, options(p))).approved).toBe(true);
      }
      const a = await proposal(first, "wrp_pg_first", scope === "insurer" ? "a" : "b", "person-one");
      const b = await proposal(second, "wrp_pg_second", scope === "insurer" ? "a" : "c", "person-two");
      armed = true;
      work.push(first.approveProposalByPolicy(a.proposal_id, options(a)));
      await Promise.race([firstLocked.promise, work[0]!.then(() => { throw new Error("First approval completed without the lock barrier"); })]);
      work.push(second.approveProposalByPolicy(b.proposal_id, options(b)));
      await Promise.race([secondContended.promise, work[1]!.then(() => { throw new Error("Second approval completed without database contention"); })]);
      release.resolve();
      const results = await Promise.all(work);
      expect(results).toMatchObject([{ approved: true }, { approved: false, proposal: { state: "pending_review" } }]);
      expect(await first.approvals(a.proposal_id)).toHaveLength(1);
      expect(await second.approvals(b.proposal_id)).toEqual([]);
      const durable = await poolA.query(`SELECT payload_json FROM "${schema}".ledger_entries WHERE kind='approval'`);
      expect(durable.rows).toHaveLength(history.length + 1);
      armed = false;
      const winner = (await first.approvals(a.proposal_id))[0]!;
      const denial = (await second.events(b.proposal_id)).find(e => e.kind === "policy_auto_approval_deferred")!;
      const lockA = sequence.find(e => e.pool === "A" && e.event === "writer_lock_acquired")!;
      const lockB = sequence.find(e => e.pool === "B" && e.event === "writer_lock_acquired")!;
      expect(Date.parse(winner.created_at)).toBeGreaterThanOrEqual(Date.parse(lockA.at));
      expect(denial.payload.tripped_limits).toEqual(expect.arrayContaining([expect.objectContaining({id: scope,
        observed: scope === "insurer" ? 3 : 8, window_end: expect.any(String)})]));
      const windowEnd = (denial.payload.tripped_limits as Array<{window_end: string}>)[0]!.window_end;
      expect(Date.parse(windowEnd)).toBeGreaterThanOrEqual(Date.parse(lockB.at));
      expect(Date.parse(windowEnd)).toBeGreaterThanOrEqual(Date.parse(winner.created_at));
      expect(sequence.find(e => e.pool === "B" && e.event === "fresh_ledger_materialized")?.approvals).toBe(history.length + 1);
      await saveObservation(`pg-last-${scope}`, {schema, sequence, caller_now_override: false, results, durable_approvals: durable.rows, denial});
    } finally {
      release.resolve();
      await Promise.allSettled(work);
      try {
        await first.close(); await second.close();
        if (schemaCreated) await poolA.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally { await Promise.all([poolA.end(), poolB.end()]); }
    }
  }, 25000);
  it("grants ample concurrent capacity, rolls back a definite pre-COMMIT failure, and preserves decisions on retry and restart", async () => {
    const schema = `approval_control_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({connectionString: postgresUrl, connectionTimeoutMillis: 3000, statement_timeout: 10000});
    let failBeforeCommit = false;
    const sequence: unknown[] = [];
    const wrapped: PostgresRuntimePool = {query: (sql, values) => pool.query(sql, values), connect: async () => {
      const client = await pool.connect();
      return {release: () => client.release(), query: async (sql, values) => {
        if (failBeforeCommit && sql === "COMMIT") {failBeforeCommit = false; sequence.push("injected definite failure before COMMIT submission"); throw new Error("owned_pre_commit_failure");}
        const result = await client.query(sql, values); if (sql === "ROLLBACK") sequence.push("ROLLBACK acknowledged"); return result;
      }} as PostgresRuntimeClient;
    }};
    const stores = [new PostgresProposalRuntimeStore({pool: wrapped, schema, autoMigrate: true})];
    const peers = Array.from({length: 3}, () => new Pool({connectionString: postgresUrl, connectionTimeoutMillis: 3000}));
    stores.push(...peers.map(pool => new PostgresProposalRuntimeStore({pool, schema, autoMigrate: true})));
    try {
      const ps = [];
      for (let i = 0; i < 4; i++) ps.push(await proposal(stores[i]!, `wrp_ample${i}`, `insurer-${i}`));
      const concurrent = await Promise.all(ps.map((p, i) => stores[i]!.approveProposalByPolicy(p.proposal_id, options(p))));
      expect(concurrent.every(r => r.approved)).toBe(true);
      const retry = await proposal(stores[0]!, "wrp_rollback", "insurer-retry");
      failBeforeCommit = true;
      await expect(stores[0]!.approveProposalByPolicy(retry.proposal_id, options(retry))).rejects.toThrow("owned_pre_commit_failure");
      expect(await stores[1]!.approvals(retry.proposal_id)).toEqual([]);
      expect(await stores[1]!.getProposal(retry.proposal_id)).toMatchObject({state: "pending_review"});
      expect((await stores[0]!.approveProposalByPolicy(retry.proposal_id, options(retry))).approved).toBe(true);
      await expect(stores[0]!.approveProposalByPolicy(retry.proposal_id, options(retry))).rejects.toMatchObject({code: "PROPOSAL_NOT_PENDING_REVIEW"});
      await Promise.all(stores.map(store => store.close()));
      const restartedPool = new Pool({connectionString: postgresUrl, connectionTimeoutMillis: 3000});
      const restarted = new PostgresProposalRuntimeStore({pool: restartedPool, schema, autoMigrate: false});
      try {
        const approvals = [];
        for (const p of await restarted.listProposals()) approvals.push(...await restarted.approvals(p.proposal_id));
        expect(approvals).toHaveLength(5);
        expect(await restarted.receipts(retry.proposal_id)).toEqual([]);
        const sequential = await proposal(restarted, "wrp_sequential", "insurer-sequential");
        expect((await restarted.approveProposalByPolicy(sequential.proposal_id, options(sequential))).approved).toBe(true);
        await saveObservation("pg-controls", {concurrent, sequence, approvals_after_restart: approvals,
          sequential: await restarted.approvals(sequential.proposal_id), uncertain_commit_recovery: "unrun", clock: "ordinary default"});
      } finally { await restarted.close(); await restartedPool.end(); }
    } finally {
      await Promise.all(stores.map(store => store.close()));
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await Promise.all([pool.end(), ...peers.map(pool => pool.end())]);
    }
  }, 30000);

});
