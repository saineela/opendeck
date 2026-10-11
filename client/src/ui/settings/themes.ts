import { useSyncExternalStore } from "react";
import matrixThemeCss from "../themes/matrix.css?raw";
import {
  getAuthSnapshot,
  refreshAuthSession,
  subscribeAuth,
  type AuthSession,
} from "../../auth/authClient";
import {
  hydrateLocalJsonSetting,
  readLocalJsonSetting,
  writeLocalJsonSetting,
} from "../../internal/durableLocalSetting";
import { logInternalWarn } from "../../internal/logging";

export type AppTheme =
  | "dark"
  | "light"
  | "glass"
  | "matrix"
  | "sakura"
  | "tokyo"
  | "ghibli"
  | "cel"
  | "sunset"
  | "ocean"
  | "nordic"
  | "custom";
export interface MatrixThemeSettings {
  rainSpeed: number;
  mediaAging: number;
}
export interface GlassThemeSettings {
  intensity: number;
}

export const APP_THEMES: Array<{ id: AppTheme; label: string }> = [
  {
    id: "light",
    label: "Daylight",
  },
  {
    id: "dark",
    label: "Midnight",
  },
  {
    id: "glass",
    label: "Prism",
  },
  {
    id: "matrix",
    label: "Terminal",
  },
  {
    id: "sakura",
    label: "Sakura",
  },
  {
    id: "tokyo",
    label: "Neon Tokyo",
  },
  {
    id: "ghibli",
    label: "Ghibli",
  },
  {
    id: "cel",
    label: "Cel Shade",
  },
  {
    id: "sunset",
    label: "Sunset",
  },
  {
    id: "ocean",
    label: "Deep Sea",
  },
  {
    id: "nordic",
    label: "Nordic",
  },
  {
    id: "custom",
    label: "Custom CSS",
  },
];


const STORAGE_KEY = "app-theme";
const CHANGE_EVENT = "app-theme-change";
const GLASS_SETTINGS_STORAGE_KEY = "glass-theme-settings";
const GLASS_SETTINGS_CHANGE_EVENT = "glass-theme-settings-change";
const MATRIX_SETTINGS_STORAGE_KEY = "matrix-theme-settings";
const MATRIX_SETTINGS_CHANGE_EVENT = "matrix-theme-settings-change";
const CUSTOM_STYLE_ID = "app-custom-theme-css";
const CUSTOM_CSS_STORAGE_KEY = "custom-theme-css";
const THEME_USERNAME_PLACEHOLDER = "%username%";
const DEFAULT_GLASS_THEME_SETTINGS: GlassThemeSettings = {
  intensity: 68,
};
const DEFAULT_MATRIX_THEME_SETTINGS: MatrixThemeSettings = {
  rainSpeed: 100,
  mediaAging: 100,
};
let glassThemeSettingsSnapshot = DEFAULT_GLASS_THEME_SETTINGS;
let matrixThemeSettingsSnapshot = DEFAULT_MATRIX_THEME_SETTINGS;
let themeUsername = "user";
let themeUsernameLoadPromise: Promise<void> | null = null;
let themeAuthUnsubscribe: (() => void) | null = null;
/**
 * The admin's instance theme, adopted when this account has not chosen its
 * own. Fetched with the session, so the sign-in page (which has no account)
 * still wears the instance's look.
 */
let instanceThemeSnapshot: AppTheme | null = null;

function isAppTheme(value: unknown): value is AppTheme {
  return value === "dark"
    || value === "light"
    || value === "glass"
    || value === "matrix"
    || value === "sakura"
    || value === "tokyo"
    || value === "ghibli"
    || value === "cel"
    || value === "sunset"
    || value === "ocean"
    || value === "nordic"
    || value === "custom";
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function isMatrixThemeSettings(value: unknown): value is MatrixThemeSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Partial<MatrixThemeSettings>;
  return typeof settings.rainSpeed === "number"
    && Number.isFinite(settings.rainSpeed)
    && typeof settings.mediaAging === "number"
    && Number.isFinite(settings.mediaAging);
}

function isGlassThemeSettings(value: unknown): value is GlassThemeSettings {
  if (!value || typeof value !== "object") return false;
  const settings = value as Partial<GlassThemeSettings>;
  return (
    typeof settings.intensity === "number"
    && Number.isFinite(settings.intensity)
  ) || (
    typeof (settings as { transparency?: unknown }).transparency === "number"
    && Number.isFinite((settings as { transparency?: number }).transparency)
  );
}

