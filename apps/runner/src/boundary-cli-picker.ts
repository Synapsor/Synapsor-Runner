import type { ReadStream, WriteStream } from "node:tty";
import {
  reviewedBoundaryFieldTier,
  type BoundaryResourceReviewSummary,
  type BoundaryResourceReviewView,
  type ReviewedBoundaryFieldTier,
} from "./boundary-review-mutation.js";
import {
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
  type DerivedScopePath,
} from "./auto-boundary.js";
import {
  readTerminalActivationConfirmation,
  readTerminalBooleanConfirmation,
  readTerminalTextWithEscape,
  withAlternateTerminalScreen,
  withRawTerminalScreen,
  type TerminalKeypress,
} from "./terminal-prompt.js";
import {
  terminalContentWidth,
  wrapStyledTerminalLine,
} from "./terminal-layout.js";
import {
  formatDerivedScopeJoinColumns,
  formatDerivedScopePath,
  formatRelationshipJoinColumns,
  formatRelationshipPath,
} from "./derived-scope-display.js";
import { blockedTenantScopeGuidance } from "./boundary-scope-guidance.js";
import { shellQuote } from "./cli-format.js";
import {
  boundaryMapOperationLegend,
  renderBoundaryMapFieldMatrix,
  renderBoundaryMapTable,
  type BoundaryMapFieldRow,
} from "./boundary-map-presentation.js";
import { exploreVocabularyCoverage } from "./explore-vocabulary.js";
import { terminalBrandPalette } from "./terminal-brand-theme.js";
import type { ReadWorkloadPlanCard } from "./read-workload-assist.js";
import { READ_SELECTION_GUIDANCE } from "./read-workload-selection-guidance.js";

export type BoundaryFieldTier = ReviewedBoundaryFieldTier;
export type BoundaryFieldTierEditResult =
  | Record<string, BoundaryFieldTier>
  | {
      action: "enum";
      field: string;
      tiers: Record<string, BoundaryFieldTier>;
    }
  | {
      action: "principal";
      tiers: Record<string, BoundaryFieldTier>;
    }
  | {
      action: "metadata";
      field: string;
      tiers: Record<string, BoundaryFieldTier>;
    }
  | {
      action: "restore_operations";
      field: string;
      tiers: Record<string, BoundaryFieldTier>;
    }
  | {
      action: "exact_numeric_grouping";
      field: string;
      enabled: boolean;
      tiers: Record<string, BoundaryFieldTier>;
    }
  | `enum:${string}`
  | "back"
  | "privacy"
  | undefined;

export type BoundaryFieldEnumEditResult = string[] | "back" | undefined;

export type BoundaryRelationshipPathEditResult =
  | {
      action: "add" | "remove";
      relationship_id: string;
    }
  | "back"
  | undefined;

async function withRawKeys<T>(
  input: ReadStream,
  output: WriteStream,
  operation: (
    nextKey: () => Promise<TerminalKeypress>,
    render: (lines: string[]) => void,
  ) => Promise<T>,
): Promise<T> {
  return withAlternateTerminalScreen(
    output,
    () => withRawTerminalScreen(input, output, operation),
  );
}

export type BoundaryBlockedResolution =
  | ({ row_identity: string } & (
      | { tenant_key: string; tenant_scope_path?: never }
      | { tenant_key?: never; tenant_scope_path: string }
      | {
        tenant_key?: never;
        tenant_scope_path?: never;
        shared_reference_scope: typeof SHARED_REFERENCE_ACKNOWLEDGEMENT;
      }
      | {
        tenant_key?: never;
        tenant_scope_path?: never;
        shared_reference_scope?: never;
        organization_scope: "single_organization";
      }
    ))
  | "back"
  | undefined;

export type BoundaryResourceSelection =
  | {
      resource_id: string;
      action: "add" | "review" | "remove" | "signoff" | "privacy" | "analytics" | "metadata"
        | "relationships";
    }
  | {
      action: "create" | "rename" | "confirm" | "limits" | "privacy_all" | "workloads";
    }
  | {
      action: "actions";
      boundary_name: string;
    }
  | {
      action: "model_output";
      exact_metadata_confirmed?: true;
    }
  | {
      action: "intent_check";
      boundary_name: string;
    }
  | {
      action: "switch" | "delete" | "disable";
      boundary_name: string;
    };

export type BoundaryReviewOverview = {
  discovery_concerns?: Array<{ resource: string; entry_bytes: number; response_bytes: number }>;
  confirmed_decisions: number;
  outstanding_decisions: number;
  outstanding_resource_decisions: number;
  outstanding_boundary_decisions: number;
  resources_requiring_signoff: number;
  model_authority_metadata_mode?: "semantic" | "exact";
  action_boundary?: {
    name?: string;
    state: "off" | "disabled" | "active" | "active_with_disabled_changes";
    active_action_count: number;
    draft_action_count: number;
  };
  boundaries?: Array<{
    name: string;
    selected: boolean;
    active: boolean;
    matches_active_digest: boolean;
    table_count: number;
    outstanding_decisions: number;
    policy_review_required?: boolean;
    ask_intent_check_mode?: "balanced" | "boundary_only";
    proposal_action_state?: "none" | "draft" | "rehearsed" | "active";
    proposal_action_active_count?: number;
    proposal_action_draft_count?: number;
    verified_action_boundary_name?: string;
    verified_action_state?: "disabled" | "active" | "active_with_disabled_changes" | "blocked";
    verified_action_active_count?: number;
    verified_action_draft_count?: number;
    verified_action_error?: string;
  }>;
};

export type BoundaryAccessNotice = {
  tone: "danger" | "warning" | "success";
  title: string;
  lines: string[];
  footer?: string;
};

type BoundaryPromptOptions = {
  /** Trusted typed authoring adapters bypass prose decision classification. */
  decisionKind?: "business_review" | "disclosure" | "activation" | "recovery";
  /** Local typed controls/details must never request a model explanation. */
  localOnly?: boolean;
  context?: string[];
  exactDetails?: { title: string; lines: string[]; summaryTitle?: string; sections?: import("./read-boundary-review-types.js").ReviewSection[] };
  /** Display only; exact prompts, permissions and defaults remain with the caller. */
  activationView?: import("./authoring-activation-view.js").AuthoringActivationView;
};

export type BoundaryPromptChoice = {
  value: string;
  label: string;
  detail?: string;
  disabled?: boolean;
};

type BoundaryChoicePromptOptions = BoundaryPromptOptions & {
  /** Reviewed structural evidence for answers, not additional default screen text. */
  explanationContext?: string[];
  /** A draft task, not an activation permission; retain questions and exact details. */
  reviewOnly?: boolean;
  /** The concise deterministic decision is already presented. Narrate only on request. */
  explainOnRequest?: boolean;
  /** Route an operator question back to a draft model; never an activation decision. */
  onModelQuestion?: (question: string) => Promise<"revise">;
  /** Keep a prerequisite/blocker visible in the choice, not only in /details. */
  displayContext?: boolean;
  initialValue?: string;
  requireExplicitSelection?: boolean;
};

export type BoundaryReviewInteractiveSession = {
  /** Conversation surfaces retain scrollback and render prompt context themselves. */
  presentationMode?: "screen" | "conversation";
  /** Live terminal width for responsive review artifacts. */
  terminalColumns?: number;
  present?(
    title: string,
    lines: string[],
    tone?: "normal" | "success" | "warning" | "danger",
  ): void;
  /** Retain exact deterministic context for an operator-requested details view. */
  rememberDetails?(title: string, lines: string[]): void;
  /** Render the retained details without duplicating them as a new Runner turn. */
  showRememberedDetails?(): void;
  showReviewDetails?(title: string, lines: string[]): Promise<void>;
  showReviewSections?(title: string, sections: import("./read-boundary-review-types.js").ReviewSection[]): Promise<void>;
  chooseResource(
    resources: BoundaryResourceReviewSummary[],
    overview?: BoundaryReviewOverview,
    options?: {
      initialView?: "boundaries" | "access";
      startingBoundaryName?: string;
      startAtBoundaryList?: boolean;
      initialResourceId?: string;
      notice?: BoundaryAccessNotice;
    },
  ): Promise<BoundaryResourceSelection | undefined>;
  editFieldTiers(
    view: BoundaryResourceReviewView,
    options?: {
      focusedAccess?: boolean;
      initialTiers?: Record<string, BoundaryFieldTier>;
    },
  ): Promise<BoundaryFieldTierEditResult>;
  editFieldEnumValues?(
    view: BoundaryResourceReviewView,
    field: string,
  ): Promise<BoundaryFieldEnumEditResult>;
  editRelationshipPaths?(
    view: BoundaryResourceReviewView,
    summary: BoundaryResourceReviewSummary,
  ): Promise<BoundaryRelationshipPathEditResult>;
  resolveBlockedResource?(
    view: BoundaryResourceReviewView,
  ): Promise<BoundaryBlockedResolution>;
  selectReadWorkloadCards?(
    cards: ReadWorkloadPlanCard[],
    options?: {
      initialSelectedIds?: string[];
      recommendationLabel?: string;
    },
  ): Promise<string[] | undefined>;
  chooseOption?(
    title: string,
    choices: BoundaryPromptChoice[],
    options?: BoundaryChoicePromptOptions,
  ): Promise<string | undefined>;
  // Structured local record fields can opt out of general policy clarification history.
  promptText(prompt: string, options?: BoundaryPromptOptions & { defaultValue?: string; recordPolicyAnswer?: boolean; preserveWhitespace?: boolean }): Promise<string | undefined>;
  confirm(
    prompt: string,
    options?: BoundaryPromptOptions & { defaultValue?: boolean },
  ): Promise<boolean | undefined>;
  confirmActivation?(
    prompt: string,
    options?: BoundaryPromptOptions,
  ): Promise<boolean | undefined>;
  confirmReviewedDisabled?(
    prompt: string,
    options?: BoundaryPromptOptions,
  ): Promise<boolean | undefined>;
};

type Keypress = {
  name?: string;
  ctrl?: boolean;
  sequence?: string;
};

type ResourcePickerView = "boundary" | "related" | "all";

type BoundaryRelationshipConnection = {
  kind: "relationship" | "derived_tenant_scope" | "derived_principal_scope";
  source_resource: string;
  target_resource: string;
  relationship_id: string;
  path_depth: number;
  path_links?: BoundaryResourceReviewSummary["relationships"][number]["path_links"];
  derived_scope?: DerivedScopePath;
};

const tierOrder: BoundaryFieldTier[] = ["visible", "withheld_from_model", "kept_out"];

function safeActionAccessLabel(
  state: "none" | "draft" | "rehearsed" | "active" | undefined,
  available: boolean,
  activeCount = 0,
): string {
  if (!available) return "Safe actions - prepare proposal [FINISH READ REVIEW]";
  if (state === "rehearsed") {
    return activeCount > 0
      ? `Safe actions - ${activeCount} active + rehearsed change [READY FOR REVIEW]`
      : "Safe actions - proposal rehearsed [READY FOR REVIEW]";
  }
  if (state === "draft") {
    return activeCount > 0
      ? `Safe actions - ${activeCount} active + disabled change [DRAFT]`
      : "Safe actions - continue proposal setup [DISABLED]";
  }
  if (state === "active") {
    return `Safe actions - ${activeCount} active proposal ${plural(activeCount, "action", "actions")} [ACTIVE]`;
  }
  return "Safe actions - prepare proposal [AVAILABLE]";
}

type TerminalTheme = ReturnType<typeof terminalTheme>;

function linkedActionBoundaryLines(
  overview: BoundaryReviewOverview | undefined,
  boundary: NonNullable<BoundaryReviewOverview["boundaries"]>[number],
  theme: TerminalTheme,
  rowLayout: SavedBoundaryRowLayout,
): string[] {
  const activeCount = boundary.proposal_action_active_count ?? 0;
  const draftCount = boundary.proposal_action_draft_count ?? 0;
  const verifiedActiveCount = boundary.verified_action_active_count ?? 0;
  const verifiedDraftCount = boundary.verified_action_draft_count ?? 0;
  const verifiedCount = verifiedActiveCount + verifiedDraftCount;
  const hasVerified = verifiedCount > 0;
  const hasDiscretionary = activeCount + draftCount > 0;
  const global = overview?.action_boundary;
  const state = global?.state ?? (activeCount ? "active" : draftCount ? "disabled" : "off");
  const stateLabel = state === "active_with_disabled_changes"
    ? "ACTIVE + DISABLED CHANGES"
    : state === "active"
      ? "ACTIVE"
      : state === "disabled"
        ? "DISABLED DRAFT"
        : "OFF";
  const name = global?.name ?? "default_action_boundary";
  const actionCount = activeCount + draftCount;
  const access = activeCount > 0
    ? draftCount > 0
      ? "ACTIVE + CHANGES"
      : "ACTIVE"
    : "NOT ACTIVE";
  const row = savedBoundaryRow(
    hasVerified ? "" : "Y",
    name,
    "ACTION",
    stateLabel,
    `${actionCount} ${plural(actionCount, "action", "actions")}`,
    access,
    rowLayout,
  );
  const styledRow = state === "active"
    ? theme.success(row)
    : state === "off"
      ? theme.dim(row)
      : theme.warning(row);
  const lines: string[] = [];
  if (hasVerified) {
    const verifiedState = boundary.verified_action_state
      ?? (verifiedActiveCount ? "active" : "disabled");
    const verifiedStatus = verifiedState === "active_with_disabled_changes"
      ? "ACTIVE + DISABLED CHANGES"
      : verifiedState === "active"
        ? "ACTIVE"
        : verifiedState === "blocked"
          ? "BLOCKED - REVIEW"
          : "DISABLED DRAFT";
    const verifiedAccess = verifiedActiveCount > 0
      ? verifiedDraftCount > 0 ? "ACTIVE + CHANGES" : "ACTIVE"
      : "NOT ACTIVE";
    const verifiedRow = savedBoundaryRow(
      "Y",
      boundary.verified_action_boundary_name ?? `${boundary.name}_actions`,
      "ACTION",
      verifiedStatus,
      `${verifiedCount} verified ${plural(verifiedCount, "outcome", "outcomes")}`,
      verifiedAccess,
      rowLayout,
    );
    lines.push(
      verifiedState === "active"
        ? theme.success(verifiedRow)
        : verifiedState === "blocked"
          ? theme.danger(verifiedRow)
          : theme.warning(verifiedRow),
      theme.dim("  Agent nominates an outcome; Runner privately verifies facts and derives the exact bounded effect."),
      ...(boundary.verified_action_error
        ? [theme.danger(`  Blocked: ${safeTerminalText(boundary.verified_action_error)}`)]
        : []),
    );
  }
  if (hasDiscretionary || !hasVerified) {
    lines.push(styledRow);
  }
  lines.push(theme.dim(`  Linked Read Boundary: ${safeTerminalText(boundary.name)}`));
  if (hasVerified && hasDiscretionary) {
    lines.push("  Y opens verified outcomes or caller-supplied proposal actions. Approval and apply remain separate.");
  } else if (hasVerified) {
    lines.push(verifiedActiveCount > 0
      ? "  Y reviews this verified outcome authority. Approval and apply remain outside the agent."
      : theme.warning("  Next: Y reviews this disabled verified outcome; W can revise it with a model."));
  } else if (activeCount > 0) {
    lines.push("  Y reviews active proposal authority or any disabled replacement. Approval and apply remain outside the agent.");
  } else if (draftCount > 0) {
    lines.push(theme.warning(
      `  Next: Y reviews ${draftCount} disabled Action ${plural(draftCount, "draft", "drafts")}; `
      + "W opens model chat to create or edit Read + Action authority.",
    ));
  } else {
    lines.push("  Y drafts business changes with a model or the manual rule editor. Activation requires separate review.");
  }
  return lines;
}

function databaseCompatibilityLine(
  compatibility: BoundaryResourceReviewView["database_server_compatibility"],
  theme: TerminalTheme,
): string | undefined {
  if (!compatibility) return undefined;
  const product = compatibility.engine === "postgres" ? "PostgreSQL" : "MySQL";
  const detectedVersion = safeTerminalText(compatibility.detected_version);
  const version = detectedVersion.toLowerCase().startsWith(product.toLowerCase())
    ? detectedVersion
    : `${product} ${detectedVersion}`;
  const releaseLine = compatibility.authority?.version_line
    ? `; reviewed release line ${safeTerminalText(compatibility.authority.version_line)}`
    : "";
  if (compatibility.tier === "full") {
    return theme.success(`Reviewed database grammar: ${version} uses the full grammar${releaseLine}.`);
  }
  if (compatibility.tier === "compatible_limited") {
    const limitations = [
      ...(compatibility.authority?.features.schema_check_constraints === false
        ? ["Text grouping/filtering requires a bounded native ENUM."]
        : []),
      ...(compatibility.authority?.features.automatic_numeric_bands === false
        ? ["Automatic numeric bands are unavailable."]
        : []),
    ];
    return theme.warning(
      `Reviewed database grammar: ${version} uses the supported limited tier${releaseLine}. `
      + limitations.join(" "),
    );
  }
  return theme.danger(`Reviewed database grammar: ${version} is outside the supported release lines.`);
}

export function createBoundaryReviewInteractiveSession(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stderr,
): BoundaryReviewInteractiveSession {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive boundary review requires a real terminal.");
  }
  const theme = terminalTheme(output.isTTY && !("NO_COLOR" in process.env), {
    brand: true,
  });
  return {
    terminalColumns: output.columns,
    showReviewDetails: (title, lines) => withRawKeys(input, output, async (nextKey, render) => {
      const paint = () => render([theme.title(title), "", ...lines, "",
        `${theme.key("PgUp/PgDn")} Scroll   ${theme.key("Enter/Esc")} Return to pending review`]);
      output.on("resize", paint);
      try {
        paint();
        while (true) {
          const key = await nextKey();
          if (["return", "enter", "escape"].includes(key.name ?? "") || (key.ctrl && key.name === "c")) return;
        }
      } finally { output.off("resize", paint); }
    }),
    chooseResource: (resources, overview, options) =>
      chooseResource(resources, overview, options, input, output),
    editFieldTiers: (view, options) => editFieldTiers(view, options, input, output),
    editFieldEnumValues: (view, field) => editFieldEnumValues(view, field, input, output),
    editRelationshipPaths: (view, summary) =>
      editRelationshipPaths(view, summary, input, output),
    resolveBlockedResource: (view) => resolveBlockedResource(view, input, output),
    selectReadWorkloadCards: (cards, options) => selectReadWorkloadCards(cards, input, output, options),
    chooseOption: (title, choices, options) =>
      chooseBoundaryPromptOption(title, choices, options, input, output, theme),
    promptText: (prompt, options = {}) => withAlternateTerminalScreen(
      output,
      () => readTerminalTextWithEscape(
        terminalPromptWithContext(
          formatTextPromptWithBack(options.defaultValue === undefined ? prompt : `${prompt} [${options.defaultValue}]`, theme),
          options.context,
          theme,
        ),
        input,
        output,
        { defaultValue: options.defaultValue, preserveWhitespace: options.preserveWhitespace },
      ),
    ),
    confirm: (prompt, options = {}) => withAlternateTerminalScreen(output, () => {
      const defaultValue = options.defaultValue === true;
      return readTerminalBooleanConfirmation(
        terminalPromptWithContext(
          `${theme.bold(prompt)} ${theme.key(defaultValue ? "[Y/n]" : "[y/N]")} ` +
            `${theme.key("[Esc Back]")}: `,
          options.context,
          theme,
        ),
        input,
        output,
        { defaultValue },
      );
    }),
    confirmActivation: (prompt, options = {}) => withAlternateTerminalScreen(
      output,
      () => readTerminalActivationConfirmation(
        terminalPromptWithContext(theme.bold(prompt), options.context, theme),
        input,
        output,
      ),
    ),
    confirmReviewedDisabled: (prompt, options = {}) => withAlternateTerminalScreen(output, () =>
      readTerminalBooleanConfirmation(
        terminalPromptWithContext(
          `${theme.bold(prompt)} ${theme.key("[y/N]")} ${theme.key("[Esc Back]")}: `,
          options.context,
          theme,
        ),
        input,
        output,
        { defaultValue: false },
      )),
  };
}

async function chooseBoundaryPromptOption(
  title: string,
  choices: BoundaryPromptChoice[],
  options: BoundaryChoicePromptOptions | undefined,
  input: ReadStream,
  output: WriteStream,
  theme: TerminalTheme,
): Promise<string | undefined> {
  if (!choices.length) return undefined;
  const requested = options?.initialValue === undefined
    ? -1
    : choices.findIndex((choice) =>
        choice.value === options.initialValue && choice.disabled !== true);
  let selected = options?.requireExplicitSelection
    ? -1
    : requested >= 0
      ? requested
      : Math.max(0, choices.findIndex((choice) => choice.disabled !== true));
  return withRawKeys(input, output, async (nextKey, render) => {
    while (true) {
      render([
        theme.title(`  ${title}`),
        ...(options?.context ?? []).map((line) =>
          line ? `  ${theme.dim(line)}` : ""),
        "",
        ...choices.flatMap((choice, index) => {
          const focused = index === selected;
          const marker = focused ? theme.focus("  >") : "   ";
          const label = choice.disabled
            ? theme.dim(choice.label)
            : focused
              ? theme.focus(choice.label)
              : choice.label;
          return [
            `${marker} ${label}`,
            ...(choice.detail
              ? [`      ${theme.dim(choice.detail)}`]
              : []),
          ];
        }),
        "",
        `  ${theme.key("Up/Down")} Navigate   ${theme.key("Enter")} Select   ${theme.key("Esc")} Back`,
      ]);
      const key = await nextKey();
      if (isEscapeKey(key) || (key.ctrl && ["c", "d"].includes(key.name ?? ""))) {
        return undefined;
      }
      if (key.name === "up" || key.name === "down") {
        const direction = key.name === "up" ? -1 : 1;
        if (selected < 0) {
          const start = direction > 0 ? -1 : 0;
          for (let offset = 1; offset <= choices.length; offset += 1) {
            const candidate = (start + direction * offset + choices.length) % choices.length;
            if (choices[candidate]!.disabled !== true) {
              selected = candidate;
              break;
            }
          }
          continue;
        }
        for (let offset = 1; offset <= choices.length; offset += 1) {
          const candidate = (selected + direction * offset + choices.length) % choices.length;
          if (choices[candidate]!.disabled !== true) {
            selected = candidate;
            break;
          }
        }
      }
      if (selected >= 0
        && (key.name === "return" || key.name === "enter")
        && choices[selected]!.disabled !== true) {
        return choices[selected]!.value;
      }
    }
  });
}

