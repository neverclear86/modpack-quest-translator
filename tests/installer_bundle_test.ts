import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { AppError } from "../src/errors.ts";
import {
  BUNDLE_FORMAT_VERSION,
  type BundleManifest,
  loadBundle,
  loadBundleManifest,
  parseBundleManifest,
} from "../src/installer/bundle.ts";
import { sha256Hex } from "../src/util/hash.ts";

const PAYLOAD_TEXT = '{ quest.title: "\u7a7a\u306e\u5192\u967a" }\n';

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: BUNDLE_FORMAT_VERSION,
    bundleId: "aca-2.4-ja_jp-en_us-override",
    tool: "modpack-quest-translator",
    toolVersion: "1.1.0",
    generatedAt: "2026-08-25T00:00:00.000Z",
    pack: { name: "All of Create: Aeronautics", version: "2.4" },
    sourceLocale: "en_us",
    targetLocale: "ja_jp",
    overrideEnglish: true,
    containsSourceProse: false,
    payload: [{
      path: "config/ftbquests/quests/lang/en_us.snbt",
      sha256: "a".repeat(64),
      sizeBytes: 10,
    }],
    binaries: [],
    ...overrides,
  };
}

function parseFails(overrides: Record<string, unknown>, needle: string): void {
  const error = assertThrows(
    () => parseBundleManifest(JSON.stringify(manifest(overrides))),
    AppError,
  );
  assertEquals(error.code, "E_BUNDLE");
  assertStringIncludes(error.message, needle);
}

Deno.test("a well-formed bundle manifest round-trips", () => {
  const parsed: BundleManifest = parseBundleManifest(JSON.stringify(manifest()));
  assertEquals(parsed.bundleId, "aca-2.4-ja_jp-en_us-override");
  assertEquals(parsed.targetLocale, "ja_jp");
  assertEquals(parsed.overrideEnglish, true);
  assertEquals(parsed.payload[0].path, "config/ftbquests/quests/lang/en_us.snbt");
  assertEquals(parsed.payload[0].sizeBytes, 10);
});

Deno.test("a newer format version is refused rather than best-effort parsed", () => {
  const error = assertThrows(
    () => parseBundleManifest(JSON.stringify(manifest({ formatVersion: 2 }))),
    AppError,
  );
  assertEquals(error.code, "E_BUNDLE");
  assertStringIncludes(error.message, "newer version");
});

Deno.test("malformed manifests are refused field by field", () => {
  parseFails({ formatVersion: "1" }, "formatVersion");
  parseFails({ bundleId: "" }, "bundleId");
  parseFails({ toolVersion: 11 }, "toolVersion");
  parseFails({ targetLocale: null }, "targetLocale");
  parseFails({ payload: [] }, "payload");
  parseFails({ payload: "nope" }, "payload");
  parseFails({ binaries: { a: 1 } }, "binaries");
});

Deno.test("a manifest that is not JSON at all is refused", () => {
  const error = assertThrows(() => parseBundleManifest("{not json"), AppError);
  assertEquals(error.code, "E_BUNDLE");
});

Deno.test("a payload path that escapes the payload root is refused", () => {
  for (
    const path of [
      "../../saves/level.dat",
      "/etc/passwd",
      "C:\\Windows\\system32\\drivers\\etc\\hosts",
      "config/ftbquests/quests/lang/../../../../mods/evil.jar",
      "\\\\server\\share\\en_us.snbt",
    ]
  ) {
    const error = assertThrows(
      () => parseBundleManifest(JSON.stringify(manifest({ payload: [payloadOf(path)] }))),
      AppError,
      undefined,
      `expected ${path} to be refused`,
    );
    assertEquals(error.code, "E_BUNDLE");
  }
});

