import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { INSTALLER_DIR } from "../src/installer/backup.ts";
import {
  emptyState,
  HISTORY_LIMIT,
  type InstallerState,
  loadState,
  saveState,
  STATE_FILE,
} from "../src/installer/state.ts";

const TARGET = "config/ftbquests/quests/lang/en_us.snbt";

async function withInstaller(fn: (dir: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "mqt-state-" });
  try {
    await fn(`${root}/${INSTALLER_DIR}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function populated(): InstallerState {
  const state = emptyState();
  state.installs[TARGET] = {
    bundleId: "aca-2.4-ja",
    installedSha256: "b".repeat(64),
    installedAt: "2026-08-25T14:22:33.000Z",
    originalBackup: "backups/en_us.snbt.20260825T142233Z-0.9f2a1c4b7e01.bak",
    originalSha256: "c".repeat(64),
    originalWasAbsent: false,
    toolVersion: "1.1.0",
  };
  state.history.push({
    event: "install",
    target: TARGET,
    at: "2026-08-25T14:22:33.000Z",
    bundleId: "aca-2.4-ja",
    installedSha256: "b".repeat(64),
  });
  return state;
}

Deno.test("state round-trips through disk", async () => {
  await withInstaller(async (dir) => {
    await saveState(dir, populated());
    const loaded = await loadState(dir);
    assertEquals(loaded.state, populated());
    assertEquals(loaded.warning, undefined);
  });
});

Deno.test("a never-installed instance loads as empty rather than failing", async () => {
  await withInstaller(async (dir) => {
    const loaded = await loadState(dir);
    assertEquals(loaded.state, emptyState());
    assertEquals(loaded.warning, undefined);
  });
});

Deno.test("a truncated state file is recoverable, not fatal", async () => {
  await withInstaller(async (dir) => {
    await saveState(dir, populated());
    await Deno.writeTextFile(`${dir}/${STATE_FILE}`, '{"formatVersion": 1, "inst');
    const loaded = await loadState(dir);
    assertEquals(loaded.state.installs, {});
    assertStringIncludes(loaded.warning ?? "", STATE_FILE);
  });
});

Deno.test("state written by a newer installer is refused rather than overwritten", async () => {
  await withInstaller(async (dir) => {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/${STATE_FILE}`,
      JSON.stringify({ formatVersion: 99, installs: {}, history: [] }),
    );
    const error = await assertRejects(() => loadState(dir), AppError);
    assertEquals(error.code, "E_INSTANCE");
    assertStringIncludes(error.message, "newer version");
  });
});

Deno.test("an install record missing its digest is dropped, not half-trusted", async () => {
  await withInstaller(async (dir) => {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/${STATE_FILE}`,
      JSON.stringify({
        formatVersion: 1,
        installs: { [TARGET]: { bundleId: "x", installedAt: "2026-01-01T00:00:00.000Z" } },
        history: "not an array",
      }),
    );
    const loaded = await loadState(dir);
    assertEquals(loaded.state.installs, {});
    assertEquals(loaded.state.history, []);
  });
});

Deno.test("history is capped so an instance reinstalled forever stays readable", async () => {
  await withInstaller(async (dir) => {
    const state = emptyState();
    for (let i = 0; i < HISTORY_LIMIT + 25; i++) {
      state.history.push({
        event: "install",
        target: TARGET,
        at: "2026-08-25T14:22:33.000Z",
        bundleId: "aca-2.4-ja",
        installedSha256: `${i}`.padStart(64, "0"),
      });
    }
    await saveState(dir, state);
    const loaded = await loadState(dir);
    assertEquals(loaded.state.history.length, HISTORY_LIMIT);
    // The newest events are the ones kept.
    assertEquals(
      loaded.state.history[HISTORY_LIMIT - 1],
      state.history[state.history.length - 1],
    );
  });
});

Deno.test("saving leaves no temporary files behind", async () => {
  await withInstaller(async (dir) => {
    await saveState(dir, populated());
    await saveState(dir, populated());
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) names.push(entry.name);
    assertEquals(names, [STATE_FILE]);
  });
});
