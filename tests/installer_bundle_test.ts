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

Deno.test("a manifest whose descriptive fields are nonsense is refused", () => {
  // The write allowlist holds whatever the manifest says, but a bundle that
  // cannot describe itself coherently is one this installer should not be
  // acting on -- and "unknown" is a worse answer to give the player than a
  // refusal.
  parseFails({ tool: "someone-elses-packager" }, "tool");
  parseFails({ toolVersion: "unreleased" }, "toolVersion");
  parseFails({ generatedAt: "yesterday" }, "generatedAt");
  parseFails({ generatedAt: "2026-13-45T99:00:00.000Z" }, "generatedAt");
  parseFails({ sourceLocale: "../../etc" }, "sourceLocale");
  parseFails({ targetLocale: "japanese" }, "targetLocale");
  // A "translation" into the language it was read from is a copy.
  parseFails({ targetLocale: "en_us" }, "targetLocale");
});

Deno.test("a bundleId that is not a plain name is refused", () => {
  // It is never used as a path here, but it is written into state.json, into
  // every backup sidecar, and printed back to the player. A control character
  // or a screenful of text belongs in none of those.
  parseFails({ bundleId: "" }, "bundleId");
  parseFails({ bundleId: "aca\nInstalled: nothing was changed" }, "bundleId");
  parseFails({ bundleId: "../../elsewhere" }, "bundleId");
  parseFails({ bundleId: "x".repeat(200) }, "bundleId");
  // Dot-only names are made of allowed characters but name a directory rather
  // than a bundle, and read as a path to anyone shown one.
  parseFails({ bundleId: "." }, "bundleId");
  parseFails({ bundleId: ".." }, "bundleId");
  parseFails({ bundleId: "..." }, "bundleId");
});

Deno.test("a manifest whose payload does not match its own locales is refused", () => {
  // overrideEnglish means the translated text ships under the source locale's
  // name. A bundle that says so and then carries something else is malformed.
  parseFails(
    { payload: [payloadOf("config/ftbquests/quests/lang/ja_jp.snbt")] },
    "en_us.snbt",
  );
  parseFails(
    {
      overrideEnglish: false,
      payload: [payloadOf("config/ftbquests/quests/lang/en_us.snbt")],
    },
    "ja_jp.snbt",
  );
});

Deno.test("a binary entry that could name a path outside bin/ is refused", () => {
  for (
    const binary of [
      { path: "../../evil.exe", target: "x86_64-pc-windows-msvc", sha256: "a".repeat(64) },
      { path: "/usr/bin/sh", target: "x86_64-unknown-linux-gnu", sha256: "a".repeat(64) },
      { path: "bin/nested/exe", target: "x86_64-unknown-linux-gnu", sha256: "a".repeat(64) },
      { path: "bin/mqt", target: "x86_64-unknown-linux-gnu", sha256: "not a digest" },
      { path: "bin/mqt", target: "../elsewhere", sha256: "a".repeat(64) },
    ]
  ) {
    const error = assertThrows(
      () => parseBundleManifest(JSON.stringify(manifest({ binaries: [binary] }))),
      AppError,
      undefined,
      `expected ${JSON.stringify(binary)} to be refused`,
    );
    assertEquals(error.code, "E_BUNDLE");
  }
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
