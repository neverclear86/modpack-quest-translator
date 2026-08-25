import {
  assertEquals,
  assertMatch,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { AppError } from "../src/errors.ts";
import { BackupStore, INSTALLER_DIR } from "../src/installer/backup.ts";
import { sha256Hex } from "../src/util/hash.ts";

const AT = "2026-08-25T14:22:33.000Z";
const ORIGINAL = '{ quest.title: "Skyward" }\n';

async function withStore(fn: (store: BackupStore, root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "mqt-backup-" });
  try {
    await fn(new BackupStore(root, { toolVersion: "1.1.0", bundleId: "aca-2.4-ja" }), root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

Deno.test("a captured backup is named for its target, its time and its digest", async () => {
  await withStore(async (store) => {
    const record = await store.capture({
      relativePath: "config/ftbquests/quests/lang/en_us.snbt",
      bytes: bytes(ORIGINAL),
      kind: "original",
      capturedAt: AT,
    });
    assertMatch(record.name, /^en_us\.snbt\.20260825T142233Z-0\.[0-9a-f]{12}\.bak$/);
    assertEquals(record.relativePath, `backups/${record.name}`);
    assertEquals(await Deno.readTextFile(record.backupPath), ORIGINAL);
    assertStringIncludes(record.backupPath, `${INSTALLER_DIR}/backups/`);
  });
});

Deno.test("the sidecar records everything needed to restore without state.json", async () => {
  await withStore(async (store) => {
    const record = await store.capture({
      relativePath: "config/ftbquests/quests/lang/en_us.snbt",
      bytes: bytes(ORIGINAL),
      kind: "original",
      capturedAt: AT,
    });
    const sidecar = JSON.parse(await Deno.readTextFile(record.sidecarPath));
    assertEquals(sidecar, {
      formatVersion: 1,
      kind: "original",
      targetRelativePath: "config/ftbquests/quests/lang/en_us.snbt",
      capturedAt: AT,
      sha256: await sha256Hex(bytes(ORIGINAL)),
      sizeBytes: bytes(ORIGINAL).byteLength,
      toolVersion: "1.1.0",
      capturedByBundleId: "aca-2.4-ja",
    });
  });
});

Deno.test("capturing the same bytes twice reuses the first backup", async () => {
  await withStore(async (store) => {
    const first = await store.capture({
      relativePath: "config/ftbquests/quests/lang/en_us.snbt",
      bytes: bytes(ORIGINAL),
      kind: "original",
      capturedAt: AT,
    });
    const second = await store.capture({
      relativePath: "config/ftbquests/quests/lang/en_us.snbt",
      bytes: bytes(ORIGINAL),
      kind: "original",
      capturedAt: "2026-09-01T00:00:00.000Z",
    });
    assertEquals(second.backupPath, first.backupPath);
    assertEquals(second.reused, true);
    const scan = await store.scan();
    assertEquals(scan.records.length, 1);
  });
});

Deno.test("different content for the same target is captured separately", async () => {
  await withStore(async (store) => {
    const first = await store.capture({
      relativePath: "config/ftbquests/quests/lang/en_us.snbt",
      bytes: bytes(ORIGINAL),
      kind: "original",
      capturedAt: AT,
    });
    const second = await store.capture({
      relativePath: "config/ftbquests/quests/lang/en_us.snbt",
      bytes: bytes("edited by the user\n"),
      kind: "modified-install",
      capturedAt: AT,
    });
    assertNotEquals(second.backupPath, first.backupPath);
    assertEquals((await store.scan()).records.length, 2);
  });
});

Deno.test("a name already taken under a frozen clock bumps the counter", async () => {
  await withStore(async (store, root) => {
    const digest = (await sha256Hex(bytes(ORIGINAL))).slice(0, 12);
    const taken = `${root}/${INSTALLER_DIR}/backups/en_us.snbt.20260825T142233Z-0.${digest}.bak`;
    await Deno.mkdir(`${root}/${INSTALLER_DIR}/backups`, { recursive: true });
    await Deno.writeTextFile(taken, "someone else got here first");
    const record = await store.capture({
      relativePath: "config/ftbquests/quests/lang/en_us.snbt",
      bytes: bytes(ORIGINAL),
      kind: "original",
      capturedAt: AT,
    });
    assertMatch(record.name, /-1\./);
    // The file already there is never overwritten.
    assertEquals(await Deno.readTextFile(taken), "someone else got here first");
  });
});

Deno.test("an absent sentinel records that there was no file to save", async () => {
  await withStore(async (store) => {
    const record = await store.capture({
      relativePath: "config/ftbquests/quests/lang/en_us.snbt",
      bytes: null,
      kind: "absent",
      capturedAt: AT,
    });
    assertEquals(record.sidecar.kind, "absent");
    assertEquals(record.sidecar.sizeBytes, 0);
    const verified = await store.verify(record);
    assertEquals(verified.ok, true);
  });
});

Deno.test("verification catches a deleted, truncated or edited backup", async () => {
  await withStore(async (store) => {
    const record = await store.capture({
      relativePath: "config/ftbquests/quests/lang/en_us.snbt",
      bytes: bytes(ORIGINAL),
      kind: "original",
      capturedAt: AT,
    });
    assertEquals((await store.verify(record)).ok, true);

    await Deno.writeTextFile(record.backupPath, ORIGINAL.slice(0, 5));
    const truncated = await store.verify(record);
    assertEquals(truncated.ok, false);
    assertStringIncludes(truncated.reason ?? "", "bytes");

    await Deno.writeTextFile(record.backupPath, ORIGINAL.replace("Skyward", "Skywerd"));
    const edited = await store.verify(record);
    assertEquals(edited.ok, false);
    assertStringIncludes(edited.reason ?? "", "digest");

    await Deno.remove(record.backupPath);
    const missing = await store.verify(record);
    assertEquals(missing.ok, false);
    assertStringIncludes(missing.reason ?? "", "missing");
  });
});

Deno.test("scanning rebuilds the inventory from sidecars and reports unreadable ones", async () => {
  await withStore(async (store, root) => {
    await store.capture({
      relativePath: "config/ftbquests/quests/lang/en_us.snbt",
      bytes: bytes(ORIGINAL),
      kind: "original",
      capturedAt: AT,
    });
    const backups = `${root}/${INSTALLER_DIR}/backups`;
    await Deno.writeTextFile(`${backups}/junk.bak.json`, "{not json");
    await Deno.writeTextFile(`${backups}/stray.txt`, "ignored");

    const scan = await store.scan();
    assertEquals(scan.records.length, 1);
    assertEquals(
      scan.records[0].sidecar.targetRelativePath,
      "config/ftbquests/quests/lang/en_us.snbt",
    );
    assertEquals(scan.skipped.length, 1);
    assertStringIncludes(scan.skipped[0].path, "junk.bak.json");
  });
});

Deno.test("scanning an instance we have never touched is empty, not an error", async () => {
  await withStore(async (store) => {
    const scan = await store.scan();
    assertEquals(scan.records, []);
    assertEquals(scan.skipped, []);
  });
});

Deno.test("a sidecar from a newer installer is refused rather than misread", async () => {
  await withStore(async (store, root) => {
    const backups = `${root}/${INSTALLER_DIR}/backups`;
    await Deno.mkdir(backups, { recursive: true });
    await Deno.writeTextFile(`${backups}/x.bak`, ORIGINAL);
    await Deno.writeTextFile(
      `${backups}/x.bak.json`,
      JSON.stringify({ formatVersion: 99, kind: "original" }),
    );
    const error = await assertRejects(() => store.scan(), AppError);
    assertEquals(error.code, "E_BACKUP");
    assertStringIncludes(error.message, "newer version");
  });
});

Deno.test("a backup is never written outside the installer directory", async () => {
  await withStore(async (store) => {
    await assertRejects(
      () =>
        store.capture({
          relativePath: "../../../../etc/passwd",
          bytes: bytes(ORIGINAL),
          kind: "original",
          capturedAt: AT,
        }),
      AppError,
    );
  });
});
