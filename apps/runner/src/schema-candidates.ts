import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertSafeManagedOutputPath, readManagedOutputMarker } from "./managed-output.js";
import ts from "typescript";
import { parseDocument } from "yaml";
import { validateContract, type ArgumentSpec, type CapabilitySpec, type SynapsorContract } from "@synapsor/spec";

export type SchemaCandidateFormat = "prisma" | "drizzle" | "openapi";

export const SCHEMA_CANDIDATE_VERSION = "synapsor.schema-candidates.v1";
export const SCHEMA_CANDIDATE_MARKER = ".synapsor-schema-candidates.json";

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_OBJECTS = 50;
const MAX_FIELDS_PER_OBJECT = 128;
const MAX_CAPABILITIES = 200;
const MAX_AST_NODES = 100_000;
const MAX_STRUCTURE_NODES = 50_000;

const CONTRACT_FILE = "synapsor.candidate.contract.json";
const CONFIG_FILE = "synapsor.candidate.runner.json";
const TEST_FILE = "synapsor.candidate.contract-tests.json";
const REVIEW_JSON_FILE = "generation-review.json";
const REVIEW_FILE = "REVIEW.md";

const SENSITIVE_PATTERN =
  /(password|secret|token|api_?key|credential|ssn|social_?security|card|pan|cvv|private|internal|medical|diagnosis|email|phone)/i;
const TENANT_PATTERN = /^(tenant|tenant_id|tenantid|workspace_id|organization_id|org_id|account_id|project_id)$/i;
const PRINCIPAL_PATTERN = /^(user_id|userid|owner_id|assignee_id|agent_id|principal_id|customer_id|patient_id)$/i;
const CONFLICT_PATTERN = /^(version|row_version|lock_version|updated_at|updatedat|etag|modified_at)$/i;
const PRIMARY_PATTERN = /^(id|uuid|[a-z0-9_]+_id)$/i;
const MODEL_AUTHORITY_PATTERN =
  /^(tenant|tenant_id|tenantid|principal|principal_id|schema|table|column|columns|database|database_url|sql|query|where|predicate|expected_version|row_version|approval_identity|token|api_key|password|secret)$/i;

type ScalarType = "string" | "number" | "boolean";

type CandidateField = {
  name: string;
  type: ScalarType | "object" | "array" | "unknown";
  source_type?: string;
  required: boolean;
  primary_key: boolean;
  unique: boolean;
  generated: boolean;
  sensitive: boolean;
};

type CandidateAction = {
  name: string;
  kind: "read" | "proposal";
  args: CandidateField[];
  visible_candidates: string[];
  allowed_field_candidates: string[];
  handler_required: boolean;
  source_hint: string;
};

type CandidateObject = {
  name: string;
  schema: string;
  table: string;
  engine?: "postgres" | "mysql";
  fields: CandidateField[];
  primary_key_candidates: string[];
  tenant_candidates: string[];
  principal_candidates: string[];
  conflict_candidates: string[];
  sensitive_candidates: string[];
  visible_candidates: string[];
  action_candidates: CandidateAction[];
  assumptions: string[];
  unsupported: string[];
};

export type SchemaCandidateReview = {
  schema_version: typeof SCHEMA_CANDIDATE_VERSION;
  format: SchemaCandidateFormat;
  source_digest: `sha256:${string}`;
  activation: "blocked_unreviewed";
  summary: {
    objects: number;
    fields: number;
    capabilities: number;
    write_candidates: number;
  };
  warnings: string[];
  objects: Array<{
    name: string;
    table: string;
    structural_primary_key_candidates: string[];
    potential_tenant_fields: string[];
    potential_principal_fields: string[];
    potential_conflict_fields: string[];
    potentially_sensitive_fields: string[];
    suggested_kept_out_fields: string[];
    suggested_visible_fields: string[];
    possible_actions: Array<{
      name: string;
      kind: "read" | "proposal";
      allowed_field_candidates: string[];
      requires_business_logic: boolean;
      requires_app_owned_handler: boolean;
    }>;
    uncertain_assumptions: string[];
    unsupported_or_dynamic: string[];
  }>;
};

export type SchemaCandidateGenerationResult = {
  output_dir: string;
  overwritten: boolean;
  format: SchemaCandidateFormat;
  source_digest: `sha256:${string}`;
  objects: number;
  capabilities: number;
  activation: "blocked_unreviewed";
  files: string[];
};

type ParsedSchema = {
  format: SchemaCandidateFormat;
  objects: CandidateObject[];
  warnings: string[];
};

type GeneratedSchemaBundle = {
  contract: SynapsorContract;
  config: Record<string, unknown>;
  tests: Record<string, unknown>;
  review: SchemaCandidateReview;
  reviewMarkdown: string;
  marker: Record<string, unknown>;
  result: Omit<SchemaCandidateGenerationResult, "output_dir" | "overwritten">;
};

