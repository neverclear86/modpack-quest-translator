# Installer Bundle — Design (v1)

How a translated overlay becomes something a Windows or Linux player can double-click, and how that
installer is prevented from ever destroying the file it replaces.

This document covers only the installer feature. `DESIGN.md` still governs translation, and the raw
overlay ZIP it describes stays exactly as it is — the installer bundle is an additional artefact
built _from_ that overlay, never a replacement for it.

---

## 1. Why a bundle at all

Installing the overlay by hand means: find the instance root, find
`config/ftbquests/quests/lang/en_us.snbt`, remember to copy the original somewhere first, overwrite
it, and — months later — remember which copy was the original. Every one of those steps is a place
to lose the pack's own quest text.

The bundle turns that into: unzip, double-click `INSTALL-WINDOWS.cmd` (or run `./INSTALL-LINUX.sh`),
point at the instance. Uninstall is the same gesture in reverse and puts back the exact bytes that
were there before, verified by hash.

End users need **no Deno, Node or Python**. The bundle ships a standalone `deno compile`d executable
per platform, and the launchers are a plain `.cmd` and a POSIX `sh` script.

---

## 2. Threat model

### 2.1 What is being protected

| Asset                                         | Why it matters                                                  |
| --------------------------------------------- | --------------------------------------------------------------- |
| `config/ftbquests/quests/lang/en_us.snbt`     | The pack's own quest prose. Irreplaceable if the user edited it |
| The rest of the instance, especially `saves/` | Collateral damage from a mis-aimed write                        |
| The user's disk outside the instance          | Collateral damage from traversal or a symlink                   |
| ACA's original English prose                  | Copyright: it must not be redistributed inside our artefacts    |

### 2.2 Hazards and mitigations

| #  | Hazard                                                                                           | Mitigation                                                                                                                                                                                                                                                                                                                                                        |
| -- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | Bundle payload declares a traversal path (`../../saves/level.dat`)                               | Payload paths go through `normaliseEntryPath`, then an allowlist: only `config/ftbquests/quests/lang/*.snbt`                                                                                                                                                                                                                                                      |
| 2  | Bundle payload **damaged** after packaging                                                       | `bundle-manifest.json` carries a SHA-256 per payload file; install verifies every one before touching anything. This catches a corrupt download, **not** a deliberate edit: the bundle is unsigned, so whoever can rewrite a payload can rewrite the manifest beside it (§2.3)                                                                                    |
| 3  | User drags the wrong folder onto the launcher                                                    | The instance root must contain both `mods/` and `config/` as real directories, or install refuses (`E_INSTANCE`)                                                                                                                                                                                                                                                  |
| 4  | Target, or a directory on the way to it, is a symlink pointing outside                           | `lstat` on the target and on every path component inside the root; a symlink is refused outright — `--force` does not override                                                                                                                                                                                                                                    |
| 4b | `.mqt-installer/`, `backups/`, a backup, a sidecar or `state.json` is a symlink pointing outside | The same component walk, re-run at **every** read and write boundary (§5.6); directories are created a level at a time, never `mkdir --recursive`                                                                                                                                                                                                                 |
| 5  | Resolved target escapes the instance root anyway                                                 | `realpath(target's parent)` must be a prefix of `realpath(instanceRoot)`; checked after resolution, not before                                                                                                                                                                                                                                                    |
| 6  | Install interrupted (power loss, Ctrl+C, closed console)                                         | Every write is temp-in-destination-dir → `fsync` → `rename` → `fsync` the directory, and a flush that fails **aborts before the target is replaced** (§6.1). Backup inventory is rebuilt from on-disk sidecars, so a half-done run converges on re-run                                                                                                            |
| 7  | Repeated install overwrites the real backup with the Japanese file                               | A file whose SHA-256 matches **any** known payload digest is never captured as an original backup (§5.3). This is the single load-bearing rule                                                                                                                                                                                                                    |
| 8  | Backup deleted, truncated or corrupted, then uninstall runs                                      | Every backup is verified against its sidecar hash and size before use; a failure is an actionable error and **nothing is written** (`E_BACKUP`)                                                                                                                                                                                                                   |
| 9  | Uninstall clobbers edits the user made after installing                                          | The installed file's hash must still match what was installed, else `E_TARGET_MODIFIED`. `--force` proceeds but backs the modified file up first                                                                                                                                                                                                                  |
| 10 | We redistribute ACA's English prose                                                              | The packager refuses an overlay it cannot recognise as a finished run of this tool, and re-computes the run's per-key source digests over the payload: a file that still digests to the source key for key **is** the source and is refused (§8.1). `containsSourceProse: false` is that check's result, not a promise. Backups exist only on the user's own disk |
| 11 | The installer executable does something other than install                                       | Compiled with `--allow-read --allow-write` only. No `--allow-net`, no `--allow-run`, no `--allow-env`, no `-A`. It structurally cannot phone home or spawn anything                                                                                                                                                                                               |

