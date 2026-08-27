/**
 * Real-data discovery check against the DeceasedCraft archive and the mod jar
 * that provides its quest strings. Both live outside the repository and are
 * never modified; the test skips itself when they are not present, so CI and a
 * fresh clone stay green while a local run still exercises the real shapes.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { readZip } from "../src/archive/zip/reader.ts";
import { discoverLangJsonSource } from "../src/archive/discover.ts";

const PACK = "/tmp/deceasedcraft-5.10.17.zip";
const JAR = "/tmp/DCTweaks_5.10.14.jar";

function present(path: string): boolean {
  try {
    return Deno.statSync(path).isFile;
  } catch {
    return false;
  }
}

const available = present(PACK) && present(JAR);

Deno.test({
  name: "real data: DeceasedCraft resolves to the deceasedcraft namespace",
  ignore: !available,
  fn: async () => {
    const pack = await readZip(await Deno.readFile(PACK), { maxTotalBytes: 4 * 1024 ** 3 });
    const jar = await readZip(await Deno.readFile(JAR), { maxTotalBytes: 4 * 1024 ** 3 });
    const source = await discoverLangJsonSource(pack, jar, { sourceLocale: "en_us" });

    assertEquals(source.langNamespace, "deceasedcraft");
    assertEquals(source.path, "assets/deceasedcraft/lang/en_us.json");
    assertEquals(source.flavour, "curseforge");
    assertEquals(source.packInfo.minecraftVersion, "1.20.1");
    assertEquals(source.adapter.id, "minecraft-lang-json");

    const scan = source.references!;
    // The pack is large; assert the shape rather than a number that a pack
    // update would invalidate for no reason.
    assertEquals(scan.unparsed, []);
    assertEquals(scan.files.length > 25, true);
    assertEquals(scan.keys.length > 1000, true);
    assertEquals(source.presentKeys!.length > 1000, true);
    assertEquals(source.missingKeys!.length > 0, true);
    assertEquals(
      source.presentKeys!.length + source.missingKeys!.length,
      scan.keys.length,
    );
    assertEquals(scan.literals.length > 0, true);

    // Extraction is filtered: the mod ships far more strings than the quests use.
    const document = source.adapter.extract(source.text, { keys: source.presentKeys });
    assertEquals(document.units.length, source.presentKeys!.length);
    assertStringIncludes(
      document.units.find((u) => u.key === "quest.guide.survival.fiber.title")!.text,
      "Fiber",
    );
  },
});

Deno.test({
  name: "real data: the hordes namespace in the same jar is not a candidate",
  ignore: !available,
  fn: async () => {
    const { scanLangJar } = await import("../src/archive/lang_jar.ts");
    const jar = await readZip(await Deno.readFile(JAR), { maxTotalBytes: 4 * 1024 ** 3 });
    const { candidates, malformed } = await scanLangJar(jar, "en_us");
    assertEquals(candidates.map((c) => c.namespace).sort(), ["deceasedcraft", "hordes"]);
    assertEquals(candidates.find((c) => c.namespace === "hordes")!.keys.has("quest.intro"), false);
    assertEquals(malformed, []);
  },
});