export async function generateSchemaCandidateDirectory(input: {
  format: SchemaCandidateFormat;
  inputPath: string;
  outputDir: string;
  force?: boolean;
}): Promise<SchemaCandidateGenerationResult> {
  const source = await readBoundedInput(input.inputPath);
  const parsed = parseSchemaCandidateSource(input.format, source, input.inputPath);
  const outputDir = await assertSafeManagedOutputPath(input.outputDir);
  const existed = await pathExists(outputDir);
  if (existed) {
    if (!input.force) {
      throw new Error(`schema candidate output already exists: ${outputDir}. Choose another directory or pass --force.`);
    }
    await assertOwnedDirectory(outputDir);
  }
  const bundle = buildSchemaCandidateBundle(parsed);
  await fs.mkdir(path.dirname(outputDir), { recursive: true });
  const temporary = await fs.mkdtemp(path.join(path.dirname(outputDir), `.${path.basename(outputDir)}.tmp-`));
  try {
    await fs.writeFile(path.join(temporary, CONTRACT_FILE), json(bundle.contract), "utf8");
    await fs.writeFile(path.join(temporary, CONFIG_FILE), json(bundle.config), "utf8");
    await fs.writeFile(path.join(temporary, TEST_FILE), json(bundle.tests), "utf8");
    await fs.writeFile(path.join(temporary, REVIEW_JSON_FILE), json(bundle.review), "utf8");
    await fs.writeFile(path.join(temporary, REVIEW_FILE), bundle.reviewMarkdown, "utf8");
    await fs.writeFile(path.join(temporary, SCHEMA_CANDIDATE_MARKER), json(bundle.marker), "utf8");
    if (existed) {
      await assertOwnedDirectory(outputDir);
      await fs.rm(outputDir, { recursive: true, force: true });
    }
    await fs.rename(temporary, outputDir);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return {
    output_dir: outputDir,
    overwritten: existed,
    ...bundle.result,
  };
}

export function parseSchemaCandidateSource(
  format: SchemaCandidateFormat,
  source: string,
  sourceName = "inline",
): ParsedSchema {
  if (Buffer.byteLength(source, "utf8") > MAX_INPUT_BYTES) {
    throw new Error(`candidate input exceeds ${MAX_INPUT_BYTES} bytes`);
  }
  if (format === "prisma") return parsePrismaSchema(source);
  if (format === "drizzle") return parseDrizzleSchema(source, sourceName);
  return parseOpenApiDocument(source, sourceName);
}

export function buildSchemaCandidateBundle(parsed: ParsedSchema): GeneratedSchemaBundle {
  if (parsed.objects.length === 0) throw new Error(`${parsed.format} input did not contain a supported static object or operation`);
  if (parsed.objects.length > MAX_OBJECTS) throw new Error(`candidate input exceeds ${MAX_OBJECTS} supported objects`);
  const sourceDigest = digest({
    schema_version: "synapsor.schema-candidate-source.v1",
    format: parsed.format,
    objects: parsed.objects,
    warnings: parsed.warnings,
  });
  const capabilities: CapabilitySpec[] = [];
  const usedNames = new Set<string>();
  parsed.objects.forEach((object, objectIndex) => {
    for (const action of object.action_candidates) {
      if (capabilities.length >= MAX_CAPABILITIES) {
        throw new Error(`candidate input exceeds ${MAX_CAPABILITIES} generated capabilities`);
      }
      capabilities.push(buildCapability(object, action, objectIndex, usedNames));
    }
  });
  const contract: SynapsorContract = {
    spec_version: "0.1",
    kind: "SynapsorContract",
    metadata: {
      name: `${parsed.format} reviewed capability candidates`,
      description: "Structurally inferred, authority-free candidates. Review every placeholder before activation.",
      version: "0.0.0-candidate",
      tags: ["schema-candidate", parsed.format, "not-active"],
      "x-runner-source-digest": sourceDigest,
    },
    contexts: [
      {
        name: "review_candidate_context",
        description: "TODO: bind tenant and principal from a verified deployment-specific authority.",
        bindings: [
          {
            name: "tenant_id",
            source: "environment",
            key: "SYNAPSOR_REVIEW_TENANT_ID",
            required: true,
            "x-runner-todo": "Choose the authoritative tenant binding; this is not inferred from schema fields.",
          },
          {
            name: "principal",
            source: "environment",
            key: "SYNAPSOR_REVIEW_PRINCIPAL",
            required: true,
            "x-runner-todo": "Choose the authoritative principal binding and identity verification mode.",
          },
        ],
        tenant_binding: "tenant_id",
        principal_binding: "principal",
        "x-runner-review-status": "blocked_unreviewed",
      },
    ],
    capabilities,
    "x-runner-candidate-only": true,
    "x-runner-review-status": "blocked_unreviewed",
    "x-runner-source-format": parsed.format,
    "x-runner-source-digest": sourceDigest,
  };
  const validation = validateContract(contract);
  if (!validation.ok) {
    throw new Error(`internal schema candidate contract error: ${validation.errors.map((issue) => `${issue.code}@${issue.path}`).join(", ")}`);
  }
  const review = schemaCandidateReview(parsed, sourceDigest, capabilities.length);
  const files = [CONTRACT_FILE, CONFIG_FILE, TEST_FILE, REVIEW_JSON_FILE, REVIEW_FILE];
  const result = {
    format: parsed.format,
    source_digest: sourceDigest,
    objects: parsed.objects.length,
    capabilities: capabilities.length,
    activation: "blocked_unreviewed" as const,
    files: [SCHEMA_CANDIDATE_MARKER, ...files],
  };
  return {
    contract,
    config: candidateRunnerConfig(),
    tests: candidateContractTests(capabilities),
    review,
    reviewMarkdown: reviewMarkdown(review),
    marker: {
      schema_version: SCHEMA_CANDIDATE_VERSION,
      owner: "@synapsor/runner",
      format: parsed.format,
      source_digest: sourceDigest,
      activation: "blocked_unreviewed",
      deterministic: true,
      files,
    },
    result,
  };
}

function buildCapability(
  object: CandidateObject,
  action: CandidateAction,
  objectIndex: number,
  usedNames: Set<string>,
): CapabilitySpec {
  const objectName = safeIdentifier(object.name);
  const proposedName = safeQualifiedName(action.name, action.kind, objectName);
  const name = uniqueName(proposedName, usedNames);
  const primaryKey = object.primary_key_candidates.length === 1
    ? object.primary_key_candidates[0]!
    : "review_required_id";
  const lookupArg = `${objectName}_id`;
  const structuralPrimary = object.fields.find((field) => field.name === primaryKey);
  const args = actionArgs(action.args, lookupArg, structuralPrimary?.type);
  const suggestedVisible = unique([
    primaryKey,
    ...action.visible_candidates,
    ...object.visible_candidates,
  ]).filter(isSafeIdentifier);
  const sensitive = object.sensitive_candidates.filter(isSafeIdentifier);
  const common = {
    name,
    description: action.kind === "proposal"
      ? "TODO: review this exact business action. The candidate is shadow-only and has no writeback authority."
      : "TODO: review this tenant-scoped business read and its minimum output allowlist.",
    kind: action.kind,
    context: "review_candidate_context",
    source: "review_required_source",
    subject: {
      schema: safeIdentifier(object.schema || "public"),
      table: safeIdentifier(object.table || `review_required_object_${objectIndex + 1}`),
      primary_key: isSafeIdentifier(primaryKey) ? primaryKey : "review_required_id",
      tenant_key: "review_required_tenant",
      conflict_key: "review_required_version",
      "x-runner-todo": "Confirm source identifiers, then select one authoritative tenant field or an isolated single-tenant deployment.",
    },
    args,
    lookup: { id_from_arg: Object.prototype.hasOwnProperty.call(args, lookupArg) ? lookupArg : Object.keys(args)[0]! },
    visible_fields: unique([
      isSafeIdentifier(primaryKey) ? primaryKey : "review_required_id",
      "review_required_tenant",
      "review_required_version",
      "review_required_visible_field",
    ]),
    kept_out_fields: unique(["review_required_sensitive_field", ...sensitive]),
    evidence: { required: true, query_audit: true },
    max_rows: 1,
    "x-runner-review-status": "blocked_unreviewed",
    "x-runner-source-hint": action.source_hint,
    "x-runner-suggested-visible-fields": suggestedVisible,
    "x-runner-potential-tenant-fields": object.tenant_candidates,
    "x-runner-potential-principal-fields": object.principal_candidates,
    "x-runner-potential-conflict-fields": object.conflict_candidates,
    "x-runner-todos": [
      "Select tenant/principal authority independently from model input.",
      "Replace visible-field placeholders with the minimum reviewed allowlist.",
      "Confirm potentially sensitive fields using the real data classification.",
      ...object.assumptions,
      ...object.unsupported,
    ],
  } satisfies CapabilitySpec;
  if (action.kind === "read") return common;
  const patchArg = Object.keys(args)[0]!;
  return {
    ...common,
    proposal: {
      action: `${name.replace(".propose_", ".")}_reviewed_action`,
      allowed_fields: ["review_required_write_field"],
      patch: {
        review_required_write_field: { from_arg: patchArg },
      },
      conflict_guard: { column: "review_required_version" },
      approval: {
        mode: "human",
        required_role: "review_required_reviewer",
      },
      writeback: { mode: "none" },
      "x-runner-suggested-allowed-fields": action.allowed_field_candidates,
      "x-runner-handler-required": action.handler_required,
      "x-runner-todo": action.handler_required
        ? "Implement and verify an app-owned handler after review; API semantics cannot be inferred from OpenAPI shape alone."
        : "Choose exact patch bindings, bounds, conflict/version semantics, and writeback only after Shadow evaluation.",
    },
  };
}

function actionArgs(
  fields: CandidateField[],
  fallbackName: string,
  fallbackType: CandidateField["type"] | undefined,
): Record<string, ArgumentSpec> {
  const args: Record<string, ArgumentSpec> = {};
  for (const field of fields) {
    if (!isSafeIdentifier(field.name) || MODEL_AUTHORITY_PATTERN.test(field.name)) continue;
    if (!["string", "number", "boolean"].includes(field.type)) continue;
    args[field.name] = field.type === "string"
      ? { type: "string", required: field.required, max_length: 512 }
      : field.type === "number"
        ? { type: "number", required: field.required }
        : { type: "boolean", required: field.required };
  }
  if (Object.keys(args).length === 0) {
    args[fallbackName] = fallbackType === "number"
      ? { type: "number", required: true }
      : { type: "string", required: true, max_length: 128 };
  }
  return Object.fromEntries(Object.entries(args).sort(([left], [right]) => left.localeCompare(right)));
}

function schemaCandidateReview(
  parsed: ParsedSchema,
  sourceDigest: `sha256:${string}`,
  capabilityCount: number,
): SchemaCandidateReview {
  return {
    schema_version: SCHEMA_CANDIDATE_VERSION,
    format: parsed.format,
    source_digest: sourceDigest,
    activation: "blocked_unreviewed",
    summary: {
      objects: parsed.objects.length,
      fields: parsed.objects.reduce((total, object) => total + object.fields.length, 0),
      capabilities: capabilityCount,
      write_candidates: parsed.objects.flatMap((object) => object.action_candidates).filter((action) => action.kind === "proposal").length,
    },
    warnings: unique([
      "Structure was inferred; tenant authority, principal authority, data sensitivity, allowed reads, and safe writes were not.",
      "Generated writes remain disabled and require Shadow evaluation plus explicit human activation.",
      ...parsed.warnings,
    ]),
    objects: parsed.objects.map((object) => ({
      name: object.name,
      table: `${object.schema}.${object.table}`,
      structural_primary_key_candidates: object.primary_key_candidates,
      potential_tenant_fields: object.tenant_candidates,
      potential_principal_fields: object.principal_candidates,
      potential_conflict_fields: object.conflict_candidates,
      potentially_sensitive_fields: object.sensitive_candidates,
      suggested_kept_out_fields: object.sensitive_candidates,
      suggested_visible_fields: object.visible_candidates,
      possible_actions: object.action_candidates.map((action) => ({
        name: action.name,
        kind: action.kind,
        allowed_field_candidates: action.allowed_field_candidates,
        requires_business_logic: action.kind === "proposal",
        requires_app_owned_handler: action.handler_required,
      })),
      uncertain_assumptions: object.assumptions,
      unsupported_or_dynamic: object.unsupported,
    })),
  };
}

function reviewMarkdown(review: SchemaCandidateReview): string {
  const rows = review.objects.flatMap((object) =>
    object.possible_actions.map((action) =>
      `| \`${object.name}\` | \`${action.name}\` | ${action.kind} | ${action.requires_business_logic ? "yes" : "no"} | ${action.requires_app_owned_handler ? "yes" : "review"} |`,
    ));
  return `# Review ${review.format} capability candidates

This directory is **not active configuration**. It contains structurally
inferred suggestions, not authorization decisions.

- Source digest: \`${review.source_digest}\`
- Objects: ${review.summary.objects}
- Fields: ${review.summary.fields}
- Candidate capabilities: ${review.summary.capabilities}
- Activation: **blocked and unreviewed**

| Object | Possible capability | Kind | Business logic | App handler |
| --- | --- | --- | --- | --- |
${rows.join("\n")}

## Human review required

1. Confirm each source/schema/table and structural primary key.
2. Choose the authoritative tenant and principal bindings. Candidate names are
   hints only; the generator never selects them as authority.
3. Classify sensitive fields and replace the visible-field placeholder with a
   minimum allowlist.
4. Define exact business actions, allowed fields, bounds, conflict guards, and
   approval policy.
5. Keep writes in strict Shadow mode. OpenAPI writes require an app-owned
   handler because an API schema does not define transaction/security behavior.
6. Run the generated deny/redaction tests and a Shadow study.
7. Deliberately copy reviewed definitions into an active contract through code
   review; do not turn this generated directory into production in place.

## Warnings

${review.warnings.map((warning) => `- ${warning}`).join("\n")}
`;
}

function candidateRunnerConfig(): Record<string, unknown> {
  return {
    version: 1,
    mode: "shadow",
    storage: { sqlite_path: "./.synapsor/candidate-shadow.db" },
    sources: {},
    trusted_context: {
      provider: "environment",
      values: {
        tenant_id_env: "SYNAPSOR_REVIEW_TENANT_ID",
        principal_env: "SYNAPSOR_REVIEW_PRINCIPAL",
      },
    },
    contexts: {
      review_candidate_context: {
        provider: "environment",
        values: {
          tenant_id_env: "SYNAPSOR_REVIEW_TENANT_ID",
          principal_env: "SYNAPSOR_REVIEW_PRINCIPAL",
        },
      },
    },
    contracts: [`./${CONTRACT_FILE}`],
    capabilities: [],
  };
}

function candidateContractTests(capabilities: CapabilitySpec[]): Record<string, unknown> {
  return {
    version: 1,
    name: "Generated schema/API deny and redaction checks - review placeholders first",
    tests: capabilities.flatMap((capability, index) => {
      const lookup = capability.lookup?.id_from_arg ?? Object.keys(capability.args)[0]!;
      return [
        {
          id: `candidate_${index + 1}_operator_boundary`,
          kind: "operator_boundary",
          capability: capability.name,
        },
        {
          id: `candidate_${index + 1}_hide_fields`,
          kind: "hide_fields",
          capability: capability.name,
          fields: capability.kept_out_fields,
        },
        {
          id: `candidate_${index + 1}_cross_tenant_deny`,
          kind: "tool_deny",
          capability: capability.name,
          args: { [lookup]: sampleArg(capability.args[lookup]) },
          trusted_context: {
            tenant_id: "REVIEW_TENANT_A",
            principal: "REVIEW_PRINCIPAL_A",
            provenance: "static_dev",
          },
          expected_code: "NOT_FOUND_IN_TENANT",
        },
      ];
    }),
  };
}

function sampleArg(arg: ArgumentSpec | undefined): string | number | boolean {
  if (arg?.type === "number") return 1;
  if (arg?.type === "boolean") return true;
  return "REVIEW_OTHER_TENANT_OBJECT";
}

function parsePrismaSchema(source: string): ParsedSchema {
  const tokens = lexPrisma(source);
  const rawModels: Array<{
    name: string;
    table?: string;
    fields: CandidateField[];
    primary: string[];
    unsupported: string[];
  }> = [];
  let engine: "postgres" | "mysql" | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind === "identifier" && token.value === "provider" && tokens[index + 1]?.value === "=") {
      const provider = tokens[index + 2];
      if (provider?.kind === "string") {
        if (provider.value === "postgresql") engine = "postgres";
        if (provider.value === "mysql") engine = "mysql";
      }
    }
    if (token.kind !== "identifier" || token.value !== "model") continue;
    const nameToken = tokens[index + 1];
    const open = tokens[index + 2];
    if (nameToken?.kind !== "identifier" || open?.value !== "{") {
      throw new Error(`Prisma model declaration near line ${token.line} is not statically parseable`);
    }
    const { body, end } = prismaBlock(tokens, index + 2);
    index = end;
    rawModels.push(parsePrismaModel(nameToken.value, body));
    if (rawModels.length > MAX_OBJECTS) throw new Error(`Prisma input exceeds ${MAX_OBJECTS} models`);
  }
  const modelNames = new Set(rawModels.map((model) => model.name));
  const objects = rawModels.map((model) => {
    const fields = model.fields.filter((field) => !modelNames.has(field.source_type ?? ""));
    return objectFromFields({
      name: model.name,
      table: model.table ?? model.name,
      schema: "public",
      engine,
      fields,
      primary: model.primary,
      assumptions: [
        "Prisma model/table mapping is structural; it does not prove database grants, RLS, or business authorization.",
      ],
      unsupported: model.unsupported,
      sourceHint: `prisma:model:${model.name}`,
    });
  });
  return {
    format: "prisma",
    objects,
    warnings: [
      "Prisma datasource URLs, defaults, enum values, generators, and plugins were not copied or executed.",
      ...(engine ? [] : ["Datasource engine was not statically recognized; confirm Postgres/MySQL separately."]),
    ],
  };
}