async function selectReadWorkloadCards(
  cards: Array<{ id: string; title: string; detail: string }>,
  input: ReadStream,
  output: WriteStream,
  options: {
    initialSelectedIds?: string[];
    recommendationLabel?: string;
  } = {},
): Promise<string[] | undefined> {
  if (!cards.length) return [];
  const theme = terminalTheme(output.isTTY && !("NO_COLOR" in process.env), {
    brand: true,
  });
  const offeredIds = new Set(cards.map((card) => card.id));
  const selected = new Set((options.initialSelectedIds ?? []).filter((id) => offeredIds.has(id)));
  let cursor = 0;
  let notice = "";
  return withRawKeys(input, output, async (nextKey, render) => {
    while (true) {
      const guidance = READ_SELECTION_GUIDANCE.flatMap(line =>
        wrapStyledTerminalLine(`  ${line}`, terminalContentWidth(output.columns)));
      const visibleRows = Math.max(1, (output.rows ?? 24) - 10 - guidance.length);
      const start = Math.max(0, Math.min(
        cursor - Math.floor(visibleRows / 2),
        Math.max(0, cards.length - visibleRows),
      ));
      const end = Math.min(cards.length, start + visibleRows);
      const current = cards[cursor]!;
      render([
        theme.title("  CHOOSE REPRESENTATIVE QUESTIONS"),
        `  ${theme.dim(options.recommendationLabel
          ?? "No model or source query. Job matches appear first; choose exact plan shapes.")}`,
        ...guidance.map(line => theme.dim(line)),
        `  ${theme.bold(`${selected.size} selected`)}  ${theme.dim(`| question ${cursor + 1} of ${cards.length}`)}`,
        `  ${theme.dim(current.detail)}`,
        ...(notice ? [`  ${theme.warning(notice)}`] : [""]),
        ...cards.slice(start, end).map((card, offset) => {
          const index = start + offset;
          const marker = selected.has(card.id) ? theme.success("[x]") : "[ ]";
          const row = `  ${index === cursor ? theme.focus(">") : " "} ${marker} ${card.title}`;
          return index === cursor ? theme.bold(row) : row;
        }),
        "",
        `  ${theme.key("Up/Down")} Move   ${theme.key("Space")} Select   ${theme.key("A")} All   ${theme.key("C")} Clear`,
        `  ${theme.key("Enter")} Continue   ${theme.key("Esc")} Back`,
      ]);
      const key = await nextKey();
      notice = "";
      if (key.name === "escape" || key.sequence === "\u001b" || (key.ctrl && ["c", "d"].includes(key.name ?? ""))) {
        return undefined;
      }
      if (key.name === "up") cursor = (cursor - 1 + cards.length) % cards.length;
      if (key.name === "down") cursor = (cursor + 1) % cards.length;
      if (key.name === "space" || key.sequence === " ") {
        if (selected.has(current.id)) {
          selected.delete(current.id);
          notice = "Question removed. Check private verification needs before continuing.";
        }
        else selected.add(current.id);
      }
      if (key.name === "a" || key.sequence?.toLowerCase() === "a") {
        cards.forEach((card) => selected.add(card.id));
      }
      if (key.name === "c" || key.sequence?.toLowerCase() === "c") selected.clear();
      if (key.name === "return" || key.name === "enter") {
        if (!selected.size) {
          notice = "Select at least one question before continuing.";
          continue;
        }
        return cards.filter((card) => selected.has(card.id)).map((card) => card.id);
      }
    }
  });
}

async function resolveBlockedResource(
  view: BoundaryResourceReviewView,
  input: ReadStream,
  output: WriteStream,
): Promise<BoundaryBlockedResolution> {
  const rowCandidates = uniqueCandidates(view.row_identity.selected, view.row_identity.candidates);
  const tenantOptions = [
    ...uniqueCandidates(view.tenant_key.selected, view.tenant_key.candidates).map((value) => ({
      kind: "direct" as const,
      value,
      label: `${value} (direct column)`,
      selected: view.tenant_key.selected === value,
    })),
    ...(view.derived_tenant_scope?.candidates ?? []).map((scope) => ({
      kind: "derived" as const,
      value: scope.path_id,
      label: `${formatDerivedScopePath(scope)} (mandatory relationship path)`,
      selected: view.derived_tenant_scope?.selected?.path_id === scope.path_id,
      scope,
    })),
    ...(view.shared_reference_scope?.eligible ? [{
      kind: "shared_reference" as const,
      value: SHARED_REFERENCE_ACKNOWLEDGEMENT,
      label: "Shared reference - same reviewed rows for every tenant",
      selected: Boolean(view.shared_reference_scope.selected),
    }] : []),
    ...(view.organization_scope ? [{
      kind: "single_organization" as const,
      value: "single_organization" as const,
      label: `Whole organization ${view.organization_scope.organization_id} (no tenant predicate)`,
      selected: true,
    }] : []),
  ];
  const theme = terminalTheme(output.isTTY && !("NO_COLOR" in process.env), {
    brand: true,
  });
  const scopeGuidance = tenantOptions.length === 0
    ? blockedTenantScopeGuidance(view)
    : undefined;
  let selectedDecision = view.row_identity.selected ? 1 : 0;
  let rowIndex = Math.max(0, rowCandidates.indexOf(view.row_identity.selected ?? rowCandidates[0] ?? ""));
  let tenantIndex = Math.max(0, tenantOptions.findIndex((option) => option.selected));
  let actionNotice: string | undefined;

  return withRawKeys(input, output, async (nextKey, render) => {
    while (true) {
      const rowValue = rowCandidates[rowIndex];
      const tenantOption = tenantOptions[tenantIndex];
      const derivedDepth = tenantOption?.kind === "derived"
        ? tenantOption.scope.proof.links.length
        : 0;
      const reviewedDerivedDepth = view.reviewed_budgets?.max_derived_scope_hops
        ?? view.reviewed_budgets?.max_relationship_hops
        ?? 2;
      const depthAllowed = derivedDepth === 0 || derivedDepth <= reviewedDerivedDepth;
      const resolvable = Boolean(rowValue && tenantOption && depthAllowed);
      const selectedValue = selectedDecision === 0 ? rowValue : tenantOption?.value;
      const evidence = selectedDecision === 0
        ? view.row_identity.alternatives_considered
          .find((candidate) => candidate.value === selectedValue)?.evidence[0]
          ?? view.row_identity.evidence.find((item) => item.detail.includes(String(selectedValue)))?.detail
        : tenantOption?.kind === "derived"
          ? "database foreign key is non-null and points many-to-one to a unique key on the scoped ancestor"
          : tenantOption?.kind === "shared_reference"
            ? "human confirmation is required because Runner will apply no tenant predicate to this table"
            : tenantOption?.kind === "single_organization"
              ? "the reviewed boundary binds every row to one fixed organization outside model arguments"
            : view.tenant_key.alternatives_considered
            .find((candidate) => candidate.value === selectedValue)?.evidence[0]
            ?? view.tenant_key.evidence.find((item) => item.detail.includes(String(selectedValue)))?.detail;
      render([
        theme.title(`RESOLVE TABLE ACCESS - ${safeTerminalText(view.resource_id)}`),
        view.organization_scope
          ? "Runner needs one database-backed record ID; whole-organization row scope is already reviewed."
          : "Runner needs one database-backed record ID and one reviewed row-scope choice.",
        view.organization_scope
          ? theme.success(
              `Whole organization ${safeTerminalText(view.organization_scope.organization_id)} is active; no tenant column or tenant predicate is required.`,
            )
          : theme.dim("Choose a direct tenant column, a proven path, or Shared reference."),
        ...(view.organization_scope
          ? []
          : [theme.dim("Shared reference means every tenant receives the same reviewed rows.")]),
        theme.dim("These choices stay outside model arguments and do not activate access."),
        "",
        resolutionRow(
          theme,
          selectedDecision === 0,
          "Record ID",
          rowValue,
          rowCandidates.length,
          view.row_identity.selected === rowValue,
        ),
        resolutionRow(
          theme,
          selectedDecision === 1,
          view.organization_scope ? "Organization scope" : "Tenant isolation",
          tenantOption?.label,
          tenantOptions.length,
          tenantOption?.selected === true,
        ),
        "",
        ...(selectedValue
          ? [theme.dim(`Evidence: ${safeTerminalText(evidence ?? "inspected database structure")}`)]
          : [theme.danger(
            selectedDecision === 0
              ? "No single-column primary or unique key was proven by the database."
              : view.organization_scope
                ? "Whole-organization scope is reviewed outside the table's columns."
                : "No tenant-isolation candidate was found in the inspected structure.",
          )]),
        ...(tenantOption?.kind === "derived" && selectedDecision === 1
          ? derivedScopeCostAdvisoryLines(
              view,
              tenantOption.scope,
              reviewedDerivedDepth,
              theme,
            )
          : []),
        ...(resolvable
          ? [
              "",
              `${theme.key("Up/Down")} Choose decision   ` +
                `${theme.key("Left/Right/Space")} Change value`,
              `${theme.key("Enter")} Save choices and review columns [AVAILABLE]   ` +
                `${theme.key("B/Esc")} Back   ${theme.key("Q")} Quit`,
            ]
          : [
              "",
              theme.warning(scopeGuidance
                ? "This table is unavailable for the reviewed reasons below."
                : "This table cannot be added until the missing database structure is available."),
              ...(scopeGuidance
                ? [
                    "",
                    theme.bold("Why tenant isolation is unavailable"),
                    ...scopeGuidance.why.map((line) => `  - ${safeTerminalText(line)}`),
                    "",
                    theme.bold("What makes this table addable"),
                    ...scopeGuidance.remediation.map((line) => `  - ${safeTerminalText(line)}`),
                  ]
                : []),
              `${theme.key("Up/Down")} Choose decision   ` +
                `${theme.key("Left/Right/Space")} Change available value`,
              `${theme.key("Enter")} Save choices [UNAVAILABLE]   ` +
                `${theme.key("B/Esc")} Back   ${theme.key("Q")} Quit`,
            ]),
        ...(actionNotice ? [theme.warning(actionNotice)] : []),
      ]);
      const key = await nextKey();
      if (isBackKey(key) || isEscapeKey(key)) return "back";
      if (isCancel(key)) return undefined;
      if (key.name === "up" || key.name === "down") {
        selectedDecision = selectedDecision === 0 ? 1 : 0;
        continue;
      }
      const direction = key.name === "left" ? -1 : key.name === "right" || key.name === "space" ? 1 : 0;
      if (direction !== 0) {
        if (selectedDecision === 0 && rowCandidates.length) {
          rowIndex = (rowIndex + direction + rowCandidates.length) % rowCandidates.length;
        } else if (selectedDecision === 1 && tenantOptions.length) {
          tenantIndex = (tenantIndex + direction + tenantOptions.length) % tenantOptions.length;
        }
        continue;
      }
      if ((key.name === "return" || key.name === "enter") && rowValue && tenantOption && depthAllowed) {
        if (tenantOption.kind === "direct") {
          return { row_identity: rowValue, tenant_key: tenantOption.value };
        }
        if (tenantOption.kind === "derived") {
          return { row_identity: rowValue, tenant_scope_path: tenantOption.value };
        }
        if (tenantOption.kind === "single_organization") {
          return { row_identity: rowValue, organization_scope: "single_organization" };
        }
        return {
          row_identity: rowValue,
          shared_reference_scope: SHARED_REFERENCE_ACKNOWLEDGEMENT,
        };
      }
      if (key.name === "return" || key.name === "enter") {
        actionNotice = depthAllowed
          ? "Enter is unavailable until both a record ID and trusted row scope are proven."
          : `Enter is unavailable: this ${derivedDepth}-hop path exceeds the reviewed maximum of ${reviewedDerivedDepth}.`;
        continue;
      }
    }
  });
}

function derivedScopeCostAdvisoryLines(
  view: BoundaryResourceReviewView,
  scope: DerivedScopePath,
  reviewedDepth: number,
  theme: TerminalTheme,
): string[] {
  const depth = scope.proof.links.length;
  const rows = view.approximate_row_count;
  const rowHops = rows === undefined ? undefined : rows * depth;
  const pressure = depth >= 3 || (rowHops !== undefined && rowHops >= 500_000);
  return [
    "",
    (pressure ? theme.warning : theme.dim)(
      `Cost advisory: ${depth}-hop mandatory scope path; reviewed statement timeout ${(view.reviewed_budgets?.statement_timeout_ms ?? 3000).toLocaleString("en-US")} ms.`,
    ),
    ...(rows === undefined
      ? [theme.dim("Catalog row volume is unavailable; doctor can attest indexes but cannot estimate structural volume.")]
      : [theme.dim(
          `Catalog estimate: about ${rows.toLocaleString("en-US")} total root rows (${rowHops!.toLocaleString("en-US")} row-hops before selectivity). This is not a tenant count or latency prediction.`,
        )]),
    ...(depth > reviewedDepth
      ? [theme.danger(
          `This path is not selectable yet. In /access press L and raise Derived-scope depth to ${depth}, then return here.`,
        )]
      : []),
    ...(pressure
      ? [theme.warning(
          "Use doctor to verify every path index. For high-volume leaves, a direct tenant column is usually faster; measured query time appears in /details.",
        )]
      : []),
  ];
}

function uniqueCandidates(selected: string | undefined, candidates: string[]): string[] {
  return [...new Set([...(selected ? [selected] : []), ...candidates])];
}

function exactModelOutputConfirmationLines(theme: TerminalTheme): string[] {
  return [
    "",
    theme.bold(
      "Show exact Runner digests, fingerprints, and query-audit hashes to model-facing " +
      "MCP clients and local Ask? Operator evidence is already exact. Use this only for " +
      "a diagnostic client.",
    ),
    `${theme.key("[y/N]")} ${theme.key("[Esc Back]")}:`,
  ];
}

function modelGuidedSetupHint(theme: TerminalTheme): string[] {
  return [
    theme.bold(`${theme.key("W")} Model chat can create or edit Read + Action authority anytime.`),
    theme.dim("Describe the business rule; Runner validates it; only you activate it. Manual controls stay available."),
  ];
}

function exactModelOutputConfirmationDecision(
  key: Keypress,
): "accept" | "cancel" | "wait" {
  const value = (key.sequence ?? "").toLowerCase();
  if (key.name === "y" || value === "y") return "accept";
  if (
    key.name === "n"
    || value === "n"
    || key.name === "return"
    || key.name === "enter"
    || key.sequence === "\r"
    || key.sequence === "\n"
    || isEscapeKey(key)
  ) return "cancel";
  return "wait";
}

function resolutionRow(
  theme: TerminalTheme,
  selected: boolean,
  label: string,
  value: string | undefined,
  optionCount: number,
  alreadyReviewed: boolean,
): string {
  const line = `${selected ? ">" : " "} ${label.padEnd(18)} ${safeTerminalText(value ?? "not available")}`
    + (optionCount > 1 ? `  [${optionCount} choices]` : "")
    + (alreadyReviewed ? "  [reviewed]" : "  [choice required]");
  return selected ? theme.focus(line) : line;
}

