import { defineConfig, devices } from "@playwright/test";

/**
 * E2E topology:
 *  - :4310 fake Google OIDC provider (discovery/JWKS/authorize/token, PKCE)
 *  - :4000 main app, Google sign-in configured against the fake provider
 *  - :4100 second app instance with NO Google credentials (graceful-503 tests)
 *
 * Both app instances serve the production client build from client/dist.
 */
const FAKE_GOOGLE_PORT = Number(process.env.E2E_FAKE_GOOGLE_PORT ?? 4310);
const APP_PORT = Number(process.env.E2E_APP_PORT ?? 4000);
const UNCONFIGURED_PORT = Number(process.env.E2E_UNCONFIGURED_PORT ?? 4100);

const FAKE_GOOGLE_ORIGIN = `http://127.0.0.1:${FAKE_GOOGLE_PORT}`;
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`;
const UNCONFIGURED_ORIGIN = `http://127.0.0.1:${UNCONFIGURED_PORT}`;

/** Shared between the fake provider and the app under test. */
const E2E_GOOGLE_CLIENT_ID = "e2e-client-id";
const E2E_GOOGLE_CLIENT_SECRET = "e2e-client-secret";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [["list"]],
  use: {
    baseURL: APP_ORIGIN,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "off",
    launchOptions: {
      // Playback must actually start in headless Chromium.
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "npx tsx e2e/fixtures/fake-google.ts",
      url: `${FAKE_GOOGLE_ORIGIN}/.well-known/openid-configuration`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(FAKE_GOOGLE_PORT),
        E2E_GOOGLE_CLIENT_ID,
      },
    },
    {
      command: "npx tsx server/src/index.ts",
      url: `${APP_ORIGIN}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(APP_PORT),
        APP_URL: APP_ORIGIN,
        DATA_DIR: ".data-e2e",
        APP_SECRET: "e2e-app-secret-e2e-app-secret-e2e-app-secret",
        GOOGLE_CLIENT_ID: E2E_GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: E2E_GOOGLE_CLIENT_SECRET,
        GOOGLE_OPENID_DISCOVERY: `${FAKE_GOOGLE_ORIGIN}/.well-known/openid-configuration`,
        // Grants the admin role to this address regardless of creation order
        // so the admin-panel spec is deterministic across runs.
        ADMIN_EMAILS: "e2e-admin@example.com",
      },
    },
    {
      command: "npx tsx server/src/index.ts",
      url: `${UNCONFIGURED_ORIGIN}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(UNCONFIGURED_PORT),
        APP_URL: UNCONFIGURED_ORIGIN,
        DATA_DIR: ".data-e2e-unconfigured",
        APP_SECRET: "e2e-unconfigured-secret-e2e-unconfigured-secret",
        // No GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET → sign-in must 503 gracefully.
      },
    },
  ],
});

export { APP_ORIGIN, UNCONFIGURED_ORIGIN };
