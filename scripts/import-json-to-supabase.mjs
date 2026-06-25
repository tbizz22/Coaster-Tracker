// One-time import: data/*.json (the legacy file-based store) → Supabase.
// Creates one household owned by the bootstrap user, then riders/regions/
// parks/coasters, then resolves each "parkId|||coasterName" credit key to a
// coaster_id row.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment
// (service-role bypasses RLS — never use this key outside one-off scripts).
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-json-to-supabase.mjs <owner_user_id>

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ownerUserId = process.argv[2];

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.");
  process.exit(1);
}
if (!ownerUserId) {
  console.error("Usage: node scripts/import-json-to-supabase.mjs <owner_user_id>");
  console.error("(owner_user_id = the auth.users id created when you sign up in the app)");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf8"));
}

async function main() {
  // The new-user trigger already created a household + membership + profile
  // + default regions for this user on sign-up — fetch that household.
  const { data: profile, error: profileErr } = await sb
    .from("profiles")
    .select("default_household_id")
    .eq("user_id", ownerUserId)
    .single();
  if (profileErr || !profile?.default_household_id) {
    throw new Error(
      `No profile/household found for user ${ownerUserId}. Sign up in the app first, then re-run with that user's id.`
    );
  }
  const householdId = profile.default_household_id;
  console.log(`Importing into household ${householdId}`);

  // Regions: overwrite the trigger's defaults with the real region list.
  const settings = readJson("settings.json");
  await sb.from("regions").delete().eq("household_id", householdId);
  const regionRows = Object.entries(settings.regions).map(([code, name], i) => ({
    household_id: householdId,
    code,
    name,
    sort: i,
  }));
  if (regionRows.length) {
    const { error } = await sb.from("regions").insert(regionRows);
    if (error) throw error;
  }
  console.log(`Imported ${regionRows.length} regions.`);

  // Riders. ids are client-generated text (the app's uid() scheme) — reuse
  // the legacy id verbatim so no id-mapping/translation is needed.
  const riders = readJson("riders.json");
  const riderRows = riders.map((r, i) => ({
    id: r.id,
    household_id: householdId,
    name: r.name,
    height: r.height,
    color: r.color,
    needs_companion: !!r.needsCompanion,
    sort: i,
  }));
  if (riderRows.length) {
    const { error } = await sb.from("riders").insert(riderRows);
    if (error) throw error;
  }
  console.log(`Imported ${riders.length} riders.`);

  // Parks + coasters. Park ids are the legacy client-generated ids (reused
  // verbatim). Coasters never had a client id in the old file-based model —
  // mint one now with the same uid() scheme `credit-tracker.jsx` uses, so
  // future client-side upserts (normalizeCoaster) recognize and preserve it.
  const uid = () => Math.random().toString(36).slice(2, 10);
  const parks = readJson("parks.json");
  const coasterIdMap = new Map(); // `${legacyParkId}|||${coasterName}` -> coaster id
  for (let i = 0; i < parks.length; i++) {
    const p = parks[i];
    const parkRow = {
      id: p.id,
      household_id: householdId,
      name: p.name,
      tag: p.tag ?? null,
      region_code: p.region ?? null,
      badge: p.badge ?? null,
      family: p.family ?? null,
      official_url: p.officialUrl ?? null,
      lat: p.lat ?? null,
      lng: p.lng ?? null,
      sort: i,
    };
    const { error: parkErr } = await sb.from("parks").insert(parkRow);
    if (parkErr) throw parkErr;

    const coasters = p.coasters ?? [];
    const coasterRows = coasters.map((c, j) => {
      const id = uid();
      coasterIdMap.set(`${p.id}|||${c.name}`, id);
      return {
        id,
        park_id: p.id,
        name: c.name,
        type: c.type ?? null,
        min: c.min ?? null,
        min_accompanied: c.minAccompanied ?? null,
        speed_mph: c.speedMph ?? null,
        racing: !!c.racing,
        defunct: !!c.defunct,
        rcdb_id: c.rcdbId ?? null,
        rcdb_url: c.rcdbUrl ?? null,
        scale: c.scale ?? null,
        status: c.status ?? null,
        height_source: c.heightSource ?? null,
        sort: j,
      };
    });
    if (coasterRows.length) {
      const { error: coasterErr } = await sb.from("coasters").insert(coasterRows);
      if (coasterErr) throw coasterErr;
    }
  }
  console.log(`Imported ${parks.length} parks and ${coasterIdMap.size} coasters.`);

  // Credits: resolve each legacy "parkId|||coasterName" key per rider.
  let creditCount = 0;
  let unresolved = 0;
  for (const r of riders) {
    const creditsFile = path.join(DATA_DIR, "credits", `${r.id}.json`);
    if (!fs.existsSync(creditsFile)) continue;
    const keys = JSON.parse(fs.readFileSync(creditsFile, "utf8"));
    const rows = [];
    for (const key of keys) {
      const coasterId = coasterIdMap.get(key);
      if (!coasterId) {
        console.warn(`Unresolved credit key for rider ${r.name}: "${key}"`);
        unresolved++;
        continue;
      }
      rows.push({ rider_id: r.id, coaster_id: coasterId });
    }
    if (rows.length) {
      const { error } = await sb.from("credits").insert(rows);
      if (error) throw error;
      creditCount += rows.length;
    }
  }
  console.log(`Imported ${creditCount} credits (${unresolved} unresolved keys skipped).`);
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
