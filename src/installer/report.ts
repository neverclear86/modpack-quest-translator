import { AppError, type ErrorCode } from "../errors.ts";
import type { InstallResult, StatusResult, UninstallResult } from "./operations.ts";

/**
 * Every user-facing line is a pair. The person double-clicking this is reading
 * quest text in Japanese; the English half is there for bug reports, and
 * because the maintainers read it.
 */
export interface Bilingual {
  ja: string;
  en: string;
}

export function lines(pairs: Bilingual[]): string[] {
  const out: string[] = [];
  for (const pair of pairs) {
    out.push(pair.ja, pair.en, "");
  }
  if (out.length > 0) out.pop();
  return out;
}

/** A short Japanese gloss per exit code; the English detail follows it. */
const ERROR_GLOSS: Record<ErrorCode, string> = {
  E_INTERNAL: "予期しないエラーが発生しました",
  E_INVALID_INPUT: "指定された内容に誤りがあります",
  E_UNSUPPORTED_PACK: "このパックには対応していません",
  E_DOWNLOAD: "ダウンロードに失敗しました",
  E_NO_QUEST_LOCALIZATION: "クエストの言語ファイルが見つかりません",
  E_TRANSLATION: "翻訳に失敗しました",
  E_VALIDATION: "翻訳結果の検証に失敗しました",
  E_WRITE: "ファイルの書き込みに失敗しました",
  E_PREFLIGHT: "実行前の確認に失敗しました",
  E_BUNDLE: "配布物 (バンドル) が壊れているか、改ざんされています",
  E_INSTANCE: "指定されたフォルダーは Minecraft のインスタンスではありません",
  E_TARGET_MODIFIED: "導入後にファイルが変更されているため、中止しました",
  E_BACKUP: "使用できるバックアップが見つからないため、何も変更していません",
  E_NOT_INSTALLED: "このインスタンスには何も導入されていません",
  E_SOURCE_MISMATCH: "パックのクエストファイルが、この翻訳の元になったものと一致しません",
  E_CANCELLED: "中断されました",
};

export function describeError(error: unknown): string[] {
  if (!(error instanceof AppError)) {
    const message = error instanceof Error ? error.message : String(error);
    return [`エラー (E_INTERNAL): ${ERROR_GLOSS.E_INTERNAL}`, `error (E_INTERNAL): ${message}`];
  }
  const out = [
    `エラー (${error.code}): ${ERROR_GLOSS[error.code]}`,
    `error (${error.code}): ${error.message}`,
  ];
  if (error.hint) out.push(`hint: ${error.hint}`);
  return out;
}

export function describeInstall(result: InstallResult): string[] {
  const pairs: Bilingual[] = [{
    ja: `インストール先: ${result.instance.root}`,
    en: `Instance:   ${result.instance.root}`,
  }];
  if (result.instance.descendedInto) {
    pairs.push({
      ja: `(${result.instance.descendedInto}/ を使用しました)`,
      en: `(resolved into ${result.instance.descendedInto}/)`,
    });
  }

  for (const target of result.targets) {
    if (target.status === "already-installed") {
      pairs.push({
        ja: `すでに導入済みです。変更はありません: ${target.relativePath}`,
        en: `Already installed, nothing to do: ${target.relativePath}`,
      });
      continue;
    }
    pairs.push({
      ja: `${verbJa(target.status)}: ${target.relativePath}`,
      en: `${verbEn(target.status)}: ${target.relativePath}`,
    });
    if (target.backup?.kind === "original") {
      pairs.push({
        ja: `元のファイルを保存しました: .mqt-installer/${target.backup.relativePath}`,
        en: `The original file was saved to .mqt-installer/${target.backup.relativePath}`,
      });
    } else if (target.backup?.kind === "absent") {
      pairs.push({
        ja: "元のファイルはありませんでした。削除すれば元の状態に戻ります",
        en: "There was no file here before; removing it restores the original state",
      });
    } else if (target.backup?.kind === "modified-install") {
      pairs.push({
        ja: `変更されていたファイルを保存しました: .mqt-installer/${target.backup.relativePath}`,
        en: `The file that was there was kept at .mqt-installer/${target.backup.relativePath}`,
      });
    }
  }

  pairs.push({
    ja: "元に戻すにはアンインストーラーを実行してください",
    en: "To undo this, run the uninstaller from the same bundle",
  });
  return lines(pairs);
}

