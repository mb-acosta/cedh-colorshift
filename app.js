import { COMMANDERS } from "./commanders.js";
import { firebaseConfig, EVENT_ID } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getDatabase, ref, onValue, push, runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// ───────────────────────────── Config ─────────────────────────────
// How likely is the wheel to land on "PARTNER" vs a single commander?
//   "cards"  -> proportional to the number of partner CARDS in play (25)
//               vs available single cards (71). Partner odds start ~26%.
//   "combos" -> proportional to the number of partner COMBOS still open
//               (up to 300) vs single cards. Makes partners land ~80% of
//               the time early on. Pick this for a partner-heavy draft.
//   <number> -> a fixed weight (e.g. 30) for the whole PARTNER slice.
const PARTNER_ODDS = "cards";

// ──────────────────────────── Data split ──────────────────────────
const SINGLES = COMMANDERS.filter((c) => !c.partner);
const PARTNERS = COMMANDERS.filter((c) => c.partner);
const comboKey = (a, b) => [a, b].sort().join("  ||  ");
const NAME_MAP = new Map(COMMANDERS.map((c) => [c.name, c]));

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

// ───────────────────────────── Firebase ───────────────────────────
let db, assignmentsRef;
let assignments = {};            // live mirror of the DB
let usedSingles = new Set();     // single commander names already taken
let usedCombos = new Set();      // partner combo keys already taken
let firebaseReady = false;

