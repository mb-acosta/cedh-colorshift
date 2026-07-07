import { COMMANDERS } from "./commanders.js";
import { firebaseConfig, EVENT_ID } from "./firebase-config.js";

// Static reference gallery. Renders every commander in alphabetical order with a
// search filter, in either a card GRID (default) or a compact LIST. It reads the
// admin overrides from Firebase over REST — card art (live + staged), partner
// status, custom cards, roster status, color identity, and the last store-event's
// added/updated markers — and falls back to the shipped list if reads fail.
//
// Views:
//   • Grid — card art. Shows the collapsible sections below (all players see
//     Future updates + Leaving soon; only the admin sees Retired and full art
//     previews of future updates — players get names only for those).
//   • List — a compact name / partner / color-identity table of the LIVE pool only.
// Color-identity filters (grid + list): pick colors to show cards whose identity
// fits inside the pick (deckbuilding-legal), or "My commander" to auto-derive the
// logged-in player's assigned colors. Admin is detected via the wheel's session pointer.

// Same Google Drive thumbnail endpoint the wheel uses. Cards must be shared
// "Anyone with the link"; a broken image hides itself via the onerror handler.
const driveImg = (id) => `https://lh3.googleusercontent.com/d/${id}=w480`;
// Firebase-safe key from a commander name (must match encKey() in app.js).
const encKey = (s) => encodeURIComponent(String(s)).replace(/\./g, "%2E");
// A player's stable identity = lowercased Discord name (must match userKey() in app.js).
const userKey = (s) => encKey(String(s).trim().toLowerCase());
const WUBRG = ["W", "U", "B", "R", "G"];
const COLOR_NAME = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green", C: "Colorless" };
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function face(id, alt) {
  if (!id) return "";
  return `<img class="g-card" src="${driveImg(id)}" alt="${escapeHtml(alt)}" ` +
    `loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('broken')">`;
}
// A real MTG mana symbol (mana-font). "" or "C" → colorless. data-letter is the
// fallback shown (via CSS) as a colored W/U/B/R/G/C circle if the font fails.
function manaSym(L) {
  const c = String(L || "C").toUpperCase();
  return `<i class="ms ms-${c.toLowerCase()} ms-cost" data-letter="${c}" title="${COLOR_NAME[c] || c}" aria-hidden="true"></i>`;
}
// Flag <html> if the Mana web font can't load, so CSS falls back to letter pips.
function detectManaFont() {
  const flag = () => {
    if (!document.fonts || !document.fonts.load) { document.documentElement.classList.add("no-mana"); return; }
    document.fonts.load('16px "Mana"')
      .then((faces) => { if (!faces || faces.length === 0) document.documentElement.classList.add("no-mana"); })
      .catch(() => document.documentElement.classList.add("no-mana"));
  };
  if (document.readyState === "complete") flag();
  else window.addEventListener("load", flag, { once: true });
}
detectManaFont();
// Color-identity pips (read-only), as authentic mana symbols. null/undefined
// (untagged) renders nothing; "" renders the colorless symbol.
function colorPipsHtml(colors) {
  if (colors == null) return "";
  if (colors === "") return `<span class="cc-pips">${manaSym("")}</span>`;
  return `<span class="cc-pips">` + colors.split("").map((L) => manaSym(L)).join("") + `</span>`;
}

const grid = document.getElementById("gallery");
const countEl = document.getElementById("galleryCount");
const liveCount = document.getElementById("liveCount");
const search = document.getElementById("gallerySearch");
const futureSec = document.getElementById("secFuture");
const futureList = document.getElementById("galleryFuture");
const futureCount = document.getElementById("futureCount");
const leavingSec = document.getElementById("secLeaving");
const leavingList = document.getElementById("galleryLeaving");
const leavingCount = document.getElementById("leavingCount");
const retiredSec = document.getElementById("secRetired");
const retiredList = document.getElementById("galleryRetired");
const retiredCount = document.getElementById("retiredCount");

