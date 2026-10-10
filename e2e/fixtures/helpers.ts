import { expect, type Page } from "@playwright/test";

/** App instance launched WITHOUT Google credentials (see playwright.config.ts). */
export const UNCONFIGURED_ORIGIN = `http://127.0.0.1:${process.env.E2E_UNCONFIGURED_PORT ?? 4100}`;
/** Main app instance (the baseURL Playwright navigates to). */
export const APP_ORIGIN = `http://127.0.0.1:${process.env.E2E_APP_PORT ?? 4000}`;

/** localStorage key that permanently dismisses the first-run onboarding. */
export const ONBOARDING_COMPLETE_KEY = "yt-music-dock:onboarding-complete";

export const LOADING_SCREEN = '[aria-label="Loading"]';
export const SEARCH_BAR = 'button[data-onboarding="search"]';
export const SEARCH_INPUT =
  'input[aria-label="Search artists, songs, playlists, and albums"]';
export const SEARCH_RESULT_ROWS =
  'div[data-onboarding="search-results"] button[data-selectable-index]';
export const OPEN_SETTINGS = 'button[aria-label="Open settings"]';
export const ACCOUNT_SECTION = "#account-settings-title";
/** The Account card; scopes status assertions away from unrelated cards. */
export function accountCard(page: Page) {
  return page.locator('section[aria-labelledby="account-settings-title"]');
}
/** CSS-module class names are hashed; match the readable fragment. */
export const TRACK_TITLE = 'p[class*="trackTitle"]';

/**
 * Marks onboarding complete before the app boots so tests start on the
 * regular UI instead of the first-run tour.
 */
export async function skipOnboarding(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    window.localStorage.setItem(key, "true");
  }, ONBOARDING_COMPLETE_KEY);
}

export type TestAccount = { email: string; password: string; name?: string };

export const DEFAULT_ACCOUNT: TestAccount = {
  email: "e2e-user@example.com",
  password: "e2e user passphrase",
  name: "E2E User",
};

/**
 * Session cookies reused across tests within a run. Registering is capped
 * at 5/min/IP and logging in at 10/min/IP — both far below how often the
 * suite needs a session — so the first successful sign-in per account is
 * remembered and replayed (and re-validated against /api/auth/session, so
 * a logout mid-run transparently triggers a fresh sign-in).
 */
const sessionCache = new Map<string, { name: string; value: string }>();

/**
 * Ensures the browser context holds an OpenDeck session before `gotoApp`.
 *
 * The app is gated behind sign-in — an anonymous visitor only ever sees
 * /login — so every spec that needs the shell must authenticate first.
 * Signs in first (the account usually exists: the E2E data directory
 * persists between runs) and only registers when the address is unknown.
 */
export async function signIn(
  page: Page,
  account: TestAccount = DEFAULT_ACCOUNT,
  origin = APP_ORIGIN,
): Promise<void> {
  const key = `${origin}|${account.email}`;

  // Replay a session captured earlier in this run when it still holds.
  const cached = sessionCache.get(key);
  if (cached) {
    await page.context().addCookies([{ ...cached, url: origin }]);
    const session = await page.request.get(`${origin}/api/auth/session`);
    const body = (await session.json()) as { authenticated?: boolean };
    if (body.authenticated) return;
    sessionCache.delete(key);
  }

  const login = await page.request.post(`${origin}/api/auth/login`, {
    data: { email: account.email, password: account.password },
  });
  if (!login.ok()) {
    // Unknown address on a fresh instance — create it, then the session
    // cookie from the register response carries the context.
    expect(
      login.status(),
      `login as ${account.email}: ${login.status()} ${await login.text()}`,
    ).toBe(401);
    const register = await page.request.post(`${origin}/api/auth/register`, {
      data: {
        email: account.email,
        password: account.password,
        name: account.name,
      },
    });
    expect(
      register.ok(),
      `register ${account.email}: ${register.status()} ${await register.text()}`,
    ).toBeTruthy();
  }

  const cookies = await page.context().cookies(origin);
  const sid = cookies.find((c) => c.name === "od_sid");
  if (sid) sessionCache.set(key, { name: sid.name, value: sid.value });
}

/** Loads the app and waits until the boot/loading screen is gone. */
export async function gotoApp(page: Page, url = "/"): Promise<void> {
  await page.goto(url);
  await expect(page.locator(LOADING_SCREEN)).toBeHidden({ timeout: 30_000 });
}

/**
 * Opens the settings tab and waits for the Account card (default tab).
 * Idempotent: the settings view may already be active (it survives reloads).
 */
export async function openSettings(page: Page): Promise<void> {
  const account = page.locator(ACCOUNT_SECTION);
  const settingsButton = page.locator(OPEN_SETTINGS);
  if (await settingsButton.isVisible().catch(() => false)) {
    await settingsButton.click();
  } else if (!(await account.isVisible().catch(() => false))) {
    // Not on a view that exposes the settings button — return home first.
    await page.getByRole("button", { name: "Home" }).first().click();
    await settingsButton.click();
  }
  await expect(account).toBeVisible();
}

/** Runs a search from the home screen and waits for the results list. */
export async function searchFor(page: Page, query: string): Promise<void> {
  await page.locator(SEARCH_BAR).click();
  const input = page.locator(SEARCH_INPUT);
  await expect(input).toBeVisible();
  await input.fill(query);
  await input.press("Enter");
  await expect(page.locator(SEARCH_RESULT_ROWS).first()).toBeVisible({
    timeout: 45_000,
  });
}
