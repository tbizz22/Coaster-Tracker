import { useState, useMemo, useEffect, useCallback, useRef } from "react";
import { supabase } from "./src/supabaseClient";

// ═══════════════════════════════════════════════════════════════════════════
// DESIGN TOKENS — the single scale every component styles against. Replaces the
// ad-hoc inline numbers (paddings 5/7/9, fonts 9/10/12.5, radii 3/4/6…) that had
// drifted. Mirrored as CSS variables in index.html for the responsive rules.
// ═══════════════════════════════════════════════════════════════════════════
const T = {
  // spacing scale (px)
  s1:4, s2:6, s3:8, s4:10, s5:12, s6:16, s7:20, s8:24,
  // type scale (px) — 10 is the smallest legible micro-label (was 9)
  fxs:10, fsm:11, fbase:12.5, fmd:14, flg:16, fxl:20, f2xl:24,
  // radius scale
  r1:4, r2:6, r3:8, r4:10, r5:12, pill:999,
  // font weights
  wMed:500, wSemi:600, wBold:700, wHeavy:800,
  // color roles (dark theme)
  bg:"#060c18", panel:"#0b1222", panel2:"#0f172a", zebra:"#070d1a",
  border:"#1e293b", border2:"#334155", hair:"#0f172a",
  ink:"#f1f5f9", text:"#e2e8f0", textMid:"#94a3b8", textLo:"#64748b",
  textFaint:"#475569", textGhost:"#334155", accent:"#38bdf8",
};
// Uppercase micro-label used for section headers / column heads.
const labelCss = { fontSize:T.fxs, fontWeight:T.wBold, color:T.textFaint, textTransform:"uppercase", letterSpacing:"0.07em" };
// Uppercase field label sitting above a form input (a touch lighter/tighter).
const fieldLabelCss = { fontSize:T.fxs, fontWeight:T.wSemi, color:T.textLo, textTransform:"uppercase", letterSpacing:"0.06em" };

// REGIONS is loaded from the `regions` table at startup (see loadHouseholdData).
// Mutable so the values fetched from Supabase replace these defaults before first render.
const DEFAULT_REGIONS = { NE:"Northeast", SE:"Southeast", MW:"Midwest", TX:"Texas", CA:"California", INT:"International" };
let REGIONS = { ...DEFAULT_REGIONS };
// TOTAL_COASTERS is now computed dynamically from parks state in App

const COLOR_PALETTE = [
  "#38bdf8","#fb923c","#4ade80","#f472b6","#a78bfa",
  "#facc15","#34d399","#f87171","#60a5fa","#e879f9",
];

// ── Scraper-service helper (RCDB/Wikipedia/official-height endpoints still
// live in server.js — those are stateless lookups, not persistence) ───────
// In dev, Vite proxies "/api" to the local scraper service (vite.config.js),
// so a relative path works. In production the SPA and scraper service deploy
// to separate origins, so VITE_SCRAPER_URL must point at the deployed one.
const API_BASE = import.meta.env.VITE_SCRAPER_URL || "";

// Render's free tier spins the scraper down after idling and takes ~30-50s to
// boot back up on the next request — during that window requests fail with a
// network error (connection refused) or a 502/503/504 from Render's own proxy
// while the container starts. Those are the only failure shapes a cold boot
// produces, so retrying on anything else (4xx, a real 500 from our own code,
// a non-network thrown error) would just mask a genuine bug — fail fast instead.
const COLD_START_RETRY_DELAYS_MS = [2000, 4000, 8000, 16000, 30000]; // ~60s total, covers Render's worst-case boot time

function isColdStartStatus(status) {
  return status === 502 || status === 503 || status === 504;
}

// Wraps fetch with retry-on-cold-boot. `onRetry(attempt, total)` lets callers
// surface "scraper is waking up..." feedback instead of looking hung.
async function fetchWithColdStartRetry(url, options, onRetry) {
  const maxAttempts = COLD_START_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let resp, networkError;
    try {
      resp = await fetch(url, options);
    } catch (e) {
      networkError = e;
    }
    const shouldRetry = (networkError || isColdStartStatus(resp?.status)) && attempt < maxAttempts;
    if (!shouldRetry) {
      if (networkError) throw networkError;
      return resp;
    }
    onRetry?.(attempt, maxAttempts);
    await new Promise(r => setTimeout(r, COLD_START_RETRY_DELAYS_MS[attempt - 1]));
  }
}

async function apiGet(path) {
  const r = await fetchWithColdStartRetry(API_BASE + path);
  return r.json();
}

// The scraper service's batch/streaming endpoints need the caller's current
// parks data (it holds none itself), which EventSource can't POST — so we
// drive the same SSE wire format over a plain fetch + stream reader instead.
async function postSSE(path, body, onMessage) {
  let resp;
  try {
    resp = await fetchWithColdStartRetry(
      API_BASE + path,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
      (attempt, total) => onMessage({ type: "status", message: `Scraper service is waking up (retry ${attempt}/${total - 1})…` }),
    );
  } catch (e) {
    onMessage({ type: "error", message: `Could not reach the scraper: ${e.message}` });
    return;
  }
  if (!resp.ok || !resp.body) {
    let message = `HTTP ${resp.status}`;
    try { message = (await resp.json()).error || message; } catch {}
    onMessage({ type: "error", message });
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split("\n").find(l => l.startsWith("data: "));
      if (line) onMessage(JSON.parse(line.slice(6)));
    }
  }
}

// ── Supabase persistence (per-household; RLS scopes every query) ─────────
// Every save*() takes the FULL current array/set and reconciles it against the
// DB (upsert present rows, delete rows no longer present) — this preserves the
// old file-based API's "PUT the whole thing" semantics so call sites needed no
// changes. Ids are client-generated (uid()), so upserts are idempotent.
let HOUSEHOLD_ID = null;
export function setHouseholdId(id) { HOUSEHOLD_ID = id; }

async function loadHouseholdData() {
  const [{ data: regionRows }, { data: riderRows }, { data: parkRows }, { data: coasterRows }] = await Promise.all([
    supabase.from("regions").select("code,name,sort").eq("household_id", HOUSEHOLD_ID).order("sort"),
    supabase.from("riders").select("*").eq("household_id", HOUSEHOLD_ID).order("sort"),
    supabase.from("parks").select("*").eq("household_id", HOUSEHOLD_ID).order("sort"),
    supabase.from("coasters").select("*, parks!inner(household_id)").eq("parks.household_id", HOUSEHOLD_ID).order("sort"),
  ]);

  const regions = Object.fromEntries((regionRows ?? []).map(r => [r.code, r.name]));

  const coastersByPark = new Map();
  for (const c of coasterRows ?? []) {
    const list = coastersByPark.get(c.park_id) ?? [];
    list.push({
      id: c.id, name: c.name, manufacturer: c.manufacturer, model: c.model, material: c.material, style: c.style, min: c.min, minAccompanied: c.min_accompanied,
      speedMph: c.speed_mph, heightFt: c.height_ft, yearOpened: c.year_opened, racing: c.racing, defunct: c.defunct, rcdbId: c.rcdb_id,
      rcdbUrl: c.rcdb_url, scale: c.scale, status: c.status, heightSource: c.height_source,
    });
    coastersByPark.set(c.park_id, list);
  }

  const riders = (riderRows ?? []).map(r => ({
    id: r.id, name: r.name, height: r.height, color: r.color, needsCompanion: r.needs_companion,
  }));
  const parks = (parkRows ?? []).map(p => ({
    id: p.id, name: p.name, tag: p.tag, region: p.region_code, badge: p.badge, family: p.family,
    officialUrl: p.official_url, lat: p.lat, lng: p.lng,
    coasters: coastersByPark.get(p.id) ?? [],
  }));

  const creditEntries = await Promise.all(riders.map(async r => {
    const { data } = await supabase.from("credits").select("coaster_id").eq("rider_id", r.id);
    const coasterById = new Map();
    for (const p of parks) for (const c of p.coasters) coasterById.set(c.id, ck(p.id, c.name));
    const keys = (data ?? []).map(row => coasterById.get(row.coaster_id)).filter(Boolean);
    return [r.id, new Set(keys)];
  }));

  return { regions, riders, parks, ridden: Object.fromEntries(creditEntries) };
}

async function saveRiders(riders) {
  if (!riders.length) { /* nothing to upsert, but still reconcile deletes below */ }
  const rows = riders.map((r, i) => ({
    id: r.id, household_id: HOUSEHOLD_ID, name: r.name, height: r.height,
    color: r.color, needs_companion: !!r.needsCompanion, sort: i,
  }));
  if (rows.length) await supabase.from("riders").upsert(rows);
  const keepIds = riders.map(r => r.id);
  await supabase.from("riders").delete().eq("household_id", HOUSEHOLD_ID).not("id", "in", `(${keepIds.map(id => `"${id}"`).join(",") || "''"})`);
}

async function saveParks(parks) {
  const parkRows = parks.map((p, i) => ({
    id: p.id, household_id: HOUSEHOLD_ID, name: p.name, tag: p.tag ?? null,
    region_code: p.region ?? null, badge: p.badge ?? null, family: p.family ?? null,
    official_url: p.officialUrl ?? null, lat: p.lat ?? null, lng: p.lng ?? null, sort: i,
  }));
  if (parkRows.length) await supabase.from("parks").upsert(parkRows);
  const keepParkIds = parks.map(p => p.id);
  await supabase.from("parks").delete().eq("household_id", HOUSEHOLD_ID).not("id", "in", `(${keepParkIds.map(id => `"${id}"`).join(",") || "''"})`);

  const coasterRows = [];
  for (const p of parks) {
    (p.coasters || []).forEach((c, j) => {
      coasterRows.push({
        id: c.id, park_id: p.id, name: c.name, manufacturer: c.manufacturer ?? null, model: c.model ?? null, material: c.material ?? null, style: c.style ?? null, min: c.min ?? null,
        min_accompanied: c.minAccompanied ?? null, speed_mph: c.speedMph ?? null,
        height_ft: c.heightFt ?? null, year_opened: c.yearOpened ?? null,
        racing: !!c.racing, defunct: !!c.defunct, rcdb_id: c.rcdbId ?? null,
        rcdb_url: c.rcdbUrl ?? null, scale: c.scale ?? null, status: c.status ?? null,
        height_source: c.heightSource ?? null, sort: j,
      });
    });
  }
  if (coasterRows.length) await supabase.from("coasters").upsert(coasterRows);
  for (const p of parks) {
    const keepCoasterIds = (p.coasters || []).map(c => c.id);
    await supabase.from("coasters").delete().eq("park_id", p.id).not("id", "in", `(${keepCoasterIds.map(id => `"${id}"`).join(",") || "''"})`);
  }
}

async function saveSettings(settings) {
  const rows = Object.entries(settings.regions || {}).map(([code, name], i) => ({
    household_id: HOUSEHOLD_ID, code, name, sort: i,
  }));
  await supabase.from("regions").delete().eq("household_id", HOUSEHOLD_ID);
  if (rows.length) await supabase.from("regions").upsert(rows, { onConflict: "household_id,code" });
}

async function saveRiderCredits(riderId, keySet, parks) {
  // keySet holds ck(parkId, coasterName) strings; resolve each to a coaster_id.
  const nameToId = new Map();
  for (const p of parks || []) for (const c of p.coasters) nameToId.set(ck(p.id, c.name), c.id);
  const coasterIds = [...keySet].map(k => nameToId.get(k)).filter(Boolean);

  await supabase.from("credits").delete().eq("rider_id", riderId);
  if (coasterIds.length) {
    await supabase.from("credits").insert(coasterIds.map(coaster_id => ({ rider_id: riderId, coaster_id })));
  }
}

function ck(parkId, coasterName) { return `${parkId}|||${coasterName}`; }
function uid() { return Math.random().toString(36).slice(2, 10); }

// ── Coaster data model (canonical shape) ─────────────────────────────────
// Heights are in inches. Two thresholds:
//   min            — minimum height to ride ALONE (unaccompanied)
//   minAccompanied — minimum height to ride WITH a supervising companion
//                    (lower than `min`; null when the park posts only one limit)
// Other enriched fields: type (string), speedMph (number|null), racing, defunct,
// plus external refs (rcdbId/rcdbUrl/scale/status/heightSource).
//
// normalizeCoaster() is the single funnel every seeding path (hand-seed, RCDB
// import, fill-heights) runs through, so records always share one shape.
function numOrNull(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// `type` used to be one freeform string conflating manufacturer + model (e.g.
// "B&M Inverted", "Intamin Launch"). Manufacturer/model are now real fields;
// this heuristic splits any leftover/hand-typed `type` string for back-compat
// (RCDB import supplies manufacturer/model directly — see lookup-coasters —
// so this path is mainly for old data and manual paste-ins). Longest-prefix
// match against known manufacturer names/abbreviations; no match → the whole
// string is the model (covers generic styles like "Wooden", "Mine Train").
const KNOWN_MANUFACTURERS = [
  "Bolliger & Mabillard", "B&M", "Intamin", "Vekoma", "Arrow Dynamics", "Arrow",
  "Premier Rides", "Premier", "S&S Worldwide", "S&S", "Mack Rides", "Mack",
  "Great Coasters International", "GCI", "Philadelphia Toboggan Coasters", "PTC",
  "Gerstlauer", "Zamperla", "Chance Rides", "Chance Morgan", "Chance", "Morgan",
  "Custom Coasters International", "CCI", "Anton Schwarzkopf", "Schwarzkopf",
  "Zierer", "Maurer Söhne", "Maurer", "The Gravity Group", "Gravity Group",
  "Dinn Corporation", "Dinn", "Rocky Mountain Construction", "RMC",
  "E&F Miler Industries", "Miler", "Wisdom Rides", "Wisdom", "Reverchon",
  "Pinfari", "Mondial", "Larson International", "Larson", "Setpoint",
].sort((a, b) => b.length - a.length); // longest first so "B&M" doesn't pre-empt "Bolliger & Mabillard"
function splitManufacturerModel(typeStr) {
  const s = String(typeStr || "").trim();
  if (!s) return { manufacturer: "", model: "" };
  for (const mfr of KNOWN_MANUFACTURERS) {
    if (s.toLowerCase().startsWith(mfr.toLowerCase())) {
      return { manufacturer: mfr, model: s.slice(mfr.length).trim() };
    }
  }
  return { manufacturer: "", model: s };
}

// Construction material (Steel/Wood/Hybrid) + track layout (Sit Down/Inverted/
// Suspended/…) — a separate axis from manufacturer/model. This is what RCDB's
// park-listing page actually exposes (its "material"/"design" columns), e.g.
// "Steel" + "Sit Down" for a generic looper, distinct from "B&M" + "Hyper".
function splitMaterialStyle(typeStr) {
  const s = String(typeStr || "").trim();
  if (!s) return { material: "", style: "" };
  const lower = s.toLowerCase();
  if (lower.startsWith("steel "))  return { material: "Steel",  style: s.slice(6).trim() };
  if (lower.startsWith("wood "))   return { material: "Wood",   style: s.slice(5).trim() };
  if (lower.startsWith("hybrid ")) return { material: "Hybrid", style: s.slice(7).trim() };
  if (lower.includes("wood")) return { material: "Wood", style: s };
  return { material: "", style: s }; // no material info in this string — leave blank rather than guess
}

function normalizeCoaster(raw = {}) {
  let manufacturer = String(raw.manufacturer || "").trim();
  let model = String(raw.model || "").trim();
  if (!manufacturer && !model && raw.type) {
    ({ manufacturer, model } = splitManufacturerModel(raw.type));
  }
  let material = String(raw.material || "").trim();
  let style = String(raw.style || "").trim();
  if (!material && !style && raw.type) {
    ({ material, style } = splitMaterialStyle(raw.type));
  }
  const c = {
    id: raw.id || uid(),
    name: String(raw.name || "").trim(),
    manufacturer, model, material, style,
    min: numOrNull(raw.min),
    minAccompanied: numOrNull(raw.minAccompanied),
    speedMph: numOrNull(raw.speedMph ?? raw.speed),
    heightFt: numOrNull(raw.heightFt),
    yearOpened: numOrNull(raw.yearOpened),
  };
  // accompanied limit can never exceed the ride-alone limit
  if (c.min != null && c.minAccompanied != null && c.minAccompanied > c.min) c.minAccompanied = null;
  if (raw.racing)  c.racing = true;
  if (raw.defunct) c.defunct = true;
  // carry through any external reference / provenance fields verbatim
  for (const k of ["rcdbId", "rcdbUrl", "scale", "status", "heightSource"]) {
    if (raw[k] != null) c[k] = raw[k];
  }
  return c;
}
// Display-only join — every render site that used to show `c.type` keeps working
// without auditing each one individually; manufacturer/model are the stored fields.
const coasterType = c => [c?.manufacturer, c?.model].filter(Boolean).join(" ");

// Normalize a coaster name for *fallback* matching: lower-case, then collapse every
// non-alphanumeric run (apostrophes, colons, ™/®/℠, dashes, parens, periods…) to a
// single space. This makes punctuation/trademark-symbol differences (e.g.
// "Batman: The Ride™" vs "Batman The Ride") match instead of duplicating.
function normCoasterName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
const hasRcdbId = c => c && c.rcdbId != null && c.rcdbId !== "";

// Fuzzy name match (mirrors the server's `fuzzyNameMatch`): true when one name's
// token set contains the other's and the EXTRA tokens are all filler stopwords —
// so "Flying Cobras" ↔ "The Flying Cobras" and "Apocalypse" ↔ "Apocalypse the Ride"
// match, but racing pairs ("Racer Red" vs "Racer Blue") and true renames never do.
const NAME_STOPWORDS = new Set(["the", "a", "an", "of", "and", "ride", "roller", "coaster"]);
const nameTokens = s => normCoasterName(s).split(" ").filter(Boolean);
function fuzzyCoasterMatch(a, b) {
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  const setA = new Set(ta), setB = new Set(tb);
  const [small, big] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const t of small) if (!big.has(t)) return false;
  for (const t of big) if (!small.has(t) && !NAME_STOPWORDS.has(t)) return false;
  return true;
}

// Delta-merge incoming coasters into an existing list so an import/lookup re-run
// updates in place instead of duplicating. **Dedupe key: RCDB id first** (stable
// across name/punctuation changes), falling back to the normalized name. Field-level
// merge: fills only EMPTY existing fields, never clobbering hand-entered values
// (heights, racing, defunct, type, …). Existing names are preserved so credit keys
// stay valid. Returns { coasters, added:[names], updated:[{name,fields}], unchanged }.
const MERGE_FIELDS = ["manufacturer", "model", "material", "style", "min", "minAccompanied", "speedMph", "heightFt", "yearOpened", "scale", "status", "rcdbId", "rcdbUrl", "heightSource"];
const isEmptyField = v => v == null || v === "";
function mergeCoasters(existing, incoming) {
  const out = (existing || []).map(c => ({ ...c }));   // shallow clones we may mutate
  const byId   = new Map();   // rcdbId  -> out coaster
  const byName = new Map();   // normName -> out coaster
  for (const c of out) {
    if (hasRcdbId(c)) byId.set(String(c.rcdbId), c);
    byName.set(normCoasterName(c.name), c);
  }

  const added = [], updated = [];
  const matched = new Set(), updatedRefs = new Set();

  for (const raw of incoming) {
    const inc = normalizeCoaster(raw);
    if (!inc.name) continue;
    // Match priority: RCDB id → exact normalized name → filler-word fuzzy.
    let cur = hasRcdbId(inc) ? byId.get(String(inc.rcdbId)) : null;
    if (!cur) cur = byName.get(normCoasterName(inc.name));
    if (!cur) cur = out.find(c => !matched.has(c) && fuzzyCoasterMatch(inc.name, c.name));

    if (!cur) {                              // brand-new coaster
      out.push(inc);
      if (hasRcdbId(inc)) byId.set(String(inc.rcdbId), inc);
      byName.set(normCoasterName(inc.name), inc);
      added.push(inc.name);
      continue;
    }

    matched.add(cur);
    const filled = [];                       // field-level fill of empties only
    for (const f of MERGE_FIELDS) {
      if (isEmptyField(cur[f]) && !isEmptyField(inc[f])) { cur[f] = inc[f]; filled.push(f); }
    }
    // If this match just learned an rcdbId, index it so later rows in the same
    // batch can dedupe on it too.
    if (hasRcdbId(cur)) byId.set(String(cur.rcdbId), cur);
    if (filled.length) { updated.push({ name: cur.name, fields: filled }); updatedRefs.add(cur); }
  }

  const unchanged = out.filter(c => matched.has(c) && !updatedRefs.has(c)).map(c => c.name);
  return { coasters: out, added, updated, unchanged };
}

// Ride status for a rider of `height` on coaster `c`:
//   "alone"       — meets the ride-alone limit (min)
//   "accompanied" — below min but meets the lower supervised limit (minAccompanied)
//   "no"          — too short for any posted limit
//   "unknown"     — no posted height limit at all
function rideStatus(c, height) {
  const { min, minAccompanied: acc } = c;
  if (min == null && acc == null) return "unknown";
  if (min != null && height >= min) return "alone";
  if (acc != null && height >= acc) return "accompanied";
  return "no";
}

// Single source of truth for the four height-eligibility states. Every glyph,
// label, tooltip, and the legend derive from here so the rider-height
// vocabulary stays consistent everywhere it appears.
//   tone: "pos" uses the rider's color · "neg"/"muted" use fixed greys.
const RIDE_STATUS = {
  alone:       { glyph:"✓",  label:"Can ride",       legend:"can ride alone",            tone:"pos",   tip:"Tall enough to ride on their own" },
  accompanied: { glyph:"✓*", label:"With an adult",  legend:"only with a supervising adult", tone:"pos", tip:"Tall enough only with a supervising companion" },
  no:          { glyph:"✗",  label:"Too short",      legend:"too short",                 tone:"neg",   tip:"Below every posted height requirement" },
  unknown:     { glyph:"?",  label:"Height unknown", legend:"no height on file yet",     tone:"muted", tip:"No posted height requirement recorded yet" },
};
const RIDE_STATUS_ORDER = ["alone", "accompanied", "no", "unknown"];

// Eligible = the rider can ride it somehow (alone OR accompanied) and it's operating.
// Accompanied-only rides count as eligible but are flagged with an asterisk in the UI.
function isEligible(c, height) {
  if (c.defunct) return false;
  const s = rideStatus(c, height);
  return s === "alone" || s === "accompanied";
}
function isAvailable(c) { return !c.defunct; }
// Operating coasters only — the canonical denominator. Defunct coasters are
// excluded from every count and from the main tables; they surface only in the
// By-rider defunct sub-table. Use this anywhere a count/map should ignore defunct.
function liveCoasters(p) { return (p.coasters || []).filter(isAvailable); }
function defunctCoasters(p) { return (p.coasters || []).filter(c => c.defunct); }

// ── Geography (for the offline SVG Map view) ─────────────────────────────────
// Region marker colors; unknown/user regions fall back to a neutral hue.
const REGION_COLORS = { NE:"#38bdf8", SE:"#4ade80", MW:"#facc15", TX:"#fb923c", CA:"#f472b6", INT:"#a78bfa" };
function regionColor(code) { return REGION_COLORS[code] || "#94a3b8"; }

// Park-family / chain ownership groups (replaces the old freeform `badge` for this
// purpose — `badge` stays available for one-off labels like "🏠 Home Park").
const PARK_FAMILIES = {
  SF:  { label: "Six Flags",        color: "#ef4444" },
  CF:  { label: "Cedar Fair",       color: "#22c55e" },
  UNI: { label: "Universal",        color: "#a78bfa" },
  SW:  { label: "SeaWorld / United Parks", color: "#0ea5e9" },
  IND: { label: "Independent",      color: "#94a3b8" },
};
function familyInfo(code) { return PARK_FAMILIES[code] || null; }

