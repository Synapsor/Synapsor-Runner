import path from "node:path";
import type { ControlPolicyScope } from "@synapsor-runner/proposal-store";
import { createTerminalAnalyticsShellIo } from "./analytics-shell.js";
import { safeTerminalText } from "./analytics-shell-render.js";
import { assertKnownOptions, optionalArg } from "./cli-options.js";
import { readRuntimeConfig, runnerConfigPath } from "./cli-project.js";
import { createProjectRuntimeStore } from "./control-policy-store.js";
import { createOptionalOwnerPolicyRuntime } from "./owner-policy-runtime.js";
import type { OwnerPolicyReviewIo } from "./owner-policy-review-ui.js";
import { terminalContentWidth, wrapStyledTerminalLine } from "./terminal-layout.js";
import { tryAsk } from "./try-ask.js";

type ScopePage = Awaited<ReturnType<NonNullable<Awaited<ReturnType<typeof createOptionalOwnerPolicyRuntime>>>["scopes"]>>;

/** Select one authorized settings context locally, then start a fresh model
 * session. Other owners' policies and prior chat history are not disclosed. */
export async function ownerPolicyChat(args: string[], dependencies: {
  env?: NodeJS.ProcessEnv; io?: OwnerPolicyReviewIo; runChat?: typeof tryAsk;
} = {}): Promise<number> {
  assertKnownOptions(args, new Set(["--config", "--project-root", "--store", "--provider", "--model", "--base-url", "--api-key-env",
    "--consent", "--timeout", "--session-token-budget", "--max-output-tokens", "--verbose"]), "policy chat");
  const env = dependencies.env ?? process.env, configPath = runnerConfigPath(args);
  const config = await readRuntimeConfig(configPath, { env, storePath: optionalArg(args, "--store") });
  const root = path.resolve(optionalArg(args, "--project-root") ?? config.action_rules?.project_root ?? path.dirname(path.resolve(configPath)));
  const storePath = path.resolve(optionalArg(args, "--store") ?? path.resolve(root, config.storage?.sqlite_path ?? ".synapsor/local.db"));
  if (!config.action_rules?.owner_management) throw new Error("Owner-rule chat is not enabled. Review owner delegation and its identity configuration first. Ordinary Boundary setup remains available through start --cli.");
  const store = await createProjectRuntimeStore({ projectRoot: root, config, storePath, env });
  let selected: ControlPolicyScope | undefined;
  const terminal = dependencies.io ? undefined : createTerminalAnalyticsShellIo({ slashCommands: false });
  const io = dependencies.io ?? terminal!;
  try {
    const runtime = await createOptionalOwnerPolicyRuntime({ projectRoot: root, config, store, env });
    if (!runtime) throw new Error("Owner-rule editing is not enabled for this project.");
    selected = await chooseOwnerScope(io, (request) => runtime.scopes(request));
  } finally { terminal?.close(); await store.close(); }
  if (!selected) return 0;
  const selectedArgs = [...args,
    ...(!optionalArg(args, "--config") ? ["--config", configPath] : []),
    ...(!optionalArg(args, "--project-root") ? ["--project-root", root] : []),
    ...(!optionalArg(args, "--store") ? ["--store", storePath] : []),
    ...(!optionalArg(args, "--provider") ? ["--provider", "openai"] : [])];
  return (dependencies.runChat ?? tryAsk)(selectedArgs, { env, ownerPolicyScope: selected });
}

export async function chooseOwnerScope(io: OwnerPolicyReviewIo,
  list: (request: { query?: string; limit?: number; after?: string }) => Promise<ScopePage>): Promise<ControlPolicyScope | undefined> {
  let query = "", after: string | undefined;
  const write = (text: string) => io.write(wrapStyledTerminalLine(safeTerminalText(text), terminalContentWidth(io.columns())).join("\n") + "\n");
  while (true) {
    let page: ScopePage;
    try { page = await list({ query, limit: 10, ...(after ? { after } : {}) }); }
    catch (error) {
      const code = (error as { code?: unknown })?.code;
      if (!after || (code !== "POLICY_PAGE_EPOCH_STALE" && code !== "POLICY_SCOPE_CURSOR_INVALID")) throw error;
      write("The owner list changed or expired. Showing your current authorized owners again.");
      after = undefined;
      continue;
    }
    let selected: ScopePage["scopes"][number] | undefined;
    if (!query && !after && page.total === 1) selected = page.scopes[0];
    else {
      const options = [...page.scopes.map((entry, index) => ({ value: `scope:${index}`, label: safeTerminalText(entry.label),
        detail: `${entry.agent_count} agent(s) | ${entry.permissions.includes("draft") ? "inspect and draft changes" : "inspect only"}` })),
        ...(page.next ? [{ value: "next", label: "More owners" }] : []),
        { value: "search", label: "Search owners" }, { value: "cancel", label: "Back" }];
      if (!page.scopes.length) write(query ? "No authorized owners match this search." : "This sign-in has no configured owner scopes to inspect.");
      let answer: string | undefined;
      if (io.choose) answer = await io.choose({ title: "AGENT RULES", message: "Choose whose settings to inspect. Only your authorized scopes are listed.",
        initialValue: options[0]!.value, options });
      else {
        options.forEach((entry, index) => write(`${index + 1}. ${entry.label}`));
        const raw = await io.read("Choose a number, or press Enter to go back: ");
        answer = raw && /^\d+$/u.test(raw) ? options[Number(raw) - 1]?.value : undefined;
      }
      if (!answer || answer === "cancel") return undefined;
      if (answer === "search") {
        const value = await io.read("Find an owner or account: ");
        if (value === undefined) return undefined;
        if (value.length > 256) { write("Search is too long; use at most 256 characters."); after = undefined; continue; }
        query = value.trim(); after = undefined; continue;
      }
      if (answer === "next" && page.next) { after = page.next; continue; }
      if (/^scope:\d+$/u.test(answer)) selected = page.scopes[Number(answer.slice(6))];
    }
    if (!selected) return undefined;
    write(`Agent rules: ${selected.label}. ${selected.permissions.includes("draft") ? "Changes remain drafts until human review." : "This sign-in can inspect, not edit."}`);
    write("This chat covers only these settings; it grants no access to the owner's source records.");
    return structuredClone(selected.scope);
  }
}
