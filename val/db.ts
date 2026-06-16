// db.ts — SQLite schema, helpers, and shared constants for Tempo.
// Runs on Val Town (Deno runtime). Mirrors the data model in
// docs/running-tempo/ongoing/2026_06_15-plan.md.

import { sqlite } from 'https://esm.town/v/std/sqlite'
import { blob } from 'https://esm.town/v/std/blob'

// Pure domain types + constants live in types.ts (no remote imports) so the
// engine stays unit-testable. Re-export them for existing import sites.
export * from './types.ts'
import type { Plan, PlanWeek, User, Workout } from './types.ts'

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
  // --- identity (multi-user) ------------------------------------------------
  // Google sign-in is the identity anchor; Strava links to an existing user.
  await run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT UNIQUE NOT NULL,
    email TEXT,
    name TEXT,
    strava_athlete_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`)

  await run(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at INTEGER NOT NULL
  )`)

  await run(`CREATE TABLE IF NOT EXISTS plans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 0,
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
    user_id INTEGER NOT NULL DEFAULT 0,
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

  // One OAuth connection per (user, provider). user_id = 0 is the legacy store.
  await run(`CREATE TABLE IF NOT EXISTS integrations (
    user_id INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    scope TEXT,
    external_id TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, provider)
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

  // Migrate any DB created before multi-user (adds columns / re-keys in place).
  await ensureColumn('plans', 'user_id', 'INTEGER NOT NULL DEFAULT 0')
  await ensureColumn('runs', 'user_id', 'INTEGER NOT NULL DEFAULT 0')
  await migrateIntegrationsToPerUser()

  await run(`CREATE INDEX IF NOT EXISTS idx_workouts_date ON workouts(plan_id, date)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_runs_date ON runs(date)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_weeks_plan ON plan_weeks(plan_id, week_index)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_plans_user ON plans(user_id, status)`)
  await run(`CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)`)
}

// ---------------------------------------------------------------------------
// Migration helpers (idempotent; SQLite lacks ADD COLUMN IF NOT EXISTS)
// ---------------------------------------------------------------------------

async function columnExists(table: string, col: string): Promise<boolean> {
  const cols = await query<{ name: string }>(`PRAGMA table_info(${table})`)
  return cols.some((c) => c.name === col)
}

async function ensureColumn(table: string, col: string, def: string): Promise<void> {
  if (!(await columnExists(table, col))) {
    await run(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
  }
}

/** Rebuild a legacy single-provider `integrations` table (provider PRIMARY KEY)
 *  into the per-user shape, assigning existing rows to the user_id = 0 store. */
async function migrateIntegrationsToPerUser(): Promise<void> {
  if (await columnExists('integrations', 'user_id')) return
  await run(`ALTER TABLE integrations RENAME TO integrations_legacy`)
  await run(`CREATE TABLE integrations (
    user_id INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL,
    access_token TEXT,
    refresh_token TEXT,
    expires_at INTEGER,
    scope TEXT,
    external_id TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, provider)
  )`)
  await run(
    `INSERT INTO integrations
       (user_id, provider, access_token, refresh_token, expires_at, scope, external_id, updated_at)
     SELECT 0, provider, access_token, refresh_token, expires_at, scope, external_id, updated_at
       FROM integrations_legacy`
  )
  await run(`DROP TABLE integrations_legacy`)
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

/** The user's active plan. Defaults to the legacy/admin store (user_id = 0). */
export async function getActivePlan(userId = 0): Promise<Plan | null> {
  return queryOne<Plan>(
    `SELECT * FROM plans WHERE user_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
    [userId]
  )
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
// Identity (Google sign-in anchor) + Strava linking
// ---------------------------------------------------------------------------

/** Find-or-create a user by their stable Google account id; refresh profile. */
export async function upsertUserByGoogle(
  googleSub: string,
  email: string | null,
  name: string | null
): Promise<number> {
  await run(
    `INSERT INTO users (google_sub, email, name) VALUES (?, ?, ?)
     ON CONFLICT(google_sub) DO UPDATE SET
       email = COALESCE(excluded.email, users.email),
       name = COALESCE(excluded.name, users.name)`,
    [googleSub, email, name]
  )
  const row = await queryOne<{ id: number }>(`SELECT id FROM users WHERE google_sub = ?`, [googleSub])
  return row?.id ?? 0
}

export async function getUserById(id: number): Promise<User | null> {
  return queryOne<User>(`SELECT * FROM users WHERE id = ?`, [id])
}

/** Link a Strava athlete to an existing user (called during Strava connect). */
export async function linkStravaAthlete(userId: number, athleteId: string): Promise<void> {
  await run(`UPDATE users SET strava_athlete_id = ? WHERE id = ?`, [athleteId, userId])
}

// ---------------------------------------------------------------------------
// Sessions (cookie token -> user_id)
// ---------------------------------------------------------------------------

export async function createSession(userId: number, ttlDays = 30): Promise<string> {
  const token = crypto.randomUUID() + crypto.randomUUID().replaceAll('-', '')
  const expiresAt = Math.floor(Date.now() / 1000) + ttlDays * 86_400
  await run(`INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)`, [
    token,
    userId,
    expiresAt,
  ])
  return token
}

/** Resolve a session token to its user id, or null if missing/expired. */
export async function getSessionUserId(token: string | undefined): Promise<number | null> {
  if (!token) return null
  const row = await queryOne<{ user_id: number; expires_at: number }>(
    `SELECT user_id, expires_at FROM sessions WHERE token = ?`,
    [token]
  )
  if (!row) return null
  if (row.expires_at <= Math.floor(Date.now() / 1000)) {
    await run(`DELETE FROM sessions WHERE token = ?`, [token])
    return null
  }
  return row.user_id
}

export async function deleteSession(token: string | undefined): Promise<void> {
  if (token) await run(`DELETE FROM sessions WHERE token = ?`, [token])
}

// ---------------------------------------------------------------------------
// OAuth integrations (per user, per provider)
// ---------------------------------------------------------------------------

export interface IntegrationRow {
  access_token: string
  refresh_token: string | null
  expires_at: number
  scope: string | null
  external_id: string | null
}

export async function getIntegration(
  userId: number,
  provider: string
): Promise<IntegrationRow | null> {
  return queryOne<IntegrationRow>(
    `SELECT access_token, refresh_token, expires_at, scope, external_id
       FROM integrations WHERE user_id = ? AND provider = ?`,
    [userId, provider]
  )
}

/** Upsert tokens for (user, provider). A null refresh_token/scope/external_id
 *  preserves the stored value — Google omits the refresh token on re-consent. */
export async function upsertIntegration(
  userId: number,
  provider: string,
  fields: {
    access_token: string
    refresh_token?: string | null
    expires_at: number
    scope?: string | null
    external_id?: string | null
  }
): Promise<void> {
  await run(
    `INSERT INTO integrations
       (user_id, provider, access_token, refresh_token, expires_at, scope, external_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, provider) DO UPDATE SET
       access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, integrations.refresh_token),
       expires_at = excluded.expires_at,
       scope = COALESCE(excluded.scope, integrations.scope),
       external_id = COALESCE(excluded.external_id, integrations.external_id),
       updated_at = datetime('now')`,
    [
      userId,
      provider,
      fields.access_token,
      fields.refresh_token ?? null,
      fields.expires_at,
      fields.scope ?? null,
      fields.external_id ?? null,
    ]
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
