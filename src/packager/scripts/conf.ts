/**
 * `scripts/installer.conf`: what the script installers read instead of
 * `bundle-manifest.json`.
 *
 * A POSIX sh script has no JSON parser, and a PowerShell one that parsed the
 * JSON would then differ from the sh one in exactly the place a bug would
 * hide. So both read one flat `key=value` file, written from the same facts
 * as the manifest and checked against it by the packager's tests. Values
 * never contain a newline, and every value that reaches a path goes through
 * the same allowlist the executable installer applies to the manifest.
 */
import { AppError } from "../../errors.ts";
import {
  assertPayloadPath,
  type BundleManifest,
  isPlainBundleId,
  TOOL_NAME,
} from "../../installer/bundle.ts";

export const INSTALLER_CONF_NAME = "installer.conf";
export const CONF_FORMAT_VERSION = 1;

/**
 * Where the scripts keep their state, inside the instance. Deliberately not
 * `.mqt-installer/`, which belongs to the executable installer: the two keep
 * different records, and a directory shared between them would let one read
 * the other's bookkeeping as its own.
 */
export const SCRIPT_STATE_DIR = ".mqt-installer-scripts";

export interface ConfPayload {
  path: string;
  sha256: string;
  sizeBytes: number;
  /** The pack's own file the translation was made from, by digest. */
  sourceSha256: string;
  sourceSizeBytes: number;
}

export interface InstallerConf {
  format: number;
  bundleId: string;
  tool: string;
  toolVersion: string;
  generatedAt: string;
  packName?: string;
  packVersion?: string;
  sourceLocale: string;
  targetLocale: string;
  stateDir: string;
  payloads: ConfPayload[];
}

const SHA256 = /^[0-9a-f]{64}$/;

function refuse(message: string): AppError {
  return new AppError("E_BUNDLE", message, {
    hint: "The bundle is corrupt or has been tampered with; download it again.",
  });
}

/** Printable, single-line, and free of `=`-confusing control characters. */
function displayValue(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  // deno-lint-ignore no-control-regex
  const clean = value.replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return clean.length > 0 ? clean : undefined;
}

export interface ConfSource {
  sourceFileSha256: string;
  sourceFileSizeBytes: number;
}

/** Render the conf from the manifest the bundle carries beside it. */
export function buildInstallerConf(manifest: BundleManifest, source: ConfSource): string {
  const lines = [
    `format=${CONF_FORMAT_VERSION}`,
    `bundleId=${manifest.bundleId}`,
    `tool=${manifest.tool}`,
    `toolVersion=${manifest.toolVersion}`,
    `generatedAt=${manifest.generatedAt}`,
  ];
  const packName = displayValue(manifest.pack.name);
  const packVersion = displayValue(manifest.pack.version);
  if (packName !== undefined) lines.push(`packName=${packName}`);
  if (packVersion !== undefined) lines.push(`packVersion=${packVersion}`);
  lines.push(
    `sourceLocale=${manifest.sourceLocale}`,
    `targetLocale=${manifest.targetLocale}`,
    `stateDir=${SCRIPT_STATE_DIR}`,
    `payloadCount=${manifest.payload.length}`,
  );
  manifest.payload.forEach((entry, index) => {
    const n = index + 1;
    lines.push(
      `payload.${n}.path=${entry.path}`,
      `payload.${n}.sha256=${entry.sha256}`,
      `payload.${n}.sizeBytes=${entry.sizeBytes}`,
      `payload.${n}.sourceSha256=${source.sourceFileSha256}`,
      `payload.${n}.sourceSizeBytes=${source.sourceFileSizeBytes}`,
    );
  });
  return `${lines.join("\n")}\n`;
}

/** Parse and validate, applying exactly the rules the scripts apply. */
export function parseInstallerConf(text: string): InstallerConf {
  if (text.includes("\r")) throw refuse(`${INSTALLER_CONF_NAME} contains carriage returns`);
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw refuse(`${INSTALLER_CONF_NAME} has a line that is not key=value`);
    const key = line.slice(0, eq);
    if (!/^[A-Za-z0-9.]+$/.test(key)) throw refuse(`${INSTALLER_CONF_NAME} has an unusable key`);
    if (values.has(key)) throw refuse(`${INSTALLER_CONF_NAME} repeats ${key}`);
    values.set(key, line.slice(eq + 1));
  }
  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined || value.length === 0) {
      throw refuse(`${INSTALLER_CONF_NAME} has no usable ${key}`);
    }
    return value;
  };
  const integer = (key: string): number => {
    const value = required(key);
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      throw refuse(`${INSTALLER_CONF_NAME} ${key} is not a whole number`);
    }
    return Number(value);
  };
  const digest = (key: string): string => {
    const value = required(key);
    if (!SHA256.test(value)) throw refuse(`${INSTALLER_CONF_NAME} ${key} is not a SHA-256`);
    return value;
  };

  const format = integer("format");
  if (format !== CONF_FORMAT_VERSION) {
    throw refuse(`${INSTALLER_CONF_NAME} declares format ${format}, not ${CONF_FORMAT_VERSION}`);
  }
  const bundleId = required("bundleId");
  if (!isPlainBundleId(bundleId)) throw refuse(`${INSTALLER_CONF_NAME} has an unusable bundleId`);
  const tool = required("tool");
  if (tool !== TOOL_NAME) throw refuse(`${INSTALLER_CONF_NAME} names the tool ${tool}`);
  const stateDir = required("stateDir");
  if (stateDir !== SCRIPT_STATE_DIR) {
    throw refuse(`${INSTALLER_CONF_NAME} names the state directory ${stateDir}`);
  }
  const count = integer("payloadCount");
  if (count < 1) throw refuse(`${INSTALLER_CONF_NAME} declares no payload`);
  const payloads: ConfPayload[] = [];
  for (let n = 1; n <= count; n++) {
    payloads.push({
      path: assertPayloadPath(required(`payload.${n}.path`)),
      sha256: digest(`payload.${n}.sha256`),
      sizeBytes: integer(`payload.${n}.sizeBytes`),
      sourceSha256: digest(`payload.${n}.sourceSha256`),
      sourceSizeBytes: integer(`payload.${n}.sourceSizeBytes`),
    });
  }
  const packName = values.get("packName");
  const packVersion = values.get("packVersion");
  return {
    format,
    bundleId,
    tool,
    toolVersion: required("toolVersion"),
    generatedAt: required("generatedAt"),
    ...(packName ? { packName } : {}),
    ...(packVersion ? { packVersion } : {}),
    sourceLocale: required("sourceLocale"),
    targetLocale: required("targetLocale"),
    stateDir,
    payloads,
  };
}
