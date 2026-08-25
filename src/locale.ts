import { AppError } from "./errors.ts";

export interface ResolvedLocale {
  /** Minecraft locale code, e.g. `ja_jp`. */
  readonly locale: string;
  /** English display name, or the raw locale when unknown. */
  readonly englishName: string;
  /** Endonym, when known. */
  readonly nativeName?: string;
  /** False when the code is structurally valid but not in the built-in table. */
  readonly known: boolean;
  /** One-line description printed before work begins. */
  describe(): string;
}

interface LocaleEntry {
  locale: string;
  english: string;
  native: string;
  /** Additional accepted spellings (lowercased). */
  aliases?: string[];
}

/**
 * Minecraft locales this tool can name. Not exhaustive by design: any
 * structurally valid `xx_yy` code is accepted even when it is absent here.
 */
const LOCALES: readonly LocaleEntry[] = [
  { locale: "en_us", english: "English", native: "English", aliases: ["english (us)"] },
  { locale: "en_gb", english: "British English", native: "British English" },
  { locale: "ja_jp", english: "Japanese", native: "日本語", aliases: ["jp", "nihongo"] },
  { locale: "ko_kr", english: "Korean", native: "한국어" },
  { locale: "zh_cn", english: "Simplified Chinese", native: "简体中文", aliases: ["chinese"] },
  { locale: "zh_tw", english: "Traditional Chinese", native: "繁體中文" },
  { locale: "de_de", english: "German", native: "Deutsch" },
  { locale: "fr_fr", english: "French", native: "Français" },
  { locale: "es_es", english: "Spanish", native: "Español" },
  { locale: "es_mx", english: "Mexican Spanish", native: "Español de México" },
  { locale: "pt_br", english: "Brazilian Portuguese", native: "Português do Brasil" },
  { locale: "pt_pt", english: "Portuguese", native: "Português" },
  { locale: "it_it", english: "Italian", native: "Italiano" },
  { locale: "ru_ru", english: "Russian", native: "Русский" },
  { locale: "pl_pl", english: "Polish", native: "Polski" },
  { locale: "nl_nl", english: "Dutch", native: "Nederlands" },
  { locale: "tr_tr", english: "Turkish", native: "Türkçe" },
  { locale: "uk_ua", english: "Ukrainian", native: "Українська" },
  { locale: "cs_cz", english: "Czech", native: "Čeština" },
  { locale: "sv_se", english: "Swedish", native: "Svenska" },
  { locale: "th_th", english: "Thai", native: "ไทย" },
  { locale: "vi_vn", english: "Vietnamese", native: "Tiếng Việt" },
  { locale: "id_id", english: "Indonesian", native: "Bahasa Indonesia" },
];

/** Bare language code -> the locale Minecraft actually ships for it. */
const DEFAULT_REGION: Readonly<Record<string, string>> = {
  en: "en_us",
  ja: "ja_jp",
  ko: "ko_kr",
  zh: "zh_cn",
  de: "de_de",
  fr: "fr_fr",
  es: "es_es",
  pt: "pt_br",
  it: "it_it",
  ru: "ru_ru",
  pl: "pl_pl",
  nl: "nl_nl",
  tr: "tr_tr",
  uk: "uk_ua",
  cs: "cs_cz",
  sv: "sv_se",
  th: "th_th",
  vi: "vi_vn",
  id: "id_id",
};

const LOCALE_SHAPE = /^[a-z]{2,3}_[a-z0-9]{2,8}$/;

function make(entry: LocaleEntry): ResolvedLocale {
  return {
    locale: entry.locale,
    englishName: entry.english,
    nativeName: entry.native,
    known: true,
    describe: () => `${entry.english} (${entry.native}) → ${entry.locale}`,
  };
}

function makeUnknown(locale: string): ResolvedLocale {
  return {
    locale,
    englishName: locale,
    known: false,
    describe: () => locale,
  };
}

function suggestionHint(): string {
  const examples = ["ja_jp", "ko_kr", "zh_cn", "de_de", "fr_fr", "pt_br"];
  return `Use a Minecraft locale such as ${examples.join(", ")}, ` +
    `or a language name such as Japanese, Korean, German.`;
}

/**
 * Resolve `--target` from either a Minecraft locale (`ja_jp`, `ja-JP`, `ja`)
 * or a human-readable language name (`Japanese`, `日本語`).
 */
export function resolveTargetLocale(input: string): ResolvedLocale {
  const raw = input.trim();
  if (raw.length === 0) {
    throw new AppError("E_INVALID_INPUT", "--target is empty", { hint: suggestionHint() });
  }

  const normalised = raw.toLowerCase().replace(/-/g, "_");

  // 1. Exact locale code.
  const byCode = LOCALES.find((l) => l.locale === normalised);
  if (byCode) return make(byCode);

  // 2. Bare language code.
  const expanded = DEFAULT_REGION[normalised];
  if (expanded) {
    const entry = LOCALES.find((l) => l.locale === expanded)!;
    return make(entry);
  }

  // 3. Display name, endonym or alias. Compared on the original string too,
  //    because endonyms are not affected by lowercasing.
  const nameKey = raw.toLowerCase();
  const byName = LOCALES.find((l) =>
    l.english.toLowerCase() === nameKey ||
    l.native.toLowerCase() === nameKey ||
    l.native === raw ||
    (l.aliases ?? []).includes(nameKey)
  );
  if (byName) return make(byName);

  // 4. Unknown but structurally valid Minecraft locale.
  if (LOCALE_SHAPE.test(normalised)) return makeUnknown(normalised);

  throw new AppError("E_INVALID_INPUT", `Unrecognised --target language or locale: ${raw}`, {
    hint: suggestionHint(),
  });
}

/** Locales for which replacing `en_us.snbt` is the natural install mode. */
export function isEnglishLocale(locale: string): boolean {
  return locale.startsWith("en_");
}
