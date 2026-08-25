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
file plus a bilingual README, a metadata manifest and a machine-readable report.

It does **not** translate mod item/block/UI language files or Create Ponder scenes, does not edit
quest topology, tasks, rewards or progression, and never repacks or redistributes the modpack. No
mod JARs, pack assets or credentials are ever placed in the output.

## Requirements

- [Deno](https://deno.com/) 1.41 or newer — only to build or run from source. The compiled binary
  has no runtime dependencies.
- [Claude Code](https://claude.com/claude-code), already installed and logged in, for the default
  translation provider. The tool drives the `claude` CLI as a subprocess; it never calls Anthropic
  HTTP APIs directly and never runs `claude update`.
- No API keys are needed for Modrinth. CurseForge needs one — see
  [CurseForge access](#curseforge-access).

## Installation

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

## Installing the generated overlay

Extract the archive into your Minecraft **instance root** — the directory that already contains
`mods/`, `config/` and `saves/`:

```bash
unzip -o ./aca-ja.zip -d ~/.minecraft/instances/aca/minecraft/
```

Then start the game. FTB Quests reads the file at load time. To remove the translation, delete
`config/ftbquests/quests/lang/<locale>.snbt`.

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
(`%s`, `%1$s`, `{image:...}`, `<mod_var>`), the literal `\&` escape, empty strings staying empty,
and any glossary terms. Finally the whole document must re-parse as SNBT with exactly the same key
set and value shapes as the source.

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

## Development

```bash
deno task verify     # fmt --check, lint, check, and the full test suite
deno task test       # tests only
deno task build      # compile dist/modpack-quest-translator
```

Tests never touch the network, spawn a process, or write outside a temp directory: HTTP is a fixture
router, subprocesses are a scripted runner, and the offline `echo` provider exercises the whole
pipeline at zero cost.

See [DESIGN.md](DESIGN.md) for the architecture and the reasoning behind each decision, and
[REQUIREMENTS.md](REQUIREMENTS.md) for the approved scope.
