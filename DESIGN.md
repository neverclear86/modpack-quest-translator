# Modpack Quest Translator — Architecture & Design (v1)

Derived from `REQUIREMENTS.md`. Every decision below is either mandated by that
document or is the *safest minimal v1 behaviour* consistent with it. Decisions
that go beyond a literal requirement are marked **[assumption]** and justified.

Tool name: **`modpack-quest-translator`** (binary `mqt` alias not shipped in v1).
Answer to approval question 5; the requirement document's own example command
already uses this name, so it is adopted verbatim.

---

## 1. Runtime and dependency policy

- **Deno + TypeScript**, as mandated. Verified toolchain: `deno 1.41.1`.
- **Zero third-party runtime dependencies.** Only `https://deno.land/std@0.219.0`
  is used, and only inside tests (`assert`) plus `path`/`fs` helpers.
  - Rationale: `deno compile` must produce a standalone binary; the security
    requirements (Zip Slip, decompression bombs, size caps, deterministic
    packaging) demand full control over archive handling, which off-the-shelf ZIP
    libraries do not give. Deno ships `CompressionStream("deflate-raw")` and
    `DecompressionStream("deflate-raw")` natively, so a purpose-built ZIP
    reader/writer is both feasible and safer than a dependency.
  - Deno 1.41.1 predates JSR, so all remote specifiers are `https://deno.land/std@…`
    pinned in `deno.json` `imports`.

## 2. Layered architecture

```
cli/            argv → Options; orchestration; progress; exit codes
  ├── net/          bounded, HTTPS-only fetch
  ├── resolve/      URL → ResolvedPack (CurseForge | Modrinth | direct)
  ├── archive/      safe ZIP reader, deterministic ZIP writer, override discovery
  ├── quests/       SNBT lexer/parser/serializer + quest-format adapters
  ├── translate/    provider interface, batching, cache, validation, orchestrator
  └── output/       overlay ZIP, manifest, bilingual README, machine report
```

Dependency direction is strictly downward. `quests/`, `translate/` and `output/`
know nothing about HTTP or about Claude Code. `translate/providers/claude-code.ts`
is the only file that knows the `claude` binary exists.

### Ports (interfaces) used for testability

| Port | Purpose | Test double |
| --- | --- | --- |
| `HttpClient` | `fetch`-shaped, bounded | in-memory fixture router |
| `TranslationProvider` | `translateBatch(request) → response` | `echo`/scripted providers |
| `CommandRunner` | `Deno.Command`-shaped spawn | scripted stdout/stderr/code |
| `Clock`/`Sleeper` | backoff timing | instant, recording |

No test touches the network, spawns a real process, or writes outside a
`Deno.makeTempDir()` sandbox.

---

## 3. Pack resolution

### 3.1 URL classification (`resolve/url.ts`)

Pure function `classifyPackUrl(raw) → PackRef`. Only `http:`/`https:` accepted
(security requirement); anything else is `E_INVALID_INPUT`.

| Pattern | Result |
| --- | --- |
| `curseforge.com/minecraft/modpacks/<slug>` | `{kind:"curseforge", slug}` |
| `…/modpacks/<slug>/files/<fileId>` | `{kind:"curseforge", slug, fileId}` |
| `…/modpacks/<slug>/download/<fileId>` | `{kind:"curseforge", slug, fileId}` |
| `curseforge.com/minecraft/mc-mods/<slug>` etc. | rejected: not a modpack |
| `modrinth.com/modpack/<slug>` | `{kind:"modrinth", slug}` |
| `modrinth.com/modpack/<slug>/version/<v>` | `{kind:"modrinth", slug, versionId}` |
| `modrinth.com/mod/<slug>` etc. | rejected: not a modpack |
| any other https URL ending `.zip` / `.mrpack` | `{kind:"direct"}` |
| anything else | rejected with actionable message |

`api.modrinth.com` / `cdn.modrinth.com` / `*.forgecdn.net` direct links are also
accepted as `direct`.

### 3.2 Modrinth resolver

Public API, no credentials. Project URL → `GET /v2/project/{slug}` (must have
`project_type === "modpack"`, else `E_UNSUPPORTED_PACK`) → `GET /v2/project/{slug}/version`.
"Latest stable release" = newest `date_published` among `version_type === "release"`;
falls back to newest overall only when `--allow-prerelease` is passed **[assumption:
requirement says "latest stable"; a pack with no stable release must not silently
translate a beta, so it errors unless the user opts in]**.
File selection prefers `primary === true`, then the first `.mrpack`.

