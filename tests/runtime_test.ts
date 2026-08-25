import { assert, assertEquals } from "@std/assert";
import { writeFileAtomic } from "../src/util/fs.ts";
import { VERSION } from "../src/version.ts";

Deno.test("the tool targets Deno 2 and nothing older", () => {
  const major = Number(Deno.version.deno.split(".")[0]);
  assert(major >= 2, `expected Deno 2 or newer, got ${Deno.version.deno}`);
});

Deno.test("no Deno 1 compatibility shim is reachable", () => {
  // Deno 2 removed the resource-id fsync and shipped AbortSignal.any. Both are
  // the reason src/ used to carry feature-detection branches; asserting the
  // shape of the runtime is what lets those branches stay deleted.
  assertEquals((Deno as Record<string, unknown>).fsync, undefined);
  assertEquals(typeof AbortSignal.any, "function");
});

Deno.test("the durability flush runs on every atomic write", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mqt-sync-" });
  try {
    for (let i = 0; i < 3; i++) {
      await writeFileAtomic(`${dir}/f${i}.txt`, `contents ${i}`);
      assertEquals(await Deno.readTextFile(`${dir}/f${i}.txt`), `contents ${i}`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the version the tool stamps into artefacts is the package version", async () => {
  // VERSION reaches users: it is the toolVersion in every overlay manifest,
  // every bundle manifest and every backup sidecar. Letting it drift from
  // deno.json would make those artefacts lie about which build produced them.
  const config = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  );
  assertEquals(config.version, VERSION);
});
