#!/usr/bin/env node

// Opt-in live-model qualification. All rows and authority belong to this disposable project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { inspectDatabase } from "../packages/schema-inspector/dist/index.js";
import { ProposalStore } from "../packages/proposal-store/dist/index.js";
import { AUTO_BOUNDARY_OVERRIDES_VERSION, buildAutoBoundary, writeAutoBoundaryArtifacts, activateExplorationBoundary, explorationBoundaryCandidateDigest } from "../apps/runner/dist/auto-boundary.js";
import { buildActionRuleAuthoringCatalog } from "../apps/runner/dist/action-rule-authoring.js";
import { generateModelActionRuleDraft } from "../apps/runner/dist/action-rule-model.js";
import { planModelBoundaryJob } from "../apps/runner/dist/boundary-job-model.js";
import { createModelAuthoringConversation } from "../apps/runner/dist/model-authoring-conversation.js";
import { newPolicySourceSession, policyTextSnapshot, authoringDestination } from "../apps/runner/dist/authoring-policy-source.js";
import { buildActionRuleAuthorityDraft, writeActionRuleAuthorityDraft, activateActionRuleAuthority, deactivateActionRuleAuthority, mergeActionRuleAuthorityDraft, readActionRuleAuthorityActivation } from "../apps/runner/dist/action-rule-authority.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-multi-action-client-"));
const composeProject = `synapsor-multi-action-${process.pid}`;
const composeFile = path.join(root, "examples/runner-fleet/docker-compose.yml");
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
});
const env = { ...process.env, SYNAPSOR_FLEET_POSTGRES_PORT: String(port),
  DATABASE_URL: `postgresql://ux_reader:ux_reader_password@127.0.0.1:${port}/synapsor_fleet`,
  SYNAPSOR_TENANT_ID: "account_a", SYNAPSOR_PRINCIPAL: "customer_a" };
