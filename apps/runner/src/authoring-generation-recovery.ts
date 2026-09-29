import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJsonDigest } from "@synapsor-runner/protocol";
import { AskError, authoringTransportObservation, completedProviderContentError, type ProviderHttpInput, type ProviderHttpResult, type AuthoringTransportObservation } from "./model-provider-transport.js";

export type AuthoringTransportOperation = {
  id: string;
  request_digest: `sha256:${string}`;
  context_digest: `sha256:${string}`;
  deadline: string;
  state: "in_flight" | "unsent" | "unknown" | "partial" | "received" | "handled" | "checkpointed" | "refused";
  checkpoint_seen?: true;
  attempts: { id: string; started_at: string; outcome: "in_flight" | "A" | "B" | "C" | "response"; phase?: AuthoringTransportObservation["phase"]; code?: string }[];
};
export type AuthoringTransportState = {
  version: 1;
  policy?: {
    maximum_additional_attempts: 0 | 1 | 2;
    duplicate_generation_charges: boolean;
    provider: string;
    model: string;
    destination_digest: `sha256:${string}`;
    actor: "local_installation_operator";
    reviewed_at: string;
  };
  operations: AuthoringTransportOperation[];
};
export type AuthoringGenerationHost = {
  read(): AuthoringTransportState | undefined;
  write(state: AuthoringTransportState): Promise<void>;
  /** Checks disk Source, authority, consent and the exact acknowledged resume. */
  current(): Promise<`sha256:${string}`>;
  available(): boolean;
  progress?(message: string): void;
};
type Frame = { host?: AuthoringGenerationHost; owned: Set<string>; active: boolean };
const storage = new AsyncLocalStorage<Frame>();
const resultOperations = new WeakMap<ProviderHttpResult, string>();
export function isAuthoringGenerationStop(error: unknown): error is AskError {
  return error instanceof AskError && ["ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "ASK_GENERATION_OUTCOME_UNKNOWN",
    "ASK_GENERATION_NOT_SENT", "ASK_GENERATION_CONTEXT_CHANGED", "ASK_GENERATION_DEADLINE",
    "ASK_GENERATION_RECOVERY_EXHAUSTED", "ASK_GENERATION_ALREADY_ACTIVE", "ASK_GENERATION_HISTORY_LIMIT"].includes(error.code);
}

export function withAuthoringGenerationRecovery<T>(run: () => T, inheritCompletedOperations = false): T {
  const parent = storage.getStore();
  // A public saved Review can be the next consumer of a completed routing plan
  // in this same live call chain. Transfer only those real owned completions;
  // never infer ownership from a stored record after process/session restart.
  const owned = new Set(inheritCompletedOperations && parent && !parent.active
    ? (parent.host?.read()?.operations ?? []).filter(op => parent.owned.has(op.id)
      && ["handled","checkpointed","refused"].includes(op.state)).map(op => op.id) : []);
  return storage.run({owned, active: false}, run);
}
export function configureAuthoringGenerationRecovery(host: AuthoringGenerationHost): void {
  const frame = storage.getStore();
  if (frame) frame.host = host;
}
const exactKeys = (v: object, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k));
const invalid = () => new Error("BOUNDARY_AUTHORING_RESUME_INVALID: Saved transport recovery data is invalid.");
const digest = (v: unknown) => typeof v === "string" && /^sha256:[a-f0-9]{64}$/u.test(v);
const date = (v: unknown) => typeof v === "string" && Number.isFinite(Date.parse(v));
const id = (v: unknown) => typeof v === "string" && /^[a-f0-9-]{36}$/u.test(v);
export function validateAuthoringTransportState(value: unknown): asserts value is AuthoringTransportState {
  const s = value as AuthoringTransportState;
  if (!s || typeof s !== "object" || !exactKeys(s,["version","policy","operations"]) || s.version !== 1 || !Array.isArray(s.operations) || s.operations.length > 4096) throw invalid();
  if (s.policy) {
    const p = s.policy;
    if (!exactKeys(p,["maximum_additional_attempts","duplicate_generation_charges","provider","model","destination_digest","actor","reviewed_at"]) || ![0,1,2].includes(p.maximum_additional_attempts) || typeof p.duplicate_generation_charges !== "boolean"
      || p.actor !== "local_installation_operator" || !date(p.reviewed_at) || !digest(p.destination_digest)
      || !["openai","openrouter","anthropic","openai_compatible"].includes(p.provider)
      || typeof p.model !== "string" || !p.model.length || p.model.length > 128) throw invalid();
  }
  const seen = new Set<string>();
  for (const op of s.operations) {
    if (!op || typeof op !== "object" || !exactKeys(op,["id","request_digest","context_digest","deadline","state","checkpoint_seen","attempts"]) || !id(op.id) || seen.has(op.id) || !digest(op.request_digest) || !digest(op.context_digest) || !date(op.deadline)
      || !["in_flight","unsent","unknown","partial","received","handled","checkpointed","refused"].includes(op.state)
      || op.checkpoint_seen !== undefined && op.checkpoint_seen !== true
      || !Array.isArray(op.attempts) || !op.attempts.length || op.attempts.length > 3) throw invalid();
    seen.add(op.id);
    for (const a of op.attempts) {
      if (!a || typeof a !== "object" || !exactKeys(a,["id","started_at","outcome","phase","code"]) || !id(a.id) || seen.has(a.id) || !date(a.started_at) || !["in_flight","A","B","C","response"].includes(a.outcome)
        || a.phase !== undefined && !["resolution","connection","request","headers","response"].includes(a.phase)
        || a.code !== undefined && !/^(?:E[A-Z0-9_]{1,48}|ERR_[A-Z0-9_]{1,48})$/u.test(a.code)) throw invalid();
      seen.add(a.id);
    }
  }
}

