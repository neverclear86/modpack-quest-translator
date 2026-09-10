/**
 * The Windows PowerShell installer, shipped as `scripts/mqt-installer.ps1`.
 *
 * Written for Windows PowerShell 5.1 -- the one every Windows 10 and 11 has --
 * and run by the `.cmd` launchers with `-ExecutionPolicy Bypass`, which is
 * process-scoped: nothing here or in the launchers changes a policy, a
 * registry key or a file outside the instance. It mirrors `posix.ts` step
 * for step; a change to one is a change to both.
 *
 * The packager writes it as UTF-8 with a BOM and CRLF line endings, because
 * 5.1 reads a BOM-less `.ps1` in the system code page and the Japanese
 * strings would come out as mojibake -- or, worse, as different code.
 *
 * Nothing is downloaded, no process is started, and every cmdlet that takes
 * a path takes `-LiteralPath`, so brackets and wildcards in a path are what
 * they look like. Windows 5.1 has no directory flush a user can call, so
 * file contents are flushed with `Flush($true)` and the directory entry is
 * left to NTFS's own journal; that is documented, not hidden.
 */
const RAW = String.raw`#Requires -Version 5
<#
mqt-installer.ps1 -- script-only installer for a modpack-quest-translator bundle.

Usage: powershell -NoProfile -ExecutionPolicy Bypass -File mqt-installer.ps1
         install|uninstall|status [-BundleDir <dir>] [-Instance <path>] [-Force] [-Yes]

Exit codes: 0 ok, 2 bad arguments, 8 write failed, 10 bundle unusable,
11 not an instance / reparse point / another installer's install, 12 the
installed file was changed, 13 no usable backup, 14 nothing installed,
15 the pack's quest file is not the one this translation was made from.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = "",
  [Parameter(Position = 1)][string]$InstancePositional = "",
  [string]$BundleDir = "",
  [string]$Instance = "",
  [switch]$Force,
  [switch]$Yes
)

Set-StrictMode -Version 2
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

$STATE_DIR_NAME = ".mqt-installer-scripts"
$LEGACY_DIR_NAME = ".mqt-installer"
$CONF_FORMAT = "1"
$TOOL_NAME = "modpack-quest-translator"

$E_INTERNAL = 1
$E_INVALID_INPUT = 2
$E_WRITE = 8
$E_BUNDLE = 10
$E_INSTANCE = 11
$E_TARGET_MODIFIED = 12
$E_BACKUP = 13
$E_NOT_INSTALLED = 14
$E_SOURCE_MISMATCH = 15

$MIGRATION_HINT = "Run UNINSTALL from the bundle that installed it (the executable installer keeps its records in $LEGACY_DIR_NAME\), then run this installer. If you copied the translated file in by hand, put the pack's own file back first. / この翻訳を導入した配布物の UNINSTALL を先に実行してください。"

$Utf8 = New-Object System.Text.UTF8Encoding($false)
# "\" on Windows; "/" under pwsh on Linux, where the tests run this script.
$SEP = [string][IO.Path]::DirectorySeparatorChar

# ---- output ------------------------------------------------------------------

function Say([string]$Text) { [Console]::Out.WriteLine($Text) }
function Warn([string]$Text) { [Console]::Error.WriteLine("[warn] " + $Text) }
function Fail([int]$Code, [string]$Message, [string]$Hint = "") {
  $e = New-Object System.Exception($Message)
  $e.Data["mqtCode"] = $Code
  $e.Data["mqtHint"] = $Hint
  throw $e
}

# ---- tools -------------------------------------------------------------------

function Get-Sha256([string]$LiteralPath) {
  $h = (Get-FileHash -LiteralPath $LiteralPath -Algorithm SHA256).Hash
  if ($null -eq $h -or $h.Length -ne 64) { Fail $E_INTERNAL "Could not hash $LiteralPath" }
  return $h.ToLowerInvariant()
}
function Get-Size([string]$LiteralPath) { return (Get-Item -LiteralPath $LiteralPath -Force).Length }
function Now-Iso { return [DateTime]::UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'") }
function Short([string]$Sha) { return $Sha.Substring(0, 12) }
function Is-Hex64([string]$Value) { return ($null -ne $Value) -and ($Value -cmatch '^[0-9a-f]{64}$') }
function Is-UInt([string]$Value) { return ($null -ne $Value) -and ($Value -match '^(0|[1-9][0-9]*)$') }
function Is-Reparse([string]$LiteralPath) {
  $item = Get-Item -LiteralPath $LiteralPath -Force
  return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}
function Exists-Any([string]$LiteralPath) {
  # True for a file, a directory or a link (even a dangling one).
  if ([IO.File]::Exists($LiteralPath) -or [IO.Directory]::Exists($LiteralPath)) { return $true }
  try { $null = Get-Item -LiteralPath $LiteralPath -Force -ErrorAction Stop; return $true } catch { return $false }
}
function Is-Dir([string]$LiteralPath) { return [IO.Directory]::Exists($LiteralPath) }
function Is-File([string]$LiteralPath) { return [IO.File]::Exists($LiteralPath) }

function Write-BytesDurable([string]$LiteralPath, [byte[]]$Bytes) {
  # CreateNew: never over an existing name. Flush($true) pushes past the OS cache.
  $fs = New-Object System.IO.FileStream($LiteralPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $fs.Write($Bytes, 0, $Bytes.Length); $fs.Flush($true) } finally { $fs.Dispose() }
}
function Write-TextDurable([string]$LiteralPath, [string]$Text) {
  Write-BytesDurable $LiteralPath ($Utf8.GetBytes($Text))
}
function Remove-Quiet([string]$LiteralPath) {
  try { if (Exists-Any $LiteralPath) { [IO.File]::Delete($LiteralPath) } } catch { }
}

# ---- key=value files ----------------------------------------------------------

function Read-Kv([string]$LiteralPath) {
  $map = @{}
  $text = [IO.File]::ReadAllText($LiteralPath, $Utf8)
  foreach ($line in $text -split "\n") {
    $line = $line.TrimEnd([char]13)
    if ($line.Length -eq 0 -or $line.StartsWith("#")) { continue }
    $eq = $line.IndexOf("=")
    if ($eq -le 0) { continue }
    $key = $line.Substring(0, $eq)
    if (-not $map.ContainsKey($key)) { $map[$key] = $line.Substring($eq + 1) }
  }
  return $map
}
function Kv([hashtable]$Map, [string]$Key) {
  if ($Map.ContainsKey($Key)) { return [string]$Map[$Key] }
  return ""
}

# ---- arguments ---------------------------------------------------------------

function Usage {
  Say "usage: mqt-installer.ps1 install|uninstall|status [<instance>] [-BundleDir <dir>] [-Instance <path>] [-Force] [-Yes]"
}

# ---- bundle ------------------------------------------------------------------

$script:Bundle = ""
$script:Conf = @{}
$script:PayloadCount = 0
$script:BundleId = ""
$script:ToolVersion = ""
$script:PackLabel = ""

function Load-Bundle {
  if ($BundleDir -eq "") { $script:Bundle = (Get-Item -LiteralPath (Join-Path $PSScriptRoot "..")).FullName }
  else { $script:Bundle = $BundleDir.TrimEnd("\", "/") ; if ($script:Bundle -eq "") { $script:Bundle = $BundleDir } }
  if (-not (Is-Dir $script:Bundle)) { Fail $E_BUNDLE "No bundle directory at $script:Bundle" "Point -BundleDir at the extracted bundle directory." }
  $confPath = Join-Path (Join-Path $script:Bundle "scripts") "installer.conf"
  if (-not (Is-File $confPath)) { Fail $E_BUNDLE "No scripts\installer.conf in $script:Bundle" "Extract the whole ZIP, keeping its directory structure." }
  $script:Conf = Read-Kv $confPath
  $c = $script:Conf
  if ((Kv $c "format") -ne $CONF_FORMAT) { Fail $E_BUNDLE "installer.conf declares format '$(Kv $c 'format')'; this script understands $CONF_FORMAT" "Use the scripts that came inside this bundle." }
  if ((Kv $c "tool") -ne $TOOL_NAME) { Fail $E_BUNDLE "installer.conf was not written by $TOOL_NAME" }
  if ((Kv $c "stateDir") -ne $STATE_DIR_NAME) { Fail $E_BUNDLE "installer.conf names a state directory this script does not use" }
  $script:BundleId = Kv $c "bundleId"
  if ($script:BundleId -cnotmatch '^[A-Za-z0-9._-]{1,120}$' -or $script:BundleId -match '^\.+$') { Fail $E_BUNDLE "installer.conf has an unusable bundleId" }
  $script:ToolVersion = Kv $c "toolVersion"
  if ($script:ToolVersion -eq "") { Fail $E_BUNDLE "installer.conf has no toolVersion" }
  $script:PackLabel = ((Kv $c "packName") + " " + (Kv $c "packVersion")).Trim()
  $count = Kv $c "payloadCount"
  if (-not (Is-UInt $count) -or [int]$count -lt 1) { Fail $E_BUNDLE "installer.conf declares no payload" }
  $script:PayloadCount = [int]$count
  for ($n = 1; $n -le $script:PayloadCount; $n++) {
    $p = Kv $c "payload.$n.path"
    if ($p -cnotmatch '^config/ftbquests/quests/lang/[A-Za-z0-9._-]+\.snbt$') { Fail $E_BUNDLE "installer.conf declares the payload path '$p', which is not a .snbt file directly inside config/ftbquests/quests/lang" "This installer only ever writes quest localisation files." }
    if (-not (Is-Hex64 (Kv $c "payload.$n.sha256"))) { Fail $E_BUNDLE "installer.conf payload.$n.sha256 is not a SHA-256" }
    if (-not (Is-UInt (Kv $c "payload.$n.sizeBytes"))) { Fail $E_BUNDLE "installer.conf payload.$n.sizeBytes is not a number" }
    if (-not (Is-Hex64 (Kv $c "payload.$n.sourceSha256"))) { Fail $E_BUNDLE "installer.conf payload.$n.sourceSha256 is not a SHA-256" }
  }
}

function Payload-Conf([int]$N, [string]$Field) { return Kv $script:Conf "payload.$N.$Field" }

function Verify-PayloadFile([int]$N) {
  $p = Payload-Conf $N "path"
  $f = Join-Path (Join-Path $script:Bundle "payload") ($p -replace "/", $SEP)
  if (-not (Is-File $f)) { Fail $E_BUNDLE "The bundle is missing the payload file payload/$p" "The bundle is incomplete; extract it again, keeping the whole directory." }
  if (Is-Reparse $f) { Fail $E_BUNDLE "payload/$p is a reparse point" }
  if ([string](Get-Size $f) -ne (Payload-Conf $N "sizeBytes")) { Fail $E_BUNDLE "payload/$p is not the size installer.conf declares" "The bundle is corrupt or has been tampered with; download it again." }
  if ((Get-Sha256 $f) -ne (Payload-Conf $N "sha256")) { Fail $E_BUNDLE "payload/$p does not match the digest in installer.conf" "The bundle is corrupt or has been tampered with; download it again." }
  return $f
}

# ---- instance ----------------------------------------------------------------

$script:Root = ""
$script:State = ""
$script:Backups = ""
$script:Installs = ""

function Is-Instance([string]$Dir) {
  foreach ($name in @("mods", "config")) {
    $p = Join-Path $Dir $name
    if (-not (Is-Dir $p)) { return $false }
    if (Is-Reparse $p) { return $false }
  }
  return $true
}

function Resolve-Instance([string]$Raw) {
  $raw = $Raw.Trim().Trim('"')
  if ($raw -eq "") { Fail $E_INVALID_INPUT "No instance path given" }
  if (-not (Is-Dir $raw)) { Fail $E_INSTANCE "$raw is not a directory" "Pass the Minecraft instance folder: the one holding mods\ and config\." }
  $full = (Get-Item -LiteralPath $raw -Force).FullName
  if (Is-Instance $full) { $script:Root = $full }
  elseif (Is-Instance (Join-Path $full ".minecraft")) { $script:Root = Join-Path $full ".minecraft"; Say "using $script:Root" }
  elseif (Is-Instance (Join-Path $full "minecraft")) { $script:Root = Join-Path $full "minecraft"; Say "using $script:Root" }
  else { Fail $E_INSTANCE "$raw is not a Minecraft instance: it has no mods\ and config\ directories" "Pass the instance folder itself (the one holding mods\, config\ and saves\). A Prism/MultiMC folder holding .minecraft\ or minecraft\ is accepted too." }
  $script:Root = $script:Root.TrimEnd($SEP)
  $script:State = Join-Path $script:Root $STATE_DIR_NAME
  $script:Backups = Join-Path $script:State "backups"
  $script:Installs = Join-Path $script:State "installed"
}

function Native([string]$Rel) { return Join-Path $script:Root ($Rel -replace "/", $SEP) }

function Assert-RealPath([string]$Rel, [string]$Kind) {
  # Every existing component under the instance is a real directory (or, for
  # the last one, a real file), never a reparse point -- a symlink, a junction
  # or a mount point. Stops at the first component that does not exist.
  $acc = $script:Root
  $parts = $Rel -split "/"
  for ($i = 0; $i -lt $parts.Length; $i++) {
    $seg = $parts[$i]
    if ($seg -eq "" -or $seg -eq "." -or $seg -eq "..") { Fail $E_BUNDLE "Unsafe path component in $Rel" }
    $acc = Join-Path $acc $seg
    if (-not (Exists-Any $acc)) { return }
    if (Is-Reparse $acc) { Fail $E_INSTANCE "$acc is a reparse point (symbolic link or junction), which this installer will not follow" "The installer writes only inside the instance. Replace the link with a real directory or file." }
    $last = ($i -eq $parts.Length - 1)
    if (-not $last -or $Kind -eq "dir") { if (-not (Is-Dir $acc)) { Fail $E_INSTANCE "$acc is not a directory" } }
    else { if (-not (Is-File $acc)) { Fail $E_INSTANCE "$acc is not a regular file" } }
  }
}

function Ensure-Dir([string]$Rel) {
  Assert-RealPath $Rel "dir"
  $full = Native $Rel
  if (-not (Exists-Any $full)) { $null = [IO.Directory]::CreateDirectory($full) }
  Assert-RealPath $Rel "dir"
  $phys = (Get-Item -LiteralPath $full -Force).FullName.TrimEnd($SEP)
  if (-not ($phys -eq $script:Root -or $phys.StartsWith($script:Root + $SEP, [StringComparison]::OrdinalIgnoreCase))) { Fail $E_INSTANCE "$full resolves to $phys, outside the instance" }
}

function Ensure-StateDirs {
  Ensure-Dir $STATE_DIR_NAME
  Ensure-Dir "$STATE_DIR_NAME/backups"
  Ensure-Dir "$STATE_DIR_NAME/installed"
}

function Ensure-TargetDir([string]$Rel) {
  $parts = ($Rel -split "/")
  $acc = ""
  for ($i = 0; $i -lt $parts.Length - 1; $i++) {
    if ($acc -eq "") { $acc = $parts[$i] } else { $acc = "$acc/" + $parts[$i] }
    Ensure-Dir $acc
  }
}

function Legacy-NamesTarget([string]$Rel) {
  $f = Join-Path (Join-Path $script:Root $LEGACY_DIR_NAME) "state.json"
  if (-not (Is-File $f)) { return $false }
  if (Is-Reparse $f) { return $false }
  try {
    $state = [IO.File]::ReadAllText($f, $Utf8) | ConvertFrom-Json
    if ($null -eq $state.installs) { return $false }
    foreach ($prop in $state.installs.PSObject.Properties) { if ($prop.Name -eq $Rel) { return $true } }
    return $false
  } catch {
    # Not JSON any more: fall back to the same textual test the sh script uses.
    return ([IO.File]::ReadAllText($f, $Utf8).Contains('"' + $Rel + '":'))
  }
}

# ---- copies and transactions --------------------------------------------------

function Write-Copy([string]$Src, [string]$Dst, [string]$Want) {
  # Copy, flush, verify, then publish under the final name without replacing.
  $tmp = "$Dst.tmp-$PID"
  Remove-Quiet $tmp
  try {
    Write-BytesDurable $tmp ([IO.File]::ReadAllBytes($Src))
    if ((Get-Sha256 $tmp) -ne $Want) { Remove-Quiet $tmp; Fail $E_TARGET_MODIFIED "$Src changed while it was being copied; nothing was changed" }
    try { [IO.File]::Move($tmp, $Dst) } catch { Remove-Quiet $tmp; Fail $E_WRITE "Could not create $Dst (it may already exist)" }
  } catch { Remove-Quiet $tmp; throw }
}
function Write-TextNoClobber([string]$Dst, [string]$Text) {
  $tmp = "$Dst.tmp-$PID"
  Remove-Quiet $tmp
  Write-TextDurable $tmp $Text
  try { [IO.File]::Move($tmp, $Dst) } catch { Remove-Quiet $tmp; Fail $E_WRITE "Could not create $Dst" }
}
function Write-TextReplace([string]$Dst, [string]$Text) {
  # Only for files this installer owns outright (the install record).
  $tmp = "$Dst.tmp-$PID"
  Remove-Quiet $tmp
  Write-TextDurable $tmp $Text
  if (Is-File $Dst) { [IO.File]::Replace($tmp, $Dst, [NullString]::Value) } else { [IO.File]::Move($tmp, $Dst) }
}

function Put-Back([string]$Staged, [string]$Target) {
  try { [IO.File]::Move($Staged, $Target); return $true } catch {
    Warn "$Target was taken by another file; the previous one is kept at $Staged"
    return $false
  }
}

function Publish([string]$Target, [string]$Src, [string]$Want, [string]$Expect) {
  # The bytes at $Target are moved aside, digested against what this run
  # agreed to replace, and only then is the new file moved into the now-absent
  # name. [IO.File]::Move never replaces an existing file, so whatever appears
  # at the name in between wins and nothing is written over.
  $dir = [IO.Path]::GetDirectoryName($Target)
  $base = [IO.Path]::GetFileName($Target)
  $staged = Join-Path $dir "$base.mqt-staged"
  $tmp = Join-Path $dir "$base.mqt-tmp-$PID"
  Remove-Quiet $tmp
  Write-BytesDurable $tmp ([IO.File]::ReadAllBytes($Src))
  if ((Get-Sha256 $tmp) -ne $Want) { Remove-Quiet $tmp; Fail $E_WRITE "$tmp does not verify after writing" }
  if ($Expect -ne "absent") {
    if (Exists-Any $staged) { Remove-Quiet $tmp; Fail $E_INSTANCE "A leftover $staged is in the way" }
    if (Is-Reparse $Target) { Remove-Quiet $tmp; Fail $E_INSTANCE "$Target became a reparse point" }
    try { [IO.File]::Move($Target, $staged) } catch { Remove-Quiet $tmp; Fail $E_TARGET_MODIFIED "$Target vanished while the installer was working; nothing was changed" }
    $got = Get-Sha256 $staged
    if ($got -ne $Expect) {
      $null = Put-Back $staged $Target
      Remove-Quiet $tmp
      Fail $E_TARGET_MODIFIED "$Target changed while the installer was working; nothing was written over" "Close Minecraft and anything else writing to the instance, then run this again."
    }
  } else {
    if (Exists-Any $Target) { Remove-Quiet $tmp; Fail $E_TARGET_MODIFIED "$Target appeared while the installer was working; it is left as it is" }
  }
  try { [IO.File]::Move($tmp, $Target) } catch {
    Remove-Quiet $tmp
    if ($Expect -ne "absent") { $null = Put-Back $staged $Target }
    Fail $E_TARGET_MODIFIED "Another file appeared at $Target in the last instant; it wins and is left untouched" "Close Minecraft and anything else writing to the instance, then run this again."
  }
  if ($Expect -ne "absent") { Remove-Quiet $staged }
}

function Unpublish([string]$Target, [string]$Expect) {
  $dir = [IO.Path]::GetDirectoryName($Target)
  $base = [IO.Path]::GetFileName($Target)
  $staged = Join-Path $dir "$base.mqt-staged"
  if (Exists-Any $staged) { Fail $E_INSTANCE "A leftover $staged is in the way" }
  if (Is-Reparse $Target) { Fail $E_INSTANCE "$Target became a reparse point" }
  try { [IO.File]::Move($Target, $staged) } catch { Fail $E_TARGET_MODIFIED "$Target vanished while the installer was working" }
  if ((Get-Sha256 $staged) -ne $Expect) {
    $null = Put-Back $staged $Target
    Fail $E_TARGET_MODIFIED "$Target changed while the installer was working; nothing was deleted"
  }
  Remove-Quiet $staged
}

# ---- backups -----------------------------------------------------------------

function Backup-MetaOk([string]$Meta, [string]$Kind, [string]$Rel, [string]$Sha, [string]$Size) {
  if (-not (Is-File $Meta) -or (Is-Reparse $Meta)) { return $false }
  $m = Read-Kv $Meta
  return ((Kv $m "kind") -eq $Kind -and (Kv $m "target") -eq $Rel -and (Kv $m "sha256") -eq $Sha -and (Kv $m "sizeBytes") -eq $Size)
}

$script:BackupName = ""
function Capture-Backup([string]$Rel, [string]$Kind, [string]$Sha, [string]$Size, [string]$Src = "") {
  # Named by digest: an identical backup is reused, a different original never collides.
  if ($Src -eq "") { $Src = Native $Rel }
  $base = [IO.Path]::GetFileName($Rel)
  $name = "$base." + (Short $Sha) + ".$Kind.bak"
  if ($name -cnotmatch '^[A-Za-z0-9._-]+$') { Fail $E_INTERNAL "Unusable backup name $name" }
  Assert-RealPath "$STATE_DIR_NAME/backups/$name" "file"
  Assert-RealPath "$STATE_DIR_NAME/backups/$name.meta" "file"
  $file = Join-Path $script:Backups $name
  if (Exists-Any $file) {
    if ((Get-Sha256 $file) -eq $Sha -and [string](Get-Size $file) -eq $Size -and (Backup-MetaOk "$file.meta" $Kind $Rel $Sha $Size)) {
      Say "reusing the existing backup $name"
    } else {
      Fail $E_BACKUP "A backup named $name exists but does not verify; refusing to reuse or replace it" "Move it out of $script:Backups by hand (do not delete it) and run this again."
    }
  } else {
    Write-Copy $Src $file $Sha
    Remove-Quiet "$file.meta"
    Write-TextNoClobber "$file.meta" ("format=1@NL@kind=$Kind@NL@target=$Rel@NL@sha256=$Sha@NL@sizeBytes=$Size@NL@capturedAt=" + (Now-Iso) + "@NL@bundleId=$script:BundleId@NL@toolVersion=$script:ToolVersion@NL@")
    Say "backed up $base -> $STATE_DIR_NAME\backups\$name"
  }
  $script:BackupName = $name
}

function Capture-Absent([string]$Rel) {
  $base = [IO.Path]::GetFileName($Rel)
  $name = "$base.absent"
  Assert-RealPath "$STATE_DIR_NAME/backups/$name.meta" "file"
  $meta = Join-Path $script:Backups "$name.meta"
  if (Exists-Any $meta) {
    $m = Read-Kv $meta
    if ((Kv $m "kind") -ne "absent" -or (Kv $m "target") -ne $Rel) { Fail $E_BACKUP "$meta exists but is not an absent sentinel for $Rel" }
  } else {
    Write-TextNoClobber $meta ("format=1@NL@kind=absent@NL@target=$Rel@NL@sha256=@NL@sizeBytes=0@NL@capturedAt=" + (Now-Iso) + "@NL@bundleId=$script:BundleId@NL@toolVersion=$script:ToolVersion@NL@")
    Say "recorded that $base did not exist before"
  }
  $script:BackupName = $name
}

function Verify-Backup([string]$Name, [string]$Rel, [string]$Sha) {
  if ($Name -eq "" -or $Name -cnotmatch '^[A-Za-z0-9._-]+$') { Fail $E_BACKUP "The install record names an unusable backup" }
  Assert-RealPath "$STATE_DIR_NAME/backups/$Name" "file"
  Assert-RealPath "$STATE_DIR_NAME/backups/$Name.meta" "file"
  $file = Join-Path $script:Backups $Name
  if (-not (Is-File $file)) { Fail $E_BACKUP "The backup $Name is missing from $script:Backups; nothing was changed" "Without it the pack's own file cannot be restored. Look for it in a copy of the instance." }
  if (-not (Is-File "$file.meta")) { Fail $E_BACKUP "The backup $Name has no .meta record; nothing was changed" }
  $m = Read-Kv "$file.meta"
  if ((Kv $m "target") -ne $Rel) { Fail $E_BACKUP "The backup $Name is for a different file; nothing was changed" }
  if ((Kv $m "sha256") -ne $Sha) { Fail $E_BACKUP "The backup $Name is not the one the install record names; nothing was changed" }
  $size = [string](Get-Size $file)
  if ($size -ne (Kv $m "sizeBytes")) { Fail $E_BACKUP "The backup $Name is $size bytes but was recorded as $(Kv $m 'sizeBytes') (truncated?); nothing was changed" }
  if ((Get-Sha256 $file) -ne $Sha) { Fail $E_BACKUP "The backup $Name does not match its recorded digest; nothing was changed" }
  return $file
}

function Verify-RecordedBackup([string]$Rel, [string]$Name, [string]$OrigSha) {
  # What a record names is checked before anything is changed: an install,
  # an upgrade and an uninstall all rely on it to put the pack's file back.
  # Returns @{ kind = "absent" | "original"; file = <verified backup or ""> }.
  $base = [IO.Path]::GetFileName($Rel)
  if ($Name -eq "$base.absent") {
    Assert-RealPath "$STATE_DIR_NAME/backups/$Name.meta" "file"
    $meta = Join-Path $script:Backups "$Name.meta"
    if (-not (Is-File $meta)) { Fail $E_BACKUP "The record says there was no file before install, but the sentinel $Name.meta is missing; nothing was changed" "Without it there is no way to tell what to put back. Look for it in a copy of the instance." }
    $m = Read-Kv $meta
    if ((Kv $m "kind") -ne "absent" -or (Kv $m "target") -ne $Rel) { Fail $E_BACKUP "The sentinel $Name.meta is not an absent record for $Rel; nothing was changed" }
    if ($OrigSha -ne "") { Fail $E_BACKUP "The install record names the absent sentinel but also an original digest; nothing was changed" }
    return @{ kind = "absent"; file = "" }
  }
  if (-not (Is-Hex64 $OrigSha)) { Fail $E_BACKUP "The install record has no usable original digest; nothing was changed" }
  return @{ kind = "original"; file = (Verify-Backup $Name $Rel $OrigSha) }
}

function Count-Restorable([string]$Rel) {
  # Original/absent backups for this target: count, and the only one if there is one.
  $base = [IO.Path]::GetFileName($Rel)
  $result = @{ n = 0; name = ""; sha = "" }
  if (-not (Is-Dir $script:Backups)) { return $result }
  $metas = @(Get-ChildItem -LiteralPath $script:Backups -Force -File | Where-Object { $_.Name -like "$base.*.original.bak.meta" -or $_.Name -eq "$base.absent.meta" })
  foreach ($meta in $metas) {
    if (($meta.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    $m = Read-Kv $meta.FullName
    if ((Kv $m "target") -ne $Rel) { continue }
    $result["n"] = $result["n"] + 1
    $result.name = $meta.Name.Substring(0, $meta.Name.Length - 5)
    $result.sha = Kv $m "sha256"
  }
  return $result
}

# ---- install records ----------------------------------------------------------

function Record-Path([string]$Rel) { return Join-Path $script:Installs (([IO.Path]::GetFileName($Rel)) + ".meta") }

function Read-Record([string]$Rel) {
  $rec = @{ present = $false; sha = ""; backup = ""; origSha = ""; bundle = "" }
  Assert-RealPath ("$STATE_DIR_NAME/installed/" + [IO.Path]::GetFileName($Rel) + ".meta") "file"
  $r = Record-Path $Rel
  if (-not (Is-File $r)) { return $rec }
  $m = Read-Kv $r
  if ((Kv $m "target") -ne $Rel) { Fail $E_BACKUP "$r is for a different file" }
  $sha = Kv $m "installedSha256"
  if (-not (Is-Hex64 $sha)) { Warn "$r has no usable installedSha256; treating it as absent"; return $rec }
  $rec.present = $true
  $rec.sha = $sha
  $rec.backup = Kv $m "originalBackup"
  $rec.origSha = Kv $m "originalSha256"
  $rec.bundle = Kv $m "bundleId"
  return $rec
}

function Write-Record([string]$Rel, [string]$InstalledSha, [string]$Backup, [string]$OrigSha) {
  Write-TextReplace (Record-Path $Rel) ("format=1@NL@target=$Rel@NL@bundleId=$script:BundleId@NL@installedSha256=$InstalledSha@NL@installedAt=" + (Now-Iso) + "@NL@originalBackup=$Backup@NL@originalSha256=$OrigSha@NL@toolVersion=$script:ToolVersion@NL@")
}

function Append-History([string]$Event, [string]$Rel, [string]$Backup) {
  try { [IO.File]::AppendAllText((Join-Path $script:State "history.log"), ((Now-Iso) + " $Event $Rel $Backup@NL@"), $Utf8) } catch { }
}

# ---- leftovers ----------------------------------------------------------------

function Recover-Leftovers([string]$Rel) {
  $target = Native $Rel
  $dir = [IO.Path]::GetDirectoryName($target)
  $base = [IO.Path]::GetFileName($target)
  if (-not (Is-Dir $dir)) { return }
  $staged = Join-Path $dir "$base.mqt-staged"
  foreach ($f in @(Get-ChildItem -LiteralPath $dir -Force -File | Where-Object { $_.Name -like "$base.mqt-tmp-*" })) {
    if (($f.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }
    # status reports and changes nothing, leftovers included.
    if ($Command -eq "status") { Warn "$($f.FullName) is a leftover temporary file from an interrupted run; the next install or uninstall will remove it"; continue }
    Remove-Quiet $f.FullName
    Warn "removed a leftover temporary file $($f.FullName)"
  }
  if (-not (Exists-Any $staged)) { return }
  if (Is-Reparse $staged) { Fail $E_INSTANCE "$staged is a reparse point" }
  if (-not (Exists-Any $target)) {
    if ($Command -eq "status") { Warn "$staged was left by an interrupted run; the next install or uninstall will put it back"; return }
    if (-not (Put-Back $staged $target)) { Fail $E_TARGET_MODIFIED "Could not put $staged back" }
    Warn "put $staged back as $base after an interrupted run"
  } else {
    if ($Command -eq "status") { Warn "$staged was left by an interrupted run and $base has since been replaced; the next install or uninstall will keep it in backups\"; return }
    Ensure-StateDirs
    Capture-Backup $Rel "displaced" (Get-Sha256 $staged) ([string](Get-Size $staged)) $staged
    Remove-Quiet $staged
    Warn "$base had been replaced since an interrupted run; the displaced file is kept as $STATE_DIR_NAME\backups\$script:BackupName"
  }
}

# ---- prompts -----------------------------------------------------------------

function Confirm-Run {
  if ($Yes) { return }
  if ([Console]::IsInputRedirected) { return }
  $answer = Read-Host "続行しますか / Continue? [y/N]"
  if ($answer -notmatch '^(y|Y|yes|YES|はい)$') {
    Say "中止しました。何も変更していません。 / Cancelled. Nothing was changed."
    exit 0
  }
}

function Ask-Instance {
  if ($Instance -ne "") { return $Instance }
  if ($InstancePositional -ne "") { return $InstancePositional }
  if ([Console]::IsInputRedirected) { Fail $E_INVALID_INPUT "-Instance is required when there is no console to ask on" }
  Say "Minecraft のインスタンスのフォルダーのパスを入力してください。"
  Say "Enter the path to your Minecraft instance folder."
  $typed = Read-Host ">"
  if ($null -eq $typed -or $typed.Trim() -eq "") {
    Say "中止しました。何も変更していません。 / Cancelled. Nothing was changed."
    exit 0
  }
  return $typed
}

# ---- install -----------------------------------------------------------------

function Do-Install {
  $files = @{}
  for ($n = 1; $n -le $script:PayloadCount; $n++) { $files[$n] = Verify-PayloadFile $n }
  # The state directories are created only once a target has been classified
  # and confirmed: a refused install leaves the instance exactly as it was.
  if (Is-Dir $script:State) { Assert-RealPath $STATE_DIR_NAME "dir" }
  for ($n = 1; $n -le $script:PayloadCount; $n++) { Install-One $n $files[$n] }
}

function Install-One([int]$N, [string]$Src) {
  $rel = Payload-Conf $N "path"
  $psha = Payload-Conf $N "sha256"
  $ssha = Payload-Conf $N "sourceSha256"
  $target = Native $rel
  $base = [IO.Path]::GetFileName($rel)

  Ensure-TargetDir $rel
  Assert-RealPath $rel "file"
  Recover-Leftovers $rel
  Assert-RealPath $rel "file"
  $rec = Read-Record $rel

  $action = ""; $backup = ""; $osha = ""; $expect = "absent"; $cur = ""
  if (Exists-Any $target) {
    $cur = Get-Sha256 $target
    $expect = $cur
    if ($cur -eq $psha) {
      if ($rec.present) { Say "すでに導入済みです。変更はありません。 / Already installed: $rel is this bundle's file. Nothing to do."; return }
      if (Legacy-NamesTarget $rel) { Fail $E_INSTANCE "$rel already holds this translation, and it was installed by the executable installer ($LEGACY_DIR_NAME\state.json records it)" $MIGRATION_HINT }
      $only = Count-Restorable $rel
      if ($only["n"] -eq 1) {
        $null = Verify-RecordedBackup $rel $only.name $only.sha
        Say "$rel already holds this bundle's file and one original backup is on record; recording the install"
        Ensure-StateDirs
        Write-Record $rel $psha $only.name $only.sha
        Append-History "install" $rel $only.name
        return
      }
      Fail $E_INSTANCE "$rel already holds this translation, but this installer has no record of installing it and no backup of the pack's own file" $MIGRATION_HINT
    }
    if ($rec.present) {
      if ($cur -eq $rec.sha) { $action = "upgrade"; $backup = $rec.backup; $osha = $rec.origSha }
      elseif ($Force) { $action = "force-upgrade"; $backup = $rec.backup; $osha = $rec.origSha }
      else { Fail $E_TARGET_MODIFIED "$rel was edited after it was installed; refusing to overwrite the edit" "Run again with -Force to keep a copy of the edited file in $STATE_DIR_NAME\backups\ and install over it." }
    } else {
      if (Legacy-NamesTarget $rel) { Fail $E_INSTANCE "$rel is recorded as installed by the executable installer ($LEGACY_DIR_NAME\state.json)" $MIGRATION_HINT }
      if ($cur -eq $ssha) { $action = "first" }
      elseif (Exists-Any (Join-Path $script:Backups ("$base." + (Short $cur) + ".original.bak"))) { $action = "first" }
      elseif ($Force) { Warn "$rel is not the file this translation was made from; installing anyway because of -Force"; $action = "first" }
      else { Fail $E_SOURCE_MISMATCH "$rel is not the quest file this translation was made from ($script:PackLabel): its SHA-256 is $cur, expected $ssha" "The modpack is probably a different version, or the file was already changed. A translation for another version can break quests. To install anyway, run again with -Force; the file is backed up first either way." }
    }
  } else {
    if ($rec.present) { $action = "upgrade"; $backup = $rec.backup; $osha = $rec.origSha; $expect = "absent" }
    else {
      if (Legacy-NamesTarget $rel) { Fail $E_INSTANCE "$rel is recorded as installed by the executable installer ($LEGACY_DIR_NAME\state.json)" $MIGRATION_HINT }
      $action = "first-absent"
    }
  }

  if ($action -eq "upgrade" -or $action -eq "force-upgrade") {
    # The record is trusted only once what it names verifies: without the
    # original (or its absent sentinel) an upgrade could never be undone.
    $null = Verify-RecordedBackup $rel $backup $osha
  }

  Say "対象 / target: $target"
  Confirm-Run
  Ensure-StateDirs

  switch ($action) {
    "first" { Capture-Backup $rel "original" $cur ([string](Get-Size $target)); $backup = $script:BackupName; $osha = $cur }
    "first-absent" { Capture-Absent $rel; $backup = $script:BackupName; $osha = "" }
    "force-upgrade" { Capture-Backup $rel "modified" $cur ([string](Get-Size $target)); Say "kept the edited file as $STATE_DIR_NAME\backups\$script:BackupName" }
    "upgrade" { }
  }

  Assert-RealPath $rel "file"
  Publish $target $Src $psha $expect
  Write-Record $rel $psha $backup $osha
  Append-History "install" $rel $backup
  Say "導入しました / Installed: $rel"
}

# ---- uninstall ---------------------------------------------------------------

function Do-Uninstall {
  if (Is-Dir $script:State) { Assert-RealPath $STATE_DIR_NAME "dir" }
  for ($n = 1; $n -le $script:PayloadCount; $n++) { Uninstall-One $n }
}

function Uninstall-One([int]$N) {
  $rel = Payload-Conf $N "path"
  $psha = Payload-Conf $N "sha256"
  $target = Native $rel
  $base = [IO.Path]::GetFileName($rel)

  Assert-RealPath $rel "file"
  Recover-Leftovers $rel
  Assert-RealPath $rel "file"
  $rec = Read-Record $rel

  $cur = ""
  if (Exists-Any $target) { $cur = Get-Sha256 $target }

  if (-not $rec.present) {
    if ($cur -ne "" -and $cur -eq $psha) {
      if (Legacy-NamesTarget $rel) { Fail $E_INSTANCE "$rel was installed by the executable installer, not by these scripts" $MIGRATION_HINT }
      $only = Count-Restorable $rel
      if ($only["n"] -eq 1) {
        Warn "no install record for $rel, but the file is this bundle's and one original backup is on record; using it"
        $rec.sha = $psha; $rec.backup = $only.name; $rec.origSha = $only.sha
      } elseif ($only["n"] -gt 1) {
        Fail $E_BACKUP "no install record for $rel and $($only["n"]) original backups to choose from; refusing to guess" "Look in $script:Backups and restore the right one by hand."
      } else {
        Fail $E_INSTANCE "$rel holds this translation but nothing here installed it" $MIGRATION_HINT
      }
    } else {
      Fail $E_NOT_INSTALLED "Nothing from this bundle is installed at $rel"
    }
  }

  $action = "restore"
  if ($cur -eq "") {
    if ($Force) { Warn "$rel is missing; restoring the original anyway because of -Force" }
    else { Fail $E_TARGET_MODIFIED "$rel was installed but is now missing" "Run again with -Force to restore the original anyway." }
  } elseif ($cur -ne $rec.sha) {
    if ($Force) { $action = "force-restore" }
    else { Fail $E_TARGET_MODIFIED "$rel was edited after it was installed; refusing to discard the edit" "Run again with -Force to keep a copy of the edited file in $STATE_DIR_NAME\backups\ and restore the original over it." }
  }

  $checked = Verify-RecordedBackup $rel $rec.backup $rec.origSha
  $kind = $checked.kind
  $verified = $checked.file

  Say "対象 / target: $target"
  Confirm-Run

  if ($action -eq "force-restore") {
    Ensure-StateDirs
    Capture-Backup $rel "modified" $cur ([string](Get-Size $target))
    Say "kept the edited file as $STATE_DIR_NAME\backups\$script:BackupName"
  }
  Assert-RealPath $rel "file"
  if ($kind -eq "absent") {
    if ($cur -ne "") { Unpublish $target $cur }
    Say "削除しました / Removed $rel (there was no file before install)"
  } else {
    if ($cur -ne "") { Publish $target $verified $rec.origSha $cur } else { Publish $target $verified $rec.origSha "absent" }
    Say "元に戻しました / Restored $rel from $STATE_DIR_NAME\backups\$($rec.backup)"
  }
  Remove-Quiet (Record-Path $rel)
  Append-History "uninstall" $rel $rec.backup
}

# ---- status ------------------------------------------------------------------

function Do-Status {
  Say "bundle:   $script:BundleId ($script:PackLabel)"
  Say "instance: $script:Root"
  for ($n = 1; $n -le $script:PayloadCount; $n++) {
    $rel = Payload-Conf $n "path"
    $psha = Payload-Conf $n "sha256"
    $ssha = Payload-Conf $n "sourceSha256"
    $target = Native $rel
    Assert-RealPath $rel "file"
    Recover-Leftovers $rel
    $rec = @{ present = $false; sha = ""; backup = ""; origSha = ""; bundle = "" }
    if (Is-Dir $script:State) { Assert-RealPath $STATE_DIR_NAME "dir"; $rec = Read-Record $rel }
    Say "target:   $rel"
    if (Exists-Any $target) {
      $cur = Get-Sha256 $target
      if ($cur -eq $psha) { $state = "this bundle's translation" }
      elseif ($cur -eq $ssha) { $state = "the pack's own file (not installed)" }
      elseif ($rec.present -and $cur -eq $rec.sha) { $state = "an earlier translation of this tool" }
      elseif ($rec.present) { $state = "MODIFIED after install" }
      else { $state = "a file this installer does not recognise" }
      Say "  file:   present, $state ($cur)"
    } else { Say "  file:   absent" }
    if ($rec.present) { Say "  record: installed from $($rec.bundle), original backup $($rec.backup)" } else { Say "  record: none" }
    if (Legacy-NamesTarget $rel) { Say "  note:   the executable installer also records an install here ($LEGACY_DIR_NAME\state.json)" }
    if (Is-Dir $script:Backups) {
      $base = [IO.Path]::GetFileName($rel)
      foreach ($meta in @(Get-ChildItem -LiteralPath $script:Backups -Force -File | Where-Object { $_.Name -like "$base.*.meta" })) {
        $m = Read-Kv $meta.FullName
        Say ("  backup: " + $meta.Name.Substring(0, $meta.Name.Length - 5) + " (" + (Kv $m "kind") + ", " + (Kv $m "capturedAt") + ")")
      }
    }
  }
}

# ---- main --------------------------------------------------------------------

$exitCode = 0
try {
  if ($Command -eq "" -or $Command -eq "help" -or $Command -eq "--help") { Usage; exit 0 }
  if ($Command -notin @("install", "uninstall", "status")) { Fail $E_INVALID_INPUT "Unknown command: $Command" "Use install, uninstall or status." }
  if ($Command -eq "status" -and ($Force -or $Yes)) { Fail $E_INVALID_INPUT "status changes nothing and takes neither -Force nor -Yes" }
  Load-Bundle
  Resolve-Instance (Ask-Instance)
  switch ($Command) {
    "install" { Do-Install }
    "uninstall" { Do-Uninstall }
    "status" { Do-Status }
  }
} catch {
  $ex = $_.Exception
  if ($null -ne $ex -and $ex.Data.Contains("mqtCode")) {
    [Console]::Error.WriteLine("error: " + $ex.Message)
    $hint = [string]$ex.Data["mqtHint"]
    if ($hint -ne "") { [Console]::Error.WriteLine("hint: " + $hint) }
    $exitCode = [int]$ex.Data["mqtCode"]
  } else {
    [Console]::Error.WriteLine("error: " + $_.ToString())
    if ($null -ne $_.InvocationInfo) { [Console]::Error.WriteLine($_.InvocationInfo.PositionMessage) }
    $exitCode = $E_INTERNAL
  }
}
exit $exitCode
`;

/** PowerShell escapes with a backtick, which a JS template cannot hold; `@NL@` stands in for it. */
export const POWERSHELL_INSTALLER_SCRIPT: string = RAW.replace(/@NL@/g, "`n");
