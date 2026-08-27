import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { readZip } from "../src/archive/zip/reader.ts";
import { writeZip } from "../src/archive/zip/writer.ts";
import {
  type JarByteSource,
  loadLangJar,
  scanLangJar,
  selectLangNamespace,
} from "../src/archive/lang_jar.ts";
import { sha256Hex } from "../src/util/hash.ts";
import {
  buildLangJar,
  englishLang,
  langJson,
  MISSING_KEY,
  REFERENCED_KEYS,
} from "./helpers/lang_pack.ts";

async function scanOf(bytes: Uint8Array, locale = "en_us", namespace?: string) {
  return await scanLangJar(await readZip(bytes), locale, namespace);
}

async function candidatesOf(bytes: Uint8Array, locale = "en_us") {
  return (await scanOf(bytes, locale)).candidates;
}

Deno.test("candidates are the top-level assets/<ns>/lang/<locale>.json files only", async () => {
  const candidates = await candidatesOf(await buildLangJar());
  assertEquals(candidates.map((c) => c.namespace).sort(), ["examplepack", "hordes"]);
  const chosen = candidates.find((c) => c.namespace === "examplepack")!;
  assertEquals(chosen.path, "assets/examplepack/lang/en_us.json");
  assertEquals(chosen.entryCount, Object.keys(englishLang()).length);
  // `assets/tacz/bf1_default_gun/assets/bf1/lang/en_us.json` is nested, not a
  // namespace of this jar.
  assertEquals(candidates.some((c) => c.namespace === "bf1"), false);
});

Deno.test("a candidate carries the key set of the file it names", async () => {
  const byNamespace = new Map(
    (await candidatesOf(await buildLangJar())).map((c) => [c.namespace, c]),
  );
  assertEquals(byNamespace.get("examplepack")!.keys.has("quest.intro"), true);
  assertEquals(byNamespace.get("hordes")!.keys.has("quest.intro"), false);
});

Deno.test("selection reports which referenced keys the namespace is missing", async () => {
  const selection = selectLangNamespace(
    await candidatesOf(await buildLangJar()),
    REFERENCED_KEYS,
  );
  assertEquals(selection.missing, [MISSING_KEY]);
  assertEquals(selection.matched.length, REFERENCED_KEYS.length - 1);
});

Deno.test("exactly one matching namespace is selected without ceremony", async () => {
  const candidates = await candidatesOf(await buildLangJar());
  const selection = selectLangNamespace(candidates, REFERENCED_KEYS);
  assertEquals(selection.chosen.namespace, "examplepack");
  assertEquals(selection.alternates, []);
});

Deno.test("a source locale with no lang file at all is a clear error", async () => {
  const candidates = await candidatesOf(await buildLangJar(), "de_de");
  assertEquals(candidates, []);
  const error = assertThrows(
    () => selectLangNamespace(candidates, REFERENCED_KEYS, undefined, "de_de"),
    AppError,
  ) as AppError;
  assertEquals(error.code, "E_NO_QUEST_LOCALIZATION");
  assertStringIncludes(error.message, "de_de");
});

Deno.test("a jar whose namespaces define none of the referenced keys is an error", async () => {
  const candidates = await candidatesOf(
    await buildLangJar({ namespaces: { hordes: { en_us: { "message.hordes.Start": "x" } } } }),
  );
  const error = assertThrows(
    () => selectLangNamespace(candidates, REFERENCED_KEYS),
    AppError,
  ) as AppError;
  assertEquals(error.code, "E_NO_QUEST_LOCALIZATION");
  assertStringIncludes(error.message, "hordes");
  assertStringIncludes(error.hint ?? "", "--lang-namespace");
});

Deno.test("two namespaces with disjoint matches are ambiguous, and say so", async () => {
  const jar = await buildLangJar({
    namespaces: {
      alpha: { en_us: { "quest.intro": "A", "quest.main": "A" } },
      beta: { en_us: { "quest.guide": "B", "quest.intro.subtitle": "B" } },
    },
  });
  const candidates = await candidatesOf(jar);
  const error = assertThrows(
    () => selectLangNamespace(candidates, REFERENCED_KEYS),
    AppError,
  ) as AppError;
  assertEquals(error.code, "E_INVALID_INPUT");
  assertStringIncludes(error.message, "alpha");
  assertStringIncludes(error.message, "beta");
  assertStringIncludes(error.hint ?? "", "--lang-namespace");
});

