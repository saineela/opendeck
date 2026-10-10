/**
 * Bare test client for the music API.
 *
 * Talks to nothing but this server's own endpoints:
 *   /healthz, /api/auth/*, /api/youtube/*, /api/yt/proxy, /api/media/stream,
 *   /api/cache/*, /api/settings/*, /api/keys/*
 *
 * Search + stream resolution run through the bundled real data layer
 * (vendor/engine.js), whose entire network surface is those endpoints.
 */
import { dataSource } from "./vendor/engine.js";

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Instrumented fetch: every request lands in the log panel            */
/* ------------------------------------------------------------------ */
const realFetch = window.fetch.bind(window);
const logEntries = [];
let logSeq = 0;

function targetOf(url, init) {
  const u = String(url);
  if (u.includes("/api/yt/proxy") && init?.body) {
    try {
      const inner = JSON.parse(init.body);
      const parsed = new URL(inner.url);
      return `${inner.method ?? "GET"} ${parsed.host}${parsed.pathname}`;
    } catch {
      return "POST /api/yt/proxy";
    }
  }
  if (u.includes("/api/media/stream")) {
    try {
      const parsed = new URL(u, location.origin);
      const inner = parsed.searchParams.get("url") ?? "";
      return `GET /api/media/stream → ${new URL(inner).host}`;
    } catch {
      return "GET /api/media/stream";
    }
  }
  return u.startsWith(location.origin) ? u.slice(location.origin.length) : u;
}

function addLog(kind, method, target, status, ms, note = "") {
  const statusClass =
    status === "ERR" ? "st-err" : typeof status === "number" && status >= 400 ? "st-err" : typeof status === "number" && status >= 300 ? "st-warn" : "st-ok";
  logEntries.unshift({
    time: new Date().toLocaleTimeString(),
    kind,
    method,
    target,
    status,
    statusClass,
    ms: Math.round(ms),
    note,
  });
  if (logEntries.length > 300) logEntries.pop();
  renderLog();
}

function renderLog() {
  const body = $("log-body");
  body.textContent = "";
  const frag = document.createDocumentFragment();
  for (const entry of logEntries) {
    const tr = document.createElement("tr");
    const cells = [entry.time, entry.kind, entry.method, entry.target, String(entry.status), String(entry.ms), entry.note];
    cells.forEach((value, i) => {
      const td = document.createElement("td");
      td.textContent = value;
      if (i === 0) td.className = entry.kind === "MEDIA" ? "kind-media" : "";
      if (i === 4) td.className = entry.statusClass;
      if (i === 1 && entry.kind === "MEDIA") td.className = "kind-media";
      tr.appendChild(td);
    });
    frag.appendChild(tr);
  }
  body.appendChild(frag);
  $("log-count").textContent = `${logEntries.length} entries`;
}

window.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET") ?? "GET").toUpperCase();
  const t0 = performance.now();
  try {
    const res = await realFetch(input, init);
    addLog("API", method, targetOf(url, init), res.status, performance.now() - t0);
    return res;
  } catch (error) {
    addLog("API", method, targetOf(url, init), "ERR", performance.now() - t0, String(error));
    throw error;
  }
};

/* Media-element requests bypass fetch(); surface them via resource timing. */
const seenMedia = new Set();
setInterval(() => {
  for (const entry of performance.getEntriesByType("resource")) {
    if (!entry.name.includes("/api/media/stream")) continue;
    const key = `${entry.startTime}`;
    if (seenMedia.has(key)) continue;
    seenMedia.add(key);
    addLog("MEDIA", "GET", "media element → /api/media/stream", "ok", entry.duration, "audio playback request");
  }
}, 2000);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function show(el, value) {
  el.textContent = typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

async function call(path, { method = "GET", body } = {}) {
  const init = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await realFetch(path, init);
  // Mirror the log for manual calls too (the wrapper does not see realFetch).
  addLog("API", method, path, res.status, 0);
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, json: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, text };
  }
}

function guard(label, fn) {
  return (...args) =>
    fn(...args).catch((error) => {
      addLog("APP", label, "handler", "ERR", 0, String(error));
      if (label === "search") $("search-status").textContent = String(error);
    });
}

