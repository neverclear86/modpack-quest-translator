import { parseSnbt } from "../quests/snbt/mod.ts";
import type { SnbtValue } from "../quests/snbt/mod.ts";
import {
  countEscapedAmpersands,
  findFormattingCodes,
  findPlaceholders,
} from "../quests/tokens.ts";
import type { TranslationUnit } from "../quests/adapter.ts";

export type ProblemKind =
  | "empty-source-changed"
  | "empty-translation"
  | "formatting-codes"
  | "escaped-ampersand"
  | "placeholders"
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

function multisetDiff(a: readonly string[], b: readonly string[]): { missing: string[]; extra: string[] } {
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

/** Does the string carry any meaning a translator could change? */
function isTranslatable(text: string): boolean {
  const stripped = text
    .replace(/[&§][0-9a-fk-orA-FK-OR]/g, "")
    .replace(/%\d+\$[sdfx]|%[sdfx]|%%/g, "")
    .replace(/\{[^{}\n]*\}/g, "")
    .replace(/<[a-zA-Z_][a-zA-Z0-9_:.]*>/g, "")
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
  const push = (kind: ProblemKind, message: string) => problems.push({ kind, message, id: unit.id });

  if (unit.text.trim().length === 0) {
    if (translation !== unit.text) {
      push("empty-source-changed", `Empty source must stay empty, got ${JSON.stringify(translation)}`);
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

  if (translation === unit.text && isTranslatable(unit.text)) {
    push("unchanged", "Translation is identical to the source");
  }

  for (const [term, required] of Object.entries(options.glossary ?? {})) {
    if (unit.text.includes(term) && !translation.includes(required)) {
      push("glossary", `Glossary term ${JSON.stringify(term)} must appear as ${JSON.stringify(required)}`);
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

function shapeOf(value: SnbtValue): string {
  return value.type === "array" ? `array[${value.items.length}]` : value.type;
}

/**
 * Whole-document validation: the output must parse, carry exactly the same key
 * set, and keep every value's shape. Run before anything is written.
 */
export function validateDocument(source: string, output: string): ValidationResult {
  const problems: Problem[] = [];

  let sourceRoot, outputRoot;
  try {
    sourceRoot = parseSnbt(source);
  } catch (error) {
    return {
      ok: false,
      problems: [{ kind: "parse", message: `Source did not parse: ${describe(error)}` }],
    };
  }
  try {
    outputRoot = parseSnbt(output);
  } catch (error) {
    return {
      ok: false,
      problems: [{ kind: "parse", message: `Translated output did not parse: ${describe(error)}` }],
    };
  }

  const sourceMembers = new Map(sourceRoot.members.map((m) => [m.key, m.value]));
  const outputMembers = new Map(outputRoot.members.map((m) => [m.key, m.value]));

  for (const [key, value] of sourceMembers) {
    const other = outputMembers.get(key);
    if (other === undefined) {
      problems.push({ kind: "missing-key", message: `Key missing from output: ${key}`, id: key });
      continue;
    }
    if (value.type !== other.type) {
      problems.push({
        kind: "value-type",
        message: `Key ${key} changed shape from ${shapeOf(value)} to ${shapeOf(other)}`,
        id: key,
      });
      continue;
    }
    if (value.type === "array" && other.type === "array" && value.items.length !== other.items.length) {
      problems.push({
        kind: "array-length",
        message: `Key ${key} changed from ${value.items.length} to ${other.items.length} elements`,
        id: key,
      });
    }
  }

  for (const key of outputMembers.keys()) {
    if (!sourceMembers.has(key)) {
      problems.push({ kind: "extra-key", message: `Key not present in source: ${key}`, id: key });
    }
  }

  return { ok: problems.length === 0, problems };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
