import { readFileSync, writeFileSync } from "node:fs";

function edit(rel, fn) {
  const url = new URL(rel, import.meta.url);
  let src = readFileSync(url, "utf8");
  const before = src;
  src = fn(src);
  if (src === before) throw new Error(`no change: ${rel}`);
  writeFileSync(url, src);
  console.log(`ok: ${rel}`);
}

function once(src, needle, label) {
  const idx = src.indexOf(needle);
  if (idx === -1) throw new Error(`not found: ${label}`);
  if (src.indexOf(needle, idx + needle.length) !== -1) throw new Error(`not unique: ${label}`);
  return idx;
}

// ---- A. appSettings.ts: track remote availability, skip when known signed-out ----
edit("./client/src/internal/appSettings.ts", (src) => {
  const eol = src.includes("\r\n") ? "\r\n" : "\n";

  const headerAnchor = "async function postSettings<T>(";
  once(src, headerAnchor, "postSettings declaration");
  const guard = [
    "/**",
    " * Remote durability only exists for signed-in users. Once the server tells",
    " * us we are signed out (401) we stop calling it until the auth state says",
    " * otherwise, so boot does not spray expected 401s through the console.",
    " */",
    "let remoteState: \"unknown\" | \"enabled\" | \"disabled\" = \"unknown\";",
    "",
    "export function setSettingsRemoteAvailability(authenticated: boolean): void {",
    "  remoteState = authenticated ? \"enabled\" : \"disabled\";",
    "}",
    "",
  ].join(eol);
  src = src.slice(0, src.indexOf(headerAnchor)) + guard + src.slice(src.indexOf(headerAnchor));

  const skipAnchor = "  try {\r\n    const response = await fetch(`/api/settings/${path}`,".replace(
    /\r\n/g,
    eol,
  );
  once(src, skipAnchor, "postSettings fetch");
  src = src.replace(
    skipAnchor,
    `  if (remoteState === \"disabled\") return null;${eol}  try {${eol}    const response = await fetch(\`/api/settings/\${path}\`,`,
  );

  const unauthorized = "    if (response.status === 401) {".replace(/\r\n/g, eol);
  once(src, unauthorized, "401 branch");
  src = src.replace(
    unauthorized,
    `    if (response.status === 401) {${eol}      remoteState = \"disabled\";`,
  );

  const success = "    return (await response.json()) as T;".replace(/\r\n/g, eol);
  once(src, success, "success return");
  src = src.replace(
    success,
    `    remoteState = \"enabled\";${eol}    return (await response.json()) as T;`,
  );

  return src;
});

// ---- B. authClient.ts: feed auth state to appSettings; guard YouTube status ----
edit("./client/src/auth/authClient.ts", (src) => {
  const eol = src.includes("\r\n") ? "\r\n" : "\n";

  const importAnchor = `import { logInternalWarn } from "../internal/logging";`;
  once(src, importAnchor, "logging import");
  src = src.replace(
    importAnchor,
    `${importAnchor}${eol}import { setSettingsRemoteAvailability } from "../internal/appSettings";`,
  );

  const statusAnchor = `    status = session.authenticated ? "signed-in" : "signed-out";`;
  once(src, statusAnchor, "status assignment");
  src = src.replace(
    statusAnchor,
    `${statusAnchor}${eol}    setSettingsRemoteAvailability(session.authenticated);`,
  );

  const flagAnchor = "export async function refreshYouTubeLinkedFlag(): Promise<void> {";
  once(src, flagAnchor, "refreshYouTubeLinkedFlag");
  src = src.replace(
    flagAnchor,
    `${flagAnchor}${eol}  // The endpoint requires a session; skip it entirely while signed out.${eol}  if (!session.authenticated) return;`,
  );

  return src;
});

// ---- C. LastFm.ts: only ask for the Last.fm session when signed in ----
edit("./client/src/player/LastFm.ts", (src) => {
  const eol = src.includes("\r\n") ? "\r\n" : "\n";

  const anchor = "  static async getSession(): Promise<LastFmSessionStatus | null> {";
  once(src, anchor, "getSession declaration");
  src = src.replace(
    anchor,
    `${anchor}${eol}    if (getAuthStatusSnapshot() !== "signed-in") {${eol}      this.sessionChecked = true;${eol}      this.hasSession = false;${eol}      return null;${eol}    }`,
  );

  // Add the import after the first import line.
  const firstImportEnd = src.indexOf(eol);
  const importLine = `import { getAuthStatusSnapshot } from "../auth/authClient";`;
  if (!src.includes(importLine)) {
    src = src.slice(0, firstImportEnd + eol.length) + importLine + eol + src.slice(firstImportEnd + eol.length);
  }

  return src;
});

console.log("done");
