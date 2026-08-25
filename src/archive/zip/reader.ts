import { AppError } from "../../errors.ts";
import { normaliseEntryPath, S_IFLNK, unixFileType } from "../safety.ts";
import { asBufferSource } from "../../util/bytes.ts";

export const ZIP_LIMITS = {
  /** Largest single uncompressed entry we will inflate. */
  maxEntryBytes: 64 * 1024 * 1024,
  /** Largest total uncompressed size declared by an archive. */
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
  /**
   * Highest plausible compression ratio before we call it a bomb, applied only
   * to entries at or above `ratioCheckFloorBytes`. Highly repetitive text
   * legitimately compresses several hundred to one (100 KiB of one repeated
   * character deflates ~820:1), so a low threshold with no floor rejects real
   * packs. The absolute per-entry and total caps below are the real bound;
   * this only catches a bomb earlier and more cheaply.
   */
  maxCompressionRatio: 500,
  ratioCheckFloorBytes: 8 * 1024 * 1024,
  maxEntries: 200_000,
} as const;

export interface ZipReadOptions {
  maxEntryBytes?: number;
  maxTotalBytes?: number;
  maxCompressionRatio?: number;
  ratioCheckFloorBytes?: number;
  maxEntries?: number;
}

export interface ZipEntry {
  /** Safe, forward-slashed path. */
  readonly path: string;
  /** The name exactly as stored in the archive. */
  readonly rawName: string;
  readonly isDirectory: boolean;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly method: number;
  readonly crc32: number;
  /** Unix permission bits from the external attributes, 0 when not Unix-made. */
  readonly unixMode: number;
}

export interface ZipArchive {
  readonly entries: readonly ZipEntry[];
  files(): readonly ZipEntry[];
  has(path: string): boolean;
  read(path: string): Promise<Uint8Array>;
  readText(path: string): Promise<string>;
}

const SIG_EOCD = 0x06054B50;
const SIG_EOCD64_LOCATOR = 0x07064B50;
const SIG_EOCD64 = 0x06064B50;
const SIG_CENTRAL = 0x02014B50;
const SIG_LOCAL = 0x04034B50;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;

interface CentralRecord extends ZipEntry {
  localHeaderOffset: number;
  flag: number;
}

function corrupt(message: string): AppError {
  return new AppError("E_UNSUPPORTED_PACK", `Malformed ZIP archive: ${message}`, {
    hint: "The download may be truncated or is not a ZIP/mrpack archive.",
  });
}

/**
 * Reads a ZIP archive entirely from the central directory (local headers are
 * never trusted for sizes or names) and enforces the limits in DESIGN.md §4.
 * Nothing is written to disk and nothing is executed.
 */
