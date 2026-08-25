import type { OverlayLayout, OverlayMeta } from "./types.ts";

/** Where the translated file lands, per layout. */
function entryPaths(meta: OverlayMeta, layout: OverlayLayout): string[] {
  const name = `${meta.overrideEnglish ? "en_us" : meta.targetLocale}.snbt`;
  const inner = `config/ftbquests/quests/lang/${name}`;
  if (layout === "overrides") return [`overrides/${inner}`];
  if (layout === "both") return [inner, `overrides/${inner}`];
  return [inner];
}

/**
 * Generates the bilingual install/update README that ships inside the archive.
 * It states exactly which install action applies, and spells out the
 * multiplayer consequences the requirements enumerate.
 */
export function buildReadme(meta: OverlayMeta, layout: OverlayLayout): string {
  const paths = entryPaths(meta, layout);
  const primary = paths[0];
  const mode = meta.overrideEnglish ? "en_us override" : `target locale ${meta.targetLocale}`;
  const language = meta.targetLanguage ?? meta.targetLocale;

  const en: string[] = [
    "## English",
    "",
    `This archive is a **quest-text translation overlay** for **${
      meta.packName ?? "this modpack"
    }**` +
    `${meta.packVersion ? ` version **${meta.packVersion}**` : ""}.`,
    "It contains only the translated FTB Quests localization file. It contains no mods,",
    "no pack assets and no credentials, and the original pack download was not modified.",
    "",
    "### What it does",
    "",
    `- Translates quest titles, subtitles and descriptions into **${language}**.`,
    meta.overrideEnglish
      ? "- Installs as `en_us.snbt`, so Minecraft and every mod stay in English and **only " +
        "the quest text changes**."
      : `- Installs as \`${meta.targetLocale}.snbt\`, so it applies when the game locale is ` +
        `set to ${meta.targetLocale}.`,
    "- Does not touch quest topology, tasks, rewards, recipes or progression.",
    "",
    "### How to install",
    "",
  ];

  if (layout === "overrides") {
    en.push(
      "This archive uses the `overrides/` wrapper, which is the layout a modpack",
      "**launcher import** expects. Merge it into your pack's own `overrides/` tree, or",
      "extract just the inner path into your instance:",
    );
  } else if (layout === "both") {
    en.push(
      "This archive ships both layouts. Use whichever matches your workflow:",
      "",
      `- Extract into the **instance root** to use \`${paths[0]}\`.`,
      `- Merge into a pack's own \`overrides/\` tree to use \`${paths[1]}\`.`,
      "",
      "Extracting everything into the instance root is harmless: the extra `overrides/`",
      "directory is ignored by the game.",
    );
  } else {
    en.push(
      "**Extract this archive into your Minecraft instance root** -- the directory that",
      "already contains `mods/`, `config/` and `saves/`. The file lands at:",
    );
  }

  en.push(
    "",
    "```text",
    ...paths,
    "```",
    "",
    "Then start the game (or restart it if it is already running). FTB Quests reads the",
    "file at load time.",
    "",
    "### Updating and removing",
    "",
    "- To update, extract a newer overlay over the old one; the single file is replaced.",
    `- To remove, delete \`${primary}\`.`,
    meta.overrideEnglish
      ? "  FTB Quests then falls back to the pack's own English text."
      : "  The game then falls back to the pack's own `en_us` text.",
    "",
    "### Single-player, servers and multiplayer",
    "",
    "- **Single player:** installing into an instance affects only that instance.",
    "- **Server:** FTB Quests serves quest data from the server, so a server-side install",
    "  affects every player connected to it.",
  );

  if (meta.overrideEnglish) {
    en.push(
      `- **Important:** because this overlay replaces \`en_us.snbt\`, installing it on a`,
      "  server changes the quest text for **every player** whose game locale resolves to",
      "  `en_us` -- not just for you. On a shared server, prefer a per-player opt-in: ask",
      "  the operator to ship the translated file as `en_gb.snbt` instead, and set your own",
      "  client to British English. You keep an English game with translated quests, and",
      "  everyone else is unaffected.",
    );
  } else {
    en.push(
      `- Players whose game locale is not \`${meta.targetLocale}\` are unaffected by this file.`,
    );
  }

  en.push(
    "",
    "### Verify before trusting this on a live world",
    "",
    "The install advice above is based on the pack layout detected during generation",
    `(\`${meta.archiveFlavour}\` archive, source file \`${meta.sourcePath}\`).`,
    meta.questModVersion
      ? `The pack ships **FTB Quests ${meta.questModVersion}**` +
        `${meta.questModFile ? ` (\`${meta.questModFile}\`)` : ""}, which is the version the` +
        " server/client notes above were written against."
      : "The FTB Quests version **could not be detected** from this pack's file list, so the" +
        " server/client notes above are the general behaviour of modern FTB Quests rather than" +
        " a checked fact for your exact build. Confirm them against the version your pack ships.",
    "Back up your world first. Quest **progress** is stored separately from quest text and is",
    "not affected by this overlay, but a backup costs nothing.",
    "",
    "### Provenance",
    "",
    "```text",
    `source        ${meta.sourceUrl}`,
    `pack          ${meta.packName ?? "(unknown)"} ${meta.packVersion ?? ""}`.trimEnd(),
    `minecraft     ${meta.minecraftVersion ?? "(unknown)"}`,
    `loader        ${meta.loader ?? "(unknown)"}`,
    `source file   ${meta.sourcePath}`,
    `ftb quests    ${meta.questModVersion ?? "(not detected)"}`,
    `source sha256 ${meta.sourceArchiveSha256}`,
    `mode          ${mode}`,
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
    "向けの**クエストテキスト翻訳オーバーレイ**です。",
    "含まれるのは翻訳済みの FTB Quests 言語ファイルのみで、MOD 本体・パックの素材・",
    "認証情報は一切含まれていません。ダウンロード元のパックは変更していません。",
    "",
    "### 何をするもの?",
    "",
    `- クエストのタイトル・サブタイトル・説明文を **${language}** に翻訳します。`,
    meta.overrideEnglish
      ? "- `en_us.snbt` として導入されるため、**ゲーム本体と各 MOD の表示は英語のまま**、" +
        "クエスト文章だけが翻訳されます。"
      : `- \`${meta.targetLocale}.snbt\` として導入されるため、ゲームの言語設定が ` +
        `${meta.targetLocale} のときに適用されます。`,
    "- クエストの構成・タスク・報酬・レシピ・進行内容には一切手を加えません。",
    "",
    "### 導入方法",
    "",
  ];

  if (layout === "overrides") {
    ja.push(
      "このアーカイブはランチャーのインポートが想定する `overrides/` 形式です。",
      "パック側の `overrides/` にマージするか、内側のパスだけをインスタンスへ展開してください。",
    );
  } else if (layout === "both") {
    ja.push(
      "両方の配置を同梱しています。用途に合う方をお使いください。",
      "",
      `- **インスタンス直下**に展開する場合は \`${paths[0]}\` が使われます。`,
      `- パックの \`overrides/\` にマージする場合は \`${paths[1]}\` が使われます。`,
      "",
      "すべてインスタンス直下に展開しても問題ありません。余分な `overrides/` はゲームから無視されます。",
    );
  } else {
    ja.push(
      "**Minecraft のインスタンス直下**（`mods/`・`config/`・`saves/` がある階層）に",
      "このアーカイブを展開してください。次の場所にファイルが配置されます。",
    );
  }

  ja.push(
    "",
    "```text",
    ...paths,
    "```",
    "",
    "その後ゲームを起動（起動中なら再起動）してください。FTB Quests は読み込み時に",
    "このファイルを参照します。",
    "",
    "### 更新・削除",
    "",
    "- 更新するときは、新しいオーバーレイを上書き展開してください。ファイルが置き換わります。",
    `- 削除するときは \`${primary}\` を消してください。`,
    meta.overrideEnglish
      ? "  パック本来の英語テキストに戻ります。"
      : "  パック本来の `en_us` テキストに戻ります。",
    "",
    "### シングルプレイ・サーバー・マルチプレイ",
    "",
    "- **シングルプレイ:** 導入したインスタンスにのみ影響します。",
    "- **サーバー:** FTB Quests のクエストデータはサーバーから配信されるため、",
    "  サーバーに導入すると接続している**全プレイヤー**に影響します。",
  );

  if (meta.overrideEnglish) {
    ja.push(
      "- **重要:** このオーバーレイは `en_us.snbt` を置き換えるため、サーバーに導入すると",
      "  ゲーム言語が `en_us` になっている**全プレイヤー**のクエスト文章が変わります。",
      "  共用サーバーでは、翻訳ファイルを `en_gb.snbt` として配置してもらい、自分のクライアント",
      "  だけ British English に設定する方法をおすすめします。英語環境のまま自分だけ翻訳された",
      "  クエストを読め、他のプレイヤーには影響しません。",
    );
  } else {
    ja.push(
      `- ゲーム言語が \`${meta.targetLocale}\` 以外のプレイヤーには影響しません。`,
    );
  }

  ja.push(
    "",
    "### 本番ワールドに入れる前に",
    "",
    `上記の手順は生成時に検出したパック構成（\`${meta.archiveFlavour}\` 形式、`,
    `元ファイル \`${meta.sourcePath}\`）に基づいています。`,
    meta.questModVersion
      ? `このパックが同梱している FTB Quests は **${meta.questModVersion}**` +
        `${meta.questModFile ? `（\`${meta.questModFile}\`）` : ""} で、` +
        "上記のサーバー/クライアントに関する記述はこのバージョンを前提にしています。"
      : "このパックのファイル一覧からは FTB Quests のバージョンを**検出できません**でした。" +
        "上記のサーバー/クライアントに関する記述は最近の FTB Quests の一般的な挙動であり、" +
        "お使いのビルドで確認した結果ではありません。実際のバージョンでご確認ください。",
    "事前にワールドのバックアップを取ってください。クエストの**進行状況**はテキストとは別に",
    "保存されるため、このオーバーレイでは失われませんが、バックアップは取っておいて損はありません。",
    "",
    "### 生成情報",
    "",
    "詳細は `translation-manifest.json` と `translation-report.json` を参照してください。",
  );

  return [
    `# ${meta.packName ?? "Modpack"} — quest translation overlay (${meta.targetLocale})`,
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