Deno.test("a namespace that subsumes another is not ambiguous", async () => {
  const jar = await buildLangJar({
    namespaces: {
      // `wide` covers everything `narrow` does, and more.
      wide: { en_us: englishLang() },
      narrow: { en_us: { "quest.intro": "also here" } },
    },
  });
  const selection = selectLangNamespace(await candidatesOf(jar), REFERENCED_KEYS);
  assertEquals(selection.chosen.namespace, "wide");
  assertEquals(selection.alternates.map((c) => c.namespace), ["narrow"]);
});

Deno.test("an explicit namespace wins, and an unknown one lists what is available", async () => {
  const candidates = await candidatesOf(await buildLangJar());
  assertEquals(
    selectLangNamespace(candidates, REFERENCED_KEYS, "hordes").chosen.namespace,
    "hordes",
  );
  const error = assertThrows(
    () => selectLangNamespace(candidates, REFERENCED_KEYS, "nope"),
    AppError,
  ) as AppError;
  assertStringIncludes(error.message, "nope");
  assertStringIncludes(error.message, "examplepack");
});

Deno.test("a lang file that is not a flat JSON object is skipped, not fatal", async () => {
  const jar = await writeZip([
    { path: "assets/broken/lang/en_us.json", text: "[1, 2, 3]" },
    { path: "assets/examplepack/lang/en_us.json", text: langJson() },
  ]);
  const scan = await scanOf(jar);
  assertEquals(scan.candidates.map((c) => c.namespace), ["examplepack"]);
  // ...but it is not forgotten either: it is why a namespace is absent.
  assertEquals(scan.malformed.map((m) => m.path), ["assets/broken/lang/en_us.json"]);
});

Deno.test("an implausible number of candidate namespaces is refused", async () => {
  const entries = [];
  for (let i = 0; i < 300; i++) {
    entries.push({ path: `assets/ns${i}/lang/en_us.json`, text: '{"quest.intro":"x"}' });
  }
  const jar = await readZip(await writeZip(entries));
  await assertRejects(() => scanLangJar(jar, "en_us"), AppError, "namespaces");
});

// ---- regressions ----------------------------------------------------------

Deno.test("a candidate key set is membership, not value type", async () => {
  // Regression: a referenced key whose value is not a string used to be absent
  // from the key set, so it was reported as *missing* and never reached the
  // adapter that exists to refuse it.
  const jar = await buildLangJar({
    rawNamespaces: {
      examplepack: {
        en_us: JSON.stringify({
          "quest.intro": { "text": "an object, not a string" },
          "quest.main": "Main",
        }),
      },
    },
  });
  const candidates = await candidatesOf(jar);
  assertEquals(candidates[0].keys.has("quest.intro"), true);
  assertEquals(candidates[0].entryCount, 2);

  const selection = selectLangNamespace(candidates, ["quest.intro", "quest.main"]);
  assertEquals(selection.matched, ["quest.intro", "quest.main"]);
  assertEquals(selection.missing, []);
});

Deno.test("a forced namespace is one file, whatever else the jar ships", async () => {
  // Regression: more than MAX_LANG_NAMESPACES namespaces used to be refused
  // before the flag that names exactly one of them was even consulted.
  const raw: Record<string, Record<string, string>> = {
    examplepack: { en_us: langJson() },
  };
  for (let i = 0; i < 200; i++) raw[`ns${i}`] = { en_us: '{"quest.intro":"x"}' };

  const jar = await buildLangJar({ rawNamespaces: raw });
  const scan = await scanOf(jar, "en_us", "examplepack");
  assertEquals(scan.candidates.map((c) => c.namespace), ["examplepack"]);
  assertEquals(
    selectLangNamespace(scan.candidates, REFERENCED_KEYS, "examplepack").chosen.path,
    "assets/examplepack/lang/en_us.json",
  );
});

