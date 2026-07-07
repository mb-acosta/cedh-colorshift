import { COMMANDERS } from "./commanders.js";
import { firebaseConfig, EVENT_ID } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, onValue, push, runTransaction, remove, update, get,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ───────────────────────────── Config ─────────────────────────────
// How likely is the wheel to land on "PARTNER" vs a single commander?
//   0–1      -> target probability (e.g. 0.15 = ~15%). Weight is recomputed
//               each build so the ratio stays constant as singles are claimed.
//   "cards"  -> proportional to the number of partner CARDS in play (25)
//               vs available single cards (71). Partner odds start ~26%.
//   "combos" -> proportional to the number of partner COMBOS still open
//               (up to 300) vs single cards. Makes partners land ~80% of
//               the time early on. Pick this for a partner-heavy draft.
//   <number> -> a fixed weight (e.g. 30) for the whole PARTNER slice.
const PARTNER_ODDS = 0.20;

// ──────────────────────────── Data split ──────────────────────────
// The shipped list is the baseline; admins can add "custom" cards and flip a
// card's partner status at runtime (both persisted in Firebase — see the
// cardMeta / customCards nodes below). COMMANDERS is the live, combined list
// everything reads; SINGLES / PARTNERS / NAME_MAP are DERIVED from it and
// rebuilt (rebuildIndexes) whenever it changes.
const STATIC_COMMANDERS = COMMANDERS.map((c) => ({ ...c }));   // immutable snapshot of shipped data
const comboKey = (a, b) => [a, b].sort().join("  ||  ");
let SINGLES = [];
let PARTNERS = [];
let NAME_MAP = new Map();
function rebuildIndexes() {
  // "pending" (future upload) and "hidden" (retired) cards are kept in
  // COMMANDERS / NAME_MAP — so the admin grid and result thumbnails can still
  // render them — but are excluded from SINGLES / PARTNERS so they never reach
  // the wheel (guest rolls read these too). "pendingRemoval" stays rollable
  // until "Store event & reset pool" flips it to "hidden".
  const rollable = COMMANDERS.filter((c) => c.status !== "pending" && c.status !== "hidden");
  SINGLES = rollable.filter((c) => !c.partner);
  PARTNERS = rollable.filter((c) => c.partner);
  NAME_MAP = new Map(COMMANDERS.map((c) => [c.name, c]));
}
rebuildIndexes();

// Color variants of one commander share a "base name" — the part before a
// trailing "(...)", e.g. "Dargo, the Shipwrecker (Black)" / "(Blue)" both base
// to "Dargo, the Shipwrecker". A partner pair must never be two variants of the
// same commander, so we treat them as the same card for pairing purposes.
const baseName = (name) => String(name).replace(/\s*\([^()]*\)\s*$/, "").trim();
const sameCommander = (a, b) => baseName(a) === baseName(b);

// Firebase keys forbid  . $ # [ ] /  and control chars. encodeURIComponent
// handles all of those except ".", which we escape too. Used for account keys
// and for storing commander names / combo keys as history child-keys.
const encKey = (s) => encodeURIComponent(String(s)).replace(/\./g, "%2E");
// A person's stable identity = their lowercased Discord name. Old free-text
// spins already used this as `discord`, so accounts line up with past results.
const userKey = (name) => encKey(String(name).trim().toLowerCase());

// Google Drive image embedding (the thumbnail endpoint is the reliable one for
// public files). Cards must be shared "Anyone with the link".
// drive.google.com/thumbnail redirects here; using it directly skips a hop.
const driveImg = (id) => `https://lh3.googleusercontent.com/d/${id}=w480`;
function imgTag(id, alt, cls) {
  if (!id) return "";
  return `<img class="card ${cls || ""}" src="${driveImg(id)}" alt="${escapeHtml(alt)}" ` +
    `loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('broken')">`;
}
// All card faces for a commander name (front, plus back if it's a flip card).
function cardsForName(name, cls) {
  const c = NAME_MAP.get(name);
  if (!c) return "";
  return imgTag(c.img, name, cls) + (c.backImg ? imgTag(c.backImg, c.back || name, cls) : "");
}

// ─────────────────────── Card-art overrides ───────────────────────
// Admins can re-point a card's art at a different Google Drive file without a
// redeploy. Overrides live in Firebase at `cardImages/<encKey(name)>` and are
// merged over the static COMMANDERS list at load. We keep the shipped IDs so an
// override can be reverted cleanly. Keyed by the EXACT name (not baseName) so
// color variants that share a base name stay independent.
let ORIGINAL_ART = new Map(COMMANDERS.map((c) => [c.name, { img: c.img, backImg: c.backImg }]));
let cardImageOverrides = {};     // encKey(name) -> { img?, backImg?, ts?, by? }
let cardImageStaged = {};        // encKey(name) -> { img?, backImg?, ts?, by? }  — staged art (admin-only, publishes on Store-event)
let cardMetaOverrides = {};      // encKey(name) -> { partner: bool }  — partner-status overrides
let customCards = {};            // encKey(name) -> { name, back?, img, backImg? }  — admin-added cards
let cardStatusOverrides = {};    // encKey(name) -> { state, ts?, by? }  — staged roster status (see below)
const LS_CARDIMG = "cw_card_images";   // local-preview fallback stores
const LS_CARDIMG_STAGED = "cw_card_images_staged";
const LS_CARDMETA = "cw_card_meta";
const LS_CUSTOMCARDS = "cw_custom_cards";
const LS_CARDSTATUS = "cw_card_status";

// Pull a Google Drive file (or folder) ID out of a share link, embed URL, or a
// bare ID pasted on its own. Returns null if nothing that looks like an ID is
// found. Drive IDs are long, URL-safe tokens (letters/digits/-/_).
function extractDriveId(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  const patterns = [
    /\/file\/d\/([-\w]{20,})/,          // drive.google.com/file/d/<id>/view
    /\/(?:folders|d)\/([-\w]{20,})/,     // /folders/<id>  or  lh3…/d/<id>
    /[?&]id=([-\w]{20,})/,               // ?id=<id> / open?id=<id> / uc?id=<id>
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }
  if (/^[-\w]{20,}$/.test(s)) return s;   // bare ID
  return null;
}

// Rebuild the live COMMANDERS list from the shipped baseline + admin-added
// custom cards, then layer on the partner-status (cardMeta) and card-art
// (cardImages) overrides. SINGLES / PARTNERS / NAME_MAP / ORIGINAL_ART are all
// derived here, so one rebuild propagates a change everywhere.
function rebuildCommanders() {
  const list = STATIC_COMMANDERS.map((c) => ({ ...c }));
  const staticNames = new Set(list.map((c) => c.name));
  for (const enc in customCards) {
    const cc = customCards[enc];
    if (!cc || !cc.name || staticNames.has(cc.name)) continue;   // skip blanks / name clashes
    list.push({
      name: cc.name, back: cc.back || null, partner: false,
      img: cc.img || null, backImg: cc.backImg || null, custom: true,
    });
  }
  // Baseline art (shipped or as-imported) so a Revert has something to fall back to.
  ORIGINAL_ART = new Map(list.map((c) => [c.name, { img: c.img, backImg: c.backImg }]));
  for (const c of list) {
    const enc = encKey(c.name);
    const meta = cardMetaOverrides[enc];
    if (meta && typeof meta.partner === "boolean") c.partner = meta.partner;
    const ov = cardImageOverrides[enc];
    if (ov && typeof ov.img === "string") c.img = ov.img;
    if (ov && typeof ov.backImg === "string") c.backImg = ov.backImg;
    const st = cardStatusOverrides[enc];
    c.status = (st && typeof st.state === "string") ? st.state : null;   // null = active
  }
  // Swap into the live array in place (keep the const binding everyone imports).
  COMMANDERS.length = 0;
  COMMANDERS.push(...list);
  rebuildIndexes();
}

// Each card-data Firebase node has its own mirror; any of them changing merges
// back over the list and re-renders every spot card data is shown.
function applyCardImages(snap)  { cardImageOverrides = snap || {}; onCardDataChanged(); }
// Staged art is admin-only preview — it never touches the live COMMANDERS list
// (players/gallery keep the current art until it's published), so this only
// refreshes the card-art grid rather than rebuilding the wheel.
function applyCardImageStaged(snap) {
  cardImageStaged = snap || {};
  if (isAdmin && !adminCollapsed && typeof renderCardArtGrid === "function") renderCardArtGrid();
}
function applyCardMeta(snap)    { cardMetaOverrides = snap || {}; onCardDataChanged(); }
function applyCustomCards(snap) { customCards = snap || {}; onCardDataChanged(); }
function applyCardStatus(snap)  { cardStatusOverrides = snap || {}; onCardDataChanged(); }

function onCardDataChanged() {
  rebuildCommanders();
  // Reflect new art in the visible spots (result thumbnails, assignments list).
  // The wheel canvas draws text, not art, but a rebuild also adds/removes cards
  // and flips partner status, so refresh it (and the spin button + admin
  // dropdowns) when idle so the next spin picks the change up.
  if (typeof renderResults === "function") renderResults();
  if (wheel && phase === "main" && !wheel.spinning) buildMainWheel();
  if (typeof updateSpinButton === "function" && wheel && !wheel.spinning) updateSpinButton();
  if (isAdmin) {
    populateManualOptions();
    if (!adminCollapsed) renderCardArtGrid();
  }
}

// ───────────────────────────── Firebase ───────────────────────────
let db, assignmentsRef, historyRef, usersRef;
let assignments = {};            // live mirror of the DB
let historyMirror = {};          // userKey -> { singles:{enc:orig}, combos:{enc:orig} }
let usedSingles = new Set();     // single commander names already taken (pool-wide)
let usedCombos = new Set();      // partner combo keys already taken (pool-wide)
let usedDiscords = new Set();    // discord names (lowercase) already assigned this event
let firebaseReady = false;

// ── Auth / scope state (see blocked()) ──
let currentUser = null;          // { username, key } when logged in
let guestSeq = false;            // is the in-progress spin sequence a guest roll?
let scope = "personal";          // "personal" = exclude my past results too; "all" = nothing filtered (guest)

// ── Admin ownership ──
// Admin status is derived: you're admin iff logged in as the claimed owner
// account. The owner is stored once (create-only) so #admin can't be abused
// by anyone who stumbles on the URL.
let adminOwnerKey = null;        // userKey of the admin account (null = unclaimed)
let adminWired = false;          // admin button listeners attached only once
let registeredKeys = new Set();  // userKeys that have a registered account (loaded in admin)
let adminCollapsed = false;      // admin tools minimized to a chip (persisted per-browser)
const LS_ADMIN = "cw_admin_owner"; // local-preview fallback store
const LS_ADMIN_COLLAPSED = "cw_admin_collapsed";