// Admin overrides pulled from Firebase (empty until applyOverrides resolves).
let cardImages = {};        // encKey -> { img?, backImg? }
let cardImagesStaged = {};  // encKey -> { img?, backImg? }  — staged art (admin-only preview)
let cardMeta = {};          // encKey -> { partner }
let customCards = {};       // encKey -> { name, back?, img, backImg? }
let cardStatus = {};        // encKey -> { state }  — staged roster status
let cardColors = {};        // encKey -> { colors }  — declared color identity ("" = colorless)
let poolChanges = {};       // encKey -> { kind: "added"|"updated" }  — last store-event's changes
let assignments = {};       // pushId -> { discord, uid, type, name|partnerA/partnerB }
let session = null;         // { username, key } | null
let isAdmin = false;        // this browser's stored session is the admin owner

// View + color-filter state.
let view = "grid";          // "grid" | "list"
let picked = new Set();      // active WUBRG color subset
let colorlessOnly = false;   // the ◇ chip (only meaningful when no colors picked)
let mineMode = false;        // "My commander" filter engaged

// Combine the shipped list with admin-added custom cards, layer on partner-status,
// art, roster-status, and color overrides, then sort alphabetically. Mirrors
// rebuildCommanders() in app.js.
let display = [];
function rebuild() {
  const list = COMMANDERS.map((c) => ({ ...c }));
  const names = new Set(list.map((c) => c.name));
  for (const enc in customCards) {
    const cc = customCards[enc];
    if (!cc || !cc.name || names.has(cc.name)) continue;
    list.push({ name: cc.name, back: cc.back || null, partner: false, img: cc.img || null, backImg: cc.backImg || null });
  }
  for (const c of list) {
    const enc = encKey(c.name);
    const meta = cardMeta[enc];
    if (meta && typeof meta.partner === "boolean") c.partner = meta.partner;
    const ov = cardImages[enc];
    if (ov && typeof ov.img === "string") c.img = ov.img;
    if (ov && typeof ov.backImg === "string") c.backImg = ov.backImg;
    const st = cardStatus[enc];
    c.status = (st && typeof st.state === "string") ? st.state : null;   // null = active
    // Staged art (admin-only preview): live faces above are unchanged.
    const stg = cardImagesStaged[enc];
    c.stagedImg = (stg && typeof stg.img === "string") ? stg.img : null;
    c.stagedBackImg = (stg && typeof stg.backImg === "string") ? stg.backImg : null;
    // Declared color identity ("" = colorless, undefined = untagged).
    const col = cardColors[enc];
    c.colors = (col && typeof col.colors === "string") ? col.colors : undefined;
    // Last store-event marker ("added"|"updated"|null).
    const pc = poolChanges[enc];
    c.poolChange = (pc && (pc.kind === "added" || pc.kind === "updated")) ? pc.kind : null;
  }
  display = list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

// The transient "just changed" badge (grid + list). Only Live/Leaving cards render
// via itemHtml/listRowHtml, so a stale marker on a pending/hidden card can't surface.
function changeTag(c) {
  if (c.poolChange === "added") return `<span class="g-tag added">✨ added</span>`;
  if (c.poolChange === "updated") return `<span class="g-tag updated">🔄 updated</span>`;
  return "";
}

function itemHtml(c) {
  const faces = face(c.img, c.name) + (c.backImg ? face(c.backImg, c.back || c.name) : "");
  const flip = c.back ? `<span class="g-flip">// ${escapeHtml(c.back)}</span>` : "";
  const partnerTag = c.partner ? `<span class="g-tag">🤝 partner</span>` : "";
  let statusTag = "";
  if (c.status === "pending") statusTag = `<span class="g-tag pending">⏳ future upload</span>`;
  else if (c.status === "hidden") statusTag = `<span class="g-tag retired">🚫 retired</span>`;
  else if (isAdmin && c.status === "pendingRemoval") statusTag = `<span class="g-tag removal">⏳ removal scheduled</span>`;
  return `<li class="g-item${c.backImg ? " flip" : ""}">` +
    `<div class="g-faces">${faces}</div>` +
    `<div class="g-name">${escapeHtml(c.name)}${flip}${partnerTag}${statusTag}${changeTag(c)}</div>` +
    `</li>`;
}

// A staged art change (admin only), showing the NEW (staged) face(s) with a badge.
function modItemHtml(c) {
  const frontId = c.stagedImg || c.img;
  const backId = c.stagedBackImg || c.backImg;
  const faces = face(frontId, c.name) + (backId ? face(backId, c.back || c.name) : "");
  const flip = c.back ? `<span class="g-flip">// ${escapeHtml(c.back)}</span>` : "";
  const which = [c.stagedImg ? "front" : null, c.stagedBackImg ? "back" : null].filter(Boolean).join(" & ");
  const tag = `<span class="g-tag pending">⏳ art change (${which})</span>`;
  return `<li class="g-item${backId ? " flip" : ""}">` +
    `<div class="g-faces">${faces}</div>` +
    `<div class="g-name">${escapeHtml(c.name)}${flip}${tag}</div>` +
    `</li>`;
}

// Names-only future item for NON-admin players (no card image before it's live).
function futureNameHtml(c, kind) {
  const flip = c.back ? `<span class="g-flip">// ${escapeHtml(c.back)}</span>` : "";
  const partner = c.partner ? `<span class="g-tag">🤝 partner</span>` : "";
  const tag = kind === "add"
    ? `<span class="g-tag pending">⏳ coming soon</span>`
    : `<span class="g-tag pending">⏳ art change</span>`;
  return `<li class="g-item names-only">` +
    `<div class="g-name">${escapeHtml(c.name)}${flip}${partner}${tag}</div></li>`;
}

// One list-view row: name (+ back), 🤝 partner, and color identity.
function listRowHtml(c) {
  const back = c.back ? `<span class="gl-back">// ${escapeHtml(c.back)}</span>` : "";
  const partner = c.partner ? `<span class="gl-partner" title="Partner-eligible">🤝</span>` : "";
  return `<li class="gl-row">` +
    `<span class="gl-name">${escapeHtml(c.name)}${changeTag(c)}${back}</span>` +
    `<span class="gl-p">${partner}</span>` +
    `<span class="gl-c">${colorPipsHtml(c.colors)}</span>` +
    `</li>`;
}

function matchesFilter(c, q) {
  return !q || c.name.toLowerCase().includes(q) || (c.back && c.back.toLowerCase().includes(q));
}

// Color-identity filter. Subset semantics = deckbuilding-legal in the 99: a card
// passes if every color of its identity is in the picked set (colorless "" ⊆ any).
// Untagged cards are excluded while a filter is active (can't verify legality).
function colorFilterActive() { return mineMode || colorlessOnly || picked.size > 0; }
function passesColor(c) {
  if (!colorFilterActive()) return true;
  if (typeof c.colors !== "string") return false;
  if (colorlessOnly && picked.size === 0) return c.colors === "";
  for (const ch of c.colors) if (!picked.has(ch)) return false;
  return true;
}

// Derive the logged-in player's colors from their assignment(s). Partner = the
// union of both partners' identities. Returns a state so the UI can hint.
function deriveMyColors() {
  if (!session) return { state: "guest" };
  const mine = Object.values(assignments).filter((a) =>
    a && (a.uid === session.key || userKey(a.discord || "") === session.key));
  if (!mine.length) return { state: "none" };
  const names = [];
  for (const a of mine) {
    if (a.type === "partner") { if (a.partnerA) names.push(a.partnerA); if (a.partnerB) names.push(a.partnerB); }
    else if (a.name) names.push(a.name);
  }
  const set = new Set(); let tagged = false;
  for (const n of names) {
    const rec = cardColors[encKey(n)];
    if (rec && typeof rec.colors === "string") { tagged = true; for (const ch of rec.colors) set.add(ch); }
  }
  if (!tagged) return { state: "untagged", names };
  return { state: "ok", set, names };
}

// Show/hide + fill a section from pre-rendered item HTML (empty → hidden). The
// count pill always updates; the collapsed-state class is left untouched.
function renderSection(sec, listEl, countPill, itemsHtml) {
  if (countPill) countPill.textContent = itemsHtml.length;
  if (!sec || !listEl) return;
  if (!itemsHtml.length) { sec.style.display = "none"; listEl.innerHTML = ""; return; }
  sec.style.display = "";
  listEl.innerHTML = itemsHtml.join("");
}

function render(filter = "") {
  const q = filter.trim().toLowerCase();
  const isList = view === "list";
  grid.classList.toggle("list-view", isList);

  // Live commanders: everything live for players (active + scheduled-for-removal),
  // narrowed by search and the color filter.
  const live = display.filter((c) =>
    c.status !== "pending" && c.status !== "hidden" && matchesFilter(c, q) && passesColor(c));
  countEl.textContent = live.length;
  if (liveCount) liveCount.textContent = live.length;
  grid.innerHTML = live.length
    ? (isList ? live.map(listRowHtml).join("") : live.map(itemHtml).join(""))
    : `<li class="g-empty">No commanders match your filters.</li>`;

  // List view = live pool only. Hide the preview sections in JS (renderSection
  // sets inline display, which would otherwise beat a CSS rule).
  if (isList) {
    [futureSec, leavingSec, retiredSec].forEach((s) => { if (s) s.style.display = "none"; });
    return;
  }

  // Future updates (ALL players): additions (pending) + staged art changes on live
  // cards. Admins see full art previews; players see names only. Search-filtered
  // (not color-filtered — future additions are often untagged).
  const additions = display.filter((c) => c.status === "pending" && matchesFilter(c, q));
  const mods = display.filter((c) =>
    (c.stagedImg || c.stagedBackImg) && c.status !== "pending" && c.status !== "hidden" && matchesFilter(c, q));
  const futureHtml = isAdmin
    ? additions.map(itemHtml).concat(mods.map(modItemHtml))
    : additions.map((c) => futureNameHtml(c, "add")).concat(mods.map((c) => futureNameHtml(c, "mod")));
  renderSection(futureSec, futureList, futureCount, futureHtml);

  // Leaving soon (ALL players, with images): scheduled removals. These also stay
  // in Live (still rollable until the next store event).
  const leaving = display.filter((c) => c.status === "pendingRemoval" && matchesFilter(c, q) && passesColor(c));
  renderSection(leavingSec, leavingList, leavingCount, leaving.map(itemHtml));

  // Retired / removed (admin only).
  const retired = isAdmin ? display.filter((c) => c.status === "hidden" && matchesFilter(c, q)) : [];
  renderSection(retiredSec, retiredList, retiredCount, retired.map(itemHtml));
}

// ── Controls: view toggle + color filters ──
const VIEW_KEY = "cw_gallery_view";
function initViewToggle() {
  try { view = localStorage.getItem(VIEW_KEY) === "list" ? "list" : "grid"; } catch { /* ignore */ }
  document.querySelectorAll(".view-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
    b.addEventListener("click", () => {
      view = b.dataset.view;
      try { localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ }
      document.querySelectorAll(".view-btn").forEach((x) => x.classList.toggle("active", x.dataset.view === view));
      render(search ? search.value : "");
    });
  });
}

