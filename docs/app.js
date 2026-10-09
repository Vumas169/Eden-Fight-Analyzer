// Eden Fight Analyzer by Vumas - web app
// Reads everything from the shared database. No request goes to Eden.

const VERSION = "1.0.0";
const SB_URL = "https://bvbrhgyvwmhypmyuuqeu.supabase.co";
const SB_KEY = "sb_publishable_xFsrXEB0pYNgV_nljbK6lw_yySLDZ5c";
const EDEN_FIGHT_URL = id => `https://eden-daoc.net/fights?id=${encodeURIComponent(id)}`;

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const REFRESH_MS = MINUTE;

// ------------------------------------------------------------------
// Game data
// ------------------------------------------------------------------

const CLASS_NAMES = {
  1: "Paladin", 2: "Armsman", 3: "Scout", 4: "Minstrel", 5: "Theurgist", 6: "Cleric", 7: "Wizard",
  8: "Sorcerer", 9: "Infiltrator", 10: "Friar", 11: "Mercenary", 12: "Necromancer", 13: "Cabalist",
  19: "Reaver", 21: "Thane", 22: "Warrior", 23: "Shadowblade", 24: "Skald", 25: "Hunter", 26: "Healer",
  27: "Spiritmaster", 28: "Shaman", 29: "Runemaster", 30: "Bonedancer", 31: "Berserker", 32: "Savage",
  33: "Heretic", 34: "Valkyrie", 39: "Bainshee", 40: "Eldritch", 41: "Enchanter", 42: "Mentalist",
  43: "Blademaster", 44: "Hero", 45: "Champion", 46: "Warden", 47: "Druid", 48: "Bard", 49: "Nightshade",
  50: "Ranger", 55: "Animist", 56: "Valewalker", 58: "Vampiir", 59: "Warlock", 63: "Occultist"
};

const ROLES = {
  Caster: ["Sorcerer", "Wizard", "Theurgist", "Cabalist", "Necromancer", "Heretic", "Runemaster", "Spiritmaster",
    "Bonedancer", "Warlock", "Thane", "Eldritch", "Enchanter", "Mentalist", "Animist", "Bainshee", "Occultist"],
  Stealth: ["Infiltrator", "Scout", "Nightshade", "Ranger", "Hunter"],
  Support: ["Cleric", "Friar", "Minstrel", "Healer", "Shaman", "Bard", "Druid", "Warden"],
  Tank: ["Armsman", "Paladin", "Mercenary", "Reaver", "Mauler", "Champion", "Hero", "Blademaster", "Vampiir",
    "Valewalker", "Warrior", "Berserker", "Savage", "Valkyrie", "Skald", "Shadowblade"]
};
const ROLE_OF = {};
for (const [role, list] of Object.entries(ROLES)) for (const cls of list) ROLE_OF[cls] = role;

const ICON = {
  Tank: '<svg viewBox="0 0 16 16"><path d="M8 1.5l5.5 2v4c0 3.5-2.4 5.8-5.5 7-3.1-1.2-5.5-3.5-5.5-7v-4z" fill="currentColor"/></svg>',
  Caster: '<svg viewBox="0 0 16 16"><path d="M8 1.5l1.6 4.9L14.5 8l-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" fill="currentColor"/></svg>',
  Stealth: '<svg viewBox="0 0 16 16"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
  Support: '<svg viewBox="0 0 16 16"><path d="M6 2h4v4h4v4h-4v4H6v-4H2V6h4z" fill="currentColor"/></svg>',
  Unknown: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>'
};

const REALMS = { 1: "Albion", 2: "Midgard", 3: "Hibernia" };
const REALM_SHORT = { 1: "Alb", 2: "Mid", 3: "Hib" };

// 20 % and 80 % marks of fight durations per group size (seconds).
// Replaced by the numbers from the database when they arrive.
let durationMarks = {
  1: { fast: 12, slow: 50 }, 2: { fast: 30, slow: 90 }, 3: { fast: 38, slow: 105 }, 4: { fast: 45, slow: 120 },
  5: { fast: 55, slow: 130 }, 6: { fast: 60, slow: 135 }, 7: { fast: 65, slow: 140 }, 8: { fast: 70, slow: 155 }
};

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ESC[ch]);
const NF = new Intl.NumberFormat("en-GB");
const fmt = value => NF.format(Math.round(Number(value) || 0));
const fmt1 = value => (Number(value) || 0).toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = (w, n) => (n ? w / n * 100 : 0);
const pad2 = n => String(n).padStart(2, "0");
const fmtDate = d => (d ? `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` : "-");
const fmtDay = d => (d ? `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}` : "-");
const fmtClock = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const fmtDur = s => (s == null || !(s >= 0) ? "-" : `${Math.floor(s / 60)}:${pad2(Math.round(s % 60))}`);
const capitalize = t => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const norm = t => String(t || "").trim().toLowerCase();

function ago(value) {
  if (!value) return "-";
  const t = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  const min = Math.max(0, Math.round((Date.now() - t) / MINUTE));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode */ }
  }
};

// ------------------------------------------------------------------
// Database
// ------------------------------------------------------------------

// A query that hits the database time limit is tried once more: the first
// try has usually loaded the data into memory, the second is fast.
async function rpc(fn, body = {}) {
  try {
    return await rpcOnce(fn, body);
  } catch (error) {
    if (!/statement timeout|did not answer/i.test(error.message)) throw error;
    await new Promise(r => setTimeout(r, 400));
    return rpcOnce(fn, body);
  }
}

async function rpcOnce(fn, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25 * SECOND);
  let res;
  try {
    res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: { apikey: SB_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (error) {
    throw new Error(error.name === "AbortError" ? "The database did not answer in time" : "Database not reachable");
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  if (!res.ok) throw new Error((json && (json.message || json.hint)) || `Database error ${res.status}`);
  return json;
}

// Results are kept for ttl. A request that is still running is shared.
// Results also go to the browser's storage: when a page is opened again,
// the last result shows at once and the fresh one replaces it a moment later.
const memo = new Map();
const DISK = "efa-c:";
const DISK_MAX_AGE = 12 * HOUR;
function diskGet(key) {
  const hit = store.get(DISK + key, null);
  return hit && Date.now() - hit.t < DISK_MAX_AGE ? hit : null;
}
function diskSet(key, value) {
  let text;
  try { text = JSON.stringify({ t: Date.now(), value }); } catch (e) { return; }
  if (text.length > 250000) return;
  try { localStorage.setItem(DISK + key, text); }
  catch (e) {
    // storage full: drop the cached results and keep going
    try { Object.keys(localStorage).filter(k => k.startsWith(DISK)).forEach(k => localStorage.removeItem(k)); } catch (e2) { /* blocked */ }
  }
}
let rerenderTimer = null;
function rerenderSoon() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => render({ silent: true }), 250);
}
function cached(key, ttl, loader, force = false) {
  const hit = memo.get(key);
  if (hit && hit.pending) return hit.pending;
  if (hit && !force && Date.now() - hit.t < ttl) return Promise.resolve(hit.value);
  if (!hit && !force) {
    const disk = diskGet(key);
    if (disk) {
      memo.set(key, { t: disk.t, value: disk.value });
      if (Date.now() - disk.t >= ttl) {
        const pending = loader().then(value => {
          memo.set(key, { t: Date.now(), value });
          diskSet(key, value);
          if (JSON.stringify(value) !== JSON.stringify(disk.value)) rerenderSoon();
          return value;
        }).catch(() => { memo.set(key, { t: disk.t, value: disk.value }); });
        memo.set(key, { t: disk.t, value: disk.value, refreshing: pending });
      }
      return Promise.resolve(disk.value);
    }
  }
  const pending = loader().then(value => {
    memo.set(key, { t: Date.now(), value });
    diskSet(key, value);
    return value;
  }).catch(error => {
    if (hit && !hit.pending) memo.set(key, hit);
    else memo.delete(key);
    throw error;
  });
  memo.set(key, { ...(hit || {}), pending });
  return pending;
}
const peek = key => { const hit = memo.get(key); return hit && "value" in hit ? hit.value : undefined; };

const api = {
  pulse: force => cached("pulse", MINUTE, () => rpc("server_pulse"), force),
  heat: () => cached("heat", 10 * MINUTE, () => rpc("activity_heat", { p_days: 30 })),
  dbInfo: () => cached("dbinfo", 10 * MINUTE, () => rpc("db_info")),
  marks: () => cached("marks", HOUR, () => rpc("duration_marks")),
  feed: (hours, size, limit, force) => cached(`feed|${hours}|${size}|${limit}`, MINUTE,
    () => rpc("fights_feed", { p_hours: hours, p_size: size || null, p_limit: limit }), force),
  playerFeed: (name, force) => cached(`pfeed|${norm(name)}`, MINUTE,
    () => rpc("fights_feed", { p_name: name, p_limit: 5000 }), force),
  card: (name, vs) => cached(`card|${norm(name)}|${(vs || []).join(",")}`, 5 * MINUTE,
    () => rpc("player_card", { p_name: name, p_vs: vs && vs.length ? vs : null })),
  profile: (name, hours, size) => cached(`prof|${norm(name)}|${hours}|${size}`, 5 * MINUTE,
    () => rpc("player_profile", { p_name: name, p_hours: hours, p_size: size || null })),
  classStats: hours => cached(`cs|${hours}`, 5 * MINUTE, () => rpc("class_stats", { p_hours: hours })),
  fightCounts: hours => cached(`fc|${hours}`, 5 * MINUTE, () => rpc("fight_counts", { p_hours: hours })),
  classPlayers: (h, s, c, r) => cached(`cp|${h}|${s}|${c}|${r}`, 5 * MINUTE,
    () => rpc("class_players", { p_hours: h, p_size: s || null, p_class: c, p_realm: r })),
  classVs: (h, s, c, r) => cached(`cv|${h}|${s}|${c}|${r}`, 5 * MINUTE,
    () => rpc("class_matchups", { p_hours: h, p_size: s || null, p_class: c, p_realm: r })),
  quality: (h, s) => cached(`q|${h}|${s}`, 5 * MINUTE, () => rpc("class_quality", { p_hours: h, p_size: s || null })),
  matrix: (h, s) => cached(`mx|${h}|${s}`, 5 * MINUTE, () => rpc("matchup_matrix", { p_hours: h, p_size: s || null })),
  leaderboard: (k, h, s, r, n, force) => cached(`lb|${k}|${h}|${s}|${r}|${n}`, 2 * MINUTE,
    () => rpc("leaderboard", { p_kind: k, p_hours: h || null, p_size: s || null, p_realm: r || null, p_limit: n }), force),
  names: q => cached(`ns|${norm(q)}`, 5 * MINUTE, () => rpc("name_search", { p_q: q, p_limit: 8 })),
  eloBoard: (bucket, kind, h, r, n) => cached(`eb|${bucket}|${kind}|${h}|${r}|${n}`, 2 * MINUTE,
    () => rpc("elo_board", { p_bucket: bucket, p_kind: kind, p_hours: h || null, p_realm: r || null, p_limit: n })),
  playerElo: name => cached(`pe|${norm(name)}`, 2 * MINUTE, () => rpc("player_elo", { p_name: name })),
  fight: id => cached(`fg|${id}`, HOUR, () => rpc("fight_get", { p_id: id })),
  fightDetail: id => rpc("fight_detail", { p_id: id })
};

// Elo brackets by the size of the player's OWN side: 1 = solo (alone, also
// 1v3), 2 = small (own side 2 to 5), 3 = group (own side 6 and more)
const BRACKETS = [[1, "Solo", "own side 1"], [2, "Small", "own side 2 to 5"], [3, "Group", "own side 6 and more"]];
const bracketName = b => (BRACKETS.find(x => x[0] === b) || [0, "?"])[1];

// ------------------------------------------------------------------
// Fights
// ------------------------------------------------------------------

// Row: [id, unix seconds, winners size, losers size, winner realm, loser realm, seconds, winners, losers, zone]
function fightFromRow(row) {
  const [id, ts, ws, ls, wr, lr, dur, w, l, zone] = row;
  const winners = Array.isArray(w) ? w.map(String) : [];
  const losers = Array.isArray(l) ? l.map(String) : [];
  return {
    id: String(id),
    date: new Date(Number(ts) * SECOND),
    ws: Number(ws) || winners.length || 1,
    ls: Number(ls) || losers.length || 1,
    wr: Number(wr) || 0,
    lr: Number(lr) || 0,
    secs: Number(dur) > 0 ? Math.round(Number(dur)) : null,
    winners,
    losers,
    zone: zone || ""
  };
}

const bigSide = f => Math.max(f.ws, f.ls);
const capSize = n => Math.min(n, 8);
const fightHasSize = (f, size) => capSize(f.ws) === size || capSize(f.ls) === size;

function durClass(secs, size) {
  if (secs == null) return "";
  const m = durationMarks[capSize(size)] || durationMarks[8];
  return secs < m.fast ? "fast" : secs >= m.slow ? "slow" : "";
}

// Fights of one player, from his point of view
function playerRows(fights, name) {
  const target = norm(name);
  const rows = [];
  for (const f of fights) {
    let own = f.winners.find(n => norm(n) === target);
    let won = true;
    if (!own) {
      own = f.losers.find(n => norm(n) === target);
      won = false;
    }
    if (!own) continue;
    rows.push({
      fight: f,
      won,
      size: won ? f.ws : f.ls,
      enemySize: won ? f.ls : f.ws,
      opponents: won ? f.losers : f.winners,
      mates: (won ? f.winners : f.losers).filter(n => n !== own),
      enemyRealm: won ? f.lr : f.wr,
      ownRealm: won ? f.wr : f.lr
    });
  }
  return rows;
}

function streaks(rows) {
  let bestW = 0;
  let bestL = 0;
  let cur = 0;
  let last = null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i].won;
    cur = r === last ? cur + 1 : 1;
    last = r;
    if (r) bestW = Math.max(bestW, cur); else bestL = Math.max(bestL, cur);
  }
  let now = 0;
  for (const row of rows) {
    if (row.won !== rows[0].won) break;
    now += 1;
  }
  return { bestW, bestL, now: rows.length ? `${now}${rows[0].won ? "W" : "L"}` : "-", nowWon: rows.length ? rows[0].won : null };
}

// Lower quartile weighted by fights: below this count players together
// hold a quarter of all fights in the list.
function weightedLowerQuartile(values) {
  const sorted = values.filter(v => v > 0).sort((a, b) => a - b);
  const total = sorted.reduce((s, v) => s + v, 0);
  let cum = 0;
  for (const v of sorted) {
    cum += v;
    if (cum >= total * 0.25) return v;
  }
  return 0;
}

// ------------------------------------------------------------------
// Characters: class and realm per name
// ------------------------------------------------------------------

const chars = new Map(); // name -> { c, r }
const charsPending = new Set();

async function loadChars(names) {
  const missing = [...new Set(names)].filter(n => n && !chars.has(n) && !charsPending.has(n));
  if (!missing.length) return;
  missing.forEach(n => charsPending.add(n));
  try {
    for (let i = 0; i < missing.length; i += 400) {
      const part = missing.slice(i, i + 400);
      const list = await rpc("chars_info", { p_names: part });
      for (const [name, c, r] of list || []) chars.set(name, { c, r });
      for (const n of part) if (!chars.has(n)) chars.set(n, { c: null, r: null });
    }
  } catch (e) {
    /* names stay without icon */
  } finally {
    missing.forEach(n => charsPending.delete(n));
  }
}

// Adds class icons to every name in root that does not have one yet
async function hydrate(root) {
  if (!root) return;
  const els = $$(".pl[data-n]:not([data-h])", root);
  if (!els.length) return;
  await loadChars(els.map(el => el.dataset.n));
  for (const el of els) {
    if (el.dataset.h) continue;
    const info = chars.get(el.dataset.n);
    el.dataset.h = "1";
    if (info && info.c) el.insertAdjacentHTML("afterbegin", classIcon(info.c));
  }
}

