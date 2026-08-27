import { describeShape } from "../quests/adapter.ts";
import type { ExtractContext, QuestFormatAdapter, ValueShape } from "../quests/adapter.ts";
import { ftbQuestsLangAdapter } from "../quests/ftbquests_lang.ts";
import {
  countEscapedAmpersands,
  findFormattingCodes,
  findLineBreaks,
  findPlaceholders,
  stripPlaceholders,
} from "../quests/tokens.ts";
import type { TranslationUnit } from "../quests/adapter.ts";

export type ProblemKind =
  | "empty-source-changed"
  | "empty-translation"
  | "formatting-codes"
  | "escaped-ampersand"
  | "placeholders"
  | "line-breaks"
  | "unchanged"
  | "glossary"
  | "parse"
  | "missing-key"
  | "extra-key"
  | "value-type"
  | "array-length";

export interface Problem {
  kind: ProblemKind;
  message: string;
  id?: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: Problem[];
}

export interface UnitValidationOptions {
  glossary?: Readonly<Record<string, string>>;
}

/**
 * Below this length a string is usually a proper noun, an item name or a bare
 * placeholder, and coming back unchanged is correct rather than a failure.
 */
const UNCHANGED_MIN_LENGTH = 12;

function multisetDiff(
  a: readonly string[],
  b: readonly string[],
): { missing: string[]; extra: string[] } {
  const counts = new Map<string, number>();
  for (const token of a) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const token of b) counts.set(token, (counts.get(token) ?? 0) - 1);
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [token, count] of counts) {
    for (let i = 0; i < count; i++) missing.push(token);
    for (let i = 0; i < -count; i++) extra.push(token);
  }
  return { missing, extra };
}

/**
 * Does the string carry any meaning a translator could change? Placeholders are
 * removed with the same shared detector the preservation check uses, so the two
 * can never disagree -- a string the validator protects as markup is a string
 * this function agrees carries no prose.
 *
 * Exported because the packager asks the same question of a finished overlay.
 * `validateUnit` refuses a *provider* that hands a translatable string back
 * unchanged; provenance refuses a *payload* that still carries one. Two
 * separate notions of "this did not need translating" would mean an overlay
 * that no run could have produced, or one that every run does.
 */
export function isTranslatable(text: string): boolean {
  const stripped = stripPlaceholders(text)
    .replace(/[&§][0-9a-fk-orA-FK-OR]/g, "")
    .trim();
  return stripped.length >= UNCHANGED_MIN_LENGTH;
}

/** Validate one translated string against its source. Provider independent. */
export function validateUnit(
  unit: TranslationUnit,
  translation: string,
  options: UnitValidationOptions = {},
): ValidationResult {
  const problems: Problem[] = [];
  const push = (kind: ProblemKind, message: string) =>
    problems.push({ kind, message, id: unit.id });

  if (unit.text.trim().length === 0) {
    if (translation !== unit.text) {
      push(
        "empty-source-changed",
        `Empty source must stay empty, got ${JSON.stringify(translation)}`,
      );
    }
    return { ok: problems.length === 0, problems };
  }

  if (translation.trim().length === 0) {
    push("empty-translation", "Non-empty source produced an empty translation");
    return { ok: false, problems };
  }

  const codes = multisetDiff(findFormattingCodes(unit.text), findFormattingCodes(translation));
  if (codes.missing.length > 0 || codes.extra.length > 0) {
    push(
      "formatting-codes",
      `Formatting codes changed (missing: ${codes.missing.join(", ") || "none"}; ` +
        `unexpected: ${codes.extra.join(", ") || "none"})`,
    );
  }

  const sourceEscapes = countEscapedAmpersands(unit.text);
  if (sourceEscapes !== countEscapedAmpersands(translation)) {
    push(
      "escaped-ampersand",
      `Escaped ampersand count changed (source has ${sourceEscapes})`,
    );
  }

  const placeholders = multisetDiff(findPlaceholders(unit.text), findPlaceholders(translation));
  if (placeholders.missing.length > 0 || placeholders.extra.length > 0) {
    push(
      "placeholders",
      `Placeholders changed (missing: ${placeholders.missing.join(", ") || "none"}; ` +
        `unexpected: ${placeholders.extra.join(", ") || "none"})`,
    );
  }

  // A multiline value must stay multiline. Nothing else in this function would
  // notice a three-line description coming back as one run-on paragraph, and
  // FTB renders the result as an unreadable wall of text.
  const sourceBreaks = findLineBreaks(unit.text);
  const translatedBreaks = findLineBreaks(translation);
  if (sourceBreaks.join("\u0000") !== translatedBreaks.join("\u0000")) {
    push(
      "line-breaks",
      `Line breaks changed: source has ${describeBreaks(sourceBreaks)}, ` +
        `translation has ${describeBreaks(translatedBreaks)}`,
    );
  }

  if (translation === unit.text && isTranslatable(unit.text)) {
    push("unchanged", "Translation is identical to the source");
  }

  for (const [term, required] of Object.entries(options.glossary ?? {})) {
    if (unit.text.includes(term) && !translation.includes(required)) {
      push(
        "glossary",
        `Glossary term ${JSON.stringify(term)} must appear as ${JSON.stringify(required)}`,
      );
    }
  }

  return { ok: problems.length === 0, problems };
}

