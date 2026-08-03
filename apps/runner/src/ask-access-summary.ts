import fs from "node:fs/promises";
import path from "node:path";
import {
  loadActivatedExplorationBoundaries,
  type ExplorationBoundaryDraft,
} from "./auto-boundary.js";
import { readGuidedOnboardingState } from "./guided-project.js";
import type { AskToolGateway } from "./model-ask.js";

export type ReviewedAskResourceSummary = {
  id: string;
  label: string;
  capabilities: string[];
  suggestions: string[];
};

export type ReviewedAskAccessSummary = {
  table_count: number;
  resources: ReviewedAskResourceSummary[];
  suggestions: string[];
};

export type AskAccessGuidance = {
  kind: "review_candidate" | "reviewed_view_required";
  title: string;
  message: string;
  candidate_path?: string;
  review_resource?: string;
  review_field?: string;
  next_action: string;
};

export async function readReviewedAskAccessSummary(
  gateway: AskToolGateway,
): Promise<ReviewedAskAccessSummary> {
  const resources: ReviewedAskResourceSummary[] = [];
  let cursor: number | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await gateway.callTool("app.describe_data", {
      limit: 10,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (!result.ok) break;
    const described = Array.isArray(result.value.resources)
      ? result.value.resources.filter(isRecord)
      : [];
    resources.push(...described.flatMap((resource) => {
      const summary = reviewedResourceSummary(resource);
      return summary ? [summary] : [];
    }));
    cursor = typeof result.value.next_cursor === "number"
      ? result.value.next_cursor
      : undefined;
    if (cursor === undefined) break;
  }
  return {
    table_count: resources.length,
    resources,
    suggestions: unique(resources.flatMap((resource) => resource.suggestions)).slice(0, 3),
  };
}

export async function resolveAskAccessGuidance(input: {
  projectRoot: string;
  question: string;
}): Promise<AskAccessGuidance | undefined> {
  const normalizedQuestion = normalizedSearchText(input.question);
  if (!normalizedQuestion) return undefined;
  const draft = await readGeneratedBoundaryDraft(input.projectRoot).catch(() => undefined);
  if (!draft) return undefined;

  const resources = draft.pack.resources;
  const keptOutMatch = resources.some((resource) =>
    resource.kept_out_fields.some((field) => phraseMatches(normalizedQuestion, field)));
  if (keptOutMatch) return undefined;

  if (asksForDerivedFormula(normalizedQuestion)) {
    return {
      kind: "reviewed_view_required",
      title: "A reviewed metric is needed",
      message: "This question requires a derived formula or a relationship shape that Scoped Explore will not improvise. Define it in a reviewed database view or named capability, rescan, and then review that narrow surface.",
      next_action: "Create a reviewed view or named metric, then run /access to rescan and review it.",
    };
  }

  const activeBoundaries = await loadActivatedExplorationBoundaries(input.projectRoot).catch(() => []);
  const matches = resources.flatMap((resource) => {
    const fields = candidateVisibleFields(resource);
    const matchingField = fields.find((field) => phraseMatches(normalizedQuestion, field));
    const resourceMatch = phraseMatches(normalizedQuestion, resource.table)
      || phraseMatches(normalizedQuestion, resource.id);
    return matchingField || resourceMatch
      ? [{ resource, matchingField, score: (matchingField ? 8 : 0) + (resourceMatch ? 4 : 0) }]
      : [];
  }).sort((left, right) => right.score - left.score || left.resource.id.localeCompare(right.resource.id));
  const target = matches[0];
  if (!target) return undefined;

  const temporal = asksForTimeComparison(normalizedQuestion);
  if (activeCandidateCanAnswer({
    activeBoundaries,
    targetId: target.resource.id,
    matchingField: target.matchingField,
    temporal,
  })) return undefined;
  const targetResourceIsActive = activeBoundaries.some((boundary) =>
    boundary.pack.resources.some((resource) => resource.id === target.resource.id));
  const root = bestCandidateRoot(resources, target.resource.id, temporal);
  const candidatePath = root
    ? candidatePathSummary(root, target.resource.id, resources, temporal)
    : undefined;
  const label = businessLabel(target.resource.table);
  const fieldLabel = target.matchingField ? businessLabel(target.matchingField) : undefined;
  return {
    kind: "review_candidate",
    title: targetResourceIsActive
      ? `${fieldLabel ?? label} needs another reviewed analytical path`
      : `${fieldLabel ?? label} is not in the active boundary`,
    message: candidatePath
      ? `Runner found a source-proven, many-to-one candidate path for ${fieldLabel ?? label}. It remains disabled until a human reviews the tables, fields, relationship path, scope, and limits.`
      : `${label} exists in the generated draft but is not active. A human must review its fields, scope, and limits before an agent can query it.`,
    ...(candidatePath ? { candidate_path: candidatePath } : {}),
    review_resource: root?.id ?? target.resource.id,
    ...(target.matchingField ? { review_field: target.matchingField } : {}),
    next_action: "Use /access in the CLI or Review or expand access in Workbench. Nothing is activated automatically.",
  };
}

function activeCandidateCanAnswer(input: {
  activeBoundaries: Awaited<ReturnType<typeof loadActivatedExplorationBoundaries>>;
  targetId: string;
  matchingField?: string;
  temporal: boolean;
}): boolean {
  return input.activeBoundaries.some((boundary) => {
    const target = boundary.pack.resources.find((resource) => resource.id === input.targetId);
    if (!target) return false;
    if (input.matchingField && !candidateVisibleFields(target).includes(input.matchingField)) return false;
    if (!input.temporal) return true;
    const hasOwnMeasure = target.aggregate_measures.length > 0
      || target.count_distinct_fields.length > 0;
    const hasOwnTime = Object.keys(target.time_bucket_fields).length > 0;
    if (hasOwnMeasure && hasOwnTime) return true;
    return Boolean(bestCandidateRoot(boundary.pack.resources, input.targetId, true));
  });
}

function reviewedResourceSummary(
  resource: Record<string, unknown>,
): ReviewedAskResourceSummary | undefined {
  const id = safeIdentifier(resource.id);
  if (!id) return undefined;
  const label = safeLabel(resource.label) ?? businessLabel(id.split(".").at(-1) ?? id);
  const labels = isRecord(resource.field_labels) ? resource.field_labels : {};
  const fieldLabel = (field: string) => safeLabel(labels[field]) ?? businessLabel(field);
  const groups = stringList(resource.groupable_fields).map(fieldLabel);
  const measures = stringList(resource.aggregate_measures).map(fieldLabel);
  const distinct = stringList(resource.count_distinct_fields).map(fieldLabel);
  const time = isRecord(resource.time_bucket_fields)
    ? Object.keys(resource.time_bucket_fields).map(fieldLabel)
    : [];
  const capabilities = [
    "record counts",
    measures.length ? `totals and averages of ${naturalList(measures.slice(0, 3))}` : undefined,
    distinct.length ? `unique counts of ${naturalList(distinct.slice(0, 2))}` : undefined,
    groups.length ? `grouping by ${naturalList(groups.slice(0, 3))}` : undefined,
    time.length ? `day, week, or month using ${naturalList(time.slice(0, 2))}` : undefined,
  ].filter((value): value is string => Boolean(value));
  const suggestions = Array.isArray(resource.suggested_questions)
    ? resource.suggested_questions
      .filter(isRecord)
      .filter((question) => activeSuggestionIsExecutable(resource, question))
      .map((question) => safeQuestion(question.text))
      .filter((question): question is string => Boolean(question))
    : [];
  return { id, label, capabilities, suggestions };
}

function activeSuggestionIsExecutable(
  resource: Record<string, unknown>,
  question: Record<string, unknown>,
): boolean {
  if (question.relationship_review_required === true) return false;
  const relationships = Array.isArray(resource.relationships)
    ? resource.relationships.filter(isRecord)
    : [];
  const fieldAllowed = (
    raw: unknown,
    rootKey: "groupable_fields" | "aggregate_measures" | "count_distinct_fields" | "time_bucket_fields",
  ): boolean => {
    if (typeof raw === "string") return fieldIn(resource, rootKey, raw);
    if (!isRecord(raw) || typeof raw.field !== "string") return false;
    if (typeof raw.relationship !== "string") return fieldIn(resource, rootKey, raw.field);
    const relationship = relationships.find((candidate) =>
      candidate.id === raw.relationship && candidate.activation === "active");
    return relationship ? fieldIn(relationship, rootKey, raw.field) : false;
  };
  const measure = isRecord(question.measure) ? question.measure : undefined;
  if (measure) {
    const fn = measure.function;
    if (fn !== "count") {
      const key = fn === "count_distinct" ? "count_distinct_fields" : "aggregate_measures";
      if (!fieldAllowed(measure, key)) return false;
    }
  }
  if (question.dimension !== undefined
    && !fieldAllowed(question.dimension, "groupable_fields")) return false;
  if (question.time_field !== undefined
    && !fieldAllowed({
      field: question.time_field,
      ...(typeof question.time_relationship === "string"
        ? { relationship: question.time_relationship }
        : {}),
    }, "time_bucket_fields")) return false;
  return Boolean(safeQuestion(question.text));
}

function fieldIn(
  resource: Record<string, unknown>,
  key: "groupable_fields" | "aggregate_measures" | "count_distinct_fields" | "time_bucket_fields",
  field: string,
): boolean {
  return key === "time_bucket_fields"
    ? isRecord(resource[key]) && Object.hasOwn(resource[key], field)
    : stringList(resource[key]).includes(field);
}

function bestCandidateRoot(
  resources: ExplorationBoundaryDraft["pack"]["resources"],
  targetId: string,
  temporal: boolean,
): ExplorationBoundaryDraft["pack"]["resources"][number] | undefined {
  return resources
    .flatMap((resource) => {
      const targetPath = resource.relationships.find((relationship) =>
        relationship.target_resource === targetId && provenManyToOne(relationship));
      if (!targetPath) return [];
      const hasTime = Object.keys(resource.time_bucket_fields).length > 0
        || resource.relationships.some((relationship) => {
          if (!provenManyToOne(relationship)) return false;
          const related = resources.find((candidate) => candidate.id === relationship.target_resource);
          return Boolean(related && Object.keys(related.time_bucket_fields).length > 0);
        });
      const hasMeasure = resource.aggregate_measures.length > 0 || resource.count_distinct_fields.length > 0;
      const score = 10 + (hasMeasure ? 3 : 0) + (temporal && hasTime ? 5 : 0);
      return temporal && !hasTime ? [] : [{ resource, score }];
    })
    .sort((left, right) => right.score - left.score || left.resource.id.localeCompare(right.resource.id))[0]
    ?.resource;
}

function candidatePathSummary(
  root: ExplorationBoundaryDraft["pack"]["resources"][number],
  targetId: string,
  resources: ExplorationBoundaryDraft["pack"]["resources"],
  temporal: boolean,
): string {
  const paths = root.relationships
    .filter((relationship) => relationship.target_resource === targetId && provenManyToOne(relationship));
  if (temporal && Object.keys(root.time_bucket_fields).length === 0) {
    const timePath = root.relationships.find((relationship) => {
      if (!provenManyToOne(relationship)) return false;
      const target = resources.find((resource) => resource.id === relationship.target_resource);
      return Boolean(target && Object.keys(target.time_bucket_fields).length > 0);
    });
    if (timePath && !paths.some((path) => path.id === timePath.id)) paths.push(timePath);
  }
  return [businessLabel(root.table), ...paths.map((relationship) => {
    const target = resources.find((resource) => resource.id === relationship.target_resource);
    return businessLabel(target?.table ?? relationship.target_resource);
  })].join(" -> ");
}

function provenManyToOne(
  relationship: ExplorationBoundaryDraft["pack"]["resources"][number]["relationships"][number],
): boolean {
  return relationship.cardinality === "many_to_one"
    && relationship.proof?.source === "database_catalog"
    && relationship.proof.links.length >= 1
    && relationship.proof.links.length <= 2
    && relationship.proof.links.every((link) =>
      link.cardinality === "many_to_one"
      && link.max_fan_out === 1
      && link.target_uniqueness.columns.length === link.target_columns.length);
}

async function readGeneratedBoundaryDraft(projectRoot: string): Promise<ExplorationBoundaryDraft> {
  const journey = await readGuidedOnboardingState(projectRoot);
  const root = path.resolve(projectRoot);
  const boundaryRoot = path.resolve(root, journey?.artifacts.boundary_root ?? "synapsor/generated");
  const relative = path.relative(root, boundaryRoot);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Managed boundary root escapes the selected project.");
  }
  const filePath = path.join(boundaryRoot, "exploration-boundary.draft.json");
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) {
    throw new Error("Generated boundary draft must be a bounded regular project file.");
  }
  const value = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  if (!isRecord(value) || !isRecord(value.pack) || !Array.isArray(value.pack.resources)) {
    throw new Error("Generated boundary draft is invalid.");
  }
  return value as ExplorationBoundaryDraft;
}

