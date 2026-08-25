import { VERSION } from "../version.ts";

export const HELP = `modpack-quest-translator ${VERSION}

Translate a Minecraft modpack's FTB Quests text into another language and emit a
ready-to-install overlay archive. The downloaded pack is never modified.

USAGE
  modpack-quest-translator --url <modpack-url> --target <language> --output <path> [options]
  modpack-quest-translator --archive <file.zip|.mrpack> --target <language> --output <path>

REQUIRED
  -u, --url <url>            CurseForge or Modrinth modpack project URL, a file/version
                             URL that pins an exact release, or a direct .zip/.mrpack URL
      --archive <path>       Use a local pack archive instead of --url
  -t, --target <lang>        Target locale (ja_jp, ja-JP, ja) or language name (Japanese)
  -o, --output <path>        Output .zip path, or a directory to name the archive in

OUTPUT
      --override-en-us       Emit the translation as en_us.snbt, so the game and every
                             mod stay in English and only quest text is translated
      --override-english <true|false>
                             Same thing, spelled out
      --layout <mode>        auto (default) | instance | overrides | both
      --emit-raw             Also write the translated .snbt beside the archive
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
      --max-download <size>  Download cap, e.g. 512MiB (default: 1GiB)
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
`;
