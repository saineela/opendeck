// Mirrors the browser path: youtubei.js ANDROID client -> our /api/yt/proxy -> resolve -> /api/media/stream
import { Innertube, ClientType, Constants } from "youtubei.js";
import fs from "node:fs";

const sid = fs.readFileSync(".probe-sid", "utf8").trim();
const proxyFetch = async (input, init = {}) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const method = init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET") ?? "GET";
  const headers = {};
  if (init.headers) new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
  let bodyBase64;
  if (init.body) bodyBase64 = Buffer.from(typeof init.body === "string" ? init.body : new Uint8Array(await init.body)).toString("base64");
  if (process.env.DEBUG_PROXY) console.error("PROXY REQ", init.method ?? "GET", url, Object.keys(headers));
  const resp = await fetch("http://127.0.0.1:4000/api/yt/proxy", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `od_sid=${sid}` },
    body: JSON.stringify({ url, method, headers, body_base64: bodyBase64, timeout_ms: 30000 }),
    // eslint-disable-next-line no-console
  });
  const payload = await resp.json();
  if (!("body_base64" in payload)) throw new Error(`proxy error: ${payload.error} (${resp.status})`);
  const bytes = Buffer.from(payload.body_base64, "base64");
  return new Response(payload.status === 204 ? null : bytes, { status: payload.status, headers: payload.headers });
};

const yt = await Innertube.create({
  fetch: proxyFetch,
  user_agent: Constants.CLIENTS.ANDROID.USER_AGENT,
  client_type: ClientType.ANDROID,
  retrieve_player: true,
  generate_session_locally: true,
  enable_session_cache: false,
});

const info = await yt.getBasicInfo("dQw4w9WgXcQ");
const audio = (info.streaming_data?.adaptive_formats ?? []).filter((f) => String(f.mime_type ?? "").startsWith("audio/"));
console.log("playability:", info.playability_status?.status, "| audio formats:", audio.length);
if (!audio.length) process.exit(1);
const best = audio.sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0))[0];
console.log("format keys:", Object.keys(best).slice(0, 20).join(","), "| url len:", (best.url||"").length, "| cipher:", Boolean(best.signature_cipher || best.cipher));
const url = await best.decipher(yt.session.player);
console.log("stream url host:", new URL(url).hostname, "| has n-param:", new URL(url).searchParams.has("n"));

// Now fetch the bytes through our media API (exactly what <audio> does)
const mediaResp = await fetch(`http://127.0.0.1:4000/api/media/stream?url=${encodeURIComponent(url)}&videoId=dQw4w9WgXcQ&title=Never%20Gonna%20Give%20You%20Up&artist=Rick%20Astley&durationSec=213`, {
  headers: { cookie: `od_sid=${sid}`, range: "bytes=0-65535" },
});
console.log("media/stream:", mediaResp.status, mediaResp.headers.get("content-type"), "| bytes:", (await mediaResp.arrayBuffer()).byteLength);
