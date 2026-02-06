let RUNNING = false;
let SOURCE_TAB_ID = null;

let UI_LANG = "ar";

const I18N = {
  ar: {
    start: "بدء التحليل...",
    collect: "جمع المتاجر من الصفحة",
    stores: "تحليل المتاجر",
    designs: "استخراج عناوين/وصف/كلمات مفتاحية",
    exporting: "تصدير الملفات...",
    done: "تم الانتهاء",
    err: "خطأ: ",
    pages: "الصفحة",
    of: "/",
    store: "المتجر",
    design: "تصميم"
  },
  en: {
    start: "Starting...",
    collect: "Collecting stores from page",
    stores: "Analyzing stores",
    designs: "Extracting titles/description/keywords",
    exporting: "Exporting files...",
    done: "Done",
    err: "Error: ",
    pages: "Page",
    of: "/",
    store: "Store",
    design: "Design"
  },
  fr: {
    start: "Démarrage...",
    collect: "Collecte des boutiques depuis la page",
    stores: "Analyse des boutiques",
    designs: "Extraction titre/description/mots-clés",
    exporting: "Export des fichiers...",
    done: "Terminé",
    err: "Erreur : ",
    pages: "Page",
    of: "/",
    store: "Boutique",
    design: "Design"
  },
  es: {
    start: "Iniciando...",
    collect: "Recolectando tiendas de la página",
    stores: "Analizando tiendas",
    designs: "Extrayendo título/descripción/keywords",
    exporting: "Exportando archivos...",
    done: "Hecho",
    err: "Error: ",
    pages: "Página",
    of: "/",
    store: "Tienda",
    design: "Diseño"
  },
  de: {
    start: "Start...",
    collect: "Shops sammeln von Seite",
    stores: "Shops analysieren",
    designs: "Titel/Beschreibung/Keywords extrahieren",
    exporting: "Dateien exportieren...",
    done: "Fertig",
    err: "Fehler: ",
    pages: "Seite",
    of: "/",
    store: "Shop",
    design: "Design"
  }
};

function t(key) {
  const dict = I18N[UI_LANG] || I18N.en;
  return dict[key] ?? (I18N.en[key] ?? key);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "START_ANALYSIS") {
    if (RUNNING) {
      sendResponse({ ok: false, error: "Already running" });
      return;
    }

    RUNNING = true;
    UI_LANG = msg?.filters?.uiLang || "ar";

    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      try {
        if (!tab?.id || !tab.url || !tab.url.includes("teepublic.com")) {
          RUNNING = false;
          sendResponse({ ok: false, error: "Open TeePublic first" });
          return;
        }

        SOURCE_TAB_ID = tab.id;

        startAnalysis(msg.filters || {})
          .finally(() => {
            RUNNING = false;
            SOURCE_TAB_ID = null;
          });

        sendResponse({ ok: true });
      } catch (e) {
        RUNNING = false;
        SOURCE_TAB_ID = null;
        sendResponse({ ok: false, error: e?.message || String(e) });
      }
    });

    return true;
  }

  if (msg?.type === "GET_PROGRESS") {
    chrome.storage.local.get("progress", d => {
      sendResponse(d.progress || { pct: 0, text: t("start") });
    });
    return true;
  }
});

