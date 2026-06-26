import { COMMANDERS } from "./commanders.js";

// Static reference gallery — no Firebase. Renders every commander's card art in
// alphabetical order (front + back face for flip cards), with a simple filter.

// Same Google Drive thumbnail endpoint the wheel uses. Cards must be shared
// "Anyone with the link"; a broken image hides itself via the onerror handler.
const driveImg = (id) => `https://lh3.googleusercontent.com/d/${id}=w480`;
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
