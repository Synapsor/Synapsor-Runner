/** Reflow plain prose only; preserve structured lines and explicit hard breaks. */
function proseLine(value: string): boolean {
  return Boolean(value.trim())
    && !/^(?: {4}|\t)/u.test(value)
    && !/^\s*(?:[#>|]|`{3,}|~{3,}|[-*+](?:\s|$)|\d+[.)](?:\s|$)|[-*_]{3,}\s*$|Candidate\b|Answer\b)/iu.test(value)
    && !/^\s*\S+:\s/u.test(value)
    && !value.includes("|");
}

export function createTerminalProseReflow(write: (value: string) => void) {
  let pending = "";
  let line = "";
  let boundary = false;
  let joinPrevious = false;
  let fence: string | undefined;
  const consume = (final: boolean) => {
    while (pending.length || (final && boundary)) {
      if (boundary) {
        // Only a potentially soft continuation needs line lookahead: its
        // final columns may identify a table. Ordinary first lines stream
        // immediately; paragraphs and structured blocks never need buffering.
        if (!final && joinPrevious && !pending.includes("\n")) return;
        const nextLine = pending.split("\n", 1)[0]!;
        const join = joinPrevious && proseLine(nextLine);
        write(join ? " " : "\n");
        if (join) pending = pending.trimStart();
        boundary = false;
        line = "";
      }
      const end = pending.indexOf("\n");
      const text = end < 0 ? pending : pending.slice(0, end);
      write(text);
      line += text;
      pending = end < 0 ? "" : pending.slice(end + 1);
      if (end < 0) return;
      const marker = line.trimStart().match(/^(`{3,}|~{3,})(.*)$/u);
      const inFence = fence !== undefined;
      if (marker) {
        if (!fence) fence = marker[1];
        else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
      }
      joinPrevious = !inFence && !fence && proseLine(line) && !/(?: {2}|\\|:)$/u.test(line);
      boundary = true;
    }
  };
  return {
    push(text: string) { pending += text; consume(false); },
    finish() { consume(true); },
  };
}

export function reflowTerminalProse(value: string): string {
  const output: string[] = [];
  const stream = createTerminalProseReflow((text) => output.push(text));
  stream.push(value);
  stream.finish();
  return output.join("");
}