const className = id => CLASS_NAMES[id] || (id ? `Class ${id}` : "Unknown");
const roleOf = id => ROLE_OF[CLASS_NAMES[id]] || "Unknown";
// Class symbols from the Fair Fights 1v1 site, loaded from there and cached
// by the browser. Unknown classes fall back to a plain role symbol.
const ICON_URL = name => `https://eden.solo-daoc.net/icons/${encodeURIComponent(name)}_class_icon.webp`;
const classIcon = id => {
  const name = CLASS_NAMES[id];
  if (!name) return `<span class="ci role-unknown" title="Unknown class">${ICON.Unknown}</span>`;
  return `<img class="ci" src="${ICON_URL(name)}" alt="" title="${esc(name)}" decoding="async">`;
};
const roleIcon = role => `<span class="ci role-${String(role || "Unknown").toLowerCase()}" title="${esc(role || "Unknown")}">${ICON[role] || ICON.Unknown}</span>`;
const realmDot = r => (REALMS[r] ? `<span class="rm r${r}" title="${REALMS[r]}"></span>` : "");
const classHtml = (id, realm) => `<span class="cls">${realm !== undefined ? realmDot(realm) : ""}${classIcon(id)}<span class="cn">${esc(className(id))}</span></span>`;

function nameHtml(name) {
  const info = chars.get(name);
  const icon = info && info.c ? classIcon(info.c) : "";
  return `<a class="pl" href="#/player/${encodeURIComponent(name)}" data-n="${esc(name)}"${info ? ' data-h="1"' : ""}>${icon}${esc(name)}</a>`;
}
const namesHtml = names => `<span class="names">${names.map(nameHtml).join("")}</span>`;

// ------------------------------------------------------------------
// Favorites and notifications
// ------------------------------------------------------------------

const FAV_KEY = "efa-favs";
const favs = () => store.get(FAV_KEY, []);
const isFav = name => favs().some(n => norm(n) === norm(name));

function toggleFav(name) {
  const list = favs();
  const i = list.findIndex(n => norm(n) === norm(name));
  if (i >= 0) list.splice(i, 1); else list.push(name);
  store.set(FAV_KEY, list.slice(-16));
  renderFavs();
}

// Favorites: a bar under the header or a compact menu. Both can be
// sorted by drag and drop.
const FAV_MODE = "efa-favs-mode";
function renderFavs() {
  const box = $("#favs");
  const list = favs();
  box.hidden = !list.length;
  if (!list.length) { box.innerHTML = ""; return; }
  const current = state.route.page === "player" ? norm(state.route.arg) : "";
  const chip = (n, i) => `<a class="fav ${norm(n) === current ? "on" : ""}" href="#/player/${encodeURIComponent(n)}" data-n="${esc(n)}" data-fav-i="${i}" draggable="true">${esc(n)}</a>`;
  if (store.get(FAV_MODE, "bar") === "menu") {
    const open = !!state.favOpen;
    box.innerHTML = `
      <div class="fav-menu">
        <button class="fav-toggle ${open ? "on" : ""}" data-fav-act="open">★ Favorites <b>${list.length}</b> ▾</button>
        ${open ? `<div class="fav-drop">${list.map(chip).join("")}<button class="fav-mode" data-fav-act="bar">Show as bar</button></div>` : ""}
      </div>`;
  } else {
    box.innerHTML = `<span class="favs-label">Favorites</span>${list.map(chip).join("")}<button class="fav-mode" data-fav-act="menu" title="Fold the favorites into a menu">▴ fold</button>`;
  }
}

function moveFav(from, to) {
  const list = favs();
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  store.set(FAV_KEY, list);
  renderFavs();
}

(() => {
  const box = $("#favs");
  let dragFrom = -1;
  box.addEventListener("dragstart", e => {
    const el = e.target.closest("[data-fav-i]");
    if (!el) return;
    dragFrom = Number(el.dataset.favI);
    el.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    try { e.dataTransfer.setData("text/plain", el.dataset.n); } catch (err) { /* old browsers */ }
    hidePop();
  });
  box.addEventListener("dragover", e => {
    const el = e.target.closest("[data-fav-i]");
    if (!el || dragFrom < 0) return;
    e.preventDefault();
    $$("[data-fav-i]", box).forEach(x => x.classList.toggle("drop-to", x === el));
  });
  box.addEventListener("drop", e => {
    const el = e.target.closest("[data-fav-i]");
    if (!el || dragFrom < 0) return;
    e.preventDefault();
    const to = Number(el.dataset.favI);
    const from = dragFrom;
    dragFrom = -1;
    moveFav(from, to);
  });
  box.addEventListener("dragend", () => {
    dragFrom = -1;
    $$("[data-fav-i]", box).forEach(x => x.classList.remove("dragging", "drop-to"));
  });
  box.addEventListener("click", e => {
    const b = e.target.closest("[data-fav-act]");
    if (!b) return;
    e.preventDefault();
    const act = b.dataset.favAct;
    if (act === "open") state.favOpen = !state.favOpen;
    if (act === "menu") { store.set(FAV_MODE, "menu"); state.favOpen = false; }
    if (act === "bar") { store.set(FAV_MODE, "bar"); state.favOpen = false; }
    renderFavs();
  });
})();

function toast(html, href) {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = html;
  el.addEventListener("click", () => { if (href) location.hash = href; el.remove(); });
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), 12 * SECOND);
}

const NOTIFY_KEY = "efa-notify";
function renderBell() {
  const on = store.get(NOTIFY_KEY, false);
  $("#bell").classList.toggle("on", !!on);
  $("#bell").title = on ? "Notifications on: you hear about new fights of your favorites" : "Notify me when a favorite fights";
}

async function toggleBell() {
  const on = !store.get(NOTIFY_KEY, false);
  if (on && "Notification" in window && Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch (e) { /* ignore */ }
  }
  store.set(NOTIFY_KEY, on);
  renderBell();
  toast(on
    ? (favs().length ? "Notifications on. New fights of your favorites show up here." : "Notifications on. Add favorites with the star on a player page.")
    : "Notifications off.");
}

// New fights of favorites, checked with every refresh
const seenFights = new Set();
let watchPrimed = false;

function watchFights(fights) {
  const list = favs().map(norm);
  const fresh = fights.filter(f => !seenFights.has(f.id));
  fights.forEach(f => seenFights.add(f.id));
  if (!watchPrimed) { watchPrimed = true; return; }
  if (!list.length || !store.get(NOTIFY_KEY, false)) return;
  for (const f of fresh.slice(0, 5)) {
    const w = f.winners.find(n => list.includes(norm(n)));
    const l = f.losers.find(n => list.includes(norm(n)));
    const who = w || l;
    if (!who) continue;
    const text = `${who} ${w ? "won" : "lost"} a ${f.ws}v${f.ls}${f.zone ? ` in ${f.zone}` : ""}`;
    toast(`<b>${esc(text)}</b><div class="sub">${esc((w ? f.losers : f.winners).slice(0, 4).join(", "))}</div>`, `#/player/${encodeURIComponent(who)}`);
    if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
      try { new Notification("Eden Fight Analyzer", { body: text, icon: "icons/icon-192.png", tag: f.id }); } catch (e) { /* ignore */ }
    }
  }
}

// ------------------------------------------------------------------
// Router
// ------------------------------------------------------------------

const state = { route: { page: "over", arg: "", params: new URLSearchParams() }, token: 0, ui: {} };

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, "");
  const [path, query = ""] = raw.split("?");
  const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
  const page = parts[0] || "over";
  const map = { "": "over", over: "over", fights: "fights", player: "player", classes: "classes", leaderboard: "lb", compare: "compare", report: "report" };
  return { page: map[page] || "over", arg: parts[1] || "", params: new URLSearchParams(query) };
}

function buildHash(page, arg, params) {
  const names = { over: "", fights: "fights", player: "player", classes: "classes", lb: "leaderboard", compare: "compare", report: "report" };
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== "" && v !== null && v !== undefined && v !== false) q.set(k, v);
  const query = q.toString();
  return `#/${names[page]}${arg ? `/${encodeURIComponent(arg)}` : ""}${query ? `?${query}` : ""}`;
}

// Filter changes replace the history entry, so the back button goes to
// the previous page and not through every filter click.
function setParams(patch) {
  const r = state.route;
  const params = Object.fromEntries(r.params.entries());
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "") delete params[k]; else params[k] = String(v);
  }
  history.replaceState(null, "", buildHash(r.page, r.arg, params));
  render({ keepScroll: true });
}

const VIEWS = {};

async function render(options = {}) {
  const { keepScroll = false, silent = false } = options;
  state.route = parseHash();
  const token = ++state.token;
  const page = state.route.page;
  $$("#nav a").forEach(a => a.classList.toggle("on", a.dataset.nav === page || ((page === "player" || page === "report") && a.dataset.nav === "fights")));
  renderFavs();
  hidePop();
  if (page !== "player") document.title = "Eden Fight Analyzer";
  const y = window.scrollY;
  const ctx = {
    token,
    alive: () => token === state.token,
    silent,
    view: $("#view")
  };
  try {
    await VIEWS[page](ctx, state.route);
  } catch (error) {
    if (!ctx.alive()) return;
    if (silent) return; // keep what is on screen
    ctx.view.innerHTML = `<div class="warn"><span>Could not load: ${esc(error.message)}</span><button class="btn" data-act="retry">Try again</button></div>`;
    console.error(error);
  }
  if (!ctx.alive()) return;
  if (keepScroll || silent) window.scrollTo(0, y);
  hydrate(ctx.view);
}

window.addEventListener("hashchange", () => {
  state.ui = { overSeen: state.ui.overSeen };
  render();
  window.scrollTo(0, 0);
});

// ------------------------------------------------------------------
// Shared view parts
// ------------------------------------------------------------------

const PERIODS = [1, 2, 4, 8, 16, 24, 36, 48, 72, 168, 336, 672, 0]; // 0 = season
const PERIOD_SHORT = { 1: "1h", 2: "2h", 4: "4h", 8: "8h", 16: "16h", 24: "24h", 36: "36h", 48: "2d", 72: "3d", 168: "1w", 336: "2w", 672: "4w", 0: "All" };
const periodLabel = h => ({ 0: "Season", 24: "Last 24 hours", 48: "Last 2 days", 72: "Last 3 days", 168: "Last 7 days", 336: "Last 2 weeks", 672: "Last 4 weeks" }[h] || `Last ${h} hours`);
const sizeLabel = s => (s === 1 ? "Solo" : s ? `Group of ${s}${s === 8 ? "+" : ""}` : "All group sizes");

function sliderHtml(hours) {
  const index = Math.max(0, PERIODS.indexOf(hours));
  return `
    <div class="slider">
      <input type="range" min="0" max="${PERIODS.length - 1}" step="1" value="${index}" data-period aria-label="Period">
      <div class="ticks">${PERIODS.map((h, i) => `<span class="${i === index ? "on" : ""}" data-set="h=${h}">${PERIOD_SHORT[h]}</span>`).join("")}</div>
    </div>`;
}

function segHtml(key, current, options) {
  return `<div class="seg">${options.map(([v, label, title]) => `<button class="${String(current) === String(v) ? "on" : ""}" data-set="${key}=${v}"${title ? ` title="${esc(title)}"` : ""}>${label}</button>`).join("")}</div>`;
}

const SIZE_OPTIONS = [[0, "All"], [1, "Solo"], [2, "2"], [3, "3"], [4, "4"], [5, "5"], [6, "6"], [7, "7"], [8, "8+"]];
const REALM_OPTIONS = [[0, "All"], [1, "Alb"], [2, "Mid"], [3, "Hib"]];

const tile = (label, value, sub) => `<div class="tile"><span>${label}</span><strong>${value}</strong>${sub ? `<em>${sub}</em>` : ""}</div>`;

function barsHtml(rows, opts = {}) {
  if (!rows.length) return `<div class="empty">No data.</div>`;
  const max = Math.max(...rows.map(r => r.value), 1);
  return `<div class="bars">${rows.map(r => `
    <div class="bar-row ${opts.wide ? "wide" : ""} ${r.set ? "click" : ""}" ${r.set ? `data-set="${r.set}"` : ""} ${r.title ? `title="${esc(r.title)}"` : ""}>
      <span class="bn">${r.label}</span>
      <div class="bar"><span style="width:${(r.value / max * 100).toFixed(1)}%"></span></div>
      <span class="bv">${fmt(r.value)}</span>
      <span class="bs">${r.sub || ""}</span>
    </div>`).join("")}</div>`;
}

function rateBar(rate) {
  const tone = rate >= 52 ? "up" : rate <= 48 ? "down" : "";
  return `<span class="rbar ${tone}"><span style="width:${Math.max(0, Math.min(100, rate)).toFixed(1)}%"></span></span>`;
}

function hoursBarsHtml(buckets, title) {
  if (!buckets.length) return "";
  const max = Math.max(...buckets.map(b => b.n), 1);
  const step = Math.max(1, Math.round(buckets.length / 6));
  const total = buckets.reduce((s, b) => s + b.n, 0);
  return `
    <div class="hours">
      <div class="panel-h">${title}<span class="right muted">${fmt(total)} fights · peak ${fmt(max)}</span></div>
      <div class="hours-bars">${buckets.map(b => `<i class="${b.n ? "" : "is-empty"}" style="height:${b.n ? Math.max(5, b.n / max * 100) : 100}%" title="${esc(b.label)}: ${fmt(b.n)} fights"></i>`).join("")}</div>
      <div class="hours-scale">${buckets.filter((_, i) => i % step === 0).map(b => `<span>${esc(b.short)}</span>`).join("")}</div>
    </div>`;
}

