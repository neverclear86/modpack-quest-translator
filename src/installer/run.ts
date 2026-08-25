import { exitCodeFor } from "../errors.ts";
import { VERSION } from "../version.ts";
import { parseInstallerArgs } from "./args.ts";
import { BUNDLE_MANIFEST_NAME } from "./bundle.ts";
import { INSTALLER_HELP } from "./help.ts";
import { install, type OperationContext, status, uninstall } from "./operations.ts";
import { currentOs, joinNative, type OsKind } from "./paths.ts";
import {
  confirmationQuestion,
  describeError,
  describeInstall,
  describeStatus,
  describeUninstall,
} from "./report.ts";
import { AppError } from "../errors.ts";
import { dirnameOf } from "../util/fs.ts";

export interface InstallerDependencies {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  now?: () => Date;
  /** True when there is a terminal to prompt on. */
  isTerminal?: boolean;
  prompt?: (question: string) => string | null;
  /** Path of the running executable, used to find the bundle it sits in. */
  execPath?: string;
  os?: OsKind;
}

/** Entry point shared by the binary and the tests. Returns an exit code. */
export async function runInstaller(
  argv: readonly string[],
  deps: InstallerDependencies = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const os = deps.os ?? currentOs();
  const isTerminal = deps.isTerminal ?? false;
  const ask = deps.prompt ?? ((question: string) => prompt(question));

  let json = argv.includes("--json");
  try {
    const options = parseInstallerArgs(argv, { interactive: isTerminal });
    json = options.json;

    if (options.mode === "help") {
      stdout(INSTALLER_HELP);
      return 0;
    }
    if (options.mode === "version") {
      stdout(VERSION);
      return 0;
    }

    const bundleDir = options.bundleDir ?? await defaultBundleDir(deps.execPath, os);
    let instance = options.instance;
    if (instance === undefined) {
      const answer = ask(
        "Minecraft のインスタンスのフォルダーを入力してください\n" +
          "Enter the path to your Minecraft instance folder: ",
      );
      if (answer === null || answer.trim().length === 0) {
        stdout(cancelled().join("\n"));
        return 0;
      }
      instance = answer;
    }

    const context: OperationContext = {
      bundleDir,
      instanceInput: instance,
      force: options.force,
      now: deps.now ?? (() => new Date()),
      os,
    };

    if (options.mode === "status") {
      const result = await status(context);
      warn(result.warnings, stderr, json);
      stdout(
        json
          ? jsonLine({ ok: true, command: "status", ...result })
          : describeStatus(result).join("\n"),
      );
      return 0;
    }

    if (isTerminal && !options.assumeYes) {
      // The preview is a read-only pass over exactly the paths the operation
      // will touch, so the question names real files rather than a guess.
      const preview = await status(context);
      const answer = ask(confirmationQuestion(options.mode, preview));
      if (answer === null || !/^\s*(y|yes|はい)\s*$/i.test(answer)) {
        stdout(cancelled().join("\n"));
        return 0;
      }
    }

    if (options.mode === "install") {
      const result = await install(context);
      warn(result.warnings, stderr, json);
      stdout(
        json
          ? jsonLine({ ok: true, command: "install", ...result })
          : describeInstall(result).join("\n"),
      );
      return 0;
    }

    const result = await uninstall(context);
    warn(result.warnings, stderr, json);
    stdout(
      json
        ? jsonLine({ ok: true, command: "uninstall", ...result })
        : describeUninstall(result).join("\n"),
    );
    return 0;
  } catch (error) {
    const exitCode = exitCodeFor(error);
    if (json) {
      stdout(jsonLine({
        ok: false,
        code: error instanceof AppError ? error.code : "E_INTERNAL",
        exitCode,
        error: error instanceof Error ? error.message : String(error),
        ...(error instanceof AppError && error.hint ? { hint: error.hint } : {}),
      }));
    } else {
      for (const line of describeError(error)) stderr(line);
    }
    return exitCode;
  }
}

function cancelled(): string[] {
  return ["中止しました。何も変更していません。", "Cancelled. Nothing was changed."];
}

function warn(warnings: string[], stderr: (line: string) => void, json: boolean): void {
  if (json) return;
  for (const warning of warnings) stderr(`warning: ${warning}`);
}

function jsonLine(body: unknown): string {
  return JSON.stringify(body, null, 2);
}

/**
 * Where the bundle is when nobody said.
 *
 * The executable lives at `<bundle>/bin/<exe>`, so the bundle is two levels up;
 * a copy of the executable placed beside the manifest works too. Guessing any
 * further would be guessing.
 */
async function defaultBundleDir(execPath: string | undefined, os: OsKind): Promise<string> {
  const path = execPath ?? tryExecPath();
  const candidates: string[] = [];
  if (path) {
    const binDir = dirnameOf(path);
    candidates.push(dirnameOf(binDir), binDir);
  }
  for (const candidate of candidates) {
    try {
      await Deno.stat(joinNative(os, candidate, BUNDLE_MANIFEST_NAME));
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  throw new AppError("E_INVALID_INPUT", "Could not find the bundle to install from", {
    hint: `Pass --bundle pointing at the extracted folder that holds ${BUNDLE_MANIFEST_NAME}.`,
  });
}

function tryExecPath(): string | undefined {
  try {
    return Deno.execPath();
  } catch {
    return undefined;
  }
}
