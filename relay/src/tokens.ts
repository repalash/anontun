// 12-char Crockford base32 token (60 bits of entropy). Plenty for an
// anonymous, ephemeral, single-tunnel-at-a-time identifier. Lowercase so it
// can double as a DNS label (<token>.tunnel.example.com); matching is
// case-insensitive and canonicalToken() lowercases whatever comes in.

const ALPHA = "0123456789abcdefghjkmnpqrstvwxyz"

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let s = ""
  for (let i = 0; i < 12; i++) s += ALPHA[bytes[i]! % 32]
  return s
}

export const TOKEN_RE = /^[0-9a-hjkmnp-tv-z]{12}$/i

export function canonicalToken(raw: string): string | null {
  const t = raw.toLowerCase()
  return TOKEN_RE.test(t) ? t : null
}
