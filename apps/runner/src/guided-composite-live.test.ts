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
import {
  AUTO_BOUNDARY_OVERRIDES_VERSION,
  activateExplorationBoundary,
  buildAutoBoundary,
  explorationBoundaryCandidateDigest,
  writeAutoBoundaryArtifacts,
} from "./auto-boundary.js";
import { createScopedExploreMcpServer } from "./authoring-mcp.js";
import { secureAskJsonRequest } from "./model-ask.js";
import { generateModelReadWorkload } from "./read-workload-model.js";
import { createScopedExploreRuntime } from "./scoped-explore.js";

const reportPath = process.env.SYNAPSOR_GUIDED_COMPOSITE_REPORT;

type Transcript = {
  model: string;
  provider_requests: number;
  business_clarifications: Array<{ resource: string; field?: string; category?: string; question: string }>;
  natural_plan: unknown;
  coded_plan: unknown;
  clarified_plan?: unknown;
  usage: unknown;
  source_query_executed: boolean;
  source_database_changed: boolean;
  runtime_read_verified: boolean;
};

function safePlan(plan: unknown): unknown {
  return JSON.parse(JSON.stringify(plan));
}

async function writeTranscript(transcript: Transcript): Promise<void> {
  if (!reportPath) return;
  if (!path.isAbsolute(reportPath)) throw new Error("SYNAPSOR_GUIDED_COMPOSITE_REPORT must be an absolute path");
  await fs.mkdir(path.dirname(reportPath), { recursive: true, mode: 0o700 });
  await fs.writeFile(reportPath, `${JSON.stringify(transcript, null, 2)}\n`, { mode: 0o600 });
}

