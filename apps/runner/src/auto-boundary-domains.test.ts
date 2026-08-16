import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ColumnInfo,
  ForeignKeyInfo,
  SchemaInspection,
  TableInfo,
} from "@synapsor-runner/schema-inspector";
import { describe, expect, it } from "vitest";
import {
  buildAutoBoundary,
  EXPLORATION_TIME_BUCKETS,
  loadStructuredProjectEvidence,
} from "./auto-boundary.js";
import {
  parseSchemaCandidateSource,
  type ParsedSchema,
  type SchemaCandidateFormat,
} from "./schema-candidates.js";

type DomainFixture = {
  name: string;
  engine: "postgres" | "mysql";
  table: string;
  tenant: string;
  tenantRoot: string;
  principal: string;
  principalRoot: string;
  sensitive: string;
  falsePositive: string;
  format: SchemaCandidateFormat;
  competingTenant?: { column: string; root: string };
  nonTenantAccount?: boolean;
};

const domains: DomainFixture[] = [
  {
    name: "SaaS workspaces",
    engine: "postgres",
    table: "workspace_memberships",
    tenant: "workspace_id",
    tenantRoot: "workspaces",
    principal: "user_id",
    principalRoot: "users",
    sensitive: "api_token",
    falsePositive: "accounting_period",
    format: "prisma",
  },
  {
    name: "retail operations",
    engine: "postgres",
    table: "orders",
    tenant: "merchant_id",
    tenantRoot: "merchants",
    competingTenant: { column: "store_id", root: "stores" },
    principal: "assigned_agent_id",
    principalRoot: "agents",
    sensitive: "card_on_file",
    falsePositive: "payment_status",
    format: "prisma",
  },
  {
    name: "logistics",
    engine: "mysql",
    table: "shipments",
    tenant: "company_id",
    tenantRoot: "companies",
    principal: "assigned_technician_id",
    principalRoot: "technicians",
    sensitive: "driver_phone",
    falsePositive: "shipping_region",
    format: "drizzle",
  },
  {
    name: "property management",
    engine: "postgres",
    table: "work_orders",
    tenant: "property_id",
    tenantRoot: "properties",
    principal: "manager_id",
    principalRoot: "managers",
    sensitive: "resident_address",
    falsePositive: "maintenance_status",
    format: "drizzle",
  },
  {
    name: "healthcare care teams",
    engine: "postgres",
    table: "care_tasks",
    tenant: "clinic_id",
    tenantRoot: "clinics",
    principal: "assigned_staff_id",
    principalRoot: "staff",
    sensitive: "medical_notes",
    falsePositive: "care_status",
    format: "openapi",
  },
  {
    name: "fintech accounts",
    engine: "postgres",
    table: "transfers",
    tenant: "organization_id",
    tenantRoot: "organizations",
    principal: "owner_id",
    principalRoot: "owners",
    sensitive: "routing_number",
    falsePositive: "risk_review_status",
    format: "openapi",
    nonTenantAccount: true,
  },
  {
    name: "customer support",
    engine: "mysql",
    table: "support_tickets",
    tenant: "tenant_id",
    tenantRoot: "tenants",
    principal: "assigned_agent_id",
    principalRoot: "agents",
    sensitive: "private_support_notes",
    falsePositive: "ticket_status",
    format: "drizzle",
  },
  {
    name: "industrial IoT",
    engine: "postgres",
    table: "sensor_alerts",
    tenant: "facility_id",
    tenantRoot: "facilities",
    principal: "assigned_technician_id",
    principalRoot: "technicians",
    sensitive: "device_secret",
    falsePositive: "panel_position",
    format: "prisma",
  },
];

