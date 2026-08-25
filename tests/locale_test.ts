import { assertEquals, assertThrows } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { resolveTargetLocale } from "../src/locale.ts";

Deno.test("minecraft locale codes pass through normalised", () => {
  assertEquals(resolveTargetLocale("ja_jp").locale, "ja_jp");
  assertEquals(resolveTargetLocale("ja-JP").locale, "ja_jp");
  assertEquals(resolveTargetLocale("JA_JP").locale, "ja_jp");
  assertEquals(resolveTargetLocale("  ja_jp  ").locale, "ja_jp");
});

Deno.test("bare language codes expand to the default region", () => {
  assertEquals(resolveTargetLocale("ja").locale, "ja_jp");
  assertEquals(resolveTargetLocale("de").locale, "de_de");
  assertEquals(resolveTargetLocale("ko").locale, "ko_kr");
});

Deno.test("human readable language names resolve", () => {
  const ja = resolveTargetLocale("Japanese");
  assertEquals(ja.locale, "ja_jp");
  assertEquals(ja.englishName, "Japanese");
  assertEquals(ja.nativeName, "日本語");
  assertEquals(resolveTargetLocale("japanese").locale, "ja_jp");
  assertEquals(resolveTargetLocale("日本語").locale, "ja_jp");
  assertEquals(resolveTargetLocale("Brazilian Portuguese").locale, "pt_br");
});

Deno.test("regional variants are distinguished", () => {
  assertEquals(resolveTargetLocale("zh_cn").locale, "zh_cn");
  assertEquals(resolveTargetLocale("zh_tw").locale, "zh_tw");
  assertEquals(resolveTargetLocale("en_gb").locale, "en_gb");
});

Deno.test("unknown locales are rejected with suggestions", () => {
  const err = assertThrows(
    () => resolveTargetLocale("Japanish"),
    AppError,
  ) as AppError;
  assertEquals(err.code, "E_INVALID_INPUT");
  assertEquals(typeof err.hint, "string");
  assertEquals(err.hint!.includes("ja_jp"), true);
});

Deno.test("structurally valid but unknown minecraft locales are accepted verbatim", () => {
  // Minecraft ships locales this tool has no display name for; refusing them
  // would be worse than passing them through.
  const r = resolveTargetLocale("enp_us");
  assertEquals(r.locale, "enp_us");
  assertEquals(r.englishName, "enp_us");
  assertEquals(r.known, false);
});

Deno.test("empty and malformed input is rejected", () => {
  assertThrows(() => resolveTargetLocale(""), AppError);
  assertThrows(() => resolveTargetLocale("   "), AppError);
  assertThrows(() => resolveTargetLocale("ja_jp/../../etc"), AppError);
  assertThrows(() => resolveTargetLocale("ja jp jp jp"), AppError);
});

Deno.test("resolution is describable for the pre-flight banner", () => {
  assertEquals(resolveTargetLocale("Japanese").describe(), "Japanese (日本語) → ja_jp");
  assertEquals(resolveTargetLocale("enp_us").describe(), "enp_us");
});
