// Shared "📜 Rules" popup used on every page. The button (#rulesBtn) and the
// modal markup (#rulesModal / #rulesBody) live in each page's HTML; this wires
// open/close and returns a setText() the page calls with the current rules text
// (read live via the SDK on app.js pages, or over REST on the others).
export function initRulesModal() {
  const modal = document.getElementById("rulesModal");
  if (!modal) return { setText() {} };
  const btn = document.getElementById("rulesBtn");
  const body = document.getElementById("rulesBody");
  const open = () => { modal.hidden = false; };
  const close = () => { modal.hidden = true; };
  if (btn) btn.addEventListener("click", open);
  const closeBtn = document.getElementById("rulesClose");
  if (closeBtn) closeBtn.addEventListener("click", close);
  const backdrop = modal.querySelector(".modal-backdrop");
  if (backdrop) backdrop.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !modal.hidden) close(); });
  return {
    setText(t) {
      if (body) body.textContent = (t && String(t).trim()) ? String(t) : "No rules have been set yet.";
    },
  };
}
