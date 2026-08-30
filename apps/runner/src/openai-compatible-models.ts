import { Buffer } from "node:buffer";

export async function discoverOpenAiCompatibleModels(baseUrl: string): Promise<string[]> {
  const parsed = new URL(baseUrl);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || !["127.0.0.1", "::1", "localhost"].includes(hostname)) {
    return [];
  }
  const pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = `${pathname || "/v1"}/models`.replace(/\/{2,}/g, "/");
  parsed.search = "";
  parsed.hash = "";
  const response = await fetch(parsed, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) return [];
  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 65_536) return [];
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 65_536) return [];
  const body: unknown = JSON.parse(text);
  if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) return [];
  return [...new Set((body as { data: unknown[] }).data.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const id = (item as { id?: unknown }).id;
    return typeof id === "string" && id.trim() && id.length <= 128 ? [id.trim()] : [];
  }))].sort((left, right) => left.localeCompare(right)).slice(0, 100);
}