function setColorHint(state) {
  const el = document.getElementById("colorHint");
  if (!el) return;
  el.textContent =
    state === "guest" ? "Log in on the wheel to use “My commander”."
    : state === "none" ? "No assignment yet — spin on the wheel first."
    : state === "untagged" ? "Your commander's colors aren't tagged yet."
    : "";
}

function syncChips() {
  document.querySelectorAll("#colorFilters .filter-chip[data-color]").forEach((chip) => {
    const col = chip.dataset.color;
    const on = col === "C" ? (colorlessOnly && picked.size === 0) : picked.has(col);
    chip.classList.toggle("on", on);
  });
  const my = document.getElementById("myCmdBtn");
  if (my) my.classList.toggle("on", mineMode);
}

function engageMyCommander() {
  const r = deriveMyColors();
  if (r.state === "ok") {
    picked = new Set(r.set);
    colorlessOnly = r.set.size === 0;   // a colorless commander → only colorless cards fit
    mineMode = true;
    syncChips();
    setColorHint("");
    render(search ? search.value : "");
  } else {
    setColorHint(r.state);
  }
}

function initColorFilters() {
  const box = document.getElementById("colorFilters");
  if (!box) return;
  box.addEventListener("click", (e) => {
    const chip = e.target.closest(".filter-chip");
    if (!chip) return;
    if (chip.id === "myCmdBtn") { engageMyCommander(); return; }
    if (chip.id === "clearColors") {
      picked = new Set(); colorlessOnly = false; mineMode = false;
      syncChips(); setColorHint(""); render(search ? search.value : ""); return;
    }
    const col = chip.dataset.color;
    if (!col) return;
    mineMode = false;
    if (col === "C") { colorlessOnly = !colorlessOnly; if (colorlessOnly) picked = new Set(); }
    else { colorlessOnly = false; if (picked.has(col)) picked.delete(col); else picked.add(col); }
    syncChips(); render(search ? search.value : "");
  });
}

