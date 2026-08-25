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

| #  | Hazard                                                                 | Mitigation                                                                                                                                                                     |
| -- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1  | Bundle payload declares a traversal path (`../../saves/level.dat`)     | Payload paths go through `normaliseEntryPath`, then an allowlist: only `config/ftbquests/quests/lang/*.snbt`                                                                   |
| 2  | Bundle payload tampered with after packaging                           | `bundle-manifest.json` carries a SHA-256 per payload file; install verifies every one before touching anything                                                                 |
| 3  | User drags the wrong folder onto the launcher                          | The instance root must contain both `mods/` and `config/` as real directories, or install refuses (`E_INSTANCE`)                                                               |
| 4  | Target, or a directory on the way to it, is a symlink pointing outside | `lstat` on the target and on every path component inside the root; a symlink is refused outright — `--force` does not override                                                 |
| 5  | Resolved target escapes the instance root anyway                       | `realpath(target's parent)` must be a prefix of `realpath(instanceRoot)`; checked after resolution, not before                                                                 |
| 6  | Install interrupted (power loss, Ctrl+C, closed console)               | Every write is temp-in-destination-dir → `sync` → `rename`. Backup inventory is rebuilt from on-disk sidecars, so a half-done run converges on re-run                          |
| 7  | Repeated install overwrites the real backup with the Japanese file     | A file whose SHA-256 matches **any** known payload digest is never captured as an original backup (§5.3). This is the single load-bearing rule                                 |
| 8  | Backup deleted, truncated or corrupted, then uninstall runs            | Every backup is verified against its sidecar hash and size before use; a failure is an actionable error and **nothing is written** (`E_BACKUP`)                                |
| 9  | Uninstall clobbers edits the user made after installing                | The installed file's hash must still match what was installed, else `E_TARGET_MODIFIED`. `--force` proceeds but backs the modified file up first                               |
| 10 | We redistribute ACA's English prose                                    | The packager copies payload bytes only from the translated overlay ZIP; `bundle-manifest.json` records `containsSourceProse: false`; backups exist only on the user's own disk |
| 11 | The installer executable does something other than install             | Compiled with `--allow-read --allow-write` only. No `--allow-net`, no `--allow-run`, no `--allow-env`, no `-A`. It structurally cannot phone home or spawn anything            |

### 2.3 Explicit non-goals

- **Not** defended against: a hostile process with write access to the instance racing the
  installer, OS-level ACL misconfiguration, or a compromised machine.
- The executables are **unsigned**. Windows SmartScreen will show "Windows protected your PC" on
  first run; the bundle README says so in Japanese and English and explains _More info → Run
  anyway_. Code signing needs a certificate the project does not have.
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
  "toolVersion": "1.1.0",
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
  "toolVersion": "1.1.0",
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
      "toolVersion": "1.1.0"
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
validate bundle ─┬─ manifest unreadable / bad formatVersion / payload hash mismatch → E_BUNDLE
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

1. Capture the backup file with `createNew`, `sync`, then write its sidecar with `sync`.
2. Write the payload atomically (temp in the same directory → `sync` → `rename`).
3. Rewrite `state.json` atomically.

Crash between 1 and 2 leaves an orphan backup; the next install classifies the target as **foreign**
again, finds the identical backup by hash, reuses it, and proceeds. Crash between 2 and 3 leaves an
unrecorded install; the next uninstall rebuilds the inventory from sidecars, finds the `original`
backup for that target, and restores correctly.

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
outside the payload) is refused with `E_BUNDLE`. That is the mechanical guarantee behind "never
bundle or redistribute ACA original English prose".

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

| Area                | Assertions                                                                                                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bundle manifest     | Round-trip; unknown `formatVersion` rejected; payload hash mismatch rejected; `..`/absolute/drive payload paths rejected; payload outside the lang directory rejected                        |
| Windows path logic  | Quoted drag-and-drop argv; a path with spaces and with non-ASCII; trailing `\`; `C:\` root preserved; `C:relative` rejected; UNC handled; separator normalisation                            |
| Launcher generation | `.cmd` uses `%~dp0` and never `cd`; every expansion quoted; `chcp 65001`; `pause`; `exit /b` propagates the code. `.sh` has `set -eu`, resolves its own directory, `chmod +x`, quotes `"$@"` |
| Instance validation | Missing `mods/`; missing `config/`; a file where a directory is expected; auto-descend into `.minecraft`/`minecraft`; symlinked target refused; target escaping the root refused             |
| Backup naming       | Collision-safe under a frozen clock; sidecar contents; dedupe by hash; verification fails on truncation and on a hash mismatch                                                               |

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
