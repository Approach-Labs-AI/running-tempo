// strava.ts — Strava integration for Tempo (Val Town http val).
// OAuth connect/callback, token refresh, activity sync, and run↔workout
// matching. Slim by design: pulls runs, upserts them, links each to the
// planned workout on the same day, and marks that workout done.
//
// Env (Val Town web UI): STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET.
// Optional: STRAVA_REDIRECT_URI (else derived from the request origin).

import type { Hono } from 'npm:hono@4'
import { getActivePlan, insert, query, queryOne, run } from './db.ts'
import { requireAuth } from './auth.ts'

const METERS_PER_MILE = 1609.344
const FEET_PER_METER = 3.28084
const RUN_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun'])

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

function redirectUri(reqUrl: string): string {
  return Deno.env.get('STRAVA_REDIRECT_URI') ?? new URL(reqUrl).origin + '/strava/callback'
}

/** Register Strava OAuth routes onto the shared app. */
export function registerStrava(app: Hono) {
  // Require a dashboard session before initiating OR completing OAuth, so a
  // random visitor can't authorize their own Strava into the single-user store.
  // The callback is a browser redirect and carries the session cookie.
  app.use('/strava/*', requireAuth)

  app.get('/strava/connect', (c) => {
    const clientId = Deno.env.get('STRAVA_CLIENT_ID')
    if (!clientId) return c.text('STRAVA_CLIENT_ID not set', 500)
    const url = new URL('https://www.strava.com/oauth/authorize')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', redirectUri(c.req.url))
    url.searchParams.set('approval_prompt', 'auto')
    url.searchParams.set('scope', 'activity:read_all')
    return c.redirect(url.toString())
  })

  app.get('/strava/callback', async (c) => {
    const code = c.req.query('code')
    if (!code) return c.text('missing code', 400)
    const res = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: Deno.env.get('STRAVA_CLIENT_ID'),
        client_secret: Deno.env.get('STRAVA_CLIENT_SECRET'),
        code,
        grant_type: 'authorization_code',
      }),
    })
    if (!res.ok) return c.text(`strava token exchange failed: ${await res.text()}`, 502)
    const tok = await res.json()
    await storeTokens(tok)
    // Pull recent history immediately so the dashboard isn't empty.
    await syncStrava()
    return c.redirect('/settings')
  })
}

interface StravaToken {
  access_token: string
  refresh_token: string
  expires_at: number // epoch seconds
  athlete?: { id: number }
}

async function storeTokens(tok: StravaToken): Promise<void> {
  await run(
    `INSERT INTO integrations (provider, access_token, refresh_token, expires_at, scope, external_id, updated_at)
     VALUES ('strava', ?, ?, ?, 'activity:read_all', ?, datetime('now'))
     ON CONFLICT(provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       external_id = excluded.external_id,
       updated_at = datetime('now')`,
    [
      tok.access_token,
      tok.refresh_token,
      tok.expires_at,
      tok.athlete?.id ? String(tok.athlete.id) : null,
    ]
  )
}

/** Return a valid access token, refreshing if it's within 60s of expiry. */
export async function getAccessToken(): Promise<string | null> {
  const row = await queryOne<{
    access_token: string
    refresh_token: string
    expires_at: number
  }>(`SELECT access_token, refresh_token, expires_at FROM integrations WHERE provider = 'strava'`)
  if (!row) return null

  const now = Math.floor(Date.now() / 1000)
  if (row.expires_at > now + 60) return row.access_token

  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: Deno.env.get('STRAVA_CLIENT_ID'),
      client_secret: Deno.env.get('STRAVA_CLIENT_SECRET'),
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    }),
  })
  if (!res.ok) {
    console.error('strava refresh failed', await res.text())
    return null
  }
  const tok = (await res.json()) as StravaToken
  await storeTokens(tok)
  return tok.access_token
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

interface StravaActivity {
  id: number
  name: string
  type: string
  sport_type?: string
  distance: number // meters
  moving_time: number // seconds
  total_elevation_gain: number // meters
  start_date_local: string // ISO; prefer local per repo MCP-data rule
  average_heartrate?: number
  max_heartrate?: number
}

/**
 * Pull recent activities, upsert runs, and match them to planned workouts.
 * `afterEpoch` defaults to the active plan's start date.
 * Returns { fetched, runs_upserted, matched }.
 */
