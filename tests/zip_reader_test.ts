import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { readZip, ZIP_LIMITS } from "../src/archive/zip/reader.ts";
import { buildRawZip, type RawEntry } from "./helpers/zip_builder.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function zipOf(entries: RawEntry[]): Promise<Uint8Array> {
  return await buildRawZip(entries);
}

Deno.test("reads stored and deflated entries", async () => {
  const bytes = await zipOf([
    { name: "a.txt", data: enc.encode("hello"), method: "store" },
    { name: "b/c.txt", data: enc.encode("x".repeat(5000)), method: "deflate" },
  ]);
  const zip = await readZip(bytes);
  assertEquals(zip.entries.map((e) => e.path), ["a.txt", "b/c.txt"]);
  assertEquals(dec.decode(await zip.read("a.txt")), "hello");
  assertEquals(dec.decode(await zip.read("b/c.txt")), "x".repeat(5000));
});

Deno.test("directory entries are listed but not readable as files", async () => {
  const bytes = await zipOf([
    { name: "dir/", data: new Uint8Array(0), method: "store" },
    { name: "dir/f.txt", data: enc.encode("v"), method: "store" },
  ]);
  const zip = await readZip(bytes);
  assertEquals(zip.entries.find((e) => e.path === "dir/")?.isDirectory, true);
  assertEquals(zip.files().map((e) => e.path), ["dir/f.txt"]);
});

Deno.test("has() and read() work with exact paths and reject missing ones", async () => {
  const zip = await readZip(await zipOf([{ name: "x/y.snbt", data: enc.encode("{}") }]));
  assertEquals(zip.has("x/y.snbt"), true);
  assertEquals(zip.has("x/nope.snbt"), false);
  await assertRejects(() => zip.read("x/nope.snbt"), AppError);
});

Deno.test("readText decodes UTF-8 including a BOM", async () => {
  const withBom = new Uint8Array([0xEF, 0xBB, 0xBF, ...enc.encode("héllo")]);
  const zip = await readZip(await zipOf([{ name: "t.txt", data: withBom }]));
  assertEquals(await zip.readText("t.txt"), "héllo");
});

Deno.test("Zip Slip paths are rejected", async () => {
  for (const name of ["../evil.txt", "a/../../evil.txt", "a/b/../../../evil.txt"]) {
    const bytes = await zipOf([{ name, data: enc.encode("x") }]);
    const err = await assertRejects(() => readZip(bytes), AppError) as AppError;
    assertEquals(err.code, "E_UNSUPPORTED_PACK");
    assertStringIncludes(err.message.toLowerCase(), "unsafe");
  }
});

Deno.test("backslash traversal is rejected", async () => {
  for (const name of ["..\\evil.txt", "a\\..\\..\\evil"]) {
    const bytes = await zipOf([{ name, data: enc.encode("x") }]);
    await assertRejects(() => readZip(bytes), AppError);
  }
});

Deno.test("absolute, drive and UNC paths are rejected", async () => {
  for (const name of ["/etc/passwd", "C:/Windows/x", "C:\\Windows\\x", "//server/share/x"]) {
    const bytes = await zipOf([{ name, data: enc.encode("x") }]);
    await assertRejects(() => readZip(bytes), AppError);
  }
});

Deno.test("symlink entries are rejected", async () => {
  const bytes = await zipOf([
    { name: "link", data: enc.encode("/etc/passwd"), externalAttributes: (0o120777 << 16) >>> 0 },
  ]);
  const err = await assertRejects(() => readZip(bytes), AppError) as AppError;
  assertStringIncludes(err.message.toLowerCase(), "symlink");
});

Deno.test("encrypted entries are rejected", async () => {
  const bytes = await zipOf([{ name: "s.txt", data: enc.encode("x"), generalPurposeFlag: 0x0001 }]);
  const err = await assertRejects(() => readZip(bytes), AppError) as AppError;
  assertStringIncludes(err.message.toLowerCase(), "encrypted");
});

