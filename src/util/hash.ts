const encoder = new TextEncoder();

/** Hex-encoded SHA-256. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? encoder.encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

/**
 * Synchronous FNV-1a 128-bit-ish digest, used where a stable key is needed in a
 * hot synchronous path (cache lookups). Not a security primitive: cache keys
 * only need to be collision-resistant enough to distinguish quest strings.
 */
export function fastHashHex(input: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ (c ^ (i << 3)), 0xc2b2ae35) >>> 0;
    h4 = Math.imul(h4 ^ (c + (i * 31)), 0x27d4eb2f) >>> 0;
  }
  return [h1, h2, h3, h4].map((h) => h.toString(16).padStart(8, "0")).join("");
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}