### 3.3 CurseForge resolver

Verified 2026-08-25: `curseforge.com`, `www.curseforge.com/api/v1/*` and
`api.curseforge.com` all return **HTTP 403** without an API key (Cloudflare +
mandatory key). The requirement is explicitly conditional — *"must work without
requiring a CurseForge API key **when the public download endpoint permits it**"* —
and it authorises "Optional API-key support … for restricted cases". Therefore:

1. If `--curseforge-api-key` / `$CURSEFORGE_API_KEY` is set, use `api.curseforge.com`
   (`/v1/mods/search?gameId=432&slug=…&classId=4471`, `/v1/mods/{id}/files`,
   `/v1/mods/{id}/files/{fileId}/download-url`).
2. Otherwise attempt the key-less public endpoints; on 401/403 raise
   `E_UNSUPPORTED_PACK` with an actionable message naming the three supported
   workarounds (set a key, pass the direct `mediafilez.forgecdn.net` URL, or pass
   a local `--archive` file).

The key is read from the environment/flag only, never logged, never persisted,
never written into any output artefact (see §9).

### 3.4 Local archive escape hatch **[assumption]**

`--archive <path>` bypasses resolution entirely and treats a local `.zip`/`.mrpack`
as the source. Justified because (a) the manual acceptance test must remain
runnable while CurseForge is key-gated, and (b) it makes the end-to-end path
testable without network. Metadata then records `sourceUrl: "file:…"`.

---

## 4. Download and archive safety

`net/http.ts` — every request goes through one bounded client:

- HTTPS/HTTP only; scheme re-validated after **each** redirect.
- Max 5 redirects; cross-scheme downgrade https→http refused.
- Per-request timeout (`--timeout`, default 60 s) via `AbortSignal`.
- Response size cap (`--max-download`, default 1 GiB) enforced while streaming,
  independent of any `Content-Length` header.
- Fixed `User-Agent: modpack-quest-translator/<version>`.
- No credentials are ever attached to non-API hosts.

`archive/zip/reader.ts` — reads the **central directory** (never trusts local
headers) and enforces, per requirement §Security:

| Attack | Defence |
| --- | --- |
| Zip Slip (`../`, `..\\`) | path normalised; any `..` segment ⇒ reject |
| Absolute paths (`/etc/x`, `C:\\x`) | rejected |
| Windows drive/UNC prefixes | rejected |
| Symlinks | external-attr Unix mode `S_IFLNK` ⇒ rejected |
| Decompression bomb | per-entry uncompressed cap (64 MiB) + total cap (2 GiB) + max compression ratio 200:1 |
| Entry-count bomb | max 200 000 entries |
| Encrypted entries | GP-flag bit 0 ⇒ rejected |
| Unsupported method | only `stored` (0) and `deflate` (8) |
| NUL/control bytes in names | rejected |

**Nothing from the source archive is ever executed, and nothing is extracted to
disk.** Only the single quest-lang file (and, optionally, chapter files for
context) is decompressed *in memory*. The downloaded archive is opened read-only
and never rewritten — satisfying "never modify the original downloaded archive".

`archive/zip/writer.ts` — deterministic writer: entries sorted by path, fixed
DOS timestamp `1980-01-01T00:00:00`, fixed external attributes (`0644`/`0755`),
no extra fields, no data descriptors, UTF-8 flag set. Byte-identical output for
identical input ⇒ satisfies "deterministic packaging where practical".

### 4.1 Override discovery (`archive/discover.ts`)

Candidate roots, in priority order:

1. `` (instance root — plain overlay/zip)
2. `overrides/` (CurseForge and Modrinth both use this name)
3. `server-overrides/`, `client-overrides/` (Modrinth)

For each root, look for `config/ftbquests/quests/lang/<source>.snbt`. Path
matching is case-insensitive on the *lang file name* only. The archive flavour
(`curseforge` | `modrinth` | `plain`) is detected from `manifest.json` /
`modrinth.index.json` and recorded in the manifest. If several roots contain the
file, `overrides/` wins over `server-overrides/`, and the choice is printed.
If none match ⇒ `E_NO_QUEST_LOCALIZATION` (exit 5) with the list of
`config/ftbquests/**` paths actually seen, so the user can tell "old inline
format" from "no quests at all". Never emit an empty translation.