Deno.test("unsupported compression methods are rejected", async () => {
  const bytes = await zipOf([{ name: "s.txt", data: enc.encode("x"), methodOverride: 12 }]);
  const err = await assertRejects(() => readZip(bytes), AppError) as AppError;
  assertStringIncludes(err.message.toLowerCase(), "compression method");
});

Deno.test("names containing NUL or control bytes are rejected", async () => {
  for (const name of ["a\u0000b.txt", "a\u0001b.txt"]) {
    const bytes = await zipOf([{ name, data: enc.encode("x") }]);
    await assertRejects(() => readZip(bytes), AppError);
  }
});

Deno.test("an entry declaring more than the per-entry cap is refused", async () => {
  const bytes = await zipOf([{
    name: "bomb.bin",
    data: enc.encode("x"),
    declaredUncompressedSize: ZIP_LIMITS.maxEntryBytes + 1,
  }]);
  const err = await assertRejects(() => readZip(bytes), AppError) as AppError;
  assertStringIncludes(err.message.toLowerCase(), "too large");
});

Deno.test("a total uncompressed size over the cap is refused", async () => {
  // Ratio 1:1 for both entries, so only the *total* cap can be what trips.
  const filler = enc.encode("z".repeat(900));
  const bytes = await zipOf([
    { name: "a.bin", data: filler },
    { name: "b.bin", data: filler },
  ]);
  const err = await assertRejects(
    () => readZip(bytes, { maxTotalBytes: 1000 }),
    AppError,
  ) as AppError;
  assertStringIncludes(err.message.toLowerCase(), "total");
});

Deno.test("an implausible compression ratio is refused", async () => {
  const bytes = await zipOf([{
    name: "ratio.bin",
    data: enc.encode("x".repeat(10)),
    declaredUncompressedSize: 10_000_000,
  }]);
  const err = await assertRejects(() => readZip(bytes), AppError) as AppError;
  assertStringIncludes(err.message.toLowerCase(), "ratio");
});

Deno.test("too many entries is refused", async () => {
  const entries: RawEntry[] = [];
  for (let i = 0; i < 40; i++) entries.push({ name: `f${i}.txt`, data: enc.encode("x") });
  const bytes = await zipOf(entries);
  const err = await assertRejects(
    () => readZip(bytes, { maxEntries: 10 }),
    AppError,
  ) as AppError;
  assertStringIncludes(err.message.toLowerCase(), "entries");
});

Deno.test("actual inflated output exceeding the declared size is refused", async () => {
  // A liar: central directory understates the real uncompressed size.
  const bytes = await zipOf([{
    name: "liar.bin",
    data: enc.encode("y".repeat(4096)),
    method: "deflate",
    declaredUncompressedSize: 4,
  }]);
  const zip = await readZip(bytes);
  await assertRejects(() => zip.read("liar.bin"), AppError);
});

Deno.test("a truncated archive without an end-of-central-directory record is rejected", async () => {
  const bytes = await zipOf([{ name: "a.txt", data: enc.encode("hello") }]);
  const err = await assertRejects(
    () => readZip(bytes.slice(0, bytes.length - 10)),
    AppError,
  ) as AppError;
  assertStringIncludes(err.message.toLowerCase(), "central directory");
});

Deno.test("an empty buffer is rejected rather than treated as an empty archive", async () => {
  await assertRejects(() => readZip(new Uint8Array(0)), AppError);
});

Deno.test("entry paths are normalised for lookup without losing the original", async () => {
  const zip = await readZip(await zipOf([{ name: "a\\b\\c.txt", data: enc.encode("v") }]));
  assertEquals(zip.entries[0].path, "a/b/c.txt");
  assertEquals(zip.entries[0].rawName, "a\\b\\c.txt");
  assertEquals(await zip.readText("a/b/c.txt"), "v");
});
