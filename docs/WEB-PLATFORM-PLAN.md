# Coaster Tracker → Web Platform (DB + Auth + Mobile-ready)

> Status: **Phases 0–3 done and live in production.** See `docs/BACKLOG.md` for
> current status, what was actually built/verified, and bugs found along the way.
> This doc is kept as the original plan record — phase descriptions below were
> written before implementation and are mostly historical; Phase 4 (PWA) and
> Phase 5 (sharing/native) remain the open roadmap.

## Context

Coaster Tracker today is a **single-user, local-first** app: a Vite/React single-file
UI (`credit-tracker.jsx`) talks to an Express server (`server.js`) that reads/writes
plain JSON files in `data/` (`riders`, `parks`, `settings`, `credits/<riderId>`). There
is **no database, no authentication, and no concept of separate accounts** — it only runs
on one machine for one family.

The goal is a new direction: **web-accessible, multi-user, secure, and eventually
installable on mobile.** Per the agreed decisions:

- **Account model:** *Household account* — one user logs in and owns a household that
  contains riders (still data/profiles, not logins), parks, coasters, and credits.
  Multi-user-per-household (invites/roles) is a later phase.
- **Platform:** *Supabase* — managed Postgres + Auth + Row-Level Security (RLS). The
  React client talks to Supabase directly; a small Node service keeps the
  Playwright/RCDB/Wikipedia scrapers (which can't run inside Supabase).
- **Mobile:** *Web-first, PWA later* — reuse the current React UI; add installability
  and responsive cleanup as a later phase. React Native stays a future option that would
  share the same Supabase backend.

Outcome: the same feature set, but reachable from any browser, with isolated and secure
per-household data, on a foundation that a native app can later plug into.

---

## Target architecture

```
React SPA (current UI)  ──auth + data──▶  Supabase
  @supabase/supabase-js                   ├─ Postgres (relational schema, RLS)
                                          ├─ Auth (email/OAuth, sessions, JWT)
                                          └─ (Storage later, if needed)
        │
        └─ scrape calls ──▶  Scraper service (small Node container)
                              RCDB · Wikipedia(SSE) · Playwright scrape
                              stateless: returns proposed data; client writes to Supabase
```

- **Security boundary = RLS.** Every domain table carries `household_id`; policies allow a
  row only when its `household_id` belongs to the requesting user's membership. The client
  uses the **anon key** (RLS-enforced) — the **service-role key is never shipped to the
  client**. Auth is fully managed by Supabase (no hand-rolled crypto/sessions).
- **Model normalization (also a bug fix).** Credits move from the brittle
  `parkId|||coasterName` string key to a real `credits(rider_id, coaster_id)` join row, so
  coaster renames no longer orphan credits (resolves a standing backlog item). Coasters
  become first-class rows with FKs instead of nested JSON.

### Proposed schema (Postgres)
- `households (id, name, owner_user_id, created_at)`
- `household_members (household_id, user_id, role)` — phase 1: just the owner
- `profiles (user_id PK, default_household_id)` — maps `auth.users` → household
- `regions (household_id, code, name, sort)` — replaces `settings.regions`
- `riders (id, household_id, name, height, color, sort)`
- `parks (id, household_id, name, tag, region_code, badge, official_url, lat, lng, sort)`
- `coasters (id, park_id, name, type, min, min_accompanied, speed_mph, racing, defunct,
  rcdb_id, rcdb_url, scale, status, height_source, sort)`
- `credits (id, rider_id, coaster_id, created_at)` — presence = ridden; unique(rider_id,coaster_id)
- RLS on all of the above keyed by `household_id` (coasters/credits join through park/rider).

---

## Phases

### Phase 0 — Foundations ✅ done
- Create Supabase project; install Supabase CLI; enable **local dev** (`supabase start`)
  so schema/RLS are developed against a local Postgres before touching cloud.
- Author the schema + RLS as versioned SQL migrations under `supabase/migrations/`.
- Add config/secrets: `.env` for `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`; document
  where the service-role key lives (server only, never client).
- Decide hosting targets (web: Vercel/Netlify; scraper: Render/Railway/Fly).

### Phase 1 — Data layer migration (DB-backed, still single-household) ✅ done
- Build the schema locally; seed one "default" household.
- Add `src/supabaseClient.js`; **replace the persistence layer** in `credit-tracker.jsx`:
  - `apiGet`/`apiPut` + `saveRiders/saveParks/saveSettings/saveCredits` → Supabase queries.
  - The mount-time load (`Promise.all([...apiGet...])` ~line 2246) → Supabase selects.
  - Credits: replace the `parkId|||coasterName` Set + `ck()` usage with `coaster_id`-keyed
    membership; `toggleRidden` becomes insert/delete on `credits`.
  - `normalizeCoaster()` maps to/from the `coasters` row shape; keep `isEligible`/`rideStatus`
    and all UI logic unchanged (pure functions, no change).
- One-time **import script** `scripts/import-json-to-supabase.mjs`: read existing
  `data/*.json`, create rows, resolve each `parkId|||coasterName` credit to a `coaster_id`.
- Trim `server.js` → **scraper-only service** (RCDB, `fill-heights` SSE, `scrape-heights`);
  remove riders/parks/settings/credits CRUD (now in Supabase). Scrapers stay stateless —
  they return proposed data and the client writes it to Supabase.

### Phase 2 — Auth & multi-tenancy (households, login, security) ✅ done
- Turn on Supabase Auth (email/password + magic-link or an OAuth provider).
- Add an **auth gate**: a login/sign-up screen wrapping `<App/>` in `src/main.jsx`; load
  the session, redirect unauthenticated users.
- On first sign-in: create the user's `household` + `profile` + owner membership and seed
  default regions (and optionally run the import for the existing data into that household).
- Add `household_id` to every table + **RLS policies**; point all client queries at the
  authed user's household (RLS makes this automatic/safe).
- **Security pass:** verify RLS on every table (incl. cross-household-denied tests), confirm
  only the anon key is in the client bundle, validate session refresh + sign-out.

### Phase 3 — Web deployment ✅ done
- Deployed: SPA on Vercel (`coaster-tracker-gray.vercel.app`), scraper service on
  Render as a Docker container (`coaster-tracker.onrender.com`, built from the
  repo's `Dockerfile`), Supabase managed cloud (already in use since Phase 0).
- Production env vars: `VITE_SCRAPER_URL` (SPA → scraper) and `FRONTEND_URL`
  (scraper's CORS allowlist) — see README "Deployment".
- Not done: custom domain, client error boundary, server-side observability beyond
  Render/Supabase's own logs.

### Phase 4 — PWA / mobile-readiness
- **Responsive + design-system cleanup first** (this unblocks mobile) — execute the existing
  backlog item "Visual design system & responsive breakpoints" (`docs/BACKLOG.md`): tokens,
  breakpoints mobile→ultrawide, collapse the 260px left navs on narrow widths, wide-table
  behavior, top-bar wrap.
- Add **PWA**: `vite-plugin-pwa` (manifest + service worker), installable home-screen app,
  cache the static shell; data still requires network (Supabase). Viewport meta already set.
- Test on real iOS/Android browsers.

### Phase 5 — Future (optional)
- **Household sharing:** invites + roles (`household_members`), so multiple people use one
  household; per-person logins if desired.
- **Native app:** Expo/React Native sharing the Supabase backend + domain logic/types. Note:
  the current inline-styled HTML/SVG UI does **not** port — RN is a UI rewrite, which is why
  PWA comes first.

---

## Critical files

- `credit-tracker.jsx` — replace persistence (`apiGet/apiPut/save*`, lines ~331–357 and the
  mount loader ~2246) with Supabase; convert credits from `ck()`/string-keys to `coaster_id`;
  add auth-aware data loading. Pure logic (`isEligible`, `rideStatus`, `normalizeCoaster`,
  components) stays.
- `server.js` — reduce to the scraper service; drop CRUD endpoints.
- `scrape-heights.js` — unchanged; just deployed as part of the scraper service.
- `src/main.jsx` — wrap `<App/>` with the auth gate / session provider.
- `vite.config.js` — Supabase env; the `/api` proxy now targets only the scraper service.
- `package.json` — add `@supabase/supabase-js` (Phase 1), `vite-plugin-pwa` (Phase 4).
- **New:** `supabase/migrations/*.sql` (schema + RLS), `src/supabaseClient.js`,
  `scripts/import-json-to-supabase.mjs`, auth UI component.
- Docs: update `docs/INFORMATION-ARCHITECTURE.md` (new data architecture) and `README.md`
  (setup now includes Supabase); the credit-key migration backlog item gets resolved here.

## Verification

- **Local:** `supabase start`; apply migrations; run the import script; run the web app
  against local Supabase. Verify per-table CRUD, that credits survive a coaster rename, and
  that scrapers still apply via the client.
- **Security:** with two test households, confirm RLS denies cross-household reads/writes
  (query as user A for B's rows → empty/denied); confirm the client bundle contains only the
  anon key; confirm sign-out clears the session.
- **Deploy (staging):** smoke-test sign-up → seed → CRUD → scrape on the deployed stack.
- **PWA:** Lighthouse PWA audit; install to home screen on iOS/Android; sanity-check layouts
  at mobile/tablet/desktop/ultrawide breakpoints.
