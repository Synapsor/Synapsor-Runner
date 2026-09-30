import type { TaskContextMeter, TaskContextProfile } from "@synapsor-runner/protocol";

// Acyclic shared definitions for the native adapter and authoring recovery.
// No request, retry, provider configuration or persistence occurs in this leaf.
export class AskError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "AskError";
  }
}

export type ProviderHttpInput = {
  endpoint: URL;
  scope: "official_remote" | "custom_remote" | "custom_loopback";
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal;
  timeoutMs?: number;
  /** Trusted optional numerical observer; never included in provider input. */
  contextMeasurement?: { meter: TaskContextMeter; onProfile: (profile: TaskContextProfile) => void };
  /** Host-only producer origin, never part of the wire body or credentials. */
  authoringInput?: { consumer: "action_rule_components"; operator_message: string; program_resume_revision?: `sha256:${string}` };
  stream?: {
    format: "openai_responses" | "openai_chat" | "anthropic";
    onEvent?: (event: AskProviderStreamEvent) => void;
  };
};

export type ProviderHttpResult = {
  body: Record<string, unknown>;
  status: number;
};

export type AskProviderStreamEvent = {
  phase: "started" | "text_delta" | "tool_started" | "tool_delta" | "completed";
  characters?: number;
  tool?: string;
  text?: string;
  operator_text?: boolean;
};

/** Minted only at the owning HTTP boundary, never inferred from error prose. */
export type AuthoringTransportObservation = {
  classification: "A" | "B" | "C";
  transient: boolean;
  phase: "resolution" | "connection" | "request" | "headers" | "response";
  headers_received: boolean;
  request_finished: boolean;
  cleanup_complete: boolean;
  code?: string;
};
const transportObservations = new WeakMap<object, AuthoringTransportObservation>();
const completedProviderContentErrors = new WeakSet<object>();
export function completedProviderContentError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && completedProviderContentErrors.has(error));
}
/** Internal adapters may mark only an error derived from a fully returned response. */
export function completedContentError(error: AskError): AskError {
  completedProviderContentErrors.add(error); return error;
}
export function authoringTransportObservation(error: unknown): AuthoringTransportObservation | undefined {
  return error && typeof error === "object" ? transportObservations.get(error) : undefined;
}
/** Owning native HTTP adapter only: record observed phase after quarantine. */
export function recordAuthoringTransportObservation(error: object, observation: AuthoringTransportObservation): void {
  transportObservations.set(error, observation);
}
