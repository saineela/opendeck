import crypto from "node:crypto";

const ALGO = "aes-256-gcm";

function deriveKey(appSecret: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", appSecret, Buffer.from("jamc-youtube-tokens"), Buffer.from("v1"), 32));
}

export interface EncryptedPayload {
  ciphertext: string;
  nonce: string;
  authTag: string;
}

export function encryptJson(appSecret: Buffer, value: unknown): EncryptedPayload {
  const key = deriveKey(appSecret);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, nonce);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: encrypted.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptJson<T>(appSecret: Buffer, payload: EncryptedPayload): T {
  const key = deriveKey(appSecret);
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(payload.nonce, "base64"));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}