const fmtTime = (sec) => {
  if (!Number.isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

/* ------------------------------------------------------------------ */
/* 1. System                                                           */
/* ------------------------------------------------------------------ */
async function loadHealth() {
  const t0 = performance.now();
  const res = await realFetch("/healthz");
  addLog("API", "GET", "/healthz", res.status, performance.now() - t0);
  const json = await res.json();
  show($("health-out"), json);
  $("badge-health").textContent = `health v${json.version}`;
  $("badge-health").className = "badge ok";
}

async function showHeaders() {
  const res = await realFetch("/healthz");
  const interesting = [
    "content-security-policy",
    "strict-transport-security",
    "cross-origin-opener-policy",
    "x-content-type-options",
    "referrer-policy",
    "x-frame-options",
  ];
  const lines = interesting.map((h) => `${h}:\n  ${res.headers.get(h) ?? "(absent)"}\n`);
  show($("headers-out"), lines.join(""));
  $("headers-out").classList.remove("hidden");
}

/* ------------------------------------------------------------------ */
/* 2. Google auth                                                      */
/* ------------------------------------------------------------------ */
let sessionPoll = null;

function renderSession(session) {
  show($("auth-out"), session);
  const badge = $("badge-session");
  if (session.authenticated) {
    badge.textContent = `signed in · ${session.user?.email ?? "?"} ${session.youtubeLinked ? "· YT linked" : "· YT not linked"}`;
    badge.className = "badge ok";
  } else {
    badge.textContent = "signed out";
    badge.className = "badge warn";
  }
}

async function refreshSession() {
  const session = await call("/api/auth/session");
  renderSession(session.json);
  return session.json;
}

function signIn() {
  const popup = window.open(
    "/api/auth/google/start?returnTo=" + encodeURIComponent(location.pathname),
    "testapp-google",
    "width=520,height=640",
  );
  addLog("APP", "POPUP", "/api/auth/google/start", popup ? "opened" : "blocked", 0);
  if (sessionPoll) clearInterval(sessionPoll);
  const deadline = Date.now() + 90_000;
  sessionPoll = setInterval(() => {
    refreshSession()
      .then((s) => {
        if (s.authenticated || Date.now() > deadline) {
          clearInterval(sessionPoll);
          sessionPoll = null;
          if (popup && !popup.closed) popup.close();
          if (s.authenticated) refreshAll();
        }
      })
      .catch(() => {});
  }, 1500);
}

window.addEventListener("message", (event) => {
  if (event.origin !== location.origin) return;
  if (event.data?.odAuth) {
    addLog("APP", "MSG", "postMessage from auth popup", "ok", 0, JSON.stringify(event.data));
    refreshSession().then(refreshAll).catch(() => {});
  }
});

async function signOut() {
  const out = await call("/api/auth/logout", { method: "POST", body: {} });
  addLog("APP", "SIGNOUT", "/api/auth/logout", out.status, 0);
  await refreshSession();
  refreshAll();
}

async function whoami() {
  const out = await call("/api/auth/whoami");
  show($("auth-out"), { whoami: out.json ?? out.text, session: (await refreshSession()) });
}

/* ------------------------------------------------------------------ */
/* 3. YouTube Music device link                                        */
/* ------------------------------------------------------------------ */
let ytPoll = null;

function renderYt(status) {
  show($("yt-out"), status);
  const badge = $("badge-yt");
  const codeBox = $("yt-code");
  if (status.state === "linked") {
    badge.textContent = "youtube: linked";
    badge.className = "badge ok";
    codeBox.classList.add("hidden");
  } else if (status.state === "pending") {
    badge.textContent = "youtube: pending code";
    badge.className = "badge warn";
    codeBox.classList.remove("hidden");
    $("yt-code-url").textContent = status.verificationUrl;
    $("yt-code-url").href = status.verificationUrl;
    $("yt-code-value").textContent = status.userCode;
  } else if (status.state === "error") {
    badge.textContent = "youtube: error";
    badge.className = "badge err";
    codeBox.classList.add("hidden");
  } else if (status.error) {
    badge.textContent = `youtube: ${status.error}`;
    badge.className = "badge err";
    codeBox.classList.add("hidden");
  } else {
    badge.textContent = "youtube: not linked";
    badge.className = "badge";
    codeBox.classList.add("hidden");
  }
}

async function refreshYt(pollWhilePending = false) {
  const out = await call("/api/youtube/status");
  if (out.status === 401) {
    renderYt({ error: "sign in required (401)", raw: out.json ?? out.text });
    return out.json;
  }
  renderYt(out.json);
  if (ytPoll) {
    clearInterval(ytPoll);
    ytPoll = null;
  }
  if (pollWhilePending && out.json?.state === "pending") {
    ytPoll = setInterval(() => {
      refreshYt(false)
        .then((s) => {
          if (s && s.state !== "pending") {
            clearInterval(ytPoll);
            ytPoll = null;
            refreshYt(true);
          }
        })
        .catch(() => {});
    }, 4000);
  }
  return out.json;
}

async function ytStart() {
  const out = await call("/api/youtube/link", { method: "POST", body: {} });
  show($("yt-out"), out.json ?? out.text);
  await refreshYt(true);
}

/* ------------------------------------------------------------------ */
/* 4. Search                                                           */
/* ------------------------------------------------------------------ */
const searchResults = { tracks: [], artists: [], albums: [], playlists: [] };

function row({ artworkUrl, title, sub, trailing, onClick }) {
  const div = document.createElement("div");
  div.className = "track";
  const img = document.createElement("img");
  img.alt = "";
  img.src = artworkUrl || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
  div.appendChild(img);
  const meta = document.createElement("div");
  const t = document.createElement("div");
  t.className = "t-title";
  t.textContent = title;
  const s = document.createElement("div");
  s.className = "t-artist";
  s.textContent = sub ?? "";
  meta.append(t, s);
  div.appendChild(meta);
  if (onClick) {
    const btn = document.createElement("button");
    btn.className = "btn primary play";
    btn.textContent = "▶";
    btn.setAttribute("aria-label", `Play ${title}`);
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      onClick();
    });
    div.appendChild(btn);
    div.style.cursor = "pointer";
    div.addEventListener("click", onClick);
  }
  if (trailing) div.appendChild(trailing);
  return div;
}