delete env.SYNAPSOR_CONTROL_DATABASE_URL;
delete env.SYNAPSOR_LOCAL_STORE;
const session = { provider: "openai", model: process.env.SYNAPSOR_TEST_MODEL ?? "gpt-5.6-terra", conversation: createModelAuthoringConversation() };
const rules = [
  "Prepare TWO independent customer-service behaviors, reusing the reviewed customer Read access.",
  "Close the selected open support case by setting only its status to closed. Closed cases are ineligible.",
  "Submit the selected new billing dispute by setting only its status to submitted. Already-submitted disputes are ineligible.",
  "Both concern only the authenticated customer's records. Use version to detect stale records. Each request needs one customer_service reviewer. Keep execution off; this test requests proposals, not automatic completion.",
].join("\n");
const source = policyTextSnapshot(Buffer.from(rules), "customer-service-rules.txt");
session.conversation.policySources = newPolicySourceSession();
session.conversation.policySources.snapshots.push(source);
session.conversation.policySources.active = 1;
session.conversation.policySources.approvals.push({ digest: source.digest, destination: authoringDestination(session) });
let admin;
let client;
let stderr = "";
let stage = "fixture";
function compose(args, optional = false) {
  const result = spawnSync("docker", ["compose", "-p", composeProject, "-f", composeFile, ...args], { cwd: root, env, encoding: "utf8" });
  if (!optional) assert.equal(result.status, 0, result.stderr);
}
function body(result) {
  return result.structuredContent ?? JSON.parse(result.content.find((entry) => entry.type === "text").text);
}
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  return body(result);
}
async function publish(compiled) {
  let draft = await readActionRuleAuthorityActivation(project);
  for (const entry of compiled) {
    const incoming = buildActionRuleAuthorityDraft({ name: "customer_service_actions", action_boundary_name: "customer_service_actions", catalog: entry.loaded.authority.catalog,
      rules: [{ read_boundary_name: read.pack.name, read_boundary_digest: read.activation.digest,
        verification_boundary: entry.verification_boundary, effect_envelope: entry.effect_envelope, rule: entry.rule }],
      approval_classes: [entry.approval_class], reviews: [{ ...entry.review, outcome: entry.rule.outcome }],
    });
    draft = mergeActionRuleAuthorityDraft({ existing: draft, incoming });
  }
  await writeActionRuleAuthorityDraft(project, draft);
  await activateActionRuleAuthority({ projectRoot: project, name: draft.authority.name, expected_digest: draft.digest,
    confirmation: `ACTIVATE ${draft.digest}`, actor: "disposable integration-test operator" });
}
let read;
try {
  assert.ok(process.env.OPENAI_API_KEY, "Set OPENAI_API_KEY for this opt-in live test.");
  compose(["up", "-d", "--wait", "postgres"]);
  admin = new pg.Pool({ connectionString: `postgresql://synapsor_admin:synapsor_admin_password@127.0.0.1:${port}/synapsor_fleet`, max: 1 });
  await admin.query("CREATE ROLE ux_reader LOGIN PASSWORD 'ux_reader_password'");
  await admin.query("CREATE SCHEMA customer_service");
  await admin.query(`CREATE TABLE customer_service.support_cases (
    case_id varchar(40) PRIMARY KEY, tenant_id varchar(40) NOT NULL, principal_id varchar(40) NOT NULL,
    case_number varchar(30) NOT NULL, status varchar(16) NOT NULL CHECK (status IN ('open','closed')), version integer NOT NULL);
    CREATE TABLE customer_service.billing_disputes (
    dispute_id varchar(40) PRIMARY KEY, tenant_id varchar(40) NOT NULL, principal_id varchar(40) NOT NULL,
    invoice_number varchar(30) NOT NULL, status varchar(16) NOT NULL CHECK (status IN ('new','submitted')), version integer NOT NULL);
    CREATE TABLE customer_service.communication_preferences (
    preference_id varchar(40) PRIMARY KEY, tenant_id varchar(40) NOT NULL, principal_id varchar(40) NOT NULL,
    channel varchar(16) NOT NULL CHECK (channel IN ('email','sms')), version integer NOT NULL);
    GRANT USAGE ON SCHEMA customer_service TO ux_reader;
    GRANT SELECT ON ALL TABLES IN SCHEMA customer_service TO ux_reader;
    INSERT INTO customer_service.support_cases VALUES
      ('case_a','account_a','customer_a','CASE-001','open',1),
      ('case_closed','account_a','customer_a','CASE-002','closed',1),
      ('case_foreign','account_b','customer_b','PRIVATE-CASE','open',1);
    INSERT INTO customer_service.billing_disputes VALUES ('dispute_a','account_a','customer_a','INV-001','new',1);
    INSERT INTO customer_service.communication_preferences VALUES ('preference_a','account_a','customer_a','email',1);`);
  const before = (await admin.query("SELECT * FROM customer_service.support_cases ORDER BY case_id")).rows;
  const inspection = await inspectDatabase({ databaseUrlEnv: "DATABASE_URL", schema: "customer_service", env });
  const decision = { actor: "disposable integration-test operator", reason: "Reviewed fixture schema and customer identity bindings.", decided_at: new Date().toISOString() };
  const overrides = { schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION, resources: Object.fromEntries(inspection.tables.map((table) => [`${table.schema}.${table.name}`, {
    row_identity: { ...decision, value: table.primary_key[0] }, tenant_key: { ...decision, value: "tenant_id" }, principal_key: { ...decision, value: "principal_id" },
    fields: Object.fromEntries(table.columns.map((column) => [column.name, { ...decision, exposure: [table.primary_key[0], "tenant_id", "principal_id", "version"].includes(column.name) ? "withhold_from_model" : "allow_reviewed_use" }])) }])) };
  const build = buildAutoBoundary({ inspection, project: { root: project, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] }, sourceEnv: "DATABASE_URL", overrides });
  await writeAutoBoundaryArtifacts({ projectRoot: project, build });
  const candidate = build.exploration_boundary;
  const digest = explorationBoundaryCandidateDigest(candidate);
  read = await activateExplorationBoundary({ projectRoot: project, candidate, expectedDigest: digest, confirmation: `ACTIVATE ${digest}`,
    actor: "disposable integration-test operator", confirmedDecisions: candidate.unresolved_decisions, currentInspection: inspection });
  const builtCatalog = buildActionRuleAuthoringCatalog({ boundary: candidate, inspection });
  const configPath = path.join(project, "synapsor.actions.runner.json");
  const config = { version: 1, mode: "review", storage: { sqlite_path: "./.synapsor/local.db" },
    sources: { [read.source]: { engine: "postgres", read_url_env: "DATABASE_URL", receipts: { authority: "runner_ledger" } } },
    trusted_context: { provider: "static_dev", values: { tenant_id: "account_a", principal: "customer_a" } },
    contexts: { trusted_context: { provider: "static_dev", values: { tenant_id: "account_a", principal: "customer_a" } } },
    capabilities: [], action_rules: { project_root: project } };
  await fs.writeFile(configPath, JSON.stringify(config));
  await fs.writeFile(path.join(project, "synapsor.runner.json"), JSON.stringify(config));
  const configBefore = await fs.readFile(configPath, "utf8");
  stage = "connect once, before any Action activation";
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", import.meta.resolve("tsx"), path.join(root, "apps/runner/src/cli.ts"), "mcp", "serve", "--authoring", "--project-root", project], cwd: project, env, stderr: "pipe" });
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  client = new Client({ name: "multi-behavior-qualified-client", version: "1" });
  await client.connect(transport);
  const toolNames = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ["app.describe_actions", "app.describe_data", "app.explore_data", "app.request_change"]);
  assert.equal((await call("app.describe_actions")).actions.length, 0);
  const common = { session, builtCatalog, readBoundary: candidate, readBoundaryDigest: read.activation.digest, egressAcknowledged: true };
  stage = "model plans two independent actions from one document";
  const plan = await planModelBoundaryJob({ session, jobIntent: "Prepare the two behaviors in the attached customer-service rules, keeping existing Read access unchanged.",
    currentState: { read: { boundary_name: read.pack.name, authority: "active", fully_reviewed: true, resource_ids: read.pack.resources.map((entry) => entry.id), exact_reusable_revision_count: 1 }, actions: [],
      control_plane: { trusted_scope: "runner_injected", approval_history: "runner_proposal_ledger", model_may_supply_scope_values: false, model_may_supply_approval_history: false } },
    availableResourceIds: read.pack.resources.map((entry) => entry.id), egressAcknowledged: true });
  assert.equal(plan.state, "planned", JSON.stringify(plan));
  assert.equal(plan.action_intents?.length, 2, JSON.stringify(plan));
  const compiled = [];
  let clarificationCount = 0;
  let noChangeAnswered = false;
  const askClarification = async (question) => {
    assert.ok(++clarificationCount <= 3, "Model repeated already-specified business questions.");
    process.stdout.write(`BUSINESS QUESTION: ${question}\n`);
    if (/no.change|differs? from|already matches/iu.test(question)) {
      assert.equal(noChangeAnswered, false, "Do not repeat an answered business question.");
      noChangeAnswered = true;
      return "Refuse a communication-preference request when the requested channel already matches the current channel. Require the selected email or sms value to differ from the current channel; keep the other two actions unchanged.";
    }
    return "Use version as the conflict guard, one customer_service reviewer, and no execution. These are independent actions, not exception branches. Keep the other action unchanged. The selected record supplies the target, not a caller-supplied ID.";
  };
  for (const intent of plan.action_intents) {
    const result = await generateModelActionRuleDraft({ ...common, intent, preparedDrafts: compiled.map((entry) => entry.draft), reservedOutcomes: compiled.map((entry) => entry.rule.outcome), askClarification });
    compiled.push(result.compiled);
  }
  assert.equal(new Set(compiled.map((entry) => entry.effect_envelope.target_resource)).size, 2);
  await publish(compiled);
  stage = "same client discovers and successfully requests both actions";
  let catalog = await call("app.describe_actions");
  assert.equal(catalog.actions.length, 2);
  async function reference(action, select, matches = () => true) {
    const subject = action.subjects[0];
    assert.equal(action.subjects.length, 1);
    const result = await call("app.explore_data", { plan: { kind: "rows", resource: subject.resource, select, limit: 10 } });
    assert.ok(!JSON.stringify(result).includes("PRIVATE-CASE"), "Cross-customer row leaked.");
    const rowIndex = result.data.findIndex(matches);
    assert.ok(rowIndex >= 0, "The expected customer record is readable.");
    const ref = result.subjects?.find((entry) => entry.row_index === rowIndex)?.ref;
    assert.match(ref ?? "", /^obj_/);
    return { [subject.binding]: ref };
  }
  async function request(action, select, inputs) {
    const args = { outcome: action.outcome,
      subject_refs: await reference(action, select, (row) => row.status !== "closed"), ...(inputs ? { inputs } : {}) };
    const result = await call("app.request_change", args);
    assert.equal(result.status, "pending_human_review", JSON.stringify(result));
    assert.equal(result.request_disposition, "created");
    assert.equal(result.source_database_changed, false);
    assert.notEqual(result.execution, "completed");
    const retry = await call("app.request_change", args);
    assert.equal(retry.status, "pending_human_review", JSON.stringify(retry));
    assert.equal(retry.request_disposition, "already_recorded");
    return args;
  }
  for (const action of catalog.actions) {
    assert.equal(action.inputs.length, 0, `Fixed effects must not invent customer inputs: ${JSON.stringify(action)}`);
    assert.ok(action.request_shape.subject_refs[action.subjects[0].binding]);
    const isCase = action.subjects[0].resource.endsWith(".support_cases");
    await request(action, [isCase ? "case_number" : "invoice_number", "status"]);
  }
  const closeCase = catalog.actions.find((action) => action.subjects[0].resource.endsWith(".support_cases"));
  assert.ok(closeCase);
  const ineligible = await client.callTool({ name: "app.request_change", arguments: {
    outcome: closeCase.outcome,
    subject_refs: await reference(closeCase, ["case_number", "status"], (row) => row.case_number === "CASE-002"),
  } });
  assert.ok(ineligible.isError || body(ineligible).authorization?.eligibility !== "verified", JSON.stringify(ineligible));
  stage = "add third behavior without client reconfiguration";
  const third = await generateModelActionRuleDraft({ ...common,
    intent: "Add a THIRD independent behavior: let the customer change only channel on their selected customer_service.communication_preferences record to email or sms, chosen through a required typed business input. Use version for conflicts, one customer_service reviewer, no execution. Preserve both existing case-close and dispute-submit outcomes unchanged.",
    preparedDrafts: compiled.map((entry) => entry.draft), reservedOutcomes: compiled.map((entry) => entry.rule.outcome), askClarification });
  assert.equal(third.compiled.rule.inputs.length, 1);
  await publish([third.compiled]);
  catalog = await call("app.describe_actions");
  assert.equal(catalog.actions.length, 3);
  const added = catalog.actions.find((entry) => entry.outcome === third.compiled.rule.outcome);
  assert.ok(added);
  assert.equal(added.inputs.length, 1);
  const args = await request(added, ["channel"], { [added.inputs[0].name]: "sms" });
  const malformed = await client.callTool({ name: "app.request_change", arguments: { ...args, inputs: { [added.inputs[0].name]: "arbitrary" } } });
  assert.equal(malformed.isError, true, JSON.stringify(malformed));
  const staleArgs = { ...args, subject_refs: await reference(added, ["channel"]) };
  await admin.query("UPDATE customer_service.communication_preferences SET version = version + 1");
  const stale = await client.callTool({ name: "app.request_change", arguments: staleArgs });
  assert.ok(stale.isError || body(stale).authorization?.eligibility !== "verified", JSON.stringify(stale));
  stage = "same client observes deactivation and refuses previously issued references";
  const revokedArgs = { ...args, subject_refs: await reference(added, ["channel"]) };
  assert.equal(await deactivateActionRuleAuthority(project), true);
  assert.equal((await call("app.describe_actions")).actions.length, 0);
  const revoked = await client.callTool({ name: "app.request_change", arguments: revokedArgs });
  assert.ok(revoked.isError || body(revoked).authorization?.eligibility !== "verified", JSON.stringify(revoked));
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), toolNames);
  assert.equal(await fs.readFile(configPath, "utf8"), configBefore);
  assert.deepEqual((await admin.query("SELECT * FROM customer_service.support_cases ORDER BY case_id")).rows, before);
  assert.deepEqual((await admin.query("SELECT status, version FROM customer_service.billing_disputes")).rows, [{ status: "new", version: 1 }]);
  assert.deepEqual((await admin.query("SELECT channel, version FROM customer_service.communication_preferences")).rows,
    [{ channel: "email", version: 2 }], "Only the test's explicit version bump may change source state.");
  const store = new ProposalStore(path.join(project, ".synapsor/local.db"));
  try {
    const proposals = store.listProposals();
    assert.equal(proposals.length, 3, "Each successful request has one immutable proposal; retries and refusals add none.");
    assert.equal(new Set(proposals.map((entry) => entry.action)).size, 3);
    assert.deepEqual(proposals.map((entry) => JSON.stringify(entry.change_set.patch)).sort(),
      [{ status: "closed" }, { status: "submitted" }, { channel: "sms" }].map((patch) => JSON.stringify(patch)).sort(),
      "The exact proposed business changes must match the rules, with no additional field changes.");
  } finally { store.close(); }
  process.stdout.write(`PASS ${session.model}: attached document -> two live-model actions -> actual PostgreSQL Explore/opaque references -> three successful proposals through ONE stdio client; third typed outcome added without config/tool changes; ineligible/malformed/stale/retry/scope/deactivation guards preserved. Business clarifications: ${clarificationCount}. Execution intentionally off.\n`);
} catch (error) {
  throw new Error(`Multi-action qualification failed at ${stage}: ${error.message}\n${stderr}`, { cause: error });
} finally {
  await client?.close().catch(() => undefined);
  await admin?.end().catch(() => undefined);
  compose(["down", "-v", "--remove-orphans"], true);
  await fs.rm(project, { recursive: true, force: true });
}
