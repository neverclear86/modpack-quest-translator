import type { SnbtCompound, SnbtValue } from "./model.ts";

const INDENT = "\t";

/** Keys FTB writes unquoted; anything outside this must stay quoted. */
const BARE_KEY = /^[A-Za-z0-9_.+\-]+$/;

export interface SerializeOptions {
  /**
   * Append a trailing newline after the root compound. Defaults to whatever
   * the parsed source had, so a round-trip is byte exact.
   */
  trailingNewline?: boolean;
  /** Line ending to emit. Defaults to whatever the parsed source used. */
  lineEnding?: "\n" | "\r\n";
}

export function escapeSnbtString(value: string): string {
  let out = "";
  for (const ch of value) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      default:
        out += ch;
    }
  }
  return out;
}

function serializeKey(key: string, quoted: boolean): string {
  return quoted || !BARE_KEY.test(key) ? `"${escapeSnbtString(key)}"` : key;
}

function serializeValue(value: SnbtValue, depth: number): string {
  switch (value.type) {
    case "string":
      return `"${escapeSnbtString(value.value)}"`;
    case "number":
      return value.literal;
    case "boolean":
      return value.value ? "true" : "false";
    case "typedArray":
      return `[${value.prefix};${
        value.items.map((item) => serializeValue(item, depth)).join(", ")
      }]`;
    case "array": {
      if (value.items.length === 0) return "[ ]";
      if (value.inline) {
        return `[${value.items.map((item) => serializeValue(item, depth)).join(", ")}]`;
      }
      const inner = INDENT.repeat(depth + 1);
      const lines = value.items.map((item) => `${inner}${serializeValue(item, depth + 1)}`);
      return `[\n${lines.join("\n")}\n${INDENT.repeat(depth)}]`;
    }
    case "compound":
      return serializeCompound(value, depth);
  }
}

function serializeCompound(compound: SnbtCompound, depth: number): string {
  if (compound.members.length === 0) return "{ }";
  if (compound.inline) {
    const parts = compound.members.map((m) =>
      `${serializeKey(m.key, m.quotedKey)}: ${serializeValue(m.value, depth)}`
    );
    return `{${parts.join(", ")}}`;
  }
  const inner = INDENT.repeat(depth + 1);
  const lines = compound.members.map((m) =>
    `${inner}${serializeKey(m.key, m.quotedKey)}: ${serializeValue(m.value, depth + 1)}`
  );
  return `{\n${lines.join("\n")}\n${INDENT.repeat(depth)}}`;
}

/** Serialize back to the tab-indented, newline-separated form FTB Quests writes. */
export function serializeSnbt(root: SnbtCompound, options: SerializeOptions = {}): string {
  const body = serializeCompound(root, 0);
  const trailing = options.trailingNewline ?? root.trailingNewline ?? true;
  const text = trailing ? `${body}\n` : body;
  const lineEnding = options.lineEnding ?? root.lineEnding ?? "\n";
  // The builder always emits LF; convert once at the end.
  return lineEnding === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}
