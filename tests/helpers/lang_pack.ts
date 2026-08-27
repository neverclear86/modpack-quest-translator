/**
 * Synthetic fixtures for the "quest chapters reference Minecraft translation
 * keys, the English strings live in a mod jar" shape (DeceasedCraft-style).
 *
 * The chapter files are real committed SNBT so the parser is exercised on the
 * shape a pack actually ships; the lang JSON is built here so a test can bend
 * one value without a second fixture file.
 */

import { writeZip } from "../../src/archive/zip/writer.ts";

export const INTRO_SNBT = await Deno.readTextFile(
  new URL("../fixtures/questpack/intro.snbt", import.meta.url),
);
export const SURVIVAL_SNBT = await Deno.readTextFile(
  new URL("../fixtures/questpack/survival.snbt", import.meta.url),
);
export const CHAPTER_GROUPS_SNBT = await Deno.readTextFile(
  new URL("../fixtures/questpack/chapter_groups.snbt", import.meta.url),
);

/** Every key the fixture chapters reference, in first-seen order. */
export const REFERENCED_KEYS = [
  "quest.main",
  "quest.guide",
  "quest.intro.hotkeys.description_1",
  "quest.intro.hotkeys.description_2",
  "quest.intro.hotkeys.subtitle",
  "quest.intro.hotkeys.title",
  "quest.intro.subtitle",
  "quest.intro",
  "quest.guide.survival.fiber.description_1",
  "quest.guide.survival.fiber.description_2",
  "quest.guide.survival.fiber.subtitle",
  "quest.guide.survival.fiber.title",
  "quest.guide.survival.tesla.description_1",
];

/** Referenced but deliberately absent from the lang JSON. */
export const MISSING_KEY = "quest.guide.survival.tesla.description_1";

/**
 * The provider mod's English strings. `unused.*` is present but never
 * referenced, so it proves extraction filters by reference rather than by file.
 */
export function englishLang(): Record<string, string> {
  return {
    "quest.main": "Main",
    "quest.guide": "Guides",
    "quest.intro": "Useful Hotkeys",
    "quest.intro.subtitle": "Beginners Guide to Modded Minecraft",
    "quest.intro.hotkeys.title": "Hotkey List",
    "quest.intro.hotkeys.subtitle": "Learn the &6hotkeys&r you will use every day",
    "quest.intro.hotkeys.description_1": "Press &eE&r to open your inventory.",
    "quest.intro.hotkeys.description_2": "You can craft up to %s items at once.",
    "quest.guide.survival.fiber.title": "Fiber on Demand",
    // A literal `\&` is how FTB escapes the formatting character; it must survive.
    "quest.guide.survival.fiber.subtitle": "Turn plants into \\& fiber",
    "quest.guide.survival.fiber.description_1": "Collect tall grass to get plant fiber.",
    "quest.guide.survival.fiber.description_2": "",
    "unused.key.not.referenced": "This string must never reach the resource pack.",
    "item.examplepack.plant_fiber": "Plant Fiber",
  };
}

export function langJson(entries: Record<string, string> = englishLang()): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}

export interface PackOptions {
  /** Root inside the archive; CurseForge and Modrinth both use `overrides/`. */
  root?: string;
  minecraftVersion?: string;
  /** Also ship a modern lang/<locale>.snbt, so mode selection can be tested. */
  snbtLang?: string;
  /** Extra, parseable but reference-free `.snbt` files, for the file-count cap. */
  filler?: number;
}

/** A CurseForge-flavoured modpack archive whose quests use placeholders only. */
export async function buildQuestPack(options: PackOptions = {}): Promise<Uint8Array> {
  const root = options.root ?? "overrides/";
  const quests = `${root}config/ftbquests/quests`;
  const entries = [
    {
      path: "manifest.json",
      text: JSON.stringify({
        minecraft: {
          version: options.minecraftVersion ?? "1.20.1",
          modLoaders: [{ id: "forge-47.4.0", primary: true }],
        },
        manifestType: "minecraftModpack",
        name: "Example Pack",
        version: "5.10.17",
      }),
    },
    { path: `${quests}/chapters/intro.snbt`, text: INTRO_SNBT },
    { path: `${quests}/chapters/survival.snbt`, text: SURVIVAL_SNBT },
    { path: `${quests}/chapter_groups.snbt`, text: CHAPTER_GROUPS_SNBT },
    { path: `${root}mods/SomeMod-1.0.jar`, text: "not really a jar" },
  ];
  if (options.snbtLang !== undefined) {
    entries.push({ path: `${quests}/lang/en_us.snbt`, text: options.snbtLang });
  }
  for (let i = 0; i < (options.filler ?? 0); i++) {
    entries.push({
      path: `${quests}/chapters/filler_${String(i).padStart(4, "0")}.snbt`,
      text: `{\n\tid: "FILLER${String(i).padStart(10, "0")}"\n}\n`,
    });
  }
  return await writeZip(entries);
}

