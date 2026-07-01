import { COMMANDERS } from "./commanders.js";
import { firebaseConfig } from "./firebase-config.js";

// Static reference gallery. Renders every commander's card art in alphabetical
// order (front + back face for flip cards), with a simple filter. It reads (only)
// the admin card-art overrides from Firebase so it stays in sync with the wheel,
// but needs no login and falls back to the shipped art if that read fails.

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

const sorted = [...COMMANDERS].sort((a, b) =>
  a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));

const grid = document.getElementById("gallery");
const countEl = document.getElementById("galleryCount");
const search = document.getElementById("gallerySearch");

function render(filter = "") {
  const q = filter.trim().toLowerCase();
  const list = q
    ? sorted.filter((c) =>
        c.name.toLowerCase().includes(q) || (c.back && c.back.toLowerCase().includes(q)))
    : sorted;
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

render();
if (search) search.addEventListener("input", (e) => render(e.target.value));

// Pull admin card-art overrides (read-only) and re-render if any card's art was
// re-pointed. Fast first paint uses the shipped IDs; this just refreshes them.
(async function applyOverrides() {
  const url = firebaseConfig.databaseURL;
  if (!url || url.includes("REPLACE_ME")) return;
  try {
    const res = await fetch(url.replace(/\/$/, "") + "/cardImages.json");
    if (!res.ok) return;
    const ov = await res.json();
    if (!ov) return;
    let changed = false;
    for (const c of COMMANDERS) {
      const o = ov[encKey(c.name)];
      if (!o) continue;
      if (typeof o.img === "string" && o.img !== c.img) { c.img = o.img; changed = true; }
      if (typeof o.backImg === "string" && o.backImg !== c.backImg) { c.backImg = o.backImg; changed = true; }
    }
    if (changed) render(search ? search.value : "");
  } catch { /* offline / unconfigured — the shipped art is fine */ }
})();