// Hour buckets of the last n hours from a fight list
function hourBuckets(fights, count) {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  const last = now.getTime();
  const out = Array.from({ length: count }, (_, i) => {
    const from = new Date(last - (count - 1 - i) * HOUR);
    return { n: 0, short: fmtClock(from), label: `${fmtClock(from)} to ${fmtClock(new Date(from.getTime() + HOUR))}` };
  });
  for (const f of fights) {
    const d = new Date(f.date);
    d.setMinutes(0, 0, 0);
    const age = Math.round((last - d.getTime()) / HOUR);
    if (age >= 0 && age < count) out[count - 1 - age].n += 1;
  }
  return out;
}

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
// Time zone of the viewer, e.g. "Europe/Berlin, UTC+2"
function tzOffsetHours(tz, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(date);
  const g = t => Number((parts.find(p => p.type === t) || {}).value);
  return Math.round((Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute")) - date.getTime()) / HOUR);
}
function tzLabel() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "local";
  const off = -new Date().getTimezoneOffset() / 60;
  return `${tz.replace(/_/g, " ")}, UTC${off >= 0 ? "+" : "-"}${Math.abs(off)}`;
}

function heatmapHtml(cells) {
  if (!cells || !cells.length) return `<div class="empty">No data.</div>`;
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  // the database counts in Berlin time; move every cell to the viewer's hour
  const shift = -new Date().getTimezoneOffset() / 60 - tzOffsetHours("Europe/Berlin");
  for (const [dow, hour, count] of cells) {
    let h = Number(hour) + shift;
    let d = Number(dow) - 1;
    while (h < 0) { h += 24; d = (d + 6) % 7; }
    while (h >= 24) { h -= 24; d = (d + 1) % 7; }
    grid[d][Math.floor(h)] += Number(count);
  }
  const max = Math.max(...grid.flat(), 1);
  return `
    <div class="heat">
      <div class="heat-row"><span></span>${Array.from({ length: 24 }, (_, h) => `<span>${h % 3 === 0 ? h : ""}</span>`).join("")}</div>
      ${grid.map((row, d) => `<div class="heat-row"><span>${DAYS[d]}</span>${row.map((c, h) => `<i style="--a:${(0.05 + c / max * 0.95).toFixed(3)}" title="${DAYS[d]} ${pad2(h)}:00 · ${fmt(c)} fights"></i>`).join("")}</div>`).join("")}
    </div>`;
}

// One fight in a list. With rows from a player's point of view the stripe
// shows his result, otherwise both sides are listed.
function fightHtml(f, row, opts = {}) {
  const open = state.ui.open && state.ui.open.has(f.id);
  const dc = durClass(f.secs, bigSide(f));
  const meta = `<div class="f-meta"><b>${fmtDate(f.date)}</b><br>${esc(f.zone || "")}</div>`;
  const dur = `<span class="f-dur ${dc}" title="${dc === "fast" ? "Fast for this size" : dc === "slow" ? "Long for this size" : "Duration"}">${fmtDur(f.secs)}</span>`;
  if (row) {
    return `
      <div class="fight ${row.won ? "is-win" : "is-loss"} ${opts.isNew ? "new" : ""}" data-fid="${esc(f.id)}">
        <div class="f-badge"><b>${row.won ? "W" : "L"}</b>${f.ws}v${f.ls}</div>
        <div class="f-main">
          <div class="f-line">${realmDot(row.enemyRealm)}${namesHtml(row.opponents)}</div>
          ${row.mates.length ? `<div class="f-line dim">with&nbsp;${namesHtml(row.mates)}</div>` : ""}
        </div>
        ${dur}${meta}
        ${open ? fightDetailHtml(f) : ""}
      </div>`;
  }
  return `
    <div class="fight ${opts.isNew ? "new" : ""}" data-fid="${esc(f.id)}">
      <div class="f-badge"><b class="${f.ws < f.ls ? "" : ""}">${f.ws}v${f.ls}</b>${f.ws < f.ls ? '<span class="ud" title="The smaller side won">UD</span>' : ""}</div>
      <div class="f-main">
        <div class="f-line"><span class="tag w">W</span>${realmDot(f.wr)}${namesHtml(f.winners)}</div>
        <div class="f-line"><span class="tag l">L</span>${realmDot(f.lr)}${namesHtml(f.losers)}</div>
      </div>
      ${dur}${meta}
      ${open ? fightDetailHtml(f) : ""}
    </div>`;
}

function fightDetailHtml(f) {
  const side = (names, realm, won) => `
    <div class="f-side">
      <h4 class="${won ? "w" : "l"}">${won ? "Winners" : "Losers"} ${realmDot(realm)}<span class="sub">${names.length}</span></h4>
      <div class="list">${names.map(n => {
        const info = chars.get(n);
        return `<div class="li"><span class="lm">${nameHtml(n)}</span><span class="ls">${info && info.c ? esc(className(info.c)) : ""}</span></div>`;
      }).join("")}</div>
    </div>`;
  return `
    <div class="f-detail" data-stop>
      ${side(f.winners, f.wr, true)}
      ${side(f.losers, f.lr, false)}
      <div class="f-acts">
        <span>${fmtDay(f.date)} ${fmtClock(f.date)} · ${f.ws}v${f.ls} · ${fmtDur(f.secs)}${f.zone ? ` · ${esc(f.zone)}` : ""}</span>
        <span class="sp"></span>
        <a class="btn sm" href="#/report/${encodeURIComponent(f.id)}">Report</a>
        <a class="btn sm" href="${EDEN_FIGHT_URL(f.id)}" target="_blank" rel="noopener">Open on Eden</a>
      </div>
    </div>`;
}

const LIST_STEP = 50;
const LIST_FIRST = { over: 15 };
function fightListHtml(items, key, renderOne) {
  const shown = state.ui.shown && state.ui.shown[key] || LIST_FIRST[key] || LIST_STEP;
  if (!items.length) return `<div class="empty">No fights in this selection.</div>`;
  return `
    <div class="fights">${items.slice(0, shown).map(renderOne).join("")}</div>
    ${items.length > shown ? `<button class="btn full" data-act="more" data-key="${key}">Show ${fmt(Math.min(LIST_STEP * 4, items.length - shown))} more${items.length - shown > LIST_STEP * 4 ? ` (${fmt(items.length - shown)} left)` : ""}</button>` : ""}`;
}

function oppListHtml(entries, valueKey, unit = "") {
  if (!entries.length) return `<div class="empty">No data.</div>`;
  return `<div class="list">${entries.map(e => `
    <div class="li"><span class="lm">${realmDot(e.realm)}${nameHtml(e.name)}${e.sub ? ` <span class="sub">${e.sub}</span>` : ""}</span><span class="lv ${valueKey === "wins" ? "w" : valueKey === "losses" ? "l" : ""}">${fmt(e[valueKey])}${unit}</span></div>`).join("")}</div>`;
}

function groupsHtml(groups, title, hint) {
  if (!groups.length) return "";
  return `
    <div class="panel">
      <h2>${title}${hint ? ` <em>${hint}</em>` : ""}</h2>
      <div class="list">${groups.slice(0, 8).map(g => {
        const n = g.wins + g.losses;
        return `<div class="li"><span class="lm">${realmDot(g.realm)}${namesHtml(g.names)}</span><span class="ls"><span class="w">${g.wins}</span>/<span class="l">${g.losses}</span></span><span class="lv">${fmt1(pct(g.wins, n))}%</span></div>`;
      }).join("")}</div>
    </div>`;
}

function addGroup(map, names, realm, won) {
  if (names.length < 2) return;
  const key = names.map(norm).sort().join("|");
  if (!map.has(key)) map.set(key, { names: [...names], realm, wins: 0, losses: 0 });
  const g = map.get(key);
  if (won) g.wins += 1; else g.losses += 1;
}
const sortedGroups = map => [...map.values()].filter(g => g.wins + g.losses >= 2)
  .sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses) || b.wins - a.wins);

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    if (button) {
      const label = button.textContent;
      button.textContent = "Copied";
      setTimeout(() => { button.textContent = label; }, 1500);
    }
  } catch (e) {
    toast("Copying is blocked in this browser.");
  }
}

// Elo cursor "ts|id": calculated up to this fight
const eloUpTo = cur => { const t = Date.parse(String(cur).split("|")[0]); return Number.isFinite(t) ? fmtDay(new Date(t)) : "-"; };
const eloCaughtUp = cur => { const t = Date.parse(String(cur).split("|")[0]); return Number.isFinite(t) && Date.now() - t < 2 * HOUR; };

const loadingHtml = () => `<div class="grid"><div class="skel h"></div><div class="skel t"></div></div>`;
const appUrl = hash => `${location.origin}${location.pathname}${hash}`;

// ------------------------------------------------------------------
// View: Overview
// ------------------------------------------------------------------

VIEWS.over = async (ctx) => {
  if (!ctx.silent && !peek("pulse")) ctx.view.innerHTML = loadingHtml();
  const winsSpan = store.get("efa-ov-wins", "1h");
  const gainBucket = store.get("efa-ov-gain", 1);
  const gainKind = store.get("efa-ov-gainkind", "gain") === "loss" ? "loss" : "gain";
  const [pulse, recentRaw, wins7, gains, streaks7] = await Promise.all([
    api.pulse(ctx.silent),
    api.feed(3, null, 400, ctx.silent),
    winsSpan === "7d" ? api.leaderboard("wins", 168, null, null, 8).catch(() => null) : null,
    api.eloBoard(gainBucket, gainKind, 168, 0, 8).catch(() => null),
    api.leaderboard("streak", 168, null, null, 8).catch(() => null)
  ]);
  const heat = await api.heat().catch(() => null);
  if (!ctx.alive()) return;

  const recent = (recentRaw.rows || []).map(fightFromRow);
  watchFights(recent);
  // Latest fights by type, as in the Discord channels: 1v1, 8v8 and the rest
  // the winning side decides: 1v2 is solo, 6v8 is "other" (Eden lists
  // a fight only when the smaller side or an even side won)
  const kind = ["all", "solo", "8v8", "other"].includes(store.get("efa-ov-kind", "all")) ? store.get("efa-ov-kind", "all") : "all";
  let latest = recent;
  if (kind === "solo") latest = recent.filter(f => f.ws === 1);
  if (kind === "8v8") latest = ((await api.feed(48, 8, 300, ctx.silent).catch(() => ({ rows: [] }))).rows || []).map(fightFromRow).filter(f => f.ws >= 8);
  if (kind === "other") latest = ((await api.feed(24, null, 3000, ctx.silent).catch(() => ({ rows: [] }))).rows || []).map(fightFromRow).filter(f => f.ws >= 2 && f.ws <= 7);
  if (!ctx.alive()) return;
  updateLive(pulse.last);
  const before = state.ui.overSeen || new Set();
  state.ui.overSeen = new Set(recent.map(f => f.id));

  const sizes = (pulse.sizes || []).map(([s, c]) => ({ label: s === 1 ? "Solo" : s === 8 ? "8+" : `${s}`, value: Number(c), sub: `${fmt1(pct(c, pulse.day))}%`, set: null }));
  const zones = (pulse.zones || []).map(([z, c]) => ({ label: esc(z), value: Number(c), sub: "" }));
  const classes = (pulse.classes || []).map(([cls, realm, c, players]) => ({ label: classHtml(cls, realm), value: Number(c), sub: `${fmt(players)} players` }));
  const people = (list, unit) => oppListHtml((list || []).map(([name, cls, realm, n]) => ({ name, realm, n, sub: esc(className(cls)) })), "n", unit);
  const hours = (pulse.hours || []).map(([t, c]) => [Number(t) * SECOND, Number(c)]).sort((a, b) => a[0] - b[0])
    .map(([t, c]) => ({ n: c, short: fmtClock(new Date(t)), label: `${fmtClock(new Date(t))}` }));
  const underdogs = (pulse.underdogs || []).map(([id, ts, ws, ls, wr, lr, w, l, zone]) => fightFromRow([id, ts, ws, ls, wr, lr, null, w, l, zone]));
  const solo = (pulse.sizes || []).find(([s]) => s === 1);
  const winsList = winsSpan === "7d"
    ? ((wins7 && wins7.rows) || []).map(r => ({ name: r.n, realm: r.r, n: r.w, sub: esc(className(r.c)) }))
    : (pulse.kills_hour || []).map(([name, cls, realm, n]) => ({ name, realm, n, sub: esc(className(cls)) }));
  const gainRows = (gains && gains.rows) || [];
  const streakRows = ((streaks7 && streaks7.rows) || []).map(r => ({ name: r.n, realm: r.r, n: r.w, sub: esc(className(r.c)) }));
  const miniSeg = (key, cur, opts) => `<span class="seg mini">${opts.map(([v, l]) => `<button class="${String(cur) === String(v) ? "on" : ""}" data-store="${key}" data-val="${v}">${l}</button>`).join("")}</span>`;
  const favList = favs();

  ctx.view.innerHTML = `
    <div class="page-head">
      <div><h1>Eden right now</h1><p>Live from Eden's fight feed. Updates every minute while this page is open.</p></div>
    </div>
    <div class="tiles">
      ${tile("Fights today", fmt(pulse.today), "since midnight")}
      ${tile("Last 24 hours", fmt(pulse.day), solo ? `${fmt1(pct(solo[1], pulse.day))}% solo` : "fights")}
      ${tile("Active players", fmt(pulse.active), "last 24 hours")}
      ${tile("Biggest upset", underdogs.length ? `${underdogs[0].ws}v${underdogs[0].ls}` : "-", underdogs.length ? `${esc(underdogs[0].winners.slice(0, 2).join(", "))}${underdogs[0].winners.length > 2 ? " ..." : ""}` : "smaller side won, 24 h")}
      ${tile("Last fight", ago(pulse.last), pulse.last ? fmtDate(new Date(pulse.last)) : "")}
    </div>

    <div class="grid g-main" style="margin-top:16px">
      <div class="stack">
        <div class="panel">${hoursBarsHtml(hours, "Fights per hour · last 24 h")}</div>
        <div class="panel">
          <h2>Latest fights ${miniSeg("efa-ov-kind", kind, [["all", "All"], ["solo", "Solo"], ["8v8", "8v8"], ["other", "Other"]])}<a class="right more" href="#/fights?h=24">All fights</a></h2>
          ${fightListHtml(latest, "over", f => fightHtml(f, null, { isNew: before.size && !before.has(f.id) }))}

        </div>
      </div>
      <div class="stack">
        <div class="panel">
          <h2>Most wins ${miniSeg("efa-ov-wins", winsSpan, [["1h", "1 h"], ["7d", "7 days"]])}<a class="right more" href="#/leaderboard?k=wins&h=168">More</a></h2>
          ${oppListHtml(winsList.slice(0, 8), "n", "")}
        </div>
        <div class="panel">
          <h2>Elo · 7 days ${miniSeg("efa-ov-gainkind", gainKind, [["gain", "Rising"], ["loss", "Falling"]])} ${miniSeg("efa-ov-gain", gainBucket, BRACKETS.map(([v, l]) => [v, l]))}<a class="right more" href="#/leaderboard?k=${gainKind}&b=${gainBucket}&h=168">More</a></h2>
          ${gainRows.length ? `<div class="list">${gainRows.map((r, i) => `<div class="li"><span class="rank">${i + 1}</span><span class="lm">${realmDot(r.r)}${nameHtml(r.n)} <span class="sub">${fmt(r.rating)} · ${r.w}-${r.l}</span></span><span class="lv ${r.gain >= 0 ? "w" : "l"}">${r.gain >= 0 ? "+" : ""}${fmt(r.gain)}</span></div>`).join("")}</div>`
            : `<div class="empty">${gains && gains.cur && !eloCaughtUp(gains.cur) ? `The Elo is still being calculated (up to ${esc(eloUpTo(gains.cur))}).` : "No data yet."}</div>`}
        </div>
        <div class="panel">
          <h2>Win streaks · 7 days<a class="right more" href="#/leaderboard?k=streak&h=168">More</a></h2>
          ${oppListHtml(streakRows, "n", "W")}
        </div>
        ${favList.length ? `<div class="panel" id="fav-panel"><h2>Your favorites</h2><div class="list">${favList.map(n => `<div class="li" data-favcard="${esc(n)}"><span class="lm">${nameHtml(n)}</span><span class="ls"><span class="spin"></span></span></div>`).join("")}</div></div>` : ""}
      </div>
    </div>

    <div class="panel" style="margin-top:16px">
      <h2>Biggest underdog wins · 24 h</h2>
      ${underdogs.length ? `<div class="fights">${underdogs.map(f => fightHtml(f, null)).join("")}</div>` : `<div class="empty">None in the last 24 hours.</div>`}
    </div>

    <div class="grid g2" style="margin-top:16px">
      <div class="panel"><h2>Group sizes · 24 h</h2>${barsHtml(sizes)}</div>
      <div class="panel"><h2>Zones · 24 h</h2>${barsHtml(zones, { wide: true })}</div>
    </div>

    <div class="grid g2" style="margin-top:16px">
      <div class="panel"><h2>Classes played · 24 h<a class="right more" href="#/classes?w=0">Class win rates</a></h2>${barsHtml(classes, { wide: true })}</div>
      <div class="panel"><h2>Busy times · last 30 days <em>${esc(tzLabel())}</em></h2>${heatmapHtml(heat)}</div>
    </div>
  `;
  fillFavCards(ctx);
};

async function fillFavCards(ctx) {
  for (const el of $$("[data-favcard]", ctx.view)) {
    const name = el.dataset.favcard;
    api.card(name).then(c => {
      if (!ctx.alive()) return;
      const n7 = (c.wins7 || 0) + (c.losses7 || 0);
      $(".ls", el).innerHTML = `${n7 ? `<span class="w">${c.wins7}</span>/<span class="l">${c.losses7}</span> · 7 d · ` : ""}${esc(ago(c.last))}`;
    }).catch(() => { $(".ls", el).textContent = ""; });
  }
}

function updateLive(last) {
  const el = $("#live");
  if (!last) return;
  const age = Date.now() - Date.parse(last);
  el.classList.toggle("ok", age < 20 * MINUTE);
  el.classList.toggle("stale", age >= 20 * MINUTE);
  $("span", el).textContent = `Last fight ${ago(last)}`;
}

// ------------------------------------------------------------------
// View: Fights
// ------------------------------------------------------------------

const hoursParam = (params, fallback) => {
  const h = params.has("h") ? Number(params.get("h")) : fallback;
  return PERIODS.includes(h) ? h : fallback;
};
const sizeParam = params => {
  const s = Number(params.get("s") || 0);
  return s >= 1 && s <= 8 ? s : 0;
};