async function chooseResource(
  resources: BoundaryResourceReviewSummary[],
  overview: BoundaryReviewOverview | undefined,
  options: {
    initialView?: "boundaries" | "access";
    startingBoundaryName?: string;
    startAtBoundaryList?: boolean;
    initialResourceId?: string;
    notice?: BoundaryAccessNotice;
  } | undefined,
  input: ReadStream,
  output: WriteStream,
): Promise<BoundaryResourceSelection | undefined> {
  if (!resources.length) throw new Error("The boundary review contains no inspected tables or views.");
  const theme = terminalTheme(output.isTTY && !("NO_COLOR" in process.env), {
    brand: true,
  });
  let selected = 0;
  let selectedBoundary = 0;
  let showMap = false;
  let showMapDetails = false;
  let showReviewItems = false;
  const focusedAccess = options?.initialView === "access";
  const startingBoundaryName = options?.startingBoundaryName;
  let showBoundaryList = options?.startAtBoundaryList ?? !focusedAccess;
  let resourceView: ResourcePickerView = resources.some(
    (resource) => resource.included || resource.active,
  ) ? "boundary" : "all";
  let initialResourceId = options?.initialResourceId;
  let mapOffset = 0;
  let startingTableNotice: string | undefined;
  let actionNotice: string | undefined;
  let confirmExactModelOutput = false;
  const modelOutputMode = overview?.model_authority_metadata_mode ?? "semantic";
  const modelOutputStatus = modelOutputMode === "exact"
    ? theme.warning("Model output [EXACT] - diagnostic hashes are visible to models")
    : theme.success("Model output [SEMANTIC] - exact hashes stay operator-only");
  const modelOutputActionStatus = modelOutputMode === "exact"
    ? "EXACT: hashes model-visible"
    : "SEMANTIC: hashes operator-only";
  return withRawKeys(input, output, async (nextKey, render) => {
    while (true) {
      if (startingBoundaryName) {
        selected = Math.min(selected, resources.length - 1);
        const start = boundedWindowStart(selected, resources.length, 10);
        const visible = resources.slice(start, start + 10);
        const end = start + visible.length;
        const below = resources.length - end;
        const highlighted = resources[selected]!;
        const eligible = resources.filter(firstTableIsStartable).length;
        const sequencedAfterStart = resources.filter((resource) =>
          resource.first_table_startable === false).length;
        const unavailable = resources.length - eligible - sequencedAfterStart;
        render([
          theme.title(`CHOOSE FIRST TABLE - ${safeTerminalText(startingBoundaryName)}`),
          "A new boundary starts with the table you choose. Nothing is copied from another boundary.",
          theme.dim("Column access opens immediately after this choice; no authority is active yet."),
          "",
          ...visible.map((resource, index) => {
            const absolute = start + index;
            const details = resource.first_table_startable === false
              ? resource.first_table_scope_kind === "shared_reference"
                ? `ADD AFTER SCOPED TABLE · ${resource.first_table_guidance ?? "review Shared reference inside the new boundary"}`
                : `START FROM ANCESTOR · ${resource.first_table_guidance ?? "add its scoped ancestor first"}`
              : resource.status === "draft_read"
              ? `${resource.model_visible_fields} model · ` +
                `${resource.runner_output_only_fields} Runner-only · ${resource.kept_out_fields} kept out`
              : resource.inline_resolution_available
                ? `REVIEW REQUIRED · ${resource.blockers[0] ?? "choose trusted structure"}`
                : `UNAVAILABLE · ${resource.blockers[0] ?? "structural review required"}`;
            const line = `${absolute === selected ? ">" : " "} ${safeTerminalText(resource.resource_id)}  ` +
              `[${safeTerminalText(details)}]`;
            if (absolute === selected) return theme.focus(line);
            return firstTableIsStartable(resource)
              ? line
              : theme.dim(line);
          }),
          theme.dim(
            `Inspected tables: ${resources.length} total · ${eligible} can start · ` +
            `${sequencedAfterStart} add after required scope · ${unavailable} unavailable.`,
          ),
          ...(below > 0 || start > 0
            ? [theme.dim(
              `Showing ${start + 1}-${end} of ${resources.length}. ` +
              (below > 0
                ? `${theme.key("Down")} shows ${below} more ${plural(below, "table", "tables")} below.`
                : "Up returns to earlier tables."),
            )]
            : []),
          ...(startingTableNotice ? ["", theme.warning(startingTableNotice)] : []),
          "",
          `${theme.key("Up/Down")} Select   ${theme.key("Enter")} Choose this table`,
          `${theme.key("B/Esc/Q")} Cancel new boundary`,
        ]);
        const key = await nextKey();
        if (isCancel(key) || isBackKey(key) || isEscapeKey(key)) return undefined;
        if (key.name === "up") {
          selected = (selected - 1 + resources.length) % resources.length;
          continue;
        }
        if (key.name === "down") {
          selected = (selected + 1) % resources.length;
          continue;
        }
        if (key.name === "return" || key.name === "enter") {
          if (!firstTableIsStartable(highlighted)) {
            if (highlighted.first_table_startable === false) {
              startingTableNotice = highlighted.first_table_scope_kind === "shared_reference"
                ? `${safeTerminalText(highlighted.resource_id)} cannot be the first table in this authoring flow. ` +
                  `${safeTerminalText(highlighted.first_table_guidance ?? "Start with a tenant-scoped table, then add it.")}. ` +
                  "The no-per-tenant-rows acknowledgement is recorded separately for every boundary."
                : `${safeTerminalText(highlighted.resource_id)} cannot be the first table. ` +
                  `${safeTerminalText(highlighted.first_table_guidance ?? "Add its directly scoped ancestor first.")}. ` +
                  `Required scope is derived through ${safeTerminalText(
                    highlighted.first_table_scope_label ?? "a mandatory reviewed relationship path",
                  )}.`;
              continue;
            }
            startingTableNotice = `${safeTerminalText(highlighted.resource_id)} cannot start a boundary: ` +
              safeTerminalText(
                highlighted.scope_resolution_guidance?.why[0]
                  ?? highlighted.blockers[0]
                  ?? "structural review is required first.",
              );
            continue;
          }
          return { resource_id: highlighted.resource_id, action: "add" };
        }
        continue;
      }
      if (showReviewItems) {
        const boundaryResources = resources.filter((resource) => resource.included || resource.active);
        const listedResources = resourcesForPickerView(
          resources,
          boundaryResources,
          resourceView,
          focusedAccess,
        );
        if (initialResourceId) {
          const initialIndex = listedResources.findIndex(
            (resource) => resource.resource_id === initialResourceId,
          );
          if (initialIndex >= 0) selected = initialIndex;
          initialResourceId = undefined;
        }
        selected = Math.min(selected, listedResources.length - 1);
        const highlighted = listedResources[selected]!;
        render([
          theme.title(`TABLE SIGN-OFF DETAILS - ${safeTerminalText(highlighted.resource_id)}`),
          theme.bold(
            `This table is one part of boundary "${safeTerminalText(highlighted.candidate_boundary_name)}".`,
          ),
          "This one sign-off covers field access, operations, row scope, privacy",
          "limits, and reviewed relationships. The items below are audit details,",
          "not separate prompts.",
          "",
          ...(highlighted.pending_decisions.length
            ? highlighted.pending_decisions.flatMap((decision, index) => {
              const item = reviewItemPresentation(highlighted.resource_id, decision);
              return [
                `${index + 1}. ${theme.bold(safeTerminalText(item.label))}`,
                `   ${theme.dim(safeTerminalText(item.detail))}`,
              ];
            })
            : [theme.success("This table sign-off is complete.")]),
          ...(highlighted.blockers.length
            ? ["", theme.danger("Structural blockers:"), ...highlighted.blockers.map((item) =>
              `- ${safeTerminalText(item)}`)]
            : []),
          "",
          `${theme.key("Enter")} Edit column access   ${theme.key("S")} Sign off table   ` +
            `${theme.key("M")} View access map`,
          `${theme.key("B/Esc")} Back   ${theme.key("Q")} Quit`,
          theme.dim(
            `One S sign-off records all ${highlighted.risk_count} exact ` +
            `${plural(highlighted.risk_count, "decision", "decisions")} above.`,
          ),
          theme.dim(
            `Advanced edits: synapsor-runner boundary review resource ` +
            `${safeTerminalText(highlighted.resource_id)} --help`,
          ),
        ]);
        const key = await nextKey();
        if (isBackKey(key) || key.name === "p") {
          showReviewItems = false;
          continue;
        }
        if (key.name === "m") {
          showReviewItems = false;
          showMap = true;
          showMapDetails = false;
          mapOffset = Math.max(0, resources.indexOf(highlighted) - 2);
          continue;
        }
        if (key.name === "return" || key.name === "enter") {
          return { resource_id: highlighted.resource_id, action: "review" };
        }
        if (key.name === "s" && highlighted.included) {
          return { resource_id: highlighted.resource_id, action: "signoff" };
        }
        if (isCancel(key)) return undefined;
        continue;
      }
      if (showMap) {
        const mapLines = boundaryOverviewMapLines(
          resources,
          theme,
          "synapsor-runner",
          showMapDetails,
          Math.max(36, terminalContentWidth(output.columns)),
        );
        const pageSize = 15;
        mapOffset = Math.min(mapOffset, Math.max(0, mapLines.length - pageSize));
        render([
          theme.title("WHOLE BOUNDARY MAP"),
          boundaryOverviewSummary(resources),
          `${theme.key("Up/Down")} Scroll   ${theme.key("D")} ${showMapDetails ? "Hide" : "Show"} path IDs   ` +
            `${theme.key("B/Esc")} Back   ${theme.key("Q")} Quit`,
          "",
          ...mapLines.slice(mapOffset, mapOffset + pageSize),
          "",
          theme.dim(
            mapLines.length > pageSize
              ? `Showing lines ${mapOffset + 1}-${Math.min(mapLines.length, mapOffset + pageSize)} of ${mapLines.length}.`
              : "All inspected tables and reviewed relationship candidates are shown.",
          ),
        ]);
        const key = await nextKey();
        if (key.name === "m" || isBackKey(key) || key.name === "return" || key.name === "enter") {
          showMap = false;
          continue;
        }
        if (key.name === "d") {
          showMapDetails = !showMapDetails;
          mapOffset = 0;
          continue;
        }
        if (isCancel(key)) return undefined;
        if (key.name === "up") mapOffset = Math.max(0, mapOffset - 1);
        if (key.name === "down") {
          mapOffset = Math.min(Math.max(0, mapLines.length - pageSize), mapOffset + 1);
        }
        continue;
      }
      if (showBoundaryList) {
        const boundaryRowLayout = savedBoundaryRowLayout(terminalContentWidth(output.columns));
        const includedCount = resources.filter((resource) => resource.included).length;
        const activeResources = resources.filter((resource) => resource.active);
        const activeBoundaryName = activeResources[0]?.active_boundary_name;
        const candidateBoundaryName = resources[0]!.candidate_boundary_name;
        const reviewLeft = boundaryReviewLeft(resources, overview);
        const boundaryEntries = overview?.boundaries?.length
          ? overview.boundaries
          : [{
            name: candidateBoundaryName,
            selected: true,
            active: activeBoundaryName === candidateBoundaryName,
            matches_active_digest: activeBoundaryName === candidateBoundaryName,
            table_count: includedCount,
            outstanding_decisions: overview?.outstanding_decisions
              ?? resources.filter((resource) => resource.included)
                .reduce((total, resource) => total + resource.risk_count, 0),
          }];
        selectedBoundary = Math.min(selectedBoundary, boundaryEntries.length - 1);
        const highlightedBoundary = boundaryEntries[selectedBoundary]!;
        const highlightedOutstanding = highlightedBoundary.selected
          ? (reviewLeft === "Complete"
            ? (highlightedBoundary.policy_review_required ? 1 : 0)
            : highlightedBoundary.outstanding_decisions)
          : highlightedBoundary.outstanding_decisions;
        const highlightedActionAvailable = highlightedBoundary.active
          || (highlightedBoundary.selected && (highlightedOutstanding === 0
            || (highlightedBoundary.proposal_action_state === "none" && !highlightedBoundary.verified_action_state)));
        const selectedBoundaryHasPendingChange = highlightedBoundary.selected
          && (highlightedBoundary.policy_review_required
            || !highlightedBoundary.active
            || !highlightedBoundary.matches_active_digest);
        const boundaryListCompatibility = databaseCompatibilityLine(
          resources[0]?.database_server_compatibility,
          theme,
        );
        if (focusedAccess && !activeResources.length && boundaryEntries.length === 1) {
          render([
            theme.title("YOUR DATA BOUNDARY"),
            "A boundary is the reviewed tables, columns, relationships, and limits",
            "that your AI cannot exceed.",
            ...(boundaryListCompatibility ? [boundaryListCompatibility] : []),
            "",
            theme.bold("BOUNDARIES"),
            theme.dim("READ controls Explore. ACTION controls proposals; approval and apply remain separate."),
            theme.bold(savedBoundaryRow("KEY", "NAME", "TYPE", "STATUS", "CONTENT", "AI ACCESS", boundaryRowLayout)),
            theme.focus(savedBoundaryRow(
              ">",
              candidateBoundaryName,
              "READ",
              "DRAFT",
              `${includedCount} ${plural(includedCount, "table", "tables")}`,
              "NOT ACTIVE",
              boundaryRowLayout,
            )),
            ...linkedActionBoundaryLines(overview, highlightedBoundary, theme, boundaryRowLayout),
            "",
            highlightedBoundary.ask_intent_check_mode === "boundary_only"
              ? theme.warning("Local Ask plan check: BOUNDARY ONLY")
              : theme.success("Local Ask plan check: BALANCED"),
            theme.dim(
              highlightedBoundary.ask_intent_check_mode === "boundary_only"
                ? "English question-to-plan comparison is off. Reviewed Explore validation still applies."
                : "Runner refuses a valid but contradictory model plan before Explore execution.",
            ),
            modelOutputStatus,
            ...modelGuidedSetupHint(theme),
            "",
            theme.bold(
              `${theme.key("Enter/C")} ${overview?.discovery_concerns?.length ? "Inspect activation blocker" : "Review + activate"}`,
            ),
            ...discoveryReadinessLines(overview, theme),
            ...packTerminalActions([
              `${theme.key("E")} Edit access`,
              `${theme.key("A")} New boundary`,
              `${theme.key("P")} Privacy for all tables`,
              `${theme.key("L")} Limits`,
              `${theme.key("W")} Model chat - create/edit Read + Action`,
              `${theme.key("Y")} ${safeActionAccessLabel(
                highlightedBoundary.proposal_action_state,
                highlightedActionAvailable,
                highlightedBoundary.proposal_action_active_count,
              )}`,
              `${theme.key("T")} Ask plan check`,
              `${theme.key("O")} Model output [${modelOutputActionStatus}]`,
              `${theme.key("M")} Map`,
              `${theme.key("N")} Rename`,
              `${theme.key("X")} Delete this saved boundary [AVAILABLE]`,
              `${theme.key("D")} Deactivate - stop serving it [NOT ACTIVE]`,
              `${theme.key("Q")} Quit`,
            ], terminalContentWidth(output.columns)),
            ...(actionNotice ? [theme.warning(actionNotice)] : []),
            "",
            theme.dim(
              "Activation returns here so you can keep editing. W continues model setup; Q closes this editor.",
            ),
            theme.dim("The draft grants no AI access until you confirm it."),
            ...(options?.notice
              ? ["", ...formatBoundaryAccessNotice(theme, options.notice)]
              : []),
            ...(confirmExactModelOutput ? exactModelOutputConfirmationLines(theme) : []),
          ]);
          const key = await nextKey();
          if (confirmExactModelOutput) {
            const decision = exactModelOutputConfirmationDecision(key);
            if (decision === "accept") {
              return { action: "model_output", exact_metadata_confirmed: true };
            }
            if (decision === "cancel") {
              confirmExactModelOutput = false;
              actionNotice = "Model output [SEMANTIC] is unchanged; exact hashes remain operator-only.";
            }
            continue;
          }
          if (key.name === "return" || key.name === "enter" || key.name === "c") {
            return { action: "confirm" };
          }
          if (key.name === "e") {
            showBoundaryList = false;
            resourceView = "boundary";
            selected = 0;
            continue;
          }
          if (key.name === "m") {
            showMap = true;
            showMapDetails = false;
            mapOffset = 0;
            continue;
          }
          if (key.name === "a") return { action: "create" };
          if (key.name === "p") return { action: "privacy_all" };
          if (key.name === "l") return { action: "limits" };
          if (key.name === "w") return { action: "workloads" };
          if (key.name === "y") {
            if (highlightedActionAvailable) {
              return { action: "actions", boundary_name: candidateBoundaryName };
            }
            actionNotice = "Finish the read review first. Proposal drafting can begin before read activation, but only from a fully reviewed exact revision.";
            continue;
          }
          if (key.name === "t") {
            return { action: "intent_check", boundary_name: candidateBoundaryName };
          }
          if (key.name === "o") {
            if (modelOutputMode === "semantic") {
              confirmExactModelOutput = true;
              actionNotice = undefined;
              continue;
            }
            return { action: "model_output" };
          }
          if (key.name === "n") return { action: "rename" };
          if (key.name === "x") {
            return { action: "delete", boundary_name: candidateBoundaryName };
          }
          if (key.name === "d") {
            actionNotice = `${safeTerminalText(candidateBoundaryName)} is not active; there is nothing to deactivate.`;
            continue;
          }
          if (isCancel(key) || isEscapeKey(key)) return undefined;
          continue;
        }
        const rows = boundaryEntries.map((entry, index) => {
          const isCurrent = entry.selected;
          const outstanding = isCurrent
            ? (reviewLeft === "Complete"
              ? (entry.policy_review_required ? 1 : 0)
              : entry.outstanding_decisions)
            : entry.outstanding_decisions;
          const status = entry.active
            ? (entry.matches_active_digest ? "ACTIVE" : "ACTIVE + DRAFT EDITS")
            : outstanding > 0
              ? "DRAFT - NO ACCESS"
              : "REVIEWED - NOT ACTIVE";
          const line = savedBoundaryRow(
            index === selectedBoundary ? ">" : "",
            entry.name,
            "READ",
            status,
            `${entry.table_count} ${plural(entry.table_count, "table", "tables")}`,
            entry.active ? "ACTIVE" : "NONE",
            boundaryRowLayout,
          );
          return index === selectedBoundary ? theme.focus(line) : line;
        });
        render([
          theme.title("BOUNDARIES"),
          "READ controls Explore. ACTION controls proposals; approval and apply remain separate.",
          ...(boundaryListCompatibility ? [boundaryListCompatibility] : []),
          "",
          theme.bold(savedBoundaryRow("KEY", "NAME", "TYPE", "STATUS", "CONTENT", "AI ACCESS", boundaryRowLayout)),
          ...rows,
          ...discoveryReadinessLines(overview, theme),
          ...linkedActionBoundaryLines(overview, highlightedBoundary, theme, boundaryRowLayout),
          "",
          highlightedBoundary.ask_intent_check_mode === "boundary_only"
            ? theme.warning(
              `Local Ask plan check for ${safeTerminalText(highlightedBoundary.name)}: BOUNDARY ONLY`,
            )
            : theme.success(
              `Local Ask plan check for ${safeTerminalText(highlightedBoundary.name)}: BALANCED`,
            ),
          theme.dim(
            highlightedBoundary.ask_intent_check_mode === "boundary_only"
              ? "English question-to-plan comparison is off. Reviewed Explore validation still applies."
              : "Runner refuses a valid but contradictory model plan before Explore execution.",
          ),
          modelOutputStatus,
          ...modelGuidedSetupHint(theme),
          ...(options?.notice
            ? ["", ...formatBoundaryAccessNotice(theme, options.notice)]
            : []),
          ...(selectedBoundaryHasPendingChange
            ? [
              "",
              theme.warning(highlightedBoundary.policy_review_required
                ? "LEGACY BOUNDARY POLICY NEEDS REVIEW"
                : "1 PENDING BOUNDARY CHANGE IS NOT ACTIVE"),
              ...(highlightedBoundary.policy_review_required
                ? [
                  "Runner preserved this boundary's exact revision and did not assign the old project-wide settings to it.",
                  theme.bold("Open this boundary and save a reviewed setting, or Rescan, to isolate its policy before activation."),
                ]
                : [theme.bold(overview?.discovery_concerns?.length
                  ? `${theme.key("C")} shows why this saved revision is not ready to activate.`
                  : `${theme.key("C")} reviews and activates the exact disabled update.`)]),
            ]
            : []),
          "",
          ...packTerminalActions([
            `${theme.key("Up/Down")} Select`,
            `${theme.key("E")} Edit access manually`,
            `${theme.key("Enter")} ${highlightedBoundary.selected
              ? (focusedAccess ? "Edit" : "Review")
              : "Open"}`,
            `${theme.key("C")} ${overview?.discovery_concerns?.length ? "Inspect activation blocker" : focusedAccess ? "Review + activate" : "Complete review"}`,
            `${theme.key("A")} New boundary`,
            `${theme.key("P")} Privacy for all tables`,
            `${theme.key("L")} Limits`,
            `${theme.key("W")} Model chat - create/edit Read + Action`,
            `${theme.key("Y")} ${safeActionAccessLabel(
              highlightedBoundary.proposal_action_state,
              highlightedActionAvailable,
              highlightedBoundary.proposal_action_active_count,
            )}`,
            `${theme.key("T")} Ask plan check`,
            `${theme.key("O")} Model output [${modelOutputActionStatus}]`,
            `${theme.key("M")} Map`,
            `${theme.key("N")} Rename`,
            `${theme.key("X")} Delete this saved boundary [AVAILABLE]`,
            `${theme.key("D")} Deactivate - stop serving it ` +
              `[${highlightedBoundary.active ? "ACTIVE" : "NOT ACTIVE"}]`,
            `${theme.key("Q")} Quit`,
          ], terminalContentWidth(output.columns)),
          ...(actionNotice ? [theme.warning(actionNotice)] : []),
          ...(confirmExactModelOutput ? exactModelOutputConfirmationLines(theme) : []),
        ]);
        const key = await nextKey();
        if (confirmExactModelOutput) {
          const decision = exactModelOutputConfirmationDecision(key);
          if (decision === "accept") {
            return { action: "model_output", exact_metadata_confirmed: true };
          }
          if (decision === "cancel") {
            confirmExactModelOutput = false;
            actionNotice = "Model output [SEMANTIC] is unchanged; exact hashes remain operator-only.";
          }
          continue;
        }
        if (key.name === "up") {
          selectedBoundary = (selectedBoundary - 1 + boundaryEntries.length) % boundaryEntries.length;
          actionNotice = undefined;
          continue;
        }
        if (key.name === "down") {
          selectedBoundary = (selectedBoundary + 1) % boundaryEntries.length;
          actionNotice = undefined;
          continue;
        }
        if (key.name === "return" || key.name === "enter" || key.name === "e") {
          if (!highlightedBoundary.selected) {
            return { action: "switch", boundary_name: highlightedBoundary.name };
          }
          showBoundaryList = false;
          continue;
        }
        if (key.name === "m") {
          showMap = true;
          showMapDetails = false;
          mapOffset = 0;
          continue;
        }
        if (key.name === "a") return { action: "create" };
        if (key.name === "p") return { action: "privacy_all" };
        if (key.name === "l") return { action: "limits" };
        if (key.name === "w") return { action: "workloads" };
        if (key.name === "y") {
          if (highlightedActionAvailable) {
            return { action: "actions", boundary_name: highlightedBoundary.name };
          }
          actionNotice = highlightedBoundary.selected
            ? "Finish this exact read review first. Read activation is not required for proposal drafting."
            : "Open this boundary first. Pending proposal drafts bind only to the selected fully reviewed read revision.";
          continue;
        }
        if (key.name === "t") {
          return { action: "intent_check", boundary_name: highlightedBoundary.name };
        }
        if (key.name === "o") {
          if (modelOutputMode === "semantic") {
            confirmExactModelOutput = true;
            actionNotice = undefined;
            continue;
          }
          return { action: "model_output" };
        }
        if (key.name === "n") {
          if (!highlightedBoundary.selected) {
            return { action: "switch", boundary_name: highlightedBoundary.name };
          }
          return { action: "rename" };
        }
        if (key.name === "x") {
          return { action: "delete", boundary_name: highlightedBoundary.name };
        }
        if (key.name === "c") {
          if (!highlightedBoundary.selected) {
            return { action: "switch", boundary_name: highlightedBoundary.name };
          }
          return { action: "confirm" };
        }
        if (key.name === "d" && highlightedBoundary.active) {
          return { action: "disable", boundary_name: highlightedBoundary.name };
        }
        if (key.name === "d") {
          actionNotice = `${safeTerminalText(highlightedBoundary.name)} is not active; there is nothing to deactivate.`;
          continue;
        }
        if (focusedAccess && (isEscapeKey(key) || isBackKey(key))) return undefined;
        if (isCancel(key)) return undefined;
        continue;
      }
      const boundaryResources = resources.filter((resource) => resource.included || resource.active);
      const listedResources = resourcesForPickerView(
        resources,
        boundaryResources,
        resourceView,
        focusedAccess,
      );
      if (!listedResources.length) {
        render([
          theme.title(
            focusedAccess
              ? `EDIT ACCESS - ${safeTerminalText(resources[0]!.candidate_boundary_name)}`
              : safeTerminalText(resources[0]!.candidate_boundary_name),
          ),
          theme.bold("ADD RELATED TABLES"),
          "No other inspected table has a proven relationship path to this boundary.",
          theme.dim(
            "Runner does not infer joins from similar names. Only inspected foreign-key paths qualify.",
          ),
          "",
          `${theme.key("Tab")} Show all inspected tables   ${theme.key("B/Esc")} Boundary tables`,
          `${theme.key("M")} Map   ${theme.key("Q")} Quit`,
          theme.dim("Choosing an unrelated table remains an explicit advanced action."),
        ]);
        const key = await nextKey();
        if (key.name === "tab") {
          resourceView = "all";
          selected = 0;
          continue;
        }
        if (isBackKey(key)) {
          resourceView = "boundary";
          selected = 0;
          continue;
        }
        if (key.name === "m") {
          showMap = true;
          showMapDetails = false;
          mapOffset = 0;
          continue;
        }
        if (isCancel(key)) return undefined;
        continue;
      }
      if (initialResourceId) {
        const initialIndex = listedResources.findIndex(
          (resource) => resource.resource_id === initialResourceId,
        );
        if (initialIndex >= 0) selected = initialIndex;
        initialResourceId = undefined;
      }
      selected = Math.min(selected, listedResources.length - 1);
      const start = boundedWindowStart(selected, listedResources.length, 10);
      const visible = listedResources.slice(start, start + 10);
      const end = start + visible.length;
      const below = listedResources.length - end;
      const highlighted = listedResources[selected]!;
      const includedCount = resources.filter((resource) => resource.included).length;
      const reviewLeft = boundaryReviewLeft(resources, overview);
      const selectedBoundaryEntry = overview?.boundaries?.find((entry) => entry.selected);
      const candidateIsActive = selectedBoundaryEntry
        ? selectedBoundaryEntry.active && selectedBoundaryEntry.matches_active_digest
        : reviewLeft === "Complete"
          && resources.some((resource) =>
            resource.active_boundary_name === resource.candidate_boundary_name)
          && resources.filter((resource) => resource.active).length === includedCount;
      const candidateHasPendingChange = selectedBoundaryEntry?.active === true
        && selectedBoundaryEntry.matches_active_digest === false;
      const candidateActionAvailable = selectedBoundaryEntry?.active === true
        || (selectedBoundaryEntry?.proposal_action_state === "none" && !selectedBoundaryEntry.verified_action_state)
        || (reviewLeft === "Complete" && selectedBoundaryEntry?.policy_review_required !== true);
      const candidateStatus = candidateIsActive
        ? theme.success("ACTIVE")
        : candidateHasPendingChange
          ? theme.warning("ACTIVE + DRAFT EDITS")
        : reviewLeft === "Complete"
          ? theme.success("REVIEWED - NOT ACTIVE")
        : theme.warning("DRAFT - NO ACCESS");
      const selectedCompatibility = databaseCompatibilityLine(
        highlighted.database_server_compatibility,
        theme,
      );
      const displayedReviewLeft = focusedAccess && reviewLeft !== "Complete"
        ? "FINAL REVIEW PENDING"
        : safeTerminalText(reviewLeft);
      const actionWidth = terminalContentWidth(output.columns);
      const selectedIncluded = resourceView === "boundary" && highlighted.included;
      const relationshipStatus = relationshipPathActionStatus(highlighted);
      const selectedTableActions = [
        `${theme.key("Up/Down")} Select`,
        `${theme.key("Enter")} ${resourceView === "boundary" ? "Edit columns" : "Review and add"}`,
        `${theme.key("R")} Remove from draft ` +
          `[${selectedIncluded ? "AVAILABLE" : "NOT IN DRAFT"}]`,
        `${theme.key("J")} Relationship paths ` +
          `[${selectedIncluded ? relationshipStatus : "ADD TABLE FIRST"}]`,
        ...(focusedAccess
          ? [
              `${theme.key("P")} Privacy - withhold small groups ` +
                `[${selectedIncluded
                  ? `MIN ${highlighted.minimum_cohort_size ?? 5}${highlighted.minimum_cohort_overridden ? ", OVERRIDE" : ""}`
                  : "ADD TABLE FIRST"}]`,
              `${theme.key("G")} Metrics and numeric bands ` +
                `[${selectedIncluded ? "AVAILABLE" : "ADD TABLE FIRST"}]`,
              `${theme.key("I")} Table label and description ` +
                `[${selectedIncluded ? "AVAILABLE" : "ADD TABLE FIRST"}]`,
              `${theme.key("S")} Table sign-off - use C for the whole boundary [BOUNDARY LEVEL]`,
            ]
          : [
              `${theme.key("S")} Sign off this table's reviewed choices ` +
                `[${selectedIncluded ? "AVAILABLE" : "ADD TABLE FIRST"}]`,
              `${theme.key("P")} Explain this table's sign-off details [AVAILABLE]`,
            ]),
      ];
      const boundaryActions = [
        `${theme.key("B/Esc")} ${resourceView === "boundary"
          ? (focusedAccess ? "Boundary overview" : "Boundaries")
          : "Boundary tables"}`,
        ...(resourceView === "boundary"
          ? [`${theme.key("A")} Add related tables`]
          : [`${theme.key("Tab")} ${resourceView === "related"
            ? "All inspected tables"
            : "Related tables only"}`]),
        `${theme.key("M")} Map`,
        `${theme.key("N")} Rename`,
        `${theme.key("L")} Limits`,
        `${theme.key("W")} Model chat - create/edit Read + Action`,
        `${theme.key("Y")} ${safeActionAccessLabel(
          overview?.boundaries?.find((entry) => entry.selected)?.proposal_action_state,
          candidateActionAvailable,
          overview?.boundaries?.find((entry) => entry.selected)?.proposal_action_active_count,
        )}`,
        `${theme.key("T")} Ask plan check`,
        `${theme.key("O")} Model output [${modelOutputActionStatus}]`,
        `${theme.key("C")} ${overview?.discovery_concerns?.length ? "Inspect activation blocker" : focusedAccess ? "Review + activate" : "Complete review"}`,
        `${theme.key("Q")} Quit`,
      ];
      render([
        theme.title(
          focusedAccess
            ? `EDIT ACCESS - ${safeTerminalText(highlighted.candidate_boundary_name)}`
            : safeTerminalText(highlighted.candidate_boundary_name),
        ),
        `${overview?.discovery_concerns?.length ? theme.warning("DRAFT - ACTIVATION BLOCKED") : candidateStatus}  ${includedCount} ` +
          `${plural(includedCount, "table", "tables")}  ${displayedReviewLeft}`,
        ...discoveryReadinessLines(overview, theme),
        ...(selectedCompatibility ? [selectedCompatibility] : []),
        ...(() => {
          const boundaryName = highlighted.candidate_boundary_name;
          const mode = overview?.boundaries?.find((entry) => entry.name === boundaryName)
            ?.ask_intent_check_mode ?? "balanced";
          return mode === "boundary_only"
            ? [theme.warning("Local Ask plan check: BOUNDARY ONLY"), theme.dim(
              "Question-to-plan comparison is off; reviewed Explore validation remains active.",
            )]
            : [theme.success("Local Ask plan check: BALANCED")];
        })(),
        modelOutputStatus,
        ...modelGuidedSetupHint(theme),
        ...(candidateHasPendingChange
          ? [
            theme.warning("1 PENDING BOUNDARY CHANGE IS NOT ACTIVE"),
            theme.bold(overview?.discovery_concerns?.length
              ? `${theme.key("C")} shows why this saved update is not ready to activate.`
              : `${theme.key("C")} reviews and activates the exact disabled update.`),
          ]
          : []),
        ...(focusedAccess
          ? [
            theme.bold(
              resourceView === "related"
                ? `ADD RELATED TABLES (${listedResources.length})`
                : resourceView === "all"
                  ? `ALL INSPECTED TABLES (${listedResources.length} available to add)`
                : "TABLES IN THIS BOUNDARY",
            ),
            theme.dim(
              resourceView === "related"
                ? "Only tables connected by inspected foreign-key paths are shown."
                : resourceView === "all"
                  ? "This advanced view also includes tables unrelated to the current boundary."
                  : "Enter edits columns. A shows tables with proven paths into this boundary.",
            ),
            theme.bold(overview?.discovery_concerns?.length
              ? `${theme.key("C")} inspects the blocker before activation can be offered.`
              : `${theme.key("C")} reviews and activates this whole boundary once. No separate table sign-off.`),
          ]
          : [
            theme.bold(
              resourceView === "related"
                ? `ADD RELATED TABLES (${listedResources.length})`
                : resourceView === "all"
                  ? `ALL INSPECTED TABLES (${listedResources.length} available to add)`
                : "TABLES",
            ),
            `${theme.key("P")} Explain what this table sign-off covers`,
            theme.dim(
              `One S sign-off records ${highlighted.risk_count} exact ` +
              `${plural(highlighted.risk_count, "decision", "decisions")} together.`,
            ),
          ]),
        "",
        ...visible.map((resource, index) => {
          const absolute = start + index;
          const state = focusedAccess
            ? focusedAccessResourceState(resource, theme)
            : resourceState(resource, theme);
          const connection = resourceView === "related"
            ? bestBoundaryRelationshipConnection(resource, boundaryResources)
            : undefined;
          const connectionText = connection
            ? `  [linked to ${safeTerminalText(boundaryEndpoint(connection, boundaryResources))}]`
            : "";
          const line = `${absolute === selected ? ">" : " "} ${safeTerminalText(resource.resource_id)}  ` +
            `${state.text}${connectionText}`;
          return absolute === selected
            ? theme.focus(line)
            : `${absolute === selected ? ">" : " "} ${safeTerminalText(resource.resource_id)}  ` +
              `${state.style(state.text)}${theme.dim(connectionText)}`;
        }),
        ...(below > 0 || start > 0
          ? [
            theme.dim(
              `Showing ${start + 1}-${end} of ${listedResources.length}. ` +
              (below > 0
                ? `${theme.key("Down")} shows ${below} more ${plural(below, "table", "tables")} below.`
                : "Up returns to earlier tables."),
            ),
          ]
          : []),
        ...(resourceView === "related"
          ? relationshipConnectionDetail(highlighted, boundaryResources, theme)
          : []),
        ...(highlighted.scope_resolution_guidance
          ? [
              "",
              theme.danger("Why this table is unavailable"),
              ...highlighted.scope_resolution_guidance.why.map((line) =>
                `  - ${safeTerminalText(line)}`),
              theme.bold("What makes it addable"),
              ...highlighted.scope_resolution_guidance.remediation.map((line) =>
                `  - ${safeTerminalText(line)}`),
            ]
          : highlighted.status !== "draft_read"
            && highlighted.derived_tenant_scope?.candidates.length
            ? [
                "",
                theme.success("Proven tenant scope is available"),
                ...highlighted.derived_tenant_scope.candidates.slice(0, 3).flatMap((scope) => {
                  const depth = derivedScopeDepth(scope);
                  const reviewedMaximum = highlighted.reviewed_max_derived_scope_hops ?? 2;
                  const joinColumns = formatDerivedScopeJoinColumns(scope);
                  return [
                    `  ${theme.success(`Tenant scope available (${depth} ${plural(depth, "hop", "hops")})`)}`,
                    `    ${safeTerminalText(formatDerivedScopePath(scope))}`,
                    ...(joinColumns
                      ? [`    via columns: ${safeTerminalText(joinColumns)}`]
                      : []),
                    `    ${theme.dim(`path ID: ${safeTerminalText(scope.path_id)}`)}`,
                    ...(depth > reviewedMaximum
                      ? [theme.warning(
                          `    needs max_derived_scope_hops ${depth} (currently ${reviewedMaximum})`,
                        )]
                      : []),
                  ];
                }),
                theme.dim("Press Enter to review the exact path; no authority changes until activation."),
              ]
            : []),
        ...(options?.notice
          ? [
              "",
              ...formatBoundaryAccessNotice(theme, options.notice),
            ]
          : []),
        ...(actionNotice ? ["", theme.warning(actionNotice)] : []),
        "",
        theme.bold("SELECTED TABLE"),
        ...packTerminalActions(selectedTableActions, actionWidth),
        theme.bold("BOUNDARY"),
        ...packTerminalActions(boundaryActions, actionWidth),
        theme.dim("Edits stay disabled until separate activation."),
        ...(confirmExactModelOutput ? exactModelOutputConfirmationLines(theme) : []),
      ]);
      const key = await nextKey();
      if (confirmExactModelOutput) {
        const decision = exactModelOutputConfirmationDecision(key);
        if (decision === "accept") {
          return { action: "model_output", exact_metadata_confirmed: true };
        }
        if (decision === "cancel") {
          confirmExactModelOutput = false;
          actionNotice = "Model output [SEMANTIC] is unchanged; exact hashes remain operator-only.";
        }
        continue;
      }
      if (isEscapeKey(key)) {
        if (resourceView !== "boundary" && boundaryResources.length) {
          resourceView = "boundary";
          selected = 0;
        } else {
          showBoundaryList = true;
        }
        continue;
      }
      if (isCancel(key)) return undefined;
      if (key.name === "m") {
        showMap = true;
        showMapDetails = false;
        mapOffset = Math.max(0, selected - 2);
        continue;
      }
      if (key.name === "p") {
        if (focusedAccess && selectedIncluded) {
          return { resource_id: highlighted.resource_id, action: "privacy" };
        }
        if (focusedAccess) {
          actionNotice = "P is unavailable until this table is added to the draft boundary.";
          continue;
        }
        showReviewItems = true;
        continue;
      }
      if (key.name === "g" && focusedAccess && selectedIncluded) {
        return { resource_id: highlighted.resource_id, action: "analytics" };
      }
      if (key.name === "g" && focusedAccess) {
        actionNotice = "G is unavailable until this table is added to the draft boundary.";
        continue;
      }
      if (key.name === "j" && selectedIncluded) {
        return { resource_id: highlighted.resource_id, action: "relationships" };
      }
      if (key.name === "j") {
        actionNotice = "J is unavailable until this table is added to the draft boundary.";
        continue;
      }
      if (key.name === "i" && focusedAccess && selectedIncluded) {
        return { resource_id: highlighted.resource_id, action: "metadata" };
      }
      if (key.name === "i" && focusedAccess) {
        actionNotice = "I is unavailable until this table is added to the draft boundary.";
        continue;
      }
      if (key.name === "n") return { action: "rename" };
      if (key.name === "l") return { action: "limits" };
      if (key.name === "w") return { action: "workloads" };
      if (key.name === "y") {
        if (candidateActionAvailable) {
          return {
            action: "actions",
            boundary_name: highlighted.candidate_boundary_name,
          };
        }
        actionNotice = "Finish this exact read review first. Proposal drafting can begin before read activation.";
        continue;
      }
      if (key.name === "t") {
        return { action: "intent_check", boundary_name: highlighted.candidate_boundary_name };
      }
      if (key.name === "o") {
        if (modelOutputMode === "semantic") {
          confirmExactModelOutput = true;
          actionNotice = undefined;
          continue;
        }
        return { action: "model_output" };
      }
      if (key.name === "c") return { action: "confirm" };
      if (key.name === "a" && resourceView === "boundary") {
        resourceView = "related";
        selected = 0;
        continue;
      }
      if (key.name === "tab" && resourceView !== "boundary") {
        resourceView = resourceView === "related" ? "all" : "related";
        selected = 0;
        continue;
      }
      if (isBackKey(key)) {
        if (resourceView !== "boundary" && boundaryResources.length) {
          resourceView = "boundary";
          selected = 0;
        } else {
          showBoundaryList = true;
        }
        continue;
      }
      if (key.name === "up") {
        selected = (selected - 1 + listedResources.length) % listedResources.length;
        actionNotice = undefined;
      }
      if (key.name === "down") {
        selected = (selected + 1) % listedResources.length;
        actionNotice = undefined;
      }
      if (key.name === "r" && highlighted.included) {
        return { resource_id: highlighted.resource_id, action: "remove" };
      }
      if (key.name === "r") {
        actionNotice = "R is unavailable: this table is not in the draft boundary.";
        continue;
      }
      if (!focusedAccess && key.name === "s" && highlighted.included) {
        return { resource_id: highlighted.resource_id, action: "signoff" };
      }
      if (key.name === "s") {
        actionNotice = focusedAccess
          ? "S is not used in this editor. Press C to review and activate the whole boundary."
          : "S is unavailable until this table is added to the draft boundary.";
        continue;
      }
      if (key.name === "return" || key.name === "enter") {
        return {
          resource_id: highlighted.resource_id,
          action: resourceView === "boundary" ? "review" : "add",
        };
      }
    }
  });
}

