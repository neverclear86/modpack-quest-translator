import { AppError } from "../errors.ts";
import type { BoundedHttpClient } from "../net/http.ts";
import type { PackRef } from "./url.ts";
import { describePack, type ResolvedPack } from "./types.ts";

const API = "https://api.modrinth.com/v2";

interface ModrinthProject {
  slug?: string;
  title?: string;
  project_type?: string;
}

interface ModrinthFile {
  filename?: string;
  url?: string;
  size?: number;
  primary?: boolean;
}

interface ModrinthVersion {
  id?: string;
  version_number?: string;
  version_type?: string;
  game_versions?: string[];
  loaders?: string[];
  date_published?: string;
  files?: ModrinthFile[];
}

export interface ModrinthResolveOptions {
  client: BoundedHttpClient;
  allowPrerelease?: boolean;
  signal?: AbortSignal;
}

export async function resolveModrinth(
  ref: PackRef,
  options: ModrinthResolveOptions,
): Promise<ResolvedPack> {
  const slug = ref.slug!;
  const project = await options.client.getJson<ModrinthProject>(
    `${API}/project/${encodeURIComponent(slug)}`,
    { signal: options.signal },
  ).catch((cause) => {
    throw new AppError("E_UNSUPPORTED_PACK", `Could not find the Modrinth project "${slug}"`, {
      cause,
      hint: "Check the URL, or pass a direct .mrpack download URL instead.",
    });
  });

  if (project.project_type !== undefined && project.project_type !== "modpack") {
    throw new AppError(
      "E_UNSUPPORTED_PACK",
      `Modrinth project "${slug}" is a ${project.project_type}, not a modpack`,
      { hint: "This tool translates modpack quest files; point it at a modpack project." },
    );
  }

  let version: ModrinthVersion;
  if (ref.versionId) {
    version = await options.client.getJson<ModrinthVersion>(
      `${API}/version/${encodeURIComponent(ref.versionId)}`,
      { signal: options.signal },
    ).catch((cause) => {
      throw new AppError(
        "E_UNSUPPORTED_PACK",
        `Could not find Modrinth version "${ref.versionId}" of "${slug}"`,
        { cause },
      );
    });
  } else {
    const versions = await options.client.getJson<ModrinthVersion[]>(
      `${API}/project/${encodeURIComponent(slug)}/version`,
      { signal: options.signal },
    );
    version = pickLatest(versions, slug, options.allowPrerelease ?? false);
  }

  const file = pickFile(version, slug);
  const pack = {
    source: "modrinth" as const,
    projectName: project.title,
    projectSlug: project.slug ?? slug,
    versionName: version.version_number ?? version.id,
    minecraftVersion: version.game_versions?.[0],
    loader: version.loaders?.[0],
    publishedAt: version.date_published,
    downloadUrl: file.url!,
    fileName: file.filename ?? "pack.mrpack",
    fileSize: file.size,
    sourceUrl: ref.source,
  };
  return { ...pack, describe: () => describePack(pack) };
}

function pickLatest(
  versions: ModrinthVersion[],
  slug: string,
  allowPrerelease: boolean,
): ModrinthVersion {
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new AppError("E_UNSUPPORTED_PACK", `Modrinth project "${slug}" has no published versions`, {
      hint: "There is nothing to download yet.",
    });
  }
  const byDate = [...versions].sort((a, b) =>
    (b.date_published ?? "").localeCompare(a.date_published ?? "")
  );
  if (allowPrerelease) return byDate[0];

  const stable = byDate.find((v) => v.version_type === "release");
  if (stable) return stable;

  throw new AppError(
    "E_UNSUPPORTED_PACK",
    `Modrinth project "${slug}" has no stable release (only alpha/beta versions)`,
    { hint: "Pass --allow-prerelease to translate a pre-release, or pin an exact version URL." },
  );
}

function pickFile(version: ModrinthVersion, slug: string): ModrinthFile {
  const files = version.files ?? [];
  const candidate = files.find((f) => f.primary === true) ??
    files.find((f) => f.filename?.toLowerCase().endsWith(".mrpack")) ??
    files[0];
  if (!candidate?.url) {
    throw new AppError(
      "E_UNSUPPORTED_PACK",
      `Modrinth version "${version.version_number ?? version.id}" of "${slug}" has no downloadable file`,
    );
  }
  return candidate;
}
