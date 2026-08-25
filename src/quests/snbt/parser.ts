import { AppError } from "../../errors.ts";
import type { SnbtCompound, SnbtMember, SnbtValue } from "./model.ts";

const MAX_DEPTH = 64;

/** Characters allowed in an unquoted key or number literal. */
const BARE_CHAR = /[A-Za-z0-9_.+\-]/;

class Parser {
  #text: string;
  #pos = 0;

  constructor(text: string) {
    this.#text = text;
  }

  parseDocument(): SnbtCompound {
    this.#skipTrivia();
    if (this.#peek() !== "{") this.#fail("expected the document to start with '{'");
    const root = this.#parseCompound(0);
    const afterRoot = this.#pos;
    this.#skipTrivia();
    if (this.#pos < this.#text.length) {
      this.#fail("unexpected trailing content after the root compound");
    }
    root.trailingNewline = this.#text.slice(afterRoot).includes("\n");
    root.lineEnding = this.#text.includes("\r\n") ? "\r\n" : "\n";
    return root;
  }

  #parseValue(depth: number): SnbtValue {
    if (depth > MAX_DEPTH) this.#fail(`nesting deeper than ${MAX_DEPTH} levels`);
    const ch = this.#peek();
    if (ch === undefined) this.#fail("unexpected end of input where a value was expected");
    if (ch === "{") return this.#parseCompound(depth);
    if (ch === "[") return this.#parseArray(depth);
    if (ch === '"' || ch === "'") return { type: "string", value: this.#parseQuoted() };
    return this.#parseBare();
  }

  #parseCompound(depth: number): SnbtCompound {
    this.#expect("{");
    const members: SnbtMember[] = [];
    const seen = new Set<string>();
    let sawBreak = false;

    for (;;) {
      sawBreak = this.#skipTriviaSeenBreak() || sawBreak;
      const ch = this.#peek();
      if (ch === undefined) this.#fail("unterminated compound");
      if (ch === "}") {
        this.#pos++;
        break;
      }
      if (ch === ",") {
        this.#pos++;
        continue;
      }

      const { key, quoted } = this.#parseKey();
      this.#skipTrivia();
      this.#expect(":");
      this.#skipTrivia();
      const value = this.#parseValue(depth + 1);

      if (seen.has(key)) {
        throw new AppError(
          "E_VALIDATION",
          `Duplicate SNBT key ${JSON.stringify(key)} at line ${this.#lineOf(this.#pos)}`,
          { hint: "A duplicate key means one quest string would be silently lost." },
        );
      }
      seen.add(key);
      members.push({ key, quotedKey: quoted, value });
    }

    // "Inline" means the braces hug their contents, not that the whole compound
    // fits on one line: FTB writes `[{` ... `}]` around a multi-line compound.
    return { type: "compound", members, inline: !sawBreak };
  }

  #parseArray(depth: number): SnbtValue {
    this.#expect("[");

