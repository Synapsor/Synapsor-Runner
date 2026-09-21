// Qualification capture only. Never transforms a request or response on the wire.
import { createHash } from 'node:crypto';
export const sha = value => createHash('sha256').update(value).digest('hex');
const privateKeys = new Set(['reasoning_details', 'reasoning_content', 'thinking', 'redacted_thinking', 'encrypted_content']);
const marker = value => ({ withheld_private_continuation: true, bytes: Buffer.byteLength(JSON.stringify(value)), sha256: sha(JSON.stringify(value)) });
export function redactCapture(value, secrets = []) {
  if (typeof value === 'string') {
    let out = value;
    for (const secret of secrets) if (secret) out = out.split(secret).join('[REDACTED]');
    return out.replace(/postgres(?:ql)?:\/\/[^\s"\\]+/gi, '[REDACTED_DATABASE_URL]')
      .replace(/sk-[A-Za-z0-9_-]{16,}/g, '[REDACTED_KEY]');
  }
  if (Array.isArray(value)) return value.map(x => redactCapture(x, secrets));
  if (!value || typeof value !== 'object') return value;
  if (['reasoning', 'thinking', 'redacted_thinking'].includes(value.type)) return marker(value);
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    // A reasoning configuration such as {effort:'low'} is not private content.
    const thinkingConfiguration = key === 'thinking' && item && typeof item === 'object'
      && ['enabled', 'disabled', 'adaptive'].includes(item.type)
      && Object.keys(item).every(k => ['type', 'budget_tokens', 'display'].includes(k));
    out[key] = (!thinkingConfiguration && privateKeys.has(key)) || (key === 'reasoning' && typeof item === 'string')
      ? marker(item) : redactCapture(item, secrets);
  }
  return out;
}
export function captureBody(body, secrets = []) {
  try { return JSON.stringify(redactCapture(JSON.parse(body), secrets)); }
  catch {
    const lines = body.split('\n');
    if (lines.some(line => line.startsWith('data:'))) return lines.map(line => {
      if (!line.startsWith('data:')) return /^(event:|id:|:|\s*$)/.test(line) ? line : '[UNPARSED_STREAM_LINE_WITHHELD]';
      const raw = line.slice(5).trim();
      if (raw === '[DONE]') return line;
      try { return 'data: ' + JSON.stringify(redactCapture(JSON.parse(raw), secrets)); }
      catch { return 'data: [UNPARSED_STREAM_EVENT_WITHHELD]'; }
    }).join('\n');
    // Malformed bodies may contain arbitrary private continuation. Keep identity,
    // not readable raw text; the untouched body still reaches the product.
    return JSON.stringify({ unparsed_body_withheld: true, bytes: Buffer.byteLength(body), sha256: sha(body) });
  }
}
export function assertNoPrivateInput(body, privateValues) {
  // Complete bodies only; no guessed keyword/stem or blanket enum blacklist.
  for (const value of privateValues) {
    if (value && body.includes(value)) throw new Error('QUALIFICATION_PRIVATE_INPUT_REFUSED');
  }
}
