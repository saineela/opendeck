import crypto from "node:crypto";

/**
 * TOTP (RFC 6238) built on HOTP (RFC 4226) — implemented directly on
 * node:crypto so the deployment has no native or third-party auth dependency.
 *
 * Parameters follow the interoperability defaults every authenticator app
 * expects: SHA-1, 6 digits, 30 second step, ±1 step of drift tolerance.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_ALGORITHM = "sha1";
/** Steps of clock skew accepted on either side of the current step. */
export const TOTP_WINDOW = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const BASE32_LOOKUP = new Map<string, number>(
  [...BASE32_ALPHABET].map((char, index) => [char, index]),
);

/** Encodes raw bytes as unpadded RFC 4648 base32 (the otpauth URI form). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/** Decodes unpadded RFC 4648 base32. Returns null for malformed input. */
export function base32Decode(input: string): Buffer | null {
  const normalized = input.replace(/=+$/g, "").replace(/\s+/g, "").toUpperCase();
  if (!normalized) return null;
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE32_LOOKUP.get(char);
    if (index === undefined) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Generates a fresh 160-bit shared secret, the size RFC 4226 recommends. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac(TOTP_ALGORITHM, secret).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Current-step code, used by tests and the enrolment confirmation screen. */
export function generateTotpCode(secretBase32: string, atMs: number = Date.now()): string | null {
  const secret = base32Decode(secretBase32);
  if (!secret) return null;
  return hotp(secret, Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS));
}

/**
 * Validates a submitted code against the current step plus the drift window.
 * Comparison is byte-wise constant time to avoid leaking which digit failed.
 */
export function verifyTotp(secretBase32: string, code: unknown, atMs: number = Date.now()): boolean {
  if (typeof code !== "string") return false;
  const candidate = code.replace(/\s+/g, "");
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(candidate)) return false;
  const secret = base32Decode(secretBase32);
  if (!secret) return false;

  const counter = Math.floor(atMs / 1000 / TOTP_PERIOD_SECONDS);
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset += 1) {
    const expected = hotp(secret, counter + offset);
    const a = Buffer.from(candidate, "ascii");
    const b = Buffer.from(expected, "ascii");
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** `otpauth://` URI for the authenticator-app QR code. */
export function buildOtpauthUri(options: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(options.account)}`;
  const params = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: TOTP_ALGORITHM.toUpperCase(),
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

const BACKUP_CODE_COUNT = 10;

/** Fresh printable backup codes; only their SHA-256 digests are persisted. */
export function generateBackupCodes(count: number = BACKUP_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString("hex").toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

export function hashBackupCodes(codes: string[]): string[] {
  return codes.map((code) => crypto.createHash("sha256").update(normalizeBackupCode(code)).digest("hex"));
}

export function normalizeBackupCode(code: string): string {
  return code.replace(/[^0-9a-fA-F]/g, "").toUpperCase();
}

/**
 * Consumes a matching backup code. Returns the updated store so the caller
 * can persist the removal — each code is single-use.
 */
export function consumeBackupCode(storedHashes: string[], code: unknown): string[] | null {
  if (typeof code !== "string") return null;
  const digest = crypto.createHash("sha256").update(normalizeBackupCode(code)).digest("hex");
  const index = storedHashes.indexOf(digest);
  if (index === -1) return null;
  const next = [...storedHashes];
  next.splice(index, 1);
  return next;
}
