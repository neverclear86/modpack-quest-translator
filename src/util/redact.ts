/**
 * Credential and PII scrubbing. Every string that reaches a log, an error, a
 * report, a manifest or a generated README passes through here first.
 * See DESIGN.md §9.
 */
export const REDACTION = "«redacted»";

/** Environment variables whose values must never appear in output. */
const SECRET_ENV_KEYS = [
  "CURSEFORGE_API_KEY",
  "CF_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

/** Shortest value worth registering; below this the match is noise, not a secret. */
const MIN_SECRET_LENGTH = 6;

const PATTERNS: readonly RegExp[] = [
  // Anthropic keys and other `sk-`-prefixed provider keys.
  /\bsk-[A-Za-z0-9_-]{8,}/g,
  // CurseForge keys are bcrypt-shaped.
  /\$2[aby]\$[./A-Za-z0-9$]{10,}/g,
  // Authorization headers.
  /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // Credential-bearing query parameters.
  /([?&](?:api[_-]?key|apikey|token|access[_-]?token|auth|secret|password)=)[^&\s"']+/gi,
  // Email addresses (PII; Claude Code's auth status returns one).
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

export class Redactor {
  readonly #secrets: string[] = [];

  /** Build a redactor seeded from an environment snapshot. */
  static fromEnv(env: Record<string, string | undefined>): Redactor {
    const redactor = new Redactor();
    for (const key of SECRET_ENV_KEYS) redactor.register(env[key]);
    return redactor;
  }

  /** Register a literal secret value discovered at runtime (flag, config, ...). */
  register(secret: string | undefined | null): void {
    if (typeof secret !== "string") return;
    const trimmed = secret.trim();
    if (trimmed.length < MIN_SECRET_LENGTH) return;
    if (this.#secrets.includes(trimmed)) return;
    this.#secrets.push(trimmed);
  }

  /** Scrub a single string. */
  text(input: string): string {
    let out = input;
    // Longest first, so a secret containing another secret is fully removed.
    for (const secret of [...this.#secrets].sort((a, b) => b.length - a.length)) {
      out = out.split(secret).join(REDACTION);
    }
    for (const pattern of PATTERNS) {
      out = out.replace(pattern, (_match, ...groups) => {
        const prefix = typeof groups[0] === "string" ? groups[0] : "";
        return prefix + REDACTION;
      });
    }
    return out;
  }

  /** Scrub every string inside an arbitrary JSON-shaped value. */
  value<T>(input: T): unknown {
    if (typeof input === "string") return this.text(input);
    if (Array.isArray(input)) return input.map((item) => this.value(item));
    if (input && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
        out[key] = this.value(val);
      }
      return out;
    }
    return input;
  }

  /** Scrub anything throwable into a safe message string. */
  error(input: unknown): string {
    if (input instanceof Error) return this.text(`${input.name}: ${input.message}`);
    return this.text(String(input));
  }
}

/** Process-wide redactor seeded from the real environment. */
export function createDefaultRedactor(): Redactor {
  const env: Record<string, string | undefined> = {};
  for (const key of SECRET_ENV_KEYS) {
    try {
      env[key] = Deno.env.get(key);
    } catch {
      // No --allow-env; nothing to seed.
    }
  }
  return Redactor.fromEnv(env);
}
