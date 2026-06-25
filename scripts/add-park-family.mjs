// One-off: populate the new `family` field on every park (chain/ownership grouping).
// Source: real-world ownership, cross-checked against queuetimes.com/parks groupings.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PARKS_FILE = path.join(__dirname, "..", "data", "parks.json");

const FAMILY = {
  carowinds: "CF",     // Carowinds — Cedar Fair-branded (Six Flags Entertainment Corp since the 2024 merger)
  ki: "CF",             // Kings Island — Cedar Fair-branded
  sfga: "SF",           // Six Flags Great America
  sfog: "SF",           // Six Flags Over Georgia
  kd: "CF",             // Kings Dominion — Cedar Fair-branded
  bgw: "SW",            // Busch Gardens Williamsburg — SeaWorld/United Parks & Resorts
  cw: "CF",             // Canada's Wonderland — Cedar Fair-branded
  cp: "CF",             // Cedar Point — Cedar Fair-branded
  sfgadv: "SF",         // Six Flags Great Adventure
  hershey: "IND",       // Hersheypark — Hershey Entertainment & Resorts (independent)
  dorney: "CF",         // Dorney Park — Cedar Fair-branded
  knoebels: "IND",      // Knoebels — independent, family-owned
  sfot: "SF",           // Six Flags Over Texas
  sfft: "SF",           // Six Flags Fiesta Texas
  sfmm: "SF",           // Six Flags Magic Mountain
  knotts: "CF",         // Knott's Berry Farm — Cedar Fair-branded
  gp4moax9: "UNI",      // Universal Islands of Adventure
  za50hzzq: "UNI",      // Universal Studios (Orlando)
  cvv824wa: "UNI",      // Epic Universe
  g1cujwfp: "IND",      // Nickelodeon Universe — Triple Five Group (American Dream)
  mz6bzhvc: "SF",       // Six Flags New England
  "363b01w3": "IND",    // Jenkinson's Boardwalk — independent
  o6w410xf: "IND",      // iPlay America — independent
};

const parks = JSON.parse(fs.readFileSync(PARKS_FILE, "utf8"));
let updated = 0;
for (const p of parks) {
  const family = FAMILY[p.id];
  if (!family) { console.warn(`No family mapping for park id "${p.id}" (${p.name}) — skipped`); continue; }
  if (p.family !== family) { p.family = family; updated++; }
}
fs.writeFileSync(PARKS_FILE, JSON.stringify(parks, null, 2), "utf8");
console.log(`Updated family on ${updated}/${parks.length} parks.`);
