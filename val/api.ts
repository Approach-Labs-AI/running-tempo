// api.ts — headless HTTP API for Tempo (Val Town http val).
// API-first: this is a first-class surface so a Claude Code skill (or any
// client) can drive the whole app. Bearer-auth except /api/health.
//
// Deploy: this file's val URL is the API base. Set TEMPO_API_SECRET in the
// Val Town env (web UI). See projects/running-tempo/CLAUDE.md.

import type { Hono } from 'npm:hono@4'
import {
  getActivePlan,
  getBlobText,
  getWeeks,
  getWorkouts,
  initSchema,
  prependLogEntry,
  query,
  queryOne,
  run,
  setBlobText,
  Workout,
  WORKOUT_STATUSES,
  WorkoutStatus,
} from './db.ts'
import { fmtPace, onTrackVerdict, paceZones, projectMarathonFromHalf } from './engine.ts'
import { createPlan, CreatePlanInput, detailBlock, seedHoustonSub3 } from './plan.ts'
import { stravaStatus, syncStrava } from './strava.ts'
import { gcalStatus, pushWorkouts } from './gcal.ts'

const LOG_BLOB = 'tempo-training-log'

/** Register all /api/* routes onto the shared app. */
export function registerApi(app: Hono) {
  // --- auth ----------------------------------------------------------------
  app.use('/api/*', async (c, next) => {
    if (c.req.path === '/api/health') return next()
    const secret = Deno.env.get('TEMPO_API_SECRET')
    const auth = c.req.header('Authorization') ?? ''
    if (!secret || auth !== `Bearer ${secret}`) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    return next()
  })

  // --- meta ------------------------------------------------------------------
  app.get('/api/health', (c) => c.json({ ok: true, service: 'running-tempo' }))

  // --- plan ------------------------------------------------------------------
  app.get('/api/plan', async (c) => {
    await initSchema()
    const plan = await getActivePlan()
    if (!plan) return c.json({ error: 'no active plan' }, 404)
    return c.json({ plan, paces: paceSummary(plan), progress: await progress() })
  })

  app.post('/api/plan', async (c) => {
    await initSchema()
    const body = (await c.req.json()) as CreatePlanInput
    const id = await createPlan(body)
    const plan = await getActivePlan()
    return c.json({ id, plan, paces: plan ? paceSummary(plan) : null })
  })

  // Convenience: seed Kevin's Houston sub-3 plan.
  app.post('/api/plan/seed-houston', async (c) => {
    await initSchema()
    const id = await seedHoustonSub3()
    return c.json({ id, seeded: 'houston-sub3' })
  })

  // Regenerate the next detailed block from a given week (the retro action).
  app.post('/api/plan/block', async (c) => {
    const plan = await getActivePlan()
    if (!plan) return c.json({ error: 'no active plan' }, 404)
    const body = (await c.req.json().catch(() => ({}))) as {
      from_week?: number
      count?: number
    }
    const from = body.from_week ?? (await nextUndetailedWeek(plan.id)) ?? 1
    const created = await detailBlock(plan.id, from, body.count ?? 8)
    return c.json({ ok: true, from_week: from, workouts_created: created })
  })

  // --- weeks / workouts ------------------------------------------------------
  app.get('/api/weeks', async (c) => {
    const plan = await getActivePlan()
    if (!plan) return c.json({ error: 'no active plan' }, 404)
    const weeks = await getWeeks(plan.id)
    const detailedOnly = c.req.query('detailed') === 'true'
    return c.json({ weeks: detailedOnly ? weeks.filter((w) => w.detailed) : weeks })
  })

  app.get('/api/workouts', async (c) => {
    const plan = await getActivePlan()
    if (!plan) return c.json({ error: 'no active plan' }, 404)
    const from = c.req.query('from')
    const to = c.req.query('to')
    const workouts = await getWorkouts(plan.id, from === 'today' ? isoToday() : from, to)
    return c.json({ workouts })
  })

  app.patch('/api/workouts/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const body = (await c.req.json()) as Partial<Workout>
    const fields: string[] = []
    const args: (string | number | null)[] = []
    for (const k of [
      'date',
      'kind',
      'title',
      'description',
      'planned_distance_mi',
      'pace_lo_s',
      'pace_hi_s',
      'strides',
      'status',
    ] as const) {
      if (k in body) {
        if (k === 'status' && !WORKOUT_STATUSES.includes(body.status as WorkoutStatus)) {
          return c.json({ error: `invalid status; use one of ${WORKOUT_STATUSES.join(', ')}` }, 400)
        }
        fields.push(`${k} = ?`)
        args.push((body as Record<string, string | number | null>)[k])
      }
    }
    if (!fields.length) return c.json({ error: 'no fields' }, 400)
    args.push(id)
    await run(`UPDATE workouts SET ${fields.join(', ')} WHERE id = ?`, args)
    return c.json({ ok: true })
  })

  app.post('/api/workouts/:id/complete', async (c) => {
    const id = Number(c.req.param('id'))
    const body = (await c.req.json().catch(() => ({}))) as { status?: string }
    const status = body.status ?? 'done'
    if (!WORKOUT_STATUSES.includes(status as WorkoutStatus)) {
      return c.json({ error: `invalid status; use one of ${WORKOUT_STATUSES.join(', ')}` }, 400)
    }
    await run(`UPDATE workouts SET status = ? WHERE id = ?`, [status, id])
    return c.json({ ok: true })
  })

  // --- runs (actuals) --------------------------------------------------------
  app.get('/api/runs', async (c) => {
    const limit = Number(c.req.query('limit') ?? 50)
    const runs = await query(`SELECT * FROM runs ORDER BY date DESC LIMIT ?`, [limit])
    return c.json({ runs })
  })

  // --- paces / progress ------------------------------------------------------
  app.get('/api/paces', async (c) => {
    const plan = await getActivePlan()
    if (!plan) return c.json({ error: 'no active plan' }, 404)
    return c.json({ paces: paceSummary(plan) })
  })

  app.get('/api/progress', async (c) => {
    return c.json(await progress())
  })

  // --- projection from a tune-up half ---------------------------------------
  app.post('/api/project/half', async (c) => {
    const body = (await c.req.json()) as { half_time: string }
    const [h, m, s] = body.half_time.split(':').map(Number)
    const secs = body.half_time.split(':').length === 3 ? h * 3600 + m * 60 + s : h * 60 + m
    const marathon = projectMarathonFromHalf(secs)
    return c.json({
      projected_marathon_s: Math.round(marathon),
      projected_marathon: hms(marathon),
      sub3: marathon < 10800,
    })
  })

  // --- Strava (P2) -----------------------------------------------------------
  app.get('/api/strava/status', async (c) => {
    return c.json(await stravaStatus())
  })

  app.post('/api/sync/strava', async (c) => {
    try {
      const result = await syncStrava()
      return c.json({ ok: true, ...result })
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e) }, 502)
    }
  })

  // --- Google Calendar (P3) --------------------------------------------------
  app.get('/api/gcal/status', async (c) => {
    return c.json(await gcalStatus())
  })

  app.post('/api/gcal/push', async (c) => {
    const plan = await getActivePlan()
    if (!plan) return c.json({ error: 'no active plan' }, 404)
    try {
      const result = await pushWorkouts(plan.id)
      return c.json({ ok: true, ...result })
    } catch (e) {
      return c.json({ error: String(e instanceof Error ? e.message : e) }, 502)
    }
  })

  // --- Training log (headless coaching notes) --------------------------------
  app.get('/api/log', async (c) => {
    return c.json({ log: await getBlobText(LOG_BLOB) })
  })

  app.put('/api/log', async (c) => {
    const body = (await c.req.json()) as { text: string }
    await setBlobText(LOG_BLOB, body.text ?? '')
    return c.json({ ok: true })
  })

  app.post('/api/log/entry', async (c) => {
    const body = (await c.req.json()) as { title: string; body: string }
    if (!body.title || !body.body) return c.json({ error: 'title and body required' }, 400)
    await prependLogEntry(LOG_BLOB, body.title, body.body)
    return c.json({ ok: true })
  })

  // --- P4 stubs (wired up in later phases) -----------------------------------
  app.post('/api/adjust', (c) => c.json({ error: 'AI block adjustment ships in P4' }, 501))
  app.post('/api/nudge/test', (c) => c.json({ error: 'nudges ship in P4' }, 501))
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function hms(totalS: number): string {
  const s = Math.round(totalS)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return `${h}:${m.toString().padStart(2, '0')}:${r.toString().padStart(2, '0')}`
}

