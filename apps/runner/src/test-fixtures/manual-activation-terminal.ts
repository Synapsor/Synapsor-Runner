import type { SchemaInspection } from "@synapsor-runner/schema-inspector";
import { buildAutoBoundary, writeAutoBoundaryArtifacts, loadActivatedExplorationBoundaries } from "../auto-boundary.js";
import { boundaryReviewCommand } from "../boundary-commands.js";
import { createBoundaryReviewInteractiveSession } from "../boundary-cli-picker.js";

const root = process.argv[2]!;
const mode = process.argv[3]!;
const column = (name: string, type: string, tenant = false) => ({ name, data_type: type,
  nullable: false, generated: false, ordinal_position: 1,
  suggestions: { tenant, conflict: false, sensitive: false, immutable: name === "id" || tenant, large_or_binary: false } });
const inspection: SchemaInspection = {
  engine: "postgres", server_version: "PostgreSQL 16", current_user: "app_reader",
  inspected_at: "2026-09-09T00:00:00.000Z", schemas: ["public"], warnings: [],
  role_posture: { verified: true, superuser: false, bypass_rls: false, read_only: true,
    writable_relations: [], owned_relations: [], reasons: [] },
  tables: [{ schema: "public", name: "service_visits", type: "table", writable: true,
    columns: [column("id", "uuid"), column("tenant_id", "uuid", true),
      { ...column("status", "text"), enum_values: ["scheduled", "completed"] }],
    primary_key: ["id"], unique_constraints: [{ name: "visits_pkey", columns: ["id"] }],
    foreign_keys: [], indexes: [{ name: "visits_pkey", columns: ["id"], unique: true }],
    row_level_security: true, row_level_security_policies: [{ name: "tenant_read", command: "SELECT", permissive: true,
      roles: ["app_reader"], using_expression: "tenant_id = current_setting('app.tenant_id')::uuid" }],
    role_posture: { owner: "app_owner", current_role_is_owner: false, current_role_can_assume_owner: false,
      privileges: { select: true, insert: false, update: false, delete: false, truncate: false, references: false, trigger: false },
      row_security_forced: false, row_security_effective_for_current_role: true },
    suggestions: { tenant_columns: ["tenant_id"], conflict_columns: [], sensitive_columns: [], default_visible_columns: ["id", "tenant_id", "status"] },
  }],
};
const build = buildAutoBoundary({ inspection, project: { root, package_manager: "npm", frameworks: [], schema_inputs: [], database_env_names: ["DATABASE_URL"] },
  sourceEnv: "DATABASE_URL", inspectedSchema: "public" });
if (mode === "oversized") build.exploration_boundary.pack.resources[0]!.description = "x".repeat(6600);
await writeAutoBoundaryArtifacts({ projectRoot: root, build });
const current = structuredClone(inspection);
if (mode === "drift") current.tables[0]!.role_posture!.owner = "new_owner";
await boundaryReviewCommand(["--project-root", root, "--access"], async () => current,
  createBoundaryReviewInteractiveSession(process.stdin, process.stdout));
const active = await loadActivatedExplorationBoundaries(root).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
process.stdout.write(`\nPERSISTED_ACTIVE_COUNT=${active.length}\n`);
