import { expect, test } from "@playwright/test";
import {
  UNCONFIGURED_ORIGIN,
  accountCard,
  gotoApp,
  openSettings,
  signIn,
  skipOnboarding,
} from "./fixtures/helpers";

test.describe("sign-in gate", () => {
  test("anonymous visitors only ever see the login page", async ({ page }) => {
    await page.goto("/");

    // The URL normalises to /login and the branded page renders.
    await page.waitForURL(/\/login/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible({
      timeout: 30_000,
    });
    // No escape hatch: the app shell must not be reachable while signed out.
    await expect(page.locator('button[data-onboarding="search"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Back to the app" })).toHaveCount(0);
    // Deep links are gated too — they cannot smuggle the shell onto screen.
    await page.goto("/some/deep/client/route");
    await page.waitForURL(/\/login/, { timeout: 30_000 });
    await expect(page.locator('button[data-onboarding="search"]')).toHaveCount(0);
  });
});

test.describe("app shell", () => {
  test("boots to the home screen with the search bar", async ({ page }) => {
    await skipOnboarding(page);
    await signIn(page);
    await gotoApp(page);

    await expect(page.locator('button[data-onboarding="search"]')).toBeVisible();
    await expect(page.locator('button[aria-label="Open settings"]')).toBeVisible();
    // Onboarding overlays must not appear for a completed setup.
    await expect(page.locator('[aria-label="Welcome"]')).toBeHidden();
    await expect(page.locator('[aria-label="Skip onboarding"]')).toBeHidden();
  });

  test("serves the SPA and health check from the production server", async ({
    page,
  }) => {
    const health = await page.request.get("/healthz");
    expect(health.ok()).toBeTruthy();
    expect(await health.json()).toMatchObject({ ok: true });

    await skipOnboarding(page);
    await signIn(page);
    await page.goto("/some/deep/client/route");
    // The server falls back to index.html for client routes.
    await expect(page.locator('button[data-onboarding="search"]')).toBeVisible({
      timeout: 30_000,
    });
  });
});

test.describe("first-run onboarding", () => {
  test("welcomes a new account and can be skipped", async ({ page }) => {
    // No skipOnboarding() here: this test exercises the real post-sign-in
    // flow. A fresh account has no durable onboarding flag, so the welcome
    // tour appears once the gated shell loads.
    await signIn(page, {
      email: `e2e-onboarding-${Date.now()}@example.com`,
      password: "onboarding passphrase",
      name: "E2E Onboarding",
    });
    await gotoApp(page);

    await expect(page.locator('[aria-label="Welcome"]')).toBeVisible({
      timeout: 30_000,
    });
    const skip = page.locator('[aria-label="Skip onboarding"]');
    await expect(skip).toBeVisible({ timeout: 30_000 });
    await skip.click();
    await expect(skip).toBeHidden();

    const stored = await page.evaluate(
      (key) => window.localStorage.getItem(key),
      "yt-music-dock:onboarding-complete",
    );
    expect(stored).toBe("true");
  });
});

test.describe("settings", () => {
  test("opens the Account section and switches tabs", async ({ page }) => {
    await skipOnboarding(page);
    await signIn(page);
    await gotoApp(page);
    await openSettings(page);

    // Signed in through the gate: the Account card reflects the session.
    await expect(
      accountCard(page).getByText("Signed in", { exact: true }),
    ).toBeVisible();
    await expect(accountCard(page).getByText("E2E User")).toBeVisible();

    const systemTab = page.getByRole("tab", { name: "System" });
    await systemTab.click();
    await expect(systemTab).toHaveAttribute("aria-selected", "true");

    const styleTab = page.getByRole("tab", { name: "Style" });
    await styleTab.click();
    await expect(styleTab).toHaveAttribute("aria-selected", "true");

    const aboutTab = page.getByRole("tab", { name: "About" });
    await aboutTab.click();
    await expect(page.locator("#account-settings-title")).toBeVisible();
  });
});

test.describe("unconfigured Google Sign-In", () => {
  test("omits the provider option and fails gracefully instead of crashing", async ({
    page,
  }) => {
    await skipOnboarding(page);
    // Second server instance launched WITHOUT Google credentials.
    await gotoApp(page, `${UNCONFIGURED_ORIGIN}/`);

    // The gate still applies: signed out lands on the login page, which
    // must not offer the unconfigured provider.
    await page.waitForURL(/\/login/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: /Sign in|Set up OpenDeck/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      page.getByRole("button", { name: /Google/ }),
    ).toHaveCount(0);
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible();

    // The start endpoint itself still answers 503 with actionable guidance.
    const start = await page.request.get(
      `${UNCONFIGURED_ORIGIN}/api/auth/google/start`,
    );
    expect(start.status()).toBe(503);
    expect((await start.json()).error).toContain("not configured");

    // Password sign-in through the gate still reaches the app — against
    // THIS instance (signIn defaults to the main origin).
    await signIn(
      page,
      {
        email: "e2e-unconfigured@example.com",
        password: "unconfigured passphrase",
        name: "E2E Unconfigured",
      },
      UNCONFIGURED_ORIGIN,
    );
    await gotoApp(page, `${UNCONFIGURED_ORIGIN}/`);
    await expect(page.locator('button[data-onboarding="search"]')).toBeVisible({
      timeout: 30_000,
    });
  });
});
