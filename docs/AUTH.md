# Sign-in: parent-site admin one-time handoff

Review Ops has no password of its own in production. The owner signs in with the **existing
admin login of a parent website** (the site's `/admin/` password session), and Ops gets a one-time, browser-bound proof
of it over an authenticated back channel. No password, password hash or site session cookie ever
reaches Ops.

**Identity decision (owner):** the parent-site **admin** session is the only identity Ops accepts. The
site's member login (Discord OAuth) never grants Ops access — not as a fallback, not for a "joined"
member, not behind a flag. Ops refuses any other identity kind in its config and in every site answer.

> This repository contains the **Ops side** of the handoff and a synthetic site fixture
> (`tests/fixtures/fake-site.ts`) that implements the site side of the contract for tests. The real
> parent site's implementation is private and not part of this repository; below it is described only as
> the contract it must satisfy.

## Modes (`OPS_AUTH_MODE`)

| value | meaning |
| --- | --- |
| *(unset)* | sign-in disabled — every page stays behind `/login`, which says so |
| `site` | production: the handoff below; requires `OPS_IDENTITY_KIND=admin` |
| `demo-password` | local demo / tests only (scrypt hash in `OPS_PASSWORD_HASH`); **refused when `OPS_DEPLOYMENT=production`** |

`OPS_IDENTITY_KIND` must be exactly `admin`; `member` (or anything else) is a config error, and a
leftover `OPS_OWNER_SUBJECT` (from the earlier member design) is a config error too — a half-migrated
config fails closed instead of looking enabled.

Every mode uses **server-side sessions** (table `auth_sessions`): the cookie is an opaque 256-bit random
value, the database keeps only its SHA-256. There is no self-validating cookie anywhere.

## Protocol

Shaped like OAuth 2.0 authorization code + PKCE S256 for one confidential client (RFC 6749, RFC 7636, the
RFC 9700 rules). The site is **not** an OAuth/OIDC server and does not claim to be; this is a narrow
purpose-built handoff with the same safety properties.

```
browser            Ops (OPS_PUBLIC_ORIGIN)                     parent site (SITE_ORIGIN)
  | GET /auth/start  |                                               |
  |----------------->| state, binding, verifier = random 256-bit     |
  |                  | store {H(state), H(binding), verifier, next}  |
  |<-- 303 + cookie ops_login=binding (host-only, 5 min)             |
  | GET /admin/ops-handoff/?client_id&redirect_uri&state&code_challenge=S256(verifier)
  |------------------------------------------------------------------>| no valid admin session ⇒ 302 /admin/login.html
  |                  |                                               |   (exactly like every other /admin page)
  |                  |                                               | exact client + redirect_uri, else 400 (no redirect)
  |                  |                                               | GET only (any other method ⇒ 405); no confirm step
  |<-- 303 {redirect_uri}?code&state ---------------------------------| code = random, 60 s, one-use, bound to the
  |    (Referrer-Policy: no-referrer)                                |   exact admin session and the challenge
  | GET /auth/callback?code&state (+ ops_login cookie)               |
  |----------------->| DELETE attempt WHERE H(state) RETURNING …     |
  |                  |   (one-use; wrong binding still burns it)     |
  |                  | POST /api/ops-handoff/token  (Basic client auth, code, verifier, redirect_uri)
  |                  |---------------------------------------------->| one-use, PKCE, admin session still live
  |                  |<---- {grant, subject:"site-admin", identity:"admin", expires_at}
  |                  | identity/subject == admin? new session row    |   replay ⇒ revoke the grant it produced
  |<-- 303 next + cookie __Host-ops_session (host-only, Lax)         |
  |                  |                                               |
  |  later requests  | grant last checked > OPS_AUTH_REVALIDATE_SECONDS ago?
  |                  | POST /api/ops-handoff/introspect ------------>| active iff not revoked/expired AND the exact
  |                  |<------------- {active, subject, identity} ----|   admin session still passes the site's own
  |                  |                                               |   admin check (see "Liveness")
```

Back channel: `fetch` with `redirect: 'error'`, 5 s timeout, 8 KiB response cap, exact-origin and
`application/json` checks, strict zod schemas (`identity` must be `admin`), `client_secret_basic`. The site
refuses any request that carries an `Origin` header (browsers), bounds bodies at 4 KiB / 3 s and rate-limits
per client (120/min) and globally (600/min), with a failed-client-auth budget (10/min per client).

The back channel is `/api/ops-handoff/*`, deliberately **outside** `/api/admin/*`: those routes need a browser
admin cookie and a browser Origin, and the edge guards `/admin/*` for people. This server-to-server path
authenticates the Ops client instead (secret, SHA-256 compared in constant time) and carries no admin cookie.

## The site side: contract (implementation not in this repository)

Any parent site can serve Ops if it implements these rules. The synthetic fixture in
`tests/fixtures/fake-site.ts` implements exactly this and is what the unit tests and browser E2E run against.

- **Handoff page** `GET /admin/ops-handoff/`, guarded like every other admin page: no admin session ⇒
  `302` to the admin login, `Cache-Control: no-store`, before anything else (an anonymous visitor cannot
  learn whether the handoff is enabled). Member/non-admin cookies are never read.
- **Configuration** is private to the site: `{enabled, identity:"admin", clientId, redirectUri,
  clientSecretSha256, grantTtlHours?}`. Unknown keys invalidate the config (⇒ handoff off, back channel 503).
- **No confirm screen**: a valid GET from a live admin session gets `303 {redirectUri}?code&state` with
  `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. GET only (other methods ⇒ 405). Invalid
  requests (client, redirect URI, S256, state/challenge shape, every parameter exactly once) get an error
  page and are never redirected. Live codes are capped (20) and the page is rate-limited per client address.
- Why this is safe without a click: the code only ever goes to the one configured `redirectUri` (from the
  config, not the request), only in the browser that made the request, and the Ops callback redeems it
  only together with the `ops_login` binding cookie of the same state plus the Ops client secret and PKCE
  verifier. A planted same-site link therefore wastes a code at the callback (`/login?error=state`) and
  creates no session. Residual risk: a same-site page could fill the code cap for up to 60 s.
- **Back channel** `POST /api/ops-handoff/{token,introspect,revoke}`: client-secret authenticated
  (`client_secret_basic`, SHA-256 compared in constant time), refuses requests carrying a browser `Origin`,
  bounded bodies/timeouts, per-client and global rate limits, a failed-client-auth budget.
- **Liveness**: grants are bound to the exact admin session that produced them and are re-checked with the
  site's own admin check on every redemption and introspection (see below).

## SameSite=Strict and the Ops domain

The admin cookie is `__Host-site_admin; Secure; HttpOnly; SameSite=Strict`, host-only on the host where the
admin logs in. A Strict cookie is sent on a top-level navigation only when the navigation is **same-site**
(same scheme + registrable domain), redirects included.

- `https://ops.site.example` → `https://site.example/admin/ops-handoff/` is same-site (both `site.example`), so the
  browser attaches the admin cookie and the site answers with the code-carrying 303 directly.
- From a **different site**, the cookie is withheld: the visitor lands on the admin login page even while
  logged in. A cross-site Ops origin would therefore loop forever, so the site refuses to serve the page when
  the configured `redirectUri` host is not same-site with the request host (simple last-two-labels rule,
  sufficient for `site.example` hosts; not a Public-Suffix-List implementation).
- Verified in Chrome (E2E): same-site handoff works; a link or auto-submitted form from another site gets the
  admin login page and no code; a link from a same-site sibling host gets a code, which the Ops callback
  refuses without the browser-binding cookie (no session); a POST to the page gets 405.
- `SITE_ORIGIN` must be the host the admin actually logs in on (the cookie is host-only). `https://site.example`
  by default; use `https://admin.site.example` if that is where the admin session lives.
- After logging in on the site, the admin may need to start again from Ops (a site's admin login does not
  have to remember a return path for `/admin/ops-handoff/`). The Ops login page says so.

## Liveness: how a site-side change ends an Ops session

The back channel has no browser cookie, so the site keeps a reference to the **admin session the grant was
issued for** (in memory only) and re-runs its own admin-session check on it for every redemption and
introspection: signature with the *current* session secret, expiry, and the revocation list.

| event on the site | effect on Ops |
| --- | --- |
| admin logout (revocation list entry) | grant inactive ⇒ Ops session ends on its next check, **at most `OPS_AUTH_REVALIDATE_SECONDS` later** (default 30 s, `0` = every request) |
| admin password change (new salt/hash **and** new session secret) | every admin session invalid ⇒ every grant inactive ⇒ same window |
| session-secret rotation alone | same |
| admin session expiry (12 h, or 30 d "remember me") | grants also expire; a grant never outlives `min(grantTtlHours ≤ 24 h, admin expiry)` |
| admin e-mail changed in the auth record | the signed session no longer matches ⇒ inactive |
| handoff disabled / config invalid | back channel answers 503 ⇒ Ops **fails closed** (`unavailable`) until it is back |
| site process restart | in-memory grants are gone ⇒ inactive ⇒ Ops sessions end; sign in again |
| new admin login | does **not** revive an old grant (bound to the exact session) |

On the Ops side (unchanged): Ops logout revokes the session row **immediately** (a copied cookie is dead at
once) and hands the grant back; a different identity/subject from the site, an `OPS_AUTH_MODE` change or a
member-era session row ends the session; the site unreachable/slow/malformed ⇒ fail closed
(`/login?reason=unavailable`) with the session kept so it recovers without a new login.

What is stored, and where (site, per the contract): codes and grants in bounded in-memory maps keyed by
SHA-256 of the code/grant. Nothing is written to disk; logs carry fixed tags only.

### Trade-offs, honestly

- **Most privileged credential.** Ops now sits behind the site's admin login: whoever holds a live admin
  session can open Ops. Ops itself never holds the admin cookie, so an Ops compromise does not yield the site
  admin. The handoff page is under `/admin/`, so the edge's access policy for `/admin/*` applies to it too.
- **Session reference in site memory** for up to the grant lifetime (≤ 24 h). Not on disk, not logged.
- **Window.** A site logout reaches Ops within `OPS_AUTH_REVALIDATE_SECONDS`. `0` means a back-channel call per
  Ops request; the site allows 120 per minute from one client (plus the site-wide public limiter), so under
  heavy use with `0` Ops will get 429 and fail closed for the rest of that minute. Keep `0` for low traffic or
  strict testing; the default 30 s needs ≈ 2 calls/min per session.
- **Restart = sign-in again** (no persisted grants). Deliberate: nothing that can be replayed lies on disk.

## Threat boundary

Defended:

- **Member/Discord sessions**: never read by the handoff; a joined member without an admin session is sent to
  the admin login (tested in the module and in Chrome).
- **Login CSRF / session injection**: Ops state is bound to a host-only cookie in the browser that started it;
  a state replayed elsewhere is burned. The site needs a live admin session (SameSite=Strict, so same-site
  navigations only) and sends the code only to the configured redirect URI; a code without the matching
  binding cookie is refused by the Ops callback.
- **Code interception / replay**: PKCE S256 + confidential client auth + one-use 60 s codes; concurrent double
  redemption yields exactly one grant (tested); a replay revokes the grant.
- **Open redirects**: exact `client_id`/`redirect_uri` match on the site (no redirect on mismatch);
  Ops' post-login target is an in-app path only (`safeReturnTo`).
- **Stolen Ops cookie**: server-side row; dies on Ops logout at once and on site logout within the window.
- **CSRF on Ops mutations**: SameSite=Lax + exact `Origin` check in every server action + Next.js' own check.
- **Token leakage**: the admin cookie never leaves the site; codes/grants/sessions are stored as hashes on Ops;
  logs carry fixed tags only (tests assert no secret, cookie, code or grant in logs or on disk).
- **Cookie scope**: `__Host-` prefix in production — Secure, Path=/, no Domain; no parent-domain cookie.

Out of scope here: the reverse proxy / edge configuration (must keep `/api/ops-handoff/*` reachable server-to-server,
uncached, unchallenged, with `Authorization` intact), compromise of the site host itself (it is the identity
provider), and Ops DB compromise beyond what hashing gives (a stored grant is useless without the client secret).

## Why not a library

Auth.js and Better Auth (Generic OAuth) are clients for real OAuth 2.0 / OIDC providers; oauth4webapi and
openid-client likewise expect standard authorization-server endpoints and metadata. The parent site is none of
those, and turning it into one (e.g. node-oidc-provider) is a far larger change to a live legacy server than
this feature justifies. So the handoff reuses the standards' *rules* with Node's own crypto primitives
(`randomBytes`, SHA-256, HMAC, `timingSafeEqual`) and **no JWTs**. If the site ever becomes a
standards-compliant provider, replace `src/server/auth/handoff.ts` with one of those libraries.

## Files

- `src/server/auth/config.ts` — env parsing, fail-closed rules (`admin` only), cookie names/attributes
- `src/server/auth/handoff.ts` — PKCE, authorize URL (`/admin/ops-handoff/`), `safeReturnTo`, origin check, back-channel client
- `src/server/auth/store.ts`, `resolve.ts`, `session.ts` — server-side sessions and the per-request check
- `src/app/auth/start`, `src/app/auth/callback` — the two routes; `src/proxy.ts` is a cookie-shape pre-filter only
- `db/migrations/005-auth-sessions.sql`
- `tests/fixtures/fake-site.ts` — synthetic parent site implementing the contract; used by unit tests and the browser E2E
- `e2e/tls.ts`, `e2e/dns-hook.mjs` — per-run CA, TLS proxy and `.test` hostnames so Chrome applies real cookie rules
