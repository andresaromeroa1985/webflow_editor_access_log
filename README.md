# Webflow Editor Access Log

Answers one question across the SpotOn site portfolio:

> **How many of our clients are actually editing their own websites?**

Nightly, it pulls each site's Webflow Site Activity log, stores the events in
D1, and renders a dashboard whose headline is *"52 of 748 sites had a client
edit in the last 30 days."*

---

## How it decides what a "client edit" is

This is the part worth understanding before trusting a number.

The Webflow activity log tells you **who** did something (`user.id` +
`user.displayName`) and **what** they did — but **not their role and not their
email**. There's no `role: "client_editor"` field to filter on.

So the tool inverts it: it keeps an allowlist of SpotOn's own Webflow user IDs
(`internal_users`), and **anything done by someone not on that list counts as a
client edit.**

Two consequences:

- **The allowlist is the metric.** If a designer is missing from it, their work
  inflates the client numbers. The `/users` page exists to manage this and the
  dashboard warns you when unclassified users exist.
- **A designer editing on a client's behalf reads as a designer edit**, not a
  client one. That's usually what you want — it measures genuine client
  self-service — but it's a deliberate choice, not an accident.

Events with no user at all (automatic backups, system events) are excluded from
every count. They aren't attributable to anyone.

Classification is resolved **at query time**, not baked into rows at sync time.
Flipping a user on `/users` retroactively corrects every historical figure
without a re-sync.

---

## Requirements

| | |
|---|---|
| **Webflow plan** | **Enterprise.** `GET /sites/:id/activity_logs` is Enterprise-only and 403s otherwise. Verified working on workspace `6516eac7425d96905f7faa3a`. |
| **Token scopes** | `sites:read` + `site_activity:read` |
| **Framework** | Next.js 15 (App Router) on Webflow Cloud via OpenNext |
| **Storage** | D1 (SQLite) |

---

## Authorizing across all sites

**This is the main setup hurdle.** A **site token** only ever returns the one
site it was minted for — useless for a 950-site portfolio. A **workspace token**
covers workspace audit logs but *not* site activity logs.

What you need is a **Webflow OAuth app installed at the workspace level**, whose
access token covers every authorized site:

1. Workspace → **Apps & integrations** → **Build an App**
2. Request scopes `sites:read` and `site_activity:read`
3. Install it to the SpotOn workspace, authorizing **all sites**
4. Complete the OAuth exchange once and keep the resulting access token
   (Webflow access tokens are long-lived and don't rotate on a timer)
5. Store it as the `WEBFLOW_API_TOKEN` secret

Sites the token can't read are marked `activity_supported = 0` after their first
403/404 and skipped on later runs, so a partial authorization degrades quietly
rather than failing the whole sync.

---

## Environment variables

Set these in the Webflow Cloud environment dashboard. Mark the first two as
**secrets**.

| Variable | Required | Purpose |
|---|---|---|
| `WEBFLOW_API_TOKEN` | yes | OAuth token with `sites:read` + `site_activity:read` |
| `CRON_SECRET` | yes | Shared secret gating `/api/sync`. Generate with `openssl rand -hex 32`. |
| `BACKFILL_DAYS` | no | How far back a site's *first* sync reaches. Default `180`. |

---

## Deploy

```bash
npm install
npm run build          # sanity check
git push               # Webflow Cloud builds on push
```

Then in the Webflow Cloud dashboard: **Storage → Add Storage → SQLite**, and
paste the generated `database_id` into `wrangler.json` (it currently holds a
placeholder). Migrations in `migrations/` are applied automatically on deploy.

First run:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
     "https://<your-app>/api/sync?offset=0"
```

---

## The sync loop

Webflow Cloud has **no built-in cron**, and a single Worker invocation can't
hold ~950 sites of API calls inside its wall-clock budget. So `/api/sync`
processes a **batch** of sites and hands back the next offset:

```
GET /api/sync?offset=0&batch=25   -> { done: false, nextOffset: 25, ... }
GET /api/sync?offset=25&batch=25  -> { done: false, nextOffset: 50, ... }
...                               -> { done: true }
```

`.github/workflows/sync.yml` drives that loop nightly at 09:00 UTC (~02:00 PT).
It needs two repository secrets:

- `APP_URL` — the deployed app's base URL, no trailing slash
- `CRON_SECRET` — same value as the app's env var

Trigger it by hand from the Actions tab via **workflow_dispatch** to test.

### Why incremental sync matters

The activity log endpoint offers **no date filter** — only `limit`/`offset` over
a newest-first list, capped at 100 per page. So the sync walks pages until it
recognises the watermark event ID stored from the previous run
(`sync_state.last_event_id`), then stops.

Steady state is therefore ~1 request per site per night. Only the first run is
expensive, and `BACKFILL_DAYS` bounds it.

Rate limits are per API key: 60 req/min on lower plans, custom on Enterprise.
The client honours `Retry-After` on 429 (capped at 15s so one throttled site
can't stall a batch) and runs at a concurrency of 4 by default —
`?concurrency=N` to tune.

---

## Routes

| Route | Purpose |
|---|---|
| `/` | Dashboard. `?days=7\|30\|90\|365` switches the window. |
| `/users` | Classify Webflow users as SpotOn vs client. **Do this first.** |
| `/api/stats?days=30` | Same numbers as JSON |
| `/api/stats?days=30&format=csv` | CSV export |
| `/api/sync?offset=0&batch=25` | Batched sync (requires `CRON_SECRET`) |
| `/api/users` | `GET` list, `POST {userId, internal}` to toggle |

---

## First-run checklist

1. Deploy, add the D1 binding, set env vars
2. Run the sync once with `offset=0` (or fire the workflow manually)
3. Open `/users` — **sort is already by site count.** Users appearing across
   many sites are your designers; mark them SpotOn. Users on exactly one site
   are that site's client.
4. Open `/` — the headline is now meaningful

---

## Known limitations

- **Enterprise-gated.** Non-Enterprise sites return 403 and get flagged
  `activity_supported = 0`.
- **`source` attribution is not retroactive.** Webflow added source tagging
  (`DESIGNER` / `WEBFLOW_AI` / MCP) in early June 2026; events before that have
  no source. The tool doesn't depend on `source` for its core metric — it uses
  user identity — but the column is stored for future use.
- **It has not been confirmed that a Client Editor session is tagged
  differently from a Designer session.** Every event observed during
  development read `DESIGNER`. If Webflow does expose a distinct `EDITOR`
  source, filtering on it would be a stronger signal than the allowlist and
  worth revisiting.
- **No auth on the dashboard itself.** `/api/sync` is protected by
  `CRON_SECRET`, but the dashboard and read APIs are open to anyone who can
  reach the URL. Put it behind Webflow Cloud access controls or add middleware
  before sharing the link.
- **Only 100 events per page** with no server-side date filter, so an initial
  backfill of a very busy site can take several pages.

---

## A note on the starter template

This app began from `Webflow-Examples/hello-world-nextjs`. That template pins
`@cloudflare/workers-types@^4`, which now conflicts with the peer dependency of
current `wrangler` (`^5`). `npm install` fails with `ERESOLVE` until you bump
it — done here in `package.json`.
