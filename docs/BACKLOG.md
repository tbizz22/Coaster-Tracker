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

**Done (Phases 0–1, verified live):** schema + RLS migration pushed to the Supabase
project; `credit-tracker.jsx` persistence rewritten to talk to Supabase directly
(`loadHouseholdData`/`saveRiders`/`saveParks`/`saveSettings`/`saveRiderCredits`); a
minimal email/password `AuthGate` wraps `<App/>` (`src/AuthGate.jsx`); the real
`data/*.json` (5 riders, 23 parks, 254 coasters, 342 credits) imported into the
household via `scripts/import-json-to-supabase.mjs`; `server.js` trimmed to a
stateless scraper service — `fill-heights`/`fill-speeds`/`scrape-heights`/
`scrape-all-heights` no longer read `data/parks.json` off disk, they take the
caller's current parks data via POST body (client drives the SSE ones with a new
`postSSE()` fetch+stream helper since `EventSource` can't POST). End-to-end verified
in-browser: park/coaster data loads from Supabase, a credit toggle persisted through
a reload, and the batch-scrape SSE stream runs to completion (`start` → per-park
`park` results with real scraped heights → `done`). One real bug caught and fixed in
this pass: the SSE endpoints tracked client-disconnect via `req.on("close")`, which
fires as soon as Express finishes reading the POST body — not when the client
actually disconnects — so it flipped `aborted` true right after the first message and
silently killed the stream. Switched to `res.on("close")`. Dead code removed:
`DEFAULT_PARKS`/`DEFAULT_RIDERS` hand-seed fallback data (no longer reachable now
that load always goes through Supabase).

**Phase 2 security pass — done (verified live):** signed into a second real account
in-browser (a fresh signup, distinct from the household above) and confirmed the app
shows **0 parks · 0 credits** — none of the first household's 23 parks / 250 credits
were visible, and `handle_new_user()` gave the new account its own empty household as
designed. RLS is correctly isolating households. Also added Settings ▸ Account (signed-
in email + Sign out button, `AccountSettings` in `credit-tracker.jsx`) — closes the
"no account/session management UI" gap below; sign-out verified live (returns to the
`AuthGate` sign-in screen via its `onAuthStateChange` listener).

