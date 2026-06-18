// app.ts — single HTTP entrypoint for Tempo (the only http val).
// Everything lives on one origin (e.g. tempo.kevinjsuh.com): the password-gated
// dashboard, the bearer-auth headless API, and Strava OAuth. Each module
// registers its own routes (with its own path-scoped auth) onto this app.

import { Hono } from 'npm:hono@4'
import { initSchema } from './db.ts'
import { registerApi } from './api.ts'
import { registerAuth } from './session.ts'
import { registerReview } from './review.ts'
import { registerStrava } from './strava.ts'
import { registerGcal } from './gcal.ts'
import { registerDashboard } from './dashboard.ts'

const app = new Hono()

// Ensure the schema exists before any handler runs (cheap; CREATE IF NOT EXISTS).
let ready = false
app.use('*', async (_c, next) => {
  if (!ready) {
    await initSchema()
    ready = true
  }
  return next()
})

registerApi(app) // /api/*        (Bearer TEMPO_API_SECRET)
registerReview(app) // /api/review (weekly reconcile — shares /api/* bearer auth)
registerAuth(app) // /auth/*      (Google sign-in — end-user identity anchor)
registerStrava(app) // /strava/*  (OAuth connect + callback)
registerGcal(app) // /gcal/*      (OAuth connect + callback)
registerDashboard(app) // /, /calendar, /settings, /sync, /push-calendar, /login (cookie auth)

export default app.fetch
