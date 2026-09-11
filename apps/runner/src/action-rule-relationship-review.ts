import { actionRuleRelationshipPairs } from "@synapsor-runner/action-rules";
import type { AskToolDefinition } from "./model-ask.js";
import type { BuiltActionRuleAuthoringCatalogV1 } from "./action-rule-authoring.js";

export const actionRelationshipTools = [
  {
    name: "runner.inspect_action_relationships", title: "Inspect existing relationship paths",
    description: "Discover direct links or bounded multistep paths between catalog resources. A missing direct link does not mean there is no reviewed path. Prepare each selected path step and chain Verification bindings. Metadata only; no rows, SQL, schema changes or authority. Use this instead of asking the operator to expose a join.",
    input_schema: { type: "object", required: ["from_resource", "to_resource"], additionalProperties: false,
      properties: { from_resource: { type: "string" }, to_resource: { type: "string" } } },
  },
  {
    name: "runner.review_action_relationship", title: "Prepare an existing link for disabled review",
    description: "Select one exact inspected relationship for this disabled Action draft. Runner retains every key pair, including scope columns. Does not expose fields in Read, activate or write. Then use the relationship name in the Verification draft. Ask only about ambiguous business meaning, not join mechanics.",
    input_schema: { type: "object", required: ["from_resource", "to_resource", "relationship"], additionalProperties: false,
      properties: { from_resource: { type: "string" }, to_resource: { type: "string" }, relationship: { type: "string" } } },
  },
] satisfies AskToolDefinition[];

export function inspectActionRelationships(input: {
  built: BuiltActionRuleAuthoringCatalogV1;
  args: unknown;
  reviewed: Set<string>;
  prepare: boolean;
}) {
  const args = input.args as Record<string, unknown> | undefined;
  const keys = input.prepare ? ["from_resource", "to_resource", "relationship"] : ["from_resource", "to_resource"];
  if (!args || typeof args !== "object" || Array.isArray(args)
    || Object.keys(args).some((key) => !keys.includes(key))
    || keys.some((key) => typeof args[key] !== "string" || !/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(args[key] as string))) {
    throw new Error("ACTION_RULE_RELATIONSHIP_SELECTION_INVALID: use exact catalog resource identifiers and, for review, one exact relationship name. No joins or values are accepted.");
  }
  const from = args.from_resource as string;
  const to = args.to_resource as string;
  const allowed = new Set(input.built.catalog.resources.map((resource) => resource.name));
  const available = allowed.has(from) && allowed.has(to);
  const connects = (source: string | undefined, target: string | undefined) =>
    (source === from && target === to) || (source === to && target === from);
  const candidates = available ? input.built.catalog.relationships.filter((relationship) =>
    connects(relationship.from_resource, relationship.to_resource)
    && (!input.prepare || relationship.name === args.relationship)) : [];
  const unsupported = input.built.authoring.diagnostics.filter((diagnostic) =>
    diagnostic.relationship && connects(diagnostic.resource, diagnostic.target_resource)
    && (!input.prepare || diagnostic.relationship === args.relationship));
  const search = available && !input.prepare && candidates.length === 0
    ? inspectRelationshipPaths(input.built, from, to) : undefined;
  const status = !available ? "outside_catalog" : candidates.length > 1 ? "ambiguous"
    : search?.paths.length ? "candidate_paths"
    : search?.limited ? "path_search_bounded"
    : candidates.length === 0 ? (unsupported.length ? "unsupported" : "missing")
      : input.reviewed.has(candidates[0]!.name) ? "already_reviewed" : "available_unreviewed";
  const selected = input.prepare && candidates.length === 1 ? candidates[0] : undefined;
  if (selected) input.reviewed.add(selected.name);
  return {
    status: selected ? "already_reviewed" as const : status,
    prepared_disabled: !!selected,
    ...(search ? { paths: search.paths, path_search: { limited: search.limited, maximum_hops: 11, maximum_paths: 16, maximum_expansions: 512 } } : {}),
    candidates: candidates.map((relationship) => ({ ...relationship,
      status: input.reviewed.has(relationship.name) ? "already_reviewed" : "available_unreviewed",
      direction: relationship.from_resource === from ? "forward" : "inverse",
      key_pairs: actionRuleRelationshipPairs(relationship),
      null_behavior: "Any null component does not match; missing or ambiguous targets cannot authorize an update.",
    })),
    diagnostics: unsupported,
    next_step: selected ? "Use this exact name and direction in the disabled Verification draft; Runner supplies all join fields privately. Final authority review is still required."
      : status === "candidate_paths" ? "Use the job's business meaning to select a path, prepare each exact step with runner.review_action_relationship, and chain source.from_binding through the intermediate Verification resources. Keep every key pair and required business correlation; a many-row route is not a proven one-row update target. Compile the complete draft before claiming support. Do not ask the operator to add a direct foreign key when an existing path fits."
      : status === "path_search_bounded" ? "The bounded path search did not finish. No missing-relationship conclusion is established. Inspect a specific intermediate catalog resource; keep the job and policy unchanged."
      : status === "ambiguous" ? "Choose by the job's business meaning; ask one business question if the meanings differ. Never pick arbitrarily."
        : status === "available_unreviewed" || status === "already_reviewed" ? "Prepare this exact existing link, or include it in the disabled Verification draft."
          : "No supported link can be prepared here. Explain the precise capability limit once, preserve the draft and ask whether to revise the business outcome; approval cannot invent a join.",
    catalog_digest: input.built.authoring.digest,
    read_exposure_changed: false, authority_granted: false,
    metadata_query_performed: false, source_rows_read: false, source_database_changed: false,
  };
}