---

## 5. SNBT

`quests/snbt/` is a self-contained, dependency-free implementation of the
**FTB Quests dialect** of SNBT, grounded on a real modern pack file inspected
during design:

```snbt
{
	chapter.032B1396E6C49A89.title: "Create: Core"
	quest.0000000000002329.quest_desc: [
		"Welcome, Trainer!"
		""
		"The &bCobblemon&r chapter guides you."
	]
	quest.000000000000004B.quest_desc: ["{image:mod:item/x width:100 height:100 align:center}"]
}
```

Dialect facts the implementation must honour:

- Members are separated by **newlines**, not commas (commas are also accepted).
- Keys are **unquoted** and contain dots: `[A-Za-z0-9_.+-]+`; quoted keys accepted.
- Indent is a **tab**; arrays with a single element are written inline
  (`["one line"]`), arrays with 0 or ≥2 elements are written multi-line.
  Round-tripping reproduces this exactly.
- Escapes: `\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f`, `\/`, `\uXXXX`. FTB writes a
  literal `\&` (source bytes `\\&`) to escape the formatting char — this survives
  as a two-character string `\&` and must never be mangled.
- Typed numeric suffixes (`0.0d`, `264534277666289367L`, `1b`, `2s`, `3f`),
  booleans, empty arrays `[ ]`, nested compounds, and typed arrays (`[I;…]`,
  `[B;…]`, `[L;…]`) are all parsed — required because chapter files use them.

The parser produces a lossless-enough AST (`SnbtValue`) that preserves member
order; the serializer is the exact inverse for the constructs above. A
round-trip property test asserts `serialize(parse(x)) === x` for the fixtures.

### 5.1 Quest-format adapters (`quests/adapter.ts`)

```ts
interface QuestFormatAdapter {
  readonly id: string;              // "ftbquests-lang"
  detect(archive: ArchiveView): DetectionResult;
  extract(src: string, ctx): TranslatableDocument;   // ordered units
  apply(src: string, translations: Map<string,string[]>): string;
}
```

v1 registers exactly one adapter, `ftbquests-lang`. `registry.ts` iterates
adapters and reports **unsupported format** rather than emitting an empty file
when none detects — the requirement is explicit about this. Adding
`ftbquests-inline` or another quest mod later means adding one file.

A translation unit is
`{ id, kind, index, text }` where `id` is the SNBT key
(`quest.02B0448DA14595B0.quest_subtitle`), `kind` is its last dot segment
(`title` | `quest_desc` | `quest_subtitle` | …) and `index` is the array element
index (`-1` for a scalar string). `apply()` rebuilds values **by key and index
only**, never by position in the response.

### 5.2 Chapter context enrichment **[assumption, in service of a stated requirement]**

The requirement asks batches to retain "chapter/type context". The lang file
alone has no quest→chapter edge, but `config/ftbquests/quests/chapters/*.snbt`
does (`id`, `filename`, `quests[].id`, `quests[].tasks[].id`,
`quests[].rewards[].id`). When those files are present and parse, the tool builds
`objectId → chapterTitle` and attaches it to each unit; batches are then grouped
by chapter. Failure to parse chapter files is non-fatal (context degrades to
pack name + kind only).

---

## 6. Translation subsystem

### 6.1 Provider interface (`translate/types.ts`)

```ts
interface TranslationProvider {
  readonly id: string;                       // "claude-code" | "echo"
  preflight(): Promise<PreflightReport>;
  translateBatch(req: BatchRequest, opts): Promise<BatchResponse>;
}
```

`BatchRequest` is exactly the shape mandated by the requirements
(`sourceLocale`, `targetLocale`, `context{pack,chapter}`, `glossary`,
`items[{id,kind,text,protectedTokens}]`). `BatchResponse` is
`{ items: {id,text}[], model, usage? , costUsd? }`. Nothing above this layer
references Claude Code types.

### 6.2 Batching (`translate/batcher.ts`)

Deterministic, stable-ordered. A batch is closed when either bound is hit:
`--batch-size` items (default 40) **or** `--batch-chars` characters (default
6000). Units never split across batches. Batches never mix chapters. A single
unit larger than `--batch-chars` becomes its own batch and is pre-flagged
`longProse` so it goes straight to the fallback model (requirement: sonnet for
"unusually long prose").

