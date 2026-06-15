// Unit tests for the Tempo training engine (pure logic, runs offline).
//   bun test projects/running-tempo/test/engine.test.ts

import { expect, test } from 'bun:test'
import {
  addDays,
  buildSkeleton,
  buildWeekWorkouts,
  fmtPace,
  isCutback,
  mondayOf,
  paceZones,
  parsePace,
  parseTime,
  phaseForWeek,
  projectMarathonFromHalf,
  weeksBetween,
} from '../val/engine.ts'
import type { Plan } from '../val/types.ts'

const KEVIN: Plan = {
  id: 1,
  race_name: 'Houston Marathon',
  race_date: '2027-01-18',
  goal_time_s: 10800,
  gmp_s: 412, // 6:52
  start_date: '2026-06-15',
  current_fitness_s: 555,
  days_per_week: 5,
  peak_weekly_miles: 55,
  zones_json: null,
  status: 'active',
  created_at: '',
  updated_at: '',
}

test('pace formatting round-trips', () => {
  expect(fmtPace(412)).toBe('6:52')
  expect(parsePace('6:52')).toBe(412)
  expect(parseTime('3:00:00')).toBe(10800)
  expect(parseTime('1:25:00')).toBe(5100)
})

test('pace zones derive from GMP and match the brief', () => {
  const z = paceZones(KEVIN)
  expect(fmtPace(z.easy.lo)).toBe('8:45')
  expect(fmtPace(z.easy.hi)).toBe('9:30')
  expect(fmtPace(z.tempo.lo)).toBe('6:20')
  expect(fmtPace(z.tempo.hi)).toBe('6:35')
  expect(fmtPace(z.interval.lo)).toBe('5:50')
  expect(fmtPace(z.interval.hi)).toBe('6:10')
  expect(z.gmp.lo).toBe(412)
})

test('date helpers', () => {
  expect(mondayOf('2026-06-15')).toBe('2026-06-15') // a Monday
  expect(mondayOf('2026-06-17')).toBe('2026-06-15') // Wed -> Mon
  expect(addDays('2026-06-15', 5)).toBe('2026-06-20')
  // Jun 15 2026 -> Jan 18 2027 is ~31 weeks
  const w = weeksBetween('2026-06-15', '2027-01-18')
  expect(w).toBeGreaterThanOrEqual(31)
  expect(w).toBeLessThanOrEqual(32)
})

test('cutback every 4th week', () => {
  expect(isCutback(4)).toBe(true)
  expect(isCutback(8)).toBe(true)
  expect([1, 2, 3, 5, 6, 7].every((i) => !isCutback(i))).toBe(true)
})

test('phases count back from the race', () => {
  const total = weeksBetween(KEVIN.start_date, KEVIN.race_date)
  expect(phaseForWeek(total, total)).toBe('taper') // race week
  expect(phaseForWeek(total - 2, total)).toBe('taper')
  expect(phaseForWeek(total - 3, total)).toBe('specific')
  expect(phaseForWeek(1, total)).toBe('base')
})

test('skeleton spans the whole cycle and stays within peak', () => {
  const sk = buildSkeleton(KEVIN)
  expect(sk.length).toBe(weeksBetween(KEVIN.start_date, KEVIN.race_date))
  expect(sk[0].week_index).toBe(1)
  expect(sk[0].phase).toBe('base')
  for (const wk of sk) {
    expect(wk.planned_miles).toBeLessThanOrEqual(KEVIN.peak_weekly_miles)
    expect(wk.planned_miles).toBeGreaterThan(0)
    expect(wk.long_run_mi).toBeLessThanOrEqual(wk.planned_miles)
  }
  // cutback weeks are lighter than the week before
  const wk4 = sk.find((w) => w.week_index === 4)!
  const wk3 = sk.find((w) => w.week_index === 3)!
  expect(wk4.planned_miles).toBeLessThan(wk3.planned_miles)
})

test('base week produces runs-only template with Tue/Thu/Sat anchors', () => {
  const sk = buildSkeleton(KEVIN)
  const wk1 = sk[0]
  const zones = paceZones(KEVIN)
  const ws = buildWeekWorkouts(KEVIN, wk1, zones)
  expect(ws.length).toBe(7)
  // No lifts ever
  expect(ws.some((w) => (w.kind as string) === 'lift')).toBe(false)
  // Saturday (index 5) is the long run
  expect(ws[5].kind).toBe('long')
  // Monday + Friday rest
  expect(ws[0].kind).toBe('rest')
  expect(ws[4].kind).toBe('rest')
  // base phase has no quality work
  expect(ws.some((w) => ['tempo', 'interval', 'gmp'].includes(w.kind))).toBe(false)
  // long run distance matches the week
  expect(ws[5].planned_distance_mi).toBe(wk1.long_run_mi)
})

test('build week unlocks exactly one midweek quality session', () => {
  const sk = buildSkeleton(KEVIN)
  const buildWeek = sk.find((w) => w.phase === 'build' && !w.cutback)!
  const ws = buildWeekWorkouts(KEVIN, buildWeek, paceZones(KEVIN))
  const quality = ws.filter((w) => ['tempo', 'interval'].includes(w.kind))
  expect(quality.length).toBe(1) // one midweek workout; long run is the 2nd quality
  expect(ws[5].kind).toBe('long')
})

test('final week is capped at race day with a race workout (no post-race training)', () => {
  const sk = buildSkeleton(KEVIN)
  const last = sk[sk.length - 1]
  const ws = buildWeekWorkouts(KEVIN, last, paceZones(KEVIN))
  // Nothing scheduled after the race
  expect(ws.every((w) => w.date <= KEVIN.race_date)).toBe(true)
  // The race itself is scheduled, exactly once, on race day
  const races = ws.filter((w) => w.kind === 'race')
  expect(races.length).toBe(1)
  expect(races[0].date).toBe(KEVIN.race_date)
  expect(races[0].planned_distance_mi).toBeGreaterThan(26)
})

test('Riegel projects a sub-3 from a sub-1:25 half', () => {
  const m = projectMarathonFromHalf(parseTime('1:25:00'))
  expect(m).toBeLessThan(10800) // sub-3:00
  const m2 = projectMarathonFromHalf(parseTime('1:30:00'))
  expect(m2).toBeGreaterThan(10800) // 1:30 half -> over 3:00
})
