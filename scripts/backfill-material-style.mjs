// One-time: derive material (Steel/Wood/Hybrid) + style (Sit Down/Inverted/…)
// from the existing `model` field. For coasters where manufacturer wasn't
// matched (model still holds the full original descriptor, e.g. "Steel Sit
// Down"), this is a clean split. For manufacturer-matched coasters (model is
// just the remainder, e.g. "Wooden"/"Hyper"/"Inverted"), style = that remainder
// and material is inferred (Wood if it says so, else Steel — the safe default
// since the overwhelming majority of coasters are steel).
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/backfill-material-style.mjs
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.");
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

function splitMaterialStyle(modelStr) {
  const s = String(modelStr || "").trim();
  if (!s) return { material: "", style: "" };
  const lower = s.toLowerCase();
  if (lower.startsWith("steel ")) return { material: "Steel", style: s.slice(6).trim() };
  if (lower.startsWith("wood "))  return { material: "Wood",  style: s.slice(5).trim() };
  if (lower.startsWith("hybrid ")) return { material: "Hybrid", style: s.slice(7).trim() };
  if (lower.includes("wood")) return { material: "Wood", style: s };
  return { material: "Steel", style: s }; // safe default
}

async function main() {
  const { data: coasters, error } = await sb.from("coasters").select("id,name,model");
  if (error) throw error;

  let updated = 0;
  for (const c of coasters) {
    const { material, style } = splitMaterialStyle(c.model);
    const { error: updErr } = await sb.from("coasters").update({ material: material || null, style: style || null }).eq("id", c.id);
    if (updErr) throw updErr;
    updated++;
    console.log(`${c.name}: model="${c.model || ""}" → material="${material}" style="${style}"`);
  }
  console.log(`\nBackfilled ${updated} coasters.`);
}

main().catch(err => { console.error(err); process.exit(1); });