function candidateVisibleFields(
  resource: ExplorationBoundaryDraft["pack"]["resources"][number],
): string[] {
  return unique([
    ...resource.selectable_fields,
    ...Object.keys(resource.filterable_fields),
    ...resource.groupable_fields,
    ...resource.aggregate_measures,
    ...resource.count_distinct_fields,
    ...Object.keys(resource.time_bucket_fields),
  ]).filter((field) => !resource.kept_out_fields.includes(field));
}

function asksForDerivedFormula(question: string): boolean {
  return /\b(rate|ratio|percentage|percent|conversion|average order value)\b/.test(question);
}

function asksForTimeComparison(question: string): boolean {
  return /\b(change|changed|growth|growing|grew|trend|week|month|day|period|over time)\b/.test(question);
}

function phraseMatches(question: string, value: string): boolean {
  const phrase = normalizedSearchText(value.split(".").at(-1) ?? value);
  if (!phrase) return false;
  if (question.includes(phrase)) return true;
  const terms = new Set(question.split(" ").map(singularTerm));
  return phrase.split(" ").every((term) => terms.has(singularTerm(term)));
}

function normalizedSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function singularTerm(value: string): string {
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith("s") && !value.endsWith("ss") && value.length > 3) return value.slice(0, -1);
  return value;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_.-]{0,255}$/.test(value)
    ? value
    : undefined;
}

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const label = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return label ? label.slice(0, 80) : undefined;
}

function safeQuestion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const question = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return question && question.length <= 240 ? question : undefined;
}

function businessLabel(value: string): string {
  const normalized = value.replace(/[_.-]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized ? normalized[0]!.toUpperCase() + normalized.slice(1) : "Reviewed data";
}

function naturalList(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
