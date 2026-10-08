import type { TypedFieldValue, TypedReviewField } from "./authoring-typed-review.js";

export type TypedLiteralResult = { ok: true; value: TypedFieldValue } | { ok: false; message: string };
const invalid = (message: string): TypedLiteralResult => ({ ok: false, message });
const integer = /^-?(?:0|[1-9][0-9]*)$/u;
const decimal = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/u;
const safeBounds = (min: number, max: number) => Number.isSafeInteger(min) && Number.isSafeInteger(max) && min <= max;

/** Local syntax and domain-bound checks only. The domain owner calls this again
 * on the raw operator event before writing. No prefix parsing, coercion, model,
 * locale guessing, floating-point arithmetic, or generated field schema. */
export function decodeTypedFieldLiteral(field: TypedReviewField, raw: string): TypedLiteralResult {
  if (raw.length > 512) return invalid("This literal is too long. Keep the text for Describe a correction, or enter one exact value.");
  if (field.kind === "choice") {
    if (!field.options.length || new Set(field.options.map(option => option.value)).size !== field.options.length)
      return invalid("The current choices are not valid. Reopen the current proposal.");
    return field.options.some(option => option.value === raw)
      ? { ok: true, value: { kind: "choice", value: raw } }
      : invalid("Select one of the displayed choices; no other text has been applied.");
  }
  if (field.kind === "integer") {
    if (!safeBounds(field.minimum, field.maximum)) return invalid("The current integer bounds are invalid. Reopen the current proposal.");
    if (integer.exec(raw)?.[0] !== raw || raw === "-0") return invalid("Enter a whole integer only, without spaces, decimals or instructions. Your text has not been applied.");
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < field.minimum || value > field.maximum)
      return invalid(`Enter an integer from ${field.minimum} through ${field.maximum}. Your text has not been applied.`);
    return { ok: true, value: { kind: "integer", value } };
  }
  if (field.currency.length !== 3 || !/^[A-Z]{3}$/u.test(field.currency) || !Number.isSafeInteger(field.scale) || field.scale < 0 || field.scale > 18
    || !safeBounds(field.minimum_minor, field.maximum_minor)) return invalid("The current money unit, precision or bounds are invalid. Reopen the current proposal.");
  const match = decimal.exec(raw);
  if (!match || match[0] !== raw || (match[3]?.length ?? 0) > field.scale)
    return invalid(`Enter one ${field.currency} amount with at most ${field.scale} decimal places, without spaces or instructions. No rounding was applied.`);
  const digits = match[2]! + (match[3] ?? "").padEnd(field.scale, "0");
  const minor = BigInt(digits) * (match[1] ? -1n : 1n);
  if (minor < BigInt(field.minimum_minor) || minor > BigInt(field.maximum_minor) || match[1] && minor === 0n)
    return invalid("The amount is outside the current exact money bounds. Your text has not been applied.");
  return { ok: true, value: { kind: "money", minor_units: Number(minor), currency: field.currency, scale: field.scale } };
}

export function isValidTypedFieldValue(field: TypedReviewField, value: TypedFieldValue): boolean {
  if (field.kind !== value.kind) return false;
  if (value.kind === "integer") return Number.isSafeInteger(value.value) && decodeTypedFieldLiteral(field, String(value.value)).ok;
  if (value.kind === "choice") return decodeTypedFieldLiteral(field, value.value).ok;
  if (field.kind !== "money" || value.currency !== field.currency || value.scale !== field.scale
    || !Number.isSafeInteger(value.minor_units)) return false;
  return decodeTypedFieldLiteral(field, formatTypedFieldValue(value)).ok;
}

/** Display exact declared scale; never guess currency precision. */
export function formatTypedFieldValue(value: TypedFieldValue): string {
  if (value.kind === "integer") return String(value.value);
  if (value.kind === "choice") return value.value;
  if (!Number.isSafeInteger(value.minor_units) || !Number.isSafeInteger(value.scale) || value.scale < 0 || value.scale > 18)
    return "Invalid money suggestion (not available to keep)";
  const digits = String(Math.abs(value.minor_units)).padStart(value.scale + 1, "0");
  return `${value.minor_units < 0 ? "-" : ""}${value.scale ? `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}` : digits}`;
}
