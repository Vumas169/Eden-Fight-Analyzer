// ==UserScript==
// @name         Eden Fight Analyzer by Vumas
// @author       Vumas
// @namespace    https://github.com/Vumas169/Eden-Fight-Analyzer
// @version      0.86
// @description  Winrate, head-to-head and overview from the fight list, class analysis from a shared database, plus RA and comp comparison on the fight detail page.
// @match        https://eden-daoc.net/fights*
// @match        https://www.eden-daoc.net/fights*
// @homepageURL  https://github.com/Vumas169/Eden-Fight-Analyzer
// @supportURL   https://github.com/Vumas169/Eden-Fight-Analyzer/issues
// @downloadURL  https://raw.githubusercontent.com/Vumas169/Eden-Fight-Analyzer/main/eden-winrate-analyzer.user.js
// @updateURL    https://raw.githubusercontent.com/Vumas169/Eden-Fight-Analyzer/main/eden-winrate-analyzer.user.js
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      bvbrhgyvwmhypmyuuqeu.supabase.co
// @run-at       document-idle
// ==/UserScript==

(() => {
  "use strict";

  // Two modes, depending on the URL:
  //   /fights            -> tab "Fights": overview, player stats and head-to-head
  //                         from Eden's fight list; tab "Analysis": class win
  //                         rates from the shared database; background collection
  //   /fights?id=XXXXXX  -> fight report for that single fight
  //
  // Realm rank as RA points: points = (RR - 1) * 10 + level
  // Examples: 2L0 = 10, 3L5 = 25, 8L3 = 73

  const VERSION = "0.86";

  // Optional own logo: put an image URL here. Empty means no image.
  const LOGO_URL = "";
  const markHtml = extra => (LOGO_URL ? `<img class="ewa-mark ${extra}" src="${LOGO_URL}" alt="Vumas">` : "");

  // Time units, so intervals below read as what they are
  const SECOND = 1000;
  const MINUTE = 60 * SECOND;
  const HOUR = 60 * MINUTE;
  const DAY = 24 * HOUR;

  // Eden's matchup filter and the group size buttons go up to this size
  const MAX_GROUP = 8;

  // The back to top button appears once the panel is scrolled this far (px)
  const TOP_BUTTON_FROM = 400;

  // ---------------------------------------------------------------
  // Fight duration (free to adjust)
  // ---------------------------------------------------------------

  // Limits in seconds per group size: fast = below "fast", long = from "slow".
  // The larger side of the matchup decides (8v7 counts as 8).
  //
  // Measured on 4,000 fights from the Eden list in October 2026. Each pair
  // is the 20 percent and the 80 percent mark of the durations, so roughly
  // one in five fights is fast and one in five is long. Once enough fights
  // are in the shared database these numbers are recalculated from it.
  const DURATION_BASE = {
    1: { fast: 12, slow: 50 },
    2: { fast: 30, slow: 90 },
    3: { fast: 38, slow: 105 },
    4: { fast: 45, slow: 120 },
    5: { fast: 55, slow: 130 },
    6: { fast: 60, slow: 135 },
    7: { fast: 65, slow: 140 },
    8: { fast: 70, slow: 155 }
  };

  const DURATION_FALLBACK = { fast: 85, slow: 190 }; // 9 players and more

  // Filled from the shared database, see tuneDurations()
  let durationTuned = {};

  function durationLimit(size) {
    return durationTuned[size] || DURATION_BASE[size] || DURATION_FALLBACK;
  }

  // ---------------------------------------------------------------
  // Comp settings (free to adjust)
  // ---------------------------------------------------------------

  // Default support core per realm. From SUPPORT_LINE_FROM players it is
  // taken out of the comp row and listed in the support line below it.
  const CORE = {
    Albion: ["Cleric", "Friar", "Minstrel"],
    Midgard: ["Healer", "Healer", "Shaman"],
    Hibernia: ["Bard", "Druid", "Warden"]
  };

  // Role per class, used to describe the variable slots.
  const ROLE = {
    Caster: [
      "Sorcerer", "Wizard", "Theurgist", "Cabalist", "Necromancer", "Heretic",
      "Runemaster", "Spiritmaster", "Bonedancer", "Warlock", "Thane",
      "Eldritch", "Enchanter", "Mentalist", "Animist", "Bainshee"
    ],
    Stealth: ["Infiltrator", "Scout", "Nightshade", "Ranger", "Hunter"],
    Support: ["Cleric", "Friar", "Minstrel", "Healer", "Shaman", "Bard", "Druid", "Warden"],
    Tank: [
      "Armsman", "Paladin", "Mercenary", "Reaver", "Mauler",
      "Champion", "Hero", "Blademaster", "Vampiir", "Valewalker",
      "Warrior", "Berserker", "Savage", "Valkyrie", "Skald", "Shadowblade"
    ]
  };
  const ROLE_ORDER = ["Caster", "Tank", "Stealth", "Support"];

  // The support line under a comp only appears from this group size up
  const SUPPORT_LINE_FROM = 6;

  // Classes whose role depends on the rest of the comp.
  // Occultist: caster with at least 2 sorcerers, tank with a paladin (celerity chant),
  // otherwise whichever role is more common in the variable slots.
  const FLEX_ROLE = {
    Occultist: variable => {
      const count = cls => variable.filter(c => c === cls).length;
      if (count("Sorcerer") >= 2) return "Caster";
      if (count("Paladin")) return "Tank";
      const others = variable.filter(c => !FLEX_ROLE[c]);
      const casters = others.filter(c => roleOf(c) === "Caster").length;
      const tanks = others.filter(c => roleOf(c) === "Tank").length;
      return casters >= tanks ? "Caster" : "Tank";
    }
  };

  // Custom labels. The first matching rule is shown in front.
  // Example: { label: "Double Tank", classes: ["Armsman", "Warrior", "Hero"], min: 2 }
  // Only the variable slots count, the support core is ignored.
  const COMP_RULES = [];

  const CLASS_REALM = {
    Armsman: "Albion", Paladin: "Albion", Cleric: "Albion", Mercenary: "Albion",
    Minstrel: "Albion", Reaver: "Albion", Scout: "Albion", Friar: "Albion",
    Infiltrator: "Albion", Theurgist: "Albion", Wizard: "Albion", Cabalist: "Albion",
    Sorcerer: "Albion", Heretic: "Albion", Necromancer: "Albion", Occultist: "Albion",
    Champion: "Hibernia", Druid: "Hibernia", Hero: "Hibernia", Warden: "Hibernia",
    Bard: "Hibernia", Blademaster: "Hibernia", Ranger: "Hibernia", Nightshade: "Hibernia",
    Vampiir: "Hibernia", Bainshee: "Hibernia", Animist: "Hibernia", Enchanter: "Hibernia",
    Mentalist: "Hibernia", Eldritch: "Hibernia", Valewalker: "Hibernia",
    Healer: "Midgard", Shaman: "Midgard", Skald: "Midgard", Thane: "Midgard",
    Warrior: "Midgard", Berserker: "Midgard", Hunter: "Midgard", Shadowblade: "Midgard",
    Valkyrie: "Midgard", Warlock: "Midgard", Savage: "Midgard", Bonedancer: "Midgard",
    Runemaster: "Midgard", Spiritmaster: "Midgard",
    Mauler: null // playable in all three realms
  };
  const REALM_SHORT = { Albion: "Alb", Midgard: "Mid", Hibernia: "Hib" };

  // Plain SVG icons of our own (no game art)
  const ICON = {
    Tank: '<svg viewBox="0 0 16 16"><path d="M8 1.5l5.5 2v4c0 3.5-2.4 5.8-5.5 7-3.1-1.2-5.5-3.5-5.5-7v-4z" fill="currentColor"/></svg>',
    Caster: '<svg viewBox="0 0 16 16"><path d="M8 1.5l1.6 4.9L14.5 8l-4.9 1.6L8 14.5l-1.6-4.9L1.5 8l4.9-1.6z" fill="currentColor"/></svg>',
    Stealth: '<svg viewBox="0 0 16 16"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="8" r="2" fill="currentColor"/></svg>',
    Support: '<svg viewBox="0 0 16 16"><path d="M6 2h4v4h4v4h-4v4H6v-4H2V6h4z" fill="currentColor"/></svg>',
    Unknown: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.3 6.3a1.8 1.8 0 113 1.4c-.8.5-1.3.9-1.3 1.8M8 11.6v.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
  };
  const ROLE_CLASS = { Caster: "caster", Tank: "tank", Stealth: "stealth", Support: "support", Unknown: "unknown" };

  const icon = role => `<span class="ewa-ico ewa-role-${ROLE_CLASS[role]}">${ICON[role]}</span>`;

  // ---------------------------------------------------------------
  // Eden data sources (JSON)
  // ---------------------------------------------------------------
  //   /chrplan/daoc.json      static data: class and race ids, RP thresholds
  //   /fghts/fight.php?<id>   one fight: side a = winner, b = loser

  const STATIC_URL = "/chrplan/daoc.json";
  const FIGHT_URL = id => `/fghts/fight.php?${encodeURIComponent(id)}`;
  const STATIC_CACHE_KEY = "ewa-static-v1";
  const STATIC_MAX_AGE = 7 * DAY;
  const FIGHT_CACHE_PREFIX = "ewa-fight-v1:";

  // Stat keys inside the fight JSON
  const STAT_KEYS = {
    "Targets Mezzed": "tm",
    "Targets Stunned": "ts",
    "Targets Rooted": "tr",
    "Targets Peeled": "ta",
    "Targets Diseased": "td",
    "Targets Nearsighted": "tn",
    "Targets Interrupted": "ti",
    "Targets Sheared": "br"
  };

  function storageGet(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch (error) {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      // Storage full or blocked, then we simply work without a cache
    }
  }

  // Only for the current tab: cleared when the tab closes, but it survives
  // the page reload that Eden does on a search.
  function sessionGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (error) {
      return null;
    }
  }

  function sessionSet(key, value) {
    try {
      sessionStorage.setItem(key, String(value));
    } catch (error) {
      // blocked, then the setting simply does not survive a reload
    }
  }

  function cachedStatic() {
    const cached = storageGet(STATIC_CACHE_KEY);
    return cached && Date.now() - cached.t < STATIC_MAX_AGE ? cached.v : null;
  }

  let staticPromise = null;

  function loadStatic() {
    const cached = cachedStatic();
    if (cached) return Promise.resolve(cached);

    if (!staticPromise) {
      staticPromise = (async () => {
        const response = await fetch(STATIC_URL, { credentials: "same-origin" });
        if (!response.ok) throw new Error(`Static data not loaded (HTTP ${response.status})`);
        const json = await response.json();
        const byId = obj => Object.fromEntries(Object.entries(obj || {}).map(([name, info]) => [info.id, name]));
        const value = { classes: byId(json.classes), races: byId(json.races), rp: json.rp || [] };
        storageSet(STATIC_CACHE_KEY, { t: Date.now(), v: value });
        return value;
      })().catch(error => {
        staticPromise = null;
        throw error;
      });
    }

    return staticPromise;
  }

  // Older versions cached fights in the browser. Not needed any more,
  // so clean it up once.
  function purgeFightCache() {
    try {
      Object.keys(localStorage)
        .filter(key => key.startsWith(FIGHT_CACHE_PREFIX))
        .forEach(key => localStorage.removeItem(key));
    } catch (error) {
      // never mind
    }
  }

  async function fetchFight(id) {
    const response = await fetch(FIGHT_URL(id), { credentials: "same-origin" });
    if (!response.ok) throw new Error(`Fight ${id} not loaded (HTTP ${response.status})`);
    const json = parseEdenJson(await response.text());

    // Keep only what we need
    const side = data => ({
      s: (data && data.s) || 0,
      p: ((data && data.p) || []).map(player => {
        const stats = { ...(player.s || {}) };
        stats.rn = (stats.ri || []).length; // number of resurrections
        delete stats.di;
        delete stats.ri;
        return { n: player.n, c: player.c, r: player.r, rp: player.rp, s: stats };
      })
    });

    return {
      id: json.id,
      d: json.d,
      t: json.s,
      a: { ...side(json.a), l: json.a && json.a.l },
      b: { ...side(json.b), l: json.b && json.b.l }
    };
  }

  // Realm rank from realm points, using the thresholds from daoc.json.
  // Index 69 = 7L9, index 103 = 11L3 and so on.
  function rankIndex(rp, table) {
    let index = 0;
    for (let i = 0; i < table.length; i += 1) {
      if (table[i] <= rp) index = i;
      else break;
    }
    return index;
  }

  function rankLabelOf(index) {
    return `${Math.floor(index / 10) + 1}L${index % 10}`;
  }

  function playersFromSide(side, stat) {
    return side.p.map(player => {
      const index = rankIndex(player.rp || 0, stat.rp);
      return {
        name: player.n,
        cls: stat.classes[player.c] || null,
        clsId: player.c,
        race: stat.races[player.r] || "",
        points: index,
        rankLabel: rankLabelOf(index),
        stats: player.s || {}
      };
    });
  }

  const $ = selector => document.querySelector(selector);

  // Everything that comes from Eden, the database or an input field goes
  // through this before it ends up in innerHTML or an attribute.
  const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => HTML_ESCAPES[ch]);
  const NUMBER_FORMAT = new Intl.NumberFormat("en-GB");
  const fmt = value => NUMBER_FORMAT.format(Number(value || 0));
  const fmt1 = value => Number(value || 0).toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  const RANK_EXACT = /^(\d{1,2})L(\d)$/;
  const RANK_LOOSE = /\b(\d{1,2})L(\d)\b/;

  function isDetailPage() {
    return new URLSearchParams(location.search).has("id");
  }

  // Strips everything but letters and digits and lowercases the rest, so that
  // realm icons, non-breaking spaces or odd characters in the name cell
  // cannot break the comparison.
  const NAME_CACHE = new Map();

  function normalizeName(value) {
    const raw = String(value ?? "");
    const cached = NAME_CACHE.get(raw);
    if (cached !== undefined) return cached;

    const clean = raw
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "")
      .toLowerCase();

    if (NAME_CACHE.size < 20000) NAME_CACHE.set(raw, clean);
    return clean;
  }

  // ---------------------------------------------------------------
  // Part 1: overview and player stats from the fight list
  // ---------------------------------------------------------------

  function findFightTable() {
    return document.querySelector("table#table_global")
      || document.querySelector("table.fullwidth");
  }

  function parseDateCell(text) {
    const match = text.match(/(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
    if (!match) return null;
    const date = new Date(`${match[1]}T${match[2]}:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  // Eden puts <span class="list_matchup_inline">1v1</span> in the date cell.
  // Do not read the whole cell text, "12:17" plus "1v1" would become "171v1".
  function readMatchupCell(dateCell) {
    const span = dateCell.querySelector(".list_matchup_inline");
    if (span) return parseMatchupFromText(span.textContent);
    const textSpan = dateCell.querySelector(".list_date_text");
    const rest = textSpan ? dateCell.textContent.replace(textSpan.textContent, " ") : dateCell.textContent;
    return parseMatchupFromText(rest);
  }

  function parseMatchupFromText(text) {
    const match = text.match(/\b(\d+)v(\d+)\b/i);
    return match ? `${match[1]}v${match[2]}` : "";
  }

  function namesFromCell(cell) {
    const links = [...cell.querySelectorAll("a")].map(a => a.textContent.trim()).filter(Boolean);
    const raw = links.length ? links : (cell.textContent.trim() ? [cell.textContent.trim()] : []);

    // When a group (2v2, 8v8) sits in one link or cell as a single string,
    // split it into the individual character names.
    const split = raw.flatMap(name =>
      name.split(/\s*(?:,|\/|;|\bund\b|\bu\.\b|&)\s*/i).map(part => part.trim()).filter(Boolean)
    );

    // Dedupe: several links to the same character (icon plus name) must
    // count only once per fight.
    const seen = new Set();
    const unique = [];

    for (const name of split) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(name);
    }

    return unique;
  }

  // Looks for a realm hint in the class names, image paths, alt and title
  // attributes of the name cell. Without a hit the realm stays empty.
  const REALM_TOKENS = [
    ["Albion", ["albion", "alb"]],
    ["Midgard", ["midgard", "mid"]],
    ["Hibernia", ["hibernia", "hib"]]
  ];

  // Built once. Creating these regexes per row and per element was a real
  // cost while reading a long fight list.
  const REALM_TOKEN_RE = REALM_TOKENS.map(([realm, tokens]) => [
    realm,
    tokens.map(token => new RegExp(`(^|[^a-z])${token}([^a-z]|$)`, "i"))
  ]);

  function realmFromCell(cell) {
    const bg = (cell.className || "").match(/(alb|mid|hib)bg/i);
    if (bg) return { alb: "Albion", mid: "Midgard", hib: "Hibernia" }[bg[1].toLowerCase()];

    const counts = {};
    for (const element of [cell, ...cell.querySelectorAll("*")]) {
      const text = ["class", "src", "alt", "title", "data-realm"]
        .map(attr => element.getAttribute(attr) || "").join(" ");
      if (!text.trim()) continue;
      for (const [realm, patterns] of REALM_TOKEN_RE) {
        if (patterns.some(re => re.test(text))) counts[realm] = (counts[realm] || 0) + 1;
      }
    }
    let sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    if (sorted.length) return sorted[0][0];

    // Fallback: names are often coloured by realm (red, blue, green)
    const hueCounts = {};
    for (const element of cell.querySelectorAll("a, span, font")) {
      if (!element.textContent.trim()) continue;
      const realm = realmFromColor(getComputedStyle(element).color);
      if (realm) hueCounts[realm] = (hueCounts[realm] || 0) + 1;
    }
    sorted = Object.entries(hueCounts).sort((a, b) => b[1] - a[1]);
    return sorted.length ? sorted[0][0] : null;
  }

  function realmFromColor(color) {
    const m = String(color).match(/(\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max - min < 60) return null; // grey, white or black: no realm
    if (max === r && r - Math.max(g, b) > 40) return "Albion";
    if (max === b && b - Math.max(r, g) > 20) return "Midgard";
    if (max === g && g - Math.max(r, b) > 20) return "Hibernia";
    return null;
  }

  // Understands "1m 38s", "1:38", "01:01:38", "98s" and similar formats.
  function parseDuration(text) {
    const t = String(text || "").trim();
    if (!t) return null;
    const clock = t.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
    if (clock) {
      return clock[3] !== undefined
        ? Number(clock[1]) * 3600 + Number(clock[2]) * 60 + Number(clock[3])
        : Number(clock[1]) * 60 + Number(clock[2]);
    }
    const h = t.match(/(\d+)\s*h/i);
    const m = t.match(/(\d+)\s*m(?!s)/i);
    const sec = t.match(/(\d+)\s*s/i);
    if (!h && !m && !sec) return /^\d+$/.test(t) ? Number(t) : null;
    return (h ? Number(h[1]) * 3600 : 0) + (m ? Number(m[1]) * 60 : 0) + (sec ? Number(sec[1]) : 0);
  }

  function fmtDuration(seconds) {
    if (seconds === null) return "";
    const m = Math.floor(seconds / 60);
    const sec = seconds % 60;
    return `${m}:${String(sec).padStart(2, "0")}`;
  }

  function durationClass(seconds, size) {
    if (seconds === null) return { cls: "", hint: "" };

    const limit = durationLimit(size);
    const note = durationTuned[size] ? " · from the shared database" : "";

    if (seconds < limit.fast) return { cls: "fast", hint: `fast, the quickest fifth of ${size}v${size} (under ${limit.fast}s)${note}` };
    if (seconds >= limit.slow) return { cls: "slow", hint: `long, the slowest fifth of ${size}v${size} (from ${fmtDuration(limit.slow)})${note}` };
    return { cls: "", hint: "" };
  }

  // A row counts as done once it has a date and both sides. Half built rows
  // get read again on the next pass.
  function rowIsComplete(fight) {
    return !!(fight && fight.date && fight.winners.length && fight.losers.length);
  }

  // "known" holds what has already been read. Reading a row walks every cell
  // and in the worst case asks for computed colours, so known rows are
  // skipped. That is what keeps repeated passes cheap.
  function readRowsFromDom(known) {
    const table = findFightTable();
    if (!table) return [];

    const rows = [...table.querySelectorAll("tr.top_line")];

    return rows.map(row => {
      if (known && row.id && known.has(row.id) && rowIsComplete(known.get(row.id))) return null;

      const dateCell = row.querySelector("td.list_date");
      const nameCells = row.querySelectorAll("td.list_names");
      const durationCell = row.querySelector("td.list_duration");

      if (!dateCell || nameCells.length < 2) return null;

      const dateText = dateCell.textContent.trim();
      const date = parseDateCell(dateText);

      return {
        id: row.id || "",
        date,
        matchup: readMatchupCell(dateCell),
        winnerLinks: nameCells[0].querySelectorAll('a[href*="herald"], a[href*="n=player"]').length,
        loserLinks: nameCells[1].querySelectorAll('a[href*="herald"], a[href*="n=player"]').length,
        duration: durationCell ? durationCell.textContent.trim() : "",
        seconds: parseDuration(durationCell ? durationCell.textContent : ""),
        winners: namesFromCell(nameCells[0]),
        losers: namesFromCell(nameCells[1]),
        winnerRealm: realmFromCell(nameCells[0]),
        loserRealm: realmFromCell(nameCells[1])
      };
    }).filter(Boolean);
  }

  // Eden only keeps part of the fight list in the HTML. Scrolling adds more,
  // older rows can disappear again. So we collect everything we get to see.
  const collected = new Map();

  function fightKey(fight) {
    return fight.id || `${fight.date ? fight.date.getTime() : "?"}|${fight.winners.join()}|${fight.losers.join()}`;
  }

  // Reads the current rows and adds them to what we already know.
  function harvest() {
    const fresh = readRowsFromDom(collected);
    for (const fight of fresh) collected.set(fightKey(fight), fight);
    return collected.size;
  }

  function allFights() {
    harvest();
    return [...collected.values()];
  }

  // A new search on the Eden page throws away everything collected so far.
  function resetCollected() {
    collected.clear();
  }

  // Exact match after normalising. A substring match is only a fallback for
  // a label stuck to the name, and only when exactly one name in the fight
  // qualifies. Otherwise searching "Bob" would also hit "Bobby".
  function looseMatch(name, targetNorm) {
    const normName = normalizeName(name);
    return !!normName && (normName.includes(targetNorm) || targetNorm.includes(normName));
  }

  // The wanted name as it appears in a list of names, or null
  function findName(names, targetNorm) {
    if (!targetNorm) return null;
    const exact = names.find(name => normalizeName(name) === targetNorm);
    if (exact !== undefined) return exact;
    const loose = names.filter(name => looseMatch(name, targetNorm));
    return loose.length === 1 ? loose[0] : null;
  }

  const findPlayerInFight = (fight, targetNorm) => findName([...fight.winners, ...fight.losers], targetNorm);

  function opponentList(fight, result, own) {
    const opponentSide = result === "Win" ? fight.losers : fight.winners;
    return opponentSide.filter(name => name !== own);
  }

  // Counts wins and losses per opponent. In group fights every enemy name
  // counts on its own. Returns two top five lists, ties going to the more
  // recent fight.
  function topOpponents(rows) {
    const map = new Map();

    for (const row of rows) {
      for (const name of row.opponentsForStats) {
        const key = normalizeName(name);
        if (!key) continue;

        if (!map.has(key)) {
          map.set(key, { name, realm: row.opponentRealm, wins: 0, losses: 0, lastWinDate: null, lastLossDate: null });
        }

        const entry = map.get(key);

        if (row.result === "Win") {
          entry.wins += 1;
          if (!entry.lastWinDate || (row.date && row.date > entry.lastWinDate)) entry.lastWinDate = row.date;
        } else {
          entry.losses += 1;
          if (!entry.lastLossDate || (row.date && row.date > entry.lastLossDate)) entry.lastLossDate = row.date;
        }
      }
    }

    const entries = [...map.values()];

    const mostWins = entries
      .filter(entry => entry.wins > 0)
      .sort((a, b) => b.wins - a.wins || (b.lastWinDate || 0) - (a.lastWinDate || 0))
      .slice(0, 5);

    const mostLosses = entries
      .filter(entry => entry.losses > 0)
      .sort((a, b) => b.losses - a.losses || (b.lastLossDate || 0) - (a.lastLossDate || 0))
      .slice(0, 5);

    return { mostWins, mostLosses };
  }

  // Reads the name from Eden's own search field (#table_search), so nobody
  // has to type it twice. Eden prefills it with the hint "Search by name",
  // which does not count as a name.
  const SEARCH_PLACEHOLDERS = ["search by name", "search", "name"];

  function getSiteSearchValue() {
    const container = document.querySelector("#table_search");
    if (!container) return "";

    const input = container.querySelector('input[type="text"], input:not([type])');
    const value = input ? input.value.trim() : "";
    return SEARCH_PLACEHOLDERS.includes(value.toLowerCase()) ? "" : value;
  }

  // ---------------------------------------------------------------
  // Driving Eden's own search (matchup min/max plus the search button)
  // ---------------------------------------------------------------

  function setInputValue(input, value) {
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const POLL_MS = 250;          // how often the table is checked
  const STABLE_TICKS = 4;       // unchanged checks in a row that count as done (1 s)
  const EMPTY_GRACE_MS = 3 * SECOND; // an empty result counts as final after this
  const RELOAD_TIMEOUT_MS = MINUTE;

  let reloadPoll = null;

  // Eden shows a spinner (#loading) while it is fetching.
  function siteIsLoading() {
    const element = document.querySelector("#loading");
    return !!element && element.offsetParent !== null;
  }

  // After a click on Search, Eden rebuilds the table in several batches.
  // So we wait until the spinner is gone AND the row count has been stable
  // for a moment.
  function afterTableReload(expected, label, minRows = 0) {
    clearInterval(reloadPoll);

    const started = Date.now();
    let last = -1;
    let stable = 0;
    let painted = false;
    let spinnerSeen = false;
    let spinnerGoneAt = 0;

    const finish = () => {
      clearInterval(reloadPoll);
      reloadPoll = null;
      const playerField = $("#ewa-player");
      if (playerField) playerField.value = capitalize(getSiteSearchValue());
      calculate();

      if (!expected) return;

      const fights = allFights();
      const outside = fights.filter(fight => {
        const size = groupSize(fight);
        return size < expected.min || size > expected.max;
      }).length;

      if (fights.length && outside === fights.length) {
        setStatus("Eden did not apply the matchup selection. Please set Min and Max on the page itself.");
      }
    };

    reloadPoll = setInterval(() => {
      const count = harvest();

      if (Date.now() - started > RELOAD_TIMEOUT_MS) {
        finish();
        return;
      }

      // Below minRows Eden has usually not filled the table yet. Once Eden's
      // spinner has come and gone and the table stays empty for a moment,
      // the empty table is a real empty result (a player without fights).
      const loading = siteIsLoading();
      if (loading) {
        spinnerSeen = true;
        spinnerGoneAt = 0;
      } else if (spinnerSeen && !spinnerGoneAt) {
        spinnerGoneAt = Date.now();
      }
      const emptyIsFinal = spinnerGoneAt && Date.now() - spinnerGoneAt >= EMPTY_GRACE_MS;
      const waitingForRows = count < minRows && !emptyIsFinal;
      if (loading || count !== last || waitingForRows) {
        last = count;
        stable = 0;

        // Show a first result as soon as rows are there instead of staring
        // at an empty panel until Eden is finished.
        if (!painted && count > 0 && count >= minRows) {
          painted = true;
          calculate();
        }

        setStatus(count ? `Loading ${label} from Eden ... ${fmt(count)} rows` : `Waiting for ${label} ...`);
        return;
      }

      stable += 1;
      if (stable >= STABLE_TICKS) finish();
    }, POLL_MS);
  }

  function currentRange() {
    return {
      min: Number(document.querySelector("#select_matchup_min")?.value || 1),
      max: Number(document.querySelector("#select_matchup_max")?.value || MAX_GROUP)
    };
  }

  function renderTicks() {
    const holder = $("#ewa-ticks");
    if (!holder) return;
    const last = HOUR_STEPS.length - 1;

    // While dragging only the active mark changes, so do not rebuild the scale.
    if (holder.children.length === HOUR_STEPS.length) {
      for (let i = 0; i < holder.children.length; i++) {
        holder.children[i].classList.toggle("is-on", i === hourIndex);
      }
      return;
    }

    holder.innerHTML = HOUR_STEPS.map((hours, index) =>
      `<span class="ewa-tick ${index === hourIndex ? "is-on" : ""}" data-hour="${index}" style="left:${(index / last * 100).toFixed(3)}%" title="${hoursLabel(hours)}">${hoursShort(hours)}</span>`
    ).join("");
  }

  function updateHourLabel(loaded, shown) {
    renderTicks();
    const label = $("#ewa-hours-label");
    if (!label) return;
    label.textContent = loaded.length && shown.length !== loaded.length
      ? `${fmt(shown.length)} of ${fmt(loaded.length)}`
      : `${fmt(loaded.length)} fights`;
  }

  // Move slider, scale and analysis to one step
  function setHourIndex(index) {
    hourIndex = index;
    rememberHours(index);
    const slider = $("#ewa-hours");
    if (slider) slider.value = String(index);
    renderTicks();
    calculate();
  }

  function updateCacheLabel() {
    const label = $("#ewa-cache");
    if (!label) return;

    label.textContent = `${fmt(collected.size)} fights found`;
  }

  // Puts the name into Eden's search field and presses Search there.
  // That is exactly one request, the same as searching by hand.
  // Period and group size stay as they are, only the name changes.
  function searchPlayer(nameOverride) {
    const input = $("#ewa-player");
    const raw = nameOverride !== undefined ? nameOverride : (input ? input.value : "");
    const name = String(raw || "").trim();
    const field = document.querySelector("#search2");
    const button = document.querySelector("#search_button2");

    if (!field || !button) {
      setStatus("Could not find the search field on the Eden page.");
      return;
    }

    if (input) input.value = name ? capitalize(name) : "";

    // The head-to-head belongs to the previous player.
    const h2hField = $("#ewa-h2h");
    if (h2hField) h2hField.value = "";

    // Without "exact" Eden also lists names that only start the same way
    // ("Bob" also finds "Bobby"). Set before the name, so any search Eden
    // starts on the input already uses it.
    setExact(!!name);
    setInputValue(field, name);

    resetCollected();
    showAllFights = false;

    setStatus(name ? `Searching ${capitalize(name)} on the Eden page ...` : "Loading the full list ...");
    $("#ewa-output").innerHTML = "";

    button.click();
    afterTableReload(null, name ? capitalize(name) : "fights", 0);
  }

  function loadMatchup(min, max) {
    const minInput = document.querySelector("#select_matchup_min");
    const maxInput = document.querySelector("#select_matchup_max");
    const button = document.querySelector("#search_button2");

    if (!minInput || !maxInput || !button) {
      setStatus("Could not find the matchup fields on the Eden page.");
      return;
    }

    // Eden clamps min to the current max and the other way round, so set
    // min to 1 first, then max, then min. Nothing gets cut off that way.
    setInputValue(minInput, 1);
    setInputValue(maxInput, max);
    setInputValue(minInput, min);

    resetCollected();
    showAllFights = false;

    const label = min === max ? `${min}v${min}` : `${min} to ${max} players`;
    setStatus(`Loading ${label} from Eden ...`);
    $("#ewa-output").innerHTML = "";

    button.click();
    afterTableReload({ min, max }, label);
  }

  // Clicking a name does one of two things.
  // Nothing searched yet: start a real search for that name on the Eden page.
  // A player already searched: open the head-to-head for that name, seen
  // from the searched player. Period and group size stay untouched in both.
  function onNameClick(name) {
    const clicked = String(name || "").trim();
    if (!clicked) return;

    const searched = getSiteSearchValue();

    if (!searched) {
      searchPlayer(clicked);
      return;
    }

    if (normalizeName(clicked) === normalizeName(searched)) return; // own name
    setHeadToHead(clicked);
  }

  function setHeadToHead(name) {
    const field = $("#ewa-h2h");
    if (field) field.value = name ? capitalize(name) : "";
    calculate();

    const body = $("#ewa-body");
    const box = $("#ewa-h2h-box");

    if (!name || !body) return;
    if (!box) { body.scrollTop = 0; return; }

    body.scrollTop += box.getBoundingClientRect().top - body.getBoundingClientRect().top - 8;
  }

  // Eden's "exact" checkbox. Eden only stores the value on change and reads
  // it when Search is pressed, so setting it never starts a search itself.
  function setExact(on) {
    const box = document.querySelector("#select_exact");
    if (!box || box.checked === on) return;
    box.checked = on;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Back to the full list: no name, every group size, full period. One request.
  function resetAll() {
    const field = document.querySelector("#search2");
    const minInput = document.querySelector("#select_matchup_min");
    const maxInput = document.querySelector("#select_matchup_max");
    const button = document.querySelector("#search_button2");

    const playerField = $("#ewa-player");
    const h2hField = $("#ewa-h2h");
    if (playerField) playerField.value = "";
    if (h2hField) h2hField.value = "";

    hourIndex = HOUR_STEPS.length - 1; // All
    rememberHours(hourIndex);
    const slider = $("#ewa-hours");
    if (slider) slider.value = String(hourIndex);
    renderTicks();

    showAllFights = false;
    resetCollected();
    $("#ewa-output").innerHTML = "";

    if (!field || !button) {
      setStatus("Could not find the search field on the Eden page.");
      return;
    }

    setExact(false);
    setInputValue(field, "");

    // Eden clamps min against max, so min goes first.
    if (minInput && maxInput) {
      setInputValue(minInput, 1);
      setInputValue(maxInput, MAX_GROUP);
      setInputValue(minInput, 1);
    }

    setStatus("Loading the full list ...");
    button.click();
    afterTableReload(null, "fights", 0);
  }

  function groupSize(fight) {
    if (fight.size !== undefined) return fight.size;

    const m = (fight.matchup || "").match(/(\d+)v(\d+)/i);
    if (m) fight.size = Math.max(Number(m[1]), Number(m[2]));
    else if (fight.winnerLinks || fight.loserLinks) fight.size = Math.max(fight.winnerLinks, fight.loserLinks, 1);
    else fight.size = Math.max(fight.winners.length, fight.losers.length, 1);

    return fight.size;
  }

  function fightSeconds(fight) {
    if (fight.seconds === undefined) fight.seconds = parseDuration(fight.duration);
    return fight.seconds;
  }

  const capitalize = text => (text ? text.charAt(0).toUpperCase() + text.slice(1) : text);

  function calculateWinrate() {
    const player = capitalize(getSiteSearchValue());
    const loaded = allFights();
    const fights = filterByTime(loaded);

    updateCacheLabel();
    updateHourLabel(loaded, fights);
    renderLoadBar();

    if (!loaded.length) {
      setStatus("No fights found in the table. Is the page fully loaded?");
      $("#ewa-output").innerHTML = "";
      return;
    }

    if (!fights.length) {
      $("#ewa-output").innerHTML = emptyWindowHtml(loaded);
      setStatus("");
      return;
    }

    if (!player) {
      renderOverview(fights);
      setStatus("");
      return;
    }

    const targetNorm = normalizeName(player);
    const rows = [];

    for (const fight of fights) {
      const own = findPlayerInFight(fight, targetNorm);
      if (own === null) continue;
      const result = fight.winners.includes(own) ? "Win" : "Loss";

      rows.push({
        id: fight.id,
        date: fight.date,
        opponentsForStats: opponentList(fight, result, own),
        teammates: (result === "Win" ? fight.winners : fight.losers).filter(name => name !== own),
        matchup: fight.matchup,
        size: groupSize(fight),
        opponentRealm: result === "Win" ? fight.loserRealm : fight.winnerRealm,
        duration: fight.duration,
        seconds: fightSeconds(fight),
        result
      });
    }

    rows.sort((a, b) => (b.date || 0) - (a.date || 0));
    const { mostWins, mostLosses } = topOpponents(rows);

    const h2hInput = $("#ewa-h2h");
    const h2hName = capitalize(h2hInput ? h2hInput.value.trim() : "");
    const h2hNorm = h2hName ? normalizeName(h2hName) : "";

    const h2hRows = h2hNorm
      ? rows.filter(row => findName(row.opponentsForStats, h2hNorm) !== null)
      : null;

    renderWinrate(rows, player, mostWins, mostLosses, h2hName, h2hRows);

    setStatus(
      rows.length
        ? ""
        : `No fights for ${player} in this period (${fmt(fights.length)} of ${fmt(loaded.length)} fights). Widen the period.`
    );
  }

  // ---------------------------------------------------------------
  // Overview (no player searched)
  // ---------------------------------------------------------------

  const TOP_LIST_LIMIT = 5;
  const OVERVIEW_FIGHT_LIMIT = 60;
  let showAllFights = false;

  // Steps of the period slider in hours, the last one means everything
  const HOUR_STEPS = [1, 2, 4, 8, 16, 24, 36, 48, 72, 168, 336, 672, Infinity];
  const HOURS_KEY = "ewa_period";

  // Eden reloads the page when it searches, which would throw the chosen
  // period away. So it is kept for this tab and read back on start.
  // The hours are stored, not the position, so the setting still fits
  // after the list of steps changes.
  function storedHourIndex() {
    const raw = sessionGet(HOURS_KEY);
    if (raw === null) return HOUR_STEPS.length - 1; // default: all
    if (raw === "all") return HOUR_STEPS.length - 1;

    const index = HOUR_STEPS.indexOf(Number(raw));
    return index >= 0 ? index : HOUR_STEPS.length - 1;
  }

  function rememberHours(index) {
    const hours = HOUR_STEPS[index];
    sessionSet(HOURS_KEY, Number.isFinite(hours) ? hours : "all");
  }

  let hourIndex = storedHourIndex();

  function hoursValue() {
    return HOUR_STEPS[hourIndex];
  }

  const HOUR_LABELS = {
    168: "Last week",
    336: "Last 2 weeks",
    672: "Last 4 weeks"
  };

  const HOUR_SHORT = { 48: "2d", 72: "3d", 168: "1w", 336: "2w", 672: "4w" };

  function hoursShort(hours) {
    if (!Number.isFinite(hours)) return "All";
    return HOUR_SHORT[hours] || `${hours}h`;
  }

  function hoursLabel(hours) {
    if (!Number.isFinite(hours)) return "All";
    if (HOUR_LABELS[hours]) return HOUR_LABELS[hours];
    if (hours <= 36) return `Last ${hours} h`;
    return `Last ${hours / 24} days`;
  }

  // The anchor is now. If the newest fight lies in the future, Eden's clock
  // runs ahead of the browser, and the newest fight becomes the anchor.
  function newestDate(fights) {
    return fights.reduce((max, fight) =>
      fight.date && (!max || fight.date > max) ? fight.date : max, null);
  }

  function filterByTime(fights) {
    const hours = hoursValue();
    if (!Number.isFinite(hours)) return fights;
    const newest = newestDate(fights);
    const anchor = Math.max(Date.now(), newest ? newest.getTime() : 0);
    const cutoff = anchor - hours * HOUR;
    return fights.filter(fight => fight.date && fight.date.getTime() >= cutoff);
  }

  function overviewStats(fights) {
    const sizes = new Map();  // matchup label -> {label, size, count, seconds, timed}
    const players = new Map();

    let seconds = 0;
    let timed = 0;
    let fast = 0;
    let slow = 0;
    let first = null;
    let last = null;

    for (const fight of fights) {
      const size = groupSize(fight);
      const secs = fightSeconds(fight);
      const label = fight.matchup || `${size}v${size}`;

      if (fight.date) {
        if (!first || fight.date < first) first = fight.date;
        if (!last || fight.date > last) last = fight.date;
      }

      if (secs !== null) {
        seconds += secs;
        timed += 1;
        const cls = durationClass(secs, size).cls;
        if (cls === "fast") fast += 1;
        if (cls === "slow") slow += 1;
      }

      if (!sizes.has(label)) sizes.set(label, { label, size, count: 0, seconds: 0, timed: 0 });
      const sizeEntry = sizes.get(label);
      sizeEntry.count += 1;
      if (secs !== null) {
        sizeEntry.seconds += secs;
        sizeEntry.timed += 1;
      }

      const add = (name, realm, won) => {
        const key = normalizeName(name);
        if (!key) return;
        if (!players.has(key)) players.set(key, { name, realm, wins: 0, losses: 0 });
        const entry = players.get(key);
        if (!entry.realm && realm) entry.realm = realm;
        if (won) entry.wins += 1;
        else entry.losses += 1;
      };

      for (const name of fight.winners) add(name, fight.winnerRealm, true);
      for (const name of fight.losers) add(name, fight.loserRealm, false);
    }

    return {
      total: fights.length,
      first,
      last,
      average: timed ? seconds / timed : null,
      fast,
      slow,
      timed,
      sizes: [...sizes.values()].sort((a, b) => a.size - b.size || a.label.localeCompare(b.label)),
      players: [...players.values()]
    };
  }

  // Small bars per hour, so the recent activity stays visible even on "All".
  function activityHtml(fights) {
    // The chart follows the chosen period. Below 24 h it shows exactly those
    // hours instead of padding the rest with empty bars. One or two bars say
    // nothing, so there the chart is left out.
    const hours = hoursValue();
    const count = Number.isFinite(hours) ? Math.min(24, Math.round(hours)) : 24;
    if (count < 3) return "";

    const newest = newestDate(fights);
    const anchor = Math.max(Date.now(), newest ? newest.getTime() : 0);
    const buckets = new Array(count).fill(0);

    // Buckets are full clock hours. The last one is the current hour and
    // therefore only as full as that hour has progressed.
    const hourFloor = time => {
      const date = new Date(time);
      date.setMinutes(0, 0, 0);
      return date.getTime();
    };
    const lastHour = hourFloor(anchor);

    for (const fight of fights) {
      if (!fight.date) continue;
      const age = Math.round((lastHour - hourFloor(fight.date.getTime())) / HOUR);
      if (age >= 0 && age < count) buckets[count - 1 - age] += 1;
    }

    const max = Math.max(...buckets);
    if (!max) return "";

    const total = buckets.reduce((sum, count) => sum + count, 0);

    // Clock time of each bucket, taken from the local machine
    const hourStart = index => new Date(lastHour - (count - 1 - index) * HOUR);
    const clock = date => date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

    // Four labels spread across the bars, plus the end of the last hour
    const marks = [];
    const step = Math.max(1, Math.round(count / 4));
    for (let index = 0; index < count; index += step) marks.push(index);

    return `
      <div class="ewa-act">
        <div class="ewa-act-head">
          <span>Fights per hour</span>
          <b>${fmt(total)} in ${count} h · peak ${max}</b>
        </div>
        <div class="ewa-act-bars">
          ${buckets.map((count, index) => {
            const from = hourStart(index);
            const to = new Date(from.getTime() + HOUR);
            return `<i class="${count ? "" : "is-empty"}" style="height:${count ? Math.max(14, count / max * 100) : 100}%" title="${clock(from)} to ${clock(to)}: ${count} fights"></i>`;
          }).join("")}
        </div>
        <div class="ewa-act-scale">
          ${marks.map(index => `<span>${clock(hourStart(index))}</span>`).join("")}
          <span>${clock(new Date(lastHour + HOUR))}</span>
        </div>
      </div>
    `;
  }

  function overviewHeadHtml(stat, fights) {
    const span = stat.first && stat.last
      ? `${fmtDate(stat.first)} to ${fmtDate(stat.last)}`
      : "period unknown";

    return `
      <div class="ewa-sum">
        <div class="ewa-sum-title">All loaded fights</div>
        <div class="ewa-sum-top">
          <div class="ewa-sum-rate"><strong>${fmt(stat.total)}</strong><span>Fights</span></div>
          <div class="ewa-sum-kv"><strong>${stat.average !== null ? fmtDuration(Math.round(stat.average)) : "-"}</strong><span>Ø time</span></div>
          <div class="ewa-sum-kv"><strong class="fast">${fmt(stat.fast)}</strong><span>Fast</span></div>
          <div class="ewa-sum-kv"><strong class="slow">${fmt(stat.slow)}</strong><span>Long</span></div>
        </div>
        <div class="ewa-form"><span>Covers</span>${span}</div>
        ${activityHtml(fights)}
      </div>
    `;
  }

  function loadBarHtml() {
    const sizes = Array.from({ length: MAX_GROUP }, (_, index) => index + 1);
    const { min, max } = currentRange();
    const activeAll = min === 1 && max === MAX_GROUP;

    return `
      <div class="ewa-loadbar">
        ${sizes.map(size => `<button class="ewa-load-btn ${!activeAll && min === size && max === size ? "is-on" : ""}" data-min="${size}" data-max="${size}">${size}v${size}</button>`).join("")}
        <button class="ewa-load-btn is-reset ${activeAll ? "is-on" : ""}" data-min="1" data-max="${MAX_GROUP}">All</button>
      </div>
    `;
  }

  function matchupHtml(stat) {
    const max = stat.sizes.length ? Math.max(...stat.sizes.map(entry => entry.count)) : 1;

    return `
      <div class="ewa-section-title">Matchups</div>
      ${stat.sizes.length ? `
      <div class="ewa-bars">
        ${stat.sizes.map(entry => `
          <div class="ewa-bar-row is-plain ewa-load" data-min="${entry.size}" data-max="${entry.size}" title="Load only ${entry.size}v${entry.size} from Eden">
            <span class="ewa-bar-name">${entry.label}</span>
            <div class="ewa-bar"><span style="width:${(entry.count / max * 100).toFixed(1)}%"></span></div>
            <span class="ewa-bar-val">${fmt(entry.count)}</span>
            <span class="ewa-bar-sub">${entry.timed ? `Ø ${fmtDuration(Math.round(entry.seconds / entry.timed))}` : ""}</span>
          </div>
        `).join("")}
      </div>
      ` : `<div class="ewa-muted">No fights in this selection.</div>`}
    `;
  }

  // Recurring groups: identical player line-up on one side
  const MIN_GROUP_FIGHTS = 2;

  function addGroup(map, names, realm, won) {
    if (names.length < 2) return;
    const key = names.map(normalizeName).sort().join("|");
    if (!map.has(key)) map.set(key, { names: [...names], realm, wins: 0, losses: 0 });
    const entry = map.get(key);
    if (won) entry.wins += 1;
    else entry.losses += 1;
  }

  function groupStats(fights) {
    const map = new Map();
    for (const fight of fights) {
      if (groupSize(fight) < 2) continue;
      addGroup(map, fight.winners, fight.winnerRealm, true);
      addGroup(map, fight.losers, fight.loserRealm, false);
    }
    return sortedGroups(map);
  }

  // Wins and losses per group size, so you do not have to click through
  // the matchup buttons one by one.
  function sizeStats(rows) {
    const map = new Map();

    for (const row of rows) {
      const size = row.size || 1;
      if (!map.has(size)) map.set(size, { size, wins: 0, losses: 0 });
      const entry = map.get(size);
      if (row.result === "Win") entry.wins += 1;
      else entry.losses += 1;
    }

    return [...map.values()].sort((a, b) => a.size - b.size);
  }

  function sizesHtml(rows) {
    const sizes = sizeStats(rows);
    if (sizes.length < 2) return ""; // only one size, the summary says it already

    return `
      <div class="ewa-section-title">By group size</div>
      <div class="ewa-sizes">
        ${sizes.map(entry => {
          const total = entry.wins + entry.losses;
          return `
            <span class="ewa-size" title="${entry.size}v${entry.size}: ${entry.wins} won, ${entry.losses} lost">
              <b>${entry.size}v${entry.size}</b>
              <span class="ewa-size-wl"><em class="w">${entry.wins}</em>/<em class="l">${entry.losses}</em></span>
              <i>${fmt1(entry.wins / total * 100)}%</i>
            </span>
          `;
        }).join("")}
      </div>
    `;
  }

  // Player mode: the enemy line-ups. Wins and losses are counted from the
  // searched player, not from the enemy group.
  function enemyGroupStats(rows) {
    const map = new Map();
    for (const row of rows) {
      if (row.opponentsForStats.length < 2) continue;
      addGroup(map, row.opponentsForStats, row.opponentRealm, row.result === "Win");
    }
    return sortedGroups(map);
  }

  // Player mode: the line-ups the searched player was part of
  function playerGroupStats(rows, player) {
    const map = new Map();
    for (const row of rows) {
      if (!row.teammates.length) continue;
      addGroup(map, [player, ...row.teammates], null, row.result === "Win");
    }
    return sortedGroups(map);
  }

  function sortedGroups(map) {
    return [...map.values()]
      .filter(entry => entry.wins + entry.losses >= MIN_GROUP_FIGHTS)
      .sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses) || b.wins - a.wins);
  }

  function groupsHtml(groups, title, hint) {
    if (!groups.length) return "";

    return `
      <div class="ewa-section-title${hint ? " has-hint" : ""}">${title}${hint ? `<i class="ewa-rule"></i><em class="ewa-hint">${hint}</em>` : ""}</div>
      <div class="ewa-groups">
        ${groups.slice(0, 6).map(entry => {
          const total = entry.wins + entry.losses;
          const rate = entry.wins / total * 100;
          return `
            <div class="ewa-group">
              <span class="ewa-group-names" title="${esc(entry.names.join(", "))}">${realmMark(entry.realm)}<span class="ewa-namelist">${nameLinks(entry.names)}</span></span>
              <span class="ewa-group-n">${entry.names.length}-man</span>
              <span class="ewa-opp-sub"><em class="w">${entry.wins}</em>/<em class="l">${entry.losses}</em></span>
              <span class="ewa-opp-val">${fmt1(rate)}%</span>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  // Two lists: who wins most, who loses most.
  function topPlayersHtml(players, mode) {
    const rows = [...players]
      .filter(entry => entry[mode] > 0)
      .sort((a, b) => b[mode] - a[mode] || (a[mode === "wins" ? "losses" : "wins"] - b[mode === "wins" ? "losses" : "wins"]))
      .slice(0, TOP_LIST_LIMIT);

    if (!rows.length) return `<div class="ewa-muted">No data.</div>`;

    return `
      <div class="ewa-opp-list">
        ${rows.map(entry => {
          const total = entry.wins + entry.losses;
          const rate = total ? entry.wins / total * 100 : 0;
          return `
            <div class="ewa-opp">
              <span class="ewa-opp-name ewa-pick" data-player="${esc(entry.name)}" title="Analyse this player">${realmMark(entry.realm)}${esc(entry.name)}</span>
              <span class="ewa-opp-sub">${fmt1(rate)}% of ${total}</span>
              <span class="ewa-opp-val">${entry[mode]}</span>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function allFightsHtml(fights) {
    const sorted = [...fights].sort((a, b) => (b.date || 0) - (a.date || 0));
    const rows = showAllFights ? sorted : sorted.slice(0, OVERVIEW_FIGHT_LIMIT);

    return `
      <div class="ewa-fights">
        ${rows.map(fight => {
          const size = groupSize(fight);
          const secs = fightSeconds(fight);
          const d = durationClass(secs, size);
          const time = secs !== null ? fmtDuration(secs) : esc(fight.duration || "-");
          return `
            <a class="ewa-fight is-duel" href="/fights?id=${encodeURIComponent(String(fight.id).replace(/^fight_/, ""))}" target="_blank" rel="noopener" title="Open fight in a new tab">
              <div class="ewa-fight-main">
                <span class="ewa-fight-opp" title="${esc(fight.winners.join(", "))}"><i class="ewa-fight-res w">W</i>${realmMark(fight.winnerRealm)}<span class="ewa-namelist">${nameLinks(fight.winners) || "-"}</span></span>
                <span class="ewa-fight-opp loser" title="${esc(fight.losers.join(", "))}"><i class="ewa-fight-res l">L</i>${realmMark(fight.loserRealm)}<span class="ewa-namelist">${nameLinks(fight.losers) || "-"}</span></span>
              </div>
              <span class="ewa-dur ${d.cls}" title="${esc(d.hint)}">${time}</span>
              <div class="ewa-fight-meta">
                <span>${fmtDate(fight.date)}</span>
                <span>${fight.matchup || ""}</span>
              </div>
            </a>
          `;
        }).join("")}
      </div>
      ${!showAllFights && sorted.length > rows.length
        ? `<button class="ewa-more-btn" id="ewa-more">Show all ${fmt(sorted.length)} fights</button>`
        : ""}
    `;
  }

  function renderLoadBar() {
    const holder = $("#ewa-matchups");
    if (holder) holder.innerHTML = loadBarHtml();
  }

  function renderOverview(fights) {
    const stat = overviewStats(fights);
    const range = currentRange();
    const single = range.min === range.max; // exactly one matchup selected

    $("#ewa-output").innerHTML = `
      ${overviewHeadHtml(stat, fights)}
      ${single ? "" : matchupHtml(stat)}
      ${single && range.min === 1 ? "" : groupsHtml(groupStats(fights), "Recurring groups")}

      <div class="ewa-opponents">
        <div class="ewa-opp-col is-win">
          <div class="ewa-section-title">Most wins</div>
          ${topPlayersHtml(stat.players, "wins")}
        </div>
        <div class="ewa-opp-col is-loss">
          <div class="ewa-section-title">Most losses</div>
          ${topPlayersHtml(stat.players, "losses")}
        </div>
      </div>

      <div class="ewa-section-title">Fights <em>${fmt(fights.length)}</em></div>
      ${allFightsHtml(fights)}
    `;
  }

  // 8064 -> "8.1k", 934 -> "934"
  function fmtShort(value) {
    const number = Number(value || 0);
    if (number < 1000) return String(number);
    return `${(number / 1000).toLocaleString("en-GB", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}k`;
  }

  const pad2 = value => String(value).padStart(2, "0");

  // Same output as toLocaleString with en-GB, only without building a
  // formatter for every single row.
  const fmtDate = date => date
    ? `${pad2(date.getDate())}/${pad2(date.getMonth() + 1)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
    : "-";

  function streakOf(rows) {
    if (!rows.length) return "";
    const first = rows[0].result;
    let count = 0;
    for (const row of rows) {
      if (row.result !== first) break;
      count += 1;
    }
    return `${count}${first === "Win" ? "W" : "L"}`;
  }

  // Longest win and loss streak across all loaded fights
  function longestStreaks(rows) {
    let bestW = 0;
    let bestL = 0;
    let current = 0;
    let last = null;
    for (const row of rows) {
      current = row.result === last ? current + 1 : 1;
      last = row.result;
      if (last === "Win") bestW = Math.max(bestW, current);
      else bestL = Math.max(bestL, current);
    }
    return { bestW, bestL };
  }

  function summaryHtml(rows, title) {
    const wins = rows.filter(row => row.result === "Win").length;
    const total = rows.length;
    const rate = total ? wins / total * 100 : 0;
    const streak = streakOf(rows);
    const { bestW, bestL } = longestStreaks(rows);
    const form = rows.slice(0, 10).map(row =>
      `<span class="ewa-dot ${row.result === "Win" ? "w" : "l"}" title="${fmtDate(row.date)}"></span>`).join("");

    return `
      <div class="ewa-sum">
        ${title ? `<div class="ewa-sum-title">${esc(title)}</div>` : ""}
        <div class="ewa-sum-top">
          <div class="ewa-sum-rate"><strong>${fmt1(rate)}%</strong><span>Winrate</span></div>
          <div class="ewa-sum-kv"><strong>${total}</strong><span>Fights</span></div>
          <div class="ewa-sum-kv"><strong><em class="w">${wins}</em> / <em class="l">${total - wins}</em></strong><span>W / L</span></div>
          <div class="ewa-sum-kv"><strong class="${streak.endsWith("W") ? "w" : "l"}">${streak}</strong><span>Current</span></div>
          <div class="ewa-sum-kv"><strong>${bestW ? `<em class="w">${bestW}W</em>` : "-"}${bestL ? ` <em class="l">${bestL}L</em>` : ""}</strong><span>Best streaks</span></div>
        </div>
        <div class="ewa-rate-bar"><span style="width:${rate.toFixed(1)}%"></span></div>
        <div class="ewa-form"><span>Last ${Math.min(10, total)}</span>${form}</div>
      </div>
    `;
  }

  // The period slider is narrower than the loaded data reaches.
  function emptyWindowHtml(loaded) {
    const newest = newestDate(loaded);
    const ageHours = newest ? (Date.now() - newest.getTime()) / HOUR : null;

    return `
      <div class="ewa-sum">
        <div class="ewa-sum-title">Nothing in this period</div>
        <div class="ewa-form">
          <span>Loaded</span>${fmt(loaded.length)} fights${newest ? `, newest ${ageHours < 1 ? "under 1" : Math.round(ageHours)} h ago` : ""}
        </div>
        <div class="ewa-loadbar"><button class="ewa-load-btn is-reset" id="ewa-time-off">Show all</button></div>
      </div>
    `;
  }

  // Every player name in the panel opens that player's view on click.
  const nameLink = name => `<span class="ewa-pick" data-player="${esc(name)}" title="Show ${esc(name)}">${esc(name)}</span>`;
  const nameLinks = names => names.map(nameLink).join(", ");

  function realmMark(realm) {
    return realm
      ? `<span class="ewa-rm ewa-realm-${realmKeyOf(realm)}" title="${realm}"></span>`
      : "";
  }

  function opponentListHtml(entries, countKey) {
    if (!entries.length) return `<div class="ewa-muted">No data.</div>`;

    return `
      <div class="ewa-opp-list">
        ${entries.map(entry => `
          <div class="ewa-opp">
            <span class="ewa-opp-name">${realmMark(entry.realm)}${nameLink(entry.name)}</span>
            <span class="ewa-opp-val">${entry[countKey]}</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  function fightsListHtml(rows) {
    return `
      <div class="ewa-fights">
        ${rows.map(row => `
          <a class="ewa-fight ${row.result === "Win" ? "is-win" : "is-loss"}" href="/fights?id=${encodeURIComponent(String(row.id).replace(/^fight_/, ""))}" target="_blank" rel="noopener" title="Open fight in a new tab">
            <span class="ewa-fight-res">${row.result === "Win" ? "W" : "L"}</span>
            <div class="ewa-fight-main">
              <span class="ewa-fight-opp" title="${esc(row.opponentsForStats.join(", "))}">${realmMark(row.opponentRealm)}<span class="ewa-namelist">${nameLinks(row.opponentsForStats) || "-"}</span></span>
              ${row.teammates.length ? `<span class="ewa-fight-mates" title="${esc(row.teammates.join(", "))}">with <span class="ewa-namelist">${nameLinks(row.teammates)}</span></span>` : ""}
            </div>
            ${(() => {
              const d = durationClass(row.seconds, row.size);
              const text = row.seconds !== null ? fmtDuration(row.seconds) : esc(row.duration || "-");
              return `<span class="ewa-dur ${d.cls}" title="${esc(d.hint)}">${text}</span>`;
            })()}
            <div class="ewa-fight-meta">
              <span>${fmtDate(row.date)}</span>
              <span>${row.matchup || ""}</span>
            </div>
          </a>
        `).join("")}
      </div>
    `;
  }

  function renderWinrate(rows, player, mostWins, mostLosses, h2hName, h2hRows) {
    const output = $("#ewa-output");

    if (!rows.length) {
      output.innerHTML = `<div class="ewa-muted">No data for this player.</div>`;
      return;
    }

    let h2hHtml = "";

    if (h2hName) {
      const count = h2hRows ? h2hRows.length : 0;

      h2hHtml = `
        <div class="ewa-h2h ewa-sec-break" id="ewa-h2h-box">
          <div class="ewa-h2h-head">
            <div class="ewa-h2h-pair">
              <span class="ewa-h2h-tag">Head-to-head</span>
              <b class="ewa-h2h-me">${esc(player)}</b>
              <span class="ewa-h2h-vs">vs</span>
              <span class="ewa-h2h-foe">${esc(h2hName)}</span>
            </div>
            <div class="ewa-h2h-act">
              <button class="ewa-load-btn ewa-search-name" data-player="${esc(h2hName)}" title="Search ${esc(h2hName)} on the Eden page">Search ${esc(h2hName)}</button>
              <button class="ewa-load-btn" id="ewa-h2h-clear" title="Remove the head-to-head">Clear</button>
            </div>
          </div>
          ${count
            ? summaryHtml(h2hRows) + fightsListHtml(h2hRows)
            : `<div class="ewa-muted">No shared fights against ${esc(h2hName)} in the loaded data.</div>`}
        </div>
      `;
    }

    output.innerHTML = `
      ${summaryHtml(rows, player)}

      ${sizesHtml(rows)}

      <div class="ewa-opponents">
        <div class="ewa-opp-col is-win">
          <div class="ewa-section-title">Most wins vs</div>
          ${opponentListHtml(mostWins || [], "wins")}
        </div>
        <div class="ewa-opp-col is-loss">
          <div class="ewa-section-title">Most losses vs</div>
          ${opponentListHtml(mostLosses || [], "losses")}
        </div>
      </div>

      ${groupsHtml(playerGroupStats(rows, player), "Your setups")}
      ${groupsHtml(enemyGroupStats(rows), "Enemy groups", "your record against them")}

      ${h2hHtml}

      <div class="ewa-section-title">All fights <em>${rows.length}</em></div>
      ${fightsListHtml(showAllFights ? rows : rows.slice(0, OVERVIEW_FIGHT_LIMIT))}
      ${!showAllFights && rows.length > OVERVIEW_FIGHT_LIMIT
        ? `<button class="ewa-more-btn" id="ewa-more">Show all ${fmt(rows.length)} fights</button>`
        : ""}
    `;
  }

  // ---------------------------------------------------------------
  // Part 2: the fight report on the fight detail page
  // ---------------------------------------------------------------

  function raPoints(rank, level) {
    return (rank - 1) * 10 + level;
  }

  // The other way round for display, also for averages with decimals.
  function pointsToRankLabel(points) {
    const safe = Math.max(0, points);
    let rank = Math.floor(safe / 10) + 1;
    let level = Math.round(safe - (rank - 1) * 10);
    if (level >= 10) {
      rank += 1;
      level = 0;
    }
    return `${rank}L${level}`;
  }

  function absLeft(element) {
    const rect = element.getBoundingClientRect();
    return rect.left + window.scrollX;
  }

  function centerOf(element) {
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + window.scrollX + rect.width / 2,
      y: rect.top + window.scrollY + rect.height / 2
    };
  }

  function distance(a, b) {
    const pa = centerOf(a);
    const pb = centerOf(b);
    return Math.hypot(pa.x - pb.x, pa.y - pb.y);
  }

  function isLeafElement(element) {
    return element.children.length === 0;
  }

  // Two passes, so that small layout changes do not break everything:
  // 1. elements whose whole text is exactly a realm rank (the badge),
  // 2. if that yields too little, leaf elements with a rank somewhere inside.
  function collectRankNodes() {
    const all = [...document.querySelectorAll("body *")]
      .filter(element => !element.closest("#ewa-panel"));

    const exact = all.filter(element => {
      const text = element.textContent.trim();
      if (!RANK_EXACT.test(text)) return false;
      return ![...element.children].some(child => RANK_EXACT.test(child.textContent.trim()));
    });

    if (exact.length >= 2) return exact.map(element => ({ element, match: element.textContent.trim().match(RANK_EXACT) }));

    const loose = all
      .filter(isLeafElement)
      .map(element => ({ element, match: element.textContent.trim().match(RANK_LOOSE) }))
      .filter(entry => entry.match);

    return loose;
  }

  // Name from the nearest herald link. We walk up from the rank element and
  // take the spatially closest link in the first container that has any.
  function findPlayerName(rankElement) {
    let node = rankElement.parentElement;

    for (let step = 0; step < 5 && node; step += 1) {
      const links = [...node.querySelectorAll('a[href*="herald"], a[href*="n=player"]')]
        .filter(link => link.textContent.trim());

      if (links.length) {
        let best = links[0];
        let bestDistance = Infinity;

        for (const link of links) {
          const d = distance(link, rankElement);
          if (d < bestDistance) {
            bestDistance = d;
            best = link;
          }
        }

        return best.textContent.trim();
      }

      node = node.parentElement;
    }

    return "?";
  }

  // --- Class detection ---------------------------------------------
  // Looks for a class name near the rank element: as text, in the title or
  // alt of an icon, or in an image file name.
  const CLASS_KEYS = Object.keys(CLASS_REALM)
    .map(name => ({ name, key: normalizeName(name) }))
    .sort((a, b) => b.key.length - a.key.length);

  function classFromExactText(text) {
    const norm = normalizeName(text);
    if (!norm || norm.length > 14) return null;
    const hit = CLASS_KEYS.find(entry => entry.key === norm);
    return hit ? hit.name : null;
  }

  function classFromAttribute(value) {
    const norm = normalizeName(value);
    if (!norm) return null;
    const hit = CLASS_KEYS.find(entry => norm.includes(entry.key));
    return hit ? hit.name : null;
  }

  function classCandidates(container) {
    const result = [];

    for (const element of container.querySelectorAll("*")) {
      if (element.closest("#ewa-panel")) continue;

      let cls = null;

      if (isLeafElement(element)) cls = classFromExactText(element.textContent);

      if (!cls) {
        for (const attr of ["title", "alt", "data-class", "aria-label"]) {
          const value = element.getAttribute(attr);
          if (value && (cls = classFromAttribute(value))) break;
        }
      }

      if (!cls && element.tagName === "IMG") {
        const file = (element.getAttribute("src") || "").split("/").pop().split("?")[0];
        cls = classFromAttribute(file);
      }

      if (cls) result.push({ element, cls });
    }

    return result;
  }

  function findPlayerClass(rankElement) {
    let node = rankElement.parentElement;

    for (let step = 0; step < 5 && node; step += 1) {
      const candidates = classCandidates(node);

      if (candidates.length) {
        let best = candidates[0];
        let bestDistance = Infinity;

        for (const candidate of candidates) {
          const d = distance(candidate.element, rankElement);
          if (d < bestDistance) {
            bestDistance = d;
            best = candidate;
          }
        }

        return best.cls;
      }

      node = node.parentElement;
    }

    return null;
  }

  function readMatchup() {
    const text = document.body.innerText || "";
    const match = text.match(/\b(\d{1,2})v(\d{1,2})\b/);
    return match ? { left: Number(match[1]), right: Number(match[2]), label: `${match[1]}v${match[2]}` } : null;
  }

  // Which column won? Only an extra check, it fails quietly.
  function winningSideFromLabels(splitX) {
    const candidates = [...document.querySelectorAll("body *")]
      .filter(element => isLeafElement(element) && /^victory$/i.test(element.textContent.trim()));

    if (candidates.length !== 1) return null;
    return absLeft(candidates[0]) < splitX ? 1 : 2;
  }

  function collectGroups() {
    const entries = collectRankNodes();

    if (entries.length < 2) {
      return { error: "No realm ranks found on the page. Is it fully loaded?" };
    }

    const players = entries.map(entry => {
      const rank = Number(entry.match[1]);
      const level = Number(entry.match[2]);

      return {
        name: findPlayerName(entry.element),
        cls: findPlayerClass(entry.element),
        rankLabel: `${rank}L${level}`,
        points: raPoints(rank, level),
        stats: {}, // the page shows per player values, but they are not read here
        x: absLeft(entry.element),
        y: centerOf(entry.element).y
      };
    });

    const xs = players.map(player => player.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);

    if (maxX - minX < 40) {
      return { error: "Cannot separate the two groups by column position (layout too narrow?)." };
    }

    const splitX = (minX + maxX) / 2;

    const group1 = players.filter(player => player.x < splitX).sort((a, b) => a.y - b.y);
    const group2 = players.filter(player => player.x >= splitX).sort((a, b) => a.y - b.y);

    return { group1, group2, splitX, matchup: readMatchup() };
  }

  // --- Comp overview -------------------------------------------------

  function roleOf(cls) {
    return ROLE_ORDER.find(role => ROLE[role].includes(cls)) || "Tank";
  }

  function realmOf(classes) {
    const counts = {};
    for (const cls of classes) {
      const realm = CLASS_REALM[cls];
      if (realm) counts[realm] = (counts[realm] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted.length ? sorted[0][0] : null;
  }

  // order: role order as in the label, so label and list match up
  function groupedClasses(classes, order, roleFn) {
    const counts = new Map();
    for (const cls of classes) counts.set(cls, (counts.get(cls) || 0) + 1);

    return [...counts.entries()]
      .sort((a, b) =>
        order.indexOf(roleFn(a[0])) - order.indexOf(roleFn(b[0]))
        || b[1] - a[1]
        || a[0].localeCompare(b[0]))
      .map(([cls, count]) => ({ cls, count, role: roleFn(cls) }));
  }

  function compInfo(players) {
    const classes = players.map(player => player.cls);
    const known = classes.filter(Boolean);
    const unknown = classes.length - known.length;
    const realm = realmOf(known);

    // Take out the support core. Small groups
    // have no core: there every class, a healer as well, stays in the list,
    // because the separate support line only shows from SUPPORT_LINE_FROM.
    const variable = [...known];
    const coreFound = [];
    const core = classes.length >= SUPPORT_LINE_FROM ? (CORE[realm] || []) : [];

    for (const cls of core) {
      const index = variable.indexOf(cls);
      if (index >= 0) {
        variable.splice(index, 1);
        coreFound.push(cls);
      }
    }

    // Label: custom rules first, then the role count of the variable slots
    const rule = COMP_RULES.find(r =>
      variable.filter(cls => r.classes.includes(cls)).length >= (r.min || 1));

    // Roles by count descending, ties resolved by ROLE_ORDER.
    // The class list below uses the same order.
    const roleFn = cls => (FLEX_ROLE[cls] ? FLEX_ROLE[cls](variable) : roleOf(cls));

    const roleEntries = ROLE_ORDER
      .map(role => [role, variable.filter(cls => roleFn(cls) === role).length])
      .filter(([, count]) => count > 0)
      .sort((a, b) => b[1] - a[1] || ROLE_ORDER.indexOf(a[0]) - ROLE_ORDER.indexOf(b[0]));

    const order = roleEntries.map(([role]) => role);

    return {
      realm,
      ruleLabel: rule ? rule.label : "",
      roles: roleEntries,
      unknown,
      groups: groupedClasses(variable, order, roleFn),
      core: coreFound,
      roleFn,
      known: known.length,
      size: classes.length
    };
  }

  function realmKeyOf(realm) {
    return realm ? REALM_SHORT[realm].toLowerCase() : "none";
  }

  // One row per side: realm, W/L, role count, variable classes, support core
  function compRowHtml(info, won) {
    const roleStats = info.roles.map(([role, count]) =>
      `<span class="ewa-stat ewa-role-${ROLE_CLASS[role]}">${icon(role)}<b>${count}</b>${role}</span>`
    ).join("");

    const unknownStat = info.unknown
      ? `<span class="ewa-stat ewa-role-unknown" title="class not detected">${icon("Unknown")}<b>${info.unknown}</b></span>`
      : "";

    const chips = info.groups.map(group =>
      `<span class="ewa-chip ewa-role-${ROLE_CLASS[group.role]}">${group.count > 1 ? `<b>${group.count}×</b>` : ""}${esc(group.cls)}</span>`
    ).join("");

    // Only groups from SUPPORT_LINE_FROM have a core (see compInfo)
    const support = info.core.length
      ? `<div class="ewa-comp-support"><span>Support:</span>${info.core.join(" · ")}</div>`
      : "";

    return `
      <div class="ewa-comp-row ewa-realm-${realmKeyOf(info.realm)}">
        <div class="ewa-comp-line">
          <span class="ewa-realm-tag">${info.realm ? REALM_SHORT[info.realm] : "?"}</span>
          <span class="ewa-wl ${won ? "is-win" : "is-loss"}" title="${won ? "Winner" : "Loser"}">${won ? "W" : "L"}</span>
          <span class="ewa-comp-stats">${info.ruleLabel ? `<span class="ewa-comp-rule">${info.ruleLabel}</span>` : ""}${roleStats}${unknownStat}</span>
          <span class="ewa-comp-chips">${chips || '<span class="ewa-muted">-</span>'}</span>
        </div>
        ${support}
      </div>
    `;
  }

  // Only the values that the fight summary does not already add up.
  const STAT_LABELS = Object.keys(STAT_KEYS);

  // Read from the fight data. The rendered page does not always carry a
  // label for these, and then their absence is not worth a warning.
  const PAGE_OPTIONAL = new Set(["Targets Sheared"]);

  function cleanText(element) {
    return element.textContent.replace(/\s+/g, " ").trim();
  }

  function parseNumber(text) {
    const digits = text.replace(/[\s.,\u00a0\u202f]/g, "");
    return /^\d+$/.test(digits) ? Number(digits) : null;
  }

  // A row holds the label, optionally a medal (gold, silver, bronze) and the
  // value. We take the first purely numeric cell that is not the label.
  function valueFromRow(row, labelElement) {
    const leaves = [...row.querySelectorAll("*")]
      .filter(element => element.children.length === 0 && element !== labelElement);

    for (const element of (leaves.length ? leaves : [row])) {
      const value = parseNumber(cleanText(element));
      if (value !== null) return value;
    }

    return null;
  }

  function rowFor(labelElement, wanted) {
    let row = labelElement.closest("tr") || labelElement.parentElement;

    // If the container holds several labels we grabbed too much.
    if (row) {
      const labelCount = [...row.querySelectorAll("*")]
        .filter(element => element.children.length === 0 && wanted.has(cleanText(element).toLowerCase()))
        .length;

      if (labelCount > 1) row = labelElement.parentElement;
    }

    return row;
  }

  function collectStats(splitX, count1, count2, warnings) {
    const wanted = new Map(STAT_LABELS.map(label => [label.toLowerCase(), label]));

    const totals = { 1: {}, 2: {} };
    const found = { 1: {}, 2: {} };

    for (const label of STAT_LABELS) {
      totals[1][label] = 0;
      totals[2][label] = 0;
      found[1][label] = 0;
      found[2][label] = 0;
    }

    const leaves = [...document.querySelectorAll("body *")]
      .filter(element => element.children.length === 0 && !element.closest("#ewa-panel"));

    for (const leaf of leaves) {
      const label = wanted.get(cleanText(leaf).toLowerCase());
      if (!label) continue;

      const row = rowFor(leaf, wanted);
      if (!row) continue;

      const value = valueFromRow(row, leaf);
      if (value === null) continue;

      // Each label sits at the outer edge of its own column, so its x
      // position is enough to tell the two sides apart.
      const side = absLeft(leaf) < splitX ? 1 : 2;

      totals[side][label] += value;
      found[side][label] += 1;
    }

    const mismatched = STAT_LABELS.filter(label =>
      !(PAGE_OPTIONAL.has(label) && !found[1][label] && !found[2][label])
      && (found[1][label] !== count1 || found[2][label] !== count2));

    if (mismatched.length) {
      warnings.push(`Not found for every player: ${mismatched.map(label => label.replace(/^Targets /, "")).join(", ")}. Those sums are incomplete.`);
    }

    return totals;
  }

  function summarize(players) {
    const count = players.length;
    const total = players.reduce((sum, player) => sum + player.points, 0);
    const average = count ? total / count : 0;

    return { count, total, average, label: pointsToRankLabel(average) };
  }

  async function detailFromJson() {
    const id = new URLSearchParams(location.search).get("id");
    const [stat, fight] = await Promise.all([loadStatic(), fetchFight(id)]);

    const group1 = playersFromSide(fight.a, stat);
    const group2 = playersFromSide(fight.b, stat);

    const stats = { 1: {}, 2: {} };
    for (const label of STAT_LABELS) {
      const key = STAT_KEYS[label];
      stats[1][label] = group1.reduce((sum, player) => sum + (player.stats[key] || 0), 0);
      stats[2][label] = group2.reduce((sum, player) => sum + (player.stats[key] || 0), 0);
    }

    const sumOf = (players, key) => players.reduce((sum, player) => sum + (player.stats[key] || 0), 0);
    const totals = {
      1: { dd: sumOf(group1, "dd"), dt: sumOf(group1, "dt"), hd: sumOf(group1, "hd"), d: sumOf(group1, "d"), rn: sumOf(group1, "rn") },
      2: { dd: sumOf(group2, "dd"), dt: sumOf(group2, "dt"), hd: sumOf(group2, "hd"), d: sumOf(group2, "d"), rn: sumOf(group2, "rn") }
    };

    return {
      group1,
      group2,
      stats,
      totals,
      fight,
      matchup: { left: fight.a.s, right: fight.b.s, label: `${fight.a.s}v${fight.b.s}` }
    };
  }

  let reportRunning = false;
  let reportSubmitted = false;

  async function calculateRa() {
    if (reportRunning) return; // a second click on Refresh while loading
    reportRunning = true;
    try {
      await buildReport();
    } finally {
      reportRunning = false;
    }
  }

  async function buildReport() {
    const output = $("#ewa-output");
    const warnings = [];
    let group1;
    let group2;
    let stats = null;
    let totals = null;
    let fight = null;
    let matchup = null;
    let splitX = null;
    let fromPage = false;

    setStatus("Loading fight data ...");

    try {
      ({ group1, group2, stats, totals, fight, matchup } = await detailFromJson());
      // Hand the fight to the shared database. It costs Eden nothing, the
      // data is already loaded. Once per page is enough.
      const token = getToken();
      const fightId = new URLSearchParams(location.search).get("id");
      if (token && fight && fightId && !reportSubmitted) {
        reportSubmitted = true;
        submitDetail(token, fightId, fight).catch(() => { reportSubmitted = false; });
      }
    } catch (error) {
      // Fallback: read the values from the rendered page
      const data = collectGroups();
      if (data.error) {
        output.innerHTML = "";
        setStatus(`${error.message}. ${data.error}`); // textContent, no escaping needed
        return;
      }
      ({ group1, group2, splitX, matchup } = data);
      fromPage = true;
      warnings.push(`${error.message}. Values were read from the page instead.`);
    }

    if (!group1.length || !group2.length) {
      output.innerHTML = "";
      setStatus("Only one group was detected. Reload the page and try again.");
      return;
    }

    const sum1 = summarize(group1);
    const sum2 = summarize(group2);

    if (matchup && (sum1.count !== matchup.left || sum2.count !== matchup.right)) {
      warnings.push(`Eden reports ${sum1.count}v${sum2.count} players, the matchup says ${matchup.label}.`);
    }

    if (fromPage) {
      if (sum1.count > MAX_GROUP || sum2.count > MAX_GROUP) {
        warnings.push("More than 8 players in one group. Probably a value was misread as a realm rank.");
      }
      if (winningSideFromLabels(splitX) === 2) {
        warnings.push("The Victory label is on the right. Winner and loser are probably swapped here.");
      }
      stats = collectStats(splitX, sum1.count, sum2.count, warnings);
    }

    const comp1 = compInfo(group1);
    const comp2 = compInfo(group2);
    const compFound = comp1.known + comp2.known > 0;

    if (!compFound) {
      warnings.push("No classes detected, so the comp overview is missing.");
    } else if (comp1.known < sum1.count || comp2.known < sum2.count) {
      warnings.push("Not every player has a class, so the comp overview is incomplete.");
    }

    output.innerHTML = `
      ${heroHtml({ group1, group2, comp1, comp2, fight, matchup })}

      ${compFound ? `
      <div class="ewa-section-title">Comp</div>
      <div class="ewa-comp">
        ${compRowHtml(comp1, true)}
        ${compRowHtml(comp2, false)}
      </div>
      ` : ""}

      ${balanceHtml(totals, sum1, sum2)}

      <div class="ewa-section-title">Crowd control &amp; support</div>
      ${duelRowsHtml(STAT_LABELS.map(label => ({
        label: label.replace(/^Targets /, ""),
        left: stats[1][label],
        right: stats[2][label]
      })))}

      <div class="ewa-section-title has-hint">Players<i class="ewa-rule"></i><em class="ewa-hint">dmg &amp; heal from 1k</em></div>
      <div class="ewa-rosters">
        ${rosterHtml("Winner", group1, comp1, true)}
        ${rosterHtml("Loser", group2, comp2, false)}
      </div>

      ${warnings.length ? `<div class="ewa-warn ewa-sec-break">${warnings.map(esc).join("<br>")}</div>` : ""}
    `;

    setStatus("");
  }

  // Mirrored bars, as used for crowd control. invert = lower is better.
  function duelRowsHtml(rows) {
    return `
      <div class="ewa-duel">
        ${rows.map(row => {
          const max = Math.max(row.left, row.right, 1);
          const leftLead = row.invert ? row.left < row.right : row.left > row.right;
          const rightLead = row.invert ? row.right < row.left : row.right > row.left;
          const show = row.short ? fmtShort : fmt;
          return `
            <div class="ewa-duel-row"${row.hint ? ` title="${row.hint}"` : ""}>
              <span class="ewa-duel-val ${leftLead ? "lead" : ""}">${show(row.left)}${row.leftNote ? `<i>${row.leftNote}</i>` : ""}</span>
              <div class="ewa-duel-mid">
                <span class="ewa-duel-name">${row.label}</span>
                <div class="ewa-duel-bar">
                  <div class="half l"><span style="width:${row.left / max * 100}%"></span></div>
                  <div class="half r"><span style="width:${row.right / max * 100}%"></span></div>
                </div>
                ${row.sub ? `<span class="ewa-duel-sub">${row.sub}</span>` : ""}
              </div>
              <span class="ewa-duel-val ${rightLead ? "lead" : ""}">${show(row.right)}${row.rightNote ? `<i>${row.rightNote}</i>` : ""}</span>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  // Report header: who fought here, group leader first.
  function heroSideHtml(players, comp, leader, won) {
    const names = [...players.map(player => player.name)];
    const lead = names.findIndex(name => name === leader);
    if (lead > 0) names.unshift(names.splice(lead, 1)[0]);

    return `
      <div class="ewa-hero-side ${won ? "is-win" : "is-loss"} ewa-realm-${realmKeyOf(comp.realm)}">
        <div class="ewa-hero-head">
          <span class="ewa-realm-tag">${comp.realm ? REALM_SHORT[comp.realm] : "?"}</span>
          <span class="ewa-hero-tag">${won ? "Victory" : "Defeat"}</span>
          <span class="ewa-hero-count">${players.length}</span>
        </div>
        <div class="ewa-hero-names">${names.map(esc).join(" · ")}</div>
      </div>
    `;
  }

  function heroHtml(info) {
    const { group1, group2, comp1, comp2, fight, matchup } = info;
    const seconds = fight ? fight.d : null;
    const size = matchup ? Math.max(matchup.left, matchup.right) : group1.length;
    const duration = durationClass(seconds, size);
    const started = fight && fight.t ? new Date(fight.t) : null;

    return `
      <div class="ewa-hero">
        ${heroSideHtml(group1, comp1, fight && fight.a && fight.a.l, true)}
        <div class="ewa-hero-mid">
          <span class="ewa-hero-matchup">${matchup ? esc(matchup.label) : ""}</span>
          <span class="ewa-hero-time ${duration.cls}" title="${esc(duration.hint)}">${seconds !== null ? fmtDuration(seconds) : "-"}</span>
          <span class="ewa-hero-date">${started ? fmtDate(started) : ""}</span>
        </div>
        ${heroSideHtml(group2, comp2, fight && fight.b && fight.b.l, false)}
      </div>
    `;
  }

  function balanceHtml(totals, sum1, sum2) {
    if (!totals) return "";

    // Kills are the other side's deaths, so one row is enough.
    // Resurrections hang below the death count.
    const rez = side => (totals[side].rn ? `${totals[side].rn} rez` : "");

    const rows = [
      { label: "Damage", left: totals[1].dd, right: totals[2].dd, short: true },
      { label: "Healing", left: totals[1].hd, right: totals[2].hd, short: true },
      { label: "Deaths", left: totals[1].d, right: totals[2].d, invert: true, leftNote: rez(1), rightNote: rez(2) },
      { label: "RA points", left: sum1.total, right: sum2.total, hint: `Average rank ${sum1.label} vs ${sum2.label}`, sub: `Ø ${sum1.label} vs ${sum2.label}` }
    ];

    return `
      <div class="ewa-section-title">Totals</div>
      ${duelRowsHtml(rows)}
    `;
  }

  const MIN_SHOWN = 1000; // smaller damage and heal values are noise

  function rosterHtml(title, players, comp, won) {
    const value = player => player.stats.dd || 0;
    const sorted = [...players].sort((a, b) => value(b) - value(a) || b.points - a.points);
    const big = number => (number >= MIN_SHOWN ? fmtShort(number) : null);

    // Share of the team damage and healing, so you can see who carried the fight
    const teamDamage = players.reduce((sum, player) => sum + (player.stats.dd || 0), 0);
    const teamHeal = players.reduce((sum, player) => sum + (player.stats.hd || 0), 0);
    const shareOf = (value, total) => (total && value >= MIN_SHOWN ? Math.round(value / total * 100) : 0);

    return `
      <div class="ewa-roster ewa-realm-${realmKeyOf(comp.realm)}">
        <div class="ewa-roster-head ${won ? "is-win" : "is-loss"}"><span class="ewa-realm-tag">${comp.realm ? REALM_SHORT[comp.realm] : "?"}</span>${title}</div>
        ${sorted.map(player => {
          const role = player.cls ? comp.roleFn(player.cls) : "Unknown";
          const damage = big(player.stats.dd || 0);
          const heal = big(player.stats.hd || 0);
          const taken = big(player.stats.dt || 0);
          const healed = big(player.stats.hr || 0);
          const mez = player.stats.tm || 0;
          const stun = player.stats.ts || 0;
          const root = player.stats.tr || 0;
          const peel = player.stats.ta || 0;
          const interrupts = player.stats.ti || 0;
          const shears = player.stats.br || 0;
          const diseases = player.stats.td || 0;
          const nearsights = player.stats.tn || 0;
          const deaths = player.stats.d || 0;
          const dmgShare = shareOf(player.stats.dd || 0, teamDamage);
          const healShare = shareOf(player.stats.hd || 0, teamHeal);
          return `
            <div class="ewa-pl ewa-role-${ROLE_CLASS[role]}">
              <div class="ewa-pl-top">
                <span class="ewa-pl-name">${esc(player.name)}</span>
                <span class="ewa-pl-cls">${esc(player.cls || "unknown")}</span>
                <span class="ewa-pl-rr" title="${fmt(player.points)} RA points">${player.rankLabel}</span>
              </div>
              <div class="ewa-pl-nums">
                ${damage ? `<span title="Damage done, ${dmgShare}% of the team">` +
                  `<b class="dmg">${damage}</b> dmg${dmgShare ? `<i class="ewa-pl-share">${dmgShare}%</i>` : ""}</span>` : ""}
                ${taken ? `<span title="Damage taken"><b class="taken">${taken}</b> taken</span>` : ""}
                ${heal ? `<span title="Healing done, ${healShare}% of the team">` +
                  `<b class="heal">${heal}</b> heal${healShare ? `<i class="ewa-pl-share">${healShare}%</i>` : ""}</span>` : ""}
                ${healed ? `<span title="Healing received"><b class="healr">${healed}</b> recv</span>` : ""}
                ${mez ? `<span title="Targets mezzed"><b class="mez">${mez}</b> mez</span>` : ""}
                ${stun ? `<span title="Targets stunned"><b class="stun">${stun}</b> stun</span>` : ""}
                ${root ? `<span title="Targets rooted"><b class="root">${root}</b> root</span>` : ""}
                ${peel ? `<span title="Targets peeled"><b class="peel">${peel}</b> peel</span>` : ""}
                ${interrupts ? `<span title="Targets interrupted"><b class="int">${interrupts}</b> rupt</span>` : ""}
                ${shears ? `<span title="Targets sheared"><b class="shear">${shears}</b> shear</span>` : ""}
                ${diseases ? `<span title="Targets diseased"><b class="disease">${diseases}</b> disease</span>` : ""}
                ${nearsights ? `<span title="Targets nearsighted"><b class="ns">${nearsights}</b> ns</span>` : ""}
                ${deaths ? `<span class="ewa-pl-death" title="Deaths">✝ ${deaths}</span>` : ""}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  // ---------------------------------------------------------------
  // Collapsible sections
  // ---------------------------------------------------------------
  // A click on a section title hides everything up to the next title.
  // The choice is kept per title, also across page loads.
  //
  // A section ends at the next title, at an element that contains a title
  // (such as the two column "most wins / most losses" block), at an element
  // marked "ewa-sec-break" (head-to-head box, warnings) or at the footer.
  // Titles with data-sec use that as their key instead of their text, so
  // titles with changing text (class names) share one setting.
  // Titles with data-closed="1" start closed.

  const COLLAPSE_KEY = "ewa-collapsed-v1";
  const collapsed = new Set(storageGet(COLLAPSE_KEY) || []);

  // Up to 0.77 these keys were built from the title text
  for (const [from, to] of [["a:win rate by class", "a:classes"], ["a:loading status", "a:status"]]) {
    if (collapsed.delete(from)) collapsed.add(to);
  }

  function sectionKey(title) {
    if (title.dataset.key) return title.dataset.key;
    const page = isDetailPage() ? "d" : (title.closest("#ewa-ana") ? "a" : "l");
    let name = title.dataset.sec;
    if (!name && title.closest(".ewa-opponents")) name = "opp";
    if (!name) {
      const clone = title.cloneNode(true);
      clone.querySelectorAll("em, i").forEach(element => element.remove());
      name = clone.textContent.replace(/\d+/g, "").trim().toLowerCase();
    }
    title.dataset.key = `${page}:${name}`;
    return title.dataset.key;
  }

  function endsSection(element) {
    return element.classList.contains("ewa-section-title")
      || element.classList.contains("ewa-foot")
      || element.classList.contains("ewa-sec-break")
      || !!element.querySelector(".ewa-section-title");
  }

  // Content that belongs to a title
  function sectionTargets(title) {
    const pair = title.closest(".ewa-opponents");
    if (pair) {
      return [...pair.querySelectorAll(".ewa-opp-col > *")].filter(element => !element.classList.contains("ewa-section-title"));
    }
    const result = [];
    let next = title.nextElementSibling;
    while (next && !endsSection(next)) {
      result.push(next);
      next = next.nextElementSibling;
    }
    return result;
  }

  function applyCollapse(root) {
    for (const title of (root || document).querySelectorAll("#ewa-panel .ewa-section-title")) {
      if (!title.querySelector(":scope > .ewa-caret")) {
        title.insertAdjacentHTML("afterbegin", '<i class="ewa-caret"></i>');
        title.classList.add("ewa-sec-head");
        title.title = "Click to collapse or expand";
      }
      const closed = collapsed.has(sectionKey(title)) !== (title.dataset.closed === "1");
      title.classList.toggle("is-closed", closed);
      for (const element of sectionTargets(title)) element.classList.toggle("ewa-sec-hidden", closed);
    }
  }

  function toggleSection(title) {
    const key = sectionKey(title);
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    storageSet(COLLAPSE_KEY, [...collapsed]);
    const panel = $("#ewa-panel");
    applyCollapse(panel);
  }

  // Re-applies the collapsed state whenever new content is drawn. Only
  // mutations that bring in a section title matter; status line updates
  // and similar small changes are ignored.
  function watchCollapse(panel) {
    let frame = null;
    const bringsTitle = mutation => [...mutation.addedNodes].some(node =>
      node.nodeType === 1 && (node.classList.contains("ewa-section-title") || node.querySelector(".ewa-section-title")));

    new MutationObserver(mutations => {
      if (frame || !mutations.some(bringsTitle)) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        applyCollapse(panel);
      });
    }).observe(panel, { childList: true, subtree: true });
    applyCollapse(panel);
  }

  // ---------------------------------------------------------------
  // Eden lists for the shared database
  // ---------------------------------------------------------------
  //   /hrald/proxy.php?fights/list             the latest 500 fights
  //   /hrald/proxy.php?fights/player/<name>    the latest 300 fights of one player
  //
  // Eden sends "X-Herald-Api: minified" with every request. Without it the
  // list comes back wrapped in HTML.

  const LIST_URL = "/hrald/proxy.php?fights/list";
  const PLAYER_URL = (name, size) =>
    `/hrald/proxy.php?fights/player/${encodeURIComponent(name)}?exact=1${size ? `&min=${size}&max=${size}` : ""}`;

  const EDEN_HEADERS = {
    "X-Herald-Api": "minified",
    "X-Requested-With": "XMLHttpRequest",
    Accept: "application/json, text/javascript, */*"
  };

  const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;

  function edenError(message) {
    const error = new Error(message);
    error.eden = true;
    return error;
  }

  // Understands plain JSON and JSON that Eden wraps in HTML.
  function parseEdenJson(text) {
    const raw = String(text || "").trim();
    let json = raw;
    if (raw.startsWith("<")) {
      const body = new DOMParser().parseFromString(raw, "text/html").body;
      json = body ? body.textContent.replace(/\u00a0/g, " ").trim() : "";
    }
    if (!json.startsWith("{") && !json.startsWith("[")) throw edenError("Eden sent no data");
    try {
      return JSON.parse(json);
    } catch (error) {
      throw edenError("Eden sent unreadable data");
    }
  }

  const EDEN_TIMEOUT = 20 * SECOND;

  // One request to Eden. Every way it can fail (network, timeout, HTTP
  // error, unreadable answer) ends as an Eden error, so the collector
  // pauses with the right reason. 404 is a normal answer: fight gone.
  async function edenFetchJson(url, headers) {
    const controller = new pageWindow.AbortController();
    const timer = setTimeout(() => controller.abort(), EDEN_TIMEOUT);
    try {
      const response = await pageWindow.fetch(url, { credentials: "same-origin", headers, signal: controller.signal });
      if (response.status === 404) return { notFound: true };
      const text = await response.text();
      if (!response.ok) {
        const error = edenError(`Eden HTTP ${response.status}`);
        error.status = response.status;
        error.retryAfter = response.headers.get("Retry-After") || ""; // seconds or a date, if Eden sends it
        throw error;
      }
      return parseEdenJson(text);
    } catch (error) {
      if (error.eden) throw error;
      throw edenError(error.name === "AbortError" ? "Eden does not answer" : "Eden not reachable or unreadable answer");
    } finally {
      clearTimeout(timer);
    }
  }

  const edenJson = url => edenFetchJson(url, EDEN_HEADERS);

  function edenNames(value) {
    return (Array.isArray(value) ? value : String(value || "").split(","))
      .map(name => String(name).trim())
      .filter(Boolean);
  }

  function edenEntries(data) {
    return Object.keys(data || {}).filter(key => key !== "t").map(key => data[key]).filter(Boolean);
  }

  // ---------------------------------------------------------------
  // Shared database (Supabase)
  // ---------------------------------------------------------------
  // Everybody with the script may read. Writing only goes through checking
  // functions inside the database and needs a personal key.

  const SB_URL = "https://bvbrhgyvwmhypmyuuqeu.supabase.co";
  const SB_KEY = "sb_publishable_xFsrXEB0pYNgV_nljbK6lw_yySLDZ5c";
  const TOKEN_KEY = "ewa-token";
  const DB_TIMEOUT = 20 * SECOND;

  // Every installation gets its own key on first start, so everybody who
  // uses the script feeds the database. A key that is abused can be
  // blocked alone. Duplicates are impossible, each fight id is taken once.
  let registering = false;

  async function ensureToken() {
    if (getToken() || registering) return getToken();
    registering = true;
    try {
      const token = await sbRpc("register_submitter", { p_label: "auto" });
      if (token) {
        setToken(token);
        collectInfo("Key created for this browser");
      }
    } catch (error) {
      collectInfo(`No key yet (${error.message}), next try later`);
    } finally {
      registering = false;
    }
    return getToken();
  }

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function setToken(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (error) {
      // never mind
    }
  }

  function dbError(message) {
    const error = new Error(message);
    error.db = true;
    return error;
  }

  function sbRpc(fn, body) {
    return new Promise((resolve, reject) => {
      const done = (status, text) => {
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch (error) {
          json = null;
        }
        if (status >= 200 && status < 300) resolve(json);
        else reject(dbError((json && (json.message || json.hint)) || `Database HTTP ${status}`));
      };
      const url = `${SB_URL}/rest/v1/rpc/${fn}`;
      const headers = { apikey: SB_KEY, "Content-Type": "application/json" };
      const data = JSON.stringify(body || {});

      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method: "POST",
          url,
          headers,
          data,
          timeout: DB_TIMEOUT,
          onload: res => done(res.status, res.responseText),
          onerror: () => reject(dbError("Database not reachable")),
          ontimeout: () => reject(dbError("Database does not answer")),
          onabort: () => reject(dbError("Database request aborted"))
        });
      } else {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), DB_TIMEOUT);
        fetch(url, { method: "POST", headers, body: data, signal: controller.signal })
          .then(res => res.text().then(text => done(res.status, text)))
          .catch(() => reject(dbError("Database not reachable")))
          .finally(() => clearTimeout(timer));
      }
    });
  }

  // Race id to realm, as in Eden's own fights.js
  function raceRealm(race) {
    if ([1, 2, 3, 4, 13, 16].includes(race)) return 1;
    if ([5, 6, 7, 8, 14, 17, 20].includes(race)) return 2;
    if ([9, 10, 11, 12, 15, 18, 21].includes(race)) return 3;
    return null;
  }

  // Entry from Eden's lists in the database format
  function dbEntry(entry) {
    return {
      id: String(entry.id || ""),
      s: entry.s,
      m: entry.m,
      wr: entry.wr,
      lr: entry.lr,
      d: Math.round(Number(entry.d) || 0),
      w: edenNames(entry.w),
      l: edenNames(entry.l)
    };
  }

  // Fight detail (raw or trimmed) in the database format
  function dbEntryFromDetail(id, fight) {
    const a = (fight.a && fight.a.p) || [];
    const b = (fight.b && fight.b.p) || [];
    return {
      id: String(id),
      s: fight.s || fight.t,
      m: `${a.length}v${b.length}`,
      wr: raceRealm(a[0] && a[0].r),
      lr: raceRealm(b[0] && b[0].r),
      d: Math.round(Number(fight.d) || 0),
      w: a.map(p => p.n),
      l: b.map(p => p.n)
    };
  }

  function charsFromDetail(fight) {
    return [...((fight.a && fight.a.p) || []), ...((fight.b && fight.b.p) || [])]
      .map(p => ({ n: p.n, c: p.c, r: p.r }));
  }

  async function submitDetail(token, id, fight) {
    const res = await sbRpc("submit_fights", { p_token: token, p_fights: [dbEntryFromDetail(id, fight)] });
    const chars = await sbRpc("submit_chars", { p_token: token, p_fight: String(id), p_chars: charsFromDetail(fight) });
    return { res, chars };
  }

  // ---------------------------------------------------------------
  // Data collection in the background
  // ---------------------------------------------------------------
  // One request to Eden per step, in one tab only, with a daily limit. The
  // pace adapts to Eden's rate limit (see COLLECT). On other errors from
  // Eden it pauses, and the pause doubles as long as the errors go on.

  const COLLECT = {
    tickMs: 2 * SECOND,         // normal pace: one request to Eden every 2 s
    minTickMs: SECOND,          // fastest pace, only reached without recent 429
    afterLimitFloorMs: 2 * SECOND, // after a 429 the pace stays at least this slow ...
    afterLimitHoldMs: HOUR,     // ... for this long, so your own browsing on Eden keeps some room
    maxTickMs: 30 * SECOND,     // slowest pace after repeated "too many requests"
    slowDown: 1.5,              // pace factor after Eden answered 429
    speedUpEveryMs: 5 * MINUTE, // the pace speeds up at most this often ...
    speedUpAfter: 20,           // ... and only after this many successful steps in a row
    speedUp: 0.9,               // pace factor when speeding up
    maxRetryAfterMs: 30 * MINUTE, // cap for the wait time Eden asks for
    rateLimitPauseMs: 2 * MINUTE, // pause after a 429 when Eden does not say how long
    dailyLimit: 40000,          // requests to Eden per day, about one every 2 s around the clock
    listEveryMs: 20 * MINUTE,   // the general list holds the latest 500 fights
    pauseMs: 15 * MINUTE,       // first pause after repeated Eden errors, doubles each time
    maxPauseMs: 2 * HOUR,
    dbPauseMs: 2 * MINUTE,      // pause after a database error
    idleRefillMs: MINUTE,       // ask for new jobs this often when there was nothing to do
    registerEveryMs: 10 * MINUTE,
    lockTtlMs: MINUTE,          // another tab takes over when the heartbeat is older
    claimFights: 10,
    claimCrawl: 10
  };
  const COLLECT_STATE_KEY = "ewa-collect-v1";
  const COLLECT_LOCK_KEY = "ewa-collect-lock";
  const TAB_ID = Math.random().toString(36).slice(2);

  const jobs = { fights: [], crawl: [] };
  let jobTurn = 0;
  let collectBusy = false;
  let lastRefill = 0;
  let edenFailsInRow = 0;

  function collectState() {
    const s = storageGet(COLLECT_STATE_KEY) || {};
    const today = new Date().toDateString();
    return {
      enabled: s.enabled !== false,
      day: today,
      count: s.day === today ? s.count || 0 : 0,
      lastList: s.lastList || 0,
      pauseUntil: s.pauseUntil || 0,
      backoff: s.backoff || 0,
      pauseReason: s.pauseReason || "",
      lastInfo: s.lastInfo || "",
      lastAt: s.lastAt || 0,
      pace: Math.min(Math.max(s.pace || COLLECT.tickMs, COLLECT.minTickMs), COLLECT.maxTickMs),
      lastLimitAt: Math.min(s.lastLimitAt || 0, Date.now()), // a clock set back must not hold the floor
      lastSpeedAt: Math.min(s.lastSpeedAt || 0, Date.now()),
      okInRow: Math.min(s.okInRow || 0, COLLECT.speedUpAfter)
    };
  }

  function collectSave(patch) {
    const s = { ...collectState(), ...patch };
    storageSet(COLLECT_STATE_KEY, s);
    return s;
  }

  // Only one tab collects. The others wait until its heartbeat is older
  // than lockTtlMs. The heartbeat is renewed before every step of a job, and
  // every network call has a timeout well below the TTL, so a slow job
  // cannot lose the lock to another tab halfway.
  function isCollectorTab() {
    const lock = storageGet(COLLECT_LOCK_KEY);
    if (!lock || lock.tab === TAB_ID || Date.now() - lock.t > COLLECT.lockTtlMs) {
      heartbeat();
      return true;
    }
    return false;
  }

  // Read only: does this tab hold the collector role right now?
  function ownsCollectorLock() {
    const lock = storageGet(COLLECT_LOCK_KEY);
    return !lock || lock.tab === TAB_ID || Date.now() - lock.t > COLLECT.lockTtlMs;
  }

  function heartbeat() {
    storageSet(COLLECT_LOCK_KEY, { tab: TAB_ID, t: Date.now() });
  }

  function countEdenRequest() {
    heartbeat();
    collectSave({ count: collectState().count + 1 });
  }

  function collectInfo(text) {
    collectSave({ lastInfo: text, lastAt: Date.now() });
  }

  async function jobList(token) {
    countEdenRequest();
    const data = await edenJson(LIST_URL);
    if (data.notFound) throw edenError("List not found");
    const entries = edenEntries(data).map(dbEntry);
    heartbeat();
    const res = (await sbRpc("submit_fights", { p_token: token, p_fights: entries })) || {};
    await sbRpc("mark_list_poll", { p_token: token });
    collectSave({ lastList: Date.now() });
    collectInfo(`List: ${fmt(res.inserted)} new, ${fmt(res.known)} known${res.rejected ? `, ${fmt(res.rejected)} rejected` : ""}`);
  }

  async function jobDetail(token, id) {
    countEdenRequest();
    let json;
    try {
      json = await edenFetchJson(FIGHT_URL(id), {});
    } catch (error) {
      if (error.status === 429) jobs.fights.unshift(id); // try this fight again after the pause
      throw error;
    }
    heartbeat();
    if (json.notFound) {
      await sbRpc("report_missing", { p_token: token, p_fight: id });
      collectInfo(`Fight ${id} no longer exists`);
      return;
    }
    const { chars } = await submitDetail(token, id, json);
    collectInfo(`Classes from fight ${id}: ${fmt(chars && chars.updated)} new`);
  }

  async function jobCrawl(token, job) {
    countEdenRequest();
    let data;
    try {
      data = await edenJson(PLAYER_URL(job.name, job.size));
    } catch (error) {
      // A rate limit says nothing about this player: the job goes back to
      // the queue. Any other error: one player with an odd name must not
      // stop everything, so the job counts as done, and the Eden error still
      // counts towards the pause, also when the report itself fails.
      if (error.status === 429) {
        jobs.crawl.unshift(job);
        throw error;
      }
      await sbRpc("report_crawl", { p_token: token, p_name: job.name, p_size: job.size, p_count: -1 }).catch(() => {});
      throw error;
    }
    heartbeat();
    const entries = data.notFound ? [] : edenEntries(data).map(dbEntry);
    let inserted = 0;
    if (entries.length) {
      const res = (await sbRpc("submit_fights", { p_token: token, p_fights: entries })) || {};
      inserted = res.inserted || 0;
    }
    await sbRpc("report_crawl", { p_token: token, p_name: job.name, p_size: job.size, p_count: entries.length });
    collectInfo(`${job.name}${job.size ? ` (${job.size}-man)` : ""}: ${fmt(entries.length)} fights, ${fmt(inserted)} new`);
  }

  // Speeds up by speedUp at most every speedUpEveryMs, and only after
  // speedUpAfter successful steps in a row. Time based, so a slow pace after
  // repeated 429 recovers within hours, not days. Within afterLimitHoldMs of
  // the last 429 the pace stays at afterLimitFloorMs or slower.
  function paceAfterSuccess(state) {
    const now = Date.now();
    const patch = { okInRow: Math.min(state.okInRow + 1, COLLECT.speedUpAfter) };
    if (state.backoff) Object.assign(patch, { backoff: 0, pauseReason: "" });

    const floor = now - state.lastLimitAt < COLLECT.afterLimitHoldMs ? COLLECT.afterLimitFloorMs : COLLECT.minTickMs;
    const due = patch.okInRow >= COLLECT.speedUpAfter && now - state.lastSpeedAt >= COLLECT.speedUpEveryMs;
    if (due && state.pace > floor) {
      Object.assign(patch, { okInRow: 0, lastSpeedAt: now, pace: Math.max(floor, state.pace * COLLECT.speedUp) });
    }
    return patch;
  }

  // Retry-After comes as seconds or as an HTTP date
  function retryAfterMs(value) {
    if (!value) return 0;
    const seconds = Number(value);
    const ms = Number.isFinite(seconds) ? seconds * SECOND : Date.parse(value) - Date.now();
    return Number.isFinite(ms) && ms > 0 ? Math.min(ms, COLLECT.maxRetryAfterMs) : 0;
  }

  function handleCollectError(error) {
    // Any error breaks the run of successful steps the speed up waits for
    collectSave({ okInRow: 0 });

    // 429 "too many requests" is Eden's rate limit, not an outage. Slow
    // down for good and wait as long as Eden asks, instead of returning to
    // the old pace after a long pause and hitting the limit again.
    if (error.eden && error.status === 429) {
      const state = collectState();
      const pace = Math.min(Math.max(state.pace * COLLECT.slowDown, state.pace + SECOND), COLLECT.maxTickMs);
      const wait = retryAfterMs(error.retryAfter) || COLLECT.rateLimitPauseMs;
      collectSave({
        pace,
        okInRow: 0,
        lastLimitAt: Date.now(),
        pauseUntil: Date.now() + wait,
        pauseReason: `Eden asks to slow down (429), new pace one request every ${(pace / SECOND).toFixed(1)} s`
      });
      edenFailsInRow = 0;
      return;
    }

    if (error.eden) {
      edenFailsInRow += 1;
      if (edenFailsInRow < 2) {
        collectInfo(`Error from Eden (${error.message}), next try as usual`);
        return;
      }
      const state = collectState();
      const backoff = state.backoff + 1;
      const pause = Math.min(COLLECT.pauseMs * 2 ** (backoff - 1), COLLECT.maxPauseMs);
      collectSave({ backoff, pauseUntil: Date.now() + pause, pauseReason: `Eden: ${error.message}` });
      edenFailsInRow = 0;
      return;
    }

    const message = String(error.message || error);
    if (/invalid token/i.test(message)) {
      // Behaviour change: earlier versions switched collecting off and kept
      // the dead key. Now the key is dropped and the next tick registers a
      // new one. A blocked key therefore only stops that key, not the browser.
      setToken("");
      jobs.fights.length = 0;
      jobs.crawl.length = 0;
      collectInfo("Key no longer valid, a new one will be requested");
    } else if (/daily limit/i.test(message)) {
      collectSave({ pauseUntil: Date.now() + HOUR, pauseReason: "Daily limit of the database reached" });
    } else {
      collectSave({ pauseUntil: Date.now() + COLLECT.dbPauseMs, pauseReason: `Database: ${message}` });
    }
  }

  let lastRegister = 0;

  // Browsers slow timers in background tabs down to about once a minute,
  // but only timers that keep re-arming themselves (setInterval, or a
  // setTimeout set from inside another timer). Two ways around that:
  // 1. The pause between two steps is timed by a worker. Workers are not
  //    slowed down. Some pages do not allow workers, then:
  // 2. The pause is a plain setTimeout, set right after a network answer,
  //    not from inside a timer, so the browser does not count it as a
  //    re-arming timer either. Steps without a network request (paused,
  //    another tab collects) do not get this benefit; those may be slowed
  //    to once a minute in a hidden tab, which only delays the end of a pause.
  // The collector therefore runs as a loop: one step, then a pause, then
  // the next step. A step never overlaps with the next one.
  let timerMode = "starting";
  let workerSleep = null;

  const WORKER_CHECK_MS = 3 * SECOND;   // the worker must answer within this time to be used
  const WORKER_GRACE_MS = 10 * SECOND;  // a worker pause that takes this much longer counts as lost

  function startWorkerTimer() {
    return new Promise(resolve => {
      let url = null;
      try {
        const code = "onmessage = e => setTimeout(() => postMessage(e.data), e.data.ms);";
        url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
        const worker = new Worker(url);
        const waiting = new Map();
        let nextId = 1;

        // If the worker dies, every pause still waiting ends at once and the
        // loop goes on with the page timer.
        const fail = () => {
          worker.terminate();
          for (const done of waiting.values()) done();
          waiting.clear();
          workerSleep = null;
          timerMode = "page";
        };

        worker.onmessage = event => {
          const done = waiting.get(event.data.id);
          waiting.delete(event.data.id);
          if (done) done();
        };
        worker.onerror = () => {
          fail();
          resolve(null);
        };

        // Each pause also has a page timer as a safety net, so a lost
        // message can never stop the collector for good.
        const sleep = ms => new Promise(done => {
          const id = nextId++;
          const startedAt = Date.now();
          const backup = setTimeout(() => {
            if (!waiting.delete(id)) return;
            done();
            // Far too late means the whole tab was frozen or the computer
            // slept: not the worker's fault. Only a backup that fired on time
            // shows that the worker lost the message.
            const late = Date.now() - startedAt - (ms + WORKER_GRACE_MS);
            if (late < WORKER_GRACE_MS) fail();
          }, ms + WORKER_GRACE_MS);
          waiting.set(id, () => {
            clearTimeout(backup);
            done();
          });
          worker.postMessage({ id, ms });
        });

        const check = setTimeout(() => {
          fail();
          resolve(null);
        }, WORKER_CHECK_MS);
        sleep(0).then(() => {
          clearTimeout(check);
          if (timerMode !== "page") resolve(sleep); // not if the check already gave up
        });
      } catch (error) {
        resolve(null);
      } finally {
        // The worker has its code once it is created; a failed start needs no URL either
        if (url) setTimeout(() => URL.revokeObjectURL(url), WORKER_CHECK_MS);
      }
    });
  }

  const pageSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Chrome slows hidden tabs down hard and may freeze them after a while.
  // It leaves pages alone that hold a Web Lock or keep a WebRTC connection
  // open. Both cost next to nothing: the lock is held until the tab closes,
  // and the WebRTC connection runs between two endpoints inside this page,
  // nothing leaves the computer.
  let awakeMode = [];

  function keepAwake() {
    try {
      if (navigator.locks) {
        // One lock per tab: an exclusive lock with a shared name would only
        // ever be held by the first tab, the others would wait forever.
        navigator.locks.request(`ewa-keep-awake-${TAB_ID}`, () => {
          awakeMode.push("lock");
          return new Promise(() => {});
        }).catch(() => {});
      }
    } catch (error) {
      // not available, never mind
    }

    try {
      const a = new RTCPeerConnection();
      const b = new RTCPeerConnection();
      a.onicecandidate = event => event.candidate && b.addIceCandidate(event.candidate).catch(() => {});
      b.onicecandidate = event => event.candidate && a.addIceCandidate(event.candidate).catch(() => {});
      const channel = a.createDataChannel("ewa");
      channel.onopen = () => awakeMode.push("rtc");
      channel.onclose = () => {
        awakeMode = awakeMode.filter(mode => mode !== "rtc");
      };
      a.createOffer()
        .then(offer => a.setLocalDescription(offer))
        .then(() => b.setRemoteDescription(a.localDescription))
        .then(() => b.createAnswer())
        .then(answer => b.setLocalDescription(answer))
        .then(() => a.setRemoteDescription(b.localDescription))
        .catch(() => {});
      window.__ewaAwake = [a, b, channel]; // keep references so nothing gets collected
    } catch (error) {
      // WebRTC blocked, then only the lock helps
    }
  }

  async function runCollector() {
    keepAwake();
    workerSleep = await startWorkerTimer();
    timerMode = workerSleep ? "worker" : "page";
    for (;;) {
      const started = Date.now();
      try {
        await collectorTick();
      } catch (error) {
        // collectorTick handles its own errors, this is only a safety net
      }
      const wait = Math.max(200, collectState().pace - (Date.now() - started));
      await (workerSleep || pageSleep)(wait);
    }
  }

  async function collectorTick() {
    let token = getToken();
    if (!token) {
      if (!collectState().enabled || Date.now() - lastRegister < COLLECT.registerEveryMs) return;
      lastRegister = Date.now();
      token = await ensureToken();
      if (!token) return;
      renderAnaSide();
      migrateOldArchive();
    }

    const state = collectState();
    if (!state.enabled || Date.now() < state.pauseUntil || state.count >= COLLECT.dailyLimit || !isCollectorTab()) {
      renderCollectStatus(); // cheap, only writes when the text changed
      return;
    }

    collectBusy = true;
    try {
      if (Date.now() - state.lastList > COLLECT.listEveryMs) {
        await jobList(token);
      } else if (!jobs.fights.length && !jobs.crawl.length) {
        // Fetch new jobs. This is no request to Eden. Right away while there
        // is work, once per idleRefillMs when there was none.
        if (Date.now() - lastRefill > COLLECT.idleRefillMs) {
          const claimed = await sbRpc("claim_jobs", { p_token: token, p_fights: COLLECT.claimFights, p_crawl: COLLECT.claimCrawl });
          jobs.fights.push(...((claimed && claimed.fights) || []));
          jobs.crawl.push(...((claimed && claimed.crawl) || []));
          if (!jobs.fights.length && !jobs.crawl.length) {
            lastRefill = Date.now();
            collectInfo("Nothing to do, waiting for new fights");
          }
        }
        return;
      } else {
        const takeFight = jobs.fights.length && (!jobs.crawl.length || jobTurn++ % 2 === 0);
        if (takeFight) await jobDetail(token, jobs.fights.shift());
        else await jobCrawl(token, jobs.crawl.shift());
      }
      edenFailsInRow = 0;
      collectSave(paceAfterSuccess(collectState()));
    } catch (error) {
      handleCollectError(error);
    } finally {
      collectBusy = false;
      renderCollectStatus();
    }
  }

  // ---------------------------------------------------------------
  // Old browser archive: handed over to the shared database once
  // ---------------------------------------------------------------
  // Up to version 0.73 every loaded fight was kept in this browser
  // (IndexedDB "ewa"). That is now done by the shared database. With a key
  // the old archive is uploaded once, then deleted here. This costs Eden
  // nothing, all data is already in the browser.

  const DB_NAME = "ewa";
  const DB_STORE = "fights";
  const OLD_ARCHIVE_KEY = "ewa_archive_v1"; // from the very first version
  const MIGRATE_BATCH = 500;
  const LETTER_REALM = { A: 1, M: 2, H: 3 };

  // A fight id counts the seconds since 1 Sep 2023, 00:00 Berlin time.
  const ID_EPOCH = Date.UTC(2023, 7, 31, 22, 0, 0);
  const idToIso = id => new Date(ID_EPOCH + parseInt(id, 36) * 1000).toISOString();

  let migrateState = "";
  let migrating = false;

  function openOldArchive() {
    return new Promise(resolve => {
      if (!window.indexedDB) return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        // There was no archive. Nothing to do, the empty database is removed below.
        request.transaction.abort();
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    });
  }

  function readAll(database) {
    return new Promise(resolve => {
      if (!database.objectStoreNames.contains(DB_STORE)) return resolve([]);
      const request = database.transaction(DB_STORE).objectStore(DB_STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => resolve([]);
    });
  }

  function archiveRecordToDb(record) {
    const id = String(record.i || "");
    const winners = record.w || [];
    const losers = record.l || [];
    return {
      id,
      s: /^[0-9a-z]{1,10}$/.test(id) ? idToIso(id) : null,
      m: record.m || `${winners.length}v${losers.length}`,
      wr: LETTER_REALM[record.wr] || 0,
      lr: LETTER_REALM[record.lr] || 0,
      d: Math.round(Number(record.d) || 0),
      w: winners,
      l: losers
    };
  }

  async function migrateOldArchive() {
    if (migrating) return;
    migrating = true;
    try {
      await uploadOldArchive();
    } finally {
      migrating = false;
    }
  }

  async function uploadOldArchive() {
    try {
      localStorage.removeItem(OLD_ARCHIVE_KEY);
    } catch (error) {
      // never mind
    }

    const token = getToken();
    if (!token) return; // without a key the archive stays until one is entered

    const database = await openOldArchive();
    if (!database) return;
    const records = await readAll(database);
    database.close();

    if (records.length) {
      const totals = { inserted: 0, known: 0, rejected: 0, before_season: 0 };
      for (let i = 0; i < records.length; i += MIGRATE_BATCH) {
        migrateState = `Uploading stored fights ${fmt(Math.min(i + MIGRATE_BATCH, records.length))} of ${fmt(records.length)} ...`;
        renderCollectStatus();
        const batch = records.slice(i, i + MIGRATE_BATCH).map(archiveRecordToDb);
        let res;
        try {
          res = await sbRpc("submit_fights", { p_token: token, p_fights: batch });
        } catch (error) {
          migrateState = `Upload of stored fights stopped (${error.message}), next try on the next page load`;
          renderCollectStatus();
          return; // keep the archive, try again next time
        }
        for (const key of Object.keys(totals)) totals[key] += (res && res[key]) || 0;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      collectInfo(`Stored fights uploaded: ${fmt(totals.inserted)} new, ${fmt(totals.known)} known, ${fmt(totals.before_season)} before the season, ${fmt(totals.rejected)} rejected`);
    }

    indexedDB.deleteDatabase(DB_NAME);
    migrateState = "";
    renderCollectStatus();
  }

  // ---------------------------------------------------------------
  // The fast and long marks come from the shared database, so they keep
  // fitting even when the server meta shifts: the quickest and the slowest
  // fifth per group size over the last 21 days. Until there are enough
  // fights the measured defaults above stay in place.
  // ---------------------------------------------------------------

  const TUNE_KEY = "ewa_timers_v1";
  const TUNE_EVERY = 12 * HOUR;

  function loadTuning() {
    const stored = storageGet(TUNE_KEY);
    if (stored && stored.v && typeof stored.v === "object") durationTuned = stored.v;
  }

  async function tuneDurations() {
    const stored = storageGet(TUNE_KEY);
    if (stored && Date.now() - stored.t < TUNE_EVERY) return;
    let tuned;
    try {
      tuned = await sbRpc("duration_marks", {});
    } catch (error) {
      return;
    }
    if (!tuned || typeof tuned !== "object") return;
    const changed = JSON.stringify(tuned) !== JSON.stringify(durationTuned);
    durationTuned = tuned;
    storageSet(TUNE_KEY, { t: Date.now(), v: tuned });
    if (changed) calculate(); // redraw with the new marks
  }

  // ---------------------------------------------------------------
  // Tab "Analysis": class win rates from the database
  // ---------------------------------------------------------------

  const ANA_WINDOWS = [
    { h: 24, label: "24 h" },
    { h: 168, label: "7 days" },
    { h: 720, label: "1 month" },
    { h: 2160, label: "3 months" },
    { h: null, label: "Season" }
  ];
  const ANA_SIZES = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const ANA_REALMS = [[0, "All"], [1, "Alb"], [2, "Mid"], [3, "Hib"]];
  const ANA_MIN_FIGHTS = 20;     // greyed out below
  const ANA_PLAYER_LIMIT = 30;
  const ANA_CACHE_MS = 5 * MINUTE;
  const ANA_INFO_MS = MINUTE;
  const ANA_VS_MIN_FIGHTS = 10;  // opponent classes greyed out below
  const REALM_NAME = { 1: "Albion", 2: "Midgard", 3: "Hibernia" };

  const ana = {
    win: 1,
    size: 0,
    realm: 0,
    sel: null,          // { cls, realm }
    showAllPlayers: false,
    cache: new Map(),   // period -> { t, stats, counts }
    players: new Map(), // key -> player list
    vs: new Map(),      // key -> opponent classes
    info: null,
    infoAt: 0
  };

  function anaControlsHtml() {
    const button = (attrName, value, label, on) =>
      `<button class="ewa-ana-btn ${on ? "is-on" : ""}" ${attrName}="${value}">${label}</button>`;

    return `
      <div class="ewa-ana-ctrl">
        <span class="ewa-ana-ctrl-label">Period</span>
        <div class="ewa-loadbar">${ANA_WINDOWS.map((w, i) => button("data-ana-win", i, w.label, ana.win === i)).join("")}</div>
      </div>
      <div class="ewa-ana-ctrl">
        <span class="ewa-ana-ctrl-label">Group</span>
        <div class="ewa-loadbar">${ANA_SIZES.map(s => button("data-ana-size", s, s === 1 ? "Solo" : s ? String(s) : "All", ana.size === s)).join("")}</div>
      </div>
      <div class="ewa-ana-ctrl">
        <span class="ewa-ana-ctrl-label">Realm</span>
        <div class="ewa-loadbar">${ANA_REALMS.map(([v, l]) => button("data-ana-realm", v, l, ana.realm === v)).join("")}</div>
      </div>
    `;
  }

  function anaAggregate(rows) {
    const map = new Map();
    for (const row of rows || []) {
      if (ana.size && row.sz !== ana.size) continue;
      if (ana.realm && row.realm !== ana.realm) continue;
      const key = `${row.class}|${row.realm}`;
      if (!map.has(key)) map.set(key, { cls: row.class, realm: row.realm, wins: 0, losses: 0 });
      const entry = map.get(key);
      entry.wins += row.wins;
      entry.losses += row.losses;
    }
    return [...map.values()].map(entry => {
      const total = entry.wins + entry.losses;
      return { ...entry, total, rate: total ? entry.wins / total * 100 : 0 };
    });
  }

  // Sort state per table: cls = classes, vs = against classes, pl = players.
  // dir -1 = high to low, 1 = low to high.
  const SORT_DEFAULT = { cls: { key: "rate", dir: -1 }, vs: { key: "rate", dir: -1 }, pl: { key: "total", dir: -1 } };
  ana.sorts = JSON.parse(JSON.stringify(SORT_DEFAULT));

  function withRate(e) {
    const total = e.wins + e.losses;
    return { ...e, total, rate: total ? e.wins / total * 100 : 0 };
  }

  // Thin samples stay at the bottom when sorting by win rate, otherwise a
  // class with 2 of 2 would always top the list.
  function sortRows(rows, table, minFights) {
    const { key, dir } = ana.sorts[table];
    const value = row => (key === "name" ? String(row.label).toLowerCase() : row[key]);
    const cmp = (a, b) => {
      const va = value(a);
      const vb = value(b);
      const base = va < vb ? -1 : va > vb ? 1 : 0;
      return base * dir || b.total - a.total;
    };
    if (key !== "rate") return [...rows].sort(cmp);
    return [
      ...rows.filter(r => r.total >= minFights).sort(cmp),
      ...rows.filter(r => r.total < minFights).sort(cmp)
    ];
  }

  function sortHeadHtml(table, firstLabel) {
    const { key, dir } = ana.sorts[table];
    const col = (k, label) => {
      const on = key === k;
      return `<span class="ewa-sort ${on ? "is-on" : ""}" data-sort-t="${table}" data-sort-k="${k}" title="Sort">${label}${on ? (dir < 0 ? " ▾" : " ▴") : ""}</span>`;
    };
    return `
      <div class="ewa-ana-head">
        ${col("name", firstLabel)}${col("total", "Fights")}${col("wins", "W")}${col("losses", "L")}${col("rate", "Win rate")}
      </div>
    `;
  }

  function rowHtml(r, extraClass, attrs) {
    return `
      <div class="ewa-ana-row ${extraClass}" ${attrs}>
        <span class="ewa-ana-name">${r.mark || ""}${esc(r.label)}</span>
        <span class="ewa-ana-n">${fmt(r.total)}</span>
        <span class="ewa-ana-wl w">${fmt(r.wins)}</span>
        <span class="ewa-ana-wl l">${fmt(r.losses)}</span>
        <span class="ewa-ana-rate"><b>${fmt1(r.rate)}%</b>${rateBar(r.rate)}</span>
      </div>
    `;
  }

  function rateBar(rate) {
    const tone = rate >= 52 ? "up" : rate <= 48 ? "down" : "";
    return `<span class="ewa-ana-bar ${tone}"><span style="width:${Math.max(0, Math.min(100, rate)).toFixed(1)}%"></span></span>`;
  }

  function anaTableHtml(entries, classes) {
    if (!entries.length) {
      return `<div class="ewa-muted">No data for this selection yet. The database fills up while the script is open somewhere.</div>`;
    }
    const rows = entries.map(e => ({ ...e, label: classes[e.cls] || `Class ${e.cls}`, mark: realmMark(REALM_NAME[e.realm]) }));

    return `
      <div class="ewa-ana-grid">
        ${sortHeadHtml("cls", "Class")}
        ${sortRows(rows, "cls", ANA_MIN_FIGHTS).map(r => {
          const selected = ana.sel && ana.sel.cls === r.cls && ana.sel.realm === r.realm;
          return rowHtml(r, `${r.total < ANA_MIN_FIGHTS ? "is-thin" : ""} ${selected ? "is-sel" : ""}`,
            `data-ana-cls="${Number(r.cls)}" data-ana-crealm="${Number(r.realm)}" title="Show opponents and players of this class"`);
        }).join("")}
      </div>
      <div class="ewa-ana-note">Greyed out below ${ANA_MIN_FIGHTS} fights. Group size is the smaller side.</div>
    `;
  }

  function anaPlayersHtml(list) {
    if (!list) return `<div class="ewa-muted">Loading players ...</div>`;
    if (!list.length) return `<div class="ewa-muted">No players found.</div>`;
    const sorted = sortRows(list.map(p => ({ ...withRate(p), label: p.name })), "pl", 0);
    const rows = ana.showAllPlayers ? sorted : sorted.slice(0, ANA_PLAYER_LIMIT);

    return `
      <div class="ewa-ana-grid">
        ${sortHeadHtml("pl", "Player")}
        ${rows.map(r => rowHtml(r, "", `data-ana-player="${esc(r.label)}" title="Search ${esc(r.label)} on the Eden page"`)).join("")}
      </div>
      ${!ana.showAllPlayers && list.length > rows.length
        ? `<button class="ewa-more-btn" id="ewa-ana-more">Show all ${fmt(list.length)} players</button>`
        : ""}
    `;
  }

  const fmtDbTime = value => (value ? fmtDate(new Date(value)) : "-");

  function anaInfoHtml(meta) {
    if (!meta) return `<div class="ewa-muted">Loading ...</div>`;
    const since = meta.complete_since ? fmtDbTime(meta.complete_since) : "not started yet";
    return `
      <div class="ewa-kv">
        <span>Fights</span><b>${fmt(meta.fights)}</b>
        <span>Range</span><b>${fmtDbTime(meta.first)} to ${fmtDbTime(meta.last)}</b>
        <span>Complete since</span><b>${since}</b>
        <span>Characters</span><b>${fmt(meta.chars)}, ${fmt(meta.chars_unknown)} without class</b>
        <span>Player lists</span><b>${fmt(meta.crawl_total - meta.crawl_open)} of ${fmt(meta.crawl_total)} fetched</b>
        <span>Summary</span><b>as of ${fmtDbTime(meta.refreshed)}, newer fights counted live</b>
      </div>
      <div class="ewa-ana-note">Before "complete since" there are gaps, mostly fights between very active players, because Eden only shows the latest 300 fights per player.</div>
    `;
  }

  function collectStatusText() {
    if (!getToken()) return "";
    const s = collectState();
    const lines = [];
    const now = Date.now();

    if (!s.enabled) lines.push(s.pauseReason ? `Off: ${esc(s.pauseReason)}` : "Off");
    else if (now < s.pauseUntil) lines.push(`Paused until ${fmtDate(new Date(s.pauseUntil))}${s.pauseReason ? ` (${esc(s.pauseReason)})` : ""}`);
    else if (s.count >= COLLECT.dailyLimit) lines.push("Daily limit reached, continues tomorrow");
    else if (!ownsCollectorLock()) lines.push("Another tab is collecting");
    else lines.push(collectBusy ? "Active, working ..." : "Active");

    if (migrateState) lines.push(esc(migrateState));
    lines.push(`Background mode: ${timerMode === "worker" ? "worker timer" : "page timer"}${awakeMode.length ? `, kept awake (${awakeMode.join(", ")})` : ", not kept awake"}`);
    const limitedRecently = Date.now() - s.lastLimitAt < COLLECT.afterLimitHoldMs;
    lines.push(`Pace: one request every ${(s.pace / SECOND).toFixed(1)} s${limitedRecently ? " (Eden asked to slow down within the last hour)" : ""}`);
    lines.push(`Today ${fmt(s.count)} of ${fmt(COLLECT.dailyLimit)} requests to Eden`);
    if (s.lastList) lines.push(`Last list ${Math.max(0, Math.round((now - s.lastList) / MINUTE))} min ago`);
    lines.push(`Queue: ${jobs.fights.length} fights to read classes from, ${jobs.crawl.length} player lists`);
    if (s.lastInfo) lines.push(`Last: ${esc(s.lastInfo)}`);
    return lines.join("<br>");
  }

  function anaCollectHtml() {
    if (!getToken()) {
      return `
        <div class="ewa-ana-note">This browser gets its own key automatically within a few seconds. If you have a personal key, you can enter it here instead.</div>
        <div class="ewa-collect-row">
          <input id="ewa-token" type="password" placeholder="Enter key" autocomplete="off">
          <button id="ewa-token-save">Save</button>
        </div>
        <div id="ewa-token-msg" class="ewa-ana-note"></div>
      `;
    }
    const s = collectState();
    return `
      <div class="ewa-collect-row">
        <button id="ewa-collect-toggle">${s.enabled ? "Stop collecting" : "Start collecting"}</button>
        <button id="ewa-collect-resume" title="End the pause now">End pause</button>
      </div>
      <div id="ewa-collect-status" class="ewa-collect-lines">${collectStatusText()}</div>
    `;
  }

  // Called on every tick, so it only touches the page when the text changed.
  function renderCollectStatus() {
    const box = $("#ewa-collect-status");
    if (!box) return;
    const html = collectStatusText();
    if (box.dataset.html === html) return;
    box.dataset.html = html;
    box.innerHTML = html;
  }

  // Results are kept for ANA_CACHE_MS. A request that is still running is
  // shared, so fast clicking does not send the same query twice. When the
  // class table is reloaded, the per class lists are dropped as well, so
  // all numbers on screen come from the same moment.
  async function anaLoadWindow(force) {
    const win = ANA_WINDOWS[ana.win];
    const key = String(win.h);
    const cached = ana.cache.get(key);
    if (cached && (cached.pending || (!force && Date.now() - cached.t < ANA_CACHE_MS))) return cached.pending || cached;

    const pending = Promise.all([
      sbRpc("class_stats", { p_hours: win.h }),
      sbRpc("fight_counts", { p_hours: win.h })
    ]).then(([stats, counts]) => {
      const entry = { t: Date.now(), stats: stats || [], counts: counts || [] };
      ana.cache.set(key, entry);
      ana.players.clear();
      ana.vs.clear();
      return entry;
    }).catch(error => {
      if (cached && !cached.pending) ana.cache.set(key, cached);
      else ana.cache.delete(key);
      throw error;
    });

    ana.cache.set(key, { ...(cached || {}), pending });
    return pending;
  }

  const anaPlayersKey = () => (ana.sel ? `${ANA_WINDOWS[ana.win].h}|${ana.size}|${ana.sel.cls}|${ana.sel.realm}` : "");

  async function anaLoadPlayers() {
    const key = anaPlayersKey();
    if (!key || ana.players.has(key)) return ana.players.get(key);
    const list = await sbRpc("class_players", {
      p_hours: ANA_WINDOWS[ana.win].h,
      p_size: ana.size || null,
      p_class: ana.sel.cls,
      p_realm: ana.sel.realm
    });
    ana.players.set(key, list || []);
    return list || [];
  }

  async function anaLoadVs() {
    const key = anaPlayersKey();
    if (!key || ana.vs.has(key)) return ana.vs.get(key);
    const list = await sbRpc("class_matchups", {
      p_hours: ANA_WINDOWS[ana.win].h,
      p_size: ana.size || null,
      p_class: ana.sel.cls,
      p_realm: ana.sel.realm
    });
    ana.vs.set(key, list || []);
    return list || [];
  }

  // Win rate of the selected class against each opponent class,
  // best first. Thin samples go to the bottom.
  function anaVsHtml(list, classes) {
    if (!list) return `<div class="ewa-muted">Loading ...</div>`;
    if (!list.length) return `<div class="ewa-muted">No opponent classes found.</div>`;

    const rows = list.map(e => ({
      ...withRate(e),
      label: classes[e.oclass] || `Class ${e.oclass}`,
      mark: realmMark(REALM_NAME[e.orealm])
    }));

    return `
      <div class="ewa-ana-grid">
        ${sortHeadHtml("vs", "Against")}
        ${sortRows(rows, "vs", ANA_VS_MIN_FIGHTS).map(r => rowHtml(r, `is-static ${r.total < ANA_VS_MIN_FIGHTS ? "is-thin" : ""}`, "")).join("")}
      </div>
      <div class="ewa-ana-note">Greyed out below ${ANA_VS_MIN_FIGHTS} fights. In group fights the class was in the enemy group, not necessarily the direct opponent.</div>
    `;
  }

  let anaRenderId = 0;

  async function renderAnalysis(force) {
    const box = $("#ewa-ana");
    if (!box) return;
    const renderId = ++anaRenderId;

    $("#ewa-ana-ctrls").innerHTML = anaControlsHtml();
    const out = $("#ewa-ana-out");
    if (!out.innerHTML.trim()) out.innerHTML = `<div class="ewa-muted">Loading ...</div>`;

    let data;
    let stat;
    try {
      [data, stat] = await Promise.all([anaLoadWindow(force), loadStatic()]);
    } catch (error) {
      if (renderId === anaRenderId) out.innerHTML = `<div class="ewa-warn">Analysis not loaded: ${esc(error.message)}</div>`;
      renderAnaSide(); // the loading status does not depend on the analysis
      return;
    }
    if (renderId !== anaRenderId) return;

    const entries = anaAggregate(data.stats);
    const fights = (data.counts || [])
      .filter(c => !ana.size || c.sz === ana.size)
      .reduce((sum, c) => sum + c.n, 0);
    const win = ANA_WINDOWS[ana.win];
    const selName = ana.sel ? (stat.classes[ana.sel.cls] || `Class ${ana.sel.cls}`) : "";
    const key = anaPlayersKey();

    out.innerHTML = `
      <div class="ewa-sum">
        <div class="ewa-sum-title">Classes · ${win.label}</div>
        <div class="ewa-sum-top">
          <div class="ewa-sum-rate"><strong>${fmt(fights)}</strong><span>Fights, ${ana.size === 1 ? "solo" : ana.size ? `${ana.size}v${ana.size}` : "all sizes"}</span></div>
          <div class="ewa-sum-kv"><strong>${fmt(entries.length)}</strong><span>Classes</span></div>
        </div>
      </div>
      <div class="ewa-section-title" data-sec="classes">Win rate by class</div>
      ${anaTableHtml(entries, stat.classes)}
      ${ana.sel ? `
      <div class="ewa-section-title" data-sec="vs">${esc(selName)} against classes ${realmMark(REALM_NAME[ana.sel.realm])}</div>
      <div id="ewa-ana-vs">${anaVsHtml(ana.vs.get(key), stat.classes)}</div>
      <div class="ewa-section-title" data-sec="players">Players · ${esc(selName)} ${realmMark(REALM_NAME[ana.sel.realm])}</div>
      <div id="ewa-ana-players">${anaPlayersHtml(ana.players.get(key))}</div>
      ` : ""}
    `;

    if (ana.scrollToSel) {
      ana.scrollToSel = false;
      const vsBox = $("#ewa-ana-vs");
      if (vsBox && vsBox.previousElementSibling) vsBox.previousElementSibling.scrollIntoView({ block: "start", behavior: "smooth" });
    }

    if (ana.sel && !ana.vs.has(key)) {
      anaLoadVs().then(() => {
        if (renderId !== anaRenderId) return;
        const holder = $("#ewa-ana-vs");
        if (holder) holder.innerHTML = anaVsHtml(ana.vs.get(key), stat.classes);
      }).catch(error => {
        if (renderId !== anaRenderId) return;
        const holder = $("#ewa-ana-vs");
        if (holder) holder.innerHTML = `<div class="ewa-warn">Opponent classes not loaded: ${esc(error.message)}</div>`;
      });
    }

    if (ana.sel && !ana.players.has(key)) {
      try {
        await anaLoadPlayers();
        if (renderId !== anaRenderId) return;
        const holder = $("#ewa-ana-players");
        if (holder) holder.innerHTML = anaPlayersHtml(ana.players.get(key));
      } catch (error) {
        const holder = $("#ewa-ana-players");
        if (holder) holder.innerHTML = `<div class="ewa-warn">Players not loaded: ${esc(error.message)}</div>`;
      }
    }

    renderAnaSide();
  }

  // Loading status sits in one section at the end, closed by default.
  // Once every player list has been fetched only the regular top-up is
  // left, then the section disappears.
  const backfillDone = meta => !!meta && meta.crawl_total > 0 && meta.crawl_open === 0;

  function drawAnaSide() {
    const side = $("#ewa-ana-side");
    if (!side) return;
    if (!ana.info || backfillDone(ana.info)) {
      side.innerHTML = "";
      return;
    }
    const open = ana.info.crawl_total ? Math.round((ana.info.crawl_total - ana.info.crawl_open) / ana.info.crawl_total * 100) : 0;
    side.innerHTML = `
      <div class="ewa-section-title" data-sec="status" data-closed="1">Loading status <em>${open}% of player lists</em></div>
      <div>${anaCollectHtml()}</div>
      <div id="ewa-ana-info">${anaInfoHtml(ana.info)}</div>
    `;
  }

  async function renderAnaSide(forceInfo) {
    drawAnaSide();
    if (forceInfo || !ana.info || Date.now() - ana.infoAt > ANA_INFO_MS) {
      try {
        ana.info = await sbRpc("db_info", {});
        ana.infoAt = Date.now();
      } catch (error) {
        return;
      }
      drawAnaSide();
    }
  }

  async function saveToken() {
    const input = $("#ewa-token");
    const msg = $("#ewa-token-msg");
    const value = input ? input.value.trim() : "";
    if (!value) return;
    if (msg) msg.textContent = "Checking key ...";
    try {
      const label = await sbRpc("check_token", { p_token: value });
      setToken(value);
      collectSave({ enabled: true, pauseUntil: 0, pauseReason: "", backoff: 0 });
      collectInfo(`Signed in as ${label}`);
      renderAnaSide();
      migrateOldArchive();
    } catch (error) {
      if (msg) msg.textContent = "Key not valid.";
    }
  }

  // ---------------------------------------------------------------
  // Tabs on the fight list
  // ---------------------------------------------------------------

  const TAB_KEY = "ewa-tab";
  let currentTab = storageGet(TAB_KEY) === "ana" ? "ana" : "fights";

  function showTab(tab) {
    currentTab = tab;
    storageSet(TAB_KEY, tab);
    document.querySelectorAll("#ewa-panel .ewa-tab").forEach(button => {
      button.classList.toggle("is-on", button.dataset.tab === tab);
    });
    const fights = $("#ewa-tab-fights");
    const anaBox = $("#ewa-ana");
    if (fights) fights.hidden = tab !== "fights";
    if (anaBox) anaBox.hidden = tab !== "ana";
    if (tab === "ana") renderAnalysis();
  }

  // Clicks inside the analysis tab. Returns true when handled.
  function handleAnalysisClick(event) {
    const t = event.target;
    const hit = selector => t.closest(selector);

    const tab = hit(".ewa-tab");
    if (tab) { showTab(tab.dataset.tab); return true; }

    const win = hit("[data-ana-win]");
    if (win) { ana.win = Number(win.dataset.anaWin); ana.showAllPlayers = false; renderAnalysis(); return true; }

    const size = hit("[data-ana-size]");
    if (size) { ana.size = Number(size.dataset.anaSize); ana.showAllPlayers = false; renderAnalysis(); return true; }

    const realm = hit("[data-ana-realm]");
    if (realm) {
      ana.realm = Number(realm.dataset.anaRealm);
      if (ana.sel && ana.realm && ana.sel.realm !== ana.realm) ana.sel = null;
      renderAnalysis();
      return true;
    }

    const sort = hit("[data-sort-t]");
    if (sort) {
      const state = ana.sorts[sort.dataset.sortT];
      const key = sort.dataset.sortK;
      if (state.key === key) state.dir = -state.dir;
      else {
        state.key = key;
        state.dir = key === "name" ? 1 : -1;
      }
      renderAnalysis();
      return true;
    }

    const player = hit("[data-ana-player]");
    if (player) {
      showTab("fights");
      searchPlayer(player.dataset.anaPlayer);
      return true;
    }

    const cls = hit("[data-ana-cls]");
    if (cls) {
      const pick = { cls: Number(cls.dataset.anaCls), realm: Number(cls.dataset.anaCrealm) };
      const same = ana.sel && ana.sel.cls === pick.cls && ana.sel.realm === pick.realm;
      ana.sel = same ? null : pick;
      ana.scrollToSel = !same;
      ana.showAllPlayers = false;
      renderAnalysis();
      return true;
    }

    if (hit("#ewa-ana-more")) { ana.showAllPlayers = true; renderAnalysis(); return true; }
    if (hit("#ewa-token-save")) { saveToken(); return true; }
    if (hit("#ewa-collect-toggle")) {
      collectSave({ enabled: !collectState().enabled, pauseReason: "" });
      renderAnaSide();
      return true;
    }
    if (hit("#ewa-collect-resume")) {
      collectSave({ pauseUntil: 0, pauseReason: "", backoff: 0 });
      renderCollectStatus();
      return true;
    }
    return false;
  }

  const ANALYSIS_CSS = `
      #ewa-panel [hidden] { display: none !important; }
      #ewa-panel input[type="password"] {
        width: 100%; background: #1e2126; color: var(--text); border: 1px solid var(--edge);
        border-radius: 3px; padding: 8px 10px; font: 400 13px/1.3 "Segoe UI", Arial, sans-serif !important;
      }
      #ewa-panel input[type="password"]:focus { outline: none; border-color: var(--bronze); }

      /* Collapsible sections */
      .ewa-sec-head { cursor: pointer; user-select: none; }
      .ewa-sec-head:hover { color: var(--parch); }
      .ewa-caret {
        width: 0; height: 0; flex: none; margin-right: -3px;
        border-left: 4px solid transparent; border-right: 4px solid transparent; border-top: 5px solid currentColor;
        transition: transform .15s;
      }
      .ewa-sec-head.is-closed .ewa-caret { transform: rotate(-90deg); }
      #ewa-panel .ewa-sec-hidden { display: none !important; }

      /* Tabs */
      .ewa-tabs { display: flex; gap: 2px; margin: -4px 0 12px; border-bottom: 1px solid var(--edge); }
      #ewa-panel button.ewa-tab {
        background: transparent; border: 0; border-bottom: 2px solid transparent; border-radius: 0;
        color: var(--muted); padding: 8px 14px 7px; margin-bottom: -1px;
      }
      #ewa-panel button.ewa-tab:hover { color: var(--text); background: transparent; }
      #ewa-panel button.ewa-tab.is-on { color: var(--text); border-bottom-color: var(--bronze); }

      /* Analysis */
      .ewa-ana-ctrl { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
      .ewa-ana-ctrl-label { width: 54px; flex: none; font-size: 10px; font-weight: 600; letter-spacing: .7px; color: var(--bronze); }
      #ewa-panel button.ewa-ana-btn { background: #1e2126; color: var(--muted); padding: 5px 10px; font-size: 11px !important; }
      #ewa-panel button.ewa-ana-btn:hover { color: var(--parch); }
      #ewa-panel button.ewa-ana-btn.is-on { color: var(--ink); background: var(--bronze); border-color: var(--parch-2); font-weight: 700; }
      .ewa-ana-grid { display: grid; }
      .ewa-ana-head, .ewa-ana-row {
        display: grid; grid-template-columns: minmax(0, 1fr) 58px 46px 46px 160px; gap: 10px; align-items: center;
        padding: 5px 8px; font-size: 12px;
      }
      .ewa-ana-head { font-size: 10px; font-weight: 600; letter-spacing: .7px; color: var(--muted); border-bottom: 1px solid var(--edge); }
      .ewa-ana-head > span:nth-child(2), .ewa-ana-head > span:nth-child(3), .ewa-ana-head > span:nth-child(4) { text-align: right; }
      .ewa-sort { white-space: nowrap; }
      .ewa-sort { cursor: pointer; }
      .ewa-sort:hover, .ewa-sort.is-on { color: var(--text); }
      .ewa-ana-row { border-bottom: 1px solid #3a4048; cursor: pointer; border-radius: 3px; }
      .ewa-ana-row:hover { background: var(--stone-3); }
      .ewa-ana-row.is-sel { background: var(--stone-3); box-shadow: inset 3px 0 0 var(--bronze); }
      .ewa-ana-row.is-thin { opacity: .45; }
      .ewa-ana-row.is-static { cursor: default; }
      .ewa-ana-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ewa-ana-n { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
      .ewa-ana-wl { text-align: right; font-size: 11px; color: var(--muted); font-variant-numeric: tabular-nums; }
      .ewa-ana-wl em { font-style: normal; }
      .ewa-ana-wl.w, .ewa-ana-wl .w { color: var(--win); }
      .ewa-ana-wl.l, .ewa-ana-wl .l { color: var(--loss); }
      .ewa-ana-rate { display: flex; align-items: center; gap: 8px; }
      .ewa-ana-rate b { width: 48px; flex: none; text-align: right; font-variant-numeric: tabular-nums; }
      .ewa-ana-bar { position: relative; flex: 1; height: 6px; border-radius: 99px; background: #1e2126; overflow: hidden; }
      .ewa-ana-bar > span { display: block; height: 100%; background: var(--bronze); }
      .ewa-ana-bar.up > span { background: var(--win); }
      .ewa-ana-bar.down > span { background: var(--loss); }
      .ewa-ana-bar::after { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: var(--stone); }
      .ewa-ana-note { margin-top: 7px; font-size: 11px; color: var(--faint); line-height: 1.45; }
      .ewa-collect-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
      .ewa-collect-row input { flex: 1; min-width: 180px; }
      .ewa-collect-lines { margin-top: 8px; font-size: 11.5px; color: var(--muted); line-height: 1.6; }
      .ewa-kv { display: grid; grid-template-columns: 130px 1fr; gap: 3px 10px; font-size: 11.5px; }
      .ewa-kv span { color: var(--faint); }
      .ewa-kv b { font-weight: 400; color: var(--text); }
  `;

  // ---------------------------------------------------------------
  // UI (shared by both modes)
  // ---------------------------------------------------------------

  function setStatus(text) {
    const element = $("#ewa-status");
    if (element) element.textContent = text;
  }

  function calculate() {
    if (isDetailPage()) {
      calculateRa();
    } else {
      calculateWinrate();
    }
  }

  function createUi() {
    if ($("#ewa-panel")) return;

    const detail = isDetailPage();
    if (!detail && !findFightTable()) return; // neither fight list nor detail page

    const title = detail ? "Fight Report" : "Fight Analyzer";
    const buttonLabel = detail ? "Refresh" : "Search";
    const subLabel = detail
      ? "Fight detail page."
      : "Reading the fight list ...";

    const panel = document.createElement("div");
    panel.id = "ewa-panel";
    if (detail) panel.classList.add("is-detail"); // two columns with many numbers

    panel.innerHTML = `
      <div class="ewa-head">
        <div class="ewa-brand">
          <div class="ewa-title">${title}<span class="ewa-by">${markHtml("")}by Vumas</span></div>
          <div id="ewa-cache" class="ewa-muted">${subLabel}</div>
        </div>
        <button id="ewa-collapse" title="Collapse">−</button>
      </div>
      <div class="ewa-top-wrap">
        <button id="ewa-top" title="Back to top" hidden>↑ Top</button>
      </div>

      <div id="ewa-body">
        ${detail ? "" : `
        <div class="ewa-tabs">
          <button class="ewa-tab" data-tab="fights">Fights</button>
          <button class="ewa-tab" data-tab="ana">Analysis</button>
        </div>
        `}
        <div id="ewa-tab-fights">
        ${detail ? "" : `
        <div class="ewa-row ewa-names">
          <label class="ewa-field">
            <span>Player</span>
            <input id="ewa-player" type="text" placeholder="Name, then Enter">
          </label>
          <label class="ewa-field">
            <span>Head-to-head vs</span>
            <input id="ewa-h2h" type="text" placeholder="Opponent (optional)">
          </label>
        </div>
        `}
        <div class="ewa-row ewa-buttons">
          <button id="ewa-analyze">${buttonLabel}</button>
          ${detail ? "" : `<button id="ewa-reset" title="Clear the name, all group sizes, full period">Reset</button>`}
        </div>
        ${detail ? "" : `<div class="ewa-row" id="ewa-matchups"></div>`}
        ${detail ? "" : `
        <div class="ewa-row ewa-time">
          <span class="ewa-time-label">Period</span>
          <div class="ewa-time-main">
            <input id="ewa-hours" type="range" min="0" max="${HOUR_STEPS.length - 1}" step="1" value="${hourIndex}" title="Period">
            <div class="ewa-ticks" id="ewa-ticks"></div>
          </div>
          <span id="ewa-hours-label"></span>
        </div>
        `}

        <div id="ewa-status"></div>
        <div id="ewa-output"></div>
        </div>
        ${detail ? "" : `
        <div id="ewa-ana" hidden>
          <div id="ewa-ana-ctrls"></div>
          <div id="ewa-ana-out"></div>
          <div id="ewa-ana-side"></div>
        </div>
        `}
        <div class="ewa-foot">${markHtml("is-foot")}Eden Fight Analyzer · by Vumas · v${VERSION}</div>
      </div>
    `;

    const style = document.createElement("style");

    style.textContent = `
      /* Eden Fight Analyzer - by Vumas - grey theme */
      #ewa-panel {
        --stone: #24272c;
        --stone-2: #2e3238;
        --stone-3: #383d44;
        --edge: #474d55;
        --parch: #e4e7ea;
        --parch-2: #ced3d9;
        --ink: #22252a;
        --bronze: #b6c0ca;
        --text: #edf0f3;
        --muted: #a7afb8;
        --faint: #7e868f;
        --win: #77c97e;
        --loss: #e0706a;
        --fast: #6fc2d8;
        --slow: #dcb265;

        position: fixed;
        top: 78px;
        right: 18px;
        z-index: 2147483647;
        width: 620px;
        max-width: calc(100vw - 36px);
        max-height: calc(100vh - 96px);
        overflow: hidden;

        background-color: var(--stone);

        color: var(--text);
        border: 1px solid var(--edge);
        border-radius: 4px;
        box-shadow: 0 18px 50px rgba(0, 0, 0, .55);
        font: 13px/1.5 "Segoe UI", Arial, sans-serif;
      }

      #ewa-panel.is-detail { width: 880px; }
      .ewa-top-wrap { position: absolute; right: 22px; bottom: 16px; z-index: 2; }
      #ewa-panel.is-collapsed .ewa-top-wrap { display: none; }
      #ewa-panel button#ewa-top {
        padding: 6px 11px; border-radius: 99px; background: var(--bronze); color: var(--ink);
        border-color: var(--parch-2); box-shadow: 0 4px 14px rgba(0, 0, 0, .45);
      }
      #ewa-panel button#ewa-top:hover { background: var(--parch); }
      #ewa-panel * { box-sizing: border-box; }

      #ewa-panel button {
        border: 1px solid var(--edge);
        border-radius: 3px;
        padding: 7px 11px;
        background: var(--stone-3);
        color: var(--text);
        cursor: pointer;
        font: 600 12px/1 "Segoe UI", Arial, sans-serif !important;
        letter-spacing: .2px;
        text-transform: none !important;
      }
      #ewa-panel button:hover { background: #414750; border-color: var(--bronze); }
      #ewa-panel button:disabled { opacity: .45; cursor: default; }

      #ewa-panel input[type="text"] {
        width: 100%;
        background: #1e2126;
        color: var(--text);
        border: 1px solid var(--edge);
        border-radius: 3px;
        padding: 8px 10px;
        font: 400 13px/1.3 "Segoe UI", Arial, sans-serif !important;
        letter-spacing: normal !important;
        text-transform: none !important;
      }
      #ewa-panel input[type="text"]:focus { outline: none; border-color: var(--bronze); }
      #ewa-panel input[type="text"]::placeholder {
        color: var(--faint);
        font: 400 13px/1.3 "Segoe UI", Arial, sans-serif !important;
        letter-spacing: normal !important;
        text-transform: none !important;
      }

      /* Header */
      .ewa-head {
        position: relative;
        display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;
        padding: 10px 14px 9px;
        background: linear-gradient(180deg, var(--parch), var(--parch-2));
        border-bottom: 1px solid #a9b2bb;
        color: var(--ink);
      }

      /* Albion, Midgard, Hibernia as one quiet line */
      .ewa-head::after {
        content: "";
        position: absolute; left: 0; right: 0; bottom: -2px; height: 2px;
        background: linear-gradient(90deg,
          rgba(166, 72, 66, .8) 0%,
          rgba(166, 72, 66, .8) 18%,
          rgba(74, 106, 166, .8) 50%,
          rgba(82, 150, 106, .8) 82%,
          rgba(82, 150, 106, .8) 100%);
      }
      .ewa-title { font: 400 20px/1.1 Cinzel, Georgia, "Times New Roman", serif; letter-spacing: .3px; color: var(--ink); }
      .ewa-by {
        display: inline-flex; align-items: center; gap: 5px;
        font: 600 10px/1 "Segoe UI", Arial, sans-serif;
        letter-spacing: 1.4px; color: #5a616a; margin-left: 9px; vertical-align: 2px;
      }
      .ewa-head #ewa-cache { color: #5c636c; }
      #ewa-collapse {
        width: 26px; height: 26px; padding: 0; font-size: 15px; flex: none;
        background: rgba(42, 33, 24, .08) !important; color: var(--ink) !important; border-color: rgba(42, 33, 24, .3) !important;
      }
      #ewa-collapse:hover { background: rgba(42, 33, 24, .18) !important; }
      .ewa-mark { display: inline-flex; width: 12px; height: 12px; }
      .ewa-mark img, img.ewa-mark { width: 100%; height: 100%; border-radius: 2px; object-fit: contain; }

      /* The scene behind the panel: night sky, a dragon, a keep and two
         warbands. Drawn by hand as one SVG, so nothing is loaded and no
         game artwork is used. "local" makes it scroll along with the list. */
      #ewa-body {
        padding: 12px 14px 10px;
        overflow-y: auto; overflow-x: hidden;
        max-height: calc(100vh - 152px);
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='620' height='740' viewBox='0 0 620 740'%3E %3Cdefs%3E %3CradialGradient id='halo'%3E%3Cstop offset='0' stop-color='%23fff' stop-opacity='.045'/%3E%3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E%3C/radialGradient%3E %3ClinearGradient id='sky' x1='0' y1='0' x2='0' y2='1'%3E %3Cstop offset='0' stop-color='%23fff' stop-opacity='.022'/%3E %3Cstop offset='.62' stop-color='%23fff' stop-opacity='.008'/%3E %3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E %3C/linearGradient%3E %3ClinearGradient id='dusk' x1='0' y1='0' x2='0' y2='1'%3E %3Cstop offset='0' stop-color='%23fff' stop-opacity='.042'/%3E %3Cstop offset='1' stop-color='%23fff' stop-opacity='0'/%3E %3C/linearGradient%3E %3C/defs%3E %3Cg opacity='0.275'%3E %3Crect width='620' height='740' fill='url(%23sky)'/%3E %3Ccircle cx='506' cy='96' r='38' fill='%23fff' opacity='.05'/%3E %3Ccircle cx='506' cy='96' r='76' fill='url(%23halo)'/%3E %3Cg fill='%23fff' opacity='.03'%3E %3Ccircle cx='92' cy='58' r='1.5'/%3E%3Ccircle cx='168' cy='118' r='1.1'/%3E%3Ccircle cx='286' cy='48' r='1.4'/%3E %3Ccircle cx='366' cy='96' r='1'/%3E%3Ccircle cx='424' cy='40' r='1.3'/%3E%3Ccircle cx='592' cy='186' r='1.1'/%3E %3Ccircle cx='56' cy='176' r='1.2'/%3E%3Ccircle cx='318' cy='156' r='.9'/%3E%3Ccircle cx='462' cy='212' r='1'/%3E %3C/g%3E %3Cg fill='%23fff' opacity='.05' transform='translate(238,196) scale(.92) rotate(-6)'%3E %3Cpath d='M0,-52 C-6,-52 -8,-46 -6,-40 L-6,-30 C-14,-26 -16,-16 -14,-4 L-12,22 C-10,34 -4,40 0,40 C4,40 10,34 12,22 L14,-4 C16,-16 14,-26 6,-30 L6,-40 C8,-46 6,-52 0,-52 Z'/%3E %3Cpath d='M-4,-50 L-10,-62 L-2,-55 Z'/%3E%3Cpath d='M4,-50 L10,-62 L2,-55 Z'/%3E %3Cpath d='M0,36 C2,52 4,70 0,86 C-2,96 -8,100 -10,96 C-6,86 -4,66 -4,40 Z'/%3E %3Cpath d='M-12,-26 C-44,-40 -84,-42 -118,-30 C-128,-26 -128,-20 -118,-18 C-96,-18 -80,-14 -68,-6 L-74,-16 C-56,-10 -42,0 -34,12 L-38,-4 C-26,4 -18,14 -14,24 Z'/%3E %3Cpath d='M12,-26 C44,-40 84,-42 118,-30 C128,-26 128,-20 118,-18 C96,-18 80,-14 68,-6 L74,-16 C56,-10 42,0 34,12 L38,-4 C26,4 18,14 14,24 Z'/%3E %3C/g%3E %3Cpath d='M0,740 L0,392 L0,392 L58,344 L110,368 L170,300 L216,340 L270,308 L322,352 L376,314 L434,358 L496,322 L550,360 L600,330 L620,348 L620,740 Z' fill='%23fff' opacity='.026'/%3E %3Cpath d='M0,740 L0,470 L0,470 L72,442 L146,468 L216,430 L290,458 L358,428 L430,462 L508,436 L566,464 L620,444 L620,740 Z' fill='%23fff' opacity='.032'/%3E %3Cpath d='M196,648 C240,520 300,500 368,500 C436,500 494,520 530,648 Z' fill='%23fff' opacity='.034'/%3E %3Cg fill='%23fff' opacity='.058'%3E %3Cpath d='M304,512 L304,486 L428,486 L428,512 Z'/%3E %3Cpath d='M310,486 L310,479 L320,479 L320,486 Z'/%3E%3Cpath d='M328,486 L328,479 L338,479 L338,486 Z'/%3E%3Cpath d='M346,486 L346,479 L356,479 L356,486 Z'/%3E%3Cpath d='M364,486 L364,479 L374,479 L374,486 Z'/%3E%3Cpath d='M382,486 L382,479 L392,479 L392,486 Z'/%3E%3Cpath d='M400,486 L400,479 L410,479 L410,486 Z'/%3E%3Cpath d='M418,486 L418,479 L428,479 L428,486 Z'/%3E %3Cpath d='M298,512 L298,450 L326,450 L326,512 Z'/%3E%3Cpath d='M298.0,450 L298.0,445 L302.0,445 L302.0,450 Z'/%3E%3Cpath d='M306.0,450 L306.0,445 L310.0,445 L310.0,450 Z'/%3E%3Cpath d='M314.0,450 L314.0,445 L318.0,445 L318.0,450 Z'/%3E%3Cpath d='M322.0,450 L322.0,445 L326.0,445 L326.0,450 Z'/%3E %3Cpath d='M406,512 L406,450 L434,450 L434,512 Z'/%3E%3Cpath d='M406.0,450 L406.0,445 L410.0,445 L410.0,450 Z'/%3E%3Cpath d='M414.0,450 L414.0,445 L418.0,445 L418.0,450 Z'/%3E%3Cpath d='M422.0,450 L422.0,445 L426.0,445 L426.0,450 Z'/%3E%3Cpath d='M430.0,450 L430.0,445 L434.0,445 L434.0,450 Z'/%3E %3Cpath d='M346,512 L346,414 L386,414 L386,512 Z'/%3E%3Cpath d='M341,414 L366,388 L391,414 Z'/%3E %3Cpath d='M358,414 L358,388 L374,388 L374,414 Z' opacity='.4'/%3E %3Cpath d='M357,486 L357,468 C357,458 375,458 375,468 L375,486 Z' opacity='.45'/%3E %3Crect x='365' y='344' width='2.2' height='42'/%3E %3Cpath d='M367,346 L402,355 L367,364 Z'/%3E %3C/g%3E %3Cg fill='%23fff' opacity='0.04'%3E%3Crect x='-13.6' y='636.4' width='3.2' height='15.6'/%3E%3Cpath d='M-12,602.1 L11.9,636.4 L-35.9,636.4 Z'/%3E%3Cpath d='M-12,575.0 L7.5,609.4 L-31.5,609.4 Z'/%3E%3Cpath d='M-12,548.0 L3.1,582.3 L-27.1,582.3 Z'/%3E%3Cpath d='M-12,521.0 L-1.2,555.3 L-22.8,555.3 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='0.046'%3E%3Crect x='18.4' y='632.2' width='3.2' height='19.8'/%3E%3Cpath d='M20,588.6 L50.4,632.2 L-10.4,632.2 Z'/%3E%3Cpath d='M20,554.3 L44.8,597.9 L-4.8,597.9 Z'/%3E%3Cpath d='M20,520.0 L39.2,563.6 L0.8,563.6 Z'/%3E%3Cpath d='M20,485.7 L33.7,529.2 L6.3,529.2 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='0.04'%3E%3Crect x='52.4' y='636.7' width='3.2' height='15.3'/%3E%3Cpath d='M54,603.0 L77.5,636.7 L30.5,636.7 Z'/%3E%3Cpath d='M54,576.5 L73.2,610.2 L34.8,610.2 Z'/%3E%3Cpath d='M54,550.0 L68.9,583.7 L39.1,583.7 Z'/%3E%3Cpath d='M54,523.5 L64.6,557.1 L43.4,557.1 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='0.034'%3E%3Crect x='84.4' y='639.4' width='3.2' height='12.6'/%3E%3Cpath d='M86,611.7 L105.3,639.4 L66.7,639.4 Z'/%3E%3Cpath d='M86,589.8 L101.8,617.6 L70.2,617.6 Z'/%3E%3Cpath d='M86,568.0 L98.2,595.7 L73.8,595.7 Z'/%3E%3Cpath d='M86,546.2 L94.7,573.9 L77.3,573.9 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='0.03'%3E%3Crect x='290.4' y='640.3' width='3.2' height='11.7'/%3E%3Cpath d='M292,614.6 L309.9,640.3 L274.1,640.3 Z'/%3E%3Cpath d='M292,594.3 L306.7,620.0 L277.3,620.0 Z'/%3E%3Cpath d='M292,574.0 L303.4,599.7 L280.6,599.7 Z'/%3E%3Cpath d='M292,553.7 L300.1,579.5 L283.9,579.5 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='0.034'%3E%3Crect x='328.4' y='637.6' width='3.2' height='14.4'/%3E%3Cpath d='M330,605.9 L352.1,637.6 L307.9,637.6 Z'/%3E%3Cpath d='M330,581.0 L348.0,612.6 L312.0,612.6 Z'/%3E%3Cpath d='M330,556.0 L344.0,587.7 L316.0,587.7 Z'/%3E%3Cpath d='M330,531.0 L339.9,562.7 L320.1,562.7 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='0.034'%3E%3Crect x='510.4' y='639.1' width='3.2' height='12.9'/%3E%3Cpath d='M512,610.7 L531.8,639.1 L492.2,639.1 Z'/%3E%3Cpath d='M512,588.4 L528.2,616.7 L495.8,616.7 Z'/%3E%3Cpath d='M512,566.0 L524.5,594.4 L499.5,594.4 Z'/%3E%3Cpath d='M512,543.6 L520.9,572.0 L503.1,572.0 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='0.044'%3E%3Crect x='546.4' y='634.3' width='3.2' height='17.7'/%3E%3Cpath d='M548,595.4 L575.1,634.3 L520.9,634.3 Z'/%3E%3Cpath d='M548,564.7 L570.2,603.6 L525.8,603.6 Z'/%3E%3Cpath d='M548,534.0 L565.2,572.9 L530.8,572.9 Z'/%3E%3Cpath d='M548,503.3 L560.2,542.3 L535.8,542.3 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='0.04'%3E%3Crect x='586.4' y='637.6' width='3.2' height='14.4'/%3E%3Cpath d='M588,605.9 L610.1,637.6 L565.9,637.6 Z'/%3E%3Cpath d='M588,581.0 L606.0,612.6 L570.0,612.6 Z'/%3E%3Cpath d='M588,556.0 L602.0,587.7 L574.0,587.7 Z'/%3E%3Cpath d='M588,531.0 L597.9,562.7 L578.1,562.7 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='0.042'%3E%3Crect x='620.4' y='634.0' width='3.2' height='18.0'/%3E%3Cpath d='M622,594.4 L649.6,634.0 L594.4,634.0 Z'/%3E%3Cpath d='M622,563.2 L644.5,602.8 L599.5,602.8 Z'/%3E%3Cpath d='M622,532.0 L639.5,571.6 L604.5,571.6 Z'/%3E%3Cpath d='M622,500.8 L634.4,540.4 L609.6,540.4 Z'/%3E%3C/g%3E %3Cpath d='M0,648 C130,642 250,652 376,643 C476,638 554,650 620,645 L620,740 L0,740 Z' fill='url(%23dusk)'/%3E %3Cg fill='%23fff' opacity='.082' transform='translate(62,648) scale(1.25,1.25)'%3E%3Cpath d='M-5,0 L-4,-12 L-3,-22 L2,-22 L1,-12 L2,0 Z'/%3E %3Cpath d='M-6,-21 L-5,-33 L6,-33 L7,-21 Z'/%3E%3Cpath d='M-5,-33 L-5,-40 L6,-40 L6,-33 Z'/%3E %3Ccircle cx='0.5' cy='-45' r='4.6'/%3E%3Cpath d='M-8,-38 C-14,-36 -17,-30 -17,-24 L-17,-14 C-17,-8 -13,-4 -10,-2 C-7,-4 -3,-8 -3,-14 L-3,-24 C-3,-30 -4,-36 -8,-38 Z'/%3E %3Cpath d='M8,-36 L13,-52 L15,-51 L10,-34 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='.082' transform='translate(104,648) scale(1.2,1.2)'%3E%3Cpath d='M-5,0 L-4,-12 L-3,-22 L2,-22 L1,-12 L2,0 Z'/%3E %3Cpath d='M-6,-21 L-5,-33 L6,-33 L7,-21 Z'/%3E%3Cpath d='M-5,-33 L-5,-40 L6,-40 L6,-33 Z'/%3E %3Ccircle cx='0.5' cy='-45' r='4.6'/%3E%3Cpath d='M-4,-49 L0,-54 L5,-49 Z'/%3E %3Cpath d='M9,-62 L10.6,-62 L10.6,-6 L9,-6 Z'/%3E%3Cpath d='M8,-62 L9.8,-72 L11.6,-62 Z'/%3E %3Cpath d='M5,-36 L10,-38 L10,-33 L5,-31 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='.082' transform='translate(150,648) scale(1.3,1.3)'%3E%3Cpath d='M-5,0 L-4,-12 L-3,-22 L2,-22 L1,-12 L2,0 Z'/%3E %3Cpath d='M-6,-21 L-5,-33 L6,-33 L7,-21 Z'/%3E%3Cpath d='M-5,-33 L-5,-40 L6,-40 L6,-33 Z'/%3E %3Ccircle cx='0.5' cy='-45' r='4.6'/%3E%3Cpath d='M7,-74 L8.6,-74 L8.6,-4 L7,-4 Z'/%3E%3Cpath d='M8.6,-74 L30,-68 L8.6,-58 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='.082' transform='translate(196,648) scale(-1.15,1.15)'%3E%3Cpath d='M-5,0 L-4,-12 L-3,-22 L2,-22 L1,-12 L2,0 Z'/%3E %3Cpath d='M-6,-21 L-5,-33 L6,-33 L7,-21 Z'/%3E%3Cpath d='M-5,-33 L-5,-40 L6,-40 L6,-33 Z'/%3E %3Ccircle cx='0.5' cy='-45' r='4.6'/%3E%3Cpath d='M-4,-49 L0,-54 L5,-49 Z'/%3E %3Cpath d='M9,-62 L10.6,-62 L10.6,-6 L9,-6 Z'/%3E%3Cpath d='M8,-62 L9.8,-72 L11.6,-62 Z'/%3E %3Cpath d='M5,-36 L10,-38 L10,-33 L5,-31 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='.082' transform='translate(244,648) scale(1.1,1.1)'%3E%3Cpath d='M-5,0 L-4,-12 L-3,-22 L2,-22 L1,-12 L2,0 Z'/%3E %3Cpath d='M-6,-21 L-5,-33 L6,-33 L7,-21 Z'/%3E%3Cpath d='M-5,-33 L-5,-40 L6,-40 L6,-33 Z'/%3E %3Ccircle cx='0.5' cy='-45' r='4.6'/%3E%3Cpath d='M-8,-38 C-14,-36 -17,-30 -17,-24 L-17,-14 C-17,-8 -13,-4 -10,-2 C-7,-4 -3,-8 -3,-14 L-3,-24 C-3,-30 -4,-36 -8,-38 Z'/%3E %3Cpath d='M8,-36 L13,-52 L15,-51 L10,-34 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='.082' transform='translate(392,648) scale(-1.1,1.1)'%3E%3Cpath d='M-5,0 L-4,-12 L-3,-22 L2,-22 L1,-12 L2,0 Z'/%3E %3Cpath d='M-6,-21 L-5,-33 L6,-33 L7,-21 Z'/%3E%3Cpath d='M-5,-33 L-5,-40 L6,-40 L6,-33 Z'/%3E %3Ccircle cx='0.5' cy='-45' r='4.6'/%3E%3Cpath d='M-4,-49 L0,-54 L5,-49 Z'/%3E %3Cpath d='M9,-62 L10.6,-62 L10.6,-6 L9,-6 Z'/%3E%3Cpath d='M8,-62 L9.8,-72 L11.6,-62 Z'/%3E %3Cpath d='M5,-36 L10,-38 L10,-33 L5,-31 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='.082' transform='translate(438,648) scale(-1.2,1.2)'%3E%3Cpath d='M-5,0 L-4,-12 L-3,-22 L2,-22 L1,-12 L2,0 Z'/%3E %3Cpath d='M-6,-21 L-5,-33 L6,-33 L7,-21 Z'/%3E%3Cpath d='M-5,-33 L-5,-40 L6,-40 L6,-33 Z'/%3E %3Ccircle cx='0.5' cy='-45' r='4.6'/%3E%3Cpath d='M-8,-38 C-14,-36 -17,-30 -17,-24 L-17,-14 C-17,-8 -13,-4 -10,-2 C-7,-4 -3,-8 -3,-14 L-3,-24 C-3,-30 -4,-36 -8,-38 Z'/%3E %3Cpath d='M8,-36 L13,-52 L15,-51 L10,-34 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='.082' transform='translate(486,648) scale(-1.28,1.28)'%3E%3Cpath d='M-5,0 L-4,-12 L-3,-22 L2,-22 L1,-12 L2,0 Z'/%3E %3Cpath d='M-6,-21 L-5,-33 L6,-33 L7,-21 Z'/%3E%3Cpath d='M-5,-33 L-5,-40 L6,-40 L6,-33 Z'/%3E %3Ccircle cx='0.5' cy='-45' r='4.6'/%3E%3Cpath d='M7,-74 L8.6,-74 L8.6,-4 L7,-4 Z'/%3E%3Cpath d='M8.6,-74 L30,-68 L8.6,-58 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='.082' transform='translate(534,648) scale(-1.18,1.18)'%3E%3Cpath d='M-5,0 L-4,-12 L-3,-22 L2,-22 L1,-12 L2,0 Z'/%3E %3Cpath d='M-6,-21 L-5,-33 L6,-33 L7,-21 Z'/%3E%3Cpath d='M-5,-33 L-5,-40 L6,-40 L6,-33 Z'/%3E %3Ccircle cx='0.5' cy='-45' r='4.6'/%3E%3Cpath d='M-4,-49 L0,-54 L5,-49 Z'/%3E %3Cpath d='M9,-62 L10.6,-62 L10.6,-6 L9,-6 Z'/%3E%3Cpath d='M8,-62 L9.8,-72 L11.6,-62 Z'/%3E %3Cpath d='M5,-36 L10,-38 L10,-33 L5,-31 Z'/%3E%3C/g%3E%3Cg fill='%23fff' opacity='.082' transform='translate(576,648) scale(-1.12,1.12)'%3E%3Cpath d='M-5,0 L-4,-12 L-3,-22 L2,-22 L1,-12 L2,0 Z'/%3E %3Cpath d='M-6,-21 L-5,-33 L6,-33 L7,-21 Z'/%3E%3Cpath d='M-5,-33 L-5,-40 L6,-40 L6,-33 Z'/%3E %3Ccircle cx='0.5' cy='-45' r='4.6'/%3E%3Cpath d='M-8,-38 C-14,-36 -17,-30 -17,-24 L-17,-14 C-17,-8 -13,-4 -10,-2 C-7,-4 -3,-8 -3,-14 L-3,-24 C-3,-30 -4,-36 -8,-38 Z'/%3E %3Cpath d='M8,-36 L13,-52 L15,-51 L10,-34 Z'/%3E%3C/g%3E %3C/g%3E %3C/svg%3E");
        background-repeat: no-repeat;
        background-position: center top;
        background-size: 100% auto;
        background-attachment: local;
      }

      .ewa-row { margin-bottom: 8px; }
      .ewa-names { display: flex; gap: 8px; }
      .ewa-namelist { display: inline; }
      .ewa-field { flex: 1; min-width: 0; display: block; }
      .ewa-field > span {
        display: block; margin-bottom: 3px;
        font: 600 10px/1 "Segoe UI", Arial, sans-serif !important;
        letter-spacing: .7px; color: var(--bronze);
      }
      .ewa-buttons { display: flex; gap: 6px; }
      #ewa-analyze { flex: 1; padding: 9px; font-size: 13px !important; background: #3f454d; border-color: #a9b2bb; color: var(--parch); }
      #ewa-analyze:hover { background: #4a515a; }

      #ewa-status { color: var(--muted); font-size: 12px; padding: 3px 0; }
      #ewa-status:empty { display: none; }
      .ewa-muted { color: var(--muted); font-size: 11px; }

      .ewa-foot {
        margin-top: 14px; padding-top: 9px; border-top: 1px solid var(--edge);
        font-size: 10px; letter-spacing: .6px; color: var(--faint); text-align: center;
      }
      .ewa-foot .ewa-mark { width: 9px; height: 9px; margin-right: 5px; vertical-align: -1px; }

      .ewa-warn {
        margin-top: 10px; padding: 8px 10px; border-radius: 3px;
        background: rgba(226, 98, 92, .12); border-left: 3px solid var(--loss);
        color: #f0b2ae; font-size: 11px;
      }

      /* Period slider */
      .ewa-time { display: flex; align-items: flex-start; gap: 10px; padding: 2px 0; }
      .ewa-time-label { padding-top: 5px; }
      .ewa-time-main { flex: 1; min-width: 0; }
      /* The marks sit exactly below their position on the slider.
         8px margin, because that is where the handle stops. */
      .ewa-ticks { position: relative; height: 15px; margin: 1px 8px 0; }
      .ewa-tick {
        position: absolute; top: 0; transform: translateX(-50%);
        font-size: 9.5px; line-height: 15px; color: var(--faint);
        cursor: pointer; padding: 0 3px; letter-spacing: .2px; white-space: nowrap;
      }
      .ewa-tick:hover { color: var(--text); }
      .ewa-tick.is-on { color: var(--text); font-weight: 700; }
      .ewa-time-label { font-size: 10px; font-weight: 600; letter-spacing: .7px; color: var(--bronze); white-space: nowrap; }
      #ewa-hours {
        display: block; width: 100%; height: 18px; padding: 0; margin: 0;
        background: transparent !important; border: 0 !important;
        appearance: none; -webkit-appearance: none; cursor: pointer;
      }
      #ewa-hours::-webkit-slider-runnable-track { height: 6px; border-radius: 99px; background: #1e2126; border: 1px solid var(--edge); }
      #ewa-hours::-webkit-slider-thumb {
        appearance: none; -webkit-appearance: none; width: 16px; height: 16px; margin-top: -6px;
        border-radius: 50%; background: var(--bronze); border: 2px solid var(--stone);
        box-shadow: 0 0 0 1px var(--bronze); cursor: pointer;
      }
      #ewa-hours:hover::-webkit-slider-thumb { background: var(--parch); }
      #ewa-hours::-moz-range-track { height: 6px; border-radius: 99px; background: #1e2126; border: 1px solid var(--edge); }
      #ewa-hours::-moz-range-thumb { width: 14px; height: 14px; border-radius: 50%; background: var(--bronze); border: 2px solid var(--stone); }
      #ewa-hours-label { font-size: 11px; color: var(--muted); white-space: nowrap; min-width: 92px; text-align: right; font-variant-numeric: tabular-nums; padding-top: 4px; }

      /* Sections */
      .ewa-section-title {
        display: flex; align-items: center; gap: 9px;
        margin: 16px 0 7px; font-size: 11px; font-weight: 700;
        letter-spacing: 1px; color: var(--bronze);
      }
      .ewa-section-title em { font-style: normal; color: var(--faint); font-weight: 400; }
      .ewa-section-title::after { content: ""; flex: 1; height: 1px; background: var(--edge); }
      .ewa-section-title.has-hint::after { display: none; }
      .ewa-rule { flex: 1; height: 1px; background: var(--edge); }
      .ewa-hint { font-style: normal; font-weight: 400; letter-spacing: .2px; color: var(--faint); text-transform: none; }

      /* Matchup bar */
      .ewa-loadbar { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; }
      #ewa-panel button.ewa-load-btn { background: #1e2126; color: var(--muted); padding: 5px 10px; font-size: 11px !important; }
      #ewa-panel button.ewa-load-btn:hover { color: var(--parch); }
      #ewa-panel button.ewa-load-btn.is-on { color: var(--ink); background: var(--bronze); border-color: var(--parch-2); font-weight: 700; }
      #ewa-panel button.ewa-more-btn { width: 100%; margin-top: 7px; font-size: 11px !important; }
      #ewa-reset { flex: 0 0 auto; padding: 9px 14px; font-size: 12px !important; background: #1e2126; color: var(--muted); }
      #ewa-reset:hover { color: var(--parch); background: #262a30; }

      .ewa-h2h {
        margin: 14px 0 4px; padding: 10px 11px 12px;
        border: 1px solid var(--edge); border-left: 3px solid var(--bronze);
        border-radius: 5px; background: #20232800;
      }
      .ewa-h2h-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 9px; }
      .ewa-h2h-pair { display: flex; align-items: baseline; gap: 7px; flex-wrap: wrap; }
      .ewa-h2h-tag {
        font-size: 10px; letter-spacing: .09em; text-transform: uppercase;
        color: var(--faint);
      }
      .ewa-h2h-me { font-size: 15px; color: var(--parch); }
      .ewa-h2h-vs { font-size: 11px; color: var(--faint); }
      .ewa-h2h-foe { font-size: 15px; color: var(--muted); }
      .ewa-h2h-act { display: flex; gap: 6px; }


      /* Summary card */
      .ewa-sum {
        margin-top: 10px; padding: 12px 14px; border-radius: 4px;
        background: var(--stone-2); border: 1px solid var(--edge); border-left: 3px solid var(--bronze);
      }
      .ewa-sum-title { font: 400 17px/1.2 Cinzel, Georgia, serif; margin-bottom: 9px; color: var(--parch); }
      .ewa-sum-top { display: flex; align-items: flex-end; gap: 26px; flex-wrap: wrap; }
      .ewa-sum-rate strong { font: 400 27px/1 Cinzel, Georgia, serif; display: block; color: var(--parch); }
      .ewa-sum-kv strong { font-size: 16px; line-height: 1.1; display: block; }
      .ewa-sum-rate span, .ewa-sum-kv span { font-size: 10px; font-weight: 600; letter-spacing: .7px; color: var(--muted); }
      .ewa-sum em { font-style: normal; }
      .ewa-sum .w { color: var(--win); }
      .ewa-sum .l { color: var(--loss); }
      .ewa-sum .fast { color: var(--fast); }
      .ewa-sum .slow { color: var(--slow); }
      .ewa-rate-bar { height: 4px; margin-top: 11px; border-radius: 99px; background: rgba(226, 98, 92, .5); overflow: hidden; }
      .ewa-rate-bar span { display: block; height: 100%; background: var(--win); }
      .ewa-form { display: flex; align-items: center; gap: 5px; margin-top: 9px; font-size: 11px; color: var(--muted); }
      .ewa-form > span:first-child { font-size: 10px; font-weight: 600; letter-spacing: .7px; color: var(--faint); margin-right: 4px; }
      .ewa-dot { width: 9px; height: 9px; border-radius: 50%; }
      .ewa-dot.w { background: var(--win); }
      .ewa-dot.l { background: var(--loss); }

      .ewa-act { margin-top: 11px; padding-top: 10px; border-top: 1px solid var(--edge); }
      .ewa-act-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 5px; }
      .ewa-act-head span { font-size: 10px; font-weight: 600; letter-spacing: .7px; color: var(--bronze); }
      .ewa-act-head b { font-size: 11px; font-weight: 400; color: var(--muted); font-variant-numeric: tabular-nums; }
      .ewa-act-bars { display: flex; align-items: flex-end; gap: 2px; height: 36px; padding: 2px 0; border-bottom: 1px solid var(--edge); }
      .ewa-act-bars i { flex: 1; background: var(--bronze); border-radius: 1px 1px 0 0; min-height: 2px; }
      .ewa-act-bars i.is-empty { background: #1e2126; }
      .ewa-act-scale { display: flex; justify-content: space-between; margin-top: 4px; font-size: 9px; letter-spacing: .4px; color: var(--faint); font-variant-numeric: tabular-nums; }

      /* Realm colours */
      .ewa-realm-alb { --realm: #e0605c; }
      .ewa-realm-mid { --realm: #6aa8f0; }
      .ewa-realm-hib { --realm: #6cc46f; }
      .ewa-realm-none { --realm: #8e8676; }
      .ewa-rm { display: inline-block; width: 7px; height: 7px; border-radius: 1px; background: var(--realm); margin-right: 7px; vertical-align: 1px; flex: none; }

      /* Bar lists */
      .ewa-bars { display: grid; gap: 4px; }
      .ewa-bar-row { display: grid; grid-template-columns: 74px 1fr 46px 58px; gap: 10px; align-items: center; font-size: 12px; }
      .ewa-bar-name { color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ewa-bar { height: 5px; border-radius: 99px; background: #1e2126; overflow: hidden; }
      .ewa-bar > span { display: block; height: 100%; border-radius: 99px; background: var(--bronze); }
      .ewa-bar-val { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
      .ewa-bar-sub { text-align: right; font-size: 11px; color: var(--muted); }
      .ewa-bar-row.ewa-load { cursor: pointer; padding: 2px 5px; margin: -2px -5px; border-radius: 3px; }
      .ewa-bar-row.ewa-load:hover { background: var(--stone-3); }
      .ewa-bar-row.ewa-load:hover .ewa-bar-name { color: var(--bronze); }

      /* Names */
      .ewa-pick { cursor: pointer; white-space: nowrap; }
      .ewa-pick:hover { color: var(--bronze); text-decoration: underline; }

      /* Groups */
      .ewa-groups { display: grid; }
      .ewa-group { display: flex; align-items: baseline; gap: 10px; padding: 5px 0; border-bottom: 1px solid #3a4048; font-size: 12px; }
      .ewa-group-names { flex: 1; min-width: 0; }
      .ewa-group-n { font-size: 10px; color: var(--faint); flex: none; }

      /* Opponent lists */
      .ewa-opponents { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; }
      .ewa-opp-list { display: grid; }
      .ewa-opp { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid #3a4048; }
      .ewa-opp-name { font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ewa-opp-val { font-size: 12.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
      .ewa-opp-sub { font-size: 11px; color: var(--muted); margin-left: auto; margin-right: 10px; white-space: nowrap; }
      .ewa-opp-sub em { font-style: normal; }
      .ewa-opp-sub .w, .ewa-group .w { color: var(--win); }
      .ewa-opp-sub .l, .ewa-group .l { color: var(--loss); }
      .ewa-opp-col.is-win .ewa-opp-val { color: var(--win); }
      .ewa-opp-col.is-loss .ewa-opp-val { color: var(--loss); }

      /* Fight list */
      .ewa-fights { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
      .ewa-fight {
        display: flex; align-items: center; gap: 12px; padding: 7px 10px;
        background: var(--stone-2); border: 1px solid #3a4048; border-left: 3px solid transparent; border-radius: 3px;
      }
      .ewa-fight:hover { background: var(--stone-3); }
      #ewa-panel a.ewa-fight, #ewa-panel a.ewa-fight:hover { text-decoration: none; color: inherit; }
      .ewa-fight.is-win { border-left-color: var(--win); }
      .ewa-fight.is-loss { border-left-color: var(--loss); }
      .ewa-fight.is-duel { border-left-color: var(--edge); }
      .ewa-fight-res { font-size: 10px; font-weight: 700; width: 12px; flex: none; }
      .ewa-fight.is-win > .ewa-fight-res { color: var(--win); }
      .ewa-fight.is-loss > .ewa-fight-res { color: var(--loss); }
      .ewa-fight-res.w { color: var(--win); }
      .ewa-fight-res.l { color: var(--loss); }
      .ewa-fight-main { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
      .ewa-fight-opp { font-size: 12.5px; color: var(--text); }
      .ewa-fight.is-duel .ewa-fight-opp { display: flex; align-items: baseline; gap: 7px; }
      .ewa-fight.is-duel .ewa-fight-opp.loser { color: var(--muted); }
      .ewa-fight.is-duel .ewa-fight-opp > span:last-child { flex: 1; min-width: 0; }
      .ewa-fight-mates { font-size: 11px; color: var(--faint); }
      .ewa-dur { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); min-width: 44px; text-align: right; flex: none; }
      .ewa-dur.fast { color: var(--fast); }
      .ewa-dur.slow { color: var(--slow); }
      .ewa-fight-meta { display: flex; flex-direction: column; align-items: flex-end; font-size: 10px; color: var(--faint); white-space: nowrap; flex: none; min-width: 66px; }

      /* Fight report: header with both sides */
      .ewa-hero {
        display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: stretch;
        margin-top: 10px;
      }
      .ewa-hero-side {
        display: flex; flex-direction: column; gap: 3px; min-width: 0;
        padding: 10px 13px; border-radius: 4px;
        background: var(--stone-2); border: 1px solid var(--edge); border-top: 3px solid var(--realm);
      }
      .ewa-hero-side.is-loss { text-align: right; }
      .ewa-hero-head { display: flex; align-items: center; gap: 7px; }
      .ewa-hero-side.is-loss .ewa-hero-head { flex-direction: row-reverse; }
      .ewa-hero-tag { font-size: 10px; font-weight: 700; letter-spacing: 1.2px; }
      .ewa-hero-side.is-win .ewa-hero-tag { color: var(--win); }
      .ewa-hero-side.is-loss .ewa-hero-tag { color: var(--loss); }
      .ewa-hero-count { font-size: 10px; color: var(--faint); }
      .ewa-hero-names { font-size: 12.5px; line-height: 1.55; color: var(--text); }

      .ewa-hero-mid {
        display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
        padding: 8px 16px; border-radius: 4px; background: var(--stone-2); border: 1px solid var(--edge);
        min-width: 112px;
      }
      .ewa-hero-matchup { font: 400 19px/1 Cinzel, Georgia, serif; color: var(--text); }
      .ewa-hero-time { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; color: var(--text); }
      .ewa-hero-time.fast { color: var(--fast); }
      .ewa-hero-time.slow { color: var(--slow); }
      .ewa-hero-date { font-size: 10px; color: var(--faint); }

      /* Fight report: comp */
      .ewa-comp { display: grid; gap: 5px; }
      .ewa-comp-row { padding: 7px 10px; border-radius: 3px; background: var(--stone-2); border: 1px solid #3a4048; border-left: 3px solid var(--realm); }
      .ewa-comp-line { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
      .ewa-realm-tag { font-size: 10px; font-weight: 700; letter-spacing: .5px; padding: 2px 6px; border-radius: 2px; background: var(--realm); color: #22252a; }
      .ewa-wl { font-size: 10px; font-weight: 700; width: 16px; height: 16px; border-radius: 2px; display: inline-flex; align-items: center; justify-content: center; }
      .ewa-wl.is-win { background: rgba(127, 201, 111, .18); color: var(--win); }
      .ewa-wl.is-loss { background: rgba(226, 98, 92, .18); color: var(--loss); }
      .ewa-comp-stats { display: inline-flex; gap: 8px; align-items: center; white-space: nowrap; min-width: 130px; }
      .ewa-comp-rule { font-weight: 700; }
      .ewa-stat { display: inline-flex; align-items: center; gap: 3px; font-size: 11px; color: var(--role); }
      .ewa-stat b { font-size: 12px; }
      .ewa-comp-chips { display: inline-flex; flex-wrap: wrap; gap: 4px; flex: 1; min-width: 0; }
      .ewa-chip { padding: 1px 7px; border-radius: 2px; font-size: 11px; white-space: nowrap; color: var(--text); border: 1px solid color-mix(in srgb, var(--role) 55%, transparent); }
      .ewa-chip b { color: var(--role); margin-right: 3px; }
      .ewa-comp-support { margin: 5px 0 0 2px; font-size: 11px; color: var(--faint); }
      .ewa-comp-support span { font-size: 10px; font-weight: 600; letter-spacing: .5px; margin-right: 6px; }

      /* Fight report: crowd control */
      .ewa-duel { display: grid; gap: 15px; }
      .ewa-duel .ewa-duel-row { display: grid; grid-template-columns: 56px 1fr 56px; align-items: end; gap: 9px; }
      .ewa-duel-val { position: relative; font-size: 12px; color: var(--muted); line-height: 1; }
      .ewa-duel-val:last-child { text-align: right; }
      .ewa-duel-val.lead { color: var(--text); font-weight: 700; }
      /* The note hangs below the number without changing the row height */
      .ewa-duel-val i {
        position: absolute; left: 0; right: 0; top: 100%; margin-top: 2px;
        font-style: italic; font-weight: 400; font-size: 9.5px; color: var(--faint);
      }
      .ewa-duel-name { display: block; text-align: center; font-size: 10px; font-weight: 600; color: var(--muted); letter-spacing: .5px; margin-bottom: 3px; }
      .ewa-duel-mid { position: relative; }
      .ewa-duel-sub { position: absolute; left: 0; right: 0; top: 100%; margin-top: 3px; text-align: center; font-size: 9px; color: var(--faint); }
      .ewa-duel .ewa-duel-bar { display: grid; grid-template-columns: 1fr 1fr; gap: 2px; height: 6px; background: none; }
      .ewa-duel .ewa-duel-bar .half { background: #1e2126; border-radius: 99px; display: flex; overflow: hidden; }
      .ewa-duel .ewa-duel-bar .half.l { justify-content: flex-end; }
      .ewa-duel .ewa-duel-bar .half.l span { background: var(--win); }
      .ewa-duel .ewa-duel-bar .half.r span { background: var(--loss); }
      .ewa-duel .ewa-duel-bar .half span { display: block; height: 100%; border-radius: 99px; }

      /* Fight report: players */
      .ewa-rosters { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .ewa-roster { padding: 0 2px; }
      .ewa-roster-head {
        display: flex; align-items: center; gap: 7px;
        font-size: 10px; font-weight: 700; letter-spacing: .7px;
        padding: 0 0 5px; border-bottom: 1px solid var(--edge); margin-bottom: 2px;
      }
      .ewa-roster-head.is-win { color: var(--win); }
      .ewa-roster-head.is-loss { color: var(--loss); }
      .ewa-pl { padding: 6px 0; border-bottom: 1px solid #3a4048; }
      .ewa-pl-top { display: flex; align-items: baseline; gap: 6px; margin-bottom: 3px; }
      .ewa-pl-name { font-size: 12.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ewa-pl-death { font-size: 10.5px; color: var(--loss); font-weight: 700; margin-left: auto; padding-left: 8px; }
      .ewa-pl-cls { font-size: 11.5px; color: var(--role); white-space: nowrap; }
      .ewa-pl-cls::before { content: "· "; color: var(--faint); }
      .ewa-pl-rr { font-size: 11px; font-weight: 700; color: var(--muted); font-variant-numeric: tabular-nums; flex: none; margin-left: auto; }
      .ewa-pl-nums { display: flex; flex-wrap: wrap; column-gap: 7px; row-gap: 2px; font-size: 9.5px; color: var(--faint); font-variant-numeric: tabular-nums; }
      .ewa-pl-nums b { font-size: 11px; font-weight: 700; margin-right: 2px; }
      .ewa-pl-nums .dmg { color: #e8917a; }
      .ewa-pl-nums .taken { color: #b08078; }
      .ewa-pl-nums .heal { color: var(--win); }
      .ewa-pl-nums .healr { color: #8fc08a; }
      .ewa-pl-nums .mez { color: #5fd0dd; }
      .ewa-pl-nums .stun { color: #6aa8f0; }
      .ewa-pl-nums .root { color: #e3cf5c; }
      .ewa-pl-nums .peel { color: #e2a15f; }
      .ewa-sizes { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 4px; }
      .ewa-size {
        display: inline-flex; align-items: baseline; gap: 6px;
        padding: 4px 9px; border: 1px solid var(--edge); border-radius: 4px;
        background: #1e2126; font-size: 10.5px; color: var(--faint);
        font-variant-numeric: tabular-nums;
      }
      .ewa-size b { font-size: 11.5px; color: var(--text); }
      .ewa-size-wl em { font-style: normal; font-weight: 700; }
      .ewa-size-wl .w { color: var(--win); }
      .ewa-size-wl .l { color: var(--loss); }
      .ewa-size i { font-style: normal; font-weight: 700; color: var(--parch-2); }


      .ewa-pl-nums .int { color: #b39ddb; }
      .ewa-pl-nums .shear { color: #9fb0c4; }
      .ewa-pl-nums .disease { color: #a5c27a; }
      .ewa-pl-nums .ns { color: #c9a4d8; }
      .ewa-pl-share { font-style: normal; color: var(--faint); opacity: .72; margin-left: 3px; }
      .ewa-pl-nums > span { white-space: nowrap; }

      /* Roles */
      .ewa-role-caster { --role: #b79ae2; }
      .ewa-role-tank { --role: #e0a05c; }
      .ewa-role-stealth { --role: #9dabb8; }
      .ewa-role-support { --role: #e2cc6a; }
      .ewa-role-unknown { --role: #8e8676; }
      .ewa-ico { display: inline-flex; width: 12px; height: 12px; flex: none; color: var(--role); }
      .ewa-ico svg { width: 100%; height: 100%; }
` + ANALYSIS_CSS;

    document.head.appendChild(style);
    document.body.appendChild(panel);

    $("#ewa-analyze").addEventListener("click", () => {
      if (detail) {
        calculate();
        return;
      }
      searchPlayer(); // same as Enter in the player field
    });

    renderTicks();
    guardBrand(panel);

    const hourInput = $("#ewa-hours");
    if (hourInput) {
      let hourTimer = null;
      hourInput.addEventListener("input", () => {
        hourIndex = Number(hourInput.value);
        rememberHours(hourIndex);
        renderTicks();
        clearTimeout(hourTimer);
        hourTimer = setTimeout(calculate, 120);
      });
    }

    // A search on the Eden page means a fresh set of data.
    const siteButton = document.querySelector("#search_button2");
    if (siteButton) {
      siteButton.addEventListener("click", () => {
        resetCollected();
        updateCacheLabel();
      }, true);
    }

    panel.addEventListener("click", event => {
      const secHead = event.target.closest(".ewa-sec-head");
      if (secHead && !event.target.closest("a, button, .ewa-pick")) {
        toggleSection(secHead);
        return;
      }

      if (handleAnalysisClick(event)) return;

      const tick = event.target.closest(".ewa-tick");
      if (tick) {
        setHourIndex(Number(tick.dataset.hour));
        return;
      }

      if (event.target.closest("#ewa-time-off")) {
        setHourIndex(HOUR_STEPS.length - 1);
        return;
      }

      const load = event.target.closest(".ewa-load, .ewa-load-btn");
      if (load && load.dataset.min !== undefined) {
        loadMatchup(Number(load.dataset.min), Number(load.dataset.max));
        return;
      }

      if (event.target.closest("#ewa-more")) {
        showAllFights = true;
        calculate();
        return;
      }

      const pick = event.target.closest(".ewa-pick");
      if (pick) {
        // Some names sit inside a link to the fight detail page
        event.preventDefault();
        event.stopPropagation();
        onNameClick(pick.dataset.player || "");
        return;
      }

      const toSearch = event.target.closest(".ewa-search-name");
      if (toSearch) {
        event.preventDefault();
        searchPlayer(toSearch.dataset.player || "");
        return;
      }

      if (event.target.closest("#ewa-h2h-clear")) {
        setHeadToHead("");
        return;
      }

      if (event.target.closest("#ewa-reset")) {
        resetAll();
        return;
      }

    });

    panel.addEventListener("keydown", event => {
      if (event.key === "Enter" && event.target.id === "ewa-token") saveToken();
    });

    const h2hInput = $("#ewa-h2h");
    if (h2hInput) {
      h2hInput.addEventListener("keydown", event => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        setHeadToHead(h2hInput.value.trim());
      });
    }

    const playerInput = $("#ewa-player");
    if (playerInput) {
      playerInput.value = getSiteSearchValue();
      playerInput.addEventListener("keydown", event => {
        if (event.key === "Enter") {
          event.preventDefault();
          searchPlayer();
        }
      });
    }

    // Back to top: shows up once the panel has been scrolled down a bit
    const body = $("#ewa-body");
    const topButton = $("#ewa-top");
    body.addEventListener("scroll", () => {
      topButton.hidden = body.scrollTop < TOP_BUTTON_FROM;
    }, { passive: true });
    topButton.addEventListener("click", () => body.scrollTo({ top: 0, behavior: "smooth" }));

    $("#ewa-collapse").addEventListener("click", () => {
      const body = $("#ewa-body");
      const hidden = body.style.display === "none";
      body.style.display = hidden ? "block" : "none";
      panel.classList.toggle("is-collapsed", !hidden); // hides the back to top button as well
      if (hidden) topButton.hidden = body.scrollTop < TOP_BUTTON_FROM; // scroll position may have changed
      $("#ewa-collapse").textContent = hidden ? "−" : "+";
    });

    watchCollapse(panel);

    if (detail) {
      // Nothing changes on the detail page after loading, so run once.
      calculate();
      return;
    }

    const table = findFightTable();
    if (table) {
      let harvestTimer = null;
      const observer = new MutationObserver(() => {
        clearTimeout(harvestTimer);
        harvestTimer = setTimeout(() => {
          const before = collected.size;
          harvest();
          updateCacheLabel();
          // The table was empty when the panel last drew and has rows now
          if (!before && collected.size && !reloadPoll) calculate();
        }, 150);
      });

      observer.observe(table, { childList: true, subtree: true });
    }

    updateCacheLabel();

    // Eden fills the table after the page has loaded. Once it is there,
    // run once by itself so the overview shows up without a click.
    renderLoadBar();
    afterTableReload(null, "fights", 1);

    showTab(currentTab);

    // Data collection in the background, only on the fight list
    runCollector();
    migrateOldArchive();
    tuneDurations();
    window.addEventListener("pagehide", () => {
      const lock = storageGet(COLLECT_LOCK_KEY);
      if (lock && lock.tab === TAB_ID) storageSet(COLLECT_LOCK_KEY, null);
    });
  }

  // Keeps the byline and the footer in the panel. If either is removed at
  // runtime it comes back. This does not help against editing the script
  // file itself, which nobody can prevent with a userscript.
  function guardBrand(panel) {
    const brand = panel.querySelector(".ewa-brand");
    const foot = panel.querySelector(".ewa-foot");
    if (!brand || !foot) return;

    const byHtml = (panel.querySelector(".ewa-by") || {}).outerHTML || "";
    const footHtml = foot.innerHTML;

    const restore = () => {
      const by = panel.querySelector(".ewa-by");
      if ((!by || !by.textContent.includes("Vumas")) && byHtml) {
        if (by) by.remove();
        const titleLine = panel.querySelector(".ewa-title");
        if (titleLine) titleLine.insertAdjacentHTML("beforeend", byHtml);
      }

      const footer = panel.querySelector(".ewa-foot");
      if (!footer) {
        const body = $("#ewa-body");
        if (body) {
          const element = document.createElement("div");
          element.className = "ewa-foot";
          element.innerHTML = footHtml;
          body.appendChild(element);
        }
      } else if (!footer.textContent.includes("Vumas")) {
        footer.innerHTML = footHtml;
      }
    };

    let guardTimer = null;
    const observer = new MutationObserver(() => {
      clearTimeout(guardTimer);
      guardTimer = setTimeout(restore, 120);
    });

    observer.observe(panel, { childList: true, subtree: true, characterData: true });
  }

  function startUiWhenReady() {
    purgeFightCache();
    loadTuning();
    if (document.body) {
      createUi();
      return;
    }
    window.addEventListener("DOMContentLoaded", createUi, { once: true });
  }

  startUiWhenReady();
})();