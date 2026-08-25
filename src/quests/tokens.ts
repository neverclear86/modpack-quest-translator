/**
 * Token scanning shared by the adapter (which reports protected tokens to the
 * provider) and the validator (which enforces that they survived).
 */

/** Minecraft/FTB formatting codes: `&6`, `§r`. `\&` is an escaped literal. */
export function findFormattingCodes(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      // `\&` is a literal ampersand, not a code; skip the escaped character.
      i++;
      continue;
    }
    if ((ch === "&" || ch === "§") && i + 1 < text.length) {
      const code = text[i + 1];
      if (/[0-9a-fk-orA-FK-OR]/.test(code)) {
        out.push(ch + code.toLowerCase());
        i++;
      }
    }
  }
  return out;
}

/**
 * A printf / `java.util.Formatter` conversion specification, matched whole:
 *
 * ```text
 * %[argument_index$ | <][flags][width][.precision]conversion
 * ```
 *
 * Matching the whole specification is the point. Recognising only the trailing
 * letter would let `%02d` come back as `%2d`, or `%1$.2f` as `%1$.0f`, with the
 * validator seeing an unchanged `%d`/`%f` and waving it through.
 *
 * Deliberate limits:
 *  - the space flag (`% d`) is *not* recognised. It is vanishingly rare in
 *    quest text and it collides with ordinary prose: "50% stronger" would scan
 *    as the conversion `% s` and fail every honest translation of that string.
 *  - conversions are the `java.util.Formatter` set (Minecraft is Java) plus the
 *    C spellings `u` and `i`, which some mods copy from C-style format strings.
 *  - `%tX`/`%TX` date-time conversions take their trailing letter with them.
 *  - `%%` is one token, so `%%s` is a literal percent followed by the letter s
 *    and never a second `%s` placeholder.
 */
const PRINTF_CONVERSION =
  /%(?:%|(?:\d+\$|<)?[-#+0,(]*\d*(?:\.\d+)?(?:[tT][a-zA-Z]|[bBhHsScCdoxXeEfgGaAnui]))/g;

/**
 * Substitution markers that must survive translation unchanged: printf-style
 * tokens, positional arguments, FTB `{...}` blocks and `<...>` mod variables.
 * Every consumer -- the adapter reporting protected tokens, the validator
 * enforcing them, and the "is there any prose here at all" check -- scans with
 * this one list, so they can never disagree about what a placeholder is.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  PRINTF_CONVERSION,
  /\{[^{}\n]*\}/g, // {image:...}, {player}
  /\$\([^)\n]*\)/g, // $(...)
  /<[a-zA-Z_][a-zA-Z0-9_:.]*>/g, // <player_name>
];

export function findPlaceholders(text: string): string[] {
  const out: string[] = [];
  for (const pattern of PLACEHOLDER_PATTERNS) {
    for (const match of text.matchAll(pattern)) out.push(match[0]);
  }
  return out;
}

/**
 * Remove every placeholder, so a caller can ask what prose is left. Shared with
 * the validator's "did this actually need translating?" test: a string made
 * only of markup must be allowed to come back byte-identical.
 */
export function stripPlaceholders(text: string): string {
  let out = text;
  for (const pattern of PLACEHOLDER_PATTERNS) out = out.replace(pattern, "");
  return out;
}

/** Literal `\&` sequences FTB uses to escape the formatting character. */
export function countEscapedAmpersands(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === "\\" && text[i + 1] === "&") {
      count++;
      i++;
    }
  }
  return count;
}

/** Everything the provider is told it must reproduce verbatim. */
export function protectedTokensOf(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of [...findFormattingCodes(text), ...findPlaceholders(text)]) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}
