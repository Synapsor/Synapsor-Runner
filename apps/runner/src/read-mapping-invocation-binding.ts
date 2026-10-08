import { canonicalJsonDigest as d } from "@synapsor-runner/protocol";
import { READ_SCOPE_PROTOCOL } from "./read-structured-scope.js";

export const READ_MAPPING_INVOCATION_VERSION = "synapsor.read-mapping-invocation.v1" as const;
export type ReadMappingInvocationBinding = { version: typeof READ_MAPPING_INVOCATION_VERSION; digest: `sha256:${string}` };
/** Prospective immutable invocation identity. The complete original producer
 * hash still owns ordinary Resume/Replace. Only a separately proved, committed
 * native revision may change its technical candidate/catalog/tool projection. */
export function readMappingInvocationBinding(input: { name: string; allowedQuestions: readonly string[]; forbiddenQuestions: readonly string[];
  originalNamingSources: readonly string[]; principal_roots: readonly string[] | null; provider: string; model: string; endpoint: string;
  defer_narration: boolean; relationship_review_limit: number }): ReadMappingInvocationBinding {
  return { version: READ_MAPPING_INVOCATION_VERSION, digest: d({ domain: READ_MAPPING_INVOCATION_VERSION, protocol: READ_SCOPE_PROTOCOL, ...input }) };
}