// Feature-detect: hide the whole color UI when nothing is tagged yet, so the page
// degrades to plain search until the admin starts declaring identities.
function maybeShowColorUI() {
  const box = document.getElementById("colorFilters");
  if (box) box.hidden = Object.keys(cardColors).length === 0;
}
function refreshMyCommanderBtn() {
  const btn = document.getElementById("myCmdBtn");
  if (!btn) return;
  const r = deriveMyColors();
  btn.disabled = r.state !== "ok";
  if (!mineMode) setColorHint(r.state === "ok" ? "" : r.state);
}

// Collapse/expand per section, remembered per-browser so a preferred view sticks.
const COLLAPSE_KEY = "cw_gallery_collapsed";
function readCollapsed() { try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || "{}") || {}; } catch { return {}; } }
function writeCollapsed(o) { try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(o)); } catch { /* ignore */ } }
function initCollapsible() {
  const saved = readCollapsed();
  document.querySelectorAll(".gallery-sec-head").forEach((head) => {
    const sec = head.closest(".gallery-sec");
    const key = head.dataset.sec;
    if (sec && saved[key]) { sec.classList.add("collapsed"); head.setAttribute("aria-expanded", "false"); }
    head.addEventListener("click", () => {
      const collapsed = sec.classList.toggle("collapsed");
      head.setAttribute("aria-expanded", collapsed ? "false" : "true");
      const s = readCollapsed(); s[key] = collapsed; writeCollapsed(s);
    });
  });
}

