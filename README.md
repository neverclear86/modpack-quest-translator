# modpack-quest-translator

Translate a Minecraft modpack's **FTB Quests** text into another language and emit a
ready-to-install overlay archive. The downloaded pack is never modified, and nothing from it is
extracted to disk or executed.

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

It translates quest **titles, subtitles and descriptions** from
`config/ftbquests/quests/lang/<locale>.snbt`, and emits a small ZIP containing that one translated
file plus a bilingual README, a metadata manifest and a machine-readable report. That overlay can be
packaged further into a double-clickable **installer bundle** for Windows and Linux, which saves the
pack's own quest file before replacing it and can put it back byte for byte — see
[Installing the overlay](#installing-the-overlay).

It does **not** translate mod item/block/UI language files or Create Ponder scenes, does not edit
quest topology, tasks, rewards or progression, and never repacks or redistributes the modpack. No
mod JARs, pack assets or credentials are ever placed in the output.

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
```

### The four core inputs

| Flag               | Meaning                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `-u, --url`        | CurseForge or Modrinth modpack project URL, a file/version URL pinning an exact release, or a direct `.zip`/`.mrpack` URL           |
| `-t, --target`     | `ja_jp`, `ja-JP`, `ja`, `Japanese` or `日本語` — all resolve to the same locale, which is printed before work begins                |
| `--override-en-us` | Emit the translation as `en_us.snbt` instead of `<locale>.snbt` (`--override-english <true\|false>` is the same switch spelled out) |
| `-o, --output`     | An explicit `.zip` path, or a directory                                                                                             |

`--url` and `--archive` are mutually exclusive; exactly one is required.

### `--output` semantics

Deterministic, and never destructive:

- Ends in `.zip` → that exact file is the archive. Sidecars are written beside it as
  `<base>.manifest.json`, `<base>.report.json`, `<base>.README.md`, and `<base>.<locale>.snbt` with
  `--emit-raw`.
- Anything else → treated as a directory, created if needed. The archive is named
  `<pack-slug>-<pack-version>-<locale>[-en_us-override].zip`, so the exact compatible pack version
  is part of the filename and a newer pack release produces a new file.
- An existing output file is **never** silently overwritten. That is exit code 8 unless `--force`.

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

## Examples

```bash
# See exactly what would happen, without translating or spending anything
modpack-quest-translator -u https://modrinth.com/modpack/some-pack -t ja_jp -o ./dist --dry-run

# Pin an exact release rather than "latest stable"
modpack-quest-translator \
  -u https://modrinth.com/modpack/some-pack/version/SzR6i4dZ -t ja_jp -o ./dist

# A local pack file, fully offline, zero cost - the fastest way to smoke-test
modpack-quest-translator --archive ./pack.mrpack -t ja_jp -o ./dist --provider echo

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
  backup. If there was no file before install, uninstall deletes the file instead.
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

## Supported quest format

v1 targets modern FTB Quests packs whose localization lives in
`config/ftbquests/quests/lang/<locale>.snbt`. The instance root, `overrides/`, `server-overrides/`
and `client-overrides/` are all searched, covering both CurseForge-format ZIPs and Modrinth
`.mrpack` archives.

Quest formats are handled through adapters, so older inline FTB Quests data and other quest mods can
be added without touching extraction, translation or packaging. When no adapter matches, the tool
**reports the paths it did find** and exits 5 — it never silently produces an empty translation.

## Security

- ZIP reading enforces defences against Zip Slip, backslash traversal, absolute/drive/UNC paths,
  symlinks, encrypted entries, unsupported compression methods, control characters in names,
  per-entry and total decompression bombs, implausible compression ratios and entry-count bombs.
  Inflation is capped against real output bytes, so a lying central directory cannot bomb the
  reader.
- Nothing from a downloaded pack is written to disk or executed. Only the quest lang file and
  chapter files are decompressed, in memory.
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
writes every file temp-then-`rename` so an interrupted run leaves either the old bytes or the new
ones. The pack's own English text is never placed inside a bundle; the only copy is the backup on
the player's own disk.

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
  --overlay  ./dist/aca-2.4-ja_jp-en_us-override.zip \
  --output   ./dist \
  --binaries ./dist/bin

# build both binaries and package in one go; extra flags go to the packager
deno task bundle \
  --overlay ./dist/aca-2.4-ja_jp-en_us-override.zip \
  --output  ./dist
```

`deno task bundle` is `build:installers` followed by `package-installer --binaries dist/bin`, so it
needs only `--overlay` and `--output`.

| Flag                                               | Behaviour                                                                                                                   |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `--overlay <zip>`                                  | Required. The raw overlay archive from a translation run                                                                    |
| `--output <zip\|dir>`                              | Required. A `.zip` path is that exact file; anything else is a directory, written as `<bundle-id>-installer.zip`            |
| `--binaries <dir>`                                 | Directory holding the compiled installers, as produced by `deno task build:installers`                                      |
| `--linux-binary <path>`, `--windows-binary <path>` | Explicit paths, overriding `--binaries`                                                                                     |
| `--no-binaries`                                    | Package with no executables. The bundle README and manifest both say it cannot be double-clicked                            |
| `--manifest`, `--report`                           | The translation sidecars, if not the copies inside the overlay or beside it                                                 |
| `--bundle-id <id>`                                 | The top-level directory name inside the bundle. Letters, digits, `.`, `-` and `_` only. Defaults to the overlay's file stem |
| `--generated-at <iso>`                             | Overrides the timestamp, which otherwise comes from the translation manifest                                                |
| `--force`, `--json`, `--quiet`                     | As in the translator                                                                                                        |

The packager copies **only** entries the overlay holds under `config/ftbquests/quests/lang/`;
anything else is refused with exit code 10. On its own that allowlist would not stop the pack's own
`en_us.snbt` — it lives in that directory too — so before a byte is copied the overlay also has to
be recognisable as a finished run of this tool: both translation sidecars present and this tool's,
locales that differ, an empty `failed` list, and a payload whose per-key digests are **not** the
ones the run recorded for the text it read. A file that digests to the source key for key is the
source, and is refused. `--generated-at` overrides only the timestamp; it is not a way past the
check.

That is what keeps the pack's own English prose out of a bundle. It is not a signature and is not
claimed as one — a manifest is a JSON file, and someone determined to lie can write one that agrees
with a payload they also wrote. What it makes impossible is the accident, which is the failure this
project actually has. The same goes for the bundle's own digests: `bundle-manifest.json` sits beside
the payload it describes, so its SHA-256 entries catch a corrupt download rather than a deliberate
edit, and the bundle README says so in both languages.

Packaging the same overlay with the same binaries twice is byte-identical — the ZIP writer sorts
entries and fixes timestamps, and `generatedAt` comes from the translation run rather than the
clock.

`bin/*` and the two `.sh` launchers carry mode `0755` in the ZIP; everything else is `0644`.

### The bundle acceptance gate

```bash
deno task e2e:bundle                                  # translate a fixture pack, then package it
deno task e2e:bundle --overlay ./dist/some-pack.zip   # package an overlay you already have
```

Deliberately not a `deno test`: it spawns real processes and runs the real compiled Linux binary
against a real instance tree — install, reinstall, a payload edited without its manifest, uninstall,
byte-for-byte restore — and asserts the Windows executable is a PE image. Windows _runtime_
behaviour is not tested from Linux and no such claim is made.

See [DESIGN.md](DESIGN.md) for the architecture and the reasoning behind each decision, and
[REQUIREMENTS.md](REQUIREMENTS.md) for the approved scope.
