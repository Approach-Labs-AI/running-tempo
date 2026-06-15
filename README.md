# Tempo — Marathon Training App

A lean, **run-only** marathon training app deployed as a headless API + dashboard on
Val Town. Plans a season from a single Goal Marathon Pace (GMP) anchor, derives pace zones,
schedules runs (Tue/Thu/Sat anchors, Sat long), holds you accountable via Strava + nudges,
and is API-first so Claude Code can drive it.

**Planning doc**: `docs/running-tempo/ongoing/2026_06_15-plan.md` (read this first — full spec).
**Status**: P0–P3 built (engine + schema + API + dashboard + Strava + Google Calendar +
headless training-log notes). P4–P5 pending.
**First goal race**: Houston Marathon, Jan 18 2027 — **sub-3:00** (GMP 6:52/mi).
**Domain**: `tempo.kevinjsuh.com` (maps to the single `app.ts` http val).

> Brand "Tempo"; Val Town project + repo dir `running-tempo` (distinct from `coach-tempo`).

## Single origin

Everything is served by **one http val, `app.ts`**, on one domain. The dashboard, the
bearer-auth API, and Strava OAuth all share that origin — so OAuth redirects and links are
same-origin and there's only one URL to manage. Each module exposes a `register*(app)`
function (the coach `registerOpportunityRoutes` pattern) that mounts its routes — with its
own path-scoped auth — onto the shared Hono app. Only `app.ts` exports `default app.fetch`.

## Architecture (mirrors the `coach` Val Town project)

```
Kevin ──(dashboard / SMS reply / Claude Code)──┐
                                               ▼
            Val Town project "running-tempo"  (http vals + interval crons)
              │ read/write
              ▼
   SQLite (plans, plan_weeks, workouts, runs, integrations, nudges, settings)
   Blobs  (tempo-athlete-profile, tempo-training-log)
              │ context
              ▼
        Claude API (block adjustment, retro synthesis, nudge copy)
       ┌──────┴───────┐
       ▼              ▼
   Strava (P2)   Google Calendar (P3)     Twilio + Resend (P4)
```

## Files (`val/` → uploaded to Val Town)

| File             | Type     | Purpose                                                           | Phase |
| ---------------- | -------- | ----------------------------------------------------------------- | ----- |
| `app.ts`         | **http** | **Single entrypoint** — mounts api + strava + dashboard           | P1    |
| `types.ts`       | script   | Pure domain types + constants (no remote imports → unit-testable) | P0    |
| `db.ts`          | script   | SQLite schema + query helpers + domain getters                    | P0    |
| `engine.ts`      | script   | GMP→paces, macro skeleton, weekly templates, cutbacks, projection | P1    |
| `plan.ts`        | script   | Create plan, lay skeleton, detail ~8-wk blocks, Houston seed      | P1    |
| `api.ts`         | script   | `registerApi(app)` — headless API (bearer auth)                   | P1    |
| `views.ts`       | script   | Dashboard HTML renderers                                          | P1    |
| `dashboard.ts`   | script   | `registerDashboard(app)` — password-gated pages + `/sync`         | P1    |
| `strava.ts`      | script   | `registerStrava(app)` + OAuth, sync, run↔workout matching         | P2    |
| `gcal.ts`        | script   | `registerGcal(app)` — OAuth + push workouts as calendar events    | P3    |
| `coach-brain.ts` | script   | _(P4)_ Claude prompts: block adjustment, retro, nudge copy        | P4    |
| `nudges.ts`      | interval | _(P4)_ Morning cron — morning-of reminders                        | P4    |
| `weekly.ts`      | interval | _(P4)_ Sunday cron — reconcile + retro + weekly summary           | P4    |

Tests: `test/engine.test.ts` — `bun test projects/running-tempo/test/engine.test.ts` (offline, pure).

## Training model (the IP)

- **One anchor: GMP (6:52 = 412 s/mi).** Zones derive via `ZONE_OFFSETS_FROM_GMP`:
  easy 8:45–9:30, tempo 6:20–6:35, interval 5:50–6:10. Override per-plan via `plans.zones_json`.
- **Plan in blocks**: full macro skeleton (phase-tagged weeks) generated up front; only the
  current ~8 weeks are "detailed" into concrete workouts. Retro = `POST /api/plan/block`.
- **Phases** counted back from race: taper (last 3) · specific (8) · build (8) · base (rest).
- **Weekly skeleton**: Tue/Thu/Sat anchors, Sat = long run, Mon/Fri rest. Cutback every 4th wk.
- **Quality**: none in base; build/specific unlock one midweek tempo/interval + the long run.
- **Runs only** — no lifting/gear tracking in v1 (Kevin manages lifting separately).

## Deploy (once the Val Town project exists)