/** Called only by the existing acknowledged business-checkpoint writer. A
 * checkpoint while a callback is running is not itself callback completion. */
export function authoringTransportCheckpoint(state: AuthoringTransportState | undefined): AuthoringTransportState | undefined {
  if (!state) return undefined;
  const copy = structuredClone(state), frame = storage.getStore();
  for (const op of copy.operations) if (frame?.owned.has(op.id)) {
    if (op.state === "received") op.checkpoint_seen = true;
    else if (op.state === "handled") { op.checkpoint_seen = true; op.state = "checkpointed"; }
  }
  return copy;
}
const hostCurrentnessCodes = new Set(["POLICY_SOURCE_CHANGED", "POLICY_REVIEW_CANDIDATE_CHANGED",
  "POLICY_REVIEW_SUBJECT_CHANGED", "BOUNDARY_AUTHORING_RESUME_CHANGED"]);
/** Safe reason minted only while checking/writing the local recovery host.
 * Remains terminal through optional producers; saved Review can explain its
 * known currentness veto without treating it as an unknown write result. */
const hostCurrentnessReasons = new WeakMap<object, string>();
export function authoringGenerationCurrentnessCode(error: unknown): string | undefined {
  return error && typeof error === "object" ? hostCurrentnessReasons.get(error) : undefined;
}
function currentnessFailure(code: string): AskError {
  const error = new AskError("ASK_GENERATION_CONTEXT_CHANGED", `${code}: The saved source or review changed. No stale generation result was accepted; inspect the current saved job before continuing.`, 409);
  hostCurrentnessReasons.set(error, code);
  return error;
}
function hostRecoveryFailure(error: unknown): AskError {
  const code = error instanceof Error ? (error as Error & {code?: unknown}).code : undefined;
  return typeof code === "string" && hostCurrentnessCodes.has(code)
    ? currentnessFailure(code)
    : new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION",
      "The saved generation record could not be acknowledged. Preserve and inspect the exact saved job and attempt history before continuing; no automatic generation or callback replay is permitted.", 409);
}
async function currentRecoveryContext(host: AuthoringGenerationHost): Promise<`sha256:${string}`> {
  try { return await host.current(); } catch (error) { throw hostRecoveryFailure(error); }
}
/** A rejected acknowledgement does not establish whether its write committed.
 * Keep the last durable record and stop the caller before any fallback/reissue. */
async function writeRecoveryState(host: AuthoringGenerationHost, state: AuthoringTransportState): Promise<void> {
  try { await host.write(state); }
  catch (error) { throw hostRecoveryFailure(error); }
}
export async function authoringGenerationHandled(results: readonly ProviderHttpResult[]): Promise<void> {
  const host = storage.getStore()?.host;
  if (!host?.available()) return;
  const wanted = new Set(results.map(r => resultOperations.get(r)).filter(Boolean));
  if (!wanted.size) return;
  const s = structuredClone(host.read() ?? {version: 1 as const, operations: []});
  let changed = false;
  for (const op of s.operations) if (wanted.has(op.id) && op.state === "received") {
    op.state = op.checkpoint_seen ? "checkpointed" : "handled"; changed = true;
  }
  if (changed) await writeRecoveryState(host, s);
}
/** A callback that threw may have saved before losing its acknowledgement.
 * Persist that uncertainty even with retries disabled; never repair it by
 * generating the callback's arguments again. Full semantic refusals before a
 * callback are different: the response was received and safely rejected. */