VIEWS.fights = async (ctx, route) => {
  const hours = hoursParam(route.params, 24);
  const size = sizeParam(route.params);
  const key = `feed|${hours || null}|${size}|3000`;
  if (!ctx.silent && !peek(key)) ctx.view.innerHTML = `${fightsHeadHtml(hours, size)}${loadingHtml()}`;
  const data = await api.feed(hours || null, size, 3000, ctx.silent);
  if (!ctx.alive()) return;
  const fights = (data.rows || []).map(fightFromRow);
  const total = Number(data.total) || fights.length;

  let secs = 0;
  let timed = 0;
  let fast = 0;
  let slow = 0;
  const sizes = new Map();
  const players = new Map();
  const groups = new Map();
  const groups8 = new Map();
  for (const f of fights) {
    const big = bigSide(f);
    if (f.secs != null) {
      secs += f.secs; timed += 1;
      const dc = durClass(f.secs, big);
      if (dc === "fast") fast += 1;
      if (dc === "slow") slow += 1;
    }
    const label = `${f.ws}v${f.ls}`;
    if (!sizes.has(label)) sizes.set(label, { label, big, n: 0, secs: 0, timed: 0 });
    const s = sizes.get(label);
    s.n += 1;
    if (f.secs != null) { s.secs += f.secs; s.timed += 1; }
    const add = (name, realm, won) => {
      const k = norm(name);
      if (!players.has(k)) players.set(k, { name, realm, wins: 0, losses: 0 });
      const p = players.get(k);
      if (won) p.wins += 1; else p.losses += 1;
    };
    f.winners.forEach(n => add(n, f.wr, true));
    f.losers.forEach(n => add(n, f.lr, false));
    if (big >= 2) {
      const target = big >= 8 ? groups8 : groups;
      addGroup(target, f.winners, f.wr, true);
      addGroup(target, f.losers, f.lr, false);
    }
  }
  const list = [...players.values()];
  const topBy = (k, other) => list.filter(p => p[k] > 0).sort((a, b) => b[k] - a[k] || a[other] - b[other]).slice(0, 8)
    .map(p => ({ ...p, sub: `${fmt1(pct(p.wins, p.wins + p.losses))}% of ${p.wins + p.losses}` }));
  const sizeRows = [...sizes.values()].sort((a, b) => a.big - b.big || a.label.localeCompare(b.label)).slice(0, 18)
    .map(s => ({ label: s.label, value: s.n, sub: s.timed ? `Ø ${fmtDur(Math.round(s.secs / s.timed))}` : "", set: `s=${capSize(Math.max(...s.label.split("v").map(Number)))}`, title: "Show only this group size" }));
  const first = fights.length ? fights[fights.length - 1].date : null;
  const last = fights.length ? fights[0].date : null;
  const capped = fights.length < total;
  const bucketCount = hours && hours >= 3 ? Math.min(hours, 48) : 0;

  ctx.view.innerHTML = `
    ${fightsHeadHtml(hours, size)}
    <div class="tiles">
      ${tile("Fights", fmt(total), `${esc(periodLabel(hours))} · ${esc(sizeLabel(size))}`)}
      ${tile("Average time", timed ? fmtDur(Math.round(secs / timed)) : "-", "per fight")}
      ${tile("Fast", `<span class="fast">${fmt(fast)}</span>`, "shortest fifth for the size")}
      ${tile("Long", `<span class="slow">${fmt(slow)}</span>`, "longest fifth for the size")}
      ${tile("Covers", last ? fmtDate(last) : "-", first ? `back to ${fmtDate(first)}${capped ? `, newest ${fmt(fights.length)}` : ""}` : "")}
    </div>
    ${bucketCount ? `<div class="panel" style="margin-top:16px">${hoursBarsHtml(hourBuckets(fights, bucketCount), `Fights per hour · last ${bucketCount} h`)}</div>` : ""}
    <div class="grid g3" style="margin-top:16px">
      <div class="panel"><h2>Matchups</h2>${barsHtml(sizeRows)}</div>
      <div class="panel"><h2>Most wins</h2>${oppListHtml(topBy("wins", "losses"), "wins")}</div>
      <div class="panel"><h2>Most losses</h2>${oppListHtml(topBy("losses", "wins"), "losses")}</div>
    </div>
    <div class="grid g2" style="margin-top:16px">${groupsHtml(sortedGroups(groups8), "Recurring groups · 8v8")}${groupsHtml(sortedGroups(groups), "Recurring groups · other")}</div>
    <div class="panel" style="margin-top:16px">
      <h2>All fights <em>${fmt(fights.length)}${capped ? ` of ${fmt(total)}` : ""}</em></h2>
      ${fightListHtml(fights, "fights", f => fightHtml(f, null))}
    </div>
    ${capped ? `<div class="note">Statistics from the newest ${fmt(fights.length)} of ${fmt(total)} fights.</div>` : ""}
  `;
};

function fightsHeadHtml(hours, size) {
  return `
    <div class="page-head"><div><h1>Fights</h1><p>Every fight in the shared database. Group size: one of the two sides has this size.</p></div></div>
    <div class="ctrls panel">
      <div class="ctrl"><label>Period</label>${sliderHtml(hours)}</div>
      <div class="ctrl"><label>Group</label>${segHtml("s", size, SIZE_OPTIONS)}</div>
    </div>`;
}

// ------------------------------------------------------------------
// View: Player
// ------------------------------------------------------------------

VIEWS.player = async (ctx, route) => {
  const name = capitalize(route.arg.trim());
  if (!name) { location.hash = "#/fights"; return; }
  const hours = hoursParam(route.params, 0);
  const size = sizeParam(route.params);
  const vsName = capitalize((route.params.get("vs") || "").trim());

  if (!ctx.silent && !peek(`pfeed|${norm(name)}`)) ctx.view.innerHTML = loadingHtml();
  const [data, card] = await Promise.all([api.playerFeed(name, ctx.silent), api.card(name).catch(() => null)]);
  if (!ctx.alive()) return;
  const realName = data.name || name;
  if (realName !== name) {
    history.replaceState(null, "", buildHash("player", realName, Object.fromEntries(route.params.entries())));
    state.route.arg = realName;
    renderFavs();
  }
  document.title = `${realName} · Eden Fight Analyzer`;
  const fights = (data.rows || []).map(fightFromRow);
  const all = playerRows(fights, realName);
  const since = hours ? Date.now() - hours * HOUR : 0;
  const bracket = [1, 2, 3].includes(Number(route.params.get("br"))) ? Number(route.params.get("br")) : 0;
  const bracketOf = n => (n <= 1 ? 1 : n <= 5 ? 2 : 3);
  const inPeriod = all.filter(r => r.fight.date.getTime() >= since);
  const rows = inPeriod.filter(r => (!size || capSize(r.size) === size) && (!bracket || bracketOf(r.size) === bracket));

  const [profile, elos] = await Promise.all([
    api.profile(realName, hours || null, size).catch(() => null),
    api.playerElo(realName).catch(() => [])
  ]);
  if (!ctx.alive()) return;
  // [bucket, rating, rank, peak, games, wins, losses, gain 7 days]
  const eloOf = b => (elos || []).find(e => e[0] === b);

  const cls = card && card.class;
  const realm = card && card.realm;
  const r = profile && profile.rating;
  const wins = rows.filter(x => x.won).length;
  const n = rows.length;
  const st = streaks(rows);

  // opponents
  const opp = new Map();
  for (const row of rows) {
    for (const o of row.opponents) {
      const k = norm(o);
      if (!opp.has(k)) opp.set(k, { name: o, realm: row.enemyRealm, wins: 0, losses: 0 });
      const e = opp.get(k);
      if (row.won) e.wins += 1; else e.losses += 1;
    }
  }
  const oppList = [...opp.values()];
  const mostW = oppList.filter(e => e.wins).sort((a, b) => b.wins - a.wins || a.losses - b.losses).slice(0, 8)
    .map(e => ({ ...e, sub: `${e.wins}-${e.losses}` }));
  const mostL = oppList.filter(e => e.losses).sort((a, b) => b.losses - a.losses || a.wins - b.wins).slice(0, 8)
    .map(e => ({ ...e, sub: `${e.wins}-${e.losses}` }));

  // own group sizes
  const bySize = new Map();
  for (const row of rows) {
    const s = capSize(row.size);
    if (!bySize.has(s)) bySize.set(s, { s, w: 0, l: 0 });
    const e = bySize.get(s);
    if (row.won) e.w += 1; else e.l += 1;
  }

  // setups and enemy groups
  const setups = new Map();
  const enemies = new Map();
  for (const row of rows) {
    if (row.mates.length) addGroup(setups, [realName, ...row.mates], row.ownRealm, row.won);
    if (row.opponents.length >= 2) addGroup(enemies, row.opponents, row.enemyRealm, row.won);
  }

  // active hours (local time)
  const hourCount = new Array(24).fill(0);
  rows.forEach(row => { hourCount[row.fight.date.getHours()] += 1; });

  // head to head
  let h2h = null;
  if (vsName) {
    const t = norm(vsName);
    h2h = rows.filter(row => row.opponents.some(o => norm(o) === t));
  }

  const vs = (profile && profile.vs) || [];
  const zones = (profile && profile.zones) || [];
  const showAllVs = !!state.ui.allVs;
  const fav = isFav(realName);

  state.ui.copy = () => {
    const lines = [
      `**${realName}**${cls ? ` (${className(cls)}, ${REALM_SHORT[realm] || "?"})` : ""} · ${periodLabel(hours)} · ${sizeLabel(size)}`,
      `${fmt1(pct(wins, n))}% win rate · ${fmt(n)} fights (${fmt(wins)} W / ${fmt(n - wins)} L) · current ${st.now}`,
      (elos || []).length ? `Elo ${(elos || []).map(e => `${bracketName(e[0])} ${fmt(e[1])}${e[2] ? ` (#${fmt(e[2])})` : ""}`).join(" · ")}` : "",
      appUrl(buildHash("player", realName, {}))
    ].filter(Boolean);
    return lines.join("\n");
  };

  ctx.view.innerHTML = `
    <div class="panel">
      <div class="hero">
        <div>
          <h1>${esc(realName)}</h1>
          <div class="hero-sub">
            ${cls ? classHtml(cls, realm) : `<span>Class not known yet</span>`}
            ${realm ? `<span>${REALMS[realm]}</span>` : ""}
            <span>Last fight ${esc(ago(card && card.last))}</span>
            <span>${fmt(all.length)} fights in the database</span>
          </div>
        </div>
        <div class="acts">
          <button class="btn star ${fav ? "on" : ""}" data-act="fav" data-name="${esc(realName)}" title="Favorites appear at the top and can notify you">${fav ? "★ Favorite" : "☆ Favorite"}</button>
          <a class="btn" href="${buildHash("compare", "", { a: realName })}">Compare</a>
          <button class="btn" data-act="copy" title="Short summary for Discord">Copy</button>
          <button class="btn" data-act="share" data-url="${esc(appUrl(buildHash("player", realName, Object.fromEntries(route.params.entries()))))}">Copy link</button>
        </div>
      </div>
    </div>

    <div class="tiles" style="margin-top:16px">
      ${BRACKETS.map(([b, label, hint]) => {
        const e = eloOf(b);
        if (!e) return tile(`Elo ${label}`, "-", `no ${label.toLowerCase()} fights`);
        const [, rating, rank, peak, games, w, l, gain, rd, opp, est] = e;
        const g = gain ? ` · <span class="${gain > 0 ? "w" : "l"}">${gain > 0 ? "+" : ""}${fmt(gain)}</span> 7 d` : "";
        const provisional = rd != null && rd > 200;
        const status = rank ? `rank ${fmt(rank)}` : games < 20 ? `${fmt(games)} of 20 fights` : "provisional";
        return `<div class="tile" title="${esc(hint)}: ${fmt(w)} W / ${fmt(l)} L, peak ${fmt(peak)}${provisional ? ". Provisional: not enough recent, meaningful fights for a reliable value" : ""}"><span>Elo ${label}</span><strong>${fmt(rating)}${rd != null ? `<small class="rd">±${fmt(rd)}</small>` : ""}</strong><em>${status}${g}</em>${w ? `<em>${fmt1(pct(est || 0, w))}% of wins vs high Elo</em>` : ""}</div>`;
      }).join("")}
      ${tile("Last 7 days", card ? `<span class="w">${fmt(card.wins7)}</span> / <span class="l">${fmt(card.losses7)}</span>` : "-", card && card.wins7 + card.losses7 ? `${fmt1(pct(card.wins7, card.wins7 + card.losses7))}% won` : "no fights")}
      ${tile("All time", card ? `<span class="w">${fmt(card.wins)}</span> / <span class="l">${fmt(card.losses)}</span>` : "-", card && card.wins + card.losses ? `${fmt1(pct(card.wins, card.wins + card.losses))}% won` : "")}
    </div>

    <div class="ctrls panel" style="margin-top:16px">
      <div class="ctrl"><label>Period</label>${sliderHtml(hours)}</div>
      <div class="ctrl"><label>Group</label>${segHtml("s", size, SIZE_OPTIONS.map(([v, l]) => [v, l, v ? `Own group: ${sizeLabel(v)}` : "All group sizes"]))}</div>
    </div>

    ${n ? `
    <div class="grid g-main">
      <div class="stack">
        <div class="panel">
          <h2>${esc(periodLabel(hours))} · ${esc(sizeLabel(size))}</h2>
          <div class="sum">
            <div class="big"><strong class="${pct(wins, n) >= 50 ? "w" : "l"}">${fmt1(pct(wins, n))}%</strong><span class="k">Win rate</span></div>
            <div class="kv"><strong>${fmt(n)}</strong><span class="k">Fights</span></div>
            <div class="kv"><strong><span class="w">${fmt(wins)}</span> / <span class="l">${fmt(n - wins)}</span></strong><span class="k">W / L</span></div>
            <div class="kv"><strong class="${st.nowWon ? "w" : "l"}">${st.now}</strong><span class="k">Current</span></div>
            <div class="kv"><strong><span class="w">${st.bestW}W</span> <span class="l">${st.bestL}L</span></strong><span class="k">Best streaks</span></div>
          </div>
          <div class="ratebar"><span style="width:${pct(wins, n).toFixed(1)}%"></span></div>
          <div class="form">Last ${Math.min(15, n)} ${rows.slice(0, 15).map(x => `<span class="dot ${x.won ? "w" : "l"}" title="${fmtDate(x.fight.date)} · ${x.won ? "won" : "lost"} ${x.fight.ws}v${x.fight.ls}"></span>`).join("")}</div>
          <div class="brackets">${BRACKETS.map(([b, label, hint]) => {
            const list = inPeriod.filter(r => bracketOf(r.size) === b);
            const w = list.filter(r => r.won).length;
            const on = bracket === b;
            return `<button class="bracket ${on ? "on" : ""} ${list.length ? "" : "empty"}" data-set="br=${on ? "" : b}&s=" title="${esc(hint)}${list.length ? ". Click to show only these fights" : ""}">
              <span class="bk-name">${label}</span>
              <span class="bk-rate ${list.length ? (pct(w, list.length) >= 50 ? "w" : "l") : ""}">${list.length ? `${fmt1(pct(w, list.length))}%` : "-"}</span>
              <span class="bk-wl">${list.length ? `<span class="w">${fmt(w)}</span> / <span class="l">${fmt(list.length - w)}</span>` : "no fights"}</span>
            </button>`;
          }).join("")}</div>
        </div>

        <div class="panel">
          <h2>Head-to-head</h2>
          <div class="cmp-in">
            <div class="field"><input id="h2h" placeholder="Opponent name" value="${esc(vsName)}" autocomplete="off" spellcheck="false"><div class="suggest" hidden></div></div>
            <button class="btn primary" data-act="h2h">Show</button>
            ${vsName ? `<button class="btn" data-set="vs=">Clear</button><a class="btn" href="${buildHash("compare", "", { a: realName, b: vsName })}">Compare both</a>` : ""}
          </div>
          ${h2h ? (h2h.length ? `
            <div class="sum" style="margin-top:14px">
              <div class="big"><strong class="${pct(h2h.filter(x => x.won).length, h2h.length) >= 50 ? "w" : "l"}">${fmt1(pct(h2h.filter(x => x.won).length, h2h.length))}%</strong><span class="k">${esc(realName)} wins</span></div>
              <div class="kv"><strong><span class="w">${h2h.filter(x => x.won).length}</span> / <span class="l">${h2h.filter(x => !x.won).length}</span></strong><span class="k">W / L vs ${esc(vsName)}</span></div>
            </div>
            <div style="margin-top:12px">${fightListHtml(h2h, "h2h", x => fightHtml(x.fight, x))}</div>` : `<div class="empty">No fights against ${esc(vsName)} in this selection.</div>`) : ""}
        </div>

        <div class="panel">
          <h2>Fights <em>${fmt(n)}</em></h2>
          ${fightListHtml(rows, "pf", x => fightHtml(x.fight, x))}
        </div>
      </div>

      <div class="stack">
        ${vs.length ? `
        <div class="panel">
          <h2>Against classes</h2>
          <div class="tbl-wrap"><table class="tbl">
            <thead><tr><th>Class</th><th class="num">Fights</th><th class="num">W</th><th class="num">L</th><th class="num">Win rate</th></tr></thead>
            <tbody>${(showAllVs ? vs : vs.slice(0, 12)).map(([c, rr, w, l]) => `
              <tr class="${w + l < 5 ? "thin" : ""}"><td>${classHtml(c, rr)}</td><td class="num">${fmt(w + l)}</td><td class="num w">${fmt(w)}</td><td class="num l">${fmt(l)}</td><td class="num"><b>${fmt1(pct(w, w + l))}%</b>${rateBar(pct(w, w + l))}</td></tr>`).join("")}</tbody>
          </table></div>
          ${!showAllVs && vs.length > 12 ? `<button class="btn full" data-act="allvs">Show all ${vs.length} classes</button>` : ""}
          <div class="note">Grey: fewer than 5 fights.</div>
        </div>` : ""}
        <div class="panel"><h2>Most wins against</h2>${oppListHtml(mostW, "wins")}</div>
        <div class="panel"><h2>Most losses against</h2>${oppListHtml(mostL, "losses")}</div>
        ${zones.length ? `<div class="panel"><h2>Zones</h2>${barsHtml(zones.map(([z, w, l]) => ({ label: esc(z), value: w + l, sub: `${fmt1(pct(w, w + l))}% won` })), { wide: true })}</div>` : ""}
        ${groupsHtml(sortedGroups(setups), "Own setups", "same group at least twice")}
        ${groupsHtml(sortedGroups(enemies), "Enemy groups", "your record against them")}
        <div class="panel">${hoursBarsHtml(hourCount.map((c, h) => ({ n: c, short: `${pad2(h)}`, label: `${pad2(h)}:00 to ${pad2((h + 1) % 24)}:00` })), `Active hours <em>${esc(tzLabel())}</em>`)}</div>
      </div>
    </div>` : `
    <div class="panel"><div class="empty">${all.length ? `No fights of ${esc(realName)} in this selection. <button class="btn sm" data-set="h=0&s=0">Show all</button>` : `No fights of ${esc(realName)} in the database. Check the spelling, names are exact.`}</div></div>`}
  `;
  attachSuggest($("#h2h"), pick => setParams({ vs: pick }));
};

