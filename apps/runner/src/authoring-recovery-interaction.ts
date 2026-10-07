import { canonicalJsonDigest } from "@synapsor-runner/protocol";

type Digest = `sha256:${string}`;
/** Local recovery administration is not business testimony or permission to
 * accept ended output. The host owns every transition. */
export type AuthoringRecoveryView = {
  kind: "select" | "mode" | "details" | "confirm";
  binding: Digest;
  title: string;
  lines: readonly string[];
  details: readonly string[];
  options?: readonly { value: string; label: string; detail?: string }[];
  defaultValue?: false;
};
export type AuthoringRecoveryResponse =
  | { kind: "choice"; binding: Digest; value: string | null }
  | { kind: "details"; binding: Digest }
  | { kind: "decision"; binding: Digest; accepted: boolean | null };
export function assertRecoveryResponse(view: AuthoringRecoveryView,
  response: AuthoringRecoveryResponse): void {
  const expected = view.kind === "details" ? "details" : view.kind === "confirm" ? "decision" : "choice";
  if (response.binding !== view.binding || response.kind !== expected
    || response.kind === "choice" && response.value !== null
      && !view.options?.some(option => option.value === response.value))
    throw new Error("AUTHORING_RECOVERY_CONTEXT_CHANGED: The recovery response does not identify the exact inspected step. No decision was recorded.");
}
export const recoveryViewBinding = (subject: unknown): Digest => canonicalJsonDigest(subject);