function renderResults(results) {
  const root = $("search-results");
  root.textContent = "";
  const groups = [
    ["Songs", results.tracks, (track) => ({
      artworkUrl: track.artworkUrl,
      title: track.title,
      sub: track.artist,
      trailing: track.durationSec ? Object.assign(document.createElement("span"), { className: "t-dur", textContent: fmtTime(track.durationSec) }) : null,
      onClick: () => enqueueAndPlay(track),
    })],
    ["Artists", results.artists, (artist) => ({
      artworkUrl: artist.artworkUrl,
      title: artist.name ?? artist.title,
      sub: `${artist.subscriberCountText ?? "artist"}`,
    })],
    ["Albums", results.albums, (album) => ({
      artworkUrl: album.artworkUrl,
      title: album.title,
      sub: `${album.artist ?? ""}${album.releaseType ? ` · ${album.releaseType}` : ""}`,
    })],
    ["Playlists", results.playlists, (playlist) => ({
      artworkUrl: playlist.artworkUrl,
      title: playlist.title,
      sub: playlist.author ?? "playlist",
    })],
  ];
  for (const [label, items, map] of groups) {
    if (!items?.length) continue;
    const group = document.createElement("div");
    group.className = "res-group";
    const h4 = document.createElement("h4");
    h4.textContent = `${label} (${items.length})`;
    group.appendChild(h4);
    for (const item of items) {
      group.appendChild(row(map(item)));
    }
    root.appendChild(group);
  }
}

