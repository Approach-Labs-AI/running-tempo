// db.ts — SQLite schema, helpers, and shared constants for Tempo.
// Runs on Val Town (Deno runtime). Mirrors the data model in
// docs/running-tempo/ongoing/2026_06_15-plan.md.

import { sqlite } from 'https://esm.town/v/std/sqlite'
import { blob } from 'https://esm.town/v/std/blob'

// Pure domain types + constants live in types.ts (no remote imports) so the
// engine stays unit-testable. Re-export them for existing import sites.
export * from './types.ts'
import type { Plan, PlanWeek, Workout } from './types.ts'

// ---------------------------------------------------------------------------
// Low-level query helpers (map ResultSet rows -> objects)
// ---------------------------------------------------------------------------

type Arg = string | number | null

export async function run(sql: string, args: Arg[] = []): Promise<void> {
  await sqlite.execute({ sql, args })
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  args: Arg[] = []
): Promise<T[]> {
  const res = await sqlite.execute({ sql, args })
  const cols = res.columns as string[]
  return (res.rows as unknown[][]).map((row) => {
    const obj: Record<string, unknown> = {}
    cols.forEach((c, i) => (obj[c] = row[i]))
    return obj as T
  })
}

export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  args: Arg[] = []
): Promise<T | null> {
  const rows = await query<T>(sql, args)
  return rows[0] ?? null
}

export async function insert(sql: string, args: Arg[] = []): Promise<number> {
  const res = await sqlite.execute({ sql, args })
  return Number(res.lastInsertRowid ?? 0)
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export async function initSchema(): Promise<void> {
  await run(`CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    race_name TEXT NOT NULL,
    race_date TEXT NOT NULL,
    goal_time_s INTEGER NOT NULL,
    gmp_s INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    current_fitness_s INTEGER,
    days_per_week INTEGER NOT NULL DEFAULT 5,
    peak_weekly_miles INTEGER NOT NULL DEFAULT 55,
    zones_json TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)

  await run(`CREATE TABLE IF NOT EXISTS plan_weeks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL,
    week_index INTEGER NOT NULL,
    phase TEXT NOT NULL,
    start_date TEXT NOT NULL,
    planned_miles REAL NOT NULL DEFAULT 0,
    long_run_mi REAL NOT NULL DEFAULT 0,
    cutback INTEGER NOT NULL DEFAULT 0,
    focus TEXT NOT NULL DEFAULT '',
    detailed INTEGER NOT NULL DEFAULT 0,
    ai_note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)

  await run(`CREATE TABLE IF NOT EXISTS workouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id INTEGER NOT NULL,
    week_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    planned_distance_mi REAL NOT NULL DEFAULT 0,
    pace_lo_s INTEGER,
    pace_hi_s INTEGER,
    strides INTEGER NOT NULL DEFAULT 0,
    structure_json TEXT,
    gcal_event_id TEXT,
    status TEXT NOT NULL DEFAULT 'planned',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)

  await run(`CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strava_activity_id TEXT UNIQUE NOT NULL,
    workout_id INTEGER,
    date TEXT NOT NULL,
    distance_mi REAL NOT NULL,
    moving_time_s INTEGER NOT NULL,
    avg_pace_s INTEGER NOT NULL,
    avg_hr INTEGER,
    max_hr INTEGER,
    elev_gain_ft REAL,
    name TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'Run',
    raw_json TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)

  await run(`CREATE TABLE IF NOT EXISTS integrations (
    provider TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    scope TEXT,
    external_id TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)

  await run(`CREATE TABLE IF NOT EXISTS nudges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    channel TEXT NOT NULL,
    workout_id INTEGER,
    scheduled_for TEXT NOT NULL,
    sent_at TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)

  await run(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  )`)

  await run(`CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(plan_id, date)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(date)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_weeks_plan ON plan_weeks(plan_id, week_index)`)
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

export async function getActivePlan(): Promise<Plan | null> {
  return queryOne<Plan>(`SELECT * FROM plans WHERE status = 'active' ORDER BY id DESC LIMIT 1`)
}

export async function getWeeks(planId: number): Promise<PlanWeek[]> {
  return query<PlanWeek>(`SELECT * FROM plan_weeks WHERE plan_id = ? ORDER BY week_index`, [planId])
}

export async function getWorkouts(planId: number, from?: string, to?: string): Promise<Workout[]> {
  // Honor each bound independently so `?from=today` returns today-forward (the
  // headless "what's my run today?" flow), not the whole season.
  const clauses = ['plan_id = ?']
  const args: (string | number)[] = [planId]
  if (from) {
    clauses.push('date >= ?')
    args.push(from)
  }
  if (to) {
    clauses.push('date <= ?')
    args.push(to)
  }
  return query<Workout>(`SELECT * FROM workouts WHERE ${clauses.join(' AND ')} ORDER BY date`, args)
}

export async function getSetting(key: string): Promise<string | null> {
  const row = await queryOne<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, [key])
  return row?.value ?? null
}

export async function setSetting(key: string, value: string): Promise<void> {
  await run(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value]
  )
}

// ---------------------------------------------------------------------------
// Blob helpers (markdown coaching context: tempo-athlete-profile, tempo-training-log)
// ---------------------------------------------------------------------------

export async function getBlobText(key: string): Promise<string> {
  try {
    const res = await blob.get(key)
    return await res.text()
  } catch {
    return '' // not set yet
  }
}

export async function setBlobText(key: string, text: string): Promise<void> {
  await blob.set(key, text)
}

/** Prepend a dated entry to a markdown log blob (newest first). */
export async function prependLogEntry(key: string, title: string, body: string): Promise<void> {
  const existing = await getBlobText(key)
  const date = new Date().toISOString().slice(0, 10)
  const entry = `## ${date} — ${title}\n\n${body}\n`
  await setBlobText(key, `${entry}\n${existing}`.trim() + '\n')
}
