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
 * Substitution markers that must survive translation unchanged: printf-style
 * tokens, positional arguments, FTB `{...}` blocks and `<...>` mod variables.
 */
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /%\d+\$[sdfx]/g, // %1$s
  /%[sdfx]/g, // %s
  /%%/g,
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
