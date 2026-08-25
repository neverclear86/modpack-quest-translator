import { assertEquals } from "@std/assert";
import { asBufferSource } from "../src/util/bytes.ts";
import { sha256Hex } from "../src/util/hash.ts";
import { writeFileAtomic } from "../src/util/fs.ts";

const SAMPLE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

Deno.test("a whole array survives the Blob and BufferSource conversions", async () => {
  const viaBlob = new Uint8Array(await new Blob([asBufferSource(SAMPLE)]).arrayBuffer());
  assertEquals(viaBlob, SAMPLE);
  const digest = await crypto.subtle.digest("SHA-256", asBufferSource(SAMPLE));
  assertEquals(digest.byteLength, 32);
});

Deno.test("a view into a larger buffer keeps its own window", async () => {
  // The obvious way to satisfy the Deno 2 types is to reach for `bytes.buffer`,
  // which for a subarray is the *whole* backing store. Every archive entry this
  // tool inflates is such a view, so that mistake would silently corrupt data
  // rather than fail to compile.
  const view = SAMPLE.subarray(3, 7);
  assertEquals(view.byteOffset, 3);
  assertEquals(view.byteLength, 4);

  const viaBlob = new Uint8Array(await new Blob([asBufferSource(view)]).arrayBuffer());
  assertEquals(viaBlob, new Uint8Array([4, 5, 6, 7]));
  assertEquals(await sha256Hex(view), await sha256Hex(new Uint8Array([4, 5, 6, 7])));
});

Deno.test("an empty array converts without complaint", async () => {
  const empty = new Uint8Array(0);
  assertEquals(new Uint8Array(await new Blob([asBufferSource(empty)]).arrayBuffer()).length, 0);
  assertEquals((await sha256Hex(empty)).length, 64);
});

Deno.test("writeFileAtomic writes exactly the bytes of a view", async () => {
  const dir = await Deno.makeTempDir({ prefix: "mqt-bytes-" });
  try {
    const path = `${dir}/out.bin`;
    await writeFileAtomic(path, SAMPLE.subarray(2, 5));
    assertEquals(await Deno.readFile(path), new Uint8Array([3, 4, 5]));
    // Rewriting in place replaces rather than appends, and leaves no temp files.
    await writeFileAtomic(path, "replaced");
    assertEquals(await Deno.readTextFile(path), "replaced");
    const left: string[] = [];
    for await (const entry of Deno.readDir(dir)) left.push(entry.name);
    assertEquals(left, ["out.bin"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the durability flush works on every supported Deno major", async () => {
  // Deno 1.41 gates FsFile.sync behind --unstable-fs and *aborts the process*
  // when it is called without it, so an unguarded call does not surface as a
  // failed assertion here -- it takes the whole test runner down.
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