function inspectRelationshipPaths(built: BuiltActionRuleAuthoringCatalogV1, from: string, to: string) {
  const resources = new Set(built.catalog.resources.map((resource) => resource.name));
  const edges = built.catalog.relationships.filter((edge) => resources.has(edge.from_resource) && resources.has(edge.to_resource))
    .flatMap((edge) => (["forward", "inverse"] as const).map((direction) => ({
      relationship: edge.name, direction,
      from_resource: direction === "forward" ? edge.from_resource : edge.to_resource,
      to_resource: direction === "forward" ? edge.to_resource : edge.from_resource,
      cardinality: (direction === "forward" ? edge.cardinality === "one_to_many" : edge.cardinality === "many_to_one") ? "many" as const : "one" as const,
      key_pairs: actionRuleRelationshipPairs(edge),
    }))).sort((a, b) => a.relationship.localeCompare(b.relationship) || a.direction.localeCompare(b.direction));
  type Step = typeof edges[number];
  const adjacency = new Map<string, Step[]>();
  for (const edge of edges) adjacency.set(edge.from_resource, [...(adjacency.get(edge.from_resource) ?? []), edge]);
  const queue: Array<{ current: string; seen: Set<string>; steps: Step[] }> = [{ current: from, seen: new Set([from]), steps: [] }];
  const paths: Array<{ steps: Step[]; one_row_path: boolean }> = [];
  let expansions = 0;
  let limited = false;
  // Twelve Verification bindings permit at most eleven links from a subject.
  // This is metadata discovery, never permission to skip compiler cardinality,
  // resource-budget, scope, lock, or eligibility checks.
  for (let index = 0; index < queue.length; index++) {
    if (expansions >= 512 || paths.length >= 16) { limited = true; break; }
    const current = queue[index]!;
    for (const edge of adjacency.get(current.current) ?? []) {
      if (current.seen.has(edge.to_resource)) continue;
      if (++expansions > 512 || current.steps.length >= 11 || paths.length >= 16) { limited = true; break; }
      const steps = [...current.steps, edge];
      if (edge.to_resource === to) paths.push({ steps, one_row_path: steps.every((step) => step.cardinality === "one") });
      else queue.push({ current: edge.to_resource, seen: new Set([...current.seen, edge.to_resource]), steps });
    }
  }
  return { paths, limited };
}

export function actionRelationshipReviewDetails(result: ReturnType<typeof inspectActionRelationships>): string[] {
  return [
    `Relationship review: ${result.status}${result.prepared_disabled ? " (disabled draft only)" : ""}`,
    ...result.candidates.flatMap((candidate) => [
      `${candidate.from_resource} -> ${candidate.to_resource} | ${candidate.name}`,
      ...candidate.key_pairs.map((pair) => `  ${pair.local_field} = ${pair.target_field}`),
      `  ${candidate.direction} | ${candidate.cardinality} | exact tuple; nulls do not match`,
    ]),
    ...(result.paths ?? []).flatMap((path, index) => [
      `Path ${index + 1}: ${path.one_row_path ? "unique-row links" : "includes a bounded collection; not an exact update target"}`,
      ...path.steps.flatMap((step) => [`  ${step.from_resource} -> ${step.to_resource} | ${step.relationship} | ${step.direction}`,
        ...step.key_pairs.map((pair) => `    ${pair.local_field} = ${pair.target_field}`)]),
    ]),
    ...(result.path_search?.limited ? ["Path search reached its bound; this is not a complete list. Inspect intermediate resources to continue."] : []),
    ...result.diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
    result.next_step,
    "Existing inspected metadata only. Read exposure unchanged; no metadata query, source rows, writes or activation.",
  ];
}
