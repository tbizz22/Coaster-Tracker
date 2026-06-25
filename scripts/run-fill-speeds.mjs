// Drive the live /api/fill-speeds endpoint (server.js, already running via
// `npm run dev`) directly from Node, bypassing the browser — fetches all
// coasters from Supabase, posts them to the scraper, and writes the results
// (speed/height/year/manufacturer/model/material/style) straight back.
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/run-fill-speeds.mjs [serverUrl]
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SERVER_URL = process.argv[2] || "http://localhost:3001";
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

async function main() {
  const { data: parkRows, error: parkErr } = await sb.from("parks").select("id,name");
  if (parkErr) throw parkErr;
  const { data: coasterRows, error: coasterErr } = await sb.from("coasters").select("*");
  if (coasterErr) throw coasterErr;

  const coastersByPark = new Map();
  for (const c of coasterRows) {
    const list = coastersByPark.get(c.park_id) ?? [];
    list.push({
      name: c.name, defunct: c.defunct, rcdbUrl: c.rcdb_url,
      speedMph: c.speed_mph, heightFt: c.height_ft, yearOpened: c.year_opened, manufacturer: c.manufacturer,
    });
    coastersByPark.set(c.park_id, list);
  }
  const parks = parkRows.map(p => ({ id: p.id, name: p.name, coasters: coastersByPark.get(p.id) ?? [] }));

  console.log(`Posting ${coasterRows.length} coasters across ${parks.length} parks to ${SERVER_URL}/api/fill-speeds ...`);
  const resp = await fetch(`${SERVER_URL}/api/fill-speeds`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parks }),
  });
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(`HTTP ${resp.status}: ${body.error || resp.statusText}`);
  }
  if (!resp.body) throw new Error("No response body (not a stream) — endpoint may have returned early JSON.");

  // Build a name→coaster_id lookup per park to apply updates as they stream in.
  const coasterIdByKey = new Map(); // `${parkId}|||${name}` -> coaster id
  for (const c of coasterRows) coasterIdByKey.set(`${c.park_id}|||${c.name}`, c.id);
  const parkIdByName = new Map(parkRows.map(p => [p.name, p.id]));

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let applied = 0, found = 0, total = 0;

  async function applyResult(msg) {
    const hasAny = msg.speedMph != null || msg.heightFt != null || msg.yearOpened != null || msg.manufacturer || msg.model || msg.material || msg.style;
    if (!hasAny) return;
    const coasterId = coasterIdByKey.get(`${msg.parkId}|||${msg.coasterName}`);
    if (!coasterId) { console.warn(`No coaster id for ${msg.coasterName} @ ${msg.parkName}`); return; }
    const existing = coasterRows.find(c => c.id === coasterId);
    const update = {};
    if (msg.speedMph != null) update.speed_mph = msg.speedMph;
    if (msg.heightFt != null) update.height_ft = msg.heightFt;
    if (msg.yearOpened != null) update.year_opened = msg.yearOpened;
    if (msg.manufacturer && !existing.manufacturer) update.manufacturer = msg.manufacturer;
    if (msg.model && !existing.model) update.model = msg.model;
    if (msg.material && !existing.material) update.material = msg.material;
    if (msg.style && !existing.style) update.style = msg.style;
    if (msg.rcdbId && !existing.rcdb_id) update.rcdb_id = msg.rcdbId;
    if (msg.rcdbUrl && !existing.rcdb_url) update.rcdb_url = msg.rcdbUrl;
    if (Object.keys(update).length === 0) return;
    const { error } = await sb.from("coasters").update(update).eq("id", coasterId);
    if (error) { console.error(`Failed to update ${msg.coasterName}:`, error.message); return; }
    applied++;
    console.log(`✓ ${msg.coasterName} (${msg.parkName}):`, JSON.stringify(update));
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = chunk.split("\n").find(l => l.startsWith("data: "));
      if (!line) continue;
      const msg = JSON.parse(line.slice(6));
      if (msg.type === "start") { total = msg.total; console.log(`Starting — ${total} coasters to look up`); }
      else if (msg.type === "result") {
        found = msg.found;
        await applyResult(msg);
      } else if (msg.type === "done") {
        console.log(`\nDone — found stats for ${msg.found}/${msg.total}, applied ${applied} updates to Supabase.`);
      } else if (msg.type === "error") {
        console.error("Server error:", msg.message);
      }
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