// This intentionally exercises the actual provider mapping path. The only data sent
// to the provider is synthetic structural metadata and supplied synthetic policy text.
describe.skipIf(process.env.SYNAPSOR_TEST_GUIDED_COMPOSITE_LIVE !== "1")(
  "guided composite onboarding with live Terra",
  () => {
    it("maps natural and coded registration displays without repeated technical clarification, then serves the reviewed composite read", async () => {
      const databaseUrl = process.env.SYNAPSOR_TEST_POSTGRES_URL;
      if (!databaseUrl || !process.env.OPENAI_API_KEY) throw new Error("Live qualification requires SYNAPSOR_TEST_POSTGRES_URL for a disposable database and OPENAI_API_KEY");
      const admin = new Pool({ connectionString: databaseUrl, max: 2 });
      const name = `guided_composite_${randomBytes(6).toString("hex")}`;
      const reader = `${name}_reader`;
      const password = randomBytes(16).toString("hex");
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-guided-composite-"));
      const transcript: Transcript = {
        model: "gpt-5.6-terra",
        provider_requests: 0,
        business_clarifications: [],
        natural_plan: undefined,
        coded_plan: undefined,
        usage: undefined,
        source_query_executed: false,
        source_database_changed: false,
        runtime_read_verified: false,
      };
      try {
        await admin.query(`CREATE SCHEMA "${name}"`);
        await admin.query(`CREATE ROLE "${reader}" LOGIN PASSWORD '${password}'`);
        await admin.query(`CREATE TABLE "${name}".courses (
          row_id text PRIMARY KEY, institution_id text NOT NULL, course_id text NOT NULL,
          course_code text NOT NULL, course_title text NOT NULL, UNIQUE (institution_id, course_id));
          CREATE TABLE "${name}".class_sections (
          row_id text PRIMARY KEY, institution_id text NOT NULL, section_id text NOT NULL, course_id text NOT NULL,
          section_label text NOT NULL, meeting_days text NOT NULL, instructor text NOT NULL,
          UNIQUE (institution_id, section_id), CONSTRAINT section_course FOREIGN KEY (institution_id, course_id)
          REFERENCES "${name}".courses (institution_id, course_id));
          CREATE TABLE "${name}".registration_cases (
          row_id text PRIMARY KEY, institution_id text NOT NULL, principal_id text NOT NULL,
          section_id text NOT NULL, credits integer NOT NULL, registration_status text NOT NULL, reg_st text NOT NULL, waitlist_position integer NOT NULL,
          CONSTRAINT registration_section FOREIGN KEY (institution_id, section_id)
          REFERENCES "${name}".class_sections (institution_id, section_id));
          INSERT INTO "${name}".courses VALUES
          ('a-course', 'a', 'c1', 'CHEM210', 'Chemistry'), ('b-course', 'b', 'c1', 'FOREIGN', 'Foreign course');
          INSERT INTO "${name}".class_sections VALUES
          ('a-section', 'a', 's1', 'c1', 'Morning', 'Mon Wed', 'Dr Green'),
          ('b-section', 'b', 's1', 'c1', 'Foreign section', 'Tue', 'Foreign teacher');
          INSERT INTO "${name}".registration_cases VALUES
          ('my-registration', 'a', 'maya', 's1', 3, 'offered', 'offered', 1),
          ('foreign-registration', 'b', 'maya', 's1', 5, 'enrolled', 'enrolled', 0);
          GRANT USAGE ON SCHEMA "${name}" TO "${reader}";
          GRANT SELECT ON ALL TABLES IN SCHEMA "${name}" TO "${reader}";`);
        for (const table of ["courses", "class_sections", "registration_cases"]) {
          await admin.query(`ALTER TABLE "${name}"."${table}" ENABLE ROW LEVEL SECURITY;
            CREATE POLICY tenant_scope ON "${name}"."${table}" FOR SELECT TO "${reader}"
            USING (institution_id = current_setting('synapsor.tenant_id', true)
            ${table === "registration_cases" ? "AND principal_id = current_setting('synapsor.principal', true)" : ""})`);
        }
        const url = new URL(databaseUrl);
        url.username = reader;
        url.password = password;
        const env = {
          DATABASE_URL: url.toString(),
          SYNAPSOR_TENANT_ID: "a",
          SYNAPSOR_PRINCIPAL: "maya",
          OPENAI_API_KEY: process.env.OPENAI_API_KEY!,
        };
        const inspection = await inspectDatabase({ databaseUrlEnv: "DATABASE_URL", schema: name, env });
        const decision = {
          actor: "live-fixture-reviewer",
          reason: "Exact institution-scoped display for each student's registrations.",
          decided_at: "2026-09-09T00:00:00.000Z",
        };
        const build = buildAutoBoundary({
          inspection,
          sourceEnv: "DATABASE_URL",
          project: { root, package_manager: "pnpm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] },
          overrides: {
            schema_version: AUTO_BOUNDARY_OVERRIDES_VERSION,
            resources: Object.fromEntries(inspection.tables.map((table) => [`${name}.${table.name}`, {
              tenant_key: { ...decision, value: "institution_id" },
              fields: Object.fromEntries(["row_id", "section_id", "course_id"].filter((field) => table.columns.some((column) => column.name === field))
                .map((field) => [field, { ...decision, exposure: "withhold_from_model" as const }])),
            }])),
          },
        });
        const providerDependencies = {
          requestJson: async (input: Parameters<typeof secureAskJsonRequest>[0]) => {
            transcript.provider_requests += 1;
            if (transcript.provider_requests > 10) throw new Error("Live composite qualification exceeded its bounded provider budget");
            return secureAskJsonRequest(input);
          },
        };
        const clarify = async (request: { resource: string; field?: string; category?: string; question: string }) => {
          transcript.business_clarifications.push({ ...request });
          return { state: "answered" as const, answer: request.field === "reg_st"
            ? `${request.resource}.reg_st means the student's registration status.`
            : "The requested display is limited to each student's own registrations in their institution." };
        };
        const natural = await generateModelReadWorkload({
          name: "my_registration_display",
          allowedQuestions: ["Show my registrations with course code and title, section label, meeting days, instructor, credits, registration status, and waitlist position."],
          forbiddenQuestions: ["Show unrelated courses or another student's registrations."],
          provider: "openai",
          model: "gpt-5.6-terra",
          generatedBoundary: build.exploration_boundary,
          env,
          egressAcknowledged: true,
          deferNarration: true,
          clarificationHandler: clarify,
          dependencies: providerDependencies,
        });
        transcript.natural_plan = safePlan(natural.workload);
        transcript.usage = natural.usage;
        transcript.source_query_executed = natural.source_query_executed;
        transcript.source_database_changed = natural.source_database_changed;
        expect(natural.analysis.status).toBe("ready");
        expect(natural.workload.allowed).toHaveLength(1);
        expect(natural.workload.allowed[0]!.plan).toMatchObject({
          kind: "rows",
          resource: `${name}.registration_cases`,
          select: expect.arrayContaining(["credits", "registration_status", "waitlist_position"]),
          related: expect.arrayContaining([
            expect.objectContaining({ relationship: "registration_section", select: expect.arrayContaining(["section_label", "meeting_days", "instructor"]) }),
            expect.objectContaining({ relationship: "registration_section__section_course", select: expect.arrayContaining(["course_code", "course_title"]) }),
          ]),
        });
        const coded = await generateModelReadWorkload({
          name: "coded_registration_status",
          allowedQuestions: ["Show my registrations with course code and title, section label, meeting days, instructor, credits, reg_st (registration status), and waitlist position."],
          operatorNamingContext: "For this policy, registration_cases.reg_st means the student's registration status. Show only my registrations with course code and title, section label, meeting days, instructor, credits, reg_st, and waitlist position.",
          forbiddenQuestions: ["Show unrelated courses or another student's registrations."],
          provider: "openai",
          model: "gpt-5.6-terra",
          generatedBoundary: build.exploration_boundary,
          env,
          egressAcknowledged: true,
          deferNarration: true,
          clarificationHandler: clarify,
          dependencies: providerDependencies,
        });
        transcript.coded_plan = safePlan(coded.workload);
        expect(coded.analysis.status).toBe("ready");
        expect(coded.workload.allowed[0]!.plan).toMatchObject({
          kind: "rows",
          resource: `${name}.registration_cases`,
          select: expect.arrayContaining(["reg_st", "credits", "waitlist_position"]),
          related: expect.arrayContaining([
            expect.objectContaining({ relationship: "registration_section", select: expect.arrayContaining(["section_label", "meeting_days", "instructor"]) }),
            expect.objectContaining({ relationship: "registration_section__section_course", select: expect.arrayContaining(["course_code", "course_title"]) }),
          ]),
        });
        expect(transcript.business_clarifications.filter((item) => item.category === "relationship_support")).toEqual([]);
        expect(transcript.business_clarifications).toHaveLength(0);
        expect(natural.authority_granted).toBe(false);
        expect(natural.source_query_executed).toBe(false);
        expect(natural.source_database_changed).toBe(false);

        const clarified = await generateModelReadWorkload({
          name: "explain_registration_code", allowedQuestions: ["Show reg_st for my registration cases."],
          forbiddenQuestions: ["Show anyone else's registration cases."],
          provider: "openai", model: "gpt-5.6-terra", generatedBoundary: build.exploration_boundary,
          env, egressAcknowledged: true, deferNarration: true,
          clarificationHandler: clarify, dependencies: providerDependencies,
        });
        transcript.clarified_plan = safePlan(clarified.workload);
        expect(clarified.analysis.status).toBe("ready");
        expect(transcript.business_clarifications).toHaveLength(1);
        expect(transcript.business_clarifications[0]).toMatchObject({ resource: `${name}.registration_cases`, field: "reg_st" });
        expect(clarified.workload.allowed[0]!.plan).toMatchObject({ kind: "rows", resource: `${name}.registration_cases`, select: ["reg_st"] });

        await writeAutoBoundaryArtifacts({ projectRoot: root, build });
        const candidate = natural.analysis.candidate!;
        const digest = explorationBoundaryCandidateDigest(candidate);
        await activateExplorationBoundary({
          projectRoot: root,
          candidate,
          expectedDigest: digest,
          confirmation: `ACTIVATE ${digest}`,
          actor: "live-fixture-reviewer",
          currentInspection: inspection,
          confirmedDecisions: candidate.unresolved_decisions,
        });
        const runtime = await createScopedExploreRuntime({ projectRoot: root, transport: "stdio", env });
        const server = createScopedExploreMcpServer(runtime, { semanticActions: createInactiveSemanticActionRuntime() });
        const client = new Client({ name: "guided-live-student-client", version: "1" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        try {
          await server.connect(serverTransport);
          await client.connect(clientTransport);
          expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
            "app.describe_actions", "app.describe_data", "app.explore_data", "app.request_change",
          ]);
          const discovery = await client.callTool({ name: "app.describe_data", arguments: { resource: `${name}.registration_cases` } });
          expect(discovery.isError, JSON.stringify(discovery)).not.toBe(true);
          expect(JSON.stringify(discovery.structuredContent)).toContain("registration_section__section_course");
          const result = await client.callTool({ name: "app.explore_data", arguments: { plan: natural.workload.allowed[0]!.plan } });
          expect(result.isError, JSON.stringify(result)).not.toBe(true);
          expect((result.structuredContent as { data: Array<Record<string, unknown>> }).data).toEqual([{
            credits: 3,
            registration_status: "offered",
            waitlist_position: 1,
            "registration_section.section_label": "Morning",
            "registration_section.meeting_days": "Mon Wed",
            "registration_section.instructor": "Dr Green",
            "registration_section__section_course.course_code": "CHEM210",
            "registration_section__section_course.course_title": "Chemistry",
          }]);
          transcript.runtime_read_verified = true;
        } finally {
          await client.close();
          await server.close();
          await runtime.close();
        }
      } finally {
        try {
          await admin.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
          await admin.query(`DROP ROLE IF EXISTS "${reader}"`);
        } finally {
          await admin.end();
          await fs.rm(root, { recursive: true, force: true });
          await writeTranscript(transcript);
        }
      }
    }, 180_000);
  },
);