function readAppTheme(): AppTheme {
  const stored = readLocalJsonSetting(STORAGE_KEY, (value): value is AppTheme | "default" =>
    isAppTheme(value) || value === "default"
  );
  // "default" is the legacy sentinel for "no personal choice" — it now
  // resolves to the instance theme, then to light. A personal pick wins.
  if (stored === "default") return instanceThemeSnapshot ?? "light";
  return stored ?? instanceThemeSnapshot ?? "light";
}

/** Whether this account has explicitly picked a theme of its own. */
export function hasPersonalTheme(): boolean {
  const stored = readLocalJsonSetting(STORAGE_KEY, (value): value is AppTheme | "default" =>
    isAppTheme(value) || value === "default"
  );
  return stored !== null && stored !== "default";
}

/** The admin's instance theme, once the session has reported it. */
export function getInstanceTheme(): AppTheme | null {
  return instanceThemeSnapshot;
}

function normalizeGlassThemeSettings(settings: Partial<GlassThemeSettings>): GlassThemeSettings {
  const legacyTransparency = (settings as { transparency?: unknown }).transparency;
  const intensity = typeof settings.intensity === "number"
    ? settings.intensity
    : typeof legacyTransparency === "number"
      ? legacyTransparency
      : DEFAULT_GLASS_THEME_SETTINGS.intensity;

  return {
    intensity: clampNumber(
      intensity,
      DEFAULT_GLASS_THEME_SETTINGS.intensity,
      0,
      100,
    ),
  };
}

function normalizeMatrixThemeSettings(settings: Partial<MatrixThemeSettings>): MatrixThemeSettings {
  return {
    rainSpeed: clampNumber(
      settings.rainSpeed,
      DEFAULT_MATRIX_THEME_SETTINGS.rainSpeed,
      25,
      300,
    ),
    mediaAging: clampNumber(
      settings.mediaAging,
      DEFAULT_MATRIX_THEME_SETTINGS.mediaAging,
      0,
      200,
    ),
  };
}

function readGlassThemeSettings(): GlassThemeSettings {
  const stored = readLocalJsonSetting(GLASS_SETTINGS_STORAGE_KEY, isGlassThemeSettings);
  return normalizeGlassThemeSettings(stored ?? DEFAULT_GLASS_THEME_SETTINGS);
}

function readMatrixThemeSettings(): MatrixThemeSettings {
  const stored = readLocalJsonSetting(MATRIX_SETTINGS_STORAGE_KEY, isMatrixThemeSettings);
  return normalizeMatrixThemeSettings(stored ?? DEFAULT_MATRIX_THEME_SETTINGS);
}

function getGlassThemeSettingsSnapshot() {
  const nextSettings = readGlassThemeSettings();
  if (glassThemeSettingsSnapshot.intensity === nextSettings.intensity) {
    return glassThemeSettingsSnapshot;
  }

  glassThemeSettingsSnapshot = nextSettings;
  return glassThemeSettingsSnapshot;
}

function getMatrixThemeSettingsSnapshot() {
  const nextSettings = readMatrixThemeSettings();
  if (
    matrixThemeSettingsSnapshot.rainSpeed === nextSettings.rainSpeed
    && matrixThemeSettingsSnapshot.mediaAging === nextSettings.mediaAging
  ) {
    return matrixThemeSettingsSnapshot;
  }

  matrixThemeSettingsSnapshot = nextSettings;
  return matrixThemeSettingsSnapshot;
}

function getCustomStyleElement(): HTMLStyleElement {
  const existing = document.getElementById(CUSTOM_STYLE_ID);
  if (existing instanceof HTMLStyleElement) return existing;

  const style = document.createElement("style");
  style.id = CUSTOM_STYLE_ID;
  style.setAttribute("data-app-custom-theme", "true");
  document.head.append(style);
  return style;
}

function sanitizeThemeUsername(username: unknown) {
  if (typeof username !== "string") return "user";
  const sanitized = Array.from(username.trim())
    .filter((character) => /[a-zA-Z0-9._-]/.test(character))
    .join("");

  return sanitized || "user";
}