function initFirebase() {
  if (!firebaseConfig.apiKey || firebaseConfig.apiKey === "REPLACE_ME") {
    setStatus("⚠ Firebase not configured yet — edit firebase-config.js (see README). Running in local preview mode.", "warn");
    return false;
  }
  try {
    const app = initializeApp(firebaseConfig);
    db = getDatabase(app);
    assignmentsRef = ref(db, `events/${EVENT_ID}/assignments`);
    historyRef = ref(db, `events/${EVENT_ID}/history`);
    usersRef = ref(db, `users`);
    onValue(assignmentsRef, (snap) => {
      assignments = snap.val() || {};
      recomputeUsed();
      firebaseReady = true;
      setStatus("● Connected — live", "ok");
      renderResults();
      renderStats();
      if (phase === "main" && !wheel.spinning) buildMainWheel();
      updateSpinButton();
      if (isAdmin) populateManualOptions();
    }, (err) => {
      setStatus("✖ Database error: " + err.message + " (check your Rules — see README)", "err");
    });
    onValue(historyRef, (snap) => {
      historyMirror = snap.val() || {};
      if (phase === "main" && !wheel.spinning) buildMainWheel();
      renderStats();
      updateSpinButton();
    }, (err) => {
      // Likely the updated rules haven't been published yet — degrade quietly:
      // the app still works for the current event; cross-event blocking is off
      // until `events/<id>/history` becomes readable.
      console.warn("History unavailable (publish database.rules.json?):", err.message);
    });
    onValue(ref(db, "admin/owner"), (snap) => {
      adminOwnerKey = snap.val() || null;
      refreshAdminUI();
    }, (err) => {
      console.warn("Admin owner unavailable (publish database.rules.json?):", err.message);
    });
    onValue(ref(db, "cardImages"), (snap) => {
      applyCardImages(snap.val());
    }, (err) => {
      console.warn("Card-art overrides unavailable (publish database.rules.json?):", err.message);
    });
    onValue(ref(db, "cardImagesStaged"), (snap) => {
      applyCardImageStaged(snap.val());
    }, (err) => {
      console.warn("Staged card-art unavailable (publish database.rules.json?):", err.message);
    });
    onValue(ref(db, "cardMeta"), (snap) => {
      applyCardMeta(snap.val());
    }, (err) => {
      console.warn("Partner overrides unavailable (publish database.rules.json?):", err.message);
    });
    onValue(ref(db, "customCards"), (snap) => {
      applyCustomCards(snap.val());
    }, (err) => {
      console.warn("Custom cards unavailable (publish database.rules.json?):", err.message);
    });
    onValue(ref(db, "cardStatus"), (snap) => {
      applyCardStatus(snap.val());
    }, (err) => {
      console.warn("Card status unavailable (publish database.rules.json?):", err.message);
    });
    return true;
  } catch (e) {
    setStatus("✖ Firebase init failed: " + e.message, "err");
    return false;
  }
}

function recomputeUsed() {
  usedSingles = new Set();
  usedCombos = new Set();
  usedDiscords = new Set();
  for (const id in assignments) {
    const a = assignments[id];
    if (a.type === "single") usedSingles.add(a.name);
    else if (a.type === "partner") usedCombos.add(comboKey(a.partnerA, a.partnerB));
    if (a.discord) usedDiscords.add(a.discord.toLowerCase());
  }
}

// ─────────────────────────── Pool helpers ─────────────────────────
// The wheel filter. Returns the sets of singles / combos that are NOT
// rollable right now: pool-wide claimed ones always, plus — when scope is
// "personal" and someone is logged in — that player's own past results
// (per-exact-result, accumulated by "Store event & reset pool"). The logged-out
// view falls through to pool-wide-only; guest rolls use "all" (nothing filtered).
function blocked() {
  // Guest rolls ("all"): nothing is filtered — the whole commander list /
  // every partner combo is in play, even ones already claimed (just for fun).
  if (scope === "all") return { s: new Set(), c: new Set() };
  const s = new Set(usedSingles);
  const c = new Set(usedCombos);
  if (scope === "personal" && currentUser) {
    const h = historyMirror[currentUser.key] || {};
    for (const v of Object.values(h.singles || {})) s.add(v);
    for (const v of Object.values(h.combos || {})) c.add(v);
  }
  return { s, c };
}

const availableSingles = (b) => SINGLES.filter((c) => !b.s.has(c.name));

function comboOpen(b, a, x) { return !sameCommander(a, x) && !b.c.has(comboKey(a, x)); }

// partner cards that still have at least one open combo with another partner
function partnersInPlay(b) {
  return PARTNERS.filter((x) =>
    PARTNERS.some((y) => y.name !== x.name && comboOpen(b, x.name, y.name)));
}

function openComboCount(b) {
  let n = 0;
  for (let i = 0; i < PARTNERS.length; i++)
    for (let j = i + 1; j < PARTNERS.length; j++)
      if (comboOpen(b, PARTNERS[i].name, PARTNERS[j].name)) n++;
  return n;
}

function partnerSliceWeight(b) {
  if (openComboCount(b) === 0) return 0;
  if (PARTNER_ODDS === "cards") return partnersInPlay(b).length;
  if (PARTNER_ODDS === "combos") return openComboCount(b);
  const n = Number(PARTNER_ODDS);
  if (n > 0 && n < 1) {
    // dynamic ratio: pw / (singles + pw) = n  →  pw = singles × n/(1-n)
    return availableSingles(b).length * (n / (1 - n));
  }
  return n || 0;
}

// ───────────────────────────── Wheel ──────────────────────────────
class Wheel {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.wedges = [];
    this.rotation = 0;
    this.spinning = false;
  }
  setWedges(wedges) { this.wedges = wedges; this.draw(); }

  draw() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const cx = W / 2, cy = H / 2, r = Math.min(cx, cy) - 6;
    ctx.clearRect(0, 0, W, H);
    const total = this.wedges.reduce((s, w) => s + w.weight, 0) || 1;
    let a = 0;
    for (const w of this.wedges) {
      const ang = (w.weight / total) * Math.PI * 2;
      const a0 = a + this.rotation, a1 = a0 + ang;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a0, a1);
      ctx.closePath();
      ctx.fillStyle = w.color;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 1;
      ctx.stroke();
      // label
      const mid = a0 + ang / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(mid);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillStyle = w.kind === "partner" ? "#3a2400" : "#0b1722";
      const fs = Math.max(8, Math.min(15, ang * r * 0.5));
      ctx.font = `${w.kind === "partner" ? "700 " : "600 "}${fs}px system-ui, sans-serif`;
      let label = w.label;
      const maxChars = Math.max(6, Math.floor((r - 18) / (fs * 0.52)));
      if (label.length > maxChars) label = label.slice(0, maxChars - 1) + "…";
      ctx.fillText(label, r - 12, 0);
      ctx.restore();
      a += ang;
    }
    // hub
    ctx.beginPath();
    ctx.arc(cx, cy, 26, 0, Math.PI * 2);
    ctx.fillStyle = "#0b1722";
    ctx.fill();
    ctx.strokeStyle = "#e7c14a";
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // pick a wedge index by weight
  pickIndex() {
    const total = this.wedges.reduce((s, w) => s + w.weight, 0);
    let r = Math.random() * total;
    for (let i = 0; i < this.wedges.length; i++) {
      r -= this.wedges[i].weight;
      if (r <= 0) return i;
    }
    return this.wedges.length - 1;
  }

  spin() {
    return new Promise((resolve) => {
      if (this.spinning || this.wedges.length === 0) return resolve(null);
      this.spinning = true;
      const idx = this.pickIndex();
      const total = this.wedges.reduce((s, w) => s + w.weight, 0);
      // mid angle (wedge-local) of the chosen wedge
      let acc = 0;
      for (let i = 0; i < idx; i++) acc += (this.wedges[i].weight / total) * Math.PI * 2;
      const ang = (this.wedges[idx].weight / total) * Math.PI * 2;
      const mid = acc + ang / 2;
      const TWO = Math.PI * 2;
      const desired = (((-Math.PI / 2 - mid) % TWO) + TWO) % TWO; // pointer at top
      const start = this.rotation;
      const currentMod = ((start % TWO) + TWO) % TWO;
      let delta = desired - currentMod;
      if (delta < 0) delta += TWO;
      const end = start + delta + 5 * TWO; // 5 full spins
      const dur = 4600;
      const t0 = performance.now();
      const ease = (t) => 1 - Math.pow(1 - t, 4);
      const step = (now) => {
        const p = Math.min(1, (now - t0) / dur);
        this.rotation = start + (end - start) * ease(p);
        this.draw();
        if (p < 1) requestAnimationFrame(step);
        else { this.spinning = false; resolve(this.wedges[idx]); }
      };
      requestAnimationFrame(step);
    });
  }
}

// ──────────────────────────── Wheel building ──────────────────────
const SINGLE_COLORS = ["#7fc7d9", "#a7d8a0", "#f3d27a", "#d9a7c7", "#c7b8f0", "#f0b89b"];
const PARTNER_COLOR = "#e7c14a";

function interleave(singles, partnerWedges) {
  if (partnerWedges.length === 0) return singles;
  if (singles.length === 0) return partnerWedges;
  const out = [];
  const gap = Math.max(1, Math.floor(singles.length / partnerWedges.length));
  let pi = 0;
  for (let i = 0; i < singles.length; i++) {
    out.push(singles[i]);
    if (pi < partnerWedges.length && (i + 1) % gap === 0) out.push(partnerWedges[pi++]);
  }
  while (pi < partnerWedges.length) out.push(partnerWedges[pi++]);
  return out;
}

function buildMainWheel() {
  const b = blocked();
  const singles = availableSingles(b).map((c, i) => ({
    label: c.name, weight: 1, kind: "single", payload: c,
    color: SINGLE_COLORS[i % SINGLE_COLORS.length],
  }));
  const pw = partnerSliceWeight(b);
  let partnerWedges = [];
  if (pw > 0) {
    const spread = Math.min(8, Math.max(2, Math.round(pw / 4)));
    const each = pw / spread;
    partnerWedges = Array.from({ length: spread }, () => ({
      label: "PARTNER", weight: each, kind: "partner", payload: null, color: PARTNER_COLOR,
    }));
  }
  wheel.setWedges(interleave(singles, partnerWedges));
  setWheelTitle("Main Wheel");
}