    // Typed array prefix: [I; ...], [B; ...], [L; ...]
    const save = this.#pos;
    const prefixChar = this.#peek();
    if (prefixChar !== undefined && /[IBL]/.test(prefixChar) && this.#text[this.#pos + 1] === ";") {
      this.#pos += 2;
      const items: SnbtValue[] = [];
      for (;;) {
        this.#skipTrivia();
        const ch = this.#peek();
        if (ch === undefined) this.#fail("unterminated typed array");
        if (ch === "]") {
          this.#pos++;
          break;
        }
        if (ch === ",") {
          this.#pos++;
          continue;
        }
        items.push(this.#parseValue(depth + 1));
      }
      return { type: "typedArray", prefix: prefixChar, items };
    }
    this.#pos = save;

    const items: SnbtValue[] = [];
    let sawBreak = false;
    for (;;) {
      sawBreak = this.#skipTriviaSeenBreak() || sawBreak;
      const ch = this.#peek();
      if (ch === undefined) this.#fail("unterminated array");
      if (ch === "]") {
        this.#pos++;
        break;
      }
      if (ch === ",") {
        this.#pos++;
        continue;
      }
      items.push(this.#parseValue(depth));
    }
    return { type: "array", items, inline: !sawBreak };
  }

  #parseKey(): { key: string; quoted: boolean } {
    const ch = this.#peek();
    if (ch === '"' || ch === "'") return { key: this.#parseQuoted(), quoted: true };
    const start = this.#pos;
    while (this.#pos < this.#text.length && BARE_CHAR.test(this.#text[this.#pos])) this.#pos++;
    if (this.#pos === start) this.#fail("expected a member key");
    return { key: this.#text.slice(start, this.#pos), quoted: false };
  }

  #parseQuoted(): string {
    const quote = this.#text[this.#pos];
    this.#pos++;
    let out = "";
    for (;;) {
      if (this.#pos >= this.#text.length) this.#fail("unterminated string");
      const ch = this.#text[this.#pos];
      if (ch === "\n") {
        this.#fail("unterminated string: a newline appeared before the closing quote");
      }
      if (ch === quote) {
        this.#pos++;
        return out;
      }
      if (ch === "\\") {
        this.#pos++;
        if (this.#pos >= this.#text.length) this.#fail("unterminated escape sequence");
        const esc = this.#text[this.#pos];
        this.#pos++;
        switch (esc) {
          case "n":
            out += "\n";
            break;
          case "t":
            out += "\t";
            break;
          case "r":
            out += "\r";
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "/":
            out += "/";
            break;
          case '"':
            out += '"';
            break;
          case "'":
            out += "'";
            break;
          case "\\":
            out += "\\";
            break;
          case "u": {
            const hex = this.#text.slice(this.#pos, this.#pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.#fail("malformed \\u escape");
            out += String.fromCharCode(parseInt(hex, 16));
            this.#pos += 4;
            break;
          }
          default:
            // FTB writes `\&` for a literal ampersand; keep unknown escapes verbatim.
            out += "\\" + esc;
        }
        continue;
      }
      out += ch;
      this.#pos++;
    }
  }

  #parseBare(): SnbtValue {
    const start = this.#pos;
    while (this.#pos < this.#text.length && BARE_CHAR.test(this.#text[this.#pos])) this.#pos++;
    const raw = this.#text.slice(start, this.#pos);
    if (raw.length === 0) {
      this.#fail(`unexpected character ${JSON.stringify(this.#text[this.#pos])}`);
    }
    if (raw === "true") return { type: "boolean", value: true };
    if (raw === "false") return { type: "boolean", value: false };
    if (/^[+-]?(\d+\.?\d*|\.\d+)([bslfdBSLFD])?$/.test(raw)) {
      return { type: "number", literal: raw };
    }
    // An unquoted token that is neither a number nor a boolean is still a
    // string in SNBT.
    return { type: "string", value: raw };
  }

  /** Skip trivia, reporting whether any of it contained a line break. */
  #skipTriviaSeenBreak(): boolean {
    const start = this.#pos;
    this.#skipTrivia();
    return this.#text.slice(start, this.#pos).includes("\n");
  }

  #skipTrivia(): void {
    for (;;) {
      const ch = this.#text[this.#pos];
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
        this.#pos++;
        continue;
      }
      // Line comments are not part of vanilla SNBT but appear in hand-edited files.
      if (ch === "#" || (ch === "/" && this.#text[this.#pos + 1] === "/")) {
        while (this.#pos < this.#text.length && this.#text[this.#pos] !== "\n") this.#pos++;
        continue;
      }
      return;
    }
  }

  #peek(): string | undefined {
    return this.#text[this.#pos];
  }

  #expect(ch: string): void {
    if (this.#text[this.#pos] !== ch) {
      this.#fail(
        `expected ${JSON.stringify(ch)} but found ${JSON.stringify(this.#peek() ?? "<eof>")}`,
      );
    }
    this.#pos++;
  }

  #lineOf(pos: number): number {
    let line = 1;
    for (let i = 0; i < pos && i < this.#text.length; i++) {
      if (this.#text[i] === "\n") line++;
    }
    return line;
  }

  #columnOf(pos: number): number {
    let column = 1;
    for (let i = 0; i < pos && i < this.#text.length; i++) {
      column = this.#text[i] === "\n" ? 1 : column + 1;
    }
    return column;
  }

  #fail(message: string): never {
    const line = this.#lineOf(this.#pos);
    const column = this.#columnOf(this.#pos);
    throw new AppError(
      "E_VALIDATION",
      `SNBT parse error at line ${line}, column ${column}: ${message}`,
      {
        details: { line, column },
        hint: "The quest file may use a format this version does not support.",
      },
    );
  }
}

export function parseSnbt(text: string): SnbtCompound {
  return new Parser(text).parseDocument();
}