### 2.3 Explicit non-goals

- **Ordinary concurrent writers are handled; a hostile one is not.** Minecraft, a sync client, an
  editor or the modpack's own updater rewriting `en_us.snbt` mid-run is caught: the target is proved
  unchanged again after the backup is captured, before the replacement, and once more immediately
  before the rename that publishes it, and a change aborts with `E_TARGET_MODIFIED` and the newer
  bytes still in place (§6.2). What that cannot do is close the window between the last check and
  the `rename`/`unlink` syscall itself — POSIX has no atomic compare-and-swap on a path, and neither
  does Windows. A process deliberately racing that window, OS-level ACL misconfiguration, and a
  compromised machine all remain out of scope.
- The executables are **unsigned**. Windows SmartScreen will show "Windows protected your PC" on
  first run; the bundle README says so in Japanese and English and explains _More info → Run
  anyway_. Code signing needs a certificate the project does not have.
- **The bundle as a whole is unsigned too, and its digests are not an authenticity check.**
  `bundle-manifest.json` is a plain file sitting beside the payload it describes, so anyone who can
  replace a payload can replace the manifest in the same move and the install will verify happily.
  What the per-payload SHA-256 does catch is a download that arrived damaged, a half-extracted ZIP
  and a payload that was swapped without the manifest — real failures, and the ones a player
  actually hits. The binary digests are weaker still: nothing in the bundle verifies them at run
  time, because the launcher that would do the checking is the thing being replaced. They exist for
  a human or a CI job comparing a download against a published value. The bundle README says all of
  this in both languages rather than letting a manifest full of hashes imply otherwise.
- No elevation is requested or needed. Anything requiring administrator rights is a bug.
- No network access, no telemetry, no auto-update.

---

## 3. Bundle layout

One ZIP. Everything inside a single top-level directory so extracting it never litters the user's
Downloads folder.

```text
<bundle-id>/
  README.md                                 Japanese first, English second
  INSTALL-WINDOWS.cmd
  UNINSTALL-WINDOWS.cmd
  INSTALL-LINUX.sh                          mode 0755
  UNINSTALL-LINUX.sh                        mode 0755
  bundle-manifest.json
  translation-manifest.json                 verbatim from the translation run
  translation-report.json                   verbatim from the translation run
  bin/
    mqt-installer-windows-x86_64.exe
    mqt-installer-linux-x86_64              mode 0755
  payload/
    config/ftbquests/quests/lang/en_us.snbt Japanese text under the en_us name (override mode)
```

`<bundle-id>` defaults to the overlay archive's stem, e.g.
`all-of-create-aeronautics-2.4-ja_jp-en_us-override`.

**The original English file is not present, anywhere.** `payload/` holds only what the translation
run produced.

The ZIP is written by the existing deterministic writer (sorted entries, fixed 1980 timestamps), so
packaging the same overlay twice is byte-identical. The writer gains one thing it lacks today: a
per-entry Unix mode, because `bin/mqt-installer-linux-x86_64` and the two `.sh` files need `0755`
and everything else stays `0644`.

### 3.1 `bundle-manifest.json`

```json
{
  "formatVersion": 1,
  "bundleId": "all-of-create-aeronautics-2.4-ja_jp-en_us-override",
  "tool": "modpack-quest-translator",
  "toolVersion": "1.1.1",
  "generatedAt": "2026-08-25T00:00:00.000Z",
  "pack": { "name": "All of Create: Aeronautics", "version": "2.4" },
  "sourceLocale": "en_us",
  "targetLocale": "ja_jp",
  "overrideEnglish": true,
  "containsSourceProse": false,
  "payload": [
    {
      "path": "config/ftbquests/quests/lang/en_us.snbt",
      "sha256": "…64 hex…",
      "sizeBytes": 148213
    }
  ],
  "binaries": [
    {
      "path": "bin/mqt-installer-linux-x86_64",
      "target": "x86_64-unknown-linux-gnu",
      "sha256": "…"
    },
    {
      "path": "bin/mqt-installer-windows-x86_64.exe",
      "target": "x86_64-pc-windows-msvc",
      "sha256": "…"
    }
  ]
}
```

`formatVersion` is checked on load. An unknown (higher) version is `E_BUNDLE` with "this bundle was
made by a newer version of the tool", never a best-effort parse; a lower one is `E_BUNDLE` too,
rather than a guess at what an older shape meant. `containsSourceProse` must be present and `false`,
so a bundle that does not make the claim is refused rather than trusted.