type PrismaToken = {
  kind: "identifier" | "string" | "symbol" | "newline";
  value: string;
  line: number;
};

function lexPrisma(source: string): PrismaToken[] {
  const tokens: PrismaToken[] = [];
  let index = 0;
  let line = 1;
  const push = (kind: PrismaToken["kind"], value: string) => {
    tokens.push({ kind, value, line });
    if (tokens.length > MAX_AST_NODES) throw new Error(`Prisma input exceeds ${MAX_AST_NODES} tokens`);
  };
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\n") {
      push("newline", "\n");
      line += 1;
      index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") line += 1;
        index += 1;
      }
      if (index >= source.length) throw new Error("Unterminated Prisma block comment");
      index += 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = "";
      index += 1;
      let closed = false;
      while (index < source.length) {
        const current = source[index]!;
        if (current === "\\") {
          index += 1;
          if (index < source.length) value += source[index]!;
          index += 1;
          continue;
        }
        if (current === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (current === "\n") line += 1;
        value += current;
        index += 1;
      }
      if (!closed) throw new Error("Unterminated Prisma string");
      push("string", value);
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const start = index;
      index += 1;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) index += 1;
      push("identifier", source.slice(start, index));
      continue;
    }
    push("symbol", char);
    index += 1;
  }
  return tokens;
}

