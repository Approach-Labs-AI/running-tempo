// views.ts — HTML renderers for the Tempo dashboard. Pure string builders;
// no DB access here (dashboard.ts fetches data and passes it in).

import { fmtPace } from './engine.ts'
import { Plan, PlanWeek, Workout } from './db.ts'

/** HTML-escape user-supplied strings (race name, workout title/description, focus). */
function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string
  )
}

const CSS = `
:root{--bg:#0f1115;--card:#171a21;--ink:#e7e9ee;--mut:#9aa3b2;--line:#252a34;
--accent:#46d39a;--warn:#f5b54a;--bad:#ef6b6b;--gmp:#6aa9ff;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);
font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}
header{display:flex;align-items:center;gap:18px;padding:16px 22px;border-bottom:1px solid var(--line)}
header .logo{font-weight:700;letter-spacing:.5px}
nav a{color:var(--mut);margin-right:14px}nav a.on{color:var(--ink)}
.wrap{max-width:980px;margin:0 auto;padding:22px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card .k{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.6px}
.card .v{font-size:24px;font-weight:700;margin-top:4px}
.card .s{color:var(--mut);font-size:12px;margin-top:2px}
.pill{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:600}
.on-track{background:rgba(70,211,154,.15);color:var(--accent)}
.watch{background:rgba(245,181,74,.15);color:var(--warn)}
.behind{background:rgba(239,107,107,.15);color:var(--bad)}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line);font-size:14px}
th{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.6px}
.kind{font-weight:600}.kind.easy{color:#bcd}.kind.long{color:#fff}.kind.gmp,.kind.tempo,.kind.interval{color:var(--gmp)}.kind.race{color:var(--accent);font-weight:700}
.kind.rest{color:var(--mut)}
.done{color:var(--accent)}.missed{color:var(--bad)}.muted{color:var(--mut)}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.8px;color:var(--mut);margin:24px 0 8px}
.phase{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--mut)}
`

function shell(title: string, active: string, body: string): string {
  const link = (href: string, label: string) =>
    `<a class="${active === href ? 'on' : ''}" href="${href}">${label}</a>`
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Tempo</title><style>${CSS}</style></head><body>
<header><span class="logo">TEMPO</span>
<nav>${link('/', 'Overview')}${link('/calendar', 'Calendar')}${link('/settings', 'Settings')}</nav>
</header><div class="wrap">${body}</div></body></html>`
}

function dayName(iso: string): string {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(iso + 'T00:00:00Z').getUTCDay()]
}

function paceCell(w: Workout): string {
  if (w.pace_lo_s == null) return ''
  return w.pace_lo_s === w.pace_hi_s
    ? `${fmtPace(w.pace_lo_s)}`
    : `${fmtPace(w.pace_lo_s)}–${fmtPace(w.pace_hi_s)}`
}

export interface OverviewData {
  plan: Plan
  paces: Record<string, string>
  progress: {
    miles_earned: number
    planned_to_date: number
    planned_total: number
    adherence_pct: number
    days_to_race: number
    verdict: { status: string; note: string }
  }
  week: PlanWeek | null
  workouts: Workout[]
}

export function renderOverview(d: OverviewData): string {
  const v = d.progress.verdict
  const cards = `
  <div class="cards">
    <div class="card"><div class="k">Goal</div><div class="v">sub-3:00</div>
      <div class="s">${d.paces.gmp} GMP</div></div>
    <div class="card"><div class="k">Days to race</div><div class="v">${d.progress.days_to_race}</div>
      <div class="s">${esc(d.plan.race_name)}</div></div>
    <div class="card"><div class="k">Miles earned</div><div class="v">${d.progress.miles_earned}</div>
      <div class="s">of ${d.progress.planned_to_date} planned to date</div></div>
    <div class="card"><div class="k">On track?</div>
      <div class="v"><span class="pill ${v.status}">${v.status}</span></div>
      <div class="s">${v.note}</div></div>
  </div>`

  const zones = `
  <h2>Pace zones</h2>
  <table><tr><th>Easy</th><th>Long</th><th>GMP</th><th>Tempo</th><th>Interval</th></tr>
  <tr><td>${d.paces.easy}</td><td>${d.paces.long}</td><td>${d.paces.gmp}</td>
  <td>${d.paces.tempo}</td><td>${d.paces.interval}</td></tr></table>`

  const wk = d.week
  const thisWeek = wk
    ? `<h2>Week ${wk.week_index} · <span class="phase">${wk.phase}${wk.cutback ? ' · cutback' : ''}</span> · ${wk.planned_miles} mi</h2>
    <table><tr><th>Day</th><th>Date</th><th>Workout</th><th>Miles</th><th>Pace</th><th></th></tr>
    ${d.workouts
      .map(
        (w) => `<tr>
      <td>${dayName(w.date)}</td><td class="muted">${w.date.slice(5)}</td>
      <td><span class="kind ${w.kind}">${esc(w.title)}</span><br><span class="muted" style="font-size:12px">${esc(w.description)}</span></td>
      <td>${w.planned_distance_mi || ''}</td>
      <td class="muted">${paceCell(w)}</td>
      <td class="${w.status === 'done' ? 'done' : w.status === 'missed' ? 'missed' : 'muted'}">${w.status === 'planned' ? '' : w.status}</td>
    </tr>`
      )
      .join('')}</table>`
    : `<p class="muted">No detailed week for today yet.</p>`

  return shell('Overview', '/', cards + zones + thisWeek)
}

export function renderCalendar(plan: Plan, weeks: PlanWeek[]): string {
  const rows = weeks
    .map(
      (w) => `<tr>
    <td>${w.week_index}</td>
    <td class="phase">${w.phase}${w.cutback ? ' · cutback' : ''}</td>
    <td class="muted">${w.start_date.slice(5)}</td>
    <td>${w.planned_miles}</td>
    <td>${w.long_run_mi}</td>
    <td class="muted">${w.detailed ? '✓ detailed' : ''}</td>
    <td class="muted" style="font-size:12px">${esc(w.focus)}</td>
  </tr>`
    )
    .join('')
  return shell(
    'Calendar',
    '/calendar',
    `<h2>${esc(plan.race_name)} — full season</h2>
    <table><tr><th>Wk</th><th>Phase</th><th>Starts</th><th>Miles</th><th>Long</th><th></th><th>Focus</th></tr>
    ${rows}</table>`
  )
}

export function renderLogin(error = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tempo</title>
  <style>${CSS}body{display:grid;place-items:center;height:100vh}
  form{background:var(--card);border:1px solid var(--line);padding:28px;border-radius:14px;width:300px}
  input{width:100%;padding:10px;margin:10px 0;background:var(--bg);border:1px solid var(--line);
  border-radius:8px;color:var(--ink)}button{width:100%;padding:10px;background:var(--accent);
  border:0;border-radius:8px;font-weight:700;cursor:pointer}</style></head><body>
  <form method="POST" action="/login"><div class="logo" style="font-weight:700">TEMPO</div>
  <input type="password" name="password" placeholder="Password" autofocus>
  ${error ? `<div style="color:var(--bad);font-size:13px">${error}</div>` : ''}
  <button>Enter</button></form></body></html>`
}