function buildPartnerWheel(excludeName) {
  const b = blocked();
  let list;
  if (!excludeName) {
    list = partnersInPlay(b);
    setWheelTitle("Partner Wheel — spin for your FIRST partner");
  } else {
    list = PARTNERS.filter((y) => y.name !== excludeName && comboOpen(b, excludeName, y.name));
    setWheelTitle(`Partner Wheel — first: ${excludeName} — spin for your SECOND`);
  }
  wheel.setWedges(list.map((c, i) => ({
    label: c.name, weight: 1, kind: "psingle", payload: c,
    color: i % 2 ? "#a7d8a0" : "#7fc7d9",
  })));
  return list.length;
}

// ─────────────────────────── Commit (transaction) ─────────────────
function commit(entry, isFree) {
  // Local preview mode (no Firebase): just stash in memory.
  if (!firebaseReady) {
    const id = "local-" + Object.keys(assignments).length;
    assignments[id] = entry;
    recomputeUsed(); renderResults(); renderStats();
    return Promise.resolve({ committed: true });
  }
  const newRef = push(assignmentsRef);
  const key = newRef.key;
  return runTransaction(assignmentsRef, (current) => {
    current = current || {};
    // rebuild used sets from the freshest server data
    const uS = new Set(), uC = new Set(), uD = new Set();
    for (const id in current) {
      const a = current[id];
      if (a.type === "single") uS.add(a.name);
      else if (a.type === "partner") uC.add(comboKey(a.partnerA, a.partnerB));
      if (a.discord) uD.add(a.discord.toLowerCase());
    }
    if (!isFree(uS, uC, uD)) return; // abort — commander or discord already taken
    current[key] = entry;
    return current;
  }).then((res) => ({ committed: res.committed }));
}

// ──────────────────────────────── UI ──────────────────────────────
const $ = (id) => document.getElementById(id);
let wheel;
let phase = "main";   // main | partner1 | partner2
let partnerA = null;
let isAdmin = false;

function setStatus(msg, kind) {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + (kind || "");
}
function setWheelTitle(t) { $("wheelTitle").textContent = t; }
function showResult(html, kind) {
  const el = $("result");
  el.innerHTML = html;
  el.className = "result show " + (kind || "");
}

function updateSpinButton() {
  const spin = $("spinBtn");
  const guest = $("guestBtn");
  // Guest Spin can only START a fresh roll — not continue a partner sequence.
  guest.disabled = wheel.spinning || phase !== "main";
  if (phase === "main") {
    if (!currentUser) {
      spin.disabled = true;
      spin.textContent = "Log in to spin";
    } else {
      const b = blocked();
      const done = availableSingles(b).length === 0 && partnerSliceWeight(b) === 0;
      spin.disabled = done || wheel.spinning;
      spin.textContent = done ? "Nothing left for you 🎉" : "SPIN";
    }
  } else if (phase === "partner1") {
    spin.disabled = wheel.spinning;
    spin.textContent = "Spin for Partner 1";
  } else if (phase === "partner2") {
    spin.disabled = wheel.spinning;
    spin.textContent = "Spin for Partner 2";
  }
}

async function onSpin() {
  if (wheel.spinning) return;
  const guest = guestSeq;
  if (!guest && !currentUser) {
    setAuthMsg("Log in to spin — or hit Guest Spin to roll just for fun.", "err");
    return;
  }
  const name = guest ? null : currentUser.username;
  $("spinBtn").disabled = true;
  $("guestBtn").disabled = true;

  if (phase === "main") {
    buildMainWheel();
    const w = await wheel.spin();
    if (!w) { endSequence(); return; }
    if (w.kind === "single") {
      const c = w.payload;
      const flip = c.back ? ` <span class="flip">// ${escapeHtml(c.back)}</span>` : "";
      if (guest) {
        showResult(`<div class="cards">${cardsForName(c.name, "big")}</div>` +
          `🎲 Guest roll: <b>${escapeHtml(c.name)}</b>${flip} <span class="muted">— not saved</span>`, "guest");
        endSequence();
        return;
      }
      const ok = await commit(
        { discord: name, uid: currentUser.key, type: "single", name: c.name, back: c.back || null, ts: Date.now() },
        (uS, uC, uD) => !uS.has(c.name) && !uD.has(name.toLowerCase()),
      );
      if (ok.committed) {
        showResult(`<div class="cards">${cardsForName(c.name, "big")}</div>` +
          `🎴 <b>${escapeHtml(name)}</b> got <b>${escapeHtml(c.name)}</b>${flip}`, "ok");
      } else {
        showResult(`😬 <b>${escapeHtml(c.name)}</b> was just taken (or you already have a commander this event). Spin again!`, "err");
      }
      endSequence();
    } else { // partner slice
      phase = "partner1";
      partnerA = null;
      const n = buildPartnerWheel(null);
      showResult(`🤝 <b>PARTNER!</b> The partner wheel is loaded (${n} options). Spin again for your first partner.`, "partner");
      updateSpinButton();
    }
    return;
  }

  if (phase === "partner1") {
    buildPartnerWheel(null);
    const w = await wheel.spin();
    if (!w) { endSequence(); return; }
    partnerA = w.payload.name;
    phase = "partner2";
    const n = buildPartnerWheel(partnerA);
    if (n === 0) {
      showResult(`All combos for <b>${escapeHtml(partnerA)}</b> are taken — spinning for a new first partner.`, "err");
      phase = "partner1"; partnerA = null; buildPartnerWheel(null);
    } else {
      showResult(`<div class="cards">${cardsForName(partnerA, "big")}</div>` +
        `First partner: <b>${escapeHtml(partnerA)}</b>. Spin again for your second (${n} options).`, "partner");
    }
    updateSpinButton();
    return;
  }

  if (phase === "partner2") {
    buildPartnerWheel(partnerA);
    const w = await wheel.spin();
    if (!w) { endSequence(); return; }
    const b = w.payload.name;
    if (guest) {
      showResult(`<div class="cards">${cardsForName(partnerA, "big")}${cardsForName(b, "big")}</div>` +
        `🎲 Guest roll: <b>${escapeHtml(partnerA)}</b> + <b>${escapeHtml(b)}</b> <span class="muted">— not saved</span>`, "guest");
      endSequence();
      return;
    }
    const ok = await commit(
      { discord: name, uid: currentUser.key, type: "partner", partnerA, partnerB: b, ts: Date.now() },
      (uS, uC, uD) => !uC.has(comboKey(partnerA, b)) && !uD.has(name.toLowerCase()),
    );
    if (ok.committed) {
      showResult(`<div class="cards">${cardsForName(partnerA, "big")}${cardsForName(b, "big")}</div>` +
        `🤝 <b>${escapeHtml(name)}</b> got <b>${escapeHtml(partnerA)}</b> + <b>${escapeHtml(b)}</b>`, "ok");
      endSequence();
    } else {
      showResult(`😬 <b>${escapeHtml(partnerA)} + ${escapeHtml(b)}</b> was just taken. Spinning again for partner two.`, "err");
      phase = "partner2";
      buildPartnerWheel(partnerA);
      updateSpinButton();
    }
    return;
  }
}

// End the current spin sequence and return to a fresh personal main wheel.
function endSequence() {
  guestSeq = false;
  scope = "personal";
  resetToMain();
}

function resetToMain() {
  phase = "main";
  partnerA = null;
  buildMainWheel();
  updateSpinButton();
}

// ──────────────────────────── Rendering ───────────────────────────
function renderStats() {
  const b = blocked();
  const s = availableSingles(b).length;
  const c = openComboCount(b);
  const mine = (scope === "personal" && currentUser) ? " for you" : "";
  $("stats").innerHTML =
    `<span>${s}</span> single commanders left${mine} &nbsp;•&nbsp; <span>${c}</span> partner combos open${mine}`;
}

function renderResults() {
  const list = Object.entries(assignments).sort(([, a], [, b]) => (b.ts || 0) - (a.ts || 0));
  $("resultsCount").textContent = list.length;
  if (list.length === 0) {
    $("results").innerHTML = `<li class="empty">No assignments yet — be the first to spin!</li>`;
    return;
  }
  const removeBtn = (key) => isAdmin
    ? `<button class="reroll-btn" data-key="${key}" title="Re-roll — frees this result so they can spin again">↻</button>` +
      `<button class="remove-btn" data-key="${key}" title="Remove assignment">✕</button>`
    : "";
  $("results").innerHTML = list.map(([key, a]) => {
    const whoHtml = `<span class="who">${escapeHtml(a.discord || "?")}${isAdmin ? acctBadge(a.discord) : ""}</span>`;
    if (a.type === "single") {
      const flip = a.back ? `<span class="flip"> // ${escapeHtml(a.back)}</span>` : "";
      return `<li><div class="thumbs">${cardsForName(a.name, "thumb")}</div>` +
        `<div class="info">${whoHtml}` +
        `<span class="got">${escapeHtml(a.name)}${flip}</span></div>${removeBtn(key)}</li>`;
    }
    return `<li><div class="thumbs">${cardsForName(a.partnerA, "thumb")}${cardsForName(a.partnerB, "thumb")}</div>` +
      `<div class="info">${whoHtml}` +
      `<span class="got partner">${escapeHtml(a.partnerA)} <b>+</b> ${escapeHtml(a.partnerB)}</span></div>${removeBtn(key)}</li>`;
  }).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// Admin-only badge: does a registered account exist for this assignment's name?
// (Identity is the normalized name, so an unregistered result will attach
// itself automatically once that person registers with the same username.)
function acctBadge(discord) {
  const has = registeredKeys.has(userKey(discord || ""));
  return has
    ? `<span class="acct yes" title="A registered account exists for this name">✓ account</span>`
    : `<span class="acct no" title="No account yet — this result attaches automatically when they register with this name">no account</span>`;
}

// ──────────────────────────── Accounts ────────────────────────────
// Lightweight, server-less auth for a playgroup: register/log in with a
// Discord username (free text) + password. Passwords are hashed in the
// browser with PBKDF2-SHA256 (WebCrypto) + a unique salt; we store only the
// hash. This is "good enough for a Discord draft", NOT bank-grade — under the
// open database rules the hashes are readable, so it deters casual snooping
// rather than a determined attacker. See README for the limitations.
const PBKDF2_ITER = 150000;
const LS_USERS = "cw_users";       // local-preview account store (no Firebase)
const LS_SESSION = "cw_session";   // persisted "stay logged in" pointer (never the password)

const bytesToHex = (bytes) => Array.from(bytes).map((x) => x.toString(16).padStart(2, "0")).join("");
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function randomSaltHex() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return bytesToHex(b);
}
async function hashPassword(password, saltHex, iterations) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: hexToBytes(saltHex), iterations, hash: "SHA-256" },
    keyMaterial, 256);
  return bytesToHex(new Uint8Array(bits));
}
// constant-time-ish hex compare (avoid leaking match length via early-exit)
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