export async function syncStrava(afterEpoch?: number): Promise<{
  fetched: number
  upserted: number
  matched: number
}> {
  const token = await getAccessToken()
  if (!token) throw new Error('strava not connected')

  const plan = await getActivePlan()
  const after = afterEpoch ?? (plan ? Math.floor(Date.parse(plan.start_date) / 1000) : 0)

  let page = 1
  let fetched = 0
  let upserted = 0
  const touchedDates: string[] = []

  // Strava paginates; cap at a few pages for a slim sync.
  while (page <= 5) {
    const res = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!res.ok) throw new Error(`strava activities failed: ${await res.text()}`)
    const acts = (await res.json()) as StravaActivity[]
    if (!acts.length) break
    fetched += acts.length

    for (const a of acts) {
      if (!RUN_TYPES.has(a.sport_type ?? a.type)) continue
      const miles = a.distance / METERS_PER_MILE
      if (miles < 0.5) continue // ignore noise
      const date = a.start_date_local.slice(0, 10)
      const pace = a.moving_time / miles
      const changed = await insert(
        `INSERT INTO runs
           (strava_activity_id, date, distance_mi, moving_time_s, avg_pace_s,
            avg_hr, max_hr, elev_gain_ft, name, type, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(strava_activity_id) DO UPDATE SET
           distance_mi = excluded.distance_mi,
           moving_time_s = excluded.moving_time_s,
           avg_pace_s = excluded.avg_pace_s,
           avg_hr = excluded.avg_hr,
           max_hr = excluded.max_hr,
           elev_gain_ft = excluded.elev_gain_ft,
           name = excluded.name`,
        [
          String(a.id),
          date,
          round1(miles),
          a.moving_time,
          Math.round(pace),
          a.average_heartrate ? Math.round(a.average_heartrate) : null,
          a.max_heartrate ? Math.round(a.max_heartrate) : null,
          a.total_elevation_gain ? Math.round(a.total_elevation_gain * FEET_PER_METER) : null,
          a.name ?? 'Run',
          a.sport_type ?? a.type,
          JSON.stringify(a).slice(0, 4000),
        ]
      )
      upserted += changed > 0 ? 1 : 0
      touchedDates.push(date)
    }
    if (acts.length < 100) break
    page++
  }

  let matched = 0
  if (plan) {
    matched = await matchRuns(plan.id)
    // Past planned runs with no actual become 'missed' so adherence isn't
    // inflated by silently-skipped sessions. Today is left as 'planned'.
    const today = new Date().toISOString().slice(0, 10)
    await reconcileMissed(plan.id, today)
  }
  return { fetched, upserted, matched }
}

/**
 * Link unmatched runs to a planned workout on the same date and mark that
 * workout done. One run per workout; extra runs on a day stay unmatched (still
 * counted in "miles earned"). Returns the number of workouts newly marked done.
 */
export async function matchRuns(planId: number): Promise<number> {
  const runs = await query<{ id: number; date: string }>(
    `SELECT id, date FROM runs WHERE workout_id IS NULL ORDER BY date`
  )
  let matched = 0
  for (const r of runs) {
    const w = await queryOne<{ id: number }>(
      `SELECT id FROM workouts
       WHERE plan_id = ? AND date = ? AND kind != 'rest' AND status != 'done'
       ORDER BY id LIMIT 1`,
      [planId, r.date]
    )
    if (!w) continue
    await run(`UPDATE runs SET workout_id = ? WHERE id = ?`, [w.id, r.id])
    await run(`UPDATE workouts SET status = 'done' WHERE id = ?`, [w.id])
    matched++
  }
  return matched
}

/** Mark past planned runs with no matching actual as missed (through `throughDate`). */
export async function reconcileMissed(planId: number, throughDate: string): Promise<number> {
  const res = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM workouts
     WHERE plan_id = ? AND date < ? AND kind != 'rest' AND status = 'planned'`,
    [planId, throughDate]
  )
  await run(
    `UPDATE workouts SET status = 'missed'
     WHERE plan_id = ? AND date < ? AND kind != 'rest' AND status = 'planned'`,
    [planId, throughDate]
  )
  return res[0]?.n ?? 0
}

export async function stravaStatus(): Promise<{
  connected: boolean
  athlete_id: string | null
  last_run: string | null
}> {
  const row = await queryOne<{ external_id: string }>(
    `SELECT external_id FROM integrations WHERE provider = 'strava'`
  )
  const last = await queryOne<{ date: string }>(`SELECT date FROM runs ORDER BY date DESC LIMIT 1`)
  return {
    connected: !!row,
    athlete_id: row?.external_id ?? null,
    last_run: last?.date ?? null,
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