function prismaBlock(tokens: PrismaToken[], openIndex: number): { body: PrismaToken[]; end: number } {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index]!.value === "{") depth += 1;
    if (tokens[index]!.value === "}") {
      depth -= 1;
      if (depth === 0) return { body: tokens.slice(openIndex + 1, index), end: index };
    }
    if (depth > 64) throw new Error("Prisma nesting exceeds 64 levels");
  }
  throw new Error("Unterminated Prisma model block");
}

function parsePrismaModel(
  name: string,
  body: PrismaToken[],
): { name: string; table?: string; fields: CandidateField[]; primary: string[]; unsupported: string[] } {
  const lines = splitPrismaLines(body);
  const fields: CandidateField[] = [];
  const primary: string[] = [];
  const unsupported: string[] = [];
  let table: string | undefined;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line[0]?.value === "@" && line[1]?.value === "@") {
      const attribute = line[2]?.value;
      if (attribute === "map") {
        const mapped = firstStringToken(line);
        if (mapped && isSafeIdentifier(mapped)) table = mapped;
        else unsupported.push("@@map uses a non-identifier table name; replace the table placeholder manually.");
      } else if (attribute === "id") {
        primary.push(...prismaBracketIdentifiers(line));
      } else if (!["index", "unique", "schema"].includes(attribute ?? "")) {
        unsupported.push(`Unsupported Prisma model attribute @@${attribute ?? "unknown"}.`);
      }
      continue;
    }
    const fieldName = line[0];
    const fieldType = line[1];
    if (fieldName?.kind !== "identifier" || fieldType?.kind !== "identifier") {
      unsupported.push("A dynamic or unsupported Prisma field declaration was skipped.");
      continue;
    }
    const array = line.some((token, index) => token.value === "[" && line[index + 1]?.value === "]");
    const optional = line.some((token) => token.value === "?");
    const attributes = prismaFieldAttributes(line.slice(2));
    const mapped = attributes.map;
    const columnName = mapped && isSafeIdentifier(mapped) ? mapped : safeIdentifier(fieldName.value);
    const type = array ? "array" : prismaScalarType(fieldType.value);
    const primaryKey = attributes.id === true;
    if (primaryKey) primary.push(columnName);
    fields.push({
      name: columnName,
      type,
      source_type: fieldType.value,
      required: !optional && !array,
      primary_key: primaryKey,
      unique: primaryKey || attributes.unique === true,
      generated: attributes.generated === true,
      sensitive: SENSITIVE_PATTERN.test(columnName),
    });
    if (fields.length > MAX_FIELDS_PER_OBJECT) throw new Error(`Prisma model ${name} exceeds ${MAX_FIELDS_PER_OBJECT} fields`);
  }
  return { name: safeIdentifier(name), table, fields, primary: unique(primary), unsupported: unique(unsupported) };
}

