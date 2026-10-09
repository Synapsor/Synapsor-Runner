/** Presentation contract only. Each domain owns its native issuer/projector and
 * decides which details are permitted to display. A matching JSON object or
 * model-supplied code is never a native failure or permission to retry.
 * local_outcome concerns this operation, not all earlier work or Source effects. */
export type NativeAuthoringFailure<Domain extends string, Code extends string, Details = never> = Readonly<{
  domain: Domain;
  code: Code;
  display: string;
  local_outcome: "not_attempted" | "unchanged" | "unknown";
  details?: Details;
}>;
