// plan.ts — orchestration: create plans, lay down the macro skeleton, and
// "detail" a ~8-week block into concrete workouts. Bridges engine.ts (pure
// logic) and db.ts (storage).

import { getActivePlan, getWeeks, insert, Plan, PlanWeek, query, run } from './db.ts'
import { buildSkeleton, buildWeekWorkouts, paceZones, parsePace, parseTime } from './engine.ts'

export interface CreatePlanInput {
  race_name: string
  race_date: string // YYYY-MM-DD
  goal_time: string // "3:00:00"
  gmp: string // "6:52"
  start_date: string // YYYY-MM-DD
  current_fitness?: string // "9:15"
  days_per_week?: number
  peak_weekly_miles?: number
  zones_json?: string
  /** Per-week overrides keyed by week_index: { planned_miles, long_run_mi }. */
  week_overrides?: Record<number, { planned_miles?: number; long_run_mi?: number }>
}

/** Create a plan, generate the full skeleton, and detail the first block. */
export async function createPlan(input: CreatePlanInput): Promise<number> {
  // Archive any existing active plan (single active plan at a time).
  await run(`UPDATE plans SET status = 'archived' WHERE status = 'active'`)

  const planId = await insert(
    `INSERT INTO plans
       (race_name, race_date, goal_time_s, gmp_s, start_date,
        current_fitness_s, days_per_week, peak_weekly_miles, zones_json, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    [
      input.race_name,
      input.race_date,
      parseTime(input.goal_time),
      parsePace(input.gmp),
      input.start_date,
      input.current_fitness ? parsePace(input.current_fitness) : null,
      input.days_per_week ?? 5,
      input.peak_weekly_miles ?? 55,
      input.zones_json ?? null,
    ]
  )

  await regenerateSkeleton(planId, input.week_overrides)
  await detailBlock(planId, 1, 8)
  return planId
}

/** (Re)build plan_weeks from the engine skeleton. Applies any week overrides. */
export async function regenerateSkeleton(
  planId: number,
  overrides?: CreatePlanInput['week_overrides']
): Promise<void> {
  const plan = await getPlanById(planId)
  if (!plan) throw new Error(`plan ${planId} not found`)

  await run(`DELETE FROM plan_weeks WHERE plan_id = ?`, [planId])
  const skeleton = buildSkeleton(plan)

  for (const wk of skeleton) {
    const ov = overrides?.[wk.week_index]
    const plannedMiles = ov?.planned_miles ?? wk.planned_miles
    const longRun = ov?.long_run_mi ?? wk.long_run_mi
    await insert(
      `INSERT INTO plan_weeks
         (plan_id, week_index, phase, start_date, planned_miles, long_run_mi, cutback, focus, detailed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [
        planId,
        wk.week_index,
        wk.phase,
        wk.start_date,
        plannedMiles,
        longRun,
        wk.cutback ? 1 : 0,
        wk.focus,
      ]
    )
  }
}

/**
 * Detail `count` weeks starting at `fromIndex` into concrete workouts.
 * Skips weeks that already have completed workouts (won't clobber history).
 */
export async function detailBlock(
  planId: number,
  fromIndex: number,
  count: number
): Promise<number> {
  const plan = await getPlanById(planId)
  if (!plan) throw new Error(`plan ${planId} not found`)
  const zones = paceZones(plan)
  const weeks = await getWeeks(planId)

  let created = 0
  for (const wk of weeks) {
    if (wk.week_index < fromIndex || wk.week_index >= fromIndex + count) continue

    const doneCount = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM workouts WHERE week_id = ? AND status IN ('done','missed')`,
      [wk.id]
    )
    if ((doneCount[0]?.n ?? 0) > 0) continue // preserve weeks in progress

    // Carry existing calendar links forward by date so re-detailing doesn't
    // orphan pushed events (the next /api/gcal/push then PATCHes, not POSTs).
    const priorEvents = await query<{ date: string; gcal_event_id: string }>(
      `SELECT date, gcal_event_id FROM workouts
       WHERE week_id = ? AND status = 'planned' AND gcal_event_id IS NOT NULL`,
      [wk.id]
    )
    const eventByDate = new Map(priorEvents.map((e) => [e.date, e.gcal_event_id]))

    await run(`DELETE FROM workouts WHERE week_id = ? AND status = 'planned'`, [wk.id])

    const planned = buildWeekWorkouts(plan, toSkeletonWeek(wk), zones)
    for (const w of planned) {
      await insert(
        `INSERT INTO workouts
           (plan_id, week_id, date, kind, title, description, planned_distance_mi,
            pace_lo_s, pace_hi_s, strides, gcal_event_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')`,
        [
          planId,
          wk.id,
          w.date,
          w.kind,
          w.title,
          w.description,
          w.planned_distance_mi,
          w.pace_lo_s,
          w.pace_hi_s,
          w.strides,
          eventByDate.get(w.date) ?? null,
        ]
      )
      created++
    }
    await run(`UPDATE plan_weeks SET detailed = 1 WHERE id = ?`, [wk.id])
  }
  return created
}

function toSkeletonWeek(wk: PlanWeek) {
  return {
    week_index: wk.week_index,
    phase: wk.phase,
    start_date: wk.start_date,
    planned_miles: wk.planned_miles,
    long_run_mi: wk.long_run_mi,
    cutback: !!wk.cutback,
    focus: wk.focus,
  }
}

async function getPlanById(id: number): Promise<Plan | null> {
  const rows = await query<Plan>(`SELECT * FROM plans WHERE id = ?`, [id])
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Concrete seed: Kevin's sub-3:00 Houston build (from the planning brief)
// ---------------------------------------------------------------------------

/** First 8 weeks (Base) — exact mileage + long-run targets from the brief. */
const KEVIN_BASE_OVERRIDES: CreatePlanInput['week_overrides'] = {
  1: { planned_miles: 12, long_run_mi: 4 },
  2: { planned_miles: 14, long_run_mi: 5 },
  3: { planned_miles: 16, long_run_mi: 6 },
  4: { planned_miles: 13, long_run_mi: 4 },
  5: { planned_miles: 18, long_run_mi: 7 },
  6: { planned_miles: 21, long_run_mi: 8 },
  7: { planned_miles: 24, long_run_mi: 10 },
  8: { planned_miles: 20, long_run_mi: 8 },
}

export async function seedHoustonSub3(): Promise<number> {
  return createPlan({
    race_name: 'Houston Marathon',
    race_date: '2027-01-18',
    goal_time: '3:00:00',
    gmp: '6:52',
    start_date: '2026-06-15',
    current_fitness: '9:15',
    days_per_week: 5,
    peak_weekly_miles: 55,
    week_overrides: KEVIN_BASE_OVERRIDES,
  })
}