export async function authoringGenerationFailed(results: readonly ProviderHttpResult[], callbackMayHaveRun: boolean): Promise<void> {
  const host = storage.getStore()?.host;
  if (!host?.available()) return;
  const wanted = new Set(results.map(r => resultOperations.get(r)).filter(Boolean));
  const s = structuredClone(host.read() ?? {version: 1 as const, operations: []});
  let changed = false;
  for (const op of s.operations) if (wanted.has(op.id) && op.state === "received") {
    op.state = callbackMayHaveRun ? "partial" : "refused"; changed = true;
  }
  if (changed) await writeRecoveryState(host, s);
}
function pureLocalGeneration(input: ProviderHttpInput): boolean {
  const b = input.body;
  if (["background","conversation","previous_response_id","webhook","webhooks"].some(k => k in b)) return false;
  if (input.stream?.format === "openai_responses" && b.store !== false) return false;
  if (!Array.isArray(b.tools) && b.tools !== undefined) return false;
  return (b.tools as Record<string, unknown>[] | undefined ?? []).every(t => input.stream?.format === "anthropic"
    ? typeof t.name === "string" && t.input_schema !== undefined && t.type === undefined
    : t.type === "function" && (typeof t.name === "string" || typeof t.function === "object"));
}
function transportStop(observation: AuthoringTransportObservation | undefined, original: unknown): unknown {
  // A fully read content refusal and known local/permanent admission errors keep
  // their existing semantics. Unknown dependency errors must not become a
  // narrator/producer fallback merely because they lack native phase evidence.
  if (completedProviderContentError(original) || isAuthoringGenerationStop(original)) return original;
  if (original instanceof AskError && ["ASK_CANCELLED", "ASK_PROVIDER_REQUEST_INVALID", "ASK_PROVIDER_REDIRECT_REFUSED", "ASK_PROVIDER_DESTINATION_REFUSED",
    "ASK_PROVIDER_REQUEST_TOO_LARGE"].includes(original.code)) return original;
  if (!observation) return new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION",
    "The generation failed without sufficient transport-phase evidence. Saved progress is retained; inspect its recorded attempt and local state before continuing. No automatic generation or callback replay is permitted.", 502);
  return new AskError(observation.classification === "C" ? "ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION"
    : observation.classification === "B" ? "ASK_GENERATION_OUTCOME_UNKNOWN" : "ASK_GENERATION_NOT_SENT",
  observation.classification === "C"
    ? "The provider response was interrupted or incomplete. Saved progress is retained. Inspect the current saved job before continuing; no automatic generation or draft replay is permitted."
    : observation.classification === "B"
      ? "The connection was interrupted before response headers. The provider may have processed and charged for this generation. Saved progress is retained; the permitted recovery is unavailable or exhausted."
      : "The connection failed before an API request could be sent. Saved progress is retained; inspect connection settings and the saved recovery policy.", 502);
}

/** One generation, never a tool/producer/save retry. The HTTP owner alone mints
 * A/B evidence. Missing evidence cannot turn a dependency/guard error into retry. */
