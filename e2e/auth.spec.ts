import { expect, test } from "@playwright/test";
import {
  accountCard,
  gotoApp,
  openSettings,
  skipOnboarding,
} from "./fixtures/helpers";

test.describe("Google sign-in", () => {
  test("signs in through the QR handoff, keeps the session across reload, and returns to the gate on logout", async ({
    page,
    browser,
  }) => {
    test.setTimeout(180_000);
    await skipOnboarding(page);
    // Signed out, the gated shell never appears — gotoApp lands on /login,
    // which is where the QR panel arms an attempt automatically.
    await gotoApp(page);
    await page.waitForURL(/\/login/, { timeout: 30_000 });
    const qr = page.getByRole("img", { name: "Sign in with Google QR code" });
    await expect(qr).toBeVisible({ timeout: 30_000 });

    // "Scanning" = opening the encoded link in a separate browser context,
    // exactly as a phone would (no shared cookies with the desktop).
    const qrUrl = await page
      .locator('a:has(> svg[aria-label="Sign in with Google QR code"])')
      .getAttribute("href");
    expect(qrUrl).toBeTruthy();

    const phone = await browser.newContext();
    try {
      const phonePage = await phone.newPage();
      await phonePage.goto(qrUrl!, { waitUntil: "domcontentloaded", timeout: 60_000 });
      // The fake IdP auto-approves; the callback renders the confirmation
      // page — and must NOT set a session cookie on the phone.
      await expect(phonePage.getByText("Signed in on your computer")).toBeVisible({
        timeout: 60_000,
      });
      const phoneCookies = await phone.cookies();
      expect(phoneCookies.find((cookie) => cookie.name === "od_sid")).toBeUndefined();
    } finally {
      await phone.close();
    }

    // Back on the desktop, Verify claims the completed attempt.
    await page.getByRole("button", { name: "Verify sign-in" }).click();
    // The login page hands control back to the app once the session exists.
    await page.waitForURL((url) => !url.pathname.endsWith("/login"), { timeout: 30_000 });
    await openSettings(page);

    await expect(accountCard(page).getByText("Google only")).toBeVisible({
      timeout: 30_000,
    });
    await expect(accountCard(page).getByText("E2E Tester")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Connect YouTube Music|Waiting for Google/ }),
    ).toBeVisible({ timeout: 30_000 });

    const session = await page.request.get("/api/auth/session");
    expect(await session.json()).toMatchObject({
      authenticated: true,
      user: { email: "e2e@example.com" },
    });

    // --- Step 2: session survives a full page reload ---
    await page.reload();
    await openSettings(page);
    await expect(accountCard(page).getByText("Google only")).toBeVisible({
      timeout: 30_000,
    });
    await expect(accountCard(page).getByText("E2E Tester")).toBeVisible();

    // --- Step 3: tear down the YouTube link poll, then sign out ---
    await page.request.post("/api/youtube/cancel");
    const logout = await page.request.post("/api/auth/logout", { data: {} });
    expect(logout.ok()).toBeTruthy();

    // Signing out drops the account: the gate takes over again.
    await page.reload();
    await page.waitForURL(/\/login/, { timeout: 30_000 });
    await expect(
      page.getByRole("heading", { name: /Sign in|Set up OpenDeck/ }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('button[data-onboarding="search"]')).toHaveCount(0);
    const after = await page.request.get("/api/auth/session");
    expect(await after.json()).toMatchObject({ authenticated: false });
  });
});
