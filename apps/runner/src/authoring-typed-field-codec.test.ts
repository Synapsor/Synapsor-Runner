import { describe, expect, it } from "vitest";
import { decodeTypedFieldLiteral, formatTypedFieldValue, isValidTypedFieldValue } from "./authoring-typed-field-codec.js";
import type { TypedReviewField } from "./authoring-typed-review.js";
const id = { id: "reviewers", target_digest: "sha256:target", dependencies_digest: "sha256:dependencies", label: "Reviewers", required: true } as const;
const count: TypedReviewField = { ...id, kind: "integer", minimum: 1, maximum: 20 };
const money: TypedReviewField = { ...id, kind: "money", currency: "USD", scale: 2, minimum_minor: -9007199254740991, maximum_minor: 9007199254740991 };
describe("host field exact literal codec", () => {
  it.each(["", " ", " 2", "2 ", "2.0", "2e0", "02", "+2", "-0", "2 reviewers", "2, keep the rest", "0x2", "2\n"])("refuses non-integer literal %j", raw => expect(decodeTypedFieldLiteral(count, raw).ok).toBe(false));
  it("preserves a supported integer and rejects bounds", () => {
    expect(decodeTypedFieldLiteral(count, "2")).toEqual({ ok: true, value: { kind: "integer", value: 2 } });
    expect(decodeTypedFieldLiteral(count, "0").ok).toBe(false); expect(decodeTypedFieldLiteral(count, "9007199254740992").ok).toBe(false);
  });
  it.each(["", "50.001", "50,00", "$50", "50 USD", "50 but only VIP", "1e2", " 50", "50\n", "-0", "-0.00"])("refuses unsupported money syntax %j", raw => expect(decodeTypedFieldLiteral(money, raw).ok).toBe(false));
  it("converts declared money exactly without float rounding", () => {
    expect(decodeTypedFieldLiteral(money, "90071992547409.91")).toEqual({ ok: true, value: { kind: "money", currency: "USD", scale: 2, minor_units: Number.MAX_SAFE_INTEGER } });
    expect(decodeTypedFieldLiteral(money, "90071992547409.92").ok).toBe(false);
    expect(decodeTypedFieldLiteral(money, "0.29")).toEqual({ ok: true, value: { kind: "money", currency: "USD", scale: 2, minor_units: 29 } });
    expect(decodeTypedFieldLiteral(money, "50")).toEqual({ ok: true, value: { kind: "money", currency: "USD", scale: 2, minor_units: 5000 } });
    expect(formatTypedFieldValue({ kind: "money", currency: "USD", scale: 2, minor_units: -1 })).toBe("-0.01");
  });
  it("checks currency, scale, kind, options and bounds before keep", () => {
    expect(isValidTypedFieldValue(money, { kind: "money", currency: "EUR", scale: 2, minor_units: 10 })).toBe(false);
    expect(isValidTypedFieldValue(money, { kind: "money", currency: "USD", scale: 3, minor_units: 10 })).toBe(false);
    expect(isValidTypedFieldValue(count, { kind: "integer", value: 2.5 })).toBe(false);
    expect(decodeTypedFieldLiteral({ ...count, minimum: NaN }, "2").ok).toBe(false);
    const choice: TypedReviewField = { ...id, kind: "choice", options: [{ value: "inclusive", label: "At most" }] };
    expect(decodeTypedFieldLiteral(choice, "inclusive").ok).toBe(true); expect(decodeTypedFieldLiteral(choice, "Inclusive").ok).toBe(false);
    expect(decodeTypedFieldLiteral({ ...choice, options: [...choice.options, ...choice.options] }, "inclusive").ok).toBe(false);
  });
});