### 6.3 Cache (`translate/cache.ts`)

Key = `sha256(JSON([sourceText, sourceLocale, targetLocale, providerId, model,
PROMPT_VERSION, glossaryVersion]))` — precisely the fields the requirement lists.
`glossaryVersion` is `sha256` of the sorted glossary (or `"none"`).

Lookup consults the **primary-model namespace first, then the fallback-model
namespace**, so a string rescued by Sonnet is still reused on resume; the entry
records which model produced it. Store is a single JSON file under
`--cache-dir` (default `$XDG_CACHE_HOME/modpack-quest-translator`, else
`~/.cache/…`), rewritten **atomically after every batch** so Ctrl+C can never
corrupt it and resume loses at most one in-flight batch.

### 6.4 Validation (`translate/validate.ts`) — provider independent

Per unit, source vs. translation:

1. Empty/whitespace-only source ⇒ translation must be byte-identical (keeps
   empty strings empty).
2. Multiset of **formatting codes** (`&x`, `§x`, honouring `\&` escapes) equal.
3. Multiset of **placeholders** equal: `%s`/`%d`/`%f`, `%1$s`, `{…}` blocks
   (FTB `{image:…}` etc.), `$(…)`, `<…>` mod variables.
4. Escaped-token preservation: every literal `\&` in the source appears the same
   number of times.
5. Non-empty source ⇒ non-empty translation.
6. Response-level: every requested id present exactly once; no unknown ids; no
   duplicates. (Requirement: "duplicate/missing/unknown IDs fail validation".)

Document-level, after `apply()`:

7. Output re-parses as SNBT.
8. Key set **exactly** equal to source key set.
9. Value shapes compatible: string↔string, array↔array of identical length.

Failures are per-batch and drive retry/fallback; a failure that survives all
attempts fails the run without writing an installable archive (§7).

### 6.5 Orchestrator (`translate/orchestrator.ts`)

```
for each batch:
  cache lookup (primary ns, then fallback ns) → hits removed from the request
  if nothing left → mark "cached"
  attempt 1: primary model  (--model, default haiku, --effort low)
  on transient error → bounded exponential backoff (3 attempts, 500 ms × 2ⁿ, capped 8 s)
  on validation failure → attempt 2: primary model, repaired prompt
                        → attempt 3: fallback model (--fallback-model, default sonnet)
  still failing → record failed unit ids; run fails at the end (atomic policy)
```

Only failed/malformed batches are retried — never the whole run. Concurrency is
bounded by `--concurrency` (default 2, hard max 8). Quality presets:
`--quality fast` (haiku only), `--quality balanced` (default), `--quality best`
(sonnet primary, opus fallback). The model that actually produced each batch is
recorded in the cache entry and in the report.

