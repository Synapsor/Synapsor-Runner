import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(root, "apps", "runner");
const specPackageDir = path.join(root, "packages", "spec");
const packageJson = JSON.parse(await fs.readFile(path.join(packageDir, "package.json"), "utf8"));
const expectedVersion = packageJson.version;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-packed-lifecycle-"));
let tarball;

try {
  run("corepack", ["pnpm", "build:runner-package"], { cwd: root });
  const specPack = run("corepack", ["pnpm", "pack", "--pack-destination", tempDir], { cwd: specPackageDir });
  const specPackedName = specPack.stdout.trim().split(/\r?\n/).findLast((line) => line.endsWith(".tgz"));
  assert(specPackedName, "pnpm pack did not return a Spec tarball filename", specPack.stdout);
  const specTarball = path.join(tempDir, path.basename(specPackedName));
  const pack = run("corepack", ["pnpm", "pack", "--pack-destination", tempDir], { cwd: packageDir });
  const packedName = pack.stdout.trim().split(/\r?\n/).findLast((line) => line.endsWith(".tgz"));
  assert(packedName, "pnpm pack did not return a tarball filename", pack.stdout);
  tarball = path.join(tempDir, path.basename(packedName));

  const entries = run("tar", ["-tzf", tarball]).stdout.trim().split(/\r?\n/);
  assert(entries.includes("package/docs/store-lifecycle.md"), "packed Runner is missing docs/store-lifecycle.md");
  assert(entries.includes("package/docs/dsl-reference.md"), "packed Runner is missing docs/dsl-reference.md");
  assert(entries.includes("package/docs/proposal-evidence-freshness.md"),
    "packed Runner is missing docs/proposal-evidence-freshness.md");
  const forbiddenEntry = entries.find((entry) => /(^|\/)(?:development|\.synapsor)(?:\/|$)|\.(?:db|db-wal|db-shm|log)$|mcp-audit\.sarif$/i.test(entry));
  assert(!forbiddenEntry, "packed Runner contains development or runtime state", forbiddenEntry);

  run("npm", ["init", "-y"], { cwd: tempDir });
  run("npm", ["install", specTarball, tarball], { cwd: tempDir });
  const packedRoot = path.join(tempDir, "node_modules", "@synapsor", "runner");
  const cli = path.join(packedRoot, "dist", "cli.js");
  const installed = JSON.parse(await fs.readFile(path.join(packedRoot, "package.json"), "utf8"));
  assert(installed.version === expectedVersion, "scratch install has the wrong Runner version", installed.version);

  const help = runPacked(cli, ["lifecycle", "--help"]);
  assert(help.stdout.includes("lifecycle show latest"), "packed lifecycle help omits no-ID latest inspection", help.stdout);
  assert(help.stdout.includes("receipt:<numeric-id>"), "packed lifecycle help omits typed numeric handles", help.stdout);
  assert(help.stdout.includes("does not materialize replay records"), "packed lifecycle help does not state its read-only behavior", help.stdout);
  const proposalHelp = runPacked(cli, ["proposals", "--help"]);
  assert(proposalHelp.stdout.includes("proposals check-freshness latest"),
    "packed proposal help omits no-ID freshness inspection", proposalHelp.stdout);
  assert(proposalHelp.stdout.includes("apply rechecks again before mutation"),
    "packed proposal help overstates approval-time freshness", proposalHelp.stdout);

  const stateContainer = path.join(tempDir, "try-state");
  const proof = runPacked(cli, ["try", "--prove", "--json", "--yes", "--no-open", "--state-dir", stateContainer], {}, { timeout: 30000 });
  const proofResult = JSON.parse(proof.stdout);
  assert(proofResult.ok === true, "packed try proof did not complete", proofResult);
  assert(proofResult.paths?.root === path.join(stateContainer, ".synapsor-try"), "try did not preserve the caller-owned state container", proofResult.paths);
  const storePath = proofResult.paths?.ledger;
  assert(typeof storePath === "string" && path.isAbsolute(storePath), "try did not return an absolute ledger path", proofResult.paths);

  const before = sqliteTableCounts(storePath);
  const freshness = lifecycleJson(cli, [
    "proposals", "check-freshness", "latest", "--json", "--store", storePath,
  ]);
  assert(freshness.schema_version === "synapsor.proposal-freshness-result.v1",
    "packed freshness inspection has the wrong schema version", freshness);
  assert(freshness.required === false && freshness.status === "not_required" &&
    freshness.safe_code === "FRESHNESS_NOT_REQUIRED",
  "packed freshness inspection changed legacy proposal behavior", freshness);
  assert(JSON.stringify(sqliteTableCounts(storePath)) === JSON.stringify(before),
    "not-required freshness inspection changed durable SQLite row counts",
    { before, after: sqliteTableCounts(storePath) });
  const bare = lifecycleJson(cli, ["lifecycle", "--json", "--store", storePath]);
  const show = lifecycleJson(cli, ["lifecycle", "show", "--json", "--store", storePath]);
  const latest = lifecycleJson(cli, ["lifecycle", "show", "latest", "--json", "--store", storePath]);
  assert(JSON.stringify(bare) === JSON.stringify(show) && JSON.stringify(show) === JSON.stringify(latest),
    "bare/show/latest lifecycle selection is not equivalent", { bare, show, latest });
  assert(bare.schema_version === "synapsor.lifecycle-view.v1", "packed lifecycle view has the wrong schema version", bare.schema_version);
  assert(bare.selection?.mode === "latest" && bare.selection?.match_count >= 2,
    "packed lifecycle did not select the deterministic latest try proposal", bare.selection);
  assert(bare.proposal?.capability === proofResult.capability,
    "packed lifecycle selected a proposal outside the try capability", bare.proposal);
  assert(bare.evidence?.count >= 1, "packed lifecycle omitted proposal evidence", bare.evidence);
  assert(bare.writeback?.receipts?.length >= 1, "packed lifecycle omitted writeback receipts", bare.writeback);
  assert(bare.replay?.replay_id, "packed lifecycle omitted replay linkage", bare.replay);
  const renderedLifecycle = JSON.stringify(bare);
  assert(!renderedLifecycle.includes("internal_risk_note") && !renderedLifecycle.includes("internal_agent_note"),
    "packed lifecycle exposed fields kept out of the synthetic evidence projection", bare.evidence);

  const proposalView = lifecycleJson(cli, ["lifecycle", "show", proofResult.proposal.proposal_id, "--json", "--store", storePath]);
  assert(proposalView.selection?.handle_kind === "proposal", "proposal handle did not resolve through lifecycle", proposalView.selection);
  const evidenceView = lifecycleJson(cli, ["lifecycle", "show", proofResult.evidence.evidence_bundle_id, "--json", "--store", storePath]);
  assert(evidenceView.selection?.handle_kind === "evidence", "evidence handle did not resolve through lifecycle", evidenceView.selection);
  const replayView = lifecycleJson(cli, ["lifecycle", "show", bare.replay.replay_id, "--json", "--store", storePath]);
  assert(replayView.selection?.handle_kind === "replay", "replay handle did not resolve through lifecycle", replayView.selection);

  const list = lifecycleJson(cli, ["lifecycle", "list", "--tenant", "acme", "--capability", proofResult.capability, "--json", "--store", storePath]);
  assert(list.schema_version === "synapsor.lifecycle-list.v1", "packed lifecycle list has the wrong schema version", list.schema_version);
  assert(list.lifecycles?.some((proposal) => proposal.proposal_id === proofResult.proposal.proposal_id),
    "packed lifecycle filters omitted the expected proposal", list);
  assert(JSON.stringify(sqliteTableCounts(storePath)) === JSON.stringify(before),
    "lifecycle inspection changed durable SQLite row counts", { before, after: sqliteTableCounts(storePath) });

  const sourceDsl = await fs.readFile(path.join(root, "packages", "dsl", "examples", "billing-late-fee.synapsor.sql"), "utf8");
  const exactPath = path.join(tempDir, "exact.synapsor.sql");
  const exactOut = path.join(tempDir, "exact.contract.json");
  await fs.writeFile(exactPath, sourceDsl, "utf8");
  runPacked(cli, ["dsl", "validate", exactPath]);
  runPacked(cli, ["dsl", "compile", exactPath, "--out", exactOut]);
  const exactContract = JSON.parse(await fs.readFile(exactOut, "utf8"));
  const exactProposal = exactContract.capabilities.find((capability) => capability.name === "billing.propose_late_fee_waiver");
  assert(exactProposal?.proposal?.conflict_guard?.column === "updated_at", "packed DSL lost the exact version-column guard", exactProposal);

  const marker = "CREATE CAPABILITY billing.propose_late_fee_waiver";
  const missingPath = path.join(tempDir, "missing-guard.synapsor.sql");
  await fs.writeFile(missingPath, rewriteProposalGuard(sourceDsl, marker, ""), "utf8");
  const missing = runPacked(cli, ["dsl", "validate", missingPath], {}, { allowFailure: true });
  assert(missing.status !== 0 && combined(missing).includes("UPDATE_CONFLICT_GUARD_REQUIRED"),
    "packed DSL accepted an UPDATE without an exact or acknowledged weak guard", combined(missing));

  const weakPath = path.join(tempDir, "weak.synapsor.sql");
  const weakOut = path.join(tempDir, "weak.contract.json");
  await fs.writeFile(weakPath, rewriteProposalGuard(sourceDsl, marker, "  CONFLICT GUARD WEAK ROW HASH ACKNOWLEDGED\n"), "utf8");
  const weak = runPacked(cli, ["dsl", "validate", weakPath]);
  assert(combined(weak).includes("WEAK_CONFLICT_GUARD_ACKNOWLEDGED"), "packed DSL did not warn for the explicit weak guard", combined(weak));
  runPacked(cli, ["dsl", "compile", weakPath, "--out", weakOut]);
  const weakContract = JSON.parse(await fs.readFile(weakOut, "utf8"));
  const weakProposal = weakContract.capabilities.find((capability) => capability.name === "billing.propose_late_fee_waiver");
  assert(weakProposal?.proposal?.conflict_guard?.weak_guard_ack === true, "packed DSL did not preserve the weak-guard acknowledgement", weakProposal);

  const sessionPath = path.join(tempDir, "session.synapsor.sql");
  const sessionOut = path.join(tempDir, "session.contract.json");
  await fs.writeFile(sessionPath, sourceDsl.replace(
    "BIND tenant_id FROM ENVIRONMENT SYNAPSOR_TENANT_ID REQUIRED",
    "BIND tenant_id FROM SESSION tenant_id REQUIRED",
  ), "utf8");
  const session = runPacked(cli, ["dsl", "compile", sessionPath, "--out", sessionOut], {}, { allowFailure: true });
  assert(session.status !== 0 && combined(session).includes("SESSION_BINDING_UNSUPPORTED"),
    "packed Runner compiled a canonical SESSION binding through its unsupported runtime target", combined(session));
  await assertMissing(sessionOut, "packed Runner wrote a contract after rejecting SESSION binding");

  const lifecycleDoc = await fs.readFile(path.join(packedRoot, "docs", "store-lifecycle.md"), "utf8");
  const dslDoc = await fs.readFile(path.join(packedRoot, "docs", "dsl-reference.md"), "utf8");
  const freshnessDoc = await fs.readFile(path.join(packedRoot, "docs", "proposal-evidence-freshness.md"), "utf8");
  assert(lifecycleDoc.includes("synapsor.lifecycle-view.v1") && lifecycleDoc.includes("lifecycle show latest"),
    "packed lifecycle documentation is stale");
  assert(dslDoc.includes("CONFLICT GUARD WEAK ROW HASH ACKNOWLEDGED") && dslDoc.includes("SESSION_BINDING_UNSUPPORTED"),
    "packed DSL documentation is stale");
  assert(/approval-time freshness can never replace\s+apply-time concurrency control/i.test(freshnessDoc) &&
    freshnessDoc.includes("proposals check-freshness latest"),
  "packed proposal freshness documentation is stale");

  process.stdout.write(`Packed Runner ${expectedVersion} lifecycle and DSL behavior verified:\n`);
  process.stdout.write("- no-ID lifecycle inspection and typed proposal/evidence/replay handles resolve\n");
  process.stdout.write("- no-ID freshness inspection preserves legacy not-required behavior without mutating the ledger\n");
  process.stdout.write("- lifecycle JSON is stable and inspection leaves every SQLite row count unchanged\n");
  process.stdout.write("- exact UPDATE guards are preserved and omitted guards fail closed\n");
  process.stdout.write("- weak row-hash guards require an explicit acknowledgement and warning\n");
  process.stdout.write("- Runner rejects canonical SESSION bindings it cannot implement\n");
  process.stdout.write("- lifecycle/DSL docs ship in the installed tarball without development state\n");
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
  if (tarball) await fs.rm(tarball, { force: true });
}

