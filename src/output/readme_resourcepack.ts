import type { ArtifactMeta, Limitations } from "./types.ts";
import { outputLocale } from "./resourcepack.ts";

/** How many limitation entries the README lists before deferring to the report. */
const LIST_LIMIT = 20;

function listed<T>(items: readonly T[], render: (item: T) => string): string[] {
  const shown = items.slice(0, LIST_LIMIT).map(render);
  if (items.length > LIST_LIMIT) shown.push(`... and ${items.length - LIST_LIMIT} more`);
  return shown;
}

function missingSection(limits: Limitations | undefined, language: "en" | "ja"): string[] {
  const missing = limits?.missingKeys ?? [];
  if (missing.length === 0) return [];
  const body = ["", "```text", ...listed(missing, (key) => key), "```", ""];
  return language === "en"
    ? [
      `- **${missing.length} referenced key(s) have no English string** in the source language`,
      "  file, so they are absent from this pack and the game will keep showing the raw key.",
      "  Nothing was invented for them:",
      ...body,
    ]
    : [
      `- **${missing.length} 件のキー**はソース言語ファイルに英語テキストが無いため、`,
      "  このパックには含まれていません。ゲーム側ではキー名がそのまま表示されます。",
      "  推測による翻訳は一切行っていません。",
      ...body,
    ];
}

function literalSection(limits: Limitations | undefined, language: "en" | "ja"): string[] {
  const literals = limits?.literalLabels ?? [];
  if (literals.length === 0) return [];
  const body = [
    "",
    "```text",
    ...listed(literals, (l) => `${l.field}: ${JSON.stringify(l.text)}  (${l.file})`),
    "```",
    "",
  ];
  return language === "en"
    ? [
      `- **${literals.length} visible label(s) are hard-coded** in the quest files rather than`,
      "  written as a translation key. A resource pack cannot reach them, so they stay in",
      "  English. Translating them would mean editing the modpack, which this tool never does:",
      ...body,
    ]
    : [
      `- **${literals.length} 件のラベル**はクエストファイルに直接書かれており、翻訳キーが`,
      "  存在しません。リソースパックからは変更できないため英語のままになります。",
      "  変更するにはモッドパック本体の編集が必要で、このツールは決してそれを行いません。",
      ...body,
    ];
}

function unreadableSection(limits: Limitations | undefined, language: "en" | "ja"): string[] {
  const unreadable = limits?.unreadableQuestFiles ?? [];
  if (unreadable.length === 0) return [];
  return language === "en"
    ? [
      `- **${unreadable.length} quest file(s) could not be parsed**, so any key they reference`,
      "  was not collected. They are listed in `translation-report.json`.",
    ]
    : [
      `- **${unreadable.length} 件のクエストファイルを解析できませんでした。**`,
      "  そこで参照されているキーは収集されていません。詳細は `translation-report.json` を参照してください。",
    ];
}

/**
 * The bilingual README that ships inside a resource pack.
 *
 * Deliberately different from the overlay README: the install action is
 * "Options -> Resource Packs", not "extract into the instance root", and the
 * multiplayer story is the opposite one -- a resource pack is client-side, so
 * nothing here can change what another player sees.
 */