function renderThemeCss(css: string) {
  return css.split(THEME_USERNAME_PLACEHOLDER).join(themeUsername);
}

function isCustomCss(value: unknown): value is string {
  return typeof value === "string";
}

function syncThemeFromSession(session: AuthSession): void {
  const nextUsername = session.authenticated
    ? sanitizeThemeUsername(session.user?.name ?? "user")
    : "user";
  const usernameChanged = themeUsername !== nextUsername;
  if (usernameChanged) themeUsername = nextUsername;

  // A signed-out placeholder (e.g. after logout) has no instance theme in
  // memory. Preserve the last server-provided default in that case so /login
  // keeps its theme; authenticated sessions can explicitly clear it.
  const hasInstanceThemeValue = session.instanceTheme !== null || session.authenticated;
  const nextInstanceTheme = isAppTheme(session.instanceTheme)
    ? session.instanceTheme
    : null;
  const instanceChanged = hasInstanceThemeValue && instanceThemeSnapshot !== nextInstanceTheme;
  if (instanceChanged) instanceThemeSnapshot = nextInstanceTheme;

  if (usernameChanged || instanceChanged) {
    applyAppTheme();
    dispatchAppThemeChange();
  }
}

function hydrateThemeUsername() {
  if (!themeAuthUnsubscribe) {
    themeAuthUnsubscribe = subscribeAuth(() => syncThemeFromSession(getAuthSnapshot()));
  }
  if (themeUsernameLoadPromise) return;

  // Keep both username-dependent custom CSS and the instance default in sync
  // with later session refreshes, not just the first app boot.
  themeUsernameLoadPromise = refreshAuthSession()
    .then(syncThemeFromSession)
    .catch((error) => {
      logInternalWarn("theme username load failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

function setCustomThemeCss(css: string) {
  const style = getCustomStyleElement();
  style.textContent = renderThemeCss(css);
  document.head.append(style);
}

function applyThemeAttribute(theme: AppTheme) {
  document.documentElement.dataset.appTheme = theme;
}

function applyGlassThemeSettings(settings = readGlassThemeSettings()) {
  const intensity = settings.intensity / 100;
  document.documentElement.style.setProperty(
    "--glass-intensity",
    intensity.toFixed(2),
  );
  document.documentElement.style.setProperty(
    "--glass-bg-alpha",
    (0.58 + intensity * 0.14).toFixed(2),
  );
  document.documentElement.style.setProperty(
    "--glass-elevated-alpha",
    (0.64 + intensity * 0.16).toFixed(2),
  );
  document.documentElement.style.setProperty(
    "--glass-overlay-alpha",
    (0.70 + intensity * 0.14).toFixed(2),
  );
  document.documentElement.style.setProperty(
    "--glass-window-alpha",
    (0.52 + intensity * 0.16).toFixed(2),
  );
  document.documentElement.style.setProperty(
    "--glass-panel-alpha",
    (0.60 + intensity * 0.18).toFixed(2),
  );
  document.documentElement.style.setProperty(
    "--glass-player-alpha",
    (0.62 + intensity * 0.16).toFixed(2),
  );
  document.documentElement.style.setProperty(
    "--glass-backdrop-alpha",
    (0.72 + intensity * 0.12).toFixed(2),
  );
  document.documentElement.style.setProperty(
    "--glass-scene-alpha",
    (0.66 + intensity * 0.16).toFixed(2),
  );
  document.documentElement.style.setProperty(
    "--glass-gloss-alpha",
    (0.40 + intensity * 0.46).toFixed(2),
  );
}

function applyMatrixThemeSettings(settings = readMatrixThemeSettings()) {
  const rainDurationScale = 100 / settings.rainSpeed;
  document.documentElement.style.setProperty(
    "--matrix-rain-duration-scale",
    rainDurationScale.toFixed(3),
  );
  document.documentElement.style.setProperty(
    "--matrix-media-aging",
    (settings.mediaAging / 100).toFixed(2),
  );
}

export function subscribeToAppTheme(callback: () => void) {
  window.addEventListener(CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function subscribeToMatrixThemeSettings(callback: () => void) {
  window.addEventListener(MATRIX_SETTINGS_CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(MATRIX_SETTINGS_CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function subscribeToGlassThemeSettings(callback: () => void) {
  window.addEventListener(GLASS_SETTINGS_CHANGE_EVENT, callback);
  window.addEventListener("storage", callback);

  return () => {
    window.removeEventListener(GLASS_SETTINGS_CHANGE_EVENT, callback);
    window.removeEventListener("storage", callback);
  };
}

export function getAppTheme() {
  return readAppTheme();
}

export function useAppTheme() {
  return useSyncExternalStore(subscribeToAppTheme, readAppTheme, () => "light");
}

export function useMatrixThemeSettings() {
  return useSyncExternalStore(
    subscribeToMatrixThemeSettings,
    getMatrixThemeSettingsSnapshot,
    () => DEFAULT_MATRIX_THEME_SETTINGS,
  );
}

export function useGlassThemeSettings() {
  return useSyncExternalStore(
    subscribeToGlassThemeSettings,
    getGlassThemeSettingsSnapshot,
    () => DEFAULT_GLASS_THEME_SETTINGS,
  );
}

export function dispatchAppThemeChange() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function applyAppTheme(theme = readAppTheme()) {
  hydrateThemeUsername();
  applyThemeAttribute(theme);
  applyGlassThemeSettings();
  applyMatrixThemeSettings();

  if (theme === "matrix") {
    setCustomThemeCss(matrixThemeCss);
    return;
  }

  if (theme !== "custom") {
    setCustomThemeCss("");
    return;
  }

  try {
    const css = readLocalJsonSetting<string>(CUSTOM_CSS_STORAGE_KEY, isCustomCss);
    setCustomThemeCss(css ?? "");
  } catch (error) {
    logInternalWarn("custom theme load failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    setCustomThemeCss("");
  }
}

export async function hydrateAppTheme() {
  await Promise.all([
    hydrateLocalJsonSetting(STORAGE_KEY, isAppTheme),
    hydrateLocalJsonSetting(GLASS_SETTINGS_STORAGE_KEY, isGlassThemeSettings),
    hydrateLocalJsonSetting(MATRIX_SETTINGS_STORAGE_KEY, isMatrixThemeSettings),
    hydrateLocalJsonSetting(CUSTOM_CSS_STORAGE_KEY, isCustomCss),
  ]);
  applyAppTheme();
  dispatchAppThemeChange();
  window.dispatchEvent(new Event(GLASS_SETTINGS_CHANGE_EVENT));
  window.dispatchEvent(new Event(MATRIX_SETTINGS_CHANGE_EVENT));
}

export function setAppTheme(theme: AppTheme) {
  applyAppTheme(theme);
  writeLocalJsonSetting(STORAGE_KEY, theme);
  dispatchAppThemeChange();
}

/**
 * Drop the personal pick so the instance theme applies to this account —
 * the "use what the admin set" escape hatch next to the theme grid.
 */
export function clearPersonalTheme() {
  writeLocalJsonSetting(STORAGE_KEY, "default");
  applyAppTheme();
  dispatchAppThemeChange();
}

export function setMatrixThemeSettings(settings: Partial<MatrixThemeSettings>) {
  const nextSettings = normalizeMatrixThemeSettings({
    ...readMatrixThemeSettings(),
    ...settings,
  });
  matrixThemeSettingsSnapshot = nextSettings;
  applyMatrixThemeSettings(nextSettings);
  writeLocalJsonSetting(MATRIX_SETTINGS_STORAGE_KEY, nextSettings);
  window.dispatchEvent(new Event(MATRIX_SETTINGS_CHANGE_EVENT));
}

export function setGlassThemeSettings(settings: Partial<GlassThemeSettings>) {
  const nextSettings = normalizeGlassThemeSettings({
    ...readGlassThemeSettings(),
    ...settings,
  });
  glassThemeSettingsSnapshot = nextSettings;
  applyGlassThemeSettings(nextSettings);
  writeLocalJsonSetting(GLASS_SETTINGS_STORAGE_KEY, nextSettings);
  window.dispatchEvent(new Event(GLASS_SETTINGS_CHANGE_EVENT));
}

export async function importCustomThemeCss(css: string) {
  writeLocalJsonSetting(CUSTOM_CSS_STORAGE_KEY, css);
  setCustomThemeCss(css);
  setAppTheme("custom");
}

export function getImportedCustomThemeCss(): string {
  return readLocalJsonSetting<string>(CUSTOM_CSS_STORAGE_KEY, isCustomCss) ?? "";
}
