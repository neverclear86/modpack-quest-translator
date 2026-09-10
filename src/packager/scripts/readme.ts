import type { BundleManifest } from "../../installer/bundle.ts";
import { SCRIPT_STATE_DIR } from "./conf.ts";

/**
 * The README for a script bundle. Japanese, kept short, because the person
 * reading it wants to play; a brief English section follows for bug reports.
 * It says plainly what the Windows launcher can and cannot do about the
 * execution policy, and tells anyone who used the executable bundle to
 * uninstall with that first.
 */
export function buildScriptBundleReadme(manifest: BundleManifest): string {
  const pack = [manifest.pack.name, manifest.pack.version].filter(Boolean).join(" ");
  const targets = manifest.payload.map((entry) => entry.path).join(", ");
  const staged = manifest.payload.map((entry) => `${entry.path.split("/").pop()}.mqt-staged`)
    .join(" / ");
  return `# ${pack} クエスト翻訳（スクリプト版インストーラー）

${manifest.bundleId}

${
    manifest.pack.name ?? "このモッドパック"
  } のクエスト文章を ${manifest.targetLocale} に翻訳したものです。Minecraft 本体や他の MOD の表示は
英語のままで、クエストの進行状況にも影響しません。

この配布物には**実行ファイルが入っていません**。Windows は標準の PowerShell 5.1、Linux は標準の
\`sh\` と coreutils だけで動きます。Deno・Node・Python は不要で、ネットワークにも接続しません。

## 必要なもの

- **Windows 10 / 11**（Windows PowerShell 5.1 が標準で入っています）
- **Linux**: \`sh\`（dash / bash / busybox）、coreutils（\`sha256sum\` \`cp\` \`mv\` \`ln\` \`sync\` など）、\`grep\`、\`sed\`
- インスタンスは NTFS / ext4 / btrfs / APFS など、ハードリンクの使えるファイルシステム上にあること
  （FAT32 の USB メモリ上では、安全に書き込めないため中止します）

## 導入のしかた

1. **Minecraft を終了**してください。ランチャーも閉じておくと確実です。
2. この ZIP を**すべて展開**します（中の \`.cmd\` を ZIP の中から直接実行しても動きません）。
3. **Windows**: \`INSTALL-WINDOWS.cmd\` をダブルクリックし、開いたウィンドウに Minecraft の
   **インスタンスのフォルダー**をドラッグして Enter を押します。
   **Linux**: 端末で \`./INSTALL-LINUX.sh /path/to/instance\` を実行します（パスを省くと入力を求められます）。
4. \`続行しますか / Continue? [y/N]:\` に \`y\` と答えます。
5. 「**導入しました**」と表示されれば完了です。Minecraft を起動してください。

インスタンスのフォルダーとは \`mods\` \`config\` \`saves\` が入っているフォルダーです。Prism / MultiMC
のように \`.minecraft\` または \`minecraft\` を含むフォルダーを渡しても構いません。スペースや日本語を
含むパスでも動きます。

## 元に戻すには

Minecraft を終了してから \`UNINSTALL-WINDOWS.cmd\`（Linux は \`./UNINSTALL-LINUX.sh\`）を同じ手順で
実行してください。導入前のファイルが **1 バイトも違わずに**戻ります。書き戻す前にバックアップの
SHA-256 とサイズを照合し、合わなければ何も書かずに終了します（終了コード 13）。
\`STATUS-WINDOWS.cmd\` / \`./STATUS-LINUX.sh\` は現在の状態を表示するだけで、何も変更しません。

## バックアップ

- 導入時、元のファイルは \`<インスタンス>/${SCRIPT_STATE_DIR}/backups/\` に保存されます。
  **このフォルダーは削除しないでください。** パックの元のクエスト文章が残る唯一の控えです。
- 同じ配布物を二度導入しても、何も書き換えず「すでに導入済みです」と表示して終わります。
  バックアップが翻訳ファイルで上書きされることはありません。
- バックアップは自動では消えません。導入 → 削除 → 再導入を繰り返しても安全です。

## 中止される場合（安全のため）

- **パックのバージョンが違う**（終了コード 15）: 導入先の \`en_us.snbt\` が、この翻訳の元になった
  ${pack} のファイルと一致しないときは中止します。別バージョンの翻訳を入れるとクエストが壊れることが
  あるためです。それでも入れる場合は \`--force\`（Windows は \`-Force\`）を付けて実行してください。
  その場合も元のファイルは先にバックアップされます。
- **導入後にファイルを編集していた**（終了コード 12）: 編集を黙って捨てません。\`--force\` を付けると、
  編集後のファイルを \`backups/\` に \`modified\` として保存**してから**処理します。
- **シンボリックリンク・ジャンクション**が対象やその途中にある場合、インスタンスの外を指すパス、
  \`mods\` と \`config\` の無いフォルダーは中止します（終了コード 11）。\`--force\` でも変わりません。
- **実行ファイル版のインストーラーで導入済み**の場合（終了コード 11）: 以前の配布物（\`bin/\` に
  実行ファイルが入っていたもの）で導入した翻訳は、\`<インスタンス>/.mqt-installer/\` に記録が残っています。
  この配布物はその記録を引き継ぎません。**先に以前の配布物の UNINSTALL を実行して元に戻してから**、
  この配布物の INSTALL を実行してください。翻訳ファイルを手でコピーしていた場合も、先に元のファイルを
  戻してください。

## 途中で止まった場合の復旧

書き込みは「元のファイルを \`${staged}\` に退避 → 新しいファイルを空いた名前に置く →
退避を消す」の順で行い、既存のファイルの上書きは一切しません。そのため、電源断や強制終了の
タイミングによっては、**対象ファイルが無く \`.mqt-staged\` だけが残っている**状態になります。
これは「元のまま」でも「導入済み」でもない中間状態で、その間 Minecraft はクエスト文章を読めません。

- 次に INSTALL か UNINSTALL を実行すると、まず退避ファイルを元の名前に戻します。その名前が別の
  ファイルに取られていた場合は、退避ファイルを \`backups/\` に \`displaced\` として保存し、
  新しい方のファイルを対象として扱います。\`.mqt-tmp-*\` の書きかけファイルは削除します。
- STATUS はこれらを警告として表示するだけで、片付けも含めて**何も書きません**。
- 復旧は自動ですが、内容の確認は行いません。\`.mqt-staged\` が残っていたら、実行前に何が起きたかを
  \`STATUS\` で確認することをおすすめします。
- バックアップは書き込み後に \`sync\` していますが、Windows PowerShell からはディレクトリの同期を
  呼べないため、書き込み直後の電源断でディレクトリ項目が失われる可能性は NTFS のジャーナルに
  委ねています。

## 検証していないこと・保証しないこと

- PowerShell スクリプトの自動テストは **Linux 上の PowerShell 7 (\`pwsh\`)** で行ったものだけです。
  実機の Windows、Windows PowerShell 5.1、NTFS のジャンクション、\`.cmd\` ランチャーは
  自動テストしていません。動くように書いてありますが、確かめていない部分です。
- Minecraft や同期ソフトが同じファイルへ**同時に**書き込む状況は想定していません。書き込み直前に
  内容を再確認し、別のファイルが現れていればそれを残して中止しますが（終了コード 12）、
  意図的に妨害するプロセスに対して整合性を保証するものではありません。
- \`backups/\` の中身は照合しますが、守るのはユーザー自身です。削除・編集されたバックアップは
  復元できません（終了コード 13 で中止します）。

## Windows の ExecutionPolicy について

Windows は既定で \`.ps1\` スクリプトの実行を禁止しています。\`.cmd\` ランチャーは PowerShell を
\`-ExecutionPolicy Bypass\` 付きで起動しますが、これは**そのプロセス 1 回限り**の指定で、PC の設定は
何も変更しません（\`Set-ExecutionPolicy\` は実行せず、レジストリにも触れません）。管理者権限も不要です。

- ダウンロードした \`.cmd\` に「**WindowsによってPCが保護されました**」(SmartScreen) が出ることが
  あります。内容を確認したうえで \`詳細情報\` → \`実行\` を選んでください。署名には証明書が必要で、
  このプロジェクトは取得していません。
- 会社や学校の PC で**グループポリシー**により実行ポリシーが固定されている場合、\`Bypass\` は
  効かず、スクリプトは起動できません。この配布物にはそれを回避する手段はありません（意図的にそうして
  います）。その PC の管理者に相談するか、別の PC で導入してください。
- PowerShell が「制約付き言語モード」(AppLocker / WDAC) の場合も動きません。
- PowerShell 7 (\`pwsh\`) でも動きますが、\`.cmd\` は常に Windows 標準の \`powershell.exe\` (5.1) を使います。
- 手動で実行する場合:

  \`\`\`bat
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\mqt-installer.ps1 install -Instance "C:\\path\\to\\instance"
  \`\`\`

## 終了コード

| コード | 意味 |
| ------ | ---- |
| 0 | 成功（「すでに導入済み」と中止も含む） |
| 2 | 引数が不正 |
| 8 | 書き込み失敗（ハードリンク不可のファイルシステムを含む） |
| 10 | 配布物が壊れている・不完全 |
| 11 | インスタンスではない／シンボリックリンク／実行ファイル版で導入済み |
| 12 | 導入後にファイルが変更されている（\`--force\` で続行） |
| 13 | 使えるバックアップが無い |
| 14 | 何も導入されていない |
| 15 | パックのクエストファイルが翻訳元と一致しない（\`--force\` で続行） |

## 収録物

| パス | 内容 |
| ---- | ---- |
| \`INSTALL-WINDOWS.cmd\` / \`UNINSTALL-WINDOWS.cmd\` / \`STATUS-WINDOWS.cmd\` | Windows 用ランチャー（PowerShell 5.1 を起動） |
| \`INSTALL-LINUX.sh\` / \`UNINSTALL-LINUX.sh\` / \`STATUS-LINUX.sh\` | Linux 用ランチャー（\`sh\` で起動） |
| \`scripts/mqt-installer.ps1\`, \`scripts/mqt-installer.sh\` | インストーラー本体 |
| \`scripts/installer.conf\` | スクリプトが読む配布物の記述（ペイロードと翻訳元ファイルの SHA-256） |
| \`payload/\` | 翻訳済みファイル: ${targets} |
| \`bundle-manifest.json\` | 配布物の記述（実行ファイル版と同じ形式。\`installer: scripts\`） |
| \`translation-manifest.json\`, \`translation-report.json\` | 翻訳時の記録 |

このモッドパック本来の ${manifest.sourceLocale} の文章はこの配布物には含まれていません。
\`installer.conf\` にある翻訳元ファイルの SHA-256 は、導入先のバージョン確認にだけ使います。
この配布物には署名がなく、ハッシュ値は破損や取り違えを防ぐもので、意図的な改変は防げません。
入手元を信頼できる範囲で信頼してください。

---

## English (brief)

A ${manifest.targetLocale} translation of ${
    manifest.pack.name ?? "this modpack"
  }'s quest text, installed by scripts only:
Windows PowerShell 5.1 on Windows, POSIX \`sh\` plus coreutils on Linux. No executables, no runtime,
no network. **Close Minecraft first.** Extract the whole ZIP, run \`INSTALL-WINDOWS.cmd\` or
\`./INSTALL-LINUX.sh <instance>\`, answer \`y\`. \`UNINSTALL-*\` restores the pack's own file byte for
byte from \`<instance>/${SCRIPT_STATE_DIR}/backups/\`, verified by SHA-256; never delete that directory.

The \`.cmd\` launchers run \`powershell.exe -NoProfile -ExecutionPolicy Bypass -File\`, which is
process-scoped and changes no setting; a Group Policy that pins the policy, or Constrained Language
Mode, stops the script and this bundle offers no way around that. The installer refuses a quest file
that is not the one the translation was made from (exit 15), an edited install (12), symlinks and
junctions (11), and an instance set up by the executable installer (11): run that bundle's UNINSTALL
first. \`--force\` / \`-Force\` overrides only 12 and 15, and always backs the file up first.

Writes never replace a file: the current one is moved to \`${staged}\`, the new one is
put at the free name, then the staged copy is removed. A power cut in between leaves the target
absent and only the \`.mqt-staged\` file present; that is an intermediate state, not "original or
installed". The next INSTALL or UNINSTALL puts the staged file back (or keeps it as a \`displaced\`
backup if the name was taken meanwhile) and removes \`.mqt-tmp-*\` leftovers; STATUS only reports
them and writes nothing.

Limitations: the PowerShell script has been exercised only under PowerShell 7 on Linux, not on
real Windows, Windows PowerShell 5.1, NTFS junctions or the \`.cmd\` launchers. No guarantee is made
against concurrent or malicious writers to the instance; the installer re-checks the file just
before publishing and stops (exit 12) if something else appeared, nothing more.

Built by modpack-quest-translator ${manifest.toolVersion} on ${manifest.generatedAt}.
`;
}