// The async signature is part of the contract: callers await readZip, and a
// malformed or hostile archive must surface as a rejected promise rather than a
// synchronous throw that no `await` would catch.
// deno-lint-ignore require-await
export async function readZip(
  bytes: Uint8Array,
  options: ZipReadOptions = {},
): Promise<ZipArchive> {
  const limits = { ...ZIP_LIMITS, ...options };
  if (bytes.byteLength === 0) throw corrupt("the archive is empty");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(bytes, view);

  let entryCount = view.getUint16(eocd + 10, true);
  let centralSize = view.getUint32(eocd + 12, true);
  let centralOffset = view.getUint32(eocd + 16, true);

  // ZIP64 for archives with >65535 entries or >4 GiB offsets.
  if (entryCount === 0xFFFF || centralOffset === 0xFFFFFFFF || centralSize === 0xFFFFFFFF) {
    const z64 = findZip64(bytes, view, eocd);
    entryCount = Number(z64.entryCount);
    centralSize = Number(z64.centralSize);
    centralOffset = Number(z64.centralOffset);
  }

  if (entryCount > limits.maxEntries) {
    throw new AppError(
      "E_UNSUPPORTED_PACK",
      `Archive declares ${entryCount} entries, above the limit of ${limits.maxEntries}`,
      { hint: "Refusing to read a potential entry-count bomb." },
    );
  }
  if (centralOffset + centralSize > bytes.byteLength) {
    throw corrupt("the central directory extends past the end of the file");
  }

  const records: CentralRecord[] = [];
  const byPath = new Map<string, CentralRecord>();
  let totalUncompressed = 0;
  let cursor = centralOffset;

  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > bytes.byteLength) throw corrupt("truncated central directory entry");
    if (view.getUint32(cursor, true) !== SIG_CENTRAL) {
      throw corrupt(`bad central directory signature at offset ${cursor}`);
    }

    const flag = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    let compressedSize = view.getUint32(cursor + 20, true);
    let uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    let localHeaderOffset = view.getUint32(cursor + 42, true);

    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > bytes.byteLength) throw corrupt("truncated entry name");
    const rawName = decodeName(bytes.subarray(nameStart, nameEnd), flag);

    const extra = bytes.subarray(nameEnd, nameEnd + extraLength);
    if (
      uncompressedSize === 0xFFFFFFFF || compressedSize === 0xFFFFFFFF ||
      localHeaderOffset === 0xFFFFFFFF
    ) {
      const z64 = readZip64Extra(extra, { uncompressedSize, compressedSize, localHeaderOffset });
      uncompressedSize = z64.uncompressedSize;
      compressedSize = z64.compressedSize;
      localHeaderOffset = z64.localHeaderOffset;
    }

    if ((flag & FLAG_ENCRYPTED) !== 0 || (flag & FLAG_STRONG_ENCRYPTION) !== 0) {
      throw new AppError(
        "E_UNSUPPORTED_PACK",
        `Archive entry ${JSON.stringify(rawName)} is encrypted`,
        { hint: "Encrypted modpack archives are not supported." },
      );
    }

    const path = normaliseEntryPath(rawName);
    const isDirectory = path.endsWith("/");

    if (!isDirectory && unixFileType(externalAttributes) === S_IFLNK) {
      throw new AppError(
        "E_UNSUPPORTED_PACK",
        `Refusing archive entry ${JSON.stringify(rawName)}: it is a symlink`,
        { hint: "Symlinks in modpack archives can escape the extraction root." },
      );
    }

    if (!isDirectory) {
      if (method !== METHOD_STORE && method !== METHOD_DEFLATE) {
        throw new AppError(
          "E_UNSUPPORTED_PACK",
          `Archive entry ${JSON.stringify(rawName)} uses unsupported compression method ${method}`,
          { hint: "Only stored and deflated entries are supported." },
        );
      }
      if (uncompressedSize > limits.maxEntryBytes) {
        throw new AppError(
          "E_UNSUPPORTED_PACK",
          `Archive entry ${JSON.stringify(rawName)} is too large: ` +
            `${uncompressedSize} bytes exceeds the ${limits.maxEntryBytes} byte per-entry limit`,
          { hint: "Refusing to inflate a potential decompression bomb." },
        );
      }
      if (
        compressedSize > 0 && uncompressedSize >= limits.ratioCheckFloorBytes &&
        uncompressedSize / compressedSize > limits.maxCompressionRatio
      ) {
        throw new AppError(
          "E_UNSUPPORTED_PACK",
          `Archive entry ${JSON.stringify(rawName)} has an implausible compression ratio ` +
            `(${Math.round(uncompressedSize / compressedSize)}:1)`,
          { hint: "Refusing to inflate a potential decompression bomb." },
        );
      }
      totalUncompressed += uncompressedSize;
      if (totalUncompressed > limits.maxTotalBytes) {
        throw new AppError(
          "E_UNSUPPORTED_PACK",
          `Archive total uncompressed size exceeds the ${limits.maxTotalBytes} byte limit`,
          { hint: "Refusing to read a potential decompression bomb." },
        );
      }
    }

    const record: CentralRecord = {
      path,
      rawName,
      isDirectory,
      compressedSize,
      uncompressedSize,
      method,
      crc32: crc,
      unixMode: (externalAttributes >>> 16) & 0o777,
      localHeaderOffset,
      flag,
    };
    records.push(record);
    if (!isDirectory && !byPath.has(path)) byPath.set(path, record);

    cursor = nameEnd + extraLength + commentLength;
  }

  const read = async (path: string): Promise<Uint8Array> => {
    const record = byPath.get(path);
    if (!record) {
      throw new AppError("E_INTERNAL", `Archive entry not found: ${path}`);
    }
    return await readEntry(bytes, view, record, limits);
  };

  return {
    entries: records,
    files: () => records.filter((r) => !r.isDirectory),
    has: (path) => byPath.has(path),
    read,
    readText: async (path) => decodeText(await read(path)),
  };
}