async function doSearch() {
  const query = $("search-input").value.trim();
  if (!query) return;
  $("search-status").textContent = "searching via /api/yt/proxy…";
  $("btn-search").disabled = true;
  try {
    const results = await dataSource.search(query, (updated) => {
      Object.assign(searchResults, updated);
      renderResults(updated);
    });
    Object.assign(searchResults, results);
    renderResults(results);
    const n = (results.tracks?.length ?? 0) + (results.artists?.length ?? 0) + (results.albums?.length ?? 0) + (results.playlists?.length ?? 0);
    $("search-status").textContent = `${n} results`;
  } catch (error) {
    $("search-status").textContent = `failed: ${error}`;
    addLog("APP", "SEARCH", query, "ERR", 0, String(error));
  } finally {
    $("btn-search").disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 5. Player + queue                                                   */
/* ------------------------------------------------------------------ */
const audio = new Audio();
audio.preload = "auto";
let queue = [];
let currentIndex = -1;
let nowPlaying = null;

function renderQueue() {
  const list = $("queue-list");
  list.textContent = "";
  queue.forEach((track, i) => {
    const li = document.createElement("li");
    if (i === currentIndex) li.className = "current";
    const idx = document.createElement("span");
    idx.className = "q-idx";
    idx.textContent = String(i + 1);
    const title = document.createElement("span");
    title.textContent = `${track.title} — ${track.artist}`;
    const remove = document.createElement("button");
    remove.className = "q-remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${track.title} from queue`);
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      removeFromQueue(i);
    });
    li.append(idx, title, remove);
    li.addEventListener("click", () => playAt(i));
    list.appendChild(li);
  });
  $("queue-count").textContent = queue.length ? `${queue.length} tracks · index ${currentIndex + 1}` : "";
}

function removeFromQueue(i) {
  queue.splice(i, 1);
  if (i === currentIndex) {
    audio.pause();
    audio.removeAttribute("src");
    nowPlaying = null;
    currentIndex = -1;
    updateNowPlaying();
  } else if (i < currentIndex) {
    currentIndex -= 1;
  }
  renderQueue();
}

function updateNowPlaying(stateNote) {
  const track = nowPlaying;
  $("np-title").textContent = track ? track.title : "nothing playing";
  $("np-artist").textContent = track ? track.artist : "search for a track and press ▶";
  $("np-art").src = track?.artworkUrl ?? "";
  $("np-stream").textContent = stateNote ?? (audio.currentSrc ? `stream: ${targetOf(audio.currentSrc)}` : "");
}

function enqueueAndPlay(track) {
  const existing = queue.findIndex((t) => t.id === track.id);
  if (existing >= 0) {
    playAt(existing);
    return;
  }
  queue.push(track);
  renderQueue();
  playAt(queue.length - 1);
}

async function playAt(index) {
  const track = queue[index];
  if (!track) return;
  currentIndex = index;
  nowPlaying = track;
  renderQueue();
  updateNowPlaying("resolving stream via /api/yt/proxy + po-token…");
  addLog("STREAM", "RESOLVE", track.title, "…", 0);
  try {
    const data = await dataSource.getStreamData(track);
    if (!data?.sourceUrl) throw new Error(`No playable source URL (got ${JSON.stringify(Object.keys(data ?? {}))})`);
    audio.src = data.sourceUrl;
    updateNowPlaying();
    await audio.play();
    addLog("STREAM", "PLAY", track.title, "ok", 0, data.mimeType ?? "");
  } catch (error) {
    addLog("STREAM", "RESOLVE", track.title, "ERR", 0, String(error));
    updateNowPlaying(`stream failed: ${error}`);
  }
}

function playNext() {
  if (currentIndex + 1 < queue.length) playAt(currentIndex + 1);
}
function playPrev() {
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    return;
  }
  if (currentIndex - 1 >= 0) playAt(currentIndex - 1);
}

audio.addEventListener("play", () => { $("btn-play").textContent = "⏸"; });
audio.addEventListener("pause", () => { $("btn-play").textContent = "▶"; });
audio.addEventListener("ended", playNext);
audio.addEventListener("error", () => {
  if (audio.currentSrc) addLog("MEDIA", "ERROR", "audio element", "ERR", 0, audio.error?.message ?? String(audio.error));
});
audio.addEventListener("loadedmetadata", () => {
  $("time-total").textContent = fmtTime(audio.duration);
  updateNowPlaying();
});
audio.addEventListener("playing", () => updateNowPlaying());
audio.addEventListener("timeupdate", () => {
  $("time-now").textContent = fmtTime(audio.currentTime);
  if (!seekDragging) $("seek").value = String(audio.currentTime);
});
audio.addEventListener("volumechange", () => { $("volume").value = String(audio.volume); });

