import fs from "node:fs/promises";
import path from "node:path";
import { cliCommandName } from "./cli-command-meta.js";
import { shellQuote } from "./cli-format.js";


export async function writeFileGuarded(filePath: string, content: string, force: boolean): Promise<void> {
  const resolved = path.resolve(filePath);
  if (!force) {
    try {
      await fs.access(resolved);
      throw new Error(`${filePath} already exists. Use --force to overwrite.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  await fs.writeFile(resolved, content, "utf8");
}


export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(path.resolve(filePath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}


export async function readJsonFileWithLocation<T>(filePath: string, label: string): Promise<T> {
  const resolved = path.resolve(filePath);
  const source = await fs.readFile(resolved, "utf8");
  try {
    return JSON.parse(source) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const explicit = message.match(/\bline\s+(\d+)\s+column\s+(\d+)\b/i);
    const position = message.match(/\bposition\s+(\d+)\b/i);
    let line = explicit ? Number(explicit[1]) : undefined;
    let column = explicit ? Number(explicit[2]) : undefined;
    if ((!line || !column) && position) {
      const offset = Math.max(0, Math.min(source.length, Number(position[1])));
      const prefix = source.slice(0, offset);
      line = prefix.split("\n").length;
      column = offset - prefix.lastIndexOf("\n");
    }
    const location = line && column ? ` at line ${line}, column ${column}` : "";
    const commentHint = /(^|\s)\/\//m.test(source) || /\/\*/.test(source)
      ? " JSON does not support // or /* */ comments; remove the comments or keep notes outside the config."
      : "";
    throw new Error(
      `${label} is not valid JSON: ${resolved}${location}. ${message}${commentHint} ` +
      `State preserved: the file and source database were not changed. ` +
      `Next: correct that location, then run ${cliCommandName()} config validate --config ${shellQuote(filePath)} --json.`,
    );
  }
}
