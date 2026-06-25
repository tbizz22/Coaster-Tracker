// Headless-browser scraper for Six Flags / Cedar Fair park "attractions" pages.
// These pages fetch attraction data from an Algolia search index whose records
// carry the authoritative height policy:
//   minHeightAlone           — minimum height to ride unaccompanied
//   minHeightAccompanied     — minimum height with a supervising companion (0 = none posted)
//   isNoMinimumHeightAccompanied — true when there is no minimum if accompanied
//
// Strategy: load the real page (so it issues an authenticated Algolia request
// with the current API key + the park's own parkId filter), capture that request,
// then replay it with a large hitsPerPage to fetch every coaster in one shot.
// This avoids hard-coding the (rotatable) API key, app id, index, or parkId.

import { chromium } from "playwright";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Map a raw Algolia hit → our height fields. Returns null min when unposted.
function mapHit(h) {
  const alone = Number(h.minHeightAlone) || 0;
  const acc   = Number(h.minHeightAccompanied) || 0;
  let minAccompanied = null;
  if (h.isNoMinimumHeightAccompanied) minAccompanied = 0;   // anyone may ride if accompanied
  else if (acc > 0) minAccompanied = acc;
  return {
    name: String(h.name || "").trim(),
    min: alone > 0 ? alone : null,
    minAccompanied,
    speedMph: null, // not present in this index; left for future enrichment
  };
}

export async function scrapeParkHeights(officialUrl, { timeoutMs = 60000 } = {}) {
  if (!officialUrl) throw new Error("No official URL provided for this park.");

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent: UA });

    let captured = null;
    page.on("request", (r) => {
      if (!captured && r.url().includes("algolia.net") && r.method() === "POST") {
        captured = { url: r.url(), postData: r.postData() };
      }
    });

    await page.goto(officialUrl, { waitUntil: "networkidle", timeout: timeoutMs }).catch(() => {});
    // Give the search request a moment if networkidle resolved early
    for (let i = 0; i < 8 && !captured; i++) await page.waitForTimeout(500);

    if (!captured) throw new Error("Could not capture the park's attraction search request (page layout may have changed).");

    // Replay the captured query with a large page size to fetch all coasters.
    const hits = await page.evaluate(async ({ url, postData }) => {
      let body;
      try { body = JSON.parse(postData); } catch { return null; }
      for (const rq of body.requests || []) {
        const p = new URLSearchParams(rq.params || "");
        p.set("hitsPerPage", "1000");
        p.set("page", "0");
        rq.params = p.toString();
        if (typeof rq.hitsPerPage === "number") rq.hitsPerPage = 1000;
        if (typeof rq.page === "number") rq.page = 0;
      }
      const resp = await fetch(url, { method: "POST", body: JSON.stringify(body) });
      const json = await resp.json();
      return (json.results || []).flatMap(r => r.hits || []);
    }, captured);

    if (!hits) throw new Error("Failed to parse the attraction search response.");

    // Keep only coasters (the page already filters by category, but be defensive).
    const coasters = hits
      .filter(h => (h.categories || []).some(c => /coaster/i.test(c)) || /coaster/i.test(h.rollupKey || ""))
      .map(mapHit)
      .filter(c => c.name);

    return coasters;
  } finally {
    await browser.close();
  }
}