// ------------------------------------------------------------------
// View: Classes
// ------------------------------------------------------------------

const CLASS_WINDOWS = [[24, "24 h"], [168, "7 days"], [720, "1 month"], [2160, "3 months"], [0, "Season"]];
const sorts = { cls: { key: "rate", dir: -1 }, vs: { key: "rate", dir: -1 }, pl: { key: "total", dir: -1 }, q: { key: "mid80", dir: -1 }, lb: { key: "rank", dir: 1, kind: "" } };

function sortList(rows, table, minFights) {
  const { key, dir } = sorts[table];
  const val = r => (key === "label" ? String(r.label).toLowerCase() : r[key] ?? -Infinity);
  const cmp = (a, b) => ((val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir) || b.total - a.total;
  if (key !== "rate" || !minFights) return [...rows].sort(cmp);
  return [...rows.filter(r => r.total >= minFights).sort(cmp), ...rows.filter(r => r.total < minFights).sort(cmp)];
}

function th(table, key, label, num = true, title = "") {
  const s = sorts[table];
  const on = s.key === key;
  return `<th class="sort ${num ? "num" : ""} ${on ? "on" : ""}" data-sort="${table}:${key}" ${title ? `title="${esc(title)}"` : ""}>${label}${on ? (s.dir < 0 ? " ▾" : " ▴") : ""}</th>`;
}

function rateTable(table, rows, minFights, firstLabel, rowAttrs) {
  return `
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr>${th(table, "label", firstLabel, false)}${th(table, "total", "Fights")}${th(table, "wins", "W")}${th(table, "losses", "L")}${th(table, "rate", "Win rate")}</tr></thead>
      <tbody>${sortList(rows, table, minFights).map(r => `
        <tr class="${rowAttrs ? "click" : ""} ${r.total < minFights ? "thin" : ""} ${r.sel ? "sel" : ""}" ${rowAttrs ? rowAttrs(r) : ""}>
          <td>${r.html}</td><td class="num">${fmt(r.total)}</td><td class="num w">${fmt(r.wins)}</td><td class="num l">${fmt(r.losses)}</td>
          <td class="num"><b>${fmt1(r.rate)}%</b>${rateBar(r.rate)}</td>
        </tr>`).join("")}</tbody>
    </table></div>`;
}

VIEWS.classes = async (ctx, route) => {
  const p = route.params;
  const view = ["rates", "quality", "matrix"].includes(p.get("v")) ? p.get("v") : "rates";
  const wi = Math.min(CLASS_WINDOWS.length - 1, Math.max(0, Number(p.has("w") ? p.get("w") : 1)));
  const hours = CLASS_WINDOWS[wi][0] || null;
  const size = sizeParam(p);
  const realm = [1, 2, 3].includes(Number(p.get("r"))) ? Number(p.get("r")) : 0;
  const [selC, selR] = (p.get("c") || "").split("-").map(Number);
  const sel = selC && selR ? { c: selC, r: selR } : null;
  const mr = [1, 2, 3].includes(Number(p.get("mr"))) ? Number(p.get("mr")) : 1;
  const mc = [1, 2, 3].includes(Number(p.get("mc"))) ? Number(p.get("mc")) : 2;

  const head = `
    <div class="page-head"><div><h1>Classes</h1><p>Win rates by class. Group size is your own side: a 1v3 counts as solo for the single player and as 3 for the three.</p></div></div>
    <div class="ctrls panel">
      <div class="ctrl"><label>View</label>${segHtml("v", view, [["rates", "Win rates"], ["quality", "Quality"], ["matrix", "Class vs class"]])}</div>
      <div class="ctrl"><label>Period</label>${segHtml("w", wi, CLASS_WINDOWS.map(([, l], i) => [i, l]))}</div>
      <div class="ctrl"><label>Group</label>${segHtml("s", size, SIZE_OPTIONS)}</div>
      ${view !== "matrix" ? `<div class="ctrl"><label>Realm</label>${segHtml("r", realm, REALM_OPTIONS)}</div>` : ""}
    </div>`;
  if (!ctx.silent && !peek(`cs|${hours}`)) ctx.view.innerHTML = head + loadingHtml();

  const [stats, counts] = await Promise.all([api.classStats(hours), api.fightCounts(hours)]);
  if (!ctx.alive()) return;
  const agg = new Map();
  for (const row of stats || []) {
    if (size && row.sz !== size) continue;
    if (realm && row.realm !== realm) continue;
    const k = `${row.class}|${row.realm}`;
    if (!agg.has(k)) agg.set(k, { c: row.class, r: row.realm, wins: 0, losses: 0 });
    const e = agg.get(k);
    e.wins += row.wins; e.losses += row.losses;
  }
  const entries = [...agg.values()].map(e => ({
    ...e, total: e.wins + e.losses, rate: pct(e.wins, e.wins + e.losses), label: className(e.c),
    html: classHtml(e.c, e.r), sel: sel && sel.c === e.c && sel.r === e.r
  }));
  const fights = (counts || []).filter(c => !size || c.sz === size).reduce((s, c) => s + c.n, 0);
  state.ui.copy = () => [
    `**Class win rates** · ${CLASS_WINDOWS[wi][1]} · ${sizeLabel(size)}${realm ? ` · ${REALMS[realm]}` : ""}`,
    ...sortList(entries, "cls", 20).filter(e => e.total >= 20).slice(0, 15).map((e, i) => `${i + 1}. ${e.label} (${REALM_SHORT[e.r]}) ${fmt1(e.rate)}% of ${fmt(e.total)}`),
    appUrl(location.hash)
  ].join("\n");

  const tiles = `
    <div class="tiles">
      ${tile("Fights", fmt(fights), `${CLASS_WINDOWS[wi][1]} · ${esc(sizeLabel(size))}`)}
      ${tile("Classes", fmt(entries.length), realm ? REALMS[realm] : "all realms")}
      ${(() => {
        const best = sortList(entries, "cls", 20).find(e => e.total >= 20);
        return tile("Best win rate", best ? `${fmt1(best.rate)}%` : "-", best ? `${esc(best.label)} (${REALM_SHORT[best.r]})` : "");
      })()}
      ${(() => {
        const most = [...entries].sort((a, b) => b.total - a.total)[0];
        return tile("Most played", most ? esc(most.label) : "-", most ? `${fmt(most.total)} fights` : "");
      })()}
    </div>`;

  let body = "";
  if (view === "rates") {
    let side = `<div class="panel"><h2>Pick a class</h2><div class="empty">Select a class in the table for its results against every other class and its players.</div></div>`;
    if (sel) {
      const [vsList, players] = await Promise.all([
        api.classVs(hours, size, sel.c, sel.r).catch(() => null),
        api.classPlayers(hours, size, sel.c, sel.r).catch(() => null)
      ]);
      if (!ctx.alive()) return;
      const vsRows = (vsList || []).map(e => ({ wins: e.wins, losses: e.losses, total: e.wins + e.losses, rate: pct(e.wins, e.wins + e.losses), label: className(e.oclass), html: classHtml(e.oclass, e.orealm) }));
      const plRows = (players || []).map(e => ({ ...e, total: e.wins + e.losses, rate: pct(e.wins, e.wins + e.losses), label: e.name, html: nameHtml(e.name) }));
      const minP = Math.max(10, weightedLowerQuartile(plRows.map(x => x.total)));
      const allPl = !!state.ui.allPlayers;
      const plSorted = sortList(plRows, "pl", minP);
      side = `
        <div class="panel">
          <h2>${classHtml(sel.c, sel.r)} <em>against classes</em><button class="right btn sm" data-set="c=">Close</button></h2>
          ${vsList ? rateTable("vs", vsRows, 10, "Against") : `<div class="empty">Not loaded.</div>`}
          <div class="note">Grey: fewer than 10 fights.</div>
        </div>
        <div class="panel">
          <h2>Players <em>${fmt(plRows.length)}</em></h2>
          ${players ? `
            <div class="tbl-wrap"><table class="tbl">
              <thead><tr>${th("pl", "label", "Player", false)}${th("pl", "total", "Fights")}${th("pl", "wins", "W")}${th("pl", "losses", "L")}${th("pl", "rate", "Win rate")}</tr></thead>
              <tbody>${(allPl ? plSorted : plSorted.slice(0, 30)).map(x => `
                <tr class="${x.total < minP ? "thin" : ""}"><td>${x.html}</td><td class="num">${fmt(x.total)}</td><td class="num w">${fmt(x.wins)}</td><td class="num l">${fmt(x.losses)}</td><td class="num"><b>${fmt1(x.rate)}%</b>${rateBar(x.rate)}</td></tr>`).join("")}</tbody>
            </table></div>
            ${!allPl && plSorted.length > 30 ? `<button class="btn full" data-act="allpl">Show all ${fmt(plSorted.length)} players</button>` : ""}
            <div class="note">Grey: fewer than ${minP} fights. The bar rises with the number of active players (at least 10). Grey rows go to the bottom when sorting by win rate.</div>` : `<div class="empty">Not loaded.</div>`}
        </div>`;
    }
    body = `
      <div class="grid g-main" style="margin-top:16px">
        <div class="panel">
          <h2>Win rate by class<span class="right"><button class="btn sm" data-act="copy">Copy</button></span></h2>
          ${entries.length ? rateTable("cls", entries, 20, "Class", e => `data-set="c=${e.sel ? "" : `${e.c}-${e.r}`}" title="${e.sel ? "Close the details" : "Opponents and players of this class"}"`) : `<div class="empty">No data for this selection yet.</div>`}
          <div class="note">Grey: fewer than 20 fights.</div>
        </div>
        <div class="stack">${side}</div>
      </div>`;
  } else if (view === "quality") {
    const rows = await api.quality(hours, size);
    if (!ctx.alive()) return;
    const list = (rows || []).map(([c, r, players, fightsN, fightWr, playerAvg, mid80, rating]) => ({
      c, r, players, fights: fightsN, fightWr, playerAvg, mid80, rating, total: fightsN,
      gap: fightWr != null && playerAvg != null ? playerAvg - fightWr : null, label: className(c)
    })).filter(x => !realm || x.r === realm);
    const pctOr = v => (v == null ? "-" : `${fmt1(v)}%`);
    body = `
      <div class="panel" style="margin-top:16px">
        <h2>Class quality</h2>
        <div class="explain">
          <p>A class win rate reflects both the strength of the class and the skill of the people who play it. This view reduces the second effect by looking at the players behind the numbers.</p>
          <ul>
            <li><b>Mid 80%</b>: win rate of the class without the best 10% and the worst 10% of its players. The most robust figure for comparing classes.</li>
            <li><b>Player avg</b>: average win rate per player. Each player counts equally, regardless of the number of fights.</li>
            <li><b>Fight WR</b>: win rate over all fights. Players with many fights carry more weight.</li>
            <li><b>Gap</b>: player avg minus fight WR. A large gap shows that a few very active players move the class result up or down.</li>
            <li><b>Avg Elo</b>: average solo Elo of the players of the class.</li>
          </ul>
          <p>Included are players with at least 20 fights and 5 wins in the season.</p>
        </div>
        ${list.length ? `<div class="tbl-wrap"><table class="tbl">
          <thead><tr>${th("q", "label", "Class", false)}${th("q", "mid80", "Mid 80%", true, "Fight-weighted win rate without the best and worst 10% of players")}${th("q", "playerAvg", "Player avg", true, "Every player counts the same")}${th("q", "fightWr", "Fight WR", true, "All fights of the qualifying players")}${th("q", "gap", "Gap", true, "Player avg minus fight WR")}${th("q", "players", "Players")}${th("q", "fights", "Fights")}${th("q", "rating", "Avg Elo", true, "Average 1v1 Elo of the class")}</tr></thead>
          <tbody>${sortList(list, "q").map(x => `
            <tr class="click ${x.players < 10 ? "thin" : ""}" data-set="v=rates&c=${x.c}-${x.r}">
              <td>${classHtml(x.c, x.r)}</td>
              <td class="num">${x.mid80 == null ? "-" : `<b>${fmt1(x.mid80)}%</b>${rateBar(x.mid80)}`}</td>
              <td class="num">${pctOr(x.playerAvg)}</td><td class="num">${pctOr(x.fightWr)}</td>
              <td class="num ${Math.abs(x.gap) > 2 ? "gold" : ""}">${x.gap == null ? "-" : `${x.gap > 0 ? "+" : ""}${fmt1(x.gap)}`}</td>
              <td class="num">${fmt(x.players)}</td><td class="num">${fmt(x.fights)}</td><td class="num">${x.rating ? fmt(x.rating) : "-"}</td>
            </tr>`).join("")}</tbody></table></div>` : `<div class="empty">No data for this selection yet.</div>`}

      </div>`;
  } else {
    const rows = await api.matrix(hours, size);
    if (!ctx.alive()) return;
    const cell = new Map();
    const rSet = new Set();
    const cSet = new Set();
    for (const [c, r, oc, or, w, l] of rows || []) {
      if (r === mr) rSet.add(c);
      if (or === mc) cSet.add(oc);
      if (r === mr && or === mc) cell.set(`${c}|${oc}`, [w, l]);
    }
    const byName = set => [...set].sort((a, b) => className(a).localeCompare(className(b)));
    const rl = byName(rSet);
    const cl = byName(cSet);
    const tone = rate => {
      const d = Math.max(-1, Math.min(1, (rate - 50) / 20));
      return d >= 0 ? `rgba(111, 207, 122, ${(0.12 + d * 0.7).toFixed(2)})` : `rgba(236, 111, 104, ${(0.12 - d * 0.7).toFixed(2)})`;
    };
    body = `
      <div class="panel" style="margin-top:16px">
        <h2>Class against class</h2>
        <div class="ctrls">
          <div class="ctrl"><label>Rows</label>${segHtml("mr", mr, REALM_OPTIONS.slice(1))}</div>
          <div class="ctrl"><label>Against</label>${segHtml("mc", mc, REALM_OPTIONS.slice(1))}</div>
        </div>
        ${rl.length && cl.length ? `
        <div class="mx" style="--cols:${cl.length}">
          <div class="mx-row head"><span></span>${cl.map(c => `<span title="${esc(className(c))}">${esc(className(c).slice(0, 4))}</span>`).join("")}</div>
          ${rl.map(rc => `
            <div class="mx-row">
              <span class="mx-name" data-set="v=rates&c=${rc}-${mr}" title="Details of this class">${classHtml(rc)}</span>
              ${cl.map(cc => {
                const [w, l] = cell.get(`${rc}|${cc}`) || [0, 0];
                const nn = w + l;
                const rate = pct(w, nn);
                const title = `${className(rc)} vs ${className(cc)}: ${nn ? `${fmt1(rate)}% (${fmt(w)} W / ${fmt(l)} L)` : "no fights"}`;
                return nn >= 15 ? `<i style="background:${tone(rate)}" title="${esc(title)}">${Math.round(rate)}</i>` : `<i class="thin" title="${esc(title)}">${nn ? Math.round(rate) : ""}</i>`;
              }).join("")}
            </div>`).join("")}
        </div>` : `<div class="empty">No data for this selection yet.</div>`}
        <div class="note">Win rate of the row class against the column class. Grey: fewer than 15 fights.</div>
      </div>`;
  }
  ctx.view.innerHTML = head + tiles + body;
};

// ------------------------------------------------------------------
// View: Leaderboard
// ------------------------------------------------------------------

const LB_KINDS = [["elo", "Elo"], ["gain", "Rising"], ["loss", "Falling"], ["wins", "Wins"], ["active", "Active"], ["underdog", "Underdog"], ["streak", "Streak"]];
const LB_PERIODS = [[24, "24 h"], [168, "7 days"], [720, "1 month"], [0, "Season"]];
const LB_TITLE = { elo: "Current Elo, reliable ratings only", gain: "Most Elo won in the period", loss: "Most Elo lost in the period", wins: "Most wins", winrate: "Best win rate", active: "Most fights", underdog: "Most wins as the smaller side", streak: "Longest win streak" };
const svgI = d => `<svg viewBox="0 0 20 20"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const LB_ICON = {
  elo: svgI("M4 15l4-4 3 3 5-6M13 8h3v3"),
  gain: svgI("M10 16V4M5 9l5-5 5 5"),
  loss: svgI("M10 4v12M5 11l5 5 5-5"),
  wins: svgI("M6 3h8v4a4 4 0 01-8 0zM10 11v4M7 17h6M6 5H3.5a2 2 0 002.5 3M14 5h2.5a2 2 0 01-2.5 3"),
  winrate: svgI("M4 16L16 4M6 5.5a1.5 1.5 0 100 .01M14 14.5a1.5 1.5 0 100 .01"),
  active: svgI("M3 10h3l2-5 4 10 2-5h3"),
  underdog: svgI("M4 15l3-6 3 3 3-7 3 10"),
  streak: svgI("M11 2L5 11h5l-1 7 6-9h-5z")
};

VIEWS.lb = async (ctx, route) => {
  const p = route.params;
  let kind = p.get("k") === "rating" ? "elo" : p.get("k");
  if (!LB_KINDS.some(([k]) => k === kind)) kind = "elo";
  const isElo = kind === "elo" || kind === "gain" || kind === "loss";
  const bucket = [1, 2, 3].includes(Number(p.get("b"))) ? Number(p.get("b")) : 1;
  const periods = kind === "gain" || kind === "loss" ? LB_PERIODS.filter(([h]) => h && h <= 720) : LB_PERIODS;
  let hours = periods.some(([h]) => String(h) === p.get("h")) ? Number(p.get("h")) : 168;
  const size = sizeParam(p);
  const realm = [1, 2, 3].includes(Number(p.get("r"))) ? Number(p.get("r")) : 0;
  const limit = p.get("n") === "100" ? 100 : 25;
  const head = `
    <div class="page-head"><div><h1>Leaderboard</h1></div></div>
    <div class="lb-kinds">${LB_KINDS.map(([k, label]) => `
      <button class="lb-kind ${k === kind ? "on" : ""}" data-set="k=${k}" title="${esc(LB_TITLE[k] || "")}">
        <span class="lk-icon">${LB_ICON[k] || ""}</span><span class="lk-name">${label}</span>
      </button>`).join("")}</div>
    <div class="filters panel">
      ${isElo ? `<div class="filter"><label>Bracket</label>${segHtml("b", bucket, BRACKETS.map(([v, l, t]) => [v, l, t]))}</div>` : ""}
      <div class="filter"><label>Period</label>${segHtml("h", hours, periods)}</div>
      ${!isElo ? `<div class="filter"><label>Group</label>${segHtml("s", size, SIZE_OPTIONS)}</div>` : ""}
      <div class="filter"><label>Realm</label>${segHtml("r", realm, REALM_OPTIONS)}</div>
    </div>`;
  if (!ctx.silent) ctx.view.innerHTML = head + loadingHtml();
  const data = isElo
    ? await api.eloBoard(bucket, kind === "elo" ? "rating" : kind, hours, realm, limit)
    : await api.leaderboard(kind, hours, size, realm, limit);
  if (!ctx.alive()) return;
  const rows = (data && data.rows) || [];
  const rate = (w, l) => (w + l ? `${fmt1(pct(w, w + l))}%` : "-");
  const rateV = r => (r.w + r.l ? r.w / (r.w + r.l) : -1);
  const wl = r => `<span class="w">${fmt(r.w)}</span> / <span class="l">${fmt(r.l)}</span>`;
  const chg = r => `<span class="${r.gain >= 0 ? "w" : "l"}">${r.gain >= 0 ? "+" : ""}${fmt(r.gain)}</span>`;
  // [label, cell, sort value]
  const cols = {
    elo: [["Elo", r => fmt(r.rating), r => r.rating], ["Peak", r => fmt(r.peak), r => r.peak], ["Win rate", r => rate(r.w, r.l), rateV],
          ["vs high Elo", r => (r.est != null && r.w ? `${fmt1(pct(r.est, r.w))}%` : "-"), r => (r.w ? (r.est || 0) / r.w : -1)], ["W / L", wl, r => r.w + r.l]],
    loss: [["Change", chg, r => r.gain], ["Elo now", r => fmt(r.rating), r => r.rating], ["W / L", wl, r => r.w + r.l], ["Win rate", r => rate(r.w, r.l), rateV]],
    gain: [["Change", chg, r => r.gain], ["Elo now", r => fmt(r.rating), r => r.rating], ["W / L", wl, r => r.w + r.l], ["Win rate", r => rate(r.w, r.l), rateV]],
    wins: [["Wins", r => fmt(r.w), r => r.w], ["Fights", r => fmt(r.w + r.l), r => r.w + r.l], ["Win rate", r => rate(r.w, r.l), rateV]],
    active: [["Fights", r => fmt(r.w + r.l), r => r.w + r.l], ["W / L", wl, r => r.w], ["Win rate", r => rate(r.w, r.l), rateV]],
    underdog: [["Underdog wins", r => fmt(r.w), r => r.w], ["Biggest gap", r => (r.fid ? `<a class="pl" href="#/report/${encodeURIComponent(r.fid)}" title="Open this fight">+${fmt(r.best)} enemies</a>` : `+${fmt(r.best)}`), r => r.best]],
    streak: [["Longest streak", r => `${fmt(r.w)}W`, r => r.w]]
  }[kind];
  const ls = sorts.lb;
  if (ls.kind !== kind) { ls.kind = kind; ls.key = "rank"; ls.dir = 1; }
  const ranked = rows.map((r, i) => ({ r, i }));
  if (ls.key === "name") ranked.sort((a, b) => a.r.n.localeCompare(b.r.n) * ls.dir);
  else if (ls.key !== "rank" && cols[Number(ls.key)]) { const f = cols[Number(ls.key)][2]; ranked.sort((a, b) => ((f(a.r) - f(b.r)) * ls.dir) || a.i - b.i); }
  else if (ls.dir < 0) ranked.reverse();
  const lth = (key, label, num = true) => `<th class="sort ${num ? "num" : ""} ${ls.key === key ? "on" : ""}" data-sort="lb:${key}">${label}${ls.key === key ? (ls.dir < 0 ? " ▾" : " ▴") : ""}</th>`;
  const building = isElo && data && data.cur && !eloCaughtUp(data.cur);
  const note = {
    elo: `<div class="notes">
      <div><b>Elo</b><span>Rating system Glicko-2. Each value also has an uncertainty (shown on the player page); it shrinks with every meaningful fight and grows slowly during breaks (back to the starting value after about three years).</span></div>
      <div><b>Listed</b><span>Only reliable values (uncertainty 200 or less), from 20 fights, active in the chosen period.</span></div>
      <div><b>Weighting</b><span>A fight counts by the season experience of the less experienced side. Solo: almost nothing below 20 fights, about 70% at 50, in full from 100. Small and Group: in full from 20, and each person's share gets smaller the larger the own side.</span></div>
      <div><b>Repeats</b><span>Several solo fights against the same opponent within 24 hours count less each time.</span></div>
      <div><b>vs high Elo</b><span>Share of wins against strong opponents, measured by their Elo at the time of the fight: Solo from 1600, Small from 1650, Group from 1700 (team average). That is roughly the top quarter of all opponents.</span></div>
      <div><b>Brackets</b><span>Each side counts by its own size: Solo, Small (2 to 5), Group (6 and more).</span></div>
    </div>`,
    loss: "Elo lost in the period, at least 3 fights in the period. Only players with a reliable value (as in the Elo list).",
    gain: "Elo won in the period, at least 3 fights in the period. Only players with a reliable value (as in the Elo list).",
    underdog: "Wins where the own side was smaller. Biggest gap shows the largest difference in one fight.",
    streak: `Longest run of wins within the period, at most the last ${data.days || 30} days.`
  }[kind] || "";

  ctx.view.innerHTML = `${head}
    ${building ? `<div class="warn info" style="margin-bottom:16px"><span>The Elo is still being calculated from all fights since the start of the season, currently up to ${esc(eloUpTo(data.cur))}. The numbers grow into place over the next minutes.</span></div>` : ""}
    <div class="panel">
      ${rows.length ? `<div class="tbl-wrap"><table class="tbl">
        <thead><tr>${lth("rank", "#", false)}${lth("name", "Player", false)}<th>Class</th>${cols.map(([l], k) => lth(String(k), l)).join("")}</tr></thead>
        <tbody>${ranked.map(({ r, i }) => `
          <tr class="${i < 3 ? `top${i + 1}` : ""}"><td class="rank-c">${i + 1}</td><td>${realmDot(r.r)}${nameHtml(r.n)}</td><td class="muted">${r.c ? esc(className(r.c)) : ""}</td>${cols.map(([, f], k) => `<td class="num ${k === 0 ? "main" : ""}">${f(r)}</td>`).join("")}</tr>`).join("")}</tbody>
      </table></div>
      ${limit < 100 && rows.length >= 25 ? `<button class="btn full" data-set="n=100">Show top 100</button>` : ""}` : `<div class="empty">No players for this selection yet.</div>`}
      ${note ? `<div class="note">${note}</div>` : ""}
    </div>`;
};

// ------------------------------------------------------------------
// View: Compare
// ------------------------------------------------------------------

VIEWS.compare = async (ctx, route) => {
  const a = capitalize((route.params.get("a") || "").trim());
  const b = capitalize((route.params.get("b") || "").trim());
  const head = `
    <div class="page-head"><div><h1>Compare</h1><p>Two players side by side, with every fight between them.</p></div></div>
    <div class="panel ctrls">
      <div class="cmp-in">
        <div class="field"><input id="cmp-a" placeholder="First player" value="${esc(a)}" autocomplete="off" spellcheck="false"><div class="suggest" hidden></div></div>
        <button class="btn" data-act="swap" title="Swap">⇄</button>
        <div class="field"><input id="cmp-b" placeholder="Second player" value="${esc(b)}" autocomplete="off" spellcheck="false"><div class="suggest" hidden></div></div>
        <button class="btn primary" data-act="compare">Compare</button>
      </div>
    </div>`;
  const wire = () => {
    attachSuggest($("#cmp-a"), pick => setParams({ a: pick }));
    attachSuggest($("#cmp-b"), pick => setParams({ b: pick }));
  };
  if (!a || !b) {
    ctx.view.innerHTML = `${head}<div class="panel"><div class="empty">Pick two players. Tip: the Compare button on a player page fills in the first name.</div></div>`;
    wire();
    return;
  }
  if (!ctx.silent) ctx.view.innerHTML = head + loadingHtml();
  const [feedA, cardA, cardB, profA, profB, eloA, eloB] = await Promise.all([
    api.playerFeed(a), api.card(a).catch(() => null), api.card(b).catch(() => null),
    api.profile(a, null, 0).catch(() => null), api.profile(b, null, 0).catch(() => null),
    api.playerElo(a).catch(() => []), api.playerElo(b).catch(() => [])
  ]);
  if (!ctx.alive()) return;
  const nameA = (cardA && cardA.name) || a;
  const nameB = (cardB && cardB.name) || b;
  const rowsA = playerRows((feedA.rows || []).map(fightFromRow), nameA);
  const tb = norm(nameB);
  const h2h = rowsA.filter(r => r.opponents.some(o => norm(o) === tb));
  const together = rowsA.filter(r => r.mates.some(m => norm(m) === tb));
  const hw = h2h.filter(r => r.won).length;
  const tw = together.filter(r => r.won).length;
  const ra = profA && profA.rating;
  const rb = profB && profB.rating;

  const line = (label, va, vb, num = null, higherBetter = true) => {
    let ca = "";
    let cb = "";
    if (num && num[0] != null && num[1] != null && num[0] !== num[1]) {
      const aWins = higherBetter ? num[0] > num[1] : num[0] < num[1];
      ca = aWins ? "better" : "";
      cb = aWins ? "" : "better";
    }
    return `<div class="cmp-row"><span class="${ca}">${va}</span><span class="ck">${label}</span><span class="${cb}">${vb}</span></div>`;
  };
  const tot = c => (c ? c.wins + c.losses : 0);
  const rate7 = c => (c ? pct(c.wins7, c.wins7 + c.losses7) : null);

  // classes both have fought, side by side
  const vsMap = new Map();
  for (const [prof, idx] of [[profA, 0], [profB, 1]]) {
    for (const [c, r, w, l] of (prof && prof.vs) || []) {
      const k = `${c}|${r}`;
      if (!vsMap.has(k)) vsMap.set(k, { c, r, s: [null, null] });
      vsMap.get(k).s[idx] = [w, l];
    }
  }
  const vsRows = [...vsMap.values()].filter(e => e.s[0] && e.s[1] && e.s[0][0] + e.s[0][1] >= 5 && e.s[1][0] + e.s[1][1] >= 5)
    .sort((x, y) => (y.s[0][0] + y.s[0][1] + y.s[1][0] + y.s[1][1]) - (x.s[0][0] + x.s[0][1] + x.s[1][0] + x.s[1][1])).slice(0, 14);
  const vsCell = s => `${fmt1(pct(s[0], s[0] + s[1]))}% <span class="sub">of ${fmt(s[0] + s[1])}</span>`;

  const heroMini = (name, card) => `
    <div class="panel">
      <div class="hero"><div>
        <h1 style="font-size:24px">${nameHtml(name)}</h1>
        <div class="hero-sub">${card && card.class ? classHtml(card.class, card.realm) : "Class not known"}<span>Last fight ${esc(ago(card && card.last))}</span></div>
      </div></div>
    </div>`;

  ctx.view.innerHTML = `${head}
    <div class="vs-head">${heroMini(nameA, cardA)}<span class="vs">vs</span>${heroMini(nameB, cardB)}</div>
    <div class="grid g2" style="margin-top:16px">
      <div class="panel">
        <h2>Numbers</h2>
        ${BRACKETS.map(([bk, label]) => {
          const ea = (eloA || []).find(e => e[0] === bk);
          const eb = (eloB || []).find(e => e[0] === bk);
          if (!ea && !eb) return "";
          const show = e => (e ? `${fmt(e[1])}${e[2] ? ` <span class="sub">#${fmt(e[2])}</span>` : ""}` : "-");
          return line(`Elo ${label}`, show(ea), show(eb), [ea && ea[1], eb && eb[1]]);
        }).join("")}
        ${line("All fights", fmt(tot(cardA)), fmt(tot(cardB)), [tot(cardA), tot(cardB)])}
        ${line("Win rate all", cardA ? `${fmt1(pct(cardA.wins, tot(cardA)))}%` : "-", cardB ? `${fmt1(pct(cardB.wins, tot(cardB)))}%` : "-", [cardA && pct(cardA.wins, tot(cardA)), cardB && pct(cardB.wins, tot(cardB))])}
        ${line("Last 7 days", cardA ? `${cardA.wins7} / ${cardA.losses7}` : "-", cardB ? `${cardB.wins7} / ${cardB.losses7}` : "-", [rate7(cardA), rate7(cardB)])}
      </div>
      <div class="panel">
        <h2>Against each other</h2>
        ${h2h.length ? `
          <div class="sum">
            <div class="big"><strong class="${hw * 2 >= h2h.length ? "w" : "l"}">${hw} : ${h2h.length - hw}</strong><span class="k">${esc(nameA)} : ${esc(nameB)}</span></div>
            <div class="kv"><strong>${fmt(h2h.length)}</strong><span class="k">Fights</span></div>
            <div class="kv"><strong>${h2h[0] ? esc(ago(h2h[0].fight.date)) : "-"}</strong><span class="k">Last one</span></div>
          </div>
          <div class="ratebar"><span style="width:${pct(hw, h2h.length).toFixed(1)}%"></span></div>` : `<div class="empty">They have not fought each other.</div>`}
        ${together.length ? `<div class="note">Same side ${fmt(together.length)} times, ${fmt1(pct(tw, together.length))}% won.</div>` : ""}
      </div>
    </div>
    ${vsRows.length ? `
    <div class="panel" style="margin-top:16px">
      <h2>Against classes</h2>
      <div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Class</th><th class="num">${esc(nameA)}</th><th class="num">${esc(nameB)}</th></tr></thead>
        <tbody>${vsRows.map(e => {
          const ra2 = pct(e.s[0][0], e.s[0][0] + e.s[0][1]);
          const rb2 = pct(e.s[1][0], e.s[1][0] + e.s[1][1]);
          return `<tr><td>${classHtml(e.c, e.r)}</td><td class="num ${ra2 > rb2 ? "w" : ""}">${vsCell(e.s[0])}</td><td class="num ${rb2 > ra2 ? "w" : ""}">${vsCell(e.s[1])}</td></tr>`;
        }).join("")}</tbody>
      </table></div>
    </div>` : ""}
    ${h2h.length ? `<div class="panel" style="margin-top:16px"><h2>Fights between them <em>from ${esc(nameA)}'s side</em></h2>${fightListHtml(h2h, "cmp", x => fightHtml(x.fight, x))}</div>` : ""}
  `;
  wire();
};

// ------------------------------------------------------------------
// View: Fight report
// The full report comes from the userscript on Eden's fight page (button
// "Open in Fight Analyzer"). Without it the app shows what the database
// knows: both line-ups, duration and zone.
// ------------------------------------------------------------------

const REPORT_PREFIX = "efa-report:";
const REALM_ID = { Albion: 1, Midgard: 2, Hibernia: 3 };
const ROLE_ORDER = ["Caster", "Tank", "Stealth", "Support"];
const CLASS_ID = Object.fromEntries(Object.entries(CLASS_NAMES).map(([id, name]) => [name, Number(id)]));

function saveReport(report) {
  if (!report || !report.id) return;
  store.set(REPORT_PREFIX + report.id, { t: Date.now(), r: report });
  // keep the newest 15
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(REPORT_PREFIX))
      .map(k => [k, (store.get(k, {}) || {}).t || 0]).sort((a, b) => b[1] - a[1]);
    keys.slice(15).forEach(([k]) => localStorage.removeItem(k));
  } catch (e) { /* storage blocked */ }
}
const loadReport = id => (store.get(REPORT_PREFIX + id, null) || {}).r || null;

const short = n => (n >= 1e6 ? `${fmt1(n / 1e6)}m` : n >= 1000 ? `${fmt1(n / 1000)}k` : fmt(n));

function duelHtml(rows) {
  return `<div class="duel">${rows.map(r => {
    const max = Math.max(r.left, r.right, 1);
    const lLead = r.invert ? r.left < r.right : r.left > r.right;
    const rLead = r.invert ? r.right < r.left : r.right > r.left;
    const show = r.short ? short : fmt;
    return `
      <div class="duel-row"${r.hint ? ` title="${esc(r.hint)}"` : ""}>
        <span class="dv ${lLead ? "lead" : ""}">${show(r.left)}${r.leftNote ? `<i>${esc(r.leftNote)}</i>` : ""}</span>
        <div class="dm">
          <span class="dn">${esc(r.label)}</span>
          <div class="db"><div class="half l"><span style="width:${(r.left / max * 100).toFixed(1)}%"></span></div><div class="half r"><span style="width:${(r.right / max * 100).toFixed(1)}%"></span></div></div>
          ${r.sub ? `<span class="ds">${esc(r.sub)}</span>` : ""}
        </div>
        <span class="dv ${rLead ? "lead" : ""}">${show(r.right)}${r.rightNote ? `<i>${esc(r.rightNote)}</i>` : ""}</span>
      </div>`;
  }).join("")}</div>`;
}

function compHtml(side) {
  const c = side.comp || {};
  const roles = (c.roles || []).map(([role, n]) => `<span class="role-stat">${roleIcon(role)}<b>${n}</b> ${esc(role)}</span>`).join("");
  const chips = (c.groups || []).map(g => `<span class="cchip">${CLASS_ID[g.cls] ? classIcon(CLASS_ID[g.cls]) : roleIcon(g.role)}${g.count > 1 ? `<b>${g.count}×</b>` : ""}${esc(g.cls)}</span>`).join("");
  return `
    <div class="comp-side">
      <div class="comp-line"><span class="tag ${side.won ? "w" : "l"}">${side.won ? "W" : "L"}</span>${realmDot(REALM_ID[c.realm])}<span class="muted">${esc(c.realm || "?")}</span>${roles}${c.unknown ? `<span class="role-stat">${roleIcon("Unknown")}<b>${c.unknown}</b> unknown</span>` : ""}</div>
      <div class="comp-chips">${chips || '<span class="muted">-</span>'}</div>
      ${(c.core || []).length ? `<div class="comp-core">Support core: ${c.core.map(esc).join(" · ")}</div>` : ""}
    </div>`;
}

function rosterHtml(side) {
  const players = side.players || [];
  const team = k => players.reduce((sum, p) => sum + ((p.stats || {})[k] || 0), 0);
  const tDmg = team("dd");
  const tHeal = team("hd");
  // badges: the player with the most healing, crowd control (mez, stun,
  // root) and damage taken on this side; damage is the sort order anyway
  const ccOf = st => (st.tm || 0) + (st.ts || 0) + (st.tr || 0);
  const topOf = f => { const m = Math.max(...players.map(p => f(p.stats || {})), 0); return m > 0 && players.length > 1 ? m : null; };
  const topHeal = topOf(st => (st.hd >= 1000 ? st.hd : 0));
  const topCc = topOf(ccOf);
  const topTank = topOf(st => (st.dt >= 1000 ? st.dt : 0));
  const big = n => (n >= 1000 ? short(n) : null);
  const sorted = [...players].sort((a, b) => ((b.stats || {}).dd || 0) - ((a.stats || {}).dd || 0) || b.points - a.points);
  const realm = REALM_ID[(side.comp || {}).realm];
  return `
    <div class="roster">
      <h3 class="${side.won ? "w" : "l"}">${side.won ? "Winners" : "Losers"} ${realmDot(realm)}<span class="sub">${players.length}</span></h3>
      ${sorted.map(p => {
        const st = p.stats || {};
        const id = p.clsId || CLASS_ID[p.cls];
        const cc = [["tm", "mez"], ["ts", "stun"], ["tr", "root"], ["ta", "peel"], ["ti", "rupt"], ["br", "shear"], ["td", "disease"], ["tn", "ns"]]
          .filter(([k]) => st[k]).map(([k, l]) => `<span><b>${fmt(st[k])}</b> ${l}</span>`).join("");
        const dShare = tDmg && st.dd >= 1000 ? Math.round(st.dd / tDmg * 100) : 0;
        const hShare = tHeal && st.hd >= 1000 ? Math.round(st.hd / tHeal * 100) : 0;
        return `
          <div class="rp">
            <div class="rp-top">
              ${id ? classIcon(id) : roleIcon(p.role)}
              ${nameHtml(p.name)}${p.name === side.leader ? '<span class="lead-mark" title="Group leader">★</span>' : ""}
              <span class="sub">${esc(p.cls || "unknown")}${p.guild ? ` · &lt;${esc(p.guild)}&gt;` : ""}</span>
              ${topHeal && st.hd === topHeal ? '<span class="mvp heal" title="Most healing of the side">top heal</span>' : ""}
              ${topCc && ccOf(st) === topCc ? `<span class="mvp cc" title="Most mez, stun and root of the side: ${topCc}">top cc</span>` : ""}
              ${topTank && st.dt === topTank ? '<span class="mvp tank" title="Most damage taken of the side">top tank</span>' : ""}
              <span class="rr" title="${fmt(p.points)} realm rank steps">${esc(p.rank || "")}</span>
            </div>
            <div class="rp-nums">
              ${big(st.dd) ? `<span title="Damage done"><b class="dmg">${big(st.dd)}</b> dmg${dShare ? `<i>${dShare}%</i>` : ""}</span>` : ""}
              ${big(st.dt) ? `<span title="Damage taken"><b>${big(st.dt)}</b> taken</span>` : ""}
              ${big(st.hd) ? `<span title="Healing done"><b class="heal">${big(st.hd)}</b> heal${hShare ? `<i>${hShare}%</i>` : ""}</span>` : ""}
              ${big(st.hr) ? `<span title="Healing received"><b>${big(st.hr)}</b> recv</span>` : ""}
              ${cc}
              ${st.d ? `<span class="l" title="Deaths">✝ ${st.d}</span>` : ""}
            </div>
          </div>`;
      }).join("")}
    </div>`;
}

// The same report the userscript builds, made from Eden's fight data
const CORE = { 1: ["Cleric", "Friar", "Minstrel"], 2: ["Healer", "Healer", "Shaman"], 3: ["Bard", "Druid", "Warden"] };
const CC_KEYS = [["tm", "Mezzed"], ["ts", "Stunned"], ["tr", "Rooted"], ["ta", "Peeled"], ["td", "Diseased"], ["tn", "Nearsighted"], ["ti", "Interrupted"], ["br", "Sheared"]];
const rankIndex = (rp, table) => { let i = 0; for (let k = 0; k < table.length; k += 1) { if (table[k] <= rp) i = k; else break; } return i; };
const rankLabel = i => `${Math.floor(i / 10) + 1}L${i % 10}`;

function reportFromEden(raw, rp) {
  const guilds = raw.gu || {};
  const side = (sd, won) => {
    const players = (sd.p || []).map(p => {
      const st = { ...(p.s || {}) };
      st.rn = (st.ri || []).length;
      delete st.ri; delete st.di;
      const idx = rankIndex(p.rp || 0, rp || []);
      const cls = CLASS_NAMES[p.c] || null;
      return { name: p.n, cls, clsId: p.c, rank: rankLabel(idx), points: idx, role: cls ? (ROLE_OF[cls] || "Tank") : "Unknown",
               guild: p.g && guilds[p.g] ? guilds[p.g].n : "", stats: st };
    });
    const known = players.filter(p => p.cls).map(p => p.cls);
    const variable = [...known];
    const core = [];
    if (players.length >= 6) for (const c of CORE[sd.r] || []) { const i = variable.indexOf(c); if (i >= 0) { variable.splice(i, 1); core.push(c); } }
    const counts = new Map();
    variable.forEach(c => counts.set(c, (counts.get(c) || 0) + 1));
    const roles = ROLE_ORDER.map(r => [r, variable.filter(c => (ROLE_OF[c] || "Tank") === r).length]).filter(([, n]) => n).sort((x, y) => y[1] - x[1]);
    const order = roles.map(r => r[0]);
    const groups = [...counts.entries()].map(([c, n]) => ({ cls: c, count: n, role: ROLE_OF[c] || "Tank" }))
      .sort((x, y) => order.indexOf(x.role) - order.indexOf(y.role) || y.count - x.count || x.cls.localeCompare(y.cls));
    return { won, size: sd.s || players.length, leader: sd.l || "", players,
             comp: { realm: REALMS[sd.r] || null, roles, groups, core, unknown: players.length - known.length } };
  };
  const win = side(raw.a || {}, true);
  const loss = side(raw.b || {}, false);
  const sum = (ps, k) => ps.reduce((t, p) => t + (p.stats[k] || 0), 0);
  const tot = ps => ({ dd: sum(ps, "dd"), dt: sum(ps, "dt"), hd: sum(ps, "hd"), d: sum(ps, "d"), rn: sum(ps, "rn") });
  const pts = ps => ps.reduce((t, p) => t + p.points, 0);
  const avgLabel = ps => (ps.length ? rankLabel(Math.round(pts(ps) / ps.length)) : "-");
  return {
    v: 1, id: raw.id, t: raw.s, d: raw.d, matchup: `${(raw.a || {}).s || win.players.length}v${(raw.b || {}).s || loss.players.length}`,
    win, loss,
    cc: CC_KEYS.map(([k, label]) => [label, sum(win.players, k), sum(loss.players, k)]),
    totals: { 1: tot(win.players), 2: tot(loss.players) },
    ra: [pts(win.players), pts(loss.players), avgLabel(win.players), avgLabel(loss.players)]
  };
}

// Ask the database for Eden's fight data; the first time it fetches it
// from Eden, which takes a second or two.
async function loadEdenReport(id, alive) {
  for (let i = 0; i < 14; i += 1) {
    const res = await api.fightDetail(id);
    if (!alive()) return null;
    if (res && res.status === "ok") {
      const report = reportFromEden(res.data, res.rp);
      saveReport(report);
      return report;
    }
    if (!res || res.status === "error" || res.status === "busy") return { failed: res ? (res.error || res.status) : "no answer" };
    await new Promise(r => setTimeout(r, i < 4 ? 700 : 1500));
  }
  return { failed: "Eden did not answer in time" };
}

VIEWS.report = async (ctx, route) => {
  const id = String(route.arg || "").toLowerCase();
  if (!/^[0-9a-z]{1,10}$/.test(id)) { ctx.view.innerHTML = `<div class="panel"><div class="empty">No fight id.</div></div>`; return; }
  let report = loadReport(id);
  if (!report && window.opener && !state.ui.askedOpener) {
    state.ui.askedOpener = true;
    try { window.opener.postMessage({ type: "efa-ready", id }, "*"); } catch (e) { /* no opener */ }
  }
  if (ctx.silent && report) return; // a finished report does not change
  if (!ctx.silent) ctx.view.innerHTML = `<div class="panel"><div class="empty"><span class="spin"></span> Loading the fight ...</div></div>`;
  const row = await api.fight(id).catch(() => null);
  if (!ctx.alive()) return;
  let failed = "";
  if (!report) {
    const got = await loadEdenReport(id, ctx.alive);
    if (!ctx.alive()) return;
    if (got && !got.failed) report = got;
    else failed = got ? got.failed : "";
  }
  const f = row ? fightFromRow(row) : null;
  if (f) await loadChars([...f.winners, ...f.losers]);
  if (!ctx.alive()) return;

  const date = f ? f.date : report && report.t ? new Date(report.t) : null;
  const secs = report && report.d != null ? report.d : f ? f.secs : null;
  const size = f ? bigSide(f) : report ? Math.max((report.win.players || []).length, (report.loss.players || []).length) : 1;
  const dc = durClass(secs, size);
  const matchup = report ? report.matchup : f ? `${f.ws}v${f.ls}` : "";
  const head = `
    <div class="page-head">
      <div>
        <h1>Fight report <span class="muted">${esc(matchup)}</span></h1>
        <p>${date ? `${fmtDay(date)} ${fmtClock(date)}` : ""}${secs != null ? ` · <span class="${dc}">${fmtDur(secs)}</span>` : ""}${f && f.zone ? ` · ${esc(f.zone)}` : ""}</p>
      </div>
      <div class="acts">
        <button class="btn" data-act="share" data-url="${esc(appUrl(`#/report/${id}`))}">Copy link</button>
        <a class="btn" href="${EDEN_FIGHT_URL(id)}" target="_blank" rel="noopener">Open on Eden</a>
      </div>
    </div>`;

  if (!report) {
    const side = (names, realm, won) => `
      <div class="roster">
        <h3 class="${won ? "w" : "l"}">${won ? "Winners" : "Losers"} ${realmDot(realm)}<span class="sub">${names.length}</span></h3>
        ${names.map(n => { const i = chars.get(n); return `<div class="rp"><div class="rp-top">${i && i.c ? classIcon(i.c) : roleIcon("Unknown")}${nameHtml(n)}<span class="sub">${i && i.c ? esc(className(i.c)) : ""}</span></div></div>`; }).join("")}
      </div>`;
    ctx.view.innerHTML = `${head}
      <div class="warn" style="margin-bottom:16px"><span>The full report could not be loaded from Eden right now${failed ? ` (${esc(failed)})` : ""}. Shown below: the line-ups from the database.</span><button class="btn" data-act="retry">Try again</button></div>
      ${f ? `<div class="grid g2">${side(f.winners, f.wr, true)}${side(f.losers, f.lr, false)}</div>` : `<div class="panel"><div class="empty">This fight is not in the database.</div></div>`}`;
    return;
  }

  const t = report.totals || { 1: {}, 2: {} };
  const ra = report.ra || [0, 0, "", ""];
  const rez = side => (t[side] && t[side].rn ? `${t[side].rn} rez` : "");
  const hero = side => {
    const names = (side.players || []).map(p => p.name);
    const lead = names.indexOf(side.leader);
    if (lead > 0) names.unshift(names.splice(lead, 1)[0]);
    return `
      <div class="hero-side ${side.won ? "is-win" : "is-loss"}">
        <div class="hs-head"><span class="tag ${side.won ? "w" : "l"}">${side.won ? "Victory" : "Defeat"}</span>${realmDot(REALM_ID[(side.comp || {}).realm])}<span class="muted">${esc((side.comp || {}).realm || "?")}</span><span class="right sub">${names.length} ${names.length === 1 ? "player" : "players"}</span></div>
        <div class="hs-names">${names.map(nameHtml).join(" ")}</div>
      </div>`;
  };

  ctx.view.innerHTML = `${head}
    <div class="vs-head">${hero(report.win)}<span class="vs">vs</span>${hero(report.loss)}</div>
    <div class="panel" style="margin-top:16px"><h2>Comp</h2>${compHtml(report.win)}${compHtml(report.loss)}</div>
    <div class="grid g2" style="margin-top:16px">
      <div class="panel"><h2>Totals</h2>${duelHtml([
        { label: "Damage", left: t[1].dd || 0, right: t[2].dd || 0, short: true },
        { label: "Healing", left: t[1].hd || 0, right: t[2].hd || 0, short: true },
        { label: "Deaths", left: t[1].d || 0, right: t[2].d || 0, invert: true, leftNote: rez(1), rightNote: rez(2) },
        { label: "Realm ranks", left: ra[0] || 0, right: ra[1] || 0, sub: `Ø ${ra[2]} vs ${ra[3]}`, hint: "Sum of realm rank steps" }
      ])}</div>
      <div class="panel"><h2>Crowd control and support</h2>${(() => { const rows = (report.cc || []).filter(([, l, r]) => l || r); return rows.length ? duelHtml(rows.map(([label, l, r]) => ({ label, left: l, right: r }))) : `<div class="empty">No crowd control in this fight.</div>`; })()}</div>
    </div>
    <div class="grid g2" style="margin-top:16px">
      <div class="panel">${rosterHtml(report.win)}</div>
      <div class="panel">${rosterHtml(report.loss)}</div>
    </div>
    <div class="note">Damage and healing from 1k. Percent: share of the own side.</div>`;
};

window.addEventListener("message", event => {
  if (!/^https:\/\/(www\.)?eden-daoc\.net$/.test(event.origin)) return;
  const data = event.data;
  if (!data || data.type !== "efa-report" || !data.report || !data.report.id) return;
  saveReport(data.report);
  if (state.route.page === "report" && String(state.route.arg).toLowerCase() === String(data.report.id).toLowerCase()) render();
  else location.hash = `#/report/${encodeURIComponent(data.report.id)}`;
});

