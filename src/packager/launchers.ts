export const WINDOWS_BINARY_NAME = "mqt-installer-windows-x86_64.exe";
export const LINUX_BINARY_NAME = "mqt-installer-linux-x86_64";

export type LauncherCommand = "install" | "uninstall";

/** Mode for the shell launchers and the Linux binary inside the bundle. */
export const EXECUTABLE_MODE = 0o755;

const WINDOWS_TITLE: Record<LauncherCommand, string> = {
  install: "クエスト翻訳を導入 / Install the quest translation",
  uninstall: "クエスト翻訳を削除 / Remove the quest translation",
};

/**
 * The Windows launcher.
 *
 * `%~dp0` is the batch file's own directory, always with a trailing backslash,
 * and it is the only thing this script trusts: a double-clicked `.cmd` may
 * start in `C:\Windows\System32`, so anything relative to the working directory
 * is wrong. Every path expansion is quoted, so a bundle extracted to
 * `C:\Users\ゆき\Downloads\aca ja\` works. `chcp 65001` first so the Japanese
 * output renders, and `pause` last so a double-clicked window does not vanish
 * before it can be read.
 */
export function windowsLauncher(command: LauncherCommand): string {
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    "setlocal",
    `title ${WINDOWS_TITLE[command]}`,
    "",
    'set "MQT_BUNDLE=%~dp0."',
    `set "MQT_EXE=%~dp0bin\\${WINDOWS_BINARY_NAME}"`,
    "",
    'if not exist "%MQT_EXE%" (',
    '  echo インストーラーの実行ファイルが見つかりません: "%MQT_EXE%"',
    '  echo The installer executable is missing: "%MQT_EXE%"',
    "  echo ZIP をすべて展開してから、もう一度実行してください。",
    "  echo Extract the whole ZIP first, then run this again.",
    "  pause",
    "  exit /b 10",
    ")",
    "",
    'set "MQT_INSTANCE=%~1"',
    'if not "%~2"=="" echo [warn] フォルダーが複数渡されました。最初のものだけを使います / several paths were given; only the first is used',
    "",
    'if "%MQT_INSTANCE%"=="" (',
    "  echo Minecraft のインスタンスのフォルダーをこのウィンドウにドラッグして Enter を押すか、パスを入力してください。",
    "  echo Drag your Minecraft instance folder onto this window and press Enter, or type its path.",
    '  set /p "MQT_INSTANCE=> "',
    ")",
    "",
    `"%MQT_EXE%" ${command} --bundle "%MQT_BUNDLE%" --instance "%MQT_INSTANCE%"`,
    'set "MQT_CODE=%ERRORLEVEL%"',
    "",
    "echo.",
    "pause",
    "exit /b %MQT_CODE%",
    "",
  ];
  // CRLF throughout: cmd.exe tolerates LF unevenly, and Notepad still shows it
  // as one long line.
  return lines.join("\r\n");
}

/**
 * The POSIX launcher.
 *
 * `set -eu` so a failure stops rather than continues, the bundle is located
 * from `$0` rather than the working directory, and the execute bit is restored
 * because several GUI unzip tools drop it. `~` is expanded here because the
 * installer itself is compiled without --allow-env and so cannot read $HOME.
 */
export function linuxLauncher(command: LauncherCommand): string {
  return `#!/bin/sh
# Modpack Quest Translator -- ${command} the quest translation.
set -eu

BUNDLE_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
EXE="$BUNDLE_DIR/bin/${LINUX_BINARY_NAME}"

if [ ! -f "$EXE" ]; then
  printf '%s\\n' "インストーラーの実行ファイルが見つかりません: $EXE" >&2
  printf '%s\\n' "The installer executable is missing: $EXE" >&2
  printf '%s\\n' "ZIP をすべて展開してから、もう一度実行してください / extract the whole ZIP first" >&2
  exit 10
fi

# Some GUI unzip tools drop the execute bit.
[ -x "$EXE" ] || chmod +x "$EXE"

INSTANCE=""
case "\${1-}" in
  "") ;;
  -*) ;;
  *)
    INSTANCE="$1"
    shift
    ;;
esac

if [ -z "$INSTANCE" ]; then
  printf '%s\\n' "Minecraft のインスタンスのフォルダーのパスを入力してください。"
  printf '%s\\n' "Enter the path to your Minecraft instance folder."
  printf '> '
  read -r INSTANCE
fi

# The installer is compiled without --allow-env, so it cannot expand ~ itself.
case "$INSTANCE" in
  "~") INSTANCE="$HOME" ;;
  "~/"*) INSTANCE="$HOME/\${INSTANCE#\\~/}" ;;
esac

exec "$EXE" ${command} --bundle "$BUNDLE_DIR" --instance "$INSTANCE" "$@"
`;
}
