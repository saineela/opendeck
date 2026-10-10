import { expect, test } from "@playwright/test";
import { gotoApp, openSettings, signIn, skipOnboarding } from "./fixtures/helpers";

/**
 * Admin panel flow.
 *
 * `ADMIN_EMAILS=e2e-admin@example.com` is set on the app under test, so this
 * account carries the admin role no matter how many users earlier runs
 * created — the Admin tab must appear for it and only for it.
 */
const ADMIN_EMAIL = "e2e-admin@example.com";
const ADMIN_PASSWORD = "e2e admin passphrase";
const ADMIN_NAME = "E2E Admin";

function ensureSignedIn(page: import("@playwright/test").Page): Promise<void> {
  return signIn(page, {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    name: ADMIN_NAME,
  });
}

test.describe("admin panel", () => {
  test("shows the Admin tab to admins and lets them create a user", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await skipOnboarding(page);
    await ensureSignedIn(page);

    await gotoApp(page);
    await openSettings(page);

    // Role-gated navigation: the Admin tab exists for this account.
    const adminTab = page.getByRole("tab", { name: "Admin" });
    await expect(adminTab).toBeVisible();
    await adminTab.click();

    // Overview + users render from /api/admin/*.
    await expect(
      page.getByRole("region", { name: "Instance overview" }),
    ).toBeVisible();
    await expect(page.getByRole("region", { name: "Users" })).toBeVisible();
    await expect(page.getByText(ADMIN_EMAIL)).toBeVisible();

    // Create an account through the panel.
    const createdEmail = `e2e-created-${Date.now()}@example.com`;
    await page.getByLabel("New user email").fill(createdEmail);
    await page.getByLabel("New user password").fill("created account password");
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText(createdEmail)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Account created.")).toBeVisible();

    // The new account is a regular user with a working login.
    const login = await page.request.post("/api/auth/login", {
      data: { email: createdEmail, password: "created account password" },
    });
    expect(login.ok()).toBeTruthy();
    const who = await page.request.get("/api/auth/session");
    expect(await who.json()).toMatchObject({ authenticated: true });

    // Sign the admin back out so later tests see a clean session state.
    await page.request.post("/api/auth/logout", { data: {} });
  });

  test("closes and reopens self-service account creation", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await skipOnboarding(page);
    await ensureSignedIn(page);
    await gotoApp(page);
    await openSettings(page);
    await page.getByRole("tab", { name: "Admin" }).click();

    // Close sign-up through the Account creation switch. The checkbox is a
    // visually-hidden input inside its label, so click the label text.
    const creationCard = page.locator('section[aria-labelledby="admin-registration-title"]');
    await expect(creationCard).toBeVisible();
    const toggle = creationCard.locator('input[type="checkbox"]');
    if (await toggle.isChecked()) {
      await creationCard.getByText("Allow self-service sign-up").click();
    }
    await expect(creationCard.getByText("Closed", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    // A signed-out visitor no longer sees the "Create an account" option.
    await page.request.post("/api/auth/logout", { data: {} });
    await page.reload();
    await page.waitForURL(/\/login/, { timeout: 30_000 });
    await expect(page.getByText("Create an account")).toHaveCount(0);
    const session = (await (await page.request.get("/api/auth/session")).json()) as {
      registrationEnabled: boolean;
    };
    expect(session.registrationEnabled).toBe(false);

    // Reopen it so the instance is left as it was found.
    await ensureSignedIn(page);
    await gotoApp(page);
    await openSettings(page);
    await page.getByRole("tab", { name: "Admin" }).click();
    const reopenToggle = creationCard.locator('input[type="checkbox"]');
    if (!(await reopenToggle.isChecked())) {
      await creationCard.getByText("Allow self-service sign-up").click();
    }
    await expect(creationCard.getByText("Open", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await page.request.post("/api/auth/logout", { data: {} });
  });

  test("hides the Admin tab from regular accounts", async ({ page }) => {
    test.setTimeout(120_000);
    await skipOnboarding(page);

    const createdEmail = `e2e-plain-${Date.now()}@example.com`;
    const register = await page.request.post("/api/auth/register", {
      data: { email: createdEmail, password: "plain account password" },
    });
    // First account on a brand-new instance would be admin; the admin spec
    // runs first, so this account must be a regular user. If the instance
    // somehow has no other accounts, registration makes it admin — skip.
    const session = (await (await page.request.get("/api/auth/session")).json()) as {
      role: string | null;
    };
    test.skip(session.role !== "user", "account is not a regular user");

    expect(register.ok()).toBeTruthy();
    await gotoApp(page);
    await openSettings(page);
    await expect(page.getByRole("tab", { name: "Admin" })).toHaveCount(0);

    await page.request.post("/api/auth/logout", { data: {} });
  });
});
