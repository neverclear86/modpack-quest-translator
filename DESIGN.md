# Modpack Quest Translator — Architecture & Design (v1)

Derived from `REQUIREMENTS.md`. Every decision below is either mandated by that document or is the
_safest minimal v1 behaviour_ consistent with it. Decisions that go beyond a literal requirement are
marked **[assumption]** and justified.

Tool name: **`modpack-quest-translator`** (binary `mqt` alias not shipped in v1). Answer to approval
question 5; the requirement document's own example command already uses this name, so it is adopted
verbatim.

---

## 1. Runtime and dependency policy

- **Deno + TypeScript**, as mandated. **Deno 2 only**: fmt, lint, check, the full suite, both
  compiled binaries and the packaged installer bundle are verified on `deno 2.9.5`. Deno 1 is not
  supported and not tested, and the feature-detection branches that used to keep one source tree
  compiling on both majors have been deleted -- `FsFile.sync` and `AbortSignal.any` are called
  directly. Deno 2's TypeScript makes `Uint8Array` generic over its backing store, so it no longer
  satisfies `BufferSource` or `BlobPart`; `util/bytes.ts` holds the single cast that reconciles
  them.
- **Zero third-party runtime dependencies.** Only `https://deno.land/std@0.219.0` is used, and only
  inside tests (`assert`) plus `path`/`fs` helpers.
  - Rationale: `deno compile` must produce a standalone binary; the security requirements (Zip Slip,
    decompression bombs, size caps, deterministic packaging) demand full control over archive
    handling, which off-the-shelf ZIP libraries do not give. Deno ships
    `CompressionStream("deflate-raw")` and `DecompressionStream("deflate-raw")` natively, so a
    purpose-built ZIP reader/writer is both feasible and safer than a dependency.
  - All remote specifiers are `https://deno.land/std@…` pinned in `deno.json` `imports`.

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

Dependency direction is strictly downward. `quests/`, `translate/` and `output/` know nothing about
HTTP or about Claude Code. `translate/providers/claude-code.ts` is the only file that knows the
`claude` binary exists.

### Ports (interfaces) used for testability

| Port                  | Purpose                              | Test double                 |
| --------------------- | ------------------------------------ | --------------------------- |
| `HttpClient`          | `fetch`-shaped, bounded              | in-memory fixture router    |
| `TranslationProvider` | `translateBatch(request) → response` | `echo`/scripted providers   |
| `CommandRunner`       | `Deno.Command`-shaped spawn          | scripted stdout/stderr/code |
| `Clock`/`Sleeper`     | backoff timing                       | instant, recording          |

No test touches the network, spawns a real process, or writes outside a `Deno.makeTempDir()`
sandbox.

---

## 3. Pack resolution

### 3.1 URL classification (`resolve/url.ts`)

Pure function `classifyPackUrl(raw) → PackRef`. Only `http:`/`https:` accepted (security
requirement); anything else is `E_INVALID_INPUT`.

| Pattern                                        | Result                               |
| ---------------------------------------------- | ------------------------------------ |
| `curseforge.com/minecraft/modpacks/<slug>`     | `{kind:"curseforge", slug}`          |
| `…/modpacks/<slug>/files/<fileId>`             | `{kind:"curseforge", slug, fileId}`  |
| `…/modpacks/<slug>/download/<fileId>`          | `{kind:"curseforge", slug, fileId}`  |
| `curseforge.com/minecraft/mc-mods/<slug>` etc. | rejected: not a modpack              |
| `modrinth.com/modpack/<slug>`                  | `{kind:"modrinth", slug}`            |
| `modrinth.com/modpack/<slug>/version/<v>`      | `{kind:"modrinth", slug, versionId}` |
| `modrinth.com/mod/<slug>` etc.                 | rejected: not a modpack              |
| any other https URL ending `.zip` / `.mrpack`  | `{kind:"direct"}`                    |
| anything else                                  | rejected with actionable message     |

`api.modrinth.com` / `cdn.modrinth.com` / `*.forgecdn.net` direct links are also accepted as
`direct`.

### 3.2 Modrinth resolver

Public API, no credentials. Project URL → `GET /v2/project/{slug}` (must have
`project_type === "modpack"`, else `E_UNSUPPORTED_PACK`) → `GET /v2/project/{slug}/version`. "Latest
stable release" = newest `date_published` among `version_type === "release"`; falls back to newest
overall only when `--allow-prerelease` is passed **[assumption: requirement says "latest stable"; a
pack with no stable release must not silently translate a beta, so it errors unless the user opts
in]**. File selection prefers `primary === true`, then the first `.mrpack`.

### 3.3 CurseForge resolver

Verified 2026-08-25: `curseforge.com`, `www.curseforge.com/api/v1/*` and `api.curseforge.com` all
return **HTTP 403** without an API key (Cloudflare + mandatory key). The requirement is explicitly
conditional — _"must work without requiring a CurseForge API key **when the public download endpoint
permits it**"_ — and it authorises "Optional API-key support … for restricted cases". Therefore:

