const encoder = new TextEncoder()

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0))

export const randomToken = (bytes = 32) =>
  toBase64(crypto.getRandomValues(new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export const sha256 = async (value: string) => toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))

export async function hmacSha256Hex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

export function timingSafeEqual(a: string, b: string) {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ (y[i % y.length] ?? 0)
  return diff === 0
}

const aesKey = (base64Key: string) => crypto.subtle.importKey('raw', fromBase64(base64Key), 'AES-GCM', false, ['encrypt', 'decrypt'])

export async function encrypt(base64Key: string, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(base64Key), encoder.encode(plaintext)))
  const out = new Uint8Array(iv.length + cipher.length)
  out.set(iv)
  out.set(cipher, iv.length)
  return toBase64(out)
}

export async function decrypt(base64Key: string, encoded: string) {
  const bytes = fromBase64(encoded)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await aesKey(base64Key), bytes.slice(12))
  return new TextDecoder().decode(plain)
}
