import { actionRuleStringMatches, actionRuleStringMinimumValid } from "@synapsor/spec";
import type { ActionRuleInputSpecV1, ActionRuleSpecV1, JsonScalar } from "@synapsor/spec";
import { ActionRuleError } from "./errors.js";

function invalid(message: string): never {
  throw new ActionRuleError("ACTION_RULE_INVALID", message, "rule.inputs");
}

export function validateActionRuleInputDefinitions(inputs: ActionRuleInputSpecV1[] = []): void {
  if (!Array.isArray(inputs) || inputs.length > 32) invalid("Business inputs must be a list of at most 32 reviewed values.");
  const names = new Set<string>();
  for (const input of inputs) {
    if (!input || typeof input !== "object" || Object.keys(input).some((key) => !["name", "description", "type", "minimum", "maximum"].includes(key))) invalid("Business input definition has unsupported fields.");
    if (typeof input.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.name) || ["__proto__", "constructor", "prototype"].includes(input.name) || names.has(input.name)) invalid("Business input names must be exact, unique safe identifiers.");
    names.add(input.name);
    if (typeof input.description !== "string" || !input.description.trim() || input.description.length > 500) invalid(`Input ${input.name} needs a concise business description.`);
    if (!input.type || !["integer", "money_minor", "string", "boolean", "date", "timestamp"].includes(input.type.kind)) invalid(`Input ${input.name} has no supported scalar type.`);
    const numeric = input.type.kind === "integer" || input.type.kind === "money_minor";
    if (numeric && (!Number.isSafeInteger(input.minimum) || !Number.isSafeInteger(input.maximum) || input.minimum! > input.maximum!)) invalid(`Input ${input.name} requires a finite integer minimum and maximum.`);
    if (!numeric && (input.minimum !== undefined || input.maximum !== undefined)) invalid(`Input ${input.name} cannot have numeric bounds.`);
    if (input.type.kind === "string" && !actionRuleStringMinimumValid(input.type)) invalid(`Input ${input.name} has invalid UTF-16 string minimum/maximum bounds.`);
    if (input.type.kind === "string" && input.type.enum?.some(value => !actionRuleStringMatches(value,{max_length: input.type.kind === "string" ? input.type.max_length : 0, min_length: input.type.kind === "string" ? input.type.min_length : undefined}))) invalid(`Input ${input.name} enum must fit its reviewed string bounds.`);
    if (input.type.kind === "string" && (input.type.max_length > 4096 || input.type.max_length < 1 || !Number.isSafeInteger(input.type.max_length))) invalid(`Input ${input.name} requires a string length from 1 through 4096.`);
  }
}

/** Called before reference consumption, and again when evaluating immutable proposals. */
export function validateActionRuleInputs(rule: Pick<ActionRuleSpecV1, "inputs">, value: unknown = {}): Record<string, JsonScalar> {
  const definitions = rule.inputs ?? [];
  validateActionRuleInputDefinitions(definitions);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Business inputs must be one exact object.");
  const supplied = value as Record<string, unknown>;
  const names = new Set(definitions.map((input) => input.name));
  for (const key of Object.keys(supplied)) if (!names.has(key)) invalid(`Business input ${key} is not allowed for this outcome.`);
  const entries: Array<[string, JsonScalar]> = [];
  for (const input of definitions) {
    if (!Object.hasOwn(supplied, input.name)) invalid(`Business input ${input.name} is required: ${input.description}`);
    const candidate = supplied[input.name];
    switch (input.type.kind) {
      case "integer":
      case "money_minor":
        if (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate < input.minimum! || candidate > input.maximum!) invalid(`Input ${input.name} must be an integer from ${input.minimum} through ${input.maximum}.`);
        break;
      case "string":
        if (!actionRuleStringMatches(candidate, input.type)) invalid(`Input ${input.name} must match its reviewed text bounds and allowed values.`);
        break;
      case "boolean":
        if (typeof candidate !== "boolean") invalid(`Input ${input.name} must be true or false.`);
        break;
      case "date":
      case "timestamp": {
        const date = typeof candidate === "string" ? new Date(candidate) : undefined;
        if (!date || !Number.isFinite(date.getTime()) || (input.type.kind === "date"
          ? !/^\d{4}-\d{2}-\d{2}$/.test(candidate as string) || date.toISOString().slice(0, 10) !== candidate
          : date.toISOString() !== candidate)) invalid(`Input ${input.name} must be a canonical ${input.type.kind}.`);
        break;
      }
    }
    entries.push([input.name, candidate as JsonScalar]);
  }
  const result = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 16_384) invalid("Business inputs exceed the 16 KiB request limit.");
  return result;
}
