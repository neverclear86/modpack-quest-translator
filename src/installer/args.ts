import { AppError } from "../errors.ts";

export type InstallerMode = "install" | "uninstall" | "status" | "help" | "version";

export interface InstallerOptions {
  mode: InstallerMode;
  /** The extracted bundle directory; defaulted from the executable when absent. */
  bundleDir?: string;
  /** Absent only when a terminal is available to prompt on. */
  instance?: string;
  force: boolean;
  json: boolean;
  /** Skip the "about to replace X" confirmation. */
  assumeYes: boolean;
}

export interface ParseOptions {
  /** True when there is a terminal to prompt on. */
  interactive: boolean;
}

const VALUE_FLAGS = new Set(["--bundle", "--instance"]);
const BOOLEAN_FLAGS = new Set(["--force", "--json", "--yes", "-y", "--help", "-h", "--version"]);
/** Flags each subcommand accepts beyond the shared ones. */
const MUTATING_FLAGS = new Set(["--force", "--yes", "-y"]);

function usage(message: string, hint?: string): AppError {
  return new AppError("E_INVALID_INPUT", message, {
    hint: hint ?? "Run `mqt-installer --help` for usage.",
  });
}

/**
 * Parse argv for the installer.
 *
 * `--instance` is optional only when there is a terminal to ask on -- that is
 * the double-click flow. Without one it is required, so a script or a test can
 * never hang waiting for input nobody is there to give.
 */
export function parseInstallerArgs(
  argv: readonly string[],
  options: ParseOptions,
): InstallerOptions {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  let mode: InstallerMode | undefined;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    if (!token.startsWith("-")) {
      if (mode !== undefined) throw usage(`Unexpected argument: ${token}`);
      if (token !== "install" && token !== "uninstall" && token !== "status") {
        throw usage(
          `Unknown command: ${token}`,
          "The commands are install, uninstall and status.",
        );
      }
      mode = token;
      continue;
    }

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
    values.set(name, value);
  }

  if (switches.has("--help") || switches.has("-h") || mode === undefined) {
    return blank(switches.has("--version") && !switches.has("--help") ? "version" : "help");
  }
  if (switches.has("--version")) return blank("version");

  if (mode === "status") {
    for (const flag of MUTATING_FLAGS) {
      if (switches.has(flag)) {
        throw usage(`status does not take ${flag}: it never changes anything`);
      }
    }
  }

  const instance = values.get("--instance");
  if (instance !== undefined && instance.trim().length === 0) {
    throw usage("--instance is empty");
  }
  if (instance === undefined && !options.interactive) {
    throw usage(
      "--instance is required when the installer is not run from a terminal",
      "Pass --instance /path/to/your/minecraft/instance.",
    );
  }

  const bundleDir = values.get("--bundle");
  if (bundleDir !== undefined && bundleDir.trim().length === 0) {
    throw usage("--bundle is empty");
  }

  return {
    mode,
    ...(bundleDir !== undefined ? { bundleDir } : {}),
    ...(instance !== undefined ? { instance } : {}),
    force: switches.has("--force"),
    json: switches.has("--json"),
    assumeYes: switches.has("--yes") || switches.has("-y"),
  };
}

function blank(mode: InstallerMode): InstallerOptions {
  return { mode, force: false, json: false, assumeYes: false };
}
