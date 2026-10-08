import { readFileSync, writeFileSync } from "node:fs";

const file = new URL("./client/src/player/PlayerController.ts", import.meta.url);
let src = readFileSync(file, "utf8");
const EOL = "\r\n";

const oldBlock = [
  `      } else {`,
  `        await this.audioEngine.loadTrack(`,
  `          track.id,`,
  `          audioData?.bytes,`,
  `          audioData?.mimeType,`,
  `          audioData?.sourceUrl,`,
  `        );`,
  `      }`,
].join(EOL);

const newBlock = [
  `      } else {`,
  `        try {`,
  `          await this.audioEngine.loadTrack(`,
  `            track.id,`,
  `            audioData?.bytes,`,
  `            audioData?.mimeType,`,
  `            audioData?.sourceUrl,`,
  `          );`,
  `        } catch (iframeError) {`,
  `          // The embedded player refuses videos whose owner disabled`,
  `          // embedding (errors 101/150) — common for official music videos.`,
  `          // Fall back to streaming the audio through the backend before`,
  `          // surfacing a failure, so playback still works in the browser.`,
  `          if (this.audioEngine.usesNativeAudio()) throw iframeError;`,
  `          logInternalWarn(`,
  `            "PlayerController.iframe playback failed, trying native stream",`,
  `            {`,
  `              trackId: track.id,`,
  `              error: getErrorMessage(iframeError),`,
  `            },`,
  `          );`,
  `          const stream = await this.dataSource.getStreamData?.(track);`,
  `          if (!stream || (!stream.bytes && !stream.sourceUrl)) {`,
  `            throw iframeError;`,
  `          }`,
  `          await this.audioEngine.loadNativeFallback(`,
  `            track.id,`,
  `            stream.bytes,`,
  `            stream.mimeType,`,
  `            stream.sourceUrl,`,
  `          );`,
  `          logInternalInfo("PlayerController native fallback loaded", {`,
  `            trackId: track.id,`,
  `            via: stream.sourceUrl ? "media-stream" : "bytes",`,
  `          });`,
  `        }`,
  `      }`,
].join(EOL);

const idx = src.indexOf(oldBlock);
if (idx === -1) throw new Error("loadTrack block not found");
if (src.indexOf(oldBlock, idx + oldBlock.length) !== -1) throw new Error("loadTrack block not unique");

src = src.slice(0, idx) + newBlock + src.slice(idx + oldBlock.length);
writeFileSync(file, src);
console.log("done");