1. If `--curseforge-api-key` / `$CURSEFORGE_API_KEY` is set, use `api.curseforge.com`
   (`/v1/mods/search?gameId=432&slug=…&classId=4471`, `/v1/mods/{id}/files`,
   `/v1/mods/{id}/files/{fileId}/download-url`).
2. Otherwise attempt the key-less public endpoints; on 401/403 raise `E_UNSUPPORTED_PACK` with an
   actionable message naming the three supported workarounds (set a key, pass the direct
   `mediafilez.forgecdn.net` URL, or pass a local `--archive` file).

The key is read from the environment/flag only, never logged, never persisted, never written into
any output artefact (see §9).

### 3.4 Local archive escape hatch **[assumption]**

`--archive <path>` bypasses resolution entirely and treats a local `.zip`/`.mrpack` as the source.
Justified because (a) the manual acceptance test must remain runnable while CurseForge is key-gated,
and (b) it makes the end-to-end path testable without network. Metadata then records
`sourceUrl: "file:…"`.

---

## 4. Download and archive safety

`net/http.ts` — every request goes through one bounded client:

- HTTPS/HTTP only; scheme re-validated after **each** redirect.
- Max 5 redirects; cross-scheme downgrade https→http refused.
- Per-request timeout (`--timeout`, default 60 s) via `AbortSignal`.
- Response size cap (`--max-download`, default 1 GiB) enforced while streaming, independent of any
  `Content-Length` header. The flag itself is bounded to a finite, safe integer no greater than 16
  GiB: every other limit is derived from it — the `--lang-jar` cap, and the ZIP reader's
  total-inflation cap at four times it — so a value that overflowed to `Infinity` would not permit a
  large download, it would switch those defences off.
- Fixed `User-Agent: modpack-quest-translator/<version>`.
- No credentials are ever attached to non-API hosts.

`archive/zip/reader.ts` — reads the **central directory** (never trusts local headers) and enforces,
per requirement §Security:

| Attack                             | Defence                                                                               |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| Zip Slip (`../`, `..\\`)           | path normalised; any `..` segment ⇒ reject                                            |
| Absolute paths (`/etc/x`, `C:\\x`) | rejected                                                                              |
| Windows drive/UNC prefixes         | rejected                                                                              |
| Symlinks                           | external-attr Unix mode `S_IFLNK` ⇒ rejected                                          |
| Decompression bomb                 | per-entry uncompressed cap (64 MiB) + total cap (2 GiB) + max compression ratio 200:1 |
| Entry-count bomb                   | max 200 000 entries                                                                   |
| Encrypted entries                  | GP-flag bit 0 ⇒ rejected                                                              |
| Unsupported method                 | only `stored` (0) and `deflate` (8)                                                   |
| NUL/control bytes in names         | rejected                                                                              |

**Nothing from the source archive is ever executed, and nothing is extracted to disk.** Only the
single quest-lang file (and, optionally, chapter files for context) is decompressed _in memory_. The
downloaded archive is opened read-only and never rewritten — satisfying "never modify the original
downloaded archive".

The ratio rule needs that floor. Highly repetitive text legitimately compresses several hundred to
one — 100 KiB of a single repeated character deflates about 820:1 — so a low threshold with no floor
rejects real quest files. The absolute per-entry and total caps are the real bound; the ratio check
only catches a bomb earlier and more cheaply. Inflation is additionally capped against _actual_
output bytes, so a central directory that understates a size cannot bomb us.

`archive/zip/writer.ts` — deterministic writer: entries sorted by path, fixed DOS timestamp
`1980-01-01T00:00:00`, fixed external attributes (`0644`/`0755`), no extra fields, no data
descriptors, UTF-8 flag set. Byte-identical output for identical input ⇒ satisfies "deterministic
packaging where practical".

### 4.1 Override discovery (`archive/discover.ts`)

Candidate roots, in priority order:

1. `` (instance root — plain overlay/zip)
2. `overrides/` (CurseForge and Modrinth both use this name)
3. `server-overrides/`, `client-overrides/` (Modrinth)

For each root, look for `config/ftbquests/quests/lang/<source>.snbt`. Path matching is
case-insensitive on the _lang file name_ only. The archive flavour (`curseforge` | `modrinth` |
`plain`) is detected from `manifest.json` / `modrinth.index.json` and recorded in the manifest. If
several roots contain the file, `overrides/` wins over `server-overrides/`, and the choice is
printed. If none match ⇒ `E_NO_QUEST_LOCALIZATION` (exit 5) with the list of `config/ftbquests/**`
paths actually seen, so the user can tell "old inline format" from "no quests at all". Never emit an
empty translation.

That error now distinguishes a third case. A bounded sample of the pack's quest files is scanned for
`{translation.key}` placeholders; when they are present the hint names the keys it saw and says to
re-run with `--lang-jar`, because such a pack is neither broken nor too old — its strings live in a
mod. See §4.2.

### 4.2 Translation-key packs and the language jar (`archive/lang_jar.ts`)