export function buildResourcePackReadme(meta: ArtifactMeta): string {
  const locale = outputLocale(meta);
  const language = meta.targetLanguage ?? meta.targetLocale;
  const namespace = meta.resourcePack?.namespace ?? "unknown";
  const langPath = meta.resourcePack?.langPath ?? `assets/${namespace}/lang/${locale}.json`;
  const packFormat = meta.resourcePack?.packFormat;
  const exact = meta.resourcePack?.packFormatExact ?? false;
  const counts = meta.keyCounts;

  const en: string[] = [
    "## English",
    "",
    `This archive is a **Minecraft resource pack** that translates the quest text of **${
      meta.packName ?? "this modpack"
    }**${meta.packVersion ? ` version **${meta.packVersion}**` : ""} into **${language}**.`,
    "",
    "It contains only the translated language file. It contains no mods, no mod jar, no",
    "modpack files, no English source file and no credentials, and neither the modpack",
    "download nor the mod it reads from was modified.",
    "",
    "### Why a resource pack, and not a quest overlay",
    "",
    "This pack's quest files hold **translation keys** such as `{quest.guide.fiber.title}`",
    `rather than prose; the English strings live in a mod, under \`${meta.sourcePath}\`.`,
    "Minecraft merges resource-pack language files over a mod's own, key by key, so a",
    "resource pack is the supported way to replace exactly those strings and nothing else.",
    `Only the **${counts?.strings ?? 0} key(s) the quest files actually reference** are in here:`,
    "the rest of the mod -- item names, GUI labels -- is untouched.",
    "",
    "### How to install",
    "",
    "1. Copy this `.zip` **as it is** (do not unzip it) into your instance's",
    "   `resourcepacks/` folder:",
    "   - MultiMC / Prism: instance folder -> `.minecraft/resourcepacks/`",
    "   - CurseForge / vanilla launcher: `.minecraft/resourcepacks/`",
    "2. Start the game, open **Options -> Resource Packs**, and move this pack to the",
    "   right-hand side so it is enabled.",
    "3. Put it **above** other packs in the list if anything else also changes quest text.",
    meta.overrideEnglish
      ? "4. The translation is applied whatever your game language is set to (see below)."
      : `4. Set your game language to **${language}** (\`${meta.targetLocale}\`); the` +
        " translation applies when that language is active.",
    "",
    "```text",
    langPath,
    "```",
    "",
    "To remove it, disable it in the same screen or delete the `.zip`. Nothing else in",
    "your instance was changed, so there is nothing else to undo.",
    "",
    "### What locale this replaces",
    "",
  ];

  if (meta.overrideEnglish) {
    en.push(
      "This pack was built with `--override-en-us`, so it writes **`en_us.json`** rather than",
      `\`${meta.targetLocale}.json\`. That is a deliberate choice with two consequences:`,
      "",
      `- You keep an **English game** -- every mod, item and menu stays in English -- while`,
      "  the quest text is translated. Only the quest keys are overridden; every other string",
      "  in this namespace is left to the mod.",
      "- `en_us` is Minecraft's **fallback** locale: any language that has no entry of its own",
      "  for these keys falls back to it. So the translated quest text will also appear if you",
      "  later switch the game to another language that this mod does not translate.",
      "",
      "This is safe to do here in a way it is not for a server-side quest overlay: a resource",
      "pack is **only the client that enables it**. No other player, and no server, is affected.",
    );
  } else {
    en.push(
      `This pack writes \`${meta.targetLocale}.json\`, so it applies only when the game`,
      `language is **${language}**. Any other language is unaffected.`,
      "",
      "A resource pack is client-side: it affects **only the client that enables it**. No",
      "other player, and no server, sees anything different because of this file.",
    );
  }

  en.push(
    "",
    "### Known limitations",
    "",
    "Both of the following are structural, not oversights, and nothing was guessed at:",
    "",
    ...missingSection(meta.limitations, "en"),
    ...literalSection(meta.limitations, "en"),
    ...unreadableSection(meta.limitations, "en"),
    "",
    "The full lists are in `translation-report.json`.",
    "",
    "### Compatibility",
    "",
    exact
      ? `Built for Minecraft **${meta.minecraftVersion}** (\`pack_format\` ${packFormat}).`
      : `The pack format **could not be derived** from this pack's Minecraft version` +
        `${meta.minecraftVersion ? ` (\`${meta.minecraftVersion}\`)` : ""}, so \`pack_format\` ` +
        `${packFormat} was used. If the launcher calls this pack incompatible, rebuild with ` +
        "`--pack-format <n>` for your version. It will still load if you enable it anyway.",
    "",
    "### Provenance",
    "",
    "```text",
    `source        ${meta.sourceUrl}`,
    `pack          ${meta.packName ?? "(unknown)"} ${meta.packVersion ?? ""}`.trimEnd(),
    `minecraft     ${meta.minecraftVersion ?? "(unknown)"}`,
    `loader        ${meta.loader ?? "(unknown)"}`,
    `namespace     ${namespace}`,
    `strings from  ${meta.sourceLangJar?.file ?? "(unknown)"} ! ${meta.sourcePath}`,
    `lang jar      sha256 ${meta.sourceLangJar?.sha256 ?? "(unknown)"}`,
    `source sha256 ${meta.sourceArchiveSha256}`,
    `mode          ${meta.overrideEnglish ? "en_us override" : `target locale ${locale}`}`,
    `provider      ${meta.provider} (${meta.model})`,
    `generated     ${meta.generatedAt}`,
    `tool          modpack-quest-translator ${meta.toolVersion}`,
    "```",
    "",
    "See `translation-manifest.json` and `translation-report.json` for full detail.",
  );

  const ja: string[] = [
    "## 日本語",
    "",
    `このアーカイブは **${meta.packName ?? "このモッドパック"}**` +
    `${meta.packVersion ? `（バージョン **${meta.packVersion}**）` : ""}` +
    `のクエストテキストを **${language}** に翻訳する`,
    "**Minecraft リソースパック**です。",
    "",
    "含まれるのは翻訳済みの言語ファイルのみです。MOD 本体・MOD の JAR・モッドパックのファイル・",
    "英語の原文ファイル・認証情報は一切含まれていません。モッドパックのダウンロードにも、",
    "参照した MOD にも変更は加えていません。",
    "",
    "### なぜオーバーレイではなくリソースパックなのか",
    "",
    "このパックのクエストファイルには本文ではなく `{quest.guide.fiber.title}` のような",
    `**翻訳キー**が書かれており、英語テキストは MOD 側の \`${meta.sourcePath}\` にあります。`,
    "Minecraft はリソースパックの言語ファイルを MOD 側の言語ファイルにキー単位で上書きするため、",
    "該当する文字列だけを差し替える正規の方法がリソースパックです。",
    `収録しているのは**クエストが実際に参照している ${counts?.strings ?? 0} 件のキー**のみで、`,
    "アイテム名や GUI ラベルなど MOD の他の文字列には手を触れていません。",
    "",
    "### 導入方法",
    "",
    "1. この `.zip` を**解凍せずそのまま**インスタンスの `resourcepacks/` フォルダに入れます。",
    "   - MultiMC / Prism: インスタンスフォルダ内の `.minecraft/resourcepacks/`",
    "   - CurseForge / 公式ランチャー: `.minecraft/resourcepacks/`",
    "2. ゲームを起動し、**設定 → リソースパック**を開いて、このパックを右側（有効）へ移動します。",
    "3. クエストテキストを変更する他のパックがある場合は、このパックを**上位**に置いてください。",
    meta.overrideEnglish
      ? "4. ゲームの言語設定に関わらず翻訳が適用されます（詳細は下記）。"
      : `4. ゲームの言語を **${language}**（\`${meta.targetLocale}\`）に設定してください。` +
        "その言語のときに翻訳が適用されます。",
    "",
    "```text",
    langPath,
    "```",
    "",
    "削除するときは同じ画面で無効にするか、`.zip` を削除してください。",
    "インスタンスの他の部分は一切変更していないため、他に戻す作業はありません。",
    "",
    "### どのロケールを置き換えるか",
    "",
  ];

  if (meta.overrideEnglish) {
    ja.push(
      "このパックは `--override-en-us` で生成されているため、`" + meta.targetLocale +
        ".json` ではなく",
      "**`en_us.json`** を書き出します。これは意図的な選択で、次の 2 点の意味があります。",
      "",
      "- **ゲーム本体は英語のまま**（MOD・アイテム名・メニューはすべて英語）で、クエスト文章だけが",
      "  翻訳されます。上書きするのはクエストのキーのみで、この名前空間の他の文字列は MOD 側のままです。",
      "- `en_us` は Minecraft の**フォールバック**ロケールです。該当キーを持たない言語は en_us に",
      "  フォールバックするため、後で MOD が未翻訳の別言語に切り替えても、この翻訳が表示されます。",
      "",
      "サーバー側のクエストオーバーレイと違い、これは安全です。リソースパックは",
      "**有効にしたクライアントにのみ**適用されます（only the client that enables it）。",
      "他のプレイヤーにもサーバーにも影響しません。",
    );
  } else {
    ja.push(
      `このパックは \`${meta.targetLocale}.json\` を書き出すため、ゲームの言語が`,
      `**${language}** のときにのみ適用されます。他の言語には影響しません。`,
      "",
      "リソースパックはクライアント側の仕組みで、**有効にしたクライアントにのみ**",
      "適用されます（only the client that enables it）。他のプレイヤーやサーバーには影響しません。",
    );
  }

  ja.push(
    "",
    "### 既知の制限",
    "",
    "以下はいずれも構造上の制限であり、推測による翻訳は行っていません。",
    "",
    ...missingSection(meta.limitations, "ja"),
    ...literalSection(meta.limitations, "ja"),
    ...unreadableSection(meta.limitations, "ja"),
    "",
    "完全な一覧は `translation-report.json` にあります。",
    "",
    "### 対応バージョン",
    "",
    exact
      ? `Minecraft **${meta.minecraftVersion}** 向け（\`pack_format\` ${packFormat}）です。`
      : "このパックの Minecraft バージョンから `pack_format` を**確定できなかった**ため、" +
        `${packFormat} を使用しています。ランチャーが非対応と表示する場合は ` +
        "`--pack-format <n>` を指定して再生成してください。そのまま有効にしても読み込まれます。",
    "",
    "### 生成情報",
    "",
    "詳細は `translation-manifest.json` と `translation-report.json` を参照してください。",
  );

  return [
    `# ${meta.packName ?? "Modpack"} — quest translation resource pack (${locale})`,
    "",
    `Generated by modpack-quest-translator ${meta.toolVersion} on ${meta.generatedAt}.`,
    "",
    ...en,
    "",
    "---",
    "",
    ...ja,
    "",
  ].join("\n");
}
