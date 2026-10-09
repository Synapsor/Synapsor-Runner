import { AskError } from "./model-provider-transport.js";
import type { OperatorQuestion } from "./authoring-operator-question.js";
import type { PolicyTextSnapshot } from "./authoring-policy-source.js";

/** Locators from the current Source producer's existing needs-information
 * response. Naming context only: no adopted requirement or answer provenance. */
export type ActionRuleSourceQuestionPassageV1 = {
  start: number;
  end: number;
  identifiers: string[];
};
const identifier = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function invalid(): never {
  throw new AskError("OPERATOR_QUESTION_CONTEXT_INVALID",
    "The current input's exact bounded naming passages are unavailable or changed. Preserve the saved question and answer; no Source meaning or completion was inferred.", 409);
}

/** Shape validation for the existing question envelope. This carries no
 * consumption provenance; the actual producer/host retain that responsibility. */
export function parseActionRuleSourceQuestionPassageShape(value: unknown,
  maxLines = 600): ActionRuleSourceQuestionPassageV1[] {
  if (!Array.isArray(value) || !value.length || value.length > 12) invalid();
  const keys = new Set<string>();
  let selectedLines = 0;
  const passages = value.map(raw => {
    if (!object(raw) || Object.keys(raw).some(key => !["start", "end", "identifiers"].includes(key))
      || !Number.isSafeInteger(raw.start) || !Number.isSafeInteger(raw.end)
      || (raw.start as number) < 1 || (raw.end as number) < (raw.start as number) || (raw.end as number) > maxLines
      || !Array.isArray(raw.identifiers) || !raw.identifiers.length || raw.identifiers.length > 16
      || raw.identifiers.some(id => typeof id !== "string" || id.length > 128 || !identifier.test(id))
      || new Set(raw.identifiers).size !== raw.identifiers.length) invalid();
    const start = raw.start as number, end = raw.end as number, identifiers = raw.identifiers as string[];
    selectedLines += end - start + 1;
    const key = JSON.stringify({ start, end, identifiers });
    if (keys.has(key)) invalid();
    keys.add(key);
    return { start, end, identifiers: [...identifiers] };
  });
  if (selectedLines > 12) invalid();
  return passages;
}

/** Current-source validation creates no evidence record, actor, digest or
 * allowance. Actual decoding and protected child persistence remain with the
 * existing producer/controller and Resume CAS. */
export function parseActionRuleSourceQuestionPassages(value: unknown, root: OperatorQuestion,
  source: PolicyTextSnapshot): ActionRuleSourceQuestionPassageV1[] {
  const binding = root.source_binding;
  if (root.kind !== "input_bounds" || !binding || source.digest !== binding.source_digest
    || source.lines !== binding.lines) invalid();
  const passages = parseActionRuleSourceQuestionPassageShape(value, source.lines);
  const lines = source.text.split("\n");
  for (const passage of passages) {
    const text = lines.slice(passage.start - 1, passage.end).join("\n");
    const tokens = new Set([...text.matchAll(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/gu)].map(match => match[0]));
    if (passage.identifiers.some(id => !tokens.has(id))) invalid();
  }
  if (Buffer.byteLength(JSON.stringify(passages.map(p => ({...p,text:lines.slice(p.start-1,p.end).join("\n")}))), "utf8") > 8_192) invalid();
  return passages;
}