let seekDragging = false;

/* ------------------------------------------------------------------ */
/* 6. Cache / settings / API keys                                      */
/* ------------------------------------------------------------------ */
async function dataProbe(label, path, opts) {
  const out = await call(path, opts);
  show($("data-out"), { endpoint: path, status: out.status, response: out.json ?? out.text });
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */
function refreshAll() {
  refreshSession().catch(() => {});
  refreshYt(true).catch(() => {});
}

$("btn-health").addEventListener("click", guard("health", loadHealth));
$("btn-headers").addEventListener("click", guard("headers", showHeaders));
$("btn-session").addEventListener("click", guard("session", refreshSession));
$("btn-signin").addEventListener("click", signIn);
$("btn-whoami").addEventListener("click", guard("whoami", whoami));
$("btn-signout").addEventListener("click", guard("signout", signOut));
$("btn-yt-refresh").addEventListener("click", guard("yt", () => refreshYt(false)));
$("btn-yt-start").addEventListener("click", guard("yt-start", ytStart));
$("btn-yt-cancel").addEventListener("click", guard("yt-cancel", async () => {
  await call("/api/youtube/cancel", { method: "POST", body: {} });
  await refreshYt(false);
}));
$("btn-yt-unlink").addEventListener("click", guard("yt-unlink", async () => {
  await call("/api/youtube/unlink", { method: "POST", body: {} });
  await refreshYt(false);
}));
$("btn-search").addEventListener("click", doSearch);
$("search-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") doSearch();
});
$("btn-play").addEventListener("click", () => {
  if (!audio.src) {
    if (queue.length) playAt(Math.max(0, currentIndex));
    return;
  }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
});
$("btn-next").addEventListener("click", playNext);
$("btn-prev").addEventListener("click", playPrev);
$("seek").addEventListener("input", () => { seekDragging = true; });
$("seek").addEventListener("change", () => {
  audio.currentTime = Number($("seek").value);
  seekDragging = false;
});
$("volume").addEventListener("input", () => { audio.volume = Number($("volume").value); });
$("btn-mute").addEventListener("click", () => { audio.muted = !audio.muted; $("btn-mute").textContent = audio.muted ? "🔇" : "🔊"; });
$("btn-cache-stats").addEventListener("click", guard("cache", () => dataProbe("stats", "/api/cache/stats", { method: "POST", body: {} })));
$("btn-cache-set").addEventListener("click", guard("cache", () => dataProbe("set", "/api/cache/set", { method: "POST", body: { key: "test-app:probe", value: JSON.stringify({ setAt: Date.now() }) } })));
$("btn-cache-clear").addEventListener("click", guard("cache", () => dataProbe("clear", "/api/cache/clear", { method: "POST", body: {} })));
$("btn-settings-get").addEventListener("click", guard("settings", () => dataProbe("get", "/api/settings/get", { method: "POST", body: { key: "onboardingComplete" } })));
$("btn-settings-set").addEventListener("click", guard("settings", () => dataProbe("set", "/api/settings/set", { method: "POST", body: { key: "test-app:lastProbe", value: { at: new Date().toISOString() } } })));
$("btn-apikeys").addEventListener("click", guard("apikeys", () => dataProbe("keys", "/api/keys")));
$("btn-log-clear").addEventListener("click", () => { logEntries.length = 0; renderLog(); });

/* boot */
addLog("APP", "BOOT", "/test-app", "ok", 0, "bare test client loaded");
loadHealth().catch(() => {});
refreshAll();

/* Automation/debug handle (the <audio> element is created imperatively). */
window.__testApp = {
  audio,
  dataSource,
  getQueue: () => queue,
  getCurrentIndex: () => currentIndex,
  getLog: () => logEntries,
};
