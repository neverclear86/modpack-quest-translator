# Modpack Quest Translator CLI — Requirements & Environment Draft

> **Status:** User approval required before design or implementation. Do not start Claude Code yet.

## Goal

Given a Minecraft modpack URL, automatically obtain the pack's FTB Quests localization source, translate its quest text into a requested language, and emit a ready-to-install overlay archive without modifying the downloaded original pack.

## Recommended environment

### Choice: Deno + TypeScript

Deno is recommended for the first implementation.

Reasons:
- Native `fetch`, filesystem, streams, crypto, and TypeScript support fit URL resolution, archive download, translation API calls, and CLI implementation.
- Easier access to ZIP and JSON/SNBT libraries than MoonBit/WASM.
- `deno compile` can produce standalone executables for Linux, Windows, and macOS.
- Cross-platform filesystem and HTTP behavior can be integration-tested directly.
- Translation providers can be implemented as HTTP adapters without external runtimes.

MoonBit/WASM is not recommended for v1 because WASI networking, archive handling, native packaging, credential/environment access, and cross-platform CLI ergonomics add complexity without benefiting this workload. A later WASM core for parsing/validation remains possible if useful.

## Product scope (v1)

### Supported pack sources

1. CurseForge modpack project URLs.
2. CurseForge URLs pointing to a specific file/release.
3. Modrinth modpack project URLs.
4. Modrinth URLs pointing to a specific version.
5. Direct URLs to a CurseForge-format ZIP or `.mrpack` archive, where technically accessible.

Resolution rules:
- A version/file URL selects that exact release.
- A project URL selects the latest stable release and prints the resolved project, version, Minecraft version, loader, publication date, and download URL before processing.
- The resolver must reject non-modpack projects and ambiguous/unsupported URLs with an actionable error.
- CurseForge downloads must work without requiring a CurseForge API key when the public download endpoint permits it. Optional API-key support may be added for restricted cases.

### Supported quest format

v1 targets modern FTB Quests packs where quest localization is stored under:

```text
config/ftbquests/quests/lang/en_us.snbt
```

Also detect equivalent paths inside:
- CurseForge `overrides/`
- Modrinth `overrides/`
- server overrides, if present in the selected archive

Architecture must use quest-format adapters so older inline FTB Quests data and other quest mods can be added later. v1 must report unsupported formats rather than silently producing an empty translation.

## Required CLI inputs

The user-requested core inputs are mandatory:

```text
--url <modpack-url>
--target <language-or-locale>
--override-english <true|false>
--output <path>
```

Proposed ergonomic aliases:

```text
-u, --url
-t, --target
-o, --output
--override-en-us
```

Rules:
- `--target` accepts a Minecraft locale such as `ja_jp` and a human-readable language such as `Japanese`; the resolved locale is shown before work begins.
- `--override-en-us` emits translated quest content as `en_us.snbt`, allowing the game and all mods to remain in English while only quest content is Japanese.
- Without `--override-en-us`, output uses the target locale, such as `ja_jp.snbt`.
- `--output` may be either an output directory or an explicit `.zip` path; behavior must be documented and deterministic.
- Non-interactive operation must be fully supported for scripts and CI.

Example:

```bash
modpack-quest-translator \
  --url "https://www.curseforge.com/minecraft/modpacks/all-of-create-aeronautics" \
  --target ja_jp \
  --override-en-us \
  --output ./aca-ja.zip
```

## Translation-provider requirements

Translation must be replaceable through a stable provider interface. Parsing, validation, caching, and packaging must not depend on Claude Code-specific response types.

### v1 default provider: Claude Code command adapter

The first provider invokes an already-installed and authenticated Claude Code CLI through a subprocess. It must not call Anthropic HTTP APIs directly.

Preflight checks:
- Confirm `claude` exists and report its version.
- Confirm Claude Code authentication is usable before starting a paid/limited translation run.
- Give an actionable error when Claude Code is missing, logged out, rate-limited, or unavailable.
- The translation tool must not run `claude update` automatically; upgrading a user's global CLI is outside its scope.

