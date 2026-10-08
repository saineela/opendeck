import { Innertube } from "youtubei.js";

const VIDEO_ID = process.argv[2] ?? "Kx7B-XvmFtE";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const yt = await Innertube.create({ lang: "en", country: "US", client: "music" });
const info = await yt.getInfo(VIDEO_ID);
console.log("playability:", info.playability_status?.status, "|", info.playability_status?.reason ?? "");
const sd = info.streaming_data;
const audio = (sd?.adaptive_formats ?? []).filter((f) => (f.mime_type ?? "").startsWith("audio"));
console.log(
  "audio itags:",
  audio.map((f) => `${f.itag}:${f.mime_type}:${f.url ? "plainurl" : "ciphered"}`).join(", "),
);

async function probe(label, url, headers) {
  try {
    const res = await fetch(url, { headers });
    let bodySnippet = "";
    if (!res.ok) {
      bodySnippet = ` body=${(await res.text()).slice(0, 300)}`;
      console.log(`  ${label}: HTTP ${res.status}${bodySnippet}`);
      return;
    }
    const reader = res.body?.getReader();
    const { value } = await reader.read();
    console.log(`  ${label}: HTTP ${res.status}, first chunk ${value?.length} bytes`);
    await reader.cancel().catch(() => {});
  } catch (error) {
    console.log(`  ${label}: ERROR ${error.message}`);
  }
}

const target = audio.find((f) => f.itag === 140) ?? audio[0];
const url = target.url ?? (await target.decipher(yt.session.player));
console.log(`probing itag ${target.itag}: ${url.slice(0, 120)}...`);

await probe("browser UA only (server behaviour)", url, { "user-agent": BROWSER_UA });
await probe("browser UA + range", url, { "user-agent": BROWSER_UA, range: "bytes=0-1023" });
await probe("browser UA + music origin", url, {
  "user-agent": BROWSER_UA,
  origin: "https://music.youtube.com",
  referer: "https://music.youtube.com/",
});
