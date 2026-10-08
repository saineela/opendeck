import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("./client/src/internal/appSettings.ts", import.meta.url);
let src = readFileSync(file, "utf8");
const EOL = "\r\n";

function replaceOnce(oldStr, newStr, label) {
  const idx = src.indexOf(oldStr);
  if (idx === -1) throw new Error(`not found: ${label}`);
  if (src.indexOf(oldStr, idx + oldStr.length) !== -1) throw new Error(`not unique: ${label}`);
  src = src.slice(0, idx) + newStr + src.slice(idx + oldStr.length);
}

// A. Ready promise declaration after remoteState.
replaceOnce(
  `let remoteState: "unknown" | "enabled" | "disabled" = "unknown";`,
  [
    `let remoteState: "unknown" | "enabled" | "disabled" = "unknown";`,
    ``,
    `/** Resolved the first time the auth session probe reports a verdict. */`,
    `let readyResolve: (() => void) | null = null;`,
    `const remoteReady = new Promise<void>((resolve) => {`,
    `  readyResolve = resolve;`,
    `});`,
    `let readySettled = false;`,
  ].join(EOL),
  "remoteState declaration",
);

// B. Settle ready when the verdict arrives.
replaceOnce(
  `export function setSettingsRemoteAvailability(authenticated: boolean): void {`,
  [
    `export function setSettingsRemoteAvailability(authenticated: boolean): void {`,
    `  remoteState = authenticated ? "enabled" : "disabled";`,
    `  if (!readySettled) {`,
    `    readySettled = true;`,
    `    readyResolve?.();`,
    `  }`,
    `}`,
    ``,
    `/** Wait (bounded) for the first auth verdict so mount does not race it. */`,
    `async function waitForAuthVerdict(): Promise<void> {`,
    `  if (readySettled) return;`,
    `  await Promise.race([`,
    `    remoteReady,`,
    `    new Promise((resolve) => setTimeout(resolve, 3000)),`,
    `  ]);`,
    `}`,
  ].join(EOL),
  "setSettingsRemoteAvailability declaration",
);

// Remove the now-duplicated old body line + closing brace that followed the
// inserted helpers (the signature line replacement left them behind).
replaceOnce(
  `  remoteState = authenticated ? "enabled" : "disabled";${EOL}}${EOL}async function postSettings`,
  `async function postSettings`,
  "old setter body",
);

// C. postSettings waits for the verdict before fetching.
replaceOnce(
  `  if (remoteState === "disabled") return null;${EOL}  try {`,
  [
    `  if (remoteState === "disabled") return null;`,
    `  await waitForAuthVerdict();`,
    `  if (remoteState === "disabled") return null;`,
    `  try {`,
  ].join(EOL),
  "postSettings guard",
);

// D. clearAppSettings gets the same guard.
replaceOnce(
  `export async function clearAppSettings(): Promise<void> {${EOL}  const response = await fetch("/api/settings/clear", {`,
  [
    `export async function clearAppSettings(): Promise<void> {`,
    `  if (remoteState === "disabled") return;`,
    `  await waitForAuthVerdict();`,
    `  if (remoteState === "disabled") return;`,
    `  const response = await fetch("/api/settings/clear", {`,
  ].join(EOL),
  "clearAppSettings guard",
);

writeFileSync(file, src);
console.log("done");
