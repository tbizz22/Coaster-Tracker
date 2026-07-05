# Backlog & future ideas

Durable record of future work (the in-app suggestion chips don't persist across
restarts). Roughly priority-ordered within each section. See
`INFORMATION-ARCHITECTURE.md` for the design context.

---

## 🚀 Major direction: web platform (DB + auth + mobile)

**Status: Phases 0–3 done.**
Full phased plan: **`docs/WEB-PLATFORM-PLAN.md`**.

Re-platform the local-first, single-user app into a web-accessible, multi-user,
eventually-installable product. **Decisions already made:**
- **Account model:** *Household account* — one login owns a household containing
  riders (still data, not logins), parks, coasters, credits. Multi-user-per-
  household (invites/roles) is a later phase.
- **Platform:** *Supabase* — managed Postgres + Auth + Row-Level Security. React
  client talks to Supabase directly; a small Node service keeps the
  Playwright/RCDB/Wikipedia scrapers (can't run inside Supabase).
- **Mobile:** *Web-first, PWA later*; React Native stays a future option sharing
  the same backend (note: current inline-styled DOM/SVG UI does **not** port to RN).

**Side benefit:** moving credits from the `parkId|||coasterName` string key to a
real `credits(rider_id, coaster_id)` FK row fixes the rename-orphan bug for free.

**Phases:** 0 Foundations (Supabase project + schema/RLS migrations + config) ·
1 Data-layer migration (swap file persistence for Supabase, normalize coasters→rows
& credits→FK, JSON→DB import, trim `server.js` to scraper-only) · 2 Auth & multi-
tenancy (login gate, household creation, `household_id` + RLS, security pass) ·
3 Web deploy (SPA + Supabase + scraper container — code/config ready, see below) ·
4 PWA (do the responsive/design-
system cleanup first, then `vite-plugin-pwa`) · 5 Future (household sharing, native app).

See the plan file for the proposed schema, critical files, and verification steps.
**Prerequisite for good mobile:** the "Visual design system & responsive breakpoints"
item below.

Phases 0–4a (Supabase migration, auth/RLS, production deploy to Vercel+Render, and
the mobile Plan/Log redesign) are done and verified live — full detail moved to the
Done archive at the bottom ("Web platform: Phases 0–4a"). The old `data/*.json`
pre-migration snapshot (and its `.backup-*` files) has been deleted — Supabase has
been the system of record with no issues.

**Not yet done:** Phase 4b (PWA manifest/installability), Phase 5
(sharing/native). A few smaller account-creation UX rough edges remain — see
the dedicated subsection below.

### Clean up the account-creation experience

Rough edges found while building the minimal `AuthGate` — fine for one self-serve signup,
not fine to ship as-is:

- **Sign-up gives no feedback when email confirmation is pending.** Supabase's default
  "Confirm email" setting means `signUp()` resolves with no error and no session — from the
  user's perspective the button just... stops, with nothing visibly different. Partially
  fixed (a green "check your email to confirm" notice now shows when `data.session` is null
  after signup), but there's no resend-confirmation-email action and no detection of *which*
  state the project's auth settings are in.
- **No password reset / forgot-password flow.** `AuthForm` only has sign-in and sign-up;
  losing the password locks you out with no recovery path.
- **No real error-state styling/validation.** Email/password fields use only native HTML
  `required`/`minLength`; weak-password and malformed-email errors surface as raw Supabase
  error strings, not friendly copy.
- **No loading state for the initial session check.** `AuthGate` renders `null` while
  `session === undefined` or while `householdReady` is resolving — a blank white/black flash
  on every load instead of a spinner.
- **Silent failure if the new-user trigger fails.** `handle_new_user()` (the SQL trigger that
  creates a household/profile/default regions on sign-up) runs inside the same transaction as
  the `auth.users` insert, so a trigger bug surfaces as a generic signup error with no
  indication *why* — needs either better error surfacing or a Supabase Function/Edge Function
  with explicit logging instead of a bare trigger.
- ~~**No account/session management UI.**~~ **Done** — Settings ▸ Account shows the signed-in
  email and a Sign out button (`AccountSettings` in `credit-tracker.jsx`); still no way to
  leave/delete a household (that's multi-user-per-household, a later phase).
- **Hardcoded dev-only styling.** `AuthGate`'s inline styles (`wrap`/`card`/`input`/`button`)
  don't use the `T` design-token scale the rest of the app is built on (see "Visual design
  system" below) — should be restyled once that token system extends to this screen.

---

## Deferred — needs external data or a product decision

These were reviewed during the backlog sweep and intentionally left for later;
each is blocked on something this codebase can't settle on its own.

- **Accompanied heights for non-Six-Flags parks** (Knoebels, Hersheypark,
  Universal, …). *Deferred:* the Playwright scraper only covers Six Flags / Cedar
  Fair pages; no source for the others — manual entry only. (Coverage for SF/CF
  parks is done — see Done archive: "Batch scrape all parks", "officialUrl coverage",
  "By-rider accompanied-height column".)
- **Credit history / dates** — record *when* / *how many times* a coaster was
  ridden instead of a boolean. *Deferred:* a data-model change best done alongside
  the web-platform DB migration (credits become FK rows there anyway).
- **Real tile map (optional upgrade).** Swap the offline SVG for Leaflet/MapLibre
  for pan/zoom + street context. *Deferred:* explicitly optional and conflicts
  with the offline-first goal (adds deps + network tiles).
- **Shared/global coaster data across households.** Right now every household's
  `coasters` rows are private, per-household copies (RLS-scoped, no cross-household
  read) — so 23 households tracking Six Flags Great Adventure each hold their own
  duplicate row for Nitro, independently scraped/entered. Idea: promote park/coaster
  *reference* data (name, manufacturer, model, material, style, heightFt, yearOpened,
  speedMph, rcdbId/rcdbUrl, officialUrl) to a household-independent global table that
  every account reads from, while household-specific state (credits, per-rider
  overrides, hand-edited fields) stays local. **Decided: worth scoping now** — next
  step is a design/RLS pass answering the open questions below before migration work
  starts:
  - **Write access.** Global rows can't be household-writable (any user could vandalize
    every other household's data) — likely needs a separate elevated role (service-role
    script, or an admin-only RLS policy) that only the scrapers/import scripts use, not
    arbitrary authenticated users.
  - **Overwrite vs. override semantics.** A household must be able to locally override a
    global field (e.g. a hand-corrected height) without that edit (a) leaking to other
    households or (b) getting silently clobbered the next time the global row is
    refreshed by a re-scrape. Likely needs an explicit per-field "is this overridden
    locally" flag (similar in spirit to the existing `mergeCoasters` never-clobber
    logic) rather than a flat global-vs-local table split.
  - **Schema shape.** Options: (a) one global `coasters` table + a thin per-household
    `coaster_overrides` table joined at read time, or (b) keep per-household `coasters`
    rows but seed/refresh them from a global reference table on import/scrape (closer
    to today's model, simpler RLS, but back to per-household duplication). Needs a
    decision before migration work starts.
  - **RLS implications.** The global table would need read access for all authenticated
    users but RLS write-denial for everyone except the elevated role — different shape
    from every other table in this schema (all currently scoped strictly to
    `household_id`), so worth a dedicated security review of the new policies before
    shipping, not just reusing the existing household-scoped pattern.

## Visual design system & responsive breakpoints

**Done** (see Done — "Design system & responsive pass" + "Design system sweep").
A `T` design-token object (spacing / type / radius / weight / color roles) +
mirrored CSS variables, shared `labelCss` / `fieldLabelCss`, the responsive shell
(`.ct-split` / `.ct-sidenav` / `.ct-hscroll` + `.ct-content`), unified
`HEIGHT_BANDS`, and a full per-component token sweep across every primary surface.

**Remaining (thin tail, optional):**
- **Extract `Pill`/`Badge`/`Panel` primitives.** The token *values* are now
  consistent, but a few visual patterns (status pills, the panel card, the small
  accent buttons) are still repeated inline rather than factored into shared
  components. Worth doing alongside the coaster-detail-modal work (which needs the
  first reusable modal primitive anyway).
- **Map SVG colors** intentionally stay literal (geographic/region hues live in
  `REGION_COLORS`, not the grey token scale). Semantic status colors (green/amber/
  red/violet for fill/scrape/racing/defunct) also stay literal by design.
- **Light/extra theming** is out of scope (decision: refine the existing dark
  theme).

## IA / UX (from INFORMATION-ARCHITECTURE.md §8)

All items from the original IA §8 review are done — see Done archive: "Coaster
detail modal", "Coaster import = delta merge", "Top-bar rider pills deep-link",
"By-rider visited-parks-scoped totals", "Park `family` field". Nothing open here.

---

## Done (this build) — for reference

**settingsupdates.md sweep — badges, geocoding, image search, manufacturer data cleanup.**
- **Park badges → multi-select.** `badge` (single freeform text, never actually
  displayed anywhere) is now `badges` (array) picked via checkboxes from a fixed
  preset (Home Park / Pass Holder / Favorite), rendered as icon chips in the
  Parks left-nav row and the detail header. Migration `00000000000008` applied.
- **Auto-geocode park coordinates.** A "Find by name" button next to the lat/lng
  fields queries Nominatim/OpenStreetMap and fills them (still manually
  overridable); added to the mobile edit-park form too (previously desktop-only).
- **One-off "Find image" button** on the coaster detail modal — new
  `/api/find-image` endpoint reuses the existing RCDB/Wikimedia lookup helpers
  for a single coaster on demand, instead of requiring the full bulk enrich job.
- **Manufacturer/model data cleanup.** Backfilled production: normalized 91
  coasters' manufacturer from RCDB's full legal name to the canonical
  abbreviation, and cleared 236 coasters' `model` field where it just duplicated
  material+style (e.g. `"Steel Sit Down"`) instead of a real model name — no
  real model value existed anywhere to recover, so a future "Enrich Coaster
  Data" run will refill them from RCDB now that the server also treats a blank
  model as missing (previously only checked blank manufacturer).
- **"Stop heights" → "Stop scrape"** button copy fix.
- Fixed a real data-loss bug found along the way: editing a coaster via the
  Settings grid silently wiped `material`/`style`/`heightFt`/`yearOpened`/
  `imageUrl`/rcdb fields on every save (the handler built a bare replacement
  object instead of merging onto the existing record).
- Fixed production CORS: the scraper's `FRONTEND_URL` allowlist on Render
  hadn't been updated when `coasterattack.com` was added as a custom domain,
  so scraper calls silently failed from production while working fine from
  localhost (Vite's dev proxy bypasses CORS). Documented the fix requirement
  in `CONTRIBUTING.md` for future domain changes.
- Not done: a management UI for the `MANUFACTURER_OPTIONS` dropdown list itself
  (still a hardcoded const) — would need a new per-household settings store,
  which doesn't exist yet (only the dedicated `regions` table today).

**Desktop park-detail table redesign (user feedback).** Addressed all four
notes on the Parks ▸ detail table:
- Dropped the `HEIGHT_BANDS` breakdown chips and the "Unknown" chip from the
  stat-card row (arbitrary per-band colors, and the unknown-height count
  already surfaces in the "N missing a height" subtitle) — kept only
  "Coasters" total and, when a rider lens is active, the "[Rider] can ride"
  chip that feedback called out as the genuinely useful one.
- Split the combined Type column into separate **Manufacturer** and **Model**
  columns; Manufacturer always renders through a new `MANUFACTURER_ABBR` map
  (`abbrMfr()`) so a coaster stored with the full name ("Bolliger & Mabillard")
  still displays the common abbreviation ("B&M") — the full name is kept as a
  tooltip.
- The height-eligibility legend (✓/✓\*/✗/?) moved behind a small "ⓘ" hover/focus
  affordance (`LegendInfo`) instead of sitting permanently under the table.
- `imageUrl` thumbnails (28×28) now render in the desktop Credits view's
  coaster-name cell, in both the By-park pivot grid and the By-rider drawer
  rows (skipped on the `compact`/mobile variant, which already has its own
  card layout) — a blank placeholder swatch shows for coasters with no image
  yet, so the column doesn't jump width row to row.

**Mobile/desktop view-boundary audit — confirmed already done.** Re-checked all
three items from the old "Mobile & desktop view fixes" section against current
code: (1) `isMobile` (`window.innerWidth<640`) + a bidirectional `useEffect`
(`credit-tracker.jsx:~3788`) snaps `view` back to Plan/Log on mobile and to
Parks on desktop, and `NAV`'s `desktopOnly`/`mobileOnly` flags structurally
exclude Parks/Credits from the mobile tab bar (not just CSS-hidden) — Credits
is deliberately still reachable on mobile via a dedicated `MobileRiderCredits`
component, not the desktop `CreditTracker`. (2) The mobile Settings menu lists
"Parks & Coasters" identically to every other sub-tab — no hidden dead end;
the `ct-settings-parks-tab` class the old backlog note referenced no longer
exists anywhere in the code. (3) Settings sub-nav on mobile is already a
purpose-built stacked drill-down list with a back button, not the old
horizontal pill strip. Removed the stale comments referencing the no-longer-
real `ct-settings-parks-tab` mechanism.

**Coaster Manufacturer field → dropdown.** `CoasterModal`'s edit form
Manufacturer field (`credit-tracker.jsx`) is now a `<select>` sourced from a
new `MANUFACTURER_OPTIONS` list (one canonical abbreviation per manufacturer,
kept in sync with `KNOWN_MANUFACTURERS`), with an "Other…" option that swaps
in a free-text input for manufacturers not yet in the list (RCDB imports do
carry genuinely new/rare ones). The Settings add/edit grid's combined "Type"
field was left as free text — it's one string covering manufacturer+model
together, not a clean fit for a single-manufacturer dropdown.

**Add park from the desktop main view.** The Parks tab's left nav (`ParksTab`)
now has a "＋" button next to the "Parks" header that opens an inline add-park
form (name, airport code, region, chain/family) — same shape as `PlanMode`'s
existing add-park form — and selects the new park on save. Previously this
required navigating to Settings ▸ Parks & Coasters.

**Add park from mobile — confirmed already done.** `PlanMode` (the mobile
Plan/Log view) already had this exact inline add-park form (name/code/region/
family) wired to `parkEditProps.onAddPark`; the backlog note was stale.

**Web platform: Phases 0–4a (Supabase migration, auth/RLS, production deploy,
mobile redesign) — verified live.**
- **Phases 0–1 (data layer):** schema + RLS migration pushed to Supabase;
  `credit-tracker.jsx` persistence rewritten to talk to Supabase directly
  (`loadHouseholdData`/`saveRiders`/`saveParks`/`saveSettings`/`saveRiderCredits`);
  minimal email/password `AuthGate` wraps `<App/>`; real `data/*.json` (5 riders,
  23 parks, 254 coasters, 342 credits) imported via
  `scripts/import-json-to-supabase.mjs`; `server.js` trimmed to a stateless
  scraper service (scrape endpoints take the caller's parks data via POST body
  instead of reading `data/parks.json` off disk; a new `postSSE()` helper drives
  the SSE ones since `EventSource` can't POST). Bug caught and fixed: the SSE
  endpoints tracked disconnect via `req.on("close")`, which fires as soon as
  Express finishes reading the POST body, not on actual client disconnect —
  switched to `res.on("close")`. Dead `DEFAULT_PARKS`/`DEFAULT_RIDERS` fallback
  data removed (unreachable once load always goes through Supabase).
- **Phase 2 (auth/RLS security pass):** verified with a second real account —
  0 parks/0 credits visible, confirming RLS correctly isolates households and
  `handle_new_user()` seeds a fresh empty household per signup. Added Settings ▸
  Account (signed-in email + Sign out).
- **Phase 3 (deploy):** SPA on Vercel (`coaster-tracker-gray.vercel.app`),
  scraper on Render as a Docker web service (Playwright's base image, so headless
  Chromium is already present); `API_BASE` env wiring, `cors` gated by
  `FRONTEND_URL`, `PORT` read from env. Verified CORS preflight is scoped to the
  real frontend origin only. Repo checked for secrets/PII before confirming
  public-safe. Bug found and fixed: `VITE_SCRAPER_URL` was initially a
  placeholder hostname from setup instructions, not the real Render URL —
  surfaced as a misleading CORS error, actual cause was Render's edge 404 for an
  unregistered hostname.
- **Phase 4a (mobile redesign):** new **Plan mode** (per-park "where should we
  go," rider avatars greyed/amber-badged by height) and **Log mode** (same view,
  tap-to-toggle credits). Below 640px: bottom tab bar (Plan · Log · Settings
  only — Parks/Credits redirect to Plan), rider pills collapse to a popover,
  Settings sub-nav/region filter scroll horizontally. Park/coaster editing
  reachable inline from Plan mode via `lockToParkId`.

**Ride photo/thumbnail.** `imageUrl` field added (Wikipedia infobox image,
hotlinked), rendered as a 56×56 thumbnail in the Parks detail table
(`credit-tracker.jsx:3463`) and full-width in `CoasterModal`
(`credit-tracker.jsx:929`). Not yet extended to the desktop Credits view — see
the open item above.

**⚠️ Critical bug fixed: editing a coaster silently deleted its credits.**
Neither coaster-edit form (`CoasterModal`'s "Edit details" dialog, nor the
inline editor in Settings ▸ Parks & Coasters) passed the coaster's existing
`id` through in the save payload, so `normalizeCoaster()` minted a *new* id on
every single edit (`id: raw.id || uid()`). `saveParks()` then deleted the
old-id row (no longer present in the in-memory list), which cascaded and wiped
every credit tied to that coaster's `coaster_id` foreign key — for every
rider, permanently. Affected **every** coaster edit (any field, not just
height), at any park, since credits moved to the FK model. Fixed by carrying
`id` through `modalDraftFrom` and both save payloads. **Any credits lost to
this bug before the fix landed are not recoverable** — the cascade delete was
real; re-check recently-edited coasters' credits by hand.

**Bug fixed: focus jumping to the Name field while editing coaster details.**
`Row`/`Field` were defined as inline component functions inside
`CoasterModal`'s render body, so they got a new function identity every
re-render — React treated that as a different component type and remounted
the whole form on every keystroke, and the Name input's `autoFocus` stole
focus back each time. Fixed by hoisting `Row`/`Field` to module scope.

**Favicon** changed to the 🎢 emoji (inline SVG data URI in `index.html`, no
binary asset needed).

**Coaster stats expanded: `heightFt`, `yearOpened`, plus real manufacturer/
model/material/style — re-scraped live for all 254 coasters.** Extends the
existing `fill-speeds` RCDB lookup (which already fetched each coaster's own
RCDB page for speed) to also parse the rest of that page's stats.
- **Schema:** `00000000000005` adds `height_ft` (numeric) + `year_opened` (int)
  to `coasters`.
- **Server (`server.js`):** new `parseRcdbStats()` extracts height (`<th>Height
  <td><span class=float>325</span> ft`), opening year (`Operating since <time
  datetime="2015-03-28">`), and the *real* manufacturer/model from a `Make:
  <a>Bolliger & Mabillard</a><br>Model: <a>All Models</a> / <a>Hyper
  Coaster</a>` header block — genuinely different markup from the park-listing
  page's material/design columns (which only ever gave Steel/Wood + Sit Down/
  Inverted, not brand names). `lookupSpeedFromRcdb` renamed `lookupStatsFromRcdb`
  and now prefers the coaster's already-known `rcdbUrl` (fetch directly) over
  re-running quick-search when available — faster and avoids occasional
  wrong-park mismatches. `/api/fill-speeds`'s "missing" filter broadened from
  "no speed" to "missing speed, height, year, or manufacturer".
- **Client:** `normalizeCoaster` gained `heightFt`/`yearOpened`; `applySpeeds`
  (kept its name despite the broadened scope) now merges all seven fields —
  speed/height/year always overwrite (single authoritative source, previously
  null), manufacturer/model/material/style only fill empties (won't clobber a
  hand edit or downgrade "B&M" to "Bolliger & Mabillard" for no reason). Coaster
  modal shows/edits Height and Year alongside the existing fields. UI copy
  relabeled "Fill speeds" → "Fill stats" to match the broadened scope.
- **Real bug found and fixed:** `speed_mph` was declared `int` in the original
  schema (migration 1, before any of this session's work), which silently
  worked for whole-number mph but rejected metric-sourced conversions like
  21.7 mph (`Math.round(kmh * 0.621371 * 10) / 10` — always one decimal place)
  with `invalid input syntax for type integer`. Took three diagnostic passes to
  isolate (kept misreading the error as a `height_ft` problem since the two
  values looked superficially similar) — confirmed via a direct `/api/fill-
  speeds` call against the live server showing the exact decimal `speedMph`
  going out. Fixed with `00000000000006`: `alter column speed_mph type numeric`.
- **Re-scrape run live** via `scripts/run-fill-speeds.mjs` (new — drives the
  running server's `/api/fill-speeds` endpoint directly from Node against real
  Supabase data, bypassing the browser/auth entirely; reusable for future
  re-runs). Final coverage across all 254 coasters: **speed 198, height 202,
  year 201, manufacturer 230, model 253, material 254, style 254** populated
  (the ~50 still missing speed/height/year are mostly RCDB pages that simply
  don't carry that particular stat, e.g. very old or kiddie rides). Verified
  live: Nitro's modal shows Top speed 80 mph, Height 230 ft, Opened 2001,
  Manufacturer B&M, Model Hyper — all from the real per-coaster RCDB page.

**Restored construction material/track-layout as `material` + `style`.** After
splitting `type` into manufacturer/model, the user asked to keep the
material/layout taxonomy too (e.g. "Steel" + "Sit Down") — it's genuinely
different information from manufacturer/model ("B&M" + "Hyper") and useful on
its own, not something to drop.
- **Schema:** `00000000000004` adds `material` (Steel/Wood/Hybrid) and `style`
  (Sit Down/Inverted/Suspended/Flying/Wing/…) columns to `coasters` — additive,
  doesn't touch `manufacturer`/`model`.
- **Backfill:** `scripts/backfill-material-style.mjs` derived both from the
  `model` field (which still holds the right source data — either the full
  original descriptor for non-manufacturer-matched coasters, e.g. "Steel Sit
  Down", or just the remainder for matched ones, e.g. "Hyper"/"Wooden"). Run
  live: **254/254 backfilled.** Material defaults to "Steel" when undetectable
  (the safe default — most coasters are steel) and "Wood" when the descriptor
  says so; style is invariably the model/descriptor value the material prefix
  was stripped from (or the descriptor itself when there's no material info).
- **Client:** `normalizeCoaster` gained a second independent fallback splitter
  (`splitMaterialStyle`, parallel to `splitManufacturerModel`) so a raw `type`
  string populates both manufacturer/model AND material/style simultaneously
  when present (e.g. RCDB import). Added to `MERGE_FIELDS`. The coaster detail
  modal shows/edits Material and Style as two more rows/fields alongside
  Manufacturer/Model; the dense Settings grid wasn't touched (still one
  combined "Type" text field — no room for two more grid columns).
- Verified live: Nitro (Six Flags Great Adventure) shows Manufacturer "B&M" /
  Model "Hyper" / Material "Steel" / Style "Hyper" correctly in the modal.

**Coaster `type` split into `manufacturer` + `model`.** `type` was one freeform
string conflating both (e.g. "B&M Inverted") — now two real fields throughout:
- **Schema:** two migrations — `00000000000002` adds `manufacturer`/`model`
  columns; `00000000000003` drops `type` (run in that order, with the backfill
  script in between, so the source data isn't destroyed before it's migrated).
- **Backfill:** `scripts/backfill-manufacturer-model.mjs` split every existing
  coaster's `type` via a known-manufacturer-prefix heuristic (longest-match
  against ~25 manufacturer names/abbreviations — B&M, Intamin, Vekoma, RMC, …).
  Run live: **254/254 coasters backfilled**, 57 matched a known manufacturer
  (e.g. "PTC Wooden" → PTC/Wooden), 197 left `manufacturer` blank with the full
  original descriptor preserved in `model` (most real data is RCDB's own
  "Steel Sit Down"/"Wood Sit Down"-style material+layout tags, not actual brand
  names — these legitimately have no manufacturer info to extract).
- **Client:** `normalizeCoaster` now takes `manufacturer`/`model` directly, with
  a `splitManufacturerModel()` fallback heuristic (same list as the backfill
  script — keep in sync) for any leftover/hand-typed `type` string. A
  `coasterType(c)` display helper (`[manufacturer, model].join(" ")`) keeps every
  existing table/grid render site working unchanged. The coaster detail modal
  got real separate Manufacturer/Model fields; the dense Settings add/edit grid
  rows (no room for a 9th column) kept one combined "Type" text input that
  splits via the same heuristic on save.
- **Caught and fixed a real bug before it shipped:** RCDB's *park-listing* page
  (used by "Look up coasters") only exposes construction material (Steel/Wood)
  and train layout (Sit Down/Inverted/…) in those two columns — NOT manufacturer/
  model, despite looking like it might be. An earlier version of this change
  mapped them directly to `manufacturer`/`model`, which would have written
  `manufacturer: "Steel"` for new RCDB imports. Reverted to route RCDB-import
  `type` strings through the same heuristic splitter as everything else, so
  unmatched values land in `model` (blank `manufacturer`) instead of corrupting
  it. Real manufacturer/model lives on RCDB's *per-coaster* page — see the next
  backlog item.
- Verified live: build clean, app loads with `type` column gone, the "Nitro"
  coaster at Six Flags Great Adventure shows Manufacturer "B&M" / Model "Hyper"
  correctly in both the detail modal and its edit form.

**`officialUrl` fixed/filled for all non-SF/CF parks** — using the new `family`
field to identify which parks aren't SF/Cedar Fair (`scripts/fix-non-sixflags-
urls.mjs`), replaced Hersheypark's incorrectly-stamped `sixflags.com` URL and
filled in the 8 parks that had none, with real official pages found via web
search: [Hersheypark](https://www.hersheypark.com/plan-your-visit/blog/plan-your-hersheypark-day-by-height-category),
[Busch Gardens Williamsburg](https://buschgardens.com/williamsburg/roller-coasters/),
[Knoebels](https://knoebels.com/faqs/rider-safety/),
[Universal Orlando](https://www.universalorlando.com/web/en/us/plan-your-visit/hours-information/ride-height-requirements)
(shared by Islands of Adventure / Universal Studios / Epic Universe),
[Nickelodeon Universe](https://nickelodeonuniverse.com/faq/),
[Jenkinson's Boardwalk](https://jenkinsons.com/rides/),
[iPlay America](https://www.iplayamerica.com/fun-and-games/amusement-rides/).
All 23 parks now have an `officialUrl`. These 9 still aren't auto-scrapable (only
SF/Cedar Fair pages carry the Algolia height index), but the "📏 Official height
chart" link in Parks detail now resolves to a real, relevant page instead of a
wrong or missing one. Verified live: Hersheypark's detail-header link now points
at the Hershey blog page instead of `sixflags.com`.

**Park `family` field (chain/ownership grouping)** — added a new `family` field
(distinct from the pre-existing freeform `badge`, which is still available for
one-off labels like "🏠 Home Park") to every park, surfaced as a small colored
chip (`PARK_FAMILIES` map: `SF`/`CF`/`UNI`/`SW`/`IND` with a label + color) in the
Parks left-nav list, the Parks detail header, and a new "Family" `<select>` in the
Settings ▸ Parks add/edit forms (`familySelect`). Populated for all 23 parks via
`scripts/add-park-family.mjs` based on real-world ownership (Six Flags entities →
`SF`; legacy Cedar Fair-branded parks, now under Six Flags Entertainment Corp post
2024-merger but still operating under their original names → `CF`; Universal/
NBCUniversal → `UNI`; Busch Gardens/SeaWorld → `SW`; independents — Hersheypark,
Knoebels, Nickelodeon Universe, Jenkinson's, iPlay America → `IND`), cross-checked
against queuetimes.com/parks groupings per the user's suggested source. Verified
live: chips render correctly in all three locations, and the Settings select
pre-populates from the saved value (e.g. Six Flags Great Adventure → `SF`).

**Top-bar pill deep-link + visited-parks-scoped totals** — the header rider pills
(`grandTotals.map` in [credit-tracker.jsx](../credit-tracker.jsx)) are now
`<button>`s; clicking one sets `view="credits"` and passes a `jump={{pivot:"rider",
riderId}}` prop into `CreditTracker`, which applies it via a `useEffect` (a fresh
object each click, so it fires even when re-jumping to the same rider already
selected). Both the pills and the By-rider strip now lead with a denominator scoped
to **parks the rider has actually visited** (`visitedParks = parks.filter(p =>
liveCoasters(p).some(c => ridden[r.id]?.has(ck(p.id,c.name))))`) — e.g. `58/77`
instead of `58/177` — with the all-parks total kept alongside (pill tooltip; strip
shows both: "58 of 77 eligible credits at parks visited · 58/177 across all 23
parks"). Verified live: clicking a pill lands on that rider's By-rider view with
the new strip copy rendering correctly.


Official-URL field · configurable Regions · Credits By-park/By-rider pivot ·
defunct flag · sortable tables · flattened Parks detail (Overview + rider lens) ·
`normalizeCoaster` enrichment funnel with alone-vs-accompanied heights (`✓*`) +
`speedMph` · Playwright official-height scraper · offline SVG Map view.

**Defunct rework + rider filters** — added `liveCoasters()`/`defunctCoasters()`
helpers; defunct now excluded from *all* counts/denominators (top bar, park nav,
rider nav, all-riders grid, By-rider strips & drawers, bulk select/clear) and no
longer rendered in any main table (Parks detail, By-park grid, By-rider main
list); the `DefunctBadge`/strikethrough survives only in Settings ▸ Parks. Each
By-rider park drawer now has a muted **"Defunct · historical"** sub-table (with a
`+N ridden` note) so pre-closure credits stay recordable outside the headline
`done/eligible`. Added **"Eligible only"** and **"Ridden only"** toggles to the
By-rider controls bar (combine with the existing park filter / status pills).

**Rider-height vocabulary** — single `RIDE_STATUS` source of truth for the four
states (alone `✓` / accompanied `✓*` / too short `✗` / unknown `?`): glyph, label,
legend phrase, and tooltip all derive from it. `Tick` renders from it, a reusable
`HeightLegend` sits under the Parks rider-lens table (tinted to the rider color),
and the inline hints now read consistently ("with an adult", "X" too short", "no
height on file yet").

**Backlog sweep** (everything tractable without external data):
- **Map name matching** — `normParkName()` (lower-case + unify apostrophe variants
  + collapse whitespace) drives a normalized `PARK_COORDS_BY_NORM` lookup, so a
  stored name with a curly vs straight apostrophe still lands on the map.
- **Credit-key migration on rename** — new `updateCoaster()` handler edits a
  coaster in place (no more delete+re-add) and, when the name changes, moves every
  rider's credit from `parkId|||oldName` to `parkId|||newName`. No more orphans.
- **`minAccompanied = 0` edge** — copy reads "any height with an adult"; the
  "X" too short" hint can't go negative (acc=0 always resolves to accompanied).
- **Unified height bands** — one `HEIGHT_BANDS` array drives both `minHtColor` and
  the Parks-detail stat cards (≤42 / 43-48 / 49-52 / 53+), closing the old 49-51
  gap and the badge-vs-card drift.
- **Unknown-height nudge** — Parks Overview subtitle shows "N missing a height
  (add in Settings ▸ Parks)" when live coasters lack a `min`.
- **Coaster height validation** — shared `validateHeights()` checks min 20–96,
  acc 0–96, and acc ≤ min, with inline errors on both the add and edit forms; acc
  inputs now allow 0.
- **Region-filter config** — `showRegion` derives from a per-view `region:` flag on
  `NAV` instead of an ad-hoc allow-list; Settings sub-tab renamed "Parks & Coasters"
  to disambiguate from the top-level Parks tab.
- **Persistent sort** — `useCoasterSort` saves the picked column/direction to
  `localStorage` so it survives reloads.
- **Backup & restore** — new Settings ▸ 💾 Backup tab: export the whole dataset
  (parks, coasters, riders, regions, credits) to JSON, or import one (with an
  explicit "this replaces all data" confirmation; coasters re-run `normalizeCoaster`).

**Accompanied height in the By-rider view** — the By-rider drawer height badge
shows the accompanied threshold `minAccompanied ?? min` with a trailing `*` when
it's the with-adult height (e.g. The Flash → `48"*`). The view stays a clean four
columns (name · type · height · ridden) — no separate eligibility-tick column; the
height itself carries the accompanied signal. The Parks rider-lens keeps the full
`✓ / ✓* / ✗ / ?` ticks + `HeightLegend` as the reference view. Data-gated: only
**8 of 252 coasters** have `minAccompanied` today, so the `*` is rare until more
heights are populated — see *Deferred* ("By-rider height column…" + batch scrape).

**Accompanied-height column** — shared amber `AccBadge` adds a dedicated "w/ adult"
column (`minAccompanied` or muted `—`) to Parks detail (Overview + rider lens), the
Credits By-park grid, and the By-rider drawers (now with a column header; the single
`X"*` badge is replaced by explicit alone + accompanied columns). Grid templates +
the By-park `minWidth` widened for the new track.

**Per-rider "needs companion" flag** (informational) — a `needsCompanion` checkbox in
Settings ▸ Riders surfaces a "needs an adult for ✓*" reminder on the By-rider strip,
the Parks rider-lens subtitle, and the rider list. Per the agreed semantics it does
**not** change counts (`✓*` rides stay eligible for everyone).

**Coaster import = delta merge** — `mergeCoasters(existing, incoming)` reconciles by
**RCDB id first**, then a punctuation/trademark-insensitive normalized name
(`normCoasterName` collapses `:` `™` `®` etc.): matches fill only *empty* fields
(type, heights, speed, scale, status, rcdb refs) and never clobber hand-entered
values; only truly-new coasters are appended; existing names are preserved so credit
keys stay valid. `handleImport` shows a **"N new · M merged · K unchanged" review
panel** before applying via `mergeImportCoasters`. Verified: re-importing Carowinds
produced **zero duplicates** (rcdbId/name dedupe confirmed via unit + live tests).

**Scrape name-matcher upgrade + RCDB re-seed of non-visited parks** — fixes the
"RCDB names ≠ official-height-page names ≠ seed names" mismatch. `normName` (server)
now strips *all* punctuation/trademark symbols, and a `fuzzyNameMatch` second pass
bridges filler-word differences via stopword-containment ("Apocalypse" ↔ "Apocalypse
the Ride", `THE RIDDLER™'s Revenge` ↔ "Riddler's Revenge") — while **never** matching
racing pairs ("Racer Red" vs "Racer Blue") or true renames ("Revolution" vs "New
Revolution"). `matchScrapeToPark` returns `scrapedName` + `fuzzy` per match; the
per-park and batch review panels show an amber `≈ official-name` flag on approximate
matches. Validated: Magic Mountain re-scrape went 9 → 15 matched. Used it to **wipe
the bad seed data and re-seed all 6 non-visited parks** (Magic Mountain, Kings Island,
SF Great America, Over Georgia, Over Texas, Fiesta Texas) from their RCDB rosters —
clean canonical names + `rcdbId` on every coaster, heights re-filled by the upgraded
scrape (residual abbreviations recovered from the pre-reseed backup). *Visited parks
(any with credits) were left untouched* so no credit keys orphaned. Two genuinely-new
coasters (Shock Wave / Werewolf Gorge) remain height-unknown (`?`) — not on the
official page, no seed value to recover, left rather than fabricated. **Note:** RCDB
models a racing coaster as one entry, so Kings Island's seed "Racer (Red)/(Blue)"
collapsed to a single "Racer" (no credits lost — KI is non-visited — but the dual-
track credit split is gone; re-add by hand if wanted).

**Batch scrape all parks** — `/api/scrape-all-heights` (SSE, shares the single-park
scrape's `scrapeRunning` lock + `matchScrapeToPark` helper) streams per-park results
over every park with an `officialUrl`; the client accumulates a combined review panel
(grouped by park, with failures) and applies all approved changes at once via a new
name-keyed `applyScrapedHeights` handler (stamps `heightSource:"official"`). Verified
against the live network — 3 URL'd parks scraped, matches confirmed, the one bad URL
(Hersheypark) surfaced as a failure rather than crashing the run.

**Coaster detail modal (view ▸ edit)** — the app's first reusable modal primitive.
Clicking a coaster *name* in the Parks detail table, the Credits By-park grid, or
the By-rider drawers opens a centered `CoasterModal` (backdrop/Esc close, body
scroll-lock) showing every field — alone/accompanied heights (accompanied as
`X"*`, e.g. The Flash → `48"*`), speed, type, racing/defunct, and provenance
(`rcdbUrl`/`rcdbId`, `heightSource`, `scale`, `status`). A toggle flips to an edit
form; Save funnels through the shared `updateCoaster` (in-place edit + credit-key
migration on rename) and `validateHeights`, so it can't drift from the Settings
inline editor. Modal state lives in `App` (`{parkId, coasterName}`, coaster derived
live from `parks`); clicking only the name keeps the credit circles independent.

**Design system sweep** (completes the foundation below — token coverage across
every primary surface):
- **Tablet breakpoint** raised 760→820px so tablet-portrait (768) stacks the nav
  instead of keeping a cramped 260px column (verified: 768 stacks/no overflow,
  900 side-by-side).
- **Ultrawide cap** — new `.ct-content` class (`max-width: var(--content-max,
  1160px)`, `margin-inline:auto`) on the three flex:1 scroll panels (Parks detail,
  Credits By-park, By-rider); content centers at ≤1160px on wide monitors instead
  of stretching to an unreadable line length (verified at 1900px → 1160px centered).
- **Per-component token sweep** — migrated the inline numbers/colors onto `T` +
  `labelCss` across: shared atoms (`HtBadge`/`DefunctBadge`/`Tick`/`CreditBtn`/
  `HeightLegend`/`SortTh`), top bar + NAV + settings sub-nav + region filter,
  both Credits left navs + the Parks left nav, the all-riders grid (header + rows),
  the Parks detail (header/lens/stat cards/table), the By-rider strip/controls/
  drawers, and the Settings forms (`ManageRiders`/`ManageRegions`/`ManageParks`
  incl. the coaster editor). Added a shared `fieldLabelCss` for form field labels
  and folded the repeated input/panel/cancel-button chrome onto tokens. Semantic
  status colors (green/amber/red/violet) and the map's geographic hues stay literal
  by design.

**Design system & responsive pass** (foundation + key surfaces):
- **Design tokens** — `T` object (spacing `s1-s8`, type `fxs-f2xl`, radius
  `r1-r5`, weights, dark-theme color roles) + mirrored CSS variables in
  `index.html`; shared `labelCss` for uppercase micro-labels.
- **Responsive shell** — `.ct-split` / `.ct-sidenav` / `.ct-hscroll` classes +
  `@media (max-width:760px)`: the 260px left navs collapse to a full-width,
  height-capped scrolling strip, the all-riders grid scrolls horizontally, the
  top bar wraps. Verified at 375 (no horizontal overflow) and 1280 (unchanged).
- **Theme refinement** — every 9px font bumped to the 10px legible minimum;
  `StatCard` and the By-rider rider strip moved onto tokens; the strip now shows
  a prominent height chip and clarifies that "eligible" counts `✓*` with-adult
  rides (or prompts to set a height when missing).