function splitPrismaLines(tokens: PrismaToken[]): PrismaToken[][] {
  const lines: PrismaToken[][] = [];
  let current: PrismaToken[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (token.value === "(" || token.value === "[") depth += 1;
    if (token.value === ")" || token.value === "]") depth = Math.max(0, depth - 1);
    if (token.kind === "newline" && depth === 0) {
      if (current.length) lines.push(current);
      current = [];
    } else if (token.kind !== "newline") {
      current.push(token);
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

function prismaFieldAttributes(tokens: PrismaToken[]): {
  id?: boolean;
  unique?: boolean;
  generated?: boolean;
  map?: string;
} {
  const result: { id?: boolean; unique?: boolean; generated?: boolean; map?: string } = {};
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index]?.value !== "@" || tokens[index + 1]?.kind !== "identifier") continue;
    const name = tokens[index + 1]!.value;
    if (name === "id") result.id = true;
    if (name === "unique") result.unique = true;
    if (name === "updatedAt") result.generated = true;
    if (name === "default") result.generated = true;
    if (name === "map") {
      const segment = tokens.slice(index + 2);
      const mapped = firstStringToken(segment);
      if (mapped && isSafeIdentifier(mapped)) result.map = mapped;
    }
  }
  return result;
}

function prismaBracketIdentifiers(tokens: PrismaToken[]): string[] {
  const open = tokens.findIndex((token) => token.value === "[");
  const close = tokens.findIndex((token, index) => index > open && token.value === "]");
  if (open < 0 || close < 0) return [];
  return tokens.slice(open + 1, close)
    .filter((token) => token.kind === "identifier")
    .map((token) => safeIdentifier(token.value));
}

function firstStringToken(tokens: PrismaToken[]): string | undefined {
  return tokens.find((token) => token.kind === "string")?.value;
}

function prismaScalarType(value: string): CandidateField["type"] {
  if (["Int", "BigInt", "Float", "Decimal"].includes(value)) return "number";
  if (value === "Boolean") return "boolean";
  if (["String", "DateTime", "Json", "Bytes"].includes(value)) return "string";
  return "object";
}

