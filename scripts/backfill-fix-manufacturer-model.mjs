// One-time cleanup: fixes two data-quality problems left over from the
// original manufacturer/model split (see docs/BACKLOG.md "Coaster `type` split
// into `manufacturer` + `model`" in the Done archive):
//
// 1. Manufacturer sometimes holds RCDB's full legal name instead of the
//    canonical abbreviation the app's MANUFACTURER_OPTIONS dropdown expects
//    (e.g. "Bolliger & Mabillard" instead of "B&M"). Normalized via a known
//    full-name -> abbreviation map.
// 2. Model sometimes holds a material/layout descriptor duplicated from
//    material+style (e.g. model="Steel Sit Down" when material="Steel" and
//    style="Sit Down") instead of a real model name (e.g. "Hyper Coaster").
//    There's no other source for the real model already in the DB, so this
//    script clears it to null rather than guessing — a subsequent "Enrich
//    Coaster Data" run (Stats checked) will re-fetch the real model from RCDB,
//    once server.js's needsStats check also treats a blank model as missing
//    (see the paired fix in server.js).
//
// Defaults to a DRY RUN (prints planned changes, writes nothing). Pass --apply
// to actually write.
//
// Usage: node scripts/backfill-fix-manufacturer-model.mjs [--apply]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";

const envText = readFileSync(new URL("../.env", import.meta.url), "utf8");
const env = {};
for (const line of envText.split("\n")) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const sb = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const APPLY = process.argv.includes("--apply");

// Full-name variants actually observed in the data -> the canonical
// abbreviation already used by MANUFACTURER_OPTIONS in credit-tracker.jsx.
const FULL_TO_ABBR = {
  "Bolliger & Mabillard": "B&M",
  "Mack Rides GmbH & Co KG": "Mack Rides",
  "Rocky Mountain Construction": "RMC",
  "Philadelphia Toboggan Coasters, Inc.": "PTC",
  "Intamin Amusement Rides": "Intamin",
};

const MATERIAL_WORDS = ["steel", "wood", "hybrid", "sit down", "inverted", "suspended", "flying", "wing", "stand", "spinning"];
function modelLooksLikeMaterial(model) {
  if (!model) return false;
  const m = model.toLowerCase();
  return MATERIAL_WORDS.some(w => m.includes(w));
}

async function main() {
  const { data: coasters, error } = await sb
    .from("coasters")
    .select("id,name,manufacturer,model,material,style,parks(name)")
    .order("park_id");
  if (error) throw error;

  const mfrFixes = [];
  const modelClears = [];
  for (const c of coasters) {
    const abbr = FULL_TO_ABBR[c.manufacturer];
    if (abbr && abbr !== c.manufacturer) mfrFixes.push({ ...c, newManufacturer: abbr });
    if (modelLooksLikeMaterial(c.model)) modelClears.push(c);
  }

  console.log(`${APPLY ? "APPLYING" : "DRY RUN"} — ${coasters.length} coasters checked\n`);

  console.log(`Manufacturer normalization: ${mfrFixes.length} rows`);
  for (const c of mfrFixes) console.log(`  ${c.parks?.name} — ${c.name}: "${c.manufacturer}" -> "${c.newManufacturer}"`);

  console.log(`\nModel clear (material/layout text, not a real model): ${modelClears.length} rows`);
  for (const c of modelClears) console.log(`  ${c.parks?.name} — ${c.name}: model "${c.model}" -> null (material="${c.material}" style="${c.style}")`);

  if (!APPLY) {
    console.log(`\nDry run only — nothing written. Re-run with --apply to write these ${mfrFixes.length + modelClears.length} changes.`);
    return;
  }

  let done = 0;
  for (const c of mfrFixes) {
    const { error: e } = await sb.from("coasters").update({ manufacturer: c.newManufacturer }).eq("id", c.id);
    if (e) throw e;
    done++;
  }
  for (const c of modelClears) {
    const { error: e } = await sb.from("coasters").update({ model: null }).eq("id", c.id);
    if (e) throw e;
    done++;
  }
  console.log(`\nApplied ${done} updates.`);
}

main().catch(err => { console.error(err); process.exit(1); });