function relationshipPathActionStatus(resource: BoundaryResourceReviewSummary): string {
  const available = resource.relationships.filter((relationship) =>
    relationship.state === "available").length;
  const reviewed = resource.relationships.length - available;
  if (available > 0) return `${reviewed} REVIEWED, ${available} AVAILABLE`;
  if (reviewed > 0) return `${reviewed} REVIEWED`;
  return "NONE FOUND";
}

async function editRelationshipPaths(
  view: BoundaryResourceReviewView,
  summary: BoundaryResourceReviewSummary,
  input: ReadStream,
  output: WriteStream,
): Promise<BoundaryRelationshipPathEditResult> {
  const generated = [...(view.generated_candidate?.relationships ?? [])].sort((left, right) =>
    (left.path_depth ?? 1) - (right.path_depth ?? 1)
      || left.target_resource.localeCompare(right.target_resource)
      || left.id.localeCompare(right.id));
  const candidateIds = new Set(view.candidate?.relationships.map((relationship) =>
    relationship.id) ?? []);
  const stateById = new Map(summary.relationships.map((relationship) => [
    relationship.relationship_id,
    relationship.state,
  ]));
  const includedResources = new Set(view.included_resource_ids ?? [view.resource_id]);
  const reviewedMaximum = view.reviewed_budgets?.max_analysis_relationship_hops
    ?? view.reviewed_budgets?.max_relationship_hops
    ?? 2;
  const theme = terminalTheme(output.isTTY && !("NO_COLOR" in process.env), {
    brand: true,
  });
  let selected = 0;
  let showIds = false;
  let actionNotice: string | undefined;

  return withRawKeys(input, output, async (nextKey, render) => {
    while (true) {
      if (!generated.length) {
        render([
          theme.title(`RELATIONSHIP PATHS - ${safeTerminalText(view.resource_id)}`),
          "No catalog-proven many-to-one analysis path is available from this table.",
          theme.dim("Runner never infers joins from similar names or lets the model author a path."),
          "",
          `${theme.key("B/Esc/Q")} Back to boundary tables`,
        ]);
        const key = await nextKey();
        if (isCancel(key) || isBackKey(key) || isEscapeKey(key)) return "back";
        continue;
      }

      selected = Math.min(selected, generated.length - 1);
      const start = boundedWindowStart(selected, generated.length, 7);
      const visible = generated.slice(start, start + 7);
      const selectedRelationship = generated[selected]!;
      const selectedState = relationshipPathEditorState({
        relationship: selectedRelationship,
        candidateIds,
        stateById,
        includedResources,
        reviewedMaximum,
      });
      const selectedDisplay = relationshipPathDisplay(view.resource_id, selectedRelationship);
      const selectedJoinColumns = formatRelationshipJoinColumns(selectedDisplay);

      render([
        theme.title(`REVIEW RELATIONSHIP PATHS - ${safeTerminalText(view.resource_id)}`),
        `Analysis-path depth limit: ${reviewedMaximum} proven ${plural(reviewedMaximum, "hop", "hops")}.`,
        theme.dim(
          "The limit makes a path eligible. Each exact path below still requires human review and separate activation.",
        ),
        "",
        ...visible.map((relationship, index) => {
          const absolute = start + index;
          const state = relationshipPathEditorState({
            relationship,
            candidateIds,
            stateById,
            includedResources,
            reviewedMaximum,
          });
          const display = relationshipPathDisplay(view.resource_id, relationship);
          const line = `${absolute === selected ? ">" : " "} ` +
            `[${state.label}] ${relationship.path_depth ?? 1} ` +
            `${plural(relationship.path_depth ?? 1, "hop", "hops")}  ` +
            safeTerminalText(formatRelationshipPath(display));
          if (absolute === selected) return theme.focus(line);
          if (state.kind === "active" || state.kind === "included") return theme.success(line);
          if (state.kind === "available" || state.kind === "pending_removal") return theme.warning(line);
          return theme.dim(line);
        }),
        ...(generated.length > visible.length
          ? [theme.dim(
              `Showing ${start + 1}-${start + visible.length} of ${generated.length}. Use Up/Down for the rest.`,
            )]
          : []),
        "",
        theme.bold("SELECTED PATH"),
        `  ${safeTerminalText(formatRelationshipPath(selectedDisplay))}`,
        ...(selectedJoinColumns
          ? [`  via columns: ${safeTerminalText(selectedJoinColumns)}`]
          : []),
        `  state: ${relationshipPathStateStyled(selectedState, theme)}`,
        ...(selectedState.missingResources.length
          ? [`  add first: ${selectedState.missingResources.map(safeTerminalText).join(", ")}`]
          : []),
        ...(showIds
          ? [`  ${theme.dim(`path ID: ${safeTerminalText(selectedRelationship.id)}`)}`]
          : []),
        ...(actionNotice ? ["", theme.warning(actionNotice)] : []),
        "",
        `${theme.key("Up/Down")} Select   ${theme.key("Enter")} ${selectedState.actionLabel}   ` +
          `${theme.key("D")} ${showIds ? "Hide" : "Show"} path ID`,
        `${theme.key("B/Esc/Q")} Back to boundary tables`,
        theme.dim("No active authority changes here. Press C later to review and activate the disabled boundary."),
      ]);

      const key = await nextKey();
      if (isCancel(key) || isBackKey(key) || isEscapeKey(key)) return "back";
      if (key.name === "up") {
        selected = (selected - 1 + generated.length) % generated.length;
        actionNotice = undefined;
        continue;
      }
      if (key.name === "down") {
        selected = (selected + 1) % generated.length;
        actionNotice = undefined;
        continue;
      }
      if (key.name === "d") {
        showIds = !showIds;
        continue;
      }
      if (key.name !== "return" && key.name !== "enter") continue;
      if (selectedState.missingResources.length) {
        actionNotice = `Add ${selectedState.missingResources.join(", ")} to this boundary first.`;
        continue;
      }
      if (selectedState.depthExceeded) {
        actionNotice = `Raise Analysis-path depth to ${selectedRelationship.path_depth ?? 1} under L Limits first.`;
        continue;
      }
      return {
        relationship_id: selectedRelationship.id,
        action: candidateIds.has(selectedRelationship.id) ? "remove" : "add",
      };
    }
  });
}

type RelationshipPathEditorState = {
  kind: "active" | "included" | "available" | "pending_removal" | "missing_tables" | "over_depth";
  label: string;
  actionLabel: string;
  missingResources: string[];
  depthExceeded: boolean;
};

function relationshipPathEditorState(input: {
  relationship: NonNullable<BoundaryResourceReviewView["generated_candidate"]>["relationships"][number];
  candidateIds: ReadonlySet<string>;
  stateById: ReadonlyMap<string, BoundaryResourceReviewSummary["relationships"][number]["state"]>;
  includedResources: ReadonlySet<string>;
  reviewedMaximum: number;
}): RelationshipPathEditorState {
  const requiredResources = relationshipPathRequiredResources(input.relationship);
  const missingResources = requiredResources.filter((resource) =>
    !input.includedResources.has(resource));
  const depthExceeded = (input.relationship.path_depth ?? 1) > input.reviewedMaximum;
  const inCandidate = input.candidateIds.has(input.relationship.id);
  const active = input.stateById.get(input.relationship.id) === "active";
  if (inCandidate && active) {
    return {
      kind: "active",
      label: "ACTIVE",
      actionLabel: "Review removal",
      missingResources,
      depthExceeded,
    };
  }
  if (inCandidate) {
    return {
      kind: "included",
      label: "IN DRAFT",
      actionLabel: "Remove from draft",
      missingResources,
      depthExceeded,
    };
  }
  if (active) {
    return {
      kind: "pending_removal",
      label: "ACTIVE; REMOVED IN DRAFT",
      actionLabel: "Restore to draft",
      missingResources,
      depthExceeded,
    };
  }
  if (missingResources.length) {
    return {
      kind: "missing_tables",
      label: "ADD TABLES FIRST",
      actionLabel: "Unavailable",
      missingResources,
      depthExceeded,
    };
  }
  if (depthExceeded) {
    return {
      kind: "over_depth",
      label: `NEEDS DEPTH ${input.relationship.path_depth ?? 1}`,
      actionLabel: "Unavailable",
      missingResources,
      depthExceeded,
    };
  }
  return {
    kind: "available",
    label: "AVAILABLE",
    actionLabel: "Review and add",
    missingResources,
    depthExceeded,
  };
}

function relationshipPathStateStyled(
  state: RelationshipPathEditorState,
  theme: TerminalTheme,
): string {
  if (state.kind === "active" || state.kind === "included") return theme.success(state.label);
  if (state.kind === "available" || state.kind === "pending_removal") {
    return theme.warning(state.label);
  }
  return theme.danger(state.label);
}

function relationshipPathDisplay(
  sourceResource: string,
  relationship: NonNullable<BoundaryResourceReviewView["generated_candidate"]>["relationships"][number],
) {
  return {
    source_resource: sourceResource,
    target_resource: relationship.target_resource,
    links: relationship.proof?.links,
  };
}

function relationshipPathRequiredResources(
  relationship: NonNullable<BoundaryResourceReviewView["generated_candidate"]>["relationships"][number],
): string[] {
  return [...new Set([
    relationship.target_resource,
    ...(relationship.proof?.links ?? []).flatMap((link) => [
      link.source_resource,
      link.target_resource,
    ]),
  ])].sort();
}

