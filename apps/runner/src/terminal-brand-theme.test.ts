import { describe, expect, it } from "vitest";
import { terminalBrandPalette } from "./terminal-brand-theme.js";

describe("terminal brand theme", () => {
  it("uses semantic foreground roles without painting the terminal background", () => {
    const env = { TERM: "xterm-256color", COLORTERM: "truecolor" };
    const palette = terminalBrandPalette(env);
    expect(palette).toMatchObject({
      title: "1;36",
      key: "1;96",
      warning: "1;33",
      danger: "1;31",
    });
    expect(Object.values(palette ?? {})).not.toContainEqual(expect.stringMatching(/(?:^|;)4[0-9](?:;|$)/u));
  });

  it("lets the terminal palette adapt foreground roles to its own theme", () => {
    expect(terminalBrandPalette({ TERM: "xterm-256color" })).toEqual(
      terminalBrandPalette({ TERM: "xterm-direct", COLORTERM: "truecolor" }),
    );
  });

  it("honors NO_COLOR and dumb terminals", () => {
    expect(terminalBrandPalette({ TERM: "xterm-256color", NO_COLOR: "1" })).toBeUndefined();
    expect(terminalBrandPalette({ TERM: "dumb" })).toBeUndefined();
  });
});
