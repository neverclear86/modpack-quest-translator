/**
 * Minecraft resource-pack shape.
 *
 * A resource pack is the only supported way to change a *mod's* translation
 * strings without touching the mod: the game merges `assets/<namespace>/lang/
 * <locale>.json` from every enabled pack over the jar's own, key by key. That
 * is why this mode can ship only the quest keys and leave the rest of the mod
 * exactly as it was.
 */

import type { ArtifactMeta } from "./types.ts";

/**
 * Minecraft 1.20 / 1.20.1. The default when the pack's Minecraft version is
 * unknown or newer than the table below: it is the version this mode was built
 * and verified against, and `--pack-format` overrides it.
 */
export const DEFAULT_PACK_FORMAT = 15;

/**
 * Resource-pack format numbers per Minecraft release. Only versions whose
 * number is settled are listed; anything else is reported as a fallback rather
 * than guessed at, because a wrong number makes the launcher call the pack
 * incompatible.
 */
const PACK_FORMATS: Record<string, number> = {
  "1.18": 8,
  "1.18.1": 8,
  "1.18.2": 8,
  "1.19": 9,
  "1.19.1": 9,
  "1.19.2": 9,
  "1.19.3": 12,
  "1.19.4": 13,
  "1.20": 15,
  "1.20.1": 15,
  "1.20.2": 18,
  "1.20.3": 22,
  "1.20.4": 22,
  "1.20.5": 32,
  "1.20.6": 32,
  "1.21": 34,
  "1.21.1": 34,
  "1.21.2": 42,
  "1.21.3": 42,
  "1.21.4": 46,
};

export interface PackFormatChoice {
  packFormat: number;
  /** True when the number came from a known Minecraft version. */
  exact: boolean;
}

export function packFormatFor(minecraftVersion?: string): PackFormatChoice {
  const known = minecraftVersion ? PACK_FORMATS[minecraftVersion.trim()] : undefined;
  if (known !== undefined) return { packFormat: known, exact: true };
  return { packFormat: DEFAULT_PACK_FORMAT, exact: false };
}

/** `assets/<namespace>/lang/<locale>.json`. */
export function resourcePackLangPath(namespace: string, locale: string): string {
  return `assets/${namespace}/lang/${locale}.json`;
}

/**
 * The locale the file is *written as*, which is not always the locale it was
 * translated *into*: `--override-en-us` deliberately writes `en_us` so the
 * translation shows in an otherwise English game. Shared by the entry path, the
 * README and the raw sidecar so they cannot drift apart.
 */
export function outputLocale(meta: { targetLocale: string; overrideEnglish: boolean }): string {
  return meta.overrideEnglish ? "en_us" : meta.targetLocale;
}

/** The `pack.mcmeta` every resource pack needs, deterministic for equal input. */
export function buildPackMcmeta(meta: ArtifactMeta): string {
  const locale = outputLocale(meta);
  const language = meta.targetLanguage ?? meta.targetLocale;
  const mcmeta = {
    pack: {
      pack_format: meta.resourcePack?.packFormat ?? DEFAULT_PACK_FORMAT,
      description: `${meta.packName ?? "Modpack"} quest text\n${language} (${locale})`,
    },
  };
  return `${JSON.stringify(mcmeta, null, 2)}\n`;
}