// ------------------------------------------------------------------
// Name suggestions
// ------------------------------------------------------------------

function attachSuggest(input, onPick) {
  if (!input || input.dataset.wired) return;
  input.dataset.wired = "1";
  const box = input.parentElement.querySelector(".suggest");
  let items = [];
  let active = -1;
  let timer = null;
  let seq = 0;

  const close = () => { box.hidden = true; active = -1; };
  const draw = () => {
    if (!items.length) {
      box.innerHTML = `<div class="s-empty">No player found. Enter opens the name as typed.</div>`;
      return;
    }
    box.innerHTML = items.map(([name, c, r, elo, games], i) => `
      <a href="#/player/${encodeURIComponent(name)}" data-pick="${esc(name)}" class="${i === active ? "on" : ""}">
        ${realmDot(r)}${c ? classIcon(c) : ""}<b>${esc(name)}</b>
        <span class="s-sub">${c ? esc(className(c)) : ""}${elo && games >= 20 ? ` · Elo ${fmt(elo)}` : ""}</span>
      </a>`).join("");
  };
  const pick = name => {
    close();
    input.value = name;
    onPick(name);
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { close(); return; }
    timer = setTimeout(async () => {
      const my = ++seq;
      try {
        const list = await api.names(q);
        if (my !== seq || document.activeElement !== input) return;
        items = list || [];
        active = -1;
        draw();
        box.hidden = false;
      } catch (e) { close(); }
    }, 160);
  });
  input.addEventListener("keydown", event => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (box.hidden || !items.length) return;
      event.preventDefault();
      active = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      draw();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const name = active >= 0 && items[active] ? items[active][0] : capitalize(input.value.trim());
      if (name) pick(name);
    } else if (event.key === "Escape") {
      close();
    }
  });
  box.addEventListener("mousedown", event => {
    const a = event.target.closest("[data-pick]");
    if (!a) return;
    event.preventDefault();
    pick(a.dataset.pick);
  });
  input.addEventListener("blur", () => setTimeout(close, 120));
  document.addEventListener("mousedown", e => { if (!input.parentElement.contains(e.target)) close(); });
}

