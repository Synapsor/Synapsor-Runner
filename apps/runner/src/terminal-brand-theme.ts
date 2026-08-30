import process from "node:process";

export type TerminalBrandPalette = {
  title: string;
  bold: string;
  italic: string;
  dim: string;
  key: string;
  focus: string;
  success: string;
  warning: string;
  danger: string;
  scope: string;
  value: string;
  relationship: string;
  visible: string;
  runnerOnly: string;
  keptOut: string;
};

export function terminalBrandPalette(
  env: NodeJS.ProcessEnv = process.env,
): TerminalBrandPalette | undefined {
  if ("NO_COLOR" in env || (env.TERM ?? "").toLowerCase() === "dumb") return undefined;
  // Standard ANSI roles adapt to the operator's terminal theme. Runner never
  // paints a background, so resize and scrollback remain terminal-owned.
  return {
    title: "1;36",
    bold: "1",
    italic: "3",
    dim: "2",
    key: "1;96",
    focus: "1;96",
    success: "1;32",
    warning: "1;33",
    danger: "1;31",
    scope: "1;35",
    value: "36",
    relationship: "1;34",
    visible: "1;32",
    runnerOnly: "1;33",
    keptOut: "2;37",
  };
}
