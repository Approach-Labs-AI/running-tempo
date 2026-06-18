// review.ts — headless weekly training review (the P4 "Sunday reconcile").
// Computes one plan-week's running adherence (planned vs actual, miles earned,
// easy pace, on-track verdict), stores a snapshot in `reviews`, and writes a
// dated note to the training log. Runs from the Sunday cron (weekly.ts) and is
// fully API-drivable (GET /api/review, POST /api/review/run) so Claude Code or
// curl can trigger/read it on demand.

import type { Hono } from 'npm:hono@4'
import {
  getActivePlan,
  prependLogEntry,
  query,
  queryOne,
  Plan,
  PlanWeek,
  Review,
  run,
} from './db.ts'
import { fmtPace, onTrackVerdict } from './engine.ts'

const LOG_BLOB = 'tempo-training-log'

function isoToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The plan week to review: the most recent one that has started (on Sunday,
 *  that's the week ending today). Returns null if the plan hasn't begun. */
async function weekToReview(planId: number, asOf: string): Promise<PlanWeek | null> {
  return queryOne<PlanWeek>(
    `SELECT * FROM plan_weeks
     WHERE plan_id = ? AND start_date <= ?
     ORDER BY week_index DESC LIMIT 1`,
    [planId, asOf]
  )
}

interface WeekReview {
  plan_id: number
  user_id: number
  week_index: number
  week_start: string
  week_end: string
  planned_mi: number
  earned_mi: number
  adherence_pct: number
  sessions_done: number
  sessions_planned: number
  avg_easy_pace_s: number | null
  verdict: string
  summary: string
}

/** Compute (without storing) the running-adherence review for one plan week. */
export async function computeWeekReview(
  plan: Plan,
  week: PlanWeek,
  userId = 0
): Promise<WeekReview> {
  const weekStart = week.start_date
  const weekEnd = addDays(weekStart, 6)

  const planned = await queryOne<{ mi: number; n: number }>(
    `SELECT COALESCE(SUM(planned_distance_mi),0) AS mi, COUNT(*) AS n
     FROM workouts WHERE week_id = ? AND kind != 'rest'`,
    [week.id]
  )
  const done = await queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM workouts WHERE week_id = ? AND kind != 'rest' AND status = 'done'`,
    [week.id]
  )
  const earned = await queryOne<{ mi: number }>(
    `SELECT COALESCE(SUM(distance_mi),0) AS mi FROM runs
     WHERE user_id = ? AND date >= ? AND date <= ?`,
    [userId, weekStart, weekEnd]
  )
  const easy = await queryOne<{ p: number | null }>(
    `SELECT AVG(avg_pace_s) AS p FROM runs
     WHERE user_id = ? AND date >= ? AND date <= ? AND distance_mi >= 2`,
    [userId, weekStart, weekEnd]
  )

  const plannedMi = round1(planned?.mi ?? 0)
  const earnedMi = round1(earned?.mi ?? 0)
  const sessionsPlanned = planned?.n ?? 0
  const sessionsDone = done?.n ?? 0
  const avgEasy = easy?.p != null ? Math.round(easy.p) : null
  // Mirror progress(): 100% only when nothing was planned; a real 0 stays 0.
  const adherence = plannedMi > 0 ? Math.round((earnedMi / plannedMi) * 100) : 100
  const verdict = onTrackVerdict(plan, avgEasy, adherence)

  const paceStr = avgEasy != null ? `${fmtPace(avgEasy)}/mi avg easy` : 'no easy runs logged'
  const summary =
    `Week ${week.week_index} (${week.phase}${week.cutback ? ', cutback' : ''}): ` +
    `${earnedMi} of ${plannedMi} mi planned (${adherence}%), ` +
    `${sessionsDone}/${sessionsPlanned} sessions done · ${paceStr}. ` +
    verdict.note

  return {
    plan_id: plan.id,
    user_id: userId,
    week_index: week.week_index,
    week_start: weekStart,
    week_end: weekEnd,
    planned_mi: plannedMi,
    earned_mi: earnedMi,
    adherence_pct: adherence,
    sessions_done: sessionsDone,
    sessions_planned: sessionsPlanned,
    avg_easy_pace_s: avgEasy,
    verdict: verdict.status,
    summary,
  }
}

/** Compute + persist the current week's review, and log a dated note.
 *  Idempotent: re-running the same plan-week updates that row in place. */
export async function runWeeklyReview(userId = 0): Promise<WeekReview | null> {
  const plan = await getActivePlan(userId)
  if (!plan) return null
  const week = await weekToReview(plan.id, isoToday())
  if (!week) return null

  const r = await computeWeekReview(plan, week, userId)
  await run(
    `INSERT INTO reviews
       (user_id, plan_id, week_index, week_start, week_end, planned_mi, earned_mi,
        adherence_pct, sessions_done, sessions_planned, avg_easy_pace_s, verdict, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(plan_id, week_index) DO UPDATE SET
       earned_mi = excluded.earned_mi,
       planned_mi = excluded.planned_mi,
       adherence_pct = excluded.adherence_pct,
       sessions_done = excluded.sessions_done,
       sessions_planned = excluded.sessions_planned,
       avg_easy_pace_s = excluded.avg_easy_pace_s,
       verdict = excluded.verdict,
       summary = excluded.summary,
       created_at = datetime('now')`,
    [
      r.user_id,
      r.plan_id,
      r.week_index,
      r.week_start,
      r.week_end,
      r.planned_mi,
      r.earned_mi,
      r.adherence_pct,
      r.sessions_done,
      r.sessions_planned,
      r.avg_easy_pace_s,
      r.verdict,
      r.summary,
    ]
  )
  await prependLogEntry(LOG_BLOB, `Week ${r.week_index} review`, r.summary)
  return r
}

export async function getLatestReview(userId = 0): Promise<Review | null> {
  return queryOne<Review>(
    `SELECT * FROM reviews WHERE user_id = ? ORDER BY week_index DESC LIMIT 1`,
    [userId]
  )
}

export async function getReviews(userId = 0, limit = 12): Promise<Review[]> {
  return query<Review>(
    `SELECT * FROM reviews WHERE user_id = ? ORDER BY week_index DESC LIMIT ?`,
    [userId, limit]
  )
}

/** Register the headless review API onto the shared app (under /api/* bearer auth). */
export function registerReview(app: Hono) {
  app.get('/api/review', async (c) => {
    const latest = await getLatestReview()
    const history = await getReviews()
    return c.json({ latest, history })
  })

  app.post('/api/review/run', async (c) => {
    const review = await runWeeklyReview()
    if (!review) return c.json({ error: 'no active plan or plan not started' }, 404)
    return c.json({ ok: true, review })
  })
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
