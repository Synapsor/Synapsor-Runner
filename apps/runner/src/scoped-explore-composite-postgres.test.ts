import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { inspectDatabase } from "@synapsor-runner/schema-inspector";
import { createInactiveSemanticActionRuntime } from "@synapsor-runner/mcp-server";
import { describe, expect, it } from "vitest";
import { AUTO_BOUNDARY_OVERRIDES_VERSION, activateExplorationBoundary, buildAutoBoundary,
  explorationBoundaryCandidateDigest, writeAutoBoundaryArtifacts } from "./auto-boundary.js";
import { analyzeReadWorkloadSet, READ_WORKLOAD_SET_VERSION } from "./read-workload-assist.js";
import { createScopedExploreRuntime } from "./scoped-explore.js";
import { createScopedExploreMcpServer } from "./authoring-mcp.js";

// Only an explicitly supplied disposable database may create this random fixture.
// Real catalog, RLS, query, activation and MCP; this is not a live-model UX test.
describe.skipIf(!process.env.SYNAPSOR_TEST_POSTGRES_URL)("connected composite registration display", () => {
  it("returns own section/course details without independent course access or cross-institution matches", async () => {
    const admin = new Pool({ connectionString: process.env.SYNAPSOR_TEST_POSTGRES_URL, max: 2 });
    const name = `composite_${randomBytes(6).toString("hex")}`;
    const reader = `${name}_reader`, password = randomBytes(16).toString("hex");
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-composite-pg-"));
    try {
      await admin.query(`CREATE SCHEMA "${name}"`);
      await admin.query(`CREATE ROLE "${reader}" LOGIN PASSWORD '${password}'`);
      await admin.query(`CREATE TABLE "${name}".courses (
        row_id text PRIMARY KEY, institution_id text NOT NULL, course_id text NOT NULL,
        code text NOT NULL, title text NOT NULL, UNIQUE (institution_id, course_id));
        CREATE TABLE "${name}".class_sections (
        row_id text PRIMARY KEY, institution_id text NOT NULL, section_id text NOT NULL, course_id text NOT NULL,
        section_label text NOT NULL, meeting_days text NOT NULL, instructor text NOT NULL,
        UNIQUE (institution_id, section_id), CONSTRAINT section_course FOREIGN KEY (institution_id, course_id)
        REFERENCES "${name}".courses (institution_id, course_id));
        CREATE TABLE "${name}".registration_cases (
        row_id text PRIMARY KEY, institution_id text NOT NULL, principal_id text NOT NULL,
        section_id text NOT NULL, credits integer NOT NULL, status text NOT NULL, waitlist_position integer NOT NULL,
        CONSTRAINT registration_section FOREIGN KEY (institution_id, section_id)
        REFERENCES "${name}".class_sections (institution_id, section_id));
        INSERT INTO "${name}".courses VALUES
          ('a-course', 'a', 'c1', 'CHEM210', 'Chemistry'), ('b-course', 'b', 'c1', 'FOREIGN', 'Foreign course'),
          ('unrelated-course', 'a', 'c2', 'UNRELATED', 'Unrelated course');
        INSERT INTO "${name}".class_sections VALUES
          ('a-section', 'a', 's1', 'c1', 'Morning', 'Mon Wed', 'Dr Green'),
          ('b-section', 'b', 's1', 'c1', 'Foreign section', 'Tue', 'Foreign teacher'),
          ('unrelated-section', 'a', 's2', 'c2', 'Unrelated section', 'Fri', 'Other teacher');
        INSERT INTO "${name}".registration_cases VALUES
          ('my-registration', 'a', 'maya', 's1', 3, 'offered', 1),
          ('other-student', 'a', 'devin', 's2', 4, 'enrolled', 0),
          ('foreign-registration', 'b', 'maya', 's1', 5, 'enrolled', 0);
        GRANT USAGE ON SCHEMA "${name}" TO "${reader}";
        GRANT SELECT ON ALL TABLES IN SCHEMA "${name}" TO "${reader}";`);
      for (const table of ["courses", "class_sections", "registration_cases"]) {
        await admin.query(`ALTER TABLE "${name}"."${table}" ENABLE ROW LEVEL SECURITY;
          CREATE POLICY tenant_scope ON "${name}"."${table}" FOR SELECT TO "${reader}"
          USING (institution_id = current_setting('synapsor.tenant_id', true)
          ${table === "registration_cases" ? "AND principal_id = current_setting('synapsor.principal', true)" : ""})`);
      }
      const url = new URL(process.env.SYNAPSOR_TEST_POSTGRES_URL!);
      url.username = reader; url.password = password;
      const env = { DATABASE_URL: url.toString(), SYNAPSOR_TENANT_ID: "a", SYNAPSOR_PRINCIPAL: "maya" };
      const inspection = await inspectDatabase({ databaseUrlEnv: "DATABASE_URL", schema: name, env });
      const decision = { actor: "fixture-reviewer", reason: "Exact institution-scoped display for each student's registrations.",
        decided_at: "2026-09-09T00:00:00.000Z" };
      const build = buildAutoBoundary({ inspection, sourceEnv: "DATABASE_URL",
        project: { root, package_manager: "pnpm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] },
        overrides: { schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
          resources: Object.fromEntries(inspection.tables.map(table => [`${name}.${table.name}`, {
            tenant_key: { ...decision, value: "institution_id" },
            fields: Object.fromEntries(["row_id", "section_id", "course_id"].filter(field => table.columns.some(c => c.name === field))
              .map(field => [field, { ...decision, exposure: "withhold_from_model" as const }])),
          }])) } });
      const requested = { kind: "rows", resource: `${name}.registration_cases`, select: ["credits", "status", "waitlist_position"],
        related: [{ relationship: "registration_section", select: ["section_label", "meeting_days", "instructor"] },
          { relationship: "registration_section__section_course", select: ["code", "title"] }] };
      const analysis = analyzeReadWorkloadSet({ generatedBoundary: build.exploration_boundary, workload: {
        schema_version: READ_WORKLOAD_SET_VERSION, name: "my_registration_display", source: { kind: "operator_exact_plan" },
        allowed: [{ id: "own_details", description: "Show my registrations, section details and course names", plan: requested }],
        forbidden: [{ id: "all_courses", description: "No unrelated course viewing", plan: { kind: "rows", resource: `${name}.courses`, select: ["title"] } }],
      } });
      expect(analysis.blockers).toEqual([]);
      expect(analysis.coverage).toMatchObject({ allowed_supported: 1, forbidden_denied: 1 });
      await writeAutoBoundaryArtifacts({ projectRoot: root, build });
      const candidate = analysis.candidate!;
      const digest = explorationBoundaryCandidateDigest(candidate);
      await activateExplorationBoundary({ projectRoot: root, candidate, expectedDigest: digest,
        confirmation: `ACTIVATE ${digest}`, actor: "fixture-reviewer", currentInspection: inspection,
        confirmedDecisions: candidate.unresolved_decisions });
      for (const [tenant, principal, status] of [["a", "maya", "offered"], ["a", "devin", "enrolled"], ["b", "maya", "enrolled"], ["a", "unknown", undefined]]) {
        const runtime = await createScopedExploreRuntime({ projectRoot: root, transport: "stdio",
          env: { ...env, SYNAPSOR_TENANT_ID: tenant, SYNAPSOR_PRINCIPAL: principal } });
        const server = createScopedExploreMcpServer(runtime, { semanticActions: createInactiveSemanticActionRuntime() });
        const client = new Client({ name: "student-client", version: "1" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        try {
          await server.connect(serverTransport); await client.connect(clientTransport);
          expect((await client.listTools()).tools.map(tool => tool.name).sort()).toEqual([
            "app.describe_actions", "app.describe_data", "app.explore_data", "app.request_change"]);
          const discovery = await client.callTool({ name: "app.describe_data", arguments: { resource: requested.resource } });
          expect(discovery.isError, JSON.stringify(discovery)).not.toBe(true);
          expect(JSON.stringify(discovery.structuredContent)).toContain("registration_section__section_course");
          const result = await client.callTool({ name: "app.explore_data", arguments: { plan: requested } });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          const data = (result.structuredContent as { data: Array<Record<string, unknown>> }).data;
          expect(data).toHaveLength(status ? 1 : 0);
          if (status) expect(data[0]!.status).toBe(status);
          if (tenant === "a" && principal === "maya") {
            expect(data[0]).toEqual({ credits: 3, status: "offered", waitlist_position: 1,
              "registration_section.section_label": "Morning", "registration_section.meeting_days": "Mon Wed",
              "registration_section.instructor": "Dr Green", "registration_section__section_course.code": "CHEM210",
              "registration_section__section_course.title": "Chemistry" });
          }
          expect(JSON.stringify(data)).not.toMatch(/row_id|institution_id|principal_id|course_id|section_id/);
          const forbidden = await client.callTool({ name: "app.explore_data", arguments: {
            plan: { kind: "rows", resource: `${name}.courses`, select: ["title"] } } });
          expect(forbidden.isError).toBe(true);
        } finally { await client.close(); await server.close(); await runtime.close(); }
      }
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
      await admin.query(`DROP ROLE IF EXISTS "${reader}"`);
      await admin.end();
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