const SIG_EOCD = 0x06054B50;
const SIG_CENTRAL = 0x02014B50;

/**
 * Make one entry unreadable without making the archive unreadable.
 *
 * The central directory is what `readZip` trusts, so pointing a record's local
 * header offset at a byte that is not a local header leaves the listing intact
 * and fails only when that one entry is actually read -- exactly the shape of a
 * truncated or damaged jar entry in the wild.
 */
export function breakEntryData(zip: Uint8Array, path: string): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);

  let eocd = -1;
  for (let i = out.byteLength - 22; i >= 0; i--) {
    if (view.getUint32(i, true) !== SIG_EOCD) continue;
    if (i + 22 + view.getUint16(i + 20, true) === out.byteLength) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end of central directory record");

  const wanted = new TextEncoder().encode(path);
  let cursor = view.getUint32(eocd + 16, true);
  const count = view.getUint16(eocd + 10, true);
  for (let i = 0; i < count; i++) {
    if (view.getUint32(cursor, true) !== SIG_CENTRAL) throw new Error("bad central directory");
    const nameLength = view.getUint16(cursor + 28, true);
    const name = out.subarray(cursor + 46, cursor + 46 + nameLength);
    if (nameLength === wanted.byteLength && wanted.every((b, k) => name[k] === b)) {
      view.setUint32(cursor + 42, 3, true);
      return out;
    }
    cursor = cursor + 46 + nameLength + view.getUint16(cursor + 30, true) +
      view.getUint16(cursor + 32, true);
  }
  throw new Error(`no central directory record for ${path}`);
}

export interface JarOptions {
  /** namespace -> locale -> entries. */
  namespaces?: Record<string, Record<string, Record<string, string>>>;
  /**
   * namespace -> locale -> the exact file text. For the shapes a well-typed
   * entry map cannot express: malformed JSON, an array, an empty object, or a
   * key whose value is not a string.
   */
  rawNamespaces?: Record<string, Record<string, string>>;
}

/** A mod jar carrying `assets/<namespace>/lang/<locale>.json`. */
export async function buildLangJar(options: JarOptions = {}): Promise<Uint8Array> {
  const namespaces = options.namespaces ?? (options.rawNamespaces ? {} : {
    examplepack: { en_us: englishLang() },
    // A second namespace with no referenced key at all: present, but never a
    // candidate, so auto-detection must still be unambiguous.
    hordes: {
      en_us: {
        "message.hordes.EventStart": "The horde is coming!",
        "message.hordes.EventEnd": "The horde has passed.",
      },
    },
  });

  const entries: { path: string; text: string }[] = [
    { path: "META-INF/MANIFEST.MF", text: "Manifest-Version: 1.0\n" },
    // Proof that nothing outside assets/<ns>/lang is read, copied or run.
    { path: "com/example/Tweaks.class", text: "Êþº¾ not bytecode" },
    // Nested `assets/.../assets/...` trees exist in real jars and are not
    // top-level namespaces.
    { path: "assets/tacz/bf1_default_gun/assets/bf1/lang/en_us.json", text: '{"a.b":"nested"}' },
  ];
  for (const [namespace, locales] of Object.entries(namespaces)) {
    for (const [locale, values] of Object.entries(locales)) {
      entries.push({ path: `assets/${namespace}/lang/${locale}.json`, text: langJson(values) });
    }
  }
  for (const [namespace, locales] of Object.entries(options.rawNamespaces ?? {})) {
    for (const [locale, text] of Object.entries(locales)) {
      entries.push({ path: `assets/${namespace}/lang/${locale}.json`, text });
    }
  }
  return await writeZip(entries);
}
