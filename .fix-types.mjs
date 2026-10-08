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

function count(src, needle) {
  let n = 0;
  let idx = src.indexOf(needle);
  while (idx !== -1) {
    n += 1;
    idx = src.indexOf(needle, idx + needle.length);
  }
  return n;
}

function dropLine(src, line, label) {
  const idx = src.indexOf(line);
  if (idx === -1) throw new Error(`line not found: ${label}`);
  if (count(src, line) !== 1) throw new Error(`line not unique: ${label}`);
  const end = idx + line.length;
  const nl = src.startsWith("\r\n", end) ? 2 : 1;
  return src.slice(0, idx) + src.slice(end + nl);
}

// 1. YouTubeMusicDataSource.ts: import unlinkYouTube
edit("./client/src/datasource/youtube/YouTubeMusicDataSource.ts", (src) => {
  const nl = src.includes("\r\n") ? "\r\n" : "\n";
  const anchor = `${nl}} from "../../auth/authClient";`;
  if (count(src, anchor) !== 1) throw new Error("authClient import end not unique");
  const at = src.indexOf(anchor);
  return src.slice(0, at) + `  unlinkYouTube,${nl}` + src.slice(at);
});

// 2. DiscordRPC.ts: drop unused static field + assignment
edit("./client/src/player/DiscordRPC.ts", (src) => {
  src = dropLine(src, "  private static isEnabled = false;", "isEnabled field");
  src = dropLine(src, "    this.isEnabled = false;", "isEnabled assign");
  return src;
});

// 3. localFiles.ts: declare showDirectoryPicker on window (WICG File System Access API)
edit("./client/src/player/localFiles.ts", (src) => {
  const decl = [
    "",
    "declare global {",
    "  interface Window {",
    "    showDirectoryPicker(options?: {",
    '      mode?: "read" | "readwrite";',
    "    }): Promise<FileSystemDirectoryHandle>;",
    "  }",
    "}",
    "",
  ].join("\n");
  return src + decl;
});

// 4. downloaderStore.ts: drop write-only progressStarted
edit("./client/src/plugins/official/downloader/downloaderStore.ts", (src) => {
  src = dropLine(src, "let progressStarted = false;", "progressStarted decl");
  src = dropLine(src, "  progressStarted = true;", "progressStarted assign");
  return src;
});

// 5. SettingsPage.tsx: unused setDownloadPath import + auth.session.error -> auth.error
edit("./client/src/ui/pages/SettingsPage.tsx", (src) => {
  src = dropLine(src, "  setDownloadPath,", "setDownloadPath import");
  const n = count(src, "auth.session.error");
  if (n !== 2) throw new Error(`expected 2 auth.session.error, got ${n}`);
  src = src.split("auth.session.error").join("auth.error");
  return src;
});

console.log("done");