async function readEntry(
  bytes: Uint8Array,
  view: DataView,
  record: CentralRecord,
  limits: Required<ZipReadOptions>,
): Promise<Uint8Array> {
  const offset = record.localHeaderOffset;
  if (offset + 30 > bytes.byteLength) throw corrupt("truncated local file header");
  if (view.getUint32(offset, true) !== SIG_LOCAL) {
    throw corrupt(`bad local file header signature at offset ${offset}`);
  }
  // Only the variable-length fields are read from the local header; sizes and
  // the name come from the central directory.
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const dataStart = offset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + record.compressedSize;
  if (dataEnd > bytes.byteLength) throw corrupt(`entry data for ${record.path} is truncated`);

  const raw = bytes.subarray(dataStart, dataEnd);
  if (record.method === METHOD_STORE) {
    if (raw.byteLength > limits.maxEntryBytes) {
      throw corrupt(`entry ${record.path} exceeds the per-entry limit`);
    }
    return raw.slice();
  }

  return await inflateBounded(raw, Math.min(record.uncompressedSize, limits.maxEntryBytes), record);
}

/** Inflate with a hard output cap, so a lying central directory cannot bomb us. */
async function inflateBounded(
  raw: Uint8Array,
  cap: number,
  record: CentralRecord,
): Promise<Uint8Array> {
  const stream = new Blob([asBufferSource(raw)]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) {
        throw new AppError(
          "E_UNSUPPORTED_PACK",
          `Archive entry ${JSON.stringify(record.rawName)} inflated to more than its ` +
            `declared size of ${cap} bytes`,
          { hint: "Refusing to inflate a potential decompression bomb." },
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw corrupt(`entry ${record.path} could not be inflated`);
  } finally {
    reader.releaseLock();
    await stream.cancel().catch(() => {});
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const chunk of chunks) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  const minimum = 22;
  if (bytes.byteLength < minimum) throw corrupt("the file is too small to be a ZIP archive");
  // The comment may be up to 64 KiB, so scan backwards over that window.
  const scanStart = Math.max(0, bytes.byteLength - (0xFFFF + minimum));
  for (let i = bytes.byteLength - minimum; i >= scanStart; i--) {
    if (view.getUint32(i, true) !== SIG_EOCD) continue;
    const commentLength = view.getUint16(i + 20, true);
    if (i + minimum + commentLength === bytes.byteLength) return i;
  }
  throw corrupt("no end of central directory record found");
}

interface Zip64Values {
  entryCount: bigint;
  centralSize: bigint;
  centralOffset: bigint;
}

function findZip64(bytes: Uint8Array, view: DataView, eocd: number): Zip64Values {
  const locator = eocd - 20;
  if (locator < 0 || view.getUint32(locator, true) !== SIG_EOCD64_LOCATOR) {
    throw corrupt("ZIP64 archive without an end of central directory locator");
  }
  const recordOffset = Number(view.getBigUint64(locator + 8, true));
  if (
    recordOffset < 0 || recordOffset + 56 > bytes.byteLength ||
    view.getUint32(recordOffset, true) !== SIG_EOCD64
  ) {
    throw corrupt("ZIP64 end of central directory record is missing or malformed");
  }
  return {
    entryCount: view.getBigUint64(recordOffset + 32, true),
    centralSize: view.getBigUint64(recordOffset + 40, true),
    centralOffset: view.getBigUint64(recordOffset + 48, true),
  };
}

interface Zip64EntrySizes {
  uncompressedSize: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readZip64Extra(extra: Uint8Array, current: Zip64EntrySizes): Zip64EntrySizes {
  const view = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let offset = 0;
  while (offset + 4 <= extra.byteLength) {
    const headerId = view.getUint16(offset, true);
    const size = view.getUint16(offset + 2, true);
    const body = offset + 4;
    if (body + size > extra.byteLength) break;
    if (headerId === 0x0001) {
      const out = { ...current };
      let cursor = body;
      if (out.uncompressedSize === 0xFFFFFFFF && cursor + 8 <= body + size) {
        out.uncompressedSize = Number(view.getBigUint64(cursor, true));
        cursor += 8;
      }
      if (out.compressedSize === 0xFFFFFFFF && cursor + 8 <= body + size) {
        out.compressedSize = Number(view.getBigUint64(cursor, true));
        cursor += 8;
      }
      if (out.localHeaderOffset === 0xFFFFFFFF && cursor + 8 <= body + size) {
        out.localHeaderOffset = Number(view.getBigUint64(cursor, true));
      }
      return out;
    }
    offset = body + size;
  }
  throw corrupt("ZIP64 entry without a ZIP64 extended information extra field");
}

function decodeName(bytes: Uint8Array, flag: number): string {
  // Bit 11 marks UTF-8. Historic archives use CP437; UTF-8 with a lenient
  // decoder is close enough for path matching and never throws.
  void flag;
  return new TextDecoder("utf-8").decode(bytes);
}

function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder("utf-8").decode(bytes);
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

export { FLAG_DATA_DESCRIPTOR };