Some packs store no quest prose at all: every visible string is a Minecraft translation key, and the
English text ships inside a mod's `assets/<namespace>/lang/<locale>.json`. DeceasedCraft 5.10.17 is
the worked example — 30 chapter files, `{quest.guide.survival.fiber.title}` throughout, and no
`config/ftbquests/quests/lang/en_us.snbt` anywhere.

`--lang-jar <path>` selects this mode. **The flag is the mode switch, never a guess about the
pack**: a pack that ships both an SNBT lang file and placeholder chapters gets whichever the user
asked for, and mode selection stays a decision the user can read off their own command line.

Discovery is three steps, each failing with something actionable:

1. **Find the quest files.** The first root carrying `config/ftbquests/quests/**` wins; every
   `.snbt` under it is read (chapters, `chapter_groups.snbt`, reward tables), except the pack's own
   `lang/` directory, which is not a source of references.
2. **Read the references** (`quests/references.ts`). Each file is _parsed_, not text-scanned, and
   every string value is searched for `{a.b.c}`-shaped placeholders. The pattern is deliberately
   narrow — lowercase-initial, at least one dot, no colon, no space — because the same braces carry
   FTB's own markup: `{image:mod:tex.png width:100}` and `{item:minecraft:apple}` have a colon,
   `{player}` has no dot. The same walk records **literal labels**: strings under a `title`,
   `subtitle` or `description` member that still contain a letter once placeholders and formatting
   codes are stripped. Files that fail to parse — or that could not be inflated out of the archive
   at all — are reported, not silently dropped: their references are unknown rather than absent. No
   placeholders anywhere ⇒ `E_NO_QUEST_LOCALIZATION` telling the user to drop `--lang-jar`. The file
   count is bounded at 500, and a pack above it is **refused**, not truncated: every translated key
   comes from one of these files, so reading a prefix would ship a resource pack with quest text
   missing and no way to tell.
3. **Pick the namespace.** Every top-level `assets/<ns>/lang/<source>.json` in the jar is read (the
   nested `assets/…/assets/…` trees real jars contain are not namespaces and are skipped), and a
   namespace is a **candidate only if it defines keys the quest files reference**. Naming is not
   evidence; coverage is. A key counts as defined by **membership, not value type**: a referenced
   key whose value is not a string is a key the jar defines and this tool refuses (§6), never a key
   it is missing and may skip.

The selection rule, in full:

| Situation                                | Result                                                |
| ---------------------------------------- | ----------------------------------------------------- |
| exactly one candidate matches            | chosen                                                |
| several match, one **subsumes** the rest | chosen; others reported as alternates                 |
| several match, none subsumes             | `E_INVALID_INPUT` naming each and its match count     |
| none matches                             | `E_NO_QUEST_LOCALIZATION` listing the namespaces      |
| every lang file failed to load           | `E_INVALID_INPUT` naming each file and what is wrong  |
| more than 64 candidate namespaces        | `E_INVALID_INPUT`; pass `--lang-namespace`            |
| `--lang-namespace <ns>`                  | that one file is read and validated; no limit applies |

"Subsumes" means the winner defines every key the loser does, and strictly more — then there is
nothing to choose between, so choosing is not a guess. **[assumption]** Anything else is genuinely
ambiguous and is refused rather than resolved by a heuristic, per the requirement to reject
ambiguity with a useful error.

`--lang-namespace <ns>` overrides the whole rule, and overrides it **first**: it names one file, so
exactly one file is looked for, parsed and validated. The 64-namespace limit is a property of
guessing, so the flag that answers it is never measured against it — and a named file that is
malformed, array-shaped or empty fails with that reason and that path, rather than being dropped and
reported as absent. A jar whose language files are all unloadable is likewise a different error from
a jar that ships none.

On the real inputs this resolves without ceremony: `DCTweaks_5.10.14.jar` ships
`assets/deceasedcraft/lang/en_us.json` (2 735 keys, 1 183 of them referenced) and
`assets/hordes/lang/en_us.json` (27 keys, none referenced), so exactly one candidate matches.

**The jar is data.** It is opened by the same bounded reader as a modpack, so §4's whole table
applies to it; only language entries are ever read; nothing is extracted to disk and nothing is
executed. Neither the jar nor the modpack is modified or redistributed.

Its size is checked against `--max-download` **twice**: once against the `stat`, so an oversized jar
is refused before it is read at all, and again against `bytes.byteLength` afterwards. The `stat` is
a claim about a file that could have been replaced or extended in the meantime, or that never
reported its size honestly to begin with; what was actually read is the only number the cap can be
applied to without trusting the thing it is bounding.

---

## 5. SNBT

`quests/snbt/` is a self-contained, dependency-free implementation of the **FTB Quests dialect** of
SNBT, grounded on a real modern pack file inspected during design:

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
- Indent is a **tab**; arrays with a single element are written inline (`["one line"]`), arrays with
  0 or ≥2 elements are written multi-line. Round-tripping reproduces this exactly.
