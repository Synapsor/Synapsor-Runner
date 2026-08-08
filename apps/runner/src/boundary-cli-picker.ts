import readline from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import type {
  BoundaryResourceReviewSummary,
  BoundaryResourceReviewView,
} from "./boundary-review-mutation.js";
import {
  SHARED_REFERENCE_ACKNOWLEDGEMENT,
  type DerivedScopePath,
} from "./auto-boundary.js";
import {
  readTerminalActivationConfirmation,
  readTerminalTextWithEscape,
} from "./terminal-prompt.js";
import {
  padTerminalLine,
  terminalContentWidth,
} from "./terminal-layout.js";
import { formatDerivedScopePath } from "./derived-scope-display.js";
import { blockedTenantScopeGuidance } from "./boundary-scope-guidance.js";

export type BoundaryFieldTier = "visible" | "withheld_from_model" | "kept_out";
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
  | `enum:${string}`
  | "back"
  | "privacy"
  | undefined;

export type BoundaryFieldEnumEditResult = string[] | "back" | undefined;

export type BoundaryBlockedResolution =
  | ({ row_identity: string } & (
      | { tenant_key: string; tenant_scope_path?: never }
      | { tenant_key?: never; tenant_scope_path: string }
      | {
        tenant_key?: never;
        tenant_scope_path?: never;
        shared_reference_scope: typeof SHARED_REFERENCE_ACKNOWLEDGEMENT;
      }
    ))
  | "back"
  | undefined;

export type BoundaryResourceSelection =
  | {
      resource_id: string;
      action: "add" | "review" | "remove" | "signoff" | "privacy" | "analytics";
    }
  | {
      action: "create" | "rename" | "confirm" | "limits" | "privacy_all";
    }
  | {
      action: "switch" | "delete" | "disable";
      boundary_name: string;
    };

export type BoundaryReviewOverview = {
  confirmed_decisions: number;
  outstanding_decisions: number;
  outstanding_resource_decisions: number;
  outstanding_boundary_decisions: number;
  resources_requiring_signoff: number;
  boundaries?: Array<{
    name: string;
    selected: boolean;
    active: boolean;
    matches_active_digest: boolean;
    table_count: number;
    outstanding_decisions: number;
    policy_review_required?: boolean;
  }>;
};

export type BoundaryReviewInteractiveSession = {
  chooseResource(
    resources: BoundaryResourceReviewSummary[],
    overview?: BoundaryReviewOverview,
    options?: {
      initialView?: "boundaries" | "access";
      startingBoundaryName?: string;
      startAtBoundaryList?: boolean;
      initialResourceId?: string;
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
  resolveBlockedResource?(
    view: BoundaryResourceReviewView,
  ): Promise<BoundaryBlockedResolution>;
  promptText(prompt: string): Promise<string | undefined>;
  confirm(prompt: string, options?: { defaultValue?: boolean }): Promise<boolean | undefined>;
  confirmActivation?(prompt: string): Promise<boolean | undefined>;
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
  derived_scope?: DerivedScopePath;
};

const tierOrder: BoundaryFieldTier[] = ["visible", "withheld_from_model", "kept_out"];

type TerminalTheme = ReturnType<typeof terminalTheme>;

export function createBoundaryReviewInteractiveSession(
  input: ReadStream = process.stdin,
  output: WriteStream = process.stderr,
): BoundaryReviewInteractiveSession {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive boundary review requires a real terminal.");
  }
  const theme = terminalTheme(output.isTTY && !("NO_COLOR" in process.env));
  return {
    chooseResource: (resources, overview, options) =>
      chooseResource(resources, overview, options, input, output),
    editFieldTiers: (view, options) => editFieldTiers(view, options, input, output),
    editFieldEnumValues: (view, field) => editFieldEnumValues(view, field, input, output),
    resolveBlockedResource: (view) => resolveBlockedResource(view, input, output),
    promptText: (prompt) => readTerminalTextWithEscape(
      formatTextPromptWithBack(prompt, theme),
      input,
      output,
    ),
    confirm: async (prompt, options = {}) => {
      const defaultValue = options.defaultValue === true;
      const answer = await readTerminalTextWithEscape(
        `${theme.bold(prompt)} ${theme.key(defaultValue ? "[Y/n]" : "[y/N]")} ` +
          `${theme.key("[Esc Back]")}: `,
        input,
        output,
      );
      if (answer === undefined) return undefined;
      if (!answer) return defaultValue;
      return answer.toLowerCase() === "y" || answer.toLowerCase() === "yes";
    },
    confirmActivation: (prompt) => readTerminalActivationConfirmation(
      theme.bold(prompt),
      input,
      output,
    ),
  };
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
    })),
    ...(view.shared_reference_scope?.eligible ? [{
      kind: "shared_reference" as const,
      value: SHARED_REFERENCE_ACKNOWLEDGEMENT,
      label: "Shared reference - same reviewed rows for every tenant",
      selected: Boolean(view.shared_reference_scope.selected),
    }] : []),
  ];
  const theme = terminalTheme(output.isTTY && !("NO_COLOR" in process.env));
  const scopeGuidance = tenantOptions.length === 0
    ? blockedTenantScopeGuidance(view)
    : undefined;
  let selectedDecision = view.row_identity.selected ? 1 : 0;
  let rowIndex = Math.max(0, rowCandidates.indexOf(view.row_identity.selected ?? rowCandidates[0] ?? ""));
  let tenantIndex = Math.max(0, tenantOptions.findIndex((option) => option.selected));

  return withRawKeys(input, output, async (nextKey, render) => {
    while (true) {
      const rowValue = rowCandidates[rowIndex];
      const tenantOption = tenantOptions[tenantIndex];
      const resolvable = Boolean(rowValue && tenantOption);
      const selectedValue = selectedDecision === 0 ? rowValue : tenantOption?.value;
      const evidence = selectedDecision === 0
        ? view.row_identity.alternatives_considered
          .find((candidate) => candidate.value === selectedValue)?.evidence[0]
          ?? view.row_identity.evidence.find((item) => item.detail.includes(String(selectedValue)))?.detail
        : tenantOption?.kind === "derived"
          ? "database foreign key is non-null and points many-to-one to a unique key on the scoped ancestor"
          : tenantOption?.kind === "shared_reference"
            ? "human confirmation is required because Runner will apply no tenant predicate to this table"
            : view.tenant_key.alternatives_considered
            .find((candidate) => candidate.value === selectedValue)?.evidence[0]
            ?? view.tenant_key.evidence.find((item) => item.detail.includes(String(selectedValue)))?.detail;
      render([
        theme.title(`RESOLVE TABLE ACCESS - ${safeTerminalText(view.resource_id)}`),
        "Runner needs one database-backed record ID and one reviewed row-scope choice.",
        theme.dim("Choose a direct tenant column, a proven path, or Shared reference."),
        theme.dim("Shared reference means every tenant receives the same reviewed rows."),
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
          "Tenant isolation",
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
              : "No tenant-isolation candidate was found in the inspected structure.",
          )]),
        ...(resolvable
          ? [
              "",
              `${theme.key("Up/Down")} Choose decision   ${theme.key("Left/Right")} Change value`,
              `${theme.key("Enter")} Save choices and review columns   ${theme.key("B/Esc")} Back`,
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
              `${theme.key("B/Esc")} Back   ${theme.key("Q")} Quit`,
            ]),
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
      if ((key.name === "return" || key.name === "enter") && rowValue && tenantOption) {
        if (tenantOption.kind === "direct") {
          return { row_identity: rowValue, tenant_key: tenantOption.value };
        }
        if (tenantOption.kind === "derived") {
          return { row_identity: rowValue, tenant_scope_path: tenantOption.value };
        }
        return {
          row_identity: rowValue,
          shared_reference_scope: SHARED_REFERENCE_ACKNOWLEDGEMENT,
        };
      }
    }
  });
}