The descriptive fields are validated too, rather than read as bare strings and defaulted when
absent. None of them can steer a write — the payload path allowlist is checked separately, below —
but a bundle that cannot say coherently what it is gets refused rather than reported in its own
words, because those words reach the player through the install report, `state.json` and every
backup sidecar:

- `tool` must be this tool's name, and `toolVersion` a semver;
- `generatedAt` must be an ISO-8601 timestamp that survives a `Date` round trip, so neither
  "yesterday" nor `2026-13-45T99:00:00.000Z` is accepted;
- `sourceLocale` and `targetLocale` must be well-formed and must differ from each other;
- `payload` must name the single file the manifest's own locales and `overrideEnglish` imply, by the
  same rule the packager used to produce it (§7.2 of DESIGN.md: override mode ships as `en_us`
  whatever locale was read);
- `bundleId` must be a plain short name: 1–120 characters of `[A-Za-z0-9._-]`, and never a dot-only
  name like `.` or `..`, which is built from allowed characters but names a directory. The packager
  checks the same predicate before building, so `--bundle-id ../evil` — or `--bundle-id ..` — names
  the flag to change instead of surfacing later as the ZIP writer complaining about an unsafe entry
  path;
- each `binaries` entry must be a plain name inside `bin/`, a compile target and a lower-case
  SHA-256. The installer never opens them, but the bundle README prints those paths, and a name that
  reads as a path is one a reader could be talked into running.

### 3.2 Launchers locate the bundle relative to themselves

Never relative to the working directory — a double-clicked `.cmd` on Windows may start in
`C:\Windows\System32`, and an `.sh` invoked by absolute path starts wherever the user's shell was.

- `.cmd`: `%~dp0` is the batch file's own directory, always with a trailing backslash.
  `"%~dp0bin\mqt-installer-windows-x86_64.exe" install --bundle "%~dp0."`
- `.sh`: `BUNDLE_DIR=$(cd -- "$(dirname -- "$0")" && pwd)`, then
  `exec "$BUNDLE_DIR/bin/mqt-installer-linux-x86_64" install --bundle "$BUNDLE_DIR"`.

Every expansion is quoted, so a bundle extracted to `C:\Users\ゆき\Downloads\aca ja\` works.

Both launchers check that the executable is actually there before anything else and exit `10` with a
"extract the whole ZIP first" message if it is not, because running a `.cmd` from inside a ZIP
viewer is the most common way this fails.

The Windows launchers accept a **drag-and-drop**: dropped paths arrive as `%1` (and `%2`… if several
were dropped — only the first is used, with a warning). With no argument they `set /p` prompt for a
path. `chcp 65001` first so Japanese output renders, and `pause` last so a double-clicked window
does not vanish before the user can read the result. `exit /b` propagates the real exit code.

A dropped path ending in a backslash would escape the closing quote of the `--instance "…"` argument
and hand the installer the rest of the line, so the launcher appends a `.` to it first; that
resolves to the same directory and needs no special case for a drive root.

`INSTALL-LINUX.sh` uses `set -eu`, `chmod +x` on the binary defensively (some GUI unzip tools drop
the mode bit), accepts the instance path as `$1`, and otherwise prompts on the TTY — a closed stdin
there is a cancellation, not a crash. It expands a leading `~` itself, because the installer is
compiled without `--allow-env` and so cannot read `$HOME`. Any remaining arguments are forwarded to
the executable as `"$@"`, so `./UNINSTALL-LINUX.sh <instance> --force` works; the `.cmd` forwards
nothing beyond the dropped path, so on Windows `--force` means calling
`bin\mqt-installer-windows-x86_64.exe` directly.

---

## 4. Installer CLI

One executable, subcommand-shaped, compiled from `src/installer/main.ts`.

```text
mqt-installer install   [--bundle <dir>] [--instance <path>] [--force] [--json] [--yes]
mqt-installer uninstall [--bundle <dir>] [--instance <path>] [--force] [--json] [--yes]
mqt-installer status    [--bundle <dir>] [--instance <path>] [--json]
```

`--bundle` may be omitted: the executable lives at `<bundle>/bin/<exe>`, so the bundle is found two
levels up from `Deno.execPath()`, and a copy of the executable placed beside the manifest works too.
Neither candidate holding `bundle-manifest.json` is `E_INVALID_INPUT` with the flag named — guessing
any further would be guessing.

`--instance` may be omitted when stdin is a TTY, in which case the path is prompted for — that is
the double-click flow. In a non-TTY it is required, so scripts and tests never hang. `--yes` skips
the "about to replace X, continue?" confirmation, which is otherwise shown interactively; a
cancelled prompt writes nothing and exits 0. `status` refuses `--force` and `--yes` outright,
because it never changes anything.

### 4.1 Exit codes

Extending the table in `src/errors.ts`; existing codes keep their meanings.

| Code | Symbol              | Meaning                                                          |
| ---- | ------------------- | ---------------------------------------------------------------- |
| 0    | —                   | Success, including "already installed, nothing to do"            |
| 1    | `E_INTERNAL`        | Unexpected error                                                 |
| 2    | `E_INVALID_INPUT`   | Bad flags or an unusable path string                             |
| 8    | `E_WRITE`           | Write/rename failed                                              |
| 10   | `E_BUNDLE`          | Bundle missing, malformed, unknown format version, hash mismatch |
| 11   | `E_INSTANCE`        | Not a Minecraft instance root, or a symlink/traversal refusal    |
| 12   | `E_TARGET_MODIFIED` | The installed file changed after installation; refusing          |
| 13   | `E_BACKUP`          | No usable backup: missing, truncated or hash mismatch            |
| 14   | `E_NOT_INSTALLED`   | Uninstall with nothing of ours installed                         |
| 130  | `E_CANCELLED`       | Interrupted                                                      |

---

## 5. State and backup layout

Everything the installer remembers lives **inside the instance**, so backups travel with a copied or
moved instance and no home directory, registry key or admin right is involved.

```text
<instance>/.mqt-installer/
  state.json
  backups/
    en_us.snbt.20260825T142233Z-0.9f2a1c4b7e01.bak
    en_us.snbt.20260825T142233Z-0.9f2a1c4b7e01.bak.json
