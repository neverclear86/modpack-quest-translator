# modpack-quest-translator

Translate a Minecraft modpack's **FTB Quests** text into another language and emit a
ready-to-install archive. The downloaded pack is never modified, and nothing from it is extracted to
disk or executed.

The headline use case: read quests in Japanese while Minecraft, JEI, Create and every other mod stay
in English.

```bash
modpack-quest-translator \
  --url "https://www.curseforge.com/minecraft/modpacks/all-of-create-aeronautics" \
  --target ja_jp \
  --override-en-us \
  --output ./aca-ja.zip
```

## What it does and does not do

It translates quest **titles, subtitles and descriptions**, and emits a small ZIP containing the one
translated file plus a bilingual README, a metadata manifest and a machine-readable report.

Packs store that text in one of two ways, and the tool has a mode for each — see
[Two source formats, two outputs](#two-source-formats-two-outputs):

| The pack's quest text lives in                                   | You get                                           |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| `config/ftbquests/quests/lang/<locale>.snbt`                     | a **quest overlay** you extract into the instance |
| `{translation.key}` placeholders backed by a mod's `lang/*.json` | a **Minecraft resource pack** you enable in-game  |

An overlay can be packaged further into a double-clickable **installer bundle** for Windows and
Linux, which saves the pack's own quest file before replacing it and can put it back byte for byte —
see [Installing the overlay](#installing-the-overlay).

It does **not** translate mod item/block/UI language files or Create Ponder scenes, does not edit
quest topology, tasks, rewards or progression, and never repacks or redistributes the modpack or any
mod. No mod JARs, pack assets, source English files or credentials are ever placed in the output.

## Requirements

- The latest [Deno](https://deno.com/) 2 — only to build or run from source; developed and verified
  on `2.9.5`. Deno 2 is the only supported runtime: Deno 1 is not supported, not tested, and the
  compatibility shim it needed is gone. The compiled binaries have no runtime dependencies, and a
  player installing an installer bundle needs no runtime at all.
- [Claude Code](https://claude.com/claude-code), already installed and logged in, for the default
  translation provider. The tool drives the `claude` CLI as a subprocess; it never calls Anthropic
  HTTP APIs directly and never runs `claude update`.
- No API keys are needed for Modrinth. CurseForge needs one — see
  [CurseForge access](#curseforge-access).

## Installing the translator itself

This section is about the command-line translator. If you were handed a finished installer bundle,
you do not need any of it — go to [Installing the overlay](#installing-the-overlay).

### Build a standalone binary (recommended)

```bash
git clone <this-repo> modpack-quest-translator
cd modpack-quest-translator
deno task build          # -> dist/modpack-quest-translator
./dist/modpack-quest-translator --help
```

Put it on your PATH:

```bash
install -m755 dist/modpack-quest-translator ~/.local/bin/
```

`deno compile` also cross-compiles, so you can produce Windows and macOS binaries from Linux:

```bash
deno compile -A --target x86_64-pc-windows-msvc  -o dist/mqt-windows.exe   src/cli/main.ts
deno compile -A --target x86_64-apple-darwin     -o dist/mqt-macos-intel   src/cli/main.ts
deno compile -A --target aarch64-apple-darwin    -o dist/mqt-macos-arm     src/cli/main.ts
```

### Run from source

```bash
deno run -A src/cli/main.ts --help
```

### Required permissions

The compiled binary is built with `-A`. Running from source needs `--allow-net` (pack registries and
CDNs), `--allow-read`/`--allow-write` (cache and output), `--allow-env` (cache directory and the
optional CurseForge key) and `--allow-run=claude` (the translation provider).

## Usage

```text
modpack-quest-translator --url <modpack-url> --target <language> --output <path> [options]
modpack-quest-translator --archive <file.zip|.mrpack> --target <language> --output <path>
modpack-quest-translator --archive <pack.zip> --lang-jar <mod.jar> -t <lang> -o <path>
```

### The four core inputs

| Flag               | Meaning                                                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `-u, --url`        | CurseForge or Modrinth modpack project URL, a file/version URL pinning an exact release, or a direct `.zip`/`.mrpack` URL |
| `-t, --target`     | `ja_jp`, `ja-JP`, `ja`, `Japanese` or `日本語` — all resolve to the same locale, which is printed before work begins      |
| `--override-en-us` | Emit the translation as `en_us` instead of `<locale>` (`--override-english <true\|false>` is the same switch spelled out) |
| `-o, --output`     | An explicit `.zip` path, or a directory                                                                                   |

`--url` and `--archive` are mutually exclusive; exactly one is required. Adding `--lang-jar`
switches the output to a resource pack — see
[Two source formats, two outputs](#two-source-formats-two-outputs).

### `--output` semantics

Deterministic, and never destructive:

- Ends in `.zip` → that exact file is the archive. Sidecars are written beside it as
  `<base>.manifest.json`, `<base>.report.json`, `<base>.README.md`, and
  `<base>.<locale>.<snbt|json>` with `--emit-raw` — the extension follows the artefact.
- Anything else → treated as a directory, created if needed. The archive is named
  `<pack-slug>-<pack-version>-<locale>[-en_us-override][-resourcepack].zip`, so the exact compatible
  pack version is part of the filename and a newer pack release produces a new file.
- An existing output file is **never** silently overwritten. That is exit code 8 unless `--force`,
  and it covers **every** file the run would write — the archive, all three sidecars, and the raw
  payload when `--emit-raw` asks for it. All of them are checked before anything is translated, and
  every collision is reported at once.
- Publication also uses an atomic create-if-absent operation, so a file created after that early
  check is not overwritten. If a later sidecar loses such a race, outputs already published by this
  run are conservatively left in place and named in the error. They are not deleted: a pathname can
  be replaced immediately before unlink, and deleting a partial output is not worth risking somebody
  else's file. The next run reports those leftovers during its early collision check.

### Override mode, and which one you want

| Mode               | Archive entry                             | Effect                                                            |
| ------------------ | ----------------------------------------- | ----------------------------------------------------------------- |
| default            | `config/ftbquests/quests/lang/ja_jp.snbt` | Applies when the game locale is `ja_jp`                           |
| `--override-en-us` | `config/ftbquests/quests/lang/en_us.snbt` | Applies while the game stays in English — only quest text changes |

Use `--override-en-us` for single player when you want an English game with Japanese quests.

On a **shared server** it is a blunt instrument: FTB Quests serves quest data from the server, so
replacing `en_us.snbt` there changes the quest text for **every player** whose locale resolves to
`en_us`. The per-player alternative is to ship the translated file as `en_gb.snbt` and set only your
own client to British English:

```bash
# --emit-raw writes the translated .snbt loose, beside the archive
modpack-quest-translator -u <url> -t ja_jp -o ./opt-in/overlay.zip --emit-raw
cp ./opt-in/overlay.ja_jp.snbt <server>/config/ftbquests/quests/lang/en_gb.snbt
```

Players who want the translation then set their client language to British English; everyone else is
unaffected.

Every generated archive's README spells this out in English and Japanese.

## Two source formats, two outputs

### The default: an FTB Quests SNBT overlay

Most modern packs export their quest text to `config/ftbquests/quests/lang/<locale>.snbt`. Nothing
extra is needed: point the tool at the pack and it emits an overlay archive whose single entry is
`config/ftbquests/quests/lang/<target>.snbt`. This is the mode every other section here describes,
and it is unchanged.

### `--lang-jar`: translation keys backed by a mod, emitted as a resource pack

Some packs keep no quest prose in their quest files at all. Every visible string is a **translation
key** and the English text lives in a mod:

```snbt
title: "{quest.guide.survival.fiber.title}"
subtitle: "{quest.guide.survival.fiber.subtitle}"
description: ["{quest.guide.survival.fiber.description_1}"]
```

```json
// inside SomeMod.jar, at assets/<namespace>/lang/en_us.json
{ "quest.guide.survival.fiber.title": "Fiber on Demand" }
```

There is no `lang/en_us.snbt` to translate, and an overlay could not help: those keys are resolved
against the **mod's** language file. Minecraft merges resource-pack language files over a mod's own,
key by key, so a resource pack is the supported way to replace exactly those strings and nothing
else. Pass the mod jar with `--lang-jar` and that is what you get:

```bash
modpack-quest-translator \
  --archive ./somepack.zip \
  --lang-jar ./SomeMod-1.0.jar \
  --target ja_jp --output ./dist
```

| Flag                    | Meaning                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `--lang-jar <path>`     | Local mod jar providing `assets/<namespace>/lang/<source-locale>.json`. **Its presence selects this mode.** |
| `--lang-namespace <ns>` | Force the namespace instead of deducing it. Only needed when detection reports ambiguity.                   |
| `--pack-format <n>`     | `pack.mcmeta` `pack_format`. Default is derived from the pack's Minecraft version.                          |

The flag is the mode switch, never a guess about the pack. A pack that happens to ship both an SNBT
lang file and placeholder chapters uses whichever you asked for.

#### What gets extracted

Only the keys the quest files **actually reference**. Every `.snbt` under `config/ftbquests/quests/`
— chapters, chapter groups, reward tables — is parsed, and every `{a.b.c}`-shaped placeholder in it
is collected. A mod's `en_us.json` also carries its item names and GUI labels; translating those
would quietly turn a quest translation into a whole-mod translation, so they are left alone. Values
must be strings: a referenced key whose value is not one is refused rather than guessed at.

FTB's own markup is not a translation key and is never collected — `{image:mod:tex.png width:100}`,
`{item:minecraft:apple}` and `{player}` all contain a colon or lack a dot. Formatting codes (`&6`),
escaped ampersands (`\&`) and printf tokens (`%s`, `%1$s`) are protected and validated exactly as in
overlay mode.

#### Automatic namespace detection, and when it refuses

The namespace is decided by **evidence, not naming**. Every top-level
`assets/<namespace>/lang/<source-locale>.json` in the jar is read, and a namespace is a candidate
only if it defines keys the quest files reference.

- **One candidate matches** → that is the answer.
- **Several match, but one subsumes the rest** (it defines everything they do, and more) → that one
  is chosen and the others are reported as alternates. There is nothing to choose between.
- **Anything else** → refused with exit code 2, naming each namespace and how many of the referenced
  keys it covers, and telling you to pass `--lang-namespace`:

  ```text
  error: Several namespaces in the language jar define the referenced quest keys:
         alpha (2 of 13), beta (2 of 13)
  hint:  Pass --lang-namespace <namespace> to say which one provides the quest text.
  ```

- **Nothing matches at all** → exit code 5, listing the namespaces the jar does ship, so you can see
  whether you passed the wrong jar or the wrong `--source-locale`.

- **Every candidate is unreadable** → exit code 2, naming each file and what is wrong with it
  (malformed JSON, an array, no keys at all), rather than reporting the jar as shipping nothing.

Nested trees such as `assets/tacz/x_default_gun/assets/bf1/lang/en_us.json` are not namespaces of
the jar and are skipped; Minecraft only reads the top-level layout. A jar declaring more than 64
candidate namespaces is refused rather than trawled — pass `--lang-namespace`.

`--lang-namespace <ns>` is checked **first**, and it names exactly one file: that file is read and
validated on its own, so the 64-namespace limit never stands in the way of the flag that exists to
answer it, and a jar of a thousand namespaces works fine as long as you say which one you want. If
the file you named is malformed, you are told that — with its path and the reason — instead of being
told the namespace is not there.

#### Known limitations, reported rather than papered over

Two things this mode structurally cannot do. Both are counted on stdout, listed in full in
`translation-report.json` and in the generated README, and **nothing is ever invented** for either:

- **Referenced-but-missing keys.** A key the quest files reference that the source language file
  does not define has no English text to translate. It is omitted from the resource pack, and the
  game keeps showing the raw key.
- **Hard-coded literal labels.** A `title`, `subtitle` or `description` typed straight into a quest
  file — `"WIP"`, `"Any #minecraft:wool"` — has no translation key, so no resource pack can reach
  it. Changing it would mean editing the modpack, which this tool never does.

A quest file that fails to parse is reported too, since its references are unknown rather than
absent — and so is one that could not be read out of the archive at all, for the same reason. Both
are counted in the generated README and listed by path in `translation-report.json`, so a damaged
entry never turns into a silently smaller translation.

A pack with more than 500 quest files is **refused** rather than partly read. Every translated key
comes from one of those files, so stopping at the limit would ship a resource pack missing quest
text with nothing to say so.

Run `--dry-run` to see all of it before spending anything:

```text
[3/7] inspect  curseforge archive, 33 quest file(s), strings from DCTweaks_5.10.14.jar!assets/deceasedcraft/lang/en_us.json
      namespace deceasedcraft: 1269 referenced key(s), 1183 defined, 86 missing, 65 hard-coded label(s)
```

#### `pack.mcmeta` and Minecraft versions

`pack_format` is derived from the pack's own Minecraft version (1.18 → 8 … 1.20/1.20.1 → **15** …
1.21.4 → 46). When the version is unknown or newer than that table, `15` is used, the README says so
explicitly, and `--pack-format <n>` overrides it. A wrong number only makes the launcher call the
pack incompatible; it still loads if you enable it anyway.

#### `--override-en-us` in resource-pack mode

Supported, and it targets `assets/<namespace>/lang/en_us.json` deliberately. It is **safer here than
in overlay mode**, because a resource pack is client-side: only the client that enables it is
affected — never another player, never a server. The two documented consequences:

- You keep an English game while quest text is translated. Only the quest keys are overridden; every
  other string in the namespace is left to the mod.
- `en_us` is Minecraft's **fallback** locale, so any language with no entry of its own for these
  keys falls back to it. The translated quest text will also appear if you later switch to another
  language the mod does not translate.

| Mode               | Archive entry                    |
| ------------------ | -------------------------------- |
| default            | `assets/<ns>/lang/<target>.json` |
| `--override-en-us` | `assets/<ns>/lang/en_us.json`    |

`--layout` does not apply — a resource pack has exactly one layout — and passing it with
`--lang-jar` is a usage error rather than a silently ignored flag. Likewise `--lang-namespace` and
`--pack-format` without `--lang-jar`.

## Installing a resource pack

The generated archive **is** a resource pack. Do not unzip it.

1. Copy the `.zip` as-is into your instance's `resourcepacks/` folder:
   - MultiMC / Prism: the instance folder, then `.minecraft/resourcepacks/`
   - CurseForge / vanilla launcher: `.minecraft/resourcepacks/`
2. Start the game and open **Options → Resource Packs**.
3. Move the pack to the right-hand side so it is enabled, and put it **above** anything else that
   changes quest text.
4. Unless it was built with `--override-en-us`, set your game language to the target locale.

To remove it, disable it on that same screen or delete the `.zip`. Nothing else in the instance was
touched, so there is nothing else to undo. The archive contains `pack.mcmeta`, the one language
file, `README.md`, `translation-manifest.json` and `translation-report.json` — the extra files are
ignored by the game.

The installer bundle is for **overlays only**; a resource pack needs no installer, because enabling
it replaces nothing on disk.

## Examples

```bash
# See exactly what would happen, without translating or spending anything
modpack-quest-translator -u https://modrinth.com/modpack/some-pack -t ja_jp -o ./dist --dry-run

# Pin an exact release rather than "latest stable"
modpack-quest-translator \
  -u https://modrinth.com/modpack/some-pack/version/SzR6i4dZ -t ja_jp -o ./dist

# A local pack file, fully offline, zero cost - the fastest way to smoke-test
modpack-quest-translator --archive ./pack.mrpack -t ja_jp -o ./dist --provider echo

# DeceasedCraft 5.10.17: quest text is translation keys backed by DCTweaks.
# Emits a Minecraft 1.20.1 resource pack; neither input file is modified.
modpack-quest-translator \
  --archive ./deceasedcraft-5.10.17.zip \
  --lang-jar ./DCTweaks_5.10.14.jar \
  --target ja_jp --output ./dist

# ...and what that finds first: 33 quest files, 1269 referenced keys,
# 1183 defined by assets/deceasedcraft/lang/en_us.json, 86 missing, 65 literals
modpack-quest-translator \
  --archive ./deceasedcraft-5.10.17.zip --lang-jar ./DCTweaks_5.10.14.jar \
  -t ja_jp -o ./dist --dry-run

# Keep technical terms verbatim
modpack-quest-translator -u <url> -t ja_jp -o ./dist \
  --glossary "Create=Create" --glossary "Ponder=Ponder" --glossary "Stress Units=Stress Units"

# Cheapest: Haiku only, no automatic escalation
modpack-quest-translator -u <url> -t ja_jp -o ./dist --quality fast --max-cost-usd 2

# Highest quality
modpack-quest-translator -u <url> -t ja_jp -o ./dist --quality best

# Machine-readable, for CI
modpack-quest-translator -u <url> -t ja_jp -o ./dist --json --quiet

# Translating a newer pack release, reporting what actually changed
modpack-quest-translator -u <url> -t ja_jp -o ./dist \
  --previous ./dist/some-pack-1.0.0-ja_jp.manifest.json
```

## Installing the overlay

There are two ways in. The **installer bundle** is the one to hand a player: extract, double-click,
point it at the instance. It saves the pack's own quest file first and can put it back byte for
byte. Everything else on this page is for the person who builds that bundle.

The bundle comes in two kinds. The default carries a compiled executable per platform; the
**script-only bundle** (`--installer scripts`, described in
[its own section](#the-script-only-bundle-no-executables)) carries a Windows PowerShell 5.1 script
and a POSIX `sh` script instead, for players who cannot or will not run an unsigned executable. Both
are built from the same overlay by the same packager, and both keep the same promises about backups.

### The installer bundle — 日本語

配布されるのは 1 つの ZIP です。展開すると次のものが入っています。

```text
<バンドル名>/
  README.md                      日本語 → 英語の説明
  INSTALL-WINDOWS.cmd            Windows: 導入
  UNINSTALL-WINDOWS.cmd          Windows: 削除
  INSTALL-LINUX.sh               Linux: 導入
  UNINSTALL-LINUX.sh             Linux: 削除
  bin/                           各 OS 用の実行ファイル
  payload/                       導入される翻訳済みファイル
  bundle-manifest.json           上記すべての SHA-256
  translation-manifest.json      翻訳時の記録
  translation-report.json
```

Deno も Node も Python も **不要**です。実行ファイルは単体で動きます。

#### 導入のしかた (Windows)

1. ZIP を**すべて展開**します。展開せずに中の `.cmd` を実行しても動きません。
2. `INSTALL-WINDOWS.cmd` をダブルクリックします。
3. 「**WindowsによってPCが保護されました**」(SmartScreen) が出たら、`詳細情報` → `実行` を選びます。
   この実行ファイルにはコード署名がないため、初回は必ずこの警告が出ます。署名には証明書が必要で、
   このプロジェクトは取得していません。入手元に心当たりがない ZIP
   であれば、実行せずに捨ててください。
4. 開いたウィンドウに、Minecraft の**インスタンスのフォルダー**をドラッグして Enter を押します。
   パスを直接入力しても構いません。複数フォルダーをドロップした場合は、最初の 1 つだけを使い、
   その旨を表示します。
5. `続行しますか / Continue? [y/N]:` に `y`（または `はい`）と答えます。
6. 「**導入しました**」と表示されれば完了です。ウィンドウは自動では閉じないので、
   表示を読んでから閉じてください。

インスタンスのフォルダーとは `mods` `config` `saves` が入っているフォルダーです。 Prism / MultiMC
のように `.minecraft` または `minecraft` を含むフォルダーを渡した場合は、 その 1
つ下へ自動で降りて、どちらを使ったかを表示します。それより深くは探しません。 `mods` と `config`
の両方が無いフォルダーは、間違いとして拒否します（終了コード 11）。

#### 導入のしかた (Linux)

```bash
unzip -q <バンドル名>-installer.zip
cd <バンドル名>

# インスタンスのパスを引数で渡す
./INSTALL-LINUX.sh ~/.local/share/PrismLauncher/instances/ACA/minecraft

# 省略すると、その場で入力を求められます
./INSTALL-LINUX.sh
```

端末から実行した場合は Windows と同じ確認 (`続行しますか / Continue? [y/N]:`) が出るので、`y`
と答えてください。`y` 以外は中止で、何も変更されません。確認を省くには `--yes` を渡します。

GUI の展開ツールは実行権限を落とすことがありますが、スクリプトが自分で `chmod +x` し直します。
`sh INSTALL-LINUX.sh` でも動きます。入力を求められたときは `~` から始まるパスも使えます。

#### 元に戻すには

`UNINSTALL-WINDOWS.cmd`（Linux は `./UNINSTALL-LINUX.sh`）を同じ手順で実行するだけです。
導入前のファイルが **1 バイトも違わずに**戻ります。書き戻す前にバックアップの SHA-256 とサイズを
照合し、少しでも合わなければ何も書かずに終了します（終了コード 13）。

翻訳ファイルを消すだけでも構いませんが、その場合はパックの元のクエスト文章が戻りません。
アンインストーラーを使ってください。

#### バックアップの場所と扱い

- 保存先は `<インスタンス>/.mqt-installer/backups/` です。ホームフォルダーやレジストリ、
  管理者権限は一切使いません。インスタンスごとコピー・移動してもバックアップは付いていきます。
- バックアップ本体 `<名前>.<日時>-<連番>.<ハッシュ先頭12桁>.bak` と、その
  SHA-256・サイズ・取得日時・ 対象パスを記録した `.bak.json`
  が対になっています。復元時はこの記録と照合します。
- **このフォルダーは削除しないでください。** パックの元のクエスト文章が残っている、
  あなたの手元の唯一の控えです。消すと元に戻せません。
- 同じ配布物を二度導入しても、バックアップが日本語ファイルで上書きされることはありません。
  ペイロードと同じ内容のファイルは「元のファイル」として決して保存しない、という規則で防いでいます。
- バックアップは**自動で消えません**。アンインストールしても残るので、導入 → 削除 → 再導入 → 削除を
  繰り返しても安全です。不要になったら手で削除してください。
- 導入前にファイルが存在しなかった場合は「無かった」という記録だけを残します。
  アンインストールでは、復元ではなくファイルの削除で元の状態に戻します。

#### 二度目の導入、新しい翻訳への更新

- まったく同じ配布物をもう一度導入した場合は、何も書き換えずに
  「**すでに導入済みです。変更はありません**」と表示して終了します（終了コード 0）。
  バックアップも増えません。
- 新しい翻訳の配布物を導入した場合は、翻訳ファイルだけを差し替え、
  最初に保存した元のファイルはそのまま残します。何度更新しても、戻る先は常にパック本来のファイルです。

#### 導入後に自分でファイルを編集していた場合

- アンインストールも再導入も**中止**され、終了コード 12 と `--force` の案内が出ます。
  ファイルには触れません。編集を黙って捨てることはしません。
- `--force` を付けると、編集後のファイルを `.mqt-installer/backups/` に `modified-install` として
  保存**してから**、アンインストールなら元のファイルを復元し、導入なら翻訳ファイルを書き込みます。
  編集内容が失われることはありません。
- どちらの場合も、最初に保存した「元のファイル」のバックアップはそのまま残ります。
- `--force` を付けても、壊れた・改ざんされた配布物、シンボリックリンクになっている対象、
  インスタンスの外を指すパス、バックアップが無い状態は上書きできません。そこは安全側に倒したままです。
- Linux では、引数はそのまま実行ファイルに渡ります。

  ```bash
  ./UNINSTALL-LINUX.sh /path/to/instance --force
  ```

  Windows の `.cmd` は追加の引数を渡しません。実行ファイルを直接呼んでください。

  ```bat
  bin\mqt-installer-windows-x86_64.exe uninstall --bundle . --instance "C:\...\instance" --force
  ```

#### 覚えておくこと

- **管理者権限は不要です。** 管理者として実行を求めるものがあれば、それは不具合です。
- ネットワークには接続しません。実行ファイルは `--allow-read --allow-write` だけでビルドされていて、
  通信も外部プログラムの起動も、仕組みとしてできません。
- 読み書きするのは、指定したインスタンスの中だけです。
- クエストの**進行状況**はクエスト文章とは別に保存されているので、導入・削除の影響を受けません。
  それでもワールドのバックアップは取っておいてください。

### The installer bundle — English

Same bundle, same steps. Extract the whole ZIP, then:

| Platform | Install                                                                                               | Uninstall                                |
| -------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Windows  | double-click `INSTALL-WINDOWS.cmd`, drag the instance folder onto the window, press Enter, answer `y` | `UNINSTALL-WINDOWS.cmd`                  |
| Linux    | `./INSTALL-LINUX.sh /path/to/instance`                                                                | `./UNINSTALL-LINUX.sh /path/to/instance` |

- The instance folder is the one holding `mods/`, `config/` and `saves/`. A Prism or MultiMC folder
  holding `.minecraft/` or `minecraft/` is accepted and the resolution is printed. Anything without
  both `mods/` and `config/` is refused.
- **SmartScreen**: the executables are unsigned, so Windows shows "Windows protected your PC" on
  first run. `More info` → `Run anyway`, if you trust where the ZIP came from. Code signing needs a
  certificate this project does not have.
- The original file is saved to `<instance>/.mqt-installer/backups/` before anything is replaced,
  with a `.bak.json` sidecar recording its SHA-256, size and capture time. **Do not delete that
  directory** — it is the only copy of the pack's own quest text on your disk. Nothing in it is ever
  deleted or overwritten by the installer, and installing the same bundle twice never replaces the
  original with the translated file.
- Installing the same bundle twice is a no-op that reports "already installed" and exits 0.
  Installing a newer bundle swaps the translation and keeps the first original backup.
- Uninstall restores the original byte for byte, verified against the recorded digest, and keeps the
  backup. If there was no file before install, uninstall deletes the file instead. It restores only
  the backup its own install record names: after a modpack update there are two originals on disk,
  and if the right one cannot be verified the answer is exit code 13, never the older one.
- **Nothing is ever written over.** If Minecraft, a sync client or the modpack's own updater writes
  to the quest file while the installer is working — including in the last instant before the
  installer publishes — that file wins and is left exactly as it is; the run stops with exit code 12
  and says so. Installing needs a filesystem with hard links (NTFS, ext4, APFS, btrfs); on one
  without them the installer refuses up front rather than falling back to a write that could
  overwrite something.
- A run killed by a power cut mid-write leaves the quest file next to itself under a `.mqt-staged-…`
  name. The next install or uninstall puts it back before doing anything else, or keeps it in
  `backups/` if something else has taken the name since. `status` reports it without changing
  anything.
- If you edited the installed file, uninstall refuses with exit code 12 and names `--force`. With
  `--force` your edit is captured as a `modified-install` backup **first**, then the original is
  restored. `--force` never overrides a corrupt bundle, a symlink, a path escaping the instance, or
  a missing backup.
- No administrator rights, no network, no telemetry, no environment variables. Nothing outside the
  instance you name is read or written.

### Running the installer executable directly

The launchers are a convenience; the executable inside `bin/` is the whole program.

```text
mqt-installer install   [--bundle <dir>] [--instance <path>] [--force] [--yes] [--json]
mqt-installer uninstall [--bundle <dir>] [--instance <path>] [--force] [--yes] [--json]
mqt-installer status    [--bundle <dir>] [--instance <path>] [--json]
```

- `--bundle` defaults to the bundle the executable is sitting in (`bin/..`, then `bin/`).
- `--instance` is prompted for when stdin is a terminal, and **required** when it is not, so a
  script or a CI job can never hang.
- `--yes` skips the confirmation, which is otherwise shown before anything is written.
- `status` changes nothing and refuses `--force`/`--yes`.
- `--json` prints one object instead of the bilingual prose.

| Code | Meaning                                                                    |
| ---- | -------------------------------------------------------------------------- |
| 0    | Success, including "already installed, nothing to do", and cancelling      |
| 2    | Bad flags or an unusable path                                              |
| 8    | A write failed                                                             |
| 10   | The bundle is missing, malformed, a newer format, or fails its own digests |
| 11   | Not a Minecraft instance, or the target is a symlink / escapes the root    |
| 12   | The installed file was edited after installation (`--force` overrides)     |
| 13   | No usable backup: missing, truncated or altered                            |
| 14   | Nothing from this bundle is installed                                      |
| 130  | Interrupted                                                                |

The script-only bundle below uses the same codes and adds one: `15`, the pack's quest file is not
the one the translation was made from.

### The script-only bundle (no executables)

`deno task package-installer --installer scripts` builds a bundle with **no compiled binary**:

```text
<バンドル名>/
  README.md                      日本語（簡潔）→ English (brief)
  INSTALL-WINDOWS.cmd            Windows: 導入   (powershell.exe -NoProfile -ExecutionPolicy Bypass -File …)
  UNINSTALL-WINDOWS.cmd          Windows: 削除
  STATUS-WINDOWS.cmd             Windows: 状態表示（何も変更しない）
  INSTALL-LINUX.sh               Linux: 導入     (sh scripts/mqt-installer.sh install …)
  UNINSTALL-LINUX.sh             Linux: 削除
  STATUS-LINUX.sh                Linux: 状態表示
  scripts/mqt-installer.ps1      Windows PowerShell 5.1 (UTF-8 BOM, CRLF)
  scripts/mqt-installer.sh       POSIX sh: dash, bash, busybox
  scripts/installer.conf         key=value: payload path, SHA-256, size; the source file's SHA-256
  payload/                       the translated file
  bundle-manifest.json           as in the binary bundle, plus "installer": "scripts"
  translation-manifest.json / translation-report.json
```

What a player needs: Windows 10/11 (Windows PowerShell 5.1 is built in), or Linux with `sh`,
coreutils (`sha256sum` or `shasum`/`openssl`, `cp`, `mv`, `ln`, `mkdir`, `rm`, `wc`, `date`,
`sync`), `grep` and `sed`. Nothing is downloaded and no other program is started.

- **Windows execution policy.** The `.cmd` launchers run
  `powershell.exe -NoProfile
  -ExecutionPolicy Bypass -File scripts\mqt-installer.ps1 …`. `Bypass`
  is process-scoped: no `Set-ExecutionPolicy`, no registry write, no persistent change. A Group
  Policy that pins the policy, or Constrained Language Mode (AppLocker/WDAC), stops the script, and
  the bundle offers no way around that. SmartScreen may still warn about a downloaded `.cmd`. The
  bundle README says all of this in Japanese and tells the player to close Minecraft first.
- **Same promises, separate state.** The scripts keep their records in
  `<instance>/.mqt-installer-scripts/` — `backups/<name>.<sha12>.<kind>.bak` with a `.meta` sidecar,
  `installed/<name>.meta`, `history.log` — never in the executable installer's `.mqt-installer/`.
  Backups are named by digest, so a reinstall reuses the identical original and a different original
  never collides. Every backup is verified by size and SHA-256 before a restore, and nothing in
  `backups/` is ever deleted.
- **Migration from the executable bundle is a refusal, on purpose.** If `.mqt-installer/state.json`
  records an install of the target, or the target already holds a translation this installer has no
  record and no backup of, the scripts exit 11 and say: run that bundle's UNINSTALL first. The
  executable installer likewise refuses a bundle whose manifest says `installer: scripts`.
- **The pack version is checked.** `installer.conf` pins the SHA-256 of the pack's own quest file as
  read out of `--source-archive` at packaging time (a digest, not prose). A target that is neither
  that file, nor one of this tool's payloads, nor an original already backed up is refused with exit
  15; `--force` (`-Force`) backs it up and installs anyway.
- **Writes.** Payloads and backups are written to a temporary file beside the destination, flushed
  (`sync` on Linux, `Flush(true)` on Windows), verified by digest, then published without replacing:
  the current file is renamed aside, digested against what the run agreed to replace, and the new
  file is linked (`ln`) or moved (`File.Move`, which fails if the name is taken) into the now-absent
  name. A file that appears in between wins and the run exits 12. A run killed in between leaves
  `<target>.mqt-staged`, which the next run puts back, or keeps as a `displaced` backup if the name
  has been taken since. Linux needs hard links (refused up front on FAT32); Windows has no directory
  flush a user can call, so the directory entry is left to NTFS's journal.
- **What the scripts do not do** that the executable does: bind a transaction to the directory's
  identity (a directory swapped for a link between two syscalls is caught only at the next component
  walk), and all-or-nothing across several payload files (every bundle this tool builds has one).
  Both scripts are one translation of the same steps and are tested against each other.
- Usage, directly:

  ```text
  sh scripts/mqt-installer.sh install|uninstall|status [<instance>] [--bundle <dir>] [--instance <path>] [--force] [--yes]
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\mqt-installer.ps1 install|uninstall|status [-BundleDir <dir>] [-Instance <path>] [-Force] [-Yes]
  ```

  Without `--yes`/`-Yes` a terminal is asked `続行しますか / Continue? [y/N]`; with no terminal the
  run proceeds, and a missing instance path is exit 2 rather than a hang.

### Installing the overlay by hand

The raw overlay ZIP is still a plain overlay. Extract it into your Minecraft **instance root** — the
directory that already contains `mods/`, `config/` and `saves/`:

```bash
unzip -o ./aca-ja.zip -d ~/.minecraft/instances/aca/minecraft/
```

Then start the game. FTB Quests reads the file at load time. To remove the translation, delete
`config/ftbquests/quests/lang/<locale>.snbt` — but note that unzipping over the pack's own
`en_us.snbt` in override mode destroys it unless you copied it somewhere first. That is exactly what
the installer bundle exists to prevent.

Quest **progress** is stored separately from quest text, so installing or removing the overlay does
not affect it. Back up your world anyway.

Use `--layout overrides` if you are merging into a pack's own `overrides/` tree for a launcher
import, or `--layout both` to ship both.

## Translation quality and cost

The default provider drives Claude Code with a bounded escalation:

1. `--model` (default `haiku`, `--effort low`) for ordinary strings.
2. The same model again with a repair note naming exactly what failed validation.
3. `--fallback-model` (default `sonnet`) if it still fails.

A string too long for a normal batch skips straight to the fallback model. A transient failure (rate
limit, outage) is retried with bounded exponential backoff and does **not** escalate the model — a
bigger model cannot fix an outage.

Presets: `--quality fast` (haiku only), `balanced` (default), `best` (sonnet, falling back to opus).

Every result is joined **by id**, never by position. Missing, unknown or duplicate ids fail the
batch. Each translation is then checked for preserved formatting codes (`&6`, `§r`), placeholders
(`%s`, `%02d`, `%1$.2f`, `%<s`, `%%`, `{image:...}`, `<mod_var>`), embedded line breaks, the literal
`\&` escape, empty strings staying empty, and any glossary terms. Finally the whole document must
re-parse as SNBT with exactly the same key set and value shapes as the source.

**Output is atomic.** If any string cannot be validated, no installable archive is written at all.
The cache keeps everything that did succeed, so re-running resumes rather than starting over.
`--allow-partial` is deliberately not implemented in v1.

### Cache

Results are cached under `--cache-dir` (default `$XDG_CACHE_HOME/modpack-quest-translator`, else
`~/.cache/modpack-quest-translator`), keyed by source text, source locale, target locale, provider,
model, prompt version and glossary version. Ctrl+C is safe at any point: the cache is flushed
atomically after every batch, and packaging is the last step, so no partial archive can exist.

Use `--no-cache` to disable it.

## CurseForge access

Verified 2026-08-25: `curseforge.com`, its `/api/v1` endpoints and `api.curseforge.com` all return
**HTTP 403** without an API key. There is currently no key-less path. When a CurseForge URL is
refused, the tool says so and names the three real workarounds:

1. Set `CURSEFORGE_API_KEY` (or pass `--curseforge-api-key`). Keys are free from
   <https://console.curseforge.com/>.
2. Pass the direct CDN URL instead — `https://mediafilez.forgecdn.net/files/...` needs no key.
3. Download the pack yourself and pass `--archive <path>`.

Modrinth needs no credentials at all.

## Exit codes

| Code | Meaning                                                                                  |
| ---- | ---------------------------------------------------------------------------------------- |
| 0    | Success                                                                                  |
| 1    | Unexpected internal error                                                                |
| 2    | Invalid input: bad flags, URL or locale                                                  |
| 3    | Unsupported pack: not a modpack, unresolvable, key-gated, or a malformed/hostile archive |
| 4    | Download failure                                                                         |
| 5    | No modern FTB Quests localization file found                                             |
| 6    | Translation failed after retries                                                         |
| 7    | Output failed key-set / value-shape validation                                           |
| 8    | Write or packaging failure, including refusing to overwrite                              |
| 9    | Provider preflight failed: `claude` missing, logged out or unusable                      |
| 130  | Cancelled                                                                                |

The installer executable has its own table, which extends this one:
[installer exit codes](#running-the-installer-executable-directly).

## Supported quest formats

Two, both through the same adapter seam:

| Adapter               | Source                                        | Output                  |
| --------------------- | --------------------------------------------- | ----------------------- |
| `ftbquests-lang`      | `config/ftbquests/quests/lang/<locale>.snbt`  | quest overlay archive   |
| `minecraft-lang-json` | `assets/<ns>/lang/<locale>.json` in a mod jar | Minecraft resource pack |

The instance root, `overrides/`, `server-overrides/` and `client-overrides/` are all searched,
covering both CurseForge-format ZIPs and Modrinth `.mrpack` archives.

Extraction, batching, the cache, the glossary, token preservation, validation, update diffs and
packaging are written against translation **units**, not against a file format, so both modes share
all of them — a new storage format is a new adapter and nothing else. Older inline FTB Quests data
and other quest mods can be added the same way. When no adapter matches, the tool **reports the
paths it did find** and exits 5 — it never silently produces an empty translation. If a pack has no
SNBT lang file but its quest files do hold `{translation.key}` placeholders, that error names the
keys it saw and tells you to re-run with `--lang-jar`.

## Security

- ZIP reading enforces defences against Zip Slip, backslash traversal, absolute/drive/UNC paths,
  symlinks, encrypted entries, unsupported compression methods, control characters in names,
  per-entry and total decompression bombs, implausible compression ratios and entry-count bombs.
  Inflation is capped against real output bytes, so a lying central directory cannot bomb the
  reader.
- Nothing from a downloaded pack is written to disk or executed. Only the quest lang file and
  chapter files are decompressed, in memory.
- **A `--lang-jar` is data, and only data.** It is opened with the same bounded central-directory
  ZIP reader as a modpack, so every defence above applies to it identically. Its size is checked
  against the `--max-download` cap before a byte is inflated **and again against what was actually
  read**, so a file that grew, was swapped, or never reported its size honestly is still refused
  rather than inflated on the strength of its own `stat`. `--max-download` is itself bounded to a
  finite, safe integer, since every other size limit is derived from it. Only
  `assets/<namespace>/lang/<locale>.json` entries are read — no class file is touched, nothing is
  extracted to disk, and nothing in it is ever executed. Neither the jar nor the modpack is
  modified, and neither is redistributed: the output carries the translation only, never the source
  `en_us.json`, the jar, mod bytecode or any pack file. The jar's **path on disk** is deliberately
  not recorded either, since it can carry a user name; provenance is its base name, its SHA-256 and
  the entry that was read.
- HTTP is HTTPS/HTTP only, re-validated at every redirect hop, with https→http downgrades refused,
  bounded redirects, timeouts and a body cap enforced against real bytes.
- Credentials and email addresses are scrubbed from every log line, error, report, manifest, README
  and cache file. A test asserts nothing leaks with secrets present in both the environment and the
  pack text.
- Pack text is sent to the provider on **stdin**; it never appears in argv, and no shell is ever
  invoked.
- Final files are written atomically.
- No telemetry, ever.

The installer executable is held to the same standard, and is compiled with
`--allow-read
--allow-write` and nothing else — no `--allow-net`, `--allow-run` or `--allow-env` —
so it structurally cannot phone home or spawn anything. It refuses a payload path outside
`config/ftbquests/quests/lang/`, verifies every payload digest against `bundle-manifest.json` before
touching a file, refuses a manifest that cannot describe itself coherently — a foreign tool name, a
`toolVersion` that is not a semver, a `generatedAt` that is not a real timestamp, locales that are
malformed or identical, a `bundleId` carrying a path separator — refuses a symlinked target or one
whose resolved parent is outside the instance root (`--force` does not override any of those), and
publishes every file inside an instance through a transaction that cannot overwrite one: the new
bytes are flushed to a temporary file, whatever is at the target is renamed aside and digested
against the plan, and the payload is published into the now-absent name with a hard link, which
fails rather than replacing. An interrupted run leaves either the old bytes or the new ones, and a
concurrent writer keeps its own. The pack's own English text is never placed inside a bundle; the
only copy is the backup on the player's own disk.

## Development

```bash
deno task verify     # fmt --check, lint, check, and the full test suite
deno task test       # tests only
deno task build      # compile dist/modpack-quest-translator
```

Tests never touch the network, spawn a process, or write outside a temp directory: HTTP is a fixture
router, subprocesses are a scripted runner, and the offline `echo` provider exercises the whole
pipeline at zero cost.

### Building an installer bundle

The bundle described in [Installing the overlay](#installing-the-overlay) is built from an overlay
this tool produced, in two steps: compile the installer for each platform, then package.

```bash
deno task build:installer:linux     # -> dist/bin/mqt-installer-linux-x86_64
deno task build:installer:windows   # -> dist/bin/mqt-installer-windows-x86_64.exe
deno task build:installers          # both of the above

# package an existing overlay with binaries you already built
deno task package-installer \
  --overlay        ./dist/aca-2.4-ja_jp-en_us-override.zip \
  --source-archive ./aca-v2.4.zip \
  --output         ./dist \
  --binaries       ./dist/bin

# build both binaries and package in one go; extra flags go to the packager
deno task bundle \
  --overlay        ./dist/aca-2.4-ja_jp-en_us-override.zip \
  --source-archive ./aca-v2.4.zip \
  --output         ./dist
```

`deno task bundle` is `build:installers` followed by `package-installer --binaries dist/bin`, so it
needs `--overlay`, `--source-archive` and `--output`.

| Flag                                               | Behaviour                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--overlay <zip>`                                  | Required. The raw overlay archive from a translation run                                                                                                      |
| `--source-archive <zip>`                           | Required. The modpack archive that run read, byte for byte. See below                                                                                         |
| `--output <zip\|dir>`                              | Required. A `.zip` path is that exact file; anything else is a directory, written as `<bundle-id>-installer.zip`                                              |
| `--binaries <dir>`                                 | Directory holding the compiled installers, as produced by `deno task build:installers`                                                                        |
| `--linux-binary <path>`, `--windows-binary <path>` | Explicit paths, overriding `--binaries`                                                                                                                       |
| `--no-binaries`                                    | Package with no executables. The bundle README and manifest both say it cannot be double-clicked                                                              |
| `--installer scripts`                              | The [script-only bundle](#the-script-only-bundle-no-executables): PowerShell 5.1 + POSIX sh, written as `<bundle-id>-scripts.zip`. Excludes every binary flag |
| `--manifest`, `--report`                           | The translation sidecars, if not the copies inside the overlay or beside it                                                                                   |
| `--bundle-id <id>`                                 | The top-level directory name inside the bundle. Letters, digits, `.`, `-` and `_` only. Defaults to the overlay's file stem                                   |
| `--generated-at <iso>`                             | Overrides the timestamp, which otherwise comes from the translation manifest                                                                                  |
| `--force`, `--json`, `--quiet`                     | As in the translator                                                                                                                                          |

The packager copies **only** entries the overlay holds under `config/ftbquests/quests/lang/`;
anything else is refused with exit code 10. On its own that allowlist would not stop the pack's own
`en_us.snbt` — it lives in that directory too — so before a byte is copied the overlay also has to
be recognisable as a finished run of this tool: both translation sidecars present and this tool's,
locales that differ, and an empty `failed` list.

The check that actually matters, though, cannot be made from the overlay alone. `sourceKeyDigests`
is the manifest's own account of text it read, and comparing a payload against that account proves
nothing: whoever writes the payload writes the manifest beside it, so setting every digest to a
string the payload cannot produce is enough to have the pack's own prose packaged as a translation.
That is why `--source-archive` is required. The packager hashes it, refuses it unless it is the
archive the run recorded, finds the quest lang file inside it with the same rules the run used,
recomputes every per-key digest from those bytes, and refuses any manifest that disagrees — key
counts included. Only then is the payload compared, against the source **as read** rather than as
described — and string by string rather than in bulk: same keys, the same strings in the same
places, and not one of the source's own sentences still sitting there word for word. "Did anything
change?" is too weak a question; one translated title in a file of English descriptions answers it
yes. Strings a translation run is _supposed_ to hand back untouched — empty ones, markup, a single
short word — are recognised by the translator's own classifier, the one that refuses a provider for
echoing its input, so an honest overlay is never caught by this. `--generated-at` overrides only the
timestamp; it is not a way past any of it.

That is what keeps the pack's own English prose out of a bundle, and the guarantee is _relative to
the archive you supply_. It establishes "this payload is a translation of the quest file in that
archive", not "that archive is what the pack's author released" — hand it a fabricated archive and a
manifest that agrees with it, and the two will agree. Establishing the second needs a signed
provenance scheme this project does not have. The same limit applies to the bundle's own digests:
`bundle-manifest.json` sits beside the payload it describes, so its SHA-256 entries catch a corrupt
download rather than a deliberate edit, and the bundle README says so in both languages.

Packaging the same overlay with the same binaries twice is byte-identical — the ZIP writer sorts
entries and fixes timestamps, and `generatedAt` comes from the translation run rather than the
clock.

`bin/*` and the two `.sh` launchers carry mode `0755` in the ZIP; everything else is `0644`.

### The bundle acceptance gate

```bash
# translate a fixture pack, then package it
deno task e2e:bundle

# package an overlay you already have, against the archive its run read
deno task e2e:bundle --overlay ./dist/some-pack.zip --source-archive ./aca-v2.4.zip
```

Deliberately not a `deno test`: it spawns real processes and runs the real compiled Linux binary
against a real instance tree — install, reinstall, a payload edited without its manifest, uninstall,
byte-for-byte restore — and asserts the Windows executable is a PE image. Windows _runtime_
behaviour is not tested from Linux and no such claim is made.

The script-only bundle has its own gate:

```bash
deno task e2e:scripts --bundle-zip ./dist/<id>-scripts.zip --source-archive ./aca-v2.4.zip \
  [--pwsh /path/to/pwsh] [--sh dash|bash] [--keep]
```

It extracts the bundle under a path with a space and Japanese in it and drives
`scripts/mqt-installer.sh` under `dash` and `bash` — and `scripts/mqt-installer.ps1` under `pwsh`
when one is given or on `PATH` — through the happy path and every refusal: wrong directory, wrong
pack version, edited install, symlinked target, lang directory and state directory, tampered payload
and conf, truncated and missing backups, lost records, two candidate originals, an instance the
executable installer set up, staged leftovers, and an upgrade. A `pwsh` run on Linux proves the
PowerShell logic against the same filesystem as the sh script; it is **not** Windows PowerShell 5.1,
NTFS or `cmd.exe`, and the `.cmd` launchers are checked only by the unit tests for quoting, `-File`,
`-NoProfile` and a process-scoped `-ExecutionPolicy Bypass`.

See [DESIGN.md](DESIGN.md) for the architecture and the reasoning behind each decision, and
[REQUIREMENTS.md](REQUIREMENTS.md) for the approved scope.