function verbJa(status: string): string {
  if (status === "upgraded") return "更新しました";
  if (status === "reinstalled") return "再導入しました";
  return "導入しました";
}

function verbEn(status: string): string {
  if (status === "upgraded") return "Updated";
  if (status === "reinstalled") return "Reinstalled";
  return "Installed";
}

export function describeUninstall(result: UninstallResult): string[] {
  const pairs: Bilingual[] = [{
    ja: `対象: ${result.instance.root}`,
    en: `Instance: ${result.instance.root}`,
  }];
  for (const target of result.targets) {
    if (target.status === "deleted") {
      pairs.push({
        ja: `削除しました (導入前は存在しなかったため): ${target.relativePath}`,
        en: `Deleted, because there was no file here before: ${target.relativePath}`,
      });
    } else {
      pairs.push({
        ja: `元のファイルを復元しました: ${target.relativePath}`,
        en: `Restored the original file: ${target.relativePath}`,
      });
      pairs.push({
        ja: `復元元: .mqt-installer/${target.restoredFrom}`,
        en: `Restored from .mqt-installer/${target.restoredFrom}`,
      });
    }
    if (target.keptModifiedAs) {
      pairs.push({
        ja: `変更されていたファイルは .mqt-installer/${target.keptModifiedAs} に保存しました`,
        en: `Your edited file was kept at .mqt-installer/${target.keptModifiedAs}`,
      });
    }
  }
  pairs.push({
    ja: "バックアップは削除していません",
    en: "No backup was deleted",
  });
  return lines(pairs);
}

export function describeStatus(result: StatusResult): string[] {
  const pairs: Bilingual[] = [
    { ja: `対象: ${result.instance.root}`, en: `Instance: ${result.instance.root}` },
    { ja: `バンドル: ${result.bundleId}`, en: `Bundle:   ${result.bundleId}` },
  ];
  for (const target of result.targets) {
    if (target.modified) {
      pairs.push({
        ja: `導入済みですが、その後変更されています: ${target.relativePath}`,
        en: `Installed, but edited since: ${target.relativePath}`,
      });
    } else if (target.matchesBundle) {
      pairs.push({
        ja: `このバンドルが導入されています: ${target.relativePath}`,
        en: `This bundle is installed: ${target.relativePath}`,
      });
    } else if (target.present) {
      pairs.push({
        ja: `このバンドルは導入されていません: ${target.relativePath}`,
        en: `This bundle is not installed: ${target.relativePath}`,
      });
    } else {
      pairs.push({
        ja: `ファイルがありません: ${target.relativePath}`,
        en: `No file there: ${target.relativePath}`,
      });
    }
    pairs.push(
      target.restorableFrom
        ? {
          ja: `復元できるバックアップがあります: .mqt-installer/${target.restorableFrom}`,
          en: `A restorable backup is present: .mqt-installer/${target.restorableFrom}`,
        }
        : {
          ja: "復元できるバックアップはありません",
          en: "No restorable backup is present",
        },
    );
  }
  return lines(pairs);
}

/** The confirmation shown before anything is written. */
export function confirmationQuestion(
  command: "install" | "uninstall",
  result: StatusResult,
): string {
  const targets = result.targets.map((target) => target.relativePath).join(", ");
  const ja = command === "install"
    ? `${result.instance.root} の ${targets} を置き換えます。元のファイルは自動で保存されます。`
    : `${result.instance.root} の ${targets} を元のファイルに戻します。`;
  const en = command === "install"
    ? `About to replace ${targets} in ${result.instance.root}. The original is saved first.`
    : `About to restore ${targets} in ${result.instance.root}.`;
  return `${ja}\n${en}\n続行しますか / Continue? [y/N]: `;
}
