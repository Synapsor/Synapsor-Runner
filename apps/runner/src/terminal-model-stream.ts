import { stripVTControlCharacters as stripTerminalAnsi } from "node:util";

/** Incremental prose renderer. Tool arguments must never be passed to this surface. */
export function createTerminalModelStream(input: {
  width: () => number;
  prefix: string;
  continuation: string;
  write: (text: string) => void;
  bold: (text: string) => string;
  code: (text: string) => string;
}) {
  let pending = "";
  let word: Array<{ text: string; bold: boolean; code: boolean }> = [];
  let bold = false;
  let code = false;
  let column = 0;
  let started = false;
  let space = false;
  const prefix = () => {
    if (column) return;
    const value = started ? input.continuation : input.prefix;
    input.write(value);
    column = Array.from(stripTerminalAnsi(value)).length;
    started = true;
  };
  const newline = () => { input.write("\n"); column = 0; space = false; };
  const flushWord = () => {
    if (!word.length) return;
    prefix();
    const width = Math.max(16, input.width() - 1);
    const length = word.reduce((total, part) => total + Array.from(part.text).length, 0);
    if (space && column + 1 + length > width) { newline(); prefix(); }
    if (space) { input.write(" "); column += 1; }
    for (const part of word) {
      // Sanitize only after assembling the word, so split escape sequences cannot execute.
      const text = stripTerminalAnsi(part.text).replace(/[\u0000-\u001f\u007f-\u009f]/gu, "");
      let segment = "";
      const emit = () => {
        if (!segment) return;
        input.write(part.code ? input.code(segment) : part.bold ? input.bold(segment) : segment);
        segment = "";
      };
      for (const char of text) {
        if (column >= width) { emit(); newline(); prefix(); }
        segment += char;
        column += 1;
      }
      emit();
    }
    word = [];
    space = false;
  };
  const consume = (final: boolean) => {
    while (pending.length) {
      if (!final && pending.length === 1 && /[*_\\]/u.test(pending)) break;
      if (pending[0] === "\\" && pending.length > 1 && /[*_`\\]/u.test(pending[1]!)) {
        word.push({ text: pending[1]!, bold, code });
        pending = pending.slice(2);
      } else if (!code && (pending.startsWith("**") || pending.startsWith("__"))) {
        bold = !bold;
        pending = pending.slice(2);
      } else if (pending[0] === "`") {
        code = !code;
        pending = pending.slice(1);
      } else {
        const char = String.fromCodePoint(pending.codePointAt(0)!);
        pending = pending.slice(char.length);
        if (/\s/u.test(char)) {
          flushWord();
          if (char === "\n") newline();
          else space = column > 0;
        } else {
          const last = word.at(-1);
          if (last && last.bold === bold && last.code === code) last.text += char;
          else word.push({ text: char, bold, code });
        }
      }
    }
    if (final) flushWord();
  };
  return {
    push(text: string) { pending += text; consume(false); },
    finish() { consume(true); if (column) newline(); },
  };
}