- Escapes: `\"`, `\\`, `\n`, `\r`, `\t`, `\b`, `\f`, `\/`, `\uXXXX`. FTB writes a literal `\&`
  (source bytes `\\&`) to escape the formatting char — this survives as a two-character string `\&`
  and must never be mangled.
- Typed numeric suffixes (`0.0d`, `264534277666289367L`, `1b`, `2s`, `3f`), booleans, empty arrays
  `[ ]`, nested compounds, and typed arrays (`[I;…]`, `[B;…]`, `[L;…]`) are all parsed — required
  because chapter files use them.

The parser produces a lossless-enough AST (`SnbtValue`) that preserves member order; the serializer
is the exact inverse for the constructs above. A round-trip property test asserts
`serialize(parse(x)) === x` for the fixtures.

### 5.1 Quest-format adapters (`quests/adapter.ts`)

```ts
interface QuestFormatAdapter {
  readonly id: string; // "ftbquests-lang" | "minecraft-lang-json"
  readonly payloadExtension: string; // "snbt" | "json"
  detect(source: string): DetectionResult;
  extract(source: string, context?: ExtractContext): TranslatableDocument; // ordered units
  apply(source: string, translations: ReadonlyMap<string, string>, context?): string;
  shapes(source: string, context?): Map<string, ValueShape>; // for §6.4 document validation
}
```

Two adapters are registered:

| id                    | source                                        | payload |
| --------------------- | --------------------------------------------- | ------- |
| `ftbquests-lang`      | `config/ftbquests/quests/lang/*.snbt`         | `snbt`  |
| `minecraft-lang-json` | `assets/<ns>/lang/<locale>.json` in a mod jar | `json`  |

`registry.ts` lists them in priority order and reports **unsupported format** rather than emitting
an empty file when none detects — the requirement is explicit about this. `selectAdapter` is only
ever handed a pack's own quest localization file, so an SNBT lang file keeps resolving to the SNBT
adapter; the JSON adapter is normally chosen explicitly, by a caller that has a `--lang-jar` and a
namespace. Adding `ftbquests-inline` or another quest mod later still means adding one file.

`ExtractContext.keys` is the one piece of knowledge the document does not carry: a mod's
`en_us.json` holds item names and GUI labels beside the quest prose, and only the quest files know
which keys are actually used. Passing the selection in keeps the adapter a pure function of
(document, selection) and keeps the "which keys?" policy with the caller that can see the pack. The
SNBT adapter ignores it — there, the file _is_ the selection.

`shapes()` exists so whole-document validation is written once. The adapter answers "key → value
shape"; `validateDocumentWith` compares two such maps and produces the same
`missing-key`/`extra-key`/`value-type`/`array-length` problems whether the container was an SNBT
compound or a JSON object. `validateDocument(source, output)` remains as the SNBT-specific
convenience its callers and tests already use.

For the JSON adapter a unit's `kind` is the key's last dot segment with any `_<n>` suffix removed,
so `quest.guide.fiber.description_1` reports as a `description` — the useful thing to tell a
provider, rather than a kind per line number. Referenced keys whose value is not a string are
refused (`E_INVALID_INPUT`), because a value the game itself could not render must not be guessed
at; unreferenced non-strings are simply not ours to judge.

A translation unit is `{ id, kind, index, text }` where `id` is the SNBT key
(`quest.02B0448DA14595B0.quest_subtitle`), `kind` is its last dot segment (`title` | `quest_desc` |
`quest_subtitle` | …) and `index` is the array element index (`-1` for a scalar string). `apply()`
rebuilds values **by key and index only**, never by position in the response.

### 5.2 Chapter context enrichment **[assumption, in service of a stated requirement]**

The requirement asks batches to retain "chapter/type context". The lang file alone has no
quest→chapter edge, but `config/ftbquests/quests/chapters/*.snbt` does (`id`, `filename`,
`quests[].id`, `quests[].tasks[].id`, `quests[].rewards[].id`). When those files are present and
parse, the tool builds `objectId → chapterTitle` and attaches it to each unit; batches are then
grouped by chapter. Failure to parse chapter files is non-fatal (context degrades to pack name +
kind only).

In JSON mode there are no object ids to join on — but the file a key was **referenced from** is its
chapter, which is strictly better evidence. The reference scan already records `key → file` and
`file → its own title`, and that title is usually itself a placeholder, so it is resolved through
the same lang strings before use. On DeceasedCraft this gives chapter context for 1 183 of 1 183
strings, which is what keeps the run at 46 batches instead of hundreds (§6.2).

---

## 6. Translation subsystem

### 6.1 Provider interface (`translate/types.ts`)

```ts
interface TranslationProvider {
  readonly id: string; // "claude-code" | "echo"
  preflight(): Promise<PreflightReport>;
  translateBatch(req: BatchRequest, opts): Promise<BatchResponse>;
}
```

`BatchRequest` is exactly the shape mandated by the requirements (`sourceLocale`, `targetLocale`,
`context{pack,chapter}`, `glossary`, `items[{id,kind,text,protectedTokens}]`). `BatchResponse` is
`{ items: {id,text}[], model, usage? , costUsd? }`. Nothing above this layer references Claude Code
types.

