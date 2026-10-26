const SECRET_KEYS = /^(authorization|cookie|x-api-key|api[_-]?key|token|secret|password)$/i;
const SECRET_VALUE =
  /(?:sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9._-]+|cf_[a-zA-Z0-9]{20,}|CLOUDFLARE_[A-Z_]+=[^\s]+)/gi;

export const REDACTED = "[REDACTED]";

export function scrubString(value: string): string {
  return value.replace(SECRET_VALUE, REDACTED);
}

export function scrubDeep<T>(value: T): T {
  if (typeof value === "string") return scrubString(value) as T;
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = scrubDeep(v);
      }
    }
    return out as T;
  }
  return value;
}
