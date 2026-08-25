import { AppError } from "../errors.ts";
import { VERSION } from "../version.ts";

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpClientOptions {
  fetch?: FetchLike;
  userAgent?: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
  /** Hard cap on any response body. */
  maxBytes?: number;
  maxRedirects?: number;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Overrides the client-wide body cap for this request. */
  maxBytes?: number;
  onProgress?: (received: number, total: number | undefined) => void;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB
const DEFAULT_MAX_REDIRECTS = 5;
/** JSON API responses are small; a separate, much tighter cap. */
const JSON_MAX_BYTES = 32 * 1024 * 1024;

function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("E_DOWNLOAD", `Not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AppError("E_DOWNLOAD", `Refusing non-http URL scheme "${url.protocol}"`);
  }
  return url;
}

/**
 * The single HTTP entry point. Every outbound request is bounded in time, size
 * and redirect count, and every hop is re-validated. See DESIGN.md §4.
 */
export class BoundedHttpClient {
  readonly #fetch: FetchLike;
  readonly #userAgent: string;
  readonly #timeoutMs: number;
  readonly #maxBytes: number;
  readonly #maxRedirects: number;

  constructor(options: HttpClientOptions = {}) {
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#userAgent = options.userAgent ?? `modpack-quest-translator/${VERSION}`;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  }

  async getJson<T = unknown>(url: string, options: RequestOptions = {}): Promise<T> {
    const bytes = await this.getBytes(url, {
      ...options,
      maxBytes: Math.min(options.maxBytes ?? JSON_MAX_BYTES, JSON_MAX_BYTES),
      headers: { accept: "application/json", ...options.headers },
    });
    const text = new TextDecoder().decode(bytes);
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new AppError("E_DOWNLOAD", `Response from ${url} was not valid JSON`, {
        cause,
        hint: "The endpoint may have returned an HTML error or challenge page.",
      });
    }
  }

  /** Fetch a whole body into memory, following redirects manually. */
  async getBytes(url: string, options: RequestOptions = {}): Promise<Uint8Array> {
    // One deadline covers redirects plus body read, and is always cleared so it
    // cannot outlive the call (Deno's test sanitizer treats a live timer as a leak).
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new DOMException("Timed out", "TimeoutError")),
      this.#timeoutMs,
    );
    const signal = options.signal ? anySignal([options.signal, deadline.signal]) : deadline.signal;
    try {
      const response = await this.#request(url, options, signal);
      return await this.#readBody(response, options, url, signal);
    } catch (error) {
      if (deadline.signal.aborted && !options.signal?.aborted) {
        throw new AppError("E_DOWNLOAD", `Request to ${url} timed out after ${this.#timeoutMs}ms`, {
          cause: error,
          hint: "Raise --timeout for slow mirrors.",
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async #request(url: string, options: RequestOptions, signal: AbortSignal): Promise<Response> {
    let current = assertHttpUrl(url);
    let previousProtocol = current.protocol;

    for (let hop = 0; hop <= this.#maxRedirects; hop++) {
      if (options.signal?.aborted) {
        throw new AppError("E_CANCELLED", "Request cancelled");
      }

      let response: Response;
      try {
        response = await this.#fetch(current.toString(), {
          method: "GET",
          redirect: "manual",
          signal,
          headers: { "user-agent": this.#userAgent, ...options.headers },
        });
      } catch (cause) {
        if (options.signal?.aborted) throw new AppError("E_CANCELLED", "Request cancelled");
        throw new AppError("E_DOWNLOAD", `Request to ${current.toString()} failed`, { cause });
      }

      if (!isRedirect(response.status)) {
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw new AppError(
            "E_DOWNLOAD",
            `HTTP ${response.status} ${response.statusText} for ${current.toString()}`,
            { details: { status: response.status, url: current.toString() } },
          );
        }
        return response;
      }

      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => {});
      if (!location) {
        throw new AppError(
          "E_DOWNLOAD",
          `Redirect from ${current.toString()} had no Location header`,
        );
      }

      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        throw new AppError("E_DOWNLOAD", `Redirect to an unparseable location: ${location}`);
      }
      if (next.protocol !== "https:" && next.protocol !== "http:") {
        throw new AppError(
          "E_DOWNLOAD",
          `Refusing redirect to unsupported scheme "${next.protocol}"`,
        );
      }
      if (previousProtocol === "https:" && next.protocol === "http:") {
        throw new AppError(
          "E_DOWNLOAD",
          `Refusing https to http downgrade redirect to ${next.toString()}`,
        );
      }
      previousProtocol = next.protocol;
      current = next;
    }

    throw new AppError(
      "E_DOWNLOAD",
      `Exceeded the maximum of ${this.#maxRedirects} redirects starting from ${url}`,
    );
  }

  async #readBody(
    response: Response,
    options: RequestOptions,
    url: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const cap = options.maxBytes ?? this.#maxBytes;

    const declared = response.headers.get("content-length");
    const total = declared !== null && /^\d+$/.test(declared) ? Number(declared) : undefined;
    if (total !== undefined && total > cap) {
      await response.body?.cancel().catch(() => {});
      throw new AppError(
        "E_DOWNLOAD",
        `Response from ${url} is too large: ${total} bytes exceeds the ${cap} byte limit`,
        { hint: "Raise --max-download if this pack really is that big." },
      );
    }

    if (!response.body) {
      const buf = new Uint8Array(await response.arrayBuffer());
      if (buf.byteLength > cap) {
        throw new AppError("E_DOWNLOAD", `Response from ${url} is too large (over ${cap} bytes)`);
      }
      options.onProgress?.(buf.byteLength, total);
      return buf;
    }

    const chunks: Uint8Array[] = [];
    let received = 0;
    const reader = response.body.getReader();
    try {
      while (true) {
        if (options.signal?.aborted) throw new AppError("E_CANCELLED", "Download cancelled");
        if (signal.aborted && !options.signal?.aborted) {
          throw new AppError("E_DOWNLOAD", `Download of ${url} timed out`);
        }
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        received += value.byteLength;
        // Enforced against actual bytes, so a lying Content-Length cannot help.
        if (received > cap) {
          throw new AppError(
            "E_DOWNLOAD",
            `Response from ${url} is too large: exceeded the ${cap} byte limit`,
            { hint: "Raise --max-download if this pack really is that big." },
          );
        }
        chunks.push(value);
        options.onProgress?.(received, total);
      }
    } finally {
      reader.releaseLock();
      await response.body.cancel().catch(() => {});
    }

    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Deno 1.41 has no AbortSignal.any. */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}
