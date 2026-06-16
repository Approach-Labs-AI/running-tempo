// session.ts — end-user identity for Tempo, anchored on Google sign-in.
//
// Google is the identity anchor: a single consent grants BOTH sign-in
// (openid/email/profile) AND calendar access (calendar.events), so the user
// authorizes once and we capture their calendar tokens at the same time.
// On callback we upsert a `users` row keyed by the Google `sub`, store the
// Google OAuth tokens as that user's integration, and set a session cookie.
// Strava is linked afterward, inside the session (see strava.ts).
//
// Env (Val Town web UI): GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET.
// Optional: GOOGLE_REDIRECT_URI (else derived from the request origin).
//
// NOTE: calendar.events is a Google *sensitive* scope. In "Testing" publishing
// mode external users must be added by hand (100 cap) and refresh tokens are
// revoked after 7 days. Production multi-user requires sensitive-scope
// verification (public homepage + privacy policy + domain verification).

import type { Hono, MiddlewareHandler } from 'npm:hono@4'
import { getCookie, setCookie } from 'npm:hono@4/cookie'
import {
  createSession,
  deleteSession,
  getSessionUserId,
  upsertIntegration,
  upsertUserByGoogle,
} from './db.ts'

export const SESSION_COOKIE = 'tempo_session'
const STATE_COOKIE = 'tempo_oauth_state'

// One consent for identity + calendar. `openid` returns an id_token we decode
// for the user's stable `sub`; calendar.events lets us push workouts later.
const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ')

function googleRedirectUri(reqUrl: string): string {
  return Deno.env.get('GOOGLE_REDIRECT_URI') ?? new URL(reqUrl).origin + '/auth/google/callback'
}

/** Register Google sign-in + session routes onto the shared app. */
export function registerAuth(app: Hono) {
  app.get('/auth/google/login', (c) => {
    const clientId = Deno.env.get('GOOGLE_CLIENT_ID')
    if (!clientId) return c.text('GOOGLE_CLIENT_ID not set', 500)

    // CSRF: stash an unguessable state in a short-lived cookie, echo via Google.
    const state = crypto.randomUUID()
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 600,
      path: '/',
    })

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.searchParams.set('client_id', clientId)
    url.searchParams.set('redirect_uri', googleRedirectUri(c.req.url))
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', GOOGLE_SCOPES)
    url.searchParams.set('access_type', 'offline') // get a refresh token
    url.searchParams.set('prompt', 'consent') // force refresh token on re-login
    url.searchParams.set('include_granted_scopes', 'true')
    url.searchParams.set('state', state)
    return c.redirect(url.toString())
  })

  app.get('/auth/google/callback', async (c) => {
    const code = c.req.query('code')
    if (!code) return c.text('missing code', 400)

    // CSRF check: the state echoed by Google must match our cookie.
    const state = c.req.query('state')
    const expected = getCookie(c, STATE_COOKIE)
    setCookie(c, STATE_COOKIE, '', { maxAge: 0, path: '/' })
    if (!state || !expected || state !== expected) {
      return c.text('invalid oauth state', 400)
    }

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: Deno.env.get('GOOGLE_CLIENT_ID') ?? '',
        client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') ?? '',
        code,
        grant_type: 'authorization_code',
        redirect_uri: googleRedirectUri(c.req.url),
      }),
    })
    if (!res.ok) return c.text(`google token exchange failed: ${await res.text()}`, 502)
    const tok = (await res.json()) as GoogleTokenResponse

    const claims = decodeIdToken(tok.id_token)
    if (!claims?.sub) return c.text('no id_token subject from google', 502)

    // Identity: find-or-create the user by their stable Google sub.
    const userId = await upsertUserByGoogle(claims.sub, claims.email ?? null, claims.name ?? null)

    // Capture the calendar tokens for this user (same consent as sign-in).
    await upsertIntegration(userId, 'google', {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token ?? null,
      expires_at: Math.floor(Date.now() / 1000) + (tok.expires_in ?? 3600),
      scope: tok.scope ?? GOOGLE_SCOPES,
      external_id: claims.sub,
    })

    // Session cookie -> user_id.
    const token = await createSession(userId)
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: 60 * 60 * 24 * 30,
      path: '/',
    })
    return c.redirect('/')
  })

  app.get('/auth/logout', async (c) => {
    await deleteSession(getCookie(c, SESSION_COOKIE))
    setCookie(c, SESSION_COOKIE, '', { maxAge: 0, path: '/' })
    return c.redirect('/login')
  })
}

// ---------------------------------------------------------------------------
// Session access helpers (used by route guards across modules)
// ---------------------------------------------------------------------------

/** The signed-in user's id, or null. Reads the session cookie. */
export async function currentUserId(c: { req: { header(name: string): string | undefined } }) {
  return getSessionUserId(getCookieValue(c.req.header('Cookie'), SESSION_COOKIE))
}

/** Middleware: require a Google session, else kick off sign-in. Downstream
 *  handlers re-resolve the id via currentUserId(c). */
export const requireUser: MiddlewareHandler = async (c, next) => {
  const userId = await currentUserId(c)
  if (!userId) return c.redirect('/auth/google/login')
  return next()
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

interface GoogleTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  id_token: string
}

interface IdTokenClaims {
  sub: string
  email?: string
  name?: string
}

/** Decode (not verify) a Google id_token JWT payload. The token came straight
 *  from Google's token endpoint over TLS, so we trust it without re-verifying
 *  the signature for this MVP. */
function decodeIdToken(idToken: string | undefined): IdTokenClaims | null {
  if (!idToken) return null
  const part = idToken.split('.')[1]
  if (!part) return null
  try {
    const b64 = part.replaceAll('-', '+').replaceAll('_', '/').padEnd(
      part.length + ((4 - (part.length % 4)) % 4),
      '='
    )
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))
    return JSON.parse(new TextDecoder().decode(bytes)) as IdTokenClaims
  } catch {
    return null
  }
}

/** Pull one cookie's value out of a raw Cookie header. */
function getCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === name) return rest.join('=')
  }
  return undefined
}
