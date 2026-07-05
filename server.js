// Stateless scraper service: RCDB lookup, Wikipedia height-fill, and the
// official-attractions-page scraper. Riders/parks/settings/credits persistence
// moved to Supabase (see src/supabaseClient.js) — this server holds no data of
// its own; every endpoint here takes the caller's current park(s) in the
// request body/query and returns proposed results for the client to apply.
import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";
import { scrapeParkHeights, ScrapeCancelledError } from "./scrape-heights.js";

const app = express();
// FRONTEND_URL = the deployed SPA's production origin (comma-separated for
// multiple). Falls back to wide-open in dev, where the Vite proxy means CORS
// rarely matters. Also allows this project's Vercel PR-preview deployments —
// every PR gets its own throwaway "coaster-tracker-git-<branch>-*.vercel.app"
// URL, so a fixed allowlist alone would block reviewing PRs before merge.
const allowedOrigins = process.env.FRONTEND_URL?.split(",").map(s => s.trim());
const VERCEL_PREVIEW_RE = /^https:\/\/coaster-tracker-[a-z0-9-]+\.vercel\.app$/;
app.use(cors({
  origin: allowedOrigins
    ? (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin) || VERCEL_PREVIEW_RE.test(origin))
    : true,
}));
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

// ── Fill/reconcile heights via Server-Sent Events (streams results as they arrive) ──
// One job now checks every available source instead of leaving the choice to the
// user: for parks with an official height-chart URL, scrape it and trust it over
// anything else (it also catches stale values on coasters that already have a
// height, unless `missingOnly` is set); everything still missing afterward — and
// anything at a park with no official source — falls back to Wikipedia.
//
// The job itself is decoupled from any single HTTP connection: it's tracked in
// `heightsJob` and keeps running to completion even if the initiating browser
// tab navigates away or closes (the SSE response is just one of possibly several
// listeners). A later request — same tab reopened, or a fresh tab — replays
// everything sent so far and then keeps streaming, so no progress is lost.
let heightsJob = null; // { total, missingOnly, messages, done, doneMessage, listeners }

function attachToHeightsJob(job, send) {
  send({ type: "start", total: job.total });
  for (const m of job.messages) send(m);
  if (job.done) send(job.doneMessage);
  else job.listeners.add(send);
}

