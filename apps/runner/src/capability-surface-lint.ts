import type { ArgumentSpec, CapabilitySpec, JsonScalar, SynapsorContract } from "@synapsor/spec";

export const CAPABILITY_SURFACE_DENSITY_REVIEW_THRESHOLD = 8;

export type CapabilitySurfaceFinding = {
  code: "SURFACE_GENERIC_ARGUMENT" | "SURFACE_TARGET_DENSITY" | "SURFACE_OPERATION_NAMING" | "SURFACE_NEAR_DUPLICATE";
  severity: "warning";
  path: string;
  message: string;
  details: Record<string, string | number | string[]>;
};

export type CapabilitySurfaceTargetSummary = {
  target: string;
  capability_count: number;
  capabilities: string[];
  density_warning: boolean;
};

export type CapabilitySurfaceAnalysis = {
  findings: CapabilitySurfaceFinding[];
  summary: {
    total_capabilities: number;
    target_count: number;
    density_review_threshold: number;
    targets: CapabilitySurfaceTargetSummary[];
  };
};

type IndexedCapability = {
  capability: CapabilitySpec;
  targetKey: string;
  targetLabel: string;
};

const GENERIC_ARGUMENT_NAMES = new Set(["filter", "predicate", "query", "sql", "where"]);
const ACTION_PREFIXES = new Set([
  "add", "answer", "archive", "assign", "cancel", "change", "close", "count", "create", "delete", "export", "find",
  "get", "grant", "inspect", "list", "lookup", "open", "propose", "read", "refund", "remove", "request", "resolve",
  "restore", "revert", "search", "set", "sum", "update", "verify", "waive", "write",
]);
const ACTION_SUFFIXES = new Set(["average", "count", "lookup", "review", "search", "summary", "total"]);
const GENERIC_OPERATION_WORDS = new Set([
  "create", "data", "database", "db", "delete", "execute", "get", "item", "manage", "mutate", "object", "process",
  "query", "read", "record", "resource", "row", "run", "set", "sql", "table", "thing", "update", "write",
]);

export function analyzeCapabilitySurface(contract: SynapsorContract): CapabilitySurfaceAnalysis {
  const resources = new Map((contract.resources ?? []).map((resource) => [resource.name, resource]));
  const indexed = contract.capabilities.map((capability): IndexedCapability => {
    const resource = capability.subject.resource ? resources.get(capability.subject.resource) : undefined;
    const source = capability.source ?? resource?.engine ?? "unresolved-source";
    const schema = capability.subject.schema ?? resource?.schema ?? "unresolved-schema";
    const table = capability.subject.table ?? resource?.table ?? capability.subject.resource ?? "unresolved-object";
    return {
      capability,
      targetKey: `${source}\u0000${schema}\u0000${table}`,
      targetLabel: `${source}:${schema}.${table}`,
    };
  });

  const findings: CapabilitySurfaceFinding[] = [];
  for (const entry of indexed) {
    collectGenericArgumentFindings(findings, entry);
    collectOperationNamingFinding(findings, entry);
  }

  const grouped = new Map<string, IndexedCapability[]>();
  for (const entry of indexed) grouped.set(entry.targetKey, [...(grouped.get(entry.targetKey) ?? []), entry]);

  const targets = [...grouped.values()]
    .map((entries): CapabilitySurfaceTargetSummary => {
      const sortedEntries = [...entries].sort((left, right) => left.capability.name.localeCompare(right.capability.name));
      const capabilityNames = sortedEntries.map((entry) => entry.capability.name);
      const densityWarning = entries.length > CAPABILITY_SURFACE_DENSITY_REVIEW_THRESHOLD;
      if (densityWarning) {
        findings.push({
          code: "SURFACE_TARGET_DENSITY",
          severity: "warning",
          path: "$.capabilities",
          message: `${entries[0]!.targetLabel} exposes ${entries.length} capabilities, above the advisory review threshold of ${CAPABILITY_SURFACE_DENSITY_REVIEW_THRESHOLD}. Review whether every operation belongs on the same model-facing surface or should be consolidated or assigned to a narrower agent.`,
          details: {
            target: entries[0]!.targetLabel,
            capability_count: entries.length,
            review_threshold: CAPABILITY_SURFACE_DENSITY_REVIEW_THRESHOLD,
            capabilities: capabilityNames,
          },
        });
      }
      collectNearDuplicateFindings(findings, sortedEntries);
      return {
        target: entries[0]!.targetLabel,
        capability_count: entries.length,
        capabilities: capabilityNames,
        density_warning: densityWarning,
      };
    })
    .sort((left, right) => left.target.localeCompare(right.target));

  findings.sort((left, right) => left.code.localeCompare(right.code) || left.path.localeCompare(right.path) || left.message.localeCompare(right.message));
  return {
    findings,
    summary: {
      total_capabilities: indexed.length,
      target_count: targets.length,
      density_review_threshold: CAPABILITY_SURFACE_DENSITY_REVIEW_THRESHOLD,
      targets,
    },
  };
}

