// One-time: split coasters.type ("B&M Inverted") into manufacturer/model
// columns for every existing row, before 00000000000003 drops `type`.
// Mirrors splitManufacturerModel() in credit-tracker.jsx — keep the two in sync.
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-manufacturer-model.mjs
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

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
].sort((a, b) => b.length - a.length);

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

async function main() {
  const { data: coasters, error } = await sb.from("coasters").select("id,name,type");
  if (error) throw error;

  let updated = 0, withManufacturer = 0;
  for (const c of coasters) {
    const { manufacturer, model } = splitManufacturerModel(c.type);
    const { error: updErr } = await sb
      .from("coasters")
      .update({ manufacturer: manufacturer || null, model: model || null })
      .eq("id", c.id);
    if (updErr) throw updErr;
    updated++;
    if (manufacturer) withManufacturer++;
    console.log(`${c.name}: "${c.type || ""}" → manufacturer="${manufacturer}" model="${model}"`);
  }
  console.log(`\nBackfilled ${updated} coasters (${withManufacturer} matched a known manufacturer, ${updated - withManufacturer} left manufacturer blank — model carries the full original string).`);
}

main().catch(err => { console.error(err); process.exit(1); });
