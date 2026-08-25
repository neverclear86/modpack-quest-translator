/**
 * Builds ZIP archives byte-by-byte, including deliberately malformed ones.
 * Test-only: the production writer refuses to emit anything unsafe, so the
 * attack corpus has to be constructed here.
 */
import { asBufferSource } from "../../src/util/bytes.ts";

export interface RawEntry {
  name: string;
  data: Uint8Array;
  method?: "store" | "deflate";
  /** Write a compression method the reader should refuse. */
  methodOverride?: number;
  /** General purpose bit flag, e.g. 0x0001 for "encrypted". */
  generalPurposeFlag?: number;
  /** Unix mode in the high 16 bits, e.g. symlink. */
  externalAttributes?: number;
  /** Lie about the uncompressed size in both headers. */
  declaredUncompressedSize?: number;
}

const encoder = new TextEncoder();

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([asBufferSource(data)]).stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

class Buf {
  #parts: Uint8Array[] = [];
  #length = 0;
  get length(): number {
    return this.#length;
  }
  push(part: Uint8Array): void {
    this.#parts.push(part);
    this.#length += part.length;
  }
  u16(v: number): void {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v & 0xFFFF, true);
    this.push(b);
  }
  u32(v: number): void {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0, true);
    this.push(b);
  }
  bytes(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let off = 0;
    for (const p of this.#parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }
}

export async function buildRawZip(entries: RawEntry[]): Promise<Uint8Array> {
  const local = new Buf();
  const central = new Buf();
  const offsets: number[] = [];

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const method = entry.methodOverride ?? (entry.method === "deflate" ? 8 : 0);
    const stored = method === 8 ? await deflateRaw(entry.data) : entry.data;
    const uncompressedSize = entry.declaredUncompressedSize ?? entry.data.length;
    const crc = crc32(entry.data);
    const flag = entry.generalPurposeFlag ?? 0x0800; // UTF-8 by default

    offsets.push(local.length);
    local.u32(0x04034B50);
    local.u16(20);
    local.u16(flag);
    local.u16(method);
    local.u16(0);
    local.u16(0);
    local.u32(crc);
    local.u32(stored.length);
    local.u32(uncompressedSize);
    local.u16(nameBytes.length);
    local.u16(0);
    local.push(nameBytes);
    local.push(stored);
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const nameBytes = encoder.encode(entry.name);
    const method = entry.methodOverride ?? (entry.method === "deflate" ? 8 : 0);
    const stored = method === 8 ? await deflateRaw(entry.data) : entry.data;
    const uncompressedSize = entry.declaredUncompressedSize ?? entry.data.length;
    const flag = entry.generalPurposeFlag ?? 0x0800;

    central.u32(0x02014B50);
    central.u16(0x031E); // made by unix
    central.u16(20);
    central.u16(flag);
    central.u16(method);
    central.u16(0);
    central.u16(0);
    central.u32(crc32(entry.data));
    central.u32(stored.length);
    central.u32(uncompressedSize);
    central.u16(nameBytes.length);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u16(0);
    central.u32(entry.externalAttributes ?? ((0o100644 << 16) >>> 0));
    central.u32(offsets[i]);
    central.push(nameBytes);
  }

  const out = new Buf();
  const localBytes = local.bytes();
  const centralBytes = central.bytes();
  out.push(localBytes);
  out.push(centralBytes);
  out.u32(0x06054B50);
  out.u16(0);
  out.u16(0);
  out.u16(entries.length);
  out.u16(entries.length);
  out.u32(centralBytes.length);
  out.u32(localBytes.length);
  out.u16(0);
  return out.bytes();
}