**Failure policy:** atomic, as approved-by-default in the requirements.
`--allow-partial` is **not** implemented in v1 (answer to approval question 4:
the requirement says "should not be enabled by default in v1 unless explicitly
approved", and no approval is recorded), but the report already carries a
`failed` bucket so adding it later is additive.

### 6.6 Claude Code adapter (`translate/providers/claude-code.ts`)

Spawned with `Deno.Command` — **argv array only, never a shell, never string
interpolation of pack text**. Verified against `claude 2.1.241`.

```
claude -p
  --output-format json
  --json-schema <schema>          # {items:[{id,text}]}, additionalProperties:false
  --model <model> --effort <effort>
  --tools ""                      # all built-in tools disabled
  --no-session-persistence
  --disable-slash-commands
  --system-prompt <translation system prompt>
  [--max-turns <n>]               # only if `claude --help` advertises it
  [--max-budget-usd <n>]          # only when --max-cost-usd is given
```

- The batch JSON goes in on **stdin**; stdin is closed after write.
- `--system-prompt` replaces Claude Code's default system prompt. Measured
  effect on a probe batch: input tokens 7 161 → 1 054, cost 0.0159 → 0.0039 USD.
- `--max-turns` is absent from CLI 2.1.241; the adapter probes `claude --help`
  once and includes the flag only when supported. With `--tools ""` a single
  turn is structurally guaranteed regardless.
- Timeout via `AbortSignal.timeout`; on expiry the child is killed
  (`SIGTERM`, then `SIGKILL`) and the batch is treated as a transient error.
- Response parsing reads `structured_output` (verified present), falling back to
  `JSON.parse(result)`. **Prose is never scraped**; a response that yields
  neither is a batch failure. `is_error`/`subtype !== "success"` ⇒ failure, and
  the message is classified transient (rate limit, overloaded, 429/5xx, timeout)
  vs. fatal (not logged in, unknown model, invalid schema).
- Preflight: `claude --version` (reported), then `claude auth status --json`.
  Only `loggedIn`, `authMethod`, `subscriptionType` are read; the returned
  `email`/`orgId` are **discarded immediately** and never logged or stored.
  `claude update` is never invoked.

`translate/providers/echo.ts` is a deterministic in-process provider used by
`--provider echo` (and by tests) that returns `[locale] text` while preserving
placeholders — it makes the full pipeline runnable offline with zero cost.

---

## 7. Output

`--output` is deterministic:

- Ends with `.zip` ⇒ that exact path is the archive; sidecars sit beside it as
  `<base>.manifest.json`, `<base>.report.json`, `<base>.README.md`,
  and `<base>.<locale>.snbt` with `--emit-raw`.
- Otherwise ⇒ treated as a **directory** (created if absent); the archive is
  named `<slug>-<packVersion>-<targetLocale>[-en_us-override].zip`, embedding the
  exact compatible pack version as required.

Existing files are **never silently overwritten** — that is `E_WRITE` (exit 8)
unless `--force` is given. This is how "running against a newer pack release
creates a new output rather than overwriting" is enforced.

Archive layout (`--layout`, default `auto`):

| Mode | Entry |
| --- | --- |
| `instance` (what `auto` chooses) | `config/ftbquests/quests/lang/<out>.snbt` |
| `overrides` | `overrides/config/ftbquests/quests/lang/<out>.snbt` |
| `both` | both of the above |

**[assumption]** `auto` = `instance`. An overlay ZIP containing only
`overrides/` and no `manifest.json`/`modrinth.index.json` is not importable by
any launcher, so the `overrides/` wrapper is only useful to someone re-building
a pack; the instance-root layout is what the generated README instructs users to
extract. `--layout` covers the other cases explicitly.

`<out>` is `en_us` with `--override-en-us`, otherwise the resolved target locale.

Every archive also contains `README.md` (bilingual JA/EN),
`translation-manifest.json`, and `translation-report.json`. It contains **no**
mod JARs, no other pack assets, and no credentials.

The README is generated, not templated by hand, and states — in both languages —
whether to extract into the instance root, import, or install server-side, plus
the multiplayer consequences the requirements enumerate (replacing `en_us.snbt`
server-side affects every player whose locale resolves to `en_us`; `en_gb.snbt`
as a per-player opt-in; single-player scope), and the detected FTB Quests
evidence the advice is based on.

`translation-manifest.json`: source URL, resolved pack/version/MC version/loader,
`sourceArchiveSha256`, source & target locale, override mode, provider id, model
(and fallback model actually used), generation time, tool version, key counts.

`translation-report.json`: per-key buckets `translated` / `cached` / `skipped` /
`failed` / `fallback`, plus the update diff (`added`/`changed`/`removed`/`reused`)
against `--previous`, plus optional usage/cost totals when Claude Code reports
them.

All final files are written **atomically** (temp file in the destination
directory → `fsync` → `rename`).

### 7.1 Update behaviour

`--previous <manifest-or-cache>` loads a prior run's key→sourceText map. Keys are
classified `added` / `changed` / `removed` / `reused`; reused keys with a valid
cache entry are not re-translated. The report contains all four buckets.

---

## 8. CLI

```
modpack-quest-translator --url <u> --target <t> [--override-en-us] --output <p>
```

Mandatory: `--url` (or `--archive`), `--target`, `--output`.
`--override-english <true|false>` is accepted as the requirement's literal
spelling; `--override-en-us` is the boolean alias.

Aliases `-u`, `-t`, `-o` as proposed. Other flags: `--source-locale`,
`--layout`, `--glossary`, `--provider`, `--model`, `--fallback-model`,
`--quality`, `--effort`, `--batch-size`, `--batch-chars`, `--concurrency`,
`--retries`, `--timeout`, `--max-download`, `--max-cost-usd`, `--cache-dir`,
`--no-cache`, `--previous`, `--emit-raw`, `--force`, `--dry-run`,
`--allow-prerelease`, `--curseforge-api-key`, `--json`, `--quiet`, `--verbose`,
`--no-color`, `--version`, `--help`.

Unknown flags are a usage error (exit 2) — never silently ignored.

**Target resolution** (`locale.ts`): accepts `ja_jp`, `ja-JP`, `ja`, `Japanese`,
`日本語`; normalises to Minecraft locale form and prints the resolution before
work starts. Unknown language names are rejected with the closest matches listed.

**Stages** printed in order: `resolve → download → inspect → parse → translate →
validate → package`. `--json` emits one NDJSON event per stage on stdout (so it
is machine-consumable and never interleaved with prose); `--quiet` prints only
errors. No telemetry, ever.

**Cancellation:** a `SIGINT` handler flips an `AbortSignal`; in-flight subprocess
batches are killed, the cache is already durable (§6.3), no partial ZIP exists
because packaging is the last step and atomic. Exit code 130.

### Exit codes

| Code | Symbol | Meaning |
| --- | --- | --- |
| 0 | — | success |
| 1 | `E_INTERNAL` | unexpected error |
| 2 | `E_INVALID_INPUT` | bad usage/flags/URL/locale |
| 3 | `E_UNSUPPORTED_PACK` | not a modpack, unresolvable, key-gated |
| 4 | `E_DOWNLOAD` | network/archive fetch failure |
| 5 | `E_NO_QUEST_LOCALIZATION` | no modern FTB Quests lang file found |
| 6 | `E_TRANSLATION` | provider failed after retries |
| 7 | `E_VALIDATION` | output failed key/shape/placeholder validation |
| 8 | `E_WRITE` | packaging/write failure, refusing to overwrite |
| 9 | `E_PREFLIGHT` | `claude` missing, logged out, or unusable |
| 130 | `E_CANCELLED` | interrupted |

---

## 9. Secret and PII hygiene

`util/redact.ts` runs over **every** message that reaches a log, an error, the
report, the manifest, or the README:

- Known secret-bearing values (CurseForge API key, `ANTHROPIC_API_KEY`,
  `CLAUDE_CODE_OAUTH_TOKEN`) are registered at startup and replaced with
  `«redacted»` by exact substring match.
- Regex classes: `sk-ant-…`, `sk-…`, bearer tokens, `?api_key=`/`?token=`
  query parameters, and email addresses.
- The Claude Code preflight discards `email`/`orgId` before the auth result ever
  leaves the adapter.
- Environment variables are **never** dumped; the manifest records provider and
  model names only.

A dedicated test asserts that a run performed with secrets present in the
environment and in the pack text leaks nothing into the ZIP, the manifest, the
report, stdout, or stderr.

---

## 10. Test strategy

Strict vertical-slice TDD: one failing test → minimal implementation → green →
refactor, per slice, in this order:

1. errors/exit codes 2. locale resolution 3. URL classification 4. bounded HTTP
5. ZIP reader + attack corpus 6. deterministic ZIP writer 7. override discovery
8. SNBT round-trip 9. FTB lang adapter 10. batching 11. validation 12. cache
13. Claude adapter (scripted `CommandRunner`) 14. orchestrator retry/fallback
15. Modrinth/CurseForge resolvers (fixture HTTP) 16. packaging/manifest/README/report
17. CLI arg parsing 18. end-to-end fixture 19. compiled-binary smoke test.

Fixtures are hand-authored to mirror the real pack structure inspected during
design (multi-line arrays, `&`-codes, `\&` escapes, `{image:…}` placeholders,
Unicode, empty strings, typed numerics in chapter files). ZIP attack fixtures are
built byte-by-byte by a test helper, not committed as binaries.

Acceptance gates: `deno fmt --check`, `deno lint`, `deno check`, `deno test -A`,
and a `deno compile`d binary smoke test that runs a full offline end-to-end
translation with `--provider echo` and verifies the emitted archive.

---

## 11. Explicit v1 non-goals

As listed in the requirements: no mod language files, no Ponder scenes, no quest
topology edits, no whole-pack repacking, no historical quest formats, no GUI.
Additionally not in v1: `--allow-partial` (§6.5) and translation-memory fuzzy
matching.
