import crypto from "node:crypto";

/**
 * Password hashing for local (email + password) accounts.
 *
 * scrypt is used because it ships with Node's standard library — no native
 * build step, which keeps the Docker image simple — and it is memory-hard,
 * which is the property that matters against GPU cracking rigs. Parameters
 * are stored inside the hash string so they can be raised later without
 * invalidating existing accounts.
 *
 * Encoded form: `scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>`
 */

const SCRYPT_N = 16384; // 2^14 → ~16 MiB per hash
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
// scrypt needs 128 * N * r bytes; Node's default 32 MiB cap is too tight once
// the r factor is raised, so budget explicitly.
const MAX_MEM = 128 * SCRYPT_N * SCRYPT_R * 4;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 256;

export interface PasswordPolicyResult {
  ok: boolean;
  error?: string;
}

/**
 * Length floor only — deliberately no composition rules (NIST SP 800-63B):
 * they push users toward predictable substitutions. The cap exists because
 * scrypt cost is linear in input length and the request body is already
 * limited, but an unbounded password would still be worth bounding.
 */
export function checkPasswordPolicy(password: unknown): PasswordPolicyResult {
  if (typeof password !== "string" || password.length === 0) {
    return { ok: false, error: "Password is required." };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      error: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    };
  }
  return { ok: true };
}

function scryptAsync(password: string, salt: Buffer, params: { N: number; r: number; p: number }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password.normalize("NFKC"),
      salt,
      KEY_LEN,
      { N: params.N, r: params.r, p: params.p, maxmem: Math.max(MAX_MEM, 128 * params.N * params.r * 4) },
      (error, derived) => (error ? reject(error) : resolve(derived)),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString("base64"),
    derived.toString("base64"),
  ].join("$");
}

/**
 * Verifies a candidate password. Returns false for malformed stored hashes
 * rather than throwing, and always spends comparable time on the mismatch
 * path so a corrupt row does not become an oracle.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) {
    // Burn an equivalent-ish amount of work so "no such account" and
    // "wrong password" are not distinguishable by timing.
    await scryptAsync(password, crypto.randomBytes(16), { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).catch(() => undefined);
    return false;
  }
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  // Refuse absurd parameters from a tampered row: they would turn a login
  // attempt into a denial of service.
  if (N < 1024 || N > 1 << 22 || r < 1 || r > 32 || p < 1 || p > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = await scryptAsync(password, salt, { N, r, p });
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