app.post("/api/fill-heights", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let closed = false;
  const send = data => {
    if (closed || res.writableEnded) return;
    try {
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      if (data.type === "done" || data.type === "error") res.end();
    } catch { closed = true; }
  };
  // res (not req!) — req's stream closes as soon as the POST body is fully read,
  // long before the client actually disconnects. Losing this listener does NOT
  // stop the job — it just stops streaming to this particular connection.
  res.on("close", () => { closed = true; if (heightsJob) heightsJob.listeners.delete(send); });

  // A job is already running — attach this connection to it instead of starting
  // a second one (also covers the resume-after-navigating-away case).
  if (heightsJob && !heightsJob.done) {
    attachToHeightsJob(heightsJob, send);
    return;
  }

  // No fill-heights job in flight, but the manual per-park scrape (`/api/scrape-heights`)
  // is using the browser right now — refuse rather than run two scrapes at once.
  if (scrapeRunning) {
    send({ type: "error", message: "A scrape job is already running. Please wait." });
    return;
  }

  const parks = req.body.parks;
  if (!Array.isArray(parks)) { send({ type: "error", message: "No parks data provided." }); return; }
  const missingOnly = !!req.body.missingOnly;

  // Work list: coasters missing a height everywhere, plus — at parks with an
  // official source, unless missingOnly is set — every coaster, so the scrape
  // can also correct stale values instead of only filling blanks.
  const work = [];
  for (const park of parks) {
    for (let ci = 0; ci < park.coasters.length; ci++) {
      const c = park.coasters[ci];
      if (c.min == null || (!missingOnly && park.officialUrl)) {
        work.push({
          parkId: park.id, parkName: park.name, coasterIdx: ci, name: c.name, scale: c.scale,
          min: c.min ?? null, minAccompanied: c.minAccompanied ?? null, officialUrl: park.officialUrl || null,
        });
      }
    }
  }

  if (work.length === 0) {
    send({ type: "done", results: [], found: 0, notFound: 0, total: 0 });
    return;
  }

  const job = { total: work.length, missingOnly, messages: [], done: false, doneMessage: null, listeners: new Set([send]) };
  heightsJob = job;
  scrapeRunning = true; // fill-heights now drives the same scraper — serialize with the manual per-park scrape

  const broadcast = data => { job.messages.push(data); for (const l of job.listeners) l(data); };
  broadcast({ type: "start", total: job.total });
  console.log(`[fill-heights] Starting — ${work.length} coasters to check${missingOnly ? " (missing only)" : ""}`);

  // Runs detached from this request/response — it keeps going even if every
  // listener (including this one) disconnects, so the job survives navigation.
  (async () => {
    let found = 0, notFound = 0;
    const results = [];
    try {
      // Scrape each distinct official-source park once up front, indexed by coasterIdx.
      const officialByPark = new Map();
      const officialParkIds = [...new Set(work.filter(w => w.officialUrl).map(w => w.parkId))];
      for (const parkId of officialParkIds) {
        if (job.cancelled) break;
        const park = parks.find(p => p.id === parkId);
        try {
          const scraped = await scrapeParkHeights(park.officialUrl, { isCancelled: () => job.cancelled });
          const { matched } = matchScrapeToPark(park, scraped);
          officialByPark.set(parkId, new Map(matched.map(m => [m.coasterIdx, m])));
        } catch (err) {
          if (err instanceof ScrapeCancelledError) break;
          console.log(`[fill-heights] Official scrape failed for ${park.name}: ${err.message}`);
          officialByPark.set(parkId, new Map());
        }
      }

      for (const item of work) {
        if (job.cancelled) { console.log("[fill-heights] Cancelled by user — stopping"); break; }
        const officialMatch = officialByPark.get(item.parkId)?.get(item.coasterIdx);
        let height = item.min, minAccompanied = item.minAccompanied, source = "Current", fuzzy = false, changed = false;

        if (officialMatch && officialMatch.changed) {
          height = officialMatch.scraped.min;
          minAccompanied = officialMatch.scraped.minAccompanied;
          source = "Official";
          fuzzy = officialMatch.fuzzy;
          changed = true;
        } else if (officialMatch) {
          source = "Official"; // already agrees with the current value — nothing to change
        } else if (item.min == null) {
          const result = await lookupHeightFromWikipedia(item.name, () => job.cancelled);
          if (result?.height != null) { height = result.height; source = "Wikipedia"; changed = true; }
          else source = "Not found";
        }

        const entry = {
          parkId: item.parkId, parkName: item.parkName, coasterIdx: item.coasterIdx, coasterName: item.name,
          currentMin: item.min, height, minAccompanied, source, fuzzy, changed, scale: item.scale ?? null,
        };
        results.push(entry);
        if (changed) found++; else if (height == null) notFound++;
        broadcast({ type: "result", ...entry, found, notFound, total: job.total });
      }

      console.log(job.cancelled
        ? `[fill-heights] Stopped early — ${found} updated of ${results.length}/${work.length} checked`
        : `[fill-heights] Done — ${found} updated of ${work.length} checked`);
      job.doneMessage = { type: "done", results, found, notFound, total: job.total, cancelled: job.cancelled };
    } catch (err) {
      console.log(`[fill-heights] Error: ${err.message}`);
      job.doneMessage = { type: "error", message: err.message };
    } finally {
      job.done = true;
      broadcast(job.doneMessage);
      scrapeRunning = false;
    }
  })();
});

// Lets a freshly (re)mounted tab find out whether a fill-heights job is still
// running — or already finished — without opening a new SSE stream, so the UI
// can resume showing progress after the user navigated away and back.
app.get("/api/fill-heights/status", (req, res) => {
  if (!heightsJob) return res.json({ active: false });
  res.json({ active: !heightsJob.done, total: heightsJob.total, missingOnly: heightsJob.missingOnly, messages: heightsJob.messages, done: heightsJob.done, doneMessage: heightsJob.doneMessage });
});