async function editFieldTiers(
  view: BoundaryResourceReviewView,
  options: {
    focusedAccess?: boolean;
    initialTiers?: Record<string, BoundaryFieldTier>;
  } | undefined,
  input: ReadStream,
  output: WriteStream,
): Promise<BoundaryFieldTierEditResult> {
  if (!view.candidate && !view.generated_candidate) {
    throw new Error(
      `${view.resource_id} is blocked because its record identity or trusted scope is unresolved. ` +
      "Resolve only source-proven identity and scope candidates before reviewing column access.",
    );
  }
  const fields = [...view.fields].sort((left, right) => left.name.localeCompare(right.name));
  if (!fields.length) throw new Error(`${view.resource_id} has no inspected columns.`);
  const tiers = Object.fromEntries(fields.map((field) => [
    field.name,
    options?.initialTiers?.[field.name] ?? currentFieldTier(view, field.name),
  ])) as Record<string, BoundaryFieldTier>;
  const theme = terminalTheme(output.isTTY && !("NO_COLOR" in process.env), {
    brand: true,
  });
  let selected = 0;
  let showMap = false;
  let showMapDetails = false;
  let actionNotice: string | undefined;
  return withRawKeys<BoundaryFieldTierEditResult>(input, output, async (nextKey, render) => {
    while (true) {
      if (showMap) {
        const width = Math.max(36, terminalContentWidth(output.columns));
        render([
          ...boundaryResourceMapLines(
            view,
            tiers,
            theme,
            "synapsor-runner",
            width,
            showMapDetails,
          ),
          "",
          `${theme.key("D")} ${showMapDetails ? "Hide" : "Show"} exact details   ` +
            `${theme.key("B/Esc")} Back to columns   ${theme.key("Q")} Quit`,
        ]);
        const key = await nextKey();
        if (key.name === "backspace" || (key.name === "b" && key.sequence === "b")) return "back";
        if (key.name === "m" || isBackKey(key) || key.name === "return" || key.name === "enter") {
          showMap = false;
          continue;
        }
        if (key.name === "d") {
          showMapDetails = !showMapDetails;
          continue;
        }
        if (isCancel(key)) return undefined;
        continue;
      }
      const highlighted = fields[selected]!;
      const enumValues = reviewableEnumValues(view, highlighted);
      const reviewedEnumValues = enumValues
        ? currentReviewedEnumValues(view, highlighted, enumValues)
        : undefined;
      const operationRepairAvailable = (view.operation_repair_fields ?? []).includes(highlighted.name)
        && tiers[highlighted.name] !== "kept_out";
      const exactNumericGroupingEligibility = view.exact_numeric_grouping_eligibility?.[highlighted.name];
      const exactNumericGroupingEnabled = Boolean(
        highlighted.exact_numeric_grouping_review_override
        && (view.candidate ?? view.generated_candidate)?.groupable_fields.includes(highlighted.name),
      );
      const generatedGroupingAlreadyAvailable = Boolean(
        view.generated_candidate?.groupable_fields.includes(highlighted.name),
      );
      const exactNumericGroupingAvailable = tiers[highlighted.name] !== "kept_out"
        && (exactNumericGroupingEnabled
          || (exactNumericGroupingEligibility?.eligible && !generatedGroupingAlreadyAvailable));
      const selectedTier = tiers[highlighted.name]!;
      const metadataStatus = highlighted.metadata_review_override?.label
        || highlighted.metadata_review_override?.description
        ? "SET"
        : "NOT SET";
      const enumStatus = enumValues
        ? `${reviewedEnumValues!.length}/${enumValues.length} REVIEWED`
        : "UNAVAILABLE";
      const operationRepairStatus = operationRepairAvailable
        ? "AVAILABLE"
        : selectedTier === "kept_out"
          ? "UNAVAILABLE WHILE KEPT OUT"
          : "NOT NEEDED";
      const exactNumericGroupingStatus = exactNumericGroupingEnabled
        ? "ON"
        : generatedGroupingAlreadyAvailable
          ? "ALREADY GROUPABLE"
          : exactNumericGroupingAvailable
            ? "OFF"
            : "UNAVAILABLE";
      const tableWidth = Math.max(36, terminalContentWidth(output.columns));
      const accessLayout = fieldAccessLayout(tableWidth);
      const reviewCompatibility = databaseCompatibilityLine(view.database_server_compatibility, theme);
      const vocabularyCoverage = exploreVocabularyCoverage(
        (view.candidate ?? view.generated_candidate)!,
      );
      const vocabularyGaps = [
        ...(vocabularyCoverage.opaque_resource_without_vocabulary ? ["table name"] : []),
        ...vocabularyCoverage.opaque_fields_without_vocabulary,
      ];
      const minimumCohort = (view.candidate ?? view.generated_candidate)!.minimum_cohort_size;
      const principalScope = (view.candidate ?? view.generated_candidate)!.principal_key
        ?? ((view.candidate ?? view.generated_candidate)!.principal_scope
          ? formatDerivedScopePath((view.candidate ?? view.generated_candidate)!.principal_scope!)
          : (view.candidate ?? view.generated_candidate)!.rls_session?.principal_setting
            ? "reviewed PostgreSQL RLS"
            : "not configured");
      const primaryActions = [
        `${theme.key("Up/Down")} Navigate`,
        `${theme.key("Left/Right/Space")} Change access [${tierLabel(selectedTier)}]`,
        `${theme.key("Enter")} ${options?.focusedAccess ? "Save draft choices" : "Continue to table sign-off"}`,
        `${theme.key("V")} Model + Runner${selectedTier === "visible" ? " [CURRENT]" : ""}`,
        `${theme.key("W")} Runner output only${selectedTier === "withheld_from_model" ? " [CURRENT]" : ""}`,
        `${theme.key("K")} Keep out completely${selectedTier === "kept_out" ? " [CURRENT]" : ""}`,
        `${theme.key("M")} View access map`,
        `${theme.key("B/Esc")} ${options?.focusedAccess ? "Back to boundary tables" : "Back"}`,
        `${theme.key("Q")} Quit`,
      ];
      const reviewActions = [
        `${theme.key("P")} Privacy - withhold groups below ${minimumCohort} ` +
          `[${minimumCohort === 1 ? "OFF" : `MIN ${minimumCohort}`}]`,
        `${theme.key("O")} User/owner scope - restrict rows per user [${principalScope}]`,
        `${theme.key("I")} Column vocabulary - edit its label and description [${metadataStatus}]`,
        `${theme.key("E")} Allowed values - narrow filtering/grouping to reviewed values [${enumStatus}]`,
        `${theme.key("S")} Add operations - apply inspected filter/sort/group/measure suggestions [${operationRepairStatus}]`,
        `${theme.key("X")} Exact-value groups - group by each distinct value [${exactNumericGroupingStatus}]`,
      ];
      const terminalRows = typeof output.rows === "number" && Number.isFinite(output.rows)
        ? Math.max(1, Math.floor(output.rows))
        : undefined;
      const detailedContext = terminalRows === undefined || terminalRows >= 30;
      const contextLines = [
        ...(reviewCompatibility ? [reviewCompatibility] : []),
        ...(vocabularyGaps.length > 0
          ? [
            theme.warning(`REVIEWED MODEL VOCABULARY REQUIRED: ${vocabularyGaps.join(", ")}`),
            ...(detailedContext
              ? [theme.dim(
                "Add field vocabulary here with I. Use I on the boundary table list for the table label or description. Exact database IDs remain the plan authority.",
              )]
              : []),
          ]
          : []),
        ...(vocabularyCoverage.coded_fields_without_vocabulary.length > 0
          ? [
            theme.warning(
              `REVIEWED MODEL VOCABULARY ADVISED: coded value fields ${vocabularyCoverage.coded_fields_without_vocabulary.join(", ")}`,
            ),
            ...(detailedContext
              ? [theme.dim(
                "Activation remains available, but clients are told not to infer business meaning from codes such as P1 or W2. Press I to add a reviewed label or description.",
              )]
              : []),
          ]
          : []),
      ];
      const fullHeader = [
        theme.title(`REVIEW COLUMNS - ${safeTerminalText(view.resource_id)}`),
        ...packTerminalActions(primaryActions, tableWidth),
        ...packTerminalActions(reviewActions, tableWidth),
        ...contextLines,
        "Space cycles: MODEL + RUNNER -> RUNNER ONLY -> KEPT OUT",
      ];
      const compactHeader = [
        theme.title(`REVIEW COLUMNS - ${safeTerminalText(view.resource_id)}`),
        ...packTerminalActions([
          `${theme.key("Up/Down")} Navigate`,
          `${theme.key("Left/Right/Space")} Access [${tierLabel(selectedTier)}]`,
          `${theme.key("Enter")} Save`,
          `${theme.key("V")} Model${selectedTier === "visible" ? " [CURRENT]" : ""}`,
          `${theme.key("W")} Runner only${selectedTier === "withheld_from_model" ? " [CURRENT]" : ""}`,
          `${theme.key("K")} Keep out${selectedTier === "kept_out" ? " [CURRENT]" : ""}`,
          `${theme.key("M")} Map`,
          `${theme.key("P")} Privacy [${minimumCohort === 1 ? "OFF" : `MIN ${minimumCohort}`}]`,
          `${theme.key("O")} User/owner rows [${principalScope === "not configured" ? "OFF" : "SET"}]`,
          `${theme.key("I")} Label/describe [${metadataStatus}]`,
          `${theme.key("E")} Allowed values [${enumStatus}]`,
          `${theme.key("S")} Add operations [${operationRepairStatus}]`,
          `${theme.key("X")} Exact-value groups [${exactNumericGroupingStatus}]`,
          `${theme.key("B/Esc")} ${options?.focusedAccess ? "Back to tables" : "Back"}`,
          `${theme.key("Q")} Quit`,
        ], tableWidth),
      ];
      const fullFooter = [
        "",
        theme.bold(`Selected access: ${tierLabel(tiers[highlighted.name]!)}`),
        theme.dim(
          `Selected column: ${safeTerminalText(highlighted.name)} · ` +
          `${safeTerminalText(highlighted.data_type)} · ${compactRiskBadge(view, highlighted)}`,
        ),
        isTrustedScopeField(view, highlighted.name)
          ? theme.scope(trustedScopeTierConsequence(tiers[highlighted.name]!))
          : styleTierConsequence(theme, tiers[highlighted.name]!),
        ...(operationRepairAvailable
          ? [theme.warning(
              "Optional operations available: this returned field has no analytical grants; the inspected draft has suggestions you may review.",
            )]
          : []),
        ...(actionNotice ? [theme.warning(actionNotice)] : []),
        theme.dim(
          options?.focusedAccess
            ? "Enter stages these choices in the disabled boundary. Final activation is one separate confirmation."
            : "Enter continues to one plain-language table sign-off. Nothing activates from this screen.",
        ),
      ];
      const compactFooter = [
        theme.bold(
          `Selected: ${safeTerminalText(highlighted.name)} · ${safeTerminalText(highlighted.data_type)} · ` +
          tierLabel(tiers[highlighted.name]!),
        ),
        actionNotice
          ? theme.warning(actionNotice)
          : theme.dim(options?.focusedAccess
            ? "Draft only; activate separately after saving."
            : "Nothing activates from this screen."),
      ];
      const buildFrame = (windowSize: number, compact: boolean) => {
        const start = boundedWindowStart(selected, fields.length, windowSize);
        const visible = fields.slice(start, start + windowSize);
        const tableLines = visible.map((field, index) => {
          const absolute = start + index;
          const tier = tiers[field.name]!;
          const tierText = `[${tierLabel(tier)}]`;
          const line = `${absolute === selected ? ">" : " "} ${fieldAccessRow(
            safeTerminalText(field.name),
            safeTerminalText(field.data_type),
            tierText,
            compactRiskBadge(view, field),
            accessLayout,
          )}`;
          return absolute === selected
            ? theme.focus(line)
            : line.replace(tierText, styleTier(theme, tier, tierText));
        });
        return [
          ...(compact ? compactHeader : fullHeader),
          "",
          ...(compact
            ? []
            : [theme.bold(fieldAccessRow("COLUMN", "TYPE", "ACCESS", "REVIEW NOTE", accessLayout))]),
          ...tableLines,
          ...(visible.length < fields.length
            ? [theme.dim(
              `Showing columns ${start + 1}-${start + visible.length} of ${fields.length}; Up/Down moves the selection.`,
            )]
            : []),
          ...(compact ? compactFooter : fullFooter),
        ];
      };
      let windowSize = Math.min(12, fields.length);
      let frame = buildFrame(windowSize, false);
      while (terminalRows !== undefined
        && terminalFrameRows(frame, tableWidth) > terminalRows
        && windowSize > 1) {
        windowSize -= 1;
        frame = buildFrame(windowSize, false);
      }
      if (terminalRows !== undefined && terminalFrameRows(frame, tableWidth) > terminalRows) {
        windowSize = Math.min(12, fields.length);
        frame = buildFrame(windowSize, true);
        while (terminalFrameRows(frame, tableWidth) > terminalRows && windowSize > 1) {
          windowSize -= 1;
          frame = buildFrame(windowSize, true);
        }
      }
      render(frame);
      const key = await nextKey();
      if (isBackToResources(key)) return "back";
      if (isCancel(key)) return undefined;
      if (key.name === "m") {
        showMap = true;
        showMapDetails = false;
        continue;
      }
      if (key.name === "p") return "privacy";
      if (key.name === "o") return { action: "principal", tiers: { ...tiers } };
      if (key.name === "i") {
        return {
          action: "metadata",
          field: highlighted.name,
          tiers: { ...tiers },
        };
      }
      if (key.name === "s" && operationRepairAvailable) {
        return {
          action: "restore_operations",
          field: highlighted.name,
          tiers: { ...tiers },
        };
      }
      if (key.name === "s") {
        actionNotice = selectedTier === "kept_out"
          ? "S is unavailable while this column is kept out. Press V or W first."
          : "S is not needed: this column has no missing inspected analytical grants.";
        continue;
      }
      if (key.name === "x" && exactNumericGroupingAvailable) {
        return {
          action: "exact_numeric_grouping",
          field: highlighted.name,
          enabled: !exactNumericGroupingEnabled,
          tiers: { ...tiers },
        };
      }
      if (key.name === "x") {
        const reason = exactNumericGroupingEligibility?.reasons[0];
        actionNotice = generatedGroupingAlreadyAvailable
          ? "X is not needed: this column is already a reviewed grouping dimension."
          : selectedTier === "kept_out"
            ? "X is unavailable while this column is kept out. Press V or W first."
            : `X is unavailable for this column${reason ? `: ${safeTerminalText(reason)}` : "."}`;
        continue;
      }
      if (key.name === "e" && enumValues) {
        return {
          action: "enum",
          field: highlighted.name,
          tiers: { ...tiers },
        };
      }
      if (key.name === "e") {
        actionNotice = "E is unavailable: this column has no database-declared reviewed value list.";
        continue;
      }
      if (key.name === "up") {
        selected = (selected - 1 + fields.length) % fields.length;
        actionNotice = undefined;
      }
      if (key.name === "down") {
        selected = (selected + 1) % fields.length;
        actionNotice = undefined;
      }
      if (key.name === "space" || key.name === "right") {
        tiers[highlighted.name] = cycleTier(tiers[highlighted.name]!, 1);
        actionNotice = undefined;
      }
      if (key.name === "left") {
        tiers[highlighted.name] = cycleTier(tiers[highlighted.name]!, -1);
        actionNotice = undefined;
      }
      if (key.name === "v") {
        tiers[highlighted.name] = "visible";
        actionNotice = undefined;
      }
      if (key.name === "w") {
        tiers[highlighted.name] = "withheld_from_model";
        actionNotice = undefined;
      }
      if (key.name === "k") {
        tiers[highlighted.name] = "kept_out";
        actionNotice = undefined;
      }
      if (key.name === "return" || key.name === "enter") return tiers;
    }
  });
}

async function editFieldEnumValues(
  view: BoundaryResourceReviewView,
  fieldName: string,
  input: ReadStream,
  output: WriteStream,
): Promise<BoundaryFieldEnumEditResult> {
  const field = view.fields.find((candidate) => candidate.name === fieldName);
  const schemaValues = field ? reviewableEnumValues(view, field) : undefined;
  if (!field || !schemaValues) {
    throw new Error(`${view.resource_id}.${fieldName} has no reviewed database-declared value list.`);
  }
  const selectedValues = new Set(currentReviewedEnumValues(view, field, schemaValues));
  const theme = terminalTheme(output.isTTY && !("NO_COLOR" in process.env), {
    brand: true,
  });
  let selected = 0;
  return withRawKeys(input, output, async (nextKey, render) => {
    while (true) {
      const start = boundedWindowStart(selected, schemaValues.length, 12);
      const visible = schemaValues.slice(start, start + 12);
      render([
        theme.title(`REVIEW ALLOWED VALUES - ${safeTerminalText(view.resource_id)}.${safeTerminalText(fieldName)}`),
        "Runner learned this complete list from database schema metadata. No source rows were sampled.",
        "The AI may filter or group only by checked values. Removed values are refused even if guessed.",
        "Selecting none disables filtering and grouping for this column; it does not enable free-text access.",
        "",
        `${theme.key("Up/Down")} Navigate   ${theme.key("Space")} Toggle value   ` +
          `${theme.key("A")} Keep all   ${theme.key("N")} Keep none`,
        `${theme.key("Enter")} Save allowed values and return to columns   ` +
          `${theme.key("B/Esc")} Back without saving   ${theme.key("Q")} Quit`,
        "",
        ...visible.map((value, index) => {
          const absolute = start + index;
          const line = `${absolute === selected ? ">" : " "} ` +
            `[${selectedValues.has(value) ? "x" : " "}] ${safeTerminalText(value)}`;
          return absolute === selected ? theme.focus(line) : line;
        }),
        "",
        theme.bold(`${selectedValues.size} of ${schemaValues.length} values kept`),
      ]);
      const key = await nextKey();
      if (isBackToResources(key)) return "back";
      if (isCancel(key)) return undefined;
      if (key.name === "up") selected = (selected - 1 + schemaValues.length) % schemaValues.length;
      if (key.name === "down") selected = (selected + 1) % schemaValues.length;
      if (key.name === "space") {
        const value = schemaValues[selected]!;
        if (selectedValues.has(value)) selectedValues.delete(value);
        else selectedValues.add(value);
      }
      if (key.name === "a") schemaValues.forEach((value) => selectedValues.add(value));
      if (key.name === "n") selectedValues.clear();
      if (key.name === "return" || key.name === "enter") {
        return schemaValues.filter((value) => selectedValues.has(value));
      }
    }
  });
}

function reviewableEnumValues(
  view: BoundaryResourceReviewView,
  field: BoundaryResourceReviewView["fields"][number],
): string[] | undefined {
  const candidate = view.candidate ?? view.generated_candidate;
  if (!candidate || !field.enum_values?.length) return undefined;
  const generatedEnum = Object.hasOwn(candidate.field_enums, field.name);
  if (!generatedEnum && !field.enum_review_override) return undefined;
  return [...field.enum_values];
}

function currentReviewedEnumValues(
  view: BoundaryResourceReviewView,
  field: BoundaryResourceReviewView["fields"][number],
  schemaValues: string[],
): string[] {
  const candidate = view.candidate ?? view.generated_candidate;
  if (Object.hasOwn(candidate?.field_enums ?? {}, field.name)) {
    return [...(candidate?.field_enums[field.name] ?? [])];
  }
  return field.enum_review_override ? [] : [...schemaValues];
}

function currentFieldTier(view: BoundaryResourceReviewView, field: string): BoundaryFieldTier {
  const candidate = view.candidate ?? view.generated_candidate;
  return reviewedBoundaryFieldTier(candidate, field);
}

function cycleTier(current: BoundaryFieldTier, direction: 1 | -1): BoundaryFieldTier {
  const index = tierOrder.indexOf(current);
  return tierOrder[(index + direction + tierOrder.length) % tierOrder.length]!;
}

function tierLabel(tier: BoundaryFieldTier): string {
  if (tier === "withheld_from_model") return "RUNNER ONLY";
  if (tier === "kept_out") return "KEPT OUT";
  return "MODEL + RUNNER";
}

function tierConsequence(tier: BoundaryFieldTier): string {
  if (tier === "visible") {
    return "Model + Runner: reviewed values appear locally and may be sent to the configured model; re-including a kept-out field restores its current inspected operation suggestions.";
  }
  if (tier === "withheld_from_model") {
    return "Raw values: Runner only. Moving a field here removes model analysis grants in the disabled draft; selected cells get unlinkable placeholders. Existing reviewed grants remain until revised and activated. Use Kept out to exclude the field entirely.";
  }
  return "Kept out: the field cannot be selected, filtered, sorted, grouped, joined, or aggregated.";
}

function trustedScopeTierConsequence(tier: BoundaryFieldTier): string {
  if (tier === "visible") {
    return "Fixed trusted scope. Runner injects it outside model arguments; the reviewed value may be sent to the model.";
  }
  if (tier === "withheld_from_model") {
    return "Fixed trusted scope. Runner shows it locally; the model gets a response-local token.";
  }
  return "Fixed trusted scope. The value is unavailable in results, but Runner still injects it into the row predicate.";
}

export function formatBoundaryResourceMap(
  view: BoundaryResourceReviewView,
  options: {
    color?: boolean;
    commandName?: string;
    columns?: number;
    details?: boolean;
  } = {},
): string {
  const tiers = Object.fromEntries(view.fields.map((field) => [
    field.name,
    currentFieldTier(view, field.name),
  ])) as Record<string, BoundaryFieldTier>;
  const width = Math.max(36, terminalContentWidth(options.columns));
  const lines = boundaryResourceMapLines(
    view,
    tiers,
    terminalTheme(options.color === true && !("NO_COLOR" in process.env)),
    options.commandName ?? "synapsor-runner",
    width,
    options.details === true,
  );
  return `${lines.join("\n")}\n`;
}

export function formatBoundaryOverviewMap(
  resources: BoundaryResourceReviewSummary[],
  options: {
    color?: boolean;
    exhaustive?: boolean;
    commandName?: string;
    details?: boolean;
    columns?: number;
  } = {},
): string {
  const theme = terminalTheme(options.color === true && !("NO_COLOR" in process.env));
  if (!options.exhaustive) {
    const lines = [
      theme.title("BOUNDARY OVERVIEW"),
      ...boundaryOverviewFirstRunLines(
        resources,
        theme,
        options.commandName ?? "synapsor-runner",
      ),
      "",
    ];
    return lines.join("\n");
  }
  const lines = [
    theme.title("WHOLE BOUNDARY MAP (ALL TABLES)"),
    theme.dim("Complete inspected catalog. Use boundary review --map for the concise overview."),
    boundaryOverviewSummary(resources),
    "",
    ...boundaryOverviewMapLines(
      resources,
      theme,
      options.commandName ?? "synapsor-runner",
      options.details === true,
      Math.max(36, terminalContentWidth(options.columns)),
    ),
    ...(options.details ? [] : [
      "",
      theme.dim("Canonical path IDs are hidden in the scan view. Rerun with --details for scripted review."),
    ]),
    "",
  ];
  return lines.join("\n");
}

