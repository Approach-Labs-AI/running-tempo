// engine.ts — the training brain (pure logic, no I/O).
// GMP-anchored pace zones, macro-cycle skeleton, weekly workout templates,
// cutback logic, and finish-time projection. Deterministic; Claude layers
// block-level adjustments on top at retro checkpoints (see coach-brain.ts).

import { Phase, Plan, WorkoutKind, ZONE_OFFSETS_FROM_GMP } from './types.ts'

// ---------------------------------------------------------------------------
// Pace formatting
// ---------------------------------------------------------------------------

/** 412 -> "6:52" */
export function fmtPace(secPerMile: number | null): string {
  if (secPerMile == null) return '—'
  const s = Math.round(secPerMile)
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${r.toString().padStart(2, '0')}`
}

/** "6:52" -> 412 */
export function parsePace(str: string): number {
  const [m, s] = str.split(':').map(Number)
  return m * 60 + (s || 0)
}

/** "3:00:00" -> 10800 */
export function parseTime(str: string): number {
  const parts = str.split(':').map(Number)
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  return parts[0]
}

export type PaceRange = { lo: number; hi: number }
export type Zones = Record<WorkoutKind, PaceRange>

/**
 * Pace zones for a plan. Uses an explicit override in `zones_json` if present,
 * else derives ranges from GMP via ZONE_OFFSETS_FROM_GMP.
 */
export function paceZones(plan: Plan): Zones {
  if (plan.zones_json) {
    try {
      return JSON.parse(plan.zones_json) as Zones
    } catch {
      /* fall through to derived */
    }
  }
  const z = {} as Zones
  for (const [kind, off] of Object.entries(ZONE_OFFSETS_FROM_GMP)) {
    z[kind as WorkoutKind] = {
      lo: plan.gmp_s + off.lo,
      hi: plan.gmp_s + off.hi,
    }
  }
  return z
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function addDays(iso: string, days: number): string {
  return isoDate(new Date(Date.parse(iso) + days * DAY_MS))
}

/** Monday on/before the given ISO date. */
export function mondayOf(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  const dow = d.getUTCDay() // 0 Sun .. 6 Sat
  const back = dow === 0 ? 6 : dow - 1
  return addDays(iso, -back)
}

/** Whole weeks between two Mondays (inclusive of start). */
export function weeksBetween(startIso: string, endIso: string): number {
  const a = Date.parse(mondayOf(startIso))
  const b = Date.parse(mondayOf(endIso))
  return Math.max(1, Math.round((b - a) / (7 * DAY_MS)) + 1)
}

// ---------------------------------------------------------------------------
// Phase assignment & mileage curve
// ---------------------------------------------------------------------------

/** Cutback every 4th week (week 4, 8, 12, ...). */
export function isCutback(weekIndex: number): boolean {
  return weekIndex % 4 === 0
}

/**
 * Assign a phase to every week, counting backward from the race:
 * last 3 weeks = taper, prior 8 = specific, prior 8 = build, rest = base.
 */
export function phaseForWeek(weekIndex: number, totalWeeks: number): Phase {
  const fromEnd = totalWeeks - weekIndex // 0 = race week
  if (fromEnd < 3) return 'taper'
  if (fromEnd < 3 + 8) return 'specific'
  if (fromEnd < 3 + 8 + 8) return 'build'
  return 'base'
}

export interface SkeletonWeek {
  week_index: number
  phase: Phase
  start_date: string // Monday
  planned_miles: number
  long_run_mi: number
  cutback: boolean
  focus: string
}

/**
 * Build the full macro skeleton: one row per week from start to race week.
 * Mileage ramps from the runner's current volume toward peak across base+build,
 * holds through specific, and drops in taper. Cutback weeks shed ~20%.
 */
export function buildSkeleton(plan: Plan): SkeletonWeek[] {
  const total = weeksBetween(plan.start_date, plan.race_date)
  const startMiles = estimateStartMiles(plan)
  const peak = plan.peak_weekly_miles
  const weeks: SkeletonWeek[] = []

  for (let i = 1; i <= total; i++) {
    const phase = phaseForWeek(i, total)
    const cutback = isCutback(i) && phase !== 'taper'

    // Ramp target (pre-cutback) as a function of phase progress.
    let target: number
    if (phase === 'base') {
      // Ramp start -> ~35 over the base block.
      const baseEnd = lastWeekOfPhase('base', total)
      target = lerp(startMiles, Math.min(35, peak), i / Math.max(1, baseEnd))
    } else if (phase === 'build') {
      const buildStart = lastWeekOfPhase('base', total) + 1
      const buildEnd = lastWeekOfPhase('build', total)
      const t = (i - buildStart + 1) / Math.max(1, buildEnd - buildStart + 1)
      target = lerp(Math.min(35, peak), peak, t)
    } else if (phase === 'specific') {
      target = peak // hold near peak with GMP-specific long runs
    } else {
      // taper: drop ~45% over the final weeks
      const fromEnd = total - i // 0 race week
      target = peak * (fromEnd === 0 ? 0.4 : fromEnd === 1 ? 0.55 : 0.7)
    }

    const planned = Math.round(cutback ? target * 0.8 : target)
    const longRun = longRunFor(phase, planned, i, total)

    weeks.push({
      week_index: i,
      phase,
      start_date: addDays(mondayOf(plan.start_date), (i - 1) * 7),
      planned_miles: planned,
      long_run_mi: longRun,
      cutback,
      focus: focusFor(phase, cutback),
    })
  }
  return weeks
}

function estimateStartMiles(plan: Plan): number {
  // If current fitness is much slower than GMP, start conservative.
  return 12
}

function lastWeekOfPhase(phase: Phase, total: number): number {
  for (let i = total; i >= 1; i--) {
    if (phaseForWeek(i, total) === phase) return i
  }
  return 1
}

function longRunFor(phase: Phase, weeklyMiles: number, weekIndex: number, total: number): number {
  if (phase === 'taper') return Math.round(weeklyMiles * 0.45)
  // Long run is ~33–40% of weekly volume, capped by phase ceilings.
  const cap = phase === 'base' ? 14 : phase === 'build' ? 20 : 22
  const ratio = phase === 'base' ? 0.4 : 0.36
  return Math.min(cap, Math.max(4, Math.round(weeklyMiles * ratio)))
}

function focusFor(phase: Phase, cutback: boolean): string {
  if (cutback) return 'Cutback — absorb the work, drop ~20% volume'
  switch (phase) {
    case 'base':
      return 'Easy aerobic volume + strides. No hard workouts.'
    case 'build':
      return 'Add one midweek quality session + the long run.'
    case 'specific':
      return 'Marathon-specific: GMP segments in the long run.'
    case 'taper':
      return 'Sharpen and freshen. Volume down, intensity touches.'
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.max(0, Math.min(1, t))
}

// ---------------------------------------------------------------------------
// Weekly workout template
// ---------------------------------------------------------------------------

export interface PlannedWorkout {
  date: string
  kind: WorkoutKind
  title: string
  description: string
  planned_distance_mi: number
  pace_lo_s: number | null
  pace_hi_s: number | null
  strides: number
}

/**
 * Turn one skeleton week into 7 scheduled workouts.
 * Anchors: Tue / Thu / Sat (Sat is always the long run). Mon/Fri rest.
 * Quality (tempo/interval/GMP) appears only from the build phase onward,
 * capped at one midweek session + the long run.
 */
export function buildWeekWorkouts(plan: Plan, week: SkeletonWeek, zones: Zones): PlannedWorkout[] {
  const monday = week.start_date
  const days = [...Array(7)].map((_, i) => addDays(monday, i)) // Mon..Sun
  const easy = zones.easy

  // How many easy "filler" miles to spread across Tue/Wed/Thu/Sun.
  const longRun = week.long_run_mi
  const easyBudget = Math.max(0, week.planned_miles - longRun)

  // Decide quality for build+ (alternate tempo / interval by week).
  const hasQuality = week.phase === 'build' || week.phase === 'specific'
  const qualityKind: WorkoutKind =
    week.phase === 'specific' ? 'tempo' : week.week_index % 2 === 0 ? 'interval' : 'tempo'

  // Number of running days: 5 (base early) up to 6.
  const runDays = week.planned_miles >= 30 ? 6 : 5

  const out: PlannedWorkout[] = []
  const rest = (date: string): PlannedWorkout => ({
    date,
    kind: 'rest',
    title: 'Rest',
    description: 'Full rest (or your own cross-training — not tracked here).',
    planned_distance_mi: 0,
    pace_lo_s: null,
    pace_hi_s: null,
    strides: 0,
  })

  const easyRun = (date: string, miles: number, strides = 0): PlannedWorkout => ({
    date,
    kind: 'easy',
    title: `Easy ${miles}${strides ? ` + ${strides} strides` : ''}`,
    description: strides
      ? `Conversational Zone 2. Finish with ${strides}×~20s relaxed strides.`
      : 'Conversational Zone 2 — keep it honest and easy.',
    planned_distance_mi: miles,
    pace_lo_s: easy.lo,
    pace_hi_s: easy.hi,
    strides,
  })

  // Split the easy budget: Wed/Sun smaller, Tue medium; Thu carries quality or easy.
  const fillerDays = runDays >= 6 ? 4 : 3 // Tue, (Wed), Thu, Sun
  const each = Math.max(2, Math.round(easyBudget / Math.max(1, fillerDays)))

  // Mon — rest
  out.push(rest(days[0]))

  // Tue — easy
  out.push(easyRun(days[1], each))

  // Wed — easy only on higher-volume weeks, else rest
  out.push(runDays >= 6 ? easyRun(days[2], Math.max(3, each - 1)) : rest(days[2]))

  // Thu — quality (build+) or easy + strides (base)
  if (hasQuality) {
    out.push(qualityWorkout(days[3], qualityKind, zones, week))
  } else {
    const strides = week.week_index >= 3 ? Math.min(6, 3 + (week.week_index % 4)) : 4
    out.push(easyRun(days[3], each, strides))
  }

  // Fri — rest
  out.push(rest(days[4]))

  // Sat — long run (with GMP segment in specific phase)
  out.push(longWorkout(days[5], longRun, zones, week))

  // Sun — easy shakeout
  out.push(easyRun(days[6], Math.max(2, each - 2)))

  // Cap at race day: drop any workout after the race, and convert the race-day
  // slot into the race itself. (The macro skeleton's final week can start on race
  // day when the race lands on a Monday — without this we'd schedule post-race
  // training and never schedule the race.)
  const raceDate = plan.race_date
  return out
    .filter((w) => w.date <= raceDate)
    .map((w) => (w.date === raceDate ? raceWorkout(w.date, zones) : w))
}

function raceWorkout(date: string, zones: Zones): PlannedWorkout {
  return {
    date,
    kind: 'race',
    title: '🏁 Race Day',
    description: 'Marathon — execute the plan. Even/negative splits, GMP discipline early.',
    planned_distance_mi: 26.2,
    pace_lo_s: zones.gmp.lo,
    pace_hi_s: zones.gmp.hi,
    strides: 0,
  }
}

function qualityWorkout(
  date: string,
  kind: WorkoutKind,
  zones: Zones,
  week: SkeletonWeek
): PlannedWorkout {
  const z = zones[kind]
  if (kind === 'interval') {
    const reps = week.cutback ? 4 : 5
    return {
      date,
      kind,
      title: `Intervals ${reps}×3min`,
      description: `2mi easy warmup, ${reps}×3min @ VO2max (${fmtPace(z.lo)}–${fmtPace(z.hi)}/mi) w/ 2min jog, 1–2mi cooldown.`,
      planned_distance_mi: 7,
      pace_lo_s: z.lo,
      pace_hi_s: z.hi,
      strides: 0,
    }
  }
  // tempo
  const mins = week.cutback ? 20 : 30
  return {
    date,
    kind: 'tempo',
    title: `Tempo ${mins}min`,
    description: `2mi easy warmup, ${mins}min sustained @ threshold (${fmtPace(z.lo)}–${fmtPace(z.hi)}/mi), 1–2mi cooldown.`,
    planned_distance_mi: 8,
    pace_lo_s: z.lo,
    pace_hi_s: z.hi,
    strides: 0,
  }
}

function longWorkout(
  date: string,
  miles: number,
  zones: Zones,
  week: SkeletonWeek
): PlannedWorkout {
  if (week.phase === 'specific' && miles >= 14) {
    const gmpMiles = Math.min(miles - 4, Math.round(miles * 0.65))
    const g = zones.gmp
    return {
      date,
      kind: 'long',
      title: `Long ${miles} w/ ${gmpMiles} @ GMP`,
      description: `${miles}mi total: easy to start, then ${gmpMiles}mi @ GMP (${fmtPace(g.lo)}/mi). Race-pace rehearsal.`,
      planned_distance_mi: miles,
      pace_lo_s: zones.easy.lo,
      pace_hi_s: zones.easy.hi,
      strides: 0,
    }
  }
  return {
    date,
    kind: 'long',
    title: `Long run ${miles}`,
    description: 'Easy/Zone 2 throughout. Time on feet — distance is the point.',
    planned_distance_mi: miles,
    pace_lo_s: zones.long.lo,
    pace_hi_s: zones.long.hi,
    strides: 0,
  }
}

// ---------------------------------------------------------------------------
// Projection / reality check
// ---------------------------------------------------------------------------

/** Riegel race-time predictor: T2 = T1 * (D2/D1)^1.06. Distances in miles. */
export function riegel(timeS: number, fromMi: number, toMi: number): number {
  return timeS * Math.pow(toMi / fromMi, 1.06)
}

/** Projected marathon time (s) from a tune-up half time (s). */
export function projectMarathonFromHalf(halfTimeS: number): number {
  return riegel(halfTimeS, 13.1094, 26.2188)
}

/**
 * On-track verdict from actuals vs. the goal.
 * `recentEasyPaceS` = current avg easy pace; `adherencePct` = % of planned
 * miles actually run over the trailing block.
 */
export function onTrackVerdict(
  plan: Plan,
  recentEasyPaceS: number | null,
  adherencePct: number
): { status: 'on-track' | 'watch' | 'behind'; note: string } {
  if (adherencePct >= 85 && (recentEasyPaceS == null || recentEasyPaceS <= plan.gmp_s + 170)) {
    return { status: 'on-track', note: 'Volume is landing. Stay consistent.' }
  }
  if (adherencePct >= 65) {
    return {
      status: 'watch',
      note: 'Some sessions slipping — protect the long run and easy volume.',
    }
  }
  return {
    status: 'behind',
    note: 'Adherence is low. Regenerate the block at a sustainable volume.',
  }
}