function collectGenericArgumentFindings(findings: CapabilitySurfaceFinding[], entry: IndexedCapability): void {
  const visit = (arg: ArgumentSpec, argName: string, argPath: string): void => {
    if (arg.type === "object_array") {
      for (const [fieldName, field] of Object.entries(arg.fields).sort(([left], [right]) => left.localeCompare(right))) {
        visit(field, fieldName, `${argPath}.fields.${fieldName}`);
      }
      return;
    }
    const normalizedName = normalizeIdentifier(argName);
    if (arg.type !== "string" || (arg.enum?.length ?? 0) > 0 || !GENERIC_ARGUMENT_NAMES.has(normalizedName)) return;
    findings.push({
      code: "SURFACE_GENERIC_ARGUMENT",
      severity: "warning",
      path: argPath,
      message: `${entry.capability.name} exposes un-enumerated string argument ${argName}, a generic query/predicate-style name. Runner does not turn it into SQL, but reviewers should confirm this remains a named business operation instead of an escape-hatch surface.`,
      details: { capability: entry.capability.name, argument: argName },
    });
  };
  for (const [argName, arg] of Object.entries(entry.capability.args).sort(([left], [right]) => left.localeCompare(right))) {
    visit(arg, argName, `${capabilityPath(entry.capability.name)}.args.${argName}`);
  }
}

function collectOperationNamingFinding(findings: CapabilitySurfaceFinding[], entry: IndexedCapability): void {
  const operation = entry.capability.name.split(".").at(-1) ?? entry.capability.name;
  const tokens = tokenizeIdentifier(operation);
  const genericOnly = tokens.length > 0 && tokens.every((token) => GENERIC_OPERATION_WORDS.has(token));
  const actionOriented = tokens.length >= 2 && (ACTION_PREFIXES.has(tokens[0]!) || ACTION_SUFFIXES.has(tokens.at(-1)!));
  if (tokens.length >= 2 && actionOriented && !genericOnly) return;
  findings.push({
    code: "SURFACE_OPERATION_NAMING",
    severity: "warning",
    path: `${capabilityPath(entry.capability.name)}.name`,
    message: `${entry.capability.name} does not read as a high-confidence named business operation. Use a reviewer-recognizable operation such as inspect_invoice or propose_plan_credit; this is a naming heuristic, not a runtime enforcement failure.`,
    details: { capability: entry.capability.name, operation, tokens },
  });
}

function collectNearDuplicateFindings(findings: CapabilitySurfaceFinding[], entries: IndexedCapability[]): void {
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const left = entries[leftIndex]!;
      const right = entries[rightIndex]!;
      if (left.capability.kind !== right.capability.kind || capabilityShape(left.capability) !== capabilityShape(right.capability)) continue;
      const relationship = compareArgumentSurfaces(left.capability.args, right.capability.args);
      if (!relationship) continue;
      const differences = relationship.differences.length > 0 ? relationship.differences : ["identical model-visible arguments"];
      findings.push({
        code: "SURFACE_NEAR_DUPLICATE",
        severity: "warning",
        path: "$.capabilities",
        message: `${left.capability.name} and ${right.capability.name} have the same target, kind, reviewed fields, targeting, and write/approval shape, with only this argument-surface difference: ${differences.join("; ")}. Review whether both operations are necessary or one is a loosened duplicate.`,
        details: {
          target: left.targetLabel,
          capabilities: [left.capability.name, right.capability.name],
          relationship: relationship.relationship,
          differences,
        },
      });
    }
  }
}

function capabilityShape(capability: CapabilitySpec): string {
  const { name: _name, description: _description, returns_hint: _returnsHint, args: _args, ...shape } = capability;
  return stableString(shape);
}

function compareArgumentSurfaces(
  left: Record<string, ArgumentSpec>,
  right: Record<string, ArgumentSpec>,
): { relationship: string; differences: string[] } | undefined {
  if (stableString(stripArgumentDescriptions(left)) === stableString(stripArgumentDescriptions(right))) {
    return { relationship: "identical", differences: [] };
  }
  const leftLooser = argumentMapNoStricter(left, right);
  const rightLooser = argumentMapNoStricter(right, left);
  if (leftLooser && !rightLooser) return { relationship: "left_is_looser", differences: describeRelaxations(left, right) };
  if (rightLooser && !leftLooser) return { relationship: "right_is_looser", differences: describeRelaxations(right, left) };
  return undefined;
}

function argumentMapNoStricter(looser: Record<string, ArgumentSpec>, stricter: Record<string, ArgumentSpec>): boolean {
  for (const [name, strictArg] of Object.entries(stricter)) {
    const looseArg = looser[name];
    if (!looseArg || !argumentNoStricter(looseArg, strictArg)) return false;
  }
  return Object.entries(looser)
    .filter(([name]) => !(name in stricter))
    .every(([, arg]) => arg.required !== true);
}

