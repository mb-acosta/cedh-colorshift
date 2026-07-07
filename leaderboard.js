import { firebaseConfig } from "./firebase-config.js";
import { initRulesModal } from "./rules-modal.js";

// Standings page. Reads accounts + points + champions over REST (like the gallery).
// The admin (detected via the wheel's stored session) gets +1 / −1 controls to
// award points per win; on the next "Store event & reset pool" (run from the wheel/
// admin page) the top scorer(s) get a 👑 until the following event and points reset.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

const listEl = document.getElementById("lbList");
const rules = initRulesModal();
const base = (firebaseConfig.databaseURL || "").replace(/\/$/, "");

let users = {};        // userKey -> { username, ... }
let points = {};       // userKey -> number (current event)
let champions = {};    // userKey -> true (reigning crown holders)
let isAdmin = false;

function getSession() {
  try {
    const raw = localStorage.getItem("cw_session") || sessionStorage.getItem("cw_session");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
const session = getSession();

// Sorted rows: highest points first, then name.
function rows() {
  return Object.entries(users).map(([key, u]) => ({
    key,
    name: (u && u.username) || key,
    pts: Number(points[key]) || 0,
    crown: champions[key] === true,
  })).sort((a, b) => b.pts - a.pts || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

function render() {
  const rs = rows();
  if (!rs.length) { listEl.innerHTML = `<li class="lb-empty">No registered accounts yet.</li>`; return; }
  listEl.innerHTML = rs.map((r, i) => {
    const crown = r.crown ? ` <span class="lb-crown" title="Reigning champion">👑</span>` : "";
    const ctrl = isAdmin
      ? `<span class="lb-ctrl">` +
          `<button class="lb-minus" type="button" data-key="${escapeHtml(r.key)}" title="Remove a point">−</button>` +
          `<button class="lb-plus" type="button" data-key="${escapeHtml(r.key)}" title="Add a point (win)">+1</button>` +
        `</span>`
      : "";
    return `<li class="lb-row${r.crown ? " champ" : ""}">` +
      `<span class="lb-rank">${i + 1}</span>` +
      `<span class="lb-name">${escapeHtml(r.name)}${crown}</span>` +
      `<span class="lb-pts">${r.pts}</span>${ctrl}</li>`;
  }).join("");
}

// Award/undo a point (admin). Optimistic local update, then a REST PUT (open rules,
// same as the gallery's reads). A reload resyncs if the write fails.
async function award(key, delta) {
  const next = Math.max(0, (Number(points[key]) || 0) + delta);
  points[key] = next;
  render();
  // Encode the key for the URL: user keys can contain %2E (dotted names), which the
  // REST layer would otherwise mis-decode — encodeURIComponent round-trips it exactly.
  try { await fetch(`${base}/points/${encodeURIComponent(key)}.json`, { method: "PUT", body: JSON.stringify(next) }); }
  catch { /* ignore — reload resyncs */ }
}

listEl.addEventListener("click", (e) => {
  const plus = e.target.closest(".lb-plus");
  const minus = e.target.closest(".lb-minus");
  if (plus) award(plus.dataset.key, 1);
  else if (minus) award(minus.dataset.key, -1);
});

render();   // fast (empty) first paint

(async function load() {
  if (!base || base.includes("REPLACE_ME")) { render(); return; }
  const fetchJson = async (p) => {
    try { const r = await fetch(base + p); return r.ok ? (await r.json()) : null; }
    catch { return null; }
  };
  const [u, p, c, owner, lr] = await Promise.all([
    fetchJson("/users.json"),
    fetchJson("/points.json"),
    fetchJson("/champions.json"),
    fetchJson("/admin/owner.json"),
    fetchJson("/leagueRules.json"),
  ]);
  users = u || {};
  points = p || {};
  champions = c || {};
  isAdmin = !!(owner && session && session.key && session.key === owner);
  rules.setText(lr && lr.text);
  const nav = document.getElementById("adminNav");
  if (nav) nav.style.display = isAdmin ? "inline-flex" : "none";
  render();
})();
