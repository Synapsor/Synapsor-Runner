import crypto from "node:crypto";
import { canonicalJsonStringify } from "./canonical-json.js";

/** Numerical observations only. This meter neither stores payloads nor manages context. */
export type TaskContextProfile = {
  version: "task-context-profile.v1";
  boundary: "provider_request" | "provider_completed_response" | "mcp_request" | "mcp_result";
  encoded_utf8_bytes: number;
  static_instruction_bytes: number;
  schema_bytes: number;
  conversation_bytes: number;
  framing_and_other_bytes: number;
  new_conversation_bytes: number | null;
  repeated_conversation_bytes: number | null;
  repetition_tracking: "exact_encoded_units" | "capacity_exhausted" | "not_applicable";
  mcp_text_rendering_bytes: number;
  mcp_structured_rendering_bytes: number;
  equivalent_text_and_structured: boolean | null;
  cumulative_provider_request_bytes: number;
  peak_provider_request_bytes: number;
  cumulative_completed_response_bytes: number;
  provider_request_observations: number;
  /** An observed prepared body does not establish upstream transmission. */
  actual_provider_sends: null;
  mcp_tool_calls: number;
  /** No bytes-to-token conversion or inference of cache behavior. */
  token_estimate: null;
  reported_usage: TaskContextReportedUsage | null;
  elapsed_ms: number | null;
};

export type TaskContextReportedUsage = Partial<Record<
  "input_tokens" | "output_tokens" | "cache_read_input_tokens" | "cache_creation_input_tokens" | "reasoning_tokens" | "cost_usd",
  number
>>;
export type TaskContextObservation = {
  boundary: TaskContextProfile["boundary"];
  encoded: string | Uint8Array;
  reportedUsage?: TaskContextReportedUsage;
  elapsedMs?: number;
};
export type TaskContextMeter = { observe(input: TaskContextObservation): TaskContextProfile };

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
const digest = (value: unknown): string => crypto.createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex");

/** Normalized explicitly supplied API usage, not a local token/cost estimate. */
export function taskContextReportedUsage(body: Record<string, unknown>): TaskContextReportedUsage | undefined {
  const usage = record(body.usage);
  if (!usage) return undefined;
  return safeUsage({
    input_tokens: usage.input_tokens ?? usage.prompt_tokens,
    output_tokens: usage.output_tokens ?? usage.completion_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens ?? record(usage.input_tokens_details)?.cached_tokens ?? record(usage.prompt_tokens_details)?.cached_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    reasoning_tokens: record(usage.output_tokens_details)?.reasoning_tokens ?? record(usage.completion_tokens_details)?.reasoning_tokens ?? record(usage.output_tokens_details)?.thinking_tokens,
    cost_usd: usage.cost,
  } as TaskContextReportedUsage) ?? undefined;
}

function safeUsage(value: TaskContextReportedUsage | undefined): TaskContextReportedUsage | null {
  if (!value) return null;
  const output: TaskContextReportedUsage = {};
  for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "reasoning_tokens", "cost_usd"] as const) {
    const number = value[key];
    if (typeof number === "number" && Number.isFinite(number) && number >= 0) output[key] = number;
  }
  return Object.keys(output).length ? output : null;
}

/**
 * One bounded meter per task/journey. Pass the actual final JSON encoding,
 * including any adapter transformation. No raw strings or digests are returned.
 * Repetition means byte-identical encoded message units, not semantic redundancy.
 * Completed response bytes exclude SSE transport framing; measure that separately.
 */
