import crypto from "node:crypto";

type CanonicalJson = null | boolean | number | string | CanonicalJson[] | { [key: string]: CanonicalJson };

/** Serialize reviewed protocol data independently of object insertion order. */
export function canonicalJsonStringify(input: unknown): string {
  return JSON.stringify(canonicalJsonValue(input, new Set<object>()));
}

/** Hash reviewed protocol data with deterministic recursive object-key ordering. */
export function canonicalJsonDigest(input: unknown): `sha256:${string}` {
  return `sha256:${crypto.createHash("sha256").update(canonicalJsonStringify(input)).digest("hex")}`;
}

function canonicalJsonValue(input: unknown, ancestors: Set<object>): CanonicalJson {
  if (input === null || typeof input === "string" || typeof input === "boolean") return input;
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new TypeError("canonical JSON accepts only finite numbers");
    return Object.is(input, -0) ? 0 : input;
  }
  if (Array.isArray(input)) {
    if (ancestors.has(input)) throw new TypeError("canonical JSON does not accept circular values");
    ancestors.add(input);
    const output = input.map((item) => canonicalJsonValue(item, ancestors));
    ancestors.delete(input);
    return output;
  }
  if (typeof input !== "object" || input === undefined) throw new TypeError("canonical JSON accepts only JSON values");
  const record = input as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("canonical JSON accepts only plain objects");
  if (ancestors.has(record)) throw new TypeError("canonical JSON does not accept circular values");
  ancestors.add(record);
  const output: Record<string, CanonicalJson> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value === undefined) throw new TypeError("canonical JSON does not accept undefined values");
    output[key] = canonicalJsonValue(value, ancestors);
  }
  ancestors.delete(record);
  return output;
}
