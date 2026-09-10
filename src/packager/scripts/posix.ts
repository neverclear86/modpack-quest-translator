/**
 * The POSIX sh installer, shipped as `scripts/mqt-installer.sh`.
 *
 * Kept as one string so the packager, the tests and the e2e gate all see the
 * exact bytes a player gets. It mirrors `powershell.ts` step for step; a
 * change to one is a change to both.
 *
 * Tools it needs, all of them standard: a POSIX `sh` (dash, bash, busybox),
 * coreutils (`cp`, `mv`, `ln`, `mkdir`, `rm`, `wc`, `date`, `sync`,
 * `dirname`, `basename`, `sha256sum` -- or `shasum`/`openssl` instead of
 * `sha256sum`), `grep` and `sed`. Nothing is downloaded and nothing else is
 * run.
 */
export const POSIX_INSTALLER_SCRIPT = `#!/bin/sh
# mqt-installer.sh -- script-only installer for a modpack-quest-translator bundle.
#
# Usage: sh mqt-installer.sh install|uninstall|status [<instance>] [--bundle <dir>]
#                            [--instance <path>] [--force] [--yes]
#
# Needs only a POSIX sh, coreutils (cp mv ln mkdir rm wc date sync dirname
# basename, and sha256sum or shasum or openssl), grep and sed. No network,
# no other programs.
#
# Exit codes: 0 ok, 2 bad arguments, 8 write failed, 10 bundle unusable,
# 11 not an instance / symlink / another installer's install, 12 the
# installed file was changed, 13 no usable backup, 14 nothing installed,
# 15 the pack's quest file is not the one this translation was made from.
set -eu

STATE_DIR_NAME=".mqt-installer-scripts"
LEGACY_DIR_NAME=".mqt-installer"
CONF_FORMAT=1
TOOL_NAME="modpack-quest-translator"

E_INTERNAL=1
E_INVALID_INPUT=2
E_WRITE=8
E_BUNDLE=10
E_INSTANCE=11
E_TARGET_MODIFIED=12
E_BACKUP=13
E_NOT_INSTALLED=14
E_SOURCE_MISMATCH=15

# ---- output ------------------------------------------------------------------

say() { printf '%s\\n' "$1"; }
warn() { printf '[warn] %s\\n' "$1" >&2; }
die() {
  local code
  # die <code> <message> [<hint>]
  code=$1
  printf 'error: %s\\n' "$2" >&2
  if [ $# -ge 3 ] && [ -n "$3" ]; then printf 'hint: %s\\n' "$3" >&2; fi
  exit "$code"
}

MIGRATION_HINT="Run UNINSTALL from the bundle that installed it (the executable installer keeps its records in $LEGACY_DIR_NAME/), then run this installer. If you copied the translated file in by hand, put the pack's own file back first. / この翻訳を導入した配布物の UNINSTALL を先に実行してください。"

# ---- tools -------------------------------------------------------------------

HASH_CMD=""
detect_tools() {
  local tool
  if command -v sha256sum >/dev/null 2>&1; then HASH_CMD="sha256sum"
  elif command -v shasum >/dev/null 2>&1; then HASH_CMD="shasum -a 256"
  elif command -v openssl >/dev/null 2>&1; then HASH_CMD="openssl dgst -sha256 -r"
  else die $E_INTERNAL "No SHA-256 tool found" "Install coreutils (sha256sum), perl (shasum) or openssl."
  fi
  for tool in cp mv ln mkdir rm wc date sync dirname basename grep sed; do
    command -v "$tool" >/dev/null 2>&1 || die $E_INTERNAL "Required tool missing: $tool"
  done
}

digest_of() {
  local d
  # digest_of <file> -> 64 lower-case hex on stdout. Read from stdin so an odd
  # file name never reaches the hash tool's output.
  d=$($HASH_CMD < "$1" | sed 's/[ *].*//' | tr 'ABCDEF' 'abcdef')
  case "$d" in
    *[!0-9a-f]*|"") die $E_INTERNAL "Could not hash $1";;
  esac
  [ \${#d} -eq 64 ] || die $E_INTERNAL "Could not hash $1"
  printf '%s' "$d"
}

size_of() { wc -c < "$1" | tr -d ' \\n\\t'; }

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

short() { printf '%.12s' "$1"; }

fsync_path() {
  # Flush one file or directory to disk. GNU coreutils and busybox accept a
  # path; older ones do not, and then everything is flushed instead.
  if sync -- "$1" 2>/dev/null; then return 0; fi
  sync
}

is_hex64() { case "$1" in *[!0-9a-f]*|"") return 1;; esac; [ \${#1} -eq 64 ]; }
is_uint() { case "$1" in ""|*[!0-9]*) return 1;; esac; return 0; }

# ---- key=value files ----------------------------------------------------------

kv_get() {
  # kv_get <file> <key> -> value (first match) or empty
  sed -n "s/^$2=//p" "$1" | head -n 1
}

# ---- arguments ---------------------------------------------------------------

usage() {
  say "usage: mqt-installer.sh install|uninstall|status [<instance>] [--bundle <dir>] [--instance <path>] [--force] [--yes]"
}

CMD=""
BUNDLE=""
INSTANCE_ARG=""
FORCE=0
YES=0

parse_args() {
  [ $# -ge 1 ] || { usage; exit $E_INVALID_INPUT; }
  CMD=$1
  shift
  case "$CMD" in
    install|uninstall|status) ;;
    --help|-h|help) usage; exit 0;;
    *) die $E_INVALID_INPUT "Unknown command: $CMD" "Use install, uninstall or status.";;
  esac
  while [ $# -gt 0 ]; do
    case "$1" in
      --bundle) [ $# -ge 2 ] || die $E_INVALID_INPUT "--bundle needs a value"; BUNDLE=$2; shift;;
      --bundle=*) BUNDLE=\${1#--bundle=};;
      --instance) [ $# -ge 2 ] || die $E_INVALID_INPUT "--instance needs a value"; INSTANCE_ARG=$2; shift;;
      --instance=*) INSTANCE_ARG=\${1#--instance=};;
      --force) FORCE=1;;
      --yes) YES=1;;
      --help|-h) usage; exit 0;;
      -*) die $E_INVALID_INPUT "Unknown option: $1" "Options are --bundle, --instance, --force and --yes.";;
      *) if [ -z "$INSTANCE_ARG" ]; then INSTANCE_ARG=$1; else die $E_INVALID_INPUT "Unexpected argument: $1"; fi;;
    esac
    shift
  done
  if [ "$CMD" = status ] && { [ $FORCE -eq 1 ] || [ $YES -eq 1 ]; }; then
    die $E_INVALID_INPUT "status changes nothing and takes neither --force nor --yes"
  fi
}

# ---- bundle ------------------------------------------------------------------

CONF=""
PAYLOAD_COUNT=0
BUNDLE_ID=""
TOOL_VERSION=""
PACK_LABEL=""

load_bundle() {
  local fmt n p s z ss
  if [ -z "$BUNDLE" ]; then
    BUNDLE=$(cd -- "$(dirname -- "$0")/.." && pwd)
  fi
  [ -d "$BUNDLE" ] || die $E_BUNDLE "No bundle directory at $BUNDLE" "Point --bundle at the extracted bundle directory."
  CONF="$BUNDLE/scripts/installer.conf"
  [ -f "$CONF" ] || die $E_BUNDLE "No scripts/installer.conf in $BUNDLE" "Extract the whole ZIP, keeping its directory structure."
  if grep -q "$(printf '\\r')" "$CONF"; then die $E_BUNDLE "installer.conf contains carriage returns"; fi

  fmt=$(kv_get "$CONF" format)
  [ "$fmt" = "$CONF_FORMAT" ] || die $E_BUNDLE "installer.conf declares format '$fmt'; this script understands $CONF_FORMAT" "Use the scripts that came inside this bundle."
  [ "$(kv_get "$CONF" tool)" = "$TOOL_NAME" ] || die $E_BUNDLE "installer.conf was not written by $TOOL_NAME"
  [ "$(kv_get "$CONF" stateDir)" = "$STATE_DIR_NAME" ] || die $E_BUNDLE "installer.conf names a state directory this script does not use"
  BUNDLE_ID=$(kv_get "$CONF" bundleId)
  case "$BUNDLE_ID" in
    ""|*[!A-Za-z0-9._-]*) die $E_BUNDLE "installer.conf has an unusable bundleId";;
  esac
  if printf '%s' "$BUNDLE_ID" | grep -Eq '^\\.+$'; then die $E_BUNDLE "installer.conf has an unusable bundleId"; fi
  [ \${#BUNDLE_ID} -le 120 ] || die $E_BUNDLE "installer.conf has an unusable bundleId"
  TOOL_VERSION=$(kv_get "$CONF" toolVersion)
  [ -n "$TOOL_VERSION" ] || die $E_BUNDLE "installer.conf has no toolVersion"
  PACK_LABEL="$(kv_get "$CONF" packName) $(kv_get "$CONF" packVersion)"

  PAYLOAD_COUNT=$(kv_get "$CONF" payloadCount)
  is_uint "$PAYLOAD_COUNT" && [ "$PAYLOAD_COUNT" -ge 1 ] || die $E_BUNDLE "installer.conf declares no payload"
  n=1
  while [ "$n" -le "$PAYLOAD_COUNT" ]; do
    p=$(kv_get "$CONF" "payload.$n.path")
    printf '%s' "$p" | grep -Eq '^config/ftbquests/quests/lang/[A-Za-z0-9._-]+\\.snbt$' \\
      || die $E_BUNDLE "installer.conf declares the payload path '$p', which is not a .snbt file directly inside config/ftbquests/quests/lang" "This installer only ever writes quest localisation files."
    s=$(kv_get "$CONF" "payload.$n.sha256")
    is_hex64 "$s" || die $E_BUNDLE "installer.conf payload.$n.sha256 is not a SHA-256"
    z=$(kv_get "$CONF" "payload.$n.sizeBytes")
    is_uint "$z" || die $E_BUNDLE "installer.conf payload.$n.sizeBytes is not a number"
    ss=$(kv_get "$CONF" "payload.$n.sourceSha256")
    is_hex64 "$ss" || die $E_BUNDLE "installer.conf payload.$n.sourceSha256 is not a SHA-256"
    n=$((n + 1))
  done
}

payload_conf() { kv_get "$CONF" "payload.$1.$2"; }

verify_payload_file() {
  local p f
  # verify_payload_file <n> -> checks payload/<path> against the conf
  p=$(payload_conf "$1" path)
  f="$BUNDLE/payload/$p"
  [ ! -L "$f" ] || die $E_BUNDLE "payload/$p is a symbolic link"
  [ -f "$f" ] || die $E_BUNDLE "The bundle is missing the payload file payload/$p" "The bundle is incomplete; extract it again, keeping the whole directory."
  [ "$(size_of "$f")" = "$(payload_conf "$1" sizeBytes)" ] || die $E_BUNDLE "payload/$p is not the size installer.conf declares" "The bundle is corrupt or has been tampered with; download it again."
  [ "$(digest_of "$f")" = "$(payload_conf "$1" sha256)" ] || die $E_BUNDLE "payload/$p does not match the digest in installer.conf" "The bundle is corrupt or has been tampered with; download it again."
}

# ---- instance ----------------------------------------------------------------

INSTANCE=""
STATE=""
BACKUPS=""
INSTALLS=""

is_instance() {
  [ -d "$1/mods" ] && [ ! -L "$1/mods" ] && [ -d "$1/config" ] && [ ! -L "$1/config" ]
}

resolve_instance() {
  local raw
  raw=$1
  case "$raw" in
    "~") raw=\${HOME-};;
    "~/"*) raw="\${HOME-}/\${raw#\\~/}";;
  esac
  [ -n "$raw" ] || die $E_INVALID_INPUT "No instance path given"
  [ -d "$raw" ] || die $E_INSTANCE "$raw is not a directory" "Pass the Minecraft instance folder: the one holding mods/ and config/."
  if is_instance "$raw"; then INSTANCE=$raw
  elif is_instance "$raw/.minecraft"; then INSTANCE="$raw/.minecraft"; say "using $INSTANCE"
  elif is_instance "$raw/minecraft"; then INSTANCE="$raw/minecraft"; say "using $INSTANCE"
  else
    die $E_INSTANCE "$raw is not a Minecraft instance: it has no mods/ and config/ directories" "Pass the instance folder itself (the one holding mods/, config/ and saves/). A Prism/MultiMC folder holding .minecraft/ or minecraft/ is accepted too."
  fi
  INSTANCE=$(cd -- "$INSTANCE" && pwd -P)
  STATE="$INSTANCE/$STATE_DIR_NAME"
  BACKUPS="$STATE/backups"
  INSTALLS="$STATE/installed"
}

assert_real_path() {
  local rest kind acc seg
  # assert_real_path <relative path> <dir|file>: every existing component under
  # the instance is a real directory (or, for the last one, a real file), never
  # a symbolic link. Stops at the first component that does not exist.
  rest=$1
  kind=$2
  acc=$INSTANCE
  while [ -n "$rest" ]; do
    seg=\${rest%%/*}
    if [ "$seg" = "$rest" ]; then rest=""; else rest=\${rest#*/}; fi
    case "$seg" in ""|.|..) die $E_BUNDLE "Unsafe path component in $1";; esac
    acc="$acc/$seg"
    [ ! -L "$acc" ] || die $E_INSTANCE "$acc is a symbolic link, which this installer will not follow" "The installer writes only inside the instance. Replace the link with a real directory or file."
    if [ -e "$acc" ]; then
      if [ -n "$rest" ] || [ "$kind" = dir ]; then
        [ -d "$acc" ] || die $E_INSTANCE "$acc is not a directory"
      else
        [ -f "$acc" ] || die $E_INSTANCE "$acc is not a regular file"
      fi
    else
      return 0
    fi
  done
}

assert_contained() {
  local phys
  # assert_contained <existing directory>: its physical path is inside the instance.
  phys=$(cd -- "$1" && pwd -P)
  case "$phys" in
    "$INSTANCE"|"$INSTANCE"/*) ;;
    *) die $E_INSTANCE "$1 resolves to $phys, outside the instance";;
  esac
}

ensure_dir() {
  local full
  # ensure_dir <relative path>: create one level, never recursively, and re-check.
  assert_real_path "$1" dir
  full="$INSTANCE/$1"
  if [ ! -e "$full" ]; then
    mkdir -- "$full" || die $E_WRITE "Could not create $full"
    fsync_path "$(dirname -- "$full")"
  fi
  assert_real_path "$1" dir
  assert_contained "$full"
}

ensure_state_dirs() {
  ensure_dir "$STATE_DIR_NAME"
  ensure_dir "$STATE_DIR_NAME/backups"
  ensure_dir "$STATE_DIR_NAME/installed"
}

target_dir_of() { dirname -- "$INSTANCE/$1"; }

ensure_target_dir() {
  local d acc rest seg
  # ensure_target_dir <relative payload path>: config/ftbquests/quests/lang, one level at a time.
  d=$(dirname -- "$1")
  acc=""
  rest=$d
  while [ -n "$rest" ]; do
    seg=\${rest%%/*}
    if [ "$seg" = "$rest" ]; then rest=""; else rest=\${rest#*/}; fi
    if [ -z "$acc" ]; then acc=$seg; else acc="$acc/$seg"; fi
    ensure_dir "$acc"
  done
}

legacy_names_target() {
  local f
  # The executable installer's state.json keys installs by target path.
  f="$INSTANCE/$LEGACY_DIR_NAME/state.json"
  [ -f "$f" ] && [ ! -L "$f" ] && grep -Fq "\\"$1\\":" "$f"
}

# ---- copies and transactions --------------------------------------------------

write_copy() {
  local src dst want tmp
  # write_copy <src> <dst> <expected sha>: copy, flush, verify, publish no-clobber.
  src=$1; dst=$2; want=$3
  tmp="$dst.tmp-$$"
  rm -f -- "$tmp"
  cp -- "$src" "$tmp" || { rm -f -- "$tmp"; die $E_WRITE "Could not copy $src to $tmp"; }
  fsync_path "$tmp"
  [ "$(digest_of "$tmp")" = "$want" ] || { rm -f -- "$tmp"; die $E_TARGET_MODIFIED "$src changed while it was being copied; nothing was changed"; }
  if ! ln -- "$tmp" "$dst" 2>/dev/null; then
    rm -f -- "$tmp"
    die $E_WRITE "Could not create $dst (it may already exist)"
  fi
  rm -f -- "$tmp"
  fsync_path "$dst"
  fsync_path "$(dirname -- "$dst")"
}

write_text() {
  local tmp
  # write_text <dst> <text>: durable, replacing (only for files this installer owns).
  tmp="$1.tmp-$$"
  printf '%s' "$2" > "$tmp" || die $E_WRITE "Could not write $tmp"
  fsync_path "$tmp"
  mv -f -- "$tmp" "$1" || { rm -f -- "$tmp"; die $E_WRITE "Could not write $1"; }
  fsync_path "$(dirname -- "$1")"
}

probe_hardlinks() {
  local probe
  # The no-clobber publish needs link(2). Refuse a filesystem without it before
  # anything is moved, rather than falling back to a rename that can overwrite.
  probe="$1/.mqt-probe-$$"
  rm -f -- "$probe" "$probe.link"
  : > "$probe" || die $E_WRITE "Cannot write in $1"
  if ! ln -- "$probe" "$probe.link" 2>/dev/null; then
    rm -f -- "$probe"
    die $E_WRITE "$1 is on a filesystem without hard links (FAT32?), so a file cannot be published without risking an overwrite" "Move the instance to ext4, NTFS, APFS or btrfs."
  fi
  rm -f -- "$probe" "$probe.link"
}

put_back() {
  # put_back <staged> <target>: no-clobber. Leaves the staged copy if the name is taken.
  if ln -- "$1" "$2" 2>/dev/null; then rm -f -- "$1"; return 0; fi
  warn "$2 was taken by another file; the previous one is kept at $1"
  return 1
}

publish() {
  local target src want expect dir base staged tmp got
  # publish <target> <src file> <src sha> <expected current sha | absent>
  # The bytes at <target> are moved aside, digested against what this run
  # agreed to replace, and only then is <src> linked into the now-absent name.
  # Whatever appears at the name in between wins, and nothing is written over.
  target=$1; src=$2; want=$3; expect=$4
  dir=$(dirname -- "$target"); base=$(basename -- "$target")
  staged="$dir/$base.mqt-staged"
  tmp="$dir/$base.mqt-tmp-$$"
  rm -f -- "$tmp"
  cp -- "$src" "$tmp" || { rm -f -- "$tmp"; die $E_WRITE "Could not write $tmp"; }
  fsync_path "$tmp"
  [ "$(digest_of "$tmp")" = "$want" ] || { rm -f -- "$tmp"; die $E_WRITE "$tmp does not verify after writing"; }
  if [ "$expect" != absent ]; then
    if [ -e "$staged" ] || [ -L "$staged" ]; then rm -f -- "$tmp"; die $E_INSTANCE "A leftover $staged is in the way"; fi
    [ ! -L "$target" ] || { rm -f -- "$tmp"; die $E_INSTANCE "$target became a symbolic link"; }
    if ! mv -- "$target" "$staged" 2>/dev/null; then
      rm -f -- "$tmp"
      die $E_TARGET_MODIFIED "$target vanished while the installer was working; nothing was changed"
    fi
    got=$(digest_of "$staged")
    if [ "$got" != "$expect" ]; then
      put_back "$staged" "$target" || true
      rm -f -- "$tmp"
      die $E_TARGET_MODIFIED "$target changed while the installer was working; nothing was written over" "Close Minecraft and anything else writing to the instance, then run this again."
    fi
  else
    if [ -e "$target" ] || [ -L "$target" ]; then rm -f -- "$tmp"; die $E_TARGET_MODIFIED "$target appeared while the installer was working; it is left as it is"; fi
  fi
  if ! ln -- "$tmp" "$target" 2>/dev/null; then
    rm -f -- "$tmp"
    if [ "$expect" != absent ]; then put_back "$staged" "$target" || true; fi
    die $E_TARGET_MODIFIED "Another file appeared at $target in the last instant; it wins and is left untouched" "Close Minecraft and anything else writing to the instance, then run this again."
  fi
  rm -f -- "$tmp"
  if [ "$expect" != absent ]; then rm -f -- "$staged"; fi
  fsync_path "$target"
  fsync_path "$dir"
}

unpublish() {
  local target expect dir base staged got
  # unpublish <target> <expected sha>: delete, through the same move-aside step.
  target=$1; expect=$2
  dir=$(dirname -- "$target"); base=$(basename -- "$target")
  staged="$dir/$base.mqt-staged"
  if [ -e "$staged" ] || [ -L "$staged" ]; then die $E_INSTANCE "A leftover $staged is in the way"; fi
  [ ! -L "$target" ] || die $E_INSTANCE "$target became a symbolic link"
  mv -- "$target" "$staged" 2>/dev/null || die $E_TARGET_MODIFIED "$target vanished while the installer was working"
  got=$(digest_of "$staged")
  if [ "$got" != "$expect" ]; then
    put_back "$staged" "$target" || true
    die $E_TARGET_MODIFIED "$target changed while the installer was working; nothing was deleted"
  fi
  rm -f -- "$staged"
  fsync_path "$dir"
}

# ---- backups -----------------------------------------------------------------

backup_meta_ok() {
  # backup_meta_ok <meta file> <kind> <target rel> <sha> <size>
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  [ "$(kv_get "$1" kind)" = "$2" ] || return 1
  [ "$(kv_get "$1" target)" = "$3" ] || return 1
  [ "$(kv_get "$1" sha256)" = "$4" ] || return 1
  [ "$(kv_get "$1" sizeBytes)" = "$5" ] || return 1
}

BACKUP_NAME=""
capture_backup() {
  local rel kind sha size src base name file
  # capture_backup <target rel> <kind original|modified|displaced> <sha> <size> [<source file>]
  # Backups are named by digest, so an identical one is reused rather than
  # duplicated, and a different original never collides with an old one.
  rel=$1; kind=$2; sha=$3; size=$4; src=\${5:-$INSTANCE/$1}
  base=$(basename -- "$rel")
  name="$base.$(short "$sha").$kind.bak"
  case "$name" in *[!A-Za-z0-9._-]*) die $E_INTERNAL "Unusable backup name $name";; esac
  assert_real_path "$STATE_DIR_NAME/backups/$name" file
  assert_real_path "$STATE_DIR_NAME/backups/$name.meta" file
  file="$BACKUPS/$name"
  if [ -e "$file" ]; then
    if [ "$(digest_of "$file")" = "$sha" ] && [ "$(size_of "$file")" = "$size" ] && backup_meta_ok "$file.meta" "$kind" "$rel" "$sha" "$size"; then
      # Reused: its bytes verify, but out of the page cache. Flush it again.
      fsync_path "$file"; fsync_path "$file.meta"; fsync_path "$BACKUPS"
      say "reusing the existing backup $name"
    else
      die $E_BACKUP "A backup named $name exists but does not verify; refusing to reuse or replace it" "Move it out of $BACKUPS by hand (do not delete it) and run this again."
    fi
  else
    write_copy "$src" "$file" "$sha"
    rm -f -- "$file.meta"
    write_copy_text "$file.meta" "format=1
kind=$kind
target=$rel
sha256=$sha
sizeBytes=$size
capturedAt=$(now_iso)
bundleId=$BUNDLE_ID
toolVersion=$TOOL_VERSION
"
    say "backed up $(basename -- "$rel") -> $STATE_DIR_NAME/backups/$name"
  fi
  BACKUP_NAME=$name
}

write_copy_text() {
  local tmp
  # write_copy_text <dst> <text>: durable, no-clobber (backups are append-only).
  tmp="$1.tmp-$$"
  rm -f -- "$tmp"
  printf '%s' "$2" > "$tmp" || die $E_WRITE "Could not write $tmp"
  fsync_path "$tmp"
  if ! ln -- "$tmp" "$1" 2>/dev/null; then rm -f -- "$tmp"; die $E_WRITE "Could not create $1"; fi
  rm -f -- "$tmp"
  fsync_path "$1"
  fsync_path "$(dirname -- "$1")"
}

capture_absent() {
  local rel base name meta
  # capture_absent <target rel>: the sentinel for "there was no file".
  rel=$1
  base=$(basename -- "$rel")
  name="$base.absent"
  assert_real_path "$STATE_DIR_NAME/backups/$name.meta" file
  meta="$BACKUPS/$name.meta"
  if [ -e "$meta" ]; then
    [ "$(kv_get "$meta" kind)" = absent ] && [ "$(kv_get "$meta" target)" = "$rel" ] || die $E_BACKUP "$meta exists but is not an absent sentinel for $rel"
    fsync_path "$meta"
  else
    write_copy_text "$meta" "format=1
kind=absent
target=$rel
sha256=
sizeBytes=0
capturedAt=$(now_iso)
bundleId=$BUNDLE_ID
toolVersion=$TOOL_VERSION
"
    say "recorded that $(basename -- "$rel") did not exist before"
  fi
  BACKUP_NAME=$name
}

verify_backup() {
  local name rel sha file msize msha
  # verify_backup <name> <target rel> <expected sha> -> sets VERIFIED_FILE, or dies E_BACKUP
  name=$1; rel=$2; sha=$3
  case "$name" in *[!A-Za-z0-9._-]*|"") die $E_BACKUP "The install record names an unusable backup";; esac
  assert_real_path "$STATE_DIR_NAME/backups/$name" file
  assert_real_path "$STATE_DIR_NAME/backups/$name.meta" file
  file="$BACKUPS/$name"
  [ -f "$file" ] || die $E_BACKUP "The backup $name is missing from $BACKUPS; nothing was changed" "Without it the pack's own file cannot be restored. Look for it in a copy of the instance."
  [ -f "$file.meta" ] || die $E_BACKUP "The backup $name has no .meta record; nothing was changed"
  msize=$(kv_get "$file.meta" sizeBytes)
  msha=$(kv_get "$file.meta" sha256)
  [ "$(kv_get "$file.meta" target)" = "$rel" ] || die $E_BACKUP "The backup $name is for a different file; nothing was changed"
  [ "$msha" = "$sha" ] || die $E_BACKUP "The backup $name is not the one the install record names; nothing was changed"
  [ "$(size_of "$file")" = "$msize" ] || die $E_BACKUP "The backup $name is $(size_of "$file") bytes but was recorded as $msize (truncated?); nothing was changed"
  [ "$(digest_of "$file")" = "$sha" ] || die $E_BACKUP "The backup $name does not match its recorded digest; nothing was changed"
  VERIFIED_FILE=$file
}

verify_recorded_backup() {
  local rel name osha base meta
  # verify_recorded_backup <target rel> <backup name> <original sha> -> RESTORE_KIND
  # (absent|original) and, for original, VERIFIED_FILE; or dies E_BACKUP.
  # What a record names is checked before anything is changed: an install,
  # an upgrade and an uninstall all rely on it to put the pack's file back.
  rel=$1; name=$2; osha=$3
  base=$(basename -- "$rel")
  if [ "$name" = "$base.absent" ]; then
    RESTORE_KIND=absent
    assert_real_path "$STATE_DIR_NAME/backups/$name.meta" file
    meta="$BACKUPS/$name.meta"
    [ -f "$meta" ] || die $E_BACKUP "The record says there was no file before install, but the sentinel $name.meta is missing; nothing was changed" "Without it there is no way to tell what to put back. Look for it in a copy of the instance."
    [ "$(kv_get "$meta" kind)" = absent ] && [ "$(kv_get "$meta" target)" = "$rel" ] || die $E_BACKUP "The sentinel $name.meta is not an absent record for $rel; nothing was changed"
    [ -z "$osha" ] || die $E_BACKUP "The install record names the absent sentinel but also an original digest; nothing was changed"
  else
    RESTORE_KIND=original
    is_hex64 "$osha" || die $E_BACKUP "The install record has no usable original digest; nothing was changed"
    verify_backup "$name" "$rel" "$osha"
  fi
}

count_restorable() {
  local rel base n meta
  # count_restorable <target rel> -> number of original/absent backups for it, and ONLY_BACKUP/ONLY_SHA
  rel=$1; base=$(basename -- "$rel")
  n=0; ONLY_BACKUP=""; ONLY_SHA=""
  for meta in "$BACKUPS/$base".*.original.bak.meta "$BACKUPS/$base.absent.meta"; do
    [ -f "$meta" ] || continue
    [ ! -L "$meta" ] || continue
    [ "$(kv_get "$meta" target)" = "$rel" ] || continue
    n=$((n + 1))
    ONLY_BACKUP=$(basename -- "$meta" .meta)
    ONLY_SHA=$(kv_get "$meta" sha256)
  done
  RESTORABLE=$n
}

# ---- install records ----------------------------------------------------------

record_path() { printf '%s' "$INSTALLS/$(basename -- "$1").meta"; }

read_record() {
  local r
  # read_record <target rel> -> REC_* or REC_PRESENT=0
  REC_PRESENT=0; REC_SHA=""; REC_BACKUP=""; REC_ORIG_SHA=""; REC_BUNDLE=""
  r=$(record_path "$1")
  assert_real_path "$STATE_DIR_NAME/installed/$(basename -- "$1").meta" file
  [ -f "$r" ] || return 0
  [ "$(kv_get "$r" target)" = "$1" ] || die $E_BACKUP "$r is for a different file"
  REC_SHA=$(kv_get "$r" installedSha256)
  is_hex64 "$REC_SHA" || { warn "$r has no usable installedSha256; treating it as absent"; return 0; }
  REC_BACKUP=$(kv_get "$r" originalBackup)
  REC_ORIG_SHA=$(kv_get "$r" originalSha256)
  REC_BUNDLE=$(kv_get "$r" bundleId)
  REC_PRESENT=1
}

write_record() {
  local r
  # write_record <target rel> <installed sha> <backup name> <original sha>
  r=$(record_path "$1")
  write_text "$r" "format=1
target=$1
bundleId=$BUNDLE_ID
installedSha256=$2
installedAt=$(now_iso)
originalBackup=$3
originalSha256=$4
toolVersion=$TOOL_VERSION
"
}

append_history() {
  printf '%s %s %s %s\\n' "$(now_iso)" "$1" "$2" "$3" >> "$STATE/history.log" 2>/dev/null || true
}

# ---- leftovers ----------------------------------------------------------------

recover_leftovers() {
  local rel target dir base staged f sha
  # A run that died between moving the file aside and publishing leaves
  # <target>.mqt-staged. Put it back if the name is free; keep it as a
  # 'displaced' backup if something has taken the name since.
  rel=$1
  target="$INSTANCE/$rel"
  dir=$(dirname -- "$target"); base=$(basename -- "$target")
  staged="$dir/$base.mqt-staged"
  [ -d "$dir" ] || return 0
  for f in "$dir/$base".mqt-tmp-*; do
    [ -e "$f" ] || continue
    [ ! -L "$f" ] || continue
    # status reports and changes nothing, leftovers included.
    if [ "$CMD" = status ]; then
      warn "$f is a leftover temporary file from an interrupted run; the next install or uninstall will remove it"
      continue
    fi
    rm -f -- "$f"
    warn "removed a leftover temporary file $f"
  done
  [ -e "$staged" ] || [ -L "$staged" ] || return 0
  [ ! -L "$staged" ] || die $E_INSTANCE "$staged is a symbolic link"
  if [ ! -e "$target" ] && [ ! -L "$target" ]; then
    if [ "$CMD" = status ]; then
      warn "$staged was left by an interrupted run; the next install or uninstall will put it back"
      return 0
    fi
    put_back "$staged" "$target" || die $E_TARGET_MODIFIED "Could not put $staged back"
    fsync_path "$dir"
    warn "put $staged back as $base after an interrupted run"
  else
    if [ "$CMD" = status ]; then
      warn "$staged was left by an interrupted run and $base has since been replaced; the next install or uninstall will keep it in backups/"
      return 0
    fi
    ensure_state_dirs
    sha=$(digest_of "$staged")
    capture_backup "$rel" displaced "$sha" "$(size_of "$staged")" "$staged"
    rm -f -- "$staged"
    warn "$base had been replaced since an interrupted run; the displaced file is kept as $STATE_DIR_NAME/backups/$BACKUP_NAME"
  fi
}

# ---- prompts -----------------------------------------------------------------

confirm() {
  local answer
  [ $YES -eq 1 ] && return 0
  [ -t 0 ] || return 0
  printf '%s' "続行しますか / Continue? [y/N]: "
  read -r answer || answer=""
  case "$answer" in y|Y|yes|YES|はい) return 0;; esac
  say "中止しました。何も変更していません。 / Cancelled. Nothing was changed."
  exit 0
}

ask_instance() {
  if [ -n "$INSTANCE_ARG" ]; then return 0; fi
  [ -t 0 ] || die $E_INVALID_INPUT "--instance is required when there is no terminal to ask on"
  say "Minecraft のインスタンスのフォルダーのパスを入力してください。"
  say "Enter the path to your Minecraft instance folder."
  printf '> '
  read -r INSTANCE_ARG || INSTANCE_ARG=""
  if [ -z "$INSTANCE_ARG" ]; then
    say "中止しました。何も変更していません。 / Cancelled. Nothing was changed."
    exit 0
  fi
}

# ---- install -----------------------------------------------------------------

do_install() {
  local n
  n=1
  while [ "$n" -le "$PAYLOAD_COUNT" ]; do verify_payload_file "$n"; n=$((n + 1)); done
  # The state directories are created only once a target has been classified
  # and confirmed: a refused install leaves the instance exactly as it was.
  if [ -d "$STATE" ]; then assert_real_path "$STATE_DIR_NAME" dir; fi
  n=1
  while [ "$n" -le "$PAYLOAD_COUNT" ]; do install_one "$n"; n=$((n + 1)); done
}

install_one() {
  local rel psha ssha src target base action backup osha expect cur
  rel=$(payload_conf "$1" path)
  psha=$(payload_conf "$1" sha256)
  ssha=$(payload_conf "$1" sourceSha256)
  src="$BUNDLE/payload/$rel"
  target="$INSTANCE/$rel"
  base=$(basename -- "$rel")

  ensure_target_dir "$rel"
  assert_real_path "$rel" file
  assert_contained "$(target_dir_of "$rel")"
  recover_leftovers "$rel"
  assert_real_path "$rel" file
  read_record "$rel"

  action=""; backup=""; osha=""; expect=absent; cur=""
  if [ -e "$target" ]; then
    cur=$(digest_of "$target")
    expect=$cur
    if [ "$cur" = "$psha" ]; then
      if [ $REC_PRESENT -eq 1 ]; then
        say "すでに導入済みです。変更はありません。 / Already installed: $rel is this bundle's file. Nothing to do."
        return 0
      fi
      legacy_names_target "$rel" && die $E_INSTANCE "$rel already holds this translation, and it was installed by the executable installer ($LEGACY_DIR_NAME/state.json records it)" "$MIGRATION_HINT"
      count_restorable "$rel"
      if [ "$RESTORABLE" -eq 1 ]; then
        verify_recorded_backup "$rel" "$ONLY_BACKUP" "$ONLY_SHA"
        say "$rel already holds this bundle's file and one original backup is on record; recording the install"
        ensure_state_dirs
        write_record "$rel" "$psha" "$ONLY_BACKUP" "$ONLY_SHA"
        append_history install "$rel" "$ONLY_BACKUP"
        return 0
      fi
      die $E_INSTANCE "$rel already holds this translation, but this installer has no record of installing it and no backup of the pack's own file" "$MIGRATION_HINT"
    fi
    if [ $REC_PRESENT -eq 1 ]; then
      if [ "$cur" = "$REC_SHA" ]; then
        action=upgrade; backup=$REC_BACKUP; osha=$REC_ORIG_SHA
      elif [ $FORCE -eq 1 ]; then
        action=force-upgrade; backup=$REC_BACKUP; osha=$REC_ORIG_SHA
      else
        die $E_TARGET_MODIFIED "$rel was edited after it was installed; refusing to overwrite the edit" "Run again with --force to keep a copy of the edited file in $STATE_DIR_NAME/backups/ and install over it."
      fi
    else
      legacy_names_target "$rel" && die $E_INSTANCE "$rel is recorded as installed by the executable installer ($LEGACY_DIR_NAME/state.json)" "$MIGRATION_HINT"
      if [ "$cur" = "$ssha" ]; then
        action=first
      elif [ -e "$BACKUPS/$base.$(short "$cur").original.bak" ]; then
        action=first
      elif [ $FORCE -eq 1 ]; then
        warn "$rel is not the file this translation was made from; installing anyway because of --force"
        action=first
      else
        die $E_SOURCE_MISMATCH "$rel is not the quest file this translation was made from ($PACK_LABEL): its SHA-256 is $cur, expected $ssha" "The modpack is probably a different version, or the file was already changed. A translation for another version can break quests. To install anyway, run again with --force; the file is backed up first either way."
      fi
    fi
  else
    if [ $REC_PRESENT -eq 1 ]; then
      action=upgrade; backup=$REC_BACKUP; osha=$REC_ORIG_SHA
      expect=absent
    else
      legacy_names_target "$rel" && die $E_INSTANCE "$rel is recorded as installed by the executable installer ($LEGACY_DIR_NAME/state.json)" "$MIGRATION_HINT"
      action=first-absent
    fi
  fi

  case "$action" in
    upgrade|force-upgrade)
      # The record is trusted only once what it names verifies: without the
      # original (or its absent sentinel) an upgrade could never be undone.
      verify_recorded_backup "$rel" "$backup" "$osha";;
  esac

  say "対象 / target: $target"
  confirm
  ensure_state_dirs
  probe_hardlinks "$(target_dir_of "$rel")"

  case "$action" in
    first)
      capture_backup "$rel" original "$cur" "$(size_of "$target")"
      backup=$BACKUP_NAME; osha=$cur;;
    first-absent)
      capture_absent "$rel"
      backup=$BACKUP_NAME; osha="";;
    force-upgrade)
      capture_backup "$rel" modified "$cur" "$(size_of "$target")"
      say "kept the edited file as $STATE_DIR_NAME/backups/$BACKUP_NAME";;
    upgrade) ;;
  esac

  assert_real_path "$rel" file
  publish "$target" "$src" "$psha" "$expect"
  write_record "$rel" "$psha" "$backup" "$osha"
  append_history install "$rel" "$backup"
  say "導入しました / Installed: $rel"
}

# ---- uninstall ---------------------------------------------------------------

do_uninstall() {
  local n
  # No directories are created here: an uninstall with nothing installed must
  # leave the instance exactly as it found it.
  if [ -d "$STATE" ]; then assert_real_path "$STATE_DIR_NAME" dir; fi
  n=1
  while [ "$n" -le "$PAYLOAD_COUNT" ]; do uninstall_one "$n"; n=$((n + 1)); done
}

uninstall_one() {
  local rel psha target base cur action kind r
  rel=$(payload_conf "$1" path)
  psha=$(payload_conf "$1" sha256)
  target="$INSTANCE/$rel"
  base=$(basename -- "$rel")

  assert_real_path "$rel" file
  [ -d "$(target_dir_of "$rel")" ] && assert_contained "$(target_dir_of "$rel")"
  recover_leftovers "$rel"
  assert_real_path "$rel" file
  read_record "$rel"

  cur=""
  if [ -e "$target" ]; then cur=$(digest_of "$target"); fi

  if [ $REC_PRESENT -eq 0 ]; then
    if [ -n "$cur" ] && [ "$cur" = "$psha" ]; then
      legacy_names_target "$rel" && die $E_INSTANCE "$rel was installed by the executable installer, not by these scripts" "$MIGRATION_HINT"
      count_restorable "$rel"
      if [ "$RESTORABLE" -eq 1 ]; then
        warn "no install record for $rel, but the file is this bundle's and one original backup is on record; using it"
        REC_SHA=$psha; REC_BACKUP=$ONLY_BACKUP; REC_ORIG_SHA=$ONLY_SHA
      elif [ "$RESTORABLE" -gt 1 ]; then
        die $E_BACKUP "no install record for $rel and $RESTORABLE original backups to choose from; refusing to guess" "Look in $BACKUPS and restore the right one by hand."
      else
        die $E_INSTANCE "$rel holds this translation but nothing here installed it" "$MIGRATION_HINT"
      fi
    else
      die $E_NOT_INSTALLED "Nothing from this bundle is installed at $rel"
    fi
  fi

  action=restore
  if [ -z "$cur" ]; then
    if [ $FORCE -eq 1 ]; then
      warn "$rel is missing; restoring the original anyway because of --force"
    else
      die $E_TARGET_MODIFIED "$rel was installed but is now missing" "Run again with --force to restore the original anyway."
    fi
  elif [ "$cur" != "$REC_SHA" ]; then
    if [ $FORCE -eq 1 ]; then action=force-restore
    else die $E_TARGET_MODIFIED "$rel was edited after it was installed; refusing to discard the edit" "Run again with --force to keep a copy of the edited file in $STATE_DIR_NAME/backups/ and restore the original over it."
    fi
  fi

  verify_recorded_backup "$rel" "$REC_BACKUP" "$REC_ORIG_SHA"
  kind=$RESTORE_KIND

  say "対象 / target: $target"
  confirm
  probe_hardlinks "$(target_dir_of "$rel")"

  if [ "$action" = force-restore ]; then
    ensure_state_dirs
    capture_backup "$rel" modified "$cur" "$(size_of "$target")"
    say "kept the edited file as $STATE_DIR_NAME/backups/$BACKUP_NAME"
  fi
  assert_real_path "$rel" file
  if [ "$kind" = absent ]; then
    if [ -n "$cur" ]; then unpublish "$target" "$cur"; fi
    say "削除しました / Removed $rel (there was no file before install)"
  else
    if [ -n "$cur" ]; then publish "$target" "$VERIFIED_FILE" "$REC_ORIG_SHA" "$cur"
    else publish "$target" "$VERIFIED_FILE" "$REC_ORIG_SHA" absent; fi
    say "元に戻しました / Restored $rel from $STATE_DIR_NAME/backups/$REC_BACKUP"
  fi
  r=$(record_path "$rel")
  rm -f -- "$r"
  fsync_path "$INSTALLS"
  append_history uninstall "$rel" "$REC_BACKUP"
}

# ---- status ------------------------------------------------------------------

do_status() {
  local n rel psha ssha target cur state meta
  say "bundle:   $BUNDLE_ID ($PACK_LABEL)"
  say "instance: $INSTANCE"
  n=1
  while [ "$n" -le "$PAYLOAD_COUNT" ]; do
    rel=$(payload_conf "$n" path)
    psha=$(payload_conf "$n" sha256)
    ssha=$(payload_conf "$n" sourceSha256)
    target="$INSTANCE/$rel"
    assert_real_path "$rel" file
    recover_leftovers "$rel"
    if [ -d "$STATE" ]; then
      assert_real_path "$STATE_DIR_NAME" dir
      [ -d "$INSTALLS" ] && read_record "$rel" || REC_PRESENT=0
    else
      REC_PRESENT=0
    fi
    say "target:   $rel"
    if [ -e "$target" ]; then
      cur=$(digest_of "$target")
      if [ "$cur" = "$psha" ]; then state="this bundle's translation"
      elif [ "$cur" = "$ssha" ]; then state="the pack's own file (not installed)"
      elif [ $REC_PRESENT -eq 1 ] && [ "$cur" = "$REC_SHA" ]; then state="an earlier translation of this tool"
      elif [ $REC_PRESENT -eq 1 ]; then state="MODIFIED after install"
      else state="a file this installer does not recognise"
      fi
      say "  file:   present, $state ($cur)"
    else
      say "  file:   absent"
    fi
    if [ $REC_PRESENT -eq 1 ]; then
      say "  record: installed from $REC_BUNDLE, original backup $REC_BACKUP"
    else
      say "  record: none"
    fi
    if legacy_names_target "$rel"; then say "  note:   the executable installer also records an install here ($LEGACY_DIR_NAME/state.json)"; fi
    if [ -d "$BACKUPS" ]; then
      for meta in "$BACKUPS/$(basename -- "$rel")".*.meta; do
        [ -f "$meta" ] || continue
        say "  backup: $(basename -- "$meta" .meta) ($(kv_get "$meta" kind), $(kv_get "$meta" capturedAt))"
      done
    fi
    n=$((n + 1))
  done
}

# ---- main --------------------------------------------------------------------

main() {
  parse_args "$@"
  detect_tools
  load_bundle
  ask_instance
  resolve_instance "$INSTANCE_ARG"
  case "$CMD" in
    install) do_install;;
    uninstall) do_uninstall;;
    status) do_status;;
  esac
}

main "$@"
`;