// Stops the in-flight fill-heights job after its current coaster/park finishes
// (cooperative — there's no way to interrupt an in-flight scrape/HTTP request
// mid-flight, so this sets a flag the job loop checks between steps). Results
// gathered so far still stream out normally via the "done" message.
app.post("/api/fill-heights/cancel", (req, res) => {
  if (!heightsJob || heightsJob.done) return res.json({ ok: false, message: "No active job." });
  heightsJob.cancelled = true;
  res.json({ ok: true });
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
  // Return html so the image pipeline can reuse the already-fetched page.
  return { mph, rcdbId, rcdbUrl: rcdbId ? `https://rcdb.com/${rcdbId}.htm` : knownRcdbUrl ?? null, ...stats, _html: html };
}

// ── Image enrichment ─────────────────────────────────────────────────────────
// Two-stage pipeline: Wikimedia Commons API first (freely hotlinkable), then
// RCDB page image as fallback (downloaded + re-hosted in Supabase Storage so
// we're not leeching RCDB bandwidth). Results carry imageSource and
// imageConfidence so the UI can flag low-confidence matches for review.

const WIKI_API = "https://commons.wikimedia.org/w/api.php";
const SUPABASE_URL    = process.env.SUPABASE_URL    || process.env.VITE_SUPABASE_URL    || "";
const SUPABASE_SVC    = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const COASTER_BUCKET  = "coaster-images";

const WIKI_HDR = { "User-Agent": "CoasterTracker/1.0 (educational; contact via github)" };
const normWiki = s => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Wikimedia Commons: search for a coaster image by name + park, return the
// best-matching direct image URL and a confidence score.
// Tries multiple query strategies to maximise hit rate.
async function lookupWikimediaImage(coasterName, parkName) {
  const normCoaster = normWiki(coasterName);

  // Try queries from most-specific to least. Stop at first hit whose title
  // contains the coaster name (high confidence), or keep the first result
  // from any query as a low-confidence fallback.
  const queries = [
    `${coasterName} ${parkName} roller coaster`,
    `${coasterName} roller coaster`,
    `${coasterName} coaster`,
    coasterName,
  ];

  let lowFallback = null;

  for (const query of queries) {
    const searchUrl = `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=6&srlimit=8&format=json&origin=*`;
    const searchResp = await fetch(searchUrl, { headers: WIKI_HDR });
    if (!searchResp.ok) continue;
    const results = (await searchResp.json())?.query?.search ?? [];

    for (const r of results) {
      const titleNorm = normWiki(r.title);
      if (titleNorm.includes(normCoaster)) {
        // High-confidence match — resolve immediately.
        const url = await resolveWikiUrl(r.title);
        if (url) return { imageUrl: url, imageSource: "wikimedia", imageConfidence: "high" };
      } else if (!lowFallback) {
        lowFallback = r.title;
      }
    }
  }

  // No high-confidence match found — use low-confidence fallback if any.
  if (lowFallback) {
    const url = await resolveWikiUrl(lowFallback);
    if (url) return { imageUrl: url, imageSource: "wikimedia", imageConfidence: "low" };
  }

  return null;
}

async function resolveWikiUrl(title) {
  const infoUrl = `${WIKI_API}?action=query&titles=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url&format=json&origin=*`;
  const resp = await fetch(infoUrl, { headers: WIKI_HDR });
  if (!resp.ok) return null;
  const pages = Object.values((await resp.json())?.query?.pages ?? {});
  const url = pages[0]?.imageinfo?.[0]?.url ?? null;
  // Only accept displayable image types.
  if (!url || !/\.(jpe?g|png|webp)(\?|$)/i.test(url)) return null;
  return url;
}

// Parse the primary image from an RCDB coaster page HTML.
// RCDB lazy-loads images via JS; the server-rendered HTML encodes the image
// as data-url on the #opfAnchor element, e.g.:
//   <a id=opfAnchor data-url=/aaaaabc ...>
// That path, prepended with https://rcdb.com, serves the image directly as JPEG.
function parseRcdbImage(html) {
  const m = html.match(/id=opfAnchor[^>]+data-url=([^\s>]+)/i);
  if (!m) return null;
  const path = m[1].replace(/^["']|["']$/g, "");
  return path ? `https://rcdb.com${path}` : null;
}

// Download an RCDB image and upload to Supabase Storage. Returns the public CDN URL.
async function mirrorImageToSupabase(rcdbImageUrl, rcdbId) {
  if (!SUPABASE_URL || !SUPABASE_SVC) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  const ext = (rcdbImageUrl.match(/\.(jpe?g|png)$/i) || ["", "jpg"])[1].toLowerCase().replace("jpeg", "jpg");
  const path = `rcdb-${rcdbId}.${ext}`;

  // Download from RCDB.
  const imgResp = await fetch(rcdbImageUrl, { headers: { ...RCDB_HDRS, Referer: "https://rcdb.com/" } });
  if (!imgResp.ok) throw new Error(`RCDB image download failed: ${imgResp.status}`);
  const buffer = Buffer.from(await imgResp.arrayBuffer());

  // Upload to Supabase Storage via REST API.
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${COASTER_BUCKET}/${path}`;
  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SUPABASE_SVC}`,
      "Content-Type": ext === "png" ? "image/png" : "image/jpeg",
      "x-upsert": "true",
    },
    body: buffer,
  });
  if (!uploadResp.ok) {
    const err = await uploadResp.text();
    throw new Error(`Supabase Storage upload failed: ${uploadResp.status} ${err}`);
  }

  return `${SUPABASE_URL}/storage/v1/object/public/${COASTER_BUCKET}/${path}`;
}