Deno.test("a forced namespace that is not in the jar is refused before anything is read", async () => {
  const raw: Record<string, Record<string, string>> = {};
  for (let i = 0; i < 200; i++) raw[`ns${i}`] = { en_us: '{"quest.intro":"x"}' };
  const jar = await readZip(await buildLangJar({ rawNamespaces: raw }));
  const error = await assertRejects(
    () => scanLangJar(jar, "en_us", "examplepack"),
    AppError,
  ) as AppError;
  assertEquals(error.code, "E_INVALID_INPUT");
  assertStringIncludes(error.message, "examplepack");
});

Deno.test("a forced namespace whose file is unusable says exactly what is wrong", async () => {
  // Regression: a malformed, array-shaped or empty lang file used to be dropped
  // silently, so naming it produced "not in the language jar" instead.
  for (
    const [text, reason] of [
      ["{ not json", "not valid JSON"],
      ["[1, 2, 3]", "not a JSON object"],
      ["{}", "no translation keys"],
    ]
  ) {
    const jar = await readZip(
      await buildLangJar({ rawNamespaces: { examplepack: { en_us: text } } }),
    );
    const error = await assertRejects(
      () => scanLangJar(jar, "en_us", "examplepack"),
      AppError,
    ) as AppError;
    assertEquals(error.code, "E_INVALID_INPUT", text);
    assertStringIncludes(error.message, "assets/examplepack/lang/en_us.json");
    assertStringIncludes(error.message, reason);
  }
});

Deno.test("a jar whose every lang file is unusable names the files, not the absence", async () => {
  const jar = await buildLangJar({
    rawNamespaces: { alpha: { en_us: "{ not json" }, beta: { en_us: "[]" } },
  });
  const scan = await scanOf(jar);
  assertEquals(scan.candidates, []);
  assertEquals(scan.malformed.map((m) => m.namespace).sort(), ["alpha", "beta"]);

  const error = assertThrows(
    () => selectLangNamespace(scan.candidates, REFERENCED_KEYS, undefined, "en_us", scan.malformed),
    AppError,
  ) as AppError;
  assertEquals(error.code, "E_INVALID_INPUT");
  assertStringIncludes(error.message, "assets/alpha/lang/en_us.json");
  assertStringIncludes(error.message, "assets/beta/lang/en_us.json");
});

Deno.test({
  name: "the jar size is re-checked against what was actually read",
  // Regression: the cap was enforced against `stat`, so a file whose size
  // changed -- or was never truthful -- was inflated anyway. `/proc` gives a
  // regular file that reports zero bytes and reads far more.
  ignore: Deno.build.os !== "linux" || !readsMoreThanItClaims("/proc/self/maps"),
  fn: async () => {
    const error = await assertRejects(
      () => loadLangJar("/proc/self/maps", 1024),
      AppError,
    ) as AppError;
    assertEquals(error.code, "E_INVALID_INPUT");
    assertStringIncludes(error.message, "1024 byte limit");
  },
});

function readsMoreThanItClaims(path: string): boolean {
  try {
    return Deno.statSync(path).size === 0 && Deno.readFileSync(path).byteLength > 1024;
  } catch {
    return false;
  }
}

// ---- the cap is enforced while reading, not after ---------------------------

/** A source of exactly these bytes, handed over a few at a time. */
class ChunkedSource implements JarByteSource {
  produced = 0;
  closed = false;
  readonly #bytes: Uint8Array;
  readonly #chunk: number;
  #offset = 0;

  constructor(bytes: Uint8Array, chunk = 7) {
    this.#bytes = bytes;
    this.#chunk = chunk;
  }

