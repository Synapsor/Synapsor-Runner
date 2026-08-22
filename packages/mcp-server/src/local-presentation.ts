import crypto from "node:crypto";

const LOCAL_PRESENTATION_TOKEN_META_KEY = "synapsor.local_presentation_token";
const MAX_PENDING_LOCAL_PRESENTATIONS = 32;

export type LocalToolPresentation = {
  value: Record<string, unknown>;
  provider_value: Record<string, unknown>;
  model_withheld_values: boolean;
  operator_metadata_withheld: boolean;
};

export type LocalToolPresentationSink = {
  capture(
    requestMeta: Record<string, unknown> | undefined,
    presentation: LocalToolPresentation,
  ): void;
};

export type PendingLocalToolPresentation = {
  request_meta: Record<string, unknown>;
  take(): LocalToolPresentation | undefined;
  cancel(): void;
};

/**
 * One-time in-process result handoff for trusted local UI clients.
 *
 * Only code holding this object can register a token or read a captured value.
 * Tokens may cross an in-memory MCP request, but raw results never enter the
 * MCP response and no MCP tool or resource can redeem a token.
 */
export class TrustedLocalToolPresentationChannel implements LocalToolPresentationSink {
  readonly #pending = new Map<string, LocalToolPresentation | undefined>();

  begin(): PendingLocalToolPresentation {
    if (this.#pending.size >= MAX_PENDING_LOCAL_PRESENTATIONS) {
      throw new Error("Too many trusted local tool presentations are pending.");
    }
    const token = crypto.randomBytes(32).toString("hex");
    this.#pending.set(token, undefined);
    let finished = false;
    const finish = (): LocalToolPresentation | undefined => {
      if (finished) return undefined;
      finished = true;
      const presentation = this.#pending.get(token);
      this.#pending.delete(token);
      return presentation;
    };
    return {
      request_meta: { [LOCAL_PRESENTATION_TOKEN_META_KEY]: token },
      take: finish,
      cancel: () => {
        finish();
      },
    };
  }

  capture(
    requestMeta: Record<string, unknown> | undefined,
    presentation: LocalToolPresentation,
  ): void {
    const token = requestMeta?.[LOCAL_PRESENTATION_TOKEN_META_KEY];
    if (typeof token !== "string" || !this.#pending.has(token)) return;
    this.#pending.set(token, presentation);
  }

  close(): void {
    this.#pending.clear();
  }
}
