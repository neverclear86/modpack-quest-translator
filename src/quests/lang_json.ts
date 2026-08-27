import { AppError } from "../errors.ts";
import type {
  DetectionResult,
  ExtractContext,
  QuestFormatAdapter,
  TranslatableDocument,
  TranslationUnit,
  ValueShape,
} from "./adapter.ts";
import { protectedTokensOf } from "./tokens.ts";

/**
 * A Minecraft resource-pack language file: a flat JSON object of translation
 * key to string. Same units, same protected tokens and the same validation as
 * the SNBT adapter -- only the container differs.
 *
 * Extraction is normally narrowed by `context.keys` to the keys the pack's quest
 * files actually reference. A mod's `en_us.json` also carries its item names and
 * GUI labels, and translating those would quietly turn a quest translation into
 * a whole-mod translation.
 */

function parseObject(source: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new AppError("E_INVALID_INPUT", `${what} is not valid JSON`, {
      cause,
      hint: "A Minecraft language file is a JSON object mapping translation keys to strings.",
    });
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError("E_INVALID_INPUT", `${what} is not a JSON object`, {
      hint: "A Minecraft language file is a JSON object mapping translation keys to strings.",
    });
  }
  return parsed as Record<string, unknown>;
}

/**
 * `quest.guide.fiber.description_1` -> `description`. The trailing index is how
 * packs split one description across several lines; it is not a kind of its own,
 * and telling the provider "this is a description" is the useful part.
 */
function kindOf(key: string): string {
  const last = key.split(".").pop() ?? key;
  return last.replace(/_\d+$/, "");
}

interface Selection {
  units: TranslationUnit[];
}

function select(source: string, context: ExtractContext | undefined, what: string): Selection {
  const object = parseObject(source, what);
  const wanted = context?.keys ? new Set(context.keys) : undefined;
  const units: TranslationUnit[] = [];
  const nonString: string[] = [];

  for (const [key, value] of Object.entries(object)) {
    if (wanted && !wanted.has(key)) continue;
    if (typeof value !== "string") {
      // A key nobody asked for is simply not ours to judge; a referenced key
      // that is not a string cannot be translated and must not be guessed at.
      if (wanted) nonString.push(key);
      continue;
    }
    units.push({
      id: key,
      key,
      kind: kindOf(key),
      index: -1,
      text: value,
      protectedTokens: protectedTokensOf(value),
    });
  }

  if (nonString.length > 0) {
    throw new AppError(
      "E_INVALID_INPUT",
      `${nonString.length} referenced translation key(s) in ${what} are not strings: ` +
        nonString.slice(0, 5).join(", "),
      {
        hint: "Minecraft language files map every key to a string. " +
          "Refusing to guess at a value the game itself could not render.",
      },
    );
  }

  return { units };
}

export const minecraftLangJsonAdapter: QuestFormatAdapter = {
  id: "minecraft-lang-json",
  description: "Minecraft language file (assets/<namespace>/lang/<locale>.json)",
  payloadExtension: "json",

  detect(source: string): DetectionResult {
    let object: Record<string, unknown>;
    try {
      object = parseObject(source, "the language file");
    } catch (error) {
      return {
        supported: false,
        reason: error instanceof Error ? error.message : "the file could not be parsed as JSON",
      };
    }
    const strings = Object.values(object).filter((v) => typeof v === "string").length;
    if (strings === 0) {
      return { supported: false, reason: "the file contains no translatable strings" };
    }
    return { supported: true };
  },

  extract(source: string, context?: ExtractContext): TranslatableDocument {
    const { units } = select(source, context, "the language file");
    return { units, keyCount: units.length };
  },

  shapes(source: string, context?: ExtractContext): Map<string, ValueShape> {
    const shapes = new Map<string, ValueShape>();
    for (const unit of select(source, context, "the language file").units) {
      shapes.set(unit.key, { type: "string" });
    }
    return shapes;
  },

  apply(
    source: string,
    translations: ReadonlyMap<string, string>,
    context?: ExtractContext,
  ): string {
    const { units } = select(source, context, "the language file");
    const out: Record<string, string> = {};
    const applied = new Set<string>();

    for (const unit of units) {
      const value = translations.get(unit.id);
      if (value === undefined) {
        throw new AppError("E_VALIDATION", `No translation was produced for ${unit.id}`, {
          hint: "Refusing to write a partially translated language file.",
        });
      }
      applied.add(unit.id);
      out[unit.key] = value;
    }

    if (applied.size !== translations.size) {
      const unknown = [...translations.keys()].filter((id) => !applied.has(id));
      throw new AppError(
        "E_VALIDATION",
        `Translation result contains ${unknown.length} id(s) that are not in the source file: ` +
          unknown.slice(0, 5).join(", "),
        { hint: "The provider returned keys that were never requested." },
      );
    }

    return `${JSON.stringify(out, null, 2)}\n`;
  },
};