function parseDrizzleSchema(source: string, sourceName: string): ParsedSchema {
  const file = ts.createSourceFile(sourceName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parseDiagnostics = (file as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length > 0) {
    throw new Error(`Drizzle TypeScript parse failed: ${parseDiagnostics[0]!.messageText}`);
  }
  let nodeCount = 0;
  const objects: CandidateObject[] = [];
  const warnings: string[] = [
    "Drizzle input was parsed as TypeScript AST only; it was not imported, transpiled, type-checked, or executed.",
  ];
  const visit = (node: ts.Node) => {
    nodeCount += 1;
    if (nodeCount > MAX_AST_NODES) throw new Error(`Drizzle input exceeds ${MAX_AST_NODES} AST nodes`);
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
      const parsed = parseDrizzleTable(node, node.initializer);
      if (parsed) {
        objects.push(parsed);
        if (objects.length > MAX_OBJECTS) throw new Error(`Drizzle input exceeds ${MAX_OBJECTS} static tables`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (objects.length === 0) {
    warnings.push("No supported static pgTable/mysqlTable object literal was found.");
  }
  return { format: "drizzle", objects, warnings };
}

function parseDrizzleTable(node: ts.VariableDeclaration, call: ts.CallExpression): CandidateObject | undefined {
  const callee = ts.isIdentifier(call.expression) ? call.expression.text : undefined;
  if (callee !== "pgTable" && callee !== "mysqlTable") return undefined;
  const engine = callee === "pgTable" ? "postgres" : "mysql";
  const tableArg = call.arguments[0];
  const fieldsArg = call.arguments[1];
  const variableName = ts.isIdentifier(node.name) ? node.name.text : "review_object";
  const unsupported: string[] = [];
  if (!tableArg || !ts.isStringLiteralLike(tableArg) || !isSafeIdentifier(tableArg.text)) {
    throw new Error(`Drizzle table ${variableName} requires a static identifier string as its first argument`);
  }
  if (!fieldsArg || !ts.isObjectLiteralExpression(fieldsArg)) {
    throw new Error(`Drizzle table ${variableName} must use a static object literal as its second argument`);
  }
  const fields: CandidateField[] = [];
  for (const property of fieldsArg.properties) {
    if (!ts.isPropertyAssignment(property)) {
      unsupported.push("Spread, shorthand, getter, and computed Drizzle column definitions are unsupported.");
      continue;
    }
    const propertyName = staticPropertyName(property.name);
    if (!propertyName) {
      unsupported.push("Dynamic Drizzle property name is unsupported.");
      continue;
    }
    const column = parseDrizzleColumn(property.initializer, propertyName);
    if (!column) {
      unsupported.push(`Column ${propertyName} uses a dynamic or unsupported builder expression.`);
      continue;
    }
    fields.push(column);
    if (fields.length > MAX_FIELDS_PER_OBJECT) throw new Error(`Drizzle table ${variableName} exceeds ${MAX_FIELDS_PER_OBJECT} fields`);
  }
  if (call.arguments.length > 2) {
    unsupported.push("Drizzle table-level index/constraint callback was not executed; verify composite keys and indexes manually.");
  }
  return objectFromFields({
    name: safeIdentifier(variableName),
    schema: "public",
    table: tableArg.text,
    engine,
    fields,
    primary: fields.filter((field) => field.primary_key).map((field) => field.name),
    assumptions: [
      "Drizzle builder structure does not prove deployed migrations, grants, RLS, or business authorization.",
    ],
    unsupported,
    sourceHint: `drizzle:${variableName}`,
  });
}

function parseDrizzleColumn(expression: ts.Expression, propertyName: string): CandidateField | undefined {
  const methods: string[] = [];
  let current: ts.Expression = expression;
  while (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression)) {
    methods.push(current.expression.name.text);
    current = current.expression.expression;
  }
  if (!ts.isCallExpression(current) || !ts.isIdentifier(current.expression)) return undefined;
  const builder = current.expression.text;
  const supportedBuilders = new Set([
    "text", "varchar", "char", "uuid", "serial", "bigserial", "integer", "smallint",
    "bigint", "numeric", "decimal", "real", "doublePrecision", "boolean", "timestamp",
    "date", "datetime", "json", "jsonb", "mysqlEnum", "pgEnum",
  ]);
  if (!supportedBuilders.has(builder)) return undefined;
  const firstArg = current.arguments[0];
  const columnName = firstArg && ts.isStringLiteralLike(firstArg) && isSafeIdentifier(firstArg.text)
    ? firstArg.text
    : safeIdentifier(propertyName);
  const type: CandidateField["type"] =
    ["serial", "bigserial", "integer", "smallint", "bigint", "numeric", "decimal", "real", "doublePrecision"].includes(builder)
      ? "number"
      : builder === "boolean"
        ? "boolean"
        : "string";
  const primary = methods.includes("primaryKey");
  return {
    name: columnName,
    type,
    required: primary || methods.includes("notNull"),
    primary_key: primary,
    unique: primary || methods.includes("unique"),
    generated: methods.some((method) => ["default", "defaultNow", "$default", "$defaultFn"].includes(method))
      || ["serial", "bigserial"].includes(builder),
    sensitive: SENSITIVE_PATTERN.test(columnName),
  };
}

function staticPropertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    const value = name.text;
    return isSafeIdentifier(value) ? value : undefined;
  }
  return undefined;
}

function parseOpenApiDocument(source: string, sourceName: string): ParsedSchema {
  let document: unknown;
  if (/\.ya?ml$/i.test(sourceName) || !source.trimStart().startsWith("{")) {
    const parsed = parseDocument(source, {
      uniqueKeys: true,
      strict: true,
    });
    if (parsed.errors.length) throw new Error(`OpenAPI YAML parse failed: ${parsed.errors[0]!.message}`);
    document = parsed.toJS({ maxAliasCount: 0 });
  } else {
    document = JSON.parse(source);
  }
  if (!isRecord(document)) throw new Error("OpenAPI document must be an object");
  if (typeof document.openapi !== "string" || !/^3\./.test(document.openapi)) {
    throw new Error("Only OpenAPI 3.x documents are supported");
  }
  assertBoundedStructure(document);
  assertNoExternalRefs(document);
  const components = isRecord(document.components) && isRecord(document.components.schemas)
    ? document.components.schemas
    : {};
  const paths = isRecord(document.paths) ? document.paths : {};
  const actionsByObject = new Map<string, CandidateAction[]>();
  const warnings: string[] = [
    "OpenAPI was parsed locally; server URLs, examples, defaults, enum values, callbacks, webhooks, and security credentials were not copied.",
    "OpenAPI writes require an app-owned handler because API transaction and authorization behavior cannot be inferred from shape.",
  ];
  const methods = new Set(["get", "post", "put", "patch", "delete"]);
  for (const [rawPath, pathItem] of Object.entries(paths)) {
    if (!rawPath.startsWith("/") || !isRecord(pathItem)) continue;
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!methods.has(method.toLowerCase()) || !isRecord(operation)) continue;
      const kind = method.toLowerCase() === "get" ? "read" as const : "proposal" as const;
      const operationName = typeof operation.operationId === "string"
        ? safeIdentifier(operation.operationId)
        : safeIdentifier(`${method}_${rawPath}`);
      const objectName = openApiObjectName(operation, rawPath);
      const parameters = [
        ...(Array.isArray(pathItem.parameters) ? pathItem.parameters : []),
        ...(Array.isArray(operation.parameters) ? operation.parameters : []),
      ];
      const parameterFields = parameters
        .map((parameter) => openApiParameterField(parameter, components))
        .filter((field): field is CandidateField => Boolean(field));
      const requestFields = openApiRequestFields(operation, components);
      const responseFields = openApiResponseFields(operation, components);
      const args = uniqueFields([...parameterFields, ...requestFields]);
      const action: CandidateAction = {
        name: `${safeIdentifier(objectName)}.${kind === "read" ? "inspect" : "propose"}_${operationName}`,
        kind,
        args,
        visible_candidates: responseFields.filter((field) => !field.sensitive).map((field) => field.name),
        allowed_field_candidates: kind === "proposal"
          ? requestFields.filter((field) => !MODEL_AUTHORITY_PATTERN.test(field.name)).map((field) => field.name)
          : [],
        handler_required: kind === "proposal",
        source_hint: `openapi:${method.toUpperCase()} ${rawPath}`,
      };
      const list = actionsByObject.get(objectName) ?? [];
      list.push(action);
      actionsByObject.set(objectName, list);
      if ([...actionsByObject.values()].flat().length > MAX_CAPABILITIES) {
        throw new Error(`OpenAPI input exceeds ${MAX_CAPABILITIES} supported operations`);
      }
    }
  }
  const objects = [...actionsByObject.entries()].map(([name, actions], index) => {
    const fields = uniqueFields(actions.flatMap((action) => [...action.args, ...action.visible_candidates.map(fieldFromName)]));
    return objectFromFields({
      name,
      schema: "review_required_schema",
      table: `review_required_api_object_${index + 1}`,
      fields,
      primary: fields.filter((field) => PRIMARY_PATTERN.test(field.name)).map((field) => field.name).slice(0, 1),
      assumptions: [
        "OpenAPI path/operation shape does not prove a database table, tenant boundary, or authorization policy.",
      ],
      unsupported: [
        ...(document.callbacks ? ["Top-level callbacks are not inspected."] : []),
        ...(document.webhooks ? ["OpenAPI webhooks are not inspected."] : []),
      ],
      sourceHint: `openapi:object:${name}`,
      actionCandidates: actions,
    });
  });
  return { format: "openapi", objects, warnings };
}