### 6.2 Batching (`translate/batcher.ts`)

Deterministic, stable-ordered. Units are **grouped by chapter first** (chapters in first-seen order,
source order preserved inside each), then each chapter's units are chunked: a batch closes when
either bound is hit, `--batch-size` items (default 40) **or** `--batch-chars` characters (default
6000). Grouping first is load-bearing, not cosmetic — SNBT id order interleaves chapters, so closing
a batch on every chapter _change_ degenerates to roughly one batch per string (measured on All of
Create: Aeronautics v2.4: 1030 strings produced **593** batches that way, **39** when grouped).
Units never split across batches and batches never mix chapters. A single unit larger than
`--batch-chars` becomes its own batch and is pre-flagged `longProse` so it goes straight to the
fallback model (requirement: sonnet for "unusually long prose").

### 6.3 Cache (`translate/cache.ts`)

Key =
`sha256(JSON([sourceText, sourceLocale, targetLocale, providerId, model, PROMPT_VERSION, glossaryVersion]))`
— precisely the fields the requirement lists. `glossaryVersion` is `sha256` of the sorted glossary
(or `"none"`).

Lookup consults the **primary-model namespace first, then the fallback-model namespace**, so a
string rescued by Sonnet is still reused on resume; the entry records which model produced it. Store
is a single JSON file under `--cache-dir` (default `$XDG_CACHE_HOME/modpack-quest-translator`, else
`~/.cache/…`), rewritten **atomically after every batch** so Ctrl+C can never corrupt it and resume
loses at most one in-flight batch.

### 6.4 Validation (`translate/validate.ts`) — provider independent

Per unit, source vs. translation:

