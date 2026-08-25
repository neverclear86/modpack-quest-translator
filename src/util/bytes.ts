/**
 * One place to hand a `Uint8Array` to a web API.
 *
 * Deno 2 ships a TypeScript in which `Uint8Array` is generic over its backing
 * store (`Uint8Array<ArrayBufferLike>`) and so is not assignable to
 * `BufferSource` or `BlobPart`, both of which demand an `ArrayBuffer`. The two
 * agree about the value -- only the types disagree about its name -- so a
 * single cast, in one place, keeps the rest of the tree free of casts.
 *
 * It is a cast and not a copy on purpose. Every archive entry this tool inflates
 * is a *view* into a much larger buffer; reaching for `bytes.buffer` to satisfy
 * the types would hand over the whole backing store and silently corrupt the
 * data, and copying would double the peak memory of every zip operation.
 */
export function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}
