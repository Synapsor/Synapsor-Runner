import fs from "node:fs/promises";
import { normalizeContract } from "./normalize.js";
import type { SynapsorContract } from "./types.js";

export async function loadContract(path: string): Promise<SynapsorContract> {
  const parsed = JSON.parse(await fs.readFile(path, "utf8"));
  return normalizeContract(parsed);
}