// Read the wheel's session pointer {username, key} (localStorage for "remember me",
// else sessionStorage). Used for admin detection and the "My commander" filter.
function getSession() {
  try {
    const raw = localStorage.getItem("cw_session") || sessionStorage.getItem("cw_session");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function detectAdmin(ownerKey) {
  return !!(ownerKey && session && session.key && session.key === ownerKey);
}

session = getSession();
initCollapsible();
initViewToggle();
initColorFilters();
rebuild();
render();
if (search) search.addEventListener("input", (e) => render(e.target.value));

// Pull the admin overrides (read-only) and re-render. Fast first paint uses the
// shipped list; this refreshes art, partner tags, colors, staged sections, and
// the added/updated markers.
(async function applyOverrides() {
  const url = firebaseConfig.databaseURL;
  if (!url || url.includes("REPLACE_ME")) return;
  const base = url.replace(/\/$/, "");
  const fetchJson = async (path) => {
    try { const res = await fetch(base + path); return res.ok ? (await res.json()) : null; }
    catch { return null; }
  };
  const [imgs, staged, meta, custom, status, colors, changes, assigns, owner] = await Promise.all([
    fetchJson("/cardImages.json"),
    fetchJson("/cardImagesStaged.json"),
    fetchJson("/cardMeta.json"),
    fetchJson("/customCards.json"),
    fetchJson("/cardStatus.json"),
    fetchJson("/cardColors.json"),
    fetchJson("/poolChanges.json"),
    fetchJson(`/events/${EVENT_ID}/assignments.json`),
    fetchJson("/admin/owner.json"),
  ]);
  cardImages = imgs || {};
  cardImagesStaged = staged || {};
  cardMeta = meta || {};
  customCards = custom || {};
  cardStatus = status || {};
  cardColors = colors || {};
  poolChanges = changes || {};
  assignments = assigns || {};
  session = getSession();
  isAdmin = detectAdmin(owner);
  rebuild();
  render(search ? search.value : "");
  maybeShowColorUI();
  refreshMyCommanderBtn();
})();