function openApiObjectName(operation: Record<string, unknown>, rawPath: string): string {
  const tags = Array.isArray(operation.tags) ? operation.tags.filter((tag): tag is string => typeof tag === "string") : [];
  if (tags[0]) return safeIdentifier(tags[0]);
  const segment = rawPath.split("/").find((part) => part && !part.startsWith("{"));
  return safeIdentifier(segment ?? "api_object");
}

function openApiParameterField(
  parameter: unknown,
  components: Record<string, unknown>,
): CandidateField | undefined {
  const resolved = resolveOpenApiSchema(parameter, components);
  if (!isRecord(resolved) || typeof resolved.name !== "string") return undefined;
  const schema = resolveOpenApiSchema(resolved.schema, components);
  return candidateFieldFromOpenApi(resolved.name, schema, resolved.required === true);
}

function openApiRequestFields(operation: Record<string, unknown>, components: Record<string, unknown>): CandidateField[] {
  if (!isRecord(operation.requestBody)) return [];
  const body = resolveOpenApiSchema(operation.requestBody, components);
  if (!isRecord(body) || !isRecord(body.content)) return [];
  const media = body.content["application/json"] ?? body.content["application/*+json"];
  if (!isRecord(media)) return [];
  return openApiSchemaFields(media.schema, components);
}

function openApiResponseFields(operation: Record<string, unknown>, components: Record<string, unknown>): CandidateField[] {
  if (!isRecord(operation.responses)) return [];
  const response = Object.entries(operation.responses)
    .filter(([status]) => /^2\d\d$/.test(status))
    .sort(([left], [right]) => left.localeCompare(right))[0]?.[1];
  const resolved = resolveOpenApiSchema(response, components);
  if (!isRecord(resolved) || !isRecord(resolved.content)) return [];
  const media = resolved.content["application/json"] ?? resolved.content["application/*+json"];
  if (!isRecord(media)) return [];
  return openApiSchemaFields(media.schema, components);
}

function openApiSchemaFields(schema: unknown, components: Record<string, unknown>, depth = 0): CandidateField[] {
  if (depth > 8) return [];
  const resolved = resolveOpenApiSchema(schema, components);
  if (!isRecord(resolved)) return [];
  if (resolved.type === "array" && isRecord(resolved.items)) {
    return openApiSchemaFields(resolved.items, components, depth + 1);
  }
  if (!isRecord(resolved.properties)) return [];
  const required = new Set(Array.isArray(resolved.required)
    ? resolved.required.filter((value): value is string => typeof value === "string")
    : []);
  return Object.entries(resolved.properties)
    .slice(0, MAX_FIELDS_PER_OBJECT)
    .map(([name, property]) => candidateFieldFromOpenApi(name, resolveOpenApiSchema(property, components), required.has(name)))
    .filter((field): field is CandidateField => Boolean(field));
}

function candidateFieldFromOpenApi(name: string, schema: unknown, required: boolean): CandidateField | undefined {
  if (!isSafeIdentifier(name) || !isRecord(schema)) return undefined;
  const type: CandidateField["type"] =
    schema.type === "integer" || schema.type === "number"
      ? "number"
      : schema.type === "boolean"
        ? "boolean"
        : schema.type === "array"
          ? "array"
          : schema.type === "object" || schema.properties
            ? "object"
            : schema.type === "string" || schema.type === undefined
              ? "string"
              : "unknown";
  return {
    name,
    type,
    required,
    primary_key: PRIMARY_PATTERN.test(name) && (schema.readOnly === true || /id$/i.test(name)),
    unique: false,
    generated: schema.readOnly === true,
    sensitive: SENSITIVE_PATTERN.test(name) || schema.writeOnly === true,
  };
}

function resolveOpenApiSchema(value: unknown, components: Record<string, unknown>): unknown {
  if (!isRecord(value) || typeof value.$ref !== "string") return value;
  const prefix = "#/components/schemas/";
  if (!value.$ref.startsWith(prefix)) throw new Error(`External or unsupported OpenAPI reference is forbidden: ${value.$ref}`);
  const name = value.$ref.slice(prefix.length);
  if (!isSafeIdentifier(name) || !Object.prototype.hasOwnProperty.call(components, name)) {
    throw new Error(`OpenAPI schema reference not found: ${value.$ref}`);
  }
  return components[name];
}

function assertNoExternalRefs(value: unknown): void {
  const stack: unknown[] = [value];
  let count = 0;
  while (stack.length) {
    const current = stack.pop();
    count += 1;
    if (count > MAX_STRUCTURE_NODES) throw new Error(`OpenAPI structure exceeds ${MAX_STRUCTURE_NODES} nodes`);
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (!isRecord(current)) continue;
    if (typeof current.$ref === "string" && !current.$ref.startsWith("#/components/schemas/")) {
      throw new Error(`External or unsupported OpenAPI reference is forbidden: ${current.$ref}`);
    }
    stack.push(...Object.values(current));
  }
}

