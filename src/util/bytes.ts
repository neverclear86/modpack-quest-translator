/**
 * One place to hand a `Uint8Array` to a web API across both supported Deno
 * majors.
 *
 * Deno 2 ships TypeScript 5.9, where `Uint8Array` is generic over its backing
 * store (`Uint8Array<ArrayBufferLike>`) and so is not assignable to `BufferSource`
 * or `BlobPart`, both of which now demand an `ArrayBuffer`. Deno 1.41 ships
 * TypeScript 5.3, which has no such type parameter to narrow, so the obvious
 * `Uint8Array<ArrayBuffer>` annotation does not parse there. Neither runtime
 * disagrees about the value -- only the two type systems disagree about its
 * name -- so a single cast keeps one source tree compiling on both.
 *
 * It is a cast and not a copy on purpose. Every archive entry this tool inflates
 * is a *view* into a much larger buffer; reaching for `bytes.buffer` to satisfy
 * the Deno 2 types would hand over the whole backing store and silently corrupt
 * the data, and copying would double the peak memory of every zip operation.
 */
export function asBufferSource(bytes: Uint8Array): BufferSource {
  return bytes as unknown as BufferSource;
}