function lifecycleJson(cli, args) {
  return JSON.parse(runPacked(cli, args).stdout);
}

function rewriteProposalGuard(source, marker, replacement) {
  const index = source.indexOf(marker);
  assert(index >= 0, "DSL fixture is missing its proposal capability marker");
  const head = source.slice(0, index);
  const tail = source.slice(index);
  const exact = "  CONFLICT GUARD updated_at\n";
  assert(tail.includes(exact), "DSL fixture proposal is missing its exact guard");
  return `${head}${tail.replace(exact, replacement)}`;
}

function sqliteTableCounts(storePath) {
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return Object.fromEntries(tables.map(({ name }) => {
      const quoted = `"${String(name).replaceAll('"', '""')}"`;
      const row = db.prepare(`SELECT COUNT(*) AS count FROM ${quoted}`).get();
      return [name, Number(row.count)];
    }));
  } finally {
    db.close();
  }
}

function runPacked(cli, args, env = {}, options = {}) {
  return run(process.execPath, [cli, ...args], {
    cwd: tempDir,
    env: { ...process.env, NO_COLOR: "1", ...env },
    ...options,
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: options.env ?? process.env,
    encoding: "utf8",
    timeout: options.timeout ?? 120000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${combined(result)}`);
  }
  return result;
}

function combined(result) {
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

function assert(condition, message, detail) {
  if (condition) return;
  throw new Error(`${message}${detail === undefined ? "" : `\n${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`}`);
}

async function assertMissing(filePath, message) {
  try {
    await fs.stat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(message);
}
