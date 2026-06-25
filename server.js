// Stateless scraper service: RCDB lookup, Wikipedia height-fill, and the
// official-attractions-page scraper. Riders/parks/settings/credits persistence
// moved to Supabase (see src/supabaseClient.js) — this server holds no data of
// its own; every endpoint here takes the caller's current park(s) in the
// request body/query and returns proposed results for the client to apply.
import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";
import { scrapeParkHeights } from "./scrape-heights.js";

const app = express();
// FRONTEND_URL = the deployed SPA's origin (comma-separated for multiple).
// Falls back to wide-open in dev, where the Vite proxy means CORS rarely
// matters, but production should set this so only our own frontend can call in.
const allowedOrigins = process.env.FRONTEND_URL?.split(",").map(s => s.trim());
app.use(cors({ origin: allowedOrigins ?? true }));
app.use(express.json({ limit: "5mb" })); // batch endpoints post the full parks array

// ── Coaster lookup via RCDB ────────────────────────────────────────────────
const RCDB_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml",
};

// Parse coasters from an RCDB park page HTML
function parseRcdbParkPage(html) {
  const $ = cheerio.load(html);
  const parkName = $("title").text().replace(/\s*\(.*\)\s*/g, "").trim();
  const coasters = [];
  const seen = new Set();

  // RCDB park pages have separate tables per status group:
  //   Operating → headers include "opened" but not "closed" or "opening"
  //   Removed   → headers include "closed"
  //   Upcoming  → headers include "opening"
  $("table").each((_, tbl) => {
    const headers = $(tbl).find("tr").first().find("th, td")
      .map((_, c) => $(c).text().trim().toLowerCase()).get();

    if (!headers.includes("name")) return;

    let tableStatus;
    if      (headers.includes("opening")) tableStatus = "Upcoming";
    else if (headers.includes("closed"))  tableStatus = "Removed";
    else                                  tableStatus = "Operating";

    $(tbl).find("tr").each((ri, row) => {
      if (ri === 0) return;
      const cells = $(row).find("td");
      if (cells.length < 4) return;

      // col 0=image, col 1=name (with link to coaster page), col 2=material, col 3=design, col 4=scale
      const nameLink = $(cells[1]).find("a").first();
      const name = (nameLink.text().trim() || $(cells[1]).text().trim()).replace(/\s+/g, " ");
      if (!name || name.length < 2 || name.length > 80) return;
      if (seen.has(name.toLowerCase())) return;
      seen.add(name.toLowerCase());

      const rcdbPath = nameLink.attr("href") || null; // e.g. "/1.htm"
      // NOT manufacturer/model despite appearances — this is the park-listing
      // page, where RCDB only exposes construction material (Steel/Wood) and
      // train layout (Sit Down/Inverted/Suspended/…), e.g. "Steel Sit Down".
      // Real manufacturer/model ("B&M", "Intamin") lives on the individual
      // coaster's own RCDB page, which fill-speeds already fetches for speed —
      // see the open backlog item to pull manufacturer/model from there too.
      const material = $(cells[2]).text().trim();
      const design   = $(cells[3]).text().trim();
      const type      = [material, design].filter(Boolean).join(" ");
      const scale    = cells[4] ? $(cells[4]).text().trim() : ""; // Extreme/Thrill/Family/Kiddie

      coasters.push({ name, type, status: tableStatus, rcdbPath, scale });
    });
  });

  return { parkName, coasters };
}

// Parse a "Quick Search Results" page and return park suggestions
function parseRcdbSearchResults(html) {
  const $ = cheerio.load(html);
  // RCDB groups results in <section> elements with descriptive <h3> headings
  // Section types for parks: "is named", "name starts with", "names contain"
  // We ignore roller coaster sections
  const ranked = []; // { rank, name, path, location }

  $("section").each((_, sec) => {
    const heading = $(sec).find("h3").text().toLowerCase();
    if (!heading.includes("amusement park")) return; // skip coaster sections

    const rank = heading.includes("is named") ? 0
      : heading.includes("starts with")       ? 1
      : heading.includes("contains")          ? 2 : 3;

    $(sec).find("p").each((_, p) => {
      const firstLink = $(p).find("a[href]").first();
      const href = firstLink.attr("href") || "";
      if (!/^\/\d+\.htm$/.test(href)) return;
      const name     = firstLink.text().trim();
      // Remaining text after removing the park name link = location
      const location = $(p).text().replace(name, "").replace(/[()]/g, "").trim();
      ranked.push({ rank, name, path: href, location });
    });
  });

  // Sort by rank (exact match first)
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked;
}