function uniqueCandidates(selected: string | undefined, candidates: string[]): string[] {
  return [...new Set([...(selected ? [selected] : []), ...candidates])];
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
  } | undefined,
  input: ReadStream,
  output: WriteStream,
): Promise<BoundaryResourceSelection | undefined> {
  if (!resources.length) throw new Error("The boundary review contains no inspected tables or views.");
  const theme = terminalTheme(output.isTTY && !("NO_COLOR" in process.env));
  let selected = 0;
  let selectedBoundary = 0;
  let showMap = false;
  let showReviewItems = false;
  const focusedAccess = options?.initialView === "access";
  const startingBoundaryName = options?.startingBoundaryName;
  let showBoundaryList = options?.startAtBoundaryList === true || !focusedAccess;
  let resourceView: ResourcePickerView = resources.some(
    (resource) => resource.included || resource.active,
  ) ? "boundary" : "all";
  let initialResourceId = options?.initialResourceId;
  let mapOffset = 0;
  let startingTableNotice: string | undefined;
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
        const ancestorRequired = resources.filter((resource) =>
          resource.first_table_startable === false).length;
        const unavailable = resources.length - eligible - ancestorRequired;
        render([
          theme.title(`CHOOSE FIRST TABLE - ${safeTerminalText(startingBoundaryName)}`),
          "A new boundary starts with the table you choose. Nothing is copied from another boundary.",
          theme.dim("Column access opens immediately after this choice; no authority is active yet."),
          "",
          ...visible.map((resource, index) => {
            const absolute = start + index;
            const details = resource.first_table_startable === false
              ? `START FROM ANCESTOR · ${resource.first_table_guidance ?? "add its scoped ancestor first"}`
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
            `${ancestorRequired} add after ancestor · ${unavailable} unavailable.`,
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
              startingTableNotice = `${safeTerminalText(highlighted.resource_id)} cannot be the first table. ` +
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
        const mapLines = boundaryOverviewMapLines(resources, theme);
        const pageSize = 15;
        mapOffset = Math.min(mapOffset, Math.max(0, mapLines.length - pageSize));
        render([
          theme.title("WHOLE BOUNDARY MAP"),
          boundaryOverviewSummary(resources),
          `${theme.key("Up/Down")} Scroll   ${theme.key("B/Esc")} Back   ${theme.key("Q")} Quit`,
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
        if (isCancel(key)) return undefined;
        if (key.name === "up") mapOffset = Math.max(0, mapOffset - 1);
        if (key.name === "down") {
          mapOffset = Math.min(Math.max(0, mapLines.length - pageSize), mapOffset + 1);
        }
        continue;
      }
      if (showBoundaryList) {
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
        const selectedBoundaryHasPendingChange = highlightedBoundary.selected
          && (highlightedBoundary.policy_review_required
            || !highlightedBoundary.active
            || !highlightedBoundary.matches_active_digest);
        if (focusedAccess && !activeResources.length && boundaryEntries.length === 1) {
          render([
            theme.title("YOUR DATA BOUNDARY"),
            "A boundary is the reviewed tables, columns, relationships, and limits",
            "that your AI cannot exceed.",
            "",
            theme.bold(firstRunBoundaryRow("NAME", "STATUS", "TABLES", "AI ACCESS")),
            theme.focus(firstRunBoundaryRow(
              candidateBoundaryName,
              "DRAFT",
              includedCount,
              "NOT ACTIVE",
            )),
            "",
            theme.bold(
              `${theme.key("Enter/C")} Review + activate`,
            ),
            ...packTerminalActions([
              `${theme.key("E")} Edit access`,
              `${theme.key("A")} New boundary`,
              `${theme.key("P")} Privacy for all tables`,
              `${theme.key("L")} Ranked limit`,
              `${theme.key("M")} Map`,
              `${theme.key("N")} Rename`,
              `${theme.key("Q")} Quit`,
            ], terminalContentWidth(output.columns)),
            "",
            theme.dim(
              "Activation returns here so you can keep editing. Press Q when finished " +
              "to choose how to ask.",
            ),
            theme.dim("The draft grants no AI access until you confirm it."),
          ]);
          const key = await nextKey();
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
            mapOffset = 0;
            continue;
          }
          if (key.name === "a") return { action: "create" };
          if (key.name === "p") return { action: "privacy_all" };
          if (key.name === "l") return { action: "limits" };
          if (key.name === "n") return { action: "rename" };
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
            status,
            entry.table_count,
            entry.active ? "ACTIVE" : "NONE",
          );
          return index === selectedBoundary ? theme.focus(line) : line;
        });
        render([
          theme.title("BOUNDARIES"),
          "Each boundary is a saved set of reviewed tables, fields, relationships, and limits.",
          theme.dim("One boundary is selected for editing; only an explicitly activated boundary grants Explore access."),
          "",
          theme.bold(savedBoundaryRow("", "NAME", "STATUS", "TABLES", "AUTHORITY")),
          ...rows,
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
                : [theme.bold(`${theme.key("C")} reviews and activates the exact disabled update.`)]),
            ]
            : []),
          "",
          ...packTerminalActions([
            `${theme.key("Up/Down")} Select`,
            `${theme.key("Enter")} ${highlightedBoundary.selected
              ? (focusedAccess ? "Edit" : "Review")
              : "Open"}`,
            `${theme.key("C")} ${focusedAccess ? "Review + activate" : "Complete review"}`,
            `${theme.key("A")} New boundary`,
            `${theme.key("P")} Privacy for all tables`,
            `${theme.key("L")} Ranked limit`,
            `${theme.key("M")} Map`,
            `${theme.key("N")} Rename`,
            `${theme.key("X")} Delete`,
            ...(highlightedBoundary.active ? [`${theme.key("D")} Deactivate active boundary`] : []),
            `${theme.key("Q")} Quit`,
          ], terminalContentWidth(output.columns)),
          theme.dim("New boundaries start with a table you choose, then open its column access for review."),
          theme.dim("Activation adds or updates this reviewed boundary. Each query remains inside one boundary."),
        ]);
        const key = await nextKey();
        if (key.name === "up") {
          selectedBoundary = (selectedBoundary - 1 + boundaryEntries.length) % boundaryEntries.length;
          continue;
        }
        if (key.name === "down") {
          selectedBoundary = (selectedBoundary + 1) % boundaryEntries.length;
          continue;
        }
        if (key.name === "return" || key.name === "enter") {
          if (!highlightedBoundary.selected) {
            return { action: "switch", boundary_name: highlightedBoundary.name };
          }
          showBoundaryList = false;
          continue;
        }
        if (key.name === "m") {
          showMap = true;
          mapOffset = 0;
          continue;
        }
        if (key.name === "a") return { action: "create" };
        if (key.name === "p") return { action: "privacy_all" };
        if (key.name === "l") return { action: "limits" };
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
      const candidateStatus = candidateIsActive
        ? theme.success("ACTIVE")
        : candidateHasPendingChange
          ? theme.warning("ACTIVE + DRAFT EDITS")
        : reviewLeft === "Complete"
          ? theme.success("REVIEWED - NOT ACTIVE")
        : theme.warning("DRAFT - NO ACCESS");
      const displayedReviewLeft = focusedAccess && reviewLeft !== "Complete"
        ? "FINAL REVIEW PENDING"
        : safeTerminalText(reviewLeft);
      const actionWidth = terminalContentWidth(output.columns);
      const selectedTableActions = [
        `${theme.key("Up/Down")} Select`,
        `${theme.key("Enter")} ${resourceView === "boundary" ? "Edit columns" : "Review and add"}`,
        ...(resourceView === "boundary" && !focusedAccess
          ? [`${theme.key("S")} Sign off table`]
          : []),
        ...(resourceView === "boundary"
          ? [`${theme.key("R")} Remove from draft`]
          : []),
        ...(focusedAccess && resourceView === "boundary"
          ? [`${theme.key("P")} Privacy (minimum group ${
            highlighted.minimum_cohort_size ?? 5
          }${highlighted.minimum_cohort_overridden ? ", owner override" : ""})`]
          : []),
        ...(focusedAccess && resourceView === "boundary" && highlighted.included
          ? [`${theme.key("G")} Reviewed metrics and numeric bands`]
          : []),
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
        `${theme.key("L")} Ranked limits`,
        `${theme.key("C")} ${focusedAccess ? "Review + activate" : "Complete review"}`,
        `${theme.key("Q")} Quit`,
      ];
      render([
        theme.title(
          focusedAccess
            ? `EDIT ACCESS - ${safeTerminalText(highlighted.candidate_boundary_name)}`
            : safeTerminalText(highlighted.candidate_boundary_name),
        ),
        `${candidateStatus}  ${includedCount} ` +
          `${plural(includedCount, "table", "tables")}  ${displayedReviewLeft}`,
        ...(candidateHasPendingChange
          ? [
            theme.warning("1 PENDING BOUNDARY CHANGE IS NOT ACTIVE"),
            theme.bold(`${theme.key("C")} reviews and activates the exact disabled update.`),
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
            theme.bold(`${theme.key("C")} reviews and activates this whole boundary once. No separate table sign-off.`),
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
          : []),
        "",
        theme.bold("SELECTED TABLE"),
        ...packTerminalActions(selectedTableActions, actionWidth),
        theme.bold("BOUNDARY"),
        ...packTerminalActions(boundaryActions, actionWidth),
        theme.dim("Edits stay disabled until separate activation."),
      ]);
      const key = await nextKey();
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
        mapOffset = Math.max(0, selected - 2);
        continue;
      }
      if (key.name === "p") {
        if (focusedAccess && resourceView === "boundary") {
          return { resource_id: highlighted.resource_id, action: "privacy" };
        }
        showReviewItems = true;
        continue;
      }
      if (key.name === "g" && focusedAccess && resourceView === "boundary" && highlighted.included) {
        return { resource_id: highlighted.resource_id, action: "analytics" };
      }
      if (key.name === "n") return { action: "rename" };
      if (key.name === "l") return { action: "limits" };
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
      }
      if (key.name === "down") selected = (selected + 1) % listedResources.length;
      if (key.name === "r" && highlighted.included) {
        return { resource_id: highlighted.resource_id, action: "remove" };
      }
      if (!focusedAccess && key.name === "s" && highlighted.included) {
        return { resource_id: highlighted.resource_id, action: "signoff" };
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
  const theme = terminalTheme(output.isTTY && !("NO_COLOR" in process.env));
  let selected = 0;
  let showMap = false;
  return withRawKeys<BoundaryFieldTierEditResult>(input, output, async (nextKey, render) => {
    while (true) {
      if (showMap) {
        render([
          ...boundaryResourceMapLines(view, tiers, theme),
          "",
          `${theme.key("B/Esc")} Back to columns   ${theme.key("Q")} Quit`,
        ]);
        const key = await nextKey();
        if (key.name === "backspace" || (key.name === "b" && key.sequence === "b")) return "back";
        if (key.name === "m" || isBackKey(key) || key.name === "return" || key.name === "enter") {
          showMap = false;
          continue;
        }
        if (isCancel(key)) return undefined;
        continue;
      }
      const start = boundedWindowStart(selected, fields.length, 12);
      const visible = fields.slice(start, start + 12);
      const highlighted = fields[selected]!;
      const enumValues = reviewableEnumValues(view, highlighted);
      const reviewedEnumValues = enumValues
        ? currentReviewedEnumValues(view, highlighted, enumValues)
        : undefined;
      const tableWidth = Math.max(36, Math.min(terminalContentWidth(output.columns), 116));
      const accessLayout = fieldAccessLayout(tableWidth);
      render([
        theme.title(`REVIEW COLUMNS - ${safeTerminalText(view.resource_id)}`),
        `${theme.key("Up/Down")} Navigate   ${theme.key("Space")} Change access   ` +
          `${theme.key("Enter")} ${options?.focusedAccess ? "Save draft choices" : "Continue to table sign-off"}`,
        `${theme.key("V/W/K")} Set directly   ${theme.key("M")} View access map   ` +
          `${theme.key("B/Esc")} ${options?.focusedAccess ? "Back to boundary tables" : "Back"}   ` +
          `${theme.key("Q")} Quit`,
        `${theme.key("P")} Privacy threshold: minimum group ${
          (view.candidate ?? view.generated_candidate)!.minimum_cohort_size
        } (${(view.candidate ?? view.generated_candidate)!.minimum_cohort_size === 1 ? "suppression off" : "small groups withheld"})`,
        `${theme.key("O")} User/owner row limit: ${
          (view.candidate ?? view.generated_candidate)!.principal_key
            ?? ((view.candidate ?? view.generated_candidate)!.principal_scope
              ? formatDerivedScopePath((view.candidate ?? view.generated_candidate)!.principal_scope!)
              : "not configured")
        }`,
        ...(enumValues
          ? [`${theme.key("E")} Edit allowed values for selected column: ${reviewedEnumValues!.length} of ${enumValues.length}`]
          : []),
        "Space cycles: MODEL + RUNNER -> RUNNER ONLY -> KEPT OUT",
        "",
        theme.bold(fieldAccessRow("COLUMN", "TYPE", "ACCESS", "REVIEW NOTE", accessLayout)),
        ...visible.map((field, index) => {
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
        }),
        "",
        theme.bold(`Selected access: ${tierLabel(tiers[highlighted.name]!)}`),
        theme.dim(
          `Selected column: ${safeTerminalText(highlighted.name)} · ` +
          `${safeTerminalText(highlighted.data_type)} · ${compactRiskBadge(view, highlighted)}`,
        ),
        isTrustedScopeField(view, highlighted.name)
          ? theme.scope(trustedScopeTierConsequence(tiers[highlighted.name]!))
          : styleTierConsequence(theme, tiers[highlighted.name]!),
        theme.dim(
          options?.focusedAccess
            ? "Enter stages these choices in the disabled boundary. Final activation is one separate confirmation."
            : "Enter continues to one plain-language table sign-off. Nothing activates from this screen.",
        ),
      ]);
      const key = await nextKey();
      if (isBackToResources(key)) return "back";
      if (isCancel(key)) return undefined;
      if (key.name === "m") {
        showMap = true;
        continue;
      }
      if (key.name === "p") return "privacy";
      if (key.name === "o") return { action: "principal", tiers: { ...tiers } };
      if (key.name === "e" && enumValues) {
        return {
          action: "enum",
          field: highlighted.name,
          tiers: { ...tiers },
        };
      }
      if (key.name === "up") selected = (selected - 1 + fields.length) % fields.length;
      if (key.name === "down") selected = (selected + 1) % fields.length;
      if (key.name === "space" || key.name === "right") {
        tiers[highlighted.name] = cycleTier(tiers[highlighted.name]!, 1);
      }
      if (key.name === "left") {
        tiers[highlighted.name] = cycleTier(tiers[highlighted.name]!, -1);
      }
      if (key.name === "v") tiers[highlighted.name] = "visible";
      if (key.name === "w") tiers[highlighted.name] = "withheld_from_model";
      if (key.name === "k") tiers[highlighted.name] = "kept_out";
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
  const theme = terminalTheme(output.isTTY && !("NO_COLOR" in process.env));
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
  if (candidate?.kept_out_fields.includes(field)) return "kept_out";
  if (candidate?.model_withheld_fields?.includes(field)) return "withheld_from_model";
  if (candidate?.selectable_fields.includes(field)) return "visible";
  return "kept_out";
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
    return "Model + Runner: reviewed values appear locally and may be sent to the configured model.";
  }
  if (tier === "withheld_from_model") {
    return "Raw values: Runner only. Raw values stay local or become response-only tokens; reviewed derived results remain usable.";
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
  options: { color?: boolean } = {},
): string {
  const tiers = Object.fromEntries(view.fields.map((field) => [
    field.name,
    currentFieldTier(view, field.name),
  ])) as Record<string, BoundaryFieldTier>;
  return `${boundaryResourceMapLines(
    view,
    tiers,
    terminalTheme(options.color === true && !("NO_COLOR" in process.env)),
  ).join("\n")}\n`;
}

export function formatBoundaryOverviewMap(
  resources: BoundaryResourceReviewSummary[],
  options: {
    color?: boolean;
    exhaustive?: boolean;
    commandName?: string;
  } = {},
): string {
  const theme = terminalTheme(options.color === true && !("NO_COLOR" in process.env));
  if (!options.exhaustive) {
    return [
      theme.title("BOUNDARY OVERVIEW"),
      ...boundaryOverviewFirstRunLines(
        resources,
        theme,
        options.commandName ?? "synapsor-runner",
      ),
      "",
    ].join("\n");
  }
  return [
    theme.title("WHOLE BOUNDARY MAP (ALL TABLES)"),
    theme.dim("Complete inspected catalog. Use boundary review --map for the concise overview."),
    boundaryOverviewSummary(resources),
    "",
    ...boundaryOverviewMapLines(resources, theme),
    "",
  ].join("\n");
}

function boundaryResourceMapLines(
  view: BoundaryResourceReviewView,
  tiers: Record<string, BoundaryFieldTier>,
  theme: TerminalTheme,
): string[] {
  const candidate = view.candidate ?? view.generated_candidate;
  if (!candidate) {
    const scopeGuidance = blockedTenantScopeGuidance(view);
    return [
      theme.title(`TABLE ACCESS MAP - ${safeTerminalText(view.resource_id)}`),
      theme.warning("Blocked: record identity or trusted scope is unresolved."),
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
  const groupedFields = new Map<BoundaryFieldTier, string[]>(tierOrder.map((tier) => [tier, []]));
  for (const field of [...view.fields].sort((left, right) => left.name.localeCompare(right.name))) {
    groupedFields.get(tiers[field.name] ?? "kept_out")!.push(field.name);
  }
  const lines = [
    theme.title(`TABLE ACCESS MAP - ${safeTerminalText(view.resource_id)}`),
    theme.dim(hasStagedChanges
      ? "Preview includes unsaved access choices. This view cannot save or activate authority."
      : "Current disabled review candidate. This view cannot save or activate authority."),
    "",
    theme.bold(safeTerminalText(view.resource_id)),
    `|-- Record identity: ${safeTerminalText(candidate.primary_key)}`,
    `|-- Trusted tenant scope: ${candidate.tenant_key
      ? `${safeTerminalText(candidate.tenant_key)} (direct; bound outside model arguments)`
      : candidate.tenant_scope
        ? `${safeTerminalText(formatDerivedScopePath(candidate.tenant_scope))} (mandatory relationship path)`
        : "Shared reference (no tenant predicate; reviewed field/privacy controls still apply)"}`,
    `|-- Trusted principal scope: ${candidate.principal_key
      ? `${safeTerminalText(candidate.principal_key)} (bound outside model arguments)`
      : candidate.principal_scope
        ? `${safeTerminalText(formatDerivedScopePath(candidate.principal_scope))} (mandatory relationship path)`
        : "not configured"}`,
    ...mapTierLines(view, candidate, "visible", groupedFields.get("visible")!, theme),
    ...mapTierLines(
      view,
      candidate,
      "withheld_from_model",
      groupedFields.get("withheld_from_model")!,
      theme,
    ),
    ...mapTierLines(view, candidate, "kept_out", groupedFields.get("kept_out")!, theme),
    ...mapRelationshipLines(candidate, theme),
    `\`-- Aggregate guard: minimum group size ${candidate.minimum_cohort_size}; small groups are suppressed`,
  ];
  return lines;
}

function firstTableIsStartable(resource: BoundaryResourceReviewSummary): boolean {
  if (resource.first_table_startable === false) return false;
  return resource.status === "draft_read" || resource.inline_resolution_available === true;
}

function mapTierLines(
  view: BoundaryResourceReviewView,
  candidate: NonNullable<BoundaryResourceReviewView["candidate"]>,
  tier: BoundaryFieldTier,
  fields: string[],
  theme: TerminalTheme,
): string[] {
  const heading = tier === "visible"
    ? "Model + Runner fields"
    : tier === "withheld_from_model"
      ? "Runner-output-only fields"
      : "Kept-out fields";
  const consequence = tier === "visible"
    ? "real values may reach the model"
    : tier === "withheld_from_model"
      ? "raw values stay local or tokenized; reviewed derived results remain usable"
      : "unavailable to every read operation";
  const lines = [`|-- ${styleTier(theme, tier, heading)} (${consequence})`];
  if (!fields.length) return [...lines, "|   `-- (none)"];
  fields.forEach((field, index) => {
    const branch = index === fields.length - 1 ? "`--" : "|--";
    const operations = tier === "kept_out"
      ? "no operations"
      : boundaryFieldOperations(candidate, field);
    const sourceField = view.fields.find((item) => item.name === field);
    const risk = sourceField ? riskBadge(view, sourceField) : "";
    lines.push(
      `|   ${branch} ${safeTerminalText(field)}: ${operations}${risk ? ` ${risk}` : ""}`,
    );
  });
  return lines;
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
  if (candidate.count_distinct_fields.includes(field)) operations.push("count distinct");
  const buckets = candidate.time_bucket_fields[field];
  if (buckets?.length) operations.push(`time(${buckets.join("/")})`);
  return operations.length ? operations.join(", ") : "no reviewed operation";
}

function mapRelationshipLines(
  candidate: NonNullable<BoundaryResourceReviewView["candidate"]>,
  theme: TerminalTheme,
): string[] {
  const lines = [`|-- ${theme.relationship("Reviewed relationships")}`];
  if (!candidate.relationships.length) return [...lines, "|   `-- (none)"];
  candidate.relationships.forEach((relationship, index) => {
    const branch = index === candidate.relationships.length - 1 ? "`--" : "|--";
    lines.push(
      `|   ${branch} ${safeTerminalText(relationship.local_columns.join(","))} -> ` +
      `${safeTerminalText(relationship.target_resource)}.` +
      `${safeTerminalText(relationship.target_columns.join(","))} ` +
      `[many-to-one, max fan-out 1, path ${relationship.path_depth ?? 1}]`,
    );
  });
  return lines;
}

function boundaryOverviewSummary(resources: BoundaryResourceReviewSummary[]): string {
  const included = resources.filter((resource) => resource.included).length;
  const active = resources.filter((resource) => resource.active).length;
  const blocked = resources.filter((resource) => resource.status !== "draft_read").length;
  const includedRelationships = resources.reduce(
    (total, resource) =>
      total + resource.relationships.filter((relationship) => relationship.state !== "available").length,
    0,
  );
  const name = resources[0]?.candidate_boundary_name ?? "reviewed_staging";
  return `Next boundary "${safeTerminalText(name)}": ${included}/${resources.length} tables | ` +
    `active ${active} | reviewed paths ${includedRelationships} | blocked ${blocked}`;
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
  const lines = [
    `  ${safeTerminalText(resource.resource_id)} [${theme.warning(state)}; ${review}]`,
    `    Fields: ${resource.model_visible_fields} model | ` +
      `${resource.runner_output_only_fields} raw Runner-only | ${resource.kept_out_fields} kept out`,
  ];
  for (const relationship of relationships.slice(0, 3)) {
    lines.push(
      `    -> ${safeTerminalText(relationship.target_resource)} ` +
      `(many-to-one, depth ${relationship.path_depth})`,
    );
  }
  if (relationships.length > 3) {
    lines.push(theme.dim(`    +${relationships.length - 3} more reviewed paths`));
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
    .map((resource) => ({
      resource,
      relationships: resource.relationships.filter(
        (relationship) => relationship.state === "available",
      ),
    }))
    .filter(({ relationships }) => relationships.length > 0);
  const lines = suggestions.slice(0, limit).map(({ resource, relationships }) => {
    const targets = relationships
      .slice(0, 4)
      .map((relationship) => safeTerminalText(relationship.target_resource))
      .join(", ");
    const remainder = relationships.length > 4 ? `, +${relationships.length - 4} more` : "";
    return theme.relationship(
      `  ${safeTerminalText(resource.resource_id)} -> ${targets}${remainder}`,
    );
  });
  if (suggestions.length > limit) {
    lines.push(theme.dim(`  +${suggestions.length - limit} more tables with proven paths`));
  }
  return lines;
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
    return [
      theme.relationship(
        `${scopeLabel}: ${safeTerminalText(formatDerivedScopePath(connection.derived_scope))}`,
      ),
      theme.dim(
        `Exact path ID: ${safeTerminalText(connection.relationship_id)}; continuous non-null ` +
        `many-to-one catalog proof. Human review is still required before use.`,
      ),
    ];
  }
  return [
    theme.relationship(
      `Proven path: ${safeTerminalText(connection.source_resource)} -> ` +
      `${safeTerminalText(connection.target_resource)}`,
    ),
    theme.dim(
      `${safeTerminalText(connection.relationship_id)}; inspected many-to-one path; ` +
      `depth ${connection.path_depth}. Human review is still required before use.`,
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
  status: string,
  tables: number | string,
  authority: string,
): string {
  return [
    fitTerminalCell(marker, 1),
    fitTerminalCell(safeTerminalText(name), 20),
    fitTerminalCell(status, 21),
    fitTerminalCell(String(tables), 6),
    safeTerminalText(authority),
  ].join("  ");
}

function firstRunBoundaryRow(
  name: string,
  status: string,
  tables: number | string,
  access: string,
): string {
  return [
    fitTerminalCell(safeTerminalText(name), 20),
    fitTerminalCell(status, 10),
    fitTerminalCell(String(tables), 7),
    access,
  ].join("  ");
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
): string[] {
  if (!resources.length) return [theme.warning("(no inspected tables or views)")];
  return resources.flatMap((resource) => {
    const status = resource.status !== "draft_read"
      ? theme.danger("BLOCKED")
      : resource.active && resource.included
        ? theme.success("ACTIVE + NEXT BOUNDARY")
        : resource.active
          ? theme.success("ACTIVE")
          : resource.included
            ? theme.warning("IN NEXT BOUNDARY")
            : theme.dim("NOT INCLUDED");
    const lines = [
      `${safeTerminalText(resource.resource_id)} [${status}]`,
      `  fields: ${resource.model_visible_fields} model | ` +
      `${resource.runner_output_only_fields} raw Runner-only | ${resource.kept_out_fields} kept out`,
    ];
    if (resource.status !== "draft_read") {
      lines.push(`  \`-- ${theme.danger(safeTerminalText(resource.blockers[0] ?? "review blocked"))}`);
      if (resource.scope_resolution_guidance) {
        lines.push(
          ...resource.scope_resolution_guidance.why.map((line) =>
            `      why: ${safeTerminalText(line)}`),
          ...resource.scope_resolution_guidance.remediation.slice(0, 2).map((line) =>
            `      next: ${safeTerminalText(line)}`),
        );
      }
      return lines;
    }
    if (!resource.relationships.length) {
      lines.push(`  \`-- ${theme.dim("no proven relationship candidate")}`);
      return lines;
    }
    resource.relationships.forEach((relationship, index) => {
      const branch = index === resource.relationships.length - 1 ? "`--" : "|--";
      const state = relationship.state === "active"
        ? theme.success("ACTIVE")
        : relationship.state === "included"
          ? theme.warning("IN NEXT BOUNDARY")
          : theme.dim("AVAILABLE");
      lines.push(`  ${branch} path ${safeTerminalText(relationship.relationship_id)} [${state}]`);
      lines.push(
        `      -> ${safeTerminalText(relationship.target_resource)} ` +
        `(many-to-one, depth ${relationship.path_depth})`,
      );
    });
    return lines;
  });
}

function riskBadge(
  view: BoundaryResourceReviewView,
  field: BoundaryResourceReviewView["fields"][number],
): string {
  if (isTrustedScopeField(view, field.name)) return "[trusted scope fixed; output tier reviewed]";
  if (field.primary_key) return "[record ID]";
  if (field.sensitivity.state === "high_confidence_sensitive") return "[sensitive]";
  if (field.sensitivity.state === "unresolved_free_text") return "[free text]";
  return "[low structural risk]";
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
    return resource.risk_count
      ? {
        text: "[active + updated sign-off needed]",
        style: theme.warning,
      }
      : { text: "[active + reviewed]", style: theme.success };
  }
  if (!resource.included) return { text: "[available]", style: theme.dim };
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

export function terminalTheme(color: boolean) {
  const style = (codes: string) => (value: string) =>
    color ? `\u001b[${codes}m${value}\u001b[0m` : value;
  return {
    title: style("1;36"),
    bold: style("1"),
    italic: style("3"),
    dim: style("2"),
    key: style("1;36"),
    focus: style("1;96"),
    success: style("1;32"),
    warning: style("1;33"),
    danger: style("1;31"),
    scope: style("1;35"),
    value: style("36"),
    relationship: style("1;34"),
    visible: style("1;32"),
    runnerOnly: style("1;33"),
    keptOut: style("2"),
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

function formatTextPromptWithBack(prompt: string, theme: TerminalTheme): string {
  const normalized = prompt.trimEnd();
  const label = normalized.endsWith(":")
    ? normalized.slice(0, -1).trimEnd()
    : normalized;
  return `${label} ${theme.key("[Esc Back]")}: `;
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
    || isEscapeKey(key)
    || (key.name === "q" && key.sequence === "q");
}

function isBackToResources(key: Keypress): boolean {
  return key.name === "backspace"
    || isEscapeKey(key)
    || (key.name === "b" && key.sequence === "b");
}

function isBackKey(key: Keypress): boolean {
  return key.name === "backspace"
    || isEscapeKey(key)
    || (key.name === "b" && key.sequence === "b");
}

function isEscapeKey(key: Keypress): boolean {
  return key.name === "escape" || key.sequence === "\u001b";
}

async function withRawKeys<T>(
  input: ReadStream,
  output: WriteStream,
  operation: (
    nextKey: () => Promise<Keypress>,
    render: (lines: string[]) => void,
  ) => Promise<T>,
): Promise<T> {
  const wasRaw = input.isRaw;
  const wasPaused = input.isPaused();
  let renderedLines = 0;
  const queuedKeys: Keypress[] = [];
  const keyWaiters: Array<(key: Keypress) => void> = [];
  const keyHandler = (_text: string, key: Keypress) => {
    const waiter = keyWaiters.shift();
    if (waiter) waiter(key);
    else queuedKeys.push(key);
  };
  readline.emitKeypressEvents(input);
  input.on("keypress", keyHandler);
  input.setRawMode(true);
  input.resume();
  output.write("\u001b[?25l");
  const render = (lines: string[]) => {
    if (renderedLines) output.write(`\u001b[${renderedLines}F`);
    const width = Math.max(36, Math.min(terminalContentWidth(output.columns), 116));
    const normalized = lines.flatMap((line) =>
      wrapTerminalLine(line, width).map((wrapped) => padTerminalLine(wrapped)));
    const targetLines = Math.max(renderedLines, normalized.length);
    for (let index = 0; index < targetLines; index += 1) {
      output.write(`\u001b[2K${normalized[index] ?? ""}\n`);
    }
    renderedLines = targetLines;
  };
  const nextKey = () => {
    const queued = queuedKeys.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise<Keypress>((resolve) => keyWaiters.push(resolve));
  };
  try {
    return await operation(nextKey, render);
  } finally {
    input.off("keypress", keyHandler);
    if (renderedLines) output.write(`\u001b[${renderedLines}F\u001b[0J`);
    output.write("\u001b[?25h");
    input.setRawMode(wasRaw);
    if (wasPaused) input.pause();
  }
}

function safeTerminalText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

function wrapTerminalLine(value: string, width: number): string[] {
  const safe = sanitizeStyledTerminalLine(value);
  if (!safe) return [""];
  const tokens = (safe.match(/\u001b\[[0-9;]*m|./gu) ?? []).map((raw) => ({
    raw,
    visible: !raw.startsWith("\u001b["),
  }));
  const lines: string[] = [];
  let current: typeof tokens = [];
  let visible = 0;
  for (const token of tokens) {
    current.push(token);
    if (token.visible) visible += 1;
    if (visible <= width) continue;

    const wordBreak = findStyledWordBreak(current, width);
    const splitAt = wordBreak >= 0
      ? wordBreak
      : styledTokenIndexAfterVisibleWidth(current, width);
    const head = current.slice(0, splitAt);
    current = current.slice(splitAt + (wordBreak >= 0 ? 1 : 0));
    lines.push(head.map((item) => item.raw).join("").trimEnd());
    visible = current.filter((item) => item.visible).length;
  }
  lines.push(current.map((item) => item.raw).join("").trimEnd());
  return lines;
}

function findStyledWordBreak(
  tokens: Array<{ raw: string; visible: boolean }>,
  width: number,
): number {
  let visible = 0;
  let candidate = -1;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.visible) continue;
    visible += 1;
    if (visible > width) break;
    if (/\s/u.test(token.raw) && visible >= Math.max(8, Math.floor(width / 2))) {
      candidate = index;
    }
  }
  return candidate;
}

function styledTokenIndexAfterVisibleWidth(
  tokens: Array<{ raw: string; visible: boolean }>,
  width: number,
): number {
  let visible = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index]!.visible) continue;
    visible += 1;
    if (visible > width) return index;
  }
  return tokens.length;
}

function sanitizeStyledTerminalLine(value: string): string {
  let safe = "";
  for (let index = 0; index < value.length;) {
    if (value[index] === "\u001b") {
      const sgr = value.slice(index).match(/^\u001b\[[0-9;]*m/);
      if (sgr) {
        safe += sgr[0];
        index += sgr[0].length;
        continue;
      }
      safe += "?";
      index += 1;
      continue;
    }
    const codePoint = value.codePointAt(index)!;
    const character = String.fromCodePoint(codePoint);
    safe += codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? "?"
      : character;
    index += character.length;
  }
  return safe;
}
