export const PACKAGER_HELP =
  `package-installer -- turn an overlay this tool produced into a double-clickable
installer bundle for Windows and Linux.

USAGE
  package-installer --overlay <zip> --source-archive <zip> --output <zip|dir>
                    [options]

REQUIRED
  --overlay <zip>        The raw overlay archive from a translation run.
  --source-archive <zip> The modpack archive that run read. Its sha256 has to
                         match the one the run recorded, and the pack's own
                         quest file is read back out of it to prove the payload
                         is a translation rather than that file.
  --output <zip|dir>     A path ending in .zip is that exact file; anything else
                         is a directory the bundle is written into.

BINARIES
  --binaries <dir>       Directory holding the compiled installers, as produced
                         by \`deno task build:installers\`.
  --linux-binary <path>  Explicit path, overriding --binaries.
  --windows-binary <path>
  --no-binaries          Build a bundle with no executables. It cannot be
                         installed by double-clicking, and the manifest and
                         README both say so.

OTHER
  --manifest <path>      translation-manifest.json, if not the copy inside the
                         overlay or the sidecar beside it.
  --report <path>        translation-report.json, likewise.
  --bundle-id <id>       Top-level directory name inside the bundle. Defaults to
                         the overlay's file name without .zip.
  --generated-at <iso>   Overrides the timestamp taken from the translation run.
  --force                Overwrite an existing output file.
  --json                 Print one machine-readable object.
  --quiet                Print nothing on success.
  --help, -h / --version

WHAT IT REFUSES
  An overlay holding anything that is not config/ftbquests/quests/lang/<x>.snbt.
  A --source-archive whose bytes are not the ones the run recorded. A manifest
  whose account of the source disagrees with what that archive actually says. A
  payload that is byte for byte the source read out of it. Together those are
  what keeps the pack's own text out of the bundle -- relative to the archive
  you supply, which is not the same as relative to the publisher: nothing here
  is signed.

Packaging the same overlay twice produces byte-identical output.`;
