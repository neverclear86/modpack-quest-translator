import { AppError } from "../errors.ts";
import type { BoundedHttpClient } from "../net/http.ts";
import { classifyPackUrl } from "./url.ts";
import { resolveCurseForge } from "./curseforge.ts";
import { resolveModrinth } from "./modrinth.ts";
import { describePack, type ResolvedPack } from "./types.ts";

export { classifyPackUrl } from "./url.ts";
export type { PackRef } from "./url.ts";
export type { ResolvedPack } from "./types.ts";

export interface ResolveOptions {
  client: BoundedHttpClient;
  curseForgeApiKey?: string;
  allowPrerelease?: boolean;
  signal?: AbortSignal;
}

/** Turn a user-supplied URL into a concrete, downloadable release. */
export async function resolvePack(url: string, options: ResolveOptions): Promise<ResolvedPack> {
  const ref = classifyPackUrl(url);

  switch (ref.kind) {
    case "modrinth":
      return await resolveModrinth(ref, {
        client: options.client,
        allowPrerelease: options.allowPrerelease,
        signal: options.signal,
      });
    case "curseforge":
      return await resolveCurseForge(ref, {
        client: options.client,
        apiKey: options.curseForgeApiKey,
        allowPrerelease: options.allowPrerelease,
        signal: options.signal,
      });
    case "direct": {
      const fileName = fileNameFromUrl(ref.url!);
      const pack = {
        source: "direct" as const,
        versionName: fileName.replace(/\.(zip|mrpack)$/i, ""),
        downloadUrl: ref.url!,
        fileName,
        sourceUrl: ref.source,
      };
      return { ...pack, describe: () => describePack(pack) };
    }
  }
}

/** Treat a local archive as an already-resolved pack. */
export function resolveLocalArchive(path: string): ResolvedPack {
  const fileName = path.replace(/\\/g, "/").split("/").pop() ?? "pack.zip";
  const pack = {
    source: "local" as const,
    versionName: fileName.replace(/\.(zip|mrpack)$/i, ""),
    downloadUrl: path,
    fileName,
    sourceUrl: `file:${path}`,
  };
  return { ...pack, describe: () => describePack(pack) };
}

function fileNameFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last);
  } catch {
    // Fall through to the generic name.
  }
  throw new AppError("E_INVALID_INPUT", `Could not derive a file name from ${url}`);
}
