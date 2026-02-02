// app.js
import { BleUartClient } from "./ble_uart.js";

// ======================== Spotify settings (CHANGE ME) ======================
// Create an app in Spotify Developer Dashboard and paste client id here.
const SPOTIFY_CLIENT_ID = "81cff1fc219b442abfb47d9a3bba8960";

// Must match Redirect URI configured in Spotify app settings.
// If you host at https://example.com/dvs/ then this should be that exact URL.
const REDIRECT_URI = location.origin + location.pathname;

// Minimal scopes for /me + search. (You can add more later.)
const SCOPES = ["user-read-email"];

// Limit: max 10 minutes track duration
const MAX_MS = 10 * 60 * 1000;
// ===========================================================================

// ============================= Simple “crate DB” ============================
const LS_KEY = "dvs_crates_v1";
function loadCrates() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); } catch { return []; }
}
function saveCrates(crates) {
  localStorage.setItem(LS_KEY, JSON.stringify(crates));
}
// ===========================================================================

// ============================= UI helpers ==================================
const $ = (id) => document.getElementById(id);

function logBle(msg) {
  $("bleLog").textContent = msg + "\n" + $("bleLog").textContent;
}

function setVinylPill({ ready, lock }) {
  const pill = $("vinylPill");
  if (ready) { pill.className = "pill good"; pill.textContent = "VINYL: READY"; }
  else if (lock) { pill.className = "pill warn"; pill.textContent = "VINYL: LOCKED"; }
  else { pill.className = "pill bad"; pill.textContent = "VINYL: NO LOCK"; }
}
// ===========================================================================

// ============================= BLE / UART ==================================
let notifyBuf = "";
let lastStatus = { ready: false, lock: false, posMs: 0, rate: 1.0 };
let pollTimer = null;

const ble = new BleUartClient({
  onText: (text) => {
    // Accumulate and parse line-oriented replies
    notifyBuf += text;
    let idx;
    while ((idx = notifyBuf.indexOf("\n")) >= 0) {
      const line = notifyBuf.slice(0, idx).trim();
      notifyBuf = notifyBuf.slice(idx + 1);
      if (!line) continue;

      // STATUS format from dvs_core:
      // READY 0/1
      // LOCK 0/1
      // POS_MS N
      // RATE X
      // .
      if (line.startsWith("READY ")) lastStatus.ready = line.endsWith("1");
      else if (line.startsWith("LOCK ")) lastStatus.lock = line.endsWith("1");
      else if (line.startsWith("POS_MS ")) lastStatus.posMs = parseInt(line.slice(7), 10) || 0;
      else if (line.startsWith("RATE ")) lastStatus.rate = parseFloat(line.slice(5)) || 0;
      else if (line === ".") {
        setVinylPill({ ready: lastStatus.ready, lock: lastStatus.lock });
      }

      logBle(line);
    }
  }
});

function setBleUi(connected) {
  $("bleConnectBtn").disabled = connected;
  $("bleDisconnectBtn").disabled = !connected;

  $("statusBtn").disabled = !connected;
  $("startPollBtn").disabled = !connected;
  $("stopPollBtn").disabled = !connected;

  $("uploadBtn").disabled = !connected;
  $("listBtn").disabled = !connected;
  $("playBtn").disabled = !connected;
  $("stopBtn").disabled = !connected;
  $("deleteBtn").disabled = !connected;
  $("piTrackSelect").disabled = !connected;
}

async function bleConnect() {
  await ble.connect();
  setBleUi(true);
  logBle("BLE connected. Tap STATUS to verify.");
}

async function bleDisconnect() {
  stopPoll();
  await ble.disconnect();
  setBleUi(false);
  logBle("BLE disconnected.");
}

async function statusOnce() {
  await ble.writeLine("STATUS");
}

function startPoll() {
  stopPoll();
  pollTimer = setInterval(() => {
    if (ble.connected) ble.writeLine("STATUS").catch(()=>{});
  }, 300);
  logBle("Polling STATUS…");
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  logBle("Stopped polling.");
}

async function uploadFiles() {
  const files = [...$("filePicker").files];
  if (!files.length) return alert("Pick WAV/MP3 files first.");

  for (const f of files) {
    $("uploadProgress").textContent = `Uploading ${f.name}…`;
    await ble.uploadFile(f, {
      chunkSize: 180,
      onProgress: (p) => {
        $("uploadProgress").textContent = `Uploading ${f.name}: ${Math.round(p * 100)}%`;
      }
    });
  }

  $("uploadProgress").textContent = "Uploads done.";
  await listPi();
}