async function startAnalysis(filters) {
  try {
    await setProgress(0, t("start"));

    const baseTabId = SOURCE_TAB_ID;
    const baseTab = await chrome.tabs.get(baseTabId);
    const baseUrl = new URL(baseTab.url);

    const pagesCount = Math.max(1, Number(filters.pagesCount || 1));
    const designsPerStore = clamp(Number(filters.designsPerStore || 5), 1, 50);

    const storeAppearances = new Map();

    // Stage A
    for (let p = 1; p <= pagesCount; p++) {
      await setProgress(
        Math.floor(((p - 1) / pagesCount) * 35),
        `${t("collect")} ${p}${t("of")}${pagesCount}`
      );

      const pageUrl = new URL(baseUrl.toString());
      if (p > 1) pageUrl.searchParams.set("page", String(p));

      const pageTab = await tabsCreateSafe({ url: pageUrl.toString(), active: false });
      if (!pageTab?.id) continue;

      try {
        await wait(1600);

        const [{ result: designLinks }] = await chrome.scripting.executeScript({
          target: { tabId: pageTab.id },
          files: ["scripts/collector.search.js"]
        });

        const links = Array.isArray(designLinks) ? designLinks : [];

        for (const designUrl of links) {
          const ttab = await tabsCreateSafe({ url: designUrl, active: false });
          if (!ttab?.id) continue;

          try {
            const ok = await waitForStoreLinkSafe(ttab.id);
            if (!ok) continue;

            const [{ result: storeUrl }] = await chrome.scripting.executeScript({
              target: { tabId: ttab.id },
              func: () => {
                const a = document.querySelector('a[href^="/user/"]');
                return a ? new URL(a.href).toString().replace(/\/+$/, "") : "";
              }
            });

            if (storeUrl) {
              storeAppearances.set(storeUrl, (storeAppearances.get(storeUrl) || 0) + 1);
            }
          } catch {
          } finally {
            await tabsRemoveSafe(ttab.id);
          }
        }
      } finally {
        await tabsRemoveSafe(pageTab.id);
      }
    }

    const storeUrls = Array.from(storeAppearances.keys());
    if (!storeUrls.length) {
      await setProgress(0, t("err") + "No stores found");
      return;
    }

    // Stage B
    const storeResults = [];
    let sIdx = 0;

    for (const storeUrl of storeUrls) {
      sIdx++;
      await setProgress(
        35 + Math.floor((sIdx / storeUrls.length) * 25),
        `${t("stores")} ${sIdx}${t("of")}${storeUrls.length}`
      );

      const tab = await tabsCreateSafe({ url: storeUrl, active: false });
      if (!tab?.id) continue;

      try {
        const ok = await waitForSelectorSafe(tab.id, ".m-store-head, h1");
        if (!ok) continue;

        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["scripts/scraper.store.js"]
        });

        const r = { ...result, storeUrl };
        r.appearances = storeAppearances.get(storeUrl) || 1;

        if (filters.noSocialOnly && r.hasSocial) continue;

        if (typeof r.designsCount === "number") {
          if (r.designsCount < Number(filters.minDesigns || 0)) continue;
          if (r.designsCount > Number(filters.maxDesigns || 999999)) continue;
        }

        storeResults.push(r);
      } catch {
      } finally {
        await tabsRemoveSafe(tab.id);
      }
    }

    storeResults.sort((a, b) => {
      const aApp = a.appearances || 0;
      const bApp = b.appearances || 0;
      if (bApp !== aApp) return bApp - aApp;
      const aD = typeof a.designsCount === "number" ? a.designsCount : 999999999;
      const bD = typeof b.designsCount === "number" ? b.designsCount : 999999999;
      return aD - bD;
    });

    // Stage C
    await setProgress(60, `${t("designs")} (${designsPerStore})`);

    const designRows = [];
    let storeCounter = 0;

    for (const store of storeResults) {
      storeCounter++;
      await setProgress(
        60 + Math.floor((storeCounter / storeResults.length) * 30),
        `${t("designs")} ${storeCounter}${t("of")}${storeResults.length}`
      );

      const storeTab = await tabsCreateSafe({ url: store.storeUrl, active: false });
      if (!storeTab?.id) continue;

      try {
        const ok = await waitForSelectorSafe(storeTab.id, ".m-store-head, h1");
        if (!ok) continue;

        const [{ result: designLinks }] = await chrome.scripting.executeScript({
          target: { tabId: storeTab.id },
          files: ["scripts/collector.store.designs.js"]
        });

        const links = Array.isArray(designLinks) ? designLinks : [];
        const firstN = links.slice(0, designsPerStore);

        for (const designUrl of firstN) {
          const dTab = await tabsCreateSafe({ url: designUrl, active: false });
          if (!dTab?.id) continue;

          try {
            const ok2 = await waitForSelectorSafe(dTab.id, "h1, meta[property='og:title']");
            if (!ok2) continue;

            const [{ result: data }] = await chrome.scripting.executeScript({
              target: { tabId: dTab.id },
              files: ["scripts/scraper.design.js"]
            });

            if (!data) continue;

            designRows.push({
              storeName: store.storeName || "",
              storeUrl: store.storeUrl,
              designUrl,
              title: data.title || "",
              description: data.description || "",
              keywords: data.keywords || ""
            });
          } catch {
          } finally {
            await tabsRemoveSafe(dTab.id);
          }
        }
      } finally {
        await tabsRemoveSafe(storeTab.id);
      }
    }

    // Stage D
    await setProgress(95, t("exporting"));

    const storesCsv = makeStoresCSV(storeResults);
    await downloadCSV(storesCsv, `stores-pages-${pagesCount}-${new Date().toISOString().slice(0, 10)}.csv`);

    const designCsv = makeDesignCSV(designRows);
    await downloadCSV(designCsv, `designs-pages-${pagesCount}-N${designsPerStore}-${new Date().toISOString().slice(0, 10)}.csv`);

    await setProgress(100, t("done"));
  } catch (e) {
    await setProgress(0, t("err") + (e?.message || String(e)));
  }
}

