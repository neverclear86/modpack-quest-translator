import { AppError, exitCodeFor } from "../errors.ts";
import { VERSION } from "../version.ts";
import { basenameOf, joinPath, pathExists, writeFileAtomic } from "../util/fs.ts";
import { sha256Hex } from "../util/hash.ts";
import { type PackagerOptions, parsePackagerArgs } from "./args.ts";
import {
  buildInstallerBundle,
  type PackagedBinary,
  TRANSLATION_MANIFEST_NAME,
  TRANSLATION_REPORT_NAME,
} from "./bundle.ts";
import { PACKAGER_HELP } from "./help.ts";
import { LINUX_BINARY_NAME, WINDOWS_BINARY_NAME } from "./launchers.ts";

export interface PackagerDependencies {
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

const BINARY_TARGETS = [
  { name: LINUX_BINARY_NAME, target: "x86_64-unknown-linux-gnu", flag: "--linux-binary" },
  { name: WINDOWS_BINARY_NAME, target: "x86_64-pc-windows-msvc", flag: "--windows-binary" },
] as const;

/** Entry point shared by the binary, the deno task and the tests. */
export async function runPackager(
  argv: readonly string[],
  deps: PackagerDependencies = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stderr = deps.stderr ?? ((line: string) => console.error(line));

  let json = argv.includes("--json");
  try {
    const options = parsePackagerArgs(argv);
    json = options.json;

    if (options.mode === "help") {
      stdout(PACKAGER_HELP);
      return 0;
    }
    if (options.mode === "version") {
      stdout(VERSION);
      return 0;
    }

    const overlay = await readRequired(options.overlay, "--overlay");
    const bundleId = options.bundleId ?? defaultBundleId(options.overlay);
    const binaries = await collectBinaries(options);

    const manifestText = await readSidecar(options, "manifest", TRANSLATION_MANIFEST_NAME);
    const reportText = await readSidecar(options, "report", TRANSLATION_REPORT_NAME);

    const built = await buildInstallerBundle({
      overlay,
      bundleId,
      toolVersion: VERSION,
      ...(options.generatedAt !== undefined ? { generatedAt: options.generatedAt } : {}),
      binaries,
      ...(manifestText !== undefined ? { translationManifest: manifestText } : {}),
      ...(reportText !== undefined ? { translationReport: reportText } : {}),
    });

    const output = await resolveOutput(options.output, bundleId, options.force);
    await writeFileAtomic(output, built.bytes);
    const digest = await sha256Hex(built.bytes);

    if (json) {
      stdout(JSON.stringify(
        {
          ok: true,
          bundleId,
          output,
          sha256: digest,
          sizeBytes: built.bytes.byteLength,
          payload: built.manifest.payload,
          binaries: built.manifest.binaries,
          generatedAt: built.manifest.generatedAt,
        },
        null,
        2,
      ));
    } else if (!options.quiet) {
      stdout(`wrote ${output}`);
      stdout(`  bundle id  ${bundleId}`);
      stdout(`  sha256     ${digest}`);
      stdout(`  payload    ${built.manifest.payload.map((entry) => entry.path).join(", ")}`);
      stdout(
        `  binaries   ${
          built.manifest.binaries.length === 0
            ? "none -- this bundle cannot be installed by double-clicking"
            : built.manifest.binaries.map((entry) => entry.target).join(", ")
        }`,
      );
    }
    return 0;
  } catch (error) {
    if (json) {
      stdout(JSON.stringify(
        {
          ok: false,
          code: error instanceof AppError ? error.code : "E_INTERNAL",
          error: error instanceof Error ? error.message : String(error),
          ...(error instanceof AppError && error.hint ? { hint: error.hint } : {}),
        },
        null,
        2,
      ));
    } else {
      stderr(`error: ${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof AppError && error.hint) stderr(`hint: ${error.hint}`);
    }
    return exitCodeFor(error);
  }
}

async function readRequired(path: string, flag: string): Promise<Uint8Array> {
  try {
    return await Deno.readFile(path);
  } catch (cause) {
    throw new AppError("E_INVALID_INPUT", `Could not read ${flag} ${path}`, {
      hint: "Check the path; nothing was written.",
      cause,
    });
  }
}

/** `--<kind>`, else the sidecar beside the overlay, else the copy inside it. */
async function readSidecar(
  options: PackagerOptions,
  kind: "manifest" | "report",
  _entryName: string,
): Promise<string | undefined> {
  const explicit = kind === "manifest" ? options.manifest : options.report;
  if (explicit !== undefined) {
    return new TextDecoder().decode(await readRequired(explicit, `--${kind}`));
  }
  const stem = options.overlay.replace(/\.zip$/i, "");
  const candidate = `${stem}.${kind}.json`;
  if (await pathExists(candidate)) return await Deno.readTextFile(candidate);
  // Fall through: buildInstallerBundle uses the copy inside the overlay.
  return undefined;
}

async function collectBinaries(options: PackagerOptions): Promise<PackagedBinary[]> {
  if (options.noBinaries) return [];

  const binaries: PackagedBinary[] = [];
  for (const spec of BINARY_TARGETS) {
    const explicit = spec.target.includes("windows") ? options.windowsBinary : options.linuxBinary;
    const path = explicit ??
      (options.binariesDir !== undefined ? joinPath(options.binariesDir, spec.name) : undefined);
    if (path === undefined) {
      throw new AppError("E_INVALID_INPUT", `No ${spec.name} to package`, {
        hint: `Pass --binaries <dir>, or ${spec.flag} <path>, or --no-binaries.`,
      });
    }
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(path);
    } catch (cause) {
      throw new AppError("E_INVALID_INPUT", `Could not read the installer binary ${path}`, {
        hint: "Run `deno task build:installers` first, or pass --no-binaries.",
        cause,
      });
    }
    binaries.push({ path: `bin/${spec.name}`, target: spec.target, bytes });
  }
  return binaries;
}

/** `.zip` names the exact file; anything else is a directory to write into. */
async function resolveOutput(output: string, bundleId: string, force: boolean): Promise<string> {
  const trimmed = output.replace(/[/\\]+$/, "");
  if (trimmed.length === 0) throw new AppError("E_INVALID_INPUT", "--output is empty");

  const path = /\.zip$/i.test(trimmed) ? trimmed : joinPath(trimmed, `${bundleId}-installer.zip`);
  if (!force && await pathExists(path)) {
    throw new AppError("E_WRITE", `Refusing to overwrite the existing file ${path}`, {
      hint: "Pass --force to overwrite, or choose a different --output.",
    });
  }
  return path;
}

function defaultBundleId(overlayPath: string): string {
  const stem = basenameOf(overlayPath).replace(/\.zip$/i, "");
  const safe = stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(
    /^[-.]+|[-.]+$/g,
    "",
  );
  return safe.length > 0 ? safe : "modpack-quest-translation";
}