async function listPi() {
  $("piListBox").textContent = "";
  $("piTrackSelect").innerHTML = "";

  // LIST returns lines then "."
  await ble.writeLine("LIST");

  // The BLE log is already collecting output; we also want to parse the most recent LIST.
  // Simple approach: request STATUS next to update pill. For the dropdown, we request LIST and
  // then request STATUS; user can see names in log.
  // Better approach: have BLE bridge tag LIST replies. If you want, I’ll add that.

  // Minimal: ask user to hit STATUS after list; we'll build dropdown from TRACK_DIR index via new API later.
  // But we *can* still populate using the log by scanning recent lines:

  setTimeout(() => {
    const lines = $("bleLog").textContent.split("\n").map(s => s.trim()).filter(Boolean);
    // Find most recent LIST block by scanning backward for "." after LIST.
    // We'll take names between the last "." and previous "." isn't perfect, but workable.
    // Better is a tagged response; ask and I’ll improve.
    let end = lines.lastIndexOf(".");
    if (end < 0) return;
    // Take up to 200 lines before end and filter plausible filenames (not READY/LOCK/POS_MS/RATE)
    const block = lines.slice(Math.max(0, end - 200), end)
      .filter(s => !s.startsWith("READY ") && !s.startsWith("LOCK ") && !s.startsWith("POS_MS ") && !s.startsWith("RATE "))
      .filter(s => s !== "LIST" && s !== "OK" && s !== "ERR");

    const uniq = [...new Set(block)].reverse(); // reverse because log prepends
    const sel = $("piTrackSelect");
    sel.innerHTML = "";
    for (const name of uniq) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      sel.appendChild(opt);
    }
    $("piListBox").textContent = uniq.length ? uniq.join("\n") : "(No tracks found — upload some files.)";
  }, 300);
}

async function playSelected() {
  const name = $("piTrackSelect").value;
  if (!name) return alert("No track selected.");
  await ble.writeLine(`PLAY ${name}`);
  await statusOnce();
}

async function stopPlayback() {
  await ble.writeLine("STOP");
  await statusOnce();
}

async function deleteSelected() {
  const name = $("piTrackSelect").value;
  if (!name) return alert("No track selected.");
  if (!confirm(`Delete ${name}?`)) return;
  await ble.writeLine(`DELETE ${name}`);
  await listPi();
  await statusOnce();
}
// ===========================================================================

// ============================= Spotify PKCE =================================
function base64urlencode(a) {
  return btoa(String.fromCharCode(...new Uint8Array(a)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256(plain) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(plain));
}
function randomString(len = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i=0;i<len;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

async function spotifyLogin() {
  const verifier = randomString(96);
  const challenge = base64urlencode(await sha256(verifier));
  localStorage.setItem("pkce_verifier", verifier);

  const args = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    code_challenge_method: "S256",
    code_challenge: challenge,
    scope: SCOPES.join(" "),
  });

  location.href = `https://accounts.spotify.com/authorize?${args.toString()}`;
}

async function exchangeCodeForToken(code) {
  const verifier = localStorage.getItem("pkce_verifier");
  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  localStorage.setItem("spotify_token", data.access_token);

  // Clean URL
  history.replaceState({}, document.title, REDIRECT_URI);
  return data.access_token;
}

function spotifyToken() {
  return localStorage.getItem("spotify_token");
}

function spotifyLogout() {
  localStorage.removeItem("spotify_token");
  $("me").textContent = "";
  $("results").innerHTML = "";
  alert("Logged out.");
}

async function spotifyGET(path) {
  const token = spotifyToken();
  if (!token) throw new Error("Not logged in");
  const r = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(data));
  return data;
}

async function loadMe() {
  const me = await spotifyGET("/me");
  $("me").textContent = `Logged in as: ${me.display_name || me.id}`;
}
// ===========================================================================

// ============================= Crate builder =================================
const selected = [];

function renderSelected() {
  const ol = $("selected");
  ol.innerHTML = "";
  for (const t of selected) {
    const li = document.createElement("li");
    li.textContent = `${t.name} — ${t.artist} (${Math.round(t.duration_ms/1000)}s)`;
    ol.appendChild(li);
  }
}

function renderResults(items) {
  const root = $("results");
  root.innerHTML = "";

  for (const t of items) {
    const tooLong = t.duration_ms > MAX_MS;
    const div = document.createElement("div");
    div.className = "row";
    div.innerHTML = `
      <div style="max-width: 70%;">
        <b>${t.name}</b> — ${t.artist}<br/>
        <small>${Math.round(t.duration_ms/1000)}s ${tooLong ? "(too long)" : ""}</small>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button ${tooLong ? "disabled" : ""}>Add</button>
      </div>
    `;
    div.querySelector("button").onclick = () => {
      selected.push(t);
      renderSelected();
    };
    root.appendChild(div);
  }
}

