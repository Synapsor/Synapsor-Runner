import { readFile, writeFile } from "node:fs/promises";

const [inputPath, outputPath, repoRoot = ""] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("usage: redact-output.mjs <input> <output> [repo-root]");
}

let text = await readFile(inputPath, "utf8");

const replacements = [
  [repoRoot ? new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g") : /$^/, "<repo>"],
  [/\/home\/[A-Za-z0-9._-]+/g, "<home>"],
  [/(?:postgres(?:ql)?|mysql):\/\/[^\s"'<>]+/gi, "<redacted-database-url>"],
  [/(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1<redacted>"],
  [/(Cookie\s*:\s*)[^\r\n]+/gi, "$1<redacted>"],
  [/\b(?:syn_sess|syn_ops|syn_inv|syn_run|syn_pat)_[A-Za-z0-9_-]{8,}\b/g, "<redacted-token>"],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "<redacted-aws-key>"],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "<redacted-api-key>"],
  [/(["']?(?:password|token|secret|api_key|access_key)["']?\s*[:=]\s*["'])[^"'\r\n]+(["'])/gi, "$1<redacted>$2"],
  [/synapsor-demo-video-[A-Za-z0-9._+-]+@example\.com/gi, "demo-user@example.com"],
];

for (const [pattern, replacement] of replacements) {
  text = text.replace(pattern, replacement);
}

await writeFile(outputPath, text, { mode: 0o600 });
