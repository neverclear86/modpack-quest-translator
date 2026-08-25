import { AppError } from "../../errors.ts";
import { normaliseEntryPath } from "../safety.ts";
import { asBufferSource } from "../../util/bytes.ts";

export interface ZipWriteEntry {
  path: string;
  data?: Uint8Array;
  /** Convenience alternative to `data`; encoded as UTF-8. */
  text?: string;
  /**
   * Unix permission bits, default 0644. The installer bundle needs 0755 on the
   * compiled binary and the two shell launchers: a `.sh` that arrives without
   * its execute bit is a support ticket, not a security feature.
   */
  mode?: number;
}

/**
 * DOS timestamp for 1980-01-01T00:00:00, the earliest the format can express.
 * Fixed so that identical content always produces an identical archive.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const DEFAULT_MODE = 0o644;
/** Regular-file type bits; the permission bits are OR-ed in per entry. */
const S_IFREG = 0o100000;
const VERSION_MADE_BY = 0x031E; // Unix, spec 3.0
const VERSION_NEEDED = 20;
const FLAG_UTF8 = 0x0800;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

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

class ByteWriter {
  #parts: Uint8Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  push(part: Uint8Array): void {
    this.#parts.push(part);
    this.#length += part.byteLength;
  }

  u16(value: number): void {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, value & 0xFFFF, true);
    this.push(buf);
  }

  u32(value: number): void {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, value >>> 0, true);
    this.push(buf);
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let offset = 0;
    for (const part of this.#parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([asBufferSource(data)]).stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Deterministic ZIP writer: entries sorted by path, fixed timestamps and
 * attributes, no extra fields, no data descriptors. See DESIGN.md §4.
 */
export async function writeZip(entries: readonly ZipWriteEntry[]): Promise<Uint8Array> {
  if (entries.length === 0) {
    throw new AppError("E_WRITE", "Refusing to write an empty archive");
  }

  const encoder = new TextEncoder();
  const prepared = entries.map((entry) => {
    const path = normaliseEntryPath(entry.path);
    if (path.endsWith("/")) {
      throw new AppError("E_WRITE", `Refusing to write a directory entry: ${entry.path}`);
    }
    const mode = entry.mode ?? DEFAULT_MODE;
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) {
      throw new AppError(
        "E_WRITE",
        `Refusing to write ${entry.path} with the mode ${mode}: expected 0 to 0o777`,
      );
    }
    const data = entry.data ?? encoder.encode(entry.text ?? "");
    return { path, data, mode };
  });

  prepared.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (let i = 1; i < prepared.length; i++) {
    if (prepared[i].path === prepared[i - 1].path) {
      throw new AppError("E_WRITE", `Duplicate archive entry: ${prepared[i].path}`);
    }
  }

  const local = new ByteWriter();
  const central = new ByteWriter();

  for (const entry of prepared) {
    const nameBytes = encoder.encode(entry.path);
    const deflated = entry.data.byteLength > 0 ? await deflateRaw(entry.data) : new Uint8Array(0);
    // Never let compression make an entry bigger.
    const useDeflate = deflated.byteLength > 0 && deflated.byteLength < entry.data.byteLength;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const stored = useDeflate ? deflated : entry.data;
    const crc = crc32(entry.data);
    const offset = local.length;

    local.u32(0x04034B50);
    local.u16(VERSION_NEEDED);
    local.u16(FLAG_UTF8);
    local.u16(method);
    local.u16(DOS_TIME);
    local.u16(DOS_DATE);
    local.u32(crc);
    local.u32(stored.byteLength);
    local.u32(entry.data.byteLength);
    local.u16(nameBytes.byteLength);
    local.u16(0);
    local.push(nameBytes);
    local.push(stored);

    central.u32(0x02014B50);
    central.u16(VERSION_MADE_BY);
    central.u16(VERSION_NEEDED);
    central.u16(FLAG_UTF8);
    central.u16(method);
    central.u16(DOS_TIME);
    central.u16(DOS_DATE);
    central.u32(crc);
    central.u32(stored.byteLength);
    central.u32(entry.data.byteLength);
    central.u16(nameBytes.byteLength);
    central.u16(0); // extra length
    central.u16(0); // comment length
    central.u16(0); // disk number
    central.u16(0); // internal attributes
    central.u32(((S_IFREG | entry.mode) << 16) >>> 0);
    central.u32(offset);
    central.push(nameBytes);
  }

  const localBytes = local.bytes();
  const centralBytes = central.bytes();

  const out = new ByteWriter();
  out.push(localBytes);
  out.push(centralBytes);
  out.u32(0x06054B50);
  out.u16(0);
  out.u16(0);
  out.u16(prepared.length);
  out.u16(prepared.length);
  out.u32(centralBytes.byteLength);
  out.u32(localBytes.byteLength);
  out.u16(0);
  return out.bytes();
}