function boundaryResourceMapLines(
  view: BoundaryResourceReviewView,
  tiers: Record<string, BoundaryFieldTier>,
  theme: TerminalTheme,
  commandName = "synapsor-runner",
  width = 96,
  details = false,
): string[] {
  const candidate = view.candidate ?? view.generated_candidate;
  if (!candidate) {
    const scopeGuidance = blockedTenantScopeGuidance(view);
    const derivedScopeLines = view.organization_scope
      ? []
      : availableDerivedTenantScopeLines(view, theme, commandName);
    const selectedIdentity = view.row_identity.selected;
    const identityCandidate = view.row_identity.candidates[0];
    const relevantBlockers = view.organization_scope
      ? view.blockers.filter((value) => !/^trusted tenant scope is unresolved/iu.test(value))
      : view.blockers;
    const blocker = (
      relevantBlockers.join("; ") || "record identity is unresolved"
    ).replace(/[.]+$/, "");
    return [
      theme.title(`TABLE ACCESS MAP - ${safeTerminalText(view.resource_id)}`),
      theme.warning(`Blocked: ${safeTerminalText(blocker)}.`),
      "",
      theme.bold("What Runner already proved"),
      selectedIdentity
        ? `  Record identity: ${theme.success(safeTerminalText(selectedIdentity))} ` +
          `(${safeTerminalText(view.row_identity.confidence)} confidence)`
        : identityCandidate
          ? `  Record identity candidate: ${theme.warning(safeTerminalText(identityCandidate))} ` +
            `(${safeTerminalText(view.row_identity.confidence)} confidence; human review required)`
          : `  Record identity: ${theme.danger("unresolved")}`,
      ...view.row_identity.evidence.slice(0, 3).map((evidence) =>
        `    evidence: ${safeTerminalText(`${evidence.source}: ${evidence.detail}`)}`),
      ...(view.organization_scope
        ? [
            `  Whole-organization scope: ${theme.success(safeTerminalText(view.organization_scope.organization_id))}`,
            theme.dim("    no tenant column or tenant predicate is required"),
          ]
        : [`  Direct tenant scope: ${view.tenant_key.selected
            ? theme.success(safeTerminalText(view.tenant_key.selected))
            : view.tenant_key.candidates.length
              ? theme.warning(`${view.tenant_key.candidates.length} candidate(s); human review required`)
              : theme.warning("unavailable")}`]),
      ...(!view.organization_scope && view.tenant_key.blocked_reason
        ? [`    why: ${safeTerminalText(view.tenant_key.blocked_reason)}`]
        : []),
      ...(view.organization_scope ? [] : blockedRelationshipProofLines(view, theme)),
      ...(scopeGuidance || view.organization_scope ? [] : sharedReferenceProofLines(view, theme)),
      ...derivedScopeLines,
      ...(scopeGuidance
        ? [
            "",
            theme.bold("Why tenant isolation is unavailable"),
            ...scopeGuidance.why.map((line) => `  - ${safeTerminalText(line)}`),
            "",
            theme.bold("What makes this table addable"),
            ...scopeGuidance.remediation.map((line) => `  - ${safeTerminalText(line)}`),
          ]
        : []),
    ];
  }
  const hasStagedChanges = view.fields.some(
    (field) => currentFieldTier(view, field.name) !== tiers[field.name],
  );
  const lines = [
    theme.title(`TABLE ACCESS MAP - ${safeTerminalText(view.resource_id)}`),
    theme.dim(hasStagedChanges
      ? "Preview includes unsaved access choices. This view cannot save or activate authority."
      : "Current disabled review candidate. This view cannot save or activate authority."),
    "",
    theme.bold(`${safeTerminalText(view.resource_id)}  in reviewed boundary`),
    ...boundaryResourceScopeLines(candidate, view.organization_scope),
    "",
    theme.bold("FIELD AUTHORITY"),
    ...renderBoundaryMapFieldMatrix(
      boundaryResourceFieldRows(view, candidate, tiers),
      { width, indent: "  " },
    ),
    "",
    ...boundaryMapOperationLegend().map((line) => theme.dim(line)),
    ...(details ? mapFieldOperationDetailLines(view, candidate, tiers, theme) : []),
    ...operationRepairLines(view, tiers, theme, commandName),
    ...mapRelationshipLines(candidate, theme, details),
    ...availableRelationshipReviewLines(view, theme, details),
    ...(!details && (mapHasExactDetails(candidate)
      || hasAvailableRelationshipDetails(view))
      ? ["", theme.dim("Exact filter/time vocabularies and canonical path IDs: rerun with --details or use --json.")]
      : []),
  ];
  return lines;
}

function hasAvailableRelationshipDetails(view: BoundaryResourceReviewView): boolean {
  const reviewed = new Set(view.candidate?.relationships.map((relationship) =>
    relationship.id) ?? []);
  return (view.generated_candidate?.relationships ?? []).some((relationship) =>
    !reviewed.has(relationship.id));
}

function availableRelationshipReviewLines(
  view: BoundaryResourceReviewView,
  theme: TerminalTheme,
  details: boolean,
): string[] {
  const reviewed = new Set(view.candidate?.relationships.map((relationship) =>
    relationship.id) ?? []);
  const available = (view.generated_candidate?.relationships ?? [])
    .filter((relationship) => !reviewed.has(relationship.id))
    .sort((left, right) =>
      (left.path_depth ?? 1) - (right.path_depth ?? 1)
        || left.target_resource.localeCompare(right.target_resource)
        || left.id.localeCompare(right.id));
  if (!available.length) return [];
  const includedResources = new Set(view.included_resource_ids ?? [view.resource_id]);
  const reviewedMaximum = view.reviewed_budgets?.max_analysis_relationship_hops
    ?? view.reviewed_budgets?.max_relationship_hops
    ?? 2;
  return [
    "",
    theme.bold("RELATIONSHIP PATHS AVAILABLE FOR REVIEW"),
    ...available.flatMap((relationship) => {
      const display = relationshipPathDisplay(view.resource_id, relationship);
      const joinColumns = formatRelationshipJoinColumns(display);
      const missingResources = relationshipPathRequiredResources(relationship).filter((resource) =>
        !includedResources.has(resource));
      const depth = relationship.path_depth ?? 1;
      const state = missingResources.length
        ? theme.danger(`ADD TABLES FIRST: ${missingResources.join(", ")}`)
        : depth > reviewedMaximum
          ? theme.warning(`NEEDS ANALYSIS-PATH DEPTH ${depth}; CURRENTLY ${reviewedMaximum}`)
          : theme.warning("AVAILABLE - HUMAN REVIEW REQUIRED");
      return [
        `  ${state}`,
        `    ${safeTerminalText(formatRelationshipPath(display))} ` +
          `(${depth} ${plural(depth, "hop", "hops")})`,
        ...(joinColumns ? [`    via columns: ${safeTerminalText(joinColumns)}`] : []),
        ...(details ? [`    ${theme.dim(`path ID: ${safeTerminalText(relationship.id)}`)}`] : []),
      ];
    }),
    theme.bold("Review interactively: open boundary review --access, select this table, then press J."),
    theme.dim("Saving the path creates a disabled revision. C remains the separate review and activation step."),
  ];
}

function operationRepairLines(
  view: BoundaryResourceReviewView,
  tiers: Record<string, BoundaryFieldTier>,
  theme: TerminalTheme,
  commandName: string,
): string[] {
  const generated = view.generated_candidate;
  const fields = (view.operation_repair_fields ?? [])
    .filter((field) => tiers[field] !== "kept_out");
  if (!generated || !fields.length) return [];
  return [
    "",
    theme.warning("OPTIONAL ANALYTICAL OPERATIONS"),
    ...fields.flatMap((field) => {
      const tier = tiers[field] ?? currentFieldTier(view, field);
      const flag = tier === "withheld_from_model" ? "--withhold-from-model" : "--allow-reviewed-field";
      const command = [
        commandName,
        "boundary review resource",
        shellQuote(view.resource_id),
        flag,
        shellQuote(field),
        "--apply",
        "--actor \"$USER\"",
        "--reason",
        shellQuote(`Add the current inspected analytical operations for ${view.resource_id}.${field}.`),
      ].join(" ");
      return [
        `  ${safeTerminalText(field)} is usable but has no filter, sort, group, or measure grant.`,
        `    current suggestions: ${boundaryFieldOperations(generated, field)}`,
        "    review and add here: press S while this column is selected",
        `    scripted review: ${safeTerminalText(command)}`,
      ];
    }),
  ];
}

function blockedRelationshipProofLines(
  view: BoundaryResourceReviewView,
  theme: TerminalTheme,
): string[] {
  if (!view.relationships.length) {
    return [`  Relationships: ${theme.dim("none found")}`];
  }
  return [
    `  Relationships: ${view.relationships.length}`,
    ...view.relationships.flatMap((relationship) => {
      const target = `${relationship.referenced_resource}.${relationship.referenced_columns.join(",")}`;
      const uniqueness = relationship.target_uniqueness
        ? `${relationship.target_uniqueness.kind.replaceAll("_", " ")} ` +
          `${relationship.target_uniqueness.name}(` +
          `${relationship.target_uniqueness.columns.join(",")})`
        : "unique target";
      const proof = relationship.cardinality_proven
        ? `${relationship.nullable ? "nullable" : "NOT NULL"}; many-to-one proven; target ${uniqueness}`
        : `${relationship.nullable ? "nullable" : "NOT NULL"}; cardinality not proven`;
      return [
        `    ${theme.relationship(safeTerminalText(relationship.name))}: ` +
          `${safeTerminalText(relationship.columns.join(","))} -> ${safeTerminalText(target)}`,
        `      ${relationship.cardinality_proven && !relationship.nullable
          ? theme.success(safeTerminalText(proof))
          : theme.warning(safeTerminalText(proof))}`,
      ];
    }),
  ];
}

function sharedReferenceProofLines(
  view: BoundaryResourceReviewView,
  theme: TerminalTheme,
): string[] {
  if (view.shared_reference_scope?.eligible) {
    return [`  Shared reference: ${theme.success("eligible for explicit human review")}`];
  }
  if (!view.shared_reference_scope?.blockers.length) return [];
  return [
    `  Shared reference: ${theme.warning("unavailable")}`,
    ...view.shared_reference_scope.blockers.map((blocker) =>
      `    why: ${safeTerminalText(blocker)}`),
  ];
}

function availableDerivedTenantScopeLines(
  view: BoundaryResourceReviewView,
  theme: TerminalTheme,
  commandName: string,
): string[] {
  const paths = [...(view.derived_tenant_scope?.candidates ?? [])].sort((left, right) =>
    derivedScopeDepth(left) - derivedScopeDepth(right) || left.path_id.localeCompare(right.path_id));
  if (!paths.length) return [];
  const reviewedMaximum = view.reviewed_budgets?.max_derived_scope_hops
    ?? view.reviewed_budgets?.max_relationship_hops
    ?? 2;
  return [
    "",
    theme.bold("Available tenant-scope paths"),
    ...paths.flatMap((scope) => {
      const depth = derivedScopeDepth(scope);
      const joinColumns = formatDerivedScopeJoinColumns(scope);
      const principalScope = view.derived_principal_scope?.candidates.find((candidate) =>
        candidate.path_id === scope.path_id);
      const command = derivedTenantScopeReviewCommand({
        commandName,
        resourceId: view.resource_id,
        rowIdentity: view.row_identity.selected,
        scope,
        ...(principalScope ? { principalScopePath: principalScope.path_id } : {}),
        ...(depth > reviewedMaximum ? { requiredMaximum: depth } : {}),
      });
      return [
        `  ${theme.success(`Tenant scope available (${depth} ${plural(depth, "hop", "hops")})`)}`,
        `    ${safeTerminalText(formatDerivedScopePath(scope))}`,
        ...(joinColumns
          ? [`    via columns: ${safeTerminalText(joinColumns)}`]
          : []),
        `    ${theme.dim(`path ID: ${safeTerminalText(scope.path_id)}`)}`,
        `    review order: add scoped ancestors first, then this table.`,
        ...(depth > reviewedMaximum
          ? [theme.warning(
              `    needs max_derived_scope_hops ${depth} (currently ${reviewedMaximum}); ` +
              `the command below raises only this reviewed limit.`,
            )]
          : []),
        ...(principalScope
          ? [`    principal scope is also proven through this exact path.`]
          : []),
        `    review: ${safeTerminalText(command)}`,
      ];
    }),
  ];
}

function derivedTenantScopeReviewCommand(input: {
  commandName: string;
  resourceId: string;
  rowIdentity?: string;
  scope: DerivedScopePath;
  principalScopePath?: string;
  requiredMaximum?: number;
}): string {
  return [
    input.commandName,
    "boundary review resource",
    shellQuote(input.resourceId),
    "--include",
    ...(input.rowIdentity ? ["--row-identity", shellQuote(input.rowIdentity)] : []),
    "--tenant-scope-path",
    shellQuote(input.scope.path_id),
    ...(input.principalScopePath
      ? ["--principal-scope-path", shellQuote(input.principalScopePath)]
      : []),
    ...(input.requiredMaximum
      ? ["--max-derived-scope-hops", String(input.requiredMaximum)]
      : []),
    "--apply",
    "--actor \"$USER\"",
    "--reason",
    shellQuote(
      `Rows inherit trusted scope through mandatory path ${input.scope.path_id} to ` +
      `${input.scope.ancestor_resource}.`,
    ),
  ].join(" ");
}

function derivedScopeDepth(scope: DerivedScopePath): number {
  return scope.proof.links.length;
}

function firstTableIsStartable(resource: BoundaryResourceReviewSummary): boolean {
  if (resource.first_table_startable === false) return false;
  return resource.status === "draft_read" || resource.inline_resolution_available === true;
}

function boundaryResourceScopeLines(
  candidate: NonNullable<BoundaryResourceReviewView["candidate"]>,
  organizationScope?: BoundaryResourceReviewView["organization_scope"],
): string[] {
  return [
    `  ${"record identity".padEnd(18)}${safeTerminalText(candidate.primary_key)}`,
    `  ${"tenant scope".padEnd(18)}${organizationScope
      ? `whole organization ${safeTerminalText(organizationScope.organization_id)}; no tenant column or tenant predicate required`
      : candidate.tenant_key
      ? `${safeTerminalText(candidate.tenant_key)} (direct; trusted runtime value)`
      : candidate.tenant_scope
        ? `${safeTerminalText(formatDerivedScopePath(candidate.tenant_scope))} ` +
          `(${candidate.tenant_scope.proof.links.length} ` +
          `${plural(candidate.tenant_scope.proof.links.length, "hop", "hops")}, mandatory)`
        : "shared reference (no tenant predicate)"}`,
    `  ${"principal scope".padEnd(18)}${candidate.principal_key
      ? `${safeTerminalText(candidate.principal_key)} (direct; trusted runtime value)`
      : candidate.principal_scope
        ? `${safeTerminalText(formatDerivedScopePath(candidate.principal_scope))} ` +
          `(${candidate.principal_scope.proof.links.length} ` +
          `${plural(candidate.principal_scope.proof.links.length, "hop", "hops")}, mandatory)`
        : "not configured"}`,
    `  ${"cohort guard".padEnd(18)}minimum group size ${candidate.minimum_cohort_size}; smaller groups are suppressed`,
  ];
}

function boundaryResourceFieldRows(
  view: BoundaryResourceReviewView,
  candidate: NonNullable<BoundaryResourceReviewView["candidate"]>,
  tiers: Record<string, BoundaryFieldTier>,
): BoundaryMapFieldRow[] {
  return [...view.fields]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((field) => {
      const tier = tiers[field.name] ?? "kept_out";
      const restoresSuggestions = tier !== "kept_out"
        && currentFieldTier(view, field.name) === "kept_out";
      const authority = restoresSuggestions ? (view.generated_candidate ?? candidate) : candidate;
      const unavailable = tier === "kept_out";
      const notes = boundaryMapFieldNotes(view, field, restoresSuggestions);
      return {
        field: safeTerminalText(field.name),
        data_type: safeTerminalText(field.data_type ?? candidate.field_types[field.name] ?? "reviewed"),
        access: tier === "visible" ? "MODEL" : tier === "withheld_from_model" ? "RUNNER" : "KEPT",
        operations: {
          return_value: !unavailable && authority.selectable_fields.includes(field.name),
          filter: !unavailable && (authority.filterable_fields[field.name]?.length ?? 0) > 0,
          sort: !unavailable && authority.sortable_fields.includes(field.name),
          group: !unavailable && (
            authority.groupable_fields.includes(field.name)
            || (authority.numeric_bands ?? []).some((band) => band.field === field.name)
            || (authority.auto_bands ?? []).some((policy) => policy.field === field.name)
          ),
          measure: !unavailable && authority.aggregate_measures.includes(field.name),
          presence: !unavailable && (authority.presence_measure_fields ?? []).includes(field.name),
          distinct: !unavailable && authority.count_distinct_fields.includes(field.name),
          time: !unavailable && (authority.time_bucket_fields[field.name]?.length ?? 0) > 0,
        },
        ...(notes.length ? { note: notes.join("; ") } : {}),
      };
    });
}

function boundaryMapFieldNotes(
  view: BoundaryResourceReviewView,
  field: BoundaryResourceReviewView["fields"][number],
  restoresSuggestions: boolean,
): string[] {
  const notes: string[] = [];
  if (isTrustedScopeField(view, field.name)) notes.push("trusted scope");
  else if (field.primary_key) notes.push("record ID");
  if (field.sensitivity.state === "high_confidence_sensitive") notes.push("sensitive");
  else if (field.sensitivity.state !== "structurally_low_risk") notes.push("needs review");
  if (restoresSuggestions) notes.push("restores on save");
  if ((view.operation_repair_fields ?? []).includes(field.name)) notes.push("operations available");
  return notes;
}

function mapFieldOperationDetailLines(
  view: BoundaryResourceReviewView,
  candidate: NonNullable<BoundaryResourceReviewView["candidate"]>,
  tiers: Record<string, BoundaryFieldTier>,
  theme: TerminalTheme,
): string[] {
  const details = [...view.fields]
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((field) => {
      const tier = tiers[field.name] ?? "kept_out";
      if (tier === "kept_out") return [];
      const restoresSuggestions = currentFieldTier(view, field.name) === "kept_out";
      const authority = restoresSuggestions ? (view.generated_candidate ?? candidate) : candidate;
      const values: string[] = [];
      const filters = authority.filterable_fields[field.name];
      if (filters?.length) values.push(`filter: ${filters.join(", ")}`);
      const functions = authority.aggregate_measure_functions?.[field.name];
      if (functions?.length) values.push(`measure: ${functions.join(", ")}`);
      const buckets = authority.time_bucket_fields[field.name];
      if (buckets?.length) values.push(`time: ${buckets.join(", ")}`);
      const fixedBands = (authority.numeric_bands ?? [])
        .filter((band) => band.field === field.name)
        .map((band) => band.name);
      if (fixedBands.length) values.push(`fixed bands: ${fixedBands.join(", ")}`);
      const autoBands = (authority.auto_bands ?? [])
        .filter((policy) => policy.field === field.name)
        .map((policy) => `${policy.methods.join("/")} ${policy.min_buckets}-${policy.max_buckets}`);
      if (autoBands.length) values.push(`auto bands: ${autoBands.join(", ")}`);
      return values.length ? [`  ${safeTerminalText(field.name)}  ${safeTerminalText(values.join(" | "))}`] : [];
    });
  return details.length
    ? ["", theme.bold("EXACT OPERATION DETAILS"), ...details]
    : [];
}

function boundaryFieldOperations(
  candidate: NonNullable<BoundaryResourceReviewView["candidate"]>,
  field: string,
): string {
  const operations: string[] = [];
  if (candidate.selectable_fields.includes(field)) operations.push("return");
  const filters = candidate.filterable_fields[field];
  if (filters?.length) operations.push(`filter(${filters.join("/")})`);
  if (candidate.sortable_fields.includes(field)) operations.push("sort");
  if (candidate.groupable_fields.includes(field)) operations.push("group");
  if (candidate.aggregate_measures.includes(field)) operations.push("aggregate measure");
  if (candidate.presence_measure_fields?.includes(field)) operations.push("presence measures");
  if (candidate.count_distinct_fields.includes(field)) operations.push("count distinct");
  const buckets = candidate.time_bucket_fields[field];
  if (buckets?.length) operations.push(`time(${buckets.join("/")})`);
  return operations.length ? operations.join(", ") : "no reviewed operation";
}

function mapRelationshipLines(
  candidate: NonNullable<BoundaryResourceReviewView["candidate"]>,
  theme: TerminalTheme,
  details: boolean,
): string[] {
  const pathIds = mapPathIdEntries(candidate);
  if (!candidate.relationships.length && (!details || !pathIds.length)) return [];
  const lines = candidate.relationships.length
    ? ["", theme.relationship("RELATIONSHIPS")]
    : [];
  candidate.relationships.forEach((relationship, index) => {
    const display = {
      source_resource: candidate.id,
      target_resource: relationship.target_resource,
      links: relationship.proof?.links,
    };
    const depth = relationship.path_depth ?? 1;
    const joinColumns = formatRelationshipJoinColumns(display)
      ?? relationship.local_columns.join(", ");
    lines.push(
      `  R${index + 1}  ${depth} ${plural(depth, "hop", "hops")}  ` +
      `${safeTerminalText(formatRelationshipPath(display))}` +
      `${joinColumns ? `  via ${safeTerminalText(joinColumns)}` : ""}`,
    );
  });
  if (details && pathIds.length) {
    lines.push("", theme.dim("PATH IDS (SCRIPTED REVIEW)"));
    lines.push(...pathIds.map((entry) => `  ${entry.labels.join("/")}  ${safeTerminalText(entry.id)}`));
  }
  return lines;
}

function mapPathIdEntries(
  candidate: NonNullable<BoundaryResourceReviewView["candidate"]>,
): Array<{ id: string; labels: string[] }> {
  const entries = new Map<string, string[]>();
  const add = (id: string | undefined, label: string) => {
    if (!id) return;
    const labels = entries.get(id) ?? [];
    labels.push(label);
    entries.set(id, labels);
  };
  add(candidate.tenant_scope?.path_id, "T");
  add(candidate.principal_scope?.path_id, "P");
  candidate.relationships.forEach((relationship, index) => add(relationship.id, `R${index + 1}`));
  return [...entries].map(([id, labels]) => ({ id, labels }));
}

