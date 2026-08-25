/**
 * AST for the FTB Quests dialect of SNBT. Rich enough to round-trip the
 * constructs real packs use, and to rewrite string values in place without
 * disturbing anything else. See DESIGN.md §5.
 */
export type SnbtValue =
  | SnbtString
  | SnbtNumber
  | SnbtBoolean
  | SnbtArray
  | SnbtTypedArray
  | SnbtCompound;

export interface SnbtString {
  readonly type: "string";
  value: string;
}

export interface SnbtNumber {
  readonly type: "number";
  /** The literal exactly as written, including any type suffix (`0.0d`, `12L`). */
  readonly literal: string;
}

export interface SnbtBoolean {
  readonly type: "boolean";
  readonly value: boolean;
}

export interface SnbtArray {
  readonly type: "array";
  items: SnbtValue[];
  /** True when the source wrote the whole array on one line. */
  inline: boolean;
}

export interface SnbtTypedArray {
  readonly type: "typedArray";
  /** `I`, `B` or `L`. */
  readonly prefix: string;
  readonly items: SnbtValue[];
}

export interface SnbtMember {
  readonly key: string;
  /** True when the key was quoted in the source. */
  readonly quotedKey: boolean;
  value: SnbtValue;
}

export interface SnbtCompound {
  readonly type: "compound";
  members: SnbtMember[];
  /** True when the source wrote the whole compound on one line. */
  inline: boolean;
  /**
   * Root only: whether the source file ended with a newline. Preserved so a
   * round-trip does not gain or lose one.
   */
  trailingNewline?: boolean;
  /**
   * Root only: the line ending the source used. Real FTB Quests lang files ship
   * with CRLF, and rewriting them as LF would turn every line into a spurious
   * diff against the pack's own output.
   */
  lineEnding?: "\n" | "\r\n";
}

export function isString(value: SnbtValue): value is SnbtString {
  return value.type === "string";
}

export function isArray(value: SnbtValue): value is SnbtArray {
  return value.type === "array";
}
