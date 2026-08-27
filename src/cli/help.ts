import { VERSION } from "../version.ts";

export const HELP = `modpack-quest-translator ${VERSION}

Translate a Minecraft modpack's FTB Quests text into another language and emit a
ready-to-install archive. The downloaded pack is never modified.

Two kinds of pack, two kinds of output:

  * The pack ships config/ftbquests/quests/lang/<locale>.snbt
    -> a quest overlay you extract into the instance. This is the default.

  * The pack's quest files hold {translation.key} placeholders and the English
    strings live in a mod's assets/<namespace>/lang/<locale>.json
    -> pass --lang-jar <that-mod.jar> and get a normal Minecraft resource pack
       you enable in Options -> Resource Packs.

USAGE
  modpack-quest-translator --url <modpack-url> --target <language> --output <path> [options]
  modpack-quest-translator --archive <file.zip|.mrpack> --target <language> --output <path>
  modpack-quest-translator --archive <pack.zip> --lang-jar <mod.jar> -t <lang> -o <path>

REQUIRED
  -u, --url <url>            CurseForge or Modrinth modpack project URL, a file/version
                             URL that pins an exact release, or a direct .zip/.mrpack URL
      --archive <path>       Use a local pack archive instead of --url
  -t, --target <lang>        Target locale (ja_jp, ja-JP, ja) or language name (Japanese)
  -o, --output <path>        Output .zip path, or a directory to name the archive in

RESOURCE-PACK MODE
      --lang-jar <path>      Local mod jar providing assets/<ns>/lang/<source>.json.
                             Its presence selects resource-pack mode. Read as data only:
                             bounded, never extracted, never executed
      --lang-namespace <ns>  Force the namespace instead of deducing it from the keys
                             the quest files reference (needed only when ambiguous)
      --pack-format <n>      pack.mcmeta pack_format; default is derived from the pack's
                             Minecraft version, falling back to 15 (MC 1.20/1.20.1)

OUTPUT
      --override-en-us       Emit the translation as en_us, so the game and every
                             mod stay in English and only quest text is translated
      --override-english <true|false>
                             Same thing, spelled out
      --layout <mode>        auto (default) | instance | overrides | both.
                             Overlay mode only; a resource pack has one layout
      --emit-raw             Also write the translated .snbt/.json beside the archive
      --force                Overwrite an existing output file
      --source-locale <loc>  Locale to translate from (default: en_us)

TRANSLATION
      --provider <name>      claude-code (default) | echo (offline, no cost)
      --model <model>        Primary model (default: haiku)
      --fallback-model <m>   Model for batches that fail validation (default: sonnet)
      --quality <preset>     fast (haiku only) | balanced (default) | best (sonnet/opus)
      --effort <level>       Reasoning effort for the primary model (default: low)
      --glossary <k=v>       Term that must be preserved; repeatable
      --glossary-file <path> JSON object of term -> required translation
      --batch-size <n>       Max strings per request (default: 40)
      --batch-chars <n>      Max characters per request (default: 6000)
      --concurrency <n>      Parallel requests, 1-8 (default: 2)
      --retries <n>          Transient retries per batch (default: 3)
      --max-cost-usd <n>     Cap the spend the provider is allowed
      --dry-run              Report the plan and exit without translating

CACHE AND UPDATES
      --cache-dir <path>     Cache location (default: XDG cache directory)
      --no-cache             Do not read or write the cache
      --previous <manifest>  A previous run's manifest, to report added/changed/reused

NETWORK
      --timeout <seconds>    Per-request timeout (default: 60)
      --max-download <size>  Download cap, e.g. 512MiB (default: 1GiB, max: 16GiB)
      --allow-prerelease     Allow a beta/alpha release to be selected
      --curseforge-api-key <key>
                             CurseForge API key; also read from CURSEFORGE_API_KEY

OUTPUT CONTROL
      --json                 NDJSON events on stdout, for scripts and CI
      --quiet                Errors only
      --verbose              Extra detail
      --no-color             Disable ANSI colour
  -h, --help                 Show this help
  -v, --version              Show the version

EXIT CODES
  0 success              5 no FTB Quests localization found
  1 internal error       6 translation failed
  2 invalid input        7 validation failed
  3 unsupported pack     8 write/packaging failed
  4 download failed      9 provider preflight failed  130 cancelled

EXAMPLES
  # Japanese quests, English UI, from a CurseForge pack
  modpack-quest-translator \\
    --url "https://www.curseforge.com/minecraft/modpacks/all-of-create-aeronautics" \\
    --target ja_jp --override-en-us --output ./aca-ja.zip

  # Modrinth pack, target-locale mode, into a directory
  modpack-quest-translator -u https://modrinth.com/modpack/some-pack -t Japanese -o ./dist

  # See what would happen, without translating anything
  modpack-quest-translator -u <url> -t ja_jp -o ./out --dry-run

  # Fully offline smoke run against a local pack
  modpack-quest-translator --archive ./pack.mrpack -t ja_jp -o ./out --provider echo

  # A pack whose quests are translation keys: emit a Minecraft resource pack
  modpack-quest-translator \\
    --archive ./deceasedcraft-5.10.17.zip \\
    --lang-jar ./DCTweaks_5.10.14.jar \\
    --target ja_jp --output ./dist

  # See what it would find first: referenced, defined, missing and hard-coded counts
  modpack-quest-translator --archive ./pack.zip --lang-jar ./mod.jar \\
    -t ja_jp -o ./dist --dry-run
`;
