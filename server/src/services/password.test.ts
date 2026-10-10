import { describe, expect, it } from "vitest";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  checkPasswordPolicy,
  hashPassword,
  verifyPassword,
} from "./password.js";

describe("checkPasswordPolicy", () => {
  it("accepts passwords at or above the length floor", async () => {
    expect(checkPasswordPolicy("a".repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
    expect(checkPasswordPolicy("a".repeat(MIN_PASSWORD_LENGTH + 40)).ok).toBe(true);
  });

  it("rejects missing, short, non-string, and oversized values", () => {
    expect(checkPasswordPolicy(undefined)).toEqual({
      ok: false,
      error: "Password is required.",
    });
    expect(checkPasswordPolicy(12345678 as unknown as string).error).toBe("Password is required.");
    expect(checkPasswordPolicy("short").error).toBe(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
    expect(checkPasswordPolicy("a".repeat(MAX_PASSWORD_LENGTH + 1)).error).toBe(
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    );
  });
});

describe("hashPassword / verifyPassword", () => {
  it("round-trips the correct password", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
  });

  it("rejects a wrong password", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse batterz", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts each hash so identical passwords differ at rest", async () => {
    const [first, second] = await Promise.all([hashPassword("same password"), hashPassword("same password")]);
    expect(first).not.toBe(second);
    expect(await verifyPassword("same password", first)).toBe(true);
    expect(await verifyPassword("same password", second)).toBe(true);
  });

  it("returns false rather than throwing on malformed stored values", async () => {
    for (const bad of [null, "", "not-a-hash", "scrypt$16384$8$1$onlyfive$parts", "bcrypt$1$2$3$4$5"]) {
      expect(await verifyPassword("anything", bad)).toBe(false);
    }
  });

  it("refuses absurd cost parameters from a tampered row", async () => {
    // A row claiming N = 2^30 would allocate gigabytes per login attempt.
    const hostile = `scrypt$1073741824$8$1$YWJjZGVmZ2hpamtsbW5v$YWJj`;
    expect(await verifyPassword("anything", hostile)).toBe(false);
  });

  it("normalises unicode so the same typed password verifies", async () => {
    // é as one code point vs. e + combining acute.
    const stored = await hashPassword("café-password");
    expect(await verifyPassword("café-password", stored)).toBe(true);
  });

  it("verifies without a stored hash only to burn equivalent time", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
  });
});
