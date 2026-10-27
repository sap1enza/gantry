import { timingSafeEqual } from 'hono/utils/buffer'
import { decodeBase64, encodeBase64, encodeBase64Url } from 'hono/utils/encode'

export { timingSafeEqual }

const encoder = new TextEncoder()

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')

export const randomToken = (bytes = 32) => encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)).buffer).replace(/=+$/, '')

export const sha256 = async (value: string) => toHex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))

export async function hmacSha256Hex(secret: string, message: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)))
}

const aesKey = (base64Key: string) => crypto.subtle.importKey('raw', decodeBase64(base64Key), 'AES-GCM', false, ['encrypt', 'decrypt'])

export async function encrypt(base64Key: string, plaintext: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(base64Key), encoder.encode(plaintext)))
  const out = new Uint8Array(iv.length + cipher.length)
  out.set(iv)
  out.set(cipher, iv.length)
  return encodeBase64(out.buffer)
}

export async function decrypt(base64Key: string, encoded: string) {
  const bytes = decodeBase64(encoded)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await aesKey(base64Key), bytes.slice(12))
  return new TextDecoder().decode(plain)
}
