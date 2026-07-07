// Shared "📜 Rules" popup used on every page. The button (#rulesBtn) and the
// modal markup (#rulesModal / #rulesBody) live in each page's HTML; this wires
// open/close and returns a setText() the page calls with the current rules text
// (read live via the SDK on app.js pages, or over REST on the others).
//
// Rules are authored in Markdown and rendered here. Because the leagueRules node
// is world-writable, the renderer HTML-ESCAPES the source FIRST and only then
// applies a small, safe Markdown subset — so no raw HTML/script can be injected,
// and link hrefs are restricted to http(s)/mailto.

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// Inline spans, applied to text that is ALREADY HTML-escaped.
function inlineMd(text) {
  let t = text;
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);            // `code`
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");              // **bold**
  t = t.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");          // *italic*
  t = t.replace(/(^|[^_])_([^_\s][^_]*)_/g, "$1<em>$2</em>");            // _italic_
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) => {       // [text](url)
    const safe = /^(https?:|mailto:)/i.test(url) ? url : "#";
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  return t;
}

// Block-level Markdown → safe HTML (headings, lists, hr, paragraphs, line breaks).
function renderMarkdown(md) {
  const lines = String(md == null ? "" : md).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [];
  let listType = null;   // "ul" | "ol" | null
  const flushPara = () => { if (para.length) { out.push(`<p>${para.join("<br>")}</p>`); para = []; } };
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { flushPara(); closeList(); continue; }
    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flushPara(); closeList();
      const level = m[1].length + 1;   // # → h2, ## → h3, ### → h4
      out.push(`<h${level}>${inlineMd(escapeHtml(m[2]))}</h${level}>`);
    } else if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushPara(); closeList(); out.push("<hr>");
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      flushPara();
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${inlineMd(escapeHtml(m[1]))}</li>`);
    } else if ((m = /^\s*\d+\.\s+(.*)$/.exec(line))) {
      flushPara();
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${inlineMd(escapeHtml(m[1]))}</li>`);
    } else {
      closeList();
      para.push(inlineMd(escapeHtml(line)));
    }
  }
  flushPara(); closeList();
  return out.join("\n");
}

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
      if (!body) return;
      body.innerHTML = (t && String(t).trim())
        ? renderMarkdown(t)
        : `<p class="rules-empty">No rules have been set yet.</p>`;
    },
  };
}