```

### 5.1 Backup file naming

`<basename>.<UTC compact timestamp>-<counter>.<sha256[0..12]>.bak`

- The timestamp orders them; the hash makes two different files with the same timestamp distinct and
  makes the name self-describing; the counter is bumped until an exclusive create succeeds, so the
  name is collision-safe even against a clock that stands still or steps backwards.
- Nothing is ever overwritten in `backups/`. Files are created with `createNew: true`.

### 5.2 Backup sidecar

Written next to each backup, and it — not `state.json` — is the authority on what backups exist.
`state.json` can be lost or truncated; the inventory is rebuilt by scanning sidecars.

```json
{
  "formatVersion": 1,
  "kind": "original",
  "targetRelativePath": "config/ftbquests/quests/lang/en_us.snbt",
  "capturedAt": "2026-08-25T14:22:33.000Z",
  "sha256": "…64 hex…",
  "sizeBytes": 148213,
  "toolVersion": "1.1.1",
  "capturedByBundleId": "all-of-create-aeronautics-2.4-ja_jp-en_us-override"
}
```

`kind` is one of:

| `kind`             | Meaning                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `original`         | The file that was there before we first replaced anything. Restore uses these |
| `absent`           | Sentinel: there was **no** file before install. Restore means delete          |
| `modified-install` | An installed payload the user then edited, captured by `uninstall --force`    |

Only `original` and `absent` are restore candidates.

### 5.3 The rule that protects the backup

> A file whose SHA-256 matches any known payload digest is never recorded as `kind: "original"`.

"Known payload digests" is the union of: the current bundle's payload digests, every
`installedSha256` in `state.json`, and every payload digest recorded in the install history. This is
what makes a second install idempotent instead of quietly replacing the English backup with the
Japanese file — and it holds even if `state.json` is missing, because the current bundle's own
digest alone already catches the common case.

A second, cheap guard: capture deduplicates by hash. If `backups/` already holds a verified backup
of the same target with the same SHA-256, that one is reused rather than a near-duplicate written.
This is what makes an interrupted run converge rather than accumulate.

### 5.5 A retained backup is not an installation

`backups/` is append-only and survives uninstall for ever, so **the existence of an `original` or
`absent` backup says nothing about the file that is on disk right now.** It may be the leftover of
an install that was undone releases ago.

A backup counts as _this install's preserved original_ only when the target is genuinely under
installation — the **lineage** is live:

- `state.json` still has an install record for that target, **or**
- the file on disk is still one of our payloads and it is `state.json` that was lost.

Where neither holds, install is at **first contact** with whatever is there, and captures it as a
fresh `original`.

Without that rule, this happens: install into a pack, uninstall, then update the modpack so it ships
a new `en_us.snbt`. The next install finds the retained backup, decides the pack's brand-new English
file must be somebody's edit of our translation, refuses with `E_TARGET_MODIFIED` — and under
`--force` files that new file away as `modified-install`, which is _not_ a restore candidate, while
pointing the install record at the years-old backup. The next uninstall then puts the old version
back, or deletes the file outright if the old backup was an `absent` sentinel. Both outcomes destroy
the pack's current quest prose, which is the one asset this whole design exists to protect.

The exception, and it is safe by construction: if the bytes on disk are byte-for-byte a verified
`original` we already hold, that backup is adopted whatever its lineage, because restoring it later
reproduces exactly the file that is there now. `absent` sentinels are excluded from that match — a
sentinel is a zero-byte file, so a target that genuinely _is_ empty would match one, and adopting it
would turn "restore an empty file" into "delete the file".

### 5.6 The installer's own directories get the target's guarantees

`config/ftbquests/quests/lang/en_us.snbt` is walked component by component, refusing a symlink
anywhere and proving the deepest existing component still resolves inside the instance root.
**`.mqt-installer/`, `backups/`, every backup, every sidecar and `state.json` go through the same
walk**, and go through it again at each boundary rather than once per run, so a directory swapped
for a link mid-run is caught before the next write rather than after it.

Concretely:

- `.mqt-installer/` and `backups/` are created **a level at a time** with plain `mkdir`, each level
  re-inspected afterwards. `mkdir --recursive` follows a symlinked `.mqt-installer` without
  complaint, which is enough on its own to put `backups/` and `state.json` outside the instance.
- Backup and sidecar names are generated from a payload basename, a timestamp and a digest, and are
  re-checked against `[A-Za-z0-9._-]+` before they are joined to anything — the last place a name
  could turn into a path.
- `scan()` skips a symlinked sidecar with a warning instead of reading through it, and `verify()`
  re-resolves the backup before opening it, so a link swapped in between the scan and the restore
  fails verification rather than being restored from.
- `state.json` is `lstat`-ed before it is read and before it is replaced.
- No path is ever built from `state.json`. `originalBackup` is compared as a _string_ against names
  discovered by scanning `backups/`, so a tampered state file can fail to match but can never name a
  file to open.

`--force` overrides none of it, for the same reason it overrides nothing else here: forcing past a
symlink is how an installer writes outside the instance.

### 5.4 `state.json`

```json
{
  "formatVersion": 1,
  "installs": {
    "config/ftbquests/quests/lang/en_us.snbt": {
      "bundleId": "all-of-create-aeronautics-2.4-ja_jp-en_us-override",
      "installedSha256": "…",
      "installedAt": "2026-08-25T14:22:33.000Z",
      "originalBackup": "backups/en_us.snbt.20260825T142233Z-0.9f2a1c4b7e01.bak",
      "originalSha256": "…",
      "originalWasAbsent": false,
      "toolVersion": "1.1.1"
    }
  },
  "history": [
    {
      "event": "install",
      "target": "…",
      "at": "…",
      "bundleId": "…",
      "installedSha256": "…",
      "backup": "backups/…"
    },
    {
      "event": "uninstall",
      "target": "…",
      "at": "…",
      "restoredFrom": "backups/…",
      "deleted": false
    }
  ]
}
```

Written atomically, and trimmed to the most recent 200 events so a much-reinstalled instance cannot
grow the file without bound. Losing it is recoverable: sidecars still identify every backup and its
target. A `state.json` that is not readable JSON, or whose records do not parse, is a **warning**
and an empty in-memory state rather than a failure: the sidecars are the authority, and refusing to
run because a bookkeeping file is corrupt would strand the user with no way to uninstall. The one
exception is a **higher** `formatVersion`, which is `E_INSTANCE` — rewriting it would discard
whatever a newer installer recorded there.

---

## 6. Install state machine

```text
validate bundle ─┬─ manifest unreadable / bad formatVersion → E_BUNDLE
                 ├─ manifest cannot describe itself (tool, toolVersion, generatedAt,
                 │    locales, bundleId, binaries, payload name) → E_BUNDLE
                 ├─ payload hash or size mismatch → E_BUNDLE
                 └─ ok
