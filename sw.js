let RUNNING = false;
let SOURCE_TAB_ID = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "START_ANALYSIS") {
    if (RUNNING) {
      sendResponse({ ok: false, error: "التحليل يعمل بالفعل" });
      return;
    }

    RUNNING = true;

    chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
      try {
        if (!tab?.id || !tab.url || !tab.url.includes("teepublic.com")) {
          RUNNING = false;
          sendResponse({ ok: false, error: "افتح صفحة TeePublic أولًا" });
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
      sendResponse(d.progress || { pct: 0, text: "Waiting..." });
    });
    return true;
  }
});

async function startAnalysis(filters) {
  try {
    await setProgress(0, "بدء التحليل...");

    const baseTabId = SOURCE_TAB_ID;
    const baseTab = await chrome.tabs.get(baseTabId);
    const baseUrl = new URL(baseTab.url);

    const pagesCount = Math.max(1, Number(filters.pagesCount || 1));
    const designsPerStore = clamp(Number(filters.designsPerStore || 5), 1, 50);

    // storeUrl -> appearances
    const storeAppearances = new Map();

    // ===== Stage A: scan pages -> store appearances (0..35) =====
    for (let p = 1; p <= pagesCount; p++) {
      await setProgress(
        Math.floor(((p - 1) / pagesCount) * 35),
        `جمع المتاجر من الصفحة ${p}/${pagesCount}`
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
          const t = await tabsCreateSafe({ url: designUrl, active: false });
          if (!t?.id) continue;

          try {
            const ok = await waitForStoreLinkSafe(t.id);
            if (!ok) continue;

            const [{ result: storeUrl }] = await chrome.scripting.executeScript({
              target: { tabId: t.id },
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
            await tabsRemoveSafe(t.id);
          }
        }
      } finally {
        await tabsRemoveSafe(pageTab.id);
      }
    }

    const storeUrls = Array.from(storeAppearances.keys());
    if (!storeUrls.length) {
      await setProgress(0, "خطأ: لم يتم العثور على متاجر");
      return;
    }

    // ===== Stage B: scrape stores + filter (35..60) =====
    const storeResults = [];
    let sIdx = 0;

    for (const storeUrl of storeUrls) {
      sIdx++;
      await setProgress(
        35 + Math.floor((sIdx / storeUrls.length) * 25),
        `تحليل المتاجر ${sIdx}/${storeUrls.length}`
      );

      const t = await tabsCreateSafe({ url: storeUrl, active: false });
      if (!t?.id) continue;

      try {
        const ok = await waitForSelectorSafe(t.id, ".m-store-head, h1");
        if (!ok) continue;

        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: t.id },
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
        await tabsRemoveSafe(t.id);
      }
    }

    // Sort stores: appearances desc, designs asc
    storeResults.sort((a, b) => {
      const aApp = a.appearances || 0;
      const bApp = b.appearances || 0;
      if (bApp !== aApp) return bApp - aApp;
      const aD = typeof a.designsCount === "number" ? a.designsCount : 999999999;
      const bD = typeof b.designsCount === "number" ? b.designsCount : 999999999;
      return aD - bD;
    });

    // ===== Stage C: analyze first N designs per store (60..90) =====
    await setProgress(60, `استخراج عناوين/وصف/كلمات مفتاحية (أول ${designsPerStore} تصميم لكل متجر)...`);

    const designRows = [];
    let storeCounter = 0;

    for (const store of storeResults) {
      storeCounter++;
      await setProgress(
        60 + Math.floor((storeCounter / storeResults.length) * 30),
        `تصاميم المتجر ${storeCounter}/${storeResults.length}`
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

    // ===== Stage D: export (95..100) =====
    await setProgress(95, "تصدير الملفات...");

    const storesCsv = makeStoresCSV(storeResults);
    await downloadCSV(
      storesCsv,
      `stores-pages-${pagesCount}-${new Date().toISOString().slice(0, 10)}.csv`
    );

    const designCsv = makeDesignCSV(designRows);
    await downloadCSV(
      designCsv,
      `designs-pages-${pagesCount}-N${designsPerStore}-${new Date().toISOString().slice(0, 10)}.csv`
    );

    await setProgress(100, "تم الانتهاء");
  } catch (e) {
    await setProgress(0, "خطأ عام: " + (e?.message || String(e)));
  }
}

function setProgress(pct, text) {
  return chrome.storage.local.set({ progress: { pct, text, ts: Date.now() } });
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

// ===== CSV EXPORTS =====

// ملف المتاجر (بدون Has Social و Artisan)
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

// ملف التصاميم: Title / Description / Keywords فقط
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
