import { COMMANDERS } from "./commanders.js";
import { firebaseConfig } from "./firebase-config.js";

// Static reference gallery. Renders every commander's card art in alphabetical
// order (front + back face for flip cards), with a simple filter. It reads (only)
// the admin overrides from Firebase — card art, partner status, admin-added
// custom cards, and staged roster status — so it stays in sync with the wheel,
// but needs no login and falls back to the shipped list if those reads fail.
//
// Staged roster: the main grid shows everything live for players (active +
// "pendingRemoval", which is still live until the next Store-event). The admin
// (detected via the session pointer the wheel stores) additionally sees two
// sections: "Future additions" (pending) and "Retired" (hidden).

// Same Google Drive thumbnail endpoint the wheel uses. Cards must be shared
// "Anyone with the link"; a broken image hides itself via the onerror handler.
const driveImg = (id) => `https://lh3.googleusercontent.com/d/${id}=w480`;
// Firebase-safe key from a commander name (must match encKey() in app.js).
const encKey = (s) => encodeURIComponent(String(s)).replace(/\./g, "%2E");
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}
function face(id, alt) {
  if (!id) return "";
  return `<img class="g-card" src="${driveImg(id)}" alt="${escapeHtml(alt)}" ` +
    `loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('broken')">`;
}

const grid = document.getElementById("gallery");
const countEl = document.getElementById("galleryCount");
const search = document.getElementById("gallerySearch");
const pendingSec = document.getElementById("galleryPendingSec");
const pendingList = document.getElementById("galleryPending");
const retiredSec = document.getElementById("galleryRetiredSec");
const retiredList = document.getElementById("galleryRetired");

// Admin overrides pulled from Firebase (empty until applyOverrides resolves).
let cardImages = {};   // encKey -> { img?, backImg? }
let cardMeta = {};     // encKey -> { partner }
let customCards = {};  // encKey -> { name, back?, img, backImg? }
let cardStatus = {};   // encKey -> { state }  — staged roster status
let isAdmin = false;   // whether this browser's stored session is the admin owner

// Combine the shipped list with admin-added custom cards, layer on partner-status,
// art, and staged-status overrides, then sort alphabetically. Mirrors
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
  }
  display = list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
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
    `<div class="g-name">${escapeHtml(c.name)}${flip}${partnerTag}${statusTag}</div>` +
    `</li>`;
}

function matchesFilter(c, q) {
  return !q || c.name.toLowerCase().includes(q) || (c.back && c.back.toLowerCase().includes(q));
}

// Show/hide + fill an admin-only section (empty → hidden).
function renderSection(sec, listEl, items) {
  if (!sec || !listEl) return;
  if (!items.length) { sec.style.display = "none"; listEl.innerHTML = ""; return; }
  sec.style.display = "";
  listEl.innerHTML = items.map(itemHtml).join("");
}

function render(filter = "") {
  const q = filter.trim().toLowerCase();
  // Main gallery: everything live for players (active + scheduled-for-removal).
  const main = display.filter((c) =>
    c.status !== "pending" && c.status !== "hidden" && matchesFilter(c, q));
  countEl.textContent = main.length;
  grid.innerHTML = main.length
    ? main.map(itemHtml).join("")
    : `<li class="g-empty">No commanders match “${escapeHtml(filter)}”.</li>`;

  // Admin-only staged sections (only shown to the admin owner's browser).
  const pending = isAdmin ? display.filter((c) => c.status === "pending" && matchesFilter(c, q)) : [];
  const retired = isAdmin ? display.filter((c) => c.status === "hidden" && matchesFilter(c, q)) : [];
  renderSection(pendingSec, pendingList, pending);
  renderSection(retiredSec, retiredList, retired);
}

// Detect the admin the same way app.js does: session pointer {username, key}
// (localStorage for "remember me", else sessionStorage) vs the claimed owner
// key. No login on this page — this only unlocks the read-only admin sections.
function detectAdmin(ownerKey) {
  if (!ownerKey) return false;
  try {
    const raw = localStorage.getItem("cw_session") || sessionStorage.getItem("cw_session");
    if (!raw) return false;
    const s = JSON.parse(raw);
    return !!(s && s.key && s.key === ownerKey);
  } catch { return false; }
}

rebuild();
render();
if (search) search.addEventListener("input", (e) => render(e.target.value));

// Pull the admin overrides (read-only) and re-render. Fast first paint uses the
// shipped list; this refreshes art, partner tags, admin-added cards, and (for the
// admin) the staged-roster sections.
(async function applyOverrides() {
  const url = firebaseConfig.databaseURL;
  if (!url || url.includes("REPLACE_ME")) return;
  const base = url.replace(/\/$/, "");
  const fetchJson = async (path) => {
    try { const res = await fetch(base + path); return res.ok ? (await res.json()) : null; }
    catch { return null; }
  };
  const [imgs, meta, custom, status, owner] = await Promise.all([
    fetchJson("/cardImages.json"),
    fetchJson("/cardMeta.json"),
    fetchJson("/customCards.json"),
    fetchJson("/cardStatus.json"),
    fetchJson("/admin/owner.json"),
  ]);
  cardImages = imgs || {};
  cardMeta = meta || {};
  customCards = custom || {};
  cardStatus = status || {};
  isAdmin = detectAdmin(owner);
  rebuild();
  render(search ? search.value : "");
})();