describe("Auto Boundary cross-domain evidence matrix", () => {
  for (const fixture of domains) {
    it(`drafts ${fixture.name} from structural evidence without guessing authority`, () => {
      const inspection = domainInspection(fixture);
      const parsedEvidence = [structuredEvidence(fixture)];
      const result = buildAutoBoundary({
        inspection,
        project: {
          root: `/fixtures/${fixture.table}`,
          package_manager: "pnpm",
          frameworks: [fixture.format],
          schema_inputs: [{ kind: fixture.format, path: structuredEvidencePath(fixture.format) }],
          database_env_names: ["DATABASE_URL"],
        },
        parsedEvidence,
        sourceEnv: "DATABASE_URL",
      });
      const resource = result.graph.resources.find((candidate) =>
        candidate.id === `public.${fixture.table}`);
      const boundary = result.exploration_boundary.pack.resources.find((candidate) =>
        candidate.id === `public.${fixture.table}`);

      expect(resource, fixture.name).toBeDefined();
      expect(resource?.status, fixture.name).toBe("draft_read");
      expect(resource?.primary_key.selected, fixture.name).toBe("id");
      expect(resource?.tenant_key.selected, fixture.name).toBe(fixture.tenant);
      expect(resource?.principal_key.selected, fixture.name)
        .toBe(fixture.engine === "postgres" ? fixture.principal : undefined);
      expect(resource?.tenant_key.confidence, fixture.name).toMatch(/high|medium/);
      expect(resource?.principal_key.confidence, fixture.name)
        .toMatch(fixture.engine === "postgres" ? /high|medium/ : /low|medium/);
      expect(resource?.tenant_key.alternatives_considered, fixture.name)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            value: fixture.tenant,
            selected: true,
            evidence: expect.any(Array),
          }),
        ]));
      expect(resource?.tenant_key.evidence.length, fixture.name).toBeGreaterThan(0);
      expect(resource?.principal_key.evidence.length, fixture.name).toBeGreaterThan(0);
      expect(boundary?.kept_out_fields, fixture.name).toContain(fixture.sensitive);
      expect(boundary?.selectable_fields, fixture.name).not.toContain(fixture.sensitive);
      expect(boundary?.selectable_fields, fixture.name).toContain(fixture.falsePositive);
      expect(boundary?.aggregate_measures, fixture.name).toContain("amount_cents");
      expect(boundary?.groupable_fields, fixture.name).toContain("status");
      expect(boundary?.time_bucket_fields.occurred_at, fixture.name).toEqual([...EXPLORATION_TIME_BUCKETS]);
      if (fixture.competingTenant) {
        expect(resource?.tenant_key.alternatives_considered, fixture.name)
          .toEqual(expect.arrayContaining([
            expect.objectContaining({
              value: fixture.competingTenant.column,
              selected: false,
            }),
          ]));
      }
      if (fixture.nonTenantAccount) {
        expect(resource?.tenant_key.alternatives_considered, fixture.name)
          .toEqual(expect.arrayContaining([
            expect.objectContaining({
              value: "account_id",
              selected: false,
              confidence: "low",
            }),
          ]));
      }
      if (fixture.format === "prisma" || fixture.format === "drizzle") {
        expect(resource?.tenant_key.evidence, fixture.name)
          .toEqual(expect.arrayContaining([expect.objectContaining({ source: fixture.format })]));
      } else {
        expect(result.graph.structured_actions, fixture.name)
          .toEqual(expect.arrayContaining([
            expect.objectContaining({
              source: "openapi",
              status: "disabled_requires_business_review",
            }),
          ]));
      }
    });
  }

  it("keeps an account-like name blocked when no structural fact proves tenant authority", () => {
    const inspection = baseInspection("postgres");
    inspection.tables = [
      table("ledger_entries", [
        column("id", "uuid"),
        column("account_id", "uuid"),
        column("status", "text"),
      ], {
        foreignKeys: [foreignKey("ledger_entries_account", "account_id", "bank_accounts")],
      }),
      rootTable("bank_accounts"),
    ];

    const result = buildAutoBoundary({
      inspection,
      project: emptyProject(),
      sourceEnv: "DATABASE_URL",
    });
    const resource = result.graph.resources.find((candidate) => candidate.id === "public.ledger_entries");

    expect(resource).toMatchObject({
      status: "blocked_scope",
      tenant_key: {
        confidence: "low",
        confirmation_required: true,
        blocked_reason: expect.stringMatching(/names alone/i),
      },
    });
    expect(resource?.tenant_key.selected).toBeUndefined();
    expect(resource?.tenant_key.alternatives_considered).toContainEqual(expect.objectContaining({
      value: "account_id",
      selected: false,
    }));
    expect(result.contract.capabilities).toEqual([]);
  });

  it("does not confuse tenant RLS with principal scope", () => {
    const fixture = domains[0]!;
    const inspection = domainInspection(fixture);
    const target = inspection.tables.find((candidate) => candidate.name === fixture.table)!;
    target.row_level_security_policies = target.row_level_security_policies
      ?.filter((policy) => policy.name === `${fixture.table}_tenant_scope`);

    const result = buildAutoBoundary({
      inspection,
      project: emptyProject(),
      sourceEnv: "DATABASE_URL",
    });
    const resource = result.graph.resources.find((candidate) => candidate.id === `public.${fixture.table}`)!;

    expect(resource.tenant_key.selected).toBe(fixture.tenant);
    expect(resource.principal_key.selected).toBeUndefined();
    expect(resource.principal_key.blocked_reason).toMatch(/relationships do not prove/i);
    expect(resource.principal_key.candidates).toContain(fixture.principal);
  });

  it("ignores principal policies that do not apply to the inspected database role", () => {
    const fixture = domains[0]!;
    const inspection = domainInspection(fixture);
    const target = inspection.tables.find((candidate) => candidate.name === fixture.table)!;
    const principalPolicy = target.row_level_security_policies
      ?.find((policy) => policy.name === `${fixture.table}_principal_scope`);
    if (!principalPolicy) throw new Error("principal policy fixture missing");
    principalPolicy.roles = ["different_reader"];

    const result = buildAutoBoundary({
      inspection,
      project: emptyProject(),
      sourceEnv: "DATABASE_URL",
    });
    const resource = result.graph.resources.find((candidate) => candidate.id === `public.${fixture.table}`)!;

    expect(resource.tenant_key.selected).toBe(fixture.tenant);
    expect(resource.principal_key.selected).toBeUndefined();
    expect(resource.principal_key.candidates).toContain(fixture.principal);
    expect(resource.principal_key.blocked_reason).toMatch(/relationships do not prove/i);
  });

  it("uses a reviewed public DSL contract as the highest-ranked scope evidence", async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synapsor-reviewed-dsl-evidence-"));
    try {
      const fixture = domains[0]!;
      const inspection = domainInspection(fixture);
      const initial = buildAutoBoundary({
        inspection,
        project: emptyProject(),
        sourceEnv: "DATABASE_URL",
      });
      const dslPath = path.join(projectRoot, "reviewed.synapsor.sql");
      await fs.writeFile(dslPath, initial.dsl, "utf8");
      const project = {
        root: projectRoot,
        package_manager: "pnpm" as const,
        frameworks: ["synapsor"],
        schema_inputs: [{ kind: "synapsor" as const, path: "reviewed.synapsor.sql" }],
        database_env_names: ["DATABASE_URL"],
      };
      const evidence = await loadStructuredProjectEvidence(project);
      expect(evidence.warnings).toEqual([]);
      expect(evidence.existingContracts).toHaveLength(1);

      const metadataWithoutScopeProof = structuredClone(inspection);
      const target = metadataWithoutScopeProof.tables.find((candidate) => candidate.name === fixture.table)!;
      target.foreign_keys = [];
      target.row_level_security = false;
      target.row_level_security_policies = [];
      target.role_posture = {
        ...target.role_posture!,
        row_security_forced: false,
        row_security_effective_for_current_role: false,
      };
      const rebuilt = buildAutoBoundary({
        inspection: metadataWithoutScopeProof,
        project,
        existingContracts: evidence.existingContracts,
        sourceEnv: "DATABASE_URL",
      });
      const resource = rebuilt.graph.resources.find((candidate) =>
        candidate.id === `public.${fixture.table}`)!;

      expect(resource.status).toBe("draft_read");
      expect(resource.tenant_key).toMatchObject({
        selected: fixture.tenant,
        confidence: "high",
      });
      expect(resource.principal_key).toMatchObject({
        selected: fixture.principal,
        confidence: "high",
      });
      expect(resource.tenant_key.evidence).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source: "synapsor",
          detail: expect.stringMatching(/Synapsor .*contract.* capability/i),
        }),
      ]));
    } finally {
      await fs.rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function domainInspection(fixture: DomainFixture): SchemaInspection {
  const columns = [
    column("id", "uuid"),
    column(fixture.tenant, "uuid"),
    column(fixture.principal, "uuid"),
    ...(fixture.competingTenant ? [column(fixture.competingTenant.column, "uuid")] : []),
    ...(fixture.nonTenantAccount ? [column("account_id", "uuid")] : []),
    column("status", "text"),
    column("occurred_at", fixture.engine === "postgres" ? "timestamp with time zone" : "datetime"),
    column("amount_cents", "integer"),
    column(fixture.sensitive, "text"),
    column(fixture.falsePositive, "text"),
  ];
  const foreignKeys = [
    foreignKey(`${fixture.table}_${fixture.tenant}`, fixture.tenant, fixture.tenantRoot),
    foreignKey(`${fixture.table}_${fixture.principal}`, fixture.principal, fixture.principalRoot),
    ...(fixture.competingTenant
      ? [foreignKey(
          `${fixture.table}_${fixture.competingTenant.column}`,
          fixture.competingTenant.column,
          fixture.competingTenant.root,
        )]
      : []),
    ...(fixture.nonTenantAccount
      ? [foreignKey(`${fixture.table}_account`, "account_id", "bank_accounts")]
      : []),
  ];
  const target = table(fixture.table, columns, {
    foreignKeys,
    rlsPolicies: fixture.engine === "postgres"
      ? [
          rlsPolicy(
            `${fixture.table}_tenant_scope`,
            fixture.tenant,
            `app.${fixture.tenant.replace(/_id$/, "")}_id`,
          ),
          rlsPolicy(
            `${fixture.table}_principal_scope`,
            fixture.principal,
            `app.${fixture.principal.replace(/_id$/, "")}_id`,
          ),
        ]
      : [],
  });
  const roots = [
    fixture.tenantRoot,
    fixture.principalRoot,
    fixture.competingTenant?.root,
    ...(fixture.nonTenantAccount ? ["bank_accounts"] : []),
  ].filter((value): value is string => Boolean(value));
  return {
    ...baseInspection(fixture.engine),
    tables: [
      target,
      ...[...new Set(roots)].map(rootTable),
    ],
  };
}

function baseInspection(engine: "postgres" | "mysql"): SchemaInspection {
  return {
    engine,
    server_version: engine === "postgres" ? "PostgreSQL 16.14" : "MySQL 8.4.9",
    current_user: "app_reader",
    role_posture: {
      verified: true,
      superuser: false,
      bypass_rls: engine === "postgres" ? false : "unsupported",
      read_only: true,
      writable_relations: [],
      owned_relations: [],
      reasons: [],
    },
    inspected_at: "2026-07-25T00:00:00.000Z",
    schemas: ["public"],
    warnings: [],
    tables: [],
  };
}

function table(
  name: string,
  columns: ColumnInfo[],
  options: {
    foreignKeys?: ForeignKeyInfo[];
    rlsPolicies?: NonNullable<TableInfo["row_level_security_policies"]>;
  } = {},
): TableInfo {
  const rls = Boolean(options.rlsPolicies?.length);
  return {
    schema: "public",
    name,
    type: "table",
    writable: false,
    columns,
    primary_key: ["id"],
    unique_constraints: [{ name: `${name}_pkey`, columns: ["id"] }],
    foreign_keys: options.foreignKeys ?? [],
    indexes: [{ name: `${name}_pkey`, columns: ["id"], unique: true }],
    row_level_security: rls,
    row_level_security_policies: options.rlsPolicies ?? [],
    role_posture: {
      owner: "app_owner",
      current_role_is_owner: false,
      current_role_can_assume_owner: false,
      row_security_forced: rls,
      row_security_effective_for_current_role: rls,
      privileges: {
        select: true,
        insert: false,
        update: false,
        delete: false,
        truncate: false,
        references: false,
        trigger: false,
      },
    },
    suggestions: {
      tenant_columns: columns.filter((field) => /(?:tenant|workspace|organization|merchant|store|company|property|clinic|facility)_id/i.test(field.name))
        .map((field) => field.name),
      conflict_columns: [],
      sensitive_columns: columns.filter((field) => field.suggestions.sensitive).map((field) => field.name),
      default_visible_columns: columns.filter((field) => !field.suggestions.sensitive).map((field) => field.name),
    },
  };
}

function rootTable(name: string): TableInfo {
  return table(name, [column("id", "uuid")]);
}

function column(name: string, dataType: string): ColumnInfo {
  return {
    name,
    data_type: dataType,
    nullable: false,
    generated: false,
    ordinal_position: 1,
    suggestions: {
      tenant: /(?:tenant|workspace|organization|merchant|store|company|property|clinic|facility)_id/i.test(name),
      conflict: false,
      sensitive: /(?:token|secret|phone|address|medical|routing|private)/i.test(name),
      immutable: name === "id" || name.endsWith("_id"),
      large_or_binary: false,
    },
  };
}

function foreignKey(name: string, localColumn: string, targetTable: string): ForeignKeyInfo {
  return {
    name,
    columns: [localColumn],
    referenced_schema: "public",
    referenced_table: targetTable,
    referenced_columns: ["id"],
    delete_rule: "RESTRICT",
  };
}

function rlsPolicy(name: string, columnName: string, settingName: string) {
  return {
    name,
    command: "SELECT",
    permissive: true,
    roles: ["app_reader"],
    using_expression: `(${columnName} = current_setting('${settingName}')::uuid)`,
  };
}

function structuredEvidence(fixture: DomainFixture): ParsedSchema {
  return parseSchemaCandidateSource(
    fixture.format,
    structuredSource(fixture),
    structuredEvidencePath(fixture.format),
  );
}

function structuredEvidencePath(format: SchemaCandidateFormat): string {
  if (format === "prisma") return "prisma/schema.prisma";
  if (format === "drizzle") return "src/schema.ts";
  return "openapi.yaml";
}

function structuredSource(fixture: DomainFixture): string {
  if (fixture.format === "prisma") {
    return `
datasource db {
  provider = "${fixture.engine === "postgres" ? "postgresql" : "mysql"}"
  url = env("DATABASE_URL")
}
model DomainRecord {
  id String @id
  ${camel(fixture.tenant)} String @map("${fixture.tenant}")
  ${camel(fixture.principal)} String @map("${fixture.principal}")
  status String
  ${camel(fixture.sensitive)} String @map("${fixture.sensitive}")
  @@map("${fixture.table}")
}`;
  }
  if (fixture.format === "drizzle") {
    const constructor = fixture.engine === "mysql" ? "mysqlTable" : "pgTable";
    return `
export const domainRecord = ${constructor}("${fixture.table}", {
  id: text("id").primaryKey(),
  tenant: text("${fixture.tenant}").notNull(),
  principal: text("${fixture.principal}").notNull(),
  status: text("status").notNull(),
  sensitive: text("${fixture.sensitive}").notNull(),
});`;
  }
  return `
openapi: 3.1.0
info: { title: ${fixture.name}, version: "1" }
paths:
  /${fixture.table}/{id}:
    get:
      tags: [${fixture.table}]
      operationId: get_${fixture.table}
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
                  ${fixture.tenant}: { type: string }
                  ${fixture.principal}: { type: string }
                  ${fixture.sensitive}: { type: string }
    patch:
      tags: [${fixture.table}]
      operationId: update_${fixture.table}
      parameters:
        - { name: id, in: path, required: true, schema: { type: string } }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                status: { type: string }
      responses:
        "200": { description: ok }
`;
}

function camel(value: string): string {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function emptyProject() {
  return {
    root: "/fixtures/empty",
    package_manager: "pnpm" as const,
    frameworks: ["node"],
    schema_inputs: [],
    database_env_names: ["DATABASE_URL"],
  };
}