function localUsers() {
  try { return JSON.parse(localStorage.getItem(LS_USERS) || "{}"); }
  catch { return {}; }
}
// Account storage lives in Firebase when configured, else in localStorage so
// the whole feature is testable offline (local-preview mode).
async function readUser(key) {
  if (db) {
    const snap = await get(ref(db, `users/${key}`));
    return snap.exists() ? snap.val() : null;
  }
  return localUsers()[key] || null;
}
async function writeNewUser(key, record) {
  if (db) {
    // Create-only: abort if the username already exists (no overwrite/hijack).
    const res = await runTransaction(ref(db, `users/${key}`), (cur) => (cur ? undefined : record));
    return res.committed;
  }
  const users = localUsers();
  if (users[key]) return false;
  users[key] = record;
  localStorage.setItem(LS_USERS, JSON.stringify(users));
  return true;
}

function setAuthMsg(msg, kind) {
  const el = $("authMsg");
  el.textContent = msg || "";
  el.className = "auth-msg " + (kind || "");
}
function renderAuth() {
  if (currentUser) {
    $("authLoggedOut").style.display = "none";
    $("authLoggedIn").style.display = "flex";
    $("whoami").textContent = currentUser.username;
  } else {
    $("authLoggedOut").style.display = "flex";
    $("authLoggedIn").style.display = "none";
  }
}

async function register() {
  const username = $("authUser").value.trim();
  const pw = $("authPass").value;
  if (!username) return setAuthMsg("Enter a Discord username.", "err");
  if (pw.length < 4) return setAuthMsg("Password must be at least 4 characters.", "err");
  if (!window.crypto || !crypto.subtle) {
    return setAuthMsg("Secure crypto unavailable — open the site over https or localhost.", "err");
  }
  const key = userKey(username);
  setAuthMsg("Creating account…", "");
  try {
    if (await readUser(key)) return setAuthMsg("That username is taken — try logging in instead.", "err");
    const salt = randomSaltHex();
    const hash = await hashPassword(pw, salt, PBKDF2_ITER);
    const created = await writeNewUser(key, { username, salt, hash, iterations: PBKDF2_ITER, createdTs: Date.now() });
    if (!created) return setAuthMsg("That username was just taken — try logging in.", "err");
    finishLogin(username, key);
    setAuthMsg("Account created — you're logged in.", "ok");
  } catch (e) {
    setAuthMsg("Registration failed: " + e.message, "err");
  }
}

async function login() {
  const username = $("authUser").value.trim();
  const pw = $("authPass").value;
  if (!username) return setAuthMsg("Enter your Discord username.", "err");
  if (!pw) return setAuthMsg("Enter your password.", "err");
  const key = userKey(username);
  setAuthMsg("Logging in…", "");
  try {
    const rec = await readUser(key);
    if (!rec) return setAuthMsg("No account with that username — register first.", "err");
    const hash = await hashPassword(pw, rec.salt, rec.iterations || PBKDF2_ITER);
    if (!safeEqual(hash, rec.hash)) return setAuthMsg("Wrong password.", "err");
    finishLogin(rec.username || username, key);
    setAuthMsg("", "");
  } catch (e) {
    setAuthMsg("Login failed: " + e.message, "err");
  }
}

