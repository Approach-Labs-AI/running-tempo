// dashboard.ts — password-gated web dashboard for Tempo (Val Town http val).
// Routing + cookie auth; rendering lives in views.ts, data in db.ts.
// Set DASHBOARD_PASSWORD in the Val Town env (web UI).

import type { Hono } from 'npm:hono@4'
import { setCookie } from 'npm:hono@4/cookie'
import {
  getActivePlan,
  getWeeks,
  initSchema,
  Plan,
  PlanWeek,
  query,
  queryOne,
  Workout,
} from './db.ts'
import { onTrackVerdict, paceZones, fmtPace } from './engine.ts'
import { stravaStatus, syncStrava } from './strava.ts'
import { gcalStatus, pushWorkouts } from './gcal.ts'
import { getReviews } from './review.ts'
import { COOKIE, requireAuth, sessionToken } from './auth.ts'
import {
  OverviewData,
  renderCalendar,
  renderLogin,
  renderOverview,
  renderSettings,
} from './views.ts'

/** Register the password-gated dashboard pages onto the shared app. */
export function registerDashboard(app: Hono) {
  app.get('/login', (c) => c.html(renderLogin()))

  app.post('/login', async (c) => {
    const form = await c.req.parseBody()
    const pw = Deno.env.get('DASHBOARD_PASSWORD')
    if (pw && form.password === pw) {
      // Store hash(password), never the raw secret (see auth.ts).
      setCookie(c, COOKIE, (await sessionToken()) ?? '', {
        httpOnly: true,
        secure: true,
        maxAge: 60 * 60 * 24 * 30,
        path: '/',
      })
      return c.redirect('/')
    }
    return c.html(renderLogin('Wrong password'))
  })

  app.get('/logout', (c) => {
    setCookie(c, COOKIE, '', { maxAge: 0, path: '/' })
    return c.redirect('/login')
  })

  // Page guards — scoped to exact dashboard paths so /api is untouched (it has
  // its own bearer auth). OAuth routes guard themselves in strava.ts/gcal.ts.
  app.use('/', requireAuth)
  app.use('/calendar', requireAuth)
  app.use('/settings', requireAuth)
  app.use('/sync', requireAuth)
  app.use('/push-calendar', requireAuth)

  app.get('/', async (c) => {
    await initSchema()
    const plan = await getActivePlan()
    if (!plan) return c.html(renderSettings(null))
    const data = await overviewData(plan)
    return c.html(renderOverview(data))
  })

  app.get('/calendar', async (c) => {
    const plan = await getActivePlan()
    if (!plan) return c.html(renderSettings(null))
    const weeks = await getWeeks(plan.id)
    return c.html(renderCalendar(plan, weeks))
  })

  app.get('/settings', async (c) => {
    const plan = await getActivePlan()
    const strava = await stravaStatus()
    const gcal = await gcalStatus()
    return c.html(renderSettings(plan, strava, gcal))
  })

  // Browser-triggered Strava sync (from the Settings page).
  app.get('/sync', async (c) => {
    try {
      await syncStrava()
    } catch (_e) {
      // surfaced on the settings page via status; ignore for the redirect
    }
    return c.redirect('/settings')
  })

  // Browser-triggered calendar push (from the Settings page).
  app.get('/push-calendar', async (c) => {
    const plan = await getActivePlan()
    if (plan) {
      try {
        await pushWorkouts(plan.id)
      } catch (_e) {
        // surfaced on the settings page via status; ignore for the redirect
      }
    }
    return c.redirect('/settings')
  })
}

// ---------------------------------------------------------------------------

async function overviewData(plan: Plan): Promise<OverviewData> {
  const today = new Date().toISOString().slice(0, 10)

  const week = await queryOne<PlanWeek>(
    `SELECT * FROM plan_weeks
     WHERE plan_id = ? AND start_date <= ? AND date(start_date,'+6 days') >= ?
     ORDER BY week_index LIMIT 1`,
    [plan.id, today, today]
  )

  const workouts = week
    ? await query<Workout>(`SELECT * FROM workouts WHERE week_id = ? ORDER BY date`, [week.id])
    : []

  const plannedToDate = await queryOne<{ mi: number }>(
    `SELECT COALESCE(SUM(planned_distance_mi),0) AS mi FROM workouts
     WHERE plan_id = ? AND date <= ?`,
    [plan.id, today]
  )
  const plannedTotal = await queryOne<{ mi: number }>(
    `SELECT COALESCE(SUM(planned_miles),0) AS mi FROM plan_weeks WHERE plan_id = ?`,
    [plan.id]
  )
  const earned = await queryOne<{ mi: number }>(
    `SELECT COALESCE(SUM(distance_mi),0) AS mi FROM runs WHERE date >= ?`,
    [plan.start_date]
  )

  const ptd = plannedToDate?.mi ?? 0
  const earnedMi = earned?.mi ?? 0
  const adherence = ptd > 0 ? Math.round((earnedMi / ptd) * 100) : 100
  const verdict = onTrackVerdict(plan, null, adherence)

  const z = paceZones(plan)
  const range = (r: { lo: number; hi: number }) =>
    r.lo === r.hi ? `${fmtPace(r.lo)}/mi` : `${fmtPace(r.lo)}–${fmtPace(r.hi)}/mi`

  return {
    plan,
    paces: {
      gmp: `${fmtPace(plan.gmp_s)}/mi`,
      easy: range(z.easy),
      long: range(z.long),
      tempo: range(z.tempo),
      interval: range(z.interval),
    },
    progress: {
      miles_earned: Math.round(earnedMi),
      planned_to_date: Math.round(ptd),
      planned_total: Math.round(plannedTotal?.mi ?? 0),
      adherence_pct: adherence,
      days_to_race: Math.max(0, Math.round((Date.parse(plan.race_date) - Date.now()) / 86_400_000)),
      verdict,
    },
    week: week ?? null,
    workouts,
    reviews: await getReviews(),
  }
}