function mapHasExactDetails(
  candidate: NonNullable<BoundaryResourceReviewView["candidate"]>,
): boolean {
  return Object.values(candidate.filterable_fields).some((operators) => operators.length > 0)
    || Object.values(candidate.time_bucket_fields).some((buckets) => buckets.length > 0)
    || Object.values(candidate.aggregate_measure_functions ?? {}).some((functions) => functions.length > 0)
    || (candidate.numeric_bands?.length ?? 0) > 0
    || (candidate.auto_bands?.length ?? 0) > 0
    || mapPathIdEntries(candidate).length > 0;
}

function boundaryOverviewSummary(resources: BoundaryResourceReviewSummary[]): string {
  const included = resources.filter((resource) => resource.included).length;
  const active = resources.filter((resource) => resource.active).length;
  const blocked = resources.filter((resource) => resource.status !== "draft_read").length;
  const reviewedPaths = new Set<string>();
  for (const resource of resources) {
    for (const relationship of resource.relationships) {
      if (relationship.state !== "available") {
        reviewedPaths.add(`${resource.resource_id}\u0000${relationship.relationship_id}`);
      }
    }
    for (const entry of selectedDerivedScopeEntries(resource)) {
      reviewedPaths.add(`${resource.resource_id}\u0000${entry.scope.path_id}`);
    }
  }
  const name = resources[0]?.candidate_boundary_name ?? "reviewed_staging";
  return `Next boundary "${safeTerminalText(name)}": ${included}/${resources.length} tables | ` +
    `active ${active} | reviewed paths ${reviewedPaths.size} | blocked ${blocked}`;
}

function boundaryOverviewFirstRunLines(
  resources: BoundaryResourceReviewSummary[],
  theme: TerminalTheme,
  commandName: string,
): string[] {
  if (!resources.length) {
    return [
      theme.warning("Runner did not find any inspected tables or views in this boundary draft."),
      "",
      theme.bold("NEXT"),
      `Draft the boundary again: ${commandName} boundary draft --from-env DATABASE_URL`,
    ];
  }

  const candidate = resources.filter((resource) => resource.included);
  const active = resources.filter((resource) => resource.active);
  const available = resources.filter(
    (resource) => resource.status === "draft_read" && !resource.included,
  );
  const blocked = resources.filter((resource) => resource.status !== "draft_read");
  const boundaryName = resources[0]!.candidate_boundary_name;
  const lines = [
    `Runner inspected ${resources.length} ${plural(resources.length, "table", "tables")}.`,
    `Boundary "${safeTerminalText(boundaryName)}" is one boundary containing ` +
      `${candidate.length} ${plural(candidate.length, "table", "tables")}.`,
    "The schema.table entries below are tables inside it, not separate boundaries.",
    "",
    theme.bold("ACTIVE NOW"),
  ];

  if (!active.length) {
    lines.push(
      theme.warning(
        "No Scoped Explore tables are active. The disabled draft below grants no data access.",
      ),
    );
  } else {
    lines.push(`${active.length} ${plural(active.length, "table is", "tables are")} active:`);
    lines.push(...resourceNamePreview(active, theme, 6));
  }

  lines.push(
    "",
    theme.bold(`NEXT BOUNDARY "${safeTerminalText(boundaryName)}" (DISABLED DRAFT)`),
  );
  if (!candidate.length) {
    lines.push(theme.warning("No tables are included in the next boundary draft."));
  } else {
    lines.push(
      `Auto Boundary selected ${candidate.length} starting ${plural(candidate.length, "table", "tables")}.`,
      "You can rename it and add, remove, or edit tables before separate exact-digest activation.",
      ...candidate.slice(0, 6).flatMap((resource) =>
        candidateResourceOverviewLines(resource, theme)),
    );
    if (candidate.length > 6) {
      lines.push(theme.dim(`  +${candidate.length - 6} more candidate tables; use --map --all to inspect them.`));
    }
  }

  lines.push(
    "",
    theme.bold("OTHER INSPECTED TABLES"),
    `${available.length} reviewable ${plural(available.length, "table is", "tables are")} outside this boundary; ` +
      `${blocked.length} ${plural(blocked.length, "is", "are")} blocked.`,
  );
  if (available.length) {
    lines.push(theme.dim("Available to add:"));
    lines.push(...resourceNamePreview(available, theme, 6));
  }
  if (blocked.length) {
    lines.push(theme.danger("Blocked pending structural review:"));
    lines.push(...resourceNamePreview(blocked, theme, 3));
  }

  const relationshipSuggestions = availableRelationshipSuggestionLines(available, theme, 3);
  if (relationshipSuggestions.length) {
    lines.push(
      "",
      theme.bold("PROVEN PATHS WORTH REVIEWING"),
      ...relationshipSuggestions,
    );
  }

  lines.push(
    "",
    theme.bold("WHAT THE FIELD COUNTS MEAN"),
    `${theme.visible("Model")}: real reviewed values may reach the configured model and appear locally.`,
    `${theme.runnerOnly("Raw values: Runner only")}: reviewed operations may use it; raw values stay out of model requests while derived results remain usable.`,
    `${theme.keptOut("Kept out")}: unavailable for selection, filtering, grouping, joining, or aggregation.`,
    "",
    theme.bold("NEXT"),
    `Open add/remove/edit/rename and the review checklist: ${commandName} boundary review`,
    `Inspect one table: ${commandName} boundary review resource <table> --map`,
    `Show the complete catalog: ${commandName} boundary review --map --all`,
  );
  return lines;
}

function candidateResourceOverviewLines(
  resource: BoundaryResourceReviewSummary,
  theme: TerminalTheme,
): string[] {
  const state = resource.active ? "ACTIVE + IN DRAFT" : "IN DISABLED DRAFT";
  const review = resource.risk_count
    ? `table sign-off needed (${resource.risk_count} exact ` +
      `${plural(resource.risk_count, "decision", "decisions")})`
    : "table sign-off complete";
  const relationships = resource.relationships.filter(
    (relationship) => relationship.state !== "available",
  );
  const scopeEntries = selectedDerivedScopeEntries(resource);
  const scopePathIds = new Set(scopeEntries.map((entry) => entry.scope.path_id));
  const relationshipByPath = new Map(relationships.map((relationship) => [
    relationship.relationship_id,
    relationship,
  ]));
  const lines = [
    `  ${safeTerminalText(resource.resource_id)} [${theme.warning(state)}; ${review}]`,
    `    Fields: ${resource.model_visible_fields} model | ` +
      `${resource.runner_output_only_fields} raw Runner-only | ${resource.kept_out_fields} kept out`,
    ...((resource.operation_repair_fields?.length ?? 0) > 0
      ? [theme.warning(
          `    Optional operations: ${resource.operation_repair_fields!.join(", ")}`,
        )]
      : []),
  ];
  for (const entry of scopeEntries.slice(0, 3)) {
    const relationship = relationshipByPath.get(entry.scope.path_id);
    const depth = derivedScopeDepth(entry.scope);
    const role = entry.roles.join(" + ");
    lines.push(
      `    ${theme.relationship(
        `${role}${relationship ? " + analysis relationship" : ""}: ` +
        `${safeTerminalText(formatDerivedScopePath(entry.scope))} ` +
        `(${depth} ${plural(depth, "hop", "hops")})`,
      )}`,
    );
    const joinColumns = formatDerivedScopeJoinColumns(entry.scope);
    if (joinColumns) lines.push(theme.dim(`      via columns: ${safeTerminalText(joinColumns)}`));
  }
  const remainingRelationships = relationships.filter(
    (relationship) => !scopePathIds.has(relationship.relationship_id),
  );
  const remainingSlots = Math.max(0, 3 - scopeEntries.length);
  for (const relationship of remainingRelationships.slice(0, remainingSlots)) {
    const display = summaryRelationshipDisplay(resource.resource_id, relationship);
    const joinColumns = formatRelationshipJoinColumns(display);
    lines.push(
      `    ${theme.relationship(safeTerminalText(formatRelationshipPath(display)))} ` +
      `(${relationship.path_depth} ${plural(relationship.path_depth, "hop", "hops")})`,
    );
    if (joinColumns) lines.push(theme.dim(`      via columns: ${safeTerminalText(joinColumns)}`));
  }
  const renderedPaths = Math.min(3, scopeEntries.length + remainingRelationships.length);
  const totalPaths = scopeEntries.length + remainingRelationships.length;
  if (totalPaths > renderedPaths) {
    lines.push(theme.dim(`    +${totalPaths - renderedPaths} more reviewed paths`));
  }
  return lines;
}

function resourceNamePreview(
  resources: BoundaryResourceReviewSummary[],
  theme: TerminalTheme,
  limit: number,
): string[] {
  const lines = resources.slice(0, limit).flatMap((resource) => [
    `  ${safeTerminalText(resource.resource_id)}`,
    ...(resource.scope_resolution_guidance
      ? [theme.dim(
          `    Why: ${safeTerminalText(
            resource.scope_resolution_guidance.why[0]
              ?? "trusted tenant scope is unresolved",
          )}`,
        )]
      : resource.derived_tenant_scope?.candidates.length
        ? [theme.dim(
            `    Available tenant path: ${safeTerminalText(
              formatDerivedScopePath(resource.derived_tenant_scope.candidates[0]!),
            )}`,
          )]
        : []),
  ]);
  if (resources.length > limit) {
    lines.push(theme.dim(`  +${resources.length - limit} more`));
  }
  return lines;
}

function availableRelationshipSuggestionLines(
  resources: BoundaryResourceReviewSummary[],
  theme: TerminalTheme,
  limit: number,
): string[] {
  const suggestions = resources
    .flatMap((resource) => resource.relationships
      .filter((relationship) => relationship.state === "available")
      .map((relationship) => ({ resource, relationship })));
  const lines = suggestions.slice(0, limit).flatMap(({ resource, relationship }) => {
    const display = summaryRelationshipDisplay(resource.resource_id, relationship);
    const joinColumns = formatRelationshipJoinColumns(display);
    return [
      theme.relationship(
        `  ${safeTerminalText(formatRelationshipPath(display))} ` +
        `(${relationship.path_depth} ${plural(relationship.path_depth, "hop", "hops")})`,
      ),
      ...(joinColumns
        ? [theme.dim(`    via columns: ${safeTerminalText(joinColumns)}`)]
        : []),
    ];
  });
  if (suggestions.length > limit) {
    lines.push(theme.dim(`  +${suggestions.length - limit} more proven paths`));
  }
  return lines;
}

function summaryRelationshipDisplay(
  sourceResource: string,
  relationship: BoundaryResourceReviewSummary["relationships"][number],
) {
  return {
    source_resource: sourceResource,
    target_resource: relationship.target_resource,
    links: relationship.path_links,
  };
}

function resourcesForPickerView(
  resources: BoundaryResourceReviewSummary[],
  boundaryResources: BoundaryResourceReviewSummary[],
  view: ResourcePickerView,
  stableBoundaryOrder = false,
): BoundaryResourceReviewSummary[] {
  if (view === "boundary") {
    const listed = boundaryResources.length ? boundaryResources : resources;
    return stableBoundaryOrder
      ? [...listed].sort((left, right) => left.resource_id.localeCompare(right.resource_id))
      : listed;
  }
  const boundaryIds = new Set(boundaryResources.map((resource) => resource.resource_id));
  const outsideBoundary = resources.filter((resource) => !boundaryIds.has(resource.resource_id));
  if (view === "all" || !boundaryResources.length) return outsideBoundary.length
    ? outsideBoundary
    : resources;
  return outsideBoundary.filter(
    (resource) => bestBoundaryRelationshipConnection(resource, boundaryResources) !== undefined,
  );
}

function boundaryRelationshipConnections(
  candidate: BoundaryResourceReviewSummary,
  boundaryResources: BoundaryResourceReviewSummary[],
): BoundaryRelationshipConnection[] {
  const boundaryIds = new Set(boundaryResources.map((resource) => resource.resource_id));
  const connections: BoundaryRelationshipConnection[] = [];
  for (const relationship of candidate.relationships) {
    if (!boundaryIds.has(relationship.target_resource)) continue;
    connections.push({
      kind: "relationship",
      source_resource: candidate.resource_id,
      target_resource: relationship.target_resource,
      relationship_id: relationship.relationship_id,
      path_depth: relationship.path_depth,
      path_links: relationship.path_links,
    });
  }
  for (const boundaryResource of boundaryResources) {
    for (const relationship of boundaryResource.relationships) {
      if (relationship.target_resource !== candidate.resource_id) continue;
      connections.push({
        kind: "relationship",
        source_resource: boundaryResource.resource_id,
        target_resource: candidate.resource_id,
        relationship_id: relationship.relationship_id,
        path_depth: relationship.path_depth,
        path_links: relationship.path_links,
      });
    }
  }
  connections.push(...boundaryDerivedScopeConnections(candidate, boundaryResources));
  return connections.sort((left, right) =>
    left.path_depth - right.path_depth
      || connectionKindOrder(left.kind) - connectionKindOrder(right.kind)
      || left.source_resource.localeCompare(right.source_resource)
      || left.target_resource.localeCompare(right.target_resource)
      || left.relationship_id.localeCompare(right.relationship_id));
}

function boundaryDerivedScopeConnections(
  candidate: BoundaryResourceReviewSummary,
  boundaryResources: BoundaryResourceReviewSummary[],
): BoundaryRelationshipConnection[] {
  const boundaryIds = new Set(boundaryResources.map((resource) => resource.resource_id));
  const inferences = [
    ...derivedScopePaths(candidate.derived_tenant_scope).map((scope) => ({
      kind: "derived_tenant_scope" as const,
      scope,
    })),
    ...derivedScopePaths(candidate.derived_principal_scope).map((scope) => ({
      kind: "derived_principal_scope" as const,
      scope,
    })),
  ];
  return inferences.flatMap(({ kind, scope }) => {
    const links = scope.proof?.links ?? [];
    let expectedSource = candidate.resource_id;
    const visited = new Set([candidate.resource_id]);
    for (const link of links) {
      if (link.source_resource !== expectedSource
        || visited.has(link.target_resource)
        || !boundaryIds.has(link.target_resource)
        || link.nullable
        || link.cardinality !== "many_to_one"
        || link.max_fan_out !== 1
        || link.source_columns.length < 1
        || link.source_columns.length !== link.target_columns.length
        || link.target_uniqueness.columns.length !== link.target_columns.length
        || link.target_uniqueness.columns.some(
          (field, index) => field !== link.target_columns[index],
        )) return [];
      expectedSource = link.target_resource;
      visited.add(link.target_resource);
    }
    if (links.length < 1
      || expectedSource !== scope.ancestor_resource
      || !boundaryIds.has(scope.ancestor_resource)) return [];
    return [{
      kind,
      source_resource: candidate.resource_id,
      target_resource: scope.ancestor_resource,
      relationship_id: scope.path_id,
      path_depth: links.length,
      derived_scope: scope,
    }];
  });
}

function derivedScopePaths(
  inference: BoundaryResourceReviewSummary["derived_tenant_scope"],
): DerivedScopePath[] {
  if (!inference) return [];
  const paths = [
    ...(inference.selected ? [inference.selected] : []),
    ...inference.candidates,
  ];
  return paths.filter((scope, index) =>
    paths.findIndex((candidate) => candidate.path_id === scope.path_id) === index);
}

function connectionKindOrder(kind: BoundaryRelationshipConnection["kind"]): number {
  return kind === "derived_tenant_scope" ? 0 : kind === "derived_principal_scope" ? 1 : 2;
}

function bestBoundaryRelationshipConnection(
  candidate: BoundaryResourceReviewSummary,
  boundaryResources: BoundaryResourceReviewSummary[],
): BoundaryRelationshipConnection | undefined {
  return boundaryRelationshipConnections(candidate, boundaryResources)[0];
}

function boundaryEndpoint(
  connection: BoundaryRelationshipConnection,
  boundaryResources: BoundaryResourceReviewSummary[],
): string {
  const boundaryIds = new Set(boundaryResources.map((resource) => resource.resource_id));
  return boundaryIds.has(connection.source_resource)
    ? connection.source_resource
    : connection.target_resource;
}

function relationshipConnectionDetail(
  candidate: BoundaryResourceReviewSummary,
  boundaryResources: BoundaryResourceReviewSummary[],
  theme: TerminalTheme,
): string[] {
  const connection = bestBoundaryRelationshipConnection(candidate, boundaryResources);
  if (!connection) return [];
  if (connection.derived_scope) {
    const scopeLabel = connection.kind === "derived_principal_scope"
      ? "Derived principal scope"
      : "Derived tenant scope";
    const joinColumns = formatDerivedScopeJoinColumns(connection.derived_scope);
    return [
      theme.relationship(
        `${scopeLabel} (${connection.path_depth} ` +
        `${plural(connection.path_depth, "hop", "hops")})`,
      ),
      `  ${safeTerminalText(formatDerivedScopePath(connection.derived_scope))}`,
      ...(joinColumns
        ? [`  via columns: ${safeTerminalText(joinColumns)}`]
        : []),
      theme.dim(
        `  path ID: ${safeTerminalText(connection.relationship_id)}; continuous non-null ` +
        `many-to-one catalog proof. Human review is still required before use.`,
      ),
    ];
  }
  const display = {
    source_resource: connection.source_resource,
    target_resource: connection.target_resource,
    links: connection.path_links,
  };
  const joinColumns = formatRelationshipJoinColumns(display);
  return [
    theme.relationship(
      `Proven relationship (${connection.path_depth} ` +
      `${plural(connection.path_depth, "hop", "hops")})`,
    ),
    `  ${safeTerminalText(formatRelationshipPath(display))}`,
    ...(joinColumns
      ? [`  via columns: ${safeTerminalText(joinColumns)}`]
      : []),
    theme.dim(
      `  path ID: ${safeTerminalText(connection.relationship_id)}; inspected many-to-one proof. ` +
      `Human review is still required before use.`,
    ),
  ];
}

function plural(count: number, singular: string, pluralValue: string): string {
  return count === 1 ? singular : pluralValue;
}

function boundaryReviewLeft(
  resources: BoundaryResourceReviewSummary[],
  overview: BoundaryReviewOverview | undefined,
): string {
  const tableSignoffs = overview?.resources_requiring_signoff
    ?? resources.filter((resource) => resource.included && resource.risk_count > 0).length;
  const boundarySignoff = (overview?.outstanding_boundary_decisions ?? 0) > 0 ? 1 : 0;
  if (tableSignoffs === 0 && boundarySignoff === 0) return "Complete";
  return [
    ...(tableSignoffs
      ? [`${tableSignoffs} ${plural(tableSignoffs, "table", "tables")}`]
      : []),
    ...(boundarySignoff ? ["boundary"] : []),
  ].join(" + ");
}

function savedBoundaryRow(
  marker: string,
  name: string,
  type: string,
  status: string,
  content: string,
  authority: string,
  layout: SavedBoundaryRowLayout,
): string {
  return [
    fitTerminalCell(marker, layout.marker),
    fitTerminalCell(safeTerminalText(name), layout.name),
    fitTerminalCell(type, layout.type),
    fitTerminalCell(status, layout.status),
    fitTerminalCell(content, layout.content),
    fitTerminalCell(authority, layout.authority),
  ].join("  ");
}

type SavedBoundaryRowLayout = {
  marker: number;
  name: number;
  type: number;
  status: number;
  content: number;
  authority: number;
};

function savedBoundaryRowLayout(width: number): SavedBoundaryRowLayout {
  if (width >= 108) {
    return { marker: 3, name: 26, type: 7, status: 24, content: 18, authority: 15 };
  }
  if (width >= 88) {
    return { marker: 2, name: 22, type: 7, status: 21, content: 14, authority: 12 };
  }
  if (width >= 72) {
    return { marker: 2, name: 17, type: 6, status: 17, content: 11, authority: 10 };
  }
  return { marker: 1, name: 9, type: 4, status: 8, content: 7, authority: 8 };
}

function fieldAccessRow(
  column: string,
  type: string,
  access: string,
  note: string,
  layout: FieldAccessLayout,
): string {
  if (layout.compact) {
    return [
      fitTerminalCell(column, layout.column),
      fitTerminalCell(access, layout.access),
    ].join("  ");
  }
  return [
    fitTerminalCell(column, layout.column),
    fitTerminalCell(type, layout.type),
    fitTerminalCell(access, layout.access),
    fitTerminalCell(note, layout.note),
  ].join("  ");
}

type FieldAccessLayout = {
  compact: boolean;
  column: number;
  type: number;
  access: number;
  note: number;
};

function fieldAccessLayout(width: number): FieldAccessLayout {
  const content = Math.max(34, width - 2); // leading selection marker and space
  if (width < 72) {
    const access = 18;
    return {
      compact: true,
      column: Math.max(12, content - access - 2),
      type: 0,
      access,
      note: 0,
    };
  }
  const access = 18;
  const note = Math.min(21, Math.max(14, Math.floor(content * 0.22)));
  const namesAndTypes = content - access - note - 6;
  const column = Math.min(22, Math.max(12, Math.floor(namesAndTypes * 0.48)));
  const type = Math.min(25, Math.max(13, namesAndTypes - column));
  return { compact: false, column, type, access, note };
}

function compactRiskBadge(
  view: BoundaryResourceReviewView,
  field: BoundaryResourceReviewView["fields"][number],
): string {
  if (isTrustedScopeField(view, field.name)) return "[trusted scope]";
  return riskBadge(view, field);
}

function fitTerminalCell(value: string, width: number): string {
  const safe = safeTerminalText(value);
  if (safe.length <= width) return safe.padEnd(width);
  return `${safe.slice(0, Math.max(1, width - 3))}...`;
}

function boundaryOverviewMapLines(
  resources: BoundaryResourceReviewSummary[],
  theme: TerminalTheme,
  commandName = "synapsor-runner",
  details = false,
  width = 116,
): string[] {
  if (!resources.length) return [theme.warning("(no inspected tables or views)")];
  const tableRows = resources.map((resource) => boundaryOverviewTableRow(
    resource,
    commandName,
    details,
  ));
  const normalizedWidth = Math.max(36, width);
  const lines = normalizedWidth >= 96
    ? renderWideBoundaryOverviewTable(tableRows, normalizedWidth)
    : normalizedWidth >= 64
      ? renderMediumBoundaryOverviewTable(tableRows, normalizedWidth)
      : renderNarrowBoundaryOverviewTable(tableRows, normalizedWidth);
  return lines.map((line) => styleBoundaryOverviewTableLine(line, theme));
}

