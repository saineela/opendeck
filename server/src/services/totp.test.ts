import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  buildOtpauthUri,
  consumeBackupCode,
  generateBackupCodes,
  generateTotpCode,
  generateTotpSecret,
  hashBackupCodes,
  verifyTotp,
} from "./totp.js";

const RFC6238_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // "12345678901234567890" base32

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const encoded = base32Encode(bytes);
    expect(encoded).toMatch(/^[A-Z2-7]+$/);
    expect(base32Decode(encoded)?.equals(bytes)).toBe(true);
  });

  it("matches known RFC 4648 vectors", () => {
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Decode("MZXW6YTBOI")?.toString()).toBe("foobar");
  });

  it("returns null for malformed input", () => {
    expect(base32Decode("")).toBeNull();
    expect(base32Decode("1")).toBeNull(); // 0 and 1 are not in the alphabet
    expect(base32Decode("!@#$")).toBeNull();
  });
});

describe("TOTP (RFC 6238)", () => {
  it("produces the published test vectors", () => {
    // RFC 6238 Appendix B publishes 8-digit codes; this implementation uses
    // the 6-digit form every authenticator app defaults to, which is the same
    // truncated value modulo 10^6 — i.e. the last six digits.
    const vectors: Array<[number, string]> = [
      [59, "287082"],
      [1111111109, "081804"],
      [1111111111, "050471"],
      [1234567890, "005924"],
      [2000000000, "279037"],
      [20000000000, "353130"],
    ];
    for (const [seconds, expected] of vectors) {
      const code = generateTotpCode(RFC6238_SECRET, seconds * 1000);
      expect(code, `vector at t=${seconds}`).toBe(expected);
    }
  });

  it("accepts the current code within one step of drift", () => {
    const now = 1_700_000_000_000;
    const code = generateTotpCode(RFC6238_SECRET, now);
    expect(verifyTotp(RFC6238_SECRET, code, now)).toBe(true);
    // One step of drift either side is tolerated (authenticator clock skew):
    // a code minted at step S is still valid while S±1 is current.
    expect(verifyTotp(RFC6238_SECRET, code, now + 30_000)).toBe(true);
    expect(verifyTotp(RFC6238_SECRET, code, now - 30_000)).toBe(true);
    // Two steps of drift is outside the window.
    expect(verifyTotp(RFC6238_SECRET, code, now + 60_000)).toBe(false);
    expect(verifyTotp(RFC6238_SECRET, code, now - 60_000)).toBe(false);
  });

  it("rejects malformed codes and secrets", () => {
    const now = Date.now();
    expect(verifyTotp(RFC6238_SECRET, "12345", now)).toBe(false);
    expect(verifyTotp(RFC6238_SECRET, "1234567", now)).toBe(false);
    expect(verifyTotp(RFC6238_SECRET, "abcdef", now)).toBe(false);
    expect(verifyTotp(RFC6238_SECRET, 123456, now)).toBe(false);
    expect(verifyTotp(RFC6238_SECRET, null, now)).toBe(false);
    expect(verifyTotp("not-base32!!", "123456", now)).toBe(false);
    // Spaces are tolerated — some apps paste with one.
    expect(verifyTotp(RFC6238_SECRET, generateTotpCode(RFC6238_SECRET, now)!.replace(/^(\d{3})/, "$1 "), now)).toBe(
      true,
    );
  });

  it("generates a distinct secret per enrolment", () => {
    const secrets = new Set(Array.from({ length: 20 }, () => generateTotpSecret()));
    expect(secrets.size).toBe(20);
    for (const secret of secrets) expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });
});

describe("otpauth URI", () => {
  it("encodes issuer and account", () => {
    const uri = buildOtpauthUri({ secret: RFC6238_SECRET, account: "me@example.com", issuer: "OpenDeck" });
    // The label separator stays a literal colon, per the otpauth spec.
    expect(uri).toContain("otpauth://totp/OpenDeck:me%40example.com");
    expect(uri).toContain("secret=" + RFC6238_SECRET);
    expect(uri).toContain("issuer=OpenDeck");
    expect(uri).toContain("algorithm=SHA1");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});

describe("backup codes", () => {
  it("generates unique, hyphenated codes", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-F]{5}-[0-9A-F]{5}$/);
  });

  it("stores only digests and consumes a matching code exactly once", () => {
    const codes = generateBackupCodes(3);
    const stored = hashBackupCodes(codes);
    expect(stored).toHaveLength(3);
    // Digests must not be the plaintext codes.
    for (let i = 0; i < codes.length; i += 1) expect(stored[i]).not.toBe(codes[i]);

    const remaining = consumeBackupCode(stored, codes[1]);
    expect(remaining).toHaveLength(2);
    expect(consumeBackupCode(remaining!, codes[1])).toBeNull();
    expect(consumeBackupCode(remaining!, codes[0])).toHaveLength(1);
    expect(consumeBackupCode(remaining!, "nope")).toBeNull();
    expect(consumeBackupCode(remaining!, 42)).toBeNull();
  });

  it("matches codes regardless of formatting", () => {
    const [code] = generateBackupCodes(1);
    const stored = hashBackupCodes([code!]);
    // Same code with dashes stripped and lower-cased still resolves.
    const alt = code!.replace("-", "").toLowerCase();
    expect(consumeBackupCode(stored, alt)).not.toBeNull();
  });
});
