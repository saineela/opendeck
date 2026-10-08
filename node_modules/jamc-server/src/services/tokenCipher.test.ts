import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptJson, encryptJson } from "./tokenCipher.js";

const SECRET = crypto.createHash("sha256").update("test-app-secret").digest();
const OTHER_SECRET = crypto.createHash("sha256").update("different-app-secret").digest();

describe("encryptJson / decryptJson", () => {
  it("round-trips arbitrary JSON values", () => {
    const value = {
      access_token: "ya29.secret",
      refresh_token: "1//refresh",
      expiry_date: new Date("2030-01-02T03:04:05.000Z").toISOString(),
      nested: { list: [1, 2, 3], flag: true, nothing: null },
    };
    const payload = encryptJson(SECRET, value);
    expect(decryptJson(SECRET, payload)).toEqual(value);
  });

  it("never stores plaintext in the ciphertext", () => {
    const payload = encryptJson(SECRET, { access_token: "super-secret-token" });
    expect(payload.ciphertext).not.toContain("super-secret-token");
    expect(Buffer.from(payload.ciphertext, "base64").toString("utf8")).not.toContain(
      "super-secret-token",
    );
  });

  it("uses a fresh nonce per encryption", () => {
    const value = { access_token: "same" };
    const first = encryptJson(SECRET, value);
    const second = encryptJson(SECRET, value);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("rejects decryption with the wrong secret", () => {
    const payload = encryptJson(SECRET, { access_token: "token" });
    expect(() => decryptJson(OTHER_SECRET, payload)).toThrow();
  });

  it("rejects tampered ciphertext", () => {
    const payload = encryptJson(SECRET, { access_token: "token" });
    const bytes = Buffer.from(payload.ciphertext, "base64");
    bytes[0] ^= 0xff;
    expect(() =>
      decryptJson(SECRET, { ...payload, ciphertext: bytes.toString("base64") }),
    ).toThrow();
  });

  it("rejects a tampered auth tag", () => {
    const payload = encryptJson(SECRET, { access_token: "token" });
    const tag = Buffer.from(payload.authTag, "base64");
    tag[0] ^= 0xff;
    expect(() =>
      decryptJson(SECRET, { ...payload, authTag: tag.toString("base64") }),
    ).toThrow();
  });
});
