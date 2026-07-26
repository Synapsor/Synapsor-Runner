import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { fileExists } from "./cli-files.js";


const moduleDir = path.dirname(fileURLToPath(import.meta.url));

const packageAssetRoot = path.resolve(moduleDir, "..");

const sourceAssetRoot = path.resolve(moduleDir, "../../..");


export async function resolveAssetPath(relativePath: string): Promise<string> {
  const candidates = [
    path.resolve(process.cwd(), relativePath),
    path.resolve(packageAssetRoot, relativePath),
    path.resolve(sourceAssetRoot, relativePath),
  ];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return candidates[0]!;
}