// Top-level image lookup: Wikimedia first, RCDB mirror fallback.
async function lookupImage(name, parkName, rcdbId, rcdbHtml, isAborted = () => false) {
  // 1. Wikimedia Commons.
  try {
    if (isAborted()) return null;
    const wiki = await lookupWikimediaImage(name, parkName);
    if (wiki) {
      console.log(`[images] ✓ wikimedia (${wiki.imageConfidence}) "${name}"`);
      return wiki;
    }
  } catch (e) {
    console.log(`[images] wikimedia error for "${name}": ${e.message}`);
  }

  // 2. RCDB image → Supabase Storage mirror.
  if (!rcdbHtml) return null;
  try {
    if (isAborted()) return null;
    const rcdbImgUrl = parseRcdbImage(rcdbHtml);
    if (!rcdbImgUrl) { console.log(`[images] · no image on RCDB page for "${name}"`); return null; }
    // Use rcdbId as storage key; fall back to a slugified coaster name.
    const storageKey = rcdbId ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
    const publicUrl = await mirrorImageToSupabase(rcdbImgUrl, storageKey);
    console.log(`[images] ✓ rcdb-mirror "${name}" → ${publicUrl}`);
    return { imageUrl: publicUrl, imageSource: "rcdb-mirror", imageConfidence: "high" };
  } catch (e) {
    console.log(`[images] rcdb-mirror error for "${name}": ${e.message}`);
    return null;
  }
}

let fillSpeedsRunning = false;
app.post("/api/fill-speeds", async (req, res) => {
  if (fillSpeedsRunning) return res.status(409).json({ error: "A fill-speeds job is already running. Please wait." });

  const parks = req.body.parks;
  if (!Array.isArray(parks)) return res.status(400).json({ error: "No parks data provided." });

  // fields: which data elements to fill. Default = all except images (backward compat).
  const fields = req.body.fields ?? { stats: true, images: false };
  const fillStats  = !!fields.stats;
  const fillImages = !!fields.images;

  // Build work list: coasters that are missing any requested field.
  const missing = [];
  for (const park of parks)
    park.coasters.forEach((c, ci) => {
      if (c.defunct) return;
      const needsStats  = fillStats  && (c.speedMph == null || c.heightFt == null || c.yearOpened == null || !c.manufacturer || !c.model);
      const needsImages = fillImages && !c.imageUrl;
      if (needsStats || needsImages) {
        missing.push({ parkId: park.id, parkName: park.name, coasterIdx: ci, name: c.name, rcdbUrl: c.rcdbUrl ?? null, needsStats, needsImages });
      }
    });

  if (missing.length === 0) return res.json({ results: [], message: "All operating coasters already have the requested fields." });

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
  console.log(`[fill-speeds] Starting — ${missing.length} coasters | stats:${fillStats} images:${fillImages}`);
  let found = 0, notFound = 0;
  const results = [];
  try {
    send({ type: "start", total: missing.length, fields: { stats: fillStats, images: fillImages } });
    for (const item of missing) {
      if (aborted) { console.log("[fill-speeds] Client disconnected — aborting"); break; }

      let r = null;
      // Always fetch the RCDB page when stats are needed OR when images are
      // needed (image fallback reuses the already-fetched HTML).
      if (item.needsStats || (item.needsImages && fillImages)) {
        try { r = await lookupStatsFromRcdb(item.name, item.parkName, item.rcdbUrl, () => aborted); }
        catch (e) { console.log(`[fill-speeds] rcdb error on "${item.name}": ${e.message}`); }
      }

      let imgResult = null;
      if (item.needsImages && fillImages && !aborted) {
        try {
          imgResult = await lookupImage(item.name, item.parkName, r?.rcdbId ?? null, r?._html ?? null, () => aborted);
        } catch (e) {
          console.log(`[fill-speeds] image error on "${item.name}": ${e.message}`);
        }
      }

      const entry = {
        parkId: item.parkId, parkName: item.parkName, coasterIdx: item.coasterIdx, coasterName: item.name,
        // Stats fields — null when stats not requested or not found.
        speedMph:     item.needsStats ? (r?.mph ?? null)          : undefined,
        rcdbId:       r?.rcdbId ?? null,
        rcdbUrl:      r?.rcdbUrl ?? null,
        heightFt:     item.needsStats ? (r?.heightFt ?? null)     : undefined,
        yearOpened:   item.needsStats ? (r?.yearOpened ?? null)   : undefined,
        manufacturer: item.needsStats ? (r?.manufacturer ?? null) : undefined,
        model:        item.needsStats ? (r?.model ?? null)        : undefined,
        material:     item.needsStats ? (r?.material ?? null)     : undefined,
        style:        item.needsStats ? (r?.style ?? null)        : undefined,
        // Image fields — null when images not requested or not found.
        imageUrl:         item.needsImages ? (imgResult?.imageUrl ?? null)         : undefined,
        imageSource:      item.needsImages ? (imgResult?.imageSource ?? null)      : undefined,
        imageConfidence:  item.needsImages ? (imgResult?.imageConfidence ?? null)  : undefined,
      };
      results.push(entry);
      if (r?.mph != null || imgResult?.imageUrl) found++; else notFound++;
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`API server on http://localhost:${PORT}`));