function assertBoundedStructure(value: unknown): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const current = stack.pop()!;
    count += 1;
    if (count > MAX_STRUCTURE_NODES) throw new Error(`OpenAPI structure exceeds ${MAX_STRUCTURE_NODES} nodes`);
    if (current.depth > 32) throw new Error("OpenAPI nesting exceeds 32 levels");
    if (Array.isArray(current.value)) {
      for (const child of current.value) stack.push({ value: child, depth: current.depth + 1 });
    } else if (isRecord(current.value)) {
      for (const child of Object.values(current.value)) stack.push({ value: child, depth: current.depth + 1 });
    }
  }
}

function objectFromFields(input: {
  name: string;
  schema: string;
  table: string;
  engine?: "postgres" | "mysql";
  fields: CandidateField[];
  primary: string[];
  assumptions: string[];
  unsupported: string[];
  sourceHint: string;
  actionCandidates?: CandidateAction[];
}): CandidateObject {
  const fields = uniqueFields(input.fields).slice(0, MAX_FIELDS_PER_OBJECT);
  const primaryCandidates = unique(input.primary.filter(isSafeIdentifier));
  const tenant = fields.filter((field) => TENANT_PATTERN.test(field.name)).map((field) => field.name);
  const principal = fields.filter((field) => PRINCIPAL_PATTERN.test(field.name)).map((field) => field.name);
  const conflict = fields.filter((field) => CONFLICT_PATTERN.test(field.name)).map((field) => field.name);
  const sensitive = fields.filter((field) => field.sensitive).map((field) => field.name);
  const visible = fields
    .filter((field) => !field.sensitive)
    .filter((field) => field.type !== "object" && field.type !== "array" && field.type !== "unknown")
    .map((field) => field.name);
  const objectName = safeIdentifier(input.name);
  const defaultArgs = primaryCandidates.length === 1
    ? [fields.find((field) => field.name === primaryCandidates[0]) ?? fieldFromName(`${objectName}_id`)]
    : [fieldFromName(`${objectName}_id`)];
  const actions = input.actionCandidates ?? [
    {
      name: `${objectName}.inspect_${objectName}`,
      kind: "read",
      args: defaultArgs,
      visible_candidates: visible,
      allowed_field_candidates: [],
      handler_required: false,
      source_hint: input.sourceHint,
    },
    {
      name: `${objectName}.propose_${objectName}_update`,
      kind: "proposal",
      args: defaultArgs,
      visible_candidates: visible,
      allowed_field_candidates: fields
        .filter((field) => !field.primary_key && !field.generated && !field.sensitive)
        .filter((field) => !tenant.includes(field.name) && !principal.includes(field.name))
        .map((field) => field.name),
      handler_required: false,
      source_hint: input.sourceHint,
    },
  ];
  return {
    name: objectName,
    schema: safeIdentifier(input.schema),
    table: safeIdentifier(input.table),
    ...(input.engine ? { engine: input.engine } : {}),
    fields,
    primary_key_candidates: primaryCandidates,
    tenant_candidates: tenant,
    principal_candidates: principal,
    conflict_candidates: conflict,
    sensitive_candidates: sensitive,
    visible_candidates: visible,
    action_candidates: actions,
    assumptions: unique([
      ...(primaryCandidates.length === 1
        ? []
        : ["A single structural primary key was not proven; review_required_id remains a placeholder."]),
      ...(tenant.length ? ["Tenant-like field names are suggestions only and were not selected as authority."] : ["No tenant-like field was found; choose an isolated deployment or reviewed tenant key."]),
      ...(conflict.length ? ["Version-like field names are suggestions only and were not selected as the conflict guard."] : ["No version-like field was found; define an exact concurrency strategy before writes."]),
      ...input.assumptions,
    ]),
    unsupported: unique(input.unsupported),
  };
}

function fieldFromName(name: string): CandidateField {
  return {
    name: safeIdentifier(name),
    type: "string",
    required: true,
    primary_key: PRIMARY_PATTERN.test(name),
    unique: false,
    generated: false,
    sensitive: SENSITIVE_PATTERN.test(name),
  };
}

function uniqueFields(fields: CandidateField[]): CandidateField[] {
  const byName = new Map<string, CandidateField>();
  for (const field of fields) {
    const name = safeIdentifier(field.name);
    const current = byName.get(name);
    byName.set(name, current
      ? {
          ...current,
          required: current.required || field.required,
          primary_key: current.primary_key || field.primary_key,
          unique: current.unique || field.unique,
          generated: current.generated || field.generated,
          sensitive: current.sensitive || field.sensitive,
        }
      : { ...field, name });
  }
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function readBoundedInput(inputPath: string): Promise<string> {
  const stat = await fs.stat(inputPath);
  if (!stat.isFile()) throw new Error(`candidate input must be a regular file: ${inputPath}`);
  if (stat.size > MAX_INPUT_BYTES) throw new Error(`candidate input exceeds ${MAX_INPUT_BYTES} bytes`);
  const source = await fs.readFile(inputPath, "utf8");
  if (Buffer.byteLength(source, "utf8") > MAX_INPUT_BYTES) throw new Error(`candidate input exceeds ${MAX_INPUT_BYTES} bytes`);
  return source;
}

async function assertOwnedDirectory(directory: string): Promise<void> {
  try {
    const marker = await readManagedOutputMarker(directory, SCHEMA_CANDIDATE_MARKER);
    if (marker.schema_version !== SCHEMA_CANDIDATE_VERSION || marker.owner !== "@synapsor/runner") {
      throw new Error("marker mismatch");
    }
  } catch {
    throw new Error(`refusing to overwrite non-generated directory: ${directory}`);
  }
}

function safeQualifiedName(value: string, kind: "read" | "proposal", objectName: string): string {
  const pieces = value.split(".").map(safeIdentifier).filter(Boolean);
  const namespace = pieces.length > 1 ? pieces[0]! : objectName;
  let action = pieces.length > 1 ? pieces.slice(1).join("_") : pieces[0] ?? objectName;
  if (kind === "read" && !/^(inspect|read|get|list|search|lookup)_/.test(action)) action = `inspect_${action}`;
  if (kind === "proposal" && !/^propose_/.test(action)) action = `propose_${action}`;
  return `${namespace}.${action}`;
}

function uniqueName(value: string, used: Set<string>): string {
  let candidate = value;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${value}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function safeIdentifier(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (!normalized) return "review_required";
  return /^[a-z_]/.test(normalized) ? normalized : `field_${normalized}`;
}

function isSafeIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value);
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort();
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}