function setProgress(pct, text) {
  return chrome.storage.local.set({ progress: { pct, text, ts: Date.now(), lang: UI_LANG } });
}

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function isTabsBusyError(err) {
  const m = (err?.message || String(err) || "").toLowerCase();
  return m.includes("tabs cannot be edited right now") || m.includes("dragging a tab");
}

async function tabsCreateSafe(createProps, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.tabs.create(createProps);
    } catch (e) {
      if (isTabsBusyError(e)) {
        await wait(200 + i * 120);
        continue;
      }
      await wait(150);
    }
  }
  return null;
}

async function tabsRemoveSafe(tabId, tries = 12) {
  for (let i = 0; i < tries; i++) {
    try {
      await chrome.tabs.remove(tabId);
      return true;
    } catch (e) {
      if (isTabsBusyError(e)) {
        await wait(200 + i * 120);
        continue;
      }
      await wait(150);
    }
  }
  return false;
}

async function waitForStoreLinkSafe(tabId) {
  for (let i = 0; i < 20; i++) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => !!document.querySelector('a[href^="/user/"]')
      });
      if (result) return true;
    } catch {}
    await wait(300);
  }
  return false;
}

async function waitForSelectorSafe(tabId, sel) {
  for (let i = 0; i < 20; i++) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: s => !!document.querySelector(s),
        args: [sel]
      });
      if (result) return true;
    } catch {}
    await wait(300);
  }
  return false;
}

async function downloadCSV(csvText, filename) {
  const dataUrl = "data:text/csv;charset=utf-8," + encodeURIComponent(csvText);
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: true });
}

function makeStoresCSV(rows) {
  const headers = ["Store Name", "Store", "Designs", "Appearances", "Social Links"];
  const lines = [headers.join(",")];

  for (const r of rows) {
    lines.push([
      `"${esc(r.storeName)}"`,
      `"=HYPERLINK(""${esc(r.storeUrl)}"",""OPEN STORE"")"`,
      `"${esc(r.designsCount ?? "")}"`,
      `"${esc(r.appearances ?? 1)}"`,
      `"${esc(r.socialLinks || "")}"`
    ].join(","));
  }
  return lines.join("\n");
}

function makeDesignCSV(rows) {
  const headers = ["Store", "Design", "Title", "Description", "Keywords"];
  const lines = [headers.join(",")];

  for (const r of rows) {
    lines.push([
      `"=HYPERLINK(""${esc(r.storeUrl)}"",""OPEN STORE"")"`,
      `"=HYPERLINK(""${esc(r.designUrl)}"",""OPEN DESIGN"")"`,
      `"${esc(cleanCell(r.title))}"`,
      `"${esc(cleanCell(r.description))}"`,
      `"${esc(cleanCell(r.keywords))}"`
    ].join(","));
  }
  return lines.join("\n");
}

function cleanCell(s) {
  return String(s ?? "")
    .replace(/\r\n/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function esc(v) {
  return String(v ?? "").replace(/"/g, '""');
}
