import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { ProposalStore, PostgresProposalRuntimeStore, type ProposalRuntimeStore, type ActionBoundaryApprovalContext,
  type PostgresRuntimeClient, type PostgresRuntimePool, type StoredProposal } from "./index.js";

const outcome = "reserve_ops.adjust_claim_reserve";
const boundary: ActionBoundaryApprovalContext = { name: "reviewed_insurance", digest: `sha256:${"a".repeat(64)}`, limits: [
  { id: "overall", kind: "count", scope: "capability", capability: outcome, maximum: 8, window_seconds: 86400 },
  { id: "insurer", kind: "count", scope: "tenant", capability: outcome, maximum: 3, window_seconds: 86400 },
] };
const time = (second: number) => new Date(Date.parse("2026-09-12T12:00:00.000Z") + second * 1000).toISOString();

async function proposal(store: ProposalRuntimeStore, id: string, tenant = "insurer-a", principal = "adjuster-a") {
  const input = JSON.parse(await fs.readFile(new URL("../../../fixtures/protocol/change-set.late-fee-waiver.v1.json", import.meta.url), "utf8"));
  input.proposal_id = id; input.action = outcome; input.principal.id = principal;
  input.scope.tenant_id = tenant; input.guards.tenant.value = tenant;
  input.scope.object_id = id; input.source.primary_key.value = id;
  input.integrity.proposal_hash = `sha256:${id}`;
  return await store.createProposal(input);
}
function options(p: StoredProposal, now?: string, action_boundary = boundary) {
  return { policy: "reviewed_policy", proposal_hash: p.proposal_hash, proposal_version: p.proposal_version,
    reason: "eligible synthetic local fixture", action_boundary, ...(now ? { now } : {}) };
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
    const wrap = (pool: Pool, first: boolean): PostgresRuntimePool => ({
      query: (sql, values) => pool.query(sql, values),
      connect: async () => {
        const client = await pool.connect();
        return { release: () => client.release(), query: async (sql, values) => {
          const result = await client.query(sql, values);
          if (armed && sql.includes("pg_try_advisory_xact_lock")) {
            if (first && result.rows[0]?.locked) { firstLocked.resolve(); await release.promise; }
            if (!first && result.rows[0]?.locked === false) secondContended.resolve();
          }
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
    } finally {
      release.resolve();
      await Promise.allSettled(work);
      try {
        await first.close(); await second.close();
        if (schemaCreated) await poolA.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally { await Promise.all([poolA.end(), poolB.end()]); }
    }
  }, 25000);
});