export async function recoverAuthoringGeneration(input: ProviderHttpInput,
  request: (input: ProviderHttpInput) => Promise<ProviderHttpResult>): Promise<ProviderHttpResult> {
  const frame = storage.getStore(), host = frame?.host;
  if (!frame || !host) {
    try { return await request(input); }
    catch (e) { throw transportStop(authoringTransportObservation(e), e); }
  }
  if (frame.active) throw new AskError("ASK_GENERATION_ALREADY_ACTIVE", "Another authoring generation is still active.", 409);
  const initial = structuredClone(host.read() ?? {version: 1 as const, operations: []});
  validateAuthoringTransportState(initial);
  if (initial.operations.some(op => ["in_flight", "unsent", "unknown", "partial"].includes(op.state)
    || !frame.owned.has(op.id) && op.state !== "checkpointed" && op.state !== "refused")) {
    throw new AskError("ASK_GENERATION_OUTCOME_REQUIRES_INSPECTION", "The saved job contains an unfinished generation or unacknowledged local result. Inspect/reconcile its exact saved progress; restart cannot reset the attempt allowance.", 409);
  }
  if (!host.available()) {
    try { return await request(input); }
    catch (e) { throw transportStop(authoringTransportObservation(e), e); }
  }
  if (initial.operations.length >= 4096) throw new AskError("ASK_GENERATION_HISTORY_LIMIT", "The saved generation history reached its local record bound. Preserve and inspect it before continuing.", 409);
  const context = await currentRecoveryContext(host);
  const body = structuredClone(input.body), requestDigest = canonicalJsonDigest({body, endpoint: input.endpoint.href, stream: input.stream?.format ?? null});
  const op: AuthoringTransportOperation = {id: randomUUID(), request_digest: requestDigest, context_digest: context,
    deadline: new Date(Date.now() + (input.timeoutMs ?? 30_000)).toISOString(), state: "in_flight", attempts: []};
  const policy = initial.policy;
  const allowed = policy && policy.model === body.model && policy.destination_digest === canonicalJsonDigest(input.endpoint.origin)
    ? policy.maximum_additional_attempts : 0;
  if (frame.active) throw new AskError("ASK_GENERATION_ALREADY_ACTIVE", "Another authoring generation is still active.", 409);
  frame.active = true; frame.owned.add(op.id);
  let priorB = 0;
  try {
    for (let ordinal = 0; ordinal <= allowed; ordinal++) {
      input.signal.throwIfAborted();
      if (await currentRecoveryContext(host) !== context) throw new AskError("ASK_GENERATION_CONTEXT_CHANGED", "The saved source, permissions or parent changed. This generation will not be retargeted.", 409);
      let remaining = Date.parse(op.deadline) - Date.now();
      if (remaining <= 0) throw new AskError("ASK_GENERATION_DEADLINE", "The original generation deadline expired. Saved progress is retained.", 504);
      const attempt = {id: randomUUID(), started_at: new Date().toISOString(), outcome: "in_flight" as AuthoringTransportOperation["attempts"][number]["outcome"]};
      op.attempts.push(attempt); op.state = "in_flight";
      const save = async () => {
        const s = structuredClone(host.read() ?? initial), index = s.operations.findIndex(x => x.id === op.id);
        if (index < 0) s.operations.push(structuredClone(op)); else s.operations[index] = structuredClone(op);
        await writeRecoveryState(host, s);
      };
      await save();
      input.signal.throwIfAborted();
      remaining = Date.parse(op.deadline) - Date.now();
      if (remaining <= 0) throw new AskError("ASK_GENERATION_DEADLINE", "The original generation deadline expired before dispatch. No new request was sent; preserve the saved attempt record.", 504);
      const deadline = AbortSignal.timeout(remaining), signal = AbortSignal.any([input.signal, deadline]);
      let result: ProviderHttpResult;
      try {
        result = await request({...input, body: structuredClone(body), signal, timeoutMs: remaining,
          headers: {...input.headers, "x-client-request-id": attempt.id, "x-synapsor-generation-id": op.id, "x-synapsor-generation-attempt": String(op.attempts.length)}});
        if (signal.aborted) throw new AskError(input.signal.aborted ? "ASK_CANCELLED" : "ASK_GENERATION_DEADLINE",
          "The generation ended after cancellation or its original deadline. Late output was not accepted; inspect the saved attempt.", 499);
      } catch (e) {
        const observation = authoringTransportObservation(e);
        attempt.outcome = completedProviderContentError(e) ? "response" : observation?.classification ?? "C";
        if (observation) Object.assign(attempt, {phase: observation.phase, ...(observation.code ? {code: observation.code} : {})});
        const permanent = e instanceof AskError && ["ASK_PROVIDER_REQUEST_INVALID", "ASK_PROVIDER_REDIRECT_REFUSED", "ASK_PROVIDER_DESTINATION_REFUSED"].includes(e.code);
        op.state = permanent || completedProviderContentError(e) ? "refused" : observation?.classification === "A" ? "unsent" : observation?.classification === "B" ? "unknown" : "partial";
        await save();
        const b = observation?.classification === "B";
        const retry = observation?.transient && observation.cleanup_complete && observation.classification !== "C"
          && !input.signal.aborted && !deadline.aborted && ordinal < allowed
          && (!b || policy?.duplicate_generation_charges === true && priorB === 0 && pureLocalGeneration(input));
        if (!retry) throw transportStop(observation, e);
        if (b) priorB++;
        host.progress?.("Connection interrupted; one permitted generation retry is underway. Provider charges may apply twice; saved Actions are retained.");
        await delay(Math.min(ordinal === 0 ? 2000 : 5000, Math.max(0, Date.parse(op.deadline) - Date.now())), undefined, {signal: input.signal});
        continue;
      }
      op.state = "received"; attempt.outcome = "response";
      await save(); // Failed acknowledgement is C; never return output for use.
      resultOperations.set(result, op.id);
      return result;
    }
    throw new AskError("ASK_GENERATION_RECOVERY_EXHAUSTED", "The finite generation recovery allowance is exhausted.", 502);
  } finally { frame.active = false; }
}
