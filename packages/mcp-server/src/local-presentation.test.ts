import { describe, expect, it } from "vitest";
import { TrustedLocalToolPresentationChannel } from "./local-presentation.js";

describe("trusted local tool presentation channel", () => {
  it("captures only a registered one-time request and never exposes a retrieval API", () => {
    const channel = new TrustedLocalToolPresentationChannel();
    const pending = channel.begin();
    const presentation = {
      value: { secret: "local-only-value" },
      provider_value: { secret: "[withheld:abcdef123456:1]" },
      model_withheld_values: true,
      operator_metadata_withheld: false,
    };

    channel.capture({ "synapsor.local_presentation_token": "invented" }, presentation);
    channel.capture(pending.request_meta, presentation);

    expect(pending.take()).toEqual(presentation);
    expect(pending.take()).toBeUndefined();
    pending.cancel();
    channel.close();
  });
});