// ------------------------------------------------------------------
// Hover card for names
// ------------------------------------------------------------------

let popTimer = null;
let popFor = null;

function hidePop() {
  clearTimeout(popTimer);
  popFor = null;
  $("#pop").hidden = true;
}

function showPopFor(el) {
  const name = el.dataset.n;
  if (!name) return;
  popFor = el;
  clearTimeout(popTimer);
  popTimer = setTimeout(async () => {
    const viewing = state.route.page === "player" ? state.route.arg : "";
    const vs = viewing && norm(viewing) !== norm(name) ? [viewing] : null;
    let c;
    try { c = await api.card(name, vs); } catch (e) { return; }
    if (popFor !== el) return;
    const n = c.wins + c.losses;
    const n7 = c.wins7 + c.losses7;
    const pop = $("#pop");
    pop.innerHTML = `
      <h3>${realmDot(c.realm)}${c.class ? classIcon(c.class) : ""}${esc(c.name)}</h3>
      <div class="cp-sub">${c.class ? esc(className(c.class)) : "Class unknown"}${c.realm ? ` · ${REALMS[c.realm]}` : ""}</div>
      <div class="cp-kv">
        <span>All fights</span><b>${n ? `<span class="w">${fmt(c.wins)}</span> / <span class="l">${fmt(c.losses)}</span> · ${fmt1(pct(c.wins, n))}%` : "none"}</b>
        <span>Last 7 days</span><b>${n7 ? `<span class="w">${fmt(c.wins7)}</span> / <span class="l">${fmt(c.losses7)}</span> · ${fmt1(pct(c.wins7, n7))}%` : "none"}</b>
        <span>Last fight</span><b>${esc(ago(c.last))}</b>
        ${vs && (c.vs_wins || c.vs_losses) ? `<span>vs ${esc(viewing)}</span><b><span class="w">${c.vs_wins}</span> / <span class="l">${c.vs_losses}</span></b>` : ""}
      </div>`;
    const rect = el.getBoundingClientRect();
    pop.hidden = false;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = Math.min(window.innerWidth - w - 10, Math.max(10, rect.left));
    let top = rect.bottom + 8;
    if (top + h > window.innerHeight - 10) top = rect.top - h - 8;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }, 380);
}

