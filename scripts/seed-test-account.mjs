// Seeds the dedicated test account's household with generic riders + one
// real park's coasters, so PR previews / local Plan-mode testing have
// something realistic to render without touching real family data.
//
// Safe to commit: riders are generic placeholders (no real names), and the
// park/coaster data is public real-world info (names + posted height limits),
// not anyone's personal data.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in the environment
// (service-role bypasses RLS — never use this key outside one-off scripts).
//
// Usage: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed-test-account.mjs <test_account_email>

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const testEmail = process.argv[2];

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.");
  process.exit(1);
}
if (!testEmail) {
  console.error("Usage: node scripts/seed-test-account.mjs <test_account_email>");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// Generic placeholder riders spanning the height bands that matter for
// eligibility testing: too-short-for-most, companion-range, and tall-enough.
const RIDERS = [
  { id: "seed-rider-a", name: "Rider A", height: 40, color: "#fb923c" },
  { id: "seed-rider-b", name: "Rider B", height: 48, color: "#38bdf8" },
  { id: "seed-rider-c", name: "Rider C", height: 52, color: "#34d399" },
  { id: "seed-rider-d", name: "Rider D", height: 60, color: "#f87171" },
];

// Real Carowinds (Charlotte, NC) coasters with their publicly posted height
// limits — chosen because it has a mix of alone-only, companion-eligible,
// and fully-blocked cases for a 40" rider, which is the interesting case
// for testing Plan mode's family-fit logic.
const PARK = {
  id: "seed-park-carowinds",
  name: "Carowinds",
  tag: "CLT",
  region: "SE",
  family: "CF",
  officialUrl: "https://www.carowinds.com/things-to-do/rides/height-requirements",
  coasters: [
    { name: "Wilderness Run", min: 36, minAccompanied: null },
    { name: "Snoopy's Racing Railway", min: 36, minAccompanied: null },
    { name: "Woodstock Express", min: 46, minAccompanied: 40 },
    { name: "Kiddy Hawk", min: 42, minAccompanied: null },
    { name: "Carolina Goldrusher", min: 48, minAccompanied: null },
    { name: "Carolina Cyclone", min: 48, minAccompanied: null },
    { name: "Hurler", min: 48, minAccompanied: null },
    { name: "Flying Cobras", min: 48, minAccompanied: null },
    { name: "Ricochet", min: 54, minAccompanied: 44 },
    { name: "Copperhead Strike", min: 52, minAccompanied: null },
    { name: "Afterburn", min: 54, minAccompanied: null },
    { name: "Thunder Striker", min: 54, minAccompanied: null },
    { name: "Fury 325", min: 54, minAccompanied: null },
    { name: "Vortex", min: 54, minAccompanied: null },
  ],
};

async function main() {
  const { data: usersPage, error: usersErr } = await sb.auth.admin.listUsers();
  if (usersErr) throw usersErr;
  const user = usersPage.users.find(u => u.email === testEmail);
  if (!user) throw new Error(`No auth user found for ${testEmail}. Sign up with the test account in the app first.`);

  const { data: profile, error: profileErr } = await sb
    .from("profiles")
    .select("default_household_id")
    .eq("user_id", user.id)
    .single();
  if (profileErr || !profile?.default_household_id) {
    throw new Error(`No profile/household found for ${testEmail}. Sign up in the app first.`);
  }
  const householdId = profile.default_household_id;
  console.log(`Seeding household ${householdId} (${testEmail})`);

  await sb.from("riders").upsert(
    RIDERS.map((r, i) => ({ id: r.id, household_id: householdId, name: r.name, height: r.height, color: r.color, sort: i })),
    { onConflict: "id" }
  );

  await sb.from("parks").upsert(
    { id: PARK.id, household_id: householdId, name: PARK.name, tag: PARK.tag, region_code: PARK.region, family: PARK.family, official_url: PARK.officialUrl, sort: 0 },
    { onConflict: "id" }
  );

  await sb.from("coasters").upsert(
    PARK.coasters.map((c, i) => ({
      id: `${PARK.id}-${i}`, park_id: PARK.id, name: c.name, min: c.min, min_accompanied: c.minAccompanied, sort: i,
    })),
    { onConflict: "id" }
  );

  console.log(`Seeded ${RIDERS.length} riders and ${PARK.coasters.length} coasters at ${PARK.name}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