// Known park coordinates [lat, lng]. A park's own lat/lng (if set in settings)
// always wins; this is the seed fallback so the map works out of the box.
const PARK_COORDS = {
  carowinds:[35.10,-80.94], ki:[39.34,-84.27], sfga:[42.37,-87.94], sfog:[33.77,-84.55],
  sfne:[42.04,-72.61], kd:[37.84,-77.44], bgw:[37.23,-76.65], cw:[43.84,-79.54],
  cp:[41.48,-82.68], sfgadv:[40.14,-74.44], hershey:[40.29,-76.66], dorney:[40.58,-75.53],
  knoebels:[40.88,-76.55], sfot:[32.75,-97.07], sfft:[29.60,-98.61], sfmm:[34.43,-118.60],
  knotts:[33.84,-118.00],
};
const PARK_COORDS_BY_NAME = {
  "Nickelodeon Universe":[40.81,-74.07], "Jenkinson's Boardwalk":[40.09,-74.04],
  "iPlay America":[40.25,-74.29], "Universal Islands of Adventure":[28.47,-81.47],
  "Universal Studios":[28.48,-81.46], "Epic Universe":[28.47,-81.44],
};
// Normalize a park name for fuzzy matching: lower-case, unify apostrophe variants
// (curly ’ vs straight '), collapse whitespace. Mirrors the server's `normName`
// so a stored name with a different apostrophe still lands on the map.
function normParkName(s) {
  return String(s || "").toLowerCase().replace(/[’‘`´]/g, "'").replace(/\s+/g, " ").trim();
}
const PARK_COORDS_BY_NORM = Object.fromEntries(
  Object.entries(PARK_COORDS_BY_NAME).map(([k, v]) => [normParkName(k), v])
);
function parkCoord(p) {
  if (p.lat != null && p.lng != null) return [Number(p.lat), Number(p.lng)];
  return PARK_COORDS[p.id] || PARK_COORDS_BY_NORM[normParkName(p.name)] || null;
}

// Equirectangular projection over a North-America bounding box → SVG units.
const MAP_W = 1000, MAP_H = 560, MAP_PAD = 26;
const LNG_MIN = -125, LNG_MAX = -66, LAT_MIN = 24, LAT_MAX = 50;
function project(lat, lng) {
  const x = MAP_PAD + ((lng - LNG_MIN) / (LNG_MAX - LNG_MIN)) * (MAP_W - 2 * MAP_PAD);
  const y = MAP_PAD + ((LAT_MAX - lat) / (LAT_MAX - LAT_MIN)) * (MAP_H - 2 * MAP_PAD);
  return [x, y];
}
// Simplified continental-US silhouette (lng,lat), drawn faintly as a backdrop.
const US_OUTLINE = [
  [-124.6,48.3],[-124.2,46.3],[-124,43.3],[-122.4,40.3],[-121.3,36.6],[-120.5,34.5],
  [-117.1,32.5],[-114.7,32.7],[-111,31.3],[-108.2,31.3],[-106.5,31.8],[-103.1,29],
  [-101,29.8],[-99.2,26.4],[-97.1,25.9],[-96.5,28.4],[-94,29.7],[-91.5,29.2],[-89,29],
  [-88.9,30.4],[-87.5,30.3],[-85,29.7],[-84,30],[-82.8,28.9],[-80.6,25.2],[-80.1,26.8],
  [-81.1,31],[-80.8,32],[-78.5,33.9],[-75.9,35.2],[-75.5,37.9],[-74,39.5],[-73.9,40.5],
  [-71.9,41.3],[-70.7,41.7],[-70,43.7],[-67.8,44.8],[-67,45.2],[-69.2,47.4],[-71.5,45],
  [-74.7,45],[-76.9,43.3],[-79.8,43.3],[-82.5,41.7],[-83.1,42],[-82.5,45.3],[-84.4,46.5],
  [-88,48],[-90,48.1],[-94.6,49],[-104,49],[-114,49],[-123,49],[-124.6,48.3],
];

// ── Coaster table sorting ─────────────────────────────────────────────────
// Sort keys: "name" | "type" | "min". Unknown height (min == null) always
// sorts last regardless of direction. Default sort is height ascending.
function sortCoasters(coasters, key, dir) {
  const arr = [...coasters];
  const sign = dir === "desc" ? -1 : 1;
  arr.sort((a, b) => {
    if (key === "min") {
      const an = a.min == null, bn = b.min == null;
      if (an && bn) return a.name.localeCompare(b.name);
      if (an) return 1;          // unknown height → bottom
      if (bn) return -1;
      return (a.min - b.min) * sign || a.name.localeCompare(b.name);
    }
    return String(a[key] || "").localeCompare(String(b[key] || "")) * sign;
  });
  return arr;
}

// Sort state persists across reloads (one shared preference) via localStorage,
// so the user's last-picked column/direction sticks.
const SORT_STORE_KEY = "coasterSort";
function loadSort(defaultKey) {
  try {
    const s = JSON.parse(localStorage.getItem(SORT_STORE_KEY));
    if (s && typeof s.key === "string" && (s.dir === "asc" || s.dir === "desc")) return s;
  } catch {}
  return { key: defaultKey, dir: "asc" };
}
function useCoasterSort(defaultKey = "min") {
  const [sort, setSort] = useState(() => loadSort(defaultKey));
  useEffect(() => { try { localStorage.setItem(SORT_STORE_KEY, JSON.stringify(sort)); } catch {} }, [sort]);
  const onSort = (key) => setSort(s => s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" });
  const apply = (coasters) => sortCoasters(coasters, sort.key, sort.dir);
  return { sort, onSort, apply };
}

// Clickable sortable header cell. `base` carries the existing th styling.
function SortTh({ label, col, sort, onSort, align = "left", base = {} }) {
  const active = sort.key === col;
  return (
    <div onClick={() => onSort(col)} title="Click to sort" style={{
      cursor:"pointer", userSelect:"none", display:"flex", alignItems:"center", gap:3,
      justifyContent: align === "center" ? "center" : "flex-start",
      color: active ? T.textMid : (base.color || T.textFaint), ...base,
    }}>
      {label}<span style={{ fontSize:8, opacity: active ? 1 : 0.25 }}>{active ? (sort.dir === "asc" ? "▲" : "▼") : "▾"}</span>
    </div>
  );
}

// ── External-reference helpers (lean stubs — see backlog task #10: enrichment pipeline) ──
// These normalize foreign keys / links so coaster & park records can be cross-referenced
// against external sources later. They only DERIVE values from data we already have; the
// full enrichment/scraping lives in the consolidation task. Safe to extend, not throwaway.

// RCDB: "/1.htm" -> { rcdbId: "1", rcdbUrl: "https://rcdb.com/1.htm" }
function rcdbRef(path) {
  if (!path) return {};
  const m = String(path).match(/\/(\d+)\.htm/);
  if (!m) return {};
  return { rcdbId: m[1], rcdbUrl: `https://rcdb.com/${m[1]}.htm` };
}

// Six Flags / Cedar Fair attractions page URL from a stored slug.
// Slugs are NOT reliably derivable from park names (e.g. "SF Great Adventure" -> "greatadventure"),
// so the slug is stored per-park and only DEFAULTED here. Edit the stored value when wrong.
function sixFlagsSlugGuess(parkName) {
  return String(parkName || "")
    .toLowerCase()
    .replace(/^sf\s+/, "")        // "SF Great Adventure" -> "great adventure"
    .replace(/[^a-z0-9]+/g, "");  // collapse to "greatadventure"
}
function sixFlagsAttractionsUrl(slug) {
  return slug ? `https://www.sixflags.com/${slug}/attractions?ride-category=coaster` : null;
}

// ── color helpers ──────────────────────────────────────────────────────────
// Single height-band definition — used both for the `HtBadge`/`minHtColor`
// coloring and the Parks-detail stat cards, so the two never drift. Contiguous
// ranges (no gaps): ≤42 / 43-48 / 49-52 / 53+.
const HEIGHT_BANDS = [
  { label: '≤42"',   test: m => m <= 42,            color: "#4ade80" },
  { label: '43-48"', test: m => m >= 43 && m <= 48, color: "#facc15" },
  { label: '49-52"', test: m => m >= 49 && m <= 52, color: "#fb923c" },
  { label: '53"+',   test: m => m >= 53,            color: "#f87171" },
];
function minHtColor(min) {
  return (HEIGHT_BANDS.find(b => b.test(min)) || HEIGHT_BANDS[HEIGHT_BANDS.length - 1]).color;
}

// Validate a coaster's ride-alone (min) + accompanied (acc) height inputs.
// Returns { h, a } parsed numbers (null = blank/unknown), or { err } message.
// acc may be 0 ("any height with an adult") and must not exceed min.
function validateHeights(rawMin, rawAcc) {
  const sMin = (rawMin ?? "").toString().trim();
  const h = sMin === "" ? null : Number(sMin);
  if (h !== null && (isNaN(h) || h < 20 || h > 96))
    return { err: "Min height must be 20–96 inches, or leave blank for unknown." };
  const sAcc = (rawAcc ?? "").toString().trim();
  const a = sAcc === "" ? null : Number(sAcc);
  if (a !== null && (isNaN(a) || a < 0 || a > 96))
    return { err: "Accompanied height must be 0–96 inches (0 = any height with an adult), or blank for none." };
  if (a !== null && h !== null && a > h)
    return { err: "Accompanied height can't exceed the ride-alone height." };
  return { h, a };
}

function accessHeatColor(ratio) {
  if (ratio >= 0.85) return "#4ade80";
  if (ratio >= 0.70) return "#86efac";
  if (ratio >= 0.55) return "#facc15";
  if (ratio >= 0.40) return "#fb923c";
  return "#f87171";
}

function creditHeatColor(ratio) {
  if (ratio >= 0.85) return "#4ade80";
  if (ratio >= 0.55) return "#86efac";
  if (ratio >= 0.30) return "#facc15";
  if (ratio >  0)    return "#fb923c";
  return "#334155";
}

// ── shared atoms ───────────────────────────────────────────────────────────
// All of these style against the `T` token scale (spacing/type/radius/weight/
// color roles) so paddings, radii, fonts, and greys stay consistent app-wide.
function DefunctBadge() {
  return (
    <span title="Defunct — no longer operating. Still counts as a credit, but excluded from eligible/available." style={{
      fontSize:T.fxs, fontWeight:T.wBold, background:"#3f1d1d", color:"#fca5a5",
      border:"1px solid #7f1d1d", borderRadius:T.r1, padding:"1px 4px",
      whiteSpace:"nowrap", flexShrink:0, letterSpacing:"0.03em",
    }}>✖ defunct</span>
  );
}

// `accompanied` = the value shown is the with-adult threshold (minAccompanied),
// not the solo limit — marked with a trailing `*` and an explanatory tooltip.
function HtBadge({ min, accompanied = false }) {
  if (min == null) return (
    <span style={{
      display:"inline-flex", alignItems:"center", justifyContent:"center",
      width:36, height:20, borderRadius:T.r1, fontSize:T.fxs, fontWeight:T.wBold,
      background:T.border, color:T.textFaint, border:`1px solid ${T.border2}`, fontFamily:"monospace",
    }}>?</span>
  );
  const c = minHtColor(min);
  return (
    <span title={accompanied ? "Minimum height with a supervising adult" : undefined} style={{
      display:"inline-flex", alignItems:"center", justifyContent:"center",
      width:36, height:20, borderRadius:T.r1, fontSize:T.fxs, fontWeight:T.wBold,
      background:c+"22", color:c, border:`1px solid ${c}44`, fontFamily:"monospace",
    }}>{min}"{accompanied && <span style={{ fontSize:8, verticalAlign:"top" }}>*</span>}</span>
  );
}

// Accompanied-height (with-a-supervising-adult) cell for the data tables — amber,
// matching the Settings editor's `minAccompanied` input. A muted `—` when none is
// posted. 0 = "any height with an adult".
const ACC_AMBER = "#fbbf24";
function AccBadge({ value }) {
  if (value == null) return <span style={{ color:T.textGhost, fontSize:T.fsm }}>—</span>;
  return (
    <span title="Minimum height with a supervising adult" style={{
      display:"inline-flex", alignItems:"center", justifyContent:"center",
      width:36, height:20, borderRadius:T.r1, fontSize:T.fxs, fontWeight:T.wBold,
      background:ACC_AMBER+"1f", color:ACC_AMBER, border:`1px solid ${ACC_AMBER}3a`, fontFamily:"monospace",
    }}>{value === 0 ? "any" : `${value}"`}</span>
  );
}

// Per-coaster eligibility glyph for a rider. All glyphs/colors/tooltips come
// from RIDE_STATUS so the four states read identically across the app.
function Tick({ status, color }) {
  const def = RIDE_STATUS[status] || RIDE_STATUS.unknown;
  const fg  = def.tone === "pos" ? color : T.textFaint;
  const bd  = def.tone === "pos" ? `${color}55` : T.border2;
  const bg  = def.tone === "pos" ? `${color}1a` : "transparent";
  return (
    <span title={def.tip} style={{
      display:"inline-flex", alignItems:"center", justifyContent:"center",
      width:26, height:26, borderRadius:"50%", fontSize:T.fbase, fontWeight:T.wBold,
      background:bg, color:fg, border:`1.5px solid ${bd}`,
    }}>{def.glyph}</span>
  );
}

// Shared legend for the four height-eligibility states. `color` tints the
// positive (✓ / ✓*) glyphs to match the active rider lens.
function HeightLegend({ color = T.accent, states = RIDE_STATUS_ORDER }) {
  return (
    <div style={{ display:"flex", flexWrap:"wrap", gap:"6px 14px", fontSize:T.fxs, color:T.textFaint }}>
      {states.map(s => {
        const def = RIDE_STATUS[s];
        const fg  = def.tone === "pos" ? color : T.textLo;
        return (
          <span key={s} title={def.tip} style={{ display:"inline-flex", alignItems:"center", gap:T.s1 }}>
            <span style={{ fontWeight:T.wBold, color:fg }}>{def.glyph}</span>
            <span>{def.label} <span style={{ color:T.textGhost }}>· {def.legend}</span></span>
          </span>
        );
      })}
    </div>
  );
}

function CreditBtn({ done, color, onClick, title }) {
  return (
    <button onClick={onClick} title={title} style={{
      display:"inline-flex", alignItems:"center", justifyContent:"center",
      width:28, height:28, borderRadius:"50%", fontSize:T.fmd, fontWeight:T.wBold,
      border:`1.5px solid ${done ? color : T.border2}`,
      background: done ? color+"22" : "transparent",
      color: done ? color : T.textFaint,
      cursor:"pointer", transition:"all 0.15s", flexShrink:0, fontFamily:"inherit",
    }}>{done ? "✓" : "○"}</button>
  );
}

function ColorDot({ color, size=10 }) {
  return <span style={{ width:size, height:size, borderRadius:"50%", background:color, display:"inline-block", flexShrink:0 }}/>;
}

// ═══════════════════════════════════════════════════════════════════════════
// COASTER DETAIL MODAL — click any coaster (name) anywhere to open a centered
// detail card; a toggle flips it into an edit form. Saves funnel through the
// shared `updateCoaster` (in-place edit + credit-key migration on rename) and
// `validateHeights`, so the modal can't drift from the Settings inline editor.
// The first reusable modal primitive in the app (backdrop/Esc close, scroll-lock).
// ═══════════════════════════════════════════════════════════════════════════
function modalDraftFrom(c) {
  return {
    name: c.name ?? "", manufacturer: c.manufacturer ?? "", model: c.model ?? "",
    material: c.material ?? "", style: c.style ?? "",
    min: c.min == null ? "" : String(c.min),
    minAccompanied: c.minAccompanied == null ? "" : String(c.minAccompanied),
    speed: c.speedMph == null ? "" : String(c.speedMph),
    heightFt: c.heightFt == null ? "" : String(c.heightFt),
    yearOpened: c.yearOpened == null ? "" : String(c.yearOpened),
    racing: !!c.racing, defunct: !!c.defunct,
  };
}

function CoasterModal({ park, coaster, canEdit = true, onSave, onClose }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft]     = useState(() => modalDraftFrom(coaster));
  const [err, setErr]         = useState("");
  const panelRef = useRef(null);

  // Re-seed the draft if the underlying coaster identity changes (e.g. reopened).
  useEffect(() => { setDraft(modalDraftFrom(coaster)); setEditing(false); setErr(""); }, [coaster.name, park.id]);

  // Esc closes; lock background scroll while open; focus the panel for a11y.
  useEffect(() => {
    const onKey = e => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    panelRef.current?.focus();
    return () => { window.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [onClose]);

  function save(e) {
    e?.preventDefault?.();
    if (!draft.name.trim()) { setErr("Name is required."); return; }
    const v = validateHeights(draft.min, draft.minAccompanied);
    if (v.err) { setErr(v.err); return; }
    // Resolve the real index in park.coasters by current name (tables are sorted/filtered).
    const idx = park.coasters.findIndex(c => c.name === coaster.name);
    if (idx === -1) { setErr("Couldn't locate this coaster to save."); return; }
    onSave(park.id, idx, {
      name: draft.name.trim(), manufacturer: draft.manufacturer.trim(), model: draft.model.trim(),
      material: draft.material.trim(), style: draft.style.trim(),
      min: v.h, minAccompanied: draft.minAccompanied, speedMph: draft.speed,
      heightFt: draft.heightFt, yearOpened: draft.yearOpened,
      racing: draft.racing, defunct: draft.defunct,
    });
    setEditing(false); setErr("");
  }

  const st = (k, v) => setDraft(d => ({ ...d, [k]: v }));
  const numInput = (k, ph, extra={}) => (
    <input type="number" value={draft[k]} onChange={e=>st(k, e.target.value)} placeholder={ph}
      style={{ width:"100%", background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"7px 9px", color:T.ink, fontSize:T.fmd, fontFamily:"inherit", outline:"none", ...extra }}/>
  );
  const Row = ({ label, children }) => (
    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:T.s4, padding:`${T.s2}px 0`, borderBottom:`1px solid ${T.hair}` }}>
      <span style={{ fontSize:T.fsm, color:T.textLo }}>{label}</span>
      <span style={{ fontSize:T.fbase, color:T.text, textAlign:"right", minWidth:0 }}>{children}</span>
    </div>
  );
  const Field = ({ label, children }) => (
    <label style={{ display:"flex", flexDirection:"column", gap:T.s1 }}>
      <span style={fieldLabelCss}>{label}</span>{children}
    </label>
  );

  const prov = [
    coaster.rcdbUrl && ["RCDB", <a key="u" href={coaster.rcdbUrl} target="_blank" rel="noreferrer" style={{ color:T.accent, textDecoration:"none" }}>#{coaster.rcdbId || "link"} ↗</a>],
    coaster.heightSource && ["Height source", coaster.heightSource],
    coaster.scale && ["Scale", coaster.scale],
    coaster.status && ["Status", coaster.status],
  ].filter(Boolean);

  return (
    <div onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position:"fixed", inset:0, zIndex:50, background:"rgba(2,6,15,0.66)", display:"flex", alignItems:"center", justifyContent:"center", padding:T.s5 }}>
      <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true"
        style={{ width:"100%", maxWidth:440, maxHeight:"88vh", overflowY:"auto", background:T.panel, border:`1px solid ${T.border2}`, borderRadius:T.r5, padding:`${T.s6}px ${T.s6}px ${T.s5}px`, outline:"none", boxShadow:"0 24px 60px rgba(0,0,0,0.5)" }}>

        {/* Header */}
        <div style={{ display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:T.s4, marginBottom:T.s5 }}>
          <div style={{ minWidth:0 }}>
            <div style={{ fontSize:T.flg, fontWeight:T.wHeavy, color:T.ink, display:"flex", alignItems:"center", gap:T.s2, flexWrap:"wrap" }}>
              {editing ? "Edit coaster" : coaster.name}
              {!editing && coaster.racing && <span style={{ fontSize:T.fxs, background:"#6366f122", color:"#818cf8", border:"1px solid #6366f133", borderRadius:T.r1, padding:"1px 5px" }}>⇄ racing</span>}
              {!editing && coaster.defunct && <DefunctBadge/>}
            </div>
            <div style={{ fontSize:T.fsm, color:T.textLo, marginTop:2 }}>{park.name}{!editing && coasterType(coaster) ? ` · ${coasterType(coaster)}` : ""}</div>
          </div>
          <button onClick={onClose} title="Close (Esc)" style={{ background:"none", border:"none", color:T.textFaint, cursor:"pointer", fontSize:T.flg, lineHeight:1, padding:T.s1, flexShrink:0, fontFamily:"inherit" }}>✕</button>
        </div>

        {editing ? (
          /* ── EDIT ── */
          <form onSubmit={save} style={{ display:"flex", flexDirection:"column", gap:T.s4 }}>
            <Field label="Name">
              <input value={draft.name} onChange={e=>st("name", e.target.value)} autoFocus
                style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"7px 9px", color:T.ink, fontSize:T.fmd, fontFamily:"inherit", outline:"none" }}/>
            </Field>
            <div style={{ display:"flex", gap:T.s4 }}>
              <Field label="Manufacturer">
                <input value={draft.manufacturer} onChange={e=>st("manufacturer", e.target.value)} placeholder="e.g. B&M"
                  style={{ width:"100%", boxSizing:"border-box", background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"7px 9px", color:T.ink, fontSize:T.fmd, fontFamily:"inherit", outline:"none" }}/>
              </Field>
              <Field label="Model">
                <input value={draft.model} onChange={e=>st("model", e.target.value)} placeholder="e.g. Inverted"
                  style={{ width:"100%", boxSizing:"border-box", background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"7px 9px", color:T.ink, fontSize:T.fmd, fontFamily:"inherit", outline:"none" }}/>
              </Field>
            </div>
            <div style={{ display:"flex", gap:T.s4 }}>
              <Field label="Material">
                <input value={draft.material} onChange={e=>st("material", e.target.value)} placeholder="e.g. Steel"
                  style={{ width:"100%", boxSizing:"border-box", background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"7px 9px", color:T.ink, fontSize:T.fmd, fontFamily:"inherit", outline:"none" }}/>
              </Field>
              <Field label="Style">
                <input value={draft.style} onChange={e=>st("style", e.target.value)} placeholder="e.g. Sit Down"
                  style={{ width:"100%", boxSizing:"border-box", background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"7px 9px", color:T.ink, fontSize:T.fmd, fontFamily:"inherit", outline:"none" }}/>
              </Field>
            </div>
            <div style={{ display:"flex", gap:T.s4 }}>
              <Field label="Min (alone)">{numInput("min", "—")}</Field>
              <Field label="Acc (w/ adult)">{numInput("minAccompanied", "—", { color:"#fbbf24" })}</Field>
              <Field label="Speed (mph)">{numInput("speed", "—")}</Field>
            </div>
            <div style={{ display:"flex", gap:T.s4 }}>
              <Field label="Height (ft)">{numInput("heightFt", "—")}</Field>
              <Field label="Year opened">{numInput("yearOpened", "—")}</Field>
            </div>
            <div style={{ display:"flex", gap:T.s6, marginTop:T.s1 }}>
              <label style={{ display:"flex", alignItems:"center", gap:T.s2, fontSize:T.fsm, color:T.textMid, cursor:"pointer" }}>
                <input type="checkbox" checked={draft.racing} onChange={e=>st("racing", e.target.checked)} style={{ accentColor:"#818cf8", width:14, height:14 }}/> Racing / dueling
              </label>
              <label style={{ display:"flex", alignItems:"center", gap:T.s2, fontSize:T.fsm, color:T.textMid, cursor:"pointer" }}>
                <input type="checkbox" checked={draft.defunct} onChange={e=>st("defunct", e.target.checked)} style={{ accentColor:"#f87171", width:14, height:14 }}/> Defunct
              </label>
            </div>
            {err && <div style={{ fontSize:T.fsm, color:"#f87171" }}>{err}</div>}
            <div style={{ display:"flex", gap:T.s3, marginTop:T.s2 }}>
              <button type="submit" style={{ background:"#1e3a1e", border:"1px solid #4ade8044", color:"#4ade80", borderRadius:T.r3, padding:"8px 18px", cursor:"pointer", fontSize:T.fmd, fontWeight:T.wBold, fontFamily:"inherit" }}>Save changes</button>
              <button type="button" onClick={()=>{ setDraft(modalDraftFrom(coaster)); setEditing(false); setErr(""); }} style={{ background:"transparent", border:`1px solid ${T.border2}`, color:T.textLo, borderRadius:T.r3, padding:"8px 14px", cursor:"pointer", fontSize:T.fmd, fontFamily:"inherit" }}>Cancel</button>
            </div>
          </form>
        ) : (
          /* ── VIEW ── */
          <>
            <div>
              <Row label="Min height (alone)">{coaster.min != null ? `${coaster.min}"` : <span style={{ color:T.textFaint }}>unknown</span>}</Row>
              <Row label="Min with an adult">{coaster.minAccompanied != null ? <span style={{ color:"#fbbf24", fontWeight:T.wBold }}>{coaster.minAccompanied}"<span style={{ fontSize:8, verticalAlign:"top" }}>*</span></span> : <span style={{ color:T.textFaint }}>—</span>}</Row>
              <Row label="Top speed">{coaster.speedMph != null ? `${coaster.speedMph} mph` : <span style={{ color:T.textFaint }}>—</span>}</Row>
              <Row label="Height">{coaster.heightFt != null ? `${coaster.heightFt} ft` : <span style={{ color:T.textFaint }}>—</span>}</Row>
              <Row label="Opened">{coaster.yearOpened || <span style={{ color:T.textFaint }}>—</span>}</Row>
              <Row label="Manufacturer">{coaster.manufacturer || <span style={{ color:T.textFaint }}>—</span>}</Row>
              <Row label="Model">{coaster.model || <span style={{ color:T.textFaint }}>—</span>}</Row>
              <Row label="Material">{coaster.material || <span style={{ color:T.textFaint }}>—</span>}</Row>
              <Row label="Style">{coaster.style || <span style={{ color:T.textFaint }}>—</span>}</Row>
              {prov.map(([k, v]) => <Row key={k} label={k}>{v}</Row>)}
            </div>
            <div style={{ display:"flex", gap:T.s3, marginTop:T.s5 }}>
              {canEdit && <button onClick={()=>setEditing(true)} style={{ background:"#0f2a3f", border:"1px solid #38bdf844", color:T.accent, borderRadius:T.r3, padding:"8px 16px", cursor:"pointer", fontSize:T.fmd, fontWeight:T.wBold, fontFamily:"inherit" }}>✎ Edit details</button>}
              <button onClick={onClose} style={{ background:"transparent", border:`1px solid ${T.border2}`, color:T.textLo, borderRadius:T.r3, padding:"8px 14px", cursor:"pointer", fontSize:T.fmd, fontFamily:"inherit" }}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PARKS TAB — park list (left) + a display area that shows the offline SVG MAP
// by default, and swaps to a flattened park detail once a park is selected
// (via the list or a map marker). The detail defaults to a neutral Overview;
// an inline rider lens switches the table into per-rider height eligibility.
// ═══════════════════════════════════════════════════════════════════════════
function ParksTab({ visibleParks, allParks, riders, ridden, onToggle, onSelectAll, onClearAll, onOpenCoaster }) {
  const [selectedId,  setSelectedId]  = useState(null);   // null = show the Map; a park id = show its detail
  const [lensRiderId, setLensRiderId] = useState(null);   // null = Overview (neutral reference)
  const [hoverId,     setHoverId]     = useState(null);   // map marker hover
  const sort = useCoasterSort();

  const park       = visibleParks.find(p => p.id === selectedId) || null;   // null → Map view
  const lensRider  = riders.find(r => r.id === lensRiderId) || null;        // null → overview

  useEffect(() => {
    if (selectedId && !visibleParks.find(p => p.id === selectedId)) setSelectedId(null);  // back to Map if selection drops out
  }, [visibleParks]);
  useEffect(() => {
    if (lensRiderId && !riders.find(r => r.id === lensRiderId)) setLensRiderId(null);
  }, [riders]);

  // Per-park sidebar stat — eligible/available when a rider lens is on, else count
  function ParkStat({ p }) {
    if (!lensRider) return <span style={{ fontSize:T.fxs, color:T.textFaint }}>{liveCoasters(p).length}</span>;
    const can   = p.coasters.filter(c => isEligible(c, lensRider.height)).length;
    const total = liveCoasters(p).length;
    return <span style={{ fontSize:T.fxs, color: can > 0 ? accessHeatColor(can/total) : T.textGhost }}>{can}/{total}</span>;
  }

  // ── Left panel: park list grouped by region ──────────────────────────────
  const leftPanel = (
    <div className="ct-sidenav" style={{ width:260, flexShrink:0, borderRight:`1px solid ${T.border}`, display:"flex", flexDirection:"column", overflow:"hidden" }}>
      <div style={{ background:T.panel2, borderBottom:`1px solid ${T.border}`, padding:`${T.s3}px ${T.s5}px`, flexShrink:0 }}>
        <span style={{ ...labelCss, fontSize:T.fsm, color:T.textFaint, letterSpacing:"0.08em" }}>Parks</span>
      </div>
      <div style={{ overflowY:"auto", flex:1, padding:"8px 6px" }}>
        {/* Map / all-parks entry */}
        <button onClick={() => setSelectedId(null)} style={{
          display:"flex", alignItems:"center", gap:7, width:"100%", padding:"7px 8px", borderRadius:T.r3, border:"none",
          background: selectedId===null ? T.border : "transparent", marginBottom:T.s3,
          cursor:"pointer", textAlign:"left", fontFamily:"inherit",
        }}
          onMouseEnter={e => { if (selectedId!==null) e.currentTarget.style.background = "#1e293b22"; }}
          onMouseLeave={e => { if (selectedId!==null) e.currentTarget.style.background = "transparent"; }}
        >
          <span style={{ fontSize:T.fbase }}>🗺</span>
          <span style={{ fontSize:T.fbase, fontWeight: selectedId===null ? T.wBold : T.wMed, color: selectedId===null ? T.ink : T.textMid }}>Map · all parks</span>
        </button>
        {Object.entries(REGIONS).map(([rKey, rName]) => {
          const rParks = visibleParks.filter(p => p.region === rKey);
          if (!rParks.length) return null;
          return (
            <div key={rKey} style={{ marginBottom:T.s4 }}>
              <div style={{ ...labelCss, color:T.textGhost, letterSpacing:"0.08em", marginBottom:T.s1, padding:"0 6px" }}>{rName}</div>
              {rParks.map(p => {
                const sel = selectedId === p.id;
                return (
                  <button key={p.id} onClick={() => setSelectedId(p.id)} style={{
                    display:"flex", alignItems:"center", justifyContent:"space-between",
                    width:"100%", padding:"6px 8px", borderRadius:T.r3, border:"none",
                    background: sel ? T.border : "transparent",
                    cursor:"pointer", textAlign:"left", fontFamily:"inherit", marginBottom:1,
                  }}
                    onMouseEnter={e => { if (!sel) e.currentTarget.style.background = "#1e293b22"; }}
                    onMouseLeave={e => { if (!sel) e.currentTarget.style.background = "transparent"; }}
                  >
                    <div style={{ minWidth:0 }}>
                      <div style={{ display:"flex", alignItems:"center", gap:T.s1 }}>
                        {p.family && familyInfo(p.family) && (
                          <span title={familyInfo(p.family).label} style={{ fontSize:T.fxs, fontWeight:T.wBold, color:familyInfo(p.family).color, background:familyInfo(p.family).color+"1a", border:`1px solid ${familyInfo(p.family).color}44`, borderRadius:T.r2, padding:"0 4px", flexShrink:0 }}>{p.family}</span>
                        )}
                        <span style={{ fontSize:T.fxs, color:T.textFaint, fontWeight:T.wSemi, flexShrink:0 }}>{p.tag}</span>
                        <span style={{ fontSize:T.fbase, fontWeight: sel ? T.wBold : 400, color: sel ? T.ink : T.textMid, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.name}</span>
                      </div>
                    </div>
                    <div style={{ flexShrink:0, marginLeft:8 }}><ParkStat p={p}/></div>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );

  // ── Display area #1: the offline SVG map (shown until a park is selected) ──
  const placed = visibleParks.filter(p => parkCoord(p));
  const unplaced = visibleParks.filter(p => !parkCoord(p));
  const markerR = p => 5 + Math.min(liveCoasters(p).length, 18) * 0.5;
  const outlinePts = US_OUTLINE.map(([lng, lat]) => project(lat, lng).join(",")).join(" ");
  const mapView = (
    <div style={{ flex:1, position:"relative", overflow:"hidden", display:"flex", alignItems:"center", justifyContent:"center", padding:16, background:"radial-gradient(circle at 40% 35%, #0a1426, #060c18)" }}>
      <div style={{ position:"absolute", top:12, left:16, zIndex:1, fontSize:T.fsm, color:T.textFaint }}>
        {placed.length} parks · click a marker to open it
        {unplaced.length > 0 && <span style={{ color:T.textGhost }}> · {unplaced.length} not placed (add lat/lng in settings)</span>}
      </div>
      <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} preserveAspectRatio="xMidYMid meet" style={{ width:"100%", height:"100%", maxWidth:1100, maxHeight:620 }}>
        {[30,35,40,45].map(lat => { const [,y] = project(lat, LNG_MIN); return <line key={"la"+lat} x1={MAP_PAD} y1={y} x2={MAP_W-MAP_PAD} y2={y} stroke="#13203a" strokeWidth={1}/>; })}
        {[-120,-110,-100,-90,-80,-70].map(lng => { const [x] = project(LAT_MIN, lng); return <line key={"lo"+lng} x1={x} y1={MAP_PAD} x2={x} y2={MAP_H-MAP_PAD} stroke="#13203a" strokeWidth={1}/>; })}
        <polygon points={outlinePts} fill="#0e1b30" stroke="#1e3253" strokeWidth={1.5} strokeLinejoin="round"/>
        {placed.map(p => {
          const [lat, lng] = parkCoord(p);
          const [x, y] = project(lat, lng);
          const hov = hoverId === p.id;
          const col = regionColor(p.region);
          return (
            <g key={p.id} transform={`translate(${x},${y})`} style={{ cursor:"pointer" }}
              onClick={() => setSelectedId(p.id)} onMouseEnter={() => setHoverId(p.id)} onMouseLeave={() => setHoverId(null)}>
              {hov && <circle r={markerR(p)+5} fill={col} opacity={0.18}/>}
              <circle r={markerR(p)} fill={col} fillOpacity={hov?0.95:0.7} stroke={hov?"#f8fafc":col} strokeWidth={hov?2:1}/>
              {hov && (
                <text x={0} y={-markerR(p)-7} textAnchor="middle" fontSize={13} fontWeight={700} fill="#f1f5f9" style={{ paintOrder:"stroke", stroke:"#060c18", strokeWidth:4, strokeLinejoin:"round" }}>{p.name}</text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );

  // ── Display area #2: flattened park detail (overview ⇄ rider-height lens) ──
  const detail = !park ? null : (() => {
  const live = liveCoasters(park);
  const can = lensRider ? live.filter(c => isEligible(c, lensRider.height)).length : 0;
  const avail = live.length;
  return (
    <div className="ct-content" style={{ flex:1, overflowY:"auto", padding:"14px 20px 24px" }}>
      {/* Breadcrumb back to the map */}
      <button onClick={() => setSelectedId(null)} style={{ display:"inline-flex", alignItems:"center", gap:5, background:"none", border:"none", color:T.textLo, cursor:"pointer", fontSize:T.fsm, fontFamily:"inherit", padding:0, marginBottom:T.s3 }}>
        <span style={{ fontSize:T.fbase }}>🗺</span> ← Back to map
      </button>
      {/* Park header */}
      <div style={{ marginBottom:T.s5, display:"flex", alignItems:"flex-start", justifyContent:"space-between", gap:T.s4, flexWrap:"wrap" }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:T.s2 }}>
            {park.family && familyInfo(park.family) && (
              <span title={familyInfo(park.family).label} style={{ fontSize:T.fxs, fontWeight:T.wBold, color:familyInfo(park.family).color, background:familyInfo(park.family).color+"1a", border:`1px solid ${familyInfo(park.family).color}44`, borderRadius:T.r2, padding:"1px 5px" }}>{park.family}</span>
            )}
            <div style={{ fontSize:T.flg, fontWeight:T.wHeavy, color:T.ink }}>{park.name}</div>
          </div>
          <div style={{ fontSize:T.fsm, color:T.textLo, marginTop:2 }}>
            {lensRider
              ? <><strong style={{color:lensRider.color}}>{can}</strong> of <strong style={{color:T.textMid}}>{avail}</strong> coasters accessible at {lensRider.height}"{lensRider.needsCompanion && <span title="Needs a supervising adult for accompanied-only (✓*) coasters" style={{ color:ACC_AMBER }}> · needs an adult for ✓*</span>}</>
              : <>{avail} coasters{(() => { const m = live.filter(c=>c.min==null).length; return m>0 ? <span style={{ color:"#fb923c99" }}> · {m} missing a height (add in Settings ▸ Parks)</span> : null; })()}</>}
          </div>
        </div>
        {park.officialUrl && (
          <a href={park.officialUrl} target="_blank" rel="noreferrer"
            style={{ fontSize:T.fsm, color:T.accent, textDecoration:"none", background:"#0f2a3f", border:"1px solid #38bdf833", borderRadius:T.r3, padding:"5px 11px", whiteSpace:"nowrap" }}>
            📏 Official height chart ↗
          </a>
        )}
      </div>

      {/* Inline rider lens (one level below the header) */}
      <div style={{ display:"flex", alignItems:"center", gap:T.s2, marginBottom:T.s6, flexWrap:"wrap" }}>
        <span style={{ ...labelCss, marginRight:2 }}>View</span>
        <button onClick={() => setLensRiderId(null)} style={{
          display:"flex", alignItems:"center", gap:5, padding:"3px 11px", borderRadius:T.r5,
          border: !lensRider ? `1px solid ${T.accent}` : `1px solid ${T.border2}`,
          background: !lensRider ? "#38bdf822" : "transparent",
          color: !lensRider ? T.accent : T.textLo, cursor:"pointer", fontSize:T.fsm, fontFamily:"inherit",
        }}>🗺 Overview</button>
        {riders.map(r => (
          <button key={r.id} onClick={() => setLensRiderId(r.id)} style={{
            display:"flex", alignItems:"center", gap:5, padding:"3px 9px", borderRadius:T.r5,
            border: r.id===lensRider?.id ? `1px solid ${r.color}` : `1px solid ${T.border2}`,
            background: r.id===lensRider?.id ? r.color+"22" : "transparent",
            color: r.id===lensRider?.id ? r.color : T.textLo, cursor:"pointer", fontSize:T.fsm, fontFamily:"inherit",
          }}>
            <ColorDot color={r.color} size={7}/>{r.name}
          </button>
        ))}
      </div>

      {/* Stat cards (reference) */}
      <div style={{ display:"flex", gap:T.s4, marginBottom:T.s6, flexWrap:"wrap" }}>
        <StatCard label="Coasters" value={avail} color={T.ink}/>
        {HEIGHT_BANDS.map(b => (
          <StatCard key={b.label} label={`Min ${b.label}`} value={live.filter(c=>c.min!=null&&b.test(c.min)).length} color={b.color}/>
        ))}
        <StatCard label="Unknown" value={live.filter(c=>c.min==null).length} color={T.textFaint}/>
        {lensRider && <StatCard label={`${lensRider.name} can ride`} value={can} color={lensRider.color}/>}
      </div>

      {/* Coaster table — last column adapts to the active lens */}
      <div style={{ background:T.panel, border:`1px solid ${T.border}`, borderRadius:T.r5, overflow:"hidden" }}>
        <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr 60px 56px 64px", padding:"8px 14px", background:T.panel2, borderBottom:`1px solid ${T.border}`, ...labelCss, gap:T.s2, alignItems:"center" }}>
          <SortTh label="Coaster" col="name" sort={sort.sort} onSort={sort.onSort}/>
          <SortTh label="Type" col="type" sort={sort.sort} onSort={sort.onSort}/>
          <SortTh label="Min" col="min" sort={sort.sort} onSort={sort.onSort} align="center"/>
          <div style={{textAlign:"center"}} title="Minimum height with a supervising adult">w/ adult</div>
          <div style={{textAlign:"center", color: lensRider ? lensRider.color : T.textFaint}}>{lensRider ? lensRider.name : "Racing"}</div>
        </div>
        {sort.apply(live).map((c, i, arr) => {
          const st = lensRider ? rideStatus(c, lensRider.height) : undefined;  // alone|accompanied|no|unknown
          const eligible = st === "alone" || st === "accompanied";
          const dim = lensRider && !eligible;
          const lowest = c.minAccompanied ?? c.min;   // lowest posted threshold, for the "need X" hint
          return (
            <div key={c.name} style={{ display:"grid", gridTemplateColumns:"2fr 1fr 60px 56px 64px", padding:"8px 14px", borderBottom: i<arr.length-1?`1px solid ${T.hair}`:"none",
              background: lensRider
                ? (eligible ? (i%2===0?"transparent":T.zebra) : (i%2===0?"#0a0510":"#070309"))
                : (i%2===0?"transparent":T.zebra),
              alignItems:"center", gap:T.s2 }}>
              <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                {c.racing && <span style={{ fontSize:T.fxs, background:"#6366f122", color:"#818cf8", border:"1px solid #6366f133", borderRadius:T.r1, padding:"1px 4px" }}>⇄</span>}
                <span onClick={()=>onOpenCoaster(park.id, c)} title="View coaster details" onMouseEnter={e=>e.currentTarget.style.textDecoration="underline"} onMouseLeave={e=>e.currentTarget.style.textDecoration="none"} style={{ fontSize:T.fbase, fontWeight:T.wSemi, color: dim ? T.textGhost : T.text, cursor:"pointer" }}>{c.name}</span>
                {st==="accompanied" && <span title={RIDE_STATUS.accompanied.tip} style={{ fontSize:T.fxs, color:lensRider.color, marginLeft:2, fontWeight:T.wBold }}>{c.minAccompanied===0 ? "any height with an adult" : "with an adult"}</span>}
                {st==="no" && <span style={{ fontSize:T.fxs, color:T.textLo, marginLeft:2 }}>{lowest!=null ? `${lowest-lensRider.height}" too short` : "too short"}</span>}
                {st==="unknown" && <span style={{ fontSize:T.fxs, color:T.textFaint, marginLeft:2 }}>{RIDE_STATUS.unknown.legend}</span>}
              </div>
              <div style={{ fontSize:T.fsm, color:T.textFaint }}>{coasterType(c)}{c.speedMph!=null && <span style={{ color:T.textGhost }}> · {c.speedMph} mph</span>}</div>
              <div style={{textAlign:"center"}}><HtBadge min={c.min}/></div>
              <div style={{textAlign:"center"}}><AccBadge value={c.minAccompanied}/></div>
              <div style={{textAlign:"center"}}>
                {lensRider
                  ? <Tick status={st} color={lensRider.color}/>
                  : (c.racing ? <span style={{ fontSize:T.fxs, background:"#6366f122", color:"#818cf8", border:"1px solid #6366f133", borderRadius:T.r1, padding:"2px 5px" }}>⇄ dual</span> : <span style={{ color:T.textGhost }}>—</span>)}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ marginTop:T.s5, display:"flex", flexDirection:"column", gap:T.s2 }}>
        {lensRider && <HeightLegend color={lensRider.color}/>}
        <div style={{ fontSize:T.fxs, color:T.textGhost }}>
          <span style={{color:"#818cf8"}}>⇄</span> = dueling/racing — both tracks count as separate credits
          {lensRider && <> · pick <strong style={{color:T.accent}}>🗺 Overview</strong> to see all coasters neutrally</>}
        </div>
      </div>
    </div>
  );
  })();

  return (
    <div className="ct-split">
      {leftPanel}
      {park ? detail : mapView}
    </div>
  );
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ background:T.panel2, border:`1px solid ${T.border}`, borderRadius:T.r4, padding:`${T.s3}px ${T.s6}px`, minWidth:100 }}>
      <div style={{ ...labelCss, color:T.textLo, marginBottom:2 }}>{label}</div>
      <div style={{ fontSize:T.f2xl, fontWeight:T.wHeavy, color }}>{value}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// CREDIT TRACKER — all riders in one table, select-all per rider
// ═══════════════════════════════════════════════════════════════════════════
function CreditTracker({ riders, ridden, onToggle, onSelectAll, onClearAll, visibleParks, allParks, onOpenCoaster, jump }) {
  const [pivot,    setPivot]    = useState("park");         // "park" = parks down left · "rider" = riders down left
  const [dashPark, setDashPark] = useState(visibleParks[0]?.id || "");
  const [riderId,  setRiderId]  = useState(riders[0]?.id || null);
  const sort = useCoasterSort();

  // External deep-link request (e.g. clicking a top-bar rider pill) — `jump` is a
  // fresh object each time, so this fires even when re-jumping to the same rider.
  useEffect(() => {
    if (!jump) return;
    if (jump.pivot) setPivot(jump.pivot);
    if (jump.riderId) setRiderId(jump.riderId);
  }, [jump]);

  // By-rider view: filter + collapsible park drawers
  const [riderFilter,       setRiderFilter]       = useState("");
  const [riderStatusFilter, setRiderStatusFilter] = useState("all");   // all | progress | unstarted | complete
  const [expandedParks,     setExpandedParks]     = useState(() => new Set()); // park ids expanded (default: all collapsed)
  const [riderEligibleOnly, setRiderEligibleOnly] = useState(false); // show only coasters the rider can ride
  const [riderRiddenOnly,   setRiderRiddenOnly]   = useState(false); // show only coasters already ridden
  const toggleParkOpen = id => setExpandedParks(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  useEffect(() => {
    if (!visibleParks.find(p => p.id === dashPark)) setDashPark(visibleParks[0]?.id || "");
  }, [visibleParks]);
  useEffect(() => {
    if (!riders.find(r => r.id === riderId) && riders[0]) setRiderId(riders[0].id);
  }, [riders]);

  const parkData = visibleParks.find(p => p.id === dashPark) || visibleParks[0];
  const rider    = riders.find(r => r.id === riderId) || riders[0];
  if (!parkData) return <EmptyRiders/>;

  const riderCols  = `${riders.map(() => "52px").join(" ")}`;
  const gridCols   = riders.length > 0 ? `2fr 1fr 52px 52px ${riderCols} 40px` : "2fr 1fr 52px 52px";
  const totalsParks = allParks || visibleParks;

  // ── Pivot switcher (top of detail) ───────────────────────────────────────
  const pivotBar = (
    <div style={{ background:T.panel2, borderBottom:`1px solid ${T.border}`, padding:"7px 16px", display:"flex", gap:T.s4, alignItems:"center", flexWrap:"wrap", flexShrink:0 }}>
      <span style={labelCss}>Pivot</span>
      <div style={{ display:"flex", gap:3, background:T.panel, borderRadius:T.r3, padding:3, border:`1px solid ${T.border}` }}>
        {[{id:"park",label:"🎡 By park"},{id:"rider",label:"👤 By rider"}].map(l => (
          <button key={l.id} onClick={() => setPivot(l.id)} style={{
            padding:"4px 12px", borderRadius:T.r2, border:"none", fontFamily:"inherit",
            fontSize:T.fsm, fontWeight: pivot===l.id ? T.wBold : 400,
            background: pivot===l.id ? T.border : "transparent",
            color: pivot===l.id ? T.ink : T.textLo, cursor:"pointer",
          }}>{l.label}</button>
        ))}
      </div>
      <span style={{ fontSize:T.fxs, color:T.textFaint }}>
        {pivot==="park" ? "All riders × coasters for one park" : "One rider's credits across all parks"}
      </span>
    </div>
  );

  // ── Left nav: PARK list (pivot = park) ───────────────────────────────────
  const parkNav = (
    <div className="ct-sidenav" style={{ width:260, flexShrink:0, borderRight:`1px solid ${T.border}`, overflowY:"auto", padding:T.s6 }}>
      <div style={{ ...labelCss, fontSize:T.fsm, color:T.textFaint, letterSpacing:"0.08em", marginBottom:T.s4 }}>Parks</div>
      {Object.entries(REGIONS).map(([rKey, rName]) => {
        const rParks = visibleParks.filter(p => p.region === rKey);
        if (!rParks.length) return null;
        return (
          <div key={rKey} style={{ marginBottom:T.s6 }}>
            <div style={{ ...labelCss, color:T.textGhost, letterSpacing:"0.08em", marginBottom:T.s2 }}>{rName}</div>
            <div style={{ display:"flex", flexDirection:"column", gap:T.s1 }}>
              {rParks.map(p => {
                const selected = dashPark === p.id;
                const total    = liveCoasters(p).length;
                return (
                  <button key={p.id} onClick={() => setDashPark(p.id)} style={{
                    display:"flex", alignItems:"center", justifyContent:"space-between",
                    gap:T.s3, padding:"8px 10px", borderRadius:T.r3, border:"none", cursor:"pointer",
                    background: selected ? T.border : "transparent",
                    outline: selected ? `1px solid ${T.border2}` : "none",
                    textAlign:"left", fontFamily:"inherit", transition:"background 0.12s",
                  }}>
                    <div>
                      <div style={{ fontSize:T.fsm, fontWeight: selected ? T.wBold : T.wMed, color: selected ? T.ink : T.textMid }}>{p.name}</div>
                      <div style={{ fontSize:T.fxs, color:T.textFaint, marginTop:1 }}>
                        {riders.map(r => {
                          const n = liveCoasters(p).filter(c => ridden[r.id]?.has(ck(p.id, c.name))).length;
                          return <span key={r.id} style={{ marginRight:6, color: n > 0 ? r.color : T.textGhost }}>{r.name[0]}: {n}</span>;
                        })}
                      </div>
                    </div>
                    <span style={{ fontSize:T.fxs, color:T.textGhost, flexShrink:0 }}>{total}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );

  // ── Left nav: RIDER list (pivot = rider) ─────────────────────────────────
  const riderNav = (
    <div className="ct-sidenav" style={{ width:260, flexShrink:0, borderRight:`1px solid ${T.border}`, overflowY:"auto", padding:T.s6 }}>
      <div style={{ ...labelCss, fontSize:T.fsm, color:T.textFaint, letterSpacing:"0.08em", marginBottom:T.s4 }}>Riders</div>
      {riders.length === 0 && <div style={{ fontSize:T.fsm, color:T.textGhost, fontStyle:"italic" }}>No riders yet.</div>}
      <div style={{ display:"flex", flexDirection:"column", gap:T.s1 }}>
        {riders.map(r => {
          const selected = rider?.id === r.id;
          const done     = totalsParks.reduce((s,p)=>s+liveCoasters(p).filter(c=>ridden[r.id]?.has(ck(p.id,c.name))).length,0);
          const eligible = totalsParks.reduce((s,p)=>s+p.coasters.filter(c=>isEligible(c,r.height)).length,0);
          const pct      = eligible>0 ? done/eligible : 0;
          return (
            <button key={r.id} onClick={() => setRiderId(r.id)} style={{
              display:"flex", flexDirection:"column", gap:T.s1, padding:"8px 10px", borderRadius:T.r3, border:"none", cursor:"pointer",
              background: selected ? T.border : "transparent",
              outline: selected ? `1px solid ${r.color}55` : "none",
              textAlign:"left", fontFamily:"inherit", transition:"background 0.12s",
            }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:T.s3 }}>
                <span style={{ display:"flex", alignItems:"center", gap:T.s2, fontSize:T.fbase, fontWeight: selected ? T.wBold : T.wMed, color: selected ? T.ink : T.textMid }}>
                  <ColorDot color={r.color} size={8}/>{r.name}
                </span>
                <span style={{ fontSize:T.fxs, color: done>0?r.color:T.textGhost, fontWeight:T.wBold, flexShrink:0 }}>{done}<span style={{color:T.textFaint,fontWeight:400}}>/{eligible}</span></span>
              </div>
              <div style={{ height:3, borderRadius:2, background:T.border, overflow:"hidden" }}>
                <div style={{ height:"100%", width:`${pct*100}%`, background:r.color, borderRadius:2 }}/>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );

  // ── Right: all-riders grid (one park) ────────────────────────────────────
  const allRidersBody = (
    <div className="ct-content" style={{ flex:1, overflowY:"auto", padding:"14px 20px 24px" }}>
      <div style={{ display:"flex", alignItems:"center", gap:T.s4, marginBottom:T.s5, flexWrap:"wrap" }}>
        <div>
          <div style={{ fontSize:T.flg, fontWeight:T.wHeavy, color:T.ink }}>{parkData.name}</div>
          <div style={{ fontSize:T.fsm, color:T.textLo, marginTop:2 }}>{liveCoasters(parkData).length} coasters</div>
        </div>
        {/* Per-rider summary pills */}
        <div style={{ display:"flex", gap:T.s2, marginLeft:"auto", flexWrap:"wrap" }}>
          {riders.map(r => {
            const n   = liveCoasters(parkData).filter(c => ridden[r.id]?.has(ck(parkData.id, c.name))).length;
            const tot = liveCoasters(parkData).length;
            return (
              <div key={r.id} style={{ background:T.panel2, border:`1px solid ${r.color}33`, borderRadius:T.r3, padding:"5px 10px", textAlign:"center" }}>
                <div style={{ fontSize:T.fxs, color:r.color, fontWeight:T.wBold, marginBottom:1 }}>{r.name}</div>
                <div style={{ fontSize:T.flg, fontWeight:T.wHeavy, color: n > 0 ? r.color : T.textGhost }}>{n}<span style={{ fontSize:T.fxs, color:T.textFaint, fontWeight:400 }}>/{tot}</span></div>
              </div>
            );
          })}
        </div>
      </div>

      {riders.length === 0
        ? <EmptyRiders/>
        : (
          <div className="ct-hscroll">
          <div style={{ background:T.panel, border:`1px solid ${T.border}`, borderRadius:T.r5, overflow:"hidden", minWidth: 412 + riders.length*60 }}>
            {/* Header row */}
            <div style={{ display:"grid", gridTemplateColumns:gridCols, padding:"8px 14px", background:T.panel2, borderBottom:`1px solid ${T.border}`, gap:T.s2, alignItems:"center" }}>
              <SortTh label="Coaster" col="name" sort={sort.sort} onSort={sort.onSort} base={labelCss}/>
              <SortTh label="Type" col="type" sort={sort.sort} onSort={sort.onSort} base={labelCss}/>
              <SortTh label="Min" col="min" sort={sort.sort} onSort={sort.onSort} align="center" base={labelCss}/>
              <div style={{ ...labelCss, textAlign:"center" }} title="Minimum height with a supervising adult">w/ adult</div>
              {riders.map(r => {
                const allDone = liveCoasters(parkData).every(c => ridden[r.id]?.has(ck(parkData.id, c.name)));
                return (
                  <div key={r.id} style={{ textAlign:"center", display:"flex", flexDirection:"column", alignItems:"center", gap:2 }}>
                    <div style={{ ...labelCss, color:r.color, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis", maxWidth:48 }}>{r.name}</div>
                    <button
                      onClick={() => allDone ? onClearAll(r.id, parkData) : onSelectAll(r.id, parkData)}
                      title={allDone ? `Clear all for ${r.name}` : `Select all for ${r.name}`}
                      style={{
                        fontSize:T.fxs, fontWeight:T.wBold, padding:"1px 5px", borderRadius:T.r1,
                        border:`1px solid ${allDone ? r.color+"66" : r.color+"44"}`,
                        background: allDone ? r.color+"22" : "transparent",
                        color: allDone ? r.color : r.color+"88",
                        cursor:"pointer", fontFamily:"inherit", whiteSpace:"nowrap",
                      }}
                    >{allDone ? "clear" : "all"}</button>
                  </div>
                );
              })}
              {/* Row-all header */}
              <div style={{ ...labelCss, textAlign:"center" }}>All</div>
            </div>

            {/* Coaster rows */}
            {sort.apply(liveCoasters(parkData)).map((c, i, arr) => {
              const key      = ck(parkData.id, c.name);
              const anyDone  = riders.some(r => ridden[r.id]?.has(key));
              const allDone  = riders.length > 0 && riders.every(r => ridden[r.id]?.has(key));
              return (
                <div key={c.name} style={{
                  display:"grid", gridTemplateColumns:gridCols,
                  padding:"7px 14px",
                  borderBottom: i < arr.length - 1 ? `1px solid ${T.hair}` : "none",
                  background: i%2===0 ? "transparent" : T.zebra,
                  alignItems:"center", gap:T.s2,
                }}
                  onMouseEnter={e => e.currentTarget.style.background = "#1e293b22"}
                  onMouseLeave={e => e.currentTarget.style.background = i%2===0 ? "transparent" : T.zebra}
                >
                  <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                    {c.racing && <span style={{ fontSize:T.fxs, background:"#6366f122", color:"#818cf8", border:"1px solid #6366f133", borderRadius:T.r1, padding:"1px 4px", flexShrink:0 }}>⇄</span>}
                    <span onClick={()=>onOpenCoaster(parkData.id, c)} title="View coaster details" onMouseEnter={e=>e.currentTarget.style.textDecoration="underline"} onMouseLeave={e=>e.currentTarget.style.textDecoration="none"} style={{ fontSize:T.fbase, fontWeight:T.wSemi, color: anyDone ? T.text : T.textLo, cursor:"pointer" }}>{c.name}</span>
                  </div>
                  <div style={{ fontSize:T.fsm, color:T.textFaint }}>{coasterType(c)}</div>
                  <div style={{textAlign:"center"}}><HtBadge min={c.min}/></div>
                  <div style={{textAlign:"center"}}><AccBadge value={c.minAccompanied}/></div>
                  {riders.map(r => {
                    const done = ridden[r.id]?.has(key);
                    return (
                      <div key={r.id} style={{textAlign:"center"}}>
                        <CreditBtn done={done} color={r.color} onClick={() => onToggle(r.id, key)} title={`${done?"Unmark":"Mark"} ${c.name} for ${r.name}`}/>
                      </div>
                    );
                  })}
                  {/* Row-level all/clear button */}
                  <div style={{textAlign:"center"}}>
                    <button
                      onClick={() => riders.forEach(r => {
                        const done = ridden[r.id]?.has(key);
                        if (!allDone && !done) onToggle(r.id, key);
                        if (allDone  &&  done) onToggle(r.id, key);
                      })}
                      title={allDone ? "Clear all riders for this coaster" : "Mark all riders for this coaster"}
                      style={{
                        width:28, height:28, borderRadius:"50%", fontSize:T.fsm, fontWeight:T.wBold,
                        border:`1.5px solid ${allDone ? "#a78bfa66" : anyDone ? "#a78bfa44" : T.border2}`,
                        background: allDone ? "#a78bfa22" : "transparent",
                        color: allDone ? "#a78bfa" : anyDone ? "#a78bfa66" : T.textGhost,
                        cursor:"pointer", fontFamily:"inherit",
                      }}
                    >{allDone ? "✓" : "★"}</button>
                  </div>
                </div>
              );
            })}
          </div>
          </div>
        )
      }
      <div style={{ marginTop:T.s4, fontSize:T.fxs, color:T.textGhost }}>
        <span style={{color:"#818cf8"}}>⇄</span> = Dueling/racing — both tracks are separate credits · Click column header <span style={{color:T.textMid}}>all</span> to select/clear entire park for a rider
      </div>
    </div>
  );

  // ── Right: one rider across ALL parks (clickable, grouped by region/park) ─
  const riderBody = !rider ? <EmptyRiders/> : (() => {
    const allRidden   = totalsParks.reduce((s,p)=>s+liveCoasters(p).filter(c=>ridden[rider.id]?.has(ck(p.id,c.name))).length,0);
    const allEligible = totalsParks.reduce((s,p)=>s+p.coasters.filter(c=>isEligible(c,rider.height)).length,0);
    const visitedParks   = totalsParks.filter(p => liveCoasters(p).some(c => ridden[rider.id]?.has(ck(p.id,c.name))));
    const visitedRidden   = visitedParks.reduce((s,p)=>s+liveCoasters(p).filter(c=>ridden[rider.id]?.has(ck(p.id,c.name))).length,0);
    const visitedEligible = visitedParks.reduce((s,p)=>s+p.coasters.filter(c=>isEligible(c,rider.height)).length,0);
    return (
      <div className="ct-content" style={{ flex:1, overflowY:"auto", padding:"14px 20px 24px" }}>
        {/* Global rider strip */}
        <div style={{ background:`${rider.color}0d`, border:`1px solid ${rider.color}22`, borderRadius:T.r4, padding:`${T.s4}px ${T.s6}px`, marginBottom:T.s6, display:"flex", alignItems:"center", gap:T.s6, flexWrap:"wrap" }}>
          <div style={{ display:"flex", alignItems:"center", gap:T.s3 }}>
            <span style={{ fontSize:T.flg, fontWeight:T.wHeavy, color:rider.color }}>{rider.name}</span>
            {rider.height
              ? <span style={{ fontSize:T.fsm, fontWeight:T.wBold, color:rider.color, background:`${rider.color}1a`, border:`1px solid ${rider.color}44`, borderRadius:T.pill, padding:`2px ${T.s3}px` }}>{rider.height}" tall</span>
              : <span style={{ fontSize:T.fsm, color:"#fb923c" }}>no height set — add in Settings ▸ Riders</span>}
            {rider.needsCompanion && <span title="This rider needs a supervising adult to ride accompanied-only (✓*) coasters" style={{ fontSize:T.fsm, fontWeight:T.wBold, color:ACC_AMBER, background:ACC_AMBER+"1f", border:`1px solid ${ACC_AMBER}3a`, borderRadius:T.pill, padding:`2px ${T.s3}px` }}>needs an adult for ✓*</span>}
          </div>
          <div style={{ fontSize:T.fsm, color:T.textLo }}>
            <strong style={{color:rider.color}}>{visitedRidden}</strong> of <strong style={{color:T.textMid}}>{visitedEligible}</strong> eligible credits at parks visited
            <span style={{ color:T.textGhost }}> · <strong style={{color:rider.color}}>{allRidden}</strong>/<strong style={{color:T.textMid}}>{allEligible}</strong> across all {totalsParks.length} parks</span>
            <span style={{ color:T.textGhost }}> · eligible counts <strong style={{color:rider.color}}>✓*</strong> with-adult rides</span>
          </div>
          <div style={{ flex:1, minWidth:120 }}>
            <div style={{ height:5, borderRadius:T.r2, background:T.border, overflow:"hidden" }}>
              <div style={{ height:"100%", width:`${visitedEligible>0?(visitedRidden/visitedEligible)*100:0}%`, background:`linear-gradient(90deg,${rider.color},${rider.color}99)`, borderRadius:T.r2 }}/>
            </div>
          </div>
        </div>

        {/* Per-park stats + status, then filter */}
        {(() => {
          const q = riderFilter.trim().toLowerCase();
          const withStats = visibleParks
            .filter(p => p.coasters.length)
            .map(p => {
              const done     = liveCoasters(p).filter(c => ridden[rider.id]?.has(ck(p.id, c.name))).length;
              const eligible = p.coasters.filter(c => isEligible(c, rider.height)).length;
              const status   = done === 0 ? "unstarted" : (eligible > 0 && done >= eligible ? "complete" : "progress");
              return { p, done, eligible, status };
            });
          const matches = withStats.filter(({ p, status }) =>
            (!q || p.name.toLowerCase().includes(q)) &&
            (riderStatusFilter === "all" || riderStatusFilter === status));
          const matchIds = matches.map(m => m.p.id);
          const allOpen  = matchIds.length > 0 && matchIds.every(id => expandedParks.has(id));

          const FILTERS = [
            { id:"all",       label:"All" },
            { id:"progress",  label:"In progress" },
            { id:"unstarted", label:"Unstarted" },
            { id:"complete",  label:"Complete" },
          ];

          return (
            <>
              {/* Controls bar */}
              <div style={{ position:"sticky", top:0, zIndex:2, background:T.bg, display:"flex", alignItems:"center", gap:T.s3, flexWrap:"wrap", paddingBottom:T.s4, marginBottom:T.s1 }}>
                <input value={riderFilter} onChange={e=>setRiderFilter(e.target.value)} placeholder="Filter parks…"
                  style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r3, padding:"5px 10px", color:T.ink, fontSize:T.fbase, fontFamily:"inherit", outline:"none", width:160 }}/>
                <div style={{ display:"flex", gap:3, background:T.panel, borderRadius:T.r3, padding:3, border:`1px solid ${T.border}` }}>
                  {FILTERS.map(f => (
                    <button key={f.id} onClick={()=>setRiderStatusFilter(f.id)} style={{
                      padding:"3px 10px", borderRadius:T.r2, border:"none", fontFamily:"inherit", fontSize:T.fsm,
                      fontWeight: riderStatusFilter===f.id ? T.wBold : 400,
                      background: riderStatusFilter===f.id ? T.border : "transparent",
                      color: riderStatusFilter===f.id ? T.ink : T.textLo, cursor:"pointer",
                    }}>{f.label}</button>
                  ))}
                </div>
                {[
                  { on:riderEligibleOnly, set:setRiderEligibleOnly, label:"Eligible only", color:rider.color },
                  { on:riderRiddenOnly,   set:setRiderRiddenOnly,   label:"Ridden only",   color:"#4ade80" },
                ].map(t => (
                  <button key={t.label} onClick={()=>t.set(v=>!v)} style={{
                    fontSize:T.fsm, padding:"4px 10px", borderRadius:T.r2, cursor:"pointer", fontFamily:"inherit",
                    border:`1px solid ${t.on ? t.color : T.border2}`,
                    background: t.on ? `${t.color}22` : "transparent",
                    color: t.on ? t.color : T.textLo, fontWeight: t.on ? T.wBold : 400,
                  }}>{t.on ? "✓ " : ""}{t.label}</button>
                ))}
                <button onClick={()=>setExpandedParks(allOpen ? new Set() : new Set(matchIds))}
                  style={{ fontSize:T.fsm, padding:"4px 10px", borderRadius:T.r2, border:`1px solid ${T.border2}`, background:"transparent", color:T.textMid, cursor:"pointer", fontFamily:"inherit" }}>
                  {allOpen ? "Collapse all" : "Expand all"}
                </button>
                <span style={{ fontSize:T.fxs, color:T.textFaint, marginLeft:"auto" }}>{matches.length} of {withStats.length} parks</span>
              </div>

              {matches.length === 0 && (
                <div style={{ fontSize:T.fbase, color:T.textGhost, fontStyle:"italic", padding:"20px 0" }}>No parks match this filter.</div>
              )}

              {/* Region-grouped collapsible park drawers */}
              {Object.entries(REGIONS).map(([rKey, rName]) => {
                const rParks = matches.filter(({ p }) => p.region === rKey);
                if (!rParks.length) return null;
                return (
                  <div key={rKey} style={{ marginBottom:T.s6 }}>
                    <div style={{ ...labelCss, color:T.textGhost, letterSpacing:"0.08em", marginBottom:T.s3 }}>{rName}</div>
                    {rParks.map(({ p, done, eligible, status }) => {
                      const open = expandedParks.has(p.id);
                      const pct  = eligible > 0 ? done/eligible : 0;
                      const dot  = status==="complete" ? "#4ade80" : status==="progress" ? rider.color : T.textFaint;
                      return (
                        <div key={p.id} style={{ background:T.panel, border:`1px solid ${T.border}`, borderRadius:T.r5, overflow:"hidden", marginBottom:T.s3 }}>
                          {/* Drawer header (toggle) */}
                          <button onClick={()=>toggleParkOpen(p.id)} style={{
                            display:"flex", alignItems:"center", gap:T.s4, width:"100%", padding:"9px 14px",
                            background: open ? "#111c30" : T.panel2, border:"none", borderBottom: open ? `1px solid ${T.border}` : "none",
                            cursor:"pointer", textAlign:"left", fontFamily:"inherit",
                          }}>
                            <span style={{ fontSize:T.fxs, color:T.textFaint, width:10, flexShrink:0, transition:"transform 0.12s", display:"inline-block", transform: open?"rotate(90deg)":"none" }}>▸</span>
                            <span style={{ width:7, height:7, borderRadius:"50%", background:dot, flexShrink:0 }}/>
                            <span style={{ fontSize:T.fbase, fontWeight:T.wHeavy, color:T.ink, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{p.name}</span>
                            <div style={{ flex:1, minWidth:40, maxWidth:160, height:4, borderRadius:2, background:T.border, overflow:"hidden" }}>
                              <div style={{ height:"100%", width:`${pct*100}%`, background:rider.color, borderRadius:2 }}/>
                            </div>
                            <span style={{ fontSize:T.fsm, color:T.textLo, flexShrink:0, marginLeft:"auto" }}>
                              <strong style={{color: done>0?rider.color:T.textFaint}}>{done}</strong> of <strong style={{color:T.textMid}}>{eligible}</strong> eligible
                            </span>
                          </button>

                          {/* Drawer body (active coaster list) */}
                          {open && (() => {
                            const rows = sort.apply(liveCoasters(p)).filter(c => {
                              if (riderEligibleOnly && !isEligible(c, rider.height)) return false;
                              if (riderRiddenOnly   && !ridden[rider.id]?.has(ck(p.id, c.name))) return false;
                              return true;
                            });
                            const dfRaw  = defunctCoasters(p);
                            const dfRows = riderRiddenOnly ? dfRaw.filter(c => ridden[rider.id]?.has(ck(p.id, c.name))) : dfRaw;
                            const dfDone = dfRaw.filter(c => ridden[rider.id]?.has(ck(p.id, c.name))).length;
                            return (
                              <>
                                {rows.length === 0 && (
                                  <div style={{ fontSize:T.fsm, color:T.textGhost, fontStyle:"italic", padding:"8px 14px" }}>No coasters match the active filters.</div>
                                )}
                                {rows.length > 0 && (
                                  <div style={{ display:"grid", gridTemplateColumns:"2fr 1fr 56px 56px 56px", padding:"4px 14px", gap:T.s2, ...labelCss, borderBottom:`1px solid ${T.hair}` }}>
                                    <div>Coaster</div><div>Type</div>
                                    <div style={{textAlign:"center"}}>Min</div>
                                    <div style={{textAlign:"center"}} title="Minimum height with a supervising adult">w/ adult</div>
                                    <div style={{textAlign:"center"}}>Ridden</div>
                                  </div>
                                )}
                                {rows.map((c, i, arr) => {
                                  const key    = ck(p.id, c.name);
                                  const isDone = ridden[rider.id]?.has(key);
                                  return (
                                    <div key={c.name} style={{ display:"grid", gridTemplateColumns:"2fr 1fr 56px 56px 56px", padding:"7px 14px", borderBottom:i<arr.length-1?`1px solid ${T.hair}`:"none", background:isDone?`${rider.color}0a`:(i%2===0?"transparent":T.zebra), alignItems:"center", gap:T.s2 }}>
                                      <div style={{ display:"flex", alignItems:"center", gap:5, minWidth:0 }}>
                                        {c.racing && <span style={{ fontSize:T.fxs, background:"#6366f122", color:"#818cf8", border:"1px solid #6366f133", borderRadius:T.r1, padding:"1px 4px" }}>⇄</span>}
                                        <span onClick={()=>onOpenCoaster(p.id, c)} title="View coaster details" onMouseEnter={e=>e.currentTarget.style.textDecoration="underline"} onMouseLeave={e=>e.currentTarget.style.textDecoration="none"} style={{ fontSize:T.fbase, fontWeight: isDone?T.wBold:T.wSemi, color: isDone ? T.ink : T.textMid, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", cursor:"pointer" }}>{c.name}</span>
                                      </div>
                                      <div style={{ fontSize:T.fsm, color:T.textFaint, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{coasterType(c)}</div>
                                      <div style={{textAlign:"center"}}><HtBadge min={c.min}/></div>
                                      <div style={{textAlign:"center"}}><AccBadge value={c.minAccompanied}/></div>
                                      <div style={{textAlign:"center"}}>
                                        <CreditBtn done={isDone} color={rider.color} onClick={()=>onToggle(rider.id,key)} title={`${isDone?"Unmark":"Mark"} ${c.name} as ridden`}/>
                                      </div>
                                    </div>
                                  );
                                })}

                                {/* Defunct sub-table — historical credits, outside the headline count */}
                                {dfRows.length > 0 && (
                                  <div style={{ borderTop:`1px solid ${T.hair}`, background:"#05080f" }}>
                                    <div style={{ ...labelCss, display:"flex", alignItems:"center", gap:T.s2, padding:"6px 14px", letterSpacing:"0.08em" }}>
                                      Defunct · historical
                                      {dfDone > 0 && <span style={{ color:T.textLo, fontWeight:400, textTransform:"none", letterSpacing:0 }}>+{dfDone} ridden</span>}
                                    </div>
                                    {dfRows.map((c, i, arr) => {
                                      const key    = ck(p.id, c.name);
                                      const isDone = ridden[rider.id]?.has(key);
                                      return (
                                        <div key={c.name} style={{ display:"grid", gridTemplateColumns:"2fr 1fr 56px 56px 56px", padding:"6px 14px", borderTop:"1px solid #0a0f1a", background:isDone?"#0a1410":"transparent", alignItems:"center", gap:T.s2, opacity:0.8 }}>
                                          <div style={{ display:"flex", alignItems:"center", gap:5 }}>
                                            <span style={{ fontSize:T.fbase, fontWeight: isDone?T.wBold:T.wMed, color:T.textLo }}>{c.name}</span>
                                          </div>
                                          <div style={{ fontSize:T.fsm, color:T.textGhost }}>{coasterType(c)}</div>
                                          <div style={{textAlign:"center"}}><HtBadge min={c.min}/></div>
                                          <div style={{textAlign:"center"}}><AccBadge value={c.minAccompanied}/></div>
                                          <div style={{textAlign:"center"}}>
                                            <CreditBtn done={isDone} color={T.textLo} onClick={()=>onToggle(rider.id,key)} title={`${isDone?"Unmark":"Mark"} ${c.name} (defunct) as ridden`}/>
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </>
          );
        })()}
      </div>
    );
  })();

  return (
    <div className="ct-split">
      {pivot === "rider" ? riderNav : parkNav}
      <div style={{ flex:1, display:"flex", flexDirection:"column", minHeight:0 }}>
        {pivotBar}
        {pivot === "rider" ? riderBody : allRidersBody}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MANAGE RIDERS
// ═══════════════════════════════════════════════════════════════════════════
function ManageRiders({ riders, onAdd, onUpdate, onDelete }) {
  const blankForm = { name:"", height:"", color: COLOR_PALETTE[0], needsCompanion:false };
  const [form,    setForm]    = useState(blankForm);
  const [editId,  setEditId]  = useState(null);
  const [error,   setError]   = useState("");
  const nameRef = useRef(null);

  function validate(f) {
    if (!f.name.trim()) return "Name is required.";
    const h = Number(f.height);
    if (!f.height || isNaN(h) || h < 20 || h > 96) return "Height must be 20–96 inches.";
    return "";
  }

  function handleSubmit(e) {
    e.preventDefault();
    const err = validate(form);
    if (err) { setError(err); return; }
    if (editId) {
      onUpdate({ id:editId, name:form.name.trim(), height:Number(form.height), color:form.color, needsCompanion:form.needsCompanion });
      setEditId(null);
    } else {
      onAdd({ id:uid(), name:form.name.trim(), height:Number(form.height), color:form.color, needsCompanion:form.needsCompanion });
    }
    setForm(blankForm);
    setError("");
    nameRef.current?.focus();
  }

  function startEdit(r) {
    setEditId(r.id);
    setForm({ name:r.name, height:String(r.height), color:r.color, needsCompanion:!!r.needsCompanion });
    setError("");
    nameRef.current?.focus();
  }

  function cancelEdit() {
    setEditId(null);
    setForm(blankForm);
    setError("");
  }

  const usedColors = new Set(riders.filter(r => r.id !== editId).map(r => r.color));

  return (
    <div style={{ flex:1, overflowY:"auto", padding:"24px 28px", maxWidth:640 }}>
      <div style={{ fontSize:T.flg, fontWeight:T.wHeavy, color:T.ink, marginBottom:T.s1 }}>Manage Riders</div>
      <div style={{ fontSize:T.fbase, color:T.textFaint, marginBottom:T.s7 }}>Add, edit, or remove riders. Credits and height data are stored per rider ID.</div>

      {/* Rider list */}
      <div style={{ display:"flex", flexDirection:"column", gap:T.s3, marginBottom:T.s8 }}>
        {riders.length === 0 && (
          <div style={{ fontSize:T.fbase, color:T.textGhost, fontStyle:"italic" }}>No riders yet. Add one below.</div>
        )}
        {riders.map(r => (
          <div key={r.id} style={{ display:"flex", alignItems:"center", gap:T.s5, background:T.panel2, border:`1px solid ${T.border}`, borderRadius:T.r4, padding:"10px 14px" }}>
            <ColorDot color={r.color} size={12}/>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:T.fmd, fontWeight:T.wBold, color:T.text, display:"flex", alignItems:"center", gap:T.s2 }}>
                {r.name}
                {r.needsCompanion && <span title="Needs a supervising adult to ride accompanied-only (✓*) coasters" style={{ fontSize:T.fxs, fontWeight:T.wBold, color:ACC_AMBER, background:ACC_AMBER+"1f", border:`1px solid ${ACC_AMBER}3a`, borderRadius:T.r1, padding:"1px 5px" }}>needs adult</span>}
              </div>
              <div style={{ fontSize:T.fsm, color:T.textFaint }}>{r.height}" tall</div>
            </div>
            <button onClick={() => startEdit(r)} style={{ background:T.border, border:`1px solid ${T.border2}`, color:T.textMid, borderRadius:T.r2, padding:"4px 10px", cursor:"pointer", fontSize:T.fsm, fontFamily:"inherit" }}>Edit</button>
            <button onClick={() => { if (window.confirm(`Remove ${r.name}? Their credits will be kept if they are re-added with the same ID.`)) onDelete(r.id); }} style={{ background:"#1e0a0a", border:"1px solid #7f1d1d", color:"#f87171", borderRadius:T.r2, padding:"4px 10px", cursor:"pointer", fontSize:T.fsm, fontFamily:"inherit" }}>Remove</button>
          </div>
        ))}
      </div>

      {/* Add / edit form */}
      <div style={{ background:T.panel, border:`1px solid ${T.border}`, borderRadius:T.r5, padding:"18px 20px" }}>
        <div style={{ ...labelCss, fontSize:T.fbase, color:T.textLo, letterSpacing:"0.08em", marginBottom:T.s6 }}>
          {editId ? `Editing ${riders.find(r=>r.id===editId)?.name}` : "Add New Rider"}
        </div>
        <form onSubmit={handleSubmit} style={{ display:"flex", flexDirection:"column", gap:T.s6 }}>
          <div style={{ display:"flex", gap:T.s5, flexWrap:"wrap" }}>
            <label style={{ display:"flex", flexDirection:"column", gap:T.s1, flex:1, minWidth:140 }}>
              <span style={fieldLabelCss}>Name</span>
              <input
                ref={nameRef}
                value={form.name}
                onChange={e => setForm(f => ({...f, name:e.target.value}))}
                placeholder="e.g. Alex"
                style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r3, padding:"7px 10px", color:T.ink, fontSize:T.fmd, fontFamily:"inherit", outline:"none" }}
              />
            </label>
            <label style={{ display:"flex", flexDirection:"column", gap:T.s1, width:110 }}>
              <span style={fieldLabelCss}>Height (inches)</span>
              <input
                type="number"
                min={20} max={96}
                value={form.height}
                onChange={e => setForm(f => ({...f, height:e.target.value}))}
                placeholder="e.g. 48"
                style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r3, padding:"7px 10px", color:T.ink, fontSize:T.fmd, fontFamily:"inherit", outline:"none" }}
              />
            </label>
          </div>

          {/* Color picker */}
          <div>
            <div style={{ ...fieldLabelCss, marginBottom:T.s3 }}>Color</div>
            <div style={{ display:"flex", gap:T.s3, flexWrap:"wrap" }}>
              {COLOR_PALETTE.map(c => {
                const inUse    = usedColors.has(c);
                const selected = form.color === c;
                return (
                  <button
                    key={c} type="button"
                    onClick={() => !inUse && setForm(f => ({...f, color:c}))}
                    title={inUse ? "Already in use" : c}
                    style={{
                      width:28, height:28, borderRadius:"50%", border: selected ? `3px solid ${T.ink}` : "3px solid transparent",
                      background:c, cursor:inUse?"not-allowed":"pointer", opacity:inUse?0.3:1,
                      outline:"none", transition:"opacity 0.15s",
                    }}
                  />
                );
              })}
            </div>
          </div>

          {/* Needs-companion flag — informational only (✓* rides still count as
              eligible); surfaces a reminder where this rider's progress is shown. */}
          <label style={{ display:"flex", alignItems:"flex-start", gap:T.s2, cursor:"pointer" }}>
            <input type="checkbox" checked={form.needsCompanion} onChange={e=>setForm(f=>({...f, needsCompanion:e.target.checked}))} style={{ accentColor:ACC_AMBER, width:14, height:14, marginTop:2 }}/>
            <span style={{ fontSize:T.fsm, color:T.textMid }}>
              Needs a supervising adult for <strong style={{color:ACC_AMBER}}>✓*</strong> rides
              <span style={{ color:T.textFaint }}> — shows a reminder on their pages (doesn't change counts)</span>
            </span>
          </label>

          {error && <div style={{ fontSize:T.fsm, color:"#f87171" }}>{error}</div>}

          <div style={{ display:"flex", gap:T.s3 }}>
            <button type="submit" style={{ background: editId ? "#1e3a1e" : "#0f2a3f", border:`1px solid ${editId?"#4ade8044":"#38bdf844"}`, color: editId?"#4ade80":T.accent, borderRadius:T.r3, padding:"8px 18px", cursor:"pointer", fontSize:T.fmd, fontWeight:T.wBold, fontFamily:"inherit" }}>
              {editId ? "Save Changes" : "Add Rider"}
            </button>
            {editId && (
              <button type="button" onClick={cancelEdit} style={{ background:"transparent", border:`1px solid ${T.border2}`, color:T.textLo, borderRadius:T.r3, padding:"8px 14px", cursor:"pointer", fontSize:T.fmd, fontFamily:"inherit" }}>Cancel</button>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MANAGE REGIONS — edit the region list (stored in data/settings.json)
// ═══════════════════════════════════════════════════════════════════════════
function ManageRegions({ regions, parks, onUpdate }) {
  const entries = Object.entries(regions); // [ [code, name], ... ] — order is preserved
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [error,   setError]   = useState("");

  // Count parks per region code so we can guard deletes
  const usage = {};
  for (const p of parks) usage[p.region] = (usage[p.region] || 0) + 1;

  // Rebuild the regions object from an ordered entries array
  const fromEntries = es => Object.fromEntries(es);

  function rename(code, name) {
    if (regions[code] === name || !name.trim()) return; // no-op / don't blank a name
    onUpdate(fromEntries(entries.map(([c, n]) => [c, c === code ? name.trim() : n])));
  }

  function move(idx, dir) {
    const next = [...entries];
    const j = idx + dir;
    if (j < 0 || j >= next.length) return;
    [next[idx], next[j]] = [next[j], next[idx]];
    onUpdate(fromEntries(next));
  }

  function remove(code) {
    if (usage[code]) {
      setError(`Can't delete "${regions[code]}" — ${usage[code]} park${usage[code] !== 1 ? "s" : ""} still use it. Reassign those parks first.`);
      return;
    }
    if (!window.confirm(`Delete region "${regions[code]}"?`)) return;
    onUpdate(fromEntries(entries.filter(([c]) => c !== code)));
    setError("");
  }

  function add(e) {
    e.preventDefault();
    const code = newCode.trim().toUpperCase();
    const name = newName.trim();
    if (!code)               { setError("Region code is required (e.g. PNW)."); return; }
    if (!/^[A-Z0-9]{2,5}$/.test(code)) { setError("Code must be 2–5 letters/numbers."); return; }
    if (regions[code])       { setError(`Code "${code}" already exists.`); return; }
    if (!name)               { setError("Display name is required."); return; }
    onUpdate(fromEntries([...entries, [code, name]]));
    setNewCode(""); setNewName(""); setError("");
  }

  const inputStyle = { background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r3, padding:"7px 10px", color:T.ink, fontSize:T.fmd, fontFamily:"inherit", outline:"none" };

  return (
    <div style={{ flex:1, overflowY:"auto", padding:"24px 28px", maxWidth:640 }}>
      <div style={{ fontSize:T.flg, fontWeight:T.wHeavy, color:T.ink, marginBottom:T.s1 }}>Manage Regions</div>
      <div style={{ fontSize:T.fbase, color:T.textFaint, marginBottom:T.s7 }}>
        Regions group parks in lists and the region filter. Stored in <code style={{color:T.textLo}}>settings.json</code>.
      </div>

      {/* Existing regions */}
      <div style={{ display:"flex", flexDirection:"column", gap:T.s3, marginBottom:T.s8 }}>
        {entries.length === 0 && <div style={{ fontSize:T.fbase, color:T.textGhost, fontStyle:"italic" }}>No regions yet. Add one below.</div>}
        {entries.map(([code, name], i) => (
          <div key={code} style={{ display:"flex", alignItems:"center", gap:T.s4, background:T.panel2, border:`1px solid ${T.border}`, borderRadius:T.r4, padding:"8px 12px" }}>
            {/* Reorder */}
            <div style={{ display:"flex", flexDirection:"column", gap:1 }}>
              <button onClick={() => move(i, -1)} disabled={i===0} style={{ background:"none", border:"none", color: i===0?T.border:T.textLo, cursor: i===0?"default":"pointer", fontSize:T.fxs, lineHeight:1, padding:0 }}>▲</button>
              <button onClick={() => move(i, +1)} disabled={i===entries.length-1} style={{ background:"none", border:"none", color: i===entries.length-1?T.border:T.textLo, cursor: i===entries.length-1?"default":"pointer", fontSize:T.fxs, lineHeight:1, padding:0 }}>▼</button>
            </div>
            {/* Code (immutable) */}
            <span style={{ fontSize:T.fxs, fontWeight:T.wBold, color:"#a78bfa", background:"#a78bfa18", border:"1px solid #a78bfa33", borderRadius:T.r1, padding:"2px 7px", fontFamily:"monospace", minWidth:42, textAlign:"center" }}>{code}</span>
            {/* Name (editable — commits on blur / Enter, not per keystroke) */}
            <input
              key={code + "|" + name}
              defaultValue={name}
              onBlur={e => rename(code, e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
              style={{ ...inputStyle, flex:1, padding:"5px 9px", fontSize:T.fmd }}
            />
            {/* Usage + delete */}
            <span style={{ fontSize:T.fxs, color:T.textFaint, whiteSpace:"nowrap" }}>{usage[code] || 0} park{(usage[code]||0)!==1?"s":""}</span>
            <button onClick={() => remove(code)} style={{ background:"#1e0a0a", border:"1px solid #7f1d1d", color:"#f87171", borderRadius:T.r2, padding:"4px 10px", cursor:"pointer", fontSize:T.fsm, fontFamily:"inherit" }}>Remove</button>
          </div>
        ))}
      </div>

      {/* Add form */}
      <div style={{ background:T.panel, border:`1px solid ${T.border}`, borderRadius:T.r5, padding:"18px 20px" }}>
        <div style={{ ...labelCss, fontSize:T.fbase, color:T.textLo, letterSpacing:"0.08em", marginBottom:T.s6 }}>Add Region</div>
        <form onSubmit={add} style={{ display:"flex", gap:T.s4, alignItems:"flex-end", flexWrap:"wrap" }}>
          <label style={{ display:"flex", flexDirection:"column", gap:T.s1, width:90 }}>
            <span style={fieldLabelCss}>Code</span>
            <input value={newCode} onChange={e => setNewCode(e.target.value)} placeholder="PNW" style={{ ...inputStyle, textTransform:"uppercase", fontFamily:"monospace" }}/>
          </label>
          <label style={{ display:"flex", flexDirection:"column", gap:T.s1, flex:1, minWidth:160 }}>
            <span style={fieldLabelCss}>Display Name</span>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Pacific Northwest" style={inputStyle}/>
          </label>
          <button type="submit" style={{ background:"#0f2a3f", border:`1px solid #38bdf844`, color:T.accent, borderRadius:T.r3, padding:"8px 18px", cursor:"pointer", fontSize:T.fmd, fontWeight:T.wBold, fontFamily:"inherit" }}>Add</button>
        </form>
        {error && <div style={{ fontSize:T.fsm, color:"#f87171", marginTop:T.s4 }}>{error}</div>}
      </div>
    </div>
  );
}

function EmptyRiders() {
  return (
    <div style={{ flex:1, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:T.s3 }}>
      <div style={{ fontSize:32 }}>🎢</div>
      <div style={{ fontSize:T.fmd, color:T.textFaint }}>No riders yet — add one in <strong style={{color:T.textMid}}>Riders</strong></div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MANAGE PARKS
// ═══════════════════════════════════════════════════════════════════════════
function LookupList({ coasters, parkUrl, lookupSel, setLookupSel, lookupMin, setLookupMin, onImport }) {
  const isOperating = s => !s || s === "Operating";
  const operatingIdxs = coasters.map((_,i)=>i).filter(i => isOperating(coasters[i].status));
  const allSelected   = lookupSel.size === coasters.length;

  return (
    <>
      {/* Toolbar */}
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:8, flexWrap:"wrap" }}>
        <div style={{ fontSize:T.fsm, color:T.textMid, fontWeight:T.wSemi }}>{lookupSel.size} of {coasters.length} selected</div>
        <button onClick={() => setLookupSel(allSelected ? new Set() : new Set(coasters.map((_,i)=>i)))}
          style={{ background:"transparent", border:`1px solid ${T.border2}`, color:T.textLo, borderRadius:T.r1, padding:"2px 8px", cursor:"pointer", fontSize:T.fxs, fontFamily:"inherit" }}>
          {allSelected ? "Deselect all" : "Select all"}
        </button>
        <button onClick={() => setLookupSel(new Set(operatingIdxs))}
          style={{ background:"#1e3a1e", border:"1px solid #4ade8044", color:"#4ade80", borderRadius:T.r1, padding:"2px 8px", cursor:"pointer", fontSize:T.fxs, fontFamily:"inherit" }}>
          Operating only
        </button>
        {parkUrl && (
          <a href={parkUrl} target="_blank" rel="noreferrer"
            style={{ marginLeft:"auto", fontSize:T.fxs, color:T.accent, textDecoration:"none" }}>
            View on RCDB ↗
          </a>
        )}
      </div>

      {/* Checklist */}
      <div style={{ maxHeight:280, overflowY:"auto", border:`1px solid ${T.border}`, borderRadius:T.r3, marginBottom:T.s5 }}>
        {coasters.map((c, i) => {
          const operating   = isOperating(c.status);
          const statusColor = operating ? "#4ade80" : c.status === "Upcoming" ? "#a78bfa" : "#f87171";
          return (
            <label key={i} style={{
              display:"flex", alignItems:"center", gap:10, padding:"7px 12px",
              borderBottom: i < coasters.length-1 ? `1px solid ${T.hair}` : "none",
              background: lookupSel.has(i) ? "#0f2a3f44" : (i%2===0 ? "transparent" : T.zebra),
              cursor:"pointer",
            }}>
              <input type="checkbox" checked={lookupSel.has(i)}
                onChange={() => setLookupSel(prev => {
                  const next = new Set(prev);
                  next.has(i) ? next.delete(i) : next.add(i);
                  return next;
                })}
                style={{ accentColor:"#38bdf8", width:14, height:14, flexShrink:0 }}
              />
              <span style={{ fontSize:T.fbase, fontWeight:T.wSemi, color: operating ? T.text : T.textLo, flex:1 }}>{c.name}</span>
              {coasterType(c) && <span style={{ fontSize:T.fxs, color:T.textFaint, maxWidth:200, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{coasterType(c)}</span>}
              {c.status && <span style={{ fontSize:T.fxs, fontWeight:T.wBold, color:statusColor, flexShrink:0 }}>{c.status}</span>}
            </label>
          );
        })}
      </div>

      {/* Min height + import */}
      <div style={{ display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
        <label style={{ display:"flex", alignItems:"center", gap:T.s2, fontSize:T.fbase, color:T.textMid }}>
          Default min height:
          <input type="number" min={20} max={96} value={lookupMin} onChange={e => setLookupMin(e.target.value)}
            style={{ width:52, background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"4px 7px", color:T.ink, fontSize:T.fbase, fontFamily:"inherit", outline:"none", textAlign:"center" }}
          />
          <span style={{ fontSize:T.fsm, color:T.textFaint }}>" — edit per coaster after import</span>
        </label>
        <button onClick={onImport} disabled={lookupSel.size === 0} style={{
          marginLeft:"auto",
          background: lookupSel.size > 0 ? "#0f2a3f" : "transparent",
          border:`1px solid ${lookupSel.size > 0 ? "#38bdf844" : T.border2}`,
          color: lookupSel.size > 0 ? T.accent : T.textFaint,
          borderRadius:T.r3, padding:"7px 16px", cursor: lookupSel.size > 0 ? "pointer" : "default",
          fontSize:T.fbase, fontWeight:T.wBold, fontFamily:"inherit",
        }}>
          Import {lookupSel.size > 0 ? `${lookupSel.size} coaster${lookupSel.size!==1?"s":""}` : ""}
        </button>
      </div>
    </>
  );
}

function ManageParks({ parks, onAddPark, onUpdatePark, onDeletePark, onAddCoaster, onUpdateCoaster, onDeleteCoaster, onApplyHeights, onApplyScrapedAll, onApplySpeeds, onMergeImport }) {
  const blankPark    = { name:"", tag:"", region:"NE", badge:"", family:"" };
  const familySelect = (value, onChange) => (
    <select value={value||""} onChange={onChange} style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"6px 7px", color:T.ink, fontSize:T.fbase, fontFamily:"inherit", outline:"none" }}>
      <option value="">—</option>
      {Object.entries(PARK_FAMILIES).map(([code,info]) => <option key={code} value={code}>{code} — {info.label}</option>)}
    </select>
  );
  // The dense add/edit grid rows use one combined free-text "Type" field (split
  // into manufacturer/model via splitManufacturerModel on save) — there's no
  // room in an 8-column grid for two inputs. The coaster detail modal offers
  // separate Manufacturer/Model fields for anyone who wants precise control.
  const blankCoaster = { name:"", typeText:"", min:"", minAccompanied:"", speed:"", racing:false, defunct:false };

  const [selectedId,   setSelectedId]   = useState(parks[0]?.id || null);
  const [addingPark,   setAddingPark]   = useState(false);
  const [parkDraft,    setParkDraft]    = useState(null);
  const [newParkForm,  setNewParkForm]  = useState(blankPark);
  const [coasterForm,  setCoasterForm]  = useState(blankCoaster);
  const [editCoaster,  setEditCoaster]  = useState(null);
  const [parkError,    setParkError]    = useState("");
  const [coasterError, setCoasterError] = useState("");

  // Fill-heights processor state
  const [fillLoading,  setFillLoading]  = useState(false);
  const [fillResults,  setFillResults]  = useState(null);

  // Scrape-official-heights state (per selected park)
  const [scrapeLoading, setScrapeLoading] = useState(false);
  const [scrapeResult,  setScrapeResult]  = useState(null);   // {matched,unmatched...} or {error}

  // Batch scrape (all parks with an officialUrl) state
  const [scrapeAllRunning, setScrapeAllRunning] = useState(false);
  const [scrapeAll, setScrapeAll] = useState(null);   // { parks:[{parkId,parkName,changed,error?}], done, totalParks, finished, totalChanged }

  // Fill-speeds (RCDB) state
  const [speedsRunning, setSpeedsRunning] = useState(false);
  const [speedsResults, setSpeedsResults] = useState(null);   // { results, found, notFound, total }

  // Import delta preview (computed by mergeCoasters before applying)
  const [importPreview, setImportPreview] = useState(null);   // { added, updated, unchanged, coasters, parkName }

  // Lookup state
  const [lookupOpen,    setLookupOpen]    = useState(false);
  const [lookupQuery,   setLookupQuery]   = useState("");
  const [lookupLoading, setLookupLoading] = useState(false);
  const [lookupResults, setLookupResults] = useState(null);
  const [lookupSel,     setLookupSel]     = useState(new Set());
  const [lookupMin,     setLookupMin]     = useState("");

  const selectedPark = parks.find(p => p.id === selectedId) || null;

  // Sync draft + reset lookup when selection changes
  useEffect(() => {
    if (selectedPark) {
      setParkDraft({ name:selectedPark.name, tag:selectedPark.tag, region:selectedPark.region, badge:selectedPark.badge||"", family:selectedPark.family||"", officialUrl:selectedPark.officialUrl||"", lat:selectedPark.lat??"", lng:selectedPark.lng??"" });
      setLookupQuery(selectedPark.name);
    }
    setEditCoaster(null);
    setCoasterForm(blankCoaster);
    setCoasterError("");
    setLookupOpen(false);
    setLookupResults(null);
    setLookupSel(new Set());
  }, [selectedId]);

  async function handleLookup(overridePath) {
    if (typeof overridePath !== "string") overridePath = null; // guard against click events
    setLookupLoading(true);
    setLookupResults(null);
    setLookupSel(new Set());
    try {
      const url = overridePath
        ? `/api/lookup-coasters?path=${encodeURIComponent(overridePath)}`
        : `/api/lookup-coasters?q=${encodeURIComponent(lookupQuery)}`;
      const data = await apiGet(url);
      setLookupResults(data);
      if (data.coasters?.length) {
        // Auto-select only Operating coasters
        setLookupSel(new Set(
          data.coasters.map((c, i) => ({ c, i }))
            .filter(({ c }) => !c.status || c.status === "Operating")
            .map(({ i }) => i)
        ));

        // Stamp the selected park with external refs we just resolved (foreign keys — task #10).
        // Only fills blanks so manual edits aren't clobbered.
        if (selectedPark && data.parkUrl) {
          const { rcdbId, rcdbUrl } = rcdbRef(new URL(data.parkUrl).pathname);
          const patch = {};
          if (rcdbId && !selectedPark.rcdbId)   { patch.rcdbId = rcdbId; patch.rcdbUrl = rcdbUrl; }
          if (!selectedPark.sixFlagsSlug) {
            const slug = sixFlagsSlugGuess(selectedPark.name);
            patch.sixFlagsSlug = slug;
            if (!selectedPark.officialUrl) patch.officialUrl = sixFlagsAttractionsUrl(slug);
          }
          if (Object.keys(patch).length) onUpdatePark({ ...selectedPark, ...patch });
        }
      }
    } catch(e) {
      setLookupResults({ error: e.message, coasters: [] });
    } finally {
      setLookupLoading(false);
    }
  }

  // Build a delta preview from the selected lookup results vs. the park's existing
  // coasters — merges by name instead of blindly appending (no duplicates).
  function handleImport() {
    const rawMin = lookupMin.toString().trim();
    const min = rawMin === "" ? null : Math.max(20, Math.min(96, Number(rawMin) || null));
    const incoming = (lookupResults?.coasters || [])
      .filter((_, i) => lookupSel.has(i))
      .map(c => ({
        name:   c.name,
        type:   c.type || "Coaster", // not real manufacturer/model — see normalizeCoaster's splitManufacturerModel fallback
        min,
        racing: false,
        scale:  c.scale  || null,
        status: c.status || null,
        ...rcdbRef(c.rcdbPath),
      }));
    if (!incoming.length) return;
    const delta = mergeCoasters(selectedPark.coasters, incoming);
    setImportPreview({ ...delta, parkName: selectedPark.name });
    setLookupOpen(false);
    setLookupResults(null);
    setLookupSel(new Set());
  }

  function confirmImport() {
    if (importPreview) onMergeImport(selectedPark.id, importPreview.coasters);
    setImportPreview(null);
  }

  function handleFillHeights() {
    setFillLoading(true);
    setFillResults({ results: [], found: 0, notFound: 0, total: 0 });

    postSSE("/api/fill-heights", { parks }, msg => {
      if (msg.type === "start") {
        setFillResults({ results: [], found: 0, notFound: 0, total: msg.total });
      } else if (msg.type === "result") {
        setFillResults(prev => ({
          results:  [...(prev?.results || []), msg],
          found:    msg.found,
          notFound: msg.notFound,
          total:    msg.total,
        }));
      } else if (msg.type === "done") {
        setFillResults({ results: msg.results, found: msg.found, notFound: msg.notFound, total: msg.total });
        setFillLoading(false);
      } else if (msg.type === "error") {
        setFillResults(prev => ({ ...(prev || {}), error: msg.message }));
        setFillLoading(false);
      }
    });
  }

  function handleApplyHeights() {
    if (!fillResults?.results) return;
    const updates = fillResults.results.filter(r => r.height != null);
    onApplyHeights(updates);  // App handles the state mutation + save
    setFillResults(null);
  }

  async function handleScrapeHeights() {
    if (!selectedPark) return;
    setScrapeLoading(true);
    setScrapeResult(null);
    try {
      const resp = await fetchWithColdStartRetry(API_BASE + "/api/scrape-heights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ park: selectedPark }),
      }, (attempt, total) => setScrapeResult({ status: `Scraper service is waking up (retry ${attempt}/${total - 1})…` }));
      const data = await resp.json();
      if (!resp.ok) { setScrapeResult({ error: data.error || "Scrape failed." }); }
      else setScrapeResult(data);
    } catch (e) {
      setScrapeResult({ error: `Could not reach the scraper: ${e.message}` });
    } finally {
      setScrapeLoading(false);
    }
  }

  function handleApplyScrape() {
    const changed = (scrapeResult?.matched || []).filter(m => m.changed);
    if (!changed.length) { setScrapeResult(null); return; }
    // Apply each change to min + minAccompanied via an edit-through-add at the same index.
    changed.forEach(m => {
      const c = selectedPark.coasters[m.coasterIdx];
      if (!c) return;
      onDeleteCoaster(selectedPark.id, m.coasterIdx);
      onAddCoaster(selectedPark.id, { ...c, min: m.scraped.min, minAccompanied: m.scraped.minAccompanied }, m.coasterIdx);
    });
    setScrapeResult(null);
  }

  // ── Batch scrape: stream every officialUrl park, collect proposed changes ──
  function handleScrapeAll() {
    setScrapeAllRunning(true);
    setScrapeAll({ parks: [], done: 0, totalParks: 0, finished: false, totalChanged: 0 });
    postSSE("/api/scrape-all-heights", { parks }, msg => {
      if (msg.type === "start") {
        setScrapeAll(prev => ({ ...prev, totalParks: msg.totalParks }));
      } else if (msg.type === "park") {
        setScrapeAll(prev => ({
          ...prev,
          done: msg.done, totalParks: msg.totalParks,
          parks: [...prev.parks, { parkId: msg.parkId, parkName: msg.parkName, changed: msg.changed || [], unmatchedExisting: msg.unmatchedExisting || [], error: msg.error || null }],
        }));
      } else if (msg.type === "done") {
        setScrapeAll(prev => ({ ...prev, finished: true, totalChanged: msg.totalChanged, parksScraped: msg.parksScraped, parksFailed: msg.parksFailed }));
        setScrapeAllRunning(false);
      } else if (msg.type === "error") {
        setScrapeAll(prev => ({ ...(prev || {}), error: msg.message, finished: true }));
        setScrapeAllRunning(false);
      }
    });
  }

  function handleApplyScrapeAll() {
    if (!scrapeAll?.parks) return;
    // Flatten every changed coaster into name-keyed updates (indexes are per-park-fragile).
    const updates = [];
    for (const p of scrapeAll.parks) {
      for (const m of (p.changed || [])) {
        updates.push({ parkId: p.parkId, coasterName: m.name, min: m.scraped.min, minAccompanied: m.scraped.minAccompanied });
      }
    }
    if (updates.length) onApplyScrapedAll(updates);
    setScrapeAll(null);
  }

  // ── Fill speeds from RCDB (streamed, all operating coasters without a speed) ──
  function handleFillSpeeds() {
    setSpeedsRunning(true);
    setSpeedsResults({ results: [], found: 0, notFound: 0, total: 0 });
    postSSE("/api/fill-speeds", { parks }, msg => {
      if (msg.type === "start") {
        setSpeedsResults({ results: [], found: 0, notFound: 0, total: msg.total });
      } else if (msg.type === "result") {
        setSpeedsResults(prev => ({ results: [...(prev?.results || []), msg], found: msg.found, notFound: msg.notFound, total: msg.total }));
      } else if (msg.type === "done") {
        setSpeedsResults({ results: msg.results, found: msg.found, notFound: msg.notFound, total: msg.total, finished: true });
        setSpeedsRunning(false);
      } else if (msg.type === "error") {
        setSpeedsResults(prev => ({ ...(prev || {}), error: msg.message, finished: true }));
        setSpeedsRunning(false);
      }
    });
  }

  function handleApplySpeeds() {
    const updates = (speedsResults?.results || []).filter(r =>
      r.speedMph != null || r.heightFt != null || r.yearOpened != null || r.manufacturer || r.model || r.material || r.style
    );
    if (updates.length) onApplySpeeds(updates);
    setSpeedsResults(null);
  }

  function selectPark(id) { setSelectedId(id); setAddingPark(false); setParkError(""); }

  // ── Park add/save ──
  function handleAddPark(e) {
    e.preventDefault();
    if (!newParkForm.name.trim()) { setParkError("Name is required."); return; }
    if (!newParkForm.tag.trim())  { setParkError("Airport is required."); return; }
    const park = { id: uid(), name: newParkForm.name.trim(), tag: newParkForm.tag.trim().toUpperCase(), region: newParkForm.region, badge: newParkForm.badge.trim(), family: newParkForm.family || undefined, coasters: [] };
    onAddPark(park);
    setSelectedId(park.id);
    setAddingPark(false);
    setNewParkForm(blankPark);
    setParkError("");
  }

  function handleSavePark(e) {
    e.preventDefault();
    if (!parkDraft.name.trim()) { setParkError("Name is required."); return; }
    if (!parkDraft.tag.trim())  { setParkError("Airport is required."); return; }
    const lat = parkDraft.lat === "" ? null : Number(parkDraft.lat);
    const lng = parkDraft.lng === "" ? null : Number(parkDraft.lng);
    onUpdatePark({ ...selectedPark, name:parkDraft.name.trim(), tag:parkDraft.tag.trim().toUpperCase(), region:parkDraft.region, badge:parkDraft.badge.trim(), family:parkDraft.family || undefined, officialUrl:parkDraft.officialUrl.trim() || null, lat: Number.isFinite(lat)?lat:null, lng: Number.isFinite(lng)?lng:null });
    setParkError("");
  }

  // ── Coaster add ──
  function handleAddCoaster(e) {
    e.preventDefault();
    if (!coasterForm.name.trim()) { setCoasterError("Name is required."); return; }
    const v = validateHeights(coasterForm.min, coasterForm.minAccompanied);
    if (v.err) { setCoasterError(v.err); return; }
    const { manufacturer, model } = splitManufacturerModel(coasterForm.typeText);
    onAddCoaster(selectedPark.id, { name:coasterForm.name, manufacturer, model, min:v.h, minAccompanied:coasterForm.minAccompanied, speedMph:coasterForm.speed, racing:coasterForm.racing, defunct:coasterForm.defunct });
    setCoasterForm(blankCoaster);
    setCoasterError("");
  }

  // ── Coaster edit save ──
  function handleSaveCoaster(e) {
    e.preventDefault();
    if (!editCoaster.draft.name.trim()) return;
    const d = editCoaster.draft;
    const v = validateHeights(d.min, d.minAccompanied);
    if (v.err) { setEditCoaster(ec => ({ ...ec, err:v.err })); return; }
    // In-place update (migrates credits if the name changes) — no delete+re-add.
    const { manufacturer, model } = splitManufacturerModel(d.typeText);
    onUpdateCoaster(selectedPark.id, editCoaster.idx, { name:d.name, manufacturer, model, min:v.h, minAccompanied:d.minAccompanied, speedMph:d.speed, racing:d.racing, defunct:d.defunct });
    setEditCoaster(null);
  }

  const inp = (val, onChange, placeholder, style={}) => (
    <input value={val} onChange={onChange} placeholder={placeholder} style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"5px 8px", color:T.ink, fontSize:T.fbase, fontFamily:"inherit", outline:"none", ...style }}/>
  );

  const regionSelect = (val, onChange) => (
    <select value={val} onChange={onChange} style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"5px 8px", color:T.ink, fontSize:T.fbase, fontFamily:"inherit", outline:"none" }}>
      {Object.entries(REGIONS).map(([k,v]) => <option key={k} value={k}>{v}</option>)}
    </select>
  );

  return (
    <div className="ct-split">

      {/* ── Left: park list ── */}
      <div className="ct-sidenav" style={{ width:260, flexShrink:0, borderRight:`1px solid ${T.border}`, overflowY:"auto", padding:T.s6, display:"flex", flexDirection:"column", gap:T.s2 }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:T.s2 }}>
          <div style={{ ...labelCss, fontSize:T.fsm, color:T.textFaint, letterSpacing:"0.08em" }}>Parks</div>
          <button onClick={() => { setAddingPark(true); setSelectedId(null); setParkError(""); }}
            style={{ fontSize:T.fsm, background:"#0f2a3f", border:"1px solid #38bdf844", color:T.accent, borderRadius:T.r2, padding:"3px 10px", cursor:"pointer", fontFamily:"inherit", fontWeight:T.wBold }}>+ Add</button>
        </div>

        {/* Fill-heights processor */}
        {(() => {
          const nullCount = parks.reduce((s, p) => s + p.coasters.filter(c => c.min == null).length, 0);
          if (nullCount === 0 && !fillResults) return null;
          return (
            <div style={{ background:T.panel, border:`1px solid ${T.border}`, borderRadius:T.r3, padding:"10px 12px", marginBottom:T.s1 }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:T.s2 }}>
                <div style={{ fontSize:T.fxs, fontWeight:T.wBold, color:"#facc15" }}>
                  {nullCount > 0 ? `⚠ ${nullCount} unknown height${nullCount!==1?"s":""}` : "✓ Heights filled"}
                </div>
                {nullCount > 0 && (
                  <button onClick={handleFillHeights} disabled={fillLoading} style={{
                    fontSize:T.fxs, fontWeight:T.wBold, padding:"2px 8px", borderRadius:T.r1,
                    background: fillLoading ? "transparent" : "#1e3a1e",
                    border:`1px solid ${fillLoading ? T.border2 : "#4ade8044"}`,
                    color: fillLoading ? T.textFaint : "#4ade80",
                    cursor: fillLoading ? "default" : "pointer", fontFamily:"inherit",
                  }}>{fillLoading ? "Looking up…" : "Auto-fill"}</button>
                )}
              </div>

              {fillResults && !fillResults.error && fillResults.results?.length > 0 && (
                <>
                  <div style={{ fontSize:T.fxs, color:T.textLo, marginBottom:T.s2 }}>
                    Found <span style={{color:"#4ade80", fontWeight:T.wBold}}>{fillResults.found}</span> of {fillResults.total} via Wikipedia
                    {fillResults.notFound > 0 && <span style={{color:"#f87171"}}> · {fillResults.notFound} not found</span>}
                  </div>
                  <div style={{ maxHeight:140, overflowY:"auto", marginBottom:T.s3 }}>
                    {fillResults.results.map((r, i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"3px 0", borderBottom:`1px solid ${T.hair}`, fontSize:T.fxs }}>
                        <span style={{ color: r.height ? T.text : T.textFaint, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.coasterName}</span>
                        {r.height
                          ? <span style={{ color:"#4ade80", fontWeight:T.wBold, flexShrink:0, marginLeft:T.s2 }}>{r.height}"</span>
                          : <span style={{ color:T.textFaint, flexShrink:0, marginLeft:T.s2 }}>—</span>
                        }
                      </div>
                    ))}
                  </div>
                  {fillResults.found > 0 && (
                    <button onClick={handleApplyHeights} style={{
                      width:"100%", background:"#0f2a3f", border:"1px solid #38bdf844",
                      color:T.accent, borderRadius:T.r2, padding:"5px 0", cursor:"pointer",
                      fontSize:T.fsm, fontWeight:T.wBold, fontFamily:"inherit",
                    }}>Apply {fillResults.found} update{fillResults.found!==1?"s":""}</button>
                  )}
                </>
              )}
              {fillResults?.error && <div style={{ fontSize:T.fxs, color:"#f87171" }}>⚠ {fillResults.error}</div>}
              {fillResults?.message && <div style={{ fontSize:T.fxs, color:T.textLo }}>{fillResults.message}</div>}
            </div>
          );
        })()}
        {Object.entries(REGIONS).map(([rKey, rName]) => {
          const rParks = parks.filter(p => p.region === rKey);
          if (!rParks.length) return null;
          return (
            <div key={rKey} style={{ marginBottom:T.s3 }}>
              <div style={{ ...labelCss, color:T.textGhost, letterSpacing:"0.08em", marginBottom:T.s1 }}>{rName}</div>
              {rParks.map(p => (
                <button key={p.id} onClick={() => selectPark(p.id)} style={{
                  display:"flex", alignItems:"center", justifyContent:"space-between", width:"100%",
                  padding:"7px 10px", borderRadius:T.r3, border:"none", cursor:"pointer", textAlign:"left",
                  background: selectedId===p.id ? T.border : "transparent",
                  fontFamily:"inherit",
                }}>
                  <div>
                    <div style={{ fontSize:T.fbase, fontWeight: selectedId===p.id ? T.wBold : T.wMed, color: selectedId===p.id ? T.ink : T.textMid }}>{p.name}</div>
                    <div style={{ fontSize:T.fxs, color:T.textFaint }}>{p.tag} · {p.coasters.length} coasters</div>
                  </div>
                  {selectedId===p.id && <span style={{ fontSize:T.fxs, color:T.accent }}>›</span>}
                </button>
              ))}
            </div>
          );
        })}
      </div>

      {/* ── Right: detail ── */}
      <div style={{ flex:1, overflowY:"auto", padding:"18px 24px 32px" }}>

        {/* Batch scrape — all parks with an official height-chart URL */}
        {(() => {
          const targets = parks.filter(p => p.officialUrl).length;
          return (
            <div style={{ background:T.panel, border:`1px solid ${T.border}`, borderRadius:T.r5, padding:"14px 18px", maxWidth:720, marginBottom:20 }}>
              <div style={{ display:"flex", alignItems:"center", gap:T.s4, flexWrap:"wrap" }}>
                <div style={{ flex:1, minWidth:200 }}>
                  <div style={{ fontSize:T.fmd, fontWeight:T.wBold, color:T.ink }}>📏 Scrape all official heights</div>
                  <div style={{ fontSize:T.fsm, color:T.textLo, marginTop:2 }}>
                    Fetch authoritative alone/accompanied heights for all <strong style={{color:T.textMid}}>{targets}</strong> park{targets!==1?"s":""} with an official URL, then review &amp; apply together.
                  </div>
                </div>
                <button onClick={handleScrapeAll} disabled={scrapeAllRunning || targets===0}
                  style={{ background: scrapeAllRunning||targets===0 ? "transparent" : "#0f2a3f", border:`1px solid ${scrapeAllRunning||targets===0 ? T.border2 : "#38bdf844"}`, color: scrapeAllRunning||targets===0 ? T.textFaint : T.accent, borderRadius:T.r3, padding:"8px 16px", cursor: scrapeAllRunning||targets===0 ? "default" : "pointer", fontSize:T.fbase, fontWeight:T.wBold, fontFamily:"inherit", whiteSpace:"nowrap" }}>
                  {scrapeAllRunning ? `Scraping ${scrapeAll?.done||0}/${scrapeAll?.totalParks||"…"}…` : "Scrape all parks"}
                </button>
              </div>

              {scrapeAll && (() => {
                const withChanges = scrapeAll.parks.filter(p => (p.changed||[]).length > 0);
                const failed = scrapeAll.parks.filter(p => p.error);
                const totalUpdates = withChanges.reduce((s,p)=>s+p.changed.length, 0);
                return (
                  <div style={{ marginTop:T.s4, borderTop:`1px solid ${T.border}`, paddingTop:T.s4 }}>
                    {scrapeAll.error && <div style={{ fontSize:T.fsm, color:"#f87171", marginBottom:T.s2 }}>⚠ {scrapeAll.error}</div>}
                    <div style={{ fontSize:T.fsm, color:T.textLo, marginBottom:T.s3 }}>
                      {scrapeAll.finished ? "Done" : "Scraping"} · <strong style={{color:T.textMid}}>{scrapeAll.parks.length}</strong>/{scrapeAll.totalParks} parks
                      {totalUpdates > 0 && <> · <strong style={{color:"#facc15"}}>{totalUpdates}</strong> change{totalUpdates!==1?"s":""} across {withChanges.length} park{withChanges.length!==1?"s":""}</>}
                      {failed.length > 0 && <span style={{color:"#f87171"}}> · {failed.length} failed</span>}
                    </div>

                    <div style={{ maxHeight:300, overflowY:"auto", marginBottom:T.s3 }}>
                      {withChanges.map(p => (
                        <div key={p.parkId} style={{ marginBottom:T.s3 }}>
                          <div style={{ fontSize:T.fsm, fontWeight:T.wBold, color:T.text, marginBottom:T.s1 }}>{p.parkName} <span style={{ color:T.textFaint, fontWeight:400 }}>· {p.changed.length}</span></div>
                          {p.changed.map((m,i) => {
                            const fmt = v => v==null ? "—" : `${v}"`;
                            return (
                              <div key={i} style={{ display:"flex", justifyContent:"space-between", gap:T.s3, padding:"2px 0 2px 12px", fontSize:T.fxs }}>
                                <span style={{ color:T.textMid, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                                  {m.name}{m.fuzzy && <span title={`Approx. name match to official "${m.scrapedName}" — verify`} style={{ color:ACC_AMBER, marginLeft:4 }}>≈ {m.scrapedName}</span>}
                                </span>
                                <span style={{ flexShrink:0, color:T.textFaint }}>
                                  {fmt(m.current.min)}{m.current.minAccompanied!=null?` (acc ${m.current.minAccompanied}")`:""} → <span style={{color:"#4ade80", fontWeight:T.wBold}}>{fmt(m.scraped.min)}{m.scraped.minAccompanied!=null?` (acc ${m.scraped.minAccompanied}")`:""}</span>
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      ))}
                      {failed.map(p => (
                        <div key={p.parkId} style={{ fontSize:T.fxs, color:"#f8717199", padding:"2px 0" }}>{p.parkName}: {p.error}</div>
                      ))}
                      {scrapeAll.finished && totalUpdates === 0 && !scrapeAll.error && (
                        <div style={{ fontSize:T.fsm, color:"#4ade80" }}>✓ All scraped heights already match.</div>
                      )}
                    </div>

                    {scrapeAll.finished && (
                      <div style={{ display:"flex", gap:T.s2 }}>
                        {totalUpdates > 0 && (
                          <button onClick={handleApplyScrapeAll} style={{ background:"#0f2a3f", border:"1px solid #38bdf844", color:T.accent, borderRadius:T.r2, padding:"6px 16px", cursor:"pointer", fontSize:T.fsm, fontWeight:T.wBold, fontFamily:"inherit" }}>Apply {totalUpdates} update{totalUpdates!==1?"s":""}</button>
                        )}
                        <button onClick={()=>setScrapeAll(null)} style={{ background:"transparent", border:`1px solid ${T.border2}`, color:T.textLo, borderRadius:T.r2, padding:"6px 12px", cursor:"pointer", fontSize:T.fsm, fontFamily:"inherit" }}>Dismiss</button>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>
          );
        })()}

        {/* Fill speed/height/year/manufacturer/model/material/style from RCDB */}
        {(() => {
          const incomplete = parks.reduce((s, p) => s + p.coasters.filter(c =>
            !c.defunct && (c.speedMph == null || c.heightFt == null || c.yearOpened == null || !c.manufacturer)
          ).length, 0);
          if (incomplete === 0 && !speedsResults) return null;
          const found = speedsResults?.results?.filter(r =>
            r.speedMph != null || r.heightFt != null || r.yearOpened != null || r.manufacturer || r.model || r.material || r.style
          ) || [];
          return (
            <div style={{ background:T.panel, border:`1px solid ${T.border}`, borderRadius:T.r5, padding:"14px 18px", maxWidth:720, marginBottom:20 }}>
              <div style={{ display:"flex", alignItems:"center", gap:T.s4, flexWrap:"wrap" }}>
                <div style={{ flex:1, minWidth:200 }}>
                  <div style={{ fontSize:T.fmd, fontWeight:T.wBold, color:T.ink }}>⚡ Fill stats from RCDB</div>
                  <div style={{ fontSize:T.fsm, color:T.textLo, marginTop:2 }}>
                    Look up speed, height, opening year, manufacturer, model, material & style on rcdb.com for the <strong style={{color:T.textMid}}>{incomplete}</strong> operating coaster{incomplete!==1?"s":""} missing any of these. ~1s each — this runs a while.
                  </div>
                </div>
                <button onClick={handleFillSpeeds} disabled={speedsRunning || incomplete===0}
                  style={{ background: speedsRunning||incomplete===0 ? "transparent" : "#0f2a3f", border:`1px solid ${speedsRunning||incomplete===0 ? T.border2 : "#38bdf844"}`, color: speedsRunning||incomplete===0 ? T.textFaint : T.accent, borderRadius:T.r3, padding:"8px 16px", cursor: speedsRunning||incomplete===0 ? "default" : "pointer", fontSize:T.fbase, fontWeight:T.wBold, fontFamily:"inherit", whiteSpace:"nowrap" }}>
                  {speedsRunning ? `Looking up ${(speedsResults?.results?.length)||0}/${speedsResults?.total||"…"}…` : "Fill stats"}
                </button>
              </div>

              {speedsResults && (
                <div style={{ marginTop:T.s4, borderTop:`1px solid ${T.border}`, paddingTop:T.s4 }}>
                  {speedsResults.error && <div style={{ fontSize:T.fsm, color:"#f87171", marginBottom:T.s2 }}>⚠ {speedsResults.error}</div>}
                  <div style={{ fontSize:T.fsm, color:T.textLo, marginBottom:T.s3 }}>
                    {speedsResults.finished ? "Done" : "Looking up"} · found <strong style={{color:"#4ade80"}}>{found.length}</strong> of {speedsResults.results?.length||0} checked
                    {speedsResults.total ? ` (${speedsResults.total} total)` : ""}
                  </div>
                  <div style={{ maxHeight:260, overflowY:"auto", marginBottom:T.s3 }}>
                    {found.map((r,i) => (
                      <div key={i} style={{ display:"flex", justifyContent:"space-between", gap:T.s3, padding:"2px 0", fontSize:T.fxs, borderBottom:`1px solid ${T.hair}` }}>
                        <span style={{ color:T.textMid, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.coasterName} <span style={{ color:T.textGhost }}>· {r.parkName}</span></span>
                        <span style={{ flexShrink:0, color:"#4ade80", fontWeight:T.wBold, textAlign:"right" }}>
                          {[r.speedMph!=null && `${r.speedMph} mph`, r.heightFt!=null && `${r.heightFt} ft`, r.yearOpened, [r.manufacturer,r.model].filter(Boolean).join(" ")].filter(Boolean).join(" · ")}
                        </span>
                      </div>
                    ))}
                  </div>
                  {speedsResults.finished && (
                    <div style={{ display:"flex", gap:T.s2 }}>
                      {found.length > 0 && (
                        <button onClick={handleApplySpeeds} style={{ background:"#0f2a3f", border:"1px solid #38bdf844", color:T.accent, borderRadius:T.r2, padding:"6px 16px", cursor:"pointer", fontSize:T.fsm, fontWeight:T.wBold, fontFamily:"inherit" }}>Apply {found.length} update{found.length!==1?"s":""}</button>
                      )}
                      <button onClick={()=>setSpeedsResults(null)} style={{ background:"transparent", border:`1px solid ${T.border2}`, color:T.textLo, borderRadius:T.r2, padding:"6px 12px", cursor:"pointer", fontSize:T.fsm, fontFamily:"inherit" }}>Dismiss</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })()}

        {/* Add new park form */}
        {addingPark && (
          <div style={{ background:T.panel, border:`1px solid ${T.border}`, borderRadius:T.r5, padding:"18px 20px", maxWidth:560, marginBottom:20 }}>
            <div style={{ fontSize:T.fmd, fontWeight:T.wBold, color:T.ink, marginBottom:T.s6 }}>New Park</div>
            <form onSubmit={handleAddPark} style={{ display:"flex", flexDirection:"column", gap:12 }}>
              <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
                <label style={{ display:"flex", flexDirection:"column", gap:3, flex:2, minWidth:140 }}>
                  <span style={fieldLabelCss}>Name</span>
                  {inp(newParkForm.name, e=>setNewParkForm(f=>({...f,name:e.target.value})), "e.g. Kings Island", {flex:1})}
                </label>
                <label style={{ display:"flex", flexDirection:"column", gap:3, width:70 }}>
                  <span style={fieldLabelCss}>Airport</span>
                  {inp(newParkForm.tag, e=>setNewParkForm(f=>({...f,tag:e.target.value})), "CVG")}
                </label>
                <label style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <span style={fieldLabelCss}>Region</span>
                  {regionSelect(newParkForm.region, e=>setNewParkForm(f=>({...f,region:e.target.value})))}
                </label>
                <label style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <span style={fieldLabelCss}>Family</span>
                  {familySelect(newParkForm.family, e=>setNewParkForm(f=>({...f,family:e.target.value})))}
                </label>
              </div>
              <label style={{ display:"flex", flexDirection:"column", gap:3 }}>
                <span style={fieldLabelCss}>Badge (optional)</span>
                {inp(newParkForm.badge, e=>setNewParkForm(f=>({...f,badge:e.target.value})), "e.g. 🏠 Home Park")}
              </label>
              {parkError && <div style={{ fontSize:11, color:"#f87171" }}>{parkError}</div>}
              <div style={{ display:"flex", gap:8 }}>
                <button type="submit" style={{ background:"#0f2a3f", border:"1px solid #38bdf844", color:"#38bdf8", borderRadius:8, padding:"7px 16px", cursor:"pointer", fontSize:12, fontWeight:700, fontFamily:"inherit" }}>Create Park</button>
                <button type="button" onClick={()=>{setAddingPark(false);setParkError("");}} style={{ background:"transparent", border:`1px solid ${T.border2}`, color:T.textLo, borderRadius:8, padding:"7px 12px", cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Cancel</button>
              </div>
            </form>
          </div>
        )}

        {/* Selected park detail */}
        {selectedPark && parkDraft && (
          <>
            {/* Park metadata form */}
            <form onSubmit={handleSavePark} style={{ background:T.panel, border:`1px solid ${T.border}`, borderRadius:T.r5, padding:"16px 20px", maxWidth:560, marginBottom:20 }}>
              <div style={{ fontSize:T.fmd, fontWeight:T.wBold, color:T.ink, marginBottom:T.s5 }}>Park Details</div>
              <div style={{ display:"flex", gap:10, flexWrap:"wrap", marginBottom:10 }}>
                <label style={{ display:"flex", flexDirection:"column", gap:3, flex:2, minWidth:140 }}>
                  <span style={fieldLabelCss}>Name</span>
                  {inp(parkDraft.name, e=>setParkDraft(d=>({...d,name:e.target.value})), "Park name")}
                </label>
                <label style={{ display:"flex", flexDirection:"column", gap:3, width:70 }}>
                  <span style={fieldLabelCss}>Airport</span>
                  {inp(parkDraft.tag, e=>setParkDraft(d=>({...d,tag:e.target.value})), "CLT")}
                </label>
                <label style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <span style={fieldLabelCss}>Region</span>
                  {regionSelect(parkDraft.region, e=>setParkDraft(d=>({...d,region:e.target.value})))}
                </label>
                <label style={{ display:"flex", flexDirection:"column", gap:3 }}>
                  <span style={fieldLabelCss}>Family</span>
                  {familySelect(parkDraft.family, e=>setParkDraft(d=>({...d,family:e.target.value})))}
                </label>
              </div>
              <label style={{ display:"flex", flexDirection:"column", gap:3, marginBottom:12 }}>
                <span style={fieldLabelCss}>Badge (optional)</span>
                {inp(parkDraft.badge, e=>setParkDraft(d=>({...d,badge:e.target.value})), "e.g. 🏠 Home Park", {width:"100%"})}
              </label>

              {/* Official height-chart URL (Six Flags / Cedar Fair). Authoritative source for filling heights by hand. */}
              <label style={{ display:"flex", flexDirection:"column", gap:3, marginBottom:12 }}>
                <span style={fieldLabelCss}>Official Height-Chart URL (optional)</span>
                <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                  {inp(parkDraft.officialUrl, e=>setParkDraft(d=>({...d,officialUrl:e.target.value})), "https://www.sixflags.com/<park>/attractions?ride-category=coaster", {flex:1})}
                  <button type="button"
                    onClick={()=>setParkDraft(d=>({...d, officialUrl: sixFlagsAttractionsUrl(sixFlagsSlugGuess(d.name)) || ""}))}
                    title="Guess a Six Flags URL from the park name"
                    style={{ background:T.panel2, border:`1px solid ${T.border2}`, color:T.textMid, borderRadius:T.r2, padding:"6px 9px", cursor:"pointer", fontSize:T.fsm, fontFamily:"inherit", whiteSpace:"nowrap" }}>Guess</button>
                  {parkDraft.officialUrl?.trim() && (
                    <a href={parkDraft.officialUrl.trim()} target="_blank" rel="noreferrer"
                      style={{ fontSize:11, color:"#38bdf8", textDecoration:"none", whiteSpace:"nowrap" }}>Open ↗</a>
                  )}
                </div>
              </label>

              {/* Map coordinates (optional) — used by the Map view */}
              <label style={{ display:"flex", flexDirection:"column", gap:3, marginBottom:12 }}>
                <span style={fieldLabelCss}>Map Coordinates (optional)</span>
                <div style={{ display:"flex", gap:6, alignItems:"center" }}>
                  <input type="number" step="0.0001" value={parkDraft.lat} onChange={e=>setParkDraft(d=>({...d,lat:e.target.value}))} placeholder="Latitude" style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"6px 8px", color:T.ink, fontSize:T.fbase, fontFamily:"inherit", outline:"none", width:110 }}/>
                  <input type="number" step="0.0001" value={parkDraft.lng} onChange={e=>setParkDraft(d=>({...d,lng:e.target.value}))} placeholder="Longitude" style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"6px 8px", color:T.ink, fontSize:T.fbase, fontFamily:"inherit", outline:"none", width:110 }}/>
                  <span style={{ fontSize:T.fxs, color:T.textFaint }}>blank = use built-in location if known</span>
                </div>
              </label>

              {parkError && <div style={{ fontSize:11, color:"#f87171", marginBottom:8 }}>{parkError}</div>}
              <div style={{ display:"flex", gap:8 }}>
                <button type="submit" style={{ background:"#1e3a1e", border:"1px solid #4ade8044", color:"#4ade80", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontSize:12, fontWeight:700, fontFamily:"inherit" }}>Save Changes</button>
                <button type="button" onClick={()=>{ if(window.confirm(`Delete ${selectedPark.name}? This cannot be undone.`)) { onDeletePark(selectedPark.id); setSelectedId(parks.find(p=>p.id!==selectedPark.id)?.id||null); }}}
                  style={{ background:"#1e0a0a", border:"1px solid #7f1d1d", color:"#f87171", borderRadius:8, padding:"6px 14px", cursor:"pointer", fontSize:12, fontFamily:"inherit" }}>Delete Park</button>
              </div>
            </form>

            {/* ── Import delta preview (merge, not duplicate) ── */}
            {importPreview && (
              <div style={{ maxWidth:700, marginBottom:20, background:T.panel, border:`1px solid ${T.accent}55`, borderRadius:T.r5, padding:"14px 18px" }}>
                <div style={{ fontSize:T.fmd, fontWeight:T.wBold, color:T.ink, marginBottom:T.s2 }}>Review import → {importPreview.parkName}</div>
                <div style={{ fontSize:T.fsm, color:T.textLo, marginBottom:T.s3 }}>
                  <strong style={{color:"#4ade80"}}>{importPreview.added.length}</strong> new ·{" "}
                  <strong style={{color:ACC_AMBER}}>{importPreview.updated.length}</strong> merged (filled empty fields) ·{" "}
                  <strong style={{color:T.textMid}}>{importPreview.unchanged.length}</strong> unchanged
                  <span style={{ color:T.textGhost }}> — existing coasters are matched by name, never duplicated.</span>
                </div>
                <div style={{ maxHeight:200, overflowY:"auto", marginBottom:T.s3, fontSize:T.fxs }}>
                  {importPreview.added.length > 0 && (
                    <div style={{ marginBottom:T.s2 }}>
                      <span style={{ ...labelCss, color:"#4ade80" }}>New</span>
                      <div style={{ color:T.textMid, marginTop:2 }}>{importPreview.added.join(" · ")}</div>
                    </div>
                  )}
                  {importPreview.updated.length > 0 && (
                    <div style={{ marginBottom:T.s2 }}>
                      <span style={{ ...labelCss, color:ACC_AMBER }}>Merged</span>
                      {importPreview.updated.map(u => (
                        <div key={u.name} style={{ color:T.textMid, marginTop:2 }}>{u.name} <span style={{ color:T.textFaint }}>+ {u.fields.join(", ")}</span></div>
                      ))}
                    </div>
                  )}
                  {importPreview.added.length === 0 && importPreview.updated.length === 0 && (
                    <div style={{ color:"#4ade80" }}>✓ Everything selected already exists with the same data — nothing to change.</div>
                  )}
                </div>
                <div style={{ display:"flex", gap:T.s2 }}>
                  {(importPreview.added.length > 0 || importPreview.updated.length > 0) && (
                    <button onClick={confirmImport} style={{ background:"#0f2a3f", border:"1px solid #38bdf844", color:T.accent, borderRadius:T.r2, padding:"7px 16px", cursor:"pointer", fontSize:T.fsm, fontWeight:T.wBold, fontFamily:"inherit" }}>
                      Apply ({importPreview.added.length} new{importPreview.updated.length ? `, ${importPreview.updated.length} merged` : ""})
                    </button>
                  )}
                  <button onClick={()=>setImportPreview(null)} style={{ background:"transparent", border:`1px solid ${T.border2}`, color:T.textLo, borderRadius:T.r2, padding:"7px 12px", cursor:"pointer", fontSize:T.fsm, fontFamily:"inherit" }}>Cancel</button>
                </div>
              </div>
            )}

            {/* ── Coaster Lookup ── */}
            <div style={{ maxWidth:700, marginBottom:20 }}>
              <button onClick={() => { setLookupOpen(o => !o); }} style={{
                display:"flex", alignItems:"center", gap:6,
                background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r3,
                color:T.textMid, padding:"7px 14px", cursor:"pointer",
                fontSize:T.fbase, fontFamily:"inherit", fontWeight:T.wSemi,
              }}>
                <span>🔍</span> Look up coasters online
                <span style={{ marginLeft:4, fontSize:T.fxs, color:T.textFaint }}>{lookupOpen ? "▲" : "▼"}</span>
              </button>

              {lookupOpen && (
                <div style={{ marginTop:T.s4, background:T.panel, border:`1px solid ${T.border}`, borderRadius:T.r5, padding:"16px 18px" }}>
                  <div style={{ fontSize:T.fsm, color:T.textLo, marginBottom:T.s4 }}>
                    Searches Wikipedia for a roller coaster list. Results are auto-selected — uncheck any you don't want, then click Import.
                  </div>

                  {/* Search bar */}
                  <div style={{ display:"flex", gap:T.s3, marginBottom:T.s5 }}>
                    <input
                      value={lookupQuery}
                      onChange={e => setLookupQuery(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && handleLookup()}
                      placeholder="Park name…"
                      style={{ flex:1, background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r3, padding:"7px 10px", color:T.ink, fontSize:T.fmd, fontFamily:"inherit", outline:"none" }}
                    />
                    <button onClick={() => handleLookup()} disabled={lookupLoading || !lookupQuery.trim()} style={{
                      background:"#0f2a3f", border:"1px solid #38bdf844", color:T.accent,
                      borderRadius:T.r3, padding:"7px 16px", cursor:"pointer", fontSize:T.fbase,
                      fontWeight:T.wBold, fontFamily:"inherit", opacity: lookupLoading ? 0.6 : 1,
                    }}>{lookupLoading ? "Searching…" : "Search"}</button>
                  </div>

                  {/* Results */}
                  {lookupResults && (
                    <>
                      {lookupResults.error && (
                        <div style={{ color:"#f87171", fontSize:T.fbase, marginBottom:T.s3 }}>⚠ {lookupResults.error}</div>
                      )}
                      {lookupResults.message && (
                        <div style={{ color:"#facc15", fontSize:T.fbase, marginBottom:T.s3 }}>{lookupResults.message}</div>
                      )}
                      {lookupResults.source && (
                        <div style={{ color:T.textFaint, fontSize:T.fxs, marginBottom:T.s4 }}>Source: {lookupResults.source}</div>
                      )}

                      {/* Suggestions — shown when RCDB returned multiple park matches */}
                      {lookupResults.suggestions?.length > 0 && (
                        <div style={{ display:"flex", flexDirection:"column", gap:T.s2 }}>
                          {lookupResults.suggestions.map((s, i) => (
                            <button key={i} onClick={() => handleLookup(s.path)} style={{
                              display:"flex", alignItems:"baseline", gap:T.s3, textAlign:"left",
                              background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r3,
                              padding:"8px 12px", cursor:"pointer", fontFamily:"inherit",
                            }}>
                              <span style={{ fontSize:T.fmd, fontWeight:T.wBold, color:T.text }}>{s.name}</span>
                              <span style={{ fontSize:T.fsm, color:T.textFaint }}>{s.location}</span>
                              <span style={{ marginLeft:"auto", fontSize:T.fxs, color:T.accent }}>Load ›</span>
                            </button>
                          ))}
                        </div>
                      )}

                      {lookupResults.coasters?.length > 0 && <LookupList
                        coasters={lookupResults.coasters}
                        parkUrl={lookupResults.parkUrl}
                        lookupSel={lookupSel} setLookupSel={setLookupSel}
                        lookupMin={lookupMin} setLookupMin={setLookupMin}
                        onImport={handleImport}
                      />}

                      {lookupResults.coasters?.length === 0 && !lookupResults.error
                        && !lookupResults.suggestions?.length && (
                        <div style={{ fontSize:T.fbase, color:T.textFaint, fontStyle:"italic" }}>No coasters found. Try a different search term.</div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Coaster list */}
            <div style={{ background:T.panel, border:`1px solid ${T.border}`, borderRadius:T.r5, overflow:"hidden", maxWidth:820 }}>
              <div style={{ padding:"10px 16px", background:T.panel2, borderBottom:`1px solid ${T.border}`, display:"flex", justifyContent:"space-between", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                <div style={{ fontSize:T.fbase, fontWeight:T.wBold, color:T.ink }}>Coasters <span style={{ fontWeight:400, color:T.textFaint }}>({selectedPark.coasters.length})</span></div>
                {selectedPark.officialUrl && (
                  <button onClick={handleScrapeHeights} disabled={scrapeLoading} title="Fetch authoritative alone/accompanied heights from the park's official attractions page"
                    style={{ fontSize:T.fxs, fontWeight:T.wBold, padding:"4px 10px", borderRadius:T.r2,
                      background: scrapeLoading ? "transparent" : "#0f2a3f",
                      border:`1px solid ${scrapeLoading ? T.border2 : "#38bdf844"}`,
                      color: scrapeLoading ? T.textFaint : T.accent,
                      cursor: scrapeLoading ? "default" : "pointer", fontFamily:"inherit" }}>
                    {scrapeLoading ? "Scraping…" : "📏 Scrape official heights"}
                  </button>
                )}
              </div>

              {/* Scrape review panel */}
              {scrapeResult && (
                <div style={{ padding:"10px 16px", borderBottom:`1px solid ${T.border}`, background:T.zebra }}>
                  {scrapeResult.error
                    ? <div style={{ fontSize:T.fsm, color:"#f87171" }}>⚠ {scrapeResult.error}</div>
                    : scrapeResult.status
                    ? <div style={{ fontSize:T.fsm, color:T.textLo }}>⏳ {scrapeResult.status}</div>
                    : (() => {
                        const changed = (scrapeResult.matched || []).filter(m => m.changed);
                        const fmt = v => v == null ? "—" : `${v}"`;
                        return (
                          <>
                            <div style={{ fontSize:T.fxs, color:T.textLo, marginBottom:T.s2 }}>
                              Scraped <strong style={{color:T.accent}}>{scrapeResult.scrapedCount}</strong> coasters · <strong style={{color:"#facc15"}}>{changed.length}</strong> with new/changed heights
                              {scrapeResult.unmatchedExisting?.length > 0 && <span> · {scrapeResult.unmatchedExisting.length} of yours not found on the official page</span>}
                            </div>
                            {changed.length > 0 ? (
                              <>
                                <div style={{ maxHeight:160, overflowY:"auto", marginBottom:T.s3 }}>
                                  {changed.map((m,i) => (
                                    <div key={i} style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:T.s3, padding:"3px 0", borderBottom:`1px solid ${T.hair}`, fontSize:T.fxs }}>
                                      <span style={{ color:T.text, flex:1, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                                        {m.name}{m.fuzzy && <span title={`Approx. name match to official "${m.scrapedName}" — verify`} style={{ color:ACC_AMBER, marginLeft:4 }}>≈ {m.scrapedName}</span>}
                                      </span>
                                      <span style={{ flexShrink:0, color:T.textFaint }}>
                                        {fmt(m.current.min)}{m.current.minAccompanied!=null?` (acc ${m.current.minAccompanied}")`:""} → <span style={{color:"#4ade80", fontWeight:T.wBold}}>{fmt(m.scraped.min)}{m.scraped.minAccompanied!=null?` (acc ${m.scraped.minAccompanied}")`:""}</span>
                                      </span>
                                    </div>
                                  ))}
                                </div>
                                <div style={{ display:"flex", gap:T.s2 }}>
                                  <button onClick={handleApplyScrape} style={{ flex:1, background:"#0f2a3f", border:"1px solid #38bdf844", color:T.accent, borderRadius:T.r2, padding:"5px 0", cursor:"pointer", fontSize:T.fsm, fontWeight:T.wBold, fontFamily:"inherit" }}>Apply {changed.length} update{changed.length!==1?"s":""}</button>
                                  <button onClick={()=>setScrapeResult(null)} style={{ background:"transparent", border:`1px solid ${T.border2}`, color:T.textLo, borderRadius:T.r2, padding:"5px 12px", cursor:"pointer", fontSize:T.fsm, fontFamily:"inherit" }}>Dismiss</button>
                                </div>
                              </>
                            ) : (
                              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                                <span style={{ fontSize:T.fxs, color:"#4ade80" }}>✓ All heights already match the official page.</span>
                                <button onClick={()=>setScrapeResult(null)} style={{ background:"transparent", border:`1px solid ${T.border2}`, color:T.textLo, borderRadius:T.r2, padding:"4px 12px", cursor:"pointer", fontSize:T.fsm, fontFamily:"inherit" }}>OK</button>
                              </div>
                            )}
                          </>
                        );
                      })()}
                </div>
              )}

              {/* Column headers */}
              <div style={{ display:"grid", gridTemplateColumns:"1.7fr 1fr 48px 48px 50px 46px 46px 28px", padding:"6px 14px", ...labelCss, color:T.textGhost, gap:6, borderBottom:`1px solid ${T.hair}` }}>
                <div>Name</div><div>Type</div>
                <div style={{textAlign:"center"}} title="Minimum height to ride alone">Min</div>
                <div style={{textAlign:"center"}} title="Minimum height with a supervising companion">Acc</div>
                <div style={{textAlign:"center"}} title="Top speed (mph)">Speed</div>
                <div style={{textAlign:"center"}}>⇄</div><div style={{textAlign:"center"}}>✖</div><div/>
              </div>

              {selectedPark.coasters.length === 0 && (
                <div style={{ padding:"16px 14px", fontSize:T.fbase, color:T.textGhost, fontStyle:"italic" }}>No coasters yet — add one below.</div>
              )}

              {selectedPark.coasters.map((c, i) => (
                editCoaster?.idx === i ? (
                  /* Inline edit row */
                  <form key={i} onSubmit={handleSaveCoaster} style={{ display:"grid", gridTemplateColumns:"1.7fr 1fr 48px 48px 50px 46px 46px 28px", padding:"6px 14px", borderBottom:`1px solid ${T.hair}`, gap:6, alignItems:"center", background:"#1e293b22" }}>
                    {inp(editCoaster.draft.name, e=>setEditCoaster(ec=>({...ec,draft:{...ec.draft,name:e.target.value}})), "Name")}
                    {inp(editCoaster.draft.typeText, e=>setEditCoaster(ec=>({...ec,draft:{...ec.draft,typeText:e.target.value}})), "Type")}
                    <input type="number" min={20} max={96} value={editCoaster.draft.min} onChange={e=>setEditCoaster(ec=>({...ec,draft:{...ec.draft,min:e.target.value}}))} title="Min height to ride alone" style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"5px 3px", color:T.ink, fontSize:T.fbase, fontFamily:"inherit", outline:"none", textAlign:"center", width:"100%" }}/>
                    <input type="number" min={0} max={96} value={editCoaster.draft.minAccompanied} onChange={e=>setEditCoaster(ec=>({...ec,draft:{...ec.draft,minAccompanied:e.target.value}}))} title="Min height with a supervising companion (0 = any height with an adult)" placeholder="—" style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"5px 3px", color:"#fbbf24", fontSize:T.fbase, fontFamily:"inherit", outline:"none", textAlign:"center", width:"100%" }}/>
                    <input type="number" min={0} max={150} value={editCoaster.draft.speed} onChange={e=>setEditCoaster(ec=>({...ec,draft:{...ec.draft,speed:e.target.value}}))} title="Top speed (mph)" placeholder="—" style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"5px 3px", color:T.ink, fontSize:T.fbase, fontFamily:"inherit", outline:"none", textAlign:"center", width:"100%" }}/>
                    <div style={{textAlign:"center"}}>
                      <input type="checkbox" checked={!!editCoaster.draft.racing} onChange={e=>setEditCoaster(ec=>({...ec,draft:{...ec.draft,racing:e.target.checked}}))} style={{accentColor:"#818cf8", width:14, height:14}}/>
                    </div>
                    <div style={{textAlign:"center"}}>
                      <input type="checkbox" checked={!!editCoaster.draft.defunct} onChange={e=>setEditCoaster(ec=>({...ec,draft:{...ec.draft,defunct:e.target.checked}}))} style={{accentColor:"#f87171", width:14, height:14}}/>
                    </div>
                    <div style={{ display:"flex", gap:3 }}>
                      <button type="submit" style={{ background:"#1e3a1e", border:"1px solid #4ade8044", color:"#4ade80", borderRadius:4, padding:"3px 6px", cursor:"pointer", fontSize:10, fontFamily:"inherit" }}>✓</button>
                      <button type="button" onClick={()=>setEditCoaster(null)} style={{ background:"transparent", border:`1px solid ${T.border2}`, color:T.textLo, borderRadius:4, padding:"3px 6px", cursor:"pointer", fontSize:10, fontFamily:"inherit" }}>✕</button>
                    </div>
                    {editCoaster.err && <div style={{ gridColumn:"1/-1", fontSize:10.5, color:"#f87171" }}>{editCoaster.err}</div>}
                  </form>
                ) : (
                  /* Normal row */
                  <div key={i} style={{ display:"grid", gridTemplateColumns:"1.7fr 1fr 48px 48px 50px 46px 46px 28px", padding:"7px 14px", borderBottom: i<selectedPark.coasters.length-1?`1px solid ${T.hair}`:"none", background:i%2===0?"transparent":T.zebra, alignItems:"center", gap:6 }}
                    onMouseEnter={e=>e.currentTarget.style.background="#1e293b22"}
                    onMouseLeave={e=>e.currentTarget.style.background=i%2===0?"transparent":T.zebra}
                  >
                    <button onClick={()=>setEditCoaster({idx:i,draft:{name:c.name,typeText:coasterType(c),min:c.min==null?"":String(c.min),minAccompanied:c.minAccompanied==null?"":String(c.minAccompanied),speed:c.speedMph==null?"":String(c.speedMph),racing:!!c.racing,defunct:!!c.defunct}})} style={{ background:"none", border:"none", padding:0, textAlign:"left", cursor:"pointer", fontFamily:"inherit", display:"flex", alignItems:"center", gap:5 }}>
                      <span style={{ fontSize:T.fbase, fontWeight:T.wSemi, color: c.defunct?T.textMid:T.text, textDecoration: c.defunct?"line-through":"none" }}>{c.name}</span>
                      {c.racing && <span style={{ fontSize:T.fxs, background:"#6366f122", color:"#818cf8", border:"1px solid #6366f133", borderRadius:T.r1, padding:"1px 4px" }}>⇄</span>}
                      {c.defunct && <DefunctBadge/>}
                    </button>
                    <div style={{ fontSize:T.fsm, color:T.textFaint }}>{coasterType(c)}</div>
                    <div style={{textAlign:"center"}}><HtBadge min={c.min}/></div>
                    <div style={{textAlign:"center", fontSize:T.fsm, fontWeight:T.wBold, color: c.minAccompanied!=null?"#fbbf24":T.textGhost}}>{c.minAccompanied!=null?`${c.minAccompanied}"`:"—"}</div>
                    <div style={{textAlign:"center", fontSize:T.fsm, color: c.speedMph!=null?T.textMid:T.textGhost}}>{c.speedMph!=null?`${c.speedMph}`:"—"}</div>
                    <div style={{textAlign:"center", fontSize:T.fbase, color: c.racing?"#818cf8":T.textGhost}}>{c.racing?"⇄":"—"}</div>
                    <div style={{textAlign:"center", fontSize:T.fmd, color: c.defunct?"#f87171":T.textGhost}}>{c.defunct?"✖":"—"}</div>
                    <button onClick={()=>{ if(window.confirm(`Remove "${c.name}"?`)) onDeleteCoaster(selectedPark.id, i); }} style={{ background:"transparent", border:"none", color:T.textFaint, cursor:"pointer", fontSize:T.fmd, padding:"2px 4px", borderRadius:T.r1 }} title="Delete coaster">×</button>
                  </div>
                )
              ))}

              {/* Add coaster form */}
              <form onSubmit={handleAddCoaster} style={{ display:"grid", gridTemplateColumns:"1.7fr 1fr 48px 48px 50px 46px 46px 28px", padding:"8px 14px", borderTop:`1px solid ${T.border}`, gap:6, alignItems:"center", background:T.panel2 }}>
                {inp(coasterForm.name, e=>setCoasterForm(f=>({...f,name:e.target.value})), "Coaster name")}
                {inp(coasterForm.typeText, e=>setCoasterForm(f=>({...f,typeText:e.target.value})), "Type")}
                <input type="number" min={20} max={96} value={coasterForm.min} onChange={e=>setCoasterForm(f=>({...f,min:e.target.value}))} placeholder='Min' title="Min height to ride alone" style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"5px 3px", color:T.ink, fontSize:T.fbase, fontFamily:"inherit", outline:"none", textAlign:"center", width:"100%" }}/>
                <input type="number" min={0} max={96} value={coasterForm.minAccompanied} onChange={e=>setCoasterForm(f=>({...f,minAccompanied:e.target.value}))} placeholder="Acc" title="Min height with a supervising companion (0 = any height with an adult)" style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"5px 3px", color:"#fbbf24", fontSize:T.fbase, fontFamily:"inherit", outline:"none", textAlign:"center", width:"100%" }}/>
                <input type="number" min={0} max={150} value={coasterForm.speed} onChange={e=>setCoasterForm(f=>({...f,speed:e.target.value}))} placeholder="mph" title="Top speed (mph)" style={{ background:T.panel2, border:`1px solid ${T.border2}`, borderRadius:T.r2, padding:"5px 3px", color:T.ink, fontSize:T.fbase, fontFamily:"inherit", outline:"none", textAlign:"center", width:"100%" }}/>
                <div style={{textAlign:"center", display:"flex", alignItems:"center", justifyContent:"center"}}>
                  <input type="checkbox" checked={coasterForm.racing} onChange={e=>setCoasterForm(f=>({...f,racing:e.target.checked}))} title="Dueling/racing" style={{accentColor:"#818cf8", width:14, height:14}}/>
                </div>
                <div style={{textAlign:"center", display:"flex", alignItems:"center", justifyContent:"center", gap:4}}>
                  <input type="checkbox" checked={coasterForm.defunct} onChange={e=>setCoasterForm(f=>({...f,defunct:e.target.checked}))} style={{accentColor:"#f87171", width:14, height:14}}/>
                  <span style={{fontSize:T.fxs,color:T.textFaint}}>gone</span>
                </div>
                <button type="submit" title="Add coaster" style={{ background:"#0f2a3f", border:"1px solid #38bdf844", color:T.accent, borderRadius:T.r2, padding:"4px 8px", cursor:"pointer", fontSize:T.fmd, fontFamily:"inherit", fontWeight:T.wBold }}>+</button>
              </form>
              {coasterError && <div style={{ padding:"4px 14px 8px", fontSize:T.fsm, color:"#f87171" }}>{coasterError}</div>}
            </div>
          </>
        )}

        {!selectedPark && !addingPark && (
          <div style={{ color:T.textGhost, fontSize:T.fmd, marginTop:40 }}>Select a park from the list or click <strong style={{color:T.accent}}>+ Add</strong> to create one.</div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// BACKUP — export the whole dataset to a JSON file, or import one (overwrites).
// ═══════════════════════════════════════════════════════════════════════════
function ExportImport({ buildExport, onImport, counts }) {
  const fileRef = useRef(null);
  const [pending, setPending] = useState(null);   // parsed import awaiting confirmation
  const [msg,     setMsg]     = useState("");

  function handleExport() {
    const data = buildExport();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `coaster-tracker-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMsg("Exported.");
  }

  function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.riders) || !Array.isArray(data.parks))
          throw new Error("Not a valid Coaster Tracker export (missing riders/parks).");
        const creditCount = Object.values(data.credits || {}).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0);
        setPending({ data, summary: `${data.parks.length} parks · ${data.riders.length} riders · ${creditCount} credits` });
        setMsg("");
      } catch (err) {
        setMsg(`Couldn't read that file: ${err.message}`);
        setPending(null);
      }
    };
    reader.readAsText(file);
    e.target.value = "";   // allow re-selecting the same file
  }

  function confirmImport() {
    onImport(pending.data);
    setMsg("Imported — your data has been replaced.");
    setPending(null);
  }

  const btn = (bg, bd, fg) => ({ background:bg, border:`1px solid ${bd}`, color:fg, borderRadius:T.r3, padding:"8px 14px", cursor:"pointer", fontSize:T.fbase, fontWeight:T.wBold, fontFamily:"inherit" });

  return (
    <div style={{ maxWidth:560 }}>
      <div style={{ fontSize:T.fmd, fontWeight:T.wHeavy, color:T.ink, marginBottom:T.s1 }}>Backup &amp; restore</div>
      <div style={{ fontSize:T.fsm, color:T.textLo, marginBottom:T.s6 }}>
        Export everything (parks, coasters, riders, regions, and credits) to a single JSON
        file, or import a previous export. Currently tracking {counts}.
      </div>

      <div style={{ display:"flex", gap:T.s4, flexWrap:"wrap" }}>
        <button onClick={handleExport} style={btn("#0f2a3f", "#38bdf844", T.accent)}>⭳ Export to JSON</button>
        <button onClick={() => fileRef.current?.click()} style={btn("transparent", T.border2, T.textMid)}>⭱ Import from JSON…</button>
        <input ref={fileRef} type="file" accept="application/json,.json" onChange={handleFile} style={{ display:"none" }}/>
      </div>

      {pending && (
        <div style={{ marginTop:T.s6, background:"#1a0f0f", border:"1px solid #7f1d1d", borderRadius:T.r4, padding:"12px 14px" }}>
          <div style={{ fontSize:T.fbase, color:"#fca5a5", fontWeight:T.wBold, marginBottom:T.s1 }}>⚠ This replaces all current data</div>
          <div style={{ fontSize:T.fsm, color:T.textMid, marginBottom:T.s4 }}>Import contains: {pending.summary}. Your existing parks, riders, and credits will be overwritten.</div>
          <div style={{ display:"flex", gap:T.s3 }}>
            <button onClick={confirmImport} style={btn("#3f1d1d", "#7f1d1d", "#fca5a5")}>Replace my data</button>
            <button onClick={() => setPending(null)} style={btn("transparent", T.border2, T.textLo)}>Cancel</button>
          </div>
        </div>
      )}
      {msg && <div style={{ marginTop:T.s5, fontSize:T.fsm, color:"#4ade80" }}>{msg}</div>}
    </div>
  );
}

function AccountSettings() {
  const [email, setEmail] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setEmail(data.user?.email ?? null));
  }, []);

  async function handleSignOut() {
    setBusy(true);
    await supabase.auth.signOut();
    // AuthGate's onAuthStateChange listener flips the session to null and
    // re-renders the sign-in form; no local cleanup needed here.
  }

  const btn = (bg, bd, fg) => ({ background:bg, border:`1px solid ${bd}`, color:fg, borderRadius:T.r3, padding:"8px 14px", cursor:"pointer", fontSize:T.fbase, fontWeight:T.wBold, fontFamily:"inherit" });

  return (
    <div style={{ maxWidth:560 }}>
      <div style={{ fontSize:T.fmd, fontWeight:T.wHeavy, color:T.ink, marginBottom:T.s1 }}>Account</div>
      <div style={{ fontSize:T.fsm, color:T.textLo, marginBottom:T.s6 }}>
        Signed in as <span style={{ color:T.textMid, fontWeight:T.wBold }}>{email ?? "…"}</span>.
      </div>
      <button onClick={handleSignOut} disabled={busy} style={btn("transparent", T.border2, T.textMid)}>
        {busy ? "Signing out…" : "Sign out"}
      </button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PLAN MODE (prototype) — "where should we go" instead of "here's a table".
// Reuses rideStatus()'s existing alone/accompanied/no/unknown states; a rider
// avatar stays visible for every coaster (never hidden), just recolored:
// full color = alone, ringed = accompanied-only (the rare, valuable case),
// greyed = too short, outlined = unknown height.
// ═══════════════════════════════════════════════════════════════════════════
// Status is conveyed by shape/badge as well as color, so it still reads for
// colorblind users or on a washed-out screen: "alone" is a plain filled
// circle, "accompanied" gets a corner badge (amber ring + a small "A" tag),
// "no" gets a corner badge (greyscale + a small "✕" tag), "unknown" is a
// dashed outline.
function RiderAvatar({ rider, status, size = 28 }) {
  const initial = rider.name.slice(0, 1).toUpperCase();
  const base = { width:size, height:size, borderRadius:"50%", display:"flex", alignItems:"center", justifyContent:"center",
    fontSize:size*0.42, fontWeight:T.wBold, flexShrink:0, fontFamily:"inherit" };
  const badgeBase = { position:"absolute", bottom:-2, right:-2, width:size*0.5, height:size*0.5, borderRadius:"50%",
    display:"flex", alignItems:"center", justifyContent:"center", fontSize:size*0.32, fontWeight:T.wBold,
    border:`1.5px solid ${T.bg ?? "#0b0b0b"}`, lineHeight:1 };

  if (status === "alone") {
    return <div title={`${rider.name} — can ride alone`} style={{ ...base, background:rider.color, color:"#0b0b0b" }}>{initial}</div>;
  }
  if (status === "accompanied") {
    return (
      <div title={`${rider.name} — only with an adult`} style={{ position:"relative", flexShrink:0 }}>
        <div style={{ ...base, background:rider.color, color:"#0b0b0b", boxShadow:`0 0 0 2px ${ACC_AMBER}` }}>{initial}</div>
        <div style={{ ...badgeBase, background:ACC_AMBER, color:"#0b0b0b" }}>A</div>
      </div>
    );
  }
  if (status === "no") {
    return (
      <div title={`${rider.name} — too short`} style={{ position:"relative", flexShrink:0 }}>
        <div style={{ ...base, background:rider.color, color:"#0b0b0b", filter:"grayscale(1)", opacity:0.35 }}>{initial}</div>
        <div style={{ ...badgeBase, background:"#6b7280", color:"#fff" }}>✕</div>
      </div>
    );
  }
  return <div title={`${rider.name} — height unknown`} style={{ ...base, background:"transparent", border:`1px dashed ${T.border2}`, color:T.textFaint }}>{initial}</div>;
}

// One coaster's family-fit threshold collapsed to a single number, per the
// "lowest applicable height wins, flag if it required a companion" rule.
function effectiveThreshold(c) {
  const { min, minAccompanied: acc } = c;
  if (min == null && acc == null) return null;
  if (acc != null && (min == null || acc < min)) return { ft:acc, companion:true };
  return { ft:min, companion:false };
}

function familyFit(park, riders) {
  const live = liveCoasters(park);
  let everyone = 0, someNeedAdult = 0, blocked = 0;
  for (const c of live) {
    const statuses = riders.map(r => rideStatus(c, r.height));
    if (statuses.every(s => s === "alone")) everyone++;
    else if (statuses.every(s => s === "alone" || s === "accompanied")) someNeedAdult++;
    else blocked++;
  }
  return { total: live.length, everyone, someNeedAdult, blocked };
}

// How many of a park's coasters a single rider can ride alone vs. only with
// an adult vs. not at all — the basis for the per-rider summary cards.
function riderFit(park, rider) {
  const live = liveCoasters(park);
  let alone = 0, accompanied = 0, no = 0;
  for (const c of live) {
    const s = rideStatus(c, rider.height);
    if (s === "alone") alone++;
    else if (s === "accompanied") accompanied++;
    else if (s === "no") no++;
  }
  return { total: live.length, alone, accompanied, no };
}

function PlanMode({ parks, riders }) {
  const [selectedId, setSelectedId] = useState(null);
  const selected = parks.find(p => p.id === selectedId) || null;

  if (selected) {
    const live = liveCoasters(selected);
    return (
      <div style={{ padding:T.s7, maxWidth:720 }}>
        <button onClick={() => setSelectedId(null)} style={{ background:"none", border:"none", color:T.textLo, cursor:"pointer", fontSize:T.fsm, marginBottom:T.s4, fontFamily:"inherit", padding:0 }}>← Back to parks</button>
        <div style={{ fontSize:T.fxl, fontWeight:T.wHeavy, color:T.ink, marginBottom:T.s5 }}>{selected.name}</div>

        <div style={{ display:"flex", gap:T.s3, marginBottom:T.s6, flexWrap:"wrap" }}>
          {riders.map(r => {
            const rf = riderFit(selected, r);
            return (
              <div key={r.id} style={{ display:"flex", alignItems:"center", gap:T.s3, background:T.panel2, border:`1px solid ${T.border}`, borderRadius:T.r3, padding:`${T.s3} ${T.s4}` }}>
                <RiderAvatar rider={r} status="alone" size={30}/>
                <div>
                  <div style={{ fontSize:T.fsm, fontWeight:T.wBold, color:T.ink }}>{r.name}</div>
                  <div style={{ fontSize:T.fxs, color:T.textLo }}>
                    {rf.alone}/{rf.total} alone
                    {rf.accompanied > 0 && <span style={{ color:ACC_AMBER }}> · +{rf.accompanied} w/ adult</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div style={{ display:"flex", flexDirection:"column", gap:T.s4 }}>
          {live.map(c => {
            const thr = effectiveThreshold(c);
            return (
              <div key={c.name} style={{ borderBottom:`1px solid ${T.border}`, paddingBottom:T.s3 }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"baseline", marginBottom:T.s2 }}>
                  <span style={{ fontSize:T.fbase, fontWeight:T.wBold, color:T.ink }}>{c.name}</span>
                  <span style={{ fontSize:T.fxs, color: thr?.companion ? ACC_AMBER : T.textFaint }}>
                    {thr == null ? "height unknown" : thr.companion ? `${c.min ?? "—"}" · ${thr.ft}" w/ companion` : `${thr.ft}"`}
                  </span>
                </div>
                <div style={{ display:"flex", gap:T.s2 }}>
                  {riders.map(r => <RiderAvatar key={r.id} rider={r} status={rideStatus(c, r.height)}/>)}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding:T.s7, maxWidth:560 }}>
      <div style={{ fontSize:T.fxl, fontWeight:T.wHeavy, color:T.ink, marginBottom:T.s2 }}>Where should we go?</div>
      <div style={{ fontSize:T.fsm, color:T.textLo, marginBottom:T.s6 }}>Scored for {riders.map(r=>r.name).join(", ")}.</div>
      <div style={{ display:"flex", flexDirection:"column", gap:T.s3 }}>
        {parks.map(p => {
          const fit = familyFit(p, riders);
          const ratio = fit.total ? fit.everyone / fit.total : 0;
          const tone = fit.total === 0 ? { bg:T.panel2, fg:T.textFaint } : ratio >= 0.6 ? { bg:"#4ade8022", fg:"#4ade80" } : ratio >= 0.25 ? { bg:`${ACC_AMBER}22`, fg:ACC_AMBER } : { bg:"#f8717122", fg:"#f87171" };
          return (
            <button key={p.id} onClick={() => setSelectedId(p.id)} style={{
              display:"flex", alignItems:"center", gap:T.s4, padding:T.s4, borderRadius:T.r3,
              border:`1px solid ${T.border}`, background:T.panel, cursor:"pointer", textAlign:"left", fontFamily:"inherit",
            }}>
              <div style={{ flex:1 }}>
                <div style={{ fontSize:T.fbase, fontWeight:T.wBold, color:T.ink }}>{p.name}</div>
                <div style={{ fontSize:T.fxs, color:T.textFaint }}>{REGIONS[p.region] || p.region}</div>
              </div>
              <span style={{ background:tone.bg, color:tone.fg, fontSize:T.fxs, fontWeight:T.wBold, padding:"3px 10px", borderRadius:T.pill, whiteSpace:"nowrap" }}>
                {fit.everyone}/{fit.total} fit all
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// APP ROOT
// ═══════════════════════════════════════════════════════════════════════════
export default function App() {
  const [view,         setView]         = useState("parks");
  const [settingsTab,  setSettingsTab]  = useState("parks");     // parks | riders | regions
  const [region, setRegion] = useState("ALL");
  const [riders, setRiders] = useState(null);
  const [parks,  setParks]  = useState(null);
  const [ridden, setRidden] = useState(null);
  const [regions, setRegions] = useState(REGIONS); // mirrors module-level REGIONS; drives re-renders on edit
  const [ready,  setReady]  = useState(false);
  // Coaster detail modal: { parkId, coasterName }; the coaster + park are derived
  // live from `parks` so edits stay in sync. null = closed.
  const [coasterModal, setCoasterModal] = useState(null);
  const openCoaster = useCallback((parkId, coaster) => setCoasterModal({ parkId, coasterName: coaster.name }), []);

  // Load everything from Supabase on mount (HOUSEHOLD_ID set by the auth gate
  // in main.jsx before App renders).
  useEffect(() => {
    loadHouseholdData().then(({ regions, riders, parks, ridden }) => {
      const parkList = parks.map(p => ({ ...p, coasters: (p.coasters || []).map(normalizeCoaster) }));
      if (Object.keys(regions).length) REGIONS = regions;
      setRegions(REGIONS);
      setRiders(riders);
      setParks(parkList);
      setRidden(ridden);
      setReady(true);
    });
  }, []);

  // ── ridden helpers ────────────────────────────────────────────────────────
  const toggleRidden = useCallback((riderId, key) => {
    setRidden(prev => {
      const set = new Set(prev[riderId] || []);
      set.has(key) ? set.delete(key) : set.add(key);
      setParks(curParks => { saveRiderCredits(riderId, set, curParks); return curParks; });
      return { ...prev, [riderId]: set };
    });
  }, []);

  const selectAll = useCallback((riderId, park) => {
    setRidden(prev => {
      const set = new Set(prev[riderId] || []);
      liveCoasters(park).forEach(c => set.add(ck(park.id, c.name)));
      setParks(curParks => { saveRiderCredits(riderId, set, curParks); return curParks; });
      return { ...prev, [riderId]: set };
    });
  }, []);

  const clearAll = useCallback((riderId, park) => {
    setRidden(prev => {
      const set = new Set(prev[riderId] || []);
      liveCoasters(park).forEach(c => set.delete(ck(park.id, c.name)));
      setParks(curParks => { saveRiderCredits(riderId, set, curParks); return curParks; });
      return { ...prev, [riderId]: set };
    });
  }, []);

  // ── rider helpers ─────────────────────────────────────────────────────────
  const addRider = useCallback(r => {
    setRiders(prev => { const next = [...prev, r]; saveRiders(next); return next; });
    setParks(curParks => { saveRiderCredits(r.id, new Set(), curParks); return curParks; });
  }, []);
  const updateRider = useCallback(r => {
    setRiders(prev => { const next = prev.map(x => x.id===r.id ? r : x); saveRiders(next); return next; });
  }, []);
  const deleteRider = useCallback(id => {
    setRiders(prev => { const next = prev.filter(x => x.id!==id); saveRiders(next); return next; });
  }, []);

  // ── park helpers ──────────────────────────────────────────────────────────
  const addPark = useCallback(p => {
    setParks(prev => { const next = [...prev, p]; saveParks(next); return next; });
  }, []);
  const updatePark = useCallback(p => {
    setParks(prev => { const next = prev.map(x => x.id===p.id ? p : x); saveParks(next); return next; });
  }, []);
  const deletePark = useCallback(id => {
    setParks(prev => { const next = prev.filter(x => x.id!==id); saveParks(next); return next; });
  }, []);

  // ── region helpers ────────────────────────────────────────────────────────
  // Regions live in data/settings.json. Keep the module-level REGIONS in sync so
  // every component that reads it (region filter, grouped lists) renders new values.
  const updateRegions = useCallback(nextRegions => {
    REGIONS = nextRegions;            // legacy read path used across components
    setRegions(nextRegions);          // triggers re-render
    saveSettings({ regions: nextRegions });
    // If the active filter points at a region that no longer exists, reset it
    setRegion(r => (r === "ALL" || nextRegions[r]) ? r : "ALL");
  }, []);
  // Whole-dataset export → a single JSON object the user can download.
  const exportDataset = useCallback(() => ({
    version: 1,
    exportedAt: new Date().toISOString(),
    riders: riders ?? [],
    parks: parks ?? [],
    settings: { regions: REGIONS },
    credits: Object.fromEntries(Object.entries(ridden ?? {}).map(([rid, set]) => [rid, [...set]])),
  }), [riders, parks, ridden]);

  // Whole-dataset import → replaces riders, parks, regions, and credits, and
  // persists each. Coasters re-run through `normalizeCoaster`. Destructive: the
  // caller confirms first.
  const importDataset = useCallback(data => {
    const nextRiders = Array.isArray(data.riders) ? data.riders : [];
    const nextParks = (Array.isArray(data.parks) ? data.parks : []).map(p => ({
      ...p, coasters: (p.coasters || []).map(normalizeCoaster),
    }));
    setRiders(nextRiders); saveRiders(nextRiders);
    setParks(nextParks); saveParks(nextParks);
    if (data.settings?.regions && Object.keys(data.settings.regions).length) updateRegions(data.settings.regions);
    const creditsObj = data.credits || {};
    const nextRidden = {};
    for (const r of nextRiders) {
      const set = new Set(Array.isArray(creditsObj[r.id]) ? creditsObj[r.id] : []);
      nextRidden[r.id] = set;
      saveRiderCredits(r.id, set, nextParks);
    }
    setRidden(nextRidden);
  }, [updateRegions]);

  const addCoaster = useCallback((parkId, coaster, atIndex) => {
    const nc = normalizeCoaster(coaster);   // single funnel — every add/edit/import normalizes here
    setParks(prev => {
      const next = prev.map(p => {
        if (p.id !== parkId) return p;
        const coasters = [...p.coasters];
        if (atIndex != null) coasters.splice(atIndex, 0, nc);
        else coasters.push(nc);
        return { ...p, coasters };
      });
      saveParks(next);
      return next;
    });
  }, []);
  const deleteCoaster = useCallback((parkId, idx) => {
    setParks(prev => {
      const next = prev.map(p => p.id!==parkId ? p : { ...p, coasters: p.coasters.filter((_,i)=>i!==idx) });
      saveParks(next);
      return next;
    });
  }, []);

  // Edit a coaster in place. If the name changes, the credit key
  // (`parkId|||coasterName`) changes too, so migrate every rider's recorded
  // credit from the old key to the new one — otherwise the credit is orphaned.
  const updateCoaster = useCallback((parkId, idx, coaster) => {
    const nc = normalizeCoaster(coaster);
    let oldName = null, updatedParks = null;
    setParks(prev => {
      const next = prev.map(p => {
        if (p.id !== parkId) return p;
        const coasters = p.coasters.map((c, i) => {
          if (i !== idx) return c;
          oldName = c.name;
          return nc;
        });
        return { ...p, coasters };
      });
      saveParks(next);
      updatedParks = next;
      return next;
    });
    if (oldName != null && oldName !== nc.name) {
      const oldKey = ck(parkId, oldName), newKey = ck(parkId, nc.name);
      setRidden(prev => {
        let changed = false;
        const next = {};
        for (const [rid, set] of Object.entries(prev)) {
          if (set.has(oldKey)) {
            const ns = new Set(set); ns.delete(oldKey); ns.add(newKey);
            saveRiderCredits(rid, ns, updatedParks);
            next[rid] = ns; changed = true;
          } else next[rid] = set;
        }
        return changed ? next : prev;
      });
    }
  }, []);

  // Apply batch-scrape results: [{parkId, coasterName, min, minAccompanied}].
  // Name-keyed (cross-park indexes are fragile); stamps heightSource:"official".
  const applyScrapedHeights = useCallback(updates => {
    const norm = normCoasterName;   // punctuation/trademark-insensitive name match
    setParks(prev => {
      const next = prev.map(park => {
        const ups = updates.filter(u => u.parkId === park.id);
        if (!ups.length) return park;
        const coasters = park.coasters.map(c => {
          const u = ups.find(u => norm(u.coasterName) === norm(c.name));
          return u ? { ...c, min: u.min, minAccompanied: u.minAccompanied, heightSource: "official" } : c;
        });
        return { ...park, coasters };
      });
      saveParks(next);
      return next;
    });
  }, []);

  // Replace a park's coaster list with the merged result of a delta import.
  // `mergeCoasters` already preserved existing names (so credit keys stay valid)
  // and only filled empty fields; here we just persist the new list.
  const mergeImportCoasters = useCallback((parkId, coasters) => {
    setParks(prev => {
      const next = prev.map(p => p.id === parkId ? { ...p, coasters } : p);
      saveParks(next);
      return next;
    });
  }, []);

  // Apply RCDB stats results: [{parkId, coasterName, speedMph, heightFt, yearOpened,
  // manufacturer, model, material, style, rcdbId, rcdbUrl}]. Name-keyed merge;
  // speed/height/year always overwrite (previously null, single authoritative
  // source); manufacturer/model/material/style only fill empties — these may
  // already hold a heuristic guess (from splitting `type`) or a hand edit, and
  // RCDB's full name ("Bolliger & Mabillard") isn't strictly better than the
  // common abbreviation ("B&M") already there. Doesn't touch rider heights.
  const applySpeeds = useCallback(updates => {
    const norm = normCoasterName;   // punctuation/trademark-insensitive name match
    setParks(prev => {
      const next = prev.map(park => {
        const ups = updates.filter(u => u.parkId === park.id);
        if (!ups.length) return park;
        const coasters = park.coasters.map(c => {
          const u = ups.find(u => norm(u.coasterName) === norm(c.name));
          if (!u) return c;
          const merged = { ...c, speedMph: u.speedMph, heightFt: u.heightFt ?? c.heightFt, yearOpened: u.yearOpened ?? c.yearOpened };
          if (u.rcdbId && c.rcdbId == null)  merged.rcdbId  = u.rcdbId;
          if (u.rcdbUrl && c.rcdbUrl == null) merged.rcdbUrl = u.rcdbUrl;
          if (u.manufacturer && !c.manufacturer) merged.manufacturer = u.manufacturer;
          if (u.model && !c.model) merged.model = u.model;
          if (u.material && !c.material) merged.material = u.material;
          if (u.style && !c.style) merged.style = u.style;
          return merged;
        });
        return { ...park, coasters };
      });
      saveParks(next);
      return next;
    });
  }, []);

  // Apply height lookup results: [{parkId, coasterIdx, height, source}]
  const applyHeights = useCallback(updates => {
    setParks(prev => {
      const next = prev.map(park => {
        const parkUpdates = updates.filter(u => u.parkId === park.id);
        if (!parkUpdates.length) return park;
        const coasters = park.coasters.map((c, i) => {
          const u = parkUpdates.find(u => u.coasterIdx === i);
          return u ? { ...c, min: u.height, heightSource: u.source } : c;
        });
        return { ...park, coasters };
      });
      saveParks(next);
      return next;
    });
  }, []);

  // ── derived values (all hooks before any early return) ────────────────────
  const visibleParks = useMemo(
    () => (parks ?? []).filter(p => region==="ALL" || p.region===region),
    [parks, region]
  );
  const totalCoasters = useMemo(() => (parks ?? []).reduce((s,p)=>s+liveCoasters(p).length,0), [parks]);
  const grandTotals = useMemo(() =>
    (riders ?? []).map(r => {
      const visitedParks = (parks ?? []).filter(p => liveCoasters(p).some(c => ridden?.[r.id]?.has(ck(p.id,c.name))));
      return {
        ...r,
        credits:  (parks ?? []).reduce((s,p) => s+liveCoasters(p).filter(c=>ridden?.[r.id]?.has(ck(p.id,c.name))).length, 0),
        // rideable = coasters the rider meets the height requirement for (null height = unknown, exclude; defunct excluded)
        rideable: (parks ?? []).reduce((s,p) => s+p.coasters.filter(c=>isEligible(c, r.height)).length, 0),
        // scoped to parks the rider has actually visited (≥1 credit) — keeps the pill reachable
        visitedCredits:  visitedParks.reduce((s,p) => s+liveCoasters(p).filter(c=>ridden?.[r.id]?.has(ck(p.id,c.name))).length, 0),
        visitedRideable: visitedParks.reduce((s,p) => s+p.coasters.filter(c=>isEligible(c, r.height)).length, 0),
      };
    }),
  [riders, parks, ridden]);

  const [creditsJump, setCreditsJump] = useState(null);
  const jumpToRiderCredits = riderId => { setCreditsJump({ pivot:"rider", riderId }); setView("credits"); };

  // Loading screen
  if (!ready || !riders || !parks || !ridden) {
    return (
      <div style={{ minHeight:"100vh", background:T.bg, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:T.s4, color:T.textFaint, fontFamily:"'DM Sans','Segoe UI',sans-serif" }}>
        <div style={{ fontSize:32 }}>🎢</div>
        <div style={{ fontSize:T.fmd }}>Loading data…</div>
      </div>
    );
  }

  // `region: true` = the top-bar region filter applies to this view (it filters
  // the parks shown). Per-view config instead of an ad-hoc allow-list.
  const NAV = [
    { id:"plan",     label:"🧭 Plan (prototype)", region:false },
    { id:"parks",    label:"🎢 Parks",    region:true  },
    { id:"credits",  label:"✓ Credits",   region:true  },
    { id:"settings", label:"⚙ Settings",  region:false },
  ];

  const SETTINGS_SUB = [
    { id:"parks",   label:"🎡 Parks & Coasters" },
    { id:"riders",  label:"👤 Riders"  },
    { id:"regions", label:"🗺 Regions" },
    { id:"backup",  label:"💾 Backup"  },
    { id:"account", label:"👤 Account" },
  ];

  const showRegion = !!NAV.find(n => n.id === view)?.region;

  return (
    <div style={{ minHeight:"100vh", background:T.bg, color:T.text, fontFamily:"'DM Sans','Segoe UI',sans-serif", display:"flex", flexDirection:"column" }}>

      {/* TOP BAR */}
      <div style={{ background:"linear-gradient(135deg,#0f172a 0%,#1a1040 100%)", borderBottom:`1px solid ${T.border}`, padding:`${T.s5}px ${T.s7}px` }}>
        <div style={{ display:"flex", alignItems:"center", gap:T.s4, flexWrap:"wrap", justifyContent:"space-between" }}>
          <div style={{ display:"flex", alignItems:"center", gap:T.s4, flexWrap:"wrap" }}>
            <span style={{ fontSize:T.fxl, fontWeight:T.wHeavy, letterSpacing:"-0.02em", color:T.ink }}>🎢 Coaster Tracker</span>
            <span style={{ fontSize:T.fxs, color:T.textFaint }}>{parks.length} parks · {totalCoasters} credits</span>
            {grandTotals.map(r => (
              <button key={r.id} onClick={() => jumpToRiderCredits(r.id)} title={`${r.visitedCredits}/${r.visitedRideable} eligible at parks visited · ${r.credits}/${r.rideable} across all parks — view ${r.name}'s credits`} style={{ display:"inline-flex", alignItems:"center", gap:T.s2, background:`${r.color}15`, border:`1px solid ${r.color}44`, borderRadius:T.pill, padding:"2px 9px", fontSize:T.fsm, fontWeight:T.wBold, color:r.color, cursor:"pointer", fontFamily:"inherit" }}>
                <ColorDot color={r.color} size={7}/>
                {r.name} <span style={{ fontWeight:400, color:r.color+"99" }}>{r.visitedCredits}/{r.visitedRideable}</span>
              </button>
            ))}
          </div>
          <div style={{ display:"flex", gap:T.s1, background:T.panel2, borderRadius:T.r4, padding:T.s1, border:`1px solid ${T.border}` }}>
            {NAV.map(m => (
              <button key={m.id} onClick={() => setView(m.id)} style={{
                padding:`${T.s2}px ${T.s6}px`, borderRadius:T.r3, fontFamily:"inherit", fontSize:T.fbase, fontWeight: view===m.id?T.wBold:400,
                border: view===m.id?`1px solid ${T.border2}`:"1px solid transparent",
                background: view===m.id?T.border:"transparent",
                color: view===m.id?T.ink:T.textLo,
                cursor:"pointer", transition:"all 0.15s",
              }}>{m.label}</button>
            ))}
          </div>
        </div>
      </div>

      {/* SETTINGS SUB-NAV */}
      {view === "settings" && (
        <div style={{ background:T.panel, borderBottom:`1px solid ${T.border}`, padding:`0 ${T.s7}px`, display:"flex", gap:2 }}>
          {SETTINGS_SUB.map(s => (
            <button key={s.id} onClick={() => setSettingsTab(s.id)} style={{
              padding:`${T.s3}px ${T.s6}px`, background:"none", border:"none",
              borderBottom: settingsTab===s.id ? `2px solid ${T.accent}` : "2px solid transparent",
              color: settingsTab===s.id ? T.ink : T.textLo,
              cursor:"pointer", fontSize:T.fbase, fontWeight: settingsTab===s.id ? T.wBold : 400,
              fontFamily:"inherit", transition:"all 0.15s",
            }}>{s.label}</button>
          ))}
        </div>
      )}

      {/* REGION FILTER */}
      {showRegion && (
        <div style={{ background:T.panel, borderBottom:`1px solid ${T.border}`, padding:`${T.s2}px ${T.s7}px`, display:"flex", gap:T.s2, alignItems:"center", flexWrap:"wrap" }}>
          <span style={{ fontSize:T.fxs, color:T.textGhost }}>Region:</span>
          {["ALL", ...Object.keys(REGIONS)].map(r => (
            <button key={r} onClick={() => setRegion(r)} style={{
              padding:"2px 9px", borderRadius:T.pill,
              border: region===r?`1px solid ${T.accent}`:`1px solid ${T.border}`,
              background: region===r?"#38bdf822":"transparent",
              color: region===r?T.accent:T.textFaint,
              cursor:"pointer", fontSize:T.fxs, fontFamily:"inherit", transition:"all 0.12s",
            }}>{r==="ALL"?"All Regions":REGIONS[r]}</button>
          ))}
        </div>
      )}

      {/* CONTENT */}
      <div style={{ display:"flex", flexDirection:"column", flex:1, minHeight:0, overflowY:"auto" }}>
        {/* Plan mode — prototype, additive alongside the existing tabs */}
        {view==="plan" && <PlanMode parks={parks} riders={riders}/>}

        {/* Parks tab — unified left nav with Explorer / Height sub-views */}
        {view==="parks" && <ParksTab visibleParks={visibleParks} allParks={parks} riders={riders} ridden={ridden} onToggle={toggleRidden} onSelectAll={selectAll} onClearAll={clearAll} onOpenCoaster={openCoaster}/>}

        {/* Credits tab */}
        {view==="credits" && <CreditTracker riders={riders} ridden={ridden} onToggle={toggleRidden} onSelectAll={selectAll} onClearAll={clearAll} visibleParks={visibleParks} allParks={parks} onOpenCoaster={openCoaster} jump={creditsJump}/>}

        {/* Settings tab — Parks first, then Riders */}
        {view==="settings" && settingsTab==="parks"  && <ManageParks parks={parks} onAddPark={addPark} onUpdatePark={updatePark} onDeletePark={deletePark} onAddCoaster={addCoaster} onUpdateCoaster={updateCoaster} onDeleteCoaster={deleteCoaster} onApplyHeights={applyHeights} onApplyScrapedAll={applyScrapedHeights} onApplySpeeds={applySpeeds} onMergeImport={mergeImportCoasters}/>}
        {view==="settings" && settingsTab==="riders"  && <ManageRiders riders={riders} onAdd={addRider} onUpdate={updateRider} onDelete={deleteRider}/>}
        {view==="settings" && settingsTab==="regions" && <ManageRegions regions={regions} parks={parks} onUpdate={updateRegions}/>}
        {view==="settings" && settingsTab==="backup"  && <ExportImport buildExport={exportDataset} onImport={importDataset} counts={`${parks.length} parks · ${riders.length} riders`}/>}
        {view==="settings" && settingsTab==="account" && <AccountSettings/>}
      </div>

      {/* Coaster detail modal — opened from any clickable coaster name; park +
          coaster derived live so an edit reflects immediately. */}
      {(() => {
        if (!coasterModal) return null;
        const park = parks.find(p => p.id === coasterModal.parkId);
        const coaster = park?.coasters.find(c => c.name === coasterModal.coasterName);
        if (!park || !coaster) return null;   // closed if the coaster was renamed away/deleted
        return <CoasterModal park={park} coaster={coaster} onClose={() => setCoasterModal(null)}
          onSave={(pid, idx, c) => { updateCoaster(pid, idx, c); setCoasterModal(m => m ? { ...m, coasterName: normalizeCoaster(c).name } : m); }}/>;
      })()}
    </div>
  );
}
