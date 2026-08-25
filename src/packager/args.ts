import { AppError } from "../errors.ts";

export type PackagerMode = "package" | "help" | "version";

export interface PackagerOptions {
  mode: PackagerMode;
  overlay: string;
  output: string;
  /** The modpack archive the translation run read. Required; see provenance.ts. */
  sourceArchive: string;
  manifest?: string;
  report?: string;
  binariesDir?: string;
  linuxBinary?: string;
  windowsBinary?: string;
  noBinaries: boolean;
  bundleId?: string;
  /** ISO-8601 override; otherwise taken from the translation manifest. */
  generatedAt?: string;
  force: boolean;
  json: boolean;
  quiet: boolean;
}

const VALUE_FLAGS = new Set([
  "--overlay",
  "--output",
  "--source-archive",
  "-o",
  "--manifest",
  "--report",
  "--binaries",
  "--linux-binary",
  "--windows-binary",
  "--bundle-id",
  "--generated-at",
]);

const BOOLEAN_FLAGS = new Set([
  "--no-binaries",
  "--force",
  "--json",
  "--quiet",
  "--help",
  "-h",
  "--version",
]);

function usage(message: string, hint?: string): AppError {
  return new AppError("E_INVALID_INPUT", message, {
    hint: hint ?? "Run `package-installer --help` for usage.",
  });
}

export function parsePackagerArgs(argv: readonly string[]): PackagerOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("-")) throw usage(`Unexpected argument: ${token}`);

    const eq = token.indexOf("=");
    const name = eq >= 0 ? token.slice(0, eq) : token;
    const inline = eq >= 0 ? token.slice(eq + 1) : undefined;

    if (BOOLEAN_FLAGS.has(name) && inline === undefined) {
      switches.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw usage(`Unknown option: ${name}`);

    const value = inline ?? argv[++i];
    if (value === undefined) throw usage(`Option ${name} requires a value`);
    values.set(name === "-o" ? "--output" : name, value);
  }

  if (switches.has("--help") || switches.has("-h") || argv.length === 0) return blank("help");
  if (switches.has("--version")) return blank("version");

  const overlay = values.get("--overlay");
  if (!overlay) throw usage("--overlay is required, e.g. --overlay ./dist/aca-ja.zip");
  const output = values.get("--output");
  if (!output) throw usage("--output is required, e.g. --output ./dist/aca-ja-installer.zip");
  const sourceArchive = values.get("--source-archive");
  if (!sourceArchive) {
    throw usage(
      "--source-archive is required, e.g. --source-archive ./aca-v2.4.zip",
      "It has to be the modpack archive the translation run read. The packager re-reads the " +
        "pack's own quest file out of it to prove the payload is a translation and not that " +
        "file; a manifest alone cannot prove it, because whoever writes the payload writes the " +
        "manifest beside it.",
    );
  }

  const noBinaries = switches.has("--no-binaries");
  const linuxBinary = values.get("--linux-binary");
  const windowsBinary = values.get("--windows-binary");
  const binariesDir = values.get("--binaries");
  if (noBinaries && (linuxBinary || windowsBinary || binariesDir)) {
    throw usage(
      "--no-binaries cannot be combined with --binaries, --linux-binary or --windows-binary",
      "Choose one: a bundle with executables, or one without.",
    );
  }

  return {
    mode: "package",
    overlay,
    output,
    sourceArchive,
    ...optional(values, "--manifest", "manifest"),
    ...optional(values, "--report", "report"),
    ...(binariesDir !== undefined ? { binariesDir } : {}),
    ...(linuxBinary !== undefined ? { linuxBinary } : {}),
    ...(windowsBinary !== undefined ? { windowsBinary } : {}),
    noBinaries,
    ...optional(values, "--bundle-id", "bundleId"),
    ...optional(values, "--generated-at", "generatedAt"),
    force: switches.has("--force"),
    json: switches.has("--json"),
    quiet: switches.has("--quiet"),
  };
}

function optional(
  values: Map<string, string>,
  flag: string,
  key: string,
): Record<string, string> {
  const value = values.get(flag);
  return value === undefined ? {} : { [key]: value };
}

function blank(mode: PackagerMode): PackagerOptions {
  return {
    mode,
    overlay: "",
    output: "",
    sourceArchive: "",
    noBinaries: false,
    force: false,
    json: false,
    quiet: false,
  };
}