validate instance ─┬─ no mods/ or no config/ → E_INSTANCE (with the auto-descend hint below)
                   └─ ok
resolve target ─┬─ payload path not under config/ftbquests/quests/lang/, or contains ".." → E_BUNDLE
                ├─ target or an intermediate component is a symlink → E_INSTANCE
                ├─ realpath(parent) not inside realpath(root) → E_INSTANCE
                └─ ok
classify current target
```

| Classification                                                  | Action                                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **payload-current** — hash equals this bundle's payload         | **Idempotent.** No backup, no rewrite. Report "already installed", exit 0. `--force` rewrites the same bytes but still takes no backup                                    |
| **absent** — no file there                                      | Record an `absent` sentinel backup, write payload → `INSTALLED`. If the **live** install already has an `original` preserved, keep it and record nothing new              |
| **payload-known** — hash equals a previously installed payload  | Overlay upgrade. **No backup** (it is not original). Keep the existing `originalBackup` pointer, write the new payload → `INSTALLED`                                      |
| **preserved-original** — hash equals an `original` we hold      | The run that finishes an install interrupted between capturing the backup and writing the payload. No second backup; write payload → `INSTALLED`                          |
| **modified** — foreign, and the live install's original is held | Whatever is here arrived after we installed. `E_TARGET_MODIFIED`, nothing written. `--force` captures it as `kind: "modified-install"` **first**, then writes the payload |
| **foreign** — anything else, no install of ours is live here    | First contact with a file we did not write: capture it as `kind: "original"` (or reuse an identical existing backup), then write payload → `INSTALLED`                    |

The order matters: **payload-current** is tested before anything else, so a file that is one of our
payloads can never reach the capture branches. **modified** is the reason `install` — not only
`uninstall` — can exit 12: an edited installed file is not an original, and silently overwriting the
player's edit would be as bad as silently overwriting the pack's.

"Preserved" always means **the live install's** original (§5.5). A backup left behind by an install
that has already been undone is not one, so a modpack that ships a new `en_us.snbt` after an
uninstall is classified **foreign** — first contact — and its file becomes the new `original`.

Write order, chosen for crash safety:

1. Capture the backup file with `createNew` and `fsync` it, write its sidecar and `fsync` that, then
   `fsync` `backups/` — and every parent directory this run had to create — so the _entries naming
   those files_ are on the disk too, not only their contents.
2. Write the payload atomically (temp in the same directory → `fsync` → `rename` → `fsync` the
   directory).
3. Rewrite `state.json` atomically, the same way.

Crash between 1 and 2 leaves an orphan backup; the next install classifies the target as **foreign**
again, finds the identical backup by hash, reuses it, and proceeds. Crash between 2 and 3 leaves an
unrecorded install; the next uninstall rebuilds the inventory from sidecars, finds the `original`
backup for that target, and restores correctly.

### 6.1 A flush that fails stops the run

Every one of those flushes is checked. A failure aborts **before** step 2, with `E_BACKUP` and
"nothing was changed" — because the alternative is the one outcome this whole design exists to
prevent: a power cut that takes the backup with it and leaves the instance holding the translated
file and no copy of the pack's own prose. A file's contents reaching the page cache is not the same
as reaching the disk, and neither says anything about the directory entry that names it.

The flushes are injected rather than called directly, so a filesystem that refuses one is testable
without finding one, and so the two platforms differ in one visible place instead of by implication:

| Platform | File contents        | Directory entry                                         |
| -------- | -------------------- | ------------------------------------------------------- |
| Linux    | `fsync(fd)`, checked | `fsync` on a read-only handle to the directory, checked |
| Windows  | `fsync(fd)`, checked | **A deliberate no-op** — see below                      |

Windows has no per-directory flush to call: opening a directory as a file fails outright, and the
nearest equivalent, `FlushFileBuffers` on a volume handle, needs administrator rights this installer
never asks for. NTFS journals directory metadata, so a rename that has returned is recoverable by
the filesystem itself. That is a documented no-op, not a swallowed failure.

So the claim is: on Linux, the backup **and the entry naming it** are both on the disk before the
original is replaced. On Windows it is the backup's _contents_ plus a rename that has returned, with
NTFS's own journalling behind it. No more than that is claimed.

### 6.2 The target is re-proved at every destructive boundary

The plan is built from **one** read per target. Capturing a backup, hashing it and flushing it all
take time, and the file is not locked while they happen — so between the read that classified it and
the rename that replaces it, the file can have become something else entirely.

The target is therefore re-read and re-hashed, and its whole path re-walked, at each boundary:

1. after the backup is captured,
2. before the replacement,
3. inside the atomic write, after the temp file is durable and immediately before the `rename`.

Any difference — different bytes, a file that appeared where there was none, one that vanished, or a
parent directory that has become a symbolic link since the plan was made — aborts the run.
`E_TARGET_MODIFIED` (or `E_INSTANCE` for the symlink), nothing overwritten, the newer bytes still
there. Re-walking rather than reusing the resolved path is what makes the symlink case work: the
containment guarantee is re-established, not remembered.

`--force` does not weaken this. `--force` means "the file I installed was edited and I accept losing
that edit", decided by a human looking at an error message. It does not mean "overwrite whatever
turns up in the next fifty milliseconds".

**The residual window is the syscall itself.** Between check (3) and the `rename` — or between the
check and the `unlink` when a restore means deleting — there is no way to make the pair atomic on
either platform. That window is microseconds wide, and it is what §2.3 declines to defend. What is
closed is the realistic one: the seconds-wide window an editor, a sync client or a modpack updater
actually writes in.

**Instance-root convenience:** if the given directory has no `mods/`+`config/` but its child
`.minecraft/` or `minecraft/` does, that child is used and the resolution is printed. This covers
Prism/MultiMC instance folders, which is where drag-and-drop actually lands. Anything deeper is not
searched.

---

## 7. Uninstall state machine

```text
validate bundle (manifest only; payload bytes are not needed)
validate instance, resolve target, symlink + containment guards   [same as install]
load state.json, then reconcile the backup inventory from backups/*.json sidecars
```

| Condition                                                        | Outcome                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| No install record **and** target hash is not a known payload     | `E_NOT_INSTALLED`. Nothing is written                                          |
| Target present, hash ≠ recorded `installedSha256`                | `E_TARGET_MODIFIED`. Nothing is written. Hint names `--force`                  |
| Target present, hash ≠ recorded, **`--force`**                   | Capture the current file as `kind: "modified-install"` **first**, then restore |
| No candidate backup verifies (missing / wrong size / wrong hash) | `E_BACKUP`, listing each candidate and why it failed. Nothing is written       |
| Best candidate is `kind: "absent"`                               | Delete the target. Directories are left alone                                  |
| Best candidate is `kind: "original"` and verifies                | Restore atomically                                                             |

**Choosing the backup** — "the correct/latest usable original backup":

1. The one named by the install record, if it exists and verifies.
2. Otherwise the one whose `sha256` equals the record's `originalSha256` — a pointer whose file was
   renamed away still names its bytes, and that beats "the newest" when several undone installs have
   each left an original behind.
3. Otherwise the newest by `capturedAt` among sidecars with a matching `targetRelativePath` and
   `kind ∈ {original, absent}` that verifies.
4. Otherwise `E_BACKUP`.

**Restore is atomic**: backup bytes → temp file in the target's directory → `sync` → `rename` over
the target. A crash mid-restore leaves either the old file or the new one, never a truncated one.

**All-or-nothing survives past planning.** Every target is planned and refused before a byte moves,
but a _write_ can still fail at run time on the second of two files. When it does, the targets
already changed are put back to what this run found — checked first, so a third party's later write
is not clobbered in the name of tidying up — and the error names each one and whether it could be
undone. `state.json` is rewritten only after every target has succeeded, so a failed run leaves the
install exactly as on the books as it was, and re-running finishes the job. `install` does the same.

**Backups are retained after restore.** Nothing in `backups/` is ever deleted by the installer;
uninstall only appends to `history`. Removing the translation twice in a row is therefore safe, and
so is uninstalling, reinstalling and uninstalling again.

---

## 8. Packaging command

Generic, not ACA-specific: it takes any overlay ZIP this tool produced and emits a bundle.

```text
deno task package-installer \
  --overlay   ./dist/aca-2.4-ja_jp-en_us-override.zip \
  --output    ./dist/aca-2.4-ja_jp-installer.zip \
  --binaries  ./dist/bin
```

| Flag                                 | Behaviour                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `--overlay <zip>`                    | Required. The raw overlay ZIP                                                                                                |
| `--output <zip\|dir>`                | Required. Same `.zip`-or-directory semantics as the translator's `--output`; a directory gets `<bundle-id>-installer.zip`    |
| `--manifest`, `--report`             | Default to the sidecars beside the overlay, then to the copies inside it                                                     |
| `--binaries <dir>`                   | Directory holding the compiled installer executables                                                                         |
| `--windows-binary`, `--linux-binary` | Explicit paths, overriding `--binaries`                                                                                      |
| `--no-binaries`                      | Build a bundle without executables — for packaging tests only; the bundle README and manifest both say it is not installable |
| `--bundle-id <id>`                   | Overrides the default, which is the overlay's file stem, reduced to `[A-Za-z0-9._-]`                                         |
| `--generated-at <iso>`               | Overrides the timestamp, which otherwise comes from the translation manifest — that is what keeps packaging deterministic    |
| `--force`, `--json`, `--quiet`       | As in the translator                                                                                                         |

The packager **only** copies entries the overlay itself contains under
`config/ftbquests/quests/lang/`. Anything else in the overlay (a `.jar`, a stray `en_us` file from
outside the payload) is refused with `E_BUNDLE`.

That allowlist is necessary and not sufficient: the pack's own `en_us.snbt` is a file under that
directory, so on its own the allowlist would have copied ACA's English prose into `payload/` under a
manifest recording `containsSourceProse: false`. Before any of it is copied,
`verifyTranslationProvenance` therefore requires the overlay to be a finished run of this tool:

- `translation-manifest.json` and `translation-report.json` are both present, are this tool's, name
  a real ISO-8601 `generatedAt`, and carry well-formed locales that differ from each other;
- the report's `failed` list is empty, so a partial run is never packaged;
- `keyCounts` accounts for at least one string translated, cached or fallen back;
- the payload is the single file the run's own locale and `overrideEnglish` say it produced;
- and the load-bearing one: a run records a digest per SNBT key of the text it _read_, and
  re-computing those over the payload has to yield the same key set while **not** reproducing every
  digest. A file that digests to the source key for key _is_ the source.

`--generated-at` overrides the timestamp for reproducibility and is not a way past any of it.

What this is not is a signature. A manifest is a JSON file, and someone determined to lie can write
one that agrees with a payload they also wrote. What it does make impossible is the _accident_ —
pointing `--overlay` at the pack's own quest file, or at a run that did not finish — which is the
failure mode this project actually has. `containsSourceProse: false` is the result of that check and
is described that way in the bundle README, rather than as a promise the format cannot keep.

Supporting tasks:

```text
deno task build:installer:linux     deno compile --target x86_64-unknown-linux-gnu …
deno task build:installer:windows   deno compile --target x86_64-pc-windows-msvc  …
deno task build:installers          both of the above
deno task bundle                    build:installers && package-installer --binaries dist/bin
```

`deno task bundle` appends its own arguments to the packaging step, so
`deno task bundle --overlay <zip> --output <dir>` is the whole build from a clean checkout.

---

## 9. Test plan

Same discipline as the rest of the project: one failing test, minimal implementation, green,
refactor. No test writes outside a temp directory, and nothing touches the network.

### 9.1 Pure logic (runs on Linux, covers Windows behaviour)

| Area                | Assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle manifest     | Round-trip; unknown `formatVersion` rejected; payload hash mismatch rejected; `..`/absolute/drive payload paths rejected; payload outside the lang directory rejected; a manifest that cannot describe itself rejected — foreign `tool`, non-semver `toolVersion`, unparseable `generatedAt`, malformed or equal locales, a `bundleId` carrying a path, a newline or only dots, a binary entry outside `bin/`, a payload name its own locales do not imply |
| Windows path logic  | Quoted drag-and-drop argv; a path with spaces and with non-ASCII; trailing `\`; `C:\` root preserved; `C:relative` rejected; UNC handled; separator normalisation                                                                                                                                                                                                                                                                                          |
| Launcher generation | `.cmd` uses `%~dp0` and never `cd`; every expansion quoted; `chcp 65001`; `pause`; `exit /b` propagates the code. `.sh` has `set -eu`, resolves its own directory, `chmod +x`, quotes `"$@"`                                                                                                                                                                                                                                                               |
| Instance validation | Missing `mods/`; missing `config/`; a file where a directory is expected; auto-descend into `.minecraft`/`minecraft`; symlinked target refused; target escaping the root refused                                                                                                                                                                                                                                                                           |
| Backup naming       | Collision-safe under a frozen clock; sidecar contents; dedupe by hash; verification fails on truncation and on a hash mismatch                                                                                                                                                                                                                                                                                                                             |

### 9.2 State machines (real temp directories)

- Fresh install: payload lands byte-exact, backup captured, sidecar and `state.json` correct.
- **Reinstall is idempotent**: no second backup, the `original` backup still holds the English
  bytes, target unchanged, exit 0.
- Overlay upgrade (different payload): no new `original` backup, the original pointer survives.
- Install where the target did not exist: `absent` sentinel; uninstall deletes rather than restores.
- Crash recovery: orphan backup with no `state.json` entry → next install reuses it; installed
  payload with no `state.json` entry → uninstall still finds the backup via sidecars.
- Uninstall restores the exact original bytes, and the backup is **still there** afterwards.
- Uninstall after the user edited the installed file → `E_TARGET_MODIFIED`, file untouched.
- The same with `--force` → the edit is captured as `modified-install`, then the original is
  restored.
- Backup deleted → `E_BACKUP`, actionable message, target file byte-identical to before.
- Backup truncated → same.
- Paths containing spaces and non-ASCII (`…/インスタンス フォルダ/`) throughout.

### 9.3 Packaging

- A bundle built from a fixture overlay contains exactly the expected entry set.
- Byte-identical when built twice from the same input.
- `bin/*` and `*.sh` carry mode `0755`; everything else `0644`.
- An overlay containing a `.jar` or a file outside the lang directory is refused.
- No entry anywhere in the bundle contains the original English source text.

### 9.4 Binaries

- `deno compile --target x86_64-unknown-linux-gnu` → run the real binary against a real temp
  instance: install, reinstall, uninstall, and each error path.
- `deno compile --target x86_64-pc-windows-msvc` → assert the output is a PE image (`MZ` magic) of a
  plausible size. **This is a build check only.** Windows runtime behaviour is not tested from Linux
  and no such claim will be made.
- The compiled installer is checked to have been built without `--allow-net`/`--allow-run`.

### 9.5 Acceptance gates

`deno fmt --check`, `deno lint`, `deno check`, `deno test -A`, `deno task build`,
`deno task build:installers`, and `deno task e2e:bundle`, which packages a bundle into a temp
directory and installs from it with the real compiled binary — all on the latest Deno 2 only. Deno 1
is not supported and not tested: the compatibility shim is gone from `src/util/fs.ts` (a test
asserts no such shim is reachable) and the Deno 1 claims are gone from `DESIGN.md` and `README.md`.
