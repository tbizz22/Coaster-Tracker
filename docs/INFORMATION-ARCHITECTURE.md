# Coaster Tracker — Information Architecture

> Status: **Proposal v1** · Owner: design/architecture pass (backlog task #8)
> Purpose: define a deliberate sitemap, consistent page naming, and reusable
> navigation/layout patterns so future feature work lands coherently.

---

## 1. What the app is for

Coaster Tracker answers three questions for a family of roller-coaster riders:

1. **What coasters exist** at each theme park? (reference data)
2. **Which coasters can a given rider get on** today, by height? (eligibility)
3. **Which coasters has each rider actually ridden** — their "credits"? (progress)

Everything in the IA should make one of those three jobs obvious and fast.

---

## 2. Domain model & vocabulary

A shared vocabulary prevents drift ("credits" vs "rides ridden" vs "done").
Use these terms consistently in UI copy, code, and docs.

| Term | Definition | Notes / banned synonyms |
|---|---|---|
| **Park** | A theme park. Has name, tag (airport code), region, optional badge (one-off label), optional `family` (chain/ownership group — `SF`/`CF`/`UNI`/`SW`/`IND`), and a list of coasters. | not "venue" |
| **Coaster** | A roller coaster at a park. Has name, manufacturer/model, `min` height (inches, or `null` = unknown), `racing` flag, plus external refs (RCDB, status, scale). | "ride" is acceptable as a casual synonym; prefer "coaster" |
| **Rider** | A person whose credits we track. Has name, height (inches), color. | not "user", not "kid" |
| **Credit** | The fact that a *rider* has ridden a specific *coaster*. The unit of progress. | banned: "done", "ridden flag" in UI copy |
| **Eligible** | A rider *meets the height requirement* for a coaster (`min != null && height >= min`). | distinct from "ridden" |
| **Region** | A geographic grouping of parks (NE, SE, MW, TX, CA, INT). Configurable. | — |
| **Unknown height** | `min == null` — we don't yet know the requirement. Renders as `?`. | not "0", not "N/A" |

**Key denominators** (be explicit which one a number uses):
- **Total** — every coaster at the park(s).
- **Eligible** — coasters this rider is tall enough for. *This is the default
  denominator for a rider's progress %* (you can't earn a credit you can't ride).

---

## 3. Current state (as-built sitemap)

```
🎢 Parks                — park list (left) + a display area that shows the
                          offline SVG Map by default and swaps to a park detail
                          once a park is selected (via the list or a map marker)
                          • Map: region-colored markers plotted from lat/lng
                            (size = #coasters); "Map · all parks" left-nav entry
                            returns to it; a "← Back to map" breadcrumb in detail
                          • detail defaults to 🗺 Overview (neutral reference:
                            stat cards + coaster table w/ Racing column)
                          • inline "View" lens (below park header) switches the
                            table to a rider's height eligibility (Tick column)
✓ Credits               — park list (left) + detail, with a PIVOT toggle:
                          • 🎡 By park  → all riders × coasters grid, bulk toggles
                          • 👤 By rider → riders down the left nav; detail shows
                            one rider's credits across all parks as collapsible,
                            filterable per-park drawers (name filter + status
                            filter: All/In progress/Unstarted/Complete; expand-all)
⚙ Settings
├── 🎡 Parks            — add/edit parks & coasters (+ defunct flag, official
│                         height-chart URL), RCDB lookup, fill-heights
├── 👤 Riders           — add/edit/delete riders
└── 🌎 Regions          — add/rename/reorder/delete regions (→ `regions` table)
```

All coaster tables share one sort model (click headers; default height-asc,
unknown last). Defunct coasters are badged, still count as credits, and are
excluded from eligible/available denominators.

**Resolved since v1:** Dashboard merged into the Credits pivot (P3/#4); Explorer
+ Height Check flattened into one Parks detail with the rider lens pushed one
level down (P1); Regions added to Settings (P5); external links surfaced (P7);
sortable tables landed.

**Remaining friction:**
- **Two "Parks" labels** still exist (top-level `🎢 Parks` and Settings
  `🎡 Parks`). The Explore/Track rename (§4) would resolve this.
- Region filter visibility rules remain ad-hoc (`view` allow-list).
- The Map is a lean offline SVG (no pan/zoom street tiles) — sufficient for an
  at-a-glance geographic overview; a real tile map remains a possible upgrade.

---

## 4. Proposed sitemap & page names

Reorganize around the **three core jobs**, not around screens that grew
organically. Two top-level destinations for *doing*, one for *configuring*.

```
EXPLORE  (reference — "what's out there")
└── Map / Park browser
    • Park list (left nav, region-grouped) ⇄ map markers
    • Park detail: coasters, types, heights, external links
    • No rider context — pure reference

TRACK  (the core loop — "who has ridden what")
└── Park-based left nav (region-grouped list)  ← same chrome as Explore
    └── Park detail (right pane): ALL riders × coasters
        • toggle credits per rider
        • per-rider and per-coaster bulk actions
        • progress framing (ridden / eligible) per rider
    └── Secondary lens: "Height Check" (can each rider ride it?)

SETTINGS  (configure — "set up the data")
├── Parks      — manage parks & coasters; import (RCDB); fill heights
├── Riders     — manage riders (name, height, color)
└── Regions    — manage the region list (codes + names)
```

### Page-name conventions
- Top-level destinations are **verbs or plain nouns**: *Explore*, *Track*,
  *Settings*.
- Sub-views are **nouns describing the content**, not actions: *Map*,
  *Height Check*, *Parks*, *Riders*, *Regions*.
- Avoid duplicate labels across levels (rename Settings → "Parks" stays, but
  the top-level becomes *Explore/Track*, removing the clash).

### Why this shape
- **Explore vs Track** cleanly separates *reference* (no rider) from *progress*
  (all riders). Today that line is blurred.
- **Track absorbs Dashboard + Credits** (backlog #4): one place to pick a park
  and see/toggle every rider. Height Check becomes a *lens* on the same park
  selection rather than a sibling screen.
- **Settings gains Regions** (backlog #5), making all configuration live in one
  predictable place.

---

## 5. IA patterns (reuse these)

### P1 — Navigation model (3 tiers, fixed roles)
- **Tier 1 — Top tabs:** the major destinations (Explore · Track · Settings).
  Always visible. Switching is a context change.
- **Tier 2 — Left nav (list):** the *object you're acting on* — almost always
  the region-grouped **park list**. Selection persists across Tier-3 changes.
- **Tier 3 — Sub-tabs / lens switch:** a view *of the current selection*
  (e.g. Track's "Credits" vs "Height Check" lens). Never changes what's
  selected, only how it's shown.

> Rule: **the left nav owns "what", sub-tabs own "how".** A user should never
> lose their selected park by switching a lens.

### P2 — List / detail layout
Every data-heavy screen is **list (left) + detail (right)**:
- Left: region-grouped, scrollable, with a compact per-item stat that adapts to
  the active view (count / eligible / ridden).
- Right: header (name + summary stats) → table/visualization → legend/footnote.
- This is already implemented in `ParksTab`; promote it to *the* layout.

### P3 — Rider context
- **Reference views (Explore):** no rider — show neutral facts.
- **Progress views (Track):** show **all riders at once** in the detail pane
  (columns), with a rider selector only when a single-rider lens needs it
  (Height Check). Prefer all-riders-by-default; single-rider is the exception.

### P4 — Numbers always declare their denominator
- Progress = `ridden / eligible` (rider's color).
- Always offer `ridden / total` as the secondary, muted figure.
- Unknown-height coasters are excluded from *eligible* and badged `?`.

### P5 — Settings = everything configurable, nowhere else
- Parks, Riders, Regions, and any future data sources/import tools live under
  Settings. No configuration leaks into Explore/Track.

### P6 — Empty & unknown states (standardize copy)
- No riders yet → "No riders yet — add one in **Settings → Riders**." (link)
- No parks in region → "No parks in this region."
- Unknown height → `?` badge + "height unknown" inline; never blank or `0`.
- Lookups in progress → streamed/live status, not a frozen spinner.

### P7 — External references are first-class
- Coasters/parks carry external IDs/URLs (RCDB id+url; official Six Flags chart
  URL — backlog #1/#3). Surface them as small "↗" links in detail/settings,
  so the app is a hub into authoritative sources.

### P8 — Design tokens + responsive shell (style against the scale, not literals)
- **Tokens.** All spacing/type/radius/weight/color-role values come from the `T`
  object in `credit-tracker.jsx` (mirrored as CSS variables in `index.html`). New
  UI styles against `T` (and the shared `labelCss` / `fieldLabelCss` micro-label
  helpers) — not ad-hoc inline `12`/`#1e293b` literals. Exceptions that stay
  literal *by design*: semantic status colors (green/amber/red/violet) and the
  map's geographic `REGION_COLORS`.
- **Responsive shell.** Layout uses the CSS classes (inline styles can't do media
  queries): `.ct-split` (list+detail row) + `.ct-sidenav` (the 260px nav) collapse
  to a stacked, scrollable strip below **820px**; `.ct-hscroll` scrolls wide grids;
  `.ct-content` caps the scrollable detail panels at `--content-max` (1160px) and
  centers them on ultrawide. Put new list/detail screens on these classes.

---

## 6. Current → proposed mapping

| Current | Proposed | Change |
|---|---|---|
| Parks ▸ Explorer | **Explore ▸ Map** | rename + becomes map-first (backlog #7) |
| Parks ▸ Dashboard | **Track** (all-riders detail) | merge into Track (backlog #4) |
| Parks ▸ Height Check | **Track ▸ Height Check lens** | becomes a lens, keeps park selection |
| Credits | **Track** (default lens) | merge into Track (backlog #4) |
| Settings ▸ Parks | **Settings ▸ Parks** | unchanged |
| Settings ▸ Riders | **Settings ▸ Riders** | unchanged |
| *(none)* | **Settings ▸ Regions** | new (backlog #5) |
| top-level "🎢 Parks" | **Explore / Track** | split + rename (resolves label clash) |

**Sequencing note:** this IA assumes backlog tasks #4 (merge Dashboard→Credits),
#5 (configurable regions), and #7 (Explorer→map) land. Do those *to this spec*.
Tasks #1/#3 (external links) implement pattern **P7**. Task #6 (sortable tables)
is orthogonal and applies to every detail table.

---

## 7. Data architecture (for reference)

Single-page React UI (`credit-tracker.jsx`) talks to **Supabase** (Postgres +
Auth + RLS) directly for all persistence — every mutation writes straight to
Supabase via `src/supabaseClient.js`; the UI never holds the source of truth.
A small stateless Express service (`server.js`) handles only scraping
(RCDB/Wikipedia/official-height pages), which can't run inside Supabase.

| Table | Shape |
|---|---|
| `riders` | `{id,household_id,name,height,color,needs_companion,sort}` |
| `parks` | `{id,household_id,name,tag,region_code,badge,family?,official_url,lat?,lng?,sort}` |
| `coasters` | `{id,park_id,name,manufacturer,model,material,style,min,min_accompanied,speed_mph,height_ft,year_opened,racing,defunct,rcdb_id,rcdb_url,scale,status,height_source,sort}` |
| `credits` | `{rider_id,coaster_id}` — presence = ridden; real FK row, unique(rider_id,coaster_id) |
| `regions` | `{household_id,code,name,sort}` |
| `households` / `household_members` / `profiles` | account → household mapping; RLS policies key off membership |

`riders`/`parks`/`coasters` use **client-generated text ids** (the app's `uid()`
scheme), not server uuids — `credit-tracker.jsx`'s `save*()` functions are
fire-and-forget upserts of the whole current array (reconciling against the DB:
upsert present rows, delete rows no longer present), so the id has to be known
client-side at insert time. RLS scopes every table to the requesting user's
household; the client only ever uses the anon key.

**Coaster (canonical shape — every seeding path runs through `normalizeCoaster`):**
`{ id, name, manufacturer, model, material, style, min, minAccompanied, speedMph, heightFt?, yearOpened?, racing?, defunct?, rcdbId?, rcdbUrl?, scale?, status?, heightSource? }`
- `min` = minimum height to ride **alone**; `minAccompanied` = lower limit **with a
  supervising companion** (null when the park posts one limit). A rider is *eligible*
  if they meet either; accompanied-only rides are flagged with a `✓*` asterisk.
- `min == null` (and `minAccompanied == null`) = unknown height → `?`.
- `normalizeCoaster()` is the single funnel for hand-seed, RCDB import, and
  fill-heights, so all records share one schema (normalized idempotently on load).
  It also assigns a stable `id` (`uid()`) the first time a coaster is seen, which
  every subsequent save preserves.
- `mergeCoasters(existing, incoming)` reconciles an import against the existing list
  by **`rcdbId` first**, then a punctuation/trademark-insensitive name — fills only
  empty fields, never clobbers, appends only new — so re-imports update in place
  instead of duplicating. (`needsCompanion` on riders is an informational flag only;
  it doesn't affect eligibility/counts.)

| RCDB import | `GET /api/lookup-coasters` | — (live scrape) | park search → coaster list |
| Height fill | `POST /api/fill-heights` (SSE, body `{parks}`) | stateless | streams `{coaster,height,source}` |
| Official scrape | `POST /api/scrape-heights` (body `{park}`) | stateless | headless-browser scrape of the park's `officialUrl`; matches coasters by punctuation-stripped name + a stopword-containment fuzzy pass (`fuzzyNameMatch`), returns proposed `{min,minAccompanied}` updates with a `fuzzy`/`scrapedName` flag (client reviews & applies) |
| Batch scrape | `POST /api/scrape-all-heights` (SSE, body `{parks}`) | stateless | runs the official scrape over every `officialUrl` park, streaming per-park results to a combined review panel |
| RCDB speeds | `POST /api/fill-speeds` (SSE, body `{parks}`) | stateless | resolves top speed (mph) from rcdb.com for operating coasters lacking one (quick-search + park-name disambiguation) |

The SSE endpoints are POST, not GET — they need the caller's parks data in the
body, which `EventSource` can't do — so the client drives them with a small
`postSSE()` fetch+stream-reader helper instead.

**IA-relevant invariants:**
- A **credit** is a real `credits(rider_id, coaster_id)` row — renaming a coaster
  can never orphan it, because nothing about a credit references the coaster's
  name. (Resolved; previously this was a `parkId|||coasterName` string key with
  client-side migration-on-rename as a workaround.) The UI still derives an
  in-memory `ck(parkId, coasterName)` key for the `ridden` Set lookup convenience,
  resolved against `coaster.id` at every save — a display-layer detail, not the
  source of truth.
- `min == null` is the canonical "unknown height" — preserve it; don't coerce.
- Regions are data, not code — the Regions settings page (P5) edits the
  `regions` table.

---

## 8. Open questions / decisions to make

1. **Explore vs Track naming** — *decided: keep "Parks"/"Credits"* for now (the
   duplicate-label confusion was resolved by renaming the Settings sub-tab to
   "Parks & Coasters"). The Explore/Track rename stays an optional future polish.
2. **Single vs all-rider default in Track** — confirmed: all-riders columns is the
   By-park default; the single-rider lens is the Parks rider-View and the By-rider
   pivot.
3. **Map scope** (backlog #7) — US-region map vs full world (parks include INT
   e.g. Canada's Wonderland); needs lat/lng added to parks.
4. ~~**Coaster rename migration**~~ — *resolved (twice).* Originally `updateCoaster`
   migrated the credit's string key on rename; now it's moot — credits are a real
   `credits(rider_id, coaster_id)` FK row (§7), so a rename can't orphan one at all.
5. ~~**Coaster detail modal**~~ — *built.* `CoasterModal` (first reusable modal
   primitive) opens from any coaster name in the wide tables; view shows full
   details + provenance, with a toggle into an edit form.
6. **`needsCompanion` semantics** — *decided: informational only.* The per-rider
   flag surfaces a "needs an adult for ✓*" reminder but does not change counts
   (`✓*` rides stay eligible for everyone).
7. ~~**Top-bar pills are static / all-parks denominator is unreachable**~~ —
   *resolved.* Pills are clickable (deep-link into Credits ▸ By rider for that
   rider) and both the pills and the By-rider strip now lead with a
   visited-parks-scoped credits/eligible figure, keeping the all-parks total as a
   secondary "explore more" signal.
8. ~~**`badge` field overloaded for chain identity**~~ — *resolved.* Added a
   separate `family` field (`SF`/`CF`/`UNI`/`SW`/`IND`, via the `PARK_FAMILIES`
   map) populated for all 23 parks; `badge` stays available for one-off labels.
9. ~~**Single-user, file-based persistence with no auth**~~ — *resolved (Phases
   0–1 of the web-platform direction, see `BACKLOG.md`).* Riders/parks/coasters/
   credits/regions moved from `data/*.json` to Supabase Postgres, gated by a
   minimal email/password `AuthGate`, scoped per-household by RLS. `server.js`
   trimmed to a stateless scraper service. Auth/account UX itself is rough —
   tracked separately as its own backlog item ("Clean up the account-creation
   experience"). Phases 2+ (deploy, PWA, household sharing) remain open.

---

*Keep this doc current as the backlog tasks land. It is the reference the
reorganization work should follow. Future work / open items are tracked in
[`BACKLOG.md`](./BACKLOG.md); project overview and setup live in the root
[`README.md`](../README.md).*
