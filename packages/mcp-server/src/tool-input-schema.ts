import {
  z,
} from "zod";
import type {
  Scalar,
  RuntimeCapabilityConfig,
  RuntimeScalarArgConfig,
} from "./runtime-types.js";
import {
  isRecord,
  scalar,
} from "./safe-values.js";

export function zodInputShapeFromJsonSchema(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? new Set(schema.required.map(String)) : new Set<string>();
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, rawProperty] of Object.entries(properties)) {
    const property = isRecord(rawProperty) ? rawProperty : {};
    let valueSchema: z.ZodTypeAny;
    if (Array.isArray(property.enum)) {
      const allowed = property.enum.map((item) => scalar(item));
      valueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
        .refine((value) => allowed.includes(value), "value is not allowlisted");
    } else if (property.type === "number" || property.type === "integer") valueSchema = z.number();
    else if (property.type === "boolean") valueSchema = z.boolean();
    else valueSchema = z.string();
    if (!required.has(name)) valueSchema = valueSchema.optional();
    shape[name] = valueSchema.describe(
      typeof property.description === "string" ? property.description : `${name} argument`,
    );
  }
  return shape;
}

export function zodInputShape(capability: RuntimeCapabilityConfig): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, spec] of Object.entries(capability.args)) {
    let schema: z.ZodTypeAny = spec.type === "object_array"
      ? z.array(
        z.object(
          Object.fromEntries(
            Object.entries(spec.fields).map(([field, fieldSpec]) => [field, zodScalarArg(fieldSpec)]),
          ),
        ).strict(),
      ).min(1).max(spec.max_items)
      : zodScalarArg(spec);
    if (spec.required === false) schema = schema.optional();
    shape[name] = schema.describe(spec.description ?? `${name} business argument`);
  }
  return shape;
}

export function zodScalarArg(spec: RuntimeScalarArgConfig): z.ZodTypeAny {
  let schema: z.ZodTypeAny = spec.type === "number"
    ? z.number()
    : spec.type === "boolean"
      ? z.boolean()
      : z.string();
  if (spec.type === "string" && spec.max_length) schema = (schema as z.ZodString).max(spec.max_length);
  if (spec.type === "number" && spec.minimum !== undefined) {
    schema = (schema as z.ZodNumber).min(spec.minimum);
  }
  if (spec.type === "number" && spec.maximum !== undefined) {
    schema = (schema as z.ZodNumber).max(spec.maximum);
  }
  if (spec.enum && spec.enum.length > 0) {
    schema = schema.refine((value) => spec.enum?.includes(value as Scalar), "value is not allowlisted");
  }
  if (spec.required === false) schema = schema.optional();
  return schema;
}