// Session persistence. We store only the identity pointer {username, key},
// never the password. "Remember me" → localStorage (survives a browser
// restart). Unchecked → sessionStorage (cleared when the tab/browser closes),
// for shared computers.
function saveSession(remember) {
  const data = JSON.stringify(currentUser);
  try {
    if (remember) { localStorage.setItem(LS_SESSION, data); sessionStorage.removeItem(LS_SESSION); }
    else { sessionStorage.setItem(LS_SESSION, data); localStorage.removeItem(LS_SESSION); }
  } catch { /* ignore */ }
}
function clearSession() {
  try { localStorage.removeItem(LS_SESSION); sessionStorage.removeItem(LS_SESSION); } catch { /* ignore */ }
}
function loadSession() {
  try {
    const raw = localStorage.getItem(LS_SESSION) || sessionStorage.getItem(LS_SESSION);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function finishLogin(username, key) {
  currentUser = { username, key };
  const remember = $("authRemember") ? $("authRemember").checked : true;
  saveSession(remember);
  $("authPass").value = "";
  renderAuth();
  endSequence();        // rebuild a fresh personal wheel for this account
  renderStats();
  refreshAdminUI();     // admin tools appear if this is the owner account
}

function logout() {
  currentUser = null;
  clearSession();
  renderAuth();
  setAuthMsg("", "");
  endSequence();
  renderStats();
  refreshAdminUI();     // hide admin tools
}

function restoreSession() {
  const s = loadSession();
  if (s && s.username && s.key) currentUser = s;
  renderAuth();
}

// ───────────────────────────── Admin ──────────────────────────────
async function deleteAssignment(key) {
  if (!firebaseReady) {
    delete assignments[key];
    recomputeUsed(); renderResults(); renderStats();
    if (phase === "main" && !wheel.spinning) buildMainWheel();
    if (isAdmin) populateManualOptions();
    return;
  }
  await remove(ref(db, `events/${EVENT_ID}/assignments/${key}`));
  // onValue re-fires and updates everything
}

async function removeAssignment(key) {
  const e = assignments[key];
  if (!e) return;
  if (!confirm(`Remove ${e.discord}'s assignment?`)) return;
  await deleteAssignment(key);
}

async function reRoll(key) {
  const e = assignments[key];
  if (!e) return;
  const what = e.type === "single" ? e.name : `${e.partnerA} + ${e.partnerB}`;
  if (!confirm(`Re-roll ${e.discord}? This frees ${what} back to the pool so they can spin again.`)) return;
  await deleteAssignment(key);
}

// Archive the current event, fold each result into that player's per-exact
// history (so they can't re-roll it), then clear assignments to refill the pool.
async function storeEventAndReset() {
  const entries = Object.entries(assignments);
  // Staged roster changes ride along on store-event, so a roster-only rotation
  // still applies even when there are no results to archive.
  const staged = Object.entries(cardStatusOverrides)
    .filter(([, s]) => s && (s.state === "pending" || s.state === "pendingRemoval"));
  // Staged art changes publish on the same rotation (each entry may stage a front
  // and/or a back face).
  const stagedArt = Object.entries(cardImageStaged)
    .filter(([, v]) => v && (typeof v.img === "string" || typeof v.backImg === "string"));
  if (entries.length === 0 && staged.length === 0 && stagedArt.length === 0) {
    return alert("Nothing to store — no results and no staged roster or art changes.");
  }

  const pendCount = staged.filter(([, s]) => s.state === "pending").length;
  const remCount = staged.filter(([, s]) => s.state === "pendingRemoval").length;
  const parts = [];
  if (entries.length) parts.push(`store ${entries.length} result(s) and reset the pool`);
  if (pendCount) parts.push(`publish ${pendCount} future upload(s)`);
  if (remCount) parts.push(`remove ${remCount} commander(s)`);
  if (stagedArt.length) parts.push(`apply ${stagedArt.length} art change(s)`);
  const detail = entries.length
    ? "\n\nAll commanders return to the pool, but each player keeps their stored result and can't roll that exact result again."
    : "";
  if (!confirm(`This will ${parts.join(", ")}.${detail}`)) return;

  const ts = Date.now(), by = byName();

  if (!firebaseReady) {
    if (entries.length) {
      for (const [, a] of entries) foldIntoHistory(historyMirror, a);
      assignments = {};
    }
    const s = readLocalCardStatus();
    for (const [enc, st] of staged) {
      if (st.state === "pending") delete s[enc];
      else if (st.state === "pendingRemoval") s[enc] = { state: "hidden", ts, by };
    }
    writeLocalCardStatus(s); cardStatusOverrides = s;
    if (stagedArt.length) {
      const im = readLocalCardImages();
      for (const [enc, v] of stagedArt) {
        im[enc] = { ...(im[enc] || {}) };
        if (typeof v.img === "string") im[enc].img = v.img;
        if (typeof v.backImg === "string") im[enc].backImg = v.backImg;
        im[enc].ts = ts; im[enc].by = by;
      }
      writeLocalCardImages(im); cardImageOverrides = im;
      writeLocalCardImageStaged({}); cardImageStaged = {};
    }
    rebuildCommanders();
    recomputeUsed(); renderResults(); renderStats(); endSequence();
    if (isAdmin) { populateManualOptions(); if (!adminCollapsed) renderCardArtGrid(); }
    return;
  }

  // One atomic root update: archive + history fold + pool reset + roster
  // transitions all commit together, so staged changes go live exactly when the
  // pool resets. Paths are fully-qualified from the root because cardStatus is a
  // top-level node, not under events/<id>.
  const updates = {};
  if (entries.length) {
    const snapId = push(ref(db, `events/${EVENT_ID}/archives`)).key;
    updates[`events/${EVENT_ID}/archives/${snapId}`] = { ts, assignments: Object.fromEntries(entries) };
    for (const [, a] of entries) {
      const k = userKey(a.discord || "");
      if (!k) continue;
      if (a.type === "single") {
        updates[`events/${EVENT_ID}/history/${k}/singles/${encKey(a.name)}`] = a.name;
      } else if (a.type === "partner") {
        const ck = comboKey(a.partnerA, a.partnerB);
        updates[`events/${EVENT_ID}/history/${k}/combos/${encKey(ck)}`] = ck;
      }
    }
    updates[`events/${EVENT_ID}/assignments`] = null;
  }
  for (const [enc, st] of staged) {
    if (st.state === "pending") updates[`cardStatus/${enc}`] = null;             // future upload → active
    else if (st.state === "pendingRemoval") updates[`cardStatus/${enc}`] = { state: "hidden", ts, by }; // future removal → retired
  }
  for (const [enc, v] of stagedArt) {
    if (typeof v.img === "string") updates[`cardImages/${enc}/img`] = v.img;      // staged art → live
    if (typeof v.backImg === "string") updates[`cardImages/${enc}/backImg`] = v.backImg;
    updates[`cardImages/${enc}/ts`] = ts;
    updates[`cardImages/${enc}/by`] = by;
    updates[`cardImagesStaged/${enc}`] = null;                                    // clear the stage
  }
  await update(ref(db), updates);
  endSequence();
}

// Mirror of the store-event fold, for local-preview mode.
function foldIntoHistory(mirror, a) {
  const k = userKey(a.discord || "");
  if (!k) return;
  const h = mirror[k] || (mirror[k] = { singles: {}, combos: {} });
  if (a.type === "single") {
    (h.singles || (h.singles = {}))[encKey(a.name)] = a.name;
  } else if (a.type === "partner") {
    const ck = comboKey(a.partnerA, a.partnerB);
    (h.combos || (h.combos = {}))[encKey(ck)] = ck;
  }
}

function setMaMsg(msg, kind) {
  const el = $("maMsg");
  el.textContent = msg || "";
  el.className = "auth-msg " + (kind || "");
}

// Manually assign a commander to a username (admin). Validates the
// commander/combo is still free, but does NOT require the player to be
// account-less or commander-less — handy for re-attaching existing results.
async function manualAssign() {
  const username = $("maUser").value.trim();
  if (!username) return setMaMsg("Enter a username.", "err");
  const type = $("maType").value;
  if (type === "single") {
    const cName = $("maA").value;
    if (!cName) return setMaMsg("Pick a commander.", "err");
    if (usedSingles.has(cName)) return setMaMsg(`${cName} is already taken.`, "err");
    const c = NAME_MAP.get(cName);
    const ok = await commit(
      { discord: username, uid: userKey(username), type: "single", name: cName, back: (c && c.back) || null, ts: Date.now() },
      (uS) => !uS.has(cName),
    );
    setMaMsg(ok.committed ? `Assigned ${cName} to ${username}.` : `${cName} was just taken.`, ok.committed ? "ok" : "err");
  } else {
    const a = $("maA").value, b = $("maB").value;
    if (!a || !b) return setMaMsg("Pick both partners.", "err");
    if (a === b) return setMaMsg("Pick two different partners.", "err");
    if (sameCommander(a, b)) return setMaMsg(`${a} and ${b} are color variants of the same commander — pick two different ones.`, "err");
    if (usedCombos.has(comboKey(a, b))) return setMaMsg(`${a} + ${b} is already taken.`, "err");
    const ok = await commit(
      { discord: username, uid: userKey(username), type: "partner", partnerA: a, partnerB: b, ts: Date.now() },
      (uS, uC) => !uC.has(comboKey(a, b)),
    );
    setMaMsg(ok.committed ? `Assigned ${a} + ${b} to ${username}.` : `${a} + ${b} was just taken.`, ok.committed ? "ok" : "err");
  }
  if (firebaseReady) await new Promise((r) => setTimeout(r, 50)); // let onValue settle
  populateManualOptions();
}

// Fill the manual-assign dropdowns from the pool-wide available list.
function populateManualOptions() {
  const type = $("maType") ? $("maType").value : "single";
  const b = { s: usedSingles, c: usedCombos };
  const opt = (v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`;
  if (type === "single") {
    $("maB").style.display = "none";
    $("maA").innerHTML = `<option value="">— pick a commander —</option>` +
      availableSingles(b).map((c) => opt(c.name)).join("");
  } else {
    $("maB").style.display = "";
    const ps = PARTNERS.map((c) => c.name).sort();
    $("maA").innerHTML = `<option value="">— first partner —</option>` + ps.map(opt).join("");
    $("maB").innerHTML = `<option value="">— second partner —</option>` + ps.map(opt).join("");
  }
}

async function refreshUserList() {
  let users = {};
  if (db) { try { const snap = await get(usersRef); users = snap.val() || {}; } catch { /* ignore */ } }
  else { users = localUsers(); }
  registeredKeys = new Set(Object.keys(users));   // node keys are userKeys
  const names = Object.values(users).map((u) => u && u.username).filter(Boolean).sort();
  $("userList").innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("");
  renderResults();   // reflect account badges once the list has loaded
}

// ─────────────────────── Card-art admin ──────────────────────────
// Admin-only tools to re-point card art at Drive files: per-card (drop/paste a
// Drive link) and bulk (scan a Drive folder or paste a name→id list, review the
// diff, apply). Writes go to `cardImages/<encKey(name)>` (or localStorage in
// local-preview); the onValue listener merges them back over COMMANDERS.
let bulkMatches = [];   // last-parsed bulk import rows, indexed by review checkbox

const byName = () => (currentUser && currentUser.username) || "admin";
function setCaMsg(msg, kind) {
  const el = $("caMsg");
  if (el) { el.textContent = msg; el.className = "auth-msg " + (kind || ""); }
}
function readLocalCardImages() { try { return JSON.parse(localStorage.getItem(LS_CARDIMG) || "{}") || {}; } catch { return {}; } }
function writeLocalCardImages(o) { try { localStorage.setItem(LS_CARDIMG, JSON.stringify(o)); } catch { /* ignore */ } }
function readLocalCardImageStaged() { try { return JSON.parse(localStorage.getItem(LS_CARDIMG_STAGED) || "{}") || {}; } catch { return {}; } }
function writeLocalCardImageStaged(o) { try { localStorage.setItem(LS_CARDIMG_STAGED, JSON.stringify(o)); } catch { /* ignore */ } }
function readLocalCardMeta() { try { return JSON.parse(localStorage.getItem(LS_CARDMETA) || "{}") || {}; } catch { return {}; } }
function writeLocalCardMeta(o) { try { localStorage.setItem(LS_CARDMETA, JSON.stringify(o)); } catch { /* ignore */ } }
function readLocalCustomCards() { try { return JSON.parse(localStorage.getItem(LS_CUSTOMCARDS) || "{}") || {}; } catch { return {}; } }
function writeLocalCustomCards(o) { try { localStorage.setItem(LS_CUSTOMCARDS, JSON.stringify(o)); } catch { /* ignore */ } }
function readLocalCardStatus() { try { return JSON.parse(localStorage.getItem(LS_CARDSTATUS) || "{}") || {}; } catch { return {}; } }
function writeLocalCardStatus(o) { try { localStorage.setItem(LS_CARDSTATUS, JSON.stringify(o)); } catch { /* ignore */ } }

// Write one face override for a commander (Firebase, or localStorage offline).
async function writeCardOverride(name, face, id) {
  const enc = encKey(name);
  if (db) {
    await update(ref(db, "cardImages/" + enc), { [face]: id, ts: Date.now(), by: byName() });
  } else {
    const store = readLocalCardImages();
    store[enc] = { ...(store[enc] || {}), [face]: id, ts: Date.now(), by: byName() };
    writeLocalCardImages(store);
    applyCardImages(store);
  }
}

// Set a face's art from a pasted/dropped Drive link, URL, or bare ID — live for
// everyone immediately. Any staged change to the same face is now moot, so drop it.
async function setFaceOverride(name, face, rawInput) {
  const id = extractDriveId(rawInput);
  if (!id) return setCaMsg("Couldn't find a Drive ID in that — paste a share link or the file ID.", "err");
  try {
    await writeCardOverride(name, face, id);
    if (hasStagedFace(name, face)) await clearStagedFace(name, face);
    setCaMsg(`Updated ${name} (${face === "img" ? "front" : "back"}) — live for everyone.`, "ok");
  } catch (e) { setCaMsg("Write failed: " + e.message + " (publish database.rules.json?)", "err"); }
}

// ── Staged card-art changes (request A) ──
// A staged face lives at cardImagesStaged/<enc>/<face>: an admin-only preview that
// never reaches players or the gallery. storeEventAndReset() folds it into
// cardImages (live for everyone) on the next Store-event — mirroring how staged
// add/remove ride along on the same rotation. "Set now" bypasses staging entirely.
const hasStagedFace = (name, face) => {
  const st = cardImageStaged[encKey(name)];
  return !!(st && typeof st[face] === "string");
};

// Stage a face's art for the next Store-event (does NOT change what players see).
async function stageFaceOverride(name, face, rawInput) {
  const id = extractDriveId(rawInput);
  if (!id) return setCaMsg("Couldn't find a Drive ID in that — paste a share link or the file ID.", "err");
  const enc = encKey(name);
  try {
    if (db) {
      await update(ref(db, "cardImagesStaged/" + enc), { [face]: id, ts: Date.now(), by: byName() });
    } else {
      const s = readLocalCardImageStaged();
      s[enc] = { ...(s[enc] || {}), [face]: id, ts: Date.now(), by: byName() };
      writeLocalCardImageStaged(s); applyCardImageStaged(s);
    }
    setCaMsg(`Staged ${name} (${face === "img" ? "front" : "back"}) — goes live on the next “Store event & reset pool”.`, "ok");
  } catch (e) { setCaMsg("Stage failed: " + e.message + " (publish database.rules.json?)", "err"); }
}

// Drop a staged face (dropping the whole node if neither face is staged, since a
// node with neither img nor backImg would fail the rules' validation). Shared by
// discard, publish, and "Set now".
async function clearStagedFace(name, face) {
  const enc = encKey(name);
  const other = face === "img" ? "backImg" : "img";
  if (db) {
    const cur = (await get(ref(db, "cardImagesStaged/" + enc))).val() || {};
    if (typeof cur[other] === "string") await update(ref(db, "cardImagesStaged/" + enc), { [face]: null, ts: Date.now(), by: byName() });
    else await remove(ref(db, "cardImagesStaged/" + enc));
  } else {
    const s = readLocalCardImageStaged();
    if (s[enc]) { delete s[enc][face]; if (!s[enc].img && !s[enc].backImg) delete s[enc]; }
    writeLocalCardImageStaged(s); applyCardImageStaged(s);
  }
}

// Publish a staged face right now: move it into cardImages (live) and clear the stage.
async function publishStagedFace(name, face) {
  const st = cardImageStaged[encKey(name)];
  const id = st && typeof st[face] === "string" ? st[face] : null;
  if (!id) return;
  try {
    await writeCardOverride(name, face, id);
    await clearStagedFace(name, face);
    setCaMsg(`Published ${name} (${face === "img" ? "front" : "back"}) — now live for everyone.`, "ok");
  } catch (e) { setCaMsg("Publish failed: " + e.message + " (publish database.rules.json?)", "err"); }
}

// Discard a staged face without publishing it (players never saw it, so nothing changes for them).
async function discardStagedFace(name, face) {
  try {
    await clearStagedFace(name, face);
    setCaMsg(`Discarded the staged ${face === "img" ? "front" : "back"} for ${name}.`, "ok");
  } catch (e) { setCaMsg("Discard failed: " + e.message, "err"); }
}

// Remove a face override. If the other face has no override, drop the whole node
// (a node with neither img nor backImg would fail the rules' validation).
async function revertFace(name, face) {
  const enc = encKey(name);
  const other = face === "img" ? "backImg" : "img";
  try {
    if (db) {
      const snap = await get(ref(db, "cardImages/" + enc));
      const cur = snap.val() || {};
      if (typeof cur[other] === "string") {
        await update(ref(db, "cardImages/" + enc), { [face]: null, ts: Date.now(), by: byName() });
      } else {
        await remove(ref(db, "cardImages/" + enc));
      }
    } else {
      const store = readLocalCardImages();
      if (store[enc]) { delete store[enc][face]; if (!store[enc].img && !store[enc].backImg) delete store[enc]; }
      writeLocalCardImages(store);
      applyCardImages(store);
    }
    setCaMsg(`Reverted ${name} (${face === "img" ? "front" : "back"}).`, "ok");
  } catch (e) { setCaMsg("Revert failed: " + e.message, "err"); }
}

// Flip a card's partner status (request B). Stored per-card in cardMeta and
// applied over both shipped and custom cards on rebuild, so the change flows
// straight into PARTNERS, the partner wheel, and the manual-assign dropdowns.
async function setPartnerFlag(name, on) {
  const enc = encKey(name);
  try {
    if (db) {
      await update(ref(db, "cardMeta/" + enc), { partner: !!on, ts: Date.now(), by: byName() });
    } else {
      const store = readLocalCardMeta();
      store[enc] = { ...(store[enc] || {}), partner: !!on, ts: Date.now(), by: byName() };
      writeLocalCardMeta(store);
      applyCardMeta(store);
    }
    setCaMsg(`${name} is ${on ? "now" : "no longer"} a partner.`, "ok");
  } catch (e) { setCaMsg("Partner update failed: " + e.message + " (publish database.rules.json?)", "err"); }
}

// ── Staged roster status (future upload / future removal) ──
// A card's lifecycle state lives in cardStatus/<enc>:
//   "pending"        → future upload: off the wheel + hidden from players
//                      (admin-only), goes live for everyone on the next Store-event.
//   "pendingRemoval" → future removal: still live/rollable now, becomes "hidden"
//                      on the next Store-event.
//   "hidden"         → retired: off the wheel + hidden from players; kept in the
//                      DB so it can be revolved back in via restoreCard().
// Absent = active. The transitions themselves fire in storeEventAndReset();
// these writers just stage the intent (applied over shipped AND custom cards).
async function writeCardStatus(name, state) {
  const enc = encKey(name);
  const ts = Date.now(), by = byName();
  if (db) {
    await update(ref(db, "cardStatus/" + enc), { state, ts, by });
  } else {
    const s = readLocalCardStatus(); s[enc] = { state, ts, by }; writeLocalCardStatus(s); applyCardStatus(s);
  }
}
async function eraseCardStatus(name) {
  const enc = encKey(name);
  if (db) {
    await remove(ref(db, "cardStatus/" + enc));
  } else {
    const s = readLocalCardStatus(); delete s[enc]; writeLocalCardStatus(s); applyCardStatus(s);
  }
}

// Schedule an existing card (shipped or custom) for removal on the next Store-event.
async function scheduleRemoval(name) {
  try { await writeCardStatus(name, "pendingRemoval"); setCaMsg(`“${name}” is scheduled to be removed on the next “Store event & reset pool”.`, "ok"); }
  catch (e) { setCaMsg("Schedule failed: " + e.message + " (publish database.rules.json?)", "err"); }
}
// Undo a scheduled removal, or publish a pending future-upload card immediately.
async function clearStatus(name) {
  try { await eraseCardStatus(name); setCaMsg(`“${name}” is active.`, "ok"); }
  catch (e) { setCaMsg("Update failed: " + e.message, "err"); }
}
// Revolve a retired card back in — returns as a staged future upload.
async function restoreCard(name) {
  try { await writeCardStatus(name, "pending"); setCaMsg(`“${name}” will be restored — it goes live on the next “Store event & reset pool”.`, "ok"); }
  catch (e) { setCaMsg("Restore failed: " + e.message + " (publish database.rules.json?)", "err"); }
}
// Cancel a pending restore — send the card straight back to retired (it isn't
// live yet, so nothing changes for players).
async function retireCard(name) {
  try { await writeCardStatus(name, "hidden"); setCaMsg(`“${name}” stays retired.`, "ok"); }
  catch (e) { setCaMsg("Update failed: " + e.message, "err"); }
}

// Add a brand-new commander to the pool (request A). Identity + art go to
// customCards; partner status (if any) goes to cardMeta so this and the grid
// toggle share one source of truth. Rejects names that already exist.
async function addCustomCard({ name, back, img, backImg, partner, pending }) {
  name = String(name || "").trim();
  back = String(back || "").trim();
  if (!name) { setCaMsg("Give the card a name.", "err"); return false; }
  if (NAME_MAP.has(name)) { setCaMsg(`“${name}” is already in the list — edit it in the grid below.`, "err"); return false; }
  const frontId = extractDriveId(img);
  if (!frontId) { setCaMsg("Front image: paste a Drive share link or file ID.", "err"); return false; }
  let backId = null;
  if (backImg != null && String(backImg).trim() !== "") {
    backId = extractDriveId(backImg);
    if (!backId) { setCaMsg("Back image: paste a Drive share link or file ID (or turn off “two faces”).", "err"); return false; }
  }
  const enc = encKey(name);
  const ts = Date.now(), by = byName();
  const rec = { name, img: frontId, ts, by };
  if (back) rec.back = back;
  if (backId) rec.backImg = backId;
  try {
    if (db) {
      const updates = { ["customCards/" + enc]: rec };
      if (partner) updates["cardMeta/" + enc] = { partner: true, ts, by };
      if (pending) updates["cardStatus/" + enc] = { state: "pending", ts, by };
      await update(ref(db), updates);
    } else {
      const cc = readLocalCustomCards(); cc[enc] = rec; writeLocalCustomCards(cc); customCards = cc;
      if (partner) { const m = readLocalCardMeta(); m[enc] = { partner: true, ts, by }; writeLocalCardMeta(m); cardMetaOverrides = m; }
      if (pending) { const s = readLocalCardStatus(); s[enc] = { state: "pending", ts, by }; writeLocalCardStatus(s); cardStatusOverrides = s; }
      applyCustomCards(cc);
    }
    setCaMsg(pending ? `Staged “${name}” as a future upload — it goes live for everyone on the next “Store event & reset pool”.` : `Added “${name}”.`, "ok");
    return true;
  } catch (e) { setCaMsg("Add failed: " + e.message + " (publish database.rules.json?)", "err"); return false; }
}

// Remove an admin-added card and any of its overrides. Only custom cards expose
// this — shipped cards can't be deleted from the UI.
async function deleteCustomCard(name) {
  const enc = encKey(name);
  try {
    if (db) {
      await Promise.all([
        remove(ref(db, "customCards/" + enc)),
        remove(ref(db, "cardMeta/" + enc)),
        remove(ref(db, "cardImages/" + enc)),
        remove(ref(db, "cardStatus/" + enc)),
      ]);
    } else {
      const cc = readLocalCustomCards(); delete cc[enc]; writeLocalCustomCards(cc);
      const m = readLocalCardMeta(); delete m[enc]; writeLocalCardMeta(m);
      const im = readLocalCardImages(); delete im[enc]; writeLocalCardImages(im);
      const s = readLocalCardStatus(); delete s[enc]; writeLocalCardStatus(s);
      cardMetaOverrides = m; cardImageOverrides = im; cardStatusOverrides = s; applyCustomCards(cc);
    }
    setCaMsg(`Removed “${name}”.`, "ok");
  } catch (e) { setCaMsg("Remove failed: " + e.message, "err"); }
}

// One editable face inside the admin grid. When a change is staged for this face
// we preview the staged art (admin-only — players still see the live art) with a
// badge, and swap the Set/Revert controls for Publish-now / Discard.
function faceTile(c, face) {
  const enc = encKey(c.name);
  const liveId = face === "img" ? c.img : c.backImg;
  const ov = cardImageOverrides[enc];
  const overridden = !!(ov && typeof ov[face] === "string");
  const st = cardImageStaged[enc];
  const stagedId = (st && typeof st[face] === "string") ? st[face] : null;
  const shownId = stagedId || liveId;
  const label = face === "img" ? "Front" : "Back";
  const badge = stagedId
    ? ` <span class="ca-badge staged">⏳ staged</span>`
    : (overridden ? ` <span class="ca-badge">overridden</span>` : "");
  const thumb = shownId
    ? `<img class="ca-thumb" src="${driveImg(shownId)}" alt="${escapeHtml(c.name)} ${label}" loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('broken')">`
    : `<div class="ca-thumb ca-empty">no image</div>`;
  return `<div class="ca-face${overridden ? " overridden" : ""}${stagedId ? " staged" : ""}" data-name="${escapeHtml(c.name)}" data-face="${face}">` +
    `<div class="ca-face-label">${label}${badge}</div>` +
    thumb +
    `<div class="ca-drop-hint">drop a Drive link</div>` +
    `<div class="ca-tools">` +
      `<input class="ca-input" type="text" placeholder="link or ID" autocomplete="off">` +
      `<button class="ca-set" type="button" title="Apply now — live for everyone">Set now</button>` +
      `<button class="ca-stage" type="button" title="Stage — publishes on the next “Store event & reset pool”">⏳ Stage</button>` +
      (stagedId
        ? `<button class="ca-publish ok" type="button" title="Publish the staged art now">Publish now</button>` +
          `<button class="ca-discard-staged" type="button">Discard staged</button>`
        : "") +
      `<button class="ca-revert" type="button"${overridden ? "" : " hidden"}>Revert</button>` +
    `</div>` +
  `</div>`;
}

// Staged-roster badge shown next to a card's name in the admin grid.
function statusTag(c) {
  if (c.status === "pending") return ` <span class="ca-status-tag pending">⏳ future upload</span>`;
  if (c.status === "pendingRemoval") return ` <span class="ca-status-tag removal">⏳ removal scheduled</span>`;
  if (c.status === "hidden") return ` <span class="ca-status-tag retired">🚫 retired</span>`;
  return "";
}
// Per-card staging controls. Actions are delegated in wireCardArt() via
// data-action + data-name. Hard-delete (customCards) is offered only for
// admin-added cards; shipped cards can be retired (hidden) but never deleted.
function statusControls(c) {
  const nm = escapeHtml(c.name);
  const btn = (action, label, cls) =>
    `<button class="ca-status-btn${cls ? " " + cls : ""}" type="button" data-action="${action}" data-name="${nm}">${label}</button>`;
  if (c.status === "pending") {
    // Future upload (or a restored card) awaiting the next Store-event.
    return btn("clear", "Publish now", "ok") +
      (c.custom ? btn("discard", "Discard", "danger") : btn("retire", "Cancel"));
  }
  if (c.status === "pendingRemoval") return btn("clear", "Undo removal");
  if (c.status === "hidden") return btn("restore", "Restore") + (c.custom ? btn("discard", "Delete", "danger") : "");
  // active
  return btn("schedule", "⏳ Schedule removal") + (c.custom ? btn("discard", "✕ Remove", "danger") : "");
}

// Render the searchable card grid (only meaningful while the panel is visible).
function renderCardArtGrid() {
  const grid = $("caGrid");
  if (!grid) return;
  const q = (($("caSearch") && $("caSearch").value) || "").trim().toLowerCase();
  const sorted = [...COMMANDERS].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  const shown = q
    ? sorted.filter((c) => c.name.toLowerCase().includes(q) || (c.back && c.back.toLowerCase().includes(q)))
    : sorted;
  if ($("caCount")) $("caCount").textContent = shown.length;
  grid.innerHTML = shown.map((c) => {
    const hasBack = !!(ORIGINAL_ART.get(c.name).backImg || c.back);
    const nm = escapeHtml(c.name);
    const stCls = c.status ? ` st-${c.status}` : "";
    return `<li class="ca-item${c.custom ? " custom" : ""}${stCls}">` +
      `<div class="ca-faces">${faceTile(c, "img")}${hasBack ? faceTile(c, "backImg") : ""}</div>` +
      `<div class="ca-name">${nm}${c.back ? `<span class="ca-flip">// ${escapeHtml(c.back)}</span>` : ""}` +
        `${c.custom ? ` <span class="ca-custom-tag">added</span>` : ""}${statusTag(c)}</div>` +
      `<div class="ca-meta">` +
        `<label class="ca-partner"><input type="checkbox" class="ca-partner-check" data-name="${nm}"${c.partner ? " checked" : ""}> 🤝 partner</label>` +
        `<span class="ca-status-actions">${statusControls(c)}</span>` +
      `</div>` +
    `</li>`;
  }).join("");
}

// ── Bulk import: matching ──
const stripExt = (s) => String(s).replace(/\.(png|jpe?g|webp|gif|bmp|tiff?|heic|avif)$/i, "");
// Unify punctuation that differs between Drive filenames and the shipped names:
// straight vs. curly/back apostrophes, and the various unicode dashes. Without
// this, e.g. "Calamity's Augur" (straight ') would miss "Calamity’s Augur" (curly ’).
const unifyPunct = (s) => String(s).replace(/[‘’‛`´]/g, "'").replace(/[‐-―]/g, "-");
// Full label (keeps a trailing "(front)"/color) for an exact match.
const canonName = (s) => unifyPunct(stripExt(String(s))).toLowerCase().replace(/\s+/g, " ").trim();
// Base name (trailing "(...)" stripped) for a looser fallback match.
const normArt = (s) => unifyPunct(baseName(stripExt(String(s)))).toLowerCase().replace(/\s+/g, " ").trim();

// Index every commander by its front name (→img) and back name (→backImg), both
// exactly and normalized (base name, no extension), so a Drive filename can be
// matched to the right commander and face.
function buildArtIndex() {
  const exact = new Map();   // canonName(label) -> { commander, face }
  const norm = new Map();    // normArt(label) -> [ { commander, face } ]
  const add = (label, commander, face) => {
    const k = canonName(label);
    if (!exact.has(k)) exact.set(k, { commander, face });
    const nk = normArt(label);
    if (!norm.has(nk)) norm.set(nk, []);
    norm.get(nk).push({ commander, face });
  };
  for (const c of COMMANDERS) {
    add(c.name, c, "img");
    if (c.back) add(c.back, c, "backImg");
  }
  return { exact, norm };
}

// Turn a list of {label, id} into review rows with a status.
function buildMatches(files) {
  const idx = buildArtIndex();
  return files.map((f) => {
    const id = extractDriveId(f.id);
    if (!id) return { file: f.label, id: "", status: "no id" };
    const key = canonName(f.label);
    let hit = idx.exact.get(key);
    let status;
    if (!hit) {
      const list = idx.norm.get(normArt(f.label)) || [];
      if (list.length === 1) hit = list[0];
      else if (list.length > 1) status = "ambiguous";
    }
    if (!hit) return { file: f.label, id, status: status || "unmatched" };
    const cur = hit.face === "img" ? hit.commander.img : hit.commander.backImg;
    return { file: f.label, id, commander: hit.commander, face: hit.face, current: cur || "", status: cur === id ? "same" : "changed" };
  });
}

function renderReview(matches) {
  const el = $("caReview");
  if (!el) return;
  if (!matches.length) { el.innerHTML = ""; return; }
  const count = (s) => matches.filter((m) => m.status === s).length;
  const shortId = (v) => (v ? escapeHtml(String(v).slice(0, 10)) + "…" : "—");
  const rows = matches.map((m, i) => {
    const canApply = m.status === "changed";
    const target = m.commander
      ? escapeHtml(m.commander.name) + (m.face === "backImg" ? " (back)" : "")
      : `<span class="ca-none">— no match —</span>`;
    return `<tr class="ca-row ca-st-${m.status.replace(/\s/g, "-")}">` +
      `<td><input type="checkbox" class="ca-row-check" data-idx="${i}"${canApply ? " checked" : " disabled"}></td>` +
      `<td>${escapeHtml(m.file)}</td><td>${target}</td>` +
      `<td class="ca-id">${shortId(m.current)}</td><td class="ca-id">${shortId(m.id)}</td>` +
      `<td><span class="ca-status">${m.status}</span></td></tr>`;
  }).join("");
  el.innerHTML =
    `<div class="ca-review-sum">${count("changed")} to change · ${count("same")} unchanged · ` +
      `${count("unmatched") + count("ambiguous") + count("no id")} unmatched</div>` +
    `<div class="ca-review-scroll"><table class="ca-table">` +
      `<thead><tr><th></th><th>File</th><th>Commander</th><th>Current</th><th>New</th><th>Status</th></tr></thead>` +
      `<tbody>${rows}</tbody></table></div>` +
    `<button id="caApplyBtn" class="ca-apply" type="button">Apply selected</button>`;
}

async function applyReview() {
  const chosen = [];
  $("caReview").querySelectorAll(".ca-row-check").forEach((b) => {
    if (b.checked && !b.disabled) chosen.push(bulkMatches[+b.dataset.idx]);
  });
  if (!chosen.length) return setCaMsg("Nothing selected to apply.", "err");
  const by = byName(), ts = Date.now();
  try {
    if (db) {
      const updates = {};
      for (const m of chosen) {
        const enc = encKey(m.commander.name);
        updates[enc + "/" + m.face] = m.id;
        updates[enc + "/ts"] = ts;
        updates[enc + "/by"] = by;
      }
      await update(ref(db, "cardImages"), updates);
    } else {
      const store = readLocalCardImages();
      for (const m of chosen) {
        const enc = encKey(m.commander.name);
        store[enc] = { ...(store[enc] || {}), [m.face]: m.id, ts, by };
      }
      writeLocalCardImages(store);
      applyCardImages(store);
    }
    setCaMsg(`Applied ${chosen.length} update${chosen.length === 1 ? "" : "s"}.`, "ok");
    if (firebaseReady) await new Promise((r) => setTimeout(r, 60)); // let onValue settle
    bulkMatches = buildMatches(bulkMatches.map((m) => ({ label: m.file, id: m.id })));
    renderReview(bulkMatches);
  } catch (e) { setCaMsg("Apply failed: " + e.message + " (publish database.rules.json?)", "err"); }
}

// ── Bulk import: inputs ──
async function driveListFolder(folderId, key) {
  const out = [];
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      key,
      fields: "nextPageToken,files(id,name,mimeType)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const res = await fetch("https://www.googleapis.com/drive/v3/files?" + params.toString());
    if (!res.ok) {
      let msg = res.status + " " + res.statusText;
      try { const e = await res.json(); if (e.error && e.error.message) msg = e.error.message; } catch { /* ignore */ }
      throw new Error(msg);
    }
    const data = await res.json();
    (data.files || []).forEach((f) => out.push(f));
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return out;
}

async function onScanFolder() {
  const folderId = extractDriveId($("caFolder").value);
  if (!folderId) return setCaMsg("Paste the Drive folder's link or ID.", "err");
  const key = firebaseConfig.apiKey;
  if (!key || key === "REPLACE_ME") return setCaMsg("No API key available — use the paste box below instead.", "err");
  setCaMsg("Scanning folder…", "");
  try {
    const files = await driveListFolder(folderId, key);
    const imgs = files.filter((f) => !f.mimeType || f.mimeType.startsWith("image/"));
    if (!imgs.length) {
      return setCaMsg("No image files returned. Make sure the folder is shared “Anyone with the link” and the Drive API is enabled — or use the paste box below.", "err");
    }
    bulkMatches = buildMatches(imgs.map((f) => ({ label: f.name, id: f.id })));
    renderReview(bulkMatches);
    setCaMsg(`Found ${imgs.length} image${imgs.length === 1 ? "" : "s"} — review below.`, "ok");
  } catch (e) {
    setCaMsg("Folder scan failed: " + e.message + ". The Drive API may be off, the folder not public, or the key restricted — use the paste box below.", "err");
  }
}

function onParsePaste() {
  const raw = $("caPaste").value.trim();
  if (!raw) return setCaMsg("Paste a “Name, driveId” list (or JSON) first.", "err");
  let files = [];
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) files = j.map((x) => ({ label: x.name || x.label || x[0], id: x.id || x.img || x[1] }));
    else if (j && typeof j === "object") files = Object.entries(j).map(([name, id]) => ({ label: name, id }));
  } catch {
    // CSV / lines: split on the LAST comma so commander names with commas survive.
    files = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
      const i = line.lastIndexOf(",");
      if (i < 0) return null;
      return { label: line.slice(0, i).trim().replace(/^["']|["']$/g, ""), id: line.slice(i + 1).trim() };
    }).filter(Boolean);
  }
  files = files.filter((f) => f && f.label && f.id);
  if (!files.length) return setCaMsg("Couldn't parse any “name, id” rows.", "err");
  bulkMatches = buildMatches(files);
  renderReview(bulkMatches);
  setCaMsg(`Parsed ${files.length} row${files.length === 1 ? "" : "s"} — review below.`, "ok");
}

// ── Single-card import (request A) ──
// Show/hide the back-face inputs when "two faces" is toggled.
function syncNewCardFaces() {
  const on = $("caNew2Faces") && $("caNew2Faces").checked;
  const back = $("caNewBackWrap");
  if (back) back.style.display = on ? "" : "none";
}

async function onAddSingleCard() {
  const twoFaces = $("caNew2Faces") && $("caNew2Faces").checked;
  const ok = await addCustomCard({
    name: $("caNewName").value,
    img: $("caNewImg").value,
    back: twoFaces ? $("caNewBackName").value : "",
    backImg: twoFaces ? $("caNewBackImg").value : "",
    partner: $("caNewPartner") && $("caNewPartner").checked,
    pending: $("caNewFuture") && $("caNewFuture").checked,
  });
  if (ok) {
    // Clear the form for the next card; keep the panel open on the new grid entry.
    ["caNewName", "caNewImg", "caNewBackName", "caNewBackImg"].forEach((id) => { if ($(id)) $(id).value = ""; });
    if ($("caNew2Faces")) $("caNew2Faces").checked = false;
    if ($("caNewPartner")) $("caNewPartner").checked = false;
    if ($("caNewFuture")) $("caNewFuture").checked = false;
    syncNewCardFaces();
    if ($("caSearch")) { $("caSearch").value = ""; renderCardArtGrid(); }
  }
}

// Attach the admin button handlers once. The buttons live in the DOM always
// (hidden until you're admin); wiring them up front avoids double-binding when
// admin status flips on login/logout.
function wireAdmin() {
  if (adminWired) return;
  adminWired = true;
  $("claimBtn").addEventListener("click", claimAdmin);
  $("adminToggle").addEventListener("click", () => {
    adminCollapsed = !adminCollapsed;
    try { localStorage.setItem(LS_ADMIN_COLLAPSED, adminCollapsed ? "1" : "0"); } catch { /* ignore */ }
    refreshAdminUI();
  });
  $("resetBtn").addEventListener("click", async () => {
    if (!confirm("Clear ALL assignments for this event? This cannot be undone. (Use 'Store event & reset' if you want to keep results.)")) return;
    if (!firebaseReady) { assignments = {}; recomputeUsed(); renderResults(); renderStats(); endSequence(); populateManualOptions(); return; }
    await runTransaction(assignmentsRef, () => null);
    endSequence();
  });
  $("storeResetBtn").addEventListener("click", storeEventAndReset);
  $("maType").addEventListener("change", populateManualOptions);
  $("maAssignBtn").addEventListener("click", manualAssign);
  wireCardArt();
}

// Card-art panel listeners (delegated so they survive grid/review re-renders).
function wireCardArt() {
  const grid = $("caGrid");
  if (grid) {
    grid.addEventListener("click", (e) => {
      const stBtn = e.target.closest(".ca-status-btn");
      if (stBtn) {
        const { action, name } = stBtn.dataset;
        if (action === "schedule") scheduleRemoval(name);
        else if (action === "clear") clearStatus(name);
        else if (action === "restore") restoreCard(name);
        else if (action === "retire") retireCard(name);
        else if (action === "discard") {
          if (confirm(`Remove the custom card “${name}”? This deletes its art, partner, and status overrides too.`)) deleteCustomCard(name);
        }
        return;
      }
      const face = e.target.closest(".ca-face");
      if (!face) return;
      const { name, face: f } = face.dataset;
      if (e.target.closest(".ca-set")) {
        const inp = face.querySelector(".ca-input");
        setFaceOverride(name, f, inp ? inp.value : "");
      } else if (e.target.closest(".ca-stage")) {
        const inp = face.querySelector(".ca-input");
        stageFaceOverride(name, f, inp ? inp.value : "");
      } else if (e.target.closest(".ca-publish")) {
        publishStagedFace(name, f);
      } else if (e.target.closest(".ca-discard-staged")) {
        discardStagedFace(name, f);
      } else if (e.target.closest(".ca-revert")) {
        revertFace(name, f);
      }
    });
    // Partner toggle (request B) — delegated so it survives grid re-renders.
    grid.addEventListener("change", (e) => {
      const cb = e.target.closest(".ca-partner-check");
      if (cb) setPartnerFlag(cb.dataset.name, cb.checked);
    });
    grid.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !e.target.classList.contains("ca-input")) return;
      const face = e.target.closest(".ca-face");
      setFaceOverride(face.dataset.name, face.dataset.face, e.target.value);
    });
    grid.addEventListener("dragover", (e) => {
      const face = e.target.closest(".ca-face");
      if (!face) return;
      e.preventDefault();
      face.classList.add("drop");
    });
    grid.addEventListener("dragleave", (e) => {
      const face = e.target.closest(".ca-face");
      if (face) face.classList.remove("drop");
    });
    grid.addEventListener("drop", (e) => {
      const face = e.target.closest(".ca-face");
      if (!face) return;
      e.preventDefault();
      face.classList.remove("drop");
      const dt = e.dataTransfer;
      const data = (dt.getData("text/uri-list") || dt.getData("text/plain") || "").trim();
      setFaceOverride(face.dataset.name, face.dataset.face, data);
    });
  }
  if ($("caSearch")) $("caSearch").addEventListener("input", renderCardArtGrid);
  if ($("caScanBtn")) $("caScanBtn").addEventListener("click", onScanFolder);
  if ($("caParseBtn")) $("caParseBtn").addEventListener("click", onParsePaste);
  if ($("caReview")) $("caReview").addEventListener("click", (e) => {
    if (e.target.id === "caApplyBtn") applyReview();
  });
  // Single-card import (request A).
  if ($("caNew2Faces")) $("caNew2Faces").addEventListener("change", syncNewCardFaces);
  if ($("caAddBtn")) $("caAddBtn").addEventListener("click", onAddSingleCard);
}

// Show/hide admin tools based on (logged-in account === claimed owner). #admin
// in the URL only reveals the one-time "claim" button while still unclaimed.
function refreshAdminUI() {
  const owner = adminOwnerKey;
  isAdmin = !!(currentUser && owner && currentUser.key === owner);

  // The owner can minimize the tools to a small chip; the chip itself stays
  // visible so they can bring the tools back. State is remembered per-browser.
  const showTools = isAdmin && !adminCollapsed;
  const toggle = $("adminToggle");
  toggle.style.display = isAdmin ? "inline-flex" : "none";
  toggle.setAttribute("aria-expanded", String(showTools));
  toggle.textContent = showTools ? "🔧 Admin ▾" : "🔧 Admin ▸";
  $("adminBar").style.display = showTools ? "flex" : "none";
  $("adminPanel").style.display = showTools ? "block" : "none";
  $("cardArtPanel").style.display = showTools ? "block" : "none";

  const canClaim = location.hash === "#admin" && !owner;
  $("adminClaim").style.display = canClaim ? "flex" : "none";
  if (canClaim) {
    $("claimMsg").textContent = currentUser
      ? `Make “${currentUser.username}” the permanent admin for this app.`
      : "Log in (or register) first, then claim admin for your account.";
    $("claimBtn").disabled = !currentUser;
  }

  if (isAdmin) { populateManualOptions(); refreshUserList(); }
  if (showTools) renderCardArtGrid();
  renderResults();   // reflect re-roll / remove buttons
}

// One-time claim: writes the owner only if none exists yet (create-only, both
// in the rules and here), so a leaked #admin link can't seize or change it.
async function claimAdmin() {
  if (!currentUser) return setAuthMsg("Log in first, then claim admin.", "err");
  if (adminOwnerKey) return;
  if (!db) {   // local-preview mode
    try { localStorage.setItem(LS_ADMIN, currentUser.key); } catch { /* ignore */ }
    adminOwnerKey = currentUser.key;
    refreshAdminUI();
    return;
  }
  const res = await runTransaction(ref(db, "admin/owner"), (cur) => (cur ? undefined : currentUser.key));
  if (!res.committed) alert("Admin was just claimed by another account.");
  // onValue("admin/owner") fires and calls refreshAdminUI()
}

// ───────────────────────────── Boot ───────────────────────────────
function boot() {
  wheel = new Wheel($("wheel"));
  try { adminCollapsed = localStorage.getItem(LS_ADMIN_COLLAPSED) === "1"; } catch { /* ignore */ }
  restoreSession();
  buildMainWheel();
  renderStats();
  renderResults();
  $("spinBtn").addEventListener("click", () => {
    if (wheel.spinning) return;
    if (phase === "main") { guestSeq = false; scope = "personal"; }
    onSpin();
  });
  $("guestBtn").addEventListener("click", () => {
    if (wheel.spinning || phase !== "main") return;
    guestSeq = true; scope = "all";   // roll across every commander, even claimed ones
    onSpin();
  });
  $("loginBtn").addEventListener("click", login);
  $("registerBtn").addEventListener("click", register);
  $("logoutBtn").addEventListener("click", logout);
  $("authUser").addEventListener("keydown", (e) => { if (e.key === "Enter") $("authPass").focus(); });
  $("authPass").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
  $("results").addEventListener("click", (e) => {
    const rb = e.target.closest(".reroll-btn");
    if (rb) { reRoll(rb.dataset.key); return; }
    const xb = e.target.closest(".remove-btn");
    if (xb) removeAssignment(xb.dataset.key);
  });
  wireAdmin();
  const configured = initFirebase();
  // Local-preview mode (no Firebase): the owner + card-art overrides live in
  // localStorage so the admin tools are still testable.
  if (!configured) {
    try { adminOwnerKey = localStorage.getItem(LS_ADMIN) || null; } catch { /* ignore */ }
    // Seed the mirrors, then a single rebuild so custom cards + partner flips
    // + staged roster status all show.
    cardImageOverrides = readLocalCardImages();
    cardImageStaged = readLocalCardImageStaged();
    cardMetaOverrides = readLocalCardMeta();
    cardStatusOverrides = readLocalCardStatus();
    applyCustomCards(readLocalCustomCards());
  }
  window.addEventListener("hashchange", refreshAdminUI);
  refreshAdminUI();
  updateSpinButton();
}

boot();
