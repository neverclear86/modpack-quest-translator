export const INSTALLER_HELP = `mqt-installer -- install a translated FTB Quests overlay into a
Minecraft instance, and take it back out again.

USAGE
  mqt-installer install   [--bundle <dir>] [--instance <path>] [--force] [--yes] [--json]
  mqt-installer uninstall [--bundle <dir>] [--instance <path>] [--force] [--yes] [--json]
  mqt-installer status    [--bundle <dir>] [--instance <path>] [--json]

COMMANDS
  install     Replace the quest language file with the translated one, saving the
              file that was there first. Running it twice changes nothing.
  uninstall   Put the saved original back, byte for byte. Backups are kept.
  status      Report what is installed. Changes nothing.

OPTIONS
  --bundle <dir>     The extracted bundle directory, the one holding
                     bundle-manifest.json. Defaults to the directory this
                     executable was run from.
  --instance <path>  The Minecraft instance: the folder containing mods/,
                     config/ and saves/. A launcher folder holding .minecraft/
                     or minecraft/ is also accepted. Required unless the
                     installer is run from a terminal, where it is asked for.
  --force            install:   replace a file that was edited after install.
                     uninstall: restore over a file that was edited after
                     install, keeping the edit as a backup first.
                     It never overrides a corrupt bundle, a symbolic link or a
                     missing backup.
  --yes, -y          Skip the confirmation prompt.
  --json             Print one machine-readable object instead of prose.
  --help, -h         This text.
  --version          Print the version and exit.

EXIT CODES
  0   success, including "already installed, nothing to do"
  2   bad flags or an unusable path
  8   a write failed
  10  the bundle is missing, malformed or does not match its manifest
  11  that folder is not a Minecraft instance, or the target is a symbolic link
  12  the installed file was edited after installation (use --force)
  13  no usable backup: missing, truncated or altered
  14  nothing from this bundle is installed
  130 interrupted

WHAT IT WRITES
  <instance>/config/ftbquests/quests/lang/<locale>.snbt   the translated file
  <instance>/.mqt-installer/                              backups and state

No network access, no elevation, no environment variables, and nothing outside
the instance is ever read or written.`;
