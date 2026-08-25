import type { BundleManifest } from "../installer/bundle.ts";

/** Human wording for a deno compile target triple. */
function describeTarget(target: string): string {
  if (target.includes("windows")) return "Windows x86_64";
  if (target.includes("linux")) return "Linux x86_64";
  if (target.includes("darwin")) return "macOS";
  return target;
}

/**
 * The bundle README. Japanese first, because the person who needs it is
 * reading quest text in Japanese; English second, for bug reports.
 */
export function buildBundleReadme(manifest: BundleManifest): string {
  const pack = [manifest.pack.name, manifest.pack.version].filter(Boolean).join(" ");
  const targets = manifest.payload.map((entry) => entry.path);
  const hasBinaries = manifest.binaries.length > 0;
  // Listed from the manifest rather than hard-coded: a --no-binaries bundle
  // that promises executables it does not carry reads as a broken download.
  const binaryRows = manifest.binaries
    .map((binary) => `| \`${binary.path}\` | the installer, ${describeTarget(binary.target)} |\n`)
    .join("");

  const noBinariesJa = hasBinaries ? "" : `
> **注意**: この配布物には実行ファイルは含まれていません。ダブルクリックでの導入はできません。
> \`bin/\` に対応する実行ファイルを置いてから使用してください。
`;
  const noBinariesEn = hasBinaries ? "" : `
> **Note**: this bundle does not include the installer executables, so it cannot be installed by
> double-clicking. Put the matching executables in \`bin/\` first.
`;

  return `# ${pack} クエスト翻訳 / Quest translation

${manifest.bundleId}

---

## 日本語

${
    manifest.pack.name ?? "このモッドパック"
  } のクエスト文章を ${manifest.targetLocale} に翻訳したものです。
Minecraft 本体や他の MOD の表示は英語のままです。クエストの進行状況には一切影響しません。
${noBinariesJa}
### 導入のしかた

1. この ZIP をすべて展開します（中身を丸ごと取り出してください）。
2. **Windows**: \`INSTALL-WINDOWS.cmd\` をダブルクリックし、Minecraft のインスタンスのフォルダーを
   ウィンドウにドラッグして Enter を押します。
   **Linux**: 端末で \`./INSTALL-LINUX.sh\` を実行し、同じフォルダーのパスを入力します。
3. 「導入しました」と表示されれば完了です。Minecraft を起動してください。

インスタンスのフォルダーとは \`mods\` \`config\` \`saves\` が入っているフォルダーです。
Prism / MultiMC の場合は \`.minecraft\` または \`minecraft\` を含むフォルダーを渡しても構いません。

### 元に戻すには

\`UNINSTALL-WINDOWS.cmd\`（Linux では \`./UNINSTALL-LINUX.sh\`）を実行してください。
導入前のファイルが 1 バイトも違わずに戻ります。

### バックアップについて

導入時、元のファイルは自動的に
\`<インスタンス>/.mqt-installer/backups/\` に保存されます。
このフォルダーは削除しないでください。削除すると元に戻せなくなります。
同じ配布物を二度導入しても、バックアップが上書きされることはありません。

### よくある表示

- **「WindowsによってPCが保護されました」(SmartScreen)**: この実行ファイルには
  コード署名がありません。内容を確認したうえで、\`詳細情報\` → \`実行\` を選んでください。
  署名には証明書が必要で、このプロジェクトは取得していません。
- **管理者権限は不要です**。管理者として実行する必要は一切ありません。
- ネットワークには接続しません。読み書きするのは指定したインスタンスの中だけです。

---

## English

A translation of ${manifest.pack.name ?? "this modpack"}'s quest text into ${manifest.targetLocale}.
Minecraft itself and every other mod stay in ${manifest.sourceLocale}. Quest progress is stored
separately from quest text and is not affected.
${noBinariesEn}
### Installing

1. Extract the whole ZIP.
2. **Windows**: double-click \`INSTALL-WINDOWS.cmd\` and drag your Minecraft instance folder onto
   the window, then press Enter.
   **Linux**: run \`./INSTALL-LINUX.sh\` and type the path to the same folder.
3. When it says \`Installed\`, you are done.

The instance folder is the one containing \`mods\`, \`config\` and \`saves\`. A Prism or MultiMC
instance folder holding \`.minecraft\` or \`minecraft\` is accepted too.

### Undoing it

Run \`UNINSTALL-WINDOWS.cmd\` (or \`./UNINSTALL-LINUX.sh\`). The file that was there before install
is restored byte for byte, verified against the digest recorded when it was saved.

### Backups

The original file is saved to \`<instance>/.mqt-installer/backups/\` before anything is replaced.
Do not delete that directory: it is the only copy of the pack's own quest text on your disk.
Installing the same bundle twice never overwrites it.

### Things you may see

- **"Windows protected your PC" (SmartScreen)**: these executables are unsigned. Choose
  \`More info\` → \`Run anyway\` if you are happy with where you got this. Code signing needs a
  certificate this project does not have.
- **No administrator rights are needed.** Anything asking for elevation is a bug.
- No network access, no telemetry. Nothing outside the instance you name is read or written.

---

## What is in this bundle / 収録物

| Path | What it is |
| ---- | ---------- |
| \`INSTALL-WINDOWS.cmd\`, \`UNINSTALL-WINDOWS.cmd\` | Windows launchers |
| \`INSTALL-LINUX.sh\`, \`UNINSTALL-LINUX.sh\` | Linux launchers |
${binaryRows}| \`payload/\` | the translated file${targets.length === 1 ? "" : "s"}: ${
    targets.join(", ")
  } |
| \`bundle-manifest.json\` | digests of everything above |
| \`translation-manifest.json\`, \`translation-report.json\` | what the translation run did |

The pack's own ${manifest.sourceLocale} text is **not** in this bundle. Only the translated file is.

Built by modpack-quest-translator ${manifest.toolVersion} on ${manifest.generatedAt}.
`;
}