app.get("/api/lookup-coasters", async (req, res) => {
  const q    = (req.query.q    || "").trim();
  const path = (req.query.path || "").trim(); // direct park path e.g. /4534.htm

  if (!q && !path) return res.status(400).json({ error: "Provide q or path" });

  try {
    let html, parkUrl;

    if (path) {
      // Direct fetch of a specific park page
      const resp = await fetch(`https://rcdb.com${path}`, { headers: RCDB_HEADERS });
      html    = await resp.text();
      parkUrl = resp.url;
    } else {
      // Search — RCDB redirects to park page on exact match, else shows search results
      const resp = await fetch(`https://rcdb.com/qs.htm?qs=${encodeURIComponent(q)}`, { headers: RCDB_HEADERS });
      html    = await resp.text();
      parkUrl = resp.url;

      // Check if we landed on a search results page
      const $ = cheerio.load(html);
      const title = $("title").text().trim();

      if (title === "Quick Search Results") {
        const suggestions = parseRcdbSearchResults(html);

        if (suggestions.length === 0) {
          return res.json({ coasters: [], message: `No parks found matching "${q}" on RCDB.` });
        }

        // Auto-follow if there's exactly one high-confidence (rank 0 or 1) result
        const topRank = suggestions[0].rank;
        const topGroup = suggestions.filter(s => s.rank === topRank);

        if (topGroup.length === 1 && topRank <= 1) {
          // Single clear match — fetch it automatically
          const resp2 = await fetch(`https://rcdb.com${topGroup[0].path}`, { headers: RCDB_HEADERS });
          html    = await resp2.text();
          parkUrl = resp2.url;
          // Fall through to parse below
        } else {
          // Multiple matches — return suggestions so user can pick
          return res.json({ coasters: [], suggestions, message: `Multiple parks matched "${q}" — pick one:` });
        }
      }
    }

    // Parse the park page
    const { parkName, coasters } = parseRcdbParkPage(html);

    if (coasters.length === 0) {
      return res.json({
        coasters: [],
        parkUrl,
        message: parkName
          ? `Found "${parkName}" on RCDB but no coasters were listed — it may not be a coaster park.`
          : `Couldn't parse coasters from this page. Try searching by exact park name from rcdb.com.`,
      });
    }

    res.json({ coasters, source: `RCDB: ${parkName}`, parkUrl, parkName });

  } catch (err) {
    res.status(500).json({ error: `RCDB lookup failed: ${err.message}` });
  }
});

// ── Fill missing heights via Wikipedia ────────────────────────────────────
const WP      = "https://en.wikipedia.org/w/api.php";
const WP_HDRS = { "User-Agent": "CoasterTracker/1.0 (personal roller coaster tracker)" };

