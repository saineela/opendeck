// ANDROID client DIRECT (no proxy) to isolate whether our proxy breaks URL delivery
import { Innertube, ClientType, Constants } from "youtubei.js";
const yt = await Innertube.create({
  fetch: (input, init) => fetch(input, init),
  user_agent: Constants.CLIENTS.ANDROID.USER_AGENT,
  client_type: ClientType.ANDROID,
  retrieve_player: false,
  generate_session_locally: true,
  enable_session_cache: false,
});
const info = await yt.getBasicInfo("dQw4w9WgXcQ");
const audio = (info.streaming_data?.adaptive_formats ?? []).filter((f) => String(f.mime_type ?? "").startsWith("audio/"));
const withUrl = audio.filter((f) => f.url);
console.log("DIRECT ANDROID: playability:", info.playability_status?.status, "| audio:", audio.length, "| withUrl:", withUrl.length);
if (withUrl.length) console.log("url:", (await withUrl[0].decipher(yt.session.player)).slice(0, 110));
