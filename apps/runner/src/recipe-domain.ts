import {
  type OnboardingSelectionSpec
} from "@synapsor-runner/schema-inspector";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveAssetPath } from "./cli-assets.js";
import { cliCommandName } from "./cli-command-meta.js";
import { fileExists } from "./cli-files.js";
import { isRecord } from "./cli-format.js";


export type CapabilityRecipe = {
  id: string;
  title: string;
  summary: string;
  expected_table_type: string;
  required_columns: string[];
  recommended_primary_key: string;
  recommended_tenant_key: string;
  recommended_conflict_column: string;
  visible_columns: string[];
  allowed_write_columns: string[];
  semantic_tools: string[];
  notes: string[];
  spec: OnboardingSelectionSpec;
};


export async function loadBuiltInRecipes(): Promise<CapabilityRecipe[]> {
  const recipeDir = await resolveAssetPath("recipes");
  const entries = await fs.readdir(recipeDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(recipeDir, entry.name))
    .sort();
  return Promise.all(files.map((file) => loadRecipeFile(file)));
}


async function loadRecipeFile(filePath: string): Promise<CapabilityRecipe> {
  const resolved = path.resolve(filePath);
  const parsed = JSON.parse(await fs.readFile(resolved, "utf8"));
  return normalizeRecipe(parsed, resolved);
}


export async function requireRecipe(recipeIdOrPath: string): Promise<CapabilityRecipe> {
  if (looksLikeRecipePath(recipeIdOrPath)) {
    return loadRecipeFile(recipeIdOrPath);
  }
  const recipeDir = await resolveAssetPath("recipes");
  const file = path.join(recipeDir, `${recipeIdOrPath}.json`);
  if (await fileExists(file)) {
    return loadRecipeFile(file);
  }
  throw new Error(`unknown recipe ${recipeIdOrPath}. Run ${cliCommandName()} recipes list, or pass a recipe JSON file path.`);
}


function looksLikeRecipePath(value: string): boolean {
  return value.endsWith(".json") || value.includes("/") || value.includes("\\") || value.startsWith(".");
}


function normalizeRecipe(value: unknown, source: string): CapabilityRecipe {
  if (!isRecord(value)) throw new Error(`recipe ${source} must be a JSON object`);
  const recipe: CapabilityRecipe = {
    id: requiredString(value, "id", source),
    title: requiredString(value, "title", source),
    summary: requiredString(value, "summary", source),
    expected_table_type: requiredString(value, "expected_table_type", source),
    required_columns: requiredStringArray(value, "required_columns", source),
    recommended_primary_key: requiredString(value, "recommended_primary_key", source),
    recommended_tenant_key: requiredString(value, "recommended_tenant_key", source),
    recommended_conflict_column: requiredString(value, "recommended_conflict_column", source),
    visible_columns: requiredStringArray(value, "visible_columns", source),
    allowed_write_columns: requiredStringArray(value, "allowed_write_columns", source),
    semantic_tools: requiredStringArray(value, "semantic_tools", source),
    notes: requiredStringArray(value, "notes", source),
    spec: requiredRecord(value, "spec", source) as OnboardingSelectionSpec,
  };
  if (!recipe.spec.namespace || !recipe.spec.table || !recipe.spec.primary_key) {
    throw new Error(`recipe ${source} spec must include namespace, table, and primary_key`);
  }
  return recipe;
}


function requiredString(value: Record<string, unknown>, key: string, source: string): string {
  const item = value[key];
  if (typeof item !== "string" || item.trim() === "") throw new Error(`recipe ${source} requires string ${key}`);
  return item;
}


function requiredStringArray(value: Record<string, unknown>, key: string, source: string): string[] {
  const item = value[key];
  if (!Array.isArray(item) || !item.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
    throw new Error(`recipe ${source} requires string[] ${key}`);
  }
  return item;
}


function requiredRecord(value: Record<string, unknown>, key: string, source: string): Record<string, unknown> {
  const item = value[key];
  if (!isRecord(item)) throw new Error(`recipe ${source} requires object ${key}`);
  return item;
}
