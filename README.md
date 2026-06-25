# 🎢 Coaster Tracker

A web app for tracking roller-coaster **credits** (which rider has ridden
which coaster) across theme parks, plus per-rider **height eligibility** and a
geographic **map** of the parks. One login owns a **household** of riders, parks,
and credits — data is private to that household (enforced by Supabase RLS).

Built for a family of riders of differing heights — including the
"can ride only with an adult" case (e.g. a 39" rider) — so the app distinguishes
*ride-alone* from *accompanied* height limits.

**Live:** [coaster-tracker-gray.vercel.app](https://coaster-tracker-gray.vercel.app)
(SPA on Vercel) · scraper service on Render at `coaster-tracker.onrender.com` ·
source on GitHub at [`tbizz22/Coaster-Tracker`](https://github.com/tbizz22/Coaster-Tracker).

---

## Quick start

Requires **Node.js** (with `node` / `npm` on PATH) and a **Supabase** project
(free tier is fine — see `supabase/migrations/` for the schema).

```bash
npm install
npx playwright install chromium   # one-time: needed only for the official-height scraper
cp .env.example .env               # fill in your Supabase project URL + anon key
npm run dev
```

`npm run dev` runs two processes via `concurrently`:
- **Vite** dev server (UI) → http://localhost:5173
- **Express** scraper service (`server.js`) → http://localhost:3001 (proxied by Vite)

Open http://localhost:5173, sign up (creates your household), and you're in.

> All household data (riders, parks, coasters, credits, regions) lives in
> **Supabase Postgres**, scoped to your household by Row-Level Security — the
> client talks to it directly via `src/supabaseClient.js`. `server.js` holds
> **no data of its own**: it's a stateless scraper service (RCDB/Wikipedia/
> official-height lookups) that takes your current parks data in the request
> and returns proposed updates for the client to apply.

---

## What you can do

| Tab | Purpose |
|---|---|
| **🎢 Parks** | Opens on an offline **map** of the parks (region-colored markers sized by coaster count). Click a marker — or a park in the left list — to open that park's coasters. A small colored chip shows the park's **family/chain** (`SF` Six Flags, `CF` Cedar Fair-branded, `UNI` Universal, `SW` SeaWorld/United Parks, `IND` independent) next to its airport-code tag. Tables show both the ride-alone **Min** and a dedicated **w/ adult** (accompanied) height column. The detail defaults to a neutral **Overview**; pick a rider in the inline **View** control to see their height eligibility (`✓` can ride alone, `✓*` only with an adult, `✗` too short). Click any coaster **name** to open a detail modal (toggle into edit mode to update it). "← Back to map" returns to the overview. |
| **✓ Credits** | Mark who has ridden what. **Pivot** the left nav **By park** (all-riders × coasters grid, bulk toggles) or **By rider** (one rider's credits across every park, with **Eligible only** / **Ridden only** filters and a muted "Defunct · historical" sub-table per park). Both pivots show the alone + accompanied height columns; click a coaster name for its detail modal. The top-bar rider pills are clickable — they jump straight to that rider's By-rider view — and lead with a denominator scoped to **parks the rider has actually visited** (the all-parks total is kept alongside it). |
| **⚙ Settings** | Manage **Parks & Coasters** (+ heights, defunct flag, official-URL, RCDB import with **delta merge** (no duplicates), height auto-fill, per-park **official-height scrape**, **batch scrape all parks**, and **fill speeds/height/year/manufacturer/model/material/style from RCDB**), **Riders** (incl. a per-rider "needs an adult for ✓*" flag), **Regions**, **💾 Backup** (export/import the whole dataset as JSON), and **👤 Account** (signed-in email + sign out). |

Key concepts: **credit** = a rider has ridden a coaster (unit of progress);
**eligible** = the rider meets the height limit (alone or accompanied) and the
coaster is operating; **defunct** coasters still count as credits but are excluded
from eligible/available denominators; `min == null` = unknown height (renders `?`).

---

## Architecture

Single-page React 18 UI (`credit-tracker.jsx`, one file) talks to **Supabase**
(Postgres + Auth + RLS) directly for all persistence, plus a small stateless
Express service (`server.js`) for scraping (RCDB/Wikipedia/official-height
pages — things that can't run inside Supabase).

```
credit-tracker.jsx   UI: data, helpers (normalizeCoaster, mergeCoasters, CoasterModal),
                     persistence (loadHouseholdData/save* — talk to Supabase),
                     components (ParksTab [list + map/detail], CreditTracker,
                     ManageParks/Riders/Regions/AccountSettings, App)
src/supabaseClient.js  Supabase client singleton (anon key only)
src/AuthGate.jsx     Email/password sign-in/sign-up screen wrapping <App/>
server.js            Stateless scraper service: RCDB scrape/speeds + Wikipedia
                     height-fill + per-park & batch official-height scrape (all SSE);
                     every endpoint takes the caller's current parks data in the
                     request and returns proposed results — it persists nothing
scrape-heights.js    Playwright scraper for Six Flags / Cedar Fair official heights
Dockerfile           Builds the scraper service for deployment (see "Deployment")
vercel.json          SPA build config for Vercel
supabase/migrations/ Schema + RLS policies (households/riders/parks/coasters/credits)
scripts/import-json-to-supabase.mjs   one-time importer from the old data/*.json files
docs/INFORMATION-ARCHITECTURE.md   sitemap, IA patterns, data model (read this!)
docs/BACKLOG.md      future ideas / TODOs
```

### Data model (Supabase Postgres)
| Table | Shape |
|---|---|
| `households` / `household_members` / `profiles` | account → household mapping; RLS keys off membership |
| `regions` | `{ household_id, code, name, sort }` |
| `riders` | `{ id, household_id, name, height, color, needs_companion, sort }` |
| `parks` | `{ id, household_id, name, tag, region_code, badge, family?, official_url, lat, lng, sort }` |
| `coasters` | `{ id, park_id, name, manufacturer, model, material, style, min, min_accompanied, speed_mph, height_ft, year_opened, racing, defunct, rcdb_id, rcdb_url, scale, status, height_source, sort }` |
| `credits` | `{ rider_id, coaster_id }` — presence = ridden (real FK row, not a string key) |

`riders`/`parks`/`coasters` use client-generated text ids (the app's `uid()`
scheme) rather than server-generated uuids, since `credit-tracker.jsx`'s
save\* functions are fire-and-forget upserts of the full current array — the
id has to be known client-side at insert time. Every table is RLS-protected;
the client uses only the **anon key** (never the service-role key).

### Coaster (canonical shape)
Every seeding path (hand-seed, RCDB import, official scrape, manual add/edit)
funnels through `normalizeCoaster()` so records share one schema:

```js
{ id, name, manufacturer, model, material, style, min, minAccompanied, speedMph, heightFt?, yearOpened?, racing?, defunct?,
  rcdbId?, rcdbUrl?, scale?, status?, heightSource? }
```
- `min` — minimum height to ride **alone**
- `minAccompanied` — minimum height **with a supervising companion**
  (null = none posted; `0` = no minimum when accompanied)
- A rider is *eligible* if they meet either; accompanied-only rides get a `✓*`.

### Key API endpoints (`server.js` — scraper only, stateless)
| Endpoint | Purpose |
|---|---|
| `GET /api/lookup-coasters` | RCDB park-page scrape (import coasters) |
| `POST /api/fill-heights` (SSE, body `{ parks }`) | best-effort height fill from Wikipedia |
| `POST /api/scrape-heights` (body `{ park }`) | headless-browser scrape of a park's official attractions page → authoritative alone/accompanied heights (review & apply in the UI) |
| `POST /api/scrape-all-heights` (SSE, body `{ parks }`) | batch scrape — runs the official-height scrape over every park with an `officialUrl`, streaming per-park results to a combined review panel |
| `POST /api/fill-speeds` (SSE, body `{ parks }`) | resolve speed/height/year/manufacturer/model/material/style from each coaster's own rcdb.com page (prefers the known `rcdbUrl`, else quick-search + park-name disambiguation; review & apply) |

The SSE endpoints are POST (parks data has to go somewhere), so the client
drives them with a small `postSSE()` fetch+stream-reader helper instead of
`EventSource` (which can only GET).

See **`docs/INFORMATION-ARCHITECTURE.md`** for the full sitemap, IA patterns,
and design rationale.

---

## Deployment

The SPA and the scraper service deploy **separately** (different runtimes — the
scraper needs Playwright's headless Chromium, the SPA is a static build) and talk to
each other over plain HTTPS, not a proxy:

1. **Scraper service** (`server.js`) — build the included `Dockerfile` (based on
   `mcr.microsoft.com/playwright`, so headless Chromium is already there) and deploy
   it to any container host (Render, Railway, Fly.io). Set `FRONTEND_URL` to the
   SPA's deployed origin (comma-separated if more than one) so CORS only allows your
   own frontend. The host should set `PORT` itself — `server.js` reads it from the
   environment automatically.
2. **SPA** (`credit-tracker.jsx` + Vite) — deploy to Vercel/Netlify (`vercel.json` is
   included; build command `npm run build`, output `dist`). Set the env vars:
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` — same as local dev
   - `VITE_SCRAPER_URL` — the scraper service's deployed URL (step 1). Leave unset
     only in local dev, where the Vite proxy handles `/api` instead.
3. **Supabase** — no separate deploy step; the cloud project you've already been
   using *is* production. (If you want a staging environment, that's a second
   Supabase project + its own `.env`.)

There's no CI/build step that needs the scraper at SPA-build-time — the two only
talk to each other at runtime, via `VITE_SCRAPER_URL`.

---

## Notes / gotchas

- **server.js changes require a restart** — Vite hot-reloads the UI (and Supabase
  schema/data changes need nothing at all, just a refetch), Express does not.
- **Heights are hard to source reliably.** Wikipedia rate-limits and is often
  inaccurate; RCDB carries physical stats but not rider-height policy. The
  authoritative source is the parks' own Six Flags / Cedar Fair attractions pages
  (`scrape-heights.js`), which embed an Algolia index with `minHeightAlone` /
  `minHeightAccompanied`. Default new-coaster height is `null` (unknown), filled
  deliberately rather than guessed.
- **Three name sources disagree:** RCDB (our display names), the official
  attractions page (where heights live), and old hand-seed names. The scrape matcher
  (`normName` + `fuzzyNameMatch` in `server.js`) strips punctuation/trademark symbols
  and bridges filler-word differences ("Apocalypse" ↔ "Apocalypse the Ride") so
  heights attach to RCDB-named coasters — but it deliberately won't match racing
  pairs or true renames, which surface as unmatched for manual handling.
- **Credits are a real `credits(rider_id, coaster_id)` row**, not a name-based
  string key — renaming a coaster can never orphan a credit, because nothing about
  a credit references the coaster's name. (The UI still derives an in-memory
  `parkId|||coasterName` key for the `ridden` Set/lookup convenience —
  `ck()`/`saveRiderCredits()` in `credit-tracker.jsx` — but that's a display-layer
  detail resolved against the current `coaster.id` at every save, not the source
  of truth.) The import **delta merge** (`mergeCoasters`) still preserves existing
  names so a re-import doesn't churn that in-memory key for no reason.
- **Coaster import is a delta merge, not an append.** Re-running "Look up coasters"
  or importing into a park that already has coasters **dedupes on RCDB id first**
  (stable across name/punctuation changes), falling back to a normalized-name match
  that ignores punctuation and trademark symbols (`:`, `™`, `®`, …). It fills only
  empty fields (never clobbering hand-entered values) and appends only genuinely-new
  coasters — shown in a "N new · M merged · K unchanged" review before applying.
  (A leading `"The "` is still a meaningful word, not punctuation, so a first-time
  name like "Flying Cobras" vs "The Flying Cobras" can still differ until one import
  stamps the shared rcdbId — see backlog.)
