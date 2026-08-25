import { AppError } from "../errors.ts";

export interface PackRef {
  readonly kind: "curseforge" | "modrinth" | "direct";
  /** Project slug (CurseForge / Modrinth). */
  readonly slug?: string;
  /** CurseForge file id, when the URL pins an exact release. */
  readonly fileId?: number;
  /** Modrinth version id, when the URL pins an exact release. */
  readonly versionId?: string;
  /** Absolute URL, for `direct`. */
  readonly url?: string;
  /** True when the URL uses plain http. */
  readonly insecure?: boolean;
  /** The URL as supplied, for reporting. */
  readonly source: string;
}

const ARCHIVE_EXTENSIONS = [".zip", ".mrpack"];

const HINT = "Supported: a CurseForge or Modrinth modpack project URL, a CurseForge " +
  "file/download URL, a Modrinth version URL, or a direct https URL to a .zip or " +
  ".mrpack archive. Use --archive <path> for a local file.";

function parse(raw: string): URL {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new AppError("E_INVALID_INPUT", "--url is empty", { hint: HINT });
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new AppError("E_INVALID_INPUT", `Not a valid URL: ${trimmed}`, { hint: HINT });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError(
      "E_INVALID_INPUT",
      `Unsupported URL scheme "${url.protocol}"; only http and https are allowed`,
      { hint: HINT },
    );
  }
  return url;
}

function segments(url: URL): string[] {
  return url.pathname.split("/").filter((s) => s.length > 0).map(decodeURIComponent);
}

function hostIs(url: URL, domain: string): boolean {
  const host = url.hostname.toLowerCase();
  return host === domain || host.endsWith(`.${domain}`);
}

function looksLikeArchive(url: URL): boolean {
  const path = url.pathname.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function parseFileId(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

function classifyCurseForge(url: URL, source: string, insecure: boolean): PackRef {
  const seg = segments(url);
  // Expected: /minecraft/modpacks/<slug>[/files/<id> | /download/<id>]
  const mcIndex = seg.indexOf("minecraft");
  const category = mcIndex >= 0 ? seg[mcIndex + 1] : undefined;
  const slug = mcIndex >= 0 ? seg[mcIndex + 2] : undefined;

  if (category !== "modpacks") {
    throw new AppError(
      "E_UNSUPPORTED_PACK",
      `CurseForge URL does not point at a modpack (category: ${category ?? "unknown"})`,
      { hint: HINT },
    );
  }
  if (!slug) {
    throw new AppError("E_UNSUPPORTED_PACK", "CurseForge modpack URL has no project slug", {
      hint: HINT,
    });
  }

  const rest = seg.slice(mcIndex + 3);
  let fileId: number | undefined;
  if (rest[0] === "files" || rest[0] === "download") fileId = parseFileId(rest[1] ?? null);
  fileId ??= parseFileId(url.searchParams.get("fileId"));

  return { kind: "curseforge", slug, fileId, insecure, source };
}

function classifyModrinth(url: URL, source: string, insecure: boolean): PackRef {
  const seg = segments(url);
  // Expected: /modpack/<slug>[/version/<id>]
  const [category, slug, ...rest] = seg;
  if (category !== "modpack") {
    throw new AppError(
      "E_UNSUPPORTED_PACK",
      `Modrinth URL does not point at a modpack (project type: ${category ?? "unknown"})`,
      { hint: HINT },
    );
  }
  if (!slug) {
    throw new AppError("E_UNSUPPORTED_PACK", "Modrinth modpack URL has no project slug", {
      hint: HINT,
    });
  }
  const versionId = rest[0] === "version" || rest[0] === "versions" ? rest[1] : undefined;
  return { kind: "modrinth", slug, versionId, insecure, source };
}

/** Pure classification of a user-supplied pack URL. Performs no I/O. */
export function classifyPackUrl(raw: string): PackRef {
  const url = parse(raw);
  const source = url.toString();
  const insecure = url.protocol === "http:";

  if (hostIs(url, "curseforge.com")) return classifyCurseForge(url, source, insecure);
  if (hostIs(url, "modrinth.com") && !hostIs(url, "cdn.modrinth.com")) {
    return classifyModrinth(url, source, insecure);
  }
  if (looksLikeArchive(url)) return { kind: "direct", url: source, insecure, source };

  throw new AppError(
    "E_UNSUPPORTED_PACK",
    `Cannot tell what modpack this URL refers to: ${source}`,
    { hint: HINT },
  );
}
