# Dev workflow

Now that there's a live production deployment (see README "Deployment"), changes
go through a branch + PR, not straight to `main`.

## Branching

- `main` is production — every push to `main` auto-deploys (Vercel for the SPA,
  Render for the scraper service).
- Work happens on a short-lived branch off `main`, named by intent:
  `feat/...`, `fix/...`, `docs/...`, `chore/...`.
- Open a PR into `main` when ready for review (`gh pr create`). Merge (don't force-push
  over `main`) once it looks right.

## Reviewing before merge — Vercel preview deployments

Every PR gets its own **Vercel preview URL** automatically (Vercel's GitHub
integration creates one per push, no setup needed) — something like
`coaster-tracker-git-<branch>-tbizz22.vercel.app`. `server.js`'s CORS allowlist
recognizes any `coaster-tracker-*.vercel.app` origin in addition to the
production `FRONTEND_URL`, so a preview can call the live scraper service.

The scraper service itself doesn't get a separate preview deployment — previews
and local dev both hit the **same production Render scraper** (it's stateless,
so that's safe) and the **same production Supabase project** (see below for why
that's also safe).

## Testing without touching real data — the test account

Production Supabase is shared between prod, previews, and local dev — there's no
separate "staging" database. What keeps test data from polluting your real
family's data is **household-level RLS isolation**: every row belongs to exactly
one household, scoped to the signed-in user, and households can't see each other.

So there's one dedicated **test account** (a Gmail "+" alias, e.g.
`tyler.bisbee+test@gmail.com`, signed up like any other account) whose household
exists purely for testing. **Always sign in with the test account when verifying
a PR preview or doing exploratory local testing** — never the real family
account. Real family data is never at risk from test work because RLS guarantees
the test household can't read or write it, regardless of what gets tested.

Avoid testing destructive/global operations (schema migrations via the Supabase
CLI, anything that isn't scoped to a household) against production Supabase from
a branch — those aren't covered by the household-isolation safety net.

## Summary

```
feature branch → PR → Vercel preview (sign in as test account, verify) → merge to main
                                                                              │
                                                                              ▼
                                                          auto-deploy: Vercel (SPA) + Render (scraper)
```