Deno.test("a payload path outside the quest lang directory is refused", () => {
  for (
    const path of [
      "mods/evil.jar",
      "config/ftbquests/quests/chapters/one.snbt",
      "config/ftbquests/quests/lang/nested/en_us.snbt",
      "config/ftbquests/quests/lang/en_us.txt",
      "config/ftbquests/quests/lang/.snbt",
    ]
  ) {
    const error = assertThrows(
      () => parseBundleManifest(JSON.stringify(manifest({ payload: [payloadOf(path)] }))),
      AppError,
      undefined,
      `expected ${path} to be refused`,
    );
    assertEquals(error.code, "E_BUNDLE");
    assertStringIncludes(error.message, "config/ftbquests/quests/lang");
  }
});

Deno.test("two payload entries for the same target are refused", () => {
  const entry = payloadOf("config/ftbquests/quests/lang/en_us.snbt");
  parseFails({ payload: [entry, entry] }, "twice");
});

Deno.test("a manifest claiming to contain source prose is refused", () => {
  parseFails({ containsSourceProse: true }, "containsSourceProse");
});

function payloadOf(path: string): Record<string, unknown> {
  return { path, sha256: "a".repeat(64), sizeBytes: 10 };
}

async function writeBundle(
  dir: string,
  payloadText: string | null,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  await Deno.mkdir(`${dir}/payload/config/ftbquests/quests/lang`, { recursive: true });
  const bytes = new TextEncoder().encode(payloadText ?? "");
  if (payloadText !== null) {
    await Deno.writeFile(`${dir}/payload/config/ftbquests/quests/lang/en_us.snbt`, bytes);
  }
  const body = manifest({
    payload: [{
      path: "config/ftbquests/quests/lang/en_us.snbt",
      sha256: await sha256Hex(bytes),
      sizeBytes: bytes.byteLength,
    }],
    ...overrides,
  });
  await Deno.writeTextFile(`${dir}/bundle-manifest.json`, JSON.stringify(body, null, 2));
}

async function withBundle(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "mqt-bundle-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("loading a bundle verifies every payload byte", async () => {
  await withBundle(async (dir) => {
    await writeBundle(dir, PAYLOAD_TEXT);
    const bundle = await loadBundle(dir);
    assertEquals(bundle.payload.length, 1);
    assertEquals(new TextDecoder().decode(bundle.payload[0].bytes), PAYLOAD_TEXT);
    assertEquals(bundle.manifest.bundleId, "aca-2.4-ja_jp-en_us-override");
  });
});

Deno.test("a payload file edited after packaging is refused", async () => {
  await withBundle(async (dir) => {
    await writeBundle(dir, PAYLOAD_TEXT);
    // Same length, different bytes: the digest is the only thing that catches it.
    await Deno.writeTextFile(
      `${dir}/payload/config/ftbquests/quests/lang/en_us.snbt`,
      PAYLOAD_TEXT.replace("\u5192", "\u9a13"),
    );
    const error = await assertRejects(() => loadBundle(dir), AppError);
    assertEquals(error.code, "E_BUNDLE");
    assertStringIncludes(error.message, "does not match");
  });
});

Deno.test("a payload file truncated after packaging is refused", async () => {
  await withBundle(async (dir) => {
    await writeBundle(dir, PAYLOAD_TEXT);
    await Deno.writeTextFile(`${dir}/payload/config/ftbquests/quests/lang/en_us.snbt`, "");
    const error = await assertRejects(() => loadBundle(dir), AppError);
    assertEquals(error.code, "E_BUNDLE");
  });
});

Deno.test("a missing payload file is refused", async () => {
  await withBundle(async (dir) => {
    await writeBundle(dir, null);
    const error = await assertRejects(() => loadBundle(dir), AppError);
    assertEquals(error.code, "E_BUNDLE");
    assertStringIncludes(error.message, "en_us.snbt");
  });
});

Deno.test("a missing manifest names the directory it looked in", async () => {
  await withBundle(async (dir) => {
    const error = await assertRejects(() => loadBundleManifest(dir), AppError);
    assertEquals(error.code, "E_BUNDLE");
    assertStringIncludes(error.message, dir);
  });
});

Deno.test("uninstall can read the manifest without the payload present", async () => {
  await withBundle(async (dir) => {
    await writeBundle(dir, null);
    const loaded = await loadBundleManifest(dir);
    assertEquals(loaded.manifest.payload.length, 1);
  });
});