1. Empty/whitespace-only source ⇒ translation must be byte-identical (keeps empty strings empty).
2. Multiset of **formatting codes** (`&x`, `§x`, honouring `\&` escapes) equal.
3. Multiset of **placeholders** equal. printf/`java.util.Formatter` conversions are matched as whole
   specifications — `%[argument_index$ | <][flags][width][.precision]conversion`, so `%02d`,
   `%1$.2f`, `%<s`, `%u` and `%%` each count as one token and cannot come back subtly rewritten as
   `%2d` or `%1$.0f`. Also `{…}` blocks (FTB `{image:…}` etc.), `$(…)`, `<…>` mod variables. The
   space flag (`% d`) is deliberately not recognised: it collides with ordinary prose ("50%
   stronger") and a false positive here hard-fails an atomic run. One detector in `quests/tokens.ts`
   serves both this check and the "is there any prose here to translate?" test, so the two cannot
   disagree.
4. Escaped-token preservation: every literal `\&` in the source appears the same number of times.
5. **Line breaks** identical as an ordered sequence, not merely in count — a three-line quest
   description may not come back as one reflowed paragraph, and a CRLF may not quietly become an LF.
6. Non-empty source ⇒ non-empty translation.
7. Response-level: every requested id present exactly once; no unknown ids; no duplicates.
   (Requirement: "duplicate/missing/unknown IDs fail validation".)

Document-level, after `apply()`:

8. Output re-parses as SNBT.
9. Key set **exactly** equal to source key set.
10. Value shapes compatible: string↔string, array↔array of identical length.

Failures are per-batch and drive retry/fallback; a failure that survives all attempts fails the run
without writing an installable archive (§7).

### 6.5 Orchestrator (`translate/orchestrator.ts`)

```
for each batch:
  cache lookup (primary ns, then fallback ns), each candidate re-validated
      against the current unit and glossary → a failure is a miss, and the
      untrusted entry is deleted rather than re-offered next run
  hits removed from the request; if nothing left → mark "cached"
  attempt 1: primary model  (--model, default haiku, --effort low)
  on transient error → bounded exponential backoff (3 attempts, 500 ms × 2ⁿ, capped 8 s)
                     → budget exhausted: fail the batch, do NOT escalate the model
  on validation failure → attempt 2: primary model, repaired prompt
                        → attempt 3: fallback model (--fallback-model, default sonnet)
  still failing → record failed unit ids; run fails at the end (atomic policy)
```

Transient exhaustion deliberately does **not** advance the model plan. A rate limit or an outage
cannot be fixed by a bigger model, and letting each plan step spend its own retry budget cost 3× the
calls (12 provider invocations) burning the user's quota on a provider that is simply down. Model
escalation is reserved for validation failures, where a stronger model genuinely can help.

Identical source strings are deduplicated before batching, so a quest line repeated across the pack
is translated once and fanned back out by id.

Only failed/malformed batches are retried — never the whole run. Concurrency is bounded by
`--concurrency` (default 2, hard max 8). Quality presets: `--quality fast` (haiku only),
`--quality balanced` (default), `--quality best` (sonnet primary, opus fallback). The model that
actually produced each batch is recorded in the cache entry and in the report.

**Failure policy:** atomic, as approved-by-default in the requirements. `--allow-partial` is **not**
implemented in v1 (answer to approval question 4: the requirement says "should not be enabled by
default in v1 unless explicitly approved", and no approval is recorded), but the report already
carries a `failed` bucket so adding it later is additive.

### 6.6 Claude Code adapter (`translate/providers/claude-code.ts`)

Spawned with `Deno.Command` — **argv array only, never a shell, never string interpolation of pack
text**. Verified against `claude 2.1.241`.

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
- `--system-prompt` replaces Claude Code's default system prompt. Measured effect on a probe batch:
  input tokens 7 161 → 1 054, cost 0.0159 → 0.0039 USD.
- `--max-turns` is absent from CLI 2.1.241; the adapter probes `claude --help` once and includes the
  flag only when supported. With `--tools ""` a single turn is structurally guaranteed regardless.
- Timeout via `AbortSignal.timeout`; on expiry the child is killed (`SIGTERM`, then `SIGKILL`) and
  the batch is treated as a transient error.
- Response parsing reads `structured_output` (verified present), falling back to
  `JSON.parse(result)`. **Prose is never scraped**; a response that yields neither is a batch
  failure. `is_error`/`subtype !== "success"` ⇒ failure, and the message is classified transient
  (rate limit, overloaded, 429/5xx, timeout) vs. fatal (not logged in, unknown model, invalid
  schema).
- Preflight: `claude --version` (reported), then `claude auth status --json`. Only `loggedIn`,
  `authMethod`, `subscriptionType` are read; the returned `email`/`orgId` are **discarded
  immediately** and never logged or stored. `claude update` is never invoked.

`translate/providers/echo.ts` is a deterministic in-process provider used by `--provider echo` (and
by tests) that returns `[locale] text` while preserving placeholders — it makes the full pipeline
runnable offline with zero cost.

---

## 7. Output

`--output` is deterministic:

- Ends with `.zip` ⇒ that exact path is the archive; sidecars sit beside it as
  `<base>.manifest.json`, `<base>.report.json`, `<base>.README.md`, and
  `<base>.<locale>.<snbt|json>` with `--emit-raw` — the extension follows the artefact, so a JSON
  payload is never written under a name claiming to be SNBT.
- Otherwise ⇒ treated as a **directory** (created if absent); the archive is named
  `<slug>-<packVersion>-<targetLocale>[-en_us-override][-resourcepack].zip`, embedding the exact
  compatible pack version as required.

Existing files are **never silently overwritten** — that is `E_WRITE` (exit 8) unless `--force` is
given. This is how "running against a newer pack release creates a new output rather than
overwriting" is enforced. The check covers **every path the run will write**, not just the archive:
the three sidecars always, and the raw payload when `--emit-raw` asks for it. It runs before a
single key is translated and reports all the collisions it found at once, so a leftover
`.manifest.json` cannot survive the archive check and then be overwritten at packaging time, and
clearing the way takes one run rather than four.

That preflight is an optimisation, not the safety boundary. Final publication is an atomic
create-if-absent hard link, so a name taken during translation is never replaced. Multi-file output
cannot be an atomic transaction across pathnames: if a later sidecar loses the race, files already
published by this run remain and are named in the error. We deliberately do not unlink them because
an identity check followed by pathname removal has its own race and could delete a competitor's
replacement. A subsequent run reports every leftover before translating. `--force` alone selects the
replacing write path.

Archive layout (`--layout`, default `auto`):

| Mode                             | Entry                                               |
| -------------------------------- | --------------------------------------------------- |
| `instance` (what `auto` chooses) | `config/ftbquests/quests/lang/<out>.snbt`           |
| `overrides`                      | `overrides/config/ftbquests/quests/lang/<out>.snbt` |
| `both`                           | both of the above                                   |

**[assumption]** `auto` = `instance`. An overlay ZIP containing only `overrides/` and no
`manifest.json`/`modrinth.index.json` is not importable by any launcher, so the `overrides/` wrapper
is only useful to someone re-building a pack; the instance-root layout is what the generated README
instructs users to extract. `--layout` covers the other cases explicitly.

`<out>` is `en_us` with `--override-en-us`, otherwise the resolved target locale.

Every archive also contains `README.md` (bilingual JA/EN), `translation-manifest.json`, and
`translation-report.json`. It contains **no** mod JARs, no other pack assets, and no credentials.

The README is generated, not templated by hand, and states — in both languages — whether to extract
into the instance root, import, or install server-side, plus the multiplayer consequences the
requirements enumerate (replacing `en_us.snbt` server-side affects every player whose locale
resolves to `en_us`; `en_gb.snbt` as a per-player opt-in; single-player scope), and the detected FTB
Quests evidence the advice is based on.

`translation-manifest.json`: source URL, resolved pack/version/MC version/loader,
`sourceArchiveSha256`, source & target locale, override mode, provider id, model (and fallback model
actually used), generation time, tool version, key counts.

`translation-report.json`: per-key buckets `translated` / `cached` / `skipped` / `failed` /
`fallback`, plus the update diff (`added`/`changed`/`removed`/`reused`) against `--previous`, plus
optional usage/cost totals when Claude Code reports them.

### 7.2 Resource-pack artefacts

`ArtifactMeta.artifact` is `snbt-overlay` or `resource-pack`, and everything downstream branches on
that one field rather than on a file extension. A resource pack's archive is:

| Entry                         | Content                                      |
| ----------------------------- | -------------------------------------------- |
| `pack.mcmeta`                 | `{"pack":{"pack_format":N,"description":…}}` |
| `assets/<ns>/lang/<out>.json` | the translated language file                 |
| `README.md`                   | bilingual, resource-pack specific            |
| `translation-manifest.json`   | as §7, plus the fields below                 |
| `translation-report.json`     | as §7, plus `limitations`                    |

Nothing else — no `pack.png`, no source `en_us.json`, no jar, no pack files. The three metadata
files are inert extras Minecraft ignores.

`pack_format` is derived from the pack's own Minecraft version through a table of settled values
(1.18→8, 1.19→9, 1.19.3→12, 1.19.4→13, 1.20/1.20.1→**15**, 1.20.2→18, 1.20.3/4→22, 1.20.5/6→32,
1.21/1.21.1→34, 1.21.2/3→42, 1.21.4→46). An unknown or newer version falls back to 15 — the version
this mode was verified against — and records `packFormatExact: false`, which the README turns into
an explicit "could not be derived" note naming `--pack-format`. **[assumption]** Guessing a number
for an unlisted version would be worse than saying so: a wrong `pack_format` makes the launcher call
the pack incompatible, while an honest fallback plus an override flag costs the user one flag.

The manifest gains `artifact`, `resourcePack {namespace, packFormat, packFormatExact, langPath}` and
`sourceLangJar {file, sha256, entry}`. The jar's **path on disk is deliberately absent** — it can
carry a user name — so provenance is the base name, the hash and the entry that was read.

Both the manifest and the report carry `limitations`:

```jsonc
{
  "scannedQuestFiles": 33,
  "referencedKeys": 1269,
  "missingKeys": ["quest.material.arc_furnace.title", "…"], // referenced, not defined
  "literalLabels": [{ "field": "title", "text": "WIP", "file": "…", "count": 2 }],
  "unreadableQuestFiles": []
}
```

Both limitations are structural and are stated rather than papered over, per the requirement that
nothing be guessed: a referenced key with no English string has nothing to translate, and a label
typed straight into a quest file has no translation key any resource pack could override. The README
lists the first 20 of each in both languages and defers to the report for the rest.

#### `--override-en-us` in resource-pack mode

Supported, targeting `assets/<ns>/lang/en_us.json`. **[assumption — the requirement asks for the
safer coherent behaviour, and this is it.]** Rejecting the flag here would remove a genuinely useful
and _safer_ capability: in overlay mode `--override-en-us` is a blunt instrument on a shared server
because FTB Quests serves quest data server-side, but a resource pack is client-side, so the same
flag affects **only the client that enables it** — never another player, never a server. The two
consequences are documented in the README in both languages:

- only the emitted quest keys are overridden, so the rest of the mod's English is untouched;
- `en_us` is Minecraft's fallback locale, so any language lacking its own entry for these keys will
  also show the translation.

`--layout` is refused with `--lang-jar` rather than silently ignored — a resource pack has exactly
one layout — as are `--lang-namespace` and `--pack-format` without `--lang-jar`.

All final files are written **atomically** (temp file in the destination directory → `fsync` →
`rename`).

### 7.1 Update behaviour

`--previous <manifest-or-cache>` loads a prior run's key→sourceText map. Keys are classified `added`
/ `changed` / `removed` / `reused`; reused keys with a valid cache entry are not re-translated. The
report contains all four buckets.

---

## 8. CLI

```
modpack-quest-translator --url <u> --target <t> [--override-en-us] --output <p>
```

Mandatory: `--url` (or `--archive`), `--target`, `--output`. `--override-english <true|false>` is
accepted as the requirement's literal spelling; `--override-en-us` is the boolean alias.

Aliases `-u`, `-t`, `-o` as proposed. Resource-pack mode adds `--lang-jar <path>` (its presence is
the mode switch), `--lang-namespace <ns>` and `--pack-format <n>`; the latter two are usage errors
without the first. Other flags: `--source-locale`, `--layout`, `--glossary`, `--provider`,
`--model`, `--fallback-model`, `--quality`, `--effort`, `--batch-size`, `--batch-chars`,
`--concurrency`, `--retries`, `--timeout`, `--max-download`, `--max-cost-usd`, `--cache-dir`,
`--no-cache`, `--previous`, `--emit-raw`, `--force`, `--dry-run`, `--allow-prerelease`,
`--curseforge-api-key`, `--json`, `--quiet`, `--verbose`, `--no-color`, `--version`, `--help`.

Unknown flags are a usage error (exit 2) — never silently ignored.

**Target resolution** (`locale.ts`): accepts `ja_jp`, `ja-JP`, `ja`, `Japanese`, `日本語`;
normalises to Minecraft locale form and prints the resolution before work starts. Unknown language
names are rejected with the closest matches listed.

**Stages** printed in order:
`resolve → download → inspect → parse → translate → validate → package`. `--json` emits one NDJSON
event per stage on stdout (so it is machine-consumable and never interleaved with prose); `--quiet`
prints only errors. No telemetry, ever.

**Cancellation:** a `SIGINT` handler flips an `AbortSignal`; in-flight subprocess batches are
killed, the cache is already durable (§6.3), no partial ZIP exists because packaging is the last
step and atomic. Exit code 130.

### Exit codes

| Code | Symbol                    | Meaning                                        |
| ---- | ------------------------- | ---------------------------------------------- |
| 0    | —                         | success                                        |
| 1    | `E_INTERNAL`              | unexpected error                               |
| 2    | `E_INVALID_INPUT`         | bad usage/flags/URL/locale                     |
| 3    | `E_UNSUPPORTED_PACK`      | not a modpack, unresolvable, key-gated         |
| 4    | `E_DOWNLOAD`              | network/archive fetch failure                  |
| 5    | `E_NO_QUEST_LOCALIZATION` | no modern FTB Quests lang file found           |
| 6    | `E_TRANSLATION`           | provider failed after retries                  |
| 7    | `E_VALIDATION`            | output failed key/shape/placeholder validation |
| 8    | `E_WRITE`                 | packaging/write failure, refusing to overwrite |
| 9    | `E_PREFLIGHT`             | `claude` missing, logged out, or unusable      |
| 130  | `E_CANCELLED`             | interrupted                                    |

---

## 9. Secret and PII hygiene

`util/redact.ts` runs over **every** message that reaches a log, an error, the report, the manifest,
or the README:

- Known secret-bearing values (CurseForge API key, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`)
  are registered at startup and replaced with `«redacted»` by exact substring match.
- Regex classes: `sk-ant-…`, `sk-…`, bearer tokens, `?api_key=`/`?token=` query parameters, and
  email addresses.
- The Claude Code preflight discards `email`/`orgId` before the auth result ever leaves the adapter.
- Environment variables are **never** dumped; the manifest records provider and model names only.

A dedicated test asserts that a run performed with secrets present in the environment and in the
pack text leaks nothing into the ZIP, the manifest, the report, stdout, or stderr.

---

## 10. Test strategy

Strict vertical-slice TDD: one failing test → minimal implementation → green → refactor, per slice,
in this order:

1. errors/exit codes 2. locale resolution 3. URL classification 4. bounded HTTP
2. ZIP reader + attack corpus 6. deterministic ZIP writer 7. override discovery
3. SNBT round-trip 9. FTB lang adapter 10. batching 11. validation 12. cache
4. Claude adapter (scripted `CommandRunner`) 14. orchestrator retry/fallback
5. Modrinth/CurseForge resolvers (fixture HTTP) 16. packaging/manifest/README/report
6. CLI arg parsing 18. end-to-end fixture 19. compiled-binary smoke test.

Resource-pack mode was added the same way, tests first, in three slices: reference/literal scanning
(`quest_references_test.ts`), the JSON adapter and generic document validation
(`lang_json_adapter_test.ts`), and namespace detection with its ambiguity cases
(`lang_jar_test.ts`); then packaging (`resourcepack_test.ts`) and the CLI end to end
(`e2e_resourcepack_test.ts`), which asserts the exact archive entry list, that no source
`en_us.json` / jar / `.class` / pack file leaks in, that `--override-en-us` retargets to
`en_us.json`, that `--emit-raw` writes `.json` and not `.snbt`, and that a pack of placeholders
**without** `--lang-jar` still takes the unchanged SNBT path.

`deceasedcraft_real_test.ts` runs the same discovery against the real 114 MiB archive and the real
mod jar when both are present locally, and `ignore`s itself when they are not, so a fresh clone and
CI stay green while a local run still exercises the real shapes.

Fixtures are hand-authored to mirror the real pack structure inspected during design (multi-line
arrays, `&`-codes, `\&` escapes, `{image:…}` placeholders, Unicode, empty strings, typed numerics in
chapter files). ZIP attack fixtures are built byte-by-byte by a test helper, not committed as
binaries.

Acceptance gates: `deno fmt --check`, `deno lint`, `deno check`, `deno test -A`, and a
`deno compile`d binary smoke test that runs a full offline end-to-end translation with
`--provider echo` and verifies the emitted archive.

---

## 11. Explicit v1 non-goals

As listed in the requirements: no mod language files, no Ponder scenes, no quest topology edits, no
whole-pack repacking, no historical quest formats, no GUI. Additionally not in v1: `--allow-partial`
(§6.5) and translation-memory fuzzy matching.

Resource-pack mode narrows one of those deliberately. It **does** write a mod's language namespace,
but only the keys the pack's quest files reference — never the mod's item names, block names or GUI
labels, which remain out of scope. Translating a mod wholesale is still a non-goal; overriding the
quest strings a mod happens to host is the feature. Nor does it touch hard-coded quest labels, which
would require editing the modpack itself (§7.2).