function paceSummary(plan: Parameters<typeof paceZones>[0]) {
  const z = paceZones(plan)
  const fmtRange = (r: { lo: number; hi: number }) =>
    r.lo === r.hi ? `${fmtPace(r.lo)}/mi` : `${fmtPace(r.lo)}–${fmtPace(r.hi)}/mi`
  return {
    gmp: `${fmtPace(plan.gmp_s)}/mi`,
    easy: fmtRange(z.easy),
    long: fmtRange(z.long),
    tempo: fmtRange(z.tempo),
    interval: fmtRange(z.interval),
  }
}

async function nextUndetailedWeek(planId: number): Promise<number | null> {
  const row = await queryOne<{ week_index: number }>(
    `SELECT week_index FROM plan_weeks WHERE plan_id = ? AND detailed = 0 ORDER BY week_index LIMIT 1`,
    [planId]
  )
  return row?.week_index ?? null
}

/** Season totals: planned-to-date vs miles earned (actual), adherence, verdict. */
async function progress() {
  const plan = await getActivePlan()
  if (!plan) return { error: 'no active plan' }
  const today = isoToday()

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
  const recentEasy = await queryOne<{ p: number }>(
    `SELECT AVG(avg_pace_s) AS p FROM runs
     WHERE date >= date('now','-21 days') AND distance_mi >= 2`
  )

  const ptd = plannedToDate?.mi ?? 0
  const earnedMi = earned?.mi ?? 0
  // Adherence is 100 only when nothing is planned-to-date yet; a real 0% (miles
  // planned, none run) must stay 0 so the verdict reads 'behind', matching the
  // dashboard. (Do NOT use `adherence || 100` — it coerces a genuine 0 to 100.)
  const adherence = ptd > 0 ? Math.round((earnedMi / ptd) * 100) : 100
  const verdict = onTrackVerdict(plan, recentEasy?.p ?? null, adherence)

  return {
    miles_earned: Math.round(earnedMi),
    planned_to_date: Math.round(ptd),
    planned_total: Math.round(plannedTotal?.mi ?? 0),
    adherence_pct: adherence,
    recent_easy_pace: recentEasy?.p ? `${fmtPace(recentEasy.p)}/mi` : null,
    days_to_race: Math.max(0, Math.round((Date.parse(plan.race_date) - Date.now()) / 86_400_000)),
    verdict,
  }
}
