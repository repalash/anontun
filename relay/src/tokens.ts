// 12-char Crockford base32 token (60 bits of entropy). Plenty for an
// anonymous, ephemeral, single-tunnel-at-a-time identifier.

const ALPHA = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export function generateToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  let s = ""
  for (let i = 0; i < 12; i++) s += ALPHA[bytes[i]! % 32]
  return s
}

export const TOKEN_RE = /^[0-9A-HJKMNP-TV-Z]{12}$/
