import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import {
  assertValidContract,
  normalizeContract,
  type CapabilitySpec,
  type SynapsorContract,
} from "@synapsor/spec";
import {
  explainContract,
  formatContractExplanation,
  formatContractLint,
  lintContract,
  type ContractLintIssue,
} from "./contract-tools.js";
import {
  approvalBoundarySnapshot,
  formatContractTestReport,
  proposalEffectSnapshot,
  runContractTests,
  trustedScopeSnapshot,
} from "./contract-testing.js";
import { detectProjectContext } from "./project-detection.js";
import type { ProjectDetectionSummary } from "./onboarding-artifacts.js";
import { writeSafeActionAgentInstructions } from "./safe-action-instructions.js";

type JsonRecord = Record<string, unknown>;

const draftSchemaVersion = "synapsor.safe-action-draft.v1" as const;
const activeSchemaVersion = "synapsor.safe-action-active.v1" as const;
const pointerSchemaVersion = "synapsor.safe-action-pointer.v1" as const;
const liveContractTestKinds = new Set([
  "tool_allow",
  "tool_deny",
  "cross_principal_deny",
  "source_unchanged_before_approval",
]);
const forbiddenModelArgs = new Set([
  "tenant_id",
  "tenantId",
  "principal",
  "principal_id",
  "principalId",
  "source_id",
  "sourceId",
  "table",
  "table_name",
  "schema",
  "column",
  "columns",
  "where",
  "sql",
  "query",
  "approval",
  "approved",
  "apply",
]);
const unresolvedPattern = /(?:__REVIEW_[A-Z0-9_]+__|\bTODO\b|\bTBD\b|REVIEW_REQUIRED)/i;

export type SafeActionDiagnostic = {
  severity: "error" | "warning";
  code: string;
  message: string;
  path?: string;
  source?: string;
};

export type SafeActionDraftManifest = {
  schema_version: typeof draftSchemaVersion;
  state: "disabled_draft" | "activated";
  action_name: string;
  source_path: string;
  source_digest: `sha256:${string}`;
  base_contract_path: string;
  base_contract_digest: `sha256:${string}`;
  draft_contract_path: string;
  draft_contract_digest: `sha256:${string}`;
  generated_tests_path: string;
  generated_at: string;
  diagnostics: SafeActionDiagnostic[];
  unresolved_authority: string[];
  validation: {
    ok: boolean;
    lint_report_path: string;
    explanation_path: string;
    static_tests_path: string;
    static_test_report_path: string;
    lint_summary: { errors: number; warnings: number; info: number };
    blocking_lint_issues: number;
    static_test_summary: { passed: number; failed: number; total: number };
    live_tests_pending: string[];
  };
  effect_preview?: {
    draft_contract_digest: `sha256:${string}`;
    proposal_id: string;
    proposal_hash: string;
    source_database_changed: false;
    previewed_at: string;
  };
  activated_at?: string;
};

export type SafeActionActiveManifest = {
  schema_version: typeof activeSchemaVersion;
  state: "active";
  action_name: string;
  contract_path: string;
  contract_digest: `sha256:${string}`;
  source_path: string;
  source_digest: `sha256:${string}`;
  activated_at: string;
  previous_contract_path: string;
  previous_contract_digest: `sha256:${string}`;
};

export type SafeActionStatus = {
  draft?: SafeActionDraftManifest;
  active?: SafeActionActiveManifest;
  preview_args?: JsonRecord;
  draft_matches_active: boolean;
};

export type SafeActionScaffold = {
  action_name: string;
  source_path: string;
  base_contract_path: string;
  based_on_capability: string;
  project_context: ProjectDetectionSummary;
  instructions: { canonical: string; codex: string; claude: string };
  authority_questions: Array<{ field: string; question: string; source: string }>;
};

export async function scaffoldSafeAction(input: {
  projectRoot?: string;
  configPath?: string;
  actionName: string;
  description: string;
  basedOnCapability?: string;
  force?: boolean;
}): Promise<SafeActionScaffold> {
  const projectRoot = await realProjectRoot(input.projectRoot);
  const projectContext = await detectProjectContext(projectRoot);
  const configPath = await containedInputPath(projectRoot, input.configPath ?? "synapsor.runner.json", "Runner config");
  const rawConfig = await readJsonRecord(configPath, "Runner config");
  const contractReferences = rawConfig.contracts;
  if (!Array.isArray(contractReferences) || contractReferences.length !== 1 || typeof contractReferences[0] !== "string") {
    throw new Error("SAFE_ACTION_SINGLE_CONTRACT_REQUIRED: Safe Action authoring currently requires exactly one active canonical contract reference.");
  }
  const contractPath = await containedInputPath(path.dirname(configPath), contractReferences[0], "active canonical contract");
  const contract = normalizeContract(await readJson(contractPath, "active canonical contract"));
  const readable = contract.capabilities.filter((capability) => capability.kind === "read");
  const basedOn = input.basedOnCapability
    ? readable.find((capability) => capability.name === input.basedOnCapability)
    : readable.length === 1 ? readable[0] : undefined;
  if (!basedOn) {
    const choices = readable.map((capability) => capability.name).join(", ") || "none";
    throw new Error(`SAFE_ACTION_BASE_READ_REQUIRED: choose one reviewed read capability with --based-on <name>. Available: ${choices}`);
  }
  if (!basedOn.source) throw new Error(`SAFE_ACTION_SOURCE_REQUIRED: ${basedOn.name} does not declare a source.`);
  const resource = basedOn.subject.resource ? contract.resources?.find((item) => item.name === basedOn.subject.resource) : undefined;
  const actionName = normalizeActionName(input.actionName, basedOn.name);
  const slug = safeSlug(actionName);
  const sourcePath = path.join(projectRoot, "synapsor", "actions", `${slug}.ts`);
  const conflictSuggestion = basedOn.subject.conflict_key ?? resource?.conflict_key;
  const source = renderSafeActionScaffold({
    actionName,
    businessAction: input.actionName,
    description: input.description,
    basedOn,
    conflictSuggestion,
  });
  await writeNewText(sourcePath, source, input.force === true);
  const authorityQuestions = [
    { field: "proposal.operation", question: "Which one reviewed write operation is intended?", source: "developer business intent; never inferred from table structure" },
    { field: "proposal.allowed_fields / patch", question: "Which exact columns and values may this action change?", source: "developer review; never inferred from writable columns" },
    { field: "proposal.conflict_guard", question: "Which field proves the row has not changed since review?", source: conflictSuggestion ? `structural suggestion from active resource: ${conflictSuggestion}` : "developer review required; no structural suggestion found" },
    { field: "proposal.approval", question: "Which human role or already-reviewed policy must approve?", source: "developer/operator authority; never inferred" },
    { field: "proposal.writeback", question: "Does guarded direct SQL or an app-owned executor own the final effect?", source: "developer/operator authority; never inferred" },
  ];
  const composerPath = path.join(projectRoot, ".synapsor", "composer.json");
  const instructions = await writeSafeActionAgentInstructions(projectRoot);
  await writeJsonAtomic(composerPath, {
    schema_version: "synapsor.safe-action-composer.v1",
    state: "awaiting_agent_draft",
    action_name: actionName,
    source_path: relativeProjectPath(projectRoot, sourcePath),
    base_contract_path: relativeProjectPath(projectRoot, contractPath),
    base_contract_digest: canonicalJsonDigest(contract),
    based_on_capability: basedOn.name,
    project_context: projectContext,
    instructions,
    inherited_boundary: {
      context: basedOn.context,
      source: basedOn.source,
      subject: basedOn.subject,
      visible_fields: basedOn.visible_fields,
      kept_out_fields: basedOn.kept_out_fields ?? [],
    },
    authority_questions: authorityQuestions,
    activation_allowed: false,
  });
  return {
    action_name: actionName,
    source_path: relativeProjectPath(projectRoot, sourcePath),
    base_contract_path: relativeProjectPath(projectRoot, contractPath),
    based_on_capability: basedOn.name,
    project_context: projectContext,
    instructions,
    authority_questions: authorityQuestions,
  };
}