function initFirebase() {
  if (firebaseConfig.apiKey === "REPLACE_ME") {
    setStatus("⚠ Firebase not configured yet — edit firebase-config.js (see README). Running in local preview mode.", "warn");
    return false;
  }
  try {
    const app = initializeApp(firebaseConfig);
    db = getDatabase(app);
    assignmentsRef = ref(db, `events/${EVENT_ID}/assignments`);
    onValue(assignmentsRef, (snap) => {
      assignments = snap.val() || {};
      recomputeUsed();
      firebaseReady = true;
      setStatus("● Connected — live", "ok");
      renderResults();
      renderStats();
      if (phase === "main" && !wheel.spinning) buildMainWheel();
      updateSpinButton();
    }, (err) => {
      setStatus("✖ Database error: " + err.message + " (check your Rules — see README)", "err");
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
  for (const id in assignments) {
    const a = assignments[id];
    if (a.type === "single") usedSingles.add(a.name);
    else if (a.type === "partner") usedCombos.add(comboKey(a.partnerA, a.partnerB));
  }
}

// ─────────────────────────── Pool helpers ─────────────────────────
const availableSingles = () => SINGLES.filter((c) => !usedSingles.has(c.name));

function comboOpen(a, b) { return !usedCombos.has(comboKey(a, b)); }

// partner cards that still have at least one open combo with another partner
function partnersInPlay() {
  return PARTNERS.filter((x) =>
    PARTNERS.some((y) => y.name !== x.name && comboOpen(x.name, y.name)));
}

function openComboCount() {
  let n = 0;
  for (let i = 0; i < PARTNERS.length; i++)
    for (let j = i + 1; j < PARTNERS.length; j++)
      if (comboOpen(PARTNERS[i].name, PARTNERS[j].name)) n++;
  return n;
}

function partnerSliceWeight() {
  if (openComboCount() === 0) return 0;
  if (PARTNER_ODDS === "cards") return partnersInPlay().length;
  if (PARTNER_ODDS === "combos") return openComboCount();
  return Number(PARTNER_ODDS) || 0;
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
  const singles = availableSingles().map((c, i) => ({
    label: c.name, weight: 1, kind: "single", payload: c,
    color: SINGLE_COLORS[i % SINGLE_COLORS.length],
  }));
  const pw = partnerSliceWeight();
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
  let list;
  if (!excludeName) {
    list = partnersInPlay();
    setWheelTitle("Partner Wheel — spin for your FIRST partner");
  } else {
    list = PARTNERS.filter((y) => y.name !== excludeName && comboOpen(excludeName, y.name));
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
    const uS = new Set(), uC = new Set();
    for (const id in current) {
      const a = current[id];
      if (a.type === "single") uS.add(a.name);
      else if (a.type === "partner") uC.add(comboKey(a.partnerA, a.partnerB));
    }
    if (!isFree(uS, uC)) return; // abort — someone else took it
    current[key] = entry;
    return current;
  }).then((res) => ({ committed: res.committed }));
}

// ──────────────────────────────── UI ──────────────────────────────
const $ = (id) => document.getElementById(id);
let wheel;
let phase = "main";   // main | partner1 | partner2
let partnerA = null;

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

function nameOk() {
  const v = $("discord").value.trim();
  if (!v) { showResult("Enter your Discord name first ☝️", "err"); return null; }
  return v;
}

function updateSpinButton() {
  const btn = $("spinBtn");
  if (phase === "main") {
    const done = availableSingles().length === 0 && partnerSliceWeight() === 0;
    btn.disabled = done || wheel.spinning;
    btn.textContent = done ? "All commanders assigned 🎉" : "SPIN";
  } else if (phase === "partner1") {
    btn.textContent = "Spin for Partner 1";
  } else if (phase === "partner2") {
    btn.textContent = "Spin for Partner 2";
  }
}

async function onSpin() {
  const name = nameOk();
  if (!name) return;
  if (wheel.spinning) return;
  $("spinBtn").disabled = true;
  $("discord").disabled = true;

  if (phase === "main") {
    buildMainWheel();
    const w = await wheel.spin();
    if (!w) { resetToMain(); return; }
    if (w.kind === "single") {
      const c = w.payload;
      const ok = await commit(
        { discord: name, type: "single", name: c.name, back: c.back || null, ts: Date.now() },
        (uS) => !uS.has(c.name),
      );
      if (ok.committed) {
        const flip = c.back ? ` <span class="flip">// ${c.back}</span>` : "";
        showResult(`<div class="cards">${cardsForName(c.name, "big")}</div>` +
          `🎴 <b>${name}</b> got <b>${c.name}</b>${flip}`, "ok");
        resetToMain();
      } else {
        showResult(`😬 <b>${c.name}</b> was just taken by someone else. Spin again!`, "err");
        resetToMain();
      }
    } else { // partner slice
      phase = "partner1";
      partnerA = null;
      const n = buildPartnerWheel(null);
      showResult(`🤝 <b>PARTNER!</b> The partner wheel is loaded (${n} options). Spin again for your first partner.`, "partner");
      $("spinBtn").disabled = false;
      $("discord").disabled = false;
      updateSpinButton();
    }
    return;
  }

  if (phase === "partner1") {
    buildPartnerWheel(null);
    const w = await wheel.spin();
    if (!w) { resetToMain(); return; }
    partnerA = w.payload.name;
    phase = "partner2";
    const n = buildPartnerWheel(partnerA);
    if (n === 0) {
      showResult(`All combos for <b>${partnerA}</b> are taken — spinning for a new first partner.`, "err");
      phase = "partner1"; partnerA = null; buildPartnerWheel(null);
    } else {
      showResult(`<div class="cards">${cardsForName(partnerA, "big")}</div>` +
        `First partner: <b>${partnerA}</b>. Spin again for your second (${n} options).`, "partner");
    }
    $("spinBtn").disabled = false;
    $("discord").disabled = false;
    updateSpinButton();
    return;
  }

  if (phase === "partner2") {
    buildPartnerWheel(partnerA);
    const w = await wheel.spin();
    if (!w) { resetToMain(); return; }
    const b = w.payload.name;
    const ok = await commit(
      { discord: name, type: "partner", partnerA, partnerB: b, ts: Date.now() },
      (uS, uC) => !uC.has(comboKey(partnerA, b)),
    );
    if (ok.committed) {
      showResult(`<div class="cards">${cardsForName(partnerA, "big")}${cardsForName(b, "big")}</div>` +
        `🤝 <b>${name}</b> got <b>${partnerA}</b> + <b>${b}</b>`, "ok");
      resetToMain();
    } else {
      showResult(`😬 <b>${partnerA} + ${b}</b> was just taken. Spinning again for partner two.`, "err");
      phase = "partner2";
      buildPartnerWheel(partnerA);
      $("spinBtn").disabled = false;
      $("discord").disabled = false;
      updateSpinButton();
    }
    return;
  }
}

function resetToMain() {
  phase = "main";
  partnerA = null;
  buildMainWheel();
  $("discord").disabled = false;
  updateSpinButton();
}

// ──────────────────────────── Rendering ───────────────────────────
function renderStats() {
  const s = availableSingles().length;
  const c = openComboCount();
  $("stats").innerHTML =
    `<span>${s}</span> single commanders left &nbsp;•&nbsp; <span>${c}</span> partner combos open`;
}

function renderResults() {
  const list = Object.values(assignments).sort((a, b) => (b.ts || 0) - (a.ts || 0));
  $("resultsCount").textContent = list.length;
  if (list.length === 0) {
    $("results").innerHTML = `<li class="empty">No assignments yet — be the first to spin!</li>`;
    return;
  }
  $("results").innerHTML = list.map((a) => {
    const who = escapeHtml(a.discord || "?");
    if (a.type === "single") {
      const flip = a.back ? `<span class="flip"> // ${escapeHtml(a.back)}</span>` : "";
      return `<li><div class="thumbs">${cardsForName(a.name, "thumb")}</div>` +
        `<div class="info"><span class="who">${who}</span>` +
        `<span class="got">${escapeHtml(a.name)}${flip}</span></div></li>`;
    }
    return `<li><div class="thumbs">${cardsForName(a.partnerA, "thumb")}${cardsForName(a.partnerB, "thumb")}</div>` +
      `<div class="info"><span class="who">${who}</span>` +
      `<span class="got partner">${escapeHtml(a.partnerA)} <b>+</b> ${escapeHtml(a.partnerB)}</span></div></li>`;
  }).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// ───────────────────────────── Admin ──────────────────────────────
function setupAdmin() {
  if (location.hash !== "#admin") return;
  $("adminBar").style.display = "flex";
  $("resetBtn").addEventListener("click", async () => {
    if (!confirm("Clear ALL assignments for this event? This cannot be undone.")) return;
    if (!firebaseReady) { assignments = {}; recomputeUsed(); renderResults(); renderStats(); resetToMain(); return; }
    await runTransaction(assignmentsRef, () => null);
    resetToMain();
  });
}

// ───────────────────────────── Boot ───────────────────────────────
function boot() {
  wheel = new Wheel($("wheel"));
  buildMainWheel();
  renderStats();
  renderResults();
  $("spinBtn").addEventListener("click", onSpin);
  $("discord").addEventListener("keydown", (e) => { if (e.key === "Enter") onSpin(); });
  setupAdmin();
  initFirebase();
  updateSpinButton();
}

boot();
