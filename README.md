# Tempo

A run-only marathon training engine, deployed as a headless API + dashboard on
[Val Town](https://val.town). Tempo plans a season from a single Goal Marathon
Pace (GMP), derives pace zones, schedules workouts, and reconciles them against
actual runs from Strava. It is API-first: a dashboard, a cron, or an external
agent can all read and edit the same plan.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Training model

- **GMP anchor.** A single Goal Marathon Pace (e.g. `6:52/mi`) expands into pace
  zones via fixed offsets — easy `8:45–9:30`, tempo `6:20–6:35`, interval
  `5:50–6:10`. Override per-plan via `plans.zones_json`.
- **Block-based plans.** The full season skeleton (phase-tagged weeks) is
  generated up front; only the current ~8 weeks are detailed into concrete
  workouts. Re-detailing the next block is the retro step (`POST /api/plan/block`).
- **Phases**, counted back from race day: taper (last 3) · specific (8) ·
  build (8) · base (the remainder).
- **Weekly skeleton.** Tue/Thu/Sat anchor runs; Sat is the long run; Mon/Fri
  rest. Every 4th week is a cutback.
- **Quality** unlocks with fitness: none in base; build and specific phases add
  one midweek tempo or interval session plus the long run.
- **Projection.** Marathon time projected from a recent half via Riegel's formula.
- Runs only — no lifting or gear tracking in v1.

## Architecture

A single http val (`app.ts`) is the only entrypoint and serves everything on one
origin: the dashboard, the bearer-auth API, and the Strava / Google OAuth flows.
Same-origin keeps OAuth redirects and links simple and leaves one URL to manage.
Each module exposes a `register*(app)` function that mounts its own path-scoped
routes onto the shared Hono app.

```
client (dashboard / script / agent)
        │ read/write
        ▼
Val Town project  (http vals + interval crons)
        │
        ▼
SQLite (plans, plan_weeks, workouts, runs, integrations, nudges, settings)
Blobs  (athlete-profile, training-log)
        │ context
        ▼
Claude API (block adjustment, retro synthesis, nudge copy)
   ┌────┴─────┐
   ▼          ▼
 Strava   Google Calendar
```

Pure logic (`engine.ts`, `types.ts`) has no remote imports and runs/unit-tests
offline; all I/O lives in `db.ts` and the http vals. The runtime is Deno: SQLite
via `https://esm.town/v/std/sqlite`, blobs via `https://esm.town/v/std/blob`.

### Files (`val/` → uploaded to Val Town)

| File           | Type   | Purpose                                                       |
| -------------- | ------ | ------------------------------------------------------------- |
| `app.ts`       | http   | Single entrypoint — mounts api + strava + gcal + dashboard    |
| `types.ts`     | script | Domain types + constants (no remote imports → unit-testable)  |
| `db.ts`        | script | SQLite schema + query helpers + domain getters                |
| `engine.ts`    | script | GMP→paces, macro skeleton, weekly templates, cutbacks, projection |
| `plan.ts`      | script | Create plan, lay skeleton, detail ~8-week blocks              |
| `api.ts`       | script | `registerApi(app)` — headless API (bearer auth)               |
| `views.ts`     | script | Dashboard HTML renderers                                      |
| `dashboard.ts` | script | `registerDashboard(app)` — password-gated pages + `/sync`     |
| `strava.ts`    | script | `registerStrava(app)` — OAuth, sync, run↔workout matching     |
| `gcal.ts`      | script | `registerGcal(app)` — OAuth + push workouts as calendar events |

See [`CLAUDE.md`](CLAUDE.md) for the full architecture notes and conventions.

## Development

Requires [Bun](https://bun.sh) for the offline test suite.

```bash
gh repo clone Approach-Labs-AI/running-tempo
cd running-tempo

# pure engine tests — no network, no Val Town
bun test test/engine.test.ts
```

Live behavior (API, dashboard, OAuth, crons) requires deploying to your own Val
Town project — use a throwaway project and your own keys for development.

## Deploy

```bash
export VALTOWN_TOKEN=...      # vtwn_...
export VALTOWN_PROJECT=...    # project id
export VALTOWN_BRANCH=...     # branch id
python3 scripts/upload.py     # uploads everything in val/ (script vs http inferred)
```

Then set env vars in the Val Town web UI (not via API): `ANTHROPIC_API_KEY`,
`TEMPO_API_SECRET`, `DASHBOARD_PASSWORD`, `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET`,
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`. Create a plan with `POST /api/plan`.

## API

Base = the deployed origin. Auth: `Authorization: Bearer $TEMPO_API_SECRET`
(browser OAuth routes excepted).

| Endpoint                     | Method   | Purpose                                      |
| ---------------------------- | -------- | -------------------------------------------- |
| `/api/health`                | GET      | Health (no auth)                             |
| `/api/plan`                  | GET/POST | Active plan + paces + progress / create plan |
| `/api/plan/block`            | POST     | Detail the next ~8-week block (the retro)    |
| `/api/weeks?detailed=true`   | GET      | Season skeleton / detailed weeks             |
| `/api/workouts?from=today`   | GET      | Workouts in a date range                     |
| `/api/workouts/:id`          | PATCH    | Edit a workout                               |
| `/api/workouts/:id/complete` | POST     | Mark done / skipped                          |
| `/api/runs`                  | GET      | Actual Strava runs                           |
| `/api/paces`                 | GET      | Current pace zones                           |
| `/api/progress`              | GET      | Miles earned, adherence, days to race        |
| `/api/project/half`          | POST     | Project marathon time from a half (Riegel)   |
| `/api/strava/status`         | GET      | Strava connection + last run                 |
| `/api/sync/strava`           | POST     | Pull activities, upsert runs, match workouts |
| `/api/gcal/status`           | GET      | Calendar connection + events pushed          |
| `/api/gcal/push`             | POST     | Push / refresh workouts as calendar events   |
| `/api/log`                   | GET/PUT  | Read / replace the training-log notes        |
| `/api/log/entry`             | POST     | Prepend a dated note                         |

OAuth (browser, same origin): `GET /strava/connect` → Strava authorize
(`activity:read_all`); `GET /strava/callback` exchanges the code and runs a first
sync. `GET /gcal/connect` → Google consent (`calendar.events`, offline);
`pushWorkouts()` upserts a timed event per non-rest workout with popup + email
reminders. Redirect URIs default to `<origin>/strava/callback` and
`<origin>/gcal/callback`; override with `STRAVA_REDIRECT_URI` / `GOOGLE_REDIRECT_URI`.

Strava sync matches one actual run per planned workout on the same date and marks
it done; all running miles count toward miles-earned and adherence.

## Status

| Phase | Scope                                                  | State |
| ----- | ------------------------------------------------------ | ----- |
| P0–P1 | Engine, schema, API, dashboard                         | ✅     |
| P2    | Strava sync + run↔workout matching                     | ✅     |
| P3    | Google Calendar push + reminders                       | ✅     |
| P4    | AI block adjustment, retro synthesis, SMS/email nudges | ⏳     |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, conventions, and how to
propose training-model changes. Bug reports and feature requests have issue
templates.

## License

[MIT](LICENSE)