/**
 * Parse the intentionally small code-first authoring subset without importing
 * or executing the file. This keeps an agent-authored TypeScript file from
 * gaining local process authority during validation.
 */
export function parseSafeActionSource(sourceText: string, fileName = "action.ts"): CapabilitySpec {
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const parseDiagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (parseDiagnostics.length > 0) {
    const diagnostic = parseDiagnostics[0];
    throw new Error(formatTypescriptDiagnostic(sourceFile, diagnostic!));
  }

  let importedDefineCapability = false;
  let definition: ts.Expression | undefined;
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.moduleSpecifier.getText(sourceFile).replace(/^['"]|['"]$/g, "") !== "@synapsor/runner/authoring") {
        throw sourceError(sourceFile, statement, "SAFE_ACTION_IMPORT_FORBIDDEN", "Safe Action files may import only defineCapability from @synapsor/runner/authoring.");
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings) || bindings.elements.length !== 1 || bindings.elements[0]?.name.text !== "defineCapability") {
        throw sourceError(sourceFile, statement, "SAFE_ACTION_IMPORT_INVALID", "Import exactly { defineCapability } from @synapsor/runner/authoring.");
      }
      importedDefineCapability = true;
      continue;
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals && !definition) {
      definition = statement.expression;
      continue;
    }
    if (ts.isEmptyStatement(statement)) continue;
    throw sourceError(sourceFile, statement, "SAFE_ACTION_STATEMENT_FORBIDDEN", "Safe Action files may contain one defineCapability import and one export default definition only.");
  }
  if (!importedDefineCapability) throw new Error("SAFE_ACTION_IMPORT_REQUIRED: import { defineCapability } from @synapsor/runner/authoring.");
  if (!definition) throw new Error("SAFE_ACTION_EXPORT_REQUIRED: export default defineCapability({...}) is required.");

  const expression = unwrapExpression(definition);
  if (!ts.isCallExpression(expression)
    || !ts.isIdentifier(expression.expression)
    || expression.expression.text !== "defineCapability"
    || expression.arguments.length !== 1
    || expression.typeArguments?.length) {
    throw sourceError(sourceFile, expression, "SAFE_ACTION_CALL_REQUIRED", "The default export must be one defineCapability({...}) call without type arguments.");
  }
  const value = staticValue(sourceFile, expression.arguments[0]!);
  if (!isRecord(value)) throw sourceError(sourceFile, expression, "SAFE_ACTION_OBJECT_REQUIRED", "defineCapability must receive an object literal.");
  return value as CapabilitySpec;
}

