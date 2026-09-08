import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ownerPolicyParentSchema } from "./owner-policy-language.js";

export const ownerPolicyParentModelResultSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("clarification"), question: z.string().min(1).max(600) }).strict(),
  z.object({ state: z.literal("candidate"), delegation: ownerPolicyParentSchema,
    summary: z.string().min(1).max(1_200) }).strict(),
]);
export type OwnerPolicyParentModelResult = z.infer<typeof ownerPolicyParentModelResultSchema>;

/** Provider schema for an untrusted delegation-only draft. Identity bindings
 * are assembled by the local operator path and are deliberately absent here. */
export function ownerPolicyParentModelJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(ownerPolicyParentModelResultSchema, {
    $refStrategy: "root",
    target: "jsonSchema7",
  }) as Record<string, unknown>;
}
