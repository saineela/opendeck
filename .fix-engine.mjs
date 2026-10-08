import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("./client/src/player/AudioEngine.ts", import.meta.url);
let src = readFileSync(file, "utf8");
const EOL = "\r\n";

function replaceOnce(oldStr, newStr, label) {
  const idx = src.indexOf(oldStr);
  if (idx === -1) throw new Error(`not found: ${label}`);
  if (src.indexOf(oldStr, idx + oldStr.length) !== -1) throw new Error(`not unique: ${label}`);
  src = src.slice(0, idx) + newStr + src.slice(idx + oldStr.length);
}

// Clear the stale video id when native loading fails or times out; otherwise
// the next loadTrack() short-circuits on `currentVideoId === videoId` and
// never cues the video, so player errors escape the controller's fallback.
replaceOnce(
  [
    `      const timeoutId = window.setTimeout(() => {`,
    `        cleanup();`,
    `        reject(new Error("Timed out while loading native audio."));`,
    `      }, 30_000);`,
  ].join(EOL),
  [
    `      const timeoutId = window.setTimeout(() => {`,
    `        cleanup();`,
    `        if (requestId === this.loadRequestId && this.currentVideoId === videoId) {`,
    `          this.currentVideoId = null;`,
    `        }`,
    `        reject(new Error("Timed out while loading native audio."));`,
    `      }, 30_000);`,
  ].join(EOL),
  "timeout reset",
);

replaceOnce(
  [
    `      const handleError = () => {`,
    `        cleanup();`,
    `        reject(new Error(\`Unable to decode native audio (\${audio.error?.code ?? "unknown"}).\`));`,
    `      };`,
  ].join(EOL),
  [
    `      const handleError = () => {`,
    `        cleanup();`,
    `        if (requestId === this.loadRequestId && this.currentVideoId === videoId) {`,
    `          this.currentVideoId = null;`,
    `        }`,
    `        reject(new Error(\`Unable to decode native audio (\${audio.error?.code ?? "unknown"}).\`));`,
    `      };`,
  ].join(EOL),
  "error reset",
);

writeFileSync(file, src);
console.log("done");