function argumentNoStricter(looser: ArgumentSpec, stricter: ArgumentSpec): boolean {
  if (looser.type !== stricter.type) return false;
  if (looser.required === true && stricter.required !== true) return false;
  if (looser.type === "object_array" && stricter.type === "object_array") {
    if (!sameExtensions(looser, stricter)) return false;
    if (looser.max_items < stricter.max_items) return false;
    return argumentMapNoStricter(looser.fields, stricter.fields);
  }
  if (looser.type === "object_array" || stricter.type === "object_array") return false;
  if (!sameExtensions(looser, stricter)) return false;
  if ((looser.max_length ?? Number.POSITIVE_INFINITY) < (stricter.max_length ?? Number.POSITIVE_INFINITY)) return false;
  if ((looser.minimum ?? Number.NEGATIVE_INFINITY) > (stricter.minimum ?? Number.NEGATIVE_INFINITY)) return false;
  if ((looser.maximum ?? Number.POSITIVE_INFINITY) < (stricter.maximum ?? Number.POSITIVE_INFINITY)) return false;
  return enumContains(looser.enum, stricter.enum);
}

function enumContains(looser: readonly JsonScalar[] | undefined, stricter: readonly JsonScalar[] | undefined): boolean {
  if (!looser?.length) return true;
  if (!stricter?.length) return false;
  const looseValues = new Set(looser.map((value) => stableString(value)));
  return stricter.every((value) => looseValues.has(stableString(value)));
}

function describeRelaxations(looser: Record<string, ArgumentSpec>, stricter: Record<string, ArgumentSpec>): string[] {
  const differences: string[] = [];
  for (const name of Object.keys(looser).sort()) {
    const looseArg = looser[name]!;
    const strictArg = stricter[name];
    if (!strictArg) {
      differences.push(`${name} adds an optional argument`);
      continue;
    }
    describeArgumentRelaxations(looseArg, strictArg, name, differences);
  }
  return differences;
}

function describeArgumentRelaxations(looser: ArgumentSpec, stricter: ArgumentSpec, path: string, differences: string[]): void {
  if (looser.required !== true && stricter.required === true) differences.push(`${path} becomes optional`);
  if (looser.type === "object_array" && stricter.type === "object_array") {
    if (looser.max_items > stricter.max_items) differences.push(`${path}.max_items increases from ${stricter.max_items} to ${looser.max_items}`);
    for (const name of Object.keys(looser.fields).sort()) {
      const looseField = looser.fields[name]!;
      const strictField = stricter.fields[name];
      if (!strictField) differences.push(`${path}.${name} adds an optional field`);
      else describeArgumentRelaxations(looseField, strictField, `${path}.${name}`, differences);
    }
    return;
  }
  if (looser.type === "object_array" || stricter.type === "object_array") return;
  if ((looser.max_length ?? Number.POSITIVE_INFINITY) > (stricter.max_length ?? Number.POSITIVE_INFINITY)) differences.push(`${path}.max_length widens from ${displayBound(stricter.max_length)} to ${displayBound(looser.max_length)}`);
  if ((looser.minimum ?? Number.NEGATIVE_INFINITY) < (stricter.minimum ?? Number.NEGATIVE_INFINITY)) differences.push(`${path}.minimum widens from ${displayBound(stricter.minimum)} to ${displayBound(looser.minimum)}`);
  if ((looser.maximum ?? Number.POSITIVE_INFINITY) > (stricter.maximum ?? Number.POSITIVE_INFINITY)) differences.push(`${path}.maximum widens from ${displayBound(stricter.maximum)} to ${displayBound(looser.maximum)}`);
  if (stableString(looser.enum ?? []) !== stableString(stricter.enum ?? [])) differences.push(`${path}.enum widens from ${displayEnum(stricter.enum)} to ${displayEnum(looser.enum)}`);
}

function stripArgumentDescriptions(args: Record<string, ArgumentSpec>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).map(([name, arg]) => [name, stripArgumentDescription(arg)]));
}

function stripArgumentDescription(arg: ArgumentSpec): Record<string, unknown> {
  const { description: _description, ...rest } = arg;
  if (arg.type !== "object_array") return rest;
  return { ...rest, fields: Object.fromEntries(Object.entries(arg.fields).map(([name, field]) => [name, stripArgumentDescription(field)])) };
}

function sameExtensions(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const extensionEntries = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => key.startsWith("x-")));
  return stableString(extensionEntries(left)) === stableString(extensionEntries(right));
}

function normalizeIdentifier(value: string): string {
  return tokenizeIdentifier(value).join("_");
}

function capabilityPath(name: string): string {
  return `$.capabilities[name=${JSON.stringify(name)}]`;
}

function tokenizeIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function stableString(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, stableValue(nested)]));
}

function displayBound(value: number | undefined): string {
  return value === undefined ? "unbounded" : String(value);
}

function displayEnum(value: readonly unknown[] | undefined): string {
  return value?.length ? JSON.stringify([...value].map(stableValue).sort()) : "any value";
}