const HEIGHT_PATTERNS = [
  /\|\s*restrict(?:ion)?[^=\n]*=[^\d]*(\d{2})/i,
  /\|\s*height[_\s]req(?:uirement)?[^=\n]*=[^\d]*(\d{2})/i,
  /height[^{]{0,20}\{\{convert\|(\d{2})\|in/i,
  /require[^{]{0,20}\{\{convert\|(\d{2})\|in/i,
  /minimum[^.\n]{0,60}?(\d{2})\s*(?:in\b|inch|")/i,
  /must be[^.\n]{0,60}?(\d{2})\s*(?:in\b|inch|")/i,
];

// Interruptible sleep — resolves early if isAborted() becomes true (polls every 250ms)
const sleep = (ms, isAborted = () => false) => new Promise(resolve => {
  const end = Date.now() + ms;
  const tick = () => {
    if (isAborted() || Date.now() >= end) return resolve();
    setTimeout(tick, Math.min(250, end - Date.now()));
  };
  tick();
});

// Global rate limiter — enforces minimum 1200ms between any two Wikipedia requests
let lastWpRequestAt = 0;
let fillHeightsRunning = false;

async function wpFetch(url, isAborted = () => false, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    if (isAborted()) return null;

    // Enforce global minimum interval
    const gap = Date.now() - lastWpRequestAt;
    if (gap < 1200) await sleep(1200 - gap, isAborted);
    if (isAborted()) return null;
    lastWpRequestAt = Date.now();

    const resp = await fetch(url, { headers: WP_HDRS });
    const text = await resp.text();

    if (resp.status === 429 || text.startsWith("You are making too many")) {
      const wait = 5000 * (attempt + 1); // 5s, 10s, 15s
      console.log(`[Wikipedia] Rate limited — waiting ${wait / 1000}s (attempt ${attempt + 1}/${retries})`);
      lastWpRequestAt = Date.now() + wait; // push back window
      await sleep(wait, isAborted);
      continue;
    }

    try { return JSON.parse(text); }
    catch { return null; }
  }
  console.log(`[Wikipedia] Gave up: ${new URL(url).pathname}?${new URL(url).searchParams.get("srsearch") || new URL(url).searchParams.get("titles") || ""}`);
  return null;
}

async function lookupHeightFromWikipedia(coasterName, isAborted = () => false) {
  const searchData = await wpFetch(
    `${WP}?action=query&list=search&srsearch=${encodeURIComponent(coasterName + " roller coaster")}&format=json&srlimit=3`,
    isAborted
  );
  if (!searchData) return null;

  for (const result of (searchData.query?.search || [])) {
    if (isAborted()) return null;
    const data = await wpFetch(
      `${WP}?action=query&titles=${encodeURIComponent(result.title)}&prop=revisions&rvprop=content&rvslots=main&format=json`,
      isAborted
    );
    if (!data) continue;

    const wikitext = Object.values(data.query?.pages || {})[0]
      ?.revisions?.[0]?.slots?.main?.["*"] || "";

    for (const pat of HEIGHT_PATTERNS) {
      const m = wikitext.match(pat);
      if (m) {
        const h = parseInt(m[1]);
        if (h >= 30 && h <= 80) {
          console.log(`[Wikipedia] ✓ ${h}" — "${coasterName}" → "${result.title}"`);
          return { height: h, source: `Wikipedia: ${result.title}` };
        }
      }
    }
  }
  console.log(`[Wikipedia] ✗ not found — "${coasterName}"`);
  return null;
}

// ── Fill missing heights via Server-Sent Events (streams results as they arrive) ──
app.post("/api/fill-heights", async (req, res) => {
  if (fillHeightsRunning) {
    return res.status(409).json({ error: "A fill-heights job is already running. Please wait." });
  }

  const parks = req.body.parks;
  if (!Array.isArray(parks)) return res.status(400).json({ error: "No parks data provided." });

  const missing = [];
  for (const park of parks) {
    for (let ci = 0; ci < park.coasters.length; ci++) {
      const c = park.coasters[ci];
      if (c.min == null) missing.push({ parkId: park.id, parkName: park.name, coasterIdx: ci, name: c.name, scale: c.scale });
    }
  }

  if (missing.length === 0) {
    return res.json({ results: [], message: "All coasters already have height data." });
  }

  // Switch to SSE so the browser receives each result as it arrives
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Track client disconnect so a closed browser tab doesn't leave the job (and flag) stuck
  let aborted = false;
  // res (not req!) — req's stream closes as soon as the POST body is fully
  // read, long before the client actually disconnects; res only closes when
  // the underlying connection really does.
  res.on("close", () => { aborted = true; });

  const send = data => {
    if (aborted || res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); }
    catch { aborted = true; }
  };

  fillHeightsRunning = true;
  console.log(`[fill-heights] Starting — ${missing.length} coasters to look up`);

  let found = 0, notFound = 0;
  const results = [];

  try {
    send({ type: "start", total: missing.length });

    for (const item of missing) {
      if (aborted) { console.log("[fill-heights] Client disconnected — aborting"); break; }

      const result = await lookupHeightFromWikipedia(item.name, () => aborted);
      const entry = {
        parkId:      item.parkId,
        parkName:    item.parkName,
        coasterIdx:  item.coasterIdx,
        coasterName: item.name,
        height:      result?.height ?? null,
        source:      result?.source ?? "Not found",
        scale:       item.scale ?? null,
      };
      results.push(entry);
      if (result?.height) found++; else notFound++;
      send({ type: "result", ...entry, found, notFound, total: missing.length });
    }

    if (!aborted) {
      console.log(`[fill-heights] Done — found ${found}/${missing.length}`);
      send({ type: "done", results, found, notFound, total: missing.length });
    }
  } catch (err) {
    console.log(`[fill-heights] Error: ${err.message}`);
    send({ type: "error", message: err.message });
  } finally {
    // Always release the lock, no matter how the request ended
    fillHeightsRunning = false;
    if (!res.writableEnded) res.end();
  }
});

// ── RCDB speed enrichment ────────────────────────────────────────────────────
// RCDB coaster pages carry a stats table; speed renders as
//   <th>Speed<td><span class=float>95</span> mph   (or km/h for metric parks).
// We resolve a coaster by quick-search (qs.htm), disambiguating by park name when
// the search returns a list rather than redirecting straight to the coaster page.
const RCDB_HDRS = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36" };
let lastRcdbRequestAt = 0;

async function rcdbFetch(url, isAborted = () => false) {
  const gap = Date.now() - lastRcdbRequestAt;
  if (gap < 1000) await sleep(1000 - gap, isAborted);   // polite: ≥1s between requests
  if (isAborted()) return null;
  lastRcdbRequestAt = Date.now();
  const resp = await fetch(url, { headers: RCDB_HDRS, redirect: "follow" });
  return { html: await resp.text(), finalUrl: resp.url };
}

function parseRcdbSpeed(html) {
  const mph = html.match(/<th>Speed<td>(?:<span[^>]*>)?([\d.]+)(?:<\/span>)?\s*mph/i);
  if (mph) return parseFloat(mph[1]);
  const kmh = html.match(/<th>Speed<td>(?:<span[^>]*>)?([\d.]+)(?:<\/span>)?\s*km\/h/i);
  if (kmh) return Math.round(parseFloat(kmh[1]) * 0.621371 * 10) / 10;
  return null;
}
// Structure height, opening year, manufacturer/model, and material/style all
// live on the same per-coaster RCDB page (fetched anyway for speed), in a
// header block that looks like:
//   Make: <a>Bolliger & Mabillard</a><br>Model: <a>All Models</a> / <a>Hyper Coaster</a>
//   <a href="/g.htm?id=277">Roller Coaster</a><li><a ...>Steel</a><li><a ...>Sit Down</a>
//   ...<a href="/g.htm?id=93">Operating</a> since <time datetime="2015-03-28">
function parseRcdbStats(html) {
  const heightM = html.match(/<th>Height<td>(?:<span[^>]*>)?([\d.]+)(?:<\/span>)?\s*ft/i);
  const heightFt = heightM ? parseFloat(heightM[1]) : null;

  const yearM = html.match(/since <time datetime="(\d{4})-/i);
  const yearOpened = yearM ? parseInt(yearM[1]) : null;

  let manufacturer = null, model = null;
  const mk = html.match(/Make:\s*<a[^>]*>([^<]+)<\/a>/i);
  if (mk) manufacturer = mk[1].trim();
  const mdl = html.match(/Model:\s*<a[^>]*>([^<]+)<\/a>(?:\s*\/\s*<a[^>]*>([^<]+)<\/a>)?/i);
  if (mdl) model = (mdl[2] || mdl[1]).trim();

  // Tag list after the "Roller Coaster" type tag is [material, style, scale].
  let material = null, style = null;
  const tags = [...html.matchAll(/<a href="\/g\.htm\?id=\d+">([^<]+)<\/a>/g)].map(m => m[1]);
  const rcIdx = tags.indexOf("Roller Coaster");
  if (rcIdx !== -1) {
    material = tags[rcIdx + 1] || null;
    style    = tags[rcIdx + 2] || null;
  }
  return { heightFt, yearOpened, manufacturer, model, material, style };
}
const rcdbIsCoasterPage = (html, name) => {
  const t = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || "";
  return !/Quick Search Results/i.test(t) && normName(t).includes(normName(name).slice(0, 12));
};
// From a results page, pick the coaster id whose row text mentions the park.
function rcdbPickResult(html, parkName) {
  const rows = [...html.matchAll(/href=\/(\d+)\.htm>([^<]+)<\/a>([^<]*(?:<[^>]+>[^<]*){0,6})/g)];
  const pn = normName(parkName).replace(/^sf /, "").replace(/^six flags /, "");
  for (const r of rows) {
    const ctx = normName(r[0].replace(/<[^>]+>/g, " "));
    if (pn && ctx.includes(pn)) return r[1];
  }
  return rows[0]?.[1] || null;
}
// If we already know the coaster's rcdbUrl (from a prior import/lookup), fetch
// it directly — faster and more reliable than re-running quick-search, which
// can occasionally land on the wrong same-named coaster at another park.
async function lookupStatsFromRcdb(name, parkName, knownRcdbUrl, isAborted = () => false) {
  let html, finalUrl;
  if (knownRcdbUrl) {
    const page = await rcdbFetch(knownRcdbUrl, isAborted);
    if (!page) return null;
    html = page.html; finalUrl = page.finalUrl;
  } else {
    const first = await rcdbFetch("https://rcdb.com/qs.htm?qs=" + encodeURIComponent(name), isAborted);
    if (!first) return null;
    ({ html, finalUrl } = first);
    if (!rcdbIsCoasterPage(html, name)) {
      const id = rcdbPickResult(html, parkName);
      if (!id) { console.log(`[rcdb-stats] ✗ no match — "${name}" (${parkName})`); return null; }
      const page = await rcdbFetch("https://rcdb.com/" + id + ".htm", isAborted);
      if (!page) return null;
      html = page.html; finalUrl = page.finalUrl;
    }
  }
  const mph = parseRcdbSpeed(html);
  const stats = parseRcdbStats(html);
  const idMatch = String(finalUrl || "").match(/\/(\d+)\.htm/);
  const rcdbId = idMatch ? idMatch[1] : null;
  console.log(`[rcdb-stats] ${mph != null ? "✓" : "·"} "${name}" (${parkName}) — ${mph ?? "?"} mph, ${stats.heightFt ?? "?"} ft, ${stats.yearOpened ?? "?"}, ${stats.manufacturer ?? "?"} ${stats.model ?? ""}`.trim());
  return { mph, rcdbId, rcdbUrl: rcdbId ? `https://rcdb.com/${rcdbId}.htm` : knownRcdbUrl ?? null, ...stats };
}

let fillSpeedsRunning = false;
app.post("/api/fill-speeds", async (req, res) => {
  if (fillSpeedsRunning) return res.status(409).json({ error: "A fill-speeds job is already running. Please wait." });

  const parks = req.body.parks;
  if (!Array.isArray(parks)) return res.status(400).json({ error: "No parks data provided." });

  // Broader than just speed now: also fills height/year/manufacturer/model/
  // material/style, all pulled from the same per-coaster RCDB page.
  const missing = [];
  for (const park of parks)
    park.coasters.forEach((c, ci) => {
      const incomplete = c.speedMph == null || c.heightFt == null || c.yearOpened == null || !c.manufacturer;
      if (incomplete && !c.defunct) {
        missing.push({ parkId: park.id, parkName: park.name, coasterIdx: ci, name: c.name, rcdbUrl: c.rcdbUrl ?? null });
      }
    });

  if (missing.length === 0) return res.json({ results: [], message: "All operating coasters already have full RCDB stats." });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let aborted = false;
  // res (not req!) — req's stream closes as soon as the POST body is fully
  // read, long before the client actually disconnects; res only closes when
  // the underlying connection really does.
  res.on("close", () => { aborted = true; });
  const send = data => { if (aborted || res.writableEnded) return; try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { aborted = true; } };

  fillSpeedsRunning = true;
  console.log(`[fill-speeds] Starting — ${missing.length} coasters with incomplete RCDB stats`);
  let found = 0, notFound = 0;
  const results = [];
  try {
    send({ type: "start", total: missing.length });
    for (const item of missing) {
      if (aborted) { console.log("[fill-speeds] Client disconnected — aborting"); break; }
      let r = null;
      try { r = await lookupStatsFromRcdb(item.name, item.parkName, item.rcdbUrl, () => aborted); }
      catch (e) { console.log(`[fill-speeds] error on "${item.name}": ${e.message}`); }
      const entry = {
        parkId: item.parkId, parkName: item.parkName, coasterName: item.name,
        speedMph: r?.mph ?? null, rcdbId: r?.rcdbId ?? null, rcdbUrl: r?.rcdbUrl ?? null,
        heightFt: r?.heightFt ?? null, yearOpened: r?.yearOpened ?? null,
        manufacturer: r?.manufacturer ?? null, model: r?.model ?? null,
        material: r?.material ?? null, style: r?.style ?? null,
      };
      results.push(entry);
      if (r?.mph != null) found++; else notFound++;
      send({ type: "result", ...entry, found, notFound, total: missing.length });
    }
    if (!aborted) {
      console.log(`[fill-speeds] Done — found ${found}/${missing.length}`);
      send({ type: "done", results, found, notFound, total: missing.length });
    }
  } catch (err) {
    console.log(`[fill-speeds] Error: ${err.message}`);
    send({ type: "error", message: err.message });
  } finally {
    fillSpeedsRunning = false;
    if (!res.writableEnded) res.end();
  }
});

// ── Scrape authoritative heights from a park's official attractions page ──────
// Returns proposed updates (matched to existing coasters by name) without writing;
// the client reviews and applies them. One park per call (a browser launch is heavy).
//
// Name matching is hard because three sources disagree: RCDB (our display names),
// the official Six Flags page (where heights live), and old seed names. `normName`
// strips ALL punctuation/trademark symbols so "Batman: The Ride" == "Batman The Ride".
// `fuzzyNameMatch` then bridges filler-word differences ("Apocalypse" vs "Apocalypse
// the Ride", "Riddler's Revenge" vs "The Riddler's Revenge") via token containment
// where the EXTRA words are all stopwords — which never matches racing pairs
// ("Racer Red" vs "Racer Blue") or true renames ("Revolution" vs "New Revolution").
const normName = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const NAME_STOPWORDS = new Set(["the", "a", "an", "of", "and", "ride", "roller", "coaster"]);
const nameTokens = s => normName(s).split(" ").filter(Boolean);
function fuzzyNameMatch(a, b) {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const setA = new Set(ta), setB = new Set(tb);
  const [small, big] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const t of small) if (!big.has(t)) return false;             // smaller ⊆ bigger
  for (const t of big) if (!small.has(t) && !NAME_STOPWORDS.has(t)) return false; // extras are filler
  return true;
}
let scrapeRunning = false;

app.post("/api/scrape-heights", async (req, res) => {
  if (scrapeRunning) return res.status(409).json({ error: "A scrape job is already running. Please wait." });

  const park = req.body.park;
  if (!park) return res.status(400).json({ error: "No park data provided." });
  if (!park.officialUrl) return res.status(400).json({ error: "This park has no official height-chart URL set (add one in park settings)." });

  scrapeRunning = true;
  try {
    console.log(`[scrape-heights] ${park.name} → ${park.officialUrl}`);
    const scraped = await scrapeParkHeights(park.officialUrl);

    // Match scraped coasters to existing ones by normalized name.
    const { matched, unmatchedScraped, unmatchedExisting } = matchScrapeToPark(park, scraped);

    console.log(`[scrape-heights] ${park.name}: ${scraped.length} scraped, ${matched.length} matched, ${matched.filter(m=>m.changed).length} changed`);
    res.json({ parkId: park.id, parkName: park.name, source: park.officialUrl, scrapedCount: scraped.length, matched, unmatchedScraped, unmatchedExisting });
  } catch (err) {
    console.log(`[scrape-heights] Error: ${err.message}`);
    res.status(500).json({ error: `Scrape failed: ${err.message}` });
  } finally {
    scrapeRunning = false;
  }
});

// Match a park's coasters against a scraped list. Two passes: exact normalized name
// first, then the stopword-containment fuzzy match. Shared by the single-park and
// batch scrape paths. Matched entries carry `scrapedName` + `fuzzy` so the review UI
// can flag approximate matches for the user to eyeball before applying.
function pushScrapeMatch(matched, c, idx, s, fuzzy) {
  const changed = (s.min ?? null) !== (c.min ?? null) || (s.minAccompanied ?? null) !== (c.minAccompanied ?? null);
  matched.push({
    coasterIdx: idx, name: c.name, scrapedName: s.name, fuzzy,
    current: { min: c.min ?? null, minAccompanied: c.minAccompanied ?? null },
    scraped: { min: s.min ?? null, minAccompanied: s.minAccompanied ?? null },
    changed,
  });
}
function matchScrapeToPark(park, scraped) {
  const matched = [];
  const usedScraped = new Set();   // scraped indices consumed
  const matchedIdx  = new Set();   // park coaster indices matched

  // Pass 1 — exact normalized name
  const byName = new Map();
  scraped.forEach((s, si) => { const k = normName(s.name); if (!byName.has(k)) byName.set(k, si); });
  park.coasters.forEach((c, idx) => {
    const si = byName.get(normName(c.name));
    if (si == null || usedScraped.has(si)) return;
    usedScraped.add(si); matchedIdx.add(idx);
    pushScrapeMatch(matched, c, idx, scraped[si], false);
  });

  // Pass 2 — fuzzy (filler-word containment) for still-unmatched park coasters
  park.coasters.forEach((c, idx) => {
    if (matchedIdx.has(idx)) return;
    const si = scraped.findIndex((s, j) => !usedScraped.has(j) && fuzzyNameMatch(c.name, s.name));
    if (si === -1) return;
    usedScraped.add(si); matchedIdx.add(idx);
    pushScrapeMatch(matched, c, idx, scraped[si], true);
  });

  const unmatchedScraped  = scraped.filter((s, j) => !usedScraped.has(j)).map(s => s.name);
  const unmatchedExisting = park.coasters.filter((c, idx) => !matchedIdx.has(idx)).map(c => c.name);
  return { matched, unmatchedScraped, unmatchedExisting };
}

// ── Batch scrape: every park with an officialUrl, streamed (SSE) ──────────────
// Like fill-heights, this streams per-park progress so the client can show a
// combined review panel. It does NOT write — the client applies approved updates.
// Shares the `scrapeRunning` lock with the single-park scrape (one browser at a time).
app.post("/api/scrape-all-heights", async (req, res) => {
  if (scrapeRunning) return res.status(409).json({ error: "A scrape job is already running. Please wait." });

  const parks = req.body.parks;
  if (!Array.isArray(parks)) return res.status(400).json({ error: "No parks data provided." });

  const targets = parks.filter(p => p.officialUrl);
  if (targets.length === 0) {
    return res.json({ results: [], message: "No parks have an official height-chart URL set." });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let aborted = false;
  // res (not req!) — req's stream closes as soon as the POST body is fully
  // read, long before the client actually disconnects; res only closes when
  // the underlying connection really does.
  res.on("close", () => { aborted = true; });
  const send = data => {
    if (aborted || res.writableEnded) return;
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { aborted = true; }
  };

  scrapeRunning = true;
  console.log(`[scrape-all] Starting — ${targets.length} parks with an officialUrl`);
  let parksScraped = 0, parksFailed = 0, totalChanged = 0;

  try {
    send({ type: "start", totalParks: targets.length });
    for (const park of targets) {
      if (aborted) { console.log("[scrape-all] Client disconnected — aborting"); break; }
      try {
        const scraped = await scrapeParkHeights(park.officialUrl);
        const { matched, unmatchedScraped, unmatchedExisting } = matchScrapeToPark(park, scraped);
        const changed = matched.filter(m => m.changed);
        parksScraped++; totalChanged += changed.length;
        console.log(`[scrape-all] ${park.name}: ${scraped.length} scraped, ${matched.length} matched, ${changed.length} changed`);
        send({ type: "park", parkId: park.id, parkName: park.name, scrapedCount: scraped.length,
               matched, changed, unmatchedScraped, unmatchedExisting, done: parksScraped + parksFailed, totalParks: targets.length });
      } catch (err) {
        parksFailed++;
        console.log(`[scrape-all] ${park.name} failed: ${err.message}`);
        send({ type: "park", parkId: park.id, parkName: park.name, error: err.message,
               done: parksScraped + parksFailed, totalParks: targets.length });
      }
    }
    if (!aborted) {
      console.log(`[scrape-all] Done — ${parksScraped} scraped, ${parksFailed} failed, ${totalChanged} changes proposed`);
      send({ type: "done", parksScraped, parksFailed, totalChanged, totalParks: targets.length });
    }
  } catch (err) {
    console.log(`[scrape-all] Error: ${err.message}`);
    send({ type: "error", message: err.message });
  } finally {
    scrapeRunning = false;
    if (!res.writableEnded) res.end();
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API server on http://localhost:${PORT}`));