Invocation design:
- Extract translatable values into bounded JSON batches before invoking Claude.
- Send JSON through stdin, never interpolate source text into a shell command.
- Spawn `claude` directly through Deno's subprocess API without a shell.
- Use non-interactive print mode (`claude -p`).
- Disable Claude Code tools for translation (`--tools ""`) so it cannot read/write files or execute commands.
- Use `--no-session-persistence` so translation batches do not accumulate as reusable Claude sessions.
- Require structured output using `--output-format json` plus `--json-schema`.
- Set a bounded `--max-turns` and subprocess timeout.
- Parse only the schema-validated structured result; do not scrape prose.

Proposed default model policy:
- Default model: `haiku`, effort `low`, for ordinary strings.
- Fallback model: `sonnet` for batches that fail schema/placeholder validation, contain unusually long prose, or remain inconsistent after a bounded Haiku retry.
- Expose `--model`, `--fallback-model`, and a simple quality preset so users can force Haiku-only or Sonnet-only behavior.
- Record the actual model used per translated batch in metadata/cache.

Proposed translation-unit JSON shape:

```json
{
  "sourceLocale": "en_us",
  "targetLocale": "ja_jp",
  "context": {
    "pack": "All of Create Aeronautics",
    "chapter": "aeronautics"
  },
  "glossary": {
    "Create": "Create",
    "Ponder": "Ponder"
  },
  "items": [
    {
      "id": "quest.02B0448DA14595B0.quest_subtitle",
      "kind": "quest_subtitle",
      "text": "The Contraption Diagram lets you visualize...",
      "protectedTokens": ["&6", "&r"]
    }
  ]
}
```

Claude must return only IDs and translated values. The tool restores nothing by position: every result is joined by ID, and duplicate/missing/unknown IDs fail validation.

Provider-independent requirements:
- Batch requests to reduce cost and latency while retaining chapter/type context.
- Retry with bounded exponential backoff for transient CLI/provider errors.
- Resumable cache keyed by source text, source locale, target locale, provider, model, prompt version, and glossary version.
- Optional `--dry-run` reports source detection, key counts, expected batches, and output layout without invoking Claude.
- Optional usage/cost report when Claude Code returns enough usage information.
- Credentials must never be written into output archives, logs, caches, or error reports.

Future providers can include direct HTTP APIs, local models, or another command adapter without changing extraction or packaging.

## Translation correctness requirements

The translator must:
- Preserve every SNBT key exactly.
- Translate values only; never translate quest IDs, item IDs, NBT, resource locations, filenames, or structural syntax.
- Preserve Minecraft formatting markers such as `&6`, `&r`, `§`, escaped quotes, newlines, arrays, and placeholders.
- Preserve placeholders including printf-style tokens, `{...}` substitutions, `%s`, `%1$s`, and mod-specific variables.
- Keep empty strings empty.
- Preserve technical names when appropriate, with a user-supplied glossary option for terms such as Create, Ponder, Stress Units, and contraption names.
- Translate array elements independently while preserving order and array structure.
- Validate that output parses as SNBT and has exactly the same key set and compatible value shapes as the source.
- Automatically retry only failed/malformed batches.
- Fail without writing a final installable archive if validation still fails.
- Never modify the original downloaded archive.

## Output requirements

Produce an installable overlay ZIP with one of these layouts.

Target-locale mode:

```text
config/ftbquests/quests/lang/ja_jp.snbt
```

English-override mode:

```text
config/ftbquests/quests/lang/en_us.snbt
```

For launcher/modpack import compatibility, support or automatically choose the necessary `overrides/config/...` wrapper when appropriate. The generated README must state exactly whether the archive should be extracted into the instance root, imported, or installed server-side.

Each output should contain:
- Ready-to-install translated overlay ZIP.
- Translation metadata manifest containing source URL, resolved pack/version, source archive hash, source locale, target locale, override mode, translation provider/model identifier, generation time, tool version, and key counts.
- Human-readable installation/update README in Japanese and English.
- Optional raw translated SNBT beside the ZIP when `--emit-raw` is specified.
- Machine-readable report of translated, cached, skipped, failed, and fallback keys.

Do not include:
- The complete original modpack.
- Mod JARs or other copyrighted pack assets unrelated to the localization overlay.
- API credentials.

## Partial translation and failure policy