async function doSearch() {
  if (!spotifyToken()) return alert("Login to Spotify first.");
  const q = $("searchBox").value.trim();
  if (!q) return;

  const data = await spotifyGET(`/search?type=track&limit=20&q=${encodeURIComponent(q)}`);
  const items = data.tracks.items.map(tr => ({
    id: tr.id,
    uri: tr.uri,
    name: tr.name,
    artist: tr.artists?.[0]?.name ?? "Unknown",
    duration_ms: tr.duration_ms,
  }));
  renderResults(items);
}

function saveCrate() {
  const name = $("crateName").value.trim();
  if (!name) return alert("Enter a crate name.");
  if (!selected.length) return alert("Select tracks first.");

  const tracks = selected.filter(t => t.duration_ms <= MAX_MS);
  const crates = loadCrates();
  crates.unshift({
    id: crypto.randomUUID(),
    name,
    tracks,
    createdAt: Date.now(),
  });
  saveCrates(crates);

  selected.length = 0;
  renderSelected();
  $("crateName").value = "";
  refreshCrates();
  alert("Crate saved (on this phone).");
}

function refreshCrates() {
  const crates = loadCrates();
  const ul = $("crates");
  ul.innerHTML = "";

  for (const c of crates) {
    const li = document.createElement("li");
    li.className = "row";
    li.innerHTML = `
      <div>
        <b>${c.name}</b><br/>
        <small>${c.tracks.length} tracks</small>
      </div>
      <div style="display:flex; gap:8px; flex-wrap:wrap;">
        <button class="send">Send to Pi</button>
        <button class="del">Delete</button>
      </div>
    `;

    li.querySelector(".send").onclick = async () => {
      if (!ble.connected) return alert("Connect BLE first.");
      // Send a lightweight “crate” selection. Your Pi bridge can ignore or store this.
      await ble.writeLine(`CRATE_BEGIN ${c.name}`);
      for (const t of c.tracks) {
        // purely metadata; does not download audio
        await ble.writeLine(`CRATE_TRACK ${t.name} | ${t.artist} | ${t.duration_ms} | ${t.uri}`);
      }
      await ble.writeLine("CRATE_END");
      alert("Crate metadata sent to Pi (optional). Now upload audio files and PLAY a filename.");
    };

    li.querySelector(".del").onclick = () => {
      const next = crates.filter(x => x.id !== c.id);
      saveCrates(next);
      refreshCrates();
    };

    ul.appendChild(li);
  }
}
// ===========================================================================

// ============================= Wire UI =====================================
$("bleConnectBtn").onclick = () => bleConnect().catch(e => alert("BLE connect failed: " + e));
$("bleDisconnectBtn").onclick = () => bleDisconnect().catch(()=>{});

$("statusBtn").onclick = () => statusOnce().catch(e => alert("STATUS failed: " + e));
$("startPollBtn").onclick = () => { startPoll(); };
$("stopPollBtn").onclick = () => { stopPoll(); };

$("uploadBtn").onclick = () => uploadFiles().catch(e => alert("Upload failed: " + e));

$("listBtn").onclick = () => listPi().catch(e => alert("LIST failed: " + e));
$("playBtn").onclick = () => playSelected().catch(e => alert("PLAY failed: " + e));
$("stopBtn").onclick = () => stopPlayback().catch(e => alert("STOP failed: " + e));
$("deleteBtn").onclick = () => deleteSelected().catch(e => alert("DELETE failed: " + e));

$("spotifyLoginBtn").onclick = () => spotifyLogin();
$("spotifyLogoutBtn").onclick = () => spotifyLogout();
$("searchBtn").onclick = () => doSearch().catch(e => alert("Search failed: " + e));

$("saveCrateBtn").onclick = () => saveCrate();
$("refreshCratesBtn").onclick = () => refreshCrates();
$("clearSelectedBtn").onclick = () => { selected.length = 0; renderSelected(); };

setBleUi(false);
function setBleUi(connected) {
  $("bleConnectBtn").disabled = connected;
  $("bleDisconnectBtn").disabled = !connected;

  $("statusBtn").disabled = !connected;
  $("startPollBtn").disabled = !connected;
  $("stopPollBtn").disabled = !connected;

  $("uploadBtn").disabled = !connected;
  $("listBtn").disabled = !connected;
  $("playBtn").disabled = !connected;
  $("stopBtn").disabled = !connected;
  $("deleteBtn").disabled = !connected;
  $("piTrackSelect").disabled = !connected;
}
// ===========================================================================

// ============================= Boot ========================================
(async function boot() {
  // Handle Spotify redirect ?code=
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  if (code) {
    try {
      await exchangeCodeForToken(code);
    } catch (e) {
      alert("Spotify token exchange failed. Check client id + redirect uri.");
    }
  }
  if (spotifyToken()) {
    try { await loadMe(); } catch {}
  }
  refreshCrates();
})();
