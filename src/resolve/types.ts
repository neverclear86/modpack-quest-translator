export interface ResolvedPack {
  source: "curseforge" | "modrinth" | "direct" | "local";
  projectName?: string;
  projectSlug?: string;
  versionName?: string;
  minecraftVersion?: string;
  loader?: string;
  publishedAt?: string;
  downloadUrl: string;
  fileName: string;
  fileSize?: number;
  /** The URL the user supplied, for the manifest. */
  sourceUrl: string;
  /** Extra request headers required to download, e.g. a CurseForge key. */
  downloadHeaders?: Record<string, string>;
  describe(): string;
}

export function describePack(pack: Omit<ResolvedPack, "describe">): string {
  const parts = [
    pack.projectName ?? pack.fileName,
    pack.versionName ? `version ${pack.versionName}` : undefined,
    pack.minecraftVersion ? `Minecraft ${pack.minecraftVersion}` : undefined,
    pack.loader,
    pack.publishedAt ? `published ${pack.publishedAt}` : undefined,
  ].filter(Boolean);
  return `${parts.join(" · ")}\n  download: ${pack.downloadUrl}`;
}
