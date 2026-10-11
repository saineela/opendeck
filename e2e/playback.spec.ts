import { expect, test } from "@playwright/test";
import {
  SEARCH_RESULT_ROWS,
  TRACK_TITLE,
  gotoApp,
  searchFor,
  signIn,
  skipOnboarding,
} from "./fixtures/helpers";

test.describe("search and playback", () => {
  test("searches, streams a track through the media API, and toggles the queue", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await skipOnboarding(page);
    // The app is gated: authenticate before the shell loads. Search and
    // streaming still run against anonymous InnerTube through the proxy.
    await signIn(page);
    await gotoApp(page);

    // --- Search ---
    await searchFor(page, "believer imagine dragons");
    await expect(page.locator("h1").first()).toContainText("believer");

    // --- Play the first result; the stream must come from our API ---
    const streamPromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/media/stream") &&
        response.status() < 400,
      { timeout: 90_000 },
    );
    await page.locator(SEARCH_RESULT_ROWS).first().click();
    const streamResponse = await streamPromise;
    expect(streamResponse.ok()).toBeTruthy();

    // --- Player state ---
    const title = page.locator(TRACK_TITLE).first();
    await expect(title).toBeVisible({ timeout: 60_000 });
    expect((await title.innerText()).trim().length).toBeGreaterThan(0);

    await expect(page.locator('button[aria-label="Pause"]')).toBeVisible({
      timeout: 90_000,
    });

    // --- Seek position advances in real time while audio plays ---
    const seek = page.locator('input[aria-label="Seek"]');
    await expect(seek).toBeEnabled({ timeout: 30_000 });
    const startPosition = Number(await seek.inputValue());
    await expect
      .poll(async () => Number(await seek.inputValue()), {
        timeout: 60_000,
        intervals: [1_000],
      })
      .toBeGreaterThan(startPosition);

    // --- Pause / resume ---
    await page.locator('button[aria-label="Pause"]').click();
    await expect(page.locator('button[aria-label="Play"]')).toBeVisible();
    await page.locator('button[aria-label="Play"]').click();
    await expect(page.locator('button[aria-label="Pause"]')).toBeVisible();

    // --- Queue panel opens and closes ---
    await page.locator('button[aria-label="Open queue"]').click();
    const closePanel = page.locator('button[aria-label="Close queue panel"]');
    await expect(closePanel).toBeVisible();
    await page.locator('button[aria-label="Close queue"]').click();
    await expect(closePanel).toBeHidden();
  });
});
