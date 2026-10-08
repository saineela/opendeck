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

function replaceOnce(src, oldStr, newStr, label) {
  const idx = src.indexOf(oldStr);
  if (idx === -1) throw new Error(`not found: ${label}`);
  if (src.indexOf(oldStr, idx + oldStr.length) !== -1) throw new Error(`not unique: ${label}`);
  return src.slice(0, idx) + newStr + src.slice(idx + oldStr.length);
}

// ---- 1. YouTubeMusicDataSource.resolveStream: attest (po-token) for every client ----
edit("./client/src/datasource/youtube/YouTubeMusicDataSource.ts", (src) => {
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const oldBlock = [
    `        const poToken = label === "download"`,
    `          ? await this.attestForTrack(yt, track.id)`,
    `          : undefined;`,
  ].join(eol);
  const newBlock = [
    `        // Every playback client now needs a po-token on the resolved URL;`,
    `        // without it googlevideo answers 403 on server-side fetches.`,
    `        const poToken = await this.attestForTrack(yt, track.id);`,
  ].join(eol);
  return replaceOnce(src, oldBlock, newBlock, "attest condition");
});

// ---- 2. poToken.ts: bootstrap the interpreter without an inline <script> tag ----
edit("./client/src/datasource/youtube/poToken.ts", (src) => {
  const eol = src.includes("\r\n") ? "\r\n" : "\n";
  const oldBlock = [
    `  const interpreterId = challenge.interpreterHash ?? "botguard-interpreter";`,
    `  if (!document.getElementById(interpreterId)) {`,
    `    const script = document.createElement("script");`,
    `    script.id = interpreterId;`,
    `    script.type = "text/javascript";`,
    `    script.textContent = interpreterJavascript;`,
    `    document.head.appendChild(script);`,
    `  }`,
  ].join(eol);
  const newBlock = [
    `  const interpreterId = challenge.interpreterHash ?? "botguard-interpreter";`,
    `  if (!interpreterLoaded.has(interpreterId)) {`,
    `    // The CSP has no 'unsafe-inline', so a <script> element would be`,
    `    // blocked. Indirect eval runs the interpreter in global scope (so its`,
    `    // top-level bindings attach to window) and is covered by`,
    `    // script-src 'unsafe-eval', which youtubei.js already requires.`,
    `    (0, globalThis.eval)(interpreterJavascript);`,
    `    interpreterLoaded.add(interpreterId);`,
    `  }`,
  ].join(eol);
  const withFlag = replaceOnce(src, oldBlock, newBlock, "interpreter bootstrap");
  const anchor = `let cached: Promise<CachedMinter> | null = null;`;
  return replaceOnce(
    withFlag,
    anchor,
    `${anchor}${eol}const interpreterLoaded = new Set<string>();`,
    "interpreterLoaded flag",
  );
});

console.log("done");
