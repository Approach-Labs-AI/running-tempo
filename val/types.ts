// types.ts — pure domain types + constants. NO runtime/remote imports, so this
// is safe to import anywhere (including offline unit tests of engine.ts).

// --- phases & workout kinds ------------------------------------------------

export const PHASES = ['base', 'build', 'specific', 'taper'] as const
export type Phase = (typeof PHASES)[number]

/** Workout kinds the app schedules (runs only for v1 — no lifts). */
export const WORKOUT_KINDS = ['easy', 'long', 'gmp', 'tempo', 'interval', 'rest', 'race'] as const
export type WorkoutKind = (typeof WORKOUT_KINDS)[number]

/** Which kinds are "quality" (capped at 2/week in build phases). */
export const QUALITY_KINDS: WorkoutKind[] = ['gmp', 'tempo', 'interval']

/** Valid workout lifecycle states. */
export const WORKOUT_STATUSES = ['planned', 'done', 'missed', 'skipped'] as const
export type WorkoutStatus = (typeof WORKOUT_STATUSES)[number]

/**
 * Default pace zones as offsets from Goal Marathon Pace (GMP), in seconds/mile.
 * Easy is governed by *current* aerobic fitness early on, so its offset is wide
 * and gets tightened toward GMP+easy as fitness improves (via retro adjustment).
 * Seed values match the sub-3 brief (GMP 6:52 = 412 s/mi):
 *   easy 8:45–9:30, tempo 6:20–6:35, interval 5:50–6:10.
 */
export const ZONE_OFFSETS_FROM_GMP = {
  easy: { lo: +113, hi: +158 }, // 8:45–9:30 at GMP 6:52
  long: { lo: +113, hi: +158 }, // easy effort; GMP segments added in 'specific'
  gmp: { lo: 0, hi: 0 }, // on the number
  tempo: { lo: -32, hi: -17 }, // 6:20–6:35
  interval: { lo: -62, hi: -42 }, // 5:50–6:10
  rest: { lo: 0, hi: 0 },
  race: { lo: 0, hi: 0 }, // run it at GMP
} as const

// --- row shapes ------------------------------------------------------------

/** A person. Identity is anchored on the Google account (sign-in); Strava is
 *  linked afterward. `user_id = 0` is reserved for the legacy single-user /
 *  headless-admin store so pre-multi-user data and the bearer API keep working. */
export interface User {
  id: number
  google_sub: string // stable Google account id (the identity anchor)
  email: string | null
  name: string | null
  strava_athlete_id: string | null // linked once the user connects Strava
  created_at: string
}

export interface Session {
  token: string
  user_id: number
  created_at: string
  expires_at: number // epoch seconds
}

export interface Plan {
  id: number
  user_id: number // 0 = legacy/admin single-user store
  race_name: string
  race_date: string // ISO date (YYYY-MM-DD)
  goal_time_s: number // 3:00:00 = 10800
  gmp_s: number // 6:52/mi = 412
  start_date: string // ISO date
  current_fitness_s: number | null // recent easy pace s/mi (e.g. 9:15 = 555)
  days_per_week: number
  peak_weekly_miles: number
  zones_json: string | null // overridden pace zones { kind: {lo,hi} } s/mi
  status: string // active | archived
  created_at: string
  updated_at: string
}

export interface PlanWeek {
  id: number
  plan_id: number
  week_index: number // 1-based
  phase: Phase
  start_date: string // Monday ISO date
  planned_miles: number
  long_run_mi: number
  cutback: number // 0/1
  focus: string
  detailed: number // 0/1 — only the current ~8-wk block is detailed
  ai_note: string | null
  created_at: string
}

export interface Workout {
  id: number
  plan_id: number
  week_id: number
  date: string // ISO date
  kind: WorkoutKind
  title: string
  description: string
  planned_distance_mi: number
  pace_lo_s: number | null
  pace_hi_s: number | null
  strides: number
  structure_json: string | null
  gcal_event_id: string | null
  status: string // planned | done | missed | skipped
  created_at: string
}

export interface Run {
  id: number
  user_id: number // 0 = legacy/admin single-user store
  strava_activity_id: string
  workout_id: number | null
  date: string
  distance_mi: number
  moving_time_s: number
  avg_pace_s: number // s/mi
  avg_hr: number | null
  max_hr: number | null
  elev_gain_ft: number | null
  name: string
  type: string
  raw_json: string | null
  created_at: string
}
