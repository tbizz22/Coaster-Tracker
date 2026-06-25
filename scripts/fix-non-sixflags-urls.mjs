// One-off: using the new `family` field, fix officialUrl for non-Six-Flags-family
// parks. The scraper only reads SF/Cedar Fair Algolia pages, so these links are
// for the "📏 Official height chart" reference link, not auto-scraping.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PARKS_FILE = path.join(__dirname, "..", "data", "parks.json");

const URLS = {
  // hershey is IND but was wrongly stamped with a sixflags.com URL — clear it.
  hershey:  "https://www.hersheypark.com/plan-your-visit/blog/plan-your-hersheypark-day-by-height-category",
  bgw:      "https://buschgardens.com/williamsburg/roller-coasters/",
  knoebels: "https://knoebels.com/faqs/rider-safety/",
  gp4moax9: "https://www.universalorlando.com/web/en/us/plan-your-visit/hours-information/ride-height-requirements", // Islands of Adventure
  za50hzzq: "https://www.universalorlando.com/web/en/us/plan-your-visit/hours-information/ride-height-requirements", // Universal Studios
  cvv824wa: "https://www.universalorlando.com/web/en/us/plan-your-visit/hours-information/ride-height-requirements", // Epic Universe
  g1cujwfp: "https://nickelodeonuniverse.com/faq/",
  "363b01w3": "https://jenkinsons.com/rides/",
  o6w410xf: "https://www.iplayamerica.com/fun-and-games/amusement-rides/",
};

const parks = JSON.parse(fs.readFileSync(PARKS_FILE, "utf8"));
let updated = 0;
for (const p of parks) {
  if (p.family === "SF" || p.family === "CF") continue; // these already have correct sixflags.com URLs
  const url = URLS[p.id];
  if (!url) { console.warn(`No URL mapping for non-SF/CF park "${p.id}" (${p.name}) — left as-is`); continue; }
  if (p.officialUrl !== url) { p.officialUrl = url; updated++; }
}
fs.writeFileSync(PARKS_FILE, JSON.stringify(parks, null, 2), "utf8");
console.log(`Updated officialUrl on ${updated} non-SF/CF parks.`);