  read(into: Uint8Array): Promise<number | null> {
    if (this.#offset >= this.#bytes.byteLength) return Promise.resolve(null);
    const size = Math.min(this.#chunk, into.byteLength, this.#bytes.byteLength - this.#offset);
    into.set(this.#bytes.subarray(this.#offset, this.#offset + size));
    this.#offset += size;
    this.produced += size;
    return Promise.resolve(size);
  }

  close(): void {
    this.closed = true;
  }
}

/**
 * A source that never runs out: a file being appended to as fast as it is read,
 * or one whose length was never a fact in the first place.
 */
class EndlessSource implements JarByteSource {
  produced = 0;
  closed = false;

  read(into: Uint8Array): Promise<number | null> {
    const size = Math.min(into.byteLength, 4096);
    into.fill(0x50, 0, size);
    this.produced += size;
    return Promise.resolve(size);
  }

  close(): void {
    this.closed = true;
  }
}

/** A source that fails part way through, like a disconnected volume. */
class FailingSource implements JarByteSource {
  closed = false;
  #reads = 0;

  read(into: Uint8Array): Promise<number | null> {
    if (this.#reads++ === 0) {
      into.fill(0x50, 0, 16);
      return Promise.resolve(16);
    }
    return Promise.reject(new Deno.errors.NotConnected("the volume went away"));
  }

  close(): void {
    this.closed = true;
  }
}

Deno.test("the cap stops the read rather than measuring the allocation afterwards", async () => {
  // Regression: the jar was `stat`ed and then read whole, so a file that
  // reported one size and delivered another was allocated in full before the
  // limit was applied to it. One byte past the cap is the entire proof.
  const source = new EndlessSource();
  const error = await assertRejects(
    () => loadLangJar("endless.jar", 4096, { open: () => Promise.resolve(source) }),
    AppError,
  ) as AppError;
  assertEquals(error.code, "E_INVALID_INPUT");
  assertStringIncludes(error.message, "4096 byte limit");
  assertEquals(source.produced <= 4097, true, `${source.produced} bytes were read`);
  assertEquals(source.closed, true);
});

Deno.test("a jar of exactly the limit is read; one byte more is refused", async () => {
  const bytes = await buildLangJar();

  const exact = new ChunkedSource(bytes);
  const jar = await loadLangJar("exact.jar", bytes.byteLength, {
    open: () => Promise.resolve(exact),
  });
  assertEquals(jar.sha256, await sha256Hex(bytes));
  assertEquals(jar.fileName, "exact.jar");
  assertEquals(exact.closed, true);
  assertEquals((await scanLangJar(jar.archive, "en_us")).candidates.length > 0, true);

  const over = new ChunkedSource(bytes);
  const error = await assertRejects(
    () => loadLangJar("over.jar", bytes.byteLength - 1, { open: () => Promise.resolve(over) }),
    AppError,
  ) as AppError;
  assertEquals(error.code, "E_INVALID_INPUT");
  // Never the whole file: the read stops at the first byte that proves it.
  assertEquals(over.produced <= bytes.byteLength, true, `${over.produced} bytes were read`);
  assertEquals(over.closed, true);
});

Deno.test("a read that fails part way through is a usage error, and closes the handle", async () => {
  const source = new FailingSource();
  const error = await assertRejects(
    () => loadLangJar("broken.jar", 1024 * 1024, { open: () => Promise.resolve(source) }),
    AppError,
  ) as AppError;
  assertEquals(error.code, "E_INVALID_INPUT");
  assertStringIncludes(error.message, "broken.jar");
  assertEquals(source.closed, true);
});

Deno.test("a local jar is read through a handle and never left open", async () => {
  // Deno's resource sanitizer fails this test if the file handle outlives it,
  // on the refusal path as much as on the successful one.
  const dir = await Deno.makeTempDir({ prefix: "mqt-jar-" });
  try {
    const bytes = await buildLangJar();
    const path = `${dir}/ExampleTweaks_1.0.jar`;
    await Deno.writeFile(path, bytes);

    const jar = await loadLangJar(path, 1024 * 1024);
    assertEquals(jar.fileName, "ExampleTweaks_1.0.jar");
    assertEquals(jar.sha256, await sha256Hex(bytes));
    assertEquals((await scanLangJar(jar.archive, "en_us")).candidates.length > 0, true);

    const error = await assertRejects(
      () => loadLangJar(path, bytes.byteLength - 1),
      AppError,
    ) as AppError;
    assertEquals(error.code, "E_INVALID_INPUT");
    assertStringIncludes(error.message, `${bytes.byteLength - 1} byte limit`);

    // A directory opens perfectly well on Linux and reads nothing useful.
    const directory = await assertRejects(
      () => loadLangJar(dir, 1024 * 1024),
      AppError,
    ) as AppError;
    assertEquals(directory.code, "E_INVALID_INPUT");
    assertStringIncludes(directory.message, "is not a file");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
