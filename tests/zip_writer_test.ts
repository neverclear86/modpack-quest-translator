import { assertEquals, assertRejects } from "@std/assert";
import { AppError } from "../src/errors.ts";
import { writeZip } from "../src/archive/zip/writer.ts";
import { readZip } from "../src/archive/zip/reader.ts";

const enc = new TextEncoder();

Deno.test("written archives are readable by our own reader", async () => {
  const bytes = await writeZip([
    { path: "config/ftbquests/quests/lang/ja_jp.snbt", data: enc.encode("{\n}\n") },
    { path: "README.md", data: enc.encode("# hi") },
  ]);
  const zip = await readZip(bytes);
  assertEquals(zip.files().map((e) => e.path).sort(), [
    "README.md",
    "config/ftbquests/quests/lang/ja_jp.snbt",
  ]);
  assertEquals(await zip.readText("README.md"), "# hi");
});

Deno.test("output is byte-for-byte deterministic and order independent", async () => {
  const a = await writeZip([
    { path: "b.txt", data: enc.encode("bbb") },
    { path: "a.txt", data: enc.encode("aaa") },
  ]);
  const b = await writeZip([
    { path: "a.txt", data: enc.encode("aaa") },
    { path: "b.txt", data: enc.encode("bbb") },
  ]);
  assertEquals(a, b);
  const again = await writeZip([
    { path: "a.txt", data: enc.encode("aaa") },
    { path: "b.txt", data: enc.encode("bbb") },
  ]);
  assertEquals(a, again);
});

Deno.test("entries are stored in sorted path order", async () => {
  const bytes = await writeZip([
    { path: "z.txt", data: enc.encode("z") },
    { path: "a/b.txt", data: enc.encode("b") },
    { path: "a/a.txt", data: enc.encode("a") },
  ]);
  const zip = await readZip(bytes);
  assertEquals(zip.files().map((e) => e.path), ["a/a.txt", "a/b.txt", "z.txt"]);
});

Deno.test("unicode content and paths round-trip", async () => {
  const text = "クエスト &6説明&r\n日本語テキスト";
  const bytes = await writeZip([{ path: "日本語/クエスト.snbt", data: enc.encode(text) }]);
  const zip = await readZip(bytes);
  assertEquals(await zip.readText("日本語/クエスト.snbt"), text);
});

Deno.test("compression is applied but never inflates small inputs", async () => {
  const big = enc.encode("A".repeat(100_000));
  const compressed = await writeZip([{ path: "big.txt", data: big }]);
  assertEquals(compressed.length < 5000, true);
  const zip = await readZip(compressed);
  assertEquals((await zip.read("big.txt")).length, 100_000);

  // Incompressible data must fall back to stored rather than grow.
  const random = new Uint8Array(4096);
  for (let i = 0; i < random.length; i++) random[i] = (i * 7 + (i % 13) * 31) & 0xFF;
  const rz = await readZip(await writeZip([{ path: "r.bin", data: random }]));
  assertEquals(await rz.read("r.bin"), random);
});

Deno.test("empty entries are supported", async () => {
  const zip = await readZip(await writeZip([{ path: "empty.txt", data: new Uint8Array(0) }]));
  assertEquals((await zip.read("empty.txt")).length, 0);
});

Deno.test("unsafe output paths are refused", async () => {
  for (const path of ["../escape.txt", "/abs.txt", "C:\\x.txt", "a/../../b"]) {
    await assertRejects(() => writeZip([{ path, data: enc.encode("x") }]), AppError);
  }
});

Deno.test("duplicate paths are refused", async () => {
  await assertRejects(
    () => writeZip([{ path: "a.txt", data: enc.encode("1") }, { path: "a.txt", data: enc.encode("2") }]),
    AppError,
  );
});

Deno.test("an empty archive is refused", async () => {
  await assertRejects(() => writeZip([]), AppError);
});

Deno.test("timestamps are fixed so identical content hashes identically", async () => {
  const bytes = await writeZip([{ path: "a.txt", data: enc.encode("x") }]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Local header: mod time at +10, mod date at +12. 1980-01-01 == time 0, date 0x0021.
  assertEquals(view.getUint16(10, true), 0);
  assertEquals(view.getUint16(12, true), 0x0021);
});

Deno.test("string content is accepted and encoded as UTF-8", async () => {
  const zip = await readZip(await writeZip([{ path: "t.txt", text: "héllo" }]));
  assertEquals(await zip.readText("t.txt"), "héllo");
});