export interface IdValidationResult {
  ok: boolean;
  missing: string[];
  unknown: string[];
  duplicates: string[];
}

/**
 * Results are joined by id, never by position, so a response with a missing,
 * unknown or duplicated id is rejected outright.
 */
export function validateResponseIds(
  requested: readonly string[],
  returned: readonly { id: string }[],
): IdValidationResult {
  const wanted = new Set(requested);
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const unknown: string[] = [];

  for (const item of returned) {
    if (!wanted.has(item.id)) {
      if (!unknown.includes(item.id)) unknown.push(item.id);
      continue;
    }
    if (seen.has(item.id)) {
      if (!duplicates.includes(item.id)) duplicates.push(item.id);
      continue;
    }
    seen.add(item.id);
  }

  const missing = requested.filter((id) => !seen.has(id));
  return {
    ok: missing.length === 0 && unknown.length === 0 && duplicates.length === 0,
    missing,
    unknown,
    duplicates,
  };
}

/**
 * Whole-document validation: the output must parse, carry exactly the same key
 * set, and keep every value's shape. Run before anything is written.
 *
 * The format is the adapter's business -- SNBT compound, JSON object -- so this
 * asks it for a key-to-shape map and compares the two. One comparison serves
 * every format, which is why an SNBT array that came back a string and a JSON
 * key that came back missing produce the same problem kinds.
 */
export function validateDocumentWith(
  adapter: QuestFormatAdapter,
  source: string,
  output: string,
  context?: ExtractContext,
): ValidationResult {
  const problems: Problem[] = [];

  let sourceShapes: Map<string, ValueShape>;
  let outputShapes: Map<string, ValueShape>;
  try {
    sourceShapes = adapter.shapes(source, context);
  } catch (error) {
    return {
      ok: false,
      problems: [{ kind: "parse", message: `Source did not parse: ${describe(error)}` }],
    };
  }
  try {
    // Deliberately unfiltered: the output is supposed to hold exactly the
    // selected keys, so filtering it too would hide the extra ones.
    outputShapes = adapter.shapes(output);
  } catch (error) {
    return {
      ok: false,
      problems: [{ kind: "parse", message: `Translated output did not parse: ${describe(error)}` }],
    };
  }

  for (const [key, shape] of sourceShapes) {
    const other = outputShapes.get(key);
    if (other === undefined) {
      problems.push({ kind: "missing-key", message: `Key missing from output: ${key}`, id: key });
      continue;
    }
    if (shape.type !== other.type) {
      problems.push({
        kind: "value-type",
        message: `Key ${key} changed shape from ${describeShape(shape)} to ${describeShape(other)}`,
        id: key,
      });
      continue;
    }
    if (shape.length !== other.length) {
      problems.push({
        kind: "array-length",
        message: `Key ${key} changed from ${shape.length} to ${other.length} elements`,
        id: key,
      });
    }
  }

  for (const key of outputShapes.keys()) {
    if (!sourceShapes.has(key)) {
      problems.push({ kind: "extra-key", message: `Key not present in source: ${key}`, id: key });
    }
  }

  return { ok: problems.length === 0, problems };
}

/** Whole-document validation for the FTB Quests SNBT lang format. */
export function validateDocument(source: string, output: string): ValidationResult {
  return validateDocumentWith(ftbQuestsLangAdapter, source, output);
}

/** `2 (\n, \r\n)` -- enough to see both how many and which. */
function describeBreaks(breaks: readonly string[]): string {
  if (breaks.length === 0) return "0";
  const shown = breaks.map((b) => b.replace(/\r/g, "\\r").replace(/\n/g, "\\n"));
  return `${breaks.length} (${shown.join(", ")})`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