export interface StravaStatus {
  connected: boolean
  athlete_id: string | null
  last_run: string | null
}

export interface GcalStatus {
  connected: boolean
  events_pushed: number
}

export function renderSettings(
  plan: Plan | null,
  strava?: StravaStatus,
  gcal?: GcalStatus
): string {
  const stravaBlock = strava?.connected
    ? `<p><span class="pill on-track">Strava connected</span>
       <span class="muted">athlete ${strava.athlete_id ?? '?'} · last run ${strava.last_run ?? '—'}</span></p>
       <p><a href="/strava/connect">Reconnect</a> · <a href="/sync">Sync now</a></p>`
    : `<p class="muted">Strava not connected.</p><p><a href="/strava/connect">Connect Strava →</a></p>`

  const gcalBlock = gcal?.connected
    ? `<p><span class="pill on-track">Google Calendar connected</span>
       <span class="muted">${gcal.events_pushed} workouts on calendar</span></p>
       <p><a href="/gcal/connect">Reconnect</a> · <a href="/push-calendar">Push schedule</a></p>`
    : `<p class="muted">Calendar not connected. Connecting pushes your runs as events with reminders.</p>
       <p><a href="/gcal/connect">Connect Google Calendar →</a></p>`

  const body = plan
    ? `<h2>Plan</h2><table>
      <tr><th>Race</th><td>${esc(plan.race_name)} — ${plan.race_date}</td></tr>
      <tr><th>Goal</th><td>sub-3:00 · GMP ${fmtPace(plan.gmp_s)}/mi</td></tr>
      <tr><th>Start</th><td>${plan.start_date}</td></tr>
      <tr><th>Days/wk</th><td>${plan.days_per_week}</td></tr>
      <tr><th>Peak miles</th><td>${plan.peak_weekly_miles}</td></tr></table>
      <h2>Strava</h2>${stravaBlock}
      <h2>Google Calendar</h2>${gcalBlock}
      <h2>Nudges</h2><p class="muted">Calendar event reminders cover morning-of for now.
      Dedicated SMS/email summary ships in P4.</p>`
    : `<p class="muted">No active plan. POST /api/plan/seed-houston to seed.</p>`
  return shell('Settings', '/settings', body)
}
