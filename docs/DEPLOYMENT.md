# Deployment runbook (dedicated host, container)

> Generic runbook. The CI of this public repository builds the app and runs the tests; it does not build
> the container image or deploy anything. Reverse-proxy / edge configuration is out of scope.

## Shape

- One host dedicated to Ops runs one app container (`review-ops:<git-sha>`) bound to **host loopback
  `127.0.0.1:3000`**; the reverse proxy on that host is the only way in and forwards the
  public Ops origin (`OPS_PUBLIC_ORIGIN`, https) to it.
- A **dedicated database** `review_ops` on the existing PostgreSQL cluster with two roles:
  `ops_owner` (owns the schema; used **only** by the one-shot migrate job) and `ops_app` (runtime, DML only,
  owns nothing, statement timeout). No superuser credential exists on the Ops host.
- Secrets are files under `deploy/secrets/` on the host (git- and docker-ignored, mode 0600, owned by the
  deploy user), mounted as Docker secrets. Images contain no secrets and no `.env` files.

| secret file | used by | content |
| --- | --- | --- |
| `site_client_secret` | app | ≥ 32 random chars; its SHA-256 goes into the site's `ops-handoff.json` |
| `ops_app_database_url` | app | `postgres://ops_app:***@db-host:5432/review_ops?sslmode=…` |
| `ops_owner_database_url` | migrate job only | `postgres://ops_owner:***@db-host:5432/review_ops?sslmode=…` |
| `ops_ingest_token_sha256` | app | 64 hex: SHA-256 of the mail producer's bearer token (**not** the token). Empty file = mail ingest off |

