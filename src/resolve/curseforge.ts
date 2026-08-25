import { AppError, isAppError } from "../errors.ts";
import type { BoundedHttpClient } from "../net/http.ts";
import type { PackRef } from "./url.ts";
import { describePack, type ResolvedPack } from "./types.ts";

const API = "https://api.curseforge.com/v1";
const GAME_MINECRAFT = 432;
const CLASS_MODPACKS = 4471;

/** CurseForge releaseType: 1 = release, 2 = beta, 3 = alpha. */
const RELEASE_STABLE = 1;

const KEY_HINT = [
  "CurseForge requires an API key for programmatic access and its web endpoints are",
  "behind a bot challenge, so a key-less download is not possible for this project.",
  "Choose one of:",
  "  1. Set CURSEFORGE_API_KEY (or pass --curseforge-api-key). Keys are free from",
  "     https://console.curseforge.com/",
  "  2. Pass the direct CDN URL instead, e.g. https://mediafilez.forgecdn.net/files/...",
  "  3. Download the pack yourself and pass --archive <path-to.zip>",
].join("\n");

interface CurseForgeFile {
  id?: number;
  displayName?: string;
  fileName?: string;
  releaseType?: number;
  fileDate?: string;
  downloadUrl?: string | null;
  fileLength?: number;
  gameVersions?: string[];
}

interface CurseForgeMod {
  id?: number;
  name?: string;
  slug?: string;
  classId?: number;
}

export interface CurseForgeResolveOptions {
  client: BoundedHttpClient;
  apiKey?: string;
  allowPrerelease?: boolean;
  signal?: AbortSignal;
}

export async function resolveCurseForge(
  ref: PackRef,
  options: CurseForgeResolveOptions,
): Promise<ResolvedPack> {
  const slug = ref.slug!;
  const headers = options.apiKey ? { "x-api-key": options.apiKey } : undefined;

  const search = await get<{ data?: CurseForgeMod[] }>(
    options.client,
    `${API}/mods/search?gameId=${GAME_MINECRAFT}&classId=${CLASS_MODPACKS}&slug=${
      encodeURIComponent(slug)
    }`,
    headers,
    options.signal,
  );

  const mod = (search.data ?? []).find((m) => m.slug === slug) ?? (search.data ?? [])[0];
  if (!mod?.id) {
    throw new AppError(
      "E_UNSUPPORTED_PACK",
      `No CurseForge modpack found with the slug "${slug}"`,
      {
        hint: "Check the URL. Only modpack projects are supported, not individual mods " +
          "or resource packs.",
      },
    );
  }

  let file: CurseForgeFile;
  if (ref.fileId) {
    const response = await get<{ data?: CurseForgeFile }>(
      options.client,
      `${API}/mods/${mod.id}/files/${ref.fileId}`,
      headers,
      options.signal,
    );
    if (!response.data) {
      throw new AppError(
        "E_UNSUPPORTED_PACK",
        `CurseForge file ${ref.fileId} was not found for "${slug}"`,
      );
    }
    file = response.data;
  } else {
    const response = await get<{ data?: CurseForgeFile[] }>(
      options.client,
      `${API}/mods/${mod.id}/files?pageSize=50`,
      headers,
      options.signal,
    );
    file = pickLatest(response.data ?? [], slug, options.allowPrerelease ?? false);
  }

  if (!file.downloadUrl) {
    throw new AppError(
      "E_UNSUPPORTED_PACK",
      `CurseForge file "${file.displayName ?? file.fileName ?? file.id}" has no download URL`,
      {
        hint: "The project author has disabled third-party downloads for this file. " +
          "Download it manually from the CurseForge website and pass --archive <path>.",
      },
    );
  }

  const pack = {
    source: "curseforge" as const,
    projectName: mod.name,
    projectSlug: mod.slug ?? slug,
    versionName: file.displayName ?? file.fileName,
    minecraftVersion: (file.gameVersions ?? []).find((v) => /^\d+\.\d+/.test(v)),
    loader: (file.gameVersions ?? []).find((v) => !/^\d+\.\d+/.test(v)),
    publishedAt: file.fileDate,
    downloadUrl: file.downloadUrl,
    fileName: file.fileName ?? "pack.zip",
    fileSize: file.fileLength,
    sourceUrl: ref.source,
    downloadHeaders: headers,
  };
  return { ...pack, describe: () => describePack(pack) };
}

async function get<T>(
  client: BoundedHttpClient,
  url: string,
  headers: Record<string, string> | undefined,
  signal: AbortSignal | undefined,
): Promise<T> {
  try {
    return await client.getJson<T>(url, { headers, signal });
  } catch (error) {
    const status = isAppError(error) ? Number(error.details?.status) : undefined;
    if (status === 401 || status === 403) {
      throw new AppError(
        "E_UNSUPPORTED_PACK",
        headers
          ? "CurseForge rejected the supplied API key"
          : "CurseForge refused the request because no API key was supplied",
        { cause: error, hint: KEY_HINT },
      );
    }
    throw error;
  }
}

function pickLatest(
  files: CurseForgeFile[],
  slug: string,
  allowPrerelease: boolean,
): CurseForgeFile {
  if (files.length === 0) {
    throw new AppError("E_UNSUPPORTED_PACK", `CurseForge modpack "${slug}" has no published files`);
  }
  const byDate = [...files].sort((a, b) => (b.fileDate ?? "").localeCompare(a.fileDate ?? ""));
  if (allowPrerelease) return byDate[0];

  const stable = byDate.find((f) => f.releaseType === RELEASE_STABLE);
  if (stable) return stable;

  throw new AppError(
    "E_UNSUPPORTED_PACK",
    `CurseForge modpack "${slug}" has no stable release (only alpha/beta files)`,
    { hint: "Pass --allow-prerelease, or pin an exact file URL." },
  );
}