export async function compileSafeActionDraft(input: {
  projectRoot?: string;
  sourcePath: string;
  configPath?: string;
  generatedAt?: string;
}): Promise<{ manifest: SafeActionDraftManifest; contract: SynapsorContract; tests: JsonRecord }> {
  const projectRoot = await realProjectRoot(input.projectRoot);
  const sourcePath = await containedInputPath(projectRoot, input.sourcePath, "Safe Action source");
  const configPath = await containedInputPath(projectRoot, input.configPath ?? "synapsor.runner.json", "Runner config");
  const rawConfig = await readJsonRecord(configPath, "Runner config");
  const contractReferences = rawConfig.contracts;
  if (!Array.isArray(contractReferences) || contractReferences.length !== 1 || typeof contractReferences[0] !== "string") {
    throw new Error("SAFE_ACTION_SINGLE_CONTRACT_REQUIRED: Safe Action authoring currently requires exactly one active canonical contract reference.");
  }
  const baseContractPath = await containedInputPath(path.dirname(configPath), contractReferences[0], "active canonical contract");
  const sourceText = await fs.readFile(sourcePath, "utf8");
  const capability = parseSafeActionSource(sourceText, sourcePath);
  const baseContract = normalizeContract(await readJson(baseContractPath, "active canonical contract"));
  const diagnostics = validateSafeActionCapability(capability, baseContract, rawConfig);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new SafeActionValidationError(diagnostics);

  const capabilities = [...baseContract.capabilities];
  const existingIndex = capabilities.findIndex((item) => item.name === capability.name);
  if (existingIndex >= 0) capabilities[existingIndex] = capability;
  else capabilities.push(capability);
  const workflows = (baseContract.workflows ?? []).map((workflow) => workflow.context === capability.context && !workflow.allowed_capabilities.includes(capability.name)
    ? { ...workflow, allowed_capabilities: [...workflow.allowed_capabilities, capability.name] }
    : workflow);
  const draftContract = normalizeContract({
    ...baseContract,
    capabilities,
    ...(workflows.length ? { workflows } : {}),
  });
  assertValidContract(draftContract);

  const slug = safeSlug(capability.name);
  const sourceDigest = canonicalJsonDigest({ source: sourceText });
  const baseContractDigest = canonicalJsonDigest(baseContract);
  const draftContractDigest = canonicalJsonDigest(draftContract);
  const digestToken = draftContractDigest.slice("sha256:".length);
  const draftDirectory = path.join(projectRoot, ".synapsor", "drafts", slug);
  const draftContractPath = path.join(draftDirectory, `${digestToken}.contract.json`);
  const manifestPath = path.join(draftDirectory, "manifest.json");
  const pointerPath = path.join(projectRoot, ".synapsor", "drafts", "current.json");
  const generatedTestsPath = path.join(projectRoot, "synapsor", "actions", `${slug}.contract-tests.generated.json`);
  const lintReportPath = path.join(draftDirectory, "lint-report.json");
  const explanationPath = path.join(draftDirectory, "explanation.md");
  const staticTestsPath = path.join(draftDirectory, "static.contract-tests.json");
  const staticTestReportPath = path.join(draftDirectory, "static.contract-test-report.json");
  const validationConfigPath = path.join(draftDirectory, "validation.runner.json");
  const tests = generatedContractTests(capability, draftContract);
  const baselineLint = lintContract(baseContract, { runnerConfig: rawConfig });
  const draftLint = lintContract(draftContract, { runnerConfig: rawConfig });
  const baselineIssueKeys = new Set(baselineLint.issues.map(lintIssueKey));
  const blockingLintIssues = draftLint.issues.filter((issue) =>
    issue.severity === "error" || (issue.severity === "warning" && !baselineIssueKeys.has(lintIssueKey(issue))));
  const lintDiagnostics = draftLint.issues
    .filter((issue) => issue.severity !== "info")
    .map((issue): SafeActionDiagnostic => ({
      severity: issue.severity === "error" ? "error" : "warning",
      code: issue.code,
      message: issue.message,
      path: issue.path,
      source: baselineIssueKeys.has(lintIssueKey(issue)) ? "inherited contract lint" : "Safe Action contract lint",
    }));
  diagnostics.push(...lintDiagnostics);

  const generatedAssertions = Array.isArray(tests.tests) ? tests.tests.filter(isRecord) : [];
  const staticAssertions = generatedAssertions.filter((test) => typeof test.kind === "string" && !liveContractTestKinds.has(test.kind));
  const liveTestsPending = generatedAssertions
    .filter((test) => typeof test.kind === "string" && liveContractTestKinds.has(test.kind))
    .map((test) => typeof test.id === "string" ? test.id : "unnamed-live-test");
  const staticTests: JsonRecord = {
    ...tests,
    name: `${capability.name} generated static contract boundary`,
    tests: staticAssertions,
  };
  const relativeDraftForValidation = normalizePath(path.relative(draftDirectory, draftContractPath));
  const validationConfig: JsonRecord = {
    ...rawConfig,
    mode: "review",
    contracts: [relativeDraftForValidation.startsWith(".") ? relativeDraftForValidation : `./${relativeDraftForValidation}`],
    governance: { mode: "local_only" },
  };
  delete validationConfig.cloud;

  await writeDigestArtifact(draftContractPath, `${JSON.stringify(draftContract, null, 2)}\n`);
  await writeJsonAtomic(generatedTestsPath, tests);
  await writeJsonAtomic(staticTestsPath, staticTests);
  await writeJsonAtomic(validationConfigPath, validationConfig);
  await fs.writeFile(lintReportPath, formatContractLint(draftLint, "json"), { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(explanationPath, formatContractExplanation(explainContract(draftContract), "markdown"), { encoding: "utf8", mode: 0o600 });
  const staticTestReport = await runContractTests({
    manifestPath: staticTestsPath,
    contractPath: draftContractPath,
    configPath: validationConfigPath,
    live: false,
  });
  await fs.writeFile(staticTestReportPath, formatContractTestReport(staticTestReport, "json"), { encoding: "utf8", mode: 0o600 });
  if (!staticTestReport.ok) {
    diagnostics.push(...staticTestReport.tests.filter((test) => test.status === "failed").map((test): SafeActionDiagnostic => ({
      severity: "error",
      code: test.code,
      message: `${test.id}: ${test.message}`,
      source: "generated static contract test",
    })));
  }
  const unresolvedAuthority = [
    ...blockingLintIssues.map((issue) => `lint:${issue.code}:${issue.path}`),
    ...staticTestReport.tests.filter((test) => test.status === "failed").map((test) => `test:${test.id}:${test.code}`),
  ];
  const manifest: SafeActionDraftManifest = {
    schema_version: draftSchemaVersion,
    state: "disabled_draft",
    action_name: capability.name,
    source_path: relativeProjectPath(projectRoot, sourcePath),
    source_digest: sourceDigest,
    base_contract_path: relativeProjectPath(projectRoot, baseContractPath),
    base_contract_digest: baseContractDigest,
    draft_contract_path: relativeProjectPath(projectRoot, draftContractPath),
    draft_contract_digest: draftContractDigest,
    generated_tests_path: relativeProjectPath(projectRoot, generatedTestsPath),
    generated_at: input.generatedAt ?? new Date().toISOString(),
    diagnostics,
    unresolved_authority: unresolvedAuthority,
    validation: {
      ok: blockingLintIssues.length === 0 && staticTestReport.ok,
      lint_report_path: relativeProjectPath(projectRoot, lintReportPath),
      explanation_path: relativeProjectPath(projectRoot, explanationPath),
      static_tests_path: relativeProjectPath(projectRoot, staticTestsPath),
      static_test_report_path: relativeProjectPath(projectRoot, staticTestReportPath),
      lint_summary: draftLint.summary,
      blocking_lint_issues: blockingLintIssues.length,
      static_test_summary: staticTestReport.summary,
      live_tests_pending: liveTestsPending,
    },
  };

  await writeJsonAtomic(manifestPath, manifest);
  await writeJsonAtomic(pointerPath, {
    schema_version: pointerSchemaVersion,
    manifest_path: relativeProjectPath(projectRoot, manifestPath),
    draft_contract_digest: draftContractDigest,
  });
  return { manifest, contract: draftContract, tests };
}

export async function activateSafeActionDraft(input: {
  projectRoot?: string;
  configPath?: string;
  expectedDigest: string;
  confirmation: string;
  activatedAt?: string;
}): Promise<SafeActionActiveManifest> {
  const projectRoot = await realProjectRoot(input.projectRoot);
  const configPath = await containedInputPath(projectRoot, input.configPath ?? "synapsor.runner.json", "Runner config");
  const draft = await readCurrentDraft(projectRoot);
  if (!/^sha256:[a-f0-9]{64}$/.test(input.expectedDigest) || input.expectedDigest !== draft.draft_contract_digest) {
    throw new Error("SAFE_ACTION_DIGEST_MISMATCH: activation requires the exact currently reviewed draft digest.");
  }
  if (input.confirmation !== `ACTIVATE ${draft.draft_contract_digest}`) {
    throw new Error("SAFE_ACTION_CONFIRMATION_REQUIRED: enter ACTIVATE followed by the complete reviewed draft digest.");
  }
  if (!draft.validation?.ok || draft.unresolved_authority.length > 0 || draft.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw new Error("SAFE_ACTION_UNRESOLVED_AUTHORITY: activation is blocked until every authority question and validation error is resolved.");
  }
  if (!draft.effect_preview
    || draft.effect_preview.draft_contract_digest !== draft.draft_contract_digest
    || draft.effect_preview.source_database_changed !== false) {
    throw new Error("SAFE_ACTION_EFFECT_PREVIEW_REQUIRED: run and review a non-mutating staging-data proposal preview for this exact draft digest before activation.");
  }

  const sourcePath = await containedInputPath(projectRoot, draft.source_path, "Safe Action source");
  const sourceText = await fs.readFile(sourcePath, "utf8");
  if (canonicalJsonDigest({ source: sourceText }) !== draft.source_digest) {
    throw new Error("SAFE_ACTION_SOURCE_CHANGED: the action source changed after validation; compile a new disabled draft.");
  }
  const draftContractPath = await containedInputPath(projectRoot, draft.draft_contract_path, "draft contract");
  const draftContract = normalizeContract(await readJson(draftContractPath, "draft contract"));
  if (canonicalJsonDigest(draftContract) !== draft.draft_contract_digest) {
    throw new Error("SAFE_ACTION_DRAFT_TAMPERED: the draft artifact does not match its reviewed digest.");
  }
  assertValidContract(draftContract);

  const rawConfig = await readJsonRecord(configPath, "Runner config");
  const contractReferences = rawConfig.contracts;
  if (!Array.isArray(contractReferences) || contractReferences.length !== 1 || typeof contractReferences[0] !== "string") {
    throw new Error("SAFE_ACTION_SINGLE_CONTRACT_REQUIRED: activation requires exactly one current canonical contract reference.");
  }
  const currentContractPath = await containedInputPath(path.dirname(configPath), contractReferences[0], "current active contract");
  const currentContract = normalizeContract(await readJson(currentContractPath, "current active contract"));
  const currentDigest = canonicalJsonDigest(currentContract);
  if (currentDigest !== draft.base_contract_digest) {
    throw new Error("SAFE_ACTION_BASE_CHANGED: the active contract changed after this draft was compiled; compile and review a new draft.");
  }

  const digestToken = draft.draft_contract_digest.slice("sha256:".length);
  const activeContractPath = path.join(projectRoot, ".synapsor", "active", `${digestToken}.contract.json`);
  const activeManifestPath = path.join(projectRoot, ".synapsor", "active.json");
  const activatedAt = input.activatedAt ?? new Date().toISOString();
  const active: SafeActionActiveManifest = {
    schema_version: activeSchemaVersion,
    state: "active",
    action_name: draft.action_name,
    contract_path: relativeProjectPath(projectRoot, activeContractPath),
    contract_digest: draft.draft_contract_digest,
    source_path: draft.source_path,
    source_digest: draft.source_digest,
    activated_at: activatedAt,
    previous_contract_path: relativeProjectPath(projectRoot, currentContractPath),
    previous_contract_digest: currentDigest,
  };
  const configDirectory = path.dirname(configPath);
  const relativeActivePath = normalizePath(path.relative(configDirectory, activeContractPath));
  const nextConfig = {
    ...rawConfig,
    contracts: [relativeActivePath.startsWith("./") ? relativeActivePath : `./${relativeActivePath}`],
  };
  const previousConfigText = await fs.readFile(configPath, "utf8");

  await writeDigestArtifact(activeContractPath, `${JSON.stringify(draftContract, null, 2)}\n`, true);
  try {
    await writeJsonAtomic(configPath, nextConfig);
    await writeJsonAtomic(activeManifestPath, active);
    await writeJsonAtomic(path.join(projectRoot, ".synapsor", "drafts", safeSlug(draft.action_name), "manifest.json"), {
      ...draft,
      state: "activated",
      activated_at: activatedAt,
    } satisfies SafeActionDraftManifest);
  } catch (error) {
    await writeTextAtomic(configPath, previousConfigText).catch(() => undefined);
    throw error;
  }
  return active;
}

export async function prepareSafeActionPreview(input: {
  projectRoot?: string;
  configPath?: string;
}): Promise<{ config_path: string; capability: string; draft_digest: `sha256:${string}` }> {
  const projectRoot = await realProjectRoot(input.projectRoot);
  const configPath = await containedInputPath(projectRoot, input.configPath ?? "synapsor.runner.json", "Runner config");
  const draft = await readCurrentDraft(projectRoot);
  if (draft.state !== "disabled_draft") throw new Error("SAFE_ACTION_DRAFT_NOT_PENDING: compile a new disabled draft before previewing it.");
  if (!draft.validation.ok || draft.unresolved_authority.length > 0) {
    throw new Error("SAFE_ACTION_VALIDATION_REQUIRED: resolve every lint and static-test finding before running a staging-data preview.");
  }
  const draftContractPath = await containedInputPath(projectRoot, draft.draft_contract_path, "draft contract");
  const draftContract = normalizeContract(await readJson(draftContractPath, "draft contract"));
  if (canonicalJsonDigest(draftContract) !== draft.draft_contract_digest) throw new Error("SAFE_ACTION_DRAFT_TAMPERED: the draft artifact does not match its digest.");
  const rawConfig = await readJsonRecord(configPath, "Runner config");
  const contractReferences = rawConfig.contracts;
  if (!Array.isArray(contractReferences) || contractReferences.length !== 1 || typeof contractReferences[0] !== "string") throw new Error("SAFE_ACTION_SINGLE_CONTRACT_REQUIRED: preview requires one current canonical contract.");
  const currentContractPath = await containedInputPath(path.dirname(configPath), contractReferences[0], "current active contract");
  const currentContract = normalizeContract(await readJson(currentContractPath, "current active contract"));
  if (canonicalJsonDigest(currentContract) !== draft.base_contract_digest) throw new Error("SAFE_ACTION_BASE_CHANGED: compile a new draft against the current active contract.");
  const previewConfigPath = path.join(projectRoot, ".synapsor", "drafts", safeSlug(draft.action_name), "preview.runner.json");
  const relativeDraftPath = normalizePath(path.relative(path.dirname(previewConfigPath), draftContractPath));
  const previewConfig: JsonRecord = {
    ...rawConfig,
    mode: "review",
    contracts: [relativeDraftPath.startsWith("./") ? relativeDraftPath : `./${relativeDraftPath}`],
    governance: { mode: "local_only" },
  };
  delete previewConfig.cloud;
  await writeJsonAtomic(previewConfigPath, previewConfig);
  return {
    config_path: relativeProjectPath(projectRoot, previewConfigPath),
    capability: draft.action_name,
    draft_digest: draft.draft_contract_digest,
  };
}

export async function recordSafeActionEffectPreview(input: {
  projectRoot?: string;
  draftDigest: string;
  proposalId: string;
  proposalHash: string;
  sourceDatabaseChanged: boolean;
  previewedAt?: string;
}): Promise<SafeActionDraftManifest> {
  const projectRoot = await realProjectRoot(input.projectRoot);
  const draft = await readCurrentDraft(projectRoot);
  if (input.draftDigest !== draft.draft_contract_digest) throw new Error("SAFE_ACTION_PREVIEW_DIGEST_MISMATCH: preview does not belong to the current draft.");
  if (input.sourceDatabaseChanged) throw new Error("SAFE_ACTION_PREVIEW_MUTATED_SOURCE: activation is blocked because preview changed source data.");
  if (!input.proposalId.trim() || !input.proposalHash.trim()) throw new Error("SAFE_ACTION_PREVIEW_IDENTITY_REQUIRED: preview proposal identity is incomplete.");
  const updated: SafeActionDraftManifest = {
    ...draft,
    effect_preview: {
      draft_contract_digest: draft.draft_contract_digest,
      proposal_id: input.proposalId,
      proposal_hash: input.proposalHash,
      source_database_changed: false,
      previewed_at: input.previewedAt ?? new Date().toISOString(),
    },
  };
  const manifestPath = path.join(projectRoot, ".synapsor", "drafts", safeSlug(draft.action_name), "manifest.json");
  await writeJsonAtomic(manifestPath, updated);
  return updated;
}

export async function safeActionStatus(projectRootInput?: string): Promise<SafeActionStatus> {
  const projectRoot = await realProjectRoot(projectRootInput);
  const draft = await readCurrentDraft(projectRoot).catch((error) => missingFileOnly(error));
  const active = await readActiveManifest(projectRoot).catch((error) => missingFileOnly(error));
  let previewArgs: JsonRecord | undefined;
  if (draft) {
    const draftContractPath = await containedInputPath(projectRoot, draft.draft_contract_path, "draft contract");
    const draftContract = normalizeContract(await readJson(draftContractPath, "draft contract"));
    if (canonicalJsonDigest(draftContract) !== draft.draft_contract_digest) throw new Error("SAFE_ACTION_DRAFT_TAMPERED: the draft artifact does not match its digest.");
    const capability = draftContract.capabilities.find((item) => item.name === draft.action_name);
    if (capability) previewArgs = sampleArgs(capability);
  }
  return {
    ...(draft ? { draft } : {}),
    ...(active ? { active } : {}),
    ...(previewArgs ? { preview_args: previewArgs } : {}),
    draft_matches_active: Boolean(draft && active && draft.draft_contract_digest === active.contract_digest),
  };
}

export function validateSafeActionCapability(
  capability: CapabilitySpec,
  contract: SynapsorContract,
  runnerConfig: JsonRecord,
): SafeActionDiagnostic[] {
  const diagnostics: SafeActionDiagnostic[] = [];
  const error = (code: string, message: string, issuePath?: string) => diagnostics.push({ severity: "error", code, message, ...(issuePath ? { path: issuePath } : {}) });
  const warning = (code: string, message: string, issuePath?: string) => diagnostics.push({ severity: "warning", code, message, ...(issuePath ? { path: issuePath } : {}) });
  if (!capability || typeof capability !== "object") return [{ severity: "error", code: "SAFE_ACTION_NOT_OBJECT", message: "Safe Action must be an object." }];
  if (!capability.description?.trim()) error("SAFE_ACTION_DESCRIPTION_REQUIRED", "Describe the exact business action for the developer and reviewer.", "description");
  if (capability.kind !== "proposal") error("SAFE_ACTION_PROPOSAL_REQUIRED", "A Safe Action must create a proposal; read-only capabilities should remain in the base contract.", "kind");
  const context = contract.contexts.find((candidate) => candidate.name === capability.context);
  if (!context) error("SAFE_ACTION_CONTEXT_UNKNOWN", `Context ${String(capability.context)} is not declared in the active contract.`, "context");
  const resource = capability.subject?.resource ? contract.resources?.find((item) => item.name === capability.subject.resource) : undefined;
  if (capability.subject?.resource && !resource) error("SAFE_ACTION_RESOURCE_UNKNOWN", `Resource ${capability.subject.resource} is not declared in the active contract.`, "subject.resource");
  if (!capability.subject?.resource && !(capability.subject?.schema && capability.subject?.table)) error("SAFE_ACTION_SUBJECT_REQUIRED", "Choose one reviewed resource or a fixed schema/table subject.", "subject");
  const primaryKey = capability.subject?.primary_key ?? resource?.primary_key;
  if (!primaryKey) error("SAFE_ACTION_PRIMARY_KEY_REQUIRED", "Choose one reviewed primary key so the effect cannot widen to an arbitrary set.", "subject.primary_key");
  const tenantKey = capability.subject?.tenant_key ?? resource?.tenant_key;
  const singleTenant = capability.subject?.single_tenant_dev === true || resource?.single_tenant_dev === true;
  if (!tenantKey && !singleTenant) error("SAFE_ACTION_TENANT_AUTHORITY_REQUIRED", "Declare the trusted tenant key, or explicitly acknowledge a single-tenant development resource.", "subject.tenant_key");
  if (singleTenant) warning("SAFE_ACTION_SINGLE_TENANT_DEV", "single_tenant_dev is not a production tenant-isolation control; use a trusted tenant key and database-enforced isolation for production.", "subject.single_tenant_dev");
  if (tenantKey && context) {
    const tenantBinding = context.bindings.find((binding) => binding.name === context.tenant_binding);
    if (!context.tenant_binding || !tenantBinding || tenantBinding.required !== true) {
      error("SAFE_ACTION_TRUSTED_TENANT_BINDING_REQUIRED", "Tenant-scoped actions require a required trusted context tenant binding resolved outside model arguments.", "context.tenant_binding");
    }
    if (tenantBinding?.source === "static_dev") warning("SAFE_ACTION_STATIC_TENANT_DEV", "A static_dev tenant binding is development-only; use authenticated session/claim/environment authority for deployment.", "context.tenant_binding");
  }
  const principalScopeKey = capability.subject?.principal_scope_key;
  if (principalScopeKey && context) {
    const principalBinding = context.bindings.find((binding) => binding.name === context.principal_binding);
    if (!context.principal_binding || !principalBinding || principalBinding.required !== true) {
      error("SAFE_ACTION_TRUSTED_PRINCIPAL_BINDING_REQUIRED", "Principal-scoped rows require a required trusted principal binding resolved outside model arguments.", "context.principal_binding");
    }
  }
  for (const name of Object.keys(capability.args ?? {})) {
    if (forbiddenModelArgs.has(name)) error("SAFE_ACTION_TRUSTED_ARG_FORBIDDEN", `Model-visible argument ${name} could control trusted authority or raw query shape.`, `args.${name}`);
  }
  const visible = new Set(capability.visible_fields ?? []);
  if (visible.size === 0) error("SAFE_ACTION_VISIBLE_FIELDS_REQUIRED", "Review an explicit non-empty model-visible field allowlist.", "visible_fields");
  for (const field of capability.kept_out_fields ?? []) {
    if (visible.has(field)) error("SAFE_ACTION_FIELD_VISIBILITY_CONFLICT", `${field} cannot be both visible and kept out.`, "kept_out_fields");
  }
  if (!capability.kept_out_fields?.length) warning("SAFE_ACTION_KEPT_OUT_EMPTY", "No kept-out fields are declared. Review unknown and sensitive columns explicitly before activation.", "kept_out_fields");
  if (capability.evidence?.required !== true) error("SAFE_ACTION_EVIDENCE_REQUIRED", "Safe Actions require bounded evidence so reviewers can inspect why the proposal was created.", "evidence.required");
  if (containsUnresolved(capability)) error("SAFE_ACTION_REVIEW_PLACEHOLDER", "Resolve every TODO/TBD/__REVIEW_*__ placeholder before compiling the draft.");
  const proposal = capability.proposal;
  if (!proposal) {
    error("SAFE_ACTION_PROPOSAL_MISSING", "Proposal authority is required.", "proposal");
    return diagnostics;
  }
  const operation = proposal.operation?.kind ?? "update";
  if (operation !== "delete" && !proposal.allowed_fields?.length) error("SAFE_ACTION_MUTATION_REQUIRED", "Declare at least one exact allowed mutation field.", "proposal.allowed_fields");
  if (operation === "delete" && (proposal.allowed_fields.length > 0 || Object.keys(proposal.patch ?? {}).length > 0)) {
    error("SAFE_ACTION_DELETE_PATCH_FORBIDDEN", "A reviewed DELETE targets one row and must not carry writable columns or a patch.", "proposal.patch");
  }
  if (operation !== "delete") {
    const allowed = new Set(proposal.allowed_fields);
    const patched = new Set(Object.keys(proposal.patch ?? {}));
    const missing = [...allowed].filter((field) => !patched.has(field));
    const extra = [...patched].filter((field) => !allowed.has(field));
    if (missing.length || extra.length) error("SAFE_ACTION_PATCH_MUST_BE_EXACT", `allowed_fields and patch must match exactly (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}).`, "proposal.patch");
  }
  for (const field of Object.keys(proposal.patch ?? {})) {
    if (!proposal.allowed_fields?.includes(field)) error("SAFE_ACTION_PATCH_NOT_ALLOWED", `Patch field ${field} is not in allowed_fields.`, `proposal.patch.${field}`);
  }
  if (!proposal.approval?.mode) error("SAFE_ACTION_APPROVAL_REQUIRED", "Choose an explicit human, operator, or reviewed policy approval mode.", "proposal.approval.mode");
  if ((proposal.approval?.mode === "human" || proposal.approval?.mode === "operator") && !proposal.approval.required_role?.trim()) {
    error("SAFE_ACTION_REVIEWER_ROLE_REQUIRED", `${proposal.approval.mode} approval requires one explicit reviewed role.`, "proposal.approval.required_role");
  }
  if (proposal.approval?.mode === "policy") {
    if (!proposal.approval.policy || !contract.policies?.some((policy) => policy.name === proposal.approval?.policy)) {
      error("SAFE_ACTION_POLICY_UNKNOWN", "Policy approval must reference an existing reviewed policy in the active canonical contract.", "proposal.approval.policy");
    } else {
      warning("SAFE_ACTION_POLICY_REVIEW_REQUIRED", "This action reuses existing policy authority; review its limits explicitly. The draft does not activate or widen the policy.", "proposal.approval");
    }
  }
  if (!proposal.writeback?.mode || proposal.writeback.mode === "none") error("SAFE_ACTION_WRITEBACK_REQUIRED", "Choose direct_sql or an app_handler/cloud_worker executor explicitly.", "proposal.writeback.mode");
  if ((operation === "update" || operation === "delete") && !proposal.conflict_guard?.column && proposal.conflict_guard?.weak_guard_ack !== true) {
    error("SAFE_ACTION_CONFLICT_GUARD_REQUIRED", `${operation.toUpperCase()} requires an expected-version/conflict field or an explicit weak-guard acknowledgement.`, "proposal.conflict_guard");
  }
  if ((operation === "update" || operation === "delete") && proposal.conflict_guard?.weak_guard_ack === true) {
    warning("SAFE_ACTION_WEAK_CONFLICT_GUARD", "A weak guard can miss same-value concurrency. Prefer a real monotonically changing version/conflict column.", "proposal.conflict_guard");
  }
  if ((operation === "update" || operation === "delete") && !capability.lookup?.id_from_arg) {
    error("SAFE_ACTION_LOOKUP_REQUIRED", `${operation.toUpperCase()} requires one fixed primary-key lookup argument.`, "lookup.id_from_arg");
  }
  if (operation === "insert" && !(proposal.operation?.deduplication?.components.length)) {
    error("SAFE_ACTION_INSERT_DEDUP_REQUIRED", "INSERT requires a deterministic reviewed deduplication key so retries cannot create another row.", "proposal.operation.deduplication");
  }
  for (const [field, binding] of Object.entries(proposal.patch ?? {})) {
    if (!binding.from_arg) continue;
    const argument = capability.args?.[binding.from_arg];
    if (!argument || argument.type === "object_array") {
      error("SAFE_ACTION_PATCH_ARGUMENT_INVALID", `Patch field ${field} must bind to one declared scalar model argument.`, `proposal.patch.${field}.from_arg`);
      continue;
    }
    if (argument.type === "number") {
      const bounds = proposal.numeric_bounds?.[field];
      if (argument.minimum === undefined || argument.maximum === undefined || bounds?.minimum === undefined || bounds.maximum === undefined) {
        error("SAFE_ACTION_NUMERIC_VALUE_BOUNDS_REQUIRED", `Numeric mutation ${field} requires minimum and maximum bounds on both argument ${binding.from_arg} and the reviewed patch field.`, `proposal.numeric_bounds.${field}`);
      }
    }
    if (argument.type === "string" && argument.max_length === undefined && !argument.enum?.length) {
      error("SAFE_ACTION_STRING_VALUE_BOUND_REQUIRED", `String mutation ${field} requires a max_length or fixed enum on argument ${binding.from_arg}.`, `args.${binding.from_arg}`);
    }
  }
  for (const [field, binding] of Object.entries(proposal.patch ?? {})) {
    if (!/^(?:status|state)$/i.test(field) || binding.fixed === undefined) continue;
    if (!proposal.transition_guards?.[field]) error("SAFE_ACTION_TRANSITION_GUARD_REQUIRED", `State mutation ${field} requires an explicit reviewed transition guard.`, `proposal.transition_guards.${field}`);
  }
  if ((proposal.operation?.cardinality ?? "single") === "set") {
    if (!proposal.operation?.selection?.all?.length) error("SAFE_ACTION_FIXED_SELECTION_REQUIRED", "Bounded-set actions require a reviewer-fixed selection predicate.", "proposal.operation.selection");
    if (!proposal.operation?.max_rows || proposal.operation.max_rows < 1) error("SAFE_ACTION_ROW_CAP_REQUIRED", "Bounded-set actions require a positive hard max_rows cap.", "proposal.operation.max_rows");
    const hasNumericMutation = Object.values(proposal.patch ?? {}).some((binding) => {
      const argument = binding.from_arg ? capability.args?.[binding.from_arg] : undefined;
      return typeof binding.fixed === "number" || argument?.type === "number";
    });
    if (hasNumericMutation && !proposal.operation?.aggregate_bounds?.length) {
      error("SAFE_ACTION_SET_VALUE_CAP_REQUIRED", "A bounded-set numeric mutation requires at least one reviewed aggregate value cap in addition to MAX ROWS.", "proposal.operation.aggregate_bounds");
    }
  } else if ((capability.max_rows ?? 1) !== 1) {
    error("SAFE_ACTION_SINGLE_ROW_LIMIT", "Single-row Safe Actions must set max_rows to 1.", "max_rows");
  }
  const sources = isRecord(runnerConfig.sources) ? runnerConfig.sources : {};
  const source = capability.source ? sources[capability.source] : undefined;
  if (!capability.source || !isRecord(source)) error("SAFE_ACTION_SOURCE_UNKNOWN", `Source ${String(capability.source)} is not configured in synapsor.runner.json.`, "source");
  if (proposal.writeback?.mode === "direct_sql" && (!isRecord(source) || typeof source.write_url_env !== "string" || !source.write_url_env.trim())) {
    error("SAFE_ACTION_WRITE_CREDENTIAL_AUTHORITY_REQUIRED", "Direct SQL writeback requires a separate environment-bound write_url_env outside model authority.", "source.write_url_env");
  }
  const executors = isRecord(runnerConfig.executors) ? runnerConfig.executors : {};
  if (proposal.writeback?.mode === "app_handler" && (!proposal.writeback.executor || !isRecord(executors[proposal.writeback.executor]))) {
    error("SAFE_ACTION_EXECUTOR_UNKNOWN", "App-handler writeback requires a matching reviewed executor in synapsor.runner.json.", "proposal.writeback.executor");
  }
  if (proposal.writeback?.mode === "cloud_worker" && !isRecord(runnerConfig.cloud)) {
    error("SAFE_ACTION_CLOUD_WORKER_UNRESOLVED", "Cloud-worker writeback requires an existing reviewed Cloud runner connection; local authoring cannot infer it.", "proposal.writeback.mode");
  }
  return diagnostics;
}

export class SafeActionValidationError extends Error {
  constructor(public readonly diagnostics: SafeActionDiagnostic[]) {
    super(`Safe Action draft is blocked:\n${diagnostics.map((item) => `${item.severity.toUpperCase()} ${item.code}${item.path ? ` ${item.path}` : ""}: ${item.message}`).join("\n")}`);
    this.name = "SafeActionValidationError";
  }
}

async function readCurrentDraft(projectRoot: string): Promise<SafeActionDraftManifest> {
  const pointer = await readJsonRecord(path.join(projectRoot, ".synapsor", "drafts", "current.json"), "Safe Action draft pointer");
  if (pointer.schema_version !== pointerSchemaVersion || typeof pointer.manifest_path !== "string" || typeof pointer.draft_contract_digest !== "string") {
    throw new Error("SAFE_ACTION_POINTER_INVALID: current draft pointer is invalid.");
  }
  const manifestPath = await containedInputPath(projectRoot, pointer.manifest_path, "Safe Action draft manifest");
  const manifest = await readJsonRecord(manifestPath, "Safe Action draft manifest");
  if (manifest.schema_version !== draftSchemaVersion || (manifest.state !== "disabled_draft" && manifest.state !== "activated")) {
    throw new Error("SAFE_ACTION_MANIFEST_INVALID: current draft manifest is invalid.");
  }
  if (manifest.draft_contract_digest !== pointer.draft_contract_digest) throw new Error("SAFE_ACTION_POINTER_DIGEST_MISMATCH: current draft pointer and manifest disagree.");
  if (!isRecord(manifest.validation) || typeof manifest.validation.ok !== "boolean") throw new Error("SAFE_ACTION_VALIDATION_EVIDENCE_MISSING: current draft lacks validation evidence.");
  return manifest as SafeActionDraftManifest;
}

async function readActiveManifest(projectRoot: string): Promise<SafeActionActiveManifest> {
  const manifest = await readJsonRecord(path.join(projectRoot, ".synapsor", "active.json"), "Safe Action active manifest");
  if (manifest.schema_version !== activeSchemaVersion || manifest.state !== "active") throw new Error("SAFE_ACTION_ACTIVE_INVALID: active manifest is invalid.");
  return manifest as SafeActionActiveManifest;
}

function generatedContractTests(capability: CapabilitySpec, contract: SynapsorContract): JsonRecord {
  const slug = safeSlug(capability.name);
  const args = sampleArgs(capability);
  const trustedContext = { tenant_id: "replace-with-test-tenant", principal: "contract_test" };
  const tests: JsonRecord[] = [{
    id: `${slug}-operator-boundary`,
    kind: "operator_boundary",
    capability: capability.name,
  }, {
    id: `${slug}-proposal-effect`,
    kind: "proposal_effect",
    capability: capability.name,
    expected: proposalEffectSnapshot(capability),
  }, {
    id: `${slug}-trusted-scope`,
    kind: "trusted_scope",
    capability: capability.name,
    expected: trustedScopeSnapshot(capability, contract),
  }, {
    id: `${slug}-evidence-required`,
    kind: "evidence_requirement",
    capability: capability.name,
    expected: capability.evidence ?? {},
  }, {
    id: `${slug}-approval-boundary`,
    kind: "approval_boundary",
    capability: capability.name,
    expected: approvalBoundarySnapshot(capability, contract),
  }, {
    id: `${slug}-allowed-effect`,
    kind: "tool_allow",
    capability: capability.name,
    args,
    trusted_context: trustedContext,
  }, {
    id: `${slug}-other-tenant-denied`,
    kind: "tool_deny",
    capability: capability.name,
    args: deniedSampleArgs(capability, args),
    trusted_context: trustedContext,
    expected_code: "NOT_FOUND_IN_TENANT",
  }, {
    id: `${slug}-source-unchanged`,
    kind: "source_unchanged_before_approval",
    capability: capability.name,
    args,
    trusted_context: trustedContext,
  }];
  const operation = capability.proposal?.operation?.kind ?? "update";
  if (operation === "update" || operation === "delete") tests.splice(2, 0, {
    id: `${slug}-conflict-guard`,
    kind: "conflict_guard",
    capability: capability.name,
    expected: capability.proposal?.conflict_guard ?? {},
  });
  if (capability.kept_out_fields?.length) tests.splice(2, 0, {
    id: `${slug}-kept-out-fields`,
    kind: "hide_fields",
    capability: capability.name,
    args,
    trusted_context: trustedContext,
    fields: [...capability.kept_out_fields],
  });
  for (const [argument, spec] of Object.entries(capability.args ?? {})) {
    if (spec.type === "object_array") continue;
    const expected = Object.fromEntries(Object.entries({
      minimum: spec.minimum,
      maximum: spec.maximum,
      max_length: spec.max_length,
      enum: spec.enum,
    }).filter(([, value]) => value !== undefined));
    if (Object.keys(expected).length > 0) tests.push({ id: `${slug}-${safeSlug(argument)}-constraints`, kind: "argument_constraint", capability: capability.name, argument, expected });
  }
  if (capability.proposal?.transition_guards && Object.keys(capability.proposal.transition_guards).length > 0) {
    tests.push({ id: `${slug}-transition-guards`, kind: "transition_guard", capability: capability.name, expected: capability.proposal.transition_guards });
  }
  if (capability.proposal?.operation?.cardinality === "set") {
    tests.push({
      id: `${slug}-set-cap`,
      kind: "set_cap",
      capability: capability.name,
      expected: {
        max_rows: capability.proposal.operation.max_rows,
        aggregate_bounds: capability.proposal.operation.aggregate_bounds ?? [],
      },
    });
  }
  return {
    $schema: "https://schemas.synapsor.ai/synapsor.contract-tests.schema.json",
    version: 1,
    name: `${capability.name} generated contract boundary`,
    tests,
  };
}

function deniedSampleArgs(capability: CapabilitySpec, allowed: JsonRecord): JsonRecord {
  const lookupArg = capability.lookup?.id_from_arg;
  if (!lookupArg) return { ...allowed };
  return { ...allowed, [lookupArg]: `replace-with-other-tenant-${lookupArg}` };
}

function lintIssueKey(issue: ContractLintIssue): string {
  return `${issue.severity}\u0000${issue.code}\u0000${issue.path}\u0000${issue.message}`;
}

function renderSafeActionScaffold(input: {
  actionName: string;
  businessAction: string;
  description: string;
  basedOn: CapabilitySpec;
  conflictSuggestion?: string;
}): string {
  const baseArgs = { ...input.basedOn.args };
  if (!baseArgs.reason) baseArgs.reason = { type: "string", required: true, max_length: 500 };
  const subject = input.basedOn.subject.resource
    ? { resource: input.basedOn.subject.resource }
    : input.basedOn.subject;
  const suggestedConflict = input.conflictSuggestion
    ? `"${escapeTs(input.conflictSuggestion)}" /* structural suggestion; review explicitly */`
    : '"__REVIEW_CONFLICT_FIELD__"';
  return `import { defineCapability } from "@synapsor/runner/authoring";

// Disabled authoring draft. Editing this file never changes active Runner tools.
// Resolve every __REVIEW_*__ value, then run: synapsor-runner action validate ${relativeCommandPath(input.actionName)}
export default defineCapability({
  name: ${JSON.stringify(input.actionName)},
  description: ${JSON.stringify(input.description)},
  kind: "proposal",
  context: ${JSON.stringify(input.basedOn.context)},
  source: ${JSON.stringify(input.basedOn.source)},
  subject: ${JSON.stringify(subject)},
  args: ${JSON.stringify(baseArgs)},
  lookup: ${JSON.stringify(input.basedOn.lookup)},
  visible_fields: ${JSON.stringify(input.basedOn.visible_fields)},
  kept_out_fields: ${JSON.stringify(input.basedOn.kept_out_fields ?? [])},
  evidence: ${JSON.stringify(input.basedOn.evidence ?? { required: true, query_audit: true })},
  max_rows: 1,
  proposal: {
    action: ${JSON.stringify(input.businessAction)},
    operation: { kind: "__REVIEW_OPERATION__" },
    allowed_fields: ["__REVIEW_MUTATION_COLUMN__"],
    patch: { __REVIEW_MUTATION_COLUMN__: { from_arg: "__REVIEW_MODEL_ARGUMENT__" } },
    conflict_guard: { column: ${suggestedConflict} },
    approval: { mode: "human", required_role: "__REVIEW_APPROVER_ROLE__" },
    writeback: { mode: "__REVIEW_WRITEBACK_MODE__" },
  },
});
`;
}

function normalizeActionName(requested: string, basedOn: string): string {
  const raw = requested.trim();
  if (!raw || raw.length > 160 || !/^[a-zA-Z_][a-zA-Z0-9_.-]*$/.test(raw)) {
    throw new Error("Safe Action name must contain only letters, numbers, underscores, dots, and hyphens and start with a letter or underscore.");
  }
  if (raw.includes(".")) return raw;
  const namespace = basedOn.includes(".") ? basedOn.slice(0, basedOn.indexOf(".")) : "app";
  const identifier = raw.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  return `${namespace}.propose_${identifier}`;
}

function relativeCommandPath(actionName: string): string {
  return `./synapsor/actions/${safeSlug(actionName)}.ts`;
}

function escapeTs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sampleArgs(capability: CapabilitySpec): JsonRecord {
  return Object.fromEntries(Object.entries(capability.args ?? {}).filter(([, spec]) => spec.required !== false).map(([name, spec]) => {
    if (spec.type === "object_array") return [name, []];
    if (spec.enum?.length) return [name, spec.enum[0]];
    if (spec.type === "number") return [name, spec.minimum ?? 1];
    if (spec.type === "boolean") return [name, true];
    return [name, `replace-${name}`];
  }));
}

function staticValue(sourceFile: ts.SourceFile, rawExpression: ts.Expression): unknown {
  const expression = unwrapExpression(rawExpression);
  if (ts.isObjectLiteralExpression(expression)) {
    const result: JsonRecord = {};
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property) || property.name === undefined || ts.isComputedPropertyName(property.name)) {
        throw sourceError(sourceFile, property, "SAFE_ACTION_STATIC_OBJECT_REQUIRED", "Only fixed object properties are allowed; spreads, shorthand properties, methods, and computed names are forbidden.");
      }
      const key = propertyName(sourceFile, property.name);
      if (Object.prototype.hasOwnProperty.call(result, key)) throw sourceError(sourceFile, property, "SAFE_ACTION_DUPLICATE_PROPERTY", `Duplicate property ${key}.`);
      result[key] = staticValue(sourceFile, property.initializer);
    }
    return result;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    if (expression.elements.some((element) => ts.isSpreadElement(element))) throw sourceError(sourceFile, expression, "SAFE_ACTION_SPREAD_FORBIDDEN", "Array spreads are forbidden.");
    return expression.elements.map((element) => staticValue(sourceFile, element as ts.Expression));
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  if (expression.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (expression.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (expression.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isPrefixUnaryExpression(expression) && (expression.operator === ts.SyntaxKind.MinusToken || expression.operator === ts.SyntaxKind.PlusToken) && ts.isNumericLiteral(expression.operand)) {
    const value = Number(expression.operand.text);
    return expression.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }
  throw sourceError(sourceFile, expression, "SAFE_ACTION_DYNAMIC_EXPRESSION_FORBIDDEN", "Safe Action values must be static JSON-compatible literals. Function calls, identifiers, templates with substitutions, and executable expressions are forbidden.");
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isTypeAssertionExpression(current)) current = current.expression;
  return current;
}

function propertyName(sourceFile: ts.SourceFile, name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  throw sourceError(sourceFile, name, "SAFE_ACTION_PROPERTY_NAME_INVALID", "Property names must be fixed identifiers or string literals.");
}

function formatTypescriptDiagnostic(sourceFile: ts.SourceFile, diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (diagnostic.start === undefined) return `SAFE_ACTION_TYPESCRIPT_PARSE: ${message}`;
  const location = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
  return `SAFE_ACTION_TYPESCRIPT_PARSE ${sourceFile.fileName}:${location.line + 1}:${location.character + 1}: ${message}`;
}

function sourceError(sourceFile: ts.SourceFile, node: ts.Node, code: string, message: string): Error {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return new Error(`${code} ${sourceFile.fileName}:${location.line + 1}:${location.character + 1}: ${message}`);
}

function containsUnresolved(value: unknown): boolean {
  if (typeof value === "string") return unresolvedPattern.test(value);
  if (Array.isArray(value)) return value.some(containsUnresolved);
  if (isRecord(value)) return Object.entries(value).some(([key, item]) => unresolvedPattern.test(key) || containsUnresolved(item));
  return false;
}

async function realProjectRoot(input?: string): Promise<string> {
  const resolved = path.resolve(input ?? process.cwd());
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Safe Action project root must be a real directory, not a symlink.");
  return fs.realpath(resolved);
}

async function containedInputPath(base: string, candidate: string, label: string): Promise<string> {
  const resolved = path.resolve(base, candidate);
  assertContained(base, resolved, label);
  await rejectSymlinkChain(base, resolved, label);
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular file inside the project.`);
  return resolved;
}

async function rejectSymlinkChain(base: string, target: string, label: string): Promise<void> {
  assertContained(base, target, label);
  const relative = path.relative(base, target);
  let current = base;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`${label} may not traverse a symbolic link: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function assertContained(base: string, target: string, label: string): void {
  const relative = path.relative(path.resolve(base), path.resolve(target));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new Error(`${label} must stay inside the project directory.`);
}

async function readJson(filePath: string, label: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Unable to read ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readJsonRecord(filePath: string, label: string): Promise<JsonRecord> {
  const parsed = await readJson(filePath, label);
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object.`);
  return parsed;
}

async function writeDigestArtifact(filePath: string, content: string, immutable = false): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing !== content) throw new Error(`Digest-addressed artifact collision at ${filePath}.`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await fs.open(filePath, "wx", immutable ? 0o400 : 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (immutable) await fs.chmod(filePath, 0o400).catch(() => undefined);
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeTextAtomic(filePath: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
  try {
    await fs.writeFile(temporary, value, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function writeNewText(filePath: string, value: string, force: boolean): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try {
    const existing = await fs.readFile(filePath, "utf8");
    if (existing === value) return;
    if (!force) throw new Error(`Safe Action source already exists: ${filePath}. Review it or pass --force explicitly.`);
    await fs.copyFile(filePath, `${filePath}.bak`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await writeTextAtomic(filePath, value);
}

function relativeProjectPath(projectRoot: string, filePath: string): string {
  const relative = normalizePath(path.relative(projectRoot, filePath));
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function normalizePath(value: string): string {
  return value.split(path.sep).join("/");
}

function safeSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|[.-]+$/g, "");
  if (!slug || slug.length > 120) throw new Error("Safe Action name cannot produce a bounded artifact path.");
  return slug;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function missingFileOnly(error: unknown): undefined {
  if ((error as NodeJS.ErrnoException).code === "ENOENT" || /Unable to read .*ENOENT/.test(error instanceof Error ? error.message : String(error))) return undefined;
  throw error;
}