// ------------------------------------------------------------------
// Events
// ------------------------------------------------------------------

document.addEventListener("click", event => {
  const t = event.target;

  const set = t.closest("[data-set]");
  if (set && !t.closest("a[href]:not([data-set])")) {
    event.preventDefault();
    const patch = Object.fromEntries(new URLSearchParams(set.dataset.set));
    if ("s" in patch || "h" in patch || "w" in patch || "r" in patch) state.ui.shown = {};
    if ("c" in patch) state.ui.allPlayers = false;
    if ("s" in patch && !("br" in patch) && state.route.page === "player") patch.br = "";
    setParams(patch);
    return;
  }

  const sort = t.closest("[data-sort]");
  if (sort) {
    const [table, key] = sort.dataset.sort.split(":");
    const s = sorts[table];
    if (s.key === key) s.dir = -s.dir; else { s.key = key; s.dir = key === "label" || key === "name" || key === "rank" ? 1 : -1; }
    render({ keepScroll: true });
    return;
  }

  const st = t.closest("[data-store]");
  if (st) {
    const v = st.dataset.val;
    store.set(st.dataset.store, /^\d+$/.test(v) ? Number(v) : v);
    render({ keepScroll: true });
    return;
  }

  const act = t.closest("[data-act]");
  if (act) {
    const a = act.dataset.act;
    if (a === "retry") render();
    if (a === "more") {
      state.ui.shown = state.ui.shown || {};
      state.ui.shown[act.dataset.key] = (state.ui.shown[act.dataset.key] || LIST_FIRST[act.dataset.key] || LIST_STEP) + LIST_STEP * 4;
      render({ keepScroll: true });
    }
    if (a === "fav") { toggleFav(act.dataset.name); render({ keepScroll: true }); }
    if (a === "copy" && state.ui.copy) copyText(state.ui.copy(), act);
    if (a === "share") copyText(act.dataset.url, act);
    if (a === "allvs") { state.ui.allVs = true; render({ keepScroll: true }); }
    if (a === "allpl") { state.ui.allPlayers = true; render({ keepScroll: true }); }
    if (a === "h2h") { const v = capitalize($("#h2h").value.trim()); setParams({ vs: v }); }
    if (a === "swap") { const p = state.route.params; setParams({ a: p.get("b") || "", b: p.get("a") || "" }); }
    if (a === "compare") setParams({ a: capitalize($("#cmp-a").value.trim()), b: capitalize($("#cmp-b").value.trim()) });
    return;
  }

  // a fight row opens and closes its line-ups; links inside keep working
  const fight = t.closest(".fight");
  if (fight && !t.closest("a, button, [data-stop]")) {
    const id = fight.dataset.fid;
    state.ui.open = state.ui.open || new Set();
    if (state.ui.open.has(id)) {
      state.ui.open.delete(id);
      const d = $(".f-detail", fight);
      if (d) d.remove();
      return;
    }
    state.ui.open.add(id);
    const f = findFight(id);
    if (!f) return;
    loadChars([...f.winners, ...f.losers]).then(() => {
      if (!state.ui.open.has(id) || $(".f-detail", fight)) return;
      fight.insertAdjacentHTML("beforeend", fightDetailHtml(f));
      hydrate(fight);
    });
  }
});

function findFight(id) {
  for (const { value } of memo.values()) {
    if (!value) continue;
    const rows = value.rows || value.underdogs;
    if (!Array.isArray(rows)) continue;
    const row = rows.find(r => Array.isArray(r) && String(r[0]) === id);
    if (row) return value.underdogs ? fightFromRow([row[0], row[1], row[2], row[3], row[4], row[5], null, row[6], row[7], row[8]]) : fightFromRow(row);
  }
  return null;
}

document.addEventListener("input", event => {
  if (event.target.matches("[data-period]")) {
    const h = PERIODS[Number(event.target.value)];
    $$(".slider .ticks span").forEach((s, i) => s.classList.toggle("on", i === Number(event.target.value)));
    clearTimeout(state.periodTimer);
    state.periodTimer = setTimeout(() => { state.ui.shown = {}; setParams({ h }); }, 220);
  }
});

document.addEventListener("mouseover", event => {
  const el = event.target.closest(".pl[data-n], .fav[data-n]");
  if (el && el !== popFor) showPopFor(el);
});
document.addEventListener("mouseout", event => {
  const el = event.target.closest(".pl[data-n], .fav[data-n]");
  if (el && !el.contains(event.relatedTarget)) hidePop();
});

document.addEventListener("mousedown", e => {
  if (state.favOpen && !e.target.closest(".fav-menu")) { state.favOpen = false; renderFavs(); }
});

document.addEventListener("keydown", event => {
  if (event.key === "/" && !/input|textarea/i.test(document.activeElement.tagName)) {
    event.preventDefault();
    $("#q").focus();
  }
  if (event.key === "Escape") hidePop();
});

$("#bell").addEventListener("click", toggleBell);
let lastReload = 0;
$("#reload").addEventListener("click", () => {
  const wait = 10 * SECOND - (Date.now() - lastReload);
  if (wait > 0) { toast(`Just reloaded. Again in ${Math.ceil(wait / SECOND)} s.`); return; }
  lastReload = Date.now();
  for (const [k, v] of memo) if (!v.pending) memo.delete(k);
  const btn = $("#reload");
  btn.classList.add("spinning");
  render({ keepScroll: true }).finally(() => setTimeout(() => btn.classList.remove("spinning"), 300));
});

// A new version of the app: say so once, reloading picks it up
const APP_V = (document.querySelector('script[src*="app.js"]') || {}).src?.match(/v=(\d+)/)?.[1] || "";
let versionShown = false;
async function checkVersion() {
  if (versionShown || !APP_V) return;
  try {
    const html = await (await fetch(`index.html?check=${Date.now()}`, { cache: "no-store" })).text();
    const live = (html.match(/app\.js\?v=(\d+)/) || [])[1];
    if (live && live !== APP_V) {
      versionShown = true;
      const el = document.createElement("div");
      el.className = "toast";
      el.innerHTML = `<b>New version available</b><div class="sub">Click to reload the app.</div>`;
      el.addEventListener("click", () => location.reload());
      $("#toasts").appendChild(el);
    }
  } catch (e) { /* offline */ }
}
setInterval(checkVersion, 10 * MINUTE);
attachSuggest($("#q"), name => {
  $("#q").value = "";
  $("#q").blur();
  location.hash = buildHash("player", name, {});
});

// ------------------------------------------------------------------
// Start
// ------------------------------------------------------------------

async function startup() {
  renderBell();
  api.marks().then(m => {
    if (!m) return;
    for (const [k, v] of Object.entries(m)) durationMarks[k] = v;
    // sizes without own numbers use the next smaller known size
    for (let s = 2; s <= 8; s += 1) if (!m[s] && m[s - 1]) durationMarks[s] = durationMarks[s - 1];
  }).catch(() => {});
  api.dbInfo().then(info => {
    $("#foot-db").textContent = `${fmt(info.fights)} fights · ${fmt(info.chars)} players · since ${fmtDay(new Date(info.first))}`;
  }).catch(() => {});
  api.pulse().then(p => updateLive(p.last)).catch(() => {});
  await render();

  // Background refresh: only while the page is visible
  setInterval(() => {
    if (document.hidden) return;
    const page = state.route.page;
    if (page === "over" || page === "fights" || page === "player") render({ silent: true });
    if (page !== "over") api.feed(3, null, 400, true).then(d => watchFights((d.rows || []).map(fightFromRow))).catch(() => {});
    api.pulse(true).then(p => updateLive(p.last)).catch(() => {});
  }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.route.page === "over") render({ silent: true });
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

window.EFA = { VERSION, state, memo };
startup();