```bash
export VALTOWN_TOKEN=...        # vtwn_...
export VALTOWN_PROJECT=...      # project id
export VALTOWN_BRANCH=...       # branch id
python3 scripts/upload.py       # uploads everything in val/ (script vs http inferred)
```

Then set env vars in the Val Town web UI (NOT via API):
`ANTHROPIC_API_KEY`, `TEMPO_API_SECRET`, `DASHBOARD_PASSWORD`,
`STRAVA_CLIENT_ID`/`STRAVA_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`,
`TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_FROM`, `RESEND_API_KEY`.

Seed Kevin's plan: `POST /api/plan/seed-houston` (bearer auth) — creates the plan, lays the
31-week skeleton, and details the first 8-week base block from the brief.

## Headless API

Base = the `api.ts` val URL. Auth: `Authorization: Bearer $TEMPO_API_SECRET`.

| Endpoint                     | Method  | Purpose                                      |
| ---------------------------- | ------- | -------------------------------------------- |
| `/api/health`                | GET     | Health (no auth)                             |
| `/api/plan`                  | GET     | Active plan + paces + progress               |
| `/api/plan`                  | POST    | Create/regenerate a plan                     |
| `/api/plan/seed-houston`     | POST    | Seed Kevin's sub-3 Houston plan              |
| `/api/plan/block`            | POST    | Detail the next ~8-wk block (the retro)      |
| `/api/weeks?detailed=true`   | GET     | Season skeleton / detailed weeks             |
| `/api/workouts?from=today`   | GET     | Workouts in range                            |
| `/api/workouts/:id`          | PATCH   | Edit a workout                               |
| `/api/workouts/:id/complete` | POST    | Mark done/skipped                            |
| `/api/runs`                  | GET     | Actual Strava runs (P2)                      |
| `/api/paces`                 | GET     | Current pace zones                           |
| `/api/progress`              | GET     | Miles earned, adherence, days-to-race        |
| `/api/project/half`          | POST    | Project marathon time from a half (Riegel)   |
| `/api/strava/status`         | GET     | Strava connection + last run                 |
| `/api/sync/strava`           | POST    | Pull activities, upsert runs, match workouts |
| `/api/gcal/status`           | GET     | Calendar connection + events pushed          |
| `/api/gcal/push`             | POST    | Push/refresh workouts as calendar events     |
| `/api/log`                   | GET/PUT | Read / replace the training-log notes        |
| `/api/log/entry`             | POST    | Prepend a dated note (Claude Code writes)    |
| `/api/adjust`                | POST    | _(P4)_ AI block adjustment                   |
| `/api/nudge/test`            | POST    | _(P4)_ test SMS/email                        |

### Strava OAuth (browser, same origin)

- `GET /strava/connect` → redirects to Strava authorize (scope `activity:read_all`).
- `GET /strava/callback` → exchanges code, stores tokens in `integrations`, runs a first sync.
- `GET /sync` (dashboard, password-gated) → manual resync, then back to `/settings`.
- Redirect URI defaults to `<origin>/strava/callback`; override with `STRAVA_REDIRECT_URI`.
  Set the Strava app's Authorization Callback Domain to `tempo.kevinjsuh.com`.
- Sync matches one actual run per planned workout on the same date (marks it `done`); all
  running miles count toward "miles earned" and adherence.

### Google Calendar OAuth (P3) — doubles as the morning-of reminder

- `GET /gcal/connect` → Google consent (`calendar.events`, offline). `GET /gcal/callback`
  stores tokens + pushes the schedule. `GET /push-calendar` (password-gated) re-pushes.
- `pushWorkouts()` upserts a **timed event** per non-rest workout from today forward
  (default 06:30 local, duration = distance×pace) with **popup 30m + email 60m reminders** —
  the MVP accountability nudge. Idempotent via stored `gcal_event_id`.
- Redirect URI defaults to `<origin>/gcal/callback`; override `GOOGLE_REDIRECT_URI`. Set the
  Google OAuth client's authorized redirect to `https://tempo.kevinjsuh.com/gcal/callback`.
- Settings keys: `timezone` (default `America/Los_Angeles`), `run_time` (default `06:30`).

### Headless training-log notes

`tempo-training-log` is a markdown blob. `POST /api/log/entry {title, body}` prepends a dated
entry so Claude Code can write coaching notes from the terminal. Schedule edits use
`PATCH /api/workouts/:id`, `POST /api/plan/block` (retro re-detail), then `POST /api/gcal/push`
to reflect changes on the calendar.

## Conventions

- Val Town runtime is Deno: `Deno.env.get(...)`, `export default app.fetch` for http vals.
- SQLite via `https://esm.town/v/std/sqlite`; blobs via `https://esm.town/v/std/blob`.
- POST to create a Val Town file, PUT to update; both need `branch_id` (see `scripts/upload.py`).
- Keep pure logic in `engine.ts`/`types.ts` (testable); I/O in `db.ts`/http vals.