Generate the client secret on the host, e.g. `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))" > deploy/secrets/site_client_secret`.
For mail ingest see [Mail ingest](#mail-ingest-메일-의뢰) below; until it is set up, create `deploy/secrets/ops_ingest_token_sha256` empty (`: > …`, mode 0600).

## Expected external URLs (app-facing only)

- `<ops-host>` must be **same-site** with the site host the admin logs in on (e.g. `ops.site.example` next to
  `site.example`): the parent-site admin cookie is `SameSite=Strict`, so from a different site the browser never sends
  it and the site refuses such a `redirectUri` (docs/AUTH.md, "SameSite=Strict and the Ops domain").
- Browser → `https://<ops-host>/` (any path); `/auth/start`, `/auth/callback` must reach the app unchanged.
  The proxy must preserve `Host` (or set `X-Forwarded-Host`) = `<ops-host>`: Next.js rejects Server Actions
  whose `Origin` does not match it, and Ops additionally requires `Origin` == `OPS_PUBLIC_ORIGIN` exactly.
- The site's handoff config must list exactly `https://<ops-host>/auth/callback` as `redirectUri`.
- Browser → `https://site.example/admin/ops-handoff/` (no confirm page: a valid admin GET gets a direct 303
  to the Ops callback) sits under `/admin/`, so the edge access policy for `/admin/*` and the admin login
  guard it like every admin page.
- Ops → site back channel: `POST https://site.example/api/ops-handoff/{token,introspect,revoke}` from the Ops
  host — outside `/admin/` and `/api/admin/` on purpose (server-to-server, client-secret authenticated, no
  browser cookie); must not be cached, challenged (bot checks / access login) or rewritten by the edge, and
  must carry the `Authorization` header through. The site allows 120 calls/min from one client: keep
  `OPS_AUTH_REVALIDATE_SECONDS` at its default (30) in production.
- If the proxy in front of Ops sets a trustworthy client-IP header, set `OPS_TRUSTED_CLIENT_IP_HEADER`
  (e.g. `x-real-ip`); otherwise leave it empty. Then the sign-in routes share one bucket
  (20/min) and at most 50 sign-ins may be pending, so a flood can delay the owner's login by a few minutes
  (it cannot get anyone in) — configure the header in production.

## Mail ingest (메일 의뢰)

Review requests found in the owner's mailbox reach Ops as **candidates**; nothing becomes a review until
the owner confirms it in 메일 의뢰. The mailbox is read (read-only) on the producer host, never by Ops:

```
producer host: scheduled job → Gmail API (read-only scope) → LLM extraction → post_candidates.py
      │  POST http://<Ops host LAN address>:<OPS_INGEST_PUBLISH port>/api/ingest/mail-candidates
      │  Authorization: Bearer <token>   (one JSON candidate per request, ≤ 64 KB)
      ▼
Ops app: direct host (Host == OPS_INGEST_ALLOWED_HOST, no cf-* header) → allowlist (TCP peer)
         → token (SHA-256, constant time) → rate limit → zod schema → mail_candidates row
```

- **Endpoint contract:** `201` created (`{"result":"created","id":…,"status":"pending"|"duplicate"}`),
  `200` already stored (same `source` + `message_id`; re-sending is always safe), `400` invalid (field
  names only), `401` not allowed (not the direct host, no/wrong token, peer not allowlisted, ingest off), `413` body > 64 KB,
  `429` over `OPS_INGEST_RATE_PER_MINUTE` (`Retry-After: 60`), `503` database down. No response echoes
  input. The schema (caps: subject 500, snippet 1000, notes 500, ≤ 5 evidence lines of ≤ 300, no control /
  bidi characters) is `src/server/ingest/schema.ts`; the producer side is documented in
  [`mail-ingest/README.md`](../mail-ingest/README.md).
- **What the token can do:** POST candidates to that one route. It is not a session: every page, server
  action and other API still requires an Ops sign-in, and the route never sets a cookie. It writes only
  `mail_candidates` rows (reviews are created by the owner's 리뷰로 등록, in one transaction with the
  candidate decision).
- **Token:** created on the producer host and kept there (mode 0600), e.g.
  `python3 -c "import secrets; print(secrets.token_urlsafe(32))" > ops_ingest_token && chmod 600 ops_ingest_token`
  (or `npm run ingest-token -- --out <path>` where the app is checked out). Ops gets only the hash:
  `tr -d '\n' < ops_ingest_token | sha256sum | cut -d' ' -f1 > deploy/secrets/ops_ingest_token_sha256`
  — run on the producer host, copy only that hash file. The hash is never logged; neither is the token.
  **Rotate:** new token + new hash file, restart `app`; the old token stops working at once.
- **Network path:** the app is still published on host loopback for the tunnel. For the producer set
  `OPS_INGEST_PUBLISH=<host LAN address>:3100` (compose publishes the same container port there) and allow
  only the producer host to that port in the host firewall. Then set `OPS_INGEST_ALLOWED_HOST` to that same
  `<host LAN address>:3100` (next point) and `OPS_INGEST_ALLOWED_CIDRS` to the producer host
  (`192.0.2.30/32`). The allowlist is checked against the **TCP peer address**, which the
  runtime image stamps on each request with `peer-address.mjs` (`node --import ./peer-address.mjs
  server.js`); `X-Forwarded-For` and other headers are ignored. Without that preload an allowlist refuses
  everything (fail closed, logged as `ingest: refused, peer address unavailable`).
- **Check the peer address Docker shows:** with Docker's default iptables port publishing a LAN
  client keeps its own source address; with `userland-proxy` it can appear as the bridge gateway
  (`172.x.0.1`) instead. Look for `ingest: refused, peer not in OPS_INGEST_ALLOWED_CIDRS` in
  `docker compose logs app` after a test POST and fix the CIDR (or the publish mode) before relying on it.
  Requests that came through the tunnel come from loopback / the bridge gateway. Never allowlist those
  addresses: then nothing that came through the tunnel can reach the ingest route, even with the token.
- **The public hostname never reaches ingest (`OPS_INGEST_ALLOWED_HOST`, required).** The tunnel
  connector may itself sit on an allowlisted address, so the peer check alone cannot tell a public request
  from the producer's. Before anything else (config, token, body) the route therefore requires:
  - the raw `Host` header to equal `OPS_INGEST_ALLOWED_HOST` **exactly**: the LAN `host:port` the producer
    uses, i.e. `OPS_INGEST_PUBLISH`'s value (e.g. `192.0.2.20:3100`). `X-Forwarded-Host` is never
    consulted. Put the port in the producer's `OPS_INGEST_URL` explicitly (`http://192.0.2.20:3100`), so
    its Host header carries it;
  - neither `cf-connecting-ip` nor `cf-ray` to be present, even empty. These only ever deny (a direct caller
    could add them only to refuse itself), never authenticate.
  
  Otherwise the fixed `401` is returned and `ingest: refused, not the direct ingest host` is logged (no
  header value). Unset or blank = every ingest POST is refused (`ingest: refused, OPS_INGEST_ALLOWED_HOST is
  not set`); the rest of the app is unaffected, so Compose does not hard-require the variable.
  This holds as long as the tunnel keeps the public `Host` **or** at least one of those two Cloudflare headers.
  If a connector strips both markers **and** rewrites `Host` to the LAN authority, no in-app header check can
  tell the paths apart. Therefore also apply the edge rule below.
- **Edge:** additionally, do not route `/api/ingest/*` through the public tunnel / edge at all (a public-host
  ingress rule rejecting that path before the catch-all route).
- **Release check (from the real hosts):** from the producer: right token → `201`, again → `200`, wrong
  token → `401`. Through the public hostname, a **valid** token must still get `401`, and no row may be
  written. Normal pages, login and `/api/health` must keep working.
- **Turning it off:** empty the hash file (or remove `OPS_INGEST_PUBLISH` / `OPS_INGEST_ALLOWED_HOST`) and restart `app`.

## First install

1. **Database (cluster admin, once):** `psql -v owner_password=… -v app_password=… -f db/bootstrap/001-roles-and-database.sql`
   (passwords from files, not typed into history). Put the two URLs into the secret files.
2. **Images (build host):** `docker build --target runtime -t review-ops:<sha> .` and
   `docker build --target migrate -t review-ops-migrate:<sha> .` Pin `NODE_IMAGE` by digest first (Dockerfile header).
3. **Config:** copy `deploy/ops.env.example` → `deploy/ops.env`, fill in origins/image tags. The identity is
   fixed to the parent-site admin login (`OPS_IDENTITY_KIND=admin` in the Compose file); there is no owner id to
   configure, and a leftover `OPS_OWNER_SUBJECT` makes the app refuse to enable sign-in.
4. **Migration gate:** `docker compose -f deploy/compose.yaml --env-file deploy/ops.env run --rm migrate` — must exit 0
   (applies `db/migrations/*` from zero, re-grants DML to `ops_app`).
5. **Start:** `docker compose -f deploy/compose.yaml --env-file deploy/ops.env up -d app`; wait for
   `healthy` (`/api/health` → `{"status":"ok"}`).
6. **Site side:** the parent site must implement the contract in docs/AUTH.md and be configured with
   `clientId`, the exact `redirectUri` `https://<ops-host>/auth/callback` and the SHA-256 of the client
   secret. Until then Ops shows the login page and the handoff answers 503. If the site keeps grants in
   memory only, a site restart means the admin signs in to Ops again.

Startup never migrates and never seeds: `db:seed` (fictional demo data) refuses to run with
`OPS_DEPLOYMENT=production`, and `demo-password` sign-in is refused in production.

## Every release

1. **Backup first:** `pg_dump -Fc -d "<ops_owner url>" -f review_ops-<date>-<sha>.dump` (keep ≥ 7 daily + the
   pre-release dumps of the last 3 releases, off the host). Test-restore a dump into a scratch database
   monthly: `pg_restore --no-owner -d scratch review_ops-….dump`.
2. Build both images for the new `<sha>`; update `OPS_IMAGE` / `OPS_MIGRATE_IMAGE`.
3. Run the migrate job (gate). Non-zero exit ⇒ stop; nothing else changed.
4. `up -d app`; confirm `healthy`, sign in, open the dashboard.

## Rollback

- **App only (no new migration):** set `OPS_IMAGE` back to the previous tag, `up -d app`.
- **With a migration:** migrations are forward-only. Either keep the new schema and roll the app back only
  if the migration was additive (the default policy: add columns/tables, never drop in the same release),
  or restore the pre-release dump (`pg_restore --clean --if-exists -d "<owner url>" …`), re-run
  `migrate` with the previous image, then start the previous app image.
- **Sign-in emergency:** log out of the site admin / change the admin password (ends every grant within the
  revalidation window), disable the handoff in the site's config (immediate) and/or end every Ops
  session: `docker compose -f deploy/compose.yaml --env-file deploy/ops.env run --rm -e DATABASE_URL_FILE=/run/secrets/ops_owner_database_url --entrypoint node migrate --import tsx scripts/revoke-sessions.ts`.