type BoundaryOverviewTableRow = {
  resource: string;
  status: string;
  fields: string[];
  review: string[];
};

function boundaryOverviewTableRow(
  resource: BoundaryResourceReviewSummary,
  commandName: string,
  details: boolean,
): BoundaryOverviewTableRow {
  const fields = [
    `Model + Runner: ${resource.model_visible_fields}`,
    `Runner only: ${resource.runner_output_only_fields}`,
    `Kept out: ${resource.kept_out_fields}`,
  ];
  if ((resource.operation_repair_fields?.length ?? 0) > 0) {
    fields.push(
      `Optional: add suggested operations for ${resource.operation_repair_fields!.join(", ")}`,
    );
  }
  const review: string[] = [];
  if (resource.status === "draft_read") {
    review.push(...reviewedRelationshipTableLines(resource, details));
  } else {
    review.push(...blockedBoundaryTableLines(resource));
    review.push(...availableDerivedTenantScopeTableLines(resource, commandName, details));
  }
  if (!review.length) review.push("No reviewed relationship paths");
  return {
    resource: safeTerminalText(resource.resource_id),
    status: boundaryOverviewStatus(resource),
    fields: fields.map(safeTerminalText),
    review: review.map(safeTerminalText),
  };
}

function boundaryOverviewStatus(resource: BoundaryResourceReviewSummary): string {
  if (resource.status !== "draft_read") return "BLOCKED";
  if (resource.active && resource.included) return "ACTIVE + NEXT";
  if (resource.active) return "ACTIVE";
  if (resource.included) return "IN NEXT";
  return "NOT INCLUDED";
}

function reviewedRelationshipTableLines(
  resource: BoundaryResourceReviewSummary,
  details: boolean,
): string[] {
  const lines: string[] = [];
  const scopeEntries = selectedDerivedScopeEntries(resource);
  const scopePathIds = new Set(scopeEntries.map((entry) => entry.scope.path_id));
  const relationshipByPath = new Map(resource.relationships.map((relationship) => [
    relationship.relationship_id,
    relationship,
  ]));
  const pathIds: Array<{ label: string; id: string }> = [];
  scopeEntries.forEach((entry, index) => {
    const relationship = relationshipByPath.get(entry.scope.path_id);
    const depth = derivedScopeDepth(entry.scope);
    const label = `S${index + 1}`;
    const state = relationship ? plainRelationshipStateLabel(relationship) : undefined;
    lines.push(
      `${label}: ${entry.roles.join(" + ")}${relationship ? " + analysis relationship" : ""}` +
      ` (${depth} ${plural(depth, "hop", "hops")})${state ? ` [${state}]` : ""}`,
      `Path: ${formatDerivedScopePath(entry.scope)}`,
    );
    const joinColumns = formatDerivedScopeJoinColumns(entry.scope);
    if (joinColumns) lines.push(`Via columns: ${joinColumns}`);
    pathIds.push({ label, id: entry.scope.path_id });
  });
  const remainingRelationships = resource.relationships.filter(
    (relationship) => !scopePathIds.has(relationship.relationship_id),
  );
  remainingRelationships.forEach((relationship, index) => {
    const display = summaryRelationshipDisplay(resource.resource_id, relationship);
    const label = `R${index + 1}`;
    lines.push(
      `${label}: analysis relationship (${relationship.path_depth} ` +
      `${plural(relationship.path_depth, "hop", "hops")}) ` +
      `[${plainRelationshipStateLabel(relationship)}]`,
      `Path: ${formatRelationshipPath(display)}`,
    );
    const joinColumns = formatRelationshipJoinColumns(display);
    if (joinColumns) lines.push(`Via columns: ${joinColumns}`);
    pathIds.push({ label, id: relationship.relationship_id });
  });
  if (details && pathIds.length) {
    lines.push(...pathIds.map((entry) => `Path ID ${entry.label}: ${entry.id}`));
  }
  return lines;
}

function blockedBoundaryTableLines(
  resource: BoundaryResourceReviewSummary,
): string[] {
  const lines: string[] = [];
  if (resource.organization_scope) {
    lines.push(`Whole organization: ${resource.organization_scope.organization_id}`);
    lines.push("Row scope: no tenant column or tenant predicate required");
  }
  const blockers = resource.blockers.length ? resource.blockers : ["review blocked"];
  for (const blocker of blockers) {
    const normalized = compactMapReferenceText(resource.resource_id, blocker);
    const tenantScope = /^trusted tenant scope is unresolved(?:;\s*(.+))?\.?$/iu.exec(normalized);
    if (tenantScope) {
      if (resource.organization_scope) continue;
      lines.push("Tenant scope: UNRESOLVED");
      if (tenantScope[1]) {
        lines.push(`Review: ${tenantScope[1].replace(/^review\s+/iu, "")}`);
      }
      continue;
    }
    lines.push(`Blocked: ${normalized}`);
  }

  for (const reason of resource.scope_resolution_guidance?.why ?? []) {
    const presentation = blockedScopeReasonPresentation(reason);
    lines.push(
      `${titleCaseMapLabel(presentation.label)}: ` +
      compactMapReferenceText(resource.resource_id, presentation.message),
    );
  }
  for (const [index, remediation] of (
    resource.scope_resolution_guidance?.remediation.slice(0, 2) ?? []
  ).entries()) {
    lines.push(
      `Next ${index + 1}: ${compactMapReferenceText(resource.resource_id, remediation)}`,
    );
  }
  return lines;
}

function blockedScopeReasonPresentation(value: string): { label: string; message: string } {
  const match = /^(Direct tenant scope|Derived tenant scope|Shared reference) unavailable:\s*(.+)$/iu.exec(
    value.trim(),
  );
  if (!match) return { label: "why", message: value };
  const labels: Record<string, string> = {
    "direct tenant scope": "direct",
    "derived tenant scope": "derived",
    "shared reference": "shared",
  };
  return {
    label: labels[match[1]!.toLowerCase()] ?? "why",
    message: match[2]!,
  };
}

function titleCaseMapLabel(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function compactMapReferenceText(resourceId: string, value: string): string {
  const schemaSeparator = resourceId.indexOf(".");
  const schemaPrefix = schemaSeparator > 0 ? `${resourceId.slice(0, schemaSeparator)}.` : undefined;
  const compact = schemaPrefix ? value.split(schemaPrefix).join("") : value;
  return compact.trim().replace(/[.]+$/u, "");
}

function availableDerivedTenantScopeTableLines(
  resource: BoundaryResourceReviewSummary,
  commandName: string,
  details = false,
): string[] {
  const paths = [...(resource.derived_tenant_scope?.candidates ?? [])].sort((left, right) =>
    derivedScopeDepth(left) - derivedScopeDepth(right) || left.path_id.localeCompare(right.path_id));
  if (!paths.length) return [];
  const reviewedMaximum = resource.reviewed_max_derived_scope_hops ?? 2;
  const lines = paths.slice(0, 3).flatMap((scope, index) => {
    const depth = derivedScopeDepth(scope);
    const joinColumns = formatDerivedScopeJoinColumns(scope);
    return [
      `Available tenant scope: ${depth} ${plural(depth, "hop", "hops")}`,
      `Path: ${formatDerivedScopePath(scope)}`,
      ...(joinColumns
        ? [`Via columns: ${joinColumns}`]
        : []),
      ...(details
        ? [`Path ID A${index + 1}: ${scope.path_id}`]
        : []),
      ...(depth > reviewedMaximum
        ? [`Needs: max_derived_scope_hops ${depth} (currently ${reviewedMaximum})`]
        : []),
    ];
  });
  if (paths.length > 3) {
    lines.push(`${paths.length - 3} more proven paths are available`);
  }
  lines.push(
    `Next: ${commandName} boundary review resource ` +
    `${shellQuote(resource.resource_id)} --map shows the exact review command`,
  );
  return lines;
}

function renderWideBoundaryOverviewTable(
  rows: BoundaryOverviewTableRow[],
  width: number,
): string[] {
  const contentWidth = width - 13;
  const longestResource = Math.max(...rows.map((row) => row.resource.length), 18);
  const resourceWidth = Math.min(
    longestResource,
    Math.max(18, Math.floor(contentWidth * 0.3)),
  );
  const statusWidth = Math.min(20, Math.max(15, Math.floor(contentWidth * 0.18)));
  const fieldsWidth = Math.min(20, Math.max(18, Math.floor(contentWidth * 0.19)));
  const reviewWidth = contentWidth - resourceWidth - statusWidth - fieldsWidth;
  return renderBoundaryMapTable(
    ["Table", "Boundary status", "Field access", "Scope and relationships"],
    rows.map((row) => [
      row.resource,
      row.status,
      row.fields.join("\n"),
      row.review.join("\n"),
    ]),
    { widths: [resourceWidth, statusWidth, fieldsWidth, reviewWidth] },
  );
}

function renderMediumBoundaryOverviewTable(
  rows: BoundaryOverviewTableRow[],
  width: number,
): string[] {
  const contentWidth = width - 10;
  const resourceWidth = Math.min(23, Math.max(15, Math.floor(contentWidth * 0.28)));
  const statusWidth = Math.min(18, Math.max(14, Math.floor(contentWidth * 0.2)));
  const reviewWidth = contentWidth - resourceWidth - statusWidth;
  return renderBoundaryMapTable(
    ["Table", "Status", "Reviewed boundary details"],
    rows.map((row) => [
      row.resource,
      row.status,
      [...row.fields, ...row.review].join("\n"),
    ]),
    { widths: [resourceWidth, statusWidth, reviewWidth] },
  );
}

function renderNarrowBoundaryOverviewTable(
  rows: BoundaryOverviewTableRow[],
  width: number,
): string[] {
  const contentWidth = width - 7;
  const resourceWidth = Math.min(18, Math.max(12, Math.floor(contentWidth * 0.38)));
  const detailWidth = contentWidth - resourceWidth;
  return renderBoundaryMapTable(
    ["Table", "Reviewed boundary details"],
    rows.map((row) => [
      row.resource,
      [`Status: ${row.status}`, ...row.fields, ...row.review].join("\n"),
    ]),
    { widths: [resourceWidth, detailWidth] },
  );
}

function styleBoundaryOverviewTableLine(line: string, theme: TerminalTheme): string {
  if (line.startsWith("+")) return theme.dim(line);
  let styled = line.replace(
    /(ACTIVE \+ NEXT BOUNDARY|ACTIVE \+ NEXT|IN NEXT BOUNDARY|IN NEXT|NOT INCLUDED|BLOCKED|ACTIVE)/gu,
    (status) => status === "BLOCKED"
      ? theme.danger(status)
      : status === "NOT INCLUDED"
        ? theme.dim(status)
        : status === "IN NEXT BOUNDARY" || status === "IN NEXT"
          ? theme.warning(status)
          : theme.success(status),
  );
  styled = styled.replace(/UNRESOLVED/gu, (value) => theme.danger(value));
  styled = styled.replace(
    /(Table|Boundary status|Status|Field access|Scope and relationships|Reviewed boundary details)/gu,
    (header) => theme.bold(header),
  );
  styled = styled.replace(
    /(Review|Next(?: \d+)?|Needs|Repair):/gu,
    (label) => theme.warning(label),
  );
  return styled;
}

function plainRelationshipStateLabel(
  relationship: BoundaryResourceReviewSummary["relationships"][number],
): string {
  if (relationship.state === "active") return "ACTIVE";
  if (relationship.state === "included") return "IN NEXT BOUNDARY";
  return "AVAILABLE";
}

function riskBadge(
  view: BoundaryResourceReviewView,
  field: BoundaryResourceReviewView["fields"][number],
): string {
  if (isTrustedScopeField(view, field.name)) return "[trusted scope fixed; output tier reviewed]";
  if (field.primary_key) return "[record ID]";
  if (field.sensitivity.state === "high_confidence_sensitive") return "[sensitive]";
  if (field.sensitivity.state === "structurally_low_risk") return "[low structural risk]";
  return "[needs review]";
}

function relationshipStateLabel(
  relationship: BoundaryResourceReviewSummary["relationships"][number],
  theme: TerminalTheme,
): string {
  return relationship.state === "active"
    ? theme.success("ACTIVE")
    : relationship.state === "included"
      ? theme.warning("IN NEXT BOUNDARY")
      : theme.dim("AVAILABLE");
}

function selectedDerivedScopeEntries(
  resource: BoundaryResourceReviewSummary,
): Array<{ scope: DerivedScopePath; roles: string[] }> {
  const entries = [
    ...(resource.derived_tenant_scope?.selected
      ? [{ scope: resource.derived_tenant_scope.selected, role: "tenant scope" }]
      : []),
    ...(resource.derived_principal_scope?.selected
      ? [{ scope: resource.derived_principal_scope.selected, role: "principal scope" }]
      : []),
  ];
  const grouped = new Map<string, { scope: DerivedScopePath; roles: string[] }>();
  for (const entry of entries) {
    const key = `${entry.scope.path_id}\u0000${entry.scope.ancestor_column}`;
    const current = grouped.get(key);
    if (current) current.roles.push(entry.role);
    else grouped.set(key, { scope: entry.scope, roles: [entry.role] });
  }
  return [...grouped.values()].sort((left, right) =>
    derivedScopeDepth(left.scope) - derivedScopeDepth(right.scope)
      || left.scope.path_id.localeCompare(right.scope.path_id)
      || left.roles.join("+").localeCompare(right.roles.join("+")));
}

function resourceState(
  resource: BoundaryResourceReviewSummary,
  theme: TerminalTheme,
): { text: string; style: (value: string) => string } {
  if (resource.status !== "draft_read") {
    return {
      text: `[blocked: ${resource.blockers.length} issue${resource.blockers.length === 1 ? "" : "s"}]`,
      style: theme.danger,
    };
  }
  if (resource.active && !resource.included) {
    return {
      text: "[active; removal staged]",
      style: theme.warning,
    };
  }
  if (resource.active && resource.included) {
    if (resource.operation_repair_fields?.length) {
      return {
        text: "[active + reviewed; more operations optional]",
        style: theme.success,
      };
    }
    return resource.risk_count
      ? {
        text: "[active + updated sign-off needed]",
        style: theme.warning,
      }
      : { text: "[active + reviewed]", style: theme.success };
  }
  if (!resource.included) return { text: "[available]", style: theme.dim };
  if (resource.operation_repair_fields?.length) {
    return {
      text: "[reviewed; more operations optional]",
      style: theme.success,
    };
  }
  if (resource.risk_count) {
    return {
      text: "[table sign-off needed]",
      style: theme.warning,
    };
  }
  return { text: "[reviewed]", style: theme.success };
}

function focusedAccessResourceState(
  resource: BoundaryResourceReviewSummary,
  theme: TerminalTheme,
): { text: string; style: (value: string) => string } {
  if (resource.status !== "draft_read" || !resource.included || resource.active) {
    return resourceState(resource, theme);
  }
  return {
    text: "[draft changed - activate to use]",
    style: theme.warning,
  };
}

function reviewItemLabel(resourceId: string, decision: string): string {
  const prefix = `${resourceId}: `;
  const detail = decision.startsWith(prefix) ? decision.slice(prefix.length) : decision;
  return detail.charAt(0).toUpperCase() + detail.slice(1);
}

function reviewItemPresentation(
  resourceId: string,
  decision: string,
): { label: string; detail: string } {
  const original = reviewItemLabel(resourceId, decision);
  const normalized = original.toLowerCase();
  if (normalized.includes("visible and kept-out")) {
    return {
      label: "Column access",
      detail: "Which fields are model-visible, Runner-output-only, or kept out.",
    };
  }
  if (normalized.includes("field permissions")) {
    return {
      label: "Allowed operations",
      detail: "What the agent may filter, sort, group, count, or measure.",
    };
  }
  if (normalized.includes("minimum cohort")) {
    return {
      label: "Privacy limits",
      detail: "Minimum group size plus extraction and differencing limits.",
    };
  }
  if (normalized.includes("principal scope")) {
    const field = original.match(/principal scope\s+([^\s]+)/i)?.[1];
    return {
      label: `User row scope${field ? `: ${field}` : ""}`,
      detail: "Runner supplies the trusted user value outside AI requests.",
    };
  }
  if (normalized.includes("tenant key")) {
    const field = original.match(/tenant key\s+([^\s]+)/i)?.[1];
    return {
      label: `Customer row scope${field ? `: ${field}` : ""}`,
      detail: "Runner supplies the trusted customer value outside AI requests.",
    };
  }
  if (normalized.includes("relationship")) {
    const target = original.match(/\son\s+([^\s]+)/i)?.[1];
    return {
      label: `Related-table path${target ? `: ${target}` : ""}`,
      detail: "Which proven relationship is allowed and how row fan-out is bounded.",
    };
  }
  return {
    label: original,
    detail: "Review this exact table setting before signing off the table.",
  };
}

function styleTier(
  theme: TerminalTheme,
  tier: BoundaryFieldTier,
  value: string,
): string {
  if (tier === "visible") return theme.visible(value);
  if (tier === "withheld_from_model") return theme.runnerOnly(value);
  return theme.keptOut(value);
}

function styleTierConsequence(theme: TerminalTheme, tier: BoundaryFieldTier): string {
  return styleTier(theme, tier, tierConsequence(tier));
}

function discoveryReadinessLines(overview: BoundaryReviewOverview | undefined, theme: TerminalTheme): string[] {
  if (!overview?.discovery_concerns?.length) return [];
  return [theme.warning("CLIENT READINESS: BLOCKED - complete access details exceed the supported size."),
    theme.dim("Recorded review decisions are not activation readiness. C inspects the blocker; W revises with the model. No access is granted.")];
}

function noticeStyle(
  theme: TerminalTheme,
  tone: BoundaryAccessNotice["tone"],
): (value: string) => string {
  if (tone === "danger") return theme.danger;
  if (tone === "warning") return theme.warning;
  return theme.success;
}

function formatBoundaryAccessNotice(
  theme: TerminalTheme,
  notice: BoundaryAccessNotice,
): string[] {
  const style = noticeStyle(theme, notice.tone);
  return [
    style(safeTerminalText(notice.title)),
    ...notice.lines.map((line) => style(safeTerminalText(line))),
    ...(notice.footer ? [theme.warning(safeTerminalText(notice.footer))] : []),
  ];
}

export function terminalTheme(
  color: boolean,
  options: { brand?: boolean } = {},
) {
  const brand = color && options.brand ? terminalBrandPalette() : undefined;
  const style = (codes: string) => (value: string) =>
    color ? `\u001b[${codes}m${value}\u001b[0m` : value;
  const code = (role: keyof NonNullable<typeof brand>, fallback: string) =>
    brand?.[role] ?? fallback;
  return {
    title: style(code("title", "1;36")),
    bold: style(code("bold", "1")),
    italic: style(code("italic", "3")),
    dim: style(code("dim", "2")),
    key: style(code("key", "1;36")),
    focus: style(code("focus", "1;96")),
    success: style(code("success", "1;32")),
    warning: style(code("warning", "1;33")),
    danger: style(code("danger", "1;31")),
    scope: style(code("scope", "1;35")),
    value: style(code("value", "36")),
    relationship: style(code("relationship", "1;34")),
    visible: style(code("visible", "1;32")),
    runnerOnly: style(code("runnerOnly", "1;33")),
    keptOut: style(code("keptOut", "2")),
  };
}

export function packTerminalActions(actions: string[], width: number): string[] {
  const gap = "   ";
  const lines: string[] = [];
  let current = "";
  for (const action of actions) {
    const candidate = current ? `${current}${gap}${action}` : action;
    if (current && styledTerminalWidth(candidate) > width) {
      lines.push(current);
      current = action;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function styledTerminalWidth(value: string): number {
  return Array.from(value.replace(/\u001b\[[0-9;]*m/g, "")).length;
}

function terminalFrameRows(lines: string[], width: number): number {
  return lines.reduce(
    (total, line) => total + wrapStyledTerminalLine(line, width).length,
    0,
  );
}

function formatTextPromptWithBack(prompt: string, theme: TerminalTheme): string {
  const normalized = prompt.trimEnd();
  // Styled prompts can end in one or more SGR restore sequences after the
  // visible colon. Remove that visible colon without dropping the restores.
  const label = normalized.replace(
    /:((?:\u001b\[[0-9;]*m)*)$/u,
    "$1",
  ).trimEnd();
  return `${label} ${theme.key("[Esc Back]")}: `;
}

function terminalPromptWithContext(
  prompt: string,
  context: string[] | undefined,
  theme: TerminalTheme,
): string {
  if (!context?.length) return prompt;
  const lines = [...context];
  while (lines.at(-1)?.trim() === "") lines.pop();
  const heading = lines.findIndex((line) => line.trim().length > 0);
  const rendered = lines.map((line, index) =>
    index === heading && isTerminalPromptHeading(line)
      ? theme.title(line)
      : line);
  return [...rendered, "", prompt].join("\n");
}

function isTerminalPromptHeading(value: string): boolean {
  const trimmed = value.trim();
  return /[A-Z]/u.test(trimmed)
    && trimmed === trimmed.toUpperCase()
    && /^[A-Z0-9][A-Z0-9 +&/():.'-]*$/u.test(trimmed);
}

function isTrustedScopeField(view: BoundaryResourceReviewView, field: string): boolean {
  const candidate = view.candidate ?? view.generated_candidate;
  return candidate?.tenant_key === field || candidate?.principal_key === field;
}

function boundedWindowStart(selected: number, length: number, size: number): number {
  if (length <= size) return 0;
  return Math.min(Math.max(0, selected - Math.floor(size / 2)), length - size);
}

function isCancel(key: Keypress): boolean {
  return (key.ctrl === true && key.name === "c")
    || (key.ctrl === true && key.name === "d")
    || isEscapeKey(key)
    || (key.ctrl !== true && key.name?.toLowerCase() === "q");
}

function isBackToResources(key: Keypress): boolean {
  return key.name === "backspace"
    || isEscapeKey(key)
    || (key.ctrl !== true && key.name?.toLowerCase() === "b");
}

function isBackKey(key: Keypress): boolean {
  return key.name === "backspace"
    || isEscapeKey(key)
    || (key.ctrl !== true && key.name?.toLowerCase() === "b");
}

function isEscapeKey(key: Keypress): boolean {
  return key.name === "escape" || key.sequence === "\u001b";
}

function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}
