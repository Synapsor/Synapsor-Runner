import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ProposalStore } from "@synapsor-runner/proposal-store";

type JsonRecord = Record<string, unknown>;

export type ActivationMilestoneName =
  | "try_proof"
  | "own_data_ready"
  | "cursor_configured"
  | "first_tool_call"
  | "first_own_data_read"
  | "first_proposal";

export type ActivationMilestone = {
  name: ActivationMilestoneName;
  status: "complete" | "pending";
  observed_at?: string;
  elapsed_ms?: number;
  evidence: "managed_try_state" | "onboarding_manifest" | "cursor_marker" | "local_ledger";
};

export type LocalActivationReport = {
  schema_version: "synapsor.activation-report.v1";
  generated_at: string;
  local_only: true;
  telemetry_transmitted: false;
  clock_boundary: string;
  milestones: ActivationMilestone[];
  completed: number;
  pending: number;
};

export async function recordOwnDataActivationTiming(input: {
  manifestPath: string;
  startedAt: string;
  completedAt?: string;
}): Promise<void> {
  const completedAt = input.completedAt ?? new Date().toISOString();
  const startedMs = Date.parse(input.startedAt);
  const completedMs = Date.parse(completedAt);
  if (!Number.isFinite(startedMs) || !Number.isFinite(completedMs) || completedMs < startedMs) {
    throw new Error("own-data activation timing requires ordered ISO timestamps");
  }
  const manifest = await readJsonRecord(input.manifestPath, "onboarding manifest");
  manifest.activation = {
    own_data_started_at: input.startedAt,
    own_data_ready_at: completedAt,
    product_activation_ms: completedMs - startedMs,
    clock_boundary: "CLI execution after package installation; excludes npm package download and cache population",
  };
  await writeJsonAtomic(input.manifestPath, manifest);
}

export async function buildLocalActivationReport(input: {
  projectRoot: string;
  storePath: string;
  tryStateDir?: string;
  now?: string;
}): Promise<LocalActivationReport> {
  const projectRoot = path.resolve(input.projectRoot);
  const manifest = await readOptionalJsonRecord(path.join(projectRoot, ".synapsor/onboarding.json"));
  const activation = asRecord(manifest?.activation);
  const onboardingStartedAt = isoString(activation.own_data_started_at);
  const onboardingReadyAt = isoString(activation.own_data_ready_at) ?? isoString(manifest?.generated_at);

  const tryContainer = input.tryStateDir
    ? path.resolve(projectRoot, input.tryStateDir)
    : path.join(projectRoot, ".synapsor");
  const tryRoot = input.tryStateDir
    ? path.join(tryContainer, ".synapsor-try")
    : path.join(tryContainer, "try");
  const tryActivation = await readOptionalJsonRecord(path.join(tryRoot, "activation.json"));
  const tryCompletedAt = isoString(tryActivation?.completed_at);
  const tryDuration = nonNegativeInteger(tryActivation?.product_activation_ms);

  const cursorMarker = await readOptionalJsonRecord(path.join(projectRoot, ".synapsor/cursor-project.json"));
  const cursorInstalledAt = isoString(cursorMarker?.installed_at);

  const { firstReadAt, firstProposalAt } = await localLedgerMilestones(path.resolve(projectRoot, input.storePath));
  const milestones: ActivationMilestone[] = [
    milestone("try_proof", tryCompletedAt, tryDuration, "managed_try_state"),
    milestone("own_data_ready", onboardingReadyAt, elapsed(onboardingStartedAt, onboardingReadyAt), "onboarding_manifest"),
    milestone("cursor_configured", cursorInstalledAt, elapsed(onboardingStartedAt, cursorInstalledAt), "cursor_marker"),
    milestone("first_tool_call", firstReadAt, elapsed(onboardingStartedAt, firstReadAt), "local_ledger"),
    milestone("first_own_data_read", firstReadAt, elapsed(onboardingStartedAt, firstReadAt), "local_ledger"),
    milestone("first_proposal", firstProposalAt, elapsed(onboardingStartedAt, firstProposalAt), "local_ledger"),
  ];
  return {
    schema_version: "synapsor.activation-report.v1",
    generated_at: input.now ?? new Date().toISOString(),
    local_only: true,
    telemetry_transmitted: false,
    clock_boundary: "Product activation excludes initial npm package download/cache population. Record cold npx timing separately.",
    milestones,
    completed: milestones.filter((item) => item.status === "complete").length,
    pending: milestones.filter((item) => item.status === "pending").length,
  };
}

export function formatLocalActivationReport(report: LocalActivationReport): string {
  const lines = [
    "Synapsor local activation report",
    "",
    "Local only: yes; telemetry transmitted: no",
    `Clock boundary: ${report.clock_boundary}`,
    "",
  ];
  for (const item of report.milestones) {
    const timing = item.elapsed_ms === undefined ? "" : `; elapsed ${formatDuration(item.elapsed_ms)}`;
    lines.push(`${item.status === "complete" ? "COMPLETE" : "PENDING "} ${item.name.replaceAll("_", " ")}${timing}`);
  }
  lines.push("", `${report.completed} complete; ${report.pending} pending`, "");
  return lines.join("\n");
}

async function localLedgerMilestones(storePath: string): Promise<{ firstReadAt?: string; firstProposalAt?: string }> {
  if (!(await pathExists(storePath))) return {};
  const stat = await fs.lstat(storePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("activation report store must be a regular local SQLite file");
  const store = new ProposalStore(storePath);
  try {
    const reads = store.listQueryAudit()
      .map((item) => isoString(item.created_at))
      .filter((item): item is string => Boolean(item))
      .sort();
    const proposals = store.listProposals()
      .map((item) => isoString(item.created_at))
      .filter((item): item is string => Boolean(item))
      .sort();
    return { ...(reads[0] ? { firstReadAt: reads[0] } : {}), ...(proposals[0] ? { firstProposalAt: proposals[0] } : {}) };
  } finally {
    store.close();
  }
}

function milestone(
  name: ActivationMilestoneName,
  observedAt: string | undefined,
  elapsedMs: number | undefined,
  evidence: ActivationMilestone["evidence"],
): ActivationMilestone {
  return {
    name,
    status: observedAt ? "complete" : "pending",
    ...(observedAt ? { observed_at: observedAt } : {}),
    ...(elapsedMs === undefined ? {} : { elapsed_ms: elapsedMs }),
    evidence,
  };
}

function elapsed(startedAt: string | undefined, completedAt: string | undefined): number | undefined {
  if (!startedAt || !completedAt) return undefined;
  const value = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1_000 ? `${milliseconds}ms` : `${(milliseconds / 1_000).toFixed(2)}s`;
}

function isoString(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(Date.parse(value))) return undefined;
  return value;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

async function readJsonRecord(value: string, label: string): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(await fs.readFile(value, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${label} must contain a JSON object`);
  return parsed as JsonRecord;
}

async function readOptionalJsonRecord(value: string): Promise<JsonRecord | undefined> {
  try {
    return await readJsonRecord(value, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJsonAtomic(destination: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.lstat(value);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
