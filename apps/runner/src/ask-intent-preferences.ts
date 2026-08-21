import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const ASK_INTENT_CHECK_MODES = ["balanced", "boundary_only"] as const;
export type AskIntentCheckMode = typeof ASK_INTENT_CHECK_MODES[number];

type AskIntentPreference = {
  intent_check_mode: AskIntentCheckMode;
  updated_at: string;
};

type AskPreferences = {
  schema_version: "synapsor.ask-preferences.v1";
  boundaries: Record<string, AskIntentPreference>;
};

const ASK_PREFERENCES_FILE = "ask-preferences.json";
const BOUNDARY_NAME = /^[a-z][a-z0-9_.-]{0,63}$/;

export async function askIntentCheckModeForBoundary(
  projectRoot: string,
  boundaryName: string,
): Promise<AskIntentCheckMode> {
  assertBoundaryName(boundaryName);
  const preferences = await readAskPreferences(projectRoot);
  return preferences.boundaries[boundaryName]?.intent_check_mode ?? "balanced";
}

export async function askIntentCheckModesForBoundaries(
  projectRoot: string,
  boundaryNames: string[],
): Promise<Record<string, AskIntentCheckMode>> {
  const preferences = await readAskPreferences(projectRoot);
  return Object.fromEntries(boundaryNames.map((boundaryName) => {
    assertBoundaryName(boundaryName);
    return [boundaryName, preferences.boundaries[boundaryName]?.intent_check_mode ?? "balanced"];
  }));
}

export async function setAskIntentCheckMode(input: {
  projectRoot: string;
  boundaryName: string;
  mode: AskIntentCheckMode;
  now?: Date;
}): Promise<AskIntentCheckMode> {
  assertBoundaryName(input.boundaryName);
  assertMode(input.mode);
  const preferences = await readAskPreferences(input.projectRoot);
  preferences.boundaries[input.boundaryName] = {
    intent_check_mode: input.mode,
    updated_at: (input.now ?? new Date()).toISOString(),
  };
  await writeAskPreferences(input.projectRoot, preferences);
  return input.mode;
}

export async function renameAskIntentCheckPreference(input: {
  projectRoot: string;
  previousName: string;
  nextName: string;
}): Promise<void> {
  assertBoundaryName(input.previousName);
  assertBoundaryName(input.nextName);
  const preferences = await readAskPreferences(input.projectRoot);
  const existing = preferences.boundaries[input.previousName];
  if (!existing || input.previousName === input.nextName) return;
  preferences.boundaries[input.nextName] = existing;
  delete preferences.boundaries[input.previousName];
  await writeAskPreferences(input.projectRoot, preferences);
}

export async function deleteAskIntentCheckPreference(
  projectRoot: string,
  boundaryName: string,
): Promise<void> {
  assertBoundaryName(boundaryName);
  const preferences = await readAskPreferences(projectRoot);
  if (!preferences.boundaries[boundaryName]) return;
  delete preferences.boundaries[boundaryName];
  await writeAskPreferences(projectRoot, preferences);
}

async function readAskPreferences(projectRoot: string): Promise<AskPreferences> {
  const filePath = askPreferencesPath(projectRoot);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyAskPreferences();
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Local Ask preferences at ${filePath} are not valid JSON. Repair or remove the file; Runner kept the question-to-plan check enabled.`,
    );
  }
  if (!isRecord(parsed)
    || parsed.schema_version !== "synapsor.ask-preferences.v1"
    || !isRecord(parsed.boundaries)) {
    throw new Error(
      `Local Ask preferences at ${filePath} use an unsupported shape. Repair or remove the file; Runner kept the question-to-plan check enabled.`,
    );
  }
  const boundaries: Record<string, AskIntentPreference> = {};
  for (const [boundaryName, value] of Object.entries(parsed.boundaries)) {
    assertBoundaryName(boundaryName);
    if (!isRecord(value)
      || !isAskIntentCheckMode(value.intent_check_mode)
      || typeof value.updated_at !== "string"
      || !Number.isFinite(Date.parse(value.updated_at))) {
      throw new Error(
        `Local Ask preference for boundary ${boundaryName} is invalid. Repair or remove ${filePath}; Runner kept the question-to-plan check enabled.`,
      );
    }
    boundaries[boundaryName] = {
      intent_check_mode: value.intent_check_mode,
      updated_at: value.updated_at,
    };
  }
  return { schema_version: "synapsor.ask-preferences.v1", boundaries };
}

async function writeAskPreferences(projectRoot: string, preferences: AskPreferences): Promise<void> {
  const filePath = askPreferencesPath(projectRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  try {
    await fs.rename(temporary, filePath);
    await fs.chmod(filePath, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function askPreferencesPath(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), ".synapsor", ASK_PREFERENCES_FILE);
}

function emptyAskPreferences(): AskPreferences {
  return { schema_version: "synapsor.ask-preferences.v1", boundaries: {} };
}

function assertBoundaryName(boundaryName: string): void {
  if (!BOUNDARY_NAME.test(boundaryName)) {
    throw new Error(`Invalid boundary name ${JSON.stringify(boundaryName)} in local Ask preferences.`);
  }
}

function assertMode(mode: string): asserts mode is AskIntentCheckMode {
  if (!isAskIntentCheckMode(mode)) {
    throw new Error(`Unsupported local Ask intent-check mode ${JSON.stringify(mode)}.`);
  }
}

function isAskIntentCheckMode(value: unknown): value is AskIntentCheckMode {
  return value === "balanced" || value === "boundary_only";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