export function createTaskContextMeter(maximumTrackedUnits = 4096): TaskContextMeter {
  if (!Number.isSafeInteger(maximumTrackedUnits) || maximumTrackedUnits < 1 || maximumTrackedUnits > 16384) {
    throw new RangeError("context measurement retains between 1 and 16384 unit digests");
  }
  const seen = new Set<string>();
  let trackingExhausted = false, cumulativeInput = 0, peakInput = 0, cumulativeOutput = 0, sends = 0, calls = 0;
  return {
    observe(input) {
      const encoded = typeof input.encoded === "string" ? Buffer.from(input.encoded, "utf8") : Buffer.from(input.encoded);
      const body = record(JSON.parse(encoded.toString("utf8")));
      if (!body) throw new TypeError("context measurement expects an encoded JSON object");
      let instructions = 0, schemas = 0, conversation = 0, newlySeen = 0, repeated = 0;
      let textRendering = 0, structuredRendering = 0;
      let equivalent: boolean | null = null;
      if (input.boundary === "provider_request") {
        sends += 1; cumulativeInput += encoded.length; peakInput = Math.max(peakInput, encoded.length);
        for (const key of ["system", "instructions"]) if (body[key] !== undefined) instructions += bytes(body[key]);
        if (body.tools !== undefined) schemas = bytes(body.tools);
        for (const key of ["messages", "input"]) {
          if (body[key] === undefined) continue;
          const value = body[key];
          const units = Array.isArray(value) ? value : [value];
          let instructionUnits = 0;
          for (const unit of units) {
            const role = record(unit)?.role;
            if (role === "system" || role === "developer") { instructionUnits += bytes(unit); continue; }
            const size = bytes(unit), hash = digest(unit);
            if (seen.has(hash)) repeated += size;
            else if (seen.size < maximumTrackedUnits) { newlySeen += size; seen.add(hash); }
            else trackingExhausted = true;
          }
          instructions += instructionUnits;
          // Array delimiters belong to the conversation rendering; each unit
          // retains its exact role/type, escaping and nested tool-result form.
          conversation += bytes(value) - instructionUnits;
        }
      } else if (input.boundary === "provider_completed_response") cumulativeOutput += encoded.length;
      else if (input.boundary === "mcp_request" && body.method === "tools/call") calls += 1;
      else if (input.boundary === "mcp_result") {
        const result = record(body.result) ?? body;
        if (result.structuredContent !== undefined) structuredRendering = bytes(result.structuredContent);
        const content = Array.isArray(result.content) ? result.content : [];
        for (const block of content) {
          const item = record(block);
          if (item?.type !== "text" || typeof item.text !== "string") continue;
          textRendering += bytes(item.text);
          if (result.structuredContent !== undefined) {
            try {
              const same = canonicalJsonStringify(JSON.parse(item.text)) === canonicalJsonStringify(result.structuredContent);
              equivalent = equivalent === true || same;
            } catch { equivalent ??= false; }
          }
        }
      }
      const profile: TaskContextProfile = {
        version: "task-context-profile.v1", boundary: input.boundary, encoded_utf8_bytes: encoded.length,
        static_instruction_bytes: instructions, schema_bytes: schemas, conversation_bytes: conversation,
        framing_and_other_bytes: encoded.length - instructions - schemas - conversation,
        new_conversation_bytes: input.boundary === "provider_request" && !trackingExhausted ? newlySeen : null,
        repeated_conversation_bytes: input.boundary === "provider_request" && !trackingExhausted ? repeated : null,
        repetition_tracking: input.boundary !== "provider_request" ? "not_applicable" : trackingExhausted ? "capacity_exhausted" : "exact_encoded_units",
        mcp_text_rendering_bytes: textRendering, mcp_structured_rendering_bytes: structuredRendering,
        equivalent_text_and_structured: equivalent,
        cumulative_provider_request_bytes: cumulativeInput, peak_provider_request_bytes: peakInput,
        cumulative_completed_response_bytes: cumulativeOutput, provider_request_observations: sends, actual_provider_sends: null, mcp_tool_calls: calls,
        token_estimate: null, reported_usage: safeUsage(input.reportedUsage),
        elapsed_ms: typeof input.elapsedMs === "number" && Number.isFinite(input.elapsedMs) && input.elapsedMs >= 0 ? input.elapsedMs : null,
      };
      return profile;
    },
  };
}
