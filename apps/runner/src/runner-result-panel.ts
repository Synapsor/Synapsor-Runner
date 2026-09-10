import { renderReviewFacts } from "./review-facts.js";

/** Operator checkpoints only. Status and checked facts come from Runner results,
 * while any model-authored explanation stays explicitly separate. */
export type RunnerResultPanel = {
  result: string;
  checked?: string;
  interpretation?: string;
  changed?: string;
  decision?: string;
  notChecked?: string;
  next?: string;
};

export function renderRunnerResultPanel(result: RunnerResultPanel, width: number): string[] {
  const rows: Array<[string, string | undefined]> = [
    ["Result", result.result],
    ["Runner confirmed", result.checked],
    ["Model interpretation", result.interpretation],
    ["What changes now", result.changed],
    ["Decision needed", result.decision],
    ["Not checked", result.notChecked],
    ["Next step", result.next],
  ];
  return renderReviewFacts(rows.filter((row): row is [string, string] => Boolean(row[1]?.trim())), width);
}
