import { AppError } from "../errors.ts";
import { isArray, isString, parseSnbt, serializeSnbt } from "./snbt/mod.ts";
import type { SnbtCompound } from "./snbt/mod.ts";
import type {
  DetectionResult,
  QuestFormatAdapter,
  TranslatableDocument,
  TranslationUnit,
} from "./adapter.ts";
import { protectedTokensOf } from "./tokens.ts";

/** `quest.02B0448DA14595B0.quest_subtitle` -> objectId `02B0448DA14595B0`. */
const KEY_SHAPE = /^([a-z_]+)\.([0-9A-Fa-f]{4,32})\.([a-z_]+)$/;

function unitId(key: string, index: number): string {
  return index < 0 ? key : `${key}#${index}`;
}

function kindOf(key: string): string {
  const parts = key.split(".");
  return parts.length > 1 ? parts[parts.length - 1] : key;
}

function objectIdOf(key: string): string | undefined {
  const match = KEY_SHAPE.exec(key);
  return match ? match[2] : undefined;
}

function collect(root: SnbtCompound): TranslationUnit[] {
  const units: TranslationUnit[] = [];
  for (const member of root.members) {
    const kind = kindOf(member.key);
    const objectId = objectIdOf(member.key);
    if (isString(member.value)) {
      units.push({
        id: unitId(member.key, -1),
        key: member.key,
        kind,
        index: -1,
        objectId,
        text: member.value.value,
        protectedTokens: protectedTokensOf(member.value.value),
      });
      continue;
    }
    if (isArray(member.value)) {
      member.value.items.forEach((item, index) => {
        // Array elements that are not strings are structural; leave them alone.
        if (!isString(item)) return;
        units.push({
          id: unitId(member.key, index),
          key: member.key,
          kind,
          index,
          objectId,
          text: item.value,
          protectedTokens: protectedTokensOf(item.value),
        });
      });
    }
    // Numbers, booleans and nested compounds are never quest prose.
  }
  return units;
}

export const ftbQuestsLangAdapter: QuestFormatAdapter = {
  id: "ftbquests-lang",
  description: "Modern FTB Quests localization file (config/ftbquests/quests/lang/*.snbt)",

  detect(source: string): DetectionResult {
    let root: SnbtCompound;
    try {
      root = parseSnbt(source);
    } catch (error) {
      return {
        supported: false,
        reason: error instanceof Error ? error.message : "the file could not be parsed as SNBT",
      };
    }
    const units = collect(root);
    if (units.length === 0) {
      return { supported: false, reason: "the file contains no translatable strings" };
    }
    // A modern lang file is a flat map of dotted keys to strings/arrays. An
    // inline quest file has a `quests` array of compounds instead.
    const dotted = root.members.filter((m) => m.key.includes(".")).length;
    if (dotted === 0) {
      return {
        supported: false,
        reason: "the file is not a flat FTB Quests lang map (no dotted translation keys found)",
      };
    }
    return { supported: true };
  },

  extract(source: string): TranslatableDocument {
    const root = parseSnbt(source);
    const units = collect(root);
    return { units, keyCount: root.members.length };
  },

  apply(source: string, translations: ReadonlyMap<string, string>): string {
    const root = parseSnbt(source);
    const applied = new Set<string>();

    const take = (id: string): string => {
      const value = translations.get(id);
      if (value === undefined) {
        throw new AppError("E_VALIDATION", `No translation was produced for ${id}`, {
          hint: "Refusing to write a partially translated quest file.",
        });
      }
      applied.add(id);
      return value;
    };

    for (const member of root.members) {
      if (isString(member.value)) {
        member.value.value = take(unitId(member.key, -1));
        continue;
      }
      if (isArray(member.value)) {
        member.value.items.forEach((item, index) => {
          if (!isString(item)) return;
          item.value = take(unitId(member.key, index));
        });
      }
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

    return serializeSnbt(root);
  },
};
