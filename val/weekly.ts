// weekly.ts — Val Town interval (cron) val: the headless Sunday reconcile.
// Set this val's schedule to Sundays (e.g. cron `0 18 * * 0`) in the Val Town
// UI. It computes + stores the week's running review and writes a training-log
// note. The same work is available on demand via POST /api/review/run.

import { initSchema } from './db.ts'
import { runWeeklyReview } from './review.ts'

export default async function weekly() {
  await initSchema()
  const review = await runWeeklyReview(0)
  if (!review) {
    console.log('[weekly] no active plan or plan not started — skipped')
    return
  }
  console.log(
    `[weekly] Week ${review.week_index}: ${review.earned_mi}/${review.planned_mi} mi ` +
      `(${review.adherence_pct}%) — ${review.verdict}`
  )
}
