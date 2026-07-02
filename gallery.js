import { COMMANDERS } from "./commanders.js";
import { firebaseConfig } from "./firebase-config.js";

// Static reference gallery. Renders every commander's card art in alphabetical
// order (front + back face for flip cards), with a simple filter. It reads (only)
// the admin overrides from Firebase — card art, partner status, and admin-added
// custom cards — so it stays in sync with the wheel, but needs no login and
// falls back to the shipped list if those reads fail.

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

// Admin overrides pulled from Firebase (empty until applyOverrides resolves).
let cardImages = {};   // encKey -> { img?, backImg? }
let cardMeta = {};     // encKey -> { partner }
let customCards = {};  // encKey -> { name, back?, img, backImg? }

// Combine the shipped list with admin-added custom cards, layer on partner-status
// and art overrides, then sort alphabetically. Mirrors rebuildCommanders() in app.js.
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
  }
  display = list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function render(filter = "") {
  const q = filter.trim().toLowerCase();
  const list = q
    ? display.filter((c) =>
        c.name.toLowerCase().includes(q) || (c.back && c.back.toLowerCase().includes(q)))
    : display;
  countEl.textContent = list.length;
  if (list.length === 0) {
    grid.innerHTML = `<li class="g-empty">No commanders match “${escapeHtml(filter)}”.</li>`;
    return;
  }
  grid.innerHTML = list.map((c) => {
    const faces = face(c.img, c.name) + (c.backImg ? face(c.backImg, c.back || c.name) : "");
    const flip = c.back ? `<span class="g-flip">// ${escapeHtml(c.back)}</span>` : "";
    const tag = c.partner ? `<span class="g-tag">🤝 partner</span>` : "";
    return `<li class="g-item${c.backImg ? " flip" : ""}">` +
      `<div class="g-faces">${faces}</div>` +
      `<div class="g-name">${escapeHtml(c.name)}${flip}${tag}</div>` +
      `</li>`;
  }).join("");
}

rebuild();
render();
if (search) search.addEventListener("input", (e) => render(e.target.value));

// Pull the admin overrides (read-only) and re-render. Fast first paint uses the
// shipped list; this refreshes art, partner tags, and any admin-added cards.
(async function applyOverrides() {
  const url = firebaseConfig.databaseURL;
  if (!url || url.includes("REPLACE_ME")) return;
  const base = url.replace(/\/$/, "");
  const fetchJson = async (path) => {
    try { const res = await fetch(base + path); return res.ok ? (await res.json()) : null; }
    catch { return null; }
  };
  const [imgs, meta, custom] = await Promise.all([
    fetchJson("/cardImages.json"),
    fetchJson("/cardMeta.json"),
    fetchJson("/customCards.json"),
  ]);
  cardImages = imgs || {};
  cardMeta = meta || {};
  customCards = custom || {};
  rebuild();
  render(search ? search.value : "");
})();
