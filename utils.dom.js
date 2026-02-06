// Utilities that run inside the page context (collector/scraper)
window.__aaDom = {
  qs(sel, root = document) { return root.querySelector(sel); },
  qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); },

  text(el) { return (el?.textContent || "").trim(); },

  attr(el, name) { return (el?.getAttribute?.(name) || "").trim(); },

  absUrl(url) {
    try { return new URL(url, location.href).toString(); } catch { return ""; }
  },

  bgImageUrl(el) {
    if (!el) return "";
    const bg = getComputedStyle(el).backgroundImage || "";
    // background-image: url("...") or none
    const m = bg.match(/url\(["']?(.*?)["']?\)/i);
    return m?.[1] ? window.__aaDom.absUrl(m[1]) : "";
  },

  parseIntLoose(s) {
    const n = String(s || "").replace(/[^\d]/g, "");
    return n ? Number(n) : null;
  }
};
