// auth.ts — shared dashboard session auth (used by dashboard, strava, gcal).
// The session cookie stores a SHA-256 hash of DASHBOARD_PASSWORD, never the raw
// secret — so the password never travels in a Cookie header after login.

import type { MiddlewareHandler } from 'npm:hono@4'

export const COOKIE = 'tempo_auth'

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/** The expected cookie value: hash(DASHBOARD_PASSWORD). null if password unset. */
export async function sessionToken(): Promise<string | null> {
  const pw = Deno.env.get('DASHBOARD_PASSWORD')
  return pw ? sha256Hex(pw) : null
}

/** True if the request carries a valid dashboard session cookie. */
export async function authedCookie(cookieHeader: string | undefined): Promise<boolean> {
  const token = await sessionToken()
  if (!token) return false
  const raw = cookieHeader ?? ''
  return raw.split(';').some((p) => p.trim() === `${COOKIE}=${token}`)
}

/** Middleware: redirect to /login unless a valid dashboard session is present. */
export const requireAuth: MiddlewareHandler = async (c, next) =>
  (await authedCookie(c.req.header('Cookie'))) ? next() : c.redirect('/login')