**Phase 3 (deploy) — done, live in production:** SPA deployed to Vercel
(`https://coaster-tracker-gray.vercel.app`), scraper service deployed to Render as a
Docker web service (`https://coaster-tracker.onrender.com`, built from the repo's
`Dockerfile` — Playwright's own base image, so headless Chromium for
`scrape-heights.js` is already present). `credit-tracker.jsx`'s `apiGet`/`postSSE`/
scrape-heights fetch all go through `API_BASE` (`import.meta.env.VITE_SCRAPER_URL`,
empty in dev so the Vite proxy still works); `server.js` got `cors` (gated by
`FRONTEND_URL`) and reads `PORT` from the environment instead of hardcoding 3001.
Verified live end-to-end: the deployed bundle has the real Supabase URL and the
Render scraper URL baked in; Render's CORS preflight correctly returns
`access-control-allow-origin: https://coaster-tracker-gray.vercel.app` for that
origin and nothing for an unrelated test origin (scoped, not wide-open). The repo
is on GitHub (`tbizz22/Coaster-Tracker`) — checked the pushed commit for secrets/PII
before confirming it was safe: no `.env`, no `data/*.json` (real family data), no
Supabase keys or tokens anywhere in tracked files. One real bug found and fixed
during this rollout: `VITE_SCRAPER_URL` on Vercel was initially set to a placeholder
hostname from the setup instructions (`coaster-tracker-scraper.onrender.com`, which
doesn't exist) instead of the real deployed one — surfaced in the browser as a CORS
error on the preflight, but the actual cause was Render's edge returning a plain 404
(`X-Render-Routing: no-server`) for an unregistered hostname, not a CORS
misconfiguration. Fixed by correcting the env var to the real Render URL and
redeploying; batch scrape confirmed working live afterward.

**Phase 4a (mobile-style UI redesign) — done, live in production.** Ahead of
PWA installability, the app gained a purpose-built mobile experience (desktop
stays as the dense, data-rich layout): a new **Plan mode** (per-park "where
should we go" view — every rider's avatar always shown, greyed when too short,
amber "A"-badged when accompanied-only, collapsed to a single effective height
threshold instead of separate min/accompanied numbers) and **Log mode** (the
same view, but tapping a rider's avatar toggles that credit — the post-visit
counterpart to Plan). Below 640px the top tab strip becomes a fixed LogRide-
style bottom tab bar, the always-visible rider pills collapse into a tap-to-
open popover, and Settings sub-nav/region filter scroll horizontally instead of
wrapping. Park/coaster editing is now reachable inline from Plan mode ("✎ Edit
park", scoped to just that park via `ManageParks`'s new `lockToParkId` prop) —
Settings ▸ Parks & Coasters is hidden on mobile (desktop keeps it as-is).

**Not yet done:** Phase 4b (PWA manifest/installability), Phase 5
(sharing/native). A few smaller account-creation UX rough edges remain — see
the dedicated subsection below.

**Cleanup follow-up:** `data/*.json` (riders/parks/settings/credits + the
`.backup-*` files) are now inert — nothing reads or writes them anymore. Left in
place as a known-good snapshot of the pre-migration state rather than deleted
outright. Once Supabase has been the system of record for a while with no
surprises, these can be deleted (or moved out of the repo into a one-time archive).

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

- ~~**Batch "scrape all parks"**~~ **Done** (see Done section) — `/api/scrape-all-heights`
  SSE endpoint streams every `officialUrl` park; Settings ▸ Parks shows a combined
  review panel (per-park grouped changes + failures) with one "Apply all N updates"
  button. **Run-and-verified:** the 3 parks that had URLs at the time scraped clean
  (Canada's Wonderland + SF Great Adventure already had their heights; Hersheypark's
  URL was wrong at the time → reported as a failure, since fixed — see the next item).
- ~~**`officialUrl` coverage — mostly done for SF/CF; remaining = non-SF/CF parks.**~~
  **Done** (see Done section) — all 23 parks now have an `officialUrl`. SF/Cedar
  Fair parks (12) point at their `sixflags.com` attractions page (scrapable); the
  9 non-SF/CF parks now point at the real park-specific height/ride pages found via
  web search, using the `family` field to identify and fix the wrong one
  (Hersheypark's stray `sixflags.com` URL). These 9 aren't scrapable (the Algolia
  scraper only reads SF/Cedar Fair pages) but the "📏 Official height chart" link
  in Parks detail now points somewhere real for manual lookup — see the non-Six-
  Flags accompanied-heights item below for the still-open scraping gap.
- ~~**Speeds.**~~ **Done** — `speedMph` fills from RCDB via `POST /api/fill-speeds`
  (quick-search + park-name disambiguation; see `server.js`/`lookupSpeedFromRcdb`).
  See the new **"Expand coaster data model: structure height, year, manufacturer,
  model"** item below for the rest of RCDB's physical stats, which are still
  unpopulated.
- **Accompanied heights for non-Six-Flags parks** (Knoebels, Hersheypark,
  Universal, …). *Deferred:* the Playwright scraper only covers Six Flags / Cedar
  Fair pages; no source for the others — manual entry only.
- ~~**Split coaster `type` into `manufacturer` + `model`.**~~ **Done** (see Done
  section) — schema migration + data backfill + full UI/scraper-mapping update.
- ~~**Restore construction material/track-layout as its own fields.**~~ **Done**
  (see Done section) — `material` (Steel/Wood/Hybrid) + `style` (Sit Down/
  Inverted/Suspended/…), the data the park-listing page actually has, kept as a
  separate axis from manufacturer/model rather than collapsed back into one.
- ~~**Expand coaster data model: structure height, year (opened).**~~ **Done**
  (see Done section) — `heightFt`/`yearOpened` added, real manufacturer/model
  now sourced from each coaster's own RCDB page (not the park-listing page),
  and the whole RCDB stats fetch re-run live against all 254 coasters.
- ~~**By-rider height column should show the accompanied height (`X"*`).**~~
  **Implemented + largely populated.** The badge shows `minAccompanied ?? min` with a
  `*` for the with-adult threshold. After the batch scrape, **39** coasters across 13
  parks carry `minAccompanied` (up from 8) — every SF/Cedar Fair park is now covered.
  The only gap left is the **non-SF/CF parks** (Universal, Knoebels, Hersheypark, …),
  which the scraper can't read — see the `officialUrl` item above + the non-Six-Flags
  accompanied-heights item below.
- **Per-rider "needs companion" default** (also in Nice-to-haves). *Deferred:*
  needs a product decision on what it does to counts — accompanied (`✓*`) rides
  currently count as eligible for everyone; whether a flagged rider should treat
  them differently is the open question. Ask the owner before building.
- **Credit history / dates** — record *when* / *how many times* a coaster was
  ridden instead of a boolean. *Deferred:* a data-model change best done alongside
  the web-platform DB migration (credits become FK rows there anyway).
- **Real tile map (optional upgrade).** Swap the offline SVG for Leaflet/MapLibre
  for pan/zoom + street context. *Deferred:* explicitly optional and conflicts
  with the offline-first goal (adds deps + network tiles).

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

## Data tables: dedicated accompanied-height column

~~Requested revision~~ **Done** (see Done section). Every wide data table now has a
dedicated **"w/ adult"** column next to `Min`, rendering the `minAccompanied` value
in an amber `AccBadge` (or a muted `—`). Added to Parks detail (Overview + rider
lens), the Credits By-park grid, and the By-rider drawers (which gained a column
header and now show alone + accompanied as two explicit columns instead of the
single `X"*` badge). The per-rider eligibility tick stays as the eligibility signal.

## Desktop park-detail table: redesign (user feedback)

User feedback on the current Parks ▸ detail table (the per-rider stat-chip row +
data table), captured for the desktop "hardened, more data/insights" pass —
**not yet started, this is notes for when that work begins**:

- **Stat chips are inconsistent and mostly not useful.** The row of summary chips
  (coaster counts by min-height band, unknown count, "rider can ride" count) uses
  different colors for what's conceptually the same kind of data, which reads as
  arbitrary rather than meaningful. Of the whole row, only the **"[Rider] can
  ride: N"** chip was called out as genuinely useful — the height-band breakdown
  chips should be redesigned or dropped rather than carried forward as-is.
- **Type column is too verbose, and should split + abbreviate.** The combined
  "Manufacturer Model" free-text column reads as one long string. Wants its own
  dedicated column (separate from name), and manufacturer names should always use
  common industry abbreviations (B&M, RMC, GCI, PTC, etc.) instead of full names.
- **Add a ride photo/thumbnail**, ideally without self-hosting images. Likely
  approach: extend the existing Wikipedia lookup (already used for height
  fill-ins) to also pull the infobox image URL and store just the URL — Wikimedia
  Commons images are freely licensed and safe to hotlink with attribution. Falls
  back to a placeholder when a coaster has no Wikipedia image. (RCDB also has
  photos, but scraping/hotlinking those is more ToS-questionable than Wikipedia's
  API.)
- **Legend row should be a hover/tooltip on desktop, not always-on screen.** The
  "✓ Can ride · ✓\* With an adult · ✗ Too short · ? Height unknown" key currently
  sits permanently on the page; move it behind a small "ⓘ" affordance instead.

## Clean up the minimum-rider-height experience

**Done.** Vocabulary + legend (single `RIDE_STATUS` source of truth), the
backlog-sweep items (unknown-height nudge, Min/Acc validation, unified
`HEIGHT_BANDS`), the dedicated accompanied-height column (above), and the
**per-rider "needs companion" flag** (informational, per the agreed
counting-semantics decision — `✓*` rides still count as eligible). The flag is a
checkbox in Settings ▸ Riders that surfaces a "needs an adult for ✓*" reminder on
the rider's By-rider strip, the Parks rider-lens subtitle, and the rider list — it
does **not** change any counts.

## IA / UX (from INFORMATION-ARCHITECTURE.md §8)

- ~~**Coaster detail modal (view ▸ edit).**~~ **Done** (see Done section) — clickable
  coaster names in Parks detail, the By-park grid, and the By-rider drawers open a
  centered `CoasterModal` showing full details + provenance, with a toggle into an
  edit form that saves through the shared `updateCoaster` + `validateHeights`.

- ~~**Coaster import = delta merge, not duplicate-append.**~~ **Done** (see Done
  section). The lookup import now runs `mergeCoasters(existing, incoming)` (match by
  normalized name, fill only empty fields, never clobber, append only truly-new),
  shows a **"N new · M merged · K unchanged" review panel** before applying, and
  preserves existing names so credit keys stay valid. Verified: re-importing
  Carowinds enriched 11 existing coasters in place + added the genuinely-missing
  ones, with **zero duplicates** (12 → 14, not 26).
  - **Dedupe key (fixed):** `mergeCoasters` now matches on **`rcdbId` first**
    (stable across name/punctuation/marketing changes), falling back to a normalized
    name that collapses all punctuation + trademark symbols (`:`, `™`, `®`, …) — so
    "Batman: The Ride™" matches "Batman The Ride". The two App-side scrape/speed
    apply handlers use the same `normCoasterName`.
  - *Follow-up (resolved):* both the **scrape** matcher (`fuzzyNameMatch`, `server.js`)
    and the **import** `mergeCoasters` (`fuzzyCoasterMatch`, `credit-tracker.jsx`) now
    apply the same stopword-containment fuzzy pass — match priority is **RCDB id →
    exact normalized name → filler-word fuzzy**. So a first-time `"Flying Cobras"` now
    merges into `"The Flying Cobras"` instead of duplicating (verified), while racing
    pairs and true renames still never match. True renames/removals remain surfaced as
    "new" rather than auto-applied — no auto-delete.
  - <details><summary>original spec</summary>

  When adding a new park or re-running "Look up coasters online" / a scrape against a
  park that already has coasters, the import must **reconcile against the existing
  list** instead of blindly appending — a **delta update keyed by normalized name**:
  - **Match existing** coasters by normalized name → **merge, don't duplicate**:
    fill in only *missing/empty* fields (e.g. `type`, `scale`, `status`, `rcdbId`/
    `rcdbUrl`, and heights when blank) and **never clobber** hand-entered values
    (especially `min`/`minAccompanied`, `racing`, `defunct`). A field-level merge.
  - **Only truly-new** coasters (no name match) get appended as new rows.
  - **Surface the delta** in the import/review UI before applying: "N new · M merged
    (updated fields) · K unchanged" so the user sees what will change, mirroring the
    scrape review panel. Optionally flag existing coasters *not* present in the new
    source (possible renames/removals) without auto-deleting.
  - **Preserve credits.** Merging must keep the credit key stable (`parkId|||name`);
    if a merge would rename, route it through `updateCoaster` so credits migrate.
  - Applies to all three intake paths: new-park creation, the RCDB/Wikipedia
    "look up coasters" import, and (already partly handled) the height scrape apply.
  - **Where to build it:** a shared `mergeCoasters(existing, incoming)` reconciler
    that all three paths call, returning `{ added, merged, unchanged }` for the
    review UI; wire `handleImport` and the new-park flow through it.
  </details>

- ~~**Top-bar rider pills → By-rider view (deep link).**~~ **Done** (see Done
  section) — pills are now `<button>`s; clicking one jumps to Credits ▸ By rider
  with that rider selected.

- ~~**By-rider: credits vs. eligible at parks actually visited.**~~ **Done** (see
  Done section) — both the top-bar pills and the By-rider strip now lead with a
  visited-parks-scoped figure, with the all-parks total alongside it.

- ~~**Rethink the park `badge` abbreviation system.**~~ **Done** (see Done
  section) — added a new `family` field (kept separate from `badge`, which stays
  available for one-off labels like "🏠 Home Park") populated for all 23 parks.

## Nice-to-haves

- **Credit history / dates** — moved to *Deferred* (data-model change; pairs with
  the DB migration).
- *(per-rider "needs companion" → Deferred · export/import → Done)*

---

## Done (this build) — for reference

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
