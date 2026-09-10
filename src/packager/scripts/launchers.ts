/**
 * Launchers for the script bundle. Thin on purpose: every decision lives in
 * `scripts/mqt-installer.ps1` and `scripts/mqt-installer.sh`, which the tests
 * can run; these only locate the bundle from their own path and hand over.
 */
export type ScriptCommand = "install" | "uninstall" | "status";

export const POWERSHELL_SCRIPT_NAME = "mqt-installer.ps1";
export const POSIX_SCRIPT_NAME = "mqt-installer.sh";
export const SCRIPTS_DIR = "scripts";

const WINDOWS_TITLE: Record<ScriptCommand, string> = {
  install: "クエスト翻訳を導入 / Install the quest translation",
  uninstall: "クエスト翻訳を削除 / Remove the quest translation",
  status: "クエスト翻訳の状態 / Quest translation status",
};

/**
 * The Windows launcher.
 *
 * `powershell.exe` is Windows PowerShell 5.1, present on every Windows 10 and
 * 11. `-ExecutionPolicy Bypass` applies to this one process and changes no
 * setting anywhere: nothing here runs `Set-ExecutionPolicy`, and nothing is
 * written to the registry. `-File` rather than `-Command`, because `-Command`
 * re-parses its argument as PowerShell and a path with `$` or a quote in it
 * would be code. `-NoProfile` so the user's own profile scripts cannot change
 * what this one does. A Group Policy that pins the execution policy overrides
 * the flag, and the README says what to do then.
 */
export function scriptWindowsLauncher(command: ScriptCommand): string {
  // Every command hands the instance path to PowerShell the same way, so every
  // command needs the same fix-up: a path ending in a backslash would escape
  // the closing quote below, and PowerShell would be handed the rest of the
  // line along with it. A trailing dot resolves to the same directory and
  // needs no special case for a drive root.
  const prompt = [
    ":: A path ending in a backslash would escape the closing quote below, and",
    ":: PowerShell would be handed the rest of the line along with it. A trailing",
    ":: dot resolves to the same directory and needs no special case for a drive root.",
    'if "%MQT_INSTANCE:~-1%"=="\\" set "MQT_INSTANCE=%MQT_INSTANCE%."',
    "",
  ];
  const lines = [
    "@echo off",
    "chcp 65001 >nul",
    "setlocal",
    `title ${WINDOWS_TITLE[command]}`,
    "",
    'set "MQT_BUNDLE=%~dp0."',
    `set "MQT_PS1=%~dp0${SCRIPTS_DIR}\\${POWERSHELL_SCRIPT_NAME}"`,
    "",
    'if not exist "%MQT_PS1%" (',
    '  echo インストーラーのスクリプトが見つかりません: "%MQT_PS1%"',
    '  echo The installer script is missing: "%MQT_PS1%"',
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
    ":: A path dropped onto the window arrives wrapped in quotes; strip them.",
    'if defined MQT_INSTANCE set "MQT_INSTANCE=%MQT_INSTANCE:"=%"',
    "",
    ...prompt,
    ":: -ExecutionPolicy Bypass applies to this process only. No policy is changed.",
    `powershell.exe -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%MQT_PS1%" ${command} -BundleDir "%MQT_BUNDLE%" -Instance "%MQT_INSTANCE%"`,
    'set "MQT_CODE=%ERRORLEVEL%"',
    "",
    "echo.",
    "pause",
    "exit /b %MQT_CODE%",
    "",
  ];
  return lines.join("\r\n");
}

/**
 * The POSIX launcher. It runs the script through `sh` explicitly, so a lost
 * execute bit costs nothing, and forwards every argument: the instance path,
 * `--force`, `--yes`.
 */
export function scriptLinuxLauncher(command: ScriptCommand): string {
  return `#!/bin/sh
# Modpack Quest Translator -- ${command} the quest translation (script installer).
set -eu

BUNDLE_DIR=$(cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="$BUNDLE_DIR/${SCRIPTS_DIR}/${POSIX_SCRIPT_NAME}"

if [ ! -f "$SCRIPT" ]; then
  printf '%s\\n' "インストーラーのスクリプトが見つかりません: $SCRIPT" >&2
  printf '%s\\n' "The installer script is missing: $SCRIPT" >&2
  printf '%s\\n' "ZIP をすべて展開してから、もう一度実行してください / extract the whole ZIP first" >&2
  exit 10
fi

exec sh "$BUNDLE_DIR/${SCRIPTS_DIR}/${POSIX_SCRIPT_NAME}" ${command} --bundle "$BUNDLE_DIR" "$@"
`;
}