Default policy: atomic output.
- No final installable ZIP is produced unless all selected keys pass validation.
- Work-in-progress cache remains available for resume.

Optional future policy:
- `--allow-partial` could retain original English values for failed keys and mark them in the report.
- This should not be enabled by default in v1 unless explicitly approved.

## Multiplayer behavior to document

- Replacing `en_us.snbt` server-side affects all players whose game locale resolves to `en_us`.
- A separate locale file such as `en_gb.snbt` can be used as a per-player opt-in while retaining an English-language Minecraft environment.
- Single-player installation applies only to that instance.
- Server and client responsibilities must be verified against the detected FTB Quests version and included in the generated README.

## Update behavior

- Running against a newer pack release should create a new output rather than overwrite silently.
- Compare source localization keys against an optional previous translation/cache.
- Reuse unchanged validated translations.
- Translate added or changed source strings only.
- Report added, changed, removed, and reused keys.
- Include the exact compatible modpack version in the output filename by default.

## CLI quality requirements

- Clear progress stages: resolve, download, inspect, parse, translate, validate, package.
- Quiet and JSON output modes for automation.
- Useful exit codes for invalid input, unsupported pack, download failure, missing quest localization, translation failure, validation failure, and write failure.
- Cancellation via Ctrl+C without corrupting cache or final output.
- No telemetry by default.
- Deterministic packaging where practical.
- Cross-platform path handling.

## Security requirements

- Defend ZIP extraction against path traversal/Zip Slip, absolute paths, symlinks, decompression bombs, and unreasonable archive/file sizes.
- Bound HTTP redirects, request timeouts, response size, translation batch size, and concurrency.
- Validate URLs and allow only HTTP(S).
- Do not execute files or scripts contained in modpacks.
- Redact credentials from all errors.
- Write final files atomically.

## Testing and acceptance criteria

At minimum, automated tests must cover:
- URL parsing for CurseForge, Modrinth, version URLs, and invalid URLs.
- Archive resolution/download using fixtures and mocked HTTP.
- CurseForge ZIP and Modrinth `.mrpack` override discovery.
- SNBT round-trip parsing/serialization with multiline arrays, escaping, formatting codes, Unicode, and placeholders.
- Translation batching, retries, resume cache, and malformed provider responses.
- Exact key-set/value-shape validation.
- ZIP safety attacks.
- Correct `ja_jp.snbt` output mode.
- Correct translated `en_us.snbt` override mode.
- No secret leakage into output/logs.
- End-to-end fixture producing an archive that can be extracted to the expected path.

Manual acceptance test:
1. Run against a fixed ACA release URL.
2. Install generated overlay into a cloned ACA instance.
3. Keep Minecraft set to English.
4. Confirm quest titles/descriptions are Japanese while items, JEI, Create UI, and other mod UI remain English.
5. Confirm FTB Quests loads without parse errors and existing quest progress remains intact.

## Proposed repository and delivery

After approval:
- Create a new Git repository under `~/workspace/projects/`.
- Ask Claude Code to perform architecture/design first, then implementation from the approved requirements.
- Run `claude update` before invoking Claude Code.
- Use Claude Code Opus 5 with effort `xhigh` unless changed by the user.
- Require TDD, type checking, linting, unit/integration tests, compiled executable smoke tests, and README usage examples.
- Hermes independently verifies produced files and real CLI output before reporting completion.

## Approval questions

1. Is the proposed model policy acceptable: Haiku/low by default, with automatic Sonnet fallback only for failed, long, or validation-problematic batches?
2. Is v1 scope limited to modern FTB Quests `lang/*.snbt`, with older inline FTB Quests and other quest mods deferred?
3. For a project URL, is selecting the latest stable pack release acceptable, while a file/version URL pins an exact release?
4. Should `--allow-partial` be included in v1, or should output remain all-or-nothing?
5. Preferred project/tool name, if any.

## Non-goals for v1

Unless separately approved:
- Translating mod item/block/UI language files.
- Translating Create Ponder scenes.
- Editing quest topology, tasks, rewards, recipes, or progression.
- Repacking and redistributing the entire modpack.
- Supporting every historical questing mod/format.
- GUI application or web service.
