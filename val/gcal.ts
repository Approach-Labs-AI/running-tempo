// gcal.ts — Google Calendar integration for Tempo (registers onto app.ts).
// OAuth connect/callback, token refresh, and one-way push of scheduled workouts
// to the user's primary calendar as timed events with reminders. The calendar
// event reminders ARE the morning-of accountability nudge for the MVP.
//
// Env (Val Town web UI): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
// Optional: GOOGLE_REDIRECT_URI (else derived from request origin).

import type { Hono } from 'npm:hono@4'
import { getActivePlan, getSetting, query, queryOne, run, Workout } from './db.ts'
import { fmtPace } from './engine.ts'
import { requireAuth } from './auth.ts'

const SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const DEFAULT_RUN_TIME = '06:30' // local wall-clock start for scheduled runs
const DEFAULT_TZ = 'America/Los_Angeles'

function redirectUri(reqUrl: string): string {
  return Deno.env.get('GOOGLE_REDIRECT_URI') ?? new URL(reqUrl).origin + '/gcal/callback'
}

export function registerGcal(app: Hono) {
  // Same as Strava: OAuth connect/callback require a dashboard session.
  app.use('/gcal/*', requireAuth)

  app.get('/gcal/connect', (c) => {
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
    if (!clientId) return c.text('GOOGLE_CLIENT_ID not set', 500)
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', redirectUri(c.req.url))
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', SCOPE)
    url.searchParams.set('access_type', 'offline') // get a refresh token
    url.searchParams.set('prompt', 'consent')
    return c.redirect(url.toString())
  })

  app.get('/gcal/callback', async (c) => {
    const code = c.req.query('code')
    if (!code) return c.text('missing code', 400)
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
        client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri(c.req.url),
      }),
    })
    if (!res.ok) return c.text(`google token exchange failed: ${await res.text()}`, 502)
    const tok = await res.json()
    await storeTokens(tok)
    const plan = await getActivePlan()
    if (plan) await pushWorkouts(plan.id)
    return c.redirect('/settings')
  })
}

interface GoogleToken {
  access_token: string
  refresh_token?: string
  expires_in: number // seconds from now
}

async function storeTokens(tok: GoogleToken): Promise<void> {
  const expiresAt = Math.floor(Date.now() / 1000) + (tok.expires_in ?? 3600)
  // Keep the existing refresh token if Google omits it on re-consent.
  const existing = await queryOne<{ refresh_token: string }>(
    `SELECT refresh_token FROM integrations WHERE provider = 'google'`
  )
  const refresh = tok.refresh_token ?? existing?.refresh_token ?? null
  await run(
    `INSERT INTO integrations (provider, access_token, refresh_token, expires_at, scope, updated_at)
     VALUES ('google', ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at,
       updated_at = datetime('now')`,
    [tok.access_token, refresh, expiresAt, SCOPE]
  )
}

export async function getAccessToken(): Promise<string | null> {
  const row = await queryOne<{
    access_token: string
    refresh_token: string
    expires_at: number
  }>(`SELECT access_token, refresh_token, expires_at FROM integrations WHERE provider = 'google'`)
  if (!row) return null

  const now = Math.floor(Date.now() / 1000)
  if (row.expires_at > now + 60) return row.access_token
  if (!row.refresh_token) return null

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
    }),
  })
  if (!res.ok) {
    console.error('google refresh failed', await res.text())
    return null
  }
  const tok = (await res.json()) as GoogleToken
  await storeTokens(tok)
  return tok.access_token
}

// ---------------------------------------------------------------------------
// Push workouts → calendar events (idempotent via stored gcal_event_id)
// ---------------------------------------------------------------------------

/**
 * Upsert a calendar event for every scheduled (non-rest) workout from today
 * forward. Timed events at the configured local start, with popup + email
 * reminders — these are the morning-of nudge for the MVP.
 * Returns { created, updated }.
 */
export async function pushWorkouts(planId: number): Promise<{ created: number; updated: number }> {
  const token = await getAccessToken()
  if (!token) throw new Error('google calendar not connected')

  const tz = (await getSetting('timezone')) ?? DEFAULT_TZ
  const startTime = (await getSetting('run_time')) ?? DEFAULT_RUN_TIME
  const today = new Date().toISOString().slice(0, 10)

  const workouts = await query<Workout>(
    `SELECT * FROM workouts
     WHERE plan_id = ? AND kind != 'rest' AND date >= ?
     ORDER BY date`,
    [planId, today]
  )

  let created = 0
  let updated = 0
  for (const w of workouts) {
    const event = buildEvent(w, startTime, tz)
    if (w.gcal_event_id) {
      const patched = await gcalFetch(token, `events/${w.gcal_event_id}`, 'PATCH', event)
      if (patched?.id) {
        updated++
        continue
      }
      // PATCH failed (event likely deleted on the calendar) — drop the stale id
      // and fall through to recreate, so the workout isn't permanently orphaned.
      await run(`UPDATE workouts SET gcal_event_id = NULL WHERE id = ?`, [w.id])
    }
    const res = await gcalFetch(token, 'events', 'POST', event)
    if (res?.id) {
      await run(`UPDATE workouts SET gcal_event_id = ? WHERE id = ?`, [res.id, w.id])
      created++
    }
  }
  return { created, updated }
}

function buildEvent(w: Workout, startTime: string, tz: string) {
  const durationMin = estimateDurationMin(w)
  const [sh, sm] = startTime.split(':').map(Number)
  const startMins = sh * 60 + sm
  const endMins = Math.min(23 * 60 + 59, startMins + durationMin)
  const fmt = (mins: number) =>
    `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}:00`

  const paceLine =
    w.pace_lo_s != null
      ? `\nPace: ${
          w.pace_lo_s === w.pace_hi_s
            ? `${fmtPace(w.pace_lo_s)}/mi`
            : `${fmtPace(w.pace_lo_s)}–${fmtPace(w.pace_hi_s)}/mi`
        }`
      : ''

  return {
    summary: `🏃 ${w.title}`,
    description: `${w.description}${paceLine}\n\n— Tempo`,
    start: { dateTime: `${w.date}T${fmt(startMins)}`, timeZone: tz },
    end: { dateTime: `${w.date}T${fmt(endMins)}`, timeZone: tz },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 30 },
        { method: 'email', minutes: 60 },
      ],
    },
  }
}

/** Rough session duration from distance × pace (for the calendar block length). */
function estimateDurationMin(w: Workout): number {
  const pace = w.pace_lo_s != null && w.pace_hi_s != null ? (w.pace_lo_s + w.pace_hi_s) / 2 : 540 // 9:00/mi default
  const mins = (w.planned_distance_mi * pace) / 60
  return Math.max(20, Math.round(mins))
}

async function gcalFetch(
  token: string,
  path: string,
  method: string,
  body: unknown
): Promise<{ id?: string } | null> {
  const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    console.error(`gcal ${method} ${path} failed`, await res.text())
    return null
  }
  return res.json()
}

export async function gcalStatus(): Promise<{
  connected: boolean
  events_pushed: number
}> {
  const row = await queryOne<{ provider: string }>(
    `SELECT provider FROM integrations WHERE provider = 'google'`
  )
  const count = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM workouts WHERE gcal_event_id IS NOT NULL`
  )
  return { connected: !!row, events_pushed: count?.n ?? 0 }
}
