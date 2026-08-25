/**
 * Builds a bundle directory and a Minecraft instance in a temp directory.
 *
 * The instance name carries a space and non-ASCII characters on purpose: every
 * state-machine test then exercises the path handling a Japanese user's
 * "インスタンス フォルダ" would hit, rather than a tidy ASCII path that proves
 * nothing.
 */
import { BUNDLE_FORMAT_VERSION } from "../../src/installer/bundle.ts";
import { sha256Hex } from "../../src/util/hash.ts";

export const TARGET_RELATIVE = "config/ftbquests/quests/lang/en_us.snbt";
export const JAPANESE = '{ quest.title: "空の冒険" }\n';
export const ENGLISH = '{ quest.title: "Skyward Adventure" }\n';
export const INSTANCE_NAME = "インスタンス フォルダ";

export interface FixtureOptions {
  /** Payload text the bundle installs. */
  payload?: string;
  /** More than one payload, keyed by instance-relative path. Overrides `payload`. */
  payloads?: Record<string, string>;
  /** File already at the target, or null for none. */
  existing?: string | null;
  bundleId?: string;
  toolVersion?: string;
}

export interface Fixture {
  dir: string;
  bundleDir: string;
  instanceRoot: string;
  targetPath: string;
  payload: string;
  bundleId: string;
  /** Build a second bundle directory, e.g. a later overlay release. */
  addBundle(name: string, options: FixtureOptions): Promise<string>;
  read(): Promise<string | null>;
  cleanup(): Promise<void>;
}

export async function writeBundleDir(dir: string, options: FixtureOptions = {}): Promise<string> {
  const payloads = options.payloads ?? { [TARGET_RELATIVE]: options.payload ?? JAPANESE };
  const bundleId = options.bundleId ?? "aca-2.4-ja_jp-en_us-override";

  const payload: { path: string; sha256: string; sizeBytes: number }[] = [];
  for (const path of Object.keys(payloads).sort()) {
    const bytes = new TextEncoder().encode(payloads[path]);
    await Deno.mkdir(`${dir}/payload/config/ftbquests/quests/lang`, { recursive: true });
    await Deno.writeFile(`${dir}/payload/${path}`, bytes);
    payload.push({ path, sha256: await sha256Hex(bytes), sizeBytes: bytes.byteLength });
  }

  await Deno.writeTextFile(
    `${dir}/bundle-manifest.json`,
    `${
      JSON.stringify(
        {
          formatVersion: BUNDLE_FORMAT_VERSION,
          bundleId,
          tool: "modpack-quest-translator",
          toolVersion: options.toolVersion ?? "1.1.0",
          generatedAt: "2026-08-25T00:00:00.000Z",
          pack: { name: "All of Create: Aeronautics", version: "2.4" },
          sourceLocale: "en_us",
          targetLocale: "ja_jp",
          overrideEnglish: true,
          containsSourceProse: false,
          payload,
          binaries: [],
        },
        null,
        2,
      )
    }\n`,
  );
  return dir;
}

export async function makeFixture(options: FixtureOptions = {}): Promise<Fixture> {
  const dir = await Deno.makeTempDir({ prefix: "mqt-install-" });
  const bundleDir = `${dir}/bundle`;
  const instanceRoot = `${dir}/${INSTANCE_NAME}`;
  const targetPath = `${instanceRoot}/${TARGET_RELATIVE}`;

  await writeBundleDir(bundleDir, options);
  await Deno.mkdir(`${instanceRoot}/mods`, { recursive: true });
  await Deno.mkdir(`${instanceRoot}/config`, { recursive: true });
  await Deno.mkdir(`${instanceRoot}/saves`, { recursive: true });

  const existing = options.existing === undefined ? ENGLISH : options.existing;
  if (existing !== null) {
    await Deno.mkdir(`${instanceRoot}/config/ftbquests/quests/lang`, { recursive: true });
    await Deno.writeTextFile(targetPath, existing);
  }

  return {
    dir,
    bundleDir,
    instanceRoot,
    targetPath,
    payload: options.payload ?? JAPANESE,
    bundleId: options.bundleId ?? "aca-2.4-ja_jp-en_us-override",
    async addBundle(name, bundleOptions) {
      const path = `${dir}/${name}`;
      await writeBundleDir(path, bundleOptions);
      return path;
    },
    async read() {
      try {
        return await Deno.readTextFile(targetPath);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return null;
        throw error;
      }
    },
    async cleanup() {
      await Deno.remove(dir, { recursive: true });
    },
  };
}

/** A clock that advances a minute each call, so captures order deterministically. */
export function fakeClock(start = "2026-08-25T14:22:33.000Z"): () => Date {
  let tick = 0;
  return () => new Date(new Date(start).getTime() + tick++ * 60_000);
}
