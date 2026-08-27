import type { SchemaInspection } from "@synapsor-runner/schema-inspector";


export type DatabaseRolePostureAssessment = {
  safe_for_model_reads: boolean;
  engine: SchemaInspection["engine"];
  role: string;
  verified: boolean;
  read_only: boolean;
  facts: string[];
};


export class DatabaseRolePostureError extends Error {
  public readonly code = "DATABASE_ROLE_UNSAFE";

  constructor(
    message: string,
    public readonly assessment: DatabaseRolePostureAssessment,
  ) {
    super(message);
    this.name = "DatabaseRolePostureError";
  }
}


export function assessDatabaseRolePosture(
  inspection: Pick<SchemaInspection, "engine" | "current_user" | "role_posture">,
): DatabaseRolePostureAssessment {
  const posture = inspection.role_posture;
  const enginePrivilegePostureSafe = inspection.engine === "mysql"
    ? (posture?.superuser === false || posture?.superuser === "unsupported")
      && (posture?.bypass_rls === false || posture?.bypass_rls === "unsupported")
    : posture?.superuser === false && posture?.bypass_rls === false;
  const ownedRelations = posture?.owned_relations ?? [];
  const writableRelations = posture?.writable_relations ?? [];
  const relationPostureSafe = ownedRelations.length === 0
    && writableRelations.length === 0;
  const facts: string[] = [];
  if (posture && !posture.verified) facts.push("effective database-role posture could not be fully verified");
  if (posture?.superuser === true) {
    facts.push(inspection.engine === "postgres"
      ? "the role is a PostgreSQL superuser"
      : "the account has elevated/global authority or GRANT OPTION");
  }
  if (inspection.engine === "postgres" && posture?.bypass_rls === true) {
    facts.push("the role has BYPASSRLS");
  }
  if (inspection.engine === "postgres" && posture && posture.superuser !== false && posture.superuser !== true) {
    facts.push("PostgreSQL superuser posture is not proven false");
  }
  if (inspection.engine === "postgres" && posture && posture.bypass_rls !== false && posture.bypass_rls !== true) {
    facts.push("PostgreSQL BYPASSRLS posture is not proven false");
  }
  if (inspection.engine === "mysql" && posture
    && posture.superuser !== false && posture.superuser !== "unsupported" && posture.superuser !== true) {
    facts.push("MySQL global/elevated privilege posture could not be proven safe");
  }
  if (ownedRelations.length) {
    facts.push(`the role owns or can assume ownership of ${ownedRelations.length} inspected ${plural(ownedRelations.length, "relation", "relations")}`);
  }
  if (writableRelations.length) {
    facts.push(`the role has write authority on ${writableRelations.length} inspected ${plural(writableRelations.length, "relation", "relations")}`);
  }
  if (posture?.verified && !posture.read_only && facts.length === 0) {
    facts.push("the role is not proven read-only and non-owner for the inspected relations");
  }
  if (!posture) facts.push("the inspection does not contain database-role posture evidence");
  return {
    safe_for_model_reads: Boolean(
      posture?.verified
      && posture.read_only
      && enginePrivilegePostureSafe
      && relationPostureSafe,
    ),
    engine: inspection.engine,
    role: safeRoleName(inspection.current_user),
    verified: posture?.verified === true,
    read_only: posture?.read_only === true,
    facts,
  };
}


export function databaseRolePostureRemediation(
  assessment: DatabaseRolePostureAssessment,
): string {
  return assessment.engine === "postgres"
    ? "Use a dedicated PostgreSQL role with only required CONNECT, schema USAGE, and SELECT grants; it must not be SUPERUSER, have BYPASSRLS, own reviewed relations, or be able to assume their owner."
    : "Use a dedicated MySQL account with only required schema/table SELECT grants; it must not have global privileges, GRANT OPTION, ownership-equivalent authority, or write grants.";
}


export function formatUnsafeDatabaseRoleMessage(input: {
  inspection: Pick<SchemaInspection, "engine" | "current_user" | "role_posture">;
  sourceEnv?: string;
  nextAction?: string;
  statePreserved?: string;
}): string {
  const assessment = assessDatabaseRolePosture(input.inspection);
  const detected = assessment.facts.length
    ? assessment.facts.map((fact) => `  - ${fact}`).join("\n")
    : "  - the role is not safe for model-facing reads";
  const envInstruction = input.sourceEnv
    ? `Update ${safeEnvironmentName(input.sourceEnv)} to reference that credential without printing its value.`
    : "Update the configured read-credential environment variable without printing its value.";
  return [
    `Database role ${assessment.role} is unsafe for model-facing reads.`,
    "Detected:",
    detected,
    "Why it matters: elevated, owner, write-capable, or BYPASSRLS credentials can bypass database defenses that Runner expects to remain independently effective.",
    `State preserved: ${input.statePreserved ?? "Runner did not create or activate model-facing authority, and the source database was not changed."}`,
    `Next: ${databaseRolePostureRemediation(assessment)} ${envInstruction}${input.nextAction ? ` ${input.nextAction}` : " Then rerun the command."}`,
  ].join("\n");
}


export function assertDatabaseRoleSafeForModelReads(input: {
  inspection: Pick<SchemaInspection, "engine" | "current_user" | "role_posture">;
  sourceEnv?: string;
  nextAction?: string;
  statePreserved?: string;
}): void {
  const assessment = assessDatabaseRolePosture(input.inspection);
  if (assessment.safe_for_model_reads) return;
  throw new DatabaseRolePostureError(formatUnsafeDatabaseRoleMessage(input), assessment);
}


function safeRoleName(value: string): string {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/gu, "?");
  return JSON.stringify((normalized || "unknown").slice(0, 160));
}


function safeEnvironmentName(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/u.test(value) ? value : "the configured read-credential environment variable";
}


function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}
